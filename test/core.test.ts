import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

async function bindAction(origin: string, path: string, payload: any) {
  if (!payload || !path.endsWith("/actions") || payload.context) return payload;
  const { workout: w } = await fetch(origin + path.slice(0, -8)).then(r => r.json());
  return { ...payload, context: { sessionId: w.sessionId, exerciseId: w.exercises[w.runtime.currentExerciseIndex]?.exerciseId ?? null,
    setNumber: w.runtime.currentSetNumber, coachPhase: w.runtime.coach?.phase ?? null, status: w.status, eventCount: w.runtime.events.length } };
}
import { convertUpstream } from "../knowledge/import-free-exercise-db.ts";
import { assertKnowledgeExercise } from "../knowledge/schema.ts";
import { createCoachState, transitionCoach, parseCoachReport, AdjustmentPolicyV0 } from "../src/coach-runtime.ts";
import {
  adjustedWeight, sessionRecipe, completeCooldown, completeRest, completeWarmup, createWorkout, generateWorkout, LocalLanguageModelProvider,
  markSetComplete, nextAvailableWeight, pauseWorkout, replaceExercise, resumeWorkout,
  safetyGate, skipExercise, startWorkout, submitSetFeedback, exercises, prescriptionRules,
  buildUserTrainingModel, recommendExercise, ContextInterpreter, RuleLanguageModelProvider,
  validateStructuredContext, configureExperience, experienceDirective, controlExperience,
  advanceExperienceSegment, createExperimentRecord, experimentRecordsCsv, TtsSpeechQueue,
  enableCoach, handleCoachEvent, handleCoachMessage, coachAdjustedDose,
  type LanguageModelProvider, type WorkoutSession, type SetRecord, type TrainingFacts
} from "../src/core.ts";

let __portSeq = 0; // D16-D:pid 取模跨进程会撞端口,自增序列根除
const context = { userId: "u1", rawInput: "", availableDurationMinutes: 40, durationMinutes: 40, environment: "gym" as const, gymId: "test-gym", focus: "back", fatigue: "low" as const, soreness: [], restrictions: [] };

test("coach runtime: guidance needs user confirmation and feedback can precede completion", () => {
  const now = "2026-10-09T00:00:00Z";
  let state = createCoachState(now);
  for (const type of ["start_set", "guidance_started", "guidance_finished"] as const) state = transitionCoach(state, { type }, now).state;
  assert.equal(state.phase, "SET_COMPLETE");
  assert.equal(state.awaitingCompletion, true);
  const early = transitionCoach(state, { type: "user_report", feedback: "too_heavy", completed: false }, now);
  assert.equal(early.state.phase, "SET_COMPLETE");
  assert.equal(early.directive.action, "confirm_completion");
  const finished = transitionCoach(early.state, { type: "user_report", completed: true, actualReps: 6 }, now);
  assert.equal(finished.state.phase, "FEEDBACK");
  assert.deepEqual(finished.directive, { action: "adjust_next_set", adjustment: { policy: "AdjustmentPolicyV0", weightRatio: -0.1 }, feedback: "too_heavy" });
  state = transitionCoach(finished.state, { type: "feedback_saved" }, now).state;
  assert.equal(state.phase, "REST");
  state = transitionCoach(state, { type: "rest_finished" }, now).state;
  assert.equal(state.phase, "NEXT_SET");
  state = transitionCoach(state, { type: "next_set" }, now).state;
  assert.equal(state.phase, "READY");
  assert.equal(state.pendingFeedback, undefined);
});
test("coach runtime: pain preempts every phase and cannot resume through normal events", () => {
  for (const phase of ["READY", "START_SET", "REP_GUIDANCE", "SET_COMPLETE", "FEEDBACK", "REST", "NEXT_SET"] as const) {
    const result = transitionCoach({ ...createCoachState("now"), phase }, { type: "pain" }, "later");
    assert.equal(result.directive.action, "safety_stop");
    assert.equal(result.state.safetyStopped, true);
    assert.equal(transitionCoach(result.state, { type: "next_set" }, "later").state.safetyStopped, true);
  }
});
test("coach runtime: narrow reports distinguish unfinished, completed and negated pain", () => {
  assert.deepEqual(parseCoachReport("太重了，还没做完"), { type: "user_report", feedback: "too_heavy", completed: false });
  assert.deepEqual(parseCoachReport("做完了，太轻了，实际12次"), { type: "user_report", feedback: "too_light", completed: true, actualReps: 12 });
  assert.deepEqual(parseCoachReport("膝盖不舒服"), { type: "pain" });
  assert.equal(parseCoachReport("没有疼痛"), undefined);
  assert.equal(parseCoachReport("这个动作怎么做？"), undefined);
  assert.equal(AdjustmentPolicyV0.too_light, 0.05);
});
const fresh = () => generateWorkout(context);
function coached() {
  const w = fresh(); startWorkout(w); if (w.status === "warming_up") completeWarmup(w);
  enableCoach(w); handleCoachEvent(w, { type: "start_set" }); handleCoachEvent(w, { type: "guidance_started" });
  return w;
}
test("coach core: early difficulty does not complete a set or manufacture actual reps", () => {
  const w = coached();
  assert.equal(handleCoachMessage(w, "太重了，还没做完").record, undefined);
  assert.equal(w.status, "exercise_active"); assert.equal(w.exercises[0].completedSets, 0);
  assert.equal(handleCoachMessage(w, "做完了").record, undefined);
  assert.equal(w.status, "set_feedback");
  const saved = handleCoachMessage(w, "实际六次");
  assert.equal(saved.record?.actualReps, 6); assert.equal(saved.record?.feedback, "hard");
  assert.equal(w.status, "resting");
  assert.equal(saved.directive.action, "agency_offer", "D14:吃力 → 三选一而非自动降档");
  handleCoachEvent(w, { type: "agency_choice", choice: "accept_cut" }); // 学员选"行,降点重量"
  const adjustment = w.runtime.events.find(x => x.type === "coach_adjustment")!;
  assert.equal(adjustment.details?.reason, "too_heavy");
  assert.equal(adjustment.details?.policy, "AdjustmentPolicyV0");
  assert.equal(handleCoachMessage(w, "实际六次").record, undefined);
});
test("coach core: actual load is separate from the prescription and only core picks equipment steps", () => {
  const w = coached(), x = w.exercises[0]; x.currentWeight = 60;
  const saved = handleCoachMessage(w, "做完了，太重了，实际12次，实际60公斤");
  assert.equal(saved.record?.actualWeight, 60); assert.equal(saved.record?.targetWeight, 60);
  assert.equal(saved.directive.action, "agency_offer", "D14:剂量待学员选择");
  handleCoachEvent(w, { type: "agency_choice", choice: "accept_cut" });
  assert.equal(x.currentWeight, 55);
  const event = w.runtime.events.find(x => x.type === "coach_adjustment")!;
  assert.deepEqual(event.details?.before, { weightKg: 60, targetReps: saved.record?.targetReps });
  assert.equal((event.details?.after as any).weightKg, 55);
  x.currentWeight = 100; x.equipmentId = "barbell";
  assert.equal(coachAdjustedDose(x, "too_light").after.weightKg, 105);
  x.currentWeight = 30; x.equipmentId = "lat-pulldown";
  assert.equal(coachAdjustedDose(x, "too_light").after.weightKg, 30);
  assert.equal(Number(coachAdjustedDose(x, "too_light").after.targetReps.match(/\d+/)![0]), Number(x.targetReps.match(/\d+/)![0]) + 1);
});
test("coach core: pain pauses without a fake set and ordinary resume remains blocked", () => {
  const w = coached(), index = w.runtime.currentExerciseIndex;
  const result = handleCoachMessage(w, "膝盖不舒服");
  assert.equal(result.record, undefined); assert.equal(w.status, "paused");
  assert.equal(w.runtime.currentExerciseIndex, index); assert.equal(w.exercises[index].completedSets, 0);
  assert.ok(w.runtime.events.some(x => x.type === "coach_safety_stop"));
  assert.throws(() => resumeWorkout(w), /疼痛/);
  handleCoachMessage(w, "疼痛");
  assert.equal(w.runtime.events.filter(x => x.type === "coach_safety_stop").length, 1);
});
test("coach core: retracting completion keeps reported reps uncommitted until confirmed again", () => {
  const w = coached();
  handleCoachMessage(w, "做完了，太重了");
  assert.equal(w.status, "set_feedback");
  handleCoachMessage(w, "还没做完");
  assert.equal(w.status, "exercise_active");
  assert.equal(handleCoachMessage(w, "实际6次").record, undefined);
  assert.equal(w.exercises[0].completedSets, 0);
  assert.equal(handleCoachMessage(w, "做完了").record?.actualReps, 6);
});
test("coach Day2 Memory: explicit 60kg heavy feedback initializes 55kg with an explanation", () => {
  const w = coached(); w.exercises[0].currentWeight = 60;
  const first = handleCoachMessage(w, "做完了，太重了，实际12次，实际60公斤").record!;
  handleCoachEvent(w, { type: "agency_choice", choice: "accept_cut" }); // D14:三选一(降档)后,55 落到下一组
  completeRest(w); w.runtime.coach = undefined; enableCoach(w);
  handleCoachEvent(w, { type: "start_set" }); handleCoachEvent(w, { type: "guidance_started" });
  const second = handleCoachMessage(w, "做完了，实际10次，正好").record!;
  w.status = "completed"; w.runtime.completedAt = new Date().toISOString();
  const facts = { sessions: [w], sets: [first, second] }, before = JSON.stringify(facts);
  // Selection remains the Prescription Engine's decision; verify the dose when this exercise is prescribed again.
  const next = generateWorkout({ ...context, availableEquipmentIds: ['lat-pulldown', 'bodyweight'] }, facts);
  const exercise = next.exercises.find(x => x.exerciseId === first.exerciseId)!;
  assert.equal(exercise.currentWeight, 55);
  assert.match(exercise.recommendation.userExplanation, /根据上次偏重反馈/);
  assert.equal(JSON.stringify(facts), before);
});

test("coach API: full workout persists only confirmed sets, replays are harmless and pain is recoverable", async () => {
  const port = 33000 + (process.pid % 900) + (++__portSeq * 7);
  const child = spawn(process.execPath, ["src/server.ts"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", TRAINMIND_DB: ":memory:" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(Error("server timeout")), 20000); child.stdout.on("data", b => { if (String(b).includes("TrainMind running")) { clearTimeout(timeout); resolve(); } }); child.once("exit", code => reject(Error(`server exited ${code}`))); });
    const call = async (path: string, payload?: unknown, ok = true) => {
      payload = await bindAction(`http://127.0.0.1:${port}`, path, payload);
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: payload ? "POST" : "GET", headers: { "content-type": "application/json" }, body: payload ? JSON.stringify(payload) : undefined });
      if (ok) assert.equal(response.ok, true, await response.clone().text()); return response.json() as Promise<any>;
    };
    let data = await call("/api/workouts/preview", { input: "今天练20分钟。", userId: "coach-api", dataOrigin: "automated_test" });
    const id = data.workout.sessionId, path = `/api/workouts/${id}/actions`;
    data = await call(path, { type: "start", coach: true });
    const coachedAction = async (payload: any) => {
      const request = await bindAction(`http://127.0.0.1:${port}`, path, { ...payload, exerciseIndex: data.workout.runtime.currentExerciseIndex, setNumber: data.workout.runtime.currentSetNumber, expectedPhase: data.workout.runtime.coach.phase });
      data = await call(path, request); return request;
    };
    let confirmed = 0;
    while (!["completed", "cooling_down"].includes(data.workout.status)) {
      if (data.workout.status === "resting") { data = await call(path, { type: "rest_complete" }); continue; }
      await coachedAction({ type: "coach_event", event: { type: "start_set" } });
      await coachedAction({ type: "coach_event", event: { type: "guidance_started" } });
      if (confirmed === 0) {
        await coachedAction({ type: "coach_message", message: "太重了，还没做完" });
        assert.equal(data.setRecord, undefined); assert.equal(data.workout.exercises[0].completedSets, 0);
        await coachedAction({ type: "coach_event", event: { type: "guidance_finished" } });
        assert.equal(data.setRecord, undefined);
        await coachedAction({ type: "coach_message", message: "做完了" });
        assert.equal(data.setRecord, undefined);
      }
      const request = await coachedAction({ type: "coach_message", message: confirmed === 0 ? "实际6次" : "做完了，实际6次，正好" });
      assert.equal(data.setRecord.actualReps, 6); assert.equal(data.setRecord.actualWeight, undefined); confirmed++;
      const replay = await call(path, request); assert.equal(replay.stale, true); assert.equal(replay.setRecord, undefined);
      const refreshed = await call(`/api/workouts/${id}`); assert.deepEqual(refreshed.workout.runtime.coach, data.workout.runtime.coach);
    }
    if (data.workout.status === "cooling_down") data = await call(path, { type: "cooldown_complete" });
    const history = await call("/api/history?userId=coach-api");
    assert.equal(history.sessions[0].sets.length, confirmed);
    assert.ok(history.sessions[0].workout.runtime.events.some((x: any) => x.type === "coach_adjustment"));
    const second = await call("/api/workouts/preview", { input: "今天练20分钟。", userId: "coach-pain", dataOrigin: "automated_test" });
    const painPath = `/api/workouts/${second.workout.sessionId}/actions`;
    const started = await call(painPath, { type: "start", coach: true });
    const pain = await call(painPath, { type: "coach_message", message: "膝盖不舒服", exerciseIndex: 0, setNumber: 1, expectedPhase: started.workout.runtime.coach.phase });
    assert.equal(pain.workout.status, "paused"); assert.equal(pain.setRecord, undefined);
    const resume = await call(painPath, { type: "resume" }, false); assert.match(resume.error, /疼痛/);
    await call(painPath, { type: "abort" });
    const painHistory = await call("/api/history?userId=coach-pain"); assert.deepEqual(painHistory.sessions[0].sets, []);
    // Replay the old button route after the next set has actually started.
    const isolation = await call("/api/workouts/preview", { input: "我在 Test Gym，有40分钟，想练背。", userId: "mobile-isolation", dataOrigin: "automated_test" });
    const isolationPath = `/api/workouts/${isolation.workout.sessionId}/actions`;
    await call(isolationPath, { type: "start", coach: true });
    const early = await call(isolationPath, { type: "feedback", feedback: "hard", actualReps: 6 }, false);
    assert.match(early.error ?? "", /确认.*完成/);
    // 记录一个"完成前"的请求,用于稍后验证重放会被 stale 拒绝
    const staleRequest = await bindAction(`http://127.0.0.1:${port}`, isolationPath, { type: "feedback", feedback: "hard", actualReps: 6, actualWeight: 30 });
    // 产品决定(2026-11-05):完成一组即记录并进入休息,不再二次确认、不再问感受
    const completed = await call(isolationPath, { type: "complete_set" });
    assert.equal(completed.setRecord.setNumber, 1, "完成即记录");
    assert.equal(completed.setRecord.actualRepsSource, "assumed", "不再报数 → 次数按目标推定");
    assert.equal(completed.workout.status, "resting", "完成后直接进休息");
    assert.equal(completed.workout.runtime.coach.phase, "REST");
    // D17:完整一句"做完了+反馈"之后,若用户再补一句反馈 → 视为"事后补充",更正同一组(不报错、不新增记录)
    const late = await call(isolationPath, { type: "feedback", feedback: "hard", actualReps: 6 });
    assert.equal(late.setRecord.id, completed.setRecord.id, "更正的是同一组,不能新插一条");
    assert.equal(late.setRecord.feedback, "hard", "补充的反馈要被采纳");
    assert.equal(late.setRecord.actualReps, 6, "补充的次数要被采纳");
    const extend = await bindAction(`http://127.0.0.1:${port}`, isolationPath, { type: "extend_rest", seconds: 15 });
    const extended = await call(isolationPath, extend);
    const duplicateExtend = await call(isolationPath, extend);
    assert.equal(duplicateExtend.stale, true);
    assert.deepEqual(duplicateExtend.workout, extended.workout, "Even same-phase duplicates must not extend rest twice");
    let next = (await call(isolationPath, { type: "rest_complete" })).workout;
    next = (await call(isolationPath, { type: "coach_event", event: { type: "start_set" } })).workout;
    next = (await call(isolationPath, { type: "coach_event", event: { type: "guidance_started" } })).workout;
    for (const request of [staleRequest, { ...staleRequest, type: "complete_set" }, { ...staleRequest, type: "pause" }, { ...staleRequest, type: "abort" }]) {
      const replay = await call(isolationPath, request);
      assert.equal(replay.stale, true); assert.equal(replay.setRecord, undefined);
      assert.deepEqual(replay.workout, next);
    }
    for (const key of ["sessionId", "exerciseId", "setNumber", "coachPhase"]) {
      const wrong = await bindAction(`http://127.0.0.1:${port}`, isolationPath, { type: "complete_set" });
      wrong.context[key] = key === "setNumber" ? 99 : "wrong";
      assert.equal((await call(isolationPath, wrong)).stale, true);
    }
    const missing = await fetch(`http://127.0.0.1:${port}${isolationPath}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "complete_set" }) });
    assert.equal(missing.status, 400);
  } finally { child.kill(); if (child.exitCode === null) await new Promise(resolve => child.once("exit", resolve)); }
});
const setFeedback = (w: WorkoutSession, input = { actualReps: 10, actualWeight: w.exercises[w.runtime.currentExerciseIndex].currentWeight, rir: 2, feedback: "right" as const }) => { markSetComplete(w, "2026-09-22T10:00:10Z"); return submitSetFeedback(w, input, "2026-09-22T10:00:11Z"); };
function makeFacts(entries: Array<{ exerciseId?: string; weight?: number; reps: number[]; rirs: number[]; pain?: boolean; daysAgo?: number; events?: any[] }>): TrainingFacts {
  const sessions: WorkoutSession[] = [], sets: SetRecord[] = [];
  entries.forEach((entry, sessionIndex) => {
    const session = fresh(), exerciseId = entry.exerciseId ?? "lat-pulldown-ex", sessionId = `history-${sessionIndex}`, at = new Date(Date.now() - (entry.daysAgo ?? sessionIndex + 2) * 86400000).toISOString();
    session.sessionId = sessionId; session.status = "completed"; session.runtime.completedAt = at; session.runtime.events = entry.events ?? [];
    sessions.push(session);
    entry.reps.forEach((reps, i) => sets.push({ id: `${sessionId}-${i}`, sessionId, workoutExerciseId: `wx-${sessionIndex}`, exerciseId, setNumber: i + 1, targetWeight: entry.weight ?? 40, actualWeight: entry.weight ?? 40, targetReps: "8-10", actualReps: reps, rir: entry.rirs[i], feedback: entry.pain ? "pain" : "right", pain: entry.pain ?? false, completedAt: at }));
  });
  return { sessions, sets };
}

test("40 minutes does not inflate working sets to fill time", () => {
  const w = fresh();
  assert.deepEqual(w.exercises.map(x => x.sets), [2, 2, 2]);
  assert.equal(w.prescription.workingSets, 6);
  assert.ok(w.plannedDurationMinutes < 40);
  assert.ok(w.durationBreakdown.warmupSeconds && w.durationBreakdown.setExecutionSeconds && w.durationBreakdown.restSeconds && w.durationBreakdown.transitionSeconds && w.durationBreakdown.cooldownSeconds);
});

test("planned duration never exceeds available duration", () => { for (const minutes of [5, 10, 15, 20, 40]) { const w = generateWorkout({ ...context, availableDurationMinutes: minutes, durationMinutes: minutes }); assert.ok(w.plannedDurationMinutes <= minutes, `${minutes}: ${w.plannedDurationMinutes}`); } });
test("reasonable core training leaves optional duration", () => { const w = fresh(); assert.ok(w.optionalDurationMinutes > 0); assert.equal(w.blocks.optionalBlock[0].required, false); });
test("exercise sets stay within configured exercise bounds", () => { const w = fresh(); for (const item of w.exercises) { const definition = exercises.find(x => x.id === item.exerciseId)!; assert.ok(item.sets >= definition.minSets && item.sets <= definition.maxSets); } });
test("session working sets stay below prescription cap", () => { const w = fresh(); assert.ok(w.prescription.workingSets <= prescriptionRules.back_strength.maxWorkingSets); });

test("acceptance input produces Test Gym back workout", async () => {
  const result = await createWorkout("我现在在 Test Gym，有40分钟，今天想练背。", "u1", new LocalLanguageModelProvider());
  assert.equal(result.workout?.goal, "back_strength");
  assert.equal(result.workout?.exercises[0].currentWeight, 30);
  assert.equal(result.workout?.exercises[0].recommendation.action, "calibrate");
});

test("completing a set creates a complete SetRecord", () => {
  const w = fresh(); startWorkout(w, "2026-09-22T10:00:00Z"); const { record } = setFeedback(w);
  assert.deepEqual({ session: record.sessionId, exercise: record.exerciseId, set: record.setNumber, reps: record.actualReps, rir: record.rir, feedback: record.feedback, pain: record.pain }, { session: w.sessionId, exercise: "lat-pulldown-ex", set: 1, reps: 10, rir: 2, feedback: "right", pain: false });
});

test("RIR 2 keeps weight", () => assert.equal(adjustedWeight("lat-pulldown", 40, "right", 2), 40));
test("too light moves to the next real increment", () => assert.equal(adjustedWeight("lat-pulldown", 40, "too_light", 4), 45));
test("available-weight equipment never invents a weight", () => { assert.equal(nextAvailableWeight("dumbbell", 12.5, 1), 15); assert.equal(adjustedWeight("dumbbell", 12.5, "failed", 0), 10); });
test("failed target lowers load", () => assert.equal(adjustedWeight("lat-pulldown", 40, "failed", 0, false), 35));

test("pain stops remaining sets of the current exercise", () => {
  const w = fresh(); startWorkout(w); const first = w.exercises[0]; markSetComplete(w); submitSetFeedback(w, { actualReps: 4, actualWeight: 40, feedback: "pain" });
  assert.equal(first.executionStatus, "pain"); assert.equal(w.runtime.currentExerciseIndex, 1); assert.equal(w.status, "exercise_active");
});

test("skip records reason and advances", () => {
  const w = fresh(); startWorkout(w); const first = w.exercises[0]; skipExercise(w, "equipment_busy");
  assert.equal(first.executionStatus, "skipped"); assert.equal(first.skippedReason, "equipment_busy"); assert.equal(w.runtime.currentExerciseIndex, 1);
});

test("replace avoids every action already scheduled in the session", () => {
  const w = fresh(); startWorkout(w); w.runtime.currentExerciseIndex = 1; w.exercises[0].executionStatus = "completed"; w.exercises[1].executionStatus = "active"; replaceExercise(w, "equipment_busy"); const x = w.exercises[1];
  assert.equal(x.originalExerciseId, "seated-cable-row"); assert.equal(x.exerciseId, "one-arm-db-row"); assert.ok(!["lat-pulldown-ex", "face-pull"].includes(x.exerciseId));
});

test("replace prioritizes the same movement pattern", () => { const w = fresh(); startWorkout(w); w.runtime.currentExerciseIndex = 1; w.exercises[1].executionStatus = "active"; replaceExercise(w); assert.equal(exercises.find(x => x.id === w.exercises[1].exerciseId)?.movementPattern, "horizontal_pull"); });
test("no legal same-pattern replacement safely skips", () => { const w = fresh(); startWorkout(w); w.exercises[0].alternatives = []; replaceExercise(w); assert.equal(w.exercises[0].executionStatus, "skipped"); assert.equal(w.exercises[0].skippedReason, "no_legal_replacement"); assert.equal(w.runtime.currentExerciseIndex, 1); });
test("short time has no optional block before core content is cut", () => { const w = generateWorkout({ ...context, availableDurationMinutes: 20, durationMinutes: 20 }); assert.deepEqual(w.blocks.optionalBlock, []); });
test("continued time pressure removes accessory before main", () => { const w = generateWorkout({ ...context, availableDurationMinutes: 12, durationMinutes: 12 }); assert.equal(w.blocks.accessoryBlock.length, 0); assert.equal(w.blocks.mainBlock.length, 2); });
test("main block survives severe time pressure before lower priority blocks", () => { const w = generateWorkout({ ...context, availableDurationMinutes: 10, durationMinutes: 10 }); assert.ok(w.blocks.mainBlock.length >= 1); assert.equal(w.blocks.accessoryBlock.length, 0); });
test("prescription rationale is structured and factual", () => { const w = fresh(); assert.equal(w.prescription.goal, "back_strength"); assert.equal(w.prescription.availableDurationMinutes, 40); assert.equal(w.prescription.plannedDurationMinutes, w.plannedDurationMinutes); assert.ok(w.prescription.reasoningSummary.some(x => x.includes(`${w.prescription.workingSets} 个工作组`))); });

test("rest state has a deadline and can advance", () => {
  const w = fresh(); startWorkout(w, "2026-09-22T10:00:00Z"); setFeedback(w); assert.equal(w.status, "resting"); assert.ok(w.runtime.restEndsAt); completeRest(w); assert.equal(w.status, "exercise_active");
});

test("pause excludes paused wall time from active workout time", () => {
  const w = fresh(); startWorkout(w, "2026-09-22T10:00:00Z"); pauseWorkout(w, "2026-09-22T10:01:00Z"); resumeWorkout(w, "2026-09-22T10:06:00Z"); pauseWorkout(w, "2026-09-22T10:07:00Z"); assert.equal(w.runtime.activeWorkoutMs, 120000);
});

test("a complete workout reaches completed", () => {
  const w = fresh(); w.exercises = w.exercises.slice(0, 1); w.exercises[0].sets = 2; startWorkout(w, "2026-09-22T10:00:00Z"); setFeedback(w); completeRest(w); setFeedback(w); assert.equal(w.status, "completed"); assert.ok(w.runtime.completedAt);
});

test("stable top-range sets with target RIR progress to next equipment step", () => { const w = generateWorkout(context, makeFacts([{ reps: [10, 10, 10], rirs: [3, 2, 2], weight: 40 }])); const r = w.exercises.find(x => x.exerciseId === "lat-pulldown-ex")!.recommendation; assert.equal(r.action, "progress"); assert.equal(r.weightKg, 45); assert.ok(r.reasonCodes.includes("minimum_evidence_met")); assert.match(r.userExplanation, /末组仍保留约2次余力/); });
test("one excellent set is insufficient evidence to progress", () => { const w = generateWorkout(context, makeFacts([{ reps: [10], rirs: [4], weight: 40 }])); const r = w.exercises.find(x => x.exerciseId === "lat-pulldown-ex")!.recommendation; assert.equal(r.action, "maintain"); assert.ok(r.reasonCodes.includes("insufficient_evidence_for_progression")); });
test("low RIR blocks progression", () => { const r = generateWorkout(context, makeFacts([{ reps: [10, 10, 10], rirs: [1, 1, 1], weight: 40 }])).exercises.find(x => x.exerciseId === "lat-pulldown-ex")!.recommendation; assert.notEqual(r.action, "progress"); assert.equal(r.weightKg, 40); });
test("multiple incomplete sets regress instead of progressing", () => { const r = generateWorkout(context, makeFacts([{ reps: [8, 7, 6], rirs: [1, 0, 0], weight: 40 }])).exercises.find(x => x.exerciseId === "lat-pulldown-ex")!.recommendation; assert.equal(r.action, "regress"); assert.equal(r.weightKg, 35); });
test("progression uses a real equipment increment", () => { const r = generateWorkout(context, makeFacts([{ reps: [10, 10, 10], rirs: [3, 2, 2], weight: 40 }])).exercises[0].recommendation; assert.equal(r.weightKg, 45); });
test("high same-pattern load from yesterday blocks volume growth", () => { const facts = makeFacts([{ reps: [10, 10, 10], rirs: [3, 2, 2], weight: 40, daysAgo: 1 }, { exerciseId: "kneeling-cable-pulldown", reps: [10, 10, 10], rirs: [2, 2, 2], weight: 25, daysAgo: 1 }]); const r = generateWorkout(context, facts).exercises[0].recommendation; assert.notEqual(r.action, "progress"); assert.ok(r.reasonCodes.includes("recent_pattern_load_high")); });
test("reported fatigue reduces volume and cancels progression", () => { const facts = makeFacts([{ reps: [10, 10, 10], rirs: [3, 2, 2], weight: 40 }]), r = generateWorkout({ ...context, recoveryState: "fatigued" }, facts).exercises.find(x => x.exerciseId === "lat-pulldown-ex")!.recommendation; assert.equal(r.action, "reduce_volume"); assert.equal(r.sets, 2); });
test("unknown recovery is represented rather than inferred", () => { const r = fresh().exercises[0].recommendation; assert.ok(r.reasonCodes.includes("recovery_unknown")); });
test("recent pain prohibits progression", () => { const facts = makeFacts([{ reps: [10], rirs: [2], weight: 40, pain: true, daysAgo: 3 }]), model = buildUserTrainingModel("u1", facts, "normal"), r = recommendExercise(exercises.find(x => x.id === "lat-pulldown-ex")!, model, facts, { ...context, recoveryState: "normal" }); assert.equal(r.action, "avoid"); assert.ok(r.reasonCodes.includes("progression_blocked")); });
test("pain history changes exercise selection", () => { const facts = makeFacts([{ reps: [8], rirs: [1], weight: 40, pain: true, daysAgo: 3 }]), w = generateWorkout({ ...context, recoveryState: "normal" }, facts); assert.equal(w.exercises[0].exerciseId, "kneeling-cable-pulldown"); });
test("cold start returns low-confidence calibration", () => { const r = fresh().exercises[0].recommendation; assert.equal(r.action, "calibrate"); assert.equal(r.confidence, "low"); assert.equal(r.weightKg, 30); assert.equal(r.calibrationSet, true); });
test("calibration feedback changes the next set conservatively", () => { const w = fresh(); startWorkout(w); markSetComplete(w); submitSetFeedback(w, { actualReps: 10, actualWeight: 30, rir: 5, feedback: "too_light" }); assert.equal(w.exercises[0].currentWeight, 35); });
test("frequently skipped exercise loses selection priority", () => { const events = Array.from({ length: 3 }, (_, i) => ({ id: `e${i}`, type: "exercise_skipped", at: new Date().toISOString(), exerciseId: "lat-pulldown-ex" })), facts = makeFacts([{ reps: [], rirs: [], events }]), w = generateWorkout(context, facts); assert.equal(w.exercises[0].exerciseId, "kneeling-cable-pulldown"); });
test("preference cannot remove required movement coverage", () => { const events = exercises.filter(x => x.movementPattern === "vertical_pull").map((x, i) => ({ id: `e${i}`, type: "exercise_skipped", at: new Date().toISOString(), exerciseId: x.id })), w = generateWorkout(context, makeFacts([{ reps: [], rirs: [], events }])); assert.ok(w.prescription.movementPatterns.includes("vertical_pull")); });
test("no history has low data confidence", () => assert.equal(buildUserTrainingModel("u1", { sessions: [], sets: [] }).dataConfidence, "low"));
test("multiple stable sessions raise confidence", () => { const model = buildUserTrainingModel("u1", makeFacts([{ reps: [10, 10, 10], rirs: [2, 2, 2] }, { reps: [10, 10, 10], rirs: [2, 2, 2] }, { reps: [10, 10, 10], rirs: [2, 2, 2] }])); assert.equal(model.exerciseCapabilities["lat-pulldown-ex"].confidence, "high"); });
test("ExerciseCapability is rebuilt from SetRecord facts", () => { const facts = makeFacts([{ reps: [10, 10, 10], rirs: [3, 2, 2], weight: 40 }]), c = buildUserTrainingModel("u1", facts).exerciseCapabilities["lat-pulldown-ex"]; assert.equal(c.validSetCount, 3); assert.equal(c.recommendedWeightKg, 40); assert.equal(c.estimatedRir, 2); assert.equal(c.recentSuccessfulSets, 3); });
test("deriving the training model never mutates raw facts", () => { const facts = makeFacts([{ reps: [10, 10, 10], rirs: [3, 2, 2] }]), before = JSON.stringify(facts); buildUserTrainingModel("u1", facts); assert.equal(JSON.stringify(facts), before); });

const interpreter = () => new ContextInterpreter(new RuleLanguageModelProvider());
test("natural language extracts explicit 15 minutes", async () => { const r = await interpreter().interpret("我现在只有15分钟，坐了一上午，腰背有点僵，想活动一下。", "u1"); assert.equal(r.context?.availableDurationMinutes, 15); assert.equal(r.context?.fieldEvidence.availableDurationMinutes.source, "explicit"); });
test("半小时 maps to 30 minutes", async () => { const r = await interpreter().interpret("我在 Test Gym，还有半小时，想练背。", "u1"); assert.equal(r.context?.availableDurationMinutes, 30); });
test("Test Gym is identified without inventing a gym", async () => { const a = await interpreter().interpret("我在 Test Gym，有40分钟。", "u1"), b = await interpreter().interpret("我在健身房，有40分钟。", "u1"); assert.equal(a.context?.environmentContext.gymId, "test-gym"); assert.equal(b.context?.environmentContext.gymId, undefined); assert.equal(b.status, "needs_clarification"); });
test("home is identified", async () => { const r = await interpreter().interpret("我在家，有20分钟。", "u1"); assert.equal(r.context?.environmentContext.type, "home"); });
test("不想跳 becomes a deterministic constraint", async () => { const r = await interpreter().interpret("今天很累，只有10分钟，不想跳，也没有器械。", "u1"); assert.equal(r.context?.constraints.noJumping, true); assert.ok(r.context?.restrictions.includes("no_jumping")); });
test("reported previous training is context, not fabricated history", async () => { const r = await interpreter().interpret("我在 Test Gym，有40分钟，今天想练背，昨天练腿了。", "u1"); assert.deepEqual(r.context?.previousTraining, { status: "reported", when: "yesterday", areas: ["legs"] }); assert.equal(r.context?.fieldEvidence.goal.source, "explicit"); });
test("training history comes from facts rather than provider output", async () => { const facts = makeFacts([{ reps: [10, 10, 10], rirs: [3, 2, 2], weight: 40 }]), r = await createWorkout("我在 Test Gym，有40分钟，状态正常，想练背。", "u1", new RuleLanguageModelProvider(), facts); assert.equal(r.workout?.exercises.find(x => x.exerciseId === "lat-pulldown-ex")?.recommendation.weightKg, 45); });
test("fatigue is extracted", async () => { const r = await interpreter().interpret("我在家，只有10分钟，今天很累。", "u1"); assert.equal(r.context?.recovery.overall, "very_fatigued"); });
test("shoulder pain reaches Safety Gate before clarification", async () => { const r = await createWorkout("今天肩膀疼，但是我还想练上肢。", "u1", new RuleLanguageModelProvider()); assert.equal(r.safety.allowed, false); assert.equal(r.safety.code, "active_pain"); assert.match(r.safety.message!, /肩部疼痛/); assert.equal(r.workout, null); });
test("explicit excluded exercise is recognized", async () => { const r = await interpreter().interpret("我想练胸，但是不想做俯卧撑。", "u1"); assert.deepEqual(r.context?.preferences.excludedExercises, ["push-up"]); });
test("omitted information remains unknown", async () => { const r = await interpreter().interpret("我在家，有20分钟。", "u1"); assert.equal(r.context?.goalContext.type, "unknown"); assert.equal(r.context?.previousTraining.status, "unknown"); assert.equal(r.context?.recovery.overall, "unknown"); });
test("non-blocking unknown goal does not trigger clarification", async () => { const r = await interpreter().interpret("我在家，有20分钟，你看着安排。", "u1"); assert.equal(r.status, "ready"); });
test("missing duration triggers one focused clarification", async () => { const r = await interpreter().interpret("我在家，想练一下。", "u1"); assert.equal(r.status, "needs_clarification"); assert.deepEqual(r.context?.missingCriticalFields, ["availableDurationMinutes"]); assert.equal(r.clarificationQuestions.length, 1); });
test("structured context runtime validation accepts valid rule output", async () => { const raw = await new RuleLanguageModelProvider().generateStructuredContext("我在家，有20分钟。", {}); assert.deepEqual(validateStructuredContext(raw), []); });
test("invalid provider output never enters workout engine", async () => { const bad: LanguageModelProvider = { name: "bad", async generateStructuredContext() { return { duration: "twenty" }; } }; const r = await new ContextInterpreter(bad, null).interpret("anything", "u1"); assert.equal(r.status, "error"); assert.equal(r.context, null); });
test("provider failure uses an explicit rule fallback", async () => { const failing: LanguageModelProvider = { name: "failing", async generateStructuredContext() { throw Error("timeout"); } }; const r = await new ContextInterpreter(failing, new RuleLanguageModelProvider()).interpret("我在家，有20分钟。", "u1"); assert.equal(r.status, "ready"); assert.equal(r.fallbackUsed, true); assert.match(r.warnings[0], /fallback/); });
test("cold-start natural language reaches calibration workout", async () => { const r = await createWorkout("我第一次来，想练20分钟。", "new-user", new RuleLanguageModelProvider()); assert.equal(r.interpretation.status, "ready"); assert.equal(r.workout?.exercises[0].recommendation.action, "calibrate"); });
test("natural language context flows through to deterministic workout", async () => { const facts = makeFacts([{ reps: [10, 10, 10], rirs: [3, 2, 2], weight: 40 }]), r = await createWorkout("我刚下班，在 Test Gym，还有半小时。昨天练腿了，今天有点累，想练上肢。", "u1", new RuleLanguageModelProvider(), facts); const x = r.workout?.exercises.find(x => x.exerciseId === "lat-pulldown-ex"); assert.equal(r.context?.availableDurationMinutes, 30); assert.equal(r.context?.goalContext.type, "upper_body"); assert.equal(r.context?.recovery.overall, "fatigued"); assert.equal(r.context?.previousTraining.areas[0], "legs"); assert.equal(x?.recommendation.action, "reduce_volume"); assert.equal(x?.recommendation.weightKg, 40); });
test("home goal selections produce matching workout patterns", async () => {
  const cases = [
    ["想练全身", "general_fitness", ["squat", "horizontal_push", "core_stability"]],
    ["想练上肢", "upper_body", ["vertical_pull", "horizontal_push"]],
    ["想练下肢", "lower_body", ["squat", "hip_extension"]],
    ["想做恢复训练", "mobility", ["core_stability"]],
    ["想练胸和手臂", "chest_strength", ["horizontal_push", "arm_curl", "arm_extension"]]
  ] as const;
  for (const [request, goal, patterns] of cases) {
    const result = await createWorkout(`30分钟，我在 Test Gym，状态一般，${request}`, "goal-test", new RuleLanguageModelProvider());
    assert.equal(result.workout?.goal, goal, request);
    for (const pattern of patterns) assert.ok(result.workout?.prescription.movementPatterns.includes(pattern), `${request}: ${pattern}`);
    assert.equal(result.workout?.availableDurationMinutes, 30);
    assert.equal(result.workout?.environment, "gym");
  }
});

test("SQLite API persists SetRecord and restores active state after refresh", async () => {
  const dbPath = `${process.cwd()}\\test\\phase3-${process.pid}.db`, port = 31000 + (process.pid % 900) + (++__portSeq * 7);
  await rm(dbPath, { force: true });
  const child = spawn(process.execPath, ["src/server.ts"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), TRAINMIND_DB: dbPath }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(Error("server timeout")), 20000); child.stdout.on("data", b => { if (String(b).includes("TrainMind running")) { clearTimeout(timeout); resolve(); } }); child.once("exit", code => reject(Error(`server exited ${code}`))); });
    const call = async (path: string, payload?: unknown) => { payload = await bindAction(`http://localhost:${port}`, path, payload); const r = await fetch(`http://localhost:${port}${path}`, { method: payload ? "POST" : "GET", headers: { "content-type": "application/json" }, body: payload ? JSON.stringify(payload) : undefined }); return r.json() as Promise<any>; };
    let data = await call("/api/workouts/preview", { input: "我现在在 Test Gym，有40分钟，今天想练背。", userId: "integration-user", dataOrigin: "automated_test" }); const id = data.workout.sessionId; assert.equal(data.workout.experience.dataOrigin, "automated_test");
    await call(`/api/workouts/${id}/actions`, { type: "start" }); await call(`/api/workouts/${id}/actions`, { type: "warmup_complete" }); await call(`/api/workouts/${id}/actions`, { type: "complete_set" }); await call(`/api/workouts/${id}/actions`, { type: "feedback", actualReps: 10, actualWeight: 40, rir: 2, feedback: "right" });
    data = await call("/api/workouts/active?userId=integration-user"); assert.equal(data.workout.status, "resting"); assert.equal(data.workout.runtime.currentSetNumber, 2);
    const history = await call("/api/history?userId=integration-user"), profile = await call("/api/profile?userId=integration-user"); assert.deepEqual(history.sessions, []); assert.equal(profile.userId, "integration-user");
    const db = new DatabaseSync(dbPath); const row = db.prepare("SELECT data_json FROM set_records").get() as { data_json: string }; const record = JSON.parse(row.data_json); assert.equal(record.actualWeight, 40); assert.equal(record.rir, 2); db.close();
  } finally { child.kill(); await new Promise(resolve => child.once("exit", resolve)); await rm(dbPath, { force: true }); }
});

test("duration intent distinguishes a target course from a hard maximum", async () => {
  const provider = new RuleLanguageModelProvider();
  const target = await createWorkout("我在家，想练30分钟，想练全身。", "duration-target", provider);
  const maximum = await createWorkout("我在家，最多30分钟，想练全身。", "duration-max", provider);
  assert.equal(target.context?.durationIntent, "target"); assert.equal(maximum.context?.durationIntent, "maximum");
  assert.equal(target.workout?.durationIntent, "target"); assert.equal(maximum.workout?.durationIntent, "maximum");
  const equipmentOnly = await createWorkout("我在家只有哑铃，想练30分钟全身。", "duration-equipment", provider);
  assert.equal(equipmentOnly.context?.durationIntent, "target");
  const halfHourLimit = await createWorkout("我在家，不要超过半小时，想练全身。", "duration-half-hour", provider);
  assert.equal(halfHourLimit.context?.durationIntent, "maximum"); assert.equal(halfHourLimit.context?.availableDurationMinutes, 30);
  assert.ok(target.workout!.plannedDurationMinutes >= 27 && target.workout!.plannedDurationMinutes <= 30);
  assert.ok(maximum.workout!.plannedDurationMinutes <= 30);
  assert.ok(target.workout!.exercises.length > maximum.workout!.exercises.length);
});

test("target course includes persisted warmup and cooldown phases", async () => {
  const result = await createWorkout("我在家，想练30分钟，想练全身。", "phase-test", new RuleLanguageModelProvider());
  const w = result.workout!; startWorkout(w, "2026-09-24T00:00:00Z"); assert.equal(w.status, "warming_up");
  completeWarmup(w, "2026-09-24T00:03:00Z"); assert.equal(w.status, "exercise_active");
  for (const item of w.exercises) { while (item.completedSets < item.sets) { if (w.status === "resting") completeRest(w); markSetComplete(w); submitSetFeedback(w, { feedback: "right" }); } }
  assert.equal(w.status, "cooling_down"); completeCooldown(w); assert.equal(w.status, "completed");
});

test("three exercise API completion is atomic and survives refresh", async () => {
  const dbPath = `${process.cwd()}\\test\\completion-${process.pid}.db`, port = 32000 + (process.pid % 900) + (++__portSeq * 7);
  await rm(dbPath, { force: true });
  const child = spawn(process.execPath, ["src/server.ts"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), TRAINMIND_DB: dbPath }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(Error("server timeout")), 20000); child.stdout.on("data", b => { if (String(b).includes("TrainMind running")) { clearTimeout(timeout); resolve(); } }); child.once("exit", code => reject(Error(`server exited ${code}`))); });
    const call = async (path: string, payload?: unknown) => { payload = await bindAction(`http://localhost:${port}`, path, payload); const r = await fetch(`http://localhost:${port}${path}`, { method: payload ? "POST" : "GET", headers: { "content-type": "application/json" }, body: payload ? JSON.stringify(payload) : undefined }); assert.ok(r.ok, `${path}: ${r.status}`); return r.json() as Promise<any>; };
    let w = (await call("/api/workouts/preview", { input: "我在家，只有15分钟，今天精神不错，想练全身。", userId: "completion-e2e", dataOrigin: "automated_test" })).workout;
    assert.deepEqual(w.exercises.map((x: any) => x.exerciseId), ["bodyweight-squat", "push-up", "bird-dog"]);
    const id = w.sessionId;
    const choices = await call(`/api/workouts/${id}/alternatives?index=0`);
    assert.ok(choices.alternatives.some((x: any) => x.id === "chair-squat"));
    w = (await call(`/api/workouts/${id}/actions`, { type: "plan_move", index: 0, direction: 1 })).workout;
    assert.equal(w.exercises[0].exerciseId, "push-up");
    w = (await call(`/api/workouts/${id}/actions`, { type: "plan_restore" })).workout;
    w = (await call(`/api/workouts/${id}/actions`, { type: "plan_replace", index: 0, exerciseId: "chair-squat" })).workout;
    assert.equal(w.exercises[0].exerciseId, "chair-squat");
    w = (await call(`/api/workouts/${id}/actions`, { type: "plan_remove", index: 0 })).workout;
    assert.equal(w.exercises.length, 2);
    w = (await call(`/api/workouts/${id}/actions`, { type: "plan_restore" })).workout;
    assert.equal(w.exercises.length, 3);
    assert.equal((await call("/api/exercises/bodyweight-squat")).exercise.name, "徒手深蹲");
    assert.equal((await fetch(`http://localhost:${port}/api/exercises/box-squat`)).status, 404);
    w = (await call(`/api/workouts/${id}/actions`, { type: "start" })).workout;
    while (w.status !== "completed") {
      if (w.status === "resting") w = (await call(`/api/workouts/${id}/actions`, { type: "rest_complete" })).workout;
      else if (w.status === "exercise_active") w = (await call(`/api/workouts/${id}/actions`, { type: "complete_set" })).workout;
      else { const response = await call(`/api/workouts/${id}/actions`, { type: "feedback", feedback: "right" }); assert.ok(response.setRecord); w = response.workout; }
    }
    assert.equal((await call("/api/workouts/active?userId=completion-e2e")).workout, null);
    const history = await call("/api/history?userId=completion-e2e"); assert.equal(history.sessions.length, 1);
    assert.equal(history.sessions[0].workout.status, "completed"); assert.equal(history.sessions[0].sets.length, w.exercises.reduce((n: number, x: any) => n + x.completedSets, 0));
    assert.deepEqual([...new Set(history.sessions[0].sets.map((x: any) => x.exerciseId))], ["bodyweight-squat", "push-up", "bird-dog"]);
    assert.deepEqual(history.sessions[0].sets.map((x: any) => x.actualReps), history.sessions[0].sets.map((x: any) => Number(x.targetReps.match(/\d+/)[0])));
    assert.ok(history.sessions[0].workout.exercises.every((x: any) => x.source && x.sourceId && x.sourceLicense));
    const db = new DatabaseSync(dbPath);
    try { const setCount = w.exercises.reduce((n: number, x: any) => n + x.completedSets, 0);
    for (const [table, count] of [["workout_sessions", 1], ["workout_exercises", 3], ["training_records", 1]] as const) assert.equal((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as any).n, count, table);
    // 7B.2 起 set_records 同表双形状:legacy 行(data_json 带 sessionId)+ v2 遥测行(exercise_instance_id 非空)
    assert.equal((db.prepare("SELECT count(*) AS n FROM set_records WHERE data_json != '{}'").get() as any).n, setCount, "legacy set rows");
    assert.equal((db.prepare("SELECT count(*) AS n FROM set_records WHERE exercise_instance_id IS NOT NULL").get() as any).n, setCount, "v2 telemetry set rows");
    assert.deepEqual({ ...(db.prepare("SELECT status, json_extract(data_json, '$.status') AS runtime_status FROM workout_sessions").get() as any) }, { status: "completed", runtime_status: "completed" }); } finally { db.close(); }
    assert.equal((await call(`/api/workouts/${id}`)).workout.status, "completed");
    assert.equal((await call(`/api/workouts/${id}/experience`, {})).workout.status, "completed");
    const illegalResume = await fetch(`http://localhost:${port}/api/workouts/${id}/actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "resume" }) });
    assert.equal(illegalResume.status, 400); assert.equal((await call(`/api/workouts/${id}`)).workout.status, "completed");
    let target = (await call("/api/workouts/preview", { input: "我在家，有30分钟，今天精神不错，想练全身。", userId: "target-e2e", dataOrigin: "automated_test" })).workout;
    assert.ok(target.plannedDurationMinutes >= 27 && target.plannedDurationMinutes <= 30);
    const targetId = target.sessionId; target = (await call(`/api/workouts/${targetId}/actions`, { type: "start" })).workout; assert.equal(target.status, "exercise_active"); assert.ok(!target.runtime.events.some((event: any) => event.type === "warmup_completed"));
    while (target.status !== "completed") {
      const type = target.status === "warming_up" ? "warmup_complete" : target.status === "cooling_down" ? "cooldown_complete" : target.status === "resting" ? "rest_complete" : target.status === "exercise_active" ? "complete_set" : "feedback";
      target = (await call(`/api/workouts/${targetId}/actions`, { type, ...(type === "feedback" ? { feedback: "right" } : {}) })).workout;
    }
    const targetHistory = await call("/api/history?userId=target-e2e"); assert.equal(targetHistory.sessions.length, 1);
    assert.equal(targetHistory.sessions[0].sets.length, target.exercises.reduce((n: number, x: any) => n + x.completedSets, 0));
    assert.equal((await call("/api/workouts/active?userId=target-e2e")).workout, null);
    assert.equal((await call(`/api/workouts/${targetId}`)).workout.status, "completed");
  } finally { child.kill(); await new Promise(resolve => child.once("exit", resolve)); await rm(dbPath, { force: true }); }
});

test("exercise catalog IDs are unique", () => assert.equal(new Set(exercises.map(x => x.id)).size, exercises.length));

test("knowledge import keeps source identity and excludes unverified media", () => {
  const source = { id: "Alternate_Incline_Dumbbell_Curl", name: "Alternate Incline Dumbbell Curl", force: "pull", level: "beginner", mechanic: "isolation", equipment: "dumbbell", primaryMuscles: ["biceps"], secondaryMuscles: ["forearms"], instructions: ["Curl with control."], category: "strength", images: ["unverified.jpg"] };
  const records = convertUpstream([source, source]); assert.equal(records.length, 1); assertKnowledgeExercise(records[0]);
  assert.equal(records[0].sourceId, source.id); assert.equal(records[0].sourceLicense, "Unlicense"); assert.deepEqual(records[0].media, []);
  const reviewed = { ...records[0], coachingCues: ["Human reviewed cue"] };
  assert.deepEqual(convertUpstream([source], [reviewed]), [reviewed]);
});

test("home substitutions retain an easier push option", async () => {
  const w = (await createWorkout("我在家，想练30分钟，想练全身。", "substitution-test", new RuleLanguageModelProvider())).workout!;
  assert.ok(!w.exercises.some(x => x.exerciseId === "wall-push-up"));
  startWorkout(w); completeWarmup(w); w.runtime.currentExerciseIndex = 1; w.exercises[0].executionStatus = "completed"; w.exercises[1].executionStatus = "active";
  replaceExercise(w, "too_hard"); assert.equal(w.exercises[1].exerciseId, "wall-push-up");
});

test("knowledge recipe and evidence carry provenance", async () => {
  const recipe = sessionRecipe("general_fitness", 30, "home"); assert.equal(recipe.id, "general_full_body");
  assert.deepEqual(recipe.blocks.find(x => x.type === "main")?.movementPatterns, ["squat", "horizontal_push", "core_stability"]);
  assert.ok(recipe.blocks.every(x => x.workingSetBudget.length === 2));
  const manifest = JSON.parse(await readFile(new URL("../knowledge/sources/manifest.json", import.meta.url), "utf8"));
  const source = manifest.sources.find((x: any) => x.source_id === "yuhonas-free-exercise-db-a859101");
  assert.match(source.version, /^[0-9a-f]{40}$/); assert.equal(source.imported_at, null);
  assert.ok(!source.imported_fields.includes("images"));
  const evidence = JSON.parse(await readFile(new URL("../knowledge/evidence.json", import.meta.url), "utf8"));
  assert.ok(evidence.rules.every((x: any) => x.rule_id && x.source && x.evidence_type && x.version && x.implementation_note));
  const knownRules = new Set(evidence.rules.map((x: any) => x.rule_id));
  const workout = (await createWorkout("我在家，想练30分钟，想练全身。", "evidence-test", new RuleLanguageModelProvider())).workout!;
  assert.ok(workout.prescription.ruleIds.every(id => knownRules.has(id)));
});

test("safety gate remains independent", () => assert.equal(safetyGate("胸痛而且呼吸困难").allowed, false));

test("experience: high attention never plays entertainment", () => { const w = fresh(); configureExperience(w, { mode: "content" }); w.exercises[0].attentionLevel = "high"; startWorkout(w); const d = experienceDirective(w); assert.equal(d.kind, "training"); assert.equal(d.action, "pause"); });
test("experience: low attention permits content", () => { const w = fresh(); configureExperience(w, { mode: "content" }); w.exercises[0].attentionLevel = "low"; startWorkout(w); assert.equal(experienceDirective(w).kind, "content"); });
test("experience: rest permits content", () => { const w = fresh(); configureExperience(w, { mode: "content" }); startWorkout(w); setFeedback(w); assert.equal(experienceDirective(w).kind, "content"); assert.equal(w.experience?.playback, "playing"); });
test("experience: next set pauses medium-attention content", () => { const w = fresh(); configureExperience(w, { mode: "content" }); startWorkout(w); setFeedback(w); completeRest(w); assert.equal(w.experience?.playback, "paused"); assert.equal(experienceDirective(w).kind, "training"); });
test("experience: safety immediately stops content", () => { const w = fresh(); configureExperience(w, { mode: "content" }); const d = controlExperience(w, "safety"); assert.equal(d.priority, 4); assert.equal(d.action, "stop"); assert.equal(w.experience?.playback, "stopped"); });
test("experience: user disable prevents future content", () => { const w = fresh(); configureExperience(w, { mode: "content" }); controlExperience(w, "off"); w.status = "resting"; assert.notEqual(experienceDirective(w).kind, "content"); assert.equal(w.experience?.contentDisabled, true); });
test("experience: queue resumes instead of restarting", () => { const w = fresh(); configureExperience(w, { mode: "content", topic: "history" }); const first = w.experience!.queue[0].id; advanceExperienceSegment(w, 5); w.status = "resting"; const d = experienceDirective(w); assert.equal(d.segmentId, first); assert.equal(d.resumeOffsetSeconds, 5); });
test("experience: priority order is safety then training then interaction then content", () => { const w = fresh(); configureExperience(w, { mode: "content" }); w.status = "resting"; const content = experienceDirective(w); const interaction = experienceDirective(w, { userInteraction: "你好" }); w.status = "exercise_active"; w.exercises[0].attentionLevel = "high"; const training = experienceDirective(w); const safety = experienceDirective(w, { safetyEvent: "pain" }); assert.deepEqual([safety.priority, training.priority, interaction.priority, content.priority], [4, 3, 2, 1]); });
test("experience: training instruction interrupts content", () => { const w = fresh(); configureExperience(w, { mode: "content" }); w.status = "resting"; assert.equal(experienceDirective(w).kind, "content"); w.status = "exercise_active"; w.exercises[0].attentionLevel = "medium"; assert.equal(experienceDirective(w).kind, "training"); });
test("experiment: perceived duration is saved and ratio is calculated", () => { const w = fresh(); w.runtime.activeWorkoutMs = 20 * 60000; const r = createExperimentRecord(w, { perceivedDurationMinutes: 14 }); assert.equal(r.perceivedDurationMinutes, 14); assert.equal(r.durationPerceptionRatio, .7); assert.equal(r.perceivedTimeDifference, 6); });
test("experiment: boredom is saved", () => assert.equal(createExperimentRecord(fresh(), { boredomScore: 3 }).boredomScore, 3));
test("experiment: aversiveness is saved", () => assert.equal(createExperimentRecord(fresh(), { aversivenessScore: 4 }).aversivenessScore, 4));
test("experiment: physical fatigue is independent", () => { const r = createExperimentRecord(fresh(), { aversivenessScore: 2, physicalFatigueScore: 9 }); assert.equal(r.aversivenessScore, 2); assert.equal(r.physicalFatigueScore, 9); });
test("experiment: reuse intent is saved", () => assert.equal(createExperimentRecord(fresh(), { reuseIntentScore: 8 }).reuseIntentScore, 8));
test("experiment: session saves experience mode", () => { const w = fresh(); configureExperience(w, { mode: "companion" }); assert.equal(createExperimentRecord(w).experienceMode, "companion"); });
test("experiment: CSV and JSON exports contain required fields", () => { const w = fresh(); configureExperience(w, { mode: "content" }); const doseOutcomes = [{ exerciseId: "squat", planned: { sets: 3, targetReps: "8-10", targetRir: 2, restSeconds: 90 }, actual: { setRecords: [], completedSets: 0, executionStatus: "skipped" as const }, recommendation: { action: "calibrate" as const, reasonCodes: ["low_confidence"], confidence: "low" as const } }]; const row = createExperimentRecord(w, { perceivedDurationMinutes: 12, boredomScore: 3 }, doseOutcomes); const output = experimentRecordsCsv([row]), json = JSON.stringify([row]); assert.match(output, /userId,sessionId,experienceMode/); assert.match(output, /doseOutcomes/); assert.match(output, /"content"/); assert.match(json, /"boredomScore":3/); assert.match(json, /"exerciseId":"squat"/); });
test("experience: TTS provider failure never affects training", async () => { const tts = new TtsSpeechQueue({ name: "broken", play() { return Promise.reject(Error("offline")); }, pause() { throw Error("offline"); }, resume() { throw Error("offline"); }, stop() { throw Error("offline"); } }); tts.enqueue("test"); tts.pause(); tts.resume(); tts.stop(); await Promise.resolve(); const w = fresh(); startWorkout(w); assert.equal(w.status, "exercise_active"); });
test("experience: disabled engine preserves Phase 0-5 behavior", () => { const w = fresh(); const before = { prescription: JSON.stringify(w.prescription), weights: w.exercises.map(x => x.currentWeight) }; configureExperience(w, { mode: "minimal" }); startWorkout(w); markSetComplete(w); submitSetFeedback(w, { actualReps: 10, actualWeight: w.exercises[0].currentWeight, rir: 2, feedback: "right" }); assert.equal(JSON.stringify(w.prescription), before.prescription); assert.deepEqual(w.exercises.map(x => x.currentWeight), before.weights); assert.equal(w.status, "resting"); });
test("experience: less talkative companion reduces rest frequency", () => { const w = fresh(); configureExperience(w, { mode: "companion" }); startWorkout(w); setFeedback(w); controlExperience(w, "less"); assert.equal(w.experience?.talkativeness, "low"); assert.equal(experienceDirective(w).kind, "none"); });
test("experiment hardening: data origin is explicit and exported", () => { const w = fresh(); configureExperience(w, { mode: "content", dataOrigin: "human" }); const human = createExperimentRecord(w), legacy = createExperimentRecord(fresh()); assert.equal(human.dataOrigin, "human"); assert.equal(legacy.dataOrigin, "demo"); assert.match(experimentRecordsCsv([human]), /dataOrigin/); assert.match(experimentRecordsCsv([human]), /"human"/); });
test("legacy sessions without runtime events remain valid training facts", () => { const legacy = { ...fresh(), runtime: undefined } as unknown as WorkoutSession; assert.doesNotThrow(() => buildUserTrainingModel("u1", { sessions: [legacy], sets: [] })); });
test("frontend completed state routes to the complete renderer", async () => { const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8"); assert.match(html, /completed\s*:\s*complete/); });

test("7B.2.4 自重动作负重归一:居家计划不出现 0 公斤(0=自重=undefined)", () => {
  const home = { userId: "u1", rawInput: "", availableDurationMinutes: 20, durationMinutes: 20, environment: "home" as const, gymId: undefined, focus: "chest", fatigue: "low" as const, soreness: [], restrictions: [] };
  const workout = generateWorkout(home);
  for (const x of workout.exercises) {
    assert.notEqual(x.currentWeight, 0, `${x.name} 不应为 0 公斤`);
    if (x.currentWeight === undefined) assert.equal(x.weightUnit, undefined, "自重动作不应带 kg 单位");
  }
});

test("7B.2.4 酸痛部位用户可见文本为中文名", () => {
  const ctx = { userId: "u1", rawInput: "我在家，20分钟，练胸，肩膀有点酸", availableDurationMinutes: 20, durationMinutes: 20, environment: "home" as const, gymId: undefined, focus: "chest", fatigue: "low" as const, soreness: ["shoulder"], restrictions: [] };
  const workout = generateWorkout(ctx);
  assert.ok(workout.safetyNotes.length > 0, "酸痛应产生 safetyNotes");
  assert.ok(workout.safetyNotes[0]!.includes("肩"), `应含中文部位: ${workout.safetyNotes[0]}`);
  assert.ok(!workout.safetyNotes[0]!.includes("shoulder"), `不得泄露英文枚举: ${workout.safetyNotes[0]}`);
});

// ── B2/B5/B9(2026-11-09):剂量与组数的三个边界 ─────────────────────
test("B2: 中断场次不当作剂量基准(不永久砍量)", () => {
  const at = new Date(Date.now() - 2 * 86400000).toISOString(), session = fresh(), def = exercises.find(x => x.id === "lat-pulldown-ex")!;
  session.sessionId = "aborted-1"; session.status = "aborted"; session.runtime.completedAt = at;
  session.exercises = [{ ...session.exercises[0]!, exerciseId: def.id, name: def.name, sets: 3, targetReps: "8-10", executionStatus: "active", completedSets: 1 }];
  const sets: SetRecord[] = [{ id: "aborted-1-1", sessionId: "aborted-1", workoutExerciseId: session.exercises[0]!.id, exerciseId: def.id, setNumber: 1, targetWeight: 30, actualWeight: 30, targetReps: "8-10", actualReps: 8, rir: 2, feedback: "right", pain: false, completedAt: at }];
  const facts: TrainingFacts = { sessions: [session], sets }, model = buildUserTrainingModel("u1", facts, "normal", at);
  const rec = recommendExercise(def, model, facts, context as any);
  assert.equal(rec.sets, def.defaultSets, `只做 1 组就退出的场次不该把下次排成 minSets(实际 ${rec.sets})`);
  assert.ok(rec.reasonCodes.includes("interrupted_session_not_capacity_failure"));
});

test("B5: 换动作扣掉已完成组数,不超处方", () => {
  const w = fresh(); startWorkout(w); if (w.status === "warming_up") completeWarmup(w);
  const planned = w.exercises[0]!.sets;
  markSetComplete(w); submitSetFeedback(w, { feedback: "right" }); completeRest(w);
  assert.equal(w.exercises[0]!.completedSets, 1);
  replaceExercise(w, "equipment_busy");
  const after = w.exercises[0]!;
  assert.equal(after.completedSets, 0, "新动作自己的计数从 0 开始");
  assert.equal(after.sets, Math.max(1, planned - 1), `换动作只补剩余组数(实际 ${after.sets},原计划 ${planned})`);
  assert.equal(w.runtime.currentSetNumber, 1, "新动作从第 1 组重新编号");
});

test("B9: 越界时长不进规则层(走澄清,不生成畸形课)", async () => {
  const i = new ContextInterpreter(new RuleLanguageModelProvider(), null);
  for (const input of ["我有 0 分钟，在家随便练练", "我有 999 分钟，在家练全身"]) {
    const r = await i.interpret(input, "u9");
    assert.equal(r.status, "needs_clarification", `${input} → ${r.status}`);
    assert.ok(r.context?.missingCriticalFields.includes("availableDurationMinutes"), input);
  }
  const clamped = generateWorkout({ ...(context as any), availableDurationMinutes: 0, durationMinutes: 0 });
  assert.ok(clamped.availableDurationMinutes >= 5, `防御性夹取必须生效,实际 ${clamped.availableDurationMinutes}`);
});
