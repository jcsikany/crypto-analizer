// ─── Ventana de tiempo para pedir velas a KuCoin ────────────────────────────
// Sin startAt/endAt, KuCoin devuelve solo las últimas 100 velas, sin importar
// cuántas pidas. Con un rango explícito devuelve hasta 1500.

const KUCOIN_MAX_CANDLES = 1500;

const KUCOIN_INTERVALS = {
  '15m': { type: '15min', seconds: 900 },
  '1h':  { type: '1hour', seconds: 3_600 },
  '4h':  { type: '4hour', seconds: 14_400 },
  '1d':  { type: '1day',  seconds: 86_400 },
};

/**
 * Rango [startAt, endAt] (en segundos) que cubre `count` velas del timeframe.
 * Se pide una vela de margen porque KuCoin no incluye el borde inicial.
 * @param {'15m'|'1h'|'4h'|'1d'} tf
 * @param {number} count
 * @param {number} [nowSec]
 * @returns {{ type: string, startAt: number, endAt: number }}
 */
function klineTimeRange(tf, count, nowSec = Math.floor(Date.now() / 1000)) {
  const interval = KUCOIN_INTERVALS[tf];
  if (!interval) throw new Error(`Timeframe no soportado: ${tf}`);
  if (!Number.isInteger(count) || count < 1 || count >= KUCOIN_MAX_CANDLES) {
    throw new Error(`count inválido: ${count} (1..${KUCOIN_MAX_CANDLES - 1})`);
  }
  return {
    type: interval.type,
    startAt: nowSec - (count + 1) * interval.seconds,
    endAt: nowSec,
  };
}

module.exports = { klineTimeRange, KUCOIN_INTERVALS, KUCOIN_MAX_CANDLES };
