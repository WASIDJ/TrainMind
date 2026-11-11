// D26(2026-11-09, owner 要求):"和 AI 聊完生成编排好的计划"。
// 反向验收重点:课程参数必须来自规则收集,不能来自模型的自由发挥;
// 缺槽位时只问一个、且绝不猜器械(器械由用户决定,这是既有产品口径)。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const freePort = async () => {
  const probe = createServer();
  await new Promise<void>(r => probe.listen(0, "127.0.0.1", () => r()));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(r => probe.close(() => r()));
  return port;
};

async function startServer() {
  const dir = await mkdtemp(join(tmpdir(), "trainmind-program-"));
  const dbPath = join(dir, "t.db");
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), HOST: "127.0.0.1", TRAINMIND_DB: dbPath, TRAINMIND_STT: "off" };
  // 编排分支不该依赖 LLM:故意清掉模型配置,证明"聊出来的课程"不需要模型也能出参数
  for (const key of ["TRAINMIND_CHAT_BASE_URL", "TRAINMIND_CHAT_MODEL", "TRAINMIND_CHAT_API_KEY"]) delete env[key];
  const child = spawn(process.execPath, ["src/server.ts"], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", b => output += b);
  child.stderr.on("data", b => output += b);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`服务没有起来: ${output.slice(-400)}`)), 20000);
    child.stdout.on("data", b => { if (String(b).includes("TrainMind running")) { clearTimeout(timer); resolve(); } });
    child.once("exit", code => reject(Error(`服务提前退出(${code}): ${output.slice(-400)}`)));
  });
  return {
    origin: `http://127.0.0.1:${port}`,
    async coach(body: unknown) {
      const r = await fetch(`http://127.0.0.1:${port}/api/coach`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> };
    },
    async close() { if (child.exitCode === null) { child.kill(); await new Promise(r => child.once("exit", r)); } await rm(dir, { recursive: true, force: true }); },
  };
}

test("D26: 想排计划时先问频率,不给参数也不编计划", { timeout: 40000 }, async () => {
  const s = await startServer();
  try {
    const r = await s.coach({ message: "帮我排个训练计划" });
    assert.equal(r.status, 200);
    assert.equal(r.body.programProposal, null, "槽位没齐时不许给 proposal");
    assert.equal(r.body.mode, "program_proposal");
    assert.match(String(r.body.reply), /一周想练几次/);
    assert.ok((r.body.programSlotsMissing as string[]).includes("sessionsPerWeek"));
  } finally { await s.close(); }
});

test("D26: 多轮续接——用户只答数字也要接得上,收齐后给出可执行参数", { timeout: 40000 }, async () => {
  const s = await startServer();
  try {
    // 第二句"每周三次"不含"计划"二字,靠历史里我们自己的提问识别为续接
    const r = await s.coach({
      message: "每周三次",
      history: [
        { role: "user", content: "帮我排个训练计划" },
        { role: "assistant", content: "一周想练几次？3 次是个能坚持的开始。" },
      ],
    });
    assert.equal(r.status, 200);
    assert.match(String(r.body.reply), /哑铃|弹力带/, "还缺器械时只问器械,不许猜");
    assert.equal(r.body.programProposal, null);

    const full = await s.coach({
      message: "在家，有哑铃，每次30分钟",
      history: [
        { role: "user", content: "帮我排个训练计划" },
        { role: "assistant", content: "一周想练几次？3 次是个能坚持的开始。" },
        { role: "user", content: "每周三次" },
        { role: "assistant", content: "在家还是去健身房？手边有哑铃或弹力带吗？（只有自重也可以）" },
      ],
    });
    const p = full.body.programProposal as Record<string, unknown>;
    assert.ok(p, "槽位齐了必须给 proposal");
    assert.equal(p.sessionsPerWeek, 3);
    assert.deepEqual(p.equipment, ["dumbbell"], "器械来自用户原话,不是模型猜的");
    assert.equal(p.weeks, 4);
    assert.equal(p.targetMinutes, 30);
    assert.equal(full.body.programSlotsMissing instanceof Array && (full.body.programSlotsMissing as string[]).length === 0, true);
  } finally { await s.close(); }
});

test("D26: 有周期没器械——不许替用户决定器械", { timeout: 40000 }, async () => {
  const s = await startServer();
  try {
    const r = await s.coach({ message: "帮我排个 4 周的计划，每周练三次" });
    assert.equal(r.body.programProposal, null);
    assert.deepEqual(r.body.programSlotsMissing, ["equipment"]);
  } finally { await s.close(); }
});

test("D26: 普通闲聊不触发编排(不许把聊天都当成要建课)", { timeout: 40000 }, async () => {
  const s = await startServer();
  try {
    const r = await s.coach({ message: "今天有点累，还能练吗？" });
    assert.equal(r.body.programProposal, undefined, "非编排分支不带 proposal 字段");
    assert.notEqual(r.body.mode, "program_proposal");
  } finally { await s.close(); }
});

// 2026-11-11 审查发现的死循环：用户说"去健身房"后，我们回问"在家还是去健身房？有哑铃吗"，
// 用户答"健身房"→ 同一句再问一遍，永远收不到 equipment。产品上"不猜器械"仍然成立，
// 但提问必须能往前走：按环境给出可选的答案词，并认出"器械都有"这类明确授权。
test("D26: 答'健身房'不能把同一句问题再问一遍，且最终能收齐器械", { timeout: 40000 }, async () => {
  const s = await startServer();
  try {
    const first = await s.coach({ message: "帮我安排 8 周，每周 3 次，去健身房" });
    assert.equal(first.body.programProposal, null, "没说器械就不给 proposal");
    assert.deepEqual(first.body.programSlotsMissing, ["equipment"]);
    const firstReply = String(first.body.reply);
    assert.match(firstReply, /哑铃|自重/, `第一问要给出可回答的词：${firstReply}`);

    const second = await s.coach({
      message: "健身房",
      history: [
        { role: "user", content: "帮我安排 8 周，每周 3 次，去健身房" },
        { role: "assistant", content: firstReply },
      ],
    });
    const secondReply = String(second.body.reply);
    assert.notEqual(secondReply, firstReply, "不许把同一句问题原样再问一遍");
    assert.deepEqual(second.body.programSlotsMissing, ["equipment"], "确实还缺器械");
    assert.match(secondReply, /哑铃|弹力带|自重/, `第二问要给出明确选项：${secondReply}`);

    const third = await s.coach({
      message: "哑铃",
      history: [
        { role: "user", content: "帮我安排 8 周，每周 3 次，去健身房" },
        { role: "assistant", content: firstReply },
        { role: "user", content: "健身房" },
        { role: "assistant", content: secondReply },
      ],
    });
    const proposal = third.body.programProposal as Record<string, unknown>;
    assert.ok(proposal, `答出器械后必须给 proposal：${JSON.stringify(third.body)}`);
    assert.deepEqual(proposal.equipment, ["dumbbell"]);
    assert.equal(proposal.environment, "gym");
    assert.equal(proposal.weeks, 8);
    assert.equal(proposal.sessionsPerWeek, 3);
  } finally { await s.close(); }
});

test("D26: 用户明确说'器械都有'时按健身房器械排，不算替他猜", { timeout: 40000 }, async () => {
  const s = await startServer();
  try {
    const r = await s.coach({ message: "帮我安排 6 周，每周 2 次，去健身房，器械都有" });
    const proposal = r.body.programProposal as Record<string, unknown>;
    assert.ok(proposal, `明确授权器械后应当直接给 proposal：${JSON.stringify(r.body)}`);
    assert.deepEqual(proposal.equipment, ["dumbbell"]);
    assert.equal(proposal.environment, "gym");
  } finally { await s.close(); }
});
