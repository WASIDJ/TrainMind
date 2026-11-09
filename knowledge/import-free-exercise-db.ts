import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertKnowledgeExercise, type KnowledgeExercise } from "./schema.ts";

const root = fileURLToPath(new URL("./", import.meta.url));
const manifestPath = join(root, "sources", "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const source = manifest.sources.find((x: any) => x.source_id === "yuhonas-free-exercise-db-a859101");
const reviewed = JSON.parse(readFileSync(join(root, "sources", "reviewed-map.json"), "utf8"));

export function convertUpstream(rows: any[], existing: KnowledgeExercise[] = []): KnowledgeExercise[] {
  if (!source?.version || !source?.license) throw new Error("Source version and license are required.");
  const byId = new Map(existing.map(x => [x.id, x]));
  const seenSourceIds = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || !reviewed[row.id]) continue;
    if (seenSourceIds.has(row.id)) continue;
    seenSourceIds.add(row.id);
    const mapping = reviewed[row.id];
    if (byId.has(mapping.id)) continue; // Preserve every first-party or previously reviewed field.
    if (!Array.isArray(row.instructions) || !Array.isArray(row.primaryMuscles)) throw new Error(`Invalid source record ${row.id}`);
    const item: KnowledgeExercise = {
      id: mapping.id, canonicalName: row.name, localizedNames: { en: row.name }, category: row.category,
      movementPattern: mapping.movementPattern, primaryMuscles: row.primaryMuscles, secondaryMuscles: row.secondaryMuscles ?? [],
      equipment: mapping.equipment, environment: mapping.environment, difficulty: row.level === "expert" ? "advanced" : row.level,
      unilateral: mapping.unilateral, mechanic: row.mechanic, force: row.force, repOrTimeBased: mapping.repOrTimeBased,
      defaultRepRange: mapping.defaultRepRange, defaultSetRange: mapping.defaultSetRange, restRangeSeconds: mapping.restRangeSeconds,
      attentionLevel: mapping.attentionLevel, instructions: row.instructions, coachingCues: [], commonMistakes: [],
      regressions: [], progressions: [], substitutions: [], media: [],
      source: source.source_name, sourceId: row.id, sourceCommit: source.version, sourceLicense: "Unlicense", attributionRequired: false,
      reviewStatus: "reviewed", reviewedAt: new Date().toISOString().slice(0, 10)
    };
    assertKnowledgeExercise(item);
    byId.set(item.id, item);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const checkout = process.argv[2];
  if (!checkout) throw new Error("Usage: node knowledge/import-free-exercise-db.ts <pinned-source-checkout>");
  const commit = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (commit !== source.version) throw new Error(`Source commit mismatch: expected ${source.version}, got ${commit}`);
  const license = execFileSync("git", ["-C", checkout, "show", "HEAD:LICENSE.md"], { encoding: "utf8" });
  if (!license.includes("public domain") || !license.includes("commercial or non-commercial")) throw new Error("Source license could not be verified.");
  const rows = JSON.parse(execFileSync("git", ["-C", checkout, "show", "HEAD:dist/exercises.json"], { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 }));
  if (!Array.isArray(rows)) throw new Error("Expected an array of source exercises.");
  const output = join(root, "exercises.imported.json");
  const existing = existsSync(output) ? JSON.parse(readFileSync(output, "utf8")) : [];
  const converted = convertUpstream(rows, existing);
  writeFileSync(output, JSON.stringify(converted, null, 2) + "\n");
  source.imported_at = new Date().toISOString();
  source.imported_count = converted.filter(x => x.source === source.source_name).length;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Imported ${source.imported_count} reviewed text exercises. No media imported.`);
}
