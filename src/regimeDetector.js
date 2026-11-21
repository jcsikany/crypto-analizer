// ─── Market Regime Detector ──────────────────────────────────────────────────
// Determina si el mercado está en tendencia, rango o volatilidad extrema
// y ajusta los pesos de los indicadores dinámicamente.

const { extractOHLCV, EMA, ADX, ATR, BollingerBands } = require('./indicators');

// ─── Regímenes posibles ──────────────────────────────────────────────────────
const REGIMES = {
  STRONG_TREND_UP:   'STRONG_TREND_UP',
  TREND_UP:          'TREND_UP',
  RANGING:           'RANGING',
  TREND_DOWN:        'TREND_DOWN',
  STRONG_TREND_DOWN: 'STRONG_TREND_DOWN',
  HIGH_VOLATILITY:   'HIGH_VOLATILITY',
};

// ─── Pesos por categoría según régimen ───────────────────────────────────────
// En tendencia: trend e momentum dominan
// En rango: volatility y volume son más útiles (mean reversion)
// En alta volatilidad: reducir confianza general
const REGIME_WEIGHTS = {
  [REGIMES.STRONG_TREND_UP]: {
    trend: 0.35, momentum: 0.25, volatility: 0.15, volume: 0.15, pattern: 0.10,
  },
  [REGIMES.TREND_UP]: {
    trend: 0.30, momentum: 0.25, volatility: 0.18, volume: 0.17, pattern: 0.10,
  },
  [REGIMES.RANGING]: {
    trend: 0.15, momentum: 0.25, volatility: 0.30, volume: 0.20, pattern: 0.10,
  },
  [REGIMES.TREND_DOWN]: {
    trend: 0.30, momentum: 0.25, volatility: 0.18, volume: 0.17, pattern: 0.10,
  },
  [REGIMES.STRONG_TREND_DOWN]: {
    trend: 0.35, momentum: 0.25, volatility: 0.15, volume: 0.15, pattern: 0.10,
  },
  [REGIMES.HIGH_VOLATILITY]: {
    trend: 0.20, momentum: 0.20, volatility: 0.25, volume: 0.20, pattern: 0.15,
  },
};

// ─── Factor de confianza por régimen ─────────────────────────────────────────
// Señales en mercados de alta volatilidad son menos confiables
const REGIME_CONFIDENCE = {
  [REGIMES.STRONG_TREND_UP]:   1.0,
  [REGIMES.TREND_UP]:          0.95,
  [REGIMES.RANGING]:           0.75,  // señales en rango son menos confiables
  [REGIMES.TREND_DOWN]:        0.95,
  [REGIMES.STRONG_TREND_DOWN]: 1.0,
  [REGIMES.HIGH_VOLATILITY]:   0.60,  // mucha incertidumbre
};

// ─── Detector principal ──────────────────────────────────────────────────────

function detectRegime(candles) {
  if (!candles || candles.length < 60) {
    return { regime: REGIMES.RANGING, confidence: 0.5, details: {} };
  }

  const { highs, lows, closes } = extractOHLCV(candles);
  const n = closes.length;
  const price = closes[n - 1];

  // 1. ADX — fuerza de la tendencia
  const { adx, diPlus, diMinus } = ADX(highs, lows, closes);
  const lastADX = adx[n - 1] ?? adx[n - 2] ?? 20;
  const lastDIPlus = diPlus[n - 1] ?? 50;
  const lastDIMinus = diMinus[n - 1] ?? 50;

  // 2. ATR ratio — volatilidad relativa al precio
  const atrVals = ATR(highs, lows, closes, 14);
  const lastATR = atrVals[n - 1] ?? 0;
  const atrRatio = price > 0 ? lastATR / price : 0;

  // ATR ratio promedio de los últimos 50 periodos para comparar
  let atrAvg = 0, atrCount = 0;
  for (let i = Math.max(0, n - 50); i < n; i++) {
    if (atrVals[i] !== null) { atrAvg += atrVals[i] / price; atrCount++; }
  }
  atrAvg = atrCount > 0 ? atrAvg / atrCount : atrRatio;
  const volatilityExpansion = atrAvg > 0 ? atrRatio / atrAvg : 1;

  // 3. Bollinger Band width — squeeze vs expansion
  const bb = BollingerBands(closes, 20, 2);
  const lastBBWidth = bb.width[n - 1] ?? 0;

  // BB width promedio
  let bbWidthAvg = 0, bbCount = 0;
  for (let i = Math.max(0, n - 50); i < n; i++) {
    if (bb.width[i] !== null) { bbWidthAvg += bb.width[i]; bbCount++; }
  }
  bbWidthAvg = bbCount > 0 ? bbWidthAvg / bbCount : lastBBWidth;
  const bbExpansion = bbWidthAvg > 0 ? lastBBWidth / bbWidthAvg : 1;

  // 4. EMA slopes — dirección y fuerza
  const ema21 = EMA(closes, 21);
  const ema50 = EMA(closes, 50);
  const ema200 = EMA(closes, 200);

  // Slope de EMA21 (últimos 5 periodos)
  const slope21 = calculateSlope(ema21, 5);
  const slope50 = calculateSlope(ema50, 10);

  // 5. Price position relative to EMAs
  const aboveEma21  = price > (ema21[n-1] ?? price);
  const aboveEma50  = price > (ema50[n-1] ?? price);
  const aboveEma200 = price > (ema200[n-1] ?? price);
  const emaAlignment = (aboveEma21 ? 1 : -1) + (aboveEma50 ? 1 : -1) + (aboveEma200 ? 1 : -1);

  // ─── Lógica de clasificación ───────────────────────────────────────────

  let regime;
  let strength = 0;

  // Alta volatilidad: ATR se expande significativamente
  if (volatilityExpansion > 1.8 || bbExpansion > 1.8) {
    regime = REGIMES.HIGH_VOLATILITY;
    strength = Math.min(1, (volatilityExpansion - 1) / 2);
  }
  // Tendencia fuerte alcista
  else if (lastADX > 35 && lastDIPlus > lastDIMinus && emaAlignment >= 2 && slope21 > 0) {
    regime = REGIMES.STRONG_TREND_UP;
    strength = Math.min(1, lastADX / 50);
  }
  // Tendencia alcista
  else if (lastADX > 20 && lastDIPlus > lastDIMinus && emaAlignment >= 1) {
    regime = REGIMES.TREND_UP;
    strength = Math.min(1, (lastADX - 20) / 30);
  }
  // Tendencia fuerte bajista
  else if (lastADX > 35 && lastDIMinus > lastDIPlus && emaAlignment <= -2 && slope21 < 0) {
    regime = REGIMES.STRONG_TREND_DOWN;
    strength = Math.min(1, lastADX / 50);
  }
  // Tendencia bajista
  else if (lastADX > 20 && lastDIMinus > lastDIPlus && emaAlignment <= -1) {
    regime = REGIMES.TREND_DOWN;
    strength = Math.min(1, (lastADX - 20) / 30);
  }
  // Rango / lateral
  else {
    regime = REGIMES.RANGING;
    strength = Math.min(1, (30 - lastADX) / 20);
  }

  return {
    regime,
    strength: Math.max(0, Math.min(1, strength)),
    confidenceMultiplier: REGIME_CONFIDENCE[regime],
    weights: REGIME_WEIGHTS[regime],
    details: {
      adx: lastADX,
      diPlus: lastDIPlus,
      diMinus: lastDIMinus,
      atrRatio: +(atrRatio * 100).toFixed(3),       // en porcentaje
      volatilityExpansion: +volatilityExpansion.toFixed(2),
      bbWidth: +lastBBWidth.toFixed(4),
      bbExpansion: +bbExpansion.toFixed(2),
      emaAlignment,
      slope21: +slope21.toFixed(6),
      slope50: +slope50.toFixed(6),
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function calculateSlope(values, lookback) {
  const n = values.length;
  const start = values[n - lookback] ?? values[n - 1];
  const end = values[n - 1];
  if (start === null || end === null || start === 0) return 0;
  return (end - start) / Math.abs(start);
}

// ─── Adaptive threshold ──────────────────────────────────────────────────────
// En alta volatilidad, necesitamos señales más fuertes para actuar

function getAdaptiveThresholds(regime, atrRatio) {
  const base = {
    strongBuy:    1.3,
    buy:          0.4,
    sell:        -0.4,
    strongSell:  -1.3,
  };

  // En alta volatilidad, subir umbrales (ser más exigente)
  if (regime === REGIMES.HIGH_VOLATILITY) {
    const factor = 1.3;
    return {
      strongBuy:   base.strongBuy * factor,
      buy:         base.buy * factor,
      sell:        base.sell * factor,
      strongSell:  base.strongSell * factor,
    };
  }

  // En rango, umbrales un poco más exigentes
  if (regime === REGIMES.RANGING) {
    const factor = 1.15;
    return {
      strongBuy:   base.strongBuy * factor,
      buy:         base.buy * factor,
      sell:        base.sell * factor,
      strongSell:  base.strongSell * factor,
    };
  }

  // En tendencia fuerte, umbrales más permisivos (la tendencia ayuda)
  if (regime === REGIMES.STRONG_TREND_UP || regime === REGIMES.STRONG_TREND_DOWN) {
    const factor = 0.85;
    return {
      strongBuy:   base.strongBuy * factor,
      buy:         base.buy * factor,
      sell:        base.sell * factor,
      strongSell:  base.strongSell * factor,
    };
  }

  return base;
}

module.exports = { detectRegime, getAdaptiveThresholds, REGIMES, REGIME_WEIGHTS, REGIME_CONFIDENCE };
