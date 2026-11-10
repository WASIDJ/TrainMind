export type KnowledgeGoal = "general_fitness" | "strength" | "hypertrophy" | "muscular_endurance" | "mobility" | "recovery";
export type ExperienceLevel = "beginner" | "intermediate" | "advanced" | "unknown";
export type EvidenceKind = "external_evidence" | "product_heuristic" | "unverified";
export interface EvidenceSource { id: string; organization: string; document: string; section: string | null; urlOrIdentifier: string; status: "verified" | "unverified"; notes: string }
export interface EvidenceRule { id: string; domain: string; statement: string; evidenceKind: EvidenceKind; sourceId: string; confidence: "high" | "moderate" | "low" | "unverified"; conditions: string[]; notes: string }
export interface GoalProfile {
  primaryPatterns: string[]; secondaryPatterns: string[]; accessoryPatterns: string[];
  sets: { minimum: number; preferred: number; maximum: number; ruleId: string };
  reps: { minimum: number; maximum: number; ruleId: string };
  restSeconds: { minimum: number; maximum: number; ruleId: string };
  targetRir: { minimum: number; maximum: number; ruleId: string };
  // FROZEN（2026-11-10）：周容量目标只算不用。出处说的是"肌群/全身周容量"，我们按【动作模式】扣减，
  // 单位对不上，也没有任何调用方读它。启用前必须先统一到肌群口径并复核出处（见 docs/PROGRESS.md 第二十四节）。
  weeklySetsTarget?: { value: number; ruleId: string };
  durationPolicyRuleId: string;
}
export interface TrainingKnowledgeRegistry { version: string; sources: EvidenceSource[]; rules: EvidenceRule[]; goals: Record<KnowledgeGoal, GoalProfile>; experienceSetPreference: Record<ExperienceLevel, number>; progression: { minimumStrengthEvidenceSets: number; minimumRepProgressionSets: number; ruleId: string }; }
export interface DecisionReason { type: "goal" | "history" | "recovery" | "knowledge" | "constraint" | "equipment" | "time" | "experience" | "progression" | "regression"; reason: string; ruleId?: string }
export interface RequiredStimulus { goal: KnowledgeGoal; experienceLevel: ExperienceLevel; primaryPatterns: string[]; secondaryPatterns: string[]; accessoryPatterns: string[]; setsPerExercise: number; repRange: string; restSeconds: number; targetRir: number; /** FROZEN：只记录、不参与排课（core.ts 不读）。见 GoalProfile.weeklySetsTarget */ weeklySetsRemainingByPattern: Record<string, number>; workingSetCap: number; exerciseCountRange: [number, number]; ruleIds: string[]; decisionReasons: DecisionReason[] }
