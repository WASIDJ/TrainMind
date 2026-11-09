// SqliteTelemetryRecorder — 冻结规格 §6 TelemetryRecorder 的实现
// 核心不变量(规格 §5 + 附录 A #1):
//   InteractionEvent / AdaptationEvent 共享 workout_sessions.next_event_seq 事务分配器;
//   分配与插入在同一事务内完成 → 跨表 seq 全局唯一、单调、无空洞,ORDER BY seq 可回放完整 timeline。
import { DatabaseSync } from 'node:sqlite';
import { ulid } from './ids.ts';
import { allRows, getRow, mapAdaptationRow, mapFeedbackRow, mapInteractionRow, mapSetRow } from './records.ts';
import { deriveSummary } from './summary.ts';
import type {
  AdaptationEvent, InteractionEvent, IsoMs, ObserverRecord, SessionTelemetrySummary,
  SetFeedback, SetRecord, TelemetryRecorder, Ulid,
} from './types.ts';

let savepointCounter = 0;
/** 可重入事务:外层无事务时 SAVEPOINT≈BEGIN/COMMIT;嵌套在调用方事务(如 /actions 的 BEGIN IMMEDIATE)内时为安全嵌套,回滚仅触及本层。 */
export function reentrantTx<T>(db: DatabaseSync, fn: () => T): T {
  const sp = `tm_sp_${++savepointCounter}`;
  db.exec(`SAVEPOINT ${sp}`);
  try { const out = fn(); db.exec(`RELEASE ${sp}`); return out; }
  catch (e) { try { db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`); } catch { /* 连接已回滚 */ } throw e; }
}

/**
 * C12(2026-11-09):语音原文统一截断 + 可关闭。
 * 此前同类数据两套口径(叙事路径截 120 字,完成口令/疼痛原话全量入库),
 * 一次误触的长录音会永久留在本地库里;疼痛与恐惧类自由文本是最敏感的一类。
 * TRAINMIND_TELEMETRY_TRANSCRIPT=0 时干脆不落原文。
 */
const TRANSCRIPT_MAX_CHARS = 200;
function capTranscript(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !value) return null;
  if (process.env.TRAINMIND_TELEMETRY_TRANSCRIPT === "0") return null;
  return value.length > TRANSCRIPT_MAX_CHARS ? value.slice(0, TRANSCRIPT_MAX_CHARS) : value;
}

export class SqliteTelemetryRecorder implements TelemetryRecorder {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** 事务内分配一个全局序号(独立调用会预留 seq;record* 在自身事务内使用同一原语,不留空洞) */
  nextSeq(sessionId: Ulid): number {
    return this.tx(() => this.allocSeq(sessionId));
  }

  recordInteraction(input: Omit<InteractionEvent, 'id' | 'seq'>): InteractionEvent {
    const id = ulid();
    const seq = this.tx(() => {
      const s = this.allocSeq(input.sessionId);
      this.db.prepare(
        `INSERT INTO interaction_events
         (id, session_id, seq, occurred_at, actor, modality, action, runtime_state,
          target_set_record_id, target_exercise_instance_id, intent, success, latency_ms, transcript, error_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, input.sessionId, s, input.occurredAt, input.actor, input.modality, input.action,
        input.runtimeState, input.targetSetRecordId, input.targetExerciseInstanceId, input.intent,
        input.success === null ? null : input.success ? 1 : 0,
        input.latencyMs, capTranscript(input.transcript),
        input.error === null ? null : JSON.stringify(input.error),
      );
      return s;
    });
    return { ...input, id, seq };
  }

  recordAdaptation(input: Omit<AdaptationEvent, 'id' | 'seq'>): AdaptationEvent {
    const id = ulid();
    const seq = this.tx(() => {
      const s = this.allocSeq(input.sessionId);
      this.db.prepare(
        `INSERT INTO adaptation_events
         (id, session_id, seq, occurred_at, exercise_instance_id, set_record_id, type,
          deltas_json, triggered_by_json, reason_json, evidence_refs_json, applied, applied_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)`,
      ).run(
        id, input.sessionId, s, input.occurredAt, input.exerciseInstanceId, input.setRecordId,
        input.type, JSON.stringify(input.deltas), JSON.stringify(input.triggeredBy),
        JSON.stringify(input.reason), JSON.stringify(input.evidenceRefs),
      );
      return s;
    });
    return { ...input, id, seq };
  }

  recordSetFeedback(input: Omit<SetFeedback, 'id'>): SetFeedback {
    const id = ulid();
    // H2(2026-11-06 全仓审查):同组二次反馈(组后更正"刚才那组太重了"→再改口)曾命中
    // UNIQUE(set_record_id) 裸 INSERT 抛错,更正与剂量 adaptation 成对丢失。
    // 规格 §9.7 的不变量是"每组 0..1 条已接受反馈"——INSERT OR REPLACE 保持该不变量:
    // 末次接受的反馈为准(ASR 重试过程仍只留 InteractionEvent,不会走到这里)。
    this.db.prepare(
      `INSERT OR REPLACE INTO set_feedbacks
       (id, set_record_id, difficulty, fatigue, pain_json, source, transcript, interaction_event_id, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, input.setRecordId, input.difficulty, input.fatigue,
      input.pain === null ? null : JSON.stringify(input.pain),
      input.source, capTranscript(input.transcript), input.interactionEventId, input.capturedAt,
    );
    return { ...input, id };
  }

  markApplied(adaptationId: Ulid, at: IsoMs): void {
    const r = this.db.prepare('UPDATE adaptation_events SET applied = 1, applied_at = ? WHERE id = ?').run(at, adaptationId);
    if (Number(r.changes) !== 1) throw new Error(`adaptation event not found: ${adaptationId}`);
  }

  /** 部分回填:仅更新提供的 actual 字段;未提供字段保持原值(规格原则 3:null ≠ 0,不做默认填充) */
  finalizeSet(
    setRecordId: Ulid,
    actuals: Partial<Pick<SetRecord,
      'actualReps' | 'actualDurationSeconds' | 'actualWeightKg'
      | 'actualRestAfterSeconds' | 'completedAt' | 'status'>>,
  ): SetRecord {
    const map = [
      ['actualReps', 'actual_reps'], ['actualDurationSeconds', 'actual_duration_seconds'],
      ['actualWeightKg', 'actual_weight_kg'], ['actualRestAfterSeconds', 'actual_rest_after_seconds'],
      ['completedAt', 'completed_at'], ['status', 'status'],
    ] as const;
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [field, column] of map) {
      const v = (actuals as Record<string, unknown>)[field];
      if (v !== undefined) { sets.push(`${column} = ?`); params.push(v); }
    }
    if (sets.length > 0) {
      params.push(setRecordId);
      const r = this.db.prepare(`UPDATE set_records SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      if (Number(r.changes) !== 1) throw new Error(`set record not found: ${setRecordId}`);
    }
    const row = getRow(this.db, 'SELECT * FROM set_records WHERE id = ?', setRecordId);
    if (!row) throw new Error(`set record not found: ${setRecordId}`);
    return mapSetRow(row);
  }

  computeSummary(sessionId: Ulid): SessionTelemetrySummary {
    return deriveSummary(this.db, sessionId);
  }

  attachObserverRecord(record: ObserverRecord): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO observer_records
       (session_id, recorded_by, phone_pickup_count, screen_glance_count, observer_intervention_count, pickups_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(record.sessionId, record.recordedBy, record.phonePickupCount, record.screenGlanceCount,
      record.observerInterventionCount, JSON.stringify(record.pickups));
  }

  getInteraction(id: Ulid): InteractionEvent | null {
    const row = getRow(this.db, 'SELECT * FROM interaction_events WHERE id = ?', id);
    return row ? mapInteractionRow(row) : null;
  }

  getAdaptation(id: Ulid): AdaptationEvent | null {
    const row = getRow(this.db, 'SELECT * FROM adaptation_events WHERE id = ?', id);
    return row ? mapAdaptationRow(row) : null;
  }

  getFeedback(id: Ulid): SetFeedback | null {
    const row = getRow(this.db, 'SELECT * FROM set_feedbacks WHERE id = ?', id);
    return row ? mapFeedbackRow(row) : null;
  }

  listAdaptations(sessionId: Ulid): AdaptationEvent[] {
    return allRows(this.db, 'SELECT * FROM adaptation_events WHERE session_id = ? ORDER BY seq', sessionId).map(mapAdaptationRow);
  }

  listFeedbacks(sessionId: Ulid): SetFeedback[] {
    return allRows(this.db,
      'SELECT f.* FROM set_feedbacks f JOIN set_records sr ON sr.id = f.set_record_id JOIN exercise_instances ei ON ei.id = sr.exercise_instance_id WHERE ei.session_id = ? ORDER BY f.captured_at',
      sessionId).map(mapFeedbackRow);
  }

  /** 事务分配原语:必须在已开启的事务内调用;分配 + 后续插入由调用方包在同一事务中 */
  private allocSeq(sessionId: Ulid): number {
    const upd = this.db.prepare('UPDATE workout_sessions SET next_event_seq = next_event_seq + 1 WHERE id = ?').run(sessionId);
    if (Number(upd.changes) !== 1) throw new Error(`workout session not found: ${sessionId}`);
    const row = getRow(this.db, 'SELECT next_event_seq AS v FROM workout_sessions WHERE id = ?', sessionId);
    return Number(row!.v) - 1;
  }

  private tx<T>(fn: () => T): T {
    return reentrantTx(this.db, fn);
  }
}
