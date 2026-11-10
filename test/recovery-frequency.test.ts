// 恢复约束主口径：同一肌群每周 2–3 次（2026-11-10）。
//
// 依据：Schoenfeld BJ, Ogborn D, Krieger JW. Effects of Resistance Training Frequency on Measures
// of Muscle Hypertrophy: A Systematic Review and Meta-Analysis. Sports Med. 2016.
// DOI 10.1007/s40279-016-0543-8（docs/EVIDENCE-RECOVERY.md 第 2 条）。
//
// 文件结构（顺序即 TDD 顺序）：
//   一、对照组：记录改动前的排课结果，作为不变量。本轮改代码**不许**动这些数字。
//   二、账本：每周训练次数怎么数（按会话去重，不是组数）。
//   三、排课：超过每周上限才不再加量；小时数不再是主约束。
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkout, RuleLanguageModelProvider, type SetRecord, type WorkoutSession } from "../src/core.ts";
import { buildMuscleLedger, WEEKLY_FREQUENCY_TARGET } from "../src/muscles.ts";

const DAY = 86_400_000;
const FIXTURE_USER = "recovery-frequency-fixture";

/** 造历史：每条 = 某个动作在某天的一次会话（每组按 assumed 记，避免把"进阶"混进来） */
function history(entries: Array<{ exerciseId: string; daysAgo: number; sets?: number; source?: SetRecord["actualRepsSource"] }>, userId = FIXTURE_USER): { sessions: WorkoutSession[]; sets: SetRecord[] } {
  const sessions: WorkoutSession[] = [];
  const sets: SetRecord[] = [];
  const byDay = new Map<number, typeof entries>();
  for (const entry of entries) byDay.set(entry.daysAgo, [...(byDay.get(entry.daysAgo) ?? []), entry]);
  for (const [daysAgo, items] of byDay) {
    const sessionId = `${userId}-d${daysAgo}`;
    const completedAt = new Date(Date.now() - daysAgo * DAY).toISOString();
    sessions.push({ sessionId, userId, status: "completed", runtime: { events: [] }, createdAt: completedAt, exercises: [] } as unknown as WorkoutSession);
    for (const item of items) for (let i = 0; i < (item.sets ?? 1); i++) sets.push({
      id: `${sessionId}-${item.exerciseId}-${i}`, sessionId, workoutExerciseId: "we-fixture", exerciseId: item.exerciseId,
      setNumber: i + 1, targetReps: "8-12", actualReps: 8, feedback: "right", pain: false, completedAt,
      actualRepsSource: item.source ?? "assumed",
    });
  }
  return { sessions, sets };
}

const empty = { sessions: [] as WorkoutSession[], sets: [] as SetRecord[] };
async function plan(input: string, facts = empty) {
  const result = await createWorkout(input, FIXTURE_USER, new RuleLanguageModelProvider(), facts);
  assert.ok(result.workout, `${input} 应该排出计划`);
  return result.workout;
}
const shape = (workout: WorkoutSession) => workout.exercises.map(x => `${x.exerciseId}:${x.sets}`);

// ── 一、对照组：改动前的实测结果（2026-11-10，在工作区干净时记录）─────────────
test("对照组：无历史的典型输入排课结果不变", async () => {
  const cases: Array<[string, string[]]> = [
    ["我在家，有30分钟，徒手，想练全身。", ["bodyweight-squat:1", "push-up:1", "bird-dog:1", "hip-hinge:1", "bodyweight-calf-raise:1", "march-in-place:1"]],
    ["去Test Gym，有45分钟，想练背。", ["lat-pulldown-ex:2", "seated-cable-row:2", "face-pull:2", "dumbbell-face-pull:1", "march-in-place:1", "standing-mobility:1"]],
    ["在办公室，只有20分钟，随便练练。", ["bodyweight-squat:1", "push-up:1", "bird-dog:1"]],
    ["在家，30分钟，想练下肢。", ["bodyweight-squat:1", "bodyweight-good-morning:1", "reverse-lunge:1", "glute-bridge:1", "march-in-place:1"]],
  ];
  for (const [input, expected] of cases) assert.deepEqual(shape(await plan(input)), expected, input);
});

test("对照组：本周 2–3 次的部位照常安排（正好在建议区间）", async () => {
  // 腿本周 2 次：剂量按历史演进（深蹲 3 组），但动作与顺序不变
  const twoTimes = await plan("我在家，有30分钟，徒手，想练全身。", history([
    { exerciseId: "bodyweight-squat", daysAgo: 4, sets: 3, source: "counted" },
    { exerciseId: "bodyweight-squat", daysAgo: 2, sets: 3, source: "counted" },
  ]));
  assert.deepEqual(shape(twoTimes), ["bodyweight-squat:3", "push-up:1", "bird-dog:1", "hip-hinge:1", "bodyweight-calf-raise:1", "march-in-place:1"]);

  // 胸本周 3 次：到达上限，但仍算"在该练的次数里"，不触发收手
  const threeTimes = await plan("我在家，有30分钟，有哑铃，想练胸。", history([
    { exerciseId: "push-up", daysAgo: 5, sets: 3, source: "counted" },
    { exerciseId: "push-up", daysAgo: 3, sets: 3, source: "counted" },
    { exerciseId: "push-up", daysAgo: 1, sets: 3, source: "counted" },
  ]));
  assert.deepEqual(shape(threeTimes), ["push-up:2", "dumbbell-face-pull:1", "dumbbell-curl:1", "dumbbell-tricep-extension:1", "march-in-place:1"]);
});

// ── 二、账本：每周训练次数怎么数 ────────────────────────────────────────
test("频次：按会话去重，同一次会话里练两组只算一天", () => {
  const now = Date.parse("2026-11-10T12:00:00.000Z");
  const at = (hoursAgo: number, sessionId: string) => ({
    exerciseId: "bodyweight-squat", sessionId, actualRepsSource: "counted" as const,
    completedAt: new Date(now - hoursAgo * 3_600_000).toISOString(),
  });
  const legs = buildMuscleLedger({
    now, musclesByExercise: { "bodyweight-squat": ["legs"] },
    sets: [at(10, "s1"), at(9, "s1"), at(60, "s2"), at(120, "s3"), at(200, "s4")],
  }).find(x => x.group === "legs")!;
  assert.equal(legs.sets7d, 4); // 组数：4 组（s1 两组 + s2 + s3）
  assert.equal(legs.sessions7d, 3); // 次数：s1/s2/s3 三次；s4 在 7 天外（200h ≈ 8.3 天）
  assert.equal(legs.frequencyStatus, "in_range");
});

test("频次：状态分档与目标区间（靶区间 = 2–3 次）", () => {
  assert.deepEqual([WEEKLY_FREQUENCY_TARGET.min, WEEKLY_FREQUENCY_TARGET.max], [2, 3]);
  const now = Date.parse("2026-11-10T12:00:00.000Z");
  const run = (sessions: number) => buildMuscleLedger({
    now, musclesByExercise: { "bodyweight-squat": ["legs"] },
    sets: Array.from({ length: sessions }, (_, i) => ({ exerciseId: "bodyweight-squat", sessionId: `s${i}`, completedAt: new Date(now - (i + 1) * DAY).toISOString() })),
  }).find(x => x.group === "legs")!;
  assert.equal(run(0).frequencyStatus, "none");
  assert.equal(run(1).frequencyStatus, "below");
  assert.equal(run(2).frequencyStatus, "in_range");
  assert.equal(run(3).frequencyStatus, "in_range");
  assert.equal(run(4).frequencyStatus, "above");
  // 按小时的辅助提示仍在（没有被删掉，只是不再当主约束）
  assert.ok(run(1).recoveryPercent !== null);
});

// ── 三、排课：主约束是周频次，小时数只是提示 ─────────────────────────────
test("频次：同一肌群本周 4 次后不再加量（其余部位照常）", async () => {
  // 四场腿部训练，覆盖腿/臀/小腿三个部位（同一场里各部位都练到，各算一次）
  const legSession = [{ exerciseId: "bodyweight-squat" }, { exerciseId: "hip-hinge" }, { exerciseId: "glute-bridge" }, { exerciseId: "bodyweight-calf-raise" }];
  const overTrained = await plan("我在家，有30分钟，徒手，想练全身。", history(
    [6, 4, 2, 1].flatMap(daysAgo => legSession.map(set => ({ ...set, daysAgo }))),
  ));
  const names = overTrained.exercises.map(x => `${x.exerciseId} ${x.name}`);
  const legExerciseIds = ["bodyweight-squat", "reverse-lunge", "hip-hinge", "glute-bridge", "bodyweight-calf-raise", "march-in-place"];
  assert.ok(!overTrained.exercises.some(x => legExerciseIds.includes(x.exerciseId)), `腿本周已 4 次却还排了腿部动作：${names.join(" / ")}`);
  assert.ok(overTrained.exercises.length >= 2, `收手后仍要能排出计划，实际 ${overTrained.exercises.length} 个`);
  assert.ok(overTrained.prescription.decisionReasons.some(x => x.ruleId === WEEKLY_FREQUENCY_TARGET.ruleId), "收手要有可解释的理由");
});

test("频次：不到 48 小时但本周只练了 1 次，仍然照安排（小时不再是主约束）", async () => {
  const recent = await plan("我在家，有30分钟，徒手，想练全身。", history([
    { exerciseId: "bodyweight-squat", daysAgo: 0, sets: 2 }, // 约 8 小时内练过腿
  ]));
  assert.ok(recent.exercises.some(x => x.exerciseId === "bodyweight-squat"), "按小时算腿还在恢复期，但本周只练 1 次——应该照常安排");
});

test("频次：候选不够 3 个时不强行收手（宁可少避一点，也不能排不出课）", async () => {
  const onlyLegs = await plan("在家，10分钟，徒手，想练下肢。", history([
    { exerciseId: "bodyweight-squat", daysAgo: 6 }, { exerciseId: "bodyweight-squat", daysAgo: 4 },
    { exerciseId: "bodyweight-squat", daysAgo: 2 }, { exerciseId: "bodyweight-squat", daysAgo: 1 },
  ]));
  assert.ok(onlyLegs.exercises.length >= 1);
});
