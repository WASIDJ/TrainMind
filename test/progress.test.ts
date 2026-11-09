// ③ 进步叙事 / ⑤ 关系进度 / ④ 回归钩子 / ① 次数来源 —— 用户价值回归测试
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { exerciseProgress, progressSummary, relationship, nudgeFor, weeklyVolume } from "../src/progress.ts";
import { completeRest, completeWarmup, createWorkout, markSetComplete, RuleLanguageModelProvider, startWorkout, submitSetFeedback } from "../src/core.ts";

const set = (exerciseId: string, actualReps: number, at: string, extra: Record<string, unknown> = {}) => ({ exerciseId, actualReps, completedAt: at, actualRepsSource: "counted" as const, ...extra });

// ── ① 次数来源:没有真实输入就标 assumed,永不冒充测量 ─────────────
test("provenance: reps are labelled assumed unless the session actually counted them", async () => {
  const s = (await createWorkout("我在家，想练30分钟，想练全身。", "provenance-user", new RuleLanguageModelProvider())).workout!;
  startWorkout(s); completeWarmup(s);

  markSetComplete(s);
  const assumed = submitSetFeedback(s, { feedback: "right" });
  assert.equal(assumed.record.actualRepsSource, "assumed", "没数到就是 assumed");
  completeRest(s);

  markSetComplete(s);
  const counted = submitSetFeedback(s, { feedback: "right", actualReps: 6, actualRepsSource: "counted" });
  assert.equal(counted.record.actualRepsSource, "counted");
  assert.equal(counted.record.actualReps, 6, "系统数到的次数原样落库");
  completeRest(s);

  markSetComplete(s);
  const reported = submitSetFeedback(s, { feedback: "right", actualReps: 7 });
  assert.equal(reported.record.actualRepsSource, "reported", "有真实输入但未声明来源 → 视为学员口报");
});

// ── ③ 进步叙事 ───────────────────────────────────────────────
test("progress: assumed sets never count toward a strength claim", () => {
  const rows = exerciseProgress([
    set("squat", 8, "2026-10-01T10:00:00Z"),
    set("squat", 12, "2026-10-08T10:00:00Z", { actualRepsSource: "assumed" }),
  ], { squat: "徒手深蹲" });
  assert.equal(rows.length, 0, "只有 1 组实测,不足以比较");
});

test("progress: measured sets produce an honest 8→12 style headline", () => {
  const rows = exerciseProgress([
    set("squat", 8, "2026-10-01T10:00:00Z"),
    set("squat", 12, "2026-10-08T10:00:00Z"),
    set("pushup", 5, "2026-10-01T10:10:00Z"),
    set("pushup", 6, "2026-10-08T10:10:00Z"),
  ], { squat: "徒手深蹲", pushup: "俯卧撑" });
  assert.equal(rows.length, 2);
  const squat = rows.find(r => r.exerciseId === "squat")!;
  assert.equal(squat.firstReps, 8); assert.equal(squat.bestReps, 12); assert.equal(squat.deltaReps, 4);
  assert.equal(squat.trend, "up"); assert.equal(squat.headline, "徒手深蹲 从 8 次做到 12 次");
  assert.equal(rows[0]!.exerciseId, "squat", "按进步幅度排序");
});

test("progress: pain sets are excluded from strength claims", () => {
  const rows = exerciseProgress([
    set("squat", 8, "2026-10-01T10:00:00Z"),
    set("squat", 20, "2026-10-08T10:00:00Z", { pain: true }),
  ]);
  assert.equal(rows.length, 0);
});

test("progress summary is honest when there is nothing to compare", () => {
  assert.match(progressSummary([]), /还不足以比较/);
  assert.match(progressSummary([{ exerciseId: "x", name: "x", measuredSets: 3, firstReps: 8, bestReps: 8, lastReps: 8, deltaReps: 0, firstAt: "", lastAt: "", trend: "flat", headline: "x 稳定在 8 次" } as any]), /稳定/);
});

// ── 训练规律性(不依赖用户报数) ─────────────────────────────────
test("weeklyVolume: counts real sessions and sets, no user reporting needed", () => {
  const now = Date.parse("2026-10-15T12:00:00Z"); // 周四;本周一 = 2026-10-12
  const v = weeklyVolume(
    ["2026-10-13T10:00:00Z", "2026-10-14T10:00:00Z", "2026-10-06T10:00:00Z"],
    ["2026-10-13T10:00:00Z", "2026-10-13T10:05:00Z", "2026-10-14T10:00:00Z", "2026-10-06T10:00:00Z", "2026-10-07T10:00:00Z"],
    now,
  );
  assert.equal(v.thisWeek.sessions, 2);
  assert.equal(v.thisWeek.sets, 3);
  assert.equal(v.lastWeek.sets, 2);
  assert.equal(v.deltaSets, 1);
  assert.equal(v.text, "本周 2 次 / 3 组，比上周多 1 组");
});

test("weeklyVolume: honest when there is nothing to compare", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  assert.match(weeklyVolume([], [], now).text, /还没开始练/);
  assert.match(weeklyVolume(["2026-10-13T10:00:00Z"], ["2026-10-13T10:00:00Z"], now).text, /上周没有可比数据/);
});

// ── ⑤ 关系进度(跨月,不再只看 7 天) ─────────────────────────────
test("relationship: counts sessions, span, streak weeks and days since last", () => {
  // B10(2026-11-09):日/周边界按本地时区 —— 夹具也用「本地日历」构造,不依赖运行机器的时区。
  const at = (m: number, d: number, h = 10) => new Date(2026, m - 1, d, h).toISOString();
  const rel = relationship([at(10, 5), at(10, 6), at(10, 12), at(10, 19)], new Date(2026, 9, 20, 18).getTime());
  assert.equal(rel.stage, "warming_up"); // 4 次
  assert.ok(rel.streakWeeks >= 3, "连续三周");
  assert.equal(rel.daysSinceLast, 1);
  assert.match(rel.text, /一起练了 4 次/);
  assert.match(rel.text, /连续/);
});

test("relationship: stage ladder follows real session counts", () => {
  const one = relationship(["2026-10-05T10:00:00Z"], Date.parse("2026-10-05T12:00:00Z"));
  assert.equal(one.stage, "first_meet"); assert.equal(one.daysSinceLast, 0);
  const many = relationship(Array.from({ length: 12 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}T10:00:00Z`), Date.parse("2026-09-20T12:00:00Z"));
  assert.equal(many.stage, "long_term");
});

// ── ④ 回归钩子 ───────────────────────────────────────────────
test("nudge: silent when training is current, speaks when it lapses", () => {
  const base = { totalSessions: 5, daysTogether: 30, streakWeeks: 3, stage: "warming_up" as const, label: "磨合中", text: "" };
  assert.equal(nudgeFor({ ...base, daysSinceLast: 0 }).shouldNudge, false);
  assert.equal(nudgeFor({ ...base, daysSinceLast: 1 }).shouldNudge, false);
  assert.equal(nudgeFor({ ...base, daysSinceLast: 2 }).code, "back_soon");
  assert.equal(nudgeFor({ ...base, daysSinceLast: 4 }).code, "missing");
  assert.match(nudgeFor({ ...base, daysSinceLast: 4 }).text, /隔了 4 天/);
  assert.equal(nudgeFor({ ...base, daysSinceLast: 9 }).code, "lapsed");
  assert.match(nudgeFor({ ...base, daysSinceLast: 20 }).text, /5 分钟/);
  assert.equal(nudgeFor({ ...base, daysSinceLast: null }).shouldNudge, false);
});

// ── 接口端到端:感知不碰剂量、进步只认实测 ───────────────────────
let __portSeq = 0;

test("server: /api/progress reports only measured reps and drives the home nudge", async () => {
  const dbPath = `${process.cwd()}${process.platform === "win32" ? "\\" : "/"}test${process.platform === "win32" ? "\\" : "/"}progress-${process.pid}.db`;
  const port = 36000 + (process.pid % 900) + (++__portSeq * 7);
  await rm(dbPath, { force: true });
  const child = spawn(process.execPath, ["src/server.ts"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), TRAINMIND_DB: dbPath }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(Error("server timeout")), 20000); child.stdout.on("data", b => { if (String(b).includes("TrainMind running")) { clearTimeout(timeout); resolve(); } }); child.once("exit", code => reject(Error(`server exited ${code}`))); });
    const origin = `http://localhost:${port}`;
    const get = async (path: string) => (await fetch(origin + path)).json() as Promise<any>;
    const post = async (path: string, payload: unknown) => { const r = await fetch(origin + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
    const bind = async (id: string, payload: any) => { const { workout: w } = await get(`/api/workouts/${id}`); return { ...payload, context: { sessionId: w.sessionId, exerciseId: w.exercises[w.runtime.currentExerciseIndex]?.exerciseId ?? null, setNumber: w.runtime.currentSetNumber, coachPhase: w.runtime.coach?.phase ?? null, status: w.status, eventCount: w.runtime.events.length } }; };

    const userId = "progress-e2e";
    let w = (await post("/api/workouts/preview", { input: "我在家，有30分钟，想练全身。", userId, dataOrigin: "automated_test" })).body.workout;
    const id = w.sessionId, exerciseId = w.exercises[0].exerciseId;
    w = (await post(`/api/workouts/${id}/actions`, await bind(id, { type: "start" }))).body.workout;
    assert.equal(w.status, "exercise_active");

    // 每个动作第一组数 6 次、第二组数 12 次 → 任何有 ≥2 组的动作都应形成 6→12 的真实进步
    const seen: Array<{ exerciseId: string; reps: number }> = [];
    for (let i = 0; i < 10; i++) {
      while (w.status === "resting") w = (await post(`/api/workouts/${id}/actions`, await bind(id, { type: "rest_complete" }))).body.workout;
      if (w.status !== "exercise_active") break;
      const exIdx = w.runtime.currentExerciseIndex, done = w.exercises[exIdx].completedSets;
      const reps = done === 0 ? 6 : 12;
      w = (await post(`/api/workouts/${id}/actions`, await bind(id, { type: "complete_set" }))).body.workout;
      const fb = await post(`/api/workouts/${id}/actions`, await bind(id, { type: "feedback", feedback: "right", actualReps: reps, actualRepsSource: "counted" }));
      assert.equal(fb.body.setRecord.actualRepsSource, "counted");
      assert.equal(fb.body.setRecord.actualReps, reps, "系统数到的次数原样落库");
      seen.push({ exerciseId: fb.body.setRecord.exerciseId, reps });
      w = fb.body.workout;
    }

    const target = seen.find(s => seen.filter(t => t.exerciseId === s.exerciseId).length >= 2);
    assert.ok(target, "至少有一个动作完成两组");
    const progress = await get(`/api/progress?userId=${userId}`);
    const row = progress.exercises.find((x: any) => x.exerciseId === target.exerciseId);
    assert.ok(row, "实测两组后应出现进步记录");
    assert.equal(row.firstReps, 6); assert.equal(row.bestReps, 12);
    assert.match(row.headline, /从 6 次做到 12 次/);
    assert.match(progress.summary, /变强/);
    assert.equal(progress.relationship.totalSessions, 1);
    assert.equal(progress.nudge.shouldNudge, false, "今天刚练,不该催");

    // 未测次数的组:标 assumed,且不得抬高最佳成绩
    while (w.status === "resting") w = (await post(`/api/workouts/${id}/actions`, await bind(id, { type: "rest_complete" }))).body.workout;
    if (w.status === "exercise_active") {
      const before = (await get(`/api/progress?userId=${userId}`)).exercises.find((x: any) => x.exerciseId === target.exerciseId);
      w = (await post(`/api/workouts/${id}/actions`, await bind(id, { type: "complete_set" }))).body.workout;
      const blind = await post(`/api/workouts/${id}/actions`, await bind(id, { type: "feedback", feedback: "right" }));
      assert.equal(blind.body.setRecord.actualRepsSource, "assumed", "没数到必须标 assumed");
      const after = (await get(`/api/progress?userId=${userId}`)).exercises.find((x: any) => x.exerciseId === target.exerciseId);
      assert.equal(after.bestReps, before.bestReps, "assumed 组不得改写进步结论");
    }
  } finally { child.kill(); await new Promise(resolve => child.once("exit", resolve)); await rm(dbPath, { force: true }); }
});

// ── B7(2026-11-09):退步不许被说成"稳定" ─────────────────────────
// 旧实现 deltaReps = bestReps - first.actualReps 恒 ≥ 0,"down" 是死代码,
// 12 → 6 → 4 会被说成"稳定在 4 次",等于用话术盖住退步。
test("progress B7: 退步报回落,不再冒充稳定", () => {
  const rows = exerciseProgress([
    set("squat", 12, "2026-10-01T10:00:00Z"),
    set("squat", 6, "2026-10-08T10:00:00Z"),
    set("squat", 4, "2026-10-15T10:00:00Z"),
  ], { squat: "徒手深蹲" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.trend, "down", "最近比首测低就是 down");
  assert.equal(rows[0]!.deltaReps, -8);
  assert.ok(rows[0]!.headline.includes("回落"), rows[0]!.headline);
  assert.ok(!rows[0]!.headline.includes("稳定"), rows[0]!.headline);
  assert.ok(progressSummary(rows).includes("低一些"), progressSummary(rows));
  // 上升/持平仍然各自正确
  const up = exerciseProgress([set("squat", 8, "2026-10-01T10:00:00Z"), set("squat", 12, "2026-10-08T10:00:00Z")], { squat: "徒手深蹲" });
  assert.equal(up[0]!.trend, "up");
  assert.ok(up[0]!.headline.includes("做到 12 次"), up[0]!.headline);
  const flat = exerciseProgress([set("squat", 10, "2026-10-01T10:00:00Z"), set("squat", 10, "2026-10-08T10:00:00Z")], { squat: "徒手深蹲" });
  assert.equal(flat[0]!.trend, "flat");
  assert.ok(flat[0]!.headline.includes("稳定"), flat[0]!.headline);
});

// ── B8(2026-11-09):停练后不许再宣称"连续 N 周" ─────────────────
test("relationship B8: streak 必须是现在还连着,不是历史上最长的一段", () => {
  // B10:同样用本地日历构造,避免机器时区影响
  const at = (m: number, d: number) => new Date(2026, m - 1, d, 10).toISOString();
  const continuous = [at(10, 5), at(10, 12), at(10, 19), at(10, 26), at(11, 2)];
  const stale = relationship(continuous, new Date(2026, 11, 28, 10).getTime()); // 停 8 周
  assert.equal(stale.streakWeeks, 0, "两个月没练不能算连着");
  assert.ok(!stale.text.includes("连续"), stale.text);
  assert.equal(nudgeFor(stale).text.includes("连续"), false, "催练话术不许引用过期 streak");
  // 最近一周练过 → 仍然连着(两周)
  const alive = relationship([at(11, 2), at(11, 9)], new Date(2026, 10, 11, 10).getTime());
  assert.equal(alive.streakWeeks, 2);
  assert.ok(alive.text.includes("连续 2 周"), alive.text);
});
