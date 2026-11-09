#!/usr/bin/env node
// 一次性修复:历史训练时长把"挂机/过夜"时间算了进去(真机暴露:出现 18919/21976/27736 分钟的"训练")。
// 做法:按事件时间线重算 activeWorkoutMs(相邻事件间隔按 ACTIVE_IDLE_GAP_MS 截断),同步 training_records。
//
// C6(2026-11-09 审计):两个"修一半"的坑已堵——
//   1. apply 路径原来每条自动提交、无 try:第 N 条会话写成功、第 M 条 training_record 坏 JSON 抛错时,
//      前 N 条已落库而对应 training_record 没同步;重跑又因为 |old-new| 已小于阈值而跳过 → 脏数据固化。
//      现在整段包在 BEGIN IMMEDIATE 里,异常整体回滚;单行坏数据只计入 broken 继续。
//   2. 备份原来是 copyFileSync 裸拷活库(服务在跑时会拷到写入中间态)。现在用 VACUUM INTO 取一致性快照。
//   另加 PRAGMA busy_timeout:活库是 journal_mode=delete,服务在跑时并发写会直接 SQLITE_BUSY。
//
// 用法(建议先停服务):
//   node tools/repair-durations.ts                      # dry-run,只报告不改
//   TRAINMIND_APPLY=1 node tools/repair-durations.ts    # 真正写库(自带一致性备份)
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { ACTIVE_IDLE_GAP_MS, activeMsFromEvents } from "../src/core.ts";

const dbPath = process.env.TRAINMIND_DB ?? fileURLToPath(new URL("../trainmind.db", import.meta.url));
const apply = process.env.TRAINMIND_APPLY === "1";
const THRESHOLD_MS = 60_000; // 差异小于 1 分钟不动,避免无意义抖动

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 5000");

if (apply) {
  const backup = `${dbPath}.bak-${Date.now()}`;
  // 一致性快照:即使服务正在写,snapshot 也是完整的一刻,不会拷到半页
  db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
  const check = db.prepare(`PRAGMA quick_check`).get() as { quick_check?: string } | undefined;
  if (check?.quick_check !== "ok") { console.error(`备份后完整性自检未通过(${check?.quick_check});已中止,未写入任何数据。`); db.close(); process.exit(1); }
  console.log(`备份(一致性快照): ${backup}`);
}

const sessions = db.prepare("SELECT id, data_json FROM workout_sessions").all() as Array<{ id: string; data_json: string }>;
let changed = 0, beforeTotal = 0, afterTotal = 0, brokenSessions = 0;
const fixedSessionMs = new Map<string, number>();

const runWrite = () => {
  for (const row of sessions) {
    let w: any;
    try { w = JSON.parse(row.data_json); } catch { brokenSessions++; continue; }
    if (w === null || typeof w !== "object") { brokenSessions++; continue; }
    const oldMs = Number(w?.runtime?.activeWorkoutMs ?? 0);
    const events = Array.isArray(w?.runtime?.events) ? w.runtime.events : [];
    if (events.length < 2) continue;
    const newMs = activeMsFromEvents(events);
    beforeTotal += oldMs;
    if (Math.abs(oldMs - newMs) > THRESHOLD_MS) {
      changed++;
      fixedSessionMs.set(row.id, newMs);
      if (changed <= 10) console.log(`  ${row.id.slice(0, 8)}  ${(oldMs / 60000).toFixed(1)} min → ${(newMs / 60000).toFixed(1)} min`);
      if (apply) {
        try {
          w.runtime.activeWorkoutMs = newMs;
          db.prepare("UPDATE workout_sessions SET data_json = ? WHERE id = ?").run(JSON.stringify(w), row.id);
        } catch (error) {
          // 单行写失败不该让整批停在一个"改了一半"的状态:记下来,事务整体回滚,人工处理后再跑
          throw new Error(`会话 ${row.id} 写入失败: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      afterTotal += newMs;
    } else afterTotal += oldMs;
  }

  let records = 0;
  const recs = db.prepare("SELECT id, session_id, data_json FROM training_records").all() as Array<{ id: string; session_id: string; data_json: string }>;
  for (const row of recs) {
    const fixed = fixedSessionMs.get(row.session_id);
    if (fixed === undefined) continue;
    records++;
    if (!apply) continue;
    let record: any;
    try { record = JSON.parse(row.data_json); } catch { brokenSessions++; continue; }
    if (record === null || typeof record !== "object") { brokenSessions++; continue; }
    record.activeWorkoutMs = fixed;
    db.prepare("UPDATE training_records SET data_json = ? WHERE id = ?").run(JSON.stringify(record), row.id);
  }
  return records;
};

let records = 0;
try {
  if (apply) db.exec("BEGIN IMMEDIATE");
  records = runWrite();
  if (apply) db.exec("COMMIT");
} catch (error) {
  if (apply) { try { db.exec("ROLLBACK"); } catch { /* 连接已回滚 */ } }
  console.error(`\n失败,已整体回滚(数据库未被改动): ${error instanceof Error ? error.message : String(error)}`);
  db.close();
  process.exit(1);
}

console.log(`\n会话修正: ${changed} 条 | 训练记录同步: ${records} 条 | 封顶阈值: ${ACTIVE_IDLE_GAP_MS / 60000} 分钟`);
console.log(`总时长: ${(beforeTotal / 60000).toFixed(0)} min → ${(afterTotal / 60000).toFixed(0)} min`);
if (brokenSessions) console.warn(`坏数据跳过(需人工看): ${brokenSessions} 行`);
console.log(apply ? "已写入(单一事务)。" : "dry-run,未写入(加 TRAINMIND_APPLY=1 生效)。");
db.close();
