/**
 * 教练：告诉玩家这一手该怎么打，打完再判断对错并给出解析。
 *
 * 关键设计：教练和 AI 共用同一套决策逻辑（翻前用 preflop.js 的范围表，
 * 翻后用同一套胜率与赔率模型）。如果两边各写一套，"教练说该加注、
 * 机器人却弃牌"这种矛盾会立刻让人失去信任。
 *
 * 翻后判断的依据是期望值：
 *
 *   跟注的期望 = 胜率 × 底池 − (1 − 胜率) × 跟注额
 *   弃牌的期望 = 0
 *
 * 两个数可以直接比较，所以"该不该跟"是有明确答案的，
 * 差额就是这次决策的代价。
 */

import { ACTION_TYPES, PHASES, getLegalActions, totalPot } from './engine.js';
import { estimateEquity } from './ai.js';
import { estimateEquityVsRanges, opponentRangeWeights } from './equity.js';
import { solveRiverForState } from './river-solver.js';
import { betPlan, boardTexture, rangeAdvantage } from './postflop.js';
import { handClass, preflopAdvice } from './preflop.js';

const ACTION_LABEL = {
  [ACTION_TYPES.FOLD]: '弃牌',
  [ACTION_TYPES.CHECK]: '过牌',
  [ACTION_TYPES.CALL]: '跟注',
  [ACTION_TYPES.RAISE]: '加注',
  [ACTION_TYPES.ALL_IN]: '全下',
};

const pct = (x) => `${(x * 100).toFixed(0)}%`;

const SOLVER_ACTION = {
  fold: ACTION_TYPES.FOLD,
  check: ACTION_TYPES.CHECK,
  call: ACTION_TYPES.CALL,
  bet: ACTION_TYPES.RAISE,
  raise: ACTION_TYPES.RAISE,
  allin: ACTION_TYPES.ALL_IN,
};

/** 跟注的期望值。P 是当下桌上的全部筹码，C 是要跟的额度。 */
function callEV(equity, pot, toCall) {
  return equity * pot - (1 - equity) * toCall;
}

function decisionData(state, seatIdx) {
  const legal = getLegalActions(state, seatIdx);
  if (!legal) return null;
  const pot = totalPot(state);
  const toCall = legal.toCall;
  return { legal, pot, toCall, potOdds: toCall > 0 ? toCall / (pot + toCall) : 0 };
}

/**
 * 给出建议。返回结构里既有"该怎么做"，也有支撑结论的数据和理由。
 */
export function advise(state, seatIdx, rng = Math.random) {
  const data = decisionData(state, seatIdx);
  if (!data) return null;
  const { legal, pot, toCall, potOdds } = data;
  const seat = state.seats[seatIdx];
  const cls = handClass(seat.hole);

  if (state.phase === PHASES.PREFLOP) {
    const advice = preflopAdvice(state, seatIdx, rng);
    const action =
      advice.action === 'raise'
        ? ACTION_TYPES.RAISE
        : advice.action === 'allin'
          ? ACTION_TYPES.ALL_IN
        : advice.action === 'call'
          ? ACTION_TYPES.CALL
          : advice.action === 'check'
            ? ACTION_TYPES.CHECK
            : ACTION_TYPES.FOLD;
    return {
      street: '翻前',
      action,
      amount: advice.sizing,
      handClass: advice.cls,
      position: advice.position,
      label: advice.label,
      reasons: [advice.note, `${advice.position} 位，手牌 ${advice.cls}`],
      pot,
      toCall,
      potOdds,
      equity: null,
    };
  }

  // 河牌：单挑时交给 CFR 求解器，给出真正的均衡策略（含混合频率）
  if (state.phase === PHASES.RIVER) {
    const solved = solveRiverForState(state, seatIdx, { iterations: 450 });
    if (solved) {
      const ranked = Object.entries(solved.strategy).sort((a, b) => b[1] - a[1]);
      const [bestName, bestP] = ranked[0];
      const spec = solved.actions.find((a) => a.name === bestName);
      const mixText = ranked
        .map(([n, p]) => `${ACTION_LABEL[SOLVER_ACTION[n]] ?? n} ${pct(p)}`)
        .join('／');
      return {
        street: '河牌（CFR 求解）',
        action: SOLVER_ACTION[bestName] ?? ACTION_TYPES.CHECK,
        amount: spec?.amount,
        fraction: bestName === 'bet' ? spec?.amount / Math.max(1, pot) : undefined,
        handClass: handClass(seat.hole),
        solver: true,
        strategy: solved.strategy,
        equity: null,
        pot,
        toCall,
        reasons: [
          `均衡策略：${mixText}`,
          `底池 ${pot}${toCall > 0 ? `，需要跟 ${toCall}` : '，无人下注'}`,
          '这是按双方范围做 CFR 求解得到的，已经算进对手的反应',
        ],
      };
    }
  }

  const opponents = state.seats.filter(
    (s) => s.inHand && !s.folded && s.index !== seatIdx
  ).length;
  const equity = estimateEquityVsRanges(
    seat.hole,
    state.board,
    opponentRangeWeights(state, seatIdx),
    420,
    rng
  );
  const ev = callEV(equity, pot, toCall);
  const base = { street: '翻后', equity, pot, toCall, potOdds, handClass: cls };
  const reasons = [`估算胜率 ${pct(equity)}（对抗 ${opponents} 个对手，模拟 420 次）`];

  if (legal.canCheck) {
    const texture = boardTexture(state.board);
    const advantage = rangeAdvantage(state, seatIdx);
    const plan = betPlan({ texture, advantage, aggression: 0.55, bluff: 0.15 });
    const textureName = texture.wetness < 0.2 ? '干燥' : texture.wetness < 0.5 ? '中等' : '湿润';
    reasons.push(
      `牌面偏${textureName}（湿润度 ${texture.wetness.toFixed(2)}），` +
        `范围优势 ${advantage >= 0 ? '+' : ''}${advantage.toFixed(2)}`
    );
    reasons.push(
      `这种牌面的标准打法是下注约 ${Math.round(plan.fraction * 100)}% 底池，频率约 ${Math.round(plan.betFrequency * 100)}%` +
        (texture.wetness < 0.3 ? '（干燥面用小注高频收池）' : '（湿润面用大注低频，中等牌多过牌）')
    );
    if (equity > 0.72 && legal.canRaise) {
      reasons.push('胜率明显领先，应该下注拿价值');
      return { ...base, action: ACTION_TYPES.RAISE, fraction: plan.fraction, reasons };
    }
    if (equity > 0.55 && legal.canRaise) {
      reasons.push('胜率尚可，可以下注也可以过牌控池');
      return { ...base, action: ACTION_TYPES.RAISE, fraction: plan.fraction * 0.8, reasons };
    }
    reasons.push(`胜率不高但没有下注压力，过牌看下一张`);
    return { ...base, action: ACTION_TYPES.CHECK, reasons };
  }

  reasons.push(`底池 ${pot}，需要跟 ${toCall}，赔率要求胜率至少 ${pct(potOdds)}`);
  reasons.push(
    ev > 0
      ? `跟注的期望是 +${Math.round(ev)} 筹码，弃牌是 0`
      : `跟注的期望是 ${Math.round(ev)} 筹码，弃牌是 0`
  );

  if (equity > 0.78 && legal.canRaise) {
    reasons.push(`胜率这么高应该加注，把筹码放进去`);
    return { ...base, action: ACTION_TYPES.RAISE, fraction: 0.8, ev, reasons };
  }
  if (ev > 0) return { ...base, action: ACTION_TYPES.CALL, ev, reasons };

  reasons.push(`跟注是亏的，应该弃牌`);
  return { ...base, action: ACTION_TYPES.FOLD, ev, reasons };
}

/**
 * 复盘玩家的实际操作。
 * 必须在 applyAction **之前**调用，否则拿不到决策当时的局面。
 */
export function reviewDecision(state, seatIdx, chosen, advice) {
  if (!advice) return null;
  const data = decisionData(state, seatIdx);
  if (!data) return null;

  const chosenLabel = ACTION_LABEL[chosen.type] ?? '行动';
  const bestLabel = ACTION_LABEL[advice.action] ?? '行动';

  // 翻前没有胜率数字，按范围表判断
  if (advice.equity === null || advice.equity === undefined) {
    const shouldPlay = advice.action !== ACTION_TYPES.FOLD;
    const folded = chosen.type === ACTION_TYPES.FOLD;
    if (shouldPlay && folded) {
      return {
        grade: 'mistake',
        title: `${advice.handClass} 不该弃`,
        detail: `${advice.label} —— ${advice.reasons[0]}。这里弃掉等于把牌力和位置都让出去。`,
      };
    }
    if (!shouldPlay && !folded) {
      return {
        grade: 'imprecise',
        title: `${advice.handClass} 不在建议范围里`,
        detail: `${advice.label} —— ${advice.reasons[0]}。长期这么打会亏，但偶尔混一下能防止被打得太死。`,
      };
    }
    return {
      grade: 'good',
      title: '翻前处理得当',
      detail: `${advice.label} —— ${advice.reasons[0]}`,
    };
  }

  if (chosen.type === advice.action) {
    return {
      grade: 'good',
      title: `处理得当：${bestLabel}`,
      detail: advice.reasons.join('；') + '。',
    };
  }

  const { legal, pot, toCall } = data;
  const equity = advice.equity;
  const ev = callEV(equity, pot, toCall);
  const severity = Math.abs(ev) / Math.max(1, pot);
  const userFolded = chosen.type === ACTION_TYPES.FOLD;
  const recommendFold = advice.action === ACTION_TYPES.FOLD;

  if (userFolded && !recommendFold) {
    return {
      grade: severity > 0.1 ? 'mistake' : 'imprecise',
      title: `弃牌偏保守，估计让出 ${Math.round(ev)} 筹码`,
      detail:
        `胜率 ${pct(equity)}，底池赔率只要求 ${pct(advice.potOdds)}，跟注的期望是 +${Math.round(ev)}。` +
        '这类牌弃多了，对手会发现只要下注就能拿走底池。',
    };
  }
  if (!userFolded && recommendFold) {
    return {
      grade: severity > 0.1 ? 'mistake' : 'imprecise',
      title: `跟注不合理，估计损失 ${Math.round(-ev)} 筹码`,
      detail:
        `胜率只有 ${pct(equity)}，而底池赔率要求 ${pct(advice.potOdds)}，跟注的期望是 ${Math.round(ev)}。` +
        '这种牌面对下注应该直接弃掉。',
    };
  }

  return {
    grade: 'imprecise',
    title: `大方向没错，但建议${bestLabel}`,
    detail: advice.reasons.join('；') + '。',
  };
}

export { ACTION_LABEL };
