// src/search/map-elites.js の単体テスト。
// evaluate は engine.js / evaluate-projectile.js に依存しない人工的なスタブを使う。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createArchive,
  tryInsert,
  sampleParent,
  archiveStats,
  archiveEntries,
  toJSON,
  fromJSON,
  runMapElites,
} from '../src/search/map-elites.js';

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

function makeGenome(overrides = {}) {
  return {
    rule: 'RL',
    antX: 0,
    antY: 0,
    antDir: 0,
    cells: [{ x: 0, y: 0, state: 0 }],
    ...overrides,
  };
}

// 人工的な evaluate: genome.rule.length と genome.cells.length から記述子を作る。
function makeStubEvaluate({ ruleBins = 15, cellBins = 16, quality = () => 1 } = {}) {
  return (genome) => ({
    descriptor: {
      ruleLenBin: Math.min(ruleBins - 1, genome.rule.length - 2), // rule.length は 2..16
      cellCountBin: Math.min(cellBins - 1, genome.cells.length - 1), // cells.length は 1..16
    },
    quality: quality(genome),
  });
}

test('archive insertion: 空セルなら必ず inserted', () => {
  const archive = createArchive({ dims: [{ name: 'a', bins: 4 }, { name: 'b', bins: 4 }] });
  const individual = { genome: makeGenome(), descriptor: { a: 0, b: 0 }, quality: 1 };
  assert.equal(tryInsert(archive, individual), 'inserted');
  assert.equal(archiveStats(archive).filled, 1);
});

test('replacement: 低qualityは rejected、高qualityは replaced', () => {
  const archive = createArchive({ dims: [{ name: 'a', bins: 4 }] });
  const base = { genome: makeGenome(), descriptor: { a: 1 }, quality: 5 };
  assert.equal(tryInsert(archive, base), 'inserted');

  const lower = { genome: makeGenome(), descriptor: { a: 1 }, quality: 3 };
  assert.equal(tryInsert(archive, lower), 'rejected');
  assert.equal(archiveEntries(archive)[0].quality, 5, '低qualityで上書きされてはいけない');

  const higher = { genome: makeGenome(), descriptor: { a: 1 }, quality: 10 };
  assert.equal(tryInsert(archive, higher), 'replaced');
  assert.equal(archiveEntries(archive)[0].quality, 10);
});

test('同quality(引き分け)では置換しない', () => {
  const archive = createArchive({ dims: [{ name: 'a', bins: 4 }] });
  const base = { genome: makeGenome(), descriptor: { a: 0 }, quality: 5 };
  const tie = { genome: makeGenome(), descriptor: { a: 0 }, quality: 5 };
  assert.equal(tryInsert(archive, base), 'inserted');
  assert.equal(tryInsert(archive, tie), 'rejected');
  assert.equal(archiveEntries(archive)[0], base);
});

test('sampleParent: 空アーカイブでは null を返す', () => {
  const archive = createArchive({ dims: [{ name: 'a', bins: 4 }] });
  const rng = makeRng(1);
  assert.equal(sampleParent(archive, rng), null);
});

test('sampleParent: 埋まっているセルからのみ返す', () => {
  const archive = createArchive({ dims: [{ name: 'a', bins: 4 }] });
  const individuals = [
    { genome: makeGenome(), descriptor: { a: 0 }, quality: 1 },
    { genome: makeGenome(), descriptor: { a: 1 }, quality: 2 },
    { genome: makeGenome(), descriptor: { a: 2 }, quality: 3 },
  ];
  for (const ind of individuals) tryInsert(archive, ind);
  const rng = makeRng(42);
  for (let i = 0; i < 50; i++) {
    const sampled = sampleParent(archive, rng);
    assert.ok(individuals.includes(sampled), 'sampleParent が挿入済み個体以外を返した');
  }
});

test('deterministic replay: 同じ初期シード・同じ evaluate なら runMapElites の結果が完全一致する', () => {
  const dims = [
    { name: 'ruleLenBin', bins: 15 },
    { name: 'cellCountBin', bins: 16 },
  ];
  const evaluate = makeStubEvaluate({ quality: (g) => g.rule.length + g.cells.length });

  const archive1 = createArchive({ dims });
  runMapElites({ archive: archive1, evaluate, rng: makeRng(123), iterations: 200, initialBatch: 20 });

  const archive2 = createArchive({ dims });
  runMapElites({ archive: archive2, evaluate, rng: makeRng(123), iterations: 200, initialBatch: 20 });

  assert.deepEqual(toJSON(archive1), toJSON(archive2));
});

test('evaluate が null を返した個体はアーカイブに入らず、ループも止まらない', () => {
  const dims = [{ name: 'ruleLenBin', bins: 15 }];
  let calls = 0;
  const evaluate = () => {
    calls++;
    return null;
  };
  const archive = createArchive({ dims });
  const rng = makeRng(7);
  runMapElites({ archive, evaluate, rng, iterations: 50, initialBatch: 10 });
  assert.equal(archiveStats(archive).filled, 0);
  assert.equal(calls, 60, 'initialBatch + iterations 分だけ evaluate が呼ばれるはず');
});

test('evaluate が descriptor 無しのオブジェクトを返しても挿入されない', () => {
  const dims = [{ name: 'ruleLenBin', bins: 15 }];
  const evaluate = () => ({ quality: 5 }); // descriptor 無し
  const archive = createArchive({ dims });
  const rng = makeRng(8);
  runMapElites({ archive, evaluate, rng, iterations: 20, initialBatch: 5 });
  assert.equal(archiveStats(archive).filled, 0);
});

test('archiveStats: filled/coverage が正しい', () => {
  const archive = createArchive({ dims: [{ name: 'a', bins: 5 }, { name: 'b', bins: 2 }] }); // total=10
  tryInsert(archive, { genome: makeGenome(), descriptor: { a: 0, b: 0 }, quality: 1 });
  tryInsert(archive, { genome: makeGenome(), descriptor: { a: 1, b: 0 }, quality: 2 });
  const stats = archiveStats(archive);
  assert.equal(stats.filled, 2);
  assert.equal(stats.total, 10);
  assert.equal(stats.coverage, 0.2);
  assert.equal(stats.qualityMax, 2);
  assert.equal(stats.qualityMean, 1.5);
  assert.equal(stats.qualitySum, 3);
});

test('toJSON → fromJSON のラウンドトリップで内容が保存される', () => {
  const archive = createArchive({ dims: [{ name: 'a', bins: 4 }, { name: 'b', bins: 4 }] });
  tryInsert(archive, { genome: makeGenome({ rule: 'LR' }), descriptor: { a: 0, b: 1 }, quality: 3, meta: { foo: 1 } });
  tryInsert(archive, { genome: makeGenome({ rule: 'RRL' }), descriptor: { a: 2, b: 3 }, quality: 9 });

  const json = toJSON(archive);
  const restored = fromJSON(JSON.parse(JSON.stringify(json)));

  assert.deepEqual(archiveStats(restored), archiveStats(archive));
  const originalEntries = archiveEntries(archive).sort((x, y) => x.quality - y.quality);
  const restoredEntries = archiveEntries(restored).sort((x, y) => x.quality - y.quality);
  assert.deepEqual(restoredEntries, originalEntries);
});

test('runMapElites: coverage は単調非減少になる(elite が消えない)', () => {
  const dims = [
    { name: 'ruleLenBin', bins: 15 },
    { name: 'cellCountBin', bins: 16 },
  ];
  const evaluate = makeStubEvaluate({ quality: (g) => g.rule.length * g.cells.length });
  const archive = createArchive({ dims });
  const rng = makeRng(99);

  let prevCoverage = 0;
  runMapElites({
    archive,
    evaluate,
    rng,
    iterations: 500,
    initialBatch: 30,
    onProgress: (stats) => {
      assert.ok(stats.coverage >= prevCoverage, `coverage が減少した: ${prevCoverage} -> ${stats.coverage}`);
      prevCoverage = stats.coverage;
    },
  });
});

test('多様性の確認: 人工 evaluate で複数セルが埋まる', () => {
  const dims = [
    { name: 'ruleLenBin', bins: 15 },
    { name: 'cellCountBin', bins: 16 },
  ];
  const evaluate = makeStubEvaluate({ quality: (g) => g.rule.length + g.cells.length * 2 });
  const archive = createArchive({ dims });
  const rng = makeRng(2026);

  runMapElites({ archive, evaluate, rng, iterations: 1000, initialBatch: 50 });

  const stats = archiveStats(archive);
  assert.ok(stats.filled > 5, `多様性が低すぎる: filled=${stats.filled}`);
});
