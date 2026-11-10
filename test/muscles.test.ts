// 肌群疲劳账本测试(2026-11-09):纯函数，覆盖命名空间映射、时间衰减、被落下、三态口径。
import test from "node:test";
import assert from "node:assert/strict";
import { buildMuscleLedger, canonicalMuscle, ledgerSignals, MUSCLE_GROUPS } from "../src/muscles.ts";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();

const muscles = {
  "bodyweight-squat": ["legs"],
  "box-squat": ["quadriceps", "gluteus_maximus"],   // RepDB 解剖命名
  "push-up": ["chest"],
  "lat-pulldown-ex": ["back"],
};

test("肌群：两套命名空间都能映射到同一个部位", () => {
  assert.equal(canonicalMuscle("legs"), "legs");
  assert.equal(canonicalMuscle("quadriceps"), "legs");
  assert.equal(canonicalMuscle("hamstrings"), "legs");
  assert.equal(canonicalMuscle("pectoralis_major"), "chest");
  assert.equal(canonicalMuscle("latissimus_dorsi"), "back");
  assert.equal(canonicalMuscle("rear_delt"), "shoulders");
  assert.equal(canonicalMuscle("biceps_brachii"), "arms");
  assert.equal(canonicalMuscle("没人认识的名字"), null, "认不出就老实返回 null");
});

test("肌群：刚练过的部位标 just_trained，剂量不动", () => {
  const entries = buildMuscleLedger({ now: NOW, musclesByExercise: muscles, sets: [
    { exerciseId: "bodyweight-squat", completedAt: at(2), actualRepsSource: "counted" },
    { exerciseId: "bodyweight-squat", completedAt: at(2), actualRepsSource: "counted" },
  ]});
  const legs = entries.find(x => x.group === "legs")!;
  assert.equal(legs.state, "just_trained");
  assert.equal(legs.sets7d, 2);
  assert.equal(legs.measuredSets7d, 2);
  assert.match(legs.text, /今天刚练过/);
  assert.doesNotMatch(legs.text, /%|小时/, "展示层不出现百分比与小时数");
});

test("肌群：超过恢复窗口就算已恢复", () => {
  const entries = buildMuscleLedger({ now: NOW, musclesByExercise: muscles, sets: [
    { exerciseId: "push-up", completedAt: at(60), actualRepsSource: "counted" }, // 胸 48h 窗口
  ]});
  const chest = entries.find(x => x.group === "chest")!;
  assert.equal(chest.state, "recovered");
});

test("肌群：两周以上没练 = 被落下", () => {
  const entries = buildMuscleLedger({ now: NOW, musclesByExercise: muscles, sets: [
    { exerciseId: "lat-pulldown-ex", completedAt: at(24 * 20), actualRepsSource: "counted" },
  ]});
  const back = entries.find(x => x.group === "back")!;
  assert.equal(back.state, "neglected");
  const signals = ledgerSignals(entries);
  assert.deepEqual(signals.neglected, ["back"]);
});

test("肌群：assumed（按计划推定）单独计数，不与实测混谈", () => {
  const entries = buildMuscleLedger({ now: NOW, musclesByExercise: muscles, sets: [
    { exerciseId: "bodyweight-squat", completedAt: at(3), actualRepsSource: "counted" },
    { exerciseId: "bodyweight-squat", completedAt: at(3), actualRepsSource: "assumed" },
  ]});
  const legs = entries.find(x => x.group === "legs")!;
  assert.equal(legs.sets7d, 2);
  assert.equal(legs.measuredSets7d, 1);
  assert.equal(legs.assumedSets7d, 1, "推定组数必须单独可见");
});

test("肌群：RepDB 动作用一个动作喂两个部位（四头肌 + 臀）", () => {
  const entries = buildMuscleLedger({ now: NOW, musclesByExercise: muscles, sets: [
    { exerciseId: "box-squat", completedAt: at(1), actualRepsSource: "counted" },
  ]});
  assert.equal(entries.find(x => x.group === "legs")!.sets7d, 1);
  assert.equal(entries.find(x => x.group === "glutes")!.sets7d, 1);
});

test("肌群：没有记录的部位标 no_record，不假装已恢复", () => {
  const entries = buildMuscleLedger({ now: NOW, musclesByExercise: muscles, sets: [] });
  assert.equal(entries.length, MUSCLE_GROUPS.length);
  assert.ok(entries.every(x => x.state === "no_record"));
  assert.deepEqual(ledgerSignals(entries).ready, []);
});

test("肌群：未来时间戳（时钟漂移）不计入，也不报错", () => {
  const entries = buildMuscleLedger({ now: NOW, musclesByExercise: muscles, sets: [
    { exerciseId: "push-up", completedAt: new Date(NOW + 5 * HOUR).toISOString(), actualRepsSource: "counted" },
  ]});
  assert.equal(entries.find(x => x.group === "chest")!.state, "no_record");
});

test("恢复度：0–100 百分比，边界与无记录", () => {
  const fresh = buildMuscleLedger({ now: NOW, musclesByExercise: muscles, sets: [] }).find(x => x.group === "chest")!;
  assert.equal(fresh.recoveryPercent, null, "没有记录不能假装 0%");

  // 胸窗口 48h：24h 前 → 50%
  const half = buildMuscleLedger({ now: NOW, musclesByExercise: muscles, sets: [
    { exerciseId: "push-up", completedAt: at(24), actualRepsSource: "counted" },
  ]}).find(x => x.group === "chest")!;
  assert.ok(Math.abs((half.recoveryPercent ?? 0) - 50) <= 3, `期望约 50%，实际 ${half.recoveryPercent}`);
  assert.equal(half.state, "recovering");

  // 超窗 → 100%，状态仍是已恢复
  const full = buildMuscleLedger({ now: NOW, musclesByExercise: muscles, sets: [
    { exerciseId: "push-up", completedAt: at(72), actualRepsSource: "counted" },
  ]}).find(x => x.group === "chest")!;
  assert.equal(full.recoveryPercent, 100);
  assert.equal(full.state, "recovered");
});

test("恢复度：很久没练仍单独标记，不并入 100%", () => {
  const old = buildMuscleLedger({ now: NOW, musclesByExercise: muscles, sets: [
    { exerciseId: "lat-pulldown-ex", completedAt: at(24 * 20), actualRepsSource: "counted" },
  ]}).find(x => x.group === "back")!;
  assert.equal(old.state, "neglected");
  assert.equal(old.recoveryPercent, 100, "数值上是 100%，但状态仍是久未训练");
});
