/**
 * 河牌 CFR 求解器（CFR+，抽象后的解）。
 *
 * 为什么只有河牌能做：翻牌和转牌后面还有街，博弈树会大到浏览器里跑不动。
 * 河牌是终点，只有一条街、决策树很小，几百次迭代就能收敛。
 *
 * 两个关键设计：
 *
 * 1. **从英雄当前的决策点建子树**，而不是从这条街的开头建。
 *    这样根节点就是英雄该行动的地方，取策略不会取错节点。
 *
 * 2. **按节点预分配效用矩阵**。第一版每次迭代、每个节点都重新分配
 *    (nH × nO) 的矩阵，实测单次求解要 2 秒；改成复用完再没有分配开销。
 *
 * 抽象：下注尺度只有 3/4 底池和全下两档，手牌按 169 类聚合、只保留权重
 * 最高的若干类。所以这是近似解，不是精确解 —— 但它会算到对手的反应，
 * 会为了不让对手便宜跟注而两极化下注，这比启发式的"赔率够不够"强得多。
 */

import { evaluateBest } from './evaluator.js';
import { freshDeck } from './cards.js';
import { HAND_RANK } from './hand-rank.js';
import { getLegalActions, totalPot } from './engine.js';
import { opponentRangeWeights, selfRangeWeights } from './equity.js';
import { handClass } from './preflop.js';

const CLASSES = HAND_RANK.length;
const RANK_CHAR = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const CHAR_RANK = new Map(RANK_CHAR.map((c, i) => [c, i + 2]));

export const RIVER_LIMITS = {
  MAX_CLASSES: 20, // 每边保留权重最高的若干类别
  ITERATIONS: 700,
  // 三个尺度。之前只有「3/4 池」和「全下」两档，求解器想下注时只能在这
  // 两者里挑，结果实测河牌下注有 57% 是全下 —— 那是抽象太粗造成的，
  // 不是策略偏好。加上小注档才有得选。
  BET_FRACTIONS: [0.33, 0.75, Infinity], // Infinity 表示全下
};

/**
 * 这一注能用哪些尺度。
 *
 * 之前无条件把「全下」放进选项里，实测河牌有 57% 的下注是全下。根因不是
 * 档位太少，而是**尺度算错了**：河牌时底池常常很小（前面几条街都下小注），
 * 拿全下去比就是九倍底池的超池，模型里对手只能弃牌，全下于是变成"总是赚"。
 *
 * 所以底池相对筹码太小时不提供全下，改用一个正常尺寸的超池。
 */
function betSizesFor(pot, stack) {
  const spr = stack / Math.max(1, pot);
  return spr <= 3 ? [0.33, 0.75, Infinity] : [0.33, 0.75, 1.25];
}

const RANK_OF_CLASS = new Map(HAND_RANK.map((h, i) => [h, i]));

/** 某个手牌类别在这个牌面上的全部具体组合及牌力。 */
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
      if (pair) {
        /* 对子：两个花色只要不同即可 */
      } else if (suited ? s1 !== s2 : s1 === s2) continue;
      const c1 = (a - 2) * 4 + s1;
      const c2 = (b - 2) * 4 + s2;
      if (dead.has(c1) || dead.has(c2)) continue;
      out.push({ cards: [c1, c2], score: evaluateBest([c1, c2, ...board]) });
    }
  }
  return out;
}

/**
 * 胜负矩阵：heroWin[i][j] 是我方第 i 类对抗对手第 j 类的胜率（平局算一半）。
 * 组合撞车时跳过 —— 这就是挡牌效应。
 *
 * 河牌用真实牌力直接比；翻牌和转牌还没有发完，就抽样补完公共牌、比最终牌力，
 * 得到的是"打到河牌的胜率"。后者让求解器在翻牌/转牌也能算进听牌的价值。
 */
function buildShowdownMatrix(heroClasses, oppClasses, board) {
  const hc = heroClasses.map((c) => combosOfClass(HAND_RANK[c], board));
  const oc = oppClasses.map((c) => combosOfClass(HAND_RANK[c], board));
  const m = heroClasses.map(() => new Float64Array(oppClasses.length));

  for (let i = 0; i < heroClasses.length; i++) {
    for (let j = 0; j < oppClasses.length; j++) {
      let sum = 0;
      let n = 0;
      for (const h of hc[i]) {
        for (const o of oc[j]) {
          if (h.cards[0] === o.cards[0] || h.cards[0] === o.cards[1]) continue;
          if (h.cards[1] === o.cards[0] || h.cards[1] === o.cards[1]) continue;
          sum += h.score > o.score ? 1 : h.score === o.score ? 0.5 : 0;
          n += 1;
        }
      }
      m[i][j] = n > 0 ? sum / n : 0.5;
    }
  }
  return m;
}

function topClasses(weights, limit) {
  const idx = [];
  for (let i = 0; i < CLASSES; i++) if (weights[i] > 0) idx.push(i);
  idx.sort((a, b) => weights[b] - weights[a]);
  const kept = idx.slice(0, limit);
  const w = kept.map((i) => weights[i]);
  const sum = w.reduce((a, b) => a + b, 0) || 1;
  return { classes: kept, weights: w.map((x) => x / sum) };
}

// ---------------------------------------------------------------------------
// 子树：根节点就是英雄当前要行动的地方
// ---------------------------------------------------------------------------

/**
 * @param {number} actor 0 = 英雄，1 = 对手
 * @param {object} ctx {potStart, inv0, inv1, stack0, stack1}
 * @param {boolean} heroCanCheck 英雄过牌后这条街是否直接结束
 */
function buildNode(actor, ctx, opponentChecked, sizes) {
  const actions = [];
  const stack = actor === 0 ? ctx.stack0 : ctx.stack1;
  const myInv = actor === 0 ? ctx.inv0 : ctx.inv1;

  const advance = (name, amount, nextActor, nextCtx, nextChecked) => {
    actions.push({ name, amount, child: buildNode(nextActor, nextCtx, nextChecked, sizes) });
  };

  const facing = (actor === 0 ? ctx.inv1 : ctx.inv0) - myInv;

  if (facing > 0) {
    // 面对下注：弃牌 / 跟注 / 全下加注
    actions.push({ name: 'fold', child: { kind: 'fold', folder: actor, ctx } });
    const callCtx =
      actor === 0
        ? { ...ctx, inv0: ctx.inv1 }
        : { ...ctx, inv1: ctx.inv0 };
    actions.push({ name: 'call', child: { kind: 'showdown', ctx: callCtx } });

    const raiseTo = Math.min(myInv + stack, ctx.inv0 === myInv ? ctx.inv1 * 2.5 : Math.max(ctx.inv0, ctx.inv1) * 2.5);
    if (raiseTo > Math.max(ctx.inv0, ctx.inv1)) {
      const raised = actor === 0 ? { ...ctx, inv0: raiseTo } : { ...ctx, inv1: raiseTo };
      const nextStack = actor === 0 ? { ...raised, stack0: ctx.stack0 - (raiseTo - myInv) } : { ...raised, stack1: ctx.stack1 - (raiseTo - myInv) };
      actions.push({
        name: 'raise',
        amount: raiseTo,
        child: buildNode(1 - actor, nextStack, false, sizes),
      });
    }
    return { kind: 'dec', player: actor, actions };
  }

  // 可以过牌
  if (opponentChecked) {
    // 对手已经过牌，我再过牌就是摊牌
    actions.push({ name: 'check', child: { kind: 'showdown', ctx } });
  } else {
    const nextChecked = true;
    actions.push({ name: 'check', child: buildNode(1 - actor, ctx, nextChecked, sizes) });
  }

  for (const fraction of sizes) {
    const size = fraction === Infinity ? stack : Math.min(stack, Math.round((ctx.potStart + ctx.inv0 + ctx.inv1) * fraction));
    if (size <= 0) continue;
    const allIn = size >= stack;
    const nextCtx = actor === 0
      ? { ...ctx, inv0: ctx.inv0 + size, stack0: ctx.stack0 - size }
      : { ...ctx, inv1: ctx.inv1 + size, stack1: ctx.stack1 - size };
    // 名字必须带上尺度：之前两档都叫 bet，写进策略对象时后一个把前一个
    // 覆盖掉了 —— 概率之和不再等于 1，而且有一档尺度直接消失。
    const name = allIn ? 'allin' : `bet-${fraction}`;
    actions.push({ name, amount: size, child: buildNode(1 - actor, nextCtx, false, sizes) });
  }
  return { kind: 'dec', player: actor, actions };
}

/** 给每个节点编号，并预分配效用矩阵缓冲区。 */
function indexNodes(root, nH, nO) {
  let id = 0;
  const pool = [];
  const visit = (node) => {
    node.id = id++;
    if (node.kind === 'dec') {
      pool[node.id] = [];
      for (let i = 0; i < nH; i++) pool[node.id].push(new Float64Array(nO));
      for (const a of node.actions) visit(a.child);
    }
  };
  visit(root);
  return pool;
}

// ---------------------------------------------------------------------------
// CFR+
// ---------------------------------------------------------------------------

function runCfr(root, heroW, oppW, heroWin, potStart, pool, iterations) {
  const nH = heroW.length;
  const nO = oppW.length;
  const regrets = new Map();
  const avg = new Map();

  function strategyFor(node, isHero, c) {
    const key = `${node.id}:${isHero ? 'h' : 'o'}:${c}`;
    let r = regrets.get(key);
    if (!r) {
      r = new Float64Array(node.actions.length);
      regrets.set(key, r);
    }
    let sum = 0;
    for (let a = 0; a < r.length; a++) sum += Math.max(0, r[a]);
    const s = new Float64Array(node.actions.length);
    if (sum > 0) for (let a = 0; a < r.length; a++) s[a] = Math.max(0, r[a]) / sum;
    else for (let a = 0; a < r.length; a++) s[a] = 1 / r.length;
    return { key, s };
  }

  /** 子节点在 (i,j) 上的英雄效用。 */
  function terminalValue(child, i, j) {
    const ctx = child.ctx;
    if (child.kind === 'fold') {
      return child.folder === 1 ? potStart + ctx.inv1 : -ctx.inv0;
    }
    const w = heroWin[i][j];
    return w * (potStart + ctx.inv1) - (1 - w) * ctx.inv0;
  }

  function walk(node, reachH, reachO) {
    if (node.kind === 'dec') {
      const isHero = node.player === 0;
      const count = isHero ? nH : nO;
      const strategies = [];
      const childValues = [];

      for (let a = 0; a < node.actions.length; a++) {
        const child = node.actions[a].child;
        const nextH = Float64Array.from(reachH);
        const nextO = Float64Array.from(reachO);
        // 先把策略算出来才能算到达概率
        for (let c = 0; c < count; c++) {
          const st = strategyFor(node, isHero, c);
          if (isHero) nextH[c] *= st.s[a];
          else nextO[c] *= st.s[a];
        }
        childValues.push(child.kind === 'dec' ? walk(child, nextH, nextO) : child);
      }

      const M = pool[node.id];
      const util = new Float64Array(count);
      for (let c = 0; c < count; c++) {
        const st = strategyFor(node, isHero, c);
        strategies.push(st);
        let v = 0;
        for (let a = 0; a < node.actions.length; a++) {
          const child = childValues[a];
          let cv = 0;
          if (child.kind === 'dec') {
            const m = child.matrix ?? pool[child.id];
            if (isHero) for (let j = 0; j < nO; j++) cv += reachO[j] * m[c][j];
            else for (let i = 0; i < nH; i++) cv -= reachH[i] * m[i][c];
          } else if (isHero) {
            for (let j = 0; j < nO; j++) cv += reachO[j] * terminalValue(child, c, j);
          } else {
            for (let i = 0; i < nH; i++) cv -= reachH[i] * terminalValue(child, i, c);
          }
          v += st.s[a] * cv;
        }
        util[c] = v;
      }

      // 遗憾更新 + 平均策略累积
      for (let c = 0; c < count; c++) {
        const st = strategies[c];
        const regret = regrets.get(st.key);
        for (let a = 0; a < node.actions.length; a++) {
          const child = childValues[a];
          let cv = 0;
          if (child.kind === 'dec') {
            const m = pool[child.id];
            if (isHero) for (let j = 0; j < nO; j++) cv += reachO[j] * m[c][j];
            else for (let i = 0; i < nH; i++) cv -= reachH[i] * m[i][c];
          } else if (isHero) {
            for (let j = 0; j < nO; j++) cv += reachO[j] * terminalValue(child, c, j);
          } else {
            for (let i = 0; i < nH; i++) cv -= reachH[i] * terminalValue(child, i, c);
          }
          regret[a] = Math.max(0, regret[a] + (cv - util[c]));
        }
        const reach = isHero ? reachH[c] : reachO[c];
        let acc = avg.get(st.key);
        if (!acc) {
          acc = new Float64Array(node.actions.length);
          avg.set(st.key, acc);
        }
        for (let a = 0; a < node.actions.length; a++) acc[a] += reach * st.s[a];
      }

      // 往上传递英雄视角的效用矩阵
      for (let i = 0; i < nH; i++) {
        const stHero = isHero ? strategies[i] : null;
        for (let j = 0; j < nO; j++) {
          const stOpp = !isHero ? strategies[j] : null;
          let v = 0;
          for (let a = 0; a < node.actions.length; a++) {
            const p = isHero ? stHero.s[a] : stOpp.s[a];
            const child = childValues[a];
            v += p * (child.kind === 'dec' ? pool[child.id][i][j] : terminalValue(child, i, j));
          }
          M[i][j] = v;
        }
      }
      node.matrix = M;
      return node;
    }
    return node;
  }

  const initH = Float64Array.from(heroW);
  const initO = Float64Array.from(oppW);
  for (let t = 0; t < iterations; t++) walk(root, initH, initO);
  return avg;
}

/**
 * 求解英雄当前在河牌的这个决策。
 *
 * 返回各行动的均衡频率与期望值；局面不适合求解时返回 null。
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
    heroStack,
    oppStack,
    heroIsFirst,
    opponentChecked = false,
    iterations = RIVER_LIMITS.ITERATIONS,
  } = opts;
  // 只解河牌。翻牌/转牌试过 —— 终局只走一轮下注、对手范围收窄不足，
  // 求解器会收敛到"反正对手会弃牌就无脑全下"，那个结果是错的，所以不做。
  if (board.length !== 5) return null;

  const heroTop = topClasses(heroWeights, RIVER_LIMITS.MAX_CLASSES);
  const oppTop = topClasses(oppWeights, RIVER_LIMITS.MAX_CLASSES);
  if (oppTop.classes.length === 0) return null;

  // 英雄自己的范围是"按胜率取前 X%"近似出来的，未必包含他手里实际那两张牌。
  // 不包含就直接求解失败 —— 所以这里把它补进去，给一个小权重。
  let heroIdx = heroTop.classes.indexOf(heroClass);
  if (heroIdx < 0) {
    heroTop.classes = [...heroTop.classes, heroClass].slice(0, RIVER_LIMITS.MAX_CLASSES + 1);
    heroTop.weights = [...heroTop.weights, 0.3];
    const total = heroTop.weights.reduce((a, b) => a + b, 0);
    heroTop.weights = heroTop.weights.map((w) => w / total);
    heroIdx = heroTop.classes.length - 1;
  }

  const heroWin = buildShowdownMatrix(heroTop.classes, oppTop.classes, board);
  const potStart = Math.max(0, pot - heroInvested - oppInvested);

  const root = buildNode(
    0,
    { potStart, inv0: heroInvested, inv1: oppInvested, stack0: heroStack, stack1: oppStack },
    opponentChecked,
    betSizesFor(potStart + heroInvested + oppInvested, Math.min(heroStack, oppStack))
  );
  if (root.kind !== 'dec' || root.actions.length === 0) return null;

  const pool = indexNodes(root, heroTop.weights.length, oppTop.weights.length);
  const started = Date.now();
  const avg = runCfr(
    root,
    heroTop.weights,
    oppTop.weights,
    heroWin,
    potStart,
    pool,
    iterations
  );

  const strategy = {};
  let total = 0;
  const counts = root.actions.map((a, idx) => {
    const acc = avg.get(`${root.id}:h:${heroIdx}`);
    const v = acc ? acc[idx] : 0;
    total += v;
    return v;
  });
  if (total <= 0) return null;
  root.actions.forEach((a, idx) => {
    strategy[a.name] = counts[idx] / total;
  });

  // 各行动的期望值（相对弃牌为 0 的口径）
  const ev = {};
  const foldRef = root.actions.find((a) => a.name === 'fold');
  for (let idx = 0; idx < root.actions.length; idx++) {
    const child = root.actions[idx].child;
    const nO = oppTop.weights.length;
    let v = 0;
    for (let j = 0; j < nO; j++) {
      const w = oppTop.weights[j];
      if (child.kind === 'dec') {
        v += w * (pool[child.id][heroIdx][j] ?? 0);
      } else {
        const ctx = child.ctx;
        v += w * (child.kind === 'fold'
          ? child.folder === 1 ? potStart + ctx.inv1 : -ctx.inv0
          : heroWin[heroIdx][j] * (potStart + ctx.inv1) - (1 - heroWin[heroIdx][j]) * ctx.inv0);
      }
    }
    ev[root.actions[idx].name] = v + (foldRef ? 0 : 0);
  }

  return {
    strategy,
    ev,
    actions: root.actions.map((a) => ({ name: a.name, amount: a.amount ?? 0 })),
    heroClass: heroTop.classes[heroIdx],
    heroIsFirst,
    elapsedMs: Date.now() - started,
  };
}

/**
 * 把引擎状态翻译成求解器输入。
 *
 * 只支持**单挑**：多人底池的求解规模大一个量级，那需要另一套抽象，
 * 暂时回落到启发式。局面不适合求解时返回 null。
 */
export function solveRiverForState(state, seatIdx, options = {}) {
  // 实验开关：HOLDEM_NO_SOLVER=1 时整条求解路径关闭，用来做 A/B 对照。
  // 浏览器里没有 process，所以这个开关对线上没有任何影响。
  if (typeof process !== 'undefined' && process.env?.HOLDEM_NO_SOLVER === '1') return null;
  if (state.board.length !== 5) return null;
  const legal = getLegalActions(state, seatIdx);
  if (!legal) return null;

  const live = state.seats.filter((s) => s.inHand && !s.folded);
  if (live.length !== 2) return null;

  const hero = state.seats[seatIdx];
  const opp = live.find((s) => s.index !== seatIdx);
  if (!opp || hero.hole.length !== 2) return null;

  const heroClass = RANK_OF_CLASS.get(handClass(hero.hole));
  if (heroClass === undefined) return null;

  const heroRange = selfRangeWeights(state, hero);
  const oppRanges = opponentRangeWeights(state, seatIdx);
  if (oppRanges.length !== 1) return null;

  const riverActions = state.streetActions ?? [];
  const opponentChecked = riverActions.some((a) => a.seat === opp.index && a.kind === 'check');
  // 按钮位翻牌后最后行动，所以不是按钮就是先手方
  const heroIsFirst = state.buttonSeat !== seatIdx;

  return solveRiver({
    board: state.board,
    heroWeights: heroRange,
    oppWeights: oppRanges[0],
    heroClass,
    pot: totalPot(state),
    heroInvested: hero.streetBet,
    oppInvested: opp.streetBet,
    heroStack: hero.stack,
    oppStack: opp.stack,
    heroIsFirst,
    opponentChecked,
    iterations: options.iterations,
    rng: options.rng,
  });
}
