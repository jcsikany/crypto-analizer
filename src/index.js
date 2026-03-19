// ─── BTC Analyzer Server ─────────────────────────────────────────────────
require('dotenv').config();

const express = require('express');
const { startScheduler, getLastAnalysis } = require('./scheduler');
const {
  upsertDevice, removeDevice,
  upsertAlertConfig, getAlertConfig,
  getAllDevices,
} = require('./database');

const app  = express();
const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || 'dev_secret';

app.use(express.json());

// ─── Auth middleware ───────────────────────────────────────────────────────
function auth(req, res, next) {
  const secret = req.headers['x-api-secret'];
  if (secret !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── Health check (público) ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    devices: getAllDevices().length,
    timestamp: new Date().toISOString(),
  });
});

// ─── Registrar dispositivo ────────────────────────────────────────────────
// La app llama a esto al iniciar, enviando su Expo push token
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

// ─── Actualizar asset del dispositivo ────────────────────────────────────
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

// ─── Desregistrar dispositivo ─────────────────────────────────────────────
app.post('/unregister', auth, (req, res) => {
  const { pushToken } = req.body;
  if (!pushToken) return res.status(400).json({ error: 'pushToken requerido' });
  removeDevice(pushToken);
  res.json({ success: true });
});

// ─── Guardar config de alertas ────────────────────────────────────────────
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

// ─── Obtener config de alertas ────────────────────────────────────────────
app.get('/alerts/config/:pushToken', auth, (req, res) => {
  try {
    const config = getAlertConfig(req.params.pushToken);
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Última señal (para debug) ────────────────────────────────────────────
app.get('/signal/:asset', auth, (req, res) => {
  const analysis = getLastAnalysis();
  const asset = req.params.asset.toUpperCase();
  if (!analysis[asset]) {
    return res.status(404).json({ error: 'Sin análisis disponible aún' });
  }
  res.json(analysis[asset]);
});

// ─── Arrancar ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════╗
║     BTC Analyzer Signal Server        ║
║     Puerto: ${PORT}                       ║
║     Secreto: ${API_SECRET.slice(0, 4)}...                   ║
╚═══════════════════════════════════════╝
  `);

  const intervalMinutes = parseInt(process.env.CHECK_INTERVAL_MINUTES) || 1;
  startScheduler(intervalMinutes);
});

// Manejar errores no capturados para que el servidor no muera
process.on('uncaughtException', err => {
  console.error('[UncaughtException]', err.message);
});
process.on('unhandledRejection', err => {
  console.error('[UnhandledRejection]', err?.message);
});
