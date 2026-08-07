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
import { instantiateTemplate, scoringLaunchColumns, launchColumnScores, wrapX } from './template.js';

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

const launchXEl = document.getElementById('launch-x');
const launchEntryEl = document.getElementById('launch-entry');
const launchGateWarningEl = document.getElementById('launch-gate-warning');

const resultOverlay = document.getElementById('result-overlay');
const resultTitleEl = document.getElementById('result-title');
const resultDetailEl = document.getElementById('result-detail');
const btnRestart = document.getElementById('btn-restart');
const btnBackTitle = document.getElementById('btn-back-title');

// ---------------------------------------------------------------------------
// 盤面描画の定数(論理解像度。CSSの表示サイズとは別)
// ---------------------------------------------------------------------------
// v5 で 256×256 になった。CELL_PX はもはやセルの描画バッファサイズを決めない
// (ImageData は常に C.WIDTH×C.HEIGHT の1セル=1ピクセルで作る。下記 drawBoard 参照)。
// ここで決まるのは方眼線・アリ・ラベルを描く論理座標系の解像度だけ。
// --board-max-h(78vh)から実表示は概ね 800〜900 CSSpx になるので、DPR2でも過大にならない
// よう CELL_PX=4(論理解像度 1024×1024)にした。8のままだと 2048×2048 になり、
// 罫線描画(drawGrid が最大 256*2 本の線分をパスに積む)のコストが不要に増える。
const CELL_PX = 4; // 1セルの論理描画サイズ。256×256 → 1024×1024 が論理解像度
const CANVAS_W = C.WIDTH * CELL_PX;
const CANVAS_H = C.HEIGHT * CELL_PX;

const battleArea = document.querySelector('.battle-area');
let setupCanvasRaf = null;
/** setupCanvas が最後に計算した論理→表示スケール。drawGrid の細線間引き判定に使う
 *  (CELL_PX は定数なので単体では「実際に何ピクセルで表示されるか」が分からない)。 */
let boardDisplayScale = 1;

// 描画バッファは常に CANVAS_W x CANVAS_H(論理解像度)のまま固定し、描画コードは
// 一切変えない。CSS(aspect-ratio)が決めた実際の表示サイズを読み、そのCSSピクセル数
// ×DPRだけバッキングストアを持たせ、論理解像度→表示解像度のスケールを setTransform で1本にする。
// v5 で aspect-ratio が 1:1 になったので、縦横どちらかだけ計算すれば揃うという前提が
// 崩れる余地がある(丸め誤差・レイアウト都合で縦横比が完全一致しない場合)。
// 縦横それぞれのスケールを検算し、小さい方(＝全体が収まる方)を採用して非一様な
// 引き伸ばしを避ける(DESIGN.md 不変条件1: 盤面を引き伸ばさない)。
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
    const scaleX = backingW / CANVAS_W;
    const scaleY = backingH / CANVAS_H;
    const scale = Math.min(scaleX, scaleY); // 非一様スケールにしない(引き伸ばし禁止)
    boardDisplayScale = scale;
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
/**
 * 1フレームで消化してよい論理ステップ数の上限(極端な遅延時のスパイラル防止)。
 * v5 で 120→300 step/s に上げたため固定値16は前提が崩れている(120step/sの
 * 前提だと16は約133msぶんにしかならず、30fps(≒33ms/frame)でも1フレームで
 * 追いつききれない)。「30fpsまで落ちても実時間に追従できる最低ステップ数」
 * = ceil(STEPS_PER_SECOND / 30) を基準に、瞬間的な遅延吸収の余裕を持たせて2倍にする。
 * これを超える遅延は loop() 側の delta>250ms クランプが意図的に「追いつかず遅れる」
 * 側に倒す(スパイラル防止が優先、これはバグではない)。
 */
const MAX_STEPS_PER_FRAME = Math.ceil(C.STEPS_PER_SECOND / 30) * 2; // 300/s → 20

let activeTab = 'attack';
let selectedTemplateId = null; // プレイヤーが選択中のテンプレート
let selectedThreatAntId = null; // 選択中の敵攻撃アリ(識別・カウンター表示用)
/**
 * プレイヤーが選択中の発射列(antX)。§v5 で発射列が可変になったため、テンプレート選択とは
 * 別に保持する。テンプレートを新規選択するたびに `defaultAntXForTemplate` の値に戻す
 * (タスク要件: 「テンプレートを切り替えたら初期値に戻す」)。
 */
let selectedAntX = 0;
let pointerSelectingAntX = false; // 盤面をポインタでドラッグして発射列を選んでいる最中か

// engine.js はセルの「最後に触れた陣営」を直接は保持していない(match.lastToucher は
// アリの id)。engine.js は board と同じ長さで `match.lastToucherSide` を保守しており、
// 盤面描画(drawBoard の fillBoardImageData)はそれをそのまま読む。
// 0=未接触 / 1=side1(藍) / 2=side2(朱)。色相=陣営・濃度=状態 という2軸の描画のうち、
// 色相側の入力になる(DESIGN.md 参照)。

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
  selectedAntX = 0;
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
// ゲームループ(論理は固定ステップ C.STEPS_PER_SECOND/秒、描画はrAF。アキュムレータ方式)
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
/** テンプレート(相対 cells)を発射列 antX で実体化し、engine が受け取れる action にする。
 *  座標変換は自前で書かず、必ず template.js の instantiateTemplate を経由する。 */
function templateAction(kind, tpl, antX) {
  const inst = instantiateTemplate(tpl, antX);
  return { ...inst, kind };
}

function findTemplate(kind, id) {
  const list = kind === 'attack' ? templatesData.attack : templatesData.disrupt;
  return (list ?? []).find((t) => t.id === id) ?? null;
}

/**
 * テンプレートを新規選択したときの発射列の初期値。
 * 「得点ゲートに届く区間の中央」(タスク要件)。届く区間が無い(entryXAt0 が無い)
 * テンプレートは、フォールバックとしてテンプレート既定の antX(無ければ盤面中央)を使う。
 */
function defaultAntXForTemplate(tpl) {
  const gate = scoringLaunchColumns(tpl);
  if (gate.count > 0) {
    return wrapX(gate.min + Math.floor(gate.count / 2));
  }
  return wrapX(tpl.antX ?? Math.floor(C.WIDTH / 2));
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
      if (selectedTemplateId === tpl.id) {
        selectedTemplateId = null;
      } else {
        selectedTemplateId = tpl.id;
        // 新規選択時の発射列の初期値:
        //   妨害 + 脅威を選択中 → counterTable の deltaX から求まる「当たる列」に合わせる。
        //     v5 では列を合わせないと迎撃が成立しないので、ここで自動で寄せないと
        //     推奨タイミングだけ出て実際には当てられない、という状態になる。
        //   それ以外 → 得点ゲートに届く区間の中央。
        const counterX = activeTab === 'disrupt' ? recommendedCounterAntX(tpl.id) : null;
        selectedAntX = counterX ?? defaultAntXForTemplate(tpl);
      }
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
  return templateAction(activeTab, tpl, selectedAntX);
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
// 発射列(antX)の選択 — 盤面クリック/ドラッグ、キーボード(←/→、Shiftで16列)
// プレイヤー vs CPU で、テンプレートを選択している間だけ有効。
// ---------------------------------------------------------------------------

/** ポインタイベントの clientX を盤面の論理列(0..WIDTH-1)に変換する。
 *  CSS 表示サイズ(getBoundingClientRect)基準で計算するので、DPR やレイアウトの
 *  スケールに依存しない。 */
function antXFromPointerEvent(ev) {
  const rect = canvas.getBoundingClientRect();
  const ratio = rect.width > 0 ? (ev.clientX - rect.left) / rect.width : 0;
  return wrapX(Math.floor(ratio * C.WIDTH));
}

function canSelectLaunchColumn() {
  return mode !== 'cvc' && !!selectedTemplateId && !!match && match.phase !== 'finished';
}

canvas.addEventListener('pointerdown', (ev) => {
  if (!canSelectLaunchColumn()) return;
  pointerSelectingAntX = true;
  selectedAntX = antXFromPointerEvent(ev);
  canvas.setPointerCapture(ev.pointerId);
});
canvas.addEventListener('pointermove', (ev) => {
  if (!pointerSelectingAntX || !canSelectLaunchColumn()) return;
  selectedAntX = antXFromPointerEvent(ev);
});
canvas.addEventListener('pointerup', (ev) => {
  if (!pointerSelectingAntX) return;
  pointerSelectingAntX = false;
  if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
});
canvas.addEventListener('pointercancel', () => {
  pointerSelectingAntX = false;
});

// キーボード操作(アクセシビリティのため必須): 盤面か操作パネルにフォーカスがある状態で
// ←/→ で1列、Shift+←/→ で16列。テンプレートカードや発射ボタンなど、操作パネル内の
// どの要素にフォーカスがあっても効くよう controlPanel.contains で判定する。
document.addEventListener('keydown', (ev) => {
  if (!canSelectLaunchColumn()) return;
  if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
  const focused = document.activeElement;
  const focusInBoard = focused === canvas;
  const focusInPanel = controlPanel.contains(focused);
  if (!focusInBoard && !focusInPanel) return;
  ev.preventDefault();
  const step = ev.shiftKey ? 16 : 1;
  selectedAntX = wrapX(selectedAntX + (ev.key === 'ArrowLeft' ? -step : step));
});

// ---------------------------------------------------------------------------
// 敵の攻撃の識別・カウンター強調表示
//
// 敵の攻撃アリの識別。docs/spec.md 機能3 のとおり、**発射行と向き**から
// identifyTable を引いて攻撃ID(A1〜A9)を決める。9種は (antY, antDir) がすべて
// 異なるように選抜されているので一意に決まる(選抜基準の必須項目)。
//
// ⚠️ v5: キーは "antY,antDir"。**発射列 antX は識別に使えない**(発射時に自由に
// 選ぶ自由度になったため、同じテンプレートでも毎回違う列から飛んでくる)。
// spawnX は識別ではなく「迎撃をどの列から撃つか」を deltaX から求めるのに使う。
//
// view の spawnX/spawnY/spawnDir は「発射した陣営自身のローカル座標での発射位置」で、
// アリが動いても変わらない。現在位置(ownerX/ownerY/ownerDir)はアリが毎ステップ
// 動くので識別には使えない。
// ---------------------------------------------------------------------------
function identifyAttack(ant) {
  if (!ant) return null;
  return templatesData.identifyTable?.[`${ant.spawnY},${ant.spawnDir}`] ?? null;
}

/**
 * カウンター候補を「実際に撃つべき発射列」まで解決する。
 * counterTable の deltaX は**攻撃の発射列からの相対**なので、絶対列は
 * `wrapX(敵攻撃の spawnX + deltaX)` になる。
 */
function resolveCounter(threat, cand) {
  return { ...cand, antX: wrapX(threat.spawnX + (cand.deltaX ?? 0)) };
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
  // ⚠️ v5: 迎撃は「どの妨害を・いつ」だけでは足りず、**どの列から撃つか**まで揃えないと
  // 当たらない(counterTable は deltaX = 攻撃の発射列からの相対 で記録されている)。
  // 実際に撃つべき絶対列を必ず併記する。
  const lines = raw
    .slice()
    .sort((a, b) => (b.successRate ?? 0) - (a.successRate ?? 0))
    .slice(0, 6) // 全部出すと読めないので上位だけ
    .map((cand) => {
      const c = resolveCounter(threat, cand);
      const absStep = threat.firedAtStep + c.fireAtStep;
      const remainSec = (absStep - match.step) / C.STEPS_PER_SECOND;
      const timing = remainSec >= 0 ? `あと${remainSec.toFixed(1)}秒後` : 'タイミング終了';
      return `${c.disruptId}: x=${c.antX} から ${timing}(成功率${Math.round((c.successRate ?? 0) * 100)}%)`;
    });
  threatDetailEl.textContent = `${attackId} への迎撃候補\n` + lines.join('\n');
}

/**
 * いま選んでいる脅威に対して、いま選んでいる妨害テンプレートで撃つべき発射列を返す。
 * 見つからなければ null(=プレイヤーが自由に選ぶ)。
 * これが無いと「推奨は出るが自分で列を合わせられない」状態になり、迎撃が実質不可能になる。
 */
function recommendedCounterAntX(disruptId) {
  if (!match || selectedThreatAntId == null) return null;
  const view = createSideView(match, PLAYER_SIDE);
  const threat = view.enemyAnts.find((a) => a.id === selectedThreatAntId);
  if (!threat) return null;
  const attackId = identifyAttack(threat);
  if (!attackId) return null;
  const raw = templatesData.counterTable?.[attackId] ?? [];
  const best = raw
    .filter((c) => c.disruptId === disruptId)
    .sort((a, b) => (b.successRate ?? 0) - (a.successRate ?? 0))[0];
  return best ? resolveCounter(threat, best).antX : null;
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

/**
 * board のバイト値(0..255。有効な状態は 0..MAX_COLORS-1)→ アルファ(0..255整数)の
 * 事前計算テーブル。毎フレーム65,536セル分 inkAlphaForState を呼ぶコストを避ける。
 * 状態0(未初期化の Uint8ClampedArray は0埋め)は0のまま = 紙のまま透明で、
 * 現行ロジック(状態0は描かない)と同じ結果になる。
 */
const INK_ALPHA_BYTE_TABLE = (() => {
  const table = new Uint8ClampedArray(256);
  for (let s = 1; s < 256; s++) table[s] = Math.round(inkAlphaForState(s) * 255);
  return table;
})();

/** "r, g, b" 形式の CSS 変数値を数値配列にパースする。 */
function parseRgbVar(str) {
  return str.split(',').map((s) => Number(s.trim()));
}
const AI_RGB_BYTES = parseRgbVar(COLOR_AI_RGB);
const SHU_RGB_BYTES = parseRgbVar(COLOR_SHU_RGB);

// ---------------------------------------------------------------------------
// 盤面セルのオフスクリーン ImageData(1セル=1ピクセル、C.WIDTH×C.HEIGHT固定)。
// v5 で盤面が 256×256=65,536セルになり、毎フレーム per-cell fillRect すると
// 破綻する(旧: 60×120=7,200セル)。等倍のピクセルバッファに書き込んで
// putImageData → drawImage で拡大描画する方式に置き換える。
// ---------------------------------------------------------------------------
const boardImageCanvas = document.createElement('canvas');
boardImageCanvas.width = C.WIDTH;
boardImageCanvas.height = C.HEIGHT;
const boardImageCtx = boardImageCanvas.getContext('2d', { willReadFrequently: false });
const boardImageData = boardImageCtx.createImageData(C.WIDTH, C.HEIGHT);

/** match.board / lastToucherSide をオフスクリーンの ImageData に書き込み putImageData する。
 *  状態0のセルも含め全ピクセルを毎回書く(消えたインクを透明に戻すため)。 */
function fillBoardImageData() {
  const data = boardImageData.data;
  const board = match.board;
  const toucherSide = match.lastToucherSide;
  for (let i = 0; i < C.CELL_COUNT; i++) {
    const side = toucherSide[i]; // 0=未接触 / 1=side1 / 2=side2
    const rgb = side === 2 ? SHU_RGB_BYTES : AI_RGB_BYTES; // 未接触(通常起こらない)は藍側に倒す
    const o = i * 4;
    data[o] = rgb[0];
    data[o + 1] = rgb[1];
    data[o + 2] = rgb[2];
    data[o + 3] = INK_ALPHA_BYTE_TABLE[board[i]];
  }
  boardImageCtx.putImageData(boardImageData, 0, 0);
}

function drawGrid() {
  // 方眼紙: 細線を1セルごと、太線を16セルごとに引く。まとめて1本のパスにして負荷を抑える。
  // 太線間隔16は 256÷16=16分割(v5: 旧10は256を割り切らないため16に変更。DESIGN.md 参照)。
  const MAJOR_STEP = 16;
  // 1セルの実表示ピクセル数が2px未満だと細線は潰れて見えない上に描画コストだけが残るので間引く。
  // CELL_PX は論理座標系の定数でしかないので、setupCanvas が計算した実スケールと掛け合わせて判定する。
  const cellDisplayPx = CELL_PX * boardDisplayScale;
  if (cellDisplayPx >= 2) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = COLOR_RULE_FINE;
    ctx.beginPath();
    for (let x = 0; x <= C.WIDTH; x++) {
      if (x % MAJOR_STEP === 0) continue; // 太線側で描く
      ctx.moveTo(x * CELL_PX + 0.5, 0);
      ctx.lineTo(x * CELL_PX + 0.5, CANVAS_H);
    }
    for (let y = 0; y <= C.HEIGHT; y++) {
      if (y % MAJOR_STEP === 0) continue;
      ctx.moveTo(0, y * CELL_PX + 0.5);
      ctx.lineTo(CANVAS_W, y * CELL_PX + 0.5);
    }
    ctx.stroke();
  }

  ctx.strokeStyle = COLOR_RULE_MAJOR;
  ctx.beginPath();
  for (let x = 0; x <= C.WIDTH; x += MAJOR_STEP) {
    ctx.moveTo(x * CELL_PX + 0.5, 0);
    ctx.lineTo(x * CELL_PX + 0.5, CANVAS_H);
  }
  for (let y = 0; y <= C.HEIGHT; y += MAJOR_STEP) {
    ctx.moveTo(0, y * CELL_PX + 0.5);
    ctx.lineTo(CANVAS_W, y * CELL_PX + 0.5);
  }
  ctx.stroke();
}

/**
 * 得点ゲート(§v5)の描画。C.isInScoreGate を列ごとに評価して壁区間を求める
 * (定数を直接使わず関数を経由することで、ゲートの定義が唯一の場所に留まる)。
 * ネオンやグローは使わず、方眼紙に馴染む「沈んだ面+境界の点線」で表現する。
 *
 * 塗りは盤面全高ではなく、両陣営の配置可能帯(y<ZONE_DEPTH と y>=SCORE_LINE_Y)だけに
 * 限定する。ゲートが効くのは「敵陣に到達した瞬間」だけで、中間地帯やゲート外側の
 * 配置可能帯そのものは通常どおり配置・発射に使える。全高を塗ると「この列は使えない」
 * という誤読を招くため。
 */
function drawScoreGateWalls() {
  ctx.save();
  ctx.fillStyle = COLOR_RULE_MAJOR;
  ctx.globalAlpha = 0.28;
  let wallStart = null;
  for (let x = 0; x <= C.WIDTH; x++) {
    const isWall = x < C.WIDTH && !C.isInScoreGate(x);
    if (isWall && wallStart === null) wallStart = x;
    if (!isWall && wallStart !== null) {
      const wx = wallStart * CELL_PX;
      const ww = (x - wallStart) * CELL_PX;
      ctx.fillRect(wx, 0, ww, C.ZONE_DEPTH * CELL_PX); // side1 配置帯側
      ctx.fillRect(wx, C.SCORE_LINE_Y * CELL_PX, ww, C.ZONE_DEPTH * CELL_PX); // side2 配置帯側
      wallStart = null;
    }
  }
  ctx.restore();

  // ゲートの境界(壁と可動域の切れ目)を太めの点線で示す
  ctx.save();
  ctx.strokeStyle = COLOR_RULE_MAJOR;
  ctx.lineWidth = 2;
  ctx.setLineDash([CELL_PX * 2, CELL_PX]);
  ctx.beginPath();
  ctx.moveTo(C.SCORE_GATE_X_MIN * CELL_PX, 0);
  ctx.lineTo(C.SCORE_GATE_X_MIN * CELL_PX, CANVAS_H);
  ctx.moveTo(C.SCORE_GATE_X_MAX * CELL_PX, 0);
  ctx.lineTo(C.SCORE_GATE_X_MAX * CELL_PX, CANVAS_H);
  ctx.stroke();
  ctx.restore();
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

  drawScoreGateWalls();
  drawGrid();

  ctx.strokeStyle = COLOR_RULE_MAJOR;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, C.ZONE_DEPTH * CELL_PX + 0.5);
  ctx.lineTo(CANVAS_W, C.ZONE_DEPTH * CELL_PX + 0.5);
  ctx.moveTo(0, C.SCORE_LINE_Y * CELL_PX + 0.5);
  ctx.lineTo(CANVAS_W, C.SCORE_LINE_Y * CELL_PX + 0.5);
  ctx.stroke();

  // セル。色相=最後に触れた陣営、濃度=状態値(0..15)。ImageData を等倍で作り拡大描画する
  // (per-cell fillRect は 65,536セルで破綻するため v5 で置き換えた)。
  fillBoardImageData();
  ctx.imageSmoothingEnabled = false; // 拡大時に補間でぼやけさせない(方眼紙のくっきり感を保つ)
  ctx.drawImage(boardImageCanvas, 0, 0, CANVAS_W, CANVAS_H);
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
 *  プレイヤーは常に side1 なので配置マスは藍で表示する(攻撃/妨害の区別はアリの形で示す)。
 *  cells は**アリからの相対座標**なので、選択中の発射列 antX で instantiateTemplate を
 *  通してから絶対座標に変換する(v5 で antX が可変になったため、tpl.cells を直接
 *  絶対座標として描くと誤描画する)。 */
function drawPreview() {
  if (mode === 'cvc' || !selectedTemplateId) return;
  const tpl = findTemplate(activeTab, selectedTemplateId);
  if (!tpl) return;
  const inst = instantiateTemplate(tpl, selectedAntX);
  ctx.save();
  ctx.fillStyle = `rgba(${COLOR_AI_RGB}, 0.45)`;
  for (const cell of inst.cells) {
    const [x, y] = cell; // cells は [x, y, state] の3要素(state はプレビューでは使わない)
    ctx.fillRect(x * CELL_PX, y * CELL_PX, CELL_PX, CELL_PX);
  }
  ctx.restore();
  drawAnt(inst.antX, inst.antY, inst.antDir, COLOR_AI, activeTab, 0.7);
}

/**
 * 選択中の発射列を示す縦のガイド線。発射位置(antY)から進行方向(プレイヤーは常に
 * side1=画面上なので、進行方向は常に y が増える向き)へ、盤面下端まで細い破線を引く。
 * ネオン/グローは使わず、方眼紙に馴染む細線+破線で表現する(DESIGN.md)。
 */
function drawLaunchGuide() {
  if (mode === 'cvc' || !selectedTemplateId) return;
  const tpl = findTemplate(activeTab, selectedTemplateId);
  if (!tpl) return;
  const x = selectedAntX * CELL_PX + CELL_PX / 2;
  const yStart = (tpl.antY ?? 0) * CELL_PX;
  ctx.save();
  ctx.strokeStyle = COLOR_AI;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 1;
  ctx.setLineDash([CELL_PX * 2, CELL_PX * 2]);
  ctx.beginPath();
  ctx.moveTo(x, yStart);
  ctx.lineTo(x, CANVAS_H);
  ctx.stroke();
  ctx.restore();
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

/**
 * 発射列パネル(x=NNN・予測到達列・ゲート外警告)の更新。
 * 発射すること自体は禁止しない(妨害目的で得点ゲート外を撃つ選択もありうるため)ので、
 * ゲートを外れる場合も発射ボタンは無効化せず、警告テキストだけを出す。
 */
function updateLaunchPanel() {
  canvas.classList.toggle('launch-selectable', mode !== 'cvc' && !!selectedTemplateId);
  if (mode === 'cvc' || !selectedTemplateId) {
    launchXEl.textContent = '-';
    launchEntryEl.textContent = '-';
    launchGateWarningEl.textContent = '';
    return;
  }
  const tpl = findTemplate(activeTab, selectedTemplateId);
  if (!tpl) {
    launchXEl.textContent = '-';
    launchEntryEl.textContent = '-';
    launchGateWarningEl.textContent = '';
    return;
  }
  launchXEl.textContent = String(selectedAntX);
  launchEntryEl.textContent =
    tpl.entryXAt0 != null ? String(wrapX(selectedAntX + tpl.entryXAt0)) : '-';
  // ⚠️ ゲートの警告は**攻撃テンプレートにだけ**出す。妨害は敵陣に届かない設計
  // (docs/spec.md 機能5)で entryXAt0 を持たないので、そのまま judge すると
  // 「常に得点ゲートを外れます」という無意味な警告が出っぱなしになる。
  const isAttack = activeTab === 'attack' && tpl.entryXAt0 != null;
  launchGateWarningEl.textContent =
    isAttack && !launchColumnScores(tpl, selectedAntX) ? 'この列から撃つと得点ゲートを外れます' : '';
}

function render() {
  const view0 = createSideView(match, PLAYER_SIDE);
  drawBoard();
  drawAnts(view0);
  drawPreview();
  drawLaunchGuide();
  updateHud(view0);
  if (mode !== 'cvc') {
    const sig = templateListSignature();
    if (sig !== lastTemplateSig) {
      lastTemplateSig = sig;
      renderTemplateList();
    }
    updateFireButton();
    updateLaunchPanel();
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
