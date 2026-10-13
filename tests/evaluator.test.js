import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCards } from '../src/core/cards.js';
import {
  CATEGORY,
  bestFive,
  categoryOf,
  describeScore,
  evaluateBest,
  evaluate5,
} from '../src/core/evaluator.js';

const score = (str) => evaluateBest(parseCards(str));

test('识别所有牌型', () => {
  assert.equal(categoryOf(score('As Ks Qs Js Ts 2c 3d')), CATEGORY.STRAIGHT_FLUSH);
  assert.equal(categoryOf(score('Ah Ad Ac As 2c 3d 4h')), CATEGORY.QUADS);
  assert.equal(categoryOf(score('Ah Ad Ac Ks Kd 2c 3d')), CATEGORY.FULL_HOUSE);
  assert.equal(categoryOf(score('Ah 2h 5h 9h Kh 2c 3d')), CATEGORY.FLUSH);
  assert.equal(categoryOf(score('9h 8d 7c 6s 5h 2c 3d')), CATEGORY.STRAIGHT);
  assert.equal(categoryOf(score('Ah Ad Ac Ks Qd 2c 3d')), CATEGORY.TRIPS);
  assert.equal(categoryOf(score('Ah Ad Kc Ks Qd 2c 3d')), CATEGORY.TWO_PAIR);
  assert.equal(categoryOf(score('Ah Ad Kc Qs Jd 2c 3d')), CATEGORY.PAIR);
  assert.equal(categoryOf(score('Ah Kd Qc Js 9d 2c 3d')), CATEGORY.HIGH_CARD);
});

test('牌型大小顺序正确', () => {
  const ordered = [
    'Ah Kd Qc Js 9d 2c 3d', // 高牌
    'Ah Ad Kc Qs Jd 2c 3d', // 一对
    'Ah Ad Kc Ks Qd 2c 3d', // 两对
    'Ah Ad Ac Ks Qd 2c 3d', // 三条
    '9h 8d 7c 6s 5h 2c 3d', // 顺子
    'Ah 2h 5h 9h Kh 2c 3d', // 同花
    'Ah Ad Ac Ks Kd 2c 3d', // 葫芦
    'Ah Ad Ac As 2c 3d 4h', // 四条
    'As Ks Qs Js Ts 2c 3d', // 同花顺
  ].map(score);

  for (let i = 1; i < ordered.length; i++) {
    assert.ok(
      ordered[i] > ordered[i - 1],
      `第 ${i} 种牌型应该大于第 ${i - 1} 种`
    );
  }
});

test('A-2-3-4-5 是顺子，且比 2-3-4-5-6 小', () => {
  const wheel = score('Ah 2d 3c 4s 5h 9c Kd');
  const sixHigh = score('2h 3d 4c 5s 6h 9c Kd');
  assert.equal(categoryOf(wheel), CATEGORY.STRAIGHT);
  assert.equal(categoryOf(sixHigh), CATEGORY.STRAIGHT);
  assert.ok(sixHigh > wheel, '6 高顺子应该大于轮子顺');
  assert.equal(score('Ah 2d 3c 4s 5h'), score('2h 3d 4c 5s 6h') - 50625);
});

test('同花顺的轮子同样按 5 高算', () => {
  const wheelFlush = score('As 2s 3s 4s 5s Kd Qc');
  assert.equal(categoryOf(wheelFlush), CATEGORY.STRAIGHT_FLUSH);
  assert.equal(describeScore(wheelFlush), '5 高同花顺');
  assert.ok(score('6s 5s 4s 3s 2s Kd Qc') > wheelFlush);
});

test('7 选 5 会挑出最强的组合', () => {
  // 手里有 A 高同花，同时公共牌组成顺子 —— 必须选同花
  const seven = score('Ah Kh Qh Jh 9h Ts 2d');
  assert.equal(categoryOf(seven), CATEGORY.FLUSH);

  // 三张 K + 两张 A 时，应该识别为葫芦 K 带 A，而不是两对
  const boat = score('Kh Kd Kc Ah Ad 2s 3s');
  assert.equal(categoryOf(boat), CATEGORY.FULL_HOUSE);
  assert.equal(describeScore(boat), '葫芦：K 带 A');
});

test('牌型描述必须是中文，不能出现英文单词', () => {
  const samples = [
    'As Ks Qs Js Ts 2c 3d', // 皇家同花顺
    'Ah Ad Ac As 2c 3d 4h', // 四条
    'Kh Kd Kc Ah Ad 2s 3s', // 葫芦
    'Ah 2h 5h 9h Kh 2c 3d', // 同花
    '9h 8d 7c 6s 5h 2c 3d', // 顺子
    'Ah Ad Ac Ks Qd 2c 3d', // 三条
    'Ah Ad Kc Ks Qd 2c 3d', // 两对
    'Ah Ad Kc Qs Jd 2c 3d', // 一对
    'Ah Kd Qc Js 9d 2c 3d', // 高牌
  ];
  for (const sample of samples) {
    const text = describeScore(score(sample));
    assert.ok(!/[A-Za-z]{2,}/.test(text), `描述里出现了英文：${text}`);
    assert.ok(text.length > 0);
  }
});

test('踢脚器决定同牌型胜负', () => {
  const kickerHigh = score('Ah Ad Kc Qs Jd 2c 3d');
  const kickerLow = score('Ah Ad Kc Qs Td 2c 3d');
  assert.ok(kickerHigh > kickerLow);

  // 公共牌就是最大牌型时双方打平
  assert.equal(score('As Ks Qs Js Ts 2c 3d'), score('As Ks Qs Js Ts 4h 5h'));
});

test('evaluate5 与 evaluateBest 在 5 张时结果一致', () => {
  const cards = parseCards('Ah Kd Qc Js 9d');
  assert.equal(evaluate5(cards), evaluateBest(cards));
});

test('bestFive 挑出的确实是构成最强牌型的那 5 张', () => {
  // 三张 K + 两张 A：最强是葫芦 K 带 A，不能把 A 之外的杂牌算进去
  const boat = parseCards('Kh Kd Kc Ah Ad 2s 3s');
  const five = bestFive(boat);
  assert.equal(five.length, 5);
  assert.equal(evaluate5(five), evaluateBest(boat));
  assert.deepEqual(
    five.map((c) => c).sort((a, b) => a - b),
    parseCards('Kh Kd Kc Ah Ad').sort((a, b) => a - b)
  );

  // 顺子：A 只作为最高张，不该被选进轮子顺
  const wheel = parseCards('Ah 2d 3c 4s 5h 9c Kd');
  assert.equal(evaluate5(bestFive(wheel)), evaluateBest(wheel));

  // 5 张时原样返回
  const exact = parseCards('Ah Kd Qc Js 9d');
  assert.equal(bestFive(exact).length, 5);
});
