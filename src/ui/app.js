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
import { advise, reviewDecision } from '../core/coach.js';
import { bestFive } from '../core/evaluator.js';
import { createCryptoRng } from '../core/rng.js';

/** 每次发布时改一下这个号，界面上能看到，方便确认自己加载的是哪一版。 */
const BUILD = 'v0.20';

const CONFIG = {
  smallBlind: 1,
  bigBlind: 2,
  startingStack: 200,
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
  btnChips: document.getElementById('btn-chips'),
  btnCoach: document.getElementById('btn-coach'),
  net: document.getElementById('hud-net'),
  logBuild: document.getElementById('log-build'),
  chipBuild: document.getElementById('chip-build'),
  tableArea: document.getElementById('table-area'),
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
  chippanel: document.getElementById('chippanel'),
  chipBody: document.getElementById('chip-body'),
  chipClose: document.getElementById('chip-close'),
  toast: document.getElementById('toast'),
};

const rng = createCryptoRng();

let state = attachBots(createTable(CONFIG), rng);
let botTimer = null;
let resultTimer = null;
let resultShownFor = -1;
let renderedPhase = null;
let betPanel = { open: false, value: 0 };
let toastTimer = null;
const seatEls = [];

/**
 * 教练状态。
 *
 * advice 是"轮到玩家时算出的最佳行动"，key 用来判断是否已经算过 ——
 * 每次玩家行动前都要重新算，因为局面变了。
 * review 是玩家行动之后的复盘结果。
 */
const coach = { enabled: true, key: null, advice: null, review: null, expanded: false };
let reviewTimer = null;

/** 每个座位一条线，自己那条用金色。数据来自引擎的 session 账本。 */
const SEAT_COLORS = ['#f2c53d', '#7ce0a7', '#6db3f2', '#f19a92', '#c79af2', '#f2a65a'];

/** 从顶部飘一条提示，比如破产补码。 */
function showToast(text) {
  clearTimeout(toastTimer);
  els.toast.textContent = text;
  els.toast.classList.add('show');
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2800);
}

/**
 * 把所有座位的筹码画成一张多线图 —— 一眼能看出谁在赢、谁在输。
 *
 * 用 innerHTML 拼 SVG 字符串而不是 createElementNS：这样连测试用的
 * DOM 桩也能跑通，不需要额外支持命名空间。
 */
function chipChartSvg(series, options = {}) {
  const w = options.width ?? 300;
  const h = options.height ?? 96;
  const pad = 8;
  const usable = series.filter((s) => s.values.length >= 2);
  if (usable.length === 0) return '';

  const all = usable.flatMap((s) => s.values);
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = Math.max(1, max - min);
  const steps = Math.max(...usable.map((s) => s.values.length)) - 1;
  const x = (i) => pad + (i / Math.max(1, steps)) * (w - pad * 2);
  const y = (v) => h - pad - ((v - min) / span) * (h - pad * 2);

  const lines = usable
    .map((s) => {
      const points = s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
      const width = s.emphasis ? 2.6 : 1.6;
      const opacity = s.emphasis ? 1 : 0.72;
      return (
        `<polyline points="${points}" fill="none" stroke="${s.color}" ` +
        `stroke-width="${width}" opacity="${opacity}" ` +
        `stroke-linejoin="round" stroke-linecap="round"/>`
      );
    })
    .join('');

  // 虚线是买入线，掉到它下面就是在亏
  const baseY = y(usable[0].values[0]).toFixed(1);
  const baseline =
    `<line x1="${pad}" y1="${baseY}" x2="${w - pad}" y2="${baseY}" ` +
    `stroke="rgba(255,255,255,0.18)" stroke-width="1" stroke-dasharray="3 4"/>`;

  return (
    `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="spark" aria-hidden="true">` +
    baseline +
    lines +
    '</svg>'
  );
}

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
/**
 * 筹码取整的步长：四分之一个大盲，至少 1。
 * 盲注 1/2 时步长就是 1 —— 以前写死 5 的话，最小加注 2 会被取整成 0，直接算错。
 */
const chipStep = () => Math.max(1, Math.round(state.config.bigBlind / 4));
const roundChip = (v) => Math.round(v / chipStep()) * chipStep();
const isHandOver = () => state.phase === PHASES.HAND_OVER || state.phase === PHASES.IDLE;

/** 头像里的缩写：中文名取前两个字，英文名取前两个字母。 */
function initials(name) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) return '?';
  return /^[\x20-\x7f]+$/.test(trimmed)
    ? trimmed.slice(0, 2).toUpperCase()
    : trimmed.slice(0, 2);
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
      actSeq: null,
      lastBet: 0,
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
    let badgeKind = '';
    // 摊牌时每个亮牌的人都显示自己的牌型，不只是赢家
    const showdownInfo = isHandOver()
      ? state.result?.shown?.find((s) => s.seat === seat.index)
      : null;
    const winInfo = isHandOver()
      ? state.result?.winners?.find((w) => w.seat === seat.index)
      : null;

    if (showdownInfo) {
      badgeText = showdownInfo.description;
      badgeKind = 'showdown';
    } else if (winInfo) {
      badgeText = '赢得底池';
      badgeKind = 'win';
    } else if (seat.inHand && seat.folded) {
      badgeText = '弃牌';
      badgeKind = 'fold';
    } else if (seat.inHand && seat.allIn) {
      badgeText = '全下';
      badgeKind = 'allIn';
    } else if (seat.lastAction) {
      badgeText = seat.lastAction.label;
      badgeKind = seat.lastAction.kind ?? '';
    }
    ui.badge.textContent = badgeText;
    ui.badge.className = badgeKind ? `badge ${badgeKind}` : 'badge';
    ui.badge.style.display = badgeText ? 'block' : 'none';

    // 有人做了新动作 —— 放个光环、让徽标弹一下，别让它一闪而过。
    // 用 seq 而不是文字判断，否则连续两次「跟注 2」会被当成没变化。
    const seq = seat.lastAction?.seq ?? null;
    if (seq !== null && seq !== ui.actSeq) {
      ui.actSeq = seq;
      playActionEffect(seat.index, seat.lastAction.kind);
      pulse(ui.badge, 'pop');
    }

    // 桌面上的下注筹码
    if (seat.streetBet > 0) {
      if (ui.lastBet !== seat.streetBet) {
        ui.lastBet = seat.streetBet;
        ui.betValue.textContent = String(seat.streetBet);
        pulse(ui.chip, 'pulse');
      }
      ui.chip.style.display = 'flex';
    } else {
      ui.lastBet = 0;
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
  // 版本号放在两个面板的标题旁边 —— 放在顶部会被挤掉（窄屏上实测过）
  els.logBuild.textContent = BUILD;
  els.chipBuild.textContent = BUILD;

  // 常驻显示"本局净变化" —— 座位上那块筹码数字看不出这个
  const hero = humanSeat(state);
  const net = hero.stack - state.session.seats[hero.index].buyIn;
  els.net.textContent = `${net > 0 ? '+' : ''}${net}`;
  els.btnChips.classList.toggle('up', net > 0);
  els.btnChips.classList.toggle('down', net < 0);
}

// ---------------------------------------------------------------------------
// 操作栏
// ---------------------------------------------------------------------------

function potSizedTarget(legal, fraction) {
  const potAfterCall = totalPot(state) + legal.toCall;
  return clamp(
    roundChip(state.currentBet + potAfterCall * fraction),
    legal.minRaiseTo,
    legal.maxRaiseTo
  );
}

/**
 * 快捷加注按钮。
 *
 * 翻牌前和翻牌后应该是两套逻辑：
 *   翻牌前 —— 按「几个大盲」说话（2.5BB / 3BB），这是牌桌上的通用语言；
 *             如果已经有人加注，就改成「几倍」再加。
 *   翻牌后 —— 按底池比例（1/3 池、1/2 池、满池）才是标准说法。
 */
function betPresets(legal) {
  const bb = state.config.bigBlind;
  const fit = (v) => clamp(roundChip(v), legal.minRaiseTo, legal.maxRaiseTo);

  if (state.phase === PHASES.PREFLOP) {
    if (state.currentBet <= bb) {
      return [
        { label: '2.5BB', value: fit(bb * 2.5) },
        { label: '3BB', value: fit(bb * 3) },
        { label: '4BB', value: fit(bb * 4) },
        { label: '全下', value: legal.maxRaiseTo },
      ];
    }
    return [
      { label: '2.5 倍', value: fit(state.currentBet * 2.5) },
      { label: '3 倍', value: fit(state.currentBet * 3) },
      { label: '4 倍', value: fit(state.currentBet * 4) },
      { label: '全下', value: legal.maxRaiseTo },
    ];
  }

  return [
    { label: '⅓ 池', value: potSizedTarget(legal, 1 / 3) },
    { label: '½ 池', value: potSizedTarget(legal, 0.5) },
    { label: '满池', value: potSizedTarget(legal, 1) },
    { label: '全下', value: legal.maxRaiseTo },
  ];
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
  // 筹码量级小的时候用 5 做步长太粗，滑一下就越过好几个大盲
  slider.step = String(legal.maxRaiseTo - legal.minRaiseTo >= 500 ? 5 : 1);
  slider.value = String(betPanel.value);

  const presets = el('div', 'preset-row');
  for (const preset of betPresets(legal)) {
    const btn = el('button', 'preset', preset.label);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      applyBetValue(legal, preset.value);
      slider.value = String(betPanel.value);
      syncPanel();
    });
    presets.appendChild(btn);
  }

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

  const hero = humanSeat(state);
  const legal = getLegalActions(state, hero.index);
  const myTurn = !isHandOver() && state.toAct === hero.index && Boolean(legal);
  const showAdvice = Boolean(myTurn && coach.enabled && coach.advice);

  // 操作栏变高时牌桌会被压矮，把自己的座位往上收一点，
  // 免得筹码名牌被面板盖住。
  els.tableArea.classList.toggle(
    'compact',
    betPanel.open || Boolean(coach.review) || showAdvice
  );

  // 复盘卡片放在最上面：它是对刚刚那一步的反馈，比什么都重要
  if (coach.review) els.actionbar.appendChild(buildReviewCard(coach.review));

  if (isHandOver()) {
    const row = el('div', 'btn-row');
    const next = el('button', 'btn primary', '下一手');
    next.type = 'button';
    next.addEventListener('click', newHand);
    row.appendChild(next);
    els.actionbar.appendChild(row);
    return;
  }

  if (!myTurn) {
    const waiting = state.seats[state.toAct];
    els.actionbar.appendChild(
      el('div', 'status-line', waiting ? `${waiting.name} 正在思考…` : '发牌中…')
    );
    return;
  }

  if (showAdvice) els.actionbar.appendChild(buildAdviceStrip(coach.advice));
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

/** 筹码面板：所有人的走势曲线 + 每人一行的明细。 */
function renderChipPanel() {
  if (els.chippanel.classList.contains('hidden')) return;

  const heroIndex = humanSeat(state).index;
  const start = state.config.startingStack;

  const series = state.session.seats.map((stats) => ({
    color: SEAT_COLORS[stats.index % SEAT_COLORS.length],
    values: stats.history,
    emphasis: stats.index === heroIndex,
  }));

  els.chipBody.innerHTML = '';

  const chart = el('div', 'chip-chart');
  chart.innerHTML = chipChartSvg(series);
  els.chipBody.appendChild(chart);

  const legend = el('ul', 'chip-legend');
  const head = el('li', 'head');
  head.append(
    el('span', ''),
    el('span', '', '玩家'),
    el('span', '', '买入'),
    el('span', '', '筹码'),
    el('span', '', '净变化')
  );
  legend.appendChild(head);

  for (const seat of state.seats) {
    const stats = state.session.seats[seat.index];
    const net = seat.stack - stats.buyIn;
    const li = el('li', seat.index === heroIndex ? 'me' : '');

    const dot = el('span', 'dot');
    dot.style.setProperty('background', SEAT_COLORS[seat.index % SEAT_COLORS.length]);

    li.append(
      dot,
      el('span', 'who', seat.index === heroIndex ? '你' : seat.name),
      el('span', 'buyin', stats.buyIn > start ? String(stats.buyIn) : '—'),
      el('span', 'stack', String(seat.stack)),
      el('span', `net ${net > 0 ? 'up' : net < 0 ? 'down' : ''}`, `${net > 0 ? '+' : ''}${net}`)
    );
    legend.appendChild(li);
  }
  els.chipBody.appendChild(legend);

  const note =
    `每手结束后记一次筹码。买入一列不是「—」说明输光过、自动补过码；` +
    `净变化 = 当前筹码 − 累计买入。共打了 ${state.session.hands} 手。`;
  els.chipBody.appendChild(el('p', 'chip-note', note));
}

// ---------------------------------------------------------------------------
// 结算弹窗
// ---------------------------------------------------------------------------

function showResult() {
  const result = state.result;
  if (!result) return;

  const hero = humanSeat(state);
  const delta = hero.stack - hero.startStack;
  const shownOf = (seatIdx) => result.shown?.find((s) => s.seat === seatIdx) ?? null;

  const sheet = el(
    'div',
    `result-sheet ${delta > 0 ? 'win' : delta < 0 ? 'loss' : 'tie'}`
  );
  // 内容放 body 里滚动，"下一手"按钮固定在底部，永远看得见
  const body = el('div', 'result-body');

  // 自上而下：结果 → 盈亏 → 说明 → 赢家的牌 → 派彩 → 下一手
  body.appendChild(
    el('div', 'result-title', delta > 0 ? '你赢了' : delta < 0 ? '你输了' : '平手')
  );
  const amount = el('div', `result-amount ${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}`);
  amount.append(el('span', 'chip-icon'), el('span', '', `${delta > 0 ? '+' : ''}${delta}`));
  body.appendChild(amount);
  body.appendChild(
    el('div', 'result-sub', result.type === 'fold' ? '其他人都弃牌' : '按牌型大小分配彩池')
  );

  // 公共牌：所有人共用的信息，先摆出来，否则光看底牌不知道牌型是怎么来的
  if (state.board.length) {
    body.appendChild(resultBlock('公共牌', state.board));
  }

  if (result.shown?.length) {
    // 摊牌：把每个亮牌玩家的底牌和牌型都列出来，按牌力从强到弱排。
    // 只显示赢家不够 —— 你更想知道自己和对手差在哪。
    const list = el('ul', 'showdown-list');
    const ranked = [...result.shown].sort((a, b) => b.score - a.score);
    for (const info of ranked) {
      const seat = state.seats[info.seat];
      const isWinner = result.winners.some((w) => w.seat === info.seat);
      const net = seat.stack - seat.startStack;

      const li = el('li', `${info.seat === hero.index ? 'me ' : ''}${isWinner ? 'winner' : ''}`);
      const cards = el('div', 'sd-cards');
      for (const card of info.cards) cards.appendChild(cardEl(card));
      const mid = el('div', 'sd-mid');
      mid.appendChild(el('div', 'sd-name', info.seat === hero.index ? '你' : seat.name));
      mid.appendChild(el('div', 'sd-hand', info.description));
      li.append(cards, mid, el('span', 'sd-amt', `${net > 0 ? '+' : ''}${net}`));
      list.appendChild(li);
    }
    body.appendChild(list);

    // 赢家的牌到底是哪五张凑出来的，单独再亮一次，并且标上牌型
    const champ = result.winners.find((w) => shownOf(w.seat));
    if (champ) {
      const seat = state.seats[champ.seat];
      const who = champ.seat === hero.index ? '你' : seat.name;
      const info = shownOf(champ.seat);
      body.appendChild(
        resultBlock(
          '最佳五张',
          bestFive([...seat.hole, ...state.board]),
          `${who} · ${info.description}`
        )
      );
    }
  } else {
    // 弃牌结束：没人亮牌，只需要说清谁拿走了底池
    const payouts = el('ul', 'result-payouts');
    for (const w of result.winners) {
      const li = el('li', w.seat === hero.index ? 'me' : '');
      li.appendChild(el('span', 'who', w.seat === hero.index ? '你' : state.seats[w.seat].name));
      li.appendChild(el('span', 'hand', '其他人弃牌'));
      li.appendChild(el('span', 'amt', `+${w.amount}`));
      payouts.appendChild(li);
    }
    body.appendChild(payouts);
  }

  const next = el('button', 'btn primary result-next', '下一手');
  next.type = 'button';
  next.addEventListener('click', newHand);
  sheet.append(body, next);

  els.overlay.innerHTML = '';
  els.overlay.appendChild(sheet);
  els.overlay.classList.remove('hidden');

  // 筹码飞向赢家的那个数字
  for (const w of result.winners) showWinDelta(w.seat, w.amount);
}

/** 赢家座位上飘一个 "+340" 的数字，给结算加点即时反馈。 */
function showWinDelta(seatIdx, amount) {
  const pos = POSITIONS[seatIdx] ?? POSITIONS[0];
  const node = el('div', 'win-delta', `+${amount}`);
  node.style.setProperty('--x', `${pos.x}%`);
  node.style.setProperty('--y', `${pos.y}%`);
  els.chipLayer.appendChild(node);
  setTimeout(() => node.remove(), 1800);
}

/** 重新触发一次 CSS 动画 —— 单纯反复加同一个 class 是不会重播的。 */
function pulse(node, className) {
  node.classList.remove(className);
  void node.offsetWidth; // 读一下布局，强制浏览器重排
  node.classList.add(className);
}

/** 轮到玩家时算一次建议。同一个局面只算一次，否则每帧都要跑蒙特卡洛。 */
function updateCoach() {
  if (!coach.enabled || isHandOver()) return;
  const hero = humanSeat(state);
  if (state.toAct !== hero.index) return;
  const key = `${state.handNumber}:${state.actionSeq ?? 0}`;
  if (coach.key === key) return;
  coach.key = key;
  coach.expanded = false;
  coach.advice = advise(state, hero.index, rng);
}

/** 把建议翻译成一句话。 */
function adviceText(a) {
  if (!a) return '';
  if (a.action === ACTION_TYPES.FOLD) return '弃牌';
  if (a.action === ACTION_TYPES.CHECK) return '过牌';
  if (a.action === ACTION_TYPES.CALL) return `跟注 ${a.toCall ?? ''}`.trim();
  if (a.amount) return `加注到 ${a.amount}`;
  if (a.fraction) return `下注约 ${Math.round(a.fraction * 100)}% 底池`;
  return '加注';
}

function buildAdviceStrip(advice) {
  const box = el('div', 'coach-advice');
  const head = el('div', 'coach-head');
  head.appendChild(el('span', 'coach-tag', '建议'));
  head.appendChild(el('span', 'coach-action', adviceText(advice)));

  const why = el('button', 'coach-why', coach.expanded ? '收起解析' : '为什么');
  why.type = 'button';
  why.addEventListener('click', () => {
    coach.expanded = !coach.expanded;
    renderActionBar();
  });
  head.appendChild(why);
  box.appendChild(head);

  if (coach.expanded) {
    const list = el('ul', 'coach-reasons');
    for (const reason of advice.reasons ?? []) list.appendChild(el('li', '', reason));
    box.appendChild(list);
  }
  return box;
}

function buildReviewCard(review) {
  const box = el('div', `coach-review ${review.grade}`);
  box.appendChild(el('div', 'coach-review-title', review.title));
  box.appendChild(el('div', 'coach-review-detail', review.detail));
  const close = el('button', 'coach-close', '×');
  close.type = 'button';
  close.addEventListener('click', () => {
    coach.review = null;
    renderActionBar();
  });
  box.appendChild(close);
  return box;
}

/**
 * 座位周围扩散一圈彩色光环，标明这个座位刚刚做了什么。
 * 单机版里机器人一个接一个行动，没有这个的话动作就是一闪而过。
 */
function playActionEffect(seatIdx, kind) {
  const pos = POSITIONS[seatIdx] ?? POSITIONS[0];
  const node = el('div', `seat-flash ${kind ?? ''}`);
  node.style.setProperty('--x', `${pos.x}%`);
  node.style.setProperty('--y', `${pos.y}%`);
  els.chipLayer.appendChild(node);
  setTimeout(() => node.remove(), 900);
}

/**
 * 结算面板里的一个分节：小标题 +（可选说明）+ 一排牌。
 * 公共牌和最佳五张都用它，保证两处的排版完全一致。
 */
function resultBlock(label, cards, caption) {
  const box = el('div', 'result-block');
  box.appendChild(el('div', 'block-label', label));
  if (caption) box.appendChild(el('div', 'block-caption', caption));
  const row = el('div', 'result-cards');
  for (const card of cards) row.appendChild(cardEl(card));
  box.appendChild(row);
  return box;
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

  updateCoach();
  renderHud();
  renderBoard();
  renderSeats();
  renderActionBar();
  renderLog();
  renderChipPanel();
  maybeShowResult();
}

function heroIsOut() {
  const hero = humanSeat(state);
  return hero.folded || !hero.inHand;
}

function scheduleBots(delay) {
  clearTimeout(botTimer);
  botTimer = setTimeout(stepBots, delay ?? botDelay());
}

/** 同步跑一次机器人行动；返回它实际用的 action，没行动则返回 null。 */
function performBotAction() {
  if (isHandOver()) return null;
  const seat = state.seats[state.toAct];
  if (!seat || seat.isHuman) return null;
  const action = decideBotAction(state, state.toAct, rng);
  if (!action) return null;
  state = applyAction(state, action, rng);
  render();
  return action;
}

/**
 * 两次行动之间停多久 —— 这个值直接决定"看不看得清"。
 * 太快像跳过，太慢又拖沓。加注和全下是最需要看清的信息，所以额外多停一会儿。
 */
function botDelay(action) {
  const base = heroIsOut() ? 460 : 720;
  const weight =
    action?.type === ACTION_TYPES.RAISE || action?.type === ACTION_TYPES.ALL_IN ? 1.45 : 1;
  return Math.round(base * weight * (0.8 + Math.random() * 0.45));
}

function stepBots() {
  if (isHandOver()) return;
  const before = state.phase;
  const action = performBotAction();
  if (!action) {
    render();
    return;
  }
  // 换街（发牌）之后再停一下，让人看清新发的牌
  const extra = state.phase !== before ? 520 : 0;
  scheduleBots(extra + botDelay(action));
}

function humanAct(type, amount) {
  if (isHandOver()) return;
  const hero = humanSeat(state);
  if (state.toAct !== hero.index) return;
  const before = state.phase;
  // 复盘必须在 applyAction 之前做 —— 之后局面就变了，算不出当时的选择对不对
  const adviceForReview = coach.enabled ? coach.advice : null;
  const stateBefore = state;
  try {
    state = applyAction(state, { seat: hero.index, type, amount }, rng);
  } catch (err) {
    // 理论上界面只会送出合法行动，真出问题也不要把整局卡死
    console.error('行动被拒绝：', err);
    render();
    return;
  }

  if (adviceForReview) {
    coach.review = reviewDecision(stateBefore, hero.index, { type, amount }, adviceForReview);
    clearTimeout(reviewTimer);
    reviewTimer = setTimeout(() => {
      coach.review = null;
      renderActionBar();
    }, 9000);
  }

  render();
  if (!isHandOver()) scheduleBots((state.phase !== before ? 520 : 0) + botDelay());
}

function newHand() {
  clearTimeout(botTimer);
  clearTimeout(resultTimer);
  clearTimeout(reviewTimer);
  hideOverlay();
  betPanel.open = false;
  renderedPhase = null;
  coach.review = null;
  coach.advice = null;
  coach.key = null;

  state = startHand(state, rng);

  // 破产补码必须让玩家看见，否则"我的筹码怎么突然变多了"没法解释
  for (const event of state.events) {
    if (event.type === 'rebuy' && state.seats[event.seat].isHuman) {
      const buyIn = state.session.seats[event.seat].buyIn;
      showToast(`筹码输光了，自动补入 ${event.amount}（累计买入 ${buyIn}）`);
    }
  }

  render();

  if (isHandOver()) {
    // 唯一会走到这里的情况是桌上只剩一个还有筹码的玩家
    els.actionbar.innerHTML = '';
    els.actionbar.appendChild(el('div', 'status-line', '桌上没有足够的玩家，点右上角重开'));
    return;
  }
  scheduleBots(900);
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
  els.btnCoach.addEventListener('click', () => {
    coach.enabled = !coach.enabled;
    coach.advice = null;
    coach.review = null;
    coach.key = null;
    els.btnCoach.classList.toggle('coach-on', coach.enabled);
    els.btnCoach.textContent = coach.enabled ? '教练' : '教练关';
    render();
  });
  els.btnChips.addEventListener('click', () => {
    els.chippanel.classList.remove('hidden');
    renderChipPanel();
  });
  els.chipClose.addEventListener('click', () => els.chippanel.classList.add('hidden'));
}

function boot() {
  buildBoard();
  buildSeats();
  bind();
  newHand();

  setupServiceWorker();
}

/**
 * 注册 Service Worker，并且在新版本接管后自动刷新一次。
 *
 * 这一步是为了解决"改了代码但用户一直看到旧版"的问题：旧的 SW 一旦
 * 还在控制页面，它就会继续把缓存的旧文件喂给你。这里主动触发更新检查，
 * 等新 SW 拿到控制权后自动 reload。
 *
 * 注意 hadController：首次安装时 controller 是空的，此时不能刷新，
 * 否则会陷入无限刷新。
 */
function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloaded = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded) return;
    reloaded = true;
    location.reload();
  });

  navigator.serviceWorker
    .register('sw.js')
    .then((registration) => registration.update())
    .catch(() => {});
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
  showResult,
  stop: () => {
    clearTimeout(botTimer);
    clearTimeout(resultTimer);
  },
  isHandOver: () => isHandOver(),
};

if (typeof window !== 'undefined') window.__holdem = debug;
