// 多周课程(Program → Week → Session) + 计划/执行分离 + 周对周进步
// 借鉴 workout.cool(MIT)的结构设计:计划是模板,执行是事实,两者显式分离再连接。
// 铁律不变:本模块不生成剂量——每场训练仍由既有规则引擎(core.createWorkout)产出,课程只管"节奏与章节"。
// 纯函数,时间由调用方传入,可测试可回放。
import { localWeekKey, localWeekStart } from "./local-time.ts";

export interface ProgramWeek { weekNumber: number; title: string; focus: string }
export interface ProgramSessionTemplate {
  id: string;
  weekNumber: number;
  sessionNumber: number;
  title: string;
  /** 生成该场训练的一句话需求 —— 交给现有规则引擎,不复制剂量逻辑 */
  input: string;
}
export interface PlannedExercise { exerciseId: string; name: string; sets: number; targetReps: string }
/** 一次"计划↔执行"的绑定:哪一场模板,对应哪一次真实训练,以及开始时的计划快照 */
export interface ProgramCompletion {
  programSessionId: string;
  workoutSessionId: string;
  completedAt: string;
  planned?: PlannedExercise[];
  /** 实际测量到的组数(只含 counted/reported,assumed 不计) */
  measuredSets?: number;
}
export interface Program {
  schemaVersion: "1.0";
  programId: string;
  userId: string;
  title: string;
  goal: string;
  environment: string;
  equipment: string[];
  targetMinutes: number;
  sessionsPerWeek: number;
  weeks: ProgramWeek[];
  sessions: ProgramSessionTemplate[];
  status: "active" | "completed" | "abandoned";
  createdAt: string;
  completions: ProgramCompletion[];
}

export interface ProgramStatus {
  weekNumber: number;
  weekTitle: string;
  chapter: string;
  completedSessions: number;
  totalSessions: number;
  percent: number;
  nextSession: ProgramSessionTemplate | null;
  /** 一句话章节描述,可直接上屏/进叙事 */
  text: string;
}

const CHAPTERS = ["起步", "建立", "加深", "巩固"] as const;

/** 章节:按课程进度四等分(不按周硬编码,4 周和 12 周都能用) */
export function chapterFor(weekNumber: number, totalWeeks: number): string {
  const ratio = totalWeeks <= 1 ? 0 : (weekNumber - 1) / totalWeeks;
  const index = Math.min(CHAPTERS.length - 1, Math.floor(ratio * CHAPTERS.length));
  return CHAPTERS[index]!;
}

const WEEK_FOCUS = ["建立动作模式,重量宁轻", "稳定节奏,推进次数", "加深刺激,尝试加重", "巩固成果,查漏补缺"];

/** 用户说的目标（常常是半句话）→ 课程标题里的名词短语。认不出就用"训练"，不硬编。 */
export function programGoalName(goal: string): string {
  const text = String(goal ?? "");
  if (/下肢|练腿|腿部/.test(text)) return "下肢";
  if (/上肢/.test(text)) return "上肢";
  if (/恢复|放松|活动/.test(text)) return "恢复";
  if (/全身|力量|增肌/.test(text)) return "全身力量";
  return "训练";
}

export function buildProgram(opts: {
  programId: string; userId: string; goal: string; weeks: number; sessionsPerWeek: number;
  environment?: string; targetMinutes?: number; title?: string; now?: Date; equipment?: string[];
}): Program {
  const weeks = Math.max(1, Math.min(24, Math.floor(opts.weeks)));
  const perWeek = Math.max(1, Math.min(7, Math.floor(opts.sessionsPerWeek)));
  const environment = opts.environment ?? "home";
  const targetMinutes = opts.targetMinutes ?? 30;
  // 器械必须由用户选,不能靠历史瞎猜(否则会排出"家里没有哑铃"的动作)
  const equipment = (opts.equipment?.length ? opts.equipment : ["bodyweight"]).filter(e => ["bodyweight", "dumbbell", "band"].includes(e));
  // 注意:需求解析器遇到"徒手自重"会短路,不再读后面的器械 —— 所以只要有器械,就别说"自重"(自重恒可用)
  const extras = equipment.filter(e => e !== "bodyweight");
  const equipmentPhrase = extras.length ? extras.map(e => e === "dumbbell" ? "有哑铃" : "有弹力带").join("、") : "徒手自重";
  const placePhrase = environment === "home" ? "家" : environment === "gym" ? "健身房" : "办公室";
  const input = `我在${placePhrase}，${targetMinutes} 分钟，${equipmentPhrase}，${opts.goal}。`;
  const chapters: ProgramWeek[] = Array.from({ length: weeks }, (_, i) => ({
    weekNumber: i + 1,
    title: chapterFor(i + 1, weeks),
    focus: WEEK_FOCUS[Math.min(WEEK_FOCUS.length - 1, Math.floor((i / weeks) * WEEK_FOCUS.length))]!,
  }));
  const sessions: ProgramSessionTemplate[] = [];
  for (const week of chapters) {
    for (let s = 1; s <= perWeek; s++) {
      sessions.push({
        id: `${opts.programId}-w${week.weekNumber}s${s}`,
        weekNumber: week.weekNumber,
        sessionNumber: s,
        title: `第 ${week.weekNumber} 周 · 第 ${s} 场`,
        // 需求文本交给规则引擎解析;周次信息只影响"节奏",不影响剂量
        input,
      });
    }
  }
  return {
    schemaVersion: "1.0",
    programId: opts.programId,
    userId: opts.userId,
    // 2026-11-11 审查：title 原来直接拼 goal，而 goal 常常是用户原话（"想练全身"），
    // 于是课程名显示成"4 周 想练全身课程"——像内部变量漏到界面上。这里按目标映射成名词。
    title: opts.title ?? `${weeks} 周${programGoalName(opts.goal)}课程`,
    goal: opts.goal,
    environment,
    equipment,
    targetMinutes,
    sessionsPerWeek: perWeek,
    weeks: chapters,
    sessions,
    status: "active",
    createdAt: (opts.now ?? new Date()).toISOString(),
    completions: [],
  };
}

/** 课程状态:进度完全由"真实完成的场次"决定,未完成的计划不冒充进度 */
export function programStatus(program: Program): ProgramStatus {
  const done = new Set(program.completions.map(c => c.programSessionId));
  const totalSessions = program.sessions.length;
  const completedSessions = done.size;
  const nextSession = program.sessions.find(s => !done.has(s.id)) ?? null;
  const weekNumber = nextSession?.weekNumber ?? program.weeks.length;
  const week = program.weeks.find(w => w.weekNumber === weekNumber) ?? program.weeks[program.weeks.length - 1]!;
  const chapter = chapterFor(weekNumber, program.weeks.length);
  return {
    weekNumber,
    weekTitle: week?.title ?? chapter,
    chapter,
    completedSessions,
    totalSessions,
    percent: totalSessions ? Math.round((completedSessions / totalSessions) * 100) : 0,
    nextSession,
    text: `第 ${weekNumber} 周 · ${chapter} · 已完成 ${completedSessions}/${totalSessions} 场`,
  };
}

/** 记一次完成:同一场重复完成只认第一次(计划与执行一一对应) */
export function recordCompletion(program: Program, completion: ProgramCompletion): Program {
  if (program.completions.some(c => c.programSessionId === completion.programSessionId)) return program;
  const completions = [...program.completions, completion];
  const allDone = program.sessions.every(s => completions.some(c => c.programSessionId === s.id));
  return { ...program, completions, status: allDone ? "completed" : program.status };
}

// ── 周对周进步:同一动作本周 vs 上周的实测次数 ────────────────────
export interface WeeklySet { exerciseId: string; actualReps: number; completedAt: string; actualRepsSource?: "counted" | "reported" | "assumed"; pain?: boolean }
export interface WeeklyDelta { exerciseId: string; name: string; thisWeek: number; lastWeek: number; delta: number; text: string }

const DAY = 24 * 3600 * 1000;
/** B10(2026-11-09):本地时区的周起点(原来用 getUTCDay + toISOString,早间训练会落到上一周) */
const mondayOf = (t: number) => localWeekKey(t);

/** 只比较两侧都有实测的动作;assumed 与疼痛组一律排除。 */
export function weekOverWeek(sets: WeeklySet[], names: Record<string, string> = {}, now = Date.now()): WeeklyDelta[] {
  // B10(2026-11-09, owner 裁决 A):周对周按「本地时区」切周(见 local-time.ts)。
  const thisWeekKey = mondayOf(now), lastWeekKey = mondayOf(localWeekStart(now) - DAY);
  const acc = new Map<string, { thisWeek: number[]; lastWeek: number[] }>();
  for (const s of sets) {
    if (s.pain || s.actualRepsSource === "assumed" || !Number.isFinite(s.actualReps)) continue;
    // B11(2026-11-09):脏 completedAt(空串/非 ISO)会让 mondayOf(NaN) → RangeError,
    // 一条坏记录就能让整周的周对周进步拿不到。跳过它,别抛。
    const at = Date.parse(s.completedAt);
    if (!Number.isFinite(at)) continue;
    const key = mondayOf(at);
    const bucket = acc.get(s.exerciseId) ?? { thisWeek: [], lastWeek: [] };
    if (key === thisWeekKey) bucket.thisWeek.push(s.actualReps);
    else if (key === lastWeekKey) bucket.lastWeek.push(s.actualReps);
    acc.set(s.exerciseId, bucket);
  }
  const out: WeeklyDelta[] = [];
  for (const [exerciseId, b] of acc) {
    if (!b.thisWeek.length || !b.lastWeek.length) continue;
    const thisWeek = Math.max(...b.thisWeek), lastWeek = Math.max(...b.lastWeek), delta = thisWeek - lastWeek;
    const name = names[exerciseId] ?? exerciseId;
    const text = delta > 0 ? `${name} 本周 ${thisWeek} 次,比上周多 ${delta} 次`
      : delta < 0 ? `${name} 本周 ${thisWeek} 次,比上周少 ${-delta} 次,先稳住`
      : `${name} 本周和上周一样,都是 ${thisWeek} 次`;
    out.push({ exerciseId, name, thisWeek, lastWeek, delta, text });
  }
  return out.sort((a, b) => b.delta - a.delta);
}
