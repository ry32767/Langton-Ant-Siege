// テーブル参照型のCPUエージェント。docs/spec.md 機能6・docs/data-model.md 準拠。
//
// ⚠️ 重要な制約(AGENTS.md Do NOT / docs/spec.md 機能6の受け入れ条件):
// このファイルは `src/engine.js` を import しない。実行時のシミュレーション探索を
// 一切しないことをコード上の依存関係で担保するため。engine 側の操作(予約発射)は
// options.scheduleFire のコールバックで受け取る。数値定数のみ src/config.js から使う。
import * as C from './config.js';

/** kind別のコスト(engine.js の costOf と同じ計算式。依存を避けるためローカルに持つ)。 */
function costOf(kind, cellCount) {
  return C.ANT_KINDS[kind].baseCost + cellCount;
}

function buildTemplateIndex(list) {
  const byId = new Map();
  for (const t of list ?? []) byId.set(t.id, t);
  return byId;
}

/**
 * テンプレートから engine.fire() が受け取る action を組み立てる。
 * ⚠️ rule を必ず載せること。載せないと engine.fire() が C.LEGACY_RULE に
 * フォールバックしてしまい、テンプレートが想定するルールと違う挙動になる。
 */
function toAction(kind, template) {
  return {
    kind,
    rule: template.rule,
    cells: template.cells,
    antX: template.antX,
    antY: template.antY,
    antDir: template.antDir,
    templateId: template.id,
  };
}

/** softmax でひとつ選ぶ。rng.next() だけを使う(Math.random 禁止)。 */
function softmaxPick(rng, items, weights) {
  const exps = weights.map((w) => Math.exp(w));
  const sum = exps.reduce((a, b) => a + b, 0);
  if (!(sum > 0) || !Number.isFinite(sum)) return items[rng.int(items.length)];
  const r = rng.next() * sum;
  let acc = 0;
  for (let i = 0; i < items.length; i++) {
    acc += exps[i];
    if (r < acc) return items[i];
  }
  return items[items.length - 1];
}

/**
 * @param {object} options
 * @param {object} options.templates data/templates.json をパースしたオブジェクト
 *   ({ attack, disrupt, identifyTable, counterTable, escortTable, ... })
 * @param {object} options.policy data/policy.json の .policy 部分
 * @param {object} options.rng engine.createRng() が返す形({ next, int, pick })
 * @param {(action: object, atStep: number) => void} [options.scheduleFire] 予約発射のコールバック
 */
export function createCpuAgent(options) {
  const templates = options.templates ?? {};
  const policy = options.policy ?? {};
  const rng = options.rng;
  const scheduleFire = options.scheduleFire ?? (() => {});

  const attackTemplates = templates.attack ?? [];
  const disruptTemplates = templates.disrupt ?? [];
  const disruptById = buildTemplateIndex(disruptTemplates);
  const identifyTable = templates.identifyTable ?? {};
  const counterTable = templates.counterTable ?? {};
  const escortTable = templates.escortTable ?? {};

  // identifyTable(data/templates.json)は攻撃9種の発射位置・向きだけを持つ(選抜基準で
  // 一意性が保証されているのはそこだけ)。護衛の判断には「敵の迎撃(妨害)が何か」を
  // 特定する必要があるので、templates.disrupt から同じ形の逆引き表をローカルに作る。
  const disruptIdentifyTable = {};
  for (const d of disruptTemplates) {
    disruptIdentifyTable[`${d.antX},${d.antY},${d.antDir}`] = d.id;
  }

  // 「どの敵アリに迎撃を割り当てたか」。同じアリに何度も判断をやり直さないため。
  let assignedIntercepts = new Set(); // 敵の攻撃アリID → 迎撃を予約済み
  // 護衛は「自分の攻撃を撃った、まさにそのステップ」で、来るであろう迎撃を counterTable から
  // 予測して先回りで撃つ(docs/spec.md 護衛節)。CPU の判断は DECISION_INTERVAL_STEPS(1秒=120
  // ステップ)おきにしか呼ばれない一方、escortTable の fireAtStep は 0〜100 の窓しかない。つまり
  // 「攻撃アリが view.myAnts に現れてから」護衛を探すのでは、次の判断が来た時点で窓が閉じている
  // (fireAtStep=0/50 < DECISION_INTERVAL_STEPS=120)。そのため護衛は tryAttack が攻撃を選んだ
  // その場で(view.step を firedAtStep とみなして)予測・予約する。
  // キーは「自分の firedAtStep(=攻撃を撃ったステップ)」。1判断で最大1回しか攻撃しないので
  // 同じ側で firedAtStep が重複することはない。
  let escortedAtSteps = new Set();

  function identifyAttack(ownerX, ownerY, ownerDir) {
    return identifyTable[`${ownerX},${ownerY},${ownerDir}`] ?? null;
  }

  function identifyDisrupt(ownerX, ownerY, ownerDir) {
    return disruptIdentifyTable[`${ownerX},${ownerY},${ownerDir}`] ?? null;
  }

  /** counterTable/escortTable の候補一覧から、成功率降順・現在のトークンで撃てるものだけを残す。 */
  function affordableDisruptCandidates(candidates, tokens) {
    return candidates
      .filter((c) => {
        const tpl = disruptById.get(c.disruptId ?? c.escortId);
        if (!tpl) return false;
        return costOf('disrupt', tpl.cells.length) <= tokens;
      })
      .slice()
      .sort((a, b) => (b.successRate ?? 1) - (a.successRate ?? 1));
  }

  /**
   * 候補の中から「まだ未来」の発射ステップを持つものを探し、見つかったら
   * scheduleFire するか(未来)即座に返すか(ちょうど今)を決める。
   * 戻り値: { action, atStep } または null(全候補が過去 → 諦める)
   */
  function pickTiming(candidates, idKey, baseStep, currentStep) {
    for (const cand of candidates) {
      const tpl = disruptById.get(cand[idKey]);
      if (!tpl) continue;
      const absStep = baseStep + cand.fireAtStep;
      if (absStep < currentStep) continue; // 既に過ぎている → 次の候補
      return { action: toAction('disrupt', tpl), atStep: absStep };
    }
    return null;
  }

  /**
   * pickTiming と同じだが、「ちょうど今」(absStep === currentStep)は候補から除外する。
   * scheduleFire だけを使う経路(即時 return ができない場所)で使う: engine.js の
   * stepMatch は「予約発射の消化」→「新しい判断」の順で1ステップを処理するため、
   * 判断中に scheduleFire(action, 現在のstep) してしまうと、そのステップではもう
   * 予約発射の消化が終わった後なので永遠に発火しない「ゾンビ予約」になる。
   */
  function pickFutureTiming(candidates, idKey, baseStep, currentStep) {
    for (const cand of candidates) {
      const tpl = disruptById.get(cand[idKey]);
      if (!tpl) continue;
      const absStep = baseStep + cand.fireAtStep;
      if (absStep <= currentStep) continue; // 今 or 過去 → scheduleFire では発火できない
      return { action: toAction('disrupt', tpl), atStep: absStep };
    }
    return null;
  }

  function tryDefend(view) {
    const threat = view.enemyAnts.find(
      (a) => a.kind === 'attack' && !assignedIntercepts.has(a.id),
    );
    if (!threat) return null;
    if (rng.next() >= policy.defendBias) return null;

    const attackId = identifyAttack(threat.spawnX, threat.spawnY, threat.spawnDir);
    if (!attackId) return null;
    const raw = counterTable[attackId];
    if (!raw || raw.length === 0) return null;

    const candidates = affordableDisruptCandidates(raw, view.tokens);
    const picked = pickTiming(candidates, 'disruptId', threat.firedAtStep, view.step);
    if (!picked) return null; // 全候補が過去 → 迎撃を諦める

    assignedIntercepts.add(threat.id);
    if (picked.atStep > view.step) {
      scheduleFire(picked.action, picked.atStep);
      return null;
    }
    return picked.action; // ちょうど今のタイミング
  }

  /**
   * counterTable[myAttackId](成功率降順)を走査し、各予測迎撃候補について
   * escortTable[myAttackId][予測迎撃ID] から「トークンが足りて、指定した基準の中で
   * 発火可能」な護衛タイミングを探す。見つかった時点で確定する(敵の迎撃を実際に
   * 観測する必要はない)。`timingFn` は pickTiming(今も可) か pickFutureTiming(今は不可、
   * scheduleFire専用) のどちらかを呼び出し元が選ぶ。
   */
  function pickEscortForAttack(myAttackId, baseStep, tokens, currentStep, timingFn) {
    const counterCandidates = counterTable[myAttackId];
    if (!counterCandidates || counterCandidates.length === 0) return null;
    const sortedCounters = counterCandidates
      .slice()
      .sort((a, b) => (b.successRate ?? 1) - (a.successRate ?? 1));
    for (const counterCand of sortedCounters) {
      const predictedInterceptId = counterCand.disruptId;
      const raw = escortTable[myAttackId]?.[predictedInterceptId];
      if (!raw || raw.length === 0) continue;
      const candidates = affordableDisruptCandidates(raw, tokens);
      const picked = timingFn(candidates, 'escortId', baseStep, currentStep);
      if (picked) return picked;
    }
    return null;
  }

  /**
   * 護衛は「敵の迎撃を見てから」ではなく「自分の攻撃を撃った、まさにそのステップ」で
   * 予測して先回りで撃つ(docs/spec.md 護衛節)。CPU の判断(decide)は
   * DECISION_INTERVAL_STEPS(1秒=120ステップ)おきにしか呼ばれない一方、escortTable の
   * fireAtStep は多くが 0〜100 の窓しかない。攻撃アリが view.myAnts に現れるのを待って
   * から護衛を探すのでは、次の判断が来た時点で窓が閉じていることが多い(実測で確認済み)。
   * そのため tryAttack が攻撃を選んだその場で、view.step を firedAtStep とみなして
   * 予測・予約する。scheduleFire しか使えない(この呼び出しの戻り値は攻撃アクションに
   * 固定されているため)ので、pickFutureTiming で「ちょうど今」の候補(ゾンビ予約になる)
   * は除外する。
   */
  function scheduleEscortForAttack(chosenAttackTemplate, attackCost, view) {
    if (rng.next() >= policy.escortBias) return; // 護衛しない判断
    const tokensAfterAttack = view.tokens - attackCost; // 攻撃コストを差し引いた残りトークン
    const picked = pickEscortForAttack(
      chosenAttackTemplate.id,
      view.step,
      tokensAfterAttack,
      view.step,
      pickFutureTiming,
    );
    if (picked) scheduleFire(picked.action, picked.atStep);
  }

  /**
   * 後方互換の経路: すでに飛んでいる自分の攻撃アリ(view.myAnts)を見て、まだ間に合う
   * 護衛タイミングが残っていれば予約する。escortTable の fireAtStep が
   * DECISION_INTERVAL_STEPS 以上(=次の判断でもまだ間に合う)場合に有効に働く。
   * 攻撃発射と同じステップで scheduleEscortForAttack がすでに処理済みのアリは
   * escortedAtSteps でスキップする。
   */
  function tryEscort(view) {
    for (const myAnt of view.myAnts) {
      if (myAnt.kind !== 'attack' || !myAnt.templateId) continue;
      if (escortedAtSteps.has(myAnt.firedAtStep)) continue;

      if (rng.next() >= policy.escortBias) continue; // 護衛しない判断(次のステップで再抽選)

      const picked = pickEscortForAttack(
        myAnt.templateId,
        myAnt.firedAtStep,
        view.tokens,
        view.step,
        pickTiming,
      );
      if (!picked) {
        escortedAtSteps.add(myAnt.firedAtStep); // 有効な護衛が見つからない → 諦めて再試行しない
        continue;
      }

      escortedAtSteps.add(myAnt.firedAtStep);
      if (picked.atStep > view.step) {
        scheduleFire(picked.action, picked.atStep);
        return null;
      }
      return picked.action; // ちょうど今のタイミング
    }
    return null;
  }

  function tryAttack(view) {
    if (view.tokens < policy.fireThreshold) return null;
    const reserve = policy.reserveTokens ?? 0;
    const affordable = [];
    const weights = [];
    attackTemplates.forEach((tpl, i) => {
      const cost = costOf('attack', tpl.cells.length);
      if (view.tokens - cost >= reserve) {
        affordable.push(tpl);
        weights.push(policy.attackPref?.[i] ?? 0);
      }
    });
    if (affordable.length === 0) return null;
    const chosen = softmaxPick(rng, affordable, weights);
    const cost = costOf('attack', chosen.cells.length);

    // 護衛の予約はここで行う(このアリが実際に発射されるのはこの直後、まさに view.step)。
    escortedAtSteps.add(view.step);
    scheduleEscortForAttack(chosen, cost, view);

    return toAction('attack', chosen);
  }

  return {
    decide(view) {
      if (view.flyingCount >= C.MAX_FLYING) return null;
      return tryDefend(view) ?? tryEscort(view) ?? tryAttack(view) ?? null;
    },
    reset() {
      assignedIntercepts = new Set();
      escortedAtSteps = new Set();
    },
  };
}
