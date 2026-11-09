// 第 2 批审计(2026-11-09)的服务层反向验收:
//   A4 一行坏配置不许带走服务(A5/A6/A7 同理:出错只回 4xx,进程必须活着)
//   A5 静态资源缺失 → 404,不是"写了 200 头再抛错"崩进程
//   A6 超大请求体 → 400,不吃进内存
//   A7 /survey 只收主观量表字段,不许覆写剂量证据
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { rename, rm, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const freePort = async () => {
  const probe = createServer();
  await new Promise<void>(r => probe.listen(0, "127.0.0.1", () => r()));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(r => probe.close(() => r()));
  return port;
};

/** 启一个指向临时库的服务;返回 origin 与清理函数。 */
async function startServer(env: Record<string, string | undefined> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "trainmind-hardening-"));
  const dbPath = join(dir, "t.db");
  const port = await freePort();
  const childEnv: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), HOST: "127.0.0.1", TRAINMIND_DB: dbPath, TRAINMIND_STT: "off", ...env };
  // 测试里必须走"没有环境变量"的分支,才能覆盖 app_settings 读取路径
  for (const key of ["TRAINMIND_CHAT_BASE_URL", "TRAINMIND_CHAT_MODEL", "TRAINMIND_CHAT_API_KEY"]) if (!(key in (env as object))) delete childEnv[key];
  const child = spawn(process.execPath, ["src/server.ts"], { cwd: process.cwd(), env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", b => output += b);
  child.stderr.on("data", b => output += b);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error(`服务没有起来: ${output.slice(-400)}`)), 20000);
    child.stdout.on("data", b => { if (String(b).includes("TrainMind running")) { clearTimeout(timeout); resolve(); } });
    child.once("exit", code => reject(Error(`服务提前退出(${code}): ${output.slice(-400)}`)));
  });
  return {
    origin: `http://127.0.0.1:${port}`,
    dbPath,
    alive: () => child.exitCode === null,
    output: () => output,
    async close() { if (child.exitCode === null) { child.kill(); await new Promise(r => child.once("exit", r)); } await rm(dir, { recursive: true, force: true }); },
  };
}

const get = async (origin: string, path: string, init?: RequestInit) => {
  const r = await fetch(origin + path, init);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

test("A4: app_settings.coach 写坏时服务仍能启动并应答(不许启动即死)", { timeout: 40000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "trainmind-badcfg-"));
  const dbPath = join(dir, "t.db");
  const seed = new DatabaseSync(dbPath);
  seed.exec("CREATE TABLE IF NOT EXISTS app_settings (name TEXT PRIMARY KEY, data_json TEXT NOT NULL)");
  seed.prepare("INSERT INTO app_settings VALUES ('coach', ?)").run("{broken");
  seed.close();
  // 用同一个库文件启动服务(不走 startServer,因为它会新建库)
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), HOST: "127.0.0.1", TRAINMIND_DB: dbPath, TRAINMIND_STT: "off" };
  for (const key of ["TRAINMIND_CHAT_BASE_URL", "TRAINMIND_CHAT_MODEL", "TRAINMIND_CHAT_API_KEY"]) delete env[key];
  const child = spawn(process.execPath, ["src/server.ts"], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", b => output += b);
  child.stderr.on("data", b => output += b);
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error(`坏配置把服务带走了: ${output.slice(-400)}`)), 20000);
      child.stdout.on("data", b => { if (String(b).includes("TrainMind running")) { clearTimeout(timeout); resolve(); } });
      child.once("exit", code => reject(Error(`服务在坏配置下退出(${code}): ${output.slice(-400)}`)));
    });
    const home = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(home.status, 200, "服务必须还能服务页面");
    assert.match(output, /coach_config_unreadable/, "坏行要被记一笔,而不是静默吞掉");
  } finally {
    if (child.exitCode === null) { child.kill(); await new Promise(r => child.once("exit", r)); }
    await rm(dir, { recursive: true, force: true });
  }
});

test("A5: 静态资源缺失只回 404,进程不许被 ERRP_HTTP_HEADERS_SENT 带走", { timeout: 40000 }, async () => {
  const target = new URL("../public/perception-check.html", import.meta.url);
  const filePath = target.pathname;
  const backup = `${filePath}.a5-bak`;
  await rename(filePath, backup);
  const server = await startServer();
  try {
    const missing = await fetch(`${server.origin}/perception-check`);
    assert.equal(missing.status, 404, "缺文件应回 404");
    const home = await fetch(`${server.origin}/`);
    assert.equal(home.status, 200, "服务必须还活着");
    assert.ok(server.alive(), "进程不许退出");
  } finally {
    await server.close();
    if (existsSync(backup)) await rename(backup, filePath);
  }
  assert.ok(existsSync(filePath), "测试必须把文件还原");
});

test("A6: 超大请求体被拒(400),不会整包读进内存", { timeout: 40000 }, async () => {
  const server = await startServer();
  try {
    const huge = "x".repeat(2 * 1024 * 1024); // 2MB,超过 1MB 上限
    const r = await fetch(`${server.origin}/api/workouts/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: huge, userId: "oversize" }) });
    assert.equal(r.status, 400, "超限应按用户输入错误拒绝");
    const body = await r.json() as { error?: string };
    assert.match(String(body.error), /请求体过大/, "要给可读原因");
    const home = await fetch(`${server.origin}/`);
    assert.equal(home.status, 200, "服务必须还活着");
  } finally { await server.close(); }
});

test("A7: /survey 只收主观量表字段,不能覆写 elapsedClockMs / userId", { timeout: 40000 }, async () => {
  const server = await startServer();
  try {
    const created = await get(server.origin, "/api/workouts/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "我在家，有20分钟，想练全身。", userId: "survey-evil", dataOrigin: "automated_test" }) });
    const id = created.body.workout.sessionId as string;
    const bind = async (payload: any) => {
      const { body } = await get(server.origin, `/api/workouts/${id}`);
      const w = body.workout;
      return { ...payload, context: { sessionId: w.sessionId, exerciseId: w.exercises[w.runtime.currentExerciseIndex]?.exerciseId ?? null, setNumber: w.runtime.currentSetNumber, coachPhase: w.runtime.coach?.phase ?? null, status: w.status, eventCount: w.runtime.events.length } };
    };
    await get(server.origin, `/api/workouts/${id}/actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(await bind({ type: "start" })) });
    await get(server.origin, `/api/workouts/${id}/actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(await bind({ type: "abort" })) });

    const db = new DatabaseSync(server.dbPath);
    const before = db.prepare("SELECT data_json FROM training_records WHERE session_id = ?").get(id) as { data_json: string } | undefined;
    db.close();
    assert.ok(before, "abort 后应已写入训练记录");

    const survey = await get(server.origin, `/api/workouts/${id}/survey`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ perceivedFatigue: 3, elapsedClockMs: 0, userId: "evil", startedAt: "2020-01-01T00:00:00Z", doseOutcomes: [] }),
    });
    assert.equal(survey.status, 200);

    const db2 = new DatabaseSync(server.dbPath);
    const after = JSON.parse((db2.prepare("SELECT data_json FROM training_records WHERE session_id = ?").get(id) as { data_json: string }).data_json);
    db2.close();
    assert.equal(after.perceivedFatigue, 3, "量表字段应当被接受");
    assert.notEqual(after.elapsedClockMs, 0, "elapsedClockMs 不许被客户端覆写");
    assert.notEqual(after.userId, "evil", "userId 不许被客户端覆写");
    assert.notEqual(after.startedAt, "2020-01-01T00:00:00Z", "startedAt 不许被客户端覆写");
  } finally { await server.close(); }
});
