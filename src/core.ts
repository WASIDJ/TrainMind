import { randomUUID } from "node:crypto";
import { createCoachState, transitionCoach, parseCoachReport, AdjustmentPolicyV0, type CoachState, type CoachEvent, type CoachDirective, type CoachFeedback } from "./coach-runtime.ts";
import { existsSync, readFileSync } from "node:fs";
import { assertKnowledgeExercise, type KnowledgeExercise, type VoiceCues } from "../knowledge/schema.ts";
import { relationScore, substitutionGraph } from "../knowledge/substitutions.ts";
import { getGoalProfile, resolveRequiredStimulus } from "./training-knowledge/resolver.ts";
import type { DecisionReason, ExperienceLevel, KnowledgeGoal, RequiredStimulus } from "./training-knowledge/types.ts";
import { buildCapabilityEstimates, compatibleMovementEvidence, type CapabilityEstimates, type ExerciseCapabilityEstimate, type MovementCapabilityEstimate } from "./user-training-model/capability.ts";
import { buildLightExerciseIds, buildMuscleLedger, canonicalMuscle, MIN_SAME_MUSCLE_INTERVAL_HOURS, MIN_SAME_MUSCLE_INTERVAL_RULE_ID, WEEKLY_FREQUENCY_TARGET, type MuscleGroup } from "./muscles.ts";

export type Environment = "home" | "office" | "gym";
export type Intensity = "low" | "moderate" | "high";
export type TrainingGoal = "back_strength" | "chest_strength" | "upper_body" | "lower_body" | "general_fitness" | "mobility";
export type WorkoutState = "preview" | "active" | "warming_up" | "exercise_active" | "set_feedback" | "resting" | "cooling_down" | "paused" | "completed" | "aborted";
export type SetFeedback = "too_light" | "right" | "hard" | "failed" | "pain";
export type RecoveryState = "fresh" | "normal" | "fatigued" | "very_fatigued" | "unknown";
export type RecommendationAction = "calibrate" | "maintain" | "progress" | "regress" | "reduce_volume" | "substitute" | "avoid";
export type DataConfidence = "low" | "medium" | "high";
export type FieldSource = "explicit" | "inferred" | "profile" | "history" | "unknown";
export type AttentionLevel = "high" | "medium" | "low";
export type ExperienceMode = "minimal" | "content" | "companion";
export type ExperienceTopic = "AI" | "business" | "history" | "trivia" | "story";
export type DataOrigin = "human" | "automated_test" | "demo";
export type SessionPhase = "before_set" | "during_set" | "set_feedback" | "resting" | "transition" | "warmup" | "cooldown" | "completed";
export interface ExperienceContentSegment { id: string; topic: ExperienceTopic; text: string; estimatedDurationSeconds: number; targetDurationSeconds: number; continuationId?: string; continueNext: boolean; priority: 1 | 2 | 3 | 4; interruptible: boolean }
export interface ExperienceEvent { id: string; type: string; at: string; phase: SessionPhase; details?: Record<string, unknown> }
export interface ExperienceState { mode: ExperienceMode; initialMode: ExperienceMode; experimentGroup: ExperienceMode; dataOrigin: DataOrigin; topic: ExperienceTopic; talkativeness: "low" | "medium" | "high"; enabled: boolean; queue: ExperienceContentSegment[]; currentIndex: number; currentOffsetSeconds: number; playback: "idle" | "playing" | "paused" | "stopped"; contentSkipCount: number; contentDisabled: boolean; events: ExperienceEvent[] }
export interface ExperiencePreference { preferredMode: ExperienceMode; topics: ExperienceTopic[]; talkativeness: "low" | "medium" | "high"; contentDisabledCount: number; skippedTopics: Record<string, number> }
export interface TtsProvider { readonly name: string; play(text: string): Promise<void> | void; pause(): void; resume(): void; stop(): void }
export interface ExperienceSurvey { perceivedDurationMinutes?: number; boredomScore?: number; aversivenessScore?: number; physicalFatigueScore?: number; reuseIntentScore?: number }
export interface DoseOutcome { exerciseId: string; planned: { sets: number; targetReps: string; loadKg?: number; targetRir: number; restSeconds: number }; actual: { setRecords: Array<{ targetReps: string; actualReps: number; targetWeight?: number; actualWeight?: number; rir?: number; rpe?: number; feedback: SetFeedback; pain: boolean }>; completedSets: number; executionStatus: WorkoutExercise["executionStatus"]; skippedReason?: string }; recommendation: { action: RecommendationAction; reasonCodes: string[]; confidence: DataConfidence; capabilityAdjustment?: CapabilityAdjustment }; replacement?: { fromExerciseId?: string; reason?: string } }
export function createExperimentRecord(session: WorkoutSession, survey: ExperienceSurvey = {}, doseOutcomes: DoseOutcome[] = []) { const actualDurationMinutes = Number(((session.runtime.activeWorkoutMs || 0) / 60000).toFixed(2)), perceived = survey.perceivedDurationMinutes; return { userId: session.userId, sessionId: session.sessionId, experienceMode: session.experience?.initialMode ?? "minimal", experimentGroup: session.experience?.experimentGroup ?? "minimal", dataOrigin: session.experience?.dataOrigin ?? "demo", actualDurationMinutes, perceivedDurationMinutes: perceived, durationPerceptionRatio: perceived === undefined || actualDurationMinutes === 0 ? undefined : Number((perceived / actualDurationMinutes).toFixed(3)), perceivedTimeDifference: perceived === undefined ? undefined : Number((actualDurationMinutes - perceived).toFixed(2)), boredomScore: survey.boredomScore, aversivenessScore: survey.aversivenessScore, physicalFatigueScore: survey.physicalFatigueScore, reuseIntentScore: survey.reuseIntentScore, completed: session.status === "completed", earlyExit: session.status === "aborted", contentSkipCount: session.experience?.contentSkipCount ?? 0, contentDisabled: session.experience?.contentDisabled ?? false, doseOutcomes, createdAt: session.createdAt }; }
export function experimentRecordsCsv(rows: ReturnType<typeof createExperimentRecord>[]) { const keys = ["userId","sessionId","experienceMode","experimentGroup","dataOrigin","actualDurationMinutes","perceivedDurationMinutes","durationPerceptionRatio","perceivedTimeDifference","boredomScore","aversivenessScore","physicalFatigueScore","reuseIntentScore","completed","earlyExit","contentSkipCount","contentDisabled","doseOutcomes"] as const; const cell = (v: unknown) => `"${String(v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : v).replaceAll('"','""')}"`; return [keys.join(","), ...rows.map(row => keys.map(k => cell(row[k])).join(","))].join("\n"); }
export interface FieldEvidence<T> { value: T; confidence: DataConfidence; source: FieldSource }
export interface ContextEnvironment { type: Environment | "unknown"; gymId?: string }
export interface ContextGoal { type: "back" | "chest" | "upper_body" | "lower_body" | "general" | "mobility" | "unknown"; priority: string | null }
export interface SorenessSignal { area: string; level: "mild" | "marked" | "unknown" }
export interface PainSignal { area: string; severity: "unspecified" | "severe"; rawText: string }
export interface PreviousTrainingContext { status: "reported" | "unknown"; when?: "yesterday" | "recent"; areas: string[] }
export interface User { id: string; createdAt: string }
export interface UserProfile { userId: string; experienceLevel?: "beginner" | "intermediate" | "advanced"; goals: TrainingGoal[]; preferredEnvironments: Environment[]; availableEquipmentIds: string[]; dislikedExerciseIds: string[]; unavailableExerciseIds: string[]; knownLimitations: string[] }
export interface Equipment { id: string; name: string; type: string; minWeightKg?: number; maxWeightKg?: number; incrementKg?: number; availableWeightsKg?: number[] }
export interface Gym { id: string; name: string }
export interface GymEquipment { gymId: string; equipmentId: string; available: boolean }
export type MovementPattern = "vertical_pull" | "horizontal_pull" | "horizontal_push" | "vertical_push" | "squat" | "hinge" | "lunge" | "hip_extension" | "calf" | "arm_curl" | "arm_extension" | "scapular_control" | "core_stability" | "core_flexion_rotation" | "conditioning" | "mobility";
export interface Exercise { id: string; name: string; aliases?: string[]; movementPattern: MovementPattern; primaryMuscles: string[]; secondaryMuscles: string[]; equipmentIds: string[]; requiredEquipmentIds?: string[]; environments: Environment[]; difficulty: "beginner" | "intermediate" | "advanced"; unilateral?: boolean; defaultSets: number; minSets: number; maxSets: number; defaultReps: string; defaultWeightKg?: number; repOrTimeBased?: "reps" | "time"; attentionLevel: "low" | "medium" | "high"; substitutionTags: string[]; contraindicationTags: string[]; instructions: string[]; bodyRegion?: string | null; position?: string | null; impactLevel?: "low" | "moderate" | "high" | null; compoundOrIsolation?: string | null; progressions?: string[]; regressions?: string[]; voiceCues?: VoiceCues; source?: string; sourceId?: string; sourceCommit?: string; sourceLicense?: string; attributionRequired?: boolean }
export interface SessionContext { userId: string; rawInput: string; availableDurationMinutes: number; durationMinutes: number; durationIntent?: "target" | "maximum"; environment: Environment; gymId?: string; focus?: string; fatigue: "low" | "moderate" | "high"; recoveryState: RecoveryState; experienceLevel?: ExperienceLevel; availableEquipmentIds?: string[]; soreness: string[]; restrictions: string[]; intensityPreference?: Intensity; environmentContext: ContextEnvironment; goalContext: ContextGoal; recovery: { overall: RecoveryState; soreness: SorenessSignal[] }; constraints: { avoidExercises: string[]; avoidMovements: string[]; noJumping: boolean; noiseSensitive: boolean }; preferences: { requestedExercises: string[]; excludedExercises: string[] }; painSignals: PainSignal[]; previousTraining: PreviousTrainingContext; missingCriticalFields: string[]; fieldEvidence: Record<string, FieldEvidence<unknown>> }
export interface ExercisePerformance { userId: string; exerciseId: string; performedAt: string; weightKg?: number; reps: number; sets: number; rir?: number; rpe?: number; completed: boolean; pain: boolean; perceivedDifficulty?: SetFeedback }
export interface TrainingRecord { id: string; userId: string; sessionId: string; startedAt: string; completedAt?: string; elapsedClockMs: number; activeWorkoutMs: number; perceivedFatigue?: number; physicalFatigueScore?: number; suitability?: number; discomfort?: boolean; perceivedDurationMinutes?: number; doseOutcomes?: DoseOutcome[] }
export interface SetRecord { id: string; sessionId: string; workoutExerciseId: string; exerciseId: string; setNumber: number; targetWeight?: number; actualWeight?: number; targetReps: string; actualReps: number; /** 次数来源:counted=系统报数累计 / reported=学员口报 / assumed=系统按目标推定(不是测量值,进步统计一律排除) */ actualRepsSource?: "counted" | "reported" | "assumed"; actualDurationSeconds?: number; rir?: number; rpe?: number; feedback: SetFeedback; pain: boolean; completedAt: string }
export interface CapabilityAdjustment { adjustment: string; from: { sets: number; repRange: string; loadKg?: number; restSeconds?: number; targetRir?: number }; to: { sets: number; repRange: string; loadKg?: number; restSeconds?: number; targetRir?: number }; evidence: string[]; confidence: DataConfidence; modelSource: "exercise" | "movement_pattern" | "experience_default"; ruleId: string }
export interface ExerciseRecommendation { exerciseId: string; weightKg?: number; repRange: string; sets: number; targetRir: number; confidence: DataConfidence; action: RecommendationAction; reasonCodes: string[]; userExplanation: string; calibrationSet: boolean; progressionStep?: "load" | "repetitions" | "difficulty"; progressionExerciseId?: string; knowledgeRuleIds?: string[]; capabilityAdjustment?: CapabilityAdjustment }
export interface WorkoutExercise { id: string; exerciseId: string; name: string; attentionLevel: AttentionLevel; unilateral?: boolean; equipmentId?: string; sets: number; targetReps: string; repOrTimeBased?: "reps" | "time"; recommendedWeight?: number; currentWeight?: number; weightUnit?: "kg"; restSeconds: number; targetRir: number; recommendation: ExerciseRecommendation; instructions: string[]; voiceCues?: VoiceCues; source?: string; sourceId?: string; sourceCommit?: string; sourceLicense?: string; attributionRequired?: boolean; alternatives: string[]; rationale: string; executionStatus: "pending" | "active" | "completed" | "skipped" | "pain" | "replaced"; completedSets: number; skippedReason?: string; originalExerciseId?: string; replacementReason?: string }
export interface WorkoutEvent { id: string; type: string; at: string; exerciseId?: string; details?: Record<string, unknown> }
export interface WorkoutRuntime { currentExerciseIndex: number; currentSetNumber: number; startedAt?: string; completedAt?: string; activeSince?: string; currentSetStartedAt?: string; currentSetEndedAt?: string; activeWorkoutMs: number; pausedAt?: string; previousState?: WorkoutState; restEndsAt?: string; phaseEndsAt?: string; events: WorkoutEvent[]; coach?: CoachState }
export interface DurationBreakdown { warmupSeconds: number; setExecutionSeconds: number; restSeconds: number; transitionSeconds: number; cooldownSeconds: number; totalSeconds: number }
export interface OptionalItem { type: "cardio" | "mobility" | "accessory" | "extended_cooldown"; name: string; durationMinutes: number; required: false }
export interface WorkoutBlocks { warmup: { durationMinutes: number }; mainBlock: string[]; secondaryBlock?: string[]; accessoryBlock: string[]; conditioningBlock?: string[]; mobilityBlock?: string[]; optionalBlock: OptionalItem[]; cooldown: { durationMinutes: number } }
export interface PrescriptionDiagnostics { totalWorkingSets: number; movementPatternSets: Record<string, number>; blockDuration: Record<string, number> }
export interface Prescription { goal: TrainingGoal; workingSets: number; maxWorkingSets: number; availableDurationMinutes: number; plannedDurationMinutes: number; optionalDurationMinutes: number; movementPatterns: MovementPattern[]; reasoningSummary: string[]; ruleIds: string[]; decisionReasons?: DecisionReason[] }
export interface ExerciseCapability { userId: string; exerciseId: string; recommendedWeightKg?: number; targetRepRange: string; estimatedRir?: number; recentSuccessfulSets: number; recentFailedSets: number; validSetCount: number; lastPerformedAt?: string; daysSinceLastExercise?: number; recentPainEvent: boolean; lastPainAt?: string; painCountRecent: number; confidence: DataConfidence; estimate?: ExerciseCapabilityEstimate }
export interface MovementPatternLoad { movementPattern: MovementPattern; last7Days: { workingSets: number; completedReps: number; volumeLoad?: number; sessions: number; painEvents: number }; daysSinceLastMovementPattern?: number }
export interface PreferenceProfile { byExercise: Record<string, { skipCount: number; replaceCount: number; tooHardCount: number; tooLightCount: number }> }
export interface UserTrainingModel { userId: string; generatedAt: string; exerciseCapabilities: Record<string, ExerciseCapability>; movementCapabilities: Record<string, MovementCapabilityEstimate>; volumeToleranceByPattern: CapabilityEstimates["volumeToleranceByPattern"]; recoveryTendency: CapabilityEstimates["recoveryTendency"]; interruptionCounts: Record<string, number>; movementPatternLoads: Record<string, MovementPatternLoad>; preferenceProfile: PreferenceProfile; recoveryState: RecoveryState; dataConfidence: DataConfidence }
export interface TrainingFacts { sessions: WorkoutSession[]; sets: SetRecord[]; trainingRecords?: TrainingRecord[] }
export interface WorkoutSession { schemaVersion: "1.2"; sessionId: string; userId: string; createdAt: string; /** 加练(2026-11-09, owner):用户完成当日计划后自愿再练的那一场。单独存档,不顶替计划、不计入课程进度 */ kind?: "planned" | "extra"; /** 课程归属(计划↔执行分离:模板是计划,本会话是执行的事实) */ program?: { programId: string; programSessionId: string; weekNumber: number; sessionNumber: number }; durationMinutes: number; availableDurationMinutes: number; durationIntent?: "target" | "maximum"; plannedDurationMinutes: number; optionalDurationMinutes: number; goal: TrainingGoal; environment: Environment; gymId?: string; restrictions: string[]; intensity: Intensity; status: WorkoutState; warmupMinutes: number; exercises: WorkoutExercise[]; suggestedExercises?: WorkoutExercise[]; blocks: WorkoutBlocks; prescription: Prescription; requiredStimulus?: RequiredStimulus; prescriptionDiagnostics?: PrescriptionDiagnostics; cooldownMinutes: number; safetyNotes: string[]; estimatedDurationMinutes: number; durationBreakdown: DurationBreakdown; durationShortfallReason?: string; runtime: WorkoutRuntime; experience?: ExperienceState }

export const workoutJsonSchema = { $schema: "https://json-schema.org/draft/2020-12/schema", $id: "https://trainmind.local/schemas/workout-session.json", title: "WorkoutSession", type: "object", required: ["schemaVersion", "sessionId", "userId", "availableDurationMinutes", "plannedDurationMinutes", "goal", "environment", "status", "exercises", "runtime"], properties: { schemaVersion: { const: "1.2" }, sessionId: { type: "string" }, userId: { type: "string" }, durationIntent: { enum: ["target", "maximum"] }, availableDurationMinutes: { type: "integer", minimum: 5, maximum: 180 }, plannedDurationMinutes: { type: "integer", minimum: 1 }, goal: { enum: ["back_strength", "chest_strength", "upper_body", "lower_body", "general_fitness", "mobility"] }, environment: { enum: ["home", "office", "gym"] }, status: { enum: ["preview", "active", "warming_up", "exercise_active", "set_feedback", "resting", "cooling_down", "paused", "completed", "aborted"] }, exercises: { type: "array", minItems: 1 }, blocks: { type: "object" }, prescription: { type: "object" }, durationBreakdown: { type: "object" }, runtime: { type: "object" } }, additionalProperties: true } as const;


export const prescriptionRules = {
  back_strength: { maxWorkingSets: 10, requiredPatterns: ["vertical_pull", "horizontal_pull"] as MovementPattern[], preferredAccessoryPatterns: ["scapular_control"] as MovementPattern[], optionalMinimumMinutes: 5 },
  chest_strength: { maxWorkingSets: 12, requiredPatterns: ["horizontal_push"] as MovementPattern[], preferredAccessoryPatterns: ["arm_curl", "arm_extension"] as MovementPattern[], optionalMinimumMinutes: 5 },
  upper_body: { maxWorkingSets: 12, requiredPatterns: ["vertical_pull", "horizontal_push"] as MovementPattern[], preferredAccessoryPatterns: ["arm_curl"] as MovementPattern[], optionalMinimumMinutes: 5 },
  lower_body: { maxWorkingSets: 10, requiredPatterns: ["squat", "hip_extension"] as MovementPattern[], preferredAccessoryPatterns: [] as MovementPattern[], optionalMinimumMinutes: 5 },
  general_fitness: { maxWorkingSets: 12, requiredPatterns: ["squat", "horizontal_push", "core_stability"] as MovementPattern[], preferredAccessoryPatterns: [] as MovementPattern[], optionalMinimumMinutes: 5 },
  mobility: { maxWorkingSets: 6, requiredPatterns: ["core_stability"] as MovementPattern[], preferredAccessoryPatterns: [] as MovementPattern[], optionalMinimumMinutes: 5 }
} as const;
export interface SessionRecipe { id: string; goal: TrainingGoal; durationMinutes: number; blocks: { type: "warmup" | "main" | "secondary" | "accessory" | "conditioning" | "mobility" | "cooldown"; required: boolean; movementPatterns: MovementPattern[]; timeShare: number; workingSetBudget: [number, number]; intensity: Intensity }[] }
const recipePath = new URL("../knowledge/recipes.json", import.meta.url);
type RecipeFamily = { id: string; goals: string[]; durations: number[]; environments: string[]; blocks: SessionRecipe["blocks"] };
const recipeCatalog = (existsSync(recipePath) ? JSON.parse(readFileSync(recipePath, "utf8")) : { recipes: [] }) as { recipes: RecipeFamily[] };
const legacyToKnowledgeGoal = (goal: TrainingGoal): KnowledgeGoal => goal === "mobility" ? "mobility" : goal === "general_fitness" ? "general_fitness" : "strength";
function knowledgeRecipe(goal: TrainingGoal, durationMinutes: number): RecipeFamily {
  const profile = getGoalProfile(legacyToKnowledgeGoal(goal));
  const blocks: SessionRecipe["blocks"] = [
    { type: "warmup", required: true, movementPatterns: [], timeShare: 0.1, workingSetBudget: [0, 0], intensity: "low" },
    { type: "main", required: true, movementPatterns: profile.primaryPatterns as MovementPattern[], timeShare: 0.55, workingSetBudget: [profile.sets.minimum, profile.sets.maximum * profile.primaryPatterns.length], intensity: "moderate" },
    { type: "secondary", required: false, movementPatterns: profile.secondaryPatterns as MovementPattern[], timeShare: 0.2, workingSetBudget: [0, profile.sets.maximum * profile.secondaryPatterns.length], intensity: "moderate" },
    { type: "accessory", required: false, movementPatterns: profile.accessoryPatterns as MovementPattern[], timeShare: 0.05, workingSetBudget: [0, profile.accessoryPatterns.length], intensity: "low" },
    { type: "conditioning", required: false, movementPatterns: ["conditioning"], timeShare: 0.05, workingSetBudget: [0, 1], intensity: "low" },
    { type: "mobility", required: true, movementPatterns: ["mobility"], timeShare: 0.025, workingSetBudget: [0, 0], intensity: "low" },
    { type: "cooldown", required: true, movementPatterns: [], timeShare: 0.025, workingSetBudget: [0, 0], intensity: "low" }
  ];
  return { id: `knowledge_${legacyToKnowledgeGoal(goal)}`, goals: [goal], durations: [durationMinutes], environments: ["home", "office", "gym"], blocks };
}
export function sessionRecipe(goal: TrainingGoal, durationMinutes = 30, environment: Environment = "home", preferredRecipeId?: string): SessionRecipe {
  const preferred = preferredRecipeId ? recipeCatalog.recipes.find(x => x.id === preferredRecipeId && x.goals.includes(goal) && x.environments.includes(environment)) : undefined;
  const family = preferred ?? recipeCatalog.recipes.find(x => x.goals.includes(goal) && x.durations.includes(durationMinutes) && x.environments.includes(environment)) ?? recipeCatalog.recipes.find(x => x.goals.includes(goal) && x.environments.includes(environment)) ?? knowledgeRecipe(goal, durationMinutes);
  return { id: family.id, goal, durationMinutes: family.durations.reduce((best, x) => Math.abs(x - durationMinutes) < Math.abs(best - durationMinutes) ? x : best, family.durations[0]), blocks: family.blocks };
}
export const trainingModelRules = { recentSessionsPerExercise: 5, minimumEvidenceForProgression: 3, highConfidenceValidSets: 9, recentLoadDays: 7, recentPainDays: 30, highPatternWorkingSets: 10 } as const;

export const equipment: Equipment[] = [
  { id: "lat-pulldown", name: "Lat Pulldown", type: "machine", minWeightKg: 5, maxWeightKg: 100, incrementKg: 5 },
  { id: "cable-machine", name: "Cable Machine", type: "cable", minWeightKg: 5, maxWeightKg: 100, incrementKg: 5 },
  { id: "machine", name: "Gym Machine", type: "machine" },
  { id: "bench", name: "Bench", type: "bench" },
  { id: "resistance_band", name: "Resistance Band", type: "resistance_band" },
  { id: "pull_up_bar", name: "Pull-up Bar", type: "bodyweight" },
  { id: "rings", name: "Gym Rings", type: "bodyweight" },
  { id: "barbell", name: "Barbell", type: "free_weight", minWeightKg: 20, maxWeightKg: 160, incrementKg: 2.5 },
  { id: "dumbbell", name: "Dumbbells", type: "free_weight", availableWeightsKg: [2.5, 5, 7.5, 10, 12.5, 15, 17.5, 20, 22.5, 25, 30, 35, 40] },
  { id: "bodyweight", name: "Bodyweight", type: "bodyweight" }
];
export const testGym: Gym = { id: "test-gym", name: "Test Gym" };
export const gymEquipment: GymEquipment[] = equipment.filter(x => x.id !== "bodyweight").map(x => ({ gymId: testGym.id, equipmentId: x.id, available: true }));
export const exercises: Exercise[] = [
  { id: "lat-pulldown-ex", name: "高位下拉", movementPattern: "vertical_pull", primaryMuscles: ["back"], secondaryMuscles: ["biceps"], equipmentIds: ["lat-pulldown"], environments: ["gym"], difficulty: "beginner", defaultSets: 3, minSets: 2, maxSets: 4, defaultReps: "8-10", defaultWeightKg: 30, attentionLevel: "medium", substitutionTags: ["vertical_pull", "machine_pull"], contraindicationTags: ["shoulder_pain"], instructions: ["胸口微抬，肩胛先下沉", "拉至上胸后控制还原"] },
  { id: "kneeling-cable-pulldown", name: "跪姿绳索下拉", movementPattern: "vertical_pull", primaryMuscles: ["back"], secondaryMuscles: ["biceps"], equipmentIds: ["cable-machine"], environments: ["gym"], difficulty: "intermediate", defaultSets: 3, minSets: 2, maxSets: 4, defaultReps: "8-10", defaultWeightKg: 25, attentionLevel: "medium", substitutionTags: ["vertical_pull", "cable_pull"], contraindicationTags: ["shoulder_pain"], instructions: ["躯干稳定", "肘部向髋部方向下拉"] },
  { id: "seated-cable-row", name: "坐姿划船", movementPattern: "horizontal_pull", primaryMuscles: ["back"], secondaryMuscles: ["biceps", "rear_delt"], equipmentIds: ["cable-machine"], environments: ["gym"], difficulty: "beginner", defaultSets: 3, minSets: 2, maxSets: 4, defaultReps: "8-10", defaultWeightKg: 35, attentionLevel: "medium", substitutionTags: ["horizontal_pull", "supported_row"], contraindicationTags: [], instructions: ["躯干保持稳定", "肘部贴近身体向后拉"] },
  { id: "face-pull", name: "绳索面拉", movementPattern: "scapular_control", primaryMuscles: ["rear_delt", "back"], secondaryMuscles: ["rotator_cuff"], equipmentIds: ["cable-machine"], environments: ["gym"], difficulty: "beginner", defaultSets: 3, minSets: 2, maxSets: 3, defaultReps: "12-15", defaultWeightKg: 15, attentionLevel: "low", substitutionTags: ["scapular_control", "rear_delt"], contraindicationTags: ["shoulder_pain"], instructions: ["绳索拉向眉眼高度", "肩胛自然后收"] },
  { id: "one-arm-db-row", name: "单臂哑铃划船", movementPattern: "horizontal_pull", primaryMuscles: ["back"], secondaryMuscles: ["biceps"], equipmentIds: ["dumbbell"], environments: ["home", "gym"], difficulty: "intermediate", defaultSets: 3, minSets: 2, maxSets: 4, defaultReps: "10/侧", defaultWeightKg: 12.5, attentionLevel: "medium", substitutionTags: ["horizontal_pull", "unilateral_row"], contraindicationTags: ["low_back_pain"], instructions: ["保持脊柱中立", "向髋部方向拉动哑铃"] },
  { id: "bird-dog", name: "鸟狗式", movementPattern: "core_stability", primaryMuscles: ["core"], secondaryMuscles: ["back"], equipmentIds: ["bodyweight"], environments: ["home", "office", "gym"], difficulty: "beginner", defaultSets: 2, minSets: 1, maxSets: 3, defaultReps: "8/侧", attentionLevel: "low", substitutionTags: ["core_stability"], contraindicationTags: [], instructions: ["缓慢伸展对侧手脚", "保持骨盆稳定"] },
  { id: "barbell-bench-press", name: "杠铃卧推", movementPattern: "horizontal_push", primaryMuscles: ["chest"], secondaryMuscles: ["triceps"], equipmentIds: ["barbell"], environments: ["gym"], difficulty: "intermediate", defaultSets: 3, minSets: 2, maxSets: 4, defaultReps: "6-8", defaultWeightKg: 20, attentionLevel: "high", substitutionTags: ["horizontal_push"], contraindicationTags: ["shoulder_pain"], instructions: ["肩胛稳定，双脚踩稳", "控制下放，避免憋气"] },
  { id: "incline-db-press", name: "上斜哑铃卧推", movementPattern: "horizontal_push", primaryMuscles: ["chest"], secondaryMuscles: ["triceps"], equipmentIds: ["dumbbell"], environments: ["gym"], difficulty: "intermediate", defaultSets: 3, minSets: 2, maxSets: 4, defaultReps: "8-10", defaultWeightKg: 10, attentionLevel: "high", substitutionTags: ["horizontal_push"], contraindicationTags: ["shoulder_pain"], instructions: ["背部贴稳凳面", "双臂缓慢推起"] },
  { id: "cable-fly", name: "绳索夹胸", movementPattern: "horizontal_push", primaryMuscles: ["chest"], secondaryMuscles: [], equipmentIds: ["cable-machine"], environments: ["gym"], difficulty: "intermediate", defaultSets: 2, minSets: 1, maxSets: 3, defaultReps: "10-12", defaultWeightKg: 10, attentionLevel: "medium", substitutionTags: ["chest_accessory"], contraindicationTags: ["shoulder_pain"], instructions: ["肘部微屈", "双手在胸前缓慢合拢"] },
  { id: "dumbbell-curl", name: "哑铃弯举", movementPattern: "arm_curl", primaryMuscles: ["biceps"], secondaryMuscles: [], equipmentIds: ["dumbbell"], environments: ["home", "gym"], difficulty: "beginner", defaultSets: 2, minSets: 1, maxSets: 3, defaultReps: "8-12", defaultWeightKg: 5, attentionLevel: "low", substitutionTags: ["arm_curl"], contraindicationTags: [], instructions: ["肘部贴近身体", "避免借力摆动"] },
  { id: "triceps-pushdown", name: "三头下压", movementPattern: "arm_extension", primaryMuscles: ["triceps"], secondaryMuscles: [], equipmentIds: ["cable-machine"], environments: ["gym"], difficulty: "beginner", defaultSets: 2, minSets: 1, maxSets: 3, defaultReps: "10-12", defaultWeightKg: 10, attentionLevel: "low", substitutionTags: ["arm_extension"], contraindicationTags: [], instructions: ["上臂保持稳定", "控制回放"] },
  { id: "push-up", name: "俯卧撑", movementPattern: "horizontal_push", primaryMuscles: ["chest"], secondaryMuscles: ["triceps"], equipmentIds: ["bodyweight"], environments: ["home", "office", "gym"], difficulty: "beginner", defaultSets: 2, minSets: 1, maxSets: 3, defaultReps: "6-10", attentionLevel: "medium", substitutionTags: ["horizontal_push"], contraindicationTags: ["shoulder_pain"], instructions: ["身体保持一条直线", "按能力调整动作幅度"] },
  { id: "bodyweight-squat", name: "徒手深蹲", movementPattern: "squat", primaryMuscles: ["legs"], secondaryMuscles: ["glutes"], equipmentIds: ["bodyweight"], environments: ["home", "office", "gym"], difficulty: "beginner", defaultSets: 2, minSets: 1, maxSets: 3, defaultReps: "8-12", attentionLevel: "medium", substitutionTags: ["squat"], contraindicationTags: ["knee_pain"], instructions: ["双脚站稳", "膝盖顺脚尖方向弯曲"] },
  { id: "glute-bridge", name: "臀桥", movementPattern: "hip_extension", primaryMuscles: ["glutes", "legs"], secondaryMuscles: ["core"], equipmentIds: ["bodyweight"], environments: ["home", "office", "gym"], difficulty: "beginner", defaultSets: 2, minSets: 1, maxSets: 3, defaultReps: "10-12", attentionLevel: "low", substitutionTags: ["hip_extension"], contraindicationTags: ["low_back_pain"], instructions: ["脚跟踩稳", "抬髋时避免腰部过度伸展"] },
  { id: "reverse-lunge", name: "后撤箭步蹲", movementPattern: "lunge", primaryMuscles: ["legs"], secondaryMuscles: ["glutes"], equipmentIds: ["bodyweight"], environments: ["home", "office", "gym"], difficulty: "beginner", defaultSets: 2, minSets: 1, maxSets: 3, defaultReps: "8-10", attentionLevel: "medium", substitutionTags: ["lunge"], contraindicationTags: ["knee_pain"], instructions: ["后撤一脚并缓慢屈膝", "前脚踩稳后站回"] },
  { id: "dead-bug", name: "死虫式", movementPattern: "core_stability", primaryMuscles: ["core"], secondaryMuscles: [], equipmentIds: ["bodyweight"], environments: ["home", "office", "gym"], difficulty: "beginner", defaultSets: 2, minSets: 1, maxSets: 3, defaultReps: "8-10", attentionLevel: "low", substitutionTags: ["core_stability"], contraindicationTags: [], instructions: ["仰卧，交替伸展对侧手脚", "保持腰背舒适地贴近地面"] },
  { id: "hip-hinge", name: "徒手髋铰链", movementPattern: "hinge", primaryMuscles: ["glutes"], secondaryMuscles: ["legs"], equipmentIds: ["bodyweight"], environments: ["home", "office", "gym"], difficulty: "beginner", defaultSets: 2, minSets: 1, maxSets: 3, defaultReps: "10-12", attentionLevel: "medium", substitutionTags: ["hinge"], contraindicationTags: ["low_back_pain"], instructions: ["双脚站稳，髋部向后移动", "躯干保持自然挺直后站起"] },
  { id: "wall-push-up", name: "靠墙俯卧撑", movementPattern: "horizontal_push", primaryMuscles: ["chest"], secondaryMuscles: ["triceps"], equipmentIds: ["bodyweight"], environments: ["home", "office", "gym"], difficulty: "beginner", defaultSets: 2, minSets: 1, maxSets: 3, defaultReps: "10-12", attentionLevel: "low", substitutionTags: ["horizontal_push", "low_impact"], contraindicationTags: ["shoulder_pain"], instructions: ["双手扶墙，身体保持一条直线", "屈肘靠近墙面后推回"] },
  { id: "calf-raise", name: "提踵", movementPattern: "calf", primaryMuscles: ["calves"], secondaryMuscles: [], equipmentIds: ["bodyweight"], environments: ["home", "office", "gym"], difficulty: "beginner", defaultSets: 2, minSets: 1, maxSets: 3, defaultReps: "12-15", attentionLevel: "low", substitutionTags: ["calf"], contraindicationTags: [], instructions: ["扶稳支撑，缓慢抬起脚跟", "控制脚跟落回地面"] },
  { id: "chair-squat", name: "椅子深蹲", movementPattern: "squat", primaryMuscles: ["legs"], secondaryMuscles: ["glutes"], equipmentIds: ["bodyweight"], environments: ["home", "office", "gym"], difficulty: "beginner", defaultSets: 2, minSets: 1, maxSets: 3, defaultReps: "8-12", attentionLevel: "low", substitutionTags: ["squat", "low_impact"], contraindicationTags: ["knee_pain"], instructions: ["在稳固椅子前站稳", "缓慢坐向椅面后站起，不要向后跌坐"] },
  { id: "march-in-place", name: "原地快走", movementPattern: "conditioning", primaryMuscles: ["legs"], secondaryMuscles: [], equipmentIds: ["bodyweight"], environments: ["home", "office", "gym"], difficulty: "beginner", defaultSets: 1, minSets: 1, maxSets: 1, defaultReps: "300秒", repOrTimeBased: "time", attentionLevel: "low", substitutionTags: ["conditioning", "low_impact"], contraindicationTags: [], instructions: ["保持能说话的轻快节奏", "如感到不适，立即放慢或停止"] },
  { id: "standing-mobility", name: "站姿活动度练习", movementPattern: "mobility", primaryMuscles: ["core"], secondaryMuscles: ["legs"], equipmentIds: ["bodyweight"], environments: ["home", "office", "gym"], difficulty: "beginner", defaultSets: 1, minSets: 1, maxSets: 1, defaultReps: "240秒", repOrTimeBased: "time", attentionLevel: "low", substitutionTags: ["mobility", "low_impact"], contraindicationTags: [], instructions: ["缓慢活动肩、髋和踝", "在舒适范围内动作，不追求幅度"] }
];

for (const exercise of exercises) { exercise.source ??= "TrainMind authored training knowledge"; exercise.sourceId ??= "trainmind-authored-v0"; exercise.sourceLicense ??= "TrainMind original content"; }
const authoredSquat = JSON.parse(readFileSync(new URL("../knowledge/exercises/bodyweight-squat.json", import.meta.url), "utf8")) as KnowledgeExercise;
assertKnowledgeExercise(authoredSquat);
Object.assign(exercises.find(x => x.id === authoredSquat.id)!, { voiceCues: authoredSquat.voiceCues, source: authoredSquat.source, sourceId: authoredSquat.sourceId, sourceLicense: authoredSquat.sourceLicense });
const importedPath = new URL("../knowledge/exercises.imported.json", import.meta.url);
if (existsSync(importedPath)) for (const knowledge of JSON.parse(readFileSync(importedPath, "utf8")) as KnowledgeExercise[]) {
  assertKnowledgeExercise(knowledge);
  if (knowledge.reviewStatus !== "reviewed" || exercises.some(x => x.id === knowledge.id)) continue;
  if (!(["vertical_pull", "horizontal_pull", "horizontal_push", "squat", "hip_extension", "arm_curl", "arm_extension", "scapular_control", "core_stability", "conditioning", "mobility"] as string[]).includes(knowledge.movementPattern)) continue;
  exercises.push({ id: knowledge.id, name: knowledge.localizedNames["zh-CN"] ?? knowledge.canonicalName, movementPattern: knowledge.movementPattern as MovementPattern, primaryMuscles: knowledge.primaryMuscles, secondaryMuscles: knowledge.secondaryMuscles, equipmentIds: knowledge.equipment, requiredEquipmentIds: knowledge.equipment, environments: knowledge.environment.filter((x): x is Environment => ["home", "office", "gym"].includes(x)), difficulty: knowledge.difficulty, defaultSets: knowledge.defaultSetRange[0], minSets: knowledge.defaultSetRange[0], maxSets: knowledge.defaultSetRange[1], defaultReps: knowledge.defaultRepRange ? `${knowledge.defaultRepRange[0]}-${knowledge.defaultRepRange[1]}` : "60秒", repOrTimeBased: knowledge.repOrTimeBased, attentionLevel: knowledge.attentionLevel, substitutionTags: [knowledge.movementPattern], contraindicationTags: [], instructions: knowledge.instructions, voiceCues: knowledge.voiceCues, source: knowledge.source, sourceId: knowledge.sourceId, sourceLicense: knowledge.sourceLicense });
}
// RepDB 条目在原始数据里没有 contraindicationTags（实测 80 条全缺）。空数组意味着
// 这些动作**永远不会**因为用户膝/腰/肩限制被排除 —— 安全上是条缝（2026-11-09 复核发现）。
// 这里按动作模式保守推导，宁可少排也不要给禁忌部位上负荷；自研动作仍用自己的手写标签。
const PATTERN_CONTRAINDICATIONS: Partial<Record<MovementPattern, string[]>> = {
  squat: ["knee_pain"],
  lunge: ["knee_pain"],
  hinge: ["low_back_pain"],
  hip_extension: ["low_back_pain"],
  vertical_push: ["shoulder_pain"],
  horizontal_push: ["shoulder_pain"],
  vertical_pull: ["shoulder_pain"],
};
const contraindicationsFor = (pattern: MovementPattern): string[] => [...(PATTERN_CONTRAINDICATIONS[pattern] ?? [])];
const repDbPath = new URL("../knowledge/exercises.repdb.json", import.meta.url);
if (existsSync(repDbPath)) for (const knowledge of JSON.parse(readFileSync(repDbPath, "utf8")) as KnowledgeExercise[]) {
  assertKnowledgeExercise(knowledge);
  if (knowledge.reviewStatus !== "reviewed" || !knowledge.attributionRequired || exercises.some(x => x.id === knowledge.id)) continue;
  const timed = knowledge.movementPattern === "mobility" || knowledge.movementPattern === "conditioning" || /hold|plank|carry/i.test(knowledge.id);
  const defaultReps = timed ? "30秒" : knowledge.movementPattern === "calf" ? "12-15" : knowledge.movementPattern.startsWith("core_") ? "8-12" : "8-12";
  exercises.push({ id: knowledge.id, name: knowledge.localizedNames["zh-CN"] ?? knowledge.canonicalName, aliases: knowledge.aliases, movementPattern: knowledge.movementPattern as MovementPattern, primaryMuscles: knowledge.primaryMuscles, secondaryMuscles: knowledge.secondaryMuscles, equipmentIds: knowledge.equipment, requiredEquipmentIds: knowledge.equipment, environments: knowledge.environment.filter((x): x is Environment => ["home", "office", "gym"].includes(x)), difficulty: knowledge.difficulty, unilateral: knowledge.unilateral, defaultSets: 2, minSets: 1, maxSets: 3, defaultReps, repOrTimeBased: timed ? "time" : "reps", attentionLevel: knowledge.difficulty === "beginner" ? "medium" : "high", substitutionTags: [knowledge.movementPattern, ...knowledge.equipment], contraindicationTags: contraindicationsFor(knowledge.movementPattern as MovementPattern), instructions: knowledge.instructions, bodyRegion: knowledge.bodyRegion, position: knowledge.position, impactLevel: knowledge.impactLevel, compoundOrIsolation: knowledge.compoundOrIsolation, progressions: knowledge.progressions, regressions: knowledge.regressions, voiceCues: knowledge.voiceCues, source: knowledge.source, sourceId: knowledge.sourceId, sourceCommit: knowledge.sourceCommit, sourceLicense: knowledge.sourceLicense, attributionRequired: true });
  substitutionGraph[knowledge.id] = knowledge.substitutions;
}
const cueProfiles = JSON.parse(readFileSync(new URL("../knowledge/voice-cue-profiles.json", import.meta.url), "utf8")).profiles as Record<string, VoiceCues>;
for (const exercise of exercises) {
  exercise.voiceCues ??= { ...cueProfiles[exercise.movementPattern], startCue: `接下来做${exercise.name}，按自己的稳定节奏完成。`, reviewStatus: "reviewed" };
  exercise.attributionRequired ??= false;
}
for (const exercise of exercises) {
  const existing = substitutionGraph[exercise.id] ?? [];
  const known = new Set(existing.map(x => x.exerciseId));
  for (const other of exercises) {
    if (other.id === exercise.id || other.movementPattern !== exercise.movementPattern || known.has(other.id)) continue;
    const kind = exercise.difficulty === "intermediate" && other.difficulty === "beginner" ? "easier" : exercise.difficulty === "beginner" && other.difficulty === "intermediate" ? "harder" : exercise.equipmentIds[0] !== other.equipmentIds[0] ? "equipment_alternative" : "same_pattern";
    existing.push({ exerciseId: other.id, kind, reason: `TrainMind-reviewed ${exercise.movementPattern} alternative; confirm fit, equipment and user constraints.` });
  }
  substitutionGraph[exercise.id] = existing;
}

// 肌群账本的输入：动作 id → 它训练的主肌群（RepDB 的解剖名原样传，muscles.ts 内部再映射）
export const primaryMusclesByExerciseId: Record<string, string[]> = Object.fromEntries(exercises.map(exercise => [exercise.id, exercise.primaryMuscles]));

const dangerPatterns = [/胸痛/, /呼吸(异常|困难)/, /眩晕/, /晕厥/, /麻木/, /(剧烈|突发).{0,4}疼痛/, /急性损伤/];
export function safetyGate(input: string, context?: Pick<SessionContext, "painSignals">) { const signal = context?.painSignals[0], areaLabels: Record<string, string> = { chest: "胸部", shoulder: "肩部", lower_back: "腰背部", legs: "腿部", unknown: "身体" }; return dangerPatterns.some(pattern => pattern.test(input)) || Boolean(signal) ? { allowed: false, code: signal?.area === "chest" ? "chest_pain" : signal ? "active_pain" : "danger_signal", message: signal?.area === "chest" ? "检测到胸部疼痛信号。请停止训练并尽快寻求专业医疗帮助；本产品不提供诊断。" : signal ? `检测到${areaLabels[signal.area] ?? signal.area}疼痛。今天不生成普通训练，请先确认不适情况；如疼痛明显或持续，请寻求专业帮助。` : "检测到可能的危险信号。请停止训练并尽快寻求专业医疗帮助；本产品不提供诊断。" } : { allowed: true }; }
export interface InterpreterHints { knownEnvironment?: ContextEnvironment; longTermRestrictions?: string[] }
export interface LanguageModelProvider { readonly name: string; generateStructuredContext(input: string, hints: InterpreterHints): Promise<unknown>; repairStructuredContext?(input: string, invalidOutput: unknown, errors: string[], hints: InterpreterHints): Promise<unknown> }
export interface SessionContextInterpretation { status: "ready" | "needs_clarification" | "error"; context: SessionContext | null; clarificationQuestions: string[]; provider: string; fallbackUsed: boolean; warnings: string[]; errors: string[] }

function areaName(text: string) { return /膝/.test(text) ? "legs" : /腿/.test(text) ? "legs" : /肩/.test(text) ? "shoulder" : /胸/.test(text) ? "chest" : /腰|背/.test(text) ? "lower_back" : "unknown"; }
export class RuleLanguageModelProvider implements LanguageModelProvider {
  readonly name = "rule";
  async generateStructuredContext(input: string, hints: InterpreterHints) {
    const numeric = input.match(/(\d{1,3})\s*分钟/), halfHour = /半个?小时|半小时/.test(input), oneHour = /(?:一个|1个?)小时/.test(input);
    const duration = numeric ? Number(numeric[1]) : halfHour ? 30 : oneHour ? 60 : /看着安排|随便练|不知道练什么/.test(input) ? 20 : null;
    const durationSource: FieldSource = numeric || halfHour || oneHour ? "explicit" : duration ? "inferred" : "unknown";
    let environment: ContextEnvironment = /Test Gym/i.test(input) ? { type: "gym", gymId: testGym.id } : /健身房/.test(input) ? { type: "gym" } : /办公室/.test(input) || /坐了一上午/.test(input) ? { type: "office" } : /在家|居家|家里/.test(input) ? { type: "home" } : /没有器械|无器械/.test(input) ? { type: "home" } : hints.knownEnvironment ?? { type: "unknown" };
    const environmentSource: FieldSource = environment.type === "unknown" ? "unknown" : hints.knownEnvironment === environment ? "profile" : /没有器械|无器械|坐了一上午/.test(input) ? "inferred" : "explicit";
    const goal: ContextGoal = { type: /上肢/.test(input) ? "upper_body" : /下肢|练腿|腿部训练/.test(input) ? "lower_body" : /练背|背部/.test(input) ? "back" : /练胸|胸部/.test(input) ? "chest" : /恢复训练|恢复一下|活动|动一动/.test(input) ? "mobility" : /全身|随便|看着安排|不知道练什么/.test(input) ? "general" : "unknown", priority: null };
    const recovery: RecoveryState = /很累|累坏|练废/.test(input) ? "very_fatigued" : /有点累|疲劳|刚下班/.test(input) ? "fatigued" : /精神不错|状态不错|状态很好|精力很好|精力充沛/.test(input) ? "fresh" : /正常|状态一般/.test(input) ? "normal" : "unknown";
    const soreness: SorenessSignal[] = [...input.matchAll(/(腿|肩|胸|腰|背)[^，。]{0,6}(酸|僵|练废)/g)].map(x => ({ area: areaName(x[1]), level: /练废|明显|很/.test(x[0]) ? "marked" : "mild" }));
    const painSignals: PainSignal[] = [...input.matchAll(/(胸口|胸|肩膀|肩|膝盖|膝|腰|背|腿)[^，。]{0,5}(疼|痛)/g)].map(x => ({ area: areaName(x[1]), severity: /剧烈|突发|很痛/.test(x[0]) ? "severe" : "unspecified", rawText: x[0] }));
    const previousTraining: PreviousTrainingContext = /昨天.*练/.test(input) ? { status: "reported", when: "yesterday", areas: [/腿/.test(input.match(/昨天[^，。]*/)?.[0] ?? "") ? "legs" : /胸/.test(input.match(/昨天[^，。]*/)?.[0] ?? "") ? "chest" : /背/.test(input.match(/昨天[^，。]*/)?.[0] ?? "") ? "back" : "unknown"] } : { status: "unknown", areas: [] };
    const excludedExercises = /不想做俯卧撑|不要俯卧撑/.test(input) ? ["push-up"] : [];
    return { availableDurationMinutes: { value: duration, confidence: duration ? "high" : "low", source: durationSource }, environment: { value: environment, confidence: environment.type === "unknown" ? "low" : "high", source: environmentSource }, goal: { value: goal, confidence: goal.type === "unknown" ? "low" : /随便|看着安排/.test(input) ? "medium" : "high", source: goal.type === "unknown" ? "unknown" : /随便|看着安排/.test(input) ? "inferred" : "explicit" }, recovery: { value: { overall: recovery, soreness }, confidence: recovery === "unknown" && !soreness.length ? "low" : "high", source: recovery === "unknown" && !soreness.length ? "unknown" : "explicit" }, constraints: { avoidExercises: excludedExercises, avoidMovements: [], noJumping: /不想跳|不要跳|不跳/.test(input), noiseSensitive: /不能吵|安静/.test(input) }, preferences: { requestedExercises: [], excludedExercises }, painSignals, previousTraining };
  }
}
export class LocalLanguageModelProvider extends RuleLanguageModelProvider {}
export function validateStructuredContext(value: any): string[] {
  const errors: string[] = [];
  if (!value || typeof value !== "object") return ["output must be an object"];
  if (!value.availableDurationMinutes || !(value.availableDurationMinutes.value === null || Number.isInteger(value.availableDurationMinutes.value))) errors.push("availableDurationMinutes must be an integer or null");
  if (!value.environment?.value || !["home", "office", "gym", "unknown"].includes(value.environment.value.type)) errors.push("environment.type is invalid");
  if (!value.goal?.value || !["back", "chest", "upper_body", "lower_body", "general", "mobility", "unknown"].includes(value.goal.value.type)) errors.push("goal.type is invalid");
  if (!value.recovery?.value || !["fresh", "normal", "fatigued", "very_fatigued", "unknown"].includes(value.recovery.value.overall)) errors.push("recovery.overall is invalid");
  if (!value.constraints || typeof value.constraints.noJumping !== "boolean") errors.push("constraints are invalid");
  if (!Array.isArray(value.painSignals) || !value.previousTraining) errors.push("painSignals and previousTraining are required");
  return errors;
}

/** B9(2026-11-09):与 workoutJsonSchema 的 minimum/maximum 同源,别在别处硬编码 5/180。 */
export const DURATION_MIN_MINUTES = 5, DURATION_MAX_MINUTES = 180;

/** 酸痛过滤被短路时的可审计标记（见 generateWorkout 里的 sorenessSkipped）。 */
export const SORENESS_NOT_APPLIED_RULE_ID = "soreness-not-applied-v1";
const AREA_LABELS: Record<string, string> = { chest: "胸", shoulder: "肩", lower_back: "腰背", legs: "腿" };

/**
 * 酸痛提示（2026-11-11 审查修正）。
 *
 * 旧实现无条件写"今天会控制相关部位的强度"，但过滤在"候选不足 3 个"时会整体放弃，
 * 于是出现"一边排深蹲一边说已控制强度"——这句话比不提示更危险，因为它让人以为系统已经处理过。
 * 现在按实际生效与否分成两种说法，都把"训练中疼痛要停"留着。
 */
function sorenessNotes(soreness: string[], skipped: Set<string>): string[] {
  if (!soreness.length) return [];
  const label = (area: string) => AREA_LABELS[area] ?? area;
  const notes: string[] = [];
  const applied = soreness.filter(area => !skipped.has(area));
  if (applied.length) notes.push(`检测到${applied.map(label).join("、")}部酸痛，今天会控制相关部位的强度，训练中如出现疼痛请立即停止。`);
  if (skipped.size) notes.push(`检测到${[...skipped].map(label).join("、")}部酸痛，但没有避开：你在目标里指定了这个部位，可选动作不足 3 个。今天请降到能轻松完成的强度，任何疼痛立刻停止。`);
  return notes;
}
export class ContextInterpreter {
  private primary: LanguageModelProvider;
  private fallback: LanguageModelProvider | null;
  constructor(primary: LanguageModelProvider, fallback: LanguageModelProvider | null = new RuleLanguageModelProvider()) { this.primary = primary; this.fallback = fallback; }
  async interpret(input: string, userId: string, hints: InterpreterHints = {}): Promise<SessionContextInterpretation> {
    let provider = this.primary, output: unknown, fallbackUsed = false, warnings: string[] = [];
    try { output = await provider.generateStructuredContext(input, hints); }
    catch (error) { if (!this.fallback || this.fallback === provider) return { status: "error", context: null, clarificationQuestions: [], provider: provider.name, fallbackUsed: false, warnings: [], errors: [`Provider failure: ${error instanceof Error ? error.message : "unknown"}`] }; provider = this.fallback; fallbackUsed = true; warnings.push(`Primary provider failed; used ${provider.name} fallback.`); output = await provider.generateStructuredContext(input, hints); }
    let errors = validateStructuredContext(output);
    if (errors.length && provider.repairStructuredContext) { output = await provider.repairStructuredContext(input, output, errors, hints); errors = validateStructuredContext(output); }
    if (errors.length && this.fallback && this.fallback !== provider) { provider = this.fallback; fallbackUsed = true; warnings.push(`Invalid structured output; used ${provider.name} fallback.`); output = await provider.generateStructuredContext(input, hints); errors = validateStructuredContext(output); }
    if (errors.length) return { status: "error", context: null, clarificationQuestions: [], provider: provider.name, fallbackUsed, warnings, errors };
    // B9(2026-11-09):可用时长只认规则层可信区间。0 / 负数 / 999 这类来自解析(或 LLM 幻觉)的值
    // 不当数字用:降级为"未提供"走澄清 —— 既不生成注定超时的畸形课,也不替用户编一个数字。
    const raw: any = output, durationRaw = raw.availableDurationMinutes.value as number | null, duration = durationRaw !== null && Number.isInteger(durationRaw) && durationRaw >= DURATION_MIN_MINUTES && durationRaw <= DURATION_MAX_MINUTES ? durationRaw : null, environmentInfo = raw.environment.value as ContextEnvironment, missing: string[] = [];
    if (duration === null) missing.push("availableDurationMinutes");
    if (environmentInfo.type === "gym" && !environmentInfo.gymId) missing.push("gymId");
    const questions = missing.map(x => x === "availableDurationMinutes" ? "你现在大概有多久可以训练？" : x === "gymId" ? "你现在在哪一家健身房？" : "你现在是在家、办公室，还是健身房？");
    const recoveryState = raw.recovery.value.overall as RecoveryState, goal = raw.goal.value as ContextGoal, environment = environmentInfo.type === "unknown" ? "home" : environmentInfo.type;
    const experienceLevel: ExperienceLevel = /初学者|新手|初学|beginner/i.test(input) ? "beginner" : /中级|intermediate/i.test(input) ? "intermediate" : /高级|advanced/i.test(input) ? "advanced" : "unknown";
    // "徒手"不该吃掉后面明确说出的器械:说了"徒手 + 有哑铃"应该两样都算可用
    const mentionsEquipment = /哑铃|dumbbell|杠铃|barbell|弹力带|resistance band|壶铃|kettlebell/i.test(input);
    const explicitNoEquipment = /没有器械|无器械|不带器械|徒手|bodyweight only/i.test(input) && !mentionsEquipment;
    const availableEquipmentIds = explicitNoEquipment ? ["bodyweight"] : [...new Set(["bodyweight", ...(/哑铃|dumbbell/i.test(input) ? ["dumbbell"] : []), (/杠铃|barbell/i.test(input) ? ["barbell"] : []), (/弹力带|resistance band/i.test(input) ? ["resistance_band"] : []), (/壶铃|kettlebell/i.test(input) ? ["kettlebell"] : [])].flat())];
    const context: SessionContext = { userId, rawInput: input, availableDurationMinutes: duration ?? 20, durationMinutes: duration ?? 20, durationIntent: /(?:最多|不(?:要)?超过|至多|只有|只能练)\s*(?:\d{1,3}\s*分钟|半个?小时|(?:一个|1个?)小时)|(?:\d{1,3}\s*分钟|半个?小时|(?:一个|1个?)小时)\s*(?:以内|上限)/.test(input) ? "maximum" : "target", environment, gymId: environmentInfo.gymId, focus: ["back", "upper_body"].includes(goal.type) ? "back" : goal.type === "chest" ? "chest" : goal.type === "lower_body" ? "legs" : undefined, fatigue: recoveryState === "very_fatigued" ? "high" : recoveryState === "fatigued" ? "moderate" : "low", recoveryState, experienceLevel, availableEquipmentIds: explicitNoEquipment || /哑铃|dumbbell|杠铃|barbell|弹力带|resistance band|壶铃|kettlebell/i.test(input) ? availableEquipmentIds : undefined, soreness: raw.recovery.value.soreness.map((x: SorenessSignal) => x.area), restrictions: [...(hints.longTermRestrictions ?? []), ...(raw.constraints.noJumping ? ["no_jumping"] : [])], environmentContext: environmentInfo, goalContext: goal, recovery: raw.recovery.value, constraints: raw.constraints, preferences: raw.preferences, painSignals: raw.painSignals, previousTraining: raw.previousTraining, missingCriticalFields: missing, fieldEvidence: { availableDurationMinutes: raw.availableDurationMinutes, environment: raw.environment, goal: raw.goal, recovery: raw.recovery } };
    return { status: missing.length ? "needs_clarification" : "ready", context, clarificationQuestions: questions.slice(0, 2), provider: provider.name, fallbackUsed, warnings, errors: [] };
  }
}

const SET_SECONDS = 45, TRANSITION_SECONDS = 75;
export function durationBreakdown(items: (Pick<WorkoutExercise, "sets" | "restSeconds"> & Partial<Pick<WorkoutExercise, "targetReps" | "repOrTimeBased">>)[], warmupMinutes: number, cooldownMinutes: number): DurationBreakdown { const setExecutionSeconds = items.reduce((sum, x) => sum + x.sets * (x.repOrTimeBased === "time" ? Number(x.targetReps?.match(/\d+/)?.[0] ?? 0) : SET_SECONDS), 0), restSeconds = items.reduce((sum, x) => sum + Math.max(0, x.sets - 1) * x.restSeconds, 0); const result = { warmupSeconds: warmupMinutes * 60, setExecutionSeconds, restSeconds, transitionSeconds: Math.max(0, items.length - 1) * TRANSITION_SECONDS, cooldownSeconds: cooldownMinutes * 60, totalSeconds: 0 }; result.totalSeconds = result.warmupSeconds + result.setExecutionSeconds + result.restSeconds + result.transitionSeconds + result.cooldownSeconds; return result; }
const dayMs = 86400000;
const daysAgo = (at: string | undefined, now: string) => at ? Math.max(0, Math.floor((Date.parse(now) - Date.parse(at)) / dayMs)) : undefined;
export function buildUserTrainingModel(userId: string, facts: TrainingFacts, recoveryState: RecoveryState = "unknown", now = new Date().toISOString()): UserTrainingModel {
  const sessionById = new Map(facts.sessions.map(x => [x.sessionId, x]));
  const capabilityModel = buildCapabilityEstimates({ exercises, sessions: facts.sessions, sets: facts.sets, trainingRecords: facts.trainingRecords, now });
  const exerciseCapabilities: Record<string, ExerciseCapability> = {};
  for (const exercise of exercises) {
    const all = facts.sets.filter(x => x.exerciseId === exercise.id).sort((a, b) => b.completedAt.localeCompare(a.completedAt) || b.setNumber - a.setNumber);
    const sessionIds = [...new Set(all.map(x => x.sessionId))].slice(0, trainingModelRules.recentSessionsPerExercise), recent = all.filter(x => sessionIds.includes(x.sessionId));
    const valid = recent.filter(x => { const session = sessionById.get(x.sessionId), performed = session?.exercises.find(item => item.exerciseId === exercise.id); return session?.status === "completed" && (!performed || !["skipped", "replaced", "pain"].includes(performed.executionStatus)) && !x.pain && Number.isFinite(x.actualReps); });
    const targetMin = Number(exercise.defaultReps.match(/\d+/)?.[0] ?? 0), targetMax = Number(exercise.defaultReps.match(/(\d+)(?!.*\d)/)?.[0] ?? targetMin);
    // B3:时长型动作的 actualReps 恒为 0(完成键结组),拿它比次数会把每场都算成失败
    const timedDose = isTimedDose(exercise.defaultReps);
    const successful = timedDose ? [] : valid.filter(x => x.actualReps >= targetMax && x.rir! >= 2), failed = timedDose ? valid.filter(x => x.feedback === "failed") : valid.filter(x => x.actualReps < targetMin || x.rir! <= 0), pains = all.filter(x => x.pain && (daysAgo(x.completedAt, now) ?? Infinity) <= trainingModelRules.recentPainDays);
    const latest = valid[0] ?? recent[0], estimate = capabilityModel.exercise[exercise.id], confidence = estimate.confidence;
    exerciseCapabilities[exercise.id] = { userId, exerciseId: exercise.id, recommendedWeightKg: latest?.actualWeight, targetRepRange: exercise.defaultReps, estimatedRir: latest?.rir, recentSuccessfulSets: successful.length, recentFailedSets: failed.length, validSetCount: valid.length, lastPerformedAt: all[0]?.completedAt, daysSinceLastExercise: daysAgo(all[0]?.completedAt, now), recentPainEvent: pains.length > 0, lastPainAt: pains[0]?.completedAt, painCountRecent: pains.length, confidence, estimate };
  }
  const movementPatternLoads = {} as Record<string, MovementPatternLoad>;
  for (const pattern of [...new Set(exercises.map(x => x.movementPattern))]) {
    const ids = new Set(exercises.filter(x => x.movementPattern === pattern).map(x => x.id)), recent = facts.sets.filter(x => ids.has(x.exerciseId) && (daysAgo(x.completedAt, now) ?? Infinity) <= trainingModelRules.recentLoadDays), sessions = new Set(recent.map(x => x.sessionId)), weighted = recent.filter(x => x.actualWeight !== undefined);
    const latest = facts.sets.filter(x => ids.has(x.exerciseId)).sort((a, b) => b.completedAt.localeCompare(a.completedAt))[0];
    movementPatternLoads[pattern] = { movementPattern: pattern, last7Days: { workingSets: recent.filter(x => !x.pain).length, completedReps: recent.reduce((n, x) => n + x.actualReps, 0), volumeLoad: weighted.length ? weighted.reduce((n, x) => n + (x.actualWeight ?? 0) * x.actualReps, 0) : undefined, sessions: sessions.size, painEvents: recent.filter(x => x.pain).length }, daysSinceLastMovementPattern: daysAgo(latest?.completedAt, now) };
  }
  const byExercise: PreferenceProfile["byExercise"] = {};
  for (const exercise of exercises) byExercise[exercise.id] = { skipCount: 0, replaceCount: 0, tooHardCount: facts.sets.filter(x => x.exerciseId === exercise.id && ["hard", "failed"].includes(x.feedback)).length, tooLightCount: facts.sets.filter(x => x.exerciseId === exercise.id && x.feedback === "too_light").length };
  for (const session of facts.sessions) for (const event of session.runtime?.events ?? []) { const originalId = event.details?.originalExerciseId, id = event.exerciseId ?? (typeof originalId === "string" ? originalId : undefined); if (!id || !byExercise[id]) continue; if (event.type === "exercise_skipped") byExercise[id].skipCount++; if (event.type === "exercise_replaced") byExercise[id].replaceCount++; }
  const validCount = Object.values(exerciseCapabilities).reduce((n, x) => n + x.validSetCount, 0), dataConfidence: DataConfidence = validCount >= trainingModelRules.highConfidenceValidSets ? "high" : validCount >= trainingModelRules.minimumEvidenceForProgression ? "medium" : "low";
  return { userId, generatedAt: now, exerciseCapabilities, movementCapabilities: capabilityModel.movement, volumeToleranceByPattern: capabilityModel.volumeToleranceByPattern, recoveryTendency: capabilityModel.recoveryTendency, interruptionCounts: capabilityModel.interruptionCounts, movementPatternLoads: movementPatternLoads as Record<string, MovementPatternLoad>, preferenceProfile: { byExercise }, recoveryState, dataConfidence };
}

/** B3(2026-11-09):时长型动作的 targetReps 形如"300秒"/"9分钟" —— 它的数字是秒,不是次数。 */
const isTimedDose = (targetReps: string | undefined) => /秒|分钟/.test(targetReps ?? "");
export function recommendExercise(exercise: Exercise, model: UserTrainingModel, facts: TrainingFacts, context: SessionContext): ExerciseRecommendation {
  const capability = model.exerciseCapabilities[exercise.id], estimate = capability.estimate, outcomes = estimate?.recentOutcomes ?? [], latest = outcomes[0], previous = outcomes[1];
  const candidate = { id: exercise.id, movementPattern: exercise.movementPattern, difficulty: exercise.difficulty, unilateral: exercise.unilateral, equipmentIds: exercise.equipmentIds };
  const movementEvidence = compatibleMovementEvidence(candidate, exercises, model.movementCapabilities);
  const doseRange = latest?.targetReps ?? exercise.defaultReps, min = Number(doseRange.match(/\d+/)?.[0] ?? 0), max = Number(doseRange.match(/(\d+)(?!.*\d)/)?.[0] ?? min);
  let action: RecommendationAction = "maintain", weight = estimate?.staleness === "very_stale" ? exercise.defaultWeightKg : capability.recommendedWeightKg ?? exercise.defaultWeightKg;
  // B2(2026-11-09):只有完成过的场次才能当剂量基准。中断场次(做完 1 组就退出)的组数
  // 此前会被拿来夹到 minSets,配一句"保持保守剂量",等于一次中断永久砍量。
  let sets = latest?.completed && latest.sets ? Math.min(exercise.maxSets, Math.max(exercise.minSets, latest.sets)) : exercise.defaultSets;
  let repRange = doseRange, confidence = estimate?.confidence ?? "low", modelSource: CapabilityAdjustment["modelSource"] = estimate?.cleanSessionCount ? "exercise" : movementEvidence.compatible ? "movement_pattern" : "experience_default";
  let targetRir = 2;
  const reasonCodes: string[] = [], evidence: string[] = [], base = { sets, repRange, loadKg: weight, targetRir };
  let userExplanation = "", progressionStep: ExerciseRecommendation["progressionStep"], progressionExerciseId: string | undefined, adjustment = "maintain";
  const setForLatest = latest ? facts.sets.filter(x => x.sessionId === latest.sessionId && x.exerciseId === exercise.id).sort((a, b) => a.setNumber - b.setNumber) : [];
  const easy = latest?.completed && latest.difficulty === "easy" && (setForLatest.length >= 2 || Boolean(previous?.completed && previous.difficulty === "easy")), consecutiveEasy = easy && (!previous || (previous.completed && previous.difficulty === "easy"));
  if (capability.recentPainEvent || latest?.difficulty === "pain") {
    action = "avoid"; sets = exercise.minSets; reasonCodes.push("recent_pain_safety_override", "capability_progression_blocked", "progression_blocked"); evidence.push("recent_pain_record"); adjustment = "safety_avoid";
    userExplanation = "近期记录到疼痛，安全优先；今天避免该动作并选择无痛替代，不按普通困难反馈回退剂量。";
  } else if (estimate?.staleness === "very_stale") {
    action = "calibrate"; sets = exercise.minSets; confidence = "low"; reasonCodes.push("capability_stale_over_90_days", "calibration_required"); evidence.push("last_exposure_over_90_days_ago"); adjustment = "recalibrate";
    userExplanation = "该动作超过 90 天没有近期证据；不沿用旧负荷，先用低剂量重新确认。";
  } else if (["fatigued", "very_fatigued"].includes(context.recoveryState) || (context.recoveryState === "unknown" && model.recoveryTendency.recentHighFatigue)) {
    action = "reduce_volume"; sets = Math.max(exercise.minSets, Math.min(sets, (latest?.sets ?? exercise.defaultSets) - 1)); targetRir = 3; reasonCodes.push(context.recoveryState === "unknown" ? "recent_survey_fatigue" : "reported_fatigue", "capability_volume_reduced"); evidence.push(context.recoveryState === "unknown" ? "recent_post_session_fatigue_survey" : `reported_recovery_${context.recoveryState}`); adjustment = "reduce_sets";
    userExplanation = "今天恢复信号偏疲劳，保留动作与已知负荷，减少一组；若有疼痛则先走安全处理。";
  } else if (latest && (latest.difficulty === "failed" || (latest.completed && setForLatest.some(x => !isTimedDose(x.targetReps) && x.actualReps < min)))) {
    action = "regress"; sets = Math.max(exercise.minSets, Math.min(sets - 1, latest.sets));
    const lowerWeight = nextAvailableWeight(exercise.equipmentIds[0], weight, -1);
    const timedDose = isTimedDose(doseRange);
    if (lowerWeight !== undefined && weight !== undefined && lowerWeight < weight) weight = lowerWeight;
    else if (!timedDose) repRange = `${min}-${Math.max(min, max - 2)}`;
    // B3:时长型的目标是"秒",按次数收窄会产出"300-298秒"这种不存在的剂量,只减组不改时长
    if (timedDose) reasonCodes.push("timed_dose_not_narrowed");
    targetRir = 3; reasonCodes.push("recent_failed_reps", "dose_regressed", "product_heuristic_capability_v2"); evidence.push("target_reps_not_completed"); adjustment = "regress_dose";
    userExplanation = `上次没有完成目标${timedDose ? "时长" : "次数"}，本次${weight !== base.loadKg ? `负荷下调到 ${weight}kg` : timedDose ? "时长保持不变" : `目标次数收窄到 ${repRange}`}并减少训练量，不做 progression。`;
  } else if (latest && latest.difficulty === "hard") {
    if (previous?.completed && previous.difficulty === "hard") { action = "reduce_volume"; sets = Math.max(exercise.minSets, sets - 1); adjustment = "reduce_sets_after_repeated_hard"; reasonCodes.push("repeated_hard_sessions", "volume_reduced"); }
    else { action = "maintain"; adjustment = "maintain_after_hard_completed"; reasonCodes.push("hard_but_completed", "hysteresis_hold"); }
    targetRir = 3; evidence.push("latest_completed_session_was_hard"); userExplanation = previous?.difficulty === "hard" ? "连续两次完成但都感觉偏难，本次减少一组，其余剂量保持。" : "上次完成但感觉偏难，本次先保持剂量，不加量；需要连续稳定反馈才反向进阶。";
  } else if (latest && !latest.completed) {
    reasonCodes.push("interrupted_session_not_capacity_failure"); evidence.push("session_interrupted_without_failure_evidence"); adjustment = "hold_after_interruption";
    userExplanation = "上次训练被中断；没有足够证据判断能力下降，本次按默认剂量重新确认，不按中断场次缩量。";
  } else if (latest?.completed && setForLatest.length >= trainingModelRules.minimumEvidenceForProgression && setForLatest.every(x => x.actualReps >= max && (x.rir ?? -1) >= 2 && !x.pain) && !["hard", "failed", "pain"].includes(latest.difficulty)) {
    const nextWeight = nextAvailableWeight(exercise.equipmentIds[0], weight, 1);
    if (nextWeight !== undefined && weight !== undefined && nextWeight > weight) { action = "progress"; weight = nextWeight; progressionStep = "load"; adjustment = "increase_load_one_step"; reasonCodes.push("top_rep_range_reached", "target_rir_maintained", "minimum_evidence_met", "one_step_load_cap", "product_heuristic_capability_v2"); evidence.push("completed_top_rep_sets", "target_rir_at_least_2", "three_clean_sets"); const finalRir = setForLatest.at(-1)?.rir ?? 2; userExplanation = `最近一节完成${setForLatest.length}组上限次数，末组仍保留约${finalRir}次余力，本次只增加一个可用重量档。`; }
    else { reasonCodes.push("rep_ceiling_reached", "no_real_load_increment"); adjustment = "hold_at_rep_ceiling"; evidence.push("no_supported_equipment_increment"); userExplanation = "已达到次数上限，但当前器械没有可确认的下一档负荷，本次保持，不虚构重量。"; }
  } else if (latest && easy && consecutiveEasy && estimate?.staleness !== "very_stale") {
    // B1(2026-11-09):次数进阶只认实测。assumed 次数是按计划推定的,拿它抬下次目标
    // 等于让推定改剂量 —— M3 当时只堵了 +load 路径,次数路径仍由 assumed 驱动。
    const measuredSets = setForLatest.filter(x => (x.actualRepsSource === "counted" || x.actualRepsSource === "reported") && !x.pain);
    const measuredRepDone = measuredSets.length ? Math.round(measuredSets.reduce((n, x) => n + x.actualReps, 0) / measuredSets.length) : undefined;
    const repDone = measuredRepDone ?? estimate?.estimatedWorkingReps ?? min; // 仅用于文案与装载,不单独构成进阶依据
    const noHardInRecentWindow = outcomes.slice(0, 2).every(x => x.difficulty === "easy");
    const nextWeight = nextAvailableWeight(exercise.equipmentIds[0], weight, 1);
    // "到顶"同样只认实测次数:assumed 到顶不构成任何进阶依据(与 load 路径同一口径)
    const atRepCeiling = measuredRepDone !== undefined && measuredRepDone >= max;
    const measuredAtCeiling = measuredSets.length > 0 && measuredSets.every(x => x.actualReps >= max);
    const measuredProgressionEvidence = measuredSets.length >= trainingModelRules.minimumEvidenceForProgression || Boolean(previous?.completed && previous.difficulty === "easy" && previous.loadKg === latest.loadKg && previous.targetReps === latest.targetReps && measuredSets.length >= 2);
    if (measuredRepDone !== undefined && !atRepCeiling && noHardInRecentWindow) {
      action = "progress"; progressionStep = "repetitions"; const next = Math.min(max, Math.max(min, repDone + 1)); repRange = `${next}-${max}`; adjustment = "increase_reps";
      reasonCodes.push("recent_clean_easy_session", "repeated_easy_completed_sets", "reps_before_load", "product_heuristic_capability_v2"); evidence.push("completed_clean_session", "explicit_or_rir_easy", "no_recent_pain");
      userExplanation = `上次干净完成且感觉轻松，本次只增加 1 次目标（${repRange}）；先加次数，暂不同时增加负荷或组数。`;
    } else if (atRepCeiling && measuredAtCeiling && measuredProgressionEvidence && nextWeight !== undefined && weight !== undefined) {
      action = "progress"; weight = nextWeight; progressionStep = "load"; adjustment = "increase_load_one_step"; reasonCodes.push("rep_ceiling_reached", "real_load_increment_available", "one_step_load_cap", "measured_reps_only", "product_heuristic_capability_v2"); evidence.push("completed_at_rep_ceiling", "measured_reps_at_ceiling", measuredSets.length >= trainingModelRules.minimumEvidenceForProgression ? "three_clean_sets" : "repeated_easy_sessions");
      userExplanation = `实测达到次数上限且感觉轻松，本次只增加一个可用重量档，不同时增加组数。`;
    } else if (atRepCeiling && nextWeight === undefined && previous?.completed && previous.difficulty === "easy" && previous.loadKg === latest.loadKg && previous.targetReps === latest.targetReps && exercise.progressions?.length) {
      const progression = exercise.progressions.map(id => exercises.find(x => x.id === id)).filter((x): x is Exercise => Boolean(x) && compatibleMovementEvidence({ id: x.id, movementPattern: x.movementPattern, difficulty: x.difficulty, unilateral: x.unilateral, equipmentIds: x.equipmentIds }, exercises, model.movementCapabilities).compatible && x.environments.includes(context.environment) && !x.contraindicationTags.some(tag => context.restrictions.includes(tag)) && !context.constraints.avoidExercises.includes(x.id) && (!context.availableEquipmentIds || x.equipmentIds.every(id => context.availableEquipmentIds!.includes(id))))[0];
      if (progression) { action = "progress"; progressionExerciseId = progression.id; progressionStep = "difficulty"; adjustment = "increase_exercise_difficulty"; reasonCodes.push("repeated_easy_at_rep_ceiling", "compatible_graph_progression", "product_heuristic_capability_v2"); evidence.push("repeated_easy_sessions", "movement_and_unilateral_compatibility"); userExplanation = `次数已到上限且有重复轻松证据，按兼容的动作关系尝试${progression.name}，从校准组开始。`; }
    } else if (atRepCeiling && nextWeight === undefined && estimate.easySessionCount >= 3 && sets < exercise.maxSets) {
      action = "progress"; sets++; progressionStep = "repetitions"; adjustment = "increase_sets_one"; reasonCodes.push("repeated_easy_sessions", "sets_progressed_last", "product_heuristic_capability_v2"); evidence.push("three_or_more_clean_easy_sessions", "rep_ceiling_reached", "no_load_increment_available"); userExplanation = "连续轻松完成、次数已到上限且没有合适负荷增量，本次仅增加一组。";
    } else { reasonCodes.push("rep_ceiling_or_conflicting_history", "hysteresis_hold", "insufficient_evidence_for_progression"); adjustment = "hold_for_confirmation"; evidence.push("recent_history_not_consistently_easy"); if (measuredRepDone === undefined || (atRepCeiling && !measuredAtCeiling)) { reasonCodes.push("assumed_reps_excluded"); userExplanation = "最近的完成次数是按计划推定的，没有实测证据；先保持剂量，实测到次数上限再考虑加重。"; } else userExplanation = "近期表现尚未达到稳定进阶条件，本次保持剂量，避免一次轻松反馈后反复加量。"; }
  } else if (!latest) {
    sets = exercise.minSets; confidence = movementEvidence.compatible ? movementEvidence.confidence : "low"; action = "calibrate"; adjustment = movementEvidence.compatible ? "calibrate_from_pattern" : "experience_default_calibration";
    if (movementEvidence.compatible) { reasonCodes.push("familiar_movement_pattern", "conservative_transfer_only"); evidence.push(`compatible_pattern_sessions_${movementEvidence.validSessionCount}`, `compatible_source_exercises_${movementEvidence.sourceExerciseIds.join(",")}`); userExplanation = `没有该动作的直接记录，但${exercise.movementPattern}模式有兼容历史；只用于保守初始化${sets}组，不迁移旧负荷。`; }
    else { reasonCodes.push("no_training_history", "experience_default_calibration"); evidence.push("no_exercise_or_compatible_pattern_history"); userExplanation = `暂无该动作或兼容模式的历史，按经验水平的低剂量默认值先做${sets}组校准。`; }
  } else { reasonCodes.push("recent_performance_tolerated", "maintain_within_dose_boundaries"); if (latest?.difficulty === "easy" && setForLatest.length < 2) reasonCodes.push("insufficient_evidence_for_progression"); if (latest?.difficulty === "easy" && previous && previous.difficulty !== "easy") reasonCodes.push("hysteresis_hold"); evidence.push("no_progression_or_regression_trigger"); userExplanation = "近期表现没有触发增量或回退条件，本次保持已耐受剂量。"; }

  // First-layer memory: an explicit, recorded MVP adjustment, not a new capability model.
  const latestSession = latest && facts.sessions.find(x => x.sessionId === latest.sessionId);
  const remembered = latestSession?.runtime?.events?.filter(x => x.type === "coach_adjustment" && x.exerciseId === exercise.id).at(-1);
  if (remembered?.details?.reason === "too_heavy" && !capability.recentPainEvent && estimate?.staleness !== "very_stale") {
    const after = remembered.details.after as { weightKg?: number; targetReps: string };
    weight = after.weightKg; repRange = after.targetReps; action = "regress"; adjustment = "remember_explicit_coach_adjustment";
    progressionStep = undefined; progressionExerciseId = undefined;
    reasonCodes.push("last_coach_feedback_too_heavy", "AdjustmentPolicyV0"); evidence.push(`coach_adjustment_${remembered.id}`);
    userExplanation = `根据上次偏重反馈，本次${weight !== undefined ? `建议 ${weight}kg，${repRange} 次` : `目标 ${repRange} 次`}，先确认合适强度。`;
  }
  const patternVolume = model.volumeToleranceByPattern[exercise.movementPattern], load = model.movementPatternLoads[exercise.movementPattern];
  if (load && (load.last7Days.workingSets >= trainingModelRules.highPatternWorkingSets || (load.daysSinceLastMovementPattern !== undefined && load.daysSinceLastMovementPattern <= 1 && load.last7Days.workingSets >= 6))) {
    sets = Math.max(exercise.minSets, sets - 1); if (action === "progress") { action = "maintain"; progressionStep = undefined; progressionExerciseId = undefined; weight = capability.recommendedWeightKg ?? exercise.defaultWeightKg; repRange = exercise.defaultReps; adjustment = "hold_for_recent_pattern_volume"; }
    reasonCodes.push("recent_pattern_load_high", "volume_reduced"); evidence.push(`pattern_sets_last_7_days_${patternVolume?.cleanSetsLast7Days ?? load.last7Days.workingSets}`);
  }
  if (context.recoveryState === "unknown") reasonCodes.push("recovery_unknown");
  const capabilityAdjustment: CapabilityAdjustment = { adjustment, from: base, to: { sets, repRange, loadKg: weight, targetRir }, evidence, confidence, modelSource, ruleId: "history-capability-adjustment-v2" };
  return { exerciseId: exercise.id, weightKg: weight, repRange, sets, targetRir, confidence, action, reasonCodes, userExplanation, calibrationSet: action === "calibrate", progressionStep, progressionExerciseId, knowledgeRuleIds: [capabilityAdjustment.ruleId], capabilityAdjustment };
}
export function generateWorkout(context: SessionContext, facts: TrainingFacts = { sessions: [], sets: [] }): WorkoutSession {
  context.recoveryState ??= "unknown";
  context.previousTraining ??= { status: "unknown", areas: [] };
  context.goalContext ??= { type: "general", priority: null };
  context.constraints ??= { avoidExercises: [], avoidMovements: [], noJumping: false, noiseSensitive: false };
  const model = buildUserTrainingModel(context.userId, facts, context.recoveryState);
  // B9:防御性夹取 —— 即使 context 从别处传进来(API/测试),也不让 0 或 999 进处方
  const available = Math.min(DURATION_MAX_MINUTES, Math.max(DURATION_MIN_MINUTES, context.availableDurationMinutes ?? context.durationMinutes));
  const goal: TrainingGoal = context.goalContext?.type === "upper_body" ? "upper_body" : context.goalContext?.type === "chest" ? "chest_strength" : context.goalContext?.type === "lower_body" ? "lower_body" : context.goalContext?.type === "mobility" ? "mobility" : context.focus === "back" ? "back_strength" : "general_fitness", rules = prescriptionRules[goal];
  const durationIntent = context.durationIntent ?? "maximum";
  const interpretedGoal = context.goalContext.type === "general" && context.focus === "back" ? "back" : context.goalContext.type === "general" && context.focus === "legs" ? "lower_body" : context.goalContext.type;
  const stimulus = resolveRequiredStimulus({ rawInput: context.rawInput ?? "", interpretedGoal, durationMinutes: available, durationIntent, recoveryState: context.recoveryState, experienceLevel: context.experienceLevel, previousTraining: context.previousTraining, movementPatternLoads: model.movementPatternLoads });
  const environmentEquipment = context.environment === "gym" && context.gymId ? ["bodyweight", ...gymEquipment.filter(x => x.gymId === context.gymId && x.available).map(x => x.equipmentId)] : context.environment === "home" ? ["bodyweight", "dumbbell", "resistance_band"] : context.environment === "office" ? ["bodyweight", "resistance_band"] : ["bodyweight", "dumbbell", "barbell", "cable", "machine", "bench", "resistance_band", "pull_up_bar", "rings"];
  const allowedEquipment = new Set(context.availableEquipmentIds ? context.availableEquipmentIds.filter(id => environmentEquipment.includes(id)) : environmentEquipment);
  const focusMuscles: Record<string, string[]> = { back: ["back", "latissimus_dorsi", "trapezius", "rhomboids", "erector_spinae"], chest: ["chest", "pectoralis_major", "rectus_abdominis"], legs: ["legs", "gluteus_maximus", "quadriceps", "hamstrings", "adductors"] };
  let candidates = exercises.filter(e => e.environments.includes(context.environment) && e.equipmentIds.some(id => allowedEquipment.has(id)) && (e.requiredEquipmentIds ?? []).every(id => allowedEquipment.has(id)) && !context.constraints.avoidExercises.includes(e.id) && !context.constraints.avoidMovements.some(pattern => e.movementPattern === pattern) && !(context.constraints.noJumping && e.impactLevel === "high")); if (context.focus && goal !== "upper_body" && goal !== "chest_strength") candidates = candidates.filter(e => e.primaryMuscles.some(m => (focusMuscles[context.focus!] ?? [context.focus!]).includes(m))); if (!candidates.length) throw new Error("当前环境和目标下没有可用动作，请调整目标或器械条件。");
  // 恢复约束的主口径(2026-11-10):同一肌群每周 2–3 次,超过上限本周不再给这个部位加容量。
  // 依据:Schoenfeld 2016 频率 meta(DOI 10.1007/s40279-016-0543-8,见 docs/EVIDENCE-RECOVERY.md 第 2 条)。
  // 小时数(muscles.ts 的 recoveryHours/recoveryPercent)只作展示层提示,不参与这里的取舍。
  // 用户自报酸痛优先于任何估算(2026-11-10 7ed6444):酸痛按部位直接排除。
  // 两处都保守:过滤后候选不足 3 个就不过滤,宁可少避一点,也不能排不出课。
  const soreMuscles: Record<string, string[]> = {
    legs: ["legs", "quadriceps", "hamstrings", "glutes", "calves", "adductors", "hip_flexors", "gastrocnemius", "soleus", "gluteus_maximus", "gluteus_medius"],
    chest: ["chest", "pectoralis_major", "rectus_abdominis"],
    shoulder: ["rear_delt", "shoulder", "anterior_deltoid", "lateral_deltoid", "posterior_deltoid"],
    lower_back: ["back", "erector_spinae", "latissimus_dorsi", "trapezius", "rhomboids"],
  };
  const bannedMuscles = new Set<string>(context.soreness.flatMap(area => soreMuscles[area] ?? []));
  // 低强度活动（快走/活动度）不算力量训练：它们只进"今天动过"的展示，
  // 不触发 24h 硬线，也不占每周 2–3 次的名额（2026-11-11 审查修）。
  const lightExerciseIds = buildLightExerciseIds(exercises);
  const frequencyLedger = facts.sets.length ? buildMuscleLedger({
    sets: facts.sets.map(set => ({ exerciseId: set.exerciseId, completedAt: set.completedAt, sessionId: set.sessionId, actualRepsSource: set.actualRepsSource })),
    musclesByExercise: primaryMusclesByExerciseId,
    lightExerciseIds,
  }) : [];
  const overFrequency = new Set<MuscleGroup>(frequencyLedger.filter(x => x.frequencyStatus === "above").map(x => x.group));
  // 24 小时硬线（2026-11-10，依据 MacDougall 1995 的 MPS 时程）：同一部位刚练完不排力量动作。
  // 只拦力量动作——低强度收尾（快走/活动度）照旧保留，见下面 timedPlan 那段。
  const tooSoon = new Set<MuscleGroup>(frequencyLedger.filter(x => x.intervalStatus === "too_soon").map(x => x.group));
  const blockedMuscle = (muscle: string) => bannedMuscles.has(muscle) || overFrequency.has(canonicalMuscle(muscle) as MuscleGroup) || tooSoon.has(canonicalMuscle(muscle) as MuscleGroup);
  const blockedExercise = (exercise: Exercise) => exercise.primaryMuscles.some(blockedMuscle);
  let frequencyHold = new Set<MuscleGroup>(); // 实际生效的"本周次数已到上限"部位（候选够 3 个才生效）
  let intervalHold = new Set<MuscleGroup>(); // 实际生效的"24 小时内刚练过"部位
  // 只有真的把候选换掉了才算"约束生效"。此前不论是否过滤，safetyNotes 都写
  // "今天会控制相关部位的强度" —— 于是出现"一边排深蹲一边说已控制强度"的自相矛盾
  // （2026-11-11 审查）。这里记下实际生效的集合，话术与 ruleId 都按它来。
  const sorenessBlocked = new Set<string>();
  if (bannedMuscles.size || overFrequency.size || tooSoon.size) {
    const withoutBlocked = candidates.filter(exercise => !blockedExercise(exercise));
    if (withoutBlocked.length >= 3) {
      candidates = withoutBlocked; frequencyHold = overFrequency; intervalHold = tooSoon;
      for (const muscle of bannedMuscles) sorenessBlocked.add(muscle);
    }
  }
  // 报了酸痛但一个候选都排不掉（例如"腿酸 + 要练下肢"）：过滤被短路。
  // 这时必须如实说明，不能继续宣称"已控制强度"。
  const sorenessSkipped = new Set<string>(context.soreness.filter(area => (soreMuscles[area] ?? []).length > 0 && !sorenessBlocked.has((soreMuscles[area] ?? [])[0]!)));
  const selected = new Set<string>();
  const rank = (x: Exercise) => (model.exerciseCapabilities[x.id]?.recentPainEvent ? 1000 : 0) + (model.preferenceProfile.byExercise[x.id]?.skipCount ?? 0) * 10 + (model.preferenceProfile.byExercise[x.id]?.replaceCount ?? 0) * 5 + (model.preferenceProfile.byExercise[x.id]?.tooHardCount ?? 0) * 8 - Math.min(30, (model.preferenceProfile.byExercise[x.id]?.tooLightCount ?? 0) * 6);
  const preferredRecipeId = /恢复训练|恢复一下/.test(context.rawInput) ? "recovery" : context.environment === "office" ? "desk_break" : /有氧|心肺|体能/.test(context.rawInput) ? "general_conditioning" : undefined;
  const recipe = sessionRecipe(goal, available, context.environment, preferredRecipeId);
  const coverage = [...stimulus.primaryPatterns, ...stimulus.secondaryPatterns] as MovementPattern[];
  const mainDefs = coverage.map(pattern => candidates.filter(x => (x.movementPattern === pattern || goal === "upper_body" && pattern === "vertical_pull" && x.movementPattern === "horizontal_pull") && !selected.has(x.id)).sort((a, b) => Number(b.movementPattern === pattern) - Number(a.movementPattern === pattern) || rank(a) - rank(b))[0]).filter((x): x is Exercise => Boolean(x)).map(x => (selected.add(x.id), x));
  // 2026-11-11 审查：upper_body 缺 vertical_pull 时会回退到 horizontal_pull，于是同一个
  // 动作可能被两个 pattern 各选一次（选了也得排除，但"先 map 再加 selected"的顺序让
  // 第二个 pattern 仍可能选中它）——"30分钟，在家，有哑铃，想练上肢"就会出现
  // 单臂哑铃划船两次。这里按 exerciseId 去重，保留首次出现的位置。
  const uniqueMain = mainDefs.filter((def, index) => mainDefs.findIndex(other => other.id === def.id) === index);
  mainDefs.length = 0;
  mainDefs.push(...uniqueMain);
  const recipeAccessoryPatterns = context.durationIntent === "target" && available >= 30 ? stimulus.accessoryPatterns : [];
  const preferredAccessories = context.durationIntent === "target" && available >= 30 ? rules.preferredAccessoryPatterns : [];
  const requestedArmPatterns: MovementPattern[] = goal === "chest_strength" && /手臂|arm/i.test(context.rawInput) ? ["arm_curl", "arm_extension"] : [];
  const accessoryPatterns = [...new Set([...preferredAccessories, ...requestedArmPatterns, ...new Set(recipeAccessoryPatterns.filter(pattern => !preferredAccessories.includes(pattern))).values().take(available >= 45 ? 2 : 1)])];
  const accessoryDefs = accessoryPatterns.map(pattern => candidates.find(x => x.movementPattern === pattern && !selected.has(x.id))).filter((x): x is Exercise => Boolean(x)).map(x => (selected.add(x.id), x));
  if (!mainDefs.length) mainDefs.push(candidates[0]);
  const toWorkoutExercise = (exercise: Exercise, block: "main" | "accessory"): WorkoutExercise => {
    const recommendation = recommendExercise(exercise, model, facts, context);
    const progression = recommendation.progressionExerciseId ? candidates.find(x => x.id === recommendation.progressionExerciseId && !selected.has(x.id)) : undefined;
    const definition = progression ?? exercise;
    if (progression) { selected.add(progression.id); recommendation.exerciseId = progression.id; }
    const weight = progression ? undefined : (recommendation.weightKg || undefined); // 0=自重,归一为 undefined(剂量走次数路径、休息封顶、单位留空)
    const maxKnowledgeSets = getGoalProfile(stimulus.goal).sets.maximum;
    const sets = Math.max(definition.minSets, Math.min(definition.maxSets, maxKnowledgeSets, recommendation.sets));
    const repOrTimeBased = definition.repOrTimeBased ?? "reps", targetReps = repOrTimeBased === "time" || recommendation.action !== "calibrate" || recommendation.progressionStep === "repetitions" ? recommendation.repRange : stimulus.repRange;
    const rirRange = getGoalProfile(stimulus.goal).targetRir, targetRir = Math.max(rirRange.minimum, Math.min(rirRange.maximum, Math.max(stimulus.targetRir, recommendation.targetRir)));
    recommendation.sets = sets; recommendation.repRange = targetReps; recommendation.targetRir = targetRir; recommendation.knowledgeRuleIds = [...new Set([...stimulus.ruleIds, "history-capability-adjustment-v2"])];
    if (recommendation.capabilityAdjustment) { recommendation.capabilityAdjustment.from.targetRir = stimulus.targetRir; recommendation.capabilityAdjustment.to = { sets, repRange: targetReps, loadKg: weight, targetRir }; }
    const alternatives = (substitutionGraph[definition.id] ?? []).map(x => exercises.find(y => y.id === x.exerciseId)).filter((x): x is Exercise => Boolean(x) && candidates.some(y => y.id === x.id)).sort((a, b) => rank(a) - rank(b));
    // 自重/无外部负荷(weight undefined)为肌耐力型:主项组间休息封顶 60s,不沿用力量型长间歇
    return { id: randomUUID(), exerciseId: definition.id, name: definition.name, attentionLevel: definition.attentionLevel, unilateral: definition.unilateral, equipmentId: definition.equipmentIds.find(id => allowedEquipment.has(id)), sets, targetReps, repOrTimeBased, recommendedWeight: weight, currentWeight: weight, weightUnit: weight === undefined ? undefined : "kg", restSeconds: repOrTimeBased === "time" ? 0 : block === "main" ? (weight === undefined ? Math.min(stimulus.restSeconds, 60) : stimulus.restSeconds) : Math.max(30, stimulus.restSeconds - 30), targetRir, recommendation, instructions: definition.instructions, voiceCues: definition.voiceCues, source: definition.source, sourceId: definition.sourceId, sourceCommit: definition.sourceCommit, sourceLicense: definition.sourceLicense, attributionRequired: definition.attributionRequired, alternatives: alternatives.map(x => x.id), rationale: recommendation.userExplanation, executionStatus: "pending", completedSets: 0 };
  };
  let mainItems = mainDefs.map(x => toWorkoutExercise(x, "main")), accessoryItems = accessoryDefs.map(x => toWorkoutExercise(x, "accessory"));
  let warmupMinutes = available >= 30 ? 5 : available >= 15 ? 3 : 1, cooldownMinutes = available >= 30 ? 4 : available >= 15 ? 2 : 1;
  const all = () => [...mainItems, ...accessoryItems];
  if (context.durationIntent === "target") {
    const budget = Math.min(stimulus.workingSetCap, Math.max(rules.maxWorkingSets, Math.ceil(available / 2.5)));
    const reserved = new Set([...selected].flatMap(id => (substitutionGraph[id] ?? []).map(relation => relation.exerciseId)));
    const recipeAccessoryPatterns = [...stimulus.secondaryPatterns, ...stimulus.accessoryPatterns];
    const extras = candidates.filter(x => !selected.has(x.id) && !reserved.has(x.id) && x.repOrTimeBased !== "time" && recipeAccessoryPatterns.includes(x.movementPattern)).sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
    for (const definition of extras) {
      if (all().length >= stimulus.exerciseCountRange[1] || accessoryItems.length >= (available >= 60 ? 3 : available >= 45 ? 2 : 1)) break;
      if (durationBreakdown(all(), warmupMinutes, cooldownMinutes).totalSeconds >= (available - 3) * 60) break;
      const item = toWorkoutExercise(definition, "accessory");
      if (all().reduce((n, x) => n + x.sets, 0) + item.sets > budget) continue;
      if (durationBreakdown([...all(), item], warmupMinutes, cooldownMinutes).totalSeconds <= available * 60) { accessoryItems.push(item); selected.add(definition.id); }
    }
    if (available >= 10 && (context.environment === "office" || available >= 15)) {
      const timedCount = available >= 45 ? 2 : 1, remaining = available * 60 - durationBreakdown(all(), warmupMinutes, cooldownMinutes).totalSeconds - timedCount * TRANSITION_SECONDS;
      const timedBlock = recipe.blocks.some(x => x.type === "conditioning" || x.type === "mobility");
      if (remaining >= 2 * 60 && timedBlock) {
        const timedPlan: Array<[string, number]> = timedCount === 2
          ? [["march-in-place", Math.round(remaining * .6)], ["standing-mobility", Math.floor(remaining * .4)]]
          : [[context.environment === "office" || goal === "mobility" ? "standing-mobility" : "march-in-place", remaining]];
        for (const [id, plannedSeconds] of timedPlan) {
          const definition = exercises.find(x => x.id === id)!;
          // 这块绕过候选过滤，单独挡一次：本周次数已到上限的部位不再塞低强度收尾。
          // 酸痛不在这一条里——低强度快走/活动度对酸痛是有益的，酸痛只挡该部位的力量动作。
          if (definition.primaryMuscles.some(m => overFrequency.has(canonicalMuscle(m) as MuscleGroup))) continue;
          const item = toWorkoutExercise(definition, "accessory");
          item.sets = 1; item.targetReps = `${plannedSeconds}秒`; item.recommendation.sets = 1; item.recommendation.repRange = item.targetReps; item.restSeconds = 0;
          accessoryItems.push(item);
        }
      }
    }
  }
  while (durationBreakdown(all(), warmupMinutes, cooldownMinutes).totalSeconds > available * 60 && accessoryItems.length) accessoryItems.pop();
  while (durationBreakdown(all(), warmupMinutes, cooldownMinutes).totalSeconds > available * 60) { const reducible = [...accessoryItems, ...mainItems].reverse().find(x => x.sets > 1); if (reducible) { reducible.sets--; reducible.recommendation.sets = reducible.sets; } else if (mainItems.length > 1) mainItems.pop(); else if (warmupMinutes > 1) warmupMinutes--; else if (cooldownMinutes > 1) cooldownMinutes--; else break; }
  const items = all(), workingSets = items.reduce((sum, x) => sum + x.sets, 0);
  const maxWorkingSets = Math.min(stimulus.workingSetCap, context.durationIntent === "target" ? Math.max(rules.maxWorkingSets, Math.ceil(available / 2.5)) : rules.maxWorkingSets);
  if (workingSets > maxWorkingSets) throw new Error("处方工作组超过配置上限。");
  const breakdown = durationBreakdown(items, warmupMinutes, cooldownMinutes), planned = Math.ceil(breakdown.totalSeconds / 60), optional = Math.max(0, available - planned);
  const optionalBlock: OptionalItem[] = optional >= rules.optionalMinimumMinutes ? [{ type: "cardio", name: "可选低强度有氧或活动度练习", durationMinutes: optional, required: false }] : [];
  const definitions = new Map(items.map(x => [x.id, exercises.find(e => e.id === x.exerciseId)!]));
  const patternSets = items.reduce((out, item) => { const pattern = definitions.get(item.id)!.movementPattern; out[pattern] = (out[pattern] ?? 0) + item.sets; return out; }, {} as Record<string, number>);
  const mainPatterns = new Set(stimulus.primaryPatterns), secondaryPatterns = new Set(stimulus.secondaryPatterns);
  const conditioningBlock = items.filter(x => definitions.get(x.id)!.movementPattern === "conditioning").map(x => x.id);
  const mobilityBlock = items.filter(x => definitions.get(x.id)!.movementPattern === "mobility").map(x => x.id);
  const timedBlockIds = new Set([...conditioningBlock, ...mobilityBlock]);
  const mainBlock = items.filter(x => !timedBlockIds.has(x.id) && mainPatterns.has(definitions.get(x.id)!.movementPattern)).map(x => x.id);
  const secondaryBlock = items.filter(x => !timedBlockIds.has(x.id) && secondaryPatterns.has(definitions.get(x.id)!.movementPattern) && !mainBlock.includes(x.id)).map(x => x.id);
  const accessoryBlock = items.filter(x => !mainBlock.includes(x.id) && !secondaryBlock.includes(x.id) && !conditioningBlock.includes(x.id) && !mobilityBlock.includes(x.id)).map(x => x.id);
  const blockItems = { main: mainBlock, secondary: secondaryBlock, accessory: accessoryBlock, conditioning: conditioningBlock, mobility: mobilityBlock };
  const blockDuration: Record<string, number> = { warmup: warmupMinutes * 60, main: 0, secondary: 0, accessory: 0, conditioning: 0, mobility: 0, cooldown: cooldownMinutes * 60 };
  let activeBlockCount = 0;
  for (const [blockName, ids] of Object.entries(blockItems)) if (ids.length) {
    const groupSeconds = ids.reduce((sum, id) => { const x = items.find(y => y.id === id)!; const work = x.sets * (x.repOrTimeBased === "time" ? Number(x.targetReps.match(/\d+/)?.[0] ?? 0) : SET_SECONDS); return sum + work + Math.max(0, x.sets - 1) * x.restSeconds; }, 0) + Math.max(0, ids.length - 1) * TRANSITION_SECONDS;
    blockDuration[blockName] = groupSeconds + (activeBlockCount++ > 0 ? TRANSITION_SECONDS : 0);
  }
  const patterns = items.map(x => definitions.get(x.id)!.movementPattern);
  const reasoningSummary = [`本次目标 ${stimulus.goal}，先满足${patterns.join("、")}训练刺激`, `采用 ${workingSets} 个工作组，不超过 ${maxWorkingSets} 组上限`, optional ? `剩余 ${optional} 分钟作为可选训练时间` : "核心训练已接近可用时间上限"];
  const blocks: WorkoutBlocks = { warmup: { durationMinutes: warmupMinutes }, mainBlock, secondaryBlock, accessoryBlock, conditioningBlock, mobilityBlock, optionalBlock, cooldown: { durationMinutes: cooldownMinutes } };
  const decisionReasons = [...stimulus.decisionReasons];
  if (context.availableEquipmentIds) decisionReasons.push({ type: "equipment", reason: `Exercise candidates were restricted to explicitly available equipment: ${context.availableEquipmentIds.join(", ")}.` });
  if (items.some(x => x.recommendation.progressionStep)) decisionReasons.push({ type: "progression", reason: "Recent completed sets support a small, explainable load or repetition progression.", ruleId: "history-progression-v1" });
  if (items.some(x => x.recommendation.action === "regress" || x.recommendation.action === "reduce_volume")) decisionReasons.push({ type: "regression", reason: "Recent difficult or incomplete work, fatigue, or high pattern volume limited this session's dose.", ruleId: "history-progression-v1" });
  if (frequencyHold.size) decisionReasons.push({ type: "recovery", reason: `Weekly frequency is already at the ${WEEKLY_FREQUENCY_TARGET.min}–${WEEKLY_FREQUENCY_TARGET.max}x target for ${[...frequencyHold].join(", ")}; this week no extra volume is added to those muscles.`, ruleId: WEEKLY_FREQUENCY_TARGET.ruleId });
  if (intervalHold.size) decisionReasons.push({ type: "recovery", reason: `${[...intervalHold].join(", ")} were trained within the last ${MIN_SAME_MUSCLE_INTERVAL_HOURS} hours; muscle protein synthesis is still elevated, so no strength work for those muscles today (low-intensity movement is still allowed).`, ruleId: MIN_SAME_MUSCLE_INTERVAL_RULE_ID });
  if (sorenessSkipped.size) decisionReasons.push({ type: "recovery", reason: `Reported soreness for ${[...sorenessSkipped].join(", ")} could not be applied: after excluding those muscles there were fewer than 3 candidate exercises, so the session was kept as-is instead of returning an unusable plan.`, ruleId: SORENESS_NOT_APPLIED_RULE_ID });
  const legacyRuleIds = ["session_movement_coverage_v0", "target_rir_v0", "set_range_v0", "progression_requires_history_v0", "duration_recipe_v0"];
  const prescription: Prescription = { goal, workingSets, maxWorkingSets, availableDurationMinutes: available, plannedDurationMinutes: planned, optionalDurationMinutes: optional, movementPatterns: patterns, reasoningSummary, ruleIds: [...new Set([...legacyRuleIds, ...stimulus.ruleIds, ...(frequencyHold.size ? [WEEKLY_FREQUENCY_TARGET.ruleId] : []), ...(intervalHold.size ? [MIN_SAME_MUSCLE_INTERVAL_RULE_ID] : []), ...(sorenessSkipped.size ? [SORENESS_NOT_APPLIED_RULE_ID] : [])])], decisionReasons };
  return { schemaVersion: "1.2", sessionId: randomUUID(), userId: context.userId, createdAt: new Date().toISOString(), durationMinutes: available, availableDurationMinutes: available, durationIntent, plannedDurationMinutes: planned, optionalDurationMinutes: optional, goal, environment: context.environment, gymId: context.gymId, restrictions: context.restrictions, intensity: context.intensityPreference ?? (stimulus.goal === "recovery" || stimulus.goal === "mobility" || ["fatigued", "very_fatigued"].includes(context.recoveryState) ? "low" : "moderate"), status: "preview", warmupMinutes, exercises: items, blocks, prescription, requiredStimulus: stimulus, prescriptionDiagnostics: { totalWorkingSets: workingSets, movementPatternSets: patternSets, blockDuration }, cooldownMinutes, safetyNotes: sorenessNotes(context.soreness, sorenessSkipped), estimatedDurationMinutes: planned, durationBreakdown: breakdown, durationShortfallReason: planned > available ? "最低安全处方超过可用时间。" : context.durationIntent === "target" && available - planned > 3 ? "当前动作库无法安全填满目标时长。" : undefined, runtime: { currentExerciseIndex: 0, currentSetNumber: 1, activeWorkoutMs: 0, events: [] } };
}

function addEvent(session: WorkoutSession, type: string, now: string, details?: Record<string, unknown>) { session.runtime.events.push({ id: randomUUID(), type, at: now, exerciseId: session.exercises[session.runtime.currentExerciseIndex]?.exerciseId, details }); }
const contentByTopic: Record<ExperienceTopic, string[]> = {
  AI: ["早期人工智能研究者曾用棋类游戏检验机器推理，因为规则明确，结果也容易比较。", "后来研究逐渐从手写规则转向从数据中学习模式，这改变了机器处理语言和图像的方式。", "今天的生成模型会根据上下文预测下一段信息，它并不是在训练中临时搜索一份固定答案。"],
  business: ["一家产品公司早期最稀缺的资源通常不是创意，而是对真实用户问题的清晰判断。", "低成本实验的价值，在于先确认方向，再决定是否扩大投入。", "留存常比第一次使用更能说明产品是否真正进入了用户的生活。"],
  history: ["拿破仑进攻俄国时，补给线随着军队深入而不断拉长，天气并不是唯一困难。", "俄军避免过早决战，并在撤退中削弱对手可获得的补给。", "到了撤退阶段，寒冷、饥饿和疾病共同放大了此前的战略代价。"],
  trivia: ["章鱼有三个心脏，其中两个主要把血液送往鳃。", "蜂鸟能够向后飞，是因为它的翅膀可以形成独特的八字轨迹。", "香蕉在植物分类上属于浆果，而草莓并不属于真正的浆果。"],
  story: ["清晨的列车离站时，旅人发现座位上留着一封没有署名的信。", "信里只写着下一站的钟楼和一个时间，他决定下车看看。", "钟声响起时，一个老人递给他一张旧照片，故事才刚刚显出轮廓。"]
};
export function createExperiencePack(topic: ExperienceTopic, targetDurationSeconds = 30): ExperienceContentSegment[] { const continuationId = randomUUID(); return contentByTopic[topic].map((text, i, all) => ({ id: randomUUID(), topic, text, estimatedDurationSeconds: Math.min(40, Math.max(20, Math.round(text.length / 4))), targetDurationSeconds, continuationId, continueNext: i < all.length - 1, priority: 1, interruptible: true })); }
export function sessionPhase(session: WorkoutSession): SessionPhase { return session.status === "set_feedback" ? "set_feedback" : session.status === "resting" ? "resting" : session.status === "warming_up" ? "warmup" : session.status === "cooling_down" ? "cooldown" : session.status === "exercise_active" ? "during_set" : session.status === "completed" || session.status === "aborted" ? "completed" : "transition"; }
function experienceEvent(session: WorkoutSession, type: string, details?: Record<string, unknown>, now = new Date().toISOString()) { session.experience?.events.push({ id: randomUUID(), type, at: now, phase: sessionPhase(session), details }); }
export function configureExperience(session: WorkoutSession, input: { mode?: ExperienceMode; topic?: ExperienceTopic; talkativeness?: "low" | "medium" | "high"; experimentGroup?: ExperienceMode; dataOrigin?: DataOrigin } = {}) { const mode = input.mode ?? "minimal", topic = input.topic ?? "history"; session.experience = { mode, initialMode: mode, experimentGroup: input.experimentGroup ?? mode, dataOrigin: input.dataOrigin ?? "demo", topic, talkativeness: input.talkativeness ?? "medium", enabled: mode !== "minimal", queue: mode === "minimal" ? [] : createExperiencePack(topic), currentIndex: 0, currentOffsetSeconds: 0, playback: "idle", contentSkipCount: 0, contentDisabled: false, events: [] }; experienceEvent(session, "experience_configured", { mode, topic, dataOrigin: session.experience.dataOrigin }); return session; }
export interface ExperienceDirective { priority: 1 | 2 | 3 | 4; kind: "safety" | "training" | "interaction" | "content" | "none"; action: "play" | "pause" | "stop" | "none"; text?: string; segmentId?: string; resumeOffsetSeconds?: number }
export function experienceDirective(session: WorkoutSession, input: { safetyEvent?: string; userInteraction?: string } = {}): ExperienceDirective {
  const state = session.experience, phase = sessionPhase(session), exercise = session.exercises[session.runtime.currentExerciseIndex];
  if (input.safetyEvent) return { priority: 4, kind: "safety", action: "stop", text: input.safetyEvent };
  if (input.userInteraction) return { priority: 2, kind: "interaction", action: "pause", text: input.userInteraction };
  if (!state || !state.enabled || state.mode === "minimal" || state.contentDisabled) return { priority: 3, kind: "training", action: "none", text: phase === "during_set" ? exercise?.instructions[0] : undefined };
  if (phase === "set_feedback" || phase === "completed") return { priority: 3, kind: "training", action: "stop" };
  if (phase === "during_set" && exercise?.attentionLevel !== "low") return { priority: 3, kind: "training", action: "pause", text: exercise.instructions[0] };
  if (state.mode === "companion" && state.talkativeness === "low" && phase === "resting" && session.runtime.currentSetNumber % 2 === 0) return { priority: 1, kind: "none", action: "pause" };
  const segment = state.queue[state.currentIndex];
  if ((phase === "resting" || (phase === "during_set" && exercise?.attentionLevel === "low")) && segment) return { priority: 1, kind: "content", action: "play", text: `${state.currentIndex && state.currentOffsetSeconds === 0 ? "继续刚才的内容。" : ""}${segment.text}`, segmentId: segment.id, resumeOffsetSeconds: state.currentOffsetSeconds };
  if (state.mode === "companion" && phase === "transition") return { priority: 2, kind: "interaction", action: "play", text: `下一项是${exercise?.name ?? "训练"}。` };
  return { priority: 1, kind: "none", action: "none" };
}
export function applyExperienceDirective(session: WorkoutSession, directive = experienceDirective(session), now = new Date().toISOString()) { const state = session.experience; if (!state) return directive; state.playback = directive.action === "play" ? "playing" : directive.action === "pause" ? "paused" : directive.action === "stop" ? "stopped" : state.playback; experienceEvent(session, `experience_${directive.action}`, { kind: directive.kind, priority: directive.priority, segmentId: directive.segmentId }, now); return directive; }
export function controlExperience(session: WorkoutSession, command: "off" | "resume" | "skip" | "less" | "more" | "safety", now = new Date().toISOString()) { if (!session.experience) configureExperience(session); const x = session.experience!; if (command === "off") { x.mode = "minimal"; x.enabled = false; x.contentDisabled = true; x.playback = "stopped"; } else if (command === "resume") { x.mode = x.initialMode === "minimal" ? "content" : x.initialMode; x.enabled = true; x.contentDisabled = false; x.playback = "paused"; } else if (command === "skip") { x.currentIndex = Math.min(x.queue.length, x.currentIndex + 1); x.currentOffsetSeconds = 0; x.contentSkipCount++; x.playback = "paused"; } else if (command === "less") x.talkativeness = x.talkativeness === "high" ? "medium" : "low"; else if (command === "more") x.talkativeness = x.talkativeness === "low" ? "medium" : "high"; else { x.enabled = false; x.playback = "stopped"; } experienceEvent(session, `experience_control_${command}`, { talkativeness: x.talkativeness }, now); return experienceDirective(session, command === "safety" ? { safetyEvent: "检测到安全信号，请立即停止训练。" } : {}); }
export function advanceExperienceSegment(session: WorkoutSession, listenedSeconds = 0, now = new Date().toISOString()) { const state = session.experience, segment = state?.queue[state.currentIndex]; if (!state || !segment) return; if (listenedSeconds < segment.estimatedDurationSeconds) state.currentOffsetSeconds = listenedSeconds; else { state.currentIndex++; state.currentOffsetSeconds = 0; } state.playback = "paused"; experienceEvent(session, "content_progress", { segmentId: segment.id, listenedSeconds, nextIndex: state.currentIndex }, now); }
export class TtsSpeechQueue { private queue: string[] = []; private provider: TtsProvider; constructor(provider: TtsProvider) { this.provider = provider; } enqueue(text: string) { this.queue.push(text); try { const result = this.provider.play(text); if (result && typeof (result as Promise<void>).catch === "function") (result as Promise<void>).catch(() => undefined); } catch {} } pause() { try { this.provider.pause(); } catch {} } resume() { try { this.provider.resume(); } catch {} } stop() { this.queue = []; try { this.provider.stop(); } catch {} } get pending() { return [...this.queue]; } }

export function enableCoach(session: WorkoutSession, now = new Date().toISOString()) {
  session.runtime.coach ??= { ...createCoachState(now), ...(session.status === "set_feedback" ? { phase: "FEEDBACK" as const } : session.status === "resting" ? { phase: "REST" as const } : {}) };
}
export function resetCoachForSet(session: WorkoutSession, now = new Date().toISOString()) {
  // D14 Agency 到期:学员未选择就进入下一组(按钮"开始下一组"/跳过/替换)→ 静默按标准降档执行
  if (session.runtime.coach?.pendingAgency) applyAgencyChoice(session, agencyDefaultChoice(session.runtime.coach.pendingAgency), now, true);
  if (session.runtime.coach && !session.runtime.coach.safetyStopped) {
    delete session.runtime.coach.stopProbes; // 新的一组重新计"喊停追问"次数
    if (session.runtime.coach.phase === "REST") {
      session.runtime.coach = transitionCoach(session.runtime.coach, { type: "rest_finished" }, now).state;
      addEvent(session, "coach_next_set", now);
      session.runtime.coach = transitionCoach(session.runtime.coach, { type: "next_set" }, now).state;
    } else session.runtime.coach = createCoachState(now);
  }
}
export function coachAdjustedDose(exercise: WorkoutExercise, feedback: CoachFeedback, actualWeight = exercise.currentWeight) {
  const before = { weightKg: exercise.currentWeight, targetReps: exercise.targetReps };
  const ratio = AdjustmentPolicyV0[feedback], item = equipment.find(x => x.id === exercise.equipmentId);
  const options = item?.availableWeightsKg ?? (item?.minWeightKg !== undefined && item.maxWeightKg !== undefined && item.incrementKg ? Array.from({ length: Math.floor((item.maxWeightKg - item.minWeightKg) / item.incrementKg) + 1 }, (_, i) => item.minWeightKg! + i * item.incrementKg!) : []);
  const legal = actualWeight ? options.filter(value => ratio < 0 ? value >= actualWeight * 0.9 - 0.00001 && value <= actualWeight * 0.95 : value > actualWeight && value <= actualWeight * 1.05 + 0.00001) : [];
  const candidate = legal.sort((a, b) => Math.abs(a - actualWeight! * (1 + ratio)) - Math.abs(b - actualWeight! * (1 + ratio)))[0];
  const change = actualWeight && candidate !== undefined ? (candidate - actualWeight) / actualWeight : 0;
  const validWeight = ratio < 0 ? change <= -0.05 && change >= -0.100001 : change > 0 && change <= 0.050001;
  const count = Number(exercise.targetReps.match(/\d+/)?.[0] ?? 1);
  const targetReps = validWeight ? exercise.targetReps : exercise.targetReps.replace(/\d+/, String(Math.max(1, count + (ratio < 0 ? -1 : 1))));
  return { before, after: { weightKg: validWeight ? candidate : actualWeight, targetReps }, reason: feedback, policy: AdjustmentPolicyV0.id, requestedWeightRatio: ratio, fallback: validWeight ? undefined : "no_supported_weight_within_policy" };
}
export type AgencyChoice = "accept_cut" | "hold_on" | "bargain" | "next_down" | "stay" | "skip_next";
/** 到期默认:组内=标准降档;跨动作=下一动作降一档(保守保护学员) */
function agencyDefaultChoice(pending: { scope?: "set" | "exercise" } | undefined): AgencyChoice { return pending?.scope === "exercise" ? "next_down" : "accept_cut"; }
/** D16-B 跨动作三选一:①next_down=下一动作降一档(基准=其自身重量,不用上一动作报告实重) ②stay=原计划 ③skip_next=砍掉下一动作,休息照旧。 */
function applyCrossAgencyChoice(session: WorkoutSession, choice: AgencyChoice, now: string, silent: boolean, pending: NonNullable<CoachState["pendingAgency"]>): string {
  const coach = session.runtime.coach!;
  const idx = session.runtime.currentExerciseIndex, target = session.exercises[idx];
  let reply = "";
  if (target && idx < session.exercises.length) {
    if (choice === "next_down") {
      const dose = coachAdjustedDose(target, "too_heavy");
      const before = { weightKg: target.currentWeight, targetReps: target.targetReps };
      target.currentWeight = dose.after.weightKg; target.targetReps = dose.after.targetReps;
      addEvent(session, "coach_adjustment", now, { ...dose, before, agencyChoice: choice, scope: "exercise", actual: { reps: pending.actualReps }, appliesToSetNumber: 1 });
      reply = target.currentWeight !== undefined && target.currentWeight !== null ? `下一个降一档：${target.name}，${target.currentWeight} 公斤，稳着来。` : `下一个降一档：${target.name}，先做 ${Number(target.targetReps.match(/\d+/)?.[0] ?? 8)} 次，稳着来。`;
    } else if (choice === "stay") {
      reply = `行，${target.name} 按原计划。我盯着。`;
    } else {
      const skipped = target;
      let next = idx + 1;
      while (next < session.exercises.length && ["skipped", "replaced", "pain"].includes(session.exercises[next].executionStatus)) next++;
      skipped.executionStatus = "skipped"; skipped.skippedReason = "agency_skip";
      addEvent(session, "exercise_skipped", now, { reason: "agency_skip" });
      addEvent(session, "coach_adjustment", now, { before: { exerciseId: skipped.exerciseId }, after: { skipped: true }, reason: "agency_skip_next", policy: "AgencyChoiceV1", agencyChoice: choice, scope: "exercise" });
      if (next >= session.exercises.length) { reply = `收到，砍掉 ${skipped.name}。后面没有了，今天到这。`; finish(session, now); }
      else { session.runtime.currentExerciseIndex = next; session.runtime.currentSetNumber = 1; session.exercises[next].executionStatus = "active"; reply = `收到，砍掉 ${skipped.name}。休息完直接上 ${session.exercises[next].name}。`; }
    }
  }
  addEvent(session, "coach_agency_choice", now, { choice, scope: "exercise" });
  delete coach.pendingAgency;
  return silent ? "" : reply;
}
/** Agency 三选一的剂量应用:①accept_cut=标准降档(重量-10%或次数-1) ②hold_on=重量不变,目标=实际次数 ③bargain=次数-2 重量不变。silent=到期默认,不产话术。 */
function applyAgencyChoice(session: WorkoutSession, choice: AgencyChoice, now: string, silent: boolean): string {
  const pending = session.runtime.coach?.pendingAgency;
  if (pending?.scope === "exercise") return applyCrossAgencyChoice(session, choice, now, silent, pending);
  const exercise = session.exercises[session.runtime.currentExerciseIndex];
  if (pending && exercise) {
    const hasNextSet = exercise.completedSets < exercise.sets;
    if (hasNextSet) {
      if (choice === "accept_cut") {
        const dose = coachAdjustedDose(exercise, "too_heavy", pending.actualWeight); // 剂量基准=学员报告实重(与原流程对齐)
        const before = { weightKg: exercise.currentWeight, targetReps: exercise.targetReps };
        exercise.currentWeight = dose.after.weightKg; exercise.targetReps = dose.after.targetReps;
        addEvent(session, "coach_adjustment", now, { ...dose, before, agencyChoice: choice, actual: { reps: pending.actualReps }, appliesToSetNumber: session.runtime.currentSetNumber + 1 });
        addEvent(session, "coach_agency_choice", now, { choice, setNumber: session.runtime.currentSetNumber, dose });
      } else if (choice === "hold_on") {
        const before = { weightKg: exercise.currentWeight, targetReps: exercise.targetReps };
        exercise.targetReps = String(pending.actualReps);
        addEvent(session, "coach_adjustment", now, { before, after: { weightKg: exercise.currentWeight, targetReps: exercise.targetReps }, reason: "agency_hold_on", policy: "AgencyChoiceV1", agencyChoice: choice, appliesToSetNumber: session.runtime.currentSetNumber + 1 });
        addEvent(session, "coach_agency_choice", now, { choice, setNumber: session.runtime.currentSetNumber });
      } else {
        const count = Number(exercise.targetReps.match(/\d+/)?.[0] ?? 8), newReps = Math.max(1, count - 2);
        const before = { weightKg: exercise.currentWeight, targetReps: exercise.targetReps };
        exercise.targetReps = String(newReps);
        addEvent(session, "coach_adjustment", now, { before, after: { weightKg: exercise.currentWeight, targetReps: exercise.targetReps }, reason: "agency_bargain", policy: "AgencyChoiceV1", agencyChoice: choice, appliesToSetNumber: session.runtime.currentSetNumber + 1 });
        addEvent(session, "coach_agency_choice", now, { choice, setNumber: session.runtime.currentSetNumber });
      }
    }
    if (session.runtime.coach) delete session.runtime.coach.pendingAgency;
  }
  if (silent) return "";
  const pendingReps = pending?.actualReps ?? Number(exercise?.targetReps.match(/\d+/)?.[0] ?? 8);
  if (choice === "accept_cut") return exercise?.currentWeight !== undefined && exercise?.currentWeight !== null ? `实在人。下一组 ${exercise.currentWeight} 公斤，稳着做。` : `实在人。下一组做 ${Number(exercise?.targetReps.match(/\d+/)?.[0] ?? 8)} 次，稳着做。`;
  if (choice === "hold_on") return `行。目标就定 ${pendingReps} 次，说到做到。`;
  return `成交，${Number(exercise?.targetReps.match(/\d+/)?.[0] ?? 8)} 次。你欠我一次标准姿势。`;
}

/** D14 Agency 口令 → 三选一(server 路由与遥测分类共用,单一事实源)。D16-B:scope=exercise 时映射跨动作选项。 */
export function agencyChoiceFromSpeech(text: string, scope: "set" | "exercise" = "set"): AgencyChoice | undefined {
  const t = text.trim();
  if (scope === "exercise") {
    if (/少练|跳过|砍|不做下|少一个|去掉/.test(t)) return "skip_next";
    if (/原计划|按计划|照旧|就这样|保持|我能行|没问题|可以|继续/.test(t)) return "stay";
    if (/轻|换|降|减|听你的|^行$|^好$|累|不行|扛不住/.test(t)) return "next_down";
    return undefined;
  }
  if (/^(?:行|好|听你的|可以|降|减重量)/.test(t)) return "accept_cut";
  if (/^(?:不行|我能行|我能扛|没问题|我可以|继续)/.test(t)) return "hold_on";
  if (/少做|少练|减几|少两|讨价/.test(t)) return "bargain";
  return undefined;
}

export function handleCoachEvent(session: WorkoutSession, event: CoachEvent, now = new Date().toISOString(), painText = "疼痛"): { directive: CoachDirective; record?: SetRecord } {
  if (["completed", "aborted", "preview", "warming_up", "cooling_down"].includes(session.status)) return { directive: { action: "none" } };
  enableCoach(session, now);
  const previous = session.runtime.coach!;
  if (session.status === "paused" && event.type !== "pain") return { directive: { action: "speak", text: previous.safetyStopped ? "疼痛后不能继续当前动作，请结束本次训练。" : "训练已暂停，准备好后说继续。" } };
  const result = transitionCoach(previous, event, now);
  session.runtime.coach = result.state;
  if (result.directive.action === "safety_stop") {
    if (!previous.safetyStopped) {
      if (session.status !== "paused") pauseWorkout(session, now);
      const safety = safetyGate(painText, { painSignals: [{ area: areaName(painText), severity: "unspecified", rawText: painText }] });
      addEvent(session, "coach_safety_stop", now, { reason: "pain", safetyCode: safety.code, rawText: painText });
      controlExperience(session, "safety", now);
    }
    const safety = safetyGate(painText, { painSignals: [{ area: areaName(painText), severity: "unspecified", rawText: painText }] });
    return { directive: { action: "safety_stop", text: `先停止当前动作，安全放下负重。训练已暂停。${safety.message}可以结束本次训练。` } };
  }
  // ── D14 Agency 层:吃力后的三选一(降档/硬扛/讨价)。未选而开始下一组 → 默认降档 ──
  if (event.type === "start_set" && session.runtime.coach?.pendingAgency) applyAgencyChoice(session, agencyDefaultChoice(session.runtime.coach.pendingAgency), now, true);
  if (event.type === "agency_choice") {
    if (!session.runtime.coach?.pendingAgency) return { directive: { action: "speak", text: "这一组已经定过了，按计划走。" } };
    const text = applyAgencyChoice(session, event.choice, now, false);
    return { directive: { action: "speak", text } };
  }
  if (event.type === "substitute") {
    if (session.status !== "exercise_active") return { directive: { action: "speak", text: "替换动作要在动作进行时告诉我。请先开始当前动作。" } };
    replaceExercise(session, "equipment_busy", now);
    resetCoachForSet(session, now);
    const replaced = session.runtime.events.some(x => x.type === "exercise_replaced" && x.at === now);
    const text = replaced
      ? `器械占用，已换为${session.exercises[session.runtime.currentExerciseIndex].name}。先用这一组确认合适负荷。`
      : "没有合适的替代动作，已跳过当前动作，继续下一个。";
    return { directive: { action: "speak", text } };
  }
  if (event.type === "time_constraint") {
    const shortened = shortenRemainingWorkout(session, event.remainingMinutes, now);
    return { directive: { action: "speak", text: shortened.message } };
  }
  if (event.type !== "user_report" || !["START_SET", "REP_GUIDANCE", "SET_COMPLETE", "FEEDBACK"].includes(previous.phase)) return result;
  if (event.actualReps !== undefined && (!Number.isInteger(event.actualReps) || event.actualReps < 0 || event.actualReps > 500)) throw new Error("请报告有效的实际次数。");
  if (event.actualWeight !== undefined && (!Number.isFinite(event.actualWeight) || event.actualWeight < 0 || event.actualWeight > 1000)) throw new Error("请报告有效的实际重量。");
  const exercise = session.exercises[session.runtime.currentExerciseIndex], setNumber = session.runtime.currentSetNumber;
  // 徒手/无外部负荷:难度问话用"费力感"措辞(轻松/合适/吃力),不用重量措辞(太轻/太重)
  const noLoad = exercise.currentWeight === undefined;
  const effortAsk = noLoad ? "轻松、合适还是吃力？" : "太轻、太重还是正好？";
  addEvent(session, "coach_user_report", now, { setNumber, ...event });
  if (event.completed === false) { if (session.status === "set_feedback") { session.status = "exercise_active"; delete session.runtime.currentSetEndedAt; } if (noLoad && result.directive.text?.includes("太轻、太重还是正好")) result.directive.text = result.directive.text.replace("太轻、太重还是正好", effortAsk); return result; }
  if (event.completed === true && session.status === "exercise_active") markSetComplete(session, now);
  if (session.status !== "set_feedback") return result;
  const reports = session.runtime.events.filter(x => x.type === "coach_user_report" && x.exerciseId === exercise.exerciseId && x.details?.setNumber === setNumber);
  const weight = reports.map(x => x.details?.actualWeight).filter(x => typeof x === "number").at(-1) as number | undefined;
  // D16-C:次数是唯一允许的补问(答得出、且不可捏造——实际数据只能来自学员);保持一个短问
  const reps = reports.map(x => x.details?.actualReps).filter(x => typeof x === "number").at(-1) as number | undefined;
  if (reps === undefined) return { directive: { action: "collect_feedback", text: "做了几次？" } };
  const feedback = result.state.pendingFeedback;
  if (noLoad && result.directive.text?.includes("太轻、太重还是正好")) result.directive.text = result.directive.text.replace("太轻、太重还是正好", effortAsk);
  // A count-only reply completes an already-confirmed report; otherwise ask for effort.
  if (!feedback && !event.right) return { directive: { action: "collect_feedback", text: `记下了。${effortAsk}` } };
  const dose = feedback ? coachAdjustedDose(exercise, feedback, weight) : undefined;
  const saved = submitSetFeedback(session, { actualReps: reps, actualWeight: weight, feedback: feedback === "too_heavy" ? "hard" : feedback === "too_light" ? "too_light" : "right", coachConfirmed: true, actualRepsSource: (event as { actualRepsSource?: "counted" | "reported" | "assumed" }).actualRepsSource ?? "reported" }, now);
  if (weight === undefined) delete saved.record.actualWeight;
  // D14:吃力/没做完且本动作还有后续组 → 下一组走法交给学员三选一(不再自动降档)
  if (feedback === "too_heavy" && exercise.completedSets < exercise.sets) {
    session.runtime.coach = { ...transitionCoach(result.state, { type: "feedback_saved" }, now).state, pendingAgency: { actualReps: reps, actualWeight: weight, feedback } };
    return { record: saved.record, directive: { action: "agency_offer", text: `这组 ${reps} 次开始吃力了。下一组怎么走？` } };
  }
  // D16-B:吃力收工(本动作末组)且休息已指向下一动作 → 跨动作三选一(居家单组计划由此获得 agency 时刻)
  if (feedback === "too_heavy" && session.status === "resting" && session.runtime.currentExerciseIndex < session.exercises.length) {
    const target = session.exercises[session.runtime.currentExerciseIndex];
    const definition = exercises.find(x => x.id === target.exerciseId);
    const offerable = target.repOrTimeBased !== "time" && !(definition && ["mobility", "conditioning"].includes(definition.movementPattern));
    if (offerable) {
      session.runtime.coach = { ...transitionCoach(result.state, { type: "feedback_saved" }, now).state, pendingAgency: { scope: "exercise", actualReps: reps, actualWeight: weight, feedback } };
      return { record: saved.record, directive: { action: "agency_offer", text: `这组 ${reps} 次吃力收工。下一个动作「${target.name}」怎么走？` } };
    }
  }
  if (dose) {
    const hasNextSet = exercise.completedSets < exercise.sets;
    if (hasNextSet) { exercise.currentWeight = dose.after.weightKg; exercise.targetReps = dose.after.targetReps; }
    // Never relabel an adjusted plan as actual performance.
    session.runtime.events.push({ id: randomUUID(), type: "coach_adjustment", at: now, exerciseId: exercise.exerciseId, details: { ...dose, actual: { weightKg: saved.record.actualWeight, reps: saved.record.actualReps }, appliesToSetNumber: hasNextSet ? setNumber + 1 : null } });
  }
  session.runtime.coach = transitionCoach(result.state, { type: "feedback_saved" }, now).state;
  const hasNextSet = exercise.completedSets < exercise.sets;
  const text = dose ? (hasNextSet
    ? (dose.after.weightKg !== dose.before.weightKg ? `下一组 ${dose.after.weightKg} 公斤` : `下一组 ${dose.after.targetReps} 次`)
    : "已记录，下次参考。") : "保持当前强度。";
  return { directive: { action: "speak", text: text + (session.status === "resting" ? `休息 ${exercise.restSeconds} 秒。` : "本动作完成。") }, record: saved.record };
}
export function handleCoachMessage(session: WorkoutSession, message: string, now = new Date().toISOString()) {
  const event = parseCoachReport(message);
  return event ? handleCoachEvent(session, event, now, message) : { directive: { action: "none" } as CoachDirective };
}
// 空闲封顶:两次动作间隔超过 10 分钟视为"人不在"(放下手机/锁屏/过夜),不计入训练时长。
// 修复前:整夜挂机被当成持续训练(历史数据出现 18919/21976/27736 分钟的"训练")。
export const ACTIVE_IDLE_GAP_MS = 10 * 60 * 1000;
function accrue(session: WorkoutSession, now: string) {
  if (!session.runtime.activeSince) return;
  const gap = Math.max(0, Date.parse(now) - Date.parse(session.runtime.activeSince));
  if (gap <= ACTIVE_IDLE_GAP_MS) session.runtime.activeWorkoutMs += gap;
  session.runtime.activeSince = now;
}
/** 由事件时间线重算有效训练时长(相邻事件间隔按封顶截断),用于修复历史脏数据与审计。 */
export function activeMsFromEvents(events: Array<{ at: string }>, capMs = ACTIVE_IDLE_GAP_MS): number {
  const times = events.map(e => Date.parse(e.at)).filter(t => Number.isFinite(t)).sort((a, b) => a - b);
  let total = 0;
  for (let i = 1; i < times.length; i++) total += Math.min(capMs, times[i]! - times[i - 1]!);
  return total;
}
function finish(session: WorkoutSession, now: string, afterCooldown = false) { accrue(session, now); if (session.durationIntent === "target" && session.cooldownMinutes > 0 && !afterCooldown) { session.status = "cooling_down"; session.runtime.phaseEndsAt = new Date(Date.parse(now) + session.cooldownMinutes * 60000).toISOString(); addEvent(session, "cooldown_started", now); return; } session.status = "completed"; delete session.runtime.phaseEndsAt; session.runtime.completedAt = now; delete session.runtime.activeSince; delete session.runtime.restEndsAt; delete session.runtime.previousState; delete session.runtime.pausedAt; if (session.experience) session.experience.playback = "stopped"; addEvent(session, "workout_completed", now); }
function advanceExercise(session: WorkoutSession, now: string) { session.runtime.currentExerciseIndex++; session.runtime.currentSetNumber = 1; if (session.runtime.currentExerciseIndex >= session.exercises.length) return finish(session, now); session.exercises[session.runtime.currentExerciseIndex].executionStatus = "active"; session.status = "exercise_active"; }
export function startWorkout(session: WorkoutSession, now = new Date().toISOString()) { if (session.status !== "preview" && session.status !== "active") throw new Error("只有预览状态可以开始训练。"); session.status = session.durationIntent === "target" && session.warmupMinutes > 0 ? "warming_up" : "exercise_active"; session.runtime.startedAt ??= now; session.runtime.activeSince = now; if (session.status === "warming_up") session.runtime.phaseEndsAt = new Date(Date.parse(now) + session.warmupMinutes * 60000).toISOString(); else { session.runtime.currentSetStartedAt = now; session.exercises[0].executionStatus = "active"; } addEvent(session, "workout_started", now); applyExperienceDirective(session, experienceDirective(session), now); return session; }
export function completeWarmup(session: WorkoutSession, now = new Date().toISOString()) { if (session.status !== "warming_up") throw new Error("当前不在热身阶段。"); session.status = "exercise_active"; delete session.runtime.phaseEndsAt; session.runtime.currentSetStartedAt = now; session.exercises[0].executionStatus = "active"; addEvent(session, "warmup_completed", now); return session; }
export function completeCooldown(session: WorkoutSession, now = new Date().toISOString()) { if (session.status !== "cooling_down") throw new Error("当前不在放松阶段。"); finish(session, now, true); return session; }
export function markSetComplete(session: WorkoutSession, now = new Date().toISOString()) { if (session.status !== "exercise_active") throw new Error("当前状态不能完成本组。"); accrue(session, now); session.runtime.currentSetEndedAt = now; session.status = "set_feedback"; addEvent(session, "set_completed", now, { setNumber: session.runtime.currentSetNumber }); applyExperienceDirective(session, experienceDirective(session), now); return session; }
export function nextAvailableWeight(equipmentId: string | undefined, current: number | undefined, direction: 1 | -1) { if (!equipmentId || current === undefined) return current; const item = equipment.find(x => x.id === equipmentId); if (!item) return current; const options = item.availableWeightsKg ?? (item.minWeightKg !== undefined && item.maxWeightKg !== undefined && item.incrementKg ? Array.from({ length: Math.floor((item.maxWeightKg - item.minWeightKg) / item.incrementKg) + 1 }, (_, i) => item.minWeightKg! + i * item.incrementKg!) : []); return direction > 0 ? options.find(x => x > current) ?? current : [...options].reverse().find(x => x < current) ?? current; }
export function adjustedWeight(equipmentId: string | undefined, current: number | undefined, feedback: SetFeedback, rir?: number, completedTarget = true) { if (feedback === "pain") return current; if (feedback === "too_light" || (rir !== undefined && rir >= 4)) return nextAvailableWeight(equipmentId, current, 1); if (feedback === "failed" || !completedTarget || (rir !== undefined && rir <= 1)) return nextAvailableWeight(equipmentId, current, -1); return current; }
/**
 * 事后补充反馈(D17):complete_set 已经自动结组并进入休息,用户此时才说"太重了/有点轻"。
 * 不该报错打断他,也不该当作没听见——更正刚那一组的记录,并在同一动作还有后续组时据此调剂量。
 * 只改这一组与下一组剂量,不动状态机(仍在休息)。
 */
export function applyLateFeedback(session: WorkoutSession, record: SetRecord, input: { feedback?: SetFeedback; actualReps?: number; actualWeight?: number; actualRepsSource?: "counted" | "reported" | "assumed" }, now = new Date().toISOString()) {
  // B4(2026-11-09):用户事后真的报了一个数字,来源就该升到 reported。
  // 旧实现沿用 record.actualRepsSource(自动结组时是 assumed),导致
  // 实测被永久当成推定、进步统计永远排除它 —— 三态只降不升。
  // 但 counted 不许被降级(系统数过的就是数过的)。
  const upgradedRepsSource: SetRecord["actualRepsSource"] = record.actualRepsSource === "counted" ? "counted" : (input.actualRepsSource ?? "reported");
  const updated: SetRecord = {
    ...record,
    ...(input.feedback ? { feedback: input.feedback } : {}),
    ...(input.actualReps !== undefined ? { actualReps: input.actualReps, actualRepsSource: upgradedRepsSource } : {}),
    ...(input.actualWeight !== undefined ? { actualWeight: input.actualWeight } : {}),
  };
  updated.pain = updated.feedback === "pain";
  const exercise = session.exercises[session.runtime.currentExerciseIndex];
  let doseChanged = false;
  // 只有"同一动作还有后续组"时,这一组的反馈才影响下一组;换动作后不再回头改别人的重量
  if (exercise && exercise.exerciseId === updated.exerciseId && !updated.pain && exercise.completedSets < exercise.sets) {
    // 与常规反馈同源:吃力 → 按 AdjustmentPolicyV0 降一档(不是简单 ±1 个配重片)
    const coachFeedback: CoachFeedback | null = updated.feedback === "hard" || updated.feedback === "failed" ? "too_heavy" : updated.feedback === "too_light" ? "too_light" : null;
    const dose = coachFeedback ? coachAdjustedDose(exercise, coachFeedback, updated.actualWeight ?? exercise.currentWeight) : undefined;
    if (dose && (dose.after.weightKg !== exercise.currentWeight || dose.after.targetReps !== exercise.targetReps)) {
      exercise.currentWeight = dose.after.weightKg;
      exercise.targetReps = dose.after.targetReps;
      doseChanged = true;
    }
  }
  // D14/D16-B:吃力的补充反馈同样要给 agency 时刻(本动作还有组 → 本组三选一;末组 → 跨动作三选一)
  let agency: "set" | "exercise" | null = null;
  if (updated.feedback === "hard" && session.runtime.coach && !updated.pain) {
    const current = session.exercises[session.runtime.currentExerciseIndex];
    if (current && current.exerciseId === updated.exerciseId && current.completedSets < current.sets) agency = "set";
    else if (session.status === "resting" && session.runtime.currentExerciseIndex < session.exercises.length) agency = "exercise";
    if (agency) {
      session.runtime.coach = {
        ...session.runtime.coach,
        pendingAgency: { ...(agency === "exercise" ? { scope: "exercise" as const } : {}), actualReps: updated.actualReps, actualWeight: updated.actualWeight, feedback: "too_heavy" },
      };
    }
  }
  addEvent(session, "feedback_corrected", now, { setRecordId: updated.id, feedback: updated.feedback, doseChanged, agency });
  return { record: updated, doseChanged, agency };
}

export function submitSetFeedback(session: WorkoutSession, input: { actualReps?: number; actualWeight?: number; rir?: number; rpe?: number; feedback: SetFeedback; coachConfirmed?: boolean; actualRepsSource?: "counted" | "reported" | "assumed" }, now = new Date().toISOString()) {
  if (session.status !== "set_feedback") throw new Error("当前状态不能提交组反馈。"); const exercise = session.exercises[session.runtime.currentExerciseIndex], targetMin = Number(exercise.targetReps.match(/\d+/)?.[0] ?? 0), weight = input.actualWeight ?? exercise.currentWeight;
  const actualReps = input.actualReps ?? (exercise.repOrTimeBased === "time" ? 0 : targetMin);
  // 诚实记账:没有真实次数输入时,次数是"按目标推定"而非测量值 —— 标注来源,进步统计据此排除
  const actualRepsSource = input.actualReps !== undefined ? (input.actualRepsSource ?? "reported") : "assumed";
  const record: SetRecord = { id: randomUUID(), sessionId: session.sessionId, workoutExerciseId: exercise.id, exerciseId: exercise.exerciseId, setNumber: session.runtime.currentSetNumber, targetWeight: exercise.currentWeight, actualWeight: weight, targetReps: exercise.targetReps, actualReps, actualRepsSource, actualDurationSeconds: exercise.repOrTimeBased === "time" ? Math.min(targetMin, Math.max(0, Math.round((Date.parse(session.runtime.currentSetEndedAt ?? now) - Date.parse(session.runtime.currentSetStartedAt ?? now)) / 1000))) : undefined, rir: input.rir, rpe: input.rpe, feedback: input.feedback, pain: input.feedback === "pain", completedAt: now };
  exercise.completedSets++; addEvent(session, "feedback_recorded", now, { feedback: input.feedback, rir: input.rir, actualReps, actualWeight: weight });
  if (record.pain) { exercise.executionStatus = "pain"; addEvent(session, "pain_stop", now); advanceExercise(session, now); return { session, record }; }
  if (!input.coachConfirmed) exercise.currentWeight = adjustedWeight(exercise.equipmentId, weight, input.feedback, input.rir, actualReps >= targetMin);
  if (exercise.completedSets >= exercise.sets) { exercise.executionStatus = "completed"; session.runtime.currentExerciseIndex++; session.runtime.currentSetNumber = 1; } else session.runtime.currentSetNumber++;
  if (session.runtime.currentExerciseIndex >= session.exercises.length) finish(session, now); else { session.exercises[session.runtime.currentExerciseIndex].executionStatus = "active"; session.status = "resting"; session.runtime.restEndsAt = new Date(Date.parse(now) + exercise.restSeconds * 1000).toISOString(); addEvent(session, "rest_started", now, { restSeconds: exercise.restSeconds }); }
  applyExperienceDirective(session, experienceDirective(session), now);
  return { session, record };
}
export function completeRest(session: WorkoutSession, now = new Date().toISOString()) { if (session.status !== "resting") throw new Error("当前不在休息状态。"); session.status = "exercise_active"; session.runtime.currentSetStartedAt = now; delete session.runtime.currentSetEndedAt; delete session.runtime.restEndsAt; addEvent(session, "rest_completed", now); applyExperienceDirective(session, experienceDirective(session), now); return session; }
export function extendRest(session: WorkoutSession, seconds = 30) { if (session.status !== "resting" || !session.runtime.restEndsAt) throw new Error("当前不在休息状态。"); session.runtime.restEndsAt = new Date(Date.parse(session.runtime.restEndsAt) + seconds * 1000).toISOString(); return session; }
export function pauseWorkout(session: WorkoutSession, now = new Date().toISOString()) { if (!["warming_up", "exercise_active", "set_feedback", "resting", "cooling_down"].includes(session.status)) throw new Error("当前状态不能暂停。"); accrue(session, now); session.runtime.previousState = session.status; session.runtime.pausedAt = now; session.status = "paused"; delete session.runtime.activeSince; addEvent(session, "paused", now); return session; }
export function resumeWorkout(session: WorkoutSession, now = new Date().toISOString()) { if (session.status !== "paused") throw new Error("训练未暂停。"); if (session.runtime.coach?.safetyStopped) throw new Error("疼痛后不能直接恢复当前动作，请结束本次训练。"); if (session.runtime.currentSetStartedAt && session.runtime.pausedAt) session.runtime.currentSetStartedAt = new Date(Date.parse(session.runtime.currentSetStartedAt) + Math.max(0, Date.parse(now) - Date.parse(session.runtime.pausedAt))).toISOString(); if (session.runtime.phaseEndsAt && session.runtime.pausedAt) session.runtime.phaseEndsAt = new Date(Date.parse(session.runtime.phaseEndsAt) + Math.max(0, Date.parse(now) - Date.parse(session.runtime.pausedAt))).toISOString(); if (session.runtime.restEndsAt && session.runtime.pausedAt) session.runtime.restEndsAt = new Date(Date.parse(session.runtime.restEndsAt) + Math.max(0, Date.parse(now) - Date.parse(session.runtime.pausedAt))).toISOString(); session.status = session.runtime.previousState ?? "exercise_active"; session.runtime.activeSince = now; delete session.runtime.pausedAt; addEvent(session, "resumed", now); return session; }
export function skipExercise(session: WorkoutSession, reason = "other", now = new Date().toISOString()) { if (!["exercise_active", "set_feedback", "resting"].includes(session.status)) throw new Error("当前状态不能跳过动作。"); const current = session.exercises[session.runtime.currentExerciseIndex]; current.executionStatus = "skipped"; current.skippedReason = reason; addEvent(session, "exercise_skipped", now, { reason }); advanceExercise(session, now); return session; }
export function replaceExercise(session: WorkoutSession, reason = "equipment_busy", now = new Date().toISOString()) {
  if (session.status !== "exercise_active") throw new Error("只能在动作进行时替换。");
  const index = session.runtime.currentExerciseIndex, current = session.exercises[index], currentDefinition = exercises.find(x => x.id === current.exerciseId)!;
  const alreadyScheduled = new Set(session.exercises.filter((_, i) => i !== index).map(x => x.exerciseId));
  const ranked = current.alternatives.map(id => exercises.find(x => x.id === id)).filter((x): x is Exercise => Boolean(x))
    .filter(x => !alreadyScheduled.has(x.id) && x.environments.includes(session.environment) && !x.contraindicationTags.some(tag => session.restrictions.includes(tag)))
    .map(x => ({ exercise: x, equipmentId: x.equipmentIds.find(id => session.environment !== "gym" || gymEquipment.some(g => g.gymId === session.gymId && g.equipmentId === id && g.available)), score: (x.movementPattern === currentDefinition.movementPattern ? 100 : 0) + relationScore(current.exerciseId, x.id, reason) + x.substitutionTags.filter(tag => currentDefinition.substitutionTags.includes(tag)).length * 10 - Math.abs(["beginner", "intermediate", "advanced"].indexOf(x.difficulty) - ["beginner", "intermediate", "advanced"].indexOf(currentDefinition.difficulty)) }))
    .filter(x => Boolean(x.equipmentId)).sort((a, b) => b.score - a.score);
  const choice = ranked[0];
  if (!choice || choice.exercise.movementPattern !== currentDefinition.movementPattern) { addEvent(session, "replacement_unavailable", now, { originalExerciseId: current.exerciseId, reason }); return skipExercise(session, "no_legal_replacement", now); }
  const originalId = current.exerciseId, replacement = choice.exercise;
  // B5(2026-11-09):替换前已完成的组数必须扣掉,否则"3 组做完 1 组再换"会变成再做 3 组(超处方)
  const remainingSets = Math.max(1, Math.min(current.sets, replacement.maxSets) - current.completedSets);
  const recommendation: ExerciseRecommendation = { exerciseId: replacement.id, weightKg: replacement.defaultWeightKg, repRange: replacement.defaultReps, sets: remainingSets, targetRir: 2, confidence: "low", action: "calibrate", reasonCodes: ["replacement_selected", "calibration_set_required"], userExplanation: "这是本次替代动作，先用第一组确认合适负荷。", calibrationSet: true };
  Object.assign(current, { exerciseId: replacement.id, name: replacement.name, attentionLevel: replacement.attentionLevel, equipmentId: choice.equipmentId, sets: recommendation.sets, targetReps: replacement.defaultReps, repOrTimeBased: replacement.repOrTimeBased ?? "reps", recommendedWeight: replacement.defaultWeightKg, currentWeight: replacement.defaultWeightKg, recommendation, rationale: recommendation.userExplanation, instructions: replacement.instructions, voiceCues: replacement.voiceCues, source: replacement.source, sourceId: replacement.sourceId, sourceLicense: replacement.sourceLicense, alternatives: exercises.filter(x => x.id !== replacement.id).map(x => x.id), originalExerciseId: originalId, replacementReason: reason, executionStatus: "active", completedSets: 0 });
  // 新动作从自己的第 1 组开始编号(替换前的组属于原动作)
  session.runtime.currentSetNumber = 1;
  addEvent(session, "exercise_replaced", now, { originalExerciseId: originalId, replacementExerciseId: replacement.id, reason, movementPattern: replacement.movementPattern }); return session;
}

/** C2(7B.2 裁决)最小实现:把剩余训练压缩到 remainingMinutes 内。
 * 规则:当前组保底 1 组;从末尾丢弃未开始的动作;仍超预算则只削减当前动作的剩余组数;
 * 放松环节全额保留(安全下限);不做粗暴算法,时长估算复用 durationBreakdown。 */
export interface WorkoutShortenResult { droppedExerciseIds: string[]; trimmedToSets: number | null; beforeMinutes: number; afterMinutes: number; message: string }
export function shortenRemainingWorkout(session: WorkoutSession, remainingMinutes: number, now = new Date().toISOString()): WorkoutShortenResult {
  if (!["warming_up", "exercise_active", "set_feedback", "resting", "paused"].includes(session.status)) throw new Error("当前状态不能调整时长。请先开始或继续训练。");
  const minutes = Math.round(Number(remainingMinutes));
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 180) throw new Error("请说明 1 到 180 分钟内的剩余时间。");
  const index = session.runtime.currentExerciseIndex, beforeMinutes = session.plannedDurationMinutes, budgetSeconds = minutes * 60;
  const keep = session.exercises.slice(index);
  const estimate = () => durationBreakdown(
    keep.map((x, i) => ({ sets: i === 0 ? Math.max(1, x.sets - x.completedSets) : x.sets, restSeconds: x.restSeconds, targetReps: x.targetReps, repOrTimeBased: x.repOrTimeBased })),
    0, session.cooldownMinutes,
  ).totalSeconds;
  const droppedExerciseIds: string[] = [], droppedNames: string[] = [];
  while (keep.length > 1 && estimate() > budgetSeconds) { const dropped = keep.pop()!; droppedExerciseIds.unshift(dropped.exerciseId); droppedNames.unshift(dropped.name); }
  let trimmedToSets: number | null = null;
  const current = keep[0];
  if (current && estimate() > budgetSeconds) {
    let sets = Math.max(1, current.sets - current.completedSets);
    while (sets > 1 && estimate() > budgetSeconds) { sets--; current.sets = current.completedSets + sets; trimmedToSets = sets; }
  }
  session.exercises = [...session.exercises.slice(0, index), ...keep];
  session.durationBreakdown = durationBreakdown(session.exercises, session.warmupMinutes, session.cooldownMinutes);
  session.plannedDurationMinutes = Math.ceil(session.durationBreakdown.totalSeconds / 60);
  session.optionalDurationMinutes = Math.max(0, session.availableDurationMinutes - session.plannedDurationMinutes);
  const afterMinutes = session.plannedDurationMinutes, projected = estimate(), over = projected > budgetSeconds;
  addEvent(session, "workout_shortened", now, { remainingMinutes: minutes, droppedExerciseIds, trimmedToSets, beforeMinutes, afterMinutes, projectedRemainingSeconds: projected, budgetSeconds });
  const parts = [`剩余训练压到 ${minutes} 分钟以内`];
  if (droppedNames.length) parts.push(`跳过 ${droppedNames.join("、")}`);
  if (trimmedToSets !== null) parts.push(`当前动作保留 ${trimmedToSets} 组`);
  if (over) parts.push(`受当前组和放松环节影响，可能仍会超出约 ${Math.ceil((projected - budgetSeconds) / 60)} 分钟`);
  return { droppedExerciseIds, trimmedToSets, beforeMinutes, afterMinutes, message: parts.join("，") + "。" };
}
export function abortWorkout(session: WorkoutSession, now = new Date().toISOString()) {
  // H4(2026-11-06 全仓审查):这是全文件唯一没有前置判断的转移。终态不可再转移——
  // abort 一个 completed 会话会把 training_records 已定稿的记录口径翻成 aborted。
  if (session.status === "completed" || session.status === "aborted") throw new Error("训练已经结束了。");
  accrue(session, now); session.status = "aborted"; session.runtime.completedAt = now; delete session.runtime.activeSince; addEvent(session, "workout_aborted", now); return session;
}
export async function createWorkout(input: string, userId: string, provider: LanguageModelProvider, facts: TrainingFacts = { sessions: [], sets: [] }, hints: InterpreterHints = {}) {
  const interpretation = await new ContextInterpreter(provider).interpret(input, userId, hints);
  if (!interpretation.context) return { safety: { allowed: true }, interpretation, context: null, workout: null, trainingModel: null };
  const context = interpretation.context, safety = safetyGate(input, context);
  if (!safety.allowed) return { safety, interpretation, context, workout: null, trainingModel: null };
  if (interpretation.status !== "ready") return { safety, interpretation, context, workout: null, trainingModel: null };
  const trainingModel = buildUserTrainingModel(userId, facts, context.recoveryState);
  return { safety, interpretation, context, workout: generateWorkout(context, facts), trainingModel };
}
