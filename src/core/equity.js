/**
 * 对抗「范围」的胜率估算。
 *
 * 为什么不能用"对抗随机牌"？因为对手主动加注的时候，他手里不可能是任意两张牌。
 * 拿"对抗随机牌"的胜率去跟底池赔率比，会系统性高估自己的胜率，结果就是
 * 跟注过多 —— 这正是实测出来的最大漏洞（面对中等下注只弃 11.7%，
 * 而理论允许弃到 36%）。
 *
 * 做法：对手的手牌不再均匀随机，而是从"前 X% 的强牌"里抽。
 * X 由他的投入和本街动作推断 —— 加注过就窄，只是跟注就宽。
 */

import { freshDeck, makeCard } from './cards.js';
import { evaluateBest } from './evaluator.js';
import { HAND_RANK } from './hand-rank.js';
import { handClass } from './preflop.js';

const RANK_INDEX = new Map(HAND_RANK.map((h, i) => [h, i]));
const CLASSES = HAND_RANK.length;
const RANK_CHAR = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const CHAR_RANK = new Map(RANK_CHAR.map((c, i) => [c, i + 2]));

/**
 * 推断每个对手的范围宽度（0~1）。
 * 投入越多、动作越强，范围越窄。
 */
export function opponentRangeWidths(state, seatIdx) {
  const bb = state.config.bigBlind;
  const actedThisStreet = new Map(
    (state.streetActions ?? []).map((a) => [a.seat, a.kind])
  );

  return state.seats
    .filter((s) => s.inHand && !s.folded && s.index !== seatIdx)
    .map((s) => {
      let w = 0.8; // 平跟进来的范围
      if (s.committed >= bb * 6) w = 0.22; // 翻前主动加注过
      else if (s.committed >= bb * 2) w = 0.5; // 翻前跟注过加注

      const kind = actedThisStreet.get(s.index);
      if (kind === 'raise' || kind === 'allIn') w *= 0.5; // 本街还在加注，范围更窄
      else if (kind === 'call') w *= 0.8;

      return Math.max(0.08, Math.min(1, w));
    });
}

/** 按手牌类别造出两张具体的牌，避开发过的牌。 */
function materialize(cls, dead, rng) {
  const a = CHAR_RANK.get(cls[0]);
  const b = CHAR_RANK.get(cls[1]);
  const pair = cls.length === 2;
  const suited = cls[2] === 's';

  for (let tries = 0; tries < 12; tries++) {
    const s1 = Math.floor(rng() * 4);
    const s2 = pair ? Math.floor(rng() * 4) : suited ? s1 : Math.floor(rng() * 4);
    const c1 = makeCard(a, s1);
    const c2 = makeCard(b, s2);
    if (c1 === c2) continue;
    if (dead.has(c1) || dead.has(c2)) continue;
    return [c1, c2];
  }
  return null;
}

/**
 * 蒙特卡洛胜率，对手手牌按其范围宽度从强到弱抽取。
 * widths 为长度等于对手数的数组；宽度为 1 时退化成均匀随机。
 */
export function estimateEquityVsRanges(hole, board, widths, iterations, rng) {
  const dead = new Set([...hole, ...board]);
  const live = freshDeck().filter((c) => !dead.has(c));
  const needBoard = 5 - board.length;
  const opponentCount = widths.length;
  const cardsNeeded = needBoard + opponentCount * 2;
  if (cardsNeeded > live.length) return 0.5;

  const limits = widths.map((w) => Math.max(1, Math.round(CLASSES * Math.min(1, w))));
  const my7 = new Array(7);
  const opp7 = new Array(7);
  const simBoard = new Array(5);
  const pool = new Array(live.length);

  let equity = 0;
  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < live.length; i++) pool[i] = live[i];
    for (let i = 0; i < cardsNeeded; i++) {
      const j = i + Math.floor(rng() * (pool.length - i));
      const tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
    }

    let cursor = 0;
    for (let i = 0; i < board.length; i++) simBoard[i] = board[i];
    for (let i = 0; i < needBoard; i++) simBoard[board.length + i] = pool[cursor++];

    my7[0] = hole[0];
    my7[1] = hole[1];
    for (let i = 0; i < 5; i++) my7[2 + i] = simBoard[i];
    const myScore = evaluateBest(my7);

    const used = new Set([...hole, ...simBoard]);
    let better = 0;
    let equal = 0;
    for (let o = 0; o < opponentCount; o++) {
      // 从剩下的牌里按范围抽样：抽到的牌不够强就重抽
      let oppHand = null;
      for (let tries = 0; tries < 16 && !oppHand; tries++) {
        const c1 = pool[cursor + Math.floor(rng() * (pool.length - cursor))];
        const c2 = pool[cursor + Math.floor(rng() * (pool.length - cursor))];
        if (c1 === c2 || used.has(c1) || used.has(c2)) continue;
        if (limits[o] < CLASSES) {
          const cls = handClass([c1, c2]);
          const rank = RANK_INDEX.get(cls);
          if (rank === undefined || rank >= limits[o]) continue;
        }
        oppHand = [c1, c2];
      }
      if (!oppHand) oppHand = [pool[cursor], pool[cursor + 1]];
      cursor += 2;
      used.add(oppHand[0]);
      used.add(oppHand[1]);

      opp7[0] = oppHand[0];
      opp7[1] = oppHand[1];
      for (let i = 0; i < 5; i++) opp7[2 + i] = simBoard[i];
      const score = evaluateBest(opp7);
      if (score > myScore) better++;
      else if (score === myScore) equal++;
    }

    if (better === 0) equity += equal === 0 ? 1 : 1 / (equal + 1);
  }

  return equity / iterations;
}
