import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertKnowledgeExercise, type KnowledgeExercise, type VoiceCues } from "./schema.ts";

const root = fileURLToPath(new URL("./", import.meta.url));
const manifestPath = join(root, "sources", "manifest.json");
const curatedPath = join(root, "sources", "repdb-curated.json");
const voicePath = join(root, "voice-cue-profiles.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const source = manifest.sources.find((x: any) => x.sourceId === "repdb-exercise-dataset-free");
const curated = JSON.parse(readFileSync(curatedPath, "utf8"));
const cueProfiles = JSON.parse(readFileSync(voicePath, "utf8")).profiles;
type RepDbSourceExercise = { id: string; name_en: string; name_de?: string; name_es?: string; category?: string; difficulty: string; equipment?: string; body_part?: string; primary_muscles?: string[]; secondary_muscles?: string[]; mechanic?: string; force_type?: string; is_unilateral?: boolean; is_bodyweight?: boolean; instructions_en?: string[]; tips_en?: string[]; tags?: string[]; images?: { flat?: Record<string, string> } };
const gearAliases: Record<string, string> = { flat_bench: "bench", loop_band: "resistance_band", chest_press_machine: "machine", shoulder_press_machine: "machine", leg_press: "machine", lat_pulldown_machine: "machine", seated_calf_raise_machine: "machine", bicep_curl_machine: "machine", tricep_extension_machine: "machine", preacher_curl_machine: "machine", dumbbell: "dumbbell", barbell: "barbell", cable: "cable", resistance_band: "resistance_band", bodyweight: "bodyweight", pull_up_bar: "pull_up_bar", rings: "rings", suspension_trainer: "resistance_band", air_bike: "machine", stationary_bike: "machine", treadmill: "machine" };
function environmentsFor(equipment: string[]) {
  if (equipment.some(x => ["barbell", "cable", "machine", "bench", "pull_up_bar", "rings"].includes(x))) return ["gym"];
  if (equipment.includes("resistance_band")) return ["home", "office", "gym"];
  if (equipment.includes("dumbbell")) return ["home", "gym"];
  return ["home", "office", "gym"];
}
function normalize(row: RepDbSourceExercise, mapping: any, graph: Record<string, any[]>, sourceCommit: string): KnowledgeExercise {
  if (!row?.id || !mapping?.zhCNName || !mapping?.movementPattern) throw new Error("Source record is missing its reviewed normalization mapping.");
  if (!["beginner", "intermediate"].includes(row.difficulty)) throw new Error(`Ineligible difficulty in ${row.id}`);
  const equipment = row.equipment ? [gearAliases[row.equipment] ?? row.equipment] : row.is_bodyweight ? ["bodyweight"] : [];
  const relations = graph[row.id] ?? [];
  const profile = cueProfiles[mapping.movementPattern];
  if (!profile) throw new Error(`Missing reviewed voice cue profile for ${row.id}`);
  const voiceCues: VoiceCues = { ...profile, startCue: `接下来做${mapping.zhCNName}，按自己的稳定节奏完成。`, reviewStatus: "reviewed" };
  const result: KnowledgeExercise = {
    id: row.id, canonicalName: row.name_en, localizedNames: { en: row.name_en, ...(row.name_de ? { de: row.name_de } : {}), ...(row.name_es ? { es: row.name_es } : {}), "zh-CN": mapping.zhCNName }, aliases: mapping.aliases ?? [], category: row.category ?? "unknown", movementPattern: mapping.movementPattern,
    primaryMuscles: row.primary_muscles ?? [], secondaryMuscles: row.secondary_muscles ?? [], equipment, environment: environmentsFor(equipment), bodyRegion: row.body_part ?? null, position: null, impactLevel: null, compoundOrIsolation: row.mechanic ?? null, difficulty: row.difficulty as "beginner" | "intermediate", unilateral: row.is_unilateral ?? false, mechanic: row.mechanic ?? null, force: row.force_type ?? null,
    repOrTimeBased: null, defaultRepRange: null, defaultSetRange: null, restRangeSeconds: null, attentionLevel: null,
    instructions: row.instructions_en ?? [], coachingCues: row.tips_en ?? [], commonMistakes: [], regressions: relations.filter(x => x.kind === "easier").map(x => x.exerciseId), progressions: relations.filter(x => x.kind === "harder").map(x => x.exerciseId), substitutions: relations, media: [], voiceCues,
    source: source.sourceName, sourceId: row.id, sourceCommit, sourceLicense: source.license, attributionRequired: true,
    reviewStatus: "reviewed", reviewedAt: curated.reviewedAt
  };
  assertKnowledgeExercise(result);
  return result;
}

export function parseRepDb(data: any) {
  if (!data || data.name !== "RepDB Exercise Dataset (free tier)" || !Array.isArray(data.exercises) || data.count !== data.exercises.length) throw new Error("Expected the canonical RepDB free-tier JSON envelope.");
  return data.exercises as RepDbSourceExercise[];
}

export function normalizeRepDbExercises(rows: RepDbSourceExercise[], sourceCommit = source?.sourceCommit): KnowledgeExercise[] {
  if (!sourceCommit) throw new Error("Pinned RepDB source commit is required.");
  const byId = new Map(rows.map(row => [row.id, row]));
  const mappings = curated.exercises as any[];
  const sourceIds = new Set<string>();
  const graph: Record<string, any[]> = {};
  for (const mapping of mappings) {
    if (sourceIds.has(mapping.sourceId)) throw new Error(`Duplicate curated source ID ${mapping.sourceId}`);
    sourceIds.add(mapping.sourceId);
    const row = byId.get(mapping.sourceId);
    if (!row) throw new Error(`Curated RepDB exercise not found: ${mapping.sourceId}`);
    graph[row.id] = [];
  }
  for (const mapping of mappings) for (const other of mappings) {
    if (mapping.sourceId === other.sourceId || mapping.movementPattern !== other.movementPattern) continue;
    const left = byId.get(mapping.sourceId)!, right = byId.get(other.sourceId)!;
    const leftGear = gearAliases[left.equipment ?? ""] ?? (left.is_bodyweight ? "bodyweight" : "unknown");
    const rightGear = gearAliases[right.equipment ?? ""] ?? (right.is_bodyweight ? "bodyweight" : "unknown");
    const relation = left.difficulty === "intermediate" && right.difficulty === "beginner" ? "easier" : left.difficulty === "beginner" && right.difficulty === "intermediate" ? "harder" : leftGear !== rightGear ? "equipment_alternative" : "same_pattern";
    graph[left.id].push({ exerciseId: right.id, kind: relation, reason: `Reviewed ${mapping.movementPattern} alternative; confirm equipment, experience and pain constraints before use.` });
  }
  return mappings.map(mapping => normalize(byId.get(mapping.sourceId)!, mapping, graph, sourceCommit));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const checkout = process.argv[2];
  if (!checkout) throw new Error("Usage: node knowledge/import-repdb.ts <pinned-repdb-checkout>");
  const commit = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (commit !== source.sourceCommit) throw new Error(`RepDB commit mismatch: expected ${source.sourceCommit}, got ${commit}`);
  const license = readFileSync(join(checkout, "LICENSE-DATA.md"), "utf8");
  for (const required of ["Free for personal and commercial use inside applications", "Attribution required", "No redistribution as a dataset", "No generative-AI derivation", "premium-samples/"]) if (!license.includes(required)) throw new Error(`RepDB license term not verified: ${required}`);
  const data = JSON.parse(readFileSync(join(checkout, "exercises.json"), "utf8"));
  const rows = parseRepDb(data), converted = normalizeRepDbExercises(rows, commit);
  const output = join(root, "exercises.repdb.json");
  const existing = existsSync(output) ? JSON.parse(readFileSync(output, "utf8")) as KnowledgeExercise[] : [];
  const mergedById = new Map(existing.map(x => [x.id, x]));
  for (const exercise of converted) mergedById.set(exercise.id, exercise);
  const merged = [...mergedById.values()];
  writeFileSync(output, JSON.stringify(merged, null, 2) + "\n");
  Object.assign(source, { importedAt: new Date().toISOString(), parsedCount: rows.length, productionCandidateCount: converted.length, premiumSamplesImported: 0, mediaImportedCount: 0 });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify({ sourceCommit: commit, parsed: rows.length, productionCandidates: converted.length, mediaImported: 0, premiumSamplesImported: 0 }, null, 2));
}
