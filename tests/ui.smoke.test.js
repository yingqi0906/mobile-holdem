import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * 界面冒烟测试。
 *
 * 只用一个极简的 DOM 桩，不起浏览器，专门用来抓
 * "getElementById 拿到 null"、"渲染时用了不存在的字段" 这类接线错误。
 */

class ClassList {
  constructor() {
    this.set = new Set();
  }
  add(...names) {
    names.forEach((n) => this.set.add(n));
  }
  remove(...names) {
    names.forEach((n) => this.set.delete(n));
  }
  contains(name) {
    return this.set.has(name);
  }
  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : Boolean(force);
    if (on) this.set.add(name);
    else this.set.delete(name);
    return on;
  }
}

class Style {
  constructor() {
    this.props = new Map();
  }
  setProperty(key, value) {
    this.props.set(key, value);
  }
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.classList = new ClassList();
    this.style = new Style();
    this.listeners = new Map();
    this.text = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
  }

  get className() {
    return [...this.classList.set].join(' ');
  }
  set className(value) {
    this.classList = new ClassList();
    String(value)
      .split(/\s+/)
      .filter(Boolean)
      .forEach((c) => this.classList.add(c));
  }

  get textContent() {
    return this.text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(value) {
    this.text = String(value);
    this.children = [];
  }

  get innerHTML() {
    return this.text;
  }
  set innerHTML(value) {
    this.text = String(value);
    this.children = [];
  }

  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    return child;
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  get childElementCount() {
    return this.children.length;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  dispatch(type, extra = {}) {
    for (const handler of this.listeners.get(type) ?? []) {
      handler({ type, target: this, preventDefault() {}, ...extra });
    }
  }

  /** 深度优先找出所有按钮，方便测试点它。 */
  findButtons(out = []) {
    if (this.tagName === 'BUTTON') out.push(this);
    for (const child of this.children) child.findButtons(out);
    return out;
  }
}

const byId = new Map();
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
for (const match of html.matchAll(/id="([^"]+)"/g)) {
  byId.set(match[1], new El('div'));
}

globalThis.document = {
  createElement: (tag) => new El(tag),
  getElementById: (id) => byId.get(id) ?? null,
};
globalThis.window = globalThis.window ?? {};
globalThis.window.addEventListener = () => {};

const { debug } = await import('../src/ui/app.js');

// ---------------------------------------------------------------------------

test('初始渲染：6 个座位、HUD、底牌明暗都正确', () => {
  debug.stop();

  const seats = byId.get('seat-layer');
  assert.equal(seats.children.length, 6, '应该建出 6 个座位');
  assert.match(byId.get('hud-blinds').textContent, /1 \/ 2/);
  assert.match(byId.get('hud-hand').textContent, /第 1 手/);

  const state = debug.getState();
  assert.equal(state.phase, 'preflop');
  assert.equal(state.seats[0].isHuman, true);
  assert.equal(byId.get('pot-amount').textContent, '3', '盲注已经进池');

  // 座位骨架顺序是 hole → plate → dealer → badge
  const heroCards = seats.children[0].children[0];
  assert.equal(heroCards.children.length, 2);
  assert.ok(
    heroCards.children.every((c) => !c.classList.contains('back')),
    '自己的底牌必须看得见'
  );

  const botCards = seats.children[3].children[0];
  assert.ok(
    botCards.children.every((c) => c.classList.contains('back')),
    '机器人的底牌应该是暗牌'
  );

  // 公共牌位置应该摆了 5 个占位槽
  assert.equal(byId.get('community').children.length, 5);
  debug.stop();
});

test('操作栏会轮到自己时出现按钮，轮到机器人时显示等待', () => {
  debug.stop();
  const bar = byId.get('actionbar');
  const state = debug.getState();

  if (state.toAct === 0) {
    const labels = bar.findButtons().map((b) => b.textContent);
    assert.ok(labels.some((l) => l.includes('弃牌')), `应该能弃牌，实际按钮：${labels}`);
    assert.ok(labels.some((l) => l.includes('过牌') || l.includes('跟注')));
  } else {
    assert.match(bar.textContent, /正在思考/);
  }
  debug.stop();
});

test('连续打完多手牌不会崩，且筹码守恒', () => {
  debug.stop();
  const initialTotal = 6 * 200;

  for (let hand = 0; hand < 5; hand++) {
    debug.newHand();
    let guard = 0;
    while (!debug.isHandOver() && guard++ < 400) {
      const state = debug.getState();
      const actor = state.seats[state.toAct];
      if (actor.isHuman) {
        const legal = debug.legal();
        debug.humanAct(legal.canCheck ? 'check' : 'call');
      } else {
        assert.ok(debug.botAct(), `座位 ${state.toAct} 应该能做出行动`);
      }
    }
    assert.ok(guard < 400, `第 ${hand + 1} 手没有正常结束`);

    const state = debug.getState();
    assert.equal(state.phase, 'handOver');
    assert.ok(state.result, '结束后必须有结算结果');

    // 这个单机版开了「破产自动补码」，所以筹码总量只可能因为补码而增加，
    // 而且每次补码正好是一个买入量。反过来，筹码凭空消失就是真 bug。
    const total = state.seats.reduce((sum, s) => sum + s.stack, 0);
    assert.ok(total >= initialTotal, `第 ${hand + 1} 手之后筹码不该减少`);
    assert.equal(
      (total - initialTotal) % 200,
      0,
      `第 ${hand + 1} 手之后多出来的筹码应该正好是补码`
    );
    assert.ok(
      state.seats.every((s) => Number.isInteger(s.stack) && s.stack >= 0),
      '筹码必须是非负整数'
    );
  }

  debug.stop();
});

test('点按钮能真的推进牌局', () => {
  debug.stop();
  debug.newHand();

  // 一直让机器人走到玩家行动
  let guard = 0;
  while (debug.getState().toAct !== 0 && guard++ < 50) {
    if (!debug.botAct()) break;
  }

  if (debug.getState().toAct === 0) {
    const bar = byId.get('actionbar');
    const fold = bar.findButtons().find((b) => b.textContent.includes('弃牌'));
    assert.ok(fold, '轮到自己时应该有一个弃牌按钮');
    fold.dispatch('click');
    const after = debug.getState();
    assert.equal(after.seats[0].folded, true, '点了弃牌就应该真的弃牌');
  }

  debug.stop();
});

// 回归测试：公共牌曾经每有人行动就被重建，导致牌面上的入场动画反复重放，
// 视觉上就是中间那块一直在闪。修法是只在牌真的变化时才动 DOM。
test('重绘不会重建已有的公共牌', () => {
  debug.stop();

  let reachedFlop = false;
  for (let attempt = 0; attempt < 15 && !reachedFlop; attempt++) {
    debug.newHand();
    let guard = 0;
    while (!debug.isHandOver() && guard++ < 400) {
      if (debug.getState().board.length >= 3) {
        reachedFlop = true;
        break;
      }
      const state = debug.getState();
      const actor = state.seats[state.toAct];
      if (actor.isHuman) {
        const legal = debug.legal();
        debug.humanAct(legal.canCheck ? 'check' : 'call');
      } else if (!debug.botAct()) {
        break;
      }
    }
  }
  assert.ok(reachedFlop, '这么多手牌里应该至少有一次看到翻牌');

  const community = byId.get('community');
  const snapshot = community.children.map((slot) => slot.children[0]);
  assert.equal(snapshot.filter(Boolean).length, 3, '翻牌应该是 3 张');

  // 连着重绘两次，节点身份必须完全不变（重建就意味着动画会重放）
  debug.render();
  debug.render();

  const after = community.children.map((slot) => slot.children[0]);
  for (let i = 0; i < 5; i++) {
    assert.equal(after[i], snapshot[i], `第 ${i} 张公共牌的 DOM 节点不该被重建`);
  }

  debug.stop();
  debug.newHand();
  debug.stop();
});

test('结算面板会亮出赢家的最佳五张牌', () => {
  debug.stop();

  // 打到出现摊牌为止（一路跟注，尽量让牌局走到河牌）
  let showdownReached = false;
  for (let attempt = 0; attempt < 20 && !showdownReached; attempt++) {
    debug.newHand();
    let guard = 0;
    while (!debug.isHandOver() && guard++ < 400) {
      const state = debug.getState();
      const actor = state.seats[state.toAct];
      if (actor.isHuman) {
        const legal = debug.legal();
        debug.humanAct(legal.canCheck ? 'check' : 'call');
      } else if (!debug.botAct()) {
        break;
      }
    }
    if (debug.getState().result?.type === 'showdown') showdownReached = true;
  }
  assert.ok(showdownReached, '这么多手牌里应该至少摊牌一次');

  debug.showResult();
  const overlay = byId.get('overlay');
  assert.equal(overlay.children.length, 1, '结算面板应该被挂上去');

  const sheet = overlay.children[0];
  assert.ok(sheet.classList.contains('result-sheet'), '应该是底部升起的结算面板');

  // 公共牌和最佳五张都要摆出来，各 5 张
  const cardRows = findAll(sheet, (n) => n.classList.contains('result-cards'));
  assert.equal(cardRows.length, 2, '应该同时有「公共牌」和「最佳五张」两块');
  for (const row of cardRows) {
    assert.equal(row.children.length, 5, '每块都应该是 5 张');
  }
  const labels = findAll(sheet, (n) => n.classList.contains('block-label')).map(
    (n) => n.textContent
  );
  assert.deepEqual(labels, ['公共牌', '最佳五张']);

  // 最佳五张必须标明牌型，否则光看五张牌不知道强在哪
  const captions = findAll(sheet, (n) => n.classList.contains('block-caption'));
  assert.equal(captions.length, 1, '最佳五张应该有牌型说明');
  const descriptions = debug.getState().result.shown.map((s) => s.description);
  assert.ok(
    descriptions.some((d) => captions[0].textContent.includes(d)),
    `说明里应该带上赢家的牌型（${descriptions.join(' / ')}），实际：${captions[0].textContent}`
  );

  const next = sheet.findButtons().find((b) => b.textContent.includes('下一手'));
  assert.ok(next, '应该有下一手按钮');

  // 摊牌列表里应该有所有亮牌玩家的底牌和牌型，不只是赢家
  const list = findFirst(sheet, (n) => n.classList.contains('showdown-list'));
  assert.ok(list, '应该有摊牌列表');
  assert.equal(
    list.children.length,
    debug.getState().result.shown.length,
    '每个亮牌玩家都要有一行'
  );
  const rows = list.children.map((li) => li.textContent);
  assert.ok(rows.length >= 2, `摊牌至少两行，实际 ${rows.length}`);
  for (const row of rows) {
    assert.ok(!/[A-Za-z]{2,}/.test(row), `摊牌行里出现了英文：${row}`);
  }

  debug.stop();
  debug.newHand();
  debug.stop();
});

/** 在 DOM 桩里按条件找第一个元素。 */
function findFirst(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.children) {
    const hit = findFirst(child, predicate);
    if (hit) return hit;
  }
  return null;
}

/** 在 DOM 桩里收集所有符合条件的元素。 */
function findAll(node, predicate, out = []) {
  if (predicate(node)) out.push(node);
  for (const child of node.children) findAll(child, predicate, out);
  return out;
}

test('输光后自动补码会让玩家看见，并计入累计买入', () => {
  debug.stop();
  debug.newHand();

  // 先把这一手打完，避免留下"未结清"的投入 —— 中途清空筹码的话，
  // 开新局时会把已经投入底池的筹码退回来，反而不会触发补码。
  let guard = 0;
  while (!debug.isHandOver() && guard++ < 400) {
    const live = debug.getState();
    if (live.seats[live.toAct].isHuman) {
      const legal = debug.legal();
      debug.humanAct(legal.canCheck ? 'check' : 'call');
    } else if (!debug.botAct()) {
      break;
    }
  }

  const before = debug.getState().seats[0];
  before.stack = 0;
  before.committed = 0;
  before.streetBet = 0;

  debug.newHand();

  // 补码之后还要下盲注，所以只会比 200 少一点
  const after = debug.getState().seats[0];
  assert.ok(after.stack >= 198, `应该补满到起始筹码附近，实际 ${after.stack}`);
  const toast = byId.get('toast');
  assert.ok(toast.textContent.includes('自动补入'), `应该有补码提示：${toast.textContent}`);
  assert.ok(toast.classList.contains('show'), '提示应该是可见状态');

  // 打开筹码面板，累计买入应该已经翻倍
  byId.get('btn-chips').dispatch('click');
  const body = byId.get('chip-body');
  assert.ok(body.textContent.includes('400'), `应该记到两次买入共 400：${body.textContent}`);

  // 面板要列出所有人，不只是自己
  const legend = findFirst(body, (n) => n.classList.contains('chip-legend'));
  assert.ok(legend, '应该有玩家明细表');
  assert.equal(legend.children.length, 7, '一行表头 + 六个玩家');
  for (const seat of debug.getState().seats) {
    assert.ok(
      body.textContent.includes(seat.name),
      `面板里应该有 ${seat.name}：${body.textContent}`
    );
  }

  const chart = findFirst(body, (n) => n.classList.contains('chip-chart'));
  assert.ok(chart, '应该有走势图容器');
  assert.ok(chart.innerHTML.includes('<svg'), '走势图应该是 SVG');
  assert.equal(
    (chart.innerHTML.match(/<polyline/g) ?? []).length,
    6,
    '六个玩家应该有六条线'
  );

  debug.stop();
  debug.newHand();
  debug.stop();
});

test('翻牌前的快捷加注按钮按大盲计', () => {
  debug.stop();

  let seated = false;
  for (let attempt = 0; attempt < 6 && !seated; attempt++) {
    debug.newHand();
    let guard = 0;
    while (debug.getState().toAct !== 0 && guard++ < 60) {
      if (!debug.botAct()) break;
    }
    if (debug.getState().toAct === 0) seated = true;
  }
  assert.ok(seated, '应该轮到玩家行动');

  const bar = byId.get('actionbar');
  const raise = bar
    .findButtons()
    .find((b) => !b.disabled && (b.textContent.includes('加注') || b.textContent.includes('下注')));
  const state = debug.getState();
  const debugInfo =
    `legal=${JSON.stringify(debug.legal())} currentBet=${state.currentBet} ` +
    `toAct=${state.toAct} cannotRaise=${JSON.stringify(state.cannotRaise)}`;
  assert.ok(raise, `轮到自己时应该能加注；${debugInfo}`);
  raise.dispatch('click');

  const labels = bar.findButtons().map((b) => b.textContent);
  assert.ok(labels.includes('全下'), `快捷按钮里应该有全下，实际：${labels} ${debugInfo}`);

  if (state.currentBet <= state.config.bigBlind) {
    // 还没人加注：按大盲说话
    for (const want of ['2.5BB', '3BB', '4BB']) {
      assert.ok(labels.includes(want), `缺少 ${want}，实际：${labels}`);
    }
  } else {
    // 已经有人加注：按倍数再加
    for (const want of ['2.5 倍', '3 倍', '4 倍']) {
      assert.ok(labels.includes(want), `缺少 ${want}，实际：${labels}`);
    }
  }

  debug.stop();
  debug.newHand();
  debug.stop();
});
