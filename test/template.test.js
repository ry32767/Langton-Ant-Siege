// src/template.js(相対テンプレート → 絶対座標の変換)の単体テスト。
// engine / cpu / app / scripts が全部この変換を共有しているので、ここが崩れると
// 「テンプレートは正しいのに撃つと別物が出る」という一番追いにくい壊れ方をする。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/config.js';
import { instantiateTemplate, wrapX, scoringLaunchColumns, launchColumnScores } from '../src/template.js';
import { simulateSolo } from '../src/engine.js';

const baseTemplate = {
  rule: 'RRL',
  antY: 5,
  antDir: C.DIR_DOWN,
  cells: [
    [0, 0, 1],
    [2, -1, 2],
    [-3, 3, 0],
  ],
};

test('wrapX はトーラスの範囲に正規化する(負の値も)', () => {
  assert.equal(wrapX(0), 0);
  assert.equal(wrapX(C.WIDTH - 1), C.WIDTH - 1);
  assert.equal(wrapX(C.WIDTH), 0);
  assert.equal(wrapX(-1), C.WIDTH - 1);
  assert.equal(wrapX(-C.WIDTH - 3), C.WIDTH - 3);
});

test('instantiateTemplate は cells を (antX+dx) mod WIDTH と antY+dy の絶対座標にする', () => {
  const inst = instantiateTemplate(baseTemplate, 100);
  assert.equal(inst.antX, 100);
  assert.equal(inst.antY, 5);
  assert.equal(inst.antDir, C.DIR_DOWN);
  assert.deepEqual(inst.cells, [
    [100, 5, 1],
    [102, 4, 2],
    [97, 8, 0],
  ]);
});

test('instantiateTemplate は x の折り返しを正しく扱う(左端・右端をまたぐ)', () => {
  const inst = instantiateTemplate(baseTemplate, 1);
  // dx=-3 は x=1-3=-2 → WIDTH-2
  assert.deepEqual(inst.cells[2], [C.WIDTH - 2, 8, 0]);

  const inst2 = instantiateTemplate(baseTemplate, C.WIDTH - 1);
  // dx=2 は x=WIDTH-1+2 → 1
  assert.deepEqual(inst2.cells[1], [1, 4, 2]);
});

test('instantiateTemplate は antX を WIDTH で正規化する(範囲外・負の値も受ける)', () => {
  assert.equal(instantiateTemplate(baseTemplate, C.WIDTH + 7).antX, 7);
  assert.equal(instantiateTemplate(baseTemplate, -1).antX, C.WIDTH - 1);
});

test('x の平行移動は軌道を平行移動させるだけ(力学の対称性。発射列可変の根拠)', () => {
  // 同じテンプレートを別の列から撃つと、到達ステップ数は同じで、到達列だけが平行移動する。
  // これが成り立たないと counterTable を deltaX の表にできない。
  const a = simulateSolo(instantiateTemplate(baseTemplate, 0), { life: C.GAME_LIFE_SEARCH_CAP });
  for (const shift of [1, 37, 128, C.WIDTH - 1]) {
    const b = simulateSolo(instantiateTemplate(baseTemplate, shift), { life: C.GAME_LIFE_SEARCH_CAP });
    assert.equal(b.steps, a.steps, `shift=${shift} で到達ステップ数が変わった`);
    assert.equal(b.reached, a.reached, `shift=${shift} で到達判定が変わった`);
    assert.equal(b.endY, a.endY, `shift=${shift} で終端 y が変わった`);
    assert.equal(b.endX, wrapX(a.endX + shift), `shift=${shift} で終端 x が平行移動になっていない`);
  }
});

test('scoringLaunchColumns は得点ゲートに届く発射列の連続区間(幅 SCORE_GATE_WIDTH)を返す', () => {
  // entryXAt0=0 なら、到達列 = antX なので、そのままゲートの範囲が答えになる
  const tpl = { ...baseTemplate, entryXAt0: 0 };
  const cols = scoringLaunchColumns(tpl);
  assert.equal(cols.min, C.SCORE_GATE_X_MIN);
  assert.equal(cols.count, C.SCORE_GATE_WIDTH);

  // entryXAt0 の分だけ区間が左にずれる
  const shifted = scoringLaunchColumns({ ...baseTemplate, entryXAt0: 10 });
  assert.equal(shifted.min, wrapX(C.SCORE_GATE_X_MIN - 10));
  assert.equal(shifted.count, C.SCORE_GATE_WIDTH);

  // 到達しないテンプレート(entryXAt0 が無い)は「撃てる列が無い」
  assert.deepEqual(scoringLaunchColumns(baseTemplate), { min: 0, count: 0 });
});

test('launchColumnScores は scoringLaunchColumns の区間とちょうど一致する', () => {
  for (const entryXAt0 of [0, 10, 200, C.WIDTH - 1]) {
    const tpl = { ...baseTemplate, entryXAt0 };
    const cols = scoringLaunchColumns(tpl);
    const inRange = new Set();
    for (let i = 0; i < cols.count; i++) inRange.add(wrapX(cols.min + i));
    for (let antX = 0; antX < C.WIDTH; antX++) {
      assert.equal(
        launchColumnScores(tpl, antX),
        inRange.has(antX),
        `entryXAt0=${entryXAt0} antX=${antX} で区間と判定が食い違う`,
      );
    }
  }
});

test('得点ゲートの外へ到達する発射列では、実際に得点しない(engine と整合する)', () => {
  // 得点する軌道を1つ作り、その entryXAt0 からゲート内/外の発射列を組み立てて engine で確かめる。
  const probe = simulateSolo(instantiateTemplate(baseTemplate, 0), { life: C.GAME_LIFE_SEARCH_CAP });
  if (!probe.reached) return; // このフィクスチャが到達しない場合は検証対象外
  const tpl = { ...baseTemplate, entryXAt0: probe.endX };
  const cols = scoringLaunchColumns(tpl);

  const insideX = wrapX(cols.min + Math.floor(cols.count / 2));
  const outsideX = wrapX(cols.min - 1);
  const inside = simulateSolo(instantiateTemplate(tpl, insideX), { life: C.GAME_LIFE_SEARCH_CAP });
  const outside = simulateSolo(instantiateTemplate(tpl, outsideX), { life: C.GAME_LIFE_SEARCH_CAP });

  assert.equal(inside.reached, true);
  assert.equal(inside.scored, true, 'ゲート内の発射列なのに得点していない');
  assert.equal(outside.reached, true, 'ゲート外でも敵陣には到達するはず');
  assert.equal(outside.scored, false, 'ゲート外の発射列なのに得点している');
});
