const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeDaily, computeSeries, classifyZones, evaluateLatest, findEpisodes, summarizeStats,
  WMA_DAYS, EXIT_MARGIN,
} = require('../src/accumulationEngine');

const DAY = 86_400_000;
const isoDay = (i) => new Date(Date.UTC(2020, 0, 1) + i * DAY).toISOString().slice(0, 10);

// Filas ya con métricas, para probar la lógica de zonas aislada
const row = (i, p, wma200, mvrv) => ({ t: isoDay(i), p, wma200, mvrv });

test('normalizeDaily convierte filas de CoinMetrics y descarta las inválidas', () => {
  const raw = [
    { time: '2020-01-01T00:00:00.000000000Z', PriceUSD: '7200.5', CapMVRVCur: '1.2' },
    { time: '2020-01-02T00:00:00.000000000Z', PriceUSD: '7300' },               // sin MVRV
    { time: '2020-01-03T00:00:00.000000000Z', PriceUSD: 'abc', CapMVRVCur: '1' }, // precio roto
    { time: '2020-01-04T00:00:00.000000000Z', PriceUSD: '-5', CapMVRVCur: '1' },  // precio negativo
  ];

  const out = normalizeDaily(raw);

  assert.deepEqual(out, [
    { t: '2020-01-01', p: 7200.5, mvrv: 1.2 },
    { t: '2020-01-02', p: 7300, mvrv: null },
  ]);
});

test('computeSeries calcula la media de 200 semanas (1400 días) y el Mayer', () => {
  const daily = Array.from({ length: WMA_DAYS + 10 }, (_, i) => ({ t: isoDay(i), p: 100, mvrv: 1.5 }));
  daily[daily.length - 1] = { ...daily[daily.length - 1], p: 80 };

  const s = computeSeries(daily);

  assert.equal(s[WMA_DAYS - 2].wma200, null, 'sin historia suficiente no hay 200WMA');
  const last = s[s.length - 1];
  assert.ok(Math.abs(last.wma200 - (100 * 1399 + 80) / 1400) < 1e-9);
  assert.ok(Math.abs(last.mayer - 80 / ((100 * 199 + 80) / 200)) < 1e-9);
  assert.ok(Math.abs(last.realizedPrice - 80 / 1.5) < 1e-9);
});

test('entra en zona de VALOR apenas el precio cae debajo de la 200WMA', () => {
  const z = classifyZones([row(0, 110, 100, 1.5), row(1, 99, 100, 1.5)]);

  assert.deepEqual(z.map(r => r.zone), ['NONE', 'VALUE']);
});

test('entra en zona de VALOR también con MVRV < 1 aunque el precio esté sobre la 200WMA', () => {
  const z = classifyZones([row(0, 110, 100, 0.95)]);

  assert.equal(z[0].zone, 'VALUE');
});

test('zona EXTREMA cuando se cumplen las dos condiciones', () => {
  const z = classifyZones([row(0, 90, 100, 0.9)]);

  assert.equal(z[0].zone, 'EXTREME');
});

test('histéresis: no sale de la zona hasta recuperarse con margen en ambas condiciones', () => {
  const justAbove = 100 * (1 + EXIT_MARGIN / 2);
  const clearlyAbove = 100 * (1 + EXIT_MARGIN) + 1;

  const z = classifyZones([
    row(0, 95, 100, 1.5),            // entra
    row(1, justAbove, 100, 1.5),     // apenas arriba → sigue en zona
    row(2, clearlyAbove, 100, 1.05), // precio recuperado pero MVRV dentro del margen → sigue
    row(3, clearlyAbove, 100, 1.5),  // ambas recuperadas → sale
  ]);

  assert.deepEqual(z.map(r => r.zone), ['VALUE', 'VALUE', 'VALUE', 'NONE']);
});

test('de EXTREMA baja a VALOR cuando una condición se recupera con margen', () => {
  const z = classifyZones([
    row(0, 90, 100, 0.9),
    row(1, 99, 100, 1.2),  // MVRV recuperado con margen, precio sigue abajo
  ]);

  assert.deepEqual(z.map(r => r.zone), ['EXTREME', 'VALUE']);
});

test('sin métricas suficientes la zona es null y no rompe la secuencia', () => {
  const z = classifyZones([row(0, 90, null, null), row(1, 90, 100, 1.5)]);

  assert.deepEqual(z.map(r => r.zone), [null, 'VALUE']);
});

test('evaluateLatest detecta la entrada a la zona en el último día', () => {
  const z = classifyZones([row(0, 110, 100, 1.5), row(1, 99, 100, 1.5)]);
  const now = Date.parse(z[1].t) + DAY;

  const e = evaluateLatest(z, now);

  assert.equal(e.zone, 'VALUE');
  assert.equal(e.previousZone, 'NONE');
  assert.equal(e.event, 'ENTER');
  assert.equal(e.zoneSince, z[1].t);
  assert.equal(e.daysInZone, 0);
  assert.equal(e.isStale, false);
});

test('evaluateLatest: UPGRADE a EXTREMA, EXIT al salir, sin evento si no cambia', () => {
  const up = classifyZones([row(0, 99, 100, 1.5), row(1, 90, 100, 0.9)]);
  const exit = classifyZones([row(0, 99, 100, 1.5), row(1, 120, 100, 1.5)]);
  const same = classifyZones([row(0, 99, 100, 1.5), row(1, 98, 100, 1.5)]);
  const now = (z) => Date.parse(z[1].t);

  assert.equal(evaluateLatest(up, now(up)).event, 'UPGRADE');
  assert.equal(evaluateLatest(exit, now(exit)).event, 'EXIT');
  assert.equal(evaluateLatest(same, now(same)).event, null);
});

test('evaluateLatest sigue reportando el evento unos días (si una corrida falla no se pierde)', () => {
  const rows = [row(0, 110, 100, 1.5), row(1, 99, 100, 1.5)];
  for (let i = 2; i <= 9; i++) rows.push(row(i, 98, 100, 1.5));
  const z = classifyZones(rows);

  const day4 = evaluateLatest(z.slice(0, 5), Date.parse(z[4].t));
  const day9 = evaluateLatest(z, Date.parse(z[9].t));

  assert.equal(day4.event, 'ENTER');
  assert.equal(day4.eventDate, z[1].t);
  assert.equal(day9.event, null, 'pasada la ventana ya no se reporta');
});

test('evaluateLatest reporta el evento más reciente de la ventana', () => {
  const z = classifyZones([
    row(0, 110, 100, 1.5), row(1, 99, 100, 1.5), row(2, 90, 100, 0.9), row(3, 91, 100, 0.9),
  ]);

  const e = evaluateLatest(z, Date.parse(z[3].t));

  assert.equal(e.event, 'UPGRADE');
  assert.equal(e.eventDate, z[2].t);
});

test('el recordatorio tolera días salteados pero no salta al entrar', () => {
  const rows = [row(0, 110, 100, 1.5)];
  for (let i = 1; i <= 34; i++) rows.push(row(i, 95, 100, 1.5));
  const z = classifyZones(rows);
  const at = (i) => evaluateLatest(z.slice(0, i + 1), Date.parse(z[i].t));

  assert.equal(at(2).reminderDue, false, 'día 1 en zona');
  assert.equal(at(32).reminderDue, true, 'día 31: dentro de la tolerancia');
  assert.equal(at(34).reminderDue, false, 'día 33: fuera de la tolerancia');
});

test('findEpisodes ignora días sin métricas en vez de cortar el episodio', () => {
  const z = classifyZones([
    row(0, 95, 100, 1.5), row(1, 95, 100, null), row(2, 95, 100, 1.5),
  ]);

  const eps = findEpisodes(z);

  assert.equal(eps.length, 1);
  assert.equal(eps[0].days, 2);
  assert.equal(eps[0].ongoing, true);
});

test('evaluateLatest marca recordatorio cada 30 días dentro de la zona', () => {
  const rows = [row(0, 110, 100, 1.5)];
  for (let i = 1; i <= 31; i++) rows.push(row(i, 95, 100, 1.5));
  const z = classifyZones(rows);

  const at30 = evaluateLatest(z.slice(0, 31), Date.parse(z[30].t));
  const at31 = evaluateLatest(z, Date.parse(z[31].t));

  assert.equal(at30.daysInZone, 29);
  assert.equal(at30.reminderDue, false);
  assert.equal(at31.daysInZone, 30);
  assert.equal(at31.reminderDue, true);
});

test('evaluateLatest marca los datos viejos como stale (no se notifica)', () => {
  const z = classifyZones([row(0, 110, 100, 1.5), row(1, 99, 100, 1.5)]);

  const e = evaluateLatest(z, Date.parse(z[1].t) + 5 * DAY);

  assert.equal(e.isStale, true);
});

test('findEpisodes agrupa los días en zona y calcula el retorno a 365 días', () => {
  const rows = [];
  for (let i = 0; i < 400; i++) rows.push(row(i, i < 10 ? 95 : 200, 100, 1.5));
  rows[0] = row(0, 95, 100, 1.5);
  const z = classifyZones(rows);

  const eps = findEpisodes(z);

  assert.equal(eps.length, 1);
  assert.equal(eps[0].start, z[0].t);
  assert.equal(eps[0].maxZone, 'VALUE');
  assert.ok(Math.abs(eps[0].return365 - (200 / 95 - 1)) < 1e-9);
});

test('summarizeStats compara días en zona contra todos los días', () => {
  const rows = [];
  for (let i = 0; i < 400; i++) rows.push(row(i, i < 10 ? 95 : 200, 100, 1.5));
  const z = classifyZones(rows);

  const stats = summarizeStats(z);

  assert.equal(stats.value.days, 10);
  assert.equal(stats.all.days, 400);
  assert.equal(stats.value.pctPositive365, 100);
  assert.ok(stats.value.median365 > 1);
});
