const test = require('node:test');
const assert = require('node:assert/strict');
const { klineTimeRange, KUCOIN_INTERVALS } = require('../src/klineWindow');

test('klineTimeRange pide una ventana que cubre `count` velas (+1 de margen)', () => {
  const now = 1_700_000_000;

  const range = klineTimeRange('4h', 300, now);

  assert.deepEqual(range, { type: '4hour', startAt: now - 301 * 14_400, endAt: now });
});

test('klineTimeRange soporta todos los timeframes que usa el scheduler', () => {
  for (const tf of ['15m', '1h', '4h', '1d']) {
    const r = klineTimeRange(tf, 10, 1_000_000);
    assert.equal(r.type, KUCOIN_INTERVALS[tf].type);
    assert.ok(r.startAt < r.endAt);
  }
});

test('klineTimeRange rechaza timeframes desconocidos y cantidades inválidas', () => {
  assert.throws(() => klineTimeRange('3m', 100, 1_000_000), /timeframe/i);
  assert.throws(() => klineTimeRange('1h', 0, 1_000_000), /count/i);
  assert.throws(() => klineTimeRange('1h', 2000, 1_000_000), /count/i);
});
