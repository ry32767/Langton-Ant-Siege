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
 * アリを1歩進める。
 * 「回転は踏んだ時点の状態で決める」(進める前の状態を読んでから状態を進める)。
 * 盤面の生値はアリの色数で割った余りとして解釈する(異種ルールの衝突)。
 */
function stepAnt(board, lastToucher, lastToucherSide, ant) {
  const gy = toGlobalY(ant.sideIndex, ant.y);
  const j = idx(ant.x, gy);
  const raw = board[j];
  const s = raw % ant.colorCount;
  ant.dir = ant.rule[s] === 'R' ? (ant.dir + 1) & 3 : (ant.dir + 3) & 3;
  board[j] = (s + 1) % ant.colorCount;
  lastToucher[j] = ant.id;
  lastToucherSide[j] = ant.sideIndex + 1;
  const d = C.DIRS[ant.dir];
  ant.x = (ant.x + d[0] + C.WIDTH) % C.WIDTH; // 左右はトーラス
  ant.y = ant.y + d[1]; // 上下はラップしない(素の加算)
  ant.steps++;
}

/**
 * アリ消滅時のクリーンアップ。
 * { 配置マスのうち lastToucher が -1 か自分 } ∪ { lastToucher が自分と一致する全マス } を白に戻す。
 */
function cleanupAnt(board, lastToucher, lastToucherSide, ant) {
  for (const cell of ant.cells) {
    const [x, y] = cell;
    const q = idx(x, toGlobalY(ant.sideIndex, y));
    if (lastToucher[q] === -1 || lastToucher[q] === ant.id) {
      board[q] = 0;
      lastToucher[q] = -1;
      lastToucherSide[q] = 0;
    }
  }
  for (let q = 0; q < board.length; q++) {
    if (lastToucher[q] === ant.id) {
      board[q] = 0;
      lastToucher[q] = -1;
      lastToucherSide[q] = 0;
    }
  }
}

/** 前進後の判定。dead / scored を返す(盤面操作はしない)。判定は前進後、この順。 */
function resolveAnt(ant) {
  if (ant.y < 0) return { dead: true, scored: false };
  if (ant.y >= C.SCORE_LINE_Y) return { dead: true, scored: true };
  if (ant.steps >= ant.life) return { dead: true, scored: false };
  return { dead: false, scored: false };
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
// オフライン用の単体シミュレーション
// ---------------------------------------------------------------------------

/**
 * 空盤面に template.cells を置いてアリ1匹を寿命まで走らせる(side0 固定)。
 * rule は template.rule か options.rule を使う(どちらも無ければ C.LEGACY_RULE)。
 */
export function simulateSolo(template, options = {}) {
  const board = new Uint8Array(C.CELL_COUNT);
  const lastToucher = new Int16Array(C.CELL_COUNT).fill(-1);
  const lastToucherSide = new Uint8Array(C.CELL_COUNT);
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
  };
  const trackPath = !!options.trackPath;
  const path = trackPath ? [[ant.x, ant.y]] : undefined;
  let scored = false;
  let entryY = null;
  for (;;) {
    stepAnt(board, lastToucher, lastToucherSide, ant);
    if (trackPath) path.push([ant.x, ant.y]);
    const { dead, scored: didScore } = resolveAnt(ant);
    if (dead) {
      if (didScore) {
        scored = true;
        entryY = ant.y;
      }
      break;
    }
  }
  return { scored, steps: ant.steps, entryY, endX: ant.x, endY: ant.y, path };
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
  };
  const trackPath = !!options.trackPath;
  const path = trackPath ? [[ant.x, ant.y]] : undefined;
  for (;;) {
    touched.push(idx(ant.x, ant.y));
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
  const board = new Uint8Array(C.CELL_COUNT);
  const lastToucher = new Int16Array(C.CELL_COUNT).fill(-1);
  const lastToucherSide = new Uint8Array(C.CELL_COUNT);
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
    };
    antsBySide[sideIndex].push(ant);
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
        const { dead, scored: didScore } = resolveAnt(ant);
        if (dead) {
          if (ant.id === attackAnt.id) {
            // 消滅した瞬間の座標を控える。得点の有無にかかわらず記録する
            // (§18 の attackFinalX/Y と、§29 の「衝突後 highway 復帰率」の材料)。
            attackFinalX = ant.x;
            attackFinalY = ant.y;
            if (didScore) {
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
  };
}

export function createSideView(match, sideIndex) {
  const side = match.sides[sideIndex];
  const enemy = match.sides[1 - sideIndex];
  const toView = (ant) => ({
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
    // identifyTable("antX,antY,antDir") はこのキーで引く。
    // ⚠️ ant.x/y/dir は毎ステップ動くので識別には使えない(発射した次のステップには
    // もう1マス進んでいる)。必ず spawn* を使うこと。
    spawnX: ant.spawnX,
    spawnY: ant.spawnY,
    spawnDir: ant.spawnDir,
    // 発射した陣営自身のローカル座標での「現在位置」(描画・距離計算用)。
    ownerX: ant.x,
    ownerY: ant.y,
    ownerDir: ant.dir,
  });
  return {
    sideIndex,
    step: match.step,
    elapsedSec: match.step / C.STEPS_PER_SECOND,
    tokens: side.tokens,
    score: side.score,
    enemyScore: enemy.score,
    flyingCount: side.ants.length,
    myAnts: side.ants.map(toView),
    enemyAnts: enemy.ants.map(toView),
  };
}

export function costOf(kind, cellCount) {
  return C.ANT_KINDS[kind].baseCost + cellCount;
}

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
  side.tokens -= cost;
  const antId = match.nextAntId++;
  for (const cell of cells) {
    const [x, y] = cell;
    const j = idx(x, toGlobalY(sideIndex, y));
    match.board[j] = cellState(cell);
    match.lastToucher[j] = antId;
    match.lastToucherSide[j] = sideIndex + 1;
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
    // identifyTable("antX,antY,antDir") を引くにはこちらを使う。
    spawnX: action.antX,
    spawnY: action.antY,
    spawnDir: action.antDir,
    steps: 0,
    life: C.ANT_KINDS[action.kind].life,
    cells,
    firedAtStep: match.step,
    templateId: action.templateId ?? null,
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
    stepAnt(match.board, match.lastToucher, match.lastToucherSide, ant);
    const { dead, scored } = resolveAnt(ant);
    if (dead) {
      if (scored) {
        side.score++;
        side.scoredAnts++;
      }
      cleanupAnt(match.board, match.lastToucher, match.lastToucherSide, ant);
    } else {
      survivors.push(ant);
    }
  }
  side.ants = survivors;
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
  // ⚠️ DECISION_INTERVAL_STEPS は偶数なので、判断が走るステップ s は常に偶数になる。
  // 移動用の order（s の偶奇）をそのまま使うと判断フェーズは永久に side0 が先のままで、
  // side0 が毎秒必ず先に迎撃・攻撃を決められる構造的優位が残る
  // （実測: 攻撃の得点率 side0=28.7% 対 side1=14.8%、勝率 100%対0%）。
  const decisionOrder =
    C.ALTERNATE_STEP_ORDER && Math.floor(s / C.DECISION_INTERVAL_STEPS) % 2 === 1 ? [1, 0] : [0, 1];

  // 2. 予約発射(fireAtStep ちょうどに実行する)
  const remaining = [];
  for (const i of order) {
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
