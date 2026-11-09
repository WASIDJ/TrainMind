export type RelationKind = "same_pattern" | "same_movement_pattern" | "same_target" | "easier" | "harder" | "equipment_alternative" | "home_alternative" | "low_impact" | "low_impact_alternative" | "unilateral_alternative" | "pain_avoidance";
export interface ExerciseRelation { exerciseId: string; kind: RelationKind; reason: string }
export interface VoiceCues { startCue?: string; setupCue?: string; cadenceType?: "controlled" | "steady" | "rhythmic" | "timed"; cadence?: number; repCue?: string; midpointCue?: string; finalRepCue?: string; finalRepsCue?: string; finishCue?: string; restCue?: string; breathingCue?: string; safetyCue?: string; reviewStatus?: "reviewed" }
export interface ExerciseMedia { type: "image" | "video" | "audio"; url: string; sourceId: string; license: string; attributionRequired: boolean }
export interface KnowledgeExercise {
  id: string; canonicalName: string; localizedNames: Record<string, string>; category: string; movementPattern: string;
  primaryMuscles: string[]; secondaryMuscles: string[]; equipment: string[]; environment: string[];
  bodyRegion?: string | null; position?: string | null; impactLevel?: "low" | "moderate" | "high" | null; compoundOrIsolation?: string | null;
  difficulty: "beginner" | "intermediate" | "advanced"; unilateral: boolean; mechanic: string | null; force: string | null;
  aliases?: string[]; repOrTimeBased: "reps" | "time" | null; defaultRepRange: [number, number] | null; defaultSetRange: [number, number] | null; restRangeSeconds: [number, number] | null; attentionLevel: "low" | "medium" | "high" | null;
  instructions: string[]; coachingCues: string[]; commonMistakes: string[];
  regressions: string[]; progressions: string[]; substitutions: ExerciseRelation[]; media: ExerciseMedia[]; voiceCues?: VoiceCues;
  source: string; sourceId: string; sourceCommit?: string; sourceLicense: string; attributionRequired: boolean;
  reviewedAt?: string; reviewStatus: "reviewed" | "pending";
}
export interface SessionRecipeBlock { type: "warmup" | "main" | "secondary" | "accessory" | "conditioning" | "mobility" | "cooldown"; movementCoverage: string[]; timeShare: number; workingSetBudget: [number, number]; required: boolean; intensityRange: ["low" | "moderate" | "high", "low" | "moderate" | "high"] }
export interface SessionRecipe { id: string; goal: string; durationMinutes: number; environments: string[]; blocks: SessionRecipeBlock[]; source: string; version: string }
export interface EvidenceRule { rule_id: string; description: string; target_population: string; source: string; evidence_type: "external_evidence" | "product_heuristic" | "position_stand" | "guideline" | "internal_design_decision"; version: string; implementation_note: string }
export function assertKnowledgeExercise(x: KnowledgeExercise): void {
  for (const key of ["id", "canonicalName", "source", "sourceId", "sourceLicense"] as const) if (!x[key]) throw new Error(`Missing ${key}`);
  if (!x.localizedNames || !x.category || !x.movementPattern || !["beginner", "intermediate", "advanced"].includes(x.difficulty) || x.repOrTimeBased !== null && !["reps", "time"].includes(x.repOrTimeBased) || x.attentionLevel !== null && !["low", "medium", "high"].includes(x.attentionLevel)) throw new Error(`Incomplete exercise ${x.id}`);
  for (const key of ["primaryMuscles", "secondaryMuscles", "equipment", "environment", "instructions", "coachingCues", "commonMistakes", "regressions", "progressions", "substitutions", "media"] as const) if (!Array.isArray(x[key])) throw new Error(`Missing ${key} in ${x.id}`);
  if (x.defaultSetRange !== null && (!Array.isArray(x.defaultSetRange) || x.defaultSetRange.length !== 2) || x.restRangeSeconds !== null && (!Array.isArray(x.restRangeSeconds) || x.restRangeSeconds.length !== 2) || typeof x.unilateral !== "boolean" || typeof x.attributionRequired !== "boolean") throw new Error(`Invalid prescription metadata in ${x.id}`);
  if (x.media.some(m => !m.sourceId || !m.license)) throw new Error(`Unlicensed media in ${x.id}`);
}
