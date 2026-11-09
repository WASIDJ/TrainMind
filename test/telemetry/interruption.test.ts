// 规格 §9.8 — Interruption 状态感知判定(附录 A #2)
import test from "node:test";
import assert from "node:assert/strict";
import { interruptionOverdue } from "../../src/telemetry/pure.ts";

test("pre_set 停滞 3.1s → 计 interruption(存在 expected auto-transition)", () => {
  assert.equal(interruptionOverdue("pre_set", 3100), true);
});

test("pre_set 停滞恰好 3000ms → 不计(须严格超过 deadline)", () => {
  assert.equal(interruptionOverdue("pre_set", 3000), false);
});

test("resting 停滞 3001ms → 计", () => {
  assert.equal(interruptionOverdue("resting", 3001), true);
});

test("post_set(等用户反馈)停滞 5s → 永不计(用户思考是合法等待)", () => {
  assert.equal(interruptionOverdue("post_set", 5000), false);
});

test("paused 停滞 60s → 不计", () => {
  assert.equal(interruptionOverdue("paused", 60_000), false);
});

test("in_set_counting(用户做组/说话)停滞任意时长 → 不计", () => {
  assert.equal(interruptionOverdue("in_set_counting", 999_999), false);
});

test("summary / pre_workout / aborted → 不计", () => {
  assert.equal(interruptionOverdue("summary", 100_000), false);
  assert.equal(interruptionOverdue("pre_workout", 100_000), false);
  assert.equal(interruptionOverdue("aborted", 100_000), false);
});
