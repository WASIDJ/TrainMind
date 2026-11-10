import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { migrateTelemetry, RuntimeTelemetry } from "./telemetry/index.ts";
import { relationScore } from "../knowledge/substitutions.ts";
import {
  abortWorkout, buildUserTrainingModel, completeCooldown, completeRest, completeWarmup, createWorkout, durationBreakdown, equipment, exercises, extendRest,
  gymEquipment, LocalLanguageModelProvider, markSetComplete, pauseWorkout,
  replaceExercise, resumeWorkout, skipExercise, startWorkout, submitSetFeedback,
  testGym, workoutJsonSchema, configureExperience, controlExperience, experienceDirective,
  applyExperienceDirective, advanceExperienceSegment, type ExperienceMode, type ExperienceTopic,
  createExperimentRecord, experimentRecordsCsv, enableCoach, resetCoachForSet, handleCoachEvent, handleCoachMessage, type DataOrigin, type DoseOutcome, type SetRecord, type SetFeedback, type WorkoutSession, type TrainingFacts
} from "./core.ts";
import { narrate, slotOf, RED_FLAG, RED_FLAG_TEXT, buildMemoryFacts, type MemoryRow } from "./narration.ts";
import { classifyStopIntent, probeStopPrompt, parseCoachReport } from "./coach-runtime.ts"; // 喊停三段式:疲惫先问原因再收工
import { applyLateFeedback } from "./core.ts"; // D17:组后补充反馈(不报错、真生效)
import { CUE_TEMPLATES } from "./perception.js"; // 组内听觉感知 v1:时机引擎话术锚点(纯 JS,前后端共用)
import { detectSource, matchExercise, parseDoseText, assessItem, summarizePlan } from "./import-plan.ts"; // D27:把别人的计划拆成我们的结构
import { fetchBilibiliMeta, fetchYoutubeMeta, transcribeMedia } from "./import-fetch.ts"; // D27:链接 → 文字（元信息优先，转写兜底）
import { buildMuscleLedger, ledgerSignals } from "./muscles.ts"; // 肌群疲劳账本(按部位聚合,纯函数)
import { buildCheckIn } from "./companion.ts";
import { buildDailyReport } from "./daily-report.ts";
import { renderBodyMap } from "./body-map.ts";
import { classifyMood } from "./companion.ts"; // 日常陪伴照面(减重人群预设,规则产出话术)
import { exerciseProgress, progressSummary, relationship, nudgeFor, weeklyVolume, type Relationship } from "./progress.ts"; // 进步叙事 + 关系进度
import { buildProgram, programStatus, recordCompletion, weekOverWeek, type Program } from "./program.ts"; // 多周课程 + 计划/执行分离
import { agencyChoiceFromSpeech } from "./core.ts";

const dbPath = process.env.TRAINMIND_DB ?? fileURLToPath(new URL("../trainmind.db", import.meta.url));
const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS user_profiles (user_id TEXT PRIMARY KEY REFERENCES users(id), data_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS equipment (id TEXT PRIMARY KEY, data_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS exercises (id TEXT PRIMARY KEY, data_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS gyms (id TEXT PRIMARY KEY, data_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS gym_equipment (gym_id TEXT NOT NULL, equipment_id TEXT NOT NULL, available INTEGER NOT NULL, PRIMARY KEY (gym_id, equipment_id));
  CREATE TABLE IF NOT EXISTS session_contexts (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS workout_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, status TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS workout_exercises (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES workout_sessions(id), exercise_id TEXT NOT NULL, data_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS training_records (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT NOT NULL, data_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS set_records (id TEXT PRIMARY KEY, workout_exercise_id TEXT NOT NULL, data_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS exercise_performances (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, exercise_id TEXT NOT NULL, performed_at TEXT NOT NULL, data_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS user_training_model_snapshots (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, generated_at TEXT NOT NULL, data_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS experience_preferences (user_id TEXT PRIMARY KEY, data_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS experiment_records (session_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, experience_mode TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS app_settings (name TEXT PRIMARY KEY, data_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS programs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', data_json TEXT NOT NULL, created_at TEXT NOT NULL);
`);
// Telemetry v2 迁移(冻结规格 v1.0.1):fresh 建表 / legacy 加法补列,可重入,详见 src/telemetry/
migrateTelemetry(db);
const runtimeTelemetry = new RuntimeTelemetry(db); // 7B.2:域 /actions → v2 遥测桥(失败不阻断产品动作)
const upsertCatalog = (table: string, id: string, data: unknown) => db.prepare(`INSERT OR REPLACE INTO ${table} (id, data_json) VALUES (?, ?)`).run(id, JSON.stringify(data));
equipment.forEach(x => upsertCatalog("equipment", x.id, x));
exercises.forEach(x => upsertCatalog("exercises", x.id, x));
upsertCatalog("gyms", testGym.id, testGym);
gymEquipment.forEach(x => db.prepare("INSERT OR REPLACE INTO gym_equipment VALUES (?, ?, ?)").run(x.gymId, x.equipmentId, x.available ? 1 : 0));
db.prepare("INSERT OR IGNORE INTO users VALUES (?, ?)").run("demo-user", new Date().toISOString());
for (const stored of db.prepare("SELECT session_id, user_id, data_json FROM experiment_records").all() as any[]) {
  const record = JSON.parse(stored.data_json); if (record.dataOrigin) continue;
  record.dataOrigin = /(?:test|e2e|log|integration|automated)/i.test(stored.user_id) ? "automated_test" : "demo";
  db.prepare("UPDATE experiment_records SET data_json = ? WHERE session_id = ?").run(JSON.stringify(record), stored.session_id);
}

const provider = new LocalLanguageModelProvider();
// H3(2026-11-06 全仓审查):用户输入错误(400,信息面向用户)与内部错误(500,不回显细节)的判别标记
class UserInputError extends Error {}
const isInternalError = (error: unknown): boolean => {
  if (error instanceof UserInputError) return false;
  if (!(error instanceof Error)) return true;
  // 领域层抛的都是带中文用户话术的普通 Error;引擎/类型/数据库错误属于内部错误,细节只进日志
  return ["TypeError", "RangeError", "SyntaxError", "ReferenceError"].includes(error.constructor.name) || /constraint failed/i.test(error.message);
};
const devPageEnabled = process.env.NODE_ENV !== "production";
const mobileMode = process.argv.includes("--mobile");
const mobileAccessKey = process.env.MOBILE_ACCESS_KEY ?? (mobileMode ? crypto.randomUUID() : undefined);
// 神经网络 TTS(OpenAI 兼容 /audio/speech;跨域 302 由 fetch 规范自动去鉴权头)
const ttsConfig = { url: process.env.TRAINMIND_TTS_URL ?? "", key: process.env.TRAINMIND_TTS_KEY ?? "", model: process.env.TRAINMIND_TTS_MODEL ?? "", voice: process.env.TRAINMIND_TTS_VOICE ?? "alloy" };
const ttsCache = new Map<string, Buffer>();
if (mobileMode) console.log(`Mobile access key: ${mobileAccessKey}`);
const htmlPath = fileURLToPath(new URL("../public/index.html", import.meta.url));
const atmospherePath = fileURLToPath(new URL("../public/workout-atmosphere.png", import.meta.url));
const svgAssets = new Set(["training-art.svg", "figma-coach-wave.svg", "figma-demo-bench.svg", "figma-adjust-old.svg", "figma-adjust-new.svg", "plan-bench.svg", "plan-incline.svg", "plan-cable.svg", "plan-curl.svg", "plan-pushdown.svg", "tm-d5f35.svg", "tm-39cd6.svg", "tm-08af3.svg", "tm-2df75.svg", "tm-a0f7d.svg", "tm-bec5d.svg", "tm-97a73.svg", "tm-dca19.svg", "tm-8f912.svg", "tm-8a1f9.svg", "tm-d5578.svg", "tm-c92a0.svg", "tm-c5779.svg", "tm-359a2.svg"]);
const coachMedia = new Set(["lin-squat.jpg", "lin-hinge.jpg", "lin-pushup.jpg", "lin-cover.jpg", "su-cover.jpg", "yue-cover.jpg"]);
const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
  // A5(2026-11-09):头已发时再写会抛 ERR_HTTP_HEADERS_SENT,而该异常发生在全局 catch 内部,没人接。
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "vary": "Origin" });
  res.end(JSON.stringify(body));
};
/** A5:静态资源先读再写头 —— 读失败只回 404,绝不允许"写了 200 头再抛错"。 */
async function sendFile(res: import("node:http").ServerResponse, contentType: string, path: string | URL, cache?: string) {
  let data: Buffer;
  try { data = await readFile(path); }
  catch (error) { console.error(JSON.stringify({ timestamp: new Date().toISOString(), warning: "static_read_failed", path: String(path), error: error instanceof Error ? error.message : String(error) })); return json(res, 404, { error: "资源不存在。" }); }
  res.writeHead(200, { "content-type": contentType, ...(cache ? { "cache-control": cache } : {}) });
  return res.end(data);
}
const MAX_BODY_BYTES = 1024 * 1024; // A6:本机合法请求都在几十 KB 内;转写端点另有 2MB 闸
async function body(req: import("node:http").IncomingMessage, maxBytes = MAX_BODY_BYTES) {
  let raw = "", size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // A6(2026-11-09):此前无限累加 —— 一个几百 MB 的 JSON 能把 RSS 顶到 GB 级被 OOM 杀掉,
    // 训练中断线、库里留下未收尾会话。超限按用户输入错误处理(400),不回显细节。
    if (size > maxBytes) throw new UserInputError("请求体过大。");
    raw += chunk;
  }
  if (!raw) return {};
  // A9(2026-11-09):畸形 JSON 抛的是 SyntaxError,会被 isInternalError 判成内部错误回 500,
  // 用户看到"服务器开小差了"并被引导去重启服务 —— 这明明是自己能修的请求格式问题。
  try { return JSON.parse(raw); } catch { throw new UserInputError("请求体不是合法 JSON。"); }
}
function windowsSpeech(script: string, audio?: Buffer): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;Add-Type -AssemblyName System.Speech;${script}`, "utf16le").toString("base64")], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    const timeout = setTimeout(() => { child.kill(); reject(Error("本地识别超时，请缩短语音后重试。")); }, 15000);
    child.stdout.setEncoding("utf8");child.stdout.on("data", data => output += data);
    child.stderr.resume();
    child.on("error", () => { clearTimeout(timeout); reject(Error("本地中文识别引擎无法启动。")); });
    child.on("close", code => { clearTimeout(timeout); try { if (code !== 0) throw Error(); resolve(JSON.parse(output.trim().replace(/^\uFEFF/, ""))); } catch { reject(Error("没有识别到清晰的语音，请再说一次。")); } });
    child.stdin.on("error", () => {});child.stdin.end(audio?.toString("base64") ?? "");
  });
}
const offlineSpeechAvailable = process.platform === "win32" ? windowsSpeech("$found=@([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | Where-Object {$_.Culture.Name -eq 'zh-CN'}).Count -gt 0;@{available=$found}|ConvertTo-Json -Compress").then(x => x.available === true).catch(() => false) : Promise.resolve(false);
// ── 本地 whisper STT sidecar(tools/stt-sidecar.py,端口 8765)──
// 安卓 Chrome 的网页语音识别依赖 Google 云端,国内网络会话能启动但永不返回;
// sidecar 让识别全部发生在 Mac 本地:手机录音 → /api/voice/transcribe → sidecar → 文本。
const sttSidecarUrl = process.env.TRAINMIND_STT_SIDECAR ?? "http://127.0.0.1:8765";
async function probeSttSidecar(timeoutMs = 2000): Promise<boolean> {
  try { const r = await fetch(`${sttSidecarUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) }); return r.ok; } catch { return false; }
}
const sttSidecarReady = (async () => {
  if (await probeSttSidecar()) return true; // 已有常驻实例(避免重复 spawn/僵尸)
  if (process.env.TRAINMIND_STT === "off") return false;
  let spawnFailed = false;
  try {
    const log = await import("node:fs").then(fs => fs.openSync("/tmp/trainmind-stt-sidecar.log", "a"));
    const child = (await import("node:child_process")).spawn(process.env.TRAINMIND_PYTHON ?? "python3", ["tools/stt-sidecar.py"], { cwd: process.cwd(), detached: true, stdio: ["ignore", log, log] });
    // M10:spawn 失败(如 python3 不存在)走的是异步 'error' 事件,上面的 try/catch 接不住;
    // 没有这个 handler,ENOENT 会变成未捕获异常把整个服务带走。sidecar 起不来只废语音,不该陪葬主服务。
    child.on("error", error => {
      spawnFailed = true;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") console.warn(`STT sidecar 未启动:找不到 Python 解释器(${process.env.TRAINMIND_PYTHON ?? "python3"})。请安装 python3,或设 TRAINMIND_PYTHON 指向装有 faster-whisper 的解释器;期间语音识别退回浏览器引擎。`);
      else console.warn(`STT sidecar 启动失败:${(error as Error).message}`);
    });
    child.unref();
  } catch (e) { console.warn("STT sidecar spawn failed:", e); return false; }
  for (let i = 0; i < 30; i++) { // 模型加载 ~10-15s
    if (spawnFailed) return false; // 解释器都没起来,不再白等 60 秒
    await new Promise(r => setTimeout(r, 2000));
    if (await probeSttSidecar(1500)) return true;
  }
  console.warn("STT sidecar not ready after 60s");
  return false;
})();
async function sttTranscribe(audio: Buffer): Promise<{ text?: string; confidence?: number }> {
  const r = await fetch(`${sttSidecarUrl}/transcribe`, { method: "POST", signal: AbortSignal.timeout(30000), headers: { "content-type": "audio/wav" }, body: audio });
  if (!r.ok) return { text: undefined };
  const data = await r.json() as { text?: string; confidence?: number };
  // H6(2026-11-06 全仓审查):透传 sidecar 的置信度(exp 加权 avg_logprob)。
  // 缺它,前端"低置信先确认"在本地 whisper 主路径上恒为 false——守门形同虚设。
  return { text: data.text ?? "", confidence: typeof data.confidence === "number" ? data.confidence : undefined };
}
type ChatConfig = { baseUrl: string; model: string; protocol: "openai" | "ollama" | "tencent"; apiKey: string };
let chatConfig: ChatConfig = { baseUrl: process.env.TRAINMIND_CHAT_BASE_URL ?? "https://tokenhub.tencentmaas.com/v1", model: process.env.TRAINMIND_CHAT_MODEL ?? "", protocol: process.env.TRAINMIND_CHAT_PROTOCOL === "ollama" ? "ollama" : process.env.TRAINMIND_CHAT_PROTOCOL === "openai" ? "openai" : "tencent", apiKey: process.env.TRAINMIND_CHAT_API_KEY ?? "" };
let chatConnectedAt: string | null = null;
async function protectChatKey(value: string, decrypt = false): Promise<string> {
  if (!value) return "";
  if (process.platform !== "win32") throw Error("当前平台请通过 TRAINMIND_CHAT_API_KEY 环境变量配置密钥。");
  try {
    const result = await windowsSpeech(`Add-Type -AssemblyName System.Security;$inputBytes=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());$outputBytes=[Security.Cryptography.ProtectedData]::${decrypt ? "Unprotect" : "Protect"}($inputBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);@{value=[Convert]::ToBase64String($outputBytes)}|ConvertTo-Json -Compress`, decrypt ? Buffer.from(value, "base64") : Buffer.from(value, "utf8"));
    return decrypt ? Buffer.from(result.value, "base64").toString("utf8") : result.value;
  } catch { throw Error("无法读取或保存本机模型密钥，请重新配置。"); }
}
const chatConfigReady = (async () => {
  // 环境变量(操作者显式配置,如 start-7b3.sh)优先于历史存储设置,避免陈旧行覆盖
  if (process.env.TRAINMIND_CHAT_BASE_URL || process.env.TRAINMIND_CHAT_MODEL || process.env.TRAINMIND_CHAT_API_KEY) return;
  try {
    const stored = db.prepare("SELECT data_json FROM app_settings WHERE name = 'coach'").get() as { data_json: string } | undefined;
    if (stored) { const config = JSON.parse(stored.data_json); chatConfig = { baseUrl: config.baseUrl, model: config.model, protocol: config.protocol, apiKey: "" }; try { chatConfig.apiKey = await protectChatKey(config.protectedKey ?? "", true); } catch { console.warn("Model key could not be read; reconfigure the coach."); } }
  } catch (error) {
    // A4(2026-11-09):app_settings.coach 一行坏掉不该带走整个服务 —— 此前 JSON.parse 在 try 之外,
    // 模块加载期同步 reject、无人 await → Node 按未捕获拒绝退出,表现为"启动即死、无 HTTP"。
    console.warn(JSON.stringify({ timestamp: new Date().toISOString(), warning: "coach_config_unreadable", error: error instanceof Error ? error.message : String(error) }));
  }
})();
// ── 教练叙事层 LLM 适配器(D11):仅改写指令话术;2.5s 硬超时由调用方兜底为模板 ──
async function narrationLlm(systemPrompt: string, userPrompt: string): Promise<string> {
  const base = chatConfig.baseUrl.replace(/\/$/, "");
  const endpoint = chatConfig.protocol === "ollama" ? (base.endsWith("/api/chat") ? base : `${base}${base.endsWith("/api") ? "" : "/api"}/chat`) : (base.endsWith("/chat/completions") ? base : `${base}/chat/completions`);
  const response = await fetch(endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(2500), headers: { "content-type": "application/json", ...(chatConfig.apiKey ? { authorization: `Bearer ${chatConfig.apiKey}` } : {}) }, body: JSON.stringify({ model: chatConfig.model, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }], stream: false, max_tokens: 120, ...(/deepseek/i.test(chatConfig.model) ? { thinking: { type: "disabled" } } : {}) }) });
  if (!response.ok) throw Error(`narration_upstream_${response.status}`);
  const data = await response.json() as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content ?? "";
}
function chatStatus() { return { configured: Boolean(chatConfig.baseUrl && chatConfig.model && (chatConfig.protocol !== "tencent" || chatConfig.apiKey)), baseUrl: chatConfig.baseUrl, model: chatConfig.model, protocol: chatConfig.protocol, keyConfigured: Boolean(chatConfig.apiKey), connectedAt: chatConnectedAt }; }
function requireLocalSettings(req: import("node:http").IncomingMessage) {
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "") || !req.headers["content-type"]?.startsWith("application/json")) throw Error("请使用本机应用内的模型设置。");
  // A9(2026-11-09):`Origin: null` 或畸形 Origin 会让 new URL 抛 TypeError,被 isInternalError 判成
  // 内部错误回 500;这类明明是请求本身不对,应该 403。
  if (req.headers.origin) {
    let originHost = "";
    try { originHost = new URL(req.headers.origin).host; } catch { throw Error("已拒绝跨站请求。"); }
    if (originHost !== req.headers.host) throw Error("请使用本机应用内的模型设置。");
  }
}
async function modelReply(messages: Array<{ role: string; content: string }>, maxTokens = 700) {
  await chatConfigReady;
  if (!chatStatus().configured) throw Error("请先在模型设置中填写接口地址、模型名；腾讯云还需要有效的 TokenHub API Key。");
  const config = { ...chatConfig }, base = config.baseUrl.replace(/\/$/, "");
  const endpoint = config.protocol === "ollama" ? (base.endsWith("/api/chat") ? base : `${base}${base.endsWith("/api") ? "/chat" : "/api/chat"}`) : (base.endsWith("/chat/completions") ? base : `${base}/chat/completions`);
  let response: Response;
  try {
    response = await fetch(endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(45000), headers: { "content-type": "application/json", ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) }, body: JSON.stringify(config.protocol === "ollama" ? { model: config.model, messages, stream: false, options: { num_predict: maxTokens } } : { model: config.model, messages, stream: false, max_tokens: maxTokens, ...(/deepseek/i.test(config.model) ? { thinking: { type: "disabled" } } : {}) }) });
  } catch { chatConnectedAt = null; throw Error("模型连接失败或超时，请检查网络、接口地址和证书；内部服务可能需要公司网络或 VPN。"); }
  if (!response.ok) {
    chatConnectedAt = null;
    const failure = await response.json().catch(() => null), code = String(failure?.error?.code ?? "");
    const reasons: Record<string, string> = { "401002": "当前接口返回密钥无效或签名校验失败，请核对 Key 对应的服务类型和接口地址；Token Plan 使用 /plan/v3，普通调用使用 /v1。", "401003": "API Key 已过期，请重新生成并更新配置。", "401004": "API Key 已被禁用，请在控制台检查密钥状态。", "403002": "当前 API Key 没有这个模型的权限，请检查 Key 的可访问范围。", "403005": "当前电脑的 IP 不在 API Key 白名单中，请检查访问限制。", "401007": "模型没有可用体验额度，需要在控制台确认服务计费状态。", "401008": "模型体验额度已用完，请在控制台确认服务额度。", "403004": "模型账户余额不足，请检查腾讯云账户。" };
    throw Error(reasons[code] ? `模型请求失败（${code}）：${reasons[code]}` : response.status === 401 || response.status === 403 ? `模型鉴权失败（HTTP ${response.status}），请检查 API Key 和模型访问权限。` : response.status === 429 ? "模型请求过多或额度不足，请检查账户额度，或稍后重试。" : `模型返回 ${response.status}，请检查接口地址和模型名称。`);
  }
  let data: any;
  try { data = await response.json(); } catch { chatConnectedAt = null; throw Error("模型接口未返回有效的 JSON，请检查接口格式。"); }
  const raw = config.protocol === "ollama" ? data.message?.content : data.choices?.[0]?.message?.content;
  const reply = typeof raw === "string" ? raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim() : "";
  if (!reply || reply.startsWith("<think>")) { chatConnectedAt = null; throw Error("模型未返回完整回复，请检查输出长度或模型设置。"); }
  if (data.choices?.[0]?.finish_reason === "length" || data.done_reason === "length") { chatConnectedAt = null; throw Error("模型回复被截断，请关闭模型的深度思考或调整服务输出限制。"); }
  if (chatConfig.baseUrl === config.baseUrl && chatConfig.model === config.model && chatConfig.protocol === config.protocol) chatConnectedAt = new Date().toISOString();
  return reply.slice(0, 4000);
}
function coachContext(session?: WorkoutSession) {
  if (!session) return "当前没有训练计划，可以自由聊天或讨论训练需求。";
  const x = session.exercises[session.runtime.currentExerciseIndex];
  return JSON.stringify({ status: session.status, goal: session.goal, environment: session.environment, currentSet: session.runtime.currentSetNumber, restRemainingSeconds: session.status === "resting" ? Math.max(0, Math.ceil((Date.parse(session.runtime.restEndsAt!) - Date.now()) / 1000)) : null,
    currentExercise: x ? { name: x.name, targetReps: x.targetReps, eachSide: x.unilateral || /单臂|单腿|\/侧/.test(x.name + x.targetReps), weightKg: x.currentWeight, sets: x.sets, completedSets: x.completedSets, instructions: x.instructions, reason: x.recommendation.userExplanation } : null,
    plan: session.exercises.map(e => ({ name: e.name, targetReps: e.targetReps, sets: e.sets, completedSets: e.completedSets })) });
}
async function replyToCoach(session: WorkoutSession | undefined, message: string, history: Array<{ role: string; content: string }>) {
  await chatConfigReady;
  if (!chatStatus().configured) {
    if (session) return { reply: coachReply(session, message, history), mode: "training_context" };
    throw Error("自由对话尚未连接语言模型，请先打开模型设置并测试连接。");
  }
  const prompt = "你是 TrainMind 的中文训练教练，支持自然的多轮对话，也可以聊日常话题。结合用户上下文直接回答并自然追问，避免重复固定模板。默认回复简短，适合语音朗读；使用中文动作要点，不朗读英文资料或思考过程。训练事实仅以系统给出的 JSON 为准，次数是每组的明确建议数，单侧动作按每侧说明。不可把计时或报数当作真实完成次数，不可编造用户已经完成的组数或替用户执行操作。计划调整只能提出建议，不能声称已应用；实际执行需要用户的明确操作或口令。涉及疼痛时建议先停止该动作，不做疾病诊断。下面是当前真实训练上下文：\n" + coachContext(session);
  return { reply: await modelReply([{ role: "system", content: prompt }, ...history, { role: "user", content: message }]), mode: "language_model" };
}
function prepareWorkout(session: WorkoutSession) {
  if (["completed", "aborted"].includes(session.status)) return session;
  for (const x of [...session.exercises, ...(session.suggestedExercises ?? [])]) {
    if (x.repOrTimeBased !== "time") x.targetReps = x.targetReps.replace(/^(\d+)\s*[-–—~至]\s*\d+/, "$1");
    const chinese = (line: string) => /[\u4e00-\u9fff]/.test(line) && !/[A-Za-z]{4}/.test(line);
    if (!x.instructions.length || x.instructions.some(line => !chinese(line))) {
      const cues = x.voiceCues ?? exercises.find(e => e.id === x.exerciseId)?.voiceCues;
      x.instructions = [cues?.setupCue, cues?.midpointCue].filter((line): line is string => Boolean(line && chinese(line)));
      if (!x.instructions.length) x.instructions = ["在舒适、无痛的范围内缓慢完成，保持动作稳定。"];
    }
  }
  return session;
}
// 取这场训练最近一条已落库的组记录(用于"事后补充反馈")

// ── D26(2026-11-09, owner 要求):"和 AI 聊完生成编排好的计划" ──
// 多轮编排的槽位(周期/频率/器械/时长/目标)一律由**规则**从多轮对话里收,
// 缺哪个只问那一个;收齐了才给"开始课程"。LLM 只负责怎么说,永不决定参数。
// 这样"聊出来的课程"和"首页排的一场"走同一套建课接口,剂量仍由规则层算。
const PROGRAM_SLOT_QUESTIONS: Record<string, string> = {
  sessionsPerWeek: "一周想练几次？3 次是个能坚持的开始。",
  equipment: "在家还是去健身房？手边有哑铃或弹力带吗？（只有自重也可以）",
};
function collectProgramSlots(text: string) {
  const cn: Record<string, number> = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8 };
  const num = (s: string | undefined) => (s === undefined ? undefined : /^\d+$/.test(s) ? Number(s) : cn[s]);
  const weeks = num(text.match(/(?:(\d{1,2})|[一二两三四五六七八])\s*周/)?.[1] ?? text.match(/([一二两三四五六七八])\s*周/)?.[1]);
  const perWeek = num(text.match(/(?:每周|一周|一个星期)\s*(?:练|训练)?\s*(\d|[一二两三四五六])/)?.[1]);
  const minutes = num(text.match(/(\d{1,3})\s*分钟/)?.[1]);
  const equipment = /哑铃/.test(text) ? ["dumbbell"] : /弹力带|阻力带/.test(text) ? ["band"] : /徒手|自重|没有器械|没器械|无器械/.test(text) ? ["bodyweight"] : undefined;
  const environment: "home" | "gym" | "office" = /健身房|去练|器械齐全/.test(text) ? "gym" : /办公室/.test(text) ? "office" : "home";
  const goal = /下肢|练腿|腿部/.test(text) ? "想练下肢" : /恢复|放松|活动一下/.test(text) ? "想做恢复训练" : "想练全身";
  const missing = [perWeek === undefined ? "sessionsPerWeek" : null, equipment === undefined ? "equipment" : null].filter((x): x is string => Boolean(x));
  return { slots: { weeks, sessionsPerWeek: perWeek, targetMinutes: minutes, equipment, environment, goal }, missing };
}
function wantsProgramPlan(message: string) {
  return /(排|安排|制定|做|定|设计).{0,6}(计划|课程|方案|训练安排)|(每周|一周).{0,4}(练|训练)|\d\s*周|[一二两三四五六七八]\s*周/.test(message);
}
function latestSetRecordFor(sessionId: string): { id: string; record: SetRecord } | null {
  const row = db.prepare("SELECT id, data_json FROM set_records WHERE json_extract(data_json, '$.sessionId') = ? ORDER BY json_extract(data_json, '$.completedAt') DESC LIMIT 1").get(sessionId) as { id: string; data_json: string } | undefined;
  if (!row) return null;
  try { return { id: row.id, record: JSON.parse(row.data_json) as SetRecord }; } catch { return null; }
}
function applyLateSetFeedback(session: WorkoutSession, input: { feedback?: SetFeedback; actualReps?: number; actualWeight?: number }) {
  const latest = latestSetRecordFor(session.sessionId);
  if (!latest) return null;
  const result = applyLateFeedback(session, latest.record, input);
  db.prepare("UPDATE set_records SET data_json = ? WHERE id = ?").run(JSON.stringify(result.record), latest.id);
  return result;
}

function loadSession(id: string): WorkoutSession { const row = db.prepare("SELECT data_json FROM workout_sessions WHERE id = ?").get(id) as { data_json: string } | undefined; if (!row) throw new Error("训练不存在。"); return prepareWorkout(JSON.parse(row.data_json)); }
// ── 课程 → 一场训练:课程模板只给"需求文本",剂量仍由规则引擎产出(铁律不变) ──
async function createWorkoutFromInput(userId: string, input: string, dataOrigin: DataOrigin = "human"): Promise<WorkoutSession> {
  const sessions = (db.prepare("SELECT data_json FROM workout_sessions WHERE user_id = ? ORDER BY created_at DESC").all(userId) as any[]).map(x => JSON.parse(x.data_json) as WorkoutSession);
  const sessionIds = new Set(sessions.map(x => x.sessionId));
  const sets = (db.prepare("SELECT data_json FROM set_records").all() as any[]).map(x => JSON.parse(x.data_json) as SetRecord).filter(x => sessionIds.has(x.sessionId));
  const facts: TrainingFacts = { sessions, sets, trainingRecords: loadTrainingRecords(userId, sessionIds) };
  const result = await createWorkout(input, userId, provider, facts, {});
  if (result.interpretation.status === "error") throw new Error("这句需求没能解析,再说一次试试。");
  if (!result.safety.allowed) throw new Error(result.safety.message ?? "当前状态不适合开始训练。");
  if (result.interpretation.status === "needs_clarification") throw new Error("需要补充一点信息才能排计划。");
  db.prepare("INSERT INTO user_training_model_snapshots (user_id, generated_at, data_json) VALUES (?, ?, ?)").run(userId, result.trainingModel!.generatedAt, JSON.stringify(result.trainingModel));
  db.prepare("INSERT INTO session_contexts (user_id, data_json, created_at) VALUES (?, ?, ?)").run(userId, JSON.stringify(result.context), new Date().toISOString());
  const workout = prepareWorkout(result.workout!);
  workout.suggestedExercises = workout.exercises.map(x => ({ ...x }));
  configureExperience(workout, { mode: "minimal", topic: "history" as ExperienceTopic, talkativeness: "medium", experimentGroup: "minimal", dataOrigin });
  return workout;
}
function persistNewWorkout(workout: WorkoutSession) {
  db.prepare("INSERT INTO workout_sessions (id, user_id, status, data_json, created_at) VALUES (?, ?, ?, ?, ?)").run(workout.sessionId, workout.userId, workout.status, JSON.stringify(workout), workout.createdAt);
  workout.exercises.forEach(x => db.prepare("INSERT INTO workout_exercises VALUES (?, ?, ?, ?)").run(x.id, workout.sessionId, x.exerciseId, JSON.stringify(x)));
}
function coachReply(session: WorkoutSession, message: string, history: Array<{ role: string; content: string }>) {
  const exercise = session.exercises[session.runtime.currentExerciseIndex];
  if (!exercise) return "本次训练已经结束。你可以查看记录，或回到首页生成新的计划。";
  const previous = history.filter(x => x.role === "user").at(-1)?.content ?? "";
  const question = /再详细|具体一点|然后呢|还有呢/.test(message) ? previous + message : message;
  const remaining = Math.max(0, exercise.sets - exercise.completedSets);
  if (/怎么做|怎么练|姿势|动作要领|注意什么|呼吸|再详细|具体一点|然后呢|还有呢/.test(question)) {
    const instructions = exercise.instructions.join("；");
    return `${exercise.name}：${instructions}。${exercise.voiceCues?.breathingCue ?? ""}你可以继续问次数、重量或休息时间。`;
  }
  if (/休息|歇|多久/.test(question)) {
    const seconds = session.status === "resting" ? Math.max(0, Math.ceil((Date.parse(session.runtime.restEndsAt!) - Date.now()) / 1000)) : exercise.restSeconds;
    return session.status === "resting" ? `当前还剩约 ${seconds} 秒休息。需要多休息，可以说“再休息30秒”；准备好后说“下一组”。` : `这个动作组间休息 ${seconds} 秒。完成本组并记录反馈后再开始计时。`;
  }
  if (/重量|多重|公斤|为什么.*轻|为什么.*重/.test(question)) return `${exercise.currentWeight ? `当前建议 ${exercise.currentWeight} 公斤` : "当前是自重训练"}。${exercise.recommendation.userExplanation}实际重量不同，可以在本组反馈里更正。`;
  if (/几组|几次|多少次|剩|进度|现在.*练/.test(question)) return `现在是${exercise.name}，第 ${session.runtime.currentSetNumber} / ${exercise.sets} 组。目标 ${exercise.targetReps}${exercise.repOrTimeBased === "time" ? "" : " 次"}，已确认完成 ${exercise.completedSets} 组，还剩 ${remaining} 组。做完后告诉我“完成本组”。`;
  if (/累|难|做不动|轻|重/.test(question)) return "可以先暂停，不必跟着报数赶进度。如果本组已经结束，请告诉我实际做了几次和感受，我会按你的反馈安排下一组。";
  if (/疼|痛|不舒服/.test(question)) return "出现疼痛时先停止当前动作。请告诉我是否已经出现疼痛，疼痛反馈会停止这个动作剩余的训练。";
  return `我目前可以结合${exercise.name}回答动作要领、次数、重量和休息的问题，也能处理暂停、继续及本组反馈。你现在想了解哪一项？`;
}
function loadTrainingRecords(userId: string, sessionIds: Set<string>) { return db.prepare("SELECT session_id, data_json FROM training_records WHERE user_id = ?").all(userId).filter((row: any) => sessionIds.has(row.session_id)).map((row: any) => JSON.parse(row.data_json)); }
// ── 进步 / 关系(纯函数见 src/progress.ts):同一份数据供 API、叙事记忆、首页唤回复用 ──
const relationshipCache = new Map<string, { at: number; data: Relationship }>();
function userSessions(userId: string): any[] { return (db.prepare("SELECT data_json FROM workout_sessions WHERE user_id = ? ORDER BY created_at DESC").all(userId) as any[]).map(x => JSON.parse(x.data_json)); }
function userRelationship(userId: string): Relationship {
  const hit = relationshipCache.get(userId); if (hit && Date.now() - hit.at < 60_000) return hit.data;
  // 只认"真的练过"的会话:完成过任何一组就算一次;仅生成计划(preview,零组)不算
  const dates = userSessions(userId)
    .filter((s: any) => s.status === "completed" || (s.exercises ?? []).some((e: any) => e.completedSets > 0))
    .map((s: any) => s.runtime?.completedAt ?? s.createdAt)
    .filter((x: unknown): x is string => typeof x === "string");
  const data = relationship(dates, Date.now()); relationshipCache.set(userId, { at: Date.now(), data }); return data;
}
function userSets(userId: string) {
  const sessions = userSessions(userId), ids = new Set(sessions.map((s: any) => s.sessionId));
  const sets = (db.prepare("SELECT data_json FROM set_records").all() as any[]).map(x => JSON.parse(x.data_json)).filter((s: any) => s && ids.has(s.sessionId) && typeof s.actualReps === "number");
  return { sessions, sets };
}
function userProgress(userId: string) {
  const { sessions, sets } = userSets(userId);
  const names = Object.fromEntries(exercises.map(e => [e.id, e.name]));
  const rows = exerciseProgress(sets, names);
  // 规律性口径:场次与组数是真实发生的事实,不依赖用户填报次数
  const trained = sessions.filter((s: any) => s.status === "completed" || (s.exercises ?? []).some((e: any) => e.completedSets > 0));
  const sessionDates = trained.map((s: any) => s.runtime?.completedAt ?? s.createdAt).filter((x: unknown): x is string => typeof x === "string");
  const setDates = sets.map((s: any) => s.completedAt).filter((x: unknown): x is string => typeof x === "string");
  return { exercises: rows, summary: progressSummary(rows), weekly: weekOverWeek(sets, names), volume: weeklyVolume(sessionDates, setDates) };
}
function activeProgram(userId: string): Program | null {
  const row = db.prepare("SELECT data_json FROM programs WHERE user_id = ? AND status != 'abandoned' ORDER BY created_at DESC LIMIT 1").get(userId) as { data_json: string } | undefined;
  return row ? JSON.parse(row.data_json) as Program : null;
}
function saveSession(session: WorkoutSession) {
  prepareWorkout(session);
  db.prepare("UPDATE workout_sessions SET status = ?, data_json = ? WHERE id = ?").run(session.status, JSON.stringify(session), session.sessionId);
  db.prepare("DELETE FROM workout_exercises WHERE session_id = ?").run(session.sessionId);
  session.exercises.forEach(x => db.prepare("INSERT OR REPLACE INTO workout_exercises VALUES (?, ?, ?, ?)").run(x.id, session.sessionId, x.exerciseId, JSON.stringify(x)));
}
function skipUnstructuredWarmup(session: WorkoutSession) { if (session.status !== "warming_up") return; completeWarmup(session); session.runtime.events.pop(); }
// 废弃计划收档:预览态会话从未开始,超过 6 小时即视为放弃(否则 preview 会无限堆积并挡住课程开局)
function archiveStalePreviews(userId: string, maxAgeMs = 6 * 3600 * 1000) {
  const rows = db.prepare("SELECT id, created_at FROM workout_sessions WHERE user_id = ? AND status = 'preview'").all(userId) as Array<{ id: string; created_at: string }>;
  for (const row of rows) {
    if (Date.now() - Date.parse(row.created_at) > maxAgeMs) db.prepare("UPDATE workout_sessions SET status = 'aborted' WHERE id = ?").run(row.id);
  }
}
function persistSet(record: SetRecord) { db.prepare("INSERT INTO set_records (id, workout_exercise_id, data_json) VALUES (?, ?, ?)").run(record.id, record.workoutExerciseId, JSON.stringify(record)); }
/** A7(2026-11-09):/survey 只接受主观量表字段。
 * 此前 body 里的对象被原样展开进 training_records(`{...survey}` 在最后),客户端可以覆写
 * doseOutcomes / elapsedClockMs / startedAt 这些"实测证据",还没有任何审计痕迹。
 */
const SURVEY_NUMBER_FIELDS = ["perceivedFatigue", "suitability", "perceivedDurationMinutes", "boredomScore", "aversivenessScore", "physicalFatigueScore", "reuseIntentScore"] as const;
type SafeSurvey = { perceivedFatigue?: number; suitability?: number; discomfort?: boolean; perceivedDurationMinutes?: number; boredomScore?: number; aversivenessScore?: number; physicalFatigueScore?: number; reuseIntentScore?: number };
export function sanitizeSurvey(input: unknown): SafeSurvey {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>, out: Record<string, unknown> = {};
  for (const key of SURVEY_NUMBER_FIELDS) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) throw new UserInputError(`反馈字段 ${key} 必须是数字。`);
    out[key] = value;
  }
  const discomfort = raw.discomfort;
  if (discomfort !== undefined && discomfort !== null) {
    if (typeof discomfort !== "boolean") throw new UserInputError("反馈字段 discomfort 必须是布尔值。");
    out.discomfort = discomfort;
  }
  return out as SafeSurvey;
}
function finalize(session: WorkoutSession, survey?: SafeSurvey) {
  const exists = db.prepare("SELECT id, data_json FROM training_records WHERE session_id = ?").get(session.sessionId) as { id: string; data_json: string } | undefined;
  const safeSurvey = survey ? sanitizeSurvey(survey) : {};
  if (exists && survey) { const updated = { ...JSON.parse(exists.data_json), ...safeSurvey }; db.prepare("UPDATE training_records SET data_json = ? WHERE id = ?").run(JSON.stringify(updated), exists.id); saveExperiment(session, updated); return; }
  if (exists || !["completed", "aborted"].includes(session.status)) return;
  // H4(2026-11-06 全仓审查):预览态被 abort(从未开始)不写训练记录——
  // 没有 startedAt 的"训练"只能产出 elapsedClockMs:null 的脏行;废弃计划由 archiveStalePreviews 收档
  if (!session.runtime.startedAt || !session.runtime.completedAt) return;
  const sets = db.prepare("SELECT data_json FROM set_records WHERE json_extract(data_json, '$.sessionId') = ? ORDER BY json_extract(data_json, '$.completedAt')").all(session.sessionId).map((x: any) => JSON.parse(x.data_json) as SetRecord);
  const completedAt = session.runtime.completedAt!, startedAt = session.runtime.startedAt!;
  const doseOutcomes: DoseOutcome[] = session.exercises.map(exercise => {
    const exerciseSets = sets.filter(x => x.workoutExerciseId === exercise.id);
    return { exerciseId: exercise.exerciseId, planned: { sets: exercise.sets, targetReps: exercise.targetReps, loadKg: exercise.recommendedWeight, targetRir: exercise.targetRir, restSeconds: exercise.restSeconds }, actual: { setRecords: exerciseSets.map(({ targetReps, actualReps, targetWeight, actualWeight, rir, rpe, feedback, pain }) => ({ targetReps, actualReps, targetWeight, actualWeight, rir, rpe, feedback, pain })), completedSets: exerciseSets.length, executionStatus: exercise.executionStatus, skippedReason: exercise.skippedReason }, recommendation: { action: exercise.recommendation.action, reasonCodes: exercise.recommendation.reasonCodes, confidence: exercise.recommendation.confidence, capabilityAdjustment: exercise.recommendation.capabilityAdjustment }, ...(exercise.originalExerciseId || exercise.replacementReason ? { replacement: { fromExerciseId: exercise.originalExerciseId, reason: exercise.replacementReason } } : {}) };
  });
  const record = { id: crypto.randomUUID(), userId: session.userId, sessionId: session.sessionId, startedAt, completedAt, elapsedClockMs: Date.parse(completedAt) - Date.parse(startedAt), activeWorkoutMs: session.runtime.activeWorkoutMs, doseOutcomes, ...safeSurvey };
  db.prepare("INSERT INTO training_records VALUES (?, ?, ?, ?)").run(record.id, session.userId, session.sessionId, JSON.stringify(record));
  saveExperiment(session, record);
  // 课程进度:计划↔执行在此绑定。完成的是"这一场模板",证据是真实的组记录
  if (session.program) {
    try {
      const row = db.prepare("SELECT data_json FROM programs WHERE id = ?").get(session.program.programId) as { data_json: string } | undefined;
      if (row) {
        const program = JSON.parse(row.data_json) as Program;
        const measured = sets.filter(s => s.actualRepsSource === "counted" || s.actualRepsSource === "reported").length;
        const updated = recordCompletion(program, {
          programSessionId: session.program.programSessionId,
          workoutSessionId: session.sessionId,
          completedAt: session.runtime.completedAt ?? new Date().toISOString(),
          planned: session.exercises.map(e => ({ exerciseId: e.exerciseId, name: e.name, sets: e.sets, targetReps: e.targetReps })),
          measuredSets: measured,
        });
        db.prepare("UPDATE programs SET status = ?, data_json = ? WHERE id = ?").run(updated.status, JSON.stringify(updated), updated.programId);
      }
    } catch { /* 课程进度失败不影响训练落库 */ }
  }
  for (const exercise of session.exercises) {
    const exerciseSets = sets.filter(x => x.workoutExerciseId === exercise.id);
    if (!exerciseSets.length) continue;
    const last = exerciseSets.at(-1)!;
    const performance = { userId: session.userId, exerciseId: exercise.exerciseId, performedAt: completedAt, weightKg: last.actualWeight, reps: last.actualReps, sets: exerciseSets.length, rir: last.rir, rpe: last.rpe, completed: exercise.executionStatus === "completed", pain: exercise.executionStatus === "pain", perceivedDifficulty: last.feedback };
    db.prepare("INSERT INTO exercise_performances (user_id, exercise_id, performed_at, data_json) VALUES (?, ?, ?, ?)").run(session.userId, exercise.exerciseId, completedAt, JSON.stringify(performance));
  }
}

function saveExperiment(session: WorkoutSession, survey: any = {}) {
  const row = createExperimentRecord(session, { ...survey, physicalFatigueScore: survey.physicalFatigueScore ?? survey.perceivedFatigue }, survey.doseOutcomes ?? []);
  db.prepare("INSERT OR REPLACE INTO experiment_records VALUES (?, ?, ?, ?, ?)").run(session.sessionId, session.userId, row.experienceMode, JSON.stringify(row), session.createdAt);
}
function experimentRows(origin: DataOrigin | "all" = "human") { const rows = db.prepare("SELECT data_json FROM experiment_records ORDER BY created_at DESC").all().map((x: any) => JSON.parse(x.data_json)); return origin === "all" ? rows : rows.filter((x: any) => x.dataOrigin === origin); }
function requestedOrigin(url: URL): DataOrigin | "all" { const value = url.searchParams.get("dataOrigin") ?? "human"; if (!["human", "automated_test", "demo", "all"].includes(value)) throw new Error("无效的 dataOrigin。"); return value as DataOrigin | "all"; }
function aggregate(rows: any[]) { return (["minimal","content","companion"] as ExperienceMode[]).map(mode => { const values = rows.filter(x => x.experienceMode === mode), avg = (key: string) => values.length ? Number((values.reduce((n, x) => n + Number(x[key] ?? 0), 0) / values.length).toFixed(2)) : null; return { mode, sessions: values.length, averageActualDuration: avg("actualDurationMinutes"), averagePerceivedDuration: avg("perceivedDurationMinutes"), completionRate: values.length ? Number((values.filter(x => x.completed).length / values.length).toFixed(2)) : null, boredom: avg("boredomScore"), aversiveness: avg("aversivenessScore"), reuseIntent: avg("reuseIntentScore") }; }); }

const server = createServer(async (req, res) => {
  const requestUrl = new URL(req.url ?? "/", "http://localhost");
  const requestId = crypto.randomUUID();
  let requestUserId = requestUrl.searchParams.get("userId") ?? undefined;
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), requestId, userId: requestUserId, sessionId: requestUrl.pathname.match(/\/workouts\/([^/]+)/)?.[1], request: `${req.method} ${requestUrl.pathname}` }));
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (mobileAccessKey && url.pathname.startsWith("/api/") && req.headers["x-mobile-key"] !== mobileAccessKey) return json(res, 401, { error: "请输入本次移动测试口令。" });
    // H5(2026-11-06 全仓审查):本机 API 来源防护。
    // ① Host 必须是回环名——DNS rebinding(攻击域名解析到 127.0.0.1)时 Host 是攻击者域名,直接拒;
    // ② 写请求若带 Origin,Origin 必须也是本机——挡掉恶意网页用 text/plain 简单请求驱动的 CSRF。
    //    curl/同源 fetch 不受影响(curl 不发 Origin;同源 Origin 是 localhost)。
    // 带合法移动口令的请求放行(手机经 adb reverse 时 Host 本就是 127.0.0.1;LAN 直连靠口令鉴权)。
    {
      const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
      const stripPort = (h: string) => h.replace(/:\d+$/, "").replace(/^\[/, "").replace(/\]$/, "");
      const hostName = stripPort(req.headers.host ?? "");
      const mobileKeyOk = mobileAccessKey !== undefined && req.headers["x-mobile-key"] === mobileAccessKey;
      if (url.pathname.startsWith("/api/") && !mobileKeyOk && !localHosts.has(hostName)) return json(res, 403, { error: "请通过本机应用访问。" });
      if (url.pathname.startsWith("/api/") && !mobileKeyOk && req.method !== "GET" && req.method !== "HEAD" && typeof req.headers.origin === "string") {
        let originName = "";
        try { originName = stripPort(new URL(req.headers.origin).host); } catch { originName = ""; }
        if (!localHosts.has(originName)) return json(res, 403, { error: "已拒绝跨站请求。" });
      }
    }
    if (req.method === "GET" && ["/workout-atmosphere.png", "/tm-ring.png"].includes(url.pathname)) return sendFile(res, "image/png", url.pathname === "/tm-ring.png" ? new URL("../public/tm-ring.png", import.meta.url) : atmospherePath, "public, max-age=86400");
    if (req.method === "GET" && url.pathname === "/phone-preview.html") return sendFile(res, "text/html; charset=utf-8", new URL("../public/phone-preview.html", import.meta.url), "no-store");
    if (req.method === "GET" && ["/visual-design.css", "/visual-design.js", "/home-chat.css", "/home-chat.js"].includes(url.pathname)) {
      const mime = url.pathname.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8";
      return sendFile(res, mime, new URL(`../public${url.pathname}`, import.meta.url), "no-cache");
    }
    if (req.method === "GET" && url.pathname.startsWith("/coach-media/") && coachMedia.has(url.pathname.slice("/coach-media/".length))) {
      return sendFile(res, "image/jpeg", new URL(`../public${url.pathname}`, import.meta.url), "public, max-age=86400");
    }
    // RepDB 免费档静帧(2026-11-09):只允许这个目录 + 这个文件名形态,避免路径穿越
    if (req.method === "GET" && /^\/media\/repdb\/[a-z0-9][a-z0-9-]*\.webp$/.test(url.pathname)) {
      return sendFile(res, "image/webp", new URL(`../public${url.pathname}`, import.meta.url), "public, max-age=86400");
    }
    if (req.method === "GET" && url.pathname === "/trainmind-ui.css") return sendFile(res, "text/css; charset=utf-8", new URL("../public/trainmind-ui.css", import.meta.url), "no-cache");
    if (req.method === "GET" && svgAssets.has(url.pathname.slice(1))) return sendFile(res, "image/svg+xml", new URL(`../public/${url.pathname.slice(1)}`, import.meta.url), "public, max-age=86400");
    if (req.method === "GET" && (url.pathname === "/" || (url.pathname === "/experiment" && devPageEnabled))) return sendFile(res, "text/html; charset=utf-8", htmlPath);
    // 组内听觉感知模块(纯 JS,浏览器 <script type="module"> 加载;no-store 便于本地迭代)
    if (req.method === "GET" && url.pathname === "/perception.js") return sendFile(res, "text/javascript; charset=utf-8", fileURLToPath(new URL("./perception.js", import.meta.url)), "no-store");
    // 组内感知自检页(真机验收工具):实时看基线与触发,把"它在听吗"变成可见
    if (req.method === "GET" && url.pathname === "/perception-check") return sendFile(res, "text/html; charset=utf-8", fileURLToPath(new URL("../public/perception-check.html", import.meta.url)));
    if (req.method === "GET" && url.pathname === "/api/schema/workout") return json(res, 200, workoutJsonSchema);
    if (req.method === "GET" && url.pathname === "/api/coach/settings") { await chatConfigReady; return json(res, 200, chatStatus()); }
    if (req.method === "POST" && url.pathname === "/api/coach/settings") {
      requireLocalSettings(req); await chatConfigReady;
      const input = await body(req), baseUrl = String(input.baseUrl ?? "").trim().replace(/\/$/, ""), model = String(input.model ?? "").trim(), protocol = input.protocol === "ollama" ? "ollama" : input.protocol === "openai" ? "openai" : input.protocol === "tencent" ? "tencent" : null;
      let parsed: URL; try { parsed = new URL(baseUrl); } catch { throw Error("请输入有效的模型接口地址。"); }
      if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || parsed.search || baseUrl.length > 1000) throw Error("接口地址必须是 HTTP/HTTPS 地址，密钥请填入单独的密钥框。");
      if (!protocol || model.length > 200 || /[\r\n]/.test(model)) throw Error("请检查接口格式和模型名称。");
      if (typeof input.apiKey !== "string" || input.apiKey.length > 8000 || /[\r\n]/.test(input.apiKey)) throw Error("密钥格式不正确。");
      const apiKey = input.clearKey === true ? "" : input.apiKey.trim() || (baseUrl === chatConfig.baseUrl && protocol === chatConfig.protocol ? chatConfig.apiKey : "");
      const protectedKey = await protectChatKey(apiKey);
      db.prepare("INSERT OR REPLACE INTO app_settings (name, data_json) VALUES ('coach', ?)").run(JSON.stringify({ baseUrl, model, protocol, protectedKey }));
      chatConfig = { baseUrl, model, protocol, apiKey }; chatConnectedAt = null;
      return json(res, 200, chatStatus());
    }
    if (req.method === "POST" && url.pathname === "/api/coach/models") {
      requireLocalSettings(req); await chatConfigReady;
      const base = chatConfig.baseUrl.replace(/\/$/, ""), modelBase = chatConfig.protocol === "tencent" ? base.replace(/\/plan\/v3(?:\/chat\/completions)?$/, "/v1") : base;
      const endpoint = chatConfig.protocol === "ollama" ? `${base.replace(/\/api(?:\/chat)?$/, "")}/api/tags` : `${modelBase.replace(/\/chat\/completions$/, "")}/models`;
      if (!base) throw Error("请先保存模型接口地址。");
      let response: Response;
      try { response = await fetch(endpoint, { redirect: "error", signal: AbortSignal.timeout(10000), headers: chatConfig.apiKey ? { authorization: `Bearer ${chatConfig.apiKey}` } : {} }); } catch { throw Error("无法读取模型列表，请检查网络或手动填写模型名。"); }
      if (!response.ok) throw Error(response.status === 401 || response.status === 403 ? "读取模型列表需要有效的密钥或账号权限。" : "服务未提供模型列表，请确认模型名并手动填写。");
      let data: any; try { data = await response.json(); } catch { throw Error("模型列表格式不正确，请手动填写模型名。"); }
      const models = chatConfig.protocol === "ollama" ? data.models?.map((x: any) => x.name) : data.data?.map((x: any) => x.id);
      return json(res, 200, { models: Array.isArray(models) ? models.filter((x: any) => typeof x === "string").slice(0, 100) : [] });
    }
    if (req.method === "POST" && url.pathname === "/api/coach/test") {
      requireLocalSettings(req);
      const reply = await modelReply([{ role: "user", content: "请用中文回复一句简短的问候，用于验证模型连接。" }], 300);
      return json(res, 200, { ...chatStatus(), reply });
    }
    if (req.method === "GET" && url.pathname === "/api/voice/status") {
      const localWhisper = await sttSidecarReady.catch(() => false);
      return json(res, 200, { offlineRecognition: localWhisper || await offlineSpeechAvailable, sttProvider: localWhisper ? "local-whisper" : process.platform === "win32" && await offlineSpeechAvailable ? "windows" : "none" });
    }
    if (req.method === "POST" && ["/api/voice/open-browser", "/api/voice/open-settings"].includes(url.pathname)) {
      if (process.platform !== "win32") return json(res, 400, { error: "请手动在系统浏览器中打开当前地址，或打开系统麦克风设置。" });
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "") || !req.headers["content-type"]?.startsWith("application/json") || (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)) return json(res, 403, { error: "请使用本机应用内的麦克风帮助按钮。" });
      const target = url.pathname.endsWith("open-browser") ? `http://localhost:${port}/` : "ms-settings:privacy-microphone";
      await new Promise<void>((resolve, reject) => {
        const child = spawn("explorer.exe", [target], { detached: true, windowsHide: true, stdio: "ignore" });
        child.once("error", () => reject(Error("无法打开系统窗口，请手动打开浏览器或 Windows 麦克风设置。")));
        child.once("spawn", () => { child.unref(); resolve(); });
      });
      return json(res, 200, { opened: true });
    }
    if (req.method === "POST" && url.pathname === "/api/voice/transcribe") {
      const localWhisper = await sttSidecarReady.catch(() => false);
      if (!localWhisper && !await offlineSpeechAvailable) return json(res, 503, { error: "当前设备没有可用的本地中文识别引擎。" });
      if (!req.headers["content-type"]?.startsWith("audio/wav")) return json(res, 415, { error: "请使用 WAV 录音。" });
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) return json(res, 413, { error: "请将单次语音控制在20秒内。" }); chunks.push(Buffer.from(chunk)); }
      const audio = Buffer.concat(chunks);
      if (audio.length < 44) return json(res, 400, { error: "录音格式无效，请重新说话。" });
      if (localWhisper) {
        // 本地 whisper:接受 WAV 也接受其他可解码容器;422(没听到)与超时如实上抛
        try {
          const result = await sttTranscribe(audio);
          if (!result.text) {
            try { runtimeTelemetry.recordAsrRetry(url.searchParams.get("userId")); } catch { /* 遥测失败不影响语音链路 */ }
            return json(res, 422, { error: "没有听到清晰的语音，请再说一次。" });
          }
          return json(res, 200, { text: result.text, provider: "local-whisper", ...(result.confidence !== undefined ? { confidence: result.confidence } : {}) });
        } catch (e) {
          console.warn("local whisper transcribe failed:", e);
          return json(res, 502, { error: "本地识别暂时不可用，请再说一次。" });
        }
      }
      if (audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE") return json(res, 400, { error: "录音格式无效，请重新说话。" });
      const result = await windowsSpeech(`
        $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd());$stream=New-Object IO.MemoryStream(,$bytes);
        $engine=New-Object System.Speech.Recognition.SpeechRecognitionEngine([Globalization.CultureInfo]::GetCultureInfo('zh-CN'));
        try {$engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar));$engine.SetInputToWaveStream($stream);$texts=@();$scores=@();for($i=0;$i -lt 30;$i++){try{$result=$engine.Recognize([TimeSpan]::FromSeconds(10))}catch{if($texts.Count -gt 0 -and $_.Exception.InnerException -is [InvalidOperationException]){break};throw};if($null -eq $result){break};$texts+=$result.Text;$scores+=$result.Confidence};$confidence=if($scores.Count){($scores|Measure-Object -Minimum).Minimum}else{0};@{text=($texts -join '，');confidence=$confidence;segments=$texts.Count;provider='windows-local'}|ConvertTo-Json -Compress} finally {$engine.Dispose();$stream.Dispose()}
      `, audio);
      if (!result.text) {
        try { runtimeTelemetry.recordAsrRetry(url.searchParams.get("userId")); } catch { /* 遥测失败不影响语音链路 */ }
        return json(res, 422, { error: "没有听到清晰的语音，请再说一次。" });
      }
      return json(res, 200, result);
    }
    if (req.method === "POST" && url.pathname === "/api/voice/tts") {
      // 神经网络 TTS 代理(speech-02-turbo):文本 → 音频;未配置时 503,前端自动回退本地 TTS
      if (!ttsConfig.url || !ttsConfig.key || !ttsConfig.model) return json(res, 503, { error: "tts_unconfigured" });
      const input = await body(req);
      const text = typeof input.text === "string" ? input.text.trim().slice(0, 300) : "";
      if (!text) return json(res, 400, { error: "请提供要播报的文本。" });
      const cached = ttsCache.get(text);
      if (cached) { res.writeHead(200, { "content-type": "audio/mpeg", "content-length": cached.length }); return res.end(cached); }
      try {
        // 该供应商返回 302 → 阿里云 OSS 预签名地址,必须再 GET 一次(不能跟随 POST 跳转)
        const upstream = await fetch(ttsConfig.url, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(25000), headers: { "content-type": "application/json", authorization: `Bearer ${ttsConfig.key}` }, body: JSON.stringify({ model: ttsConfig.model, input: text, voice: ttsConfig.voice }) });
        let audioBuffer: Buffer;
        if (upstream.status >= 300 && upstream.status < 400) {
          const location = upstream.headers.get("location");
          // 只允许 https(或本地回环,便于离线测试),防止被跳到任意明文地址
          const safeTarget = /^https:\/\//i.test(location) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(location);
          if (!location || !safeTarget) throw Error("tts_bad_redirect");
          const file = await fetch(location, { signal: AbortSignal.timeout(25000) }); // 预签名地址,不带鉴权头
          if (!file.ok) throw Error(`tts_cdn_${file.status}`);
          audioBuffer = Buffer.from(await file.arrayBuffer());
        } else {
          if (!upstream.ok) throw Error(`tts_upstream_${upstream.status}`);
          audioBuffer = Buffer.from(await upstream.arrayBuffer());
        }
        const audio = audioBuffer;
        if (!audio.length) throw Error("tts_empty");
        if (ttsCache.size >= 200) ttsCache.delete(ttsCache.keys().next().value!);
        ttsCache.set(text, audio);
        res.writeHead(200, { "content-type": "audio/mpeg", "content-length": audio.length }); return res.end(audio);
      } catch { return json(res, 502, { error: "语音合成暂时不可用。" }); }
    }
    if (req.method === "POST" && url.pathname === "/api/voice/asr_retry") {
      // 7B.2.1:浏览器端识别失败(SpeechRecognition onerror)上报;fire-and-forget,永不阻塞语音 UI
      const input = await body(req);
      const asrUser = typeof input.userId === "string" && input.userId ? input.userId : requestUserId;
      const code = typeof input.reason === "string" && input.reason ? `asr_${input.reason.replace(/[^a-z0-9-]/gi, "")}` : "asr_no_speech";
      try { runtimeTelemetry.recordAsrRetry(asrUser, code); } catch { /* 遥测失败不影响语音链路 */ }
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/history") {
      const userId = url.searchParams.get("userId") ?? "demo-user";
      const rows = db.prepare("SELECT tr.data_json AS record_json, ws.data_json AS session_json FROM training_records tr JOIN workout_sessions ws ON ws.id = tr.session_id WHERE tr.user_id = ? ORDER BY ws.created_at DESC LIMIT 30").all(userId) as any[];
      return json(res, 200, { sessions: rows.map(row => { const workout = JSON.parse(row.session_json); const sets = db.prepare("SELECT data_json FROM set_records WHERE json_extract(data_json, '$.sessionId') = ? ORDER BY json_extract(data_json, '$.completedAt')").all(workout.sessionId).map((x: any) => JSON.parse(x.data_json)); return { record: JSON.parse(row.record_json), workout, sets }; }) });
    }
    if (req.method === "GET" && url.pathname === "/api/profile") {
      const userId = url.searchParams.get("userId") ?? "demo-user", row = db.prepare("SELECT data_json FROM experience_preferences WHERE user_id = ?").get(userId) as { data_json: string } | undefined;
      const sessions = db.prepare("SELECT data_json FROM workout_sessions WHERE user_id = ? AND status = 'completed'").all(userId).map((x: any) => JSON.parse(x.data_json) as WorkoutSession);
      const ids = new Set(sessions.map(x => x.sessionId)), sets = db.prepare("SELECT data_json FROM set_records").all().map((x: any) => JSON.parse(x.data_json) as SetRecord).filter(x => ids.has(x.sessionId)), trainingRecords = loadTrainingRecords(userId, ids);
      const context = db.prepare("SELECT data_json FROM session_contexts WHERE user_id = ? ORDER BY created_at DESC LIMIT 1").get(userId) as { data_json: string } | undefined;
      return json(res, 200, { userId, experiencePreference: row ? JSON.parse(row.data_json) : null, trainingOverview: { sessions: sessions.length, sets: sets.length }, trainingModel: buildUserTrainingModel(userId, { sessions, sets, trainingRecords }), latestContext: context ? JSON.parse(context.data_json) : null });
    }
    // 日常陪伴照面(2026-11-09):训练之外"它先说一句"。只读，话术由规则产出。
    if (req.method === "GET" && url.pathname === "/api/companion") {
      const userId = url.searchParams.get("userId") ?? "demo-user";
      const rows = (db.prepare("SELECT data_json FROM workout_sessions WHERE user_id = ? AND status = 'completed'").all(userId) as Array<{ data_json: string }>)
        .map(r => JSON.parse(r.data_json));
      const done = rows.map(s => (s.runtime?.completedAt ?? s.createdAt) as string).filter(Boolean).sort();
      const last = done.at(-1);
      const days = last ? Math.floor((Date.now() - Date.parse(last)) / 86_400_000) : null;
      const rel = userRelationship(userId);
      const ids = new Set((db.prepare("SELECT id FROM workout_sessions WHERE user_id = ?").all(userId) as Array<{ id: string }>).map(r => r.id));
      const setsForLedger = (db.prepare("SELECT data_json FROM set_records").all() as Array<{ data_json: string }>)
        .map(r => JSON.parse(r.data_json)).filter((s: any) => ids.has(s.sessionId) && typeof s.completedAt === "string");
      const ledger = buildMuscleLedger({ sets: setsForLedger, musclesByExercise: Object.fromEntries(exercises.map(e => [e.id, e.primaryMuscles])) });
      const neglectedLabels = ledger.filter(x => x.state === "neglected").map(x => x.label);
      const trainedToday = last ? new Date(last).toDateString() === new Date().toDateString() : false;
      return json(res, 200, {
        userId,
        checkIn: buildCheckIn({
          persona: (url.searchParams.get("persona") as "fat_loss" | "general") ?? "fat_loss",
          daysSinceLast: days, streakWeeks: rel.streakWeeks ?? 0, totalSessions: done.length,
          neglectedLabels, trainedToday,
        }),
      });
    }
    // 数据导出(2026-11-09, owner 要求):"数据资产归用户"。JSON 全量 + 可选删除。
    if (req.method === "GET" && url.pathname === "/api/export") {
      const userId = url.searchParams.get("userId") ?? "demo-user";
      const one = (sql: string) => (db.prepare(sql).all(userId) as Array<{ data_json: string }>).map(r => JSON.parse(r.data_json));
      const sessions = one("SELECT data_json FROM workout_sessions WHERE user_id = ? ORDER BY created_at");
      const ids = new Set(sessions.map((s: any) => s.sessionId));
      const sets = (db.prepare("SELECT data_json FROM set_records").all() as Array<{ data_json: string }>).map(r => JSON.parse(r.data_json)).filter((x: any) => ids.has(x.sessionId));
      const bundle = {
        exportedAt: new Date().toISOString(), userId, schemaVersion: 1,
        note: "这是你自己的训练数据。场次/组记录为本地原始结构，未做二次加工。",
        sessions, sets,
        trainingRecords: one("SELECT data_json FROM training_records WHERE user_id = ?"),
        programs: one("SELECT data_json FROM programs WHERE user_id = ?"),
        contexts: one("SELECT data_json FROM session_contexts WHERE user_id = ?"),
        experimentRecords: one("SELECT data_json FROM experiment_records WHERE user_id = ?"),
        // Nit-2:语音反馈原文与交互事件也属于用户资产，导出必须包含（删除路径同样覆盖它们）
        // 注意：set_feedbacks 没有 data_json 列（这一版是宽表），按实际列取。
        setFeedbacks: db.prepare("SELECT id, set_record_id, difficulty, fatigue, pain_json, source, transcript, captured_at FROM set_feedbacks WHERE set_record_id IN (SELECT id FROM set_records WHERE exercise_instance_id IN (SELECT id FROM exercise_instances WHERE session_id IN (SELECT id FROM workout_sessions WHERE user_id = ?)))").all(userId),
        interactionEvents: db.prepare("SELECT id, session_id, seq, occurred_at, actor, modality, action, intent, success, transcript, error_json FROM interaction_events WHERE session_id IN (SELECT id FROM workout_sessions WHERE user_id = ?)").all(userId),
      };
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="trainmind-${userId}-${new Date().toISOString().slice(0, 10)}.json"`, "cache-control": "no-store" });
      return res.end(JSON.stringify(bundle, null, 2));
    }
    // 删除全部数据(2026-11-09):合规要求"能删"。顺序遵守外键依赖。
    if (req.method === "DELETE" && url.pathname === "/api/export") {
      const userId = url.searchParams.get("userId") ?? "demo-user";
      db.exec("BEGIN IMMEDIATE");
      try {
        const ids = (db.prepare("SELECT id FROM workout_sessions WHERE user_id = ?").all(userId) as Array<{ id: string }>).map(r => r.id);
        for (const id of ids) {
          // v2 组行的 data_json 是 '{}'，按 json_extract 匹配永远不命中 → 之前"删除成功但残留"。
          // 改成走 exercise_instances 的 id 集合（v2 行有 exercise_instance_id），legacy 行仍按 json 匹配。
          db.prepare("DELETE FROM set_feedbacks WHERE set_record_id IN (SELECT id FROM set_records WHERE exercise_instance_id IN (SELECT id FROM exercise_instances WHERE session_id = ?) OR json_extract(data_json, '$.sessionId') = ?)").run(id, id);
          db.prepare("DELETE FROM set_records WHERE exercise_instance_id IN (SELECT id FROM exercise_instances WHERE session_id = ?) OR json_extract(data_json, '$.sessionId') = ?").run(id, id);
          db.prepare("DELETE FROM interaction_events WHERE session_id = ?").run(id);
          db.prepare("DELETE FROM adaptation_events WHERE session_id = ?").run(id);
          db.prepare("DELETE FROM observer_records WHERE session_id = ?").run(id);
          db.prepare("DELETE FROM workout_exercises WHERE session_id = ?").run(id);
          db.prepare("DELETE FROM exercise_instances WHERE session_id = ?").run(id);
        }
        for (const t of ["workout_sessions", "training_records", "experiment_records", "session_contexts", "programs", "user_training_model_snapshots", "experience_preferences"]) db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(userId);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      return json(res, 200, { ok: true, deleted: userId });
    }
    // 人体示意图(2026-11-09):8 个部位按账本状态上色，直接给 <img> 用。
    if (req.method === "GET" && url.pathname === "/api/body-map.svg") {
      const userId = url.searchParams.get("userId") ?? "demo-user";
      const ids = new Set((db.prepare("SELECT id FROM workout_sessions WHERE user_id = ?").all(userId) as Array<{ id: string }>).map(r => r.id));
      const sets = (db.prepare("SELECT data_json FROM set_records").all() as Array<{ data_json: string }>)
        .map(r => JSON.parse(r.data_json)).filter((x: any) => ids.has(x.sessionId) && typeof x.completedAt === "string");
      const ledger = buildMuscleLedger({ sets, musclesByExercise: Object.fromEntries(exercises.map(e => [e.id, e.primaryMuscles])) });
      res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" });
      return res.end(renderBodyMap(ledger, { width: Number(url.searchParams.get("w")) || 240 }));
    }
    // 每日日报(2026-11-09):把当天事实压成一页 Markdown。本地生成，不联外部服务。
    if (req.method === "GET" && url.pathname === "/api/report/daily") {
      const userId = url.searchParams.get("userId") ?? "demo-user";
      const localDate = (t: number | string) => new Date(t).toLocaleDateString("sv-SE");
      const today = localDate(Date.now());
      const rows = (db.prepare("SELECT data_json FROM workout_sessions WHERE user_id = ? AND status = 'completed'").all(userId) as Array<{ data_json: string }>)
        .map(r => JSON.parse(r.data_json));
      const todaySessions = rows.filter(s => localDate(s.runtime?.completedAt ?? s.createdAt) === today)
        .map(s => ({ sessionId: s.sessionId as string, goal: s.goal as string | undefined, minutes: Math.round((s.runtime?.activeWorkoutMs ?? 0) / 60000), sets: (s.exercises ?? []).reduce((n: number, e: any) => n + (e.completedSets ?? 0), 0), extra: s.kind === "extra" }));
      const ids = new Set(rows.map(s => s.sessionId));
      const sets = (db.prepare("SELECT data_json FROM set_records").all() as Array<{ data_json: string }>)
        .map(r => JSON.parse(r.data_json)).filter((x: any) => ids.has(x.sessionId) && typeof x.completedAt === "string");
      const ledger = buildMuscleLedger({ sets, musclesByExercise: Object.fromEntries(exercises.map(e => [e.id, e.primaryMuscles])) });
      const rel = userRelationship(userId);
      const mon = new Date(); mon.setHours(0, 0, 0, 0); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
      const weekSets = sets.filter((x: any) => Date.parse(x.completedAt) >= mon.getTime());
      const weekSessions = new Set(weekSets.map((x: any) => x.sessionId)).size;
      const md = buildDailyReport({
        userId, date: today, todaySessions,
        week: { sessions: weekSessions, sets: weekSets.length },
        streakWeeks: rel.streakWeeks ?? 0, muscles: ledger,
        headline: null,
        planNext: (() => { try { const prog = activeProgram(userId); if (!prog) return null; const st = programStatus(prog); return st.nextSession ? `${st.text} · ${st.nextSession.title}` : null; } catch { return null; } })(),
        bodyMapUrl: `/api/body-map.svg?userId=${encodeURIComponent(userId)}`,
      });
      if (url.searchParams.get("save") === "1") {
        const dir = new URL(`../reports/${userId}/`, import.meta.url);
        await mkdir(dir, { recursive: true });
        await writeFile(new URL(`${today}.md`, dir), md, "utf8");
      }
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" });
      return res.end(md);
    }
    // 肌群疲劳账本(2026-11-09):按部位聚合真实完成的组，给出恢复状态。
    // 纯读接口：不改任何状态；排课要不要用这些信号由调用方决定。
    if (req.method === "GET" && url.pathname === "/api/muscles") {
      const userId = url.searchParams.get("userId") ?? "demo-user";
      const ids = new Set((db.prepare("SELECT id FROM workout_sessions WHERE user_id = ?").all(userId) as Array<{ id: string }>).map(r => r.id));
      const sets = (db.prepare("SELECT data_json FROM set_records").all() as Array<{ data_json: string }>)
        .map(r => JSON.parse(r.data_json))
        .filter((s: any) => ids.has(s.sessionId) && typeof s.completedAt === "string");
      const musclesByExercise = Object.fromEntries(exercises.map(e => [e.id, e.primaryMuscles]));
      const ledger = buildMuscleLedger({ sets, musclesByExercise });
      return json(res, 200, { userId, muscles: ledger, signals: ledgerSignals(ledger) });
    }
    if (req.method === "GET" && url.pathname === "/api/progress") {
      // 进步叙事 + 关系进度 + 回归钩子 + 课程章节:一次给全端(记录页 / 首页 / 叙事记忆共用同一口径)
      const userId = url.searchParams.get("userId") ?? "demo-user", progress = userProgress(userId), rel = userRelationship(userId);
      const program = activeProgram(userId);
      return json(res, 200, { ...progress, relationship: rel, nudge: nudgeFor(rel), program: program ? { program, status: programStatus(program) } : null });
    }
    // ── 多周课程:Program → Week → Session(模板),执行事实在 workout_sessions ──
    if (req.method === "GET" && url.pathname === "/api/programs/active") {
      const userId = url.searchParams.get("userId") ?? "demo-user", program = activeProgram(userId);
      return json(res, 200, program ? { program, status: programStatus(program) } : { program: null, status: null });
    }
    if (req.method === "POST" && url.pathname === "/api/programs") {
      const input = await body(req);
      const userId = typeof input.userId === "string" && input.userId ? input.userId : "demo-user";
      const goal = typeof input.goal === "string" && input.goal.trim() ? input.goal.trim().slice(0, 40) : "全身力量";
      const program = buildProgram({
        programId: crypto.randomUUID(), userId, goal,
        weeks: Number.isInteger(input.weeks) ? input.weeks : 4,
        sessionsPerWeek: Number.isInteger(input.sessionsPerWeek) ? input.sessionsPerWeek : 3,
        environment: input.environment === "gym" ? "gym" : input.environment === "office" ? "office" : "home",
        targetMinutes: Number.isInteger(input.targetMinutes) ? input.targetMinutes : 30,
        equipment: Array.isArray(input.equipment) ? input.equipment.filter((e: unknown): e is string => typeof e === "string") : undefined,
      });
      db.prepare("INSERT INTO programs (id, user_id, status, data_json, created_at) VALUES (?, ?, ?, ?, ?)").run(program.programId, userId, program.status, JSON.stringify(program), program.createdAt);
      return json(res, 201, { program, status: programStatus(program) });
    }
    const programStart = url.pathname.match(/^\/api\/programs\/([^/]+)\/start$/);
    if (req.method === "POST" && programStart) {
      const input = await body(req);
      const program = activeProgram((typeof input.userId === "string" && input.userId) || "demo-user");
      if (!program || program.programId !== programStart[1]) throw new Error("课程不存在。");
      const status = programStatus(program), template = status.nextSession;
      if (!template) return json(res, 409, { error: "这个课程已经全部完成。" });
      const userId = program.userId;
      archiveStalePreviews(userId); // 只清 6 小时以上的废弃计划;刚生成还没开始的计划仍然占位
      // 开课程场次时:普通预览、以及"别的课程/已放弃课程"留下的场次都自动让位;
      // 只有本课程自己的未完成场次才互斥,防止同一场重复开局
      for (const inflight of db.prepare("SELECT id, data_json FROM workout_sessions WHERE user_id = ? AND status NOT IN ('completed','aborted')").all(userId) as Array<{ id: string; data_json: string }>) {
        try { const d = JSON.parse(inflight.data_json); if (d.program?.programId !== program.programId) db.prepare("UPDATE workout_sessions SET status = 'aborted' WHERE id = ?").run(inflight.id); } catch { /* 解析失败就不动 */ }
      }
      const running = db.prepare("SELECT id FROM workout_sessions WHERE user_id = ? AND status NOT IN ('completed','aborted') ORDER BY created_at DESC LIMIT 1").get(userId);
      if (running) {
        // 幂等:同一场课程已经生成过(还没开始训练),再点一次就把那一场给他,而不是报错卡死
        const existing = db.prepare("SELECT data_json FROM workout_sessions WHERE id = ?").get((running as { id: string }).id) as { data_json: string } | undefined;
        const parsed = existing ? JSON.parse(existing.data_json) as WorkoutSession : null;
        if (parsed?.program?.programId === program.programId && parsed.program.programSessionId === template.id) {
          return json(res, 200, { workout: prepareWorkout(parsed), program, status });
        }
        return json(res, 409, { error: "先把进行中的训练做完或结束，再来开课程里的下一场。" });
      }
      // A10(2026-11-09, owner 裁决):课程是产品主线 —— 真实训练必须进实验看板的"人类场次"。
      // 以前这里写死 "demo",导致按课程练的场次在默认视图(/api/experiment?dataOrigin=human)里一条都不出现。
      // 仍允许调用方显式传 dataOrigin(测试/实验需要隔离时)。
      const dataOrigin = ["human", "demo", "automated_test"].includes(String(input.dataOrigin)) ? input.dataOrigin as "human" | "demo" | "automated_test" : "human";
      const workout = await createWorkoutFromInput(userId, template.input, dataOrigin);
      // 计划↔执行绑定:这场训练知道自己是课程里的第几周第几场
      workout.program = { programId: program.programId, programSessionId: template.id, weekNumber: template.weekNumber, sessionNumber: template.sessionNumber };
      // A8(2026-11-09):上面的 running 检查与这里的落库之间隔着一次 await(createWorkoutFromInput
      // 要等 LLM,窗口是秒级),连点两下会各落一条同 programSessionId 的 preview 会话,
      // 而 /api/workouts/active 按时间取最新 → 用户可能拿到"不用的副本"继续练。
      // 落库前在事务里再查一次:已经有同场次就幂等返回它,别的会话占位就 409。
      db.exec("BEGIN IMMEDIATE");
      try {
        const racing = db.prepare("SELECT id, data_json FROM workout_sessions WHERE user_id = ? AND status NOT IN ('completed','aborted') ORDER BY created_at DESC LIMIT 1").get(userId) as { id: string; data_json: string } | undefined;
        if (racing) {
          const parsed = JSON.parse(racing.data_json) as WorkoutSession;
          db.exec("COMMIT");
          if (parsed?.program?.programId === program.programId && parsed.program.programSessionId === template.id) return json(res, 200, { workout: prepareWorkout(parsed), program, status });
          return json(res, 409, { error: "先把进行中的训练做完或结束，再来开课程里的下一场。" });
        }
        persistNewWorkout(workout);
        db.exec("COMMIT");
      } catch (error) { try { db.exec("ROLLBACK"); } catch { /* 连接已回滚 */ } throw error; }
      return json(res, 201, { workout, program, status });
    }
    if (req.method === "GET" && url.pathname === "/api/experiment") { const origin = requestedOrigin(url), rows = experimentRows(origin); return json(res, 200, { dataOrigin: origin, sessions: rows, summary: aggregate(rows) }); }
    if (req.method === "GET" && url.pathname === "/api/experiment/export.json") return json(res, 200, experimentRows(requestedOrigin(url)));
    if (req.method === "GET" && url.pathname === "/api/experiment/export.csv") { res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=trainmind-experiment.csv" }); return res.end(experimentRecordsCsv(experimentRows(requestedOrigin(url)))); }
    if (req.method === "GET" && url.pathname === "/api/workouts/active") {
      const userId = url.searchParams.get("userId") ?? "demo-user";
      archiveStalePreviews(userId);
      const stale = db.prepare("SELECT id, data_json FROM workout_sessions WHERE user_id = ? AND status NOT IN ('completed','aborted') AND datetime(created_at) < datetime('now', '-48 hours')").all(userId) as Array<{ id: string; data_json: string }>;
      for (const row of stale) { try { const d = JSON.parse(row.data_json) as { status?: string }; d.status = "aborted"; db.prepare("UPDATE workout_sessions SET status='aborted', data_json=? WHERE id=?").run(JSON.stringify(d), row.id); } catch { db.prepare("UPDATE workout_sessions SET status='aborted' WHERE id=?").run(row.id); } }
      // 课程场次(preview 但带 program)也算"进行中",否则生成后没开始就再也进不去
      const candidates = (db.prepare("SELECT data_json FROM workout_sessions WHERE user_id = ? AND status NOT IN ('completed','aborted') ORDER BY created_at DESC").all(userId) as Array<{ data_json: string }>)
        .map(r => JSON.parse(r.data_json) as WorkoutSession)
        .filter(w => w.status !== "preview" || Boolean(w.program));
      const session = candidates.length ? prepareWorkout(candidates[0]!) : null;
      if (session?.status === "warming_up") { skipUnstructuredWarmup(session); saveSession(session); }
      return json(res, 200, { workout: session });
    }
    const alternativesMatch = url.pathname.match(/^\/api\/workouts\/([^/]+)\/alternatives$/);
    if (req.method === "GET" && alternativesMatch) {
      const session = loadSession(alternativesMatch[1]), index = Number(url.searchParams.get("index"));
      if (session.status !== "preview" || !Number.isInteger(index) || index < 0 || index >= session.exercises.length) throw new Error("动作位置无效。");
      const current = session.exercises[index], source = exercises.find(x => x.id === current.exerciseId)!;
      const alternatives = exercises.filter(x => x.id !== source.id && x.movementPattern === source.movementPattern && x.environments.includes(session.environment) && !x.contraindicationTags.some(tag => session.restrictions.includes(tag)) && !session.exercises.some(e => e.exerciseId === x.id) && x.equipmentIds.some(id => session.environment !== "gym" || id === "bodyweight" || gymEquipment.some(g => g.gymId === session.gymId && g.equipmentId === id && g.available)))
        .sort((a, b) => relationScore(source.id, b.id, "other") - relationScore(source.id, a.id, "other"))
        .map(x => ({ id: x.id, name: x.name, instructions: x.instructions, movementPattern: x.movementPattern, equipmentIds: x.equipmentIds }));
      return json(res, 200, { alternatives });
    }
    if (req.method === "GET" && /^\/api\/workouts\/[^/]+$/.test(url.pathname)) return json(res, 200, { workout: loadSession(url.pathname.split("/")[3]) });
    const coachMatch = url.pathname.match(/^\/api\/workouts\/([^/]+)\/coach$/);
    if (req.method === "POST" && (coachMatch || url.pathname === "/api/coach")) {
      const input = await body(req);
      if (typeof input.message !== "string" || !input.message.trim() || input.message.length > 500) return json(res, 400, { error: "请输入不超过500字的问题。" });
      const sessionId = coachMatch?.[1] ?? input.sessionId;
      const session = typeof sessionId === "string" && sessionId ? loadSession(sessionId) : undefined;
      const history = Array.isArray(input.history) ? input.history.slice(-8).filter(x => x && ["user", "assistant"].includes(x.role) && typeof x.content === "string").map(x => ({ role: x.role, content: x.content.slice(0, 500) })) : [];
      // 场外多轮编排:命中就走规则(槽位由 collectProgramSlots 收),不调 LLM ——
      // 演示里这一步必须"立刻回",不能被模型延迟拖住;参数也绝不交给模型猜。
      // 多轮续接:用户第二句往往只是"每周三次"这种回答,不含"计划"二字,
      // 所以还要看历史里上一问是不是我们自己的槽位提问,否则会掉回自由对话。
      const slotQuestions = Object.values(PROGRAM_SLOT_QUESTIONS);
      const inProgramFlow = history.some(x => x.role === "assistant" && slotQuestions.some(q => x.content.includes(q)));
      if (!session && (wantsProgramPlan(input.message) || inProgramFlow)) {
        const said = [...history.filter(x => x.role === "user").map(x => x.content), input.message].join("，");
        const { slots, missing } = collectProgramSlots(said);
        const programProposal = missing.length ? null : {
          weeks: slots.weeks ?? 4, sessionsPerWeek: slots.sessionsPerWeek!, targetMinutes: slots.targetMinutes ?? 30,
          equipment: slots.equipment!, goal: slots.goal, environment: slots.environment,
        };
        const reply = programProposal
          ? `${programProposal.weeks} 周 · 每周 ${programProposal.sessionsPerWeek} 次 · 每次 ${programProposal.targetMinutes} 分钟左右，目标是${programProposal.goal}。前两周建立动作模式，第三周加深，最后一周巩固；每一场的剂量仍然按你当天的状态算。要开始就说一声，我把它放进你的课程。`
          : PROGRAM_SLOT_QUESTIONS[missing[0]!]!;
        return json(res, 200, { reply, mode: "program_proposal", programProposal, programSlotsMissing: missing, status: null });
      }
      // 心理安抚(2026-11-09):谈情绪时先接住。只在模型已配置时接管，
      // 未配置时仍走原报错路径（否则会吞掉"请先配置模型"）。
      if (!session && chatStatus().configured) {
        const mood = classifyMood(input.message);
        // Nit-1:如果同时问了"练什么/怎么练/几组"，不能只回安慰把问题吞掉。
        const actionable = /练什么|怎么练|几组|几次|多少|计划|排一|怎么安排|多重|多久/.test(input.message);
        if (mood !== "neutral" && !actionable) {
          const comfort = buildCheckIn({ daysSinceLast: null, streakWeeks: 0, totalSessions: 0, lastMessage: input.message });
          return json(res, 200, { reply: comfort.text, mode: "comfort", mood, status: null });
        }
      }
      const result = await replyToCoach(session, input.message.trim(), history);
      return json(res, 200, { ...result, status: session?.status ?? null });
    }
    // ── 组内听觉感知 v1(《组内听觉感知设计》§3):前端时机引擎裁决"值得说"后来此取话 ──
    // 铁律:本端点只叙事+遥测;永不改会话状态/剂量/教练状态机(感知层永不可触,见设计 §6.4)。
    const perceptionMatch = url.pathname.match(/^\/api\/workouts\/([^/]+)\/perception$/);
    if (req.method === "POST" && perceptionMatch) {
      const input = await body(req);
      const trigger = typeof input.trigger === "string" ? input.trigger : "";
      if (!(trigger in CUE_TEMPLATES)) return json(res, 400, { error: "未知感知触发。" });
      const evidence = typeof input.evidence === "string" && input.evidence.trim() ? input.evidence.trim().slice(0, 120) : null;
      const session = loadSession(perceptionMatch[1]);
      // 只有真实组内(报数进行中)的感知才有资格说话;其余一律静默丢弃
      if (!session.runtime.coach || session.status !== "exercise_active" || session.runtime.coach.phase !== "REP_GUIDANCE") return json(res, 200, { ok: false, text: null });
      let text = CUE_TEMPLATES[trigger as keyof typeof CUE_TEMPLATES];
      if (process.env.TRAINMIND_NARRATION === "1" && chatConfig.baseUrl && chatConfig.model) {
        try {
          const result = await narrate({ directive: { action: "speak", text }, session, slot: "effort_cue", templateText: text, userText: null, memoryFacts: "(组内感知,无对话)", evidence, styleStats: null, llm: narrationLlm });
          // 感知话术禁数字:数字属于计数链路,LLM 违规则整句回退模板
          text = /\d/.test(result.text) ? CUE_TEMPLATES[trigger as keyof typeof CUE_TEMPLATES] : result.text;
          if (result.fallback) { try { runtimeTelemetry.recordNarration(session.userId, { kind: "fallback", code: result.fallback }); } catch { /* 遥测失败不影响链路 */ } }
        } catch { /* narrate 内部已兜底为模板 */ }
      }
      // 静默观测(默认):感知照常分析并写遥测,但先不开口——先用真实场次量误报率,达标再开
      const speak = process.env.TRAINMIND_PERCEPTION_SPEAK === "1";
      try { runtimeTelemetry.recordPerception(session.userId, { trigger, delivered: speak }); } catch { /* 遥测失败不影响链路 */ }
      return json(res, 200, { ok: true, text, trigger, speak });
    }
    if (req.method === "GET" && /^\/api\/exercises\/[^/]+$/.test(url.pathname)) { const exercise = exercises.find(x => x.id === url.pathname.split("/")[3] && !x.attributionRequired); return exercise ? json(res, 200, { exercise }) : json(res, 404, { error: "动作不存在。" }); }
    // ── D27(2026-11-09, owner 要求):把别人的计划（链接/文字）拆成我们的结构 ──
    // 只做"读懂 + 判断适不适合"，不直接落库；落库要用户确认（见 docs 里 D27 说明）。
    if (req.method === "POST" && url.pathname === "/api/import/analyze") {
      const input = await body(req);
      const raw = typeof input.input === "string" ? input.input.trim() : "";
      if (!raw) return json(res, 400, { error: "把链接或计划文字粘进来。" });
      if (raw.length > 8000) return json(res, 400, { error: "太长了，先截到 8000 字以内。" });
      const userId = typeof input.userId === "string" && input.userId ? input.userId : "demo-user";
      requestUserId = userId;
      const source = detectSource(raw);
      let text = raw, title = "", viaLink = false, transcripted = false, note: string | undefined;
      if (source?.autoFetch) {
        try {
          const meta = source.platform === "bilibili" ? await fetchBilibiliMeta(source.id!) : await fetchYoutubeMeta(source.id!);
          title = meta.title;
          text = [meta.title, meta.desc].filter(Boolean).join("\n");
          viaLink = true;
          if (!meta.hasText && input.transcribe !== false) {
            const tr = await transcribeMedia(source.url);
            if (tr) { text = `${text}\n${tr}`; transcripted = true; }
            else note = "这个视频没有可读的文字说明，也没能转写出口播内容。把教练发的计划文字粘进来一样能分析。";
          }
        } catch (error) {
          note = `没能读取这个链接（${error instanceof Error ? error.message : "未知错误"}）。把计划文字粘进来一样能分析。`;
        }
      }
      if (!text.trim()) return json(res, 422, { error: note ?? "没有可用文字。" });
      // LLM 只做"抽结构"，判断与剂量一律走下面的规则层
      let extracted: { title?: string; items?: Array<{ name?: string; dose?: string; note?: string }> } | null = null;
      try {
        const out = await modelReply([
          { role: "system", content: "你只做信息抽取。从给定文本里找出训练计划，输出严格 JSON，不要解释、不要 markdown 代码块。格式：{\"title\":\"计划名\",\"items\":[{\"name\":\"动作中文名\",\"dose\":\"3组×12次 或 2组×30秒\",\"note\":\"原文里的关键提示，没有就省略\"}]}。只抽原文明确写到的动作；没有计划信息就输出 {\"items\":[]}。" },
          { role: "user", content: text.slice(0, 4000) },
        ], 900);
        const start = out.indexOf("{"), end = out.lastIndexOf("}");
        extracted = start >= 0 && end > start ? JSON.parse(out.slice(start, end + 1)) : null;
      } catch { extracted = null; }
      if (!extracted) return json(res, 502, { error: "模型没能从这段内容里读出训练计划。可以只粘「动作 + 组数 + 次数」那几行再试。", note });
      const rawItems = (extracted.items ?? []).filter(x => x && typeof x.name === "string" && x.name.trim()).slice(0, 20);
      if (!rawItems.length) return json(res, 422, { error: note ?? "这段内容里没找到明确的训练动作。", source, title });
      // 用户上下文：只读"最近一次会话上下文"（限制/器械/环境），没有就用缺省
      const ctxRow = db.prepare("SELECT data_json FROM session_contexts WHERE user_id = ? ORDER BY created_at DESC LIMIT 1").get(userId) as { data_json: string } | undefined;
      const lastCtx = ctxRow ? JSON.parse(ctxRow.data_json) as any : null;
      const userModel = buildUserTrainingModel(userId, {
        sessions: userSessions(userId),
        sets: (db.prepare("SELECT data_json FROM set_records").all() as any[]).map(r => JSON.parse(r.data_json)),
        trainingRecords: (db.prepare("SELECT session_id, data_json FROM training_records WHERE user_id = ?").all(userId) as any[]).map(r => JSON.parse(r.data_json)),
      });
      const assessCtx = {
        restrictions: (lastCtx?.restrictions ?? []) as string[],
        availableEquipment: (typeof input.equipment === "object" && Array.isArray(input.equipment) ? input.equipment : lastCtx?.availableEquipmentIds) as string[] | undefined,
        environment: String(input.environment ?? lastCtx?.environment ?? "home"),
      };
      const items = rawItems.map(x => {
        const name = x.name!.trim();
        const dose = parseDoseText(x.dose);
        const matched = matchExercise(name, exercises);
        const cap = matched ? userModel.exerciseCapabilities[matched.id] : undefined;
        const repRange = cap?.estimatedWorkingReps ? { min: Math.max(1, cap.estimatedWorkingReps - 2), max: cap.estimatedWorkingReps + 2 } : undefined;
        const assessment = assessItem({ name, dose }, matched, { ...assessCtx, repRange });
        return { name, dose, doseText: x.dose ?? null, note: x.note ?? null, matchedName: matched?.name ?? null, ...assessment };
      });
      return json(res, 200, {
        source: source ?? null, title: extracted.title ?? title ?? null, viaLink, transcripted, note: note ?? null,
        excerpt: text.slice(0, 400),
        items, summary: summarizePlan(items.map(i => ({ verdict: i.verdict } as any))),
      });
    }
    if (req.method === "POST" && url.pathname === "/api/workouts/preview") {
      // A10/D24(2026-11-09):真实用户练出来的场次必须记 human —— 缺省值以前是 demo,
      // 导致首页"生成计划"的每一场真练都被打上演示数据,实验看板里一条 human 都没有。
      // demo / automated_test 只在调用方显式指定时使用(演示包与自动化测试)。
      // 注意:这里的 input 是用户那句话(字符串)。加练标记是另一个字段 kind,必须单独解构。
      const { input, userId = "demo-user", knownEnvironment, experienceMode = "minimal", topic = "history", talkativeness = "medium", randomAssignment = false, dataOrigin = "human", kind } = await body(req);
      requestUserId = userId;
      if (typeof input !== "string" || !input.trim()) return json(res, 400, { error: "请输入本次训练需求。" });
      if (!["human", "automated_test", "demo"].includes(dataOrigin)) return json(res, 400, { error: "无效的 dataOrigin。" });
      const sessions = db.prepare("SELECT data_json FROM workout_sessions WHERE user_id = ? ORDER BY created_at DESC").all(userId).map((x: any) => JSON.parse(x.data_json) as WorkoutSession);
      const sessionIds = new Set(sessions.map(x => x.sessionId));
      const sets = db.prepare("SELECT data_json FROM set_records").all().map((x: any) => JSON.parse(x.data_json) as SetRecord).filter(x => sessionIds.has(x.sessionId));
      const facts: TrainingFacts = { sessions, sets, trainingRecords: loadTrainingRecords(userId, sessionIds) }, result = await createWorkout(input, userId, provider, facts, { knownEnvironment });
      if (result.interpretation.status === "error") return json(res, 502, result);
      if (!result.safety.allowed) return json(res, 422, result);
      if (result.interpretation.status === "needs_clarification") return json(res, 409, result);
      db.prepare("INSERT INTO user_training_model_snapshots (user_id, generated_at, data_json) VALUES (?, ?, ?)").run(userId, result.trainingModel!.generatedAt, JSON.stringify(result.trainingModel));
      db.prepare("INSERT INTO session_contexts (user_id, data_json, created_at) VALUES (?, ?, ?)").run(userId, JSON.stringify(result.context), new Date().toISOString());
      // 加练(owner 2026-11-09):用户完成当日计划后自愿再练的一场。不拦、不降级,
      // 只是打上标记单独存档 —— 这样记录里能分清"计划内"和"自己加的",
      // 课程进度只认计划那场,不会被加练顶掉。
      // 注意:响应体返回的是 result(不是下面持久化的 workout),两处都要标。
      if (kind === "extra") { result.workout!.kind = "extra"; }
      const workout = prepareWorkout(result.workout!);
      if (kind === "extra") workout.kind = "extra";
      workout.suggestedExercises = workout.exercises.map(x => ({ ...x }));
      const assignedMode: ExperienceMode = randomAssignment ? (["minimal", "content", "companion"] as ExperienceMode[])[Math.floor(Math.random() * 3)] : experienceMode;
      configureExperience(workout, { mode: assignedMode, topic: topic as ExperienceTopic, talkativeness, experimentGroup: assignedMode, dataOrigin: dataOrigin as DataOrigin });
      db.prepare("INSERT INTO workout_sessions (id, user_id, status, data_json, created_at) VALUES (?, ?, ?, ?, ?)").run(workout.sessionId, userId, workout.status, JSON.stringify(workout), workout.createdAt);
      workout.exercises.forEach(x => db.prepare("INSERT INTO workout_exercises VALUES (?, ?, ?, ?)").run(x.id, workout.sessionId, x.exerciseId, JSON.stringify(x)));
      return json(res, 201, result);
    }
    const experienceMatch = url.pathname.match(/^\/api\/workouts\/([^/]+)\/experience$/);
    if (req.method === "POST" && experienceMatch) {
      const input = await body(req), session = loadSession(experienceMatch[1]);
      if (session.status === "completed" || session.status === "aborted") return json(res, 200, { workout: session, directive: { action: "stop" } });
      let directive;
      if (input.command) directive = controlExperience(session, input.command);
      else if (input.progressSeconds !== undefined) { advanceExperienceSegment(session, Number(input.progressSeconds)); directive = experienceDirective(session); }
      else directive = experienceDirective(session, { safetyEvent: input.safetyEvent, userInteraction: input.userInteraction });
      applyExperienceDirective(session, directive); saveSession(session); return json(res, 200, { workout: session, directive });
    }
    const actionMatch = url.pathname.match(/^\/api\/workouts\/([^/]+)\/actions$/);
    if (req.method === "POST" && actionMatch) {
      const input = await body(req); db.exec("BEGIN IMMEDIATE");
      try {
      const session = loadSession(actionMatch[1]); let setRecord: SetRecord | undefined; let alreadyPersisted = false; let directive;
      const context = input.context;
      if (!context || typeof context.sessionId !== "string" || !("exerciseId" in context) || !Number.isInteger(context.setNumber) || !("coachPhase" in context) || typeof context.status !== "string" || !Number.isInteger(context.eventCount)) throw new Error("训练事件缺少上下文，请刷新状态后重试。");
      if (context.sessionId !== session.sessionId || context.exerciseId !== (session.exercises[session.runtime.currentExerciseIndex]?.exerciseId ?? null) || context.setNumber !== session.runtime.currentSetNumber || context.coachPhase !== (session.runtime.coach?.phase ?? null) || context.status !== session.status || context.eventCount !== session.runtime.events.length ||
        (input.exerciseIndex !== undefined && input.exerciseIndex !== session.runtime.currentExerciseIndex) || (input.setNumber !== undefined && input.setNumber !== session.runtime.currentSetNumber) || (input.expectedPhase !== undefined && input.expectedPhase !== session.runtime.coach?.phase)) {
        db.exec("COMMIT"); return json(res, 200, { workout: session, directive: { action: "none" }, stale: true });
      }
      // 7B.2.1:interruption 检查点需要"动作前"的 deadline 状态(见 bridge.checkInterruption)
      const before = { status: session.status, restEndsAt: session.runtime.restEndsAt ?? null, phaseEndsAt: session.runtime.phaseEndsAt ?? null, coachPhase: session.runtime.coach?.phase ?? null, coachPhaseStartedAt: session.runtime.coach?.phaseStartedAt ?? null, eventCount: session.runtime.events.length };
      // H3(2026-11-06 全仓审查):动作输入统一校验。API 不只服务自家前端——枚举与数值范围
      // 在此收紧(对齐 core 的 0-500 次 / 0-1000kg);范围与 core.ts 保持同源,不要各写一套。
      if (input.type === "feedback") {
        if (typeof input.feedback !== "string" || !["too_light", "right", "hard", "failed", "pain"].includes(input.feedback)) throw new UserInputError("反馈类型无效。");
        // 时长型动作的"次数"槽其实是秒数(如原地快走 540),上限按 3600s;次数型对齐 core 的 0-500
        const feedbackExercise = session.exercises[session.runtime.currentExerciseIndex];
        const repsUpper = feedbackExercise?.repOrTimeBased === "time" ? 3600 : 500;
        if (input.actualReps !== undefined && (!Number.isInteger(input.actualReps) || input.actualReps < 0 || input.actualReps > repsUpper)) throw new UserInputError("请报告有效的实际次数。");
        if (input.actualWeight !== undefined && (!Number.isFinite(input.actualWeight) || input.actualWeight < 0 || input.actualWeight > 1000)) throw new UserInputError("请报告有效的实际重量。");
      }
      if (input.type === "extend_rest" && input.seconds !== undefined && (!Number.isInteger(input.seconds) || input.seconds < 1 || input.seconds > 600)) throw new UserInputError("延长秒数须在 1-600 之间。");
      switch (input.type) {
        case "plan_move": case "plan_remove": case "plan_restore": case "plan_replace": {
          if (session.status !== "preview") throw new Error("只能编辑尚未开始的计划。");
          const index = Number(input.index), suggested = session.suggestedExercises ?? session.exercises;
          if (input.type === "plan_restore") session.exercises = suggested.map(x => ({ ...x }));
          else {
            if (!Number.isInteger(index) || index < 0 || index >= session.exercises.length) throw new Error("动作位置无效。");
            if (input.type === "plan_move") { const next = index + Number(input.direction); if (next < 0 || next >= session.exercises.length) throw new Error("动作位置无效。"); [session.exercises[index], session.exercises[next]] = [session.exercises[next], session.exercises[index]]; }
            if (input.type === "plan_remove") { if (session.exercises.length <= 1) throw new Error("至少保留一个动作。"); session.exercises.splice(index, 1); }
            if (input.type === "plan_replace") { const current = session.exercises[index], source = exercises.find(x => x.id === current.exerciseId), replacement = exercises.find(x => x.id === input.exerciseId); if (!source || !replacement || source.movementPattern !== replacement.movementPattern || !replacement.environments.includes(session.environment) || session.exercises.some((x, i) => i !== index && x.exerciseId === replacement.id)) throw new Error("替代动作不符合当前计划。"); Object.assign(current, { exerciseId: replacement.id, name: replacement.name, targetReps: replacement.defaultReps, instructions: replacement.instructions, attentionLevel: replacement.attentionLevel, currentWeight: replacement.defaultWeightKg, equipmentId: replacement.equipmentIds[0], originalExerciseId: source.id }); }
          }
          session.durationBreakdown = durationBreakdown(session.exercises, session.warmupMinutes, session.cooldownMinutes); session.plannedDurationMinutes = Math.ceil(session.durationBreakdown.totalSeconds / 60); session.optionalDurationMinutes = Math.max(0, session.availableDurationMinutes - session.plannedDurationMinutes); break;
        }
        case "start": startWorkout(session); skipUnstructuredWarmup(session); if (input.coach === true) enableCoach(session); break;
        case "warmup_complete": completeWarmup(session); break;
        case "cooldown_complete": completeCooldown(session); break;
        case "complete_set": {
          markSetComplete(session);
          if (session.runtime.coach) {
            // D1(2026-11-09, owner 裁决):报数是**可选功能** —— 用户报了数就把实测次数真正算进去
            // (counted/reported),没报就仍按目标推定(assumed)。我们不主动问、也不追问,与 D17 不冲突。
            const repsSource = ["counted", "reported"].includes(String(input.actualRepsSource)) ? input.actualRepsSource as "counted" | "reported" : undefined;
            const reportedReps = typeof input.actualReps === "number" && Number.isFinite(input.actualReps) && input.actualReps >= 0 ? input.actualReps : undefined;
            const saved = submitSetFeedback(session, { feedback: "right", coachConfirmed: true, ...(reportedReps !== undefined ? { actualReps: reportedReps, ...(repsSource ? { actualRepsSource: repsSource } : {}) } : {}) });
            setRecord = saved.record;
            session.runtime.coach = { ...session.runtime.coach, phase: "REST", awaitingCompletion: false };
            delete session.runtime.coach.pendingFeedback;
          }
          break;
        }
        case "feedback": {
          // D17:complete_set 已自动结组并进入休息。用户此时补一句"太重了"属于"事后补充",
          // 不该报错打断——更正刚那一组并据此调下一组剂量(见 applyLateFeedback)。
          if (input.feedback !== "pain" && session.status !== "set_feedback") {
            if (session.status !== "resting") throw new Error("请先确认本组完成，再提交实际反馈。");
            const late = applyLateSetFeedback(session, { feedback: input.feedback as SetFeedback, actualReps: input.actualReps, actualWeight: input.actualWeight });
            if (!late) throw new Error("请先确认本组完成，再提交实际反馈。");
            setRecord = late.record; alreadyPersisted = true;
            if (late.agency) directive = { action: "agency_offer", text: `这组有点吃力。${late.agency === "exercise" ? "下一个动作怎么走？" : "下一组怎么走？"}` };
            break;
          }
          // 次数来源三态校验:counted(报数累计)/reported(口报)/assumed(系统推定),其余一律丢弃
          const repsSource = ["counted", "reported", "assumed"].includes(input.actualRepsSource) ? input.actualRepsSource as "counted" | "reported" | "assumed" : undefined;
          // B6(2026-11-09):"做完一组才觉得疼"是最常见的时机。此前 pain 在这条路径只暂停会话,
          // 刚那组的 feedback 仍是 right、pain=false → 能力模型 recentPainEvent 恒 false,
          // 下次照样排同一个动作(安全证据断链)。先把疼痛记在那一组上,再走安全通道。
          // 剂量不动:applyLateFeedback 的 pain 分支显式跳过改重量/次数(见 core.ts:738)。
          if (input.feedback === "pain" && session.status === "resting") {
            const marked = applyLateSetFeedback(session, { feedback: "pain" });
            if (marked) { setRecord = marked.record; alreadyPersisted = true; }
            if (session.runtime.coach) ({ directive } = handleCoachEvent(session, { type: "pain" }));
            else { if (session.status !== "paused") pauseWorkout(session); directive = { action: "speak", text: "先停下，别硬撑。今天到这儿。" }; }
            break;
          }
          if (session.runtime.coach && input.feedback === "pain") ({ directive } = handleCoachEvent(session, { type: "pain" }));
          else if (session.runtime.coach) ({ record: setRecord, directive } = handleCoachEvent(session, { type: "user_report", completed: true, actualReps: input.actualReps, actualWeight: input.actualWeight, ...(repsSource ? { actualRepsSource: repsSource } : {}), ...(input.feedback === "hard" || input.feedback === "failed" ? { feedback: "too_heavy" as const } : input.feedback === "too_light" ? { feedback: "too_light" as const } : { right: true }) }));
          else {
            // 无教练时上报疼痛:可能还停在 exercise_active(疼痛是随时说的),先结案这一组再记录
            if (input.feedback === "pain" && session.status === "exercise_active") markSetComplete(session);
            ({ record: setRecord } = submitSetFeedback(session, { ...input, ...(repsSource ? { actualRepsSource: repsSource } : {}) }));
          }
          break;
        }
        case "coach_enable": enableCoach(session); break;
        case "coach_message": {
          if (typeof input.message !== "string" || input.message.length > 200) throw new Error("反馈不能超过200字。");
          // 喊停三段式(2026-11-05):疲惫先问原因并推一把,第二次喊才收工;疼痛直接走安全通道
          const stopIntent = session.runtime.coach ? classifyStopIntent(input.message) : null;
          // A2(2026-11-09):喊停的另外两个分支此前根本没人消费 —— 说"头晕/胸闷"只换了话术
          // (叙事开启时甚至会说"今天就到此为止"),说"不练了/结束这场"则什么都没发生,
          // 而训练状态机照跑。安全优先:先把状态落下来,再给话术。
          // 注意排除"换动作/器械被占"这类 substitute 意图(它由后面的 parseCoachReport 处理),
          // classifyStopIntent 的 hard_stop 词表里含"换动作",不能一刀切。
          if (stopIntent === "pain" && session.runtime.coach) {
            // B6 补齐(2026-11-09 复核 High-1):语音/旗标语路径此前**只停机器不记组** ——
            // 「头晕/恶心/胸闷/心慌/发麻」这些 classifyStopIntent 红旗词不在前端 pain 正则里,
            // 会走到这里;若不标组,能力模型 recentPainEvent 恒 false,下次照样排同一个动作。
            // 与按钮路径完全镜像:先记在刚完成的那一组上,再走安全通道;剂量不动。
            if (session.status === "resting") {
              const marked = applyLateSetFeedback(session, { feedback: "pain" });
              if (marked) { setRecord = marked.record; alreadyPersisted = true; }
            }
            ({ directive } = handleCoachEvent(session, { type: "pain" }, undefined, input.message));
            break;
          }
          if (stopIntent === "hard_stop" && session.runtime.coach && parseCoachReport(input.message)?.type !== "substitute") {
            if (session.status !== "paused" && !["completed", "aborted", "preview"].includes(session.status)) pauseWorkout(session);
            directive = { action: "speak", text: "行，先停在这，想收工就点结束。" };
            break;
          }
          if (stopIntent === "exhaustion" && session.runtime.coach && ["START_SET", "REP_GUIDANCE"].includes(session.runtime.coach.phase)) {
            if ((session.runtime.coach.stopProbes ?? 0) === 0) {
              session.runtime.coach = { ...session.runtime.coach, stopProbes: 1 };
              directive = { action: "speak", text: probeStopPrompt() };
            } else {
              pauseWorkout(session);
              directive = { action: "speak", text: "行，放下，歇一会儿。" };
            }
            break;
          }
          // D17:休息中主动补一句"太重了/有点轻" → 更正刚那一组并调下一组剂量(不追问、不忽略)
          if (session.runtime.coach && session.status === "resting") {
            const report = parseCoachReport(input.message);
            if (report?.type === "user_report" && report.feedback) {
              const late = applyLateSetFeedback(session, { feedback: report.feedback === "too_heavy" ? "hard" : "too_light", actualReps: report.actualReps, actualWeight: report.actualWeight });
              if (late) {
                setRecord = late.record; alreadyPersisted = true;
                directive = late.agency
                  ? { action: "agency_offer", text: `记下了。${late.agency === "exercise" ? "下一个动作怎么走？" : "下一组怎么走？"}` }
                  : { action: "speak", text: report.feedback === "too_heavy" ? "记下了，下一组轻一点。" : "记下了，下一组加一点。" };
                break;
              }
            }
          }
          // D14:教练正在等三选一时,口语直达("听你的/我能行/少做几次")
          if (session.runtime.coach?.pendingAgency) {
            const agencyChoice = agencyChoiceFromSpeech(input.message, session.runtime.coach.pendingAgency.scope ?? "set");
            if (agencyChoice) ({ directive } = handleCoachEvent(session, { type: "agency_choice", choice: agencyChoice }));
            else ({ record: setRecord, directive } = handleCoachMessage(session, input.message));
          } else ({ record: setRecord, directive } = handleCoachMessage(session, input.message));
          break;
        }
        case "coach_event":
          if (!["start_set", "guidance_started", "guidance_finished", "rest_finished", "next_set", "agency_choice"].includes(input.event?.type)) throw new Error("未知陪练事件。");
          ({ directive } = handleCoachEvent(session, input.event));
          // D11:start_set 此前无服务器指令(开场白是前端本地模板);统一由服务器产出,叙事层才有数字锚点
          if (input.event?.type === "start_set" && (!directive || directive.action === "none")) {
            const x = session.exercises[session.runtime.currentExerciseIndex];
            // A3(2026-11-09):组内话术 ≤30 字(铁律 3)。此前这里拼了 instructions[0],
            // 实测 102 个动作全部超 30 字(中位 95 字)。动作要领改由屏幕展示,不进语音。
            // 剂量直接用 targetReps 原文,避免把"300秒"念成"300 次"。
            if (x) directive = { action: "speak", text: `第 ${session.runtime.currentSetNumber} 组，${x.name}，${x.currentWeight ? `${x.currentWeight} 公斤` : "自重"}，建议 ${x.targetReps}。` };
          }
          break;
        case "rest_complete": completeRest(session); resetCoachForSet(session); break;
        case "extend_rest": extendRest(session, input.seconds ?? 30); break;
        case "pause": pauseWorkout(session); break;
        case "resume": resumeWorkout(session); skipUnstructuredWarmup(session); break;
        case "skip": if (session.runtime.coach?.safetyStopped) throw new Error("疼痛后请结束训练。"); skipExercise(session, input.reason); resetCoachForSet(session); break;
        case "replace": if (session.runtime.coach?.safetyStopped) throw new Error("疼痛后请结束训练。"); replaceExercise(session, input.reason); resetCoachForSet(session); break;
        case "abort": abortWorkout(session); controlExperience(session, "safety"); break;
        default: throw new Error("未知训练操作。");
      }
      // 组记录统一在此落库:任何产生 setRecord 的动作(组完成、反馈、口报)都只写一次
      if (setRecord && !alreadyPersisted) persistSet(setRecord);
      session.runtime.events.push({ id: crypto.randomUUID(), type: "client_action", at: new Date().toISOString(), exerciseId: context.exerciseId ?? undefined, details: { action: input.type, ...context } });
      try { runtimeTelemetry.onAction(session, input, { setRecord, before }); } catch (telemetryError) { console.error(JSON.stringify({ timestamp: new Date().toISOString(), requestId, telemetryError: telemetryError instanceof Error ? telemetryError.message : String(telemetryError) })); }
      saveSession(session); finalize(session); db.exec("COMMIT");
      // ── 教练人格层(D11):规则层已在事务内决定"做什么";事务外仅改写"怎么说" ──
      // 红旗 → 固定安全话术(跳过 LLM);LLM 失效 → 回退模板;两者都记遥测。
      if (process.env.TRAINMIND_NARRATION === "1" && chatConfig.baseUrl && chatConfig.model) {
        const userText = input.type === "coach_message" && typeof input.message === "string" ? input.message : null;
        if (userText && RED_FLAG.test(userText)) { // 红旗优先于一切:规则层解析不出指令也必须叫停
          directive = { action: "speak", text: RED_FLAG_TEXT } as typeof directive;
          try { runtimeTelemetry.recordNarration(session.userId, { kind: "redflag", transcript: userText }); } catch { /* 遥测失败不影响链路 */ }
        } else if (directive && typeof (directive as { text?: unknown }).text === "string" && (directive as { text: string }).text) {
          const slot = slotOf(directive as { action: string; text?: unknown }, session);
          if (slot) {
            let memoryFacts = "(无历史数据)";
            try {
              const rows = db.prepare("SELECT s.started_at AS startedAt, e.exercise_id AS exerciseId, f.difficulty AS difficulty, s.actual_reps AS actualReps, s.set_number AS setNumber FROM set_records s JOIN exercise_instances e ON e.id = s.exercise_instance_id JOIN workout_sessions w ON w.id = e.session_id LEFT JOIN set_feedbacks f ON f.set_record_id = s.id WHERE w.user_id = ? AND s.started_at >= ? ORDER BY s.started_at DESC LIMIT 60").all(session.userId, Date.now() - 7 * 24 * 3600 * 1000) as unknown as MemoryRow[];
              memoryFacts = buildMemoryFacts(rows, Date.now(), session.exercises[session.runtime.currentExerciseIndex]?.exerciseId);
              // ⑤ 跨月关系:叙事记忆不再只看近 7 天——一起练了几次、连续几周、多久没练,都进教练的判断
              try { const rel = userRelationship(session.userId); if (rel.totalSessions > 0) memoryFacts = `${memoryFacts};${rel.text}`; } catch { /* 关系进度失败不影响叙事 */ }
            } catch { /* 记忆失败不阻塞叙事 */ }
            try {
              const templateText = (directive as { text: string }).text;
              // D14 透明推理:把本组依据(实际次数/目标/重量/原话)注入叙事,人设负责织入语气(禁因果句式)
              const evidenceBits: string[] = [];
              const nx = session.exercises[session.runtime.currentExerciseIndex];
              if (nx) { evidenceBits.push(`目标 ${nx.targetReps}`, nx.currentWeight !== undefined && nx.currentWeight !== null ? `当前重量 ${nx.currentWeight} 公斤` : "自重"); }
              if (setRecord && setRecord.actualReps !== undefined && setRecord.actualReps !== null) evidenceBits.push(`本组实际 ${setRecord.actualReps} 次`);
              if (userText) evidenceBits.push(`学员原话「${userText.slice(0, 60)}」`);
              // D14 风格画像:近10次 agency 选择 + 近期完成率(全部来自既有数据,零新增采集)
              let styleStats: import("./narration.ts").StyleStats | null = null;
              try {
                const recentSessions = db.prepare("SELECT data_json FROM workout_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 10").all(session.userId) as { data_json: string }[];
                const counts = { acceptCut: 0, holdOn: 0, bargain: 0 };
                for (const row of recentSessions) { const parsed = JSON.parse(row.data_json) as WorkoutSession; for (const ev of parsed.runtime?.events ?? []) { const c = (ev as { type?: string; details?: { choice?: string } }).details?.choice; if ((ev as { type?: string }).type === "coach_agency_choice" && c) { if (c === "accept_cut" || c === "next_down" || c === "skip_next") counts.acceptCut++; else if (c === "hold_on" || c === "stay") counts.holdOn++; else if (c === "bargain") counts.bargain++; } } }
                const recentSets = db.prepare("SELECT s.actual_reps AS actual, s.target_reps_min AS targetMin FROM set_records s JOIN exercise_instances e ON e.id = s.exercise_instance_id JOIN workout_sessions w ON w.id = e.session_id WHERE w.user_id = ? ORDER BY s.started_at DESC LIMIT 10").all(session.userId) as { actual: number | null; targetMin: number | null }[];
                const rated = recentSets.filter(x => x.actual !== null && x.actual !== undefined && x.targetMin !== null && x.targetMin !== undefined);
                const completionRate = rated.length >= 3 ? rated.filter(x => (x.actual as number) >= (x.targetMin as number)).length / rated.length : null;
                styleStats = { ...counts, totalChoices: counts.acceptCut + counts.holdOn + counts.bargain, completionRate };
              } catch { /* 风格统计失败不阻塞叙事 */ }
              const result = await narrate({ directive: directive as { action: string; text: string }, session, slot, templateText, userText, memoryFacts, evidence: evidenceBits.join(";"), styleStats, llm: narrationLlm });
              directive = { ...directive, text: result.text } as typeof directive;
              if (result.fallback) { try { runtimeTelemetry.recordNarration(session.userId, { kind: "fallback", code: result.fallback }); } catch { /* 遥测失败不影响链路 */ } }
            } catch { /* narrate 内部已兜底为模板;此处理论不可达 */ }
          }
        }
      }
      return json(res, 200, { workout: session, setRecord, directive });
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    const surveyMatch = url.pathname.match(/^\/api\/workouts\/([^/]+)\/survey$/);
    if (req.method === "POST" && surveyMatch) { const session = loadSession(surveyMatch[1]), survey = sanitizeSurvey(await body(req)); finalize(session, survey); const preference = { preferredMode: session.experience?.initialMode ?? "minimal", topics: [session.experience?.topic ?? "history"], talkativeness: session.experience?.talkativeness ?? "medium", contentDisabledCount: session.experience?.contentDisabled ? 1 : 0, skippedTopics: session.experience?.contentSkipCount ? { [session.experience.topic]: session.experience.contentSkipCount } : {} }; db.prepare("INSERT OR REPLACE INTO experience_preferences VALUES (?, ?)").run(session.userId, JSON.stringify(preference)); return json(res, 200, { ok: true }); }
    json(res, 404, { error: "Not found" });
  } catch (error) { console.error(JSON.stringify({ timestamp: new Date().toISOString(), requestId, userId: requestUserId, sessionId: requestUrl.pathname.match(/\/workouts\/([^/]+)/)?.[1], request: `${req.method} ${requestUrl.pathname}`, error: error instanceof Error ? `${error.constructor.name}: ${error.message}` : "Unknown error" })); if (isInternalError(error)) json(res, 500, { error: "服务器开小差了，请稍后再试。" }); else json(res, 400, { error: error instanceof Error ? error.message : "Unknown error" }); }
});
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? (mobileMode ? "0.0.0.0" : "127.0.0.1");
// M10:端口被占(最常见:已有一个 TrainMind 实例在跑)时给出可行动的提示并以非零码退出,
// 而不是抛 EADDRINUSE 未处理堆栈;其余 listen 错误保持原样抛出。
server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") { console.error(`端口 ${port} 已被占用——大概率已有一个 TrainMind 实例在跑。先停掉旧实例,或换一个端口(如 PORT=3100)。`); process.exit(1); }
  throw error;
});
server.listen(port, host, () => console.log(`TrainMind running at http://localhost:${port} (bound to ${host}; SQLite: ${dbPath})`));
export { server };

// A4(2026-11-09):兜底 —— 任何漏网的 promise 拒绝只记日志,不许带走正在进行的训练。
// (此前全仓没有这个 handler,一行坏配置或一次未 await 的读取就足以让进程退出。)
process.on("unhandledRejection", (reason) => {
  console.error(JSON.stringify({ timestamp: new Date().toISOString(), warning: "unhandled_rejection", error: reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason) }));
});
