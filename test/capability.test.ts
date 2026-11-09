import test from "node:test";
import assert from "node:assert/strict";
import { buildCapabilityEstimates, compatibleMovementEvidence, stalenessFor } from "../src/user-training-model/capability.ts";
import { buildUserTrainingModel, exercises as exerciseCatalog, generateWorkout, recommendExercise, type SessionContext, type TrainingFacts, type WorkoutSession } from "../src/core.ts";

const now = "2026-09-28T12:00:00.000Z";
const userContext = { userId: "capability-user", rawInput: "", availableDurationMinutes: 30, durationMinutes: 30, durationIntent: "target" as const, environment: "gym" as const, gymId: "test-gym", fatigue: "low" as const, recoveryState: "normal" as const, experienceLevel: "intermediate" as const, soreness: [], restrictions: [], environmentContext: { type: "gym" as const, gymId: "test-gym" }, goalContext: { type: "general" as const, priority: null }, recovery: { overall: "normal" as const, soreness: [] }, constraints: { avoidExercises: [], avoidMovements: [], noJumping: false, noiseSensitive: false }, preferences: { requestedExercises: [], excludedExercises: [] }, painSignals: [], previousTraining: { status: "unknown" as const, areas: [] }, missingCriticalFields: [], fieldEvidence: {} } as SessionContext;
const defs = [
  { id: "split-squat", movementPattern: "lunge", difficulty: "beginner", unilateral: true, equipmentIds: ["bodyweight"] },
  { id: "bulgarian-split-squat", movementPattern: "lunge", difficulty: "intermediate", unilateral: true, equipmentIds: ["bench"] },
  { id: "pistol-squat", movementPattern: "squat", difficulty: "advanced", unilateral: true, equipmentIds: ["bodyweight"] },
  { id: "barbell-squat", movementPattern: "squat", difficulty: "intermediate", unilateral: false, equipmentIds: ["barbell"] }
];
function facts(results: Array<{ id?: string; days?: number; feedback?: string; reps?: number; status?: string; sets?: number; progressionStep?: string }>) {
  const sessions: any[] = [], sets: any[] = [];
  results.forEach((result, index) => {
    const id = result.id ?? "split-squat", sessionId = `s${index + 1}`, date = new Date(Date.parse(now) - (result.days ?? index) * 86_400_000).toISOString(), count = result.sets ?? 2;
    sessions.push({ sessionId, status: result.status ?? "completed", createdAt: date, completedAt: date, exercises: [{ exerciseId: id, sets: count, targetReps: "8-12", executionStatus: result.status === "aborted" ? "skipped" : "completed", recommendation: { action: "maintain", progressionStep: result.progressionStep } }], runtime: { events: result.status === "aborted" ? [{ type: "workout_aborted", at: date }] : [] } });
    for (let n = 1; n <= count; n++) sets.push({ sessionId, exerciseId: id, setNumber: n, actualReps: result.reps ?? 10, targetReps: "8-12", rir: result.feedback === "too_light" ? 4 : 2, feedback: result.feedback ?? "right", pain: result.feedback === "pain", completedAt: date });
  });
  return { sessions, sets };
}

test("capability model validates empty and bodyweight history without inventing load", () => {
  const empty = buildCapabilityEstimates({ exercises: defs, sessions: [], sets: [], now });
  assert.equal(empty.exercise["split-squat"].confidence, "low");
  const data = facts([{ feedback: "too_light", days: 1 }]);
  const model = buildCapabilityEstimates({ exercises: defs, ...data, now });
  assert.equal(model.exercise["split-squat"].validSetCount, 2); assert.equal(model.exercise["split-squat"].observedLoadKg, undefined);
  assert.equal(model.exercise["split-squat"].latestDifficulty, "easy"); assert.ok(model.volumeToleranceByPattern.lunge.cleanSetsLast7Days > 0);
});

test("repeated recent clean sessions raise confidence while stale evidence decays", () => {
  const data = facts([{ feedback: "too_light", days: 4 }, { feedback: "too_light", days: 10 }, { feedback: "too_light", days: 16 }, { feedback: "too_light", days: 22 }]);
  const model = buildCapabilityEstimates({ exercises: defs, ...data, now });
  assert.equal(model.exercise["split-squat"].confidence, "high");
  const old = buildCapabilityEstimates({ exercises: defs, ...facts([{ feedback: "too_light", days: 100 }]), now });
  assert.equal(old.exercise["split-squat"].staleness, "very_stale"); assert.equal(old.exercise["split-squat"].confidence, "low");
  assert.equal(stalenessFor(89), "stale"); assert.equal(stalenessFor(90), "very_stale"); assert.equal(stalenessFor(91), "very_stale");
});

test("pain, hard, failure and interruptions remain distinct outcomes", () => {
  const model = buildCapabilityEstimates({ exercises: defs, ...facts([{ feedback: "pain" }, { feedback: "hard" }, { feedback: "failed", reps: 5 }, { status: "aborted", feedback: "right" }]), now });
  const outcomes = model.exercise["split-squat"].recentOutcomes.map(x => x.difficulty);
  assert.deepEqual(outcomes, ["pain", "hard", "failed", "moderate"]);
  assert.equal(model.exercise["split-squat"].recentPain, true); assert.equal(model.exercise["split-squat"].interruptedSessionCount, 1);
  assert.equal(model.interruptionCounts.workout_aborted, 1);
});

test("pattern fallback respects difficulty and unilateral compatibility", () => {
  const model = buildCapabilityEstimates({ exercises: defs, ...facts([{ feedback: "too_light", days: 1 }]), now });
  const familiar = compatibleMovementEvidence(defs[1], defs, model.movement);
  assert.equal(familiar.compatible, true); assert.deepEqual(familiar.sourceExerciseIds, ["split-squat"]);
  const pistolFromBilateral = compatibleMovementEvidence(defs[2], defs, model.movement);
  assert.equal(pistolFromBilateral.compatible, false);
});

test("recovery tendency uses recorded fatigue survey values only", () => {
  const data = facts([{ feedback: "right", days: 1 }]);
  const model = buildCapabilityEstimates({ exercises: defs, ...data, trainingRecords: [{ sessionId: "s1", completedAt: "2026-09-27T12:00:00Z", perceivedFatigue: 5 }], now });
  assert.equal(model.recoveryTendency.meanReportedFatigue, 5); assert.equal(model.recoveryTendency.recentHighFatigue, true);
  assert.equal(buildCapabilityEstimates({ exercises: defs, sessions: [], sets: [], now }).recoveryTendency.meanReportedFatigue, undefined);
});

test("equipment replacement interruption does not contaminate original exercise capability", () => {
  const baseline = prescriptionFacts("split-squat", [{ days: 2, feedback: "too_light", reps: 10, targetReps: "8-12", sets: 2 }]);
  const prior = buildUserTrainingModel(userContext.userId, baseline, "normal", now);
  const replacement = generateWorkout(userContext); replacement.sessionId = "replacement-only"; replacement.status = "completed"; replacement.runtime.completedAt = now;
  replacement.runtime.events.push({ id: "replace-event", type: "exercise_replaced", at: now, exerciseId: "split-squat", details: { reason: "equipment_busy" } });
  replacement.exercises = [{ ...replacement.exercises[0], exerciseId: "split-squat", executionStatus: "replaced", skippedReason: "equipment_busy" }];
  const after = buildUserTrainingModel(userContext.userId, { ...baseline, sessions: [...baseline.sessions, replacement] }, "normal", now);
  assert.equal(after.exerciseCapabilities["split-squat"].estimate?.validSetCount, prior.exerciseCapabilities["split-squat"].estimate?.validSetCount);
  assert.equal(after.exerciseCapabilities["split-squat"].estimate?.easySessionCount, prior.exerciseCapabilities["split-squat"].estimate?.easySessionCount);
  assert.equal(after.interruptionCounts["exercise_replaced:equipment_busy"], 1);
});

function prescriptionFacts(exerciseId: string, results: Array<{ days: number; feedback: string; reps?: number; targetReps?: string; sets?: number; load?: number; rir?: number; status?: string; step?: string }>): TrainingFacts {
  const sessions: WorkoutSession[] = [], sets: any[] = [];
  results.forEach((result, index) => {
    const sessionId = `cap-${exerciseId}-${index}`, completedAt = new Date(Date.parse(now) - result.days * 86_400_000).toISOString(), definition = exerciseCatalog.find(x => x.id === exerciseId)!;
    const base = generateWorkout(userContext); base.sessionId = sessionId; base.status = (result.status ?? "completed") as WorkoutSession["status"]; base.runtime.completedAt = completedAt;
    base.exercises = [{ ...base.exercises[0], exerciseId, name: definition.name, sets: result.sets ?? 2, targetReps: result.targetReps ?? definition.defaultReps, executionStatus: result.status === "aborted" ? "skipped" : result.feedback === "pain" ? "pain" : "completed", recommendation: { ...base.exercises[0].recommendation, progressionStep: result.step as any } }];
    sessions.push(base);
    for (let n = 1; n <= (result.sets ?? 2); n++) sets.push({ id: `${sessionId}-${n}`, sessionId, workoutExerciseId: base.exercises[0].id, exerciseId, setNumber: n, targetWeight: result.load, actualWeight: result.load, targetReps: result.targetReps ?? definition.defaultReps, actualReps: result.reps ?? Number(definition.defaultReps.match(/(\d+)(?!.*\d)/)?.[0] ?? 10), rir: result.rir ?? (result.feedback === "too_light" ? 4 : 2), feedback: result.feedback, pain: result.feedback === "pain", completedAt, actualRepsSource: "counted" as const });
  });
  return { sessions, sets };
}
function recommend(id: string, facts: TrainingFacts, context = userContext) {
  const definition = exerciseCatalog.find(x => x.id === id)!;
  return { model: buildUserTrainingModel(context.userId, facts, context.recoveryState, now), result: recommendExercise(definition, buildUserTrainingModel(context.userId, facts, context.recoveryState, now), facts, context) };
}

test("exercise history informs reps first and records an auditable adjustment", () => {
  const facts = prescriptionFacts("split-squat", [{ days: 2, feedback: "too_light", reps: 10, targetReps: "8-12", sets: 2 }]);
  const { result } = recommend("split-squat", facts, { ...userContext, environment: "home", availableEquipmentIds: ["bodyweight"] });
  assert.equal(result.action, "progress"); assert.equal(result.progressionStep, "repetitions"); assert.equal(result.repRange, "11-12");
  assert.equal(result.capabilityAdjustment?.adjustment, "increase_reps"); assert.equal(result.capabilityAdjustment?.modelSource, "exercise");
  assert.ok(result.capabilityAdjustment?.evidence.includes("explicit_or_rir_easy"));
});

test("moderate completion maintains; one hard completed session holds with hysteresis", () => {
  const moderate = recommend("split-squat", prescriptionFacts("split-squat", [{ days: 1, feedback: "right", reps: 10, sets: 2 }])).result;
  const hard = recommend("split-squat", prescriptionFacts("split-squat", [{ days: 1, feedback: "hard", reps: 10, sets: 2, rir: 1 }])).result;
  assert.equal(moderate.action, "maintain"); assert.equal(hard.action, "maintain"); assert.equal(hard.capabilityAdjustment?.adjustment, "maintain_after_hard_completed");
});

test("failed reps regress dose, while pain avoids the exercise through Safety priority", () => {
  const failed = recommend("split-squat", prescriptionFacts("split-squat", [{ days: 1, feedback: "failed", reps: 5, sets: 2 }])).result;
  const pain = recommend("split-squat", prescriptionFacts("split-squat", [{ days: 1, feedback: "pain", reps: 10, sets: 2 }])).result;
  assert.equal(failed.action, "regress"); assert.equal(failed.sets, 1); assert.equal(failed.progressionStep, undefined);
  assert.equal(pain.action, "avoid"); assert.ok(pain.reasonCodes.includes("progression_blocked"));
});

test("new exercise uses compatible movement evidence only for low-dose calibration", () => {
  const facts = prescriptionFacts("split-squat", [{ days: 4, feedback: "right" }, { days: 10, feedback: "right" }]);
  const { result } = recommend("bulgarian-split-squat", facts, { ...userContext, availableEquipmentIds: ["bodyweight", "bench"] });
  assert.equal(result.action, "calibrate"); assert.equal(result.capabilityAdjustment?.modelSource, "movement_pattern");
  assert.equal(result.capabilityAdjustment?.to.loadKg, undefined); assert.ok(result.sets <= 1);
});

test("90-day inactivity drops old load and returns to calibration", () => {
  const facts = prescriptionFacts("lat-pulldown-ex", [{ days: 100, feedback: "too_light", reps: 10, load: 55, sets: 3 }]);
  const { model, result } = recommend("lat-pulldown-ex", facts);
  assert.equal(model.exerciseCapabilities["lat-pulldown-ex"].estimate?.staleness, "very_stale");
  assert.equal(result.action, "calibrate"); assert.equal(result.weightKg, 30); assert.equal(result.confidence, "low");
});

test("mixed easy-hard-easy history does not oscillate back into progression", () => {
  const facts = prescriptionFacts("split-squat", [
    { days: 1, feedback: "too_light", reps: 10, targetReps: "8-12", sets: 2 },
    { days: 3, feedback: "hard", reps: 10, targetReps: "8-12", sets: 2, rir: 1 },
    { days: 5, feedback: "too_light", reps: 10, targetReps: "8-12", sets: 2 }
  ]);
  const { result } = recommend("split-squat", facts, { ...userContext, environment: "home", availableEquipmentIds: ["bodyweight"] });
  assert.notEqual(result.action, "progress"); assert.ok(result.reasonCodes.includes("hysteresis_hold"));
});

test("ten-minute dose cap still wins when a capability estimate is high", () => {
  const facts = prescriptionFacts("lat-pulldown-ex", [0, 3, 6, 9].map(days => ({ days, feedback: "too_light", reps: 10, targetReps: "8-10", sets: 3, load: 35 })));
  const workout = generateWorkout({ ...userContext, availableDurationMinutes: 10, durationMinutes: 10, durationIntent: "maximum" }, facts);
  assert.ok(workout.estimatedDurationMinutes <= 10); assert.ok(workout.exercises.reduce((n, x) => n + x.sets, 0) <= workout.prescription.maxWorkingSets);
});

test("same user's five completed sessions produce progressive but bounded next doses", () => {
  const facts: TrainingFacts = { sessions: [], sets: [] }, exerciseId = "reverse-lunge", exerciseDefinition = exerciseCatalog.find(x => x.id === exerciseId)!;
  const timeline: Array<{ session: number; priorConfidence: string; prescribedSets: number; prescribedReps: string; action: string; actualFeedback: string }> = [];
  for (let index = 0; index < 5; index++) {
    const model = buildUserTrainingModel(userContext.userId, facts, "normal", now), recommendation = recommendExercise(exerciseDefinition, model, facts, { ...userContext, environment: "home", recoveryState: "normal" });
    const sessionId = `five-${index + 1}`, completedAt = new Date(Date.parse(now) - (5 - index) * 86_400_000).toISOString(), count = recommendation.sets;
    const session = generateWorkout({ ...userContext, environment: "home" }); session.sessionId = sessionId; session.status = "completed"; session.runtime.completedAt = completedAt;
    session.exercises = [{ ...session.exercises[0], exerciseId, name: exerciseDefinition.name, sets: count, targetReps: recommendation.repRange, executionStatus: "completed", recommendation }]; facts.sessions.push(session);
    for (let set = 1; set <= count; set++) facts.sets.push({ id: `${sessionId}-${set}`, sessionId, workoutExerciseId: session.exercises[0].id, exerciseId, setNumber: set, targetReps: recommendation.repRange, actualReps: Math.max(Number(recommendation.repRange.match(/\d+/)?.[0] ?? 8), 8), rir: 4, feedback: "too_light", pain: false, completedAt, actualRepsSource: "counted" as const } as any);
    timeline.push({ session: index + 1, priorConfidence: model.exerciseCapabilities[exerciseId].confidence, prescribedSets: count, prescribedReps: recommendation.repRange, action: recommendation.capabilityAdjustment?.adjustment ?? recommendation.action, actualFeedback: "easy/completed" });
  }
  const sixth = recommendExercise(exerciseDefinition, buildUserTrainingModel(userContext.userId, facts, "normal", now), facts, { ...userContext, environment: "home", recoveryState: "normal" });
  assert.equal(timeline.length, 5); assert.ok(timeline.some(x => x.prescribedReps !== exerciseDefinition.defaultReps || x.prescribedSets > exerciseDefinition.minSets));
  assert.notEqual(sixth.capabilityAdjustment?.modelSource, "experience_default"); assert.ok(sixth.capabilityAdjustment?.evidence.length); assert.ok(sixth.sets <= exerciseDefinition.maxSets);
});

// ── M3 诚实记账:easy→+load 只认实测证据(与 D20 同精神) ──────────────
// 场景:三场"只点完成(complete_set 自动结组,次数按目标推定=assumed)+ 组后补一句'轻松'"。
// one-arm-db-row 目标 "10/侧" 的推定次数恰好等于上限,旧代码会把它当"达到上限"的证据去加重。
// 上面的 fixture 标记 counted = 模拟"系统数到/学员口报"的实测历史;assumed 场景只出现在这里。
function m3Facts(source: "counted" | "assumed"): TrainingFacts {
  const sessions: WorkoutSession[] = [], sets: any[] = [];
  for (const [index, days] of [2, 9, 16].entries()) {
    const sessionId = `m3-${source}-${index}`, completedAt = new Date(Date.parse(now) - days * 86_400_000).toISOString();
    const base = generateWorkout(userContext); base.sessionId = sessionId; base.status = "completed"; base.runtime.completedAt = completedAt;
    base.exercises = [{ ...base.exercises[0], exerciseId: "one-arm-db-row", name: "单臂哑铃划船", sets: 3, targetReps: "10/侧", executionStatus: "completed", recommendation: { ...base.exercises[0].recommendation, progressionStep: undefined } }];
    sessions.push(base);
    for (let n = 1; n <= 3; n++) sets.push({ id: `${sessionId}-${n}`, sessionId, workoutExerciseId: base.exercises[0].id, exerciseId: "one-arm-db-row", setNumber: n, targetWeight: 12.5, actualWeight: 12.5, targetReps: "10/侧", actualReps: 10, rir: undefined, feedback: "too_light", pain: false, completedAt, actualRepsSource: source });
  }
  return { sessions, sets };
}

test("M3: 三场'只点完成+补一句轻松'不得触发加重(assumed 不是上限证据)", () => {
  const { result } = recommend("one-arm-db-row", m3Facts("assumed"), { ...userContext, environment: "home", availableEquipmentIds: ["bodyweight", "dumbbell"] });
  assert.equal(result.action, "maintain", "推定的'完成上限'不是测量值,不许加重量");
  assert.equal(result.progressionStep, undefined);
  assert.ok(result.reasonCodes.includes("assumed_reps_excluded"), "审计码写明排除原因");
  assert.equal(result.capabilityAdjustment?.from.loadKg, result.capabilityAdjustment?.to.loadKg, "负荷保持不变");
});

test("M3 对照: 实测(counted)达到上限的重复轻松仍会 +load 一档", () => {
  const { result } = recommend("one-arm-db-row", m3Facts("counted"), { ...userContext, environment: "home", availableEquipmentIds: ["bodyweight", "dumbbell"] });
  assert.equal(result.action, "progress");
  assert.equal(result.progressionStep, "load");
  assert.equal(result.weightKg, 15, "12.5 → 15(哑铃下一可用档)");
  assert.ok(result.reasonCodes.includes("measured_reps_only"));
});

// ── B1/B3(2026-11-09):三态与单位 ─────────────────────────────────
test("B1: assumed 次数不得抬下次的次数目标(M3 只堵了 +load 路径)", () => {
  const assumed = prescriptionFacts("split-squat", [{ days: 2, feedback: "too_light", reps: 8, targetReps: "8-10", sets: 2 }]);
  assumed.sets = assumed.sets.map(s => ({ ...s, actualRepsSource: "assumed" as const }));
  const ctx = { ...userContext, environment: "home" as const, availableEquipmentIds: ["bodyweight"] };
  const held = recommend("split-squat", assumed, ctx).result;
  assert.equal(held.repRange, "8-10", "推定 8 次不是进阶依据");
  assert.equal(held.progressionStep, undefined, "不许靠 assumed 抬次数");
  assert.ok(held.reasonCodes.includes("assumed_reps_excluded"), held.reasonCodes.join(","));
  // 对照:同样 8 次但来源是 counted → 仍然 +1 次(实测路径不许被误伤)
  const counted = prescriptionFacts("split-squat", [{ days: 2, feedback: "too_light", reps: 8, targetReps: "8-10", sets: 2 }]);
  assert.equal(recommend("split-squat", counted, ctx).result.repRange, "9-10");
});

test("B3: 时长型动作不拿'秒'比'次'", () => {
  const ctx = { ...userContext, environment: "home" as const };
  const ok = recommend("march-in-place", prescriptionFacts("march-in-place", [{ days: 1, feedback: "right", reps: 0, targetReps: "300秒", sets: 1 }]), ctx);
  assert.equal(ok.model.exerciseCapabilities["march-in-place"].estimate?.recentOutcomes[0]?.difficulty, "moderate", "0 次不该等价于'没完成 300 秒'");
  assert.ok(!ok.result.repRange.includes("298"), ok.result.repRange);
  const failed = recommend("march-in-place", prescriptionFacts("march-in-place", [{ days: 1, feedback: "failed", reps: 0, targetReps: "300秒", sets: 1 }]), ctx).result;
  assert.equal(failed.action, "regress", "用户自己说做不完仍然要回退");
  assert.ok(!failed.repRange.includes("298"), `不许产出 300-298 秒: ${failed.repRange}`);
  assert.ok(failed.reasonCodes.includes("timed_dose_not_narrowed"));
});
