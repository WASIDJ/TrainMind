import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildUserTrainingModel, createWorkout, exercises, generateWorkout, recommendExercise, RuleLanguageModelProvider, safetyGate, type SessionContext, type SetRecord, type WorkoutSession } from "../src/core.ts";
import { validateKnowledgeRegistry } from "../src/training-knowledge/schema.ts";
import { trainingKnowledge } from "../src/training-knowledge/loader.ts";
import { resolveRequiredStimulus } from "../src/training-knowledge/resolver.ts";

function makeContext(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    userId: "knowledge-test", rawInput: "", availableDurationMinutes: 30, durationMinutes: 30, durationIntent: "target",
    environment: "home", fatigue: "low", recoveryState: "normal", experienceLevel: "unknown", soreness: [], restrictions: [],
    environmentContext: { type: "home" }, goalContext: { type: "general", priority: null }, recovery: { overall: "normal", soreness: [] },
    constraints: { avoidExercises: [], avoidMovements: [], noJumping: false, noiseSensitive: false },
    preferences: { requestedExercises: [], excludedExercises: [] }, painSignals: [], previousTraining: { status: "unknown", areas: [] },
    missingCriticalFields: [], fieldEvidence: {}, ...overrides
  };
}
function history(exerciseId: string, values: Array<{ reps: number; rir: number; feedback: SetRecord["feedback"] }>) {
  const completedAt = new Date(Date.now() - 86400000).toISOString();
  const session = { sessionId: "knowledge-history", userId: "knowledge-test", status: "completed", runtime: { events: [] }, createdAt: completedAt, exercises: [] } as unknown as WorkoutSession;
  // B1(2026-11-09):进阶只认实测次数 —— 这组历史本就模拟"用户报出的次数",按语义标 counted。
  // (无标记的行按 D20-B 一律视为 assumed,不再构成进阶证据。)
  const sets: SetRecord[] = values.map((x, index) => ({ id: `set-${index}`, sessionId: session.sessionId, workoutExerciseId: "we-1", exerciseId, setNumber: index + 1, targetReps: "8-12", actualReps: x.reps, rir: x.rir, feedback: x.feedback, pain: x.feedback === "pain", completedAt, actualRepsSource: "counted" as const }));
  const facts = { sessions: [session], sets };
  return { facts, model: buildUserTrainingModel("knowledge-test", facts, "normal") };
}

test("knowledge registry validates schema and evidence provenance", async () => {
  const raw = JSON.parse(await readFile(new URL("../knowledge/training-principles.json", import.meta.url), "utf8"));
  assert.doesNotThrow(() => validateKnowledgeRegistry(raw));
  const invalid = structuredClone(raw); invalid.sources.find((x: any) => x.id === "acsm-rt-2026").status = "unverified";
  assert.throws(() => validateKnowledgeRegistry(invalid), /verified source/);
  assert.ok(trainingKnowledge.rules.every(rule => trainingKnowledge.sources.some(source => source.id === rule.sourceId)));
});

test("RepDB refresh replaces stale records with mapped metadata", async () => {
  const records = JSON.parse(await readFile(new URL("../knowledge/exercises.repdb.json", import.meta.url), "utf8"));
  const squat = records.find((x: any) => x.id === "box-squat");
  assert.equal(squat.bodyRegion, "upper_legs"); assert.equal(squat.compoundOrIsolation, "compound");
  assert.equal(squat.position, null); assert.equal(squat.impactLevel, null);
});

test("goal and experience resolve to distinct, provenance-linked stimuli", () => {
  const input = { rawInput: "", interpretedGoal: "general", durationMinutes: 30, durationIntent: "target" as const, recoveryState: "normal" as const, previousTraining: { status: "unknown" as const, areas: [] }, movementPatternLoads: {} };
  const beginner = resolveRequiredStimulus({ ...input, rawInput: "初学者" });
  const intermediate = resolveRequiredStimulus({ ...input, rawInput: "中级" });
  const strength = resolveRequiredStimulus({ ...input, rawInput: "力量训练" });
  const hypertrophy = resolveRequiredStimulus({ ...input, rawInput: "增肌" });
  const endurance = resolveRequiredStimulus({ ...input, rawInput: "肌耐力" });
  assert.equal(beginner.setsPerExercise, 1); assert.equal(intermediate.setsPerExercise, 2);
  assert.equal(strength.goal, "strength"); assert.notEqual(strength.repRange, hypertrophy.repRange);
  assert.notEqual(endurance.restSeconds, strength.restSeconds);
  assert.ok(hypertrophy.ruleIds.includes("acsm-hypertrophy-weekly-volume-2026"));
});

test("reported lower-body training yesterday and fatigue alter required stimulus", () => {
  const base = { rawInput: "", interpretedGoal: "general", durationMinutes: 20, durationIntent: "target" as const, recoveryState: "normal" as const, previousTraining: { status: "unknown" as const, areas: [] }, movementPatternLoads: {} };
  const rested = resolveRequiredStimulus(base);
  const tired = resolveRequiredStimulus({ ...base, rawInput: "今天累，昨天练腿", recoveryState: "fatigued", previousTraining: { status: "reported", when: "yesterday", areas: ["legs"] } });
  assert.ok(!tired.primaryPatterns.some(x => ["squat", "hinge", "lunge", "hip_extension", "calf"].includes(x)));
  assert.ok(tired.setsPerExercise < rested.setsPerExercise);
  assert.ok(tired.decisionReasons.some(x => x.type === "history") && tired.decisionReasons.some(x => x.type === "recovery"));
});

test("explicit no-equipment context restricts candidate exercises", async () => {
  const result = await createWorkout("我在家，有20分钟，初学者，今天精神正常，想练全身，没有器械。", "knowledge-home-none", new RuleLanguageModelProvider());
  assert.equal(result.workout?.requiredStimulus?.experienceLevel, "beginner");
  assert.ok(result.workout!.exercises.every(x => x.equipmentId === "bodyweight"));
  assert.ok(result.workout!.prescription.decisionReasons?.some(x => x.type === "equipment"));
});

test("30-minute home full-body request with good energy resolves a complete target course", async () => {
  const result = await createWorkout("我在家，有30分钟，今天精神不错，想练全身。", "knowledge-target-full-body", new RuleLanguageModelProvider());
  assert.equal(result.context?.recoveryState, "fresh"); assert.equal(result.workout?.durationIntent, "target");
  assert.ok(result.workout!.plannedDurationMinutes >= 27 && result.workout!.plannedDurationMinutes <= 30);
  assert.ok(result.workout!.exercises.length >= 3); assert.ok(new Set(result.workout!.exercises.map(x => x.exerciseId)).size >= 3);
});

test("intermediate hypertrophy session uses history and does not repeat lower-body stimulus", async () => {
  const result = await createWorkout("我在Test Gym，有45分钟，中级，想增肌，昨天练了腿。", "knowledge-hypertrophy", new RuleLanguageModelProvider());
  assert.equal(result.workout?.requiredStimulus?.goal, "hypertrophy");
  assert.ok(!result.workout!.prescription.movementPatterns.some(x => ["squat", "hinge", "lunge", "hip_extension", "calf"].includes(x)));
  assert.ok(result.workout!.requiredStimulus?.weeklySetsRemainingByPattern);
});

test("knee pain reaches Safety Gate before exercise selection", async () => {
  const input = "我在家有15分钟，膝盖有点疼，只有徒手，想练全身。";
  const result = await createWorkout(input, "knowledge-knee-pain", new RuleLanguageModelProvider());
  assert.equal(result.safety.allowed, false); assert.equal(result.workout, null);
});

test("two easy split-squat sets produce a knowledge-linked progression", () => {
  const { facts, model } = history("split-squat", [{ reps: 10, rir: 4, feedback: "too_light" }, { reps: 10, rir: 4, feedback: "too_light" }]);
  const exercise = exercises.find(x => x.id === "split-squat")!;
  const result = recommendExercise(exercise, model, facts, makeContext({ environment: "home", availableEquipmentIds: ["bodyweight"], recoveryState: "normal" }));
  assert.equal(result.action, "progress"); assert.equal(result.progressionStep, "repetitions"); assert.equal(result.repRange, "11-12");
  assert.ok(result.reasonCodes.includes("repeated_easy_completed_sets"));
});

test("hard and failed split-squat work regresses dose without progression", () => {
  const { facts, model } = history("split-squat", [{ reps: 6, rir: 0, feedback: "hard" }, { reps: 5, rir: 0, feedback: "failed" }]);
  const result = recommendExercise(exercises.find(x => x.id === "split-squat")!, model, facts, makeContext({ environment: "home", recoveryState: "normal" }));
  assert.equal(result.action, "regress"); assert.equal(result.sets, 1); assert.equal(result.progressionStep, undefined);
});

test("explicit maximum duration remains a hard upper bound", async () => {
  const result = await createWorkout("我在Test Gym，最多只有10分钟，想练全身。", "knowledge-hard-cap", new RuleLanguageModelProvider());
  assert.equal(result.context?.durationIntent, "maximum");
  assert.ok(result.workout!.estimatedDurationMinutes <= 10);
  assert.ok(result.workout!.prescription.maxWorkingSets >= result.workout!.prescription.workingSets);
});

test("stimulus resolution is deterministic and prescriptions avoid duplicate exercises", () => {
  const args = { rawInput: "初学者全身训练", interpretedGoal: "general", durationMinutes: 30, durationIntent: "target" as const, recoveryState: "normal" as const, previousTraining: { status: "unknown" as const, areas: [] }, movementPatternLoads: {} };
  assert.deepEqual(resolveRequiredStimulus(args), resolveRequiredStimulus(args));
  const workout = generateWorkout(makeContext({ rawInput: args.rawInput, experienceLevel: "beginner" }));
  assert.equal(new Set(workout.exercises.map(x => x.exerciseId)).size, workout.exercises.length);
  assert.ok(workout.prescription.decisionReasons?.some(x => x.type === "knowledge"));
  assert.ok(workout.prescription.ruleIds.every(id => trainingKnowledge.rules.some(x => x.id === id) || ["session_movement_coverage_v0", "target_rir_v0", "set_range_v0", "progression_requires_history_v0", "duration_recipe_v0"].includes(id)));
});
