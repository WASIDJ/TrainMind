# TrainMind

一个会说话的 AI 健身教练。不是又一份训练计划 App——它在你练的当下开口，按你的实际状态调整剂量，练完留下可回放的事实记录。

> **状态**：演示阶段。真实接口闭环已跑通（课程 → 开练 → 组内 → 休息 → 结算 → 记录），LLM 叙事、语音播报与组内感知已接入但默认静默。不要用它对真实用户做训练建议之外的安全承诺。

## 它解决什么

市面上的训练 App 两种：一种是静态计划表，练的时候没人管；另一种是逐组盘问的表单，练到一半停在黑洞里。

TrainMind 的取舍是第三条：**少打扰，只在必要时开口**（产品裁决 D17）。

- **剂量只来自规则层**。LLM 与语音感知只决定"说什么、什么时候说"，永远不碰重量、次数、组数。
- **三态数据不混**：`counted`（系统数的）/ `reported`（用户报的）/ `assumed`（按目标推定）。`assumed` 永不参与任何"进步"宣称。
- **组内话术 ≤30 字，且不许反问**。提问只允许出现在"整场结束"和"确实卡住"两个时机。
- **感知默认静默**（`TRAINMIND_PERCEPTION_SPEAK=1` 才出声），先量误报率再打扰。

## 快速开始

需要 **Node ≥ 24**（用到内置 `node:sqlite`）。无第三方依赖，不用 `npm install`。

```bash
./start-7b3.sh                 # 推荐：带 TTS / LLM / 叙事配置启动
# 或
npm start                      # 裸启动，缺密钥时会静默退化成模板话术
```

打开 http://localhost:3000/ 。演示账号：

- `http://localhost:3000/phone-preview.html` —— 手机壳演示版（含切换账号与重载）
- `http://localhost:3000/?user=demo-investor` —— 直接进演示账号

**别用裸 `node src/server.ts`**：会静默退化成"哑教练 + 模板话术"，这是踩过的坑。密钥放 `~/.trainmind.env`（`chmod 600`），不进仓库：

```bash
TRAINMIND_CHAT_API_KEY=...   # LLM 叙事（缺失则回退模板）
TRAINMIND_TTS_KEY=...        # 语音播报（缺失则只显示文字）
```

### 演示数据

```bash
curl -s -X DELETE "http://127.0.0.1:3000/api/export?userId=demo-investor"
TRAINMIND_DEMO_USER=demo-investor TRAINMIND_DEMO_AS_HUMAN=1 TRAINMIND_APPLY=1 node tools/demo-seed.ts
```

重建后课程进度是 6/12 场。截图或演示前先重建，否则会落在"已有未结束会话"上。

## 测试

```bash
npm test                       # 全量：node --test test/（递归整个目录）
```

当前基线：**377 项 / 376 过 / 1 skip / 0 败**。提交前连跑两次确认无抖动。

**报数必须报全量并写明命令。** 早期用"手工列测试文件"的清单跑测试，漏掉了 `test/telemetry/e2e-wiring.test.ts`，得出的"0 败"是假绿（2026-11-06 踩过）。

## 架构

```
src/server.ts         HTTP 路由与静态资源（无框架）
src/core.ts           剂量 / 安全闸 / 训练状态机（唯一能改数字的地方）
src/muscles.ts        肌群账本：近 7 天刺激、恢复窗口、每周频次
src/program.ts        课程与编排
src/narration.ts      LLM 叙事层：包装指令，30 字上限，失效回退模板
src/perception.js     组内感知（静默观测）
src/progress.ts       记录与进步判定
src/community.ts      社区（关注、图文、练友）
src/daily-report.ts   日报
src/telemetry/        冻结的 SetRecord v2 事件链（可回放）
public/               单页应用：index.html + visual-design.{js,css} + 各模块
knowledge/            动作库（含禁忌标签）、处方证据、替代动作
tools/                演示数据、素材拉取、数据修复
docs/                 PROGRESS.md（当前状态）、journal/（按日取舍）、UI-SPEC.md（界面事实来源）
```

数据存在本地 SQLite（`trainmind.db`，**永不入库**——里面是真实训练与语音转写）。

## 动作素材

动作照片来自 [free-exercise-db](https://github.com/yuhonas/free-exercise-db)（Unlicense / 公有领域，可商用、可修改、可再分发、无需署名），已入库到 `public/media/freedb/`。

只有**形态确实一致**的动作才配图；找到相似但不同的动作时宁可没图。重新拉取：`node tools/fetch-freedb-media.ts`。

## 约定

动手前先读 [AGENTS.md](AGENTS.md) 和 [docs/PROGRESS.md](docs/PROGRESS.md)。

每次实质改动：跑通测试 → 更新 `docs/PROGRESS.md` 与 `docs/journal/<日期>.md` → `git commit`，消息写清"改了什么、为什么"。

判断标准：**一个没参与当天对话的人，只看仓库能不能复原"为什么这么做"**。

## 许可

尚未选择开源许可（当前为私有仓库）。第三方素材与数据集的许可见各自目录与 `knowledge/sources/manifest.json`。
