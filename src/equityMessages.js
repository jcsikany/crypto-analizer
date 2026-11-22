// ─── Textos de las alertas del S&P 500 / CSPX ───────────────────────────────

const DAY_MINUTES = 24 * 60;
const LEVEL_COOLDOWN_MINUTES = 30 * DAY_MINUTES; // respaldo: el rearme ya evita repetir
const DCA_COOLDOWN_MINUTES = 20 * DAY_MINUTES;

const LEVEL_TITLES = {
  1: '🟡 S&P 500: oportunidad',
  2: '🟢 S&P 500: oportunidad fuerte',
  3: '🟣 S&P 500: oportunidad extrema',
};
const LEVEL_NAMES = { 1: 'oportunidad', 2: 'oportunidad fuerte', 3: 'oportunidad extrema' };

const usd = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
const pct = (x) => `${x >= 0 ? '+' : ''}${Math.round(x * 100)}%`;

function marketLine(ev) {
  const parts = [`Caída desde máximo ${pct(ev.dd)}`];
  if (Number.isFinite(ev.vix)) parts.push(`VIX ${ev.vix.toFixed(1)}`);
  if (Number.isFinite(ev.price)) parts.push(`SPY ${usd(ev.price)}`);
  if (Number.isFinite(ev.cspxPrice)) parts.push(`CSPX ${usd(ev.cspxPrice)}`);
  return parts.join(' | ');
}

function ruleLine(levels, fractions) {
  // El nivel 1 es sobre la reserva completa; 2 y 3, sobre lo que quede
  const steps = levels.map(l => `${fractions[l - 1]}% ${l === 1 ? 'de la reserva' : 'de lo que quede'}`);
  return `Según tu regla: ${steps.join(', luego ')}.`;
}

/**
 * Alerta por nivel nuevo, o null si no hay evento o los datos están viejos.
 * @param {object} ev  resultado de evaluateLatest (+ cspxPrice opcional)
 * @param {number[]} fractions  % de la reserva por nivel, de la config del usuario
 */
function buildEquityLevelAlert(ev, fractions) {
  if (!ev || ev.isStale || !ev.event) return null;
  const { level, levels } = ev.event;
  return {
    alertType: `EQ_L${level}`,
    title: LEVEL_TITLES[level],
    body: `${marketLine(ev)}\n${ruleLine(levels, fractions)}`,
    cooldownMinutes: LEVEL_COOLDOWN_MINUTES,
  };
}

/** Recordatorio de la compra fija trimestral, con el estado del mercado si se conoce. */
function buildDcaReminder(ev) {
  let body = 'Recordatorio de tu compra fija.';
  if (ev && !ev.isStale) {
    body = ev.level > 0
      ? `Además hay una ${LEVEL_NAMES[ev.level]} activa.\n${marketLine(ev)}`
      : `Mercado tranquilo: ${marketLine(ev)}`;
  }
  return {
    alertType: 'EQ_DCA',
    title: '⏰ Compra trimestral de CSPX',
    body,
    cooldownMinutes: DCA_COOLDOWN_MINUTES,
  };
}

module.exports = { buildEquityLevelAlert, buildDcaReminder };
