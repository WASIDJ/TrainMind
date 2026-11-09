/**
 * B10(2026-11-09, owner 裁决 A):日 / 周边界按「服务器本地时区」算。
 *
 * 为什么不是 UTC:北京时间早上 7:30 的训练在 UTC 里是前一天 23:30 —— 会被算成"昨天/上一周",
 * 周对周对比整条消失,同一自然日的早晚两次训练还会被算成两天。
 * 为什么不是固定 +08:00:出差或换机器时会把当地训练算错。
 * 单用户本机应用,人和机器同一个时区 —— 本地时区就是"用户眼里的今天"。
 *
 * 实现细节:按日历字段取日/周起点(不是时间戳整除),所以夏令时切换不会把边界算歪;
 * 相邻周比较用 localWeekIndex(周一 00:00 折算成天数),跨时区切换时仍保持单调。
 */
export const DAY_MS = 86_400_000;

/** 本地日历日,形如 2026-11-09(可直接字符串排序) */
export function localDayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 本地当天 00:00 的时间戳 */
export function localMidnight(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 本地本周一 00:00 的时间戳(周一为一周起点,与旧实现一致) */
export function localWeekStart(t: number): number {
  const d = new Date(t);
  return localMidnight(t) - ((d.getDay() + 6) % 7) * DAY_MS;
}

/** 本地周标识(本周一的日期串) */
export function localWeekKey(t: number): string {
  return localDayKey(localWeekStart(t));
}

/** 相邻周比较用:把"本地周一"折算成周序号(相邻周差 1) */
export function localWeekIndex(t: number): number {
  return Math.round(localWeekStart(t) / (7 * DAY_MS));
}
