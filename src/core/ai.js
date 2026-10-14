/**
 * 电脑对手。
 *
 * 思路刻意保持"够用且好懂"：
 *   1. 用蒙特卡洛模拟估算自己这手牌对抗当前对手数的胜率（equity）。
 *   2. 和底池赔率比较，再叠加一个性格参数（松紧 / 激进度 / 诈唬频率）。
 *
 * 没有上 CFR 那种求解器 —— 那是研究项目，不是第一版该做的事。
 */

import { freshDeck, rankOf, suitOf } from './cards.js';
import { evaluateBest } from './evaluator.js';
import { estimateEquityVsRanges, opponentRangeWeights } from './equity.js';
import { ACTION_TYPES, PHASES, getLegalActions, totalPot } from './engine.js';
import { preflopAdvice } from './preflop.js';
import { solveRiverForState } from './river-solver.js';
import { betPlan, boardTexture, raisePlan, rangeAdvantage } from './postflop.js';
import { createSeededRng } from './rng.js';

export const BOT_PRESETS = {
  rock: { name: '岩石', tightness: 0.85, aggression: 0.3, bluff: 0.05 },
  calling: { name: '跟注站', tightness: 0.7, aggression: 0.2, bluff: 0.04 },
  tight: { name: '紧凶', tightness: 0.55, aggression: 0.62, bluff: 0.12 },
  lag: { name: '松凶', tightness: 0.28, aggression: 0.86, bluff: 0.28 },
  balanced: { name: '均衡', tightness: 0.48, aggression: 0.55, bluff: 0.15 },
};

const STREET_ITERATIONS = {
  preflop: 200,
  flop: 240,
  turn: 280,
  river: 340,
};

/**
 * 对手越多，每轮模拟就要多评估几手牌，成本是线性上涨的。
 * 用 1/sqrt(对手数) 压低迭代次数，让单次决策的开销大致保持恒定 ——
 * 胜率精度会掉几个百分点，但对休闲对局完全够用，而且手机才不会卡。
 */
function iterationsFor(phase, opponents) {
  const base = STREET_ITERATIONS[phase] ?? 260;
  return Math.max(90, Math.round(base / Math.sqrt(Math.max(1, opponents))));
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * 把求解器给出的均衡策略翻译成一个具体行动。
 * 按频率抽样 —— 这正是"混合策略"该有的样子：同一个局面下有时加注有时跟注。
 */
function actionFromStrategy(solved, legal, seatIdx, rng) {
  const entries = Object.entries(solved.strategy).filter(([, p]) => p > 0.001);
  if (entries.length === 0) return null;

  let roll = rng();
  for (const [name, probability] of entries) {
    roll -= probability;
    if (roll > 0) continue;

    const spec = solved.actions.find((a) => a.name === name);
    if (name === 'check') {
      return legal.canCheck
        ? { type: ACTION_TYPES.CHECK, seat: seatIdx }
        : { type: ACTION_TYPES.CALL, seat: seatIdx };
    }
    if (name === 'fold') {
      return legal.canCheck
        ? { type: ACTION_TYPES.CHECK, seat: seatIdx }
        : { type: ACTION_TYPES.FOLD, seat: seatIdx };
    }
    if (name === 'call') {
      if (!legal.canCall) return { type: ACTION_TYPES.CHECK, seat: seatIdx };
      return { type: ACTION_TYPES.CALL, seat: seatIdx };
    }
    if (name === 'allin' && legal.canRaise) {
      return { type: ACTION_TYPES.ALL_IN, seat: seatIdx };
    }
    if ((name === 'bet' || name === 'raise') && legal.canRaise) {
      return {
        type: ACTION_TYPES.RAISE,
        seat: seatIdx,
        amount: clamp(spec?.amount ?? legal.minRaiseTo, legal.minRaiseTo, legal.maxRaiseTo),
      };
    }
    // 行动不合法就退回跟注/过牌
    return legal.canCheck
      ? { type: ACTION_TYPES.CHECK, seat: seatIdx }
      : { type: ACTION_TYPES.CALL, seat: seatIdx };
  }
  return null;
}

/**
 * 蒙特卡洛胜率估算。
 * 随机补完公共牌并给每个对手发随机底牌，比较牌力，返回 [0, 1] 的胜率。
 */
export function estimateEquity(hole, board, opponentCount, iterations, rng) {
  const dead = new Set([...hole, ...board]);
  const live = freshDeck().filter((c) => !dead.has(c));
  const needBoard = 5 - board.length;
  const cardsNeeded = needBoard + opponentCount * 2;
  if (cardsNeeded > live.length) return 0.5;

  const my7 = new Array(7);
  const opp7 = new Array(7);
  const simBoard = new Array(5);
  const pool = new Array(live.length);

  let equity = 0;
  for (let iter = 0; iter < iterations; iter++) {
    // 复制牌堆后只做前 N 步 Fisher-Yates，够用且比全洗快
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

    let better = 0;
    let equal = 0;
    for (let o = 0; o < opponentCount; o++) {
      opp7[0] = pool[cursor++];
      opp7[1] = pool[cursor++];
      for (let i = 0; i < 5; i++) opp7[2 + i] = simBoard[i];
      const score = evaluateBest(opp7);
      if (score > myScore) better++;
      else if (score === myScore) equal++;
    }

    if (better === 0) equity += equal === 0 ? 1 : 1 / (equal + 1);
  }

  return equity / iterations;
}

const RANK_POINTS = { 14: 10, 13: 8, 12: 7, 11: 6 };

/**
 * Chen formula：起手牌强度评分，大约 -1 到 20 分。
 *
 * 蒙特卡洛算的是「对抗随机牌的胜率」，这个数字翻牌前没什么区分度
 * （72o 对抗随机牌都有 35%），所以翻牌前额外用这个评分把烂牌挡在门外。
 */
export function chenScore(hole) {
  if (!hole || hole.length !== 2) return 0;
  const [a, b] = hole;
  const hi = Math.max(rankOf(a), rankOf(b));
  const lo = Math.min(rankOf(a), rankOf(b));
  let score = RANK_POINTS[hi] ?? hi / 2;

  if (hi === lo) return Math.max(score * 2, 5); // 对子

  if (suitOf(a) === suitOf(b)) score += 2; // 同花

  const gap = hi - lo - 1;
  if (gap === 1) score -= 1;
  else if (gap === 2) score -= 2;
  else if (gap === 3) score -= 4;
  else if (gap >= 4) score -= 5;

  if (gap <= 1 && hi < 12) score += 1; // 有顺子潜力

  return Math.ceil(score);
}

const round5 = (v) => Math.round(v / 5) * 5;

/** 把「底池的几分之几」换算成合法的加注额。 */
function raiseTarget(state, legal, fraction, pot, rng, aggression) {
  let raw;
  if (state.phase === PHASES.PREFLOP) {
    // 翻牌前用「几个大盲」来定注额，比按底池比例自然得多
    const bb = state.config.bigBlind;
    raw =
      state.currentBet <= bb
        ? bb * 3
        : state.currentBet * (2.4 + 0.7 * aggression);
  } else {
    raw = state.currentBet + (pot + legal.toCall) * fraction;
  }
  const jitter = 1 + (rng() - 0.5) * 0.16;
  return clamp(round5(raw * jitter), legal.minRaiseTo, legal.maxRaiseTo);
}

/**
 * 让某个座位做决定，返回一个 action 对象（不是直接改状态）。
 *
 * 翻牌前和翻牌后用的是两套判断：
 *   翻牌前 —— 靠 Chen 评分决定要不要进池，因为翻前胜率几乎没有区分度；
 *   翻牌后 —— 靠蒙特卡洛胜率对比底池赔率，但要求的胜率比裸赔率更高，
 *             因为对手主动下注代表他的牌比随机牌强。
 */
export function decideBotAction(state, seatIdx, rng = Math.random) {
  const legal = getLegalActions(state, seatIdx);
  if (!legal) return null;

  const seat = state.seats[seatIdx];
  const preset = seat.bot ?? BOT_PRESETS.balanced;
  const { tightness, aggression, bluff } = preset;

  const opponents = state.seats.filter(
    (s) => s.inHand && !s.folded && s.index !== seatIdx
  ).length;
  // 翻前的决策完全靠 Chen 评分，用不到胜率 —— 所以这里惰性计算，
  // 省掉一次蒙特卡洛。手机上每次决策能少几毫秒。
  let equityCache = null;
  const equity = () => {
    if (equityCache === null) {
      const iterations = iterationsFor(state.phase, opponents);
      // 对抗「范围」而不是对抗随机牌 —— 对手加注时他的牌远强于随机牌，
      // 用随机牌算胜率会系统性高估，表现出来就是跟注过多。
      const ranges = opponentRangeWeights(state, seatIdx);
      const sample = estimateEquityVsRanges(seat.hole, state.board, ranges, iterations, rng);
      equityCache = clamp(sample + (rng() - 0.5) * 0.04, 0, 1);
    }
    return equityCache;
  };

  const pot = totalPot(state);
  const potOdds = legal.toCall > 0 ? legal.toCall / (pot + legal.toCall) : 0;

  const raise = (fraction) => ({
    type: ACTION_TYPES.RAISE,
    seat: seatIdx,
    amount: raiseTarget(state, legal, fraction, pot, rng, aggression),
  });
  const call = () => ({
    type: legal.canCheck ? ACTION_TYPES.CHECK : ACTION_TYPES.CALL,
    seat: seatIdx,
  });
  const fold = () => ({ type: ACTION_TYPES.FOLD, seat: seatIdx });

  // ------------------------------------------------------------ 翻牌前
  if (state.phase === PHASES.PREFLOP) {
    // 翻前完全交给范围表 —— 这里不再用"牌力评分 + 拍脑袋门槛"那一套，
    // 因为实测那套只加注 3.3%，而 GTO 大约 30%，差了一个数量级。
    const advice = preflopAdvice(state, seatIdx, rng);

    if (advice.action === 'raise' && legal.canRaise) {
      return {
        type: ACTION_TYPES.RAISE,
        seat: seatIdx,
        amount: clamp(advice.sizing ?? state.config.bigBlind * 3, legal.minRaiseTo, legal.maxRaiseTo),
      };
    }
    // 范围表会给出「全下」这个频率 —— 别漏掉，否则会被当成弃牌
    if (advice.action === 'allin' && legal.canRaise) {
      return { type: ACTION_TYPES.ALL_IN, seat: seatIdx };
    }
    if (advice.action === 'call' && legal.canCall) {
      return { type: ACTION_TYPES.CALL, seat: seatIdx };
    }
    if (legal.canCheck) return { type: ACTION_TYPES.CHECK, seat: seatIdx };
    if (advice.action === 'call') return { type: ACTION_TYPES.CALL, seat: seatIdx };
    return { type: ACTION_TYPES.FOLD, seat: seatIdx };
  }
  // ------------------------------------------------------------ 河牌
  // 河牌是唯一能在运行时做真求解的一条街 —— 交给 CFR。
  // 多人底池或者手牌不在假设范围内时求解器返回 null，回落到底下的启发式。
  if (state.phase === PHASES.RIVER) {
    const solved = solveRiverForState(state, seatIdx, { iterations: 450 });
    const chosen = solved ? actionFromStrategy(solved, legal, seatIdx, rng) : null;
    if (chosen) return chosen;
  }

  // ------------------------------------------------------------ 翻牌后
  if (legal.canCheck) {
    const eq = equity();
    // 尺度不是拍脑袋定的：干燥面小注高频、湿润面大注低频，
    // 再按"谁的范围在这张牌面上更强"微调频率。
    const texture = boardTexture(state.board);
    const plan = betPlan({
      texture,
      advantage: rangeAdvantage(state, seatIdx),
      aggression,
      bluff,
    });
    const strong = eq > 0.68 + 0.08 * tightness;
    const decent = eq > 0.5;

    if (strong && legal.canRaise) {
      if (rng() < 0.2) return call(); // 偶尔慢打，别让"加注=大牌"太好读
      return raise(plan.fraction);
    }
    // 频率沿用原来那套（实测合格的），只把**尺度**换成按牌面算出来的。
    // 之前把频率一起改了，结果下注率从 51% 掉到 34%、三档防守全部变成
    // "弃牌过多" —— 频率和尺度必须分开动。
    if (decent && legal.canRaise && rng() < 0.5 + 0.35 * aggression) {
      return raise(plan.fraction * 0.8);
    }
    // 牌力不足时也要以一定频率下注 —— 下注不只为价值，也是为了不让对手
    // 随便过牌看免费牌。诈唬用和强牌一样的尺度（两极化），这样对手没法
    // 靠尺度读牌。
    if (legal.canRaise && rng() < 0.2 + 0.35 * bluff) return raise(plan.fraction);
    return call();
  }

  // 面对下注：对手主动下注说明他的牌强于随机牌，所以门槛要加一层保证金
  const betRatio = Math.min(2, legal.toCall / Math.max(1, pot));
  const margin = 0.02 + 0.07 * Math.min(1, betRatio) + 0.03 * (1 - tightness);

  if (equity() < potOdds + margin) {
    if (legal.canRaise && rng() < bluff * 0.07) return raise(0.75);
    return fold();
  }
  if (equity() > 0.8 && legal.canRaise && rng() < 0.45 + 0.45 * aggression) {
    const raiseSize = raisePlan({
      texture: boardTexture(state.board),
      advantage: rangeAdvantage(state, seatIdx),
      aggression,
    });
    return raise(raiseSize.fraction);
  }
  if (legal.canRaise && equity() > potOdds + margin + 0.2 && rng() < 0.2 + 0.45 * aggression) {
    return raise(0.6);
  }
  return call();
}

/** 给非人类座位随机分配性格。 */
export function attachBots(state, rng = createSeededRng(Date.now() >>> 0)) {
  const kinds = Object.keys(BOT_PRESETS);
  const next = structuredClone(state);
  for (const seat of next.seats) {
    if (seat.isHuman) continue;
    const kind = kinds[Math.floor(rng() * kinds.length)];
    seat.bot = { ...BOT_PRESETS[kind], kind };
  }
  return next;
}
