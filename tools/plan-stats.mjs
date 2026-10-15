/**
 * 两街计划的行为验证工具。
 *
 * 只看聚合胜率会漏掉"分布"（教训见 TODO.md）——这里专门量三样东西：
 *   1. 转牌继续下注率，按转牌分类拆开：听牌做成的转牌应该少开火，
 *      白板/大牌照常。计划开启前后这个差值应该明显变化。
 *   2. 全下率按街拆开：计划开启后翻牌/转牌的全下应该变多（打光判定）。
 *   3. 下注尺度分布按筹码/底池比分档：低 SPR 档的尺度应该整体抬向等比水平。
 *
 * 用法：
 *   node tools/plan-stats.mjs 3000                      计划开启（默认）
 *   HOLDEM_NO_PLAN=1 node tools/plan-stats.mjs 3000     对照（回到旧行为）
 */

import { ACTION_TYPES, PHASES, applyAction, createTable, getLegalActions, startHand, totalPot } from '../src/core/engine.js';
import { BOT_PRESETS, decideBotAction } from '../src/core/ai.js';
import { estimateEquityVsRanges, opponentRangeWeights } from '../src/core/equity.js';
import { effectiveStack, turnCardClass } from '../src/core/plan.js';
import { createSeededRng } from '../src/core/rng.js';

const hands = Number(process.argv[2] ?? 3000);
const seed = Number(process.argv[3] ?? 20261015);

const CONFIG = {
  smallBlind: 1,
  bigBlind: 2,
  startingStack: 200,
  seatCount: 6,
  autoRebuy: true,
};

const CLASS_LABEL = {
  completed: '听牌做成',
  overcard: '大牌',
  blank: '白板',
  'no-cbet': '翻牌没下注',
};

function freshTable(offset) {
  const rng = createSeededRng(seed + offset * 7919);
  const table = createTable(CONFIG);
  const kinds = Object.keys(BOT_PRESETS);
  for (const seat of table.seats) {
    seat.isHuman = seat.index === 0; // 让机器人的"读对手"功能工作起来
    const kind = kinds[Math.floor(rng() * kinds.length)];
    seat.bot = { ...BOT_PRESETS[kind], kind };
  }
  return table;
}

// 转牌继续率：每个 (类型) 一条记录
const barrel = new Map();
function barrelEntry(cls) {
  if (!barrel.has(cls)) barrel.set(cls, { decisions: 0, bets: 0, airDecisions: 0, airBets: 0 });
  return barrel.get(cls);
}

// 全下计数：按街
const jams = new Map();

// 尺度分布：按 SPR 分档统计底池比例
const SPR_BUCKETS = [
  { label: 'SPR<=2.2', lo: 0, hi: 2.2 },
  { label: '2.2~5.5', lo: 2.2, hi: 5.5 },
  { label: 'SPR>5.5', lo: 5.5, hi: Infinity },
];
const sizes = new Map(SPR_BUCKETS.map((b) => [b.label, []]));

function sprBucketOf(spr) {
  for (const b of SPR_BUCKETS) {
    if (spr > b.lo && spr <= b.hi) return b.label;
  }
  return SPR_BUCKETS[0].label;
}

function recordDecision(state, actor, legal, action) {
  const street = state.phase;
  const seat = state.seats[actor];
  const pot = totalPot(state);

  // 全下率
  if (action.type === ACTION_TYPES.ALL_IN && legal.canRaise) {
    jams.set(street, (jams.get(street) ?? 0) + 1);
  }

  if ((street !== PHASES.FLOP && street !== PHASES.TURN) || !legal.canRaise) return;

  // 转牌继续率（只在没人下注、能主动开火的时候记）
  if (street === PHASES.TURN && legal.canCheck && state.board.length === 4) {
    const barreled = (state.handActions ?? []).some(
      (a) => a.street === PHASES.FLOP && a.seat === actor && (a.kind === 'raise' || a.kind === 'allIn')
    );
    const cls = barreled ? turnCardClass(state.board.slice(0, 3), state.board) : 'no-cbet';
    const entry = barrelEntry(cls);
    entry.decisions += 1;
    const betted = action.type === ACTION_TYPES.RAISE || action.type === ACTION_TYPES.ALL_IN;
    if (betted) entry.bets += 1;
    // 单独看"空气牌"（胜率不到 50%，也就是诈唬分支覆盖的牌）的行为，
    // 否则继续率被价值牌稀释，看不出挑牌的效果。
    const eq = estimateEquityVsRanges(
      seat.hole,
      state.board,
      opponentRangeWeights(state, actor),
      160,
      rng
    );
    if (eq < 0.5) {
      entry.airDecisions += 1;
      if (betted) entry.airBets += 1;
    }
  }

  // 尺度分布（真下注才记：raise 或 主动 all-in）
  if (action.type === ACTION_TYPES.RAISE || (action.type === ACTION_TYPES.ALL_IN && legal.canRaise)) {
    const betTo = action.type === ACTION_TYPES.ALL_IN ? legal.maxRaiseTo : action.amount;
    const bet = betTo - seat.streetBet;
    if (bet <= 0) return;
    const spr = effectiveStack(state, actor) / Math.max(1, pot);
    sizes.get(sprBucketOf(spr)).push(bet / Math.max(1, pot));
  }
}

function fmt(list) {
  if (list.length === 0) return '—';
  const sorted = [...list].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const share = (lo, hi) =>
    Math.round((sorted.filter((f) => f >= lo && f < hi).length / sorted.length) * 100);
  return (
    `${String(list.length).padStart(6)}  中位 ${(median * 100).toFixed(0)}%  ` +
    `0-25% ${share(0, 0.25)}% | 25-50% ${share(0.25, 0.5)}% | 50-75% ${share(0.5, 0.75)}% | ` +
    `75-100% ${share(0.75, 1)}% | >100% ${share(1, Infinity)}%`
  );
}

const planOn = !(typeof process !== 'undefined' && process.env?.HOLDEM_NO_PLAN === '1');
const rng = createSeededRng(seed + 104729);
let state = freshTable(0);
let played = 0;
const startedAt = Date.now();

while (played < hands) {
  if (played % 150 === 0) state = freshTable(played);
  state = startHand(state, rng);
  if (state.phase === PHASES.IDLE) {
    state = freshTable(played);
    state = startHand(state, rng);
  }
  let guard = 0;
  while (state.phase !== PHASES.HAND_OVER && state.phase !== PHASES.IDLE) {
    if (++guard > 500) throw new Error('牌局没有正常结束');
    const actor = state.toAct;
    const legal = getLegalActions(state, actor);
    const action = decideBotAction(state, actor, rng);
    recordDecision(state, actor, legal, action);
    state = applyAction(state, action, rng);
  }
  played++;
}

console.log(`\n两街计划 ${planOn ? '【开启】' : '【关闭（HOLDEM_NO_PLAN=1）】'}，${played} 手，耗时 ${Math.round((Date.now() - startedAt) / 1000)}s\n`);

console.log('转牌继续下注率（翻牌下过注、转牌轮到自己且无人下注）：');
for (const cls of ['completed', 'overcard', 'blank', 'no-cbet']) {
  const e = barrel.get(cls);
  if (!e) continue;
  const rate = e.decisions > 0 ? ((e.bets / e.decisions) * 100).toFixed(1) : '—';
  const airRate = e.airDecisions > 0 ? ((e.airBets / e.airDecisions) * 100).toFixed(1) : '—';
  console.log(
    `  ${CLASS_LABEL[cls].padEnd(12)} 决策 ${String(e.decisions).padStart(6)}   下注率 ${rate}%` +
      `   其中空气牌 ${String(e.airDecisions).padStart(5)} 手，下注率 ${airRate}%`
  );
}

console.log('\n全下次数（主动全下）：');
for (const street of [PHASES.PREFLOP, PHASES.FLOP, PHASES.TURN, PHASES.RIVER]) {
  console.log(`  ${street.padEnd(8)} ${jams.get(street) ?? 0}`);
}

console.log('\n下注尺度分布（占底池比例，按决策时的 SPR 分档）：');
for (const b of SPR_BUCKETS) {
  console.log(`  ${b.label.padEnd(9)} ${fmt(sizes.get(b.label))}`);
}
console.log('');