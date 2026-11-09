import type { GoalProfile, TrainingKnowledgeRegistry } from "./types.ts";

const goals = ["general_fitness", "strength", "hypertrophy", "muscular_endurance", "mobility", "recovery"] as const;
export function validateKnowledgeRegistry(value: unknown): asserts value is TrainingKnowledgeRegistry {
  if (!value || typeof value !== "object") throw new Error("Training knowledge registry must be an object.");
  const registry = value as TrainingKnowledgeRegistry;
  const sourceIds = new Set(registry.sources?.map(x => x.id) ?? []), ruleIds = new Set(registry.rules?.map(x => x.id) ?? []);
  if (!registry.version || !registry.sources?.length || !registry.rules?.length) throw new Error("Training knowledge registry is missing version, sources, or rules.");
  for (const source of registry.sources) if (!source.id || !source.organization || !source.document || !source.urlOrIdentifier || !["verified", "unverified"].includes(source.status)) throw new Error(`Invalid evidence source: ${source.id ?? "unknown"}`);
  for (const rule of registry.rules) {
    if (!rule.id || !rule.domain || !rule.statement || !rule.notes || !sourceIds.has(rule.sourceId)) throw new Error(`Invalid evidence rule: ${rule.id ?? "unknown"}`);
    const source = registry.sources.find(x => x.id === rule.sourceId)!;
    if (rule.evidenceKind === "external_evidence" && source.status !== "verified") throw new Error(`External evidence rule ${rule.id} must use a verified source.`);
    if (rule.evidenceKind === "unverified" && rule.confidence !== "unverified") throw new Error(`Unverified rule ${rule.id} must be marked unverified.`);
  }
  for (const goal of goals) {
    const profile = registry.goals?.[goal];
    if (!profile) throw new Error(`Missing goal profile: ${goal}`);
    validateProfile(profile, ruleIds, goal);
  }
  for (const level of ["beginner", "intermediate", "advanced", "unknown"] as const) if (!Number.isInteger(registry.experienceSetPreference?.[level]) || registry.experienceSetPreference[level] < 1) throw new Error(`Missing set preference for ${level}`);
  if (registry.progression.minimumStrengthEvidenceSets < 1 || registry.progression.minimumRepProgressionSets < 1 || !ruleIds.has(registry.progression.ruleId)) throw new Error("Invalid progression evidence thresholds.");
}
function validateProfile(profile: GoalProfile, ruleIds: Set<string>, goal: string) {
  for (const patternList of [profile.primaryPatterns, profile.secondaryPatterns, profile.accessoryPatterns]) if (!Array.isArray(patternList) || patternList.some(x => typeof x !== "string")) throw new Error(`Invalid patterns in ${goal}`);
  for (const variable of [profile.sets, profile.reps, profile.restSeconds, profile.targetRir]) if (!Number.isFinite(variable.minimum) || !Number.isFinite(variable.maximum) || variable.minimum > variable.maximum || !ruleIds.has(variable.ruleId)) throw new Error(`Invalid prescription variable in ${goal}`);
  if (profile.sets.preferred < profile.sets.minimum || profile.sets.preferred > profile.sets.maximum || !ruleIds.has(profile.durationPolicyRuleId)) throw new Error(`Invalid set or duration policy in ${goal}`);
  if (profile.weeklySetsTarget && !ruleIds.has(profile.weeklySetsTarget.ruleId)) throw new Error(`Invalid weekly volume provenance in ${goal}`);
}
