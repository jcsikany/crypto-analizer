const test = require('node:test');
const assert = require('node:assert/strict');
const { detectRegime, REGIMES } = require('../src/regimeDetector');
const { trendingCandles } = require('./helpers');

test('una suba fuerte se detecta como STRONG_TREND_UP aunque no haya datos para EMA200', () => {
  // 120 velas: alcanza para EMA21/50 pero no para EMA200
  const candles = trendingCandles(120, 0.01);

  const r = detectRegime(candles);

  assert.equal(r.details.emaAlignment, 2, 'EMA200 ausente no debe contar como "debajo"');
  assert.equal(r.regime, REGIMES.STRONG_TREND_UP);
});

test('una suba fuerte con historia completa se detecta como STRONG_TREND_UP', () => {
  const r = detectRegime(trendingCandles(300, 0.01));

  assert.equal(r.details.emaAlignment, 3);
  assert.equal(r.regime, REGIMES.STRONG_TREND_UP);
});

test('una baja fuerte se detecta como STRONG_TREND_DOWN (simetría)', () => {
  const r = detectRegime(trendingCandles(300, -0.01));

  assert.equal(r.details.emaAlignment, -3);
  assert.equal(r.regime, REGIMES.STRONG_TREND_DOWN);
});
