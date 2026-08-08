// docs/action-centric-contract.md §5(差分仕様 §30 死に次元テスト)。
// 24次元の Feature Encoder が凍結契約どおりに機能することを検証する。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as C from '../src/config.js';
import { createMatch, stepMatch, createSideView, createRng } from '../src/engine.js';
import { encodeFeatures, FEATURE_NAMES, generateActions, selectAction, createCpuAgent } from '../src/cpu.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_PATH = path.join(__dirname, '..', 'data', 'templates.json');
const templates = JSON.parse(readFileSync(TEMPLATES_PATH, 'utf8'));

function zeros(n = C.ACTION_FEATURE_COUNT) {
  return new Array(n).fill(0);
}

function baseCtx(overrides = {}) {
  return {
    avail: 30,
    committed: 0,
    weights: zeros(),
    bandArrays: null,
    bandCache: new Map(),
    trailCache: new Map(),
    ...overrides,
  };
}

function baseView(overrides = {}) {
  return {
    sideIndex: 0,
    step: 1000,
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

/** selectAction(view, [action], ctx) を weights[dim]=value 一本槍で走らせ、選ばれた Action を返す。 */
function selectWith(view, action, dim, value) {
  const weights = zeros();
  weights[dim] = value;
  return selectAction(view, [action], baseCtx({ weights }));
}

/** dim が死に次元でないことを検証する: weight=+W と weight=-W で選ばれる Action が変わる。 */
function assertNotDead(dim, view, action) {
  const W = 1e6;
  const withPos = selectWith(view, action, dim, W);
  const withNeg = selectWith(view, action, dim, -W);
  assert.notDeepEqual(withPos, withNeg, `次元#${dim}(${FEATURE_NAMES[dim]}) が死んでいる(weight符号を変えても選択が変わらない)`);
}

// ---------------------------------------------------------------------------
// 死に次元テスト(24次元すべて)
// ---------------------------------------------------------------------------

test('#0 isAttackFire: attack FIRE で選択が変わる', () => {
  const view = baseView();
  const action = { type: 'FIRE', kind: 'attack', launchX: 100, atStep: view.step, cost: 6, template: { antY: 10, entryXAt0: 0 } };
  assertNotDead(0, view, action);
});

test('#1 isDisruptFire: disrupt FIRE で選択が変わる', () => {
  const view = baseView();
  const action = { type: 'FIRE', kind: 'disrupt', launchX: 100, atStep: view.step, cost: 3, template: { antY: 10 } };
  assertNotDead(1, view, action);
});

test('#2 isSelfDestruct: SELF_DESTRUCT で選択が変わる', () => {
  const view = baseView({ myAnts: [{ id: 9, x: 10, y: 10, steps: 100, life: 1000 }] });
  const action = { type: 'SELF_DESTRUCT', antId: 9, slot: 0, ant: view.myAnts[0] };
  assertNotDead(2, view, action);
});

test('#3 tokenAfter: 発射後トークンが正になる FIRE で選択が変わる', () => {
  const view = baseView({ tokens: 30, step: 1000 });
  const action = { type: 'FIRE', kind: 'attack', launchX: 100, atStep: view.step, cost: 6, template: { antY: 10 } };
  assertNotDead(3, view, action);
});

test('#4 flyingAfter: flyingCount=0 の FIRE(飛行後1匹)で選択が変わる', () => {
  const view = baseView({ flyingCount: 0 });
  const action = { type: 'FIRE', kind: 'attack', launchX: 100, atStep: view.step, cost: 6, template: { antY: 10 } };
  assertNotDead(4, view, action);
});

test('#5 effectDelay: 予約(atStep>step)の FIRE で選択が変わる', () => {
  const view = baseView({ step: 1000 });
  const action = { type: 'FIRE', kind: 'disrupt', launchX: 100, atStep: view.step + 500, cost: 3, template: { antY: 10 } };
  assertNotDead(5, view, action);
});

test('#6 scoreReachability: 得点ゲート内の attack FIRE で選択が変わる', () => {
  const view = baseView();
  const action = {
    type: 'FIRE',
    kind: 'attack',
    launchX: 100, // 得点ゲート [32,224) の内側、entryXAt0=0 なので届く
    atStep: view.step,
    cost: 6,
    template: { antY: 10, entryXAt0: 0 },
  };
  assertNotDead(6, view, action);
});

test('#7 robustness: robustness>0 の attack FIRE で選択が変わる', () => {
  const view = baseView();
  const action = {
    type: 'FIRE',
    kind: 'attack',
    launchX: 100,
    atStep: view.step,
    cost: 6,
    template: { antY: 10, robustness: 0.9 },
  };
  assertNotDead(7, view, action);
});

for (let band = 0; band < C.COARSE_BAND_COUNT; band++) {
  const occDim = 8 + band * 2;
  const ownDim = 8 + band * 2 + 1;
  test(`#${occDim} boardOccupancyBand${band}: band${band} の占有で選択が変わる`, () => {
    const cx = 10;
    const cyGlobal = band * C.COARSE_ROWS_PER_BAND + 1; // side0 なのでローカル行=グローバル行
    const view = baseView();
    view.coarseNonWhite[cyGlobal * C.COARSE_SIZE + cx] = 20;
    const action = {
      type: 'FIRE',
      kind: 'disrupt',
      launchX: cx * C.COARSE_BLOCK,
      atStep: view.step,
      cost: 3,
      template: { antY: 10 },
    };
    assertNotDead(occDim, view, action);
  });

  test(`#${ownDim} boardOwnershipBand${band}: band${band} の所有差で選択が変わる`, () => {
    const cx = 10;
    const cyGlobal = band * C.COARSE_ROWS_PER_BAND + 1;
    const view = baseView();
    view.coarseOwnedEnemy[cyGlobal * C.COARSE_SIZE + cx] = 20;
    const action = {
      type: 'FIRE',
      kind: 'disrupt',
      launchX: cx * C.COARSE_BLOCK,
      atStep: view.step,
      cost: 3,
      template: { antY: 10 },
    };
    assertNotDead(ownDim, view, action);
  });
}

test('#16 enemyNearAnchor: anchor直上の敵アリで選択が変わる', () => {
  const view = baseView({ enemyAnts: [{ id: 1, x: 100, y: 10 }] });
  const action = { type: 'FIRE', kind: 'disrupt', launchX: 100, atStep: view.step, cost: 3, template: { antY: 10 } };
  assertNotDead(16, view, action);
});

test('#17 enemyForwardPresence: anchorより奥にいる敵アリで選択が変わる', () => {
  const view = baseView({ enemyAnts: [{ id: 1, x: 100, y: 200 }] });
  const action = { type: 'FIRE', kind: 'disrupt', launchX: 100, atStep: view.step, cost: 3, template: { antY: 10 } };
  assertNotDead(17, view, action);
});

test('#18 allyNearAnchor: anchor直上の味方アリで選択が変わる', () => {
  const view = baseView({ myAnts: [{ id: 1, x: 100, y: 10 }] });
  const action = { type: 'FIRE', kind: 'disrupt', launchX: 100, atStep: view.step, cost: 3, template: { antY: 10 } };
  assertNotDead(18, view, action);
});

test('#19 allyForwardPresence: anchorより奥にいる味方アリで選択が変わる', () => {
  const view = baseView({ myAnts: [{ id: 1, x: 100, y: 200 }] });
  const action = { type: 'FIRE', kind: 'disrupt', launchX: 100, atStep: view.step, cost: 3, template: { antY: 10 } };
  assertNotDead(19, view, action);
});

test('#20 destructAge: 寿命を消化したアリの SELF_DESTRUCT で選択が変わる', () => {
  const view = baseView({ myAnts: [{ id: 9, x: 10, y: 10, steps: 500, life: 1000 }] });
  const action = { type: 'SELF_DESTRUCT', antId: 9, slot: 0, ant: view.myAnts[0] };
  assertNotDead(20, view, action);
});

test('#21 ownedTrailAmount: 所有セルがある SELF_DESTRUCT で選択が変わる', () => {
  const owned = new Int32Array(C.COARSE_COUNT);
  owned[5 * C.COARSE_SIZE + 5] = 3;
  const view = baseView({ myAnts: [{ id: 9, x: 10, y: 10, steps: 100, life: 1000 }], coarseAntOwned: [owned, null, null, null] });
  const action = { type: 'SELF_DESTRUCT', antId: 9, slot: 0, ant: view.myAnts[0] };
  assertNotDead(21, view, action);
});

test('#22 ownedTrailCentroidY: 所有セルがある SELF_DESTRUCT で選択が変わる', () => {
  const owned = new Int32Array(C.COARSE_COUNT);
  owned[5 * C.COARSE_SIZE + 5] = 3;
  const view = baseView({ myAnts: [{ id: 9, x: 10, y: 10, steps: 100, life: 1000 }], coarseAntOwned: [owned, null, null, null] });
  const action = { type: 'SELF_DESTRUCT', antId: 9, slot: 0, ant: view.myAnts[0] };
  assertNotDead(22, view, action);
});

test('#23 ownedTrailSpread: 2つ以上の coarse ブロックに散った所有で選択が変わる', () => {
  const owned = new Int32Array(C.COARSE_COUNT);
  owned[5 * C.COARSE_SIZE + 5] = 3;
  owned[5 * C.COARSE_SIZE + 13] = 3; // 別の coarse 列 → 分散>0
  const view = baseView({ myAnts: [{ id: 9, x: 10, y: 10, steps: 100, life: 1000 }], coarseAntOwned: [owned, null, null, null] });
  const action = { type: 'SELF_DESTRUCT', antId: 9, slot: 0, ant: view.myAnts[0] };
  assertNotDead(23, view, action);
});

// ---------------------------------------------------------------------------
// 全 Action の全特徴が契約 §5 の表の範囲に収まる(実試合を数十ステップ回して検査)
// ---------------------------------------------------------------------------

test('§30 実試合の各判断で、全候補の全特徴が契約の範囲に収まる(有限値も検査)', () => {
  const rngWeights = createRng(99);
  const weightsA = Array.from({ length: C.ACTION_FEATURE_COUNT }, () => rngWeights.next() * 2 - 1);
  const weightsB = Array.from({ length: C.ACTION_FEATURE_COUNT }, () => rngWeights.next() * 2 - 1);
  const match = createMatch({
    seed: 11,
    agents: [
      createCpuAgent({ templates, weights: weightsA, rng: createRng(1) }),
      createCpuAgent({ templates, weights: weightsB, rng: createRng(2) }),
    ],
  });

  const attackById = new Map(templates.attack.map((t) => [t.id, t]));
  const disruptById = new Map(templates.disrupt.map((t) => [t.id, t]));

  let checkedCandidates = 0;
  const signedDims = new Set([9, 11, 13, 15]);

  for (let decisionNo = 0; decisionNo < 30 && match.phase !== 'finished'; decisionNo++) {
    for (let i = 0; i < C.DECISION_INTERVAL_STEPS && match.phase !== 'finished'; i++) stepMatch(match);
    for (const sideIndex of [0, 1]) {
      const view = createSideView(match, sideIndex);
      const ctx = {
        attackTemplates: templates.attack,
        disruptTemplates: templates.disrupt,
        disruptById,
        identifyTable: templates.identifyTable,
        counterTable: templates.counterTable,
        escortTable: templates.escortTable,
        rng: createRng(decisionNo * 7 + sideIndex + 1),
        avail: view.tokens,
        committed: 0,
        weights: zeros(),
        bandArrays: null,
        bandCache: new Map(),
        trailCache: new Map(),
      };
      const actions = generateActions(view, ctx);
      for (const action of actions) {
        if (action.type === 'WAIT') continue;
        const out = encodeFeatures(view, action, { ...ctx, bandArrays: null, bandCache: new Map(), trailCache: new Map() });
        checkedCandidates++;
        for (let d = 0; d < C.ACTION_FEATURE_COUNT; d++) {
          const v = out[d];
          assert.ok(Number.isFinite(v), `#${d}(${FEATURE_NAMES[d]}) が有限でない: ${v}`);
          if (signedDims.has(d)) {
            assert.ok(v >= -1 && v <= 1, `#${d}(${FEATURE_NAMES[d]}) が [-1,1] の範囲外: ${v}`);
          } else {
            assert.ok(v >= 0 && v <= 1, `#${d}(${FEATURE_NAMES[d]}) が [0,1] の範囲外: ${v}`);
          }
        }
      }
    }
  }
  assert.ok(checkedCandidates > 0, 'テストが空振りしている(候補が1件も生成されなかった)');
});

// ---------------------------------------------------------------------------
// FEATURE_NAMES の長さと並び
// ---------------------------------------------------------------------------

test('FEATURE_NAMES の長さが C.ACTION_FEATURE_COUNT と一致し、契約 §5 の表と同じ並びである', () => {
  assert.equal(FEATURE_NAMES.length, C.ACTION_FEATURE_COUNT);
  assert.deepEqual(FEATURE_NAMES, [
    'isAttackFire',
    'isDisruptFire',
    'isSelfDestruct',
    'tokenAfter',
    'flyingAfter',
    'effectDelay',
    'scoreReachability',
    'robustness',
    'boardOccupancyBand0',
    'boardOwnershipBand0',
    'boardOccupancyBand1',
    'boardOwnershipBand1',
    'boardOccupancyBand2',
    'boardOwnershipBand2',
    'boardOccupancyBand3',
    'boardOwnershipBand3',
    'enemyNearAnchor',
    'enemyForwardPresence',
    'allyNearAnchor',
    'allyForwardPresence',
    'destructAge',
    'ownedTrailAmount',
    'ownedTrailCentroidY',
    'ownedTrailSpread',
  ]);
});

// ---------------------------------------------------------------------------
// 完全決定論
// ---------------------------------------------------------------------------

test('encodeFeatures は完全決定論(同じ view/action/ctx で2回呼んで完全一致)', () => {
  const view = baseView({
    myAnts: [{ id: 1, x: 100, y: 200 }],
    enemyAnts: [{ id: 2, x: 90, y: 210 }],
  });
  const action = {
    type: 'FIRE',
    kind: 'attack',
    launchX: 100,
    atStep: view.step,
    cost: 6,
    template: { antY: 10, entryXAt0: 0, robustness: 0.5 },
  };
  const ctx1 = baseCtx();
  const ctx2 = baseCtx();
  const out1 = encodeFeatures(view, action, ctx1);
  const out2 = encodeFeatures(view, action, ctx2);
  assert.deepEqual(Array.from(out1), Array.from(out2));

  // 同じ ctx を使い回して2回呼んでも一致する(キャッシュが汚染されない)
  const out3 = encodeFeatures(view, action, ctx1);
  assert.deepEqual(Array.from(out1), Array.from(out3));
});
