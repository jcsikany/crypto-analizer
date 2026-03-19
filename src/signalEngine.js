// ─── Signal Engine (Server) ───────────────────────────────────────────────
const {
  extractOHLCV, EMA, RSI, MACD, ATR,
  BollingerBands, OBV, ADX, StochRSI, CMF, WilliamsR,
} = require('./indicators');

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

const CATEGORY_WEIGHTS = { trend: 0.30, momentum: 0.25, volatility: 0.20, volume: 0.15, pattern: 0.10 };
const TF_WEIGHTS = { '15m': 0.10, '1h': 0.20, '4h': 0.35, '1d': 0.35 };

function scoreToSignal(score) {
  if (score >=  1.3) return 'STRONG_BUY';
  if (score >=  0.4) return 'BUY';
  if (score > -0.4)  return 'NEUTRAL';
  if (score > -1.3)  return 'SELL';
  return 'STRONG_SELL';
}

// ─── Trend ────────────────────────────────────────────────────────────────
function analyzeTrend(candles) {
  const { highs, lows, closes } = extractOHLCV(candles);
  const signals = [];
  const price = closes[closes.length - 1];

  const ema9  = EMA(closes, 9);
  const ema21 = EMA(closes, 21);
  const ema50 = EMA(closes, 50);
  const ema200= EMA(closes, 200);
  const l9 = ema9[ema9.length-1], l21 = ema21[ema21.length-1];
  const l50 = ema50[ema50.length-1], l200 = ema200[ema200.length-1];

  if (l9 && l21 && l50 && l200) {
    signals.push({ score: price > l200 ? 1 : -1 });
    signals.push({ score: l9 > l21 && l21 > l50 ? 2 : l9 < l21 && l21 < l50 ? -2 : 0 });
    signals.push({ score: l50 > l200 ? 1 : -1 });
  }

  const { macdLine, signalLine, histogram } = MACD(closes);
  const lm = macdLine[macdLine.length-1], ls = signalLine[signalLine.length-1];
  const pm = macdLine[macdLine.length-2], ps = signalLine[signalLine.length-2];
  const lh = histogram[histogram.length-1], ph = histogram[histogram.length-2];
  if (lm !== null && ls !== null) {
    let sc = lm > ls ? (lm > 0 ? 1 : 0.5) : (lm < 0 ? -1 : -0.5);
    if (lm > ls && pm <= ps) sc = 2;
    if (lm < ls && pm >= ps) sc = -2;
    if (lh > 0 && ph > 0 && lh > ph) sc = Math.min(2, sc + 0.5);
    if (lh < 0 && ph < 0 && lh < ph) sc = Math.max(-2, sc - 0.5);
    signals.push({ score: sc });
  }

  const { adx, diPlus, diMinus } = ADX(highs, lows, closes);
  const ladx = adx[adx.length-1], ldip = diPlus[diPlus.length-1], ldim = diMinus[diMinus.length-1];
  if (ladx !== null) {
    let sc = 0;
    if (ladx > 25) sc = ldip > ldim ? 1 : -1;
    if (ladx > 40) sc *= 1.5;
    signals.push({ score: sc });
  }

  const raw = signals.reduce((s, x) => s + x.score, 0) / Math.max(1, signals.length);
  return clamp(raw, -2, 2);
}

// ─── Momentum ─────────────────────────────────────────────────────────────
function analyzeMomentum(candles) {
  const { highs, lows, closes } = extractOHLCV(candles);
  const signals = [];

  const rsiVals = RSI(closes);
  const lastRSI = rsiVals[rsiVals.length-1];
  if (lastRSI !== null) {
    let sc = 0;
    if      (lastRSI < 20) sc = 2;
    else if (lastRSI < 30) sc = 1.5;
    else if (lastRSI < 40) sc = 1;
    else if (lastRSI > 80) sc = -2;
    else if (lastRSI > 70) sc = -1.5;
    else if (lastRSI > 60) sc = -1;
    else sc = lastRSI > 50 ? 0.3 : -0.3;
    signals.push({ score: sc });
  }

  const { k: stk, d: std } = StochRSI(closes);
  const lk = stk[stk.length-1], ld = std[std.length-1], pk = stk[stk.length-2];
  if (lk !== null && ld !== null) {
    let sc = 0;
    if (lk < 10) sc = 2; else if (lk < 20) sc = 1.5;
    if (lk > 90) sc = -2; else if (lk > 80) sc = -1.5;
    if (lk > ld && pk <= ld) sc = Math.max(sc, 1);
    if (lk < ld && pk >= ld) sc = Math.min(sc, -1);
    signals.push({ score: sc });
  }

  const wr = WilliamsR(highs, lows, closes);
  const lwr = wr[wr.length-1];
  if (lwr !== null) {
    signals.push({ score: lwr < -80 ? 1.5 : lwr < -90 ? 2 : lwr > -20 ? -1.5 : lwr > -10 ? -2 : 0 });
  }

  const raw = signals.reduce((s, x) => s + x.score, 0) / Math.max(1, signals.length);
  return clamp(raw, -2, 2);
}

// ─── Volatility ───────────────────────────────────────────────────────────
function analyzeVolatility(candles) {
  const { closes } = extractOHLCV(candles);
  const price = closes[closes.length - 1];
  const { upper, lower } = BollingerBands(closes);
  const lu = upper[upper.length-1], ll = lower[lower.length-1];
  if (!lu || !ll) return 0;
  let sc = 0;
  if (price <= ll) sc = 2;
  else if (price >= lu) sc = -2;
  else if (price < (lu + ll) / 2) sc = 0.3;
  else sc = -0.3;
  return clamp(sc, -2, 2);
}

// ─── Volume ───────────────────────────────────────────────────────────────
function analyzeVolume(candles) {
  const { highs, lows, closes, volumes } = extractOHLCV(candles);
  const signals = [];

  const obvVals = OBV(closes, volumes);
  const obv5 = obvVals.slice(-5);
  const obvTrend = (obv5[obv5.length-1] - obv5[0]) / Math.abs(obv5[0] || 1) * 100;
  const priceTrend = (closes[closes.length-1] - closes[closes.length-5]) / closes[closes.length-5] * 100;
  let obvSc = obvTrend > 5 ? 1 : obvTrend < -5 ? -1 : 0;
  if (obvTrend > 3 && priceTrend < -1) obvSc = 2;
  if (obvTrend < -3 && priceTrend > 1) obvSc = -2;
  signals.push({ score: obvSc });

  const cmfVals = CMF(highs, lows, closes, volumes);
  const lcmf = cmfVals[cmfVals.length-1];
  if (lcmf !== null) {
    signals.push({ score: lcmf > 0.15 ? 2 : lcmf > 0.05 ? 1 : lcmf < -0.15 ? -2 : lcmf < -0.05 ? -1 : 0 });
  }

  const raw = signals.reduce((s, x) => s + x.score, 0) / Math.max(1, signals.length);
  return clamp(raw, -2, 2);
}

// ─── Timeframe analysis ───────────────────────────────────────────────────
function analyzeTimeframe(candles, tf) {
  if (!candles || candles.length < 50) return null;
  const trend      = analyzeTrend(candles);
  const momentum   = analyzeMomentum(candles);
  const volatility = analyzeVolatility(candles);
  const volume     = analyzeVolume(candles);

  const score =
    trend      * CATEGORY_WEIGHTS.trend +
    momentum   * CATEGORY_WEIGHTS.momentum +
    volatility * CATEGORY_WEIGHTS.volatility +
    volume     * CATEGORY_WEIGHTS.volume;

  return { tf, score: clamp(score, -2, 2), signal: scoreToSignal(clamp(score, -2, 2)) };
}

// ─── Master signal ────────────────────────────────────────────────────────
function computeMasterSignal(tfAnalyses) {
  const available = Object.entries(tfAnalyses).filter(([, v]) => v !== null);
  if (available.length === 0) return null;

  let weighted = 0, totalW = 0;
  available.forEach(([tf, a]) => {
    const w = TF_WEIGHTS[tf] ?? 0.2;
    weighted += a.score * w;
    totalW   += w;
  });
  if (totalW > 0) weighted /= totalW;

  const signal = scoreToSignal(weighted);
  const confidence = Math.min(100, Math.round(Math.abs(weighted / 2) * 100));

  const counts = { bull: 0, bear: 0, neutral: 0 };
  available.forEach(([, a]) => {
    if (a.score > 0.4) counts.bull++;
    else if (a.score < -0.4) counts.bear++;
    else counts.neutral++;
  });

  return {
    signal,
    score:      weighted,
    confidence,
    tfBreakdown: available.map(([tf, a]) => ({ tf, signal: a.signal, score: a.score })),
    counts,
    timestamp:  Date.now(),
  };
}

module.exports = { analyzeTimeframe, computeMasterSignal, scoreToSignal };
