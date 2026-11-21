// ─── Database (SQLite) — Enhanced v2 ─────────────────────────────────────────
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'analyzer.db');

// Crear directorio si no existe
const fs = require('fs');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Optimizaciones SQLite
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// ─── Migrations ──────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    push_token    TEXT UNIQUE NOT NULL,
    asset         TEXT NOT NULL DEFAULT 'BTC',
    created_at    INTEGER NOT NULL,
    last_seen     INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS alert_configs (
    push_token          TEXT PRIMARY KEY,
    enabled             INTEGER NOT NULL DEFAULT 1,
    strong_threshold    REAL    NOT NULL DEFAULT 1.3,
    moderate_threshold  REAL    NOT NULL DEFAULT 0.7,
    cooldown_minutes    INTEGER NOT NULL DEFAULT 60,
    updated_at          INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS alert_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    push_token  TEXT    NOT NULL,
    asset       TEXT    NOT NULL,
    alert_type  TEXT    NOT NULL,
    score       REAL    NOT NULL,
    sent_at     INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS signal_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    asset       TEXT    NOT NULL,
    signal      TEXT    NOT NULL,
    score       REAL    NOT NULL,
    confidence  INTEGER NOT NULL,
    zone        TEXT,
    regime      TEXT,
    price       REAL,
    confluence  REAL,
    fundamental_score REAL,
    fear_greed  INTEGER,
    funding_rate REAL,
    tf_breakdown TEXT,
    created_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_signal_history_asset_time
    ON signal_history(asset, created_at);

  CREATE INDEX IF NOT EXISTS idx_signal_history_signal
    ON signal_history(asset, signal, created_at);
`);

// Migración idempotente: alertas de acumulación de largo plazo (on por defecto)
const alertConfigColumns = db.prepare('PRAGMA table_info(alert_configs)').all().map(c => c.name);
if (!alertConfigColumns.includes('long_term_enabled')) {
  db.exec('ALTER TABLE alert_configs ADD COLUMN long_term_enabled INTEGER NOT NULL DEFAULT 1');
}

// ─── Devices ─────────────────────────────────────────────────────────────────

function upsertDevice(pushToken, asset = 'BTC') {
  const now = Date.now();
  db.prepare(`
    INSERT INTO devices (push_token, asset, created_at, last_seen)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(push_token) DO UPDATE SET
      asset = excluded.asset,
      last_seen = excluded.last_seen
  `).run(pushToken, asset, now, now);
}

function getAllDevices() {
  return db.prepare('SELECT * FROM devices').all();
}

function removeDevice(pushToken) {
  db.prepare('DELETE FROM devices WHERE push_token = ?').run(pushToken);
  db.prepare('DELETE FROM alert_configs WHERE push_token = ?').run(pushToken);
}

// ─── Alert configs ───────────────────────────────────────────────────────────

function upsertAlertConfig(pushToken, config) {
  // Si el cliente no manda longTermEnabled (app vieja), se conserva el valor guardado
  const existing = db.prepare('SELECT long_term_enabled FROM alert_configs WHERE push_token = ?').get(pushToken);
  const longTermEnabled = typeof config.longTermEnabled === 'boolean'
    ? (config.longTermEnabled ? 1 : 0)
    : (existing?.long_term_enabled ?? 1);

  db.prepare(`
    INSERT INTO alert_configs (push_token, enabled, strong_threshold, moderate_threshold, cooldown_minutes, long_term_enabled, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(push_token) DO UPDATE SET
      enabled            = excluded.enabled,
      strong_threshold   = excluded.strong_threshold,
      moderate_threshold = excluded.moderate_threshold,
      cooldown_minutes   = excluded.cooldown_minutes,
      long_term_enabled  = excluded.long_term_enabled,
      updated_at         = excluded.updated_at
  `).run(
    pushToken,
    config.enabled ? 1 : 0,
    config.strongThreshold   ?? 1.3,
    config.moderateThreshold ?? 0.7,
    config.cooldownMinutes   ?? 60,
    longTermEnabled,
    Date.now()
  );
}

function getAlertConfig(pushToken) {
  const row = db.prepare('SELECT * FROM alert_configs WHERE push_token = ?').get(pushToken);
  if (!row) return {
    enabled: true, strongThreshold: 1.3,
    moderateThreshold: 0.7, cooldownMinutes: 60,
    longTermEnabled: true,
  };
  return {
    enabled:            !!row.enabled,
    strongThreshold:    row.strong_threshold,
    moderateThreshold:  row.moderate_threshold,
    cooldownMinutes:    row.cooldown_minutes,
    longTermEnabled:    row.long_term_enabled !== 0,
  };
}

// ─── Alert log — cooldown ────────────────────────────────────────────────────

function canSendAlert(pushToken, asset, alertType, cooldownMinutes) {
  const cutoff = Date.now() - cooldownMinutes * 60 * 1000;
  const row = db.prepare(`
    SELECT sent_at FROM alert_log
    WHERE push_token = ? AND asset = ? AND alert_type = ?
    AND sent_at > ?
    ORDER BY sent_at DESC LIMIT 1
  `).get(pushToken, asset, alertType, cutoff);
  return !row;
}

function logAlert(pushToken, asset, alertType, score) {
  db.prepare(`
    INSERT INTO alert_log (push_token, asset, alert_type, score, sent_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(pushToken, asset, alertType, score, Date.now());
}

// ─── Signal History (backtesting pasivo) ─────────────────────────────────────

function saveSignalHistory(asset, masterSignal) {
  if (!masterSignal) return;

  db.prepare(`
    INSERT INTO signal_history (
      asset, signal, score, confidence, zone, regime, price,
      confluence, fundamental_score, fear_greed, funding_rate,
      tf_breakdown, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    asset,
    masterSignal.signal,
    masterSignal.score,
    masterSignal.confidence,
    masterSignal.zone ?? null,
    masterSignal.regime ?? null,
    masterSignal.price ?? null,
    masterSignal.confluence?.ratio ?? null,
    masterSignal.fundamental?.score ?? null,
    masterSignal.fundamental?.fearGreed ?? null,
    masterSignal.fundamental?.funding ?? null,
    JSON.stringify(masterSignal.tfBreakdown ?? []),
    Date.now()
  );
}

function getSignalHistory(asset, limit = 100) {
  return db.prepare(`
    SELECT * FROM signal_history
    WHERE asset = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(asset, limit);
}

function getSignalStats(asset, hours = 24) {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const rows = db.prepare(`
    SELECT signal, COUNT(*) as count, AVG(score) as avg_score,
           AVG(confidence) as avg_confidence, MIN(price) as min_price,
           MAX(price) as max_price
    FROM signal_history
    WHERE asset = ? AND created_at > ?
    GROUP BY signal
    ORDER BY count DESC
  `).all(asset, cutoff);

  const total = rows.reduce((s, r) => s + r.count, 0);
  return {
    period: `${hours}h`,
    total,
    signals: rows.map(r => ({
      signal: r.signal,
      count: r.count,
      pct: total > 0 ? +((r.count / total) * 100).toFixed(1) : 0,
      avgScore: +r.avg_score.toFixed(3),
      avgConfidence: Math.round(r.avg_confidence),
      priceRange: { min: r.min_price, max: r.max_price },
    })),
  };
}

// Evaluar precisión: ¿las señales BUY fueron seguidas de subida de precio?
function evaluateAccuracy(asset, lookbackHours = 168) { // 7 días default
  const cutoff = Date.now() - lookbackHours * 60 * 60 * 1000;
  const signals = db.prepare(`
    SELECT * FROM signal_history
    WHERE asset = ? AND created_at > ?
    ORDER BY created_at ASC
  `).all(asset, cutoff);

  if (signals.length < 10) return null;

  let correct = 0, total = 0;
  for (let i = 0; i < signals.length - 5; i++) {
    const s = signals[i];
    // Buscar precio 5 señales después (~5 minutos si interval es 1min)
    const future = signals[Math.min(i + 5, signals.length - 1)];
    if (!s.price || !future.price) continue;

    const priceChange = (future.price - s.price) / s.price;
    const predictedUp = s.score > 0;
    const actualUp = priceChange > 0;

    if (s.signal !== 'NEUTRAL') {
      total++;
      if (predictedUp === actualUp) correct++;
    }
  }

  return {
    total,
    correct,
    accuracy: total > 0 ? +((correct / total) * 100).toFixed(1) : null,
    period: `${lookbackHours}h`,
  };
}

// Limpiar historial viejo (mantener últimos 30 días)
function cleanOldHistory(daysToKeep = 30) {
  const cutoff = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
  const result = db.prepare('DELETE FROM signal_history WHERE created_at < ?').run(cutoff);
  if (result.changes > 0) {
    console.log(`[DB] Limpiados ${result.changes} registros de signal_history`);
  }
}

module.exports = {
  upsertDevice, getAllDevices, removeDevice,
  upsertAlertConfig, getAlertConfig,
  canSendAlert, logAlert,
  saveSignalHistory, getSignalHistory, getSignalStats, evaluateAccuracy,
  cleanOldHistory,
};
