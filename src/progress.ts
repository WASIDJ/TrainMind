// 进步叙事 + 关系进度 —— 让"你变强了"从数据变成人话
// 铁律:只有真实测量的次数(counted/reported)才可用于进步宣称;assumed(系统按目标推定)一律排除。
// 纯函数,无 IO,无 Date.now 依赖(时间由调用方传入),便于测试与回放。
import { localDayKey, localMidnight, localWeekIndex, localWeekKey, localWeekStart } from "./local-time.ts";

export type RepsSource = "counted" | "reported" | "assumed";

export interface ProgressSet {
  exerciseId: string;
  actualReps: number;
  actualWeight?: number;
  feedback?: string;
  pain?: boolean;
  completedAt: string;
  actualRepsSource?: RepsSource;
}

export interface ExerciseProgress {
  exerciseId: string;
  name: string;
  /** 参与统计的测量组数(排除 assumed 与疼痛组) */
  measuredSets: number;
  firstReps: number;
  bestReps: number;
  lastReps: number;
  deltaReps: number;
  firstWeight?: number;
  bestWeight?: number;
  deltaWeight?: number;
  firstAt: string;
  lastAt: string;
  trend: "up" | "down" | "flat" | "new";
  headline: string;
}

const DAY = 24 * 3600 * 1000;
const measured = (s: ProgressSet) => !s.pain && s.actualRepsSource !== "assumed" && Number.isFinite(s.actualReps);

/** 动作级进步:首测 vs 最佳 vs 最近。首测=第一次测量组,最佳=历史上最高次数。 */
export function exerciseProgress(sets: ProgressSet[], names: Record<string, string> = {}, minSets = 2): ExerciseProgress[] {
  const byExercise = new Map<string, ProgressSet[]>();
  for (const s of sets.filter(measured)) {
    const list = byExercise.get(s.exerciseId) ?? [];
    list.push(s);
    byExercise.set(s.exerciseId, list);
  }
  const out: ExerciseProgress[] = [];
  for (const [exerciseId, list] of byExercise) {
    const sorted = [...list].sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt));
    if (sorted.length < minSets) continue;
    const first = sorted[0]!, last = sorted[sorted.length - 1]!;
    const bestReps = Math.max(...sorted.map(x => x.actualReps));
    const lastWeight = last.actualWeight;
    const weights = sorted.map(x => x.actualWeight).filter((x): x is number => typeof x === "number" && x > 0);
    const bestWeight = weights.length ? Math.max(...weights) : undefined;
    const firstWeight = weights.length ? weights[0] : undefined;
    // B7(2026-11-09):趋势必须看"最近 vs 首测"。旧实现用 bestReps - first.actualReps,
    // 它恒 ≥ 0(down 是死代码),于是 12→6→4 会被说成"稳定在 4 次",把退步说成稳定。
    const lastVsFirstReps = last.actualReps - first.actualReps;
    const lastVsFirstWeight = firstWeight !== undefined && lastWeight !== undefined ? lastWeight - firstWeight : undefined;
    const deltaReps = lastVsFirstReps, deltaWeight = lastVsFirstWeight;
    const trend = deltaReps > 0 || (deltaWeight ?? 0) > 0 ? "up" : deltaReps < 0 || (deltaWeight ?? 0) < 0 ? "down" : "flat";
    const name = names[exerciseId] ?? exerciseId;
    const headline = deltaReps > 0
      ? `${name} 从 ${first.actualReps} 次做到 ${last.actualReps} 次`
      : (deltaWeight ?? 0) > 0
        ? `${name} 从 ${firstWeight} 公斤做到 ${lastWeight} 公斤`
        : deltaReps < 0
          ? `${name} 最近回落到 ${last.actualReps} 次`
          : (deltaWeight ?? 0) < 0
            ? `${name} 最近回落到 ${lastWeight} 公斤`
            : `${name} 稳定在 ${last.actualReps} 次`;
    out.push({ exerciseId, name, measuredSets: sorted.length, firstReps: first.actualReps, bestReps, lastReps: last.actualReps, deltaReps, firstWeight, bestWeight, deltaWeight, firstAt: first.completedAt, lastAt: last.completedAt, trend, headline });
  }
  return out.sort((a, b) => b.deltaReps - a.deltaReps || Date.parse(b.lastAt) - Date.parse(a.lastAt));
}

/** 整体一句进步结论(无数据时诚实说没有)。 */
export function progressSummary(rows: ExerciseProgress[]): string {
  if (!rows.length) return "还不足以比较——再多练一次同一组动作,我就能告诉你进步了多少。";
  // (up/down 在下面一起算)
  const up = rows.filter(r => r.trend === "up"), down = rows.filter(r => r.trend === "down");
  // B7:退步不许被说成"稳定"(那等于用话术盖住退步,与不冒充进步同一条底线)
  if (!up.length) return down.length ? "最近几次比之前低一些。先把强度调回上次坐实的水平,再往前推。" : "最近几次都稳定,先把这个强度坐实,下一步再往前推。";
  const top = up.slice(0, 2).map(r => r.headline).join(";");
  return `你确实在变强:${top}。`;
}

export type RelationshipStage = "first_meet" | "warming_up" | "partner" | "long_term";

export interface Relationship {
  totalSessions: number;
  /** 一起训练了多少天(首个训练日到最近训练日) */
  daysTogether: number;
  /** 连续训练周数(含本周或上周) */
  streakWeeks: number;
  daysSinceLast: number | null;
  stage: RelationshipStage;
  label: string;
  text: string;
}

const STAGE_LABEL: Record<RelationshipStage, string> = { first_meet: "刚认识", warming_up: "磨合中", partner: "训练搭档", long_term: "长期伙伴" };

/** 关系阶段(星野 ConversationPhaseInfo 同构):用训练次数与跨度描述关系进度,不用问卷。 */
export function relationship(dates: string[], now = Date.now()): Relationship {
  // B10(2026-11-09, owner 裁决 A):按本地时区归日/周。原来直接切 ISO 串(UTC),
  // 北京时间早上 7:30 的训练会算成前一天,同一自然日的早晚两次还会算成两天。
  const times = dates.map(d => Date.parse(d)).filter(t => Number.isFinite(t));
  const days = [...new Set(times.map(localDayKey))].sort();
  const totalSessions = days.length;
  const stage: RelationshipStage = totalSessions >= 12 ? "long_term" : totalSessions >= 6 ? "partner" : totalSessions >= 3 ? "warming_up" : "first_meet";
  const dayMs = (key: string) => Date.parse(`${key}T00:00:00`); // 本地午夜
  const first = days[0], last = days[days.length - 1];
  const daysTogether = first ? Math.max(1, Math.round((dayMs(last!) - dayMs(first)) / DAY) + 1) : 0;
  const daysSinceLast = last ? Math.max(0, Math.round((localMidnight(now) - dayMs(last)) / DAY)) : null;
  // 连续周:从最近训练所在周向前数,周内只要有训练就算连上
  const weekKey = (d: string) => localWeekIndex(dayMs(d));
  const weeks = [...new Set(days.map(weekKey))].sort((a, b) => b - a);
  // B8(2026-11-09):streak 必须是"到现在还连着"。旧实现只数历史里最长的一段连续,
  // 练满 5 周后停两个月仍会宣称"连续 5 周",nudge 还会说"今天别断了"——用过去冒充当前。
  const nowWeek = localWeekIndex(now);
  const stillConnected = weeks.length > 0 && weeks[0]! >= nowWeek - 1; // 本周或上周练过才算连着
  let streakWeeks = stillConnected ? 1 : 0;
  for (let i = 1; stillConnected && i < weeks.length && weeks[i - 1]! - weeks[i]! === 1; i++) streakWeeks++;
  const parts = [`一起练了 ${totalSessions} 次`];
  if (daysTogether >= 14) parts.push(`跨度 ${Math.max(1, Math.round(daysTogether / 7))} 周`);
  if (streakWeeks >= 2) parts.push(`连续 ${streakWeeks} 周`);
  if (daysSinceLast !== null) parts.push(daysSinceLast === 0 ? "今天练了" : daysSinceLast === 1 ? "昨天练过" : `${daysSinceLast} 天前练过`);
  return { totalSessions, daysTogether, streakWeeks, daysSinceLast, stage, label: STAGE_LABEL[stage], text: parts.join(" · ") };
}

export interface Nudge { shouldNudge: boolean; code: "none" | "back_soon" | "missing" | "lapsed"; text: string }
/** 回归钩子:久未训练时主动开口(它来找我),而不是等用户想起。 */
export function nudgeFor(rel: Relationship, opts: { streakWeeks?: number } = {}): Nudge {
  if (rel.daysSinceLast === null) return { shouldNudge: false, code: "none", text: "" };
  const d = rel.daysSinceLast, streak = opts.streakWeeks ?? rel.streakWeeks;
  if (d <= 1) return { shouldNudge: false, code: "none", text: "" };
  if (d === 2) return { shouldNudge: true, code: "back_soon", text: streak >= 2 ? `连续 ${streak} 周了,今天别断了。` : "昨天休息够了,今天来一组?" };
  if (d <= 6) return { shouldNudge: true, code: "missing", text: `隔了 ${d} 天,身体正好恢复——现在练一组最划算。` };
  if (d <= 13) return { shouldNudge: true, code: "lapsed", text: `一周没练了。不从头开始,就从最简单的那个动作做起。` };
  return { shouldNudge: true, code: "lapsed", text: `${d} 天了。我们先不看计划,做 5 分钟就算赢。` };
}

// ── 训练规律性:次数的"测量"不再依赖用户报数,但"练了几次、几组"是真实发生的事实 ──
export interface WeeklyVolume {
  thisWeek: { sessions: number; sets: number };
  lastWeek: { sessions: number; sets: number };
  deltaSets: number;
  text: string;
}

export function weeklyVolume(sessionDates: string[], setDates: string[], now = Date.now()): WeeklyVolume {
  const monday = (t: number) => localWeekKey(t); // B10:本地周起点
  const thisKey = monday(now), lastKey = monday(localWeekStart(now) - DAY);
  const inWeek = (dates: string[], key: string) => dates.map(d => Date.parse(d)).filter(t => Number.isFinite(t) && monday(t) === key);
  const thisSets = inWeek(setDates, thisKey), lastSets = inWeek(setDates, lastKey);
  const thisWeek = { sessions: new Set(inWeek(sessionDates, thisKey).map(localDayKey)).size, sets: thisSets.length };
  const lastWeek = { sessions: new Set(inWeek(sessionDates, lastKey).map(localDayKey)).size, sets: lastSets.length };
  const deltaSets = thisWeek.sets - lastWeek.sets;
  const text = thisWeek.sets === 0
    ? "本周还没开始练"
    : lastWeek.sets === 0
      ? `本周 ${thisWeek.sessions} 次 / ${thisWeek.sets} 组（上周没有可比数据）`
      : deltaSets > 0 ? `本周 ${thisWeek.sessions} 次 / ${thisWeek.sets} 组，比上周多 ${deltaSets} 组`
        : deltaSets < 0 ? `本周 ${thisWeek.sessions} 次 / ${thisWeek.sets} 组，比上周少 ${-deltaSets} 组`
          : `本周 ${thisWeek.sessions} 次 / ${thisWeek.sets} 组，和上周一样`;
  return { thisWeek, lastWeek, deltaSets, text };
}
