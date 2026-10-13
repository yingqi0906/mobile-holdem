/**
 * 行为频率分析。
 *
 * 胜率实验有个先天问题：扑克方差太大，几千手也只能分辨出很大的差距。
 * 但"面对满池下注弃牌多少次"这种频率量，几百手就能收敛到很准。
 *
 * 所以这个工具不谈输赢，只统计机器人**做了什么**，然后跟理论值对比：
 *
 *   MDF（最小防守频率）= 底池 / (底池 + 下注额)
 *   这是不被对手用任意两张牌诈唬获利的最低防守比例。
 *   面对满池下注，MDF = 50%：如果你弃牌超过一半，对手拿任意牌下注都是赚的。
 *
 * 用法：node tools/profile.mjs [手数]
 */

import {
  ACTION_TYPES,
  PHASES,
  applyAction,
  createTable,
  getLegalActions,
  startHand,
  totalPot,
} from '../src/core/engine.js';
import { BOT_PRESETS, decideBotAction } from '../src/core/ai.js';
import { createSeededRng } from '../src/core/rng.js';

const hands = Number(process.argv[2] ?? 2000);
const seed = Number(process.argv[3] ?? 424242);

const CONFIG = {
  smallBlind: 1,
  bigBlind: 2,
  startingStack: 200,
  seatCount: 6,
  autoRebuy: true,
};

const rng = createSeededRng(seed);
const table = createTable(CONFIG);
const kinds = Object.keys(BOT_PRESETS);
const setupRng = createSeededRng(seed + 1);
for (const seat of table.seats) {
  seat.isHuman = false;
  const kind = kinds[Math.floor(setupRng() * kinds.length)];
  seat.bot = { ...BOT_PRESETS[kind], kind };
}

const s = {
  preflop: { fold: 0, check: 0, call: 0, raise: 0 },
  unopened: 0,
  unopenedRaise: 0,
  facingRaise: 0,
  foldedToRaise: 0,
  checkedTo: 0,
  betWhenCheckedTo: 0,
  postflopFacing: 0,
  postflopRaise: 0,
  buckets: new Map(), // 下注量分档
  showdowns: 0,
  pots: 0,
  potSum: 0,
};

function bucketOf(ratio) {
  if (ratio < 0.33) return '小额（<1/3 池）';
  if (ratio < 0.75) return '中等（1/3~3/4 池）';
  if (ratio < 1.5) return '偏大（3/4 ~ 1.5 池）';
  return '超大（>1.5 池）';
}

let state = table;
for (let h = 0; h < hands; h++) {
  state = startHand(state, rng);
  if (state.phase === PHASES.IDLE) break;

  let guard = 0;
  while (state.phase !== PHASES.HAND_OVER && state.phase !== PHASES.IDLE) {
    if (++guard > 500) throw new Error('牌局没有正常结束');

    const actor = state.seats[state.toAct];
    const legal = getLegalActions(state, state.toAct);
    const pot = totalPot(state);
    const preflop = state.phase === PHASES.PREFLOP;

    // 先记录"面对的是什么局面"，再看它怎么选
    let situation = null;
    if (preflop) {
      if (legal.canCheck) situation = 'bb-option';
      else if (state.currentBet <= state.config.bigBlind) {
        situation = 'unopened';
        s.unopened += 1;
      } else {
        situation = 'facing-raise';
        s.facingRaise += 1;
      }
    } else if (legal.canCheck) {
      situation = 'checked-to';
      s.checkedTo += 1;
    } else {
      situation = 'facing-bet';
      s.postflopFacing += 1;
    }

    // 下注额相对「下注之前的底池」的比例。
    // 不能用 totalPot 当分母 —— 它已经包含了下注本身，会把满池下注算成半池，
    // MDF 也就会跟着算错。
    const potBefore = Math.max(1, pot - legal.toCall);
    const betRatio = legal.toCall > 0 ? legal.toCall / potBefore : 0;
    const action = decideBotAction(state, state.toAct, rng);

    // 只统计行动本身，顺便按局面归类
    if (action.type === ACTION_TYPES.RAISE) {
      if (preflop) s.preflop.raise += 1;
      else if (situation === 'facing-bet') s.postflopRaise += 1;
      if (situation === 'unopened') s.unopenedRaise += 1;
      if (situation === 'checked-to') s.betWhenCheckedTo += 1;
    } else if (action.type === ACTION_TYPES.FOLD) {
      if (preflop) {
        s.preflop.fold += 1;
        if (situation === 'facing-raise') s.foldedToRaise += 1;
      }
      else if (situation === 'facing-bet') {
        const b = bucketOf(betRatio);
        const cur = s.buckets.get(b) ?? { n: 0, folds: 0, mdfSum: 0 };
        cur.n += 1;
        cur.folds += 1;
        cur.mdfSum += 1 / (1 + betRatio);
        s.buckets.set(b, cur);
      }
    } else if (action.type === ACTION_TYPES.CHECK) {
      if (preflop) s.preflop.check += 1;
    } else if (action.type === ACTION_TYPES.CALL) {
      if (preflop) s.preflop.call += 1;
      else if (situation === 'facing-bet') {
        const b = bucketOf(betRatio);
        const cur = s.buckets.get(b) ?? { n: 0, folds: 0, mdfSum: 0 };
        cur.n += 1;
        cur.mdfSum += 1 / (1 + betRatio);
        s.buckets.set(b, cur);
      }
    }

    state = applyAction(state, action, rng);
  }

  s.pots += 1;
  if (state.result?.type === 'showdown') s.showdowns += 1;
}

const pct = (a, b) => (b === 0 ? '—' : `${((a / b) * 100).toFixed(1)}%`);

console.log(`\n统计 ${s.pots} 手牌（六人桌，全部由机器人打）\n`);

console.log('翻前');
console.log(`  无人加注时主动加注的比例   ${pct(s.unopenedRaise, s.unopened)}   （GTO 参考：枪口位 15~18%，庄家位 45~50%，平均约 30%）`);
console.log(`  面对加注时弃牌的比例       ${pct(s.foldedToRaise, s.facingRaise)}`);
console.log(`  各类动作占比               弃牌 ${pct(s.preflop.fold, s.preflop.fold + s.preflop.check + s.preflop.call + s.preflop.raise)} / 过牌 ${pct(s.preflop.check, s.preflop.fold + s.preflop.check + s.preflop.call + s.preflop.raise)} / 跟注 ${pct(s.preflop.call, s.preflop.fold + s.preflop.check + s.preflop.call + s.preflop.raise)} / 加注 ${pct(s.preflop.raise, s.preflop.fold + s.preflop.check + s.preflop.call + s.preflop.raise)}`);

console.log('\n翻后');
console.log(`  被过牌后主动下注的比例     ${pct(s.betWhenCheckedTo, s.checkedTo)}   （GTO 参考：约 60~70%）`);
console.log(`  面对下注时加注的比例       ${pct(s.postflopRaise, s.postflopFacing)}`);
console.log('\n  面对下注的弃牌率 vs 理论最低防守频率（MDF）');
console.log('  档位                    样本    实际弃牌   应该≤(1-MDF)   判断');
for (const [name, v] of s.buckets) {
  const foldRate = v.folds / v.n;
  const mdf = v.mdfSum / v.n;
  const shouldFold = 1 - mdf;
  let verdict = '合理';
  if (foldRate > shouldFold + 0.12) verdict = '★ 弃牌过多';
  else if (foldRate < shouldFold - 0.12) verdict = '跟注过多';
  console.log(
    `  ${name.padEnd(20)}  ${String(v.n).padStart(5)}   ${(foldRate * 100).toFixed(1).padStart(6)}%   ${(shouldFold * 100).toFixed(1).padStart(9)}%    ${verdict}`
  );
}

console.log(`\n  打到摊牌的比例             ${pct(s.showdowns, s.pots)}`);
console.log('');
