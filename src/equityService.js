// ─── Equity Service — S&P 500 / CSPX ─────────────────────────────────────────
// runEquity: después del cierre de EE.UU. recalcula niveles y avisa si hay uno nuevo.
// runEquityReminders: una vez por día manda el recordatorio de la compra trimestral
// a quien le toque según su configuración.
const { fetchEquityData } = require('./equityData');
const {
  buildSeries, trackLevels, evaluateLatest, findTriggers, summarizeTriggers, isReminderDue, dropOpenBar,
} = require('./equityEngine');
const { buildEquityLevelAlert, buildDcaReminder } = require('./equityMessages');
const { getAllDevices } = require('./database');
const { sendEquityNotifications } = require('./pushSender');

const TRIGGERS_FROM = '1994-01-01';
const HISTORY_DAYS = 4 * 365;
const HISTORY_STEP = 5;                  // ~1 punto por semana de mercado
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 30 * 60 * 1000;

let state = null;
let running = false; // evita corridas superpuestas (cron + arranque + reintentos)

function weeklyHistory(tracked) {
  const cutoff = new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString().slice(0, 10);
  const recent = tracked.filter(r => r.t >= cutoff);
  return recent
    .filter((_, i) => (recent.length - 1 - i) % HISTORY_STEP === 0)
    .map(r => ({ t: r.t, p: +r.p.toFixed(2), dd: +r.dd.toFixed(4), level: r.level }));
}

function scheduleRetry(attempt, reason) {
  if (attempt >= MAX_ATTEMPTS) {
    console.error(`[S&P] ${reason} — sin más reintentos`);
    return;
  }
  console.warn(`[S&P] ${reason} — reintento ${attempt + 1}/${MAX_ATTEMPTS} en 30 min`);
  setTimeout(() => runEquity(attempt + 1), RETRY_DELAY_MS);
}

async function runEquity(attempt = 1) {
  if (running) {
    console.warn('[S&P] Ya hay una corrida en curso; se omite esta');
    return;
  }
  running = true;
  try {
    const { spy, vixByDate, vixSource, cspx } = await fetchEquityData();
    const tracked = trackLevels(buildSeries(dropOpenBar(spy), vixByDate));
    const evaluation = { ...evaluateLatest(tracked), cspxPrice: cspx?.price ?? null, cspxAsOf: cspx?.asOf ?? null };
    const triggers = findTriggers(tracked).filter(t => t.t >= TRIGGERS_FROM);

    state = {
      evaluation,
      triggers,
      summary: summarizeTriggers(triggers),
      history: weeklyHistory(tracked),
      vixSource,
      updatedAt: new Date().toISOString(),
    };

    console.log(
      `[S&P] ${evaluation.asOf} | nivel ${evaluation.level}` +
      (evaluation.event ? ` ◄ nuevo nivel ${evaluation.event.level} (${evaluation.event.date})` : '') +
      ` | caída ${(evaluation.dd * 100).toFixed(1)}% | VIX ${evaluation.vix?.toFixed(1) ?? '?'} (${vixSource})` +
      ` | SPY ${evaluation.price.toFixed(2)} | CSPX ${evaluation.cspxPrice ?? '?'}` +
      (evaluation.isStale ? ' | ⚠ datos viejos' : '')
    );

    if (evaluation.event && !evaluation.isStale) {
      await sendEquityNotifications(getAllDevices(), (cfg) => buildEquityLevelAlert(evaluation, cfg.fractions), evaluation);
    }
    if (evaluation.isStale) scheduleRetry(attempt, `Datos viejos (último día ${evaluation.asOf})`);
  } catch (err) {
    scheduleRetry(attempt, `Error: ${err.message}`);
  } finally {
    running = false;
  }
}

async function runEquityReminders(todayIso = new Date().toISOString().slice(0, 10)) {
  try {
    const evaluation = state?.evaluation ?? null;
    await sendEquityNotifications(
      getAllDevices(),
      (cfg) => (isReminderDue(cfg, todayIso) ? buildDcaReminder(evaluation) : null),
      evaluation,
    );
  } catch (err) {
    console.error('[S&P] Error en recordatorios:', err.message);
  }
}

function getEquityState() {
  return state;
}

module.exports = { runEquity, runEquityReminders, getEquityState };
