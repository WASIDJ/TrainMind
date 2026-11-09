// M10:两处必崩点的反向验收——
// ① listen EADDRINUSE:端口被占时必须"说人话 + 非零码退出",而不是甩未处理堆栈;
// ② python spawn ENOENT:解释器不存在时只废 STT sidecar,主服务必须活着并可服务。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const until = async (probe: () => boolean, message: string, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (probe()) return; await new Promise(r => setTimeout(r, 200)); }
  throw Error(message);
};
const freePort = async () => {
  const probe = createServer();
  await new Promise<void>(r => probe.listen(0, "127.0.0.1", () => r()));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(r => probe.close(() => r()));
  return port;
};

test("M10: 端口被占(EADDRINUSE)→ 人话报错 + 退出码 1,不甩堆栈", { timeout: 30000 }, async () => {
  // 先用一个纯 TCP 监听占住端口,保证第二个实例 listen 必然 EADDRINUSE
  const blocker = createServer((_req, res) => { res.writeHead(200); res.end("occupied"); });
  await new Promise<void>(r => blocker.listen(0, "127.0.0.1", () => r()));
  const port = (blocker.address() as { port: number }).port;
  const child = spawn(process.execPath, ["src/server.ts"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", TRAINMIND_DB: ":memory:", TRAINMIND_STT: "off" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", b => output += b);
  child.stderr.on("data", b => output += b);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error("占用端口后服务没有退出: " + output)), 15000);
      child.once("exit", c => { clearTimeout(timeout); resolve(c); });
    });
    assert.equal(code, 1, "应以退出码 1 干净退出");
    assert.match(output, /端口 \d+ 已被占用/, "报错必须说人话并指向动作");
  } finally {
    if (child.exitCode === null) { child.kill(); await new Promise(r => child.once("exit", r)); }
    await new Promise<void>(r => blocker.close(() => r()));
  }
});

test("M10: python 不存在(spawn ENOENT)→ sidecar 报原因,主服务继续活", { timeout: 40000 }, async () => {
  const port = await freePort();
  // TRAINMIND_STT_SIDECAR 指向必然无人的端口,避免"恰有常驻 sidecar"让测试跳过 spawn 分支
  const child = spawn(process.execPath, ["src/server.ts"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", TRAINMIND_DB: ":memory:", TRAINMIND_PYTHON: "/nonexistent/trainmind-python", TRAINMIND_STT_SIDECAR: "http://127.0.0.1:1" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", b => output += b);
  child.stderr.on("data", b => output += b);
  try {
    await until(() => output.includes("TrainMind running"), "服务没能启动: " + output, 20000);
    await until(() => /STT sidecar 未启动|找不到 Python/.test(output), "ENOENT 未被报告(可能直接崩了): " + output, 15000);
    const home = await fetch(`http://127.0.0.1:${port}/`);
    assert.ok(home.ok, "主服务必须仍可服务请求");
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(child.exitCode, null, "ENOENT 只该废掉 sidecar,不该带走主进程");
  } finally {
    if (child.exitCode === null) { child.kill(); await new Promise(r => child.once("exit", r)); }
  }
});
