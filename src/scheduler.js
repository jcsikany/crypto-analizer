// ─── Signal Scheduler v2 — With Fundamentals + History ───────────────────────
const cron = require('node-cron');
const { fetchAllKlines, fetchTicker } = require('./binance');
const { analyzeTimeframe, computeMasterSignal } = require('./signalEngine');
const { getAllDevices, saveSignalHistory, cleanOldHistory } = require('./database');
const { evaluateAndNotify } = require('./pushSender');
const { fetchAllFundamentals } = require('./marketApis');
const { runAccumulation } = require('./accumulationService');

// Acumulación de largo plazo: una vez por día (CoinMetrics publica el día
// anterior durante la madrugada UTC) y al arrancar.
const ACCUMULATION_CRON = '15 6 * * *';

// S&P 500 / CSPX: después del cierre de EE.UU. (20:00–21:00 UTC según horario de verano)
// y recordatorio trimestral a las 12:00 UTC (09:00 en Uruguay)
const { runEquity, runEquityReminders } = require('./equityService');
const EQUITY_CRON = '30 22 * * 1-5';
const EQUITY_REMINDER_CRON = '0 12 * * *';

// Estado en memoria
const lastAnalysis = {};
const lastFundamentals = {};

// Fundamentals se actualizan menos frecuentemente (cada 5 minutos)
let lastFundamentalsFetch = 0;
const FUNDAMENTAL_INTERVAL_MS = 5 * 60 * 1000;

async function fetchFundamentalsIfNeeded(asset) {
  const now = Date.now();
  if (now - lastFundamentalsFetch < FUNDAMENTAL_INTERVAL_MS && lastFundamentals[asset]) {
    return lastFundamentals[asset];
  }

  try {
    const data = await fetchAllFundamentals(asset);
    lastFundamentals[asset] = data;
    lastFundamentalsFetch = now;
    console.log(
      `[${asset}] Fundamentals actualizados | ` +
      `F&G: ${data.fearGreed?.value ?? '?'} | ` +
      `Funding: ${data.funding?.current?.toFixed(4) ?? '?'} | ` +
      `L/S: ${data.longShortRatio?.ratio?.toFixed(2) ?? '?'} | ` +
      `DeFi TVL 7d: ${data.defiTVL?.change7d ?? '?'}%`
    );
    return data;
  } catch (err) {
    console.warn(`[${asset}] Error fetching fundamentals:`, err.message);
    return lastFundamentals[asset] ?? null;
  }
}

async function runAnalysis(asset) {
  const symbol = `${asset}USDT`;
  console.log(`\n[${new Date().toISOString()}] ═══ Analizando ${symbol} ═══`);

  try {
    // 1. Fetch price data + fundamentals in parallel
    const [allKlines, ticker, fundamentals] = await Promise.all([
      fetchAllKlines(symbol),
      fetchTicker(symbol),
      fetchFundamentalsIfNeeded(asset),
    ]);

    // 2. Analyze each timeframe
    const tfAnalyses = {};
    for (const [tf, candles] of Object.entries(allKlines)) {
      tfAnalyses[tf] = analyzeTimeframe(candles, tf);
    }

    // 3. Compute master signal with fundamentals
    const masterSignal = computeMasterSignal(tfAnalyses, fundamentals);
    if (!masterSignal) return;

    // Attach price
    masterSignal.price = ticker.price;

    // 4. Check for signal change
    const prev = lastAnalysis[asset];
    const signalChanged = !prev || prev.signal !== masterSignal.signal;
    const zoneChanged = !prev || prev.zone !== masterSignal.zone;

    // 5. Log results
    console.log(
      `[${asset}] Signal: ${masterSignal.signal} | ` +
      `Score: ${masterSignal.score.toFixed(3)} | ` +
      `Conf: ${masterSignal.confidence}% | ` +
      `Zone: ${masterSignal.zone} | ` +
      `Regime: ${masterSignal.regime} | ` +
      `Confluence: ${(masterSignal.confluence.ratio * 100).toFixed(0)}% | ` +
      `Price: $${ticker.price.toLocaleString('en-US', { maximumFractionDigits: 0 })}` +
      (signalChanged ? ' ◄ CAMBIO DE SEÑAL' : '') +
      (zoneChanged && !signalChanged ? ' ◄ CAMBIO DE ZONA' : '')
    );

    // Log TF breakdown
    masterSignal.tfBreakdown.forEach(tf => {
      console.log(`  └─ ${tf.tf}: ${tf.signal} (${tf.score.toFixed(3)}) [${tf.regime}]`);
    });

    if (masterSignal.fundamental) {
      console.log(
        `  └─ Fundamental: ${masterSignal.fundamental.score.toFixed(3)} | ` +
        `F&G: ${masterSignal.fundamental.fearGreed ?? '?'} | ` +
        `Funding: ${masterSignal.fundamental.funding?.toFixed(4) ?? '?'}`
      );
    }

    // 6. Save to history (for backtesting)
    saveSignalHistory(asset, masterSignal);

    // 7. Update last analysis
    lastAnalysis[asset] = masterSignal;

    // 8. Evaluate push notifications
    const devices = getAllDevices();
    if (devices.length > 0) {
      await evaluateAndNotify(devices, masterSignal, asset);
    }

  } catch (err) {
    console.error(`[${asset}] Error en análisis:`, err.message);
  }
}

function getActiveAssets() {
  const devices = getAllDevices();
  const assets = [...new Set(devices.map(d => d.asset))];
  return assets.length > 0 ? assets : ['BTC', 'ETH'];
}

function startScheduler(intervalMinutes = 1) {
  const cronExpr = `*/${intervalMinutes} * * * *`;
  console.log(`[Scheduler] Iniciando con intervalo de ${intervalMinutes} minuto(s)`);

  // Análisis principal cada N minutos
  cron.schedule(cronExpr, async () => {
    const assets = getActiveAssets();
    await Promise.allSettled(assets.map(asset => runAnalysis(asset)));
  });

  // Limpieza de historial viejo cada 24h
  cron.schedule('0 3 * * *', () => {
    console.log('[Scheduler] Limpieza diaria de historial');
    cleanOldHistory(30);
  });

  cron.schedule(ACCUMULATION_CRON, () => runAccumulation(), { timezone: 'UTC' });
  cron.schedule(EQUITY_CRON, () => runEquity(), { timezone: 'UTC' });
  cron.schedule(EQUITY_REMINDER_CRON, () => runEquityReminders(), { timezone: 'UTC' });

  // Correr inmediatamente al iniciar
  setTimeout(async () => {
    const assets = getActiveAssets();
    await Promise.allSettled(assets.map(asset => runAnalysis(asset)));
  }, 2000);
  setTimeout(() => runAccumulation(), 5000);
  // Al arrancar: primero el análisis (así el recordatorio lleva datos) y después
  // el recordatorio, por si el servidor estuvo caído el día que tocaba
  setTimeout(async () => { await runEquity(); await runEquityReminders(); }, 8000);
}

function getLastAnalysis() {
  return lastAnalysis;
}

function getLastFundamentals() {
  return lastFundamentals;
}

module.exports = { startScheduler, getLastAnalysis, getLastFundamentals };
