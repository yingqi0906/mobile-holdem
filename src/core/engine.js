/**
 * 无限注德州扑克牌局引擎（单桌，固定盲注）。
 *
 * 核心设计：整局牌就是一个状态对象，所有推进都通过
 *   applyAction(state, action) -> newState
 * 完成。引擎不碰 DOM、不知道 UI 的存在，所以可以直接用单元测试
 * 跑完几万手牌来验证。
 *
 * 几个容易做错、这里专门处理了的规则：
 *   1. 边池（side pot）：按每个玩家的累计投入分层，逐层判定赢家。
 *   2. 最小加注：加注增量必须 >= 上一次加注增量，且下限是大盲注。
 *   3. 短码 all-in：不足额加注不构成"完整加注"，因此不重开下注轮，
 *      已经行动过的玩家只能跟或弃，不能再加注。
 *   4. 单挑（heads-up）：庄家就是小盲，翻牌前先行动、翻牌后后行动。
 *   5. 未被跟注的部分自动退还（例如你下注 500，对手只有 200 跟）。
 */

import { freshDeck } from './cards.js';
import { evaluateBest, describeScore } from './evaluator.js';
import { defaultRng, shuffleInPlace } from './rng.js';

export const PHASES = {
  IDLE: 'idle',
  PREFLOP: 'preflop',
  FLOP: 'flop',
  TURN: 'turn',
  RIVER: 'river',
  SHOWDOWN: 'showdown',
  HAND_OVER: 'handOver',
};

export const ACTION_TYPES = {
  FOLD: 'fold',
  CHECK: 'check',
  CALL: 'call',
  RAISE: 'raise',
  ALL_IN: 'allIn',
};

const STREET_AFTER = {
  [PHASES.PREFLOP]: PHASES.FLOP,
  [PHASES.FLOP]: PHASES.TURN,
  [PHASES.TURN]: PHASES.RIVER,
};

const DEFAULT_NAMES = ['你', '阿杰', '小雨', '老陈', '林姐', '阿豪'];

function clone(state) {
  return structuredClone(state);
}

// ---------------------------------------------------------------------------
// 建桌
// ---------------------------------------------------------------------------

export function createTable(options = {}) {
  const seatCount = options.seatCount ?? 6;
  const config = {
    smallBlind: options.smallBlind ?? 10,
    bigBlind: options.bigBlind ?? 20,
    startingStack: options.startingStack ?? 2000,
    seatCount,
    autoRebuy: options.autoRebuy ?? true,
  };
  const names = options.playerNames ?? DEFAULT_NAMES;

  const seats = [];
  for (let i = 0; i < seatCount; i++) {
    seats.push({
      index: i,
      name: names[i] ?? `座位 ${i + 1}`,
      isHuman: i === 0,
      stack: config.startingStack,
      startStack: config.startingStack,
      hole: [],
      inHand: false,
      folded: true,
      allIn: false,
      streetBet: 0,
      committed: 0,
      hasActed: false,
      lastAction: null,
      bot: null,
    });
  }

  return {
    config,
    seats,
    /**
     * 整局（session）的账本。
     *
     * 刻意放在引擎状态里而不是界面里：以后做联机时，服务端跑的是同一套
     * 引擎，这份账本可以直接随状态同步给每个客户端，不需要再写一份统计逻辑。
     */
    session: {
      hands: 0,
      seats: seats.map((seat) => ({
        index: seat.index,
        buyIn: config.startingStack,
        history: [config.startingStack],
        dealtIn: 0,
        wins: 0,
        peak: config.startingStack,
        low: config.startingStack,
      })),
    },
    handNumber: 0,
    // 初始置为最后一个座位，开第一手时按钮会移到 0 号位。
    buttonSeat: seatCount - 1,
    phase: PHASES.IDLE,
    board: [],
    deck: [],
    pots: [],
    currentBet: 0,
    minRaise: config.bigBlind,
    pendingActors: [],
    cannotRaise: [],
    toAct: null,
    lastAggressor: null,
    result: null,
    events: [],
    log: [],
  };
}

// ---------------------------------------------------------------------------
// 座位顺序工具
// ---------------------------------------------------------------------------

/** 从 startIdx 开始顺时针遍历所有座位，收集满足 predicate 的座位对象。 */
function orderFrom(state, startIdx, predicate) {
  const n = state.config.seatCount;
  const out = [];
  for (let i = 0; i < n; i++) {
    const idx = (startIdx + i) % n;
    const seat = state.seats[idx];
    if (predicate(seat)) out.push(seat);
  }
  return out;
}

/** 顺时针方向 from 之后第一个还在牌局里的座位。 */
function nextInHand(state, from) {
  const n = state.config.seatCount;
  for (let i = 1; i <= n; i++) {
    const idx = (from + i) % n;
    if (state.seats[idx].inHand) return idx;
  }
  return from;
}

/** 还能继续下注的座位（在牌局中、没弃牌、没 all-in）。 */
function canAct(seat) {
  return seat.inHand && !seat.folded && !seat.allIn;
}

function contestedSeats(state) {
  return state.seats.filter((s) => s.inHand && !s.folded);
}

// ---------------------------------------------------------------------------
// 底池
// ---------------------------------------------------------------------------

/**
 * 按累计投入分层构建主池和边池。
 *
 * 例：A 全下 100，B 跟 100，C 跟 300（多出的 200 无人跟注）。
 * 层 100：300 筹码，A/B/C 都有资格；层 300：400 筹码，只有 C 有资格，
 * 实际效果就是 C 多投的 200 原样退回，正是我们想要的。
 */
export function computePots(state) {
  const contributors = state.seats.filter((s) => s.committed > 0);
  const levels = [...new Set(contributors.map((s) => s.committed))].sort((a, b) => a - b);
  const pots = [];
  let prev = 0;

  for (const level of levels) {
    let amount = 0;
    const eligible = [];
    for (const seat of state.seats) {
      const contribution =
        Math.min(seat.committed, level) - Math.min(seat.committed, prev);
      amount += contribution;
      if (seat.committed >= level && seat.inHand && !seat.folded) {
        eligible.push(seat.index);
      }
    }
    prev = level;
    if (amount > 0) pots.push({ amount, eligible });
  }

  state.pots = pots;
  return pots;
}

export function totalPot(state) {
  return state.seats.reduce((sum, s) => sum + s.committed, 0);
}

// ---------------------------------------------------------------------------
// 开始一手牌
// ---------------------------------------------------------------------------

export function startHand(prev, rng = defaultRng()) {
  const state = clone(prev);
  state.events = [];

  // 上一手如果还没打完就被强行开新局（比如界面被重复点击），
  // 先把已经投进底池的筹码退还给本人，否则这些筹码就凭空消失了。
  if (state.phase !== PHASES.IDLE && state.phase !== PHASES.HAND_OVER) {
    for (const seat of state.seats) {
      seat.stack += seat.committed;
      seat.committed = 0;
      seat.streetBet = 0;
      seat.allIn = false;
    }
  }

  // 破产的玩家回血（单机版不希望桌子越打越空）。
  if (state.config.autoRebuy) {
    for (const seat of state.seats) {
      if (seat.stack <= 0) {
        seat.stack = state.config.startingStack;
        state.session.seats[seat.index].buyIn += seat.stack;
        state.events.push({ type: 'rebuy', seat: seat.index, amount: seat.stack });
        state.log.push({
          hand: state.handNumber + 1,
          text: `${seat.name} 输光了，自动补入 ${seat.stack}`,
        });
      }
    }
  }

  const participants = state.seats.filter((s) => s.stack > 0);
  if (participants.length < 2) {
    state.phase = PHASES.IDLE;
    return state;
  }

  state.handNumber += 1;
  state.result = null;
  state.board = [];
  state.pots = [];
  state.currentBet = 0;
  state.minRaise = state.config.bigBlind;
  state.cannotRaise = [];
  state.lastAggressor = null;
  state.phase = PHASES.PREFLOP;

  for (const seat of state.seats) {
    seat.inHand = seat.stack > 0;
    seat.folded = !seat.inHand;
    seat.allIn = false;
    seat.hole = [];
    seat.streetBet = 0;
    seat.committed = 0;
    seat.hasActed = false;
    seat.lastAction = null;
    seat.startStack = seat.stack;
    if (seat.inHand) state.session.seats[seat.index].dealtIn += 1;
  }

  // 按钮移到下一个能打的座位
  for (let i = 1; i <= state.config.seatCount; i++) {
    const cand = (state.buttonSeat + i) % state.config.seatCount;
    if (state.seats[cand].inHand) {
      state.buttonSeat = cand;
      break;
    }
  }

  // 洗牌、发底牌
  state.deck = shuffleInPlace(freshDeck(), rng);
  const dealOrder = orderFrom(state, nextInHand(state, state.buttonSeat), (s) => s.inHand);
  for (let round = 0; round < 2; round++) {
    for (const seat of dealOrder) {
      const card = state.deck.pop();
      state.seats[seat.index].hole.push(card);
    }
  }
  for (const seat of dealOrder) {
    state.events.push({ type: 'dealHole', seat: seat.index });
  }

  // 下盲注
  const count = participants.length;
  let sbSeat;
  let bbSeat;
  if (count === 2) {
    // 单挑：按钮位就是小盲
    sbSeat = state.buttonSeat;
    bbSeat = nextInHand(state, sbSeat);
  } else {
    sbSeat = nextInHand(state, state.buttonSeat);
    bbSeat = nextInHand(state, sbSeat);
  }

  postBlind(state, sbSeat, state.config.smallBlind, 'smallBlind');
  postBlind(state, bbSeat, state.config.bigBlind, 'bigBlind');

  // 即使大盲筹码不足，其他人也要按完整大盲跟注
  state.currentBet = state.config.bigBlind;
  state.minRaise = state.config.bigBlind;

  return beginStreet(state, nextInHand(state, bbSeat));
}

function postBlind(state, seatIdx, amount, reason) {
  const seat = state.seats[seatIdx];
  const paid = Math.min(amount, seat.stack);
  seat.stack -= paid;
  seat.streetBet += paid;
  seat.committed += paid;
  if (seat.stack === 0) seat.allIn = true;
  // 盲注不算"主动行动"，所以 hasActed 保持 false —— 大盲在所有人跟注后仍有加注权。
  state.events.push({ type: 'postBlind', seat: seatIdx, amount: paid, blind: reason });
  state.log.push({ hand: state.handNumber, text: `${seat.name} 下${reason === 'smallBlind' ? '小' : '大'}盲 ${paid}` });
}

// ---------------------------------------------------------------------------
// 街道流转
// ---------------------------------------------------------------------------

/**
 * 进入一条新的下注街：重置单街下注额，然后从指定座位开始收集行动顺序。
 * 如果只剩一个（或零个）还能行动的玩家，就没有下注可言，直接推进。
 */
function beginStreet(state, firstToActSeat) {
  const actionable = orderFrom(state, firstToActSeat, canAct);

  if (actionable.length <= 1) {
    // 所有人都 all-in 了，或者只有一个人还有筹码 —— 把公共牌直接发完再比牌。
    state.pendingActors = [];
    state.toAct = null;
    return endStreet(state);
  }

  state.pendingActors = actionable.map((s) => s.index);
  state.toAct = state.pendingActors[0];
  state.events.push({
    type: 'streetStart',
    street: state.phase,
    toAct: state.toAct,
  });
  return state;
}

function endStreet(state) {
  state.events.push({ type: 'streetEnd', street: state.phase });

  for (const seat of state.seats) {
    seat.streetBet = 0;
    seat.hasActed = false;
  }
  state.currentBet = 0;
  state.minRaise = state.config.bigBlind;
  state.cannotRaise = [];
  state.lastAggressor = null;
  computePots(state);

  if (state.phase === PHASES.RIVER) {
    return showdown(state);
  }

  const next = STREET_AFTER[state.phase];
  state.phase = next;
  const count = next === PHASES.FLOP ? 3 : 1;
  for (let i = 0; i < count; i++) state.board.push(state.deck.pop());
  state.events.push({
    type: 'dealBoard',
    street: next,
    cards: state.board.slice(-count),
  });

  // 翻牌后由按钮左边的第一个玩家先行动
  return beginStreet(state, nextInHand(state, state.buttonSeat));
}

// ---------------------------------------------------------------------------
// 行动推进
// ---------------------------------------------------------------------------

function advance(state) {
  const actor = state.toAct;
  state.pendingActors = state.pendingActors.filter((i) => i !== actor);

  const contested = contestedSeats(state);
  if (contested.length <= 1) {
    return finishByFold(state, contested[0]);
  }
  if (state.pendingActors.length === 0) {
    return endStreet(state);
  }
  state.toAct = state.pendingActors[0];
  return state;
}

/** 弃牌到只剩一个人，直接结算。 */
function finishByFold(state, winner) {
  computePots(state);
  const total = state.pots.reduce((sum, p) => sum + p.amount, 0);
  winner.stack += total;

  state.phase = PHASES.HAND_OVER;
  state.toAct = null;
  state.pendingActors = [];
  state.result = {
    type: 'fold',
    pots: state.pots.map((p) => ({ ...p })),
    winners: [{ seat: winner.index, amount: total }],
    shown: [],
  };
  state.events.push({ type: 'handOver', reason: 'fold' });
  state.log.push({
    hand: state.handNumber,
    text: `其他人都弃牌，${winner.name} 赢得 ${total}`,
  });
  recordSessionHand(state);
  return state;
}

/**
 * 一手牌结束后把每个人的筹码记进账本。
 * 只存"每手之后的余额"，不存每一笔下注 —— 后者是回放数据，
 * 体量大得多，而且当前的走势图用不上。
 */
function recordSessionHand(state) {
  state.session.hands += 1;
  for (const seat of state.seats) {
    const stats = state.session.seats[seat.index];
    stats.history.push(seat.stack);
    if (stats.history.length > 200) stats.history.shift();
    stats.peak = Math.max(stats.peak, seat.stack);
    stats.low = Math.min(stats.low, seat.stack);
  }
  for (const winner of state.result?.winners ?? []) {
    state.session.seats[winner.seat].wins += 1;
  }
}

function showdown(state) {
  state.phase = PHASES.SHOWDOWN;
  computePots(state);

  const contested = contestedSeats(state);
  const evals = new Map();
  for (const seat of contested) {
    const score = evaluateBest([...seat.hole, ...state.board]);
    evals.set(seat.index, { score, description: describeScore(score) });
  }

  const awards = new Map();
  state.pots.forEach((pot, potIndex) => {
    let best = -1;
    for (const idx of pot.eligible) {
      const score = evals.get(idx)?.score ?? -1;
      if (score > best) best = score;
    }
    const winners = pot.eligible.filter((idx) => evals.get(idx)?.score === best);
    // 平分时余数按"按钮左手第一个"的顺序逐个分出去
    const ordered = orderFrom(state, nextInHand(state, state.buttonSeat), (s) =>
      winners.includes(s.index)
    );
    if (ordered.length === 0) return;
    const share = Math.floor(pot.amount / ordered.length);
    let remainder = pot.amount - share * ordered.length;
    for (const seat of ordered) {
      let amount = share;
      if (remainder > 0) {
        amount += 1;
        remainder -= 1;
      }
      seat.stack += amount;
      awards.set(seat.index, (awards.get(seat.index) ?? 0) + amount);
      state.events.push({
        type: 'award',
        seat: seat.index,
        amount,
        potIndex,
      });
    }
  });

  state.result = {
    type: 'showdown',
    pots: state.pots.map((p) => ({ ...p })),
    winners: [...awards.entries()].map(([seat, amount]) => ({ seat, amount })),
    shown: contested.map((seat) => ({
      seat: seat.index,
      cards: [...seat.hole],
      score: evals.get(seat.index).score,
      description: evals.get(seat.index).description,
    })),
  };
  state.toAct = null;
  state.pendingActors = [];
  state.phase = PHASES.HAND_OVER;
  state.events.push({ type: 'handOver', reason: 'showdown' });

  const lines = state.result.winners.map(
    (w) => `${state.seats[w.seat].name} 赢得 ${w.amount}（${evals.get(w.seat).description}）`
  );
  state.log.push({ hand: state.handNumber, text: lines.join('；') });
  recordSessionHand(state);
  return state;
}

// ---------------------------------------------------------------------------
// 合法行动
// ---------------------------------------------------------------------------

export function getLegalActions(state, seatIndex = state.toAct) {
  if (seatIndex === null || seatIndex === undefined) return null;
  if (state.phase === PHASES.HAND_OVER || state.phase === PHASES.IDLE) return null;

  const seat = state.seats[seatIndex];
  if (!seat || !canAct(seat)) return null;

  const owed = state.currentBet - seat.streetBet;
  const toCall = Math.max(0, Math.min(owed, seat.stack));
  const canCheck = seat.streetBet >= state.currentBet;
  const maxRaiseTo = seat.streetBet + seat.stack;
  // 翻牌后如果有人 all-in 的金额还不到一个大盲，这属于"不完整的下注"，
  // 后面的人只要补到完整大盲就算合法，而不是按 当前注额 + 最小加注 来算。
  const fullMinRaiseTo =
    state.currentBet < state.config.bigBlind
      ? state.config.bigBlind
      : state.currentBet + state.minRaise;
  const othersCanAct = state.seats.some((s) => s.index !== seatIndex && canAct(s));

  // 筹码不够做完整加注时，唯一合法的加注就是 all-in。
  const minRaiseTo = maxRaiseTo < fullMinRaiseTo ? maxRaiseTo : fullMinRaiseTo;
  const canRaise =
    othersCanAct &&
    !state.cannotRaise.includes(seatIndex) &&
    maxRaiseTo > state.currentBet;

  return {
    seat: seatIndex,
    canFold: true,
    canCheck,
    canCall: toCall > 0,
    toCall,
    canRaise,
    minRaiseTo,
    fullMinRaiseTo,
    maxRaiseTo,
    isAllInOnly: maxRaiseTo < fullMinRaiseTo,
    pot: totalPot(state),
  };
}

// ---------------------------------------------------------------------------
// 执行行动
// ---------------------------------------------------------------------------

function commit(state, seat, amount) {
  const paid = Math.min(amount, seat.stack);
  seat.stack -= paid;
  seat.streetBet += paid;
  seat.committed += paid;
  if (seat.stack === 0) seat.allIn = true;
  return paid;
}

/**
 * 记下一次行动。
 *
 * kind 是给界面用的动作类别（fold / check / call / raise / allIn），
 * 界面据此决定用哪种颜色的特效；seq 每动一次自增，界面靠它判断
 * "这是一个新动作"，从而重新播放动画 —— 光看文字会因为连续两次
 * 相同的「跟注」而漏掉第二次。
 */
function recordAction(state, seat, label, amount, kind) {
  state.actionSeq = (state.actionSeq ?? 0) + 1;
  seat.lastAction = {
    label: amount === undefined ? label : `${label} ${amount}`,
    kind,
    seq: state.actionSeq,
  };
  state.events.push({ type: 'action', seat: seat.index, action: label, amount });
  state.log.push({ hand: state.handNumber, text: `${seat.name} ${amount !== undefined ? `${label} ${amount}` : label}` });
}

/**
 * 处理一次加注。
 *
 * 判断"完整加注"看的是增量：增量 >= 上一次的加注增量才算完整加注。
 * 完整加注会重置所有人的 hasActed（下注轮重开）；不足额的 all-in 不会，
 * 已经行动过的玩家因此只能跟注或弃牌。
 */
function applyRaise(state, seatIdx, targetTotal) {
  const seat = state.seats[seatIdx];
  const increment = targetTotal - state.currentBet;
  const isFullRaise = increment >= state.minRaise;

  const previouslyActed = [];
  if (!isFullRaise) {
    for (const s of state.seats) {
      if (s.index !== seatIdx && canAct(s) && s.hasActed) previouslyActed.push(s.index);
    }
  }

  commit(state, seat, targetTotal - seat.streetBet);
  seat.hasActed = true;
  state.currentBet = seat.streetBet;
  state.lastAggressor = seatIdx;

  if (isFullRaise) {
    state.minRaise = increment;
    for (const s of state.seats) {
      if (s.index !== seatIdx && canAct(s)) s.hasActed = false;
    }
    state.cannotRaise = [];
  } else {
    state.cannotRaise = [...new Set([...state.cannotRaise, ...previouslyActed])];
  }

  // 从加注者左手开始重新收集本轮还需要行动的玩家
  state.pendingActors = orderFrom(state, nextInHand(state, seatIdx), (s) => {
    if (!canAct(s)) return false;
    // 还没跟平当前注额，或者本街还没行动过（比如大盲的加注权），都要给行动机会
    return s.streetBet < state.currentBet || !s.hasActed;
  }).map((s) => s.index);
}

export function applyAction(prev, action, rng = defaultRng()) {
  void rng;
  const state = clone(prev);
  state.events = [];

  if (state.phase === PHASES.HAND_OVER || state.phase === PHASES.IDLE) {
    throw new Error('当前没有进行中的牌局');
  }

  const seatIdx = action.seat ?? state.toAct;
  if (seatIdx === null || seatIdx === undefined) throw new Error('现在没有轮到任何人行动');
  if (seatIdx !== state.toAct) throw new Error(`还没轮到座位 ${seatIdx} 行动`);

  const seat = state.seats[seatIdx];
  const legal = getLegalActions(state, seatIdx);
  const type = action.type;

  switch (type) {
    case ACTION_TYPES.FOLD: {
      seat.folded = true;
      seat.hasActed = true;
      recordAction(state, seat, '弃牌', undefined, 'fold');
      return advance(state);
    }

    case ACTION_TYPES.CHECK: {
      if (!legal.canCheck) throw new Error('有人下注，不能过牌');
      seat.hasActed = true;
      recordAction(state, seat, '过牌', undefined, 'check');
      return advance(state);
    }

    case ACTION_TYPES.CALL: {
      if (!legal.canCall) {
        // 不需要跟注时按过牌处理，界面上的"跟注"按钮在此时就是过牌
        if (legal.canCheck) {
          seat.hasActed = true;
          recordAction(state, seat, '过牌', undefined, 'check');
          return advance(state);
        }
        throw new Error('没有可跟注的金额');
      }
      const paid = commit(state, seat, legal.toCall);
      seat.hasActed = true;
      recordAction(state, seat, seat.allIn ? '全下跟注' : '跟注', paid, seat.allIn ? 'allIn' : 'call');
      return advance(state);
    }

    case ACTION_TYPES.RAISE: {
      if (!legal.canRaise) throw new Error('当前不允许加注');
      const target = Math.round(action.amount ?? 0);
      if (target < legal.minRaiseTo || target > legal.maxRaiseTo) {
        throw new Error(`加注额必须在 ${legal.minRaiseTo} 到 ${legal.maxRaiseTo} 之间`);
      }
      applyRaise(state, seatIdx, target);
      recordAction(
        state,
        seat,
        state.currentBet === target && seat.allIn ? '全下加注' : '加注到',
        target,
        seat.allIn ? 'allIn' : 'raise'
      );
      return advance(state);
    }

    case ACTION_TYPES.ALL_IN: {
      const target = legal.maxRaiseTo;
      if (target <= state.currentBet) {
        // 筹码不够跟注，就是一次短码跟注
        const paid = commit(state, seat, legal.toCall);
        seat.hasActed = true;
        recordAction(state, seat, '全下跟注', paid, 'allIn');
        return advance(state);
      }
      applyRaise(state, seatIdx, target);
      recordAction(state, seat, '全下', target, 'allIn');
      return advance(state);
    }

    default:
      throw new Error(`未知的行动类型: ${type}`);
  }
}

// ---------------------------------------------------------------------------
// 便捷查询
// ---------------------------------------------------------------------------

export function humanSeat(state) {
  return state.seats.find((s) => s.isHuman) ?? state.seats[0];
}

export function isHandOver(state) {
  return state.phase === PHASES.HAND_OVER || state.phase === PHASES.IDLE;
}

/** 每个座位在这一手里的净盈亏，给结算界面用。 */
export function netBySeat(state) {
  return state.seats.map((s) => ({
    seat: s.index,
    net: s.stack - s.startStack,
  }));
}
