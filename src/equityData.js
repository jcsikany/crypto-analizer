// ─── Datos del S&P 500 / CSPX (gratis, sin API key) ─────────────────────────
// SPY con dividendos reinvertidos (proxy de CSPX, que es acumulativo) y VIX
// desde Yahoo; si el VIX de Yahoo falla, se usa el de FRED (1 día de atraso).
// CSPX (Londres, USD) se baja solo para mostrar su precio.
const fetch = require('node-fetch');
const { parseYahooChart, parseFredCsv } = require('./equityEngine');

const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const FRED_VIX = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=VIXCLS';
const HEADERS = { 'User-Agent': 'Mozilla/5.0' };
const TIMEOUT_MS = 20000;
const VIX_FROM = 631152000;       // 1990-01-01
const MIN_SPY_DAYS = 2000;

async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS, timeout: TIMEOUT_MS });
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url.split('?')[0]}`);
  return res.json();
}

function yahooUrl(symbol, period1) {
  const now = Math.floor(Date.now() / 1000);
  return `${YAHOO}${encodeURIComponent(symbol)}?period1=${period1}&period2=${now}&interval=1d&includeAdjustedClose=true`;
}

async function fetchVix() {
  try {
    const rows = parseYahooChart(await fetchJson(yahooUrl('^VIX', VIX_FROM)));
    return { vixByDate: new Map(rows.map(r => [r.t, r.p])), vixSource: 'yahoo' };
  } catch (err) {
    console.warn(`[S&P] VIX de Yahoo falló (${err.message}); uso FRED`);
    const res = await fetch(FRED_VIX, { timeout: TIMEOUT_MS });
    if (!res.ok) throw new Error(`FRED HTTP ${res.status}`);
    return { vixByDate: parseFredCsv(await res.text()), vixSource: 'fred' };
  }
}

async function fetchCspx() {
  try {
    const json = await fetchJson(yahooUrl('CSPX.L', Math.floor(Date.now() / 1000) - 30 * 86400));
    const rows = parseYahooChart(json);
    const meta = json.chart.result[0].meta || {};
    const last = rows[rows.length - 1];
    return {
      price: Number.isFinite(meta.regularMarketPrice) ? meta.regularMarketPrice : last?.p ?? null,
      asOf: last?.t ?? null,
    };
  } catch (err) {
    console.warn(`[S&P] Precio de CSPX no disponible: ${err.message}`);
    return null;
  }
}

/**
 * @returns {Promise<{ spy: {t,p}[], vixByDate: Map, vixSource: string, cspx: {price, asOf}|null }>}
 */
async function fetchEquityData() {
  const [spyJson, vixResult, cspx] = await Promise.all([
    fetchJson(yahooUrl('SPY', 0)),
    fetchVix().catch(err => {
      console.warn(`[S&P] Sin VIX (${err.message}); los niveles usan solo la caída`);
      return { vixByDate: new Map(), vixSource: 'ninguna' };
    }),
    fetchCspx(),
  ]);
  const spy = parseYahooChart(spyJson, { adjusted: true });
  if (spy.length < MIN_SPY_DAYS) throw new Error(`Yahoo: solo ${spy.length} días de SPY`);
  return { spy, ...vixResult, cspx };
}

module.exports = { fetchEquityData };
