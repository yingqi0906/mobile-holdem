/**
 * 对抗「范围」的胜率估算 + 逐街范围收窄。
 *
 * 两个层次的问题：
 *
 * 1. 不能拿"对抗随机牌"的胜率去比底池赔率 —— 对手下注时他的牌远强于随机牌，
 *    那样算会系统性高估自己的胜率，表现就是跟注过多。
 *
 * 2. 光按"翻前牌力"收窄也不够。对手在 Q72 面上主动下注，他的范围应该偏向
 *    **在这个牌面上真的成牌了**的手牌，而不只是"翻前较强的牌"。
 *
 * 所以这里按牌面给每个手牌类别算一个强度百分位，对手每做一个动作就把权重
 * 乘以"这手牌会不会这么做"的似然 —— 加注偏向强牌、过牌偏向弱牌，
 * 这就是逐街范围收窄。
 */

import { freshDeck, makeCard } from './cards.js';
import { evaluateBest } from './evaluator.js';
import { HAND_RANK } from './hand-rank.js';

const CLASSES = HAND_RANK.length;
const RANK_CHAR = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const CHAR_RANK = new Map(RANK_CHAR.map((c, i) => [c, i + 2]));

/** 每个手牌类别的组合数：对子 6、同花 4、非同花 12。 */
function combosOf(cls) {
  if (cls.length === 2) return 6;
  return cls.endsWith('s') ? 4 : 12;
}
const CLASS_COMBOS = HAND_RANK.map(combosOf);

function classIndexOf(cards) {
  const [a, b] = cards;
  const ra = (a >> 2) + 2;
  const rb = (b >> 2) + 2;
  const hi = Math.max(ra, rb);
  const lo = Math.min(ra, rb);
  const label =
    hi === lo
      ? RANK_CHAR[hi - 2] + RANK_CHAR[lo - 2]
      : RANK_CHAR[hi - 2] + RANK_CHAR[lo - 2] + ((a & 3) === (b & 3) ? 's' : 'o');
  return HAND_RANK.indexOf(label);
}

// 按牌面缓存强度百分位。同一张公共牌面在一整手里要反复用。
const strengthCache = new Map();

/**
 * 这个牌面上每个手牌类别的强度百分位（0~1，1 是最强）。
 * 做法是把 1326 个组合全算一遍，比出百分位，再按类别取平均。
 * 这样"在 Q72 面上有对子"和"A 高"的差距就量化出来了。
 */
export function boardStrength(board) {
  // 翻牌前没有公共牌，强度无从谈起，返回中性值
  if (board.length < 3) return new Float64Array(CLASSES).fill(0.5);
  const key = board.join(',');
  const cached = strengthCache.get(key);
  if (cached) return cached;

  const scores = [];
  const classOf = [];
  for (let a = 0; a < 52; a++) {
    for (let b = a + 1; b < 52; b++) {
      if (board.includes(a) || board.includes(b)) continue;
      scores.push(evaluateBest([a, b, ...board]));
      classOf.push(classIndexOf([a, b]));
    }
  }

  const order = scores.map((_, i) => i).sort((x, y) => scores[x] - scores[y]);
  const sum = new Float64Array(CLASSES);
  const count = new Float64Array(CLASSES);
  for (let rank = 0; rank < order.length; rank++) {
    const i = order[rank];
    const pct = rank / Math.max(1, order.length - 1);
    sum[classOf[i]] += pct;
    count[classOf[i]] += 1;
  }
  const out = new Float64Array(CLASSES);
  for (let c = 0; c < CLASSES; c++) out[c] = count[c] > 0 ? sum[c] / count[c] : 0.5;

  strengthCache.set(key, out);
  return out;
}

/** 翻前范围：强度排序的前 width 部分。 */
export function initialWeights(width) {
  const limit = Math.max(1, Math.round(CLASSES * Math.min(1, width)));
  const w = new Float64Array(CLASSES);
  for (let i = 0; i < limit; i++) w[i] = CLASS_COMBOS[i];
  return normalize(w);
}

function normalize(w) {
  let sum = 0;
  for (let i = 0; i < CLASSES; i++) sum += w[i];
  if (sum > 0) for (let i = 0; i < CLASSES; i++) w[i] /= sum;
  return w;
}

/**
 * 按动作收窄范围。
 *
 * 似然是"这手牌会不会做这个动作"：下注/加注强烈偏向牌面强度高的，
 * 过牌偏向弱的，跟注偏中间。乘完重新归一化。
 */
export function narrowByAction(weights, kind, strength) {
  const out = new Float64Array(CLASSES);
  for (let i = 0; i < CLASSES; i++) {
    if (weights[i] <= 0) continue;
    const s = strength[i];
    let like;
    if (kind === 'raise' || kind === 'allIn') {
      like = 0.04 + 0.96 * s * s; // 越强越可能下注
    } else if (kind === 'call') {
      like = 0.25 + 0.75 * (1 - Math.abs(s - 0.55) * 1.6); // 跟注偏中间牌力
    } else if (kind === 'check') {
      like = 1 - 0.8 * s * s; // 强牌一般不会过牌
    } else {
      continue; // 弃牌的人已经不在范围里了
    }
    out[i] = weights[i] * Math.max(0.01, like);
  }
  return normalize(out);
}

/** 从投入推断翻前的初始范围宽度。 */
function preflopWidth(state, seat) {
  const bb = state.config.bigBlind;
  if (seat.committed >= bb * 6) return 0.22;
  if (seat.committed >= bb * 2) return 0.5;
  return 0.8;
}

/**
 * 算出每个还在牌局里的对手当前的范围权重。
 * 从翻前宽度出发，把他翻后的每一个动作依次作用上去。
 */
export function opponentRangeWeights(state, seatIdx) {
  const strength = boardStrength(state.board);
  const postflop = (state.handActions ?? []).filter((a) => a.street !== 'preflop');

  return state.seats
    .filter((s) => s.inHand && !s.folded && s.index !== seatIdx)
    .map((opp) => {
      let w = initialWeights(preflopWidth(state, opp));
      for (const act of postflop) {
        if (act.seat === opp.index) w = narrowByAction(w, act.kind, strength);
      }
      return w;
    });
}

/** 按权重抽样一个手牌类别，再用具体花色兑现成两张牌。 */
function makeSampler(weights, rng) {
  const cumulative = new Float64Array(CLASSES);
  let acc = 0;
  for (let i = 0; i < CLASSES; i++) {
    acc += weights[i];
    cumulative[i] = acc;
  }
  const total = acc;

  return (dead) => {
    for (let tries = 0; tries < 14; tries++) {
      const target = rng() * total;
      let lo = 0;
      let hi = CLASSES - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cumulative[mid] < target) lo = mid + 1;
        else hi = mid;
      }
      const cards = materialize(HAND_RANK[lo], dead, rng);
      if (cards) return cards;
    }
    return null;
  };
}

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
 * 蒙特卡洛胜率：对手手牌按各自的范围权重抽取。
 * weightArrays 是与对手一一对应的权重数组。
 */
export function estimateEquityVsRanges(hole, board, weightArrays, iterations, rng) {
  const dead = new Set([...hole, ...board]);
  const live = freshDeck().filter((c) => !dead.has(c));
  const needBoard = 5 - board.length;
  const opponentCount = weightArrays.length;
  if (needBoard + opponentCount * 2 > live.length) return 0.5;

  const samplers = weightArrays.map((w) => makeSampler(w, rng));
  const my7 = new Array(7);
  const opp7 = new Array(7);
  const simBoard = new Array(5);
  const pool = new Array(live.length);

  let equity = 0;
  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < live.length; i++) pool[i] = live[i];
    const cardsNeeded = needBoard + opponentCount * 2;
    for (let i = 0; i < cardsNeeded; i++) {
      const j = i + Math.floor(rng() * (pool.length - i));
      const tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
    }

    let cursor = 0;
    const used = new Set([...hole, ...board]);
    for (let i = 0; i < needBoard; i++) {
      simBoard[board.length + i] = pool[cursor++];
      used.add(simBoard[board.length + i]);
    }
    for (let i = 0; i < board.length; i++) simBoard[i] = board[i];

    my7[0] = hole[0];
    my7[1] = hole[1];
    for (let i = 0; i < 5; i++) my7[2 + i] = simBoard[i];
    const myScore = evaluateBest(my7);

    let better = 0;
    let equal = 0;
    for (let o = 0; o < opponentCount; o++) {
      const oppHand = samplers[o](used) ?? [pool[cursor], pool[cursor + 1]];
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
