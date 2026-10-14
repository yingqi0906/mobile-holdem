/**
 * 河牌 CFR 求解器。
 *
 * ⚠️ 状态：**未完成、未接入**。目前有两个已知阻塞问题，先留在这里作为底稿：
 *   1. `solveRiver` 查的是树根节点的策略，但英雄往往在根的子节点行动
 *      （比如后手方要等对手先过牌/下注），所以经常返回 null。
 *      需要先定位英雄真正行动的节点再取策略。
 *   2. 单次求解约 2 秒 —— 每次迭代在每个节点都重新分配 (nH × nO) 的效用矩阵，
 *      开销全在分配上。需要改成复用缓冲区、或者只在需要的节点算矩阵。
 * 在这两条修好之前不要接入 AI 或教练，否则会卡住界面。
 *
 * 为什么只有河牌能做：翻牌和转牌后面还有街，博弈树会大到浏览器里跑不动。
 * 河牌是终点，只有一条街、决策树很小，几千次迭代就能收敛到近似纳什均衡。
 *
 * 做法是标准的 CFR+（反事实遗憾最小化）：
 *   - 双方的范围来自上游的逐街收窄（src/core/equity.js）
 *   - 下注尺度做离散化：过牌 / 3/4 底池 / 全下
 *   - 每个信息集维护遗憾值，按遗憾匹配选策略
 *   - 收敛后取当前手牌在均衡里的策略
 *
 * 注意这是**抽象后的解**：下注尺度只有几档，手牌按类别聚合。它不是精确解，
 * 但比启发式的"按赔率够不够"要强得多 —— 因为它会算到对手的反应，
 * 会为了不让对手便宜跟注而做两极化下注。
 */

import { evaluateBest } from './evaluator.js';
import { HAND_RANK } from './hand-rank.js';

const CLASSES = HAND_RANK.length;
const RANK_CHAR = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const CHAR_RANK = new Map(RANK_CHAR.map((c, i) => [c, i + 2]));

const MAX_CLASSES = 20; // 每边只保留权重最高的若干类别，控制矩阵规模
const ITERATIONS = 800;
const BET_FRACTIONS = [0.75, Infinity]; // Infinity 表示全下

/** 列出某个手牌类别在给定牌面上的所有具体组合及其牌力。 */
function combosOfClass(cls, board) {
  const dead = new Set(board);
  const out = [];
  const a = CHAR_RANK.get(cls[0]);
  const b = CHAR_RANK.get(cls[1]);
  const pair = cls.length === 2;
  const suited = cls[2] === 's';

  for (let s1 = 0; s1 < 4; s1++) {
    for (let s2 = 0; s2 < 4; s2++) {
      if (pair && s1 === s2) continue;
      if (!pair && suited && s1 !== s2) continue;
      if (!pair && !suited && s1 === s2) continue;
      const c1 = (a - 2) * 4 + s1;
      const c2 = (b - 2) * 4 + s2;
      if (c1 === c2 || dead.has(c1) || dead.has(c2)) continue;
      out.push({ cards: [c1, c2], score: evaluateBest([c1, c2, ...board]) });
    }
  }
  return out;
}

/** win[i][j] = 我方第 i 个类别对抗对手第 j 个类别的胜率（含平局折半）。 */
function buildShowdownMatrix(heroClasses, oppClasses, board) {
  const heroCombos = heroClasses.map((c) => combosOfClass(HAND_RANK[c], board));
  const oppCombos = oppClasses.map((c) => combosOfClass(HAND_RANK[c], board));
  const matrix = heroClasses.map(() => new Float64Array(oppClasses.length));

  for (let i = 0; i < heroClasses.length; i++) {
    for (let j = 0; j < oppClasses.length; j++) {
      let sum = 0;
      let n = 0;
      for (const h of heroCombos[i]) {
        for (const o of oppCombos[j]) {
          // 两张牌撞车就跳过 —— 这就是"挡牌效应"的来源
          if (h.cards[0] === o.cards[0] || h.cards[0] === o.cards[1]) continue;
          if (h.cards[1] === o.cards[0] || h.cards[1] === o.cards[1]) continue;
          sum += h.score > o.score ? 1 : h.score === o.score ? 0.5 : 0;
          n += 1;
        }
      }
      matrix[i][j] = n > 0 ? sum / n : 0.5;
    }
  }
  return matrix;
}

/** 保留权重最高的若干类别，返回 [类别下标...] 与归一化权重。 */
function topClasses(weights, limit) {
  const idx = [];
  for (let i = 0; i < CLASSES; i++) if (weights[i] > 0) idx.push(i);
  idx.sort((a, b) => weights[b] - weights[a]);
  const kept = idx.slice(0, limit);
  const w = kept.map((i) => weights[i]);
  const sum = w.reduce((a, b) => a + b, 0) || 1;
  return { classes: kept, weights: w.map((x) => x / sum) };
}

/**
 * 构建河牌的博弈树。
 * 玩家 0 是先行动的一方（翻牌后的位置劣势方），玩家 1 在后。
 */
function buildTree(pot, stack0, stack1) {
  let nextId = 0;
  const node = (obj) => ({ id: nextId++, ...obj });

  // 一个下注轮：betFrac 是相对底池的下注额，全下时取自己的剩余筹码
  function betAmount(player, fraction) {
    const stack = player === 0 ? stack0 : stack1;
    if (fraction === Infinity) return stack;
    return Math.min(stack, Math.round(pot * fraction));
  }

  // 面对下注：弃牌 / 跟注 / 全下加注
  function facingBet(player, invested, facing, otherInvested) {
    const stack = player === 0 ? stack0 : stack1;
    const raiseTo = Math.min(stack, otherInvested * 2.5);
    const canRaise = raiseTo > facing + 1e-9;
    const actions = [
      { action: 'fold', child: node({ terminal: 'fold', folder: player, invested, otherInvested }) },
      { action: 'call', child: node({ terminal: 'showdown', invested, otherInvested: facing }) },
    ];
    if (canRaise) {
      actions.push({
        action: 'raise',
        amount: raiseTo,
        child: facingBet(1 - player, raiseTo, raiseTo, raiseTo),
      });
    }
    return node({ player, invested, facing, otherInvested, actions });
  }

  // 可以过牌或下注
  function openAction(player, invested, otherInvested) {
    const actions = [];
    if (player === 0) {
      actions.push({
        action: 'check',
        child: openAction(1, otherInvested, invested),
      });
    } else {
      actions.push({
        action: 'check',
        child: node({ terminal: 'showdown', invested: otherInvested, otherInvested: invested }),
      });
    }
    for (const fraction of BET_FRACTIONS) {
      const amount = betAmount(player, fraction);
      if (amount <= 0) continue;
      if (amount >= (player === 0 ? stack0 : stack1)) {
        // 直接全下
        actions.push({
          action: 'allin',
          amount,
          child: facingBet(1 - player, otherInvested, invested + amount, invested + amount),
        });
      } else {
        actions.push({
          action: 'bet',
          amount,
          child: facingBet(1 - player, otherInvested, invested + amount, invested + amount),
        });
      }
    }
    return node({ player, invested, otherInvested, actions });
  }

  return openAction(0, 0, 0);
}

/**
 * CFR+ 求解。
 * 返回每个节点上、每个类别的平均策略。
 */
function runCfr(root, heroW, oppW, win, pot, iterations) {
  const nH = heroW.length;
  const nO = oppW.length;
  const regrets = new Map();
  const strategySum = new Map();
  const hands = new Map();

  function infoKey(nodeId, isHero, classIdx) {
    return `${nodeId}:${isHero ? 'h' : 'o'}:${classIdx}`;
  }

  function getStrategy(node, player) {
    const n = player === 0 ? nH : nO;
    const w = player === 0 ? heroW : oppW;
    const current = new Float64Array(n);
    const total = new Float64Array(n);
    const list = [];
    for (let c = 0; c < n; c++) {
      const key = infoKey(node.id, player === 0, c);
      let r = regrets.get(key);
      if (!r) {
        r = new Float64Array(node.actions.length);
        regrets.set(key, r);
      }
      let sum = 0;
      const positive = new Float64Array(node.actions.length);
      for (let a = 0; a < node.actions.length; a++) {
        positive[a] = Math.max(0, r[a]);
        sum += positive[a];
      }
      const s = new Float64Array(node.actions.length);
      if (sum > 0) {
        for (let a = 0; a < node.actions.length; a++) s[a] = positive[a] / sum;
      } else {
        for (let a = 0; a < node.actions.length; a++) s[a] = 1 / node.actions.length;
      }
      list.push({ c, key, s, weight: w[c] });
      total[c] = 1;
      current[c] = 1;
    }
    return { list };
  }

  /** 返回玩家 0（英雄）的效用矩阵 M[i][j]。 */
  function walk(node, reach0, reach1) {
    if (node.terminal === 'fold') {
      const m = [];
      for (let i = 0; i < nH; i++) m.push(new Float64Array(nO));
      const gain = node.folder === 1 ? pot + node.otherInvested : 0;
      const loss = node.folder === 0 ? node.invested : 0;
      return { kind: 'fold', gain, loss, m: null };
    }
    if (node.terminal === 'showdown') {
      const inv0 = node.invested;
      const inv1 = node.otherInvested;
      return { kind: 'showdown', inv0, inv1, m: null };
    }

    const player = node.player;
    const isHero = player === 0;
    const { list } = getStrategy(node, player);
    const childResults = [];
    for (let a = 0; a < node.actions.length; a++) {
      const nextReach0 = Float64Array.from(reach0);
      const nextReach1 = Float64Array.from(reach1);
      for (const item of list) {
        const p = item.s[a];
        if (isHero) nextReach0[item.c] *= p;
        else nextReach1[item.c] *= p;
      }
      childResults.push(walk(node.actions[a].child, nextReach0, nextReach1));
    }

    // 把每个子节点的结果折算成 (i, j) 上的效用
    function childUtility(child, i, j) {
      if (child.kind === 'fold') {
        // 对手弃牌：我赢下底池和对手投入；我弃牌：损失自己的投入
        return child.gain > 0 ? pot + child.gain - 0 : -child.loss;
      }
      return win[i][j] * (pot + child.inv1) - (1 - win[i][j]) * child.inv0;
    }

    // 节点效用（按对手到达概率加权后求期望）
    const nodeUtil = new Float64Array(isHero ? nH : nO);
    for (let a = 0; a < node.actions.length; a++) {
      const child = childResults[a];
      for (const item of list) {
        let v = 0;
        if (isHero) {
          for (let j = 0; j < nO; j++) v += reach1[j] * childUtility(child, item.c, j);
        } else {
          // 玩家 1 的效用是玩家 0 的相反数
          for (let i = 0; i < nH; i++) v -= reach0[i] * childUtility(child, i, item.c);
        }
        nodeUtil[item.c] += item.s[a] * v;
      }
    }

    // CFR+ 遗憾更新
    for (const item of list) {
      const regret = regrets.get(item.key);
      for (let a = 0; a < node.actions.length; a++) {
        const child = childResults[a];
        let v = 0;
        if (isHero) {
          for (let j = 0; j < nO; j++) v += reach1[j] * childUtility(child, item.c, j);
        } else {
          for (let i = 0; i < nH; i++) v -= reach0[i] * childUtility(child, i, item.c);
        }
        regret[a] = Math.max(0, regret[a] + (v - nodeUtil[item.c]));
      }
      // 累积平均策略，按自己的到达概率加权
      const reach = isHero ? reach0[item.c] : reach1[item.c];
      const key = `${item.key}:avg`;
      let acc = strategySum.get(key);
      if (!acc) {
        acc = new Float64Array(node.actions.length);
        strategySum.set(key, acc);
      }
      for (let a = 0; a < node.actions.length; a++) acc[a] += reach * item.s[a];
    }

    // 继续往上传递：仍然返回"玩家 0 的效用矩阵"给父节点用
    const m = [];
    for (let i = 0; i < nH; i++) m.push(new Float64Array(nO));
    for (let i = 0; i < nH; i++) {
      for (let j = 0; j < nO; j++) {
        let v = 0;
        for (let a = 0; a < node.actions.length; a++) {
          const child = childResults[a];
          let p = 1;
          // 当前玩家的策略概率
          for (const item of list) {
            if ((isHero && item.c === i) || (!isHero && item.c === j)) {
              p = item.s[a];
              break;
            }
          }
          v += p * childUtility(child, i, j);
        }
        m[i][j] = v;
      }
    }
    hands.set(node.id, true);
    return { kind: 'node', m };
  }

  const init0 = Float64Array.from(heroW);
  const init1 = Float64Array.from(oppW);
  for (let t = 0; t < iterations; t++) walk(root, init0, init1);

  return { regrets, strategySum };
}

/**
 * 求解河牌局面，返回英雄各个行动的期望值与推荐策略。
 *
 * @param {object} opts
 *   board        公共牌（5 张）
 *   heroWeights  英雄自己的范围权重
 *   oppWeights   对手的范围权重
 *   heroIdx      英雄在 weight 数组里的序号（对应哪一手）
 *   pot          河牌开始时的底池
 *   heroInvested / oppInvested  本条街双方已投入
 *   heroFirst    英雄是否先行动
 *   heroStack / oppStack  剩余筹码
 */
export function solveRiver(opts) {
  const {
    board,
    heroWeights,
    oppWeights,
    heroClass,
    pot,
    heroInvested = 0,
    oppInvested = 0,
    heroFirst = true,
    heroStack,
    oppStack,
  } = opts;
  if (board.length !== 5) return null;

  const heroTop = topClasses(heroWeights, MAX_CLASSES);
  const oppTop = topClasses(oppWeights, MAX_CLASSES);
  const heroIdx = heroTop.classes.indexOf(heroClass);
  if (heroIdx < 0) return null; // 这手牌不在自己范围里，说明前面打错了

  const win = buildShowdownMatrix(heroTop.classes, oppTop.classes, board);

  // 构建树时要把"已经投入的部分"算进去：底池里已经有了 heroInvested + oppInvested
  const rootPot = pot;
  const stack0 = heroFirst ? heroStack : oppStack;
  const stack1 = heroFirst ? oppStack : heroStack;
  const root = buildTree(rootPot, stack0, stack1);

  const heroW = heroFirst ? heroTop.weights : oppTop.weights;
  const oppW = heroFirst ? oppTop.weights : heroTop.weights;
  const winMatrix = heroFirst ? win : win[0].map((_, j) => win.map((row) => 1 - row[j]));

  const { strategySum } = runCfr(root, heroW, oppW, winMatrix, rootPot, ITERATIONS);

  // 取英雄在根节点的平均策略
  const playerIsHero = heroFirst ? 0 : 1;
  const actions = root.actions.map((a) => a.action);
  const probs = [];
  let total = 0;
  for (let a = 0; a < actions.length; a++) {
    const key = `${root.id}:${playerIsHero === 0 ? 'h' : 'o'}:${
      playerIsHero === 0 ? heroIdx : heroIdx
    }:avg`;
    const acc = strategySum.get(key);
    const v = acc ? acc[a] : 0;
    probs.push(v);
    total += v;
  }
  if (total <= 0) return null;

  const strategy = {};
  actions.forEach((name, a) => {
    strategy[name] = probs[a] / total;
  });

  return {
    strategy,
    amounts: actions.map((name, a) => ({ name, amount: root.actions[a].amount ?? 0 })),
    classes: heroTop.classes.length,
  };
}

export const RIVER_SOLVER_CONFIG = { MAX_CLASSES, ITERATIONS, BET_FRACTIONS };
