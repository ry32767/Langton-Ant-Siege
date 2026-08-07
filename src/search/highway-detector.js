// ハイウェイ(周期並進運動)の検出。DOM に依存しない純粋な ESM。
// MAP-Elites は数百万 genome を評価するため、検出は2段構えにする(タスク仕様の設計判断):
//
//   1. 高速フィルタ = detectHighwayFromPath()
//      軌跡(位置+向き)だけを見る安価な周期性検出。全 genome 候補に適用する。
//   2. 厳密確認 = verifyHighwayStrict()
//      アリ座標を原点とした近傍セルの正規化 fingerprint が t と t+T で一致することを
//      HIGHWAY_MIN_CYCLES 周期分確認する、盤面込みの高コストな再検証。
//      高速フィルタで採用された候補にだけ適用する(毎ステップの近傍ハッシュ化は重すぎるため)。
//
// engine.js は1ステップごとの盤面スナップショットを外部に公開していない(simulateSolo の
// trackPath は位置だけを記録する)ため、verifyHighwayStrict は engine.js の CA ステップ規則
// (AGENTS.md「エンジンの参照実装」)を最小限だけ複製する。これは意図的な例外で、
// 本ファイルの外(evaluate-projectile.js のゲーム評価など)では engine.js の関数
// (simulateSolo)を必ず使う。

import * as C from '../config.js';

/**
 * 軌跡から周期ハイウェイ候補を検出する(高速フィルタ。§8/§9 の位置+向きベース版)。
 *
 * @param {Array<[number, number, number|null|undefined]>} path
 *   [x, y, dir] の配列。x/y はラップしていない絶対座標(トーラスの巻き戻しは呼び出し側の責務)。
 *   dir は「そのステップ時点でアリが持っていた向き(次の一歩を決める値)」。
 *   軌跡の末尾は次の一歩が存在せず dir を決められないことがあるため、null/undefined を許容する
 *   (その場合はその点を含む比較を「一致」とみなして通過させる。位置の一致だけで判定する)。
 * @param {{minCycles?: number, maxPeriod?: number}} [options]
 * @returns {null | {period:number, driftX:number, driftY:number, formationStep:number, verifiedCycles:number, speed:number}}
 */
export function detectHighwayFromPath(path, options = {}) {
  const minCycles = options.minCycles ?? C.HIGHWAY_MIN_CYCLES;
  const maxPeriodOpt = options.maxPeriod ?? C.HIGHWAY_MAX_PERIOD;
  if (!Array.isArray(path) || path.length < 2) return null;

  const n = path.length;
  const lastIdx = n - 1;
  // 末尾から minCycles+1 周期分さかのぼれる長さが必要(§9 の厳密検証: 連続 minCycles 一致)。
  const maxPeriod = Math.min(maxPeriodOpt, Math.floor(lastIdx / (minCycles + 1)));
  if (maxPeriod < 1) return null;

  let best = null;
  for (let period = 1; period <= maxPeriod; period++) {
    const ddx = path[lastIdx][0] - path[lastIdx - period][0];
    const ddy = path[lastIdx][1] - path[lastIdx - period][1];
    if (ddx === 0 && ddy === 0) continue; // その場ループはハイウェイではない

    // 末尾を基準に、(dx,dy,dir) が連続で一致する最小のステップ(formationStep)を
    // stride-1 でさかのぼって探す。1回だけ似た値になる transient では
    // 1つ手前で不一致になり break するため、連続一致でない限り採用されない。
    let onsetStep = null;
    for (let t = lastIdx - period; t >= 0; t--) {
      const dx = path[t + period][0] - path[t][0];
      const dy = path[t + period][1] - path[t][1];
      const dirA = path[t][2];
      const dirB = path[t + period][2];
      const dirOk = dirA == null || dirB == null || dirA === dirB;
      if (dx === ddx && dy === ddy && dirOk) {
        onsetStep = t;
      } else {
        break;
      }
    }
    if (onsetStep === null) continue;

    const verifiedCycles = Math.floor((lastIdx - onsetStep) / period);
    if (verifiedCycles < minCycles) continue;

    const speed = Math.sqrt(ddx * ddx + ddy * ddy) / period;
    const candidate = {
      period,
      driftX: ddx,
      driftY: ddy,
      formationStep: onsetStep,
      verifiedCycles,
      speed,
    };
    // 最も早く形成される(formationStep が小さい)候補を採用する。
    if (best === null || candidate.formationStep < best.formationStep) best = candidate;
  }
  return best;
}

/** directionBin が返す8方向。config.ARCHIVE1.directions と同じ並び(N を起点に時計回り)。 */
const DIRECTION_ORDER = C.ARCHIVE1.directions;

/**
 * 並進 (driftX, driftY) を8方向に離散化する。
 * 画面座標系なので y が増える向きが 'S'(下)。
 * N=(0,-1) を起点に時計回りで45度刻み: N,NE,E,SE,S,SW,W,NW。
 */
export function directionBin(driftX, driftY) {
  if (driftX === 0 && driftY === 0) return null; // 並進なしは方向を定義できない
  const deg = ((Math.atan2(driftY, driftX) * 180) / Math.PI + 360) % 360;
  const idx = Math.round((deg + 90) / 45) % 8;
  return DIRECTION_ORDER[idx];
}

// ---------------------------------------------------------------------------
// 厳密確認(§9)。高速フィルタで採用された候補にだけ適用する高コストな再検証。
// ---------------------------------------------------------------------------

/** 盤面の1次元インデックス。engine.js の idx() と同じ規則(WIDTH*y + x)。 */
function idx(x, y) {
  return y * C.WIDTH + x;
}

/**
 * genome から単体のアリを盤面込みで走らせ、各ステップの位置・向きと、指定した
 * checkpointSteps(踏む前の状態を見たいステップ番号の集合)時点での盤面スナップショットを
 * 保持する。engine.js の stepAnt() と同じ CA 規則(「回転は踏んだ時点の状態で決める」
 * 「配置マスは state で書き込む」)を複製したもの。engine.js が per-step の盤面を
 * 公開していないための例外的な複製(このファイル冒頭のコメント参照)。ゲーム評価は必ず
 * engine.js の simulateSolo を使うこと(このヘルパは厳密確認専用)。
 *
 * ⚠️ 盤面は毎ステップ書き換わるため、fingerprint はシミュレーション完了後の盤面ではなく
 * その時点のスナップショットで比較しなければならない。checkpointSteps に含めたステップの
 * 「踏む前」の盤面を複製して保存するのはそのため。
 */
function simulateWithBoard(genome, maxSteps, checkpointSteps) {
  const board = new Uint8Array(C.CELL_COUNT);
  for (const cell of genome.cells) {
    board[idx(cell.x, cell.y)] = cell.state;
  }
  const colorCount = genome.rule.length;
  let x = genome.antX;
  let y = genome.antY;
  let dir = genome.antDir;
  const frames = []; // { x, y, dir }(踏む前の状態。detectHighwayFromPath の path と同じ意味)
  const snapshots = new Map(); // step -> その時点の盤面スナップショット(踏む前)
  for (let step = 0; step < maxSteps; step++) {
    frames.push({ x, y, dir });
    if (y < 0 || y >= C.HEIGHT || x < 0 || x >= C.WIDTH) break; // 盤外に出たら打ち切り
    if (checkpointSteps.has(step)) snapshots.set(step, board.slice());
    const j = idx(x, y);
    const s = board[j] % colorCount;
    dir = genome.rule[s] === 'R' ? (dir + 1) & 3 : (dir + 3) & 3;
    board[j] = (s + 1) % colorCount;
    const d = C.DIRS[dir];
    x = (x + d[0] + C.WIDTH) % C.WIDTH;
    y = y + d[1];
  }
  return { frames, snapshots };
}

/**
 * アリ座標を原点とし、その時点の向きで正規化(回転)した近傍セル状態の fingerprint を作る。
 * radius は近傍の半径(実装の内部パラメータ。config.js には出さない。ゲームバランスの
 * 数値ではなく検出アルゴリズム内部の解像度のため)。
 */
function neighborhoodFingerprint(board, x, y, dir, radius) {
  const forward = C.DIRS[dir];
  const right = C.DIRS[(dir + 1) & 3];
  const out = [];
  for (let v = -radius; v <= radius; v++) {
    for (let u = -radius; u <= radius; u++) {
      const gx = (((x + right[0] * u + forward[0] * v) % C.WIDTH) + C.WIDTH) % C.WIDTH;
      const gy = y + right[1] * u + forward[1] * v;
      out.push(gy < 0 || gy >= C.HEIGHT ? 0 : board[idx(gx, gy)]);
    }
  }
  return out.join(',');
}

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
  // 直後の数周期はまだ収束しない(実測で確認済み)。そこで検証対象は verifiedCycles の
  // 「末尾側」の cycles 周期分にする。末尾側はハイウェイ自身の軌跡で近傍が繰り返し
  // 上書きされ尽くしているため、真のハイウェイなら確実に収束している。
  const tailCycleStart = formationStep + (verifiedCycles - cycles) * period;
  const neededSteps = tailCycleStart + cycles * period + 1;
  const checkpointSteps = new Set();
  for (let c = 0; c < cycles; c++) checkpointSteps.add(tailCycleStart + c * period);
  const { frames, snapshots } = simulateWithBoard(genome, neededSteps, checkpointSteps);
  if (frames.length < neededSteps) return false; // 途中で盤外に出た(候補自体が無効)

  let prevPrint = null;
  for (let c = 0; c < cycles; c++) {
    const t = tailCycleStart + c * period;
    const f = frames[t];
    const snapshot = snapshots.get(t);
    if (!snapshot) return false;
    const print = neighborhoodFingerprint(snapshot, f.x, f.y, f.dir, radius);
    if (prevPrint !== null && print !== prevPrint) return false;
    prevPrint = print;
  }
  return true;
}
