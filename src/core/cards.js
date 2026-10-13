/**
 * 牌的表示。
 *
 * 一张牌编码成 0..51 的整数：card = (点数 - 2) * 4 + 花色下标。
 * 用整数而不是对象，是因为蒙特卡洛胜率模拟里要反复评估几万次牌型。
 */

export const RANK_CHARS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
export const SUIT_CHARS = ['s', 'h', 'd', 'c'];
export const SUIT_SYMBOLS = ['♠', '♥', '♦', '♣'];
export const SUIT_NAMES = ['spades', 'hearts', 'diamonds', 'clubs'];
export const CARD_COUNT = 52;

const CHAR_TO_RANK = new Map();
for (let r = 2; r <= 14; r++) CHAR_TO_RANK.set(RANK_CHARS[r - 2], r);
const CHAR_TO_SUIT = new Map(SUIT_CHARS.map((s, i) => [s, i]));

/** 由点数和花色下标构造一张牌。 */
export function makeCard(rank, suitIndex) {
  return (rank - 2) * 4 + suitIndex;
}

export function rankOf(card) {
  return (card >> 2) + 2;
}

export function suitOf(card) {
  return card & 3;
}

/** 'As' / 'Th' / '2c' */
export function cardToString(card) {
  return RANK_CHARS[rankOf(card) - 2] + SUIT_CHARS[suitOf(card)];
}

/** 'A♠' / '10♥'，给界面用。 */
export function cardToLabel(card) {
  const rank = rankOf(card);
  return (rank === 10 ? '10' : RANK_CHARS[rank - 2]) + SUIT_SYMBOLS[suitOf(card)];
}

export function parseCard(str) {
  const s = str.trim();
  const rankChar = s[0].toUpperCase();
  const suitChar = s[1].toLowerCase();
  const rank = CHAR_TO_RANK.get(rankChar);
  const suit = CHAR_TO_SUIT.get(suitChar);
  if (rank === undefined || suit === undefined) {
    throw new Error(`无法解析的牌: ${str}`);
  }
  return makeCard(rank, suit);
}

export function parseCards(str) {
  return str
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(parseCard);
}

/** 一副没洗过的 52 张牌。 */
export function freshDeck() {
  const deck = new Array(CARD_COUNT);
  for (let i = 0; i < CARD_COUNT; i++) deck[i] = i;
  return deck;
}

export function isRed(card) {
  const suit = suitOf(card);
  return suit === 1 || suit === 2; // hearts / diamonds
}
