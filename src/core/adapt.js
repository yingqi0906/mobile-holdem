// 根据对手的实际打法调整策略。
//
// 这是"陪人玩"的关键一环：固定策略虽然不被剥削，但玩家打得再漏它们也照本
// 宣科，玩久了会觉得对面是个程序。这里让机器人读出对手的类型再针对。
//
// 判断标准对齐 GTO 的正常值，而且**样本不足时一律返回中性值** ——
// 前几手就根据两三个样本乱调，比不调更糟。数据全部来自公开动作。

// 少于此数不做任何调整 —— 样本太少，噪声会把策略带偏。
const MIN_HANDS = 25;
const MIN_FACING = 12;

const clamp = (v) => Math.max(0.6, Math.min(1.6, v));

/**
 * 从行为统计里读出对手倾向。
 * 返回的偏差是相对 GTO 正常值的：正数表示比正常更松 / 更爱跟。
 */
export function readTendencies(observation, dealtIn) {
  const neutral = { vpipBias: 0, foldToBetBias: 0, aggressionBias: 0, samples: 0 };
  if (!observation || dealtIn < MIN_HANDS) return neutral;

  // GTO 六人桌的正常入池率大约 25%~30%
  const vpipBias = observation.vpip / Math.max(1, dealtIn) - 0.27;

  let foldToBetBias = 0;
  let aggressionBias = 0;
  if (observation.facedBet >= MIN_FACING) {
    // 面对下注时弃牌约一半是正常值
    foldToBetBias = observation.foldedToBet / observation.facedBet - 0.5;
    // 面对下注时加注的比例，正常值约 12%
    const raw = observation.bets / Math.max(1, observation.facedBet + observation.bets);
    aggressionBias = raw - 0.12;
  }

  return { vpipBias, foldToBetBias, aggressionBias, samples: dealtIn };
}

/**
 * 把对手倾向翻译成"我该怎么调"。
 *
 *   - 对手过度弃牌   → 多诈唬（最直接的利用）
 *   - 对手过度跟注   → 少诈唬、多加价值注
 *   - 对手入池太松   → 少诈唬（他们什么都跟）
 *   - 对手入池太紧   → 多偷盲、多诈唬
 *   - 对手反击太凶   → 少用中等牌加注，多跟注摊牌
 *
 * 所有倍率限制在 [0.6, 1.6]：调整要有效果，但不能让策略面目全非。
 */
export function adaptFor(tendencies) {
  const { vpipBias, foldToBetBias, aggressionBias, samples } = tendencies;
  if (samples === 0) return { bluff: 1, value: 1, callDown: 1, note: null };

  // 弃牌偏差每 10 个百分点，诈唬频率调整 40%。
  //
  // 入池偏差这里用**正号**：入池紧（负偏差）要**少**诈唬。这一条是实测修正的 ——
  // 一开始写成负号，意思是"对紧的对手多诈唬"，结果让"只打大牌"那个策略的
  // 收益从 +1.5 涨到 +17.7。原因是紧的对手弃掉的是垃圾牌，他跟注时手里有货，
  // 对他诈唬等于送钱。入池松（正偏差）同样要少诈唬，因为他们什么都跟。
  const bluff = clamp(1 + foldToBetBias * 4 + vpipBias * 1.5);
  // 跟注偏差每 10 个百分点，价值注频率调整 30%
  const value = clamp(1 - foldToBetBias * 3 + vpipBias * 1.5);
  const callDown = clamp(1 + aggressionBias * 3);

  const notes = [];
  if (foldToBetBias > 0.12) notes.push('对手偏过度弃牌，多诈唬');
  else if (foldToBetBias < -0.12) notes.push('对手跟注太多，少诈唬多打价值');
  if (vpipBias > 0.12) notes.push('对手入池过松');
  else if (vpipBias < -0.1) notes.push('对手入池过紧');
  if (aggressionBias > 0.12) notes.push('对手反击很凶，多跟注摊牌');

  return { bluff, value, callDown, note: notes.length ? notes.join('；') : null };
}

/**
 * 找出当前牌局里最值得针对的对手。
 *
 * **优先读真人** —— 这才是这个功能的目的（针对玩家调）。如果只挑"样本最多"
 * 的那个，在全是机器人的自我对局里它会去读别的机器人，形成互相适应的循环，
 * 越调越偏。没有真人时才退回样本最多的对手。
 */
export function readOpponent(state, excludeSeat) {
  const human = state.seats.find((s) => s.isHuman && s.index !== excludeSeat);
  if (human) {
    const stats = state.session?.seats?.[human.index];
    if (stats && stats.dealtIn >= MIN_HANDS) {
      return adaptFor(readTendencies(stats.observation, stats.dealtIn));
    }
    // 真人的样本还不够，先按中性打，不要拿别人的数据去猜他
    return { bluff: 1, value: 1, callDown: 1, note: null };
  }

  let best = null;
  for (const stats of state.session?.seats ?? []) {
    if (stats.index === excludeSeat) continue;
    if (!state.seats[stats.index]?.inHand) continue;
    if (stats.dealtIn < MIN_HANDS) continue;
    if (!best || stats.dealtIn > best.dealtIn) best = stats;
  }
  if (!best) return { bluff: 1, value: 1, callDown: 1, note: null };
  return adaptFor(readTendencies(best.observation, best.dealtIn));
}
