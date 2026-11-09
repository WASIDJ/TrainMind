// 规格 §9.3 — 链路完整性:断链 / applied 不一致 / 未 applied 可被校验器发现
import test from "node:test";
import assert from "node:assert/strict";
import { freshDb, setupSession, interaction } from "./helpers.ts";
import { validateSessionChain } from "../../src/telemetry/validate.ts";

test("完整链路 → 无 issue", () => {
  const t = freshDb();
  try {
    const { store, recorder, sessionId } = setupSession(t);
    const ex = store.createExerciseInstance({ sessionId, exerciseId: "barbell-squat", orderIndex: 0, trackingMetric: "reps" });
    const set = store.createSetRecord({ exerciseInstanceId: ex.id, setNumber: 1, status: "completed", targetWeightKg: 80 });
    const cmd = recorder.recordInteraction(interaction(sessionId, { action: "voice.command.feedback.hard", success: true, targetSetRecordId: set.id, occurredAt: 98_000 }));
    recorder.recordSetFeedback({ setRecordId: set.id, difficulty: "hard", fatigue: null, pain: null, source: "voice", transcript: "有点重", interactionEventId: cmd.id, capturedAt: 98_900 });
    const ad = recorder.recordAdaptation({
      sessionId, occurredAt: 99_000, exerciseInstanceId: ex.id, setRecordId: null,
      type: "weight_change", deltas: [{ field: "weightKg", before: 80, after: 75 }],
      triggeredBy: { modality: "voice", interactionEventId: cmd.id, actor: "user" },
      reason: { code: "user_reported_too_hard", text: "用户反馈偏重,下一组降 5kg" },
      evidenceRefs: ["ev-rpe-1"], applied: false, appliedAt: null,
    });
    recorder.markApplied(ad.id, 99_200);
    store.completeSession(sessionId, "completed", 800_000);
    assert.deepEqual(validateSessionChain(t.db, sessionId), []);
  } finally { t.cleanup(); }
});

test("adaptation 引用不存在的交互 → missing_interaction_ref", () => {
  const t = freshDb();
  try {
    const { store, recorder, sessionId } = setupSession(t);
    recorder.recordAdaptation({
      sessionId, occurredAt: 1_000, exerciseInstanceId: null, setRecordId: null,
      type: "weight_change", deltas: [{ field: "weightKg", before: 80, after: 75 }],
      triggeredBy: { modality: "voice", interactionEventId: "01AAAAAAAAAAAAAAAAAAAAAAAAAA", actor: "user" },
      reason: { code: "user_reported_too_hard", text: null }, evidenceRefs: [], applied: true, appliedAt: 1_100,
    });
    store.completeSession(sessionId, "completed", 2_000);
    const issues = validateSessionChain(t.db, sessionId);
    assert.ok(issues.some(i => i.kind === "missing_interaction_ref"));
  } finally { t.cleanup(); }
});

test("会话已结束而调整未 applied → unapplied_adaptation", () => {
  const t = freshDb();
  try {
    const { store, recorder, sessionId } = setupSession(t);
    const cmd = recorder.recordInteraction(interaction(sessionId, { action: "voice.command.feedback.hard", success: true, occurredAt: 1_000 }));
    recorder.recordAdaptation({
      sessionId, occurredAt: 1_100, exerciseInstanceId: null, setRecordId: null,
      type: "weight_change", deltas: [{ field: "weightKg", before: 80, after: 75 }],
      triggeredBy: { modality: "voice", interactionEventId: cmd.id, actor: "user" },
      reason: { code: "user_reported_too_hard", text: null }, evidenceRefs: [], applied: false, appliedAt: null,
    });
    store.completeSession(sessionId, "completed", 2_000);
    const issues = validateSessionChain(t.db, sessionId);
    assert.ok(issues.some(i => i.kind === "unapplied_adaptation"));
  } finally { t.cleanup(); }
});

test("applied=false 但 applied_at 有值 → applied_inconsistent", () => {
  const t = freshDb();
  try {
    const { store, recorder, sessionId } = setupSession(t);
    const cmd = recorder.recordInteraction(interaction(sessionId, { action: "voice.command.feedback.hard", success: true, occurredAt: 1_000 }));
    const ad = recorder.recordAdaptation({
      sessionId, occurredAt: 1_100, exerciseInstanceId: null, setRecordId: null,
      type: "weight_change", deltas: [{ field: "weightKg", before: 80, after: 75 }],
      triggeredBy: { modality: "voice", interactionEventId: cmd.id, actor: "user" },
      reason: { code: "user_reported_too_hard", text: null }, evidenceRefs: [], applied: false, appliedAt: null,
    });
    recorder.markApplied(ad.id, 1_200);
    // 模拟数据损坏:applied 置回 0 但 applied_at 残留
    t.db.prepare("UPDATE adaptation_events SET applied = 0 WHERE id = ?").run(ad.id);
    const issues = validateSessionChain(t.db, sessionId);
    assert.ok(issues.some(i => i.kind === "applied_inconsistent"));
  } finally { t.cleanup(); }
});

test("seq 空洞(事件丢失)→ seq_gap", () => {
  const t = freshDb();
  try {
    const { recorder, sessionId } = setupSession(t);
    recorder.recordInteraction(interaction(sessionId, { occurredAt: 1_000 }));
    recorder.recordInteraction(interaction(sessionId, { occurredAt: 2_000 }));
    recorder.recordInteraction(interaction(sessionId, { occurredAt: 3_000 }));
    // 删除中间一条无引用的事件,制造空洞(seq 1 与 3 仍在)
    t.db.prepare("DELETE FROM interaction_events WHERE session_id = ? AND seq = 2").run(sessionId);
    const issues = validateSessionChain(t.db, sessionId);
    assert.ok(issues.some(i => i.kind === "seq_gap"));
  } finally { t.cleanup(); }
});
