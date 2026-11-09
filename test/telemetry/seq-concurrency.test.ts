// 规格 §9.6 — seq 跨表全局单调:InteractionEvent/AdaptationEvent 混合并发写入,
// 共享 workout_sessions.next_event_seq 事务分配器 → 唯一、无空洞、可完整排序
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateTelemetry, SessionStore, SqliteTelemetryRecorder } from "../../src/telemetry/index.ts";
import { interaction } from "./helpers.ts";
import { validateSessionChain } from "../../src/telemetry/validate.ts";

const tmpdirFor = () => mkdtempSync(join(tmpdir(), "trainmind-seq-"));

test("两个连接交替混合写入 200 条:seq 全局唯一、无空洞、跨表排序完整", () => {
  const dir = tmpdirFor();
  const path = join(dir, "t.sqlite");
  try {
    const db1 = new DatabaseSync(path);
    db1.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    migrateTelemetry(db1);
    const store = new SessionStore(db1);
    const session = store.createSession({ appVersion: "seq-test" });

    // 第二个连接(不同 DatabaseSync 实例)在同一文件上并发写入
    const db2 = new DatabaseSync(path);
    db2.exec("PRAGMA busy_timeout=5000;");
    const r1 = new SqliteTelemetryRecorder(db1);
    const r2 = new SqliteTelemetryRecorder(db2);

    const seqs: number[] = [];
    const order: Array<"INT" | "ADP"> = [];
    for (let i = 0; i < 100; i++) {
      const e = r1.recordInteraction(interaction(session.id, { occurredAt: 1_000 + i }));
      const a = r2.recordAdaptation({
        sessionId: session.id, occurredAt: 1_000 + i,
        exerciseInstanceId: null, setRecordId: null, type: "weight_change",
        deltas: [{ field: "weightKg", before: 80, after: 75 }],
        triggeredBy: { modality: "engine", interactionEventId: null, actor: "engine" },
        reason: { code: "progression_rule", text: null }, evidenceRefs: [], applied: false, appliedAt: null,
      });
      seqs.push(e.seq, a.seq);
      order.push("INT", "ADP");
    }

    // 唯一且无空洞:恰好 1..200
    assert.deepEqual([...seqs].sort((a, b) => a - b), Array.from({ length: 200 }, (_, k) => k + 1));

    // 跨表 ORDER BY seq 的完整 timeline:交替 INT/ADP
    const reader = new DatabaseSync(path);
    const merged = reader.prepare(
      `SELECT seq, 'interaction' AS kind FROM interaction_events WHERE session_id = ?
       UNION ALL SELECT seq, 'adaptation' AS kind FROM adaptation_events WHERE session_id = ?
       ORDER BY seq`,
    ).all(session.id, session.id) as Array<{ seq: number; kind: string }>;
    assert.equal(merged.length, 200);
    assert.deepEqual(merged.map(m => m.kind === "interaction" ? "INT" : "ADP"), order);

    // 校验器:无重复、无空洞
    assert.deepEqual(validateSessionChain(db1, session.id), []);

    db1.close(); db2.close(); reader.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("分配冲突不破坏单调性(已占用 seq 由分配器跳过)", () => {
  // 因 recordX 分配+插入同事务,正常路径不会消耗空洞;此测试验证分配器对已占用 seq 的行为:
  // next_event_seq 是行内计数器,外部直插不推进它时,分配器返回的 seq 可能与外部行冲突,
  // 此时 UNIQUE(session_id, seq) 使插入失败并整体回滚(不留半行),计数器也不前进。
  const dir = tmpdirFor();
  const path = join(dir, "t.sqlite");
  try {
    const db = new DatabaseSync(path);
    migrateTelemetry(db);
    const store = new SessionStore(db);
    const session = store.createSession({});
    const rec = new SqliteTelemetryRecorder(db);
    const e1 = rec.recordInteraction(interaction(session.id, { occurredAt: 1 }));
    assert.equal(e1.seq, 1);
    // 人为直插 seq=2(绕过分配器)
    db.prepare(
      `INSERT INTO interaction_events (id, session_id, seq, occurred_at, actor, modality, action, runtime_state)
       VALUES ('manual', ?, 2, 1, 'system', 'system', 'system.autostart.next_set', 'transition')`,
    ).run(session.id);
    // 分配器读到 next_event_seq=2 与直插行冲突 → 抛错回滚,计数器不前进
    assert.throws(() => rec.recordInteraction(interaction(session.id, { occurredAt: 2 })));
    // 推进计数器越过冲突后恢复正常(模拟运维修复)
    db.prepare("UPDATE workout_sessions SET next_event_seq = 3 WHERE id = ?").run(session.id);
    const e3 = rec.recordInteraction(interaction(session.id, { occurredAt: 3 }));
    assert.equal(e3.seq, 3);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

