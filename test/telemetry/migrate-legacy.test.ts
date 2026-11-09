// 规格 §8 — 已有库加法迁移:legacy JSON-blob 形状无损 + v2 层可用
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateTelemetry, SessionStore, SqliteTelemetryRecorder, isLegacySchema } from "../../src/telemetry/index.ts";
import { interaction } from "./helpers.ts";

function legacyShapeDb() {
  const dir = mkdtempSync(join(tmpdir(), "trainmind-legacy-"));
  const path = join(dir, "t.sqlite");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL;");
  // 复刻 server.ts 的 JSON-blob 引导(两张碰撞表)
  db.exec(`
    CREATE TABLE IF NOT EXISTS workout_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, status TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS set_records (id TEXT PRIMARY KEY, workout_exercise_id TEXT NOT NULL, data_json TEXT NOT NULL);
  `);
  // 旧数据:一个已完成会话 + 两组记录(legacy SetRecord JSON 形状)
  db.prepare("INSERT INTO workout_sessions VALUES (?, ?, ?, ?, ?)").run(
    "legacy-sess-1", "demo-user", "completed",
    JSON.stringify({ schemaVersion: "1.2", sessionId: "legacy-sess-1", createdAt: "2026-10-01T10:00:00.000Z", runtime: { completedAt: "2026-10-01T10:32:00.000Z" } }),
    "2026-10-01T10:00:00.000Z",
  );
  db.prepare("INSERT INTO set_records VALUES (?, ?, ?)").run(
    "legacy-set-1", "legacy-we-1",
    JSON.stringify({ id: "legacy-set-1", sessionId: "legacy-sess-1", workoutExerciseId: "legacy-we-1", exerciseId: "barbell-squat", setNumber: 1, targetWeight: 80, targetReps: "8", actualReps: 8, actualWeight: 80, completedAt: "2026-10-01T10:05:00.000Z", feedback: "hard", pain: false }),
  );
  db.prepare("INSERT INTO set_records VALUES (?, ?, ?)").run(
    "legacy-set-2", "legacy-we-1",
    JSON.stringify({ id: "legacy-set-2", sessionId: "legacy-sess-1", workoutExerciseId: "legacy-we-1", exerciseId: "barbell-squat", setNumber: 2, targetReps: "8" }), // 未完成:无 actual
  );
  return { db, path, dir };
}

test("legacy 加法迁移:补列 + 新表 + 无损映射 + 旧列内容不变 + 可重入", () => {
  const { db, path, dir } = legacyShapeDb();
  try {
    assert.equal(isLegacySchema(db), true);
    const r1 = migrateTelemetry(db);
    assert.equal(r1.mode, "legacy");
    assert.ok(r1.applied.length > 0);

    // 新表存在
    for (const tbl of ["exercise_instances", "set_feedbacks", "interaction_events", "adaptation_events", "observer_records"]) {
      const n = (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?").get(tbl) as { n: number }).n;
      assert.equal(n, 1, `${tbl} 应被创建`);
    }
    // 补列存在
    const wsCols = (db.prepare("PRAGMA table_info(workout_sessions)").all() as Array<{ name: string }>).map(c => c.name);
    assert.ok(wsCols.includes("next_event_seq"));
    const srCols = (db.prepare("PRAGMA table_info(set_records)").all() as Array<{ name: string }>).map(c => c.name);
    for (const c of ["exercise_instance_id", "set_number", "target_weight_kg", "actual_reps", "actual_weight_kg", "completed_at", "status"]) {
      assert.ok(srCols.includes(c), `set_records 应补列 ${c}`);
    }
    // user_version
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);

    // 旧 set_records 无损映射:legacy-set-1 数值/时间被回填,JSON 原文不动
    const s1 = db.prepare("SELECT * FROM set_records WHERE id='legacy-set-1'").get() as Record<string, unknown>;
    assert.equal(s1.set_number, 1);
    assert.equal(s1.target_weight_kg, 80);
    assert.equal(s1.actual_reps, 8);
    assert.equal(s1.actual_weight_kg, 80);
    assert.equal(s1.completed_at, Date.parse("2026-10-01T10:05:00.000Z"));
    assert.equal(s1.status, "completed");
    assert.equal(s1.exercise_instance_id, null); // 无法安全映射 → null(unknown)
    assert.ok(String(s1.data_json).includes("barbell-squat")); // 旧 JSON 原样保留
    // legacy-set-2 无 actualReps → status 保持 NULL(unknown ≠ skipped)
    const s2 = db.prepare("SELECT * FROM set_records WHERE id='legacy-set-2'").get() as Record<string, unknown>;
    assert.equal(s2.status, null);
    assert.equal(s2.actual_reps, null);

    // 可重入:再次迁移不报错、不重复改动
    const before = (db.prepare("SELECT COUNT(*) AS n FROM set_records WHERE set_number IS NOT NULL").get() as { n: number }).n;
    const r2 = migrateTelemetry(db);
    assert.equal(r2.mode, "legacy");
    const after = (db.prepare("SELECT COUNT(*) AS n FROM set_records WHERE set_number IS NOT NULL").get() as { n: number }).n;
    assert.equal(before, after);

    // v2 层在 legacy 形状上可用:分配器、事件写入、summary(时长从 data_json 解析)
    const rec = new SqliteTelemetryRecorder(db);
    rec.recordInteraction(interaction("legacy-sess-1", { action: "voice.command.query", success: true, occurredAt: 1 }));
    const summary = rec.computeSummary("legacy-sess-1");
    assert.equal(summary.voiceCommandCount, 1);
    assert.equal(summary.sessionDurationMs, 32 * 60 * 1000); // 10:00 → 10:32

    // v2 实体写入 legacy set_records:部分唯一索引拒绝重复 (instance, set_number)
    const store = new SessionStore(db);
    assert.equal(store.mode, "legacy");
    const ex = store.createExerciseInstance({ sessionId: "legacy-sess-1", exerciseId: "barbell-squat", orderIndex: 0, trackingMetric: "reps" });
    const set = store.createSetRecord({ exerciseInstanceId: ex.id, setNumber: 1, status: "completed", targetWeightKg: 75 });
    assert.throws(
      () => store.createSetRecord({ exerciseInstanceId: ex.id, setNumber: 1, status: "completed" }),
      /UNIQUE constraint failed/,
    );
    // v2 行对 legacy 读取路径不可见(json_extract($.sessionId) 无匹配)
    const legacyVisible = (db.prepare(
      "SELECT COUNT(*) AS n FROM set_records WHERE json_extract(data_json, '$.sessionId') = 'legacy-sess-1'",
    ).get() as { n: number }).n;
    assert.equal(legacyVisible, 2); // 仍是旧的两条,v2 行(data_json='{}')被排除

    // legacy 位置参数 INSERT 修复后的写入路径(server.ts persistSet 同形)
    db.prepare("INSERT INTO set_records (id, workout_exercise_id, data_json) VALUES (?, ?, ?)").run(
      "legacy-set-3", "legacy-we-1", JSON.stringify({ id: "legacy-set-3", sessionId: "legacy-sess-1", setNumber: 3, actualReps: 7, completedAt: "2026-10-01T10:20:00.000Z" }),
    );
    const s3 = db.prepare("SELECT set_number, actual_reps, status FROM set_records WHERE id='legacy-set-3'").get() as Record<string, unknown>;
    assert.equal(s3.set_number, null); // 尚未回填(下次迁移启动时映射)
    migrateTelemetry(db); // 再次迁移 → 新旧行继续被映射
    const s3b = db.prepare("SELECT set_number, actual_reps, status FROM set_records WHERE id='legacy-set-3'").get() as Record<string, unknown>;
    assert.equal(s3b.set_number, 3);
    assert.equal(s3b.actual_reps, 7);
    assert.equal(s3b.status, "completed");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fresh 迁移:全新库按规格 DDL 建表,可重入", () => {
  const dir = mkdtempSync(join(tmpdir(), "trainmind-fresh-"));
  const path = join(dir, "t.sqlite");
  const db = new DatabaseSync(path);
  try {
    assert.equal(isLegacySchema(db), false);
    const r = migrateTelemetry(db);
    assert.equal(r.mode, "fresh");
    assert.equal(r.backfilledSetRecords, 0);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map(x => x.name);
    for (const t of ["workout_sessions", "exercise_instances", "set_records", "set_feedbacks", "interaction_events", "adaptation_events", "observer_records"]) {
      assert.ok(tables.includes(t));
    }
    migrateTelemetry(db); // 重入
    // fresh 表带内联 UNIQUE(exercise_instance_id, set_number)
    const store = new SessionStore(db);
    const session = store.createSession({});
    const ex = store.createExerciseInstance({ sessionId: session.id, exerciseId: "plank", orderIndex: 0, trackingMetric: "hold" });
    store.createSetRecord({ exerciseInstanceId: ex.id, setNumber: 1, status: "completed" });
    assert.throws(() => store.createSetRecord({ exerciseInstanceId: ex.id, setNumber: 1, status: "completed" }));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("真实 trainmind.db 副本:迁移成功且旧数据完整", () => {
  const dir = mkdtempSync(join(tmpdir(), "trainmind-real-"));
  const path = join(dir, "trainmind-copy.db");
  copyFileSync(new URL("../../trainmind.db", import.meta.url).pathname, path);
  const db = new DatabaseSync(path);
  try {
    const sessionsBefore = (db.prepare("SELECT COUNT(*) AS n FROM workout_sessions").get() as { n: number }).n;
    const setsBefore = (db.prepare("SELECT COUNT(*) AS n FROM set_records").get() as { n: number }).n;
    // 真实库已随 server 启动迁移过且在持续承接新会话(legacy 行与 v2 行并存):
    // 断言改为状态无关 —— 本次迁移应恰好映射"此前未被映射的 legacy 行"
    const unmappedBefore = (db.prepare("SELECT COUNT(*) AS n FROM set_records WHERE exercise_instance_id IS NULL AND set_number IS NULL").get() as { n: number }).n;
    const r = migrateTelemetry(db);
    assert.equal(r.mode, "legacy");
    assert.equal(r.backfilledSetRecords, unmappedBefore); // 旧 set 行无损映射(状态无关)
    const mappedBefore = (db.prepare("SELECT COUNT(*) AS n FROM set_records WHERE set_number IS NOT NULL").get() as { n: number }).n;
    const sessionsAfter = (db.prepare("SELECT COUNT(*) AS n FROM workout_sessions").get() as { n: number }).n;
    const setsAfter = (db.prepare("SELECT COUNT(*) AS n FROM set_records").get() as { n: number }).n;
    assert.equal(sessionsBefore, sessionsAfter);
    assert.equal(setsBefore, setsAfter);
    // 旧行 data_json 未被改写(抽查一行)
    const row = db.prepare("SELECT data_json FROM set_records LIMIT 1").get() as { data_json: string };
    assert.ok(row && row.data_json.startsWith("{"));
    const r2 = migrateTelemetry(db); // 重入安全
    assert.equal(r2.mode, "legacy");
    // 已映射(set_number 非空)的行数不再增长
    const mappedAfter = (db.prepare("SELECT COUNT(*) AS n FROM set_records WHERE set_number IS NOT NULL").get() as { n: number }).n;
    assert.equal(mappedAfter, mappedBefore);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── C3(2026-11-09):legacy 会话时间轴回填 ──────────────────────────
test("C3: legacy 会话的 started_at / ended_at 从 data_json 派生回填(幂等)", () => {
  const { db, dir } = legacyShapeDb();
  try {
    const colsBefore = (db.prepare("PRAGMA table_info(workout_sessions)").all() as Array<{ name: string }>).map(c => c.name);
    assert.equal(colsBefore.includes("started_at"), false, "迁移前 legacy 表连时间轴列都没有");
    const r1 = migrateTelemetry(db);
    assert.equal(r1.backfilledSessions, 1);
    const row = db.prepare("SELECT started_at, ended_at FROM workout_sessions WHERE id = 'legacy-sess-1'").get() as { started_at: number; ended_at: number };
    assert.equal(row.started_at, Date.parse("2026-10-01T10:00:00.000Z"), "从 data_json.createdAt 派生");
    assert.equal(row.ended_at, Date.parse("2026-10-01T10:32:00.000Z"), "从 runtime.completedAt 派生");
    assert.equal(migrateTelemetry(db).backfilledSessions, 0, "幂等:再跑一次不再回填");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── C2(2026-11-09):迁移必须整体成功或整体不动 ────────────────────
test("C2: 建唯一索引前先查重复;失败整体回滚,不留半迁移库", () => {
  const { db, dir } = legacyShapeDb();
  try {
    // 造两条 v2 列相同 (exercise_instance_id, set_number) 的行 → 唯一索引必冲突
    db.exec("ALTER TABLE set_records ADD COLUMN exercise_instance_id TEXT; ALTER TABLE set_records ADD COLUMN set_number INTEGER;");
    const dup = db.prepare("INSERT INTO set_records (id, workout_exercise_id, data_json, exercise_instance_id, set_number) VALUES (?, 'we', '{}', 'inst-1', 1)");
    dup.run("dup-1"); dup.run("dup-2");
    assert.throws(() => migrateTelemetry(db), /重复的 \(exercise_instance_id, set_number\)/);
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 0, "失败的迁移不许推进版本号");
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(x => x.name);
    assert.equal(tables.includes("interaction_events"), false, "失败后不许留下半迁移的新表");
    assert.equal(db.prepare("PRAGMA table_info(set_records)").all().some((c: any) => c.name === "target_reps_min"), false, "失败后不许留下半迁移的新列");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C2: 数据库版本高于程序支持时拒绝打开(旧代码不碰新库)", () => {
  const dir = mkdtempSync(join(tmpdir(), "trainmind-ver-"));
  const db = new DatabaseSync(join(dir, "t.sqlite"));
  try {
    db.exec("PRAGMA user_version = 99");
    assert.throws(() => migrateTelemetry(db), /结构版本 99 高于本程序支持的/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
