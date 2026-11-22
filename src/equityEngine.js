// ─── Equity Engine — oportunidades de largo plazo en el S&P 500 (CSPX/SPY) ──
// Para un esquema de compra fija trimestral + fondo de reserva que se usa
// en caídas. Niveles (medidos con SPY desde 1993):
//
//   1 Oportunidad : caída >= 10% desde el máximo  o  VIX >= 30
//   2 Fuerte      : caída >= 20%                  o  VIX >= 40
//   3 Extrema     : caída >= 30%
//
// Cada nivel avisa una sola vez por caída. Se rearma cuando no hay señales
// activas y el precio volvió a menos de 5% del máximo. Todo es puro (sin red
// ni base de datos) y se recalcula desde la historia en cada corrida.

const THRESHOLDS = {
  1: { dd: -0.10, vix: 30 },
  2: { dd: -0.20, vix: 40 },
  3: { dd: -0.30, vix: null },
};
const RESET_DD = -0.05;
const EVENT_WINDOW_DAYS = 7;   // si una corrida falla, el evento se sigue reportando
const STALE_AFTER_DAYS = 5;    // fines de semana/feriados no cuentan como viejo
const REMINDER_CATCHUP_DAYS = 3;          // si el servidor estuvo caído ese día
const MARKET_CLOSED_UTC_MINUTES = 21 * 60 + 30; // NYSE cierra 20:00/21:00 UTC (verano/invierno)
const DEFAULT_CONFIG = {
  enabled: true,
  reminderEnabled: true,
  reminderDay: 1,
  reminderMonths: [1, 4, 7, 10],
  fractions: [33, 50, 100],    // % de la reserva por nivel (2 y 3: % de lo que quede)
};

const DAY_MS = 86_400_000;
const isoFromUnix = (s) => new Date(s * 1000).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(iso) + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);
const median = (values) => {
  if (values.length === 0) return null;
  const s = [...values].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

/**
 * Respuesta del chart API de Yahoo → [{ t: 'YYYY-MM-DD', p }] ordenada y sin duplicados.
 * @param {object} json
 * @param {{ adjusted?: boolean }} [options]  adjusted = precio con dividendos reinvertidos
 */
function parseYahooChart(json, { adjusted = false } = {}) {
  const r = json?.chart?.result?.[0];
  if (!r || !Array.isArray(r.timestamp)) {
    throw new Error(`Yahoo: respuesta inválida ${JSON.stringify(json?.chart?.error ?? null)}`);
  }
  const values = adjusted
    ? r.indicators?.adjclose?.[0]?.adjclose
    : r.indicators?.quote?.[0]?.close;
  if (!Array.isArray(values)) throw new Error('Yahoo: faltan precios en la respuesta');

  const byDate = new Map();
  r.timestamp.forEach((ts, i) => {
    const p = values[i];
    if (Number.isFinite(p) && p > 0) byDate.set(isoFromUnix(ts), p);
  });
  return [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([t, p]) => ({ t, p }));
}

/**
 * Descarta la vela de hoy si el mercado de EE.UU. todavía no cerró: Yahoo
 * devuelve la vela en curso y no debe tratarse como cierre (evita avisos
 * prematuros si el servidor corre en horario de mercado).
 */
function dropOpenBar(prices, nowMs = Date.now()) {
  if (prices.length === 0) return prices;
  const now = new Date(nowMs);
  const today = now.toISOString().slice(0, 10);
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const last = prices[prices.length - 1];
  return last.t === today && minutes < MARKET_CLOSED_UTC_MINUTES ? prices.slice(0, -1) : prices;
}

/** CSV de FRED (fecha,valor) → Map fecha→valor, ignorando días sin dato ("."). */
function parseFredCsv(text) {
  const out = new Map();
  for (const line of String(text || '').split('\n').slice(1)) {
    const [t, v] = line.trim().split(',');
    const n = Number(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(t || '') && v !== '.' && Number.isFinite(n)) out.set(t, n);
  }
  return out;
}

/**
 * Agrega máximo histórico, caída desde el máximo y VIX (arrastrado si falta ese día).
 * @param {{ t: string, p: number }[]} prices
 * @param {Map<string, number>} vixByDate
 */
function buildSeries(prices, vixByDate) {
  let ath = 0;
  let athDate = null;
  let vix = null;
  return prices.map(({ t, p }) => {
    if (p > ath) { ath = p; athDate = t; }
    if (vixByDate.has(t)) vix = vixByDate.get(t);
    return { t, p, ath, athDate, dd: p / ath - 1, vix };
  });
}

/** Nivel de oportunidad de un día: 0 (nada) a 3 (extrema). */
function levelOf({ dd, vix }) {
  const v = Number.isFinite(vix) ? vix : -Infinity;
  if (dd <= THRESHOLDS[3].dd) return 3;
  if (dd <= THRESHOLDS[2].dd || v >= THRESHOLDS[2].vix) return 2;
  if (dd <= THRESHOLDS[1].dd || v >= THRESHOLDS[1].vix) return 1;
  return 0;
}

/**
 * Marca qué niveles se disparan cada día (una vez por caída, con rearme).
 * @returns {Array<object>} filas con level, armed y triggered (niveles nuevos ese día)
 */
function trackLevels(series) {
  let armed = 0;
  return series.map(r => {
    const level = levelOf(r);
    if (level === 0 && r.dd > RESET_DD) armed = 0;
    const triggered = [];
    for (let k = armed + 1; k <= level; k++) triggered.push(k);
    if (level > armed) armed = level;
    return { ...r, level, armed, triggered };
  });
}

/** Estado del último día: nivel actual y evento reciente (dentro de la ventana). */
function evaluateLatest(tracked, nowMs = Date.now()) {
  if (tracked.length === 0) return null;
  const last = tracked[tracked.length - 1];
  let event = null;
  for (let k = tracked.length - 1; k >= 0; k--) {
    const r = tracked[k];
    if (daysBetween(r.t, last.t) >= EVENT_WINDOW_DAYS) break;
    if (r.triggered.length > 0) {
      event = { date: r.t, levels: r.triggered, level: Math.max(...r.triggered) };
      break;
    }
  }
  return {
    asOf: last.t,
    price: last.p,
    ath: last.ath,
    athDate: last.athDate,
    dd: last.dd,
    vix: last.vix,
    level: last.level,
    armed: last.armed,
    event,
    isStale: nowMs - Date.parse(last.t) > STALE_AFTER_DAYS * DAY_MS,
  };
}

/** Primer día de mercado en o después de la fecha (búsqueda binaria). */
function indexOnOrAfter(tracked, iso) {
  let lo = 0;
  let hi = tracked.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tracked[mid].t < iso) lo = mid + 1; else hi = mid;
  }
  return lo < tracked.length ? lo : -1;
}

function forwardReturn(tracked, i, days) {
  const j = indexOnOrAfter(tracked, addDays(tracked[i].t, days));
  return j === -1 ? null : tracked[j].p / tracked[i].p - 1;
}

/** Días en que se disparó algún nivel, con su retorno posterior. */
function findTriggers(tracked) {
  const out = [];
  tracked.forEach((r, i) => {
    if (r.triggered.length === 0) return;
    out.push({
      t: r.t,
      levels: r.triggered,
      level: Math.max(...r.triggered),
      p: r.p,
      dd: r.dd,
      vix: r.vix,
      return182: forwardReturn(tracked, i, 182),
      return365: forwardReturn(tracked, i, 365),
    });
  });
  return out;
}

/** Resumen por nivel: cantidad y retornos posteriores (fracciones, 0.2 = +20%). */
function summarizeTriggers(triggers) {
  const out = {};
  for (const level of [1, 2, 3]) {
    const hits = triggers.filter(t => t.levels.includes(level));
    const r365 = hits.map(h => h.return365).filter(x => x !== null);
    out[level] = {
      count: hits.length,
      median182: median(hits.map(h => h.return182).filter(x => x !== null)),
      median365: median(r365),
      pctPositive365: r365.length ? Math.round(100 * r365.filter(x => x > 0).length / r365.length) : null,
    };
  }
  return out;
}

/**
 * ¿Toca el recordatorio de la compra trimestral? El día elegido o hasta
 * REMINDER_CATCHUP_DAYS después (si el servidor estuvo caído); el cooldown
 * de alert_log evita que se mande más de una vez.
 */
function isReminderDue(config, isoDate) {
  if (!config?.reminderEnabled) return false;
  const month = Number(isoDate.slice(5, 7));
  const day = Number(isoDate.slice(8, 10));
  return config.reminderMonths.includes(month)
    && day >= config.reminderDay
    && day <= config.reminderDay + REMINDER_CATCHUP_DAYS;
}

const isOff = (v) => v === false || v === 'false';

/** Valida y completa la configuración que manda la app. */
function normalizeEquityConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const day = Math.round(Number(c.reminderDay));
  const months = Array.isArray(c.reminderMonths)
    ? [...new Set(c.reminderMonths.map(Number).filter(m => Number.isInteger(m) && m >= 1 && m <= 12))].sort((a, b) => a - b)
    : [];
  const fractions = DEFAULT_CONFIG.fractions.map((def, i) => {
    const v = Array.isArray(c.fractions) ? c.fractions[i] : undefined;
    // Un campo vacío ("" → 0 con Number) no debe convertirse en "0% de la reserva"
    if (v === '' || v === null || v === undefined) return def;
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : def;
  });
  return {
    enabled: !isOff(c.enabled),
    reminderEnabled: !isOff(c.reminderEnabled),
    reminderDay: Number.isFinite(day) ? Math.min(28, Math.max(1, day)) : DEFAULT_CONFIG.reminderDay,
    reminderMonths: months.length ? months : [...DEFAULT_CONFIG.reminderMonths],
    fractions,
  };
}

module.exports = {
  parseYahooChart, parseFredCsv, buildSeries, levelOf, trackLevels, evaluateLatest,
  findTriggers, summarizeTriggers, isReminderDue, normalizeEquityConfig, dropOpenBar,
  THRESHOLDS, RESET_DD, EVENT_WINDOW_DAYS, DEFAULT_CONFIG,
};
