// 人体示意图（2026-11-09，owner 选 A 方案：简版正视图，不依赖第三方素材）。
// 8 个部位按肌群账本状态上色。只表达"能不能接着练"，不是解剖图，也不做医疗判断。
import type { MuscleGroup, MuscleLedgerEntry, MuscleState } from "./muscles.ts";

const COLORS: Record<MuscleState, string> = {
  just_trained: "#ff9f83", recovering: "#ffcda8", recovered: "#8ed08e",
  neglected: "#b9a6e0", no_record: "#e2e2e2",
};

/** 正面示意：核心/胸/肩/手臂/腿/小腿；背与臀在右侧用引导标签表示（正面看不到）。 */
export function renderBodyMap(entries: MuscleLedgerEntry[], opts: { width?: number } = {}): string {
  const w = opts.width ?? 240;
  const by = (g: MuscleGroup) => COLORS[(entries.find(e => e.group === g)?.state ?? "no_record") as MuscleState];
  const label = (g: MuscleGroup) => entries.find(e => e.group === g)?.label ?? g;
  const z = (g: MuscleGroup, shape: string) => `<g><title>${label(g)}</title>${shape}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 300" width="${w}" height="${Math.round(w * 1.25)}" role="img" aria-label="今天训练的肌群示意图">
  <rect width="240" height="300" fill="#faf7f3" rx="12"/>
  <!-- 头 -->
  <circle cx="120" cy="34" r="16" fill="#e6e0d8"/>
  <!-- 肩 -->
  ${z("shoulders", `<ellipse cx="92" cy="62" rx="16" ry="11" fill="${by("shoulders")}"/><ellipse cx="148" cy="62" rx="16" ry="11" fill="${by("shoulders")}"/>`)}
  <!-- 胸 -->
  ${z("chest", `<rect x="100" y="66" width="40" height="34" rx="8" fill="${by("chest")}"/>`)}
  <!-- 核心 -->
  ${z("core", `<rect x="104" y="104" width="32" height="40" rx="8" fill="${by("core")}"/>`)}
  <!-- 手臂 -->
  ${z("arms", `<rect x="72" y="70" width="16" height="66" rx="8" fill="${by("arms")}"/><rect x="152" y="70" width="16" height="66" rx="8" fill="${by("arms")}"/>`)}
  <!-- 腿 -->
  ${z("legs", `<rect x="96" y="150" width="20" height="70" rx="9" fill="${by("legs")}"/><rect x="124" y="150" width="20" height="70" rx="9" fill="${by("legs")}"/>`)}
  <!-- 小腿 -->
  ${z("calves", `<rect x="98" y="224" width="16" height="50" rx="7" fill="${by("calves")}"/><rect x="126" y="224" width="16" height="50" rx="7" fill="${by("calves")}"/>`)}
  <!-- 正面看不到的部位：用引导标签表达 -->
  ${z("back", `<circle cx="196" cy="80" r="9" fill="${by("back")}"/><text x="208" y="84" font-size="11" fill="#6b625a">背</text>`)}
  ${z("glutes", `<circle cx="196" cy="120" r="9" fill="${by("glutes")}"/><text x="208" y="124" font-size="11" fill="#6b625a">臀</text>`)}
  <text x="120" y="292" font-size="10" text-anchor="middle" fill="#8a817a">按真实完成的组上色 · 灰=没记录</text>
</svg>`;
}
