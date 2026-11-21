const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAccumulationAlert } = require('../src/accumulationMessages');

const DAY_MINUTES = 24 * 60;
const base = {
  asOf: '2026-11-14', zone: 'VALUE', previousZone: 'NONE', event: 'ENTER',
  daysInZone: 0, reminderDue: false, isStale: false,
  metrics: { p: 63821, wma200: 68000, mvrv: 1.16, mayer: 0.85, realizedPrice: 55000 },
};

test('entrada a zona de valor genera alerta LT_ENTER con cooldown de 60 días', () => {
  const a = buildAccumulationAlert(base);

  assert.equal(a.alertType, 'LT_ENTER');
  assert.equal(a.cooldownMinutes, 60 * DAY_MINUTES);
  assert.match(a.title, /zona de valor/i);
  assert.match(a.body, /200 semanas/);
  assert.match(a.body, /63[.,]821/);
});

test('subida a zona extrema (o entrada directa) genera LT_EXTREME', () => {
  const up = buildAccumulationAlert({ ...base, zone: 'EXTREME', previousZone: 'VALUE', event: 'UPGRADE' });
  const direct = buildAccumulationAlert({ ...base, zone: 'EXTREME', event: 'ENTER' });

  assert.equal(up.alertType, 'LT_EXTREME');
  assert.equal(direct.alertType, 'LT_EXTREME');
  assert.match(up.title, /extrema/i);
});

test('salida de la zona genera LT_EXIT', () => {
  const a = buildAccumulationAlert({ ...base, zone: 'NONE', previousZone: 'VALUE', event: 'EXIT' });

  assert.equal(a.alertType, 'LT_EXIT');
});

test('recordatorio mensual mientras sigue en zona', () => {
  const a = buildAccumulationAlert({ ...base, event: null, daysInZone: 30, reminderDue: true });

  assert.equal(a.alertType, 'LT_REMINDER');
  assert.match(a.body, /30 días/);
});

test('el recordatorio sale aunque haya habido una bajada de EXTREMA a VALOR', () => {
  const a = buildAccumulationAlert({
    ...base, previousZone: 'EXTREME', event: 'DOWNGRADE', daysInZone: 60, reminderDue: true,
  });

  assert.equal(a.alertType, 'LT_REMINDER');
});

test('no alerta si no hay evento, si baja de EXTREMA a VALOR o si los datos están viejos', () => {
  assert.equal(buildAccumulationAlert({ ...base, event: null }), null);
  assert.equal(buildAccumulationAlert({ ...base, zone: 'VALUE', previousZone: 'EXTREME', event: 'DOWNGRADE' }), null);
  assert.equal(buildAccumulationAlert({ ...base, isStale: true }), null);
});
