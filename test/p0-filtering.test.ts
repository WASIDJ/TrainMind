// P0（2026-11-11 审查）：恢复约束的两条反向缺陷。
//
// 1. 过滤被短路后仍在宣称"已控制强度"——安全提示与排课结果不一致，比不提示更危险。
// 2. 低强度活动（快走/活动度）反向触发力量训练的 24h 硬线与周频次上限——
//    "练了两天快走，今天不让你练腿"，与 2026-11-10 定下的"只拦力量动作"相反。
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkout, RuleLanguageModelProvider, type SetRecord, type WorkoutSession } from "../src/core.ts";
import { buildMuscleLedger, MIN_SAME_MUSCLE_INTERVAL_RULE_ID, WEEKLY_FREQUENCY_TARGET } from "../src/muscles.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const USER = "p0-filter-fixture";

/** 造历史：一个动作一次会话，可以显式指定时间与目标（时长型动作要 600秒 而不是 8-12）。 */
function history(entries: Array<{ exerciseId: string; hoursAgo: number; sets?: number; targetReps?: string }>): { sessions: WorkoutSession[]; sets: SetRecord[] } {
  const sessions: WorkoutSession[] = [];
  const sets: SetRecord[] = [];
  for (const [index, entry] of entries.entries()) {
    const sessionId = `${USER}-h${entry.hoursAgo}-${index}`;
    const completedAt = new Date(Date.now() - entry.hoursAgo * HOUR).toISOString();
    sessions.push({ sessionId, userId: USER, status: "completed", runtime: { events: [] }, createdAt: completedAt, exercises: [] } as unknown as WorkoutSession);
    for (let i = 0; i < (entry.sets ?? 1); i++) sets.push({
      id: `${sessionId}-${i}`, sessionId, workoutExerciseId: "we-fixture", exerciseId: entry.exerciseId,
      setNumber: i + 1, targetReps: entry.targetReps ?? "8-12", actualReps: 8, feedback: "right", pain: false,
      completedAt, actualRepsSource: "assumed",
    });
  }
  return { sessions, sets };
}
const empty = { sessions: [] as WorkoutSession[], sets: [] as SetRecord[] };
async function plan(input: string, facts = empty) {
  const result = await createWorkout(input, USER, new RuleLanguageModelProvider(), facts);
  assert.ok(result.workout, `${input} 应该排出计划`);
  return result.workout;
}
const names = (workout: WorkoutSession) => workout.exercises.map(x => x.name);
const legStrength = (workout: WorkoutSession) => workout.exercises.filter(x => /深蹲|髋铰链|箭步|臀桥|提踵|早安式/.test(x.name));

// ── 一、过滤被短路时不许继续宣称"已控制强度" ────────────────────────────────
test("酸痛：想练下肢但腿酸到避不开时，提示必须说实话，不能声称已控制强度", async () => {
  const workout = await plan("。30分钟，我在家，徒手自重，想练下肢，腿很酸".replace("。", ""));
  // 用户明确要练下肢、又报腿部酸痛：物理上避不开，所以照排是可以的，
  // 但绝不能一边排深蹲一边说"今天会控制相关部位的强度"。
  assert.ok(legStrength(workout).length > 0, "这个输入本来就避不开下肢动作");
  const notes = (workout.safetyNotes ?? []).join("\n");
  assert.doesNotMatch(notes, /今天会控制相关部位的强度/, `避不开时不许这样写：${notes}`);
  assert.match(notes, /酸痛/, "仍然要提酸痛这件事");
  assert.match(notes, /没有避开|避不开|未能/, `要说清为什么还是排了：${notes}`);
  assert.ok(workout.prescription.ruleIds.includes("soreness-not-applied-v1"), `要留可审计的痕迹：${workout.prescription.ruleIds.join(",")}`);
  assert.ok(
    (workout.prescription.decisionReasons ?? []).some(x => x.ruleId === "soreness-not-applied-v1"),
    "decisionReasons 也要能看到这条",
  );
});

test("酸痛：能避开时（练全身）仍然按部位排除，并如实说已控制", async () => {
  const workout = await plan("我在家，有30分钟，徒手，想练全身，今天腿有点酸。");
  assert.equal(legStrength(workout).length, 0, `腿酸却排了腿部动作：${names(workout).join("/")}`);
  assert.match((workout.safetyNotes ?? []).join("\n"), /今天会控制相关部位的强度/);
  assert.ok(!workout.prescription.ruleIds.includes("soreness-not-applied-v1"));
});

// ── 二、低强度活动不许反向挡住力量训练 ──────────────────────────────────────
test("低强度：两小时前只走了一会儿，不该触发同部位 24 小时硬线", async () => {
  const facts = history([{ exerciseId: "march-in-place", hoursAgo: 2, targetReps: "600秒" }]);
  const workout = await plan("我在家，有30分钟，徒手，想练全身。", facts);
  assert.ok(legStrength(workout).length > 0, `快走不该挡住力量训练：${names(workout).join("/")}`);
  assert.ok(!workout.prescription.ruleIds.includes(MIN_SAME_MUSCLE_INTERVAL_RULE_ID), "不该打上 24h 硬线的 ruleId");
});

test("低强度：本周走了四次，也不算腿部训练次数到上限", async () => {
  const facts = history([
    { exerciseId: "march-in-place", hoursAgo: 30, targetReps: "600秒" },
    { exerciseId: "march-in-place", hoursAgo: 54, targetReps: "600秒" },
    { exerciseId: "march-in-place", hoursAgo: 78, targetReps: "600秒" },
    { exerciseId: "march-in-place", hoursAgo: 102, targetReps: "600秒" },
  ]);
  const workout = await plan("我在家，有30分钟，徒手，想练全身。", facts);
  assert.ok(legStrength(workout).length > 0, `四次快走不该挡住腿部力量：${names(workout).join("/")}`);
  assert.ok(!workout.prescription.ruleIds.includes(WEEKLY_FREQUENCY_TARGET.ruleId));
});

test("低强度：账本本身也不把快走算成'刚练过'或'本周已练'", () => {
  const now = Date.parse("2026-11-11T12:00:00.000Z");
  const at = (hoursAgo: number) => new Date(now - hoursAgo * HOUR).toISOString();
  const ledger = buildMuscleLedger({
    now,
    musclesByExercise: { "march-in-place": ["legs"], "standing-mobility": ["core"] },
    lightExerciseIds: new Set(["march-in-place", "standing-mobility"]),
    sets: [
      { exerciseId: "march-in-place", sessionId: "w1", completedAt: at(2) },
      { exerciseId: "standing-mobility", sessionId: "w2", completedAt: at(3) },
      { exerciseId: "march-in-place", sessionId: "w3", completedAt: at(50) },
    ],
  });
  const legs = ledger.find(x => x.group === "legs")!;
  const core = ledger.find(x => x.group === "core")!;
  assert.equal(legs.intervalStatus, "none", "快走不该产生 24h 硬线");
  assert.equal(legs.frequencyStatus, "none", "快走不该计成一次力量训练");
  assert.equal(legs.sessions7d, 0);
  assert.equal(core.intervalStatus, "none");
  assert.equal(core.frequencyStatus, "none");
  // 但训练量本身仍然照实记（展示层要看得到"今天动过"）
  assert.equal(legs.sets7d, 2, "近 7 天组数仍按真实发生的组记");
});

test("低强度：真的练过力量动作时，24 小时硬线与频次照旧生效", async () => {
  // 一场腿课会同时练到腿/臀/小腿，三个部位各自计时（既有约定：按肌群算，不按"腿/上半身"算）
  const hard = history([
    { exerciseId: "bodyweight-squat", hoursAgo: 8, sets: 3 },
    { exerciseId: "hip-hinge", hoursAgo: 8, sets: 3 },
    { exerciseId: "bodyweight-calf-raise", hoursAgo: 8, sets: 3 },
  ]);
  const blocked = await plan("我在家，有30分钟，徒手，想练全身。", hard);
  assert.equal(legStrength(blocked).length, 0, `8 小时前练过腿，今天不该再排腿部力量：${names(blocked).join("/")}`);
  assert.ok(blocked.prescription.ruleIds.includes(MIN_SAME_MUSCLE_INTERVAL_RULE_ID));
});
