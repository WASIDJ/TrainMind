// 规格 §9.2 — Golden test:模拟完整会话,全部走 production path(SessionStore + SqliteTelemetryRecorder)
//
// 场景(规格原文):报数 → 做组 → 反馈 → 调整 → 休息 → 下一组;
// 含 1 次器械占用语音替换、1 次 ASR 重试后语音成功、1 次 touch 兜底按钮。
//
// 链路主线(任务书要求完整回放):
//   语音反馈"有点重" → accepted feedback → 80→75kg adaptation → applied → 下一组 target=75kg
import test from "node:test";
import assert from "node:assert/strict";
import { freshDb, setupSession, interaction } from "./helpers.ts";
import { renderTimeline, replayTimeline, validateSessionChain } from "../../src/telemetry/index.ts";
import { restAfterSeconds } from "../../src/telemetry/pure.ts";

const T = 1_700_000_000_000; // 会话起点(epoch ms)

test("golden:完整训练会话 — 事件链回放 / 跨表 timeline / summary / target 快照 / 末组 rest=null", () => {
  const t = freshDb();
  try {
    const { store, recorder: r, sessionId } = setupSession(t, T);

    // ===== 处方:深蹲 3 组(barbell-squat)+ 卧推替身链 =====
    const squat = store.createExerciseInstance({ sessionId, exerciseId: "barbell-squat", orderIndex: 0, trackingMetric: "reps" });
    const bench = store.createExerciseInstance({ sessionId, exerciseId: "dumbbell-bench-press", orderIndex: 1, trackingMetric: "reps" });
    store.setExerciseInstanceStatus(squat.id, "in_progress");

    // ---------- 深蹲 第 1 组:语音反馈"有点重" → 80→75 调整 ----------
    const e1 = r.recordInteraction(interaction(sessionId, { actor: "system", modality: "system", action: "system.autostart.next_set", runtimeState: "transition", targetExerciseInstanceId: squat.id, occurredAt: T + 5_000 }));
    const set1 = store.createSetRecord({ exerciseInstanceId: squat.id, setNumber: 1, status: "completed", targetWeightKg: 80, targetRepsMin: 8, targetRepsMax: 8, targetRestAfterSeconds: 90, startedAt: T + 5_000 });
    r.finalizeSet(set1.id, { actualReps: 8, actualWeightKg: 80, completedAt: T + 95_000, status: "completed" });

    const e2 = r.recordInteraction(interaction(sessionId, { action: "voice.command.feedback.hard", success: true, runtimeState: "post_set", targetSetRecordId: set1.id, intent: "feedback.difficulty.hard", transcript: "有点重", latencyMs: 1200, occurredAt: T + 98_000 }));
    const fb1 = r.recordSetFeedback({ setRecordId: set1.id, difficulty: "hard", fatigue: 3, pain: null, source: "voice", transcript: "有点重", interactionEventId: e2.id, capturedAt: T + 98_900 });

    const a1 = r.recordAdaptation({
      sessionId, occurredAt: T + 99_000, exerciseInstanceId: squat.id, setRecordId: null, // 目标"下一组"行尚未存在(见 SPEC_NOTE-1)
      type: "weight_change", deltas: [{ field: "weightKg", before: 80, after: 75 }],
      triggeredBy: { modality: "voice", interactionEventId: e2.id, actor: "user" },
      reason: { code: "user_reported_too_hard", text: "上一组偏重,下一组降 5kg" },
      evidenceRefs: ["ev-set1-rpe"], applied: false, appliedAt: null,
    });
    r.markApplied(a1.id, T + 99_200);

    r.recordInteraction(interaction(sessionId, { actor: "system", modality: "system", action: "system.autostart.rest_end", runtimeState: "resting", targetExerciseInstanceId: squat.id, occurredAt: T + 179_900 }));

    // ---------- 深蹲 第 2 组:ASR 重试后语音成功(target 快照 75kg) ----------
    r.recordInteraction(interaction(sessionId, { actor: "system", modality: "system", action: "system.autostart.next_set", runtimeState: "transition", targetExerciseInstanceId: squat.id, occurredAt: T + 180_000 }));
    const set2 = store.createSetRecord({ exerciseInstanceId: squat.id, setNumber: 2, status: "completed", targetWeightKg: 75, targetRepsMin: 8, targetRepsMax: 8, targetRestAfterSeconds: 90, startedAt: T + 180_000 });
    r.finalizeSet(set2.id, { actualReps: 8, actualWeightKg: 75, completedAt: T + 268_000, status: "completed" });
    r.finalizeSet(set1.id, { actualRestAfterSeconds: restAfterSeconds(T + 95_000, T + 180_000) }); // 85s

    r.recordInteraction(interaction(sessionId, { actor: "system", modality: "voice", action: "voice.asr_retry", runtimeState: "post_set", targetSetRecordId: set2.id, error: { code: "asr_low_confidence", message: null }, occurredAt: T + 270_000 }));
    const e7 = r.recordInteraction(interaction(sessionId, { action: "voice.command.feedback.just_right", success: true, runtimeState: "post_set", targetSetRecordId: set2.id, intent: "feedback.difficulty.just_right", transcript: "还行,刚好", latencyMs: 1100, occurredAt: T + 274_000 }));
    r.recordSetFeedback({ setRecordId: set2.id, difficulty: "just_right", fatigue: null, pain: null, source: "voice", transcript: "还行,刚好", interactionEventId: e7.id, capturedAt: T + 274_800 });
    // just_right → 维持,不产生 adaptation

    r.recordInteraction(interaction(sessionId, { actor: "system", modality: "system", action: "system.autostart.rest_end", runtimeState: "resting", targetExerciseInstanceId: squat.id, occurredAt: T + 355_000 }));

    // ---------- 深蹲 第 3 组:无反馈,直接休息流转 ----------
    r.recordInteraction(interaction(sessionId, { actor: "system", modality: "system", action: "system.autostart.next_set", runtimeState: "transition", targetExerciseInstanceId: squat.id, occurredAt: T + 356_000 }));
    const set3 = store.createSetRecord({ exerciseInstanceId: squat.id, setNumber: 3, status: "completed", targetWeightKg: 75, targetRepsMin: 8, targetRepsMax: 8, targetRestAfterSeconds: 90, startedAt: T + 356_000 });
    r.finalizeSet(set3.id, { actualReps: 8, actualWeightKg: 75, completedAt: T + 440_000, status: "completed" });
    r.finalizeSet(set2.id, { actualRestAfterSeconds: restAfterSeconds(T + 268_000, T + 356_000) }); // 88s
    store.setExerciseInstanceStatus(squat.id, "completed");

    r.recordInteraction(interaction(sessionId, { actor: "system", modality: "system", action: "system.autostart.rest_end", runtimeState: "resting", targetExerciseInstanceId: bench.id, occurredAt: T + 525_000 }));

    // ---------- 卧推 → 器械占用语音替换 ----------
    const eSub = r.recordInteraction(interaction(sessionId, { action: "voice.command.substitute", success: true, runtimeState: "pre_set", targetExerciseInstanceId: bench.id, intent: "substitute.equipment_unavailable", transcript: "器械有人,换一个", latencyMs: 950, occurredAt: T + 530_000 }));
    const a2 = r.recordAdaptation({
      sessionId, occurredAt: T + 531_000, exerciseInstanceId: bench.id, setRecordId: null,
      type: "exercise_substitution", deltas: [{ field: "exerciseId", before: "dumbbell-bench-press", after: "incline-dumbbell-press" }],
      triggeredBy: { modality: "voice", interactionEventId: eSub.id, actor: "user" },
      reason: { code: "equipment_unavailable", text: "器械被占用,切换到上斜哑铃卧推" },
      evidenceRefs: ["ev-equipment-occupied"], applied: false, appliedAt: null,
    });
    r.markApplied(a2.id, T + 531_500);
    const { previous: oldBench, replacement: incline } = store.substituteExerciseInstance(bench.id, "incline-dumbbell-press");
    r.finalizeSet(set3.id, { actualRestAfterSeconds: restAfterSeconds(T + 440_000, T + 545_000) }); // 105s,含替换决策

    // ---------- 上斜哑铃卧推 第 1 组:touch 兜底按钮 ----------
    r.recordInteraction(interaction(sessionId, { actor: "system", modality: "system", action: "system.autostart.next_set", runtimeState: "transition", targetExerciseInstanceId: incline.id, occurredAt: T + 545_000 }));
    const iset1 = store.createSetRecord({ exerciseInstanceId: incline.id, setNumber: 1, status: "completed", targetWeightKg: 45, targetRepsMin: 10, targetRepsMax: 12, targetRestAfterSeconds: 90, startedAt: T + 545_000 });
    r.finalizeSet(iset1.id, { actualReps: 10, actualWeightKg: 45, completedAt: T + 625_000, status: "completed" });

    const eTouch = r.recordInteraction(interaction(sessionId, { actor: "user", modality: "touch", action: "touch.button.feedback_hard", runtimeState: "post_set", targetSetRecordId: iset1.id, intent: "feedback.difficulty.hard", occurredAt: T + 628_000 }));
    r.recordSetFeedback({ setRecordId: iset1.id, difficulty: "hard", fatigue: null, pain: null, source: "touch", transcript: null, interactionEventId: eTouch.id, capturedAt: T + 628_200 });

    const a3 = r.recordAdaptation({
      sessionId, occurredAt: T + 629_000, exerciseInstanceId: incline.id, setRecordId: null,
      type: "weight_change", deltas: [{ field: "weightKg", before: 45, after: 40 }],
      triggeredBy: { modality: "touch", interactionEventId: eTouch.id, actor: "user" },
      reason: { code: "user_reported_too_hard", text: "按钮反馈偏重,下一组降至 40kg" },
      evidenceRefs: ["ev-touch-fallback"], applied: false, appliedAt: null,
    });
    r.markApplied(a3.id, T + 629_300);

    r.recordInteraction(interaction(sessionId, { actor: "system", modality: "system", action: "system.autostart.rest_end", runtimeState: "resting", targetExerciseInstanceId: incline.id, occurredAt: T + 710_000 }));

    // ---------- 上斜 第 2 组(target 40kg)→ 会话结束,末组 rest = null ----------
    r.recordInteraction(interaction(sessionId, { actor: "system", modality: "system", action: "system.autostart.next_set", runtimeState: "transition", targetExerciseInstanceId: incline.id, occurredAt: T + 711_000 }));
    const iset2 = store.createSetRecord({ exerciseInstanceId: incline.id, setNumber: 2, status: "completed", targetWeightKg: 40, targetRepsMin: 10, targetRepsMax: 12, targetRestAfterSeconds: 90, startedAt: T + 711_000 });
    r.finalizeSet(iset2.id, { actualReps: 10, actualWeightKg: 40, completedAt: T + 795_000, status: "completed" }); // 无后续 work interval → rest 不回填
    r.finalizeSet(iset1.id, { actualRestAfterSeconds: restAfterSeconds(T + 625_000, T + 711_000) }); // 86s
    store.setExerciseInstanceStatus(incline.id, "completed");
    store.completeSession(sessionId, "completed", T + 800_000);

    // 观察员记录(Phase 7B 人工层)
    r.attachObserverRecord({
      sessionId, recordedBy: "observer-1", phonePickupCount: 2, screenGlanceCount: 4, observerInterventionCount: 0,
      pickups: [{ atSec: 270, reason: "asr_misheard", note: "ASR 重试时看了一眼" }, { atSec: 626, reason: "curiosity_check" }],
    });

    // ===== 断言 =====
    // 1) 链路主线:语音"有点重" → accepted feedback → 80→75 → applied → 下一组 target=75
    assert.equal(a1.triggeredBy.interactionEventId, e2.id);
    assert.equal(a1.deltas[0].before, 80); assert.equal(a1.deltas[0].after, 75);
    const a1Row = r.getAdaptation(a1.id)!;
    assert.equal(a1Row.applied, true);
    assert.ok(a1Row.appliedAt! >= a1Row.occurredAt);
    assert.equal(fb1.interactionEventId, e2.id);
    assert.ok(fb1.capturedAt >= e2.occurredAt && fb1.capturedAt <= a1.occurredAt);
    assert.equal(store.getSetRecord(set2.id)!.targetWeightKg, 75); // ← 下一组 target 快照
    assert.equal(store.getSetRecord(iset2.id)!.targetWeightKg, 40); // touch 兜底后的快照

    // 2) 跨表 seq timeline:唯一、连续、可排序;校验器零 issue
    const steps = replayTimeline(t.db, sessionId);
    const seqSteps = steps.filter(s => s.seq !== null);
    const seqs = seqSteps.map(s => s.seq!);
    assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, k) => k + 1)); // 1..N 连续
    assert.equal(seqs.length, 17); // 14 interactions + 3 adaptations
    assert.deepEqual(validateSessionChain(t.db, sessionId), []);

    // 3) ASR 重试:只落一条 SetFeedback,重试过程在 InteractionEvent
    const s2Feedbacks = t.db.prepare("SELECT COUNT(*) AS n FROM set_feedbacks WHERE set_record_id = ?").get(set2.id) as { n: number };
    assert.equal(s2Feedbacks.n, 1);
    const s2Interactions = t.db.prepare("SELECT COUNT(*) AS n FROM interaction_events WHERE target_set_record_id = ?").get(set2.id) as { n: number };
    assert.equal(s2Interactions.n, 2); // asr_retry + 成功指令

    // 4) summary 元组(规格 §9.2 示例值:manualAction=1, manualEpisode=1, asrRetry=1)
    const s = r.computeSummary(sessionId);
    assert.equal(s.voiceCommandCount, 3);       // feedback.hard + feedback.just_right + substitute
    assert.equal(s.manualActionCount, 1);       // touch.button.feedback_hard
    assert.equal(s.manualInteractionEpisodeCount, 1);
    assert.equal(s.voiceAsrRetryCount, 1);
    assert.equal(s.voiceClarificationCount, 0);
    assert.equal(s.voiceRetryCount, 1);
    assert.equal(s.runtimeInterruptionCount, 0);
    assert.deepEqual(s.runtimeInterruptionsByCategory, { ui: 0, voice: 0, error: 0, safety: 0 });
    assert.equal(s.sessionDurationMs, 800_000);

    // 5) rest 语义:末组 null,其余有值
    assert.equal(store.getSetRecord(iset2.id)!.actualRestAfterSeconds, null);
    assert.equal(store.getSetRecord(set1.id)!.actualRestAfterSeconds, 85);
    assert.equal(store.getSetRecord(set2.id)!.actualRestAfterSeconds, 88);
    assert.equal(store.getSetRecord(set3.id)!.actualRestAfterSeconds, 105); // 跨动作,含替换时间
    assert.equal(store.getSetRecord(iset1.id)!.actualRestAfterSeconds, 86);

    // 6) 替换链:旧实例 substituted + 指向新实例
    assert.equal(oldBench.status, "substituted");
    assert.equal(store.getExerciseInstance(bench.id)!.substitutedByInstanceId, incline.id);
    assert.equal(incline.orderIndex, bench.orderIndex);

    // ===== 实际 timeline 输出(交付物:golden timeline) =====
    console.log("\n════ GOLDEN TIMELINE(production path 回放)════");
    console.log(renderTimeline(steps));
    console.log("──── summary ────");
    console.log(JSON.stringify({ ...s, generatedAt: "<t>" }, null, 2));
    const obs = t.db.prepare("SELECT * FROM observer_records WHERE session_id = ?").get(sessionId) as Record<string, unknown>;
    console.log("──── observer ────");
    console.log(JSON.stringify(obs, null, 2));
  } finally { t.cleanup(); }
});
