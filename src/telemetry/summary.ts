// SessionTelemetrySummary 派生(规格 §5 计数规则,全部由 InteractionEvent/AdaptationEvent 流派生)
import type { DatabaseSync } from 'node:sqlite';
import { computeManualEpisodes } from './pure.ts';
import { TELEMETRY_CONSTANTS } from './types.ts';
import type { SessionTelemetrySummary, Ulid } from './types.ts';

type Row = Record<string, unknown>;

/**
 * 会话时长解析顺序:
 * 1) v2 列 started_at/ended_at(fresh 模式或 legacy 模式下 v2 侧写入)
 * 2) legacy data_json 的 createdAt / runtime.completedAt(域层会话)
 * 3) null(unknown)
 */
function resolveDurationMs(db: DatabaseSync, sessionId: Ulid): number | null {
  const row = db.prepare('SELECT started_at, ended_at FROM workout_sessions WHERE id = ?').get(sessionId) as
    { started_at: number | null; ended_at: number | null } | undefined;
  if (!row) throw new Error(`workout session not found: ${sessionId}`);
  if (row.started_at != null && row.ended_at != null) return row.ended_at - row.started_at;
  // legacy 物理形状:时长从 data_json 的 createdAt / runtime.completedAt 解析(fresh 库无此列)
  const hasDataJson = (db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('workout_sessions') WHERE name = 'data_json'").get() as { n: number }).n > 0;
  if (!hasDataJson) return null;
  const legacy = db.prepare('SELECT data_json FROM workout_sessions WHERE id = ?').get(sessionId) as { data_json: string } | undefined;
  if (!legacy?.data_json) return null;
  try {
    const d = JSON.parse(legacy.data_json) as { createdAt?: string; runtime?: { completedAt?: string } };
    const start = d.createdAt ? Date.parse(d.createdAt) : NaN;
    const end = d.runtime?.completedAt ? Date.parse(d.runtime.completedAt) : NaN;
    if (Number.isFinite(start) && Number.isFinite(end)) return end - start;
  } catch { /* JSON 不可解析 → unknown */ }
  return null;
}

export function deriveSummary(db: DatabaseSync, sessionId: Ulid): SessionTelemetrySummary {
  const events = db.prepare(
    'SELECT occurred_at, modality, action, success FROM interaction_events WHERE session_id = ? ORDER BY seq',
  ).all(sessionId) as Row[];

  let manualActionCount = 0;
  let voiceCommandCount = 0;
  let voiceClarificationCount = 0;
  let voiceAsrRetryCount = 0;
  const touchTimes: number[] = [];
  const interruptions = { ui: 0, voice: 0, error: 0, safety: 0 };

  for (const e of events) {
    const action = String(e.action);
    const modality = String(e.modality);
    const success = e.success === 1;
    if (modality === 'touch') { manualActionCount++; touchTimes.push(Number(e.occurred_at)); }
    if (action.startsWith('voice.command.') && success) voiceCommandCount++;
    if (action === 'voice.clarification.request') voiceClarificationCount++;
    if (action === 'voice.asr_retry') voiceAsrRetryCount++;
    if (action.startsWith('system.interruption.')) {
      const category = action.split('.')[2] as keyof typeof interruptions;
      if (category in interruptions) interruptions[category]++;
    }
  }

  // touch 事件按时间排序后做 episode 分段(规格 §5;seq 序 ≠ 时间序时以时间为准)
  touchTimes.sort((a, b) => a - b);
  const manualInteractionEpisodeCount = computeManualEpisodes(touchTimes, TELEMETRY_CONSTANTS.EPISODE_GAP_MS);

  return {
    sessionId,
    sessionDurationMs: resolveDurationMs(db, sessionId),
    manualActionCount,
    manualInteractionEpisodeCount,
    voiceCommandCount,
    voiceClarificationCount,
    voiceAsrRetryCount,
    voiceRetryCount: voiceClarificationCount + voiceAsrRetryCount,
    runtimeInterruptionCount: interruptions.ui + interruptions.voice + interruptions.error + interruptions.safety,
    runtimeInterruptionsByCategory: interruptions,
    generatedAt: Date.now(),
  };
}
