/**
 * 把一个局面的范围表打成 13×13 的格子，方便肉眼核对。
 * 用法：node tools/show-range.mjs <json> [局面名关键字]
 */

import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const filter = process.argv[3];
const spots = Object.keys(data);

if (!filter) {
  // 没给关键字就按词数分组，看看覆盖了哪些层级
  const byLength = new Map();
  for (const spot of spots) {
    const n = spot.split(/\s+/).length;
    if (!byLength.has(n)) byLength.set(n, []);
    byLength.get(n).push(spot);
  }
  for (const n of [...byLength.keys()].sort((a, b) => a - b)) {
    console.log(`\n${n} 个词的局面（${byLength.get(n).length} 个）:`);
    for (const s of byLength.get(n).slice(0, 6)) console.log('  ' + s);
  }
  process.exit(0);
}

const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];

/**
 * 数据里的写法：同花是大牌在前（AKs），非同花反过来（KAo 表示 AKo）。
 * 格子按行列取键时，上三角（行序 < 列序）是同花、下三角是非同花。
 */
function cellKey(ri, ci) {
  if (ri === ci) return RANKS[ri] + RANKS[ci];
  return RANKS[ri] + RANKS[ci] + (ri < ci ? 's' : 'o');
}

// 完全匹配优先，否则再按包含匹配
const exact = spots.filter((s) => s.toLowerCase() === filter.toLowerCase());
const matches = exact.length
  ? exact
  : spots.filter((s) => s.toLowerCase().includes(filter.toLowerCase()));
if (matches.length === 0) {
  console.log('没有匹配的局面。含该词的有：');
  for (const s of spots.filter((x) => x.toLowerCase().includes(filter.toLowerCase().slice(0, 3))).slice(0, 10)) {
    console.log('  ' + s);
  }
  process.exit(0);
}

for (const spot of matches.slice(0, 3)) {
  console.log(`\n=== ${spot} ===`);
  const hands = data[spot];
  const header = '    ' + RANKS.map((r) => r.padStart(4)).join('');
  console.log(header);
  for (let ri = 0; ri < 13; ri++) {
    const row = [];
    for (let ci = 0; ci < 13; ci++) {
      const dist = hands[cellKey(ri, ci)] ?? {};
      const main = Object.entries(dist).sort((a, b) => b[1] - a[1])[0];
      if (!main) {
        row.push('   ?');
        continue;
      }
      const [act, freq] = main;
      const mark = act === 'fold' ? '·' : act === 'allin' ? 'A' : act === 'raise' ? 'R' : act === 'call' ? 'C' : '?';
      row.push(freq >= 99.9 ? `   ${mark}` : ` ${mark}${String(Math.round(freq)).padStart(2)}`);
    }
    console.log(RANKS[ri].padStart(3) + ' ' + row.join(''));
  }
  console.log('  图例：R=加注 C=跟注 A=全下 ·=弃牌，数字是主频率百分比');
}
