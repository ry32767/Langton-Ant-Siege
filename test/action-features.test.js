// docs/action-centric-contract.md §5(差分仕様 §30 死に次元テスト)。
// 26次元の Feature Encoder(v6.2)が凍結契約どおりに機能することを検証する。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as C from '../src/config.js';
import { createMatch, stepMatch, createSideView, createRng, fire } from '../src/engine.js';
import { encodeFeatures, FEATURE_NAMES, generateActions, selectAction, createCpuAgent } from '../src/cpu.js';
import { instantiateTemplate, scoringLaunchColumns, wrapX, launchColumnScores } from '../src/template.js';

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
    templateById: new Map(),
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

test('#24 destructTargetWillScore: 得点ゲートに届く発射列から撃った自軍アリの SELF_DESTRUCT で選択が変わる', () => {
  // entryXAt0=0 の合成テンプレート。scoringLaunchColumns の先頭列は必ず得点ゲート内 → willScore=1。
  const tpl = { id: 'T-WILLSCORE', entryXAt0: 0 };
  const templateById = new Map([[tpl.id, tpl]]);
  const spawnX = scoringLaunchColumns(tpl).min;
  const view = baseView({
    myAnts: [{ id: 9, x: 10, y: 10, steps: 100, life: 1000, spawnX, templateId: tpl.id }],
  });
  const action = { type: 'SELF_DESTRUCT', antId: 9, slot: 0, ant: view.myAnts[0] };
  const weights = zeros();
  weights[24] = 1e6;
  const withPos = selectAction(view, [action], baseCtx({ weights, templateById }));
  weights[24] = -1e6;
  const withNeg = selectAction(view, [action], baseCtx({ weights, templateById }));
  assert.notDeepEqual(withPos, withNeg, `次元#24(${FEATURE_NAMES[24]}) が死んでいる(weight符号を変えても選択が変わらない)`);
});

test('#25 destructTargetOffTrack: ハイウェイ予測軌道から外れた自軍アリの SELF_DESTRUCT で選択が変わる', () => {
  // formationStep=0, period=10, driftX=driftY=1 のハイウェイを持つ合成テンプレート。
  // steps=100 → cycles=10 → predX=spawnX+10, predY=spawnY+10。実位置をそこから離すことで offTrack>0 を作る。
  const tpl = {
    id: 'T-OFFTRACK',
    entryXAt0: 0,
    highway: { formationStep: 0, period: 10, driftX: 1, driftY: 1 },
  };
  const templateById = new Map([[tpl.id, tpl]]);
  const view = baseView({
    myAnts: [{ id: 9, x: 100, y: 0, steps: 100, life: 1000, spawnX: 100, spawnY: 0, templateId: tpl.id }],
  });
  const action = { type: 'SELF_DESTRUCT', antId: 9, slot: 0, ant: view.myAnts[0] };
  const weights = zeros();
  weights[25] = 1e6;
  const withPos = selectAction(view, [action], baseCtx({ weights, templateById }));
  weights[25] = -1e6;
  const withNeg = selectAction(view, [action], baseCtx({ weights, templateById }));
  assert.notDeepEqual(withPos, withNeg, `次元#25(${FEATURE_NAMES[25]}) が死んでいる(weight符号を変えても選択が変わらない)`);
});

// ---------------------------------------------------------------------------
// #24 / #25 の意味そのもののテスト(v6.2 で追加された観測。契約 §5.0)
// ---------------------------------------------------------------------------

test('#24 destructTargetWillScore: 得点ゲートに届く発射列は1、届かない発射列は0になる', () => {
  const tpl = { id: 'T-GATE', entryXAt0: 0 };
  const templateById = new Map([[tpl.id, tpl]]);
  const ctx = () => baseCtx({ templateById });
  const { min, count } = scoringLaunchColumns(tpl);

  // scoringLaunchColumns の先頭列は必ずゲート内 → 届く
  const hitSpawnX = min;
  const hitView = baseView({ myAnts: [{ id: 1, x: 10, y: 10, steps: 0, life: 1000, spawnX: hitSpawnX, templateId: tpl.id }] });
  const hitAction = { type: 'SELF_DESTRUCT', antId: 1, slot: 0, ant: hitView.myAnts[0] };
  const hitOut = encodeFeatures(hitView, hitAction, ctx());
  assert.equal(hitOut[24], 1, 'ゲートに届く発射列なのに willScore が1でない');

  // scoringLaunchColumns の直後の列(min+count)は連続するゲート範囲の外 → 届かない
  const missSpawnX = wrapX(min + count);
  const missView = baseView({ myAnts: [{ id: 1, x: 10, y: 10, steps: 0, life: 1000, spawnX: missSpawnX, templateId: tpl.id }] });
  const missAction = { type: 'SELF_DESTRUCT', antId: 1, slot: 0, ant: missView.myAnts[0] };
  const missOut = encodeFeatures(missView, missAction, ctx());
  assert.equal(missOut[24], 0, 'ゲートに届かない発射列なのに willScore が0でない');
});

test('#25 destructTargetOffTrack: 実試合で軌道どおりに飛んでいるアリは0に近く、軌道から外れたアリは大きくなる', () => {
  const tpl = templates.attack.find((t) => t.highway && t.highway.period > 0);
  assert.ok(tpl, '前提: highway を持つ攻撃テンプレートが必要');
  const templateById = new Map([[tpl.id, tpl]]);

  const match = createMatch({ seed: 7 });
  match.sides[0].tokens = C.TOKEN_CAP;
  const antId = fire(match, 0, instantiateTemplate(tpl, 100));

  // formationStep を過ぎ、数周期分ハイウェイに乗るまで妨害なしで進める(乾渉なし=軌道どおり)。
  const runSteps = (tpl.highway.formationStep ?? 0) + tpl.highway.period * 3;
  for (let i = 0; i < runSteps; i++) stepMatch(match);

  const ant = match.sides[0].ants.find((a) => a.id === antId);
  assert.ok(ant, '前提: アリがまだ飛行中である必要がある(寿命内に収まるようステップ数を調整すること)');

  const onTrackView = createSideView(match, 0);
  const onTrackMyAnt = onTrackView.myAnts.find((a) => a.id === antId);
  const onTrackAction = { type: 'SELF_DESTRUCT', antId, slot: onTrackMyAnt.slot, ant: onTrackMyAnt };
  const onTrackOut = encodeFeatures(onTrackView, onTrackAction, baseCtx({ templateById }));
  const onTrackOffTrack = onTrackOut[25];

  // アリの現在位置を人為的に大きくずらす(別弾に軌道を壊された状況を模す)。
  ant.x = (ant.x + 40) % C.WIDTH;
  ant.y += 40;

  const offTrackView = createSideView(match, 0);
  const offTrackMyAnt = offTrackView.myAnts.find((a) => a.id === antId);
  const offTrackAction = { type: 'SELF_DESTRUCT', antId, slot: offTrackMyAnt.slot, ant: offTrackMyAnt };
  const offTrackOut = encodeFeatures(offTrackView, offTrackAction, baseCtx({ templateById }));
  const offTrackOffTrack = offTrackOut[25];

  console.log(`§5.0 offTrack: on-track=${onTrackOffTrack.toFixed(4)} off-track=${offTrackOffTrack.toFixed(4)}`);
  assert.ok(onTrackOffTrack < 0.1, `軌道どおりに飛んでいるのに offTrack が大きい: ${onTrackOffTrack}`);
  assert.ok(offTrackOffTrack > onTrackOffTrack + 0.2, `位置をずらしても offTrack が有意に増えない: on=${onTrackOffTrack} off=${offTrackOffTrack}`);
});

test('#25 destructTargetOffTrack: highway を持たない妨害テンプレートのアリは常に0になる', () => {
  const tpl = templates.disrupt[0];
  assert.ok(tpl && !tpl.highway, '前提: 妨害テンプレートは highway を持たない');
  const templateById = new Map([[tpl.id, tpl]]);
  const view = baseView({
    myAnts: [{ id: 1, x: 55, y: 33, steps: 200, life: 1000, spawnX: 10, spawnY: 0, templateId: tpl.id }],
  });
  const action = { type: 'SELF_DESTRUCT', antId: 1, slot: 0, ant: view.myAnts[0] };
  const out = encodeFeatures(view, action, baseCtx({ templateById }));
  assert.equal(out[25], 0, '妨害テンプレートのアリで offTrack が0でない');
});

test('SELF_DESTRUCT 以外の Action では #24 も #25 も0のまま', () => {
  const view = baseView();
  const attackAction = {
    type: 'FIRE',
    kind: 'attack',
    launchX: 100,
    atStep: view.step,
    cost: 6,
    template: { antY: 10, entryXAt0: 0, robustness: 0.9 },
  };
  const out = encodeFeatures(view, attackAction, baseCtx());
  assert.equal(out[24], 0);
  assert.equal(out[25], 0);

  const disruptAction = { type: 'FIRE', kind: 'disrupt', launchX: 100, atStep: view.step, cost: 3, template: { antY: 10 } };
  const out2 = encodeFeatures(view, disruptAction, baseCtx());
  assert.equal(out2[24], 0);
  assert.equal(out2[25], 0);
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
  const templateById = new Map([...attackById, ...disruptById]);

  let checkedCandidates = 0;
  const signedDims = new Set([9, 11, 13, 15]);
  // 実運用の候補生成経路(generateActions)で #24/#25 が本当に配線どおり計算されているかを
  // 独立実装で再計算して突き合わせる。targetOutcomeFeatures はテンプレート参照に失敗すると
  // 黙って {0,0} を返すため、§30 の範囲チェックだけでは「配線が壊れて常に0」という
  // バグを見逃せる(advisor 指摘)。willScore=1 が出るかは RNG が引く発射列次第で
  // 偶然任せになるため、期待値との一致を都度検証する方式にする(たまたま1が出ないと
  // 落ちる、という脆いテストにしない)。
  let selfDestructCandidates = 0;
  let attackSelfDestructCandidates = 0;
  let willScoreOnes = 0;
  let offTrackPositives = 0;
  let offTrackMax = 0;

  const expectedOutcome = (ant) => {
    const tpl = ant.templateId ? templateById.get(ant.templateId) : null;
    if (!tpl) return { willScore: 0, offTrack: 0 };
    const willScore = launchColumnScores(tpl, ant.spawnX) ? 1 : 0;
    const hw = tpl.highway;
    if (!hw || !(hw.period > 0)) return { willScore, offTrack: 0 };
    const cycles = Math.max(0, ant.steps - (hw.formationStep ?? 0)) / hw.period;
    const predY = ant.spawnY + (hw.driftY ?? 0) * cycles;
    const predX = ant.spawnX + (hw.driftX ?? 0) * cycles;
    const dy = Math.abs(ant.y - predY);
    const rawDx = Math.abs(wrapX(predX) - ant.x) % C.WIDTH;
    const dx = Math.min(rawDx, C.WIDTH - rawDx);
    const offTrack = Math.min(1, Math.max(0, Math.hypot(dx, dy) / C.OFFTRACK_SCALE_ROWS));
    return { willScore, offTrack };
  };

  // ⚠️ 60ではなく100決定回す: 攻撃アリの SELF_DESTRUCT 候補(#24/#25 が生きて動く唯一のケース)
  // が現れるまで、この seed では自爆できる攻撃アリが飛行し続けるまで数十判断かかる(実測)。
  for (let decisionNo = 0; decisionNo < 100 && match.phase !== 'finished'; decisionNo++) {
    for (let i = 0; i < C.DECISION_INTERVAL_STEPS && match.phase !== 'finished'; i++) stepMatch(match);
    for (const sideIndex of [0, 1]) {
      const view = createSideView(match, sideIndex);
      const ctx = {
        attackTemplates: templates.attack,
        disruptTemplates: templates.disrupt,
        disruptById,
        templateById,
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
        if (action.type === 'SELF_DESTRUCT') {
          selfDestructCandidates++;
          const expected = expectedOutcome(action.ant);
          assert.equal(out[24], expected.willScore, `#24(destructTargetWillScore)が独立計算(${expected.willScore})と食い違う: ${out[24]}`);
          assert.ok(
            Math.abs(out[25] - expected.offTrack) < 1e-9,
            `#25(destructTargetOffTrack)が独立計算(${expected.offTrack})と食い違う: ${out[25]}`,
          );
          const tpl = action.ant.templateId ? templateById.get(action.ant.templateId) : null;
          if (tpl && tpl.kind === 'attack') attackSelfDestructCandidates++;
          if (out[24] === 1) willScoreOnes++;
          if (out[25] > 0) offTrackPositives++;
          if (out[25] > offTrackMax) offTrackMax = out[25];
        }
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

  console.log(
    `§30 SELF_DESTRUCT候補=${selfDestructCandidates}(attack=${attackSelfDestructCandidates}) willScore=1:${willScoreOnes} offTrack>0:${offTrackPositives} offTrackMax=${offTrackMax.toFixed(4)}`,
  );
  // 実運用の候補生成経路で #24/#25 が実際に計算対象になることを確認する(配線切れの検出)。
  // ⚠️ SELF_DESTRUCT 候補・攻撃アリ由来の候補自体が0件だとこの検証が成立しないので、まず
  // それを担保する。willScore=1 になるかは発射列サンプリングの RNG 次第で偶然任せなので
  // 厳密な一致は上のループ内で expectedOutcome との突き合わせとして検証済み。ここでは
  // 「攻撃アリの SELF_DESTRUCT 候補が実在し、offTrack が実際に正の値を取る」ことだけを見る。
  assert.ok(selfDestructCandidates > 0, 'SELF_DESTRUCT 候補が1件も生成されなかった(§33 に矛盾)');
  assert.ok(attackSelfDestructCandidates > 0, '攻撃アリの SELF_DESTRUCT 候補が1件も生成されなかった(#24/#25 の検証が空振りする)');
  assert.ok(offTrackPositives > 0, '#25(destructTargetOffTrack)が実運用の候補で一度も正にならない(配線切れの疑い)');
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
    'destructTargetWillScore',
    'destructTargetOffTrack',
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
