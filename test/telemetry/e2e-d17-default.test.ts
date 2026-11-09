// H1+H2(2026-11-06 全仓审查)回归:D17 默认流程的遥测完整性
// H1:开教练时 complete_set 自动结组(不逐组询问)也必须落 v2 组记录+反馈——
//     修复前该路径 set_records/set_feedbacks 静默为空,事件链在旗舰语音模式下断链。
// H2:组后两次口头更正都不许抛 UNIQUE;每次 200,最终该组 set_feedbacks 仍是 1 行、末次接受为准。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { validateSessionChain } from "../../src/telemetry/index.ts";

const freePort = () => new Promise<number>(resolve => { const server = createServer(); server.listen(0, "127.0.0.1", () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); }); });
const until = async (check: () => Promise<boolean> | boolean, message: string, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(message);
};

async function bindAction(origin: string, path: string, payload: any) {
  if (!payload || !path.endsWith("/actions") || payload.context) return payload;
  const { workout: w } = await fetch(origin + path.slice(0, -8)).then(r => r.json());
  return { ...payload, context: { sessionId: w.sessionId, exerciseId: w.exercises[w.runtime.currentExerciseIndex]?.exerciseId ?? null,
    setNumber: w.runtime.currentSetNumber, coachPhase: w.runtime.coach?.phase ?? null, status: w.status, eventCount: w.runtime.events.length } };
}

test("H1/H2 e2e: complete_set 自动结组落 v2,组后两次更正不炸 UNIQUE", { timeout: 90000 }, async () => {
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const directory = await mkdtemp(join(tmpdir(), "trainmind-h1h2-")), databasePath = join(directory, "test.db");
  const server = spawn(process.execPath, ["src/server.ts"], { cwd: new URL("../..", import.meta.url), env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", TRAINMIND_DB: databasePath, TRAINMIND_CHAT_BASE_URL: "", TRAINMIND_CHAT_MODEL: "", TRAINMIND_CHAT_API_KEY: "", TRAINMIND_CHAT_PROTOCOL: "openai", TRAINMIND_STT: "off", TRAINMIND_STT_SIDECAR: "http://127.0.0.1:1" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; server.stdout!.on("data", data => output += data); server.stderr!.on("data", data => output += data);
  const api = async (path: string, body?: any) => {
    body = await bindAction(origin, path, body);
    const response = await fetch(origin + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json() as any;
    assert.ok(response.status >= 200 && response.status < 300, `${path}: ${response.status} ${data.error ?? ""}`);
    return data;
  };
  const action = (sessionId: string, payload: any) => api(`/api/workouts/${sessionId}/actions`, payload);
  try {
    await until(() => output.includes("TrainMind running"), "server did not start: " + output);

    // D17 默认流程:开教练 → 只按"完成本组",不逐组报感受
    const plan = (await api("/api/workouts/preview", { userId: "h1-user", input: "我在 Test Gym，有40分钟，想练背。" })).workout;
    const started = (await action(plan.sessionId, { type: "start", coach: true })).workout;
    assert.equal(started.status, "exercise_active");

    const done = await action(plan.sessionId, { type: "complete_set" });
    assert.equal(done.workout.status, "resting", "D17:完成即进休息");

    // ---- H1 断言:不补任何反馈,v2 也必须有这一组 ----
    let db = new DatabaseSync(databasePath, { readOnly: true });
    let sets = db.prepare(
      `SELECT sr.set_number, sr.status, sr.actual_reps, sr.target_reps_min
       FROM set_records sr JOIN exercise_instances ei ON ei.id = sr.exercise_instance_id
       WHERE ei.session_id = ?`).all(plan.sessionId) as any[];
    assert.equal(sets.length, 1, "H1:complete_set 自动结组必须落 v2 组记录");
    assert.equal(sets[0].status, "completed");
    assert.ok(Number.isInteger(sets[0].actual_reps), "assumed 次数落库(D17:按目标推定)");
    let feedbacks = db.prepare(
      `SELECT sf.difficulty, sf.source FROM set_feedbacks sf
       JOIN set_records sr ON sr.id = sf.set_record_id
       JOIN exercise_instances ei ON ei.id = sr.exercise_instance_id WHERE ei.session_id = ?`).all(plan.sessionId) as any[];
    assert.equal(feedbacks.length, 1, "H1:自动结组带 just_right 反馈行");
    assert.equal(feedbacks[0].difficulty, "just_right");
    assert.equal(feedbacks[0].source, "inferred", "D20:系统推定的反馈不冒充用户上报");
    db.close();

    // ---- H2:组后两次口头更正 ----
    const fix1 = await action(plan.sessionId, { type: "coach_message", message: "刚才那组太重了", source: "voice" });
    assert.equal(fix1.workout.status, "resting", "更正不打断休息");
    const fix2 = await action(plan.sessionId, { type: "coach_message", message: "还是有点重，再轻一点", source: "voice" });
    assert.equal(fix2.workout.status, "resting");

    db = new DatabaseSync(databasePath, { readOnly: true });
    feedbacks = db.prepare(
      `SELECT sf.difficulty, sf.source, sf.transcript FROM set_feedbacks sf
       JOIN set_records sr ON sr.id = sf.set_record_id
       JOIN exercise_instances ei ON ei.id = sr.exercise_instance_id WHERE ei.session_id = ?`).all(plan.sessionId) as any[];
    assert.equal(feedbacks.length, 1, "H2:两次更正后仍每组 ≤1 行(§9.7)");
    assert.equal(feedbacks[0].difficulty, "hard", "H2:末次接受为准");
    assert.equal(feedbacks[0].source, "voice");
    assert.ok(!output.includes("telemetryError"), "H2:不得再出现 UNIQUE telemetryError:\n" + output.match(/telemetryError[^\n]*/g)?.join("\n"));
    assert.deepEqual(validateSessionChain(db, plan.sessionId), []);
    db.close();
  } finally {
    if (server.exitCode === null) { const closed = new Promise(resolve => server.once("exit", resolve)); server.kill(); await closed; }
    await rm(directory, { recursive: true, force: true });
  }
});
