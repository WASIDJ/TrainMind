// 规格书 §8 存储与迁移 — DDL 定义
// 两条路径:
//   fresh  : 全新安装,按规格 DDL 原样建表(IF NOT EXISTS 保证可重入)
//   legacy : 已有 TrainMind 库(workout_sessions/set_records 为 JSON-blob 形状)加法迁移:
//            新表照建 + 两张同名表 ALTER 补列(全部可空,旧行未知字段保持 NULL)
// 两种路径下,v2 遥测层读写的列集合完全一致(规格 §0:"不改既有对外 API 语义,只做加法迁移")。
import type { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 2;

/** 规格书 §8 原文 DDL(fresh 路径,加 IF NOT EXISTS 以满足"迁移可重入") */
export const FRESH_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS workout_sessions (
  id TEXT PRIMARY KEY, planned_workout_id TEXT, started_at INTEGER NOT NULL,
  ended_at INTEGER, status TEXT NOT NULL, app_version TEXT NOT NULL,
  device_model TEXT, os_version TEXT,
  next_event_seq INTEGER NOT NULL DEFAULT 1  -- Interaction/Adaptation 共享的事件序号分配器
)`,
  `CREATE TABLE IF NOT EXISTS exercise_instances (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES workout_sessions(id),
  exercise_id TEXT NOT NULL, order_index INTEGER NOT NULL,
  tracking_metric TEXT NOT NULL, status TEXT NOT NULL,
  substituted_by_instance_id TEXT
)`,
  `CREATE INDEX IF NOT EXISTS idx_exinst_session ON exercise_instances(session_id, order_index)`,
  `CREATE TABLE IF NOT EXISTS set_records (
  id TEXT PRIMARY KEY,
  exercise_instance_id TEXT NOT NULL REFERENCES exercise_instances(id),
  set_number INTEGER NOT NULL,
  target_weight_kg REAL, target_reps_min INTEGER, target_reps_max INTEGER,
  target_duration_seconds REAL, target_rest_after_seconds REAL,
  actual_reps INTEGER, actual_duration_seconds REAL,
  actual_weight_kg REAL, actual_rest_after_seconds REAL,
  started_at INTEGER, completed_at INTEGER, status TEXT NOT NULL,
  UNIQUE(exercise_instance_id, set_number)
)`,
  `CREATE TABLE IF NOT EXISTS set_feedbacks (
  id TEXT PRIMARY KEY, set_record_id TEXT NOT NULL REFERENCES set_records(id),
  difficulty TEXT, fatigue INTEGER, pain_json TEXT,
  source TEXT NOT NULL, transcript TEXT, interaction_event_id TEXT,
  captured_at INTEGER NOT NULL,
  UNIQUE(set_record_id)  -- 每组仅一条"已接受"反馈;重试过程在 interaction_events
)`,
  `CREATE TABLE IF NOT EXISTS interaction_events (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES workout_sessions(id),
  seq INTEGER NOT NULL, occurred_at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  modality TEXT NOT NULL, action TEXT NOT NULL, runtime_state TEXT NOT NULL,
  target_set_record_id TEXT, target_exercise_instance_id TEXT,
  intent TEXT, success INTEGER, latency_ms INTEGER,
  transcript TEXT, error_json TEXT,
  UNIQUE(session_id, seq)
)`,
  `CREATE INDEX IF NOT EXISTS idx_interact_session_time ON interaction_events(session_id, occurred_at)`,
  `CREATE TABLE IF NOT EXISTS adaptation_events (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES workout_sessions(id),
  seq INTEGER NOT NULL, occurred_at INTEGER NOT NULL,
  exercise_instance_id TEXT, set_record_id TEXT,
  type TEXT NOT NULL, deltas_json TEXT NOT NULL,
  triggered_by_json TEXT NOT NULL, reason_json TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0, applied_at INTEGER,
  UNIQUE(session_id, seq)
)`,
  `CREATE TABLE IF NOT EXISTS observer_records (
  session_id TEXT PRIMARY KEY REFERENCES workout_sessions(id),
  recorded_by TEXT NOT NULL, phone_pickup_count INTEGER NOT NULL,
  screen_glance_count INTEGER, observer_intervention_count INTEGER NOT NULL,
  pickups_json TEXT NOT NULL
)`,
];

/**
 * legacy 路径:已存在的 workout_sessions / set_records 补列。
 * 依据规格 §8"已有库:加法迁移(新表 + 旧表补列),旧 SetRecord 数据无损映射"。
 * 补列全部可空(旧数据该字段未知 → NULL,规格原则 3:null ≠ 0);
 * next_event_seq 带 DEFAULT 1,旧会话自动纳入分配器起始值。
 * set_records 的 (exercise_instance_id, set_number) 唯一性用部分唯一索引实现
 * (SQLite 的 ALTER TABLE 不能追加表级 UNIQUE 约束;WHERE 排除未映射旧行)。
 */
export const LEGACY_ALTER_WORKOUT_SESSIONS: readonly string[] = [
  'ALTER TABLE workout_sessions ADD COLUMN next_event_seq INTEGER NOT NULL DEFAULT 1',
  'ALTER TABLE workout_sessions ADD COLUMN planned_workout_id TEXT',
  'ALTER TABLE workout_sessions ADD COLUMN started_at INTEGER',
  'ALTER TABLE workout_sessions ADD COLUMN ended_at INTEGER',
  'ALTER TABLE workout_sessions ADD COLUMN app_version TEXT',
  'ALTER TABLE workout_sessions ADD COLUMN device_model TEXT',
  'ALTER TABLE workout_sessions ADD COLUMN os_version TEXT',
];

export const LEGACY_ALTER_SET_RECORDS: readonly string[] = [
  'ALTER TABLE set_records ADD COLUMN exercise_instance_id TEXT',
  'ALTER TABLE set_records ADD COLUMN set_number INTEGER',
  'ALTER TABLE set_records ADD COLUMN target_weight_kg REAL',
  'ALTER TABLE set_records ADD COLUMN target_reps_min INTEGER',
  'ALTER TABLE set_records ADD COLUMN target_reps_max INTEGER',
  'ALTER TABLE set_records ADD COLUMN target_duration_seconds REAL',
  'ALTER TABLE set_records ADD COLUMN target_rest_after_seconds REAL',
  'ALTER TABLE set_records ADD COLUMN actual_reps INTEGER',
  'ALTER TABLE set_records ADD COLUMN actual_duration_seconds REAL',
  'ALTER TABLE set_records ADD COLUMN actual_weight_kg REAL',
  'ALTER TABLE set_records ADD COLUMN actual_rest_after_seconds REAL',
  'ALTER TABLE set_records ADD COLUMN started_at INTEGER',
  'ALTER TABLE set_records ADD COLUMN completed_at INTEGER',
  'ALTER TABLE set_records ADD COLUMN status TEXT',
];

export const LEGACY_SET_RECORDS_UNIQUE_INDEX =
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_set_records_instance_set ' +
  'ON set_records(exercise_instance_id, set_number) WHERE exercise_instance_id IS NOT NULL';

/** legacy 检测:workout_sessions 是否为旧 JSON-blob 形状(含 data_json 列) */
export function isLegacySchema(db: DatabaseSync): boolean {
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='workout_sessions'",
  ).get() as { n: number };
  if (row.n === 0) return false;
  const cols = db.prepare('PRAGMA table_info(workout_sessions)').all() as Array<{ name: string }>;
  return cols.some(c => c.name === 'data_json');
}

/** 列是否已存在(保证 ALTER 可重入) */
export function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some(c => c.name === column);
}
