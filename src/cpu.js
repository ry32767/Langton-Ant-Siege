// Action-Centric CPUエージェント。docs/action-centric-contract.md(v6)が唯一の仕様。
//
// ⚠️ 重要な制約(AGENTS.md Do NOT / 契約書 §絶対制約):
// このファイルは `src/engine.js` を import しない。実行時のシミュレーション探索を
// 一切しないことをコード上の依存関係で担保するため。engine 側の操作(発射・予約発射・自爆)は
// options.scheduleFire / options.selfDestruct のコールバックで受け取る。数値定数のみ
// src/config.js から使う。
//
// v6(Action-Centric)での設計の核:
//   旧実装は `tryDefend() ?? tryEscort() ?? tryAttack()` という人間が決めた固定優先順位
//   だった。v6 はこれを廃止し、
//     1. generateActions(view, ctx)  … 合法な具体的 Action を列挙する(戦術判断はしない)
//     2. selectAction(view, actions, ctx) … 24次元の線形評価器 score = Σ weights[i]*features[i]
//        で比較し、最大スコアの Action を選ぶ(同点は候補配列の添字が小さい方)
//   という2段構成に置き換える。「迎撃を優先する」「汚れていない列を選ぶ」といった戦術は
//   generateActions に書かない。良し悪しは24特徴が表現し、重みが学習する。
import * as C from './config.js';
import { instantiateTemplate, wrapX, scoringLaunchColumns, launchColumnScores } from './template.js';

// ⚠️ コスト式のローカル複製をやめ、src/config.js の costOf(唯一の定義)を使う(v5.5から継続)。
const costOf = C.costOf;

function buildTemplateIndex(list) {
  const byId = new Map();
  for (const t of list ?? []) byId.set(t.id, t);
  return byId;
}

/**
 * テンプレートから engine.fire() が受け取る action を組み立てる。
 * 相対 cells → 絶対 cells への変換は src/template.js の instantiateTemplate に委譲する
 * (antX を選ぶのはここ・変換自体は共有ロジック)。
 */
function toEngineAction(kind, template, antX) {
  const action = instantiateTemplate(template, antX);
  return { ...action, kind };
}

/**
 * FIRE Action を組み立てる(契約 §2)。`template` を持たせておくと encodeFeatures が
 * 特徴5〜7(arrivalStep / scoreReachability / robustness)を Map 参照無しで直接読める
 * (契約書に無い実装上の最適化。§末尾「自分で決めたこと」に記載)。
 */
function makeFireAction(kind, template, launchX, atStep, source) {
  const cost = costOf(kind, template.cells.length);
  return {
    type: 'FIRE',
    kind,
    templateId: template.id,
    launchX,
    atStep,
    cost,
    source, // 'generic' | 'counter' | 'escort'。選択規則に使ってはならない(DEFEND_HEAVY を除く。ログ専用)
    engineAction: toEngineAction(kind, template, launchX),
    template,
  };
}

// ---------------------------------------------------------------------------
// 汎用の数値ヘルパ(すべて決定論・乱数不使用)
// ---------------------------------------------------------------------------

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

/** トーラス距離(0..size/2)。 */
function toroidalDistance(a, b, size) {
  const raw = Math.abs(a - b) % size;
  return Math.min(raw, size - raw);
}

/**
 * `atStep` の時点で使えると見込めるトークン(契約 §7 の記述を維持)。
 * トークンは TOKEN_TICK_STEPS ごとに TOKEN_PER_TICK ずつ増えて TOKEN_CAP で頭打ちになるので、
 * 発火時点の残高は現在より多いことがある。`committed` は「予約済みでまだ発火していない発射」の
 * コスト合計(commitments 由来)。
 */
function projectedTokensAt(view, atStep, committed) {
  const ticks = Math.max(
    0,
    Math.floor(atStep / C.TOKEN_TICK_STEPS) - Math.floor(view.step / C.TOKEN_TICK_STEPS),
  );
  const projected = Math.min(C.TOKEN_CAP, view.tokens + ticks * C.TOKEN_PER_TICK);
  return projected - committed;
}

// ---------------------------------------------------------------------------
// generateActions(view, ctx) — 合法性と候補圧縮だけ(契約 §3)
//
// ⚠️ 戦術優先順位を一切埋め込まない。「敵が来たから妨害を優先する」
// 「汚れていない列を選ぶ」といった判断はここに書かない。
//
// ctx は decide() が1判断につき1回だけ組み立てて generateActions → selectAction →
// encodeFeatures の3つに使い回す(契約 §5.2 の性能要件)。ctx の形は下の
// `buildDecisionContext` を参照。単体テストでは同じ形のプレーンオブジェクトを直接
// 組み立てて渡せる。
// ---------------------------------------------------------------------------

/**
 * counterTable 由来の候補(契約 §9)。`view.enemyAnts` の攻撃アリを
 * identifyTable["spawnY,spawnDir"] で特定し、counterTable[attackId] を走査する。
 * 列挙順は successRate 降順 → fireAtStep 昇順 → deltaX 昇順(候補数制御のための
 * 決定論的な順序であって選好ではない。successRate 自体は特徴に入れない)。
 */
function generateCounterCandidates(view, ctx) {
  const raw = [];
  for (const enemyAnt of view.enemyAnts ?? []) {
    if (enemyAnt.kind !== 'attack') continue;
    const attackId = ctx.identifyTable[`${enemyAnt.spawnY},${enemyAnt.spawnDir}`];
    if (!attackId) continue;
    const candList = ctx.counterTable[attackId];
    if (!candList) continue;
    for (const cand of candList) {
      const tpl = ctx.disruptById.get(cand.disruptId);
      if (!tpl) continue;
      const absStep = enemyAnt.firedAtStep + cand.fireAtStep;
      if (absStep < view.step) continue; // 既に過ぎている
      const cost = costOf('disrupt', tpl.cells.length);
      if (cost > projectedTokensAt(view, absStep, ctx.committed)) continue;
      const launchX = wrapX(enemyAnt.spawnX + cand.deltaX);
      raw.push({ successRate: cand.successRate ?? 1, fireAtStep: cand.fireAtStep, deltaX: cand.deltaX, tpl, absStep, launchX });
    }
  }
  raw.sort((a, b) => (b.successRate - a.successRate) || (a.fireAtStep - b.fireAtStep) || (a.deltaX - b.deltaX));
  return raw
    .slice(0, C.ACTION_COUNTER_MAX)
    .map((r) => makeFireAction('disrupt', r.tpl, r.launchX, r.absStep, 'counter'));
}

/**
 * escortTable 由来の候補(契約 §9)。`view.myAnts` の攻撃アリごとに
 * counterTable[myAnt.templateId] の各 disruptId について escortTable[...][disruptId] を走査する。
 * 敵の迎撃を実際に観測する必要はない(先回りの予測)。列挙順は counter 候補と同じ規則
 * (対応する counterCand の successRate 降順 → fireAtStep 昇順 → escortDeltaX 昇順)。
 */
function generateEscortCandidates(view, ctx) {
  const raw = [];
  for (const myAnt of view.myAnts ?? []) {
    if (myAnt.kind !== 'attack' || !myAnt.templateId) continue;
    const counterCandidates = ctx.counterTable[myAnt.templateId];
    if (!counterCandidates) continue;
    for (const counterCand of counterCandidates) {
      const disruptId = counterCand.disruptId;
      const escortList = ctx.escortTable[myAnt.templateId]?.[disruptId];
      if (!escortList) continue;
      for (const cand of escortList) {
        const tpl = ctx.disruptById.get(cand.escortDisruptId);
        if (!tpl) continue;
        const absStep = myAnt.firedAtStep + cand.fireAtStep;
        if (absStep < view.step) continue;
        const cost = costOf('disrupt', tpl.cells.length);
        if (cost > projectedTokensAt(view, absStep, ctx.committed)) continue;
        const launchX = wrapX(myAnt.spawnX + cand.escortDeltaX);
        raw.push({
          successRate: counterCand.successRate ?? 1,
          fireAtStep: cand.fireAtStep,
          deltaX: cand.escortDeltaX,
          tpl,
          absStep,
          launchX,
        });
      }
    }
  }
  raw.sort((a, b) => (b.successRate - a.successRate) || (a.fireAtStep - b.fireAtStep) || (a.deltaX - b.deltaX));
  return raw
    .slice(0, C.ACTION_ESCORT_MAX)
    .map((r) => makeFireAction('disrupt', r.tpl, r.launchX, r.absStep, 'escort'));
}

/** (type, templateId, launchX, atStep) / (type, antId) が同一の候補を1件に畳む(契約 §3-7)。 */
function dedupeActions(actions) {
  const seen = new Set();
  const out = [];
  for (const a of actions) {
    let key;
    if (a.type === 'FIRE') key = `F|${a.templateId}|${a.launchX}|${a.atStep}`;
    else if (a.type === 'SELF_DESTRUCT') key = `S|${a.antId}`;
    else key = 'WAIT';
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

/**
 * 合法な具体的 Action を列挙する(契約 §3)。単体テストからも直接呼べるよう export する。
 *
 * ⚠️ 列挙順は WAIT → counter → escort → generic攻撃 → generic妨害 → SELF_DESTRUCT。
 * counter/escort を generic より先に置くのは、たまたま同じ (templateId, launchX, atStep) を
 * 汎用サンプルが引いた場合に dedupe で 'counter'/'escort' という由来(DEFEND_HEAVY が読む
 * source フィールド。契約 §6 の唯一の許可された使用箇所)を失わせないため。
 */
export function generateActions(view, ctx) {
  const actions = [{ type: 'WAIT' }];
  const rng = ctx.rng;

  if (view.flyingCount < C.MAX_FLYING) {
    for (const a of generateCounterCandidates(view, ctx)) actions.push(a);
    for (const a of generateEscortCandidates(view, ctx)) actions.push(a);

    // generic FIRE(攻撃): 得点ゲート内から ACTION_ATTACK_GATE_SAMPLES 列、
    // ゲート外から ACTION_ATTACK_OFFGATE_SAMPLES 列を rng.int() で一様にサンプルする。
    // ⚠️ 旧 chooseAttackColumn の「いちばん綺麗な列を選ぶ」ヒューリスティクスは移植しない
    // (契約 §41)。列の良し悪しは特徴8〜15が表現し、重みが学習する。
    // ⚠️ rng は候補ごとに常に消費する(コストで弾いた場合も列は引く)。CRN で方策間の
    // 乱数消費量がずれないようにするため(旧 trySelfDestruct の教訓と同じ規律)。
    for (const tpl of ctx.attackTemplates) {
      const cost = costOf('attack', tpl.cells.length);
      const gate = scoringLaunchColumns(tpl);
      for (let i = 0; i < C.ACTION_ATTACK_GATE_SAMPLES; i++) {
        if (gate.count <= 0) continue;
        const launchX = wrapX(gate.min + rng.int(gate.count));
        if (cost <= ctx.avail) actions.push(makeFireAction('attack', tpl, launchX, view.step, 'generic'));
      }
      for (let i = 0; i < C.ACTION_ATTACK_OFFGATE_SAMPLES; i++) {
        const offCount = C.WIDTH - gate.count;
        const launchX = offCount > 0 ? wrapX(gate.min + gate.count + rng.int(offCount)) : rng.int(C.WIDTH);
        if (cost <= ctx.avail) actions.push(makeFireAction('attack', tpl, launchX, view.step, 'generic'));
      }
    }

    // generic FIRE(妨害): 全256列から ACTION_DISRUPT_SAMPLES 列を一様サンプルする。
    for (const tpl of ctx.disruptTemplates) {
      const cost = costOf('disrupt', tpl.cells.length);
      for (let i = 0; i < C.ACTION_DISRUPT_SAMPLES; i++) {
        const launchX = rng.int(C.WIDTH);
        if (cost <= ctx.avail) actions.push(makeFireAction('disrupt', tpl, launchX, view.step, 'generic'));
      }
    }
  }

  // SELF_DESTRUCT: 飛行中の自軍アリすべてが候補(事前フィルタ禁止・契約 §6)。
  for (const ant of view.myAnts ?? []) {
    actions.push({ type: 'SELF_DESTRUCT', antId: ant.id, slot: ant.slot, ant });
  }

  return dedupeActions(actions);
}

// ---------------------------------------------------------------------------
// 24次元 Feature Encoder(凍結。契約 §5)
// ---------------------------------------------------------------------------

export const FEATURE_NAMES = [
  'isAttackFire', // 0
  'isDisruptFire', // 1
  'isSelfDestruct', // 2
  'tokenAfter', // 3
  'flyingAfter', // 4
  'effectDelay', // 5
  'scoreReachability', // 6
  'robustness', // 7
  'boardOccupancyBand0', // 8
  'boardOwnershipBand0', // 9
  'boardOccupancyBand1', // 10
  'boardOwnershipBand1', // 11
  'boardOccupancyBand2', // 12
  'boardOwnershipBand2', // 13
  'boardOccupancyBand3', // 14
  'boardOwnershipBand3', // 15
  'enemyNearAnchor', // 16
  'enemyForwardPresence', // 17
  'allyNearAnchor', // 18
  'allyForwardPresence', // 19
  'destructAge', // 20
  'ownedTrailAmount', // 21
  'ownedTrailCentroidY', // 22
  'ownedTrailSpread', // 23
];

/**
 * 32×32の coarse 占有・所有を CPUローカル band(4分割)へ集約する(契約 §5.2)。
 * 1判断につき1回だけ作り、ctx.bandArrays にキャッシュして使い回す。
 * `view.coarseNonWhite` / `coarseOwnedMine` / `coarseOwnedEnemy` が欠けている場合
 * (engine 側の対応が未完成なテスト・移行期)は全て0として扱う(NaN を作らない)。
 */
function ensureBandArrays(view, ctx) {
  if (ctx.bandArrays) return ctx.bandArrays;
  const size = C.COARSE_SIZE;
  const bands = C.COARSE_BAND_COUNT;
  const colOcc = Array.from({ length: bands }, () => new Float64Array(size));
  const colOwn = Array.from({ length: bands }, () => new Float64Array(size));
  const nonWhite = view.coarseNonWhite;
  const mine = view.coarseOwnedMine;
  const enemy = view.coarseOwnedEnemy;
  if (nonWhite && mine && enemy) {
    for (let cyGlobal = 0; cyGlobal < size; cyGlobal++) {
      const cyLocal = C.coarseLocalRow(view.sideIndex, cyGlobal);
      const band = Math.min(bands - 1, Math.floor(cyLocal / C.COARSE_ROWS_PER_BAND));
      const rowBase = cyGlobal * size;
      for (let cx = 0; cx < size; cx++) {
        const b = rowBase + cx;
        colOcc[band][cx] += nonWhite[b];
        colOwn[band][cx] += enemy[b] - mine[b];
      }
    }
  }
  const norm = C.COARSE_ROWS_PER_BAND * C.COARSE_CELLS_PER_BLOCK; // 8*64
  for (let band = 0; band < bands; band++) {
    for (let cx = 0; cx < size; cx++) {
      colOcc[band][cx] /= norm;
      colOwn[band][cx] /= norm;
    }
  }
  ctx.bandArrays = { colOcc, colOwn };
  return ctx.bandArrays;
}

/** anchor の coarse 列ごとの8特徴(#8〜15)。32エントリの Map に memo 化する(契約 §5.2)。 */
function getBandFeatures(view, ctx, anchorCx) {
  if (ctx.bandCache.has(anchorCx)) return ctx.bandCache.get(anchorCx);
  const { colOcc, colOwn } = ensureBandArrays(view, ctx);
  const feats = new Float64Array(8);
  const halfSize = C.COARSE_SIZE / 2; // ΣKx = 16
  for (let band = 0; band < C.COARSE_BAND_COUNT; band++) {
    let occSum = 0;
    let ownSum = 0;
    for (let cx = 0; cx < C.COARSE_SIZE; cx++) {
      const d = toroidalDistance(cx, anchorCx, C.COARSE_SIZE);
      const kx = 1 - d / halfSize;
      occSum += kx * colOcc[band][cx];
      ownSum += kx * colOwn[band][cx];
    }
    feats[band * 2] = clamp(occSum / halfSize, 0, 1);
    feats[band * 2 + 1] = clamp(ownSum / halfSize, -1, 1);
  }
  ctx.bandCache.set(anchorCx, feats);
  return feats;
}

/** アリとアンカーの近さ(契約 §5.3)。dist を [0,1] に正規化してから 1-dist を返す。 */
function proximity(ax, ay, anchorX, anchorYLocal) {
  const dxNorm = toroidalDistance(ax, anchorX, C.WIDTH) / (C.WIDTH / 2);
  const dyNorm = Math.abs(ay - anchorYLocal) / (C.HEIGHT - 1);
  const dist = Math.hypot(dxNorm, dyNorm) / Math.SQRT2;
  return 1 - dist;
}

/** 特徴16〜19(契約 §5.3)。敵/味方の attack・disrupt は区別しない。 */
function computeAntRelationFeatures(view, anchorX, anchorYLocal, excludeAllyAntId) {
  let enemyNear = 0;
  let enemyForward = 0;
  for (const ant of view.enemyAnts ?? []) {
    const prox = proximity(ant.x, ant.y, anchorX, anchorYLocal);
    if (prox > enemyNear) enemyNear = prox;
    if (ant.y > anchorYLocal) enemyForward += prox;
  }
  let allyNear = 0;
  let allyForward = 0;
  for (const ant of view.myAnts ?? []) {
    if (excludeAllyAntId != null && ant.id === excludeAllyAntId) continue;
    const prox = proximity(ant.x, ant.y, anchorX, anchorYLocal);
    if (prox > allyNear) allyNear = prox;
    if (ant.y > anchorYLocal) allyForward += prox;
  }
  return {
    enemyNearAnchor: enemyNear,
    enemyForwardPresence: clamp(enemyForward / C.MAX_FLYING, 0, 1),
    allyNearAnchor: allyNear,
    allyForwardPresence: clamp(allyForward / C.MAX_FLYING, 0, 1),
  };
}

/** 特徴21〜23(契約 §5.4)。coarseAntOwned[slot] だけから求める。全盤面走査は禁止。 */
function computeTrailFromCoarse(view, m) {
  const size = C.COARSE_SIZE;
  const block = C.COARSE_BLOCK;
  const centerOffset = (block - 1) / 2; // ブロック中心のオフセット(block=8なら3.5)
  const twoPiOverWidth = (2 * Math.PI) / C.WIDTH;
  let owned = 0;
  let sumCyLocal = 0;
  let sumSin = 0;
  let sumCos = 0;
  for (let b = 0; b < m.length; b++) {
    const w = m[b];
    if (w === 0) continue;
    owned += w;
    const cyGlobal = Math.floor(b / size);
    const cx = (b % size) * block + centerOffset;
    const cyLocal = C.coarseLocalRow(view.sideIndex, cyGlobal) * block + centerOffset;
    sumCyLocal += w * cyLocal;
    const theta = cx * twoPiOverWidth;
    sumSin += w * Math.sin(theta);
    sumCos += w * Math.cos(theta);
  }
  if (owned <= 0) return { amount: 0, centroidY: 0, spread: 0 };

  const amount = owned / C.CELL_COUNT;
  const centroidYLocal = sumCyLocal / owned;
  const centroidY = clamp(centroidYLocal / (C.HEIGHT - 1), 0, 1);
  const meanTheta = Math.atan2(sumSin, sumCos);
  const xBar = wrapX(meanTheta / twoPiOverWidth);

  let varX = 0;
  let varY = 0;
  for (let b = 0; b < m.length; b++) {
    const w = m[b];
    if (w === 0) continue;
    const cyGlobal = Math.floor(b / size);
    const cx = (b % size) * block + centerOffset;
    const cyLocal = C.coarseLocalRow(view.sideIndex, cyGlobal) * block + centerOffset;
    const dTor = toroidalDistance(cx, xBar, C.WIDTH);
    varX += w * dTor * dTor;
    varY += w * (cyLocal - centroidYLocal) * (cyLocal - centroidYLocal);
  }
  varX /= owned;
  varY /= owned;
  const spread = clamp(Math.sqrt(varX + varY) / C.OWNED_SPREAD_SCALE, 0, 1);
  return { amount, centroidY, spread };
}

/** スロットごとに1判断1回計算してキャッシュする(契約 §5.4)。 */
function getOwnedTrailFeatures(view, ctx, slot) {
  if (slot == null) return { amount: 0, centroidY: 0, spread: 0 };
  if (ctx.trailCache.has(slot)) return ctx.trailCache.get(slot);
  const m = view.coarseAntOwned?.[slot];
  const result = m ? computeTrailFromCoarse(view, m) : { amount: 0, centroidY: 0, spread: 0 };
  ctx.trailCache.set(slot, result);
  return result;
}

/**
 * `encodeFeatures(view, action, ctx) -> Float64Array(24)`(契約 §5)。完全決定論・乱数不使用。
 * WAIT には呼ばない(呼ばれた場合は防御的に全0を返す)。
 *
 * `ctx` は最低限 `{ avail, committed, bandArrays, bandCache, trailCache }` を持つプレーン
 * オブジェクトであればよい(decide() が組み立てる ctx と同じ形。単体テストは
 * `bandArrays: null, bandCache: new Map(), trailCache: new Map()` を渡せば独立に呼べる)。
 * `out` を渡すとバッファを使い回せる(渡さなければ新しい Float64Array を確保する)。
 */
export function encodeFeatures(view, action, ctx, out = new Float64Array(C.ACTION_FEATURE_COUNT)) {
  out.fill(0);
  if (!action || action.type === 'WAIT') return out;

  const isAttack = action.type === 'FIRE' && action.kind === 'attack';
  const isDisrupt = action.type === 'FIRE' && action.kind === 'disrupt';
  const isSelfDestruct = action.type === 'SELF_DESTRUCT';
  out[0] = isAttack ? 1 : 0;
  out[1] = isDisrupt ? 1 : 0;
  out[2] = isSelfDestruct ? 1 : 0;

  // anchor(契約 §5.1)
  let anchorX;
  let anchorYLocal;
  if (action.type === 'FIRE') {
    anchorX = action.launchX;
    anchorYLocal = action.template?.antY ?? action.engineAction?.antY ?? 0;
  } else {
    anchorX = action.ant.x;
    anchorYLocal = action.ant.y;
  }

  // #3 tokenAfter
  const committed = ctx.committed ?? 0;
  const tokensAfter =
    action.type === 'FIRE'
      ? projectedTokensAt(view, action.atStep, committed) - action.cost
      : (ctx.avail ?? 0) - C.SELF_DESTRUCT_COST;
  out[3] = clamp(tokensAfter / C.TOKEN_CAP, 0, 1);

  // #4 flyingAfter
  const flyingAfter = isSelfDestruct ? view.flyingCount - 1 : view.flyingCount + 1;
  out[4] = clamp(flyingAfter / C.MAX_FLYING, 0, 1);

  // #5 effectDelay
  if (isSelfDestruct) {
    out[5] = 0;
  } else {
    const travel = isAttack ? action.template?.arrivalStep ?? 0 : 0;
    const delaySteps = action.atStep - view.step + travel;
    out[5] = clamp(delaySteps / Math.max(C.TOTAL_STEPS - view.step, 1), 0, 1);
  }

  // #6 scoreReachability / #7 robustness(攻撃 FIRE のみ)
  if (isAttack && action.template) {
    out[6] = launchColumnScores(action.template, action.launchX) ? 1 : 0;
    out[7] = clamp(action.template.robustness ?? 0, 0, 1);
  }

  // #8〜15 盤面band(全 Action 共通)。契約 §0 の `x >> COARSE_SHIFT` の定義どおりに求める。
  const anchorCx = (((anchorX % C.WIDTH) + C.WIDTH) % C.WIDTH) >> C.COARSE_SHIFT;
  const bandFeats = getBandFeatures(view, ctx, anchorCx);
  for (let i = 0; i < 8; i++) out[8 + i] = bandFeats[i];

  // #16〜19 アリ空間関係(全 Action 共通)
  const rel = computeAntRelationFeatures(view, anchorX, anchorYLocal, isSelfDestruct ? action.antId : null);
  out[16] = rel.enemyNearAnchor;
  out[17] = rel.enemyForwardPresence;
  out[18] = rel.allyNearAnchor;
  out[19] = rel.allyForwardPresence;

  // #20〜23 所有軌跡(SELF_DESTRUCT のみ)
  if (isSelfDestruct) {
    const life = action.ant.life > 0 ? action.ant.life : 1;
    out[20] = clamp(action.ant.steps / life, 0, 1);
    const trail = getOwnedTrailFeatures(view, ctx, action.slot);
    out[21] = trail.amount;
    out[22] = trail.centroidY;
    out[23] = trail.spread;
  }

  return out;
}

/**
 * 高分解能時計。ブラウザと Node の両方が持つ `performance.now()` だけを使う
 * (`src/cpu.js` は engine も DOM も Node の API も import しない純粋 ESM なので、
 * `process.hrtime` は使えない)。使えない環境では 0 を返し、計測値は「未計測」になる。
 */
const nowMs = () => globalThis.performance?.now?.() ?? 0;

function dotWeights(weights, features) {
  let sum = 0;
  for (let i = 0; i < features.length; i++) sum += (weights[i] ?? 0) * features[i];
  return sum;
}

/**
 * `selectAction(view, actions, ctx)`(契約 §4)。score(WAIT)=0 固定、最大スコアを選ぶ。
 * 同点は候補配列の添字が小さい方(strict `>` で更新するため自然にそうなる)。
 * `ctx.scoreAction` があればそれを使う(Reference League 用)。無ければ
 * `ctx.weights` との内積(CEM の方策)。
 */
export function selectAction(view, actions, ctx) {
  // ⚠️ 1判断ごとに新しい Float64Array を大量に確保しない(契約 §5.2 の性能要件)。
  // ctx.featureBuffer があれば使い回す(decide() が1判断につき1個だけ用意する)。
  // 無ければ encodeFeatures の既定(呼び出しごとに新規確保)にフォールバックする
  // (単体テストなど ctx.featureBuffer を持たない呼び出しでも壊れないようにするため)。
  // ⚠️ 計測は `ctx.measure` が真のときだけ行う(差分仕様 §28 のベンチ専用)。
  // 既定は false なので、学習のホットパスに計測コストは一切入らない。
  const scoreOf =
    ctx.scoreAction ??
    (ctx.measure
      ? (action, v, c) => {
          const t0 = nowMs();
          const f = encodeFeatures(v, action, c, c.featureBuffer);
          const t1 = nowMs();
          const s = dotWeights(c.weights ?? [], f);
          c.measure.featureMs += t1 - t0;
          c.measure.scoreMs += nowMs() - t1;
          return s;
        }
      : (action, v, c) => dotWeights(c.weights ?? [], encodeFeatures(v, action, c, c.featureBuffer)));
  let best = actions.find((a) => a.type === 'WAIT') ?? { type: 'WAIT' };
  let bestScore = 0;
  for (const action of actions) {
    if (action.type === 'WAIT') continue;
    const score = scoreOf(action, view, ctx);
    if (score > bestScore) {
      bestScore = score;
      best = action;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// createCpuAgent
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {object} options.templates data/templates.json をパースしたもの
 *   ({ attack, disrupt, identifyTable, counterTable, escortTable, ... })
 * @param {number[]} [options.weights] 24要素の配列(CEM の方策)。scoreAction を渡す場合は省略可
 * @param {(action:object, view:object, ctx:object)=>number} [options.scoreAction]
 *   省略可。Reference League 用のスコア関数の差し替え(src/reference-policies.js 参照)
 * @param {object} options.rng engine.createRng() が返す形({ next, int, pick })
 * @param {(action: object, atStep: number) => void} [options.scheduleFire] 予約発射のコールバック
 * @param {(antId: number) => void} [options.selfDestruct] 自陣の飛行中アリを消すコールバック
 * @param {(event: object) => void} [options.observe] 計測用の観測コールバック(既定は何もしない)。
 *   1判断1回、`{type:'action', actionType, kind, templateId, launchX, atStep, candidateCount}` を出す。
 *   ⚠️ 副作用も乱数消費も持たない(既定が no-op なので渡さなければ再現性は完全に同じ)。
 */
export function createCpuAgent(options) {
  const templates = options.templates ?? {};
  const rng = options.rng;
  const scheduleFire = options.scheduleFire ?? (() => {});
  const selfDestructFn = options.selfDestruct ?? (() => {});
  const observe = options.observe ?? (() => {});
  const scoreAction = options.scoreAction ?? null;
  const weights = options.weights ?? new Array(C.ACTION_FEATURE_COUNT).fill(0);
  // §28 のベンチだけが true にする。特徴生成と採点の所要時間を observe へ載せる。
  const measureEnabled = options.measure === true;

  const attackTemplates = templates.attack ?? [];
  const disruptTemplates = templates.disrupt ?? [];
  const disruptById = buildTemplateIndex(disruptTemplates);
  const identifyTable = templates.identifyTable ?? {};
  const counterTable = templates.counterTable ?? {};
  const escortTable = templates.escortTable ?? {};

  // ---------------------------------------------------------------------
  // 予約発射のトークン確保(v5.2 由来。旧実装から維持する資産・契約 §15)。
  //
  // engine の scheduleFire は「予約リストに積む」だけで、実際の発射は予約した
  // ステップに fire() → canFire() を通る。トークンが足りなくなると予約は黙って消える。
  // ここで「予約済みだがまだ発火していない発射」のコストを自前で持ち、以降の
  // 判断で使えるトークンから差し引くことで予約を守る。
  // ---------------------------------------------------------------------
  let commitments = []; // { atStep, cost }
  // 特徴バッファの使い回し(契約 §5.2)。1判断の中で候補ごとに Float64Array(24) を
  // 新規確保しないよう、エージェントの寿命で1本だけ持つ。中身は selectAction が
  // encodeFeatures を呼ぶたびに上書きされ、内積計算(dotWeights)がその場で消費して
  // 終わるので、次の候補計算までに読み残されることはない。
  const featureBuffer = new Float64Array(C.ACTION_FEATURE_COUNT);

  function releaseExpiredCommitments(step) {
    if (commitments.length === 0) return;
    commitments = commitments.filter((c) => c.atStep > step);
  }

  function committedTokens() {
    let sum = 0;
    for (const c of commitments) sum += c.cost;
    return sum;
  }

  return {
    decide(view) {
      releaseExpiredCommitments(view.step);
      const committed = committedTokens();
      const avail = Math.max(0, view.tokens - committed);

      // ctx は1判断につき1回だけ組み立て、generateActions → selectAction → encodeFeatures で
      // 使い回す(契約 §5.2 の性能要件)。
      const ctx = {
        attackTemplates,
        disruptTemplates,
        disruptById,
        identifyTable,
        counterTable,
        escortTable,
        rng,
        avail,
        committed,
        weights,
        scoreAction,
        featureBuffer,
        bandArrays: null,
        bandCache: new Map(),
        trailCache: new Map(),
        measure: measureEnabled ? { featureMs: 0, scoreMs: 0 } : null,
      };

      const actions = generateActions(view, ctx);
      const chosen = selectAction(view, actions, ctx);
      const candidateCount = actions.length;
      // 計測が有効なときだけ observe に載せる追加フィールド(µs 単位)。
      const timing = ctx.measure
        ? { featureUs: ctx.measure.featureMs * 1000, scoreUs: ctx.measure.scoreMs * 1000 }
        : null;

      if (chosen.type === 'WAIT') {
        observe({
          type: 'action',
          actionType: 'WAIT',
          kind: null,
          templateId: null,
          launchX: null,
          atStep: view.step,
          candidateCount,
          ...(timing ?? {}),
        });
        return null;
      }

      if (chosen.type === 'FIRE') {
        observe({
          type: 'action',
          actionType: 'FIRE',
          kind: chosen.kind,
          templateId: chosen.templateId,
          launchX: chosen.launchX,
          atStep: chosen.atStep,
          candidateCount,
          ...(timing ?? {}),
        });
        if (chosen.atStep > view.step) {
          // 予約発射。⚠️ stepMatch は「予約発射の消化」→「新しい判断」の順で処理するため、
          // atStep === view.step で scheduleFire するとそのステップではもう消化が終わった後で
          // 永遠に発火しないゾンビ予約になる(旧 pickFutureTiming のコメント参照)。
          // 上の `atStep > view.step` 判定がこれを避ける。
          commitments.push({ atStep: chosen.atStep, cost: chosen.cost });
          scheduleFire(chosen.engineAction, chosen.atStep);
          return null;
        }
        commitments.push({ atStep: view.step, cost: chosen.cost });
        return chosen.engineAction;
      }

      if (chosen.type === 'SELF_DESTRUCT') {
        observe({
          type: 'action',
          actionType: 'SELF_DESTRUCT',
          kind: null,
          templateId: null,
          launchX: null,
          atStep: view.step,
          candidateCount,
          ...(timing ?? {}),
        });
        selfDestructFn(chosen.antId);
        return null;
      }

      return null;
    },
    reset() {
      commitments = [];
    },
  };
}
