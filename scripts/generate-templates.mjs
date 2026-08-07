#!/usr/bin/env node
// data/templates.json を生成する MAP-Elites パイプラインの制御役。
// docs/spec.md「テンプレート選抜基準」・docs/data-model.md「data/templates.json」準拠。
//
// ⚠️ このファイルはパイプラインの配線だけを行う。探索・評価・変異・アーカイブ・蒸留・
// レポートのロジックはすべて src/search/* に実装済みで、ここでは import して呼び出すだけ
// にする(自前で再実装しない。AGENTS.md)。
//
// パイプライン(v5):
//   ① MAP-Elites 探索(第1アーカイブ: direction × speed × formationTime × cost)
//      + **Seed Distillation**: ハイウェイが見つかった個体は形成時点の局所盤面を種として
//        逆抽出し、蒸留 genome も同じアーカイブへ再投入する(仕様 §10-§24)
//   ② ゲーム射影(arrivalStep <= ATTACK_LIFE を viable とする)
//   ③④ 攻撃/妨害それぞれの第2 MAP-Elites アーカイブ + 共進化
//   ④.5 最終選抜直前のゲート: strict 再評価で fingerprintVerified===true だけを残す
//   ⑤ 9×9 を貪欲法+局所探索で選抜し、counterTable/escortTable/identifyTable を計算
//
// ⚠️ 並列化と決定論(v5):
//   乱数はこのメインスレッドだけが持つ。ワーカー(scripts/lib/search-worker.mjs)は
//   「渡された genome を評価して返すだけの純粋関数」で、結果は**完了順ではなく投入した
//   添字順**にアーカイブへ入れる。したがって --seed を固定すればワーカー数によらず
//   出力は一致する。
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as C from '../src/config.js';
import { createRng, simulateSolo, instantiateTemplate } from '../src/engine.js';
import {
  createRandomGenome,
  genomeKey,
  identityKey,
  toTemplateCells,
  costOfGenome,
  cloneGenome,
} from '../src/search/genome.js';
import { mutate } from '../src/search/mutate.js';
import {
  createArchive,
  tryInsert,
  archiveEntries,
  archiveStats,
  sampleParent,
  toJSON as archiveToJSON,
  fromJSON as archiveFromJSON,
} from '../src/search/map-elites.js';
import { buildCounterMatrix, buildEscortTable } from '../src/search/evaluate-interaction.js';
import { buildSearchReport, formatSearchReport } from '../src/search/search-report.js';
import { createPool, defaultWorkerCount } from './lib/worker-pool.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_OUT_PATH = path.join(__dirname, '..', 'data', 'templates.json');
const ARCHIVE_OUT_PATH = path.join(__dirname, '..', 'data', 'search-archive.json');
const REPORT_OUT_PATH = path.join(__dirname, '..', 'data', 'search-report.json');

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
const WORKERS = argNum('workers', defaultWorkerCount());
/**
 * 第1アーカイブ探索の評価回数を直接指定する(再現用)。
 *
 * ⚠️ `--budget-min` は実時間で打ち切るので **同じ出力を再現できない**(マシンの速さで
 * 評価回数が変わる)。実行後に「実際に何回まわしたか」をログと data/search-archive.json に
 * 記録するので、そのときの回数を `--iterations` に渡せば同じ成果物を再生成できる。
 * `--iterations` を指定したときは `--budget-min` を無視する。
 */
const ITERATIONS_OVERRIDE = argNum('iterations', null);
/**
 * 既存の探索アーカイブ(data/search-archive.json)を読み込んで段階①を丸ごと省略する。
 *
 * 用途: **ATTACK_LIFE を変えたときの作り直しを安くするため。**
 * 段階①(ハイウェイ発見)は仮想盤面を SEARCH_LIFE まで走らせるので ATTACK_LIFE に依存せず、
 * ゲーム射影も GAME_LIFE_SEARCH_CAP で走らせて arrivalStep を記録してある。
 * つまり寿命を変えて必要なのは②以降だけで、①の数時間をやり直す必要がない
 * (scripts/tune-attack-life.mjs で寿命を決めたあと、この指定で②〜⑤だけ回す)。
 */
function argStr(name, def) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= argv.length) return def;
  return argv[i + 1];
}
const RESUME_ARCHIVE = argStr('resume-archive', null);
/** 第1アーカイブ探索に使う実時間(分)。--iterations 指定時は無視する。 */
const BUDGET_MIN = ITERATIONS_OVERRIDE != null ? 0 : argNum('budget-min', QUICK ? 0 : 180);

const rngObj = createRng(SEED);
const rng = () => rngObj.next();

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
      archive1InitialBatch: 400,
      archive1Iterations: 2000,
      attackPoolSize: 24,
      disruptPoolSize: 24,
      coevoRounds: 2,
      coevoAttackIters: 120,
      coevoDisruptIters: 120,
      localSearchIters: 4000,
      maxPipelineAttempts: 2,
      coevoDisruptSample: 6,
      coevoTimingStride: 2,
      selectionAttackCap: 32,
      selectionDisruptCap: 20,
    }
  : {
      archive1InitialBatch: 4000,
      archive1Iterations: 20_000_000, // 実質は BUDGET_MIN で打ち切る
      attackPoolSize: 40,
      disruptPoolSize: 48,
      coevoRounds: 4,
      coevoAttackIters: 1200,
      coevoDisruptIters: 1200,
      localSearchIters: 120000,
      maxPipelineAttempts: 2,
      // 共進化中の robustness/coverage 評価で使う妨害/攻撃のサンプル数。
      // 全プール × 全 deltaX × 全タイミングを回すと1個体の評価に8,000回以上の
      // 相互作用シミュレーションが要り、共進化だけで探索予算を食い潰す。
      // 最終選抜のテーブル計算(段階⑤)だけ全掃引する。
      coevoDisruptSample: 10,
      coevoTimingStride: 2,
      // 段階⑤に持ち込む候補数の上限。ここを絞らないと
      // (候補数)^2 × deltaX × タイミング のカウンター行列が数百万回になり選抜が終わらない。
      // 上限内は「共進化アーカイブの生存者 → ②の viable プール」の順で埋める(決定論的)。
      selectionAttackCap: 56,
      selectionDisruptCap: 36,
    };

if (ITERATIONS_OVERRIDE != null) PARAMS.archive1Iterations = ITERATIONS_OVERRIDE;

/**
 * バッチ並列の1バッチあたりの件数。
 *
 * ⚠️ **ワーカー数から導出してはいけない。** MAP-Elites は「バッチ内では同じアーカイブ状態から
 * 親を選ぶ」ので、バッチ幅が変わると親の選択列が変わり、出力が変わってしまう。
 * ワーカー数を変えても `--seed` と `--iterations` が同じなら同じ成果物になるように、
 * ここは固定値にする(AGENTS.md「シード固定で再現性を確認する」)。
 */
const ARCHIVE1_BATCH = 240;
const COEVO_BATCH = 64;

/** 共進化中の deltaX 掃引(粗いグリッド)。最終テーブルは全列を掃引する。 */
const COEVO_DELTA_XS = Object.freeze(
  Array.from({ length: Math.floor(C.WIDTH / C.COEVO_DELTA_X_STRIDE) }, (_, i) => i * C.COEVO_DELTA_X_STRIDE),
);
/** 最終テーブル計算で掃引する deltaX。発射列が自由なので全列を見る(選抜した9×9のみ)。 */
const FULL_DELTA_XS = Object.freeze(Array.from({ length: C.WIDTH }, (_, i) => i));
/**
 * 段階⑤(9×9選抜)のカウンター行列で掃引する deltaX の刻み。
 *
 * 全 WIDTH(256)列を候補プール全件(数十×数十)で掃引すると数百万回のシミュレーションになり、
 * 選抜だけで探索予算を食い潰す。一方、迎撃が成立する deltaX は連続した帯になるので、
 * 2列おきに見れば「カウンターが存在するか」の判定はほぼ落とさない。
 * ⚠️ この粗さで見つかったカウンターは全掃引でも必ず見つかる(部分集合なので)。
 * 逆に見落としがありうるので、**最終9×9のテーブル計算は全列を掃引する**(段階⑤の
 * 判定より最終テーブルの方が必ず広い)。
 */
const SELECT_DELTA_X_STRIDE = 2;
const SELECT_DELTA_XS = Object.freeze(
  Array.from({ length: Math.floor(C.WIDTH / SELECT_DELTA_X_STRIDE) }, (_, i) => i * SELECT_DELTA_X_STRIDE),
);
/** 共進化中に使うタイミング(間引き)。 */
const COEVO_TIMINGS = Object.freeze(C.FIRE_TIMINGS.filter((_, i) => i % PARAMS.coevoTimingStride === 0));

// ---------------------------------------------------------------------------
// 共通ヘルパ
// ---------------------------------------------------------------------------

/** genome を engine / evaluate-interaction 用の相対テンプレート形に変換する。 */
function toRelativeTemplate(genome, kind) {
  return {
    rule: genome.rule,
    cells: toTemplateCells(genome),
    antY: genome.antY,
    antDir: genome.antDir,
    kind,
    templateId: genome.id ?? null,
  };
}

/** ハイウェイ署名(周期・並進の絶対値)を多様性判定用の文字列キーにする。未検出は null。 */
function highwaySignatureKey(highway) {
  if (!highway || !highway.trajectoryPeriodic) return null;
  return `${highway.period},${Math.abs(highway.driftX)},${Math.abs(highway.driftY)}`;
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
 * アーカイブの生存者に、元の候補プールから未使用の genome を補って cap 件まで埋める。
 * (記述子のセル数が上限になって共進化が進むほど生存者数が頭打ちになるため。v4 からの継続)
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

/** ARCHIVE2.speedClassBins の境界で速度クラス(v_y = |driftY| / period)をビン分けする。 */
function speedClassTierOf(vy) {
  const bounds = C.ARCHIVE2.speedClassBins;
  const v = Number.isFinite(vy) ? vy : 0;
  for (let i = 0; i < bounds.length; i++) {
    if (v <= bounds[i]) return i;
  }
  return bounds.length - 1;
}

/** ARCHIVE2.reachBins 個に reachRows(縦到達距離)をビン分けする。 */
function reachTierOf(reachRows) {
  const bins = C.ARCHIVE2.reachBins;
  return Math.max(0, Math.min(bins - 1, Math.floor(reachRows / (C.ARCHIVE2.reachScale / bins))));
}

// ---------------------------------------------------------------------------
// レポート用サンプリング
// ---------------------------------------------------------------------------
/**
 * 数千万件を全部持つとメモリが持たないので、系統サンプリングでレポート用の母集団を作る。
 * cap に達したら stride を2倍にして既存を間引く(古い側だけに偏らない・決定論的)。
 */
function createReportSampler(cap) {
  const records = [];
  let stride = 1;
  let seen = 0;
  return {
    add(rec) {
      if (seen % stride === 0) records.push(rec);
      seen++;
      if (records.length > cap) {
        stride *= 2;
        for (let i = 0, j = 0; i < records.length; i += 2, j++) records[j] = records[i];
        records.length = Math.ceil(records.length / 2);
      }
    },
    get records() {
      return records;
    },
    get seen() {
      return seen;
    },
    get stride() {
      return stride;
    },
  };
}
const REPORT_SAMPLE_CAP = 120000;

// ---------------------------------------------------------------------------
// viable 個体のコレクタ
// ---------------------------------------------------------------------------
/**
 * 「寿命内に敵陣へ届いた個体」を、**MAP-Elites アーカイブとは別に**溜めておく。
 *
 * ⚠️ これが無いと候補が枯れる。第1アーカイブは記述子セルごとに quality 最良の1体しか
 * 残さないが、quality は viability を直接には見ていない(stability / verticality /
 * usability / formationPenalty の合成)。そのため探索が進むほど viable な elite が
 * 「quality はもっと高いが届かない個体」に置き換えられて消える。
 * 実測: 評価2万回で viable elite 71件 → 18万回で 56件(アーカイブの充填は 759→1,100 と
 * 増えているのに viable は減る)。3時間回しても最終候補が数十件しか残らないことになる。
 *
 * そこでハイウェイ署名ごとに quality 上位 perSignature 件を保持する。署名で分けるのは、
 * 単純な上位N件にすると最頻署名(45度・周期18)だけで埋まって多様性が死ぬため。
 */
function createViableCollector(perSignature) {
  const bySignature = new Map();
  let total = 0;
  return {
    add(genome, evaluation) {
      const sig = highwaySignatureKey(evaluation.highway) ?? 'none';
      if (!bySignature.has(sig)) bySignature.set(sig, []);
      const list = bySignature.get(sig);
      list.push({ genome, quality: evaluation.quality, meta: { highway: evaluation.highway, game: evaluation.game, viable: true } });
      total++;
      if (list.length > perSignature * 2) {
        // 償却: 上限の2倍まで溜まったら quality 降順で上位 perSignature 件に切り詰める
        list.sort((a, b) => b.quality - a.quality || (genomeKey(a.genome) < genomeKey(b.genome) ? -1 : 1));
        list.length = perSignature;
      }
    },
    /** 署名ごとに quality 上位を切り詰めた entries を返す(決定論的)。 */
    entries() {
      const out = [];
      for (const sig of [...bySignature.keys()].sort()) {
        const list = bySignature.get(sig);
        list.sort((a, b) => b.quality - a.quality || (genomeKey(a.genome) < genomeKey(b.genome) ? -1 : 1));
        out.push(...list.slice(0, perSignature));
      }
      return out;
    },
    get signatureCount() {
      return bySignature.size;
    },
    get seen() {
      return total;
    },
  };
}
/** 署名ごとに保持する viable 個体の上限。署名20種 × 200件でも4,000件で、メモリは十分軽い。 */
const VIABLE_PER_SIGNATURE = 200;

// ---------------------------------------------------------------------------
// ① 第1アーカイブ: MAP-Elites によるハイウェイ探索(バッチ並列 + Seed Distillation)
// ---------------------------------------------------------------------------
async function buildHighwayArchive(pool, sampler, viableCollector) {
  log(
    `①開始: 第1アーカイブ(ハイウェイ探索+Seed Distillation) workers=${pool.size} ` +
      `initialBatch=${PARAMS.archive1InitialBatch} 予算=${BUDGET_MIN > 0 ? BUDGET_MIN + '分' : PARAMS.archive1Iterations + '評価'}`,
  );

  const archive1 = createArchive({
    dims: [
      { name: 'direction', bins: C.ARCHIVE1.directions.length },
      { name: 'speedBin', bins: C.ARCHIVE1.speedBins },
      { name: 'formationBin', bins: C.ARCHIVE1.formationBins.length },
      { name: 'cost', bins: C.MAX_CELLS + C.ATTACK_COST + 1 },
    ],
  });

  const distillStats = { attempted: 0, success: 0, gameUsable: 0, reinserted: 0 };

  /** 1件の評価結果をアーカイブに入れ、レポート母集団に足す。 */
  function absorb(genome, r) {
    evalCount++;
    sampler.add({
      highway: r.highway,
      game: r.game,
      viable: r.viable,
      ruleLength: genome.rule.length,
      distillation: r.distillation,
      distilledViable: r.distilledEval ? r.distilledEval.viable : null,
    });
    // ⚠️ アーカイブの elite になれなくても、viable なら必ず拾っておく(コレクタのコメント参照)。
    if (r.viable) viableCollector.add(genome, r);
    if (r.highway.trajectoryPeriodic && r.descriptor != null) {
      tryInsert(archive1, {
        genome,
        descriptor: r.descriptor,
        quality: r.quality,
        meta: { highway: r.highway, game: r.game, viable: r.viable, distillation: r.distillation },
      });
    }
    // 蒸留 genome は特別扱いせず、通常の個体として同じアーカイブへ再投入する(§18)。
    if (r.distillation) {
      distillStats.attempted++;
      if (r.distillation.success) distillStats.success++;
      if (r.distillation.gameUsable) distillStats.gameUsable++;
    }
    if (r.distilledEval && r.distilledEval.viable) viableCollector.add(r.distilledGenome, r.distilledEval);
    if (r.distilledGenome && r.distilledEval && r.distilledEval.highway.trajectoryPeriodic) {
      distillStats.reinserted++;
      tryInsert(archive1, {
        genome: r.distilledGenome,
        descriptor: r.distilledEval.descriptor,
        quality: r.distilledEval.quality,
        meta: {
          highway: r.distilledEval.highway,
          game: r.distilledEval.game,
          viable: r.distilledEval.viable,
          distillation: null,
        },
      });
    }
  }

  // 初期バッチ(ランダム個体)
  const initial = Array.from({ length: PARAMS.archive1InitialBatch }, () => createRandomGenome(rng));
  const initialResults = await pool.runBatch(
    'evaluate',
    initial.map((g) => ({ genome: g, distill: true })),
  );
  for (let i = 0; i < initial.length; i++) absorb(initial[i], initialResults[i]);

  // 以降はバッチ単位で「親を選ぶ → 変異 → 並列評価 → 添字順に挿入」を繰り返す。
  const BATCH = ARCHIVE1_BATCH;
  const deadlineSec = BUDGET_MIN > 0 ? BUDGET_MIN * 60 : Infinity;
  let iterations = 0;
  let lastLog = 0;
  while (elapsedSec() < deadlineSec && iterations < PARAMS.archive1Iterations) {
    const children = [];
    for (let i = 0; i < BATCH; i++) {
      const parent = sampleParent(archive1, rng);
      children.push(parent ? mutate(parent.genome, rng) : createRandomGenome(rng));
    }
    const results = await pool.runBatch(
      'evaluate',
      children.map((g) => ({ genome: g, distill: true })),
    );
    for (let i = 0; i < children.length; i++) absorb(children[i], results[i]);
    iterations += BATCH;

    if (elapsedSec() - lastLog > 30) {
      lastLog = elapsedSec();
      const stats = archiveStats(archive1);
      const viableCount = archiveEntries(archive1).filter((e) => e.meta.viable).length;
      log(
        `  archive1: 評価${evalCount.toLocaleString()} (${(evalCount / elapsedSec()).toFixed(0)}/秒) ` +
          `coverage=${(stats.coverage * 100).toFixed(1)}% filled=${stats.filled}/${stats.total} ` +
          `viable elite=${viableCount} / viable収集=${viableCollector.seen.toLocaleString()}(署名${viableCollector.signatureCount}種) ` +
          `qualityMax=${stats.qualityMax.toFixed(2)} ` +
          `蒸留 成功${distillStats.success}/${distillStats.attempted} 再投入${distillStats.reinserted}`,
      );
    }
  }

  const stats = archiveStats(archive1);
  log(`①完了: filled=${stats.filled}/${stats.total} coverage=${(stats.coverage * 100).toFixed(1)}% 評価${evalCount.toLocaleString()}回`);
  // ⚠️ 実時間予算(--budget-min)で打ち切った場合、この回数はマシンの速さに依存する。
  // 同じ成果物を再生成するには --iterations にこの値を渡す(冒頭の ITERATIONS_OVERRIDE 参照)。
  log(`①の反復回数: ${iterations}(再現するには --seed ${SEED} --iterations ${iterations})`);
  return { archive1, distillStats, iterations };
}

// ---------------------------------------------------------------------------
// 候補プールの層化(多様性を取りこぼさないための間引き)
// ---------------------------------------------------------------------------
/**
 * 候補をハイウェイ署名ごとに層化してから cap 件まで選ぶ。
 *
 * ⚠️ ここを素朴に「先頭から cap 件」にしてはいけない。アーカイブの列挙順は
 * 「そのセルが最初に埋まった順」なので、**見つけやすい(=ありふれた)署名の個体が
 * 前に来る**。数千件の viable から先頭56件を取ると、選抜プールが最頻の署名で埋まり、
 * 選抜スコアが署名多様性を評価していても「プールに無いものは選べない」ことになる。
 * これは渡された改善案が指摘していた「45度への collapse」を選抜段階で再現してしまう経路。
 *
 * そこで署名ごとにグループ分けし、各グループを quality 降順に並べてから
 * ラウンドロビンで取る。乱数を使わないので決定論的。
 */
function stratifyBySignature(entries, cap) {
  const groups = new Map();
  for (const e of entries) {
    const k = highwaySignatureKey(e.meta.highway) ?? 'none';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const keys = [...groups.keys()].sort();
  for (const k of keys) {
    groups.get(k).sort((a, b) => b.quality - a.quality || (genomeKey(a.genome) < genomeKey(b.genome) ? -1 : 1));
  }
  const out = [];
  for (let round = 0; out.length < cap; round++) {
    let added = 0;
    for (const k of keys) {
      const list = groups.get(k);
      if (round >= list.length) continue;
      out.push(list[round].genome);
      added++;
      if (out.length >= cap) break;
    }
    if (added === 0) break;
  }
  return { genomes: out, groupCount: keys.length };
}

// ---------------------------------------------------------------------------
// ② ゲーム射影
// ---------------------------------------------------------------------------
function projectCandidates(archive1, viableCollector) {
  const entries = archiveEntries(archive1);
  // 攻撃候補: 寿命内(ATTACK_LIFE)に敵陣へ届く。
  // アーカイブの現在の elite だけでなく、探索中に拾った viable 個体(createViableCollector)も
  // 合流させる。elite は quality 競合で入れ替わるので、これが無いと候補が枯れる。
  const collected = viableCollector ? viableCollector.entries() : [];
  const seenKeys = new Set();
  const attackSeedEntries = [];
  for (const e of [...entries.filter((x) => x.meta.viable), ...collected]) {
    const k = genomeKey(e.genome);
    if (seenKeys.has(k)) continue;
    seenKeys.add(k);
    attackSeedEntries.push(e);
  }
  // 妨害候補: ハイウェイとして検出されている(妨害に「敵陣へ届く」ことは要求できない。
  // docs/spec.md 機能5「妨害は寿命内に敵陣に到達しない」が受け入れ条件のため)。
  const disruptSeedEntries = entries.filter((e) => e.meta.highway.trajectoryPeriodic);
  const attackSigs = new Set(attackSeedEntries.map((e) => highwaySignatureKey(e.meta.highway)));
  log(
    `②完了: 攻撃候補(viable)=${attackSeedEntries.length}件(ハイウェイ署名${attackSigs.size}種) / ` +
      `妨害候補(highway検出)=${disruptSeedEntries.length}件`,
  );
  return {
    attackSeedEntries,
    disruptSeedEntries,
    attackSeeds: attackSeedEntries.map((e) => e.genome),
    disruptSeeds: disruptSeedEntries.map((e) => e.genome),
  };
}

// ---------------------------------------------------------------------------
// ③④ 第2アーカイブ(攻撃/妨害)+ 共進化(バッチ並列)
// ---------------------------------------------------------------------------
async function coevolve(pool, attackSeedEntries, disruptSeedEntries) {
  const archive2Attack = createArchive({
    dims: [
      { name: 'entryPositionTier', bins: C.ARCHIVE2.entryPositionBins },
      { name: 'robustnessTier', bins: C.ARCHIVE2.robustnessBins.length },
      { name: 'speedClassTier', bins: C.ARCHIVE2.speedClassBins.length },
    ],
  });
  const archive2Disrupt = createArchive({
    dims: [
      { name: 'reachTier', bins: C.ARCHIVE2.reachBins },
      { name: 'endDirTier', bins: C.DIRS.length },
    ],
  });

  // 初期プールも署名で層化して取る(一様ランダムだと最頻署名ばかり引く)。
  let attackPool = dedupeGenomes(stratifyBySignature(attackSeedEntries, PARAMS.attackPoolSize).genomes);
  let disruptPool = dedupeGenomes(stratifyBySignature(disruptSeedEntries, PARAMS.disruptPoolSize).genomes);
  const attackSeeds = attackSeedEntries.map((e) => e.genome);
  const disruptSeeds = disruptSeedEntries.map((e) => e.genome);
  log(`③開始: 初期プール 攻撃${attackPool.length}件・妨害${disruptPool.length}件から共進化`);

  /**
   * 攻撃側 genome の一括評価。
   * 1個体あたり (妨害サンプル × deltaX グリッド × 間引きタイミング) 回の相互作用
   * シミュレーションが要るので、必ずワーカーに投げる。
   */
  async function evaluateAttacks(genomes, currentDisruptPool) {
    if (genomes.length === 0) return [];
    const disruptSample = sampleGenomes(currentDisruptPool, PARAMS.coevoDisruptSample).map((g) =>
      toRelativeTemplate(g, 'disrupt'),
    );
    const projections = await pool.runBatch(
      'evaluate',
      genomes.map((g) => ({ genome: g })),
    );
    const counters = await pool.runBatch(
      'countCounters',
      genomes.map((g) => ({
        attack: toRelativeTemplate(g, 'attack'),
        disrupts: disruptSample,
        deltaXs: COEVO_DELTA_XS,
        timings: COEVO_TIMINGS,
      })),
    );
    const out = [];
    for (let i = 0; i < genomes.length; i++) {
      evalCount++;
      const p = projections[i];
      if (!p.viable) {
        out.push(null);
        continue;
      }
      const robustness = counters[i].total > 0 ? 1 - counters[i].stopped / counters[i].total : 1;
      const vy = p.highway.period > 0 ? Math.abs(p.highway.driftY) / p.highway.period : 0;
      out.push({
        descriptor: {
          entryPositionTier: entryPositionTierOf(p.game.entryXAt0),
          robustnessTier: robustnessTierOf(robustness),
          speedClassTier: speedClassTierOf(vy),
        },
        quality: p.quality,
        meta: { robustness, counterCount: counters[i].stopped },
      });
    }
    return out;
  }

  /** 妨害側 genome の一括評価(quality = 現在の攻撃プールに対する coverage)。 */
  async function evaluateDisrupts(genomes, currentAttackPool) {
    if (genomes.length === 0) return [];
    const attackSample = sampleGenomes(currentAttackPool, PARAMS.coevoDisruptSample).map((g) =>
      toRelativeTemplate(g, 'attack'),
    );
    const profiles = await pool.runBatch(
      'disruptProfile',
      genomes.map((g) => ({ genome: g })),
    );
    const coverages = await pool.runBatch(
      'coverage',
      genomes.map((g) => ({
        disrupt: toRelativeTemplate(g, 'disrupt'),
        attacks: attackSample,
        deltaXs: COEVO_DELTA_XS,
        timings: COEVO_TIMINGS,
      })),
    );
    const out = [];
    for (let i = 0; i < genomes.length; i++) {
      evalCount++;
      const coverage = coverages[i].total > 0 ? coverages[i].covered / coverages[i].total : 0;
      out.push({
        descriptor: { reachTier: reachTierOf(profiles[i].reachRows), endDirTier: profiles[i].endDir },
        quality: coverage,
        meta: { coverage, reachRows: profiles[i].reachRows },
      });
    }
    return out;
  }

  /** バッチ並列の MAP-Elites ループ(親を選ぶ→変異→並列評価→添字順に挿入)。 */
  async function runBatchedMapElites(archive, genomes, evaluateFn, iterations, label) {
    // 種を挿入
    const seedResults = await evaluateFn(genomes);
    for (let i = 0; i < genomes.length; i++) {
      if (seedResults[i]) tryInsert(archive, { genome: genomes[i], ...seedResults[i] });
    }
    const BATCH = COEVO_BATCH;
    for (let done = 0; done < iterations; done += BATCH) {
      const children = [];
      for (let i = 0; i < BATCH && done + i < iterations; i++) {
        const parent = sampleParent(archive, rng);
        if (!parent) break;
        children.push(mutate(parent.genome, rng));
      }
      if (children.length === 0) break;
      const results = await evaluateFn(children);
      for (let i = 0; i < children.length; i++) {
        if (results[i]) tryInsert(archive, { genome: children[i], ...results[i] });
      }
    }
    const stats = archiveStats(archive);
    log(`  ${label}archive: filled=${stats.filled} qualityMax=${stats.qualityMax.toFixed(2)}`);
  }

  for (let round = 1; round <= PARAMS.coevoRounds; round++) {
    log(`--- 共進化ラウンド ${round}/${PARAMS.coevoRounds} ---`);

    const disruptPoolAtRound = disruptPool;
    await runBatchedMapElites(
      archive2Attack,
      attackPool,
      (gs) => evaluateAttacks(gs, disruptPoolAtRound),
      PARAMS.coevoAttackIters,
      '攻撃',
    );
    attackPool = finalizePool(archiveEntries(archive2Attack).map((e) => e.genome), attackSeeds, PARAMS.attackPoolSize);

    const robustnessValues = archiveEntries(archive2Attack).map((e) => e.meta.robustness);
    const meanRobustness = robustnessValues.length
      ? robustnessValues.reduce((s, v) => s + v, 0) / robustnessValues.length
      : NaN;
    log(`  robustness評価: 攻撃アーカイブ${robustnessValues.length}件の平均robustness=${meanRobustness.toFixed(3)}`);

    const attackPoolAtRound = attackPool;
    await runBatchedMapElites(
      archive2Disrupt,
      disruptPool,
      (gs) => evaluateDisrupts(gs, attackPoolAtRound),
      PARAMS.coevoDisruptIters,
      '妨害',
    );
    disruptPool = finalizePool(
      archiveEntries(archive2Disrupt).map((e) => e.genome),
      disruptSeeds,
      PARAMS.disruptPoolSize,
    );

    log(`  ラウンド${round}完了: 攻撃プール${attackPool.length}件・妨害プール${disruptPool.length}件 累計評価${evalCount.toLocaleString()}回`);
  }

  return { archive2Attack, archive2Disrupt, attackPool, disruptPool };
}

// ---------------------------------------------------------------------------
// ④.5 厳密確認(fingerprintVerified)ゲート
// ---------------------------------------------------------------------------
async function filterFingerprintVerified(pool, genomes, label) {
  if (genomes.length === 0) return [];
  const results = await pool.runBatch(
    'evaluate',
    genomes.map((g) => ({ genome: g, strict: true })),
  );
  const kept = genomes.filter((_, i) => results[i].highway.fingerprintVerified);
  evalCount += genomes.length;
  log(`  厳密検証(fingerprintVerified)ゲート: ${label} ${genomes.length}件 → ${kept.length}件`);
  // 探索本体は strict を実行しない(重すぎる)ので、レポートの fingerprintVerifiedCount は
  // このゲートの実測で上書きする。そうしないと「常に0」という誤解を招く値が残る。
  gateStats.checked += genomes.length;
  gateStats.verified += kept.length;
  return kept;
}

/** ④.5 の厳密検証ゲートの実測(レポートの fingerprintVerifiedCount をこれで上書きする)。 */
const gateStats = { checked: 0, verified: 0 };

// ---------------------------------------------------------------------------
// ⑤ 9×9 選抜(貪欲法+局所探索)。カウンター行列は deltaX を全列掃引する。
// ---------------------------------------------------------------------------
async function selectNineByNine(pool, attackPool, disruptPool) {
  const NA = attackPool.length;
  const ND = disruptPool.length;
  const totalSims = NA * ND * SELECT_DELTA_XS.length * C.FIRE_TIMINGS.length;
  log(
    `⑤開始: 候補${NA}攻撃 × ${ND}妨害 × deltaX${SELECT_DELTA_XS.length}点(${SELECT_DELTA_X_STRIDE}列刻み) × タイミング${C.FIRE_TIMINGS.length} ` +
      `= ${totalSims.toLocaleString()}回のカウンター行列を計算`,
  );

  if (NA < C.TEMPLATE_COUNT_ATTACK || ND < C.TEMPLATE_COUNT_DISRUPT) {
    log(`  候補数が9件に満たない(攻撃${NA}/妨害${ND})ため選抜不能`);
    return { ok: false };
  }

  const disruptTemplates = disruptPool.map((g) => toRelativeTemplate(g, 'disrupt'));
  const rows = await pool.runBatch(
    'counterRow',
    attackPool.map((g) => ({
      attack: toRelativeTemplate(g, 'attack'),
      disrupts: disruptTemplates,
      deltaXs: [...SELECT_DELTA_XS],
      timings: [...C.FIRE_TIMINGS],
    })),
    (done, total) => {
      if (done % 4 === 0 || done === total) log(`  行列計算 ${done}/${total} 行`);
    },
  );
  evalCount += totalSims;
  // hits[a][d] = その妨害が攻撃 a を止めた (deltaX, fireAtStep) の一覧
  const hits = rows.map((r) => r.hits);
  // M[a][d] = 止めた (deltaX, タイミング) の組の数
  const M = hits.map((row) => row.map((cell) => cell.length));
  log(`  行列計算完了`);

  // 多様性判定用の情報(ハイウェイ署名・実効色数)をまとめて取る。
  const projections = await pool.runBatch(
    'evaluate',
    attackPool.map((g) => ({ genome: g })),
  );
  const attackHighwaySig = projections.map((p) => highwaySignatureKey(p.highway));
  // 実効色数は「実際に踏んだ状態の種類数」。rule.length で多様性を測ってはいけない(§8)。
  // 近似として、ハイウェイ署名が同じでもルールの原始形が違えば別クラスとみなす。
  const attackRuleKey = attackPool.map((g) => g.rule);

  function evaluate(ai, di) {
    const sub = ai.map((a) => di.map((d) => M[a][d]));
    const pa = sub.map((row) => row.filter((v) => v > 0).length);
    const pd = di.map((_, j) => sub.reduce((s, row) => s + (row[j] > 0 ? 1 : 0), 0));
    const zeroA = pa.filter((v) => v === 0).length;
    const zeroD = pd.filter((v) => v === 0).length;
    // ⚠️ v5: 識別キーは "antY,antDir"(発射列 antX が可変になったため)。
    const idSet = new Set(ai.map((a) => identityKey(attackPool[a])));
    const cellsOk = ai.every((a) => attackPool[a].cells.length >= C.MIN_TEMPLATE_CELLS);

    let score = 0;
    score -= 100000 * zeroA; // 必須: カウンター無し攻撃は0件
    score -= 100000 * zeroD; // 必須: 死に札は0件
    score -= 100000 * (C.TEMPLATE_COUNT_ATTACK - idSet.size); // 必須: (antY,antDir) がすべて異なる
    score -= 100000 * (cellsOk ? 0 : 1);
    score -= pa.reduce((s, v) => s + Math.max(0, 2 - v) + Math.max(0, v - 4), 0) * 10;
    score -= pd.reduce((s, v) => s + Math.max(0, 2 - v) + Math.max(0, v - 4), 0) * 10;
    const costSet = new Set(ai.map((a) => C.ATTACK_COST + attackPool[a].cells.length));
    score += costSet.size * 5;
    const hwSigSet = new Set(ai.map((a) => attackHighwaySig[a]));
    const ruleSet = new Set(ai.map((a) => attackRuleKey[a]));
    score += hwSigSet.size * 8;
    score += ruleSet.size * 8;

    return { score, pa, pd, zeroA, zeroD, idSet, hwSigSet, ruleSet, costSet };
  }

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
    finalEval.idSet.size === C.TEMPLATE_COUNT_ATTACK &&
    ai.every((a) => attackPool[a].cells.length >= C.MIN_TEMPLATE_CELLS) &&
    di.every((d) => disruptPool[d].cells.length >= C.MIN_TEMPLATE_CELLS);
  log(
    `⑤完了: score=${finalEval.score} カウンター無し攻撃=${finalEval.zeroA} 死に札=${finalEval.zeroD} ` +
      `識別可能=${finalEval.idSet.size}/9 ハイウェイ署名多様性=${finalEval.hwSigSet.size}種 ` +
      `ルール多様性=${finalEval.ruleSet.size}種 コスト多様性=${finalEval.costSet.size}種 必須条件=${ok ? 'OK' : 'NG'}`,
  );
  return { ai, di, M, hits, ok, report: finalEval, projections };
}

// ---------------------------------------------------------------------------
// counterTable の間引き
// ---------------------------------------------------------------------------
/** (攻撃, 妨害) の組ごとに残すカウンター候補の上限。 */
const COUNTER_ENTRIES_PER_PAIR = 4;
/** 残す候補どうしの deltaX の最小間隔。近い列ばかり残しても迎撃の選択肢が増えない。 */
const COUNTER_DELTA_X_SPACING = 16;

/**
 * カウンター表を (攻撃, 妨害) の組ごとに上限件数へ間引く。
 *
 * 発射列が可変になったので、全掃引すると1つの攻撃に対して最大
 * 9妨害 × 256列 × 13タイミング = 29,952件 のエントリが出る。そのままだと:
 *   - `data/templates.json` が肥大してブラウザの初回読み込みが重くなる
 *   - `buildEscortTable` が「止められたタイミングごとに護衛を総当たり」する構造なので、
 *     エントリ数 × 護衛候補 × 護衛の列 × タイミング で組合せ爆発する(実測で終わらなかった)
 *
 * CPU が使うのは「実際に止められる少数の (列, タイミング)」で十分で、しかも
 * **deltaX が近いものを何本も持っても迎撃の選択肢は増えない**(同じ場所に撃つのと同じ)。
 * そこで deltaX が COUNTER_DELTA_X_SPACING 以上離れたものを優先して選ぶ。
 * 並べ替えは successRate 降順 → deltaX 昇順 → fireAtStep 昇順で、乱数を使わず決定論的。
 */
function trimCounterTable(counterTable) {
  const out = {};
  for (const [attackId, entries] of Object.entries(counterTable)) {
    const byDisrupt = new Map();
    for (const e of entries) {
      if (!byDisrupt.has(e.disruptId)) byDisrupt.set(e.disruptId, []);
      byDisrupt.get(e.disruptId).push(e);
    }
    const kept = [];
    for (const [, list] of byDisrupt) {
      list.sort(
        (a, b) => (b.successRate ?? 0) - (a.successRate ?? 0) || a.deltaX - b.deltaX || a.fireAtStep - b.fireAtStep,
      );
      const picked = [];
      // まず deltaX が十分離れたものを拾う
      for (const e of list) {
        if (picked.length >= COUNTER_ENTRIES_PER_PAIR) break;
        const far = picked.every((p) => {
          const d = Math.abs(p.deltaX - e.deltaX);
          return Math.min(d, C.WIDTH - d) >= COUNTER_DELTA_X_SPACING;
        });
        if (far) picked.push(e);
      }
      // 足りなければ残りを順に埋める
      for (const e of list) {
        if (picked.length >= COUNTER_ENTRIES_PER_PAIR) break;
        if (!picked.includes(e)) picked.push(e);
      }
      kept.push(...picked);
    }
    out[attackId] = kept;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 出力の組み立て
// ---------------------------------------------------------------------------
async function buildOutput(pool, attackPool, disruptPool, ai, di) {
  log('最終テーブル計算開始(選抜した9×9のみ・deltaX 全列掃引)');

  const attacks = ai.map((idx, i) => {
    const g = cloneGenome(attackPool[idx]);
    g.id = `A${i + 1}`;
    return g;
  });
  const disrupts = di.map((idx, i) => {
    const g = cloneGenome(disruptPool[idx]);
    g.id = `D${i + 1}`;
    return g;
  });

  const attackTpls = attacks.map((g) => ({ ...toRelativeTemplate(g, 'attack'), id: g.id }));
  const disruptTpls = disrupts.map((g) => ({ ...toRelativeTemplate(g, 'disrupt'), id: g.id }));

  const {
    matrix,
    counterTable: fullCounterTable,
    attacksWithoutCounter,
    disruptsWithoutCoverage,
    counterDensity,
  } = buildCounterMatrix(attackTpls, disruptTpls, { deltaXs: FULL_DELTA_XS });
  const rawEntryCount = Object.values(fullCounterTable).reduce((s, v) => s + v.length, 0);
  const counterTable = trimCounterTable(fullCounterTable);
  const trimmedEntryCount = Object.values(counterTable).reduce((s, v) => s + v.length, 0);
  log(`  counterTable の間引き: ${rawEntryCount.toLocaleString()}件 → ${trimmedEntryCount.toLocaleString()}件`);

  const escortTable = buildEscortTable(attackTpls, disruptTpls, counterTable, {
    escortDeltaXs: FULL_DELTA_XS.filter((_, i) => i % C.COEVO_DELTA_X_STRIDE === 0),
  });

  // 識別表: v5 で発射列が可変になったのでキーは "antY,antDir"。
  const identifyTable = {};
  attacks.forEach((a) => {
    identifyTable[identityKey(a)] = a.id;
  });

  const projections = await pool.runBatch(
    'evaluate',
    attacks.map((g) => ({ genome: g, strict: true })),
  );

  const attackOut = attacks.map((g, i) => {
    const p = projections[i];
    const cost = costOfGenome(g, C.ATTACK_COST);
    return {
      id: g.id,
      kind: 'attack',
      rule: g.rule,
      colorCount: g.rule.length,
      cells: toTemplateCells(g), // [dx, dy, state](アリからの相対)
      antY: g.antY,
      antDir: g.antDir,
      cost,
      arrivalStep: p.game.arrivalStep,
      // entryXAt0: 発射列0で撃ったときの到達列。実際の到達列は (antX + entryXAt0) % WIDTH。
      entryXAt0: p.game.entryXAt0,
      robustness: 1 - counterDensity[i],
      costTier: cost,
      featureTier: entryPositionTierOf(p.game.entryXAt0),
      highway: p.highway,
    };
  });

  log('--- 選抜した攻撃9種の多様性レポート(§8) ---');
  const counterCounts = attacks.map((_, i) =>
    matrix[i].reduce((s, byDelta) => s + byDelta.reduce((s2, cell) => s2 + cell.filter((sc) => !sc).length, 0), 0),
  );
  attacks.forEach((g, i) => {
    const hw = attackOut[i].highway;
    log(
      `  ${g.id} rule=${g.rule} 色数=${g.rule.length} ` +
        `署名=(period=${hw.period}, drift=(${hw.driftX},${hw.driftY}), formation=${hw.formationStep}) ` +
        `発射=(antY=${g.antY}, dir=${g.antDir}) cost=${attackOut[i].cost} ` +
        `到達=${attackOut[i].arrivalStep}step counter=${counterCounts[i]}通り origin=${g.origin ?? 'random'}`,
    );
  });

  const disruptProfiles = await pool.runBatch(
    'disruptProfile',
    disrupts.map((g) => ({ genome: g })),
  );
  const disruptOut = disrupts.map((g, j) => {
    const cost = costOfGenome(g, C.DISRUPT_COST);
    const coveredCount = attacks.filter((_, i) =>
      matrix[i][j].some((byDelta) => byDelta.some((scored) => !scored)),
    ).length;
    return {
      id: g.id,
      kind: 'disrupt',
      rule: g.rule,
      colorCount: g.rule.length,
      cells: toTemplateCells(g),
      antY: g.antY,
      antDir: g.antDir,
      cost,
      reachRows: disruptProfiles[j].reachRows,
      endDirection: disruptProfiles[j].endDir,
      coverage: attacks.length > 0 ? coveredCount / attacks.length : 0,
      costTier: cost,
      featureTier: reachTierOf(disruptProfiles[j].reachRows),
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
// パイプライン全体
// ---------------------------------------------------------------------------
/**
 * アーカイブの viable を現在の ATTACK_LIFE で計算し直す。
 * meta.game.arrivalStep は GAME_LIFE_SEARCH_CAP まで走らせた実測なので、
 * 閾値を当て直すだけで別の寿命に対する viable が復元できる(再シミュレーション不要)。
 * 新規探索時は evaluateProjectile が同じ判定をしているので実質 no-op。
 */
function reprojectViability(archive1) {
  let changed = 0;
  for (const e of archiveEntries(archive1)) {
    const arrival = e.meta?.game?.arrivalStep;
    const viable = arrival != null && arrival <= C.ATTACK_LIFE;
    if (e.meta.viable !== viable) changed++;
    e.meta.viable = viable;
  }
  if (changed > 0) log(`  ATTACK_LIFE=${C.ATTACK_LIFE} で viable を再射影: ${changed}件の判定が変わった`);
}

async function runPipeline(pool, sampler) {
  const viableCollector = createViableCollector(VIABLE_PER_SIGNATURE);
  let archive1;
  let distillStats = null;
  let iterations = 0;
  if (RESUME_ARCHIVE) {
    log(`①スキップ: 既存アーカイブを読み込む ${RESUME_ARCHIVE}`);
    const saved = JSON.parse(readFileSync(RESUME_ARCHIVE, 'utf8'));
    archive1 = archiveFromJSON(saved.archive1);
    distillStats = saved.distillStats ?? null;
    iterations = saved.archive1Iterations ?? 0;
    const stats = archiveStats(archive1);
    log(`  読み込み完了: filled=${stats.filled}/${stats.total} (元の反復回数 ${iterations})`);
  } else {
    const built = await buildHighwayArchive(pool, sampler, viableCollector);
    archive1 = built.archive1;
    distillStats = built.distillStats;
    iterations = built.iterations;
  }
  reprojectViability(archive1);
  const { attackSeedEntries, disruptSeedEntries, attackSeeds, disruptSeeds } = projectCandidates(archive1, viableCollector);
  if (attackSeeds.length < C.TEMPLATE_COUNT_ATTACK || disruptSeeds.length < C.TEMPLATE_COUNT_DISRUPT) {
    throw new Error(`②の候補数が不足(攻撃${attackSeeds.length}/妨害${disruptSeeds.length})。探索予算を増やすこと`);
  }

  const { archive2Attack, archive2Disrupt, attackPool, disruptPool } = await coevolve(pool, attackSeedEntries, disruptSeedEntries);

  // ④.5: 共進化で淘汰された弾も拾うため、②の viable プールを合流させてからゲートする。
  // ⚠️ 上限(selectionAttackCap)で打ち切る。全件持ち込むと段階⑤のカウンター行列が
  //   (候補数)^2 × deltaX × タイミング で数百万回になり、選抜が探索本体より長くなる。
  //   共進化アーカイブの生存者を先に入れ、残りを②の viable プールで埋める(finalizePool)。
  // ⚠️ 補填する種は**ハイウェイ署名で層化してから**取る(stratifyBySignature のコメント参照)。
  // 素朴に先頭から取るとアーカイブの充填順=ありふれた署名順になり、選抜プールの多様性が死ぬ。
  const attackFill = stratifyBySignature(attackSeedEntries, PARAMS.selectionAttackCap);
  const disruptFill = stratifyBySignature(disruptSeedEntries, PARAMS.selectionDisruptCap);
  const candidateAttackPool = finalizePool(attackPool, attackFill.genomes, PARAMS.selectionAttackCap);
  const candidateDisruptPool = finalizePool(disruptPool, disruptFill.genomes, PARAMS.selectionDisruptCap);
  log(
    `④.5開始: 選抜候補に持ち込む上限 攻撃${PARAMS.selectionAttackCap}件/妨害${PARAMS.selectionDisruptCap}件 ` +
      `(実際 攻撃${candidateAttackPool.length}件・妨害${candidateDisruptPool.length}件。` +
      `②の viable ${attackSeeds.length}件を署名${attackFill.groupCount}種に層化して補填した)`,
  );
  const verifiedAttackPool = await filterFingerprintVerified(pool, candidateAttackPool, '攻撃プール');
  const verifiedDisruptPool = await filterFingerprintVerified(pool, candidateDisruptPool, '妨害プール');

  const selection = await selectNineByNine(pool, verifiedAttackPool, verifiedDisruptPool);
  if (!selection.ok) {
    log('⚠️ ⑤の必須条件を満たさなかった。選抜結果はそのまま書き出すが、docs/spec.md 未決定事項に記録すること');
  }
  const output = await buildOutput(pool, verifiedAttackPool, verifiedDisruptPool, selection.ai, selection.di);
  return { output, archive1, archive2Attack, archive2Disrupt, distillStats, iterations, selectionOk: selection.ok };
}

// ---------------------------------------------------------------------------
// メイン
// ---------------------------------------------------------------------------
async function main() {
  log(`generate-templates 開始 (seed=${SEED}, quick=${QUICK}, workers=${WORKERS}, budget=${BUDGET_MIN}分)`);
  const pool = createPool(WORKERS);
  const sampler = createReportSampler(REPORT_SAMPLE_CAP);
  try {
    const { output, archive1, archive2Attack, archive2Disrupt, distillStats, iterations, selectionOk } = await runPipeline(
      pool,
      sampler,
    );

    const generatedAt = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;

    const templatesOutput = {
      generatedAt,
      schemaVersion: 5,
      config: {
        width: C.WIDTH,
        height: C.HEIGHT,
        zoneDepth: C.ZONE_DEPTH,
        scoreGateXMin: C.SCORE_GATE_X_MIN,
        scoreGateXMax: C.SCORE_GATE_X_MAX,
        minColors: C.MIN_COLORS,
        maxColors: C.MAX_COLORS,
        searchLife: C.SEARCH_LIFE,
        gameProjectileLife: C.ATTACK_LIFE,
        attackCost: C.ATTACK_COST,
        attackLife: C.ATTACK_LIFE,
        disruptCost: C.DISRUPT_COST,
        disruptLife: C.DISRUPT_LIFE,
        maxCells: C.MAX_CELLS,
        templateCellRadius: C.TEMPLATE_CELL_RADIUS,
      },
      attack: output.attackOut,
      disrupt: output.disruptOut,
      identifyTable: output.identifyTable,
      counterTable: output.counterTable,
      escortTable: output.escortTable,
    };

    const report = buildSearchReport(sampler.records, { totalEvaluations: evalCount });
    // 探索中は strict 検証を走らせない(数百万回には重すぎる)ので、サンプルから数えた
    // fingerprintVerifiedCount は常に0になる。実際の検証は段階④.5 のゲートで行うので、
    // その実測値で置き換える(0 のまま出すと「厳密検証が1件も通らなかった」と誤読される)。
    report.fingerprintVerifiedCount = gateStats.verified;
    report.fingerprintCheckedCount = gateStats.checked;
    console.error(formatSearchReport(report));

    const archiveOutput = {
      seed: SEED,
      quick: QUICK,
      workers: WORKERS,
      budgetMin: BUDGET_MIN,
      // ⚠️ 実時間予算で打ち切ったときの再現用。この値を --iterations に渡すと同じ成果物になる。
      archive1Iterations: iterations,
      reproduceCommand: `node scripts/generate-templates.mjs --seed ${SEED} --iterations ${iterations}`,
      rounds: PARAMS.coevoRounds,
      evaluations: evalCount,
      generatedAt,
      selectionOk,
      distillStats,
      archive1: archiveToJSON(archive1),
      archive2Attack: archiveToJSON(archive2Attack),
      archive2Disrupt: archiveToJSON(archive2Disrupt),
    };

    mkdirSync(path.dirname(TEMPLATES_OUT_PATH), { recursive: true });
    writeFileSync(TEMPLATES_OUT_PATH, JSON.stringify(templatesOutput, null, 2) + '\n', 'utf8');
    writeFileSync(ARCHIVE_OUT_PATH, JSON.stringify(archiveOutput, null, 2) + '\n', 'utf8');
    writeFileSync(
      REPORT_OUT_PATH,
      JSON.stringify({ generatedAt, seed: SEED, sampledRecords: sampler.records.length, sampleStride: sampler.stride, report }, null, 2) + '\n',
      'utf8',
    );
    log(`書き出し完了: ${TEMPLATES_OUT_PATH}`);
    log(`書き出し完了: ${ARCHIVE_OUT_PATH}`);
    log(`書き出し完了: ${REPORT_OUT_PATH}`);
    log(`累計評価回数 ${evalCount.toLocaleString()} 回 / 合計所要時間 ${(elapsedSec() / 60).toFixed(1)}分`);
  } finally {
    await pool.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
