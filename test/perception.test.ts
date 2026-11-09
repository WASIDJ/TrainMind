// 组内听觉感知 v1 测试 —— 设计《trainmind-组内听觉感知设计.md》§6 验证纪律
// 1) 时机规则表全分支(纯函数)+ 频控 2) 服务器叙事接线 3) 反向验收:感知永不出现在剂量/安全/状态机
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createEffortAnalyzer, createTimingEngine, CUE_TEMPLATES } from "../src/perception.js";

// ── 努力度分析器(纯函数,合成 RMS 时间线驱动) ─────────────────────
const run = (analyzer, timeline) => {
  // timeline: [{from, to, rms}] 毫秒区段,每 100ms 采样一次
  const events = [];
  const end = Math.max(...timeline.map(x => x.to));
  for (let t = 0; t <= end; t += 100) {
    const seg = timeline.find(x => t >= x.from && t < x.to);
    if (seg) events.push(...analyzer.feed(seg.rms, t));
  }
  return events;
};

test("analyzer: sustained breathing rise fires effort_rise exactly once", () => {
  const a = createEffortAnalyzer();
  const events = run(a, [{ from: 0, to: 6500, rms: 0.01 }, { from: 6500, to: 30000, rms: 0.02 }]);
  assert.equal(events.filter(e => e.type === "effort_rise").length, 1);
  assert.ok(events.every(e => e.type === "effort_rise"), "不应有其他事件");
  assert.ok(Math.abs(a.baseline - 0.01) < 1e-9);
});

test("analyzer: transient rise (cough) does not fire effort_rise", () => {
  const a = createEffortAnalyzer();
  const events = run(a, [{ from: 0, to: 6500, rms: 0.01 }, { from: 6500, to: 8000, rms: 0.02 }, { from: 8000, to: 20000, rms: 0.01 }]);
  assert.equal(events.length, 0);
});

test("analyzer: strain spikes debounce at 2s and re-arm", () => {
  const a = createEffortAnalyzer();
  const events = [];
  for (let t = 0; t <= 9000; t += 100) events.push(...a.feed(t === 6500 || t === 6600 || t === 8600 ? 0.05 : 0.01, t));
  const spikes = events.filter(e => e.type === "strain_peak");
  assert.equal(spikes.length, 2); // 6500 触发;6600 被去抖;8600 (>2s) 再触发
});

test("analyzer: activity followed by 8s silence fires long_pause once", () => {
  const a = createEffortAnalyzer();
  const events = run(a, [{ from: 0, to: 6500, rms: 0.01 }, { from: 6500, to: 8000, rms: 0.02 }, { from: 8000, to: 21000, rms: 0.001 }]);
  const pauses = events.filter(e => e.type === "long_pause");
  assert.equal(pauses.length, 1);
  assert.ok(pauses[0].durationMs >= 8000);
});

test("analyzer: quiet set (no audible effort) produces zero events", () => {
  const a = createEffortAnalyzer();
  const events = run(a, [{ from: 0, to: 30000, rms: 0.002 }]);
  assert.equal(events.length, 0);
  assert.equal(a.baseline, 0.008); // 基线下限生效,阈值不被压成噪声
});

test("analyzer: reset clears calibration for the next set", () => {
  const a = createEffortAnalyzer();
  run(a, [{ from: 0, to: 6500, rms: 0.01 }, { from: 6500, to: 30000, rms: 0.02 }]);
  assert.ok(a.baseline !== null);
  a.reset();
  assert.equal(a.baseline, null);
});

// ── 时机引擎(规则表全分支 + 频控) ───────────────────────────────
const evt = (type, extra = {}) => ({ type, baseline: 0.01, ema: 0.02, rms: 0.04, ...extra });

test("timing: pace confirm only at reps 2-3, once per set", () => {
  const e = createTimingEngine();
  e.onSetStart("s1", { target: 8, now: 0 });
  assert.equal(e.onRep(1, 1000), null);
  assert.equal(e.onRep(2, 2000)?.trigger, "pace_confirm");
  assert.equal(e.onRep(3, 3000), null);
  const e2 = createTimingEngine();
  e2.onSetStart("s1", { target: 8, now: 0 });
  assert.equal(e2.onRep(4, 4000), null);
});

test("timing: effort confirm requires halfway (reps or 20s elapsed fallback)", () => {
  const e = createTimingEngine();
  e.onSetStart("s1", { target: 8, now: 0 });
  assert.equal(e.onPerceptionEvent(evt("effort_rise"), 15000), null, "未过半程不说话");
  assert.equal(e.onPerceptionEvent(evt("effort_rise"), 20000)?.trigger, "effort_rise", "报数缺失时用时间近似半程");
  const e2 = createTimingEngine();
  e2.onSetStart("s1", { target: 8, now: 0 });
  e2.onRep(3, 9000);
  assert.equal(e2.onPerceptionEvent(evt("effort_rise"), 11000), null, "第3次未过8次的一半");
  const e3 = createTimingEngine();
  e3.onSetStart("s1", { target: 8, now: 0 });
  e3.onRep(4, 10000);
  assert.equal(e3.onPerceptionEvent(evt("effort_rise"), 12000)?.trigger, "effort_rise");
});

test("timing: last sprint needs strain at final two reps, once per set", () => {
  const e = createTimingEngine();
  e.onSetStart("s1", { target: 8, now: 0 });
  e.onRep(7, 7000);
  assert.equal(e.onPerceptionEvent(evt("strain_peak"), 7200)?.trigger, "last_sprint");
  assert.equal(e.onPerceptionEvent(evt("strain_peak"), 9000), null, "每组只一次");
  const e2 = createTimingEngine();
  e2.onSetStart("s1", { target: 8, now: 0 });
  e2.onRep(5, 5000);
  assert.equal(e2.onPerceptionEvent(evt("strain_peak"), 5200), null, "不在最后两次");
  const e3 = createTimingEngine();
  e3.onSetStart("s1", { target: 8, now: 0 });
  assert.equal(e3.onPerceptionEvent(evt("strain_peak"), 20000), null, "报数未行进,不冒充进度");
});

test("timing: pause care fires once and respects cooldown", () => {
  const e = createTimingEngine();
  e.onSetStart("s1", { target: 8, now: 0 });
  e.onRep(2, 3000); // 节奏确认占用一次插话 + 冷却起点
  assert.equal(e.onPerceptionEvent(evt("long_pause", { durationMs: 9000 }), 5000), null, "冷却期内不打断轰炸");
  assert.equal(e.onPerceptionEvent(evt("long_pause", { durationMs: 9000 }), 14000)?.trigger, "long_pause");
  assert.equal(e.onPerceptionEvent(evt("long_pause", { durationMs: 9000 }), 30000), null, "每组只一次");
});

test("timing: hard cap of 2 interjections per set (excluding counting)", () => {
  const e = createTimingEngine();
  e.onSetStart("s1", { target: 8, now: 0 });
  assert.equal(e.onRep(2, 2000)?.trigger, "pace_confirm");
  e.onRep(4, 20000); // 报数行进到第4次:已过8次的一半(报数已知时不走时间回退)
  // B12(2026-11-09):节奏确认属于"计数",按契约不占那 2 次插话名额
  assert.equal(e.onPerceptionEvent(evt("effort_rise"), 21000)?.trigger, "effort_rise", "第 1 次真实插话");
  assert.equal(e.onPerceptionEvent(evt("long_pause", { durationMs: 9000 }), 40000)?.trigger, "long_pause", "第 2 次真实插话");
  assert.equal(e.onPerceptionEvent(evt("strain_peak"), 41000), null, "两次真实插话之后闭嘴");
});

test("timing: quiet set stays silent; new set resets all counters", () => {
  const e = createTimingEngine();
  e.onSetStart("s1", { target: 8, now: 0 });
  for (let t = 1000; t <= 40000; t += 1000) assert.equal(e.onPerceptionEvent(evt("none_of_above"), t), null);
  e.onSetStart("s2", { target: 8, now: 50000 });
  assert.equal(e.onRep(2, 51000)?.trigger, "pace_confirm", "换组后频控重置");
});

test("timing: templates match the server-side rule table", () => {
  assert.equal(CUE_TEMPLATES.effort_rise, "呼吸变重了，正常，顶住。");
  assert.equal(CUE_TEMPLATES.long_pause, "停一下没关系，喘匀了再继续，我等你。");
  assert.equal(CUE_TEMPLATES.last_sprint, "最后两个，顶住。");
  assert.ok(!/\d/.test(Object.values(CUE_TEMPLATES).join("")), "感知话术永不携带数字(数字属于计数链路)");
});

// ── D16-C 用户价值:次数由系统持有(不再盘问用户、落库不再是目标值) ──────
test("ux contract: the set-end cue never asks the trainee for reps", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.ok(!html.includes("做了几次"), "组内提示不许再问“做了几次”");
  assert.ok(!html.includes("完成了吗？做了几次"), "旧的三连问文案必须消失");
});

test("ux contract: counted reps is the single source of truth for actualReps", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const start = html.indexOf("function countedReps()");
  assert.ok(start > 0, "countedReps 必须存在");
  const source = html.slice(start, html.indexOf("\n", start));
  // 三态:口头更正 > 报数累计 > 未知(回落到输入框)
  const call = (actualRepsOverride: number | null, guideRepCount: number) =>
    new Function("actualRepsOverride", "guideRepCount", `${source}; return countedReps();`)(actualRepsOverride, guideRepCount);
  assert.equal(call(6, 8), 6, "用户口头更正优先");
  assert.equal(call(null, 8), 8, "系统报数累计是默认");
  assert.equal(call(null, 0), null, "没数到就如实返回未知,不编造目标值");
  // 提交路径必须用它,而不是无条件读输入框
  assert.ok(html.includes("systemReps=countedReps()"), "提交必须优先取系统计数");
  assert.ok(html.includes("countedReps()??x.targetReps.match"), "纠正面板默认值也必须是系统计数");
  assert.ok(html.includes("系统记录了 "), "反馈屏应告知“系统记录了 N 次”,而不是让用户填");
});

test("perception wiring exposes console diagnostics for device acceptance", async () => {
  const source = await readFile(new URL("../src/perception.js", import.meta.url), "utf8");
  assert.ok(source.includes("window.__tmPerception"), "真机验收需要可查的感知诊断");
  assert.ok(source.includes("diagnostics.events") && source.includes("diagnostics.cues"), "事件与话术都要可见");
});

// ── 服务器接线 + 反向验收(感知永不触碰状态机/剂量/安全) ──────────
let __portSeq = 0;

test("server: perception cue narrates template, records telemetry, never mutates session or dose", async () => {
  const dbPath = `${process.cwd()}${process.platform === "win32" ? "\\" : "/"}test${process.platform === "win32" ? "\\" : "/"}perception-${process.pid}.db`;
  const port = 34000 + (process.pid % 900) + (++__portSeq * 7);
  await rm(dbPath, { force: true });
  const child = spawn(process.execPath, ["src/server.ts"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), TRAINMIND_DB: dbPath }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(Error("server timeout")), 20000); child.stdout.on("data", b => { if (String(b).includes("TrainMind running")) { clearTimeout(timeout); resolve(); } }); child.once("exit", code => reject(Error(`server exited ${code}`))); });
    const origin = `http://localhost:${port}`;
    const get = async (path: string) => (await fetch(origin + path)).json() as Promise<any>;
    const post = async (path: string, payload: unknown) => { const r = await fetch(origin + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
    const bind = async (path: string, payload: any) => { if (!payload.context) { const { workout: w } = await get(`/api/workouts/${path.split("/")[3]}`); payload.context = { sessionId: w.sessionId, exerciseId: w.exercises[w.runtime.currentExerciseIndex]?.exerciseId ?? null, setNumber: w.runtime.currentSetNumber, coachPhase: w.runtime.coach?.phase ?? null, status: w.status, eventCount: w.runtime.events.length }; } return payload; };

    // 感知模块源码可被浏览器加载
    const module = await fetch(origin + "/perception.js");
    assert.equal(module.status, 200);
    assert.match(module.headers.get("content-type") ?? "", /text\/javascript/);
    assert.match(await module.text(), /createTimingEngine/);

    // 建训练并推到组内(教练报数进行中)
    let w = (await post("/api/workouts/preview", { input: "我在家，只有15分钟，今天精神不错，想练全身。", userId: "perception-e2e", dataOrigin: "automated_test" })).body.workout;
    const id = w.sessionId;
    w = (await post(`/api/workouts/${id}/actions`, await bind(`/api/workouts/${id}/actions`, { type: "start", coach: true }))).body.workout;
    assert.equal(w.status, "exercise_active");
    w = (await post(`/api/workouts/${id}/actions`, await bind(`/api/workouts/${id}/actions`, { type: "coach_event", event: { type: "start_set" } }))).body.workout;
    w = (await post(`/api/workouts/${id}/actions`, await bind(`/api/workouts/${id}/actions`, { type: "coach_event", event: { type: "guidance_started" } }))).body.workout;
    assert.equal(w.runtime.coach.phase, "REP_GUIDANCE");

    // 反向验收基线:感知前后会话必须逐字节等价(状态/剂量/事件流都不许动)
    const before = await get(`/api/workouts/${id}`);
    const cues = await post(`/api/workouts/${id}/perception`, { trigger: "effort_rise", evidence: "呼吸能量较开组基线升高约 60%，已过半程", reps: 5, target: 8 });
    assert.equal(cues.status, 200);
    assert.equal(cues.body.ok, true);
    assert.equal(cues.body.speak, false, "默认静默观测:先量误报率,不打扰用户");
    assert.equal(cues.body.text, CUE_TEMPLATES.effort_rise, "叙事未配置时回退规则模板");
    const after = await get(`/api/workouts/${id}`);
    assert.equal(after.workout.status, before.workout.status);
    assert.equal(after.workout.runtime.events.length, before.workout.runtime.events.length, "感知不许写事件流");
    assert.deepEqual(after.workout.exercises.map((x: any) => [x.currentWeight, x.targetReps, x.sets, x.completedSets]), before.workout.exercises.map((x: any) => [x.currentWeight, x.targetReps, x.sets, x.completedSets]), "感知不许碰剂量");

    // 遥测:coach.perception.trigger 落库;剂量遥测(adaptation)零新增
    const db = new DatabaseSync(dbPath);
    try {
      assert.ok((db.prepare("SELECT count(*) AS n FROM interaction_events WHERE action = 'coach.perception' AND intent = 'coach.perception.trigger.effort_rise'").get() as any).n >= 1);
      assert.equal((db.prepare("SELECT count(*) AS n FROM adaptation_events").get() as any).n, 0, "感知永不产生剂量调整事件");
    } finally { db.close(); }

    // 未知触发拒绝;非组内时刻静默丢弃(教练尚未开始报数)
    assert.equal((await post(`/api/workouts/${id}/perception`, { trigger: "magic" })).status, 400);
    let w2 = (await post("/api/workouts/preview", { input: "我在家，有20分钟，想练全身。", userId: "perception-e2e-2", dataOrigin: "automated_test" })).body.workout;
    w2 = (await post(`/api/workouts/${w2.sessionId}/actions`, await bind(`/api/workouts/${w2.sessionId}/actions`, { type: "start", coach: true }))).body.workout;
    const idle = await post(`/api/workouts/${w2.sessionId}/perception`, { trigger: "long_pause" });
    assert.equal(idle.body.ok, false);
    assert.equal(idle.body.text, null);
  } finally { child.kill(); await new Promise(resolve => child.once("exit", resolve)); await rm(dbPath, { force: true }); }
});

// 嘈杂环境:中位数基线抗突发 + 明确标记"这里音频不可靠"
test("analyzer: median baseline resists a burst and flags a noisy room", () => {
  const a = createEffortAnalyzer();
  for (let t = 0; t <= 6000; t += 100) a.feed(t >= 2000 && t < 2200 ? 0.4 : 0.05, t); // 底噪 0.05 + 一次咳嗽
  assert.ok(a.baseline !== null && a.baseline < 0.1, "中位数不会被一次突发拉高");
  assert.equal(a.noisy, true, "底噪偏高 → 判为嘈杂环境(健身房场景)");

  const quiet = createEffortAnalyzer();
  for (let t = 0; t <= 6000; t += 100) quiet.feed(0.01, t);
  assert.equal(quiet.noisy, false, "安静房间不误判为嘈杂");
});
