# 审计 backlog（2026-11-09 重做）

> 状态：**待挑活**。这份文件是"还剩哪些真实缺陷"的唯一事实来源。
> 规则：修完一条在这里划掉并写明日期 + 验证方式；新产品级裁决仍写进 `../../TrainMind-智能性重设计提案.md`。

## 为什么重做

2026-11-06 那份外部全仓审查（B1-B2 / H1-H6 / M1-M15 / N1-N9）**原始清单从未落成文件**，只存在于当次对话里——对话一结束，M/N 的具体内容就丢了（journal 只留了"优先级最高的三个：M2/M4/M12"和三处修复记录）。所以本轮按模块重做一遍只读审计，产出可执行清单，编号改用分片前缀（A/B/C/D）以便溯源。

**这不是找回旧清单，是重新查一遍。** 旧清单里某些编号可能对应不同的东西，不要拿旧编号去对。

## 方法

| 项 | 做法 |
|---|---|
| 分片 | A: `server.ts`/`coach-runtime.ts`/`narration.ts`/启动脚本 · B: `core.ts`/`program.ts`/`progress.ts`/`perception.js`/`capability.ts` · C: `src/telemetry/*`/`tools/*` · D: `public/*.html` |
| 只读 | 四个分片并发只读审计，不改任何文件 |
| 抽查 | 主代理亲自复核 **15 / 46 条**（标 ✅）；其余标 ⏳（子代理断言，未亲验） |
| 基线 | 复核时 `npm test` 实跑：**272 项 / 271 过 / 1 skip / 0 败**，与 PROGRESS 记录一致，无漂移 |

抽查亲验的 15 条：A1 A2 A3 A4 A5 A9 B1 B4 B7 C1 C3 C4 C5 D1 D2 D8。

严重度：**M** = 用户可感知的错误／数据口径错／安全证据断链，非崩溃级或触发条件较窄；**N** = 小瑕疵、可维护性亏欠。

## 汇总

共 **46 条：M 30 / N 16**。**已全部修完（46/46）**——最后三条按 owner 裁决落地（D22 报数可选 / D23 本地时区 / D24 `dataOrigin`）。见各条标题末尾的 ✅已修 日期。

| 片 | M | N | 覆盖 |
|---|---|---|---|
| A · HTTP/进程/叙事 | 7 | 3 | 话术守门、喊停消费、启动期解析、静态资源、body 上限、survey 白名单 |
| B · 领域/剂量/口径 | 10 | 2 | assumed 驱动剂量、中断缩量、时长型单位错、三态只降不升、替换动作、趋势死代码、UTC 切天 |
| C · 持久化/脚本 | 7 | 5 | 三步拆事务、迁移无事务无版本闸、legacy 时间轴、最近会话排序、whisper 置信死代码、修复脚本 |
| D · 前端 | 6 | 6 | 反问、30 字上限、网络无超时、后台丢响应、休息卡 00:00、AudioContext 泄漏 |

**最该先看的四条**（都是"我们以为已经修好了、实际没生效"或直接踩铁律）：

1. **C5** —— H6「whisper 置信度」是死代码：`generate_segments` 是生成器，被消费两次后 `durations` 恒空，`confidence` 从未返回。**H6 的验收结论不成立，需要重开。**
2. **A2** —— 语音说「头晕/胸闷/不练了」：教练嘴上有反应（叙事开启时甚至说"今天就到此为止"），但**状态机一个都不动**，训练继续跑。
3. **B1** —— M3 只堵了 `+load` 路径，**次数进阶仍由 assumed 次数驱动**：目标 `8-10`，推定 8 次轻松 → 下场变 `9-10`。
4. **A1** —— 叙事守门只验"模板数字有没有丢"，不拦"LLM 自己加的数字"，编造的"再加 5 公斤"能过门。

---

# A · HTTP / 进程 / 叙事（`src/server.ts`、`src/coach-runtime.ts`、`src/narration.ts`）

## A1 · 叙事守门只校验模板数字是否出现，不拦 LLM 新增数字 · M · ✅亲验 · ✅已修 2026-11-09

- 证据：`src/narration.ts:123-126` —— `for (const token of templateText.match(/\d+/g) ?? []) { if (!new RegExp(...).test(text)) return "number"; }`，只做单向包含检查。
- 后果：自重/无负重动作的模板只有"第 N 组""建议 X"两个数字，LLM 可自由追加"最后一组加到 20 次""再加 5 公斤"，守门全放行 → 语音念出的剂量不是规则层给的。组内感知槽位另有 `/数字/` 全禁（说明作者知道这洞），但只补了一个槽位。
- 修法：`guardNarration` 对 `slot !== "effort_cue"` 增加反向校验——输出中的 `\d+` 去重后必须 ⊆ 模板数字集合，否则 `return "number"`。
- 验证：`guardNarration("第1组，自重12次，最后一组加到20次。", "第 1 组，自重，建议 12。", "set_intro")` 现在返回 `null`（放行），应返回 `"number"`。
- 工作量：S

## A2 · 喊停的 `pain` / `hard_stop` 分支没人消费：嘴上停、状态机不停 · M（安全相关，建议优先） · ✅亲验 · ✅已修 2026-11-09

- 证据：`src/server.ts:765-766` 只判 `stopIntent === "exhaustion"`；`src/coach-runtime.ts:24-25` 明明返回 `pain` / `hard_stop`；`parseCoachReport`（`coach-runtime.ts:107`）的疼痛词表只有 `/疼|痛|(?:膝盖|肩膀|腰|身体).*不舒服/`，不含头晕/胸闷/心慌/恶心。
- 后果：说「我有点头晕」→ 规则层不停训；若开了叙事，`server.ts:825` 的 `RED_FLAG` 会命中并让教练说「今天训练可以到此为止」（`narration.ts:12`），而 `session.status` 仍是 `exercise_active`、`safetyStopped` 仍空——**话术说停、状态机照跑**。裸 `npm start`（无叙事）连这句话都没有。说「我不练了/跳过这个动作」→ `directive:{action:"none"}`，什么都没发生。
- 修法：`case "coach_message"` 里 `stopIntent === "pain"` 直接走 `handleCoachEvent({type:"pain"})`；`hard_stop` 映射为 `pauseWorkout` + 明确指令；把 `classifyStopIntent` 的词表与 `parseCoachReport` 合并成一份（现在两份词表已经漂移）。
- 验证：`exercise_active` 会话 POST `/actions` `{"type":"coach_message","message":"我有点头晕"}` → 现在 `status` 不变、`safetyStopped` 为空；修后应为 paused/safetyStopped。
- 工作量：S

## A3 · 组内模板话术从未受 30 字上限约束，实测中位数 95 字 · M · ✅亲验（已量化） · ✅已修 2026-11-09

- 证据：`src/narration.ts:117-118` 只量 LLM 输出；回退分支 `narration.ts:175` 原样返回 `templateText`；`src/server.ts:802-804` 的 `start_set` 模板拼了 `instructions[0]`。
- 量化：按前端同一拼法（`第 N 组，名称，重量，建议 X 次。` + 要领 + `做完后告诉我。`）对 `core.ts` 里 **102 个动作**逐一计算——**全部超 30 字，中位 95 字，最长 184 字**（`固定单车`）。
- 后果：`npm start`（未设 `TRAINMIND_NARRATION`）100% 念这个长句；开了叙事也只要 LLM 超时 2.5s 就回退到同一长句。用户在组内喘着气听 90+ 字播报——铁律 3 在最常见的降级路径上形同不存在。
- 修法：`narrate` 回退前对模板做 `SLOT_MAX_CHARS[slot]` 裁剪（按标点截到首个句号）；`server.ts:804` 去掉 `instructions[0]` 拼接，要领改到屏幕上展示。
- 验证：起服务 POST `start_set`，量 `directive.text.length`；或对 102 个动作跑一遍上述脚本，断言全部 ≤30。
- 工作量：S

## A4 · `chatConfigReady` 的 `JSON.parse` 裸奔 + 全仓无 `unhandledRejection` → 一行坏配置启动即死 · M · ✅亲验 · ✅已修 2026-11-09

- 证据：`src/server.ts:148-149`（`JSON.parse` 在内层 try 之外，外层 IIFE 无 catch）；`grep unhandledRejection|uncaughtException src/ tools/` → **0 命中**。
- 后果：`app_settings.coach` 的 `data_json` 被写坏（手工改库/写入中断/磁盘满）→ 模块加载期同步 reject、无人 await → Node 默认按未捕获拒绝退出。表现为"启动即死、无 HTTP"。用 `start-7b3.sh` 设了环境变量会提前 return 躲开，换环境启动就踩。
- 修法：IIFE 整段包 try/catch（坏行 → warn + 清空）；`server.ts` 末尾加 `process.on("unhandledRejection")` 兜底。
- 验证：拷库 → `UPDATE app_settings SET data_json='{broken' WHERE name='coach'` → `env -u TRAINMIND_CHAT_* PORT=3999 node src/server.ts`，观察退出码。
- 工作量：S

## A5 · 先 `writeHead` 再 `await readFile`，读失败时 catch 再写一次头 → 崩进程 · M · ✅亲验 · ✅已修 2026-11-09

- 证据：`src/server.ts:396-399` 四个静态资源分支都是 `res.writeHead(200,…); return res.end(await readFile(...))`；`server.ts:870` 的全局 catch 又调 `json()`（内部 `writeHead`）→ `ERR_HTTP_HEADERS_SENT` 逃出 try，无人接。
- 后果：`public/` 任一静态文件缺失/不可读（打包漏文件、权限、磁盘错）→ `GET /` 直接带走进程，用户看到白屏 + 之后全部请求连接失败，而不是一个 500/404。
- 修法：四个分支改成先 `await readFile` 再 `writeHead`；`json()` 加 `if (res.headersSent || res.writableEnded) return;` 守卫。
- 验证：`mv public/trainmind-ui.css /tmp/` → `curl /trainmind-ui.css` → 再 `curl /api/coach/settings` 应连不上（进程已死）。
- 工作量：S

## A6 · JSON 请求体无大小上限（只有转写端点有 2MB 闸） · M · ✅亲验（读码） · ✅已修 2026-11-09

- 证据：`src/server.ts:81` 的 `body()` 无限累加 `raw += chunk`；对比 `server.ts:456` 转写端点显式 413。十余处 POST 共用 `body()`。
- 后果：`--mobile` 时绑 `0.0.0.0`，一个几百 MB 的 body 让 RSS 冲到 GB 级被 OOM 杀掉 → 训练中断线，库里留下未收尾会话。
- 修法：`body()` 累计长度，默认 256KB（preview/coach 1MB），超限抛 `UserInputError` + `req.destroy()`。
- 验证：`curl --data-binary @big.json` 对照 `ps -o rss=` 前后值；修后应返回 413。
- 工作量：S

## A7 · `/survey` 把请求体原样展开进 `training_records`，可覆写实测字段 · M · ✅亲验（读码） · ✅已修 2026-11-09

- 证据：`src/server.ts:868` `finalize(session, survey)` 无白名单；`server.ts:322` `{ ...JSON.parse(exists.data_json), ...survey }`；`server.ts:333` 新建时 `...survey` 也在最后。
- 后果：一次 `POST {"doseOutcomes":[],"elapsedClockMs":0}` 就能清空这场训练的剂量证据与时长，并写进 `experiment_records`，实验导出与 `/api/progress` 时长统计从此不可信，无审计痕迹。
- 修法：survey 分支显式白名单（6-8 个量表字段，数字/布尔校验）；`finalize` 内再做一次白名单。
- 验证：对已完成训练 POST 污染字段，查 `json_extract(data_json,'$.elapsedClockMs')` 是否变 0。
- 工作量：S

## A8 · 课程开局"是否已有进行中会话"的预检查与落库之间隔一次 await，连点生成重复会话 · N · ✅已修 2026-11-09

- 证据：`src/server.ts:576-577` 预检查 → `server.ts:586-589` `await createWorkoutFromInput(...)`（等 LLM，窗口秒级）→ `persistNewWorkout`。
- 后果：两个并发请求都通过检查，各落一条同 `programSessionId` 的 preview 会话。课程进度因 `program.ts:139` 幂等不会被灌水，但 `workout_sessions` 留永久重复行，`/api/workouts/active` 取 `created_at DESC` 可能拿到副本。
- 修法：检查 + 落库进同一 `BEGIN IMMEDIATE`；或加部分唯一索引。
- 验证：并发两次 `POST /api/programs/:id/start`，查 `COUNT(*) WHERE programSessionId=<sid>` → 2。
- 工作量：M

## A9 · `isInternalError` 把 `SyntaxError`/`TypeError` 判成内部错误 → 用户可修的输入问题回 500 · N · ✅亲验 · ✅已修 2026-11-09

- 证据：`src/server.ts:66-69`；`server.ts:81` 畸形 JSON 抛 `SyntaxError`；`server.ts:162` `new URL(req.headers.origin)` 遇 `Origin: null` 抛 `TypeError`（同文件 392 行那处已 try/catch，这处没有）。
- 后果：前端拼坏 JSON 或中间层改写 Origin → 用户看到"服务器开小差了"，日志只有 `SyntaxError`，把人往重启服务上引。
- 修法：`body()` 的 `JSON.parse` 包 try → `UserInputError`；Origin 解析失败按 403。
- 验证：`curl -d '{bad' /api/programs` 现在 500，应为 400；`Origin: null` 现在 500，应为 403。
- 工作量：S

## A10 · 课程开局把 `dataOrigin` 硬编码 `"demo"`，主线真实训练在实验视图里全被过滤 · N · ✅已修 2026-11-09（D24 裁决：真实训练缺省 human）

> 2026-11-09 owner 追加澄清后范围扩大：`/api/workouts/preview`（首页生成计划）的缺省值**也是 demo** —— 所以被当成演示数据的不只是课程场次，而是全部真实训练。两处缺省值一并改为 `human`，并用 `tools/relabel-data-origin.ts` 把存量 34 场（30 普通 + 4 课程）改标，自动化探针保持 demo。

- 证据：`src/server.ts:586` `createWorkoutFromInput(userId, template.input, "demo")`；`server.ts:368` 默认 `human` 并按 `dataOrigin` 过滤。
- 后果：多周课程（产品主线）产生的真实训练在默认实验视图/CSV 里全部消失，只剩 preview 路径的数据，看板"人类场次"系统性偏低。
- 修法：`programStart` 接受 `input.dataOrigin`（枚举校验，缺省 `human`）并透传，或统一缺省值。
- 验证：开一场课程训练后对比 `/api/experiment` 与 `?dataOrigin=all` 的条数。
- 工作量：S

---

# B · 领域 / 剂量 / 口径（`src/core.ts`、`src/program.ts`、`src/progress.ts`、`src/perception.js`、`capability.ts`）

> 反向验收已确认：**感知层没有任何写入剂量或状态机的路径**（`perception.js` 只经 `deliver()` → `POST /perception`，服务端只读会话、只产话术与遥测；`test/perception.test.ts:178` 覆盖）。铁律 4 成立。本节无最高严重度条目。

## B1 · M3 只堵了 `+load` 路径，**次数进阶仍由 assumed 次数驱动** · M · ✅亲验 · ✅已修 2026-11-09

- 证据：`src/core.ts:309` `repDone` 用未过滤来源的 `setForLatest` 求均值（对比 315 行 `measuredSets` 已按 `actualRepsSource` 过滤）；`core.ts:318` `atRepCeiling = repDone >= max`；`core.ts:319` 分支里 `repRange = \`${next}-${max}\``，`next = repDone + 1`。
- 后果：目标 `8-10` 的动作，用户"只点完成 + 组后补一句轻松"（`server.ts:732` 每组都写 `feedback:"right"`、无次数 → `actualReps = targetMin`、来源 `assumed`），两场后 `repDone = 8` → 下场目标凭空变 `9-10`，再一场 `10-10`。**推定值直接抬剂量**，与已修的 +load 漏洞同一根因，次数路径没堵。
- 修法：`repDone` 改用 `measuredSets`（实测均值），无实测时落 `hold_for_confirmation` 并补 `assumed_reps_excluded` 审计码（与 load 路径同一套话术）。
- 验证：照 `test/capability.test.ts:164` 的 `m3Facts` 造 `targetReps:"8-10"`、`actualReps:8`、`source:"assumed"`，断言 `repRange === "8-10"` 且 `progressionStep === undefined`（现在得 `"9-10"`）。
- 工作量：S

## B2 · 中断场次的"已做组数"被当作下场剂量基准，中途退出 = 永久砍量 · M · ✅已修 2026-11-09

- 证据：`src/core.ts:275` `sets = latest?.sets ? clamp(latest.sets) : defaultSets` 不区分 `latest.completed`；`core.ts:301-303` 的 `!latest.completed` 分支只打 reason 码，不回滚已缩小的 `sets`。
- 后果：3 组计划只做完 1 组就退出 → 下次该动作被排成 `minSets`（1-2 组），还说"保持保守剂量"。多次中断后无法回到原量。
- 修法：`core.ts:275` 改 `latest?.completed ? clamp(latest.sets) : exercise.defaultSets`；301 分支保持 `sets = base.sets`。
- 验证：`core.test.ts` 造一场 `aborted`、该动作 1 条 SetRecord（`maxSets:4/minSets:2`），断言 `sets === 3`（现在 2）。
- 工作量：S

## B3 · 时长型动作落库 `actualReps = 0`，被当成"没完成目标次数"，回退出 `300-298秒` · M · ✅已修 2026-11-09

- 证据：`src/core.ts:767` `actualReps = input.actualReps ?? (repOrTimeBased === "time" ? 0 : targetMin)`；`capability.ts:31` `x.actualReps < Number(targetReps.match(/\d+/)[0])` → `0 < 300` 恒真 → 难度一律 `failed`；`core.ts:294` 回退 `repRange = ${min}-${max-2}`。
- 后果：任一计时型动作按完成键结组后，能力模型记成失败场次，`failedSessionCount`/`consecutiveEasy` 被污染，回退目标次数变成 `300-298秒`（mobility 主项时原样上屏）。**单位把秒当次比**。
- 修法：`time` 型用 `actualDurationSeconds` 而非 `actualReps` 参与比较；`classify` 增加"目标含秒则不比次数"的短路；`core.ts:291-294` 对 time 型不做次数收窄。
- 验证：造含 `march-in-place` 的会话，`submitSetFeedback({feedback:"right"})` → 断言 `actualDurationSeconds > 0` 且 `recentOutcomes[0].difficulty !== "failed"`。
- 工作量：M

## B4 · 组后补报的真实次数被永久留在 `assumed`，三态只降不升 · M · ✅亲验 · ✅已修 2026-11-09

- 证据：`src/core.ts:731` `...(input.actualReps !== undefined ? { actualReps: input.actualReps, actualRepsSource: record.actualRepsSource } : {})` —— 数值收了，来源沿用旧值（自动结组时是 `assumed`）。
- 后果：用户说"其实我做了 12 次"，`progress.ts:36`/`program.ts:157` 仍把它排除在进步结论外，永远是"稳定在 X 次"。实测被当成推定，与铁律 2 的方向相反。
- 修法：`applyLateFeedback` 增加 `actualRepsSource` 入参（缺省 `"reported"`），有 `actualReps` 时升级来源；`server.ts:744` 透传。
- 验证：`health.test.ts` 加用例：自动结组得 assumed → `applyLateFeedback(rec,{actualReps:12})` → 断言来源变 `reported` 且 `exerciseProgress.bestReps` 上升。
- 工作量：S

## B5 · 中途换动作把 `completedSets` 归零，实际组数超处方 · M · ✅已修 2026-11-09

- 证据：`src/core.ts:795-796` `Object.assign(current, { ..., sets: recommendation.sets, ..., completedSets: 0 })`，`sets` 仍是完整计划组数。
- 后果：3 组动作做完 1 组后换动作 → 新动作再做 3 组 = 本次 4 组（超处方），第 4 组 `setNumber=4 > sets`；`capability` 的 `latest.sets = 4` 又经 B2 把下场排到 `maxSets`。用户感知"换个动作反而多练一组"。
- 修法：`replaceExercise` 里 `sets: Math.max(1, recommendation.sets - current.completedSets)` 且 `currentSetNumber = 1`。
- 验证：`core.test.ts` 加用例走 `replaceExercise` 后断言新动作 `sets === 2`、`currentSetNumber === 1`。
- 工作量：S

## B6 · 休息中报"疼"只暂停、不把刚完成那组标成 pain，下次还排同一动作 · M · ✅已修 2026-11-09

- 证据：`src/core.ts:612-621`（`safety_stop` 分支只 `pauseWorkout` + 记事件，不返回 `record`）；`server.ts:742` 的 late 路径白名单明确拒绝 `pain`。
- 后果：最常见时机（做完一组才觉得疼）→ 会话暂停，但那组 `feedback` 仍是 `right`、`pain=false` → `capability.recentPainEvent === false` → `core.ts:282` 的 `avoid` 不触发，下次照排同一动作。**安全证据断链**。
- 修法：`applyLateFeedback` 支持 `feedback:"pain"`（只置 `updated.pain = true`，不改剂量不产话术）；`server.ts:742` 对 pain 先走 late 更新再 `handleCoachEvent(pain)`。
- 验证：`health.test.ts` 加用例：完成一组进 resting 后 `handleCoachEvent({type:"pain"})` → 断言 `recentPainEvent === true` 且下次 `recommendExercise().action === "avoid"`。
- 工作量：M

## B7 · `trend: "down"` 是死代码：`deltaReps = best - first` 恒 ≥ 0，退步被报成"稳定" · M · ✅亲验 · ✅已修 2026-11-09

- 证据：`src/progress.ts:52-57` `bestReps = Math.max(...sorted.map(...))`、`deltaReps = bestReps - first.actualReps` → 恒 ≥ 0；`progress.ts:63` 的 `trend` 三元与 `headline` 因此永远走不到 `"down"`/回落文案。
- 后果：12 → 6 → 4 的用户得到 `trend:"flat"`、文案"稳定在 4 次"，`progressSummary` 还会说"最近几次都稳定"——把退步说成稳定。
- 修法：增加 `lastVsFirst = last.actualReps - first.actualReps`（或与上一场比），`trend`/`headline` 用它。
- 验证：`progress.test.ts` 造 12→6→4，断言 `trend === "down"` 且 headline 含回落语义。
- 工作量：S

## B8 · `streakWeeks` 不校验"最近一周"，停练两个月仍宣称"连续 N 周" · M · ✅已修 2026-11-09

- 证据：`src/progress.ts:104-109` 只数历史里最长的一段连续周，不比对当前周；`progress.ts:120` 的 `nudgeFor` 还会说"连续 5 周了，今天别断了"。
- 后果：用过去的事实冒充当前状态。
- 修法：`weeks[0]` 不在本周/上周则 `streakWeeks = 0`；`nudgeFor` 不再引用过期 streak。
- 验证：`progress.test.ts` 造 5 个连续周 + `now` 晚 8 周，断言 `streakWeeks === 0` 且 text 不含"连续"。
- 工作量：S

## B9 · LLM/解析出的时长无范围校验：0、负数、999 分钟都能进规则层 · M · ✅已修 2026-11-09

- 证据：`src/core.ts:206` 只校验 `Number.isInteger`；`core.ts:235` `duration ?? 20`（`??` 拦不住 0）；`core.ts:435` `optionalDurationMinutes` 由此派生；`core.ts:67` 的 schema 写了 `minimum:5, maximum:180` 但校验函数不执行、`generateWorkout` 也不 clamp。
- 后果：`0` 不触发澄清（`core.ts:227` 只判 `null`）→ 生成注定超时的畸形课；`-5` 同理；`999` → 屏上出现"可选低强度有氧 969 分钟"。**数字来自解析而非规则层**。
- 修法：`validateStructuredContext` 加 `Number.isInteger(v) && v >= 5 && v <= 180`（与 schema 同源常量）；越界降级为 `missing` 走澄清；`generateWorkout` 开头 clamp。
- 验证：`core.test.ts` 表驱动传 `0/-5/999`，断言 `errors.length > 0`（现在皆空）。
- 工作量：S

## B10 · 切天/切周走 UTC，早间训练被算成前一天/上一周 · M · ✅已修 2026-11-09（D23 裁决：服务器本地时区）

- 证据：`src/program.ts:150` `mondayOf` 用 `getUTCDay()` + `toISOString()`；`src/progress.ts:96`/`101` 用 `date.slice(0,10)`（UTC 日期串）去重。
- 后果（北京用户）：① 周一 07:30 训练 = 周日 23:30Z → `weekOverWeek` 归到上周，本周数据为空；② 同一自然日 07:00 与 20:00 两次训练跨 UTC 日期 → 算成 2 天，`totalSessions`/`daysTogether` 虚高；③ `daysSinceLast` 显示"昨天练过"。
- 修法：抽 `dayKey(t, tzOffsetMinutes)` / `weekStart(t, tz)`，`program.ts:150`、`progress.ts:96/101/103/135` 统一走它。
  > 需定：时区来源用服务器本地时区还是固定 `+08:00`（单用户本地应用，建议本地时区，测试里显式注入）。
- 验证：`program.test.ts` 造 `now = 2026-11-09T10:00:00Z`（周一 UTC）+ set 在 `2026-11-08T23:30:00Z`（北京周一 07:30），断言进 `thisWeek`（现在落 `lastWeek`）。
- 工作量：M

## B11 · `weekOverWeek` 遇脏 `completedAt` 抛 `RangeError`，同仓 `weeklyVolume` 有防呆 · N · ✅已修 2026-11-09

- 证据：`src/program.ts:150/158` `mondayOf(Date.parse(s.completedAt))` → `NaN` → `Invalid time value`；对比 `progress.ts:137` 有 `Number.isFinite` 过滤。
- 后果：历史里一条非 ISO `completedAt` 就让整周对比抛错。
- 修法：循环开头 `if (!Number.isFinite(t)) continue`；`mondayOf` 内部对 NaN 返回 null。
- 验证：`program.test.ts` 传 `completedAt:"not-a-date"`，断言返回 `[]` 不抛（现在抛）。
- 工作量：S

## B12 · 感知频控把"节奏确认"算进 2 次插话上限，与模块契约"（除计数）"矛盾 · N · ✅已修 2026-11-09

- 证据：`src/perception.js:81/90-91/101` —— `pace_confirm` 也走 `emit()` 递增 `interjections`；注释与设计写的是"组内插话 ≤2 次（除计数）"。
- 后果：`TRAINMIND_PERCEPTION_SPEAK=1` 时，`pace_confirm` 吃掉一个名额，最有价值的 `last_sprint` 常被挡掉，功能价值减半。
- 修法：`emit` 对 `rule !== "pace_confirm"` 才递增 `interjections`；同步改 `test/perception.test.ts:120` 的用例。
- 验证：`onRep(2)` 拿 `pace_confirm` → `effort_rise` → `strain_peak`，断言第三个仍返回 `last_sprint`（现在 `null`）。
- 工作量：S

---

# C · 持久化 / 脚本（`src/telemetry/*`、`tools/*`）

## C1 · 一次组记录写入被拆成三个独立 savepoint，失败只回滚尾段 · M · ✅亲验 · ✅已修 2026-11-09

- 证据：`src/telemetry/bridge.ts:520-524`（`upsertSetFromDomain` → `recordSetFeedback` → `recordDoseAdaptation` 三次调用，各自 `reentrantTx` 已 RELEASE）；`server.ts:819` 的 catch 只打日志不重抛，外层 `COMMIT` 照常提交。
- 后果：任一步抛错（UNIQUE/FK/NOT NULL/SQLITE_BUSY）→ 出现"有组行、没反馈、少适应事件"的半截链。`validateSessionChain` 查不出"组无反馈"，`unapplied_adaptation` 也查不出。当前活库 21/21 干净，属潜在缺陷。
- 修法：把 `recordCompletedSet`（及疼痛、adaptation 路径）整体包一个 `reentrantTx`，三步同生共死；或 `onAction` 整体一个 savepoint、失败 `ROLLBACK TO`。
- 验证：`bridge.test.ts` 注入一个 `recordSetFeedback` 必抛的 recorder 子类，调 `onAction({type:"complete_set"})`，断言 `set_records` 未新增行。巡检 SQL：`SELECT count(*) FROM set_records sr WHERE sr.exercise_instance_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM set_feedbacks f WHERE f.set_record_id=sr.id AND sr.status IN ('completed','partial'))`。
- 工作量：S

## C2 · `migrateTelemetry` 无事务、从不读 `user_version`、无并发锁 · M · ✅已修 2026-11-09

- 证据：`src/telemetry/migrate.ts:44-61` 逐条 `db.exec` autocommit，最后才 `PRAGMA user_version`；全仓 `user_version` 只写不读（`ddl.ts:9` 的 `SCHEMA_VERSION` 从未被校验）。
- 后果：① 中途失败（如 v2 已有重复 `(exercise_instance_id,set_number)` → `CREATE UNIQUE INDEX` 抛错）留下"列加了、索引没建、版本仍 0"的半迁移库，且 `server.ts:47` 在 try 之外调用 → 启动崩溃循环；② 两进程同时启动并发 ALTER → `duplicate column name`。
- 修法：`BEGIN IMMEDIATE … COMMIT` 包全部（含版本号）；开头读 `user_version`：大于 `SCHEMA_VERSION` 直接拒绝、等于则返回；建唯一索引前先做重复检查并给可读报错。
- 验证：造 legacy 库 + 两条重复行，跑两次迁移，第二次必须业务化报错且 `user_version` 不变。
- 工作量：S

## C3 · legacy 迁移从不回填会话的 `started_at/ended_at`（实测 66/66 为 NULL） · M · ✅亲验 · ✅已修 2026-11-09

- 证据：`src/telemetry/ddl.ts:84-85` 加的是可空列；`migrate.ts:74-105` 的 `backfillLegacySetRecords` 只处理 set_records。实测：`select count(*) from workout_sessions where started_at is null` → **66**（总数 66）。
- 后果：v2 会话时间轴整列为空，只能靠 `summary.ts:20-31` 每次解析 `data_json` 兜底；任何 `ORDER BY started_at`（见 C4）、按时间窗的统计都退化。
- 修法：加 `backfillLegacySessions`，从 `data_json.createdAt / runtime.completedAt` 派生，只在两列均 NULL 时写（天然幂等），统计进 `MigrationResult`。
- 验证：`migrate-legacy.test.ts` 的 `legacyShapeDb()` 迁移后断言 `started_at` 等于 `Date.parse(data_json.createdAt)`；线上期望 NULL 归零。
- 工作量：S

## C4 · `latestRunningSession` 的兜底排序在 legacy 库上退化成 no-op（并含死三元） · M · ✅亲验 · ✅已修 2026-11-09

- 证据：`src/telemetry/bridge.ts:576-579` —— else 分支里 `byUser` 恒 false，三元恒取 `started_at`，而该列全 NULL（C3）→ `ORDER BY` 全等值 → SQLite 按 rowid 返回**最早插入**的运行中会话。
- 后果：`recordAsrRetry`/`recordNarration`/`recordPerception` 在 `userId` 缺失时把事件挂到最老的运行中会话上，方向与注释"最近"相反。活库现有 14 个非终态会话（10-26 四条、11-05 三条 preview 等），一旦 userId 缺失必然串场，`voice.asr_retry` 的 H6 归因指标失真。
- 修法：兜底排序改 `ORDER BY COALESCE(started_at, created_at) DESC`（ISO 串可直接比较）或 `rowid DESC`，删掉死三元；更稳的做法是调用方传 sessionId 而不是"猜最新"。
- 验证：造两条 running 会话（`started_at` 均 NULL，`created_at` 差 10 分钟），`recordAsrRetry(null)` 后断言落在**较新**那条；现有 `bridge.test.ts` 只造单会话，测不出。
- 工作量：S

## C5 · **H6 的 whisper 置信度是死代码**：生成器被消费两次，`confidence` 从未返回 · M（旧结论失效，建议优先） · ✅亲验（实测） · ✅已修 2026-11-09

- 证据：`tools/stt-sidecar.py:63-71`
  ```python
  segments, _info = model.transcribe(io.BytesIO(audio), ...)
  text = "".join(s.text for s in segments).strip()      # 生成器已被耗尽
  durations = [max(0.0, s.end - s.start) for s in segments]   # → []
  if segments and sum(durations) > 0:                    # sum([])==0 → 永不进
  ```
  实机确认：faster-whisper **1.2.1**，`WhisperModel.transcribe` 返回 `return segments, info`，其中 `segments` 来自 `generate_segments`（`transcribe.py:1103` 定义、`:1870` `yield segment`）——**是生成器**。
- 后果：`payload` 永远不带 `confidence` → 前端 `index.html` 的 0.45 低置信确认守门在本地 whisper 主路径上仍是死代码（H6 注释描述的行为没生效，也没有报错）。**2026-11-06 journal 里 H6 的"置信度已恢复生效"结论不成立，需要重开并改结论。**
- 修法：`segments = list(model.transcribe(...)[0])` 一次物化，再算 text 与时长加权 `avg_logprob`。
- 验证：打一段噪声 wav 到 `/transcribe`，断言响应含 `confidence ∈ [0,1]`（当前恒缺）；`py_compile` 不算验证。
- 工作量：S

## C6 · `repair-durations.ts` 的 apply 路径无 try/无事务，中途异常留下部分写入且重跑跳过 · M · ✅已修 2026-11-09

- 证据：`tools/repair-durations.ts:35-53` —— 每条 session 自动提交，`JSON.parse` 无 try，`record.activeWorkoutMs = fixed` 可能 TypeError；连接未设 `PRAGMA busy_timeout`，活库 `journal_mode=delete`（非 WAL），服务在跑时并发写直接 `SQLITE_BUSY`。
- 后果：`workout_sessions` 与 `training_records` 是两段独立提交。若第 N 条 session 更新成功、第 M 条 training_record 坏 JSON 抛错 → 前 N 条已落库、对应 training_records 未同步；重跑因 `Math.abs(oldMs-newMs) > THRESHOLD` 已不成立而**跳过** → 脏数据固化。
- 修法：整个 apply 包 `BEGIN IMMEDIATE/COMMIT`（异常全回滚）；`JSON.parse` 与属性赋值套 try 计 `broken` 继续；连接后 `PRAGMA busy_timeout=5000`；开头提示"建议停服后运行"。
- 验证：造 `training_records.data_json='{bad'` 的副本库，`TRAINMIND_APPLY=1` 跑两遍：第一遍必须整体回滚，第二遍结果一致。
- 工作量：S

## C7 · `backfill-reps-source.ts` 在服务运行中 `copyFileSync` 活库做备份，且逐行提交、误伤 v2 行 · M · ✅已修 2026-11-09

- 证据：`tools/backfill-reps-source.ts:16`（`copyFileSync(dbPath, backup)`）/`:19`（`SELECT id, data_json FROM set_records` 不限形状）/`:32`（逐行 run）。
- 后果：① 服务同时写库（`journal_mode=delete`）时可能复制到写入中间态，而回滚就依赖这份备份；② 无事务，中途崩 → 部分行已标、部分没标，dry-run 的预演数字失去意义；③ v2 行（`data_json='{}'`）也会被写进一个 legacy 域不读的字段，制造"看着有标记、实际与三态无关"的噪声。
- 修法：备份改 `VACUUM INTO`（或先 `BEGIN IMMEDIATE` 再复制）并做 `integrity_check`；选行加 `WHERE exercise_instance_id IS NULL AND set_number IS NULL`；整个回填一个事务。
- 验证：dry-run 与 apply 两次的"本次回填"数必须相同；`sqlite3 <bak> "PRAGMA integrity_check"` = ok；apply 后 `count(*) where data_json like '%actualRepsSource%' and exercise_instance_id is not null` = 0。
- 工作量：S

## C8 · 读取层把 unknown 伪造成确定值（null → 0 / `''` / `'skipped'`） · N · ✅已修 2026-11-09

- 证据：`src/telemetry/records.ts:26/50-51/63` —— `startedAt ?? 0`、`exerciseInstanceId ?? ''`、`setNumber ?? 0`、`status ?? 'skipped'`。
- 后果：legacy 回填行（`exercise_instance_id IS NULL`、`status` 为 NULL）映射成"1970 年开始、第 0 组、已跳过"的假事实。当前 `getSession/getSetRecord/listSetRecords/finalizeSet` 在 `src/` 无生产调用方（只在 test 里），属潜在口径错；但这是冻结规格的读出口，一旦报表/回放用它就会把 unknown 计成 skipped。
- 修法：映射层保留 `null`（类型已是 `IsoMs | null`），或读取时跳过未映射 legacy 行并计数。
- 验证：插一行 `status=NULL, started_at=NULL` 的 set_records，`mapSetRow` 断言不返回 `'skipped'`/`0`。
- 工作量：S

## C9 · `seq_gap` 判定与"允许预留 seq"的语义冲突 · N · ✅已修 2026-11-09

- 证据：`src/telemetry/validate.ts:57-60` 要求 seq 从 1 连续；`recorder.ts:30-33` 的 `nextSeq()` 注释明说独立调用会预留；`test/telemetry/seq-concurrency.test.ts:68` 正是先占再跳。
- 后果：一次预留（或分配后进程崩）就让校验器永久报 `seq_gap`，"真丢事件"与"预留未用"无法区分。线上当前无洞、`next_event_seq-1 == max(seq)` 成立。
- 修法：拆成 `seq_reserved_unused`（允许，计 summary）与 `seq_gap`（对比 `next_event_seq` 才算不可解释）；或生产路径禁用 `nextSeq()`。
- 验证：`nextSeq()` 后不插入，跑 `validateSessionChain`，断言 issue kind 不是 `seq_gap`。
- 工作量：S

## C10 · 迁移返回的 `applied` 契约自相矛盾；legacy 路径用"首行正则"切 DDL · N · ✅已修 2026-11-09

- 证据：`src/telemetry/migrate.ts:44` `FRESH_DDL.filter(s => !/workout_sessions|set_records/.test(s.split('\n')[0]))`；`:56-57` 重入时也 `applied.push(LEGACY_SET_RECORDS_UNIQUE_INDEX)`，与头注释"重入时为空数组"相反。
- 后果：任何用 `applied.length` 判断"这次是否真动了库"的调用方每次重启都以为做了迁移；将来在 `FRESH_DDL` 加一条"首行含 set_records 的索引"会被静默漏建。
- 修法：显式声明"fresh-only / both"两组常量，不用正则切；索引用 `hasIndex()` 判定后再 push。
- 验证：`migrate-legacy.test.ts` 的可重入用例追加断言：第二次 `applied` 为空。
- 工作量：S

## C11 · `device-acceptance.py` 的"手机在线"会假通过，且断言失败直接崩、丢报告 · N · ✅已修 2026-11-09

- 证据：`tools/device-acceptance.py:152` `if "device" in adb("get-state")` —— 没插手机时输出 `error: no devices/emulators found` 含子串 `device` → 立刻判通过；`:206-211` `tap(fb,...)` 的 `fb` 可能是 `None` → TypeError，而 `phase8_report()` 在 `:285` 之后才跑。
- 后果：验收员看到"✓ 手机在线"却一路失败；反馈屏没出现时脚本崩在 `tap(None)`，`report.md` 不生成——与 AGENTS.md 的留档规则冲突。
- 修法：`adb get-state` 结果 `strip() == "device"`；`wait_ui` 返回 None 时 `check(False)` 并优雅返回；`main` 用 try/finally 保证 `phase8_report()` 总执行。
- 验证：不插手机跑脚本 → 必须报"手机在线 False"且退出码非 0；把 `:131` 关键词改成不存在的词 → 仍生成 `report.md` 并列出 ❌。
- 工作量：S

## C12 · 语音原文入库无长度上限，只有叙事路径截 120 字（同类数据两套口径） · N · ✅已修 2026-11-09

- 证据：`src/telemetry/bridge.ts:300`（complete_set 的 `voiceTranscript` 全量入库）、`:453`（疼痛 transcript 原样入 `set_feedbacks`）对比 `:592`（只有 narration 截 120）；`ddl.ts:40/51` 两列均无长度限制、无保留期。
- 后果：一次误触长录音会原样永久留在库里（`types.ts:82` 承诺"本地存储、上传 opt-in"，但库本身无衰减），导出/CSV/日志都带着它；疼痛与恐惧类自由文本最敏感。属风险敞口，非已发生事故。
- 修法：recorder 层统一截断（如 200 字）+ `TRAINMIND_TELEMETRY_TRANSCRIPT=0` 开关；`replay.renderTimeline` 打印时也截断。
- 验证：传入 5000 字 transcript，断言落库长度 ≤ 上限。
- 工作量：S

---

# D · 前端（`public/index.html`、`public/perception-check.html`）

## D1 · 报数交互仍在，但 `complete_set` 不带次数 → 实测次数被丢成 assumed · M · ✅亲验 · ✅已修 2026-11-09（D22 裁决：报数=可选功能，报了就记 counted）

- 证据：`public/index.html:546`（滑动完成）与 `:331`（语音"做完了"）都调 `action('complete_set')` 不附次数；`src/server.ts:727-736` 的 complete_set 分支根本不读 `input.actualReps`，直接 `submitSetFeedback({feedback:"right"})` → `assumed`；而 `index.html:91/331` 又明说"你报了 N 次"。
- 后果：用户跟着报数、界面确认"记了 N 次"，滑一下就全丢；该组记为 assumed → `measuredSets` 永不增长，记录页进度长期是"—"。
- **需裁决**：D17 定的是"组内不报数、不盘问"，那么前端这套报数交互就该**删掉**；若保留（用户主动报数算 counted），则 complete_set 必须透传 `actualReps + actualRepsSource`。两条路互斥，选一个。
- 验证（若选透传）：报数到 3 → 点完成 → 记录页应显示"3 次"而非"（按计划估算）"。
- 工作量：S

## D2 · 组内仍在反问，直接违反铁律 3 / D17 · M · ✅亲验 · ✅已修 2026-11-09

- 证据：`public/index.html:330` `speech.play(\`记了 ${repCount} 次。做完了吗？\`)`（`exercise_active` 分支）；`:329` `…太轻、太重还是正好？`；`:562` 反馈页 `刚才这一组，身体感觉怎么样？`。
- 后果：用户只说"我做了 10 次"就触发组内反问——D17 明令禁止的盘问；无 coach 的课程场次同样会说。
- 修法：330/329 改陈述句（"记了 10 次，按这个数记下。"），562 去掉问句；对前端硬编码话术加统一断言（≤30 字、不含 `？/吗/还是`）。
- 验证：真机进组内说"我做了10次"，听是否出现问句。
- 工作量：S

## D3 · `api()` 无超时 + `actionBusy` 单点锁 → 请求悬挂时全站按钮静默失效（含疼痛上报） · M · ✅已修 2026-11-09

- 证据：`public/index.html:451` `fetch` 无 signal；`:604` `if(actionBusy||…)return;`；`:606-626` 全程无超时/无 loading 提示。疼痛上报 `await action('feedback',{feedback:'pain'})` 也被静默吞。
- 后果：USB 反向代理抖动或服务端卡住 → `actionBusy` 常驻 true → 完成/暂停/结束/换动作/疼痛上报全部"点了没反应"，且无任何提示。**疼痛上报无声失败属安全通道问题。**
- 修法：`api()` 统一 `AbortSignal.timeout(15000)`；超时给可见错误 + 可重试；`actionBusy` 守卫改成"有提示的拒绝"。
- 验证：DevTools 设 Offline 后点"完成"，观察是否永久无响应、有无提示。
- 工作量：S

## D4 · 页面切后台再回来，响应被静默丢弃，按钮永久停在"正在生成计划…" · M · ✅已修 2026-11-09

- 证据：`public/index.html:14` `currentView()` 把 `!document.hidden` 并入有效性判定；`:806-808` 成功分支 `if(!currentView(stamp))return;`，catch 也不复位。
- 后果：生成计划耗时数秒，中途切到微信再回来 → 结果被丢、按钮停在禁用态，只能退出重进。同形态在 `handleCoachInput`(:368)、performance 分支也有。
- 修法：`currentView` 不校验 `document.hidden`；至少 `finally` 里复位按钮。
- 验证：生成计划时立刻切后台 5 秒回来，看按钮文案与是否进计划页。
- 工作量：S

## D5 · 休息倒计时到 0 却卡在 00:00（自动完成依赖"识别不在跑"） · M · ✅已修 2026-11-09

- 证据：`public/index.html:571` `if(left===0&&!recognition&&!coachBusy){clearInterval(timer);action('rest_complete',{},'auto')}`；`:158` 休息态持续重开识别（12 秒一轮，间隙约 500ms）。
- 后果：`left===0` 那一秒大概率被 `recognition!==null` 挡掉；再叠加 `rest_complete` 失败时 timer 已被清空 → 界面永久停在 00:00，"开始下一组"成为唯一出路。用户以为卡死。
- 修法：到 0 立即清 timer 并置 `restExpired`，在识别 `onend` 或 1s 后重试提交；失败保留重试 + 显示"未能提交，请点开始下一组"。
- 验证：开语音 → 完成一组进休息 → 连续说话占住识别，观察倒计时是否停在 00:00 超过 3 秒；再断网重复。
- 工作量：M

## D6 · `completionChime()` 每组新建 AudioContext 且从不关闭 · M · ✅已修 2026-11-09

- 证据：`public/index.html:79-80` `new AudioContext()` 无 `close()`；调用点 `:141`、`:147`。
- 后果：5 动作 ×3 组 = 15 个上下文；iOS Safari（上限 4）与部分安卓 WebView 超限后新建/播放静默失败（`catch{}` 吞掉）→ 后期提示音消失，可能连带影响 TTS 输出。
- 修法：模块级单例 AudioContext 复用（`resume()`），或播完 `close()`。
- 验证：连续完成 6 组以上，对比第 1 组与第 6 组是否还有提示音。
- 工作量：S

## D7 · 网络 TTS：无超时、无 abort、`stop()` 不回收 blob URL · N · ✅已修 2026-11-09

- 证据：`public/index.html:429` fetch 无 signal；`:445` `stop()` 只 `pause()` + `removeAttribute('src')`，无 `revokeObjectURL`。
- 后果：TTS 上游慢时 `voiceState` 停在 `processing`，`scheduleAutoListen` 一直被推迟 → 这段时间用户说话没反应；每次被打断的播报留一个未释放 blob URL。
- 修法：TTS fetch 加 `AbortSignal.timeout(8000)`；`stop()` 里 revoke 并保存 url；超时回退本地 TTS。
- 验证：DevTools 限速 `/api/voice/tts` 到 30s，看"正在处理…"是否持续、自动聆听是否失效。
- 工作量：S

## D8 · 无 coach 回退话术把时长型动作播成"建议 300 次"，且整句远超 30 字 · N · ✅亲验 · ✅已修 2026-11-09

- 证据：`public/index.html:99` 用 `targetReps.match(/\d+/g)` 取首个数字拼"建议 X 次"，`core.ts:138` 的 `原地快走` 是 `defaultReps:"300秒"`、`repOrTimeBased:"time"` → 播成"建议 300 次"；同句拼 `instructions[0]` + "做完后告诉我。"。实测量化见 A3（中位 95 字）。
- 后果：组内把"5 分钟"说成"300 次"是**播报剂量口径错误**；`index.html:100` 在无 coach 会话直接播，`:297`"再说一遍"也走这条。
- 修法：复用 `doseText()`/`formatDuration` 生成剂量短语；截断到首句，不拼 instructions。
- 验证：课程场次（未 enableCoach）或把 `workout.runtime.coach` 置空后听开场播报。
- 工作量：S

## D9 · `handleCoachInput` 在 `actionBusy` 时静默丢弃用户消息（输入框已先清空） · N · ✅已修 2026-11-09

- 证据：`public/index.html:358` `if(!message||actionBusy)return;`；调用方 `:345`/`:378` 先 `input.value=''`。
- 后果：慢网时用户打字提问，回车后输入框清空、消息不出现、无提示——用户以为发出去了，教练从未收到。
- 修法：`actionBusy` 时不清空输入框，或入队并提示"上一次操作还在提交"。
- 验证：DevTools 把 `/actions` 延迟 10s，点完成后立刻发消息，看是否消失。
- 工作量：S

## D10 · `perception-check`：`resumeIfAllowed()` 与手点 `start()` 竞态；无手势恢复会让页面假"监听中" · N · ✅已修 2026-11-09

- 证据：`public/perception-check.html:104-106` 先判 `$('live').hidden` 再 `await`，之后无条件 `start()` → 两路麦克风流、两个 interval（`:62` 覆盖 timer id、`:96` 只清最新）。
- 后果：连点/权限查询慢时出现重复事件、能量读数抖动；无手势 `ctx.resume()` 可能停在 suspended，界面显示"监听中"但基线恒 0 → 校准验收误判。
- 修法：`start()` 加互斥；`stop()` 统一释放所有 interval/handle；无手势恢复时显示"已暂停，请点开始"。
- 验证：打开页面 200ms 内连点两次"开始自检"，看日志是否翻倍；Console 查 `ctx.state`。
- 工作量：S

## D11 · 首页"结束这场，生成新计划"失败时提示落进隐藏容器 · N · ✅已修 2026-11-09

- 证据：`public/index.html:731` catch 写 `voiceCaption` → `voiceUI()` 的 home 分支指向 `#home-voice-status`（`:29`），该元素位于默认 `hidden` 的 `#intent-panel`（`:759`）内。
- 后果：断网时点这个破坏性按钮，卡片不动、无红字，用户反复点。
- 修法：失败写进 `#saved-workout` 内的 `.error`（或 alert），按钮呈现"重试"。
- 验证：挂一张未结束训练卡，Offline 后点该按钮，看有无提示。
- 工作量：S

## D12 · 无障碍硬伤：每次渲染丢焦点、选中态与倒计时对读屏不可见 · N · ✅已修 2026-11-09

- 证据：`public/index.html:597` `render()` 整屏 `innerHTML` 替换，不移动焦点；`:685/692` 筛选 `.active` 无 `aria-pressed`；`:571/579` `#seconds` 每秒改写无 `aria-live`。
- 后果：键盘用户每完成一组要从页首重新 Tab 穿越整页；读屏用户听不到休息剩余时间与筛选状态。
- 修法：`render()` 末尾聚焦该屏主按钮（或 `<h1 tabindex="-1">` + 礼貌播报）；筛选补 `aria-pressed`；倒计时 `aria-live="off"` + 每 30 秒播报。
- 验证：只用键盘完成两组，观察第一组后 Tab 落点；TalkBack 打开记录页筛选，听是否播报选中项。
- 工作量：M

---

# 建议执行顺序

**第 0 批 · 安全与铁律 —— ✅ 已全部完成 2026-11-09**
C5 → A2 → B6 → A1 → A3 → D2（顺带 D8，同一句前端模板）。回归：`npm test` **278 项 / 277 过 / 1 skip / 0 败**（连跑两次一致；原 272 项 +6）。验证方式见各条目；反向验收见 `journal/2026-11-09.md`。

**第 1 批 · 剂量与口径正确性 —— ✅ 已完成 2026-11-09（B10 除外，等时区裁决）**
B1 → B3 → B4 → B2 → B5 → B9 → B7 → B8 全部修完，各带回归；`npm test` **286 项 / 285 过 / 1 skip / 0 败**（连跑两次一致）。B1 的测试做过反向验证：临时回退两行 → assumed 8 次立刻变 `9-10`。

**第 2 批 · 数据完整性与稳定性 —— ✅ 已完成 2026-11-09**
C1 → C2 → A4/A5 → A6/A7 → C3/C4 → C6/C7。`npm test` **296 项 / 295 过 / 1 skip / 0 败**（连跑两次一致）。真库已由新迁移回填时间轴（66 会话从全 NULL → 0 NULL，`user_version` 仍 2）。A7 的白名单做过反向验证：两道都退回旧写法后测试立刻红。

**第 3 批 · 前端稳定性（M）—— ✅ 已完成 2026-11-09（D3/D4/D5/D6）**
D3（请求超时 + 忙时可见提示）→ D4（切后台不再丢响应）→ D5（休息到 0 不再卡）→ D6（提示音单例）。`npm test` **300 项 / 299 过 / 1 skip / 0 败**（连跑两次一致）。浏览器套件对比过：把 D3–D6 **全部退回**再跑，仍是 16 过 / 12 败且失败名单一致——本批没有让旧套件变差（11→12 的漂移来自第 0 批改掉 D2 反问，旧套件还在断言旧文案）。

**第 4 批 · 剩余 N —— ✅ 已完成 2026-11-09（14 条）**
A8 · A9 · B11 · B12 · C8 · C9 · C10 · C11 · C12 · D7 · D9 · D10 · D11 · D12。`npm test` **306 项 / 305 过 / 1 skip / 0 败**（连跑两次一致）；浏览器套件反而从 16/12 回到 **17 过 / 11 败**。真机复跑实测：畸形 JSON 现在回 400（原来 500）。

**✅ 46 条全部清零（2026-11-09）**。最后三条由 owner 当日裁决：**D22** 报数=可选功能（报了就记 counted）、**D23** 日/周边界用服务器本地时区、**D24** 课程场次 `dataOrigin` 缺省 `human`。裁决原文与取舍见 `../../TrainMind-智能性重设计提案.md`。`npm test` **310 项 / 309 过 / 1 skip / 0 败**（连跑两次一致）。

**需要 owner 裁决才能动的**：D1（报数交互存废）、B10（时区来源）、A10（`dataOrigin` 缺省值是否该是 `human`）。
**仍等外部条件的**（不在本清单内，见 PROGRESS §5）：M4 第二次喊停三选一（等 D21）、感知阈值与 H6 0.45 阈值的真机校准、组内命令词识别率实测、后台推送。
