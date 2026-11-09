import { readFileSync } from "node:fs";
import { validateKnowledgeRegistry } from "./schema.ts";
import type { TrainingKnowledgeRegistry } from "./types.ts";

export const trainingKnowledge = JSON.parse(readFileSync(new URL("../../knowledge/training-principles.json", import.meta.url), "utf8")) as TrainingKnowledgeRegistry;
validateKnowledgeRegistry(trainingKnowledge);
