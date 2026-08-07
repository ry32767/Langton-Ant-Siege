// MAP-Elites 探索用の genome 表現。純粋なデータ操作のみ(engine.js は import しない)。
// genome の形・不変条件は AGENTS.md 経由の作業指示(タスク仕様)で確定済み。
//
// genome = {
//   rule: 'L'/'R' のみからなる文字列。長さ = colorCount(重複して持たない。rule.length から導出)
//   antX, antY: 配置帯(side1)内のアリの初期位置
//   antDir: 0|1|2|3
//   cells: [{ x, y, state }, ...] 配置マス(座標は重複しない)
// }

import { MIN_COLORS, MAX_COLORS, MAX_CELLS, MIN_TEMPLATE_CELLS, WIDTH, ZONE_DEPTH } from '../config.js';

/** rng の [0,n) 整数を返す(n は正整数)。 */
function randInt(rng, n) {
  return Math.floor(rng() * n);
}

/** ランダムな 'L'/'R' の1文字を返す。 */
function randRuleChar(rng) {
  return rng() < 0.5 ? 'L' : 'R';
}

/** 長さ n のランダムなルール文字列を作る。 */
function randomRule(rng, n) {
  let s = '';
  for (let i = 0; i < n; i++) s += randRuleChar(rng);
  return s;
}

/**
 * ルール文字列を原始形(primitive root)に正規化する。
 * `rule` が長さ d(d は rule.length の約数)の文字列の k 回繰り返しなら、最小の d に還元する。
 * 例: 'LLRLLR' -> 'LLR'、'RRRR' -> 'R'、'LLR' -> 'LLR'(既に原始形ならそのまま)。
 * §8「ルールは原始形に正規化する」準拠。力学的に同一なルール(`rule[s % d]` が同じ)を
 * 別物として扱わないため。
 */
export function canonicalRule(rule) {
  const n = rule.length;
  for (let d = 1; d < n; d++) {
    if (n % d !== 0) continue;
    const candidate = rule.slice(0, d);
    let matches = true;
    for (let i = d; i < n; i++) {
      if (rule[i] !== candidate[i % d]) {
        matches = false;
        break;
      }
    }
    if (matches) return candidate;
  }
  return rule; // 既に原始形(自分自身より短い周期が無い)
}

/**
 * 配置帯(side1: 0<=x<WIDTH, 0<=y<ZONE_DEPTH)内で座標が重複しないランダムな
 * cells 配列を作る。count は 1..MAX_CELLS。
 */
function randomCells(rng, count, colorCount) {
  const cells = [];
  const seen = new Set();
  // 配置帯の全マス数は WIDTH*ZONE_DEPTH で MAX_CELLS より十分大きいので無限ループにならない
  while (cells.length < count) {
    const x = randInt(rng, WIDTH);
    const y = randInt(rng, ZONE_DEPTH);
    const key = `${x},${y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cells.push({ x, y, state: randInt(rng, colorCount) });
  }
  return cells;
}

/** 不変条件を満たすランダムな genome を作る。rng は () => [0,1) を返す関数。 */
export function createRandomGenome(rng) {
  // 宣言ルールを原始形に正規化する。原始形の長さが MIN_COLORS 未満(='L'/'R'単独)に
  // なった場合は不正なので作り直す(§8「ルールは原始形に正規化する」)。
  let rule;
  for (;;) {
    const declaredLen = MIN_COLORS + randInt(rng, MAX_COLORS - MIN_COLORS + 1);
    const candidate = canonicalRule(randomRule(rng, declaredLen));
    if (candidate.length >= MIN_COLORS) {
      rule = candidate;
      break;
    }
  }
  const colorCount = rule.length;
  const cellCount = MIN_TEMPLATE_CELLS + randInt(rng, MAX_CELLS - MIN_TEMPLATE_CELLS + 1);
  const cells = randomCells(rng, cellCount, colorCount);
  return {
    rule,
    antX: randInt(rng, WIDTH),
    antY: randInt(rng, ZONE_DEPTH),
    antDir: randInt(rng, 4),
    cells,
  };
}

/**
 * genome の不変条件をチェックし、違反があれば理由文字列の配列を返す。
 * 違反なしなら空配列。
 */
export function validateGenome(g) {
  const errors = [];

  if (typeof g?.rule !== 'string' || g.rule.length < 2 || g.rule.length > 16) {
    errors.push(`rule.length は 2..16 でなければならない: ${g?.rule?.length}`);
  } else if (!/^[LR]+$/.test(g.rule)) {
    errors.push(`rule は 'L'/'R' のみで構成される必要がある: ${g.rule}`);
  } else if (canonicalRule(g.rule) !== g.rule) {
    errors.push(`rule は原始形(primitive root)でなければならない: ${g.rule} -> ${canonicalRule(g.rule)}`);
  }

  if (!Array.isArray(g?.cells) || g.cells.length < 1 || g.cells.length > 16) {
    errors.push(`cells.length は 1..16 でなければならない: ${g?.cells?.length}`);
  } else {
    const colorCount = g.rule?.length;
    const seen = new Set();
    for (const cell of g.cells) {
      if (
        !Number.isInteger(cell.x) ||
        cell.x < 0 ||
        cell.x >= WIDTH ||
        !Number.isInteger(cell.y) ||
        cell.y < 0 ||
        cell.y >= ZONE_DEPTH
      ) {
        errors.push(`cell 座標が配置帯の外: (${cell.x}, ${cell.y})`);
      }
      if (!Number.isInteger(cell.state) || cell.state < 0 || (colorCount != null && cell.state >= colorCount)) {
        errors.push(`cell.state が不正: ${cell.state} (colorCount=${colorCount})`);
      }
      const key = `${cell.x},${cell.y}`;
      if (seen.has(key)) errors.push(`cell 座標が重複している: (${cell.x}, ${cell.y})`);
      seen.add(key);
    }
  }

  if (
    !Number.isInteger(g?.antX) ||
    g.antX < 0 ||
    g.antX >= WIDTH ||
    !Number.isInteger(g?.antY) ||
    g.antY < 0 ||
    g.antY >= ZONE_DEPTH
  ) {
    errors.push(`アリの初期位置が配置帯の外: (${g?.antX}, ${g?.antY})`);
  }

  if (![0, 1, 2, 3].includes(g?.antDir)) {
    errors.push(`antDir が不正: ${g?.antDir}`);
  }

  return errors;
}

/** genome の深いコピーを返す。 */
export function cloneGenome(g) {
  return {
    rule: g.rule,
    antX: g.antX,
    antY: g.antY,
    antDir: g.antDir,
    cells: g.cells.map((c) => ({ x: c.x, y: c.y, state: c.state })),
  };
}

/** 重複検出用の決定論的な文字列キー。cells は座標順にソートしてから連結する。 */
export function genomeKey(g) {
  const cellsKey = g.cells
    .map((c) => `${c.x}:${c.y}:${c.state}`)
    .sort()
    .join(',');
  return `${g.rule}|${g.antX}|${g.antY}|${g.antDir}|${cellsKey}`;
}

/** cells を templates.json 用の [x, y, state] 3要素配列の配列に変換する。 */
export function toTemplateCells(g) {
  return g.cells.map((c) => [c.x, c.y, c.state]);
}

/** genome のコスト。baseCost + cells.length(ルール長にはコストを課さない)。 */
export function costOfGenome(g, baseCost) {
  return baseCost + g.cells.length;
}
