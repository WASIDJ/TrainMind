// Phase 7B.2:C1(动作替换口令)/ C2(时间约束口令)单元测试
import test from "node:test";
import assert from "node:assert/strict";
import { parseCoachReport, spokenChineseNumber } from "../src/coach-runtime.ts";
import {
  completeRest, completeWarmup, enableCoach, generateWorkout, handleCoachEvent, handleCoachMessage,
  agencyChoiceFromSpeech, markSetComplete, resetCoachForSet, startWorkout, submitSetFeedback, shortenRemainingWorkout,
} from "../src/core.ts";
import type { WorkoutSession } from "../src/core.ts";

const context = { userId: "u1", rawInput: "", availableDurationMinutes: 40, durationMinutes: 40, environment: "gym" as const, gymId: "test-gym", focus: "back", fatigue: "low" as const, soreness: [], restrictions: [] };

function activeSession(): WorkoutSession {
  const workout = generateWorkout(context);
  startWorkout(workout);
  if (workout.status === "warming_up") completeWarmup(workout);
  assert.equal(workout.status, "exercise_active");
  return workout;
}

test("spokenChineseNumber parses digits and Chinese numerals", () => {
  assert.equal(spokenChineseNumber("10"), 10);
  assert.equal(spokenChineseNumber("十五"), 15);
  assert.equal(spokenChineseNumber("二十"), 20);
  assert.equal(spokenChineseNumber("三"), 3);
  assert.ok(Number.isNaN(spokenChineseNumber("几")));
});

test("parseCoachReport: C1 substitution phrases", () => {
  assert.deepEqual(parseCoachReport("器械有人，换一个"), { type: "substitute" });
  assert.deepEqual(parseCoachReport("这个做不了"), { type: "substitute" });
  assert.deepEqual(parseCoachReport("换个动作"), { type: "substitute" });
  assert.deepEqual(parseCoachReport("器械被占了"), { type: "substitute" });
  // 疑问句仍走对话,不是命令
  assert.equal(parseCoachReport("能不能换一个"), undefined);
});

test("parseCoachReport: C2 time constraint phrases", () => {
  assert.deepEqual(parseCoachReport("只剩10分钟"), { type: "time_constraint", remainingMinutes: 10 });
  assert.deepEqual(parseCoachReport("只有十五分钟了"), { type: "time_constraint", remainingMinutes: 15 });
  assert.deepEqual(parseCoachReport("还剩十分钟"), { type: "time_constraint", remainingMinutes: 10 });
  // "还剩几组"是查询,不是时间约束
  assert.equal(parseCoachReport("还剩几组"), undefined);
  // 0 分钟/超范围不构成口令
  assert.equal(parseCoachReport("只剩0分钟"), undefined);
});

test("parseCoachReport: pain still wins over other intents", () => {
  assert.deepEqual(parseCoachReport("膝盖疼"), { type: "pain" });
});

test("shortenRemainingWorkout drops trailing exercises and trims current within floor", () => {
  const workout = activeSession();
  const before = { count: workout.exercises.length, planned: workout.plannedDurationMinutes };
  const result = shortenRemainingWorkout(workout, 10);
  assert.ok(result.afterMinutes <= 10 || workout.exercises.length === 1, `after=${result.afterMinutes}`);
  assert.ok(workout.exercises.length < before.count || result.trimmedToSets !== null, "40 分钟计划压到 10 分钟必须丢动作或削减组数");
  assert.ok(workout.exercises.length >= 1);
  const current = workout.exercises[workout.runtime.currentExerciseIndex]!;
  assert.ok(current.sets - current.completedSets >= 1, "当前动作至少保留 1 组");
  assert.equal(workout.plannedDurationMinutes, Math.ceil(workout.durationBreakdown.totalSeconds / 60));
  const event = workout.runtime.events.at(-1)!;
  assert.equal(event.type, "workout_shortened");
  assert.deepEqual((event.details as { droppedExerciseIds: string[] }).droppedExerciseIds, result.droppedExerciseIds);
  assert.match(result.message, /10 分钟/);
});

test("shortenRemainingWorkout: 1-minute floor keeps one set and reports possible overrun", () => {
  const workout = activeSession();
  const result = shortenRemainingWorkout(workout, 1);
  assert.equal(workout.exercises.length, 1);
  assert.equal(workout.exercises[0]!.sets - workout.exercises[0]!.completedSets, 1);
  assert.ok(result.message.length > 0);
});

test("shortenRemainingWorkout rejects invalid state and range", () => {
  const preview = generateWorkout(context);
  assert.throws(() => shortenRemainingWorkout(preview, 10), /不能调整时长/);
  const workout = activeSession();
  assert.throws(() => shortenRemainingWorkout(workout, 0), /1 到 180/);
  assert.throws(() => shortenRemainingWorkout(workout, 500), /1 到 180/);
});

test("shortenRemainingWorkout works during resting and paused", () => {
  const resting = activeSession();
  markSetComplete(resting);
  submitSetFeedback(resting, { feedback: "right", actualReps: 8 });
  assert.equal(resting.status, "resting");
  shortenRemainingWorkout(resting, 12);
  assert.ok(resting.runtime.events.some(x => x.type === "workout_shortened"));

  const paused = activeSession();
  markSetComplete(paused);
  submitSetFeedback(paused, { feedback: "right", actualReps: 8 });
  completeRest(paused); // 进入下一组
  paused.status = "paused"; paused.runtime.pausedAt = new Date().toISOString(); // 直接构造暂停态
  shortenRemainingWorkout(paused, 12);
  assert.ok(paused.runtime.events.some(x => x.type === "workout_shortened"));
});

test("handleCoachEvent: substitute during exercise_active replaces or skips and speaks", () => {
  const workout = activeSession();
  enableCoach(workout);
  const result = handleCoachEvent(workout, { type: "substitute" });
  assert.equal(result.directive.action, "speak");
  const replaced = workout.runtime.events.some(x => x.type === "exercise_replaced");
  const skipped = workout.runtime.events.some(x => x.type === "exercise_skipped");
  assert.ok(replaced || skipped, "必须产生 exercise_replaced 或 exercise_skipped 域事件");
  if (replaced) {
    const event = workout.runtime.events.find(x => x.type === "exercise_replaced")!;
    assert.equal((event.details as { reason: string }).reason, "equipment_busy");
    assert.match(result.directive.text, /已换为/);
  } else {
    assert.match(result.directive.text, /没有合适的替代动作/);
  }
});

test("handleCoachEvent: substitute outside exercise_active only speaks guidance", () => {
  const workout = activeSession();
  markSetComplete(workout);
  assert.equal(workout.status, "set_feedback");
  enableCoach(workout);
  const result = handleCoachEvent(workout, { type: "substitute" });
  assert.equal(result.directive.action, "speak");
  assert.match(result.directive.text, /动作进行时/);
  assert.ok(!workout.runtime.events.some(x => x.type === "exercise_replaced"));
});

test("handleCoachMessage routes equipment/time phrases end to end", () => {
  const workout = activeSession();
  enableCoach(workout);
  const time = handleCoachMessage(workout, "只剩10分钟");
  assert.equal(time.directive.action, "speak");
  assert.match(time.directive.text, /10 分钟/);
  assert.ok(workout.runtime.events.some(x => x.type === "workout_shortened"));

  const equipment = handleCoachMessage(workout, "器械有人，换一个");
  assert.equal(equipment.directive.action, "speak");
  assert.ok(workout.runtime.events.some(x => x.type === "exercise_replaced" || x.type === "exercise_skipped"));
});

test("handleCoachEvent: time_constraint during paused is rejected by the paused guard", () => {
  const workout = activeSession();
  enableCoach(workout);
  workout.status = "paused"; workout.runtime.pausedAt = new Date().toISOString();
  const result = handleCoachEvent(workout, { type: "time_constraint", remainingMinutes: 10 });
  assert.equal(result.directive.action, "speak");
  assert.match(result.directive.text, /暂停/);
  assert.ok(!workout.runtime.events.some(x => x.type === "workout_shortened"));
});

test("7B.2.1 P0: natural difficulty phrases parse directly (no clarification loop)", () => {
  for (const phrase of ["太重了", "有点重", "有些重", "感觉重了", "这个重量有点吃力", "轻一点"]) {
    const parsed = parseCoachReport(phrase);
    assert.deepEqual(parsed, { type: "user_report", feedback: "too_heavy" }, `phrase: ${phrase}`);
  }
  for (const phrase of ["太轻了", "有点轻", "有些轻", "感觉轻了", "太轻松了", "重一点"]) {
    const parsed = parseCoachReport(phrase);
    assert.deepEqual(parsed, { type: "user_report", feedback: "too_light" }, `phrase: ${phrase}`);
  }
});

test("7B.2.1 P0 / D14: '有点重，做完了，实际8次' 一轮落 record 并进入 Agency 三选一(剂量待选,不自动降)", () => {
  const workout = activeSession();
  enableCoach(workout);
  handleCoachEvent(workout, { type: "start_set" });
  const result = handleCoachMessage(workout, "有点重，做完了，实际8次");
  assert.notEqual(result.directive.action, "collect_feedback", "自然表达不得触发追问循环");
  assert.ok(result.record, "必须直接落 SetRecord");
  assert.equal(result.record!.actualReps, 8);
  assert.equal(result.record!.feedback, "hard");
  // D14:吃力 → agency_offer(下一组走法交学员),剂量不自动应用
  assert.equal(result.directive.action, "agency_offer");
  assert.ok(workout.runtime.coach?.pendingAgency, "pendingAgency 应记录实际次数");
  assert.equal(workout.runtime.coach!.pendingAgency!.actualReps, 8);
  assert.ok(!workout.runtime.events.some(x => x.type === "coach_adjustment"), "选择前不得有剂量调整");
});

test("D14 Agency 三选一:accept_cut 降档 / hold_on 定目标 / bargain 减两次(剂量真实变化)", () => {
  const mk = () => { const w = activeSession(); enableCoach(w); handleCoachEvent(w, { type: "start_set" }); return w; };
  // ① accept_cut:标准降档(卧推杠铃 40kg → 政策 -10% 档)
  const w1 = mk(); const before = w1.exercises[0].currentWeight;
  handleCoachMessage(w1, "有点重，做完了，实际6次");
  const r1 = handleCoachEvent(w1, { type: "agency_choice", choice: "accept_cut" });
  assert.equal(r1.directive.action, "speak");
  const t1 = w1.exercises[0].targetReps;
  assert.ok(w1.exercises[0].currentWeight! < before! || t1 !== w1.exercises[0].targetReps || w1.runtime.events.some(x => x.type === "coach_agency_choice"), `accept_cut 应产生剂量变化(重量或次数)`);
  assert.ok(w1.runtime.events.some(x => x.type === "coach_agency_choice"), "选择应入域事件(风格统计源)");
  assert.ok(!w1.runtime.coach?.pendingAgency, "选择后清 pendingAgency");
  // ② hold_on:重量不变,目标=实际次数
  const w2 = mk(); const w2w = w2.exercises[0].currentWeight;
  handleCoachMessage(w2, "有点重，做完了，实际6次");
  const r2 = handleCoachEvent(w2, { type: "agency_choice", choice: "hold_on" });
  assert.equal(w2.exercises[0].currentWeight, w2w, "hold_on 重量不变");
  assert.equal(Number(w2.exercises[0].targetReps.match(/\d+/)?.[0]), 6, "hold_on 目标=实际次数");
  assert.ok(r2.directive.text!.includes("说到做到"), r2.directive.text);
  // ③ bargain:次数 -2,重量不变
  const w3 = mk(); const w3w = w3.exercises[0].currentWeight; const w3t = Number(w3.exercises[0].targetReps.match(/\d+/)?.[0]);
  handleCoachMessage(w3, "有点重，做完了，实际6次");
  const r3 = handleCoachEvent(w3, { type: "agency_choice", choice: "bargain" });
  assert.equal(w3.exercises[0].currentWeight, w3w, "bargain 重量不变");
  assert.equal(Number(w3.exercises[0].targetReps.match(/\d+/)?.[0]), Math.max(1, w3t - 2), "bargain 次数-2");
  assert.ok(r3.directive.text!.includes("欠我一次"), r3.directive.text);
  // ④ 到期默认:未选择直接开始下一组 → 静默降档
  const w4 = mk(); const w4w = w4.exercises[0].currentWeight;
  const w4t = w4.exercises[0].targetReps;
  handleCoachMessage(w4, "有点重，做完了，实际6次");
  handleCoachEvent(w4, { type: "start_set" });
  assert.ok(w4.exercises[0].currentWeight! < w4w! || w4.exercises[0].targetReps !== w4t, "到期默认应产生剂量变化");
  assert.ok(!w4.runtime.coach?.pendingAgency, "到期后清 pendingAgency");
  // ⑤ 无 pending 时选择 → 礼貌拒绝
  const w5 = mk();
  const r5 = handleCoachEvent(w5, { type: "agency_choice", choice: "bargain" });
  assert.equal(r5.directive.action, "speak");
});

test("7B.2.1 C2 hard bound: user budget is respected by the remaining projection", () => {
  const workout = activeSession();
  const result = shortenRemainingWorkout(workout, 10);
  const details = workout.runtime.events.find(x => x.type === "workout_shortened")!.details as { projectedRemainingSeconds: number; budgetSeconds: number };
  assert.ok(details.projectedRemainingSeconds <= details.budgetSeconds,
    `predicted remaining ${details.projectedRemainingSeconds}s must be within the user's ${details.budgetSeconds}s budget`);
  assert.ok(!result.message.includes("超出"), "10 分钟预算可满足时不得报超出");
});

test("7B.2.1 C2 hard bound: budget below safety floor keeps floor and reports overrun honestly", () => {
  const workout = activeSession();
  const result = shortenRemainingWorkout(workout, 1); // 60s < 1 组 + 放松环节
  assert.equal(workout.exercises.length, 1);
  const current = workout.exercises[workout.runtime.currentExerciseIndex]!;
  assert.equal(current.sets - current.completedSets, 1, "安全下限:当前动作至少 1 组");
  const details = workout.runtime.events.find(x => x.type === "workout_shortened")!.details as { projectedRemainingSeconds: number };
  assert.ok(details.projectedRemainingSeconds > 60, "低于下限时如实报告预计超出");
  assert.ok(result.message.includes("超出"));
});

test("7B.2.3 徒手动作:难度问话用费力感措辞,不用重量措辞", () => {
  const home = { userId: "u1", rawInput: "", availableDurationMinutes: 15, durationMinutes: 15, environment: "home" as const, gymId: undefined, focus: "chest", fatigue: "low" as const, soreness: [], restrictions: [] };
  const workout = generateWorkout(home);
  startWorkout(workout);
  if (workout.status === "warming_up") completeWarmup(workout);
  assert.equal(workout.status, "exercise_active");
  const exercise = workout.exercises[0]!;
  assert.equal(exercise.currentWeight, undefined, "居家计划首动作应为徒手(俯卧撑)");
  enableCoach(workout);
  handleCoachEvent(workout, { type: "start_set" });
  const result = handleCoachMessage(workout, "做完了，实际8次"); // 只报次数 → 追问难度
  assert.equal(result.directive.action, "collect_feedback");
  assert.ok(result.directive.text!.includes("轻松、合适还是吃力"), `徒手问话应为费力感措辞: ${result.directive.text}`);
  assert.ok(!result.directive.text!.includes("太重"), `不得用重量措辞: ${result.directive.text}`);
});

test("7B.2.3 徒手反馈'轻松'可解析为 too_light", () => {
  assert.deepEqual(parseCoachReport("轻松"), { type: "user_report", feedback: "too_light" });
  assert.deepEqual(parseCoachReport("很轻松"), { type: "user_report", feedback: "too_light" });
});

// ═══ D16-B:跨动作 Agency(吃力收工 → 下一动作三选一) ═══
/** 模拟服务器 complete_set 动作:核心 markSetComplete + 教练状态机 phase 同步 */
function completeSetCoach(w: WorkoutSession) { markSetComplete(w); if (w.runtime.coach) { w.runtime.coach.phase = "FEEDBACK"; (w.runtime.coach as { awaitingCompletion?: boolean }).awaitingCompletion = false; } }

test("D16-B:单组动作吃力收工 → 跨动作三选一触发(居家单组计划的 agency 时刻由此而来)", () => {
  const workout = generateWorkout(context);
  (workout.exercises[0] as { sets?: number }).sets = 1; // 合成单组:居家计划的典型形状
  startWorkout(workout);
  if (workout.status === "warming_up") completeWarmup(workout);
  enableCoach(workout);
  handleCoachEvent(workout, { type: "start_set" });
  const result = handleCoachMessage(workout, "有点吃力，做完了，实际6次");
  assert.equal(result.directive.action, "agency_offer", `应触发跨动作 offer,实际 ${result.directive.action}`);
  assert.ok(result.directive.text!.includes("下一个动作"), `话术应指向下一动作:「${result.directive.text}」`);
  assert.equal(workout.runtime.coach!.pendingAgency!.scope, "exercise", "pendingAgency 应标记跨动作");
  assert.equal(workout.status, "resting", "末组提交后处于转换休息");
  assert.ok(!workout.runtime.events.some(x => x.type === "coach_adjustment"), "选择前不得有剂量调整");
});

test("D16-B:next_down 降下一动作档 / stay 原计划 / skip_next 砍动作(剂量与结构真实变化)", () => {
  const mk = () => { const w = activeSession(); enableCoach(w); handleCoachEvent(w, { type: "start_set" }); return w; };
  const finishExercise0 = (w: WorkoutSession) => {
    handleCoachMessage(w, "有点重，做完了，实际6次");                       // 组1:同组 agency → 选降档
    handleCoachEvent(w, { type: "agency_choice", choice: "accept_cut" });
    completeRest(w);
    handleCoachEvent(w, { type: "start_set" });
    completeSetCoach(w);
    const r = handleCoachMessage(w, "有点重，做完了，实际5次");             // 组2(末组):跨动作 offer
    assert.equal(r.directive.action, "agency_offer", "末组吃力应触发跨动作 offer");
    assert.equal(w.runtime.currentExerciseIndex, 1, "末组提交后索引已指向下一动作");
    return r;
  };
  // ① next_down:下一动作(exercises[1])剂量被降
  const w1 = mk(); finishExercise0(w1);
  const next1Before = { weight: w1.exercises[1].currentWeight, reps: w1.exercises[1].targetReps };
  const r1 = handleCoachEvent(w1, { type: "agency_choice", choice: "next_down" });
  assert.equal(r1.directive.action, "speak");
  const cut = w1.runtime.events.filter(x => x.type === "coach_adjustment").at(-1)!.details as { scope?: string; agencyChoice?: string };
  assert.equal(cut.agencyChoice, "next_down");
  assert.equal(cut.scope, "exercise");
  assert.ok(w1.exercises[1].currentWeight! < next1Before.weight! || w1.exercises[1].targetReps !== next1Before.reps, `下一动作应有降档:${JSON.stringify(next1Before)} → ${w1.exercises[1].currentWeight}/${w1.exercises[1].targetReps}`);
  assert.ok(!w1.runtime.coach?.pendingAgency, "选择后清 pendingAgency");
  // ② stay:下一动作原样
  const w2 = mk(); finishExercise0(w2);
  const before2 = { weight: w2.exercises[1].currentWeight, reps: w2.exercises[1].targetReps };
  const r2 = handleCoachEvent(w2, { type: "agency_choice", choice: "stay" });
  assert.ok(r2.directive.text!.includes("按原计划"), `stay 话术:「${r2.directive.text}」`);
  assert.deepEqual({ weight: w2.exercises[1].currentWeight, reps: w2.exercises[1].targetReps }, before2, "stay 不得动下一动作");
  assert.ok(w2.runtime.events.some(x => x.type === "coach_agency_choice"), "选择入域事件");
  // ③ skip_next:砍掉下一动作,休息保留,指向再下一个
  const w3 = mk(); finishExercise0(w3);
  const r3 = handleCoachEvent(w3, { type: "agency_choice", choice: "skip_next" });
  assert.equal(w3.exercises[1].executionStatus, "skipped");
  assert.equal(w3.exercises[1].skippedReason, "agency_skip");
  assert.equal(w3.status, "resting", "砍动作不终结休息");
  assert.ok(w3.runtime.currentExerciseIndex >= 2, "索引应越过被砍动作");
  assert.equal(w3.exercises[w3.runtime.currentExerciseIndex].executionStatus, "active");
  assert.ok(w3.runtime.events.some(x => x.type === "exercise_skipped"), "exercise_skipped 应入域事件");
  assert.ok(r3.directive.text!.includes("砍掉"), `skip 话术:「${r3.directive.text}」`);
});

test("D16-B:到期默认 = 下一动作降一档(不选就进下一动作 → 保守保护)", () => {
  const w = activeSession(); enableCoach(w); handleCoachEvent(w, { type: "start_set" });
  handleCoachMessage(w, "有点重，做完了，实际6次");
  handleCoachEvent(w, { type: "agency_choice", choice: "accept_cut" });
  completeRest(w); handleCoachEvent(w, { type: "start_set" });
  completeSetCoach(w);
  handleCoachMessage(w, "有点重，做完了，实际5次");
  assert.equal(w.runtime.coach!.pendingAgency!.scope, "exercise");
  const nextBefore = { weight: w.exercises[1].currentWeight, reps: w.exercises[1].targetReps };
  completeRest(w); resetCoachForSet(w); // 服务器 rest_complete 顺序
  assert.ok(!w.runtime.coach?.pendingAgency, "到期后清 pendingAgency");
  const ev = w.runtime.events.filter(x => x.type === "coach_adjustment").at(-1)!.details as { agencyChoice?: string; scope?: string };
  assert.equal(ev.agencyChoice, "next_down", "到期默认应为跨动作降档");
  assert.ok(w.exercises[1].currentWeight! < nextBefore.weight! || w.exercises[1].targetReps !== nextBefore.reps, "下一动作剂量应被降");
});

test("D16-B:跨动作口令映射(轻一点/按原计划/少练一个;与组内口令不串)", () => {
  assert.equal(agencyChoiceFromSpeech("轻一点", "exercise"), "next_down");
  assert.equal(agencyChoiceFromSpeech("听你的", "exercise"), "next_down");
  assert.equal(agencyChoiceFromSpeech("按原计划走", "exercise"), "stay");
  assert.equal(agencyChoiceFromSpeech("我能行", "exercise"), "stay");
  assert.equal(agencyChoiceFromSpeech("少练一个", "exercise"), "skip_next");
  assert.equal(agencyChoiceFromSpeech("跳过吧", "exercise"), "skip_next");
  assert.equal(agencyChoiceFromSpeech("听你的"), "accept_cut", "组内口令不受影响");
  assert.equal(agencyChoiceFromSpeech("我能行"), "hold_on", "组内口令不受影响");
});

test("D16-B:下一动作是时间型(有氧/活动度)不触发 offer;砍到没有后续也不触发", () => {
  const w = activeSession(); enableCoach(w); handleCoachEvent(w, { type: "start_set" });
  handleCoachMessage(w, "有点重，做完了，实际6次");
  handleCoachEvent(w, { type: "agency_choice", choice: "accept_cut" });
  completeRest(w); handleCoachEvent(w, { type: "start_set" });
  completeSetCoach(w);
  (w.exercises[1] as { repOrTimeBased?: "reps" | "time" }).repOrTimeBased = "time"; // 合成:下一动作时间型
  const r = handleCoachMessage(w, "有点重，做完了，实际5次");
  assert.notEqual(r.directive.action, "agency_offer", "时间型下一动作不得 offer");
  assert.ok(!w.runtime.coach?.pendingAgency, "不留 pending");
});

test("D16-B:skip_next 砍掉最后一个动作 → 今天到这(finish)", () => {
  const w = activeSession(); enableCoach(w); handleCoachEvent(w, { type: "start_set" });
  w.exercises = w.exercises.slice(0, 2); // 合成:只剩两个动作
  handleCoachMessage(w, "有点重，做完了，实际6次");
  handleCoachEvent(w, { type: "agency_choice", choice: "accept_cut" });
  completeRest(w); handleCoachEvent(w, { type: "start_set" });
  completeSetCoach(w);
  const r = handleCoachMessage(w, "有点重，做完了，实际5次");
  assert.equal(r.directive.action, "agency_offer");
  const r2 = handleCoachEvent(w, { type: "agency_choice", choice: "skip_next" });
  assert.equal(w.status, "completed", "砍掉最后动作应 finish");
  assert.ok(r2.directive.text!.includes("今天到这"), `收尾话术:「${r2.directive.text}」`);
});
