// data/templates.json が v5(schemaVersion 5)の不変条件を満たすことを検証する。
//
// ⚠️ これは「生成スクリプトが吐いたものを、ゲーム(app.js / cpu.js)が読める形か」を
// 確かめる唯一の自動チェック。生成ロジックを直したら必ずここが通ることを確認する。
// 手で data/templates.json を編集してはいけない(AGENTS.md「Do NOT」)。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from '../src/config.js';
import { instantiateTemplate, scoringLaunchColumns, launchColumnScores, wrapX } from '../src/template.js';
import { canFire, createMatch } from '../src/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_PATH = path.join(__dirname, '..', 'data', 'templates.json');
const templates = JSON.parse(readFileSync(TEMPLATES_PATH, 'utf8'));

test('schemaVersion が 5 で、config スナップショットが src/config.js と一致する', () => {
  assert.equal(templates.schemaVersion, 5, 'テンプレートを再生成していない(古いスキーマのまま)');
  assert.equal(templates.config.width, C.WIDTH);
  assert.equal(templates.config.height, C.HEIGHT);
  assert.equal(templates.config.zoneDepth, C.ZONE_DEPTH);
  assert.equal(templates.config.scoreGateXMin, C.SCORE_GATE_X_MIN);
  assert.equal(templates.config.scoreGateXMax, C.SCORE_GATE_X_MAX);
  assert.equal(templates.config.attackLife, C.ATTACK_LIFE);
  assert.equal(templates.config.disruptLife, C.DISRUPT_LIFE);
  assert.equal(templates.config.maxCells, C.MAX_CELLS);
  assert.equal(templates.config.templateCellRadius, C.TEMPLATE_CELL_RADIUS);
});

test('攻撃9種・妨害9種が揃っていて id が一意', () => {
  assert.equal(templates.attack.length, C.TEMPLATE_COUNT_ATTACK);
  assert.equal(templates.disrupt.length, C.TEMPLATE_COUNT_DISRUPT);
  assert.equal(new Set(templates.attack.map((a) => a.id)).size, C.TEMPLATE_COUNT_ATTACK);
  assert.equal(new Set(templates.disrupt.map((d) => d.id)).size, C.TEMPLATE_COUNT_DISRUPT);
});

test('テンプレートは antX を持たず、cells はアリからの相対座標で近傍に収まる', () => {
  for (const t of [...templates.attack, ...templates.disrupt]) {
    assert.equal(t.antX, undefined, `${t.id} が antX を持っている(発射列は発射時に選ぶ)`);
    assert.ok(Number.isInteger(t.antY) && t.antY >= 0 && t.antY < C.ZONE_DEPTH, `${t.id} の antY が配置帯の外`);
    assert.ok([0, 1, 2, 3].includes(t.antDir), `${t.id} の antDir が不正`);
    assert.ok(/^[LR]+$/.test(t.rule), `${t.id} の rule が不正`);
    assert.ok(t.rule.length >= C.MIN_COLORS && t.rule.length <= C.MAX_COLORS, `${t.id} の色数が範囲外`);
    assert.equal(t.colorCount, t.rule.length);

    assert.ok(t.cells.length >= C.MIN_TEMPLATE_CELLS, `${t.id} の配置マスが0個`);
    assert.ok(t.cells.length <= C.MAX_CELLS, `${t.id} の配置マスが上限超過`);
    const seen = new Set();
    for (const [dx, dy, state] of t.cells) {
      assert.ok(Math.abs(dx) <= C.TEMPLATE_CELL_RADIUS, `${t.id} の dx=${dx} が近傍外`);
      assert.ok(Math.abs(dy) <= C.TEMPLATE_CELL_RADIUS, `${t.id} の dy=${dy} が近傍外`);
      const y = t.antY + dy;
      assert.ok(y >= 0 && y < C.ZONE_DEPTH, `${t.id} の配置マスが配置帯の外(antY=${t.antY}, dy=${dy})`);
      assert.ok(Number.isInteger(state) && state >= 0 && state < t.rule.length, `${t.id} の state=${state} が不正`);
      const key = `${dx},${dy}`;
      assert.ok(!seen.has(key), `${t.id} の配置マス (${dx},${dy}) が重複`);
      seen.add(key);
    }
  }
});

test('identifyTable のキーが "antY,antDir" で、攻撃9種を一意に識別できる', () => {
  const keys = Object.keys(templates.identifyTable);
  assert.equal(keys.length, C.TEMPLATE_COUNT_ATTACK, '識別キーが9種そろっていない');
  for (const a of templates.attack) {
    const key = `${a.antY},${a.antDir}`;
    assert.equal(templates.identifyTable[key], a.id, `${a.id} が identifyTable から引けない(キー: ${key})`);
  }
});

test('攻撃テンプレートは entryXAt0 を持ち、寿命内に敵陣へ到達する', () => {
  for (const a of templates.attack) {
    assert.ok(Number.isInteger(a.entryXAt0), `${a.id} に entryXAt0 が無い`);
    assert.ok(a.entryXAt0 >= 0 && a.entryXAt0 < C.WIDTH, `${a.id} の entryXAt0 が範囲外`);
    assert.ok(Number.isInteger(a.arrivalStep), `${a.id} に arrivalStep が無い`);
    assert.ok(a.arrivalStep <= C.ATTACK_LIFE, `${a.id} が寿命内に届かない(arrivalStep=${a.arrivalStep})`);
    assert.equal(a.highway.trajectoryPeriodic, true, `${a.id} がハイウェイでない`);
    assert.equal(a.highway.fingerprintVerified, true, `${a.id} が厳密検証を通っていない`);
  }
});

test('攻撃テンプレートは得点ゲートに届く発射列を必ず持つ(幅は SCORE_GATE_WIDTH)', () => {
  for (const a of templates.attack) {
    const cols = scoringLaunchColumns(a);
    assert.equal(cols.count, C.SCORE_GATE_WIDTH, `${a.id} の得点可能な発射列の幅が想定と違う`);
    // 区間の両端と中央が実際に得点判定を通ること
    for (const offset of [0, Math.floor(cols.count / 2), cols.count - 1]) {
      const antX = wrapX(cols.min + offset);
      assert.ok(launchColumnScores(a, antX), `${a.id} を antX=${antX} から撃つと得点ゲートを外す`);
    }
    // 区間の1つ外は外すこと(区間が本当に境界になっている)
    assert.equal(launchColumnScores(a, wrapX(cols.min - 1)), false, `${a.id} の得点可能区間の下端が甘い`);
    assert.equal(launchColumnScores(a, wrapX(cols.min + cols.count)), false, `${a.id} の得点可能区間の上端が甘い`);
  }
});

test('counterTable が deltaX を持ち、カウンターを持たない攻撃が0件(必須条件)', () => {
  for (const a of templates.attack) {
    const entries = templates.counterTable[a.id];
    assert.ok(Array.isArray(entries) && entries.length > 0, `${a.id} にカウンターが1件も無い(BALANCE.attacksWithoutCounter=0 違反)`);
    for (const e of entries) {
      assert.ok(templates.disrupt.some((d) => d.id === e.disruptId), `${a.id} のカウンターが存在しない妨害を指している`);
      assert.ok(Number.isInteger(e.deltaX) && e.deltaX >= 0 && e.deltaX < C.WIDTH, `${a.id} のカウンターに deltaX が無い/範囲外`);
      assert.ok(C.FIRE_TIMINGS.includes(e.fireAtStep), `${a.id} のカウンターの fireAtStep が候補外`);
    }
  }
});

test('escortTable の参照先がすべて実在し、deltaX を持つ', () => {
  for (const [attackId, byIntercept] of Object.entries(templates.escortTable ?? {})) {
    assert.ok(templates.attack.some((a) => a.id === attackId), `escortTable に存在しない攻撃 ${attackId}`);
    for (const [interceptId, list] of Object.entries(byIntercept)) {
      assert.ok(templates.disrupt.some((d) => d.id === interceptId), `escortTable に存在しない迎撃 ${interceptId}`);
      for (const e of list) {
        assert.ok(templates.disrupt.some((d) => d.id === e.escortDisruptId), `escortTable に存在しない護衛 ${e.escortDisruptId}`);
        assert.ok(Number.isInteger(e.escortDeltaX), `escort に escortDeltaX が無い`);
        assert.ok(C.FIRE_TIMINGS.includes(e.fireAtStep), `escort の fireAtStep が候補外`);
      }
    }
  }
});

test('すべてのテンプレートが、どの発射列で実体化しても canFire を通る', () => {
  const match = createMatch({ seed: 1 });
  match.sides[0].tokens = C.TOKEN_CAP;
  for (const t of [...templates.attack, ...templates.disrupt]) {
    const kind = t.kind ?? (templates.attack.includes(t) ? 'attack' : 'disrupt');
    for (const antX of [0, 1, C.WIDTH - 1, Math.floor(C.WIDTH / 2)]) {
      const action = instantiateTemplate({ ...t, kind }, antX);
      const check = canFire(match, 0, action);
      assert.ok(check.ok, `${t.id} を antX=${antX} で撃てない(理由: ${check.reason})`);
    }
  }
});
