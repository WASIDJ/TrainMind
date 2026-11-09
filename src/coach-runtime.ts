// Device-independent orchestration. Dose calculations and safety decisions belong to core.
export type CoachPhase = "READY" | "START_SET" | "REP_GUIDANCE" | "SET_COMPLETE" | "FEEDBACK" | "REST" | "NEXT_SET";
export type CoachFeedback = "too_heavy" | "too_light";
export interface CoachState {
  phase: CoachPhase;
  phaseStartedAt: string;
  awaitingCompletion: boolean;
  pendingFeedback?: CoachFeedback;
  safetyStopped?: boolean;
  /** D14 Agency 层:学员报告吃力后,下一组的走法由学员三选一(未选则到期默认降档) */
  pendingAgency?: { scope?: "set" | "exercise"; actualReps: number; actualWeight?: number; feedback: CoachFeedback }; // D16-B:scope=exercise 时三选一作用于下一动作
  /** 本组内"喊停"被追问过几次(0=还没问;1=问过一次,再喊就真的停) */
  stopProbes?: number;
}

// ── 喊停三段式(2026-11-05):疼痛立刻停;疲惫先问原因并推一把;第二次喊才收工 ──
// 理由:一累就歇不是训练。教练要区分"累"和"不对劲",但不能盘问超过一次。
export type StopIntent = "pain" | "exhaustion" | "hard_stop";

export function classifyStopIntent(raw: string): StopIntent | null {
  const t = String(raw ?? "").replace(/[\s，,。！？!?~～、]/g, "");
  const negated = /不疼|不痛|没(?:有)?(?:疼|痛)|还好|没事/.test(t);
  // 安全优先:任何疑似身体异常都按疼痛处理(红旗词表在服务端另有更高优先级)
  if (!negated && /疼|痛|不舒服|发麻|麻了|头晕|晕|胸闷|心慌|心悸|喘不上气|上不来气|恶心|想吐/.test(t)) return "pain";
  if (/跳过|换动作|换个动作|结束训练|不练了|退出|结束这场/.test(t)) return "hard_stop";
  const tired = /累|不行了|撑不住|做不动|没劲|顶不住|力竭|歇一下|休息一下|喘一下|停/.test(t) && !/不累|还能撑|没事/.test(t);
  if (tired) return "exhaustion";
  return null;
}

/** 第一次喊停:问原因 + 推一把;短句,不给用户做选择题的负担 */
export function probeStopPrompt(remainingReps?: number): string {
  const push = remainingReps && remainingReps > 0 ? `还剩 ${remainingReps} 个。` : "能顶就再顶一下。";
  return `是累，还是哪儿不对劲？${push}`;
}
export const AdjustmentPolicyV0 = { id: "AdjustmentPolicyV0", too_heavy: -0.10, too_light: 0.05 } as const;
export type CoachEvent =
  | { type: "start_set" | "guidance_started" | "guidance_finished" | "feedback_saved" | "rest_finished" | "next_set" }
  | { type: "user_report"; completed?: boolean; feedback?: CoachFeedback; actualReps?: number; actualWeight?: number; right?: boolean; actualRepsSource?: "counted" | "reported" | "assumed" }
  | { type: "agency_choice"; choice: "accept_cut" | "hold_on" | "bargain" | "next_down" | "stay" | "skip_next" }
  | { type: "substitute" }
  | { type: "time_constraint"; remainingMinutes: number }
  | { type: "pain" };

/** 中文数字 → 数值(1–99);无法解析返回 NaN。供 parseCoachReport 的时长口令使用。 */
export function spokenChineseNumber(value: string): number {
  if (/^\d+$/.test(value)) return Number(value);
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value.includes("十")) { const [a, b] = value.split("十"); return (a ? digits[a] : 1) * 10 + (b ? digits[b] : 0); }
  const single = digits[value];
  return single === undefined ? Number.NaN : single;
}
export type CoachDirective =
  | { action: "none" }
  | { action: "speak"; text: string }
  | { action: "confirm_completion"; text: string }
  | { action: "agency_offer"; text: string }
  | { action: "collect_feedback"; text: string }
  | { action: "adjust_next_set"; adjustment: { policy: "AdjustmentPolicyV0"; weightRatio: number }; feedback: CoachFeedback }
  | { action: "safety_stop"; text: string };
export function createCoachState(now: string): CoachState {
  return { phase: "READY", phaseStartedAt: now, awaitingCompletion: false };
}
export function transitionCoach(state: CoachState, event: CoachEvent, now: string): { state: CoachState; directive: CoachDirective } {
  const next = { ...state };
  const phase = (value: CoachPhase) => { if (next.phase !== value) { next.phase = value; next.phaseStartedAt = now; } };
  let directive: CoachDirective = { action: "none" };
  if (event.type === "pain") {
    next.safetyStopped = true;
    directive = { action: "safety_stop", text: "先停止当前动作，安全放下负重。训练已暂停。" };
  } else if (next.safetyStopped) {
    directive = { action: "speak", text: "疼痛后不能直接继续这个动作，请先结束本次训练。" };
  } else if (event.type === "start_set" && next.phase === "READY") {
    phase("START_SET");
  } else if (event.type === "guidance_started" && next.phase === "START_SET") {
    phase("REP_GUIDANCE");
  } else if (event.type === "guidance_finished" && next.phase === "REP_GUIDANCE") {
    phase("SET_COMPLETE"); next.awaitingCompletion = true;
    directive = { action: "confirm_completion", text: "这组感觉怎么样？" }; // D16-C:认知负荷在系统侧——只问感受一个词,次数由系统自己记
  } else if (event.type === "user_report" && ["START_SET", "REP_GUIDANCE", "SET_COMPLETE", "FEEDBACK"].includes(next.phase)) {
    if (event.feedback) next.pendingFeedback = event.feedback;
    if (event.completed === true) { phase("FEEDBACK"); next.awaitingCompletion = false; }
    else if (event.completed === false || next.phase !== "FEEDBACK") {
      if (event.completed === false && next.phase === "FEEDBACK") phase("REP_GUIDANCE");
      next.awaitingCompletion = true;
      directive = { action: "confirm_completion", text: event.completed === false ? "不急，做完了叫我。" : "这组做完了吗？" };
    }
    if (next.phase === "FEEDBACK") {
      directive = next.pendingFeedback
        ? { action: "adjust_next_set", adjustment: { policy: "AdjustmentPolicyV0", weightRatio: AdjustmentPolicyV0[next.pendingFeedback] }, feedback: next.pendingFeedback }
        : { action: "collect_feedback", text: "感觉太轻、太重还是正好？" };
    }
  } else if (event.type === "feedback_saved" && next.phase === "FEEDBACK") {
    phase("REST"); delete next.pendingFeedback; next.awaitingCompletion = false;
  } else if (event.type === "rest_finished" && next.phase === "REST") {
    phase("NEXT_SET");
  } else if (event.type === "next_set" && next.phase === "NEXT_SET") {
    phase("READY");
  }
  return { state: next, directive };
}

// Only MVP feedback and completion reports; this is not a general language parser.
export function parseCoachReport(raw: string): CoachEvent | undefined {
  const text = raw.replace(/[\s，,。！？!?]/g, "");
  if (/怎么|为什么|是否|是不是|能不能/.test(text)) return undefined;
  const pain = !/不疼|不痛|没(?:有)?(?:疼|痛)|没有.*(?:疼|痛)/.test(text) && /疼|痛|(?:膝盖|肩膀|腰|身体).*不舒服/.test(text);
  if (pain) return { type: "pain" };
  // C1(7B.2 裁决):器械不可用 → 动作替换意图;仅匹配陈述式口令(疑问句已在上方过滤)
  if (/器械.{0,4}(有人|被占|占用|占着|用不了|不能用|不行)|(?:帮我)?(?:换一个|换个动作)|这个做不了|这动作做不了/.test(text)) return { type: "substitute" };
  // C2(7B.2 裁决):“只剩 N 分钟” → 时间约束口令
  const timeLeft = text.match(/(?:只剩|只有|还剩|剩下)([\d零一二两三四五六七八九十]+)分钟/);
  if (timeLeft) {
    const minutes = spokenChineseNumber(timeLeft[1]!);
    if (Number.isFinite(minutes) && minutes >= 1 && minutes <= 180) return { type: "time_constraint", remainingMinutes: minutes };
  }
  const feedback = /太重|偏重|有点重|有些重|感觉重|太沉|有点沉|吃力|轻一点|轻一些/.test(text) ? "too_heavy" : /太轻|偏轻|有点轻|有些轻|感觉轻|太轻松|很轻松|轻松|重一点|重一些/.test(text) ? "too_light" : undefined;
  const incomplete = /还没|没做完|未完成/.test(text);
  const completed = incomplete ? false : /做完了|完成了|完成本组|^完成$|^做完$/.test(text) ? true : undefined;
  const count = text.match(/(?:做了|做完了|完成了|实际|^)([\d零一二两三四五六七八九十]+)(?:次|个)/);
  const number = (value: string) => {
    if (/^\d+$/.test(value)) return Number(value);
    const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    const [a, b] = value.split("十");
    return value.includes("十") ? (a ? digits[a] : 1) * 10 + (b ? digits[b] : 0) : digits[value];
  };
  const weight = text.match(/(?:实际|用了|重量)(\d+(?:\.\d+)?)(?:公斤|kg)/i);
  const right = /正好|刚好|合适/.test(text);
  if (!feedback && completed === undefined && !count && !weight && !right) return undefined;
  return { type: "user_report", ...(feedback ? { feedback } : {}), ...(completed !== undefined ? { completed } : {}), ...(count ? { actualReps: number(count[1]) } : {}), ...(weight ? { actualWeight: Number(weight[1]) } : {}), ...(right ? { right: true } : {}) };
}
