// ─── Database (SQLite) ────────────────────────────────────────────────────
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'analyzer.db');

// Crear directorio si no existe
const fs = require('fs');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// ─── Migrations ───────────────────────────────────────────────────────────
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
`);

// ─── Devices ──────────────────────────────────────────────────────────────

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

// ─── Alert configs ────────────────────────────────────────────────────────

function upsertAlertConfig(pushToken, config) {
  db.prepare(`
    INSERT INTO alert_configs (push_token, enabled, strong_threshold, moderate_threshold, cooldown_minutes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(push_token) DO UPDATE SET
      enabled            = excluded.enabled,
      strong_threshold   = excluded.strong_threshold,
      moderate_threshold = excluded.moderate_threshold,
      cooldown_minutes   = excluded.cooldown_minutes,
      updated_at         = excluded.updated_at
  `).run(
    pushToken,
    config.enabled ? 1 : 0,
    config.strongThreshold   ?? 1.3,
    config.moderateThreshold ?? 0.7,
    config.cooldownMinutes   ?? 60,
    Date.now()
  );
}

function getAlertConfig(pushToken) {
  const row = db.prepare('SELECT * FROM alert_configs WHERE push_token = ?').get(pushToken);
  if (!row) return {
    enabled: true, strongThreshold: 1.3,
    moderateThreshold: 0.7, cooldownMinutes: 60,
  };
  return {
    enabled:            !!row.enabled,
    strongThreshold:    row.strong_threshold,
    moderateThreshold:  row.moderate_threshold,
    cooldownMinutes:    row.cooldown_minutes,
  };
}

// ─── Alert log — cooldown ─────────────────────────────────────────────────

function canSendAlert(pushToken, asset, alertType, cooldownMinutes) {
  const cutoff = Date.now() - cooldownMinutes * 60 * 1000;
  const row = db.prepare(`
    SELECT sent_at FROM alert_log
    WHERE push_token = ? AND asset = ? AND alert_type = ?
    AND sent_at > ?
    ORDER BY sent_at DESC LIMIT 1
  `).get(pushToken, asset, alertType, cutoff);
  return !row; // true si puede enviar (no hay registro reciente)
}

function logAlert(pushToken, asset, alertType, score) {
  db.prepare(`
    INSERT INTO alert_log (push_token, asset, alert_type, score, sent_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(pushToken, asset, alertType, score, Date.now());
}

module.exports = {
  upsertDevice, getAllDevices, removeDevice,
  upsertAlertConfig, getAlertConfig,
  canSendAlert, logAlert,
};
