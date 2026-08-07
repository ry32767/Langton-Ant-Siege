// src/search/mutate.js の単体テスト。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRandomGenome, validateGenome, cloneGenome, genomeKey } from '../src/search/genome.js';
import { mutate } from '../src/search/mutate.js';

// engine.js に依存しない、テスト専用の決定論的 xorshift32 RNG。
function makeRng(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

test('mutation bounds: 100,000回連鎖適用しても不変条件が一度も破れない', () => {
  const rng = makeRng(42);
  let g = createRandomGenome(rng);
  assert.deepEqual(validateGenome(g), []);
  for (let i = 0; i < 100000; i++) {
    g = mutate(g, rng);
    const errors = validateGenome(g);
    assert.deepEqual(errors, [], `${i}回目の変異後に違反: ${errors.join(' / ')}`);
  }
});

test('ルール短縮変異の後、全セルの state < rule.length になる', () => {
  // rule.length=16、全セルの state を 15 にしておき、短縮を強制的に起こしやすくする
  const g = {
    rule: 'R'.repeat(16),
    antX: 5,
    antY: 5,
    antDir: 0,
    cells: Array.from({ length: 16 }, (_, i) => ({ x: i, y: 0, state: 15 })),
  };
  // ruleDelete が選ばれるまで様々なシードで試す(cellAdd等の余地がないので rule 系のみ選ばれうる)
  let sawShortening = false;
  for (let seed = 1; seed <= 500; seed++) {
    const rng = makeRng(seed);
    const mutated = mutate(g, rng);
    if (mutated.rule.length < g.rule.length) {
      sawShortening = true;
      for (const cell of mutated.cells) {
        assert.ok(cell.state < mutated.rule.length, `state=${cell.state} >= rule.length=${mutated.rule.length}`);
      }
    }
  }
  assert.ok(sawShortening, '短縮変異が一度も起きなかった(シードを増やす必要あり)');
});

test('ルール長は2..16の範囲を出ない', () => {
  const rng = makeRng(7);
  let g = createRandomGenome(rng);
  for (let i = 0; i < 20000; i++) {
    g = mutate(g, rng);
    assert.ok(g.rule.length >= 2 && g.rule.length <= 16, `rule.length=${g.rule.length}`);
  }
});

test('cells.length は1..16の範囲を出ない', () => {
  const rng = makeRng(9);
  let g = createRandomGenome(rng);
  for (let i = 0; i < 20000; i++) {
    g = mutate(g, rng);
    assert.ok(g.cells.length >= 1 && g.cells.length <= 16, `cells.length=${g.cells.length}`);
  }
});

test('セルの (x,y) 重複が発生しない', () => {
  const rng = makeRng(11);
  let g = createRandomGenome(rng);
  for (let i = 0; i < 20000; i++) {
    g = mutate(g, rng);
    const seen = new Set();
    for (const c of g.cells) {
      const key = `${c.x},${c.y}`;
      assert.ok(!seen.has(key), `座標重複: (${c.x},${c.y})`);
      seen.add(key);
    }
  }
});

test('決定論性: 同じ genome + 同じシードなら結果が完全一致する', () => {
  const seedRng = makeRng(123);
  const base = createRandomGenome(seedRng);

  const rngA = makeRng(999);
  const rngB = makeRng(999);
  const resultA = mutate(base, rngA);
  const resultB = mutate(base, rngB);
  assert.deepEqual(resultA, resultB);
  assert.equal(genomeKey(resultA), genomeKey(resultB));
});

test('mutate は引数の genome を破壊しない', () => {
  const rng = makeRng(55);
  const g = createRandomGenome(rng);
  const before = cloneGenome(g);
  mutate(g, rng);
  assert.deepEqual(g, before);
});
