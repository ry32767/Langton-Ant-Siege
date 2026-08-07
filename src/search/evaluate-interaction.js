// 攻撃 × 妨害 × 発射タイミング の相互作用評価器。
// counterTable / escortTable 生成の土台(共進化ループから呼ばれる想定)。
// DOM に依存しない純粋な ESM。エンジンの挙動は必ず src/engine.js の simulateVersus / instantiateTemplate を
// 経由する(自前でシミュレーションを書き直さない。AGENTS.md「エンジンの参照実装」)。
//
// v5: genome / テンプレートは antX(発射列)を持たない。cells はアリからの相対 [dx,dy,state]。
// 左右がトーラスなので x 方向の平行移動は力学の厳密な対称性であり、攻撃と妨害の相互作用は
// 両者の絶対列ではなく差分 deltaX = (妨害の発射列 − 攻撃の発射列) mod WIDTH だけで決まる
// (config.js「発射列(antX)の可変化」参照)。この評価器は攻撃を常に antX=0 で実体化し、
// 妨害を antX=deltaX で実体化することで、この差分だけを掃引する。
import { simulateVersus, instantiateTemplate } from '../engine.js';
import * as C from '../config.js';

// ---------------------------------------------------------------------------
// genome / template 形の正規化
// ---------------------------------------------------------------------------

/**
 * genome 形({ cells: [{dx,dy,state}] })と template 形({ cells: [[dx,dy,state]] })の
 * どちらが渡されても engine.js の instantiateTemplate が期待する「相対テンプレート」形に揃える。
 * ⚠️ ここでは antX を持たせない(発射列は evaluateInteraction / buildCounterMatrix / buildEscortTable
 * が instantiateTemplate に渡す時点で明示的に決める。attack は常に0、disrupt は deltaX)。
 */
function toEngineTemplate(source, kind) {
  if (!source) return source;
  const rawCells = source.cells ?? [];
  const cells = rawCells.map((c) => {
    if (Array.isArray(c)) return c;
    const dx = c.dx ?? c.x ?? 0;
    const dy = c.dy ?? c.y ?? 0;
    const state = c.state ?? 1;
    return [dx, dy, state];
  });
  return {
    rule: source.rule,
    cells,
    antY: source.antY,
    antDir: source.antDir,
    kind: source.kind ?? kind,
    templateId: source.templateId ?? source.id ?? null,
  };
}

/** attacks/disrupts の配列要素からIDを取り出す。id / templateId が無ければ配列インデックスで代用する。 */
function idOf(obj, index) {
  return obj?.id ?? obj?.templateId ?? index;
}

// ---------------------------------------------------------------------------
// 単発評価
// ---------------------------------------------------------------------------

/**
 * 攻撃(side0)1体と妨害(side1、fireAtStep に発射)1体を simulateVersus で走らせ、
 * 相互作用の結果を返す。攻撃は antX=0、妨害は antX=deltaX で instantiateTemplate する
 * (差分 deltaX だけが結果を左右する。上のモジュール冒頭コメント参照)。
 *
 * ⚠️ engine.js の simulateVersus は現状 { scored, steps, entryY } しか返さない。
 * 以下のフィールドは engine 側の対応が無いと取得できないため null で返す
 * (呼び出し側の報告参照。MVP で必須なのは scored のみ。差分仕様 §18):
 *   - disruptFinalX / disruptFinalY (simulateVersus は妨害アリの最終座標を返さない)
 *   - attackDirectionChanged (妨害あり/なしの2回の軌道比較が要るが、向きの履歴を engine が返さない)
 *   - attackHighwayRecovered / recoveryStep (detectHighway は path が要るが simulateVersus は
 *     trackPath に対応していない)
 */
export function evaluateInteraction(attack, disrupt, fireAtStep, deltaX = 0, options = {}) {
  const attackTpl = instantiateTemplate(toEngineTemplate(attack, 'attack'), 0);
  const opponents = [];
  if (disrupt) {
    const disruptTpl = instantiateTemplate(toEngineTemplate(disrupt, 'disrupt'), deltaX);
    opponents.push({ template: disruptTpl, side: 1, fireAtStep, kind: 'disrupt' });
  }
  const result = simulateVersus(attackTpl, opponents, options);
  return {
    scored: result.scored,
    attackSteps: result.steps,
    attackFinalX: null,
    attackFinalY: result.scored ? result.entryY : null,
    disruptFinalX: null,
    disruptFinalY: null,
    attackDirectionChanged: null,
    attackHighwayRecovered: null,
    recoveryStep: null,
  };
}

/**
 * 攻撃(side0)1体・迎撃妨害(side1)1体・護衛妨害(side0)1体を同じ盤面で走らせる内部ヘルパ。
 * 引数はすでに instantiateTemplate 済みの絶対座標テンプレートを取る(呼び出し側のループで
 * antX=0/deltaX の実体化を先に済ませておくことで、buildEscortTable の総当たりの中で
 * toEngineTemplate 相当の変換を繰り返さないようにする。性能要件)。
 * pending 配列は評価順(迎撃 → 護衛)を守る。simulateVersus は同一ステップの予約発射を
 * 配列順に処理するため、この順序が「護衛が迎撃の書き込みを上書きできるか」を左右する。
 */
function simulateWithEscort(attackTpl, interceptTpl, interceptFireAtStep, escortTpl, escortFireAtStep, options) {
  const opponents = [
    { template: interceptTpl, side: 1, fireAtStep: interceptFireAtStep, kind: 'disrupt' },
    { template: escortTpl, side: 0, fireAtStep: escortFireAtStep, kind: 'disrupt' },
  ];
  return simulateVersus(attackTpl, opponents, options);
}

// ---------------------------------------------------------------------------
// カウンター表
// ---------------------------------------------------------------------------

/**
 * attacks × disrupts × deltaXs × C.FIRE_TIMINGS の全組み合わせを評価する。
 * 「攻撃が得点しなかった時点で残りタイミングを打ち切る」ような枝刈りはしない
 * (各タイミングは独立に評価する。タイミングそのものが効くかどうかを見る評価器のため)。
 *
 * options.deltaXs(数値の配列。既定 [0])で「妨害の発射列 − 攻撃の発射列」を掃引する。
 * options.onProgress({ evaluated, total, attackId, disruptId, deltaX, fireAtStep }) を
 * 1件評価するたびに呼ぶ(共進化の1ラウンドは重いため、進捗を外から観測できるようにする)。
 *
 * 戻り値の matrix[i][j][d][t] は attacks[i] × disrupts[j] × deltaXs[d] × timings[t] の scored。
 */
export function buildCounterMatrix(attacks, disrupts, options = {}) {
  const timings = C.FIRE_TIMINGS;
  const deltaXs = options.deltaXs ?? [0];
  const matrix = [];
  const counterTable = {};
  const counterDensity = [];
  const attacksWithoutCounter = [];
  // disruptId ごとに「1件でも止めたか」を記録する(死に札検出用)。
  const disruptStopped = new Map();

  // toEngineTemplate 相当の変換(genome/template 形の正規化)はループの外で1回だけ行う。
  // instantiateTemplate(antX/deltaX ごとの絶対座標展開)だけをループの中で行う(性能要件)。
  const attackTpls = attacks.map((a) => toEngineTemplate(a, 'attack'));
  const disruptTpls = disrupts.map((d) => toEngineTemplate(d, 'disrupt'));

  const total = attacks.length * disrupts.length * deltaXs.length * timings.length;
  let evaluated = 0;

  for (let i = 0; i < attacks.length; i++) {
    const attackId = idOf(attacks[i], i);
    const attackTpl = instantiateTemplate(attackTpls[i], 0);
    matrix[i] = [];
    let stoppedCountForAttack = 0;
    const entries = [];

    for (let j = 0; j < disrupts.length; j++) {
      const disruptId = idOf(disrupts[j], j);
      if (!disruptStopped.has(disruptId)) disruptStopped.set(disruptId, false);
      matrix[i][j] = [];

      for (let d = 0; d < deltaXs.length; d++) {
        const deltaX = deltaXs[d];
        const disruptTpl = instantiateTemplate(disruptTpls[j], deltaX);
        matrix[i][j][d] = [];

        let stoppedCountForCell = 0;
        const stoppedTimings = [];
        for (let t = 0; t < timings.length; t++) {
          const fireAtStep = timings[t];
          const result = simulateVersus(
            attackTpl,
            [{ template: disruptTpl, side: 1, fireAtStep, kind: 'disrupt' }],
            options,
          );
          const scored = result.scored;
          matrix[i][j][d][t] = scored;
          evaluated++;
          if (typeof options.onProgress === 'function') {
            options.onProgress({ evaluated, total, attackId, disruptId, deltaX, fireAtStep });
          }
          if (!scored) {
            stoppedCountForCell++;
            stoppedCountForAttack++;
            stoppedTimings.push(fireAtStep);
            disruptStopped.set(disruptId, true);
          }
        }
        const successRate = stoppedCountForCell / timings.length;
        for (const fireAtStep of stoppedTimings) {
          entries.push({ disruptId, deltaX, fireAtStep, successRate });
        }
      }
    }

    counterTable[attackId] = entries;
    counterDensity[i] =
      disrupts.length > 0 ? stoppedCountForAttack / (disrupts.length * deltaXs.length * timings.length) : 0;
    if (entries.length === 0) attacksWithoutCounter.push(attackId);
  }

  const disruptsWithoutCoverage = [];
  for (const [disruptId, stopped] of disruptStopped.entries()) {
    if (!stopped) disruptsWithoutCoverage.push(disruptId);
  }

  return { matrix, counterTable, counterDensity, attacksWithoutCounter, disruptsWithoutCoverage };
}

// ---------------------------------------------------------------------------
// 護衛表
// ---------------------------------------------------------------------------

/**
 * counterTable に記録された「攻撃を止めた迎撃(disruptId, deltaX, fireAtStep)」ごとに、
 * 同じ盤面へ side0(攻撃と同じ陣営)から追加で妨害(護衛)を撃って、攻撃を再び
 * 得点させられる組み合わせを探す。escort 候補は disrupts と同じカタログを使う
 * (同じテンプレート集合を、迎撃側/護衛側どちらの役割でも使い回す)。
 * 護衛の発射列も自由度なので options.escortDeltaXs(数値の配列。既定 [0])で掃引する。
 *
 * 見つかった時点でそのタイミングの探索は打ち切る(escortTable は「1つ見つければよい」
 * という探索であって、counterTable の「全タイミング独立評価」とは目的が違うため、
 * ここでの早期終了は誤った枝刈りにはあたらない)。
 *
 * 戻り値: escortTable[attackId][interceptId] =
 *   [{ interceptDeltaX, interceptFireAtStep, escortDisruptId, escortDeltaX, fireAtStep }]
 */
export function buildEscortTable(attacks, disrupts, counterTable, options = {}) {
  const timings = C.FIRE_TIMINGS;
  const escortDeltaXs = options.escortDeltaXs ?? [0];
  const escortTable = {};

  // toEngineTemplate 相当の変換はループの外で1回だけ行う(性能要件)。
  const attackTpls = attacks.map((a) => toEngineTemplate(a, 'attack'));
  const disruptTpls = disrupts.map((d) => toEngineTemplate(d, 'disrupt'));

  for (let i = 0; i < attacks.length; i++) {
    const attackId = idOf(attacks[i], i);
    const attackTpl = instantiateTemplate(attackTpls[i], 0);
    const entries = counterTable[attackId] ?? [];

    // 迎撃 disruptId ごとに、それが攻撃を止めた (deltaX, fireAtStep) 一覧をまとめる。
    const byIntercept = new Map();
    for (const e of entries) {
      if (!byIntercept.has(e.disruptId)) byIntercept.set(e.disruptId, []);
      byIntercept.get(e.disruptId).push({ deltaX: e.deltaX, fireAtStep: e.fireAtStep });
    }

    const perAttack = {};
    for (const [interceptId, interceptCombos] of byIntercept.entries()) {
      const interceptIndex = disrupts.findIndex((d, idx) => idOf(d, idx) === interceptId);
      if (interceptIndex === -1) continue; // counterTable が disrupts と食い違うケース(呼び出し側の不整合)

      const found = [];
      for (const { deltaX: interceptDeltaX, fireAtStep: interceptFireAtStep } of interceptCombos) {
        const interceptTpl = instantiateTemplate(disruptTpls[interceptIndex], interceptDeltaX);
        let escortFound = null;
        for (let j = 0; j < disrupts.length && !escortFound; j++) {
          const escortId = idOf(disrupts[j], j);
          for (let ed = 0; ed < escortDeltaXs.length && !escortFound; ed++) {
            const escortDeltaX = escortDeltaXs[ed];
            const escortTpl = instantiateTemplate(disruptTpls[j], escortDeltaX);
            for (const escortFireAtStep of timings) {
              const result = simulateWithEscort(
                attackTpl,
                interceptTpl,
                interceptFireAtStep,
                escortTpl,
                escortFireAtStep,
                options,
              );
              if (result.scored) {
                escortFound = { escortDisruptId: escortId, escortDeltaX, fireAtStep: escortFireAtStep };
                break;
              }
            }
          }
        }
        if (escortFound) found.push({ interceptDeltaX, interceptFireAtStep, ...escortFound });
      }
      if (found.length > 0) perAttack[interceptId] = found;
    }
    if (Object.keys(perAttack).length > 0) escortTable[attackId] = perAttack;
  }

  return escortTable;
}
