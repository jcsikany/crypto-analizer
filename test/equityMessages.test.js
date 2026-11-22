const test = require('node:test');
const assert = require('node:assert/strict');
const { buildEquityLevelAlert, buildDcaReminder } = require('../src/equityMessages');

const DAY_MINUTES = 24 * 60;
const ev = (over = {}) => ({
  asOf: '2026-11-20', price: 689.81, ath: 775, athDate: '2026-10-01', dd: -0.11, vix: 35.9,
  level: 1, armed: 1, event: { date: '2026-11-20', levels: [1], level: 1 }, isStale: false,
  cspxPrice: 762.4, ...over,
});

test('nivel 1: alerta EQ_L1 con la parte de la reserva según la regla', () => {
  const a = buildEquityLevelAlert(ev(), [33, 50, 100]);

  assert.equal(a.alertType, 'EQ_L1');
  assert.equal(a.cooldownMinutes, 30 * DAY_MINUTES);
  assert.match(a.title, /oportunidad/i);
  assert.match(a.body, /-11%/);
  assert.match(a.body, /VIX 35\.9/);
  assert.match(a.body, /33% de la reserva/);
});

test('salto de varios niveles el mismo día: tipo del nivel más alto y regla acumulada', () => {
  const a = buildEquityLevelAlert(ev({ dd: -0.31, level: 3, event: { date: '2026-11-20', levels: [1, 2, 3], level: 3 } }), [33, 50, 100]);

  assert.equal(a.alertType, 'EQ_L3');
  assert.match(a.title, /extrema/i);
  assert.match(a.body, /33%.*50%.*100%/s);
});

test('si solo se dispara el nivel 2 (escalada), el texto dice "de lo que quede"', () => {
  const a = buildEquityLevelAlert(ev({ dd: -0.21, level: 2, event: { date: '2026-11-20', levels: [2], level: 2 } }), [33, 50, 100]);

  assert.match(a.body, /50% de lo que quede/);
  assert.doesNotMatch(a.body, /de la reserva/);
});

test('sin evento o con datos viejos no hay alerta de nivel', () => {
  assert.equal(buildEquityLevelAlert(ev({ event: null }), [33, 50, 100]), null);
  assert.equal(buildEquityLevelAlert(ev({ isStale: true }), [33, 50, 100]), null);
});

test('el recordatorio trimestral menciona el nivel activo si lo hay', () => {
  const active = buildDcaReminder(ev());
  const calm = buildDcaReminder(ev({ level: 0, dd: -0.01, vix: 14, event: null }));
  const noData = buildDcaReminder(null);

  assert.equal(active.alertType, 'EQ_DCA');
  assert.equal(active.cooldownMinutes, 20 * DAY_MINUTES);
  assert.match(active.body, /oportunidad/i);
  assert.doesNotMatch(calm.body, /oportunidad/i);
  assert.match(noData.title, /compra trimestral/i);
});
