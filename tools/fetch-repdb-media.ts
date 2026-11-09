#!/usr/bin/env node
// RepDB 免费档素材按需拉取(2026-11-09, owner 决定"先用 RepDB 素材")。
//
// 事实边界(不要被官网误导):
//   - Free 档 = 每个动作 **两张 512px 静帧**(start / peak,少数 hold 类只有 main),可商用、App 内使用、需署名
//   - 官网演示的**循环动画**属于 Standard 付费档;premium-samples/ 里的样品仅限评估,不得进生产
// 所以这里只拉静帧,前端用两帧交替做出"抽帧动图"的效果。
//
// 为什么不入库:
//   许可 Term 3 禁止把数据集当数据集再分发。素材放 public/media/ 且 .gitignore 掉,
//   仓库里只留这个脚本 + 署名 —— 谁克隆谁自己拉。
//
// 用法:
//   node tools/fetch-repdb-media.ts                 # 只拉动作池里用到的(id 来自 knowledge/exercises.repdb.json)
//   node tools/fetch-repdb-media.ts --all           # 601 个全拉(29.6MB 包,解出约 36MB)
//   TRAINMIND_REPDB_ZIP=/path/to/repdb-free.zip node tools/fetch-repdb-media.ts   # 用本地已下载的包
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public", "media", "repdb");
const cacheDir = join(root, ".cache");
const zipPath = process.env.TRAINMIND_REPDB_ZIP ?? join(cacheDir, "repdb-free.zip");
const all = process.argv.includes("--all");

mkdirSync(outDir, { recursive: true });
mkdirSync(cacheDir, { recursive: true });

if (!existsSync(zipPath)) {
  console.log("下载免费包(约 29.6MB)…");
  execFileSync("curl", ["-sSL", "-o", zipPath, "https://cdn.repdb.co/repdb-assets/site/repdb-free.zip"], { stdio: "inherit" });
} else {
  console.log(`用本地包:${zipPath}(${Math.round(statSync(zipPath).size / 1e6)}MB)`);
}

// 需要哪些动作:默认只取我们动作池里已收录的 RepDB 条目
const ids = new Set<string>();
for (const row of JSON.parse(readFileSync(join(root, "knowledge", "exercises.repdb.json"), "utf8")) as Array<{ id: string }>) ids.add(row.id);
if (all) for (const row of (JSON.parse(readFileSync(join(root, "test", "repdb-source", "exercises.json"), "utf8")).exercises ?? []) as Array<{ id: string }>) ids.add(row.id);

const listing = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" }).split("\n").map(s => s.trim()).filter(Boolean);
const wanted = listing.filter(name => {
  const m = name.match(/^images\/flat\/(.+)\.webp$/);
  return m ? ids.has(m[1]!.replace(/-(start|peak|main)$/, "")) : false;
});
if (!wanted.length) { console.error("免费包里没有匹配的图片,检查 id 是否对得上。"); process.exit(1); }

execFileSync("unzip", ["-o", "-j", zipPath, ...wanted, "-d", outDir], { stdio: ["ignore", "ignore", "inherit"] });
const names = new Set(wanted.map(x => x.split("/").pop()));
const covered = [...ids].filter(id => names.has(`${id}-start.webp`) || names.has(`${id}-main.webp`)).length;
console.log(`已解出 ${wanted.length} 张到 public/media/repdb/ · 覆盖 ${covered}/${ids.size} 个动作`);
if (!all) {
  // 只跑一部分时把整包删掉,免得 30MB 白占地方;要复用就设 TRAINMIND_REPDB_ZIP 指向自己的副本
  if (!process.env.TRAINMIND_REPDB_ZIP) rmSync(zipPath, { force: true });
}
console.log("提醒:素材不入 git(见 .gitignore)。署名写在应用「我的 → 档案」页脚,许可要求可见链接。");
