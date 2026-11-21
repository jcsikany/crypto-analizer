const test = require('node:test');
const assert = require('node:assert/strict');
const { computeConfidence, computeMasterSignal } = require('../src/signalEngine');

// TFs con score ya escalado (misma escala que el score maestro)
const tfs = (s15m, s1h, s4h, s1d) => [
  { tf: '15m', score: s15m }, { tf: '1h', score: s1h },
  { tf: '4h', score: s4h }, { tf: '1d', score: s1d },
];

test('score 0 da confianza 0', () => {
  assert.equal(computeConfidence(0, tfs(1, 1, 1, 1), 'STRONG_TREND_UP'), 0);
});

test('señal fuerte con todos los TF alineados en tendencia fuerte da confianza alta', () => {
  const c = computeConfidence(1.5, tfs(1.5, 1.5, 1.5, 1.5), 'STRONG_TREND_UP');

  assert.ok(c >= 90, `esperaba >= 90, dio ${c}`);
});

test('a igual score, TFs en contra bajan la confianza', () => {
  const aligned = computeConfidence(0.8, tfs(0.8, 0.8, 0.8, 0.8), 'TREND_UP');
  const mixed = computeConfidence(0.8, tfs(-0.8, -0.8, 1.2, 1.2), 'TREND_UP');

  assert.ok(mixed < aligned, `mixed=${mixed} aligned=${aligned}`);
});

test('alta volatilidad baja la confianza respecto de una tendencia', () => {
  const trend = computeConfidence(1, tfs(1, 1, 1, 1), 'STRONG_TREND_UP');
  const hv = computeConfidence(1, tfs(1, 1, 1, 1), 'HIGH_VOLATILITY');

  assert.ok(hv < trend);
});

test('la confianza es simétrica para señales de venta', () => {
  const buy = computeConfidence(1, tfs(1, 1, 1, 1), 'TREND_UP');
  const sell = computeConfidence(-1, tfs(-1, -1, -1, -1), 'TREND_DOWN');

  assert.equal(buy, sell);
});

test('la confianza es siempre un entero entre 0 y 100', () => {
  for (const s of [-2, -1.3, -0.4, 0.05, 0.7, 2]) {
    const c = computeConfidence(s, tfs(2, -2, 0.3, -0.1), 'RANGING');
    assert.ok(Number.isInteger(c) && c >= 0 && c <= 100, `s=${s} c=${c}`);
  }
});

test('un TF con score NaN se ignora y no vuelve NaN la confianza', () => {
  const withNaN = computeConfidence(1, tfs(NaN, 1, 1, 1), 'TREND_UP');
  const without = computeConfidence(1, tfs(1, 1, 1, 1), 'TREND_UP');

  assert.ok(Number.isInteger(withNaN));
  assert.equal(withNaN, without);
  assert.equal(computeConfidence(NaN, tfs(1, 1, 1, 1), 'TREND_UP'), 0);
});

test('computeMasterSignal usa la nueva confianza (no queda en ~0 con TFs alineados)', () => {
  const tf = (score) => ({ score, regime: 'TREND_UP' });

  const m = computeMasterSignal({ '15m': tf(0.25), '1h': tf(0.25), '4h': tf(0.25), '1d': tf(0.25) });

  assert.ok(m.confidence >= 70, `esperaba >= 70, dio ${m.confidence} (score ${m.score})`);
});
