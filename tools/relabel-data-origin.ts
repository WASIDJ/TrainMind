#!/usr/bin/env node
// D24 / A10(2026-11-09, owner 裁决):"需要按照 human 数据来的，不能只是演示数据"。
//
// 背景:课程开局把 dataOrigin 写死成 "demo",首页 preview 的缺省值也是 "demo" ——
// 库里真实练过的场次被打上"演示数据",而 /api/experiment 默认只看 human,
// 于是实验看板上"人类场次"一条都没有。
//
// 本工具把 demo 改标为 human,范围受控:
//   - 课程场次(有 program.programSessionId):一律改 —— 它们本来就是被代码写死的
//   - 普通场次:默认排除自动化探针(probe / smoke / audit / dryrun / planprobe / fix- / eq- / nocount-)
//   - 想只改指定用户:TRAINMIND_RELABEL_USERS=demo-user,alice
//   - `training_records`(同名 JSON)与 `experiment_records` 按 sessionId 同步改
//
// 用法(建议先停服务):
//   node tools/relabel-data-origin.ts                      # dry-run,只报告
//   TRAINMIND_APPLY=1 node tools/relabel-data-origin.ts    # 真正写库(自带一致性备份)
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const dbPath = process.env.TRAINMIND_DB ?? fileURLToPath(new URL("../trainmind.db", import.meta.url));
const apply = process.env.TRAINMIND_APPLY === "1";
const explicitUsers = (process.env.TRAINMIND_RELABEL_USERS ?? "").split(",").map(s => s.trim()).filter(Boolean);
/** 自动化探针的用户名前缀:这些不是真人训练,保持 demo 以免污染人类场次 */
const PROBE_USER = /probe|smoke|audit|dryrun|^fix-|^eq-|^nocount-|^planprobe/i;
const FROM = "demo";
const TO = "human";

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 5000");

if (apply) {
  const backup = `${dbPath}.bak-${Date.now()}`;
  db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
  const check = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
  if (check?.quick_check !== "ok") { console.error(`备份自检未通过(${check?.quick_check}),已中止。`); db.close(); process.exit(1); }
  console.log(`备份(一致性快照): ${backup}`);
}

type Row = { id: string; data_json: string };
const sessions = db.prepare("SELECT id, data_json FROM workout_sessions").all() as Row[];
const records = db.prepare("SELECT id, session_id, data_json FROM training_records").all() as Array<{ id: string; session_id: string; data_json: string }>;
const experiments = db.prepare("SELECT session_id, data_json FROM experiment_records").all() as Array<{ session_id: string; data_json: string }>;

const relabelSessions: Array<{ row: Row; data: any; kind: string; userId: string }> = [];
const skipped: Record<string, number> = {};
const note = (key: string) => { skipped[key] = (skipped[key] ?? 0) + 1; };

for (const row of sessions) {
  let data: any;
  try { data = JSON.parse(row.data_json); } catch { note("bad_json"); continue; }
  const origin = data?.experience?.dataOrigin;
  if (origin !== FROM) { note(`origin=${origin ?? "none"}`); continue; }
  const kind = data?.program?.programSessionId ? "course" : "normal";
  const userId = String(data?.userId ?? "");
  const wanted = explicitUsers.length ? explicitUsers.includes(userId) : (kind === "course" || !PROBE_USER.test(userId));
  if (!wanted) { note(`probe:${userId}`); continue; }
  relabelSessions.push({ row, data, kind, userId });
}

const relabelIds = new Set(relabelSessions.map(x => x.row.id));
const relabelRecords = records.filter(r => relabelIds.has(r.session_id));
const relabelExperiments = experiments.filter(e => {
  try { const d = JSON.parse(e.data_json); return d?.dataOrigin === FROM && relabelIds.has(String(d?.sessionId ?? e.session_id)); } catch { return false; }
});

console.log(`\n待改标(demo → ${TO}):`);
const byKind = relabelSessions.reduce<Record<string, number>>((acc, x) => { const k = `${x.kind}:${x.userId}`; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) console.log(`  ${k}  ${n} 场`);
console.log(`  合计 ${relabelSessions.length} 场 · 训练记录 ${relabelRecords.length} 条 · 实验记录 ${relabelExperiments.length} 条`);
console.log(`未动:${Object.entries(skipped).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}×${v}`).join(", ") || "无"}`);

if (apply && relabelSessions.length) {
  try {
    db.exec("BEGIN IMMEDIATE");
    for (const item of relabelSessions) {
      item.data.experience.dataOrigin = TO;
      db.prepare("UPDATE workout_sessions SET data_json = ? WHERE id = ?").run(JSON.stringify(item.data), item.row.id);
    }
    for (const row of relabelRecords) {
      const data = JSON.parse(row.data_json);
      data.dataOrigin = TO;
      db.prepare("UPDATE training_records SET data_json = ? WHERE id = ?").run(JSON.stringify(data), row.id);
    }
    for (const row of relabelExperiments) {
      const data = JSON.parse(row.data_json);
      data.dataOrigin = TO;
      db.prepare("UPDATE experiment_records SET data_json = ? WHERE session_id = ?").run(JSON.stringify(data), row.session_id);
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* 连接已回滚 */ }
    console.error(`\n失败,已整体回滚: ${error instanceof Error ? error.message : String(error)}`);
    db.close();
    process.exit(1);
  }
}

console.log(apply ? "\n已写入(单一事务)。实验看板 dataOrigin=human 现在能看到这些场次。" : "\ndry-run,未写入(加 TRAINMIND_APPLY=1 生效)。");
db.close();
