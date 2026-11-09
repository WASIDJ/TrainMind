// D27（2026-11-09，owner 要求）：把"别人给的训练计划"导入成我们的结构。
//
// 输入可以是链接（B站/YouTube，走 yt-dlp + whisper 拿文本）或直接粘贴文字。
// 这里只做**纯函数**：URL 识别、动作名匹配、适合性判定、剂量换算。
// 网络抓取与 LLM 抽取在 server 侧，方便测试与替换。
//
// 铁律边界（重要）：
//   1. 视频里的数字属于"计划目标"，不是"实际完成"。三态（counted/reported/assumed）
//      描述的是**用户做完了几次**，与这里无关，不许混用。
//   2. 安全判定永远优先于原数字：命中医嘱禁忌（膝痛/腰痛/肩痛）一律标不合适，
//      哪怕用户说"我就要照原样练"。
//   3. owner 裁决（D27）：剂量**照原数字**，但必须逐项标注我们的建议，让用户看得见差异。

export type ImportPlatform = "bilibili" | "youtube" | "douyin" | "xiaohongshu" | "other";

export interface DetectedSource {
  platform: ImportPlatform;
  /** bilibili: BV 号；youtube: videoId；douyin: aweme id（能拿到才给） */
  id: string | null;
  /** 规范化后的可抓取 URL（抖音短链需先解析重定向，这里给原样） */
  url: string;
  /** 这个平台我们能不能自动抓文本（不能就必须让用户粘贴） */
  autoFetch: boolean;
}

/** 从一段文字里认出平台与 id。认不出就按 other 处理（用户必须粘贴正文）。 */
export function detectSource(raw: string): DetectedSource | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const bili = text.match(/(?:bilibili\.com\/video\/)?(BV[0-9A-Za-z]{10})/);
  if (bili) return { platform: "bilibili", id: bili[1]!, url: `https://www.bilibili.com/video/${bili[1]}`, autoFetch: true };
  const yt = text.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  if (yt) return { platform: "youtube", id: yt[1]!, url: `https://www.youtube.com/watch?v=${yt[1]}`, autoFetch: true };
  const dy = text.match(/(?:douyin\.com\/(?:video|note)\/|v\.douyin\.com\/)([A-Za-z0-9_-]+)/);
  if (dy) return { platform: "douyin", id: dy[1]!, url: text, autoFetch: false };
  if (/xiaohongshu\.com|xhslink\.com/.test(text)) return { platform: "xiaohongshu", id: null, url: text, autoFetch: false };
  return null;
}

// ── 剂量文本解析 ─────────────────────────────────────────────
export interface ParsedDose { sets?: number; repsMin?: number; repsMax?: number; weightKg?: number; seconds?: number }

/** 解析"3组×12次""3 x 10-12""每组15个""4 组，共 40 次""2组×30秒" */
export function parseDoseText(text: string | undefined | null): ParsedDose {
  const s = String(text ?? "");
  const dose: ParsedDose = {};
  // "3组" / "3 sets" / "3 x 10" 三种写法都要认（健身房文案三种混着用）
  const sets = s.match(/(\d{1,2})\s*(?:组|set|sets|轮)/i) ?? s.match(/(\d{1,2})\s*[x×*]\s*\d/i);
  if (sets) dose.sets = Number(sets[1]);
  const range = s.match(/(\d{1,3})\s*[-~—到]\s*(\d{1,3})\s*(?:次|个|rep|reps)?/i);
  if (range) { dose.repsMin = Number(range[1]); dose.repsMax = Number(range[2]); }
  else {
    const secs = s.match(/(\d{1,4})\s*(?:秒|s|sec)/i);
    if (secs) dose.seconds = Number(secs[1]);
    const reps = s.match(/(?:×|x|\*)?\s*(\d{1,3})\s*(?:次|个|rep|reps)/i);
    if (reps) { dose.repsMin = Number(reps[1]); dose.repsMax = Number(reps[1]); }
  }
  const weight = s.match(/(\d{1,3}(?:\.\d)?)\s*(?:kg|公斤|千克)/i);
  if (weight) dose.weightKg = Number(weight[1]);
  return dose;
}

// ── 动作名匹配 ───────────────────────────────────────────────
export interface MatchableExercise {
  id: string;
  name: string;
  aliases?: string[];
  movementPattern: string;
  primaryMuscles: string[];
  equipmentIds: string[];
  contraindicationTags: string[];
  minSets: number;
  maxSets: number;
  defaultReps: string;
  substitutionTags: string[];
}

const norm = (s: string) => String(s ?? "").toLowerCase().replace(/[\s()（）·、,，.。:_-]+/g, "");

/**
 * 把外部动作名映射到动作库。
 * 顺序：完全同名 → 别名 → 包含关系。宁可先给"没匹配上"，也不要瞎猜成别的动作。
 */
export function matchExercise(name: string, exercises: MatchableExercise[]): MatchableExercise | null {
  const target = norm(name);
  if (!target) return null;
  const exact = exercises.find(e => norm(e.name) === target || (e.aliases ?? []).some(a => norm(a) === target));
  if (exact) return exact;
  // 包含关系：只接受"库里的名字被包含在外部名里"，且长度接近，避免"深蹲"匹配到"保加利亚分腿蹲"
  const scored = exercises
    .map(e => {
      const candidates = [e.name, ...(e.aliases ?? [])].map(norm).filter(Boolean);
      const hit = candidates.find(c => target.includes(c) || c.includes(target));
      return hit ? { e, len: hit.length, ratio: hit.length / Math.max(target.length, 1) } : null;
    })
    .filter((x): x is { e: MatchableExercise; len: number; ratio: number } => Boolean(x))
    .sort((a, b) => b.ratio - a.ratio || b.len - a.len);
  const best = scored[0];
  return best && best.ratio >= 0.5 ? best.e : null;
}

// ── 适合性判定 ───────────────────────────────────────────────
export type ImportVerdict = "ok" | "adjust" | "unsuitable" | "unmatched";

export interface ImportContext {
  /** 用户可用的器械（core 的 equipment id） */
  availableEquipment?: string[];
  /** 长期限制/医嘱（core 的 restrictions，如 knee_pain） */
  restrictions: string[];
  /** 该动作的能力区间，例如 "8-12"；没有就按库默认 */
  repRange?: { min: number; max: number };
  /** 当前环境（home/gym/office），用于判断器械是否够 */
  environment: string;
}

export interface ImportAssessment {
  verdict: ImportVerdict;
  reasons: string[];
  /** 我们建议的剂量（照原数字时只作提示，不覆盖） */
  suggested: { sets?: number; reps?: string; note?: string };
  /** 命中的库动作；没匹配上就是 null */
  exerciseId: string | null;
}

export function assessItem(
  item: { name: string; dose: ParsedDose },
  matched: MatchableExercise | null,
  ctx: ImportContext,
): ImportAssessment {
  const reasons: string[] = [];
  // 1) 匹配不上：不动剂量，让用户决定（换动作或跳过），别猜
  if (!matched) {
    return {
      verdict: "unmatched",
      reasons: [`动作库里没有「${item.name}」，要么换个相近动作，要么跳过这一项`],
      suggested: {},
      exerciseId: null,
    };
  }
  // 2) 禁忌优先于一切数字（D27 铁律边界 2）
  const hits = matched.contraindicationTags.filter(t => ctx.restrictions.includes(t));
  if (hits.length) {
    const labels: Record<string, string> = { knee_pain: "膝", low_back_pain: "腰背", shoulder_pain: "肩" };
    reasons.push(`你的记录里有${hits.map(h => labels[h] ?? h).join("、")}部限制，这个动作不适合`);
    return { verdict: "unsuitable", reasons, suggested: {}, exerciseId: matched.id };
  }
  // 3) 器械：环境里拿不到就降级为"需调整"
  const eqOk = !ctx.availableEquipment || matched.equipmentIds.some(id => ctx.availableEquipment!.includes(id));
  if (!eqOk) reasons.push(`当前可用器械里没有 ${matched.equipmentIds.join("/")}`);

  const suggested: ImportAssessment["suggested"] = {};
  const sets = item.dose.sets;
  if (sets !== undefined) {
    if (sets > matched.maxSets) {
      reasons.push(`原计划 ${sets} 组，超过这个动作的上限 ${matched.maxSets} 组`);
      suggested.sets = matched.maxSets;
    } else if (sets < matched.minSets) {
      reasons.push(`原计划只有 ${sets} 组，低于建议的下限 ${matched.minSets} 组`);
      suggested.sets = matched.minSets;
    }
  }
  const top = item.dose.repsMax ?? item.dose.repsMin;
  if (top !== undefined && !item.dose.seconds) {
    const cap = ctx.repRange ?? parseRepRange(matched.defaultReps);
    if (cap && top > cap.max) {
      reasons.push(`原计划做到 ${top} 次，你目前在这个动作上是 ${cap.min}-${cap.max} 次`);
      suggested.reps = `${cap.min}-${cap.max}`;
    } else if (cap && top < cap.min) {
      reasons.push(`原计划只有 ${top} 次，低于你现在能做的 ${cap.min}-${cap.max} 次`);
      suggested.reps = `${cap.min}-${cap.max}`;
    }
  }
  if (!reasons.length) return { verdict: "ok", reasons: [], suggested: {}, exerciseId: matched.id };
  return { verdict: "adjust", reasons, suggested, exerciseId: matched.id };
}

/** "8-12" → {min:8,max:12}；"10" → {min:10,max:10}；解析不了返回 undefined */
export function parseRepRange(text: string | undefined): { min: number; max: number } | undefined {
  const m = String(text ?? "").match(/(\d{1,3})\s*[-~—到]\s*(\d{1,3})/) ?? String(text ?? "").match(/^(\d{1,3})$/);
  if (!m) return undefined;
  return { min: Number(m[1]), max: Number(m[2] ?? m[1]) };
}

/** 整个计划层面的判定：任一项 unsuitable 就整体提示风险 */
export function summarizePlan(items: ImportAssessment[]) {
  const count = (v: ImportVerdict) => items.filter(i => i.verdict === v).length;
  return {
    ok: count("ok"),
    adjust: count("adjust"),
    unsuitable: count("unsuitable"),
    unmatched: count("unmatched"),
    /** 有禁忌动作时，整体不允许"照原样练" */
    blocksAsIs: count("unsuitable") > 0,
  };
}
