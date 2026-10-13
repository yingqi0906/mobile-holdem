/**
 * 开发工具：用无头 Chrome 打开页面，量出关键元素的几何数据。
 *
 * 为什么需要它：改样式不能靠猜。Windows 上 Chrome 的窗口宽度有 500px 下限，
 * 拿不到真实的手机视口，所以这里走 CDP 的 Emulation.setDeviceMetricsOverride。
 *
 * 用法：
 *   node tools/probe.mjs                                  # 正常牌桌，390x844
 *   node tools/probe.mjs http://127.0.0.1:5173/ 390 844 result   # 结算面板
 *   node tools/probe.mjs http://127.0.0.1:5173/ 390 844 raise    # 加注面板
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const url = process.argv[2] ?? 'http://127.0.0.1:5173/';
const width = Number(process.argv[3] ?? 390);
const height = Number(process.argv[4] ?? 844);
const scenario = process.argv[5] ?? 'live';
const PORT = Number(process.env.PROBE_PORT ?? 9333);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'holdem-probe-'));

const chrome = spawn(
  CHROME,
  [
    '--headless',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' }
);

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const client = new Cdp(ws);
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      const resolve = client.pending.get(msg.id);
      if (resolve) {
        client.pending.delete(msg.id);
        resolve(msg);
      }
    });
    return client;
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, (msg) => {
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg.result);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** 在页面里跑一段 JS 并取回结果。 */
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return res.result?.value;
  }
}

async function waitForDevtools() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return;
    } catch {
      // 还没起来
    }
    await sleep(150);
  }
  throw new Error('Chrome 调试端口没起来');
}

async function newTarget(targetUrl) {
  const res = await fetch(
    `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(targetUrl)}`,
    { method: 'PUT' }
  );
  if (!res.ok) throw new Error(`创建标签页失败：${res.status}`);
  return res.json();
}

// 页面里执行的量测脚本
const MEASURE = `(() => {
  const rect = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
             right: Math.round(b.right), bottom: Math.round(b.bottom) };
  };
  const vw = innerWidth, vh = innerHeight;
  const out = {
    viewport: { vw, vh },
    doc: { scrollW: document.documentElement.scrollWidth, scrollH: document.documentElement.scrollHeight },
    nodes: {},
    seats: [],
    seatOverlapsCommunity: [],
    seatOverlapsSeat: [],
    offscreen: [],
  };
  for (const [name, sel] of [
    ['hud', '.hud'], ['table', '.table-area'], ['felt', '.felt'], ['board', '.board'],
    ['community', '.community'], ['actionbar', '.actionbar'],
    ['betPanel', '.bet-panel'], ['resultSheet', '.result-sheet'],
    ['resultNext', '.result-next'], ['overlay', '.overlay'],
  ]) {
    const el = document.querySelector(sel);
    if (el) out.nodes[name] = rect(el);
  }
  const presetRow = document.querySelector('.preset-row');
  if (presetRow) {
    out.nodes.presetRow = rect(presetRow);
    out.presets = [...presetRow.children].map((b) => ({
      label: b.textContent,
      ...rect(b),
    }));
  }
  const slider = document.querySelector('.bet-slider');
  if (slider) {
    out.slider = { min: slider.min, max: slider.max, value: slider.value, step: slider.step };
  }
  const betValue = document.querySelector('.bet-head .value');
  if (betValue) out.betValue = betValue.textContent;
  const sheetEl = document.querySelector('.result-sheet');
  if (sheetEl) out.resultText = sheetEl.innerText;
  const listEl = document.querySelector('.showdown-list');
  if (listEl) out.showdownRows = [...listEl.children].map((li) => li.innerText.replace(/\\n/g, ' | '));
  document.querySelectorAll('.seat').forEach((el, i) => {
    out.seats.push({
      i, ...rect(el),
      hole: rect(el.querySelector('.hole')),
      avatar: rect(el.querySelector('.avatar')),
      plate: rect(el.querySelector('.plate')),
    });
  });
  // 注意：.seat 是一个 94px 宽的透明外框，真正有内容的是里面的
  // 底牌 / 头像 / 名牌三块。判断遮挡必须用它们，用外框会误报。
  const hit = (a, b) => a && b && a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y;
  const com = document.querySelector('.community')?.getBoundingClientRect();
  const comRect = com && { x: com.left, y: com.top, right: com.right, bottom: com.bottom };
  const partsOf = (s) => [s.hole, s.avatar, s.plate].filter(Boolean);

  if (comRect) {
    for (const s of out.seats) {
      const parts = partsOf(s);
      const clash = parts.filter((p) => hit(p, comRect)).map((p) => p === s.hole ? 'cards' : p === s.avatar ? 'avatar' : 'plate');
      if (clash.length) out.seatOverlapsCommunity.push({ seat: s.i, parts: clash });
    }
  }
  for (let a = 0; a < out.seats.length; a++) {
    for (let b = a + 1; b < out.seats.length; b++) {
      for (const pa of partsOf(out.seats[a])) {
        for (const pb of partsOf(out.seats[b])) {
          if (hit(pa, pb)) out.seatOverlapsSeat.push([out.seats[a].i, out.seats[b].i]);
        }
      }
    }
  }
  document.querySelectorAll('body *').forEach((el) => {
    const b = el.getBoundingClientRect();
    if (b.width <= 0 || b.height <= 0) return;
    if (b.left < -1 || b.right > vw + 1 || b.top < -1 || b.bottom > vh + 1) {
      out.offscreen.push({ cls: typeof el.className === 'string' && el.className ? el.className : el.tagName, ...rect(el) });
    }
  });
  return out;
})()`;

const SCRIPT_PLAY_TO_SHOWDOWN = `(() => {
  const d = window.__holdem;
  if (!d) return 'no-debug-hook';
  d.stop();
  for (let h = 0; h < 15; h++) {
    d.newHand();
    let n = 0;
    while (!d.isHandOver() && n++ < 400) {
      const s = d.getState();
      if (s.seats[s.toAct].isHuman) {
        const l = d.legal();
        d.humanAct(l.canCheck ? 'check' : 'call');
      } else if (!d.botAct()) break;
    }
    if (d.getState().result?.type === 'showdown') break;
  }
  d.showResult();
  return 'ok';
})()`;

const SCRIPT_OPEN_RAISE = `(() => {
  const d = window.__holdem;
  if (!d) return 'no-debug-hook';
  d.stop();
  let n = 0;
  while (d.getState().toAct !== 0 && n++ < 40) {
    if (!d.botAct()) break;
  }
  const btns = [...document.querySelectorAll('.actionbar button')];
  const raise = btns.find((b) => b.textContent.includes('加注') || b.textContent.includes('下注'));
  if (raise) raise.click();
  return raise ? 'opened' : 'no-raise-button';
})()`;

async function main() {
  await waitForDevtools();
  const target = await newTarget('about:blank');
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url });
  await sleep(2200);

  if (scenario === 'result') {
    const note = await cdp.eval(SCRIPT_PLAY_TO_SHOWDOWN);
    if (note !== 'ok') console.error('提示：', note);
    await sleep(500);
  } else if (scenario === 'raise') {
    const note = await cdp.eval(SCRIPT_OPEN_RAISE);
    if (note !== 'opened') console.error('提示：', note);
    await sleep(400);
  }

  const report = await cdp.eval(MEASURE);
  console.log(JSON.stringify(report, null, 2));

  cdp.ws.close();
  chrome.kill();
  await sleep(200);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // 清理失败无所谓
  }
}

main().catch((err) => {
  console.error('探测失败：', err.message);
  try {
    chrome.kill();
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // 忽略
  }
  process.exit(1);
});
