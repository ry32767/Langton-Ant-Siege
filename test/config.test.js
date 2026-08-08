// src/config.js の数値が、docs/spec.md 第2章の前提と矛盾しないことを確認する。
// v4: 盤面90度回転・グローバル RULE 廃止に合わせて全面更新。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/config.js';

test('盤面のジオメトリと得点ラインが整合する(v5: 256x256 正方形、上下が場外)', () => {
  assert.equal(C.WIDTH, 256);
  assert.equal(C.HEIGHT, 256);
  assert.equal(C.ZONE_DEPTH, 32);
  assert.equal(C.SCORE_LINE_Y, C.HEIGHT - C.ZONE_DEPTH);
  assert.equal(C.SCORE_LINE_Y, 224);
  assert.equal(C.CELL_COUNT, C.WIDTH * C.HEIGHT);
  assert.equal(C.CELL_COUNT, 65536);
  // 両陣営の配置可能帯が重ならず、中間地帯が残る
  assert.ok(C.ZONE_DEPTH * 2 < C.HEIGHT);
});

test('得点ゲートが盤面中央に左右対称に取られている(§v5)', () => {
  assert.equal(C.SCORE_GATE_WIDTH, 192);
  assert.equal(C.SCORE_GATE_X_MIN, 32);
  assert.equal(C.SCORE_GATE_X_MAX, 224);
  assert.equal(C.SCORE_GATE_X_MAX - C.SCORE_GATE_X_MIN, C.SCORE_GATE_WIDTH);
  // 左右対称(壁の幅が同じ)。x は陣営で鏡像にならないので、非対称だと片側が有利になる
  assert.equal(C.SCORE_GATE_X_MIN, C.WIDTH - C.SCORE_GATE_X_MAX);
  assert.ok(C.SCORE_GATE_WIDTH < C.WIDTH, 'ゲートが盤面全幅なら制限になっていない');
  // isInScoreGate が唯一の定義であること(境界は min を含み max を含まない)
  assert.equal(C.isInScoreGate(C.SCORE_GATE_X_MIN), true);
  assert.equal(C.isInScoreGate(C.SCORE_GATE_X_MAX - 1), true);
  assert.equal(C.isInScoreGate(C.SCORE_GATE_X_MIN - 1), false);
  assert.equal(C.isInScoreGate(C.SCORE_GATE_X_MAX), false);
});

test('配置マスの局所半径が、配置帯に収まり かつ 意味のある密度になる(§v5)', () => {
  // アリ近傍 (2r+1)^2 マスに MAX_CELLS 個を撒く。半径が大きすぎるとアリが配置マスを
  // 踏まなくなり(v4 で 256列にすると密度0.2%になる問題)、小さすぎると自由度が無くなる。
  const neighborhood = (2 * C.TEMPLATE_CELL_RADIUS + 1) ** 2;
  assert.ok(neighborhood > C.MAX_CELLS, '近傍が配置マス数より狭いと座標が重複して置けない');
  assert.ok(C.MAX_CELLS / neighborhood > 0.02, '近傍が広すぎてアリが配置マスを踏まない');
  assert.ok(2 * C.TEMPLATE_CELL_RADIUS + 1 <= C.ZONE_DEPTH, '近傍の高さが配置帯に収まらない');
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

// ⚠️ v5.3 で担保の方式が変わった。
// v5.2 まではここで「寿命 × 最速ハイウェイ速度 < 敵陣までの距離」を検査していたが、
// その不等式が保証するのは寿命が 3,474 ステップ未満のときだけで、しかも
// 「同梱の妨害9種が到達しない」ことと「どんなテンプレートでも到達しない」ことは別物だった
// (テンプレートを再生成すると9種は入れ替わる。実測で寿命4,000なら乱数配置の43%が到達した)。
// v5.3 は妨害を**空間**で縛る(DISRUPT_MAX_LOCAL_Y で消滅)ので、寿命がいくつでも
// 敵陣到達は原理的に不可能になった。検査すべき不変条件もそちらに移す。
test('妨害アリは盤面中央で消滅するので、寿命によらず敵陣に到達できない', () => {
  assert.ok(
    C.DISRUPT_MAX_LOCAL_Y <= C.SCORE_LINE_Y,
    '妨害の消滅ラインが得点ラインより奥にあると、妨害が得点できてしまう',
  );
  // 中央で消える設計なので、配置可能帯より奥・得点ラインより手前にあること。
  assert.ok(C.DISRUPT_MAX_LOCAL_Y > C.ZONE_DEPTH, '消滅ラインが自陣の配置帯より手前だと妨害が飛べない');
  assert.equal(C.DISRUPT_MAX_LOCAL_Y, C.HEIGHT / 2, '盤面中央であること(両陣営で対称になる)');
});

test('コストがトークン上限の範囲に収まる', () => {
  const maxAttackCost = C.costOf('attack', C.MAX_CELLS); // 21
  const maxDisruptCost = C.costOf('disrupt', C.MAX_CELLS); // 10(v5.5: 妨害はマス単価も半分)
  assert.equal(maxAttackCost, 21);
  assert.equal(maxDisruptCost, 10);
  assert.ok(maxAttackCost <= C.TOKEN_CAP, '最も高い攻撃が上限まで貯めても撃てないことになる');
  assert.ok(C.MIN_CELLS >= 0 && C.MIN_CELLS <= C.MAX_CELLS);
});

test('試合の時間定数が整合する', () => {
  assert.equal(C.TOTAL_STEPS, C.TIME_LIMIT_SEC * C.STEPS_PER_SECOND);
  assert.equal(C.TOTAL_STEPS, 160800);
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
  // 間隔が判断周期の倍数だと、記録した迎撃タイミングの大半が実際には撃てない
  // (docs/spec.md「共有盤面とステップ順序」の警告)
  assert.notEqual(C.FIRE_TIMING_INTERVAL % C.DECISION_INTERVAL_STEPS, 0);
  // 消滅間際に撃っても干渉できないので、末尾は妨害の寿命ぶん手前で打ち切る
  assert.ok(C.FIRE_TIMINGS.at(-1) <= C.ATTACK_LIFE - C.DISRUPT_LIFE);
});

test('共進化中の deltaX 掃引グリッドが盤面幅を割り切る(§v5)', () => {
  // 発射列 antX が可変になったので、カウンター表は deltaX の次元を持つ。
  // 共進化中は全 WIDTH 列を掃引せず、この刻みで近似する。
  assert.ok(C.COEVO_DELTA_X_STRIDE >= 1);
  assert.equal(C.WIDTH % C.COEVO_DELTA_X_STRIDE, 0, '割り切れないと掃引点が偏る');
  assert.ok(C.WIDTH / C.COEVO_DELTA_X_STRIDE >= 8, '掃引点が少なすぎるとカウンターを見落とす');
});

test('探索中のゲーム射影キャップが ATTACK_LIFE より大きい(後から寿命を決められる)', () => {
  // 探索は GAME_LIFE_SEARCH_CAP で走らせて arrivalStep を記録するので、
  // ATTACK_LIFE を後から変えても再探索が要らない。キャップが寿命以下だと成り立たない。
  assert.ok(C.GAME_LIFE_SEARCH_CAP >= C.ATTACK_LIFE);
  assert.ok(C.SEARCH_LIFE > C.GAME_LIFE_SEARCH_CAP, '探索評価はゲーム射影より長く走らせる');
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
  assert.equal(C.ANT_KINDS.disrupt.baseCost, C.DISRUPT_BASE_COST);
  assert.equal(C.ANT_KINDS.disrupt.life, C.DISRUPT_LIFE);
  assert.ok(C.ANT_KINDS.disrupt.life < C.ANT_KINDS.attack.life);
});

test('同時飛行数の上限が定義されている', () => {
  assert.equal(C.MAX_FLYING, 4);
  assert.equal(C.MAX_CELLS, 16);
});

// ---- §26: 発射コストの一本化(v5.5) -----------------------------------------
// 「低コスト妨害設計」差分仕様 §26 が要求するコスト表。costOf() が唯一の定義。

test('§26: 妨害コストの表(costOf("disrupt", n) = DISRUPT_BASE_COST + ceil(n/2))', () => {
  const table = [
    [1, 3],
    [2, 3],
    [3, 4],
    [4, 4],
    [8, 6],
    [16, 10],
  ];
  for (const [cells, expected] of table) {
    assert.equal(C.costOf('disrupt', cells), expected, `cells=${cells} の妨害コスト`);
  }
});

test('§26: 攻撃コストは変わっていない(costOf("attack", n) = ATTACK_COST + n)', () => {
  for (let n = 0; n <= C.MAX_CELLS; n++) {
    assert.equal(C.costOf('attack', n), C.ATTACK_COST + n, `cells=${n} の攻撃コスト`);
  }
});

test('§26: templateCost が costOf と一致する', () => {
  for (const kind of ['attack', 'disrupt']) {
    for (let n = 0; n <= C.MAX_CELLS; n++) {
      const template = { kind, cells: Array.from({ length: n }, () => [0, 0, 0]) };
      assert.equal(C.templateCost(template), C.costOf(kind, n));
      // kind 引数を明示しても同じ結果になる
      assert.equal(C.templateCost(template, kind), C.costOf(kind, n));
    }
  }
});

test('§26: engine.js の costOf と config.js の costOf が全 cells 数で一致する(一元化の回帰テスト)', async () => {
  const engine = await import('../src/engine.js');
  for (const kind of ['attack', 'disrupt']) {
    for (let n = 0; n <= C.MAX_CELLS; n++) {
      assert.equal(
        engine.costOf(kind, n),
        C.costOf(kind, n),
        `kind=${kind} cells=${n} で engine.costOf と config.costOf が食い違っている`,
      );
    }
  }
});
