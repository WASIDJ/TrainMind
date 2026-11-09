// 日常陪伴层（2026-11-09，owner 要求）：训练之外的"照面"。
//
// 背景：一篇减脂软文把"每日监督 + 情绪价值陪伴"当卖点，收费 299/月。owner 的判断是
// "那大概率也是 AI 回的" —— 那我们的机会是把 AI 陪伴做成明牌，且**不靠施压**。
//
// 设计红线（与 D17 一致）：
//   1. 不催、不考核、不制造焦虑。监督的隐含前提是"你缺意志力"，我们不这么看。
//   2. 不评判体重、不给饮食处方、不做医疗判断（甲状腺/多囊这类一律不碰）。
//   3. 不承诺效果。平台期就说平台期，不说"再坚持就能瘦"。
//   4. 不同人群不同语气：这里先预设 `fat_loss`(减重)，结构上预留其他人群。
//
// 话术只由规则产出（facts 来自真实数据），LLM 只负责润色 —— 与剂量/安全无关。

export type CompanionPersona = "fat_loss" | "general";

export type MoodSignal = "self_blame" | "anxious" | "plateau" | "want_quit" | "tired" | "neutral";

export interface CheckInInput {
  persona?: CompanionPersona;
  /** 距上次完成训练的天数；没有记录为 null */
  daysSinceLast: number | null;
  /** 连续训练周数 */
  streakWeeks: number;
  /** 已完成场次总数 */
  totalSessions: number;
  /** 两周以上没练的部位标签（来自肌群账本） */
  neglectedLabels?: string[];
  /** 用户说过的话（用于情绪判断，可空） */
  lastMessage?: string;
  /** 今天是否已经练过（同一自然日） */
  trainedToday?: boolean;
}

export interface CheckIn {
  kind: "first_time" | "trained_today" | "back_soon" | "back_later" | "long_gap" | "streak" | "neglected" | "comfort";
  mood: MoodSignal;
  /** 一句话（≤40 字为宜，语音可直接播） */
  text: string;
  /** 给 LLM 润色时的语气提示；不调模型时忽略 */
  tone: string;
  /** 这句话依据的事实，便于事后核对"它为什么说这句" */
  facts: Record<string, string | number | boolean>;
}

/** 从用户原话里读出情绪。宁可判成 neutral，也不要把普通陈述当成情绪发作。 */
export function classifyMood(text: string | undefined | null): MoodSignal {
  const s = String(text ?? "");
  if (!s.trim()) return "neutral";
  if (/白练|没用|失败|减不下去|我不行|管不住嘴|又吃了|又胖|恨自己|恶心自己/.test(s)) return "self_blame";
  if (/平台|瓶颈|不掉秤|卡住|反弹|一直没变/.test(s)) return "plateau";
  if (/放弃|不想练了|坚持不下去|太难了|撑不住/.test(s)) return "want_quit";
  if (/焦虑|烦躁|睡不着|心慌|压力大|emo/.test(s)) return "anxious";
  if (/累|困|没力气|疲惫|犯懒|不想动/.test(s)) return "tired";
  return "neutral";
}

const MOOD_TEXT: Record<Exclude<MoodSignal, "neutral">, string> = {
  self_blame: "别因为一顿饭给自己定罪。吃多了不等于失败，明天按原计划来就行，我不会翻旧账。",
  anxious: "你现在需要的不是更狠的计划。今天只要动一小会儿就够了，剩下的交给睡眠和规律。",
  plateau: "平台期不是退步，是身体在适应。这时候换动作、调次数比加量更有用——下次我帮你换。",
  want_quit: "不想练是真的，不是你懒。那今天就别按计划来，做五分钟收工也算数。",
  tired: "累了就先歇。休息是计划的一部分，不是欠账。",
};

const PERSONA_TONE: Record<CompanionPersona, string> = {
  fat_loss: "对减重的人说话：不评判体重、不催打卡、不承诺效果；把注意力放在'已经做到的事'和'下一步很小'。",
  general: "通用语气：温和、具体、不说教。",
};

/**
 * 生成今天这一次"照面"。优先级：情绪 > 今天已练 > 长时间没来 > 连续周 > 被落下的部位 > 首次。
 */
export function buildCheckIn(input: CheckInInput): CheckIn {
  const persona = input.persona ?? "fat_loss";
  const mood = classifyMood(input.lastMessage);
  const facts: Record<string, string | number | boolean> = {
    persona, daysSinceLast: input.daysSinceLast ?? -1, streakWeeks: input.streakWeeks, totalSessions: input.totalSessions,
  };
  const tone = PERSONA_TONE[persona];

  if (mood !== "neutral") {
    return { kind: "comfort", mood, text: MOOD_TEXT[mood], tone, facts: { ...facts, mood } };
  }
  if (input.trainedToday) {
    return { kind: "trained_today", mood, text: "今天已经练过了。剩下的交给吃和睡——长肌肉是在休息的时候。", tone, facts };
  }
  if (input.totalSessions === 0) {
    return { kind: "first_time", mood, text: "先不用定什么大目标。今天动十分钟就算开始了，我会按你的状态排。", tone, facts };
  }
  const days = input.daysSinceLast ?? 0;
  if (days >= 14) {
    return { kind: "long_gap", mood, text: `有两周多没见了，这些记录我都留着。想回来就直接开一场，我按你现在的状态排，不按旧计划催。`, tone, facts: { ...facts, days } };
  }
  if (days >= 4) {
    return { kind: "back_later", mood, text: `几天没练了。先动一次就够，量我帮你压小一点，回来比练多少重要。`, tone, facts: { ...facts, days } };
  }
  if (days >= 1) {
    return { kind: "back_soon", mood, text: `上次练完是 ${days} 天前，恢复得差不多了。今天动一动正好接上。`, tone, facts: { ...facts, days } };
  }
  if (input.streakWeeks >= 3) {
    return { kind: "streak", mood, text: `连着 ${input.streakWeeks} 周没断。这种“没停”比某一天练多狠更难，也更值钱。`, tone, facts };
  }
  if (input.neglectedLabels?.length) {
    return { kind: "neglected", mood, text: `${input.neglectedLabels.join("、")}已经很久没练了。下次要不要匀一点给它？不匀也行。`, tone, facts: { ...facts, neglected: input.neglectedLabels.join("、") } };
  }
  return { kind: "back_soon", mood, text: "今天状态怎么样？要不要排一场，按你现在的精力来。", tone, facts };
}
