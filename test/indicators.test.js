const test = require('node:test');
const assert = require('node:assert/strict');
const { EMA } = require('../src/indicators');

test('EMA devuelve todo null y conserva el largo cuando hay menos datos que el período', () => {
  const data = Array.from({ length: 100 }, (_, i) => 100 + i);

  const result = EMA(data, 200);

  assert.equal(result.length, 100);
  assert.ok(result.every(v => v === null));
});

test('EMA arranca con la SMA del período y luego suaviza', () => {
  const data = [1, 2, 3, 4, 5];

  const result = EMA(data, 3);

  assert.deepEqual(result.slice(0, 2), [null, null]);
  assert.equal(result[2], 2);            // SMA(1,2,3)
  assert.equal(result[3], 4 * 0.5 + 2 * 0.5); // k = 2/(3+1) = 0.5
  assert.ok(result.every(v => v === null || Number.isFinite(v)));
});
