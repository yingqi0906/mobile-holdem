/**
 * 检查外部范围表的结构与数据质量。
 *
 * 这份 JSON 是从截图里 OCR/提取出来的（脚本叫 _extract.py），
 * 所以先要摸清它的结构、再抽查几个已知局面判断可不可信。
 */

import { readFileSync } from 'node:fs';

const path = process.argv[2];
const data = JSON.parse(readFileSync(path, 'utf8'));
const spots = Object.keys(data);

const actions = new Map();
const tokens = new Map();
let handCounts = new Set();

for (const spot of spots) {
  for (const token of spot.split(/\s+/)) tokens.set(token, (tokens.get(token) ?? 0) + 1);
  const hands = data[spot];
  handCounts.add(Object.keys(hands).length);
  for (const [cls, dist] of Object.entries(hands)) {
    for (const [act, freq] of Object.entries(dist)) {
      const key = act;
      const cur = actions.get(key) ?? { count: 0, sum: 0, partial: 0 };
      cur.count += 1;
      cur.sum += freq;
      if (freq < 99.9) cur.partial += 1;
      actions.set(key, cur);
    }
    void cls;
  }
}

console.log(`局面数: ${spots.length}`);
console.log(`每个局面的手牌条目数: ${[...handCounts].join(', ')}`);

console.log('\n动作种类:');
for (const [name, v] of [...actions].sort((a, b) => b[1].count - a[1].count)) {
  console.log(
    `  ${name.padEnd(10)} 出现 ${String(v.count).padStart(6)} 次，其中混合频率 ${v.partial} 次`
  );
}

console.log('\n出现在局面名里的词:');
for (const [name, n] of [...tokens].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${name.padEnd(10)} ${n}`);
}

console.log('\n前 25 个局面名:');
for (const spot of spots.slice(0, 25)) console.log('  ' + spot);
