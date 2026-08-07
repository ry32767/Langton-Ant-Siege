// src/search/mutate.js の単体テスト。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRandomGenome, validateGenome, cloneGenome, genomeKey } from '../src/search/genome.js';
import { mutate } from '../src/search/mutate.js';
import { ZONE_DEPTH } from '../src/config.js';

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
  // rule.length=16、全セルの state を 15 にしておき、短縮を強制的に起こしやすくする。
  // 'R'.repeat(16) は canonicalRule で 'R'(長さ1)に潰れ MIN_COLORS 未満になるため
  // ruleDelete が常に reject されてしまう。末尾を1文字だけ 'L' にして非周期(=原始形が
  // 16文字のまま)にしておく(位置15を消す一部の変異だけが偶発的に reject される)。
  const g = {
    rule: 'R'.repeat(15) + 'L',
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

test('セルの (dx,dy) 重複が発生しない', () => {
  const rng = makeRng(11);
  let g = createRandomGenome(rng);
  for (let i = 0; i < 20000; i++) {
    g = mutate(g, rng);
    const seen = new Set();
    for (const c of g.cells) {
      const key = `${c.dx},${c.dy}`;
      assert.ok(!seen.has(key), `座標重複: (${c.dx},${c.dy})`);
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

test('mutate を1,000回連鎖適用しても validateGenome を通り続ける', () => {
  const rng = makeRng(2026);
  let g = createRandomGenome(rng);
  assert.deepEqual(validateGenome(g), []);
  for (let i = 0; i < 1000; i++) {
    g = mutate(g, rng);
    const errors = validateGenome(g);
    assert.deepEqual(errors, [], `${i}回目の変異後に違反: ${errors.join(' / ')}`);
  }
});

// applyOneMutation は pickMutationCount(rng) → randInt(rng, ops.length) の順に rng を
// 消費し、antYPlus/antYMinus 自体は rng を消費しない。この2回の呼び出し値を狙って
// 固定することで、決定論的に特定のオペレータを選ばせる(rng の実装詳細に依存する
// ホワイトボックステスト)。
function makeFixedRng(sequence) {
  let i = 0;
  return () => sequence[i++ % sequence.length];
}

test('antYMinus は、動かすと配置マスが配置帯の下端を出る場合 reject(no-op)になる', () => {
  // ops配列 = [bitFlip, cellState, antYPlus, antYMinus, antDir, ruleInsert, cellAdd, cellMove]
  // (rule.length=2 なので ruleDelete 不可、cells.length=1 なので cellDelete 不可)。
  // antYMinus は index=3 → randInt(rng,8) が 3 になる rng() ∈ [0.375, 0.5) を選ぶ。
  const g = {
    rule: 'RL',
    antY: 0, // 下端。dy=0 のセルは antY-1=-1 で配置帯を出る
    antDir: 0,
    cells: [{ dx: 0, dy: 0, state: 0 }],
    origin: 'random',
    parentGenomeId: null,
  };
  const rng = makeFixedRng([0.1, 0.4]); // count=1(<0.7), opIndex=floor(0.4*8)=3=antYMinus
  const mutated = mutate(g, rng);
  assert.equal(mutated.antY, 0); // reject: 変化しない
  assert.deepEqual(mutated.cells, g.cells);
  assert.deepEqual(validateGenome(mutated), []);
});

test('antYPlus は、動かすと配置マスが配置帯の上端を出る場合 reject(no-op)になる', () => {
  // 同じ ops配列。antYPlus は index=2 → randInt(rng,8) が 2 になる rng() ∈ [0.25, 0.375)。
  const g = {
    rule: 'RL',
    antY: ZONE_DEPTH - 1, // 上端。dy=0 のセルは antY+1=ZONE_DEPTH で配置帯を出る
    antDir: 0,
    cells: [{ dx: 0, dy: 0, state: 0 }],
    origin: 'random',
    parentGenomeId: null,
  };
  const rng = makeFixedRng([0.1, 0.3]); // count=1(<0.7), opIndex=floor(0.3*8)=2=antYPlus
  const mutated = mutate(g, rng);
  assert.equal(mutated.antY, ZONE_DEPTH - 1); // reject: 変化しない
  assert.deepEqual(mutated.cells, g.cells);
  assert.deepEqual(validateGenome(mutated), []);
});
