// 肌群疲劳账本（2026-11-09）：按肌群聚合真实完成的组，推断恢复状态。
//
// 主口径（2026-11-10 起）：**每周训练频次**——同一肌群每周 2–3 次是主规则。
//   依据：Schoenfeld BJ, Ogborn D, Krieger JW. Effects of Resistance Training Frequency on
//   Measures of Muscle Hypertrophy: A Systematic Review and Meta-Analysis. Sports Med. 2016.
//   DOI 10.1007/s40279-016-0543-8（见 docs/EVIDENCE-RECOVERY.md 第 2 条，强度：较高，系统综述+meta）。
//   小时数（recoveryHours / recoveryPercent / state）降为**辅助提示**：只用于展示层措辞，
//   不再决定"今天能不能练这个部位"。
//
// 为什么需要它：此前 `RecoveryState` 只有"整场自述"（fresh/fatigued），没有任何按肌群的累计。
// 后果是"今天腿有点酸"只能拼一句安全提示文案，排课照样排深蹲——这既是 Fitbod 的招牌，
// 也是我们自己上一轮复核发现的漏洞（`core.ts` 的过滤链里没有 soreness）。
//
// 设计约束：
//   1. 纯函数 + 不碰剂量：只产出"现状"，怎么用由调用方决定（排课过滤、卡片展示、话术）。
//   2. 只认真实完成的组：`assumed`（按计划推定）也算训练量，但要单独标出来，别和 counted 混谈。
//   3. 命名空间统一：自研动作用 legs/chest/back 这类粗粒度名，RepDB 用 quadriceps/pectoralis_major
//      这类解剖名，这里统一映射到 8 个用户看得懂的部位。
export type MuscleGroup = "chest" | "back" | "shoulders" | "arms" | "core" | "glutes" | "legs" | "calves";

export interface MuscleMeta { key: MuscleGroup; label: string; /** 完全恢复所需小时数（大肌群更久） */ recoveryHours: number }

export const MUSCLE_GROUPS: MuscleMeta[] = [
  { key: "legs", label: "腿", recoveryHours: 72 },
  { key: "glutes", label: "臀", recoveryHours: 48 },
  { key: "back", label: "背", recoveryHours: 48 },
  { key: "chest", label: "胸", recoveryHours: 48 },
  { key: "shoulders", label: "肩", recoveryHours: 36 },
  { key: "arms", label: "手臂", recoveryHours: 36 },
  { key: "core", label: "核心", recoveryHours: 24 },
  { key: "calves", label: "小腿", recoveryHours: 24 },
];

const ALIASES: Record<string, MuscleGroup> = {
  // 自研动作的粗粒度命名
  legs: "legs", glutes: "glutes", chest: "chest", back: "back", core: "core", calves: "calves",
  biceps: "arms", triceps: "arms", rear_delt: "shoulders",
  // RepDB 的解剖命名
  quadriceps: "legs", hamstrings: "legs", hip_flexors: "legs", adductors: "legs",
  gluteus_maximus: "glutes", gluteus_medius: "glutes",
  pectoralis_major: "chest",
  latissimus_dorsi: "back", trapezius: "back", rhomboids: "back", erector_spinae: "back",
  anterior_deltoid: "shoulders", lateral_deltoid: "shoulders", posterior_deltoid: "shoulders",
  biceps_brachii: "arms", brachialis: "arms", triceps_brachii: "arms",
  rectus_abdominis: "core", obliques: "core", transverse_abdominis: "core",
  gastrocnemius: "calves", soleus: "calves",
};

/** 把任意来源的肌群名映射到 8 个部位；认不出返回 null（诚实地说"不认识"） */
export function canonicalMuscle(name: string | undefined | null): MuscleGroup | null {
  const key = String(name ?? "").trim().toLowerCase();
  return key ? (ALIASES[key] ?? null) : null;
}

export type MuscleState = "just_trained" | "recovering" | "recovered" | "neglected" | "no_record";

/**
 * 每周训练频次目标：同一肌群每周 2–3 次。
 * 出处：Schoenfeld 2016 频率 meta（DOI 10.1007/s40279-016-0543-8）。
 * 注意：meta 比的是"同等周训练量下 2–3 次 vs 1 次"，不能说成"4 次有害"；
 * 所以超过上限时我们的做法是**这一周不再给这个部位加容量**，不是判它有伤。
 */
export const WEEKLY_FREQUENCY_TARGET = { min: 2, max: 3, ruleId: "muscle-weekly-frequency-v1" } as const;

export type FrequencyStatus = "none" | "below" | "in_range" | "above";

// 同一部位两次【力量】训练之间的最短间隔：24 小时。
//
// 出处（Europe PMC 2026-11-10 核实，见 docs/EVIDENCE-RECOVERY.md 第 6、7 条）：
//   MacDougall JD, et al. The time course for elevated muscle protein synthesis following heavy
//   resistance exercise. Can J Appl Physiol. 1995. DOI 10.1139/h95-038
//   → 一次高强度后 MPS +50%(4h)、+109%(24h)，36h 基本回到基线。24h 还在峰值 = 修复没完成。
//   深蹲 5x5@80%1RM 后膝伸肌力量与纵跳下降持续到 +72h（女性更久）。DOI 10.3389/fphys.2018.01480
//   练到力竭会进一步延长恢复，24–48h 才回来。DOI 10.1007/s00421-017-3725-7
//
// 边界：这些证据针对的是"同一部位再做高强度"，不是"动一动也不行"。所以只拦力量动作，
// 低强度活动（快走、活动度）照旧保留——与酸痛处理同一条口径。
// 另外"糖原要 24–48h 才恢复"这个常见说法不成立：高强度后糖原合成速率 15–33 mmol/kg/h，
// 远快于长时间有氧（1996 综述 DOI 10.2165/00007256-199621020-00003），不能拿它当拦截依据。
export const MIN_SAME_MUSCLE_INTERVAL_HOURS = 24;
export const MIN_SAME_MUSCLE_INTERVAL_RULE_ID = "muscle-min-interval-24h-v1";

// 备注：神经肌肉功能要 48–72h 才完全回来（DOI 10.3389/fphys.2018.01480），
// 所以 24h 只是"不再硬塞"的下限，不是"练了就够"的标准。展示层因此仍保留"建议明天"这类措辞。

export type IntervalStatus = "none" | "too_soon" | "ok";

export interface MuscleLedgerEntry {
  group: MuscleGroup;
  label: string;
  /** 近 7 天完成组数（含 assumed，但另有 split 字段说明） */
  sets7d: number;
  sets28d: number;
  /** 其中"系统数/用户报"的实测组 vs 按计划推定的组 */
  measuredSets7d: number;
  assumedSets7d: number;
  lastTrainedAt: string | null;
  hoursSince: number | null;
  recoveryHours: number;
  /** 0–100 的恢复度（已过时间 / 恢复窗口）。没有记录为 null —— 不假装 0% */
  recoveryPercent: number | null;
  state: MuscleState;
  /** 一句可直接给用户看的话（按小时，辅助提示） */
  text: string;
  /** 近 7 天**训练次数**（按会话去重，不是组数）——恢复约束的主口径 */
  sessions7d: number;
  frequencyStatus: FrequencyStatus;
  /** 一句可直接给用户看的频次说明（主口径） */
  frequencyText: string;
  /** 距上次训练的小时间隔够不够做【力量】训练（24h 硬线，依据 MPS 时程） */
  intervalStatus: IntervalStatus;
}

export interface LedgerSet {
  exerciseId: string;
  completedAt: string;
  /** 会话 ID：频次按会话去重；缺省时退化为"按日期去重"（老调用方没有这个字段） */
  sessionId?: string;
  actualRepsSource?: "counted" | "reported" | "assumed";
  pain?: boolean;
}

export interface BuildLedgerInput {
  sets: LedgerSet[];
  /** exerciseId → 该动作训练的肌群名（primaryMuscles 原样传入，内部再映射） */
  musclesByExercise: Record<string, string[]>;
  now?: number;
}

const DAY = 86_400_000;
/** 超过这个天数没练，就算"被落下" */
export const NEGLECT_DAYS = 14;

export function buildMuscleLedger(input: BuildLedgerInput): MuscleLedgerEntry[] {
  const now = input.now ?? Date.now();
  const acc = new Map<MuscleGroup, { sets7d: number; sets28d: number; measured7d: number; assumed7d: number; last: number; sessions: Set<string> }>();

  for (const set of input.sets) {
    const at = Date.parse(set.completedAt);
    if (!Number.isFinite(at)) continue;
    const age = now - at;
    if (age < 0) continue; // 未来时间（时钟漂移/脏数据）不计入
    const muscles = new Set<MuscleGroup>();
    for (const raw of input.musclesByExercise[set.exerciseId] ?? []) {
      const g = canonicalMuscle(raw);
      if (g) muscles.add(g);
    }
    for (const group of muscles) {
      const row = acc.get(group) ?? { sets7d: 0, sets28d: 0, measured7d: 0, assumed7d: 0, last: 0, sessions: new Set<string>() };
      if (age <= 7 * DAY) {
        row.sets7d += 1;
        if (set.actualRepsSource === "assumed") row.assumed7d += 1; else row.measured7d += 1;
        // 频次按"会话"去重（同一天练两组不算两次）；老调用方没有 sessionId 时退化为按日期
        row.sessions.add(set.sessionId ?? `day:${set.completedAt.slice(0, 10)}`);
      }
      if (age <= 28 * DAY) row.sets28d += 1;
      if (at > row.last) row.last = at;
      acc.set(group, row);
    }
  }

  return MUSCLE_GROUPS.map(meta => {
    const row = acc.get(meta.key);
    if (!row || !row.last) {
      return {
        group: meta.key, label: meta.label, sets7d: 0, sets28d: 0, measuredSets7d: 0, assumedSets7d: 0,
        lastTrainedAt: null, hoursSince: null, recoveryHours: meta.recoveryHours, recoveryPercent: null, state: "no_record" as const,
        text: `${meta.label}：还没有记录`,
        sessions7d: 0, frequencyStatus: "none" as const, frequencyText: `${meta.label}：本周还没练`,
        intervalStatus: "none" as const,
      };
    }
    const hours = (now - row.last) / 3_600_000;
    // 训练量越大，恢复窗口越久：近 7 天每多 3 组，多给 25% 窗口（上限 1.5 倍）
    const window = Math.round(meta.recoveryHours * Math.min(1.5, 1 + Math.max(0, row.sets7d - 3) / 12));
    const days = hours / 24;
    // 恢复度百分比（2026-11-10）：用于"它越来越懂你"的可感知表达；被落下仍单独标记
    const recoveryPercent = Math.max(0, Math.min(100, Math.round((hours / window) * 100)));
    let state: MuscleState;
    let text: string;
    if (days >= NEGLECT_DAYS) {
      state = "neglected";
      text = `${meta.label}：${Math.floor(days)} 天没练了`;
    } else if (hours >= window) {
      state = "recovered";
      text = `${meta.label}：可以练了（${Math.floor(days) || 1} 天前练过）`;
    } else if (hours >= window / 2) {
      state = "recovering";
      text = `${meta.label}：还在恢复 · 建议明天`;
    } else {
      state = "just_trained";
      text = `${meta.label}：今天刚练过 · 建议明天`;
    }
    const sessions7d = row.sessions.size;
    const intervalStatus: IntervalStatus = hours < MIN_SAME_MUSCLE_INTERVAL_HOURS ? "too_soon" : "ok";
    const frequencyStatus: FrequencyStatus = sessions7d === 0 ? "none" : sessions7d < WEEKLY_FREQUENCY_TARGET.min ? "below" : sessions7d <= WEEKLY_FREQUENCY_TARGET.max ? "in_range" : "above";
    const frequencyText = frequencyStatus === "none" ? `${meta.label}：本周还没练`
      : frequencyStatus === "below" ? `${meta.label}：本周 ${sessions7d} 次（建议每周 ${WEEKLY_FREQUENCY_TARGET.min}–${WEEKLY_FREQUENCY_TARGET.max} 次）`
      : frequencyStatus === "in_range" ? `${meta.label}：本周 ${sessions7d} 次，正好在该练的次数里`
      : `${meta.label}：本周 ${sessions7d} 次，已超过 ${WEEKLY_FREQUENCY_TARGET.max} 次，本周先不加量`;
    return {
      group: meta.key, label: meta.label, sets7d: row.sets7d, sets28d: row.sets28d,
      measuredSets7d: row.measured7d, assumedSets7d: row.assumed7d,
      lastTrainedAt: new Date(row.last).toISOString(), hoursSince: Math.round(hours),
      recoveryHours: window, recoveryPercent, state, text,
      sessions7d, frequencyStatus, frequencyText, intervalStatus,
    };
  });
}

/** 可以直接用在排课/提示里的信号 */
export function ledgerSignals(entries: MuscleLedgerEntry[]) {
  return {
    /** 还没恢复完的部位（按小时的辅助提示，只用于措辞，不再作为排课主约束） */
    recovering: entries.filter(x => x.state === "just_trained" || x.state === "recovering").map(x => x.group),
    /** 两周以上没练的部位（可以主动提议） */
    neglected: entries.filter(x => x.state === "neglected").map(x => x.group),
    /** 有记录且已恢复，可以正常安排 */
    ready: entries.filter(x => x.state === "recovered").map(x => x.group),
    /** 本周次数已超过 2–3 次上限的部位（排课主约束） */
    overFrequency: entries.filter(x => x.frequencyStatus === "above").map(x => x.group),
    /** 本周次数还不够 2 次的部位（可以主动补一次） */
    underFrequency: entries.filter(x => x.frequencyStatus === "below").map(x => x.group),
  };
}
