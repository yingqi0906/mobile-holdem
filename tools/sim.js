/**
 * 单人桌模拟器：让 6 个机器人互相对打 N 手，输出统计。
 *
 * 这不是"测试"，而是用来观察 AI 行为是否合理的手段 ——
 * 比如某个人赢率长期超过 40%，或者平均底池异常大，就说明策略有问题。
 *
 * 用法：npm run sim -- 5000
 */

import { PHASES, applyAction, createTable, startHand, totalPot } from '../src/core/engine.js';
import { BOT_PRESETS, attachBots, decideBotAction } from '../src/core/ai.js';
import { createSeededRng } from '../src/core/rng.js';

const hands = Number(process.argv[2] ?? 1000);
const seed = Number(process.argv[3] ?? 12345);
const rng = createSeededRng(seed);

// 这里刻意不开自动补码：筹码始终停在 100 个大盲附近，统计出的赢率才有意义。
// 一张桌子被某个人赢光之后就换一桌重开。
const TABLE = {
  smallBlind: 10,
  bigBlind: 20,
  startingStack: 2000,
  autoRebuy: false,
};

let tables = 0;
function freshTable() {
  tables++;
  const table = attachBots(createTable(TABLE), createSeededRng(seed + tables * 7919));
  // 模拟里没有真人，0 号座位（默认标记为人类）也照样交给机器人打
  table.seats[0].bot = { ...BOT_PRESETS.balanced, kind: 'balanced' };
  return table;
}

const stats = new Map();
function statOf(kind) {
  if (!stats.has(kind)) stats.set(kind, { kind, hands: 0, wins: 0, net: 0 });
  return stats.get(kind);
}

let state = freshTable();

let pots = 0;
let potSum = 0;
let showdowns = 0;
let foldEndings = 0;
let flopsSeen = 0;
let actions = 0;
const startedAt = Date.now();

for (let i = 0; i < hands; i++) {
  if (tables > hands + 50) throw new Error('换桌次数异常，可能陷入死循环');

  const next = startHand(state, rng);
  if (next.phase === PHASES.IDLE) {
    state = freshTable();
    i -= 1; // 这一手没打成，不算数
    continue;
  }
  state = next;

  let guard = 0;
  while (state.phase !== PHASES.HAND_OVER && state.phase !== PHASES.IDLE) {
    if (++guard > 400) throw new Error('模拟中出现死循环');
    const action = decideBotAction(state, state.toAct, rng);
    actions++;
    state = applyAction(state, action, rng);
  }

  const pot = totalPot(state);
  pots++;
  potSum += pot;
  if (state.result?.type === 'showdown') showdowns++;
  else foldEndings++;
  if (state.board.length > 0) flopsSeen++;

  for (const seat of state.seats) {
    if (!seat.bot) continue;
    const entry = statOf(seat.bot.kind);
    if (seat.inHand) entry.hands++;
    // startStack 是开牌那一刻的筹码，所以净盈亏只反映这一手的结果
    entry.net += seat.stack - seat.startStack;
  }
  for (const w of state.result?.winners ?? []) {
    const seat = state.seats[w.seat];
    if (seat.bot) statOf(seat.bot.kind).wins++;
  }
}

const elapsed = Date.now() - startedAt;
console.log(`\n模拟 ${pots} 手牌，用时 ${elapsed}ms（平均每手 ${(elapsed / pots).toFixed(2)}ms）\n`);
console.log(
  `平均底池 ${(potSum / pots).toFixed(1)}　亮牌结束 ${((showdowns / pots) * 100).toFixed(1)}%　弃牌结束 ${((foldEndings / pots) * 100).toFixed(1)}%　平均行动 ${(actions / pots).toFixed(2)} 次/手`
);
console.log(`看到翻牌的比例 ${((flopsSeen / pots) * 100).toFixed(1)}%（太低说明桌子太紧，没有action）`);
console.log(
  `单次决策平均耗时 ${(elapsed / actions).toFixed(2)}ms（这个数字直接决定手机上点一下会不会卡）\n`
);

console.log(`共打了 ${tables} 张桌子，每张都是 6 人 100 个大盲\n`);
console.log('风格        参与手数    赢池     赢率       净盈亏');
let netTotal = 0;
for (const s of stats.values()) {
  netTotal += s.net;
  const rate = s.wins / Math.max(1, s.hands);
  const flag = rate > 0.22 || rate < 0.08 ? '   <-- 偏了' : '';
  console.log(
    `${s.kind.padEnd(10)}  ${String(s.hands).padStart(8)}  ${String(s.wins).padStart(6)}   ${(
      rate * 100
    )
      .toFixed(1)
      .padStart(5)}%   ${String(s.net).padStart(9)}${flag}`
  );
}
console.log(`\n净盈亏合计 ${netTotal}（六个人自赢自输，加总必须是 0）\n`);
