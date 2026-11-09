// TrainMind Telemetry v2(冻结规格 v1.0.1)公共出口
// 与 src/core.ts 的同名领域类型分属两模块;v2 遥测一律从这里导入。
export * from './types.ts';
export { migrateTelemetry, type MigrationResult } from './migrate.ts';
export { SCHEMA_VERSION, FRESH_DDL, isLegacySchema } from './ddl.ts';
export { ulid } from './ids.ts';
export { computeManualEpisodes, interruptionOverdue, restAfterSeconds } from './pure.ts';
export { SessionStore, type CreateSessionInput, type CreateExerciseInstanceInput, type CreateSetRecordInput } from './store.ts';
export { SqliteTelemetryRecorder } from './recorder.ts';
export { RuntimeTelemetry, type RuntimeActionInput, type RuntimeActionResults } from './bridge.ts';
export { deriveSummary } from './summary.ts';
export { replayTimeline, renderTimeline, type TimelineStep } from './replay.ts';
export { validateSessionChain, type ChainIssue, type ChainIssueKind } from './validate.ts';
