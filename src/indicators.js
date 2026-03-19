// ─── Indicators (Node.js port) ────────────────────────────────────────────

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

function EMA(data, period) {
  const result = new Array(data.length).fill(null);
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += data[i];
  result[period - 1] = sum / period;
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
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const avg = middle[i];
    const sd  = Math.sqrt(mean(slice.map(v => (v - avg) ** 2)));
    upper[i] = avg + stdDev * sd;
    lower[i] = avg - stdDev * sd;
  }
  return { upper, middle, lower };
}

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

function WilliamsR(highs, lows, closes, period = 14) {
  const result = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const hh = Math.max(...highs.slice(i - period + 1, i + 1));
    const ll = Math.min(...lows.slice(i - period + 1,  i + 1));
    result[i] = hh === ll ? -50 : -100 * (hh - closes[i]) / (hh - ll);
  }
  return result;
}

module.exports = {
  extractOHLCV, EMA, SMA, RSI, MACD, ATR,
  BollingerBands, OBV, ADX, StochRSI, CMF, WilliamsR,
};
