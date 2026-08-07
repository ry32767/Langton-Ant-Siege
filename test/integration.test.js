// engine と cpu を実際に噛み合わせる結合テスト。
// 単体テストは手書きの view を使うため「view の中身が実際の engine とズレている」
// 種類のバグを取り逃す。実際にそれで CPU の迎撃が丸ごと死んでいたので、ここで塞ぐ。
//
// ⚠️ data/templates.json はまだ旧スキーマ(schemaVersion 5未満)のままなので、ここでは
// 読み込まない。テンプレートは v5 スキーマ(cells は antX,antY からの相対 [dx,dy,state] /
// identifyTable のキーは "antY,antDir" / counterTable の要素は deltaX を持つ)の
// 合成フィクスチャを使う。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/config.js';
import { createMatch, createSideView, fire, stepMatch, createRng } from '../src/engine.js';
import { createCpuAgent } from '../src/cpu.js';

// ---------------------------------------------------------------------------
// fixture: 攻撃1種・妨害1種の小さなテンプレート集(v5スキーマ)
// ---------------------------------------------------------------------------

function makeTemplates() {
  const A1 = {
    id: 'A1',
    kind: 'attack',
    rule: 'RRL',
    colorCount: 3,
    cells: [[3, 10, 1]], // antX=14 相対なら絶対x=17。ここでは actionOf() で直接antXを使うだけなので絶対でも相対でも同じ扱い
    antX: 14,
    antY: 12,
    antDir: 1,
    entryXAt0: 0,
  };
  const D1 = {
    id: 'D1',
    kind: 'disrupt',
    rule: 'RL',
    colorCount: 2,
    cells: [[6, 8, 1]],
    antX: 5,
    antY: 9,
    antDir: 1,
  };
  return {
    attack: [A1],
    disrupt: [D1],
    identifyTable: {
      '12,1': 'A1', // v5: キーは "antY,antDir"(antX は可変になったので含まない)
    },
    counterTable: {
      A1: [{ disruptId: 'D1', deltaX: 0, fireAtStep: 50, successRate: 1.0 }],
    },
    escortTable: {},
  };
}

function actionOf(tpl) {
  return {
    kind: tpl.kind,
    rule: tpl.rule,
    cells: tpl.cells,
    antX: tpl.antX,
    antY: tpl.antY,
    antDir: tpl.antDir,
    templateId: tpl.id,
  };
}

test('発射位置(spawn*)は動かず、現在位置(owner*)だけが動く', () => {
  const match = createMatch({ seed: 1 });
  match.sides[0].tokens = C.TOKEN_CAP; // 試合開始直後はトークン0なので撃てない
  const action = { kind: 'attack', cells: [[3, 10]], antX: 5, antY: 20, antDir: 1 };
  assert.notEqual(fire(match, 0, action), null, '発射に失敗した');

  const before = createSideView(match, 0).myAnts[0];
  assert.equal(before.spawnX, 5);
  assert.equal(before.spawnY, 20);
  assert.equal(before.spawnDir, 1);

  for (let i = 0; i < 5; i++) stepMatch(match);

  const after = createSideView(match, 0).myAnts[0];
  // 発射位置は不変
  assert.equal(after.spawnX, 5);
  assert.equal(after.spawnY, 20);
  assert.equal(after.spawnDir, 1);
  // 現在位置は動いている(これを識別に使うと引けない)
  assert.ok(
    after.ownerX !== before.spawnX || after.ownerY !== before.spawnY,
    'アリが動いていない。テストの前提が壊れている',
  );
});

test('CPU は実際の engine の view から敵の攻撃を identifyTable で特定できる', () => {
  const templates = makeTemplates();
  const attack = templates.attack[0];
  const match = createMatch({ seed: 1 });

  // side1(敵)が A1 を発射する。トークンは足りている状態にしておく
  match.sides[1].tokens = C.TOKEN_CAP;
  const antId = fire(match, 1, actionOf(attack));
  assert.notEqual(antId, null, '発射に失敗した');

  // 数ステップ進めてアリを動かす(識別が現在位置に依存していれば、ここで引けなくなる)
  for (let i = 0; i < 30; i++) stepMatch(match);

  const view = createSideView(match, 0);
  const threat = view.enemyAnts.find((a) => a.kind === 'attack');
  assert.ok(threat, '敵の攻撃アリが view に見えていない');

  const key = `${threat.spawnY},${threat.spawnDir}`; // v5: identifyTable のキーは antX を含まない
  assert.equal(
    templates.identifyTable[key],
    attack.id,
    `identifyTable を引けない(キー ${key})。spawn* が発射位置になっていない可能性`,
  );
});

test('両陣営の判断は同時で、相手が同じステップで撃ったアリは見えない', () => {
  // これを逐次にすると、後に判断する側だけが相手の発射を即座に見られてしまい、
  // 情報の非対称から先手勝率が100%になる。実際にそのバグを出したので回帰を防ぐ。
  const match = createMatch({ seed: 1 });
  const seen = [[], []];

  const makeAgent = (sideIndex) => ({
    decide(view) {
      // 相手の陣営のアリが view に何匹見えていたかを記録する
      seen[sideIndex].push(view.enemyAnts.length);
      // 毎回の判断で必ず1匹撃つ(トークンは下で潤沢にしておく)
      return { kind: 'attack', cells: [[1, 10 + sideIndex]], antX: 2, antY: 10 + sideIndex, antDir: 1 };
    },
  });
  match.sides[0].agent = makeAgent(0);
  match.sides[1].agent = makeAgent(1);

  // 最初の判断(step 0)を通す
  match.sides[0].tokens = C.TOKEN_CAP;
  match.sides[1].tokens = C.TOKEN_CAP;
  stepMatch(match);

  // どちらの陣営も、最初の判断時点では相手のアリを0匹しか見ていないはず。
  // 逐次判断だと後手側が 1 を見てしまう。
  assert.deepEqual(
    [seen[0][0], seen[1][0]],
    [0, 0],
    '後に判断した側が、相手が同じステップで撃ったアリを見てしまっている',
  );
  // 実際には両陣営とも発射できている(テストが空振りしていないことの確認)
  assert.equal(match.sides[0].ants.length, 1);
  assert.equal(match.sides[1].ants.length, 1);
});

test('CPU は識別した攻撃に対して迎撃を予約する', () => {
  const templates = makeTemplates();
  const attack = templates.attack.find((a) => (templates.counterTable[a.id] ?? []).length > 0);
  assert.ok(attack, 'カウンターを持つ攻撃が1件も無い');

  const match = createMatch({ seed: 1 });
  match.sides[1].tokens = C.TOKEN_CAP;
  fire(match, 1, actionOf(attack));

  const scheduled = [];
  const agent = createCpuAgent({
    templates,
    // 必ず迎撃を選ぶ方策にして、確率で流れるのを防ぐ
    policy: {
      fireThreshold: 0,
      reserveTokens: 0,
      defendBias: 1,
      escortBias: 1,
      attackPref: new Array(templates.attack.length).fill(1),
    },
    rng: createRng(1),
    scheduleFire: (action, atStep) => scheduled.push({ action, atStep }),
  });

  // 防御側(side0)にトークンを持たせて判断させる
  match.sides[0].tokens = C.TOKEN_CAP;
  const view = createSideView(match, 0);
  const immediate = agent.decide(view);

  const fired = immediate !== null || scheduled.length > 0;
  assert.ok(
    fired,
    'CPU が迎撃をまったく選ばなかった。identifyTable / counterTable の参照が死んでいる',
  );

  // 予約された場合、その絶対ステップは「敵の発射ステップ + fireAtStep」でなければならない
  if (scheduled.length > 0) {
    const threat = view.enemyAnts.find((a) => a.kind === 'attack');
    const offsets = templates.counterTable[attack.id].map((c) => c.fireAtStep);
    const actual = scheduled[0].atStep - threat.firedAtStep;
    assert.ok(
      offsets.includes(actual),
      `予約ステップの相対値 ${actual} が counterTable の fireAtStep ${offsets.join(',')} に無い`,
    );
    assert.equal(scheduled[0].action.kind, 'disrupt');
    assert.equal(scheduled[0].action.rule, 'RL'); // D1 の rule がそのまま載る
  }
});

// ---------------------------------------------------------------------------
// CPU vs CPU の試合が最後まで進み、決定論的で、実際に得点しうる
// ---------------------------------------------------------------------------

/**
 * 得点しうる小さなハイウェイ様のテンプレート集(自陣配置帯y=0..15で組む、v5スキーマ)。
 * cells はアリからの相対 [dx, dy, state]。entryXAt0=0 を与えて tryAttack が
 * scoringLaunchColumns() で候補から外されないようにする(count=0 だと一度も発射されない)。
 */
function makeMatchTemplates() {
  const attack = {
    id: 'ATK1',
    kind: 'attack',
    rule: 'RL',
    colorCount: 2,
    cells: [[0, 5, 1]],
    antY: 6,
    antDir: C.DIR_DOWN, // ローカルyが増える向き=自陣を出て相手陣(得点ライン)へ向かう
    entryXAt0: 0,
  };
  const disrupt = {
    id: 'DIS1',
    kind: 'disrupt',
    rule: 'RL',
    colorCount: 2,
    cells: [[0, 5, 1]],
    antY: 6,
    antDir: C.DIR_DOWN,
  };
  return {
    attack: [attack],
    disrupt: [disrupt],
    identifyTable: { [`6,${C.DIR_DOWN}`]: 'ATK1' },
    counterTable: {},
    escortTable: {},
  };
}

function makePolicy() {
  return {
    fireThreshold: 6,
    reserveTokens: 0,
    defendBias: 0.5,
    escortBias: 0.5,
    attackPref: [1],
  };
}

function playMatch(seed) {
  const templates = makeMatchTemplates();
  const policy = makePolicy();
  const match = createMatch({
    seed,
    agents: [
      createCpuAgent({ templates, policy, rng: createRng(seed * 2 + 1) }),
      createCpuAgent({ templates, policy, rng: createRng(seed * 2 + 2) }),
    ],
  });
  // agents オプションは decide() を持つオブジェクトをそのまま match.sides[i].agent にセットする
  // (createMatch の実装参照)。ここでは scheduleFire を渡していないため予約発射は使われないが、
  // それでも decide が null を返さず試合が進行することを確認できれば十分。
  while (match.phase !== 'finished') stepMatch(match);
  return match;
}

test('integration: CPU vs CPU の試合が最後まで進み、同じシードで2回走らせると結果が完全一致する', () => {
  const m1 = playMatch(1);
  const m2 = playMatch(1);
  assert.equal(m1.phase, 'finished');
  assert.equal(m2.phase, 'finished');
  assert.equal(m1.step, m2.step);
  assert.deepEqual(m1.result, m2.result);
  assert.deepEqual(
    [m1.sides[0].score, m1.sides[1].score],
    [m2.sides[0].score, m2.sides[1].score],
  );
});

test('integration: 両陣営が新スキーマのテンプレートで実際に得点しうること(少なくとも試合が正常終了すること)', () => {
  const match = playMatch(2);
  assert.equal(match.phase, 'finished');
  assert.ok(match.step > 0, '1ステップも進んでいない');
  // 少なくともどちらかの陣営が発射できていること(トークン蓄積・fireThreshold が機能している証拠)
  assert.ok(match.sides[0].fired + match.sides[1].fired > 0, '一度も発射されなかった');
});
