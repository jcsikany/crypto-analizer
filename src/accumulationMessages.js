// ─── Textos de las alertas de acumulación de largo plazo ────────────────────

const DAY_MINUTES = 24 * 60;
const EVENT_COOLDOWN_MINUTES = 60 * DAY_MINUTES;    // no repetir entradas cercanas
const REMINDER_COOLDOWN_MINUTES = 25 * DAY_MINUTES;

const usd = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
const signedPct = (ratio) => {
  const pct = Math.round((ratio - 1) * 100);
  return `${pct >= 0 ? '+' : ''}${pct}%`;
};

function metricLines(m) {
  const lines = [];
  if (m.wma200) {
    lines.push(`Precio ${usd(m.p)} | Media 200 semanas ${usd(m.wma200)} (${signedPct(m.p / m.wma200)})`);
  }
  if (m.mvrv) {
    const realized = m.realizedPrice ? ` | Precio realizado ${usd(m.realizedPrice)}` : '';
    lines.push(`MVRV ${m.mvrv.toFixed(2)}${realized}`);
  }
  return lines.join('\n');
}

/**
 * Arma la alerta push a partir de evaluateLatest(), o null si no corresponde.
 * @returns {{ alertType: string, title: string, body: string, cooldownMinutes: number } | null}
 */
function buildAccumulationAlert(evaluation) {
  if (!evaluation || evaluation.isStale) return null;
  const { event, zone, daysInZone, reminderDue, metrics } = evaluation;
  const facts = metricLines(metrics);

  if ((event === 'ENTER' || event === 'UPGRADE') && zone === 'EXTREME') {
    return {
      alertType: 'LT_EXTREME',
      title: '🟣 BTC: zona EXTREMA de acumulación',
      body: `Precio debajo de la media de 200 semanas y MVRV < 1 a la vez.\n${facts}`,
      cooldownMinutes: EVENT_COOLDOWN_MINUTES,
    };
  }
  if (event === 'ENTER') {
    return {
      alertType: 'LT_ENTER',
      title: '🟠 BTC entró en zona de valor (largo plazo)',
      body: `Zona que históricamente marcó pisos de ciclo. No es garantía.\n${facts}`,
      cooldownMinutes: EVENT_COOLDOWN_MINUTES,
    };
  }
  if (event === 'EXIT') {
    return {
      alertType: 'LT_EXIT',
      title: '⚪ BTC salió de la zona de valor',
      body: facts,
      cooldownMinutes: EVENT_COOLDOWN_MINUTES,
    };
  }
  // Recordatorio: si no hubo evento que avisar (una bajada EXTREMA→VALOR no avisa)
  if (reminderDue && (event === null || event === 'DOWNGRADE')) {
    return {
      alertType: 'LT_REMINDER',
      title: `🔔 BTC sigue en zona ${zone === 'EXTREME' ? 'extrema' : 'de valor'}`,
      body: `Lleva ${daysInZone} días en zona.\n${facts}`,
      cooldownMinutes: REMINDER_COOLDOWN_MINUTES,
    };
  }
  return null;
}

module.exports = { buildAccumulationAlert };
