/**
 * 生成 169 种起手牌的强弱排序。
 *
 * 翻前范围表需要一份"从强到弱"的排序：GTO 的范围本质上是
 * "前 X% 的牌加注、接下来的 Y% 跟注"。
 *
 * 排序依据是对抗一个随机手牌的胜率（蒙特卡洛算），而不是拍脑袋的
 * 规则。这个排序会内嵌到 src/core/preflop.js 里。
 *
 * 用法：node tools/rank-hands.mjs
 */

import { makeCard, rankOf } from '../src/core/cards.js';
import { estimateEquity } from '../src/core/ai.js';
import { createSeededRng } from '../src/core/rng.js';

const RANK_CHAR = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const rng = createSeededRng(20261014);

const classes = [];
for (let a = 14; a >= 2; a--) {
  for (let b = a; b >= 2; b--) {
    if (a === b) {
      classes.push({ label: `${RANK_CHAR[a - 2]}${RANK_CHAR[b - 2]}`, hole: [makeCard(a, 0), makeCard(b, 1)] });
      continue;
    }
    classes.push({
      label: `${RANK_CHAR[a - 2]}${RANK_CHAR[b - 2]}s`,
      hole: [makeCard(a, 0), makeCard(b, 0)],
    });
    classes.push({
      label: `${RANK_CHAR[a - 2]}${RANK_CHAR[b - 2]}o`,
      hole: [makeCard(a, 1), makeCard(b, 2)],
    });
  }
}

const scored = classes.map((c) => ({
  ...c,
  equity: estimateEquity(c.hole, [], 1, 4000, rng),
}));

scored.sort((x, y) => y.equity - x.equity);

console.log(`共 ${scored.length} 种\n`);
console.log(scored.map((c) => c.label).join(' '));

// 同时写成模块，供翻后的"对抗范围"计算使用
{
  const { writeFileSync } = await import('node:fs');
  const body =
    '/**\n' +
    ' * 自动生成，请勿手改。生成脚本：tools/rank-hands.mjs\n' +
    ' *\n' +
    ' * 169 种起手牌按「对抗一个随机手牌的胜率」从强到弱排序。\n' +
    ' * 翻后估算胜率时，用它把对手的手牌限制在合理的范围里 ——\n' +
    ' * 对手主动加注的时候，他不可能拿着任意两张牌。\n' +
    ' */\n\n' +
    'export const HAND_RANK = ' +
    JSON.stringify(scored.map((c) => c.label)) +
    ';\n';
  writeFileSync('src/core/hand-rank.js', body);
  console.log(`\n已写入 src/core/hand-rank.js（${Math.round(body.length / 1024)} KB）`);
}
console.log('\n前 20 名：');
for (const c of scored.slice(0, 20)) {
  console.log(`  ${c.label.padEnd(4)} ${(c.equity * 100).toFixed(1)}%`);
}

// 顺便报告几个常用百分位，方便定范围门槛
console.log('\n百分位对应的胜率：');
for (const p of [5, 10, 15, 20, 25, 30, 40, 50]) {
  const idx = Math.round((p / 100) * scored.length) - 1;
  console.log(`  前 ${String(p).padStart(2)}%  最弱一张是 ${scored[idx].label}（${(scored[idx].equity * 100).toFixed(1)}%）`);
}
