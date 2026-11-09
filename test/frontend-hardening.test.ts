// D3–D6(2026-11-09)前端稳定性：结构守卫。
//
// 说明：index.html 是单文件内联脚本，行为测试需要真实浏览器（`npm run test:browser` 的旧套件仍在更新）。
// 这里做的是"接线守卫"——断言那几处关键接线没被改回去，配合下面的说明让人知道为什么。
// 每个断言都对应一次真实的卡死/失效场景，不是风格检查。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const section = (start, end) => {
  const from = html.indexOf(start);
  assert.ok(from >= 0, `找不到锚点: ${start}`);
  const to = html.indexOf(end, from);
  assert.ok(to > from, `找不到结束锚点: ${end}`);
  return html.slice(from, to);
};

test("D3: api() 有默认超时,且 action() 忙时给可见提示而不是静默 return", () => {
  const api = section("async function api(", "function experienceControls(");
  assert.match(api, /AbortSignal\.timeout\(15000\)/, "没有超时的话,请求悬挂会让 actionBusy 永久为 true");
  assert.match(api, /网络超时，请重试/, "超时要给用户看得懂的文案");

  const action = section("async function action(", "function setNav(");
  assert.doesNotMatch(action, /if\(actionBusy\|\|!workout/, "忙时不许直接 return");
  assert.match(action, /if\(actionBusy\)\{[^}]*voiceCaption='上一步还在提交/, "忙时要落到可见提示");
});

test("D4: currentView 不再把 document.hidden 当作\"视图失效\"", () => {
  const view = section("function currentView(", "function setWorkout(");
  assert.doesNotMatch(view, /document\.hidden/, "切后台再回来时,响应不该被判失效而丢弃");
  // 但"后台就别自动开麦"仍然要保留(这是省电/隐私,不是丢响应)
  assert.match(section("function scheduleAutoListen(", "function primeVoiceFromGesture("), /document\.hidden/, "自动聆听仍应在后台停住");
});

test("D5: 休息到 0 不再依赖\"识别不在跑\",且有重试与可见兜底", () => {
  const resting = section("function resting(", "function timedPhase(");
  assert.doesNotMatch(resting, /left===0&&!recognition/, "旧条件会让 00:00 永久卡住");
  assert.match(resting, /left===0&&!restDone/, "到 0 只触发一次");
  assert.match(resting, /clearInterval\(timer\);timer=null;advanceRest\(\)/, "先清 timer 再提交");
  assert.match(resting, /for\(let attempt=0;attempt<3;attempt\+\+\)/, "失败要重试");
  assert.match(resting, /请点「开始下一组」/, "彻底失败也要告诉用户怎么办");
});

test("D6: 提示音只创建一个 AudioContext(不再每组泄漏)", () => {
  const chime = section("let chimeCtx=null;", "function countedReps(");
  assert.equal((chime.match(/new \(window\.AudioContext/g) ?? []).length, 1, "提示音链路只允许创建一次");
  assert.match(chime, /let chimeCtx=null;/, "必须复用同一个实例");
  assert.match(chime, /chimeCtx\.state==='suspended'/, "复用时要 resume,否则 iOS 上仍然静音");
  // completionChime 本身不许再 new(离线录音那处是每次录音自建并 close 的,属另一条链路)
  assert.doesNotMatch(section("function completionChime(", "function countedReps("), /new \(window\.AudioContext/, "completionChime 不许自建上下文");
});
