// 规格 §9.2 — 计数器:由 InteractionEvent 流派生全部 summary 字段
import test from "node:test";
import assert from "node:assert/strict";
import { freshDb, setupSession, interaction } from "./helpers.ts";

test("summary 计数器全字段派生(voice/touch/system/interruption)", () => {
  const t = freshDb();
  try {
    const { recorder, sessionId } = setupSession(t, 1000);
    const r = recorder;

    // voice 命令:2 条成功,1 条失败(不计)
    r.recordInteraction(interaction(sessionId, { action: "voice.command.feedback.easy", success: true, occurredAt: 2000 }));
    r.recordInteraction(interaction(sessionId, { action: "voice.command.substitute", success: true, occurredAt: 3000 }));
    r.recordInteraction(interaction(sessionId, { action: "voice.command.skip", success: false, occurredAt: 4000 }));
    // 澄清与 ASR 重试
    r.recordInteraction(interaction(sessionId, { actor: "ai", modality: "voice", action: "voice.clarification.request", runtimeState: "post_set", occurredAt: 5000 }));
    r.recordInteraction(interaction(sessionId, { actor: "system", modality: "voice", action: "voice.asr_retry", runtimeState: "post_set", occurredAt: 6000 }));
    r.recordInteraction(interaction(sessionId, { actor: "system", modality: "voice", action: "voice.asr_retry", runtimeState: "post_set", occurredAt: 6500 }));
    // touch:两个 episode(0→12s 连续段,30s 孤立)
    r.recordInteraction(interaction(sessionId, { modality: "touch", action: "touch.button.pause", runtimeState: "resting", occurredAt: 10000 }));
    r.recordInteraction(interaction(sessionId, { modality: "touch", action: "touch.button.resume", runtimeState: "paused", occurredAt: 12000 }));
    r.recordInteraction(interaction(sessionId, { modality: "touch", action: "touch.button.skip_rest", runtimeState: "resting", occurredAt: 30000 }));
    // 正常系统流转(不计入任何计数)
    r.recordInteraction(interaction(sessionId, { actor: "system", modality: "system", action: "system.autostart.next_set", runtimeState: "transition", occurredAt: 15000 }));
    // interruption:voice + ui
    r.recordInteraction(interaction(sessionId, { actor: "system", modality: "system", action: "system.interruption.voice", runtimeState: "resting", occurredAt: 7000 }));
    r.recordInteraction(interaction(sessionId, { actor: "system", modality: "system", action: "system.interruption.ui", runtimeState: "pre_set", occurredAt: 8000 }));

    const s = r.computeSummary(sessionId);
    assert.equal(s.voiceCommandCount, 2);
    assert.equal(s.voiceClarificationCount, 1);
    assert.equal(s.voiceAsrRetryCount, 2);
    assert.equal(s.voiceRetryCount, 3); // clarification + asrRetry
    assert.equal(s.manualActionCount, 3);
    assert.equal(s.manualInteractionEpisodeCount, 2);
    assert.equal(s.runtimeInterruptionCount, 2);
    assert.deepEqual(s.runtimeInterruptionsByCategory, { ui: 1, voice: 1, error: 0, safety: 0 });
    assert.equal(s.sessionDurationMs, null); // 尚未结束
  } finally { t.cleanup(); }
});

test("sessionDurationMs:会话结束后 = endedAt - startedAt", () => {
  const t = freshDb();
  try {
    const { store, recorder, sessionId } = setupSession(t, 1000);
    store.completeSession(sessionId, "completed", 61_000);
    assert.equal(recorder.computeSummary(sessionId).sessionDurationMs, 60_000);
  } finally { t.cleanup(); }
});

test("空会话 summary 全零计数", () => {
  const t = freshDb();
  try {
    const { recorder, sessionId } = setupSession(t);
    const s = recorder.computeSummary(sessionId);
    assert.equal(s.manualActionCount, 0);
    assert.equal(s.manualInteractionEpisodeCount, 0);
    assert.equal(s.voiceCommandCount, 0);
    assert.equal(s.voiceRetryCount, 0);
    assert.equal(s.runtimeInterruptionCount, 0);
  } finally { t.cleanup(); }
});
