// src/search/genome.js の単体テスト。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRandomGenome,
  validateGenome,
  cloneGenome,
  genomeKey,
  identityKey,
  toTemplateCells,
  costOfGenome,
  canonicalRule,
} from '../src/search/genome.js';
import { ZONE_DEPTH } from '../src/config.js';
import * as C from '../src/config.js';

// engine.js に依存しない、テスト専用の決定論的 xorshift32 RNG。
function makeRng(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

test('canonicalRule はルールを原始形(primitive root)に還元する', () => {
  assert.equal(canonicalRule('LLRLLR'), 'LLR');
  assert.equal(canonicalRule('RRRR'), 'R');
  assert.equal(canonicalRule('LRLRLR'), 'LR');
  assert.equal(canonicalRule('LLR'), 'LLR'); // 既に原始形ならそのまま
});

test('createRandomGenome は10,000件すべて不変条件を満たす', () => {
  const rng = makeRng(1);
  for (let i = 0; i < 10000; i++) {
    const g = createRandomGenome(rng);
    const errors = validateGenome(g);
    assert.deepEqual(errors, [], `${i}件目で違反: ${errors.join(' / ')}`);
  }
});

test('cloneGenome は深いコピーを返す(元の cells 配列を共有しない)', () => {
  const rng = makeRng(2);
  const g = createRandomGenome(rng);
  const clone = cloneGenome(g);
  assert.deepEqual(clone, g);
  clone.cells[0].state = 999;
  clone.rule = 'X' + clone.rule.slice(1);
  assert.notEqual(clone.cells[0].state, g.cells[0].state);
  assert.notEqual(clone.rule, g.rule);
});

test('genomeKey は同じ内容なら同じキー、違えば違うキーを返す', () => {
  const rng = makeRng(3);
  const g = createRandomGenome(rng);
  const clone = cloneGenome(g);
  assert.equal(genomeKey(g), genomeKey(clone));

  const different = cloneGenome(g);
  different.antY = (different.antY + 1) % ZONE_DEPTH;
  assert.notEqual(genomeKey(g), genomeKey(different));
});

test('genomeKey は cells の並び順に依存しない(座標でソートされる)', () => {
  const g = {
    rule: 'RL',
    antX: 0,
    antY: 0,
    antDir: 0,
    cells: [
      { x: 1, y: 1, state: 1 },
      { x: 0, y: 0, state: 0 },
    ],
  };
  const reordered = {
    ...g,
    cells: [g.cells[1], g.cells[0]],
  };
  assert.equal(genomeKey(g), genomeKey(reordered));
});

test('toTemplateCells は [dx,dy,state] の3要素配列の配列を返す', () => {
  const rng = makeRng(4);
  const g = createRandomGenome(rng);
  const tpl = toTemplateCells(g);
  assert.equal(tpl.length, g.cells.length);
  for (let i = 0; i < tpl.length; i++) {
    assert.equal(tpl[i].length, 3);
    assert.deepEqual(tpl[i], [g.cells[i].dx, g.cells[i].dy, g.cells[i].state]);
  }
});

test('costOfGenome は kind から costOf に委譲する(攻撃/妨害で式が異なる)。ルール長は無関係', () => {
  const g1 = {
    rule: 'RL',
    antX: 0,
    antY: 0,
    antDir: 0,
    cells: [{ x: 0, y: 0, state: 0 }],
  };
  const g2 = {
    rule: 'RLRLRLRLRLRLRLRL', // 16文字
    antX: 0,
    antY: 0,
    antDir: 0,
    cells: [{ x: 0, y: 0, state: 0 }],
  };
  // 攻撃: ATTACK_COST(5) + マス数(1) = 6
  assert.equal(costOfGenome(g1, 'attack'), C.costOf('attack', g1.cells.length));
  assert.equal(costOfGenome(g2, 'attack'), C.costOf('attack', g2.cells.length)); // ルール長が違っても同じコスト

  // 妨害: DISRUPT_BASE_COST(2) + ceil(マス数/2) で、攻撃とは式が異なる
  assert.equal(costOfGenome(g1, 'disrupt'), C.costOf('disrupt', g1.cells.length));
  assert.notEqual(costOfGenome(g1, 'disrupt'), costOfGenome(g1, 'attack'));
});

test('validateGenome は不変条件違反を個別に検出する', () => {
  const base = {
    rule: 'RL',
    antY: 0,
    antDir: 0,
    cells: [{ dx: 0, dy: 0, state: 0 }],
  };
  assert.deepEqual(validateGenome(base), []);

  assert.ok(validateGenome({ ...base, rule: 'R' }).length > 0); // 短すぎるルール
  assert.ok(validateGenome({ ...base, rule: 'X' + 'R'.repeat(15) }).length > 0); // 不正な記号
  assert.ok(validateGenome({ ...base, cells: [] }).length > 0); // セル0個
  assert.ok(
    validateGenome({ ...base, cells: [{ dx: 0, dy: 0, state: 5 }] }).length > 0, // state >= colorCount
  );
  assert.ok(validateGenome({ ...base, antY: ZONE_DEPTH }).length > 0); // 配置帯の外
  assert.ok(validateGenome({ ...base, antDir: 4 }).length > 0);
  assert.ok(
    validateGenome({
      ...base,
      cells: [
        { dx: 1, dy: 1, state: 0 },
        { dx: 1, dy: 1, state: 1 },
      ],
    }).length > 0, // 座標重複
  );
  assert.ok(validateGenome({ ...base, rule: 'LLRLLR' }).length > 0); // 原始形でない(LLRの繰り返し)
});

test('validateGenome は antX の混入を検出する', () => {
  const base = {
    rule: 'RL',
    antY: 0,
    antDir: 0,
    cells: [{ dx: 0, dy: 0, state: 0 }],
  };
  assert.deepEqual(validateGenome(base), []);
  assert.ok(validateGenome({ ...base, antX: 0 }).length > 0); // genome は antX を持ってはいけない
});

test('validateGenome は antY + dy の配置帯はみ出しを検出する', () => {
  const base = {
    rule: 'RL',
    antY: 0,
    antDir: 0,
    cells: [{ dx: 0, dy: -1, state: 0 }], // antY(0) + dy(-1) = -1 は配置帯の外
  };
  const errors = validateGenome(base);
  assert.ok(errors.length > 0);
  assert.ok(errors.some((e) => e.includes('配置帯の外')));

  // 境界: antY + dy がちょうど ZONE_DEPTH に達する場合も外
  const outAtTop = {
    rule: 'RL',
    antY: ZONE_DEPTH - 1,
    antDir: 0,
    cells: [{ dx: 0, dy: 1, state: 0 }], // (ZONE_DEPTH-1) + 1 = ZONE_DEPTH は範囲外
  };
  assert.ok(validateGenome(outAtTop).some((e) => e.includes('配置帯の外')));
});

test('identityKey は "antY,antDir" を返し、antY か antDir が違えば違うキーになる', () => {
  const rng = makeRng(5);
  const g = createRandomGenome(rng);
  assert.equal(identityKey(g), `${g.antY},${g.antDir}`);

  const diffAntY = cloneGenome(g);
  diffAntY.antY = (diffAntY.antY + 1) % ZONE_DEPTH;
  assert.notEqual(identityKey(g), identityKey(diffAntY));

  const diffAntDir = cloneGenome(g);
  diffAntDir.antDir = (diffAntDir.antDir + 1) % 4;
  assert.notEqual(identityKey(g), identityKey(diffAntDir));
});

test('createRandomGenome が生成する genome は必ず validateGenome を通る(シードを変えて200個)', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const rng = makeRng(seed * 7919 + 1);
    const g = createRandomGenome(rng);
    const errors = validateGenome(g);
    assert.deepEqual(errors, [], `seed=${seed} で違反: ${errors.join(' / ')}`);
  }
});
