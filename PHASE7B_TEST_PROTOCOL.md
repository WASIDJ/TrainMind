# Phase 7B — 真机单场验证协议(7B.2 遥测集成 + 7.3 首轮实测)

> **状态(2026-10-19 第三轮 owner 裁决)**:7B.2.1 ACCEPTED,**停止所有开发**。
> 本文档即 7B.3 执行契约。两条硬纪律:
> ① **禁止边测边修**——测试中发现的问题只记录,不现场修改代码;第 7 分钟产品失败就记"第 7 分钟,它失败了",不救场。
> ② **自然说话,不配合系统**——不说标准口令("太重"),自然说("有点重");不照词表换动作("这个有人在用了")。
> 从此刻起,单测全绿只证明系统按预期工作;"好不好用"只由真机用户行为回答。
> pre_set 的 12s TTS 宽限:owner 已接受为**首轮临时规则**(保持 SPEC_NOTE,不固化为长期产品规则;窗口合理性由本场真机数据裁决)。

日期:2026-10-19。设备:OPPO Reno 14(USB 转发,沿用 PHASE7B_MOBILE_VALIDATION.md §3 步骤)。
前置状态:Phase 7B.1 稳定性修复已回归通过;**SetRecord v2 / Telemetry Foundation 已验收**(src/telemetry/,37 项遥测测试 + 全量 166 项;跨表 seq 分配器 / golden 链路全绿;SPEC_NOTE-1 裁决:setRecordId 保持 nullable)。
本文状态:**设计定稿,7B.2 未实施,7B.3 未开始。** 本文不含任何实测结论。

## 0. 本轮要回答的唯一问题

> **用户只负责训练和说话,TrainMind 能不能独立把一整场 20–30 分钟训练带完?**

不是"能不能说话",不是"识别率多少"。判读只看 §4 报告卡:不用拿手机或只拿 1–3 次、四类调整全部成功、节奏无实质打断。

## 1. 7B.2 集成清单(实测的前置代码工作)

### 1.0 实施结果(2026-10-19,owner 四项裁决后完工)

**裁决**:GAP-1 ✅ 补 `voice.command.pain_report` · GAP-2 ✅ 补全部真实按钮 · C1 ✅ 最小实现 · C2 ✅ 最小实现(复用 durationBreakdown)。
范围锁定:遥测接线 + 四项 + HTTP E2E,**做完即停**。实施交付:

- 新增 `src/telemetry/bridge.ts`(RuntimeTelemetry,482 行):/actions 服务端拦截 + 前端 source 标注(voice/touch/auto,auto 仅传输层);词汇与映射遗规格附录 B
- C1/C2 落地:`parseCoachReport` 新增 substitute/time_constraint 模式;`handleCoachEvent` 新分支;`shortenRemainingWorkout()`(从末尾丢动作、当前组保底 1 组、只削减未开始 workload、放松全额保留)
- 事务:recorder/store 改 SAVEPOINT 可重入事务 —— 遥测与域动作**同事务提交**(seq 分配器不变量加强)
- 测试:全量 183 tests / 182 pass / 1 skip(既有基线);新增 e2e(12 交互 + 5 调整链 + 链路校验空)、coach-command 12 项、bridge 4 项

**W1–W10 状态与偏差(重要)**:

| # | 状态 | 说明/偏差 |
|---|---|---|
| W1/W2/W3/W4/W5/W8 | ✅ | e2e 已证:feedback/adjust/pain/pause/resume/replace/按钮链 + target 快照 + rest 惰性回填(换动作/跳过/疼痛全转移类型覆盖) |
| W6 | ⚠️ 部分 | 仅接 `/api/voice/transcribe` 422(本地引擎无清晰语音,Windows);前端 <0.45 低置信度转文字框是**确认流非重试**,不计 asr_retry(设计知会) |
| W7 | ❌ 未接 | interruption 状态机检查点未实施:当前 runtime 休息/热身/放松均为定时器自动推进(不会停滞),pre_set 无定时器无检查点可挂;**首轮 runtimeInterruptionCount 自动指标恒 0,中断证据以观察员记录为准**(协议 §2.3 已强制)。后续如需自动指标,需单独设计停滞检测,另议 |
| W9 | ✅ | `system.autostart.rest_end`(定时器)+ `.next_set`(coach_event 流);warmup_end/cooldown_end 同族补齐(附录 B.2) |
| W10 | ⚠️ 改道 | 不写 workout_sessions 的 v2 列(ended_at/status 与 legacy 共享列枚举冲突);时长由 summary 的 data_json 兑底解析,e2e 已证非空 |

另:真人 dataOrigin=human 修正未在本轮(需前端“生成计划”入口带真实来源标记,属产品行为变更,超出“纯接线”范围);首轮用独立 userId 区分样本,报告卡记 dataOrigin 观察值。

**观察员须知(新)**:域层规范触发词为“**太重**”;“有点重”会触发教练追问循环(产品既定行为,非遥测缺陷);设备/换动作口令已路由为独立命令(不再落入自由对话)。

以下为实施前的原始清单(保留作对照):

遥测层已就绪但**尚未接入 runtime**——不接线,报告卡里的自动指标全部为空。分两类:纯接线(不改产品行为)与能力补齐(需裁决)。

### 1.1 纯接线映射表(已核对 /actions switch、parseCoachReport、handleCoachEvent 实际代码)

| # | 现有入口 | v2 写入链 |
|---|---|---|
| W1 | `coach_message` → too_heavy / too_light / right | `user/voice voice.command.feedback.hard/.easy/.just_right`(success、transcript、latency=识别往返)+ SetFeedback(source=voice)+ **AdaptationEvent(weight_change,deltas 取自既有 coach_adjustment 事件的 before/after)**→ markApplied |
| W2 | `coach_message` → 做完 + 实际次数/重量 | `user/voice voice.command.adjust`(intent='report.actual')+ finalizeSet(actualReps/actualWeight) |
| W3 | `coach_message` → 疼痛 | 见 §1.3 GAP-1;SetFeedback(pain)+ AdaptationEvent(safety_stop,reason=pain_reported)→ markApplied + `system/system.safety.trigger` |
| W4 | `actions: pause / resume`(按钮) | `user/touch touch.button.pause / .resume` |
| W5 | `actions: replace`(按钮) | `user/touch touch.button.substitute_confirm` + AdaptationEvent(exercise_substitution) |
| W6 | 识别失败重试 | `system/voice voice.asr_retry`(前端识别管道失败/低置信度点) |
| W7 | runtime 状态机 | 转移检查点调 `interruptionOverdue(state, stalledMs)`(runtime 已有 restEndsAt/phaseEndsAt,可直接算停滞)→ `system.interruption.{ui,voice,error,safety}` |
| W8 | 组完成事实(markSetComplete / submitSetFeedback) | SetRecord v2:处方 target 快照 + actuals;actualRestAfterSeconds 在下一 work interval 开始时回填(用 `restAfterSeconds()`,会话结束=null) |
| W9 | 自动流转(休息结束/下一组自动) | `system/system system.autostant.rest_end / .next_set` |
| W10 | 会话开始/结束 | workout_sessions 行已由域层创建(migrateTelemetry 自动补 next_event_seq);结束时补 ended_at(status 由域层写) |

### 1.2 词汇表缺口(需规格 owner 裁决;计数规则与验收标准均不变,仅补 action 字符串)

- **GAP-1 疼痛话语**:方案 A 记 `voice.command.query` + intent='pain.report'(零规格改动,但语义牵强);方案 B 补 `voice.command.pain_report`(计入 voiceCommandCount ✓,语义干净)。**推荐 B。**
- **GAP-2 UI 按钮补齐**:冻结词汇表只覆盖 feedback 三档 / skip_rest / pause / resume / substitute_confirm;现有 UI 还有 start、complete_set、skip、extend_rest、abort。**不补会导致 manualAction 漏计 → hands-free 指标虚好 → 假阳性**,这是本轮测试最不能接受的失真。建议补 `touch.button.start / .complete_set / .skip_exercise / .extend_rest / .abort`。

### 1.3 能力缺口(五场景中有两个语音路径未实现,需裁决)

| 缺口 | 现状(已核实) | 选项 | 建议 |
|---|---|---|---|
| **C1 语音换动作** | parseCoachReport 不识别"器械有人";replace 仅按钮 | (i) 加识别模式 → replaceExercise(reason=equipment_unavailable) → voice.command.substitute + exercise_substitution;(ii) 首轮用按钮触发(计 touch,损伤 hands-free 数据) | **(i)**,工作量小(golden 已证明 substitution 链路,只差一个 regex) |
| **C2 语音缩短** | "只剩10分钟"无任何路径 | (i) 最小实现:识别时间约束 → 当前动作完成后截断后续动作、重算 durationBreakdown → workout_shorten(reason=time_constraint);(ii) 首轮降级:如实记录"未支持"(预期用户被迫拿手机或放弃),报告卡记 NS | **(i)**,"今天只有30分钟"是核心产品叙事;工作量中等,由 owner 定 |
| C3 语音结束/延长休息(非五场景必需) | parseCoachReport 无对应模式 | 记录在案,不阻塞首轮 | 首轮按钮兜底 |

另:7B 文档已列"真人默认 dataOrigin=demo、默认 userId"限制 —— 7B.2 顺手修正(独立 userId + human 标记),否则实测样本无法与 demo 区分。

### 1.3c 7B.2.3 语音链路重构 + 教练人格层(2026-10-21,owner 真机两轮反馈后)

**语音链路(D10)**:安卓 Chrome 网页语音识别依赖 Google 云端,国内网络会话启动但永不返回("聋场")。重构为:手机 getUserMedia 录音 → USB → Mac 本地 whisper 常驻服务(tools/stt-sidecar.py,端口 8765,server 自动 spawn)→ 文本。端到端逐字验证通过("有点重,做完了,实际8次")。前端经 /api/voice/status 自动走录音上传路径,零 Google 依赖。体验变化:说完停顿 ~2s 出结果(utterance 级)。

**教练人格层(D11,Bloom 移植)**:规则层决定"做什么",LLM(deepseek-flash,2.5s 硬超时)只改写"怎么说"。四个槽位(组开场/反馈回应/完成确认/休息过渡);医学红旗词表命中 → 固定安全话术,永不经 LLM;输出守卫(≤80字/禁语/数字核验)不达标 → 整句回退模板。实测叙事延迟 0.3s。开关 TRAINMIND_NARRATION=1(start-7b3.sh),缺省关。设计文档:《trainmind-教练人格层设计.md》。

**其他修复**(owner 第二轮反馈):报数/播报数字全部转中文数字(修神经 TTS 读裸数字的怪音);徒手动作问"轻松、合适还是吃力";开场白精简+去 3 行截断;计数圈改真进度环(报数逐格填充,休息屏倒计时环);滑动 ≥85% 才算完成(轻点回弹);报数到目标播"叮咚"音效+轻文案,不再口播追问;首页场景化听写文案;麦克风聋场看门狗(12s 刷新×3)。

**测试**:205 tests / 204 pass / 1 skip / 0 fail(新增 narration 8 项:槽位/守卫/红旗/记忆/回退矩阵/遥测)。规格附录 B.6 增补 coach.narration 词汇。

### 1.3f D16-B 跨动作 Agency(2026-10-26 夜,owner 裁决"直接上B")

背景:P0 审计发现居家计划全单组 → 同组 agency 触发面≈0(owner 体感"没区别"的根因)。
实施:
1. **触发**:吃力反馈在动作末组 + 休息已指向下一动作(非时间型/非mobility)→ 跨动作三选一
2. **三选一**:next_down(下一动作降一档,到期默认)/stay(原计划)/skip_next(砍掉下一动作,休息保留);口语 scope 感知(轻一点/按原计划/少练一个)
3. **遥测**:interaction 从域事件 coach_agency_choice 取真值(修「轻一点」被记成 feedback.hard 的失真);ADP 新鲜度全局检查(修跨动作 offer 提前返回后捡陈旧剂量事件重复记账——B 之前被巧合掩盖的真 bug);skip_next → exercise_skip ADP
4. 前端:休息屏跨动作卡片(下一个轻一点/按原计划/少练一个);识别上传 12s 超时+中文报错;麦克风失败提示指名 Chrome;叙事守卫"本动作完成不得提下一组"
测试:216/215/1skip(6 新跨动作测试+金样本更新:序列+system.autostart.agency_default+适应链语义);实弹全矩阵:单组吃力→offer→语音 next_down→链式 offer→卡片 stay→遥测双通道 ✓

**遗留系统性问题(审计发现,待 owner 后续裁决)**:
- 计划生成器居家路径残缺:generateWorkout 上下文只有 chest 能出计划且单动作;HTTP 预览(解释器路径)才有 7 动作计划
- 居家自重动作 defaultSets=1(单组刺激不足;owner D16 未选 A 方案,如需另议)

### 1.3e P0 智能性重设计落地(2026-10-26,D13/D14/D15)

依据:三目标逆向(reverse-lab/)+ owner 两轮裁决。实施:
1. **透明推理层**:剂量决策 evidence(目标/重量/实际次数/原话)注入叙事提示词【本组依据】;人设硬约束"禁因果句式,依据织入语气"(owner 语感裁决)
2. **Agency 三选一**:吃力反馈 → agency_offer(不再自动降档);三选项=降档(基准=报告实重)/硬扛(目标=实际次数)/讨价(次数-2);卡片(休息屏)+口语(共享 agencyChoiceFromSpeech)+到期默认(resetCoachForSet 静默降档);选择入域事件(风格统计源)
3. **风格统计管线**:近10次选择+完成率 → stylePreset 七画像(含激将证据门槛)注入人设【学员风格】
4. 遥测:voice.command.agency/touch.button.agency_choice/system.autostart.agency_default + before.eventCount(ADP 新鲜度);规格附录 B.7
5. 修复实施中发现的 bug:agency 剂量基准漏传报告实重(金样本抓出)
测试:210/209 pass/1 skip(金样本 e2e 更新:agency 交互入序列,voiceCommandCount 5→6);实弹:开场白/agency/hold_on 剂量落地/遥测全链路 ✓(真 LLM,0.4s/次)

### 1.3d 7B.2.4 第三轮真机反馈修复(2026-10-21,六项)

owner 六项反馈,全部定位到根因并修复+实弹验证:

1. **语音无回显** → listenOffline 加录音计时("正在听 N 秒")+识别完成即时回显("听到:「…」")。附带发现:owner 的"肩膀有点酸"实际已听到并解析(safetyNotes 证据),但( a )部位枚举泄露英文("shoulder部酸痛"),(b)计划页不显示——用户无从知道系统收到了。已中文化并在计划页亮出("已注意你的身体状态")。
2. **暂停屏空白圈+Ⅱ字形** → 显示真实本组进度( X/Y + 弧保留)。
3. **自重动作标 0 公斤** → 根因:推荐引擎给自重动作 weightKg=0;域层归一 0→undefined(顺带修复潜伏剂量 bug:0 会走重量路径算出"下一组 0 公斤");server/narration/前端三处统一 truthy 语义。
4. **暂停→继续清进度+重播开场白** → 前端每次重渲染都重播;改为仅"新组"播报(isNewSet 判定),进度环公式保留 guideRepCount。
5. **"Bloom 的东西没看到"** → 人格层实际在跑,但两次被数字守卫打回模板(遥测 coach.narration.fallback code=number):模板含"0 公斤",LLM 拒说 0(改说自重),守卫要求数字一字不差→回退。0kg 修复后实弹:开场白叙事成功(0.4s,含记忆引用),number 回退 0 条。守卫经受住了第一次真实考验(宁回退不放错数字)。
6. **结束训练后记录缺失** → 数据一直在(training_records 有行、2 组 8 次都在),UI 只显示 status=completed;改为"完成场+有完成组的提前结束场"都显示(标"提前结束")并计入本周次数/时长。

测试:207 tests / 206 pass / 1 skip / 0 fail(新增 core 2 项:0kg 归一/酸痛中文化)。

### 1.3b 7B.2.1 补洞(owner 验收意见,2026-10-19 第二轮:功能链路通过,先补 3 洞再上 OPPO)

**原则:最怕"用户真的遇到问题,但数据记录成 0 问题"。产品应该理解用户,不是用户学习产品语法。**

| # | 修复 | 实现 | 验收 |
|---|---|---|---|
| 1 | "有点重"等自然表达直接归一 hard(P0) | parse 词表扩:太重了/有点重/有些重/感觉重了/这个重量有点吃力/轻一点(+too_light 镜像:有点轻/有些轻/感觉轻/太轻松/重一点);前端 mvp 路由与分类器同步扩词 | **PASS**(12 短语矩阵 + handleCoachMessage 一轮直落 record+dose 无追问 + e2e S1 全链路用"有点重") |
| 2 | 浏览器 ASR 失败 → voice.asr_retry(W6) | 前端 `asrRetryTelemetry()` 接 SpeechRecognition onerror(除 aborted)与麦克风启动失败;离线转写非 422 失败(422 已由服务端记录,防双计);新端点 POST /api/voice/asr_retry{userId,reason};error.code 记细因(asr_no_speech/asr_network/...)计数不受影响 | **PASS**(e2e S4b:HTTP 上报 → voice.asr_retry 行 + summary voiceAsrRetryCount=1) |
| 3 | interruption 检查点(W7,pre_set/resting/transition) | server 在 switch 前捕获动作前快照;bridge 转移检查点判定:仅三状态超期才计 system.interruption.{voice(口令抵达)/ui(按钮)/error(定时器/叙事流自恢复)};pre_set 在冻结 3s 上加 12s TTS 播报宽限(否则每组必误报,SPEC_NOTE 已录);post_set/paused/in_set 永不计 | **PASS**(注入超期 7 项:resting 60s→ui/voice、transition 60s、pre_set 60s、1s 宽限不误报、8s 播报窗不误报、post_set 永不计) |
| 4 | C2 硬边界 | 不改实现,补行为断言:projectedRemainingSeconds ≤ 用户预算秒数;预算低于安全下限(1 组+放松)时如实报"超出"并保底 | **PASS**(10 分钟→480s≤600s;1 分钟→保底+如实超出,e2e 同步断言) |

**7B.2.1 验收(owner 指定格式)**:
```text
full tests: PASS (194 tests / 193 pass / 1 skip / 0 fail)
"有点重": PASS
browser ASR retry telemetry: PASS
runtime interruption injected timeout: PASS
10-minute shorten hard bound: PASS
```
W6/W7 状态由 ⚠️/❌ 升为 ✅(W7 限于三状态检查点;无动作抵达的完全静默仍不可测,属已知边界,观察员兜底)。

**停点:开发到此为止,直接上 OPPO Reno 14。下一阶段的问题只能由真机用户回答,不再用代码猜体验。**

### 1.4 7B.2 验收标准

新增 e2e(复用 frontend.test.ts 的 spawn 模式,**走真实 HTTP API,禁止 test-only 分支**):
创建计划 → start → complete_set → `coach_message`"太重了,实际8次" → 断言:
1. v2 事件链:`voice.command.feedback.hard`(user/voice)→ SetFeedback(hard, voice)→ AdaptationEvent(weight_change, applied)→ 下一组 SetRecord target 快照变化
2. summary 计数正确;`validateSessionChain` = []
3. 既有 166 项回归零破坏

**验收结果(2026-10-19):全部通过。**实际 e2e(`test/telemetry/e2e-wiring.test.ts`)覆盖更宽:
plan 触点 → start → 语音报告(含重量)→ 按钮 rest → 按钮 complete+hard(带重量)→ 定时器 rest → C1 替换 → C2 压缩 → 疼痛 → 语音结束;断言 12 条交互的**精确动作序列**(touch.button.plan_move/start/skip_rest/complete_set/feedback_hard + voice.command.adjust/substitute/time_constraint/pain_report/finish + system.autostart.rest_end/safety.trigger)、5 条调整链全 applied、共享 seq 1..16 跨表无空洞、set 快照递减、rest 回填非空/末组 null、疼痛 failed 行(severity=3, location=knee)、被丢实例 skipped、`validateSessionChain=[]`、summary(manual=5, voice=5, interruption=0, duration 非空)。
回归:全量 183 tests / 182 pass / 1 skip(既有基线;两处旧断言按已冻结的双形状设计修正:set_records 按 legacy/v2 分别计数;VM 沙箱补 userId 页面全局)。

## 2. 7B.3 首轮真机协议(OPPO Reno 14,单场)

### 2.0 本轮观察焦点(owner 定,优先级即排序)

> 7B.2.3 后追加第 6 条:**教练话术质量**(叙事层):开场白/反馈回应是否"像看着你说的话"(引用组次/动作/上次反馈=好;复述模板感=差);红旗测试(说"有点头晕")是否立即叫停;若某次话术明显回到模板(=LLM 回退),记时间点供事后查 coach.narration.fallback 遥测。

1. **手机拿起次数**——第一指标,不是识别准确率。
2. **每次拿手机的原因**——区分(映射到冻结 PickupReasonCode,细分写 note 自由文本):
   | 用户情形 | reason 码 | note 要写 |
   |---|---|---|
   | 没听懂(识别错/没识别) | `asr_misheard` | 说了什么、系统听到什么 |
   | 没声音(AI 无反应/无声) | `voice_failed` | 卡在哪个环节 |
   | 不知道现在该干嘛 | `other` | **无专属码(冻结词表粒度边界)**,note 必写"confusion" |
   | 想确认下一组/进度 | `curiosity_check` | 确认了什么 |
   | UI 强迫操作(必须点) | `ui_required` | 哪个按钮 |
   | 单纯不放心看一眼 | `curiosity_check` | note 区分"主动确认"vs"不信任" |
   curiosity_check 频率 = 信任度信号:用户一直忍不住看屏 = 还没真正信任这个教练。
3. **训练节奏连续性**——理想链:做完→AI 及时问→回答→调整→休息→下一组;
   失败链:做完→等→不知道有没有听见→看手机→再说一次(哪怕 adjustment 最终正确,体验仍失败)。timeline 的 seq 连续性+时间戳间隔是客观证据。
4. **四种动态变化各由一句话解决**(不进任何编辑页面):"有点重"→降重量;"这个器械有人"→替换;"我只剩10分钟"→压缩;"膝盖有点疼"→Safety 接管。
5. **收尾主观题**(报告卡必答,口述记录):**如果没有 TrainMind,这场训练会更舒服,还是用了 TrainMind 更舒服?**
   ——核心假设从来不是减少点击,是"让训练没那么痛苦,让训练时间感觉过得更快"。Hands-Free 是手段,不是价值。

**已知词表边界(出发前坦白,不修,让数据说话)**:替换口令的词表含"器械有人/被占/占用/占着/用不了/不能用/不行/换一个/换个动作/这个做不了";
**不含无"器械"字样的"这个有人在用了"**——若测试者自然这么说而未触发替换,那是真实的自然语言覆盖发现,按失败记录,不现场修。

### 2.1 前置
- 7B.2 全部完成并回归绿;USB 转发 + `isSecureContext` 核对(沿用 7B 文档 §3)
- 独立训练者 ID(如 `oppo-reno14-p7b01`),dataOrigin=human
- 耳机轮先跑;外放回声单独观察(沿用 7B 文档轮次划分,本轮先耳机)
- 观察员 1 名,只记录不教学;产品引导话术沿用 7B 文档(代读须标记"人工引导")

### 2.2 场景时序(20–30 分钟;组数按当日真实处方,触发点相对位置固定)

| 阶段 | 位置 | 用户行为 | 预期系统行为 | 采集断言 |
|---|---|---|---|---|
| S0 | 开场 | 按钮"开始训练"(产品唯一启动路径;语音启动不在 C1-C2 裁决内) | 教练开场,播报第一组 | touch.button.start;麦克风授权无卡顿 |
| S1 基线 | 组1 | 正常做完:语音"做完了,实际8次,刚好" | 记录 + just_right,无调整 | feedback.just_right;SetRecord actuals |
| S2 太重 | 组2 反馈时 | "太重了"(规范触发词;**注意"有点重"会触发教练追问循环**——追问后按提示说"太重"属正常链路) | -10% 剂量调整并播报建议(无合法杠铃片时回退调次数,e2e 已证两种部会各自成链) | weight_change/rep_change applied;**组3 target 快照变化** |
| S3 器械占用 | 组3 前/休息中 | "器械有人,换一个"(已路由为独立命令;休息中说会得到"动作进行时才能换"的语音引导,属预期) | 换动作并说明理由(C1) | exercise_substitution applied;新实例;被换实例 substituted |
| S4 ASR 失败 | 组4 反馈时 | 故意含糊/轻声 | 识别失败 → 重试提示 → 用户重复 | ⚠️ 手机浏览器 ASR 路径的失败**不落 asr_retry**(W6 只接了服务端本地引擎 422;浏览器识别失败需前端钩子,未在本轮范围)→ 本场以**观察员 asr_misheard 计数 + 后续命令成功链**为证据;asr_retry 自动指标预期恒 0 |
| S5 缩短 | 组4 后 | "我只剩10分钟" | 截断后续并说明(C2;末尾丢动作、当前组保底) | workout_shorten applied;被丢实例 skipped;实际结束时间符合 |
| S6 疼痛 | 倒数动作、静止口述 | "膝盖疼"(不诱发真实疼痛) | Safety Gate 立即停止 | voice.command.pain_report + safety_stop applied + system.safety.trigger;failed 行 severity=3 location=knee;不再继续该动作 |
| S7 结束 | 收尾 | 语音"结束训练"或按钮 | abort 如实标记,不包装为完成 | voice.command.finish / touch.button.abort;会话结束;末组 rest=null;summary 落库 |

注:疼痛在当前实现是**终态**(safetyStopped 后只能结束),故排在 S6;C1/C2 均已实现,S3/S5 不会记 NS。W7(interruption 自动检测)未接 → runtimeInterruptionCount 恒 0,中断证据以观察员记录为准。

### 2.3 观察员规则(沿用 7B 文档既有定义)
主动拿起一次计一次;看屏/点击分别计数,不合并;每次 pickup 记受控原因码(voice_failed / asr_misheard / ui_required / curiosity_check / notification / other);观察者介入单列,不算产品能力。结束后立即用 `attachObserverRecord` 落库。

### 2.4 数据提取(测试后即刻执行,电脑端;已干跑验证)

只读提取(node -e 下参数是 argv[1]):
```bash
cd TrainMind && node -e "
import('./src/telemetry/index.ts').then(m => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync('trainmind.db', { readOnly: true });
  const id = process.argv[1]; // 会话 ID
  console.log(m.renderTimeline(m.replayTimeline(db, id)));
  console.log(JSON.stringify(m.deriveSummary(db, id), null, 2));
  console.log('chain issues:', JSON.stringify(m.validateSessionChain(db, id)));
  console.log('observer:', JSON.stringify(db.prepare('SELECT * FROM observer_records WHERE session_id=?').get(id)));
});" <sessionId>
```

观察员记录落库(测试结束立刻,attachObserverRecord 为冻结 §6 接口):
```bash
cd TrainMind && node -e "
import('./src/telemetry/index.ts').then(m => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync('trainmind.db');
  const rec = { sessionId: process.argv[1], recordedBy: 'observer-姓名',
    phonePickupCount: N, screenGlanceCount: M /*观察不到填 null*/,
    observerInterventionCount: K,
    pickups: [{ atSec: 125, reason: 'asr_misheard', note: '说了X,系统听到Y' }] };
  new m.SqliteTelemetryRecorder(db).attachObserverRecord(rec);
  console.log('observer record saved');
});" <sessionId>
```

**7B.3 交付清单(owner 指定)**:① 完整 observer record(每次 pickup 的时间点+原因码+note);
② telemetry summary(manualAction/voiceCommand/asrRetry/interruption/duration);
③ 事件 timeline(按 seq,含语音原文与调整链);
④ 四类动态调整结果(降重量/替换/压缩/Safety,各一句话触发、是否 applied、是否进过编辑页面);
⑤ 全部 phone pickup 原因汇总;
⑥ §2.0 第 5 条主观题的口述记录原文。发现的问题只记录不修。

## 3. 报告卡(每场一张;自动指标来源已标注)

```text
Session: <id>  训练者: <userId>  时长: <mm:ss>
────────────────────────────────────────
Workout completed?        YES / NO   ← WorkoutSession.status(completed/aborted 如实)
Phone pickups             ?          ← observer_records(人工)
Manual episodes           ?          ← summary(自动)
Manual actions            ?          ← summary(自动)
Voice commands            ?          ← summary(自动)
Voice retries             ?          ← summary(自动 = clarification + asr)
Runtime interruptions     ?          ← summary(自动,按类分桶)
────────────────────────────────────────
太重调整成功              YES / NO   ← weight_change applied + 下一组 target 快照
器械替换成功              YES / NO   ← exercise_substitution applied
疼痛处理正确              YES / NO   ← safety_stop applied + 不再继续该动作
缩短时间成功              YES / NO / NS ← workout_shorten applied(或如实记 NS)
────────────────────────────────────────
事件链完整性 validateSessionChain = [](必须为空,否则本场数据不可信)
每类 pickup 原因分布 + 访谈三问(哪步最想拿手机/是否被打断/明天还用吗)
```

## 4. 通过标准与判读纪律

**通过** = Phone pickups ≤ 3 且 四项调整 YES(NS 按未通过计)且 interruptions 未造成实质节奏破坏(分类计数 + 访谈印证)且链路校验为空。
任一不满足 → 如实记录,不美化;识别"未测"≠ 0 次 ≠ 失败 ≠ 通过(沿用 7B 文档纪律)。
**本场结果只回答"Workout Runtime 方向是否可能成立",不外推为产品结论。**
§2.0 第 5 条主观题("没有 TrainMind 是否更舒服")为**必答记录项,不计入通过门槛**——首轮价值在留下原文,供与后续场次对照;核心假设(训练不那么痛苦、时间感觉过得快)由多轮真机数据回答,不由一场判定。
