// owner 2026-11-09 三条裁决的回归:
//   B10 日/周边界按服务器本地时区
//   D1  报数是可选功能 —— 报了就算实测(counted/reported),不报仍是 assumed
//   A10 课程场次的 dataOrigin 缺省 human(接线守卫,见文件末尾说明)
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { relationship } from "../src/progress.ts";
import { weekOverWeek } from "../src/program.ts";
import { localDayKey } from "../src/local-time.ts";

const freePort = async () => {
  const probe = createServer();
  await new Promise<void>(r => probe.listen(0, "127.0.0.1", () => r()));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(r => probe.close(() => r()));
  return port;
};

test("B10: 早间训练按本地时区算进本周(不再落到上一周)", () => {
  // 本地周一 07:30 的实测组,now = 本地周一 20:00 —— 必须算"本周"
  // (weekOverWeek 只在两侧都有实测时才出结论,所以上周也放一条对照)
  const mondayMorning = new Date(2026, 10, 9, 7, 30).toISOString();
  const lastMonday = new Date(2026, 10, 2, 7, 30).toISOString();
  const now = new Date(2026, 10, 9, 20, 0).getTime();
  const rows = weekOverWeek([
    { exerciseId: "squat", actualReps: 10, completedAt: mondayMorning, actualRepsSource: "counted" } as never,
    { exerciseId: "squat", actualReps: 8, completedAt: lastMonday, actualRepsSource: "counted" } as never,
  ], { squat: "深蹲" }, now);
  assert.equal(rows.length, 1, "本周应当看得到这条实测(UTC 口径下周一 07:30 会落到上一周)");
  assert.equal(rows[0]!.thisWeek, 10);
  assert.equal(rows[0]!.lastWeek, 8);
});

test("B10: 同一自然日的早晚两次训练算 1 天", () => {
  const morning = new Date(2026, 10, 9, 7, 0).toISOString();
  const evening = new Date(2026, 10, 9, 20, 0).toISOString();
  assert.equal(localDayKey(Date.parse(morning)), localDayKey(Date.parse(evening)), "本地同一天");
  const rel = relationship([morning, evening], new Date(2026, 10, 9, 21, 0).getTime());
  assert.equal(rel.totalSessions, 1, "两次训练算一天");
});

test("D1: 报数（可选）时 complete_set 带次数 → 记为 counted；不报 → 仍 assumed", { timeout: 40000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "trainmind-d1-"));
  const dbPath = join(dir, "t.db");
  const port = await freePort();
  const child = spawn(process.execPath, ["src/server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", TRAINMIND_DB: dbPath, TRAINMIND_STT: "off" },
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
    const origin = `http://127.0.0.1:${port}`;
    const get = async (path: string) => (await fetch(origin + path)).json() as Promise<any>;
    const post = async (path: string, payload: unknown) => { const r = await fetch(origin + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
    const bind = async (id: string, payload: any) => { const { workout: w } = await get(`/api/workouts/${id}`); return { ...payload, context: { sessionId: w.sessionId, exerciseId: w.exercises[w.runtime.currentExerciseIndex]?.exerciseId ?? null, setNumber: w.runtime.currentSetNumber, coachPhase: w.runtime.coach?.phase ?? null, status: w.status, eventCount: w.runtime.events.length } }; };
    const coachUpToSet = async (userId: string) => {
      const created = await post("/api/workouts/preview", { input: "我在家，有20分钟，想练全身。", userId, dataOrigin: "automated_test" });
      const id = created.body.workout.sessionId as string;
      await post(`/api/workouts/${id}/actions`, await bind(id, { type: "start", coach: true }));
      await post(`/api/workouts/${id}/actions`, await bind(id, { type: "coach_event", event: { type: "start_set" } }));
      await post(`/api/workouts/${id}/actions`, await bind(id, { type: "coach_event", event: { type: "guidance_started" } }));
      return id;
    };

    const countedId = await coachUpToSet("d1-counted");
    await post(`/api/workouts/${countedId}/actions`, await bind(countedId, { type: "complete_set", actualReps: 11, actualRepsSource: "counted" }));

    const silentId = await coachUpToSet("d1-silent");
    await post(`/api/workouts/${silentId}/actions`, await bind(silentId, { type: "complete_set" }));

    const db = new DatabaseSync(dbPath);
    try {
      const rows = db.prepare("SELECT id, data_json FROM set_records WHERE data_json != '{}'").all() as Array<{ id: string; data_json: string }>;
      const bySession = new Map(rows.map(r => { const d = JSON.parse(r.data_json); return [d.sessionId as string, d]; }));
      const counted = bySession.get(countedId);
      assert.ok(counted, "报了数的那组要有记录");
      assert.equal(counted.actualReps, 11, "用户报的次数要落库");
      assert.equal(counted.actualRepsSource, "counted", "报了数就是实测,不再是 assumed");
      const silent = bySession.get(silentId);
      assert.ok(silent);
      assert.equal(silent.actualRepsSource, "assumed", "没报数仍然是按计划推定");
    } finally { db.close(); }
  } finally {
    if (child.exitCode === null) { child.kill(); await new Promise(r => child.once("exit", r)); }
    await rm(dir, { recursive: true, force: true });
  }
});

test("A10/D24: 预览（真实训练）不带 dataOrigin 时缺省记 human", { timeout: 40000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "trainmind-a10-"));
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
    const origin = `http://127.0.0.1:${port}`;
    const created = await fetch(`${origin}/api/workouts/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "我在家，有20分钟，想练全身。", userId: "a10-default" }) });
    const { workout } = await created.json() as { workout: { sessionId: string } };
    const detail = await (await fetch(`${origin}/api/workouts/${workout.sessionId}`)).json() as any;
    assert.equal(detail.workout.experience?.dataOrigin, "human", "真实训练不许再默认成演示数据");
  } finally {
    if (child.exitCode === null) { child.kill(); await new Promise(r => child.once("exit", r)); }
    await rm(dir, { recursive: true, force: true });
  }
});

test("A10(接线守卫): 课程开局的 dataOrigin 缺省是 human", async () => {
  const server = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");
  const block = server.slice(server.indexOf("A10(2026-11-09"), server.indexOf("persistNewWorkout(workout);"));
  assert.match(block, /: "human";/, "缺省值必须是 human");
  assert.match(block, /createWorkoutFromInput\(userId, template\.input, dataOrigin\)/, "要把选好的来源透传下去");
  assert.doesNotMatch(block, /template\.input, "demo"/, "不许再写死 demo");
});
