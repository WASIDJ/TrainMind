// 肌群疲劳账本（2026-11-09）：按肌群聚合真实完成的组，推断恢复状态。
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
  state: MuscleState;
  /** 一句可直接给用户看的话 */
  text: string;
}

export interface LedgerSet {
  exerciseId: string;
  completedAt: string;
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
  const acc = new Map<MuscleGroup, { sets7d: number; sets28d: number; measured7d: number; assumed7d: number; last: number }>();

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
      const row = acc.get(group) ?? { sets7d: 0, sets28d: 0, measured7d: 0, assumed7d: 0, last: 0 };
      if (age <= 7 * DAY) {
        row.sets7d += 1;
        if (set.actualRepsSource === "assumed") row.assumed7d += 1; else row.measured7d += 1;
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
        lastTrainedAt: null, hoursSince: null, recoveryHours: meta.recoveryHours, state: "no_record" as const,
        text: `${meta.label}：还没有记录`,
      };
    }
    const hours = (now - row.last) / 3_600_000;
    // 训练量越大，恢复窗口越久：近 7 天每多 3 组，多给 25% 窗口（上限 1.5 倍）
    const window = Math.round(meta.recoveryHours * Math.min(1.5, 1 + Math.max(0, row.sets7d - 3) / 12));
    const days = hours / 24;
    let state: MuscleState;
    let text: string;
    if (days >= NEGLECT_DAYS) {
      state = "neglected";
      text = `${meta.label}：${Math.floor(days)} 天没练了`;
    } else if (hours >= window) {
      state = "recovered";
      text = `${meta.label}：已恢复（${Math.round(hours)} 小时前练过）`;
    } else if (hours >= window / 2) {
      state = "recovering";
      text = `${meta.label}：恢复中，还需约 ${Math.max(1, Math.round(window - hours))} 小时`;
    } else {
      state = "just_trained";
      text = `${meta.label}：刚练过（${Math.max(1, Math.round(hours))} 小时前）`;
    }
    return {
      group: meta.key, label: meta.label, sets7d: row.sets7d, sets28d: row.sets28d,
      measuredSets7d: row.measured7d, assumedSets7d: row.assumed7d,
      lastTrainedAt: new Date(row.last).toISOString(), hoursSince: Math.round(hours),
      recoveryHours: window, state, text,
    };
  });
}

/** 可以直接用在排课/提示里的两类信号 */
export function ledgerSignals(entries: MuscleLedgerEntry[]) {
  return {
    /** 还没恢复完的部位（排课时应避开或降量） */
    recovering: entries.filter(x => x.state === "just_trained" || x.state === "recovering").map(x => x.group),
    /** 两周以上没练的部位（可以主动提议） */
    neglected: entries.filter(x => x.state === "neglected").map(x => x.group),
    /** 有记录且已恢复，可以正常安排 */
    ready: entries.filter(x => x.state === "recovered").map(x => x.group),
  };
}
