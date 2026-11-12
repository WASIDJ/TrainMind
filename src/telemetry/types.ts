// TrainMind SetRecord v2 与训练事件 Schema — 冻结规格 v1.0.1
// 来源:../trainmind-setrecord-v2-schema.md(§3 类型定义 / §5 计数规则常量 / §6 TelemetryRecorder 接口)
// 冻结约束:不得新增、删除、重命名或重新解释字段、事件语义、计数规则。
// 本模块类型与 src/core.ts 中的同名领域类型(legacy)分属两个模块,互不影响;
// v2 遥测层统一从本模块导入。

// ============ 通用 ============
export type Ulid = string;            // 推荐 ULID(时间有序)
export type IsoMs = number;           // epoch milliseconds (UTC)

// ============ WorkoutSession ============
export type WorkoutSessionStatus =
  | 'active' | 'completed' | 'abandoned' | 'interrupted';

export interface WorkoutSession {
  id: Ulid;
  plannedWorkoutId: string | null;    // 处方来源(Prescription Engine)
  startedAt: IsoMs;
  endedAt: IsoMs | null;
  status: WorkoutSessionStatus;
  appVersion: string;
  deviceModel: string | null;
  osVersion: string | null;
}

// ============ ExerciseInstance ============
// tracking_metric 三种计数口径:reps(计数)| hold(保持)| time(计时)
export type TrackingMetric = 'reps' | 'hold' | 'time';
export type ExerciseInstanceStatus =
  | 'pending' | 'in_progress' | 'completed'
  | 'skipped' | 'substituted' | 'failed';

export interface ExerciseInstance {
  id: Ulid;
  sessionId: Ulid;
  exerciseId: string;                 // Exercise Knowledge Graph id
  orderIndex: number;                 // 会话内顺序(替换后指向新实例)
  trackingMetric: TrackingMetric;
  status: ExerciseInstanceStatus;
  substitutedByInstanceId: Ulid | null; // 被替换时指向替代实例
}

// ============ SetRecord(事实层)============
export type SetRecordStatus = 'completed' | 'partial' | 'failed' | 'skipped';

export interface SetRecord {
  id: Ulid;
  exerciseInstanceId: Ulid;
  setNumber: number;                  // 1-based
  // --- 处方目标快照(经 AdaptationEvent 后的最终值;初始值来自处方)---
  targetWeightKg: number | null;
  targetRepsMin: number | null;       // 支持范围目标 8–10
  targetRepsMax: number | null;
  targetDurationSeconds: number | null;  // hold / time 类
  targetRestAfterSeconds: number | null; // 本组完成后计划休息
  // --- 实际完成(unknown → null)---
  actualReps: number | null;
  actualDurationSeconds: number | null;
  actualWeightKg: number | null;
  actualRestAfterSeconds: number | null; // completedAt → 下一个 work interval 实际开始;
                                        // 无后续训练(会话完成/中止)= null,绝不度量到 summary
                                        // (未来如需研究"末组后多久离场",另设 postWorkoutTransitionSeconds,不污染 rest)
  startedAt: IsoMs | null;
  completedAt: IsoMs | null;
  status: SetRecordStatus;
}

// ============ SetFeedback(主观层;每组 0..1 条"已接受"反馈,不可变记录)============
// ASR 失败重说等过程留在 InteractionEvent;仅最终解析成功落一条(DDL 强制 UNIQUE(set_record_id))
export type DifficultyLevel = 'easy' | 'just_right' | 'hard';
// 中文标签:轻松 / 合适 / 吃力 —— 决策导向(加重/维持/减轻)
// 明确不采用竞品的 'Challenging' 中间档语义
export type FeedbackSource = 'voice' | 'touch' | 'inferred';

export interface SetFeedback {
  id: Ulid;
  setRecordId: Ulid;
  difficulty: DifficultyLevel | null;
  fatigue: 1 | 2 | 3 | 4 | 5 | null;
  pain: PainReport | null;
  source: FeedbackSource;
  transcript: string | null;          // 语音原文("有点重");本地存储,上传 opt-in
  interactionEventId: Ulid | null;    // 来源交互事件(可回放)
  capturedAt: IsoMs;
}

export interface PainReport {
  severity: 1 | 2 | 3;                // 1轻 2中 3重
  location: string | null;            // 受控词表:'knee' | 'shoulder' | 'lower_back' | ...
}
// Safety Gate 规则:pain != null 一律进入 Safety Gate(轻微疼痛不得绕过);
// severity 只决定响应强度:1 → 评估/降级/询问;2 → 强约束调整;3 → stop。
// "有点痛"与"有点累"不是同一类训练反馈,不能按 fatigue 处理。

// ============ InteractionEvent(遥测核心,append-only)============
export type InteractionModality = 'voice' | 'touch' | 'system';
export type WorkoutRuntimeState =
  | 'pre_workout' | 'pre_set' | 'in_set_counting' | 'post_set'
  | 'resting' | 'transition' | 'paused' | 'summary' | 'aborted';

export interface InteractionEvent {
  id: Ulid;
  sessionId: Ulid;
  seq: number;                        // 会话全局单调递增(与 AdaptationEvent 共享分配器,见 §5)
  occurredAt: IsoMs;
  actor: 'user' | 'ai' | 'system';    // 谁发起(与 modality 正交):用户说话/AI TTS/系统管道
  modality: InteractionModality;
  action: string;                     // 见规格 §4 动作分类表
  runtimeState: WorkoutRuntimeState;
  targetSetRecordId: Ulid | null;
  targetExerciseInstanceId: Ulid | null;
  intent: string | null;              // 解析结果,如 'feedback.difficulty.hard'
  success: boolean | null;
  latencyMs: number | null;           // voice:语音结束→AI 应答开始;touch/system:null
  transcript: string | null;          // voice only
  error: { code: string; message: string | null } | null;
}

// ============ AdaptationEvent(调整层,append-only)============
export type AdaptationType =
  | 'weight_change' | 'rep_change' | 'set_count_change' | 'rest_change'
  | 'exercise_substitution' | 'exercise_skip'
  | 'workout_shorten' | 'workout_abort' | 'safety_stop' | 'plan_regenerate';

export type AdaptationReasonCode =
  | 'user_reported_too_hard' | 'user_reported_too_easy'
  | 'equipment_unavailable' | 'pain_reported' | 'safety_gate'
  | 'time_constraint' | 'fatigue_signal' | 'progression_rule'
  | 'manual_edit' | 'unknown';

export interface AdaptationEvent {
  id: Ulid;
  sessionId: Ulid;
  seq: number;
  occurredAt: IsoMs;
  exerciseInstanceId: Ulid | null;
  setRecordId: Ulid | null;           // 通常指向被调整的"下一组"
  type: AdaptationType;
  deltas: AdaptationDelta[];          // 一次调整可含多字段
  triggeredBy: {
    modality: InteractionModality | 'engine';
    interactionEventId: Ulid | null;  // ← 链路回放入口
    actor: 'user' | 'ai' | 'engine';
  };
  reason: {
    code: AdaptationReasonCode;
    text: string | null;              // 给用户看的"为什么"(Evidence 展示源)
  };
  evidenceRefs: string[];             // Evidence Registry 条目 id
  applied: boolean;                   // 是否已在 Runtime 执行
  appliedAt: IsoMs | null;
}

export interface AdaptationDelta {
  field: 'weightKg' | 'repsMin' | 'repsMax' | 'setCount'
       | 'restAfterSeconds' | 'exerciseId' | 'durationSeconds';
  before: number | string | null;
  after:  number | string | null;
}

// ============ SessionTelemetrySummary(派生,规格 §5 规则)============
export interface SessionTelemetrySummary {
  sessionId: Ulid;
  sessionDurationMs: number | null;
  manualActionCount: number;
  manualInteractionEpisodeCount: number;
  voiceCommandCount: number;
  voiceClarificationCount: number;
  voiceAsrRetryCount: number;
  voiceRetryCount: number;            // = clarification + asrRetry(报告用)
  runtimeInterruptionCount: number;
  runtimeInterruptionsByCategory: {
    ui: number; voice: number; error: number; safety: number;
  };
  generatedAt: IsoMs;
}

// ============ ObserverRecord(人工层,Phase 7B)============
export type PickupReasonCode =
  | 'voice_failed' | 'asr_misheard' | 'ui_required'
  | 'curiosity_check' | 'notification' | 'other';

export interface ObserverRecord {
  sessionId: Ulid;
  recordedBy: string;                 // 观察员标识
  phonePickupCount: number;           // ★ 头条指标
  screenGlanceCount: number | null;   // 观察得到才记,否则 null(不假装能测)
  observerInterventionCount: number;
  pickups: Array<{ atSec: number; reason: PickupReasonCode; note?: string }>;
}

// ============ §5 计数规则常量 ============
export const TELEMETRY_CONSTANTS = {
  EPISODE_GAP_MS: 8_000,            // touch 间隔 ≤8s 归同一 episode(可校准 heuristic,≠ 真实 pickup)
  INTERRUPTION_THRESHOLD_MS: 3_000, // 状态机"本应自动推进"的超期默认阈值(非全局计时器)
} as const;

// 状态感知 interruption:仅下列状态存在 expected auto-transition,超期才计 interruption;
// 等待用户主动输入的状态(post_set 等反馈 / paused / in_set_counting 用户说话)永不计
export const RUNTIME_AUTO_TRANSITION_DEADLINES: Partial<Record<WorkoutRuntimeState, number>> = {
  pre_set: 3_000,     // 自动开始下一组
  resting: 3_000,     // 休息结束自动流转
  transition: 3_000,  // TTS 下一句提示
};
// ASR/TTS 各自的 SLA/timeout 以后单独定义,不套用统一 3 秒

// ============ §6 TelemetryRecorder 接口(实施契约)============
export interface TelemetryRecorder {
  nextSeq(sessionId: Ulid): number;   // 事务内分配;InteractionEvent/AdaptationEvent 共用
                                      // workout_sessions.next_event_seq(跨表全局单调)

  recordInteraction(
    input: Omit<InteractionEvent, 'id' | 'seq'>,
  ): InteractionEvent;

  recordSetFeedback(
    input: Omit<SetFeedback, 'id'>,
  ): SetFeedback;

  recordAdaptation(
    input: Omit<AdaptationEvent, 'id' | 'seq'>,
  ): AdaptationEvent;

  /** Runtime 实际执行了调整后回填 */
  markApplied(adaptationId: Ulid, at: IsoMs): void;

  finalizeSet(
    setRecordId: Ulid,
    actuals: Partial<Pick<SetRecord,
      'actualReps' | 'actualDurationSeconds' | 'actualWeightKg'
      | 'actualRestAfterSeconds' | 'completedAt' | 'status'>>,
  ): SetRecord;

  computeSummary(sessionId: Ulid): SessionTelemetrySummary;

  attachObserverRecord(record: ObserverRecord): void;
}
