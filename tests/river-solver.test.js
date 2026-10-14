import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCards } from '../src/core/cards.js';
import { HAND_RANK } from '../src/core/hand-rank.js';
import { initialWeights } from '../src/core/equity.js';
import { solveRiver } from '../src/core/river-solver.js';

const board = parseCards('Qs 7d 2c 9h 3s');
const heroWeights = initialWeights(0.25);
const oppWeights = initialWeights(0.4);

function solve(hand, extra = {}) {
  return solveRiver({
    board,
    heroWeights,
    oppWeights,
    heroClass: HAND_RANK.indexOf(hand),
    pot: 100,
    heroStack: 200,
    oppStack: 200,
    heroIsFirst: false,
    opponentChecked: true,
    ...extra,
  });
}

test('求解器返回的是一组合法概率', () => {
  const result = solve('QQ');
  assert.ok(result, '范围内的高牌应该能求解');
  const total = Object.values(result.strategy).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-6, `策略概率之和应该等于 1，实际 ${total}`);
  for (const [name, p] of Object.entries(result.strategy)) {
    assert.ok(p >= 0 && p <= 1, `${name} 的概率不合法：${p}`);
  }
});

test('强牌要下注，弱牌不该下注', () => {
  const nuts = solve('QQ'); // 顶三条
  const overpair = solve('AA');
  const air = solve('AKo'); // A 高，没成牌

  const aggression = (r) => (r.strategy.bet ?? 0) + (r.strategy.allin ?? 0);
  assert.ok(aggression(nuts) > 0.5, `顶三条应该主动下注，实际 ${aggression(nuts)}`);
  assert.ok(aggression(overpair) > 0.5, `超对应该主动下注，实际 ${aggression(overpair)}`);
  assert.ok(aggression(air) < 0.3, `A 高不该猛下注，实际 ${aggression(air)}`);
});

test('求解速度要能在运行时用', () => {
  const started = Date.now();
  solve('QQ');
  const elapsed = Date.now() - started;
  // 第一版每次分配矩阵要 2 秒，这个上限是防它退回去
  assert.ok(elapsed < 1500, `单次求解应该远快于 1.5 秒，实际 ${elapsed}ms`);
});

test('手牌不在假设范围里也会被补进去求解', () => {
  // 54o 不在前 25% 的近似范围里。之前这种情况直接求解失败（覆盖率只有 65%），
  // 现在会把英雄的实际手牌补进范围 —— 否则"范围模型不够准"会一直拖累求解。
  const result = solve('54o');
  assert.ok(result, '英雄的实际手牌应该总是能求解');
  const total = Object.values(result.strategy).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-6);
});

test('翻牌/转牌不求解 —— 试过，结果是错的', () => {
  // 翻牌子树只走一轮下注、对手范围收窄不足，求解器会收敛到
  // "反正对手会弃牌就无脑全下"。与其给个看起来合理实则错误的结果，
  // 不如明确拒绝，让上层回落到范围感知的启发式。
  assert.equal(
    solveRiver({
      board: parseCards('Qs 7d 2c'),
      heroWeights,
      oppWeights,
      heroClass: HAND_RANK.indexOf('QQ'),
      pot: 100,
      heroStack: 200,
      oppStack: 200,
    }),
    null
  );
});
