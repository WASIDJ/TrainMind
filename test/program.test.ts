// 多周课程(Program → Week → Session)+ 计划/执行分离 + 周对周进步
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { buildProgram, chapterFor, programStatus, recordCompletion, weekOverWeek } from "../src/program.ts";

// ── 课程结构 ────────────────────────────────────────────────
test("program: weeks × sessions structure and chapters", () => {
  const p = buildProgram({ programId: "p1", userId: "u1", goal: "全身力量", weeks: 4, sessionsPerWeek: 3, now: new Date("2026-10-01T00:00:00Z") });
  assert.equal(p.weeks.length, 4);
  assert.equal(p.sessions.length, 12, "4 周 × 3 场");
  assert.equal(new Set(p.sessions.map(s => s.id)).size, 12, "场次 id 唯一");
  assert.deepEqual(p.weeks.map(w => w.title), ["起步", "建立", "加深", "巩固"]);
  assert.deepEqual(p.sessions.filter(s => s.weekNumber === 1).map(s => s.sessionNumber), [1, 2, 3]);
  assert.equal(p.status, "active");
  assert.equal(p.completions.length, 0);
});

test("program: chapter scales with any length, not hardcoded weeks", () => {
  assert.equal(chapterFor(1, 1), "起步");
  assert.equal(chapterFor(1, 8), "起步");
  assert.equal(chapterFor(3, 8), "建立");
  assert.equal(chapterFor(5, 8), "加深");
  assert.equal(chapterFor(8, 8), "巩固");
});

test("program: status is driven by completed sessions only", () => {
  const p = buildProgram({ programId: "p2", userId: "u1", goal: "全身力量", weeks: 2, sessionsPerWeek: 2 });
  const s0 = programStatus(p);
  assert.equal(s0.completedSessions, 0);
  assert.equal(s0.weekNumber, 1);
  assert.equal(s0.nextSession!.id, p.sessions[0]!.id);
  assert.equal(s0.percent, 0);
  assert.match(s0.text, /第 1 周 · 起步/);
  assert.equal(s0.completedSessions, 0);
  assert.equal(s0.totalSessions, 4);

  // 计划里有 4 场,但只完成了 2 场 → 进度就是 2/4,不提前进入下一周
  const two = recordCompletion(recordCompletion(p, { programSessionId: p.sessions[0]!.id, workoutSessionId: "w1", completedAt: "2026-10-01T10:00:00Z" }), { programSessionId: p.sessions[1]!.id, workoutSessionId: "w2", completedAt: "2026-10-02T10:00:00Z" });
  const s1 = programStatus(two);
  assert.equal(s1.completedSessions, 2);
  assert.equal(s1.percent, 50);
  assert.equal(s1.nextSession!.id, p.sessions[2]!.id);
});

test("program: same session cannot be completed twice; finishing all marks completed", () => {
  const p = buildProgram({ programId: "p3", userId: "u1", goal: "全身力量", weeks: 1, sessionsPerWeek: 2 });
  const once = recordCompletion(p, { programSessionId: p.sessions[0]!.id, workoutSessionId: "w1", completedAt: "2026-10-01T10:00:00Z" });
  const twice = recordCompletion(once, { programSessionId: p.sessions[0]!.id, workoutSessionId: "w9", completedAt: "2026-10-01T11:00:00Z" });
  assert.equal(twice.completions.length, 1, "同一场重复完成只认第一次");
  const all = recordCompletion(twice, { programSessionId: p.sessions[1]!.id, workoutSessionId: "w2", completedAt: "2026-10-02T10:00:00Z" });
  assert.equal(all.status, "completed");
  assert.equal(programStatus(all).nextSession, null);
});

// ── 周对周进步 ──────────────────────────────────────────────
const NOW = Date.parse("2026-10-15T12:00:00Z"); // 周四;本周一 = 2026-10-12
const w = (exerciseId: string, actualReps: number, at: string, extra: Record<string, unknown> = {}) => ({ exerciseId, actualReps, completedAt: at, actualRepsSource: "counted" as const, ...extra });

test("weekOverWeek: compares this week against last week per exercise", () => {
  const rows = weekOverWeek([
    w("squat", 8, "2026-10-08T10:00:00Z"),   // 上周
    w("squat", 12, "2026-10-14T10:00:00Z"),  // 本周
    w("pushup", 10, "2026-10-09T10:00:00Z"),
    w("pushup", 9, "2026-10-13T10:00:00Z"),
  ], { squat: "徒手深蹲", pushup: "俯卧撑" }, NOW);
  const squat = rows.find(r => r.exerciseId === "squat")!;
  assert.equal(squat.thisWeek, 12); assert.equal(squat.lastWeek, 8); assert.equal(squat.delta, 4);
  assert.equal(squat.text, "徒手深蹲 本周 12 次,比上周多 4 次");
  assert.equal(rows[0]!.exerciseId, "squat", "进步大的排前面");
  const pushup = rows.find(r => r.exerciseId === "pushup")!;
  assert.equal(pushup.delta, -1);
  assert.match(pushup.text, /比上周少 1 次/);
});

test("weekOverWeek: needs both weeks measured; assumed and pain never count", () => {
  assert.equal(weekOverWeek([w("squat", 12, "2026-10-14T10:00:00Z")], {}, NOW).length, 0, "只有本周不算对比");
  assert.equal(weekOverWeek([
    w("squat", 8, "2026-10-08T10:00:00Z"),
    w("squat", 30, "2026-10-14T10:00:00Z", { actualRepsSource: "assumed" }),
  ], {}, NOW).length, 0, "assumed 不进对比");
  assert.equal(weekOverWeek([
    w("squat", 8, "2026-10-08T10:00:00Z"),
    w("squat", 30, "2026-10-14T10:00:00Z", { pain: true }),
  ], {}, NOW).length, 0, "疼痛组不进对比");
});

// ── 端到端:建课 → 开一场 → 练完 → 进度与计划/执行分离 ─────────────
let __portSeq = 0;

test("server: program session links plan to execution and only counts completed sessions", async () => {
  const dbPath = `${process.cwd()}${process.platform === "win32" ? "\\" : "/"}test${process.platform === "win32" ? "\\" : "/"}program-${process.pid}.db`;
  const port = 38000 + (process.pid % 900) + (++__portSeq * 7);
  await rm(dbPath, { force: true });
  const child = spawn(process.execPath, ["src/server.ts"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), TRAINMIND_DB: dbPath }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(Error("server timeout")), 20000); child.stdout.on("data", b => { if (String(b).includes("TrainMind running")) { clearTimeout(timeout); resolve(); } }); child.once("exit", code => reject(Error(`server exited ${code}`))); });
    const origin = `http://localhost:${port}`;
    const get = async (path: string) => (await fetch(origin + path)).json() as Promise<any>;
    const post = async (path: string, payload: unknown) => { const r = await fetch(origin + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
    const bind = async (id: string, payload: any) => { const { workout: w } = await get(`/api/workouts/${id}`); return { ...payload, context: { sessionId: w.sessionId, exerciseId: w.exercises[w.runtime.currentExerciseIndex]?.exerciseId ?? null, setNumber: w.runtime.currentSetNumber, coachPhase: w.runtime.coach?.phase ?? null, status: w.status, eventCount: w.runtime.events.length } }; };

    const userId = "program-e2e";
    // 建课:2 周 × 1 场
    const created = await post("/api/programs", { userId, goal: "全身力量", weeks: 2, sessionsPerWeek: 1, environment: "home", targetMinutes: 20 });
    assert.equal(created.status, 201);
    const program = created.body.program;
    assert.equal(program.sessions.length, 2);
    assert.equal(created.body.status.completedSessions, 0);

    // 开课程第一场
    const started = await post(`/api/programs/${program.programId}/start`, { userId });
    assert.equal(started.status, 201);
    let w0 = started.body.workout;
    assert.ok(w0.program, "训练必须带课程归属");
    assert.equal(w0.program.programSessionId, program.sessions[0].id);
    assert.equal(w0.program.weekNumber, 1);

    // 同一场再点一次是幂等的(不重复生成,也不把人卡死)
    const again = await post(`/api/programs/${program.programId}/start`, { userId });
    assert.equal(again.status, 200);
    assert.equal(again.body.workout.sessionId, w0.sessionId);

    // 练完这场(每组都"系统数到"目标次数)
    w0 = (await post(`/api/workouts/${w0.sessionId}/actions`, await bind(w0.sessionId, { type: "start" }))).body.workout;
    for (let i = 0; i < 60 && w0.status !== "completed"; i++) {
      if (w0.status === "warming_up") { w0 = (await post(`/api/workouts/${w0.sessionId}/actions`, await bind(w0.sessionId, { type: "warmup_complete" }))).body.workout; continue; }
      if (w0.status === "cooling_down") { w0 = (await post(`/api/workouts/${w0.sessionId}/actions`, await bind(w0.sessionId, { type: "cooldown_complete" }))).body.workout; continue; }
      if (w0.status === "resting") { w0 = (await post(`/api/workouts/${w0.sessionId}/actions`, await bind(w0.sessionId, { type: "rest_complete" }))).body.workout; continue; }
      if (w0.status === "exercise_active") { w0 = (await post(`/api/workouts/${w0.sessionId}/actions`, await bind(w0.sessionId, { type: "complete_set" }))).body.workout; continue; }
      if (w0.status === "set_feedback") {
        const ex = w0.exercises[w0.runtime.currentExerciseIndex];
        const reps = Number(String(ex?.targetReps ?? "").match(/\d+/)?.[0] ?? 8);
        w0 = (await post(`/api/workouts/${w0.sessionId}/actions`, await bind(w0.sessionId, { type: "feedback", feedback: "right", actualReps: reps, actualRepsSource: "counted" }))).body.workout;
        continue;
      }
      break;
    }
    assert.equal(w0.status, "completed");

    // 课程进度:只认完成的场次;绑定里保留计划快照与实测组数
    const active = await get(`/api/programs/active?userId=${userId}`);
    assert.equal(active.status.completedSessions, 1);
    assert.equal(active.status.nextSession.id, program.sessions[1].id);
    // 2026-11-11：status.text 只留"第几周·阶段名"，数字交给 completedSessions/totalSessions
    assert.match(active.status.text, /^第 \d+ 周 · /);
    assert.doesNotMatch(active.status.text, /已完成/);
    assert.equal(active.status.completedSessions, 1);
    assert.equal(active.status.totalSessions, 2);
    const completion = active.program.completions[0];
    assert.ok(completion.planned.length > 0, "计划快照留存(计划)");
    assert.ok(completion.measuredSets > 0, "实测组数单独记录(执行)");
    assert.equal(completion.workoutSessionId, w0.sessionId, "计划↔执行显式连接");

    // 训练记录本身也带着课程归属
    const stored = await get(`/api/workouts/${w0.sessionId}`);
    assert.equal(stored.workout.program.programId, program.programId);
  } finally { child.kill(); await new Promise(resolve => child.once("exit", resolve)); await rm(dbPath, { force: true }); }
});
