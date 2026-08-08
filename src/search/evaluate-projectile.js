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
import { simulateSolo, simulateSearch, instantiateTemplate } from '../engine.js';
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

/**
 * genome を simulateSolo / simulateSearch に渡せる template 形へ変換する。
 *
 * ⚠️ v5: genome は antX を持たない(発射列は発射時に選ぶ自由度)。評価は
 * **正準の発射列 antX=0** で行う。左右がトーラスなので x 方向の平行移動は力学の
 * 厳密な対称性で、どの列で評価しても周期・並進・形成時間・到達ステップ数は同じになる。
 * 変わるのは到達 x だけなので、それは `game.entryXAt0`(antX=0 のときの到達列)として
 * 記録し、実プレイでは `antX + entryXAt0 (mod WIDTH)` が実際の到達列になる。
 */
export const CANONICAL_ANT_X = 0;

function toTemplate(genome) {
  return instantiateTemplate(
    {
      cells: toTemplateCells(genome),
      antY: genome.antY,
      antDir: genome.antDir,
      rule: genome.rule,
    },
    CANONICAL_ANT_X,
  );
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

  // ---- ゲーム評価: 実ゲーム条件(256x256・左右ラップ・上下場外・SCORE_LINE_Yで到達) ----
  //
  // ⚠️ v5: 寿命は ATTACK_LIFE ではなく **GAME_LIFE_SEARCH_CAP** で走らせ、実際に
  // 敵陣へ到達したステップ数(arrivalStep)を記録する。こうしておくと ATTACK_LIFE を
  // 後から変えても探索をやり直さずに再射影できる(arrivalStep <= 新しい寿命 か
  // どうかを見るだけでよい。config.js の GAME_LIFE_SEARCH_CAP のコメント参照)。
  //
  // ⚠️ 到達判定は `reached`(敵陣に入ったか)であって `scored`(得点ゲートに入ったか)
  // ではない。発射列 antX は発射時に自由に選べ、左右がトーラスなので到達 x を
  // ゲート内に持ってくる antX は必ず存在する。つまりゲートはテンプレートの実力を
  // 左右せず、実プレイで「どの列から撃つか」を縛るだけ(engine.js の simulateSolo 参照)。
  const gameLife = options.gameLife ?? C.GAME_LIFE_SEARCH_CAP;
  const gameRun = simulateSolo(template, { life: gameLife });
  const arrivalStep = gameRun.reached ? gameRun.steps : null;
  const game = {
    reached: gameRun.reached,
    // arrivalStep: 敵陣に到達したステップ数。未到達なら null。
    arrivalStep,
    steps: gameRun.steps,
    // entryXAt0: 正準発射列(antX=0)で撃ったときの到達列。実プレイでの到達列は
    // (antX + entryXAt0) mod WIDTH になる。
    entryXAt0: gameRun.reached ? gameRun.endX : null,
    endY: gameRun.endY,
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
  // 得点ラインまでの必要距離で正規化する(到達すれば1.0に張り付く)。
  // ⚠️ 分子は ATTACK_LIFE ではなく GAME_LIFE_SEARCH_CAP まで走らせた結果なので、
  // ATTACK_LIFE を後から下げると quality が過大評価のまま残る。最終選抜は
  // arrivalStep <= ATTACK_LIFE で別途ふるいにかけるので、ここでは緩いままでよい。
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
  // ラップがあるため斜めハイウェイでも敵陣に到達できる。driftX/driftY は
  // descriptor.direction として記録するだけにし、viable の判定条件には入れない。
  //
  // ⚠️ v5: 「寿命内に届くか」は options.attackLife(既定 C.ATTACK_LIFE)との比較で決める。
  // シミュレーション自体は GAME_LIFE_SEARCH_CAP まで走らせてあるので、この閾値を
  // 変えるだけで別の寿命に対する viable を再計算できる(再シミュレーション不要)。
  const attackLife = options.attackLife ?? C.ATTACK_LIFE;
  const viable =
    highway.trajectoryPeriodic &&
    game.reached &&
    game.arrivalStep <= attackLife &&
    genome.cells.length >= C.MIN_TEMPLATE_CELLS;

  return { highway, game, descriptor, quality, viable };
}

// ⚠️ かつてここに isViableAtLife(保存済みの arrivalStep に閾値を当て直すだけの再射影)が
// あったが削除した。**保存済みの arrivalStep は当時の GAME_LIFE_SEARCH_CAP までしか
// 記録されておらず、キャップより長い寿命へは再射影できない**(キャップの外で到達した
// 個体が「未到達」として保存されているため)。実際に ATTACK_LIFE を 6,000 → 20,000 に
// 上げたとき、閾値の当て直しでは 311件の判定漏れが出た。
// 正しいやり方は genome を評価し直すことで、scripts/generate-templates.mjs の
// --resume-archive がそれを行う(elite は数千件なので数秒で終わる)。
