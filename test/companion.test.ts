// 日常陪伴层测试(2026-11-09):情绪识别 + 照面优先级 + 不施压红线。
import test from "node:test";
import assert from "node:assert/strict";
import { buildCheckIn, classifyMood } from "../src/companion.ts";

test("陪伴：情绪识别分得清自责/平台期/想放弃/焦虑/疲惫，普通话不误判", () => {
  assert.equal(classifyMood("我又吃了半盒饼干，我真没用"), "self_blame");
  assert.equal(classifyMood("一直不掉秤，卡住了"), "plateau");
  assert.equal(classifyMood("不想练了，坚持不下去"), "want_quit");
  assert.equal(classifyMood("最近很焦虑，睡不着"), "anxious");
  assert.equal(classifyMood("今天好累，没什么力气"), "tired");
  assert.equal(classifyMood("今天练什么？"), "neutral");
  assert.equal(classifyMood(undefined), "neutral");
});

test("陪伴：情绪优先于其他所有分支（先接住，再谈训练）", () => {
  const r = buildCheckIn({ daysSinceLast: 30, streakWeeks: 0, totalSessions: 5, lastMessage: "我是不是减不下去了" });
  assert.equal(r.kind, "comfort");
  assert.equal(r.mood, "self_blame");
  assert.doesNotMatch(r.text, /加油|一定会瘦|坚持就是胜利/, "不许灌鸡汤也不许承诺效果");
});

test("陪伴：今天已练过就先让人休息，不再推销计划", () => {
  const r = buildCheckIn({ daysSinceLast: 0, streakWeeks: 3, totalSessions: 6, trainedToday: true });
  assert.equal(r.kind, "trained_today");
});

test("陪伴：两周没来不指责、承诺不催，且带回入口", () => {
  const r = buildCheckIn({ daysSinceLast: 20, streakWeeks: 0, totalSessions: 4 });
  assert.equal(r.kind, "long_gap");
  assert.doesNotMatch(r.text, /怎么又|这么久|欠/, "不许有指责口吻");
  assert.match(r.text, /想回来就直接开一场/);
});

test("陪伴：连续周要给具体肯定，不空喊", () => {
  const r = buildCheckIn({ daysSinceLast: 3, streakWeeks: 3, totalSessions: 6 });
  assert.equal(r.kind, "back_soon", "3 天没练先催回来，而不是只夸连续周");
  const r2 = buildCheckIn({ daysSinceLast: 0, streakWeeks: 4, totalSessions: 9 });
  assert.equal(r2.kind, "streak");
  assert.match(r2.text, /4 周/, "肯定要带具体数字");
});

test("陪伴：新用户不设大目标", () => {
  const r = buildCheckIn({ daysSinceLast: null, streakWeeks: 0, totalSessions: 0 });
  assert.equal(r.kind, "first_time");
});

test("陪伴：话术带事实依据，便于事后核对为什么这么说", () => {
  const r = buildCheckIn({ daysSinceLast: 5, streakWeeks: 2, totalSessions: 7 });
  assert.equal(r.facts.totalSessions, 7);
  assert.equal(r.facts.streakWeeks, 2);
  assert.equal(r.facts.persona, "fat_loss", "默认减重人群预设");
});
