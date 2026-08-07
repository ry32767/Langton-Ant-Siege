// genome の突然変異オペレータ。純粋なデータ操作のみ(engine.js は import しない)。
// 数値定数は src/config.js から取り、直書きしない(AGENTS.md「コーディング規約」)。
//
// ⚠️ v5: genome から antX(発射列)が消え、cells が **アリからの相対 (dx, dy)** に
// なったのに合わせて、antX 系のオペレータを削除し、セル系のオペレータを近傍
// (TEMPLATE_CELL_RADIUS)と配置帯(ZONE_DEPTH)の両方でクランプするように変えた。

import {
  MIN_COLORS,
  MAX_COLORS,
  MAX_CELLS,
  MIN_TEMPLATE_CELLS,
  ZONE_DEPTH,
  TEMPLATE_CELL_RADIUS,
  MUTATION_COUNT_WEIGHTS,
} from '../config.js';
import { cloneGenome, canonicalRule, isCellDyInZone } from './genome.js';

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

/** (dx,dy) が cells 内のいずれかと重複するか。 */
function collides(cells, dx, dy, ignoreIndex = -1) {
  return cells.some((c, i) => i !== ignoreIndex && c.dx === dx && c.dy === dy);
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
  // アリ近傍((2R+1)^2 マス)は MAX_CELLS(16)より十分広いので、少ない試行回数で
  // ほぼ確実に空きが見つかる。見つからなければ何もしない(no-op)。
  const R = TEMPLATE_CELL_RADIUS;
  const MAX_ATTEMPTS = 50;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const dx = randInt(rng, 2 * R + 1) - R;
    const dy = randInt(rng, 2 * R + 1) - R;
    if (!isCellDyInZone(g.antY, dy)) continue; // 配置帯からはみ出す
    if (collides(g.cells, dx, dy)) continue;
    g.cells.push({ dx, dy, state: randInt(rng, g.rule.length) });
    return;
  }
}

function opCellDelete(g, rng) {
  const i = randInt(rng, g.cells.length);
  g.cells.splice(i, 1);
}

function opCellMove(g, rng) {
  // 1マスずらす移動(reject 方式)。近傍半径にクランプし、配置帯を出る移動と
  // 座標が重複する移動はこの変異を no-op として reject する。
  const R = TEMPLATE_CELL_RADIUS;
  const i = randInt(rng, g.cells.length);
  const cell = g.cells[i];
  const axis = randInt(rng, 2); // 0:dx, 1:dy
  const delta = rng() < 0.5 ? -1 : 1;
  let ndx = cell.dx;
  let ndy = cell.dy;
  if (axis === 0) ndx = Math.max(-R, Math.min(R, cell.dx + delta));
  else ndy = Math.max(-R, Math.min(R, cell.dy + delta));
  if (!isCellDyInZone(g.antY, ndy)) return; // reject: 配置帯を出る
  if (collides(g.cells, ndx, ndy, i)) return; // reject: 座標重複になる
  cell.dx = ndx;
  cell.dy = ndy;
}

function opCellState(g, rng) {
  const i = randInt(rng, g.cells.length);
  g.cells[i].state = randInt(rng, g.rule.length);
}

/**
 * アリの行を1つ動かす。
 * ⚠️ cells は相対座標なので、アリが動くと配置マスも一緒に動く。動かした先で
 * 配置マスが配置帯からはみ出す場合は reject(no-op)にする。
 * clamp ではなく reject にしているのは、clamp だと「はみ出したセルだけ潰れる」ような
 * 中途半端な状態を作ってしまい、平行移動という意味が壊れるため。
 */
function moveAntY(g, delta) {
  const ny = g.antY + delta;
  if (ny < 0 || ny >= ZONE_DEPTH) return;
  for (const cell of g.cells) {
    if (!isCellDyInZone(ny, cell.dy)) return; // reject
  }
  g.antY = ny;
}
function opAntYPlus(g) {
  moveAntY(g, +1);
}
function opAntYMinus(g) {
  moveAntY(g, -1);
}
function opAntDir(g, rng) {
  g.antDir = randInt(rng, 4);
}

/** その時点の genome に対して適用可能なオペレータ名の一覧を返す。 */
function applicableOperators(g) {
  const ops = ['bitFlip', 'cellState', 'antYPlus', 'antYMinus', 'antDir'];
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
  g.origin = 'mutation';
  const count = pickMutationCount(rng);
  for (let i = 0; i < count; i++) applyOneMutation(g, rng);
  return g;
}
