// MAP-Elites 探索の観測結果を集計してレポート用オブジェクトにする、純粋関数モジュール。
// 副作用なし・ファイル I/O なし・engine.js を import しない(集計だけを行う)。
// 仕様 §5(観測項目)・§29(追加レポート項目)に対応する。
//
// 呼び出し側は evaluateProjectile / distillSeed の戻り値を組み合わせた個体配列を渡す
// (このファイル自身はそれらを呼ばない。データの形は AGENTS.md の指示どおり
// evaluate-projectile.js / seed-distillation.js を参照して決めた)。

// ---- slope ビンの境界(名前付き定数。マジックナンバーを避ける) --------------
const SLOPE_NEAR_VERTICAL_MAX = 0.25;
const SLOPE_SHALLOW_MAX = 0.5;
const SLOPE_STEEP_MAX = 1; // このちょうど1.0が diagonal
const SLOPE_DIAGONAL = 1;

/** slopeBinOf が返しうるビンの一覧(この順序で histogram にも出す)。 */
export const SLOPE_BINS = Object.freeze(['vertical', 'nearVertical', 'shallow', 'steep', 'diagonal', 'lateral']);

/**
 * drift ベクトルを傾き比 h=|dx|/|dy| で6ビンに分類する。
 * |dy|===0 のときは 'lateral'(横のみ)。driftX/driftY が null なら null を返す。
 *
 * @param {number|null} driftX
 * @param {number|null} driftY
 * @returns {string|null}
 */
export function slopeBinOf(driftX, driftY) {
  if (driftX == null || driftY == null) return null;
  const absDx = Math.abs(driftX);
  const absDy = Math.abs(driftY);
  if (absDy === 0) return 'lateral';
  const h = absDx / absDy;
  if (h === 0) return 'vertical';
  if (h <= SLOPE_NEAR_VERTICAL_MAX) return 'nearVertical';
  if (h <= SLOPE_SHALLOW_MAX) return 'shallow';
  if (h < SLOPE_STEEP_MAX) return 'steep';
  if (h === SLOPE_DIAGONAL) return 'diagonal';
  return 'lateral';
}

// ---- 数値ヘルパ -------------------------------------------------------------

/** ソートして中央値を取る。空配列なら null。偶数個は中央2つの平均。 */
function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 分母0なら null を返す割合(NaN を返さない)。 */
function safeRate(numerator, denominator) {
  if (!denominator) return null;
  return numerator / denominator;
}

/** 値配列から { median, min, max, count } を作る。空なら全部 null(count は0)。 */
function summarize(values) {
  if (values.length === 0) return { median: null, min: null, max: null, count: 0 };
  return {
    median: median(values),
    min: Math.min(...values),
    max: Math.max(...values),
    count: values.length,
  };
}

/** { key: count } を count 降順に並べ替えたオブジェクトを作る。 */
function sortByCountDesc(counts) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const sorted = {};
  for (const [key, count] of entries) sorted[key] = count;
  return sorted;
}

// ---- 本体 --------------------------------------------------------------

/**
 * 評価済み個体配列から探索レポートを組み立てる。
 *
 * @param {Array<object>} individuals evaluateProjectile 相当の結果 + distillation 情報の配列
 * @param {{totalEvaluations?: number}} [options]
 * @returns {object} 仕様 §29 の項目名に合わせたレポートオブジェクト
 */
export function buildSearchReport(individuals, options = {}) {
  const list = Array.isArray(individuals) ? individuals : [];
  const totalEvaluations = options.totalEvaluations ?? list.length;

  const trajectoryPeriodic = list.filter((ind) => ind.highway?.trajectoryPeriodic === true);
  const trajectoryPeriodicCount = trajectoryPeriodic.length;
  const fingerprintVerifiedCount = list.filter((ind) => ind.highway?.fingerprintVerified === true).length;

  // ---- highway ベクトル・slope ヒストグラム(trajectoryPeriodic のみ) ----
  const highwayVectorCounts = {};
  const slopeCounts = {};
  for (const bin of SLOPE_BINS) slopeCounts[bin] = 0;

  const ruleLengthValuesBySlope = {};
  const periodValuesBySlope = {};
  const formationValuesBySlope = {};
  const gameViableCountBySlope = {};
  const gameTotalCountBySlope = {};
  for (const bin of SLOPE_BINS) {
    ruleLengthValuesBySlope[bin] = [];
    periodValuesBySlope[bin] = [];
    formationValuesBySlope[bin] = [];
    gameViableCountBySlope[bin] = 0;
    gameTotalCountBySlope[bin] = 0;
  }

  for (const ind of trajectoryPeriodic) {
    const { driftX, driftY, period, formationStep } = ind.highway;
    const key = `${driftX},${driftY}`;
    highwayVectorCounts[key] = (highwayVectorCounts[key] ?? 0) + 1;

    const bin = slopeBinOf(driftX, driftY);
    if (bin == null) continue;
    slopeCounts[bin] += 1;

    if (Number.isFinite(ind.ruleLength)) ruleLengthValuesBySlope[bin].push(ind.ruleLength);
    if (Number.isFinite(period)) periodValuesBySlope[bin].push(period);
    if (Number.isFinite(formationStep)) formationValuesBySlope[bin].push(formationStep);

    gameTotalCountBySlope[bin] += 1;
    if (ind.viable === true) gameViableCountBySlope[bin] += 1;
  }

  const ruleLengthBySlope = {};
  const periodBySlope = {};
  const formationBySlope = {};
  const gameViabilityBySlope = {};
  for (const bin of SLOPE_BINS) {
    ruleLengthBySlope[bin] = summarize(ruleLengthValuesBySlope[bin]);
    periodBySlope[bin] = summarize(periodValuesBySlope[bin]);
    formationBySlope[bin] = summarize(formationValuesBySlope[bin]);
    const viable = gameViableCountBySlope[bin];
    const total = gameTotalCountBySlope[bin];
    gameViabilityBySlope[bin] = { viable, total, rate: safeRate(viable, total) };
  }

  // ---- Seed Distillation の集計 ----
  const attempted = list.filter((ind) => ind.distillation?.attempted === true);
  const distillationAttemptCount = attempted.length;
  const successList = attempted.filter((ind) => ind.distillation.success === true);
  const distillationSuccessCount = successList.length;
  const distillationSuccessRate = safeRate(distillationSuccessCount, distillationAttemptCount);

  const originalFormationSteps = attempted
    .map((ind) => ind.distillation.sourceFormationStep)
    .filter((v) => Number.isFinite(v));
  const distilledFormationSteps = successList
    .map((ind) => ind.distillation.distilledFormationStep)
    .filter((v) => Number.isFinite(v));
  const formationReductions = successList
    .filter(
      (ind) =>
        Number.isFinite(ind.distillation.sourceFormationStep) && Number.isFinite(ind.distillation.distilledFormationStep),
    )
    .map((ind) => ind.distillation.sourceFormationStep - ind.distillation.distilledFormationStep);

  const originalCellCounts = attempted
    .map((ind) => ind.distillation.sourceCellCount)
    .filter((v) => Number.isFinite(v));
  const distilledCellCounts = successList
    .map((ind) => ind.distillation.distilledCellCount)
    .filter((v) => Number.isFinite(v));

  // 蒸留を試した母集団に限定し、元 genome / 蒸留後 genome の viable 数を比較する。
  const gameViableBeforeDistillation = attempted.filter((ind) => ind.viable === true).length;
  const gameViableAfterDistillation = attempted.filter((ind) => ind.distilledViable === true).length;
  const distillationViabilityGain = gameViableAfterDistillation - gameViableBeforeDistillation;

  return {
    totalEvaluations,
    trajectoryPeriodicCount,
    fingerprintVerifiedCount,
    highwayVectorHistogram: sortByCountDesc(highwayVectorCounts),
    slopeHistogram: slopeCounts,
    ruleLengthBySlope,
    periodBySlope,
    formationBySlope,
    gameViabilityBySlope,
    distillationAttemptCount,
    distillationSuccessCount,
    distillationSuccessRate,
    medianOriginalFormationStep: median(originalFormationSteps),
    medianDistilledFormationStep: median(distilledFormationSteps),
    medianFormationReduction: median(formationReductions),
    medianOriginalCellCount: median(originalCellCounts),
    medianDistilledCellCount: median(distilledCellCounts),
    gameViableBeforeDistillation,
    gameViableAfterDistillation,
    distillationViabilityGain,
  };
}

// ---- テキスト整形 -----------------------------------------------------------

function fmtPercent(rate) {
  return rate == null || !Number.isFinite(rate) ? 'N/A' : `${(rate * 100).toFixed(1)}%`;
}

function fmtNum(v, digits = 1) {
  return v == null || !Number.isFinite(v) ? 'N/A' : v.toFixed(digits);
}

function fmtSummary(s) {
  if (s.count === 0) return 'N/A(0件)';
  return `median=${fmtNum(s.median)} min=${fmtNum(s.min)} max=${fmtNum(s.max)} n=${s.count}`;
}

/**
 * buildSearchReport の戻り値を、console.error に出せる日本語の複数行テキストにする。
 * 出力はしない(文字列を返すだけ)。空の入力でも例外を投げない。
 *
 * @param {object} report buildSearchReport の戻り値
 * @returns {string}
 */
export function formatSearchReport(report) {
  const r = report ?? {};
  const lines = [];

  lines.push('=== 探索レポート(§5/§29) ===');
  lines.push(`総評価数: ${r.totalEvaluations ?? 0}`);
  lines.push(`trajectoryPeriodic: ${r.trajectoryPeriodicCount ?? 0}`);
  lines.push(`fingerprintVerified: ${r.fingerprintVerifiedCount ?? 0}`);
  lines.push('');

  lines.push('-- highway 方向ベクトル上位 --');
  const vectors = Object.entries(r.highwayVectorHistogram ?? {}).slice(0, 10);
  if (vectors.length === 0) {
    lines.push('  (データなし)');
  } else {
    for (const [key, count] of vectors) lines.push(`  (${key}): ${count}`);
  }
  lines.push('');

  lines.push('-- slope ビン別 --');
  lines.push('  slope         | 件数 | ruleLength(median/min/max/n)      | period(median/min/max/n)          | formation(median/min/max/n)       | viable率');
  for (const bin of SLOPE_BINS) {
    const count = r.slopeHistogram?.[bin] ?? 0;
    const rl = fmtSummary(r.ruleLengthBySlope?.[bin] ?? { count: 0 });
    const pd = fmtSummary(r.periodBySlope?.[bin] ?? { count: 0 });
    const fm = fmtSummary(r.formationBySlope?.[bin] ?? { count: 0 });
    const viability = r.gameViabilityBySlope?.[bin] ?? { viable: 0, total: 0, rate: null };
    const rate = `${fmtPercent(viability.rate)}(${viability.viable}/${viability.total})`;
    lines.push(`  ${bin.padEnd(13)} | ${String(count).padStart(4)} | ${rl.padEnd(34)} | ${pd.padEnd(34)} | ${fm.padEnd(34)} | ${rate}`);
  }
  lines.push('');

  lines.push('-- Seed Distillation --');
  lines.push(`  試行数: ${r.distillationAttemptCount ?? 0}`);
  lines.push(`  成功数: ${r.distillationSuccessCount ?? 0}(成功率 ${fmtPercent(r.distillationSuccessRate)})`);
  lines.push(`  formationStep 中央値: 元=${fmtNum(r.medianOriginalFormationStep, 0)} → 蒸留後=${fmtNum(r.medianDistilledFormationStep, 0)}(短縮 中央値=${fmtNum(r.medianFormationReduction, 0)})`);
  lines.push(`  セル数中央値: 元=${fmtNum(r.medianOriginalCellCount, 1)} → 蒸留後=${fmtNum(r.medianDistilledCellCount, 1)}`);
  lines.push(`  ゲーム viable(蒸留前 → 蒸留後): ${r.gameViableBeforeDistillation ?? 0} → ${r.gameViableAfterDistillation ?? 0}(差分 ${r.distillationViabilityGain ?? 0})`);

  return lines.join('\n');
}
