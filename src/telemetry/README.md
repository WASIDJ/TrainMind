# TrainMind Telemetry v2(冻结规格 v1.0.1 实现)

> 规格书:`trainmind-setrecord-v2-schema.md` v1.0.1(已冻结,在仓库外)
> 范围围栏(规格 §0):本模块只实现 schema / migration / TelemetryRecorder / seq 分配器 /
> episode 计算 / summary 派生 / 单元测试 / golden test。
> **不做:UI、真实语音引擎接入、上传/同步、下一 Phase。**

## 模块结构

| 文件 | 职责 |
|---|---|
| `types.ts` | 冻结类型(§3)+ 计数常量(§5)+ TelemetryRecorder 接口(§6)。**与 `src/core.ts` 同名领域类型分属两模块,互不影响** |
| `ddl.ts` | fresh DDL(§8 原文)+ legacy 加法 ALTER + 形状检测 |
| `migrate.ts` | `migrateTelemetry(db)`:fresh 建表 / legacy 补列+新表+旧 set 无损映射,可重入,`user_version=2` |
| `ids.ts` | 零依赖 ULID |
| `pure.ts` | `computeManualEpisodes` / `interruptionOverdue`(状态感知)/ `restAfterSeconds` |
| `store.ts` | `SessionStore`:v2 实体(会话/动作实例/组记录)落库与状态流转、动作替换 |
| `recorder.ts` | `SqliteTelemetryRecorder`:**Interaction/Adaptation 共享 `workout_sessions.next_event_seq` 事务分配器,分配+插入同事务 → 跨表 seq 唯一/单调/无空洞** |
| `summary.ts` | `deriveSummary`:全部 Hands-Free 计数器(§5) |
| `replay.ts` | `replayTimeline` / `renderTimeline`:跨表合并回放(交互→反馈→调整→applied) |
| `validate.ts` | `validateSessionChain`:断链/未 applied/seq 空洞检测 |

## 接入方式

```ts
import { migrateTelemetry, SessionStore, SqliteTelemetryRecorder,
         computeManualEpisodes, interruptionOverdue, restAfterSeconds } from "./telemetry/index.ts";

// 1) server 启动时(src/server.ts 已挂载):
migrateTelemetry(db); // 空库建表 / 已有库加法补列,可重入

// 2) 会话开始(domain 创建会话后,直接用其 sessionId;v2 实体经 SessionStore):
const store = new SessionStore(db);
const ex = store.createExerciseInstance({ sessionId, exerciseId: "barbell-squat", orderIndex: 0, trackingMetric: "reps" });

// 3) 遥测(语音/触摸/系统 → recordInteraction;调整 → recordAdaptation + markApplied):
const rec = new SqliteTelemetryRecorder(db);
const e = rec.recordInteraction({ sessionId, occurredAt: Date.now(), actor: "user", modality: "voice",
  action: "voice.command.feedback.hard", runtimeState: "post_set", /* … */ });
const a = rec.recordAdaptation({ /* deltas, triggeredBy: { interactionEventId: e.id, … } */ });
rec.markApplied(a.id, Date.now());

// 4) Runtime 状态机在转移检查点:interruptionOverdue(state, stalledMs) 为 true 时写
//    system.interruption.<category>(仅 pre_set/resting/transition 有 deadline;等用户输入永不计)

// 5) 组间休息计时:restAfterSeconds(set.completedAt, 下一 work interval startedAt) — 会话结束 = null
```

**埋点钩子边界**:本模块的公共 API(`TelemetryRecorder`/`SessionStore`/`interruptionOverdue`)
即钩子面;语音管道(ASR/TTS)与 UI 手势到这些 API 的接线属于 Phase 7B 集成,不在本任务范围。

## legacy 兼容(trainmind.db)

- `workout_sessions` / `set_records` 为 JSON-blob 形状 → **加法补列**(全部可空,旧行 unknown=null;`next_event_seq DEFAULT 1`)
- 旧 `set_records` 无损映射:数值/时间字段回填,`exercise_instance_id` 保持 NULL(不可安全映射);status 仅在 actualReps 存在时记 completed
- v2 行(`data_json='{}'`)对 legacy 的 `json_extract($.sessionId)` 查询天然不可见
- 每次 server 启动重跑迁移 → 新增 legacy 行持续被映射(幂等)
- `src/server.ts` 的两处位置参数 INSERT 已改为显式列名(加列后列数不匹配会崩溃;语义零变化)

## 测试

```bash
npm run test:telemetry   # 37 tests:§9 全部 8 项 + 迁移(fresh/legacy/真实库副本)+ golden
npm test                 # 全量:legacy 129 + telemetry 37
```
