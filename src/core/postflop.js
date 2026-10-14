/**
 * 翻后的尺度选择。
 *
 * 不追求求解，而是把启发式往 GTO 的规律上靠。最偏离的就是**下注尺度**：
 * 之前无论什么牌面都用差不多的底池比例，而 GTO 在这上面规律很明确：
 *
 *   - 干燥面（K72 彩虹）：下注方有巨大范围优势 → 小注、高频
 *     （用小注就能收下底池，没必要冒大风险）
 *   - 湿润面（JT9 两同花）：听牌多、范围差距小 → 大注、低频
 *     （要么拿价值要么保护，中等牌更愿意过牌）
 *   - 有范围优势才多下注；没有就该多过牌
 *
 * 其中"范围优势"不是拍脑袋，是用已有的牌面强度表和范围模型算出来的：
 * 把自己范围里每手牌在这张牌面上的强度百分位加权平均，再和对手的相减。
 */

import { rankOf, suitOf } from './cards.js';
import {
  CLASS_COMBOS,
  boardStrength,
  opponentRangeWeights,
  selfRangeWeights,
} from './equity.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 牌面特征：有没有对子、同花听牌、连张，以及综合湿润度。 */
export function boardTexture(board) {
  if (board.length < 3) {
    return { paired: false, flushy: false, twoTone: false, connected: false, highCard: false, wetness: 0.3 };
  }
  const ranks = board.map(rankOf);
  const suits = board.map(suitOf);

  const counts = new Map();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const paired = [...counts.values()].some((c) => c >= 2);

  let maxSuit = 0;
  for (let s = 0; s < 4; s++) maxSuit = Math.max(maxSuit, suits.filter((x) => x === s).length);
  const flushy = maxSuit >= 3; // 已经有同花可能
  const twoTone = maxSuit === 2;

  const sorted = [...new Set(ranks)].sort((a, b) => b - a);
  let connected = false;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i - 1] - sorted[i] <= 2) connected = true;
  }
  const highCard = Math.max(...ranks) >= 12; // 有 Q 以上的大牌

  // 湿润度 0（完全干燥）~ 1（最湿）
  const wetness = clamp(
    (flushy ? 0.5 : twoTone ? 0.28 : 0) + (connected ? 0.34 : 0) + (paired ? 0.08 : 0),
    0,
    1
  );
  return { paired, flushy, twoTone, connected, highCard, wetness };
}

/**
 * 范围优势：正数表示英雄的范围在这张牌面上比对手强。
 * 用牌面强度表按范围权重加权平均，再相减。
 */
export function rangeAdvantage(state, seatIdx) {
  const strength = boardStrength(state.board);
  const seat = state.seats[seatIdx];
  if (!seat || seat.hole.length !== 2) return 0;

  const average = (weights) => {
    let sum = 0;
    let total = 0;
    for (let i = 0; i < weights.length; i++) {
      sum += weights[i] * strength[i];
      total += weights[i];
    }
    return total > 0 ? sum / total : 0.5;
  };

  const hero = average(selfRangeWeights(state, seat));
  const opponentRanges = opponentRangeWeights(state, seatIdx);
  if (opponentRanges.length === 0) return 0;
  const opponent =
    opponentRanges.reduce((acc, r) => acc + average(r), 0) / opponentRanges.length;

  return hero - opponent;
}

/**
 * 坚果优势：我的范围里"在这张牌面上属于最强那一档"的比例，
 * 比对手高多少。超池下注只在有坚果优势时才合理 —— 因为超池是
 * 两极化武器：要么你手里有坚果要他命，要么你是空气在诈唬，
 * 中间牌不该用这个尺度。
 */
export function nutAdvantage(state, seatIdx, threshold = 0.85) {
  const strength = boardStrength(state.board);
  const seat = state.seats[seatIdx];
  if (!seat || seat.hole.length !== 2) return 0;

  const share = (weights) => {
    let top = 0;
    let total = 0;
    for (let i = 0; i < weights.length; i++) {
      const w = weights[i] * CLASS_COMBOS[i];
      total += w;
      if (strength[i] >= threshold) top += w;
    }
    return total > 0 ? top / total : 0;
  };

  const hero = share(selfRangeWeights(state, seat));
  const opponentRanges = opponentRangeWeights(state, seatIdx);
  if (opponentRanges.length === 0) return 0;
  const opponent =
    opponentRanges.reduce((acc, r) => acc + share(r), 0) / opponentRanges.length;

  return hero - opponent;
}

/**
 * 给出这一注的尺度与频率。
 *
 * 返回 fraction（占底池比例）、betFrequency（该不该下注）、bluffFrequency。
 * 这三个数就是"更接近 GTO 的尺度选择"落地的地方。
 */
export function betPlan({
  texture,
  advantage,
  nutAdvantage: nuts = 0,
  street = 'flop',
  aggression = 0.55,
  bluff = 0.15,
}) {
  const dry = 1 - texture.wetness;

  // 超池只在转牌/河牌、而且有坚果优势时启用。翻牌上用超池很少见 ——
  // 后面还有两条街，把底池吹大反而让自己进退两难。
  const useOverbet = street !== 'flop' && nuts > 0.06;

  // 尺度：干燥面小、湿润面大；满足条件时切换成超池
  const fraction = useOverbet
    ? clamp(1.2 + 0.9 * nuts, 1.2, 2)
    : clamp(0.3 + 0.45 * texture.wetness, 0.3, 0.75);

  // 频率：干燥面高频（小注收池）、湿润面低频；有范围优势再加
  let betFrequency = clamp(
    0.35 + 0.35 * dry + 0.3 * advantage + 0.15 * aggression,
    0.15,
    0.9
  );
  // 超池是两极化武器，频率必须降下来 —— 用大尺度高频下注等于自曝
  if (useOverbet) betFrequency *= 0.7;

  // 诈唬频率：湿润面上诈唬要更谨慎（对手有更多能跟的牌）
  const bluffFrequency = clamp(bluff * (0.5 + 0.8 * dry), 0.02, 0.4);

  return {
    fraction,
    betFrequency,
    bluffFrequency,
    wetness: texture.wetness,
    overbet: useOverbet,
  };
}

/** 面对下注时的加注尺度：同样是湿润面更大。 */
export function raisePlan({ texture, advantage, aggression = 0.55 }) {
  const fraction = clamp(0.55 + 0.5 * texture.wetness, 0.55, 1.05);
  const raiseFrequency = clamp(0.35 + 0.3 * Math.max(0, advantage) + 0.3 * aggression, 0.15, 0.85);
  return { fraction, raiseFrequency };
}
