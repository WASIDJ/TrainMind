// 规格 §9.4 — Rest 语义(附录 A #3):completedAt → 下一 work interval;会话结束 = null
import test from "node:test";
import assert from "node:assert/strict";
import { restAfterSeconds } from "../../src/telemetry/pure.ts";
import { freshDb, setupSession } from "./helpers.ts";

test("restAfterSeconds: 85s 实测", () => {
  assert.equal(restAfterSeconds(95_000, 180_000), 85);
});

test("restAfterSeconds: 四舍五入到秒", () => {
  assert.equal(restAfterSeconds(0, 1_500), 2); // 1.5s → 2
  assert.equal(restAfterSeconds(0, 84_999), 85); // 84.999s → 85
});

test("无下一 work interval(会话完成/中止)→ null", () => {
  assert.equal(restAfterSeconds(795_000, null), null);
});

test("completedAt 缺失 → null", () => {
  assert.equal(restAfterSeconds(null, 900_000), null);
});

test("末组 finalize 不提供 rest 且会话结束 → actualRestAfterSeconds 保持 null(绝不度量到 summary)", () => {
  const t = freshDb();
  try {
    const { store, recorder, sessionId } = setupSession(t);
    const ex = store.createExerciseInstance({ sessionId, exerciseId: "barbell-squat", orderIndex: 0, trackingMetric: "reps" });
    const set = store.createSetRecord({ exerciseInstanceId: ex.id, setNumber: 3, status: "completed", targetWeightKg: 75, targetRepsMin: 8, targetRepsMax: 8, targetRestAfterSeconds: 90 });
    // 末组:只回填 reps/完成时刻,不提供 rest
    recorder.finalizeSet(set.id, { actualReps: 8, completedAt: 795_000, status: "completed" });
    store.completeSession(sessionId, "completed", 800_000);
    const row = store.getSetRecord(set.id)!;
    assert.equal(row.actualRestAfterSeconds, null);
    assert.equal(row.actualReps, 8);
    assert.equal(row.completedAt, 795_000);
  } finally { t.cleanup(); }
});

test("同动作下一组 / 跨动作下一组 → 均有值(由调用方用下一 work interval 起点计算)", () => {
  assert.equal(restAfterSeconds(95_000, 180_000), 85);   // 同动作 set2 开始
  assert.equal(restAfterSeconds(440_000, 545_000), 105); // 跨动作:含替换决策时间,仍是到下一 work interval
});
