import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import vm from "node:vm";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { DatabaseSync } from "node:sqlite";

test("mobile stability: offline listening survives 30 seconds of silence", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const start = html.indexOf("async function listenOffline(");
  const source = html.slice(start, html.indexOf("function listen(", start));
  let now = 0, poll: (() => void) | undefined, limit: (() => void) | undefined;
  const processor: any = { connect() {}, disconnect() {} };
  let delivered = "";
  const sandbox: any = {
    workout: { status: "resting", runtime: { coach: { phase: "REST" } } },
    userId: "sandbox-user",
    voiceEnabled: true, voiceToken: 0, voiceState: "idle", voiceCaption: "", voicePermissionReady: true,
    recognition: null, offlineRecorder: null, voiceInputTarget: "coach",
    document: { hidden: false }, lifecycleSuspended: false,
    Date: { now: () => now }, stopCadence() {}, speech: { stop() {} }, voiceUI() {},
    setInterval(fn: () => void) { poll = fn; return 1; }, clearInterval() {},
    setTimeout(fn: () => void) { limit = fn; return 2; }, clearTimeout() {},
    localStorage: { getItem: () => null }, recordingWav: () => "wav",
    fetch: async () => ({ ok: true, json: async () => ({ text: "下一组", confidence: 1 }) }),
    scheduleAutoListen() { throw Error("Silent offline capture should keep the microphone open"); },
    microphoneFailure(error: Error) { throw error; },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
    window: { isSecureContext: true, AudioContext: class {
      sampleRate = 16000; destination = {}; async resume() {} close() {}
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      createScriptProcessor() { return processor; }
    } }
  };
  vm.createContext(sandbox); vm.runInContext(source, sandbox);
  await sandbox.listenOffline(async (text: string) => { delivered = text; });
  for (now = 1000; now <= 30000; now += 1000) { poll!(); if (now === 20000) limit?.(); }
  assert.equal(sandbox.voiceEnabled, true);
  assert.equal(sandbox.voiceState, "listening");
  assert.ok(sandbox.offlineRecorder);
  processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(16).fill(0.1) }, outputBuffer: { getChannelData: () => new Float32Array(16) } });
  await sandbox.offlineRecorder.finish(true);
  assert.equal(delivered, "下一组");
});

async function bindAction(origin: string, path: string, payload: any) {
  if (!payload || !path.endsWith("/actions") || payload.context) return payload;
  const { workout: w } = await fetch(origin + path.slice(0, -8)).then(r => r.json());
  return { ...payload, context: { sessionId: w.sessionId, exerciseId: w.exercises[w.runtime.currentExerciseIndex]?.exerciseId ?? null,
    setNumber: w.runtime.currentSetNumber, coachPhase: w.runtime.coach?.phase ?? null, status: w.status, eventCount: w.runtime.events.length } };
}

async function localModel() {
  const calls: Array<{ path: string; authorization?: string; body: any }> = [];
  const server = createHttpServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : null;
    calls.push({ path: req.url!, authorization: req.headers.authorization, body });
    const message = body?.messages?.at(-1)?.content;
    res.setHeader("content-type", "application/json");
    if (message === "拒绝访问") { res.writeHead(401); res.end(JSON.stringify({ error: { code: "401002", message: "test credential must not be echoed" } })); return; }
    if (message === "错误格式") { res.end("not-json"); return; }
    if (req.method === "GET") { res.end(JSON.stringify(req.url!.endsWith("/api/tags") ? { models: [{ name: "test-deepseek" }] } : { data: [{ id: "test-deepseek" }] })); return; }
    if (message === "等待旧回复") await new Promise(resolve => setTimeout(resolve, 800));
    const content = message === "等待旧回复" ? "旧回复不应出现。" : "可以先放慢节奏。你今天最想解决什么？";
    res.end(JSON.stringify(req.url!.endsWith("/api/chat") ? { message: { content } } : { choices: [{ message: { content: `<think>test reasoning</think>${content}`, reasoning_content: "test reasoning" }, finish_reason: message === "截断回复" ? "length" : "stop" }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, calls, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

test("model integration: real HTTP adapter, conversation context, encrypted credentials and failures", { timeout: 60000 }, async () => {
  const mock = await localModel(), port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const directory = await mkdtemp(join(tmpdir(), "trainmind-model-")), databasePath = join(directory, "test.db");
  let server: ReturnType<typeof spawn> | undefined;
  const start = async () => {
    server = spawn(process.execPath, ["src/server.ts"], { cwd: new URL("..", import.meta.url), env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", TRAINMIND_DB: databasePath, TRAINMIND_CHAT_BASE_URL: "", TRAINMIND_CHAT_MODEL: "", TRAINMIND_CHAT_API_KEY: "", TRAINMIND_CHAT_PROTOCOL: "openai" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; server.stdout!.on("data", data => output += data); server.stderr!.on("data", data => output += data);
    await until(async () => output.includes("TrainMind running"), "Model integration server did not start: " + output);
  };
  const stop = async () => { if (server && server.exitCode === null) { const closed = new Promise(resolve => server!.once("exit", resolve)); server.kill(); await closed; } };
  const request = async (path: string, body?: any, headers = {}) => {
    body = await bindAction(origin, path, body);
    const response = await fetch(origin + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json() };
  };
  const api = async (path: string, body?: any) => { const result = await request(path, body); assert.ok(result.status >= 200 && result.status < 300, `${path}: ${result.status} ${result.data.error ?? ""}`); return result.data; };
  try {
    await start();
    assert.equal((await api("/api/coach/settings")).configured, false);
    assert.match((await request("/api/coach", { message: "今天有点累" })).data.error, /模型/);
    assert.equal(mock.calls.length, 0);
    const fakeKey = process.platform === "win32" ? "test-only-fake-model-key" : "";
    const config = { baseUrl: mock.origin + "/ai-router", model: "test-deepseek", protocol: "openai", apiKey: fakeKey };
    const saved = await api("/api/coach/settings", config);
    assert.equal(saved.configured, true); assert.equal(saved.keyConfigured, Boolean(fakeKey));
    assert.equal("apiKey" in saved, false); assert.equal("protectedKey" in saved, false);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    const stored = database.prepare("SELECT data_json FROM app_settings WHERE name='coach'").get() as { data_json: string }; database.close();
    if (fakeKey) { assert.ok(!stored.data_json.includes(fakeKey)); assert.ok(JSON.parse(stored.data_json).protectedKey.length > 20); }
    assert.deepEqual((await api("/api/coach/models", {})).models, ["test-deepseek"]);
    const connection = await api("/api/coach/test", {});
    assert.ok(connection.connectedAt); assert.ok(!connection.reply.includes("think"));
    const history = [{ role: "system", content: "untrusted system instruction" }, { role: "user", content: "昨天我没睡好" }, { role: "assistant", content: "你今天感觉怎么样？" }];
    const reply = await api("/api/coach", { message: "刚才说的情况怎么安排？", history });
    assert.equal(reply.mode, "language_model");
    assert.equal(reply.status, null); assert.equal(reply.reply, connection.reply);
    const sent = mock.calls.at(-1)!;
    assert.equal(sent.path, "/ai-router/chat/completions");
    assert.equal(sent.authorization, fakeKey ? `Bearer ${fakeKey}` : undefined);
    assert.deepEqual((sent.body as any).thinking, { type: "disabled" }, "deepseek 系模型必须关思考(语音教练要短平快)");
    assert.deepEqual(sent.body.messages.slice(1), [...history.slice(1), { role: "user", content: "刚才说的情况怎么安排？" }]);
    const plan = (await api("/api/workouts/preview", { userId: "test-user", input: "我在家，20分钟，练全身" })).workout;
    assert.ok(plan.exercises.filter((x: any) => x.repOrTimeBased !== "time").every((x: any) => /^\d+(?:\/侧)?$/.test(x.targetReps)), "Plan should prescribe one exact rep count");
    const legacy = structuredClone(plan); legacy.exercises[0].targetReps = "6-10"; legacy.exercises[0].instructions = ["Stand with feet hip-width, holding a dumbbell in each hand."];
    const seed = new DatabaseSync(databasePath); seed.prepare("UPDATE workout_sessions SET data_json=? WHERE id=?").run(JSON.stringify(legacy), plan.sessionId); seed.close();
    const restored = (await api(`/api/workouts/${plan.sessionId}`)).workout;
    assert.equal(restored.exercises[0].targetReps, "6");
    assert.ok(restored.exercises[0].instructions.length > 0);
    assert.ok(restored.exercises[0].instructions.every((line: string) => /[\u4e00-\u9fff]/.test(line) && !/[A-Za-z]{4}/.test(line)));
    const active = (await api(`/api/workouts/${plan.sessionId}/actions`, { type: "start" })).workout;
    await api(`/api/workouts/${plan.sessionId}/coach`, { message: "还剩几组？" });
    const context = JSON.parse(mock.calls.at(-1)!.body.messages[0].content.split("\n").at(-1));
    assert.equal(context.status, active.status); assert.equal(context.currentSet, active.runtime.currentSetNumber);
    assert.equal(context.currentExercise.targetReps, active.exercises[active.runtime.currentExerciseIndex].targetReps);
    assert.deepEqual((await api(`/api/workouts/${plan.sessionId}`)).workout.runtime, active.runtime);
    await api(`/api/workouts/${plan.sessionId}/actions`, { type: "complete_set" });
    const feedback = await api(`/api/workouts/${plan.sessionId}/actions`, { type: "feedback", feedback: "right" });
    assert.equal(feedback.setRecord.targetReps, "6"); assert.equal(feedback.setRecord.actualReps, 6);
    for (const [message, pattern] of [["拒绝访问", /密钥|Key|权限/], ["错误格式", /JSON/], ["截断回复", /截断/]] as const) {
      const failure = await request(`/api/workouts/${plan.sessionId}/coach`, { message });
      assert.equal(failure.status, 400); assert.match(failure.data.error, pattern);
      assert.ok(!JSON.stringify(failure.data).includes("test credential"));
      if (message === "拒绝访问") assert.match(failure.data.error, /401002.*无效|无效.*401002/);
    }
    // H5(2026-11-06 全仓审查):不可信 Origin 的写请求现在被入口守卫先拦(403 Forbidden),
    // 不再走到 requireLocalSettings 的 400——两层都拒绝,外层语义更准
    assert.equal((await request("/api/coach/settings", config, { origin: "https://untrusted.example" })).status, 403);
    await stop(); await start();
    assert.equal((await api("/api/coach/settings")).keyConfigured, Boolean(fakeKey));
    await api("/api/coach", { message: "重启后继续聊" });
    assert.equal(mock.calls.at(-1)!.authorization, fakeKey ? `Bearer ${fakeKey}` : undefined);
    await api("/api/coach/settings", { ...config, apiKey: "" });
    assert.equal((await api("/api/coach/settings")).keyConfigured, Boolean(fakeKey));
    await api("/api/coach/settings", { ...config, apiKey: "", clearKey: true });
    assert.equal((await api("/api/coach/settings")).keyConfigured, false);
    await api("/api/coach/settings", { ...config, baseUrl: mock.origin, protocol: "ollama", apiKey: "" });
    assert.deepEqual((await api("/api/coach/models", {})).models, ["test-deepseek"]);
    await api("/api/coach", { message: "用本机格式继续聊" });
    assert.equal(mock.calls.at(-1)!.path, "/api/chat");
    if (fakeKey) {
      await api("/api/coach/settings", { ...config, baseUrl: mock.origin + "/v1", protocol: "tencent" });
      await api("/api/coach", { message: "验证腾讯云兼容请求" });
      assert.equal(mock.calls.at(-1)!.path, "/v1/chat/completions");
      assert.deepEqual(mock.calls.at(-1)!.body.thinking, { type: "disabled" });
      assert.equal(mock.calls.at(-1)!.authorization, `Bearer ${fakeKey}`);
      await api("/api/coach/settings", { ...config, baseUrl: mock.origin + "/plan/v3", protocol: "tencent" });
      assert.deepEqual((await api("/api/coach/models", {})).models, ["test-deepseek"]);
      assert.equal(mock.calls.at(-1)!.path, "/v1/models");
      const planConnection = await api("/api/coach/test", {});
      assert.ok(planConnection.connectedAt);
      assert.equal(mock.calls.at(-1)!.path, "/plan/v3/chat/completions");
      assert.equal(mock.calls.at(-1)!.authorization, `Bearer ${fakeKey}`);
      await api("/api/coach/settings", { ...config, baseUrl: mock.origin + "/v1", protocol: "tencent", apiKey: "", clearKey: true });
      assert.equal((await api("/api/coach/settings")).configured, false);
      const calls = mock.calls.length;
      assert.equal((await request("/api/coach/test", {})).status, 400);
      assert.equal(mock.calls.length, calls);
    }
  } finally {
    await stop(); await mock.close();
    assert.ok(directory.startsWith(join(tmpdir(), "trainmind-model-")));
    await rm(directory, { recursive: true, force: true });
  }
});

async function freePort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

async function until(check: () => Promise<any>, message: string) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error(message);
}

async function connect(url: string) {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error("Browser connection timed out: " + url)), 5000);
    socket.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
    socket.addEventListener("error", event => { clearTimeout(timeout); reject(event); }, { once: true });
  });
  let id = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: any) => void }>();
  socket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data)), request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(Error(message.error.message));
    else request.resolve(message.result);
  });
  return {
    close: () => socket.close(),
    call(method: string, params: any = {}): Promise<any> {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(Error("Browser command timed out: " + method)), 5000);
        pending.set(++id, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
        socket.send(JSON.stringify({ id, method, params }));
      });
    }
  };
}

test("browser: startup, plan confirmation, spoken cues and compact layouts", { timeout: 60000 }, async t => {
  const candidates = [process.env.TRAINMIND_TEST_BROWSER, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].filter(Boolean) as string[];
  let executable: string | undefined;
  for (const path of candidates) { try { await access(path); executable = path; break; } catch {} }
  if (!executable) { t.skip("Set TRAINMIND_TEST_BROWSER to a Chrome/Chromium executable for browser checks."); return; }
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const profile = await mkdtemp(join(tmpdir(), "trainmind-ui-"));
  const server = spawn(process.execPath, ["src/server.ts"], { cwd: new URL("..", import.meta.url), env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", TRAINMIND_DB: ":memory:" }, stdio: ["ignore", "pipe", "pipe"] });
  let serverOutput = "";
  server.stdout.on("data", data => serverOutput += data);
  server.stderr.on("data", data => serverOutput += data);
  const chrome = spawn(executable, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let chromeOutput = "";
  chrome.stderr.on("data", data => chromeOutput += data);
  let browser: Awaited<ReturnType<typeof connect>> | undefined, page: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    await until(async () => serverOutput.includes("TrainMind running"), "Isolated server did not start: " + serverOutput);
    const endpoint = await until(async () => chromeOutput.match(/DevTools listening on (ws:\/\/\S+)/)?.[1], "Chrome did not start: " + chromeOutput);
    browser = await connect(endpoint);
    const debugOrigin = endpoint.replace(/^ws:/, "http:").split("/devtools/")[0];
    const target = await fetch(`${debugOrigin}/json/new?about:blank`, { method: "PUT" }).then(r => r.json());
    page = await connect(target.webSocketDebuggerUrl);
    await page.call("Page.enable");
    await page.call("Runtime.enable");
    const evaluate = async (expression: string, userGesture = false) => {
      const result = await page!.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture });
      if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    };
    await page.call("Page.addScriptToEvaluateOnNewDocument", { source: `
      window.__spoken = []; window.__resumes = 0;
      window.__utterances = []; window.__cancels = 0;
      window.__recognizers = [];window.__actionRequests=[];
      window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
      Object.defineProperty(window, 'speechSynthesis', { value: { speaking: false, pending: false, paused: true,
        getVoices: () => [{lang:'zh-CN',name:'Test Chinese'}],
        speak(u) { window.__utterances.push(u);window.__spoken.push(u.text);this.speaking=true;u.onstart?.(); },
        resume() { this.paused = false; window.__resumes++; }, pause() {this.paused=true}, cancel() {this.speaking=false;window.__cancels++} } });
      window.__finishSpeech = () => {window.speechSynthesis.speaking=false;window.__utterances.at(-1)?.onend?.()};
      window.SpeechRecognition = class {
        start(){window.__recognizers.push(this);queueMicrotask(()=>this.onstart?.())}
        abort(){this.onend?.()}
        result(text){this.onresult?.({results:[[{transcript:text}]]});this.onend?.()}
        fail(error){this.onerror?.({error});this.onend?.()}
      };
      const originalFetch=window.fetch.bind(window);
      window.fetch=(url,options)=>{if(String(url).endsWith('/actions')&&options?.body)window.__actionRequests.push(JSON.parse(options.body));return originalFetch(url,options)};
    ` });
    const api = async (path: string, body?: any) => {
      body = await bindAction(origin, path, body);
      const response = await fetch(origin + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      assert.ok(response.ok, await response.clone().text());
      return response.json();
    };
    const saved = (await api("/api/workouts/preview", { input: "我在家，有20分钟，想练全身", userId: "demo-user" })).workout;
    await api(`/api/workouts/${saved.sessionId}/actions`, { type: "start" });
    await page.call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.call("Page.navigate", { url: origin });
    await until(() => evaluate("typeof workout !== 'undefined' && workout !== null"), "Saved training was not loaded");
    await until(() => evaluate("typeof offlineSpeechAvailable !== 'undefined'"), "Voice capability state was not initialized");
    await api("/api/voice/status");
    await evaluate("voiceCapabilityPromise");
    await evaluate("offlineSpeechAvailable=false");

    await t.test("opening with saved training keeps the plan form visible and starts no cues", async () => {
      assert.equal(await evaluate("document.querySelector('.shell').dataset.screen"), "home");
      assert.equal(await evaluate("!!document.querySelector('#create')"), true);
      assert.deepEqual(await evaluate("window.__spoken"), []);
      assert.equal(await evaluate("cadenceTimer"), null);
      assert.equal(await evaluate("!!document.querySelector('#continue-workout')"), true);
    });
    await t.test("a user gesture resumes synthesis and keeps cues independent of microphone support", async () => {
      await evaluate("primeVoiceFromGesture()", true);
      assert.ok(await evaluate("window.__resumes > 0"));
      assert.ok(await evaluate("window.__spoken.some(text => /语音|训练/.test(text))"));
      await evaluate("speech.stop()");
    });
    await t.test("continuing saved training starts its cues only after clicking Continue", async () => {
      await evaluate("document.querySelector('#continue-workout').click()", true);
      await until(() => evaluate("document.querySelector('.shell').dataset.screen==='exercise'"), "Continue did not load current session state");
      assert.equal(await evaluate("document.querySelector('.shell').dataset.screen"), "exercise");
      assert.equal(await evaluate("cadenceTimer"), null);
      assert.ok(await evaluate("window.__spoken.some(text => text.includes(workout.exercises[0].name))"));
      await evaluate("home()");
      assert.equal(await evaluate("cadenceTimer"), null);
      const button = await evaluate("({bottom:document.querySelector('#generate-plan').getBoundingClientRect().bottom, navTop:document.querySelector('.bottomnav').getBoundingClientRect().top})");
      assert.ok(button.bottom <= button.navTop, JSON.stringify(button));
    });
    await t.test("generating a plan leaves training unstarted until confirmation", async () => {
      await evaluate("home(); document.querySelector('#prompt').value='我在家，有20分钟，想练全身'; document.querySelector('#create').requestSubmit()", true);
      await until(() => evaluate("workout?.status === 'preview' && !!document.querySelector('#start')"), "Plan preview did not appear");
      assert.equal(await evaluate("cadenceTimer"), null);
      assert.equal(await evaluate("document.querySelector('.shell').dataset.screen"), "plan");
      assert.equal(await evaluate("!!document.querySelector('#voice-test')"), true);
      assert.equal(await evaluate("!!document.querySelector('.plan-overview')"), true);
      await evaluate("document.querySelector('[data-plan-info]').click()");
      assert.equal(await evaluate("document.querySelector('.plan-detail').hidden"), false);
      assert.ok(await evaluate("document.querySelector('.plan-detail').textContent.includes(workout.exercises[0].instructions[0])"));
    });
    await t.test("start and set feedback produce spoken instructions", async t => {
      await evaluate("document.querySelector('#start').click()", true);
      await until(() => evaluate("workout?.status === 'exercise_active' && !!document.querySelector('#done')"), "Training did not start");
      assert.ok(await evaluate("window.__spoken.some(text => text.includes(workout.exercises[0].name))"));
      await t.test("elapsed cadence never marks unconfirmed work complete", async () => {
        assert.equal(await evaluate("cadenceTimer"), null);
        assert.equal(await evaluate("workout.status"), "exercise_active");
        assert.equal(await evaluate("!!document.querySelector('#rep-plus')"), false);
        assert.doesNotMatch(await evaluate("document.querySelector('#cadence-count').textContent"), /已确认 0/);
      });
      await t.test("short or cancelled swipes never complete a set", async () => {
        const swipe = await evaluate(`(()=>{const r=document.querySelector('#done').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
        await page!.call("Input.dispatchMouseEvent", { type: "mousePressed", x: swipe.x, y: swipe.y, button: "left", clickCount: 1 });
        await page!.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: swipe.x + 35, y: swipe.y, button: "left", buttons: 1 });
        await page!.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: swipe.x + 35, y: swipe.y, button: "left", clickCount: 1 });
        assert.equal(await evaluate("workout.status"), "exercise_active");
        assert.equal(await evaluate("window.__actionRequests.filter(x=>x.type==='complete_set').length"), 0);
        await evaluate(`(()=>{const b=document.querySelector('#done');b.dispatchEvent(new PointerEvent('pointerdown',{pointerId:99,clientX:10}));b.dispatchEvent(new PointerEvent('pointermove',{pointerId:99,clientX:500}));b.dispatchEvent(new PointerEvent('pointercancel',{pointerId:99}));})()`);
        assert.equal(await evaluate("workout.status"), "exercise_active");
        assert.equal(await evaluate("document.querySelector('.swipe-complete').style.getPropertyValue('--swipe-x')"), "0px");
      });
      await t.test("completion stays reachable on a small screen while training content scrolls", async () => {
        await page!.call("Emulation.setDeviceMetricsOverride", { width: 320, height: 568, deviceScaleFactor: 1, mobile: true });
        const layout = await evaluate(`(()=>{const r=document.querySelector('#done').getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:innerHeight,width:document.documentElement.scrollWidth,viewport:innerWidth,overflow:getComputedStyle(document.querySelector('#app')).overflowY}})()`);
        assert.ok(layout.top >= 0 && layout.bottom <= layout.height, JSON.stringify(layout));
        assert.ok(layout.width <= layout.viewport, JSON.stringify(layout));
        assert.equal(layout.overflow, "auto");
        await page!.call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      });
      await t.test("spoken prescription uses the same exact count as the displayed target", async () => {
        assert.ok(await evaluate("window.__utterances.at(-1).text.includes(workout.exercises[0].targetReps)"));
        assert.match(await evaluate("workout.exercises[0].targetReps"), /^\d+(?:\/侧)?$/);
        assert.equal(await evaluate("/[A-Za-z]{4}/.test(window.__utterances.at(-1).text)"), false);
      });
      await t.test("asking a question interrupts narration without advancing training", async () => {
        await evaluate("handleCoachInput('我做了两次')", true);
        await evaluate("document.querySelector('#mic').click()", true);
        assert.equal(await evaluate("voiceState"), "listening", JSON.stringify(await evaluate("({state:voiceState,caption:voiceCaption,offline:offlineSpeechAvailable,recognition:!!recognition,micDisabled:document.querySelector('#mic').disabled,hasHandler:!!document.querySelector('#mic').onclick})")));
        await until(() => evaluate("voiceState==='listening'"), "Microphone did not start");
        assert.equal(await evaluate("speechSynthesis.speaking"), false);
        await evaluate("window.__recognizers.at(-1).result('这个动作怎么做？')");
        await until(() => evaluate("!coachBusy && coachHistory.at(-1)?.role==='assistant'"), "Coach did not answer the question");
        assert.equal(await evaluate("workout.status"), "exercise_active");
        assert.equal(await evaluate("repCount"), 2);
        assert.equal(await evaluate("document.querySelector('#voice-caption').textContent"), await evaluate("window.__utterances.at(-1).text"));
        await evaluate("handleCoachInput('再具体一点')");
        assert.ok(await evaluate("coachHistory.at(-1).content.includes(workout.exercises[0].name)"));
      });
      await t.test("optional pacing uses short counts, adjustable speed and never completes the set", async () => {
        await evaluate("document.querySelector('#cadence-toggle').click();window.__finishSpeech()", true);
        await until(() => evaluate("/^\\d+$/.test(window.__utterances.at(-1).text)"), "Pacing did not produce a short count");
        assert.equal(await evaluate("document.querySelector('#cadence-speed').hidden"), false);
        await evaluate("document.querySelector('#cadence-speed').value='4.5';document.querySelector('#cadence-speed').dispatchEvent(new Event('input'))");
        assert.equal(await evaluate("cadenceMs"), 4500);
        assert.equal(await evaluate("repCount"), 2);
        assert.equal(await evaluate("workout.status"), "exercise_active");
        await evaluate("document.querySelector('#cadence-toggle').click();window.__finishSpeech()");
        assert.equal(await evaluate("cadenceTimer"), null);
      });
      await evaluate("window.__oldCue=window.__utterances.at(-1);window.__beforeTransitionCancels=window.__cancels");
      const swipe = await evaluate(`(()=>{const b=document.querySelector('#done').getBoundingClientRect(),t=document.querySelector('.swipe-complete').getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2,end:t.right-b.width/2-6}})()`);
      await page!.call("Input.dispatchMouseEvent", { type: "mousePressed", x: swipe.x, y: swipe.y, button: "left", clickCount: 1 });
      await page!.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: swipe.end, y: swipe.y, button: "left", buttons: 1 });
      await page!.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: swipe.end, y: swipe.y, button: "left", clickCount: 1 });
      await until(() => evaluate("workout?.status === 'set_feedback' && !!document.querySelector('#submit')"), "Set feedback did not appear");
      assert.equal(await evaluate("window.__actionRequests.filter(x=>x.type==='complete_set').length"), 1);
      assert.ok(await evaluate("window.__spoken.some(text => text.includes('感觉怎么样'))"));
      await t.test("late callbacks from old cues cannot overwrite feedback captions", async () => {
        assert.ok(await evaluate("window.__cancels > window.__beforeTransitionCancels"));
        await evaluate("window.__oldCue.onstart?.();window.__oldCue.onend?.()");
        assert.match(await evaluate("document.querySelector('#voice-caption').textContent"), /感觉怎么样/);
      });
    });
    await t.test("small-screen feedback corrections remain scrollable and reachable", async () => {
      await page!.call("Emulation.setDeviceMetricsOverride", { width: 320, height: 568, deviceScaleFactor: 1, mobile: true });
      await evaluate("document.querySelector('details').open=true; document.querySelector('#submit').scrollIntoView({block:'end'})");
      const layout = await evaluate(`({ width: document.documentElement.scrollWidth, viewport: innerWidth,
        bottom: document.querySelector('#submit').getBoundingClientRect().bottom, height: innerHeight,
        overflow: getComputedStyle(document.querySelector('.feedback-screen')).overflowY })`);
      assert.ok(layout.width <= layout.viewport, JSON.stringify(layout));
      assert.ok(layout.bottom <= layout.height, JSON.stringify(layout));
      assert.notEqual(layout.overflow, "hidden");
    });
    await t.test("network recognition failures preserve a usable text conversation", async () => {
      await evaluate("document.querySelector('#mic').click()", true);
      await until(() => evaluate("voiceState==='listening'"), "Microphone did not start");
      await evaluate("window.__recognizers.at(-1).fail('network')");
      assert.match(await evaluate("document.querySelector('#voice-caption').textContent"), /服务连接失败/);
      assert.equal(await evaluate("voiceEnabled"), true, "A transient network failure should retain automatic retry");
      await evaluate("document.querySelector('.coach-chat summary').click()");
      assert.equal(await evaluate("document.querySelector('.coach-chat').open"), true);
      await evaluate("document.querySelector('#coach-input').value='还剩几组？';document.querySelector('#coach-form').requestSubmit()", true);
      await until(() => evaluate("!coachBusy&&coachHistory.at(-1)?.role==='assistant'"), "Text conversation did not answer");
      assert.equal(await evaluate("workout.status"), "set_feedback");
      assert.match(await evaluate("coachHistory.at(-1).content"), /已确认完成/);
    });
    await t.test("a spoken actual count and difficulty are recorded together", async t => {
      await evaluate("document.querySelector('#mic').click()", true);
      await until(() => evaluate("voiceState==='listening'"), "Microphone did not start");
      await evaluate("window.__recognizers.at(-1).result('我只做了六次，感觉有点难')");
      await until(() => evaluate("!coachBusy&&workout.status==='resting'"), "Spoken feedback was not applied");
      assert.ok(await evaluate("window.__actionRequests.some(x=>x.type==='feedback'&&x.actualReps===6&&x.feedback==='hard')"));
      assert.equal(await evaluate("document.querySelector('#voice-caption').textContent"), await evaluate("window.__utterances.at(-1).text"));
      await t.test("rest identifies the completed exercise and speaks the real remaining time", async () => {
        const state = await evaluate(`(()=>{const x=workout.exercises[workout.runtime.currentExerciseIndex],previous=x.completedSets>0?x:workout.exercises[workout.runtime.currentExerciseIndex-1];return {label:document.querySelector('.workout-head small').textContent,previous:previous.name,completed:previous.completedSets,spoken:Number(window.__utterances.at(-1).text.match(/休息 (\\d+) 秒/)[1]),remaining:Math.ceil((Date.parse(workout.runtime.restEndsAt)-Date.now())/1000)}})()`);
        assert.ok(state.label.includes(state.previous), JSON.stringify(state));
        assert.ok(state.label.includes(`已完成 ${state.completed}`), JSON.stringify(state));
        assert.ok(Math.abs(state.spoken-state.remaining) <= 2, JSON.stringify(state));
      });
    });
    await t.test("refreshing an unfinished session returns home without playing audio", async () => {
      await page!.call("Page.reload");
      await until(() => evaluate("typeof workout !== 'undefined' && workout?.status === 'paused' && !!document.querySelector('#create')"), "Refresh did not preserve the lifecycle pause");
      assert.equal(await evaluate("cadenceTimer"), null);
      assert.deepEqual(await evaluate("window.__spoken"), []);
    });
    await t.test("installed offline Chinese recognition transcribes actual WAV audio", async t => {
      const status = await api("/api/voice/status");
      if (!status.offlineRecognition) { t.skip("No installed Windows Chinese recognizer."); return; }
      const script = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';Add-Type -AssemblyName System.Speech;$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;$m=New-Object IO.MemoryStream;$s.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::NotSet,[System.Speech.Synthesis.VoiceAge]::NotSet,0,[Globalization.CultureInfo]::GetCultureInfo('zh-CN'));$s.SetOutputToWaveStream($m);$s.Speak('我只做了六次，感觉有点难。');$s.Speak('我想在办公室练一下。');[Console]::Write([Convert]::ToBase64String($m.ToArray()));$s.Dispose();$m.Dispose()`;
      const encoded = Buffer.from(script, "utf16le").toString("base64");
      const audio = await new Promise<Buffer>((resolve, reject) => {
        const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        let output = ""; child.stdout.on("data", data => output += data);child.stderr.resume();
        const timeout = setTimeout(() => { child.kill();reject(Error("Voice fixture timed out")); }, 10000);
        child.on("error", reject);child.on("close", code => {clearTimeout(timeout);code === 0 ? resolve(Buffer.from(output.trim(), "base64")) : reject(Error("Voice fixture failed"))});
      });
      const response = await fetch(origin + "/api/voice/transcribe", { method: "POST", headers: { "content-type": "audio/wav" }, body: audio });
      assert.equal(response.status, 200, await response.clone().text());
      const transcript = await response.json();
      assert.match(transcript.text, /六次/);
      assert.match(transcript.text, /难/);
      assert.equal(transcript.segments, 2);
      assert.match(transcript.text.split('，').at(-1)!, /办公/);
      assert.ok(transcript.confidence > 0);
      await t.test("captured PCM is sent to offline recognition and reaches the conversation", async () => {
        await evaluate(`window.__fixtureAudio=${JSON.stringify(audio.toString("base64"))}`);
        await evaluate(`(async()=>{
          const NativeContext=window.AudioContext,decoder=new NativeContext({sampleRate:16000});
          const bytes=Uint8Array.from(atob(window.__fixtureAudio),x=>x.charCodeAt(0));
          const decoded=await decoder.decodeAudioData(bytes.buffer);window.__pcm=new Float32Array(decoded.getChannelData(0));await decoder.close();
          window.__tracksStopped=0;window.__contextsClosed=0;
          navigator.mediaDevices.getUserMedia=async()=>({getTracks:()=>[{stop(){window.__tracksStopped++}}]});
          window.AudioContext=class{constructor(){this.sampleRate=16000;this.destination={}}
            async resume(){} async close(){window.__contextsClosed++}
            createMediaStreamSource(){return{connect(){},disconnect(){}}}
            createScriptProcessor(){window.__processor={connect(){},disconnect(){}};return window.__processor}}
          offlineSpeechAvailable=true;
          continueWorkout();
        })()`, true);
        await until(() => evaluate("!!document.querySelector('#resume')"), "Saved lifecycle pause did not appear");
        await evaluate("document.querySelector('#resume').click()", true);
        await until(() => evaluate("!!document.querySelector('#next')"), "Saved rest did not resume after confirmation");
        await evaluate("document.querySelector('#next').click()", true);
        await until(() => evaluate("!!document.querySelector('#done')"), "Next exercise did not start");
        await evaluate("document.querySelector('#done').click()", true);
        await until(() => evaluate("!!document.querySelector('#submit')"), "Feedback did not appear");
        await evaluate("document.querySelector('#mic').click()", true);
        await until(() => evaluate("!!offlineRecorder"), "Offline recording did not start");
        await evaluate("window.__processor.onaudioprocess({inputBuffer:{getChannelData:()=>window.__pcm},outputBuffer:{getChannelData:()=>new Float32Array(window.__pcm.length)}});offlineRecorder.finish(true)");
        await until(() => evaluate("workout.status==='resting'||!!document.querySelector('#coach-input')?.value"), "Offline transcript did not reach the conversation");
        if (await evaluate("workout.status!=='resting'")) {
          await evaluate("document.querySelector('#coach-form').requestSubmit()", true);
          await until(() => evaluate("workout.status==='resting'&&!coachBusy"), "Confirmed transcript did not save feedback");
        }
        assert.ok(await evaluate("window.__tracksStopped>0&&window.__contextsClosed>0"));
        assert.ok(await evaluate("coachHistory.some(x=>x.role==='user'&&x.content.includes('六次'))"));
        assert.ok(await evaluate("window.__actionRequests.some(x=>x.type==='feedback'&&x.actualReps===6&&x.feedback==='hard')"));
      });
      await t.test("uncertain coach transcription opens an editable draft and visible Send button", async () => {
        await evaluate(`window.__beforeCoachVoiceFetch=window.fetch;window.fetch=(url,options)=>String(url)==='/api/voice/transcribe'?Promise.resolve(new Response(JSON.stringify({text:'我做不到',confidence:0.22,provider:'windows-local'}),{headers:{'content-type':'application/json'}})):window.__beforeCoachVoiceFetch(url,options);render();document.querySelector('#mic').click()`, true);
        try {
          await until(() => evaluate("!!offlineRecorder"), "Coach recording did not start");
          const turnsBefore = await evaluate("coachHistory.length");
          await evaluate("window.__processor.onaudioprocess({inputBuffer:{getChannelData:()=>window.__pcm},outputBuffer:{getChannelData:()=>new Float32Array(window.__pcm.length)}});offlineRecorder.finish(true)");
          await until(() => evaluate("document.querySelector('#coach-input')?.value==='我做不到'"), "Uncertain transcript was not retained");
          assert.equal(await evaluate("coachHistory.length"), turnsBefore, "An uncertain transcript must wait for confirmation");
          assert.equal(await evaluate("document.querySelector('.coach-chat').open"), true);
          assert.equal(await evaluate("document.activeElement===document.querySelector('#coach-input')"), true);
          assert.ok(await evaluate("document.querySelector('#coach-form button').getBoundingClientRect().height>0"), "Send button was hidden inside collapsed details");
          assert.equal(await evaluate("document.querySelector('#coach-form button').textContent"), "发送");
          await evaluate("document.querySelector('#coach-input').value='暂停训练';document.querySelector('#coach-form button').click()", true);
          await until(() => evaluate("workout.status==='paused'&&!coachBusy"), "Visible Send did not submit the edited voice draft");
          assert.equal(await evaluate("coachHistory.at(-1).content"), "暂停训练");
        } finally {
          await evaluate("(async()=>{window.fetch=window.__beforeCoachVoiceFetch;if(workout.status==='paused')await action('resume')})()");
        }
      });
      await t.test("home voice input uses the same offline capture and fills the plan form", async () => {
        await evaluate("home();document.querySelector('#prompt').value='30分钟，在家';document.querySelector('#prompt').dispatchEvent(new Event('input'));document.querySelector('#home-mic').click()", true);
        await until(() => evaluate("!!offlineRecorder"), "Home did not open offline recording");
        assert.match(await evaluate("document.querySelector('#home-voice-status').textContent"), /正在听/);
        await evaluate("window.__processor.onaudioprocess({inputBuffer:{getChannelData:()=>window.__pcm},outputBuffer:{getChannelData:()=>new Float32Array(window.__pcm.length)}});document.querySelector('#home-mic').click()", true);
        await until(() => evaluate("document.querySelector('#prompt').value.includes('六次')"), "Home transcription did not populate the prompt");
        assert.match(await evaluate("document.querySelector('#prompt').value"), /^30分钟，在家/);
        assert.equal(await evaluate("document.querySelector('#prompt-count').textContent"), await evaluate("document.querySelector('#prompt').value.length+'/200'"));
        assert.equal(await evaluate("document.querySelector('.shell').dataset.screen"), "home");
        assert.equal(await evaluate("workout.status"), "resting");
        assert.equal(await evaluate("offlineRecorder"), null);
      });
      await t.test("low-confidence home transcription asks to check critical information", async () => {
        await evaluate(`window.__beforeVoiceFetch=window.fetch;window.fetch=(url,options)=>String(url)==='/api/voice/transcribe'?Promise.resolve(new Response(JSON.stringify({text:'国有20 min.的时间',confidence:0.22,provider:'windows-local'}),{headers:{'content-type':'application/json'}})):window.__beforeVoiceFetch(url,options);home();document.querySelector('#home-mic').click()`, true);
        await until(() => evaluate("!!offlineRecorder"), "Low-confidence recording did not start");
        await evaluate("window.__processor.onaudioprocess({inputBuffer:{getChannelData:()=>window.__pcm},outputBuffer:{getChannelData:()=>new Float32Array(window.__pcm.length)}})");
        await new Promise(resolve => setTimeout(resolve, 1700));
        assert.equal(await evaluate("!!offlineRecorder"), true, "A pause between sentences must not end home recording");
        await evaluate("document.querySelector('#home-mic').click()", true);
        await until(() => evaluate("document.querySelector('#home-voice-status').textContent.includes('把握较低')"), "Low confidence was silently accepted");
        assert.match(await evaluate("document.querySelector('#home-voice-status').textContent"), /时间、地点和疼痛/);
        assert.equal(await evaluate("document.querySelector('.shell').dataset.screen"), "home");
        await evaluate("window.fetch=window.__beforeVoiceFetch");
      });
    });
    await t.test("model settings and free conversation work without a training session", async () => {
      const mock = await localModel();
      await evaluate("window.__savedWorkout=workout;workout=null;coachHistory=[];home();document.querySelector('#open-coach').click()");
      try {
        await until(() => evaluate("!!document.querySelector('#configure-coach')"), "Free conversation entry did not open");
        await evaluate("document.querySelector('#configure-coach').click()");
        await until(() => evaluate("!!document.querySelector('#model-settings')&&document.querySelector('#model-url').value!==''"), "Settings did not load");
        await evaluate("document.querySelector('#preset-company').click()");
        assert.equal(await evaluate("document.querySelector('#model-url').value"), "https://ai-maas.zen5prod.com/ai-router");
        await evaluate("document.querySelector('#preset-tencent').click()");
        assert.equal(await evaluate("document.querySelector('#model-url').value"), "https://tokenhub.tencentmaas.com/v1");
        assert.equal(await evaluate("document.querySelector('#model-name').value"), "deepseek-v4-flash");
        assert.equal(await evaluate("document.querySelector('#model-key').value"), "");
        await evaluate("document.querySelector('#preset-tencent-plan').click()");
        assert.equal(await evaluate("document.querySelector('#model-url').value"), "https://tokenhub.tencentmaas.com/plan/v3");
        assert.equal(await evaluate("document.querySelector('#model-protocol').value"), "tencent");
        assert.match(await evaluate("document.querySelector('#model-config-status').textContent"), /Token Plan/);
        await evaluate(`document.querySelector('#model-url').value=${JSON.stringify(mock.origin + "/v1")};document.querySelector('#model-protocol').value='openai';document.querySelector('#model-name').value='';document.querySelector('#load-models').click()`);
        await until(() => evaluate("document.querySelector('#model-name').value==='test-deepseek'"), "Model list was not populated");
        await evaluate("document.querySelector('#test-model').click()");
        await until(() => evaluate("document.querySelector('#model-config-status').textContent.startsWith('连接成功')"), "Model connection was not tested");
        await evaluate("document.querySelector('#settings-back').click()");
        await until(() => evaluate("document.querySelector('#coach-connection')?.textContent.includes('test-deepseek')"), "Coach did not show configured model");
        await evaluate("document.querySelector('#coach-input').value='今天不想训练，能聊聊吗？';document.querySelector('#coach-form').requestSubmit()", true);
        await until(() => evaluate("!coachBusy&&coachHistory.at(-1)?.role==='assistant'"), "Free conversation did not reply");
        assert.equal(await evaluate("workout"), null);
        assert.equal(await evaluate("window.__spoken.at(-1)"), await evaluate("coachHistory.at(-1).content"));
        assert.equal(await evaluate("voiceCaption"), await evaluate("coachHistory.at(-1).content"));
        await evaluate("void handleCoachInput('那我现在该怎么做？')", true);
        await until(() => evaluate("!coachBusy&&coachHistory.length===4"), "Follow-up did not reply");
        assert.equal(mock.calls.at(-1)!.body.messages.length, 4);
        await evaluate("void handleCoachInput('等待旧回复')", true);
        await until(async () => mock.calls.at(-1)?.body?.messages?.at(-1)?.content === "等待旧回复", "Slow reply did not start");
        await evaluate("void handleCoachInput('先回答这个新问题')", true);
        await until(() => evaluate("!coachBusy&&coachHistory.at(-1)?.role==='assistant'"), "Interrupting question did not reply");
        await new Promise(resolve => setTimeout(resolve, 1000));
        assert.equal(await evaluate("coachHistory.some(x=>x.role==='assistant'&&x.content.includes('旧回复'))"), false);
        assert.equal(await evaluate("window.__spoken.some(x=>x.includes('旧回复'))"), false);
        await evaluate("void handleCoachInput('拒绝访问')", true);
        await until(() => evaluate("!coachBusy&&!!document.querySelector('#retry-coach')"), "Failed request had no retry feedback");
        assert.match(await evaluate("document.querySelector('#coach-history [role=alert]').textContent"), /401002.*无效/);
        assert.equal(await evaluate("document.querySelector('#voice-status').textContent"), "教练暂时无法回复");
        assert.equal(await evaluate("document.querySelector('#coach-form button').textContent"), "发送");
        const failedCalls = mock.calls.length;
        await evaluate("document.querySelector('#retry-coach').click()", true);
        await until(() => evaluate("!coachBusy&&!!document.querySelector('#retry-coach')"), "Retry did not finish");
        assert.equal(mock.calls.length, failedCalls + 1);
        assert.equal(await evaluate("coachHistory.filter(x=>x.role==='user'&&x.content==='拒绝访问').length"), 1);
        await evaluate("document.querySelector('#fix-coach-settings').click()");
        await until(() => evaluate("document.querySelector('#model-url')?.value.includes('/v1')"), "Repair configuration entry did not load");
        await evaluate("document.querySelector('#settings-back').click()");
        await until(() => evaluate("!!document.querySelector('#coach-form')"), "Configuration did not return to the conversation");
      } finally { await evaluate("workout=window.__savedWorkout;home()"); await mock.close(); }
    });
    await t.test("Phase 7A: speech leads counting, early feedback, actual confirmation and the next set", async () => {
      const result = await api('/api/workouts/preview', { input: '我在 Test Gym，有40分钟，想练背。', userId: 'coach-browser', dataOrigin: 'automated_test' });
      const started = await api(`/api/workouts/${result.workout.sessionId}/actions`, { type: 'start', coach: true });
      await evaluate(`workout=${JSON.stringify(started.workout)};voiceInputTarget='coach';voiceEnabled=true;voicePermissionReady=true;offlineSpeechAvailable=false;cadenceMs=1500;render()`, true);
      await until(() => evaluate("workout.runtime.coach.phase==='START_SET'"), 'Coach did not prepare the set');
      await evaluate('window.__finishSpeech()');
      assert.match(await evaluate('window.__utterances.at(-1).text'), /3，2，1/);
      await evaluate('window.__finishSpeech()');
      await until(() => evaluate("workout.runtime.coach.phase==='REP_GUIDANCE'&&cadenceActive"), 'Coach did not start guidance');
      const target = Number(await evaluate("workout.exercises[0].targetReps.match(/\\d+/)[0]"));
      for (let rep = 1; rep <= target; rep++) {
        await until(() => evaluate(`window.__utterances.at(-1).text==='${rep}'`), 'Missing count ' + rep);
        await evaluate('window.__finishSpeech()');
        if (rep === 1) {
          await until(() => evaluate("voiceState==='listening'"), 'Guidance did not open a listening window');
          await evaluate('recognition.onspeechstart()');
          await new Promise(resolve => setTimeout(resolve, 1600));
          assert.equal(await evaluate('guideRepCount'), 1);
          assert.equal(await evaluate('!!recognition'), true);
          await evaluate('recognition.coachHeard=false');
        }
      }
      await until(() => evaluate("workout.runtime.coach.phase==='SET_COMPLETE'&&window.__utterances.at(-1).text.includes('完成了吗')"), 'Completion confirmation was not requested');
      assert.equal(await evaluate('workout.exercises[0].completedSets'), 0);
      const say = async (text: string) => {
        await evaluate('window.__finishSpeech()');
        await until(() => evaluate("voiceState==='listening'"), 'Automatic listening did not resume');
        await evaluate(`window.__recognizers.at(-1).result(${JSON.stringify(text)})`);
        await until(() => evaluate('!coachBusy&&!actionBusy'), 'Voice event did not finish');
      };
      await say('太重了，还没做完');
      assert.equal(await evaluate('workout.status'), 'exercise_active');
      assert.equal(await evaluate('workout.exercises[0].completedSets'), 0);
      await say('做完了');
      assert.equal(await evaluate('workout.status'), 'set_feedback');
      assert.equal(await evaluate('workout.exercises[0].completedSets'), 0);
      await say('实际六次');
      assert.equal(await evaluate('workout.status'), 'resting');
      assert.equal(await evaluate('workout.exercises[0].completedSets'), 1);
      assert.ok(await evaluate("workout.runtime.events.some(x=>x.type==='coach_adjustment'&&x.details.reason==='too_heavy')"));
      assert.match(await evaluate('window.__utterances.at(-1).text'), /降低/);
      const repeat = await evaluate('window.__actionRequests.at(-1)');
      const replay = await api(`/api/workouts/${started.workout.sessionId}/actions`, repeat);
      assert.equal(replay.stale, true);
      await say('下一组');
      await until(() => evaluate("workout.runtime.coach.phase==='START_SET'"), 'Next set was not prepared');
      await evaluate('window.__finishSpeech();window.__finishSpeech()');
      await until(() => evaluate("workout.runtime.coach.phase==='REP_GUIDANCE'"), 'Next set guidance did not start');
      // Speech can arrive during guidance without turning the guide count into a fact.
      await say('做完了，实际六次，太轻了');
      assert.equal(await evaluate('workout.exercises[0].completedSets'), 2, JSON.stringify(await evaluate("({state:workout.status,phase:workout.runtime.coach,caption:voiceCaption,events:workout.runtime.events.slice(-6),requests:window.__actionRequests.slice(-4),recognition:!!recognition})")));
      assert.match(await evaluate('window.__utterances.at(-1).text'), /增加|已记录反馈/);
      // Complete the remaining prescribed sets entirely through spoken events.
      for (let guard = 0; guard < 30 && await evaluate("!['completed','cooling_down'].includes(workout.status)"); guard++) {
        if (await evaluate("workout.status==='resting'")) {
          await say('下一组');
          await until(() => evaluate("workout.runtime.coach.phase==='START_SET'"), 'Remaining set did not prepare');
          await evaluate('window.__finishSpeech();window.__finishSpeech()');
          await until(() => evaluate("workout.runtime.coach.phase==='REP_GUIDANCE'"), 'Remaining set did not start');
        }
        await say('做完了，实际六次，正好');
      }
      if (await evaluate("workout.status==='cooling_down'")) await say('完成');
      assert.equal(await evaluate('workout.status'), 'completed');
      const history = await api('/api/history?userId=coach-browser');
      assert.ok(history.sessions[0].sets.length >= 2);
      assert.ok(history.sessions[0].sets.every((x: any) => x.actualReps === 6));
      assert.ok(history.sessions[0].sets.every((x: any) => x.actualWeight === undefined));
      await evaluate('home()');
    });
    await t.test("Phase 7A: pain stops narration and voice failure leaves buttons usable", async () => {
      const result = await api('/api/workouts/preview', { input: '今天练20分钟。', userId: 'coach-browser-pain', dataOrigin: 'automated_test' });
      const started = await api(`/api/workouts/${result.workout.sessionId}/actions`, { type: 'start', coach: true });
      await evaluate(`workout=${JSON.stringify(started.workout)};voiceInputTarget='coach';voiceEnabled=true;voicePermissionReady=true;offlineSpeechAvailable=false;render()`, true);
      await until(() => evaluate("workout.runtime.coach.phase==='START_SET'"), 'Pain test did not prepare');
      await evaluate("handleCoachInput('膝盖不舒服')");
      assert.equal(await evaluate('workout.status'), 'paused');
      assert.equal(await evaluate('document.querySelector("#resume").disabled'), true);
      assert.equal(await evaluate('workout.exercises[0].completedSets'), 0);
      await evaluate("handleCoachInput('结束训练')");
      const history = await api('/api/history?userId=coach-browser-pain');
      assert.deepEqual(history.sessions[0].sets, []);
      const retry = await api('/api/workouts/preview', { input: '今天练20分钟。', userId: 'coach-browser-fallback', dataOrigin: 'automated_test' });
      const fallback = await api(`/api/workouts/${retry.workout.sessionId}/actions`, { type: 'start', coach: true });
      await evaluate(`workout=${JSON.stringify(fallback.workout)};voiceInputTarget='coach';voiceEnabled=true;render()`, true);
      await until(() => evaluate("workout.runtime.coach.phase==='START_SET'"), 'Fallback test did not prepare');
      await evaluate("window.__utterances.at(-1).onerror({error:'synthesis-failed'})");
      assert.equal(await evaluate('workout.exercises[0].completedSets'), 0);
      await evaluate("document.querySelector('#done-tap').click()", true);
      await until(() => evaluate("workout.status==='set_feedback'"), 'Fallback completion failed');
      await evaluate("window.__finishSpeech()");
      await until(() => evaluate("voiceState==='listening'"), 'Fallback mic did not start');
      await evaluate("window.__recognizers.at(-1).fail('network')");
      assert.equal(await evaluate("document.querySelector('#submit').disabled"), false);
      await evaluate("document.querySelector('#reps').value='5';document.querySelector('[data-feedback=too_light]').click()", true);
      await until(() => evaluate("workout.status==='resting'"), 'Fallback feedback failed');
      assert.equal(await evaluate('workout.exercises[0].completedSets'), 1);
      await evaluate('home()');
    });
    const mobilePilot = async (name: string) => {
      const result = await api('/api/workouts/preview', { input: '我在 Test Gym，有40分钟，想练背。', userId: name, dataOrigin: 'automated_test' });
      const started = await api(`/api/workouts/${result.workout.sessionId}/actions`, { type: 'start' });
      await evaluate(`home();setWorkout(${JSON.stringify(started.workout)});offlineSpeechAvailable=false;voiceInputTarget='coach';render()`);
      return started.workout;
    };
    await t.test("Phase 7B.1: stale action responses cannot return home to training or overwrite a new session", async t => {
      t.after(async () => { await evaluate('if(window.__beforeDelayedFetch)window.fetch=window.__beforeDelayedFetch;home()'); });
      const original = await mobilePilot('mobile-generation');
      await evaluate(`window.__beforeDelayedFetch=window.fetch;
        window.fetch=(url,options)=>String(url).endsWith('/actions')&&JSON.parse(options?.body||'{}').type==='pause'
          ?new Promise(resolve=>{window.__beforeDelayedFetch(url,options).then(response=>{window.__releaseAction=()=>resolve(response)})})
          :window.__beforeDelayedFetch(url,options);
        window.__pendingAction=action('pause');void 0`);
      await until(() => evaluate('!!window.__releaseAction'), 'Delayed action did not reach the server');
      await evaluate('home();window.__releaseAction();window.__pendingAction');
      assert.equal(await evaluate("document.querySelector('.shell').dataset.screen"), 'home');
      assert.equal(await evaluate('workout.status'), 'exercise_active');
      await evaluate('window.__releaseAction=null;render();window.__pendingAction=action("pause");void 0');
      await until(() => evaluate('!!window.__releaseAction'), 'Second delayed action did not complete');
      const newer = await api('/api/workouts/preview', { input: '今天20分钟。', userId: 'mobile-generation-next', dataOrigin: 'automated_test' });
      await evaluate(`setWorkout(${JSON.stringify(newer.workout)});window.__releaseAction();window.__pendingAction`);
      assert.equal(await evaluate('workout.sessionId'), newer.workout.sessionId);
      assert.notEqual(await evaluate('workout.sessionId'), original.sessionId);
      await evaluate('window.fetch=window.__beforeDelayedFetch;home()');
    });
    await t.test("Phase 7B.1: hidden and pagehide pause once; pageshow waits for explicit resume", async () => {
      const pilot = await mobilePilot('mobile-lifecycle');
      const before = await evaluate('window.__spoken.length');
      await evaluate(`voiceEnabled=true;Object.defineProperty(document,'hidden',{configurable:true,value:true});
        document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('pagehide'));
        lifecyclePausePromise`);
      assert.equal(await evaluate('workout.status'), 'paused');
      assert.equal(await evaluate('voiceEnabled'), false);
      assert.equal(await evaluate('recognition'), null);
      assert.equal(await evaluate('cadenceTimer'), null);
      assert.equal(await evaluate('workout.exercises[0].completedSets'), 0);
      assert.equal(await evaluate('window.__spoken.length'), before);
      assert.equal(await evaluate("workout.runtime.events.filter(x=>x.type==='paused').length"), 1);
      await evaluate(`Object.defineProperty(document,'hidden',{configurable:true,value:false});
        document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('pageshow'));lifecyclePausePromise`);
      assert.equal(await evaluate('workout.status'), 'paused');
      assert.equal(await evaluate('voiceEnabled'), false);
      assert.equal(await evaluate('window.__spoken.length'), before);
      assert.equal(await evaluate("document.querySelector('#resume').disabled"), false);
      await evaluate("document.querySelector('#resume').click()", true);
      await until(() => evaluate("workout.status==='exercise_active'&&!actionBusy&&!lifecycleSuspended"), 'Explicit lifecycle resume failed');
      assert.equal(await evaluate('localStorage.getItem(suspendedSessionKey)'), null);
      const stored = (await api(`/api/workouts/${pilot.sessionId}`)).workout;
      assert.equal(stored.exercises[0].completedSets, 0);
      // Completion may arrive from an already confirmed action while the page was leaving.
      await evaluate("localStorage.setItem(suspendedSessionKey,workout.sessionId);lifecycleSuspended=true;setWorkout({...workout,status:'aborted'});render()");
      assert.equal(await evaluate('lifecycleSuspended'), false);
      assert.equal(await evaluate('localStorage.getItem(suspendedSessionKey)'), null);
      assert.equal(await evaluate("document.querySelector('.shell').dataset.screen"), 'home');
      await evaluate('home();delete document.hidden');
    });
    await t.test("Phase 7B.1: Android microphone denial shows phone help and permits retry", async () => {
      await mobilePilot('mobile-permission');
      await evaluate(`window.__savedGetUserMedia=navigator.mediaDevices.getUserMedia;
        window.__permissionContext=window.AudioContext;
        window.AudioContext=class{sampleRate=16000;destination={};async resume(){}close(){}
          createMediaStreamSource(){return{connect(){},disconnect(){}}}
          createScriptProcessor(){return{connect(){},disconnect(){}}}};
        Object.defineProperty(navigator,'userAgent',{configurable:true,value:'Mozilla/5.0 (Linux; Android 15; OPPO Reno 14) Chrome/140.0 Mobile'});
        navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('denied','NotAllowedError')};
        offlineSpeechAvailable=true;voiceEnabled=true;listenOffline()`);
      assert.equal(await evaluate('voiceState'), 'permission_denied');
      assert.equal(await evaluate('voiceEnabled'), false);
      assert.equal(await evaluate('voicePermissionReady'), false);
      assert.equal(await evaluate("document.querySelector('#microphone-help').textContent.includes('Windows')"), false);
      assert.match(await evaluate('voiceCaption'), /网站权限.*系统应用麦克风权限/);
      await evaluate(`navigator.mediaDevices.getUserMedia=async()=>({getTracks:()=>[{stop(){}}]});
        document.querySelector('[data-microphone-action=retry]').click()`, true);
      await until(() => evaluate("voiceState==='listening'&&!!offlineRecorder"), 'Microphone retry did not open capture');
      assert.equal(await evaluate('voiceEnabled'), true);
      assert.equal(await evaluate('voicePermissionReady'), true);
      assert.equal(await evaluate("document.querySelector('#microphone-help')"), null);
      await evaluate('home();navigator.mediaDevices.getUserMedia=window.__savedGetUserMedia;window.AudioContext=window.__permissionContext;delete navigator.userAgent;offlineSpeechAvailable=false');
    });
    await t.test("Phase 7B.1: repeated Web Speech silence keeps automatic listening enabled", async () => {
      await mobilePilot('mobile-webspeech-silence');
      await evaluate('speech.stop();voiceEnabled=true;voicePermissionReady=true;listen()');
      for (let round = 0; round < 6; round++) {
        await until(() => evaluate('!!recognition'), 'Silence stopped the recognition loop');
        await evaluate("recognition.fail('no-speech')");
        assert.equal(await evaluate('voiceEnabled'), true);
        assert.notEqual(await evaluate('voiceState'), 'error');
      }
      await until(() => evaluate('!!recognition'), 'Listening did not resume after repeated silence');
      await evaluate('home()');
    });
    if (process.env.TRAINMIND_SCREENSHOTS) {
      for (const [name, expression, width, height] of [
        ["feedback", "workout.status='set_feedback';render()", 320, 568], ["home", "home()", 390, 844],
        ["plan", "workout.status='preview'; render()", 390, 844],
        ["rest", "workout.status='resting';coachHistory=[];render()", 390, 844],
        ["training", "workout.status='exercise_active'; render(); stopCadence()", 390, 844],
        ["training-small", "render();stopCadence()", 320, 568]
      ] as const) {
        await page.call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: true });
        await evaluate(expression);
        await evaluate("window.scrollTo(0,0);document.querySelector('#app').scrollTop=0");
        const screenshot = await page.call("Page.captureScreenshot", { captureBeyondViewport: false });
        await writeFile(join(process.env.TRAINMIND_SCREENSHOTS, `${name}.png`), Buffer.from(screenshot.data, "base64"));
      }
    }
  } finally {
    page?.close();
    if (browser) { await browser.call("Browser.close").catch(() => {}); browser.close(); }
    if (chrome.exitCode === null) chrome.kill();
    server.kill();
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
});

test("7B.2.2 mic recovery: aborted first session retries once; silent hang watchdog errors visibly", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const start = html.indexOf("function listen(automatic");
  const source = html.slice(start, html.indexOf("function spokenNumber(", start));
  assert.ok(source.includes("e.error==='aborted'") && source.includes("start_timeout"), "fix markers present");

  const build = (script: string) => {
    const timers: Array<() => void> = [];
    const asrCalls: string[] = [];
    const recs: any[] = [];
    class FakeRecognition {
      lang = ""; interimResults = false; maxAlternatives = 1;
      onstart: (() => void) | null = null; onresult: any = null; onerror: any = null; onend: any = null;
      aborted = false;
      start() { recs.push(this); script.split("|").forEach(step => {
        if (step === "abort0" && recs[0] === this) queueMicrotask(() => this.onerror?.({ error: "aborted" }));
        if (step === "hang") { /* 静默挂起:不触发任何事件 */ }
        if (step === "start1" && recs[1] === this) this.onstart?.();
      }); }
      abort() { this.aborted = true; }
    }
    const sandbox: any = {
      document: { hidden: false }, lifecycleSuspended: false, recognition: null,
      offlineSpeechAvailable: false, SpeechRecognitionApi: FakeRecognition,
      voiceEnabled: true, voiceInputTarget: "coach", voiceToken: 0, voiceState: "", voiceCaption: "",
      listenRetries: 0, localRecognitionReady: false, coachBusy: false, workout: null,
      stopCadence() {}, speech: { stop() {} }, scheduleAutoListen() {}, voiceUI() {},
      voiceLog() {}, asrRetryTelemetry(code: string) { asrCalls.push(code); },
      microphoneFailure(error: Error) { throw error; },
      handleCoachInput() {}, DOMException, Promise,
      setTimeout(fn: () => void) { timers.push(fn); return timers.length; }, clearTimeout() {},
    };
    return { sandbox, timers, asrCalls, recs };
  };

  // 场景1:授权后首个会话被 abort → 静默重试一次,第二个会话正常 onstart
  const a = build("abort0|start1");
  vm.createContext(a.sandbox); vm.runInContext(source, a.sandbox);
  a.sandbox.listen(false);
  await new Promise(resolve => queueMicrotask(resolve)); // aborted 处理器是 async
  assert.equal(a.recs.length, 2, "aborted 首会话必须重试一次");
  assert.equal(a.sandbox.voiceState, "listening", "第二会话应进入 listening");
  assert.equal(a.sandbox.recognition, a.recs[1]);

  // 场景2:完全静默挂起 → 看门狗重试一次 → 再挂起 → 可见错误 + 遥测
  const b = build("hang");
  vm.createContext(b.sandbox); vm.runInContext(source, b.sandbox);
  b.sandbox.listen(false);
  assert.equal(b.recs.length, 1);
  b.timers[0]!(); // 第一会话看门狗 5s:中止并重试
  assert.equal(b.recs.length, 2, "看门狗应创建第二会话");
  assert.equal(b.recs[0].aborted, true, "挂起的会话必须被 abort");
  b.timers[1]!(); // 第二会话仍挂起:报错
  assert.equal(b.sandbox.voiceState, "error");
  assert.match(b.sandbox.voiceCaption, /麦克风启动超时/);
  assert.deepEqual(b.asrCalls, ["start_timeout"]);
  assert.equal(b.sandbox.recognition, null);

  // 场景3:真实识别错误(非 abort)不重试,直接给出可见信息
  const c = build((["err0", ""] as any));
  (c as any).recs; // 预留
  const cSandbox = (() => {
    const recs2: any[] = [];
    class F2 { onerror: any = null; onstart: any = null; lang = ""; interimResults = false; maxAlternatives = 1;
      start() { recs2.push(this); queueMicrotask(() => this.onerror?.({ error: "audio-capture" })); } abort() {} }
    const timers2: Array<() => void> = []; const asr2: string[] = [];
    return { sandbox: { document: { hidden: false }, lifecycleSuspended: false, recognition: null, offlineSpeechAvailable: false,
      SpeechRecognitionApi: F2, voiceEnabled: true, voiceInputTarget: "coach", voiceToken: 0, voiceState: "", voiceCaption: "",
      listenRetries: 0, localRecognitionReady: false, coachBusy: false, workout: null,
      stopCadence() {}, speech: { stop() {} }, scheduleAutoListen() {}, voiceUI() {}, voiceLog() {},
      asrRetryTelemetry(code: string) { asr2.push(code); }, microphoneFailure(error: Error) { throw error; },
      handleCoachInput() {}, DOMException, Promise, setTimeout(fn: () => void) { timers2.push(fn); return 1; }, clearTimeout() {} },
      asr2 };
  })();
  vm.createContext(cSandbox.sandbox); vm.runInContext(source, cSandbox.sandbox);
  cSandbox.sandbox.listen(false);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(cSandbox.sandbox.voiceState, "error");
  assert.match(cSandbox.sandbox.voiceCaption, /没有获取到麦克风声音/);
  assert.deepEqual(cSandbox.asr2, ["audio-capture"]);
});

test("hands-free: 计划页可语音开练,且训练全程保持监听(D17: 手不离开器械)", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.ok(html.includes("'preview','exercise_active','set_feedback','resting','paused','cooling_down','completed'"),
    "训练相关状态(含计划页)必须保持语音开启");
  assert.match(html, /workout\?\.status==='preview'\)\{[\s\S]{0,220}开始/, "计划页要有语音『开始』分支");
  assert.ok(html.includes("再说一遍"), "要有『再说一遍』重听,避免让人看屏幕");
  assert.ok(html.includes("结束训练|停止训练"), "结束训练要能纯语音");
});
