// 迁移入口:规格 §8 — 全新安装 / 已有库加法迁移,可重入,失败不破坏旧数据
import type { DatabaseSync } from 'node:sqlite';
import {
  FRESH_DDL,
  LEGACY_ALTER_SET_RECORDS,
  LEGACY_ALTER_WORKOUT_SESSIONS,
  LEGACY_SET_RECORDS_UNIQUE_INDEX,
  SCHEMA_VERSION,
  hasColumn,
  isLegacySchema,
} from './ddl.ts';

/** C10(2026-11-09):legacy 形状需要新建的 v2 表(按表名显式列出,见 migrateInner)。 */
const LEGACY_NEW_TABLE_NAMES = ['exercise_instances', 'set_feedbacks', 'interaction_events', 'adaptation_events', 'observer_records'] as const;

export interface MigrationResult {
  mode: 'fresh' | 'legacy';
  /** 本次执行新应用的语句(重入时为空数组) */
  applied: string[];
  backfilledSetRecords: number;
  /** C3:本次回填了时间轴的 legacy 会话数 */
  backfilledSessions: number;
  schemaVersion: number;
}

/**
 * 迁移(可重入):
 * - fresh(空库 / 无 workout_sessions):按规格 DDL 建全部 v2 表
 * - legacy(已有 JSON-blob 形状的 workout_sessions/set_records):
 *     新表照建 + 两张同名表补列 + 部分唯一索引 + 旧 set_records 保守无损映射
 * - PRAGMA user_version = 2
 *
 * legacy 模式下绝不修改旧列内容;"旧 SetRecord 数据无损映射"只回填可从 data_json
 * 无歧义派生的数值/时间字段(status 仅在 actualReps 存在时记 'completed',
 * 其余保持 NULL = unknown,规格原则 3:null ≠ 0)。
 */
export function migrateTelemetry(db: DatabaseSync): MigrationResult {
  // C2(2026-11-09):整体一个 BEGIN IMMEDIATE 事务 + user_version 闸。
  // 旧实现逐条 autocommit、最后才写版本号:中途失败(例如唯一索引撞到重复行)会留下
  // "列加了、索引没建、版本号仍是 0"的半迁移库,而 server.ts 在 try 之外调用它 →
  // 启动崩溃循环且没有任何版本号能说明"这是半迁移库";两进程同时启动还会并发 ALTER。
  // 版本号高于本程序支持时拒绝打开(旧代码不许碰新库)。
  const current = readUserVersion(db);
  if (current > SCHEMA_VERSION) {
    throw new Error(`数据库结构版本 ${current} 高于本程序支持的 ${SCHEMA_VERSION}；请升级 TrainMind，不要用旧版本打开新库。`);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = migrateInner(db);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* 连接已回滚 */ }
    throw error;
  }
}

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

/** 真正的迁移步骤(在 C2 的事务里跑;保持原语义)。 */
function migrateInner(db: DatabaseSync): MigrationResult {
  const applied: string[] = [];
  const legacy = isLegacySchema(db);

  if (!legacy) {
    for (const stmt of FRESH_DDL) {
      const before = tableCount(db);
      db.exec(stmt);
      if (tableCount(db) > before || /CREATE INDEX/i.test(stmt)) applied.push(stmt);
    }
  } else {
    // C10(2026-11-09):legacy 要建的新表按表名显式列出,不再用"首行正则"切 FRESH_DDL ——
    // 那种写法在 FRESH_DDL 里新增"首行含 set_records 的索引"时会静默漏建(只有性能症状、无报错)。
    // 同时只把"这次真建出来的表"记进 applied,兑现"重入时为空数组"的契约。
    for (const name of LEGACY_NEW_TABLE_NAMES) {
      const stmt = FRESH_DDL.find(s => new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${name}\\b`, 'i').test(s));
      if (!stmt) throw new Error(`FRESH_DDL 里找不到表 ${name}；迁移定义不完整。`);
      const existed = db.prepare("SELECT 1 AS n FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
      db.exec(stmt);
      if (!existed) applied.push(stmt);
    }
    // 同名表补列(逐列判断,保证重入安全)
    for (const stmt of LEGACY_ALTER_WORKOUT_SESSIONS) {
      const col = stmt.match(/ADD COLUMN (\w+)/)?.[1];
      if (col && !hasColumn(db, 'workout_sessions', col)) { db.exec(stmt); applied.push(stmt); }
    }
    for (const stmt of LEGACY_ALTER_SET_RECORDS) {
      const col = stmt.match(/ADD COLUMN (\w+)/)?.[1];
      if (col && !hasColumn(db, 'set_records', col)) { db.exec(stmt); applied.push(stmt); }
    }
    // 建唯一索引前先看有没有重复,给出可读报错(而不是裸的 constraint failed)
    const duplicates = db.prepare(
      `SELECT COUNT(*) AS n FROM (SELECT exercise_instance_id, set_number FROM set_records
       WHERE exercise_instance_id IS NOT NULL AND set_number IS NOT NULL
       GROUP BY exercise_instance_id, set_number HAVING COUNT(*) > 1)`,
    ).get() as { n: number };
    if (duplicates.n > 0) throw new Error(`set_records 有 ${duplicates.n} 组重复的 (exercise_instance_id, set_number)，无法建立唯一索引；请先修数据再启动。`);
    // C10(2026-11-09):只有"这次真的建了索引"才算 applied,否则每次重启都谎报做了迁移。
    const indexName = LEGACY_SET_RECORDS_UNIQUE_INDEX.match(/INDEX IF NOT EXISTS\s+(\w+)/i)?.[1];
    const indexExisted = indexName ? db.prepare("SELECT 1 AS n FROM sqlite_master WHERE type='index' AND name=?").get(indexName) !== undefined : false;
    db.exec(LEGACY_SET_RECORDS_UNIQUE_INDEX);
    if (!indexExisted) applied.push(LEGACY_SET_RECORDS_UNIQUE_INDEX);
  }

  const backfilled = legacy ? backfillLegacySetRecords(db) : 0;
  const backfilledSessions = legacy ? backfillLegacySessions(db) : 0;
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return { mode: legacy ? 'legacy' : 'fresh', applied, backfilledSetRecords: backfilled, backfilledSessions, schemaVersion: SCHEMA_VERSION };
}

function tableCount(db: DatabaseSync): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get() as { n: number }).n;
}

/**
 * 旧 set_records 无损映射(仅 legacy 模式):
 * 条件 — v2 列完全未触碰(exercise_instance_id IS NULL AND set_number IS NULL),
 * 保证不会覆盖 v2 新行,且天然幂等。
 */
function backfillLegacySetRecords(db: DatabaseSync): number {
  const rows = db.prepare(
    'SELECT id, data_json FROM set_records WHERE exercise_instance_id IS NULL AND set_number IS NULL',
  ).all() as Array<{ id: string; data_json: string }>;
  let n = 0;
  const upd = db.prepare(
    `UPDATE set_records SET set_number=?, target_weight_kg=?, target_reps_min=?, target_reps_max=?,
     actual_reps=?, actual_duration_seconds=?, actual_weight_kg=?, completed_at=?, status=?
     WHERE id=?`,
  );
  for (const row of rows) {
    let d: any;
    try { d = JSON.parse(row.data_json); } catch { continue; }
    if (d === null || typeof d !== 'object') continue;
    const reps = numOrNullOrInt(d.actualReps);
    const status = reps !== null ? 'completed' : null; // 有实际次数→完成;否则 unknown(NULL)
    upd.run(
      intOrNull(d.setNumber),
      numOrNull(d.targetWeight),
      intOrNull(d.targetRepsMin),
      intOrNull(d.targetRepsMax),
      reps,
      numOrNull(d.actualDurationSeconds),
      numOrNull(d.actualWeight),
      isoToMsOrNull(d.completedAt),
      status,
      row.id,
    );
    n++;
  }
  return n;
}

/**
 * C3(2026-11-09):legacy 会话时间轴回填。
 *
 * 旧迁移只回填 set_records,workout_sessions 的 started_at/ended_at 一直是 NULL
 * (活库 66/66),于是 v2 侧"会话时间轴"整列不可用,只能每次解析 data_json 兜底;
 * 任何 ORDER BY started_at / 按时间窗的统计都退化。
 * 幂等:只处理 started_at IS NULL 的行;派生不出来就留 NULL(不编时间)。
 */
function backfillLegacySessions(db: DatabaseSync): number {
  // fresh 形状没有 data_json 列(域会话只存在 legacy 形状);没有就跳过。
  if (!hasColumn(db, 'workout_sessions', 'data_json')) return 0;
  if (!hasColumn(db, 'workout_sessions', 'started_at')) return 0;
  const rows = db.prepare('SELECT id, data_json FROM workout_sessions WHERE started_at IS NULL').all() as Array<{ id: string; data_json: string }>;
  const upd = db.prepare('UPDATE workout_sessions SET started_at=?, ended_at=? WHERE id=?');
  let n = 0;
  for (const row of rows) {
    let d: any;
    try { d = JSON.parse(row.data_json); } catch { continue; }
    if (d === null || typeof d !== 'object') continue;
    const started = isoToMsOrNull(d.createdAt) ?? isoToMsOrNull(d.runtime?.startedAt);
    if (started === null) continue;
    upd.run(started, isoToMsOrNull(d.runtime?.completedAt) ?? isoToMsOrNull(d.completedAt), row.id);
    n++;
  }
  return n;
}

function numOrNull(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}
function intOrNull(v: unknown): number | null {
  const n = numOrNull(v);
  return n === null ? null : Math.trunc(n);
}
function numOrNullOrInt(v: unknown): number | null { return numOrNull(v); }
function isoToMsOrNull(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
