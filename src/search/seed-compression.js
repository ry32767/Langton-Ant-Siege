// Seed Compression(仕様 §15・§16)。抽出した種セルから、ハイウェイの再現に不要な
// セルを貪欲に削る。純粋なデータ操作 + 渡された判定関数だけに依存する
// (シミュレーションは呼び出し側の verify 関数の中で行う)。
//
// 目的は「厳密な最小種を求めること」ではなく、
//   **ゲームの配置セル数上限(MAX_CELLS)に収めながら形成時間を短縮すること**(§15)。
// なので1パスの貪欲削除で十分とし、最適性は求めない。

/** セルのアリからの距離(チェビシェフ距離)。削除順の優先度に使う。 */
function chebyshev(cell) {
  return Math.max(Math.abs(cell.dx), Math.abs(cell.dy));
}

/**
 * 種セルの貪欲圧縮。
 *
 * 削除順は **アリから遠い順**(§16「初期実装ではランダム順またはアリから遠い順でよい」)。
 * 遠いセルほどハイウェイの局所構造への寄与が薄いと期待できるので、先に試すと
 * 少ない試行回数で多く削れる。同距離のセルの順序は決定論的に固定する
 * (dx, dy の辞書順)。乱数を使わないので、同じ入力に対して常に同じ結果になる。
 *
 * @param {Array<{dx:number,dy:number,state:number}>} cells 元の種セル
 * @param {(cells:Array<{dx:number,dy:number,state:number}>)=>boolean} verify
 *   セル集合を渡すと「元のハイウェイを再現するか」を返す関数。
 *   ⚠️ この関数は圧縮の内側で何度も呼ばれる(セル数ぶんの回数)。重い処理なら
 *   呼び出し側で候補数を絞ってから使うこと(§19)。
 * @param {{maxDeletions?:number}} [options]
 * @returns {{cells:Array, removed:number, verifyCalls:number}}
 */
export function compressSeed(cells, verify, options = {}) {
  const maxDeletions = options.maxDeletions ?? cells.length;
  // 遠い順 → 同距離は (dx, dy) の辞書順で決定論的に並べる
  const order = cells
    .map((c, i) => ({ i, d: chebyshev(c), dx: c.dx, dy: c.dy }))
    .sort((a, b) => b.d - a.d || a.dx - b.dx || a.dy - b.dy)
    .map((e) => e.i);

  let current = cells.map((c) => ({ dx: c.dx, dy: c.dy, state: c.state }));
  const removedKeys = new Set();
  let removed = 0;
  let verifyCalls = 0;

  for (const originalIndex of order) {
    if (removed >= maxDeletions) break;
    if (current.length <= 1) break; // 最低1マスは残す(MIN_TEMPLATE_CELLS の前提)
    const target = cells[originalIndex];
    const key = `${target.dx},${target.dy}`;
    if (removedKeys.has(key)) continue;
    const candidate = current.filter((c) => !(c.dx === target.dx && c.dy === target.dy));
    if (candidate.length === current.length) continue; // 既に無い
    verifyCalls++;
    if (verify(candidate)) {
      current = candidate;
      removedKeys.add(key);
      removed++;
    }
    // 再現しなくなったら戻す(= current を更新しない)
  }

  return { cells: current, removed, verifyCalls };
}
