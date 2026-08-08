#!/usr/bin/env node
// Action-Centric CPU の 24次元 Action 評価器を CEM法(交差エントロピー法)で学習し
// data/policy.json を書き出す(v6)。
//
// 仕様: docs/action-centric-contract.md §8 / docs/spec.md 機能6 / 差分仕様 §16〜§25。
//
// v5.5 からの変更点:
//   - 学習対象が「カテゴリ別11パラメータ」から **24次元の線形 Action 評価器の重み**になった。
//     旧 fireThreshold / defendBias / escortBias / attackPref[] 等は**完全に廃止**(§15)。
//   - fitness の基準が「単一固定アンカー(RANDOM_POLICY)」から
//     **self-play 50% + 固定 Reference League 4種 50%** になった(§20)。
//   - 固定40世代で打ち切る方式をやめ、**held-out validation による収束判定**にした(§24)。
//   - 最終世代の mean を無条件採用せず、**複数候補を固定シードで再評価**して選ぶ(§25)。
//   - worker_threads で並列化した。乱数はメインスレッドだけが持ち、ワーカーは純粋関数、
//     結果は完了順ではなく**投入した添字順**に集約するので、ワーカー数を変えても出力は一致する。
//
// 乱数は createRng(seed) だけを使う(Math.random() は使わない)。数値は src/config.js から import する。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import * as C from '../src/config.js';
import { createRng } from '../src/engine.js';
import { REFERENCE_POLICY_NAMES } from '../src/reference-policies.js';
import { deriveSeed, evaluatePair, SCORE_DIFF_WEIGHT } from './lib/match-runner.mjs';
import { createPool } from './lib/worker-pool.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_PATH = path.join(__dirname, '..', 'data', 'templates.json');
const BENCHMARK_PATH = path.join(__dirname, '..', 'data', 'benchmark.json');
const DEFAULT_OUT_PATH = path.join(__dirname, '..', 'data', 'policy.json');
const MATCH_WORKER_PATH = path.join(__dirname, 'lib', 'match-worker.mjs');

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
const elapsedSec = () => Number(process.hrtime.bigint() - T0) / 1e9;
const log = (msg) => console.log(`[${elapsedSec().toFixed(1)}s] ${msg}`);

// ---------------------------------------------------------------------------
// templates.json の読み込み
// ---------------------------------------------------------------------------
if (!existsSync(TEMPLATES_PATH)) {
  console.error(
    'data/templates.json が見つかりません。先に `node scripts/generate-templates.mjs` を実行してください。',
  );
  process.exit(1);
}
const templates = JSON.parse(readFileSync(TEMPLATES_PATH, 'utf8'));

// ---------------------------------------------------------------------------
// 学習パラメータ(差分仕様 §21・§22。--quick は動作確認用に大幅に削る)
// ---------------------------------------------------------------------------
const QUICK_DEFAULTS = {
  population: 8, elite: 2, games: 4, minGenerations: 2, maxGenerations: 3,
  validationGames: 4, validationInterval: 2, finalSelectionGames: 4,
};
const FULL_DEFAULTS = {
  population: 80, elite: 16, games: 40, minGenerations: 20, maxGenerations: 60,
  validationGames: 100, validationInterval: 5, finalSelectionGames: 50,
};
const D = QUICK ? QUICK_DEFAULTS : FULL_DEFAULTS;

const POPULATION_SIZE = argNum('population', D.population);
const ELITE_SIZE = argNum('elite', D.elite);
const GAMES_PER_INDIVIDUAL = argNum('games', D.games);
const MIN_GENERATIONS = argNum('min-generations', D.minGenerations);
const MAX_GENERATIONS = argNum('max-generations', D.maxGenerations);
/** validation 1候補・1リーグ相手あたりの試合数(§23 は 100 → 4相手で 400試合/候補)。 */
const VALIDATION_GAMES = argNum('validation-games', D.validationGames);
const VALIDATION_INTERVAL = argNum('validation-interval', D.validationInterval);
/** 最終候補の再評価(§25)で1候補・1リーグ相手あたりに使う試合数。 */
const FINAL_SELECTION_GAMES = argNum('final-selection-games', D.finalSelectionGames);

const LEAGUE = REFERENCE_POLICY_NAMES;
// §22 の配分: 40試合 = self-play 20 + 各リーグ5試合×4。
const SELFPLAY_GAMES = Math.max(1, Math.round(GAMES_PER_INDIVIDUAL / 2));
const LEAGUE_GAMES_EACH = Math.max(1, Math.round(GAMES_PER_INDIVIDUAL / 2 / LEAGUE.length));

// fitness の配分(§20)。self-play 50% + リーグ4種を均等に 50%。
const SELFPLAY_WEIGHT = 0.5;
const LEAGUE_WEIGHT = 0.5;

// ---------------------------------------------------------------------------
// 並列(worker_threads)
// ---------------------------------------------------------------------------
const WORKERS = argNum('workers', Math.max(1, Math.min(22, os.cpus().length - 2)));
const pool = WORKERS > 1
  ? createPool(WORKERS, { workerPath: MATCH_WORKER_PATH, workerData: { templates } })
  : null;

let totalMatches = 0;

/**
 * ジョブ(= 1つの subject × 1つの opponent × games 試合)をまとめて実行する。
 * ⚠️ 結果は worker-pool.mjs が**投入した添字順**に並べて返す(完了順ではない)。
 * ジョブを分割する場合も gameOffset で試合の通し番号を保つので、分割の仕方で結果は変わらない。
 */
async function runJobs(jobs) {
  for (const j of jobs) totalMatches += j.games;
  if (!pool) {
    return jobs.map((j) =>
      evaluatePair(templates, j.seedBase, j.subject, j.opponent, j.games, {
        gameOffset: j.gameOffset ?? 0,
      }),
    );
  }
  return pool.runBatch('evaluatePair', jobs);
}

/** 長い評価枠を CHUNK 試合ずつに割ってワーカーの遊びを減らす(結果は等価)。 */
function chunkJob(job, chunk) {
  if (job.games <= chunk) return [job];
  const out = [];
  for (let off = 0; off < job.games; off += chunk) {
    out.push({ ...job, games: Math.min(chunk, job.games - off), gameOffset: off });
  }
  return out;
}
function mergeChunks(results) {
  let games = 0, win = 0, diff = 0;
  for (const r of results) {
    games += r.games;
    win += r.winRate * r.games;
    diff += r.avgScoreDiff * r.games;
  }
  return { winRate: win / games, avgScoreDiff: diff / games, games };
}

// ---------------------------------------------------------------------------
// 乱数ユーティリティ
// ---------------------------------------------------------------------------
const DIM = C.ACTION_FEATURE_COUNT; // 24

/** 標準正規分布1個(Box-Muller)。rng.next() だけを使う。 */
function gaussian(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng.next();
  while (v === 0) v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// 重みはスケール自由(特徴側が [0,1] / [-1,1] に正規化済み)なので値域クランプはしない。
// ただし std が 0 に潰れて探索が止まるのを防ぐ下限だけ置く。
const INIT_MEAN = 0;
const INIT_STD = 1;
const MIN_STD = 0.05;

function sampleVector(rng, mean, std) {
  const out = new Array(DIM);
  for (let i = 0; i < DIM; i++) out[i] = mean[i] + gaussian(rng) * std[i];
  return out;
}
function elementwiseMean(vectors) {
  const out = new Array(DIM).fill(0);
  for (const v of vectors) for (let i = 0; i < DIM; i++) out[i] += v[i] / vectors.length;
  return out;
}
function elementwiseStd(vectors, mean) {
  const out = new Array(DIM).fill(0);
  for (const v of vectors) for (let i = 0; i < DIM; i++) out[i] += (v[i] - mean[i]) ** 2 / vectors.length;
  return out.map((v) => Math.max(Math.sqrt(v), MIN_STD));
}
/**
 * CEM mean の移動量を「現在の std で正規化した」量として測る(§24)。
 * ⚠️ **early stop の主条件にはしない**(補助確認のみ)。仕様が明示している。
 */
function normalizedMeanShift(newMean, oldMean, oldStd) {
  let acc = 0;
  for (let i = 0; i < DIM; i++) {
    const d = (newMean[i] - oldMean[i]) / Math.max(oldStd[i], 1e-9);
    acc += d * d;
  }
  return Math.sqrt(acc / DIM);
}

const cem = (weights) => ({ kind: 'cem', weights });
const ref = (name) => ({ kind: 'reference', name });

// ---------------------------------------------------------------------------
// シード名前空間
// ⚠️ training / validation / final-selection のシードは**完全に分離する**(§22)。
// 混ざると held-out validation が held-out でなくなり、収束判定が過学習を検出できない。
// ---------------------------------------------------------------------------
const NS_TRAIN_SELF = 0x5e1f;
const NS_TRAIN_LEAGUE = 0x1ea6;
const NS_VALIDATION = 0xda7a;
const NS_FINAL_SELECT = 0xf1a7;

// ---------------------------------------------------------------------------
// validation(§23): held-out シードで Reference League だけを戦う
// ---------------------------------------------------------------------------
async function validateCandidates(checkpoint, candidates) {
  const jobs = [];
  const index = []; // jobs と同じ添字で {ci, li} を持つ
  candidates.forEach((cand, ci) => {
    LEAGUE.forEach((name, li) => {
      const base = { seedBase: deriveSeed(SEED, NS_VALIDATION, checkpoint, li),
                     subject: cem(cand.weights), opponent: ref(name), games: VALIDATION_GAMES };
      for (const j of chunkJob(base, 25)) { jobs.push(j); index.push({ ci, li }); }
    });
  });
  const raw = await runJobs(jobs);
  const perCand = candidates.map(() => LEAGUE.map(() => []));
  raw.forEach((r, i) => perCand[index[i].ci][index[i].li].push(r));
  return candidates.map((cand, ci) => {
    const perOpponent = {};
    let sum = 0;
    LEAGUE.forEach((name, li) => {
      const m = mergeChunks(perCand[ci][li]);
      perOpponent[name] = m.winRate;
      sum += m.winRate;
    });
    return {
      candidate: cand.label,
      weights: cand.weights,
      referenceLeagueAverageWinRate: sum / LEAGUE.length,
      perOpponent,
    };
  });
}

// ---------------------------------------------------------------------------
// CEM メインループ
// ---------------------------------------------------------------------------
const rng = createRng(SEED);
let mean = new Array(DIM).fill(INIT_MEAN);
let std = new Array(DIM).fill(INIT_STD);

const trajectory = [];
const validationLog = [];
/** validation checkpoint ごとの「その時点までの best held-out スコア」。early stop の判定材料。 */
const bestScoreHistory = [];
let bestValidation = null; // { weights, referenceLeagueAverageWinRate, ... }
const recentGenerationBests = []; // 直近の世代ベスト(§25 の最終候補に混ぜる)

log(
  `学習開始: dim=${DIM} population=${POPULATION_SIZE} elite=${ELITE_SIZE} ` +
    `games/個体=${GAMES_PER_INDIVIDUAL}(self-play ${SELFPLAY_GAMES} + リーグ ${LEAGUE_GAMES_EACH}×${LEAGUE.length}) ` +
    `min/max世代=${MIN_GENERATIONS}/${MAX_GENERATIONS} workers=${pool ? pool.size : 1} seed=${SEED}`,
);

let actualGenerations = 0;
let earlyStopReason = null;

for (let gen = 0; gen < MAX_GENERATIONS; gen++) {
  const genNo = gen + 1;
  const opponent = cem(mean); // self-play の相手は現在の平均方策
  const population = [];
  for (let p = 0; p < POPULATION_SIZE; p++) population.push(sampleVector(rng, mean, std));

  // CRN: 1世代の中では全個体が同じ試合シード列を使う(個体添字を混ぜない)。
  const selfSeed = deriveSeed(SEED, NS_TRAIN_SELF, genNo);
  const leagueSeeds = LEAGUE.map((_, li) => deriveSeed(SEED, NS_TRAIN_LEAGUE, genNo, li));

  const jobs = [];
  for (const vec of population) {
    const subject = cem(vec);
    jobs.push({ seedBase: selfSeed, subject, opponent, games: SELFPLAY_GAMES });
    for (let li = 0; li < LEAGUE.length; li++) {
      jobs.push({ seedBase: leagueSeeds[li], subject, opponent: ref(LEAGUE[li]), games: LEAGUE_GAMES_EACH });
    }
  }
  const results = await runJobs(jobs);

  const perBlock = 1 + LEAGUE.length;
  const evaluated = population.map((_, p) => {
    const self = results[p * perBlock];
    const league = LEAGUE.map((_, li) => results[p * perBlock + 1 + li]);
    const leagueWin = league.reduce((s, r) => s + r.winRate, 0) / league.length;
    const leagueDiff = league.reduce((s, r) => s + r.avgScoreDiff, 0) / league.length;
    const fitness =
      SELFPLAY_WEIGHT * self.winRate +
      LEAGUE_WEIGHT * leagueWin +
      SCORE_DIFF_WEIGHT * (SELFPLAY_WEIGHT * self.avgScoreDiff + LEAGUE_WEIGHT * leagueDiff);
    return { fitness, selfWin: self.winRate, leagueWin };
  });

  const order = population.map((_, i) => i).sort((a, b) => evaluated[b].fitness - evaluated[a].fitness);
  const eliteIdx = order.slice(0, ELITE_SIZE);
  const eliteVecs = eliteIdx.map((i) => population[i]);
  const eliteFitMean = eliteIdx.reduce((s, i) => s + evaluated[i].fitness, 0) / eliteIdx.length;

  const prevMean = mean;
  const prevStd = std;
  mean = elementwiseMean(eliteVecs);
  std = elementwiseStd(eliteVecs, mean);
  const shift = normalizedMeanShift(mean, prevMean, prevStd);

  const genBest = { label: `gen${genNo}Best`, weights: population[order[0]].slice() };
  recentGenerationBests.push(genBest);
  if (recentGenerationBests.length > 3) recentGenerationBests.shift();

  trajectory.push({
    generation: genNo,
    bestFitness: evaluated[order[0]].fitness,
    eliteMeanFitness: eliteFitMean,
    eliteSelfPlayWinRate: eliteIdx.reduce((s, i) => s + evaluated[i].selfWin, 0) / eliteIdx.length,
    eliteLeagueWinRate: eliteIdx.reduce((s, i) => s + evaluated[i].leagueWin, 0) / eliteIdx.length,
    normalizedMeanShift: shift,
  });
  actualGenerations = genNo;

  log(
    `世代 ${genNo}/${MAX_GENERATIONS}: 最良fitness=${evaluated[order[0]].fitness.toFixed(3)} ` +
      `エリート平均fitness=${eliteFitMean.toFixed(3)} ` +
      `エリート勝率(self)=${trajectory[trajectory.length - 1].eliteSelfPlayWinRate.toFixed(3)} ` +
      `(リーグ)=${trajectory[trajectory.length - 1].eliteLeagueWinRate.toFixed(3)} ` +
      `meanShift=${shift.toFixed(3)} 累計試合=${totalMatches}`,
  );

  // ---- 5世代ごとの held-out validation(§23) ----
  if (genNo % VALIDATION_INTERVAL === 0) {
    const checkpoint = genNo / VALIDATION_INTERVAL;
    const candidates = [
      { label: 'mean', weights: mean.slice() },
      { label: 'generationBest', weights: genBest.weights },
    ];
    if (bestValidation) candidates.push({ label: 'bestSoFar', weights: bestValidation.weights });
    const res = await validateCandidates(checkpoint, candidates);
    for (const r of res) {
      validationLog.push({ generation: genNo, ...r, weights: undefined });
      if (!bestValidation || r.referenceLeagueAverageWinRate > bestValidation.referenceLeagueAverageWinRate) {
        bestValidation = { ...r, weights: r.weights.slice() };
      }
    }
    bestScoreHistory.push(bestValidation.referenceLeagueAverageWinRate);
    log(
      `  validation(世代${genNo}): ` +
        res.map((r) => `${r.candidate}=${r.referenceLeagueAverageWinRate.toFixed(3)}`).join(' ') +
        ` / best=${bestValidation.referenceLeagueAverageWinRate.toFixed(3)}(${bestValidation.candidate})`,
    );

    // ---- early stop(§24) ----
    // 20世代未満では停止しない。20世代以降、直近2回の checkpoint(=10世代以上)にわたって
    // best held-out 勝率の改善が 1ポイント未満なら停止できる。
    // normalizedMeanShift は**補助確認**であり、これ単独を理由に停止しない。
    if (genNo >= MIN_GENERATIONS && bestScoreHistory.length >= 3) {
      const n = bestScoreHistory.length;
      const improvement = bestScoreHistory[n - 1] - bestScoreHistory[n - 3];
      if (improvement < 0.01) {
        earlyStopReason =
          `held-out validation plateau: 直近2checkpoint(10世代)の改善 ${(improvement * 100).toFixed(2)}pt < 1pt ` +
          `(補助: normalizedMeanShift=${shift.toFixed(3)})`;
        log(`early stop: ${earlyStopReason}`);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 最終候補の再評価(§25)
// 最終世代の mean を無条件に採用しない。固定の final-evaluation シード集合で選び直す。
// ---------------------------------------------------------------------------
const finalCandidates = [{ label: 'finalMean', weights: mean.slice() }];
if (bestValidation) finalCandidates.push({ label: 'bestValidation', weights: bestValidation.weights.slice() });
for (const g of recentGenerationBests) finalCandidates.push({ label: g.label, weights: g.weights.slice() });

log(`最終候補 ${finalCandidates.length} 件を固定シードで再評価中(1候補 ${FINAL_SELECTION_GAMES * LEAGUE.length} 試合)...`);
{
  const jobs = [];
  const index = [];
  finalCandidates.forEach((cand, ci) => {
    LEAGUE.forEach((name, li) => {
      const base = { seedBase: deriveSeed(SEED, NS_FINAL_SELECT, li), subject: cem(cand.weights),
                     opponent: ref(name), games: FINAL_SELECTION_GAMES };
      for (const j of chunkJob(base, 25)) { jobs.push(j); index.push({ ci, li }); }
    });
  });
  const raw = await runJobs(jobs);
  const acc = finalCandidates.map(() => LEAGUE.map(() => []));
  raw.forEach((r, i) => acc[index[i].ci][index[i].li].push(r));
  finalCandidates.forEach((cand, ci) => {
    let sum = 0;
    cand.perOpponent = {};
    LEAGUE.forEach((name, li) => {
      const m = mergeChunks(acc[ci][li]);
      cand.perOpponent[name] = m.winRate;
      sum += m.winRate;
    });
    cand.referenceLeagueAverageWinRate = sum / LEAGUE.length;
  });
}
finalCandidates.forEach((c) =>
  log(`  候補 ${c.label}: リーグ平均勝率=${c.referenceLeagueAverageWinRate.toFixed(3)}`),
);
const winner = finalCandidates.reduce((a, b) =>
  b.referenceLeagueAverageWinRate > a.referenceLeagueAverageWinRate ? b : a,
);
log(`採用: ${winner.label}(リーグ平均勝率=${winner.referenceLeagueAverageWinRate.toFixed(3)})`);

if (pool) await pool.destroy();

// ---------------------------------------------------------------------------
// data/policy.json 書き出し(docs/action-centric-contract.md §7 の新スキーマのみ)
// ⚠️ 旧スキーマ(policy オブジェクト・fireThreshold 等)を混在させない(§37)。
// ---------------------------------------------------------------------------
const trainingSec = elapsedSec();
const benchmark = existsSync(BENCHMARK_PATH) ? JSON.parse(readFileSync(BENCHMARK_PATH, 'utf8')) : null;

const output = {
  trainedAt: new Date().toISOString(),
  method: 'CEM_ACTION_CENTRIC',
  featureSchemaVersion: C.FEATURE_SCHEMA_VERSION,
  dimensions: DIM,
  population: POPULATION_SIZE,
  elite: ELITE_SIZE,
  gamesPerIndividual: GAMES_PER_INDIVIDUAL,
  minGenerations: MIN_GENERATIONS,
  maxGenerations: MAX_GENERATIONS,
  actualGenerations,
  earlyStopReason,
  seed: SEED,
  workers: pool ? pool.size : 1,
  matches: totalMatches,
  selectedCandidate: winner.label,
  weights: winner.weights,
  evaluation: {
    // ⚠️ ここは学習中の固定シード集合での値。§26 の最終評価(2,000試合 + 旧CPU 1,000試合)は
    // scripts/evaluate-policy.mjs が別途上書きする。
    referenceLeagueAverageWinRate: winner.referenceLeagueAverageWinRate,
    winRateVsAttackOnly: winner.perOpponent.ATTACK_ONLY,
    winRateVsCheapSpam: winner.perOpponent.CHEAP_SPAM,
    winRateVsSaveAndBurst: winner.perOpponent.SAVE_AND_BURST,
    winRateVsDefendHeavy: winner.perOpponent.DEFEND_HEAVY,
    winRateVsOldCPU: null,
    averageScoreDiff: null,
  },
  performance: {
    matchesPerSec: totalMatches / trainingSec,
    trainingSec,
    ...(benchmark?.newCpu ?? {}),
  },
  trajectory,
  validation: validationLog,
  finalCandidates: finalCandidates.map((c) => ({
    label: c.label,
    referenceLeagueAverageWinRate: c.referenceLeagueAverageWinRate,
    perOpponent: c.perOpponent,
  })),
};

mkdirSync(path.dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + '\n');
log(`${path.relative(process.cwd(), OUT_PATH)} を書き出しました(累計 ${totalMatches} 試合 / ${actualGenerations} 世代)`);
