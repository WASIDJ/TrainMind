# TrainMind 进度总表

> 这份文件只放**当前状态**。过程与取舍见 `docs/journal/` 的按日记录。
> 规则：每次实质改动/决策后更新本文件；新增日志追加到 `docs/journal/<日期>.md`。

最后更新：2026-11-09

## 一、当前状态（一句话）

从"我要练"到"练完留痕"的骨架已跑通；**教练人格层（判断/叙事/感知）是核心资产**；截至今天，产品主张从"逐组盘问"转向**"少打扰、只在必要时开口"**（D17）。用户已确认 Ladder 全屏教练方向，首页、计划确认和真实训练流程已接入正式界面。

## 二、测试与质量

| 项 | 数值 |
|---|---|
| 全量测试 | **316 项 / 315 过 / 1 skip / 0 败**（2026-11-09 复核修复后 `npm test` 全目录实跑两次一致） |
| 说明 | 早期用"手工列文件"的清单跑测试，漏掉 `test/telemetry/e2e-wiring.test.ts` 等文件，得出的"0 败"是假绿。2026-11-06 起改为跑整个目录，**报数一律报全量** |
| 真机证据 | `device-acceptance/20261105-094515/`（42 个截图 + UI 树） |
| 本次复核（2026-11-09） | 审计 46 条 + 裁决 D22/D23/D24 + D26 多轮编排 + 复核 High-1 修复后 `npm test` 实跑 **316 项 / 315 过 / 1 skip / 0 败，连跑两次一致**（272 → … → 311 → 315 → 316） |

新版 UI 浏览器专项通过：390 × 844、320 × 568、1280 × 900，含训练条件、计划、开练、完成一组直达休息、暂停/恢复、记录与档案。10 张截图见 [UI 验收](ui-review/README.md)。全量回归（`npm test`）为 311 项 / 310 过 / 1 skip / 0 败，连续两次一致（2026-11-09 修完审计 46 条 + owner 三条裁决 D22/D23/D24）。本机 Chrome 已接入（`npm run test:browser`）：28 项 / 16–17 过 / 11–12 败（1 项已知抖动），失败仍是旧套件 D17 前预期与平台差异（详见 2026-11-06 日志与 `device-acceptance/20261106-175300-browser-e2e/`）；套件更新仍是独立工作项。本轮未连接真机。

用户已定稿全屏教练方向。正式 `public/index.html` 通过 `visual-design.js/css` 接入首页、计划确认、训练、休息、暂停、热身/放松和结算布局。「我的」可选择三个教练形象，按训练者 ID 保存在当前设备。使用真实接口读取计划与记录；静态教练画面保存在 public/coach-media。常用服务 3000 已重启生效。真实接口闭环与 320×568 触达已验证，真机语音未复测。原型完整页面仍见 [设计稿](ui-options/ladder/overview-v2.png)。

## 文档索引

- **UI 设计规范 v1.0（给设计/AI 的唯一事实来源）**：[UI-SPEC.md](UI-SPEC.md)
- 智能度评估与优化路线（教到现在多聪明、下一步怎么更聪明）：[AI-COACH-INTELLIGENCE.md](AI-COACH-INTELLIGENCE.md)
- **存量缺陷清单（M/N 重做审计，46 条，按批执行）**：[AUDIT-BACKLOG.md](AUDIT-BACKLOG.md)
- 组内听觉感知设计：[../../trainmind-组内听觉感知设计.md](../../trainmind-组内听觉感知设计.md)
- 产品级裁决（D14/D16-B/D17…）：[../../TrainMind-智能性重设计提案.md](../../TrainMind-智能性重设计提案.md)
- 竞品/开源对照：`../../reverse-lab/`（含 workout.cool、Duolingo）

## 三、已经能跑的闭环

```
课程/计划 → 开练 → 组内执行 → （自动结组） → 休息 → 下一组/下一场
                ↓                                      ↓
        组内感知（静默观测）                      进度/关系/课程进度
```

| 能力 | 状态 | 关键文件 |
|---|---|---|
| 计划生成（规则 + LLM 解析） | 可用，真机验证 | `src/core.ts` |
| 剂量与安全（规则层，LLM 不碰数字） | 可用 | `src/core.ts` / `src/narration.ts` |
| 教练叙事（LLM 只改说法，失败回退模板） | 可用，**30 字上限 + 组内禁问句** | `src/narration.ts` |
| 组内听觉感知 v1 | **静默观测中**（不打扰，只记数据） | `src/perception.js`、`/api/workouts/:id/perception` |
| 多周课程（Program→Week→Session） | 可用，真机验证 | `src/program.ts`、`programs` 表 |
| 计划/执行分离 | 可用 | `WorkoutSession.program` + `ProgramCompletion` |
| 进步叙事 | **口径改为"规律性"**（场次/组数），动作级次数仅在用户 opt-in 报数时出现 | `src/progress.ts` |
| 关系进度（跨月） | 可用，真机验证 | `src/progress.ts` |
| 回归钩子 | 应用内卡片（**无后台推送**） | `/api/progress` → 首页 |
| **喊停三段式** | 疼痛立即停 / 疲惫先问原因+推一把 / 二次喊才收工 | `src/coach-runtime.ts` |
| **全语音交互** | 计划页说「开始」即开练；暂停/继续/下一组/跳过/换动作/做完了/再说一遍 全可语音 | `public/index.html` |
| 感知自检页 | 可用（真机可开麦看基线/事件） | `/perception-check` |
| 神经网络 TTS | **已连通**（speech-02-turbo，302→OSS 预签名需二次 GET） | `src/server.ts` `/api/voice/tts` |
| 本地 whisper STT | 已连通（需 `TRAINMIND_PYTHON` 指向装有 faster-whisper 的解释器） | `tools/stt-sidecar.py` |

## 四、今天定下的关键决策

| 编号 | 决策 | 影响 |
|---|---|---|
| D17 | 组内零盘问：不报数、不逐组问感受；**只问两次**（整场结束 / 真的卡住） | 见设计提案 D17 段 |
| — | 进步口径由"次数"改为"规律性" | 次数不再被测量，`actualRepsSource` 恒为 `assumed` |
| — | 感知**默认静默观测**（`TRAINMIND_PERCEPTION_SPEAK=1` 才开口） | 先量误报率再决定是否打扰 |
| — | 传感器路线全部否决（手机/杠铃传感器/摄像头）；**改为"倾听"**：组内命令词 | 见 journal 第八节 |
| — | 喊停不许"一累就停"：疲惫先追问原因并推一把，第二次才收工 | 见 journal 第九节 |
| D20-B | 历史无标记次数一律回填 assumed（保守口径）；easy→+load 只认实测证据 | 次数进步叙事清零待实测组；见提案文档 D20-B 段 |
| D22 | 报数是**可选功能**：报了记 counted/reported 并参与进步；不报仍是 assumed，教练不主动问（owner 2026-11-09） | `complete_set` 透传次数；进步叙事主力仍是"规律性" |
| D23 | 日/周边界按**服务器本地时区**（owner 2026-11-09） | 早间训练不再落前一天/上周；换机器后归属会按新时区重算 |
| D24 | **所有真实训练**的 `dataOrigin` 缺省 **human**（预览 + 课程，owner 2026-11-09 追加澄清）；存量 34 场已改标 | 实验看板 `human` 能看到真实训练；自动化探针仍留 demo |

## 五、未决事项（需要 owner 拍板或我继续推进）

| 事项 | 状态 |
|---|---|
| 退路三选一：第二次喊停后给「降一点/就这样/少做一组」 | 当前只做 `pause`，三选一未接 |
| 组内命令词识别（停/轻一点/跳过这组/做完了）在健身房的识别率 | 待实测 |
| 后台推送（真·它来找我） | 未做（现在是应用内卡片） |
| 感知阈值真机校准 | 需要 owner 练 2-3 场收集数据 |
| 单场时长型动作（540 秒）展示 | 计划和组内目标均显示「9 分钟」 |
| 旧 Chrome 前端套件 | `npm run test:browser` 为 **28 项 / 16–17 过 / 11–12 败**（抖动项是 `a user gesture resumes synthesis`，两次跑交替过/红）。稳定失败仍是 D17 前文案/时序预期与 Windows 专属离线识别，套件更新仍是独立工作项，证据见 `device-acceptance/20261106-175300-browser-e2e/` |
| 审计存量缺陷（46 条已清零） | 清单见 [AUDIT-BACKLOG.md](AUDIT-BACKLOG.md)。**46/46 全部修完**（2026-11-09），最后三条按 owner 裁决落地：D22 报数可选、D23 本地时区、D24 真实训练缺省 human（含存量 34 场改标） |

## 六、已知坑（别再踩）

1. **启动必须用 `./start-7b3.sh`**：TTS/LLM/叙事配置都在里面；裸 `node src/server.ts` 会静默退化成"哑教练 + 模板话术"
2. **TTS 供应商返回 302**，必须 `redirect:"manual"` 再对 Location 发 GET；跟随 POST 跳转会 405
3. **whisper sidecar 需要 `TRAINMIND_PYTHON=/opt/homebrew/bin/python3`**（系统 python3 没有 faster-whisper）
4. **手机访问走 `adb reverse tcp:3100 tcp:3000`**：局域网 HTTP 会被 VPN 拦；Firefox 的麦克风授权弹窗**拒绝合成点击**，只能人手点
5. **训练时长必须封顶**（10 分钟空闲）：否则过夜挂机会被算成训练（历史出现过 19 天的"训练"）
6. **`preview` 会话的坑**：普通预览要自动让位；课程场次（带 `program`）要幂等返回，否则用户卡死
7. **H6 的"whisper 置信度"是死代码（2026-11-09 发现）**：`tools/stt-sidecar.py` 里 `segments` 是 faster-whisper 的生成器，先 `join` 再算 `durations` 会拿空列表，`confidence` 从未返回。当时只做了 `py_compile` 就记成"已验证"——**这类改动必须打一段真音频看返回值**，见 [AUDIT-BACKLOG.md](AUDIT-BACKLOG.md) C5

## 七、投资人演示包（2026-11-09 交付，可直接上台）

| 组件 | 路径 | 说明 |
|---|---|---|
| 一条命令准备 | `tools/demo-ready.sh` | 重造演示数据 → 6 项体检 →（可选）29 项全功能实测 → 打开浏览器 |
| 全功能实测 | `tools/demo-verify.mjs` | 29 项：读走 `demo-investor`，写走临时用户 `demo-rehearsal`，跑完自动清场，演示库不留痕 |
| 演示数据 | `tools/demo-seed.ts` | `demo-investor`：3 周 6 场、实测 8→12 次、4 周课程 6/12（第 3 周「加深」） |
| 8 分钟讲稿 | [DEMO-SCRIPT.md](DEMO-SCRIPT.md) | 两条主线（语音教练闭环 / 课程与进步）+ 投资人三问 + 兜底表 |
| 一页纸 | [INVESTOR-BRIEF.md](INVESTOR-BRIEF.md) | 定位、现场 12 项能力、三条护城河、诚实边界、下一步要什么 |

**实测结论（2026-11-09，连跑两次一致）**：`TRAINMIND_FULL_VERIFY=1 ./tools/demo-ready.sh` → 体检 7/7、功能实测 **29/29**；跑完 `workout_sessions` 中 `demo-rehearsal` 残留 0 条、`demo-investor` 仍 6 条。

演示库现状：`demo-investor` 6 场 / 18 组；`/api/experiment?dataOrigin=human` 18 条（探针已隔离在 demo）。

**注意**：`tools/demo-verify.mjs` 里"说「轻松」调下一组剂量"一项按 `core.applyLateFeedback` 的规则判定——该动作**还有后续组**才改剂量，做完最后一组时不动（曾因断言写死"必须变"而误报一次红）。

## 八、版本控制（2026-11-09 首次入库）

**此前项目从未进过 git**，所有改动只能靠 `trainmind.db.bak-*` 之类的文件快照回滚——今天一整轮（46 条审计 + 三条裁决 + 演示包）都没有历史。

现在的约定：

- 仓库 = `TrainMind/` 本身；基线提交 `3c9e6c4`（209 个文件，28208 行）
- **每次实质改动后提交**：跑通测试 → 更新 PROGRESS/journal → commit（见 `AGENTS.md`「版本控制」）
- 不进库：活库 `trainmind.db*`、备份 `*.bak*`、`device-acceptance/`、`*.env`、`__pycache__`、`test/repdb-source/`（外部数据集 clone，按需拉）

入库时踩到一个结构性坑：`test/repdb-source/` 是上游 `RepDB/exercise-dataset` 的 clone，被当作 gitlink（`160000` 模式）收进来但没有 `.gitmodules`，clone 下来会是个空目录。代码实际只读 `knowledge/exercises.repdb.json`，于是把它移出仓库并在 `.gitignore` 里记下来源 URL。

## 九、信息架构收敛 + 打卡闭环（2026-11-09，D26）

**问题**：两条生成计划的路在互相打架。首页并列「生成今日计划」和「和教练聊聊」；「计划」tab 里有第三个会回环到首页的「单场训练」；教练对话聊完不产出任何计划；课程只有数字没有打卡动作。

**依据**：`reverse-lab/duolingo-工作笔记.md` §一——多邻国永远只给"下一个下一步"，复习/错题/跳级都不是并列入口（`PATH_LEVEL_SESSION_END_INFO`）；§四明确断签惩罚我们不抄。

**改动**：

| 位置 | 之前 | 现在 |
|---|---|---|
| 首页主 CTA | 「生成今日计划」（与「和教练聊聊」平级） | 有课程 → 「继续第 N 周」；无课程 → 「排今天的训练」；「今天不跟课程」降为一行文字 |
| 「计划」tab | 单场入口（回环）+ 多周课程 | 改名「我的课程」：课程路径（12 个节点）+ 打卡日历（28 格）+ 连续周 |
| 教练对话 | 只回话术 | 想排计划 → 多轮收槽位（频率/器械）→ 给 `programProposal` → 对话里「就按这个来，开始第 1 周」 |
| 打卡 | 无 | 练完亮一格；连续 N 周 + 本周 X 场；**不做断签惩罚** |

**证据**：新增 `test/coach-program-proposal.test.ts`（4 项，清空模型配置也必须过 → 证明参数来自规则）。浏览器实走：首页显示「继续，第 3 周」+「继续这一场」；课程页 12 节点 + 28 格日历 + 「连续 3 周 · 本周已练 1 场」；教练 3 轮后出卡片，点击建课落到计划页 6 个动作（用 `demo-rehearsal` 验证，测完清零，`demo-investor` 仍是 6 场 / 1 门课程 / 0 未完成）。

## 十、外部复核（2026-11-09）：1 条 High 真缺口 + 1 条口径污染，已修

复核方不采信报告，亲跑两遍测试、只读核查真库、临时服务器端到端实测 4 个安全关键修复、派子代理审前端、核 git 卫生。它的总判定：**46 条修复 45 条属实，B6 有一处真缺口**。

| 复核结论 | 我的核实 | 处置 |
|---|---|---|
| **High-1**：B6 只修了按钮路径，语音路径（`stopIntent=pain`）不标组 | ✅ 复现：休息态说"刚才那组做完有点恶心" → `paused + safetyStopped:true`，但组记录 `feedback=right, pain=false` | 在 [server.ts](../src/server.ts) 的 pain 分支镜像按钮路径的 `applyLateSetFeedback`，并新增语音路径 e2e（`test/health.test.ts`，断言 feedback=pain、剂量不变） |
| **Medium-2**：`demo-seed` 把合成种子写死成 `human`，污染实验口径 | ✅ 属实：`/api/experiment?dataOrigin=human` 18 条里 6 条是合成的 | 种子缺省改 `demo`；`demo-ready.sh` 显式传 `TRAINMIND_DEMO_AS_HUMAN=1` 才升格，并打印"演示后归回 demo"提醒；诚实边界加一行 |
| **Medium-3**：未提交改动 + 服务跑旧代码 | ✅ 属实：进程 16:48:59 启动、文件 16:51:44 才改完 | 已重启；本轮改动按约定提交 |
| Nit：`recordDetail` 里 `'计划目标：'+doseText(x)` 未转义 | ❌ **误报**：该表达式整体在 `esc(...)` 括号内（`esc(a \|\| '计划目标：'+doseText(x))`），已转义 | 不改 |

**复核没发现、但我顺手修掉的一个真缺陷**：`demo-seed` 号称"可重复重造"，但删除旧会话时没删 `workout_exercises` / `exercise_instances`；只要库里有一场经 API 建出来的会话，整个事务就撞 `FOREIGN KEY constraint failed` 回滚（本轮实测撞到）。已补全删除顺序（先 `set_feedbacks` → `set_records` → 事件 → `workout_exercises` → `exercise_instances` → 会话）。

口径现状（2026-11-09 复核后实查）：`human` **12 条**（真实训练）、`demo` 7 条（探针）；演示时用 `TRAINMIND_DEMO_AS_HUMAN=1` 临时升到 18，演示后归回。
