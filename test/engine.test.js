// src/engine.js の単体テスト。docs/spec.md 第6章「受け入れ条件 → 検証方法」の自動の行を網羅する。
// v4: 盤面90度回転(攻撃軸=上下・ラップ=左右)・可変ルール(rule/colorCount)に合わせて全面更新。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/config.js';
import * as E from '../src/engine.js';

const cellIndex = (x, y) => y * C.WIDTH + x;

// ---------------------------------------------------------------------------
// 可変ルール・セルオートマトン規則(modulo 解釈)
// ---------------------------------------------------------------------------

test('可変ルール: RL(2色)/RRL(3色)/16色ルールがそれぞれ指定通りに回転する', () => {
  function checkRule(rule) {
    const match = E.createMatch({ seed: 1 });
    match.sides[0].tokens = 1000;
    const j = cellIndex(5, 5);
    const id = E.fire(match, 0, { kind: 'attack', cells: [], antX: 5, antY: 5, antDir: C.DIR_UP, rule });
    const ant = match.sides[0].ants.find((a) => a.id === id);
    for (let s = 0; s < rule.length; s++) {
      match.board[j] = s; // 状態sから開始させる
      ant.x = 5;
      ant.y = 5;
      ant.dir = C.DIR_UP;
      E.stepMatch(match);
      const expectedDir = rule[s] === 'R' ? C.DIR_RIGHT : C.DIR_LEFT;
      assert.equal(ant.dir, expectedDir, `rule=${rule} state=${s} の回転が不一致`);
      assert.equal(match.board[j], (s + 1) % rule.length, `rule=${rule} state=${s} の書き込みが不一致`);
    }
  }
  checkRule('RL');
  checkRule('RRL');
  checkRule('RRLLRRLLRRLLRRLL'); // 16色
});

test('状態0/1で右折・状態2で左折・状態は0→1→2→0で巡回する(回転は踏んだ時点の状態で決まる、RRL)', () => {
  const match = E.createMatch({ seed: 1 });
  match.sides[0].tokens = 1000;
  const j = cellIndex(5, 5);

  match.board[j] = 0;
  const id = E.fire(match, 0, { kind: 'attack', cells: [], antX: 5, antY: 5, antDir: C.DIR_UP, rule: 'RRL' });
  const ant = match.sides[0].ants.find((a) => a.id === id);
  E.stepMatch(match);
  assert.equal(ant.dir, C.DIR_RIGHT);
  assert.equal(match.board[j], 1);

  ant.x = 5;
  ant.y = 5;
  ant.dir = C.DIR_UP;
  E.stepMatch(match);
  assert.equal(ant.dir, C.DIR_RIGHT);
  assert.equal(match.board[j], 2);

  ant.x = 5;
  ant.y = 5;
  ant.dir = C.DIR_UP;
  E.stepMatch(match);
  assert.equal(ant.dir, C.DIR_LEFT);
  assert.equal(match.board[j], 0);
});

test('modulo解釈: 盤面状態13のマスに3色アリを置くと13%3=1として動作し、書き込み後は2になる', () => {
  const match = E.createMatch({ seed: 1 });
  match.sides[0].tokens = 1000;
  const j = cellIndex(5, 5);
  match.board[j] = 13;
  const id = E.fire(match, 0, { kind: 'attack', cells: [], antX: 5, antY: 5, antDir: C.DIR_UP, rule: 'RRL' });
  const ant = match.sides[0].ants.find((a) => a.id === id);
  E.stepMatch(match);
  // 13%3=1 → rule[1]='R' → 右折。書込は (1+1)%3=2
  assert.equal(ant.dir, C.DIR_RIGHT);
  assert.equal(match.board[j], 2);
});

test('空盤面での連続右折(周期4の正方形)を確認する(1色=常に右折)', () => {
  const r = E.simulateSolo(
    { cells: [], antX: 10, antY: 10, antDir: C.DIR_UP, rule: 'R' },
    { life: 200, trackPath: true },
  );
  assert.deepEqual(r.path[0], [10, 10]);
  assert.deepEqual(r.path[1], [11, 10]);
  assert.deepEqual(r.path[2], [11, 11]);
  assert.deepEqual(r.path[3], [10, 11]);
  assert.deepEqual(r.path[4], [10, 10]);
});

// ---------------------------------------------------------------------------
// 配置マスの書き込み
// ---------------------------------------------------------------------------

test('配置セルは指定した state で書き込まれ、2要素セルは state=1、既存の非白マスも無条件で上書きする', () => {
  const match = E.createMatch({ seed: 1 });
  match.sides[0].tokens = 100;

  // [x,y,5] → state=5
  const id1 = E.fire(match, 0, { kind: 'attack', cells: [[3, 3, 5]], antX: 0, antY: 0, antDir: C.DIR_RIGHT, rule: 'RRL' });
  assert.ok(id1 !== null);
  assert.equal(match.board[cellIndex(3, 3)], 5);
  assert.equal(match.lastToucher[cellIndex(3, 3)], id1);

  // [x,y] (2要素) → state=1
  const id2 = E.fire(match, 0, { kind: 'attack', cells: [[4, 4]], antX: 0, antY: 0, antDir: C.DIR_RIGHT, rule: 'RRL' });
  assert.ok(id2 !== null);
  assert.equal(match.board[cellIndex(4, 4)], 1);

  // 手動で別状態(9)にしてから再配置 → 無条件で5に戻る
  match.board[cellIndex(3, 3)] = 9;
  const id3 = E.fire(match, 0, { kind: 'attack', cells: [[3, 3, 5]], antX: 0, antY: 0, antDir: C.DIR_RIGHT, rule: 'RRL' });
  assert.equal(match.board[cellIndex(3, 3)], 5);
  assert.equal(match.lastToucher[cellIndex(3, 3)], id3);
});

test('発射で配置マスが書かれアリが1匹増える。発射したステップ内でそのアリも1歩進む', () => {
  const match = E.createMatch({ seed: 1 });
  match.sides[0].tokens = 100;
  const before = match.sides[0].ants.length;
  const id = E.fire(match, 0, {
    kind: 'attack',
    cells: [[2, 2]],
    antX: 5,
    antY: 5,
    antDir: C.DIR_RIGHT,
    rule: 'RRL',
  });
  assert.ok(id !== null);
  assert.equal(match.sides[0].ants.length, before + 1);
  assert.equal(match.board[cellIndex(2, 2)], 1);
  const ant = match.sides[0].ants.find((a) => a.id === id);
  assert.equal(ant.steps, 0);
  E.stepMatch(match);
  const antAfter = match.sides[0].ants.find((a) => a.id === id) ?? null;
  assert.ok(antAfter !== null);
  assert.equal(antAfter.steps, 1);
});

test('予約発射(scheduleFire)でも、発射したステップ内でそのアリが1歩進む', () => {
  const match = E.createMatch({ seed: 1 });
  match.sides[0].tokens = 100;
  E.scheduleFire(match, 0, { kind: 'attack', cells: [[1, 1]], antX: 5, antY: 5, antDir: C.DIR_RIGHT, rule: 'RRL' }, 3);
  E.stepMatch(match); // step===0
  E.stepMatch(match); // step===1
  E.stepMatch(match); // step===2
  E.stepMatch(match); // step===3 の予約発射が実行される
  assert.equal(match.sides[0].ants.length, 1);
  assert.equal(match.sides[0].ants[0].steps, 1);
});

// ---------------------------------------------------------------------------
// 左右トーラス・上下場外・寿命
// ---------------------------------------------------------------------------

test('左右はトーラス: x=-1→x=59', () => {
  // 状態0は'R'ルールで右折する。DOWN→右折→LEFT なので dir=DOWN で開始する
  const r = E.simulateSolo({ cells: [], antX: 0, antY: 30, antDir: C.DIR_DOWN, rule: 'R' }, { life: 1 });
  assert.equal(r.endX, C.WIDTH - 1);
  assert.equal(r.endY, 30);
});

test('左右はトーラス: x=60→x=0(WIDTH到達で回り込む)', () => {
  // UP→右折→RIGHT なので dir=UP で開始する
  const r = E.simulateSolo({ cells: [], antX: C.WIDTH - 1, antY: 30, antDir: C.DIR_UP, rule: 'R' }, { life: 1 });
  assert.equal(r.endX, 0);
  assert.equal(r.endY, 30);
});

test('上下は場外: y<0で消滅、y>=SCORE_LINE_Yで得点して消滅', () => {
  // LEFT→右折→UP なので dir=LEFT で開始する。y=0からUPで1歩進むと y=-1
  const rDead = E.simulateSolo({ cells: [], antX: 10, antY: 0, antDir: C.DIR_LEFT, rule: 'R' }, { life: 5 });
  assert.equal(rDead.scored, false);
  assert.equal(rDead.steps, 1);
  assert.ok(rDead.endY < 0);

  // RIGHT→右折→DOWN なので dir=RIGHT で開始する
  const rScore = E.simulateSolo(
    { cells: [], antX: 10, antY: C.SCORE_LINE_Y - 1, antDir: C.DIR_RIGHT, rule: 'R' },
    { life: 5 },
  );
  assert.equal(rScore.scored, true);
  assert.equal(rScore.steps, 1);
  assert.equal(rScore.endY, C.SCORE_LINE_Y);
  assert.equal(rScore.entryY, C.SCORE_LINE_Y);
});

test('寿命を使い切ったアリは消滅し得点しない', () => {
  const r = E.simulateSolo(
    { cells: [], antX: 30, antY: 60, antDir: C.DIR_UP, rule: 'RRL' },
    { life: 10 },
  );
  assert.equal(r.scored, false);
  assert.equal(r.steps, 10);
});

// ---------------------------------------------------------------------------
// ハイウェイ検出・回帰フィクスチャ(LEGACY_RULE)
// ---------------------------------------------------------------------------

test('回帰フィクスチャ: LEGACY_RULE(=RRL) のアリを空盤面で走らせるとLEGACY_HIGHWAY_ONSET_STEP以降LEGACY_HIGHWAY_PERIOD周期になる', () => {
  // ⚠️「全アリが38ステップでハイウェイになる」わけではない。LEGACY_RULE を選んだ場合だけの回帰フィクスチャ。
  const r = E.simulateSolo(
    { cells: [], antX: 10, antY: 30, antDir: C.DIR_RIGHT, rule: C.LEGACY_RULE },
    { life: 300, trackPath: true },
  );
  const hw = E.detectHighway(r.path, 40);
  assert.ok(hw !== null);
  assert.equal(hw.onsetStep, C.LEGACY_HIGHWAY_ONSET_STEP);
  assert.equal(hw.period, C.LEGACY_HIGHWAY_PERIOD);
});

// ---------------------------------------------------------------------------
// トークン
// ---------------------------------------------------------------------------

test('トークンは1秒(TOKEN_TICK_STEPS)ごとに+1、飛行中も蓄積、上限で頭打ち', () => {
  const match = E.createMatch({ seed: 1 });
  E.stepMatch(match); // step0の加算
  assert.equal(match.sides[0].tokens, 1);
  for (let i = 0; i < C.TOKEN_TICK_STEPS; i++) E.stepMatch(match);
  assert.equal(match.sides[0].tokens, 2);

  match.sides[0].tokens = 5;
  E.fire(match, 0, { kind: 'disrupt', cells: [[1, 1]], antX: 5, antY: 5, antDir: C.DIR_UP, rule: 'RRL' });
  const before = match.sides[0].tokens;
  for (let i = 0; i < C.TOKEN_TICK_STEPS; i++) E.stepMatch(match);
  assert.ok(match.sides[0].tokens > before || match.sides[0].tokens === C.TOKEN_CAP);

  const capMatch = E.createMatch({ seed: 1 });
  const ticks = C.TOKEN_CAP + 5;
  for (let i = 0; i < ticks * C.TOKEN_TICK_STEPS; i++) E.stepMatch(capMatch);
  assert.equal(capMatch.sides[0].tokens, C.TOKEN_CAP);
});

// ---------------------------------------------------------------------------
// 配置可能帯・発射コスト・上限
// ---------------------------------------------------------------------------

test('配置は y=0..ZONE_DEPTH-1 のみ・最大MAX_CELLS個(canFireがzone/cellsを返す)', () => {
  const match = E.createMatch({ seed: 1 });
  match.sides[0].tokens = 100;

  const outOfZone = E.canFire(match, 0, {
    kind: 'attack',
    cells: [[0, C.ZONE_DEPTH]],
    antX: 0,
    antY: 0,
    antDir: C.DIR_RIGHT,
    rule: 'RRL',
  });
  assert.equal(outOfZone.ok, false);
  assert.equal(outOfZone.reason, 'zone');

  const tooMany = E.canFire(match, 0, {
    kind: 'attack',
    cells: Array.from({ length: C.MAX_CELLS + 1 }, (_, i) => [0, i % C.ZONE_DEPTH]),
    antX: 0,
    antY: 0,
    antDir: C.DIR_RIGHT,
    rule: 'RRL',
  });
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.reason, 'cells');

  const ok = E.canFire(match, 0, {
    kind: 'attack',
    cells: [[0, 0], [0, C.ZONE_DEPTH - 1]],
    antX: 0,
    antY: 0,
    antDir: C.DIR_RIGHT,
    rule: 'RRL',
  });
  assert.equal(ok.ok, true);
});

test('コスト計算・トークン不足で発射不可・発射でコスト消費', () => {
  assert.equal(E.costOf('attack', 3), C.ATTACK_COST + 3);
  assert.equal(E.costOf('disrupt', 2), C.DISRUPT_COST + 2);

  const match = E.createMatch({ seed: 1 });
  match.sides[0].tokens = 2; // コストに満たない
  const action = { kind: 'attack', cells: [[0, 0]], antX: 0, antY: 0, antDir: C.DIR_RIGHT, rule: 'RRL' };
  const check = E.canFire(match, 0, action);
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'tokens');
  const id = E.fire(match, 0, action);
  assert.equal(id, null);

  match.sides[0].tokens = C.ATTACK_COST + 1;
  const cost = E.costOf('attack', 1);
  const id2 = E.fire(match, 0, action);
  assert.ok(id2 !== null);
  assert.equal(match.sides[0].tokens, C.ATTACK_COST + 1 - cost);
});

test('同時飛行4匹(MAX_FLYING)で発射不可', () => {
  const match = E.createMatch({ seed: 1 });
  match.sides[0].tokens = 1000;
  for (let i = 0; i < C.MAX_FLYING; i++) {
    const id = E.fire(match, 0, { kind: 'disrupt', cells: [[0, 0]], antX: 0, antY: i, antDir: C.DIR_RIGHT, rule: 'RRL' });
    assert.ok(id !== null);
  }
  const check = E.canFire(match, 0, { kind: 'disrupt', cells: [[0, 0]], antX: 0, antY: 20, antDir: C.DIR_RIGHT, rule: 'RRL' });
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'flying');
  const id = E.fire(match, 0, { kind: 'disrupt', cells: [[0, 0]], antX: 0, antY: 20, antDir: C.DIR_RIGHT, rule: 'RRL' });
  assert.equal(id, null);
});

// ---------------------------------------------------------------------------
// クリーンアップ
// ---------------------------------------------------------------------------

test('クリーンアップ: 他のアリのlastToucherが付いたマスは消滅時にも白へ戻らない', () => {
  const match = E.createMatch({ seed: 1 });
  match.sides[0].tokens = 1000;

  // アリA: 配置マス(0,0)を持つ(A自身はそこを通らない離れた位置から発射)
  const idA = E.fire(match, 0, { kind: 'disrupt', cells: [[0, 0]], antX: 3, antY: 10, antDir: C.DIR_UP, rule: 'RRL' });
  const antA = match.sides[0].ants.find((a) => a.id === idA);
  antA.life = 1000;

  // アリB: (0,1)からLEFT向きで発射。(0,1)は白(状態0)なので右折(LEFT→UP)して
  // 1歩目で(0,0)に到達し、2歩目で(0,0)を踏む(lastToucherを奪う)。
  const idB = E.fire(match, 0, { kind: 'disrupt', cells: [[5, 5]], antX: 0, antY: 1, antDir: C.DIR_LEFT, rule: 'RRL' });
  const antB = match.sides[0].ants.find((a) => a.id === idB);
  antB.life = 1000;

  E.stepMatch(match); // Bが(0,0)に到達(まだ踏んでいない)
  E.stepMatch(match); // Bが(0,0)を踏み、lastToucherがBになる
  assert.equal(match.lastToucher[cellIndex(0, 0)], idB);

  const antA2 = match.sides[0].ants.find((a) => a.id === idA);
  antA2.life = antA2.steps + 1;
  E.stepMatch(match);
  assert.equal(match.sides[0].ants.some((a) => a.id === idA), false, 'Aは消滅しているはず');

  // Aの配置マス(0,0)はBのlastToucherなので白に戻らず残っている
  assert.equal(match.lastToucher[cellIndex(0, 0)], idB);
  assert.notEqual(match.board[cellIndex(0, 0)], 0);

  // Bの配置マス(5,5)はB自身しか触れていないので、A消滅の影響を受けず状態1のまま残る
  assert.equal(match.board[cellIndex(5, 5)], 1);
});

// ---------------------------------------------------------------------------
// lastToucherSide(陣営の記録、UI描画用)
// ---------------------------------------------------------------------------

test('アリが踏んだマスの lastToucherSide が、そのアリの sideIndex+1 になる', () => {
  const match = E.createMatch({ seed: 1 });
  match.sides[0].tokens = 100;
  match.sides[1].tokens = 100;
  E.fire(match, 0, { kind: 'attack', cells: [], antX: 5, antY: 5, antDir: C.DIR_RIGHT, rule: 'RRL' });
  E.stepMatch(match);
  assert.equal(match.lastToucherSide[cellIndex(5, 5)], 1);

  E.fire(match, 1, { kind: 'attack', cells: [], antX: 8, antY: 8, antDir: C.DIR_RIGHT, rule: 'RRL' });
  E.stepMatch(match);
  const gy = E.toGlobalY(1, 8);
  assert.equal(match.lastToucherSide[cellIndex(8, gy)], 2);
});

test('発射時に置いた配置セルの lastToucherSide も発射した陣営の値になる', () => {
  const match = E.createMatch({ seed: 1 });
  match.sides[0].tokens = 100;
  match.sides[1].tokens = 100;
  E.fire(match, 0, { kind: 'attack', cells: [[3, 3]], antX: 0, antY: 0, antDir: C.DIR_RIGHT, rule: 'RRL' });
  assert.equal(match.lastToucherSide[cellIndex(3, 3)], 1);

  E.fire(match, 1, { kind: 'attack', cells: [[3, 3]], antX: 0, antY: 0, antDir: C.DIR_RIGHT, rule: 'RRL' });
  const gy = E.toGlobalY(1, 3);
  assert.equal(match.lastToucherSide[cellIndex(3, gy)], 2);
});

test('side0のアリが踏んだマスをside1のアリが後から踏むと lastToucherSide が2に上書きされる', () => {
  const match = E.createMatch({ seed: 1 });
  match.sides[0].tokens = 100;
  match.sides[1].tokens = 100;
  // 盤面中央付近(どちらの得点ラインにも近くない)を使う。端に近いマスだと
  // 相手陣営から見て「敵陣に到達した」ことになり即得点・消滅してしまうため。
  const j = cellIndex(30, 60);

  // side0のアリがまず(30,60)を踏む
  const idA = E.fire(match, 0, { kind: 'attack', cells: [], antX: 30, antY: 60, antDir: C.DIR_RIGHT, rule: 'RRL' });
  const antA = match.sides[0].ants.find((a) => a.id === idA);
  antA.life = 1000;
  E.stepMatch(match);
  assert.equal(match.lastToucherSide[j], 1);

  // side1のアリが同じグローバルマス(30,60)を踏む
  const localY = E.toLocalY(1, 60);
  const idB = E.fire(match, 1, { kind: 'attack', cells: [], antX: 30, antY: localY, antDir: C.DIR_RIGHT, rule: 'RRL' });
  const antB = match.sides[1].ants.find((a) => a.id === idB);
  antB.life = 1000;
  E.stepMatch(match);
  assert.equal(match.lastToucherSide[j], 2);
});

test('アリ消滅時のクリーンアップで白に戻ったマスは lastToucherSide も0に戻る', () => {
  const match = E.createMatch({ seed: 1 });
  match.sides[0].tokens = 1000;
  const id = E.fire(match, 0, { kind: 'disrupt', cells: [[7, 7]], antX: 0, antY: 0, antDir: C.DIR_RIGHT, rule: 'RRL' });
  const ant = match.sides[0].ants.find((a) => a.id === id);
  assert.equal(match.lastToucherSide[cellIndex(7, 7)], 1);
  ant.life = ant.steps; // 次のstepMatchで即消滅させる
  E.stepMatch(match);
  assert.equal(match.sides[0].ants.some((a) => a.id === id), false);
  assert.equal(match.board[cellIndex(7, 7)], 0);
  assert.equal(match.lastToucherSide[cellIndex(7, 7)], 0);
});

test('lastToucherSideの追加によって従来のクリーンアップ判定結果は変わらない(他のアリが踏んだマスは残る)', () => {
  const match = E.createMatch({ seed: 1 });
  match.sides[0].tokens = 1000;

  const idA = E.fire(match, 0, { kind: 'disrupt', cells: [[0, 0]], antX: 3, antY: 10, antDir: C.DIR_UP, rule: 'RRL' });
  const antA = match.sides[0].ants.find((a) => a.id === idA);
  antA.life = 1000;

  const idB = E.fire(match, 0, { kind: 'disrupt', cells: [[5, 5]], antX: 0, antY: 1, antDir: C.DIR_LEFT, rule: 'RRL' });
  const antB = match.sides[0].ants.find((a) => a.id === idB);
  antB.life = 1000;

  E.stepMatch(match);
  E.stepMatch(match);
  assert.equal(match.lastToucher[cellIndex(0, 0)], idB);
  assert.equal(match.lastToucherSide[cellIndex(0, 0)], 1); // 同じ陣営のアリBに奪われただけ

  const antA2 = match.sides[0].ants.find((a) => a.id === idA);
  antA2.life = antA2.steps + 1;
  E.stepMatch(match);
  assert.equal(match.sides[0].ants.some((a) => a.id === idA), false);

  // 従来のクリーンアップ判定(lastToucherベース)は変わらない: Bが持っているので消えない
  assert.equal(match.lastToucher[cellIndex(0, 0)], idB);
  assert.notEqual(match.board[cellIndex(0, 0)], 0);
  assert.equal(match.lastToucherSide[cellIndex(0, 0)], 1);
});

// ---------------------------------------------------------------------------
// ミラーリング
// ---------------------------------------------------------------------------

test('座標変換ヘルパが正しい(y方向の鏡像)', () => {
  assert.equal(E.toGlobalY(0, 5), 5);
  assert.equal(E.toGlobalY(1, 5), C.HEIGHT - 1 - 5);
  assert.equal(E.toLocalY(1, C.HEIGHT - 1 - 5), 5);
  assert.equal(E.mirrorDir(0, C.DIR_UP), C.DIR_UP);
  assert.equal(E.mirrorDir(1, C.DIR_UP), C.DIR_DOWN);
  assert.equal(E.mirrorDir(1, C.DIR_DOWN), C.DIR_UP);
  assert.equal(E.mirrorDir(1, C.DIR_LEFT), C.DIR_LEFT);
  assert.equal(E.mirrorDir(1, C.DIR_RIGHT), C.DIR_RIGHT);
});

test('ミラーリング: 同一テンプレートをside0/side1から撃つと鏡像軌道になり到達ステップが一致する', () => {
  const template = {
    cells: [[3, 3, 1], [4, 3, 1]],
    antX: 5,
    antY: 5,
    antDir: C.DIR_DOWN,
    kind: 'attack',
    rule: C.LEGACY_RULE,
  };
  function run(sideIndex) {
    const match = E.createMatch({ seed: 1 });
    match.sides[sideIndex].tokens = 100;
    E.fire(match, sideIndex, template);
    let steps = 0;
    let scored = null;
    while (scored === null && steps < C.ATTACK_LIFE + 10) {
      E.stepMatch(match);
      steps++;
      if (match.sides[sideIndex].ants.length === 0) {
        scored = match.sides[sideIndex].scoredAnts > 0;
      }
    }
    return { steps, scored };
  }
  const r0 = run(0);
  const r1 = run(1);
  assert.equal(r0.scored, r1.scored);
  assert.equal(r0.steps, r1.steps);
});

// ---------------------------------------------------------------------------
// 妨害
// ---------------------------------------------------------------------------

test('妨害アリが敵のアリの軌道を変える(妨害なし/ありで結果が変わる)', () => {
  // (実測)このattackはlife=2000なら妨害なしでハイウェイに乗って得点する(steps=1383)。
  // 発射位置に妨害アリの配置マスを重ねると軌道が崩れ、寿命内に得点できなくなる。
  const attack = { cells: [], antX: 30, antY: 30, antDir: C.DIR_RIGHT, kind: 'attack', rule: C.LEGACY_RULE };
  const without = E.simulateVersus(attack, [], { life: 2000 });

  const disruptor = { cells: [[30, 30]], antX: 0, antY: 0, antDir: C.DIR_UP, kind: 'disrupt', rule: C.LEGACY_RULE };
  const withDisrupt = E.simulateVersus(attack, [{ template: disruptor, side: 0, fireAtStep: 0, kind: 'disrupt' }], {
    life: 2000,
  });

  assert.equal(without.scored, true);
  assert.equal(withDisrupt.scored, false);
});

test('妨害アリ自身も他のアリの軌跡の影響を受ける', () => {
  const baseline = E.simulateSolo(
    { cells: [], antX: 5, antY: 5, antDir: C.DIR_UP, kind: 'disrupt', rule: 'RRL' },
    { life: 20, trackPath: true },
  );
  const withTrace = E.simulateSolo(
    { cells: [[5, 5]], antX: 5, antY: 5, antDir: C.DIR_UP, kind: 'disrupt', rule: 'RRL' },
    { life: 20, trackPath: true },
  );
  assert.notDeepEqual(baseline.path, withTrace.path);
});

test('妨害アリは寿命DISRUPT_LIFEでは敵陣に到達できない(乱数配置1,000通り、LEGACY_RULE)', () => {
  const rng = E.createRng(12345);
  let scoredCount = 0;
  for (let i = 0; i < 1000; i++) {
    const antX = rng.int(C.WIDTH);
    const antY = rng.int(C.ZONE_DEPTH);
    const antDir = rng.int(4);
    const r = E.simulateSolo(
      { cells: [], antX, antY, antDir, kind: 'disrupt', rule: C.LEGACY_RULE },
      { life: C.DISRUPT_LIFE },
    );
    if (r.scored) scoredCount++;
  }
  assert.equal(scoredCount, 0);
});

// ---------------------------------------------------------------------------
// ステップ順序の再現性・同時判断
// ---------------------------------------------------------------------------

test('同じシードで2回runMatchすると完全一致する(ステップ順序が固定される)', () => {
  const agentAttack = {
    decide(view) {
      if (view.step === 0 && view.tokens >= C.ATTACK_COST) {
        return { kind: 'attack', cells: [[5, 5]], antX: 8, antY: 30, antDir: C.DIR_RIGHT, rule: 'RRL' };
      }
      return null;
    },
  };
  const agentDisrupt = {
    decide(view) {
      if (view.step === 0 && view.tokens >= C.DISRUPT_COST) {
        return { kind: 'disrupt', cells: [[2, 2]], antX: 3, antY: 10, antDir: C.DIR_UP, rule: 'RRL' };
      }
      return null;
    },
  };

  const m1 = E.createMatch({ seed: 42, agents: [agentAttack, agentDisrupt] });
  m1.sides[0].tokens = 100;
  m1.sides[1].tokens = 100;
  for (let i = 0; i < 500; i++) E.stepMatch(m1);
  const stats1 = E.getStats(m1);

  const m2 = E.createMatch({ seed: 42, agents: [agentAttack, agentDisrupt] });
  m2.sides[0].tokens = 100;
  m2.sides[1].tokens = 100;
  for (let i = 0; i < 500; i++) E.stepMatch(m2);
  const stats2 = E.getStats(m2);

  assert.deepEqual(stats1, stats2);
});

test('両陣営の判断は同時: 後に処理される側の判断時にも相手の同ステップ発射がviewに見えない', () => {
  let sawEnemyCount = null;
  const agent0 = {
    decide(v) {
      if (v.step === 0) return { kind: 'attack', cells: [], antX: 5, antY: 5, antDir: C.DIR_DOWN, rule: 'RRL' };
      return null;
    },
  };
  const agent1 = {
    decide(v) {
      if (v.step === 0) sawEnemyCount = v.enemyAnts.length;
      return null;
    },
  };
  const match = E.createMatch({ seed: 1, agents: [agent0, agent1] });
  match.sides[0].tokens = 100;
  match.sides[1].tokens = 100;
  E.stepMatch(match);
  assert.equal(sawEnemyCount, 0);
});

// ---------------------------------------------------------------------------
// 勝敗判定
// ---------------------------------------------------------------------------

test('WIN_SCOREに到達すると試合が終了する', () => {
  const match = E.createMatch({ seed: 1 });
  match.sides[0].score = C.WIN_SCORE;
  E.stepMatch(match);
  assert.equal(match.phase, 'finished');
  assert.equal(match.result, 'side1');
});

test('時間切れで得点比較・同点なら引き分けになる', () => {
  const matchWin = E.createMatch({ seed: 1 });
  matchWin.step = C.TOTAL_STEPS - 1;
  matchWin.sides[0].score = 2;
  matchWin.sides[1].score = 1;
  E.stepMatch(matchWin);
  assert.equal(matchWin.phase, 'finished');
  assert.equal(matchWin.result, 'side1');
  assert.equal(matchWin.step, C.TOTAL_STEPS);

  const matchDraw = E.createMatch({ seed: 1 });
  matchDraw.step = C.TOTAL_STEPS - 1;
  matchDraw.sides[0].score = 3;
  matchDraw.sides[1].score = 3;
  E.stepMatch(matchDraw);
  assert.equal(matchDraw.phase, 'finished');
  assert.equal(matchDraw.result, 'draw');
});

test('runMatchはphaseがfinishedになるまで進める', () => {
  const match = E.createMatch({ seed: 7 });
  match.sides[0].score = C.WIN_SCORE - 1;
  match.sides[1].score = 0;
  // 発射直後に即得点する弾(y=SCORE_LINE_Y-1から'R'ルールで1歩必ず得点)を撃ち続けるエージェント
  match.sides[0].agent = {
    decide(view) {
      if (view.flyingCount < C.MAX_FLYING && view.tokens >= C.ATTACK_COST) {
        return {
          kind: 'attack',
          cells: [[5, 5]],
          antX: 15,
          antY: C.SCORE_LINE_Y - 1,
          antDir: C.DIR_RIGHT,
          rule: 'R',
        };
      }
      return null;
    },
  };
  match.sides[0].tokens = C.TOKEN_CAP;
  E.runMatch(match);
  assert.equal(match.phase, 'finished');
  assert.equal(match.result, 'side1');
});
