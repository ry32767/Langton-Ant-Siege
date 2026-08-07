// ハイウェイ(周期並進運動)の検出。DOM に依存しない純粋な ESM。
// MAP-Elites は数百万 genome を評価するため、検出は2段構えにする(タスク仕様の設計判断):
//
//   1. 高速フィルタ = detectHighwayFromPath()
//      軌跡(位置+向き)だけを見る安価な周期性検出。全 genome 候補に適用する。
//   2. 厳密確認 = verifyHighwayStrict()(highway-fingerprint.js)
//      アリ座標を原点とした近傍セルの正規化 fingerprint が t と t+T で一致することを
//      HIGHWAY_MIN_CYCLES 周期分確認する、盤面込みの高コストな再検証。
//      高速フィルタで採用された候補にだけ適用する(毎ステップの近傍ハッシュ化は重すぎるため)。
//
// このファイルは1.の高速フィルタ(軌跡ベース)のみを担当する。

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
