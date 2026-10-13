/**
 * 随机数工具。
 *
 * 洗牌绝不能用 Math.random —— 浏览器环境下用 crypto.getRandomValues。
 * 同时提供可播种的 PRNG，方便测试里复现同一局牌。
 */

/** mulberry32：小巧、够用的可播种伪随机数发生器，返回 [0, 1) 的浮点数。 */
export function createSeededRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;

/** 加密级随机数（浏览器 / Node 18+ 都有 globalThis.crypto）。 */
export function createCryptoRng() {
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    return function rng() {
      cryptoObj.getRandomValues(buf);
      return buf[0] / 4294967296;
    };
  }
  // 兜底：只有极老的运行环境才会走到这里。
  return Math.random;
}

export function defaultRng() {
  return createCryptoRng();
}

/** Fisher-Yates 洗牌，原地打乱。 */
export function shuffleInPlace(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/** 从数组里随机取一个元素。 */
export function pick(arr, rng) {
  return arr[Math.floor(rng() * arr.length)];
}
