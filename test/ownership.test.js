// docs/action-centric-contract.md §1.2/§1.3(差分仕様 §32)。
// 自軍アリ別 ownership map(coarseOwnedByAnt) の増分更新とスロット管理を検証する。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/config.js';
import { createMatch, fire, selfDestruct, createSideView } from '../src/engine.js';
import { encodeFeatures } from '../src/cpu.js';

function makeAction(antX, antY, cells) {
  return { kind: 'attack', rule: 'RL', cells, antX, antY, antDir: C.DIR_DOWN, templateId: 'T' };
}

function coarseBlockOf(x, y) {
  return (y >> C.COARSE_SHIFT) * C.COARSE_SIZE + (x >> C.COARSE_SHIFT);
}

test('§32 同じセルを自軍アリAが先・Bが後に踏むと、ownership が A から B へ移る', () => {
  const match = createMatch({ seed: 1 });
  match.sides[0].tokens = C.TOKEN_CAP;

  const sharedX = 20;
  const sharedY = 5;
  const idA = fire(match, 0, makeAction(10, 20, [[sharedX, sharedY, 1]]));
  const antA = match.sides[0].ants.find((a) => a.id === idA);
  const block = coarseBlockOf(sharedX, sharedY);
  assert.equal(match.coarseOwnedByAnt[0][antA.slot][block], 1, 'A の所有が計上されていない');

  const idB = fire(match, 0, makeAction(30, 20, [[sharedX, sharedY, 1]]));
  const antB = match.sides[0].ants.find((a) => a.id === idB);

  assert.equal(match.coarseOwnedByAnt[0][antA.slot][block], 0, 'B が踏み直したのに A の所有が残っている');
  assert.equal(match.coarseOwnedByAnt[0][antB.slot][block], 1, 'B の所有に計上されていない');
  // 同一陣営内の移動なので coarseOwnedBySide は変わらない
  assert.equal(match.coarseOwnedBySide[0][block], 1);
});

test('§32 A を自爆させても、B が最後に踏んだそのセルは消えない', () => {
  const match = createMatch({ seed: 1 });
  match.sides[0].tokens = C.TOKEN_CAP;

  const sharedX = 20;
  const sharedY = 5;
  const idA = fire(match, 0, makeAction(10, 20, [[sharedX, sharedY, 1], [0, 0, 1]]));
  const idB = fire(match, 0, makeAction(30, 20, [[sharedX, sharedY, 1], [1, 1, 1]]));

  const j = sharedY * C.WIDTH + sharedX;
  assert.equal(match.lastToucher[j], idB);

  selfDestruct(match, 0, idA);

  assert.equal(match.lastToucher[j], idB, 'B が最後に踏んだセルが A の自爆で消えてしまった');
  assert.notEqual(match.board[j], 0, 'B の配置マスが白紙に戻ってしまった');
});

test('§32 ownedTrailAmount × OWNED_TRAIL_SCALE_CELLS が、実際に cleanup されるセル数(lastToucher===antId)と一致する', () => {
  const match = createMatch({ seed: 5 });
  match.sides[0].tokens = C.TOKEN_CAP;

  // 複数の異なる coarse ブロックにまたがるセルを配置する(重ならない)。
  const cells = [
    [0, 0, 1],
    [8, 0, 1],
    [0, 8, 1],
    [16, 16, 1],
  ];
  const antId = fire(match, 0, makeAction(50, 50, cells));
  const ant = match.sides[0].ants.find((a) => a.id === antId);

  // 実際に lastToucher === antId のセル数を数える(実測)。
  let actualOwned = 0;
  for (let q = 0; q < match.lastToucher.length; q++) {
    if (match.lastToucher[q] === antId) actualOwned++;
  }
  assert.equal(actualOwned, cells.length);

  const view = createSideView(match, 0);
  const myAnt = view.myAnts.find((a) => a.id === antId);
  assert.ok(myAnt, 'view に自軍アリが見えていない');
  const action = { type: 'SELF_DESTRUCT', antId, slot: myAnt.slot, ant: myAnt };
  // templateId が未設定('T' は templateById に無い)なので #24/#25 は 0 のまま計算される。
  const ctx = { avail: 0, committed: 0, templateById: new Map(), bandArrays: null, bandCache: new Map(), trailCache: new Map() };
  const out = encodeFeatures(view, action, ctx);
  // ⚠️ v6.2: #21(ownedTrailAmount)は `clamp(owned / OWNED_TRAIL_SCALE_CELLS, 0, 1)` になった
  // (契約 §5.0)。所有セル数がスケール未満のときだけ「× スケール = 実セル数」の等式が成り立つ
  // (スケール以上ではクランプで潰れて一致しなくなる)。このテストは少数セルしか配置しない
  // ケースなので、まずスケール未満であることを前提として assert してから等式を検査する。
  assert.ok(actualOwned < C.OWNED_TRAIL_SCALE_CELLS, 'テストの前提が壊れている(所有セル数がクランプ域に入っている)');
  const predictedOwned = Math.round(out[21] * C.OWNED_TRAIL_SCALE_CELLS);
  assert.equal(predictedOwned, actualOwned);

  // 実際に自爆させて、cleanup されたセル数(lastToucher===antId だったセル)が一致することを確認する。
  let clearedCount = 0;
  for (let q = 0; q < match.lastToucher.length; q++) {
    if (match.lastToucher[q] === antId) clearedCount++;
  }
  selfDestruct(match, 0, antId);
  for (let q = 0; q < match.lastToucher.length; q++) {
    assert.notEqual(match.lastToucher[q], antId, 'cleanup 後も lastToucher が残っている');
  }
  assert.equal(clearedCount, actualOwned);
});

test('§32 アリ消滅後にスロットが解放され、coarseOwnedByAnt[side][slot] が全0になる', () => {
  const match = createMatch({ seed: 1 });
  match.sides[0].tokens = C.TOKEN_CAP;
  const antId = fire(match, 0, makeAction(10, 20, [[0, 0, 1], [1, 1, 1]]));
  const ant = match.sides[0].ants.find((a) => a.id === antId);
  const slot = ant.slot;

  assert.equal(match.antSlotOccupant[0][slot], antId);
  const sumBefore = match.coarseOwnedByAnt[0][slot].reduce((s, v) => s + v, 0);
  assert.ok(sumBefore > 0, 'テストの前提が壊れている(所有セルが無い)');

  selfDestruct(match, 0, antId);

  assert.equal(match.antSlotOccupant[0][slot], -1, 'スロットが解放されていない');
  const sumAfter = match.coarseOwnedByAnt[0][slot].reduce((s, v) => s + v, 0);
  assert.equal(sumAfter, 0, 'coarseOwnedByAnt が全0に戻っていない');
});

test('§32 不変条件: Σ_slot coarseOwnedByAnt[s][slot][b] === coarseOwnedBySide[s][b] === 実測の lastToucherSide カウント', () => {
  const match = createMatch({ seed: 3 });
  match.sides[0].tokens = C.TOKEN_CAP;
  match.sides[1].tokens = C.TOKEN_CAP;

  // 複数アリを両陣営で発射し、一部は同じセルを踏み直させる(所有の移動を発生させる)。
  fire(match, 0, makeAction(10, 5, [[0, 0, 1], [5, 5, 1]]));
  fire(match, 0, makeAction(10, 5, [[0, 0, 1], [9, 9, 1]])); // 1つ目のセルを踏み直す
  fire(match, 1, makeAction(200, 5, [[0, 0, 1], [3, 3, 1]]));
  fire(match, 1, makeAction(200, 5, [[1, 1, 1]]));

  for (let s = 0; s < 2; s++) {
    for (let b = 0; b < C.COARSE_COUNT; b++) {
      let sumSlots = 0;
      for (let slot = 0; slot < C.MAX_FLYING; slot++) sumSlots += match.coarseOwnedByAnt[s][slot][b];
      assert.equal(sumSlots, match.coarseOwnedBySide[s][b], `side=${s} block=${b} の Σslot が一致しない`);
    }
  }

  // coarseOwnedBySide が実測の lastToucherSide カウントと一致することも確認する。
  const actual = [new Int32Array(C.COARSE_COUNT), new Int32Array(C.COARSE_COUNT)];
  for (let gy = 0; gy < C.HEIGHT; gy++) {
    for (let x = 0; x < C.WIDTH; x++) {
      const j = gy * C.WIDTH + x;
      const side = match.lastToucherSide[j];
      if (side === 0) continue;
      const b = (gy >> C.COARSE_SHIFT) * C.COARSE_SIZE + (x >> C.COARSE_SHIFT);
      actual[side - 1][b]++;
    }
  }
  assert.deepEqual(Array.from(match.coarseOwnedBySide[0]), Array.from(actual[0]));
  assert.deepEqual(Array.from(match.coarseOwnedBySide[1]), Array.from(actual[1]));
});
