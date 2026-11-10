import { trainingKnowledge as knowledge } from "./loader.ts";
import type { DecisionReason, ExperienceLevel, KnowledgeGoal, RequiredStimulus } from "./types.ts";

export interface StimulusInput {
  rawInput: string; interpretedGoal: string; durationMinutes: number; durationIntent: "target" | "maximum";
  recoveryState: "fresh" | "normal" | "fatigued" | "very_fatigued" | "unknown";
  experienceLevel?: ExperienceLevel;
  previousTraining: { status: "reported" | "unknown"; when?: "yesterday" | "recent"; areas: string[] };
  movementPatternLoads: Record<string, { last7Days: { workingSets: number; sessions: number; painEvents: number }; daysSinceLastMovementPattern?: number }>;
}

const lowerPatterns = new Set(["squat", "hinge", "lunge", "hip_extension", "calf"]);
function goalFor(input: StimulusInput): KnowledgeGoal {
  if (/恢复训练|恢复一下|recovery/.test(input.rawInput)) return "recovery";
  if (/增肌|肌肥大|hypertrophy/.test(input.rawInput)) return "hypertrophy";
  if (/肌耐力|耐力训练|muscular endurance/.test(input.rawInput)) return "muscular_endurance";
  if (/力量训练|练力量|提升力量|strength/i.test(input.rawInput) || ["back", "chest"].includes(input.interpretedGoal)) return "strength";
  if (input.interpretedGoal === "mobility") return "mobility";
  return "general_fitness";
}
function experienceFor(input: StimulusInput): ExperienceLevel {
  if (input.experienceLevel && input.experienceLevel !== "unknown") return input.experienceLevel;
  if (/初学者|新手|初学|beginner/i.test(input.rawInput)) return "beginner";
  if (/中级|有训练经验|intermediate/i.test(input.rawInput)) return "intermediate";
  if (/高级|资深训练|advanced/i.test(input.rawInput)) return "advanced";
  return "unknown";
}
export function resolveRequiredStimulus(input: StimulusInput): RequiredStimulus {
  const goal = goalFor(input), experienceLevel = experienceFor(input), profile = knowledge.goals[goal];
  const reasons: DecisionReason[] = [
    { type: "goal", reason: `Resolved the requested training outcome as ${goal}.` },
    { type: "knowledge", reason: profile.sets.ruleId === "acsm-strength-load-sets-2026" ? "Applied the ACSM 2026 strength set range; no unmeasured 1RM was inferred." : "Applied the goal profile and its linked evidence or product-heuristic rules.", ruleId: profile.sets.ruleId },
    { type: "experience", reason: `Experience level is ${experienceLevel}; set preference comes from the versioned knowledge profile.` }
  ];
  const trainedLegsYesterday = input.previousTraining.status === "reported" && input.previousTraining.when === "yesterday" && input.previousTraining.areas.some(x => /leg|lower|腿|下肢/i.test(x));
  let primary = [...profile.primaryPatterns], secondary = [...profile.secondaryPatterns], accessoryPatterns = [...profile.accessoryPatterns];
  if (input.interpretedGoal === "back") { primary = ["vertical_pull", "horizontal_pull", "scapular_control"]; secondary = ["core_stability", "hip_extension"]; }
  if (input.interpretedGoal === "chest") { primary = ["horizontal_push"]; secondary = ["scapular_control"]; }
  if (input.interpretedGoal === "chest" && /手臂|arm/i.test(input.rawInput)) accessoryPatterns = [...new Set([...accessoryPatterns, "arm_curl", "arm_extension"])];
  if (input.interpretedGoal === "upper_body") { primary = ["horizontal_push", "horizontal_pull", "vertical_push"]; secondary = ["vertical_pull", "scapular_control"]; }
  if (input.interpretedGoal === "lower_body") { primary = ["squat", "hinge", "lunge"]; secondary = ["hip_extension", "calf"]; }
  if (trainedLegsYesterday) {
    primary = primary.filter(x => !lowerPatterns.has(x)); secondary = secondary.filter(x => !lowerPatterns.has(x));
    reasons.push({ type: "history", reason: "Lower-body work was reported yesterday; lower-body patterns are removed from today's required stimulus." });
  }
  const loadedPatterns = new Set([...primary, ...secondary].filter(x => (input.movementPatternLoads[x]?.last7Days.workingSets ?? 0) >= 10));
  if (loadedPatterns.size) {
    primary = primary.filter(x => !loadedPatterns.has(x)); secondary = secondary.filter(x => !loadedPatterns.has(x));
    reasons.push({ type: "history", reason: `Recent seven-day volume is high for ${[...loadedPatterns].join(", ")}; those patterns are removed from the required stimulus.`, ruleId: "recovery-volume-v1" });
  }
  if (input.recoveryState === "fatigued" || input.recoveryState === "very_fatigued") reasons.push({ type: "recovery", reason: `Reported recovery is ${input.recoveryState}; reduce volume and do not progress load.`, ruleId: "recovery-volume-v1" });
  if (input.recoveryState === "unknown") reasons.push({ type: "recovery", reason: "Recovery is unknown, so no recovery improvement is assumed." });
  const desiredPrimaryCount = input.durationMinutes <= 12 ? 2 : input.durationMinutes <= 20 ? 3 : profile.primaryPatterns.length;
  primary = primary.slice(0, desiredPrimaryCount);
  if (primary.length < desiredPrimaryCount) primary.push(...secondary.splice(0, desiredPrimaryCount - primary.length));
  const useSecondary = input.durationIntent === "target" && input.durationMinutes >= 25 ? secondary : [];
  let setsPerExercise = Math.max(profile.sets.minimum, Math.min(profile.sets.maximum, knowledge.experienceSetPreference[experienceLevel]));
  if (input.recoveryState === "fatigued" || input.recoveryState === "very_fatigued") setsPerExercise = Math.max(profile.sets.minimum, setsPerExercise - 1);
  const workingSetCap = Math.min(24, Math.max(input.durationMinutes <= 10 ? 6 : input.durationMinutes <= 20 ? 10 : input.durationMinutes <= 30 ? 14 : input.durationMinutes <= 45 ? 18 : 22, Math.ceil(input.durationMinutes / 3)));
  const exerciseCountRange: [number, number] = input.durationMinutes <= 10 ? [2, 3] : input.durationMinutes <= 20 ? [3, 5] : input.durationMinutes <= 30 ? [4, 7] : input.durationMinutes <= 45 ? [5, 9] : [6, 10];
  // FROZEN（2026-11-10）：周容量目标只算不用。
  // 出处（ACSM 2026 Overview of Reviews）说的是"肌群/全身周容量 ≥10 组"，我们这里按【动作模式】扣减，
  // 单位对不上（腿部三个模式各算 10 组 = 腿一周 30 组）；而实际管排课的是肌群级的两条硬规则
  // （24 小时间隔、每周 2–3 次，见 src/muscles.ts）。两套单位同时生效会让"为什么今天不让我练腿"答不清。
  // 启用前提：先统一到肌群口径并复核出处（docs/PROGRESS.md 第二十四节）。
  // 护栏测试：test/training-knowledge.test.ts 的"周容量目标保持冻结"会在 core.ts 读它时立刻变红。
  const weeklySetsRemainingByPattern: Record<string, number> = {};
  if (profile.weeklySetsTarget) for (const pattern of [...primary, ...useSecondary]) weeklySetsRemainingByPattern[pattern] = Math.max(0, profile.weeklySetsTarget.value - (input.movementPatternLoads[pattern]?.last7Days.workingSets ?? 0));
  reasons.push({ type: "time", reason: `Session limited to ${input.durationMinutes} minutes with a ${workingSetCap}-set working cap; rest assumptions are retained.`, ruleId: profile.durationPolicyRuleId });
  return {
    goal, experienceLevel, primaryPatterns: primary, secondaryPatterns: useSecondary,
    accessoryPatterns: input.durationMinutes >= 30 ? accessoryPatterns : [], setsPerExercise,
    repRange: `${profile.reps.minimum}-${profile.reps.maximum}`, restSeconds: Math.round((profile.restSeconds.minimum + profile.restSeconds.maximum) / 2),
    targetRir: Math.round((profile.targetRir.minimum + profile.targetRir.maximum) / 2), weeklySetsRemainingByPattern, workingSetCap, exerciseCountRange,
    // 注意：不再把 weeklySetsTarget.ruleId 放进 ruleIds —— 该规则已冻结（只算不用），
    // 处方里声称应用了没应用的规则属于虚假可解释性（2026-11-10 清理）。
    ruleIds: [...new Set([profile.sets.ruleId, profile.reps.ruleId, profile.restSeconds.ruleId, profile.targetRir.ruleId, profile.durationPolicyRuleId])], decisionReasons: reasons
  };
}

export function getGoalProfile(goal: KnowledgeGoal) { return knowledge.goals[goal]; }
export function trainingEvidenceRules() { return knowledge.rules; }
