// P0 批（2026-11-11 审查后修复）：输入校验、课程进度、删除完整性。
// 每条都先红后绿：这些行为此前要么能直接复现（路径穿越写文件、0 组算完成），
// 要么把用户输入错误当成内部错误回 500。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
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

async function startServer() {
  const dir = await mkdtemp(join(tmpdir(), "trainmind-p0-"));
  const dbPath = join(dir, "t.db");
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), HOST: "127.0.0.1", TRAINMIND_DB: dbPath, TRAINMIND_STT: "off" };
  for (const key of ["TRAINMIND_CHAT_BASE_URL", "TRAINMIND_CHAT_MODEL", "TRAINMIND_CHAT_API_KEY"]) delete env[key];
  const child = spawn(process.execPath, ["src/server.ts"], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
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
    dir,
    async close() { if (child.exitCode === null) { child.kill(); await new Promise(r => child.once("exit", r)); } await rm(dir, { recursive: true, force: true }); },
  };
}

const post = async (origin: string, path: string, body: unknown) => {
  const r = await fetch(origin + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const get = async (origin: string, path: string) => {
  const r = await fetch(origin + path);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

/** 用真实的动作接口把一场训练从开练推到结束(或中止),避免手搓会话结构。 */
async function drive(origin: string, sessionId: string, opts: { abortAfterSets?: number } = {}) {
  const load = async () => (await get(origin, `/api/workouts/${sessionId}`)).body.workout;
  const ctx = (w: any) => ({
    sessionId: w.sessionId,
    exerciseId: w.exercises[w.runtime.currentExerciseIndex]?.exerciseId ?? null,
    setNumber: w.runtime.currentSetNumber,
    coachPhase: w.runtime.coach?.phase ?? null,
    status: w.status,
    eventCount: w.runtime.events.length,
  });
  let w = await load();
  let sent = await post(origin, `/api/workouts/${sessionId}/actions`, { type: "start", context: ctx(w) });
  w = sent.body.workout;
  // 只数"真正落库的组"：complete_set 之后还要提交组反馈，set_records 才会有这一行。
  let sets = 0;
  for (let i = 0; i < 80 && !["completed", "aborted"].includes(w.status); i++) {
    if (opts.abortAfterSets !== undefined && sets >= opts.abortAfterSets) {
      sent = await post(origin, `/api/workouts/${sessionId}/actions`, { type: "abort", context: ctx(w) });
      w = sent.body.workout;
      break;
    }
    const c = ctx(w);
    if (w.status === "exercise_active") sent = await post(origin, `/api/workouts/${sessionId}/actions`, { type: "complete_set", context: c });
    else if (w.status === "resting") sent = await post(origin, `/api/workouts/${sessionId}/actions`, { type: "rest_complete", context: c });
    else if (w.status === "warming_up") sent = await post(origin, `/api/workouts/${sessionId}/actions`, { type: "warmup_complete", context: c });
    else if (w.status === "cooling_down") sent = await post(origin, `/api/workouts/${sessionId}/actions`, { type: "cooldown_complete", context: c });
    else if (w.status === "set_feedback") { sent = await post(origin, `/api/workouts/${sessionId}/actions`, { type: "feedback", feedback: "right", context: c }); sets++; }
    else throw new Error(`卡在未知状态 ${w.status}`);
    w = sent.body.workout;
  }
  return { workout: w, sets };
}

test("P0: userId 不许穿越目录写文件,也不许进响应头", { timeout: 40000 }, async () => {
  const srv = await startServer();
  // 上一轮修复前的红跑会真的留下这个目录；先清掉，免得"存在即失败"变成假红。
  await rm(join(process.cwd(), "public", "pwn"), { recursive: true, force: true });
  try {
    // 1) 日报落地路径穿越：此前会把 .md 写到仓库任意目录
    const escape = await get(srv.origin, `/api/report/daily?userId=${encodeURIComponent("..")}%2Fpublic%2Fpwn&save=1`);
    assert.equal(escape.status, 400, `越界 userId 必须是用户输入错误，实际 ${escape.status}`);
    assert.match(String((escape.body as any).error ?? ""), /训练者 ID/);
    assert.equal(existsSync(join(process.cwd(), "public", "pwn")), false, "不许在 public/ 下生成目录");

    // 2) 导出文件名直接拼 userId → 换行会打断响应头（此前 500）
    const injected = await get(srv.origin, `/api/export?userId=${encodeURIComponent("abc\ndef")}`);
    assert.equal(injected.status, 400, `带换行的 userId 应是 400，实际 ${injected.status}`);

    // 3) 正常 ID 仍然可用
    const ok = await get(srv.origin, `/api/export?userId=demo-user`);
    assert.equal(ok.status, 200);
  } finally { await srv.close(); }
});

test("P0: 感知触发只认自己的键,不许走原型链", { timeout: 40000 }, async () => {
  const srv = await startServer();
  try {
    // 触发词校验在会话加载之前，所以用不存在的会话也能区分：
    // 走原型链时这里会因为"训练不存在"报错，正确实现应当先判成未知触发。
    for (const trigger of ["toString", "constructor", "hasOwnProperty"]) {
      const r = await post(srv.origin, "/api/workouts/not-a-session/perception", { trigger });
      assert.equal(r.status, 400, `${trigger} 应被拒绝，实际 ${r.status}`);
      assert.match(String((r.body as any).error ?? ""), /未知感知触发/);
    }
  } finally { await srv.close(); }
});

test("P0: 会话体验字段非法时回 400,不是 500", { timeout: 40000 }, async () => {
  const srv = await startServer();
  try {
    const r = await post(srv.origin, "/api/workouts/preview", { input: "20分钟，我在家，徒手自重，想练全身", userId: "xp", experienceMode: "content", topic: "bogus" });
    assert.equal(r.status, 400, `非法 topic 是用户输入问题，实际 ${r.status}`);
    assert.match(String((r.body as any).error ?? ""), /内容主题|topic/i);
  } finally { await srv.close(); }
});

test("P0: 课程里 0 组的'提前结束'不算完成一场", { timeout: 60000 }, async () => {
  const srv = await startServer();
  try {
    const user = "p0-program";
    const made = await post(srv.origin, "/api/programs", { userId: user, goal: "想练全身", weeks: 4, sessionsPerWeek: 3, targetMinutes: 30, equipment: ["bodyweight"] });
    const programId = made.body.program.programId;

    // 连开三场、一组不做就结束：进度必须一直是 0，不能靠"开-结束"刷满
    for (let i = 0; i < 3; i++) {
      const started = await post(srv.origin, `/api/programs/${programId}/start`, { userId: user });
      const { sets } = await drive(srv.origin, started.body.workout.sessionId, { abortAfterSets: 0 });
      assert.equal(sets, 0);
      const status = await get(srv.origin, `/api/programs/active?userId=${user}`);
      assert.equal(status.body.status.completedSessions, 0, `第 ${i + 1} 次空结束不该算完成，实际 ${status.body.status.completedSessions}`);
    }

    // 真练了一组再提前结束 —— 这才算这场的证据
    const again = await post(srv.origin, `/api/programs/${programId}/start`, { userId: user });
    const { sets } = await drive(srv.origin, again.body.workout.sessionId, { abortAfterSets: 1 });
    assert.equal(sets, 1);
    const after = await get(srv.origin, `/api/programs/active?userId=${user}`);
    assert.equal(after.body.status.completedSessions, 1, "练过一组再结束应当记一场");
  } finally { await srv.close(); }
});

test("P0: 删除全部数据要连动作表现一起删干净", { timeout: 60000 }, async () => {
  const srv = await startServer();
  try {
    const user = "p0-delete";
    const pv = await post(srv.origin, "/api/workouts/preview", { input: "20分钟，我在家，徒手自重，想练全身", userId: user });
    const sessionId = pv.body.workout.sessionId;
    const { workout } = await drive(srv.origin, sessionId, { abortAfterSets: 1 });
    assert.equal(workout.status, "aborted");

    const readDb = () => {
      const db = new DatabaseSync(srv.dbPath, { readOnly: true });
      try {
        const one = (sql: string) => Number((db.prepare(sql).get(user) as any)?.n ?? 0);
        return {
          performances: one("SELECT COUNT(*) n FROM exercise_performances WHERE user_id = ?"),
          sessions: one("SELECT COUNT(*) n FROM workout_sessions WHERE user_id = ?"),
          records: one("SELECT COUNT(*) n FROM training_records WHERE user_id = ?"),
        };
      } finally { db.close(); }
    };
    const before = readDb();
    assert.ok(before.performances > 0, "这场训练应当已经写入动作表现");

    const del = await fetch(`${srv.origin}/api/export?userId=${user}`, { method: "DELETE" });
    assert.equal(del.status, 200);

    const after = readDb();
    assert.deepEqual(after, { performances: 0, sessions: 0, records: 0 }, `删除后必须全部归零，实际 ${JSON.stringify(after)}`);
  } finally { await srv.close(); }
});
