import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateTelemetry, SessionStore, SqliteTelemetryRecorder } from "../../src/telemetry/index.ts";
import type { InteractionEvent, Ulid } from "../../src/telemetry/types.ts";

export interface TestDb {
  db: DatabaseSync;
  path: string;
  cleanup: () => void;
}

/** fresh 物理形状(规格 DDL 原样) */
export function freshDb(): TestDb {
  const dir = mkdtempSync(join(tmpdir(), "trainmind-tel-"));
  const path = join(dir, "t.sqlite");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
  migrateTelemetry(db);
  return { db, path, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/**
 * legacy 物理形状:复刻 server.ts 的 JSON-blob 引导(仅两张碰撞表 + 最小列),
 * 用于验证加法迁移与旧读取路径共存。
 */
export function legacyDb(): TestDb {
  const dir = mkdtempSync(join(tmpdir(), "trainmind-tel-legacy-"));
  const path = join(dir, "t.sqlite");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS workout_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, status TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS set_records (id TEXT PRIMARY KEY, workout_exercise_id TEXT NOT NULL, data_json TEXT NOT NULL);
  `);
  migrateTelemetry(db);
  return { db, path, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

export interface Fixture {
  store: SessionStore;
  recorder: SqliteTelemetryRecorder;
  sessionId: Ulid;
}

export function setupSession(t: TestDb, startedAt = 1_700_000_000_000): Fixture {
  const store = new SessionStore(t.db);
  const session = store.createSession({ plannedWorkoutId: "wp-test", startedAt, appVersion: "test-1.0.1" });
  return { store, recorder: new SqliteTelemetryRecorder(t.db), sessionId: session.id };
}

/** InteractionEvent 输入工厂(仅填默认值;计数语义由调用方用 action/success 控制) */
export function interaction(
  sessionId: Ulid,
  overrides: Partial<Omit<InteractionEvent, "id" | "seq">> = {},
): Omit<InteractionEvent, "id" | "seq"> {
  return {
    sessionId,
    occurredAt: Date.now(),
    actor: "user",
    modality: "voice",
    action: "voice.command.query",
    runtimeState: "post_set",
    targetSetRecordId: null,
    targetExerciseInstanceId: null,
    intent: null,
    success: null,
    latencyMs: null,
    transcript: null,
    error: null,
    ...overrides,
  };
}
