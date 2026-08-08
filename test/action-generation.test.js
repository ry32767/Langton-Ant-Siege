// docs/action-centric-contract.md §3(差分仕様 §33 と §5)。generateActions の合法性と
// 候補圧縮(戦術優先順位は一切埋め込まないこと)を検証する。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/config.js';
import { generateActions, encodeFeatures } from '../src/cpu.js';
import { launchColumnScores } from '../src/template.js';

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
    identifyTable: { '23,1': 'A1' },
    counterTable: {},
    escortTable: {},
  };
}

function baseView(overrides = {}) {
  return {
    sideIndex: 0,
    step: 0,
    tokens: 30,
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

function baseCtx(templates, overrides = {}) {
  const disruptById = new Map(templates.disrupt.map((t) => [t.id, t]));
  return {
    attackTemplates: templates.attack,
    disruptTemplates: templates.disrupt,
    disruptById,
    identifyTable: templates.identifyTable,
    counterTable: templates.counterTable,
    escortTable: templates.escortTable,
    rng: { int: (n) => Math.floor(n / 2), next: () => 0.5, pick: (arr) => arr[0] },
    avail: 30,
    committed: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// SELF_DESTRUCT: 事前フィルタ禁止(§6・§33)
// ---------------------------------------------------------------------------

test('§33 若い自軍アリ(steps=0)でも SELF_DESTRUCT 候補になる', () => {
  const templates = makeTemplates();
  const view = baseView({ myAnts: [{ id: 1, slot: 0, x: 10, y: 10, steps: 0, life: 20000 }] });
  const ctx = baseCtx(templates);
  const actions = generateActions(view, ctx);
  const sd = actions.filter((a) => a.type === 'SELF_DESTRUCT');
  assert.equal(sd.length, 1);
  assert.equal(sd[0].antId, 1);
});

test('§33 destructAge(年齢)は候補生成の可否に影響しない: 年齢の違う2匹が両方候補になる', () => {
  const templates = makeTemplates();
  const view = baseView({
    myAnts: [
      { id: 1, slot: 0, x: 10, y: 10, steps: 0, life: 20000 },
      { id: 2, slot: 1, x: 10, y: 10, steps: 19999, life: 20000 },
    ],
  });
  const ctx = baseCtx(templates);
  const actions = generateActions(view, ctx);
  const sdIds = actions.filter((a) => a.type === 'SELF_DESTRUCT').map((a) => a.antId).sort();
  assert.deepEqual(sdIds, [1, 2]);
});

test('§33 ownership が0のアリでも合法なら SELF_DESTRUCT 候補になり、encodeFeatures は所有0の値を返す', () => {
  const templates = makeTemplates();
  // coarseAntOwned[slot] は全0の Int32Array(fire 直後で配置マスがまだ焼き込まれていない状態を模す)。
  const zeroOwned = new Int32Array(C.COARSE_COUNT);
  const view = baseView({
    myAnts: [{ id: 1, slot: 0, x: 10, y: 10, steps: 0, life: 20000 }],
    coarseAntOwned: [zeroOwned, null, null, null],
  });
  const ctx = baseCtx(templates);
  const actions = generateActions(view, ctx);
  const sd = actions.find((a) => a.type === 'SELF_DESTRUCT');
  assert.ok(sd, 'SELF_DESTRUCT 候補が無い');

  // 契約 §5.4「所有0なら amount/centroidY/spread が0」を実際に encodeFeatures で確認する。
  const out = encodeFeatures(view, sd, { avail: 30, committed: 0, bandArrays: null, bandCache: new Map(), trailCache: new Map() });
  assert.equal(out[21], 0, 'ownedTrailAmount が0でない');
  assert.equal(out[22], 0, 'ownedTrailCentroidY が0でない');
  assert.equal(out[23], 0, 'ownedTrailSpread が0でない');
});

// ---------------------------------------------------------------------------
// scoreReachability=0 の攻撃 FIRE 候補
// ---------------------------------------------------------------------------

test('§5 scoreReachability=0 の攻撃 FIRE 候補が実際に生成される(得点ゲート外の発射列)', () => {
  const templates = makeTemplates();
  assert.ok(C.ACTION_ATTACK_OFFGATE_SAMPLES > 0, 'ACTION_ATTACK_OFFGATE_SAMPLES が0だと担保できない');
  const view = baseView();
  const ctx = baseCtx(templates);
  const actions = generateActions(view, ctx);
  const attackFires = actions.filter((a) => a.type === 'FIRE' && a.kind === 'attack');
  assert.ok(attackFires.length > 0, '攻撃 FIRE 候補が無い');
  const offGate = attackFires.filter((a) => !launchColumnScores(a.template, a.launchX));
  assert.ok(offGate.length > 0, 'ゲート外(scoreReachability=0)の候補が1件も無い');
});

// ---------------------------------------------------------------------------
// flyingCount >= MAX_FLYING のとき FIRE 候補が出ない(合法性)。SELF_DESTRUCT は出る
// ---------------------------------------------------------------------------

test('§3 flyingCount >= MAX_FLYING のとき FIRE 候補が出ないが SELF_DESTRUCT は出る', () => {
  const templates = makeTemplates();
  const view = baseView({
    flyingCount: C.MAX_FLYING,
    myAnts: [{ id: 1, slot: 0, x: 10, y: 10, steps: 0, life: 20000 }],
  });
  const ctx = baseCtx(templates);
  const actions = generateActions(view, ctx);
  const fires = actions.filter((a) => a.type === 'FIRE');
  assert.equal(fires.length, 0, 'flying枠が埋まっているのに FIRE 候補が出ている');
  const sd = actions.filter((a) => a.type === 'SELF_DESTRUCT');
  assert.equal(sd.length, 1);
});

// ---------------------------------------------------------------------------
// 重複候補の畳み込み
// ---------------------------------------------------------------------------

test('§3-7 重複候補が畳まれている: 同じ (type, templateId, launchX, atStep) が2件出ない', () => {
  const templates = makeTemplates();
  // rng を固定値にして、複数サンプルが同じ列に収束するようにする(衝突を意図的に起こす)。
  const stubRng = { int: () => 3, next: () => 0.1, pick: (arr) => arr[0] };
  const view = baseView();
  const ctx = baseCtx(templates, { rng: stubRng });
  const actions = generateActions(view, ctx);

  const seen = new Set();
  for (const a of actions) {
    let key;
    if (a.type === 'FIRE') key = `F|${a.templateId}|${a.launchX}|${a.atStep}`;
    else if (a.type === 'SELF_DESTRUCT') key = `S|${a.antId}`;
    else key = 'WAIT';
    assert.ok(!seen.has(key), `重複候補が畳まれていない: ${key}`);
    seen.add(key);
  }

  // rng を固定値にしても衝突するはずの候補が実際に1本に畳まれていることを確認する
  // (ゲート内サンプル ACTION_ATTACK_GATE_SAMPLES=4本 が全部同じ列を引くはず)。
  const attackFires = actions.filter((a) => a.type === 'FIRE' && a.kind === 'attack');
  assert.ok(attackFires.length < C.ACTION_ATTACK_GATE_SAMPLES + C.ACTION_ATTACK_OFFGATE_SAMPLES, '固定rngなのに重複が畳まれていない');
});

test('同じ (type,antId) の SELF_DESTRUCT は1件に畳まれる(myAnts に重複が無い前提だが念のため)', () => {
  const templates = makeTemplates();
  const view = baseView({ myAnts: [{ id: 1, slot: 0, x: 10, y: 10, steps: 0, life: 20000 }] });
  const ctx = baseCtx(templates);
  const actions = generateActions(view, ctx);
  const sd = actions.filter((a) => a.type === 'SELF_DESTRUCT' && a.antId === 1);
  assert.equal(sd.length, 1);
});
