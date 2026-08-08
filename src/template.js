// テンプレートの座標変換だけを持つ極小の純粋モジュール。
//
// なぜ engine.js ではなくここにあるか:
//   `src/cpu.js` は **engine.js を import してはいけない**(実行時のシミュレーション探索を
//   しないことを依存関係で担保するため。AGENTS.md「Do NOT」)。一方で v5 から発射列 antX が
//   可変になり、CPU もプレイヤーUIも「相対テンプレート → 絶対座標の action」への変換が要る。
//   これはシミュレーションではなく純粋な座標計算なので、engine から切り出して
//   engine / cpu / app / scripts が同じ実装を共有する。
//
// DOM にも engine にも依存しない。数値は src/config.js から取る。

import * as C from './config.js';

/**
 * テンプレート(cells が **アリからの相対 [dx, dy, state]**)を、指定した発射列 antX で
 * 実体化して engine が受け取れる action(cells が絶対 [x, y, state])に変換する。
 *
 * 左右がトーラスなので x 方向の平行移動は力学の厳密な対称性であり、同じテンプレートを
 * どの列から撃っても軌道は平行移動するだけで形も周期も並進も変わらない。だから発射列は
 * 発射時の自由度にできる。一方 antY はテンプレート固有(y を平行移動すると得点ラインまでの
 * 距離が変わり、寿命内に届くかどうかが変わってしまう)。
 */
export function instantiateTemplate(template, antX) {
  const ax = (((antX ?? template.antX ?? 0) % C.WIDTH) + C.WIDTH) % C.WIDTH;
  const ay = template.antY;
  const cells = (template.cells ?? []).map((cell) => {
    const dx = cell[0];
    const dy = cell[1];
    const state = cell.length >= 3 ? cell[2] : 1;
    return [(((ax + dx) % C.WIDTH) + C.WIDTH) % C.WIDTH, ay + dy, state];
  });
  return {
    kind: template.kind ?? 'attack',
    rule: template.rule,
    templateId: template.id ?? template.templateId ?? null,
    antX: ax,
    antY: ay,
    antDir: template.antDir,
    cells,
  };
}

/** x をトーラスの範囲に正規化する。 */
export function wrapX(x) {
  return (((x % C.WIDTH) + C.WIDTH) % C.WIDTH);
}

/**
 * 攻撃テンプレートを「得点ゲートに届く発射列」の一覧に落とす。
 *
 * テンプレートは `entryXAt0`(発射列0で撃ったときに敵陣へ入る列)を持つ。
 * 実際の到達列は `(antX + entryXAt0) mod WIDTH` なので、得点するための条件は
 *   SCORE_GATE_X_MIN <= (antX + entryXAt0) mod WIDTH < SCORE_GATE_X_MAX
 * となり、antX は幅 SCORE_GATE_WIDTH の連続区間(トーラス上)に限られる。
 * これが「発射位置は自由だが、得点したいなら撃てる列は決まる」という v5 の駆け引きの正体。
 *
 * @returns {{min:number, count:number}} min から count 列ぶん(トーラス上で連続)が有効。
 *   entryXAt0 が無い(到達しない)テンプレートは count=0 を返す。
 */
export function scoringLaunchColumns(template) {
  const e = template.entryXAt0;
  if (e == null) return { min: 0, count: 0 };
  return { min: wrapX(C.SCORE_GATE_X_MIN - e), count: C.SCORE_GATE_WIDTH };
}

/** 発射列 antX で撃ったときに得点できるか。 */
export function launchColumnScores(template, antX) {
  const e = template.entryXAt0;
  if (e == null) return false;
  return C.isInScoreGate(wrapX(antX + e));
}

/**
 * `(startX, startY)` から `(startX + totalDx, endY)` への直線を、UI 上で発射ガイドとして
 * 描ける線分の配列に分解する。
 *
 * 盤面は左右がトーラスなので、`totalDx` の絶対値が大きい(あるいは負の)進路をそのまま
 * 1本の直線として描くと、盤面の反対側まで一直線に引かれてしまい「盤面を逆走する線」に
 * 見えてしまう。実際のアリは x=WIDTH(または x=0)で折り返して反対側から現れるので、
 * 描画もその境界(x が 0 または WIDTH をまたぐ点)で線分を分割し、それぞれを
 * `0 <= x <= WIDTH` に収まる形で返す必要がある。
 *
 * @param {number} startX 発射列(0..WIDTH-1)
 * @param {number} startY 発射行
 * @param {number} totalDx ラップしていない横方向の総移動量(負もありうる)
 * @param {number} endY 終端の行
 * @returns {{x1:number, y1:number, x2:number, y2:number}[]} 線分の配列。
 *   `endY <= startY` なら空配列(前進しないので描くものが無い)。
 */
export function launchPathSegments(startX, startY, totalDx, endY) {
  if (endY <= startY) return [];
  const dy = endY - startY;
  if (totalDx === 0) {
    return [{ x1: startX, y1: startY, x2: startX, y2: endY }];
  }
  const endX = startX + totalDx;
  const lowX = Math.min(startX, endX);
  const highX = Math.max(startX, endX);
  // startX と endX の間(端は含まない)にある WIDTH の倍数が、盤面の左右端をまたぐ分割点。
  const kMin = Math.floor(lowX / C.WIDTH);
  const kMax = Math.ceil(highX / C.WIDTH);
  const crossings = [];
  for (let k = kMin; k <= kMax; k++) {
    const m = k * C.WIDTH;
    if (m > lowX && m < highX) crossings.push((m - startX) / totalDx);
  }
  crossings.sort((a, b) => a - b);
  const ts = [0, ...crossings, 1];
  const segments = [];
  for (let i = 0; i < ts.length - 1; i++) {
    const ta = ts[i];
    const tb = ts[i + 1];
    const xa = startX + ta * totalDx;
    const xb = startX + tb * totalDx;
    const ya = startY + ta * dy;
    const yb = startY + tb * dy;
    // 分割された各区間の中点が属する WIDTH ブロックを求め、そのブロック分だけ引き戻して
    // 0..WIDTH に収める(区間の端は境界の分割点そのものなので、中点で判定すれば安全)。
    const k = Math.floor((xa + xb) / 2 / C.WIDTH);
    segments.push({ x1: xa - k * C.WIDTH, y1: ya, x2: xb - k * C.WIDTH, y2: yb });
  }
  return segments;
}
