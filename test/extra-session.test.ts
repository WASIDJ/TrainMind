// 加练(2026-11-09, owner)：「用户在完成今日训练计划的基础上还想自己接着练，
// 我们没有理由阻止；加练了就给记录好并存档。」
//
// 反向验收：加练必须
//   1. 被允许（不因为"今天已经练过"而拒绝）
//   2. 打上 kind="extra" 以便记录里分得清"计划内/自己加的"
//   3. 不挂课程归属（program 为空）→ 不会顶掉课程进度
//   4. 普通场次不受影响（kind 不能被误标）
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const freePort = async () => {
  const probe = createServer();
  await new Promise<void>(r => probe.listen(0, "127.0.0.1", () => r()));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(r => probe.close(() => r()));
  return port;
};

async function startServer() {
  const dir = await mkdtemp(join(tmpdir(), "trainmind-extra-"));
  const dbPath = join(dir, "t.db");
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), HOST: "127.0.0.1", TRAINMIND_DB: dbPath, TRAINMIND_STT: "off" };
  const child = spawn(process.execPath, ["src/server.ts"], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", b => output += b);
  child.stderr.on("data", b => output += b);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`服务没有起来: ${output.slice(-400)}`)), 20000);
    child.stdout.on("data", b => { if (String(b).includes("TrainMind running")) { clearTimeout(timer); resolve(); } });
    child.once("exit", code => reject(Error(`服务提前退出(${code}): ${output.slice(-400)}`)));
  });
  const call = async (path: string, payload: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    return { status: r.status, body: await r.json().catch(() => ({})) as any };
  };
  const get = async (path: string) => (await fetch(`http://127.0.0.1:${port}${path}`)).json() as Promise<any>;
  return { call, get, async close() { if (child.exitCode === null) { child.kill(); await new Promise(r => child.once("exit", r)); } await rm(dir, { recursive: true, force: true }); } };
}

test("加练: 完成计划后仍可再开一场，标记 extra 且不挂课程", { timeout: 40000 }, async () => {
  const s = await startServer();
  try {
    const userId = "extra-e2e";
    // 第一场：普通计划
    const first = await s.call("/api/workouts/preview", { input: "我在家，有20分钟，想练全身。", userId, dataOrigin: "automated_test" });
    assert.equal(first.status, 201);
    assert.equal(first.body.workout.kind, undefined, "普通场次不许被标成加练");

    // 第二场：加练 —— 关键断言是"不被拦"
    const extra = await s.call("/api/workouts/preview", { kind: "extra", input: "我还想再练20分钟，在家，徒手。", userId, dataOrigin: "automated_test" });
    assert.equal(extra.status, 201, "加练不许被拒绝");
    assert.equal(extra.body.workout.kind, "extra");
    assert.equal(extra.body.workout.program, undefined, "加练不挂课程，避免顶掉课程进度");

    // 落库时也要带着标记（记录页/存档据此区分）
    const stored = await s.get(`/api/workouts/${extra.body.workout.sessionId}`);
    assert.equal(stored.workout.kind, "extra");
  } finally { await s.close(); }
});
