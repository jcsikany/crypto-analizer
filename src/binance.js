// ─── KuCoin API (sin restricciones geo) ──────────────────────────────────
const fetch = require('node-fetch');
const { klineTimeRange } = require('./klineWindow');

const BASE = 'https://api.kucoin.com/api/v1';

// 300 velas: EMA200 necesita 200 para arrancar y ~100 más para estabilizarse
const CANDLES_PER_TF = 300;

async function fetchKlines(symbol, interval, limit = CANDLES_PER_TF) {
  const kuSymbol = symbol.replace('USDT', '-USDT'); // BTCUSDT → BTC-USDT
  const { type, startAt, endAt } = klineTimeRange(interval, limit);
  const url = `${BASE}/market/candles?type=${type}&symbol=${kuSymbol}&startAt=${startAt}&endAt=${endAt}`;

  const res = await fetch(url, { timeout: 10000 });
  if (!res.ok) throw new Error(`KuCoin klines ${res.status}`);
  const json = await res.json();
  if (json.code !== '200000') throw new Error(`KuCoin error: ${json.msg}`);

  // KuCoin devuelve: [time, open, close, high, low, volume, turnover]
  // Orden: más reciente primero — invertir y limitar
  const candles = (json.data || [])
    .slice(0, limit)
    .reverse()
    .map(k => ({
      time:   parseInt(k[0]) * 1000,
      open:   parseFloat(k[1]),
      close:  parseFloat(k[2]),
      high:   parseFloat(k[3]),
      low:    parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));

  if (candles.length < 200) {
    console.warn(`[KuCoin] ${symbol} ${interval}: solo ${candles.length} velas (EMA200 no disponible)`);
  }
  return candles;
}

async function fetchTicker(symbol) {
  const kuSymbol = symbol.replace('USDT', '-USDT');
  const url = `${BASE}/market/stats?symbol=${kuSymbol}`;

  const res = await fetch(url, { timeout: 10000 });
  if (!res.ok) throw new Error(`KuCoin ticker ${res.status}`);
  const json = await res.json();
  if (json.code !== '200000') throw new Error(`KuCoin ticker error: ${json.msg}`);

  const d = json.data;
  return {
    price:     parseFloat(d.last),
    changePct: parseFloat(d.changeRate) * 100,
    high24h:   parseFloat(d.high),
    low24h:    parseFloat(d.low),
    volume24h: parseFloat(d.volValue),
  };
}

async function fetchAllKlines(symbol) {
  const [k15m, k1h, k4h, k1d] = await Promise.all([
    fetchKlines(symbol, '15m'),
    fetchKlines(symbol, '1h'),
    fetchKlines(symbol, '4h'),
    fetchKlines(symbol, '1d'),
  ]);
  return { '15m': k15m, '1h': k1h, '4h': k4h, '1d': k1d };
}

module.exports = { fetchKlines, fetchTicker, fetchAllKlines };
