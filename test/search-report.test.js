import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slopeBinOf, buildSearchReport, formatSearchReport, SLOPE_BINS } from '../src/search/search-report.js';

// ---- slopeBinOf の境界 ------------------------------------------------------

test('slopeBinOf: 6ビンの境界', () => {
  assert.equal(slopeBinOf(0, 4), 'vertical');
  assert.equal(slopeBinOf(1, 4), 'nearVertical'); // h=0.25 (境界含む)
  assert.equal(slopeBinOf(1, 2), 'shallow'); // h=0.5 (境界含む)
  assert.equal(slopeBinOf(2, 3), 'steep'); // h=0.666...
  assert.equal(slopeBinOf(1, 1), 'diagonal'); // h=1
  assert.equal(slopeBinOf(2, 1), 'lateral'); // h=2
  assert.equal(slopeBinOf(1, 0), 'lateral'); // dy=0
});

test('slopeBinOf: driftX/driftY が null なら null', () => {
  assert.equal(slopeBinOf(null, 4), null);
  assert.equal(slopeBinOf(1, null), null);
});

// ---- ヘルパ: 個体を作る -----------------------------------------------------

function makeIndividual({
  driftX,
  driftY,
  period = 10,
  formationStep = 100,
  trajectoryPeriodic = true,
  fingerprintVerified = false,
  viable = false,
  ruleLength = 3,
  distillation = null,
  distilledViable = null,
} = {}) {
  return {
    highway: { trajectoryPeriodic, fingerprintVerified, formationStep, period, driftX, driftY, speed: null, verifiedCycles: 5 },
    game: { reached: false, arrivalStep: null, steps: 0, entryXAt0: null, endY: 0 },
    viable,
    ruleLength,
    distillation,
    distilledViable,
  };
}

// ---- buildSearchReport ------------------------------------------------------

test('buildSearchReport: ヒストグラムの合計が trajectoryPeriodicCount と一致する', () => {
  const individuals = [
    makeIndividual({ driftX: 0, driftY: 4 }), // vertical
    makeIndividual({ driftX: 1, driftY: 1 }), // diagonal
    makeIndividual({ driftX: 2, driftY: 1 }), // lateral
    makeIndividual({ driftX: null, driftY: null, trajectoryPeriodic: false }), // 除外
  ];
  const report = buildSearchReport(individuals);
  assert.equal(report.totalEvaluations, 4);
  assert.equal(report.trajectoryPeriodicCount, 3);

  const histSum = Object.values(report.highwayVectorHistogram).reduce((a, b) => a + b, 0);
  assert.equal(histSum, report.trajectoryPeriodicCount);

  const slopeSum = Object.values(report.slopeHistogram).reduce((a, b) => a + b, 0);
  assert.equal(slopeSum, report.trajectoryPeriodicCount);

  // 6ビンすべてキーが存在する(0件でも0で出る)
  for (const bin of SLOPE_BINS) {
    assert.ok(bin in report.slopeHistogram);
  }
});

test('buildSearchReport: options.totalEvaluations を優先する', () => {
  const individuals = [makeIndividual({ driftX: 0, driftY: 1 })];
  const report = buildSearchReport(individuals, { totalEvaluations: 1000 });
  assert.equal(report.totalEvaluations, 1000);
});

test('buildSearchReport: 中央値が偶数個・奇数個の両方で正しい', () => {
  // vertical ビンに ruleLength=[3,5,7] (奇数3件 → median=5)
  const oddSet = [
    makeIndividual({ driftX: 0, driftY: 1, ruleLength: 3 }),
    makeIndividual({ driftX: 0, driftY: 1, ruleLength: 5 }),
    makeIndividual({ driftX: 0, driftY: 1, ruleLength: 7 }),
  ];
  const oddReport = buildSearchReport(oddSet);
  assert.equal(oddReport.ruleLengthBySlope.vertical.median, 5);

  // diagonal ビンに ruleLength=[2,4,6,8] (偶数4件 → median=(4+6)/2=5)
  const evenSet = [
    makeIndividual({ driftX: 1, driftY: 1, ruleLength: 2 }),
    makeIndividual({ driftX: 1, driftY: 1, ruleLength: 4 }),
    makeIndividual({ driftX: 1, driftY: 1, ruleLength: 6 }),
    makeIndividual({ driftX: 1, driftY: 1, ruleLength: 8 }),
  ];
  const evenReport = buildSearchReport(evenSet);
  assert.equal(evenReport.ruleLengthBySlope.diagonal.median, 5);
});

test('buildSearchReport: 分母0のとき率は null になる(NaNではない)', () => {
  const report = buildSearchReport([]);
  assert.equal(report.distillationSuccessRate, null);
  for (const bin of SLOPE_BINS) {
    assert.equal(report.gameViabilityBySlope[bin].rate, null);
    assert.notEqual(Number.isNaN(report.gameViabilityBySlope[bin].rate), true);
  }
});

test('buildSearchReport: gameViabilityBySlope が条件付き確率になっている', () => {
  const individuals = [
    makeIndividual({ driftX: 0, driftY: 1, viable: true }), // vertical, viable
    makeIndividual({ driftX: 0, driftY: 1, viable: false }), // vertical, not viable
    makeIndividual({ driftX: 0, driftY: 1, viable: true }), // vertical, viable
    makeIndividual({ driftX: 1, driftY: 1, viable: false }), // diagonal, not viable
  ];
  const report = buildSearchReport(individuals);
  assert.deepEqual(report.gameViabilityBySlope.vertical, { viable: 2, total: 3, rate: 2 / 3 });
  assert.deepEqual(report.gameViabilityBySlope.diagonal, { viable: 0, total: 1, rate: 0 });
});

test('buildSearchReport: Seed Distillation の集計', () => {
  const individuals = [
    makeIndividual({
      driftX: 0,
      driftY: 1,
      viable: true,
      distillation: {
        attempted: true,
        success: true,
        gameUsable: true,
        cropRadius: 4,
        sourceFormationStep: 200,
        distilledFormationStep: 50,
        sourceCellCount: 10,
        distilledCellCount: 3,
        reason: null,
      },
      distilledViable: true,
    }),
    makeIndividual({
      driftX: 0,
      driftY: 1,
      viable: false,
      distillation: {
        attempted: true,
        success: false,
        gameUsable: false,
        cropRadius: null,
        sourceFormationStep: 300,
        distilledFormationStep: null,
        sourceCellCount: 12,
        distilledCellCount: null,
        reason: 'noReproducibleCrop',
      },
      distilledViable: null,
    }),
    makeIndividual({ driftX: 0, driftY: 1, distillation: null, distilledViable: null }), // 未試行
  ];
  const report = buildSearchReport(individuals);
  assert.equal(report.distillationAttemptCount, 2);
  assert.equal(report.distillationSuccessCount, 1);
  assert.equal(report.distillationSuccessRate, 0.5);
  assert.equal(report.medianOriginalFormationStep, (200 + 300) / 2);
  assert.equal(report.medianDistilledFormationStep, 50);
  assert.equal(report.medianFormationReduction, 150);
  assert.equal(report.medianOriginalCellCount, (10 + 12) / 2);
  assert.equal(report.medianDistilledCellCount, 3);
  // 蒸留を試した2件のうち、元 viable は1件(1件目)、蒸留後 viable も1件(1件目)
  assert.equal(report.gameViableBeforeDistillation, 1);
  assert.equal(report.gameViableAfterDistillation, 1);
  assert.equal(report.distillationViabilityGain, 0);
});

// ---- formatSearchReport -----------------------------------------------------

test('formatSearchReport: 空入力でも例外を投げず文字列を返す', () => {
  const report = buildSearchReport([]);
  const text = formatSearchReport(report);
  assert.equal(typeof text, 'string');
  assert.ok(text.length > 0);
});

test('formatSearchReport: 通常入力でも例外を投げず文字列を返す', () => {
  const individuals = [
    makeIndividual({ driftX: 0, driftY: 1, viable: true }),
    makeIndividual({ driftX: 1, driftY: 1, viable: false }),
  ];
  const report = buildSearchReport(individuals);
  const text = formatSearchReport(report);
  assert.equal(typeof text, 'string');
  assert.ok(text.includes('探索レポート'));
});
