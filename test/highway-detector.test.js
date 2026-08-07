import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/config.js';
import * as E from '../src/engine.js';
import { detectHighwayFromPath, directionBin, verifyHighwayStrict } from '../src/search/highway-detector.js';

/**
 * simulateSolo の trackPath 出力([x,y] のみ・x はトーラス巻き戻し済み)から、
 * detectHighwayFromPath が要求する [x,y,dir] の「ラップしていない絶対座標」軌跡を作る。
 * dir(i) は「position i から position i+1 への移動に使われた向き」。末尾は次の移動が
 * 存在しないため null にする(detectHighwayFromPath はそれを許容する)。
 */
function toUnwrappedDirPath(rawPath) {
  const n = rawPath.length;
  const ux = new Array(n);
  const uy = new Array(n);
  ux[0] = rawPath[0][0];
  uy[0] = rawPath[0][1];
  for (let i = 1; i < n; i++) {
    let dx = rawPath[i][0] - rawPath[i - 1][0];
    if (dx > C.WIDTH / 2) dx -= C.WIDTH;
    else if (dx < -C.WIDTH / 2) dx += C.WIDTH;
    const dy = rawPath[i][1] - rawPath[i - 1][1];
    ux[i] = ux[i - 1] + dx;
    uy[i] = uy[i - 1] + dy;
  }
  function dirFromDelta(dx, dy) {
    for (let d = 0; d < 4; d++) {
      if (C.DIRS[d][0] === dx && C.DIRS[d][1] === dy) return d;
    }
    return null;
  }
  const path = [];
  for (let i = 0; i < n; i++) {
    const dir = i < n - 1 ? dirFromDelta(ux[i + 1] - ux[i], uy[i + 1] - uy[i]) : null;
    path.push([ux[i], uy[i], dir]);
  }
  return path;
}

test('人工的な周期2・並進(1,1)の軌跡から period/driftX/driftY を検出する', () => {
  // right(dir=1) と down(dir=2) を交互に繰り返すと、2ステップごとに (1,1) 並進する
  // (dir も 2ステップ周期で一致する)。
  const path = [];
  let x = 0;
  let y = 0;
  let dirToggle = 1; // 1=right, 2=down
  for (let i = 0; i < 30; i++) {
    path.push([x, y, dirToggle]);
    if (dirToggle === 1) {
      x += 1;
      dirToggle = 2;
    } else {
      y += 1;
      dirToggle = 1;
    }
  }
  const hw = detectHighwayFromPath(path, { minCycles: 5, maxPeriod: 20 });
  assert.ok(hw !== null);
  assert.equal(hw.period, 2);
  assert.equal(hw.driftX, 1);
  assert.equal(hw.driftY, 1);
});

test('false positive除去: 末尾で2周期分だけ周期らしく見えるtransientをハイウェイと判定しない', () => {
  // 前半は不規則なジグザグ(周期1..10のどれとも噛み合わない)。末尾だけ period=3 の
  // 周期運動(right,right,down / drift(2,1))を「2周期分」続けて止める。
  // detectHighwayFromPath は末尾を起点に連続一致をさかのぼって数えるため、この場合
  // period=3 の候補は見つかるが verifiedCycles=2 < minCycles=5 で棄却されるはず
  // (1回だけ・少数回だけ似た状態になる transient を採用してはならない、という §9 の要件)。
  const irregular = [
    [0, 0, 1],
    [3, 1, 2],
    [-2, 4, 0],
    [1, -3, 3],
    [5, 2, 1],
    [-4, 1, 0],
    [2, -2, 2],
    [1, 3, 3],
    [-3, -1, 1],
    [4, 2, 0],
    [-1, -4, 2],
    [3, 1, 3],
    [-2, 3, 1],
    [1, -2, 0],
    [2, 2, 2],
  ];
  let x = 0;
  let y = 0;
  const path = [[0, 0, irregular[0][2]]];
  for (let i = 1; i < irregular.length; i++) {
    x += irregular[i][0];
    y += irregular[i][1];
    path.push([x, y, irregular[i][2]]);
  }
  // 末尾に period=3 の周期運動(right,right,down)をちょうど2周期分だけ追加する。
  const dirs = [1, 1, 2]; // right, right, down
  for (let cycle = 0; cycle < 2; cycle++) {
    for (const dir of dirs) {
      path.push([x, y, dir]);
      x += C.DIRS[dir][0];
      y += C.DIRS[dir][1];
    }
  }
  path.push([x, y, null]);

  const hw = detectHighwayFromPath(path, { minCycles: 5, maxPeriod: 10 });
  assert.equal(hw, null);
});

test('並進(0,0)のその場ループをハイウェイと判定しない', () => {
  const path = [];
  // 周期2でその場を往復する(右→左→右→左…)。並進は常に(0,0)。
  let x = 0;
  for (let i = 0; i < 20; i++) {
    const dir = i % 2 === 0 ? 1 : 3; // right / left
    path.push([x, 0, dir]);
    x += dir === 1 ? 1 : -1;
  }
  const hw = detectHighwayFromPath(path, { minCycles: 5, maxPeriod: 10 });
  assert.equal(hw, null);
});

test('dir(t+T) !== dir(t) の軌跡を採用しない(位置は周期的だが向きが揃わない)', () => {
  // 位置は毎ステップ x+=1(周期1で(1,0)並進)だが、dir だけは 0,1,2 を繰り返し、
  // 周期1では一致しない。periodOnly(位置だけ)なら採用されてしまうが、
  // dir チェックがあるため period=1 は棄却されるはず。
  const path = [];
  let x = 0;
  for (let i = 0; i < 20; i++) {
    path.push([x, 0, i % 3]);
    x += 1;
  }
  const hw = detectHighwayFromPath(path, { minCycles: 5, maxPeriod: 1 });
  assert.equal(hw, null);
});

test('directionBin が8方向すべてを正しく返す(y増加が S)', () => {
  assert.equal(directionBin(0, -1), 'N');
  assert.equal(directionBin(1, -1), 'NE');
  assert.equal(directionBin(1, 0), 'E');
  assert.equal(directionBin(1, 1), 'SE');
  assert.equal(directionBin(0, 1), 'S');
  assert.equal(directionBin(-1, 1), 'SW');
  assert.equal(directionBin(-1, 0), 'W');
  assert.equal(directionBin(-1, -1), 'NW');
});

test('回帰フィクスチャ: LEGACY_RULE genome は formationStep=LEGACY_HIGHWAY_ONSET_STEP・period=LEGACY_HIGHWAY_PERIOD になる', () => {
  const r = E.simulateSolo(
    { cells: [], antX: 10, antY: 30, antDir: C.DIR_RIGHT, rule: C.LEGACY_RULE },
    { life: 300, trackPath: true },
  );
  const path = toUnwrappedDirPath(r.path);
  const hw = detectHighwayFromPath(path, { minCycles: 5, maxPeriod: 40 });
  assert.ok(hw !== null);
  assert.equal(hw.formationStep, C.LEGACY_HIGHWAY_ONSET_STEP);
  assert.equal(hw.period, C.LEGACY_HIGHWAY_PERIOD);
});

test('同じ軌跡を2回検出すると結果が完全一致する(決定論性)', () => {
  const r = E.simulateSolo(
    { cells: [], antX: 10, antY: 30, antDir: C.DIR_RIGHT, rule: C.LEGACY_RULE },
    { life: 300, trackPath: true },
  );
  const path = toUnwrappedDirPath(r.path);
  const hw1 = detectHighwayFromPath(path, { minCycles: 5, maxPeriod: 40 });
  const hw2 = detectHighwayFromPath(path, { minCycles: 5, maxPeriod: 40 });
  assert.deepEqual(hw1, hw2);
});

test('verifyHighwayStrict: LEGACY_RULE の回帰フィクスチャで採用された候補は厳密確認も通る', () => {
  // verifyHighwayStrict は genome.cells を { x, y, state } のオブジェクト形で直接読む
  // (simulateSolo に渡す [x,y,state] 配列形とは異なる)。
  const genome = { rule: C.LEGACY_RULE, antX: 10, antY: 30, antDir: C.DIR_RIGHT, cells: [] };
  const r = E.simulateSolo(
    { cells: [], antX: genome.antX, antY: genome.antY, antDir: genome.antDir, rule: genome.rule },
    { life: C.SEARCH_LIFE, trackPath: true },
  );
  const path = toUnwrappedDirPath(r.path);
  const candidate = detectHighwayFromPath(path);
  assert.ok(candidate !== null);
  assert.equal(candidate.period, C.LEGACY_HIGHWAY_PERIOD);
  assert.equal(verifyHighwayStrict(genome, candidate), true);
});
