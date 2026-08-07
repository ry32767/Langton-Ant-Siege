// src/search/evaluate-interaction.js の単体テスト。
// フィクスチャは合成データのみを使う(data/*.json は旧スキーマなので読まない)。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/config.js';
import * as E from '../src/engine.js';
import {
  evaluateInteraction,
  buildCounterMatrix,
  buildEscortTable,
} from '../src/search/evaluate-interaction.js';

// ---------------------------------------------------------------------------
// 合成フィクスチャ
// ---------------------------------------------------------------------------

// 1色ルールは盤面の状態に関わらず常に同じ方向へ曲がるため、どんな妨害を置いても
// 軌道が変わらない(=カウンターを持たない攻撃)。1歩でスコアラインに到達する。
const attackImmune = {
  id: 'attack-immune',
  rule: 'R',
  cells: [],
  antX: 10,
  antY: C.SCORE_LINE_Y - 1,
  antDir: C.DIR_RIGHT,
  kind: 'attack',
};

// LEGACY_RULE のハイウェイに乗って得点する攻撃(妨害なしなら ATTACK_LIFE 内に得点する)。
const attackHighway = {
  id: 'attack-highway',
  rule: C.LEGACY_RULE,
  cells: [],
  antX: 30,
  antY: 30,
  antDir: C.DIR_RIGHT,
  kind: 'attack',
};

// side1 から撃つと、cells の y はローカル座標なので toGlobalY(1, y) = HEIGHT-1-y でグローバルに変換される。
// attackHighway の発射地点(グローバル (30,30))に迎撃セルを置きたいので、
// ローカル y = HEIGHT-1-30 = 89 を使う(この関数のテストなので genome の
// 配置帯制約(ZONE_DEPTH)には縛られない。engine.js の simulateVersus 自体も縛らない)。
const intercept = {
  id: 'disrupt-intercept',
  rule: C.LEGACY_RULE,
  cells: [[30, C.HEIGHT - 1 - 30, 1]],
  antX: 0,
  antY: 0,
  antDir: C.DIR_UP,
  kind: 'disrupt',
};

// 1色ルールで小さな正方形を無限ループするだけの妨害。攻撃はスコアラインに到達すると
// 即座に消滅するため y>=SCORE_LINE_Y の領域には決して現れない。この妨害は
// y=HEIGHT-1 付近(=y>=SCORE_LINE_Y)に留まるので、どの攻撃も絶対に踏まない(死に札)。
const irrelevant = {
  id: 'disrupt-irrelevant',
  rule: 'R',
  cells: [[0, 0, 1]],
  antX: 0,
  antY: 0,
  antDir: C.DIR_UP,
  kind: 'disrupt',
};

// intercept が (30,30) を白(state=0)で上書きして無効化する護衛。side0 から撃つので
// ローカル y=30 がそのままグローバル y=30 になる。
const escort = {
  id: 'disrupt-escort',
  rule: C.LEGACY_RULE,
  cells: [[30, 30, 0]],
  antX: 0,
  antY: 0,
  antDir: C.DIR_UP,
  kind: 'disrupt',
};

// ---------------------------------------------------------------------------
// evaluateInteraction
// ---------------------------------------------------------------------------

test('evaluateInteraction: 決定論性(同じ入力なら完全一致)', () => {
  const r1 = evaluateInteraction(attackHighway, intercept, 0);
  const r2 = evaluateInteraction(attackHighway, intercept, 0);
  assert.deepEqual(r1, r2);
});

test('evaluateInteraction: 妨害が攻撃の軌道を変え、scored が true→false に変わる', () => {
  const without = evaluateInteraction(attackHighway, null, 0);
  const withDisrupt = evaluateInteraction(attackHighway, intercept, 0);
  assert.equal(without.scored, true);
  assert.equal(withDisrupt.scored, false);
});

test('evaluateInteraction: fireAtStep を変えると結果が変わりうる(タイミングが効く)', () => {
  const early = evaluateInteraction(attackHighway, intercept, 0);
  // 攻撃がとっくに死んでいるであろう遅いタイミングで撃っても、もう軌道には影響しない。
  const late = evaluateInteraction(attackHighway, intercept, C.ATTACK_LIFE + 1000);
  assert.equal(early.scored, false);
  assert.equal(late.scored, true);
});

test('evaluateInteraction: MVP必須フィールド scored のほか、attackSteps は常に数値', () => {
  const r = evaluateInteraction(attackHighway, intercept, 0);
  assert.equal(typeof r.scored, 'boolean');
  assert.equal(typeof r.attackSteps, 'number');
});

// ---------------------------------------------------------------------------
// buildCounterMatrix
// ---------------------------------------------------------------------------

test('buildCounterMatrix: counterTable は「得点しなかった組み合わせ」だけを含む', () => {
  const attacks = [attackImmune, attackHighway];
  const disrupts = [intercept, irrelevant];
  const { matrix, counterTable } = buildCounterMatrix(attacks, disrupts);

  for (let i = 0; i < attacks.length; i++) {
    for (let j = 0; j < disrupts.length; j++) {
      for (let t = 0; t < C.FIRE_TIMINGS.length; t++) {
        const scored = matrix[i][j][t];
        const attackId = attacks[i].id;
        const disruptId = disrupts[j].id;
        const fireAtStep = C.FIRE_TIMINGS[t];
        const listed = counterTable[attackId].some(
          (e) => e.disruptId === disruptId && e.fireAtStep === fireAtStep,
        );
        assert.equal(listed, !scored, `attack=${attackId} disrupt=${disruptId} t=${fireAtStep}`);
      }
    }
  }
});

test('buildCounterMatrix: カウンターを持たない攻撃(1色ルール)が attacksWithoutCounter に入る', () => {
  const attacks = [attackImmune, attackHighway];
  const disrupts = [intercept, irrelevant];
  const { attacksWithoutCounter } = buildCounterMatrix(attacks, disrupts);
  assert.ok(attacksWithoutCounter.includes(attackImmune.id));
  assert.ok(!attacksWithoutCounter.includes(attackHighway.id));
});

test('buildCounterMatrix: 1件も止められない妨害(死に札)が disruptsWithoutCoverage に入る', () => {
  const attacks = [attackImmune, attackHighway];
  const disrupts = [intercept, irrelevant];
  const { disruptsWithoutCoverage } = buildCounterMatrix(attacks, disrupts);
  assert.ok(disruptsWithoutCoverage.includes(irrelevant.id));
  assert.ok(!disruptsWithoutCoverage.includes(intercept.id));
});

test('buildCounterMatrix: counterDensity は0..1の範囲に収まる', () => {
  const attacks = [attackImmune, attackHighway];
  const disrupts = [intercept, irrelevant];
  const { counterDensity } = buildCounterMatrix(attacks, disrupts);
  for (const d of counterDensity) {
    assert.ok(d >= 0 && d <= 1, `counterDensity=${d} は範囲外`);
  }
  assert.equal(counterDensity[0], 0); // attackImmune はどのタイミングでも止められない
});

test('buildCounterMatrix: onProgress が評価件数ぶん呼ばれる', () => {
  const attacks = [attackHighway];
  const disrupts = [intercept];
  let calls = 0;
  buildCounterMatrix(attacks, disrupts, { onProgress: () => calls++ });
  assert.equal(calls, attacks.length * disrupts.length * C.FIRE_TIMINGS.length);
});

// ---------------------------------------------------------------------------
// buildEscortTable
// ---------------------------------------------------------------------------

test('buildEscortTable: 迎撃されて落ちた攻撃を再び得点させる護衛を見つけられる', () => {
  const attacks = [attackHighway];
  const disrupts = [intercept, escort];
  const { counterTable } = buildCounterMatrix(attacks, disrupts);

  // 前提: intercept が fireAtStep=0 で attackHighway を止めていること。
  assert.ok(
    counterTable[attackHighway.id].some((e) => e.disruptId === intercept.id && e.fireAtStep === 0),
    '前提が崩れている: intercept が fireAtStep=0 で止めていない',
  );

  const escortTable = buildEscortTable(attacks, disrupts, counterTable);
  const perIntercept = escortTable[attackHighway.id]?.[intercept.id];
  assert.ok(perIntercept && perIntercept.length > 0, '護衛が見つからなかった');
  assert.ok(perIntercept.some((e) => e.escortDisruptId === escort.id));
});

// ---------------------------------------------------------------------------
// 性能計測(参考値。合否には使わない)
// ---------------------------------------------------------------------------

test('evaluateInteraction: 1件あたりの所要時間を計測する(参考値)', () => {
  const n = 20;
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    evaluateInteraction(attackHighway, intercept, C.FIRE_TIMINGS[i % C.FIRE_TIMINGS.length]);
  }
  const elapsedMs = Date.now() - t0;
  // eslint 的な出力目的ではなく、報告用に console.log する(テスト自体は失敗しない)。
  console.log(`evaluateInteraction: ${(elapsedMs / n).toFixed(3)}ms/件 (n=${n})`);
  assert.ok(elapsedMs >= 0);
});
