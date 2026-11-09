// D27 导入功能的规则层测试：URL 识别、剂量解析、动作匹配、适合性判定。
// 这层不碰网络与 LLM，所以能把"音频/文案里那些乱七八糟的写法"压成可断言的用例。
import test from "node:test";
import assert from "node:assert/strict";
import { detectSource, parseDoseText, matchExercise, assessItem, parseRepRange, summarizePlan, type MatchableExercise } from "../src/import-plan.ts";

const ex = (over: Partial<MatchableExercise> & { id: string; name: string }): MatchableExercise => ({
  movementPattern: "squat", primaryMuscles: ["legs"], equipmentIds: ["bodyweight"], contraindicationTags: [],
  minSets: 1, maxSets: 3, defaultReps: "8-12", substitutionTags: [], ...over,
});

test("D27: 认得 B站/YouTube 链接，认不出抖音就标成不能自动抓", () => {
  assert.deepEqual(detectSource("https://www.bilibili.com/video/BV1GJ411x7h7?spm=1")?.platform, "bilibili");
  assert.equal(detectSource("BV1GJ411x7h7")?.id, "BV1GJ411x7h7");
  assert.equal(detectSource("https://youtu.be/dQw4w9WgXcQ")?.platform, "youtube");
  const dy = detectSource("https://v.douyin.com/iAbCdEf/");
  assert.equal(dy?.platform, "douyin");
  assert.equal(dy?.autoFetch, false, "抖音反爬，不许承诺自动抓");
  assert.equal(detectSource("今天练腿：深蹲 3组×12次"), null);
});

test("D27: 剂量写法都能解析（组数/次数区间/秒数/重量）", () => {
  assert.deepEqual(parseDoseText("4组×20次"), { sets: 4, repsMin: 20, repsMax: 20 });
  assert.deepEqual(parseDoseText("3 x 10-12"), { sets: 3, repsMin: 10, repsMax: 12 });
  assert.deepEqual(parseDoseText("2组×30秒"), { sets: 2, seconds: 30 });
  assert.deepEqual(parseDoseText("5组 80kg 8次"), { sets: 5, repsMin: 8, repsMax: 8, weightKg: 80 });
  assert.deepEqual(parseDoseText("没有数字"), {});
});

test("D27: 动作名先精确、再别名，模糊匹配不许张冠李戴", () => {
  const lib = [ex({ id: "bodyweight-squat", name: "徒手深蹲", aliases: ["深蹲"] }), ex({ id: "bulgarian", name: "保加利亚分腿蹲" })];
  assert.equal(matchExercise("徒手深蹲", lib)?.id, "bodyweight-squat");
  assert.equal(matchExercise("深蹲", lib)?.id, "bodyweight-squat", "走别名");
  assert.equal(matchExercise("保加利亚分腿蹲", lib)?.id, "bulgarian", "精确命中，不许被'深蹲'抢走");
  assert.equal(matchExercise("壶铃摇摆", lib), null, "库里没有就老实返回 null，不猜");
});

test("D27: 医嘱禁忌优先于原数字——标不适合，且不给'照原样练'", () => {
  const squat = ex({ id: "bodyweight-squat", name: "徒手深蹲", contraindicationTags: ["knee_pain"] });
  const r = assessItem({ name: "徒手深蹲", dose: { sets: 3, repsMin: 12, repsMax: 12 } }, squat, { restrictions: ["knee_pain"], environment: "home" });
  assert.equal(r.verdict, "unsuitable");
  assert.match(r.reasons[0]!, /膝部限制/);
  assert.equal(summarizePlan([r]).blocksAsIs, true);
});

test("D27: 原剂量超出能力区间时给建议，但不改判定为'不适合'", () => {
  const squat = ex({ id: "bodyweight-squat", name: "徒手深蹲" });
  const r = assessItem({ name: "徒手深蹲", dose: { sets: 5, repsMin: 20, repsMax: 20 } }, squat, { restrictions: [], environment: "home", repRange: { min: 8, max: 12 } });
  assert.equal(r.verdict, "adjust");
  assert.equal(r.suggested.sets, 3, "超过 maxSets 要收回来");
  assert.equal(r.suggested.reps, "8-12");
  assert.ok(r.reasons.some(x => x.includes("20 次")));
});

test("D27: 剂量在能力范围内就判 ok，不制造噪音", () => {
  const squat = ex({ id: "bodyweight-squat", name: "徒手深蹲" });
  const r = assessItem({ name: "徒手深蹲", dose: { sets: 2, repsMin: 10, repsMax: 10 } }, squat, { restrictions: [], environment: "home", repRange: { min: 8, max: 12 } });
  assert.equal(r.verdict, "ok");
  assert.deepEqual(r.reasons, []);
});

test("D27: 器械不够要提示（用户在家但动作要哑铃）", () => {
  const db = ex({ id: "db-squat", name: "哑铃深蹲", equipmentIds: ["dumbbell"] });
  const r = assessItem({ name: "哑铃深蹲", dose: { sets: 3, repsMin: 10, repsMax: 10 } }, db, { restrictions: [], environment: "home", availableEquipment: ["bodyweight"] });
  assert.equal(r.verdict, "adjust");
  assert.match(r.reasons[0]!, /哑铃|dumbbell/);
});

test("D27: 次数区间解析容错", () => {
  assert.deepEqual(parseRepRange("8-12"), { min: 8, max: 12 });
  assert.deepEqual(parseRepRange("10"), { min: 10, max: 10 });
  assert.equal(parseRepRange("尽量多"), undefined);
});
