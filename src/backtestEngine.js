// ─── Backtest Engine v2 — Configurable thresholds + proper historical data ───
const fetch = require('node-fetch');
const { analyzeTimeframe, computeMasterSignal, scoreToSignal } = require('./signalEngine');

const BASE = 'https://api.kucoin.com/api/v1';

// ─── Threshold presets ──────────────────────────────────────────────────────
const THRESHOLD_PRESETS = {
  conservative: { strongBuy: 1.3, buy: 0.4, sell: -0.4, strongSell: -1.3 },
  normal:       { strongBuy: 1.0, buy: 0.3, sell: -0.3, strongSell: -1.0 },
  aggressive:   { strongBuy: 0.7, buy: 0.2, sell: -0.2, strongSell: -0.7 },
  veryAggressive: { strongBuy: 0.5, buy: 0.15, sell: -0.15, strongSell: -0.5 },
};

/**
 * Fetch candles from KuCoin with startAt/endAt for proper historical range
 */
async function fetchHistoricalCandles(symbol, interval, startAtSec, endAtSec) {
  const kuInterval = { '1hour': '1hour', '4hour': '4hour', '1day': '1day' }[interval] || interval;

  // KuCoin returns max 1500 candles per request
  // For long periods we may need multiple requests
  let allCandles = [];
  let currentStart = startAtSec;
  const maxPerRequest = 1500;

  // Interval in seconds for pagination
  const intervalSecs = { '1hour': 3600, '4hour': 14400, '1day': 86400 }[interval] || 14400;

  while (currentStart < endAtSec) {
    const batchEnd = Math.min(currentStart + maxPerRequest * intervalSecs, endAtSec);
    const url = `${BASE}/market/candles?type=${kuInterval}&symbol=${symbol}&startAt=${currentStart}&endAt=${batchEnd}`;

    try {
      const res = await fetch(url, { timeout: 15000 });
      if (!res.ok) throw new Error(`KuCoin ${res.status}`);
      const json = await res.json();
      if (json.code !== '200000') throw new Error(`KuCoin: ${json.msg}`);

      if (!json.data || json.data.length === 0) break;

      const candles = json.data.map(k => ({
        time: parseInt(k[0]) * 1000,
        open: parseFloat(k[1]),
        close: parseFloat(k[2]),
        high: parseFloat(k[3]),
        low: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      }));

      allCandles = allCandles.concat(candles);
      currentStart = batchEnd;

      // Small delay to avoid rate limiting
      if (currentStart < endAtSec) {
        await new Promise(r => setTimeout(r, 200));
      }
    } catch (err) {
      console.warn(`[Backtest] Fetch error at ${new Date(currentStart * 1000).toISOString().slice(0, 10)}: ${err.message}`);
      break;
    }
  }

  // KuCoin returns newest first — sort by time ascending and dedupe
  allCandles.sort((a, b) => a.time - b.time);

  // Deduplicate by time
  const seen = new Set();
  const deduped = [];
  for (const c of allCandles) {
    if (!seen.has(c.time)) {
      seen.add(c.time);
      deduped.push(c);
    }
  }

  return deduped;
}

/**
 * Custom scoreToSignal that uses backtest-specific thresholds
 */
function scoreToSignalCustom(score, thresholds) {
  if (score >= thresholds.strongBuy) return 'STRONG_BUY';
  if (score >= thresholds.buy) return 'BUY';
  if (score > thresholds.sell) return 'NEUTRAL';
  if (score > thresholds.strongSell) return 'SELL';
  return 'STRONG_SELL';
}

/**
 * Run a backtest with configurable thresholds.
 *
 * @param {string} asset - 'BTC' or 'ETH'
 * @param {object} options
 */
async function runBacktest(asset, options = {}) {
  const symbol = `${asset}-USDT`;
  const {
    period = '90d',
    stopLossPct = 3,
    takeProfitPct = 5,
    startCapital = 10000,
    thresholdPreset = 'conservative', // conservative, normal, aggressive, veryAggressive
    customThresholds = null,          // { strongBuy, buy, sell, strongSell }
  } = options;

  const thresholds = customThresholds || THRESHOLD_PRESETS[thresholdPreset] || THRESHOLD_PRESETS.conservative;

  console.log(`[Backtest] Starting ${asset} ${period} — SL:${stopLossPct}% TP:${takeProfitPct}% Thresholds: ${thresholdPreset} (buy=${thresholds.buy}, strongBuy=${thresholds.strongBuy})`);

  const periodDays = parseInt(period) || 90;
  const now = Math.floor(Date.now() / 1000);
  const warmupDays = 60; // warmup period in candles worth of extra data

  // Calculate time range — add extra time for indicator warmup
  const startSec = now - (periodDays + warmupDays) * 86400;
  const endSec = now;

  // Fetch candles in parallel
  const [candles4h, candles1d, candles1h] = await Promise.all([
    fetchHistoricalCandles(symbol, '4hour', startSec, endSec),
    fetchHistoricalCandles(symbol, '1day', startSec - (60 * 86400), endSec), // extra 60d for 1d warmup
    fetchHistoricalCandles(symbol, '1hour', Math.max(startSec, now - 60 * 86400), endSec), // 1h limited to 60d
  ]);

  if (candles4h.length < 70) {
    throw new Error(`Insufficient 4h data: got ${candles4h.length} candles`);
  }

  console.log(`[Backtest] Data fetched — 4h: ${candles4h.length}, 1d: ${candles1d.length}, 1h: ${candles1h.length}`);

  // Determine the actual backtest start time (after warmup)
  // We need at least 60 candles of 4h data before we start evaluating
  const warmupCandles = 60;
  const evalStartIdx = warmupCandles;

  const signals = [];
  const trades = [];
  const equityCurve = [];
  let position = null;
  let capital = startCapital;
  let peakCapital = startCapital;
  let maxDrawdown = 0;

  // Step through 4h candles, evaluate once per day (every 6 candles)
  const stepSize = 6;

  for (let i = evalStartIdx; i < candles4h.length; i += stepSize) {
    const window4h = candles4h.slice(Math.max(0, i - 200), i + 1);
    const currentTime = candles4h[i].time;

    // Get matching windows for other timeframes
    const window1d = candles1d.filter(c => c.time <= currentTime).slice(-200);
    const window1h = candles1h.filter(c => c.time <= currentTime).slice(-200);

    // Analyze available timeframes
    const tfAnalyses = {};
    if (window1h.length >= 60) tfAnalyses['1h'] = analyzeTimeframe(window1h, '1h');
    if (window4h.length >= 60) tfAnalyses['4h'] = analyzeTimeframe(window4h, '4h');
    if (window1d.length >= 60) tfAnalyses['1d'] = analyzeTimeframe(window1d, '1d');

    if (Object.keys(tfAnalyses).length === 0) continue;

    // Compute master signal without fundamentals
    const masterSignal = computeMasterSignal(tfAnalyses, null);
    if (!masterSignal) continue;

    const price = candles4h[i].close;
    const time = candles4h[i].time;

    // Override signal classification with custom thresholds
    const customSignal = scoreToSignalCustom(masterSignal.score, thresholds);

    signals.push({
      time, price,
      signal: customSignal,
      originalSignal: masterSignal.signal,
      score: masterSignal.score,
      confidence: masterSignal.confidence,
      regime: masterSignal.regime,
      confluence: masterSignal.confluence.ratio,
    });

    // ─── Trade logic ────────────────────────────────────────────────────
    const isBuy = customSignal === 'STRONG_BUY' || customSignal === 'BUY';
    const isSell = customSignal === 'STRONG_SELL' || customSignal === 'SELL';

    // Check existing position
    if (position) {
      const pnlPct = position.type === 'LONG'
        ? ((price - position.entryPrice) / position.entryPrice) * 100
        : ((position.entryPrice - price) / position.entryPrice) * 100;

      let closeReason = null;
      if (pnlPct <= -stopLossPct) closeReason = 'STOP_LOSS';
      else if (pnlPct >= takeProfitPct) closeReason = 'TAKE_PROFIT';
      else if (position.type === 'LONG' && isSell) closeReason = 'SIGNAL_REVERSE';
      else if (position.type === 'SHORT' && isBuy) closeReason = 'SIGNAL_REVERSE';
      else if (customSignal === 'NEUTRAL' && Math.abs(masterSignal.score) < thresholds.buy * 0.5) {
        closeReason = 'SIGNAL_NEUTRAL';
      }

      if (closeReason) {
        const pnlAmount = (pnlPct / 100) * capital;
        capital += pnlAmount;
        if (capital > peakCapital) peakCapital = capital;
        const dd = ((peakCapital - capital) / peakCapital) * 100;
        if (dd > maxDrawdown) maxDrawdown = dd;

        trades.push({
          type: position.type,
          entryPrice: position.entryPrice,
          entryTime: position.entryTime,
          entrySignal: position.signal,
          exitPrice: price, exitTime: time,
          exitReason: closeReason,
          pnlPct: +pnlPct.toFixed(2),
          pnlAmount: +pnlAmount.toFixed(2),
          capitalAfter: +capital.toFixed(2),
        });
        position = null;
      }
    }

    // Open new position
    if (!position) {
      if (isBuy) {
        position = { type: 'LONG', entryPrice: price, entryTime: time, signal: customSignal };
      } else if (isSell) {
        position = { type: 'SHORT', entryPrice: price, entryTime: time, signal: customSignal };
      }
    }

    // Track equity curve
    const unrealizedPnl = position
      ? (position.type === 'LONG'
        ? ((price - position.entryPrice) / position.entryPrice) * capital
        : ((position.entryPrice - price) / position.entryPrice) * capital)
      : 0;
    equityCurve.push({ time, capital: +(capital + unrealizedPnl).toFixed(2), price });
  }

  // Close any remaining position
  if (position && candles4h.length > 0) {
    const lastCandle = candles4h[candles4h.length - 1];
    const price = lastCandle.close;
    const pnlPct = position.type === 'LONG'
      ? ((price - position.entryPrice) / position.entryPrice) * 100
      : ((position.entryPrice - price) / position.entryPrice) * 100;
    const pnlAmount = (pnlPct / 100) * capital;
    capital += pnlAmount;

    trades.push({
      type: position.type,
      entryPrice: position.entryPrice,
      entryTime: position.entryTime,
      entrySignal: position.signal,
      exitPrice: price, exitTime: lastCandle.time,
      exitReason: 'END_OF_PERIOD',
      pnlPct: +pnlPct.toFixed(2),
      pnlAmount: +pnlAmount.toFixed(2),
      capitalAfter: +capital.toFixed(2),
    });
  }

  // ─── Metrics ──────────────────────────────────────────────────────────────
  const winTrades = trades.filter(t => t.pnlPct > 0);
  const lossTrades = trades.filter(t => t.pnlPct <= 0);
  const avgWin = winTrades.length > 0 ? winTrades.reduce((s, t) => s + t.pnlPct, 0) / winTrades.length : 0;
  const avgLoss = lossTrades.length > 0 ? lossTrades.reduce((s, t) => s + t.pnlPct, 0) / lossTrades.length : 0;

  const firstPrice = candles4h[evalStartIdx]?.close || 1;
  const lastPrice = candles4h[candles4h.length - 1]?.close || 1;
  const buyHoldPct = ((lastPrice - firstPrice) / firstPrice) * 100;

  const signalCounts = { STRONG_BUY: 0, BUY: 0, NEUTRAL: 0, SELL: 0, STRONG_SELL: 0 };
  signals.forEach(s => { signalCounts[s.signal] = (signalCounts[s.signal] || 0) + 1; });

  // Regime distribution
  const regimeCounts = {};
  signals.forEach(s => { regimeCounts[s.regime] = (regimeCounts[s.regime] || 0) + 1; });

  const grossProfit = winTrades.reduce((s, t) => s + t.pnlAmount, 0);
  const grossLoss = Math.abs(lossTrades.reduce((s, t) => s + t.pnlAmount, 0));
  const profitFactor = grossLoss > 0 ? +(grossProfit / grossLoss).toFixed(2) : grossProfit > 0 ? 999 : 0;

  const result = {
    asset,
    period: `${periodDays}d`,
    thresholdPreset,
    thresholds,
    startCapital,
    finalCapital: +capital.toFixed(2),
    totalReturnPct: +(((capital - startCapital) / startCapital) * 100).toFixed(2),
    buyHoldReturnPct: +buyHoldPct.toFixed(2),
    buyHoldFinal: +(startCapital * (1 + buyHoldPct / 100)).toFixed(2),
    outperformance: +(((capital - startCapital) / startCapital * 100) - buyHoldPct).toFixed(2),
    totalTrades: trades.length,
    winningTrades: winTrades.length,
    losingTrades: lossTrades.length,
    winRate: trades.length > 0 ? +((winTrades.length / trades.length) * 100).toFixed(1) : 0,
    avgWinPct: +avgWin.toFixed(2),
    avgLossPct: +avgLoss.toFixed(2),
    profitFactor,
    maxDrawdownPct: +maxDrawdown.toFixed(2),
    signalDistribution: signalCounts,
    regimeDistribution: regimeCounts,
    priceRange: {
      start: firstPrice,
      end: lastPrice,
      startDate: new Date(candles4h[evalStartIdx]?.time).toISOString().slice(0, 10),
      endDate: new Date(candles4h[candles4h.length - 1]?.time).toISOString().slice(0, 10),
    },
    equityCurve: equityCurve.filter((_, i) => i % Math.max(1, Math.floor(equityCurve.length / 60)) === 0), // max 60 points
    trades: trades.map(t => ({
      ...t,
      entryTime: new Date(t.entryTime).toISOString(),
      exitTime: new Date(t.exitTime).toISOString(),
    })),
    signalHistory: signals.map(s => ({
      ...s,
      time: new Date(s.time).toISOString(),
    })),
    timestamp: new Date().toISOString(),
  };

  console.log(`[Backtest] ${asset} ${period} [${thresholdPreset}] — Return: ${result.totalReturnPct}% vs B&H: ${result.buyHoldReturnPct}% | Trades: ${trades.length} | WR: ${result.winRate}% | PF: ${profitFactor} | MaxDD: ${result.maxDrawdownPct}%`);

  return result;
}

module.exports = { runBacktest, THRESHOLD_PRESETS };
