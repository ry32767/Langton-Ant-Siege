// src/search/genome.js の単体テスト。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRandomGenome,
  validateGenome,
  cloneGenome,
  genomeKey,
  toTemplateCells,
  costOfGenome,
} from '../src/search/genome.js';

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

test('createRandomGenome は10,000件すべて不変条件を満たす', () => {
  const rng = makeRng(1);
  for (let i = 0; i < 10000; i++) {
    const g = createRandomGenome(rng);
    const errors = validateGenome(g);
    assert.deepEqual(errors, [], `${i}件目で違反: ${errors.join(' / ')}`);
  }
});

test('cloneGenome は深いコピーを返す(元の cells 配列を共有しない)', () => {
  const rng = makeRng(2);
  const g = createRandomGenome(rng);
  const clone = cloneGenome(g);
  assert.deepEqual(clone, g);
  clone.cells[0].state = 999;
  clone.rule = 'X' + clone.rule.slice(1);
  assert.notEqual(clone.cells[0].state, g.cells[0].state);
  assert.notEqual(clone.rule, g.rule);
});

test('genomeKey は同じ内容なら同じキー、違えば違うキーを返す', () => {
  const rng = makeRng(3);
  const g = createRandomGenome(rng);
  const clone = cloneGenome(g);
  assert.equal(genomeKey(g), genomeKey(clone));

  const different = cloneGenome(g);
  different.antX = (different.antX + 1) % 60;
  assert.notEqual(genomeKey(g), genomeKey(different));
});

test('genomeKey は cells の並び順に依存しない(座標でソートされる)', () => {
  const g = {
    rule: 'RL',
    antX: 0,
    antY: 0,
    antDir: 0,
    cells: [
      { x: 1, y: 1, state: 1 },
      { x: 0, y: 0, state: 0 },
    ],
  };
  const reordered = {
    ...g,
    cells: [g.cells[1], g.cells[0]],
  };
  assert.equal(genomeKey(g), genomeKey(reordered));
});

test('toTemplateCells は [x,y,state] の3要素配列の配列を返す', () => {
  const rng = makeRng(4);
  const g = createRandomGenome(rng);
  const tpl = toTemplateCells(g);
  assert.equal(tpl.length, g.cells.length);
  for (let i = 0; i < tpl.length; i++) {
    assert.equal(tpl[i].length, 3);
    assert.deepEqual(tpl[i], [g.cells[i].x, g.cells[i].y, g.cells[i].state]);
  }
});

test('costOfGenome は baseCost + cells.length で、ルール長は無関係', () => {
  const g1 = {
    rule: 'RL',
    antX: 0,
    antY: 0,
    antDir: 0,
    cells: [{ x: 0, y: 0, state: 0 }],
  };
  const g2 = {
    rule: 'RLRLRLRLRLRLRLRL', // 16文字
    antX: 0,
    antY: 0,
    antDir: 0,
    cells: [{ x: 0, y: 0, state: 0 }],
  };
  assert.equal(costOfGenome(g1, 5), 6);
  assert.equal(costOfGenome(g2, 5), 6); // ルール長が違っても同じコスト
});

test('validateGenome は不変条件違反を個別に検出する', () => {
  const base = {
    rule: 'RL',
    antX: 0,
    antY: 0,
    antDir: 0,
    cells: [{ x: 0, y: 0, state: 0 }],
  };
  assert.deepEqual(validateGenome(base), []);

  assert.ok(validateGenome({ ...base, rule: 'R' }).length > 0); // 短すぎるルール
  assert.ok(validateGenome({ ...base, rule: 'X' + 'R'.repeat(15) }).length > 0); // 不正な記号
  assert.ok(validateGenome({ ...base, cells: [] }).length > 0); // セル0個
  assert.ok(
    validateGenome({ ...base, cells: [{ x: 0, y: 0, state: 5 }] }).length > 0, // state >= colorCount
  );
  assert.ok(validateGenome({ ...base, antX: -1 }).length > 0);
  assert.ok(validateGenome({ ...base, antY: 16 }).length > 0);
  assert.ok(validateGenome({ ...base, antDir: 4 }).length > 0);
  assert.ok(
    validateGenome({
      ...base,
      cells: [
        { x: 1, y: 1, state: 0 },
        { x: 1, y: 1, state: 1 },
      ],
    }).length > 0, // 座標重複
  );
});
