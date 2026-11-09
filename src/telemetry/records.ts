// 行 ↔ 对象映射(fresh / legacy 两种物理形状下,v2 列集合一致,映射统一)
import type { DatabaseSync } from 'node:sqlite';
import type {
  AdaptationDelta, AdaptationEvent, ExerciseInstance, InteractionEvent,
  ObserverRecord, PainReport, SetFeedback, SetRecord, WorkoutSession,
  WorkoutSessionStatus, ExerciseInstanceStatus, SetRecordStatus,
  TrackingMetric, DifficultyLevel, FeedbackSource, InteractionModality,
  WorkoutRuntimeState, AdaptationType,
} from './types.ts';

type Row = Record<string, unknown>;

const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const n = (v: unknown): number | null =>
  v === null || v === undefined ? null : typeof v === 'number' ? v : Number(v);
const b = (v: unknown): boolean | null => (v === null || v === undefined ? null : v === 1);
const j = <T,>(v: unknown): T | null => {
  if (v === null || v === undefined) return null;
  try { return JSON.parse(String(v)) as T; } catch { return null; }
};

export function mapSessionRow(r: Row): WorkoutSession {
  return {
    id: String(r.id),
    plannedWorkoutId: s(r.planned_workout_id),
    startedAt: n(r.started_at) ?? 0,
    endedAt: n(r.ended_at),
    status: String(r.status) as WorkoutSessionStatus,
    appVersion: s(r.app_version) ?? '',
    deviceModel: s(r.device_model),
    osVersion: s(r.os_version),
  };
}

export function mapExerciseRow(r: Row): ExerciseInstance {
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
    exerciseId: String(r.exercise_id),
    orderIndex: n(r.order_index) ?? 0,
    trackingMetric: String(r.tracking_metric) as TrackingMetric,
    status: String(r.status) as ExerciseInstanceStatus,
    substitutedByInstanceId: s(r.substituted_by_instance_id),
  };
}

/**
 * C8(2026-11-09):legacy 未映射行(`exercise_instance_id` / `set_number` / `status` 为空)
 * 不许被读成"1970 年开始、第 0 组、已跳过"的假事实。能不能进 v2 读出口,在这里一次性判定。
 */
export function mapSetRowOrNull(r: Row): SetRecord | null {
  const exerciseInstanceId = s(r.exercise_instance_id), setNumber = n(r.set_number), status = s(r.status);
  if (!exerciseInstanceId || setNumber === null || status === null) return null;
  return mapSetRow(r);
}

export function mapSetRow(r: Row): SetRecord {
  const exerciseInstanceId = s(r.exercise_instance_id), setNumber = n(r.set_number), status = s(r.status);
  // 走到这里还缺字段说明调用方没做判定 —— 直接抛,好过悄悄返回一条假记录
  if (!exerciseInstanceId || setNumber === null || status === null) throw new Error("set record row is not mapped to v2; use mapSetRowOrNull");
  return {
    id: String(r.id),
    exerciseInstanceId: s(r.exercise_instance_id) ?? '',
    setNumber: n(r.set_number) ?? 0,
    targetWeightKg: n(r.target_weight_kg),
    targetRepsMin: n(r.target_reps_min),
    targetRepsMax: n(r.target_reps_max),
    targetDurationSeconds: n(r.target_duration_seconds),
    targetRestAfterSeconds: n(r.target_rest_after_seconds),
    actualReps: n(r.actual_reps),
    actualDurationSeconds: n(r.actual_duration_seconds),
    actualWeightKg: n(r.actual_weight_kg),
    actualRestAfterSeconds: n(r.actual_rest_after_seconds),
    startedAt: n(r.started_at),
    completedAt: n(r.completed_at),
    status: (s(r.status) ?? 'skipped') as SetRecordStatus,
  };
}

export function mapInteractionRow(r: Row): InteractionEvent {
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
    seq: n(r.seq) ?? 0,
    occurredAt: n(r.occurred_at) ?? 0,
    actor: String(r.actor) as InteractionEvent['actor'],
    modality: String(r.modality) as InteractionModality,
    action: String(r.action),
    runtimeState: String(r.runtime_state) as WorkoutRuntimeState,
    targetSetRecordId: s(r.target_set_record_id),
    targetExerciseInstanceId: s(r.target_exercise_instance_id),
    intent: s(r.intent),
    success: b(r.success),
    latencyMs: n(r.latency_ms),
    transcript: s(r.transcript),
    error: j<{ code: string; message: string | null }>(r.error_json),
  };
}

export function mapAdaptationRow(r: Row): AdaptationEvent {
  const triggered = j<AdaptationEvent['triggeredBy']>(r.triggered_by_json);
  const reason = j<AdaptationEvent['reason']>(r.reason_json);
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
    seq: n(r.seq) ?? 0,
    occurredAt: n(r.occurred_at) ?? 0,
    exerciseInstanceId: s(r.exercise_instance_id),
    setRecordId: s(r.set_record_id),
    type: String(r.type) as AdaptationType,
    deltas: j<AdaptationDelta[]>(r.deltas_json) ?? [],
    triggeredBy: triggered ?? { modality: 'engine', interactionEventId: null, actor: 'engine' },
    reason: reason ?? { code: 'unknown', text: null },
    evidenceRefs: j<string[]>(r.evidence_refs_json) ?? [],
    applied: b(r.applied) ?? false,
    appliedAt: n(r.applied_at),
  };
}

export function mapFeedbackRow(r: Row): SetFeedback {
  return {
    id: String(r.id),
    setRecordId: String(r.set_record_id),
    difficulty: (s(r.difficulty) as DifficultyLevel | null),
    fatigue: (n(r.fatigue) as SetFeedback['fatigue']),
    pain: j<PainReport>(r.pain_json),
    source: String(r.source) as FeedbackSource,
    transcript: s(r.transcript),
    interactionEventId: s(r.interaction_event_id),
    capturedAt: n(r.captured_at) ?? 0,
  };
}

export function mapObserverRow(r: Row): ObserverRecord {
  return {
    sessionId: String(r.session_id),
    recordedBy: String(r.recorded_by),
    phonePickupCount: n(r.phone_pickup_count) ?? 0,
    screenGlanceCount: n(r.screen_glance_count),
    observerInterventionCount: n(r.observer_intervention_count) ?? 0,
    pickups: j<ObserverRecord['pickups']>(r.pickups_json) ?? [],
  };
}

/** 供查询用的轻量行读取器(store/recorder/validate/replay 共用) */
export function getRow(db: DatabaseSync, sql: string, ...params: unknown[]): Row | undefined {
  return db.prepare(sql).get(...params) as Row | undefined;
}
export function allRows(db: DatabaseSync, sql: string, ...params: unknown[]): Row[] {
  return db.prepare(sql).all(...params) as Row[];
}
