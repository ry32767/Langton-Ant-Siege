// src/cpu.js の単体テスト。docs/spec.md 機能6・§6検証戦略の CPU の行に対応する。
// data/templates.json にはまだ依存せず、テスト内で手書きした小さな fixture を使う。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as C from '../src/config.js';
import { createCpuAgent } from '../src/cpu.js';
// rng は engine.js が提供する決定論的な擬似乱数を使う(cpu.js 自体は engine を import しない)。
import { createRng } from '../src/engine.js';

const CPU_SOURCE_PATH = fileURLToPath(new URL('../src/cpu.js', import.meta.url));

// ---------------------------------------------------------------------------
// fixture: 攻撃3種・妨害3種の小さなテンプレート集
// ---------------------------------------------------------------------------

function makeTemplates() {
  const A1 = {
    id: 'A1',
    kind: 'attack',
    rule: 'RRL',
    colorCount: 3,
    cells: [[3, 21, 1]],
    antX: 14,
    antY: 23,
    antDir: 1,
  };
  const A2 = {
    id: 'A2',
    kind: 'attack',
    rule: 'RL',
    colorCount: 2,
    cells: [[3, 22, 1], [4, 22, 1]],
    antX: 3,
    antY: 50,
    antDir: 0,
  };
  const A3 = {
    id: 'A3',
    kind: 'attack',
    rule: 'RLL',
    colorCount: 3,
    cells: [[5, 5, 1], [5, 6, 1], [5, 7, 1]],
    antX: 10,
    antY: 10,
    antDir: 2,
  };
  const D1 = {
    id: 'D1',
    kind: 'disrupt',
    rule: 'RL',
    colorCount: 2,
    cells: [[6, 40, 1]],
    antX: 5,
    antY: 41,
    antDir: 1,
  };
  const D2 = {
    id: 'D2',
    kind: 'disrupt',
    rule: 'RRL',
    colorCount: 3,
    cells: [[6, 41, 1], [6, 42, 1]],
    antX: 2,
    antY: 2,
    antDir: 0,
  };
  const D3 = {
    id: 'D3',
    kind: 'disrupt',
    rule: 'LR',
    colorCount: 2,
    cells: [[1, 1, 1]],
    antX: 1,
    antY: 1,
    antDir: 3,
  };

  return {
    attack: [A1, A2, A3],
    disrupt: [D1, D2, D3],
    identifyTable: {
      '14,23,1': 'A1',
      '3,50,0': 'A2',
      '10,10,2': 'A3',
      '5,41,1': 'D1',
      '2,2,0': 'D2',
      '1,1,3': 'D3',
    },
    counterTable: {
      A1: [
        { disruptId: 'D2', fireAtStep: 600, successRate: 1.0 },
        { disruptId: 'D1', fireAtStep: 150, successRate: 0.5 },
      ],
    },
    escortTable: {
      A1: { D2: [{ escortId: 'D3', fireAtStep: 300 }] },
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

function baseView(overrides = {}) {
  return {
    step: 0,
    tokens: 0,
    score: 0,
    enemyScore: 0,
    flyingCount: 0,
    myAnts: [],
    enemyAnts: [],
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
      { id: 1, kind: 'attack', spawnX: 14, spawnY: 23, spawnDir: 1, ownerX: 14, ownerY: 23, ownerDir: 1, firedAtStep: 100 },
    ],
  });
  const action = agent.decide(view);
  assert.equal(action, null); // 未来のタイミングなので予約発射(scheduleFire)
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].action.templateId, 'D2'); // successRate 1.0 が優先される
  assert.equal(scheduled[0].atStep, 100 + 600); // 敵の firedAtStep からの相対
  assert.equal(scheduled[0].action.rule, 'RRL'); // D2 の rule がそのまま載る
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
