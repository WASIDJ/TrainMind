import type { ExerciseRelation } from "./schema.ts";

export const substitutionGraph: Record<string, ExerciseRelation[]> = {
  "bodyweight-squat": [
    { exerciseId: "chair-squat", kind: "easier", reason: "椅面提供稳定的深度参考。" },
    { exerciseId: "reverse-lunge", kind: "same_movement_pattern", reason: "保留下肢蹲类训练。" }
  ],
  "push-up": [
    { exerciseId: "wall-push-up", kind: "easier", reason: "墙面减少需要支撑的体重。" },
    { exerciseId: "wall-push-up", kind: "low_impact_alternative", reason: "减少地面支撑与腕部负担。" }
  ],
  "bird-dog": [
    { exerciseId: "dead-bug", kind: "same_target", reason: "继续练习躯干稳定。" }
  ],
  "barbell-bench-press": [
    { exerciseId: "incline-db-press", kind: "equipment_alternative", reason: "器械占用时使用哑铃。" }
  ]
};

export function relationScore(fromId: string, toId: string, reason: string): number {
  const relations = substitutionGraph[fromId]?.filter(x => x.exerciseId === toId) ?? [];
  const preferred = reason === "too_hard" ? ["easier", "low_impact", "low_impact_alternative"] : reason === "pain" ? ["pain_avoidance", "low_impact", "low_impact_alternative"] : reason === "equipment_busy" ? ["equipment_alternative", "home_alternative", "same_pattern", "same_movement_pattern"] : ["same_pattern", "same_movement_pattern", "same_target", "unilateral_alternative"];
  return Math.max(0, ...relations.map(x => preferred.includes(x.kind) ? 50 : 15));
}
