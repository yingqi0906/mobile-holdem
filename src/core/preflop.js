/**
 * 翻前策略：基于范围表，而不是单调的牌力评分。
 *
 * 为什么不用"牌力前 X%"这种简单做法？因为实测过：按对抗随机牌的胜率排序，
 * 同花连张（76s 这类）会排到 97 名开外，但它其实在 GTO 的开局范围里；
 * 反过来 A6o 这种被主导的牌胜率不低，GTO 却不玩。排序和真实范围差别很大，
 * 所以这里直接用显式的范围表。
 *
 * 范围用标准记号书写，解析规则：
 *   AA      对子
 *   22+     22 及以上的所有对子
 *   A2s+    A2s、A3s … AKs（同花）
 *   KTo+    KTo、KJo、KQo（非同花）
 *   A5s:0.5 混合频率，一半时候玩
 *
 * 这些范围是按公开的 6 人桌 100 个大盲 GTO 频率整理的**近似**，
 * 不是求解器输出。想调直接改下面的表即可。
 */

import { rankOf, suitOf } from './cards.js';
import { HAND_ORDER, PREFLOP_SPOTS } from './preflop-ranges.js';

const RANK_CHAR = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const CHAR_RANK = new Map(RANK_CHAR.map((c, i) => [c, i + 2]));

/** 把一手牌归到 169 类里的某一类，例如 'AKs' / 'QQ' / 'T9o'。 */
export function handClass(hole) {
  const [a, b] = hole;
  const ra = rankOf(a);
  const rb = rankOf(b);
  const hi = Math.max(ra, rb);
  const lo = Math.min(ra, rb);
  const hiChar = RANK_CHAR[hi - 2];
  const loChar = RANK_CHAR[lo - 2];
  if (hi === lo) return `${hiChar}${loChar}`;
  return `${hiChar}${loChar}${suitOf(a) === suitOf(b) ? 's' : 'o'}`;
}

/**
 * 解析一段范围字符串，返回 Map<手牌类别, 频率>。
 * 频率为 1 表示总是玩，0.5 表示一半时候玩。
 */
export function parseRange(text) {
  const map = new Map();
  for (const raw of text.split(',')) {
    const token = raw.trim();
    if (!token) continue;

    const [body, weightText] = token.split(':');
    const weight = weightText === undefined ? 1 : Number(weightText);
    const plus = body.endsWith('+');
    const core = plus ? body.slice(0, -1) : body;

    const c1 = core[0];
    const c2 = core[1];
    const suffix = core[2] ?? '';
    const r1 = CHAR_RANK.get(c1);
    const r2 = CHAR_RANK.get(c2);
    if (r1 === undefined || r2 === undefined) throw new Error(`范围写错了: ${token}`);

    if (suffix === '') {
      // 对子
      const top = plus ? 14 : r1;
      for (let r = r1; r <= top; r++) {
        map.set(`${RANK_CHAR[r - 2]}${RANK_CHAR[r - 2]}`, weight);
      }
      continue;
    }

    // 标准记号里高张固定、另一张往上长：
    //   A2s+ → A2s, A3s … AKs
    //   ATo+ → ATo, AJo, AQo, AKo
    // 之前理解反了，导致 ATo+ 只生出 ATo 一张。
    if (r1 < r2) throw new Error(`范围的写法应该是大牌在前: ${token}`);
    const top = plus ? r1 - 1 : r2;
    for (let r = r2; r <= top; r++) {
      map.set(`${RANK_CHAR[r1 - 2]}${RANK_CHAR[r - 2]}${suffix}`, weight);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// 范围表（6 人桌，100 个大盲）
// ---------------------------------------------------------------------------

/** 各个位置的率先加注范围。百分数是实测出来的宽度，写在注释里备查。 */
const OPEN_RANGES = {
  UTG: '22+, A2s+, KTs+, QTs+, JTs, T9s, 98s, AJo+, KQo', // 约 22%
  HJ: '22+, A2s+, K9s+, Q9s+, J9s+, T9s, 98s, 87s, ATo+, KJo+, QJo', // 约 26%
  CO: '22+, A2s+, K8s+, Q8s+, J8s+, T8s+, 97s+, 86s+, 75s+, 65s, A9o+, KTo+, QTo+, JTo', // 约 32%
  BTN: '22+, A2s+, K2s+, Q5s+, J7s+, T7s+, 96s+, 85s+, 74s+, 64s+, 53s+, A2o+, K8o+, Q9o+, J9o+, T9o', // 约 47%
  SB: '22+, A2s+, K4s+, Q6s+, J8s+, T8s+, 97s+, 86s+, 75s+, 64s+, A4o+, K9o+, Q9o+, J9o+', // 约 40%
};

/** 面对一个加注时的再加注范围：顶端的价值牌 + 少量诈唬。 */
const THREEBET_VALUE = 'QQ+, AKs, AKo';
const THREEBET_BLUFF = 'A5s, A4s, A3s, A2s, K9s, KTs, Q9s, 76s, 65s';

/** 面对再加注：继续的范围。 */
const FOURBET_VALUE = 'KK+, AKs';
const FOURBET_BLUFF = 'A5s, A4s';
const CALL_THREEBET = {
  default: 'JJ-88, AQs+, AQo, AJs, KQs, ATs, KJs, QJs, JTs, T9s, 99, 88, 77, 66',
  blinds: 'QQ-22, AQs+, AKo, AJs, ATs, KQs, KJs, QJs, JTs, T9s, 98s, 87s, 76s, AQo',
};

/** 面对开局加注时的跟注范围。 */
const CALL_OPEN = {
  // 大盲有折扣，防得最宽
  BB: 'QQ-22, AQs+, AKo, AJs, ATs, A9s, A8s, A5s, A4s, A3s, A2s, KQs, KJs, KTs, QJs, QTs, JTs, J9s, T9s, T8s, 98s, 97s, 87s, 76s, 65s, 54s, AQo, AJo, KQo, KJo',
  // 有位置的时候可以跟得宽一些
  IP: 'JJ-22, AQs+, AJs, ATs, KQs, KJs, QJs, JTs, T9s, 98s, 87s, AQo, AJo, KQo',
};

// ---------------------------------------------------------------------------
// 局面判断
// ---------------------------------------------------------------------------

/** 这个座位当前是什么位置。6 人桌按 按钮→小盲→大盲→枪口→中间→劫机→关煞 排。 */
export function positionOf(state, seatIdx) {
  const n = state.config.seatCount;
  const live = state.seats.filter((s) => s.inHand);
  if (live.length === 2) {
    // 单挑：按钮就是小盲
    return seatIdx === state.buttonSeat ? 'SB' : 'BB';
  }
  const order = ['SB', 'BB', 'UTG', 'HJ', 'CO', 'BTN'];
  let offset = 0;
  for (let i = 1; i <= n; i++) {
    const idx = (state.buttonSeat + i) % n;
    const seat = state.seats[idx];
    if (!seat.inHand) continue;
    if (idx === seatIdx) {
      // 人少的时候中间位置折叠掉，取靠后的名字
      const label = order[Math.min(offset, order.length - 1)];
      return label;
    }
    offset++;
  }
  return 'BTN';
}

const cache = new Map();
function range(text) {
  let parsed = cache.get(text);
  if (!parsed) {
    parsed = parseRange(text);
    cache.set(text, parsed);
  }
  return parsed;
}

/** 某个范围里有没有这手牌；频率 < 1 的牌按概率通过。 */
function plays(text, cls, rng) {
  const weight = range(text).get(cls) ?? 0;
  return weight > 0 && rng() < weight;
}

/**
 * 范围的宽度，按**组合数**算而不是按手牌类别数。
 * 对子是 6 个组合、同花 4 个、非同花 12 个，一共 1326 个组合。
 * 牌桌上说"开 20%"指的一直是组合占比，按类别算会严重偏高。
 */
function width(text) {
  let combos = 0;
  for (const [cls, w] of range(text)) {
    if (cls.length === 2) combos += 6 * w;
    else if (cls.endsWith('s')) combos += 4 * w;
    else combos += 12 * w;
  }
  return Math.round((combos / 1326) * 1000) / 10;
}

export function rangeInfo() {
  const out = {};
  for (const [pos, text] of Object.entries(OPEN_RANGES)) out[pos] = width(text);
  return out;
}

// ---------------------------------------------------------------------------
// 决策
// ---------------------------------------------------------------------------

/**
 * 查表：把当前局面还原成范围表里的键，再取出这手牌的频率分布。
 *
 * 局面名的格式是「位置 动作」成对出现、最后跟一个决策者的位置，
 * 例如 `hj open co call btn 3bet bb` = HJ 开注、CO 跟注、BTN 再加注，
 * 现在轮到 BB 决定。弃牌不进序列。
 */
const RAISE_WORD = ['open', '3bet', '4bet', '5bet'];
const spotCache = new Map();
const HAND_INDEX = new Map(HAND_ORDER.map((h, i) => [h, i]));

function spotData(key) {
  if (spotCache.has(key)) return spotCache.get(key);
  const entries = PREFLOP_SPOTS[key];
  const parsed = entries
    ? new Map(entries.map(([i, r, c, a]) => [i, { r, c, a }]))
    : null;
  spotCache.set(key, parsed);
  return parsed;
}

export function preflopRaises(state) {
  return (state.streetActions ?? []).filter(
    (a) => a.kind === 'raise' || a.kind === 'allIn'
  ).length;
}

export function spotKey(state, seatIdx) {
  const parts = [];
  let raises = 0;
  for (const act of state.streetActions ?? []) {
    const pos = positionOf(state, act.seat).toLowerCase();
    if (act.kind === 'raise' || act.kind === 'allIn') {
      if (raises >= RAISE_WORD.length) return null; // 超出表覆盖的深度
      parts.push(pos, RAISE_WORD[raises]);
      raises += 1;
    } else if (act.kind === 'call') {
      parts.push(pos, 'call');
    }
  }
  parts.push(positionOf(state, seatIdx).toLowerCase());
  return parts.join(' ');
}

/** 加注尺度。范围表只给了频率，没给下注额，这里按常规尺度补上。 */
function raiseSizing(state, seatIdx, position, raises) {
  const bb = state.config.bigBlind;
  const inBlinds = position === 'SB' || position === 'BB';
  if (raises === 0) return Math.round(bb * (position === 'SB' ? 3 : 2.5));
  if (raises === 1) return Math.round(state.currentBet * (inBlinds ? 4 : 3));
  return Math.round(state.currentBet * 2.3);
}

/** 优先用 GTO 范围表。查不到就返回 null，交给下面的后备逻辑。 */
function gtoAdvice(state, seatIdx, rng) {
  const seat = state.seats[seatIdx];
  if (!seat || seat.hole.length !== 2) return null;
  const key = spotKey(state, seatIdx);
  if (!key) return null;
  const table = spotData(key);
  if (!table) return null;
  const cls = handClass(seat.hole);
  const entry = table.get(HAND_INDEX.get(cls));

  // 表里只收录了非弃牌的条目，所以查不到就等于"纯弃牌"。
  // 但不能弃掉能过牌的局面 —— 大盲在无人加注时是可以免费看牌的。
  if (!entry) {
    if (state.currentBet <= seat.streetBet) {
      return {
        cls,
        position: positionOf(state, seatIdx),
        spot: key,
        mix: [0, 0, 0],
        source: 'gto',
        action: 'check',
        label: 'GTO 范围表',
        note: `${cls} 在「${key}」局面下不在加注范围里，过牌看牌。`,
      };
    }
    return {
      cls,
      position: positionOf(state, seatIdx),
      spot: key,
      mix: [0, 0, 0],
      source: 'gto',
      action: 'fold',
      label: 'GTO 范围表',
      note: `${cls} 在「${key}」局面下是纯弃牌，没有可玩的频率。`,
    };
  }

  const { r, c, a } = entry;
  const position = positionOf(state, seatIdx);
  const raises = preflopRaises(state);
  const mix = `加注 ${r}%／跟注 ${c}%／全下 ${a}%／弃牌 ${100 - r - c - a}%`;
  const base = { cls, position, spot: key, mix: [r, c, a], source: 'gto' };
  const roll = rng() * 100;

  if (roll < r) {
    return {
      ...base,
      action: 'raise',
      sizing: raiseSizing(state, seatIdx, position, raises),
      label: 'GTO 范围表',
      note: `${cls} 在「${key}」局面下：${mix}。这次执行加注。`,
    };
  }
  if (roll < r + c) {
    return { ...base, action: 'call', label: 'GTO 范围表', note: `${cls} 在「${key}」局面下：${mix}。这次执行跟注。` };
  }
  if (roll < r + c + a) {
    return { ...base, action: 'allin', label: 'GTO 范围表', note: `${cls} 在「${key}」局面下：${mix}。这次执行全下。` };
  }
  return { ...base, action: 'fold', label: 'GTO 范围表', note: `${cls} 在「${key}」局面下：${mix}。这次弃牌。` };
}

/**
 * 翻前建议。返回结构给 AI 和教练共用 —— 两者必须是同一套逻辑，
 * 否则"教练说该加注、AI 却弃牌"这种矛盾会立刻让人失去信任。
 */
export function preflopAdvice(state, seatIdx, rng = Math.random) {
  const gto = gtoAdvice(state, seatIdx, rng);
  if (gto) return gto;
  return fallbackAdvice(state, seatIdx, rng);
}

/** 范围表覆盖不到的局面（比如溜入后被加注）用这套简化逻辑兜底。 */
function fallbackAdvice(state, seatIdx, rng) {
  const seat = state.seats[seatIdx];
  const cls = handClass(seat.hole);
  const position = positionOf(state, seatIdx);
  const bb = state.config.bigBlind;
  const raises = preflopRaises(state);

  // 还没人加注：按位置的开局范围打
  if (state.currentBet <= bb) {
    const open = OPEN_RANGES[position] ?? OPEN_RANGES.CO;
    if (plays(open, cls, rng)) {
      return {
        action: 'raise',
        sizing: Math.round(bb * (position === 'SB' ? 3 : 2.5)),
        cls,
        position,
        label: `${position} 率先加注范围（约 ${width(open)}%）`,
        note: `${cls} 在这个范围里`,
      };
    }
    // 大盲还没人加注可以直接过牌
    if (state.currentBet === seat.streetBet) {
      return { action: 'check', cls, position, label: '无可跟注，过牌', note: `${cls} 不在加注范围` };
    }
    return {
      action: 'fold',
      cls,
      position,
      label: `${position} 率先加注范围（约 ${width(open)}%）`,
      note: `${cls} 不在范围里，弃牌`,
    };
  }

  // 面对一个加注
  if (raises <= 1) {
    if (plays(THREEBET_VALUE, cls, rng) || plays(THREEBET_BLUFF, cls, rng)) {
      const inBlinds = position === 'SB' || position === 'BB';
      return {
        action: 'raise',
        sizing: Math.round(state.currentBet * (inBlinds ? 4 : 3)),
        cls,
        position,
        label: '再加注范围（价值 + 诈唬）',
        note: `${cls} 属于再加注范围`,
      };
    }
    const callRange = position === 'BB' ? CALL_OPEN.BB : CALL_OPEN.IP;
    if (plays(callRange, cls, rng)) {
      return { action: 'call', cls, position, label: '跟注范围', note: `${cls} 属于跟注范围` };
    }
    return { action: 'fold', cls, position, label: '面对加注', note: `${cls} 不在继续范围里` };
  }

  // 面对再加注
  if (plays(FOURBET_VALUE, cls, rng) || plays(FOURBET_BLUFF, cls, rng)) {
    return {
      action: 'raise',
      sizing: Math.round(state.currentBet * 2.3),
      cls,
      position,
      label: '四次加注范围',
      note: `${cls} 继续加注`,
    };
  }
  const callVs3bet = position === 'SB' || position === 'BB' ? CALL_THREEBET.blinds : CALL_THREEBET.default;
  if (plays(callVs3bet, cls, rng)) {
    return { action: 'call', cls, position, label: '面对再加注的跟注范围', note: `${cls} 可以跟注` };
  }
  return { action: 'fold', cls, position, label: '面对再加注', note: `${cls} 弃牌` };
}
