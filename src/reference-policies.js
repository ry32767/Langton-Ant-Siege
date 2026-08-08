// Reference League(契約 docs/action-centric-contract.md §6)。学習しない固定4方策。
//
// ⚠️ `src/cpu.js` の generateActions を共有し、スコア関数だけを差し替える
// (`createCpuAgent({ scoreAction })` の形で注入する)。CEM の重みは一切参照しない。
// このファイルも `src/engine.js` を import しない。
import * as C from './config.js';

export const REFERENCE_POLICY_NAMES = Object.freeze(['ATTACK_ONLY', 'CHEAP_SPAM', 'SAVE_AND_BURST', 'DEFEND_HEAVY']);

/**
 * `SAVE_AND_BURST` が撃ち始めるトークン閾値(契約 §6・§19.3)。
 * ⚠️ src/config.js に定義済みの唯一の値をそのまま使う(直書きしない)。
 */
export const BURST_THRESHOLD = C.BURST_THRESHOLD;

// ---------------------------------------------------------------------------
// 共通 tie-break(契約 §6): atStep 昇順 → templateId 辞書順 → launchX 昇順。
//
// 各参照方策のスコア関数は `(action, view, ctx) => number` で、他の候補を横から見られない
// (selectAction が候補ごとに独立に呼ぶ)。そこで tie-break の対象になるタプル
// (atStep, templateId, launchX) を「小さいほど大きいスコア」になるよう単調写像する
// 純粋関数を用意し、各方策がそれを土台に使う。
//
// ⚠️ 「小さいものを高スコアにする」ための重み付けなので、桁を安全に分離できるよう
// 定数を決め打ちしている(仕様書に無い実装判断。値は Number.MAX_SAFE_INTEGER に
// 十分収まる範囲を検算して選んだ)。
// ---------------------------------------------------------------------------

const TPL_KEY_BASE = 128; // 文字コードの底(ASCII前提)
const TIEBREAK_TPL_WEIGHT = 1000; // launchX(<WIDTH=256)より大きい
const TIEBREAK_ATSTEP_WEIGHT = 2e7; // templateOrderKey(最大 128*128-1=16,383)*1000 より大きい
// tieBreakScore が常に正になるようにする基準値(atStep・templateOrderKey・launchX の最大値から逆算)。
const TIEBREAK_BASE =
  C.TOTAL_STEPS * TIEBREAK_ATSTEP_WEIGHT + TPL_KEY_BASE * TPL_KEY_BASE * TIEBREAK_TPL_WEIGHT + C.WIDTH + 1;

/** templateId(短い英数字ID)を辞書順を保つ数値へ変換する(先頭2文字だけで十分な解像度)。 */
function templateOrderKey(templateId) {
  const s = String(templateId ?? '');
  const c0 = s.charCodeAt(0) || 0;
  const c1 = s.charCodeAt(1) || 0;
  return c0 * TPL_KEY_BASE + c1;
}

/** (atStep, templateId, launchX) が小さいほど大きい正のスコアを返す。 */
function tieBreakScore(atStep, templateId, launchX) {
  const tplKey = templateOrderKey(templateId);
  const penalty = atStep * TIEBREAK_ATSTEP_WEIGHT + tplKey * TIEBREAK_TPL_WEIGHT + launchX;
  return TIEBREAK_BASE - penalty;
}

function isImmediateAttackFire(action, view) {
  return action.type === 'FIRE' && action.kind === 'attack' && action.atStep === view.step;
}

// ---------------------------------------------------------------------------
// 各方策の規則(契約 §6 の表)
// ---------------------------------------------------------------------------

/** 即時の attack FIRE のみ採用。妨害・自爆は不採用。無ければ WAIT(selectAction が担保)。 */
function attackOnlyScore(action, view) {
  if (!isImmediateAttackFire(action, view)) return -Infinity;
  return tieBreakScore(action.atStep, action.templateId, action.launchX);
}

// 攻撃コストの取りうる範囲(ATTACK_COST〜ATTACK_COST+MAX_CELLS)。cost を優先軸にするための正規化に使う。
const ATTACK_COST_RANGE = C.ATTACK_COST + C.MAX_CELLS;
// cost の差が tieBreakScore の全レンジより大きく効くようにする重み。
const CHEAP_SPAM_COST_WEIGHT = TIEBREAK_BASE + 1;

/** 即時 attack FIRE のうち cost 最小。同コストは共通 tie-break。無ければ WAIT。 */
function cheapSpamScore(action, view) {
  if (!isImmediateAttackFire(action, view)) return -Infinity;
  const costRank = ATTACK_COST_RANGE - action.cost; // cost が小さいほど大きい
  return costRank * CHEAP_SPAM_COST_WEIGHT + tieBreakScore(action.atStep, action.templateId, action.launchX);
}

/** avail < BURST_THRESHOLD なら WAIT。以上なら ATTACK_ONLY と同じ。 */
function saveAndBurstScore(action, view, ctx) {
  if ((ctx.avail ?? 0) < BURST_THRESHOLD) return -Infinity;
  return attackOnlyScore(action, view);
}

// counter 由来の FIRE を attack フォールバックより常に上位にするための帯オフセット。
const DEFEND_BAND_OFFSET = TIEBREAK_BASE * 2;

/** source === 'counter' の FIRE があればそれを共通 tie-break で1つ。無ければ ATTACK_ONLY と同じ。 */
function defendHeavyScore(action, view) {
  if (action.type === 'FIRE' && action.source === 'counter') {
    return DEFEND_BAND_OFFSET + tieBreakScore(action.atStep, action.templateId, action.launchX);
  }
  return attackOnlyScore(action, view);
}

const SCORERS = Object.freeze({
  ATTACK_ONLY: attackOnlyScore,
  CHEAP_SPAM: cheapSpamScore,
  SAVE_AND_BURST: saveAndBurstScore,
  DEFEND_HEAVY: defendHeavyScore,
});

/** `createReferenceScorer(name): (action, view, ctx) => number`(契約 §6)。 */
export function createReferenceScorer(name) {
  const scorer = SCORERS[name];
  if (!scorer) throw new Error(`unknown reference policy: ${name}`);
  return scorer;
}
