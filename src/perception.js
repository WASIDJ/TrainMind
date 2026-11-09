// 组内听觉感知 v1 —— 设计《trainmind-组内听觉感知设计.md》§3–§5
// 铁律:本模块只决定"什么时候值得说、说什么话";数字/剂量/安全永不触碰。
// 感知分析只在内存(浏览器 AudioContext),不落盘不上传;上传的仍只有命令识别的短音频(现状)。
// 本文件为纯 JS:Node 测试直接 import 纯核心;浏览器以 <script type="module"> 加载,末尾接线自启。
//
// ── 纯核心(无 DOM) ──────────────────────────────────────────────

export const PERCEPTION_CONFIG = {
  calibrationMs: 6000,        // 开组校准窗:建立呼吸/环境能量基线
  minCalibrationSamples: 10,  // 校准最少样本数(稀疏喂入时窗口顺延)
  baselineFloor: 0.008,       // 基线下限(极安静房间不许把阈值压成噪声)
  emaTauMs: 1500,             // 平滑时间常数:呼吸包络级别,滤掉单次撞击
  riseFactor: 1.6,            // 平滑能量 > 基线×1.6 → 呼吸变重
  riseHoldMs: 3000,           // 持续 3 秒才算变重(一声咳嗽不算)
  strainFactor: 3.0,          // 单窗能量 > 基线×3 → 发力峰值
  strainDebounceMs: 2000,
  activityFactor: 1.25,       // 出现过基线×1.25 的活动,停顿判定才武装
  pauseFloorRatio: 0.45,      // 平滑能量 < 基线×0.45 → 静默
  pauseMs: 8000,              // 静默持续 8 秒 → 组内停顿(设计 §2:>8 秒)
  noisyBaseline: 0.03,        // 基线高于此值判定为嘈杂环境(健身房/音乐),音频判定不可靠 → 只做辅助
};

/** 努力度分析器:喂 RMS 能量样本,产出组内感知事件。纯内存、无副作用、时间由调用方驱动(可测)。 */
export function createEffortAnalyzer(overrides = {}) {
  const cfg = { ...PERCEPTION_CONFIG, ...overrides };
  let t0 = null, ema = 0, emaAt = null;
  let calib = [], baseline = null;
  let riseArmed = true, riseSince = null, strainAt = -Infinity, pauseSince = null, sawActivity = false;
  const reset = () => { t0 = null; ema = 0; emaAt = null; calib = []; baseline = null; riseArmed = true; riseSince = null; strainAt = -Infinity; pauseSince = null; sawActivity = false; };
  return {
    reset,
    get baseline() { return baseline; },
    /** 环境是否嘈杂:基线过高说明底噪(音乐/他人)盖过了呼吸声,音频判定降级为参考 */
    get noisy() { return baseline !== null && baseline > cfg.noisyBaseline; },
    get ema() { return ema; },
    /** @param {number} rms 本窗 RMS 能量 @param {number} t 毫秒时间戳 @returns {Array<{type:string,t:number,baseline:number,durationMs?:number}>} */
    feed(rms, t) {
      const events = [];
      if (t0 === null) { t0 = t; ema = rms; emaAt = t; }
      else if (t > emaAt) { const a = Math.exp(-(t - emaAt) / cfg.emaTauMs); ema = ema * a + rms * (1 - a); emaAt = t; }
      if (baseline === null) { // 校准期:攒样本求中位数(抗突发噪声:咳嗽/放杠铃不会把基线抬高)
        calib.push(rms);
        if (t - t0 >= cfg.calibrationMs && calib.length >= cfg.minCalibrationSamples) {
          const sorted = [...calib].sort((a, b) => a - b);
          baseline = Math.max(cfg.baselineFloor, sorted[Math.floor(sorted.length / 2)]);
        }
        return events;
      }
      // 呼吸变重:平滑能量持续超过基线×riseFactor(需先回落再武装,防连发)
      const riseLevel = baseline * cfg.riseFactor;
      if (ema > riseLevel) {
        if (riseArmed) {
          if (riseSince === null) riseSince = t;
          else if (t - riseSince >= cfg.riseHoldMs) { events.push({ type: "effort_rise", t, baseline, ema }); riseArmed = false; riseSince = null; }
        }
      } else if (ema < riseLevel * 0.85) { riseArmed = true; riseSince = null; }
      // 发力峰值:单窗尖峰(高于基线×strainFactor),去抖
      if (rms > baseline * cfg.strainFactor && t - strainAt >= cfg.strainDebounceMs) { strainAt = t; events.push({ type: "strain_peak", t, baseline, rms }); }
      // 组内停顿:先见过活动,后静默超过 pauseMs
      if (ema > baseline * cfg.activityFactor) sawActivity = true;
      const silenceLevel = baseline * cfg.pauseFloorRatio;
      if (sawActivity && ema < silenceLevel) {
        if (pauseSince === null) pauseSince = t;
        else if (t - pauseSince >= cfg.pauseMs) { events.push({ type: "long_pause", t, baseline, durationMs: t - pauseSince }); pauseSince = null; sawActivity = false; }
      } else if (ema >= silenceLevel) pauseSince = null;
      return events;
    },
  };
}

/** 规则表 v1 话术(设计 §4):服务器叙事层的锚点模板,与 src/server.ts 共用本常量。 */
export const CUE_TEMPLATES = {
  pace_confirm: "节奏对了，保持。",
  effort_rise: "呼吸变重了，正常，顶住。",
  last_sprint: "最后两个，顶住。",
  long_pause: "停一下没关系，喘匀了再继续，我等你。",
};

/**
 * 时机引擎(规则表 v1,设计 §4):决定"什么时候值得说"。
 * 频控硬约束:组内插话 ≤2 次(除计数);每规则每组 1 次;两次插话间隔 ≥10 秒。
 * 平稳组(无触发)永不说话——感知智能的一半是知道什么时候不说。
 */
export function createTimingEngine(overrides = {}) {
  const cfg = { maxInterjections: 2, cooldownMs: 10000, elapsedHalfwayFallbackMs: 20000, ...overrides };
  let startedAt = 0, target = 0, lastRep = 0;
  let interjections = 0, lastCueAt = -Infinity;
  const fired = { pace_confirm: 0, effort_rise: 0, last_sprint: 0, long_pause: 0 };
  const halfway = (now) => (lastRep > 0 && target > 0 ? lastRep >= Math.ceil(target / 2) : now - startedAt >= cfg.elapsedHalfwayFallbackMs);
  const canSpeak = (rule, now) => interjections < cfg.maxInterjections && fired[rule] < 1 && now - lastCueAt >= cfg.cooldownMs;
  // B12(2026-11-09):契约写的是"组内插话 ≤2 次(除计数)"。节奏确认属于计数类,
  // 此前也占用名额 → 一次 pace_confirm 就把最有价值的 last_sprint 挤掉。
  const emit = (rule, evidence, now) => { fired[rule]++; if (rule !== "pace_confirm") interjections++; lastCueAt = now; return { trigger: rule, template: CUE_TEMPLATES[rule], evidence }; };
  return {
    /** @param {string} key 组标识(sessionId:exerciseIndex:setNumber),换组重置全部频控 */
    onSetStart(key, { target: t = 0, now = Date.now() } = {}) {
      void key; startedAt = now; target = t; lastRep = 0; interjections = 0; lastCueAt = -Infinity;
      for (const k of Object.keys(fired)) fired[k] = 0;
    },
    /** 报数进度(cadence 开启时由控制器喂)。第 2–3 次节奏确认,每组 ≤1 次。 */
    onRep(rep, now = Date.now()) {
      lastRep = rep;
      if ((rep === 2 || rep === 3) && canSpeak("pace_confirm", now)) return emit("pace_confirm", `第 ${rep} 次节拍稳定`, now);
      return null;
    },
    /** 感知事件 → 时机裁决;返回 {trigger,template,evidence} 或 null(闭嘴)。 */
    onPerceptionEvent(evt, now = Date.now()) {
      if (evt.type === "long_pause") {
        if (canSpeak("long_pause", now)) return emit("long_pause", `组内停顿约 ${Math.max(1, Math.round((evt.durationMs ?? 8000) / 1000))} 秒后仍在组内`, now);
        return null;
      }
      if (evt.type === "effort_rise") {
        if (halfway(now) && canSpeak("effort_rise", now)) {
          const rise = Math.max(1, Math.round((evt.ema / evt.baseline - 1) * 100));
          return emit("effort_rise", `呼吸能量较开组基线升高约 ${rise}%，已过半程`, now);
        }
        return null;
      }
      if (evt.type === "strain_peak") {
        if (lastRep > 0 && target > 0 && lastRep >= target - 2 && canSpeak("last_sprint", now)) return emit("last_sprint", `第 ${lastRep} 次发力声明显增强，只剩最后两次`, now);
        return null;
      }
      return null;
    },
  };
}

// ── 浏览器接线(仅浏览器执行;Node 测试跳过) ─────────────────────
// 麦克风在训练中本就常开(auto-listen):本层只并行"听训练者",不改命令检测链路。
// 只在 voicePermissionReady(用户已授权过语音)后启动——零新增权限弹窗。
if (typeof window !== "undefined" && typeof document !== "undefined" && window.isSecureContext) {
  (() => {
    let active = null;
    // 真机验收诊断:控制台可查 __tmPerception —— 让"它在听吗"从玄学变成可验证
    const diagnostics = { inSet: false, setKey: null, baseline: null, ema: null, events: [], cues: [] };
    if (typeof window !== "undefined") window.__tmPerception = diagnostics;
    const note = (bucket, item, cap) => { bucket.push(item); if (bucket.length > cap) bucket.shift(); };
    const speaking = () => Boolean(window.speechSynthesis?.speaking || window.speechSynthesis?.pending) || voiceState === "speaking";
    const stop = () => {
      diagnostics.inSet = false; diagnostics.setKey = null; diagnostics.baseline = null; diagnostics.ema = null;
      if (!active) return;
      const a = active; active = null;
      clearInterval(a.sampleTimer);
      try { a.stream?.getTracks().forEach(t => t.stop()); } catch { /* 已释放 */ }
      try { a.ctx?.close(); } catch { /* 已关闭 */ }
    };
    const deliver = async (cue, w, key) => {
      try {
        const x = w.exercises[w.runtime.currentExerciseIndex];
        const r = await api(`/api/workouts/${w.sessionId}/perception`, { trigger: cue.trigger, evidence: cue.evidence, reps: typeof guideRepCount !== "undefined" ? guideRepCount : 0, target: Number(x?.targetReps?.match(/\d+/g)?.at(-1) || 0) });
        const c = typeof workout !== "undefined" ? workout : null;
        const same = c?.sessionId === w.sessionId && c.status === "exercise_active" && c.runtime?.coach?.phase === "REP_GUIDANCE" && `${c.sessionId}:${c.runtime.currentExerciseIndex}:${c.runtime.currentSetNumber}` === key;
        if (!r?.ok || !r.text || !same) return;
        note(diagnostics.cues, { trigger: cue.trigger, text: r.text, speak: Boolean(r.speak), at: new Date().toISOString() }, 10);
        if (!r.speak) return; // 静默观测:记录"如果开口会说什么",但不打扰训练
        voiceCaption = r.text; voiceUI();
        speech.play(r.text); // 短句,自然排在报数队列后,不打断计数
      } catch { /* 感知链路失败永不打扰训练 */ }
    };
    async function startActive(w, key) {
      const handle = { key, opening: true, lastRep: -1 };
      active = handle;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
        if (active !== handle) { stream.getTracks().forEach(t => t.stop()); return; }
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        await ctx.resume();
        if (active !== handle) { stream.getTracks().forEach(t => t.stop()); ctx.close(); return; }
        const source = ctx.createMediaStreamSource(stream), analyser = ctx.createAnalyser(), mute = ctx.createGain();
        analyser.fftSize = 2048; mute.gain.value = 0; // 静音出口保证 AnalyserNode 被拉取,且无回放
        source.connect(analyser); analyser.connect(mute); mute.connect(ctx.destination);
        handle.stream = stream; handle.ctx = ctx; handle.analyser = analyser;
        handle.analyzer = createEffortAnalyzer();
        handle.engine = createTimingEngine();
        const x = w.exercises[w.runtime.currentExerciseIndex];
        handle.engine.onSetStart(key, { target: Number(x?.targetReps?.match(/\d+/g)?.at(-1) || 0), now: Date.now() });
        handle.opening = false;
        diagnostics.inSet = true; diagnostics.setKey = key; diagnostics.cues = diagnostics.cues ?? [];
        let ttsUntil = 0;
        const buffer = new Float32Array(analyser.fftSize);
        handle.sampleTimer = setInterval(() => {
          if (active !== handle) return;
          const now = Date.now();
          if (speaking()) { ttsUntil = now + 400; return; } // 教练自己说话时不听(防自触发)+400ms 余响
          if (now < ttsUntil) return;
          analyser.getFloatTimeDomainData(buffer);
          let energy = 0; for (let i = 0; i < buffer.length; i++) energy += buffer[i] * buffer[i];
          for (const evt of handle.analyzer.feed(Math.sqrt(energy / buffer.length), now)) {
            note(diagnostics.events, { type: evt.type, at: new Date(now).toISOString(), baseline: evt.baseline }, 30);
            const cue = handle.engine.onPerceptionEvent(evt, now);
            if (cue) deliver(cue, w, key);
          }
          diagnostics.baseline = handle.analyzer.baseline;
          diagnostics.ema = handle.analyzer.ema;
          diagnostics.noisy = handle.analyzer.noisy;
        }, 100);
      } catch { stop(); }
    }
    setInterval(() => {
      try {
        const w = typeof workout !== "undefined" ? workout : null;
        const inSet = w && w.status === "exercise_active" && w.runtime?.coach?.phase === "REP_GUIDANCE" && !document.hidden && !lifecycleSuspended && voicePermissionReady;
        if (!inSet) { stop(); return; }
        if (active?.opening) return;
        const key = `${w.sessionId}:${w.runtime.currentExerciseIndex}:${w.runtime.currentSetNumber}`;
        if (active && active.key === key) {
          const rep = cadenceActive ? guideRepCount : 0; // 报数进度喂给时机引擎(节奏确认/最后冲刺/半程判定)
          if (rep !== active.lastRep) { active.lastRep = rep; const cue = active.engine.onRep(rep, Date.now()); if (cue) deliver(cue, w, key); }
          return;
        }
        stop();
        startActive(w, key);
      } catch { stop(); }
    }, 1000);
  })();
}
