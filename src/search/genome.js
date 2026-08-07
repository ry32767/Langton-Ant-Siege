// MAP-Elites 探索用の genome 表現。純粋なデータ操作のみ(engine.js は import しない)。
//
// genome = {
//   rule:   'L'/'R' のみからなる原始形の文字列。長さ = colorCount(rule.length から導出)
//   antY:   配置帯内のアリの初期行(0..ZONE_DEPTH-1)
//   antDir: 0|1|2|3
//   cells:  [{ dx, dy, state }, ...] 配置マス。**アリからの相対座標**(座標は重複しない)
//   origin: 'random' | 'mutation' | 'distilled'(任意。探索アーカイブの分析用)
//   parentGenomeId: string | null(任意。distilled の親を辿るため)
// }
//
// ⚠️ v5 の変更点: **genome は antX(発射列)を持たない。**
// 左右がトーラスなので x 方向の平行移動は力学の厳密な対称性であり、同じ genome を
// どの列から撃っても軌道は平行移動するだけで形も周期も並進も変わらない。
// 発射列はプレイヤー / CPU が発射時に選ぶ自由度になった(docs/spec.md §v5)。
// これに伴い cells は絶対 x ではなく **アリ列からの相対 dx** で持つ。
// dy も同様にアリ行からの相対にしてある(Seed Distillation が生成する種が
// 「アリ周囲の局所セル」なので、表現をそちらに合わせると変換が要らない)。

import { MIN_COLORS, MAX_COLORS, MAX_CELLS, MIN_TEMPLATE_CELLS, ZONE_DEPTH, TEMPLATE_CELL_RADIUS } from '../config.js';

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
 * 相対 dy が、指定した antY のとき配置帯(0..ZONE_DEPTH-1)に収まるか。
 * dy はアリ行からの相対なので、収まる範囲は antY に依存する。
 */
export function isCellDyInZone(antY, dy) {
  const y = antY + dy;
  return y >= 0 && y < ZONE_DEPTH;
}

/**
 * アリ近傍(チェビシェフ半径 TEMPLATE_CELL_RADIUS)で座標が重複しないランダムな
 * cells 配列を作る。count は 1..MAX_CELLS。dy は配置帯に収まる範囲だけを使う。
 *
 * ⚠️ 近傍に限定するのが v5 の要点。配置帯全体(256×32=8,192マス)に一様に撒くと
 * 密度0.2%になってアリが配置マスを一度も踏まず、genome の初期配置部分が死ぬ
 * (config.js の TEMPLATE_CELL_RADIUS のコメント参照)。
 */
function randomCells(rng, count, colorCount, antY) {
  const R = TEMPLATE_CELL_RADIUS;
  const cells = [];
  const seen = new Set();
  // 近傍のうち配置帯に収まる位置の総数。これを下回る count しか要求されない前提だが、
  // 念のため試行回数に上限を設けて無限ループを避ける。
  const MAX_ATTEMPTS = 2000;
  let attempts = 0;
  while (cells.length < count && attempts < MAX_ATTEMPTS) {
    attempts++;
    const dx = randInt(rng, 2 * R + 1) - R;
    const dy = randInt(rng, 2 * R + 1) - R;
    if (!isCellDyInZone(antY, dy)) continue;
    const key = `${dx},${dy}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cells.push({ dx, dy, state: randInt(rng, colorCount) });
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
  const antY = randInt(rng, ZONE_DEPTH);
  const cellCount = MIN_TEMPLATE_CELLS + randInt(rng, MAX_CELLS - MIN_TEMPLATE_CELLS + 1);
  const cells = randomCells(rng, cellCount, colorCount, antY);
  return {
    rule,
    antY,
    antDir: randInt(rng, 4),
    cells,
    origin: 'random',
    parentGenomeId: null,
  };
}

/**
 * genome の不変条件をチェックし、違反があれば理由文字列の配列を返す。
 * 違反なしなら空配列。
 */
export function validateGenome(g) {
  const errors = [];

  if (typeof g?.rule !== 'string' || g.rule.length < MIN_COLORS || g.rule.length > MAX_COLORS) {
    errors.push(`rule.length は ${MIN_COLORS}..${MAX_COLORS} でなければならない: ${g?.rule?.length}`);
  } else if (!/^[LR]+$/.test(g.rule)) {
    errors.push(`rule は 'L'/'R' のみで構成される必要がある: ${g.rule}`);
  } else if (canonicalRule(g.rule) !== g.rule) {
    errors.push(`rule は原始形(primitive root)でなければならない: ${g.rule} -> ${canonicalRule(g.rule)}`);
  }

  if (!Number.isInteger(g?.antY) || g.antY < 0 || g.antY >= ZONE_DEPTH) {
    errors.push(`アリの初期行が配置帯の外: antY=${g?.antY}`);
  }

  if (![0, 1, 2, 3].includes(g?.antDir)) {
    errors.push(`antDir が不正: ${g?.antDir}`);
  }

  if (g?.antX !== undefined) {
    // 発射列は genome の持ち物ではない(発射時に選ぶ)。混入していたら設計上のバグ。
    errors.push('genome は antX を持ってはいけない(発射列は発射時に選ぶ)');
  }

  if (!Array.isArray(g?.cells) || g.cells.length < MIN_TEMPLATE_CELLS || g.cells.length > MAX_CELLS) {
    errors.push(`cells.length は ${MIN_TEMPLATE_CELLS}..${MAX_CELLS} でなければならない: ${g?.cells?.length}`);
  } else {
    const colorCount = g.rule?.length;
    const seen = new Set();
    for (const cell of g.cells) {
      if (!Number.isInteger(cell.dx) || Math.abs(cell.dx) > TEMPLATE_CELL_RADIUS) {
        errors.push(`cell.dx がアリ近傍(±${TEMPLATE_CELL_RADIUS})の外: ${cell.dx}`);
      }
      if (!Number.isInteger(cell.dy) || Math.abs(cell.dy) > TEMPLATE_CELL_RADIUS) {
        errors.push(`cell.dy がアリ近傍(±${TEMPLATE_CELL_RADIUS})の外: ${cell.dy}`);
      }
      if (Number.isInteger(g?.antY) && Number.isInteger(cell.dy) && !isCellDyInZone(g.antY, cell.dy)) {
        errors.push(`cell が配置帯の外に出る: antY=${g.antY} + dy=${cell.dy}`);
      }
      if (!Number.isInteger(cell.state) || cell.state < 0 || (colorCount != null && cell.state >= colorCount)) {
        errors.push(`cell.state が不正: ${cell.state} (colorCount=${colorCount})`);
      }
      const key = `${cell.dx},${cell.dy}`;
      if (seen.has(key)) errors.push(`cell 座標が重複している: (${cell.dx}, ${cell.dy})`);
      seen.add(key);
    }
  }

  return errors;
}

/** genome の深いコピーを返す。 */
export function cloneGenome(g) {
  return {
    rule: g.rule,
    antY: g.antY,
    antDir: g.antDir,
    cells: g.cells.map((c) => ({ dx: c.dx, dy: c.dy, state: c.state })),
    origin: g.origin ?? 'random',
    parentGenomeId: g.parentGenomeId ?? null,
  };
}

/** 重複検出用の決定論的な文字列キー。cells は座標順にソートしてから連結する。 */
export function genomeKey(g) {
  const cellsKey = g.cells
    .map((c) => `${c.dx}:${c.dy}:${c.state}`)
    .sort()
    .join(',');
  return `${g.rule}|${g.antY}|${g.antDir}|${cellsKey}`;
}

/**
 * 識別キー。飛来する敵アリを見分けるための「発射行と向き」の組。
 * ⚠️ v5 で発射列 antX が可変になったため、identifyTable のキーは
 * "antX,antY,antDir" から **"antY,antDir"** に変わった。選抜した攻撃9種が
 * このキーで一意に区別できることが選抜の必須条件(docs/spec.md §v5)。
 */
export function identityKey(g) {
  return `${g.antY},${g.antDir}`;
}

/**
 * cells を templates.json 用の [dx, dy, state] 3要素配列の配列に変換する。
 * ⚠️ 中身は**相対座標**。盤面に置くときは engine.js の instantiateTemplate を通すこと。
 */
export function toTemplateCells(g) {
  return g.cells.map((c) => [c.dx, c.dy, c.state]);
}

/** genome のコスト。baseCost + cells.length(ルール長にはコストを課さない)。 */
export function costOfGenome(g, baseCost) {
  return baseCost + g.cells.length;
}
