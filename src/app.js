// 画面制御・ゲームループ・描画。docs/spec.md 第4章(画面)・機能2〜4・7・8 準拠。
// ビルド不要の素の ESM。数値は src/config.js から import する(直書き禁止)。
// 見た目のトークンはすべて src/tokens.css から getComputedStyle で読む(hex 直書き禁止)。
import * as C from './config.js';
import {
  createMatch,
  createSideView,
  canFire,
  costOf,
  scheduleFire,
  stepMatch,
  getStats,
} from './engine.js';
import { createCpuAgent } from './cpu.js';

// ---------------------------------------------------------------------------
// DOM 参照
// ---------------------------------------------------------------------------
const screenStart = document.getElementById('screen-start');
const screenMatch = document.getElementById('screen-match');
const btnPvc = document.getElementById('btn-pvc');
const btnCvc = document.getElementById('btn-cvc');
const loadStatusEl = document.getElementById('load-status');
const loadErrorEl = document.getElementById('load-error');

const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');

const labelSide1 = document.getElementById('label-side1');
const labelSide2 = document.getElementById('label-side2');
const score1El = document.getElementById('score1');
const score2El = document.getElementById('score2');
const tokens1El = document.getElementById('tokens1');
const tokens2El = document.getElementById('tokens2');
const tokens1CapEl = document.getElementById('tokens1-cap');
const tokens2CapEl = document.getElementById('tokens2-cap');
const flying1El = document.getElementById('flying1');
const flying2El = document.getElementById('flying2');
const flying1CapEl = document.getElementById('flying1-cap');
const flying2CapEl = document.getElementById('flying2-cap');
const timeLeftEl = document.getElementById('time-left');
const pips1El = document.getElementById('pips1');
const pips2El = document.getElementById('pips2');

const controlPanel = document.getElementById('control-panel');
const tabButtons = document.querySelectorAll('.tab');
const templateListEl = document.getElementById('template-list');
const btnFire = document.getElementById('btn-fire');
const fireReasonEl = document.getElementById('fire-reason');
const threatItemsEl = document.getElementById('threat-items');
const threatDetailEl = document.getElementById('threat-detail');

const resultOverlay = document.getElementById('result-overlay');
const resultTitleEl = document.getElementById('result-title');
const resultDetailEl = document.getElementById('result-detail');
const btnRestart = document.getElementById('btn-restart');
const btnBackTitle = document.getElementById('btn-back-title');

// ---------------------------------------------------------------------------
// 盤面描画の定数(論理解像度。CSSの表示サイズとは別)
// ---------------------------------------------------------------------------
const CELL_PX = 8; // 1セルの描画サイズ。60x120 → 480x960 が論理解像度
const CANVAS_W = C.WIDTH * CELL_PX;
const CANVAS_H = C.HEIGHT * CELL_PX;

const battleArea = document.querySelector('.battle-area');
let setupCanvasRaf = null;

// 描画バッファは常に CANVAS_W x CANVAS_H(論理解像度)のまま固定し、描画コードは
// 一切変えない。CSS(aspect-ratio)が決めた実際の表示サイズを読み、そのCSSピクセル数
// ×DPRだけバッキングストアを持たせ、論理解像度→表示解像度のスケールを setTransform で1本にする。
function setupCanvas() {
  if (setupCanvasRaf) cancelAnimationFrame(setupCanvasRaf);
  setupCanvasRaf = requestAnimationFrame(() => {
    setupCanvasRaf = null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return; // 対戦画面が hidden のときは何もしない
    const dpr = window.devicePixelRatio || 1;
    const backingW = Math.max(1, Math.round(rect.width * dpr));
    const backingH = Math.max(1, Math.round(rect.height * dpr));
    canvas.width = backingW;
    canvas.height = backingH;
    const scale = backingW / CANVAS_W; // aspect-ratio が 1:2 固定なので backingH/CANVAS_H と一致する
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
  });
}

window.addEventListener('resize', () => setupCanvas());

// ---------------------------------------------------------------------------
// データ読み込み(fetch。試合開始前に完了させる)
// ---------------------------------------------------------------------------
let templatesData = null;
let policyData = null;
/** disruptId → その妨害がカバーする攻撃数(counterTable から逆算。ロード時に一度だけ計算)。 */
let coverageByDisruptId = new Map();

async function loadData() {
  const [tRes, pRes] = await Promise.all([fetch('data/templates.json'), fetch('data/policy.json')]);
  if (!tRes.ok || !pRes.ok) throw new Error('HTTPステータス異常');
  templatesData = await tRes.json();
  policyData = await pRes.json();

  coverageByDisruptId = new Map();
  for (const attackId of Object.keys(templatesData.counterTable ?? {})) {
    for (const cand of templatesData.counterTable[attackId]) {
      const id = cand.disruptId;
      coverageByDisruptId.set(id, (coverageByDisruptId.get(id) ?? 0) + 1);
    }
  }
}

async function initData() {
  try {
    await loadData();
    loadStatusEl.classList.add('hidden');
    btnPvc.disabled = false;
    btnCvc.disabled = false;
  } catch (err) {
    loadStatusEl.classList.add('hidden');
    loadErrorEl.classList.remove('hidden');
    loadErrorEl.textContent =
      'データの読み込みに失敗しました。file:// では動作しません。\n' +
      'HTTPサーバーで開いてください(例: npx serve .)。\n' +
      `詳細: ${err.message}`;
  }
}

// ---------------------------------------------------------------------------
// 試合状態
// ---------------------------------------------------------------------------
let match = null;
let mode = 'pvc'; // 'pvc' | 'cvc'
const PLAYER_SIDE = 0; // プレイヤーは常に side1(上・藍)。CPU は side2(下・朱)
let rafId = null;
let lastTs = 0;
let accMs = 0;
const STEP_MS = 1000 / C.STEPS_PER_SECOND;
const MAX_STEPS_PER_FRAME = 16; // 極端な遅延時のスパイラル防止

let activeTab = 'attack';
let selectedTemplateId = null; // プレイヤーが選択中のテンプレート
let selectedThreatAntId = null; // 選択中の敵攻撃アリ(識別・カウンター表示用)

// engine.js はセルの「最後に触れた陣営」を直接は保持していない(match.lastToucher は
// アリの id)。盤面描画にはどちらの陣営が触れたかが必要なので、id → sideIndex の対応表を
// app.js 側で保持する(最小寿命 DISRUPT_LIFE=400 step ≫ MAX_STEPS_PER_FRAME=16 なので、
// 1フレームの間にアリが発生して消えて id が失われることはない)。
/**
 * そのセルを最後に触れた陣営を返す。0=未接触 / 1=side1(藍) / 2=side2(朱)。
 * engine.js が board と同じ長さで `match.lastToucherSide` を保守しているので、それをそのまま読む。
 * 色相=陣営・濃度=状態 という2軸の描画のうち、色相側の入力になる(DESIGN.md 参照)。
 */
function toucherSideAt(i) {
  return match.lastToucherSide[i];
}

/** CPU の乱数は match.rng に委譲する(Match.seed の擬似乱数を使う規則)。match 生成前に
 *  エージェントを作る必要があるため、遅延束縛のラッパーを渡す。 */
function makeCpuAgent(sideIndex) {
  return createCpuAgent({
    templates: templatesData,
    policy: policyData.policy,
    rng: {
      next: () => match.rng.next(),
      int: (n) => match.rng.int(n),
      pick: (arr) => match.rng.pick(arr),
    },
    scheduleFire: (action, atStep) => scheduleFire(match, sideIndex, action, atStep),
  });
}

function startMatch(selectedMode) {
  mode = selectedMode;
  selectedTemplateId = null;
  selectedThreatAntId = null;
  activeTab = 'attack';

  const agents = mode === 'cvc' ? [makeCpuAgent(0), makeCpuAgent(1)] : [null, makeCpuAgent(1)];
  match = createMatch({ seed: (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0, agents });

  labelSide1.textContent = mode === 'cvc' ? '(CPU)' : '(あなた)';
  labelSide2.textContent = '(CPU)';
  tokens1CapEl.textContent = String(C.TOKEN_CAP);
  tokens2CapEl.textContent = String(C.TOKEN_CAP);
  flying1CapEl.textContent = String(C.MAX_FLYING);
  flying2CapEl.textContent = String(C.MAX_FLYING);

  controlPanel.classList.toggle('hidden', mode === 'cvc');
  resultOverlay.classList.add('hidden');

  screenStart.classList.add('hidden');
  screenMatch.classList.remove('hidden');
  setupCanvas();

  lastTemplateSig = null;
  lastThreatItemsSig = null;
  renderTemplateList();
  lastTs = 0;
  accMs = 0;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(loop);
}

function backToTitle() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  match = null;
  screenMatch.classList.add('hidden');
  screenStart.classList.remove('hidden');
  resultOverlay.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// ゲームループ(論理は固定ステップ120/秒、描画はrAF。アキュムレータ方式)
// ---------------------------------------------------------------------------
function loop(ts) {
  if (!lastTs) lastTs = ts;
  let delta = ts - lastTs;
  lastTs = ts;
  if (delta > 250) delta = 250; // タブ非アクティブ復帰などの極端な遅延を丸める

  if (match.phase !== 'finished') {
    accMs += delta;
    let steps = 0;
    while (accMs >= STEP_MS && steps < MAX_STEPS_PER_FRAME && match.phase !== 'finished') {
      stepMatch(match);
      accMs -= STEP_MS;
      steps++;
    }
  }

  render();

  if (match.phase === 'finished') {
    showResultOverlay();
    return; // ループ停止(オーバーレイ表示のまま静止)
  }
  rafId = requestAnimationFrame(loop);
}

// ---------------------------------------------------------------------------
// 発射アクションの組み立て
// ---------------------------------------------------------------------------
function templateAction(kind, tpl) {
  return {
    kind,
    cells: tpl.cells,
    antX: tpl.antX,
    antY: tpl.antY,
    antDir: tpl.antDir,
    templateId: tpl.id,
  };
}

function findTemplate(kind, id) {
  const list = kind === 'attack' ? templatesData.attack : templatesData.disrupt;
  return (list ?? []).find((t) => t.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// テンプレート一覧(タブ・カード・グレーアウト・選択)
// ---------------------------------------------------------------------------
function counterSpeciesCount(attackId) {
  const raw = templatesData.counterTable?.[attackId] ?? [];
  return new Set(raw.map((c) => c.disruptId)).size;
}

function buildCardBody(kind, tpl, cost) {
  const rule = tpl.rule ?? '-';
  const colorCount = tpl.colorCount ?? tpl.rule?.length ?? '-';
  if (kind === 'attack') {
    return (
      `<div>ルール: ${rule}(${colorCount}色)</div>` +
      `<div>コスト: ${cost}</div>` +
      `<div>カウンター: ${counterSpeciesCount(tpl.id)}種</div>`
    );
  }
  return (
    `<div>ルール: ${rule}(${colorCount}色)</div>` +
    `<div>コスト: ${cost}</div>` +
    `<div>カバー: ${coverageByDisruptId.get(tpl.id) ?? 0}件</div>`
  );
}

function renderTemplateList() {
  templateListEl.innerHTML = '';
  const list = activeTab === 'attack' ? templatesData.attack : templatesData.disrupt;

  if (!list || list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'list-empty';
    empty.textContent =
      activeTab === 'attack' ? '攻撃テンプレートがありません' : '妨害テンプレートがありません';
    templateListEl.appendChild(empty);
    return;
  }

  // 選択中の敵脅威に対して有効な妨害IDの集合(強調表示用)
  const highlightIds = activeTab === 'disrupt' ? currentCounterCandidateIds() : new Set();

  for (const tpl of list) {
    const action = templateAction(activeTab, tpl);
    const check = canFire(match, PLAYER_SIDE, action);
    const cost = costOf(activeTab, tpl.cells.length);
    const isHighlight = highlightIds.has(tpl.id);

    const card = document.createElement('div');
    card.className = 'template-card';
    if (!check.ok) card.classList.add('disabled');
    if (selectedTemplateId === tpl.id) card.classList.add('selected');
    if (isHighlight) card.classList.add('highlight');

    const header = document.createElement('div');
    header.className = 'card-header';
    const idSpan = document.createElement('span');
    idSpan.textContent = tpl.id;
    header.appendChild(idSpan);
    // 色だけで無効/推奨を伝えない: 文字バッジも添える
    if (!check.ok) {
      const badge = document.createElement('span');
      badge.className = 'card-badge badge-disabled';
      badge.textContent = '発射不可';
      header.appendChild(badge);
    } else if (isHighlight) {
      const badge = document.createElement('span');
      badge.className = 'card-badge badge-highlight';
      badge.textContent = '推奨';
      header.appendChild(badge);
    }
    card.appendChild(header);

    const body = document.createElement('div');
    body.className = 'card-body';
    body.innerHTML = buildCardBody(activeTab, tpl, cost);
    card.appendChild(body);

    card.addEventListener('click', () => {
      if (!check.ok) return; // トークン不足などは選択不可
      selectedTemplateId = selectedTemplateId === tpl.id ? null : tpl.id;
      renderTemplateList();
      updateFireButton();
    });

    templateListEl.appendChild(card);
  }
}

tabButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    activeTab = btn.dataset.tab;
    tabButtons.forEach((b) => {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-selected', String(b === btn));
    });
    selectedTemplateId = null;
    renderTemplateList();
    updateFireButton();
  });
});
tabButtons.forEach((b) => b.setAttribute('aria-selected', String(b.classList.contains('active'))));

// ---------------------------------------------------------------------------
// 発射ボタン
// ---------------------------------------------------------------------------
const REASON_TEXT = {
  kind: 'テンプレート未選択',
  cells: '配置マス超過',
  zone: '配置範囲外',
  flying: `飛行数上限(${C.MAX_FLYING}匹)`,
  tokens: 'トークン不足',
};

function currentSelectedAction() {
  if (!selectedTemplateId) return null;
  const tpl = findTemplate(activeTab, selectedTemplateId);
  if (!tpl) return null;
  return templateAction(activeTab, tpl);
}

function updateFireButton() {
  if (!match || match.phase === 'finished' || mode === 'cvc') {
    btnFire.disabled = true;
    fireReasonEl.textContent = '';
    return;
  }
  const action = currentSelectedAction();
  const check = canFire(match, PLAYER_SIDE, action);
  btnFire.disabled = !check.ok;
  fireReasonEl.textContent = check.ok ? '' : REASON_TEXT[check.reason] ?? '';
}

btnFire.addEventListener('click', () => {
  const action = currentSelectedAction();
  const check = canFire(match, PLAYER_SIDE, action);
  if (!check.ok) return;
  // 「発射ボタンを押したら次のステップで fire()」→ scheduleFire で次ステップに予約する
  scheduleFire(match, PLAYER_SIDE, action, match.step + 1);
  selectedTemplateId = null;
  renderTemplateList();
  updateFireButton();
});

// ---------------------------------------------------------------------------
// 敵の攻撃の識別・カウンター強調表示
//
// 敵の攻撃アリの識別。docs/spec.md 機能3 のとおり、**発射位置と向き**から
// identifyTable を引いて攻撃ID(A1〜A9)を決める。9種は発射位置・向きがすべて
// 異なるように選抜されているので一意に決まる(選抜基準の必須項目)。
//
// view の spawnX/spawnY/spawnDir は「発射した陣営自身のローカル座標での発射位置」で、
// アリが動いても変わらない。現在位置(ownerX/ownerY/ownerDir)はアリが毎ステップ
// 動くので識別には使えない。
// ---------------------------------------------------------------------------
function identifyAttack(ant) {
  if (!ant) return null;
  return templatesData.identifyTable?.[`${ant.spawnX},${ant.spawnY},${ant.spawnDir}`] ?? null;
}

function currentEnemyThreats(view) {
  return view.enemyAnts.filter((a) => a.kind === 'attack' && identifyAttack(a));
}

function currentCounterCandidateIds() {
  if (!match || selectedThreatAntId == null) return new Set();
  const view = createSideView(match, PLAYER_SIDE);
  const threat = view.enemyAnts.find((a) => a.id === selectedThreatAntId);
  const attackId = identifyAttack(threat);
  if (!attackId) return new Set();
  const raw = templatesData.counterTable?.[attackId] ?? [];
  return new Set(raw.map((c) => c.disruptId));
}

/** 敵攻撃の一覧(クリック可能なボタン)を再構築する。ID構成が変わった時だけ呼ぶ。 */
function renderThreatItems(view) {
  threatItemsEl.innerHTML = '';
  const threats = currentEnemyThreats(view);
  if (threats.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'threat-empty';
    empty.innerHTML =
      '<p>飛来中の敵弾はありません</p>' +
      '<p>敵の攻撃が近づくとここに識別IDが出ます</p>';
    threatItemsEl.appendChild(empty);
    return;
  }
  for (const t of threats) {
    const item = document.createElement('div');
    item.className = 'threat-item';
    if (t.id === selectedThreatAntId) item.classList.add('selected');
    item.textContent = identifyAttack(t);
    item.addEventListener('click', () => {
      selectedThreatAntId = selectedThreatAntId === t.id ? null : t.id;
      renderTemplateList();
      lastThreatItemsSig = null; // 選択状態が変わったので次フレームで再構築させる
    });
    threatItemsEl.appendChild(item);
  }
}

/** 推奨タイミングの残り秒数など、毎フレーム変わりうるテキストだけを更新する(要素は作り直さない)。 */
function updateThreatDetail(view) {
  if (selectedThreatAntId == null) {
    threatDetailEl.textContent = '';
    return;
  }
  const threat = currentEnemyThreats(view).find((t) => t.id === selectedThreatAntId);
  if (!threat) {
    threatDetailEl.textContent = '';
    return;
  }
  const attackId = identifyAttack(threat);
  const raw = templatesData.counterTable?.[attackId] ?? [];
  if (raw.length === 0) {
    threatDetailEl.textContent = `${attackId}: 有効な妨害が見つかりません`;
    return;
  }
  const lines = raw
    .slice()
    .sort((a, b) => (b.successRate ?? 0) - (a.successRate ?? 0))
    .map((c) => {
      const absStep = threat.firedAtStep + c.fireAtStep;
      const remainSec = (absStep - match.step) / C.STEPS_PER_SECOND;
      const timing = remainSec >= 0 ? `あと${remainSec.toFixed(1)}秒後に撃つ` : 'タイミング終了';
      return `${c.disruptId}: 成功率${Math.round((c.successRate ?? 0) * 100)}% ${timing}`;
    });
  threatDetailEl.textContent = `${attackId} への迎撃候補\n` + lines.join('\n');
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
/** 得点升目の塗り潰し状態を更新する。要素は作り直さず class の付け外しだけにする。 */
function updatePips(pipsEl, score) {
  if (!pipsEl) return;
  const pipNodes = pipsEl.querySelectorAll('.pip');
  pipNodes.forEach((pip, i) => {
    pip.classList.toggle('filled', i < score);
  });
}

function updateHud(view0) {
  score1El.textContent = String(match.sides[0].score);
  score2El.textContent = String(match.sides[1].score);
  updatePips(pips1El, match.sides[0].score);
  updatePips(pips2El, match.sides[1].score);
  tokens1El.textContent = String(match.sides[0].tokens);
  tokens2El.textContent = String(match.sides[1].tokens);
  flying1El.textContent = String(match.sides[0].ants.length);
  flying2El.textContent = String(match.sides[1].ants.length);
  const remain = Math.max(0, C.TIME_LIMIT_SEC - view0.elapsedSec);
  timeLeftEl.textContent = remain.toFixed(0);
}

// ---------------------------------------------------------------------------
// 盤面描画 — 色はすべて tokens.css から読む(hex 直書き禁止)
// ---------------------------------------------------------------------------
function getCssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

const COLOR_AI = getCssVar('--ai', '#1f3a6e');
const COLOR_SHU = getCssVar('--shu', '#b3402b');
const COLOR_AI_RGB = getCssVar('--ai-rgb', '31, 58, 110');
const COLOR_SHU_RGB = getCssVar('--shu-rgb', '179, 64, 43');
const COLOR_AI_WASH = getCssVar('--ai-wash', '#dfe3ed');
const COLOR_SHU_WASH = getCssVar('--shu-wash', '#f0e0da');
const COLOR_RULE_FINE = getCssVar('--rule-fine', '#dfd7c8');
const COLOR_RULE_MAJOR = getCssVar('--rule-major', '#cbc0ac');
const COLOR_SUMI = getCssVar('--sumi', '#2a2620');
const COLOR_PAPER = getCssVar('--paper', '#f2ede3');
const INK_ALPHA_MIN = Number(getCssVar('--ink-alpha-min', '0.12'));
const INK_ALPHA_MAX = Number(getCssVar('--ink-alpha-max', '0.92'));

/** セル状態(1..MAX_COLORS-1)を濃度(alpha)に線形補間する。状態0は呼び出し側で除外する。 */
/**
 * セル状態 → インク濃度。状態0は描かない(紙のまま)ので、描画対象は 1..MAX_COLORS-1。
 * その範囲を --ink-alpha-min .. --ink-alpha-max に線形に写す。
 * 分母は (MAX_COLORS - 2) = 14。状態15 がちょうど最大濃度になる。
 */
function inkAlphaForState(state) {
  const span = Math.max(1, C.MAX_COLORS - 2);
  const t = Math.min(1, Math.max(0, (state - 1) / span));
  return INK_ALPHA_MIN + (INK_ALPHA_MAX - INK_ALPHA_MIN) * t;
}

function drawGrid() {
  // 方眼紙: 細線を1セルごと、太線を10セルごとに引く。まとめて1本のパスにして負荷を抑える。
  ctx.lineWidth = 1;
  ctx.strokeStyle = COLOR_RULE_FINE;
  ctx.beginPath();
  for (let x = 0; x <= C.WIDTH; x++) {
    if (x % 10 === 0) continue; // 太線側で描く
    ctx.moveTo(x * CELL_PX + 0.5, 0);
    ctx.lineTo(x * CELL_PX + 0.5, CANVAS_H);
  }
  for (let y = 0; y <= C.HEIGHT; y++) {
    if (y % 10 === 0) continue;
    ctx.moveTo(0, y * CELL_PX + 0.5);
    ctx.lineTo(CANVAS_W, y * CELL_PX + 0.5);
  }
  ctx.stroke();

  ctx.strokeStyle = COLOR_RULE_MAJOR;
  ctx.beginPath();
  for (let x = 0; x <= C.WIDTH; x += 10) {
    ctx.moveTo(x * CELL_PX + 0.5, 0);
    ctx.lineTo(x * CELL_PX + 0.5, CANVAS_H);
  }
  for (let y = 0; y <= C.HEIGHT; y += 10) {
    ctx.moveTo(0, y * CELL_PX + 0.5);
    ctx.lineTo(CANVAS_W, y * CELL_PX + 0.5);
  }
  ctx.stroke();
}

function drawBoard() {
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.fillStyle = COLOR_PAPER;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // 配置可能帯(side1=上・side2=下)を「紙を折った」ウォッシュで沈ませ、境界に太線を1本引く
  ctx.fillStyle = COLOR_AI_WASH;
  ctx.fillRect(0, 0, CANVAS_W, C.ZONE_DEPTH * CELL_PX);
  ctx.fillStyle = COLOR_SHU_WASH;
  ctx.fillRect(0, C.SCORE_LINE_Y * CELL_PX, CANVAS_W, C.ZONE_DEPTH * CELL_PX);

  drawGrid();

  ctx.strokeStyle = COLOR_RULE_MAJOR;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, C.ZONE_DEPTH * CELL_PX + 0.5);
  ctx.lineTo(CANVAS_W, C.ZONE_DEPTH * CELL_PX + 0.5);
  ctx.moveTo(0, C.SCORE_LINE_Y * CELL_PX + 0.5);
  ctx.lineTo(CANVAS_W, C.SCORE_LINE_Y * CELL_PX + 0.5);
  ctx.stroke();

  // セル(状態0は紙のまま描かない)。色相=最後に触れた陣営、濃度=状態値(0..15)。
  for (let y = 0; y < C.HEIGHT; y++) {
    for (let x = 0; x < C.WIDTH; x++) {
      const i = y * C.WIDTH + x;
      const st = match.board[i];
      if (st === 0) continue;
      const side = toucherSideAt(i); // 0=未接触 / 1=side1 / 2=side2
      const rgb = side === 2 ? COLOR_SHU_RGB : COLOR_AI_RGB; // 未接触(通常起こらない)は藍側に倒す
      ctx.fillStyle = `rgba(${rgb}, ${inkAlphaForState(st)})`;
      ctx.fillRect(x * CELL_PX, y * CELL_PX, CELL_PX, CELL_PX);
    }
  }
}

/** 向き(0=up,1=right,2=down,3=left)から矢印用の角度(ラジアン、0=右向き基準)。 */
function dirToAngle(dir) {
  return [-Math.PI / 2, 0, Math.PI / 2, Math.PI][dir];
}

function drawAnt(x, y, dir, color, kind, alpha = 1) {
  const cx = x * CELL_PX + CELL_PX / 2;
  const cy = y * CELL_PX + CELL_PX / 2;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(cx, cy);
  ctx.rotate(dirToAngle(dir));
  ctx.fillStyle = color;
  ctx.beginPath();
  if (kind === 'attack') {
    // 攻撃アリ: 進行方向を向いた三角形(色だけでなく形でも種別を示す)
    ctx.moveTo(5, 0);
    ctx.lineTo(-4, 3.5);
    ctx.lineTo(-4, -3.5);
  } else {
    // 妨害アリ: 菱形
    ctx.moveTo(4, 0);
    ctx.lineTo(0, 3.5);
    ctx.lineTo(-4, 0);
    ctx.lineTo(0, -3.5);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawLabel(x, y, text) {
  ctx.save();
  ctx.font = '9px Consolas, monospace';
  ctx.textAlign = 'center';
  const tx = x * CELL_PX + CELL_PX / 2;
  const ty = y * CELL_PX - 3;
  // 明るい紙の上でも読めるよう、文字の下に紙色のハローを敷いてから塗る
  ctx.strokeStyle = COLOR_PAPER;
  ctx.lineWidth = 2.5;
  ctx.strokeText(text, tx, ty);
  ctx.fillStyle = COLOR_SUMI;
  ctx.fillText(text, tx, ty);
  ctx.restore();
}

function drawAnts(view) {
  for (const a of view.myAnts) {
    drawAnt(a.x, a.y, a.dir, COLOR_AI, a.kind);
  }
  for (const a of view.enemyAnts) {
    drawAnt(a.x, a.y, a.dir, COLOR_SHU, a.kind);
    const attackId = a.kind === 'attack' ? identifyAttack(a) : null;
    if (attackId) {
      drawLabel(a.x, a.y, attackId);
    }
  }
}

/** 選択中テンプレートのプレビュー(配置マス・アリの位置と向きを半透明で重ねる)。
 *  プレイヤーは常に side1 なので配置マスは藍で表示する(攻撃/妨害の区別はアリの形で示す)。 */
function drawPreview() {
  if (mode === 'cvc' || !selectedTemplateId) return;
  const tpl = findTemplate(activeTab, selectedTemplateId);
  if (!tpl) return;
  ctx.save();
  ctx.fillStyle = `rgba(${COLOR_AI_RGB}, 0.45)`;
  for (const cell of tpl.cells) {
    const [x, y] = cell; // cells は [x, y, state] の3要素(state はプレビューでは使わない)
    ctx.fillRect(x * CELL_PX, y * CELL_PX, CELL_PX, CELL_PX);
  }
  ctx.restore();
  drawAnt(tpl.antX, tpl.antY, tpl.antDir, COLOR_AI, activeTab, 0.7);
}

// テンプレート一覧・脅威パネルは状態が変わった時だけ再構築する。
// 毎フレーム(60fps)で innerHTML を作り直すとクリック中の要素が入れ替わってしまい、
// 操作性が悪化する(実際に puppeteer での自動操作でも要素の detach が発生することを確認した)。
let lastTemplateSig = null;
let lastThreatItemsSig = null;

function templateListSignature() {
  const side = match.sides[PLAYER_SIDE];
  return `${activeTab}|${selectedTemplateId}|${side.tokens}|${side.ants.length}|${selectedThreatAntId}`;
}

function threatItemsSignature(view0) {
  const ids = currentEnemyThreats(view0)
    .map((a) => a.id)
    .join(',');
  return `${ids}|${selectedThreatAntId}`;
}

function render() {
  const view0 = createSideView(match, PLAYER_SIDE);
  drawBoard();
  drawAnts(view0);
  drawPreview();
  updateHud(view0);
  if (mode !== 'cvc') {
    const sig = templateListSignature();
    if (sig !== lastTemplateSig) {
      lastTemplateSig = sig;
      renderTemplateList();
    }
    updateFireButton();
    const threatSig = threatItemsSignature(view0);
    if (threatSig !== lastThreatItemsSig) {
      lastThreatItemsSig = threatSig;
      renderThreatItems(view0);
    }
    updateThreatDetail(view0); // 秒数表示は毎フレーム更新(要素の作り直しはしない)
  }
}

// ---------------------------------------------------------------------------
// 結果オーバーレイ
// ---------------------------------------------------------------------------
function resultLabel(stats) {
  if (stats.result === 'draw') return '引き分け';
  if (mode === 'pvc') {
    return stats.result === 'side1' ? 'あなたの勝ち' : 'CPUの勝ち';
  }
  return stats.result === 'side1' ? 'SIDE1(CPU)の勝ち' : 'SIDE2(CPU)の勝ち';
}

function showResultOverlay() {
  const stats = getStats(match);
  resultTitleEl.textContent = resultLabel(stats);
  resultDetailEl.textContent =
    `最終スコア: SIDE1 ${stats.scores[0]} - SIDE2 ${stats.scores[1]}\n` +
    `試合時間: ${stats.durationSec.toFixed(1)}秒`;
  resultOverlay.classList.remove('hidden');
  btnRestart.focus();
}

// Esc で閉じる(=タイトルに戻る。試合は終了済みなので再開の選択肢はここでは提示しない)。
// Tab は「もう一度対戦する」「タイトルに戻る」の2ボタンの中に閉じ込める(フォーカストラップ)。
document.addEventListener('keydown', (ev) => {
  if (resultOverlay.classList.contains('hidden')) return;
  if (ev.key === 'Escape') {
    ev.preventDefault();
    backToTitle();
    return;
  }
  if (ev.key === 'Tab') {
    const focusables = [btnRestart, btnBackTitle];
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault();
      first.focus();
    }
  }
});

btnRestart.addEventListener('click', () => {
  startMatch(mode);
});
btnBackTitle.addEventListener('click', () => {
  backToTitle();
});

// ---------------------------------------------------------------------------
// 開始画面
// ---------------------------------------------------------------------------
btnPvc.addEventListener('click', () => startMatch('pvc'));
btnCvc.addEventListener('click', () => startMatch('cvc'));

// ---------------------------------------------------------------------------
// 初期化
// ---------------------------------------------------------------------------
setupCanvas();
initData();
