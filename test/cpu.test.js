// src/cpu.js の単体テスト。docs/action-centric-contract.md(v6・差分仕様 §34)に対応する。
//
// v6 で旧 policy(fireThreshold / reserveTokens / defendBias / escortBias / attackPref /
// selfDestructBias / selfDestructRemainingTicks)を全廃し、24次元の線形 Action 評価器
// (weights)に置き換えた。このファイルは v6 の契約(戦術非固定・固定優先順位が無い・
// engine を import しない・決定論・予約発射)だけを検証する。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as C from '../src/config.js';
import { createCpuAgent } from '../src/cpu.js';
import { createRng } from '../src/engine.js';

const CPU_SOURCE_PATH = fileURLToPath(new URL('../src/cpu.js', import.meta.url));
const CPU_SOURCE = readFileSync(CPU_SOURCE_PATH, 'utf8');

// ---------------------------------------------------------------------------
// fixture: 攻撃1種・妨害1種の小さなテンプレート集
// ---------------------------------------------------------------------------

function makeTemplates() {
  const A1 = {
    id: 'A1',
    kind: 'attack',
    rule: 'RRL',
    colorCount: 3,
    cells: [[3, 21, 1]],
    antY: 23,
    antDir: 1,
    entryXAt0: 0,
    // ⚠️ arrivalStep をわざと持たせない(effectDelay を counter 候補と区別するテストのため)。
  };
  const D1 = {
    id: 'D1',
    kind: 'disrupt',
    rule: 'RL',
    colorCount: 2,
    cells: [[6, 5, 1]],
    antY: 6,
    antDir: 1,
  };
  return {
    attack: [A1],
    disrupt: [D1],
    identifyTable: { '12,1': 'A1' },
    counterTable: {
      A1: [{ disruptId: 'D1', deltaX: 0, fireAtStep: 300, successRate: 1.0 }],
    },
    escortTable: {},
  };
}

function zeros() {
  return new Array(C.ACTION_FEATURE_COUNT).fill(0);
}

function baseView(overrides = {}) {
  return {
    sideIndex: 0,
    step: 0,
    tokens: 30,
    score: 0,
    enemyScore: 0,
    flyingCount: 0,
    myAnts: [],
    enemyAnts: [],
    boardPollution: 0,
    myZonePollution: 0,
    enemyZonePollution: 0,
    columnNonWhite: new Int32Array(C.WIDTH),
    coarseNonWhite: new Int32Array(C.COARSE_COUNT),
    coarseOwnedMine: new Int32Array(C.COARSE_COUNT),
    coarseOwnedEnemy: new Int32Array(C.COARSE_COUNT),
    coarseAntOwned: new Array(C.MAX_FLYING).fill(null),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 静的検査: engine.js を import していない(残す)
// ---------------------------------------------------------------------------

test('src/cpu.js は src/engine.js を import していない(実行時探索をしない設計の担保)', () => {
  assert.ok(!/from\s+['"][^'"]*engine(\.js)?['"]/.test(CPU_SOURCE), 'engine.js の import 文がある');
  assert.ok(!/require\(\s*['"][^'"]*engine(\.js)?['"]\s*\)/.test(CPU_SOURCE), 'engine.js の require がある');
  assert.ok(!/^\s*import[\s\S]*?engine(\.js)?['"]/m.test(CPU_SOURCE), 'engine.js を参照する import 文がある');
});

// ---------------------------------------------------------------------------
// 旧方策パラメータ名が src/cpu.js のソースに1つも出現しないこと
// ---------------------------------------------------------------------------

test('§34 旧方策パラメータ名が src/cpu.js のソースに1つも出現しない', () => {
  const legacyFieldNames = [
    'fireThreshold',
    'reserveTokens',
    'defendBias',
    'escortBias',
    'attackPref',
    'selfDestructBias',
    'selfDestructRemainingTicks',
  ];
  for (const name of legacyFieldNames) {
    assert.ok(!CPU_SOURCE.includes(name), `旧方策パラメータ名 "${name}" がまだソースに残っている`);
  }
});

// ---------------------------------------------------------------------------
// §34 戦術非固定: attack FIRE / disrupt FIRE / SELF_DESTRUCT / WAIT の4種すべてが
// 同時に候補に存在する state を作り、weights を変えることで4種それぞれを選択させられる
// ---------------------------------------------------------------------------

function decisionView() {
  return baseView({
    step: 0,
    tokens: 30,
    flyingCount: 1,
    myAnts: [{ id: 9, slot: 0, kind: 'attack', x: 10, y: 10, steps: 0, life: 20000 }],
    enemyAnts: [],
  });
}

test('§34 weights[0]=1 のとき attack FIRE が選ばれる', () => {
  const templates = makeTemplates();
  const weights = zeros();
  weights[0] = 1; // isAttackFire
  const agent = createCpuAgent({ templates, weights, rng: createRng(1) });
  const action = agent.decide(decisionView());
  assert.ok(action, 'attack FIRE が選ばれなかった');
  assert.equal(action.kind, 'attack');
});

test('§34 weights[1]=1 のとき disrupt FIRE が選ばれる', () => {
  const templates = makeTemplates();
  const weights = zeros();
  weights[1] = 1; // isDisruptFire
  const agent = createCpuAgent({ templates, weights, rng: createRng(1) });
  const action = agent.decide(decisionView());
  assert.ok(action, 'disrupt FIRE が選ばれなかった');
  assert.equal(action.kind, 'disrupt');
});

test('§34 weights[2]=1 のとき SELF_DESTRUCT が選ばれる', () => {
  const templates = makeTemplates();
  const weights = zeros();
  weights[2] = 1; // isSelfDestruct
  const destroyed = [];
  const agent = createCpuAgent({ templates, weights, rng: createRng(1), selfDestruct: (id) => destroyed.push(id) });
  const action = agent.decide(decisionView());
  assert.equal(action, null, 'SELF_DESTRUCT は decide の戻り値が null のはず');
  assert.deepEqual(destroyed, [9]);
});

test('§34 全weightsが0のとき WAIT が選ばれる(何も撃たない・自爆しない)', () => {
  const templates = makeTemplates();
  const weights = zeros();
  const destroyed = [];
  const scheduled = [];
  const agent = createCpuAgent({
    templates,
    weights,
    rng: createRng(1),
    selfDestruct: (id) => destroyed.push(id),
    scheduleFire: (action, atStep) => scheduled.push({ action, atStep }),
  });
  const action = agent.decide(decisionView());
  assert.equal(action, null);
  assert.deepEqual(destroyed, []);
  assert.deepEqual(scheduled, []);
});

// ---------------------------------------------------------------------------
// 固定優先順位が存在しないこと: counter 由来の妨害 と 攻撃 のどちらも weights 次第で選べる
// ---------------------------------------------------------------------------

function counterVsAttackView() {
  return baseView({
    step: 0,
    tokens: 30,
    flyingCount: 0,
    myAnts: [],
    // A1(antY=23,antDir=1)を identifyTable のキー "12,1" で識別できるようにするため、
    // ここでは identifyTable 側を "12,1" にしてあるので敵アリの spawnY/spawnDir を合わせる。
    enemyAnts: [
      { id: 1, kind: 'attack', x: 40, spawnX: 14, spawnY: 12, spawnDir: 1, ownerX: 40, ownerY: 12, ownerDir: 1, firedAtStep: 0 },
    ],
  });
}

test('固定優先順位が無い: weights[0]=1(攻撃を優先)で attack が選ばれる', () => {
  const templates = makeTemplates();
  const weights = zeros();
  weights[0] = 1; // isAttackFire。effectDelay(#5)は0のまま
  const scheduled = [];
  const agent = createCpuAgent({ templates, weights, rng: createRng(1), scheduleFire: (a, s) => scheduled.push({ a, s }) });
  const action = agent.decide(counterVsAttackView());
  assert.ok(action, '攻撃が選ばれなかった');
  assert.equal(action.kind, 'attack');
  assert.deepEqual(scheduled, [], 'counter 由来の妨害が予約されてしまっている');
});

test('固定優先順位が無い: weights[5]=1(effectDelayを優先)で counter 由来の妨害が選ばれる', () => {
  const templates = makeTemplates();
  const weights = zeros();
  // 攻撃(即時 atStep===step)は effectDelay=0。counter 由来の妨害(atStep=300>step=0)は
  // effectDelay>0。同じ weights[5] だけを見れば、優先順位を書かなくても counter が勝つ。
  weights[5] = 1;
  const scheduled = [];
  const agent = createCpuAgent({ templates, weights, rng: createRng(1), scheduleFire: (a, s) => scheduled.push({ a, s }) });
  const action = agent.decide(counterVsAttackView());
  assert.equal(action, null, '予約発射のはずなのに即時アクションが返っている');
  assert.equal(scheduled.length, 1, 'counter 由来の妨害が予約されなかった');
  assert.equal(scheduled[0].a.kind, 'disrupt');
  assert.equal(scheduled[0].s, 300); // firedAtStep(0) + fireAtStep(300)
});

// ---------------------------------------------------------------------------
// 決定論: 同じシード・同じ view 列で decide の結果が完全に一致する
// ---------------------------------------------------------------------------

test('決定論: 同じシード・同じ view 列で decide の結果が完全に一致する', () => {
  const templates = makeTemplates();
  const weights = [1, 0.5, 0.2, 0.1, -0.3, 0.7, 0, 0, 0.1, -0.1, 0, 0, 0, 0, 0, 0, 0.2, 0, 0.1, 0, 0.3, 0.4, 0, 0];
  const views = [
    baseView({ step: 0, tokens: 30 }),
    counterVsAttackView(),
    decisionView(),
    baseView({ step: 3, tokens: 30 }),
  ];

  const run = () => {
    const scheduled = [];
    const destroyed = [];
    const agent = createCpuAgent({
      templates,
      weights,
      rng: createRng(7),
      scheduleFire: (action, atStep) => scheduled.push({ action, atStep }),
      selfDestruct: (id) => destroyed.push(id),
    });
    const decisions = views.map((v) => agent.decide(v));
    return { decisions, scheduled, destroyed };
  };

  const r1 = run();
  const r2 = run();
  assert.deepEqual(r1, r2);
});

// ---------------------------------------------------------------------------
// 予約発射(atStep > view.step)で scheduleFire が呼ばれ、decide は null を返す
// ---------------------------------------------------------------------------

test('予約発射(atStep > view.step)で scheduleFire が呼ばれ、decide は null を返す', () => {
  const templates = makeTemplates();
  const weights = zeros();
  weights[5] = 1; // effectDelay を優先 → counter(予約)が勝つ
  const scheduled = [];
  const agent = createCpuAgent({ templates, weights, rng: createRng(1), scheduleFire: (a, s) => scheduled.push({ a, s }) });
  const action = agent.decide(counterVsAttackView());
  assert.equal(action, null);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].s, 300);
});

// ---------------------------------------------------------------------------
// atStep === view.step の FIRE では scheduleFire を呼ばず action を返す(ゾンビ予約の回帰テスト)
// ---------------------------------------------------------------------------

test('atStep === view.step の FIRE では scheduleFire を呼ばず action を返す(ゾンビ予約の回帰テスト)', () => {
  const templates = makeTemplates();
  const weights = zeros();
  weights[0] = 1; // 即時 attack FIRE を選ばせる
  const scheduled = [];
  const agent = createCpuAgent({ templates, weights, rng: createRng(1), scheduleFire: (a, s) => scheduled.push({ a, s }) });
  const action = agent.decide(decisionView());
  assert.ok(action, 'attack FIRE が選ばれなかった');
  assert.equal(scheduled.length, 0, '即時発射なのに scheduleFire が呼ばれている(ゾンビ予約の回帰)');
});
