// 规格 §9.7 — SetFeedback 唯一性:每组 0..1 条已接受反馈;重试过程留在 InteractionEvent
// H2(2026-11-06 全仓审查)后契约更新:同组"更正"是合法流(组后补一句太重了→再改口),
// 二次写入从"被拒"改为"末次接受为准"(INSERT OR REPLACE),不变量仍是每组 ≤1 行。
import test from "node:test";
import assert from "node:assert/strict";
import { freshDb, setupSession, interaction } from "./helpers.ts";

test("同一 set 二次 recordSetFeedback 覆盖为末次接受(仍 ≤1 行,§9.7 不变量保持)", () => {
  const t = freshDb();
  try {
    const { store, recorder, sessionId } = setupSession(t);
    const ex = store.createExerciseInstance({ sessionId, exerciseId: "barbell-squat", orderIndex: 0, trackingMetric: "reps" });
    const set = store.createSetRecord({ exerciseInstanceId: ex.id, setNumber: 1, status: "completed", targetWeightKg: 80 });
    const cmd = recorder.recordInteraction(interaction(sessionId, { action: "voice.command.feedback.hard", success: true, transcript: "有点重", targetSetRecordId: set.id }));
    recorder.recordSetFeedback({ setRecordId: set.id, difficulty: "hard", fatigue: null, pain: null, source: "voice", transcript: "有点重", interactionEventId: cmd.id, capturedAt: 98_900 });
    // 组后更正:不抛错,覆盖该组的已接受反馈
    recorder.recordSetFeedback({ setRecordId: set.id, difficulty: "easy", fatigue: null, pain: null, source: "touch", transcript: null, interactionEventId: null, capturedAt: 99_000 });
    assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM set_feedbacks WHERE set_record_id = ?").get(set.id).n, 1);
    const row = t.db.prepare("SELECT difficulty, source FROM set_feedbacks WHERE set_record_id = ?").get(set.id) as { difficulty: string; source: string };
    assert.equal(row.difficulty, "easy", "末次接受为准");
    assert.equal(row.source, "touch");
  } finally { t.cleanup(); }
});

test("ASR 重试场景:重试过程全在 InteractionEvent,最终只落一条 SetFeedback", () => {
  const t = freshDb();
  try {
    const { store, recorder, sessionId } = setupSession(t);
    const ex = store.createExerciseInstance({ sessionId, exerciseId: "barbell-squat", orderIndex: 0, trackingMetric: "reps" });
    const set = store.createSetRecord({ exerciseInstanceId: ex.id, setNumber: 2, status: "completed", targetWeightKg: 75 });
    // 第一次尝试:识别失败 → asr_retry(system)
    recorder.recordInteraction(interaction(sessionId, { actor: "system", modality: "voice", action: "voice.asr_retry", runtimeState: "post_set", targetSetRecordId: set.id, occurredAt: 270_000, error: { code: "asr_low_confidence", message: null } }));
    // 第二次尝试:成功
    const cmd = recorder.recordInteraction(interaction(sessionId, { action: "voice.command.feedback.just_right", success: true, runtimeState: "post_set", targetSetRecordId: set.id, transcript: "还行,刚好", occurredAt: 274_000 }));
    recorder.recordSetFeedback({ setRecordId: set.id, difficulty: "just_right", fatigue: null, pain: null, source: "voice", transcript: "还行,刚好", interactionEventId: cmd.id, capturedAt: 274_800 });

    const feedbackCount = t.db.prepare("SELECT COUNT(*) AS n FROM set_feedbacks WHERE set_record_id = ?").get(set.id).n;
    const interactionCount = t.db.prepare("SELECT COUNT(*) AS n FROM interaction_events WHERE target_set_record_id = ?").get(set.id).n;
    assert.equal(feedbackCount, 1);
    assert.equal(interactionCount, 2); // asr_retry + 成功指令
    const fb = recorder.listFeedbacks(sessionId);
    assert.equal(fb.length, 1);
    assert.equal(fb[0].source, "voice");
    assert.equal(fb[0].difficulty, "just_right");
  } finally { t.cleanup(); }
});
