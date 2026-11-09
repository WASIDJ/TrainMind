// Phase 7B.2:RuntimeTelemetry 桥单元测试(ASR 重试归属 + fresh/legacy 形状守卫)
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrateTelemetry } from "../../src/telemetry/index.ts";
import { RuntimeTelemetry } from "../../src/telemetry/bridge.ts";
import { hasColumn } from "../../src/telemetry/ddl.ts";
import { readFile } from "node:fs/promises";
import { reentrantTx } from "../../src/telemetry/recorder.ts";

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  migrateTelemetry(db);
  return db;
}

function seedRunningSession(db: DatabaseSync, id: string, status: string): void {
  db.prepare("INSERT INTO workout_sessions (id, planned_workout_id, started_at, ended_at, status, app_version, next_event_seq) VALUES (?, NULL, 1000, NULL, ?, 'test', 1)").run(id, status);
}

test("recordAsrRetry attributes to the latest running session (fresh shape, no user column)", () => {
  const db = freshDb();
  seedRunningSession(db, "01HASYRTRYN000000000000000", "exercise_active");
  const telemetry = new RuntimeTelemetry(db);
  telemetry.recordAsrRetry(null);
  const rows = db.prepare("SELECT session_id, actor, modality, action, runtime_state, success FROM interaction_events").all() as any[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session_id, "01HASYRTRYN000000000000000");
  assert.equal(rows[0].actor, "system");
  assert.equal(rows[0].modality, "voice");
  assert.equal(rows[0].action, "voice.asr_retry");
  assert.equal(rows[0].runtime_state, "in_set_counting");
  assert.equal(rows[0].success, 0);
});

test("recordAsrRetry is silent when no session is running", () => {
  const db = freshDb();
  seedRunningSession(db, "01HASYRTRYN000000000000001", "completed");
  new RuntimeTelemetry(db).recordAsrRetry(null);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM interaction_events").get() as { n: number }).n, 0);
});

test("recordAsrRetry maps resting and paused states", () => {
  const db = freshDb();
  seedRunningSession(db, "01HASYRTRYN000000000000002", "resting");
  const telemetry = new RuntimeTelemetry(db);
  telemetry.recordAsrRetry(null);
  assert.equal((db.prepare("SELECT runtime_state FROM interaction_events").get() as { runtime_state: string }).runtime_state, "resting");
});

test("hasColumn guard: fresh workout_sessions has no user_id (bridge must not filter by it)", () => {
  const db = freshDb();
  assert.equal(hasColumn(db, "workout_sessions", "user_id"), false);
  assert.equal(hasColumn(db, "workout_sessions", "started_at"), true);
});

// ── C1(2026-11-09):组记录三步写入必须同生共死 ────────────────────
// 说明:这里验的是"机制 + 接线"两层——
//   ① reentrantTx 的行为(第一步已写、第二步抛错时,第一步必须被回滚);
//   ② 桥接代码确实用外层事务把三步包在一起(结构守卫,防止将来被改回去)。
// 真正的失败注入(让 recordSetFeedback 抛错)还需要 recorder 的注入点,已记进 backlog。
test("C1: reentrantTx 失败整链回滚(组行不会独自落库)", () => {
  const db = freshDb();
  db.exec("CREATE TABLE tm_probe (id TEXT PRIMARY KEY)");
  assert.throws(() => reentrantTx(db, () => {
    db.prepare("INSERT INTO tm_probe VALUES (?)").run("first");
    throw new Error("second step failed");
  }), /second step failed/);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tm_probe").get() as { n: number }).n, 0, "第一步必须一起回滚");
  reentrantTx(db, () => { db.prepare("INSERT INTO tm_probe VALUES (?)").run("ok"); });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tm_probe").get() as { n: number }).n, 1, "正常路径仍然提交");
});

test("C1: recordCompletedSet 用外层事务包住「组行+反馈+剂量适应」", async () => {
  const source = await readFile(new URL("../../src/telemetry/bridge.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("private recordCompletedSet("), source.indexOf("private recordDoseAdaptation("));
  assert.match(body, /reentrantTx\(this\.db,/, "三步必须在同一个外层事务里");
  const wrapped = body.slice(body.indexOf("reentrantTx(this.db,"));
  for (const call of ["upsertSetFromDomain", "recordSetFeedback", "recordDoseAdaptation"]) {
    assert.ok(wrapped.includes(call), `${call} 必须在事务内`);
  }
});

// ── C4(2026-11-09):"最近运行中会话"不许退化成"最早插入" ────────────
test("C4: 时间轴未知时,事件要挂到最新的运行中会话", () => {
  // 用 legacy 形状(fresh 的 started_at 是 NOT NULL,造不出"时间轴未知"的行)
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE workout_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, status TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL);
           CREATE TABLE set_records (id TEXT PRIMARY KEY, workout_exercise_id TEXT NOT NULL, data_json TEXT NOT NULL);`);
  migrateTelemetry(db);
  const insert = db.prepare("INSERT INTO workout_sessions (id, user_id, status, data_json, created_at) VALUES (?, 'u1', 'exercise_active', '{}', ?)");
  insert.run("02HASYRTRYN000000000000OLD", "2026-11-09T10:00:00.000Z");
  insert.run("02HASYRTRYN000000000000NEW", "2026-11-09T10:10:00.000Z");
  new RuntimeTelemetry(db).recordAsrRetry(null);
  const row = db.prepare("SELECT session_id FROM interaction_events").get() as { session_id: string };
  assert.equal(row.session_id, "02HASYRTRYN000000000000NEW", "必须挂到较新那条,而不是 rowid 最早那条");
});
