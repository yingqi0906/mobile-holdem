/**
 * 牌型评估。
 *
 * 设计要点：把一手 5 张牌压缩成一个整数 score，直接比大小即可，
 * 7 张牌则枚举全部 21 种 5 张组合取最大值。
 *
 * score = 牌型等级 * 15^5 + k1*15^4 + k2*15^3 + k3*15^2 + k4*15 + k5
 * 高位放牌型等级，后面依次是比较用的关键点数（降序）。
 */

import { rankOf, suitOf } from './cards.js';

export const CATEGORY = {
  HIGH_CARD: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  TRIPS: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  QUADS: 7,
  STRAIGHT_FLUSH: 8,
};

export const CATEGORY_NAMES = [
  '高牌',
  '一对',
  '两对',
  '三条',
  '顺子',
  '同花',
  '葫芦',
  '四条',
  '同花顺',
];

const BASE = 15;
const POW = [1, 15, 225, 3375, 50625]; // 15^0 .. 15^4
const CATEGORY_SCALE = 759375; // 15^5

function scoreOf(category, k1 = 0, k2 = 0, k3 = 0, k4 = 0, k5 = 0) {
  return (
    category * CATEGORY_SCALE +
    k1 * POW[4] +
    k2 * POW[3] +
    k3 * POW[2] +
    k4 * POW[1] +
    k5 * POW[0]
  );
}

// 复用同一个 buffer，避免在蒙特卡洛里疯狂分配内存（JS 单线程，不存在并发问题）。
const counts = new Uint8Array(15);

/** 评估指定的 5 张牌（用下标传入），返回可比较的整数。 */
function score5(cards, i0, i1, i2, i3, i4) {
  const c0 = cards[i0];
  const c1 = cards[i1];
  const c2 = cards[i2];
  const c3 = cards[i3];
  const c4 = cards[i4];

  counts.fill(0);
  const suit0 = suitOf(c0);
  const flush =
    suitOf(c1) === suit0 &&
    suitOf(c2) === suit0 &&
    suitOf(c3) === suit0 &&
    suitOf(c4) === suit0;

  counts[rankOf(c0)]++;
  counts[rankOf(c1)]++;
  counts[rankOf(c2)]++;
  counts[rankOf(c3)]++;
  counts[rankOf(c4)]++;

  // 顺子判定（含 A-2-3-4-5 轮子顺）
  let straightHigh = 0;
  for (let h = 14; h >= 6; h--) {
    if (
      counts[h] &&
      counts[h - 1] &&
      counts[h - 2] &&
      counts[h - 3] &&
      counts[h - 4]
    ) {
      straightHigh = h;
      break;
    }
  }
  if (!straightHigh && counts[14] && counts[5] && counts[4] && counts[3] && counts[2]) {
    straightHigh = 5;
  }

  if (flush && straightHigh) return scoreOf(CATEGORY.STRAIGHT_FLUSH, straightHigh);

  // 按点数从大到小分组
  let quad = 0;
  let trip1 = 0;
  let trip2 = 0;
  let pair1 = 0;
  let pair2 = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  let s4 = 0;
  let s5 = 0;
  let singles = 0;

  for (let r = 14; r >= 2; r--) {
    const n = counts[r];
    if (n === 0) continue;
    if (n === 4) {
      quad = r;
    } else if (n === 3) {
      if (!trip1) trip1 = r;
      else trip2 = r;
    } else if (n === 2) {
      if (!pair1) pair1 = r;
      else pair2 = r;
    } else {
      if (singles === 0) s1 = r;
      else if (singles === 1) s2 = r;
      else if (singles === 2) s3 = r;
      else if (singles === 3) s4 = r;
      else s5 = r;
      singles++;
    }
  }

  if (quad) return scoreOf(CATEGORY.QUADS, quad, s1);

  if (trip1 && (trip2 || pair1)) {
    return scoreOf(CATEGORY.FULL_HOUSE, trip1, trip2 || pair1);
  }

  if (flush) return scoreOf(CATEGORY.FLUSH, s1, s2, s3, s4, s5);
  if (straightHigh) return scoreOf(CATEGORY.STRAIGHT, straightHigh);
  if (trip1) return scoreOf(CATEGORY.TRIPS, trip1, s1, s2);
  if (pair1 && pair2) return scoreOf(CATEGORY.TWO_PAIR, pair1, pair2, s1);
  if (pair1) return scoreOf(CATEGORY.PAIR, pair1, s1, s2, s3);
  return scoreOf(CATEGORY.HIGH_CARD, s1, s2, s3, s4, s5);
}

/** 评估恰好 5 张牌。 */
export function evaluate5(cards) {
  if (cards.length !== 5) throw new Error('evaluate5 需要恰好 5 张牌');
  return score5(cards, 0, 1, 2, 3, 4);
}

// 预生成组合下标，避免每次评估都重新枚举。
const COMBO_CACHE = new Map();

function combosOf(n) {
  let cached = COMBO_CACHE.get(n);
  if (cached) return cached;
  const list = [];
  const idx = [0, 1, 2, 3, 4];
  const rec = (start, depth) => {
    if (depth === 5) {
      list.push(idx.slice());
      return;
    }
    for (let i = start; i < n; i++) {
      idx[depth] = i;
      rec(i + 1, depth + 1);
    }
  };
  rec(0, 0);
  COMBO_CACHE.set(n, list);
  return list;
}

/**
 * 从 5/6/7 张牌里取最强的 5 张，返回 score。
 * 河牌圈是 7 张，翻牌圈是 5 张，转牌圈是 6 张。
 */
export function evaluateBest(cards) {
  const n = cards.length;
  if (n === 5) return score5(cards, 0, 1, 2, 3, 4);
  if (n < 5 || n > 7) throw new Error(`无法评估 ${n} 张牌`);
  const combos = combosOf(n);
  let best = -1;
  for (let i = 0; i < combos.length; i++) {
    const c = combos[i];
    const s = score5(cards, c[0], c[1], c[2], c[3], c[4]);
    if (s > best) best = s;
  }
  return best;
}

export function categoryOf(score) {
  return Math.floor(score / CATEGORY_SCALE);
}

/**
 * 找出这手牌里最强的 5 张（而不是只返回一个分数）。
 * 结算界面要像 GGPoker 那样把赢家的最佳五张亮出来，所以需要具体的牌。
 */
export function bestFive(cards) {
  const n = cards.length;
  if (n === 5) return cards.slice();
  if (n < 5 || n > 7) throw new Error(`无法评估 ${n} 张牌`);
  const combos = combosOf(n);
  let best = -1;
  let bestCombo = null;
  for (let i = 0; i < combos.length; i++) {
    const c = combos[i];
    const s = score5(cards, c[0], c[1], c[2], c[3], c[4]);
    if (s > best) {
      best = s;
      bestCombo = c;
    }
  }
  return bestCombo.map((i) => cards[i]);
}

/** 解出 score 里的 5 个关键点数（降序，不用的补 0）。 */
export function kickersOf(score) {
  let rem = score % CATEGORY_SCALE;
  const out = [];
  for (let i = 0; i < 5; i++) {
    const p = POW[4 - i];
    out.push(Math.floor(rem / p));
    rem %= p;
  }
  return out;
}

const RANK_SINGULAR = [
  '', '', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A',
];
const RANK_PLURAL = [
  '', '', 'Twos', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights',
  'Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces',
];

/** 把 score 翻译成人话，给界面显示。 */
export function describeScore(score) {
  const cat = categoryOf(score);
  const [k1, k2] = kickersOf(score);
  switch (cat) {
    case CATEGORY.STRAIGHT_FLUSH:
      return k1 === 14 ? '皇家同花顺' : `${RANK_SINGULAR[k1]} 高同花顺`;
    case CATEGORY.QUADS:
      return `四条 ${RANK_PLURAL[k1]}`;
    case CATEGORY.FULL_HOUSE:
      return `葫芦，${RANK_PLURAL[k1]} 带 ${RANK_PLURAL[k2]}`;
    case CATEGORY.FLUSH:
      return `同花，${RANK_SINGULAR[k1]} 高`;
    case CATEGORY.STRAIGHT:
      return `${RANK_SINGULAR[k1]} 高顺子`;
    case CATEGORY.TRIPS:
      return `三条 ${RANK_PLURAL[k1]}`;
    case CATEGORY.TWO_PAIR:
      return `两对，${RANK_PLURAL[k1]} 和 ${RANK_PLURAL[k2]}`;
    case CATEGORY.PAIR:
      return `一对 ${RANK_PLURAL[k1]}`;
    default:
      return `${RANK_SINGULAR[k1]} 高牌`;
  }
}

/** a 比 b 强返回正数，弱返回负数，平局返回 0。 */
export function compareScores(a, b) {
  return a - b;
}
