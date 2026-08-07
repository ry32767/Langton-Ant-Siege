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

// v5: evaluateInteraction は攻撃を常に antX=0 で instantiateTemplate する。だから
// このフィクスチャ集合の attack/disrupt.antX フィールドは(残していても)評価器からは
// 参照されない。cells は「アリからの相対 [dx,dy,state]」で書く(genome の表現に合わせる)。

// 1色ルールは盤面の状態に関わらず常に同じ方向へ曲がるため、どんな妨害を置いても
// 軌道が変わらない(=カウンターを持たない攻撃)。1歩でスコアラインに到達する。
const attackImmune = {
  id: 'attack-immune',
  rule: 'R',
  cells: [],
  antY: C.SCORE_LINE_Y - 1,
  antDir: C.DIR_RIGHT,
  kind: 'attack',
};

// LEGACY_RULE のハイウェイに乗って得点する攻撃(妨害なしなら ATTACK_LIFE 内に得点する)。
const attackHighway = {
  id: 'attack-highway',
  rule: C.LEGACY_RULE,
  cells: [],
  antY: 30,
  antDir: C.DIR_RIGHT,
  kind: 'attack',
};

// side1 から撃つと、cells の y はローカル座標なので toGlobalY(1, y) = HEIGHT-1-y でグローバルに変換される。
// attackHighway の発射地点(グローバル (antX=0, 30))に迎撃セルを置きたいので、
// dx=0(=deltaX=0のとき攻撃の発射列と同じ列)・ローカル y = HEIGHT-1-30 = 225 を使う
// (この関数のテストなので genome の配置帯制約(ZONE_DEPTH)には縛られない。
// engine.js の simulateVersus 自体も縛らない)。
const intercept = {
  id: 'disrupt-intercept',
  rule: C.LEGACY_RULE,
  cells: [[0, C.HEIGHT - 1 - 30, 1]],
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
  antY: 0,
  antDir: C.DIR_UP,
  kind: 'disrupt',
};

// intercept が (deltaX=0の列, 30) を白(state=0)で上書きして無効化する護衛。side0 から撃つので
// ローカル y=30 がそのままグローバル y=30 になる。dx=0 は intercept と同じ列を突く意味。
const escort = {
  id: 'disrupt-escort',
  rule: C.LEGACY_RULE,
  cells: [[0, 30, 0]],
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
        // deltaXs 省略時は既定 [0] の1要素なので、matrix[i][j][0][t] が唯一の deltaX 断面。
        const scored = matrix[i][j][0][t];
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
// deltaX(§v5: 発射時に選ぶ自由度)
// ---------------------------------------------------------------------------

test('deltaX: 平行移動不変性。攻撃と妨害を同じ量だけずらしても scored は変わらない', () => {
  // instantiateTemplate は「相対テンプレート → 絶対座標の action」への変換そのもの
  // (evaluate-interaction.js が内部でやっているのと同じ)。ここでは直接呼んで、
  // ある基準列(baseX)と、そこから+37列ずらした列とで simulateVersus の結果が一致するか見る。
  const deltaX = 0; // intercept は「攻撃と同じ列(deltaX=0)」を突くと止める(前段のテスト参照)。
  const shift = 37;

  function run(baseX) {
    const attackTpl = E.instantiateTemplate(attackHighway, baseX);
    const disruptTpl = E.instantiateTemplate(intercept, baseX + deltaX);
    return E.simulateVersus(attackTpl, [{ template: disruptTpl, side: 1, fireAtStep: 0, kind: 'disrupt' }]);
  }

  const atOrigin = run(5);
  const shifted = run(5 + shift);
  assert.equal(atOrigin.scored, shifted.scored);
  assert.equal(atOrigin.steps, shifted.steps);
});

test('deltaX: 変えると scored が変わりうる(少なくとも1組の反例)', () => {
  const stopped = evaluateInteraction(attackHighway, intercept, 0, 0);
  // intercept を攻撃の発射列から大きくずらすと、発射直後の妨害セルが攻撃の初手を突かなくなる。
  const missed = evaluateInteraction(attackHighway, intercept, 0, 128);
  assert.equal(stopped.scored, false);
  assert.equal(missed.scored, true);
});

test('deltaX 省略時は既定 0 として、旧シグネチャと同じ結果になる', () => {
  const withDeltaXOmitted = evaluateInteraction(attackHighway, intercept, 0);
  const withDeltaXExplicit0 = evaluateInteraction(attackHighway, intercept, 0, 0);
  assert.deepEqual(withDeltaXOmitted, withDeltaXExplicit0);
});

test('buildCounterMatrix: deltaXs を掃引すると counterTable のエントリに deltaX が入る', () => {
  const attacks = [attackHighway];
  const disrupts = [intercept];
  const deltaXs = [0, 128];
  const { counterTable, matrix, counterDensity } = buildCounterMatrix(attacks, disrupts, { deltaXs });

  const entries = counterTable[attackHighway.id];
  assert.ok(entries.length > 0);
  for (const e of entries) {
    assert.ok(deltaXs.includes(e.deltaX), `deltaX=${e.deltaX} が deltaXs に含まれない`);
  }
  // deltaX=0 は止める、deltaX=128 は止めない(上のテストと同じ前提)。
  assert.ok(entries.some((e) => e.deltaX === 0));
  assert.ok(!entries.some((e) => e.deltaX === 128));

  // matrix[i][j][d][t] の形になっていること。
  assert.equal(matrix[0][0].length, deltaXs.length);
  assert.equal(matrix[0][0][0].length, C.FIRE_TIMINGS.length);

  // 分母は disrupts.length * deltaXs.length * timings.length。
  const expectedDenominator = disrupts.length * deltaXs.length * C.FIRE_TIMINGS.length;
  assert.ok(counterDensity[0] >= 0 && counterDensity[0] <= 1);
  assert.equal(counterDensity[0], entries.length / expectedDenominator);
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
