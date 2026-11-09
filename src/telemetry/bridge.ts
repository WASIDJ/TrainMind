// RuntimeTelemetry —— Phase 7B.2 遥测接线(域层 /actions → v2 事件流)
//
// 设计要点(对应 trainmind-setrecord-v2-schema.md v1.0.1 + 7B.2 四项裁决):
// 1. 所有真实 /actions 都在服务端拦截记录;前端仅补充 source 标注(voice/touch/auto),
//    未标注时按类型默认:coach_message→voice;rest_complete→定时器已到=auto 否则 touch;其余→touch。
//    动作字符串严格对齐规格 §4 词表;裁决新增项(pain_report/time_constraint)与
//    GAP-2 按钮补齐项遵循同一命名模式,已在规格附录(7B.2 词汇增补)记录。
// 2. ExerciseInstance 以 order_index 定位"非 substituted"实例;被替换时旧实例标 substituted
//    并新建实例(v2 语义);v2 SetRecord 由 SessionStore 创建为独立行
//    (legacy 形状下 data_json='{}',对 legacy 查询不可见)。
// 3. actualRestAfterSeconds 惰性回填:每次 upsert 新 set 行时,用本会话内最近一条
//    completed_at 非空且 rest 未填的 v2 行,以 startedAt(本组)-completedAt(前一组) 回填
//    ——天然覆盖换动作/跳过/疼痛等一切转移类型;末组保持 null。
// 4. 域会话行(workout_sessions)不写 v2 列:时长由 summary 的 data_json 兜底解析;
//    避免与 legacy 共享 status 列的枚举冲突(v2 active/abandoned vs 域层状态机)。
// 5. 疼痛:域行为等效 stop → PainReport.severity=3(域不分级);无 SetRecord 时建
//    status='failed' 的 v2 行承载 PainReport(该组未确认完成,actuals=null=unknown)。
// 6. 遥测失败不阻断产品动作:调用方(server)以 try/catch 包裹,错误单独打日志。
import { DatabaseSync } from "node:sqlite";
import { parseCoachReport } from "../coach-runtime.ts";
import { agencyChoiceFromSpeech, type SetRecord as DomainSetRecord, type WorkoutSession } from "../core.ts";
import { hasColumn } from "./ddl.ts";
import { RUNTIME_AUTO_TRANSITION_DEADLINES, TELEMETRY_CONSTANTS } from "./types.ts";
import { restAfterSeconds } from "./pure.ts";
import { allRows, getRow, mapExerciseRow } from "./records.ts";
import { SessionStore } from "./store.ts";
import { reentrantTx, SqliteTelemetryRecorder } from "./recorder.ts";
import type { AdaptationDelta, AdaptationReasonCode, DifficultyLevel, ExerciseInstance, InteractionEvent, InteractionModality, TrackingMetric, WorkoutRuntimeState } from "./types.ts";

/** /actions 动作前的 deadline 状态快照(interruption 检查点输入;由 server 在 switch 前捕获) */
export interface RuntimeBeforeSnapshot {
  status: string;
  restEndsAt: string | null;
  phaseEndsAt: string | null;
  eventCount?: number; // D14:动作前域事件数(agency 到期默认的 ADP 新鲜度判据)
  coachPhase: string | null;
  coachPhaseStartedAt: string | null;
}
export interface RuntimeActionInput { type: string; [key: string]: unknown }
export interface RuntimeActionResults { setRecord?: DomainSetRecord | undefined; before?: RuntimeBeforeSnapshot }

const RUNNING_STATES = ["warming_up", "exercise_active", "set_feedback", "resting", "paused", "cooling_down"];
const PAIN_LOCATIONS: Array<[RegExp, string]> = [
  [/膝/, "knee"], [/肩/, "shoulder"], [/腰/, "lower_back"], [/背/, "upper_back"],
  [/肘/, "elbow"], [/腕|手腕/, "wrist"], [/髋/, "hip"], [/腿/, "leg"], [/脖|颈/, "neck"],
];

function painLocation(text: string | null): string | null {
  if (!text) return null;
  for (const [pattern, area] of PAIN_LOCATIONS) if (pattern.test(text)) return area;
  return null;
}

function runtimeStateOf(status: string, coachPhase?: string): WorkoutRuntimeState {
  switch (status) {
    case "preview": return "pre_workout";
    case "warming_up": case "cooling_down": return "transition";
    case "exercise_active": return coachPhase === "START_SET" ? "pre_set" : "in_set_counting";
    case "set_feedback": return "post_set";
    case "resting": return "resting";
    case "paused": return "paused";
    case "completed": return "summary";
    case "aborted": return "aborted";
    default: return "transition";
  }
}

function instanceStatusOf(domain: string): ExerciseInstance["status"] {
  switch (domain) {
    case "active": return "in_progress";
    case "completed": return "completed";
    case "skipped": return "skipped";
    case "pain": return "failed";
    case "replaced": return "substituted";
    default: return "pending";
  }
}

function trackingMetricOf(exercise: { repOrTimeBased?: string }): TrackingMetric {
  return exercise.repOrTimeBased === "time" ? "time" : exercise.repOrTimeBased === "hold" ? "hold" : "reps";
}

/** 域 reason → v2 AdaptationReasonCode(词表映射,不改域层枚举) */
function adaptationReason(domainReason: string | undefined): AdaptationReasonCode {
  if (domainReason === "equipment_busy" || domainReason === "equipment_unavailable" || domainReason === "no_legal_replacement") return "equipment_unavailable";
  if (domainReason === "pain") return "pain_reported";
  return "manual_edit";
}

function difficultyOf(domainFeedback: string | undefined): DifficultyLevel | null {
  if (domainFeedback === "too_light") return "easy";
  if (domainFeedback === "right") return "just_right";
  if (domainFeedback === "hard" || domainFeedback === "failed" || domainFeedback === "too_heavy") return "hard";
  return null;
}

type DomainEvent = { type: string; at: string; exerciseId?: string; details?: Record<string, unknown>; id?: string };

export class RuntimeTelemetry {
  private readonly db: DatabaseSync;
  private readonly recorder: SqliteTelemetryRecorder;
  private readonly store: SessionStore;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.recorder = new SqliteTelemetryRecorder(db);
    this.store = new SessionStore(db);
  }

  // ---------- 读取辅助 ----------
  private instanceAt(sessionId: string, orderIndex: number): ExerciseInstance | null {
    const row = getRow(this.db,
      "SELECT * FROM exercise_instances WHERE session_id = ? AND order_index = ? AND status != 'substituted' ORDER BY id LIMIT 1",
      sessionId, orderIndex);
    return row ? mapExerciseRow(row) : null;
  }

  private setRowIdFor(instanceId: string, setNumber: number): string | null {
    const row = getRow(this.db, "SELECT id FROM set_records WHERE exercise_instance_id = ? AND set_number = ?", instanceId, setNumber);
    return row ? (row as { id: string }).id : null;
  }

  private lastDomainEvent(session: WorkoutSession, types: string[]): DomainEvent | undefined {
    for (let i = session.runtime.events.length - 1; i >= 0; i--) {
      const event = session.runtime.events[i]! as unknown as DomainEvent;
      if (types.includes(event.type)) return event;
    }
    return undefined;
  }

  private positionOfExerciseId(session: WorkoutSession, exerciseId: string | undefined): number {
    if (!exerciseId) return -1;
    return session.exercises.findIndex(e => e.exerciseId === exerciseId);
  }

  // ---------- 交互/调整落库 ----------
  private interaction(input: Omit<InteractionEvent, "id" | "seq">): InteractionEvent {
    return this.recorder.recordInteraction(input);
  }

  private baseInteraction(sessionId: string, nowMs: number, state: WorkoutRuntimeState) {
    return { sessionId, occurredAt: nowMs, targetSetRecordId: null, intent: null, success: true, latencyMs: null, transcript: null, error: null } as const;
  }

  private touchButton(sessionId: string, nowMs: number, state: WorkoutRuntimeState, name: string, targetExerciseInstanceId: string | null): InteractionEvent {
    return this.interaction({ ...this.baseInteraction(sessionId, nowMs, state), actor: "user", modality: "touch", action: `touch.button.${name}`, targetExerciseInstanceId, runtimeState: state });
  }

  private systemEvent(sessionId: string, nowMs: number, state: WorkoutRuntimeState, action: string, targetExerciseInstanceId: string | null = null): InteractionEvent {
    return this.interaction({ ...this.baseInteraction(sessionId, nowMs, state), actor: "system", modality: "system", action, targetExerciseInstanceId, runtimeState: state });
  }

  private adaptation(sessionId: string, nowMs: number, input: Omit<Parameters<SqliteTelemetryRecorder["recordAdaptation"]>[0], "applied" | "appliedAt">): void {
    // 冻结设计:recordAdaptation 先落 applied=0,执行确认后 markApplied(两步链)
    const created = this.recorder.recordAdaptation({ ...input, applied: false, appliedAt: null });
    this.recorder.markApplied(created.id, nowMs);
  }

  /** interruption 检查点:动作抵达时回看"动作前"状态是否已超过 expected auto-transition deadline。 */
  private checkInterruption(sessionId: string, input: RuntimeActionInput, before: RuntimeBeforeSnapshot | undefined, arrivingModality: InteractionModality, nowMs: number): void {
    void input;
    if (!before) return;
    const { INTERRUPTION_THRESHOLD_MS } = TELEMETRY_CONSTANTS;
    const PRE_SET_NARRATION_ALLOWANCE_MS = 12_000; // TTS 播报链宽限(见 onAction 注释)
    const record = (stalledState: WorkoutRuntimeState, deadlineState: "pre_set" | "resting" | "transition", overdueMs: number) => {
      const category = arrivingModality === "voice" ? "voice" : arrivingModality === "touch" ? "ui" : "error";
      this.interaction({ sessionId, occurredAt: nowMs, actor: "system", modality: "system", action: `system.interruption.${category}`,
        runtimeState: stalledState, targetSetRecordId: null, targetExerciseInstanceId: null, intent: null, success: true, latencyMs: null, transcript: null,
        error: { code: "auto_transition_overdue", message: `${deadlineState} 超期 ${overdueMs}ms(deadline ${RUNTIME_AUTO_TRANSITION_DEADLINES[deadlineState]}ms)` } });
    };
    if (before.status === "resting" && before.restEndsAt) {
      const overdue = nowMs - Date.parse(before.restEndsAt);
      if (overdue > INTERRUPTION_THRESHOLD_MS) record("resting", "resting", overdue);
    }
    if ((before.status === "warming_up" || before.status === "cooling_down") && before.phaseEndsAt) {
      const overdue = nowMs - Date.parse(before.phaseEndsAt);
      if (overdue > INTERRUPTION_THRESHOLD_MS) record("transition", "transition", overdue);
    }
    if (before.status === "exercise_active" && before.coachPhase === "START_SET" && before.coachPhaseStartedAt) {
      const overdue = nowMs - Date.parse(before.coachPhaseStartedAt) - PRE_SET_NARRATION_ALLOWANCE_MS;
      if (overdue > INTERRUPTION_THRESHOLD_MS) record("pre_set", "pre_set", overdue + PRE_SET_NARRATION_ALLOWANCE_MS);
    }
  }

  // ---------- 实例同步 ----------
  private ensureInstances(session: WorkoutSession): void {
    for (let i = 0; i < session.exercises.length; i++) {
      const exercise = session.exercises[i]!;
      let instance = this.instanceAt(session.sessionId, i);
      if (!instance) instance = this.store.createExerciseInstance({ sessionId: session.sessionId, exerciseId: exercise.exerciseId, orderIndex: i, trackingMetric: trackingMetricOf(exercise) });
      // exerciseId 不一致时不在预同步里替换:替换由 onSubstitution 显式链在同一动作内完成
      // (避免预同步与显式链双重 substitute;不一致若残留会在链路校验中暴露)
      const target = instanceStatusOf(exercise.executionStatus);
      if (instance.status !== target) this.store.setExerciseInstanceStatus(instance.id, target);
    }
    // 被 workout_shorten 丢弃的未开始动作 → skipped
    const dropped = allRows(this.db,
      "SELECT id FROM exercise_instances WHERE session_id = ? AND order_index >= ? AND status = 'pending'",
      session.sessionId, session.exercises.length) as Array<{ id: string }>;
    for (const row of dropped) this.store.setExerciseInstanceStatus(row.id, "skipped");
  }

  // ---------- v2 SetRecord ----------
  private upsertSetFromDomain(session: WorkoutSession, record: DomainSetRecord, override: { status?: "failed"; completedAt?: number } = {}): { id: string; setNumber: number; instanceId: string } {
    const position = session.exercises.findIndex(e => e.id === record.workoutExerciseId);
    const fallback = position >= 0 ? position : session.runtime.currentExerciseIndex;
    const exercise = session.exercises[fallback] ?? session.exercises[0]!;
    const instance = this.instanceAt(session.sessionId, fallback);
    if (!instance) throw new Error(`telemetry: no exercise instance for set ${record.setNumber}`);
    const reps = record.targetReps.match(/^(\d+)(?:\s*[-–—~至]\s*(\d+))?/);
    const repsMin = reps ? Number(reps[1]) : null;
    const repsMax = reps?.[2] ? Number(reps[2]) : repsMin;
    const isTime = exercise.repOrTimeBased === "time";
    const startedAt = session.runtime.currentSetStartedAt ? Date.parse(session.runtime.currentSetStartedAt) : null;
    const completedAt = override.completedAt ?? (Number.isFinite(Date.parse(record.completedAt)) ? Date.parse(record.completedAt) : null);
    const actualReps = isTime ? null : (Number.isInteger(record.actualReps) ? record.actualReps : null);
    const status = override.status ?? (record.pain ? "failed" : record.feedback === "failed" || (repsMin !== null && actualReps !== null && actualReps < repsMin) ? "partial" : "completed");
    const fields = {
      targetWeightKg: record.targetWeight ?? null, targetRepsMin: repsMin, targetRepsMax: repsMax,
      targetDurationSeconds: isTime ? repsMin : null, targetRestAfterSeconds: exercise.restSeconds,
      actualReps, actualDurationSeconds: record.actualDurationSeconds ?? null, actualWeightKg: record.actualWeight ?? null,
      startedAt: Number.isFinite(startedAt) ? startedAt : null, completedAt, status,
    };
    const existing = this.setRowIdFor(instance.id, record.setNumber);
    const id = existing
      ? (this.store.updateSetRecordComputed(existing, fields), existing)
      : this.store.createSetRecord({ exerciseInstanceId: instance.id, setNumber: record.setNumber, ...fields }).id;
    this.backfillRest(session.sessionId, id, fields.startedAt);
    return { id, setNumber: record.setNumber, instanceId: instance.id };
  }

  /** rest 惰性回填:本会话最近一条已完成且 rest 未填的 v2 行(排除自身)。 */
  private backfillRest(sessionId: string, excludeId: string, nextStartedAt: number | null): void {
    if (nextStartedAt === null) return;
    const previous = getRow(this.db,
      `SELECT sr.id, sr.completed_at FROM set_records sr JOIN exercise_instances ei ON ei.id = sr.exercise_instance_id
       WHERE ei.session_id = ? AND sr.id != ? AND sr.completed_at IS NOT NULL AND sr.actual_rest_after_seconds IS NULL
       ORDER BY sr.completed_at DESC LIMIT 1`, sessionId, excludeId) as { id: string; completed_at: number } | undefined;
    if (!previous) return;
    const rest = restAfterSeconds(previous.completed_at, nextStartedAt);
    if (rest !== null) this.store.updateSetRecordComputed(previous.id, { actualRestAfterSeconds: rest });
  }

  // ---------- 主入口:/actions 成功路径 ----------
  onAction(session: WorkoutSession, input: RuntimeActionInput, results: RuntimeActionResults = {}): void {
    const sessionId = session.sessionId;
    const nowMs = Date.now();

    // 计划编辑发生在 pre_workout;不创建实例,仅记录真实触点
    if (input.type.startsWith("plan_")) {
      this.interaction({ ...this.baseInteraction(sessionId, nowMs, "pre_workout"), actor: "user", modality: "touch", action: `touch.button.${input.type}`, runtimeState: "pre_workout", targetExerciseInstanceId: null });
      return;
    }

    // modality:前端标注优先(voice/touch/auto 为传输层信号,auto 最终落为 system 事件);
    // 未标注时仅 coach_message 默认 voice(其余类型前端按钮路径不标注 = touch)
    const declared = typeof input.source === "string" ? input.source : undefined;
    const modality: InteractionModality = declared === "voice" || declared === "touch" || declared === "auto" ? declared
      : input.type === "coach_message" ? "voice" : "touch";

    // 7B.2.1 W7:interruption 检查点(状态机转移检查点统一判定,规格 §5)
    // 仅 deadline 状态(pre_set/resting/transition)且超期才计;等待用户输入的状态永不计。
    // pre_set 的 3s 冻结 deadline 之上加 TTS 播报链宽限(提示语+"3,2,1,开始"≈10s),否则每组必误报;
    // 分类:voice 口令抵达→voice;touch→ui;定时器/叙事流自恢复→error。
    this.checkInterruption(sessionId, input, results.before, modality, nowMs);

    this.ensureInstances(session);
    const state = runtimeStateOf(session.status, session.runtime.coach?.phase);
    const currentInstance = this.instanceAt(sessionId, session.runtime.currentExerciseIndex);
    const recordPosition = results.setRecord ? session.exercises.findIndex(e => e.id === results.setRecord!.workoutExerciseId) : -1;
    const targetInstance = recordPosition >= 0 ? this.instanceAt(sessionId, recordPosition) : currentInstance;

    switch (input.type) {
      case "start": this.touchButton(sessionId, nowMs, state, "start", null); return;
      case "warmup_complete":
        if (modality === "auto") this.systemEvent(sessionId, nowMs, state, "system.autostart.warmup_end", null);
        else this.touchButton(sessionId, nowMs, state, "warmup_complete", null);
        return;
      case "cooldown_complete":
        if (modality === "auto") this.systemEvent(sessionId, nowMs, state, "system.autostart.cooldown_end", null);
        else if (modality === "voice") this.interaction({ ...this.baseInteraction(sessionId, nowMs, state), actor: "user", modality: "voice", action: "voice.command.finish", intent: "workout.finish", runtimeState: state, targetExerciseInstanceId: null });
        else this.touchButton(sessionId, nowMs, state, "cooldown_complete", null);
        return;
      case "coach_enable": this.touchButton(sessionId, nowMs, state, "coach_enable", null); return;
      case "coach_event": {
        // 陪练叙事流的系统事件;仅 next_set 记为 autostart 信号,其余流程标记不记录
        const eventType = input.event != null && typeof input.event === "object" ? (input.event as { type?: string; choice?: string }).type : undefined;
        if (eventType === "next_set") this.systemEvent(sessionId, nowMs, state, "system.autostart.next_set", currentInstance?.id ?? null);
        // D14:三选一卡片点按(触摸路径;语音口令走 coach_message 的 voice.command.agency)
        if (eventType === "agency_choice") {
          const choice = (input.event as { choice?: string }).choice;
          const agencyTouch = this.interaction({ ...this.baseInteraction(sessionId, nowMs, state), actor: "user", modality: "touch", action: "touch.button.agency_choice", intent: `agency.choice.${choice}`, runtimeState: state, targetExerciseInstanceId: currentInstance?.id ?? null, success: true, transcript: null });
          this.recordDoseAdaptation(session, { setRecord: undefined }, agencyTouch, nowMs, "touch"); // D14:卡片选择即剂量
        }
        return;
      }
      case "complete_set": {
        const voiceTranscript = typeof input.transcript === "string" ? input.transcript : null;
        const setCompleteInteraction = modality === "voice"
          ? this.interaction({ ...this.baseInteraction(sessionId, nowMs, state), actor: "user", modality: "voice", action: "voice.command.adjust", intent: "set.complete", runtimeState: state, targetExerciseInstanceId: targetInstance?.id ?? null, transcript: voiceTranscript })
          : this.touchButton(sessionId, nowMs, state, "complete_set", targetInstance?.id ?? null);
        // H1(2026-11-06 全仓审查):complete_set 自动结组也必须落 v2 组记录。
        // 教练流程下服务端已按计划推定补 right 反馈(D17:次数不再依赖口报),results.setRecord 即该组定稿记录;
        // 不走这里的话,默认语音流程的 SetRecord/set_feedbacks/剂量适应 全部静默缺失,事件链在旗舰路径上断链。
        // D20(2026-11-06 复核):反馈来源记 inferred——学员没说"合适"也没点反馈键,是系统按计划推定的,
        // 不冒充用户上报;学员若组后补一句"太重了",会以 voice 覆盖为末次接受(见 applyLateFeedback)。
        // transcript 记 null:完成口令("做完了")不是对难度的表态,原话保留在 interaction_events。
        if (results.setRecord) this.recordCompletedSet(session, results.setRecord, setCompleteInteraction, nowMs, "inferred", null, results.before);
        return;
      }
      case "rest_complete": {
        if (modality === "voice") this.interaction({ ...this.baseInteraction(sessionId, nowMs, "resting"), actor: "user", modality: "voice", action: "voice.command.rest_control", intent: "rest.end", runtimeState: "resting", targetExerciseInstanceId: currentInstance?.id ?? null });
        else if (modality === "auto") this.systemEvent(sessionId, nowMs, "resting", "system.autostart.rest_end", currentInstance?.id ?? null);
        else this.touchButton(sessionId, nowMs, "resting", "skip_rest", currentInstance?.id ?? null);
        // D14:agency 到期默认(学员未选,rest_complete 静默降档)→ 本动作新增的 coach_adjustment 记 ADP
        const baseCount = typeof results.before?.eventCount === "number" ? results.before.eventCount : null;
        const freshAdjustment = baseCount !== null ? (session.runtime.events.slice(baseCount) as Array<{ type?: string }>).find(e => e.type === "coach_adjustment") : undefined;
        if (freshAdjustment) {
          const anchor = modality === "auto" ? this.systemEvent(sessionId, nowMs, "resting", "system.autostart.agency_default", currentInstance?.id ?? null) : this.touchButton(sessionId, nowMs, "resting", "skip_rest", currentInstance?.id ?? null);
          this.recordDoseAdaptation(session, { setRecord: undefined }, anchor, nowMs, modality === "voice" ? "voice" : "touch");
        }
        return;
      }
      case "extend_rest":
        if (modality === "voice") this.interaction({ ...this.baseInteraction(sessionId, nowMs, "resting"), actor: "user", modality: "voice", action: "voice.command.rest_control", intent: "rest.extend", runtimeState: "resting", targetExerciseInstanceId: currentInstance?.id ?? null });
        else this.touchButton(sessionId, nowMs, "resting", "extend_rest", currentInstance?.id ?? null);
        return;
      case "pause":
        if (modality === "voice") this.interaction({ ...this.baseInteraction(sessionId, nowMs, state), actor: "user", modality: "voice", action: "voice.command.pause", intent: "workout.pause", runtimeState: state, targetExerciseInstanceId: currentInstance?.id ?? null });
        else this.touchButton(sessionId, nowMs, state, "pause", currentInstance?.id ?? null);
        return;
      case "resume":
        if (modality === "voice") this.interaction({ ...this.baseInteraction(sessionId, nowMs, "paused"), actor: "user", modality: "voice", action: "voice.command.resume", intent: "workout.resume", runtimeState: "paused", targetExerciseInstanceId: currentInstance?.id ?? null });
        else this.touchButton(sessionId, nowMs, "paused", "resume", currentInstance?.id ?? null);
        return;
      case "abort":
        if (modality === "voice") this.interaction({ ...this.baseInteraction(sessionId, nowMs, state), actor: "user", modality: "voice", action: "voice.command.finish", intent: "workout.abort", runtimeState: state, targetExerciseInstanceId: null });
        else this.touchButton(sessionId, nowMs, state, "abort", null);
        return;
      case "skip": case "replace":
        this.onSubstitution(session, input, nowMs, state, modality);
        return;
      case "feedback": case "coach_message":
        this.onFeedbackOrMessage(session, input, results, nowMs, state, modality);
        return;
      default:
        this.touchButton(sessionId, nowMs, state, String(input.type), currentInstance?.id ?? null);
    }
  }

  // ---------- 跳过/替换链 ----------
  private onSubstitution(session: WorkoutSession, input: RuntimeActionInput, nowMs: number, state: WorkoutRuntimeState, modality: InteractionModality): void {
    const sessionId = session.sessionId;
    const isVoice = modality === "voice";
    const voiceTranscript = isVoice && typeof input.message === "string" ? input.message : null;
    const mainInteraction = isVoice
      ? this.interaction({ ...this.baseInteraction(sessionId, nowMs, state), actor: "user", modality: "voice", action: input.type === "skip" ? "voice.command.skip" : "voice.command.substitute", intent: input.type === "skip" ? "exercise.skip" : "exercise.substitute", runtimeState: state, targetExerciseInstanceId: this.instanceAt(sessionId, session.runtime.currentExerciseIndex)?.id ?? null, transcript: voiceTranscript })
      : this.touchButton(sessionId, nowMs, state, input.type === "skip" ? "skip_exercise" : "substitute_confirm", this.instanceAt(sessionId, session.runtime.currentExerciseIndex)?.id ?? null);

    const replaced = this.lastDomainEvent(session, ["exercise_replaced"]);
    const unavailable = this.lastDomainEvent(session, ["replacement_unavailable"]);
    const skipped = this.lastDomainEvent(session, ["exercise_skipped"]);
    const trigger = { modality: (isVoice ? "voice" : "touch") as InteractionModality, interactionEventId: mainInteraction.id, actor: "user" as const };

    if (replaced) {
      const details = (replaced.details ?? {}) as { originalExerciseId?: string; replacementExerciseId?: string; reason?: string };
      const oldInstance = this.instanceAt(sessionId, session.runtime.currentExerciseIndex); // replace 不前移游标
      if (oldInstance && details.replacementExerciseId && oldInstance.exerciseId === details.originalExerciseId) {
        // 幂等守卫:仅当旧实例仍指向原动作时执行 v2 替换(防止重复 substitute)
        this.store.substituteExerciseInstance(oldInstance.id, details.replacementExerciseId);
      }
      this.adaptation(sessionId, nowMs, {
        sessionId, occurredAt: nowMs, exerciseInstanceId: this.instanceAt(sessionId, session.runtime.currentExerciseIndex)?.id ?? null, setRecordId: null, type: "exercise_substitution",
        deltas: [{ field: "exerciseId", before: details.originalExerciseId ?? null, after: details.replacementExerciseId }],
        triggeredBy: trigger,
        reason: { code: adaptationReason(details.reason), text: typeof details.reason === "string" ? details.reason : null },
        evidenceRefs: [`domain_event:${replaced.id ?? replaced.at}`],
      });
      this.ensureInstances(session);
      return;
    }

    // 跳过链:skip / replace 无可行替代(replacement_unavailable → skipExercise,游标已前移)
    const skippedFromReplace = Boolean(unavailable && skipped);
    const skipPosition = session.exercises[session.runtime.currentExerciseIndex - 1]?.executionStatus === "skipped"
      ? session.runtime.currentExerciseIndex - 1
      : session.runtime.currentExerciseIndex;
    const instance = this.instanceAt(sessionId, skipPosition);
    if (instance) {
      if (instance.status !== "skipped") this.store.setExerciseInstanceStatus(instance.id, "skipped");
      const originalId = (unavailable?.details as { originalExerciseId?: string } | undefined)?.originalExerciseId
        ?? session.exercises[skipPosition]?.exerciseId ?? null;
      this.adaptation(sessionId, nowMs, {
        sessionId, occurredAt: nowMs, exerciseInstanceId: instance.id, setRecordId: null, type: "exercise_skip",
        deltas: [{ field: "exerciseId", before: originalId, after: null }],
        triggeredBy: trigger,
        reason: { code: skippedFromReplace ? "equipment_unavailable" : adaptationReason(typeof input.reason === "string" ? input.reason : undefined), text: skippedFromReplace ? "无可行替代动作" : (typeof input.reason === "string" ? input.reason : null) },
        evidenceRefs: [`domain_event:${skipped?.id ?? skipped?.at ?? ""}`],
      });
    }
    this.ensureInstances(session);
  }

  // ---------- 反馈/口令链(feedback 按钮 + coach_message) ----------
  private onFeedbackOrMessage(session: WorkoutSession, input: RuntimeActionInput, results: RuntimeActionResults, nowMs: number, state: WorkoutRuntimeState, modality: InteractionModality): void {
    const sessionId = session.sessionId;
    const isMessage = input.type === "coach_message";
    const transcript = isMessage && typeof input.message === "string" ? input.message : null;
    const domainFeedback = input.type === "feedback" && typeof input.feedback === "string" ? input.feedback : undefined;
    const parsed = isMessage ? parseCoachReport(transcript ?? "") : undefined;

    // ---- D16-B:Agency 口语选择(服务器路由优先级最高;域事件 coach_agency_choice 为唯一真相) ----
    // 必须先于反馈分类:「轻一点」既是难度词也是 agency 口令,服务器在等三选一时按 agency 路由
    {
      const baseCount = typeof results.before?.eventCount === "number" ? results.before.eventCount : null;
      const freshChoice = baseCount !== null ? (session.runtime.events.slice(baseCount) as Array<{ type?: string; details?: { choice?: string } }>).find(e => e.type === "coach_agency_choice") : undefined;
      if (isMessage && freshChoice?.details?.choice) {
        const choice = freshChoice.details.choice;
        const agencyInteraction = this.interaction({ ...this.baseInteraction(sessionId, nowMs, state), actor: "user", modality: modality === "touch" ? "touch" : "voice", action: modality === "touch" ? "touch.button.agency_choice" : "voice.command.agency", intent: `agency.choice.${choice}`, runtimeState: state, targetExerciseInstanceId: this.instanceAt(sessionId, session.runtime.currentExerciseIndex)?.id ?? null, success: true, transcript });
        this.recordDoseAdaptation(session, { setRecord: undefined, before: results.before }, agencyInteraction, nowMs, modality === "touch" ? "touch" : "voice");
        return;
      }
    }

    // ---- 疼痛(GAP-1):voice.command.pain_report / touch.button.pain_report + Safety Gate ----
    const isPain = parsed?.type === "pain" || domainFeedback === "pain" || Boolean(results.setRecord?.pain);
    if (isPain) {
      const viaVoice = isMessage || modality === "voice";
      const painInteraction = viaVoice
        ? this.interaction({ ...this.baseInteraction(sessionId, nowMs, state), actor: "user", modality: "voice", action: "voice.command.pain_report", intent: "safety.pain_report", runtimeState: state, targetExerciseInstanceId: this.instanceAt(sessionId, session.runtime.currentExerciseIndex)?.id ?? null, transcript })
        : this.touchButton(sessionId, nowMs, state, "pain_report", this.instanceAt(sessionId, session.runtime.currentExerciseIndex)?.id ?? null);
      // 承载行:有域 record 用之;无则建 failed 行(该组未确认完成 → actuals=null)
      let anchorId: string, anchorInstance: string;
      if (results.setRecord) {
        const anchor = this.upsertSetFromDomain(session, results.setRecord, { status: "failed" });
        anchorId = anchor.id; anchorInstance = anchor.instanceId;
      } else {
        const instance = this.instanceAt(sessionId, session.runtime.currentExerciseIndex);
        if (!instance) throw new Error("telemetry: pain without exercise instance");
        const exercise = session.exercises[session.runtime.currentExerciseIndex] ?? session.exercises.at(-1)!;
        const reps = exercise.targetReps.match(/^(\d+)/);
        const existing = this.setRowIdFor(instance.id, session.runtime.currentSetNumber);
        if (existing) { anchorId = existing; anchorInstance = instance.id; }
        else {
          const startedAt = session.runtime.currentSetStartedAt ? Date.parse(session.runtime.currentSetStartedAt) : null;
          const created = this.store.createSetRecord({ exerciseInstanceId: instance.id, setNumber: session.runtime.currentSetNumber, status: "failed",
            targetWeightKg: exercise.currentWeight ?? null, targetRepsMin: reps ? Number(reps[1]) : null, targetRepsMax: reps ? Number(reps[1]) : null,
            targetDurationSeconds: exercise.repOrTimeBased === "time" && reps ? Number(reps[1]) : null, targetRestAfterSeconds: exercise.restSeconds,
            startedAt: Number.isFinite(startedAt) ? startedAt : null, completedAt: nowMs });
          anchorId = created.id; anchorInstance = instance.id;
        }
      }
      this.recorder.recordSetFeedback({ setRecordId: anchorId, difficulty: null, fatigue: null, pain: { severity: 3, location: painLocation(transcript) }, source: viaVoice ? "voice" : "touch", transcript, interactionEventId: painInteraction.id, capturedAt: nowMs });
      this.adaptation(sessionId, nowMs, {
        sessionId, occurredAt: nowMs, exerciseInstanceId: anchorInstance, setRecordId: anchorId, type: "safety_stop", deltas: [],
        triggeredBy: { modality: viaVoice ? "voice" : "touch", interactionEventId: painInteraction.id, actor: "user" },
        reason: { code: "pain_reported", text: transcript ?? "疼痛反馈" }, evidenceRefs: [],
      });
      this.systemEvent(sessionId, nowMs, state, "system.safety.trigger", anchorInstance);
      return;
    }

    // ---- coach_message 口令分发 ----
    if (isMessage) {
      if (parsed?.type === "substitute") { this.onSubstitution(session, input, nowMs, state, "voice"); return; }
      if (parsed?.type === "time_constraint") {
        const interaction = this.interaction({ ...this.baseInteraction(sessionId, nowMs, state), actor: "user", modality: "voice", action: "voice.command.time_constraint", intent: "workout.time_constraint", runtimeState: state, targetExerciseInstanceId: this.instanceAt(sessionId, session.runtime.currentExerciseIndex)?.id ?? null, transcript });
        const shortened = this.lastDomainEvent(session, ["workout_shortened"]);
        if (shortened) {
          const details = (shortened.details ?? {}) as { beforeMinutes?: number; afterMinutes?: number };
          this.adaptation(sessionId, nowMs, {
            sessionId, occurredAt: nowMs, exerciseInstanceId: null, setRecordId: null, type: "workout_shorten",
            deltas: [{ field: "durationSeconds", before: (details.beforeMinutes ?? 0) * 60, after: (details.afterMinutes ?? 0) * 60 }],
            triggeredBy: { modality: "voice", interactionEventId: interaction.id, actor: "user" },
            reason: { code: "time_constraint", text: transcript }, evidenceRefs: [`domain_event:${shortened.id ?? shortened.at}`],
          });
          this.ensureInstances(session); // 丢弃的动作 → skipped
        }
        return;
      }
      if (!parsed) {
        // 前端路由命中但解析未识别(路由/解析词表不同步的防御分支):记失败查询,不计入口令成功
        // D14:教练等三选一时的口语选择(与 server 路由同源)→ voice.command.agency,不计入失败
        // D16-B:选择此时已被服务器应用(pendingAgency 已清),真值取本动作新推入的 coach_agency_choice 域事件,口令分类只做兜底
        const baseCount = typeof results.before?.eventCount === "number" ? results.before.eventCount : null;
        const freshChoiceEvent = baseCount !== null ? (session.runtime.events.slice(baseCount) as Array<{ type?: string; details?: { choice?: string } }>).find(e => e.type === "coach_agency_choice") : undefined;
        const agency = freshChoiceEvent?.details?.choice ?? agencyChoiceFromSpeech(transcript ?? "", session.runtime.coach?.pendingAgency?.scope ?? "set");
        if (agency) {
          const agencyInteraction = this.interaction({ ...this.baseInteraction(sessionId, nowMs, state), actor: "user", modality: modality === "touch" ? "touch" : "voice", action: modality === "touch" ? "touch.button.agency_choice" : "voice.command.agency", intent: `agency.choice.${agency}`, runtimeState: state, targetExerciseInstanceId: this.instanceAt(sessionId, session.runtime.currentExerciseIndex)?.id ?? null, success: true, transcript });
          this.recordDoseAdaptation(session, { setRecord: undefined }, agencyInteraction, nowMs, modality === "touch" ? "touch" : "voice"); // D14:选择即剂量,ADP 取刚推入的 coach_adjustment
          return;
        }
        this.interaction({ ...this.baseInteraction(sessionId, nowMs, state), actor: "user", modality: modality === "touch" ? "touch" : "voice", action: modality === "touch" ? "touch.input.text" : "voice.command.query", runtimeState: state, targetExerciseInstanceId: null, success: false, transcript, error: { code: "intent_unrecognized", message: null } });
        return;
      }
      if (parsed.type === "user_report") {
        const difficulty = difficultyOf(parsed.feedback);
        const voiceAction = parsed.completed === true ? "voice.command.adjust" : difficulty === "easy" ? "voice.command.feedback.easy" : difficulty === "hard" ? "voice.command.feedback.hard" : "voice.command.feedback.just_right";
        const intent = parsed.completed === true ? "set.complete" : difficulty === "easy" ? "feedback.difficulty.easy" : difficulty === "hard" ? "feedback.difficulty.hard" : "feedback.difficulty.just_right";
        const interaction = this.interaction({ ...this.baseInteraction(sessionId, nowMs, state), actor: "user", modality: modality === "touch" ? "touch" : "voice", action: modality === "touch" ? "touch.input.text" : voiceAction, intent: modality === "touch" ? null : intent, runtimeState: state, targetExerciseInstanceId: this.instanceAt(sessionId, session.runtime.currentExerciseIndex)?.id ?? null, transcript });
        if (results.setRecord) this.recordCompletedSet(session, results.setRecord, interaction, nowMs, modality === "touch" ? "touch" : "voice", transcript, results.before);
        else this.recordDoseAdaptation(session, results, interaction, nowMs, modality === "touch" ? "touch" : "voice");
        return;
      }
      return; // start_set 等 flow 事件不会出现在 coach_message(case 白名单已挡)
    }

    // ---- feedback 按钮(touch 为主;语音 pain 已在上面处理)----
    const difficulty = difficultyOf(domainFeedback);
    const buttonName = domainFeedback === "too_light" ? "feedback_easy" : domainFeedback === "right" ? "feedback_just_right" : "feedback_hard";
    const recordPosition = results.setRecord ? session.exercises.findIndex(e => e.id === results.setRecord!.workoutExerciseId) : -1;
    const targetInstance = this.instanceAt(sessionId, recordPosition >= 0 ? recordPosition : session.runtime.currentExerciseIndex);
    const interaction = this.touchButton(sessionId, nowMs, state, buttonName, targetInstance?.id ?? null);
    if (results.setRecord) this.recordCompletedSet(session, results.setRecord, interaction, nowMs, "touch", null, results.before);
    else this.recordDoseAdaptation(session, results, interaction, nowMs, "touch");
  }

  // source:反馈内容的来源。语音/触摸=用户真的说了/点了;inferred=系统按计划推定(D20,不冒充用户上报)
  private recordCompletedSet(session: WorkoutSession, record: DomainSetRecord, interaction: InteractionEvent, nowMs: number, source: "voice" | "touch" | "inferred", transcript: string | null, before?: RuntimeBeforeSnapshot): void {
    // C1(2026-11-09):组行 + 反馈行 + 剂量适应必须同生共死。
    // 此前三步各自 SAVEPOINT/RELEASE(已落定),任一步抛错只回滚尾段,而 /actions 的 catch
    // 只记日志、外层 COMMIT 照常提交 → 留下"有组行、没反馈、少适应事件"的半截链,
    // validateSessionChain 也查不出"组无反馈"。这里用一个外层事务包住,失败整链回滚。
    reentrantTx(this.db, () => {
      const anchor = this.upsertSetFromDomain(session, record);
      this.recorder.recordSetFeedback({ setRecordId: anchor.id, difficulty: difficultyOf(record.feedback), fatigue: null, pain: null, source, transcript, interactionEventId: interaction.id, capturedAt: nowMs });
      // D20:剂量适应的触发模态取自交互事件本身(voice/touch),与反馈来源(inferred)解耦——
      // 用户确实完成了这组(真交互),被系统推定的只是"合适"这个判断
      this.recordDoseAdaptation(session, { setRecord: record, before }, interaction, nowMs, interaction.modality === "voice" ? "voice" : "touch", anchor.id, anchor.instanceId);
    });
  }

  /** 剂量调整 → AdaptationEvent(weight_change/rep_change),证据优先取域 coach_adjustment 事件。 */
  private recordDoseAdaptation(session: WorkoutSession, results: RuntimeActionResults, interaction: InteractionEvent, nowMs: number, modality: "voice" | "touch", setRecordId?: string, instanceId?: string): void {
    const sessionId = session.sessionId;
    let adjustment = this.lastDomainEvent(session, ["coach_adjustment"]);
    // D16-B 新鲜度:只认"本动作期间新产生"的 coach_adjustment,防止跨动作 offer 提前返回后捡到上一动作的陈旧剂量事件重复记账
    const baseCount = typeof results.before?.eventCount === "number" ? results.before.eventCount : null;
    if (adjustment && baseCount !== null && session.runtime.events.indexOf(adjustment) < baseCount) adjustment = undefined;
    const deltas: AdaptationDelta[] = [];
    let exerciseId: string | undefined;
    if (adjustment) {
      const details = (adjustment.details ?? {}) as { before?: { weightKg?: number; targetReps?: string; exerciseId?: string }; after?: { weightKg?: number; targetReps?: string }; agencyChoice?: string; skipped?: boolean };
      exerciseId = adjustment.exerciseId;
      // D16-B:跨动作"少练一个" → exercise_skip 适应(带 agency 溯源)
      if (details.agencyChoice === "skip_next") {
        const skipInstance = this.instanceAt(sessionId, this.positionOfExerciseId(session, details.before?.exerciseId) >= 0 ? this.positionOfExerciseId(session, details.before?.exerciseId) : session.runtime.currentExerciseIndex);
        this.adaptation(sessionId, nowMs, { sessionId, occurredAt: nowMs, exerciseInstanceId: skipInstance?.id ?? null, setRecordId: setRecordId ?? null, type: "exercise_skip", deltas: [{ field: "exerciseId", before: details.before?.exerciseId ?? null, after: null }], triggeredBy: { modality, interactionEventId: interaction.id, actor: "user" }, reason: { code: "user_agency_skip", text: null }, evidenceRefs: [`domain_event:${adjustment.id ?? adjustment.at}`] });
        return;
      }
      if (details.before?.weightKg !== undefined && details.after?.weightKg !== undefined && details.before.weightKg !== details.after.weightKg)
        deltas.push({ field: "weightKg", before: details.before.weightKg, after: details.after.weightKg });
      const beforeReps = details.before?.targetReps?.match(/^(\d+)/)?.[1], afterReps = details.after?.targetReps?.match(/^(\d+)/)?.[1];
      if (beforeReps && afterReps && beforeReps !== afterReps) {
        deltas.push({ field: "repsMin", before: Number(beforeReps), after: Number(afterReps) });
        deltas.push({ field: "repsMax", before: Number(beforeReps), after: Number(afterReps) });
      }
    } else if (results.setRecord) {
      // 非教练路径:submitSetFeedback 直接调整 currentWeight;before 取处方快照,after 取调整后
      const position = session.exercises.findIndex(e => e.id === results.setRecord!.workoutExerciseId);
      const exercise = session.exercises[position];
      if (exercise && results.setRecord.targetWeight !== undefined && exercise.currentWeight !== undefined && results.setRecord.targetWeight !== exercise.currentWeight)
        deltas.push({ field: "weightKg", before: results.setRecord.targetWeight, after: exercise.currentWeight });
    }
    if (!deltas.length) return;
    const instance = instanceId
      ? { id: instanceId }
      : this.instanceAt(sessionId, this.positionOfExerciseId(session, exerciseId) >= 0 ? this.positionOfExerciseId(session, exerciseId) : session.runtime.currentExerciseIndex);
    this.adaptation(sessionId, nowMs, {
      sessionId, occurredAt: nowMs, exerciseInstanceId: instance?.id ?? null, setRecordId: setRecordId ?? null,
      type: deltas.some(d => d.field === "weightKg") ? "weight_change" : "rep_change", deltas,
      triggeredBy: { modality, interactionEventId: interaction.id, actor: "user" },
      reason: { code: results.setRecord?.feedback === "too_light" ? "user_reported_too_easy" : "user_reported_too_hard", text: null },
      evidenceRefs: adjustment ? [`domain_event:${adjustment.id ?? adjustment.at}`] : [],
    });
  }

  // ---------- ASR 重试(服务端 transcribe 422 + 浏览器识别失败上报)----------
  private latestRunningSession(userId: string | null): { id: string; status: string } | undefined {
    const placeholders = RUNNING_STATES.map(() => "?").join(",");
    // fresh 形状没有 user_id 列(域会话仅存在于 legacy 形状):忽略 userId,退回最近运行中会话
    const byUser = userId !== null && hasColumn(this.db, "workout_sessions", "user_id");
    return (byUser
      ? getRow(this.db, `SELECT id, status FROM workout_sessions WHERE user_id = ? AND status IN (${placeholders}) ORDER BY created_at DESC LIMIT 1`, userId, ...RUNNING_STATES)
      // C4(2026-11-09):旧写法在 else 分支里 byUser 恒 false,三元恒取 started_at —— 而 legacy 库
      // 该列(回填前)全为 NULL,ORDER BY 全等值 → SQLite 按 rowid 返回**最早**插入的会话,
      // 与"最近运行中会话"正好相反。改成:有 started_at 的优先(ms),其余回落到 created_at 文本,
      // 再以 rowid 兜底。注意不能把两者 COALESCE 成一个键(INTEGER 与 TEXT 排序规则不同);
      // fresh 形状既无 created_at 也无 user_id,这里按列存在性拼 ORDER BY。
      : getRow(this.db, `SELECT id, status FROM workout_sessions WHERE status IN (${placeholders}) ORDER BY COALESCE(started_at, 0) DESC${hasColumn(this.db, "workout_sessions", "created_at") ? ", created_at DESC" : ""}, rowid DESC LIMIT 1`, ...RUNNING_STATES)) as { id: string; status: string } | undefined;
  }

  recordAsrRetry(userId: string | null, code = "asr_no_speech"): void {
    const running = this.latestRunningSession(userId);
    if (!running) return;
    this.interaction({ sessionId: running.id, occurredAt: Date.now(), actor: "system", modality: "voice", action: "voice.asr_retry", runtimeState: runtimeStateOf(running.status), targetSetRecordId: null, targetExerciseInstanceId: null, intent: null, success: false, latencyMs: null, transcript: null, error: { code, message: null } });
  }

  // ---------- 教练叙事层(D11):红旗命中与 LLM 回退的事后记录(动作事务之外,自有事务)----------
  recordNarration(userId: string | null, detail: { kind: "redflag" | "fallback"; code?: string; transcript?: string | null }): void {
    const running = this.latestRunningSession(userId);
    if (!running) return;
    this.interaction({ sessionId: running.id, occurredAt: Date.now(), actor: "system", modality: "voice", action: "coach.narration", runtimeState: runtimeStateOf(running.status), targetSetRecordId: null, targetExerciseInstanceId: null, intent: `coach.narration.${detail.kind}`, success: detail.kind !== "fallback", latencyMs: null, transcript: detail.transcript?.slice(0, 120) ?? null, error: detail.kind === "fallback" ? { code: detail.code ?? "unknown", message: null } : null });
  }

  // ---------- 组内听觉感知 v1(《组内听觉感知设计》§6.3):时机命中率可归因 ----------
  // 只记录"说了什么时机";感知事件永不进剂量/安全遥测(adaptation/safety 由域动作独占)。
  recordPerception(userId: string | null, detail: { trigger: string; delivered: boolean }): void {
    const running = this.latestRunningSession(userId);
    if (!running) return;
    this.interaction({ sessionId: running.id, occurredAt: Date.now(), actor: "system", modality: "voice", action: "coach.perception", runtimeState: runtimeStateOf(running.status), targetSetRecordId: null, targetExerciseInstanceId: null, intent: `coach.perception.trigger.${detail.trigger}`, success: detail.delivered, latencyMs: null, transcript: null, error: null });
  }
}
