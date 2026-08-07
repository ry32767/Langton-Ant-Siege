#!/usr/bin/env node
// data/templates.json を生成する MAP-Elites パイプラインの制御役。
// docs/spec.md「テンプレート選抜基準」・docs/data-model.md「data/templates.json」準拠。
//
// ⚠️ このファイルはパイプラインの配線だけを行う。探索・評価・変異・アーカイブのロジックは
// すべて src/search/* に実装済みで、ここでは import して呼び出すだけにする(自前で
// 再実装しない。AGENTS.md 経由の作業指示)。
//
// パイプライン(docs/spec.md 未決定事項・作業指示 §22 準拠):
//   ① MAP-Elites 探索(第1アーカイブ: direction × speed × formationTime × cost)
//        → ハイウェイアーカイブ
//   ② ゲーム射影(evaluateProjectile の viable===true だけを攻撃候補として通す。
//        妨害候補は highway.detected だけを条件にする。§28 未決定事項「0マス発射」と
//        同種の理由で妨害は「敵陣へ届く」ことを要求できない。下の「妨害の viable 解釈」参照)
//   ③ 攻撃/妨害それぞれの第2 MAP-Elites アーカイブ(entryPositionTier×robustnessTier /
//        reachTier×endDirTier)を、①②のプールから種を蒔いて作る
//   ④ 共進化(攻撃ラウンド ⇄ 防御ラウンドを交互に coevoRounds 回)
//   ⑤ 候補プールから 9×9 を貪欲法+局所探索で選抜し、counterTable/escortTable/identifyTable を計算
//
// 乱数は createRng(seed) だけを使う(Math.random() は使わない)。数値は src/config.js から import する。
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as C from '../src/config.js';
import { createRng, simulateSolo } from '../src/engine.js';
import { createRandomGenome, genomeKey, toTemplateCells, costOfGenome } from '../src/search/genome.js';
import {
  createArchive,
  tryInsert,
  archiveEntries,
  archiveStats,
  runMapElites,
  toJSON as archiveToJSON,
} from '../src/search/map-elites.js';
import { evaluateProjectile } from '../src/search/evaluate-projectile.js';
import { evaluateInteraction, buildCounterMatrix, buildEscortTable } from '../src/search/evaluate-interaction.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_OUT_PATH = path.join(__dirname, '..', 'data', 'templates.json');
const ARCHIVE_OUT_PATH = path.join(__dirname, '..', 'data', 'search-archive.json');

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
const SEED = argNum('seed', 1);
const QUICK = argv.includes('--quick');
const EVALUATIONS_OVERRIDE = argNum('evaluations', null);
const ROUNDS_OVERRIDE = argNum('rounds', null);

const rngObj = createRng(SEED);
const rng = () => rngObj.next(); // src/search/* は rng() を関数として呼ぶ(engine.createRng は {next,int,pick} オブジェクト)

const T0 = process.hrtime.bigint();
function elapsedSec() {
  return Number(process.hrtime.bigint() - T0) / 1e9;
}
// 進捗は stderr に出す(標準出力を汚さない)。
function log(msg) {
  console.error(`[${elapsedSec().toFixed(1)}s] ${msg}`);
}

let evalCount = 0;

// ---------------------------------------------------------------------------
// パラメータ(--quick で小予算に削る)
// ---------------------------------------------------------------------------
const PARAMS = QUICK
  ? {
      archive1InitialBatch: 200,
      archive1Iterations: 1500,
      attackPoolSize: 30,
      disruptPoolSize: 36,
      coevoRounds: 2,
      coevoAttackIters: 200,
      coevoDisruptIters: 200,
      localSearchIters: 4000,
      maxPipelineAttempts: 2,
    }
  : {
      archive1InitialBatch: 1500,
      archive1Iterations: 12000,
      attackPoolSize: 30,
      disruptPoolSize: 40,
      coevoRounds: 4,
      coevoAttackIters: 900,
      coevoDisruptIters: 900,
      localSearchIters: 60000,
      maxPipelineAttempts: 2,
    };
if (EVALUATIONS_OVERRIDE != null) PARAMS.archive1Iterations = EVALUATIONS_OVERRIDE;
if (ROUNDS_OVERRIDE != null) PARAMS.coevoRounds = ROUNDS_OVERRIDE;

// ---------------------------------------------------------------------------
// 内部専用の解像度パラメータ(ゲームバランスの数値ではなく、記述子ビンの内部スケール。
// evaluate-projectile.js の STABILITY_CYCLES_CAP と同種の理由で config.js には出さない)
// ---------------------------------------------------------------------------
// 妨害の縦到達距離のビン幅スケール。理論上の最大値(最速ルール0.0556列/ステップ×寿命400≒22.2)
// よりわずかに大きい値を使い、6ビンに実測範囲が収まるようにする。
const DISRUPT_REACH_SCALE = 25;

// ---------------------------------------------------------------------------
// 共通ヘルパ
// ---------------------------------------------------------------------------

/** genome を engine 用 template 形に変換する(cells を [x,y,state] 配列へ)。 */
function genomeToTemplate(genome, kind) {
  return {
    rule: genome.rule,
    cells: toTemplateCells(genome),
    antX: genome.antX,
    antY: genome.antY,
    antDir: genome.antDir,
    kind,
    templateId: genome.id ?? null,
  };
}

/** genomeKey で重複を除いた配列を返す。 */
function dedupeGenomes(genomes) {
  const seen = new Set();
  const out = [];
  for (const g of genomes) {
    const k = genomeKey(g);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(g);
  }
  return out;
}

/** rng で genomes から最大 n 件をランダムに抜き出す(Fisher-Yates の先頭 n 件版)。 */
function sampleGenomes(genomes, n) {
  const arr = genomes.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, n);
}

/**
 * MAP-Elites アーカイブは記述子のビンが粗い場合(entryPositionTier×robustnessTierで最大30セル等)、
 * 「同じセルに競合する個体は1つしか残らない」性質上、共進化が進むほど生存者数がセル数を天井に
 * 頭打ちになりうる(実測: robustnessTier が高robustness側に偏り、6セル程度で頭打ちになった)。
 * 段階⑤の選抜には最低9件(TEMPLATE_COUNT_ATTACK/DISRUPT)以上の候補が要るため、アーカイブの
 * 生存者(quality で選び抜かれた優良個体)に、段階②の元の候補プール(attackSeeds/disruptSeeds)から
 * 未使用の genome を補って cap 件まで埋める。アーカイブ生存者は必ず残し、順序は決定論的
 * (dedupe は genomeKey の出現順)。
 */
function finalizePool(archiveGenomes, seedGenomes, cap) {
  const combined = dedupeGenomes(archiveGenomes);
  const seen = new Set(combined.map(genomeKey));
  for (const g of seedGenomes) {
    if (combined.length >= cap) break;
    const k = genomeKey(g);
    if (seen.has(k)) continue;
    seen.add(k);
    combined.push(g);
  }
  return combined;
}

/** map-elites.js の内部挿入ロジックを外から使うための薄いラッパ(runMapElites 内部と同じ形)。 */
function evaluateAndInsert(archive, evaluate, genome) {
  const r = evaluate(genome);
  if (r == null || r.descriptor == null) return;
  tryInsert(archive, { genome, descriptor: r.descriptor, quality: r.quality, meta: r.meta });
}

/** ARCHIVE2.entryPositionBins 個に entryX(0..WIDTH-1)を等分する。 */
function entryPositionTierOf(entryX) {
  const bins = C.ARCHIVE2.entryPositionBins;
  const x = entryX ?? 0;
  return Math.max(0, Math.min(bins - 1, Math.floor(x / (C.WIDTH / bins))));
}

/** ARCHIVE2.robustnessBins の境界で robustness(0..1)をビン分けする。 */
function robustnessTierOf(robustness) {
  const bounds = C.ARCHIVE2.robustnessBins;
  for (let i = 0; i < bounds.length; i++) {
    if (robustness <= bounds[i]) return i;
  }
  return bounds.length - 1;
}

/** ARCHIVE2.reachBins 個に reachRows(縦到達距離)をビン分けする。 */
function reachTierOf(reachRows) {
  const bins = C.ARCHIVE2.reachBins;
  return Math.max(0, Math.min(bins - 1, Math.floor(reachRows / (DISRUPT_REACH_SCALE / bins))));
}

/** 単発発射の軌跡(simulateSolo の path)から終端の向き(0..3)を推定する。 */
function endDirectionFromPath(path) {
  if (!path || path.length < 2) return null;
  const [x1, y1] = path[path.length - 2];
  const [x2, y2] = path[path.length - 1];
  let dx = x2 - x1;
  if (dx > C.WIDTH / 2) dx -= C.WIDTH;
  else if (dx < -C.WIDTH / 2) dx += C.WIDTH;
  const dy = y2 - y1;
  const found = C.DIRS.findIndex(([ddx, ddy]) => ddx === dx && ddy === dy);
  return found >= 0 ? found : null;
}

/**
 * attackGenome を disruptPool(genome配列)× FIRE_TIMINGS の総当たりで何通り止められるかを数える。
 * evaluateInteraction(src/search/evaluate-interaction.js)をそのまま使う(自前でシミュレーションしない)。
 */
function countCounters(attackGenome, disruptPool) {
  let n = 0;
  for (const d of disruptPool) {
    for (const t0 of C.FIRE_TIMINGS) {
      evalCount++;
      const { scored } = evaluateInteraction(attackGenome, d, t0);
      if (!scored) n++;
    }
  }
  return n;
}

/** disruptGenome が attackPool(genome配列)のうち何件を(いずれかのタイミングで)止められるかを数える。 */
function countCoverage(disruptGenome, attackPool) {
  let coveredCount = 0;
  for (const a of attackPool) {
    let covered = false;
    for (const t0 of C.FIRE_TIMINGS) {
      evalCount++;
      const { scored } = evaluateInteraction(a, disruptGenome, t0);
      if (!scored) {
        covered = true;
        break;
      }
    }
    if (covered) coveredCount++;
  }
  return coveredCount;
}

// ---------------------------------------------------------------------------
// ① 第1アーカイブ: MAP-Elites によるハイウェイ探索
// ---------------------------------------------------------------------------
function buildHighwayArchive() {
  log(`①開始: 第1アーカイブ(ハイウェイ探索) initialBatch=${PARAMS.archive1InitialBatch} iterations=${PARAMS.archive1Iterations}`);

  const archive1 = createArchive({
    dims: [
      { name: 'direction', bins: C.ARCHIVE1.directions.length },
      { name: 'speedBin', bins: C.ARCHIVE1.speedBins },
      { name: 'formationBin', bins: C.ARCHIVE1.formationBins.length },
      { name: 'cost', bins: C.MAX_CELLS + C.ATTACK_COST + 1 },
    ],
  });

  function evaluate(genome) {
    evalCount++;
    const p = evaluateProjectile(genome);
    // 高速フィルタでハイウェイ未検出の genome はアーカイブに入れない(単一セルへの汚染防止。
    // map-elites.js の runMapElites は descriptor===null を「挿入せずスキップ」として扱う)。
    if (!p.highway.detected) return null;
    return { descriptor: p.descriptor, quality: p.quality, meta: { highway: p.highway, game: p.game, viable: p.viable } };
  }

  runMapElites({
    archive: archive1,
    evaluate,
    rng,
    iterations: PARAMS.archive1Iterations,
    initialBatch: PARAMS.archive1InitialBatch,
    onProgress: (stats) =>
      log(`  archive1: coverage=${(stats.coverage * 100).toFixed(1)}% filled=${stats.filled}/${stats.total} qualityMax=${stats.qualityMax.toFixed(2)}`),
  });

  const stats = archiveStats(archive1);
  log(`①完了: filled=${stats.filled}/${stats.total} coverage=${(stats.coverage * 100).toFixed(1)}%`);
  return archive1;
}

// ---------------------------------------------------------------------------
// ② ゲーム射影: viable(攻撃) / highway.detected(妨害) だけを候補プールへ通す
// ---------------------------------------------------------------------------
function projectCandidates(archive1) {
  const entries = archiveEntries(archive1);
  // 攻撃候補: 寿命内(ATTACK_LIFE)に敵陣へ届く(evaluateProjectile の viable===true)。
  const attackSeeds = entries.filter((e) => e.meta.viable).map((e) => e.genome);
  // 妨害候補: ハイウェイとして検出されている(highway.detected)。
  //
  // ⚠️ 妨害の「viable」は「寿命内に敵陣へ到達できる」とは解釈しない。docs/spec.md 機能5は
  // 「妨害アリは寿命400では最大でも約22列しか進めず、敵陣には到達しない」ことを受け入れ条件に
  // している。したがって攻撃と同じ意味の viable ゲートを妨害に課すと候補が恒常的に0件になる
  // (満たせない要求)。ここでは「ハイウェイとして検出される非退化な軌道であること」を妨害版の
  // viable として扱い、後述の検証で「妨害は寿命内に敵陣へ届かない」ことを逆に確認する(報告参照)。
  const disruptSeeds = entries.filter((e) => e.meta.highway.detected).map((e) => e.genome);
  log(`②完了: 攻撃候補(viable)=${attackSeeds.length}件 / 妨害候補(highway検出)=${disruptSeeds.length}件`);
  return { attackSeeds, disruptSeeds };
}

// ---------------------------------------------------------------------------
// ③④ 第2アーカイブ(攻撃/妨害)+ 共進化ラウンド
// ---------------------------------------------------------------------------
function coevolve(attackSeeds, disruptSeeds) {
  const archive2Attack = createArchive({
    dims: [
      { name: 'entryPositionTier', bins: C.ARCHIVE2.entryPositionBins },
      { name: 'robustnessTier', bins: C.ARCHIVE2.robustnessBins.length },
    ],
  });
  const archive2Disrupt = createArchive({
    dims: [
      { name: 'reachTier', bins: C.ARCHIVE2.reachBins },
      { name: 'endDirTier', bins: C.DIRS.length },
    ],
  });

  let attackPool = dedupeGenomes(sampleGenomes(attackSeeds, PARAMS.attackPoolSize));
  let disruptPool = dedupeGenomes(sampleGenomes(disruptSeeds, PARAMS.disruptPoolSize));
  log(`③開始: 初期プール 攻撃${attackPool.length}件・妨害${disruptPool.length}件から共進化`);

  /**
   * 攻撃側の評価(§16-1「highway/viability評価」)。robustness は descriptor のビン分けにのみ使い、
   * quality には使わない(quality を robustness にすると「無敵弾」を最大品質として扱ってしまう。
   * §17 の理由でこれを避け、選抜基準の充足は段階⑤の選抜時に別途強制する)。
   */
  function makeAttackEvaluator(currentDisruptPool) {
    return function evaluateAttack(genome) {
      const p = evaluateProjectile(genome);
      evalCount++;
      if (!p.viable) return null;
      const total = currentDisruptPool.length * C.FIRE_TIMINGS.length;
      const counterCount = currentDisruptPool.length > 0 ? countCounters(genome, currentDisruptPool) : 0;
      const robustness = total > 0 ? 1 - counterCount / total : 1;
      const descriptor = {
        entryPositionTier: entryPositionTierOf(p.game.entryX),
        robustnessTier: robustnessTierOf(robustness),
      };
      return { descriptor, quality: p.quality, meta: { robustness, counterCount } };
    };
  }

  /**
   * 妨害側の評価(§16-3「現在の攻撃アーカイブに対する coverage 評価」)。
   * quality=coverage(高いほど良い)。coverage===0 でも挿入は妨げない(段階⑤で除外する)。
   */
  function makeDisruptEvaluator(currentAttackPool) {
    return function evaluateDisrupt(genome) {
      const tpl = genomeToTemplate(genome, 'disrupt');
      const r = simulateSolo(tpl, { trackPath: true });
      evalCount++;
      const reachRows = Math.max(0, r.endY - genome.antY);
      const endDirTier = endDirectionFromPath(r.path) ?? genome.antDir;
      const coveredCount = currentAttackPool.length > 0 ? countCoverage(genome, currentAttackPool) : 0;
      const coverage = currentAttackPool.length > 0 ? coveredCount / currentAttackPool.length : 0;
      const descriptor = { reachTier: reachTierOf(reachRows), endDirTier };
      return { descriptor, quality: coverage, meta: { coverage, reachRows } };
    };
  }

  for (let round = 1; round <= PARAMS.coevoRounds; round++) {
    log(`--- 共進化ラウンド ${round}/${PARAMS.coevoRounds} ---`);

    // §16-1: 攻撃ラウンド(親を選ぶ→mutate→評価→挿入。初回は現在の攻撃プールも種として挿入する)
    const evalAttack = makeAttackEvaluator(disruptPool);
    for (const g of attackPool) evaluateAndInsert(archive2Attack, evalAttack, g);
    runMapElites({
      archive: archive2Attack,
      evaluate: evalAttack,
      rng,
      iterations: PARAMS.coevoAttackIters,
      initialBatch: 0,
      onProgress: (stats) => log(`  攻撃archive: filled=${stats.filled} qualityMax=${stats.qualityMax.toFixed(2)}`),
    });
    // アーカイブの生存者(quality最良)＋段階②の元候補で cap 件まで補う(finalizePool のコメント参照)。
    attackPool = finalizePool(
      archiveEntries(archive2Attack).map((e) => e.genome),
      attackSeeds,
      PARAMS.attackPoolSize
    );

    // §16-2: 現在の妨害アーカイブに対する robustness 報告(挿入時に記録した meta.robustness の平均。
    // 追加のシミュレーションを増やさないための近似値。厳密な再測定は段階⑤の最終行列で行う)
    const robustnessValues = archiveEntries(archive2Attack).map((e) => e.meta.robustness);
    const meanRobustness = robustnessValues.length
      ? robustnessValues.reduce((s, v) => s + v, 0) / robustnessValues.length
      : NaN;
    log(`  robustness評価: 攻撃アーカイブ${robustnessValues.length}件の平均robustness=${meanRobustness.toFixed(3)}`);

    // §16-3: 妨害ラウンド(親を選ぶ→mutate→現在の攻撃アーカイブへの coverage評価→挿入)
    const evalDisrupt = makeDisruptEvaluator(attackPool);
    for (const g of disruptPool) evaluateAndInsert(archive2Disrupt, evalDisrupt, g);
    runMapElites({
      archive: archive2Disrupt,
      evaluate: evalDisrupt,
      rng,
      iterations: PARAMS.coevoDisruptIters,
      initialBatch: 0,
      onProgress: (stats) => log(`  妨害archive: filled=${stats.filled} qualityMax=${stats.qualityMax.toFixed(2)}`),
    });
    disruptPool = finalizePool(
      archiveEntries(archive2Disrupt).map((e) => e.genome),
      disruptSeeds,
      PARAMS.disruptPoolSize
    );

    log(`  ラウンド${round}完了: 攻撃プール${attackPool.length}件・妨害プール${disruptPool.length}件 累計評価${evalCount.toLocaleString()}回`);
  }

  return { archive2Attack, archive2Disrupt, attackPool, disruptPool };
}

// ---------------------------------------------------------------------------
// ⑤ 9×9 選抜(貪欲法+局所探索)
// ---------------------------------------------------------------------------
function selectNineByNine(attackPool, disruptPool) {
  const NA = attackPool.length;
  const ND = disruptPool.length;
  log(`⑤開始: 候補${NA}攻撃 × ${ND}妨害 のカウンター行列を計算`);

  if (NA < C.TEMPLATE_COUNT_ATTACK || ND < C.TEMPLATE_COUNT_DISRUPT) {
    log(`  候補数が9件に満たない(攻撃${NA}/妨害${ND})ため選抜不能`);
    return { ok: false };
  }

  const { matrix } = buildCounterMatrix(attackPool, disruptPool, {
    onProgress: ({ evaluated, total }) => {
      if (evaluated % 2000 === 0) log(`  行列計算 ${evaluated}/${total}`);
      evalCount++;
    },
  });
  // matrix[a][d][t] は evaluate-interaction.js の buildCounterMatrix の生値で「scored」
  // (攻撃が得点したか)を保持している。「d が a を止めた」は scored===false のときなので、
  // M[a][d] = FIRE_TIMINGS のうち d が a を止めた(scored===false だった)タイミングの数。
  const M = matrix.map((row) => row.map((cell) => cell.filter((scored) => !scored).length));

  function evaluate(ai, di) {
    const sub = ai.map((a) => di.map((d) => M[a][d]));
    const pa = sub.map((row) => row.filter((v) => v > 0).length); // 攻撃1件あたりのカウンター種数
    const pd = di.map((_, j) => sub.reduce((s, row) => s + (row[j] > 0 ? 1 : 0), 0)); // 妨害1件あたりのカバー数
    const zeroA = pa.filter((v) => v === 0).length;
    const zeroD = pd.filter((v) => v === 0).length;
    const posSet = new Set(ai.map((a) => `${attackPool[a].antX},${attackPool[a].antY},${attackPool[a].antDir}`));
    const cellsOk = ai.every((a) => attackPool[a].cells.length >= C.MIN_TEMPLATE_CELLS);

    let score = 0;
    score -= 100000 * zeroA; // 必須: カウンター無し攻撃は0件
    score -= 100000 * zeroD; // 必須: 死に札は0件
    score -= 100000 * (C.TEMPLATE_COUNT_ATTACK - posSet.size); // 必須: 発射位置・向きがすべて異なる
    score -= 100000 * (cellsOk ? 0 : 1); // 必須: 配置マス数1個以上(genome不変条件で通常満たされるが保険)
    // 目標: カウンター種数・カバー数は2〜4が理想
    score -= pa.reduce((s, v) => s + Math.max(0, 2 - v) + Math.max(0, v - 4), 0) * 10;
    score -= pd.reduce((s, v) => s + Math.max(0, 2 - v) + Math.max(0, v - 4), 0) * 10;
    // 目標: コストの散らばり
    const costSet = new Set(ai.map((a) => C.ATTACK_COST + attackPool[a].cells.length));
    score += costSet.size * 5;
    // 目標(v4追加): ルール長の散らばり。ランダムgenomeはL=3に偏りやすいため明示的にボーナスを与える。
    const ruleLenSet = new Set(ai.map((a) => attackPool[a].rule.length));
    score += ruleLenSet.size * 8;

    return { score, pa, pd, zeroA, zeroD, posSet, ruleLenSet, costSet };
  }

  // 貪欲初期化: カウンター数が多い(=止められやすい)攻撃を優先、カバー数の多い妨害を優先
  const attackOrder = [...Array(NA).keys()].sort((a, b) => {
    const ca = disruptPool.reduce((s, _, j) => s + (M[a][j] > 0 ? 1 : 0), 0);
    const cb = disruptPool.reduce((s, _, j) => s + (M[b][j] > 0 ? 1 : 0), 0);
    return cb - ca === 0 ? a - b : cb - ca;
  });
  let ai = attackOrder.slice(0, C.TEMPLATE_COUNT_ATTACK);
  const disruptOrder = [...Array(ND).keys()].sort((a, b) => {
    const cova = attackPool.reduce((s, _, i) => s + (M[i][a] > 0 ? 1 : 0), 0);
    const covb = attackPool.reduce((s, _, i) => s + (M[i][b] > 0 ? 1 : 0), 0);
    return covb - cova === 0 ? a - b : covb - cova;
  });
  let di = disruptOrder.slice(0, C.TEMPLATE_COUNT_DISRUPT);

  let cur = evaluate(ai, di).score;
  for (let it = 0; it < PARAMS.localSearchIters; it++) {
    const na = [...ai];
    const nd = [...di];
    if (rng() < 0.5) {
      na[Math.floor(rng() * C.TEMPLATE_COUNT_ATTACK)] = Math.floor(rng() * NA);
      if (new Set(na).size < C.TEMPLATE_COUNT_ATTACK) continue;
    } else {
      nd[Math.floor(rng() * C.TEMPLATE_COUNT_DISRUPT)] = Math.floor(rng() * ND);
      if (new Set(nd).size < C.TEMPLATE_COUNT_DISRUPT) continue;
    }
    const ev = evaluate(na, nd);
    if (ev.score >= cur) {
      cur = ev.score;
      ai = na;
      di = nd;
    }
  }

  const finalEval = evaluate(ai, di);
  const ok =
    finalEval.zeroA === 0 &&
    finalEval.zeroD === 0 &&
    finalEval.posSet.size === C.TEMPLATE_COUNT_ATTACK &&
    ai.every((a) => attackPool[a].cells.length >= C.MIN_TEMPLATE_CELLS) &&
    di.every((d) => disruptPool[d].cells.length >= C.MIN_TEMPLATE_CELLS);
  log(
    `⑤完了: score=${finalEval.score} カウンター無し攻撃=${finalEval.zeroA} 死に札=${finalEval.zeroD} ` +
      `識別可能=${finalEval.posSet.size}/9 ルール長多様性=${finalEval.ruleLenSet.size}種 ` +
      `コスト多様性=${finalEval.costSet.size}種 必須条件=${ok ? 'OK' : 'NG'}`
  );
  return { ai, di, M, ok, report: finalEval };
}

// ---------------------------------------------------------------------------
// 段階3(旧番号)相当: テーブルを計算して出力オブジェクトを組み立てる
// ---------------------------------------------------------------------------
function buildOutput(attackPool, disruptPool, ai, di) {
  log('最終テーブル計算開始(選抜した9×9のみ)');

  const attacks = ai.map((idx, i) => {
    const g = attackPool[idx];
    g.id = `A${i + 1}`;
    return g;
  });
  const disrupts = di.map((idx, i) => {
    const g = disruptPool[idx];
    g.id = `D${i + 1}`;
    return g;
  });

  const { matrix, counterTable, attacksWithoutCounter, disruptsWithoutCoverage, counterDensity } = buildCounterMatrix(
    attacks,
    disrupts,
    { onProgress: () => evalCount++ }
  );
  const escortTableRaw = buildEscortTable(attacks, disrupts, counterTable, { onProgress: () => evalCount++ });
  // evaluate-interaction.js の buildEscortTable は { interceptFireAtStep, escortDisruptId, fireAtStep }
  // を返すが、data/templates.json のスキーマ(docs/data-model.md)は { escortId, fireAtStep } なので変換する。
  const escortTable = {};
  for (const [attackId, byIntercept] of Object.entries(escortTableRaw)) {
    escortTable[attackId] = {};
    for (const [interceptId, entries] of Object.entries(byIntercept)) {
      escortTable[attackId][interceptId] = entries.map((e) => ({ escortId: e.escortDisruptId, fireAtStep: e.fireAtStep }));
    }
  }

  const identifyTable = {};
  attacks.forEach((a) => {
    identifyTable[`${a.antX},${a.antY},${a.antDir}`] = a.id;
  });

  const attackOut = attacks.map((g, i) => {
    const p = evaluateProjectile(g);
    const cost = costOfGenome(g, C.ATTACK_COST);
    return {
      id: g.id,
      kind: 'attack',
      rule: g.rule,
      colorCount: g.rule.length,
      cells: toTemplateCells(g),
      antX: g.antX,
      antY: g.antY,
      antDir: g.antDir,
      cost,
      arrivalStep: p.game.steps,
      robustness: 1 - counterDensity[i],
      costTier: cost,
      featureTier: entryPositionTierOf(p.game.entryX),
      highway: p.highway,
    };
  });

  const disruptOut = disrupts.map((g, j) => {
    const tpl = genomeToTemplate(g, 'disrupt');
    const r = simulateSolo(tpl, { trackPath: true });
    const cost = costOfGenome(g, C.DISRUPT_COST);
    const reachRows = Math.max(0, r.endY - g.antY);
    const endDirection = endDirectionFromPath(r.path) ?? g.antDir;
    const coveredCount = attacks.filter((_, i) => matrix[i][j].some(Boolean)).length;
    const coverage = attacks.length > 0 ? coveredCount / attacks.length : 0;
    return {
      id: g.id,
      kind: 'disrupt',
      rule: g.rule,
      colorCount: g.rule.length,
      cells: toTemplateCells(g),
      antX: g.antX,
      antY: g.antY,
      antDir: g.antDir,
      cost,
      reachRows,
      endDirection,
      coverage,
      costTier: cost,
      featureTier: reachTierOf(reachRows),
    };
  });

  log(`最終テーブル計算完了: カウンター無し攻撃=${attacksWithoutCounter.length}件 死に札=${disruptsWithoutCoverage.length}件`);

  return {
    attackOut,
    disruptOut,
    identifyTable,
    counterTable,
    escortTable,
    validation: {
      attacksWithoutCounter: attacksWithoutCounter.length,
      disruptsWithoutCoverage: disruptsWithoutCoverage.length,
    },
  };
}

// ---------------------------------------------------------------------------
// パイプライン全体(必須条件を満たさなければ予算を拡張してリトライ)
// ---------------------------------------------------------------------------
function runPipeline() {
  let archive1IterOverride = PARAMS.archive1Iterations;
  let archive1InitOverride = PARAMS.archive1InitialBatch;

  for (let attempt = 1; attempt <= PARAMS.maxPipelineAttempts; attempt++) {
    log(`=== パイプライン試行 ${attempt}/${PARAMS.maxPipelineAttempts} ===`);
    PARAMS.archive1Iterations = archive1IterOverride;
    PARAMS.archive1InitialBatch = archive1InitOverride;

    const archive1 = buildHighwayArchive();
    const { attackSeeds, disruptSeeds } = projectCandidates(archive1);
    if (attackSeeds.length < C.TEMPLATE_COUNT_ATTACK || disruptSeeds.length < C.TEMPLATE_COUNT_DISRUPT) {
      log('  ②の候補数が不足したため予算を拡張してリトライ');
      archive1IterOverride = Math.round(archive1IterOverride * 1.5);
      archive1InitOverride = Math.round(archive1InitOverride * 1.5);
      continue;
    }

    const { archive2Attack, archive2Disrupt, attackPool, disruptPool } = coevolve(attackSeeds, disruptSeeds);
    const selection = selectNineByNine(attackPool, disruptPool);
    if (selection.ok) {
      const output = buildOutput(attackPool, disruptPool, selection.ai, selection.di);
      return { output, archive1, archive2Attack, archive2Disrupt };
    }
    log('  ⑤の必須条件を満たさなかったため予算を拡張してリトライ');
    archive1IterOverride = Math.round(archive1IterOverride * 1.5);
    archive1InitOverride = Math.round(archive1InitOverride * 1.5);
    PARAMS.attackPoolSize = Math.round(PARAMS.attackPoolSize * 1.3);
    PARAMS.disruptPoolSize = Math.round(PARAMS.disruptPoolSize * 1.3);
  }
  throw new Error('選抜基準を満たす9x9が見つかりませんでした(maxPipelineAttemptsに到達)');
}

// ---------------------------------------------------------------------------
// メイン
// ---------------------------------------------------------------------------
function main() {
  log(`generate-templates 開始 (seed=${SEED}, quick=${QUICK})`);
  const { output, archive1, archive2Attack, archive2Disrupt } = runPipeline();

  // generatedAt は日付のみを使う(同一シード2回実行のバイト一致を保証するため、時刻までは含めない)。
  const generatedAt = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;

  const templatesOutput = {
    generatedAt,
    config: {
      width: C.WIDTH,
      height: C.HEIGHT,
      zoneDepth: C.ZONE_DEPTH,
      minColors: C.MIN_COLORS,
      maxColors: C.MAX_COLORS,
      searchLife: C.SEARCH_LIFE,
      gameProjectileLife: C.ATTACK_LIFE,
      attackCost: C.ATTACK_COST,
      attackLife: C.ATTACK_LIFE,
      disruptCost: C.DISRUPT_COST,
      disruptLife: C.DISRUPT_LIFE,
      maxCells: C.MAX_CELLS,
    },
    attack: output.attackOut,
    disrupt: output.disruptOut,
    identifyTable: output.identifyTable,
    counterTable: output.counterTable,
    escortTable: output.escortTable,
  };

  const archiveOutput = {
    seed: SEED,
    quick: QUICK,
    rounds: PARAMS.coevoRounds,
    evaluations: evalCount,
    generatedAt,
    archive1: archiveToJSON(archive1),
    archive2Attack: archiveToJSON(archive2Attack),
    archive2Disrupt: archiveToJSON(archive2Disrupt),
  };

  mkdirSync(path.dirname(TEMPLATES_OUT_PATH), { recursive: true });
  writeFileSync(TEMPLATES_OUT_PATH, JSON.stringify(templatesOutput, null, 2) + '\n', 'utf8');
  writeFileSync(ARCHIVE_OUT_PATH, JSON.stringify(archiveOutput, null, 2) + '\n', 'utf8');
  log(`書き出し完了: ${TEMPLATES_OUT_PATH}`);
  log(`書き出し完了: ${ARCHIVE_OUT_PATH}`);
  log(`累計評価回数 ${evalCount.toLocaleString()} 回`);
  log(`合計所要時間 ${elapsedSec().toFixed(1)}秒`);
}

main();
