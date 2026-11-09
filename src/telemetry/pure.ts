// 纯函数规则模块:episode 计算 / 状态感知 interruption / rest 语义(规格 §5、附录 A #2/#3)

import { RUNTIME_AUTO_TRANSITION_DEADLINES, type WorkoutRuntimeState } from './types.ts';

/**
 * manualInteractionEpisodeCount(规格 §5):
 * touch 事件按时间升序,相邻间隔 ≤ EPISODE_GAP_MS 的连续段各算 1 个 episode;
 * 单次 tap = 1;拿起手机连点 3 下放下 = 1。
 * 注意:这是可校准 heuristic,不等同真实 pickup(真实 pickup 以观察员记录为准)。
 * 输入必须已升序排列(由调用方从 ORDER BY 查询保证)。
 */
export function computeManualEpisodes(touchTimesAsc: readonly number[], gapMs: number): number {
  if (touchTimesAsc.length === 0) return 0;
  let episodes = 1;
  for (let i = 1; i < touchTimesAsc.length; i++) {
    if (touchTimesAsc[i]! - touchTimesAsc[i - 1]! > gapMs) episodes++;
  }
  return episodes;
}

/**
 * runtimeInterruption 状态感知判定(规格 §5 + 附录 A #2):
 * 仅当当前状态存在 expected auto-transition(RUNTIME_AUTO_TRANSITION_DEADLINES)
 * 且停滞严格超过该状态 deadline 才计 interruption;
 * 等待用户主动输入的状态(post_set 等反馈 / paused / in_set_counting 用户说话)
 * 没有登记 deadline → 永不计("AI 问完用户思考 5 秒"是合法等待)。
 */
export function interruptionOverdue(state: WorkoutRuntimeState, stalledMs: number): boolean {
  const deadline = RUNTIME_AUTO_TRANSITION_DEADLINES[state];
  return deadline !== undefined && stalledMs > deadline;
}

/**
 * actualRestAfterSeconds 语义(规格 §3 注释 + 附录 A #3):
 * = 本组 completedAt → 下一个 work interval 实际开始时间(秒,四舍五入)。
 * 无后续训练(会话完成/中止)→ null;绝不度量到 workout/session summary 完成时刻。
 */
export function restAfterSeconds(
  completedAt: number | null,
  nextWorkIntervalStartedAt: number | null,
): number | null {
  if (completedAt === null || nextWorkIntervalStartedAt === null) return null;
  return Math.round((nextWorkIntervalStartedAt - completedAt) / 1000);
}
