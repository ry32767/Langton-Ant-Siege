#!/usr/bin/env node
// CPU同士の自己対戦 + CEM法(交差エントロピー法)で方策を学習し data/policy.json を書き出す。
// docs/spec.md 機能6「学習方法」・docs/data-model.md「data/policy.json」準拠。
//
// 学習するのは13パラメータ: fireThreshold, reserveTokens, defendBias, escortBias, attackPref[9]。
// 各世代: 集団を平均方策からガウス分布でサンプリングし、それぞれ「その方策 vs 現在の平均方策」を
// 複数試合戦わせて勝率を fitness にする。上位(エリート)の平均・標準偏差で分布を更新する。
//
// 乱数は createRng(seed) だけを使う(Math.random() は使わない)。数値は src/config.js から import する。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as C from '../src/config.js';
import { createRng, createMatch, runMatch, scheduleFire as engineScheduleFire } from '../src/engine.js';
import { createCpuAgent } from '../src/cpu.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_PATH = path.join(__dirname, '..', 'data', 'templates.json');
const DEFAULT_OUT_PATH = path.join(__dirname, '..', 'data', 'policy.json');

// ---------------------------------------------------------------------------
// CLI 引数
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
function argNum(name, def) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= argv.length) return def;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) ? v : def;
}
function argStr(name, def) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= argv.length) return def;
  return argv[i + 1];
}
const SEED = argNum('seed', 1);
const QUICK = argv.includes('--quick');
// 検証実行(小予算)で data/policy.json を誤って上書きしないよう --out で書き出し先を変えられる。
const OUT_PATH = path.resolve(argStr('out', DEFAULT_OUT_PATH));

const T0 = process.hrtime.bigint();
function elapsedSec() {
  return Number(process.hrtime.bigint() - T0) / 1e9;
}
function log(msg) {
  console.log(`[${elapsedSec().toFixed(1)}s] ${msg}`);
}

// ---------------------------------------------------------------------------
// templates.json の読み込み(無ければ明示エラーで exit 1)
// ---------------------------------------------------------------------------
if (!existsSync(TEMPLATES_PATH)) {
  console.error(
    'data/templates.json が見つかりません。先に `node scripts/generate-templates.mjs` を実行してください。',
  );
  process.exit(1);
}
const templates = JSON.parse(readFileSync(TEMPLATES_PATH, 'utf8'));

// ---------------------------------------------------------------------------
// パラメータ(--quick で大幅に削る動作確認用。他は --population 等で個別に上書き可能)
// ---------------------------------------------------------------------------
const QUICK_DEFAULTS = { population: 12, elite: 3, games: 5, generations: 3 };
const FULL_DEFAULTS = { population: 60, elite: 12, games: 40, generations: 40 };
const D = QUICK ? QUICK_DEFAULTS : FULL_DEFAULTS;

const POPULATION_SIZE = argNum('population', D.population);
const ELITE_SIZE = argNum('elite', D.elite);
const GAMES_PER_INDIVIDUAL = argNum('games', D.games);
const GENERATIONS = argNum('generations', D.generations);
const VS_RANDOM_GAMES = argNum('vsRandomGames', 200);

// ---------------------------------------------------------------------------
// パラメータベクトル ⇄ policy オブジェクト
// ---------------------------------------------------------------------------
const NUM_ATTACK = C.TEMPLATE_COUNT_ATTACK; // 9
const VECTOR_LENGTH = 4 + NUM_ATTACK; // fireThreshold, reserveTokens, defendBias, escortBias, attackPref[9]

// [min, max] のペア。docs/spec.md 機能6「学習する方策パラメータ」の範囲。
const RANGES = [
  [0, 30], // fireThreshold
  [0, 20], // reserveTokens
  [0, 1], // defendBias
  [0, 1], // escortBias
  ...Array.from({ length: NUM_ATTACK }, () => [0, 2]), // attackPref[i]
];

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function clampVector(vec) {
  return vec.map((v, i) => clamp(v, RANGES[i][0], RANGES[i][1]));
}

function vectorToPolicy(vec) {
  return {
    fireThreshold: vec[0],
    reserveTokens: vec[1],
    defendBias: vec[2],
    escortBias: vec[3],
    attackPref: vec.slice(4, 4 + NUM_ATTACK),
  };
}

// ---------------------------------------------------------------------------
// 乱数ユーティリティ(createRng(seed).next() だけを使う)
// ---------------------------------------------------------------------------

/** 複数の整数から決定論的な32bit非ゼロシードを作る(単純ハッシュ)。 */
function deriveSeed(...parts) {
  let h = 0x811c9dc5 >>> 0; // FNV-1a 風
  for (const p of parts) {
    h ^= p >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h === 0 ? 1 : h >>> 0;
}

/** 標準正規分布1個(Box-Muller)。rng.next() だけを使う。 */
function gaussian(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng.next();
  while (v === 0) v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function sampleVector(rng, mean, std) {
  const vec = mean.map((m, i) => m + gaussian(rng) * std[i]);
  return clampVector(vec);
}

function elementwiseMean(vectors) {
  const n = vectors.length;
  const len = vectors[0].length;
  const out = new Array(len).fill(0);
  for (const vec of vectors) for (let i = 0; i < len; i++) out[i] += vec[i] / n;
  return out;
}

function elementwiseStd(vectors, mean) {
  const n = vectors.length;
  const len = mean.length;
  const out = new Array(len).fill(0);
  for (const vec of vectors) for (let i = 0; i < len; i++) out[i] += (vec[i] - mean[i]) ** 2 / n;
  return out.map((v) => Math.sqrt(v));
}

// 標準偏差が0に収束して探索が止まるのを防ぐ最低ライン(値域の2%)。
const MIN_STD = RANGES.map(([lo, hi]) => Math.max(1e-6, (hi - lo) * 0.02));

// ---------------------------------------------------------------------------
// 試合の実行(src/engine.js + src/cpu.js を組み合わせる。train-policy.mjs は engine を使ってよい)
// ---------------------------------------------------------------------------

function makeAgent(getMatch, sideIndex, policy, rngSeed) {
  const rng = createRng(rngSeed);
  return createCpuAgent({
    templates,
    policy,
    rng,
    scheduleFire: (action, atStep) => engineScheduleFire(getMatch(), sideIndex, action, atStep),
  });
}

/** policyA(side1) vs policyB(side2) を1試合戦い、{ result, scores: [s0, s1] } を返す。 */
function playMatch(seed, policyA, policyB) {
  const match = createMatch({ seed });
  match.sides[0].agent = makeAgent(() => match, 0, policyA, deriveSeed(seed, 1));
  match.sides[1].agent = makeAgent(() => match, 1, policyB, deriveSeed(seed, 2));
  runMatch(match);
  return { result: match.result, scores: [match.sides[0].score, match.sides[1].score] };
}

// 引き分け(全試合0-0膠着になり得る)で勝率だけだと fitness の分散が消え CEM が学習できなくなる。
// そのため「得点差」も混ぜた連続値の fitness にする。勝率が同点でも、より多く得点を稼いだ/
// 失点を防いだ方策が上位に来るようにする。重み 0.01 は 勝率(0〜1)のオーダーを崩さない程度の小ささ。
const SCORE_DIFF_WEIGHT = 0.01;

/**
 * individualPolicy vs opponentPolicy を games 試合戦わせ、
 * { winRate, fitness } を返す。winRate は純粋な勝率(勝=1/分=0.5/負=0)、
 * fitness = winRate + SCORE_DIFF_WEIGHT * 平均得点差(引き分けの多い局面でも順位付けできる連続値)。
 * 先手有利を均すため、ゲームごとに side を入れ替える。
 */
function evaluate(seedBase, individualPolicy, opponentPolicy, games) {
  let winTotal = 0;
  let scoreDiffTotal = 0;
  for (let g = 0; g < games; g++) {
    const matchSeed = deriveSeed(seedBase, g);
    const individualIsSide1 = g % 2 === 0;
    const policyA = individualIsSide1 ? individualPolicy : opponentPolicy;
    const policyB = individualIsSide1 ? opponentPolicy : individualPolicy;
    const { result, scores } = playMatch(matchSeed, policyA, policyB);
    let outcome;
    if (result === 'draw') outcome = 0.5;
    else {
      const individualWon =
        (individualIsSide1 && result === 'side1') || (!individualIsSide1 && result === 'side2');
      outcome = individualWon ? 1 : 0;
    }
    winTotal += outcome;
    const individualScore = individualIsSide1 ? scores[0] : scores[1];
    const opponentScore = individualIsSide1 ? scores[1] : scores[0];
    scoreDiffTotal += individualScore - opponentScore;
  }
  const winRate = winTotal / games;
  const fitness = winRate + SCORE_DIFF_WEIGHT * (scoreDiffTotal / games);
  return { winRate, fitness };
}

// ---------------------------------------------------------------------------
// CEM法によるメインループ
// ---------------------------------------------------------------------------

const rng = createRng(SEED);

// 初期分布: 値域の中央を平均、値域の半分を標準偏差にして広く探索する。
let mean = RANGES.map(([lo, hi]) => (lo + hi) / 2);
let std = RANGES.map(([lo, hi]) => (hi - lo) / 2);

let totalMatches = 0;

log(
  `学習開始: population=${POPULATION_SIZE} elite=${ELITE_SIZE} games=${GAMES_PER_INDIVIDUAL} generations=${GENERATIONS} seed=${SEED}`,
);

for (let gen = 0; gen < GENERATIONS; gen++) {
  const opponentPolicy = vectorToPolicy(mean);

  const population = [];
  for (let p = 0; p < POPULATION_SIZE; p++) {
    population.push(sampleVector(rng, mean, std));
  }

  const fitnesses = population.map((vec, idx) => {
    const policy = vectorToPolicy(vec);
    const seedBase = deriveSeed(SEED, gen + 1, idx + 1);
    const { fitness } = evaluate(seedBase, policy, opponentPolicy, GAMES_PER_INDIVIDUAL);
    totalMatches += GAMES_PER_INDIVIDUAL;
    return fitness;
  });

  const order = population.map((_, i) => i).sort((a, b) => fitnesses[b] - fitnesses[a]);
  const eliteIdx = order.slice(0, ELITE_SIZE);
  const eliteVecs = eliteIdx.map((i) => population[i]);
  const eliteFitMean = eliteIdx.reduce((s, i) => s + fitnesses[i], 0) / eliteIdx.length;

  const fitMean = fitnesses.reduce((s, f) => s + f, 0) / fitnesses.length;
  const fitVariance = fitnesses.reduce((s, f) => s + (f - fitMean) ** 2, 0) / fitnesses.length;

  mean = clampVector(elementwiseMean(eliteVecs));
  std = elementwiseStd(eliteVecs, mean).map((s, i) => Math.max(s, MIN_STD[i]));

  log(
    `世代 ${gen + 1}/${GENERATIONS}: 最良fitness=${fitnesses[order[0]].toFixed(3)} ` +
      `エリート平均fitness=${eliteFitMean.toFixed(3)} 集団fitness分散=${fitVariance.toFixed(6)} ` +
      `累計試合=${totalMatches}`,
  );
}

const finalPolicy = vectorToPolicy(mean);

// ---------------------------------------------------------------------------
// ランダム方策との対戦で学習効果を測る
// ---------------------------------------------------------------------------

// 「ランダム方策」= 学習していない中立の初期方策(閾値0で貯めずに撃ち、迎撃/護衛は五分五分、
// 攻撃選好は9種均一 = softmaxがほぼ一様分布になる)。CEM の初期平均と同じ考え方。
const RANDOM_POLICY = {
  fireThreshold: 0,
  reserveTokens: 0,
  defendBias: 0.5,
  escortBias: 0.5,
  attackPref: Array.from({ length: NUM_ATTACK }, () => 1),
};

log(`ランダム方策との対戦を${VS_RANDOM_GAMES}試合実行中...`);
const { winRate: winRateVsRandom } = evaluate(
  deriveSeed(SEED, 999999),
  finalPolicy,
  RANDOM_POLICY,
  VS_RANDOM_GAMES,
);
totalMatches += VS_RANDOM_GAMES;
log(`winRateVsRandom = ${winRateVsRandom.toFixed(3)}`);

// ---------------------------------------------------------------------------
// data/policy.json 書き出し
// ---------------------------------------------------------------------------

const output = {
  trainedAt: new Date().toISOString(),
  method: 'CEM',
  generations: GENERATIONS,
  matches: totalMatches,
  winRateVsRandom,
  policy: finalPolicy,
};

mkdirSync(path.dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + '\n');
log(`${path.relative(process.cwd(), OUT_PATH)} を書き出しました(累計 ${totalMatches} 試合)`);
