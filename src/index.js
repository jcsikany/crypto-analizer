// ─── BTC Analyzer Server v2 ──────────────────────────────────────────────────
require('dotenv').config();

const express = require('express');
const { startScheduler, getLastAnalysis, getLastFundamentals } = require('./scheduler');
const {
  upsertDevice, removeDevice,
  upsertAlertConfig, getAlertConfig,
  getAllDevices,
  getSignalHistory, getSignalStats, evaluateAccuracy,
} = require('./database');
const { runBacktest, THRESHOLD_PRESETS } = require('./backtestEngine');
const { getAccumulationState } = require('./accumulationService');

const app  = express();
const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || 'dev_secret';

app.use(express.json());

// ─── In-memory log buffer ─────────────────────────────────────────────────────
const LOG_BUFFER_SIZE = 500;
const logBuffer = [];

const origLog = console.log;
const origError = console.error;
const origWarn = console.warn;

function pushLog(level, args) {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  logBuffer.push({ ts: new Date().toISOString(), level, msg });
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
}

console.log = (...args) => { pushLog('INFO', args); origLog.apply(console, args); };
console.error = (...args) => { pushLog('ERROR', args); origError.apply(console, args); };
console.warn = (...args) => { pushLog('WARN', args); origWarn.apply(console, args); };

// ─── Auth middleware ─────────────────────────────────────────────────────────
function auth(req, res, next) {
  const secret = req.headers['x-api-secret'];
  if (secret !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── Health check (público) ──────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const analysis = getLastAnalysis();
  const assets = Object.keys(analysis);
  res.json({
    status: 'ok',
    version: '2.0.0',
    uptime: Math.round(process.uptime()),
    devices: getAllDevices().length,
    activeAssets: assets,
    lastSignals: assets.reduce((acc, a) => {
      acc[a] = {
        signal: analysis[a]?.signal,
        score: analysis[a]?.score,
        confidence: analysis[a]?.confidence,
        zone: analysis[a]?.zone,
        regime: analysis[a]?.regime,
      };
      return acc;
    }, {}),
    timestamp: new Date().toISOString(),
  });
});

// ─── Registrar dispositivo ──────────────────────────────────────────────────
app.post('/register', auth, (req, res) => {
  const { pushToken, asset = 'BTC' } = req.body;
  if (!pushToken) {
    return res.status(400).json({ error: 'pushToken requerido' });
  }
  try {
    upsertDevice(pushToken, asset);
    console.log(`[Register] ${asset} — ${pushToken.slice(-12)}`);
    res.json({ success: true, message: 'Dispositivo registrado' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Actualizar asset del dispositivo ────────────────────────────────────────
app.post('/register/asset', auth, (req, res) => {
  const { pushToken, asset } = req.body;
  if (!pushToken || !asset) {
    return res.status(400).json({ error: 'pushToken y asset requeridos' });
  }
  try {
    upsertDevice(pushToken, asset);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Desregistrar dispositivo ────────────────────────────────────────────────
app.post('/unregister', auth, (req, res) => {
  const { pushToken } = req.body;
  if (!pushToken) return res.status(400).json({ error: 'pushToken requerido' });
  removeDevice(pushToken);
  res.json({ success: true });
});

// ─── Guardar config de alertas ───────────────────────────────────────────────
app.post('/alerts/config', auth, (req, res) => {
  const { pushToken, config } = req.body;
  if (!pushToken || !config) {
    return res.status(400).json({ error: 'pushToken y config requeridos' });
  }
  try {
    upsertAlertConfig(pushToken, config);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Obtener config de alertas ───────────────────────────────────────────────
app.get('/alerts/config/:pushToken', auth, (req, res) => {
  try {
    const config = getAlertConfig(req.params.pushToken);
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Última señal completa ───────────────────────────────────────────────────
app.get('/signal/:asset', auth, (req, res) => {
  const analysis = getLastAnalysis();
  const asset = req.params.asset.toUpperCase();
  if (!analysis[asset]) {
    return res.status(404).json({ error: 'Sin análisis disponible aún' });
  }
  res.json(analysis[asset]);
});

// ─── Fundamentals actuales ───────────────────────────────────────────────────
app.get('/fundamentals/:asset', auth, (req, res) => {
  const fundamentals = getLastFundamentals();
  const asset = req.params.asset.toUpperCase();
  if (!fundamentals[asset]) {
    return res.status(404).json({ error: 'Sin datos fundamentales aún' });
  }
  res.json(fundamentals[asset]);
});

// ─── Acumulación de largo plazo (BTC) ────────────────────────────────────────
app.get('/accumulation', auth, (req, res) => {
  const state = getAccumulationState();
  if (!state) {
    return res.status(503).json({ error: 'Análisis de acumulación aún no disponible' });
  }
  res.json({ ...state, livePrice: getLastAnalysis().BTC?.price ?? null });
});

// ─── Historial de señales ────────────────────────────────────────────────────
app.get('/signal/history/:asset', auth, (req, res) => {
  const asset = req.params.asset.toUpperCase();
  const limit = parseInt(req.query.limit) || 100;
  try {
    const history = getSignalHistory(asset, Math.min(limit, 500));
    res.json({ asset, count: history.length, history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Estadísticas de señales ─────────────────────────────────────────────────
app.get('/signal/stats/:asset', auth, (req, res) => {
  const asset = req.params.asset.toUpperCase();
  const hours = parseInt(req.query.hours) || 24;
  try {
    const stats = getSignalStats(asset, hours);
    const accuracy = evaluateAccuracy(asset, hours);
    res.json({ asset, stats, accuracy });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Estado completo del sistema ─────────────────────────────────────────────
app.get('/system/status', auth, (req, res) => {
  const analysis = getLastAnalysis();
  const fundamentals = getLastFundamentals();

  res.json({
    version: '2.0.0',
    uptime: Math.round(process.uptime()),
    devices: getAllDevices().length,
    analysis: Object.entries(analysis).reduce((acc, [asset, data]) => {
      acc[asset] = {
        signal: data.signal,
        score: data.score,
        confidence: data.confidence,
        zone: data.zone,
        regime: data.regime,
        confluence: data.confluence,
        price: data.price,
        timestamp: data.timestamp,
      };
      return acc;
    }, {}),
    fundamentals: Object.entries(fundamentals).reduce((acc, [asset, data]) => {
      acc[asset] = {
        fearGreed: data.fearGreed?.value ?? null,
        funding: data.funding?.current ?? null,
        longShortRatio: data.longShortRatio?.ratio ?? null,
        defiTVL: data.defiTVL?.totalTVL ?? null,
        compositeScore: data.compositeScore ?? null,
      };
      return acc;
    }, {}),
    timestamp: new Date().toISOString(),
  });
});

// ─── Backtest ───────────────────────────────────────────────────────────────
const backtestCache = {};
const BACKTEST_CACHE_TTL = 30 * 60 * 1000; // 30 min cache

app.get('/backtest/:asset', auth, async (req, res) => {
  const asset = req.params.asset.toUpperCase();
  if (!['BTC', 'ETH'].includes(asset)) {
    return res.status(400).json({ error: 'Asset must be BTC or ETH' });
  }

  const period = req.query.period || '90d';
  const stopLoss = parseFloat(req.query.stopLoss) || 3;
  const takeProfit = parseFloat(req.query.takeProfit) || 5;
  const thresholdPreset = req.query.threshold || 'conservative';
  const cacheKey = `${asset}_${period}_${stopLoss}_${takeProfit}_${thresholdPreset}`;

  // Check cache
  if (backtestCache[cacheKey] && Date.now() - backtestCache[cacheKey].cachedAt < BACKTEST_CACHE_TTL) {
    return res.json({ ...backtestCache[cacheKey].data, cached: true });
  }

  try {
    const result = await runBacktest(asset, {
      period,
      stopLossPct: stopLoss,
      takeProfitPct: takeProfit,
      thresholdPreset,
    });
    backtestCache[cacheKey] = { data: result, cachedAt: Date.now() };
    res.json(result);
  } catch (err) {
    console.error(`[Backtest] Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// List available threshold presets
app.get('/backtest/presets', auth, (req, res) => {
  res.json(THRESHOLD_PRESETS);
});

// ─── Logs web viewer (público, solo lectura) ────────────────────────────────
app.get('/logs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 200, LOG_BUFFER_SIZE);
  const level = req.query.level; // filter: INFO, WARN, ERROR
  const search = req.query.search || '';

  let filtered = logBuffer.slice(-limit);
  if (level) filtered = filtered.filter(l => l.level === level.toUpperCase());
  if (search) filtered = filtered.filter(l => l.msg.toLowerCase().includes(search.toLowerCase()));

  // If JSON requested
  if (req.headers.accept?.includes('application/json') || req.query.format === 'json') {
    return res.json({ count: filtered.length, logs: filtered });
  }

  // HTML dashboard
  const rows = filtered.reverse().map(l => {
    const color = l.level === 'ERROR' ? '#ff6b6b' : l.level === 'WARN' ? '#ffd93d' : '#a8e6cf';
    const escapedMsg = l.msg.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return `<tr><td style="color:#888;white-space:nowrap">${l.ts.replace('T',' ').slice(0,19)}</td><td><span style="color:${color};font-weight:bold">${l.level}</span></td><td>${escapedMsg}</td></tr>`;
  }).join('');

  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Crypto Analyzer Logs</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#0d1117;color:#c9d1d9;font-family:'Courier New',monospace;font-size:13px;padding:16px}
  h1{color:#f7931a;font-size:20px;margin-bottom:8px}
  .bar{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center}
  .bar a,.bar button{background:#21262d;color:#c9d1d9;border:1px solid #30363d;padding:4px 12px;border-radius:6px;text-decoration:none;cursor:pointer;font-size:12px}
  .bar a:hover,.bar button:hover{background:#30363d}
  .bar .active{background:#f7931a;color:#000;border-color:#f7931a}
  input{background:#161b22;color:#c9d1d9;border:1px solid #30363d;padding:4px 10px;border-radius:6px;font-size:12px;width:180px}
  table{width:100%;border-collapse:collapse}
  td{padding:3px 8px;border-bottom:1px solid #21262d;vertical-align:top;max-width:0;overflow:hidden;text-overflow:ellipsis}
  td:first-child{width:150px} td:nth-child(2){width:50px}
  .status{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:12px}
  .auto{color:#888;font-size:11px}
</style></head><body>
<h1>Crypto Analyzer Server v2 — Logs</h1>
<div class="status" id="status">Cargando status...</div>
<div class="bar">
  <a href="/logs" class="${!level?'active':''}">Todos</a>
  <a href="/logs?level=INFO" class="${level==='INFO'?'active':''}">INFO</a>
  <a href="/logs?level=WARN" class="${level==='WARN'?'active':''}">WARN</a>
  <a href="/logs?level=ERROR" class="${level==='ERROR'?'active':''}">ERROR</a>
  <input type="text" placeholder="Buscar..." value="${search}" onkeydown="if(event.key==='Enter')location.href='/logs?search='+this.value">
  <button onclick="location.reload()">Refresh</button>
  <span class="auto"><input type="checkbox" id="autoRef" checked> Auto-refresh 30s</span>
</div>
<table>${rows}</table>
<script>
  fetch('/health').then(r=>r.json()).then(d=>{
    const s=d.lastSignals||{};
    let html='<b>Uptime:</b> '+Math.round(d.uptime/60)+'min | <b>Devices:</b> '+d.devices;
    Object.entries(s).forEach(([a,v])=>{
      const c=v.signal==='STRONG_BUY'||v.signal==='BUY'?'#4ade80':v.signal==='STRONG_SELL'||v.signal==='SELL'?'#f87171':'#fbbf24';
      html+=' | <b>'+a+':</b> <span style="color:'+c+'">'+v.signal+'</span> ('+((v.score||0)*100).toFixed(0)+'%) ['+v.regime+']';
    });
    document.getElementById('status').innerHTML=html;
  });
  setInterval(()=>{if(document.getElementById('autoRef').checked)location.reload()},30000);
</script></body></html>`);
});

// ─── Arrancar ────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════╗
║     Crypto Analyzer Signal Server v2      ║
║     Puerto: ${String(PORT).padEnd(29)}║
║     Features:                             ║
║       • Regime Detection                  ║
║       • Multi-TF Confluence               ║
║       • Adaptive Thresholds               ║
║       • Fundamental Analysis              ║
║       • Signal History + Backtesting      ║
╚═══════════════════════════════════════════╝
  `);

  const intervalMinutes = parseInt(process.env.CHECK_INTERVAL_MINUTES) || 1;
  startScheduler(intervalMinutes);
});

// Manejar errores no capturados
process.on('uncaughtException', err => {
  console.error('[UncaughtException]', err.message);
});
process.on('unhandledRejection', err => {
  console.error('[UnhandledRejection]', err?.message);
});
