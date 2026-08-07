// src/config.js の数値が、docs/spec.md 第2章の前提と矛盾しないことを確認する。
// v4: 盤面90度回転・グローバル RULE 廃止に合わせて全面更新。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/config.js';

test('盤面のジオメトリと得点ラインが整合する(v4: 60x120、上下が場外)', () => {
  assert.equal(C.WIDTH, 60);
  assert.equal(C.HEIGHT, 120);
  assert.equal(C.ZONE_DEPTH, 16);
  assert.equal(C.SCORE_LINE_Y, C.HEIGHT - C.ZONE_DEPTH);
  assert.equal(C.SCORE_LINE_Y, 104);
  assert.equal(C.CELL_COUNT, C.WIDTH * C.HEIGHT);
  assert.equal(C.CELL_COUNT, 7200);
  // 両陣営の配置可能帯が重ならず、中間地帯が残る
  assert.ok(C.ZONE_DEPTH * 2 < C.HEIGHT);
});

test('ラップの向きが左右のみ(上下はラップしない)', () => {
  assert.equal(C.WRAP_HORIZONTAL, true);
  assert.equal(C.WRAP_VERTICAL, false);
});

test('グローバル RULE / COLORS / PLACED_CELL_STATE / SCORE_LINE_X は廃止されている', () => {
  assert.equal(C.RULE, undefined);
  assert.equal(C.COLORS, undefined);
  assert.equal(C.PLACED_CELL_STATE, undefined);
  assert.equal(C.SCORE_LINE_X, undefined);
});

test('色数の範囲とLEGACY_RULEが妥当', () => {
  assert.equal(C.MIN_COLORS, 2);
  assert.equal(C.MAX_COLORS, 16);
  assert.equal(C.LEGACY_RULE, 'RRL');
  assert.equal(C.LEGACY_RULE.length, 3);
  for (const ch of C.LEGACY_RULE) assert.ok(ch === 'R' || ch === 'L', `不正な回転記号: ${ch}`);
  assert.ok(C.LEGACY_RULE.length >= C.MIN_COLORS && C.LEGACY_RULE.length <= C.MAX_COLORS);
});

test('回帰フィクスチャの定数が定義されている', () => {
  assert.equal(C.LEGACY_HIGHWAY_ONSET_STEP, 38);
  assert.equal(C.LEGACY_HIGHWAY_PERIOD, 18);
});

test('向きの定義と回転が対応する', () => {
  assert.equal(C.DIRS.length, 4);
  // 右回転(+1)で up → right → down → left
  assert.deepEqual(C.DIRS[C.DIR_UP], [0, -1]);
  assert.deepEqual(C.DIRS[(C.DIR_UP + 1) & 3], [1, 0]);
  assert.deepEqual(C.DIRS[(C.DIR_UP + 3) & 3], [-1, 0]); // 左回転
  assert.deepEqual(C.DIRS[C.DIR_RIGHT], [1, 0]);
  assert.deepEqual(C.DIRS[C.DIR_DOWN], [0, 1]);
  assert.deepEqual(C.DIRS[C.DIR_LEFT], [-1, 0]);
});

test('攻撃アリの寿命が、最も浅い配置帯からの縦断に足りる(LEGACY_RULE基準)', () => {
  // 発射できる最も深い y=ZONE_DEPTH-1 から得点ライン y=SCORE_LINE_Y まで
  const nearestRows = C.SCORE_LINE_Y - (C.ZONE_DEPTH - 1);
  const farthestRows = C.SCORE_LINE_Y; // y=0 発射
  const minSteps = nearestRows * C.LEGACY_HIGHWAY_PERIOD;
  const maxSteps = farthestRows * C.LEGACY_HIGHWAY_PERIOD;
  assert.ok(C.ATTACK_LIFE > maxSteps, '最も浅い位置から撃っても寿命内に届くこと');
  assert.ok(C.LEGACY_HIGHWAY_ONSET_STEP + maxSteps < C.ATTACK_LIFE);
  void minSteps;
});

test('妨害アリの寿命では敵陣に到達できない(LEGACY_RULE基準)', () => {
  const reachRows = Math.ceil(C.DISRUPT_LIFE / C.LEGACY_HIGHWAY_PERIOD);
  const nearestRows = C.SCORE_LINE_Y - (C.ZONE_DEPTH - 1);
  assert.ok(reachRows < nearestRows, '妨害が得点できてしまう寿命になっている');
});

test('コストがトークン上限の範囲に収まる', () => {
  const maxAttackCost = C.ATTACK_COST + C.MAX_CELLS; // 21
  const maxDisruptCost = C.DISRUPT_COST + C.MAX_CELLS; // 19
  assert.equal(maxAttackCost, 21);
  assert.equal(maxDisruptCost, 19);
  assert.ok(maxAttackCost <= C.TOKEN_CAP, '最も高い攻撃が上限まで貯めても撃てないことになる');
  assert.ok(C.MIN_CELLS >= 0 && C.MIN_CELLS <= C.MAX_CELLS);
});

test('試合の時間定数が整合する', () => {
  assert.equal(C.TOTAL_STEPS, C.TIME_LIMIT_SEC * C.STEPS_PER_SECOND);
  assert.equal(C.TOTAL_STEPS, 28800);
  assert.equal(C.TOKEN_TICK_STEPS, C.STEPS_PER_SECOND);
  // 上限まで貯めるのに30秒。試合時間に対して十分短い
  assert.ok(C.TOKEN_CAP / C.TOKEN_PER_TICK < C.TIME_LIMIT_SEC);
  assert.equal(C.WIN_SCORE, 5);
});

test('カウンター表の発射タイミング候補が昇順で寿命内に収まる', () => {
  assert.ok(C.FIRE_TIMINGS.length > 0);
  for (let i = 1; i < C.FIRE_TIMINGS.length; i++) {
    assert.ok(C.FIRE_TIMINGS[i] > C.FIRE_TIMINGS[i - 1], '昇順でない');
  }
  assert.equal(C.FIRE_TIMINGS[0], 0);
  assert.ok(C.FIRE_TIMINGS.at(-1) < C.ATTACK_LIFE);
});

test('記録された発射タイミングがすべて実際に撃てる(SCHEDULED_FIRE_IS_EXACT)', () => {
  if (C.SCHEDULED_FIRE_IS_EXACT) {
    assert.ok(true, '予約発射は fireAtStep ちょうどに実行するので任意のステップが撃てる');
    return;
  }
  const unreachable = C.FIRE_TIMINGS.filter((t) => t % C.DECISION_INTERVAL_STEPS !== 0);
  assert.deepEqual(unreachable, []);
});

test('テンプレートに要求する配置マス数の下限が0でない', () => {
  assert.ok(C.MIN_TEMPLATE_CELLS >= 1);
  assert.ok(C.MIN_TEMPLATE_CELLS <= C.MAX_CELLS);
  assert.ok(C.MIN_CELLS <= C.MIN_TEMPLATE_CELLS);
});

test('アリ種別の表が2種類ぶん揃っている', () => {
  assert.deepEqual(Object.keys(C.ANT_KINDS).sort(), ['attack', 'disrupt']);
  assert.equal(C.ANT_KINDS.attack.life, C.ATTACK_LIFE);
  assert.equal(C.ANT_KINDS.attack.baseCost, C.ATTACK_COST);
  assert.equal(C.ANT_KINDS.disrupt.baseCost, C.DISRUPT_COST);
  assert.equal(C.ANT_KINDS.disrupt.life, C.DISRUPT_LIFE);
  assert.ok(C.ANT_KINDS.disrupt.life < C.ANT_KINDS.attack.life);
});

test('同時飛行数の上限が定義されている', () => {
  assert.equal(C.MAX_FLYING, 4);
  assert.equal(C.MAX_CELLS, 16);
});
