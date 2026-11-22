const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseYahooChart, parseFredCsv, buildSeries, levelOf, trackLevels, evaluateLatest,
  findTriggers, summarizeTriggers, isReminderDue, normalizeEquityConfig, dropOpenBar,
} = require('../src/equityEngine');

const DAY = 86_400_000;
const isoDay = (i) => new Date(Date.UTC(2020, 0, 1) + i * DAY).toISOString().slice(0, 10);
// Filas ya armadas para probar niveles aislados
const row = (i, dd, vix = 15) => ({ t: isoDay(i), p: 100 * (1 + dd), dd, vix });

test('parseYahooChart usa adjclose si se pide y descarta valores inválidos', () => {
  const json = { chart: { result: [{
    timestamp: [1577836800, 1577923200, 1578009600],
    indicators: { quote: [{ close: [10, null, 12] }], adjclose: [{ adjclose: [9, 9.5, null] }] },
  }] } };

  assert.deepEqual(parseYahooChart(json, { adjusted: true }), [
    { t: '2020-01-01', p: 9 }, { t: '2020-01-02', p: 9.5 },
  ]);
  assert.deepEqual(parseYahooChart(json, { adjusted: false }), [
    { t: '2020-01-01', p: 10 }, { t: '2020-01-03', p: 12 },
  ]);
  assert.throws(() => parseYahooChart({ chart: { result: null, error: { code: 'x' } } }), /Yahoo/);
});

test('parseFredCsv ignora los días sin dato (".")', () => {
  const m = parseFredCsv('observation_date,VIXCLS\n2020-01-01,15.5\n2020-01-02,.\n2020-01-03,16\n');

  assert.deepEqual([...m.entries()], [['2020-01-01', 15.5], ['2020-01-03', 16]]);
});

test('buildSeries calcula máximo histórico, caída y VIX arrastrado', () => {
  const prices = [{ t: '2020-01-01', p: 100 }, { t: '2020-01-02', p: 110 }, { t: '2020-01-03', p: 88 }];
  const vix = new Map([['2020-01-01', 14], ['2020-01-03', 33]]);

  const s = buildSeries(prices, vix);

  assert.equal(s[1].ath, 110);
  assert.equal(s[1].vix, 14, 'sin VIX ese día → el último conocido');
  assert.ok(Math.abs(s[2].dd - (88 / 110 - 1)) < 1e-12);
  assert.equal(s[2].athDate, '2020-01-02');
  assert.equal(s[2].vix, 33);
});

test('levelOf: umbrales por caída y por VIX', () => {
  assert.equal(levelOf({ dd: -0.05, vix: 20 }), 0);
  assert.equal(levelOf({ dd: -0.10, vix: 20 }), 1);
  assert.equal(levelOf({ dd: -0.02, vix: 30 }), 1);
  assert.equal(levelOf({ dd: -0.20, vix: 20 }), 2);
  assert.equal(levelOf({ dd: -0.05, vix: 40 }), 2);
  assert.equal(levelOf({ dd: -0.30, vix: 20 }), 3);
  assert.equal(levelOf({ dd: -0.12, vix: null }), 1);
});

test('trackLevels avisa cada nivel una sola vez por caída', () => {
  const s = trackLevels([
    row(0, -0.02), row(1, -0.11), row(2, -0.13), row(3, -0.09), row(4, -0.12), row(5, -0.21),
  ]);

  assert.deepEqual(s.map(r => r.triggered), [[], [1], [], [], [], [2]]);
});

test('trackLevels rearma solo sin señales activas y cerca del máximo', () => {
  const s = trackLevels([
    row(0, -0.11),            // nivel 1
    row(1, -0.03, 31),        // cerca del máximo pero VIX alto → no rearma
    row(2, -0.11),            // sigue armado → no repite
    row(3, -0.03, 20),        // sin señales y cerca del máximo → rearma
    row(4, -0.10),            // nueva caída → avisa de nuevo
  ]);

  assert.deepEqual(s.map(r => r.triggered), [[1], [], [], [], [1]]);
});

test('trackLevels: un salto directo dispara todos los niveles intermedios', () => {
  const s = trackLevels([row(0, -0.01), row(1, -0.31)]);

  assert.deepEqual(s[1].triggered, [1, 2, 3]);
  assert.equal(s[1].armed, 3);
});

test('evaluateLatest reporta el evento reciente y lo olvida pasada la ventana', () => {
  const rows = [row(0, -0.01), row(1, -0.11)];
  for (let i = 2; i <= 9; i++) rows.push(row(i, -0.11));
  const s = trackLevels(rows);

  const day3 = evaluateLatest(s.slice(0, 4), Date.parse(s[3].t));
  const day9 = evaluateLatest(s, Date.parse(s[9].t));

  assert.deepEqual(day3.event, { date: s[1].t, levels: [1], level: 1 });
  assert.equal(day3.level, 1);
  assert.equal(day9.event, null);
});

test('evaluateLatest marca datos viejos (más de 5 días) como stale', () => {
  const s = trackLevels([row(0, -0.01), row(1, -0.11)]);

  assert.equal(evaluateLatest(s, Date.parse(s[1].t) + 3 * DAY).isStale, false);
  assert.equal(evaluateLatest(s, Date.parse(s[1].t) + 6 * DAY).isStale, true);
});

test('findTriggers calcula el retorno a 12 meses y summarizeTriggers lo resume', () => {
  const rows = [];
  for (let i = 0; i < 400; i++) rows.push({ t: isoDay(i), p: i === 1 ? 80 : 100, dd: i === 1 ? -0.2 : 0, vix: 15 });
  const s = trackLevels(rows);

  const trig = findTriggers(s);
  const sum = summarizeTriggers(trig);

  assert.equal(trig.length, 1);
  assert.deepEqual(trig[0].levels, [1, 2]);
  assert.ok(Math.abs(trig[0].return365 - (100 / 80 - 1)) < 1e-12);
  assert.equal(sum[2].count, 1);
  assert.equal(sum[2].pctPositive365, 100);
});

test('isReminderDue: día y meses configurados', () => {
  const cfg = normalizeEquityConfig({ reminderDay: 5, reminderMonths: [1, 4, 7, 10] });

  assert.equal(isReminderDue(cfg, '2026-04-05'), true);
  assert.equal(isReminderDue(cfg, '2026-04-04'), false);
  assert.equal(isReminderDue(cfg, '2026-05-05'), false);
  assert.equal(isReminderDue({ ...cfg, reminderEnabled: false }, '2026-04-05'), false);
});

test('normalizeEquityConfig: vacío/null en fracciones = default, "false" texto = apagado', () => {
  const c = normalizeEquityConfig({ fractions: ['', null, '40'], enabled: 'false', reminderEnabled: 'false' });

  assert.deepEqual(c.fractions, [33, 50, 40]);
  assert.equal(c.enabled, false);
  assert.equal(c.reminderEnabled, false);
});

test('isReminderDue recupera hasta 3 días si el servidor estuvo caído', () => {
  const cfg = normalizeEquityConfig({ reminderDay: 5, reminderMonths: [1, 4, 7, 10] });

  assert.equal(isReminderDue(cfg, '2026-04-07'), true);
  assert.equal(isReminderDue(cfg, '2026-04-08'), true);
  assert.equal(isReminderDue(cfg, '2026-04-09'), false);
  assert.equal(isReminderDue(cfg, '2026-04-04'), false);
});

test('dropOpenBar descarta la vela de hoy si el mercado no cerró', () => {
  const prices = [{ t: '2026-11-19', p: 1 }, { t: '2026-11-20', p: 2 }];

  const during = dropOpenBar(prices, Date.parse('2026-11-20T15:00:00Z'));
  const after = dropOpenBar(prices, Date.parse('2026-11-20T21:45:00Z'));
  const nextDay = dropOpenBar(prices, Date.parse('2026-11-21T03:00:00Z'));

  assert.deepEqual(during.map(r => r.t), ['2026-11-19']);
  assert.deepEqual(after.map(r => r.t), ['2026-11-19', '2026-11-20']);
  assert.deepEqual(nextDay.map(r => r.t), ['2026-11-19', '2026-11-20']);
});

test('normalizeEquityConfig aplica defaults y acota valores', () => {
  assert.deepEqual(normalizeEquityConfig(undefined), {
    enabled: true, reminderEnabled: true, reminderDay: 1,
    reminderMonths: [1, 4, 7, 10], fractions: [33, 50, 100],
  });
  const c = normalizeEquityConfig({ reminderDay: 40, reminderMonths: [0, 3, 13, 3], fractions: [150, -5, 'x'], enabled: false });
  assert.equal(c.enabled, false);
  assert.equal(c.reminderDay, 28);
  assert.deepEqual(c.reminderMonths, [3]);
  assert.deepEqual(c.fractions, [100, 0, 100]);
});
