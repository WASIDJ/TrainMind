#!/usr/bin/env node
// 一次性回填(M2 诚实记账):"次数来源三态"(counted/reported/assumed)上线前,set_records 里的旧行
// 没有 actualRepsSource 标记。保守口径(与 D20"不冒充测量"同一精神,2026-11-06 采纳):
// 无标记一律回填为 assumed——这些组从此退出进步叙事(exerciseProgress/weekOverWeek)与
// "已确认次数"展示,宁可暂时少报进步,不高估。
//
// C7(2026-11-09 审计)修掉三处:
//   1. 备份从 copyFileSync 裸拷活库改为 VACUUM INTO 一致性快照 + quick_check
//      (活库是 journal_mode=delete,服务在跑时裸拷可能拷到写入中间态,而回滚就靠这份备份)。
//   2. 回填整段包进 BEGIN IMMEDIATE:中途崩不再出现"部分行已标、部分没标"导致 dry-run 数字每次不同。
//   3. 只动 legacy 行(exercise_instance_id IS NULL AND set_number IS NULL):
//      v2 行的 data_json 是 '{}',给它写 assumed 会制造"看着有标记、实际与三态无关"的噪声。
//
// 回滚:APPLY 时自动备份 <db>.bak-<时间戳>;翻案就停服务后恢复备份再重启。
// 用法(与 tools/repair-durations.ts 同模板):
//   node tools/backfill-reps-source.ts                    # dry-run,只报告不改
//   TRAINMIND_APPLY=1 node tools/backfill-reps-source.ts  # 真正写库(自带一致性备份)
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { hasColumn } from "../src/telemetry/ddl.ts";

const dbPath = process.env.TRAINMIND_DB ?? fileURLToPath(new URL("../trainmind.db", import.meta.url));
const apply = process.env.TRAINMIND_APPLY === "1";

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 5000");

if (apply) {
  const backup = `${dbPath}.bak-${Date.now()}`;
  db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
  const check = db.prepare(`PRAGMA quick_check`).get() as { quick_check?: string } | undefined;
  if (check?.quick_check !== "ok") { console.error(`备份后完整性自检未通过(${check?.quick_check});已中止,未写入任何数据。`); db.close(); process.exit(1); }
  console.log(`备份(一致性快照): ${backup}`);
}

const legacyOnly = hasColumn(db, "set_records", "exercise_instance_id") && hasColumn(db, "set_records", "set_number");
const rows = (legacyOnly
  ? db.prepare("SELECT id, data_json FROM set_records WHERE exercise_instance_id IS NULL AND set_number IS NULL").all()
  : db.prepare("SELECT id, data_json FROM set_records").all()) as Array<{ id: string; data_json: string }>;
// 统计口径保持"全库视图":已有标记的 v2/legacy 行也计数,方便核对总数
const allRows = db.prepare("SELECT data_json FROM set_records").all() as Array<{ data_json: string }>;
const bySource: Record<string, number> = {};
let alreadyMarked = 0;
for (const row of allRows) {
  try {
    const record = JSON.parse(row.data_json);
    if (typeof record?.actualRepsSource === "string" && record.actualRepsSource) { alreadyMarked++; bySource[record.actualRepsSource] = (bySource[record.actualRepsSource] ?? 0) + 1; }
  } catch { /* 坏行在下面计入 broken */ }
}

let backfilled = 0, broken = 0;
let oldest: string | undefined, newest: string | undefined;

const runBackfill = () => {
  for (const row of rows) {
    let record: { actualRepsSource?: string; completedAt?: string };
    try { record = JSON.parse(row.data_json); } catch { broken++; continue; }
    if (record === null || typeof record !== "object") { broken++; continue; }
    if (typeof record.actualRepsSource === "string" && record.actualRepsSource) continue;
    backfilled++;
    const at = typeof record.completedAt === "string" ? record.completedAt : undefined;
    if (at && (!oldest || at < oldest)) oldest = at;
    if (at && (!newest || at > newest)) newest = at;
    if (backfilled <= 10) console.log(`  ${row.id.slice(0, 8)}  无标记 → assumed  ${at ?? "时间未知"}`);
    if (apply) db.prepare("UPDATE set_records SET data_json = ? WHERE id = ?").run(JSON.stringify({ ...record, actualRepsSource: "assumed" }), row.id);
  }
};

try {
  if (apply) db.exec("BEGIN IMMEDIATE");
  runBackfill();
  if (apply) db.exec("COMMIT");
} catch (error) {
  if (apply) { try { db.exec("ROLLBACK"); } catch { /* 连接已回滚 */ } }
  console.error(`\n失败,已整体回滚(数据库未被改动): ${error instanceof Error ? error.message : String(error)}`);
  db.close();
  process.exit(1);
}

console.log(`\n组记录总数: ${allRows.length} | 已有标记: ${alreadyMarked} (${Object.entries(bySource).map(([k, v]) => `${k}=${v}`).join(", ") || "无"}) | 本次回填: ${backfilled}`);
if (backfilled) console.log(`回填范围(无标记行): ${oldest ?? "?"} ~ ${newest ?? "?"}`);
if (broken) console.warn(`解析失败跳过: ${broken} 行`);
console.log(apply ? "已写入(assumed,单一事务)。进步叙事从下一次查询起按保守口径计算。" : "dry-run,未写入(加 TRAINMIND_APPLY=1 生效)。");
db.close();
