// ─── Signal Scheduler ─────────────────────────────────────────────────────
const cron = require('node-cron');
const { fetchAllKlines, fetchTicker } = require('./binance');
const { analyzeTimeframe, computeMasterSignal } = require('./signalEngine');
const { getAllDevices } = require('./database');
const { evaluateAndNotify } = require('./pushSender');

// Estado en memoria del último análisis por asset
const lastAnalysis = {};

async function runAnalysis(asset) {
  const symbol = `${asset}USDT`;
  console.log(`[${new Date().toISOString()}] Analizando ${symbol}...`);

  try {
    const [allKlines, ticker] = await Promise.all([
      fetchAllKlines(symbol),
      fetchTicker(symbol),
    ]);

    // Correr análisis técnico por timeframe
    const tfAnalyses = {};
    for (const [tf, candles] of Object.entries(allKlines)) {
      tfAnalyses[tf] = analyzeTimeframe(candles, tf);
    }

    const masterSignal = computeMasterSignal(tfAnalyses);
    if (!masterSignal) return;

    // Adjuntar precio actual
    masterSignal.price = ticker.price;

    const prev = lastAnalysis[asset];
    const signalChanged = !prev || prev.signal !== masterSignal.signal;

    console.log(
      `[${asset}] Signal: ${masterSignal.signal} | Score: ${masterSignal.score.toFixed(3)} | ` +
      `Price: $${ticker.price.toLocaleString('en-US', { maximumFractionDigits: 0 })}` +
      (signalChanged ? ' ← CAMBIO DE SEÑAL' : '')
    );

    lastAnalysis[asset] = masterSignal;

    // Obtener dispositivos y evaluar si notificar
    const devices = getAllDevices();
    if (devices.length > 0) {
      await evaluateAndNotify(devices, masterSignal, asset);
    }

  } catch (err) {
    console.error(`[${asset}] Error en análisis:`, err.message);
  }
}

function getActiveAssets() {
  // Obtener assets únicos de los dispositivos registrados
  const devices = getAllDevices();
  const assets = [...new Set(devices.map(d => d.asset))];
  // Siempre analizar BTC y ETH aunque no haya dispositivos (para logs)
  return assets.length > 0 ? assets : ['BTC', 'ETH'];
}

function startScheduler(intervalMinutes = 1) {
  const cronExpr = `*/${intervalMinutes} * * * *`;
  console.log(`[Scheduler] Iniciando con intervalo de ${intervalMinutes} minuto(s)`);

  cron.schedule(cronExpr, async () => {
    const assets = getActiveAssets();
    // Analizar assets en paralelo
    await Promise.allSettled(assets.map(asset => runAnalysis(asset)));
  });

  // Correr inmediatamente al iniciar
  setTimeout(async () => {
    const assets = getActiveAssets();
    await Promise.allSettled(assets.map(asset => runAnalysis(asset)));
  }, 2000);
}

function getLastAnalysis() {
  return lastAnalysis;
}

module.exports = { startScheduler, getLastAnalysis };
