// 审计剩余 N(2026-11-09):A8/A9/B11-C12/D7/D9-D12 的回归。
// 能行为验证的就跑真东西(HTTP / 真库 / 真函数);只能接线验证的写明是接线守卫,不冒充端到端。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mapSetRowOrNull } from "../src/telemetry/records.ts";
import { validateSessionChain } from "../src/telemetry/validate.ts";
import { SqliteTelemetryRecorder } from "../src/telemetry/recorder.ts";
import { freshDb, setupSession, interaction } from "./telemetry/helpers.ts";
import { weekOverWeek } from "../src/program.ts";

const freePort = async () => {
  const probe = createServer();
  await new Promise<void>(r => probe.listen(0, "127.0.0.1", () => r()));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(r => probe.close(() => r()));
  return port;
};

async function withServer(fn: (origin: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "trainmind-n-"));
  const port = await freePort();
  const child = spawn(process.execPath, ["src/server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", TRAINMIND_DB: join(dir, "t.db"), TRAINMIND_STT: "off" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", b => output += b);
  child.stderr.on("data", b => output += b);
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error(`no start: ${output.slice(-300)}`)), 20000);
      child.stdout.on("data", b => { if (String(b).includes("TrainMind running")) { clearTimeout(timeout); resolve(); } });
      child.once("exit", code => reject(Error(`exited ${code}: ${output.slice(-300)}`)));
    });
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    if (child.exitCode === null) { child.kill(); await new Promise(r => child.once("exit", r)); }
    await rm(dir, { recursive: true, force: true });
  }
}

// ── A9:用户能自己修的请求问题不许回 500 ───────────────────────────
test("A9: 畸形 JSON 回 400;Origin: null 不再 500", { timeout: 40000 }, async () => {
  await withServer(async origin => {
    const bad = await fetch(`${origin}/api/programs/x/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{bad" });
    assert.equal(bad.status, 400, "畸形 JSON 属于请求问题,不该 500");
    assert.match(String((await bad.json() as { error?: string }).error), /不是合法 JSON/);

    const nullOrigin = await fetch(`${origin}/api/coach/settings`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "null" },
      body: JSON.stringify({ baseUrl: "http://127.0.0.1:1", model: "m", protocol: "openai", apiKey: "" }),
    });
    assert.notEqual(nullOrigin.status, 500, `Origin: null 不该表现为服务器内部错误(实际 ${nullOrigin.status})`);
  });
});

// ── C8:未映射的 legacy 行不许被读成"第 0 组、已跳过" ─────────────────
test("C8: mapSetRowOrNull 跳过未映射行,不伪造 0 / 'skipped'", () => {
  assert.equal(mapSetRowOrNull({ id: "legacy-1", exercise_instance_id: null, set_number: null, status: null }), null);
  assert.equal(mapSetRowOrNull({ id: "legacy-2", exercise_instance_id: "inst", set_number: 1, status: null }), null);
  const mapped = mapSetRowOrNull({ id: "v2-1", exercise_instance_id: "inst", set_number: 2, status: "completed" });
  assert.ok(mapped);
  assert.equal(mapped!.setNumber, 2);
  assert.equal(mapped!.status, "completed");
});

// ── C9:预留未用 ≠ 事件丢失 ───────────────────────────────────────
test("C9: nextSeq() 预留未用报 seq_reserved_unused,不污染 seq_gap", () => {
  const t = freshDb();
  try {
    const { recorder, sessionId } = setupSession(t);
    recorder.recordInteraction(interaction(sessionId, { occurredAt: 1_000 }));
    recorder.nextSeq(sessionId); // 预留但不落库(合法操作)
    const issues = validateSessionChain(t.db, sessionId);
    assert.ok(issues.some(i => i.kind === "seq_reserved_unused"), JSON.stringify(issues));
    assert.equal(issues.some(i => i.kind === "seq_gap"), false, "可解释的空洞不该报成丢事件");
  } finally { t.cleanup(); }
});

// ── C12:语音原文统一截断,且可一键关闭 ───────────────────────────
test("C12: transcript 截断到 200 字;TRAINMIND_TELEMETRY_TRANSCRIPT=0 时不落原文", () => {
  const t = freshDb();
  try {
    const { recorder, sessionId } = setupSession(t);
    recorder.recordInteraction(interaction(sessionId, { occurredAt: 1_000, transcript: "喊".repeat(5000) }));
    const long = (t.db.prepare("SELECT length(transcript) AS n FROM interaction_events").get() as { n: number }).n;
    assert.ok(long <= 200, `落库长度应 ≤200,实际 ${long}`);

    process.env.TRAINMIND_TELEMETRY_TRANSCRIPT = "0";
    try {
      recorder.recordInteraction(interaction(sessionId, { occurredAt: 2_000, transcript: "很疼" }));
    } finally { delete process.env.TRAINMIND_TELEMETRY_TRANSCRIPT; }
    const rows = t.db.prepare("SELECT transcript FROM interaction_events ORDER BY seq").all() as Array<{ transcript: string | null }>;
    assert.equal(rows.at(-1)!.transcript, null, "开关打开时干脆不落原文");
  } finally { t.cleanup(); }
});

// ── B11:脏日期不许让整周统计崩 ───────────────────────────────────
test("B11: weekOverWeek 遇坏 completedAt 跳过,不抛 RangeError", () => {
  const rows = weekOverWeek([
    { exerciseId: "squat", actualReps: 8, completedAt: "not-a-date", actualRepsSource: "counted" } as never,
    { exerciseId: "squat", actualReps: 9, completedAt: new Date().toISOString(), actualRepsSource: "counted" } as never,
  ], {}, Date.now());
  assert.ok(Array.isArray(rows), "不许抛");
});

// ── 接线守卫(A8/C11/D7/D9-D12)────────────────────────────────────
// 这些是结构断言:它们锁住"为什么这么接",不是端到端行为。真机/浏览器验收另算。
test("接线守卫: A8 落库前的二次检查、C11 手机判定与报告兜底、前端四处接线", async () => {
  const server = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");
  const programStart = server.slice(server.indexOf("if (req.method === \"POST\" && programStart)"), server.indexOf("/api/experiment\", {"));
  assert.match(programStart, /BEGIN IMMEDIATE[\s\S]*persistNewWorkout/, "A8:检查与落库要在同一个事务里");

  const py = await readFile(new URL("../tools/device-acceptance.py", import.meta.url), "utf8");
  assert.match(py, /adb\("get-state"\)\.strip\(\) == "device"/, "C11:没插手机时不许被 `devices` 子串骗过");
  assert.match(py, /except Exception as e:[\s\S]*finally:[\s\S]*phase8_report\(\)/, "C11:异常也要落报告");

  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /signal:AbortSignal\.timeout\(8000\)/, "D7:TTS 要有超时");
  assert.match(html, /if\(this\.url\)\{try\{URL\.revokeObjectURL\(this\.url\)\}/, "D7:stop 要回收 blob URL");
  assert.match(html, /if\(actionBusy\)\{voiceState='idle';voiceCaption='上一步还在提交，请稍后再发。'/, "D9:忙时不许静默丢消息");
  assert.match(html, /note\.setAttribute\('role','alert'\)/, "D11:结束这场失败要写在可见卡片上");
  assert.match(html, /activeId=document\.activeElement\?\.id/, "D12:重渲染要还原焦点");
  assert.match(html, /aria-pressed=\"true\" data-filter=\"all\"/, "D12:筛选要有 aria-pressed");
  assert.match(html, /id=\"rest-announce\" aria-live=\"polite\"/, "D12:倒计时要有礼貌播报");

  const check = await readFile(new URL("../public/perception-check.html", import.meta.url), "utf8");
  assert.match(check, /if \(starting \|\| !\$\('live'\)\.hidden\) return;/, "D10:start 要互斥");
  assert.match(check, /clearInterval\(timer\); timer = null;/, "D10:stop 要把 timer 置空");
});
