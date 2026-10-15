import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCards } from '../src/core/cards.js';
import { createTable } from '../src/core/engine.js';
import {
  effectiveStack,
  geometricFraction,
  streetPlan,
  turnBarrelFactor,
  turnCardClass,
} from '../src/core/plan.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('等比尺度：解 (1+2f)^n = 1+2*SPR', () => {
  // 三条街、SPR 13：正好 100% 底池一条街，是最深的能"刚好打光"的深度
  close(geometricFraction(13, 3), 1);
  // 三条街、SPR 3.5：8^(1/3)=2，f=0.5
  close(geometricFraction(3.5, 3), 0.5);
  // 两条街、SPR 3.5：8^(1/2)=2.828，f=(2.828-1)/2
  close(geometricFraction(3.5, 2), (Math.sqrt(8) - 1) / 2);
  // 一条街：直接就是 SPR（河牌全下）
  close(geometricFraction(2.5, 1), 2.5);
});

test('等比尺度：越深越大、街越少越大', () => {
  assert.ok(geometricFraction(6, 3) > geometricFraction(3, 3));
  assert.ok(geometricFraction(4, 2) > geometricFraction(4, 3));
  assert.equal(geometricFraction(0, 3), 0);
  assert.equal(geometricFraction(5, 0), 0);
});

test('尺度计划：深筹码不强行规划，中低筹码抬到等比尺度', () => {
  // SPR 10：超过 PLAN_MAX_SPR，沿用牌面尺度
  const deep = streetPlan({ street: 'flop', pot: 100, stack: 1000, textureFraction: 0.3 });
  assert.equal(deep.fraction, 0.3);
  assert.equal(deep.commit, false);

  // SPR 4、三条街：等比尺度 0.54 > 牌面尺度 0.3，采用 0.54
  const mid = streetPlan({ street: 'flop', pot: 100, stack: 400, textureFraction: 0.3 });
  close(mid.fraction, (Math.cbrt(9) - 1) / 2);
  assert.ok(mid.fraction > 0.3);
  assert.equal(mid.commit, false);

  // 湿面上的大尺度不会被计划层压小
  const wet = streetPlan({ street: 'flop', pot: 100, stack: 400, textureFraction: 0.75 });
  assert.equal(wet.fraction, 0.75);

  // SPR 1.4：进入打光区间（1.4 倍池的全下还在强牌能撑住的范围内）
  const low = streetPlan({ street: 'flop', pot: 100, stack: 140, textureFraction: 0.3 });
  assert.equal(low.commit, true);
  // SPR 2.2：不打光，走等比尺度
  const aboveCommit = streetPlan({ street: 'flop', pot: 100, stack: 220, textureFraction: 0.3 });
  assert.equal(aboveCommit.commit, false);
});

test('尺度计划：转牌两条街，等比尺度封顶 100%', () => {
  const turn = streetPlan({ street: 'turn', pot: 100, stack: 550, textureFraction: 0.3 });
  assert.equal(turn.fraction, 1); // 不引入超池
  assert.equal(turn.commit, false);
  // 转牌、SPR 1.5：等比尺度 0.5 比牌面尺度 0.6 小，采用牌面尺度；同时已进入打光区间
  const turnLow = streetPlan({ street: 'turn', pot: 100, stack: 150, textureFraction: 0.6 });
  assert.equal(turnLow.commit, true); // SPR 1.5 正好在打光阈值上
  close(turnLow.fraction, 0.6);
});

test('有效筹码：取自己与所有未弃牌对手里最少的一个', () => {
  const table = createTable({
    smallBlind: 5,
    bigBlind: 10,
    startingStack: 100,
    seatCount: 4,
    autoRebuy: false,
  });
  const state = structuredClone(table);
  for (const seat of state.seats) {
    seat.inHand = true;
    seat.folded = false;
  }
  state.seats[0].stack = 300;
  state.seats[1].stack = 120;
  state.seats[2].stack = 80;
  state.seats[3].stack = 250;
  assert.equal(effectiveStack(state, 0), 80);

  state.seats[2].folded = true; // 弃牌的座位不算
  assert.equal(effectiveStack(state, 0), 120);
});

test('转牌分类：同花做成、顺子做成、大牌、白板', () => {
  const flush = turnCardClass(parseCards('Ah Kh 2c'), parseCards('Ah Kh 2c 7h'));
  assert.equal(flush, 'completed');

  const straight = turnCardClass(parseCards('6c 7d 8h'), parseCards('6c 7d 8h 9s'));
  assert.equal(straight, 'completed');

  const overcard = turnCardClass(parseCards('2c 5d 9h'), parseCards('2c 5d 9h Qs'));
  assert.equal(overcard, 'overcard');

  const blank = turnCardClass(parseCards('2c 5d 9h'), parseCards('2c 5d 9h 3s'));
  assert.equal(blank, 'blank');

  // 翻牌就已经三张同花：转牌再来一张不算"做成"
  const alreadyFlushy = turnCardClass(parseCards('2h 5h 9h'), parseCards('2h 5h 9h 3s'));
  assert.equal(alreadyFlushy, 'blank');
});

test('转牌诈唬倍率：做成听牌的牌放弃，大牌继续', () => {
  assert.equal(turnBarrelFactor(parseCards('Ah Kh 2c'), parseCards('Ah Kh 2c 7h')).factor, 0.35);
  assert.equal(turnBarrelFactor(parseCards('2c 5d 9h'), parseCards('2c 5d 9h Qs')).factor, 1.15);
  assert.equal(turnBarrelFactor(parseCards('2c 5d 9h'), parseCards('2c 5d 9h 3s')).factor, 1);
});