// ─── CoinMetrics Community API (gratis, sin API key) ────────────────────────
// Historia diaria de BTC desde 2010: precio y MVRV (market cap / realized cap).
const fetch = require('node-fetch');
const { normalizeDaily, WMA_DAYS } = require('./accumulationEngine');

const BASE = 'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics';
const MAX_PAGES = 5;          // ~6000 días entran en 1 página de 10000
const TIMEOUT_MS = 30000;

/**
 * @returns {Promise<{ t: string, p: number, mvrv: number|null }[]>}
 */
async function fetchBtcDailyHistory() {
  let url = `${BASE}?assets=btc&metrics=PriceUSD,CapMVRVCur&frequency=1d&start_time=2010-07-18&page_size=10000`;
  const raw = [];

  for (let page = 0; url && page < MAX_PAGES; page++) {
    const res = await fetch(url, { timeout: TIMEOUT_MS, redirect: 'error' });
    if (!res.ok) throw new Error(`CoinMetrics HTTP ${res.status}`);
    const json = await res.json();
    if (!Array.isArray(json.data)) throw new Error('CoinMetrics: respuesta sin "data"');
    raw.push(...json.data);

    const next = json.next_page_url || null;
    // Solo seguir paginando dentro de la misma API
    url = next && next.startsWith(BASE) ? next : null;
  }

  const daily = normalizeDaily(raw);
  if (daily.length < WMA_DAYS + 30) {
    throw new Error(`CoinMetrics: solo ${daily.length} días, insuficiente para la media de 200 semanas`);
  }
  return daily;
}

module.exports = { fetchBtcDailyHistory };
