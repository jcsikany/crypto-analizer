// ─── Accumulation Engine — zonas de acumulación de largo plazo (BTC) ─────────
// Señales de ciclo, pensadas para comprar cada 3–12 meses, no para trading.
//
//   Condición A: precio < media de 200 semanas (1400 días)
//   Condición B: MVRV < 1  (precio < precio realizado = costo promedio on-chain)
//
//   VALUE   = A o B        EXTREME = A y B
//
// Histéresis: la zona se activa apenas se cumple una condición, pero solo se
// desactiva cuando la condición se recuperó con un margen (EXIT_MARGIN). Sin
// margen, la zona "parpadeaba": 43 entradas desde 2014 contra 14 con 10%.
//
// Todo es puro (sin red ni base de datos) y se recalcula desde la historia
// completa cada día, así un reinicio del servidor no inventa eventos.

const WMA_DAYS = 1400;            // 200 semanas
const MAYER_DAYS = 200;
const EXIT_MARGIN = 0.10;
const REMINDER_EVERY_DAYS = 30;
const REMINDER_TOLERANCE_DAYS = 2;  // si una corrida falla, el recordatorio sale igual
const EVENT_WINDOW_DAYS = 7;        // un evento se sigue reportando esta cantidad de días
const STALE_AFTER_DAYS = 3;         // datos más viejos que esto no se notifican
const FORWARD_DAYS = [180, 365];

const DAY_MS = 86_400_000;
const ZONES = ['NONE', 'VALUE', 'EXTREME'];
const zoneLevel = (zone) => ZONES.indexOf(zone);

const addDays = (isoDate, days) =>
  new Date(Date.parse(isoDate) + days * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);
const positiveOrNull = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/**
 * Filas crudas de CoinMetrics → [{ t: 'YYYY-MM-DD', p, mvrv }] ordenadas.
 * Descarta filas sin precio válido; MVRV inválido queda en null.
 * @param {{ time: string, PriceUSD?: string, CapMVRVCur?: string }[]} rawRows
 */
function normalizeDaily(rawRows) {
  return (rawRows || [])
    .map(r => ({
      t: String(r.time || '').slice(0, 10),
      p: positiveOrNull(r.PriceUSD),
      mvrv: positiveOrNull(r.CapMVRVCur),
    }))
    .filter(r => r.p !== null && /^\d{4}-\d{2}-\d{2}$/.test(r.t))
    .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
}

/**
 * Días faltantes en la serie. Las medias usan ventanas por cantidad de filas,
 * así que un hueco haría que "1400 días" abarquen más tiempo calendario.
 * @param {{ t: string }[]} daily
 */
function countDateGaps(daily) {
  let gaps = 0;
  for (let i = 1; i < daily.length; i++) {
    gaps += Math.max(0, daysBetween(daily[i - 1].t, daily[i].t) - 1);
  }
  return gaps;
}

/**
 * Agrega medias móviles y métricas derivadas a la serie diaria.
 * @param {{ t: string, p: number, mvrv: number|null }[]} daily
 */
function computeSeries(daily) {
  let sumWma = 0;
  let sumMayer = 0;
  return daily.map((r, i) => {
    sumWma += r.p;
    sumMayer += r.p;
    if (i >= WMA_DAYS) sumWma -= daily[i - WMA_DAYS].p;
    if (i >= MAYER_DAYS) sumMayer -= daily[i - MAYER_DAYS].p;
    const wma200 = i >= WMA_DAYS - 1 ? sumWma / WMA_DAYS : null;
    const ma200 = i >= MAYER_DAYS - 1 ? sumMayer / MAYER_DAYS : null;
    return {
      ...r,
      wma200,
      mayer: ma200 ? r.p / ma200 : null,
      realizedPrice: r.mvrv ? r.p / r.mvrv : null,
      priceToWma: wma200 ? r.p / wma200 : null,
    };
  });
}

/**
 * Asigna la zona de cada día con histéresis. Días sin métricas → zone null.
 * @param {{ p: number, wma200: number|null, mvrv: number|null }[]} series
 * @param {{ exitMargin?: number }} [options]
 */
function classifyZones(series, { exitMargin = EXIT_MARGIN } = {}) {
  let level = 0;
  return series.map(r => {
    if (r.wma200 == null || r.mvrv == null) return { ...r, zone: null };
    const active = (r.p < r.wma200 ? 1 : 0) + (r.mvrv < 1 ? 1 : 0);
    const notRecovered = (r.p <= r.wma200 * (1 + exitMargin) ? 1 : 0)
                       + (r.mvrv <= 1 + exitMargin ? 1 : 0);
    level = Math.max(active, Math.min(level, notRecovered));
    return { ...r, zone: ZONES[level] };
  });
}

function eventBetween(previousZone, zone) {
  if (previousZone === null) return null;
  const from = zoneLevel(previousZone);
  const to = zoneLevel(zone);
  if (to > from) return from === 0 ? 'ENTER' : 'UPGRADE';
  if (to < from) return to === 0 ? 'EXIT' : 'DOWNGRADE';
  return null;
}

/**
 * Cambio de zona más reciente dentro de los últimos EVENT_WINDOW_DAYS.
 * La ventana evita perder un evento si la corrida de ese día falló o
 * CoinMetrics publicó tarde; el cooldown de alert_log evita repetirlo.
 */
function latestEvent(valid) {
  const last = valid[valid.length - 1];
  for (let k = valid.length - 1; k >= 1; k--) {
    if (daysBetween(valid[k].t, last.t) >= EVENT_WINDOW_DAYS) break;
    const event = eventBetween(valid[k - 1].zone, valid[k].zone);
    if (event) return { event, eventDate: valid[k].t, previousZone: valid[k - 1].zone };
  }
  return { event: null, eventDate: null, previousZone: valid.length > 1 ? valid[valid.length - 2].zone : null };
}

/**
 * Estado del último día con datos: zona, evento reciente y recordatorio.
 * @param {{ t: string, zone: string|null }[]} zoned
 * @param {number} [nowMs]
 */
function evaluateLatest(zoned, nowMs = Date.now()) {
  const valid = zoned.filter(r => r.zone !== null);
  if (valid.length === 0) return null;
  const last = valid[valid.length - 1];
  const { event, eventDate, previousZone } = latestEvent(valid);

  let zoneSince = null;
  if (last.zone !== 'NONE') {
    let k = valid.length - 1;
    while (k > 0 && valid[k - 1].zone !== 'NONE') k--;
    zoneSince = valid[k].t;
  }
  const daysInZone = zoneSince ? daysBetween(zoneSince, last.t) : 0;

  return {
    asOf: last.t,
    zone: last.zone,
    previousZone,
    event,
    eventDate,
    zoneSince,
    daysInZone,
    reminderDue: last.zone !== 'NONE'
      && daysInZone >= REMINDER_EVERY_DAYS
      && daysInZone % REMINDER_EVERY_DAYS <= REMINDER_TOLERANCE_DAYS,
    isStale: nowMs - Date.parse(last.t) > STALE_AFTER_DAYS * DAY_MS,
    metrics: {
      p: last.p,
      wma200: last.wma200,
      mvrv: last.mvrv,
      mayer: last.mayer ?? null,
      realizedPrice: last.realizedPrice ?? null,
      priceToWma: last.priceToWma ?? (last.wma200 ? last.p / last.wma200 : null),
    },
  };
}

function priceIndex(zoned) {
  return new Map(zoned.map(r => [r.t, r.p]));
}

function forwardReturn(prices, t, days) {
  const future = prices.get(addDays(t, days));
  const now = prices.get(t);
  return future && now ? future / now - 1 : null;
}

/**
 * Episodios contiguos en zona (VALUE o EXTREME).
 * return365 = retorno a 365 días desde el primer día del episodio.
 */
function findEpisodes(zoned) {
  const prices = priceIndex(zoned);
  const episodes = [];
  let current = null;
  for (const r of zoned) {
    if (r.zone === null) continue; // día sin métricas: no corta el episodio
    const inZone = r.zone === 'VALUE' || r.zone === 'EXTREME';
    if (inZone && !current) {
      current = { start: r.t, end: r.t, days: 0, maxZone: r.zone, startPrice: r.p, minPrice: r.p };
    }
    if (inZone) {
      current = {
        ...current,
        end: r.t,
        days: current.days + 1,
        maxZone: zoneLevel(r.zone) > zoneLevel(current.maxZone) ? r.zone : current.maxZone,
        minPrice: Math.min(current.minPrice, r.p),
      };
    } else if (current) {
      episodes.push(current);
      current = null;
    }
  }
  if (current) episodes.push({ ...current, ongoing: true });
  return episodes.map(e => ({
    ...e,
    ongoing: !!e.ongoing,
    return365: forwardReturn(prices, e.start, 365),
  }));
}

function statsFor(rows, zoned, prices) {
  const forward = Object.fromEntries(FORWARD_DAYS.map(d => [
    d, rows.map(r => forwardReturn(prices, r.t, d)).filter(x => x !== null),
  ]));
  const r365 = forward[365];
  const indexByDate = new Map(zoned.map((r, i) => [r.t, i]));
  const drawdowns = rows
    .filter(r => forwardReturn(prices, r.t, 365) !== null)
    .map(r => {
      const i = indexByDate.get(r.t);
      let min = r.p;
      for (let k = i; k < zoned.length && daysBetween(r.t, zoned[k].t) <= 365; k++) {
        min = Math.min(min, zoned[k].p);
      }
      return min / r.p - 1;
    });
  return {
    days: rows.length,
    median180: median(forward[180]),
    median365: median(r365),
    pctPositive365: r365.length ? Math.round(100 * r365.filter(x => x > 0).length / r365.length) : null,
    medianWorstDrawdown365: median(drawdowns),
  };
}

/**
 * Retornos posteriores (fracciones, 0.5 = +50%) para días en zona vs. todos.
 * Ojo: los días de un mismo episodio no son independientes.
 */
function summarizeStats(zoned) {
  const prices = priceIndex(zoned);
  const classified = zoned.filter(r => r.zone !== null);
  return {
    value: statsFor(classified.filter(r => r.zone !== 'NONE'), zoned, prices),
    extreme: statsFor(classified.filter(r => r.zone === 'EXTREME'), zoned, prices),
    all: statsFor(classified, zoned, prices),
  };
}

module.exports = {
  normalizeDaily, computeSeries, classifyZones, evaluateLatest, findEpisodes, summarizeStats,
  countDateGaps,
  WMA_DAYS, MAYER_DAYS, EXIT_MARGIN, REMINDER_EVERY_DAYS, EVENT_WINDOW_DAYS, STALE_AFTER_DAYS, ZONES,
};
