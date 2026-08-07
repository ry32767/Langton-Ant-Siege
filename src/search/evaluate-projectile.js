// genome 1件を MAP-Elites 用の記述子(descriptor)・品質(quality)・viable に落とす評価器。
// DOM に依存しない純粋な ESM。数値定数は src/config.js から取り、直書きしない
// (AGENTS.md「コーディング規約」)。
//
// ゲーム評価(実ゲーム条件でのシミュレーション)は必ず src/engine.js の simulateSolo を
// 使う(engine が唯一の正。AGENTS.md「エンジンの参照実装」)。
//
// 探索評価(ハイウェイ探索)は simulateSolo ではなく simulateSearch を使う。実ゲーム盤面
// (HEIGHT=120)は上下端でアリが死ぬため SEARCH_LIFE(=20,000)まで届かない(実測到達率
// 11.6%)。simulateSearch は上下端のない仮想盤面(C.SEARCH_BOARD_HEIGHT)で走らせ、
// 探索評価とゲーム評価を分離する(差分仕様 §7)。
//
// highway は2段構え(§8/§9、docs/spec.md 第8章)。単一の boolean にすると高速フィルタの
// 近似が最終選抜まで素通りしてしまうため:
//   trajectoryPeriodic = detectHighwayFromPath による高速フィルタ(位置+向きの周期性)。
//     MAP-Elites 探索中(アーカイブ挿入・descriptor・quality)はこちらだけを使う。
//   fingerprintVerified = verifyHighwayStrict による厳密確認(近傍セル fingerprint)。
//     最終テンプレート選抜(9×9)のゲートに使う。options.strict===true のときだけ実行する。

import * as C from '../config.js';
import { simulateSolo, simulateSearch } from '../engine.js';
import { toTemplateCells, costOfGenome } from './genome.js';
import { detectHighwayFromPath, directionBin, verifyHighwayStrict } from './highway-detector.js';

/**
 * simulateSearch の trackPath 出力([x,y] のみ・x はトーラス巻き戻し済み・y は仮想盤面の
 * 素の座標)から、detectHighwayFromPath が要求する [x,y,dir] の絶対座標軌跡を作る。
 * y は simulateSearch の時点で既にラップしていないので補正しない。x だけトーラスの
 * 巻き戻しを行う。dir(i) は「position i から position i+1 への移動に使われた向き」。
 * 末尾は次の移動が存在しないため null にする(detectHighwayFromPath はそれを許容する)。
 */
function toUnwrappedSearchPath(rawPath) {
  const n = rawPath.length;
  const ux = new Array(n);
  ux[0] = rawPath[0][0];
  for (let i = 1; i < n; i++) {
    let dx = rawPath[i][0] - rawPath[i - 1][0];
    if (dx > C.WIDTH / 2) dx -= C.WIDTH;
    else if (dx < -C.WIDTH / 2) dx += C.WIDTH;
    ux[i] = ux[i - 1] + dx;
  }
  const path = [];
  for (let i = 0; i < n; i++) {
    const y = rawPath[i][1];
    const dir = i < n - 1 ? dirFromDelta(ux[i + 1] - ux[i], rawPath[i + 1][1] - y) : null;
    path.push([ux[i], y, dir]);
  }
  return path;
}

function dirFromDelta(dx, dy) {
  for (let d = 0; d < 4; d++) {
    if (C.DIRS[d][0] === dx && C.DIRS[d][1] === dy) return d;
  }
  return null;
}

/** genome を simulateSolo に渡せる template 形へ変換する。 */
function toTemplate(genome) {
  return {
    cells: toTemplateCells(genome),
    antX: genome.antX,
    antY: genome.antY,
    antDir: genome.antDir,
    rule: genome.rule,
  };
}

/** speedBin: 0.0..1.0 を C.ARCHIVE1.speedBins 個に等分する(超過分は最終ビンに丸める)。 */
function speedBinOf(speed) {
  const bins = C.ARCHIVE1.speedBins;
  const clamped = Math.max(0, Math.min(1, speed));
  return Math.min(bins - 1, Math.floor(clamped * bins));
}

/** formationBin: C.ARCHIVE1.formationBins の境界で対数的にビン分けする(区分は config 由来)。 */
function formationBinOf(formationStep) {
  const bounds = C.ARCHIVE1.formationBins;
  for (let i = 0; i < bounds.length; i++) {
    if (formationStep <= bounds[i]) return i;
  }
  return bounds.length - 1;
}

// ---- quality の内部正規化スケール ------------------------------------------
// ゲームバランスの数値ではなく、quality を0..1に正規化するための実装内部のスケール
// なので config.js には出さない(AGENTS.md の「数値をソースに直書きしない」は
// ゲームバランス・ルールに関わる数値が対象。これは検出アルゴリズムの解像度と同種の値)。
const STABILITY_CYCLES_CAP = 20; // これ以上の連続一致周期数は「安定」として頭打ちにする

/**
 * genome 1件を評価し、MAP-Elites 用の descriptor・quality・viable を返す。
 * 決定論的(同じ genome を2回渡すと完全に同じ結果になる)。
 *
 * @param {object} genome
 * @param {{strict?: boolean}} [options]
 *   options.strict=true のときだけ verifyHighwayStrict による厳密確認を実行し
 *   highway.fingerprintVerified を埋める(既定 false。数百万回呼ばれる探索経路では
 *   厳密確認は実行しない。最終テンプレート選抜(9×9)の直前でのみ true にする)。
 */
export function evaluateProjectile(genome, options = {}) {
  const template = toTemplate(genome);

  // ---- 探索評価: SEARCH_LIFE ステップの軌跡からハイウェイを検出する ----
  // 上下端のない仮想盤面(simulateSearch)で走らせる。実ゲーム盤面の simulateSolo だと
  // 上下端でアリが死に SEARCH_LIFE に届かないため(このファイル冒頭のコメント参照)。
  const searchLife = options.searchLife ?? C.SEARCH_LIFE;
  const searchRun = simulateSearch(template, { life: searchLife, trackPath: true });
  const searchPath = toUnwrappedSearchPath(searchRun.path);
  const hw = detectHighwayFromPath(searchPath, options.detectorOptions);

  // highway は2段構え(タスク仕様。highway-detector.js 冒頭コメント参照):
  //   trajectoryPeriodic = 高速フィルタ(detectHighwayFromPath)を通ったか。
  //     MAP-Elites 探索中(アーカイブ挿入・記述子計算・quality)はこちらだけを使う。
  //   fingerprintVerified = 厳密確認(verifyHighwayStrict)を通ったか。
  //     最終テンプレート選抜(9×9)で使う。既定では実行しない(数百万回呼ばれるため重すぎる)。
  //     options.strict===true のときだけ実行して埋める。
  const strict = options.strict === true;
  const fingerprintVerified = hw != null && strict ? verifyHighwayStrict(genome, hw, options.strictOptions) : false;

  const highway = hw
    ? {
        trajectoryPeriodic: true,
        fingerprintVerified,
        formationStep: hw.formationStep,
        period: hw.period,
        driftX: hw.driftX,
        driftY: hw.driftY,
        speed: hw.speed,
        verifiedCycles: hw.verifiedCycles,
      }
    : {
        trajectoryPeriodic: false,
        fingerprintVerified: false,
        formationStep: null,
        period: null,
        driftX: null,
        driftY: null,
        speed: null,
        verifiedCycles: null,
      };

  // ---- ゲーム評価: 実ゲーム条件(60x120・左右ラップ・上下場外・SCORE_LINE_Yで得点) ----
  // simulateSolo 自体が既にこの規則を実装しているので、そのまま呼ぶだけでよい。
  const gameLife = options.gameLife ?? C.ATTACK_LIFE;
  const gameRun = simulateSolo(template, { life: gameLife });
  const game = {
    scored: gameRun.scored,
    steps: gameRun.steps,
    entryX: gameRun.scored ? gameRun.endX : null,
  };

  // ---- descriptor(MAP-Elites 探索中の評価。trajectoryPeriodic を使う) ----
  const direction = highway.trajectoryPeriodic ? directionBin(highway.driftX, highway.driftY) : null;
  const speedBin = highway.trajectoryPeriodic ? speedBinOf(highway.speed) : null;
  const formationBin = highway.trajectoryPeriodic ? formationBinOf(highway.formationStep) : null;
  const cost = costOfGenome(genome, C.ATTACK_COST);
  const descriptor = { direction, speedBin, formationBin, cost };

  // ---- quality(§12。「最速」を最大化しない。探索中の評価なので trajectoryPeriodic を使う) ----
  // stability: 検証周期数の寄与(多いほど安定)。STABILITY_CYCLES_CAP で頭打ちにして0..1化。
  const stabilityNorm = highway.trajectoryPeriodic ? Math.min(1, highway.verifiedCycles / STABILITY_CYCLES_CAP) : 0;
  // verticality: 目的方向(上下)への直進性。並進のうち縦方向成分の割合(cosine)。
  const verticalityNorm = highway.trajectoryPeriodic
    ? Math.abs(highway.driftY) / Math.sqrt(highway.driftX * highway.driftX + highway.driftY * highway.driftY)
    : 0;
  // usability: ゲーム寿命内で得られる変位。開始位置から到達した y までの距離を、
  // 得点ラインまでの必要距離で正規化する(得点すれば1.0に張り付く)。
  const neededDistance = C.SCORE_LINE_Y - genome.antY;
  const usabilityNorm = neededDistance > 0 ? Math.max(0, Math.min(1, (gameRun.endY - genome.antY) / neededDistance)) : 0;
  // formationPenalty: formationStep の長さのペナルティ。未検出は最大ペナルティにする。
  // formationBins の最終手前の境界(SEARCH_LIFE の1つ前)をスケールに使う(新しい定数を増やさない)。
  const formationScale = C.ARCHIVE1.formationBins[C.ARCHIVE1.formationBins.length - 2];
  const formationPenaltyNorm = highway.trajectoryPeriodic ? Math.min(1, highway.formationStep / formationScale) : 1;

  const W = C.ARCHIVE1_QUALITY;
  const quality =
    W.stability * stabilityNorm +
    W.verticality * verticalityNorm +
    W.usability * usabilityNorm -
    W.formationPenalty * formationPenaltyNorm;

  // ---- viable(§13 のゲーム射影。⚠️ 差分仕様 §13/§28 からの意図的な変更) ----
  // 差分仕様は driftX===0 && driftY>0 を条件に含めるが、実測(検出ハイウェイ7,680件)で
  // driftX===0 は1件のみ、しかもゲーム寿命の2.7倍かかり到達不能だった。盤面は左右
  // ラップがあるため斜めハイウェイでも敵陣に到達できる(ランダム genome の1.81%が
  // 実際に得点する)。driftX/driftY は descriptor.direction として記録するだけにし、
  // viable の判定条件には入れない。
  const viable = highway.trajectoryPeriodic && game.scored && genome.cells.length >= C.MIN_TEMPLATE_CELLS;

  return { highway, game, descriptor, quality, viable };
}
