// docs/action-centric-contract.md §1.1/§1.4/§5.2 (差分仕様 §31)。
// 32×32 粗視化盤面(coarseNonWhite)の増分更新と、encodeFeatures の band 特徴(#8/#10/#12/#14)の
// 対応関係を検証する。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/config.js';
import { createMatch, fire, stepMatch } from '../src/engine.js';
import { encodeFeatures } from '../src/cpu.js';

/** match.board を全走査して coarseNonWhite を独立に計算する(実測値)。 */
function scanCoarseNonWhite(match) {
  const out = new Int32Array(C.COARSE_COUNT);
  for (let gy = 0; gy < C.HEIGHT; gy++) {
    const cy = gy >> C.COARSE_SHIFT;
    for (let x = 0; x < C.WIDTH; x++) {
      if (match.board[gy * C.WIDTH + x] !== 0) {
        out[cy * C.COARSE_SIZE + (x >> C.COARSE_SHIFT)]++;
      }
    }
  }
  return out;
}

function makeAttackAction(antX, antY, cells) {
  return { kind: 'attack', rule: 'RL', cells, antX, antY, antDir: C.DIR_DOWN, templateId: 'T' };
}

function baseCtx(overrides = {}) {
  return {
    avail: 0,
    committed: 0,
    weights: new Array(C.ACTION_FEATURE_COUNT).fill(0),
    bandArrays: null,
    bandCache: new Map(),
    trailCache: new Map(),
    ...overrides,
  };
}

function fireAction(kind, launchX, antY) {
  return {
    type: 'FIRE',
    kind,
    launchX,
    atStep: 0,
    cost: 0,
    template: { antY },
  };
}

function baseView(overrides = {}) {
  return {
    sideIndex: 0,
    step: 0,
    tokens: 0,
    flyingCount: 0,
    myAnts: [],
    enemyAnts: [],
    coarseNonWhite: new Int32Array(C.COARSE_COUNT),
    coarseOwnedMine: new Int32Array(C.COARSE_COUNT),
    coarseOwnedEnemy: new Int32Array(C.COARSE_COUNT),
    coarseAntOwned: new Array(C.MAX_FLYING).fill(null),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. 増分更新が全盤面走査の実測値と一致する
// ---------------------------------------------------------------------------

test('§31 セルを書き換えると coarseNonWhite が増分で追従する(全盤面走査した実測値と一致する)', () => {
  const match = createMatch({ seed: 1 });
  match.sides[0].tokens = C.TOKEN_CAP;
  match.sides[1].tokens = C.TOKEN_CAP;

  fire(match, 0, makeAttackAction(10, 5, [[0, 0, 1], [1, 0, 1], [0, 1, 1]]));
  fire(match, 1, makeAttackAction(200, 5, [[0, 0, 1], [2, 0, 1]]));

  for (let i = 0; i < 40; i++) stepMatch(match);

  assert.deepEqual(Array.from(match.coarseNonWhite), Array.from(scanCoarseNonWhite(match)));

  // さらにアリを消滅させて(寿命切れではなく単純に何ステップか進めて盤面が変わった後)も一致すること
  for (let i = 0; i < 200; i++) stepMatch(match);
  assert.deepEqual(Array.from(match.coarseNonWhite), Array.from(scanCoarseNonWhite(match)));
});

// ---------------------------------------------------------------------------
// 2. band 分離: 特定の band だけ盤面を変えると、対応する band 特徴だけが変化する
// ---------------------------------------------------------------------------

test('§31 band0 だけ盤面を変えると occupancyBand0(#8) だけが変化する(他 band は0のまま)', () => {
  const cx = 5;
  const view = baseView();
  // band0 = グローバル coarse 行 0..7
  view.coarseNonWhite[2 * C.COARSE_SIZE + cx] = 10;
  const action = fireAction('disrupt', cx * C.COARSE_BLOCK, 0);
  const out = encodeFeatures(view, action, baseCtx());
  assert.ok(out[8] > 0, 'band0 occupancy が変化していない');
  assert.equal(out[10], 0, 'band1 occupancy が影響を受けている');
  assert.equal(out[12], 0, 'band2 occupancy が影響を受けている');
  assert.equal(out[14], 0, 'band3 occupancy が影響を受けている');
});

test('§31 band1(グローバル行8..15)だけ変えると occupancyBand1(#10) だけが変化する', () => {
  const cx = 5;
  const view = baseView();
  view.coarseNonWhite[10 * C.COARSE_SIZE + cx] = 10; // 行10 は band1(8..15)
  const action = fireAction('disrupt', cx * C.COARSE_BLOCK, 0);
  const out = encodeFeatures(view, action, baseCtx());
  assert.equal(out[8], 0);
  assert.ok(out[10] > 0);
  assert.equal(out[12], 0);
  assert.equal(out[14], 0);
});

test('§31 band2(グローバル行16..23)だけ変えると occupancyBand2(#12) だけが変化する', () => {
  const cx = 5;
  const view = baseView();
  view.coarseNonWhite[18 * C.COARSE_SIZE + cx] = 10; // 行18 は band2(16..23)
  const action = fireAction('disrupt', cx * C.COARSE_BLOCK, 0);
  const out = encodeFeatures(view, action, baseCtx());
  assert.equal(out[8], 0);
  assert.equal(out[10], 0);
  assert.ok(out[12] > 0);
  assert.equal(out[14], 0);
});

test('§31 band3(グローバル行24..31)だけ変えると occupancyBand3(#14) だけが変化する', () => {
  const cx = 5;
  const view = baseView();
  view.coarseNonWhite[26 * C.COARSE_SIZE + cx] = 10; // 行26 は band3(24..31)
  const action = fireAction('disrupt', cx * C.COARSE_BLOCK, 0);
  const out = encodeFeatures(view, action, baseCtx());
  assert.equal(out[8], 0);
  assert.equal(out[10], 0);
  assert.equal(out[12], 0);
  assert.ok(out[14] > 0);
});

test('§31 ownership(#9/#11/#13/#15)も対応する band だけが変化する', () => {
  const cx = 7;
  const view = baseView();
  view.coarseOwnedEnemy[20 * C.COARSE_SIZE + cx] = 5; // 行20 は band2(16..23)
  const action = fireAction('disrupt', cx * C.COARSE_BLOCK, 0);
  const out = encodeFeatures(view, action, baseCtx());
  assert.equal(out[9], 0);
  assert.equal(out[11], 0);
  assert.ok(out[13] > 0, 'band2 ownership が変化していない');
  assert.equal(out[15], 0);
});

// ---------------------------------------------------------------------------
// 3. anchorX を変えると水平カーネル Kx により band 特徴が変化する
// ---------------------------------------------------------------------------

test('§31 anchorX を変えると水平カーネルにより band 特徴が変化する', () => {
  const dirtyCx = 5;
  const view = baseView();
  view.coarseNonWhite[2 * C.COARSE_SIZE + dirtyCx] = 10;

  const nearAction = fireAction('disrupt', dirtyCx * C.COARSE_BLOCK, 0); // anchorCx = dirtyCx, d=0
  const farCx = (dirtyCx + C.COARSE_SIZE / 2) % C.COARSE_SIZE; // トーラスで正反対 d=16 → Kx=0
  const farAction = fireAction('disrupt', farCx * C.COARSE_BLOCK, 0);

  const outNear = encodeFeatures(view, nearAction, baseCtx());
  const outFar = encodeFeatures(view, farAction, baseCtx());
  assert.ok(outNear[8] > 0, 'anchor が汚れた列そのものなのに0になっている');
  assert.equal(outFar[8], 0, 'anchor が正反対(Kx=0)なのに寄与が残っている');
  assert.notEqual(outNear[8], outFar[8]);
});

// ---------------------------------------------------------------------------
// 4. X の wrap 境界(x=255 と x=0)でトーラス距離が連続する
// ---------------------------------------------------------------------------

test('§31 X の wrap 境界が連続する: anchorX=0 側と anchorX=255 側で対称な配置の特徴が一致する', () => {
  // 列1(anchor 0 からトーラス距離1)を汚す構成と、列30(anchor 31 からトーラス距離1)を
  // 汚す構成は、Kx(1) が同じなので同じ値になるはず。
  const viewA = baseView();
  viewA.coarseNonWhite[2 * C.COARSE_SIZE + 1] = 10;
  const actionA = fireAction('disrupt', 0, 0); // anchorX=0 → anchorCx=0

  const viewB = baseView();
  viewB.coarseNonWhite[2 * C.COARSE_SIZE + 30] = 10;
  const actionB = fireAction('disrupt', 255, 0); // anchorX=255 → anchorCx=31

  const outA = encodeFeatures(viewA, actionA, baseCtx());
  const outB = encodeFeatures(viewB, actionB, baseCtx());
  assert.ok(outA[8] > 0);
  assert.equal(outA[8], outB[8], 'wrap 境界をまたぐと連続性が崩れている');
});

// ---------------------------------------------------------------------------
// 5. side1 でもローカルY の向きが side0 と一致する(核心のテスト)
// ---------------------------------------------------------------------------

test('§31 side0/side1 とも「自陣側の帯」に置いた汚れが band0 に出る', () => {
  const cx = 9;
  // side0 の自陣側 = グローバル coarse 行 0..7。side1 の自陣側 = グローバル coarse 行 24..31
  // (coarseLocalRow(1, 28) = 3 → band0)。それぞれ独立した盤面で、自分の自陣側だけを汚す。
  const coarse0 = new Int32Array(C.COARSE_COUNT);
  coarse0[3 * C.COARSE_SIZE + cx] = 10;
  const coarse1 = new Int32Array(C.COARSE_COUNT);
  coarse1[28 * C.COARSE_SIZE + cx] = 10;

  const view0 = baseView({ sideIndex: 0, coarseNonWhite: coarse0 });
  const view1 = baseView({ sideIndex: 1, coarseNonWhite: coarse1 });
  const action = fireAction('disrupt', cx * C.COARSE_BLOCK, 0);

  const out0 = encodeFeatures(view0, action, baseCtx());
  const out1 = encodeFeatures(view1, action, baseCtx());

  assert.ok(out0[8] > 0, 'side0 の band0 が反応していない');
  assert.equal(out0[10], 0);
  assert.equal(out0[12], 0);
  assert.equal(out0[14], 0);

  assert.ok(out1[8] > 0, 'side1 の band0 が反応していない(自陣ローカルYの向きがsideで一致していない)');
  assert.equal(out1[10], 0);
  assert.equal(out1[12], 0);
  assert.equal(out1[14], 0);

  assert.equal(out0[8], out1[8], '同じ密度の自陣側汚れなのに side0/side1 で band0 の値が違う');
});
