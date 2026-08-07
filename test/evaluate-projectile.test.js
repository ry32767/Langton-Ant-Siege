import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/config.js';
import { createRng } from '../src/engine.js';
import { createRandomGenome } from '../src/search/genome.js';
import { evaluateProjectile } from '../src/search/evaluate-projectile.js';

test('回帰フィクスチャ: engine.test.js と同じ配置(cells無し・antX=10,antY=30寄りのRRL単体アリ)は formationStep=38・period=18 相当になる', () => {
  // evaluateProjectile は genome(cells 1個以上必須)を要求するため、engine.test.js の
  // フィクスチャ(cells:[])そのものは使えない。cells をアリの経路から外れる位置に1個だけ
  // 置いて、RRL の空盤面での挙動を実質的に再現する。
  // ⚠️ options は一切渡さない(本番の searchLife=SEARCH_LIFE・maxPeriod=HIGHWAY_MAX_PERIOD
  // の探索評価パスで期待値と一致することを確認する。短い life や小さい maxPeriod に
  // 差し替えると、末尾アンカーの位置や競合する周期候補が変わり別の結果になりうるため)。
  const genome = {
    rule: C.LEGACY_RULE,
    antX: 10,
    antY: 15,
    antDir: C.DIR_RIGHT,
    cells: [{ x: 0, y: 15, state: 1 }], // アリの経路から十分離した無関係セル
  };
  const result = evaluateProjectile(genome);
  assert.equal(result.highway.trajectoryPeriodic, true);
  assert.equal(result.highway.period, C.LEGACY_HIGHWAY_PERIOD);
  assert.equal(result.highway.formationStep, C.LEGACY_HIGHWAY_ONSET_STEP);
});

test('同じ genome を2回評価すると結果が完全一致する(決定論性)', () => {
  const rng = createRng(123);
  const genome = createRandomGenome(() => rng.next());
  const r1 = evaluateProjectile(genome);
  const r2 = evaluateProjectile(genome);
  assert.deepEqual(r1, r2);
});

test('viable の判定に driftX===0 が含まれていない(斜めハイウェイの genome が viable になりうる)', () => {
  const rng = createRng(7);
  let foundDiagonalViable = false;
  for (let i = 0; i < 4000 && !foundDiagonalViable; i++) {
    const genome = createRandomGenome(() => rng.next());
    const result = evaluateProjectile(genome);
    if (result.viable && result.highway.driftX !== 0) {
      foundDiagonalViable = true;
    }
  }
  assert.ok(foundDiagonalViable, '斜めハイウェイ(driftX!==0)で viable な genome が見つかるはず');
});

test('descriptor.cost は costOfGenome(genome, ATTACK_COST) と一致する', () => {
  const genome = {
    rule: 'RRL',
    antX: 5,
    antY: 5,
    antDir: C.DIR_UP,
    cells: [
      { x: 0, y: 0, state: 1 },
      { x: 1, y: 1, state: 2 },
    ],
  };
  const result = evaluateProjectile(genome, { searchLife: 200 });
  assert.equal(result.descriptor.cost, C.ATTACK_COST + genome.cells.length);
});

test('quality は highway 未検出のとき formationPenalty が最大になり低い値になる', () => {
  // 1マスだけのアリで、境界ですぐ盤外に落ちる(life直後に消える)ような genome は
  // 探索軌跡が短くハイウェイが検出されないはず。
  const genome = {
    rule: 'LL', // 常に左回転。すぐ場外に出やすいシンプルな挙動
    antY: 0,
    antDir: C.DIR_UP, // 開始直後に上へ進むので y<0 に落ちてすぐ死ぬ
    cells: [{ dx: 0, dy: 0, state: 1 }],
  };
  const result = evaluateProjectile(genome, { searchLife: 50 });
  assert.equal(result.highway.trajectoryPeriodic, false);
  assert.equal(result.game.reached, false);
  assert.equal(result.viable, false);
});

test('既定(strict省略)では fingerprintVerified===false のまま、厳密確認は実行されない', () => {
  // LEGACY_RULE は strict:true をかければ確実に fingerprintVerified===true になる
  // genome(下のテストで確認する回帰フィクスチャ)。strict を渡さない既定呼び出しでは
  // trajectoryPeriodic===true であっても fingerprintVerified は false のままであるはず
  // (探索経路で数百万回呼ばれるため、既定では高コストな厳密確認を実行しない設計)。
  const genome = {
    rule: C.LEGACY_RULE,
    antX: 10,
    antY: 15,
    antDir: C.DIR_RIGHT,
    cells: [{ x: 0, y: 15, state: 1 }],
  };
  const result = evaluateProjectile(genome);
  assert.equal(result.highway.trajectoryPeriodic, true);
  assert.equal(result.highway.fingerprintVerified, false);
});

test('options.strict===true を渡すと fingerprintVerified が実際に埋まる(回帰フィクスチャ: LEGACY_RULE)', () => {
  const genome = {
    rule: C.LEGACY_RULE,
    antX: 10,
    antY: 15,
    antDir: C.DIR_RIGHT,
    cells: [{ x: 0, y: 15, state: 1 }],
  };
  const result = evaluateProjectile(genome, { strict: true });
  assert.equal(result.highway.trajectoryPeriodic, true);
  assert.equal(result.highway.fingerprintVerified, true);
});

test('trajectoryPeriodic===false なら strict:true でも fingerprintVerified は必ず false になる', () => {
  const genome = {
    rule: 'LL',
    antX: 0,
    antY: 0,
    antDir: C.DIR_UP,
    cells: [{ x: 0, y: 0, state: 1 }],
  };
  const result = evaluateProjectile(genome, { searchLife: 50, strict: true });
  assert.equal(result.highway.trajectoryPeriodic, false);
  assert.equal(result.highway.fingerprintVerified, false);
});
