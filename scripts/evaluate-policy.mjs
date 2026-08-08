#!/usr/bin/env node
// 学習済み Action-Centric 方策の最終評価と、学習前の性能ベンチマーク(v6)。
//
// 仕様: 差分仕様 §26(最終評価)・§27(戦術使用ログ)・§28(学習前性能ベンチマーク)。
// docs/action-centric-contract.md §9。
//
//   node scripts/evaluate-policy.mjs --mode bench            # 学習**前**に回す(§28)
//   node scripts/evaluate-policy.mjs --mode final            # 学習**後**に回す(§26)
//
// ⚠️ --mode bench は必ず本学習の前に実行すること。差分仕様 §28 は「Action-Centric 実装後、
// CEM 本学習前に性能計測を必須とする」としている。ここで足りないと分かった場合の最適化順は
// §29(世代数の削減は最後)。data/benchmark.json に書き出し、train-policy.mjs が
// policy.json の performance へ取り込む。
//
// このスクリプトは data/templates.json / src/*.js を**書き換えない**。
// --mode final だけが data/policy.json の evaluation / tacticsLog / performance を上書きする。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import * as C from '../src/config.js';
import { createMatch, stepMatch, createRng } from '../src/engine.js';
import { REFERENCE_POLICY_NAMES } from '../src/reference-policies.js';
import { deriveSeed, evaluatePair, makeAgent, playMatch } from './lib/match-runner.mjs';
import { createPool } from './lib/worker-pool.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_PATH = path.join(__dirname, '..', 'data', 'templates.json');
const POLICY_PATH = path.join(__dirname, '..', 'data', 'policy.json');
const LEGACY_POLICY_PATH = path.join(__dirname, '..', 'data', 'policy-v55.json');
const BENCHMARK_PATH = path.join(__dirname, '..', 'data', 'benchmark.json');
const EVALUATION_PATH = path.join(__dirname, '..', 'data', 'evaluation.json');
const MATCH_WORKER_PATH = path.join(__dirname, 'lib', 'match-worker.mjs');

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
const MODE = argStr('mode', 'final');
const SEED = argNum('seed', 1);
const WORKERS = argNum('workers', Math.max(1, Math.min(22, os.cpus().length - 2)));

const T0 = process.hrtime.bigint();
const elapsedSec = () => Number(process.hrtime.bigint() - T0) / 1e9;
const log = (msg) => console.log(`[${elapsedSec().toFixed(1)}s] ${msg}`);

if (!existsSync(TEMPLATES_PATH)) {
  console.error('data/templates.json が見つかりません。先に generate-templates.mjs を実行してください。');
  process.exit(1);
}
const templates = JSON.parse(readFileSync(TEMPLATES_PATH, 'utf8'));
const LEAGUE = REFERENCE_POLICY_NAMES;

const cem = (weights) => ({ kind: 'cem', weights });
const ref = (name) => ({ kind: 'reference', name });

/** ベンチで「学習していない中立の重み」を使うときの値。全0 = すべての Action が同点。 */
const ZERO_WEIGHTS = new Array(C.ACTION_FEATURE_COUNT).fill(0);

/**
 * ⚠️ `--policy <path>` でベンチに使う方策を差し替えられる。
 *
 * これが要るのは、**全0の重みだと1発も撃たずに試合が空で終わる**ため
 * (全 Action のスコアが 0 で score(WAIT)=0 と同点 → 同点は添字の小さい WAIT が勝つ)。
 * その状態で測った matches/sec は「アリが1匹も飛ばない試合」の速度でしかなく、
 * 学習予算の見積もりにも旧CPUとの比較にも使えない(旧CPUは学習済みなので実際に撃つ)。
 * したがって §28 のベンチは **--quick で軽く学習した重み**など、実際に撃つ方策で測ること。
 */
function loadWeights() {
  const p = path.resolve(argStr('policy', POLICY_PATH));
  if (!existsSync(p)) return null;
  const doc = JSON.parse(readFileSync(p, 'utf8'));
  if (!Array.isArray(doc.weights) || doc.weights.length !== C.ACTION_FEATURE_COUNT) return null;
  return { doc, weights: doc.weights, path: p };
}

function loadLegacySpec() {
  if (!existsSync(LEGACY_POLICY_PATH)) return null;
  const doc = JSON.parse(readFileSync(LEGACY_POLICY_PATH, 'utf8'));
  if (!doc.policy) return null;
  return { kind: 'legacy', policy: doc.policy };
}

// ---------------------------------------------------------------------------
// 並列実行のヘルパ(train-policy.mjs と同じ規律: 結果は投入した添字順)
// ---------------------------------------------------------------------------
function makePool() {
  return WORKERS > 1
    ? createPool(WORKERS, { workerPath: MATCH_WORKER_PATH, workerData: { templates } })
    : null;
}
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
async function runJobs(pool, jobs) {
  if (!pool) {
    return jobs.map((j) =>
      evaluatePair(templates, j.seedBase, j.subject, j.opponent, j.games, { gameOffset: j.gameOffset ?? 0 }),
    );
  }
  return pool.runBatch('evaluatePair', jobs);
}

// ---------------------------------------------------------------------------
// §27 戦術使用ログ。**fitness には一切入れない**(解釈用の観測だけ)。
// ---------------------------------------------------------------------------
function createTacticsCollector() {
  const counts = { wait: 0, attackFire: 0, disruptFire: 0, selfDestruct: 0, decisions: 0 };
  const byTemplate = {};
  const candidateCounts = [];
  return {
    counts,
    byTemplate,
    candidateCounts,
    observe(ev) {
      if (!ev || (ev.type !== 'action' && ev.type !== 'decision')) return;
      counts.decisions++;
      if (typeof ev.candidateCount === 'number') candidateCounts.push(ev.candidateCount);
      const t = ev.actionType ?? ev.action ?? 'WAIT';
      if (t === 'WAIT') counts.wait++;
      else if (t === 'SELF_DESTRUCT') counts.selfDestruct++;
      else if (t === 'FIRE') {
        if (ev.kind === 'disrupt') counts.disruptFire++;
        else counts.attackFire++;
        if (ev.templateId) byTemplate[ev.templateId] = (byTemplate[ev.templateId] ?? 0) + 1;
      }
    },
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

// ---------------------------------------------------------------------------
// §28 学習前性能ベンチマーク
// ---------------------------------------------------------------------------

/**
 * matches/sec と decisions/sec を測る。decisions は「実際に decide() が呼ばれた回数」。
 * `opponentSpec` を省略すると自己対戦。
 *
 * ⚠️ 学習の試合の**半分は Reference League 相手**(§22)で、`ATTACK_ONLY` / `CHEAP_SPAM` は
 * 撃てるときに必ず撃つので自己対戦より重い。学習予算の見積もりは自己対戦だけで出さず、
 * リーグ相手のスループットも測ること(下の runBench がその両方を出す)。
 */
function benchThroughput(spec, games, seedNs, opponentSpec = null) {
  const opponent = opponentSpec ?? spec;
  let decisions = 0;
  const t0 = process.hrtime.bigint();
  for (let g = 0; g < games; g++) {
    const seed = deriveSeed(SEED, seedNs, g);
    const r = playMatch(templates, seed, spec, opponent);
    // 1試合の判断回数 = 陣営2つ × (ステップ数 / 判断周期)。engine は s % DECISION_INTERVAL === 0 で呼ぶ。
    decisions += 2 * (Math.floor((r.steps - 1) / C.DECISION_INTERVAL_STEPS) + 1);
  }
  const sec = Number(process.hrtime.bigint() - t0) / 1e9;
  return { games, sec, matchesPerSec: games / sec, decisionsPerSec: decisions / sec, decisions };
}

/**
 * coarse board / ownership の増分更新コストを測る。
 *
 * ⚠️ engine から機能だけを外して比較することはできない(それ用の分岐を残すと本番のホットパスが
 * 遅くなる)。そこで **(a) 1試合あたりの盤面書き込み回数を実測**し、**(b) フックと同じ演算の
 * 単価をマイクロベンチで測って**掛け合わせた**推定値**を出す。値は推定である旨を明記する。
 */
function benchBoardHooks(spec) {
  // (a) 1試合の stepAnt 呼び出し回数 = 各ステップの飛行アリ数の総和。
  const match = createMatch({ seed: deriveSeed(SEED, 0xb0a5, 1) });
  match.sides[0].agent = makeAgent(templates, spec, () => match, 0, deriveSeed(1, 1));
  match.sides[1].agent = makeAgent(templates, spec, () => match, 1, deriveSeed(1, 2));
  let stepAntCalls = 0;
  while (match.phase !== 'finished') {
    stepAntCalls += match.sides[0].ants.length + match.sides[1].ants.length;
    stepMatch(match);
  }

  // (b) フック相当の演算の単価。
  const N = 5_000_000;
  const coarse = new Int32Array(C.COARSE_COUNT);
  const ownSide = [new Int32Array(C.COARSE_COUNT), new Int32Array(C.COARSE_COUNT)];
  const ownAnt = Array.from({ length: C.MAX_FLYING }, () => new Int32Array(C.COARSE_COUNT));
  const rng = createRng(12345);
  const xs = new Int32Array(4096);
  const ys = new Int32Array(4096);
  for (let i = 0; i < 4096; i++) { xs[i] = rng.int(C.WIDTH); ys[i] = rng.int(C.HEIGHT); }

  let t = process.hrtime.bigint();
  for (let i = 0; i < N; i++) {
    const k = i & 4095;
    coarse[(ys[k] >> C.COARSE_SHIFT) * C.COARSE_SIZE + (xs[k] >> C.COARSE_SHIFT)] += 1;
  }
  const coarseNs = Number(process.hrtime.bigint() - t) / N;

  t = process.hrtime.bigint();
  for (let i = 0; i < N; i++) {
    const k = i & 4095;
    const b = (ys[k] >> C.COARSE_SHIFT) * C.COARSE_SIZE + (xs[k] >> C.COARSE_SHIFT);
    const slot = k & 3;
    ownSide[0][b] -= 1; ownAnt[slot][b] -= 1;
    ownSide[1][b] += 1; ownAnt[(slot + 1) & 3][b] += 1;
  }
  const ownershipNs = Number(process.hrtime.bigint() - t) / N;

  return {
    boardWritesPerMatch: stepAntCalls,
    coarseUpdateNsPerWrite: coarseNs,
    ownershipUpdateNsPerWrite: ownershipNs,
    coarseUpdateMsPerMatchEstimate: (stepAntCalls * coarseNs) / 1e6,
    ownershipUpdateMsPerMatchEstimate: (stepAntCalls * ownershipNs) / 1e6,
    note: '推定値。1試合の盤面書き込み回数(実測)× フック相当演算の単価(マイクロベンチ)',
  };
}

async function runBench() {
  const games = argNum('games', 30);
  const legacySpec = loadLegacySpec();
  const loaded = loadWeights();
  const newSpec = cem(loaded ? loaded.weights : ZERO_WEIGHTS);
  log(`ベンチ開始: games=${games} 新CPU=${loaded ? '学習済み weights' : '全0 weights(学習前)'}`);

  const newThr = benchThroughput(newSpec, games, 0xbe0f);
  log(`新CPU: ${newThr.matchesPerSec.toFixed(1)} 試合/秒 / ${newThr.decisionsPerSec.toFixed(0)} 判断/秒`);

  // 学習の試合の半分はリーグ相手なので、いちばん撃つ CHEAP_SPAM 相手のスループットも測る。
  const vsLeagueThr = benchThroughput(newSpec, games, 0xbe0f, ref('CHEAP_SPAM'));
  log(`新CPU vs CHEAP_SPAM: ${vsLeagueThr.matchesPerSec.toFixed(1)} 試合/秒`);

  let oldThr = null;
  if (legacySpec) {
    oldThr = benchThroughput(legacySpec, games, 0xbe0f);
    log(`旧CPU: ${oldThr.matchesPerSec.toFixed(1)} 試合/秒 / ${oldThr.decisionsPerSec.toFixed(0)} 判断/秒`);
  } else {
    log('旧CPU: data/policy-v55.json が無いのでスキップ');
  }

  // 候補数と特徴/採点の時間は observe から取る(cpu.js が measure:true のときだけ計測する)。
  const collector = createTacticsCollector();
  let featureUs = 0, scoreUs = 0, timed = 0;
  const observe = (ev) => {
    collector.observe(ev);
    if (typeof ev?.featureUs === 'number') { featureUs += ev.featureUs; scoreUs += ev.scoreUs ?? 0; timed++; }
  };
  const sampleGames = Math.max(2, Math.min(10, games));
  for (let g = 0; g < sampleGames; g++) {
    playMatch(templates, deriveSeed(SEED, 0xca11, g), newSpec, newSpec, {
      observeA: observe, observeB: observe, measure: true,
    });
  }
  const sortedCand = collector.candidateCounts.slice().sort((a, b) => a - b);
  const avgCand = sortedCand.length
    ? sortedCand.reduce((s, v) => s + v, 0) / sortedCand.length : 0;

  const hooks = benchBoardHooks(newSpec);

  const out = {
    measuredAt: new Date().toISOString(),
    seed: SEED,
    games,
    // どの方策で測ったか。⚠️ 全0の重みだと1発も撃たずに試合が空で終わり、数値が使い物に
    // ならない(loadWeights のコメント参照)。ここが null の結果は信用しないこと。
    policySource: loaded ? path.relative(process.cwd(), loaded.path) : null,
    newCpu: {
      matchesPerSec: newThr.matchesPerSec,
      decisionsPerSec: newThr.decisionsPerSec,
      avgCandidatesPerDecision: avgCand,
      p95CandidatesPerDecision: percentile(sortedCand, 95),
      featureEncodeUsPerDecision: timed ? featureUs / timed : null,
      actionScoreUsPerDecision: timed ? scoreUs / timed : null,
    },
    oldCpu: oldThr
      ? { matchesPerSec: oldThr.matchesPerSec, decisionsPerSec: oldThr.decisionsPerSec }
      : null,
    boardHooks: hooks,
    tacticsSample: collector.counts,
  };
  writeFileSync(BENCHMARK_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log('\n=== §28 学習前性能ベンチマーク ===');
  console.log(`  新CPU  : ${out.newCpu.matchesPerSec.toFixed(2)} 試合/秒 / ${out.newCpu.decisionsPerSec.toFixed(0)} 判断/秒`);
  if (out.oldCpu) {
    console.log(`  旧CPU  : ${out.oldCpu.matchesPerSec.toFixed(2)} 試合/秒 / ${out.oldCpu.decisionsPerSec.toFixed(0)} 判断/秒`);
    console.log(`  比     : 新/旧 = ${(out.newCpu.matchesPerSec / out.oldCpu.matchesPerSec).toFixed(2)} 倍`);
  }
  console.log(`  候補数 : 平均 ${avgCand.toFixed(1)} / p95 ${percentile(sortedCand, 95)}`);
  if (timed) {
    console.log(`  特徴生成: ${(featureUs / timed).toFixed(1)} µs/判断 / 採点: ${(scoreUs / timed).toFixed(1)} µs/判断`);
  } else {
    console.log('  特徴生成/採点の時間: cpu.js が measure に対応していないため未計測');
  }
  console.log(`  盤面書き込み: ${hooks.boardWritesPerMatch.toLocaleString()} 回/試合`);
  console.log(`  coarse更新   : ${hooks.coarseUpdateNsPerWrite.toFixed(2)} ns/回 → 約 ${hooks.coarseUpdateMsPerMatchEstimate.toFixed(1)} ms/試合(推定)`);
  console.log(`  ownership更新: ${hooks.ownershipUpdateNsPerWrite.toFixed(2)} ns/回 → 約 ${hooks.ownershipUpdateMsPerMatchEstimate.toFixed(1)} ms/試合(推定)`);
  console.log(`\ndata/benchmark.json に書き出しました。`);
}

// ---------------------------------------------------------------------------
// §26 最終評価
// ---------------------------------------------------------------------------
async function runFinal() {
  const loaded = loadWeights();
  if (!loaded) {
    console.error('data/policy.json に24要素の weights がありません。先に train-policy.mjs を実行してください。');
    process.exit(1);
  }
  const subject = cem(loaded.weights);
  const leagueGames = argNum('games', 500);
  const oldGames = argNum('old-games', 1000);
  const legacySpec = loadLegacySpec();

  const pool = makePool();
  log(`最終評価: リーグ ${leagueGames}試合×${LEAGUE.length} + 旧CPU ${oldGames}試合 workers=${pool ? pool.size : 1}`);

  // ---- リーグ(§26.1) ----
  const jobs = [];
  const index = [];
  LEAGUE.forEach((name, li) => {
    const base = { seedBase: deriveSeed(SEED, 0xf17a, li), subject, opponent: ref(name), games: leagueGames };
    for (const j of chunkJob(base, 25)) { jobs.push(j); index.push(li); }
  });
  // ---- 旧CPU 直接対戦(§26.2)。evaluatePair は試合ごとに先後を入れ替えるので side は均等 ----
  let oldStart = -1;
  if (legacySpec) {
    oldStart = jobs.length;
    const base = { seedBase: deriveSeed(SEED, 0x01dc9), subject, opponent: legacySpec, games: oldGames };
    for (const j of chunkJob(base, 25)) { jobs.push(j); index.push(-1); }
  }
  const raw = await runJobs(pool, jobs);

  const perLeague = LEAGUE.map(() => []);
  const oldChunks = [];
  raw.forEach((r, i) => { if (index[i] >= 0) perLeague[index[i]].push(r); else oldChunks.push(r); });

  const evaluation = {};
  let leagueSum = 0, diffSum = 0, diffN = 0;
  LEAGUE.forEach((name, li) => {
    const m = mergeChunks(perLeague[li]);
    evaluation[`winRateVs${name.split('_').map((w) => w[0] + w.slice(1).toLowerCase()).join('')}`] = m.winRate;
    leagueSum += m.winRate;
    diffSum += m.avgScoreDiff * m.games; diffN += m.games;
  });
  evaluation.referenceLeagueAverageWinRate = leagueSum / LEAGUE.length;
  if (oldChunks.length) {
    const m = mergeChunks(oldChunks);
    evaluation.winRateVsOldCPU = m.winRate;
    diffSum += m.avgScoreDiff * m.games; diffN += m.games;
  } else {
    evaluation.winRateVsOldCPU = null;
  }
  evaluation.averageScoreDiff = diffN ? diffSum / diffN : null;

  if (pool) await pool.destroy();

  // ---- §27 戦術使用ログ(別サンプル。fitness には使わない) ----
  const collector = createTacticsCollector();
  const logGames = argNum('tactics-games', 100);
  for (let g = 0; g < logGames; g++) {
    const opp = ref(LEAGUE[g % LEAGUE.length]);
    const subjectIsSide1 = g % 2 === 0;
    playMatch(
      templates, deriveSeed(SEED, 0x7ac7, g),
      subjectIsSide1 ? subject : opp, subjectIsSide1 ? opp : subject,
      subjectIsSide1 ? { observeA: collector.observe } : { observeB: collector.observe },
    );
  }
  const sortedCand = collector.candidateCounts.slice().sort((a, b) => a - b);
  const tacticsLog = {
    games: logGames,
    ...collector.counts,
    byTemplate: collector.byTemplate,
    avgCandidatesPerDecision: sortedCand.length
      ? sortedCand.reduce((s, v) => s + v, 0) / sortedCand.length : 0,
    p95CandidatesPerDecision: percentile(sortedCand, 95),
    note: '解釈用の観測のみ。fitness には一切入れていない(差分仕様 §20・§27)',
  };

  // ---- 書き出し ----
  const doc = loaded.doc;
  doc.evaluation = { ...doc.evaluation, ...evaluation };
  doc.tacticsLog = tacticsLog;
  writeFileSync(POLICY_PATH, JSON.stringify(doc, null, 2) + '\n');
  writeFileSync(
    EVALUATION_PATH,
    JSON.stringify({ evaluatedAt: new Date().toISOString(), seed: SEED, leagueGames, oldGames, evaluation, tacticsLog }, null, 2) + '\n',
  );

  console.log('\n=== §26 最終評価 ===');
  for (const name of LEAGUE) {
    const key = `winRateVs${name.split('_').map((w) => w[0] + w.slice(1).toLowerCase()).join('')}`;
    console.log(`  vs ${name.padEnd(15)}: 勝率 ${(evaluation[key] * 100).toFixed(1)}%(${leagueGames}試合)`);
  }
  console.log(`  リーグ平均勝率      : ${(evaluation.referenceLeagueAverageWinRate * 100).toFixed(1)}%`);
  console.log(`  vs 旧CPU(v5.5)     : ${evaluation.winRateVsOldCPU == null ? '未計測' : (evaluation.winRateVsOldCPU * 100).toFixed(1) + `%(${oldGames}試合)`}`);
  console.log(`  平均得点差          : ${evaluation.averageScoreDiff?.toFixed(3) ?? '-'}`);
  console.log('\n=== §27 戦術使用ログ(fitness には未使用) ===');
  console.log(`  判断 ${tacticsLog.decisions} 回: WAIT ${tacticsLog.wait} / 攻撃FIRE ${tacticsLog.attackFire} / 妨害FIRE ${tacticsLog.disruptFire} / 自爆 ${tacticsLog.selfDestruct}`);
  console.log(`  テンプレート別: ${JSON.stringify(tacticsLog.byTemplate)}`);
  console.log(`  候補数: 平均 ${tacticsLog.avgCandidatesPerDecision.toFixed(1)} / p95 ${tacticsLog.p95CandidatesPerDecision}`);
  console.log('\ndata/policy.json の evaluation / tacticsLog を更新しました。');
}

if (MODE === 'bench') await runBench();
else if (MODE === 'final') await runFinal();
else {
  console.error(`未知の --mode: ${MODE}(bench | final)`);
  process.exit(1);
}
