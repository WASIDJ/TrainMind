// v2 实体存储层(SessionStore):WorkoutSession(fresh)/ExerciseInstance/SetRecord 的创建与状态流转。
// 说明:冻结规格 §6 只冻结遥测接口;实体落库属于 §0 IN 的 schema/migration 范畴,
// 本模块是 v2 层实体写入的唯一入口,不触碰 legacy 域(src/core.ts)的对外 API。
// legacy 物理形状下:
//   - workout_sessions 由 legacy 域创建;v2 侧 createSession 需提供 userId(NOT NULL 列),
//     并写最小可解析 data_json('{"telemetryOnly":true}'),对 legacy 按 user_id 过滤的查询不可见
//   - set_records 补列后,v2 行的 workout_exercise_id = v2 exerciseInstanceId、data_json='{}',
//     legacy 侧按 json_extract($.sessionId) 过滤时自然排除(v2 行不携带 legacy sessionId)
import { DatabaseSync } from 'node:sqlite';
import { ulid } from './ids.ts';
import { reentrantTx } from './recorder.ts';
import { isLegacySchema } from './ddl.ts';
import { getRow, mapExerciseRow, mapSessionRow, mapSetRowOrNull } from './records.ts';
import type {
  ExerciseInstance, ExerciseInstanceStatus, IsoMs, SetRecord, SetRecordStatus,
  TrackingMetric, Ulid, WorkoutSession, WorkoutSessionStatus,
} from './types.ts';

export interface CreateSessionInput {
  plannedWorkoutId?: string | null;
  startedAt?: IsoMs;
  appVersion?: string;
  deviceModel?: string | null;
  osVersion?: string | null;
  /** legacy 物理形状必需(workout_sessions.user_id NOT NULL) */
  userId?: string;
  status?: WorkoutSessionStatus;
}

export interface CreateExerciseInstanceInput {
  sessionId: Ulid;
  exerciseId: string;
  orderIndex: number;
  trackingMetric: TrackingMetric;
}

export interface CreateSetRecordInput {
  exerciseInstanceId: Ulid;
  setNumber: number;
  status: SetRecordStatus;
  targetWeightKg?: number | null;
  targetRepsMin?: number | null;
  targetRepsMax?: number | null;
  targetDurationSeconds?: number | null;
  targetRestAfterSeconds?: number | null;
  startedAt?: IsoMs | null;
  completedAt?: IsoMs | null;
  actualReps?: number | null;
  actualDurationSeconds?: number | null;
  actualWeightKg?: number | null;
  actualRestAfterSeconds?: number | null;
}

const V2_SET_COLUMNS =
  'exercise_instance_id, set_number, target_weight_kg, target_reps_min, target_reps_max, ' +
  'target_duration_seconds, target_rest_after_seconds, actual_reps, actual_duration_seconds, ' +
  'actual_weight_kg, actual_rest_after_seconds, started_at, completed_at, status';

export class SessionStore {
  private readonly db: DatabaseSync;
  private readonly legacy: boolean;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.legacy = isLegacySchema(db);
  }

  get mode(): 'fresh' | 'legacy' { return this.legacy ? 'legacy' : 'fresh'; }

  createSession(input: CreateSessionInput): WorkoutSession {
    const id = ulid();
    const startedAt = input.startedAt ?? Date.now();
    const status = input.status ?? 'active';
    if (this.legacy) {
      if (!input.userId) {
        throw new Error('legacy 物理形状下 createSession 需要 userId(workout_sessions.user_id NOT NULL);域层会话请由 legacy 域创建后直接使用其 sessionId');
      }
      const dataJson = JSON.stringify({ schemaVersion: '1.2', sessionId: id, telemetryOnly: true, createdAt: new Date(startedAt).toISOString() });
      this.db.prepare(
        `INSERT INTO workout_sessions (id, user_id, status, data_json, created_at, planned_workout_id, started_at, ended_at, app_version, device_model, os_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      ).run(id, input.userId, status, dataJson, new Date(startedAt).toISOString(),
        input.plannedWorkoutId ?? null, startedAt, input.appVersion ?? 'unknown', input.deviceModel ?? null, input.osVersion ?? null);
    } else {
      this.db.prepare(
        `INSERT INTO workout_sessions (id, planned_workout_id, started_at, ended_at, status, app_version, device_model, os_version)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
      ).run(id, input.plannedWorkoutId ?? null, startedAt, status, input.appVersion ?? 'unknown', input.deviceModel ?? null, input.osVersion ?? null);
    }
    return this.getSession(id)!;
  }

  completeSession(sessionId: Ulid, status: WorkoutSessionStatus, endedAt: IsoMs): WorkoutSession {
    // legacy 形状:status 为新旧共享列;v2 值 'abandoned'/'interrupted' 不在 legacy 枚举中,
    // 对 legacy 查询仅表现为"非 active/非 completed",不影响其按 user_id 过滤的路径(见模块头注释)
    const r = this.db.prepare('UPDATE workout_sessions SET status = ?, ended_at = ? WHERE id = ?').run(status, endedAt, sessionId);
    if (Number(r.changes) !== 1) throw new Error(`workout session not found: ${sessionId}`);
    return this.getSession(sessionId)!;
  }

  getSession(sessionId: Ulid): WorkoutSession | null {
    const row = getRow(this.db, 'SELECT * FROM workout_sessions WHERE id = ?', sessionId);
    return row ? mapSessionRow(row) : null;
  }

  createExerciseInstance(input: CreateExerciseInstanceInput): ExerciseInstance {
    const id = ulid();
    this.db.prepare(
      'INSERT INTO exercise_instances (id, session_id, exercise_id, order_index, tracking_metric, status, substituted_by_instance_id) VALUES (?, ?, ?, ?, ?, ?, NULL)',
    ).run(id, input.sessionId, input.exerciseId, input.orderIndex, input.trackingMetric, 'pending');
    return this.getExerciseInstance(id)!;
  }

  getExerciseInstance(id: Ulid): ExerciseInstance | null {
    const row = getRow(this.db, 'SELECT * FROM exercise_instances WHERE id = ?', id);
    return row ? mapExerciseRow(row) : null;
  }

  setExerciseInstanceStatus(id: Ulid, status: ExerciseInstanceStatus): void {
    const r = this.db.prepare('UPDATE exercise_instances SET status = ? WHERE id = ?').run(status, id);
    if (Number(r.changes) !== 1) throw new Error(`exercise instance not found: ${id}`);
  }

  /**
   * 动作替换:旧实例标记 substituted 并指向新实例;新实例继承 session/orderIndex。
   * 与 AdaptationEvent(type='exercise_substitution')配套使用。
   */
  substituteExerciseInstance(oldInstanceId: Ulid, newExerciseId: string): { previous: ExerciseInstance; replacement: ExerciseInstance } {
    const old = this.getExerciseInstance(oldInstanceId);
    if (!old) throw new Error(`exercise instance not found: ${oldInstanceId}`);
    const newId = ulid();
    this.tx(() => {
      this.db.prepare(
        'INSERT INTO exercise_instances (id, session_id, exercise_id, order_index, tracking_metric, status, substituted_by_instance_id) VALUES (?, ?, ?, ?, ?, ?, NULL)',
      ).run(newId, old.sessionId, newExerciseId, old.orderIndex, old.trackingMetric, 'pending');
      this.db.prepare(
        "UPDATE exercise_instances SET status = 'substituted', substituted_by_instance_id = ? WHERE id = ?",
      ).run(newId, oldInstanceId);
    });
    return { previous: this.getExerciseInstance(oldInstanceId)!, replacement: this.getExerciseInstance(newId)! };
  }

  createSetRecord(input: CreateSetRecordInput): SetRecord {
    const id = ulid();
    const cols = [input.targetWeightKg ?? null, input.targetRepsMin ?? null, input.targetRepsMax ?? null,
      input.targetDurationSeconds ?? null, input.targetRestAfterSeconds ?? null,
      input.actualReps ?? null, input.actualDurationSeconds ?? null, input.actualWeightKg ?? null,
      input.actualRestAfterSeconds ?? null, input.startedAt ?? null, input.completedAt ?? null, input.status];
    if (this.legacy) {
      this.db.prepare(
        `INSERT INTO set_records (id, workout_exercise_id, data_json, ${V2_SET_COLUMNS}) VALUES (?, ?, '{}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, input.exerciseInstanceId, input.exerciseInstanceId, input.setNumber, ...cols);
    } else {
      this.db.prepare(
        `INSERT INTO set_records (id, ${V2_SET_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, input.exerciseInstanceId, input.setNumber, ...cols);
    }
    return this.getSetRecord(id)!;
  }

  getSetRecord(id: Ulid): SetRecord | null {
    const row = getRow(this.db, 'SELECT * FROM set_records WHERE id = ?', id);
    return row ? mapSetRowOrNull(row) : null;
  }

  /** 桥接层专用:更新 v2 SetRecord 的派生字段(rest 回填、状态修正);仅 v2 列,不触碰 legacy 列。 */
  updateSetRecordComputed(id: Ulid, fields: Partial<Record<'actualRestAfterSeconds' | 'actualReps' | 'actualWeightKg' | 'actualDurationSeconds' | 'startedAt' | 'completedAt' | 'status', number | string | null>>): void {
    const columns: Array<[string, string]> = [
      ['actualRestAfterSeconds', 'actual_rest_after_seconds'], ['actualReps', 'actual_reps'], ['actualWeightKg', 'actual_weight_kg'],
      ['actualDurationSeconds', 'actual_duration_seconds'], ['startedAt', 'started_at'], ['completedAt', 'completed_at'], ['status', 'status'],
    ];
    const sets: string[] = [], values: unknown[] = [];
    for (const [key, column] of columns) if (key in fields) { sets.push(`${column} = ?`); values.push(fields[key] ?? null); }
    if (!sets.length) return;
    const r = this.db.prepare(`UPDATE set_records SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    if (Number(r.changes) !== 1) throw new Error(`set record not found: ${id}`);
  }

  listSetRecords(exerciseInstanceId: Ulid): SetRecord[] {
    const rows = this.db.prepare('SELECT * FROM set_records WHERE exercise_instance_id = ? ORDER BY set_number').all(exerciseInstanceId) as Array<Record<string, unknown>>;
    // C8:未映射的 legacy 行不进 v2 读出口(否则会被读成"第 0 组、已跳过")
    return rows.map(mapSetRowOrNull).filter((x): x is SetRecord => x !== null);
  }

  private tx<T>(fn: () => T): T {
    return reentrantTx(this.db, fn);
  }
}
