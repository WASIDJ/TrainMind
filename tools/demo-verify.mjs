// 全功能实测：读走 demo-investor（不动），写走临时用户 demo-rehearsal（测完删除）。
const BASE = process.env.BASE ?? "http://localhost:3000";
const DEMO = "demo-investor";
const TMP = "demo-rehearsal";
const results = [];
const check = (name, cond, detail) => results.push({ name, pass: !!cond, detail });

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text, bytes: Buffer.byteLength(text) };
}
const get = (p) => req("GET", p);
const post = (p, b) => req("POST", p, b);
const ctxOf = (w) => ({
  sessionId: w.sessionId,
  exerciseId: w.exercises[w.runtime.currentExerciseIndex]?.exerciseId ?? null,
  setNumber: w.runtime.currentSetNumber,
  coachPhase: w.runtime.coach?.phase ?? null,
  status: w.status,
  eventCount: w.runtime.events.length,
});
const fetchW = async (id) => (await get(`/api/workouts/${id}`)).json?.workout;
async function act(id, type, extra = {}) {
  const w = await fetchW(id);
  return post(`/api/workouts/${id}/actions`, { type, context: ctxOf(w), ...extra });
}
// 按当前状态挑正确的下一步动作
async function step(id, reps = 10) {
  const w = await fetchW(id);
  if (!w) return { workout: null, error: "会话读取失败" };
  if (w.status === "completed" || w.status === "aborted") return { workout: w };
  const type = w.status === "resting" ? "rest_complete"
    : w.status === "warming_up" ? "warmup_complete"
    : w.status === "cooling_down" ? "cooldown_complete"
    : w.status === "paused" ? "resume"
    : "complete_set";
  const r = await act(id, type, type === "complete_set" ? { actualReps: reps, actualRepsSource: "counted" } : {});
  return { workout: r.json?.workout ?? w, error: r.json?.error };
}

// ── 1. 只读面（demo-investor，不写入） ─────────────────────
{
  const r = await get("/");
  check("页面加载", r.status === 200, `HTTP ${r.status}`);
}
{
  const r = await get("/api/coach/settings");
  check("LLM 配置", r.json?.configured === true, r.json?.model);
}
{
  const r = await get("/api/voice/status");
  check("语音识别服务", r.json?.offlineRecognition === true, r.json?.sttProvider);
}
{
  const r = await get(`/api/progress?userId=${DEMO}`);
  check("进步叙事", r.json?.exercises?.[0]?.trend === "up", r.json?.exercises?.[0]?.headline);
  check("周对周", (r.json?.weekly?.length ?? 0) > 0, r.json?.weekly?.[0]?.text);
  check("训练量对比", !!r.json?.volume, `本周 ${r.json?.volume?.thisWeek?.sessions} 场 / 上周 ${r.json?.volume?.lastWeek?.sessions} 场`);
  check("关系叙事", !!r.json?.relationship?.text, r.json?.relationship?.text);
}
{
  const r = await get(`/api/programs/active?userId=${DEMO}`);
  const s = r.json?.status;
  check("课程/周计划", !!r.json?.program, `第 ${s?.currentWeek?.weekNumber} 周「${s?.currentWeek?.title}」 已完成 ${s?.completedSessions}/${s?.totalSessions}`);
}
{
  const r = await get(`/api/history?userId=${DEMO}`);
  check("训练记录列表", r.json?.sessions?.length === 6, `${r.json?.sessions?.length} 场`);
}
{
  const r = await get(`/api/profile?userId=${DEMO}`);
  check("训练档案/能力模型", r.json?.trainingOverview?.sessions === 6, `${r.json?.trainingOverview?.sessions} 场 / ${r.json?.trainingOverview?.sets} 组`);
}
{
  const r = await get("/api/experiment?dataOrigin=human");
  check("实验看板（真人隔离）", r.json?.dataOrigin === "human", `${r.json?.sessions?.length} 条 human`);
  const csv = await get("/api/experiment/export.csv?dataOrigin=human");
  check("实验导出 CSV", csv.status === 200 && csv.text.includes(","), `${csv.bytes} 字节`);
}
{
  const r = await post("/api/coach", { message: "我今天有点累，还能练吗？" });
  const reply = r.json?.reply ?? r.json?.message ?? "";
  check("教练对话（LLM）", r.status === 200 && reply.length > 2, String(reply).slice(0, 46));
}
{
  const r = await post("/api/voice/tts", { text: "第 1 组，徒手深蹲，建议 8 到 12 次。" });
  check("语音播报 TTS", r.status === 200 && r.bytes > 2000, `${r.status} / ${r.bytes} 字节`);
}
{ // 用本机合成中文再送回识别服务
  try {
    const { execSync } = await import("node:child_process");
    const fs = await import("node:fs");
    const out = `${process.env.PI_SCRATCH_DIR}/asr-test.wav`;
    execSync(`say -v Tingting -o "${out}" --data-format=LEI16@16000 "我做完了十次"`, { stdio: "ignore" });
    const buf = fs.readFileSync(out);
    const res = await fetch(`${BASE}/api/voice/transcribe`, { method: "POST", headers: { "content-type": "audio/wav" }, body: buf });
    const j = await res.json().catch(() => null);
    check("语音识别（真实音频）", res.status === 200 && (j?.text ?? "").length > 0, `识别为「${j?.text ?? JSON.stringify(j)?.slice(0, 60)}」`);
  } catch (e) {
    check("语音识别（真实音频）", false, e.message);
  }
}

// ── 2. 建计划 + 训练全流程（临时用户） ──────────────────────
let sessionId;
{
  const r = await post("/api/workouts/preview", { input: "30分钟，在家，徒手，想练全身", userId: TMP });
  sessionId = r.json?.workout?.sessionId;
  const exs = r.json?.workout?.exercises ?? [];
  check("一句话生成计划", r.status === 201 && !!sessionId, `${exs.length} 个动作 · ${exs.map((x) => x.name).join("/")}`);
  check("缺省记真人数据（D24）", r.json?.workout?.experience?.dataOrigin === "human", r.json?.workout?.experience?.dataOrigin);
}
{
  const r = await get(`/api/workouts/${sessionId}/alternatives?index=0`);
  check("换动作·替代候选", r.status === 200 && Array.isArray(r.json?.alternatives), `${r.json?.alternatives?.length ?? 0} 个候选 ${(r.json?.error ?? "")}`);
}
{
  const r = await act(sessionId, "start", { coach: true });
  check("开始训练", r.status === 200 && ["active", "warming_up", "exercise_active", "resting"].includes(r.json?.workout?.status), r.json?.workout?.status);
}
{ // 报数（D22）+ 说「轻松」看下一组剂量
  const before = (await fetchW(sessionId)).exercises[0];
  const c = await act(sessionId, "complete_set", { actualReps: 10, actualRepsSource: "reported" });
  check("报数被采纳（D22）", c.status === 200 && ["resting", "set_feedback"].includes(c.json?.workout?.status), `status=${c.json?.workout?.status}`);
  const fb = await act(sessionId, "feedback", { feedback: "too_light" });
  const after = fb.json?.workout?.exercises?.[0] ?? (await fetchW(sessionId))?.exercises[0];
  const key = (x) => `${x?.targetReps ?? "-"}/${x?.currentWeight ?? "-"}/${x?.targetTimeSeconds ?? "-"}`;
  // 规则：该动作还有后续组才影响下一组；已做完最后一组时不动剂量（core.applyLateFeedback:763）
  const remaining = (before?.sets ?? 0) - 1;
  const changed = key(before) !== key(after);
  check("说「轻松」调下一组剂量", fb.status === 200 && (changed || remaining <= 0), `${key(before)} → ${key(after)} · 剩 ${Math.max(0, remaining)} 组${remaining <= 0 ? "（最后一组，按规则不动剂量）" : ""} ${fb.json?.error ?? ""}`);
}
{ // 暂停 / 继续
  const p = await act(sessionId, "pause");
  const paused = p.json?.workout?.status === "paused";
  const rs = await act(sessionId, "resume");
  check("暂停 / 继续", paused && rs.json?.workout?.status !== "paused", `${p.json?.workout?.status} → ${rs.json?.workout?.status}`);
}
{ // 整场练完
  let w, guard = 0, err;
  do { const s = await step(sessionId); w = s.workout; err = s.error ?? err; } while (w && !["completed", "aborted"].includes(w.status) && guard++ < 90);
  check("完整练完一场", w?.status === "completed", `status=${w?.status} · ${guard} 步 ${err ? "· " + err : ""}`);
}
{ // 训练后感受 / 记录 / 进步
  const s = await post(`/api/workouts/${sessionId}/survey`, { effort: 3, muscle: 2, pain: "none" });
  check("训练后感受提交", s.status === 200, `HTTP ${s.status}`);
  const h = await get(`/api/history?userId=${TMP}`);
  check("记录落盘", (h.json?.sessions?.length ?? 0) >= 1, `${h.json?.sessions?.length} 场`);
  const x = await get(`/api/experiment?dataOrigin=human`);
  check("真人数据进实验看板", x.json?.sessions?.some((r) => r.userId === TMP), `human ${x.json?.sessions?.length} 条`);
}
{ // 疼痛安全通道（独立一场）
  const r = await post("/api/workouts/preview", { input: "20分钟，在家，想练下肢", userId: TMP });
  const id = r.json?.workout?.sessionId;
  await act(id, "start", { coach: true });
  const pain = await act(id, "feedback", { feedback: "pain" });
  const w = pain.json?.workout;
  check("说「疼」立刻停", pain.status === 200 && (w?.runtime?.coach?.safetyStopped === true || w?.status === "paused"), `status=${w?.status} safetyStopped=${w?.runtime?.coach?.safetyStopped}`);
  await act(id, "abort").catch(() => null);
}
{ // 课程：生成 → 开课
  const c = await post("/api/programs", { userId: TMP, goal: "想练全身", weeks: 4, sessionsPerWeek: 3, targetMinutes: 30 });
  const pid = c.json?.program?.programId;
  check("生成多周课程", c.status === 201 && !!pid, `${c.json?.status?.totalSessions ?? "?"} 场`);
  const st = await post(`/api/programs/${pid}/start`, { userId: TMP });
  check("开课第 1 周第 1 场", [200, 201].includes(st.status) && !!st.json?.workout, `HTTP ${st.status} ${(st.json?.error ?? `${st.json?.workout?.exercises?.length ?? 0} 个动作`)}`);
}

const pass = results.filter((r) => r.pass).length;
console.log("\n===== 全功能实测 =====");
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(20, " ")} ${r.detail ?? ""}`);
console.log(`\n合计 ${results.length} 项：过 ${pass} / 败 ${results.length - pass}`);

// ── 3. 清场：删掉临时用户的全部痕迹，保证演示库干净 ──
if (process.env.TRAINMIND_KEEP_PROBE !== "1") {
  try {
    const { execFileSync } = await import("node:child_process");
    const sql = `
      PRAGMA foreign_keys=OFF; BEGIN;
      CREATE TEMP TABLE s AS SELECT id FROM workout_sessions WHERE user_id='${TMP}';
      CREATE TEMP TABLE sr AS SELECT id FROM set_records WHERE workout_exercise_id IN (SELECT id FROM workout_exercises WHERE session_id IN (SELECT id FROM s));
      DELETE FROM set_feedbacks WHERE set_record_id IN (SELECT id FROM sr);
      DELETE FROM adaptation_events WHERE session_id IN (SELECT id FROM s);
      DELETE FROM interaction_events WHERE session_id IN (SELECT id FROM s);
      DELETE FROM observer_records WHERE session_id IN (SELECT id FROM s);
      DELETE FROM set_records WHERE id IN (SELECT id FROM sr);
      DELETE FROM exercise_instances WHERE session_id IN (SELECT id FROM s);
      DELETE FROM workout_exercises WHERE session_id IN (SELECT id FROM s);
      DELETE FROM workout_sessions WHERE id IN (SELECT id FROM s);
      DELETE FROM training_records WHERE user_id='${TMP}';
      DELETE FROM experiment_records WHERE user_id='${TMP}';
      DELETE FROM session_contexts WHERE user_id='${TMP}';
      DELETE FROM programs WHERE user_id='${TMP}';
      DELETE FROM user_training_model_snapshots WHERE user_id='${TMP}';
      DELETE FROM experience_preferences WHERE user_id='${TMP}';
      DELETE FROM exercise_performances WHERE user_id='${TMP}';
      DELETE FROM user_profiles WHERE user_id='${TMP}';
      DELETE FROM users WHERE id='${TMP}';
      COMMIT;`;
    execFileSync("sqlite3", ["trainmind.db", sql], { stdio: "ignore" });
    console.log(`已清掉临时用户 ${TMP} 的测试数据（演示库保持干净）`);
  } catch (e) {
    console.log(`清场失败，请手动清理 ${TMP}：${e.message}`);
  }
}

process.exit(pass === results.length ? 0 : 1);
