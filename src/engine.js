// アリ・シミュレーションエンジン。docs/spec.md 第2章・docs/data-model.md 準拠。
// DOM / window に依存しない純粋な ESM。数値は必ず src/config.js から import する。
//
// v4(MAP-Elites 版)の変更点:
//   - 盤面を90度回転。攻撃軸が上下(y)、ラップが左右(x)になった
//   - グローバル定数 RULE / COLORS / PLACED_CELL_STATE は廃止。
//     各アリが自分の rule(文字列) / colorCount(=rule.length) / templateId を持つ
//   - 異なる色数のアリが同じ盤面を共有するため、盤面の生値は ant.colorCount で
//     割った余りとして解釈する(modulo 解釈)
import * as C from './config.js';

// ---------------------------------------------------------------------------
// 内部ヘルパ(非公開)
// ---------------------------------------------------------------------------

/** 盤面の1次元インデックス。 */
const idx = (x, y) => y * C.WIDTH + x;

/** 配置セル [x,y] または [x,y,state] から state を取り出す。2要素は state=1 とみなす(互換)。 */
function cellState(cell) {
  return cell.length >= 3 ? cell[2] : 1;
}

/**
 * 増分カウンタの更新(0 ↔ 0以外 を跨いだ瞬間だけ動かす)。
 * counters は match(または match 相当のオブジェクト)。null なら何もしない
 * (探索・単体シミュレーション経路はカウンタを持たないため)。
 */
function bumpCounters(counters, x, gy, wasZero, isZero) {
  if (!counters || wasZero === isZero) return;
  const delta = wasZero ? 1 : -1; // 0→非0 は +1、非0→0 は -1
  counters.nonWhiteTotal += delta;
  // 列ごとの非白セル数(v5.3)。発射列を選ぶ判断に使うので列単位で持つ。
  // 盤面そのものは createSideView が参照で渡すが、65,536セルを毎判断で走査させると
  // 学習が終わらない(view は学習1回で約4,600万回作られる)。列集計は増分で O(1)。
  counters.nonWhiteColumn[x] += delta;
  if (gy < C.ZONE_DEPTH) counters.nonWhiteZone[0] += delta;
  else if (gy >= C.HEIGHT - C.ZONE_DEPTH) counters.nonWhiteZone[1] += delta;
  // 32×32 粗視化盤面(action-centric-contract.md §1.1)。ブロックは 8×8セル固定。
  const coarseBlock = (gy >> C.COARSE_SHIFT) * C.COARSE_SIZE + (x >> C.COARSE_SHIFT);
  counters.coarseNonWhite[coarseBlock] += delta;
}

/**
 * セル (x, gy) の所有者が (oldSide, oldSlot) → (newSide, newSlot) へ変わったときの
 * 粗視化 ownership の増分更新(action-centric-contract.md §1.2)。
 * side は 0=所有者なし / 1=side0 / 2=side1(lastToucherSide と同じ符号化)。
 * slot は 0=不明or未確保 / 1..MAX_FLYING(lastToucherSlot と同じ符号化)。
 * counters が null なら何もしない(探索・単体シミュレーション経路はこのカウンタを持たないため)。
 */
function bumpOwnership(counters, x, gy, oldSide, oldSlot, newSide, newSlot) {
  if (!counters) return;
  if (oldSide === newSide && oldSlot === newSlot) return;
  const b = (gy >> C.COARSE_SHIFT) * C.COARSE_SIZE + (x >> C.COARSE_SHIFT);
  if (oldSide !== 0) {
    counters.coarseOwnedBySide[oldSide - 1][b]--;
    if (oldSlot !== 0) counters.coarseOwnedByAnt[oldSide - 1][oldSlot - 1][b]--;
  }
  if (newSide !== 0) {
    counters.coarseOwnedBySide[newSide - 1][b]++;
    if (newSlot !== 0) counters.coarseOwnedByAnt[newSide - 1][newSlot - 1][b]++;
  }
}

/**
 * アリを1歩進める。
 * 「回転は踏んだ時点の状態で決める」(進める前の状態を読んでから状態を進める)。
 * 盤面の生値はアリの色数で割った余りとして解釈する(異種ルールの衝突)。
 * counters: 省略可(null なら増分カウンタを更新しない)。試合の盤面(match.board)を
 * 触る経路(moveSide)だけが match を渡す。
 */
function stepAnt(board, lastToucher, lastToucherSide, ant, counters = null) {
  const gy = toGlobalY(ant.sideIndex, ant.y);
  const j = idx(ant.x, gy);
  const raw = board[j];
  const s = raw % ant.colorCount;
  ant.dir = ant.rule[s] === 'R' ? (ant.dir + 1) & 3 : (ant.dir + 3) & 3;
  const newVal = (s + 1) % ant.colorCount;
  bumpCounters(counters, ant.x, gy, raw === 0, newVal === 0);
  // ownership 更新前に旧所有者を控える(lastToucherSlot は match だけが持つので counters 経由)。
  const oldSide = lastToucherSide[j];
  const oldSlot = counters ? counters.lastToucherSlot[j] : 0;
  board[j] = newVal;
  lastToucher[j] = ant.id;
  lastToucherSide[j] = ant.sideIndex + 1;
  if (counters) {
    counters.lastToucherSlot[j] = ant.slot + 1;
    bumpOwnership(counters, ant.x, gy, oldSide, oldSlot, ant.sideIndex + 1, ant.slot + 1);
  }
  // 踏んだマスを記録する(cleanupAnt が全盤面を走査しないため。下の cleanupAnt のコメント参照)。
  ant.touched.push(j);
  const d = C.DIRS[ant.dir];
  ant.x = (ant.x + d[0] + C.WIDTH) % C.WIDTH; // 左右はトーラス
  ant.y = ant.y + d[1]; // 上下はラップしない(素の加算)
  ant.steps++;
}

/**
 * アリ消滅時のクリーンアップ。
 * { 配置マスのうち lastToucher が -1 か自分 } ∪ { lastToucher が自分と一致する全マス } を白に戻す。
 *
 * ⚠️ v5 の性能修正: 後半の集合はもともと `for (q = 0; q < board.length; q++)` の全盤面走査だった。
 * 盤面が 7,200 → 65,536 マスになり、1試合で数十匹が消滅するのでここが支配的コストになる
 * (5,000試合のバランス検証が現実的な時間で終わらない)。
 * `lastToucher[q] === ant.id` になりうるマスは **そのアリが実際に踏んだマスの部分集合**でしか
 * ありえないので、`ant.touched`(stepAnt が記録する踏んだマスの列)だけを見れば結果は同値になる。
 * 同一マスを複数回踏んでいると `touched` に重複が入るが、1回目で白に戻したあと
 * `lastToucher` が -1 になるため2回目以降は条件に合わず、二重処理にはならない。
 */
function cleanupAnt(board, lastToucher, lastToucherSide, ant, counters = null) {
  for (const cell of ant.cells) {
    const [x, y] = cell;
    const gy = toGlobalY(ant.sideIndex, y);
    const q = idx(x, gy);
    if (lastToucher[q] === -1 || lastToucher[q] === ant.id) {
      bumpCounters(counters, x, gy, board[q] === 0, true);
      const oldSide = lastToucherSide[q];
      const oldSlot = counters ? counters.lastToucherSlot[q] : 0;
      board[q] = 0;
      lastToucher[q] = -1;
      lastToucherSide[q] = 0;
      if (counters) {
        counters.lastToucherSlot[q] = 0;
        bumpOwnership(counters, x, gy, oldSide, oldSlot, 0, 0);
      }
    }
  }
  for (let i = 0; i < ant.touched.length; i++) {
    const q = ant.touched[i];
    if (lastToucher[q] === ant.id) {
      if (counters) bumpCounters(counters, q % C.WIDTH, Math.floor(q / C.WIDTH), board[q] === 0, true);
      const oldSide = lastToucherSide[q];
      const oldSlot = counters ? counters.lastToucherSlot[q] : 0;
      board[q] = 0;
      lastToucher[q] = -1;
      lastToucherSide[q] = 0;
      if (counters) {
        counters.lastToucherSlot[q] = 0;
        bumpOwnership(counters, q % C.WIDTH, Math.floor(q / C.WIDTH), oldSide, oldSlot, 0, 0);
      }
    }
  }
}

/**
 * 前進後の判定。dead / scored を返す(盤面操作はしない)。判定は前進後、この順。
 *
 * ⚠️ v5: 敵陣(y >= SCORE_LINE_Y)に到達しても、そのときの x が **得点ゲート**の外なら
 * 得点にならずに消滅する(config.js の SCORE_GATE_WIDTH のコメント参照)。
 * ゲートは盤面中央に左右対称に取ってあるので、x はグローバル座標のまま両陣営で共通に判定できる
 * (x は陣営で鏡像にならない。鏡像になるのは y だけ)。
 */
function resolveAnt(ant) {
  if (ant.y < 0) return { dead: true, scored: false, reached: false };
  // ⚠️ v5.3: 妨害アリは盤面中央(自陣ローカル y >= DISRUPT_MAX_LOCAL_Y)を越えられない。
  // 得点ラインの判定より**前**に置くこと(後ろに置くと素通りして得点しうる)。
  // これは種類による唯一の特別扱いで、意図的なもの。v5.2 までは「妨害の寿命が短いから
  // 敵陣に届かない」という担保だったが、それはテンプレートを再生成すると壊れる
  // (実測: 寿命4,000で乱数配置の43%が敵陣に到達し得点した)。空間で縛れば原理的に破れない。
  // config.js の DISRUPT_MAX_LOCAL_Y のコメント参照。
  if (ant.kind === 'disrupt' && ant.y >= C.DISRUPT_MAX_LOCAL_Y) {
    return { dead: true, scored: false, reached: false };
  }
  if (ant.y >= C.SCORE_LINE_Y) return { dead: true, scored: C.isInScoreGate(ant.x), reached: true };
  if (ant.steps >= ant.life) return { dead: true, scored: false, reached: false };
  return { dead: false, scored: false, reached: false };
}

// ---------------------------------------------------------------------------
// 擬似乱数(決定論的・xorshift32)
// ---------------------------------------------------------------------------

export function createRng(seed) {
  let s = seed >>> 0;
  if (s === 0) s = 0x9e3779b9; // 全ビット0は不動点になるため回避
  function next() {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296; // 2^32
  }
  return {
    next,
    int(n) {
      return Math.floor(next() * n);
    },
    pick(arr) {
      return arr[Math.floor(next() * arr.length)];
    },
    state() {
      return s;
    },
  };
}

// ---------------------------------------------------------------------------
// 座標変換(side0=上=ローカル座標そのもの / side1=下=上下鏡像)
// x(左右)はトーラスの共有軸なので変換しない。y(上下)だけが陣営ごとに鏡像になる。
// ---------------------------------------------------------------------------

export function toGlobalY(sideIndex, localY) {
  return sideIndex === 0 ? localY : C.HEIGHT - 1 - localY;
}

export function toLocalY(sideIndex, globalY) {
  // 変換は対称(自己逆変換)なので式は toGlobalY と同じ
  return sideIndex === 0 ? globalY : C.HEIGHT - 1 - globalY;
}

export function mirrorDir(sideIndex, dir) {
  if (sideIndex === 0) return dir;
  if (dir === C.DIR_UP) return C.DIR_DOWN;
  if (dir === C.DIR_DOWN) return C.DIR_UP;
  return dir;
}

// ---------------------------------------------------------------------------
// オフライン用シミュレーションの盤面バッファ
//
// ⚠️ v5: 盤面が 65,536 マスになったため、1回の評価ごとに Uint8Array/Int16Array を
// 確保して `fill(-1)` すると、確保とゼロ埋めだけで探索(数百万回)・カウンター行列計算
// (数十万回)が破綻する。触れたマスの添字を控えておき、実行の最後にそこだけ戻すことで
// バッファを使い回す(simulateSearch と同じ考え方)。
//
// ⚠️ **再入不可**。同じバッファ集合を使う関数の実行中に、同じ関数を再帰的・並行に
// 呼び出してはいけない。simulateSolo と simulateVersus は別のバッファ集合を持たせて
// あるので、片方の中からもう片方を呼ぶのは安全(実際そういう呼び方はしていない)。
// 並列化は worker_threads(ワーカーごとにモジュールが別インスタンスになる)で行う。
// ---------------------------------------------------------------------------

function createGameBuffers() {
  return {
    board: new Uint8Array(C.CELL_COUNT),
    lastToucher: new Int16Array(C.CELL_COUNT).fill(-1),
    lastToucherSide: new Uint8Array(C.CELL_COUNT),
  };
}

let _soloBuffers = null;
let _versusBuffers = null;

/** 指定した添字だけを白紙に戻す(バッファ使い回しのためのリセット)。 */
function resetIndices(buffers, indices) {
  const { board, lastToucher, lastToucherSide } = buffers;
  for (let i = 0; i < indices.length; i++) {
    const q = indices[i];
    board[q] = 0;
    lastToucher[q] = -1;
    lastToucherSide[q] = 0;
  }
}

// ---------------------------------------------------------------------------
// テンプレートの実体化(発射列 antX の可変化。§v5)
//
// 実体は src/template.js にある。src/cpu.js は engine.js を import できない
// (AGENTS.md「Do NOT」)ため、座標変換だけを別モジュールに切り出して共有している。
// engine.js からは後方互換のために再エクスポートする。
// ---------------------------------------------------------------------------
export { instantiateTemplate } from './template.js';

// ---------------------------------------------------------------------------
// オフライン用の単体シミュレーション
// ---------------------------------------------------------------------------

/**
 * 空盤面に template.cells を置いてアリ1匹を寿命まで走らせる(side0 固定)。
 * rule は template.rule か options.rule を使う(どちらも無ければ C.LEGACY_RULE)。
 * ⚠️ cells は**絶対座標**で渡す(相対テンプレートは instantiateTemplate を通すこと)。
 * ⚠️ 再入不可(上の「オフライン用シミュレーションの盤面バッファ」参照)。
 */
export function simulateSolo(template, options = {}) {
  if (!_soloBuffers) _soloBuffers = createGameBuffers();
  const { board, lastToucher, lastToucherSide } = _soloBuffers;
  const dirty = [];
  const kind = template.kind ?? 'attack';
  const sideIndex = 0;
  const antId = 0;
  const cells = template.cells ?? [];
  const rule = options.rule ?? template.rule ?? C.LEGACY_RULE;
  const colorCount = rule.length;
  for (const cell of cells) {
    const [x, y] = cell;
    const j = idx(x, toGlobalY(sideIndex, y));
    board[j] = cellState(cell);
    lastToucher[j] = antId;
    lastToucherSide[j] = sideIndex + 1;
    dirty.push(j);
  }
  const ant = {
    id: antId,
    sideIndex,
    kind,
    rule,
    colorCount,
    templateId: template.templateId ?? null,
    x: template.antX,
    y: template.antY,
    dir: template.antDir,
    steps: 0,
    life: options.life ?? C.ANT_KINDS[kind].life,
    cells,
    touched: [],
  };
  const trackPath = !!options.trackPath;
  const path = trackPath ? [[ant.x, ant.y]] : undefined;
  let scored = false;
  let reached = false;
  let entryY = null;
  let entryX = null;
  for (;;) {
    stepAnt(board, lastToucher, lastToucherSide, ant);
    if (trackPath) path.push([ant.x, ant.y]);
    const r = resolveAnt(ant);
    if (r.dead) {
      if (r.reached) {
        reached = true;
        entryY = ant.y;
        entryX = ant.x;
      }
      scored = r.scored;
      break;
    }
  }
  // バッファを使い回すため、触れたマスだけを白紙に戻す。
  resetIndices(_soloBuffers, dirty);
  resetIndices(_soloBuffers, ant.touched);
  // ⚠️ `scored`(得点ゲート適用後)と `reached`(敵陣に到達したか)を区別して返す。
  // 探索評価は **reached** を使う。発射列 antX は発射時に自由に選べて、左右がトーラス
  // なので「到達 x をゲート内に持ってくる antX が必ず存在する」ため、ゲートは
  // テンプレートの実力(viable かどうか)を左右しない。ゲートが効くのは実プレイで
  // 「どの列から撃つか」を縛るところだけ(config.js の SCORE_GATE_WIDTH 参照)。
  return { scored, reached, steps: ant.steps, entryY, entryX, endX: ant.x, endY: ant.y, path };
}

// ---------------------------------------------------------------------------
// 探索(MAP-Elites)専用のシミュレーション。
//
// 実ゲーム盤面(HEIGHT=120)は上下端でアリが死ぬため SEARCH_LIFE(=20,000)まで
// 走らせられない(実測: 到達率11.6%)。探索評価(ハイウェイ検出)だけは
// C.SEARCH_BOARD_HEIGHT の高さを持つ仮想盤面(上下端なし・得点判定なし)で走らせ、
// ゲーム採用評価(simulateSolo・ATTACK_LIFE)とは分離する(差分仕様 §7)。
//
// ⚠️ CA規則は stepAnt と完全に同一(1ステップ処理を複製しない)。
// sideIndex=0 で呼ぶと toGlobalY(0, y) = y の恒等変換になるので、stepAnt をそのまま流用できる。
// ⚠️ 性能: MAP-Elites が数百万回呼ぶため、盤面バッファをモジュールレベルで使い回し、
// 触れたセルだけを消してリセットする。このため **再入不可**(このシミュレーションの
// 実行が完了する前に同じ関数を再帰・並行に呼び出すとバッファが競合して壊れる)。
// ---------------------------------------------------------------------------

const SEARCH_CELL_COUNT = C.WIDTH * C.SEARCH_BOARD_HEIGHT;
const SEARCH_CENTER_Y = Math.floor(C.SEARCH_BOARD_HEIGHT / 2);
let _searchBoard = null;
let _searchLastToucher = null;
let _searchLastToucherSide = null;

function getSearchBuffers() {
  if (!_searchBoard) {
    _searchBoard = new Uint8Array(SEARCH_CELL_COUNT);
    _searchLastToucher = new Int16Array(SEARCH_CELL_COUNT).fill(-1);
    _searchLastToucherSide = new Uint8Array(SEARCH_CELL_COUNT);
  }
  return { board: _searchBoard, lastToucher: _searchLastToucher, lastToucherSide: _searchLastToucherSide };
}

/**
 * 探索評価用のシミュレーション(§7 の探索評価レジーム)。
 * template.antY(0..ZONE_DEPTH-1)は仮想盤面中央からのオフセットとして扱う(cells の y も同様)。
 * 得点判定はしない。仮想盤面の上下端をはみ出したら終了する。life は既定で C.SEARCH_LIFE。
 * ⚠️ 再入不可(上のコメント参照)。
 */
export function simulateSearch(template, options = {}) {
  const { board, lastToucher, lastToucherSide } = getSearchBuffers();
  const touched = [];
  const kind = template.kind ?? 'attack';
  const antId = 0;
  const cells = template.cells ?? [];
  const rule = options.rule ?? template.rule ?? C.LEGACY_RULE;
  const colorCount = rule.length;
  for (const cell of cells) {
    const [x, y] = cell;
    const j = idx(x, SEARCH_CENTER_Y + y);
    board[j] = cellState(cell);
    lastToucher[j] = antId;
    lastToucherSide[j] = 1;
    touched.push(j);
  }
  const ant = {
    id: antId,
    sideIndex: 0, // toGlobalY(0, y) = y の恒等変換を利用するため固定(仮想盤面に側の概念はない)
    kind,
    rule,
    colorCount,
    templateId: template.templateId ?? null,
    x: template.antX,
    y: SEARCH_CENTER_Y + template.antY,
    dir: template.antDir,
    steps: 0,
    life: options.life ?? C.SEARCH_LIFE,
    cells,
    // 踏んだマスの添字は stepAnt が ant.touched に記録する(cleanupAnt と共用の仕組み)。
    touched: [],
  };
  const trackPath = !!options.trackPath;
  const path = trackPath ? [[ant.x, ant.y]] : undefined;
  for (;;) {
    stepAnt(board, lastToucher, lastToucherSide, ant);
    if (trackPath) path.push([ant.x, ant.y]);
    if (ant.y < 0 || ant.y >= C.SEARCH_BOARD_HEIGHT || ant.steps >= ant.life) break;
  }
  // 触れたセルだけを白に戻す(盤面バッファの使い回し)
  for (const j of touched) {
    board[j] = 0;
    lastToucher[j] = -1;
    lastToucherSide[j] = 0;
  }
  for (let i = 0; i < ant.touched.length; i++) {
    const j = ant.touched[i];
    board[j] = 0;
    lastToucher[j] = -1;
    lastToucherSide[j] = 0;
  }
  return { steps: ant.steps, endX: ant.x, endY: ant.y, path };
}

/**
 * 攻撃アリ(side0 から発射)と、妨害・護衛アリ群(fireAtStep で予約)を同じ盤面で走らせる。
 * ステップ順序は spec 準拠: 各ステップ内で side0 の予約発射 → side1 の予約発射 →
 * side0 のアリを発射順に全部移動 → side1 のアリを発射順に全部移動。
 *
 * 試合の資源(トークン・同時飛行数)は考慮しない、純粋なオフライン検証用。
 */
export function simulateVersus(attack, opponents, options = {}) {
  if (!_versusBuffers) _versusBuffers = createGameBuffers();
  const { board, lastToucher, lastToucherSide } = _versusBuffers;
  // バッファ使い回しのため、この実行で盤面に書き込んだ添字を全部控える。
  // 盤面への書き込みは place()(配置マス)と stepAnt()(ant.touched)の2箇所しかないので、
  // dirty ∪ (全アリの touched) が「この実行で汚したマス」の上位集合になる。
  const dirty = [];
  const allAnts = [];
  let nextId = 0;
  const antsBySide = [[], []];

  function place(sideIndex, tpl, kind) {
    const id = nextId++;
    const cells = tpl.cells ?? [];
    const rule = tpl.rule ?? options.rule ?? C.LEGACY_RULE;
    const colorCount = rule.length;
    for (const cell of cells) {
      const [x, y] = cell;
      const j = idx(x, toGlobalY(sideIndex, y));
      board[j] = cellState(cell);
      lastToucher[j] = id;
      lastToucherSide[j] = sideIndex + 1;
      dirty.push(j);
    }
    const ant = {
      id,
      sideIndex,
      kind,
      rule,
      colorCount,
      templateId: tpl.templateId ?? null,
      x: tpl.antX,
      y: tpl.antY,
      dir: tpl.antDir,
      steps: 0,
      life: options.life ?? C.ANT_KINDS[kind].life,
      cells,
      touched: [],
    };
    antsBySide[sideIndex].push(ant);
    allAnts.push(ant);
    return ant;
  }

  const attackAnt = place(0, attack, attack.kind ?? 'attack');
  const pending = opponents.map((o) => ({ ...o, _fired: false }));

  let step = 0;
  let attackAlive = true;
  let scored = false;
  let entryX = null;
  let entryY = null;
  let attackFinalX = null;
  let attackFinalY = null;
  // trackPath:true のとき攻撃アリの軌跡を [x, y, dir] で記録する。
  // detectHighway / highway-detector にかけて「妨害で崩れた軌道が復帰したか」を測るために使う(§29)。
  const trackPath = !!options.trackPath;
  const attackPath = trackPath ? [[attackAnt.x, attackAnt.y, attackAnt.dir]] : undefined;
  const safetyLimit = C.ATTACK_LIFE + Math.max(0, ...opponents.map((o) => o.fireAtStep ?? 0)) + C.ATTACK_LIFE;

  while (attackAlive && step <= safetyLimit) {
    for (const o of pending) {
      if (!o._fired && o.fireAtStep === step) {
        place(o.side, o.template, o.kind ?? 'disrupt');
        o._fired = true;
      }
    }
    for (let s = 0; s < 2; s++) {
      const survivors = [];
      for (const ant of antsBySide[s]) {
        stepAnt(board, lastToucher, lastToucherSide, ant);
        if (trackPath && ant.id === attackAnt.id) attackPath.push([ant.x, ant.y, ant.dir]);
        const r = resolveAnt(ant);
        const dead = r.dead;
        if (dead) {
          if (ant.id === attackAnt.id) {
            // 消滅した瞬間の座標を控える。得点の有無にかかわらず記録する
            // (§18 の attackFinalX/Y と、§29 の「衝突後 highway 復帰率」の材料)。
            attackFinalX = ant.x;
            attackFinalY = ant.y;
            if (r.reached) {
              // ⚠️ カウンター表の「止めた」は **得点ゲートではなく敵陣到達**で判定する。
              // 発射列 antX は自由に選べるので、ゲート内に落とす antX は必ず存在する。
              // 「ゲートの外にずらした」を成功と数えると、平行移動で無効になる
              // カウンターを記録してしまう(counterTable は deltaX の表であって
              // 絶対座標の表ではない)。
              scored = true;
              // 敵陣へ侵入した x 座標。盤面90度回転により、記述子は y ではなく x を使う(§14)。
              entryX = ant.x;
              entryY = ant.y;
            }
          }
          cleanupAnt(board, lastToucher, lastToucherSide, ant);
          if (ant.id === attackAnt.id) attackAlive = false;
        } else {
          survivors.push(ant);
        }
      }
      antsBySide[s] = survivors;
    }
    step++;
  }

  // バッファを使い回すため、この実行で汚したマスだけを白紙に戻す。
  resetIndices(_versusBuffers, dirty);
  for (const ant of allAnts) resetIndices(_versusBuffers, ant.touched);

  return {
    scored,
    steps: attackAnt.steps,
    entryX,
    entryY,
    attackFinalX,
    attackFinalY,
    path: attackPath,
  };
}

/**
 * path(simulateSolo の trackPath:true の戻り値)から、周期 P・並進 (dx,dy) が
 * 以降ずっと一定になる最小の開始ステップ(onsetStep)を探す。
 */
export function detectHighway(path, maxPeriod = 40) {
  if (!path || path.length < 2) return null;
  const n = path.length;
  const ux = new Array(n);
  const uy = new Array(n);
  ux[0] = path[0][0];
  uy[0] = path[0][1];
  for (let i = 1; i < n; i++) {
    let dx = path[i][0] - path[i - 1][0];
    if (dx > C.WIDTH / 2) dx -= C.WIDTH;
    else if (dx < -C.WIDTH / 2) dx += C.WIDTH;
    const dy = path[i][1] - path[i - 1][1];
    ux[i] = ux[i - 1] + dx;
    uy[i] = uy[i - 1] + dy;
  }

  let best = null;
  for (let period = 1; period <= maxPeriod; period++) {
    if (n - 1 - period < 0) continue;
    const ddx = ux[n - 1] - ux[n - 1 - period];
    const ddy = uy[n - 1] - uy[n - 1 - period];
    let onsetStep = null;
    for (let t = n - 1 - period; t >= 0; t--) {
      const dx = ux[t + period] - ux[t];
      const dy = uy[t + period] - uy[t];
      if (dx === ddx && dy === ddy) {
        onsetStep = t;
      } else {
        break;
      }
    }
    if (onsetStep === null) continue;
    const repeats = (n - 1 - onsetStep) / period;
    if (repeats < 3) continue;
    if (best === null || onsetStep < best.onsetStep) {
      best = { onsetStep, period, dx: ddx, dy: ddy };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 試合
// ---------------------------------------------------------------------------

export function createMatch(options = {}) {
  const seed = options.seed ?? 1;
  const rng = createRng(seed);
  const agents = options.agents ?? [null, null];
  const makeSide = (i) => ({
    index: i,
    score: 0,
    tokens: 0,
    ants: [],
    agent: agents[i] ?? { decide: () => null },
    fired: 0,
    scoredAnts: 0,
    maxFlying: 0,
  });
  return {
    seed,
    rng,
    board: new Uint8Array(C.CELL_COUNT),
    lastToucher: new Int16Array(C.CELL_COUNT).fill(-1),
    lastToucherSide: new Uint8Array(C.CELL_COUNT),
    step: 0,
    phase: 'playing',
    result: null,
    nextAntId: 0,
    sides: [makeSide(0), makeSide(1)],
    scheduled: [],
    // 盤面の非白セル数の増分カウンタ(createSideView の pollution 系が O(1) で参照する)。
    // 更新は board に触る経路(fire / stepAnt / cleanupAnt)だけが行う(下記コメント参照)。
    nonWhiteTotal: 0,
    nonWhiteZone: [0, 0], // 添字 = sideIndex。自陣の配置可能帯(深さ ZONE_DEPTH)の非白セル数
    // 列ごとの非白セル数(v5.3)。発射列を選ぶ判断のために列単位で持つ。
    nonWhiteColumn: new Int32Array(C.WIDTH),

    // ---- 32×32 粗視化盤面 / 自軍アリ別 ownership map(action-centric-contract.md §1.1) ----
    // すべてグローバル coarse 座標(index = cyGlobal * COARSE_SIZE + cxGlobal)。増分更新のみ
    // (盤面へ書き込む経路は stepAnt / fire / cleanupAnt の3つだけ。bumpCounters / bumpOwnership 参照)。
    coarseNonWhite: new Int32Array(C.COARSE_COUNT), // ブロック内の非白セル数 0..64
    coarseOwnedBySide: [
      new Int32Array(C.COARSE_COUNT), // lastToucherSide === 1 のセル数
      new Int32Array(C.COARSE_COUNT), // lastToucherSide === 2 のセル数
    ],
    // 自軍アリ別 ownership。[sideIndex][slot] で 32×32。slot は 0..MAX_FLYING-1。
    coarseOwnedByAnt: [
      Array.from({ length: C.MAX_FLYING }, () => new Int32Array(C.COARSE_COUNT)),
      Array.from({ length: C.MAX_FLYING }, () => new Int32Array(C.COARSE_COUNT)),
    ],
    // 各スロットに今どのアリが居るか(空きは -1)。fire でスロット確保、消滅で解放。
    antSlotOccupant: [new Int8Array(C.MAX_FLYING).fill(-1), new Int8Array(C.MAX_FLYING).fill(-1)],
    // セルの現在の所有アリのスロット番号+1(0 = 所有者なし)。lastToucher と同じ長さ。
    // アリIDからスロットを引く Map 参照をホットパス(stepAnt)に入れないための実装上の要請。
    lastToucherSlot: new Uint8Array(C.CELL_COUNT),
  };
}

export function createSideView(match, sideIndex) {
  const side = match.sides[sideIndex];
  const enemy = match.sides[1 - sideIndex];
  const toView = (ant, isMine) => ({
    id: ant.id,
    kind: ant.kind,
    x: ant.x,
    y: toLocalY(sideIndex, toGlobalY(ant.sideIndex, ant.y)),
    dir: mirrorDir(sideIndex, mirrorDir(ant.sideIndex, ant.dir)),
    steps: ant.steps,
    life: ant.life,
    firedAtStep: ant.firedAtStep,
    templateId: ant.templateId,
    // 発射した陣営自身のローカル座標での「発射位置・向き」。
    // identifyTable は v5 で **"antY,antDir"** をキーにする(発射列 antX は
    // 発射時に選ぶ自由度になったので識別キーに使えない)。spawnX は迎撃の発射列を
    // deltaX から求めるために使う(counterTable の deltaX は攻撃の発射列からの相対)。
    // ⚠️ ant.x/y/dir は毎ステップ動くので識別には使えない(発射した次のステップには
    // もう1マス進んでいる)。必ず spawn* を使うこと。
    spawnX: ant.spawnX,
    spawnY: ant.spawnY,
    spawnDir: ant.spawnDir,
    // 発射した陣営自身のローカル座標での「現在位置」(描画・距離計算用)。
    ownerX: ant.x,
    ownerY: ant.y,
    ownerDir: ant.dir,
    // 自軍アリの ownership スロット番号(action-centric-contract.md §1.4)。
    // 自軍のみ意味を持つ(coarseOwnedByAnt の添字に使う)。敵アリは -1。
    slot: isMine ? ant.slot : -1,
  });
  // 自軍アリ別 ownership(§1.4)。空きスロットは null。coarseOwnedByAnt の要素そのものは
  // 参照渡し(コピーしない)。ここで新しく作るのは「どのスロットが埋まっているか」を
  // 示す長さ MAX_FLYING のポインタ配列だけで、1024要素の Int32Array は複製しない。
  const coarseAntOwned = new Array(C.MAX_FLYING);
  for (let slot = 0; slot < C.MAX_FLYING; slot++) {
    coarseAntOwned[slot] =
      match.antSlotOccupant[sideIndex][slot] === -1 ? null : match.coarseOwnedByAnt[sideIndex][slot];
  }
  return {
    sideIndex,
    step: match.step,
    elapsedSec: match.step / C.STEPS_PER_SECOND,
    tokens: side.tokens,
    score: side.score,
    enemyScore: enemy.score,
    flyingCount: side.ants.length,
    myAnts: side.ants.map((ant) => toView(ant, true)),
    enemyAnts: enemy.ants.map((ant) => toView(ant, false)),
    // 盤面の派生スカラー(増分カウンタから O(1) で算出。全走査しない)。
    boardPollution: match.nonWhiteTotal / C.CELL_COUNT,
    myZonePollution: match.nonWhiteZone[sideIndex] / (C.WIDTH * C.ZONE_DEPTH),
    enemyZonePollution: match.nonWhiteZone[1 - sideIndex] / (C.WIDTH * C.ZONE_DEPTH),

    // ---- 盤面そのもの(v5.3) --------------------------------------------
    // ⚠️ **参照渡し。コピーしない。** view は学習1回で約4,600万回作られるので、
    // 65,536セルのコピーを1回でも挟むと学習が終わらない。読み取り専用として扱うこと
    // (view の利用側が書き換えると試合が壊れる)。
    //
    // ⚠️ 利用側の責任: これを毎判断で全走査してはいけない(同じ理由で学習が破綻する)。
    // 「どの列が汚れているか」を知りたいだけなら下の columnPollution を使うこと。
    // 盤面全体が要るのは描画・デバッグ・限定的な局所参照(特定の数マスを見る)だけ。
    board: match.board,
    // 最後に触れた陣営(0=誰も触れていない / 1=side0 / 2=side1)。これも参照渡し。
    lastToucherSide: match.lastToucherSide,
    // 列ごとの非白セル数(長さ WIDTH の Int32Array・参照渡し)。増分更新なので O(1)。
    // 「発射列をどこにするか」を盤面から決めるための、実用上いちばん重要な信号。
    columnNonWhite: match.nonWhiteColumn,

    // ---- 32×32 粗視化盤面 / 自軍アリ別 ownership map(action-centric-contract.md §1.4) ----
    // すべて参照渡し(コピー禁止)。グローバル coarse 座標のまま渡す。ローカル変換は
    // 利用側が C.coarseLocalRow(sideIndex, cy) で行う。
    coarseNonWhite: match.coarseNonWhite, // Int32Array(1024) 参照
    coarseOwnedMine: match.coarseOwnedBySide[sideIndex], // Int32Array(1024) 参照
    coarseOwnedEnemy: match.coarseOwnedBySide[1 - sideIndex], // Int32Array(1024) 参照
    coarseAntOwned, // (Int32Array|null)[MAX_FLYING]
  };
}

// ⚠️ コスト式そのものは持たない。src/config.js の costOf が唯一の定義(v5.5)。
// 外部から import されているため export だけ残す再輸出。
export const costOf = C.costOf;

export function canFire(match, sideIndex, action) {
  const side = match.sides[sideIndex];
  if (!action || !C.ANT_KINDS[action.kind]) return { ok: false, reason: 'kind' };
  const cells = action.cells ?? [];
  if (cells.length > C.MAX_CELLS) return { ok: false, reason: 'cells' };
  for (const cell of cells) {
    const y = cell[1];
    if (y < 0 || y >= C.ZONE_DEPTH) return { ok: false, reason: 'zone' };
  }
  if (side.ants.length >= C.MAX_FLYING) return { ok: false, reason: 'flying' };
  const cost = costOf(action.kind, cells.length);
  if (side.tokens < cost) return { ok: false, reason: 'tokens' };
  return { ok: true, reason: null };
}

export function fire(match, sideIndex, action) {
  const check = canFire(match, sideIndex, action);
  if (!check.ok) return null;
  const side = match.sides[sideIndex];
  const cells = action.cells ?? [];
  const cost = costOf(action.kind, cells.length);
  // スロット確保(action-centric-contract.md §1.3): 空き(-1)を添字の小さい順に探す。
  // canFire が MAX_FLYING を弾くので空きが無いのはありえないはずだが、
  // 念のため slot=-1(空きなし)なら発射失敗として扱う。
  const occupant = match.antSlotOccupant[sideIndex];
  let slot = -1;
  for (let i = 0; i < occupant.length; i++) {
    if (occupant[i] === -1) {
      slot = i;
      break;
    }
  }
  if (slot === -1) return null;
  side.tokens -= cost;
  const antId = match.nextAntId++;
  occupant[slot] = antId;
  for (const cell of cells) {
    const [x, y] = cell;
    const gy = toGlobalY(sideIndex, y);
    const j = idx(x, gy);
    const wasZero = match.board[j] === 0;
    const newVal = cellState(cell);
    bumpCounters(match, x, gy, wasZero, newVal === 0);
    // ⚠️ fire() の配置マスも ownership に計上する。stepAnt の oldAnt→newAnt 遷移だけでなく、
    // ここも lastToucher[j] を書き込む経路なので、落とすと ownedTrailAmount が
    // 実際の cleanup セル数と食い違う(action-centric-contract.md §1.2)。
    const oldSide = match.lastToucherSide[j];
    const oldSlot = match.lastToucherSlot[j];
    match.board[j] = newVal;
    match.lastToucher[j] = antId;
    match.lastToucherSide[j] = sideIndex + 1;
    match.lastToucherSlot[j] = slot + 1;
    bumpOwnership(match, x, gy, oldSide, oldSlot, sideIndex + 1, slot + 1);
  }
  const rule = action.rule ?? C.LEGACY_RULE;
  const ant = {
    id: antId,
    sideIndex,
    kind: action.kind,
    rule,
    colorCount: rule.length,
    x: action.antX,
    y: action.antY,
    dir: action.antDir,
    // 発射時の位置・向きを保存する。x/y/dir は毎ステップ動くので、
    // identifyTable("antY,antDir") を引くには spawnY/spawnDir を使う。
    // spawnX は counterTable の deltaX を絶対列に直すのに使う。
    spawnX: action.antX,
    spawnY: action.antY,
    spawnDir: action.antDir,
    steps: 0,
    life: C.ANT_KINDS[action.kind].life,
    cells,
    // 踏んだマスの添字。cleanupAnt が全盤面(65,536マス)を走査しないために必要。
    touched: [],
    firedAtStep: match.step,
    templateId: action.templateId ?? null,
    // ownership map(coarseOwnedByAnt)の自分の添字。antSlotOccupant[sideIndex][slot] = antId。
    slot,
  };
  side.ants.push(ant);
  side.fired++;
  side.maxFlying = Math.max(side.maxFlying, side.ants.length);
  return antId;
}

export function scheduleFire(match, sideIndex, action, atStep) {
  match.scheduled.push({ sideIndex, action, atStep });
}

/** 1陣営のアリを発射順に全部移動させる。消滅したアリはクリーンアップして配列から除く。 */
function moveSide(match, side) {
  const survivors = [];
  for (const ant of side.ants) {
    stepAnt(match.board, match.lastToucher, match.lastToucherSide, ant, match);
    const { dead, scored } = resolveAnt(ant);
    if (dead) {
      if (scored) {
        side.score++;
        side.scoredAnts++;
      }
      cleanupAnt(match.board, match.lastToucher, match.lastToucherSide, ant, match);
      // スロット解放(action-centric-contract.md §1.3)。cleanupAnt が正しければ fill(0) は
      // 冗長だが、不変条件の保険として必ず行う。
      match.antSlotOccupant[side.index][ant.slot] = -1;
      match.coarseOwnedByAnt[side.index][ant.slot].fill(0);
    } else {
      survivors.push(ant);
    }
  }
  side.ants = survivors;
}

/**
 * 飛行中の自分のアリを自爆できるか。
 * 敵陣営のアリIDは対象にできない(自分の side.ants に無ければ false)。
 */
export function canSelfDestruct(match, sideIndex, antId) {
  if (match.phase === 'finished') return false;
  const side = match.sides[sideIndex];
  if (!side) return false;
  const ant = side.ants.find((a) => a.id === antId);
  if (!ant) return false;
  return side.tokens >= C.SELF_DESTRUCT_COST;
}

/**
 * 飛行中の自分のアリを任意のタイミングで消す。得点しない。
 * 跡の消し方は通常の消滅(cleanupAnt)と完全に同じにする(新しい経路を作らない)。
 */
export function selfDestruct(match, sideIndex, antId) {
  if (!canSelfDestruct(match, sideIndex, antId)) return false;
  const side = match.sides[sideIndex];
  const ant = side.ants.find((a) => a.id === antId);
  side.tokens -= C.SELF_DESTRUCT_COST;
  cleanupAnt(match.board, match.lastToucher, match.lastToucherSide, ant, match);
  // スロット解放(action-centric-contract.md §1.3)。moveSide の消滅処理と同じ規律。
  match.antSlotOccupant[sideIndex][ant.slot] = -1;
  match.coarseOwnedByAnt[sideIndex][ant.slot].fill(0);
  side.ants = side.ants.filter((a) => a.id !== antId);
  return true;
}

export function stepMatch(match) {
  if (match.phase === 'finished') return match;
  const s = match.step;

  // 1. トークン加算(120ステップに1回。ステップ0でも加算する)
  if (s % C.TOKEN_TICK_STEPS === 0) {
    for (const side of match.sides) {
      side.tokens = Math.min(C.TOKEN_CAP, side.tokens + C.TOKEN_PER_TICK);
    }
  }

  // このステップで陣営を処理する順序。
  // 毎ステップ固定で side0 が先だと、side0 のアリが常に先に盤面へ書き込むため
  // side0 の迎撃が構造的に半ステップ早く効く(実測で先手勝率100%・平均得点 4.88 対 2.04)。
  // 1ステップごとに先後を入れ替えて、この分のテンポ優位を打ち消す。
  const order = C.ALTERNATE_STEP_ORDER && s % 2 === 1 ? [1, 0] : [0, 1];

  // 判断フェーズの手番は「判断が何回目か」の偶奇で入れ替える。
  //
  // ⚠️ **判断周期の偶奇に依存しない書き方にしてある。** v5.x では
  // DECISION_INTERVAL_STEPS が偶数(670)だったため判断ステップ s は常に偶数で、移動用の
  // order（s の偶奇）をそのまま使うと判断フェーズは永久に side0 が先のままになり、
  // side0 が必ず先に迎撃・攻撃を決められる構造的優位が残った
  // （実測: 攻撃の得点率 side0=28.7% 対 side1=14.8%、勝率 100%対0%）。
  // v6.1 で判断周期を 67(奇数)にしたので s の偶奇は判断ごとに入れ替わるが、
  // 「判断が何回目か」で決める decisionOrder なら**周期の偶奇によらず必ず交互になる**ので
  // ここは変更不要(この独立性こそが decisionOrder を導入した目的)。
  //
  // ⚠️ v5.2: 予約発射フェーズも同じ入れ替えを使う。配置マスは陣営ごとに別の帯
  // (side0 は上端32行 / side1 は下端32行)へ書くので **この順序自体は結果に影響しない**
  // ことを実測で確認済み(先手勝率 69.3% → 69.0%、変化なし)。それでも order ではなく
  // decisionOrder を使うのは、「常に片側が先」という退化した状態をコード上に残さないため。
  //
  // 🚧 v5.2 で観測された先手勝率 69% の真因はここではない(順序は無関係)。
  // 「防御を使うほど先手が有利になる」相関は実在する
  // (同一方策どうし600試合: defendBias 0→0.2→0.5→1.0 で side0 勝率 0.548→0.623→0.742→0.729)。
  //
  // ⚠️ v5.2 ではこれを「カウンター表のキラリティ(干渉評価が攻撃=side0/妨害=side1 の一方向でしか
  // 行われない)」と診断していたが、**v5.3 の直接検証で反証した**。各攻撃の最良カウンターを
  // 実試合で両方の向きに走らせると 9件中8件が両向きで阻止でき、唯一の非対称例はむしろ鏡像側で
  // だけ成立した(キラリティ仮説と逆)。向き依存はほぼ無い。
  // 現時点で「防御が機能しない」直接原因は**迎撃の照準窓の狭さ**(阻止できる発射列は平均 17/256
  // = 6.6%、最狭で1列)。docs/spec.md「未決定事項 (a)」参照。
  const decisionOrder =
    C.ALTERNATE_STEP_ORDER && Math.floor(s / C.DECISION_INTERVAL_STEPS) % 2 === 1 ? [1, 0] : [0, 1];

  // 2. 予約発射(fireAtStep ちょうどに実行する)
  const remaining = [];
  for (const i of decisionOrder) {
    for (const sch of match.scheduled) {
      if (sch.sideIndex === i && sch.atStep === s) {
        fire(match, i, sch.action);
      }
    }
  }
  for (const sch of match.scheduled) {
    if (sch.atStep !== s) remaining.push(sch);
  }
  match.scheduled = remaining;

  // 3. 新しい判断(120ステップに1回)
  if (s % C.DECISION_INTERVAL_STEPS === 0) {
    // 両陣営の判断は「同時」に行う。先に view を2つとも取ってから decide を呼ぶ。
    // 逐次に処理すると、後に判断する側だけが「相手がこのステップで撃ったばかりのアリ」を
    // view で見られてしまい、情報の非対称が生まれる（実測でこれが勝率100%対0%の正体だった）。
    const views = [createSideView(match, 0), createSideView(match, 1)];
    const actions = [];
    for (let i = 0; i < 2; i++) {
      const agent = match.sides[i].agent;
      actions[i] = agent && typeof agent.decide === 'function' ? agent.decide(views[i]) : null;
    }
    // 実際の発射は決めた後にまとめて行う。配置マスは陣営ごとに別の帯なので順序は結果に影響しない。
    for (const i of decisionOrder) {
      if (actions[i]) fire(match, i, actions[i]);
    }
  }

  // 4. アリの移動(先手の陣営を発射順に全部 → 後手の陣営を発射順に全部)
  moveSide(match, match.sides[order[0]]);
  moveSide(match, match.sides[order[1]]);

  // 5. 勝敗判定
  if (match.sides[0].score >= C.WIN_SCORE || match.sides[1].score >= C.WIN_SCORE) {
    match.phase = 'finished';
    const s0 = match.sides[0].score;
    const s1 = match.sides[1].score;
    match.result = s0 > s1 ? 'side1' : s1 > s0 ? 'side2' : 'draw';
  }

  match.step++;

  if (match.phase !== 'finished' && match.step >= C.TOTAL_STEPS) {
    match.phase = 'finished';
    const s0 = match.sides[0].score;
    const s1 = match.sides[1].score;
    match.result = s0 > s1 ? 'side1' : s1 > s0 ? 'side2' : 'draw';
  }

  return match;
}

export function runMatch(match) {
  while (match.phase !== 'finished') stepMatch(match);
  return match;
}

export function getStats(match) {
  const scores = [match.sides[0].score, match.sides[1].score];
  let winner = null;
  if (match.result === 'side1') winner = 0;
  else if (match.result === 'side2') winner = 1;
  let pollutedCount = 0;
  for (let i = 0; i < match.board.length; i++) {
    if (match.board[i] !== 0) pollutedCount++;
  }
  return {
    scores,
    winner,
    result: match.result,
    steps: match.step,
    durationSec: match.step / C.STEPS_PER_SECOND,
    pollution: pollutedCount / match.board.length,
    fired: [match.sides[0].fired, match.sides[1].fired],
    scoredAnts: [match.sides[0].scoredAnts, match.sides[1].scoredAnts],
    maxConcurrentFlying: [match.sides[0].maxFlying, match.sides[1].maxFlying],
  };
}
