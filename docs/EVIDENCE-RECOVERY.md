# 恢复与剂量：我们的主张、依据、以及哪里是"我们拍的"

> 目的：对外讲这套算法时**每句话都有出处**，同时明确区分"文献支持"和"经验值"。
> 核实方式：Europe PMC 公开 API（`https://www.ebi.ac.uk/europepmc/webservices/rest/search`），取标题/期刊/DOI/摘要。
> 核实时间：2026-11-10。

## 一、逐条对照

| # | 我们的主张 | 依据 | 用到代码哪一步 | 强度 |
|---|---|---|---|---|
| 1 | 抗阻训练后同一肌群需要约 **48–72 小时**才能再次高强度训练 | Schoenfeld BJ. *The mechanisms of muscle hypertrophy and their application to resistance training.* J Strength Cond Res. 2010;24(10):2857-72. DOI `10.1519/JSC.0b013e3181e840f3`（机制综述，被广泛沿用） | `src/muscles.ts` 的 `recoveryHours` 基础值 | **中**：这是机制综述的普遍表述，不是精确实验测定 |
| 2 | **训练频率**（每周同一肌群 2–3 次）比"必须等满 N 小时"更能决定肌肥大 | Schoenfeld BJ, Ogborn D, Krieger JW. *Effects of Resistance Training Frequency on Measures of Muscle Hypertrophy: A Systematic Review and Meta-Analysis.* Sports Med. 2016. DOI `10.1007/s40279-016-0543-8`（已核实标题/期刊/DOI） | **已用上（2026-11-10，主口径）**：`src/muscles.ts` 的 `WEEKLY_FREQUENCY_TARGET`（每周 2–3 次）+ `sessions7d`；`src/core.ts` `generateWorkout` 里本周超过上限的部位不再加量（ruleId `muscle-weekly-frequency-v1`） | **较高**：系统综述 + meta 分析 |
| 3 | 让用户报 **RIR/RPE（还能做几个）** 比按时间推算更贴个体 | Zourdos MC, et al. *Novel Resistance Training-Specific Rating of Perceived Exertion Scale Measuring Repetitions in Reserve.* J Strength Cond Res. 2016. DOI `10.1519/JSC.0000000000001049`（已核实标题/期刊/DOI/摘要） | 部分已有：`targetRir` 在数据里但**不外露**；未接自报 | **较高**：方法学论文，已有后续验证 |
| 4 | 分肌群恢复窗口（腿 72h / 臀背胸 48h / 肩臂 36h / 核心小腿 24h） | **无文献支持，我们按常识拍的** | `MUSCLE_GROUPS`——**2026-11-10 起只作展示层的辅助提示**，不再决定排课 | **低**：方向合理，数值无出处 |
| 5 | 训练量系数（近 7 天每多 3 组，窗口 +25%，上限 1.5 倍） | **无文献支持，我们拍的** | `buildMuscleLedger` 里只影响展示层的 `recoveryHours`（窗口），不参与排课 | **无**：纯工程直觉 |

## 二、结论：哪些能对外说，哪些不能

**可以说**：
- "按训练量和时间估算恢复情况"（这是事实描述）
- "根据你说的酸痛调整"（这是我们的机制）
- "同一肌群每周 2–3 次是主流建议"（有 meta 分析支撑）

**不能说**：
- ❌ "科学算法精准计算恢复度" —— 第 4、5 条没有出处
- ❌ "精确到小时的恢复时间" —— 文献只给 48–72h 的粗区间
- ❌ 任何营销式承诺（"一定不受伤""一定进步"）

## 三、由此产生的三条产品决策

1. **展示层不再出现百分比与小时数**（已完成，`c933285`）。理由：数字会伪装精度。
2. **主约束从"按小时"改成"按周频次"**：同一肌群每周 2–3 次是主规则，小时数只作辅助提示。依据 #2。**已完成（2026-11-10，D34）**：排课按周频次收手，小时数只留在展示层。
3. **用户自报优先于估算**：用户说"腿还酸"，就覆盖算法结论。这是我方独有数据，比任何公式都准。

## 四、待核实清单（下一轮）

- [ ] Schoenfeld 2010 的 DOI 需再确认一次（本文按常见引用填写，未逐字比对）
- [ ] 找一篇**训练量-恢复**关系的实证研究，给第 5 条找替代依据；找不到就把系数删掉，改成"不做训练量修正"
- [ ] 补一条"睡眠不足对恢复的影响"的近期证据（若成立，可支撑对话收集睡眠）
- [ ] 明确 48–72h 的原始出处是否确实在 Schoenfeld 2010 正文中（而非后续二手转述）

## 五、纪律

**任何写进代码的数字，必须能回答"它从哪来"。**
答不出出处的，要么标明"经验值"，要么不用。这条适用于算法、阈值、话术里的每一个数。
