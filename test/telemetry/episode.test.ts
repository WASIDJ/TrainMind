// 规格 §9.1 — Episode 规则
import test from "node:test";
import assert from "node:assert/strict";
import { computeManualEpisodes } from "../../src/telemetry/pure.ts";
import { TELEMETRY_CONSTANTS } from "../../src/telemetry/types.ts";

const GAP = TELEMETRY_CONSTANTS.EPISODE_GAP_MS; // 8000

test("空序列 → 0 episode", () => {
  assert.equal(computeManualEpisodes([], GAP), 0);
});

test("单次 tap = 1 episode", () => {
  assert.equal(computeManualEpisodes([100], GAP), 1);
});

test("8s 内 3 连点 = 1 episode", () => {
  assert.equal(computeManualEpisodes([0, 4000, 7000], GAP), 1);
});

test("边界:间隔恰好 =8s 归同一 episode(≤)", () => {
  assert.equal(computeManualEpisodes([0, 8000], GAP), 1);
});

test("间隔 8001ms = 2 episodes", () => {
  assert.equal(computeManualEpisodes([0, 8001], GAP), 2);
});

test("混合:两段连续操作 = 2 episodes", () => {
  assert.equal(computeManualEpisodes([0, 3000, 20000, 24000], GAP), 2);
});
