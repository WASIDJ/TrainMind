// 规格 §9.5 — null 保持:未上报字段不被 coerce 成 0
import test from "node:test";
import assert from "node:assert/strict";
import { freshDb, setupSession } from "./helpers.ts";

test("finalizeSet 部分回填:未提供的 actual 字段保持 null", () => {
  const t = freshDb();
  try {
    const { store, recorder, sessionId } = setupSession(t);
    const ex = store.createExerciseInstance({ sessionId, exerciseId: "plank", orderIndex: 0, trackingMetric: "hold" });
    const set = store.createSetRecord({
      exerciseInstanceId: ex.id, setNumber: 1, status: "partial",
      targetDurationSeconds: 45, targetRestAfterSeconds: 60,
    });
    assert.equal(set.actualReps, null);
    assert.equal(set.actualWeightKg, null);
    assert.equal(set.startedAt, null);

    recorder.finalizeSet(set.id, { actualReps: 9, completedAt: 123_456, status: "completed" });
    const row = store.getSetRecord(set.id)!;
    assert.equal(row.actualReps, 9);
    assert.equal(row.completedAt, 123_456);
    assert.equal(row.status, "completed");
    // 未提供 → 保持 null,绝不变成 0
    assert.equal(row.actualDurationSeconds, null);
    assert.equal(row.actualWeightKg, null);
    assert.equal(row.actualRestAfterSeconds, null);
    assert.equal(row.startedAt, null);
  } finally { t.cleanup(); }
});

test("二次 finalizeSet 只补 rest,其余保持(null 不被覆盖为 0)", () => {
  const t = freshDb();
  try {
    const { store, recorder, sessionId } = setupSession(t);
    const ex = store.createExerciseInstance({ sessionId, exerciseId: "barbell-squat", orderIndex: 0, trackingMetric: "reps" });
    const set = store.createSetRecord({ exerciseInstanceId: ex.id, setNumber: 1, status: "completed", targetWeightKg: 80 });
    recorder.finalizeSet(set.id, { actualReps: 8, actualWeightKg: 80, completedAt: 95_000, status: "completed" });
    recorder.finalizeSet(set.id, { actualRestAfterSeconds: 85 });
    const row = store.getSetRecord(set.id)!;
    assert.deepEqual(
      { reps: row.actualReps, weight: row.actualWeightKg, rest: row.actualRestAfterSeconds, duration: row.actualDurationSeconds },
      { reps: 8, weight: 80, rest: 85, duration: null },
    );
  } finally { t.cleanup(); }
});
