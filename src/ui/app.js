/**
 * 界面层。
 *
 * 这一层只做三件事：把 state 画出来、把点击翻译成 action、用定时器驱动机器人。
 * 所有规则判断都在 core/engine.js 里，界面永远不自己判断"能不能加注"。
 */

import {
  ACTION_TYPES,
  PHASES,
  applyAction,
  createTable,
  getLegalActions,
  humanSeat,
  startHand,
  totalPot,
} from '../core/engine.js';
import { attachBots, decideBotAction } from '../core/ai.js';
import { cardToLabel, isRed } from '../core/cards.js';
import { createCryptoRng } from '../core/rng.js';

const CONFIG = {
  smallBlind: 10,
  bigBlind: 20,
  startingStack: 2000,
  seatCount: 6,
  autoRebuy: true,
};

/**
 * 竖屏 6 人桌的坐标（相对牌桌区域的百分比）。
 * 0 号位是玩家自己，在正下方；之后顺时针（屏幕左边往上、顶部、右边往下）排列。
 */
const POSITIONS = [
  { x: 50, y: 89 },
  { x: 13, y: 72 },
  { x: 19, y: 16 },
  { x: 50, y: 10 },
  { x: 81, y: 16 },
  { x: 87, y: 72 },
];

/** 下注筹码摆在「座位 → 桌心」这条线上，0.42 是离座位的距离比例。 */
const BET_OFFSET = 0.42;

const STREET_NAMES = {
  [PHASES.PREFLOP]: '翻牌前',
  [PHASES.FLOP]: '翻牌',
  [PHASES.TURN]: '转牌',
  [PHASES.RIVER]: '河牌',
};

const els = {
  blinds: document.getElementById('hud-blinds'),
  hand: document.getElementById('hud-hand'),
  btnLog: document.getElementById('btn-log'),
  btnNew: document.getElementById('btn-new'),
  pot: document.getElementById('pot-amount'),
  community: document.getElementById('community'),
  street: document.getElementById('street-label'),
  seatLayer: document.getElementById('seat-layer'),
  chipLayer: document.getElementById('chip-layer'),
  actionbar: document.getElementById('actionbar'),
  overlay: document.getElementById('overlay'),
  logpanel: document.getElementById('logpanel'),
  logList: document.getElementById('log-list'),
  logClose: document.getElementById('log-close'),
};

const rng = createCryptoRng();

let state = attachBots(createTable(CONFIG), rng);
let botTimer = null;
let resultTimer = null;
let resultShownFor = -1;
let renderedPhase = null;
let betPanel = { open: false, value: 0 };
const seatEls = [];

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round5 = (v) => Math.round(v / 5) * 5;
const isHandOver = () => state.phase === PHASES.HAND_OVER || state.phase === PHASES.IDLE;

/** 头像里的缩写：中文名取第一个字，英文名取前两个字母。 */
function initials(name) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) return '?';
  if (/^[\x20-\x7f]+$/.test(trimmed)) return trimmed.slice(0, 2).toUpperCase();
  return trimmed.slice(0, 1);
}

function cardEl(card, { faceDown = false, board = false } = {}) {
  const node = el('div', 'card');
  if (board) node.classList.add('board-card');
  if (faceDown) {
    node.classList.add('back');
    return node;
  }
  const label = cardToLabel(card);
  node.classList.add(isRed(card) ? 'red' : 'black');
  node.appendChild(el('span', 'rank', label.slice(0, -1)));
  node.appendChild(el('span', 'suit', label.slice(-1)));
  return node;
}

function cardSlot(board = false) {
  const node = el('div', 'card slot');
  if (board) node.classList.add('board-card');
  return node;
}

// ---------------------------------------------------------------------------
// 座位骨架
// ---------------------------------------------------------------------------

function buildSeats() {
  els.seatLayer.innerHTML = '';
  els.chipLayer.innerHTML = '';
  seatEls.length = 0;

  for (let i = 0; i < state.seats.length; i++) {
    const seat = state.seats[i];
    const pos = POSITIONS[i] ?? POSITIONS[POSITIONS.length - 1];
    const seatEl = el('div', 'seat');
    seatEl.style.setProperty('--x', `${pos.x}%`);
    seatEl.style.setProperty('--y', `${pos.y}%`);
    if (pos.y < 50) seatEl.classList.add('top');

    const hole = el('div', 'hole');

    // 圆形头像 + 行动计时环（GGPoker 那个标志性的圈）
    const avatar = el('div', 'avatar');
    avatar.innerHTML =
      '<svg class="ring" viewBox="0 0 100 100" aria-hidden="true">' +
      '<circle class="track" cx="50" cy="50" r="46"></circle>' +
      '<circle class="drain" cx="50" cy="50" r="46"></circle>' +
      '</svg>';
    const face = el('div', 'face', initials(seat.name));
    const dealer = el('div', 'dealer-icon', 'D');
    dealer.style.display = 'none';
    avatar.append(face, dealer);

    const plate = el('div', 'plate');
    const name = el('div', 'name');
    const stack = el('div', 'stack');
    const stackValue = el('span', '', '0');
    stack.append(el('span', 'chip-icon'), stackValue);
    plate.append(name, stack);

    const badge = el('div', 'badge');
    badge.style.display = 'none';

    seatEl.append(hole, avatar, plate, badge);
    els.seatLayer.appendChild(seatEl);

    // 下注筹码摆在座位和桌心之间的位置
    const chip = el('div', 'bet-chip');
    const betValue = el('span', '', '');
    chip.append(el('span', 'chip-icon'), betValue);
    chip.style.setProperty('--x', `${pos.x + (50 - pos.x) * BET_OFFSET}%`);
    chip.style.setProperty('--y', `${pos.y + (50 - pos.y) * BET_OFFSET}%`);
    chip.style.display = 'none';
    els.chipLayer.appendChild(chip);

    seatEls.push({
      root: seatEl,
      hole,
      name,
      stackValue,
      badge,
      chip,
      betValue,
      dealer,
      pos,
      holeSig: null,
    });
  }
}

function revealFor(seat) {
  if (seat.isHuman) return true;
  return Boolean(state.result?.shown?.some((s) => s.seat === seat.index));
}

function renderSeats() {
  const winners = new Set((state.result?.winners ?? []).map((w) => w.seat));
  const acting = isHandOver() ? null : state.toAct;

  for (const seat of state.seats) {
    const ui = seatEls[seat.index];
    if (!ui) continue;

    ui.name.textContent = seat.isHuman ? `${seat.name}（你）` : seat.name;
    ui.stackValue.textContent = String(seat.stack);
    ui.root.classList.toggle('hero', seat.isHuman);
    ui.root.classList.toggle('acting', acting === seat.index);
    ui.root.classList.toggle('winner', winners.has(seat.index) && isHandOver());
    ui.root.classList.toggle('out', seat.inHand && seat.folded);

    if (acting === seat.index) {
      // 计时环的时长：机器人 0.9 秒，轮到自己给足思考时间
      ui.root.style.setProperty('--turn-ms', seat.isHuman ? '30000ms' : '900ms');
    }

    ui.dealer.style.display =
      state.buttonSeat === seat.index && seat.inHand ? 'grid' : 'none';

    // 底牌：内容没变就不重建，避免每次行动都重放动画
    const show = seat.inHand && revealFor(seat);
    const sig = seat.inHand
      ? `${state.handNumber}|${show ? 1 : 0}|${seat.hole.join(',')}`
      : 'out';
    if (sig !== ui.holeSig) {
      ui.holeSig = sig;
      ui.hole.innerHTML = '';
      if (seat.inHand) {
        for (const card of seat.hole) {
          const node = cardEl(card, { faceDown: !show });
          if (show && state.phase === PHASES.HAND_OVER) node.classList.add('dealt');
          ui.hole.appendChild(node);
        }
        while (ui.hole.childElementCount < 2) ui.hole.appendChild(cardSlot());
      }
    }

    // 状态徽标
    let badgeText = '';
    let badgeFold = false;
    if (seat.inHand && seat.folded) {
      badgeText = '弃牌';
      badgeFold = true;
    } else if (seat.inHand && seat.allIn) {
      badgeText = '全下';
    } else if (seat.lastAction) {
      badgeText = seat.lastAction.label;
    }
    ui.badge.textContent = badgeText;
    ui.badge.classList.toggle('fold', badgeFold);
    ui.badge.style.display = badgeText ? 'block' : 'none';

    // 桌面上的下注筹码
    if (seat.streetBet > 0) {
      ui.betValue.textContent = String(seat.streetBet);
      ui.chip.style.display = 'flex';
    } else {
      ui.chip.style.display = 'none';
    }
  }
}

// ---------------------------------------------------------------------------
// 牌桌中央
// ---------------------------------------------------------------------------

let boardSlots = [];
/** 记录每个牌位当前画的是哪张牌，用来判断要不要重建（不闪烁的关键）。 */
const boardRendered = [null, null, null, null, null];

function buildBoard() {
  els.community.innerHTML = '';
  boardSlots = [];
  for (let i = 0; i < 5; i++) {
    const slot = el('div', 'board-slot');
    els.community.appendChild(slot);
    boardSlots.push(slot);
    boardRendered[i] = null;
  }
}

function renderBoard() {
  els.pot.textContent = String(totalPot(state));
  els.street.textContent =
    state.phase === PHASES.IDLE
      ? '等待开局'
      : state.phase === PHASES.HAND_OVER
        ? state.result?.type === 'showdown'
          ? '亮牌结果'
          : '本手结束'
        : STREET_NAMES[state.phase] ?? '';

  for (let i = 0; i < 5; i++) {
    const card = state.board[i];

    if (card === undefined) {
      // 新的一手：把这个牌位清空
      if (boardRendered[i] !== null) {
        boardSlots[i].innerHTML = '';
        boardRendered[i] = null;
      }
      continue;
    }

    // 已经是这张牌了 —— 什么都不做，元素不动、动画就不会重放
    if (boardRendered[i] === card) continue;

    boardSlots[i].innerHTML = '';
    const node = cardEl(card, { board: true });
    node.classList.add('dealt');
    boardSlots[i].appendChild(node);
    boardRendered[i] = card;
  }
}

function renderHud() {
  const { smallBlind, bigBlind } = state.config;
  els.blinds.textContent = `盲注 ${smallBlind} / ${bigBlind}`;
  els.hand.textContent = `第 ${Math.max(state.handNumber, 1)} 手`;
}

// ---------------------------------------------------------------------------
// 操作栏
// ---------------------------------------------------------------------------

function potSizedTarget(legal, fraction) {
  const potAfterCall = totalPot(state) + legal.toCall;
  return clamp(
    round5(state.currentBet + potAfterCall * fraction),
    legal.minRaiseTo,
    legal.maxRaiseTo
  );
}

function applyBetValue(legal, value) {
  betPanel.value = clamp(value, legal.minRaiseTo, legal.maxRaiseTo);
}

function buildBetPanel(legal) {
  const panel = el('div', 'bet-panel');
  const head = el('div', 'bet-head');
  const label = el('span', 'label');
  const value = el('span', 'value');
  head.append(label, value);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'bet-slider';
  slider.min = String(legal.minRaiseTo);
  slider.max = String(legal.maxRaiseTo);
  slider.step = String(legal.maxRaiseTo - legal.minRaiseTo >= 150 ? 5 : 1);
  slider.value = String(betPanel.value);

  const presets = el('div', 'preset-row');
  const makePreset = (text, compute) => {
    const btn = el('button', 'preset', text);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      applyBetValue(legal, compute());
      slider.value = String(betPanel.value);
      syncPanel();
    });
    return btn;
  };

  presets.append(
    makePreset('½ 池', () => potSizedTarget(legal, 0.5)),
    makePreset('¾ 池', () => potSizedTarget(legal, 0.75)),
    makePreset('满池', () => potSizedTarget(legal, 1)),
    makePreset('全下', () => legal.maxRaiseTo)
  );

  function syncPanel() {
    const v = Number(slider.value);
    betPanel.value = v;
    const pct =
      legal.maxRaiseTo === legal.minRaiseTo
        ? 100
        : ((v - legal.minRaiseTo) / (legal.maxRaiseTo - legal.minRaiseTo)) * 100;
    slider.style.setProperty('--fill', `${pct}%`);
    label.textContent = v >= legal.maxRaiseTo ? '全下' : state.currentBet > 0 ? '加注到' : '下注';
    value.textContent = String(v);
    const confirm = document.getElementById('bet-confirm');
    if (confirm) confirm.textContent = `确认 ${v}`;
  }

  slider.addEventListener('input', syncPanel);
  panel.append(head, slider, presets);
  syncPanel();
  return panel;
}

function renderActionBar() {
  els.actionbar.innerHTML = '';

  if (isHandOver()) {
    const row = el('div', 'btn-row');
    const next = el('button', 'btn primary', '下一手');
    next.type = 'button';
    next.addEventListener('click', newHand);
    row.appendChild(next);
    els.actionbar.appendChild(row);
    return;
  }

  const hero = humanSeat(state);
  const legal = getLegalActions(state, hero.index);
  const myTurn = state.toAct === hero.index && legal;

  if (!myTurn) {
    const waiting = state.seats[state.toAct];
    els.actionbar.appendChild(
      el('div', 'status-line', waiting ? `${waiting.name} 正在思考…` : '发牌中…')
    );
    return;
  }

  if (betPanel.open) els.actionbar.appendChild(buildBetPanel(legal));

  const row = el('div', 'btn-row');

  if (betPanel.open) {
    const cancel = el('button', 'btn neutral', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', () => {
      betPanel.open = false;
      renderActionBar();
    });

    const confirm = el('button', 'btn raise', `确认 ${betPanel.value}`);
    confirm.type = 'button';
    confirm.id = 'bet-confirm';
    confirm.addEventListener('click', () => {
      const value = betPanel.value;
      betPanel.open = false;
      humanAct(ACTION_TYPES.RAISE, value);
    });

    row.append(cancel, confirm);
    els.actionbar.appendChild(row);
    return;
  }

  const fold = el('button', 'btn fold', '弃牌');
  fold.type = 'button';
  fold.addEventListener('click', () => humanAct(ACTION_TYPES.FOLD));

  const call = el('button', 'btn call');
  call.type = 'button';
  if (legal.canCheck) {
    call.append(el('span', '', '过牌'));
  } else {
    call.append(el('span', '', '跟注'), el('small', '', String(legal.toCall)));
  }
  call.addEventListener('click', () =>
    humanAct(legal.canCheck ? ACTION_TYPES.CHECK : ACTION_TYPES.CALL)
  );

  if (legal.canRaise) {
    const openRaise = el('button', 'btn raise');
    openRaise.type = 'button';
    if (legal.isAllInOnly) {
      openRaise.append(el('span', '', '全下'), el('small', '', String(legal.maxRaiseTo)));
      openRaise.addEventListener('click', () => humanAct(ACTION_TYPES.ALL_IN));
    } else {
      openRaise.append(el('span', '', state.currentBet > 0 ? '加注' : '下注'));
      openRaise.append(el('small', '', `最少 ${legal.minRaiseTo}`));
      openRaise.addEventListener('click', () => {
        betPanel.open = true;
        applyBetValue(legal, legal.minRaiseTo);
        renderActionBar();
      });
    }
    row.append(fold, call, openRaise);
  } else {
    const blocked = el('button', 'btn raise', '不能加注');
    blocked.type = 'button';
    blocked.disabled = true;
    row.append(fold, call, blocked);
  }

  els.actionbar.appendChild(row);
}

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------

function renderLog() {
  if (els.logpanel.classList.contains('hidden')) return;
  els.logList.innerHTML = '';
  let lastHand = null;
  for (const entry of state.log.slice(-150)) {
    if (entry.hand !== lastHand) {
      lastHand = entry.hand;
      els.logList.appendChild(el('li', 'hand-start', `第 ${entry.hand} 手`));
    }
    els.logList.appendChild(el('li', '', entry.text));
  }
  els.logList.scrollTop = els.logList.scrollHeight;
}

// ---------------------------------------------------------------------------
// 结算弹窗
// ---------------------------------------------------------------------------

function showResult() {
  const result = state.result;
  if (!result) return;

  const hero = humanSeat(state);
  const delta = hero.stack - hero.startStack;
  const won = delta > 0;

  const card = el('div', 'result-card');
  card.appendChild(
    el('h2', '', delta > 0 ? '这一手赢了' : delta < 0 ? '这一手输了' : '平手')
  );
  card.appendChild(el('div', `delta ${won ? 'up' : 'down'}`, `${delta > 0 ? '+' : ''}${delta}`));

  const detail = el('div', 'detail');
  if (result.type === 'fold') {
    const w = result.winners[0];
    detail.innerHTML =
      w.seat === hero.index
        ? `其他人都弃牌，你直接拿下 <b>${w.amount}</b>`
        : `其他人都弃牌，<b>${state.seats[w.seat].name}</b> 拿下 ${w.amount}`;
  } else {
    const lines = result.winners.map(
      (w) =>
        `<b>${state.seats[w.seat].name}</b> 用 ${
          result.shown.find((s) => s.seat === w.seat)?.description ?? ''
        } 赢得 ${w.amount}`
    );
    detail.innerHTML = lines.join('<br>');
  }
  card.appendChild(detail);

  const shown = result.shown?.find((s) => s.seat === hero.index);
  if (shown) {
    const row = el('div', 'shown');
    for (const c of shown.cards) row.appendChild(cardEl(c));
    card.appendChild(row);
  }

  const next = el('button', 'btn primary', '下一手');
  next.type = 'button';
  next.addEventListener('click', newHand);
  card.appendChild(next);

  els.overlay.innerHTML = '';
  els.overlay.appendChild(card);
  els.overlay.classList.remove('hidden');
}

function hideOverlay() {
  els.overlay.classList.add('hidden');
  els.overlay.innerHTML = '';
}

function maybeShowResult() {
  if (!isHandOver() || !state.result) return;
  if (resultShownFor === state.handNumber) return;
  const hand = state.handNumber;
  resultShownFor = hand;
  clearTimeout(resultTimer);
  resultTimer = setTimeout(() => {
    if (resultShownFor === hand && state.handNumber === hand) showResult();
  }, 620);
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------

function render() {
  // 进入新的一条街时清空上一街的动作提示，只保留"弃牌/全下"这类状态
  if (renderedPhase !== state.phase) {
    renderedPhase = state.phase;
    for (const seat of state.seats) {
      if (seat.inHand && !seat.folded) seat.lastAction = null;
    }
  }

  renderHud();
  renderBoard();
  renderSeats();
  renderActionBar();
  renderLog();
  maybeShowResult();
}

function heroIsOut() {
  const hero = humanSeat(state);
  return hero.folded || !hero.inHand;
}

function scheduleBots(delay) {
  clearTimeout(botTimer);
  const base = heroIsOut() ? 170 : 420;
  botTimer = setTimeout(stepBots, delay ?? base + Math.random() * base * 0.9);
}

/** 同步跑一次机器人行动，返回是否真的行动了。 */
function performBotAction() {
  if (isHandOver()) return false;
  const seat = state.seats[state.toAct];
  if (!seat || seat.isHuman) return false;
  const action = decideBotAction(state, state.toAct, rng);
  if (!action) return false;
  state = applyAction(state, action, rng);
  render();
  return true;
}

function stepBots() {
  if (isHandOver()) return;
  if (!performBotAction()) {
    render();
    return;
  }
  scheduleBots();
}

function humanAct(type, amount) {
  if (isHandOver()) return;
  const hero = humanSeat(state);
  if (state.toAct !== hero.index) return;
  try {
    state = applyAction(state, { seat: hero.index, type, amount }, rng);
  } catch (err) {
    // 理论上界面只会送出合法行动，真出问题也不要把整局卡死
    console.error('行动被拒绝：', err);
    render();
    return;
  }
  render();
  if (!isHandOver()) scheduleBots(260);
}

function newHand() {
  clearTimeout(botTimer);
  clearTimeout(resultTimer);
  hideOverlay();
  betPanel.open = false;
  renderedPhase = null;

  state = startHand(state, rng);
  render();

  if (isHandOver()) {
    // 唯一会走到这里的情况是桌上只剩一个还有筹码的玩家
    els.actionbar.innerHTML = '';
    els.actionbar.appendChild(el('div', 'status-line', '桌上没有足够的玩家，点右上角重开'));
    return;
  }
  scheduleBots(760);
}

function hardReset() {
  clearTimeout(botTimer);
  clearTimeout(resultTimer);
  hideOverlay();
  betPanel.open = false;
  renderedPhase = null;
  resultShownFor = -1;
  state = attachBots(createTable(CONFIG), rng);
  buildSeats();
  render();
  newHand();
}

// ---------------------------------------------------------------------------

function bind() {
  els.btnNew.addEventListener('click', hardReset);
  els.btnLog.addEventListener('click', () => {
    els.logpanel.classList.remove('hidden');
    renderLog();
  });
  els.logClose.addEventListener('click', () => els.logpanel.classList.add('hidden'));
}

function boot() {
  buildBoard();
  buildSeats();
  bind();
  newHand();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
}

if (typeof document !== 'undefined') boot();

/**
 * 调试出口：浏览器控制台里可以直接 `__holdem.newHand()`、`__holdem.legal()`，
 * 自动化测试也靠它在不启动浏览器的情况下驱动整局牌。
 */
export const debug = {
  getState: () => state,
  legal: () => getLegalActions(state, state.toAct),
  newHand,
  humanAct: (type, amount) => humanAct(type, amount),
  botAct: () => performBotAction(),
  render,
  stop: () => {
    clearTimeout(botTimer);
    clearTimeout(resultTimer);
  },
  isHandOver: () => isHandOver(),
};

if (typeof window !== 'undefined') window.__holdem = debug;
