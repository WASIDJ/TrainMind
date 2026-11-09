// D27：把外部视频/链接变成"一段可解析的文字"。
//
// 分两段，都尽量可降级：
//   1) 元信息（标题 + 简介）：B站走公开 view API（免登录、免签名，实测可用），
//      YouTube 走 oembed。**简介里本来就常写着"3组×12次"**，很多情况下到这里就够了。
//   2) 文本不够（简介为空/只有一句标题）时，才下载音频转写：
//      yt-dlp 取音频 → ffmpeg 转 16k 单声道 → 本地 whisper sidecar。
//      转写失败/超时一律返回 null，由调用方退回"让用户粘贴文字"，绝不假装成功。
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface SourceMeta {
  title: string;
  desc: string;
  durationSeconds?: number;
  /** 抓不到任何文字时 false —— 前端据此提示"请把计划文字粘进来" */
  hasText: boolean;
  /** 文本来自哪里：meta / transcript */
  from: "meta" | "transcript";
}

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function getJson(url: string, timeoutMs = 8000) {
  const r = await fetch(url, { headers: { "user-agent": UA, referer: "https://www.bilibili.com/" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw Error(`HTTP ${r.status}`);
  return r.json() as Promise<any>;
}

/** B站公开接口，不需要 cookie / WBI 签名（实测 2026-11-09） */
export async function fetchBilibiliMeta(bvid: string): Promise<SourceMeta> {
  const data = await getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
  if (data?.code !== 0 || !data.data) throw Error(`B站接口返回 ${data?.code ?? "?"}：${data?.message ?? "未知错误"}`);
  const v = data.data;
  const desc = String(v.desc ?? "").trim();
  return {
    title: String(v.title ?? "").trim(),
    desc,
    durationSeconds: Number(v.duration) || undefined,
    hasText: desc.length >= 40,
    from: "meta",
  };
}

export async function fetchYoutubeMeta(videoId: string): Promise<SourceMeta> {
  const data = await getJson(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`);
  const desc = String(data?.description ?? "").trim();
  return { title: String(data?.title ?? "").trim(), desc, hasText: desc.length >= 40, from: "meta" };
}

/** 音频转写：yt-dlp → ffmpeg → 本地 whisper。任何一步失败都返回 null。 */
export async function transcribeMedia(url: string, opts: { maxSeconds?: number; sttUrl?: string } = {}): Promise<string | null> {
  const maxSeconds = opts.maxSeconds ?? 600;
  const sttUrl = opts.sttUrl ?? process.env.TRAINMIND_STT_URL ?? "http://127.0.0.1:8765";
  const dir = await mkdtemp(join(tmpdir(), "trainmind-import-"));
  try {
    const audio = join(dir, "audio.%(ext)s");
    // --max-filesize 兜底防爆盘；--no-playlist 防止 BV 号带出整个合集
    await run("yt-dlp", ["--no-warnings", "--no-playlist", "-f", "bestaudio/best", "--max-filesize", "60M", "-o", audio, url], { timeout: 180_000, maxBuffer: 8 << 20 });
    const probe = await run("ls", ["-1", dir], { timeout: 5000 });
    const file = probe.stdout.split("\n").map(s => s.trim()).find(s => s && s !== "audio.wav");
    if (!file) return null;
    const wav = join(dir, "audio.wav");
    await run("ffmpeg", ["-y", "-loglevel", "error", "-i", join(dir, file), "-ar", "16000", "-ac", "1", "-t", String(maxSeconds), wav], { timeout: 120_000 });
    const size = (await stat(wav)).size;
    if (size < 2000) return null;
    const body = await readFile(wav);
    const r = await fetch(`${sttUrl}/transcribe`, { method: "POST", headers: { "content-type": "audio/wav" }, body, signal: AbortSignal.timeout(180_000) });
    const j = await r.json().catch(() => null) as { text?: string; error?: string } | null;
    const text = String(j?.text ?? "").trim();
    return text || null;
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
