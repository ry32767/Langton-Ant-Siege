// CPU 対戦の実行を1か所に集約した共有モジュール(v6)。
//
// train-policy.mjs(学習)・evaluate-policy.mjs(評価/ベンチ)・match-worker.mjs(並列ワーカー)が
// **すべてこの実装を通る**。対戦の組み方(先後の入れ替え・シードの導出・エージェントの配線)が
// 学習と評価でズレると「学習では強かったのに評価では弱い」という原因不明の乖離になるため、
// 複製を作らないこと。
//
// ⚠️ このモジュールは乱数の**種**を受け取るだけで、自分で種を決めない。
// 種の決定はメインスレッド(呼び出し側)の責任。worker_threads で並列化しても結果が
// 変わらないための大原則(scripts/lib/worker-pool.mjs 冒頭のコメント参照)。

import {
  createRng,
  createMatch,
  runMatch,
  scheduleFire as engineScheduleFire,
  selfDestruct as engineSelfDestruct,
} from '../../src/engine.js';
import { createCpuAgent } from '../../src/cpu.js';
import { createCpuAgent as createLegacyCpuAgent } from '../../src/cpu-legacy.js';
import { createReferenceScorer } from '../../src/reference-policies.js';

/**
 * 複数の整数から決定論的な32bit非ゼロシードを作る(FNV-1a 風)。
 * ⚠️ 旧 train-policy.mjs / verify-v54.mjs が各自で複製していた実装をここへ一本化した。
 */
export function deriveSeed(...parts) {
  let h = 0x811c9dc5 >>> 0;
  for (const p of parts) {
    h ^= p >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h === 0 ? 1 : h >>> 0;
}

/**
 * 方策の指定(spec)は次の3種類。JSON で worker へ送れる素のオブジェクトに限る。
 *   { kind: 'cem',       weights: number[24] }   … 学習中/学習済みの Action 評価器
 *   { kind: 'reference', name: 'ATTACK_ONLY' }   … 固定 Reference League(§19)
 *   { kind: 'legacy',    policy: {...} }         … 凍結した v5.5 の旧CPU(§26.2 の対戦相手)
 */
export function makeAgent(templates, spec, getMatch, sideIndex, rngSeed, observe, measure = false) {
  const rng = createRng(rngSeed);
  const scheduleFire = (action, atStep) =>
    engineScheduleFire(getMatch(), sideIndex, action, atStep);
  const selfDestruct = (antId) => engineSelfDestruct(getMatch(), sideIndex, antId);

  if (spec.kind === 'legacy') {
    // 旧CPUは旧スキーマ(policy オブジェクト)を受け取る。新旧を取り違えないよう
    // 引数名そのものが違う(新は weights / 旧は policy)。
    return createLegacyCpuAgent({ templates, policy: spec.policy, rng, scheduleFire, selfDestruct });
  }
  // measure:true のときだけ cpu.js が特徴生成・採点の所要時間を計測して observe へ載せる
  // (§28 のベンチ専用。既定 false なので学習のホットパスに計測コストは入らない)。
  const wiring = { templates, rng, scheduleFire, selfDestruct, observe, measure };
  if (spec.kind === 'reference') {
    return createCpuAgent({ ...wiring, scoreAction: createReferenceScorer(spec.name) });
  }
  if (spec.kind === 'cem') {
    return createCpuAgent({ ...wiring, weights: spec.weights });
  }
  throw new Error(`未知の方策 spec: ${JSON.stringify(spec)}`);
}

/** specA(side1) vs specB(side2) を1試合。observeA/observeB は戦術ログ用(既定 no-op)。 */
export function playMatch(templates, seed, specA, specB, options = {}) {
  const match = createMatch({ seed });
  match.sides[0].agent = makeAgent(
    templates, specA, () => match, 0, deriveSeed(seed, 1), options.observeA, options.measure,
  );
  match.sides[1].agent = makeAgent(
    templates, specB, () => match, 1, deriveSeed(seed, 2), options.observeB, options.measure,
  );
  runMatch(match);
  return {
    result: match.result,
    scores: [match.sides[0].score, match.sides[1].score],
    steps: match.step,
  };
}

/**
 * 引き分けだけだと fitness の分散が消えて CEM が学習できなくなるので、得点差も薄く混ぜる。
 * 重み 0.01 は勝率(0〜1)のオーダーを崩さない程度の小ささ(v5 から据え置き)。
 */
export const SCORE_DIFF_WEIGHT = 0.01;

/**
 * subject を opponent と games 試合戦わせる。
 * 先手有利を均すため試合ごとに side を入れ替える(偶数回で subject が side1)。
 * seedBase が同じなら試合シード列も同じ ＝ CRN(共通乱数)が成立する。
 *
 * @returns {{winRate:number, avgScoreDiff:number, games:number}}
 */
export function evaluatePair(templates, seedBase, subject, opponent, games, options = {}) {
  // ⚠️ gameOffset は「同じ seedBase の試合列を複数ジョブへ分割する」ためだけの引数。
  // 分割しても各試合のシードと先後の割当が変わらないよう、必ず通し番号 gi で決める
  // (ここを g のまま使うと、ワーカーへの分割の仕方で学習結果が変わってしまう)。
  const gameOffset = options.gameOffset ?? 0;
  let winTotal = 0;
  let scoreDiffTotal = 0;
  for (let g = 0; g < games; g++) {
    const gi = g + gameOffset;
    const matchSeed = deriveSeed(seedBase, gi);
    const subjectIsSide1 = gi % 2 === 0;
    const specA = subjectIsSide1 ? subject : opponent;
    const specB = subjectIsSide1 ? opponent : subject;
    const obs = options.observeSubject
      ? subjectIsSide1
        ? { observeA: options.observeSubject }
        : { observeB: options.observeSubject }
      : {};
    const { result, scores } = playMatch(templates, matchSeed, specA, specB, obs);
    if (result === 'draw') winTotal += 0.5;
    else {
      const won =
        (subjectIsSide1 && result === 'side1') || (!subjectIsSide1 && result === 'side2');
      if (won) winTotal += 1;
    }
    const mine = subjectIsSide1 ? scores[0] : scores[1];
    const theirs = subjectIsSide1 ? scores[1] : scores[0];
    scoreDiffTotal += mine - theirs;
  }
  return { winRate: winTotal / games, avgScoreDiff: scoreDiffTotal / games, games };
}
