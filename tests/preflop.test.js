import test from 'node:test';
import assert from 'node:assert/strict';

import { makeCard, parseCards } from '../src/core/cards.js';
import { PHASES, createTable, startHand } from '../src/core/engine.js';
import { handClass, parseRange, positionOf, preflopAdvice, rangeInfo } from '../src/core/preflop.js';
import { advise, reviewDecision } from '../src/core/coach.js';
import { createSeededRng } from '../src/core/rng.js';

const seeded = () => createSeededRng(99);

test('范围记号的解析符合标准写法', () => {
  // ATo+ 是"高张固定、另一张往上"，不是变动高张
  assert.deepEqual(
    [...parseRange('ATo+').keys()].sort(),
    ['AKo', 'AJo', 'AQo', 'ATo'].sort()
  );
  assert.equal(parseRange('22+').size, 13);
  assert.deepEqual([...parseRange('KTs+').keys()].sort(), ['KJs', 'KQs', 'KTs'].sort());
  assert.equal(parseRange('72o').size, 1);
  // 混合频率
  assert.equal(parseRange('A5s:0.5').get('A5s'), 0.5);
});

test('手牌归类正确', () => {
  assert.equal(handClass([makeCard(14, 0), makeCard(13, 0)]), 'AKs');
  assert.equal(handClass([makeCard(14, 0), makeCard(13, 1)]), 'AKo');
  assert.equal(handClass([makeCard(7, 2), makeCard(7, 0)]), '77');
  assert.equal(handClass([makeCard(3, 1), makeCard(14, 2)]), 'A3o');
});

test('开局范围宽度落在合理区间，且按位置递增', () => {
  const w = rangeInfo();
  assert.ok(w.UTG > 12 && w.UTG < 20, `UTG 应该在 12~20%，实际 ${w.UTG}`);
  assert.ok(w.BTN > 35 && w.BTN < 55, `BTN 应该在 35~55%，实际 ${w.BTN}`);
  assert.ok(w.UTG < w.HJ && w.HJ < w.CO && w.CO < w.BTN, '位置越靠后范围越宽');
});

function preflopState(holeForSeat, seatIdx) {
  const state = startHand(createTable({ smallBlind: 1, bigBlind: 2, startingStack: 200, seatCount: 6 }), seeded());
  state.seats[seatIdx].hole = parseCards(holeForSeat);
  return state;
}

test('位置是按按钮顺时针算出来的', () => {
  const state = preflopState('As Ks', 0);
  // 第一手按钮在 0 号位
  assert.equal(state.buttonSeat, 0);
  assert.equal(positionOf(state, 0), 'BTN');
  assert.equal(positionOf(state, 1), 'SB');
  assert.equal(positionOf(state, 2), 'BB');
  assert.equal(positionOf(state, 3), 'UTG');
});

test('翻前建议：AA 任何位置都加注，72o 直接弃', () => {
  const aces = preflopState('As Ah', 3); // UTG
  assert.equal(preflopAdvice(aces, 3, seeded()).action, 'raise');

  const trash = preflopState('7s 2h', 3);
  assert.equal(preflopAdvice(trash, 3, seeded()).action, 'fold');
});

test('翻前建议：同一手牌在庄家位能玩，在枪口位弃掉', () => {
  // K9s 在按钮位范围内，但不在枪口位范围内
  const utg = preflopState('Ks 9s', 3);
  const btn = preflopState('Ks 9s', 0);
  assert.equal(preflopAdvice(utg, 3, seeded()).action, 'fold');
  assert.equal(preflopAdvice(btn, 0, seeded()).action, 'raise');
});

test('教练给出的建议和 AI 用的是同一套翻前逻辑', () => {
  const state = preflopState('As Ah', 3);
  const advice = advise(state, 3, seeded());
  assert.equal(advice.street, '翻前');
  assert.equal(advice.action, 'raise');
  assert.equal(advice.handClass, 'AA');
  assert.ok(advice.reasons.length >= 1, '应该给出解析');
});

test('复盘：该弃却跟注会被标成问题', () => {
  // 造一个翻后局面：底池很大、要跟很多，胜率明显不够
  const state = preflopState('7s 2h', 3);
  state.phase = PHASES.FLOP;
  state.board = parseCards('As Ks Qh');
  state.seats[3].streetBet = 0;
  state.currentBet = 60;
  state.seats[4].streetBet = 60;
  state.seats[4].committed = 60;
  state.toAct = 3;

  const advice = advise(state, 3, seeded());
  assert.equal(advice.action, 'fold', `72o 在 A K Q 面上应该弃牌，实际 ${advice.action}`);

  const review = reviewDecision(state, 3, { type: 'call' }, advice);
  assert.equal(review.grade, 'mistake');
  assert.match(review.title, /跟注/);
  assert.match(review.detail, /胜率/);
});

test('复盘：建议加注而你打了同方向的动作，算处理得当', () => {
  const state = preflopState('As Ah', 3);
  const advice = advise(state, 3, seeded());
  const review = reviewDecision(state, 3, { type: 'raise', amount: 5 }, advice);
  assert.equal(review.grade, 'good');
});
