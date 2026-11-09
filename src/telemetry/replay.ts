// 事件链回放:跨表合并 InteractionEvent + AdaptationEvent(共享 seq),SetFeedback 按
// interactionEventId 挂到来源交互之后 —— 完整回放「用户说了什么 → 已接受反馈 → 为什么改 →
// 改成什么 → 是否执行成功」(规格 §5 事件顺序 / §9.2 golden 断言)
import type { DatabaseSync } from 'node:sqlite';
import { allRows, mapAdaptationRow, mapFeedbackRow, mapInteractionRow } from './records.ts';
import type { AdaptationEvent, InteractionEvent, IsoMs, SetFeedback, Ulid } from './types.ts';

export interface TimelineStep {
  seq: number | null;
  kind: 'interaction' | 'adaptation' | 'feedback';
  at: IsoMs;
  interaction?: InteractionEvent;
  adaptation?: AdaptationEvent;
  feedback?: SetFeedback;
}

export function replayTimeline(db: DatabaseSync, sessionId: Ulid): TimelineStep[] {
  const interactions = allRows(db, 'SELECT * FROM interaction_events WHERE session_id = ? ORDER BY seq', sessionId).map(mapInteractionRow);
  const adaptations = allRows(db, 'SELECT * FROM adaptation_events WHERE session_id = ? ORDER BY seq', sessionId).map(mapAdaptationRow);
  const feedbacks = allRows(db,
    'SELECT f.* FROM set_feedbacks f JOIN set_records sr ON sr.id = f.set_record_id JOIN exercise_instances ei ON ei.id = sr.exercise_instance_id WHERE ei.session_id = ?',
    sessionId).map(mapFeedbackRow);

  const steps: TimelineStep[] = [
    ...interactions.map(i => ({ seq: i.seq, kind: 'interaction' as const, at: i.occurredAt, interaction: i })),
    ...adaptations.map(a => ({ seq: a.seq, kind: 'adaptation' as const, at: a.occurredAt, adaptation: a })),
  ].sort((x, y) => (x.seq ?? 0) - (y.seq ?? 0));

  // 反馈挂在来源交互之后;找不到来源时按 capturedAt 落位
  const indexOfInteraction = new Map<Ulid, number>();
  steps.forEach((s, i) => { if (s.interaction) indexOfInteraction.set(s.interaction.id, i); });
  const withFeedback: TimelineStep[] = [];
  let pending = [...feedbacks];
  steps.forEach((s, i) => {
    withFeedback.push(s);
    if (s.interaction) {
      const linked = pending.filter(f => f.interactionEventId === s.interaction!.id);
      for (const f of linked) {
        withFeedback.push({ seq: null, kind: 'feedback', at: f.capturedAt, feedback: f });
      }
      pending = pending.filter(f => f.interactionEventId !== s.interaction!.id);
    }
  });
  for (const f of pending) withFeedback.push({ seq: null, kind: 'feedback', at: f.capturedAt, feedback: f });
  return withFeedback;
}

const short = (id: string | null | undefined): string => (id ? '…' + id.slice(-6) : '—'); // ULID 后6位为随机部分,同毫秒内也可区分
const fmtDeltas = (d: AdaptationEvent['deltas']): string =>
  d.map(x => `${x.field} ${x.before}→${x.after}`).join(', ');

export function renderTimeline(steps: readonly TimelineStep[]): string {
  const lines: string[] = [];
  const seqOf = (id: Ulid | null | undefined): string => {
    if (!id) return '—';
    const s = steps.find(x => x.interaction?.id === id);
    return s?.seq != null ? `seq ${String(s.seq).padStart(2, '0')}` : short(id);
  };
  for (const s of steps) {
    if (s.kind === 'interaction' && s.interaction) {
      const i = s.interaction;
      const tag = `[seq ${String(i.seq).padStart(2, '0')}] INT`;
      const who = `${i.actor}/${i.modality}`;
      const tail = [
        i.transcript ? `"${i.transcript}"` : null,
        i.success === true ? '✓' : i.success === false ? '✗' : null,
        i.latencyMs != null ? `latency=${i.latencyMs}ms` : null,
        i.targetSetRecordId ? `→set:${short(i.targetSetRecordId)}` : i.targetExerciseInstanceId ? `→ex:${short(i.targetExerciseInstanceId)}` : null,
      ].filter(Boolean).join(' ');
      lines.push(`${tag}  ${who.padEnd(13)} ${i.action.padEnd(32)} ${i.runtimeState.padEnd(14)} ${tail}`.trimEnd());
    } else if (s.kind === 'feedback' && s.feedback) {
      const f = s.feedback;
      lines.push(`         FDB  set:${short(f.setRecordId)} difficulty=${f.difficulty ?? '—'} fatigue=${f.fatigue ?? '—'} pain=${f.pain ? `sev${f.pain.severity}${f.pain.location ? '@' + f.pain.location : ''}` : '—'} source=${f.source} (by ${seqOf(f.interactionEventId)})`);
    } else if (s.kind === 'adaptation' && s.adaptation) {
      const a = s.adaptation;
      const tag = `[seq ${String(a.seq).padStart(2, '0')}] ADP`;
      const applied = a.applied ? `applied ✓${a.appliedAt != null ? ` (+${Math.max(0, a.appliedAt - a.occurredAt)}ms)` : ''}` : 'NOT applied';
      lines.push(`${tag}  ${a.type.padEnd(46)} ${fmtDeltas(a.deltas)}  reason=${a.reason.code}  by=${seqOf(a.triggeredBy.interactionEventId)}  ${applied}`);
    }
  }
  return lines.join('\n');
}
