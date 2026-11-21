// Generadores de velas sintéticas para tests.

/**
 * Tendencia sostenida: cada vela sube (o baja) `stepPct` con una leve oscilación.
 * @param {number} count
 * @param {number} stepPct  ej. 0.01 = +1% por vela, -0.01 = -1%
 */
function trendingCandles(count, stepPct) {
  const candles = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const open = price;
    const wiggle = (i % 3 === 0 ? -0.3 : 0.15) * Math.abs(stepPct);
    const close = open * (1 + stepPct + wiggle);
    const high = Math.max(open, close) * 1.002;
    const low = Math.min(open, close) * 0.998;
    candles.push({ time: i * 3600_000, open, high, low, close, volume: 1000 + (i % 5) * 50 });
    price = close;
  }
  return candles;
}

module.exports = { trendingCandles };
