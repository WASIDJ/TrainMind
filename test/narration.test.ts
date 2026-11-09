// 教练人格层 v1(D11,Bloom 移植)单元测试:槽位映射 / 输出守卫 / 红旗 / 记忆 / 回退矩阵
// 设计文档:../../trainmind-教练人格层设计.md
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrateTelemetry } from "../src/telemetry/index.ts";
import { RuntimeTelemetry } from "../src/telemetry/bridge.ts";
import { slotOf, guardNarration, clampTemplate, buildMemoryFacts, narrate, buildPrompts, stylePreset, RED_FLAG, RED_FLAG_TEXT, type NarrationSlot, type StyleStats } from "../src/narration.ts";
import { generateWorkout, startWorkout, completeWarmup, enableCoach, handleCoachEvent, type WorkoutSession, type TrainingFacts } from "../src/core.ts";

const gymFacts: TrainingFacts = { userId: "u1", rawInput: "", availableDurationMinutes: 45, durationMinutes: 45, environment: "gym", gymId: "power-gym", focus: "back", fatigue: "low", soreness: [], restrictions: [] };
function activeSession(): WorkoutSession {
  const session = generateWorkout(gymFacts);
  startWorkout(session);
  if (session.status === "warming_up") completeWarmup(session);
  enableCoach(session);
  handleCoachEvent(session, { type: "start_set" });
  return session;
}

test("slotOf:槽位映射与安全直通", () => {
  const session = activeSession();
  assert.equal(slotOf({ action: "speak", text: "第 1 组，引体向上。" }, session), "set_intro");
  assert.equal(slotOf({ action: "confirm_completion", text: "完成了吗？" }, session), "confirm");
  assert.equal(slotOf({ action: "collect_feedback", text: "记下了。" }, session), "feedback");
  assert.equal(slotOf({ action: "safety_stop", text: "先停止当前动作。" }, session), null, "安全话术永不叙事");
  assert.equal(slotOf({ action: "speak" }, session), null, "无文本直通");
  assert.equal(slotOf({ action: "adjust_next_set" }, session), null, "调整指令无文本直通");
});

test("slotOf:休息与反馈状态下的 speak 映射", () => {
  const session = activeSession();
  session.status = "resting";
  assert.equal(slotOf({ action: "speak", text: "这组完成，休息 90 秒。" }, session), "rest");
  session.status = "set_feedback";
  assert.equal(slotOf({ action: "speak", text: "下一组 25 公斤。" }, session), "feedback");
});

test("RED_FLAG:命中明确症状词,不命中训练常用语", () => {
  assert.ok(RED_FLAG.test("教练,我有点头晕"));
  assert.ok(RED_FLAG.test("胸口闷得很"));
  assert.ok(RED_FLAG.test("好像要吐了"));
  assert.ok(!RED_FLAG.test("练到力竭了,太爽了"));
  assert.ok(!RED_FLAG.test("这个重量刚刚好"));
  assert.ok(!RED_FLAG.test("今天上班好累啊"));
});

test("guardNarration:通过 / 超长 / 禁语 / 数字核验(含词边界)", () => {
  assert.equal(guardNarration("第 2 组，20 公斤，建议 8 次。开始。", "第 2 组。本组建议 8 次，20 公斤。"), null);
  assert.equal(guardNarration("好".repeat(81), "第 2 组。"), "length");
  assert.equal(guardNarration("做完了？没事的继续，我们减肥要紧。", "完成了吗？"), "banned");
  // 数字核验:模板的 8 必须以独立数字出现,"18"不算
  assert.equal(guardNarration("这组很棒，做了 18 次。", "做了 8 次？"), "number");
  assert.equal(guardNarration("这组很棒，做了 8 次。", "做了 8 次？"), null);
  assert.equal(guardNarration("", "做了 8 次？"), "empty");
});

test("buildMemoryFacts:新学员 / 近况 / 上次吃力反馈", () => {
  const now = Date.parse("2026-10-21T12:00:00Z");
  assert.equal(buildMemoryFacts([], now), "(新学员,今天是第一次训练)");
  const day = 24 * 3600 * 1000;
  const rows = [
    { startedAt: now - 9 * day, exerciseId: "e-chin-up", difficulty: null, actualReps: 5, setNumber: 1 },   // 7 天外,不进天数统计? (查询已过滤,这里模拟过滤后传入)
  ];
  // 模拟查询过滤后的行:两天各一组,昨天反馈吃力
  const rowsIn = [ // DESC:最近的是深蹲吃力,更早的是俯卧撑偏轻
    { startedAt: now - 2 * day, exerciseId: "bodyweight-squat", difficulty: "hard", actualReps: 8, setNumber: 2 },
    { startedAt: now - 3 * day, exerciseId: "push-up", difficulty: "easy", actualReps: 10, setNumber: 1 },
  ];
  void rows;
  const facts = buildMemoryFacts(rowsIn, now);
  assert.ok(facts.includes("练了2次"), facts);
  // 同动作优先:当前动作是 push-up 时,引用 push-up 那次(而非更近的深蹲吃力)
  const factsSame = buildMemoryFacts(rowsIn, now, "push-up"); // 当前动作=俯卧撑 → 引用俯卧撑那次(而非更近的深蹲)
  assert.ok(factsSame.includes("俯卧撑"), factsSame);
  assert.ok(factsSame.includes("偏轻"), factsSame);
  assert.ok(facts.includes("前天"), facts);
  assert.ok(facts.includes("徒手深蹲") && facts.includes("吃力"), facts); // 无当前动作 → 最近一次反馈=深蹲吃力
});

test("narrate:成功路径替换文本;LLM 抛错回退模板并给出原因", async () => {
  const session = activeSession();
  const templateText = "第 1 组。本组建议 8 次。";
  const ok = await narrate({ directive: { action: "speak", text: templateText }, session, slot: "set_intro", templateText, userText: null, memoryFacts: "(新学员)", llm: async () => "第 1 组,自重引体,建议 8 次,慢慢来。" });
  assert.equal(ok.fallback, null);
  assert.equal(ok.text, "第 1 组,自重引体,建议 8 次,慢慢来。");
  const slow = await narrate({ directive: { action: "speak", text: templateText }, session, slot: "set_intro", templateText, userText: null, memoryFacts: "(新学员)", llm: async () => { throw new Error("This operation was aborted"); } });
  assert.equal(slow.fallback, "timeout");
  assert.equal(slow.text, templateText, "回退=原模板文本");
  const banned = await narrate({ directive: { action: "speak", text: templateText }, session, slot: "set_intro", templateText, userText: null, memoryFacts: "(新学员)", llm: async () => "没问题,继续练,减肥要加油。" });
  assert.equal(banned.fallback, "banned");
  assert.equal(banned.text, templateText);
});

test("RuntimeTelemetry.recordNarration:红旗与回退写入 interaction_events(seq 完整)", () => {
  const db = new DatabaseSync(":memory:");
  migrateTelemetry(db);
  db.prepare("INSERT INTO workout_sessions (id, planned_workout_id, started_at, ended_at, status, app_version, next_event_seq) VALUES ('s1', NULL, 1000, NULL, 'exercise_active', 'test', 1)").run();
  const telemetry = new RuntimeTelemetry(db);
  telemetry.recordNarration(null, { kind: "redflag", transcript: "我有点头晕" });
  telemetry.recordNarration(null, { kind: "fallback", code: "number" });
  const rows = db.prepare("SELECT action, intent, success, error_json FROM interaction_events ORDER BY seq").all() as { action: string; intent: string; success: number; error_json: string | null }[];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].action, "coach.narration");
  assert.equal(rows[0].intent, "coach.narration.redflag");
  assert.equal(rows[0].success, 1);
  assert.equal(rows[1].intent, "coach.narration.fallback");
  assert.equal(rows[1].success, 0);
  assert.ok(String(rows[1].error_json).includes("number"));
});

test("RED_FLAG_TEXT:固定安全话术内容稳定(永不经 LLM 改写)", () => {
  assert.ok(RED_FLAG_TEXT.includes("先停下来"));
  assert.ok(!RED_FLAG_TEXT.includes("继续"));
});

test("D14 stylePreset:行为统计→风格预设(含激将证据门槛)", () => {
  const mk = (acceptCut: number, holdOn: number, bargain: number, completionRate: number | null): StyleStats => ({ acceptCut, holdOn, bargain, totalChoices: acceptCut + holdOn + bargain, completionRate });
  assert.equal(stylePreset(mk(0, 0, 0, null)).name, "新学员", "零数据→新学员");
  assert.equal(stylePreset(mk(1, 6, 1, 0.9)).name, "嘴硬且扛得住", "嘴硬+高完成→激将");
  assert.equal(stylePreset(mk(1, 6, 1, 0.4)).name, "嘴硬但数据跟不上", "嘴硬+低完成→看数字");
  assert.equal(stylePreset(mk(1, 1, 5, 0.9)).name, "谈判型", "讨价主导→交易感");
  assert.equal(stylePreset(mk(8, 1, 1, 0.3)).name, "挫败/低自信", "总降档+低完成→队友式");
  assert.equal(stylePreset(mk(8, 1, 1, 0.9)).name, "实在人", "总降档+高完成→干脆");
  assert.equal(stylePreset(mk(3, 3, 2, 0.8)).name, "混合", "无主导→混合");
});

test("D14 buildPrompts:依据与风格注入提示词", () => {
  const session = activeSession();
  const { system, user } = buildPrompts({ slot: "feedback", session, templateText: "下一组 20 公斤。", userText: "有点重,做完了,实际8次", memoryFacts: "(新学员)", evidence: "目标 8-12;当前重量 25 公斤;本组实际 8 次;学员原话「有点重,做完了,实际8次」", styleStats: { acceptCut: 2, holdOn: 5, bargain: 1, totalChoices: 8, completionRate: 0.9 } });
  assert.ok(system.includes("禁止"), "人设应含措辞铁律");
  assert.ok(user.includes("【本组依据】"), "依据应注入");
  assert.ok(user.includes("【学员风格】") && user.includes("嘴硬且扛得住"), "风格预设应注入");
});

// D17(2026-11-05):组内短句 + 只在两个时机允许提问
test("guard: 组内 ≤30 字、不许反问;结束反馈才可以提问", () => {
  assert.equal(guardNarration("这组还撑得住吗？", "徒手深蹲。", "set_intro"), "banned", "组内反问必须被拦");
  assert.equal(guardNarration("开始，按自己的节奏来。", "徒手深蹲。", "set_intro"), null);
  assert.equal(guardNarration("一".repeat(31), "本组。", "set_intro"), "length", "组内超 30 字必须被拦");
  assert.equal(guardNarration("刚刚好", "这组感觉怎么样？", "feedback"), null, "结束反馈允许提问");
  assert.equal(guardNarration("呼吸变重了，正常，顶住。", "呼吸变重了，正常，顶住。", "effort_cue"), null);
});

// A1(2026-11-09):叙事里出现的数字必须能追溯到规则层(模板/记忆事实/证据),
// LLM 自己追加的剂量数字要整句回退 —— 否则等于让 LLM 改剂量。
test("guard A1: 叙事不得出现规则层之外的数字(LLM 不许改剂量)", () => {
  const template = "第 1 组，建议 12。";
  assert.equal(guardNarration("第 1 组，12 次，再加 5 公斤。", template, "set_intro"), "number", "凭空追加重量必须被拦");
  assert.equal(guardNarration("第 1 组，12 次，最后一组加到 20 次。", template, "set_intro"), "number", "凭空追加次数目标也必须被拦");
  assert.equal(guardNarration("第 1 组，12 次，稳住。", template, "set_intro"), null, "只用模板数字应放行");
  assert.equal(guardNarration("第 1 组，12 次，近7天练了3次。", template, "set_intro", "近7天练了3次"), null, "规则层记忆事实里的数字应放行");
  assert.equal(guardNarration("第 1 组，12 次，练了 9 次。", template, "set_intro", "近7天练了3次"), "number", "记忆事实里没有的 9 必须被拦");
});

// A3(2026-11-09):模板裁剪必须保住剂量数字 —— 宁可少说要领,不能少说数字。
test("clampTemplate: 超长模板截到首句,剂量数字不丢,且不超槽位上限", () => {
  const long = "第 2 组，徒手深蹲，20 公斤，建议 8 次。肩膀下沉，肩胛后收，注意膝盖方向。";
  const clipped = clampTemplate(long, "set_intro");
  assert.equal(clipped, "第 2 组，徒手深蹲，20 公斤，建议 8 次。");
  assert.ok(clipped.length <= 30, `组内必须 ≤30 字,实际 ${clipped.length}`);
  assert.ok(clipped.includes("20") && clipped.includes("8"), "重量与次数一个都不能丢");
  // 时长型动作:保留"秒"的单位原文,不许换算成次数
  const timed = clampTemplate("第 3 组，固定单车，自重，建议 300秒。保持能说话的轻快节奏。", "set_intro");
  assert.ok(timed.includes("300秒"), timed);
  assert.ok(timed.length <= 30, `实际 ${timed.length}`);
  assert.equal(clampTemplate("第 1 组。", "set_intro"), "第 1 组。", "够短的不动");
});
