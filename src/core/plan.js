/**
 * 两街计划（翻牌 / 转牌）。
 *
 * 原来的决策只看"当前这一注值不值"，不往后看：牌力强但筹码堆不进去，
 * 转牌诈唬也不管这张牌帮没帮到对手。这里补三件事：
 *
 *   1. 等比尺度：既然打算在河牌把筹码打光，每条街就该下同样的底池比例 ——
 *      底池按 (1+2f) 的节奏涨，解 (1+2f)^n = 1 + 2*SPR 就得到 f。
 *   2. 打光判定：筹码/底池已经很低（<= COMMIT_SPR）时，强牌没有"下一注"
 *      的玩法了，直接全下，免得下 70% 剩个零头、河牌再尴尬。
 *   3. 转牌分类：转牌把同花/顺子做成了，对手的跟注范围立刻变强，
 *      这时诈唬该放弃，而不是照常开火。
 *
 * 翻牌/转牌的真求解试过并失败（子树叶节点只走一轮下注，对手范围收窄不足，
 * 模型收敛到"反正对手会弃牌"，见 TODO.md 文末）。所以这里走启发式。
 */

import { rankOf, suitOf } from './cards.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * 低于这个筹码/底池比：强牌直接打光，不再分街铺垫。
 * 再高就不合适了 —— 比如 2.2 倍池的全下等于一次超池下注，
 * 只有坚果才撑得起，强牌在那个深度用等比尺度分街更稳。
 */
export const COMMIT_SPR = 1.5;

/** 高于这个筹码/底池比：不做"三条街打光"的规划，沿用牌面尺度。 */
export const PLAN_MAX_SPR = 5.5;

/**
 * 每条街下底池的同一比例 f、连下 n 条街刚好打光时：
 *   f * P * (1 + (1+2f) + ... + (1+2f)^(n-1)) = SPR * P
 * 化简得 (1+2f)^n = 1 + 2*SPR，所以 f = ((1+2*SPR)^(1/n) - 1) / 2。
 */
export function geometricFraction(spr, streets) {
  if (!(spr > 0) || streets <= 0) return 0;
  return (Math.pow(1 + 2 * spr, 1 / streets) - 1) / 2;
}

/** 有效筹码：自己还在手里的筹码，和所有未弃牌对手里最少的那个取小。 */
export function effectiveStack(state, seatIdx) {
  const hero = state.seats[seatIdx];
  let smallest = hero?.stack ?? 0;
  for (const seat of state.seats) {
    if (seat.index === seatIdx) continue;
    if (!seat.inHand || seat.folded) continue;
    smallest = Math.min(smallest, seat.stack);
  }
  return Math.max(0, smallest);
}

/**
 * 这一注的尺度计划。
 *
 * textureFraction 是"按牌面选尺度"给出的底池比例；计划层只做两件事：
 *   - 在中等筹码深度里，把尺度抬到"等比打光"需要的水平（只抬不压，
 *     湿润面本来就算得大就保持不动）；
 *   - 标记这个局面是否已经到了"打光"的深度。
 */
export function streetPlan({ street, pot, stack, textureFraction }) {
  const spr = Math.max(0, stack) / Math.max(1, pot);
  const streets = street === 'turn' ? 2 : 3; // 含当前这一注
  const geometric = geometricFraction(spr, streets);
  const planned = Math.min(geometric, 1); // 计划层不引入超池，超池另有开关
  const committed = spr <= COMMIT_SPR;
  const fraction =
    spr <= PLAN_MAX_SPR ? clamp(Math.max(textureFraction, planned), 0.15, 1) : textureFraction;
  return { spr, fraction, geometric, commit: committed };
}

/** 牌面里同花的最高张数。 */
function maxSuitCount(cards) {
  const counts = [0, 0, 0, 0];
  for (const c of cards) counts[suitOf(c)] += 1;
  return Math.max(...counts);
}

/** 牌面里是否已经有四连张（任意四张点数跨度不超过 4，缺一张即成顺）。 */
function hasFourRun(cards) {
  const ranks = [...new Set(cards.map(rankOf))].sort((a, b) => a - b);
  if (ranks.length < 4) return false;
  for (let i = 0; i + 3 < ranks.length; i++) {
    if (ranks[i + 3] - ranks[i] <= 4) return true;
  }
  return false;
}

/**
 * 转牌的分类：
 *   completed —— 转牌让同花或顺子成立（听牌的人到了，跟注范围变强）
 *   overcard  —— 转牌是 Q 以上的大牌（通常对下注方的范围更有利）
 *   blank     —— 其余
 */
export function turnCardClass(flop, board) {
  if (!Array.isArray(flop) || !Array.isArray(board) || flop.length < 3 || board.length < 4) {
    return 'blank';
  }
  const flushCompleted = maxSuitCount(board) >= 3 && maxSuitCount(flop) < 3;
  const straightCompleted = hasFourRun(board);
  if (flushCompleted || straightCompleted) return 'completed';
  if (rankOf(board[board.length - 1]) >= 12) return 'overcard';
  return 'blank';
}

/**
 * 转牌诈唬的频率倍率。
 *
 * 对手的跟注范围在"听牌做成"的转牌上最强，这时候继续开枪是送钱；
 * 大牌转牌通常对自己（下注方）的范围更有利，可以多开一点。
 */
export function turnBarrelFactor(flop, board) {
  const cls = turnCardClass(flop, board);
  const factor = cls === 'completed' ? 0.35 : cls === 'overcard' ? 1.15 : 1;
  return { factor, cls };
}