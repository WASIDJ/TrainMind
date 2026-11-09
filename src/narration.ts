// 教练人格层 v1 —— Bloom(CHI 2026)方法移植,设计见《trainmind-教练人格层设计.md》
// 分层铁律:规则层(core.ts)决定"做什么"(剂量/安全/状态机);本模块只决定"怎么说"。
// LLM 任何失效(超时/超长/禁语/数字错)自动回退规则模板 —— 永不哑、永不慢于现状。
import { exercises, type WorkoutSession } from "./core.ts";

export type NarrationSlot = "set_intro" | "feedback" | "confirm" | "rest" | "effort_cue";
export type NarrationFallback = "timeout" | "length" | "banned" | "number" | "empty" | "error";
export type NarrationLlm = (systemPrompt: string, userPrompt: string) => Promise<string>;

// ── 安全:医学红旗(规则分类,命中即固定话术,永不经过 LLM)──
export const RED_FLAG = /胸痛|胸闷|胸口闷|胸口堵|胸口疼|心悸|心慌|头晕|眼前发黑|眼前一黑|恶心|想吐|要吐|快吐|反胃|呕吐|呼吸困难|喘不上气|上不来气|受伤|扭伤|脱臼|骨折|拉伤/;
export const RED_FLAG_TEXT = "这个情况先停下来，别硬撑。休息一下，如果持续或加重，请找专业人员看看。今天的训练可以到此为止。";

const BANNED = /减肥|节食|药物|你这是|诊断为|没事的?继续/;

// ── 槽位映射:哪些话交给 LLM,哪些直通 ──
export function slotOf(directive: { action: string; text?: unknown }, session: WorkoutSession): NarrationSlot | null {
  if (typeof directive.text !== "string" || !directive.text) return null;
  if (directive.action === "safety_stop") return null; // 安全话术永不叙事
  if (directive.action === "confirm_completion") return "confirm";
  if (directive.action === "collect_feedback") return "feedback";
  if (directive.action === "speak") {
    // 域状态优先于教练子状态:resting/set_feedback 期间的 speak 语义上必属该场景
    if (session.status === "resting") return "rest";
    if (session.status === "set_feedback") return "feedback";
    if (session.runtime.coach?.phase === "START_SET") return "set_intro";
  }
  return null;
}

// ── 人设(定稿版,见设计文档 §4;MI 精髓压缩为三条:具体肯定/自我宽恕/单问句)──
const PERSONA = `你是 TrainMind 的力量训练教练,通过语音陪学员完成今天的力量训练。

学员画像:成年普通训练者,正在组间,可能喘着气,只想听短话。

说话方式(硬约束):
- 组内只说一句,不超过 30 字;组间/结束最多两句话,口语,像靠谱的私教朋友,不喊口号不鸡汤
- 组内(宣布开始、鼓励顶住、宣布休息)不许提问;只在你真的需要学员做选择时才给选项
- 数字用阿拉伯数字(如 8 次、20 公斤、75 秒)
- 具体称呼动作与组数;学员刚说的话,先用半句接住,再给指令
- 学员完成得好,具体地肯定(他做了什么);学员失败或吃力,不指责,直接给降一档的方案
- 一次最多问一个问题;能不问就不问
- 给出方案变化时,依据必须织进语气里,禁止用"因为…所以…""由于…"的因果句式(例:不说"因为你第6次抖了所以降到20",要说"这组到最后有点散了,下一组收一收,20公斤稳着做")

边界(硬约束):
- 禁止自创任何问句:模板里有问题才可以(改写)问题,模板是陈述句时输出绝不能出现问号。学员答不上来的问题(如"第几次开始吃力")永远不许出现
- 模板若含「本动作完成」，说明这个动作没有下一组:禁止提及「下一组」或预告下一动作
- 只谈今天的训练;不谈减重、饮食、药物、伤病诊断
- 学员描述疼痛或不适时,只说"先停下来",不给任何判断
- 你不决定重量和组数,方案里的数字必须与【本组方案】一字不差

只输出你要说的话本身,不要任何前缀、解释或引号。`;

const SLOT_INTENT: Record<NarrationSlot, string> = {
  set_intro: "宣布即将开始的一组:动作、第几组、负重或自重、建议次数;可以带半句历史呼应,然后让学员开始。",
  feedback: "回应学员刚说的话:先接住他的感受,再给出下一组方案(重量或次数变化);最多一个问题。",
  confirm: "确认学员报告的完成情况,语气干净利落,不追问难度(难度稍后在反馈屏收集)。",
  rest: "宣布进入组间休息:肯定刚完成的一组,报休息秒数,预告下一组。",
  // 组内听觉感知 v1(《组内听觉感知设计》§3):时机引擎已决定"值得说",本槽只措辞;
  // 证据=听到的努力曲线摘要;禁止数字(数字属于计数链路),禁止提问(学员正在喘气)。
  effort_cue: "给正在组内发力或喘气的学员一句极短的陪练话(一句话,不超过15字):接住他此刻的状态。禁止出现任何数字,禁止任何问句。",
};

function runtimeContext(session: WorkoutSession): string {
  const x = session.exercises[session.runtime.currentExerciseIndex];
  if (!x) return "(无动作)";
  const lines = [
    `动作:${x.name}`,
    `第 ${session.runtime.currentSetNumber} 组 / 共 ${x.sets} 组`,
    `负重:${x.currentWeight ? `${x.currentWeight} 公斤` : "自重"}`,
    `目标:${x.targetReps}`,
    `阶段:${session.status}${session.runtime.coach ? `/${session.runtime.coach.phase}` : ""}`,
  ];
  if (session.status === "resting" && session.runtime.restEndsAt) {
    lines.push(`休息秒数:${Math.max(0, Math.ceil((Date.parse(session.runtime.restEndsAt) - Date.now()) / 1000))}`);
  }
  return lines.join(";");
}

// ── 学员风格画像(D14:行为统计驱动,非问卷;连续配比不用硬桶) ──
export interface StyleStats { acceptCut: number; holdOn: number; bargain: number; totalChoices: number; completionRate: number | null }
export function stylePreset(stats: StyleStats): { name: string; tone: string } {
  if (stats.totalChoices < 2) return { name: "新学员", tone: "还没有足够风格数据:默认温和专业,先观察" };
  const holdRate = stats.holdOn / stats.totalChoices, cutRate = stats.acceptCut / stats.totalChoices, dealRate = stats.bargain / stats.totalChoices;
  if (holdRate >= 0.5 && (stats.completionRate ?? 1) >= 0.8) return { name: "嘴硬且扛得住", tone: "少夸多激,契约式:他要硬就陪他硬,完成就认账" };
  if (holdRate >= 0.5) return { name: "嘴硬但数据跟不上", tone: "看数字不看宣言:不哄不贬,直接用他上组的实际数字说话" };
  if (dealRate >= 0.4) return { name: "谈判型", tone: "交易感:给选项、让小利、守底线,像谈判桌上互相给面子的对手" };
  if (cutRate >= 0.7 && (stats.completionRate ?? 1) < 0.5) return { name: "挫败/低自信", tone: "队友式:降门槛、微小胜利也要具体地认,绝不用激将" };
  if (cutRate >= 0.6) return { name: "实在人", tone: "干脆直接:少废话,指令清晰,肯定要具体" };
  return { name: "混合", tone: "多数时候实在,偶尔嘴硬:默认干脆,他嘴硬的那一下陪他硬一次" };
}

export function buildPrompts(opts: { slot: NarrationSlot; session: WorkoutSession; templateText: string; userText?: string | null; memoryFacts: string; evidence?: string | null; styleStats?: StyleStats | null }): { system: string; user: string } {
  const style = opts.styleStats ? stylePreset(opts.styleStats) : null;
  const user = [
    `【学员近况】${opts.memoryFacts}`,
    style ? `【学员风格】${style.name}(${opts.styleStats!.totalChoices} 次选择:降档 ${opts.styleStats!.acceptCut}/硬扛 ${opts.styleStats!.holdOn}/讨价 ${opts.styleStats!.bargain};近期完成率 ${opts.styleStats!.completionRate === null ? "未知" : Math.round(opts.styleStats!.completionRate * 100) + "%"}) — 语气:${style.tone}` : "",
    `【当前现场】${runtimeContext(opts.session)}`,
    `【本组方案】${opts.templateText}`,
    opts.evidence ? `【本组依据】${opts.evidence}` : "",
    opts.userText ? `【学员原话】${opts.userText}` : "",
    `【你要说的话的意图】${SLOT_INTENT[opts.slot]}`,
    "只输出你要说的话本身。",
  ].filter(Boolean).join("\n");
  return { system: PERSONA, user };
}

// ── 输出守卫:任一不达标整句回退模板(不局部修补,保证语义完整)──
// ── 话术硬约束(2026-11-05 D17):组内短、且只在允许的时机提问 ──
// 喘着气听不了长句;问句只在"整场结束(feedback)"与"真的卡住(effort_cue 的退路)"出现。
export const SLOT_MAX_CHARS: Record<NarrationSlot, number> = { set_intro: 30, effort_cue: 30, rest: 30, confirm: 40, feedback: 60 };
export const SLOT_ALLOWS_QUESTION: Record<NarrationSlot, boolean> = { set_intro: false, effort_cue: true, rest: false, confirm: false, feedback: true };

export function guardNarration(output: string, templateText: string, slot?: NarrationSlot, allowedSources = ""): NarrationFallback | null {
  const text = output.trim().replace(/^[「『"'“]+/, "").replace(/[」』"'”]+$/, "");
  if (!text) return "empty";
  const maxChars = slot ? SLOT_MAX_CHARS[slot] : 80;
  if (text.length > maxChars) return "length";
  // 组内不许反问(除了明确允许的槽位);模板本身带问号时放行,避免误伤既有话术
  const templateAsks = /[？?]/.test(templateText);
  if (slot && !SLOT_ALLOWS_QUESTION[slot] && !templateAsks && /[？?]/.test(text)) return "banned";
  if (BANNED.test(text)) return "banned";
  // 数字核验(双向):
  // ① 规则模板里的每个数字串都必须在叙事中原样出现(词边界匹配,"18"不顶替"8")
  for (const token of templateText.match(/\d+/g) ?? []) {
    if (!new RegExp(`(?<!\\d)${token}(?!\\d)`).test(text)) return "number";
  }
  // ② A1(2026-11-09):叙事里出现的每个数字串也必须能追溯到规则层
  // (模板 / 记忆事实 / 证据短语)。此前只做了 ①,LLM 自己追加的
  // "最后一组加到 20 次""再加 5 公斤"能整句过门 —— 等于让 LLM 改剂量。
  const allowed = new Set(`${templateText} ${allowedSources}`.match(/\d+/g) ?? []);
  for (const token of text.match(/\d+/g) ?? []) {
    if (!allowed.has(token)) return "number";
  }
  return null;
}

/** A3(2026-11-09):模板话术同样受槽位字数上限约束。
 *
 * 30 字上限此前只量 LLM 输出,而降级路径(未开叙事 / LLM 超时 / 守门拒绝)念的是模板本身。
 * 组内模板曾把动作要领整句拼进来:实测 102 个动作全部超 30 字(中位 95 字、最长 184 字),
 * 等于铁律 3 在最常见的路径上不成立。
 * 裁剪策略:优先截到首个句号(语义完整);仍超长则硬截到上限并补句号。
 */
export function clampTemplate(templateText: string, slot?: NarrationSlot): string {
  const maxChars = slot ? SLOT_MAX_CHARS[slot] : 80;
  const text = templateText.trim();
  if (text.length <= maxChars) return text;
  const firstSentence = text.match(/^[^。！？!?]*[。！？!?]/)?.[0]?.trim();
  if (firstSentence && firstSentence.length <= maxChars) return firstSentence;
  return `${text.slice(0, Math.max(1, maxChars - 1)).replace(/[，,、；;：:\s]+$/, "")}。`;
}

// ── 记忆:近 7 天 set_records 事实(规则拼装,确定性,不做 LLM 摘要)──
export interface MemoryRow { startedAt: number; exerciseId: string; difficulty: string | null; actualReps: number | null; setNumber: number }
const DAY = 24 * 3600 * 1000;

export function buildMemoryFacts(rows: MemoryRow[], now = Date.now(), currentExerciseId?: string): string {
  if (!rows.length) return "(新学员,今天是第一次训练)";
  const byDay = new Map<string, number>();
  for (const r of rows) byDay.set(new Date(r.startedAt).toISOString().slice(0, 10), (byDay.get(new Date(r.startedAt).toISOString().slice(0, 10)) ?? 0) + 1);
  const days = [...byDay.keys()].sort();
  const sessionCount = days.length;
  const lastDay = days[days.length - 1]!;
  const daysAgo = Math.floor((now - Date.parse(lastDay + "T12:00:00Z")) / DAY);
  const when = daysAgo <= 0 ? "今天" : daysAgo === 1 ? "昨天" : daysAgo === 2 ? "前天" : `${daysAgo}天前`;
  // streak:连续训练天数(以最近一次训练日为端点向前数)
  let streak = 1;
  for (let i = days.length - 1; i > 0 && Date.parse(days[i - 1]! + "T12:00:00Z") === Date.parse(days[i]! + "T12:00:00Z") - DAY; i--) streak++;
  // 最近一次"吃力/偏轻"反馈:优先当前动作(设计文档 §6"同动作"),无则退回任意动作
  const isFeedback = (r: MemoryRow) => r.difficulty === "hard" || r.difficulty === "easy";
  const fb = (currentExerciseId ? rows.find(r => r.exerciseId === currentExerciseId && isFeedback(r)) : undefined) ?? rows.find(isFeedback);
  const fbName = fb ? exercises.find(e => e.id === fb.exerciseId)?.name : undefined;
  const fbText = fb && fbName ? `;上次${fbName}反馈${fb.difficulty === "hard" ? "吃力" : "偏轻"}` : "";
  const facts = `近7天练了${sessionCount}次,最近一次是${when}${fbText};已连续${streak}天训练。`;
  return facts.length <= 120 ? facts : facts.slice(0, 117) + "…";
}

// ── 主函数:叙事化一条指令;失败必回退模板 ──
export async function narrate(opts: {
  directive: { action: string; text: string };
  session: WorkoutSession;
  slot: NarrationSlot;
  templateText: string;
  userText?: string | null;
  memoryFacts: string;
  evidence?: string | null;
  styleStats?: StyleStats | null;
  llm: NarrationLlm;
}): Promise<{ text: string; fallback: NarrationFallback | null }> {
  const { system, user } = buildPrompts({ slot: opts.slot, session: opts.session, templateText: opts.templateText, userText: opts.userText, memoryFacts: opts.memoryFacts, evidence: opts.evidence, styleStats: opts.styleStats });
  let output: string;
  try {
    output = await opts.llm(system, user);
  } catch (e) {
    return { text: clampTemplate(opts.templateText, opts.slot), fallback: /timeout|abort/i.test(String((e as Error)?.cause ?? e)) ? "timeout" : "error" };
  }
  const reason = guardNarration(output, opts.templateText, opts.slot, [opts.memoryFacts, opts.evidence].filter(Boolean).join(" "));
  if (reason) return { text: clampTemplate(opts.templateText, opts.slot), fallback: reason };
  return { text: output.trim().replace(/^[「『"'“]+/, "").replace(/[」』"'”]+$/, ""), fallback: null };
}
