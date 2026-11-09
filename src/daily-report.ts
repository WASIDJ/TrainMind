// 每日日报（2026-11-09，owner 要求）：把当天的事实压成一页 Markdown。
//
// 为什么先做它：孙宇晨那套流程里，"数据变资产"最容易被验证的一环就是日报——
// 如果用户自己连看三天觉得没信息量，那"数据平台"的叙事就该重想。
//
// 红线（与 D17/D30 一致）：
//   1. 只报事实与"下一步很小的一步"，不评判、不喊口号、不承诺效果。
//   2. 不出现体重/热量/体重变化（我们没有这些数据，也不假装有）。
//   3. 没练就说没练，不粉饰；不练也不是失败。
import type { MuscleLedgerEntry } from "./muscles.ts";

export interface DailyReportInput {
  userId: string;
  /** 生成日期（YYYY-MM-DD，本地时区） */
  date: string;
  /** 今天完成的场次 */
  todaySessions: Array<{ sessionId: string; goal?: string; minutes: number; sets: number; extra?: boolean }>;
  /** 本周（周一起）场次与组数 */
  week: { sessions: number; sets: number };
  /** 连续周 */
  streakWeeks: number;
  /** 肌群账本 */
  muscles: MuscleLedgerEntry[];
  /** 最近一次进步叙事（可为空） */
  headline?: string | null;
}

const STATE_LABEL: Record<MuscleLedgerEntry["state"], string> = {
  just_trained: "今天练过",
  recovering: "恢复中",
  recovered: "已恢复",
  neglected: "久未训练",
  no_record: "暂无记录",
};

/** 生成 Markdown 日报。纯函数，便于测试与"同样的输入永远得到同样的报告"。 */
export function buildDailyReport(input: DailyReportInput): string {
  const lines: string[] = [];
  const trained = input.todaySessions.length > 0;
  const totalMinutes = input.todaySessions.reduce((n, s) => n + s.minutes, 0);
  const totalSets = input.todaySessions.reduce((n, s) => n + s.sets, 0);

  lines.push(`# ${input.date} 训练日报`, "");
  lines.push(`> 用户 ${input.userId} · 由 TrainMind 本地生成（未联外部服务）`, "");

  lines.push("## 今天", "");
  if (trained) {
    for (const s of input.todaySessions) {
      lines.push(`- ${s.extra ? "加练" : "计划"}：${s.minutes} 分钟 · ${s.sets} 组${s.goal ? ` · ${s.goal}` : ""}`);
    }
    lines.push("", `合计 **${totalMinutes} 分钟 / ${totalSets} 组**。`, "");
  } else {
    lines.push("- 今天没有训练记录。", "", "没练不是欠账——明天想动的时候按你当时的状态重新排。", "");
  }

  lines.push("## 本周", "");
  lines.push(`- 已完成 ${input.week.sessions} 场 / ${input.week.sets} 组`);
  lines.push(`- 连续 ${input.streakWeeks} 周${input.streakWeeks >= 3 ? "（这种“没停”比某天练多狠更难）" : ""}`);
  if (input.headline) lines.push(`- 最近的进步：${input.headline}`);
  lines.push("");

  lines.push("## 肌群状态", "");
  lines.push("| 部位 | 状态 | 近 7 天 | 距上次 |");
  lines.push("|---|---|---|---|");
  for (const m of input.muscles) {
    const since = m.hoursSince === null ? "—" : m.hoursSince >= 48 ? `${Math.floor(m.hoursSince / 24)} 天前` : `${m.hoursSince} 小时前`;
    lines.push(`| ${m.label} | ${STATE_LABEL[m.state]} | ${m.sets7d} 组 | ${since} |`);
  }
  lines.push("");

  const recovering = input.muscles.filter(m => m.state === "just_trained" || m.state === "recovering").map(m => m.label);
  const neglected = input.muscles.filter(m => m.state === "neglected").map(m => m.label);
  lines.push("## 明天可以怎么走", "");
  if (!trained) {
    lines.push("- 先动一次就够，量我帮你压小一点。");
  } else if (recovering.length) {
    lines.push(`- ${recovering.join("、")}还在恢复，明天换别的地方，或者干脆休息。`);
  } else if (neglected.length) {
    lines.push(`- ${neglected.join("、")}已经很久没练了，下次要不要匀一点给它？（不匀也行）`);
  } else {
    lines.push("- 按现在的节奏继续就行，不需要加码。");
  }
  lines.push("", "---", "", "本报告只陈述记录里的事实，不构成医疗建议。", "");
  return lines.join("\n");
}
