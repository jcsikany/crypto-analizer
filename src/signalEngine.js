// ─── Signal Engine v2 — Adaptive Multi-Factor ───────────────────────────────
// Mejoras vs v1:
//   - Pesos adaptativos según régimen de mercado
//   - Confluencia multi-timeframe obligatoria
//   - Umbrales dinámicos basados en volatilidad
//   - Indicadores adicionales: Ichimoku, Supertrend, SAR, VWAP, MFI, Squeeze
//   - Detección de divergencias (regular + hidden)
//   - Integración de datos fundamentales
//   - Sistema de zonas (acumulación/distribución/neutral)

const {
  extractOHLCV, EMA, SMA, RSI, MACD, ATR,
  BollingerBands, OBV, ADX, StochRSI, CMF, WilliamsR,
  Ichimoku, Supertrend, ParabolicSAR, VWAP, MFI,
  SqueezeMomentum, CCI, ROC, VolumeRatio, HullMA,
  detectRSIDivergence, detectHiddenDivergence, detectCandlePatterns,
  findSwingLevels,
} = require('./indicators');

const { detectRegime, getAdaptiveThresholds, REGIMES } = require('./regimeDetector');

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

// ─── Timeframe weights (base) ────────────────────────────────────────────────
const TF_WEIGHTS = { '15m': 0.10, '1h': 0.20, '4h': 0.35, '1d': 0.35 };

// ─── Score → Signal ──────────────────────────────────────────────────────────

function scoreToSignal(score, thresholds) {
  const t = thresholds || { strongBuy: 1.3, buy: 0.4, sell: -0.4, strongSell: -1.3 };
  if (score >= t.strongBuy)  return 'STRONG_BUY';
  if (score >= t.buy)        return 'BUY';
  if (score > t.sell)        return 'NEUTRAL';
  if (score > t.strongSell)  return 'SELL';
  return 'STRONG_SELL';
}

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY ANALYZERS — Cada uno retorna un score de -2 a +2
// ═══════════════════════════════════════════════════════════════════════════════

// ─── TREND (30% base) ────────────────────────────────────────────────────────

function analyzeTrend(candles) {
  const { opens, highs, lows, closes, volumes } = extractOHLCV(candles);
  const signals = [];
  const n = closes.length;
  const price = closes[n - 1];

  // 1. EMA Alignment (9, 21, 50, 200)
  const ema9   = EMA(closes, 9);
  const ema21  = EMA(closes, 21);
  const ema50  = EMA(closes, 50);
  const ema200 = EMA(closes, 200);
  const l9 = ema9[n-1], l21 = ema21[n-1], l50 = ema50[n-1], l200 = ema200[n-1];

  if (l9 && l21 && l50 && l200) {
    // Golden cross / Death cross
    signals.push({ name: 'ema_position', score: price > l200 ? 1 : -1 });

    // Perfect alignment: 9 > 21 > 50 > 200 = strong uptrend
    if (l9 > l21 && l21 > l50 && l50 > l200) signals.push({ name: 'ema_alignment', score: 2 });
    else if (l9 < l21 && l21 < l50 && l50 < l200) signals.push({ name: 'ema_alignment', score: -2 });
    else if (l9 > l21 && l21 > l50) signals.push({ name: 'ema_alignment', score: 1 });
    else if (l9 < l21 && l21 < l50) signals.push({ name: 'ema_alignment', score: -1 });
    else signals.push({ name: 'ema_alignment', score: 0 });

    // EMA50 vs 200 (longer term trend)
    signals.push({ name: 'ema_50_200', score: l50 > l200 ? 1 : -1 });
  }

  // 2. MACD
  const { macdLine, signalLine, histogram } = MACD(closes);
  const lm = macdLine[n-1], ls = signalLine[n-1];
  const pm = macdLine[n-2], ps = signalLine[n-2];
  const lh = histogram[n-1], ph = histogram[n-2];
  if (lm !== null && ls !== null) {
    let sc = lm > ls ? (lm > 0 ? 1 : 0.5) : (lm < 0 ? -1 : -0.5);
    if (lm > ls && pm <= ps) sc = 2;   // bullish crossover
    if (lm < ls && pm >= ps) sc = -2;  // bearish crossover
    if (lh > 0 && ph > 0 && lh > ph) sc = Math.min(2, sc + 0.5);
    if (lh < 0 && ph < 0 && lh < ph) sc = Math.max(-2, sc - 0.5);
    signals.push({ name: 'macd', score: sc });
  }

  // 3. ADX (trend strength)
  const { adx, diPlus, diMinus } = ADX(highs, lows, closes);
  const ladx = adx[n-1], ldip = diPlus[n-1], ldim = diMinus[n-1];
  if (ladx !== null) {
    let sc = 0;
    if (ladx > 25) sc = ldip > ldim ? 1 : -1;
    if (ladx > 40) sc *= 1.5;
    if (ladx > 50) sc *= 1.2;
    signals.push({ name: 'adx', score: clamp(sc, -2, 2) });
  }

  // 4. Ichimoku Cloud
  const ich = Ichimoku(highs, lows, closes);
  const tenkan = ich.tenkan[n-1], kijun = ich.kijun[n-1];
  const senA = ich.senkouA[n-1], senB = ich.senkouB[n-1];
  if (tenkan && kijun && senA && senB) {
    let sc = 0;
    const cloudTop = Math.max(senA, senB);
    const cloudBot = Math.min(senA, senB);

    // Price above cloud = bullish, below = bearish, inside = neutral
    if (price > cloudTop) sc += 1;
    else if (price < cloudBot) sc -= 1;

    // TK cross (tenkan > kijun = bullish)
    if (tenkan > kijun) sc += 0.5;
    else if (tenkan < kijun) sc -= 0.5;

    // Chikou span: current price vs price 26 periods ago
    if (n > 26) {
      if (price > closes[n - 27]) sc += 0.5;
      else sc -= 0.5;
    }

    signals.push({ name: 'ichimoku', score: clamp(sc, -2, 2) });
  }

  // 5. Supertrend
  const st = Supertrend(highs, lows, closes, 10, 3);
  const stDir = st.direction[n-1];
  const prevStDir = st.direction[n-2];
  if (stDir !== null) {
    let sc = stDir === 1 ? 1 : -1;
    // Cambio de dirección = señal más fuerte
    if (stDir === 1 && prevStDir === -1) sc = 2;
    if (stDir === -1 && prevStDir === 1) sc = -2;
    signals.push({ name: 'supertrend', score: sc });
  }

  // 6. Parabolic SAR
  const psar = ParabolicSAR(highs, lows);
  const sarTrend = psar.trend[n-1];
  const prevSarTrend = psar.trend[n-2];
  if (sarTrend !== null) {
    let sc = sarTrend === 1 ? 0.8 : -0.8;
    if (sarTrend !== prevSarTrend) sc *= 2; // flip = stronger signal
    signals.push({ name: 'psar', score: clamp(sc, -2, 2) });
  }

  const raw = signals.reduce((s, x) => s + x.score, 0) / Math.max(1, signals.length);
  return { score: clamp(raw, -2, 2), signals };
}

// ─── MOMENTUM (25% base) ────────────────────────────────────────────────────

function analyzeMomentum(candles) {
  const { highs, lows, closes, volumes } = extractOHLCV(candles);
  const n = closes.length;
  const signals = [];

  // 1. RSI (14)
  const rsiVals = RSI(closes);
  const lastRSI = rsiVals[n-1];
  if (lastRSI !== null) {
    let sc = 0;
    if      (lastRSI < 20) sc = 2;
    else if (lastRSI < 30) sc = 1.5;
    else if (lastRSI < 40) sc = 0.8;
    else if (lastRSI > 80) sc = -2;
    else if (lastRSI > 70) sc = -1.5;
    else if (lastRSI > 60) sc = -0.8;
    else sc = lastRSI > 50 ? 0.2 : -0.2;
    signals.push({ name: 'rsi', score: sc, value: +lastRSI.toFixed(1) });
  }

  // 2. StochRSI
  const { k: stk, d: std } = StochRSI(closes);
  const lk = stk[n-1], ld = std[n-1], pk = stk[n-2];
  if (lk !== null && ld !== null) {
    let sc = 0;
    if (lk < 10) sc = 2; else if (lk < 20) sc = 1.5;
    else if (lk > 90) sc = -2; else if (lk > 80) sc = -1.5;
    if (lk > ld && pk !== null && pk <= ld) sc = Math.max(sc, 1.2);   // bullish cross
    if (lk < ld && pk !== null && pk >= ld) sc = Math.min(sc, -1.2);  // bearish cross
    signals.push({ name: 'stochrsi', score: sc });
  }

  // 3. Williams %R
  const wr = WilliamsR(highs, lows, closes);
  const lwr = wr[n-1];
  if (lwr !== null) {
    let sc = 0;
    if (lwr < -90) sc = 2; else if (lwr < -80) sc = 1.5;
    else if (lwr > -10) sc = -2; else if (lwr > -20) sc = -1.5;
    signals.push({ name: 'williams_r', score: sc });
  }

  // 4. CCI
  const cciVals = CCI(highs, lows, closes);
  const lastCCI = cciVals[n-1];
  if (lastCCI !== null) {
    let sc = 0;
    if (lastCCI < -200) sc = 2;
    else if (lastCCI < -100) sc = 1;
    else if (lastCCI > 200) sc = -2;
    else if (lastCCI > 100) sc = -1;
    signals.push({ name: 'cci', score: sc });
  }

  // 5. MFI (Money Flow Index) — RSI ponderado por volumen
  const mfiVals = MFI(highs, lows, closes, volumes);
  const lastMFI = mfiVals[n-1];
  if (lastMFI !== null) {
    let sc = 0;
    if (lastMFI < 20) sc = 1.5;     // oversold con bajo flujo
    else if (lastMFI < 30) sc = 0.8;
    else if (lastMFI > 80) sc = -1.5; // overbought con alto flujo
    else if (lastMFI > 70) sc = -0.8;
    signals.push({ name: 'mfi', score: sc });
  }

  // 6. ROC (Rate of Change)
  const rocVals = ROC(closes, 12);
  const lastROC = rocVals[n-1];
  if (lastROC !== null) {
    let sc = 0;
    if (lastROC > 10) sc = -0.8;    // overextended up
    else if (lastROC > 5) sc = -0.3;
    else if (lastROC < -10) sc = 0.8; // oversold
    else if (lastROC < -5) sc = 0.3;
    signals.push({ name: 'roc', score: sc });
  }

  const raw = signals.reduce((s, x) => s + x.score, 0) / Math.max(1, signals.length);
  return { score: clamp(raw, -2, 2), signals };
}

// ─── VOLATILITY (20% base) ──────────────────────────────────────────────────

function analyzeVolatility(candles) {
  const { highs, lows, closes } = extractOHLCV(candles);
  const n = closes.length;
  const price = closes[n - 1];
  const signals = [];

  // 1. Bollinger Bands — position + squeeze
  const bb = BollingerBands(closes);
  const lu = bb.upper[n-1], ll = bb.lower[n-1], lm = bb.middle[n-1];
  const pctB = bb.pctB[n-1];
  if (lu && ll) {
    let sc = 0;
    if (pctB !== null) {
      if (pctB <= 0) sc = 2;        // below lower band
      else if (pctB < 0.15) sc = 1.5;
      else if (pctB < 0.3) sc = 0.8;
      else if (pctB >= 1.0) sc = -2;   // above upper band
      else if (pctB > 0.85) sc = -1.5;
      else if (pctB > 0.7) sc = -0.8;
      else sc = pctB > 0.5 ? -0.2 : 0.2;
    }
    signals.push({ name: 'bollinger', score: sc });
  }

  // 2. Squeeze Momentum — BB inside KC = compression, ready to explode
  const sq = SqueezeMomentum(highs, lows, closes);
  const isSqueeze = sq.squeeze[n-1];
  const sqMom = sq.momentum[n-1];
  const prevSqMom = sq.momentum[n-2];
  if (isSqueeze !== null && sqMom !== null) {
    let sc = 0;
    if (isSqueeze) {
      // Squeeze ON — direction of momentum matters
      if (sqMom > 0 && prevSqMom !== null && sqMom > prevSqMom) sc = 1.5;
      else if (sqMom < 0 && prevSqMom !== null && sqMom < prevSqMom) sc = -1.5;
      else sc = sqMom > 0 ? 0.5 : -0.5;
    } else {
      // Squeeze OFF — breakout happening
      if (sqMom > 0 && prevSqMom !== null && sqMom > prevSqMom) sc = 1;
      else if (sqMom < 0 && prevSqMom !== null && sqMom < prevSqMom) sc = -1;
    }
    signals.push({ name: 'squeeze', score: sc });
  }

  // 3. ATR relative position — is volatility expanding or contracting?
  const atrVals = ATR(highs, lows, closes);
  const lastATR = atrVals[n-1];
  if (lastATR !== null && n > 20) {
    let atrAvg = 0, cnt = 0;
    for (let i = Math.max(0, n-20); i < n-1; i++) {
      if (atrVals[i] !== null) { atrAvg += atrVals[i]; cnt++; }
    }
    atrAvg = cnt > 0 ? atrAvg / cnt : lastATR;
    const ratio = atrAvg > 0 ? lastATR / atrAvg : 1;

    // Expanding volatility after compression = potential breakout
    if (ratio > 1.5) {
      signals.push({ name: 'atr_expansion', score: price > lm ? 0.8 : -0.8 });
    } else if (ratio < 0.6) {
      // Compressing = waiting for breakout
      signals.push({ name: 'atr_compression', score: 0 });
    }
  }

  const raw = signals.reduce((s, x) => s + x.score, 0) / Math.max(1, signals.length);
  return { score: clamp(raw, -2, 2), signals };
}

// ─── VOLUME (15% base) ──────────────────────────────────────────────────────

function analyzeVolume(candles) {
  const { highs, lows, closes, volumes } = extractOHLCV(candles);
  const n = closes.length;
  const signals = [];

  // 1. OBV trend + divergence with price
  const obvVals = OBV(closes, volumes);
  const obv5 = obvVals.slice(-5);
  const obvTrend = (obv5[obv5.length-1] - obv5[0]) / Math.abs(obv5[0] || 1) * 100;
  const priceTrend = (closes[n-1] - closes[n-5]) / closes[n-5] * 100;
  let obvSc = obvTrend > 5 ? 1 : obvTrend < -5 ? -1 : 0;
  // Divergencia OBV: volumen sube pero precio baja = acumulación (bullish)
  if (obvTrend > 3 && priceTrend < -1) obvSc = 2;
  if (obvTrend < -3 && priceTrend > 1) obvSc = -2;
  signals.push({ name: 'obv', score: obvSc });

  // 2. CMF
  const cmfVals = CMF(highs, lows, closes, volumes);
  const lcmf = cmfVals[n-1];
  if (lcmf !== null) {
    let sc = 0;
    if (lcmf > 0.15) sc = 2;
    else if (lcmf > 0.05) sc = 1;
    else if (lcmf < -0.15) sc = -2;
    else if (lcmf < -0.05) sc = -1;
    signals.push({ name: 'cmf', score: sc });
  }

  // 3. Volume Ratio — current volume vs average
  const volRatio = VolumeRatio(volumes);
  const lastVR = volRatio[n-1];
  if (lastVR !== null) {
    // High volume on up move = bullish confirmation
    // High volume on down move = selling pressure
    const isUp = closes[n-1] > closes[n-2];
    if (lastVR > 2.0) {
      signals.push({ name: 'volume_spike', score: isUp ? 1.5 : -1.5 });
    } else if (lastVR > 1.5) {
      signals.push({ name: 'volume_high', score: isUp ? 0.8 : -0.8 });
    } else if (lastVR < 0.5) {
      // Low volume = lack of conviction
      signals.push({ name: 'volume_low', score: 0 });
    }
  }

  // 4. VWAP position
  const vwapVals = VWAP(highs, lows, closes, volumes);
  const lastVWAP = vwapVals[n-1];
  if (lastVWAP !== null) {
    const price = closes[n-1];
    const dist = ((price - lastVWAP) / lastVWAP) * 100;
    let sc = 0;
    if (dist > 3) sc = -0.8;      // far above VWAP = overextended
    else if (dist > 1) sc = -0.3;
    else if (dist < -3) sc = 0.8;  // far below VWAP = potential value
    else if (dist < -1) sc = 0.3;
    signals.push({ name: 'vwap', score: sc });
  }

  const raw = signals.reduce((s, x) => s + x.score, 0) / Math.max(1, signals.length);
  return { score: clamp(raw, -2, 2), signals };
}

// ─── PATTERN (10% base) ─────────────────────────────────────────────────────

function analyzePattern(candles) {
  const { opens, highs, lows, closes } = extractOHLCV(candles);
  const n = closes.length;
  const signals = [];

  // 1. Candlestick patterns
  const patterns = detectCandlePatterns(opens, highs, lows, closes);
  if (patterns.bullish > 0) signals.push({ name: 'candle_bull', score: Math.min(2, patterns.bullish) });
  if (patterns.bearish > 0) signals.push({ name: 'candle_bear', score: -Math.min(2, patterns.bearish) });

  // 2. RSI Divergence (regular)
  const rsiVals = RSI(closes);
  const regDiv = detectRSIDivergence(closes, rsiVals, 14);
  if (regDiv.bullish) signals.push({ name: 'rsi_div_bull', score: 2 });
  if (regDiv.bearish) signals.push({ name: 'rsi_div_bear', score: -2 });

  // 3. Hidden divergence (trend continuation)
  const hidDiv = detectHiddenDivergence(closes, rsiVals, 14);
  if (hidDiv.bullish) signals.push({ name: 'hidden_div_bull', score: 1.5 });
  if (hidDiv.bearish) signals.push({ name: 'hidden_div_bear', score: -1.5 });

  // 4. Support/Resistance proximity
  const levels = findSwingLevels(highs, lows, 5);
  const price = closes[n-1];
  const atrVals = ATR(highs, lows, closes);
  const lastATR = atrVals[n-1] ?? 0;

  if (lastATR > 0 && levels.supports.length > 0) {
    // Find nearest support
    const nearestSupport = levels.supports
      .filter(s => s < price)
      .sort((a, b) => b - a)[0];
    if (nearestSupport && (price - nearestSupport) < lastATR * 1.5) {
      signals.push({ name: 'near_support', score: 1 });
    }
  }
  if (lastATR > 0 && levels.resistances.length > 0) {
    const nearestResistance = levels.resistances
      .filter(r => r > price)
      .sort((a, b) => a - b)[0];
    if (nearestResistance && (nearestResistance - price) < lastATR * 1.5) {
      signals.push({ name: 'near_resistance', score: -1 });
    }
  }

  if (signals.length === 0) return { score: 0, signals: [] };
  const raw = signals.reduce((s, x) => s + x.score, 0) / Math.max(1, signals.length);
  return { score: clamp(raw, -2, 2), signals };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIMEFRAME ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════════

function analyzeTimeframe(candles, tf, regimeOverride = null) {
  if (!candles || candles.length < 60) return null;

  // Detect regime for this timeframe (or use override from higher TF)
  const regime = regimeOverride || detectRegime(candles);
  const weights = regime.weights;

  const trend      = analyzeTrend(candles);
  const momentum   = analyzeMomentum(candles);
  const volatility = analyzeVolatility(candles);
  const volume     = analyzeVolume(candles);
  const pattern    = analyzePattern(candles);

  // Weighted score using adaptive regime weights
  const score =
    trend.score      * weights.trend +
    momentum.score   * weights.momentum +
    volatility.score * weights.volatility +
    volume.score     * weights.volume +
    pattern.score    * weights.pattern;

  return {
    tf,
    score: clamp(score, -2, 2),
    regime: regime.regime,
    categories: {
      trend:      { score: trend.score, signals: trend.signals },
      momentum:   { score: momentum.score, signals: momentum.signals },
      volatility: { score: volatility.score, signals: volatility.signals },
      volume:     { score: volume.score, signals: volume.signals },
      pattern:    { score: pattern.score, signals: pattern.signals },
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MASTER SIGNAL — Multi-TF Confluence + Fundamentals
// ═══════════════════════════════════════════════════════════════════════════════

function computeMasterSignal(tfAnalyses, fundamentals = null) {
  const available = Object.entries(tfAnalyses).filter(([, v]) => v !== null);
  if (available.length === 0) return null;

  // ─── 1. Detect dominant regime from 4h and 1d (longer timeframes) ─────
  const regimeSource = tfAnalyses['1d'] || tfAnalyses['4h'] || available[0][1];
  const dominantRegime = regimeSource.regime;
  const regimeInfo = detectRegime; // stored for reference

  // ─── 2. Adaptive thresholds ───────────────────────────────────────────
  const thresholds = getAdaptiveThresholds(dominantRegime, 0);

  // ─── 3. Weighted technical score ──────────────────────────────────────
  let techWeighted = 0, totalW = 0;
  available.forEach(([tf, a]) => {
    const w = TF_WEIGHTS[tf] ?? 0.2;
    techWeighted += a.score * w;
    totalW += w;
  });
  if (totalW > 0) techWeighted /= totalW;

  // ─── 4. Confluence check ──────────────────────────────────────────────
  // Count how many timeframes agree on direction
  const counts = { bullish: 0, bearish: 0, neutral: 0, total: available.length };
  available.forEach(([, a]) => {
    if (a.score > 0.3) counts.bullish++;
    else if (a.score < -0.3) counts.bearish++;
    else counts.neutral++;
  });

  // Confluence ratio: what % of timeframes agree with the dominant direction
  const dominantDir = techWeighted > 0 ? 'bullish' : 'bearish';
  const agreeCount = dominantDir === 'bullish' ? counts.bullish : counts.bearish;
  const confluenceRatio = counts.total > 0 ? agreeCount / counts.total : 0;

  // Confluence penalty: if less than 50% agree, reduce score significantly
  let confluenceMultiplier = 1;
  if (confluenceRatio < 0.25) confluenceMultiplier = 0.3;      // almost no agreement
  else if (confluenceRatio < 0.5) confluenceMultiplier = 0.6;  // weak agreement
  else if (confluenceRatio < 0.75) confluenceMultiplier = 0.85; // moderate agreement
  // >= 75% = full conviction

  // ─── 5. Integrate fundamental score ───────────────────────────────────
  let fundamentalScore = 0;
  let fundamentalWeight = 0;
  if (fundamentals?.compositeScore !== undefined) {
    fundamentalScore = fundamentals.compositeScore;
    fundamentalWeight = 0.15; // 15% del score final viene de fundamentales
  }

  // ─── 6. Compute final score ───────────────────────────────────────────
  const technicalWeight = 1 - fundamentalWeight;
  let finalScore = (techWeighted * technicalWeight + fundamentalScore * fundamentalWeight);

  // Apply confluence multiplier
  finalScore *= confluenceMultiplier;

  // Clamp
  finalScore = clamp(finalScore, -2, 2);

  // ─── 7. Determine signal with adaptive thresholds ─────────────────────
  const signal = scoreToSignal(finalScore, thresholds);

  // ─── 8. Confidence calculation ────────────────────────────────────────
  // Base confidence from score magnitude
  let confidence = Math.min(100, Math.round(Math.abs(finalScore / 2) * 100));

  // Boost confidence for high confluence
  confidence = Math.round(confidence * confluenceRatio);

  // Regime confidence modifier
  const regimeConf = {
    STRONG_TREND_UP: 1.0, TREND_UP: 0.95, RANGING: 0.75,
    TREND_DOWN: 0.95, STRONG_TREND_DOWN: 1.0, HIGH_VOLATILITY: 0.60,
  };
  confidence = Math.round(confidence * (regimeConf[dominantRegime] ?? 0.8));
  confidence = Math.min(100, Math.max(0, confidence));

  // ─── 9. Zone determination ────────────────────────────────────────────
  let zone = 'NEUTRAL';
  if (finalScore >= thresholds.buy && confluenceRatio >= 0.5) {
    zone = 'ACCUMULATION';
  } else if (finalScore <= thresholds.sell && confluenceRatio >= 0.5) {
    zone = 'DISTRIBUTION';
  }

  // ─── 10. Price targets (from 4h or 1d) ────────────────────────────────
  // Use the highest available timeframe for targets

  return {
    signal,
    score: +finalScore.toFixed(4),
    confidence,
    zone,
    regime: dominantRegime,
    thresholds,
    confluence: {
      ratio: +confluenceRatio.toFixed(2),
      multiplier: confluenceMultiplier,
      counts,
    },
    fundamental: fundamentals ? {
      score: fundamentalScore,
      fearGreed: fundamentals.fearGreed?.value ?? null,
      funding: fundamentals.funding?.current ?? null,
      longShortRatio: fundamentals.longShortRatio?.ratio ?? null,
      defiTVL: fundamentals.defiTVL ? {
        total: fundamentals.defiTVL.totalTVL,
        change7d: fundamentals.defiTVL.change7d,
      } : null,
    } : null,
    tfBreakdown: available.map(([tf, a]) => ({
      tf,
      score: +a.score.toFixed(3),
      signal: scoreToSignal(a.score, thresholds),
      regime: a.regime,
    })),
    timestamp: Date.now(),
  };
}

module.exports = { analyzeTimeframe, computeMasterSignal, scoreToSignal };
