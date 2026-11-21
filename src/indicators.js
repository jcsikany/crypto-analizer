// ─── Indicators (Node.js port) — Enhanced v2 ─────────────────────────────────
// 20+ indicadores profesionales para análisis multi-timeframe

const last = arr => arr[arr.length - 1];
const sum  = arr => arr.reduce((a, b) => a + b, 0);
const mean = arr => sum(arr) / arr.length;

function extractOHLCV(candles) {
  return {
    opens:   candles.map(c => c.open),
    highs:   candles.map(c => c.high),
    lows:    candles.map(c => c.low),
    closes:  candles.map(c => c.close),
    volumes: candles.map(c => c.volume),
  };
}

// ─── Moving Averages ─────────────────────────────────────────────────────────

function EMA(data, period) {
  const result = new Array(data.length).fill(null);
  if (data.length < period) return result; // sin datos suficientes: todo null
  const k = 2 / (period + 1);
  let s = 0;
  for (let i = 0; i < period; i++) s += data[i];
  result[period - 1] = s / period;
  for (let i = period; i < data.length; i++) {
    result[i] = data[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

function SMA(data, period) {
  const result = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++) {
    result[i] = mean(data.slice(i - period + 1, i + 1));
  }
  return result;
}

function WMA(data, period) {
  const result = new Array(data.length).fill(null);
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < data.length; i++) {
    let wsum = 0;
    for (let j = 0; j < period; j++) {
      wsum += data[i - period + 1 + j] * (j + 1);
    }
    result[i] = wsum / denom;
  }
  return result;
}

function HullMA(data, period) {
  const halfPeriod = Math.floor(period / 2);
  const sqrtPeriod = Math.floor(Math.sqrt(period));
  const wma1 = WMA(data, halfPeriod);
  const wma2 = WMA(data, period);
  const diff = data.map((_, i) =>
    wma1[i] !== null && wma2[i] !== null ? 2 * wma1[i] - wma2[i] : null
  );
  const diffClean = diff.filter(v => v !== null);
  if (diffClean.length < sqrtPeriod) return new Array(data.length).fill(null);
  const hull = WMA(diffClean, sqrtPeriod);
  const result = new Array(data.length).fill(null);
  let offset = data.length - diffClean.length;
  let hullOffset = diffClean.length - hull.length;
  for (let i = 0; i < hull.length; i++) {
    if (hull[i] !== null) {
      result[offset + hullOffset + i] = hull[i];
    }
  }
  return result;
}

// ─── Momentum ────────────────────────────────────────────────────────────────

function RSI(closes, period = 14) {
  const result = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return result;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const chg = closes[i] - closes[i - 1];
    if (chg > 0) gains += chg; else losses -= chg;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const chg  = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, chg))  / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -chg)) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

function MACD(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = EMA(closes, fast);
  const emaSlow = EMA(closes, slow);
  const macdLine = closes.map((_, i) =>
    emaFast[i] !== null && emaSlow[i] !== null ? emaFast[i] - emaSlow[i] : null
  );
  const macdValues = macdLine.filter(v => v !== null);
  const sigRaw = EMA(macdValues, signal);
  const signalLine = new Array(closes.length).fill(null);
  let idx = 0;
  for (let i = 0; i < closes.length; i++) {
    if (macdLine[i] !== null) { signalLine[i] = sigRaw[idx] ?? null; idx++; }
  }
  const histogram = closes.map((_, i) =>
    macdLine[i] !== null && signalLine[i] !== null ? macdLine[i] - signalLine[i] : null
  );
  return { macdLine, signalLine, histogram };
}

function StochRSI(closes, rsiPeriod = 14, stochPeriod = 14, kPeriod = 3, dPeriod = 3) {
  const rsiVals = RSI(closes, rsiPeriod);
  const n = rsiVals.length;
  const stochK = new Array(n).fill(null);
  for (let i = stochPeriod - 1; i < n; i++) {
    const w = rsiVals.slice(i - stochPeriod + 1, i + 1).filter(v => v !== null);
    if (w.length < stochPeriod) continue;
    const mn = Math.min(...w), mx = Math.max(...w);
    stochK[i] = mx === mn ? 50 : 100 * (rsiVals[i] - mn) / (mx - mn);
  }
  const kSmooth = SMA(stochK.map(v => v ?? 0), kPeriod).map((v, i) => stochK[i] !== null ? v : null);
  const dSmooth = SMA(kSmooth.map(v => v ?? 0), dPeriod).map((v, i) => kSmooth[i] !== null ? v : null);
  return { k: kSmooth, d: dSmooth };
}

function WilliamsR(highs, lows, closes, period = 14) {
  const result = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const hh = Math.max(...highs.slice(i - period + 1, i + 1));
    const ll = Math.min(...lows.slice(i - period + 1,  i + 1));
    result[i] = hh === ll ? -50 : -100 * (hh - closes[i]) / (hh - ll);
  }
  return result;
}

function CCI(highs, lows, closes, period = 20) {
  const result = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const slice = [];
    for (let j = i - period + 1; j <= i; j++) {
      slice.push((highs[j] + lows[j] + closes[j]) / 3);
    }
    const avg = mean(slice);
    const md = mean(slice.map(v => Math.abs(v - avg)));
    result[i] = md === 0 ? 0 : (slice[slice.length - 1] - avg) / (0.015 * md);
  }
  return result;
}

function ROC(data, period = 12) {
  const result = new Array(data.length).fill(null);
  for (let i = period; i < data.length; i++) {
    if (data[i - period] !== 0) {
      result[i] = ((data[i] - data[i - period]) / data[i - period]) * 100;
    }
  }
  return result;
}

function MFI(highs, lows, closes, volumes, period = 14) {
  const result = new Array(closes.length).fill(null);
  const tp = closes.map((c, i) => (highs[i] + lows[i] + c) / 3);

  for (let i = period; i < closes.length; i++) {
    let posFlow = 0, negFlow = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const mf = tp[j] * volumes[j];
      if (tp[j] > tp[j - 1]) posFlow += mf;
      else if (tp[j] < tp[j - 1]) negFlow += mf;
    }
    result[i] = negFlow === 0 ? 100 : 100 - 100 / (1 + posFlow / negFlow);
  }
  return result;
}

// ─── Volatility ──────────────────────────────────────────────────────────────

function ATR(highs, lows, closes, period = 14) {
  const n = closes.length;
  const tr = new Array(n).fill(0);
  tr[0] = highs[0] - lows[0];
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i]  - closes[i - 1])
    );
  }
  const result = new Array(n).fill(null);
  let atr = mean(tr.slice(0, period));
  result[period - 1] = atr;
  for (let i = period; i < n; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    result[i] = atr;
  }
  return result;
}

function BollingerBands(closes, period = 20, stdDev = 2) {
  const middle = SMA(closes, period);
  const upper  = new Array(closes.length).fill(null);
  const lower  = new Array(closes.length).fill(null);
  const width  = new Array(closes.length).fill(null);
  const pctB   = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const avg = middle[i];
    const sd  = Math.sqrt(mean(slice.map(v => (v - avg) ** 2)));
    upper[i] = avg + stdDev * sd;
    lower[i] = avg - stdDev * sd;
    const bw = upper[i] - lower[i];
    width[i] = avg > 0 ? bw / avg : 0;
    pctB[i] = bw > 0 ? (closes[i] - lower[i]) / bw : 0.5;
  }
  return { upper, middle, lower, width, pctB };
}

function KeltnerChannels(highs, lows, closes, emaPeriod = 20, atrPeriod = 10, multiplier = 1.5) {
  const mid = EMA(closes, emaPeriod);
  const atr = ATR(highs, lows, closes, atrPeriod);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    if (mid[i] !== null && atr[i] !== null) {
      upper[i] = mid[i] + multiplier * atr[i];
      lower[i] = mid[i] - multiplier * atr[i];
    }
  }
  return { upper, middle: mid, lower };
}

function SqueezeMomentum(highs, lows, closes, bbPeriod = 20, bbMult = 2, kcPeriod = 20, kcMult = 1.5) {
  const bb = BollingerBands(closes, bbPeriod, bbMult);
  const kc = KeltnerChannels(highs, lows, closes, kcPeriod, kcPeriod, kcMult);
  const n = closes.length;
  const squeeze = new Array(n).fill(null);   // true = squeeze on
  const momentum = new Array(n).fill(null);

  // Momentum = linear regression of (close - midline(BB+KC))
  for (let i = 0; i < n; i++) {
    if (bb.lower[i] !== null && kc.lower[i] !== null) {
      squeeze[i] = bb.lower[i] > kc.lower[i] && bb.upper[i] < kc.upper[i];
      const midBK = (bb.middle[i] + kc.middle[i]) / 2;
      momentum[i] = closes[i] - midBK;
    }
  }
  return { squeeze, momentum };
}

// ─── Trend ───────────────────────────────────────────────────────────────────

function ADX(highs, lows, closes, period = 14) {
  const n = closes.length;
  const tr = new Array(n).fill(0);
  const dmP = new Array(n).fill(0);
  const dmM = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
    const up = highs[i] - highs[i-1];
    const dn = lows[i-1] - lows[i];
    dmP[i] = up > dn && up > 0 ? up : 0;
    dmM[i] = dn > up && dn > 0 ? dn : 0;
  }
  function ws(arr) {
    const res = new Array(n).fill(null);
    let s = sum(arr.slice(1, period + 1));
    res[period] = s;
    for (let i = period + 1; i < n; i++) { s = s - s/period + arr[i]; res[i] = s; }
    return res;
  }
  const atr14 = ws(tr), dip = ws(dmP), dim = ws(dmM);
  const adx = new Array(n).fill(null);
  const diPlus = new Array(n).fill(null);
  const diMinus = new Array(n).fill(null);
  const dx = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    if (!atr14[i]) continue;
    diPlus[i]  = 100 * dip[i]  / atr14[i];
    diMinus[i] = 100 * dim[i]  / atr14[i];
    const s = diPlus[i] + diMinus[i];
    dx[i] = s > 0 ? 100 * Math.abs(diPlus[i] - diMinus[i]) / s : 0;
  }
  let adxSum = 0, adxCount = 0;
  for (let i = period * 2; i < n; i++) {
    if (dx[i] === null) continue;
    if (adxCount < period) {
      adxSum += dx[i]; adxCount++;
      if (adxCount === period) adx[i] = adxSum / period;
    } else {
      adx[i] = (adx[i-1] * (period - 1) + dx[i]) / period;
    }
  }
  return { adx, diPlus, diMinus };
}

function Ichimoku(highs, lows, closes, tenkanP = 9, kijunP = 26, senkouBP = 52) {
  const n = closes.length;
  const midHL = (h, l, start, len) => {
    let hh = -Infinity, ll = Infinity;
    for (let i = start; i < start + len && i < n; i++) {
      if (h[i] > hh) hh = h[i];
      if (l[i] < ll) ll = l[i];
    }
    return (hh + ll) / 2;
  };

  const tenkan  = new Array(n).fill(null);
  const kijun   = new Array(n).fill(null);
  const senkouA = new Array(n).fill(null);
  const senkouB = new Array(n).fill(null);
  const chikou  = new Array(n).fill(null);

  for (let i = 0; i < n; i++) {
    if (i >= tenkanP - 1) tenkan[i] = midHL(highs, lows, i - tenkanP + 1, tenkanP);
    if (i >= kijunP - 1)  kijun[i]  = midHL(highs, lows, i - kijunP + 1, kijunP);
    if (tenkan[i] !== null && kijun[i] !== null) {
      // Senkou A se proyecta 26 periodos adelante, pero guardamos en posición actual para análisis
      senkouA[i] = (tenkan[i] + kijun[i]) / 2;
    }
    if (i >= senkouBP - 1) {
      senkouB[i] = midHL(highs, lows, i - senkouBP + 1, senkouBP);
    }
    // Chikou = precio actual (se compara con precio de hace 26 periodos)
    if (i >= kijunP) {
      chikou[i] = closes[i]; // se analiza vs closes[i - kijunP]
    }
  }

  return { tenkan, kijun, senkouA, senkouB, chikou };
}

function Supertrend(highs, lows, closes, period = 10, multiplier = 3) {
  const n = closes.length;
  const atr = ATR(highs, lows, closes, period);
  const supertrend = new Array(n).fill(null);
  const direction  = new Array(n).fill(null); // 1 = bullish, -1 = bearish

  let upperBand, lowerBand, prevUpper, prevLower, prevDir = 1;

  for (let i = period; i < n; i++) {
    if (atr[i] === null) continue;
    const hl2 = (highs[i] + lows[i]) / 2;
    let basicUpper = hl2 + multiplier * atr[i];
    let basicLower = hl2 - multiplier * atr[i];

    // Adjust bands
    if (prevLower !== undefined) {
      lowerBand = basicLower > prevLower || closes[i - 1] < prevLower ? basicLower : prevLower;
    } else {
      lowerBand = basicLower;
    }
    if (prevUpper !== undefined) {
      upperBand = basicUpper < prevUpper || closes[i - 1] > prevUpper ? basicUpper : prevUpper;
    } else {
      upperBand = basicUpper;
    }

    // Direction
    let dir;
    if (supertrend[i - 1] === null) {
      dir = closes[i] > upperBand ? 1 : -1;
    } else if (prevDir === 1) {
      dir = closes[i] < lowerBand ? -1 : 1;
    } else {
      dir = closes[i] > upperBand ? 1 : -1;
    }

    supertrend[i] = dir === 1 ? lowerBand : upperBand;
    direction[i] = dir;

    prevUpper = upperBand;
    prevLower = lowerBand;
    prevDir = dir;
  }

  return { supertrend, direction };
}

function ParabolicSAR(highs, lows, startAF = 0.02, maxAF = 0.2) {
  const n = highs.length;
  const sar = new Array(n).fill(null);
  const trend = new Array(n).fill(null); // 1 = up, -1 = down

  if (n < 2) return { sar, trend };

  let isLong = highs[1] > highs[0];
  let af = startAF;
  let ep = isLong ? highs[0] : lows[0];
  sar[0] = isLong ? lows[0] : highs[0];
  trend[0] = isLong ? 1 : -1;

  for (let i = 1; i < n; i++) {
    let newSar = sar[i - 1] + af * (ep - sar[i - 1]);

    if (isLong) {
      newSar = Math.min(newSar, lows[i - 1], i >= 2 ? lows[i - 2] : lows[i - 1]);
      if (lows[i] < newSar) {
        isLong = false;
        newSar = ep;
        ep = lows[i];
        af = startAF;
      } else {
        if (highs[i] > ep) {
          ep = highs[i];
          af = Math.min(af + startAF, maxAF);
        }
      }
    } else {
      newSar = Math.max(newSar, highs[i - 1], i >= 2 ? highs[i - 2] : highs[i - 1]);
      if (highs[i] > newSar) {
        isLong = true;
        newSar = ep;
        ep = highs[i];
        af = startAF;
      } else {
        if (lows[i] < ep) {
          ep = lows[i];
          af = Math.min(af + startAF, maxAF);
        }
      }
    }

    sar[i] = newSar;
    trend[i] = isLong ? 1 : -1;
  }

  return { sar, trend };
}

// ─── VWAP (Volume Weighted Average Price) ────────────────────────────────────

function VWAP(highs, lows, closes, volumes) {
  const n = closes.length;
  const result = new Array(n).fill(null);
  let cumTPV = 0, cumVol = 0;
  for (let i = 0; i < n; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    cumTPV += tp * volumes[i];
    cumVol += volumes[i];
    result[i] = cumVol > 0 ? cumTPV / cumVol : null;
  }
  return result;
}

// ─── Volume ──────────────────────────────────────────────────────────────────

function OBV(closes, volumes) {
  const result = new Array(closes.length).fill(0);
  result[0] = volumes[0];
  for (let i = 1; i < closes.length; i++) {
    if      (closes[i] > closes[i - 1]) result[i] = result[i - 1] + volumes[i];
    else if (closes[i] < closes[i - 1]) result[i] = result[i - 1] - volumes[i];
    else                                 result[i] = result[i - 1];
  }
  return result;
}

function CMF(highs, lows, closes, volumes, period = 20) {
  const result = new Array(closes.length).fill(null);
  const mfv = closes.map((c, i) => {
    const range = highs[i] - lows[i];
    if (range === 0) return 0;
    return ((c - lows[i] - (highs[i] - c)) / range) * volumes[i];
  });
  for (let i = period - 1; i < closes.length; i++) {
    const sv = sum(volumes.slice(i - period + 1, i + 1));
    result[i] = sv > 0 ? sum(mfv.slice(i - period + 1, i + 1)) / sv : 0;
  }
  return result;
}

function VolumeRatio(volumes, period = 20) {
  const result = new Array(volumes.length).fill(null);
  for (let i = period; i < volumes.length; i++) {
    const avg = mean(volumes.slice(i - period, i));
    result[i] = avg > 0 ? volumes[i] / avg : 1;
  }
  return result;
}

// ─── Pattern Detection ───────────────────────────────────────────────────────

function detectRSIDivergence(closes, rsiVals, lookback = 14) {
  const n = closes.length;
  if (n < lookback + 2) return { bullish: false, bearish: false };

  const recent = n - 1;
  let bullish = false, bearish = false;

  // Buscar divergencias en los últimos `lookback` periodos
  for (let i = n - lookback; i < n - 2; i++) {
    if (rsiVals[i] === null || rsiVals[recent] === null) continue;

    // Bullish divergence: precio hace nuevo mínimo, RSI no
    if (closes[recent] < closes[i] && rsiVals[recent] > rsiVals[i]) {
      bullish = true;
    }
    // Bearish divergence: precio hace nuevo máximo, RSI no
    if (closes[recent] > closes[i] && rsiVals[recent] < rsiVals[i]) {
      bearish = true;
    }
  }

  return { bullish, bearish };
}

function detectHiddenDivergence(closes, rsiVals, lookback = 14) {
  const n = closes.length;
  if (n < lookback + 2) return { bullish: false, bearish: false };

  const recent = n - 1;
  let bullish = false, bearish = false;

  for (let i = n - lookback; i < n - 2; i++) {
    if (rsiVals[i] === null || rsiVals[recent] === null) continue;

    // Hidden bullish: precio hace mínimo más alto, RSI hace mínimo más bajo (tendencia alcista continúa)
    if (closes[recent] > closes[i] && rsiVals[recent] < rsiVals[i] && rsiVals[recent] < 50) {
      bullish = true;
    }
    // Hidden bearish: precio hace máximo más bajo, RSI hace máximo más alto
    if (closes[recent] < closes[i] && rsiVals[recent] > rsiVals[i] && rsiVals[recent] > 50) {
      bearish = true;
    }
  }

  return { bullish, bearish };
}

function detectCandlePatterns(opens, highs, lows, closes) {
  const n = closes.length;
  if (n < 3) return { bullish: 0, bearish: 0, patterns: [] };

  const i = n - 1;
  const body = Math.abs(closes[i] - opens[i]);
  const range = highs[i] - lows[i];
  const upperWick = highs[i] - Math.max(opens[i], closes[i]);
  const lowerWick = Math.min(opens[i], closes[i]) - lows[i];
  const isBullish = closes[i] > opens[i];
  const patterns = [];
  let bullScore = 0, bearScore = 0;

  // Doji
  if (range > 0 && body / range < 0.1) {
    patterns.push('doji');
    // Doji en tendencia bajista = reversal alcista
  }

  // Hammer (bullish) — cuerpo pequeño arriba, mecha larga abajo
  if (lowerWick > body * 2 && upperWick < body * 0.5 && range > 0) {
    patterns.push('hammer');
    bullScore += 1.5;
  }

  // Shooting Star (bearish) — cuerpo pequeño abajo, mecha larga arriba
  if (upperWick > body * 2 && lowerWick < body * 0.5 && range > 0) {
    patterns.push('shooting_star');
    bearScore += 1.5;
  }

  // Engulfing patterns (necesita 2 velas)
  if (n >= 2) {
    const prevBody = Math.abs(closes[i-1] - opens[i-1]);
    const prevBullish = closes[i-1] > opens[i-1];

    // Bullish engulfing
    if (!prevBullish && isBullish && body > prevBody * 1.1 &&
        closes[i] > opens[i-1] && opens[i] < closes[i-1]) {
      patterns.push('bullish_engulfing');
      bullScore += 2;
    }

    // Bearish engulfing
    if (prevBullish && !isBullish && body > prevBody * 1.1 &&
        closes[i] < opens[i-1] && opens[i] > closes[i-1]) {
      patterns.push('bearish_engulfing');
      bearScore += 2;
    }
  }

  // Morning Star / Evening Star (necesita 3 velas)
  if (n >= 3) {
    const body2 = Math.abs(closes[i-1] - opens[i-1]);
    const body3 = Math.abs(closes[i-2] - opens[i-2]);
    const range2 = highs[i-1] - lows[i-1];

    // Morning Star (bullish reversal)
    if (closes[i-2] < opens[i-2] && // primera vela bajista
        range2 > 0 && body2 / range2 < 0.3 && // segunda vela pequeña
        isBullish && body > body3 * 0.5) { // tercera vela alcista
      patterns.push('morning_star');
      bullScore += 2;
    }

    // Evening Star (bearish reversal)
    if (closes[i-2] > opens[i-2] && // primera vela alcista
        range2 > 0 && body2 / range2 < 0.3 && // segunda vela pequeña
        !isBullish && body > body3 * 0.5) { // tercera vela bajista
      patterns.push('evening_star');
      bearScore += 2;
    }
  }

  return { bullish: bullScore, bearish: bearScore, patterns };
}

// ─── Support / Resistance ────────────────────────────────────────────────────

function findSwingLevels(highs, lows, lookback = 5) {
  const supports = [];
  const resistances = [];
  const n = highs.length;

  for (let i = lookback; i < n - lookback; i++) {
    // Swing high
    let isHigh = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j !== i && highs[j] >= highs[i]) { isHigh = false; break; }
    }
    if (isHigh) resistances.push(highs[i]);

    // Swing low
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j !== i && lows[j] <= lows[i]) { isLow = false; break; }
    }
    if (isLow) supports.push(lows[i]);
  }

  return { supports, resistances };
}

function PivotPoints(high, low, close) {
  const pp = (high + low + close) / 3;
  return {
    pp,
    r1: 2 * pp - low,
    r2: pp + (high - low),
    r3: high + 2 * (pp - low),
    s1: 2 * pp - high,
    s2: pp - (high - low),
    s3: low - 2 * (high - pp),
  };
}

module.exports = {
  // Helpers
  extractOHLCV, last, sum, mean,
  // Moving Averages
  EMA, SMA, WMA, HullMA,
  // Momentum
  RSI, MACD, StochRSI, WilliamsR, CCI, ROC, MFI,
  // Volatility
  ATR, BollingerBands, KeltnerChannels, SqueezeMomentum,
  // Trend
  ADX, Ichimoku, Supertrend, ParabolicSAR,
  // Volume
  OBV, CMF, VolumeRatio, VWAP,
  // Patterns
  detectRSIDivergence, detectHiddenDivergence, detectCandlePatterns,
  // Support/Resistance
  findSwingLevels, PivotPoints,
};
