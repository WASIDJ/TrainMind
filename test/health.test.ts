// 2026-11-05 真机暴露的缺陷回归:训练时长封顶 / 废弃预览收档
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { ACTIVE_IDLE_GAP_MS, activeMsFromEvents, applyLateFeedback, completeWarmup, createWorkout, enableCoach, markSetComplete, pauseWorkout, RuleLanguageModelProvider, startWorkout, submitSetFeedback } from "../src/core.ts";
import { classifyStopIntent, probeStopPrompt } from "../src/coach-runtime.ts";

// ── A. 训练时长不能把挂机时间算进去 ─────────────────────────────
test("duration: normal gap accrues, overnight idle does not", async () => {
  const a = (await createWorkout("我在家，想练30分钟，想练全身。", "dur-a", new RuleLanguageModelProvider())).workout!;
  startWorkout(a, "2026-11-01T10:00:00Z");
  pauseWorkout(a, "2026-11-01T10:02:00Z");
  assert.equal(a.runtime.activeWorkoutMs, 120000, "2 分钟正常计入");

  const b = (await createWorkout("我在家，想练30分钟，想练全身。", "dur-b", new RuleLanguageModelProvider())).workout!;
  startWorkout(b, "2026-11-01T10:00:00Z");
  pauseWorkout(b, "2026-11-04T10:00:00Z"); // 放置了 3 天
  assert.equal(b.runtime.activeWorkoutMs, 0, "过夜/挂机不计入训练时长");
});

test("duration: activeMsFromEvents caps every inter-event gap", () => {
  const ms = activeMsFromEvents([
    { at: "2026-11-01T10:00:00Z" },
    { at: "2026-11-01T10:01:00Z" },   // 1 分钟 → 计入
    { at: "2026-11-02T10:01:00Z" },   // 隔一天 → 截断
  ]);
  assert.equal(ms, 60000 + ACTIVE_IDLE_GAP_MS);
});

test("duration: historical repair keeps short gaps and cuts multi-day gaps", () => {
  const events = [
    { at: "2026-10-26T07:30:00Z" },
    { at: "2026-10-26T07:31:30Z" },
    { at: "2026-10-26T07:33:20Z" },
    { at: "2026-10-29T07:33:20Z" }, // 3 天后回来
  ];
  const ms = activeMsFromEvents(events);
  assert.equal(ms, 90000 + 110000 + ACTIVE_IDLE_GAP_MS);
  assert.ok(ms / 60000 < 15, "不再出现 19 天级的荒谬时长");
});

// ── D. "徒手"不该吃掉后面明确说出的器械 ─────────────────────────
test("equipment parsing: 徒手 + 有哑铃 两样都算可用;只说徒手就只用自重", async () => {
  const mixed = await createWorkout("我在家，30 分钟，徒手自重、有哑铃，全身力量。", "eq-mix", new RuleLanguageModelProvider());
  assert.deepEqual([...(mixed.context.availableEquipmentIds ?? [])].sort(), ["bodyweight", "dumbbell"]);
  assert.ok(mixed.workout!.exercises.some(e => e.equipmentId === "dumbbell"), "选了哑铃就该出现哑铃动作");

  const bodyweightOnly = await createWorkout("我在家，30 分钟，徒手自重，全身力量。", "eq-bw", new RuleLanguageModelProvider());
  assert.deepEqual(bodyweightOnly.context.availableEquipmentIds, ["bodyweight"]);
  assert.ok(!bodyweightOnly.workout!.exercises.some(e => e.equipmentId === "dumbbell"), "只说自重就必须全是自重动作");
});

// ── H. 只生成计划不算"练过一次" ────────────────────────────────
test("server: merely generating a plan must not count as a session in relationship", async () => {
  const dbPath = `${process.cwd()}${process.platform === "win32" ? "\\" : "/"}test${process.platform === "win32" ? "\\" : "/"}relation-${process.pid}.db`;
  const port = 40000 + (process.pid % 900) + (++__portSeq * 7);
  await rm(dbPath, { force: true });
  const child = spawn(process.execPath, ["src/server.ts"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), TRAINMIND_DB: dbPath }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(Error("server timeout")), 20000); child.stdout.on("data", b => { if (String(b).includes("TrainMind running")) { clearTimeout(timeout); resolve(); } }); child.once("exit", code => reject(Error(`server exited ${code}`))); });
    const origin = `http://localhost:${port}`;
    const userId = "relation-preview";
    const created = await fetch(`${origin}/api/workouts/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "我在家，有20分钟，想练全身。", userId, dataOrigin: "automated_test" }) });
    assert.equal(created.status, 201);
    const progress = await (await fetch(`${origin}/api/progress?userId=${userId}`)).json() as any;
    assert.equal(progress.relationship.totalSessions, 0, "只生成计划不算练过");
    assert.equal(progress.relationship.daysSinceLast, null, "没有训练就不该说'今天练了'");
    assert.equal(progress.nudge.shouldNudge, false, "没练过不该催");
  } finally { child.kill(); await new Promise(resolve => child.once("exit", resolve)); await rm(dbPath, { force: true }); }
});

// ── J. 组完成必须落一条组记录(否则规律性统计丢数据) ──────────────
test("server: completing a set persists exactly one set record in coach mode", async () => {
  const dbPath = `${process.cwd()}${process.platform === "win32" ? "\\" : "/"}test${process.platform === "win32" ? "\\" : "/"}persist-${process.pid}.db`;
  const port = 41000 + (process.pid % 900) + (++__portSeq * 7);
  await rm(dbPath, { force: true });
  const child = spawn(process.execPath, ["src/server.ts"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), TRAINMIND_DB: dbPath }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(Error("server timeout")), 20000); child.stdout.on("data", b => { if (String(b).includes("TrainMind running")) { clearTimeout(timeout); resolve(); } }); child.once("exit", code => reject(Error(`server exited ${code}`))); });
    const origin = `http://localhost:${port}`;
    const get = async (path: string) => (await fetch(origin + path)).json() as Promise<any>;
    const post = async (path: string, payload: unknown) => { const r = await fetch(origin + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
    const bind = async (id: string, payload: any) => { const { workout: w } = await get(`/api/workouts/${id}`); return { ...payload, context: { sessionId: w.sessionId, exerciseId: w.exercises[w.runtime.currentExerciseIndex]?.exerciseId ?? null, setNumber: w.runtime.currentSetNumber, coachPhase: w.runtime.coach?.phase ?? null, status: w.status, eventCount: w.runtime.events.length } }; };

    const userId = "persist-e2e";
    let w = (await post("/api/workouts/preview", { input: "我在家，有20分钟，想练全身。", userId, dataOrigin: "automated_test" })).body.workout;
    const id = w.sessionId;
    await post(`/api/workouts/${id}/actions`, await bind(id, { type: "start", coach: true }));
    await post(`/api/workouts/${id}/actions`, await bind(id, { type: "coach_event", event: { type: "start_set" } }));
    await post(`/api/workouts/${id}/actions`, await bind(id, { type: "coach_event", event: { type: "guidance_started" } }));
    const done = await post(`/api/workouts/${id}/actions`, await bind(id, { type: "complete_set" }));
    assert.equal(done.body.workout.status, "resting", "完成即进休息");

    const db = new DatabaseSync(dbPath);
    try {
      const rows = db.prepare("SELECT data_json FROM set_records WHERE data_json != '{}'").all() as Array<{ data_json: string }>;
      assert.equal(rows.length, 1, "必须且只能落一条组记录");
      const record = JSON.parse(rows[0]!.data_json);
      assert.equal(record.feedback, "right", "不再询问感受 → 按计划完成");
      assert.equal(record.actualRepsSource, "assumed", "不再报数 → 次数按目标推定");
    } finally { db.close(); }
  } finally { child.kill(); await new Promise(resolve => child.once("exit", resolve)); await rm(dbPath, { force: true }); }
});

// ── K. TTS:供应商 302 → 预签名地址时必须跟一次 GET(不能跟随 POST 跳转) ──
test("server: TTS follows a 302 redirect to a presigned URL and returns audio", async () => {
  const { createServer } = await import("node:http");
  const AUDIO = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]); // 假 ID3 头
  const fileServer = createServer((_req, res) => { res.writeHead(200, { "content-type": "audio/mpeg", "content-length": String(AUDIO.length) }); res.end(AUDIO); });
  await new Promise<void>(r => fileServer.listen(0, "127.0.0.1", () => r()));
  const filePort = (fileServer.address() as { port: number }).port;
  const router = createServer((req, res) => {
    if (req.method !== "POST") { res.writeHead(405); return res.end(); }
    res.writeHead(302, { location: `http://127.0.0.1:${filePort}/audio.mp3` });
    res.end();
  });
  await new Promise<void>(r => router.listen(0, "127.0.0.1", () => r()));
  const routerPort = (router.address() as { port: number }).port;

  const dbPath = `${process.cwd()}${process.platform === "win32" ? "\\" : "/"}test${process.platform === "win32" ? "\\" : "/"}tts-${process.pid}.db`;
  const port = 42000 + (process.pid % 900) + (++__portSeq * 7);
  await rm(dbPath, { force: true });
  const child = spawn(process.execPath, ["src/server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), TRAINMIND_DB: dbPath, TRAINMIND_TTS_URL: `http://127.0.0.1:${routerPort}/audio/speech`, TRAINMIND_TTS_KEY: "test-key", TRAINMIND_TTS_MODEL: "speech-test" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(Error("server timeout")), 20000); child.stdout.on("data", b => { if (String(b).includes("TrainMind running")) { clearTimeout(timeout); resolve(); } }); child.once("exit", code => reject(Error(`server exited ${code}`))); });
    const res = await fetch(`http://localhost:${port}/api/voice/tts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "第 1 组，深蹲。" }) });
    assert.equal(res.status, 200, "302 必须被正确跟随");
    assert.match(res.headers.get("content-type") ?? "", /audio\/mpeg/);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(bytes, AUDIO, "返回的应是跳转目标上的音频");
  } finally {
    child.kill(); await new Promise(resolve => child.once("exit", resolve));
    await rm(dbPath, { force: true });
    await new Promise<void>(r => router.close(() => r()));
    await new Promise<void>(r => fileServer.close(() => r()));
  }
});

// ── C. 废弃预览不再挡住课程开局 ────────────────────────────────
let __portSeq = 0;

test("server: a stale preview does not block starting a program session", async () => {
  const dbPath = `${process.cwd()}${process.platform === "win32" ? "\\" : "/"}test${process.platform === "win32" ? "\\" : "/"}health-${process.pid}.db`;
  const port = 39000 + (process.pid % 900) + (++__portSeq * 7);
  await rm(dbPath, { force: true });
  const child = spawn(process.execPath, ["src/server.ts"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), TRAINMIND_DB: dbPath }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(Error("server timeout")), 20000); child.stdout.on("data", b => { if (String(b).includes("TrainMind running")) { clearTimeout(timeout); resolve(); } }); child.once("exit", code => reject(Error(`server exited ${code}`))); });
    const origin = `http://localhost:${port}`;
    const post = async (path: string, payload: unknown) => { const r = await fetch(origin + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
    const userId = "health-preview";

    // 先造一个"计划生成器"的普通预览(用户看了没开始就退出)
    const preview = await post("/api/workouts/preview", { input: "我在家，有20分钟，想练全身。", userId, dataOrigin: "automated_test" });
    assert.equal(preview.status, 201);

    // 建课并开第一场:普通预览应自动让位(用户已经在选课程了)
    const created = await post("/api/programs", { userId, goal: "全身力量", weeks: 2, sessionsPerWeek: 1, equipment: ["bodyweight"] });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.program.equipment, ["bodyweight"], "器械按用户选择记录");
    assert.match(created.body.program.sessions[0].input, /徒手自重/, "课程模板必须写明器械,不自作主张");

    const started = await post(`/api/programs/${created.body.program.programId}/start`, { userId });
    assert.equal(started.status, 201, "普通计划预览不该阻塞课程开局");
    assert.ok(started.body.workout.program, "训练仍带课程归属");

    // 同一场还没开始时再点一次 → 幂等返回同一场(而不是 409 把人卡死)
    const again = await post(`/api/programs/${created.body.program.programId}/start`, { userId });
    assert.equal(again.status, 200, "同一场重复开局应幂等");
    assert.equal(again.body.workout.sessionId, started.body.workout.sessionId);
    // 而且这份未开始的课程场次要能从"继续训练"里看到
    const active = await (await fetch(`${origin}/api/workouts/active?userId=${userId}`)).json() as any;
    assert.equal(active.workout?.sessionId, started.body.workout.sessionId, "课程场次不能被藏起来");

    // 换一门课程(或放弃旧课程后新建):旧课程的未完成场次不该继续挡路
    const second = await post("/api/programs", { userId, goal: "全身力量", weeks: 2, sessionsPerWeek: 1, equipment: ["bodyweight"] });
    const restarted = await post(`/api/programs/${second.body.program.programId}/start`, { userId });
    assert.equal(restarted.status, 201, "别的课程的残留场次应自动让位");
    assert.equal(restarted.body.workout.program.programId, second.body.program.programId);
  } finally { child.kill(); await new Promise(resolve => child.once("exit", resolve)); await rm(dbPath, { force: true }); }
});

// ── L. 喊停三段式:疲惫先问原因+推一把,第二次才收工;疼痛不追问 ──
test("stop intent: 疼痛 / 疲惫 / 硬停 分得清,且否定词不误判", () => {
  assert.equal(classifyStopIntent("膝盖有点疼"), "pain");
  assert.equal(classifyStopIntent("还行，不疼"), null, "『不疼』不是疼痛");
  assert.equal(classifyStopIntent("有点晕"), "pain");
  assert.equal(classifyStopIntent("不行了，太累"), "exhaustion");
  assert.equal(classifyStopIntent("撑不住了"), "exhaustion");
  assert.equal(classifyStopIntent("停一下"), "exhaustion");
  assert.equal(classifyStopIntent("跳过这组"), "hard_stop");
  assert.equal(classifyStopIntent("今天状态不错"), null);
  const probe = probeStopPrompt();
  assert.match(probe, /是累，还是哪儿不对劲/, "第一次喊停要问原因");
  assert.match(probe, /能顶就再顶一下/, "并且推一把,不是直接答应休息");
});

test("server: first 疲惫喊停只追问,第二次才真的停下", async () => {
  const dbPath = `${process.cwd()}${process.platform === "win32" ? "\\" : "/"}test${process.platform === "win32" ? "\\" : "/"}stop-${process.pid}.db`;
  const port = 43000 + (process.pid % 900) + (++__portSeq * 7);
  await rm(dbPath, { force: true });
  const child = spawn(process.execPath, ["src/server.ts"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), TRAINMIND_DB: dbPath }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(Error("server timeout")), 20000); child.stdout.on("data", b => { if (String(b).includes("TrainMind running")) { clearTimeout(timeout); resolve(); } }); child.once("exit", code => reject(Error(`server exited ${code}`))); });
    const origin = `http://localhost:${port}`;
    const get = async (path: string) => (await fetch(origin + path)).json() as Promise<any>;
    const post = async (path: string, payload: unknown) => { const r = await fetch(origin + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
    const bind = async (id: string, payload: any) => { const { workout: w } = await get(`/api/workouts/${id}`); return { ...payload, context: { sessionId: w.sessionId, exerciseId: w.exercises[w.runtime.currentExerciseIndex]?.exerciseId ?? null, setNumber: w.runtime.currentSetNumber, coachPhase: w.runtime.coach?.phase ?? null, status: w.status, eventCount: w.runtime.events.length } }; };

    const userId = "stop-e2e";
    const w0 = (await post("/api/workouts/preview", { input: "我在家，有20分钟，想练全身。", userId, dataOrigin: "automated_test" })).body.workout;
    const id = w0.sessionId;
    await post(`/api/workouts/${id}/actions`, await bind(id, { type: "start", coach: true }));
    await post(`/api/workouts/${id}/actions`, await bind(id, { type: "coach_event", event: { type: "start_set" } }));
    await post(`/api/workouts/${id}/actions`, await bind(id, { type: "coach_event", event: { type: "guidance_started" } }));

    const first = await post(`/api/workouts/${id}/actions`, await bind(id, { type: "coach_message", message: "不行了" }));
    assert.equal(first.body.workout.status, "exercise_active", "第一次喊停不许直接停");
    assert.match(first.body.directive.text, /是累，还是哪儿不对劲/, "先问原因");
    assert.equal(first.body.workout.runtime.coach.stopProbes, 1);

    const second = await post(`/api/workouts/${id}/actions`, await bind(id, { type: "coach_message", message: "真的很累" }));
    assert.equal(second.body.workout.status, "paused", "第二次喊停才收工");

    // 疼痛不追问,直接走安全通道
    const other = (await post("/api/workouts/preview", { input: "我在家，有20分钟，想练上肢。", userId: "stop-pain", dataOrigin: "automated_test" })).body.workout;
    const oid = other.sessionId;
    await post(`/api/workouts/${oid}/actions`, await bind(oid, { type: "start", coach: true }));
    await post(`/api/workouts/${oid}/actions`, await bind(oid, { type: "coach_event", event: { type: "start_set" } }));
    const pain = await post(`/api/workouts/${oid}/actions`, await bind(oid, { type: "coach_message", message: "肩膀疼" }));
    assert.match(pain.body.directive.text, /先停|安全|放下/, "疼痛立刻停,不追问原因");
  } finally { child.kill(); await new Promise(resolve => child.once("exit", resolve)); await rm(dbPath, { force: true }); }
});

// ── M. D17:组后补充反馈要被听见(不报错、真生效、还带 agency) ──
test("late feedback: 组后补一句『太重了』更正同一组,并在同动作还有组时降重量", async () => {
  const s = (await createWorkout("我在 Test Gym，有40分钟，想练背。", "late-unit", new RuleLanguageModelProvider())).workout!;
  startWorkout(s); completeWarmup(s); enableCoach(s);
  s.exercises[0].sets = 3;                       // 制造"还有后续组"的场景
  markSetComplete(s);
  const first = submitSetFeedback(s, { feedback: "right" }).record;
  const before = s.exercises[s.runtime.currentExerciseIndex]!.currentWeight;
  s.status = "resting";                          // complete_set 之后就是休息态

  const late = applyLateFeedback(s, first, { feedback: "hard", actualReps: 5 });
  assert.equal(late.record.id, first.id, "改的是同一条记录");
  assert.equal(late.record.feedback, "hard");
  assert.equal(late.record.actualReps, 5);
  assert.equal(late.agency, "set", "同动作还有组 → 本组三选一");
  // 是否真的降重量取决于器械档位(5kg 步长时 -10% 可能落不到合法档位,系统不凭空造重量)
  const after = s.exercises[s.runtime.currentExerciseIndex]!.currentWeight;
  assert.ok(after === undefined || after <= (before ?? Infinity), "重量只降不升");
  assert.equal(typeof late.doseChanged, "boolean");
});

test("late feedback: 末组吃力 → 跨动作三选一,但不去改别人的重量", async () => {
  const s = (await createWorkout("我在 Test Gym，有40分钟，想练背。", "late-unit-2", new RuleLanguageModelProvider())).workout!;
  startWorkout(s); completeWarmup(s); enableCoach(s);
  s.exercises[0].sets = 1;
  markSetComplete(s);
  const only = submitSetFeedback(s, { feedback: "right" }).record;
  const nextWeight = s.exercises[s.runtime.currentExerciseIndex]?.currentWeight;
  s.status = "resting";
  const late = applyLateFeedback(s, only, { feedback: "hard" });
  assert.equal(late.agency, "exercise", "末组吃力 → 跨动作三选一(D16-B)");
  assert.equal(s.exercises[s.runtime.currentExerciseIndex]?.currentWeight, nextWeight, "不牵连下一个动作的重量");
});

test("server: 休息中主动说『太重了』会被采纳(不再 directive:none)", async () => {
  const dbPath = `${process.cwd()}${process.platform === "win32" ? "\\" : "/"}test${process.platform === "win32" ? "\\" : "/"}late-${process.pid}.db`;
  const port = 44000 + (process.pid % 900) + (++__portSeq * 7);
  await rm(dbPath, { force: true });
  const child = spawn(process.execPath, ["src/server.ts"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), TRAINMIND_DB: dbPath }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(Error("server timeout")), 20000); child.stdout.on("data", b => { if (String(b).includes("TrainMind running")) { clearTimeout(timeout); resolve(); } }); child.once("exit", code => reject(Error(`server exited ${code}`))); });
    const origin = `http://localhost:${port}`;
    const get = async (p: string) => (await fetch(origin + p)).json() as Promise<any>;
    const post = async (p: string, b: unknown) => { const r = await fetch(origin + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
    const bind = async (id: string, payload: any) => { const { workout: w } = await get(`/api/workouts/${id}`); return { ...payload, context: { sessionId: w.sessionId, exerciseId: w.exercises[w.runtime.currentExerciseIndex]?.exerciseId ?? null, setNumber: w.runtime.currentSetNumber, coachPhase: w.runtime.coach?.phase ?? null, status: w.status, eventCount: w.runtime.events.length } }; };

    const userId = "late-e2e";
    const w0 = (await post("/api/workouts/preview", { input: "我在 Test Gym，有40分钟，想练背。", userId, dataOrigin: "automated_test" })).body.workout;
    const id = w0.sessionId;
    await post(`/api/workouts/${id}/actions`, await bind(id, { type: "start", coach: true }));
    await post(`/api/workouts/${id}/actions`, await bind(id, { type: "coach_event", event: { type: "start_set" } }));
    await post(`/api/workouts/${id}/actions`, await bind(id, { type: "coach_event", event: { type: "guidance_started" } }));
    const done = await post(`/api/workouts/${id}/actions`, await bind(id, { type: "complete_set" }));
    assert.equal(done.body.workout.status, "resting");

    const said = await post(`/api/workouts/${id}/actions`, await bind(id, { type: "coach_message", message: "太重了", source: "voice" }));
    assert.equal(said.status, 200);
    assert.notEqual(said.body.directive.action, "none", "不能被静默忽略");
    assert.ok(said.body.setRecord, "要更正刚那一组");

    const db = new DatabaseSync(dbPath);
    try {
      const rows = db.prepare("SELECT data_json FROM set_records WHERE data_json != '{}'").all() as Array<{ data_json: string }>;
      assert.equal(rows.length, 1, "更正而不是新增");
      assert.equal(JSON.parse(rows[0]!.data_json).feedback, "hard", "落库的反馈被更正");
    } finally { db.close(); }
  } finally { child.kill(); await new Promise(resolve => child.once("exit", resolve)); await rm(dbPath, { force: true }); }
});

// ── A2(2026-11-09):喊停必须落到状态机,不能只换一句安全话术 ──────────
// 旧行为:classifyStopIntent 返回的 pain/hard_stop 两个分支在 /actions 里没人消费,
// 说"我有点头晕"只让叙事说了句"今天到此为止",session.status 与 safetyStopped 一动不动。
test("server: 语音喊停(头晕/不练了)真的停下;换动作意图不误判为收工", async () => {
  const dbPath = `${process.cwd()}${process.platform === "win32" ? "\\" : "/"}test${process.platform === "win32" ? "\\" : "/"}stopintent-${process.pid}.db`;
  const port = 43000 + (process.pid % 900) + (++__portSeq * 7);
  await rm(dbPath, { force: true });
  const child = spawn(process.execPath, ["src/server.ts"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), TRAINMIND_DB: dbPath }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(Error("server timeout")), 20000); child.stdout.on("data", b => { if (String(b).includes("TrainMind running")) { clearTimeout(timeout); resolve(); } }); child.once("exit", code => reject(Error(`server exited ${code}`))); });
    const origin = `http://localhost:${port}`;
    const get = async (path: string) => (await fetch(origin + path)).json() as Promise<any>;
    const post = async (path: string, payload: unknown) => { const r = await fetch(origin + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
    const bind = async (id: string, payload: any) => { const { workout: w } = await get(`/api/workouts/${id}`); return { ...payload, context: { sessionId: w.sessionId, exerciseId: w.exercises[w.runtime.currentExerciseIndex]?.exerciseId ?? null, setNumber: w.runtime.currentSetNumber, coachPhase: w.runtime.coach?.phase ?? null, status: w.status, eventCount: w.runtime.events.length } }; };
    // 造一场"组内"会话:开练 → 开始本组 → 指导已播
    const freshActive = async (userId: string) => {
      const created = await post("/api/workouts/preview", { input: "我在家，有20分钟，想练全身。", userId, dataOrigin: "automated_test" });
      const id = created.body.workout.sessionId;
      await post(`/api/workouts/${id}/actions`, await bind(id, { type: "start", coach: true }));
      await post(`/api/workouts/${id}/actions`, await bind(id, { type: "coach_event", event: { type: "start_set" } }));
      await post(`/api/workouts/${id}/actions`, await bind(id, { type: "coach_event", event: { type: "guidance_started" } }));
      return id;
    };

    const dizzyId = await freshActive("stopintent-dizzy");
    const dizzyBefore = (await get(`/api/workouts/${dizzyId}`)).workout;
    const dizzyWeight = dizzyBefore.exercises[dizzyBefore.runtime.currentExerciseIndex].currentWeight;
    const dizzy = await post(`/api/workouts/${dizzyId}/actions`, await bind(dizzyId, { type: "coach_message", message: "我有点头晕" }));
    assert.equal(dizzy.body.workout.status, "paused", "说头晕必须先停下训练");
    assert.ok(dizzy.body.workout.runtime.coach?.safetyStopped, "必须置 safetyStopped(疼痛后不许直接继续)");
    assert.equal(dizzy.body.workout.exercises[dizzy.body.workout.runtime.currentExerciseIndex].currentWeight, dizzyWeight, "喊停不许改剂量(反向验收)");

    const quitId = await freshActive("stopintent-quit");
    const quit = await post(`/api/workouts/${quitId}/actions`, await bind(quitId, { type: "coach_message", message: "我不练了" }));
    assert.equal(quit.body.workout.status, "paused", "说不练了必须停下");

    // 反向:换动作/器械被占 属于 substitute,不能被 hard_stop 吞掉
    const swapId = await freshActive("stopintent-swap");
    const swap = await post(`/api/workouts/${swapId}/actions`, await bind(swapId, { type: "coach_message", message: "这个器械被占了，换个动作" }));
    assert.equal(swap.body.workout.status, "exercise_active", "换动作意图不能被当成收工");
  } finally { child.kill(); await new Promise(resolve => child.once("exit", resolve)); await rm(dbPath, { force: true }); }
});

// ── B6(2026-11-09):休息中报疼,要把刚那一组标成 pain ───────────────
// 旧行为:只暂停会话,那组仍是 feedback=right/pain=false → recentPainEvent 恒 false,
// 下次照样排同一个动作(安全证据断链)。
test("server: 休息中报疼会把刚完成的组标成 pain,且不改剂量", async () => {
  const dbPath = `${process.cwd()}${process.platform === "win32" ? "\\" : "/"}test${process.platform === "win32" ? "\\" : "/"}latepain-${process.pid}.db`;
  const port = 44000 + (process.pid % 900) + (++__portSeq * 7);
  await rm(dbPath, { force: true });
  const child = spawn(process.execPath, ["src/server.ts"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), TRAINMIND_DB: dbPath }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(Error("server timeout")), 20000); child.stdout.on("data", b => { if (String(b).includes("TrainMind running")) { clearTimeout(timeout); resolve(); } }); child.once("exit", code => reject(Error(`server exited ${code}`))); });
    const origin = `http://localhost:${port}`;
    const get = async (path: string) => (await fetch(origin + path)).json() as Promise<any>;
    const post = async (path: string, payload: unknown) => { const r = await fetch(origin + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
    const bind = async (id: string, payload: any) => { const { workout: w } = await get(`/api/workouts/${id}`); return { ...payload, context: { sessionId: w.sessionId, exerciseId: w.exercises[w.runtime.currentExerciseIndex]?.exerciseId ?? null, setNumber: w.runtime.currentSetNumber, coachPhase: w.runtime.coach?.phase ?? null, status: w.status, eventCount: w.runtime.events.length } }; };

    const userId = "latepain-e2e";
    const created = await post("/api/workouts/preview", { input: "我在家，有20分钟，想练全身。", userId, dataOrigin: "automated_test" });
    const id = created.body.workout.sessionId;
    await post(`/api/workouts/${id}/actions`, await bind(id, { type: "start", coach: true }));
    await post(`/api/workouts/${id}/actions`, await bind(id, { type: "coach_event", event: { type: "start_set" } }));
    await post(`/api/workouts/${id}/actions`, await bind(id, { type: "coach_event", event: { type: "guidance_started" } }));
    const weightBefore = (await get(`/api/workouts/${id}`)).workout.exercises[(await get(`/api/workouts/${id}`)).workout.runtime.currentExerciseIndex].currentWeight;
    const done = await post(`/api/workouts/${id}/actions`, await bind(id, { type: "complete_set" }));
    assert.equal(done.body.workout.status, "resting");

    const pain = await post(`/api/workouts/${id}/actions`, await bind(id, { type: "feedback", feedback: "pain" }));
    assert.equal(pain.body.workout.status, "paused", "休息中报疼必须停下");
    assert.ok(pain.body.workout.runtime.coach?.safetyStopped, "必须置 safetyStopped");

    const db = new DatabaseSync(dbPath);
    try {
      const rows = db.prepare("SELECT data_json FROM set_records WHERE data_json != '{}'").all() as Array<{ data_json: string }>;
      assert.equal(rows.length, 1, "更正而不是新增");
      const record = JSON.parse(rows[0]!.data_json);
      assert.equal(record.feedback, "pain", "刚那组必须被标成疼痛");
      assert.equal(record.pain, true, "pain 标志必须置位(能力模型据此躲开同一动作)");
      assert.equal(record.actualWeight, weightBefore, "报疼不许改剂量");
    } finally { db.close(); }
  } finally { child.kill(); await new Promise(resolve => child.once("exit", resolve)); await rm(dbPath, { force: true }); }
});

// ── B6 语音路径补齐(2026-11-09 复核 High-1)───────────────────────────
// 「头晕/恶心/胸闷/心慌/发麻」这些红旗词不在前端 pain 正则里,会被当成 coach_message
// 送到 stopIntent=pain 分支。旧实现只停机器、不标组 —— 安全证据链对这类话仍断。
test("server: 语音红旗词报疼(恶心)也要把刚完成的组标成 pain,且不改剂量", async () => {
  const dbPath = `${process.cwd()}${process.platform === "win32" ? "\\" : "/"}test${process.platform === "win32" ? "\\" : "/"}voicepain-${process.pid}.db`;
  const port = 44000 + (process.pid % 900) + (++__portSeq * 7);
  await rm(dbPath, { force: true });
  const child = spawn(process.execPath, ["src/server.ts"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), TRAINMIND_DB: dbPath }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(Error("server timeout")), 20000); child.stdout.on("data", b => { if (String(b).includes("TrainMind running")) { clearTimeout(timeout); resolve(); } }); child.once("exit", code => reject(Error(`server exited ${code}`))); });
    const origin = `http://localhost:${port}`;
    const get = async (path: string) => (await fetch(origin + path)).json() as Promise<any>;
    const post = async (path: string, payload: unknown) => { const r = await fetch(origin + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
    const bind = async (id: string, payload: any) => { const { workout: w } = await get(`/api/workouts/${id}`); return { ...payload, context: { sessionId: w.sessionId, exerciseId: w.exercises[w.runtime.currentExerciseIndex]?.exerciseId ?? null, setNumber: w.runtime.currentSetNumber, coachPhase: w.runtime.coach?.phase ?? null, status: w.status, eventCount: w.runtime.events.length } }; };

    const userId = "voicepain-e2e";
    const created = await post("/api/workouts/preview", { input: "我在家，有20分钟，想练全身。", userId, dataOrigin: "automated_test" });
    const id = created.body.workout.sessionId;
    await post(`/api/workouts/${id}/actions`, await bind(id, { type: "start", coach: true }));
    await post(`/api/workouts/${id}/actions`, await bind(id, { type: "coach_event", event: { type: "start_set" } }));
    await post(`/api/workouts/${id}/actions`, await bind(id, { type: "coach_event", event: { type: "guidance_started" } }));
    const before = (await get(`/api/workouts/${id}`)).workout;
    const weightBefore = before.exercises[before.runtime.currentExerciseIndex].currentWeight;
    const done = await post(`/api/workouts/${id}/actions`, await bind(id, { type: "complete_set" }));
    assert.equal(done.body.workout.status, "resting");

    // 红旗词走 coach_message,不是 feedback 动作
    const pain = await post(`/api/workouts/${id}/actions`, await bind(id, { type: "coach_message", message: "刚才那组做完有点恶心" }));
    assert.equal(pain.status, 200, JSON.stringify(pain.body).slice(0, 200));
    assert.equal(pain.body.workout.status, "paused", "说完必须停下");
    assert.ok(pain.body.workout.runtime.coach?.safetyStopped, "必须置 safetyStopped");

    const db = new DatabaseSync(dbPath);
    try {
      const rows = db.prepare("SELECT data_json FROM set_records WHERE data_json != '{}'").all() as Array<{ data_json: string }>;
      assert.equal(rows.length, 1, "更正而不是新增");
      const record = JSON.parse(rows[0]!.data_json);
      assert.equal(record.feedback, "pain", "语音报疼同样必须标在那组上");
      assert.equal(record.pain, true, "pain 标志必须置位(能力模型据此躲开同一动作)");
      assert.equal(record.actualWeight, weightBefore, "报疼不许改剂量");
    } finally { db.close(); }
  } finally { child.kill(); await new Promise(resolve => child.once("exit", resolve)); await rm(dbPath, { force: true }); }
});

// ── B4(2026-11-09):三态只降不升的修复 ─────────────────────────
// 旧实现组后补报次数时沿用 record.actualRepsSource(自动结组时是 assumed),
// 用户真报的数字被永久当成推定,进步统计永远排除它。
test("late feedback B4: 事后报的次数把来源升到 reported,counted 不被降级", async () => {
  const w = (await createWorkout("我在家，想练30分钟，想练全身。", "late-source", new RuleLanguageModelProvider())).workout!;
  startWorkout(w); completeWarmup(w);
  markSetComplete(w);
  const { record } = submitSetFeedback(w, { feedback: "right" });
  assert.equal(record.actualRepsSource, "assumed", "没数到就是假定");
  const late = applyLateFeedback(w, record, { actualReps: 12 });
  assert.equal(late.record.actualReps, 12);
  assert.equal(late.record.actualRepsSource, "reported", "真报了一个数就必须升级来源");
  const counted = { ...record, actualRepsSource: "counted" as const };
  assert.equal(applyLateFeedback(w, counted, { actualReps: 11 }).record.actualRepsSource, "counted", "counted 不许被降级");
  assert.equal(applyLateFeedback(w, record, { feedback: "hard" }).record.actualRepsSource, "assumed", "没报数就不动来源");
});
