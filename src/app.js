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
  canSelfDestruct,
  selfDestruct,
} from './engine.js';
import { createCpuAgent } from './cpu.js';
import {
  instantiateTemplate,
  scoringLaunchColumns,
  launchColumnScores,
  launchPathSegments,
  wrapX,
} from './template.js';

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
const tokenBar1El = document.getElementById('token-bar1');
const tokenBar2El = document.getElementById('token-bar2');
const tokenBar1FillEl = document.getElementById('token-bar1-fill');
const tokenBar2FillEl = document.getElementById('token-bar2-fill');
const flyingPips1El = document.getElementById('flying-pips1');
const flyingPips2El = document.getElementById('flying-pips2');

/** トークンバーの5刻み目盛り。静的な位置なので起動時に一度だけ生成する(毎フレーム触らない)。 */
function buildTokenTicks(containerEl) {
  if (!containerEl) return;
  for (let t = 5; t < C.TOKEN_CAP; t += 5) {
    const tick = document.createElement('div');
    tick.className = 'token-tick';
    tick.style.setProperty('--pos', String(t / C.TOKEN_CAP));
    containerEl.appendChild(tick);
  }
}
buildTokenTicks(tokenBar1El);
buildTokenTicks(tokenBar2El);

const controlPanel = document.getElementById('control-panel');
const panelHandles = document.querySelectorAll('.panel-handle');
const btnPanelToggle = document.getElementById('btn-panel-toggle');
/** 「表示」を押したときに開き直す区画。既定は札(攻撃/妨害)。 */
let lastOpenSection = 'template';
const panelSections = {
  template: document.getElementById('panel-template'),
  threat: document.getElementById('panel-threat'),
  self: document.getElementById('panel-self'),
  legend: document.getElementById('panel-legend'),
};
const templateListEl = document.getElementById('template-list');
const btnFire = document.getElementById('btn-fire');
const fireReasonEl = document.getElementById('fire-reason');
const threatItemsEl = document.getElementById('threat-items');
const threatDetailEl = document.getElementById('threat-detail');
const selfDestructItemsEl = document.getElementById('self-destruct-items');
const btnSelfDestruct = document.getElementById('btn-self-destruct');
const selfDestructReasonEl = document.getElementById('self-destruct-reason');

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

/**
 * 盤面の実寸が変わったら必ず貼り直す。
 *
 * window の resize だけに頼ると取りこぼす: 対戦画面が hidden から表示に変わった瞬間、
 * 縦スクロールバーの出現で幅が数px変わったとき、操作パネルが出入りしたとき — どれも
 * resize イベントは飛ばない。実測で「バッキングストアが既定の 300×150 のまま」
 * (盤面がぼやける)や「バッキング545pxに対し実表示530px」というズレが出ていた。
 * ResizeObserver なら 0 → 実寸の遷移も含めて拾えるので、これを正とする。
 *
 * canvas.width の代入は CSS の box(width/height:100%)を変えないので、
 * 監視 → 再設定 → 再通知 のループにはならない。
 */
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => setupCanvas()).observe(canvas);
}

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
/** 直近の rAF タイムスタンプ。得点演出・自爆演出のタイマー(nowTs 起点)に使う。 */
let nowTs = 0;
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
/**
 * 操作パネルで現在開いている区画。'template' | 'threat' | 'self' | 'legend' | null(全部閉じている)。
 * 一度に見せる区画は1つだけ(タスク要件)。既定値は null(全区画を閉じた状態)で、
 * これが 375×667 のような背の低い画面でもページが伸びない土台になる。
 */
let openSection = null;
let selectedTemplateId = null; // プレイヤーが選択中のテンプレート
let selectedThreatAntId = null; // 選択中の敵攻撃アリ(識別・カウンター表示用)
let selectedSelfDestructAntId = null; // 選択中の自分の飛行中アリ(自爆対象)
/**
 * プレイヤーが選択中の発射列(antX)。§v5 で発射列が可変になったため、テンプレート選択とは
 * 別に保持する。テンプレートを新規選択するたびに `defaultAntXForTemplate` の値に戻す
 * (タスク要件: 「テンプレートを切り替えたら初期値に戻す」)。
 */
let selectedAntX = 0;
let pointerSelectingAntX = false; // 盤面をポインタでドラッグして発射列を選んでいる最中か

/**
 * 自分の飛行中アリの id → 固有スロット番号(1..C.MAX_FLYING)。
 * 盤面のバッジ(`#1`〜`#4`)と自爆パネルの行を1対1で対応させるための識別子。
 * `ant.id` は連番で桁が増え続けるため出さない。`templateId` は複数のアリで
 * 重複しうるため識別に使えない。実体は `sideAntSlots[0]`(slot 0..3)で、
 * ラベルは表示用に1始まりへ変換する(syncSideAntSlots で毎フレーム同期)。
 * 試合開始時にリセットする。
 */

/** 盤面バッジ・自爆パネルで共通して使う表示ラベル(`#1`〜`#4`)。 */
function myAntLabel(id) {
  const slot = antSlot(0, id);
  return slot != null ? `#${slot + 1}` : '#?';
}

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
    // v6: 方策は「24次元 Action 評価器の重み」ひとつだけ(data/policy.json の weights)。
    // 旧スキーマの `policy` オブジェクト(fireThreshold / defendBias / …)は廃止した。
    weights: policyData.weights,
    rng: {
      next: () => match.rng.next(),
      int: (n) => match.rng.int(n),
      pick: (arr) => match.rng.pick(arr),
    },
    scheduleFire: (action, atStep) => scheduleFire(match, sideIndex, action, atStep),
    // ⚠️ v5 系ではここを渡していなかったため、ブラウザの CPU だけ自爆できなかった
    // (学習・検証スクリプトは渡していたので、実プレイと学習で挙動が食い違っていた)。
    // v6 では SELF_DESTRUCT が他の Action と同列の候補なので、配線漏れは方策の一部を殺す。
    selfDestruct: (antId) => selfDestruct(match, sideIndex, antId),
  });
}

function startMatch(selectedMode) {
  mode = selectedMode;
  selectedTemplateId = null;
  selectedThreatAntId = null;
  selectedSelfDestructAntId = null;
  selectedAntX = 0;
  activeTab = 'attack';
  sideAntSlots[0].clear();
  sideAntSlots[1].clear();
  labelAnchors.clear();
  paletteIndexByAntId.fill(0);
  resetScoreEffects();
  selfDestructEffects = [];

  const agents = mode === 'cvc' ? [makeCpuAgent(0), makeCpuAgent(1)] : [null, makeCpuAgent(1)];
  match = createMatch({ seed: (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0, agents });

  labelSide1.textContent = mode === 'cvc' ? 'CPU' : 'あなた';
  labelSide2.textContent = 'CPU';
  tokens1CapEl.textContent = String(C.TOKEN_CAP);
  tokens2CapEl.textContent = String(C.TOKEN_CAP);
  flying1CapEl.textContent = String(C.MAX_FLYING);
  flying2CapEl.textContent = String(C.MAX_FLYING);

  controlPanel.classList.toggle('hidden', mode === 'cvc');
  setOpenSection(null); // 対戦開始のたびに全区画を閉じた既定状態に戻す
  resultOverlay.classList.add('hidden');

  screenStart.classList.add('hidden');
  screenMatch.classList.remove('hidden');
  setupCanvas();

  lastTemplateSig = null;
  lastThreatItemsSig = null;
  lastSelfDestructItemsSig = null;
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
  nowTs = ts;
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

/**
 * 役割ID → 日本語表示名(v5.5 §20)。
 * ⚠️ `tpl.id`(A1/D1 等)から役割を引く対応表は作らない。選抜順が変わると
 * ID↔役割の対応だけが古くなる二重の真実になるため、必ず `tpl.role` を読む。
 * 攻撃・妨害で役割IDの文字列は重複しないので、1つの表にまとめてよい。
 */
const ROLE_LABEL = {
  speed: '高速',
  economy: '低コスト',
  robust: '突破力',
  cheap: '安価',
  general: '汎用',
  complement: '補完',
};

/**
 * カード内の情報階層: コストを先頭・最も強く、ルール文字列を末尾・最も弱くする
 * (プレイヤーが札を選ぶとき最初に見るのはコストのため)。表示する情報自体は
 * 変えず、順序と強弱(クラス)だけを変える。
 */
/** `shortfall` はトークンがあと何点足りないか(足りているなら 0)。 */
function buildCardBody(kind, tpl, cost, shortfall = 0) {
  const rule = tpl.rule ?? '-';
  const colorCount = tpl.colorCount ?? tpl.rule?.length ?? '-';
  const middleLine =
    kind === 'attack'
      ? `<div class="card-counter">カウンター: ${counterSpeciesCount(tpl.id)}種</div>`
      : `<div class="card-counter">カバー: ${coverageByDisruptId.get(tpl.id) ?? 0}件</div>`;
  // 不足分(あと N)はヘッダのバッジ側だけに出す。ここにも出すと同じ数字が1枚のカードに
  // 二度並んで読みにくい(バッジのほうが一覧を流し見するときに目に入る)。
  return (
    `<div class="card-cost">コスト: ${cost}</div>` +
    middleLine +
    `<div class="card-rule">ルール: ${rule}(${colorCount}色)</div>`
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
    // トークン不足のときだけ「あと何点か」を出す(飛行数上限などは待っても増えない)。
    const shortfall =
      !check.ok && check.reason === 'tokens'
        ? Math.max(0, cost - match.sides[PLAYER_SIDE].tokens)
        : 0;

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
    // 役割(§20): tpl.role が無い古いデータでは何も出さない(「役割: -」の連呼はノイズ)。
    const roleLabel = ROLE_LABEL[tpl.role];
    if (roleLabel) {
      const roleSpan = document.createElement('span');
      roleSpan.className = 'card-role';
      roleSpan.textContent = roleLabel;
      header.appendChild(roleSpan);
    }
    // 色だけで無効/推奨を伝えない: 文字バッジも添える。
    // 「発射不可」とだけ出しても次に何をすればいいか分からないので、理由を出す。
    // 大半はトークン不足なので、その場合は「あと N」という待てば解消する表示にする。
    if (!check.ok) {
      const badge = document.createElement('span');
      badge.className = 'card-badge badge-disabled';
      badge.textContent = shortfall > 0 ? `あと${shortfall}` : REASON_TEXT[check.reason] ?? '発射不可';
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
    body.innerHTML = buildCardBody(activeTab, tpl, cost, shortfall);
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

// ---------------------------------------------------------------------------
// 操作パネルの区画開閉(盤面の端のハンドル列 + 開く区画)。
// 一度に見せる区画は1つだけ。同じハンドルをもう一度押すと閉じる。
// 攻撃/妨害ハンドルは既存の .tab の流儀を兼ねる(押すと activeTab も切り替わり、
// 切替のたびに選択中テンプレートをリセットする)。
// ---------------------------------------------------------------------------
function setOpenSection(name) {
  openSection = name;
  for (const [key, el] of Object.entries(panelSections)) {
    if (!el) continue;
    el.classList.toggle('hidden', key !== name);
  }
  panelHandles.forEach((btn) => {
    if (btn === btnPanelToggle) return; // 区画を持たないので選択状態を持たない
    const target = btn.dataset.panel ?? (btn.dataset.tab ? 'template' : null);
    const isOpenHandle = target === name && (target !== 'template' || btn.dataset.tab === activeTab);
    btn.classList.toggle('active', isOpenHandle);
    btn.setAttribute('aria-selected', String(isOpenHandle));
  });
  if (btnPanelToggle) {
    // 開いていれば「隠す」、閉じていれば「表示」。押したときに何が起きるかを label にする。
    btnPanelToggle.textContent = name ? '隠す' : '表示';
    btnPanelToggle.setAttribute('aria-expanded', String(!!name));
  }
  if (name) lastOpenSection = name; // 「表示」で戻す先を覚えておく
}

if (btnPanelToggle) {
  btnPanelToggle.addEventListener('click', () => {
    setOpenSection(openSection ? null : lastOpenSection);
  });
}

panelHandles.forEach((btn) => {
  if (btn === btnPanelToggle) return; // 上で専用のハンドラを付けてある
  btn.addEventListener('click', () => {
    const target = btn.dataset.panel ?? 'template';
    const isTabHandle = !!btn.dataset.tab;
    const alreadyOpenSame =
      openSection === target && (!isTabHandle || activeTab === btn.dataset.tab);

    if (isTabHandle) {
      activeTab = btn.dataset.tab;
      selectedTemplateId = null;
      renderTemplateList();
      updateFireButton();
    }

    setOpenSection(alreadyOpenSame ? null : target);
  });
});
setOpenSection(null); // 既定は全区画を閉じる(ページを伸ばさない土台)

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
// 自爆パネル(自分の飛行中アリを選んで即座に削除する。得点はしない)
// ---------------------------------------------------------------------------
const KIND_LABEL = { attack: '攻撃', disrupt: '妨害' };

/** 寿命の何%を消化したか(整数%)。ant.life は0にならない前提だが念のため防御する。 */
function progressPercent(ant) {
  if (!ant.life) return 0;
  return Math.min(100, Math.round((ant.steps / ant.life) * 100));
}

/** アリID → 経過%を表示する span 要素。renderSelfDestructItems で構築し直すたび張り替える。 */
let selfDestructProgressEls = new Map();

/** 自分の飛行中アリの一覧(クリック可能なボタン)を再構築する。ID構成が変わった時だけ呼ぶ。
 *  経過%は毎ステップ変わるのでここでは初期値だけ埋め、更新は updateSelfDestructProgress に任せる
 *  (毎フレーム作り直すと選択中の要素が detach され操作性が壊れるため)。 */
function renderSelfDestructItems(view) {
  selfDestructItemsEl.innerHTML = '';
  selfDestructProgressEls = new Map();
  const ants = view.myAnts;
  if (ants.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'threat-empty';
    empty.innerHTML = '<p>飛行中の自分のアリはいません</p>';
    selfDestructItemsEl.appendChild(empty);
    return;
  }
  for (const a of ants) {
    const item = document.createElement('div');
    item.className = 'threat-item self-destruct-item';
    if (a.id === selectedSelfDestructAntId) item.classList.add('selected');

    const line1 = document.createElement('div');
    line1.className = 'self-destruct-line1';
    const swatch = document.createElement('span');
    const slot = antSlot(0, a.id) ?? 0;
    swatch.className = `swatch swatch--side1-slot${slot}`;
    swatch.setAttribute('aria-hidden', 'true');
    const line1Text = document.createElement('span');
    line1Text.textContent = `${myAntLabel(a.id)} ${KIND_LABEL[a.kind] ?? a.kind} ${a.templateId ?? '-'}`;
    line1.appendChild(swatch);
    line1.appendChild(line1Text);
    const line2 = document.createElement('div');
    line2.textContent = `発射列 x=${a.spawnX}`;
    const line3 = document.createElement('div');
    line3.textContent = '経過 ';
    const progressSpan = document.createElement('span');
    progressSpan.textContent = `${progressPercent(a)}%`;
    line3.appendChild(progressSpan);

    item.appendChild(line1);
    item.appendChild(line2);
    item.appendChild(line3);
    item.addEventListener('click', () => {
      selectedSelfDestructAntId = selectedSelfDestructAntId === a.id ? null : a.id;
      lastSelfDestructItemsSig = null; // 選択状態が変わったので次フレームで再構築させる
    });
    selfDestructItemsEl.appendChild(item);
    selfDestructProgressEls.set(a.id, progressSpan);
  }
}

/** 経過%(毎ステップ変わる)だけをテキストノードの差し替えで更新する。要素は作り直さない。 */
function updateSelfDestructProgress(view) {
  for (const a of view.myAnts) {
    const el = selfDestructProgressEls.get(a.id);
    if (el) el.textContent = `${progressPercent(a)}%`;
  }
}

/** 自爆ボタンの有効/無効と理由テキスト(既存の fireReasonEl と同じ流儀)。 */
function updateSelfDestructButton() {
  if (!match || match.phase === 'finished' || mode === 'cvc') {
    btnSelfDestruct.disabled = true;
    selfDestructReasonEl.textContent = '';
    return;
  }
  if (selectedSelfDestructAntId == null) {
    btnSelfDestruct.disabled = true;
    selfDestructReasonEl.textContent = 'アリ未選択';
    return;
  }
  const ok = canSelfDestruct(match, PLAYER_SIDE, selectedSelfDestructAntId);
  btnSelfDestruct.disabled = !ok;
  if (ok) {
    selfDestructReasonEl.textContent = '';
  } else {
    const side = match.sides[PLAYER_SIDE];
    selfDestructReasonEl.textContent =
      side.tokens < C.SELF_DESTRUCT_COST ? 'トークン不足' : '対象が見つかりません';
  }
}

btnSelfDestruct.addEventListener('click', () => {
  if (selectedSelfDestructAntId == null) return;
  const antId = selectedSelfDestructAntId;
  // selfDestruct() は同期的に軌跡セルを消してしまうので、消す**前**に演出用の
  // 情報(座標・slot・セル)を1回だけ集めておく(reduced-motion では省略)。
  const reduceMotion = prefersReducedMotion();
  const view = reduceMotion ? null : createSideView(match, PLAYER_SIDE);
  const ant = view ? view.myAnts.find((a) => a.id === antId) : null;
  const cells = ant ? captureSelfDestructCells(match, antId) : [];
  const slot = antSlot(0, antId) ?? 0;
  // 発射と違い次ステップへ予約する必要はない(タスク要件: 自爆は即座に反映してよい)。
  const ok = selfDestruct(match, PLAYER_SIDE, antId);
  if (ok) {
    // cells が空でもリング(アリが居た位置の輪)は出す。軌跡が他のアリに踏み替えられて
    // 消すべきセルが残っていない場合でも、自爆したこと自体は輪で示す必要があるため。
    if (ant) {
      selfDestructEffects.push({ cells, x: ant.x, y: ant.y, slot, startTs: nowTs, life: SELF_DESTRUCT_FX_MS });
    }
    selectedSelfDestructAntId = null;
    lastSelfDestructItemsSig = null;
  }
});

function selfDestructItemsSignature(view0) {
  const ids = view0.myAnts.map((a) => a.id).join(',');
  return `${ids}|${selectedSelfDestructAntId}`;
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
/** 直前フレームの得点(側ごと)。増えたフレームで得点演出を起動するための記憶。 */
let prevScore = [0, 0];
/** 盤面の得点ラインを強調表示する締切(nowTs と同じ時間軸)。側ごと。 */
let scoreLineFlashUntil = [0, 0];
/** HUD の得点升目のうち「インク染み込み」演出を既に付与した数(側ごと)。
 *  一度付けたら外さない(キーフレーム終端は .pip.filled と同じ見た目なので害がない)。 */
let pipFlashedCount = [0, 0];

/** 試合開始時にリセットする(前の試合の演出状態を持ち越さない)。 */
function resetScoreEffects() {
  prevScore = [0, 0];
  scoreLineFlashUntil = [0, 0];
  pipFlashedCount = [0, 0];
  for (const pipsEl of [pips1El, pips2El]) {
    pipsEl?.querySelectorAll('.pip').forEach((pip) => pip.classList.remove('just-filled'));
  }
}

/** 得点が増えたフレームを検出し、盤面の得点ライン演出の締切をセットする。
 *  reduced-motion では演出そのものを起動しない(=盤面は常に通常表示)。 */
function checkScoreFlash() {
  for (let i = 0; i < 2; i++) {
    const score = match.sides[i].score;
    if (score > prevScore[i] && !prefersReducedMotion()) {
      scoreLineFlashUntil[i] = nowTs + SCORE_LINE_FLASH_MS;
    }
    prevScore[i] = score;
  }
}

/** 得点升目の塗り潰し状態を更新する。要素は作り直さず class の付け外しだけにする。
 *  新しく塗られた升目には一度だけ 'just-filled' を付け、CSS キーフレームで
 *  「インクが染み込む」演出を1回再生する(reduced-motion はベース層の規則が
 *  animation-duration を潰すので自動的に無効化される)。 */
function updatePips(pipsEl, score, sideIdx) {
  if (!pipsEl) return;
  const pipNodes = pipsEl.querySelectorAll('.pip');
  const alreadyFlashed = pipFlashedCount[sideIdx];
  pipNodes.forEach((pip, i) => {
    pip.classList.toggle('filled', i < score);
    if (i < score && i >= alreadyFlashed) pip.classList.add('just-filled');
  });
  pipFlashedCount[sideIdx] = Math.max(pipFlashedCount[sideIdx], score);
}

/** 飛行中(0..MAX_FLYING)を slot 色の升目で示す。升目は HTML 側で slot に固定
 *  対応済み(side{1,2}-slotN)なので、ここでは filled の付け外しだけを行う。 */
function updateFlyingPips(pipsEl, sideIndex) {
  if (!pipsEl) return;
  const occupiedSlots = new Set(sideAntSlots[sideIndex].values());
  const nodes = pipsEl.querySelectorAll('.flying-pip');
  nodes.forEach((node, slot) => {
    node.classList.toggle('filled', occupiedSlots.has(slot));
  });
}

/** トークン(0..TOKEN_CAP)を連続バーで示す。--fill(0..1) を代入するだけで、
 *  実際の幅は CSS 側の transform: scaleX(var(--fill)) が描く。 */
function updateTokenBar(fillEl, tokens) {
  if (!fillEl) return;
  const fill = Math.max(0, Math.min(1, tokens / C.TOKEN_CAP));
  fillEl.style.setProperty('--fill', String(fill));
}

function updateHud(view0) {
  score1El.textContent = String(match.sides[0].score);
  score2El.textContent = String(match.sides[1].score);
  updatePips(pips1El, match.sides[0].score, 0);
  updatePips(pips2El, match.sides[1].score, 1);
  tokens1El.textContent = String(match.sides[0].tokens);
  tokens2El.textContent = String(match.sides[1].tokens);
  updateTokenBar(tokenBar1FillEl, match.sides[0].tokens);
  updateTokenBar(tokenBar2FillEl, match.sides[1].tokens);
  flying1El.textContent = String(match.sides[0].ants.length);
  flying2El.textContent = String(match.sides[1].ants.length);
  updateFlyingPips(flyingPips1El, 0);
  updateFlyingPips(flyingPips2El, 1);
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
// 個体色(slot 1〜3)。slot 0 は上の COLOR_AI / COLOR_SHU と同値。
const COLOR_HANADA_RGB = getCssVar('--hanada-rgb', '44, 110, 155');
const COLOR_SUMIRE_RGB = getCssVar('--sumire-rgb', '56, 56, 148');
const COLOR_SEIHEKI_RGB = getCssVar('--seiheki-rgb', '27, 107, 98');
const COLOR_DAIDAI_RGB = getCssVar('--daidai-rgb', '194, 102, 27');
const COLOR_KURENAI_RGB = getCssVar('--kurenai-rgb', '125, 33, 57');
const COLOR_ENJI_RGB = getCssVar('--enji-rgb', '110, 42, 34');
const COLOR_HANADA = getCssVar('--hanada', '#2c6e9b');
const COLOR_SUMIRE = getCssVar('--sumire', '#383894');
const COLOR_SEIHEKI = getCssVar('--seiheki', '#1b6b62');
const COLOR_DAIDAI = getCssVar('--daidai', '#c2661b');
const COLOR_KURENAI = getCssVar('--kurenai', '#7d2139');
const COLOR_ENJI = getCssVar('--enji', '#6e2a22');
const COLOR_AI_WASH = getCssVar('--ai-wash', '#dfe3ed');
const COLOR_SHU_WASH = getCssVar('--shu-wash', '#f0e0da');
const COLOR_RULE_FINE = getCssVar('--rule-fine', '#dfd7c8');
const COLOR_RULE_MAJOR = getCssVar('--rule-major', '#cbc0ac');
const COLOR_SUMI = getCssVar('--sumi', '#2a2620');
const COLOR_PAPER = getCssVar('--paper', '#f2ede3');
const INK_ALPHA_MIN = Number(getCssVar('--ink-alpha-min', '0.12'));
const INK_ALPHA_MAX = Number(getCssVar('--ink-alpha-max', '0.92'));
const INK_ALPHA_DIM_FACTOR = Number(getCssVar('--ink-alpha-dim-factor', '0.35'));

/** "180ms" のような CSS 変数値から ms 数値だけを取り出す(canvas 側のタイマーで使う)。 */
function msVar(name, fallback) {
  return parseFloat(getCssVar(name, fallback));
}
/** 盤面の得点ラインが一瞬濃くなる時間(app.js の canvas 描画で使う。CSS transition ではない)。 */
const SCORE_LINE_FLASH_MS = msVar('--dur-score-line-flash', '250ms');
/** 自爆時の軌跡フェード・輪の演出時間(canvas 描画)。 */
const SELF_DESTRUCT_FX_MS = msVar('--dur-self-destruct-fx', '300ms');

/** 動きを減らす設定が有効か。Canvas 側の演出(CSS では効かない)はこれを見て丸ごと省略する。 */
function prefersReducedMotion() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

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

/**
 * INK_ALPHA_BYTE_TABLE の「沈めた版」。自爆パネルで選択中のアリの軌跡だけを際立たせる際、
 * それ以外の非ゼロセルに使う(色相はそのまま、不透明度だけを --ink-alpha-dim-factor 倍する)。
 * ピクセルごとに乗算せず、テーブルを選ぶだけにするための事前計算。
 */
const INK_ALPHA_BYTE_TABLE_DIM = (() => {
  const table = new Uint8ClampedArray(256);
  for (let s = 1; s < 256; s++) {
    table[s] = Math.round(inkAlphaForState(s) * INK_ALPHA_DIM_FACTOR * 255);
  }
  return table;
})();

/** "r, g, b" 形式の CSS 変数値を数値配列にパースする。 */
function parseRgbVar(str) {
  return str.split(',').map((s) => Number(s.trim()));
}
const AI_RGB_BYTES = parseRgbVar(COLOR_AI_RGB);
const SHU_RGB_BYTES = parseRgbVar(COLOR_SHU_RGB);

/**
 * 個体色パレット(side×slot → RGB)。添字は `sideIndex*4 + slot`(0..7)。
 * slot0 は各陣営の帯の基準色(藍/朱)と同値にする(不変条件: 陣営色は入れ替えない)。
 * ピクセルごとに配列添字で引くためだけに Uint8Array(24) にフラット化する。
 */
const PALETTE_SLOT_RGB = [
  AI_RGB_BYTES,
  parseRgbVar(COLOR_HANADA_RGB),
  parseRgbVar(COLOR_SUMIRE_RGB),
  parseRgbVar(COLOR_SEIHEKI_RGB),
  SHU_RGB_BYTES,
  parseRgbVar(COLOR_DAIDAI_RGB),
  parseRgbVar(COLOR_KURENAI_RGB),
  parseRgbVar(COLOR_ENJI_RGB),
];
const PALETTE_RGB_BYTES = (() => {
  const bytes = new Uint8Array(24);
  for (let i = 0; i < 8; i++) {
    bytes[i * 3] = PALETTE_SLOT_RGB[i][0];
    bytes[i * 3 + 1] = PALETTE_SLOT_RGB[i][1];
    bytes[i * 3 + 2] = PALETTE_SLOT_RGB[i][2];
  }
  return bytes;
})();
/** アリの slot 色(canvas ストローク/塗り用の CSS 色文字列)。drawAnts が引く。 */
const PALETTE_SLOT_CSS = [
  COLOR_AI,
  COLOR_HANADA,
  COLOR_SUMIRE,
  COLOR_SEIHEKI,
  COLOR_SHU,
  COLOR_DAIDAI,
  COLOR_KURENAI,
  COLOR_ENJI,
];

/**
 * アリID(0..32767, match.lastToucher と同じ添字空間)→ パレット添字+1(0..8)。
 * 0 = 未割り当て(=そのアリはもう居ない、または一度も割り当てられていない)。
 * fillBoardImageData のピクセルループから毎フレーム65,536回読むため、
 * Map ではなく事前確保した配列にする。試合開始時に全クリアする。
 */
const paletteIndexByAntId = new Uint8Array(32768);

/** side ごとのアリID → slot(0..3)。生存アリ集合が変わったときだけ更新する(安定割当)。
 *  index 0 = 自分(view.myAnts) / index 1 = 敵(view.enemyAnts)。 */
const sideAntSlots = [new Map(), new Map()];

/** `ants`(そのフレームの生存アリ配列)と `sideAntSlots[sideIndex]` を同期する。
 *  空いている最小の slot を割り当て、消えたアリの slot と paletteIndexByAntId を解放する。 */
function syncSideAntSlots(sideIndex, ants) {
  const slots = sideAntSlots[sideIndex];
  const aliveIds = new Set(ants.map((a) => a.id));
  for (const id of slots.keys()) {
    if (aliveIds.has(id)) continue;
    slots.delete(id);
    labelAnchors.delete(id); // バッジの追従位置も一緒に捨てる(id が再利用されても引きずらない)
    if (id >= 0 && id < paletteIndexByAntId.length) paletteIndexByAntId[id] = 0;
  }
  const used = new Set(slots.values());
  for (const a of ants) {
    if (slots.has(a.id)) continue;
    let slot = 0;
    while (used.has(slot)) slot++;
    slots.set(a.id, slot);
    used.add(slot);
    if (a.id >= 0 && a.id < paletteIndexByAntId.length) {
      paletteIndexByAntId[a.id] = sideIndex * 4 + slot + 1;
    }
  }
}

/** 盤面バッジ・自爆パネルで共通して使う slot 番号(0..3)。未割り当てなら null。 */
function antSlot(sideIndex, id) {
  return sideAntSlots[sideIndex].get(id) ?? null;
}

/**
 * バッジを描く位置は、アリの現在地そのものではなく「なめらかにした追従位置」を使う。
 *
 * ラングトンのアリは 120 ステップ/秒で1マスずつ進みながら毎ステップ左右に曲がるので、
 * 現在地にバッジを貼ると 120Hz で震えて読めない(実機で確認済み)。一方、ハイウェイに
 * 乗ったあとの**巨視的な動き**は一定方向への斜め並進なので、指数移動平均で微視的な
 * ジグザグだけを落とせば、バッジはハイウェイに沿って滑らかに追従する。
 *
 * ⚠️ 左右はトーラス(`C.WRAP_HORIZONTAL`)。x が 255→0 と巻き戻ったときに素直に平均を
 * 取るとバッジが盤面を横断してしまうので、差分は必ず「短い方の向き」で測る。
 */
const LABEL_SMOOTHING = 0.08; // 0=まったく追従しない, 1=現在地に即追従(=震える)
const labelAnchors = new Map(); // antId -> { x, y }(セル座標。小数を持つ)

function labelAnchor(id, x, y) {
  const prev = labelAnchors.get(id);
  if (!prev) {
    const created = { x, y };
    labelAnchors.set(id, created);
    return created;
  }
  const half = C.WIDTH / 2;
  let dx = x - prev.x;
  if (dx > half) dx -= C.WIDTH; // 0 側へ巻き戻った
  else if (dx < -half) dx += C.WIDTH; // 255 側へ巻き戻った
  prev.x = (prev.x + dx * LABEL_SMOOTHING + C.WIDTH) % C.WIDTH;
  prev.y += (y - prev.y) * LABEL_SMOOTHING;
  return prev;
}

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
 *  状態0のセルも含め全ピクセルを毎回書く(消えたインクを透明に戻すため)。
 *
 *  `selectedSelfDestructAntId` が null でない間は、自爆パネルで選択中のアリが最後に
 *  踏んだセル(`match.lastToucher[i] === selectedSelfDestructAntId`)だけを通常濃度で
 *  描き、それ以外の非ゼロセルは色相そのまま・不透明度だけを沈める(INK_ALPHA_BYTE_TABLE_DIM)。
 *  座標系の注意: `match.board` / `match.lastToucher` はグローバル座標の配列で、
 *  プレイヤーは常に side1 なので view のローカル座標と一致するが、意味的には
 *  グローバルの添字 i で判定していることに注意(ミラーされた view 座標とは混ぜない)。
 *  性能: 65,536セル/フレームをピクセルごとに乗算しないよう、テーブルを選ぶだけにする。
 */
function fillBoardImageData() {
  const data = boardImageData.data;
  const board = match.board;
  const toucherSide = match.lastToucherSide;
  const lastToucher = match.lastToucher;
  const palette = PALETTE_RGB_BYTES;

  if (selectedSelfDestructAntId == null) {
    // 選択なし: 変更前と同じ経路(色相の決め方だけ slot 対応に拡張)。
    for (let i = 0; i < C.CELL_COUNT; i++) {
      const side = toucherSide[i]; // 0=未接触 / 1=side1 / 2=side2
      const antId = lastToucher[i];
      // パレット添字が未割り当て(=そのアリはもう居ない)なら必ずその陣営の slot0 に
      // フォールバックする。敵味方の判別は toucherSide のみで行う(陣営を絶対に崩さない)。
      const stored = antId >= 0 ? paletteIndexByAntId[antId] : 0;
      const p3 = (stored !== 0 ? stored - 1 : side === 2 ? 4 : 0) * 3;
      const o = i * 4;
      data[o] = palette[p3];
      data[o + 1] = palette[p3 + 1];
      data[o + 2] = palette[p3 + 2];
      data[o + 3] = INK_ALPHA_BYTE_TABLE[board[i]];
    }
  } else {
    const highlightId = selectedSelfDestructAntId;
    for (let i = 0; i < C.CELL_COUNT; i++) {
      const side = toucherSide[i];
      const antId = lastToucher[i];
      const stored = antId >= 0 ? paletteIndexByAntId[antId] : 0;
      const p3 = (stored !== 0 ? stored - 1 : side === 2 ? 4 : 0) * 3;
      const table = antId === highlightId ? INK_ALPHA_BYTE_TABLE : INK_ALPHA_BYTE_TABLE_DIM;
      const o = i * 4;
      data[o] = palette[p3];
      data[o + 1] = palette[p3 + 1];
      data[o + 2] = palette[p3 + 2];
      data[o + 3] = table[board[i]];
    }
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

/**
 * 配置可能帯の境界線(2本)。得点が入った瞬間、その陣営が撃ち込んだ側の折り目を
 * 一瞬濃く・太く強調する(約 --dur-score-line-flash で戻す)。グロー/ブルームは
 * 使わず、色と太さだけを一時的に差し替える。
 * side1 は下方向(y増加)へ撃つので、得点した瞬間に強調するのは下側(SCORE_LINE_Y)の
 * 線。side2 は上方向へ撃つので上側(ZONE_DEPTH)の線を強調する。
 */
function drawScoreLines() {
  const topFlash = nowTs < scoreLineFlashUntil[1]; // side2 が得点 → 上側(自陣=side1側)の線
  const bottomFlash = nowTs < scoreLineFlashUntil[0]; // side1 が得点 → 下側(敵陣=side2側)の線

  ctx.lineWidth = topFlash ? 3 : 1;
  ctx.strokeStyle = topFlash ? COLOR_SHU : COLOR_RULE_MAJOR;
  ctx.beginPath();
  ctx.moveTo(0, C.ZONE_DEPTH * CELL_PX + 0.5);
  ctx.lineTo(CANVAS_W, C.ZONE_DEPTH * CELL_PX + 0.5);
  ctx.stroke();

  ctx.lineWidth = bottomFlash ? 3 : 1;
  ctx.strokeStyle = bottomFlash ? COLOR_AI : COLOR_RULE_MAJOR;
  ctx.beginPath();
  ctx.moveTo(0, C.SCORE_LINE_Y * CELL_PX + 0.5);
  ctx.lineTo(CANVAS_W, C.SCORE_LINE_Y * CELL_PX + 0.5);
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

  drawScoreGateWalls();
  drawGrid();
  drawScoreLines();

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

// ---------------------------------------------------------------------------
// アリ・ラベルの「実表示で一定サイズ」を保つための逆算。
// 描画コードは論理座標(CELL_PX 基準)で書くが、setupCanvas がキャンバスに
// setTransform(boardDisplayScale, ...) を掛けているため、論理サイズをそのまま
// 固定値にすると盤面を縮小したときに潰れる(v5で256×256になり顕著化した)。
// 「実表示で欲しいpx数」を名前付き定数にし、都度 boardDisplayScale で割って
// 論理座標系のサイズへ逆算する。
// ---------------------------------------------------------------------------
const ANT_GLYPH_TARGET_PX = 13; // アリのグリフの目標全長(実表示px)
const ANT_STROKE_TARGET_PX = 1.6; // アリの輪郭線・ハローの目標太さ(実表示px)
const LABEL_FONT_TARGET_PX = 12; // ラベル(識別ID・自分のバッジ)の目標フォントサイズ(実表示px)
const LABEL_HALO_TARGET_PX = 2.5; // ラベルの紙色ハローの目標太さ(実表示px)
const LABEL_OFFSET_TARGET_PX = 6; // ラベルをアリの上に浮かせる目標距離(実表示px)
// 同じ陣営のアリが近づいたときにバッジ同士が重なって読めなくなるので、slot ごとに段をずらす。
const LABEL_STAGGER_TARGET_PX = 11;
const SELECT_RING_RADIUS_TARGET_PX = 18; // 自爆パネルで選択中のアリを囲む選択リングの目標半径(実表示px)
const SELECT_RING_STROKE_TARGET_PX = 1.5; // 選択リングの目標線幅(実表示px)

/** 実表示pxの目標値 → 論理座標系のサイズへ逆算する。boardDisplayScale が 0/undefined
 *  (対戦画面が hidden で setupCanvas がまだ走っていない等)のときは等倍として扱う。 */
function logicalSize(targetPx) {
  const scale = boardDisplayScale > 0 ? boardDisplayScale : 1;
  return targetPx / scale;
}

function drawAnt(x, y, dir, color, kind, alpha = 1) {
  const cx = x * CELL_PX + CELL_PX / 2;
  const cy = y * CELL_PX + CELL_PX / 2;
  const glyph = logicalSize(ANT_GLYPH_TARGET_PX);
  const strokeW = logicalSize(ANT_STROKE_TARGET_PX);
  const haloW = strokeW * 2; // ハロー(紙色の縁取り)は本体線より太く、先に描いてから本体を描く
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(cx, cy);
  ctx.rotate(dirToAngle(dir));
  if (kind === 'attack') {
    // 攻撃アリ = 塗りつぶしの三角形(進行方向を向く。鋭さで「弾」を表す)
    const half = glyph * 0.35;
    ctx.beginPath();
    ctx.moveTo(glyph * 0.55, 0);
    ctx.lineTo(-glyph * 0.45, half);
    ctx.lineTo(-glyph * 0.45, -half);
    ctx.closePath();
    ctx.strokeStyle = COLOR_PAPER;
    ctx.lineWidth = haloW;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fill();
  } else {
    // 妨害アリ = 中空の円(リング)+ 進行方向へ短い線。塗りではなく輪郭にすることで、
    // 潰れるほど縮小しても三角形(塗り)と混ざらない
    const r = glyph * 0.32;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.moveTo(r, 0);
    ctx.lineTo(glyph * 0.55, 0);
    ctx.strokeStyle = COLOR_PAPER;
    ctx.lineWidth = haloW;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.moveTo(r, 0);
    ctx.lineTo(glyph * 0.55, 0);
    ctx.strokeStyle = color;
    ctx.lineWidth = strokeW;
    ctx.stroke();
  }
  ctx.restore();
}

/** `stagger` は slot 番号。同じ陣営のバッジが重ならないように段をずらす。 */
function drawLabel(x, y, text, stagger = 0) {
  ctx.save();
  const fontPx = logicalSize(LABEL_FONT_TARGET_PX);
  ctx.font = `${fontPx}px Consolas, monospace`;
  ctx.textAlign = 'center';
  const tx = x * CELL_PX + CELL_PX / 2;
  const ty = y * CELL_PX - logicalSize(LABEL_OFFSET_TARGET_PX + stagger * LABEL_STAGGER_TARGET_PX);
  // 明るい紙の上でも読めるよう、文字の下に紙色のハローを敷いてから塗る
  ctx.strokeStyle = COLOR_PAPER;
  ctx.lineWidth = logicalSize(LABEL_HALO_TARGET_PX);
  ctx.strokeText(text, tx, ty);
  ctx.fillStyle = COLOR_SUMI;
  ctx.fillText(text, tx, ty);
  ctx.restore();
}

function drawAnts(view) {
  // アリ本体は現在地に描く(1マスの動きが見えることに意味がある)。
  // バッジだけは labelAnchor でならした位置に描く — 現在地に貼ると 120Hz で震えて読めない。
  for (const a of view.myAnts) {
    const slot = antSlot(0, a.id) ?? 0;
    drawAnt(a.x, a.y, a.dir, PALETTE_SLOT_CSS[slot], a.kind);
    const anchor = labelAnchor(a.id, a.x, a.y);
    drawLabel(anchor.x, anchor.y, myAntLabel(a.id), slot);
  }
  for (const a of view.enemyAnts) {
    const slot = antSlot(1, a.id) ?? 0;
    drawAnt(a.x, a.y, a.dir, PALETTE_SLOT_CSS[4 + slot], a.kind);
    // 既存の敵ラベル(識別ID A1〜A9)は消さずに残す。
    const attackId = a.kind === 'attack' ? identifyAttack(a) : null;
    if (attackId) {
      const anchor = labelAnchor(a.id, a.x, a.y);
      drawLabel(anchor.x, anchor.y, attackId, slot);
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

// 妨害テンプレートは entryXAt0 を持たず(敵陣までは届かない設計)、highway.driftX/driftY
// から傾きだけを取って短いガイドにする。この行数ぶん先までを描く。
const GUIDE_LINE_WIDTH_TARGET_PX = 1.5; // ガイド線の目標太さ(実表示px)
const GUIDE_REACH_SPAN_TARGET_PX = 22; // 妨害の「届く深さ」を示す破線の半幅(実表示px)
const GUIDE_DASH_TARGET_PX = 8; // 破線の目標間隔(実表示px)
const GUIDE_ARROW_TARGET_PX = 8; // 進行方向矢印の目標サイズ(実表示px)
const GUIDE_ARROW_OFFSET_TARGET_PX = 20; // 矢印を線の始点からどれだけ離すか(実表示px)

/**
 * 1本目の線分上に、進行方向を示す小さな三角形を1つ描く(セル座標→実ピクセル座標)。
 */
function drawLaunchGuideArrow(seg) {
  const x1 = seg.x1 * CELL_PX;
  const y1 = seg.y1 * CELL_PX;
  const x2 = seg.x2 * CELL_PX;
  const y2 = seg.y2 * CELL_PX;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  const ux = dx / len;
  const uy = dy / len;
  const offset = Math.min(logicalSize(GUIDE_ARROW_OFFSET_TARGET_PX), len / 2);
  const cx = x1 + ux * offset;
  const cy = y1 + uy * offset;
  const size = logicalSize(GUIDE_ARROW_TARGET_PX);
  const angle = Math.atan2(dy, dx);
  const tip = { x: cx + ux * size, y: cy + uy * size };
  const back1 = { x: cx + Math.cos(angle + Math.PI * 0.8) * size, y: cy + Math.sin(angle + Math.PI * 0.8) * size };
  const back2 = { x: cx + Math.cos(angle - Math.PI * 0.8) * size, y: cy + Math.sin(angle - Math.PI * 0.8) * size };
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(back1.x, back1.y);
  ctx.lineTo(back2.x, back2.y);
  ctx.closePath();
  ctx.fill();
}

/**
 * 選択中のテンプレートが実際にどちらへ進むかを示すガイド線。
 * 攻撃テンプレートは entryXAt0(発射列0での到達列)を使って得点ラインまでの予測進路を、
 * 妨害テンプレートは highway.driftX/driftY の傾きを使って短いガイドを描く。
 * ハイウェイは斜めに進むので、単純な縦の破線では進行方向が伝わらない
 * (盤面はトーラスなので、進路は launchPathSegments で分割してから描く)。
 * ネオン/グローは使わず、方眼紙に馴染む細線+破線で表現する(DESIGN.md)。
 */
/**
 * 妨害テンプレートのガイド。
 *
 * 妨害は敵陣に届かない設計なので `entryXAt0` も `highway`(driftX/driftY) も持たない。
 * 実データでも 9種中6種が `reachRows === 0`(その場に居座って壁になる)。
 * したがって「どこへ向かうか」を線で描けるだけの情報が無い。**推測で斜線や縦線を
 * 引かず、確かに分かっている2つだけを描く**:
 *   - 初期の向き(`antDir`) → 発射位置に矢印を1つ
 *   - 届く深さ(`reachRows`) → その行に短い破線を1本(0 のときは引かない)
 */
function drawDisruptGuide(tpl, antY) {
  const dir = tpl.antDir ?? 0;
  const reachRows = tpl.reachRows ?? 0;
  const cx = selectedAntX * CELL_PX + CELL_PX / 2;
  const cy = antY * CELL_PX + CELL_PX / 2;

  ctx.save();
  ctx.strokeStyle = COLOR_AI;
  ctx.fillStyle = COLOR_AI;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = logicalSize(GUIDE_LINE_WIDTH_TARGET_PX);

  // 初期の向きを示す矢印(進む先が分からなくても、どちらを向いて出るかは確定している)
  const size = logicalSize(GUIDE_ARROW_TARGET_PX);
  const angle = dirToAngle(dir);
  ctx.save();
  ctx.translate(cx + Math.cos(angle) * logicalSize(GUIDE_ARROW_OFFSET_TARGET_PX),
                cy + Math.sin(angle) * logicalSize(GUIDE_ARROW_OFFSET_TARGET_PX));
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(size, 0);
  ctx.lineTo(-size * 0.7, size * 0.7);
  ctx.lineTo(-size * 0.7, -size * 0.7);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // 届く深さ。プレイヤーは常に side1(画面上)なので、敵陣方向は y が増える向き。
  if (reachRows > 0) {
    const reachY = (antY + reachRows) * CELL_PX;
    const halfSpan = logicalSize(GUIDE_REACH_SPAN_TARGET_PX);
    const dash = logicalSize(GUIDE_DASH_TARGET_PX);
    ctx.setLineDash([dash, dash]);
    ctx.beginPath();
    ctx.moveTo(cx - halfSpan, reachY);
    ctx.lineTo(cx + halfSpan, reachY);
    ctx.stroke();
  }
  ctx.restore();
}

function drawLaunchGuide() {
  if (mode === 'cvc' || !selectedTemplateId) return;
  const tpl = findTemplate(activeTab, selectedTemplateId);
  if (!tpl) return;
  const antY = tpl.antY ?? 0;
  let totalDx;
  let endY;
  if (tpl.entryXAt0 != null) {
    totalDx = tpl.entryXAt0;
    endY = C.SCORE_LINE_Y;
  } else {
    // 妨害テンプレートは entryXAt0 も highway も持たない(敵陣に届かない設計なので
    // ハイウェイ署名を採っていない)。横方向のドリフトが分からない以上、斜線を引くのは
    // 推測になる — 縦線を引いていた元の実装と同じ嘘になるので描かない。
    // 代わりに「分かっていること」だけを描く: 初期の向き(antDir)と、届く深さ(reachRows)。
    drawDisruptGuide(tpl, antY);
    return;
  }
  const segments = launchPathSegments(selectedAntX, antY, totalDx, endY);
  if (segments.length === 0) return;

  ctx.save();
  ctx.strokeStyle = COLOR_AI;
  ctx.fillStyle = COLOR_AI;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = logicalSize(GUIDE_LINE_WIDTH_TARGET_PX);
  const dash = logicalSize(GUIDE_DASH_TARGET_PX);
  ctx.setLineDash([dash, dash]);
  for (const seg of segments) {
    ctx.beginPath();
    ctx.moveTo(seg.x1 * CELL_PX, seg.y1 * CELL_PX);
    ctx.lineTo(seg.x2 * CELL_PX, seg.y2 * CELL_PX);
    ctx.stroke();
  }
  drawLaunchGuideArrow(segments[0]);
  ctx.restore();
}

/**
 * 自爆パネルで選択中の自分のアリを盤面上で強調する。ネオン/グローは使わず、
 * drawLaunchGuide と同じ「方眼紙に馴染む細線+破線」で表現する(DESIGN.md)。
 */
function drawSelfDestructHighlight(view) {
  if (mode === 'cvc' || selectedSelfDestructAntId == null) return;
  const ant = view.myAnts.find((a) => a.id === selectedSelfDestructAntId);
  if (!ant) return;
  const cx = ant.x * CELL_PX + CELL_PX / 2;
  const cy = ant.y * CELL_PX + CELL_PX / 2;
  const ringRadius = logicalSize(SELECT_RING_RADIUS_TARGET_PX);
  const dash = logicalSize(SELECT_RING_RADIUS_TARGET_PX * 0.4);
  ctx.save();
  ctx.strokeStyle = COLOR_AI;
  ctx.globalAlpha = 0.75;
  ctx.lineWidth = logicalSize(SELECT_RING_STROKE_TARGET_PX);
  ctx.setLineDash([dash, dash]);
  ctx.beginPath();
  ctx.arc(cx, cy, ringRadius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// 自爆演出(軌跡フェード + 消えていく輪)
//
// selfDestruct() は同期的に cleanupAnt を呼び、その場で board[q]=0 にしてしまう
// (呼んだ後にはもう消すべき軌跡が残っていない)。したがって、演出用のセル一覧は
// selfDestruct() を呼ぶ**直前**に一度だけ集める(自爆1回につき1回、描画ループには入れない)。
// ---------------------------------------------------------------------------

/** そのアリが最後に触れたセルの索引と、消える直前の状態値を集める(グローバル座標)。 */
function captureSelfDestructCells(m, antId) {
  const cells = [];
  const lastToucher = m.lastToucher;
  const board = m.board;
  for (let i = 0; i < lastToucher.length; i++) {
    if (lastToucher[i] === antId) cells.push({ i, state: board[i] });
  }
  return cells;
}

/** 進行中の自爆演出。{ cells, x, y, slot, startTs } の配列(自分=side1 のアリのみが対象)。 */
let selfDestructEffects = [];

/** 軌跡をアリの slot 色でフェードアウトさせながら重ね描きし、アリが居た位置に
 *  広がって消える輪を1つ描く。塗りつぶさない・光らせない。fillBoardImageData /
 *  drawBoard の**後**に呼ぶこと(前に描くと盤面の描画で上書きされて見えない)。 */
function drawSelfDestructEffects() {
  if (selfDestructEffects.length === 0) return;
  selfDestructEffects = selfDestructEffects.filter((fx) => nowTs - fx.startTs < fx.life);
  for (const fx of selfDestructEffects) {
    const t = Math.min(1, Math.max(0, (nowTs - fx.startTs) / fx.life));
    const decay = 1 - t;
    const rgb = PALETTE_SLOT_RGB[fx.slot];
    ctx.save();
    ctx.fillStyle = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
    for (const cell of fx.cells) {
      const x = cell.i % C.WIDTH;
      const y = Math.floor(cell.i / C.WIDTH);
      ctx.globalAlpha = inkAlphaForState(cell.state) * decay;
      ctx.fillRect(x * CELL_PX, y * CELL_PX, CELL_PX, CELL_PX);
    }
    const ringRadius = logicalSize(SELECT_RING_RADIUS_TARGET_PX) * (0.6 + 0.6 * t);
    ctx.globalAlpha = decay;
    ctx.strokeStyle = COLOR_SUMI;
    ctx.lineWidth = logicalSize(SELECT_RING_STROKE_TARGET_PX);
    ctx.beginPath();
    ctx.arc(fx.x * CELL_PX + CELL_PX / 2, fx.y * CELL_PX + CELL_PX / 2, ringRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

// テンプレート一覧・脅威パネルは状態が変わった時だけ再構築する。
// 毎フレーム(60fps)で innerHTML を作り直すとクリック中の要素が入れ替わってしまい、
// 操作性が悪化する(実際に puppeteer での自動操作でも要素の detach が発生することを確認した)。
let lastTemplateSig = null;
let lastThreatItemsSig = null;
let lastSelfDestructItemsSig = null;

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
  // 選択中のアリが自然消滅(寿命切れ・得点)して側の一覧から消えていたら選択を解除する。
  // これをしないと ID 集合の変化でシグネチャは再構築されるのに selectedSelfDestructAntId
  // だけ古いIDを指し続け、「対象が見つかりません」の理由テキストが張り付いたままになる。
  if (
    selectedSelfDestructAntId != null &&
    !view0.myAnts.some((a) => a.id === selectedSelfDestructAntId)
  ) {
    selectedSelfDestructAntId = null;
  }
  syncSideAntSlots(0, view0.myAnts);
  syncSideAntSlots(1, view0.enemyAnts);
  // drawBoard() が読む scoreLineFlashUntil を、描く前に確定させる(この試合最後の
  // 得点でループが止まっても、最終フレームで強調が出るようにするため updateHud より前で行う)。
  checkScoreFlash();
  drawBoard();
  drawSelfDestructEffects(); // fillBoardImageData/drawBoard の後(前だと上書きされて見えない)
  drawAnts(view0);
  drawSelfDestructHighlight(view0);
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
    const selfDestructSig = selfDestructItemsSignature(view0);
    if (selfDestructSig !== lastSelfDestructItemsSig) {
      lastSelfDestructItemsSig = selfDestructSig;
      renderSelfDestructItems(view0);
    }
    updateSelfDestructProgress(view0); // 経過%は毎フレーム更新(要素の作り直しはしない)
    updateSelfDestructButton();
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
