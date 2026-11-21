// ─── Accumulation Service — corre una vez por día ───────────────────────────
// Baja la historia, recalcula zonas, guarda el estado en memoria y notifica.
const { fetchBtcDailyHistory } = require('./coinMetrics');
const {
  computeSeries, classifyZones, evaluateLatest, findEpisodes, summarizeStats, countDateGaps,
} = require('./accumulationEngine');
const { buildAccumulationAlert } = require('./accumulationMessages');
const { getAllDevices } = require('./database');
const { sendAccumulationAlert } = require('./pushSender');

const HISTORY_DAYS = 4 * 365;   // gráfico de la app: últimos 4 años
const HISTORY_STEP_DAYS = 7;    // un punto por semana
const EPISODES_FROM = '2014-01-01';
const MAX_ATTEMPTS = 3;                  // si falla o los datos están viejos
const RETRY_DELAY_MS = 30 * 60 * 1000;   // reintentar a los 30 minutos

let state = null;

function weeklyHistory(zoned) {
  const recent = zoned.slice(-HISTORY_DAYS);
  return recent
    .filter((_, i) => (recent.length - 1 - i) % HISTORY_STEP_DAYS === 0)
    .map(r => ({
      t: r.t,
      p: Math.round(r.p),
      wma200: r.wma200 ? Math.round(r.wma200) : null,
      realizedPrice: r.realizedPrice ? Math.round(r.realizedPrice) : null,
      zone: r.zone,
    }));
}

function scheduleRetry(attempt, reason) {
  if (attempt >= MAX_ATTEMPTS) {
    console.error(`[Acumulación] ${reason} — sin más reintentos hoy`);
    return;
  }
  console.warn(`[Acumulación] ${reason} — reintento ${attempt + 1}/${MAX_ATTEMPTS} en 30 min`);
  setTimeout(() => runAccumulation(attempt + 1), RETRY_DELAY_MS);
}

async function runAccumulation(attempt = 1) {
  try {
    const daily = await fetchBtcDailyHistory();
    const gaps = countDateGaps(daily);
    if (gaps > 0) console.warn(`[Acumulación] La serie tiene ${gaps} días faltantes; las medias pueden desviarse`);
    const zoned = classifyZones(computeSeries(daily));
    const evaluation = evaluateLatest(zoned);
    if (!evaluation) throw new Error('sin datos suficientes para clasificar zonas');

    state = {
      evaluation,
      stats: summarizeStats(zoned),
      episodes: findEpisodes(zoned).filter(e => e.start >= EPISODES_FROM),
      history: weeklyHistory(zoned),
      updatedAt: new Date().toISOString(),
    };

    const m = evaluation.metrics;
    console.log(
      `[Acumulación] ${evaluation.asOf} | zona ${evaluation.zone}` +
      (evaluation.event ? ` ◄ ${evaluation.event} (${evaluation.eventDate})` : '') +
      ` | precio/200WMA ${m.priceToWma?.toFixed(2)} | MVRV ${m.mvrv?.toFixed(2)}` +
      (evaluation.zoneSince ? ` | en zona desde ${evaluation.zoneSince}` : '') +
      (evaluation.isStale ? ' | ⚠ datos viejos' : '')
    );

    const alert = buildAccumulationAlert(evaluation);
    if (alert) await sendAccumulationAlert(getAllDevices(), alert, evaluation);
    if (evaluation.isStale) scheduleRetry(attempt, `Datos viejos (último día ${evaluation.asOf})`);
  } catch (err) {
    // Se conserva el último estado bueno; la app sigue mostrando eso
    scheduleRetry(attempt, `Error: ${err.message}`);
  }
}

function getAccumulationState() {
  return state;
}

module.exports = { runAccumulation, getAccumulationState };
