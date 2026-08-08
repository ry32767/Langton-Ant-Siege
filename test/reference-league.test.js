// docs/action-centric-contract.md §6(差分仕様 §35)。学習しない固定4方策(Reference League)。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/config.js';
import { generateActions, selectAction } from '../src/cpu.js';
import { REFERENCE_POLICY_NAMES, createReferenceScorer, BURST_THRESHOLD } from '../src/reference-policies.js';

// ---------------------------------------------------------------------------
// fixture: コストの違う攻撃3種・妨害1種・counter 由来候補を作れるテンプレート
// ---------------------------------------------------------------------------

function makeTemplates() {
  const cheap = { id: 'A_cheap', kind: 'attack', rule: 'RL', colorCount: 2, cells: [[1, 5, 1]], antY: 6, antDir: 1, entryXAt0: 0 };
  const mid = {
    id: 'A_mid',
    kind: 'attack',
    rule: 'RRL',
    colorCount: 3,
    cells: [[1, 5, 1], [2, 5, 1], [3, 5, 1]],
    antY: 6,
    antDir: 1,
    entryXAt0: 0,
  };
  const expensive = {
    id: 'A_expensive',
    kind: 'attack',
    rule: 'RLL',
    colorCount: 3,
    cells: [[1, 5, 1], [2, 5, 1], [3, 5, 1], [4, 5, 1], [5, 5, 1]],
    antY: 6,
    antDir: 1,
    entryXAt0: 0,
  };
  const D1 = { id: 'D1', kind: 'disrupt', rule: 'RL', colorCount: 2, cells: [[1, 2, 1]], antY: 3, antDir: 1 };
  return {
    attack: [cheap, mid, expensive],
    disrupt: [D1],
    identifyTable: { '6,1': 'A_mid' },
    counterTable: {
      A_mid: [{ disruptId: 'D1', deltaX: 0, fireAtStep: 300, successRate: 1.0 }],
    },
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

function baseCtx(templates, name, overrides = {}) {
  const disruptById = new Map(templates.disrupt.map((t) => [t.id, t]));
  const avail = overrides.avail ?? 30;
  return {
    attackTemplates: templates.attack,
    disruptTemplates: templates.disrupt,
    disruptById,
    identifyTable: templates.identifyTable,
    counterTable: templates.counterTable,
    escortTable: templates.escortTable,
    rng: { int: (n) => Math.floor(n / 2), next: () => 0.5, pick: (arr) => arr[0] },
    avail,
    committed: 0,
    scoreAction: createReferenceScorer(name),
    ...overrides,
  };
}

function decide(templates, name, view, overrides = {}) {
  const ctx = baseCtx(templates, name, overrides);
  const actions = generateActions(view, ctx);
  return { chosen: selectAction(view, actions, ctx), actions };
}

// ---------------------------------------------------------------------------
// 決定論(同一 state / seed で2回実行して一致)
// ---------------------------------------------------------------------------

for (const name of REFERENCE_POLICY_NAMES) {
  test(`§35 ${name} は同一 state / seed で決定論的(2回実行して一致)`, () => {
    const templates = makeTemplates();
    const view = baseView({ tokens: 30, enemyAnts: [{ id: 1, kind: 'attack', x: 10, spawnX: 10, spawnY: 6, spawnDir: 1, ownerX: 10, ownerY: 6, ownerDir: 1, firedAtStep: 0 }] });
    const r1 = decide(templates, name, view);
    const r2 = decide(templates, name, view);
    assert.deepEqual(r1.chosen, r2.chosen);
  });
}

// ---------------------------------------------------------------------------
// 学習世代番号に依存しない・CEM の weights を参照しない
// ---------------------------------------------------------------------------

for (const name of REFERENCE_POLICY_NAMES) {
  test(`§35 ${name} は ctx.weights を参照しない(全く違う値にしても選択が変わらない)`, () => {
    const templates = makeTemplates();
    const view = baseView({ tokens: 30 });
    const r1 = decide(templates, name, view, { weights: new Array(C.ACTION_FEATURE_COUNT).fill(0) });
    const r2 = decide(templates, name, view, { weights: new Array(C.ACTION_FEATURE_COUNT).fill(-999) });
    const r3 = decide(templates, name, view, { weights: Array.from({ length: C.ACTION_FEATURE_COUNT }, (_, i) => i * 37 - 100) });
    assert.deepEqual(r1.chosen, r2.chosen);
    assert.deepEqual(r1.chosen, r3.chosen);
  });
}

// ---------------------------------------------------------------------------
// 各方策の規則
// ---------------------------------------------------------------------------

test('§35 ATTACK_ONLY は妨害・自爆を選ばない', () => {
  const templates = makeTemplates();
  const view = baseView({
    tokens: 30,
    flyingCount: 1,
    myAnts: [{ id: 5, slot: 0, x: 10, y: 10, steps: 100, life: 20000 }],
    enemyAnts: [{ id: 1, kind: 'attack', x: 10, spawnX: 10, spawnY: 6, spawnDir: 1, ownerX: 10, ownerY: 6, ownerDir: 1, firedAtStep: 0 }],
  });
  const { chosen } = decide(templates, 'ATTACK_ONLY', view);
  assert.ok(chosen.type === 'WAIT' || (chosen.type === 'FIRE' && chosen.kind === 'attack'));
});

test('§35 CHEAP_SPAM は選べる攻撃のうち最小コストを選ぶ', () => {
  const templates = makeTemplates();
  const view = baseView({ tokens: 30 });
  const { chosen } = decide(templates, 'CHEAP_SPAM', view);
  assert.equal(chosen.type, 'FIRE');
  assert.equal(chosen.kind, 'attack');
  assert.equal(chosen.templateId, 'A_cheap', `最安の A_cheap ではなく ${chosen.templateId} が選ばれた`);
});

test('§35 SAVE_AND_BURST: avail < BURST_THRESHOLD なら WAIT', () => {
  const templates = makeTemplates();
  const view = baseView({ tokens: BURST_THRESHOLD - 1 });
  const { chosen } = decide(templates, 'SAVE_AND_BURST', view, { avail: BURST_THRESHOLD - 1 });
  assert.equal(chosen.type, 'WAIT');
});

test('§35 SAVE_AND_BURST: avail >= BURST_THRESHOLD なら ATTACK_ONLY と同じ攻撃を選ぶ', () => {
  const templates = makeTemplates();
  const view = baseView({ tokens: BURST_THRESHOLD });
  const burst = decide(templates, 'SAVE_AND_BURST', view, { avail: BURST_THRESHOLD });
  const attackOnly = decide(templates, 'ATTACK_ONLY', view, { avail: BURST_THRESHOLD });
  assert.deepEqual(burst.chosen, attackOnly.chosen);
});

test('§35 DEFEND_HEAVY: counter 由来があればそれを選ぶ', () => {
  const templates = makeTemplates();
  const view = baseView({
    tokens: 30,
    enemyAnts: [{ id: 1, kind: 'attack', x: 10, spawnX: 10, spawnY: 6, spawnDir: 1, ownerX: 10, ownerY: 6, ownerDir: 1, firedAtStep: 0 }],
  });
  const { chosen } = decide(templates, 'DEFEND_HEAVY', view);
  assert.equal(chosen.type, 'FIRE');
  assert.equal(chosen.source, 'counter', `counter 由来が選ばれず ${chosen.source} が選ばれた`);
});

test('§35 DEFEND_HEAVY: counter 由来が無ければ ATTACK_ONLY と同じ', () => {
  const templates = makeTemplates();
  const view = baseView({ tokens: 30, enemyAnts: [] }); // 敵アリが居ないので counter 候補は出ない
  const defend = decide(templates, 'DEFEND_HEAVY', view);
  const attackOnly = decide(templates, 'ATTACK_ONLY', view);
  assert.deepEqual(defend.chosen, attackOnly.chosen);
});

// ---------------------------------------------------------------------------
// fitness 配分が 50% + 12.5%×4 = 100% になることの自動テスト
// (scripts/train-policy.mjs は import できないので、配分の定数だけを検証する)
// ---------------------------------------------------------------------------

test('§35 fitness 配分: self-play 20 + リーグ5×4 = 40試合、self-play重み0.5 + リーグ重み0.5 = 1.0', () => {
  // scripts/train-policy.mjs §22/§20 が定義する配分。import すると学習が走ってしまうため
  // (AGENTS.md の警告)、ここでは同じ根拠の定数をテスト内で明示的に持って検算する。
  const GAMES_PER_INDIVIDUAL = 40;
  const SELFPLAY_GAMES = Math.round(GAMES_PER_INDIVIDUAL / 2);
  const LEAGUE_GAMES_EACH = Math.round(GAMES_PER_INDIVIDUAL / 2 / REFERENCE_POLICY_NAMES.length);

  assert.equal(SELFPLAY_GAMES, 20);
  assert.equal(LEAGUE_GAMES_EACH, 5);
  assert.equal(REFERENCE_POLICY_NAMES.length, 4);
  assert.equal(SELFPLAY_GAMES + LEAGUE_GAMES_EACH * REFERENCE_POLICY_NAMES.length, GAMES_PER_INDIVIDUAL);

  const SELFPLAY_WEIGHT = 0.5;
  const LEAGUE_WEIGHT = 0.5;
  const LEAGUE_WEIGHT_EACH = LEAGUE_WEIGHT / REFERENCE_POLICY_NAMES.length;
  assert.equal(LEAGUE_WEIGHT_EACH, 0.125);
  assert.equal(SELFPLAY_WEIGHT + LEAGUE_WEIGHT_EACH * REFERENCE_POLICY_NAMES.length, 1.0);
});
