// Phase 7B.2 验收:遥测接线 HTTP E2E —— 走真实 server.ts /actions API,断言 v2 事件链
// 场景覆盖:plan 触点 / start / 语音反馈+剂量调整 / 按钮反馈+目标快照 / auto rest /
//           C1 动作替换 / C2 时间压缩 / GAP-1 疼痛 Safety Gate / 语音结束 / 链路校验
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { validateSessionChain, deriveSummary } from "../../src/telemetry/index.ts";

const freePort = () => new Promise<number>(resolve => { const server = createServer(); server.listen(0, "127.0.0.1", () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); }); });
const until = async (check: () => Promise<boolean> | boolean, message: string, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(message);
};

async function bindAction(origin: string, path: string, payload: any) {
  if (!payload || !path.endsWith("/actions") || payload.context) return payload;
  const { workout: w } = await fetch(origin + path.slice(0, -8)).then(r => r.json());
  return { ...payload, context: { sessionId: w.sessionId, exerciseId: w.exercises[w.runtime.currentExerciseIndex]?.exerciseId ?? null,
    setNumber: w.runtime.currentSetNumber, coachPhase: w.runtime.coach?.phase ?? null, status: w.status, eventCount: w.runtime.events.length } };
}

test("7B.2 e2e: full voice+touch workout writes a coherent v2 telemetry chain", { timeout: 90000 }, async () => {
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const directory = await mkdtemp(join(tmpdir(), "trainmind-7b2-")), databasePath = join(directory, "test.db");
  const server = spawn(process.execPath, ["src/server.ts"], { cwd: new URL("../..", import.meta.url), env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", TRAINMIND_DB: databasePath, TRAINMIND_CHAT_BASE_URL: "", TRAINMIND_CHAT_MODEL: "", TRAINMIND_CHAT_API_KEY: "", TRAINMIND_CHAT_PROTOCOL: "openai", TRAINMIND_STT: "off", TRAINMIND_STT_SIDECAR: "http://127.0.0.1:1" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; server.stdout!.on("data", data => output += data); server.stderr!.on("data", data => output += data);
  const api = async (path: string, body?: any) => {
    body = await bindAction(origin, path, body);
    const response = await fetch(origin + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json() as any;
    assert.ok(response.status >= 200 && response.status < 300, `${path}: ${response.status} ${data.error ?? ""}`);
    return data;
  };
  const action = (sessionId: string, payload: any) => api(`/api/workouts/${sessionId}/actions`, payload);
  try {
    await until(() => output.includes("TrainMind running"), "server did not start: " + output);

    // ---- 场景:S0 计划与启动 ----
    const plan = (await api("/api/workouts/preview", { userId: "e2e-user", input: "我在 Test Gym，有40分钟，想练背。" })).workout;
    await action(plan.sessionId, { type: "plan_move", index: 0, direction: 1 });           // touch.button.plan_move (pre_workout)
    const started = (await action(plan.sessionId, { type: "start", coach: true })).workout; // touch.button.start
    assert.equal(started.status, "exercise_active");
    await action(plan.sessionId, { type: "coach_event", event: { type: "start_set" } });   // 叙事流标记,不记录

    // ---- S1 语音反馈(7B.2.1 P0:自然表达"有点重"直接识别,不追问)→ record + 剂量 ----
    const feedback1 = await action(plan.sessionId, { type: "coach_message", message: "有点重，做完了，实际8次，用了30公斤", source: "voice" });
    assert.ok(feedback1.setRecord, "voice report should save a set record");
    assert.equal(feedback1.workout.status, "resting");
    assert.equal(feedback1.directive.action, "agency_offer", "D14: hard feedback offers agency choices");
    // D14:学员语音选择"听你的" → accept_cut,剂量落地(weight_change #1)
    const choice1 = await action(plan.sessionId, { type: "coach_message", message: "听你的", source: "voice" });
    assert.equal(choice1.directive.action, "speak");

    // ---- S2 按钮 rest 完成(未标注 source,restEndsAt 已清除 → touch)----
    const afterRest = (await action(plan.sessionId, { type: "rest_complete" })).workout;
    assert.equal(afterRest.status, "exercise_active");

    // ---- S3 按钮 complete_set + feedback_hard → set2 目标快照应低于 set1 ----
    await action(plan.sessionId, { type: "complete_set" });
    const feedback2 = await action(plan.sessionId, { type: "feedback", feedback: "hard", actualReps: 6, actualWeight: 25 });
    assert.ok(feedback2.setRecord);
    assert.equal(feedback2.workout.status, "resting");
    // D14 注:S3 是该动作最后一组(无下一组可调)→ 不触发 agency,走"已记录,下次参考"路径(与原语义一致)

    // ---- S4 定时器到点 rest(前端 timer 路径 → source:auto)----
    const afterAutoRest = (await action(plan.sessionId, { type: "rest_complete", source: "auto" })).workout;
    assert.equal(afterAutoRest.status, "exercise_active");

    // ---- S4b 浏览器 ASR 失败上报(7B.2.1 W6:SpeechRecognition onerror → voice.asr_retry)----
    const asrReport = await api("/api/voice/asr_retry", { userId: "e2e-user", reason: "no-speech" });
    assert.equal(asrReport.ok, true);

    // ---- S5 C1:器械占用口令 → 替换或跳过 ----
    const substitute = await action(plan.sessionId, { type: "coach_message", message: "器械有人，换一个", source: "voice" });
    assert.equal(substitute.directive.action, "speak");
    const replaced = substitute.workout.runtime.events.some((x: any) => x.type === "exercise_replaced");
    const skippedOut = substitute.workout.runtime.events.some((x: any) => x.type === "exercise_skipped");
    assert.ok(replaced || skippedOut, "C1 must replace or skip");
    assert.equal(substitute.workout.status, "exercise_active");

    // ---- S6 C2:只剩10分钟 ----
    const shortened = await action(plan.sessionId, { type: "coach_message", message: "只剩10分钟", source: "voice" });
    assert.equal(shortened.directive.action, "speak");
    const shortenEvent = shortened.workout.runtime.events.find((x: any) => x.type === "workout_shortened");
    assert.ok(shortenEvent, "workout_shortened event");
    const shortenDetails = shortenEvent.details as { projectedRemainingSeconds: number; budgetSeconds: number };
    assert.ok(shortenDetails.projectedRemainingSeconds <= shortenDetails.budgetSeconds,
      `predicted remaining ${shortenDetails.projectedRemainingSeconds}s must be within the user's ${shortenDetails.budgetSeconds}s budget`);

    // ---- S7 GAP-1:疼痛 → Safety Gate(会话进入终态轨道)----
    const pain = await action(plan.sessionId, { type: "coach_message", message: "膝盖疼", source: "voice" });
    assert.equal(pain.workout.status, "paused");
    assert.equal(pain.workout.runtime.coach.safetyStopped, true);

    // ---- S8 语音结束训练 ----
    const aborted = await action(plan.sessionId, { type: "abort", source: "voice" });
    assert.equal(aborted.workout.status, "aborted");

    // ================= DB 断言(服务端已 COMMIT)=================
    assert.ok(!output.includes("telemetryError"), "server logged telemetry errors:\n" + output.match(/telemetryError[^\n]*/g)?.join("\n"));
    const db = new DatabaseSync(databasePath, { readOnly: true });
    const sessionId = plan.sessionId;
    const interactions = db.prepare("SELECT seq, actor, modality, action, runtime_state, success, transcript FROM interaction_events WHERE session_id = ? ORDER BY seq").all(sessionId) as any[];
    const adaptations = db.prepare("SELECT seq, type, reason_json, deltas_json, applied FROM adaptation_events WHERE session_id = ? ORDER BY seq").all(sessionId) as any[];

    // 动作序列(规格 §4 词表 + 7B.2 裁决增补)
    assert.deepEqual(interactions.map(x => x.action), [
      "touch.button.plan_move",      // S0 计划编辑(pre_workout)
      "touch.button.start",          // S0 启动
      "voice.command.adjust",        // S1 语音完成+反馈(user_report completed=true)
      "voice.command.agency",        // S1b D14:语音选择"听你的"(agency accept_cut)→剂量落地
      "touch.button.skip_rest",      // S2 按钮 rest
      "touch.button.complete_set",   // S3 按钮 complete
      "touch.button.feedback_hard",  // S3 按钮反馈
      "system.autostart.rest_end",   // S4 定时器 rest
      "system.autostart.agency_default", // S4 D16-B:末组吃力的跨动作 offer 到期默认(下一动作降一档)
      "voice.asr_retry",             // S4b 浏览器 ASR 失败(system actor / voice modality / success=false)
      "voice.command.substitute",    // S5 C1
      "voice.command.time_constraint", // S6 C2
      "voice.command.pain_report",   // S7 GAP-1
      "system.safety.trigger",       // S7 Safety Gate 系统信号
      "voice.command.finish",        // S8 语音结束
    ]);
    const asrRow = interactions.find(x => x.action === "voice.asr_retry")!;
    assert.equal(asrRow.actor, "system"); assert.equal(asrRow.modality, "voice"); assert.equal(asrRow.success, 0);
    for (const row of interactions) {
      if (row.action.startsWith("voice.command.")) { assert.equal(row.actor, "user"); assert.equal(row.modality, "voice"); assert.equal(row.success, 1); }
      if (row.action.startsWith("touch.button.")) { assert.equal(row.actor, "user"); assert.equal(row.modality, "touch"); }
      if (row.action.startsWith("system.")) { assert.equal(row.actor, "system"); assert.equal(row.modality, "system"); }
    }
    assert.equal(interactions[0]!.runtime_state, "pre_workout");
    assert.ok(interactions[12]!.transcript.includes("膝盖"), "pain transcript preserved");
    assert.ok(interactions[11]!.transcript.includes("10"), "time constraint transcript preserved");

    // 调整链(D16-B 后):weight_change(S1b 语音选择 accept_cut)+ rep_change(S4 跨动作 offer 到期默认 next_down:下一动作重量档耗尽→次数回退)
    // + exercise_substitution|exercise_skip + workout_shorten + safety_stop,全部 applied
    const types = adaptations.map(x => x.type);
    assert.deepEqual(types, ["weight_change", "rep_change", replaced ? "exercise_substitution" : "exercise_skip", "workout_shorten", "safety_stop"]);
    assert.ok(adaptations.every(x => x.applied === 1));
    // D16-B:dose1=语音选择 accept_cut(基准=报告实重);dose2=跨动作到期默认(下一动作次数回退)
    const dose1 = JSON.parse(adaptations[0]!.deltas_json)[0], dose2 = JSON.parse(adaptations[1]!.deltas_json)[0];
    assert.equal(dose1.field, "weightKg"); assert.ok(dose1.after < dose1.before, `dose1 ${JSON.stringify(dose1)}`);
    assert.equal(dose2.field, "repsMin"); assert.ok(dose2.after < dose2.before, `dose2 ${JSON.stringify(dose2)}`);
    assert.equal(JSON.parse(adaptations[2]!.reason_json).code, replaced ? "equipment_unavailable" : "equipment_unavailable");
    assert.equal(JSON.parse(adaptations[3]!.reason_json).code, "time_constraint");
    assert.equal(JSON.parse(adaptations[4]!.reason_json).code, "pain_reported");

    // v2 SetRecord:两行 completed + 疼痛 failed 行;目标快照随剂量递减;set1 rest 回填非空
    const sets = db.prepare(
      `SELECT sr.set_number, sr.target_weight_kg, sr.actual_reps, sr.status, sr.actual_rest_after_seconds, ei.order_index
       FROM set_records sr JOIN exercise_instances ei ON ei.id = sr.exercise_instance_id
       WHERE ei.session_id = ? ORDER BY sr.completed_at`).all(sessionId) as any[];
    assert.equal(sets.filter(x => x.status === "completed").length, 2);
    const painRow = sets.find(x => x.status === "failed");
    assert.ok(painRow, "pain must leave a failed v2 set row");
    const completedRows = sets.filter(x => x.status === "completed");
    assert.ok(completedRows[0]!.target_weight_kg > completedRows[1]!.target_weight_kg, "set2 target snapshot must reflect applied -10% dose");
    assert.equal(completedRows[0]!.actual_reps, 8);
    assert.equal(completedRows[1]!.actual_reps, 6);
    assert.ok(completedRows[0]!.actual_rest_after_seconds !== null && completedRows[0]!.actual_rest_after_seconds >= 0, "set1 rest backfilled at set2 upsert");
    assert.equal(completedRows[1]!.actual_rest_after_seconds, null, "last completed set keeps rest=null until a later set exists");

    // SetFeedback:难度 ×2(voice→touch)+ 疼痛(severity 3 + 位置 knee)
    const feedbackRows = db.prepare(
      `SELECT sf.difficulty, sf.source, sf.transcript, sf.pain_json, sr.status
       FROM set_feedbacks sf JOIN set_records sr ON sr.id = sf.set_record_id
       JOIN exercise_instances ei ON ei.id = sr.exercise_instance_id WHERE ei.session_id = ?`).all(sessionId) as any[];
    assert.equal(feedbackRows.length, 3);
    assert.equal(feedbackRows.filter(x => x.difficulty === "hard").length, 2);
    assert.equal(feedbackRows[0]!.source, "voice"); assert.ok(feedbackRows[0]!.transcript.includes("有点重"), "自然表达原文保留");
    assert.equal(feedbackRows[1]!.source, "touch");
    const painFeedback = feedbackRows.find(x => x.pain_json !== null)!;
    assert.deepEqual(JSON.parse(painFeedback.pain_json), { severity: 3, location: "knee" });
    assert.equal(painFeedback.source, "voice");

    // 实例:保留动作各一实例(非 substituted/skipped);被 workout_shorten 丢弃的实例全部 skipped
    const instances = db.prepare("SELECT order_index, exercise_id, status FROM exercise_instances WHERE session_id = ? ORDER BY order_index, id").all(sessionId) as any[];
    const activeInstances = instances.filter(x => x.status !== "substituted" && x.status !== "skipped");
    assert.equal(activeInstances.length, aborted.workout.exercises.length, "one live instance per kept exercise");
    const droppedInstances = instances.filter(x => x.order_index >= aborted.workout.exercises.length);
    assert.ok(droppedInstances.length >= 1, "shorten must have dropped exercises");
    assert.ok(droppedInstances.every(x => x.status === "skipped"), `dropped instances must be skipped, got ${JSON.stringify(droppedInstances)}`);
    if (replaced) {
      const substituted = instances.filter(x => x.status === "substituted");
      assert.equal(substituted.length, 1);
      assert.equal(instances.filter(x => x.status === "in_progress").length, 1);
    }

    // 链路校验 + 摘要计数(规格 §5)
    assert.deepEqual(validateSessionChain(db, sessionId), []);
    const summary = deriveSummary(db, sessionId);
    assert.equal(summary.manualActionCount, 5);       // plan_move + start + skip_rest + complete_set + feedback_hard
    assert.equal(summary.voiceCommandCount, 6);       // adjust + agency(听你的,D14) + substitute + time_constraint + pain_report + finish
    assert.equal(summary.voiceAsrRetryCount, 1);
    assert.equal(summary.voiceRetryCount, 1);
    assert.equal(summary.runtimeInterruptionCount, 0);
    assert.ok(summary.sessionDurationMs !== null && summary.sessionDurationMs > 0, "duration resolved via data_json fallback");
    db.close();

    // ---- TTS 未配置 → 503(前端将自动回退本地 speechSynthesis)----
    const ttsResponse = await fetch(origin + "/api/voice/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "测试" }) });
    assert.equal(ttsResponse.status, 503);

    // ---- ASR 重试端点(非 Windows 无本地引擎 → 503,不得产生 asr_retry)----
    if (process.platform !== "win32") {
      const garbage = Buffer.from("not a wav at all");
      const response = await fetch(`${origin}/api/voice/transcribe?userId=e2e-user`, { method: "POST", headers: { "content-type": "audio/wav" }, body: garbage });
      assert.equal(response.status, 503);
      const check = new DatabaseSync(databasePath, { readOnly: true });
      assert.equal((check.prepare("SELECT COUNT(*) AS n FROM interaction_events WHERE action = 'voice.asr_retry'").get() as { n: number }).n, 1,
        "服务端引擎 503 不得新增 asr_retry(现有 1 条来自 S4b 浏览器上报)");
      check.close();
    }
  } finally {
    if (server.exitCode === null) { const closed = new Promise(resolve => server.once("exit", resolve)); server.kill(); await closed; }
    await rm(directory, { recursive: true, force: true });
  }
});
