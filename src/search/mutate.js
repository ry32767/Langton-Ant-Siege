// genome の突然変異オペレータ。純粋なデータ操作のみ(engine.js は import しない)。
// 数値定数は src/config.js から取り、直書きしない(AGENTS.md「コーディング規約」)。

import {
  MIN_COLORS,
  MAX_COLORS,
  MAX_CELLS,
  MIN_TEMPLATE_CELLS,
  WIDTH,
  ZONE_DEPTH,
  MUTATION_COUNT_WEIGHTS,
} from '../config.js';
import { cloneGenome, canonicalRule } from './genome.js';

/** rng の [0,n) 整数を返す(n は正整数)。 */
function randInt(rng, n) {
  return Math.floor(rng() * n);
}

/** ランダムな 'L'/'R' の1文字を返す。 */
function randRuleChar(rng) {
  return rng() < 0.5 ? 'L' : 'R';
}

/** MUTATION_COUNT_WEIGHTS([0.7,0.2,0.1] = 1回/2回/3回)に従って適用回数を決める。 */
function pickMutationCount(rng) {
  const r = rng();
  let acc = 0;
  for (let i = 0; i < MUTATION_COUNT_WEIGHTS.length; i++) {
    acc += MUTATION_COUNT_WEIGHTS[i];
    if (r < acc) return i + 1;
  }
  return MUTATION_COUNT_WEIGHTS.length; // 浮動小数点の丸め誤差対策
}

/** ルール長が変わった直後、全セルの state をルール長でラップする(§6.1)。 */
function rewrapCellStates(g) {
  const colorCount = g.rule.length;
  for (const cell of g.cells) cell.state %= colorCount;
}

/**
 * ルール変異(bitFlip/ruleInsert/ruleDelete)の候補文字列を原始形に正規化して適用する。
 * §8「ルールは原始形に正規化する」準拠。
 * 原始形の長さが MIN_COLORS 未満('L'/'R'単独)になる場合はこの変異全体を reject する(no-op)。
 * ルール長が変わった(正規化で縮んだ、または元々長さが変わる変異だった)場合は
 * 全セルの state をラップし直す。
 */
function applyCanonicalRule(g, candidateRule) {
  const canon = canonicalRule(candidateRule);
  if (canon.length < MIN_COLORS) return; // reject: 何もしない
  const lenChanged = canon.length !== g.rule.length;
  g.rule = canon;
  if (lenChanged) rewrapCellStates(g);
}

/** (x,y) が cells 内のいずれかと重複するか。 */
function collides(cells, x, y, ignoreIndex = -1) {
  return cells.some((c, i) => i !== ignoreIndex && c.x === x && c.y === y);
}

// ---- 個々の変異オペレータ ---------------------------------------------------
// それぞれ genome(g) を直接書き換える(g はこのモジュールが所有するクローンなので破壊してよい)。

function opBitFlip(g, rng) {
  const i = randInt(rng, g.rule.length);
  const chars = g.rule.split('');
  chars[i] = chars[i] === 'L' ? 'R' : 'L';
  applyCanonicalRule(g, chars.join(''));
}

function opRuleInsert(g, rng) {
  const pos = randInt(rng, g.rule.length + 1);
  const candidate = g.rule.slice(0, pos) + randRuleChar(rng) + g.rule.slice(pos);
  applyCanonicalRule(g, candidate);
}

function opRuleDelete(g, rng) {
  const pos = randInt(rng, g.rule.length);
  const candidate = g.rule.slice(0, pos) + g.rule.slice(pos + 1);
  applyCanonicalRule(g, candidate);
}

function opCellAdd(g, rng) {
  // 配置帯(WIDTH*ZONE_DEPTH=960マス)はセル数上限(16)より十分広いので、
  // 少ない試行回数でほぼ確実に空きマスが見つかる。見つからなければ何もしない(no-op)。
  const MAX_ATTEMPTS = 50;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const x = randInt(rng, WIDTH);
    const y = randInt(rng, ZONE_DEPTH);
    if (!collides(g.cells, x, y)) {
      g.cells.push({ x, y, state: randInt(rng, g.rule.length) });
      return;
    }
  }
}

function opCellDelete(g, rng) {
  const i = randInt(rng, g.cells.length);
  g.cells.splice(i, 1);
}

function opCellMove(g, rng) {
  // 配置帯の中へ1マスずらす移動(reject 方式)。境界は配置帯にクランプし、
  // 移動先が既存の別セルと重複する場合はこの変異を no-op として reject する。
  const i = randInt(rng, g.cells.length);
  const cell = g.cells[i];
  const axis = randInt(rng, 2); // 0:x, 1:y
  const delta = rng() < 0.5 ? -1 : 1;
  let nx = cell.x;
  let ny = cell.y;
  if (axis === 0) nx = Math.max(0, Math.min(WIDTH - 1, cell.x + delta));
  else ny = Math.max(0, Math.min(ZONE_DEPTH - 1, cell.y + delta));
  if (collides(g.cells, nx, ny, i)) return; // reject: 座標重複になるので何もしない
  cell.x = nx;
  cell.y = ny;
}

function opCellState(g, rng) {
  const i = randInt(rng, g.cells.length);
  g.cells[i].state = randInt(rng, g.rule.length);
}

// アリの X は盤面全体(WIDTH)をトーラスとして扱うため mod で常に有効域に収まる。
// Y は配置帯(ZONE_DEPTH)の境界を越えられないので clamp する(reject にすると
// 境界上のアリが Y 方向にだけ変異できなくなり退化するため clamp を選んだ)。
function opAntXPlus(g) {
  g.antX = (g.antX + 1) % WIDTH;
}
function opAntXMinus(g) {
  g.antX = (g.antX - 1 + WIDTH) % WIDTH;
}
function opAntYPlus(g) {
  g.antY = Math.min(ZONE_DEPTH - 1, g.antY + 1);
}
function opAntYMinus(g) {
  g.antY = Math.max(0, g.antY - 1);
}
function opAntDir(g, rng) {
  g.antDir = randInt(rng, 4);
}

/** その時点の genome に対して適用可能なオペレータ名の一覧を返す。 */
function applicableOperators(g) {
  const ops = ['bitFlip', 'cellState', 'antXPlus', 'antXMinus', 'antYPlus', 'antYMinus', 'antDir'];
  if (g.rule.length < MAX_COLORS) ops.push('ruleInsert');
  if (g.rule.length > MIN_COLORS) ops.push('ruleDelete');
  if (g.cells.length < MAX_CELLS) ops.push('cellAdd');
  if (g.cells.length > MIN_TEMPLATE_CELLS) ops.push('cellDelete');
  ops.push('cellMove'); // 1個以上は必ずあるので常に適用可能
  return ops;
}

const OPERATORS = Object.freeze({
  bitFlip: opBitFlip,
  ruleInsert: opRuleInsert,
  ruleDelete: opRuleDelete,
  cellAdd: opCellAdd,
  cellDelete: opCellDelete,
  cellMove: opCellMove,
  cellState: opCellState,
  antXPlus: opAntXPlus,
  antXMinus: opAntXMinus,
  antYPlus: opAntYPlus,
  antYMinus: opAntYMinus,
  antDir: opAntDir,
});

/** 現在の genome に対して、適用可能なオペレータを1つだけランダムに適用する。 */
function applyOneMutation(g, rng) {
  const ops = applicableOperators(g);
  const name = ops[randInt(rng, ops.length)];
  OPERATORS[name](g, rng);
  return g;
}

/**
 * genome を1つ受け取り、突然変異を適用した新しい genome を返す(引数は破壊しない)。
 * MUTATION_COUNT_WEIGHTS に従って1〜3回の変異を連鎖適用する。
 */
export function mutate(genome, rng) {
  const g = cloneGenome(genome);
  const count = pickMutationCount(rng);
  for (let i = 0; i < count; i++) applyOneMutation(g, rng);
  return g;
}
