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
  // 2026-11-10：周容量目标已冻结（只算不用），所以**不能**再声称应用了它。
  // 这条断言方向被翻转过一次：原来断言"包含"，现在断言"不包含"——因为规则本身改了，不是改断言迁就代码。
  assert.ok(!hypertrophy.ruleIds.includes("acsm-hypertrophy-weekly-volume-2026"), "冻结的规则不该出现在已应用的规则列表里");
  assert.ok(hypertrophy.weeklySetsRemainingByPattern && Object.keys(hypertrophy.weeklySetsRemainingByPattern).length, "字段仍要算出来（只是不应用）");
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

// 2026-11-09：RepDB 条目在原始数据里没有 contraindicationTags（80 条全缺），
// 空数组 = 永远不会因为膝/腰/肩限制被排除。按动作模式保守推导补上，自研动作保持原样。
test("RepDB 动作补齐禁忌标签，自研动作不受影响", () => {
  const repdbSquat = exercises.find(x => x.id === "box-squat");
  assert.ok(repdbSquat, "RepDB 的箱式深蹲应该在动作池里");
  assert.deepEqual(repdbSquat!.contraindicationTags, ["knee_pain"], "深蹲类必须带 knee_pain");

  const repdbHinge = exercises.find(x => x.id === "bodyweight-good-morning");
  assert.ok(repdbHinge, "RepDB 的徒手早安式应该在池里");
  assert.deepEqual(repdbHinge!.contraindicationTags, ["low_back_pain"], "髋铰链类必须带 low_back_pain");

  const authored = exercises.find(x => x.id === "bodyweight-squat")!;
  assert.deepEqual(authored.contraindicationTags, ["knee_pain"], "自研动作维持手写标签");
  assert.equal(authored.attributionRequired, false, "自研动作不带 RepDB 署名标记");
});

// 2026-11-10：用户自报酸痛必须真的影响排课。
// 旧行为：只在 safetyNotes 拼一句"会控制相关部位强度"，照样排深蹲（说一套做一套）。
test("酸痛真的影响排课：腿酸时不排腿/臀/小腿，且对照组不受影响", async () => {
  const control = await createWorkout("我在家，有30分钟，徒手，想练全身。", "sore-control", new RuleLanguageModelProvider());
  const sore = await createWorkout("我在家，有30分钟，徒手，想练全身，今天腿有点酸。", "sore-filter", new RuleLanguageModelProvider());
  const soreNames = sore.workout!.exercises.map(x => x.name);
  assert.ok(soreNames.length >= 3, `过滤后仍要能排出计划，实际 ${soreNames.length} 个`);
  assert.ok(!soreNames.some(n => /深蹲|髋铰链|提踵|箭步|臀桥/.test(n)), `腿酸却排了腿部动作：${soreNames.join("/")}`);
  assert.match(sore.workout!.safetyNotes?.[0] ?? "", /腿部酸痛/);
  // 对照组（不说酸痛）保持原样：仍是 6 个动作，含深蹲
  const controlNames = control.workout!.exercises.map(x => x.name);
  assert.ok(controlNames.some(n => /深蹲/.test(n)), "不酸的用户不该被误伤");
});

// 2026-11-10 冻结：周容量目标（hypertrophy 的"每模式 10 组/周"）只计算、不参与排课。
// 为什么冻结：出处（ACSM 2026 Overview of Reviews）按"肌群/全身周容量"表述，代码按【动作模式】扣减，
// 单位对不上（腿部三模式各 10 组 = 腿一周 30 组）；而真正管排课的是肌群级两条硬规则
// （24 小时内不重复、每周 2–3 次）。两套单位同时生效，用户问"为什么今天不让我练腿"就答不清。
// 这条护栏的作用：谁把该字段接进排课（core.ts 读它），测试立刻红，而不是等半年后发现剂量被一条错配口径改过。
test("周容量目标保持冻结：只计算、不参与排课", async () => {
  const coreSource = await readFile(new URL("../src/core.ts", import.meta.url), "utf8");
  assert.ok(!coreSource.includes("weeklySetsRemainingByPattern"), "core.ts 不该读 weeklySetsRemainingByPattern —— 它是冻结字段");
  assert.ok(!coreSource.includes("acsm-hypertrophy-weekly-volume-2026"), "core.ts 不该应用周容量规则");

  // 字段本身仍然算（保留事实，只是不用），且规则声明也保留（改声明会牵动既有断言，属独立的一项清理）
  const result = await createWorkout("我在Test Gym，有45分钟，中级，想增肌。", "knowledge-frozen-weekly", new RuleLanguageModelProvider());
  const stimulus = result.workout!.requiredStimulus!;
  assert.ok(stimulus.weeklySetsRemainingByPattern, "字段仍要算出来");
  assert.ok(Object.values(stimulus.weeklySetsRemainingByPattern).every(v => v >= 0), "剩余量不该出现负数");

  // 行为级护栏（比源码扫描更硬）：肌肥大处方的 ruleIds 里不许出现这条冻结规则
  const workout = await createWorkout("我在Test Gym，有45分钟，中级，想增肌。", "knowledge-frozen-ruleid", new RuleLanguageModelProvider());
  assert.ok(!workout.workout!.prescription.ruleIds.includes("acsm-hypertrophy-weekly-volume-2026"), "处方不能声称应用了冻结的周容量规则");
});

// 2026-11-11 审查：upper_body 缺 vertical_pull 时会回退到 horizontal_pull，
// 同一个动作被两个 pattern 各选一次 —— "30分钟，我在家，有哑铃，想练上肢"
// 会出现"单臂哑铃划船"两次。既有那条"avoid duplicate exercises"只覆盖了
// beginner 的全身输入，抓不到这个分支。
test("排课不出现重复动作：upper_body 的 vertical_pull 回退路径", async () => {
  const inputs = [
    "30分钟，我在家，有哑铃，想练上肢",
    "30分钟，我在家，有哑铃，想练上肢，今天肩很酸",
    "45分钟，我在家，有哑铃，想练全身",
    "30分钟，我在Test Gym，中级，想增肌",
    "20分钟，我在办公室，徒手自重，想练全身",
  ];
  for (const input of inputs) {
    const result = await createWorkout(input, "dup-guard", new RuleLanguageModelProvider());
    const ids = result.workout!.exercises.map(x => x.exerciseId);
    assert.equal(new Set(ids).size, ids.length, `${input} 排出了重复动作：${ids.join(", ")}`);
  }
});
