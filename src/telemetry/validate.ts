// 事件链完整性校验(规格 §9.1-3:断链能被校验器发现)
// 检查项:
//   missing_interaction_ref   — AdaptationEvent.triggeredBy.interactionEventId 指向不存在的交互
//   feedback_missing_interaction — SetFeedback.interactionEventId 指向不存在的交互
//   applied_inconsistent      — applied 与 applied_at 互相矛盾
//   unapplied_adaptation      — 会话已结束但调整未 applied(链不完整)
//   duplicate_seq / seq_gap   — 跨表 seq 应全局唯一且从 1 起连续(空洞 = 分配后未落库)
import type { DatabaseSync } from 'node:sqlite';
import { allRows, mapAdaptationRow, mapFeedbackRow } from './records.ts';
import type { Ulid } from './types.ts';

export type ChainIssueKind =
  | 'missing_interaction_ref'
  | 'feedback_missing_interaction'
  | 'applied_inconsistent'
  | 'unapplied_adaptation'
  | 'duplicate_seq'
  | 'seq_gap'
  // C9(2026-11-09):nextSeq() 预留未用是可解释的,与"事件真丢了"分开报
  | 'seq_reserved_unused';

export interface ChainIssue {
  kind: ChainIssueKind;
  detail: string;
}

/** 会话是否已结束(兼容 fresh 的 v2 枚举与 legacy 的 'aborted') */
function sessionEnded(db: DatabaseSync, sessionId: Ulid): boolean {
  const row = db.prepare('SELECT status FROM workout_sessions WHERE id = ?').get(sessionId) as { status: string } | undefined;
  if (!row) throw new Error(`workout session not found: ${sessionId}`);
  return ['completed', 'abandoned', 'interrupted', 'aborted'].includes(row.status);
}

export function validateSessionChain(db: DatabaseSync, sessionId: Ulid): ChainIssue[] {
  const issues: ChainIssue[] = [];
  const interactionIds = new Set(
    (db.prepare('SELECT id FROM interaction_events WHERE session_id = ?').all(sessionId) as Array<{ id: string }>).map(r => r.id),
  );
  const seqByInteractionId = new Map<Ulid, number>();
  for (const r of db.prepare('SELECT id, seq FROM interaction_events WHERE session_id = ?').all(sessionId) as Array<{ id: string; seq: number }>) {
    seqByInteractionId.set(r.id, r.seq);
  }

  const adaptations = allRows(db, 'SELECT * FROM adaptation_events WHERE session_id = ?', sessionId).map(mapAdaptationRow);
  const ended = sessionEnded(db, sessionId);

  const seen = new Map<number, string>();
  const allSeqs: Array<{ seq: number; kind: string; id: string }> = [];
  for (const r of db.prepare('SELECT id, seq FROM interaction_events WHERE session_id = ?').all(sessionId) as Array<{ id: string; seq: number }>) {
    allSeqs.push({ seq: r.seq, kind: 'interaction', id: r.id });
  }
  for (const a of adaptations) allSeqs.push({ seq: a.seq, kind: 'adaptation', id: a.id });
  allSeqs.sort((x, y) => x.seq - y.seq);
  for (const e of allSeqs) {
    const dup = seen.get(e.seq);
    if (dup !== undefined) issues.push({ kind: 'duplicate_seq', detail: `seq ${e.seq} 同时存在于 ${dup} 与 ${e.kind} ${e.id}` });
    else seen.set(e.seq, `${e.kind} ${e.id}`);
  }
  const max = allSeqs.length > 0 ? allSeqs[allSeqs.length - 1]!.seq : 0;
  // C9(2026-11-09):nextSeq() 预留的是"最新"序号(它把 next_event_seq 推上去),所以
  // 预留未用产生的空洞只会出现在已用最大序号之后。把这两类分开报,否则一次合法预留
  // 就会让校验器永久报 seq_gap,真正的事件丢失被狼来了效应稀释。
  const nextSeqRow = db.prepare('SELECT next_event_seq FROM workout_sessions WHERE id = ?').get(sessionId) as { next_event_seq?: number } | undefined;
  const reservedUpTo = Math.max(0, Number(nextSeqRow?.next_event_seq ?? 1) - 1);
  for (let s = 1; s <= Math.max(max, reservedUpTo); s++) {
    if (seen.has(s)) continue;
    if (s > max && s <= reservedUpTo) issues.push({ kind: 'seq_reserved_unused', detail: `seq ${s} 已预留未使用(next_event_seq=${reservedUpTo + 1})` });
    else issues.push({ kind: 'seq_gap', detail: `seq ${s} 缺失(分配器空洞或事件丢失)` });
  }

  for (const a of adaptations) {
    const ref = a.triggeredBy.interactionEventId;
    if (ref !== null && !interactionIds.has(ref)) {
      issues.push({ kind: 'missing_interaction_ref', detail: `adaptation ${a.id}(${a.type}) 引用不存在的交互 ${ref}` });
    }
    if (a.applied && a.appliedAt === null) {
      issues.push({ kind: 'applied_inconsistent', detail: `adaptation ${a.id}: applied=true 但 applied_at 为空` });
    }
    if (!a.applied && a.appliedAt !== null) {
      issues.push({ kind: 'applied_inconsistent', detail: `adaptation ${a.id}: applied=false 但 applied_at=${a.appliedAt}` });
    }
    if (!a.applied && ended) {
      issues.push({ kind: 'unapplied_adaptation', detail: `会话已结束,adaptation ${a.id}(${a.type}) 未 applied` });
    }
  }

  const feedbacks = allRows(db,
    'SELECT f.* FROM set_feedbacks f JOIN set_records sr ON sr.id = f.set_record_id JOIN exercise_instances ei ON ei.id = sr.exercise_instance_id WHERE ei.session_id = ?',
    sessionId).map(mapFeedbackRow);
  for (const f of feedbacks) {
    if (f.interactionEventId !== null && !interactionIds.has(f.interactionEventId)) {
      issues.push({ kind: 'feedback_missing_interaction', detail: `feedback ${f.id} 引用不存在的交互 ${f.interactionEventId}` });
    }
  }

  return issues;
}
