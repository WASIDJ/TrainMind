#!/usr/bin/env node
// 投资人演示数据（2026-11-09）：给一个干净、能讲故事的演示用户，不碰真实账号。
//
// 为什么需要它：空账号讲不了"进步""关系""课程章节"；而现有 demo-user 里混着 30 场自动化探针，
// 现场翻记录会翻出 smoke-xxx / planprobe 这类脏数据。所以单独造一个 user：
//   - 3 周连续训练（每周 2 场），实测次数 8 → 10 → 12（counted，能拿来讲"我现在真能多做 4 个"）
//   - 一个 4 周课程，已练 6/12 场（讲"第 3 周 · 加深 · 已完成 6/12"）
//   - dataOrigin 缺省 `demo`；要拿去演示实验看板时显式 TRAINMIND_DEMO_AS_HUMAN=1（见下）
//
// 用法（建议先停服务）：
//   node tools/demo-seed.ts               # dry-run，只报告
//   TRAINMIND_APPLY=1 node tools/demo-seed.ts   # 写入（先 VACUUM INTO 备份，再单一事务）
//   TRAINMIND_DEMO_USER=investor-a ...          # 换演示用户名
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { completeRest, completeWarmup, createExperimentRecord, generateWorkout, markSetComplete, startWorkout, submitSetFeedback, type SessionContext, type WorkoutSession } from "../src/core.ts";
import { buildProgram, recordCompletion, type Program } from "../src/program.ts";

// 2026-11-09 复核 Medium-2：此前这里写死 "human"，违反 D24 自己的原则 ——
// 演示用的 6 场是**合成**数据，却混进 `/api/experiment?dataOrigin=human`（18 条里 6 条是假的），
// 此后任何按 human 口径做的分析都掺了 1/3 假数据。
// 现在缺省标 demo（诚实）；演示当场要看到板有内容时，由 tools/demo-ready.sh 传
// TRAINMIND_DEMO_AS_HUMAN=1 显式升格 —— 有意为之的开关，而不是藏起来的硬编码。
const seededOrigin = () => (process.env.TRAINMIND_DEMO_AS_HUMAN === "1" ? "human" : "demo") as "human" | "demo";
const dbPath = process.env.TRAINMIND_DB ?? fileURLToPath(new URL("../trainmind.db", import.meta.url));
const apply = process.env.TRAINMIND_APPLY === "1";
const userId = process.env.TRAINMIND_DEMO_USER ?? "demo-investor";
const DAY = 86_400_000;

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 5000");

const iso = (ms: number) => new Date(ms).toISOString();

// ── 1. 造 6 场已完成训练（3 周 × 2 场），实测次数 8/10/12 ──
const context: SessionContext = {
  userId, rawInput: "我在家，有25分钟，徒手自重，想练全身。", availableDurationMinutes: 25, durationMinutes: 25,
  environment: "home", fatigue: "low", recoveryState: "normal", experienceLevel: "intermediate",
  availableEquipmentIds: ["bodyweight"], soreness: [], restrictions: [],
  environmentContext: { type: "home" }, goalContext: { type: "general", priority: null },
  recovery: { overall: "normal", soreness: [] },
  constraints: { avoidExercises: [], avoidMovements: [], noJumping: false, noiseSensitive: false },
  preferences: { requestedExercises: [], excludedExercises: [] },
  painSignals: [], previousTraining: { status: "unknown", areas: [] },
  missingCriticalFields: [], fieldEvidence: {},
};

type Seeded = { session: WorkoutSession; record: any; sets: any[] };
const seeded: Seeded[] = [];

// 6 个不同自然日:同一天两场会被 relationship 算成"1 次训练",故事就讲不清了。
// 天数:14/11 天前(第 1 周)、7/4 天前(第 2 周)、昨天与今天(本周)。
const PLAN: Array<{ daysAgo: number; reps: number }> = [
  { daysAgo: 14, reps: 8 }, { daysAgo: 11, reps: 8 },
  { daysAgo: 7, reps: 10 }, { daysAgo: 4, reps: 10 },
  { daysAgo: 1, reps: 12 }, { daysAgo: 0, reps: 12 },
];
const todayStart = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); })();
for (const plan of PLAN) {
    const startMs = plan.daysAgo === 0 ? Math.max(todayStart + 1800_000, Date.now() - 3 * 3600_000) : Date.now() - plan.daysAgo * DAY;
    const reps = plan.reps;
    const session = generateWorkout({ ...context });
    session.sessionId = randomUUID();
    session.userId = userId;
    // 2026-11-11 审查：原来每场只留 1 个动作，记录页于是显示"1 动作 · 100%"，
    // 客户一眼就看出不是真训练。真实计划是 4-6 个动作，这里保留 4 个（每个 1-2 组），
    // 并让整场走完（4 个动作 × 各自的组，最后 completeRest 收尾），记录页才是真实结构。
    const kept = session.exercises.slice(0, 4).map((x, i) => ({
      ...x,
      // 第一个动作 2 组（体现"做得起来"），其余各 1 组，总组数控制在 5 组
      sets: i === 0 ? 2 : 1,
      completedSets: 0,
      targetReps: "8-12",
      executionStatus: i === 0 ? "active" : "pending",
    }));
    session.exercises = kept;
    session.experience = { ...(session.experience ?? { mode: "minimal", initialMode: "minimal", experimentGroup: "minimal", topic: "history", talkativeness: "medium", enabled: false, queue: [], currentIndex: 0, currentOffsetSeconds: 0, playback: "idle", contentSkipCount: 0, contentDisabled: false, events: [] }), dataOrigin: seededOrigin() } as never;

    startWorkout(session, iso(startMs));
    if (session.status === "warming_up") completeWarmup(session, iso(startMs + 120_000));
    const sets: any[] = [];
    let cursor = startMs + 180_000;
    // 按真实状态机走完整场：结组 → 休息 → 下一个动作，直到没有动作可做。
    // 原来写死 3 组，只对"1 个动作 3 组"成立；现在动作数变了，循环条件也要跟着走。
    for (let guard = 0; guard < 30 && session.status !== "completed"; guard++) {
      if (session.status === "exercise_active") { markSetComplete(session, iso(cursor)); cursor += 60_000; continue; }
      if (["set_feedback", "resting"].includes(session.status)) {
        const saved = submitSetFeedback(session, { feedback: "right", actualReps: reps, actualRepsSource: "counted", rir: 2 }, iso(cursor));
        sets.push(saved.record);
        cursor += 90_000;
        if (session.status === "resting") { completeRest(session, iso(cursor)); cursor += 30_000; }
        continue;
      }
      if (session.status === "warming_up") { completeWarmup(session, iso(cursor)); continue; }
      break;
    }
    session.status = "completed";
    session.runtime.completedAt ??= iso(cursor);
    session.runtime.activeWorkoutMs = Math.max(session.runtime.activeWorkoutMs ?? 0, 25 * 60_000);
    const record = createExperimentRecord(session, {}, []);
    seeded.push({ session, record, sets });
}

// ── 2. 造一个 4 周课程，把前 6 场记成已完成 ──
let program: Program = buildProgram({
  programId: `demo-program-${userId}`, userId, goal: "想练全身",
  weeks: 4, sessionsPerWeek: 3, environment: "home", targetMinutes: 25, equipment: ["bodyweight"],
});
for (const item of seeded) {
  const next = program.sessions[program.completions.length];
  if (!next) break;
  program = recordCompletion(program, {
    programSessionId: next.id, sessionId: item.session.sessionId,
    completedAt: item.session.runtime.completedAt!, weekNumber: next.weekNumber, sessionNumber: next.sessionNumber,
  });
}

// ── 3. 报告 ──
const rows = seeded.map(x => ({ id: x.session.sessionId, at: x.session.runtime.completedAt!, reps: x.sets[0]?.actualReps ?? 0, sets: x.sets.length }));
console.log(`演示用户: ${userId}`);
console.log(`训练场次: ${rows.length} 场（3 周 × 2 场）`);
for (const r of rows) console.log(`  ${r.at.slice(0, 10)}  实测 ${r.reps} 次 × ${r.sets} 组`);
console.log(`课程: ${program.title} · 已完成 ${program.completions.length}/${program.sessions.length} 场`);
const status = program.sessions.length ? `第 ${program.sessions[program.completions.length]?.weekNumber ?? program.weeks.length} 周` : "-";
console.log(`课程下一场: ${status} · ${program.sessions[program.completions.length]?.title ?? "已全部完成"}`);

if (!apply) {
  console.log("\ndry-run,未写入（加 TRAINMIND_APPLY=1 生效）。");
  db.close();
  process.exit(0);
}

// ── 4. 备份 + 清旧 + 写入（单一事务） ──
const backup = `${dbPath}.bak-${Date.now()}`;
db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
const check = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
if (check?.quick_check !== "ok") { console.error(`备份自检未通过(${check?.quick_check}),已中止。`); db.close(); process.exit(1); }
console.log(`备份(一致性快照): ${backup}`);

try {
  db.exec("BEGIN IMMEDIATE");
  const oldSessions = (db.prepare("SELECT id FROM workout_sessions WHERE user_id = ?").all(userId) as Array<{ id: string }>).map(r => r.id);
  for (const id of oldSessions) {
    // 2026-11-09 复核发现的真缺陷:这里原来只删组记录和事件,没删 workout_exercises /
    // exercise_instances。只要库里多出一场"经 API 建出来的会话"(带子表),整事务就撞
    // FOREIGN KEY constraint failed 回滚 —— 而脚本对外宣称是"可重复重造"。
    // 顺序:先把引用 set_records 的反馈删掉,再删组记录,最后删会话的子表。
    db.prepare("DELETE FROM set_feedbacks WHERE set_record_id IN (SELECT id FROM set_records WHERE json_extract(data_json, '$.sessionId') = ?)").run(id);
    db.prepare("DELETE FROM set_records WHERE json_extract(data_json, '$.sessionId') = ?").run(id);
    db.prepare("DELETE FROM interaction_events WHERE session_id = ?").run(id);
    db.prepare("DELETE FROM adaptation_events WHERE session_id = ?").run(id);
    db.prepare("DELETE FROM observer_records WHERE session_id = ?").run(id);
    db.prepare("DELETE FROM workout_exercises WHERE session_id = ?").run(id);
    db.prepare("DELETE FROM exercise_instances WHERE session_id = ?").run(id);
  }
  db.prepare("DELETE FROM workout_sessions WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM training_records WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM experiment_records WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM programs WHERE user_id = ?").run(userId);

  for (const item of seeded) {
    const s = item.session;
    db.prepare(`INSERT INTO workout_sessions (id, user_id, status, data_json, created_at, next_event_seq, planned_workout_id, started_at, ended_at, app_version)
                VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`).run(
      s.sessionId, userId, s.status, JSON.stringify(s), s.createdAt,
      (s.runtime.events?.length ?? 0) + 1,
      Date.parse(s.runtime.startedAt ?? s.createdAt), Date.parse(s.runtime.completedAt!),
      "demo-seed",
    );
    for (const rec of item.sets) {
      db.prepare("INSERT INTO set_records (id, workout_exercise_id, data_json) VALUES (?, ?, ?)").run(rec.id, rec.workoutExerciseId, JSON.stringify(rec));
    }
    db.prepare("INSERT INTO training_records (id, user_id, session_id, data_json) VALUES (?, ?, ?, ?)").run(
      randomUUID(), userId, s.sessionId, JSON.stringify({
        id: randomUUID(), userId, sessionId: s.sessionId,
        startedAt: s.runtime.startedAt, completedAt: s.runtime.completedAt,
        elapsedClockMs: Date.parse(s.runtime.completedAt!) - Date.parse(s.runtime.startedAt!),
        activeWorkoutMs: s.runtime.activeWorkoutMs, doseOutcomes: [],
      }),
    );
    db.prepare("INSERT OR REPLACE INTO experiment_records (session_id, user_id, experience_mode, data_json, created_at) VALUES (?, ?, ?, ?, ?)").run(
      s.sessionId, userId, "minimal", JSON.stringify({ ...item.record, dataOrigin: seededOrigin() }), s.runtime.completedAt!,
    );
  }
  db.prepare("INSERT INTO programs (id, user_id, status, data_json, created_at) VALUES (?, ?, ?, ?, ?)").run(
    program.programId, userId, program.status, JSON.stringify(program), program.createdAt,
  );
  db.exec("COMMIT");
} catch (error) {
  try { db.exec("ROLLBACK"); } catch { /* 连接已回滚 */ }
  console.error(`\n失败,已整体回滚: ${error instanceof Error ? error.message : String(error)}`);
  db.close();
  process.exit(1);
}

console.log(`\n已写入。浏览器打开 http://localhost:3000/?user=${encodeURIComponent(userId)} 即可看到这套数据。`);
db.close();
