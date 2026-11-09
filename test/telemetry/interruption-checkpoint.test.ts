// 7B.2.1 W7:interruption 检查点单元测试(注入超期,走生产入口 RuntimeTelemetry.onAction)
// 规格 §5:仅 deadline 状态(pre_set/resting/transition)超期才计;等待用户输入的状态永不计。
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrateTelemetry } from "../../src/telemetry/index.ts";
import { RuntimeTelemetry } from "../../src/telemetry/bridge.ts";
import { completeWarmup, enableCoach, generateWorkout, markSetComplete, startWorkout, submitSetFeedback } from "../../src/core.ts";
import type { WorkoutSession } from "../../src/core.ts";
import { createCoachState } from "../../src/coach-runtime.ts";
import type { RuntimeBeforeSnapshot } from "../../src/telemetry/bridge.ts";

const context = { userId: "u1", rawInput: "", availableDurationMinutes: 40, durationMinutes: 40, environment: "gym" as const, gymId: "test-gym", focus: "back", fatigue: "low" as const, soreness: [], restrictions: [] };
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

function setup(): { db: DatabaseSync; telemetry: RuntimeTelemetry; session: WorkoutSession } {
  const db = new DatabaseSync(":memory:");
  migrateTelemetry(db);
  const session = generateWorkout(context);
  startWorkout(session);
  if (session.status === "warming_up") completeWarmup(session);
  assert.equal(session.status, "exercise_active");
  db.prepare("INSERT INTO workout_sessions (id, planned_workout_id, started_at, ended_at, status, app_version, next_event_seq) VALUES (?, NULL, ?, NULL, 'active', 'test', 1)").run(session.sessionId, Date.now());
  return { db, telemetry: new RuntimeTelemetry(db), session };
}

const snapshot = (patch: Partial<RuntimeBeforeSnapshot>): RuntimeBeforeSnapshot => ({
  status: "exercise_active", restEndsAt: null, phaseEndsAt: null, coachPhase: null, coachPhaseStartedAt: null, ...patch,
});

const rows = (db: DatabaseSync) =>
  db.prepare("SELECT seq, actor, modality, action, runtime_state, error_json FROM interaction_events ORDER BY seq").all() as any[];

test("resting stall: late touch rest_complete records interruption.ui before the action", () => {
  const { db, telemetry, session } = setup();
  markSetComplete(session);
  submitSetFeedback(session, { feedback: "right", actualReps: 8 });
  assert.equal(session.status, "resting");
  const stalledRest = iso(-60_000); // 注入:定时器 60 秒前就应触发但从未推进
  session.runtime.restEndsAt = stalledRest;
  telemetry.onAction(session, { type: "rest_complete", source: "touch" }, { before: snapshot({ status: "resting", restEndsAt: stalledRest }) });
  const events = rows(db);
  assert.equal(events[0].action, "system.interruption.ui");
  assert.equal(events[0].actor, "system");
  assert.equal(events[0].modality, "system");
  assert.equal(events[0].runtime_state, "resting");
  assert.match(events[0].error_json, /auto_transition_overdue/);
  assert.equal(events[1].action, "touch.button.skip_rest");
});

test("resting stall: late voice command records interruption.voice", () => {
  const { db, telemetry, session } = setup();
  markSetComplete(session);
  submitSetFeedback(session, { feedback: "right", actualReps: 8 });
  const stalledRest = iso(-45_000);
  session.runtime.restEndsAt = stalledRest;
  telemetry.onAction(session, { type: "rest_complete", source: "voice" }, { before: snapshot({ status: "resting", restEndsAt: stalledRest }) });
  const events = rows(db);
  assert.equal(events[0].action, "system.interruption.voice");
  assert.equal(events[1].action, "voice.command.rest_control");
});

test("resting within grace (1s past deadline) records no interruption", () => {
  const { db, telemetry, session } = setup();
  markSetComplete(session);
  submitSetFeedback(session, { feedback: "right", actualReps: 8 });
  const barelyLate = iso(-1_000); // < 3s 阈值:正常定时器抖动,不是中断
  telemetry.onAction(session, { type: "rest_complete", source: "auto" }, { before: snapshot({ status: "resting", restEndsAt: barelyLate }) });
  const events = rows(db);
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "system.autostart.rest_end");
});

test("transition stall: late warmup_complete records interruption (transition state)", () => {
  const { db, telemetry, session } = setup();
  const stalledPhase = iso(-60_000);
  session.status = "warming_up";
  session.runtime.phaseEndsAt = stalledPhase;
  telemetry.onAction(session, { type: "warmup_complete" }, { before: snapshot({ status: "warming_up", phaseEndsAt: stalledPhase }) });
  const events = rows(db);
  assert.equal(events[0].action, "system.interruption.ui");
  assert.equal(events[0].runtime_state, "transition");
  assert.equal(events[1].action, "touch.button.warmup_complete");
});

test("pre_set stall: narration stuck past TTS allowance records interruption", () => {
  const { db, telemetry, session } = setup();
  enableCoach(session);
  session.runtime.coach = { ...createCoachState(iso(0)), phase: "START_SET", phaseStartedAt: iso(-60_000) };
  telemetry.onAction(session, { type: "complete_set", source: "voice" }, { before: snapshot({ status: "exercise_active", coachPhase: "START_SET", coachPhaseStartedAt: iso(-60_000) }) });
  const events = rows(db);
  assert.equal(events[0].action, "system.interruption.voice");
  assert.equal(events[0].runtime_state, "pre_set");
  assert.equal(events[1].action, "voice.command.adjust");
});

test("pre_set anti-false-positive: normal TTS narration window (8s) records no interruption", () => {
  const { db, telemetry, session } = setup();
  enableCoach(session);
  session.runtime.coach = { ...createCoachState(iso(0)), phase: "START_SET", phaseStartedAt: iso(-8_000) }; // 播报链仍在正常进行
  telemetry.onAction(session, { type: "coach_event", event: { type: "guidance_started" } }, { before: snapshot({ status: "exercise_active", coachPhase: "START_SET", coachPhaseStartedAt: iso(-8_000) }) });
  const events = rows(db);
  assert.equal(events.length, 0, "guidance_started 是流程标记不落交互,且不得误报 interruption");
});

test("post_set / paused never record interruption (waiting for user is legal)", () => {
  const { db, telemetry, session } = setup();
  markSetComplete(session);
  assert.equal(session.status, "set_feedback");
  telemetry.onAction(session, { type: "feedback", feedback: "right", actualReps: 8 }, { before: snapshot({ status: "set_feedback" }) });
  const afterFeedback = rows(db).map(x => x.action);
  assert.ok(!afterFeedback.some(x => x.startsWith("system.interruption.")));
});
