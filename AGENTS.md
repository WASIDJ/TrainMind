# AGENTS.md · TrainMind 工作约定

给未来接手的人（或 AI）看的：**先读这两份，再动手**。

- 当前状态与未决事项：`docs/PROGRESS.md`
- 按日过程与取舍：`docs/journal/<日期>.md`

## 留档规则（硬性）

1. **每次实质改动/决策后**，更新 `docs/PROGRESS.md`（状态、测试数、已知坑）
2. **每个工作日**追加 `docs/journal/<YYYY-MM-DD>.md`：这天解决什么问题、发现哪些缺陷（现象/根因/修法/证据）、做了什么决策及理由、自己的失误
3. 产品级裁决写进 `../TrainMind-智能性重设计提案.md`，用 D 编号（D14/D16-B/D17…）
4. 竞品/开源对照写进 `../reverse-lab/`
5. 真机证据（截图 + UI 树）落 `device-acceptance/<时间戳>/`，日志里引用目录名
6. **每次实质改动后 `git commit`**（2026-11-09 起仓库才存在）：跑通测试 → 更新 PROGRESS/journal → 提交。消息写清"改了什么、为什么"，不写"update"。

> 判断标准：**一个没参与今天对话的人，只看仓库能不能复原"为什么这么做"**。不能，就是没留档。

## 版本控制

仓库就是 `TrainMind/` 本身（2026-11-09 `git init`）。之前从未进过 git，今天的基线提交是 `3c9e6c4`。

```bash
git status --short          # 动手前后各看一次
git add -p                  # 只挑自己这次改的，别把别人的改动卷进来
git commit -F -             # 多行消息：改了什么 + 为什么 + 验证方式
```

- **入库**：`src/` `public/` `test/` `tools/` `knowledge/` `docs/` 与根目录脚本/文档
- **永不入库**（`.gitignore` 已挡）：活库 `trainmind.db*`、备份 `*.bak*`、真机验收 `device-acceptance/`、密钥 `*.env`、`__pycache__`、外部数据集 clone `test/repdb-source/`
- 活库含真人训练与语音转写，**一旦提交进历史就无法撤回**——新增忽略规则时先确认不是数据文件

## 启动（别用裸 node）

```bash
./start-7b3.sh          # 带 TTS/LLM/叙事配置 + whisper 解释器
adb reverse tcp:3100 tcp:3000   # 手机走 USB 访问
```

裸 `node src/server.ts` 会静默退化成"哑教练 + 模板话术"——这是个已踩过的坑。

## 铁律（改代码前必须知道）

1. **LLM 与感知都只影响"说什么、什么时候说"，永不碰剂量与安全**。数字只来自规则层。
2. **术语的三态不许混**：`counted`（系统数的）/ `reported`（用户报的）/ `assumed`（按目标推定）。**assumed 永不参与"进步"宣称**。
3. **组内话术 ≤30 字，且不许反问**；提问只允许出现在"整场结束"和"确实卡住"两个时机（D17）。
4. **感知默认静默**（`TRAINMIND_PERCEPTION_SPEAK=1` 才出声）；先量误报率再打扰。
5. 任何"感知/叙事"改动都要有**反向验收**：证明它没有写剂量、没有改状态机。

## 测试

```bash
npm test                                    # 全量：node --test test/（递归整目录）
node tools/repair-durations.ts              # 数据修复（dry-run，加 TRAINMIND_APPLY=1 才写）
```

当前基线：**315 项 / 314 过 / 1 skip / 0 败**（2026-11-09 D26 落地后实跑）。提交前必须连跑两次确认无抖动。
报数必须报全量并写明命令——手工列测试文件会漏，制造假绿（2026-11-06 踩过）。
