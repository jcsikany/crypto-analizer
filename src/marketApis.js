// ─── Market APIs (todas gratuitas, sin API key) ─────────────────────────────
const fetch = require('node-fetch');

// Timeout global para requests
const TIMEOUT = 8000;

async function safeFetch(url, options = {}) {
  try {
    const res = await fetch(url, { timeout: TIMEOUT, ...options });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn(`[MarketAPI] Error fetching ${url}: ${err.message}`);
    return null;
  }
}

// ─── Fear & Greed Index (alternative.me) ─────────────────────────────────────
// 100% gratis, sin API key

async function fetchFearAndGreed() {
  const data = await safeFetch('https://api.alternative.me/fng/?limit=7');
  if (!data?.data?.length) return null;

  const current = data.data[0];
  const history = data.data.map(d => ({
    value: parseInt(d.value),
    label: d.value_classification,
    timestamp: parseInt(d.timestamp) * 1000,
  }));

  return {
    value: parseInt(current.value),
    label: current.value_classification,
    history,
    // Score: Fear = bullish (contrarian), Greed = bearish (contrarian)
    score: calculateFearGreedScore(parseInt(current.value)),
  };
}

function calculateFearGreedScore(value) {
  // Extreme Fear (0-15): STRONG BUY signal (contrarian)
  if (value <= 15) return 2;
  // Fear (15-30): BUY signal
  if (value <= 30) return 1.5;
  // Moderate Fear (30-40): slight bullish
  if (value <= 40) return 0.8;
  // Neutral (40-60): no signal
  if (value <= 60) return 0;
  // Greed (60-75): slight bearish
  if (value <= 75) return -0.5;
  // High Greed (75-85): SELL signal
  if (value <= 85) return -1.2;
  // Extreme Greed (85-100): STRONG SELL
  return -1.8;
}

// ─── DeFi Llama — TVL Data ───────────────────────────────────────────────────
// 100% gratis, sin API key, sin rate limit estricto

async function fetchDeFiTVL() {
  const [totalTVL, chainsTVL] = await Promise.all([
    safeFetch('https://api.llama.fi/v2/historicalChainTvl'),
    safeFetch('https://api.llama.fi/v2/chains'),
  ]);

  if (!totalTVL || !chainsTVL) return null;

  // TVL total actual y cambios
  const latest = totalTVL[totalTVL.length - 1];
  const dayAgo = totalTVL[totalTVL.length - 2];
  const weekAgo = totalTVL[Math.max(0, totalTVL.length - 8)];
  const monthAgo = totalTVL[Math.max(0, totalTVL.length - 31)];

  const currentTVL = latest?.tvl ?? 0;
  const change24h = dayAgo?.tvl ? ((currentTVL - dayAgo.tvl) / dayAgo.tvl) * 100 : 0;
  const change7d = weekAgo?.tvl ? ((currentTVL - weekAgo.tvl) / weekAgo.tvl) * 100 : 0;
  const change30d = monthAgo?.tvl ? ((currentTVL - monthAgo.tvl) / monthAgo.tvl) * 100 : 0;

  // Ethereum TVL (proxy de salud del ecosistema DeFi)
  const ethChain = chainsTVL.find(c => c.name === 'Ethereum');
  const ethTVL = ethChain?.tvl ?? 0;

  return {
    totalTVL: currentTVL,
    change24h: +change24h.toFixed(2),
    change7d: +change7d.toFixed(2),
    change30d: +change30d.toFixed(2),
    ethTVL,
    ethDominance: currentTVL > 0 ? +((ethTVL / currentTVL) * 100).toFixed(1) : 0,
    score: calculateTVLScore(change24h, change7d, change30d),
  };
}

function calculateTVLScore(d1, d7, d30) {
  let score = 0;
  // TVL creciendo = más capital en DeFi = bullish para crypto
  if (d7 > 5) score += 1.0;
  else if (d7 > 2) score += 0.5;
  else if (d7 < -5) score -= 1.0;
  else if (d7 < -2) score -= 0.5;

  if (d30 > 15) score += 0.8;
  else if (d30 > 5) score += 0.3;
  else if (d30 < -15) score -= 0.8;
  else if (d30 < -5) score -= 0.3;

  return Math.max(-2, Math.min(2, score));
}

// ─── Binance Futures — Funding Rate ──────────────────────────────────────────
// Gratis, sin API key

async function fetchFundingRate(symbol = 'BTCUSDT') {
  const data = await safeFetch(
    `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=10`
  );
  if (!data?.length) return null;

  const latest = data[data.length - 1];
  const rate = parseFloat(latest.fundingRate);
  const history = data.map(d => ({
    rate: parseFloat(d.fundingRate),
    timestamp: d.fundingTime,
  }));

  // Average funding
  const avgRate = history.reduce((s, h) => s + h.rate, 0) / history.length;

  return {
    current: rate,
    average: avgRate,
    history,
    // Funding negativo = shorts pagan = bearish sentiment = CONTRARIAN BULLISH
    // Funding muy positivo = longs pagan = bullish sentiment excesivo = CONTRARIAN BEARISH
    score: calculateFundingScore(rate, avgRate),
  };
}

function calculateFundingScore(current, avg) {
  // Negative funding: shorts are paying longs → contrarian bullish
  if (current < -0.005) return 2;     // very negative
  if (current < -0.001) return 1.2;   // negative
  if (current < 0) return 0.5;        // slightly negative

  // Excessive positive funding: longs overleveraged → contrarian bearish
  if (current > 0.005) return -1.5;   // very high
  if (current > 0.002) return -0.8;   // high
  if (current > 0.001) return -0.3;   // above normal

  return 0; // normal range
}

// ─── Binance Futures — Open Interest ─────────────────────────────────────────

async function fetchOpenInterest(symbol = 'BTCUSDT') {
  const [current, history] = await Promise.all([
    safeFetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`),
    safeFetch(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=1h&limit=48`),
  ]);

  if (!current) return null;

  const oi = parseFloat(current.openInterest);
  let change24h = 0;

  if (history?.length >= 24) {
    const oi24hAgo = parseFloat(history[0].sumOpenInterest);
    change24h = oi24hAgo > 0 ? ((oi - oi24hAgo) / oi24hAgo) * 100 : 0;
  }

  return {
    current: oi,
    change24h: +change24h.toFixed(2),
    // OI creciendo + precio subiendo = tendencia sana
    // OI creciendo + precio bajando = presión vendedora acumulándose
    // OI cayendo = desapalancamiento (puede ser sano en correcciones)
  };
}

// ─── Binance Futures — Long/Short Ratio ──────────────────────────────────────

async function fetchLongShortRatio(symbol = 'BTCUSDT') {
  const data = await safeFetch(
    `https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=24`
  );
  if (!data?.length) return null;

  const latest = data[data.length - 1];
  const ratio = parseFloat(latest.longShortRatio);
  const longAccount = parseFloat(latest.longAccount);
  const shortAccount = parseFloat(latest.shortAccount);

  // Trend del ratio
  const first = parseFloat(data[0].longShortRatio);
  const trend = first > 0 ? ((ratio - first) / first) * 100 : 0;

  return {
    ratio,
    longPct: +(longAccount * 100).toFixed(1),
    shortPct: +(shortAccount * 100).toFixed(1),
    trend24h: +trend.toFixed(2),
    // Demasiados longs = bearish contrarian, demasiados shorts = bullish contrarian
    score: calculateLSRatioScore(ratio),
  };
}

function calculateLSRatioScore(ratio) {
  // ratio > 1 = más longs que shorts
  if (ratio > 2.5) return -1.5;    // exceso de longs → contrarian bearish
  if (ratio > 1.8) return -0.8;
  if (ratio > 1.3) return -0.3;
  if (ratio < 0.5) return 1.5;     // exceso de shorts → contrarian bullish
  if (ratio < 0.7) return 0.8;
  if (ratio < 0.85) return 0.3;
  return 0;
}

// ─── Binance — Liquidations proxy (via top trader positions) ─────────────────

async function fetchTopTraderPositions(symbol = 'BTCUSDT') {
  const data = await safeFetch(
    `https://fapi.binance.com/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=1h&limit=24`
  );
  if (!data?.length) return null;

  const latest = data[data.length - 1];
  const longPct = parseFloat(latest.longAccount);
  const shortPct = parseFloat(latest.shortAccount);

  return {
    longPct: +(longPct * 100).toFixed(1),
    shortPct: +(shortPct * 100).toFixed(1),
    ratio: parseFloat(latest.longShortRatio),
  };
}

// ─── Bitcoin On-Chain (blockchain.com /stats) ────────────────────────────────
// Gratis, sin API key — endpoint único que devuelve todo

async function fetchOnChainBasic() {
  const data = await safeFetch('https://api.blockchain.info/stats');
  if (!data) return null;

  const hashRate = data.hash_rate ?? null;          // TH/s
  const difficulty = data.difficulty ?? null;
  const txCount24h = data.n_tx ?? null;
  const blocksMined = data.n_blocks_mined ?? null;
  const minutesBetweenBlocks = data.minutes_between_blocks ?? null;

  return {
    hashrate: hashRate,
    difficulty,
    txCount24h,
    blocksMined,
    minutesBetweenBlocks,
    marketPrice: data.market_price_usd ?? null,
    score: calculateOnChainScore(txCount24h, minutesBetweenBlocks),
  };
}

function calculateOnChainScore(txCount, blockTime) {
  let score = 0;
  // Alta actividad on-chain = bullish
  if (txCount > 300000) score += 0.5;
  else if (txCount > 200000) score += 0.3;
  else if (txCount && txCount < 100000) score -= 0.3;
  // Bloques rápidos = hashrate sano
  if (blockTime && blockTime < 9.5) score += 0.2;
  else if (blockTime && blockTime > 11) score -= 0.2;
  return Math.max(-1, Math.min(1, score));
}

// ─── Mempool.space (Bitcoin network congestion) ──────────────────────────────

async function fetchMempoolData() {
  const [fees, mempool] = await Promise.all([
    safeFetch('https://mempool.space/api/v1/fees/recommended'),
    safeFetch('https://mempool.space/api/mempool'),
  ]);

  if (!fees) return null;

  return {
    fastestFee: fees.fastestFee,
    halfHourFee: fees.halfHourFee,
    hourFee: fees.hourFee,
    mempoolSize: mempool?.count ?? null,
    mempoolVSize: mempool?.vsize ?? null,
    // Fees altas = mucha demanda de espacio en bloque = actividad alta = bullish
    score: calculateMempoolScore(fees.fastestFee),
  };
}

function calculateMempoolScore(fastestFee) {
  if (fastestFee > 100) return 0.8;   // fees muy altas = mucha demanda
  if (fastestFee > 50) return 0.5;
  if (fastestFee > 20) return 0.2;
  if (fastestFee < 3) return -0.3;    // fees muy bajas = poca actividad
  return 0;
}

// ─── CoinGecko — Global Market Data ─────────────────────────────────────────
// Gratis, sin API key (con rate limit)

async function fetchGlobalMarket() {
  const data = await safeFetch('https://api.coingecko.com/api/v3/global');
  if (!data?.data) return null;

  const d = data.data;
  return {
    totalMarketCap: d.total_market_cap?.usd ?? 0,
    totalVolume24h: d.total_volume?.usd ?? 0,
    btcDominance: +(d.market_cap_percentage?.btc ?? 0).toFixed(1),
    ethDominance: +(d.market_cap_percentage?.eth ?? 0).toFixed(1),
    marketCapChange24h: +(d.market_cap_change_percentage_24h_usd ?? 0).toFixed(2),
    activeCryptos: d.active_cryptocurrencies ?? 0,
  };
}

// ─── Aggregator: Fetch all fundamental data ──────────────────────────────────

async function fetchAllFundamentals(asset = 'BTC') {
  const symbol = `${asset}USDT`;
  const isBTC = asset === 'BTC';

  // Ejecutar todas las APIs en paralelo
  const results = await Promise.allSettled([
    fetchFearAndGreed(),
    fetchDeFiTVL(),
    fetchFundingRate(symbol),
    fetchOpenInterest(symbol),
    fetchLongShortRatio(symbol),
    fetchTopTraderPositions(symbol),
    isBTC ? fetchOnChainBasic() : Promise.resolve(null),
    isBTC ? fetchMempoolData() : Promise.resolve(null),
    fetchGlobalMarket(),
  ]);

  const get = (i) => results[i]?.status === 'fulfilled' ? results[i].value : null;

  const fundamentals = {
    fearGreed:     get(0),
    defiTVL:       get(1),
    funding:       get(2),
    openInterest:  get(3),
    longShortRatio: get(4),
    topTraders:    get(5),
    onChain:       get(6),
    mempool:       get(7),
    globalMarket:  get(8),
  };

  // Calcular score fundamental compuesto
  fundamentals.compositeScore = calculateCompositeFundamentalScore(fundamentals);

  return fundamentals;
}

function calculateCompositeFundamentalScore(f) {
  const scores = [];
  const weights = [];

  // Fear & Greed — peso alto (señal contrarian muy probada)
  if (f.fearGreed?.score !== undefined) {
    scores.push(f.fearGreed.score);
    weights.push(0.30);
  }

  // Funding rate — peso medio-alto (refleja sentimiento del mercado de futuros)
  if (f.funding?.score !== undefined) {
    scores.push(f.funding.score);
    weights.push(0.25);
  }

  // Long/Short ratio — peso medio
  if (f.longShortRatio?.score !== undefined) {
    scores.push(f.longShortRatio.score);
    weights.push(0.20);
  }

  // DeFi TVL — peso medio-bajo
  if (f.defiTVL?.score !== undefined) {
    scores.push(f.defiTVL.score);
    weights.push(0.10);
  }

  // On-chain
  if (f.onChain?.score !== undefined) {
    scores.push(f.onChain.score);
    weights.push(0.08);
  }

  // Mempool
  if (f.mempool?.score !== undefined) {
    scores.push(f.mempool.score);
    weights.push(0.07);
  }

  if (scores.length === 0) return 0;

  const totalW = weights.reduce((a, b) => a + b, 0);
  const weighted = scores.reduce((acc, s, i) => acc + s * weights[i], 0);
  return totalW > 0 ? +(weighted / totalW).toFixed(3) : 0;
}

module.exports = {
  fetchFearAndGreed,
  fetchDeFiTVL,
  fetchFundingRate,
  fetchOpenInterest,
  fetchLongShortRatio,
  fetchTopTraderPositions,
  fetchOnChainBasic,
  fetchMempoolData,
  fetchGlobalMarket,
  fetchAllFundamentals,
};
