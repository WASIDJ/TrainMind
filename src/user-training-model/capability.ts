export type CapabilityConfidence = "low" | "medium" | "high";
export type CapabilityStaleness = "recent" | "stale" | "very_stale" | "unknown";
export interface CapabilityExerciseInput { id: string; movementPattern: string; difficulty: string; unilateral?: boolean; equipmentIds?: string[] }
export interface CapabilitySetInput { sessionId: string; exerciseId: string; setNumber: number; actualReps: number; targetReps: string; actualWeight?: number; actualDurationSeconds?: number; rir?: number; rpe?: number; feedback: string; pain: boolean; completedAt: string }
export interface CapabilityWorkoutInput { sessionId: string; status: string; createdAt?: string; completedAt?: string; exercises: Array<{ exerciseId: string; sets: number; targetReps: string; executionStatus: string; recommendation?: { action?: string; progressionStep?: string }; skippedReason?: string }>; runtime?: { completedAt?: string; events?: Array<{ type: string; at?: string; details?: Record<string, unknown> }> } }
export interface ExerciseCapabilityEstimate {
  exerciseId: string; movementPattern: string; confidence: CapabilityConfidence; confidenceReasons: string[];
  validSessionCount: number; validSetCount: number; cleanSessionCount: number; interruptedSessionCount: number;
  completedSetsInLatestSession: number; estimatedWorkingReps?: number; observedLoadKg?: number; latestRir?: number; latestRpe?: number;
  latestDifficulty?: string; recentPain: boolean; lastPerformedAt?: string; daysSinceLastExercise?: number; staleness: CapabilityStaleness;
  easySessionCount: number; hardSessionCount: number; failedSessionCount: number; maxCleanSetsPerSession: number;
  recentOutcomes: Array<{ sessionId: string; difficulty: "easy" | "moderate" | "hard" | "failed" | "pain" | "unknown"; completed: boolean; date: string; sets: number; targetReps?: string; loadKg?: number; recommendationStep?: string }>;
}
export interface MovementCapabilityEstimate {
  movementPattern: string; compatibleExerciseIds: string[]; validSessionCount: number; validSetCount: number;
  confidence: CapabilityConfidence; maxCleanSetsPerSession: number; lastPerformedAt?: string; staleness: CapabilityStaleness;
}
export interface CapabilityEstimates { exercise: Record<string, ExerciseCapabilityEstimate>; movement: Record<string, MovementCapabilityEstimate>; volumeToleranceByPattern: Record<string, { cleanSetsLast7Days: number; maxCleanSetsPerSession: number; confidence: CapabilityConfidence }>; recoveryTendency: { meanReportedFatigue?: number; recentHighFatigue: boolean; confidence: CapabilityConfidence }; interruptionCounts: Record<string, number> }

const dayMs = 86_400_000;
const daysSince = (date: string | undefined, now: string) => date ? Math.max(0, Math.floor((Date.parse(now) - Date.parse(date)) / dayMs)) : undefined;
export function stalenessFor(days: number | undefined): CapabilityStaleness { return days === undefined ? "unknown" : days >= 90 ? "very_stale" : days > 30 ? "stale" : "recent"; }
function confidenceFor(sessions: number, days: number | undefined, consistent: boolean) {
  if (!sessions || days === undefined || days > 90) return "low" as const;
  if (sessions >= 3 && days <= 30 && consistent) return "high" as const;
  if (sessions >= 2 && days <= 60) return "medium" as const;
  return "low" as const;
}
const isTimedTarget = (targetReps: string) => /秒|分钟/.test(targetReps);
// B3(2026-11-09):时长型动作的 targetReps 形如"300秒"/"9分钟",而按完成键结组的
// actualReps 记 0(见 core.ts submitSetFeedback)。旧实现直接拿 0 去比 300,
// 判定恒为 failed → 回退分支把目标算成"300-298秒"。这里按单位分流:
// 有 actualDurationSeconds 就比时长,没有就只认 feedback,绝不拿秒当次。
function shortOfTarget(x: CapabilitySetInput): boolean {
  const target = Number(x.targetReps.match(/\d+/)?.[0] ?? 0);
  if (isTimedTarget(x.targetReps)) return typeof x.actualDurationSeconds === "number" && x.actualDurationSeconds < target;
  return x.actualReps < target;
}
function classify(sets: CapabilitySetInput[]): ExerciseCapabilityEstimate["recentOutcomes"][number]["difficulty"] {
  if (sets.some(x => x.pain || x.feedback === "pain")) return "pain";
  if (sets.some(x => x.feedback === "failed" || shortOfTarget(x))) return "failed";
  if (sets.some(x => x.feedback === "hard" || (x.rir !== undefined && x.rir <= 1) || (x.rpe !== undefined && x.rpe >= 9))) return "hard";
  if (sets.length && sets.every(x => x.feedback === "too_light" || (x.feedback === "right" && ((x.rir ?? 0) >= 4 || (x.rpe !== undefined && x.rpe <= 6))))) return "easy";
  return sets.length ? "moderate" : "unknown";
}
function compatible(source: CapabilityExerciseInput, target: CapabilityExerciseInput) {
  const levels = ["beginner", "intermediate", "advanced"], difference = Math.abs(levels.indexOf(source.difficulty) - levels.indexOf(target.difficulty));
  return source.id !== target.id && source.movementPattern === target.movementPattern && difference <= 1 && Boolean(source.unilateral) === Boolean(target.unilateral);
}

export function buildCapabilityEstimates(input: { exercises: CapabilityExerciseInput[]; sessions: CapabilityWorkoutInput[]; sets: CapabilitySetInput[]; trainingRecords?: Array<{ sessionId: string; completedAt?: string; perceivedFatigue?: number; physicalFatigueScore?: number }>; now?: string }): CapabilityEstimates {
  const now = input.now ?? new Date().toISOString(), dateOf = (session: CapabilityWorkoutInput) => session.completedAt ?? session.runtime?.completedAt ?? session.createdAt ?? "", sessions = [...input.sessions].sort((a, b) => dateOf(b).localeCompare(dateOf(a))), bySession = new Map(sessions.map(x => [x.sessionId, x]));
  const setSessions = (exerciseId: string) => [...new Set(input.sets.filter(x => x.exerciseId === exerciseId).map(x => x.sessionId))].map(id => bySession.get(id)).filter((x): x is CapabilityWorkoutInput => Boolean(x)).sort((a, b) => dateOf(b).localeCompare(dateOf(a)));
  const exercise: CapabilityEstimates["exercise"] = {};
  for (const definition of input.exercises) {
    const attempts = setSessions(definition.id).slice(0, 5), outcomes = attempts.map(session => {
      const sessionSets = input.sets.filter(x => x.sessionId === session.sessionId && x.exerciseId === definition.id).sort((a, b) => a.setNumber - b.setNumber);
      const workoutExercise = session.exercises.find(x => x.exerciseId === definition.id), completed = session.status === "completed" && (!workoutExercise || !["skipped", "replaced", "pain"].includes(workoutExercise.executionStatus));
      const interruption = !completed || (session.runtime?.events ?? []).some(event => event.type === "workout_aborted" || event.type === "exercise_skipped" || event.type === "exercise_replaced");
      return { session, sets: sessionSets, completed, interruption, difficulty: classify(sessionSets), workoutExercise };
    });
    const valid = outcomes.filter(x => x.completed && x.difficulty !== "pain" && x.sets.length > 0), latest = valid[0], allSets = latest?.sets ?? [];
    const recentDate = outcomes[0] ? dateOf(outcomes[0].session) : undefined, days = daysSince(recentDate, now), staleness = stalenessFor(days);
    const cleanSessionCount = valid.length, easySessionCount = outcomes.filter(x => x.completed && x.difficulty === "easy").length, hardSessionCount = outcomes.filter(x => x.completed && x.difficulty === "hard").length, failedSessionCount = outcomes.filter(x => x.difficulty === "failed").length;
    const last3 = outcomes.slice(0, 3).filter(x => x.completed).map(x => x.difficulty), consistent = last3.length < 2 || last3.every(x => x === last3[0]);
    const completeData = valid.slice(0, 3).every(x => x.sets.every(set => Number.isFinite(set.actualReps) && Boolean(set.feedback) && (definition.equipmentIds?.includes("bodyweight") || Number.isFinite(set.actualWeight)) && (set.rir !== undefined || set.rpe !== undefined || set.feedback !== "right")));
    const confidence = confidenceFor(cleanSessionCount, days, consistent && completeData), confidenceReasons = [cleanSessionCount >= 3 ? "three_or_more_clean_sessions" : cleanSessionCount >= 2 ? "repeated_clean_sessions" : cleanSessionCount ? "single_clean_session" : "no_clean_sessions", days === undefined ? "date_missing" : days > 90 ? "older_than_90_days" : days > 30 ? "older_than_30_days" : "recent_evidence", consistent ? "recent_results_consistent" : "recent_results_mixed", completeData ? "dose_and_effort_data_complete" : "dose_or_effort_data_partial"];
    const recentPainSet = input.sets.filter(x => x.exerciseId === definition.id && (daysSince(x.completedAt, now) ?? Infinity) <= 30 && (x.pain || x.feedback === "pain")).sort((a, b) => b.completedAt.localeCompare(a.completedAt))[0];
    // B3:时长型组记的是 0 次,拉进均值会把"工作次数"算成 0;只对次数型取均值
    const repSets = allSets.filter(x => !isTimedTarget(x.targetReps));
    const latestSet = allSets.at(-1), reps = repSets.length ? Math.round(repSets.reduce((sum, x) => sum + x.actualReps, 0) / repSets.length) : undefined;
    exercise[definition.id] = { exerciseId: definition.id, movementPattern: definition.movementPattern, confidence, confidenceReasons, validSessionCount: outcomes.filter(x => x.sets.length > 0).length, validSetCount: valid.reduce((n, x) => n + x.sets.length, 0), cleanSessionCount, interruptedSessionCount: outcomes.filter(x => x.interruption).length, completedSetsInLatestSession: allSets.length, estimatedWorkingReps: reps, observedLoadKg: [...allSets].reverse().find(x => x.actualWeight !== undefined)?.actualWeight, latestRir: latestSet?.rir, latestRpe: latestSet?.rpe, latestDifficulty: latest?.difficulty ?? outcomes[0]?.difficulty, recentPain: Boolean(recentPainSet), lastPerformedAt: recentDate, daysSinceLastExercise: days, staleness, easySessionCount, hardSessionCount, failedSessionCount, maxCleanSetsPerSession: valid.reduce((n, x) => Math.max(n, x.sets.length), 0), recentOutcomes: outcomes.slice(0, 5).map(x => ({ sessionId: x.session.sessionId, difficulty: x.difficulty, completed: x.completed, date: dateOf(x.session), sets: x.sets.length, targetReps: x.workoutExercise?.targetReps, loadKg: [...x.sets].reverse().find(set => set.actualWeight !== undefined)?.actualWeight, recommendationStep: x.workoutExercise?.recommendation?.progressionStep })) };
  }
  const movement: CapabilityEstimates["movement"] = {};
  for (const pattern of new Set(input.exercises.map(x => x.movementPattern))) {
    const ids = new Set(input.exercises.filter(x => x.movementPattern === pattern).map(x => x.id)), compatibleIds = input.exercises.filter(target => input.exercises.some(source => compatible(source, target))).map(x => x.id);
    const relevant = Object.values(exercise).filter(x => ids.has(x.exerciseId) && x.cleanSessionCount && x.staleness !== "very_stale"), last = relevant.map(x => x.lastPerformedAt ?? "").sort().at(-1), dates = daysSince(last, now), cleanSessionIds = new Set(relevant.flatMap(x => x.recentOutcomes.filter(outcome => outcome.completed && outcome.difficulty !== "pain").map(outcome => outcome.sessionId))), sessionsCount = cleanSessionIds.size, consistent = relevant.every(x => x.confidence !== "low");
    movement[pattern] = { movementPattern: pattern, compatibleExerciseIds: [...ids].filter(id => compatibleIds.includes(id)), validSessionCount: sessionsCount, validSetCount: relevant.reduce((n, x) => n + x.validSetCount, 0), confidence: confidenceFor(sessionsCount, dates, consistent), maxCleanSetsPerSession: relevant.reduce((n, x) => Math.max(n, x.maxCleanSetsPerSession), 0), lastPerformedAt: last, staleness: stalenessFor(dates) };
  }
  const recentSets = input.sets.filter(x => (daysSince(x.completedAt, now) ?? Infinity) <= 7 && !x.pain && bySession.get(x.sessionId)?.status === "completed"), volumeToleranceByPattern: CapabilityEstimates["volumeToleranceByPattern"] = {};
  for (const pattern of new Set(input.exercises.map(x => x.movementPattern))) {
    const ids = new Set(input.exercises.filter(x => x.movementPattern === pattern).map(x => x.id)), sets = recentSets.filter(x => ids.has(x.exerciseId));
    volumeToleranceByPattern[pattern] = { cleanSetsLast7Days: sets.length, maxCleanSetsPerSession: Math.max(0, ...Object.values(exercise).filter(x => ids.has(x.exerciseId)).map(x => x.maxCleanSetsPerSession)), confidence: movement[pattern].confidence };
  }
  const fatigue = (input.trainingRecords ?? []).map(x => ({ value: x.physicalFatigueScore ?? x.perceivedFatigue, days: daysSince(x.completedAt, now) })).filter((x): x is { value: number; days: number | undefined } => Number.isFinite(x.value) && (x.days ?? Infinity) <= 30).sort((a, b) => (a.days ?? Infinity) - (b.days ?? Infinity)).slice(0, 5), meanReportedFatigue = fatigue.length ? Number((fatigue.reduce((n, x) => n + x.value, 0) / fatigue.length).toFixed(1)) : undefined;
  const interruptionCounts: Record<string, number> = {};
  for (const session of input.sessions) for (const event of session.runtime?.events ?? []) if (["workout_aborted", "exercise_skipped", "exercise_replaced", "paused", "resumed"].includes(event.type)) { interruptionCounts[event.type] = (interruptionCounts[event.type] ?? 0) + 1; const reason = event.details?.reason; if (typeof reason === "string") interruptionCounts[`${event.type}:${reason}`] = (interruptionCounts[`${event.type}:${reason}`] ?? 0) + 1; }
  return { exercise, movement, volumeToleranceByPattern, recoveryTendency: { meanReportedFatigue, recentHighFatigue: fatigue.some(x => x.days !== undefined && x.days <= 3 && x.value >= 4), confidence: fatigue.length >= 3 ? "high" : "low" }, interruptionCounts };
}

export function compatibleMovementEvidence(candidate: CapabilityExerciseInput, exercises: CapabilityExerciseInput[], movement: CapabilityEstimates["movement"]) {
  const evidence = movement[candidate.movementPattern], compatibleSourceIds = exercises.filter(source => compatible(source, candidate) && evidence?.compatibleExerciseIds.includes(source.id)).map(x => x.id);
  return { compatible: compatibleSourceIds.length > 0 && evidence.validSessionCount > 0 && evidence.staleness !== "very_stale", sourceExerciseIds: compatibleSourceIds, confidence: evidence?.confidence ?? "low", staleness: evidence?.staleness ?? "unknown", validSessionCount: evidence?.validSessionCount ?? 0 };
}
