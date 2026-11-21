const test = require('node:test');
const assert = require('node:assert/strict');
const { computeMasterSignal, SCORE_SCALE } = require('../src/signalEngine');

// computeMasterSignal solo usa `score` y `regime` de cada timeframe
const tf = (score, regime = 'TREND_UP') => ({ score, regime });

test('timeframes neutrales no penalizan la confluencia', () => {
  const m = computeMasterSignal({
    '15m': tf(0), '1h': tf(0.1), '4h': tf(0.6), '1d': tf(0.6),
  });

  assert.equal(m.confluence.multiplier, 1);
  assert.equal(m.confluence.counts.opposing, 0);
});

test('timeframes en dirección opuesta sí penalizan la confluencia', () => {
  const m = computeMasterSignal({
    '15m': tf(-0.6), '1h': tf(-0.6), '4h': tf(0.6), '1d': tf(0.6),
  });

  assert.ok(m.confluence.multiplier < 1);
  assert.equal(m.confluence.counts.opposing, 2);
});

test('el score final es el score crudo escalado y acotado a [-2, 2]', () => {
  const m = computeMasterSignal({
    '15m': tf(0.2), '1h': tf(0.2), '4h': tf(0.2), '1d': tf(0.2),
  });

  assert.ok(typeof m.rawScore === 'number');
  assert.ok(SCORE_SCALE > 1, 'la escala debe expandir el score comprimido');
  const expected = Math.max(-2, Math.min(2, m.rawScore * SCORE_SCALE));
  assert.ok(Math.abs(m.score - expected) < 1e-3);
});

test('la escala nunca saca el score de [-2, 2]', () => {
  const m = computeMasterSignal({
    '15m': tf(2), '1h': tf(2), '4h': tf(2), '1d': tf(2),
  });

  assert.equal(m.score, 2);
  assert.equal(m.signal, 'STRONG_BUY');
});

test('un solo TF en contra aplica la penalización mínima (0.85)', () => {
  const m = computeMasterSignal({
    '15m': tf(-0.6), '1h': tf(0.6), '4h': tf(0.6), '1d': tf(0.6),
  });

  assert.equal(m.confluence.counts.opposing, 1);
  assert.equal(m.confluence.multiplier, 0.85);
});

test('el desglose por TF usa la misma escala que la señal maestra', () => {
  const m = computeMasterSignal({
    '15m': tf(0.2), '1h': tf(0.2), '4h': tf(0.2), '1d': tf(0.2),
  });

  const h4 = m.tfBreakdown.find(t => t.tf === '4h');
  assert.equal(h4.rawScore, 0.2);
  assert.ok(Math.abs(h4.score - 0.2 * SCORE_SCALE) < 1e-3);
  assert.equal(h4.signal, m.signal, 'TFs idénticos deben dar la misma señal que el maestro');
});

test('sin fundamentales ni timeframes válidos devuelve null', () => {
  assert.equal(computeMasterSignal({ '1h': null }), null);
});
