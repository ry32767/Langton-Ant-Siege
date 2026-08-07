// ハイウェイ(周期並進運動)の厳密確認(§9)。DOM に依存しない純粋な ESM。
// 高速フィルタ(highway-trajectory.js の detectHighwayFromPath)で採用された候補にだけ
// 適用する、盤面込みの高コストな再検証。
//
// engine.js は1ステップごとの盤面スナップショットを外部に公開していない(simulateSolo の
// trackPath は位置だけを記録する)ため、このモジュールは engine.js の CA ステップ規則
// (AGENTS.md「エンジンの参照実装」)を最小限だけ複製する。これは意図的な例外で、
// 本ファイルの外(evaluate-projectile.js のゲーム評価など)では engine.js の関数
// (simulateSolo / simulateSearch)を必ず使う。
//
// ⚠️ v5 の変更点:
//   - genome が antX を持たなくなり cells が相対 (dx, dy) になったのに合わせて、
//     アリは常に正準の発射列 x=0 から走らせる(左右はトーラスなので一般性を失わない)
//   - 盤面を**呼び出しごとに確保するのをやめ**、モジュールレベルのバッファを使い回す。
//     盤面が 256 列になり、maxSteps に比例した高さを毎回確保すると 10MB 級の確保が
//     数百万回走ることになるため(実測前の見積もりで破綻が確実)
//   - checkpoint で `board.slice()` を取るのをやめ、**その場で fingerprint を計算する**
//     コールバック方式にした(スナップショットの複製が同じ理由で高すぎる)

import * as C from '../config.js';

/** 盤面の1次元インデックス。engine.js の idx() と同じ規則(WIDTH*y + x)。 */
function idx(x, y) {
  return y * C.WIDTH + x;
}

// ---------------------------------------------------------------------------
// 仮想盤面バッファ(再入不可。使い回しの理由は冒頭のコメント参照)
// ---------------------------------------------------------------------------
// 高さは simulateSearch と同じ C.SEARCH_BOARD_HEIGHT。実用的なハイウェイ速度
// (最速でも 0.0556 行/ステップ)なら SEARCH_LIFE ステップで 1,100 行ほどしか動かないので、
// 中央から上下 2,048 行の余裕があれば足りる。足りずに盤外へ出た場合は
// 「検証できなかった」として false を返す(simulateSearch と同じ扱い)。
const FP_HEIGHT = C.SEARCH_BOARD_HEIGHT;
const FP_CENTER_Y = Math.floor(FP_HEIGHT / 2);
let _fpBoard = null;

function getFpBoard() {
  if (!_fpBoard) _fpBoard = new Uint8Array(C.WIDTH * FP_HEIGHT);
  return _fpBoard;
}

/**
 * 相対セル列(genome.cells)と rule / antY / antDir から、単体のアリを仮想盤面で走らせる。
 * engine.js の stepAnt() と同じ CA 規則(「回転は踏んだ時点の状態で決める」
 * 「配置マスは state で書き込む」)を複製したもの。
 *
 * @param {{rule:string, antY:number, antDir:number, cells:Array<{dx:number,dy:number,state:number}>}} genome
 * @param {number} maxSteps 走らせるステップ数の上限
 * @param {(step:number, x:number, y:number, dir:number, board:Uint8Array)=>void} [onCheckpoint]
 *   `checkpointSteps` に含まれるステップの**踏む前**に呼ばれる。盤面はこの時点の生バッファなので、
 *   保存したい場合は呼ばれた側で必要な情報だけ取り出すこと(複製はしない)。
 * @param {Set<number>} [checkpointSteps]
 * @returns {{frames: Array<{x:number,y:number,dir:number}>, outOfBoard: boolean, boardHeight: number}}
 *   frames は「踏む前」の状態(detectHighwayFromPath の path と同じ意味)。
 * ⚠️ 再入不可。戻ったあとバッファは白紙に戻してある。
 */
export function simulateWithBoard(genome, maxSteps, onCheckpoint = null, checkpointSteps = null) {
  const board = getFpBoard();
  const touched = [];
  const colorCount = genome.rule.length;
  for (const cell of genome.cells) {
    const gx = (((0 + cell.dx) % C.WIDTH) + C.WIDTH) % C.WIDTH;
    const gy = FP_CENTER_Y + genome.antY + cell.dy;
    if (gy < 0 || gy >= FP_HEIGHT) continue; // 想定上は起きない
    const j = idx(gx, gy);
    board[j] = cell.state;
    touched.push(j);
  }
  let x = 0; // 正準の発射列。左右はトーラスなので一般性を失わない
  let y = FP_CENTER_Y + genome.antY;
  let dir = genome.antDir;
  const frames = [];
  let outOfBoard = false;
  for (let step = 0; step < maxSteps; step++) {
    frames.push({ x, y, dir });
    if (y < 0 || y >= FP_HEIGHT) {
      outOfBoard = true;
      break;
    }
    if (checkpointSteps !== null && checkpointSteps.has(step) && onCheckpoint) {
      onCheckpoint(step, x, y, dir, board);
    }
    const j = idx(x, y);
    touched.push(j);
    const s = board[j] % colorCount;
    dir = genome.rule[s] === 'R' ? (dir + 1) & 3 : (dir + 3) & 3;
    board[j] = (s + 1) % colorCount;
    const d = C.DIRS[dir];
    x = (x + d[0] + C.WIDTH) % C.WIDTH;
    y = y + d[1];
  }
  for (let i = 0; i < touched.length; i++) board[touched[i]] = 0;
  return { frames, outOfBoard, boardHeight: FP_HEIGHT };
}

/**
 * アリ座標を原点とし、その時点の向きで正規化(回転)した近傍セル状態の fingerprint を作る。
 * radius は近傍の半径(実装の内部パラメータ。config.js には出さない。ゲームバランスの
 * 数値ではなく検出アルゴリズム内部の解像度のため)。
 */
export function neighborhoodFingerprint(board, x, y, dir, radius, boardHeight = FP_HEIGHT) {
  const forward = C.DIRS[dir];
  const right = C.DIRS[(dir + 1) & 3];
  const out = [];
  for (let v = -radius; v <= radius; v++) {
    for (let u = -radius; u <= radius; u++) {
      const gx = (((x + right[0] * u + forward[0] * v) % C.WIDTH) + C.WIDTH) % C.WIDTH;
      const gy = y + right[1] * u + forward[1] * v;
      out.push(gy < 0 || gy >= boardHeight ? 0 : board[idx(gx, gy)]);
    }
  }
  return out.join(',');
}

/**
 * 「形成後の近傍パターンが収束するまで待つ」周期数の上限。
 * formationStep は「位置+向きが一致し始める最小のステップ」でしかなく、近傍には
 * まだ transient の残骸が残っていることがあるので、確認済み窓の先を見る必要がある。
 * ただし verifiedCycles は 1,000 を超えることがあり(period 18 のハイウェイを 20,000 ステップ
 * 見れば当然そうなる)、そこまで進めると仮想盤面の縦幅を食い尽くす。
 * 20周期も進めば近傍パターンは十分収束しているので、ここで頭打ちにする。
 */
const SETTLE_CYCLES_CAP = 20;

/**
 * 高速フィルタで採用された候補を、盤面込みで厳密に再検証する(§9)。
 * アリ座標を原点とした近傍 fingerprint が t と t+period で HIGHWAY_MIN_CYCLES 周期分
 * 一致することを確認する。position/dir だけでなく周辺の盤面パターンまで一致するかを見るため、
 * 高速フィルタの偽陽性(たまたま位置と向きだけ一致した別パターン)をさらに除外できる。
 */
export function verifyHighwayStrict(genome, candidate, options = {}) {
  if (!candidate) return false;
  const radius = options.radius ?? 3;
  const { period, formationStep, verifiedCycles } = candidate;
  const cycles = Math.min(verifiedCycles, options.minCycles ?? C.HIGHWAY_MIN_CYCLES);

  // ⚠️ formationStep は「位置+向きが一致し始める最小のステップ」でしかない。
  // 近傍 radius マス以内には、まだ上書きされていない形成前(transient)の残骸セルが
  // 残っていることがあり、position/dir が一致していても fingerprint は formationStep
  // 直後の数周期はまだ収束しない(実測で確認済み)。そこで「高速フィルタが確認した窓」の
  // 先(ただし SETTLE_CYCLES_CAP 周期で頭打ち)から cycles 周期分を見る。
  const settleCycles = Math.min(verifiedCycles, SETTLE_CYCLES_CAP);
  const tailCycleStart = formationStep + settleCycles * period;
  const neededSteps = tailCycleStart + cycles * period + 1;
  const checkpointSteps = new Set();
  for (let c = 0; c < cycles; c++) checkpointSteps.add(tailCycleStart + c * period);

  // fingerprint は「その場で」計算する(盤面の複製を取らない)。
  const prints = new Map();
  const { frames, outOfBoard } = simulateWithBoard(
    genome,
    neededSteps,
    (step, x, y, dir, board) => {
      prints.set(step, neighborhoodFingerprint(board, x, y, dir, radius));
    },
    checkpointSteps,
  );
  if (outOfBoard || frames.length < neededSteps) return false; // 盤外に出た(候補自体が無効)

  let prevPrint = null;
  for (let c = 0; c < cycles; c++) {
    const t = tailCycleStart + c * period;
    const print = prints.get(t);
    if (print === undefined) return false;
    if (prevPrint !== null && print !== prevPrint) return false;
    prevPrint = print;
  }
  return true;
}
