/**
 * 把外部 GTO 范围表编译成项目内嵌的紧凑格式。
 *
 * 数据来源：用户提供的「翻前范围表.rar」里的 _extracted.json
 * （292 个局面的完整策略，从求解器截图提取）。原始文件 1.2MB，直接内嵌太大，
 * 这里只保留非弃牌的部分，并且用 0~168 的手牌下标代替字符串。
 *
 * 用法：node tools/build-preflop-table.mjs <_extracted.json>
 */

import { readFileSync, writeFileSync } from 'node:fs';

const src = process.argv[2];
if (!src) {
  console.error('用法: node tools/build-preflop-table.mjs <_extracted.json>');
  process.exit(1);
}

const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];

// 169 种手牌的固定顺序，和 src/core/preflop.js 的 handClass 一致
const ORDER = [];
const INDEX = new Map();
for (let i = 0; i < 13; i++) {
  for (let j = i; j < 13; j++) {
    const label = i === j ? RANKS[i] + RANKS[j] : RANKS[i] + RANKS[j] + 's';
    INDEX.set(label, ORDER.length);
    ORDER.push(label);
  }
}
for (let i = 0; i < 13; i++) {
  for (let j = i + 1; j < 13; j++) {
    // i 是大牌（RANKS[0] 是 A），所以规范写法是大牌在前
    const label = RANKS[i] + RANKS[j] + 'o';
    INDEX.set(label, ORDER.length);
    ORDER.push(label);
  }
}

/** 原始数据里非同花是小牌在前（KAo），这里统一成大牌在前（AKo）。 */
function canon(hand) {
  if (hand.length !== 3) return hand;
  const [a, b, suffix] = hand;
  if (suffix !== 'o') return hand;
  return RANKS.indexOf(a) > RANKS.indexOf(b) ? b + a + 'o' : hand;
}

const raw = JSON.parse(readFileSync(src, 'utf8'));
const spots = {};
let kept = 0;
let skipped = 0;

for (const [name, grid] of Object.entries(raw)) {
  const key = name.trim().toLowerCase().replace(/\s+/g, ' ');
  const entries = [];
  for (const [hand, dist] of Object.entries(grid)) {
    const label = canon(hand);
    const idx = INDEX.get(label);
    if (idx === undefined) throw new Error(`未知手牌写法: ${hand}`);

    const raise = Math.round(dist.raise ?? 0);
    let call = Math.round(dist.call ?? 0);
    const allin = Math.round(dist.allin ?? 0);
    // 小到可以忽略的频率直接抹掉，避免策略被提取噪声支配
    const r = raise < 2 ? 0 : raise;
    const a = allin < 5 ? 0 : allin;
    const c = call < 2 ? 0 : call;
    if (r + c + a === 0) continue;
    entries.push([idx, r, c, a]);
    kept += 1;
  }
  if (entries.length === 0) skipped += 1;
  spots[key] = entries;
}

/**
 * 数据校验。
 *
 * 这份 JSON 是 OCR 出来的，实测在**深层节点**（含冷跟再挤压的 4bet/5bet 子树）
 * 有明显错误 —— 292 个局面里有 64 个把 AA 标成"纯弃牌"，现实中不可能。
 * 但浅层节点（开局、面对开局、面对再加注）全部正确。
 *
 * 所以这里做一道硬校验：AA 和 KK 必须总是继续（加注+跟注+全下 ≥ 95%）。
 * 不合格的局面直接丢弃，运行时回落到项目自带的范围表。
 */
let dropped = 0;
const droppedNames = [];
for (const [key, entries] of Object.entries(spots)) {
  const byHand = new Map(entries.map((e) => [e[0], e]));
  const continues = (hand) => {
    const e = byHand.get(INDEX.get(hand));
    return e ? e[1] + e[2] + e[3] : 0;
  };
  if (continues('AA') < 95 || continues('KK') < 95) {
    delete spots[key];
    dropped += 1;
    if (droppedNames.length < 5) droppedNames.push(key);
  }
}

const body =
  '/**\n' +
  ' * 自动生成，请勿手改。生成脚本：tools/build-preflop-table.mjs\n' +
  ' *\n' +
  ' * 数据来源：外部 GTO 求解器导出的翻前范围表（292 个局面）。\n' +
  ' * 每条记录是 [手牌下标, 加注%, 跟注%, 全下%]，剩下的就是弃牌概率。\n' +
  ' * 只收录了非弃牌的条目。\n' +
  ' */\n\n' +
  'export const HAND_ORDER = ' +
  JSON.stringify(ORDER) +
  ';\n\n' +
  'export const PREFLOP_SPOTS = ' +
  JSON.stringify(spots) +
  ';\n';

writeFileSync('src/core/preflop-ranges.js', body);
console.log(`局面数 ${Object.keys(spots).length}，收录条目 ${kept}，空局面 ${skipped}`);
console.log(`校验剔除 ${dropped} 个局面${dropped ? '（例如 ' + droppedNames.join(' | ') + '）' : ''}`);
console.log(`输出大小 ${Math.round(body.length / 1024)} KB`);
console.log(`示例 utg:`, JSON.stringify(spots.utg?.slice(0, 3)));
