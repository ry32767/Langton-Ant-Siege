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
