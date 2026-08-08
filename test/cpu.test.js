// src/cpu.js の単体テスト。docs/spec.md 機能6・§6検証戦略の CPU の行に対応する。
// data/templates.json にはまだ依存せず、テスト内で手書きした小さな fixture を使う。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as C from '../src/config.js';
import { createCpuAgent } from '../src/cpu.js';
import { wrapX, scoringLaunchColumns, launchColumnScores } from '../src/template.js';
// rng は engine.js が提供する決定論的な擬似乱数を使う(cpu.js 自体は engine を import しない)。
import { createRng } from '../src/engine.js';

const CPU_SOURCE_PATH = fileURLToPath(new URL('../src/cpu.js', import.meta.url));

// ---------------------------------------------------------------------------
// fixture: 攻撃3種・妨害3種の小さなテンプレート集
// ---------------------------------------------------------------------------

// v5: テンプレートは antX を持たず、cells はアリからの相対 [dx, dy, state]。
// entryXAt0 は「発射列0で撃ったときに敵陣へ入る列」。全部 0 にしておくと
// scoringLaunchColumns() は min=SCORE_GATE_X_MIN(=32), count=SCORE_GATE_WIDTH(=192) になる
// (src/template.js 参照)。
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
  const A2 = {
    id: 'A2',
    kind: 'attack',
    rule: 'RL',
    colorCount: 2,
    cells: [[3, 22, 1], [4, 22, 1]],
    antY: 50,
    antDir: 0,
    entryXAt0: 0,
  };
  const A3 = {
    id: 'A3',
    kind: 'attack',
    rule: 'RLL',
    colorCount: 3,
    cells: [[5, 5, 1], [5, 6, 1], [5, 7, 1]],
    antY: 10,
    antDir: 2,
    entryXAt0: 0,
  };
  const D1 = {
    id: 'D1',
    kind: 'disrupt',
    rule: 'RL',
    colorCount: 2,
    cells: [[6, 40, 1]],
    antY: 41,
    antDir: 1,
  };
  const D2 = {
    id: 'D2',
    kind: 'disrupt',
    rule: 'RRL',
    colorCount: 3,
    cells: [[6, 41, 1], [6, 42, 1]],
    antY: 2,
    antDir: 0,
  };
  const D3 = {
    id: 'D3',
    kind: 'disrupt',
    rule: 'LR',
    colorCount: 2,
    cells: [[1, 1, 1]],
    antY: 1,
    antDir: 3,
  };

  return {
    attack: [A1, A2, A3],
    disrupt: [D1, D2, D3],
    identifyTable: {
      '23,1': 'A1',
      '50,0': 'A2',
      '10,2': 'A3',
      '41,1': 'D1',
      '2,0': 'D2',
      '1,3': 'D3',
    },
    counterTable: {
      A1: [
        { disruptId: 'D2', deltaX: 5, fireAtStep: 600, successRate: 1.0 },
        { disruptId: 'D1', deltaX: 3, fireAtStep: 150, successRate: 0.5 },
      ],
    },
    escortTable: {
      A1: {
        D2: [
          { interceptDeltaX: 5, interceptFireAtStep: 600, escortDisruptId: 'D3', escortDeltaX: 2, fireAtStep: 300 },
        ],
      },
    },
  };
}

function basePolicy(overrides = {}) {
  return {
    fireThreshold: 5,
    reserveTokens: 0,
    defendBias: 0,
    escortBias: 0,
    attackPref: [1, 1, 1],
    ...overrides,
  };
}

// ⚠️ 実物の createSideView が返すフィールドを漏らさないこと。
// v5.2 で盤面の派生スカラー、v5.3 で列ごとの非白セル数(columnNonWhite)が増えた。
// fixture がこれらを欠くと cpu.js 側で undefined を掴んで NaN になり、
// 「テストは通るのに実戦で壊れる」逆パターンになる。
function baseView(overrides = {}) {
  return {
    step: 0,
    tokens: 0,
    score: 0,
    enemyScore: 0,
    flyingCount: 0,
    myAnts: [],
    enemyAnts: [],
    boardPollution: 0,
    myZonePollution: 0,
    enemyZonePollution: 0,
    columnNonWhite: new Int32Array(C.WIDTH),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 静的検査: engine.js を import していない
// ---------------------------------------------------------------------------

test('src/cpu.js は src/engine.js を import していない(実行時探索をしない設計の担保)', () => {
  const source = readFileSync(CPU_SOURCE_PATH, 'utf8');
  assert.ok(!/from\s+['"][^'"]*engine(\.js)?['"]/.test(source), 'engine.js の import 文がある');
  assert.ok(!/require\(\s*['"][^'"]*engine(\.js)?['"]\s*\)/.test(source), 'engine.js の require がある');
  assert.ok(!/^\s*import[\s\S]*?engine(\.js)?['"]/m.test(source), 'engine.js を参照する import 文がある');
});

// ---------------------------------------------------------------------------
// 発射条件(fireThreshold / reserveTokens)
// ---------------------------------------------------------------------------

test('fireThreshold未満のトークンでは待機する(nullを返す)', () => {
  const templates = makeTemplates();
  const policy = basePolicy({ fireThreshold: 8 });
  const agent = createCpuAgent({ templates, policy, rng: createRng(1) });
  const action = agent.decide(baseView({ tokens: 5 }));
  assert.equal(action, null);
});

test('reserveTokensを下回る攻撃はしない', () => {
  const templates = makeTemplates();
  // 攻撃コストは A1=6, A2=7, A3=8。reserveTokens=6 なら tokens>=12 でないと A1 も撃てない。
  const policy = basePolicy({ fireThreshold: 5, reserveTokens: 6 });
  const agent = createCpuAgent({ templates, policy, rng: createRng(1) });
  const action = agent.decide(baseView({ tokens: 10 }));
  assert.equal(action, null);
});

test('使えるテンプレートが1件も無いとき(全部トークン不足)待機する', () => {
  const templates = makeTemplates();
  const policy = basePolicy({ fireThreshold: 5, reserveTokens: 25 });
  const agent = createCpuAgent({ templates, policy, rng: createRng(1) });
  const action = agent.decide(baseView({ tokens: 30 }));
  assert.equal(action, null);
});

// ---------------------------------------------------------------------------
// 迎撃(defend)
// ---------------------------------------------------------------------------

test('敵の攻撃をidentifyTableで特定しcounterTableの妨害を選ぶ(成功率の高い順)', () => {
  const templates = makeTemplates();
  const policy = basePolicy({ defendBias: 1, fireThreshold: 999 }); // 攻撃は絶対しない
  const scheduled = [];
  const agent = createCpuAgent({
    templates,
    policy,
    rng: createRng(1), // next() < 1 は常に真なので defendBias=1 で必ず迎撃を試みる
    scheduleFire: (action, atStep) => scheduled.push({ action, atStep }),
  });
  const view = baseView({
    step: 0,
    tokens: 30,
    enemyAnts: [
      { id: 1, kind: 'attack', x: 40, spawnX: 14, spawnY: 23, spawnDir: 1, ownerX: 40, ownerY: 23, ownerDir: 1, firedAtStep: 100 },
    ],
  });
  const action = agent.decide(view);
  assert.equal(action, null); // 未来のタイミングなので予約発射(scheduleFire)
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].action.templateId, 'D2'); // successRate 1.0 が優先される
  assert.equal(scheduled[0].atStep, 100 + 600); // 敵の firedAtStep からの相対
  assert.equal(scheduled[0].action.rule, 'RRL'); // D2 の rule がそのまま載る
});

// ---------------------------------------------------------------------------
// v5.4 §10.1〜§10.3: 迎撃の発射列はテーブル照準(spawnX + counterTable.deltaX)
// ---------------------------------------------------------------------------

test('§10.1 迎撃の発射列はwrapX(threat.spawnX + counter.deltaX)', () => {
  const templates = makeTemplates();
  templates.counterTable.A1 = [{ disruptId: 'D2', deltaX: 12, fireAtStep: 600, successRate: 1.0 }];
  const policy = basePolicy({ defendBias: 1, fireThreshold: 999 });
  const agent = createCpuAgent({ templates, policy, rng: createRng(1) });
  const view = baseView({
    step: 600, // firedAtStep(0) + fireAtStep(600) = ちょうど今 → 予約せず即座に返る
    tokens: 30,
    enemyAnts: [
      { id: 1, kind: 'attack', x: 100, spawnX: 100, spawnY: 23, spawnDir: 1, ownerX: 100, ownerY: 23, ownerDir: 1, firedAtStep: 0 },
    ],
  });
  const action = agent.decide(view);
  assert.equal(action?.templateId, 'D2');
  assert.equal(action.antX, 112); // wrapX(100 + 12)
});

test('§10.2 迎撃の発射列はトーラスでwrapする(spawnX + deltaX が WIDTH を超える場合)', () => {
  const templates = makeTemplates();
  templates.counterTable.A1 = [{ disruptId: 'D2', deltaX: 12, fireAtStep: 600, successRate: 1.0 }];
  const policy = basePolicy({ defendBias: 1, fireThreshold: 999 });
  const agent = createCpuAgent({ templates, policy, rng: createRng(1) });
  const view = baseView({
    step: 600,
    tokens: 30,
    enemyAnts: [
      { id: 1, kind: 'attack', x: 250, spawnX: 250, spawnY: 23, spawnDir: 1, ownerX: 250, ownerY: 23, ownerDir: 1, firedAtStep: 0 },
    ],
  });
  const action = agent.decide(view);
  assert.equal(action?.templateId, 'D2');
  assert.equal(action.antX, 6); // wrapX(250 + 12) = 262 - 256 = 6
});

test('§10.3 迎撃は現在位置(x)ではなくspawnXを基準にする', () => {
  const templates = makeTemplates();
  templates.counterTable.A1 = [{ disruptId: 'D2', deltaX: 12, fireAtStep: 600, successRate: 1.0 }];
  const policy = basePolicy({ defendBias: 1, fireThreshold: 999 });
  const agent = createCpuAgent({ templates, policy, rng: createRng(1) });
  const view = baseView({
    step: 600,
    tokens: 30,
    enemyAnts: [
      // spawnX(発射列=100)と x(現在列=180)をわざと変えてある。
      { id: 1, kind: 'attack', x: 180, spawnX: 100, spawnY: 23, spawnDir: 1, ownerX: 180, ownerY: 23, ownerDir: 1, firedAtStep: 0 },
    ],
  });
  const action = agent.decide(view);
  assert.equal(action?.templateId, 'D2');
  assert.equal(action.antX, 112); // wrapX(100 + 12)。x(180)を使うと192になってしまうがそれは誤り
  assert.notEqual(action.antX, 192);
});

test('迎撃候補が複数あるとき、実際に選ばれた候補のdeltaXが使われる(先頭候補のdeltaXを使い回すバグの検出)', () => {
  const templates = makeTemplates();
  // successRate降順で先頭は D2(deltaX=12) だが、そのfireAtStepは現在ステップより過去なので
  // スキップされ、2番目の D1(deltaX=30) が選ばれるはず。列も D1 のdeltaXで計算されないと壊れている。
  templates.counterTable.A1 = [
    { disruptId: 'D2', deltaX: 12, fireAtStep: 50, successRate: 1.0 },
    { disruptId: 'D1', deltaX: 30, fireAtStep: 600, successRate: 0.5 },
  ];
  const policy = basePolicy({ defendBias: 1, fireThreshold: 999 });
  const scheduled = [];
  const agent = createCpuAgent({
    templates,
    policy,
    rng: createRng(1),
    scheduleFire: (action, atStep) => scheduled.push({ action, atStep }),
  });
  const view = baseView({
    step: 700, // firedAtStep(0)+D2(50)=50 < 700 なのでスキップ。firedAtStep(0)+D1(600)=600 も実は過去…
    tokens: 30,
    enemyAnts: [
      { id: 1, kind: 'attack', x: 100, spawnX: 100, spawnY: 23, spawnDir: 1, ownerX: 100, ownerY: 23, ownerDir: 1, firedAtStep: 100 },
    ],
  });
  const action = agent.decide(view);
  // firedAtStep(100)+D2(50)=150 < 700 → スキップ。firedAtStep(100)+D1(600)=700 == 現在ステップ → 今すぐ発火。
  assert.equal(action?.templateId, 'D1');
  assert.equal(action.antX, 130); // wrapX(100 + 30)。12を使い回していたら112になってしまう
  assert.equal(scheduled.length, 0);
});

test('counterTableのfireAtStepがすべて過去なら迎撃しない', () => {
  const templates = makeTemplates();
  const policy = basePolicy({ defendBias: 1, fireThreshold: 999 });
  const scheduled = [];
  const agent = createCpuAgent({
    templates,
    policy,
    rng: createRng(1),
    scheduleFire: (action, atStep) => scheduled.push({ action, atStep }),
  });
  // D2: 100+600=700, D1: 100+150=250。両方とも現在ステップ800より過去。
  const view = baseView({
    step: 800,
    tokens: 30,
    enemyAnts: [
      { id: 1, kind: 'attack', spawnX: 14, spawnY: 23, spawnDir: 1, ownerX: 14, ownerY: 23, ownerDir: 1, firedAtStep: 100 },
    ],
  });
  const action = agent.decide(view);
  assert.equal(action, null);
  assert.equal(scheduled.length, 0);
});

// ---------------------------------------------------------------------------
// 護衛(escort)
// ---------------------------------------------------------------------------

test('escortBiasで護衛を選ぶ: 敵の迎撃を観測しなくても、自分の攻撃を撃った、まさにそのステップでcounterTableから予測して先回りで予約する', () => {
  const templates = makeTemplates();
  // reserveTokens を高くして「A1 だけが撃てる」トークン数に固定する(A1コスト=6, A2=7, A3=8)。
  // tokens=106, reserve=100 → A1(106-6=100>=100)だけ affordable。攻撃選択を一意に固定するため。
  const policy = basePolicy({ escortBias: 1, fireThreshold: 0, reserveTokens: 100 });
  const scheduled = [];
  const agent = createCpuAgent({
    templates,
    policy,
    rng: createRng(1),
    scheduleFire: (action, atStep) => scheduled.push({ action, atStep }),
  });
  // 敵の迎撃アリはまだ view に一切現れていない(=enemyAnts が空)。myAnts にも自分の攻撃アリは
  // まだ居ない(=これから撃つ攻撃)。それでも tryAttack が A1 を選んだ、まさにそのステップで
  // counterTable[A1] から敵の予測迎撃(D2, successRate最良)を導き、escortTable[A1][D2] の
  // タイミングで護衛を予約できるはず(次の判断まで待たない)。
  const view = baseView({ step: 0, tokens: 106, myAnts: [], enemyAnts: [] });
  const action = agent.decide(view);
  assert.equal(action?.templateId, 'A1'); // 攻撃自体はこのステップで即返る
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].action.templateId, 'D3');
  assert.equal(scheduled[0].atStep, 0 + 300); // 自分が撃った今このステップ(0)からの相対
  // v5.4: 護衛の発射列はescortTableのescortDeltaXが決める(テーブル照準復帰)。
  // 基準は自分が撃った攻撃の発射列(antX)。
  assert.equal(scheduled[0].action.antX, wrapX(action.antX + 2)); // escortDeltaX=2(makeTemplates参照)
  // 攻撃自体の発射列は、得点ゲートに届く区間の中にある
  assert.ok(launchColumnScores(templates.attack.find((a) => a.id === 'A1'), action.antX));
});

test('§10.4 護衛の発射列はwrapX(myAttack.spawnX + escort.escortDeltaX)', () => {
  const templates = makeTemplates();
  // counterTable[A1]の予測迎撃(D2)に対応するescortTable[A1][D2]を、escortDeltaX=10・
  // fireAtStep=50に差し替える(spec §10.4の固定値どおりに検証するため)。
  templates.counterTable.A1 = [{ disruptId: 'D2', deltaX: 5, fireAtStep: 600, successRate: 1.0 }];
  templates.escortTable.A1.D2 = [
    { interceptDeltaX: 5, interceptFireAtStep: 600, escortDisruptId: 'D3', escortDeltaX: 10, fireAtStep: 50 },
  ];
  const policy = basePolicy({ escortBias: 1, fireThreshold: 999 }); // 攻撃はしない、既に飛んでいる攻撃だけを護衛する
  const agent = createCpuAgent({ templates, policy, rng: createRng(1) });
  const view = baseView({
    step: 50, // myAnt.firedAtStep(0) + fireAtStep(50) = ちょうど今 → 予約せず即座に返る
    tokens: 30,
    myAnts: [
      { id: 2, kind: 'attack', templateId: 'A1', spawnX: 250, firedAtStep: 0 },
    ],
  });
  const action = agent.decide(view);
  assert.equal(action?.templateId, 'D3');
  assert.equal(action.antX, 4); // wrapX(250 + 10) = 260 - 256 = 4
});

test('counterTableに攻撃のエントリが無ければ護衛を予約しない(攻撃自体は撃つ)', () => {
  const templates = makeTemplates();
  // 攻撃テンプレートを A2 1件だけにした fixture。A2 は counterTable にエントリが無い
  // (makeTemplates 参照) → 予測できないので護衛は撃たれない。
  templates.attack = templates.attack.filter((a) => a.id === 'A2');
  const policy = basePolicy({ escortBias: 1, fireThreshold: 0, reserveTokens: 0, attackPref: [1] });
  const scheduled = [];
  const agent = createCpuAgent({
    templates,
    policy,
    rng: createRng(1),
    scheduleFire: (action, atStep) => scheduled.push({ action, atStep }),
  });
  const view = baseView({ step: 0, tokens: 30, myAnts: [], enemyAnts: [] });
  const action = agent.decide(view);
  assert.equal(action?.templateId, 'A2');
  assert.equal(scheduled.length, 0);
});

// ---------------------------------------------------------------------------
// 攻撃選択(attackPref の softmax)
// ---------------------------------------------------------------------------

test('攻撃選択はattackPrefのsoftmaxに従い、重みの大きいものが多く選ばれる', () => {
  const templates = makeTemplates();
  const policy = basePolicy({ fireThreshold: 0, reserveTokens: 0, attackPref: [0.01, 0.01, 6] });
  const counts = { A1: 0, A2: 0, A3: 0 };
  const N = 300;
  const agent = createCpuAgent({ templates, policy, rng: createRng(1) });
  for (let i = 0; i < N; i++) {
    const action = agent.decide(baseView({ tokens: 30 }));
    counts[action.templateId]++;
    // 選んだ発射列は、必ず得点ゲートに届く区間の中にある
    const tpl = templates.attack.find((a) => a.id === action.templateId);
    assert.ok(launchColumnScores(tpl, action.antX), `antX=${action.antX} が得点ゲートに届かない`);
  }
  assert.ok(counts.A3 > counts.A1 + counts.A2, `A3(重み最大)が多数派になるはず: ${JSON.stringify(counts)}`);
});

test('発射アクションにruleが載っている(載っていないとengineが既定ルールにフォールバックする)', () => {
  const templates = makeTemplates();
  const policy = basePolicy({ fireThreshold: 0, reserveTokens: 0, attackPref: [1, 1, 1] });
  const agent = createCpuAgent({ templates, policy, rng: createRng(1) });
  const action = agent.decide(baseView({ tokens: 30 }));
  assert.ok(action, '攻撃を選ばなかった');
  const tpl = templates.attack.find((a) => a.id === action.templateId);
  assert.equal(action.rule, tpl.rule);
});

test('攻撃選択は同じシードで再現し、決定は完全に再現する', () => {
  const templates = makeTemplates();
  const policy = basePolicy({ fireThreshold: 0, reserveTokens: 0, attackPref: [1, 2, 3] });
  const views = Array.from({ length: 20 }, () => baseView({ tokens: 30 }));

  const run = () => {
    const agent = createCpuAgent({ templates, policy, rng: createRng(42) });
    return views.map((v) => agent.decide(v)?.templateId ?? null);
  };

  const r1 = run();
  const r2 = run();
  assert.deepEqual(r1, r2);
});

// ---------------------------------------------------------------------------
// 自爆(selfDestruct) v5.4: 候補条件が「寿命の消化割合」から「残り判断tick数」に変わった
// ---------------------------------------------------------------------------

test('§10.5 自爆: 残り1tickのアリは閾値1で候補になる', () => {
  const templates = makeTemplates();
  // life=20000, steps=19330 → remainingSteps=670 → remainingTicks=ceil(670/670)=1
  const policy = basePolicy({
    fireThreshold: 999, // 攻撃はしない
    defendBias: 0,
    escortBias: 0,
    selfDestructRemainingTicks: 1,
    selfDestructBias: 1,
  });
  const destroyedIds = [];
  const agent = createCpuAgent({
    templates,
    policy,
    rng: createRng(1),
    selfDestruct: (id) => destroyedIds.push(id),
  });
  const view = baseView({
    step: 0,
    tokens: 0,
    flyingCount: 1,
    myAnts: [{ id: 9, kind: 'attack', life: 20000, steps: 19330 }],
  });
  agent.decide(view);
  assert.deepEqual(destroyedIds, [9]);
});

// docs/spec.md 機能6 受け入れ条件「selfDestructRemainingTicks=5 の場合、残り3,350ステップ
// 以下のアリが候補になる」。§10.5/§10.6 は閾値1・2しか触っていないので境界を1点足す。
test('自爆: 閾値5では残り3,350ステップちょうどが候補、3,351ステップは候補外', () => {
  const templates = makeTemplates();
  const makeAgent = (destroyedIds) =>
    createCpuAgent({
      templates,
      policy: basePolicy({
        fireThreshold: 999,
        defendBias: 0,
        escortBias: 0,
        selfDestructRemainingTicks: 5,
        selfDestructBias: 1,
      }),
      rng: createRng(1),
      selfDestruct: (id) => destroyedIds.push(id),
    });
  // 5 tick = 5 * DECISION_INTERVAL_STEPS = 3,350 ステップ。
  const boundary = 5 * C.DECISION_INTERVAL_STEPS;
  assert.equal(boundary, 3350); // 前提が崩れたら気づけるように明示する

  // 残り3,350 → ceil(3350/670)=5 → 候補
  const inRange = [];
  makeAgent(inRange).decide(
    baseView({
      step: 0,
      tokens: 0,
      flyingCount: 1,
      myAnts: [{ id: 9, kind: 'attack', life: 20000, steps: 20000 - boundary }],
    }),
  );
  assert.deepEqual(inRange, [9]);

  // 残り3,351 → ceil(3351/670)=6 → 候補外(selfDestructBias=1 でも消えない)
  const outOfRange = [];
  makeAgent(outOfRange).decide(
    baseView({
      step: 0,
      tokens: 0,
      flyingCount: 1,
      myAnts: [{ id: 9, kind: 'attack', life: 20000, steps: 20000 - boundary - 1 }],
    }),
  );
  assert.deepEqual(outOfRange, []);
});

test('§10.6 自爆: 残り2tickのアリは閾値1では候補外、閾値2では候補になる', () => {
  const templates = makeTemplates();
  // life=20000, steps=19329 → remainingSteps=671 → remainingTicks=ceil(671/670)=2
  const makeView = () =>
    baseView({
      step: 0,
      tokens: 0,
      flyingCount: 1,
      myAnts: [{ id: 9, kind: 'attack', life: 20000, steps: 19329 }],
    });

  const policyOff = basePolicy({
    fireThreshold: 999,
    defendBias: 0,
    escortBias: 0,
    selfDestructRemainingTicks: 1,
    selfDestructBias: 1,
  });
  const destroyedOff = [];
  createCpuAgent({
    templates,
    policy: policyOff,
    rng: createRng(1),
    selfDestruct: (id) => destroyedOff.push(id),
  }).decide(makeView());
  assert.deepEqual(destroyedOff, [], '閾値1では候補外のはず');

  const policyOn = basePolicy({
    fireThreshold: 999,
    defendBias: 0,
    escortBias: 0,
    selfDestructRemainingTicks: 2,
    selfDestructBias: 1,
  });
  const destroyedOn = [];
  createCpuAgent({
    templates,
    policy: policyOn,
    rng: createRng(1),
    selfDestruct: (id) => destroyedOn.push(id),
  }).decide(makeView());
  assert.deepEqual(destroyedOn, [9], '閾値2では候補になるはず');
});

test('§10.7 妨害アリの境界: life=6000,steps=0 → remainingTicks=ceil(6000/670)=9', () => {
  const templates = makeTemplates();
  const makeView = () =>
    baseView({
      step: 0,
      tokens: 0,
      flyingCount: 1,
      myAnts: [{ id: 9, kind: 'disrupt', life: 6000, steps: 0 }],
    });
  const runWith = (selfDestructRemainingTicks) => {
    const destroyed = [];
    const policy = basePolicy({
      fireThreshold: 999,
      defendBias: 0,
      escortBias: 0,
      selfDestructRemainingTicks,
      selfDestructBias: 1,
    });
    createCpuAgent({
      templates,
      policy,
      rng: createRng(1),
      selfDestruct: (id) => destroyed.push(id),
    }).decide(makeView());
    return destroyed;
  };
  assert.deepEqual(runWith(8), [], '閾値8では候補外のはず');
  assert.deepEqual(runWith(9), [9], '閾値9では候補になるはず');
  assert.deepEqual(runWith(10), [9], '閾値10でも候補になるはず');
});

test('自爆候補が0匹ならselfDestructBias=1でも自爆しない(乱数を消費せず即return)', () => {
  const templates = makeTemplates();
  // remainingTicks は必ず1以上なので、selfDestructRemainingTicks の既定値(0)なら候補ゼロ。
  const policy = basePolicy({
    fireThreshold: 999,
    defendBias: 0,
    escortBias: 0,
    selfDestructBias: 1, // selfDestructRemainingTicks は未指定(既定0=候補なし)
  });
  const destroyed = [];
  const agent = createCpuAgent({
    templates,
    policy,
    rng: createRng(1),
    selfDestruct: (id) => destroyed.push(id),
  });
  const view = baseView({
    step: 0,
    tokens: 0,
    flyingCount: 1,
    myAnts: [{ id: 9, kind: 'attack', life: 20000, steps: 19330 }],
  });
  agent.decide(view);
  assert.deepEqual(destroyed, []);
});

// ---------------------------------------------------------------------------
// 総合: 同じシード・同じview列で決定が完全に再現する(迎撃・護衛・攻撃を混ぜた列)
// ---------------------------------------------------------------------------

test('同じシード・同じview列で決定が完全に再現する', () => {
  const templates = makeTemplates();
  const policy = basePolicy({
    fireThreshold: 5,
    reserveTokens: 0,
    defendBias: 0.5,
    escortBias: 0.5,
    attackPref: [1, 1, 2],
  });

  const views = [
    baseView({ step: 0, tokens: 30 }),
    baseView({
      step: 1,
      tokens: 30,
      enemyAnts: [{ id: 1, kind: 'attack', spawnX: 14, spawnY: 23, spawnDir: 1, ownerX: 14, ownerY: 23, ownerDir: 1, firedAtStep: 0 }],
    }),
    baseView({
      step: 2,
      tokens: 30,
      myAnts: [{ id: 2, kind: 'attack', templateId: 'A1', firedAtStep: 0 }],
      enemyAnts: [{ id: 3, kind: 'disrupt', spawnX: 2, spawnY: 2, spawnDir: 0, ownerX: 2, ownerY: 2, ownerDir: 0, firedAtStep: 1 }],
    }),
    baseView({ step: 3, tokens: 30 }),
  ];

  const run = () => {
    const scheduled = [];
    const agent = createCpuAgent({
      templates,
      policy,
      rng: createRng(7),
      scheduleFire: (action, atStep) => scheduled.push({ action, atStep }),
    });
    const decisions = views.map((v) => agent.decide(v));
    return { decisions, scheduled };
  };

  const r1 = run();
  const r2 = run();
  assert.deepEqual(r1, r2);
});
