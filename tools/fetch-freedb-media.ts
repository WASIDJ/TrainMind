#!/usr/bin/env node
// 动作素材改用 free-exercise-db（2026-11-11，owner 要求换掉 RepDB）。
//
// 为什么换：
//   - RepDB 免费档只给静帧，且许可 Term 3 **禁止再分发**，素材只能靠每个开发者自己拉；
//   - 更实际的原因：我们最常用的 5 个自研动作（徒手深蹲/俯卧撑/鸟狗式/髋铰链/提踵）
//     在 RepDB 里根本没有对应条目，于是训练屏只能拿教练照凑——"做鸟狗式却整屏硬拉"。
//
// free-exercise-db（github.com/yuhonas/free-exercise-db）：
//   - **Unlicense / public domain**：可商用、可修改、可再分发、无需署名（见 LICENSE.md）；
//   - 876 个动作，其中 873 个各有 2 张真实照片（start / end）。
// 因为许可是 public domain，这些素材**可以入库**，与 RepDB 的处置正好相反。
//
// 用法：
//   node tools/fetch-freedb-media.ts            # 下载映射表里用到的动作
//   node tools/fetch-freedb-media.ts --dry-run  # 只打印将要下载什么
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "public", "media", "freedb");
const DISK = join(root, "knowledge", "freedb-map.json");
const BASE = "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises";
const dryRun = process.argv.includes("--dry-run");

/**
 * 我们的动作 id → free-exercise-db 里的动作目录名（即图片路径前缀）。
 * 只映射**动作形态真的对得上**的：宁可没有图，也不要拿相似但不同的动作冒充。
 * 明确不映射的：鸟狗式、原地快走、站姿活动度、靠墙俯卧撑、跪姿绳索下拉
 *   —— free-exercise-db 里没有可信对应，这几项继续用文字版式（见 docs/ui-review/2026-11-11-fixes）。
 */
const MAP: Record<string, string> = {
  "bodyweight-squat": "Bodyweight_Squat",
  "push-up": "Pushups",
  "plank": "Plank",
  "dead-bug": "Dead_Bug",
  "glute-bridge": "Butt_Lift_Bridge",
  "reverse-lunge": "Crossover_Reverse_Lunge",
  "hip-hinge": "Good_Morning",
  "calf-raise": "Calf_Raises_-_With_Bands",
  "chair-squat": "Chair_Squat",
  "one-arm-db-row": "One-Arm_Dumbbell_Row",
  "dumbbell-curl": "Dumbbell_Bicep_Curl",
  "barbell-bench-press": "Barbell_Bench_Press_-_Medium_Grip",
  "incline-db-press": "Incline_Dumbbell_Press",
  "lat-pulldown-ex": "Wide-Grip_Lat_Pulldown",
  "seated-cable-row": "Seated_Cable_Rows",
  "face-pull": "Face_Pull",
  "triceps-pushdown": "Triceps_Pushdown",
  "cable-fly": "Cable_Crossover",
};

async function download(url: string): Promise<Buffer | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch { return null; }
}

const results: Array<{ id: string; source: string; saved: string[]; missing: string[] }> = [];
mkdirSync(OUT, { recursive: true });

for (const [id, source] of Object.entries(MAP)) {
  const saved: string[] = [], missing: string[] = [];
  for (const frame of ["0", "1"]) {
    const target = join(OUT, `${id}-${frame}.jpg`);
    if (existsSync(target)) { saved.push(`${id}-${frame}.jpg (已存在)`); continue; }
    if (dryRun) { saved.push(`${id}-${frame}.jpg (dry-run)`); continue; }
    const bytes = await download(`${BASE}/${encodeURI(source)}/${frame}.jpg`);
    // JPEG magic：远程 404 页也会回 200 文本，必须校验内容
    if (!bytes || bytes.length < 2000 || bytes[0] !== 0xff || bytes[1] !== 0xd8) { missing.push(`${id}-${frame}`); continue; }
    await writeFile(target, bytes);
    saved.push(`${id}-${frame}.jpg (${Math.round(bytes.length / 1024)}KB)`);
  }
  results.push({ id, source, saved, missing });
}

// 落盘映射表：前端按这个表决定"哪个动作有图、用哪两张"
if (!dryRun) {
  await writeFile(DISK, `${JSON.stringify({
    note: "动作 id → free-exercise-db 帧文件。许可：Unlicense（public domain），可商用、可再分发、无需署名。",
    source: "https://github.com/yuhonas/free-exercise-db",
    license: "Unlicense",
    licenseFile: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/LICENSE.md",
    fetchedAt: new Date().toISOString(),
    frames: Object.fromEntries(results.filter(r => r.saved.length && !r.missing.length).map(r => [r.id, [`/media/freedb/${r.id}-0.jpg`, `/media/freedb/${r.id}-1.jpg`]])),
  }, null, 2)}\n`, "utf8");
}

console.log(`free-exercise-db 素材${dryRun ? "（dry-run，未写入）" : ""}`);
for (const r of results) {
  if (r.missing.length) console.log(`  ✗ ${r.id} ← ${r.source}：缺 ${r.missing.join(", ")}`);
  else console.log(`  ✓ ${r.id} ← ${r.source}`);
}
console.log(`共 ${results.filter(r => !r.missing.length).length}/${results.length} 个动作有完整两帧。`);
if (!dryRun) console.log(`映射表：knowledge/freedb-map.json · 文件数：${readdirSync(OUT).length}`);
