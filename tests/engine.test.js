import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTION_TYPES,
  PHASES,
  applyAction,
  createTable,
  getLegalActions,
  startHand,
  totalPot,
} from '../src/core/engine.js';
import { attachBots, decideBotAction } from '../src/core/ai.js';
import { createSeededRng } from '../src/core/rng.js';

const BB = 20;
const SB = 10;

function newTable(overrides = {}) {
  return createTable({
    smallBlind: SB,
    bigBlind: BB,
    startingStack: 1000,
    seatCount: 6,
    autoRebuy: false,
    ...overrides,
  });
}

function withStacks(state, stacks) {
  const next = structuredClone(state);
  stacks.forEach((stack, i) => {
    if (stack !== undefined) next.seats[i].stack = stack;
  });
  return next;
}

function act(state, seat, type, amount) {
  return applyAction(state, { seat, type, amount });
}

/** 一直打到这手牌结束。returnToAct 用于中途检查状态。 */
function playToEnd(state, rng, onStep) {
  let guard = 0;
  while (!isOver(state)) {
    if (++guard > 500) throw new Error('牌局没有正常结束，可能陷入死循环');
    const seat = state.toAct;
    const action = decideBotAction(state, seat, rng);
    if (!action) throw new Error(`座位 ${seat} 拿不到合法行动`);
    const next = applyAction(state, action, rng);
    if (onStep) onStep(next, action);
    state = next;
  }
  return state;
}

function isOver(state) {
  return state.phase === PHASES.HAND_OVER || state.phase === PHASES.IDLE;
}

// ---------------------------------------------------------------------------

test('翻牌前盲注、按钮位和行动顺序正确', () => {
  const rng = createSeededRng(1);
  const started = startHandFor(newTable(), rng);

  assert.equal(started.buttonSeat, 0, '第一手按钮应该在 0 号位');
  assert.equal(started.seats[1].streetBet, SB, '小盲在按钮左手');
  assert.equal(started.seats[2].streetBet, BB, '大盲在小盲左手');
  assert.equal(started.currentBet, BB);
  assert.equal(started.minRaise, BB);
  assert.equal(started.toAct, 3, '大盲左手第一个行动');
  assert.equal(started.seats.length, 6);
  for (const seat of started.seats) {
    assert.equal(seat.hole.length, 2, '每个人都应该拿到两张底牌');
  }
});

test('单挑时按钮是小盲，翻牌前先行动', () => {
  const rng = createSeededRng(7);
  const table = newTable({ seatCount: 2 });
  const started = startHandFor(table, rng);

  assert.equal(started.buttonSeat, 0);
  assert.equal(started.seats[0].streetBet, SB, '按钮位下小盲');
  assert.equal(started.seats[1].streetBet, BB);
  assert.equal(started.toAct, 0, '单挑翻牌前由小盲（按钮）先行动');
});

test('单挑时翻牌后由大盲先行动', () => {
  const rng = createSeededRng(11);
  let state = startHandFor(newTable({ seatCount: 2 }), rng);
  state = act(state, state.toAct, ACTION_TYPES.CALL); // 小盲补齐
  state = act(state, state.toAct, ACTION_TYPES.CHECK); // 大盲过牌
  assert.equal(state.phase, PHASES.FLOP);
  assert.equal(state.board.length, 3);
  assert.equal(state.toAct, 1, '翻牌后大盲先行动');
});

test('完整加注会重开下注轮，最小加注随之抬升', () => {
  const rng = createSeededRng(3);
  let state = startHandFor(newTable(), rng);

  // 3 号位加注到 60（增量 40 = 2 个大盲）
  state = act(state, 3, ACTION_TYPES.RAISE, 60);
  assert.equal(state.currentBet, 60);
  assert.equal(state.minRaise, 40, '加注增量成为新的最小加注');

  const legal = getLegalActions(state, state.toAct);
  assert.equal(legal.minRaiseTo, 100, '下一次加注至少要加到 60 + 40');
  assert.throws(() => act(state, state.toAct, ACTION_TYPES.RAISE, 80), /加注额必须/);
});

test('筹码不足的 all-in 加注不重开下注轮', () => {
  const rng = createSeededRng(5);
  // 2 号位（大盲）只有 70 筹码：下完 20 大盲后只剩 50，全下也只到 70
  const table = withStacks(newTable(), [, , 70]);
  let state = startHandFor(table, rng);

  // 先把后面三个座位弃掉，方便观察 0/1/2 的行动
  state = act(state, 3, ACTION_TYPES.FOLD);
  state = act(state, 4, ACTION_TYPES.FOLD);
  state = act(state, 5, ACTION_TYPES.FOLD);

  state = act(state, 0, ACTION_TYPES.RAISE, 60); // 完整加注，minRaise = 40
  state = act(state, 1, ACTION_TYPES.CALL); // 小盲跟注
  assert.equal(state.toAct, 2);

  state = act(state, 2, ACTION_TYPES.ALL_IN); // 全下到 70，增量只有 10
  assert.equal(state.currentBet, 70);
  assert.equal(state.minRaise, 40, '不足额全下不改变最小加注');

  // 已经行动过的 0、1 号位只能跟注或弃牌
  for (const seat of [0, 1]) {
    const legal = getLegalActions(state, seat);
    assert.equal(legal.canRaise, false, `座位 ${seat} 不应能再次加注`);
    assert.equal(legal.toCall, 10);
  }
  assert.deepEqual(state.pendingActors, [0, 1]);
});

test('边池按累计投入分层', () => {
  const rng = createSeededRng(13);
  const table = withStacks(newTable(), [100, 300, 300, 0, 0, 0]);
  let state = startHandFor(table, rng);

  state = act(state, 0, ACTION_TYPES.ALL_IN); // 全下 100
  state = act(state, 1, ACTION_TYPES.ALL_IN); // 小盲全下 300
  state = act(state, 2, ACTION_TYPES.CALL); // 大盲跟到 300
  state = playToEnd(state, rng);

  assert.equal(state.phase, PHASES.HAND_OVER);
  assert.equal(state.pots.length, 2, '应该产生主池 + 一个边池');
  assert.equal(state.pots[0].amount, 300);
  assert.deepEqual(state.pots[0].eligible, [0, 1, 2]);
  assert.equal(state.pots[1].amount, 400);
  assert.deepEqual(state.pots[1].eligible, [1, 2], '短码玩家不参与边池');
});

test('无人跟注的多余下注会退回', () => {
  const rng = createSeededRng(17);
  const table = withStacks(newTable({ seatCount: 2 }), [1000, 200]);
  let state = startHandFor(table, rng);

  // 按钮（小盲）加注到 500，大盲只有 200 全下跟注
  state = act(state, 0, ACTION_TYPES.RAISE, 500);
  state = act(state, 1, ACTION_TYPES.ALL_IN);
  state = playToEnd(state, rng);

  const returned = state.pots.find((p) => p.eligible.length === 1);
  assert.ok(returned, '多出来的 300 应该单独成池退回');
  assert.equal(returned.amount, 300);
  assert.deepEqual(returned.eligible, [0]);
});

test('所有人都弃牌时最后一人直接赢下底池', () => {
  const rng = createSeededRng(19);
  let state = startHandFor(newTable(), rng);

  state = act(state, 3, ACTION_TYPES.FOLD);
  state = act(state, 4, ACTION_TYPES.FOLD);
  state = act(state, 5, ACTION_TYPES.FOLD);
  state = act(state, 0, ACTION_TYPES.FOLD);
  state = act(state, 1, ACTION_TYPES.FOLD); // 小盲弃牌

  assert.equal(state.phase, PHASES.HAND_OVER);
  assert.equal(state.result.type, 'fold');
  assert.equal(state.result.winners[0].seat, 2, '大盲不战而胜');
  assert.equal(state.result.winners[0].amount, 30, '赢下小盲 10 + 大盲 20');
});

test('过牌不加注时下注轮正常结束', () => {
  const rng = createSeededRng(23);
  let state = startHandFor(newTable(), rng);
  const order = [];
  while (state.phase === PHASES.PREFLOP) {
    order.push(state.toAct);
    state = act(state, state.toAct, ACTION_TYPES.CALL);
  }
  assert.deepEqual(order, [3, 4, 5, 0, 1, 2], '大盲最后行动并保留加注权');
  assert.equal(state.phase, PHASES.FLOP);
  assert.equal(state.board.length, 3);
});

test('过牌到最后一条街会进入 showdown 并结算', () => {
  const rng = createSeededRng(29);
  let state = startHandFor(newTable(), rng);
  let guard = 0;
  while (!isOver(state)) {
    if (++guard > 200) throw new Error('牌局没有结束');
    const legal = getLegalActions(state, state.toAct);
    state = act(state, state.toAct, legal.canCheck ? ACTION_TYPES.CHECK : ACTION_TYPES.CALL);
  }
  assert.equal(state.result.type, 'showdown');
  assert.equal(state.board.length, 5);
  const awarded = state.result.winners.reduce((sum, w) => sum + w.amount, 0);
  assert.equal(awarded, totalPot(state), '派发的筹码必须等于底池总额');
  assert.ok(state.result.shown.length >= 2, '至少两个人亮牌');
});

test('非法行动会被拒绝', () => {
  const rng = createSeededRng(31);
  const state = startHandFor(newTable(), rng);
  assert.throws(() => act(state, 0, ACTION_TYPES.FOLD), /还没轮到/);
  assert.throws(() => act(state, 3, ACTION_TYPES.CHECK), /不能过牌/);
  assert.throws(() => act(state, 3, ACTION_TYPES.RAISE, 21), /加注额必须/);
  assert.throws(() => act(state, 3, ACTION_TYPES.RAISE, 999999), /加注额必须/);
});

test('一手牌结束后不能再继续行动', () => {
  const rng = createSeededRng(37);
  let state = startHandFor(newTable(), rng);
  for (const seat of [3, 4, 5, 0, 1]) {
    state = act(state, seat, ACTION_TYPES.FOLD);
  }
  assert.throws(() => act(state, 2, ACTION_TYPES.CHECK), /没有进行中的牌局/);
});

test('随机对抗：多张桌子轮流打到散场，筹码始终守恒', () => {
  const rng = createSeededRng(2026);
  let hands = 0;
  let tables = 0;
  let showdowns = 0;

  // 机器人打得很凶，一张 100BB 的桌子几十手就会散场，
  // 所以这里换桌重来，累计跑够足够多手牌。
  while (hands < 800 && tables < 80) {
    tables++;
    let state = attachBots(newTable({ startingStack: 2000 }), createSeededRng(900 + tables));
    const initialTotal = state.seats.reduce((sum, s) => sum + s.stack, 0);

    for (let i = 0; i < 300; i++) {
      state = startHandFor(state, rng, true);
      if (state.phase === PHASES.IDLE) break;
      hands++;
      state = playToEnd(state, rng);
      if (state.result?.type === 'showdown') showdowns++;

      assert.equal(
        state.seats.reduce((sum, s) => sum + s.stack, 0),
        initialTotal,
        `第 ${hands} 手之后筹码不守恒`
      );
      assert.ok(state.seats.every((s) => s.stack >= 0), '筹码不能为负');
      assert.ok(state.seats.every((s) => s.committed >= 0), '投入不能为负');
      assert.ok(
        state.seats.every((s) => s.hole.length === 0 || s.hole.length === 2),
        '底牌数量异常'
      );
    }
  }

  assert.ok(hands >= 800, `应该跑完足够多手牌，实际只有 ${hands}`);
  // 阈值放宽过：换成 GTO 翻前范围表之后机器人紧了很多，
  // 大部分牌局在翻前就结束了，摊牌比例自然下降
  assert.ok(showdowns > 15, `应该有牌打到亮牌，实际 ${showdowns}`);
});

// startHand 在 engine.js 里，这里包一层只为让上面的辅助函数读起来顺一点。
function startHandFor(state, rng, allowEnd = false) {
  const next = startHand(state, rng);
  if (!allowEnd && next.phase === PHASES.IDLE) {
    throw new Error('牌局无法开始');
  }
  return next;
}

test('引擎账本记录每个人的筹码走势', () => {
  const rng = createSeededRng(41);
  let state = attachBots(newTable(), createSeededRng(41));

  for (let i = 0; i < 6; i++) {
    state = startHandFor(state, rng, true);
    if (state.phase === PHASES.IDLE) break;
    state = playToEnd(state, rng);
  }

  assert.ok(state.session.hands > 0, '应该记录了打过的手数');
  for (const stats of state.session.seats) {
    assert.equal(
      stats.history.length,
      state.session.hands + 1,
      '账本应该是「起始一个点 + 每手一个点」'
    );
    assert.equal(stats.buyIn, 1000, '没补过码的话买入就是起始筹码');
    assert.ok(stats.peak >= stats.low, '最高不该低于最低');
    assert.equal(
      stats.history[stats.history.length - 1],
      state.seats[stats.index].stack,
      '账本最后一个点应该等于当前筹码'
    );
  }
});

test('自动补码会记进引擎账本', () => {
  const rng = createSeededRng(43);
  const table = createTable({
    smallBlind: 1,
    bigBlind: 2,
    startingStack: 200,
    seatCount: 6,
    autoRebuy: true,
  });
  let state = startHandFor(table, rng);
  state = playToEnd(state, rng);

  // 把 2 号座位打光，下一手应该补码
  state.seats[2].stack = 0;
  const beforeBuyIn = state.session.seats[2].buyIn;
  state = startHandFor(state, rng);

  assert.equal(state.session.seats[2].buyIn, beforeBuyIn + 200, '补码要计进买入');
  assert.ok(state.seats[2].stack >= 198, '补码后扣掉盲注也应该是满仓附近');
});
