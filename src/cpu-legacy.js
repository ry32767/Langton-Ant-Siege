// ⚠️ **凍結モジュール(v5.5 の旧CPU)。編集しないこと。**
//
// v6 で src/cpu.js を Action-Centric に全面刷新した(差分仕様 §3・§15)。旧CPUを消すと
// 差分仕様 §26.2「旧学習済みCPUとの直接対戦 1,000試合」が実施不能になるため、当時の
// 実装をそのまま凍結して残す。対になる方策は data/policy-v55.json(旧11次元スキーマ)。
//
// - 新しい機能をここに足さない。新CPUの変更をここへ反映しない
// - 参照するのは scripts/evaluate-policy.mjs(最終評価)だけ。ブラウザ・学習からは使わない
// - export 名は createCpuAgent のまま。呼び出し側は import 名でどちらかを選ぶ
//
// 以下は凍結時点の原文コメント。
//
// テーブル参照型のCPUエージェント。docs/spec.md 機能6・docs/data-model.md 準拠。
//
// ⚠️ 重要な制約(AGENTS.md Do NOT / docs/spec.md 機能6の受け入れ条件):
// このファイルは `src/engine.js` を import しない。実行時のシミュレーション探索を
// 一切しないことをコード上の依存関係で担保するため。engine 側の操作(予約発射)は
// options.scheduleFire のコールバックで受け取る。数値定数のみ src/config.js から使う。
//
// v5: 発射列(antX)が可変になった。テンプレートは antX を持たず、cells は
// アリからの相対 [dx, dy, state]。座標変換は engine 非依存の src/template.js に
// 切り出してあるので、そこから import する(engine.js を import してはいけないため)。
import * as C from './config.js';
import { instantiateTemplate, wrapX, scoringLaunchColumns } from './template.js';

// ⚠️ コスト式のローカル複製をやめ、src/config.js の costOf(唯一の定義)を使う(v5.5)。
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
 * ⚠️ rule は instantiateTemplate がそのまま template.rule を載せる。載らないと
 * engine.fire() が C.LEGACY_RULE にフォールバックしてしまい、想定するルールと違う挙動になる。
 */
function toAction(kind, template, antX) {
  const action = instantiateTemplate(template, antX);
  return { ...action, kind };
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
 * @param {(antId: number) => void} [options.selfDestruct] 自陣の飛行中アリを消すコールバック
 *   (engine.selfDestruct への橋渡し。cpu.js は engine を import できないため呼び出し側が渡す)
 * @param {(event: object) => void} [options.observe] 計測用の観測コールバック(既定は何もしない)。
 *   判断の**意図**(迎撃/護衛/攻撃/自爆)は action の形からは復元できない — 迎撃も護衛も
 *   同じ 'disrupt' アクションになるため。offline の検証スクリプト(docs/spec.md v5.4 §11)が
 *   「迎撃の発射数」と「護衛の発射数」を分けて数えるためにここで意図を外へ出す。
 *   ⚠️ 観測は副作用を持ってはいけない。乱数を消費せず、判断結果にも影響しない
 *   (既定が no-op なので、渡さなければ試合の再現性は完全に同じ)。
 */
export function createCpuAgent(options) {
  const templates = options.templates ?? {};
  const policy = options.policy ?? {};
  const rng = options.rng;
  const scheduleFire = options.scheduleFire ?? (() => {});
  const selfDestruct = options.selfDestruct ?? (() => {});
  const observe = options.observe ?? (() => {});

  const attackTemplates = templates.attack ?? [];
  const disruptTemplates = templates.disrupt ?? [];
  const disruptById = buildTemplateIndex(disruptTemplates);
  const identifyTable = templates.identifyTable ?? {};
  const counterTable = templates.counterTable ?? {};
  const escortTable = templates.escortTable ?? {};

  // identifyTable(data/templates.json)は攻撃9種の発射位置(y)・向きだけを持つ(v5 で
  // antX が可変になったのでキーから外れた。選抜基準で一意性が保証されているのは
  // (antY, antDir) の組)。護衛の判断には「敵の迎撃(妨害)が何か」を特定する必要が
  // あるので、templates.disrupt から同じ形の逆引き表をローカルに作る。
  const disruptIdentifyTable = {};
  for (const d of disruptTemplates) {
    disruptIdentifyTable[`${d.antY},${d.antDir}`] = d.id;
  }

  // ---------------------------------------------------------------------
  // 予約発射のトークン確保(v5.2 の修正。これが無いと迎撃・護衛が一切成立しない)
  //
  // engine の scheduleFire は「予約リストに積む」だけで、実際の発射は予約した
  // ステップに `fire()` → `canFire()` を通る。canFire が落ちたときの `fire()` の
  // 戻り値は **null で、呼び出し側は何も見ていない**(engine.js の stepMatch)。
  // つまり予約してから発火までの間に別の発射でトークンを使い切ると、予約は
  // **黙って消える**。
  //
  // ⚠️ decide() は `tryDefend() ?? tryEscort() ?? tryAttack()` であり、
  // tryDefend / tryEscort は「未来のタイミングに予約したら null を返す」。
  // その null が次を呼ぶので、**同じ判断の中で tryAttack が予約分のトークンを
  // 使ってしまう**。実測(30試合・3方策)で予約発射の **100%** がこの経路で
  // 消えており、迎撃・護衛は一度も発射されていなかった。結果として
  // defendBias / escortBias / counterTable / escortTable がまるごと死に経路になり、
  // CEM の13パラメータ中11個が学習信号を持たなかった。
  //
  // ここで「予約済みだがまだ発火していない発射」のコストを自前で持ち、以降の
  // 判断で使えるトークンから差し引くことで予約を守る。トークンは時間で増える
  // 一方 fire() でしか減らないので、いま確保しておけば発火時点でも足りる。
  // ---------------------------------------------------------------------
  let commitments = []; // { atStep, cost } 予約済みでまだ発火していない発射
  let avail = 0; // この判断で使えるトークン(view.tokens から確保分を引いた値)

  /** 発火済み(atStep <= step)の確保を解放する。 */
  function releaseExpiredCommitments(step) {
    if (commitments.length === 0) return;
    commitments = commitments.filter((c) => c.atStep > step);
  }

  function committedTokens() {
    let sum = 0;
    for (const c of commitments) sum += c.cost;
    return sum;
  }

  /** 予約発射する。必ずこれを通すこと(直接 scheduleFire を呼ぶと確保が漏れる)。 */
  function commitScheduledFire(action, atStep) {
    const cost = costOf(action.kind, action.cells.length);
    commitments.push({ atStep, cost });
    avail -= cost; // 同じ判断の後続(tryEscort / tryAttack)から見えなくする
    scheduleFire(action, atStep);
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

  function identifyAttack(ownerY, ownerDir) {
    return identifyTable[`${ownerY},${ownerDir}`] ?? null;
  }

  function identifyDisrupt(ownerY, ownerDir) {
    return disruptIdentifyTable[`${ownerY},${ownerDir}`] ?? null;
  }

  /**
   * `atStep` の時点で使えると見込めるトークン。
   *
   * ⚠️ 予約発射は「いま」ではなく**未来**に発火する。トークンは TOKEN_TICK_STEPS ごとに
   * TOKEN_PER_TICK ずつ増えて TOKEN_CAP で頭打ちになるので、発火時点の残高は現在より多い。
   *
   * v5.2 の修正: ここを「現在のトークン」で判定していたため、**護衛が構造的に一度も
   * 撃たれなかった**。護衛は tryAttack が攻撃を選んだその場で予約するが、その瞬間の残高は
   * 攻撃コストを引いた直後でほぼ 0 なので、候補が全部「高すぎる」と判定されて消えていた
   * (実測: escortBias=1 でも妨害の発射数 0.00/試合 ＝ 攻撃のみの方策と完全に同じ挙動)。
   * 結果として escortBias は学習信号を持たない死に次元だった。
   *
   * 既に確保済みのトークン(commitments)は差し引く。
   */
  function projectedTokens(view, atStep) {
    const ticks = Math.max(
      0,
      Math.floor(atStep / C.TOKEN_TICK_STEPS) - Math.floor(view.step / C.TOKEN_TICK_STEPS),
    );
    const projected = Math.min(C.TOKEN_CAP, view.tokens + ticks * C.TOKEN_PER_TICK);
    return projected - committedTokens();
  }

  /**
   * counterTable/escortTable の候補一覧を成功率降順に並べる(存在しないテンプレートは除く)。
   * ⚠️ トークンで絞るのはここではなく pickTiming 側。候補ごとに発火ステップが違い、
   * 見込み残高もステップごとに違うため(projectedTokens のコメント参照)。
   * 候補要素の id フィールド名は表によって異なる(disruptId / escortDisruptId)ので
   * disruptById のキーとして両方を試す。
   */
  function affordableDisruptCandidates(candidates) {
    return candidates
      .filter((c) => disruptById.get(c.disruptId ?? c.escortDisruptId ?? c.escortId) != null)
      .slice()
      .sort((a, b) => (b.successRate ?? 1) - (a.successRate ?? 1));
  }

  /**
   * 候補の中から「まだ未来」の発射ステップを持つものを探し、見つかったら
   * scheduleFire するか(未来)即座に返すか(ちょうど今)を決める。
   *
   * ⚠️ v5.4: 発射列は**候補ごとに違う**。`counterTable` / `escortTable` は
   * (攻撃, 妨害) ペアごとに実際に迎撃が成立する相対列 `deltaX` を事前計算して
   * 持っているので、`wrapX(baseX + cand[deltaKey])` をこのループの中で計算する。
   * v5.3 は呼び出し元が単一の列を先に決めて渡していたが、それだと候補ごとの
   * 照準情報を捨てることになる(下の tryDefend のコメント参照)。
   * ここが選ぶのは「どの妨害テンプレートを・どの相対列から・いつ」。
   *
   * @param {number} baseX 相対列の基準になる絶対列(迎撃なら敵攻撃の spawnX、
   *   護衛なら自分の攻撃の spawnX)。
   * @param {string} deltaKey 候補が持つ相対列のフィールド名('deltaX' / 'escortDeltaX')。
   * 戻り値: { action, atStep } または null(全候補が過去 or 払えない → 諦める)
   */
  function pickTiming(view, candidates, idKey, deltaKey, baseX, baseStep, currentStep) {
    for (const cand of candidates) {
      const tpl = disruptById.get(cand[idKey]);
      if (!tpl) continue;
      const absStep = baseStep + cand.fireAtStep;
      if (absStep < currentStep) continue; // 既に過ぎている → 次の候補
      // 発火時点の見込み残高で払えるかを見る(現在残高ではない。projectedTokens 参照)
      if (costOf('disrupt', tpl.cells.length) > projectedTokens(view, absStep)) continue;
      const antX = wrapX(baseX + (cand[deltaKey] ?? 0));
      return { action: toAction('disrupt', tpl, antX), atStep: absStep };
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
  function pickFutureTiming(view, candidates, idKey, deltaKey, baseX, baseStep, currentStep) {
    for (const cand of candidates) {
      const tpl = disruptById.get(cand[idKey]);
      if (!tpl) continue;
      const absStep = baseStep + cand.fireAtStep;
      if (absStep <= currentStep) continue; // 今 or 過去 → scheduleFire では発火できない
      // 発火時点の見込み残高で払えるかを見る(現在残高ではない。projectedTokens 参照)
      if (costOf('disrupt', tpl.cells.length) > projectedTokens(view, absStep)) continue;
      const antX = wrapX(baseX + (cand[deltaKey] ?? 0));
      return { action: toAction('disrupt', tpl, antX), atStep: absStep };
    }
    return null;
  }

  /**
   * 攻撃アリの発射列を決める(v5.3)。
   *
   * 得点したいなら撃てる列は `scoringLaunchColumns` が返す幅 SCORE_GATE_WIDTH の区間に
   * 限られる(ゲートを外すと到達しても得点にならない)。その区間の中はどこも力学的に等価
   * なので、絶対列の選好は学習できない。学習できるのは**盤面に対する相対評価**。
   *
   * そこで区間から ATTACK_COLUMN_SAMPLES 本を無作為に引き、`view.columnNonWhite`
   * (列ごとの非白セル数。engine が増分で持つ)が最小＝いちばん綺麗な列を選ぶ。
   * 汚れた列はハイウェイが他のアリの軌跡に乱されやすいという読み。
   * これを行う確率が `attackAvoidBias`。残りは従来どおり一様ランダム。
   */
  function chooseAttackColumn(view, cols) {
    if (rng.next() >= (policy.attackAvoidBias ?? 0)) {
      return wrapX(cols.min + rng.int(cols.count)); // 従来どおり一様
    }
    const columnNonWhite = view.columnNonWhite;
    let best = wrapX(cols.min + rng.int(cols.count));
    if (!columnNonWhite) return best;
    let bestScore = columnNonWhite[best];
    for (let i = 1; i < C.ATTACK_COLUMN_SAMPLES; i++) {
      const cand = wrapX(cols.min + rng.int(cols.count));
      const score = columnNonWhite[cand];
      if (score < bestScore) {
        bestScore = score;
        best = cand;
      }
    }
    return best;
  }

  function tryDefend(view) {
    const threat = view.enemyAnts.find(
      (a) => a.kind === 'attack' && !assignedIntercepts.has(a.id),
    );
    if (!threat) return null;
    if (rng.next() >= policy.defendBias) return null;

    const attackId = identifyAttack(threat.spawnY, threat.spawnDir);
    if (!attackId) return null;
    const raw = counterTable[attackId];
    if (!raw || raw.length === 0) return null;

    const candidates = affordableDisruptCandidates(raw);
    // 迎撃の発射列は counterTable の deltaX が決める(v5.4 でテーブル照準に戻した)。
    // ⚠️ 基準は x(現在の列)ではなく **spawnX(発射時の列)**。deltaX は「妨害の発射列 −
    // 攻撃の発射列」として事前計算されているので、飛行中に流れた現在位置に合わせると
    // 表と基準がズレて迎撃が成立しない。x は陣営で鏡像にならないのでそのまま足せる。
    const picked = pickTiming(
      view,
      candidates,
      'disruptId',
      'deltaX',
      threat.spawnX,
      threat.firedAtStep,
      view.step,
    );
    if (!picked) return null; // 全候補が過去 → 迎撃を諦める

    assignedIntercepts.add(threat.id);
    // 迎撃を「誰に対して」割り当てたかを外へ出す(§11 の迎撃成功率の計測用)。
    observe({ type: 'defend', targetAntId: threat.id, attackId, antX: picked.action.antX });
    if (picked.atStep > view.step) {
      commitScheduledFire(picked.action, picked.atStep);
      return null;
    }
    avail -= costOf(picked.action.kind, picked.action.cells.length); // 「今」撃つぶんも差し引く
    return picked.action; // ちょうど今のタイミング
  }

  /**
   * counterTable[myAttackId](成功率降順)を走査し、各予測迎撃候補について
   * escortTable[myAttackId][予測迎撃ID] から「トークンが足りて、指定した基準の中で
   * 発火可能」な護衛タイミングを探す。見つかった時点で確定する(敵の迎撃を実際に
   * 観測する必要はない)。`timingFn` は pickTiming(今も可) か pickFutureTiming(今は不可、
   * scheduleFire専用) のどちらかを呼び出し元が選ぶ。`myAttackAntX` は「自分が撃った
   * 攻撃の発射列」。護衛の発射列は wrapX(myAttackAntX + escortDeltaX) で決める。
   */
  function pickEscortForAttack(view, myAttackId, myAttackAntX, baseStep, currentStep, timingFn) {
    const counterCandidates = counterTable[myAttackId];
    if (!counterCandidates || counterCandidates.length === 0) return null;
    const sortedCounters = counterCandidates
      .slice()
      .sort((a, b) => (b.successRate ?? 1) - (a.successRate ?? 1));
    for (const counterCand of sortedCounters) {
      const predictedInterceptId = counterCand.disruptId;
      const raw = escortTable[myAttackId]?.[predictedInterceptId];
      if (!raw || raw.length === 0) continue;
      const candidates = affordableDisruptCandidates(raw);
      // 護衛の発射列も escortTable の escortDeltaX が決める(v5.4)。基準は自分の攻撃の
      // 発射列(escortDeltaX =「護衛妨害の発射列 − 自軍攻撃の発射列」)。
      const picked = timingFn(
        view,
        candidates,
        'escortDisruptId',
        'escortDeltaX',
        myAttackAntX,
        baseStep,
        currentStep,
      );
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
   * は除外する。attackAntX はこの攻撃で実際に選んだ発射列(呼び出し元がその場で渡す)。
   */
  function scheduleEscortForAttack(chosenAttackTemplate, attackAntX, view) {
    if (rng.next() >= policy.escortBias) return false; // 護衛しない判断
    // ⚠️ 攻撃コストは呼び出し元(tryAttack)が既にコミット済みなので、ここでは差し引かない。
    // projectedTokens が committedTokens() を引くため二重に引くと護衛が選ばれなくなる。
    const picked = pickEscortForAttack(
      view,
      chosenAttackTemplate.id,
      attackAntX,
      view.step,
      view.step,
      pickFutureTiming,
    );
    if (!picked) return false;
    observe({ type: 'escort', attackId: chosenAttackTemplate.id, antX: picked.action.antX });
    commitScheduledFire(picked.action, picked.atStep);
    return true;
  }

  /**
   * 後方互換の経路: すでに飛んでいる自分の攻撃アリ(view.myAnts)を見て、まだ間に合う
   * 護衛タイミングが残っていれば予約する。escortTable の fireAtStep が
   * DECISION_INTERVAL_STEPS 以上(=次の判断でもまだ間に合う)場合に有効に働く。
   * 攻撃発射と同じステップで scheduleEscortForAttack がすでに処理済みのアリは
   * escortedAtSteps でスキップする。myAnt.spawnX(=飛行中の自分の攻撃アリの発射列)を
   * 護衛の発射列の基準にする。
   */
  function tryEscort(view) {
    for (const myAnt of view.myAnts) {
      if (myAnt.kind !== 'attack' || !myAnt.templateId) continue;
      if (escortedAtSteps.has(myAnt.firedAtStep)) continue;

      if (rng.next() >= policy.escortBias) continue; // 護衛しない判断(次のステップで再抽選)

      const picked = pickEscortForAttack(
        view,
        myAnt.templateId,
        myAnt.spawnX,
        myAnt.firedAtStep,
        view.step,
        pickTiming,
      );
      // 有効な護衛が見つからない → 諦めて再試行しない。
      //
      // ⚠️ v5.2 で「トークンは時間で増えるのだから再挑戦させれば護衛が撃てるはず」と考えて
      // この打ち切りを外して毎判断リスキャンさせたが、**護衛の発射数は 0.00 回/試合のまま
      // 変わらず**、スループットだけが約半分(130 → 66 試合/秒)になった。A8 の護衛窓は
      // 16,800 ステップ＝判断25回ぶん開いているため、窓が閉じるまで打ち切る方式でも縮まらない。
      // 護衛が撃てない原因はここ(採否のロジック)ではなくテンプレート側のデータなので
      // (docs/spec.md 未決定事項 (b) 参照)、打ち切りは元どおり残す。
      if (!picked) {
        escortedAtSteps.add(myAnt.firedAtStep);
        continue;
      }

      escortedAtSteps.add(myAnt.firedAtStep);
      observe({ type: 'escort', attackId: myAnt.templateId, antX: picked.action.antX });
      if (picked.atStep > view.step) {
        commitScheduledFire(picked.action, picked.atStep);
        return null;
      }
      avail -= costOf(picked.action.kind, picked.action.cells.length); // 「今」撃つぶんも差し引く
      return picked.action; // ちょうど今のタイミング
    }
    return null;
  }

  /**
   * 発射列(antX)の選択に方策パラメータは足していない(policy.json のスキーマは v4 のまま)。
   * 理由: 得点ゲート内の192列はどこから撃っても対称(x方向の平行移動はハイウェイの厳密な
   * 対称性なので、テンプレートの強さそのものは列に依存しない)。学習で崩したい非対称は
   * 「相手がどの列を張っているか」という対戦相手依存の情報であり、CEM の自己対戦(固定の
   * 対戦相手分布ではない)ではこの種の適応的な列選びを学習させても収束しにくい。よって
   * cpu.js 内で区間から一様ランダムに選ぶ(rng.int)にとどめる。相手の傾向を見て列を
   * 散らす/絞るような発展は方策パラメータではなく view(相手の過去の発射列の観測)を使う
   * 別機能として後で追加するのが筋が良い。
   */
  function tryAttack(view) {
    if (avail < policy.fireThreshold) return null;
    const reserve = policy.reserveTokens ?? 0;
    const affordable = [];
    const weights = [];
    const launchColumns = []; // affordable と同じ添字で対応する {min, count}
    attackTemplates.forEach((tpl, i) => {
      const cost = costOf('attack', tpl.cells.length);
      if (avail - cost < reserve) return;
      // v5: 得点したいなら撃てる列は entryXAt0 から決まる幅 SCORE_GATE_WIDTH の区間に限られる。
      // count===0(到達しないテンプレート)は候補から外す。
      const cols = scoringLaunchColumns(tpl);
      if (cols.count === 0) return;
      affordable.push(tpl);
      weights.push(policy.attackPref?.[i] ?? 0);
      launchColumns.push(cols);
    });
    if (affordable.length === 0) return null;
    const chosen = softmaxPick(rng, affordable, weights);
    const chosenIdx = affordable.indexOf(chosen);
    const cols = launchColumns[chosenIdx];
    // v5.3: 発射列は方策が盤面を見て選ぶ(chooseAttackColumn 参照)。
    // Math.random() は禁止。rng.int(n) だけを使う。
    const antX = chooseAttackColumn(view, cols);
    const cost = costOf('attack', chosen.cells.length);

    // この攻撃は decide() が返した直後に engine が発射する。護衛の見込み残高から正しく
    // 差し引くため「このステップに発火するコミット」として積んでおく(atStep === view.step
    // なので次の判断の releaseExpiredCommitments で解放され、二重計上にならない)。
    commitments.push({ atStep: view.step, cost });
    avail -= cost;

    // 護衛の予約はここで行う(このアリが実際に発射されるのはこの直後、まさに view.step)。
    //
    // ⚠️ v5.2: 以前は成否によらず無条件に escortedAtSteps へ入れていたため、
    // 「発射の瞬間はトークンが足りず護衛を取れなかった」攻撃アリが**二度と**
    // tryEscort の再挑戦を受けられなかった(tryEscort は firedAtStep で弾く)。
    // トークンは時間で増えるので、発射直後に払えなくても数秒後には払える。
    // 実測: 無条件に登録していたときは escortBias=1 でも護衛の発射数が 0.00/試合。
    // 予約できたときだけ「処理済み」にして、失敗した攻撃は再挑戦の対象に残す。
    if (scheduleEscortForAttack(chosen, antX, view)) escortedAtSteps.add(view.step);

    observe({ type: 'attack', attackId: chosen.id, antX });
    return toAction('attack', chosen, antX);
  }

  /**
   * 自爆(飛行中の自分のアリを消す)。
   *
   * ⚠️ **`flyingCount >= MAX_FLYING` の早期 return より前に評価すること。**
   * 枠が埋まっているときこそ自爆したい(古い弾を引いて撃ち直す)ので、
   * 発射できないときに諦めて return してしまうと機能が死ぬ。
   *
   * 判断は3つの方策パラメータで決まる:
   *   - selfDestructRemainingTicks … 寿命まで残り何回のCPU判断になったら候補にするか(1〜10の整数)
   *   - selfDestructBias    … 自爆を試みる基礎確率
   *   - pollutionDestructWeight … 盤面が汚れているほど自爆しやすくする重み
   * 盤面汚染度は v5.2 で createSideView に追加した派生スカラー(boardPollution)。
   * 自爆は跡を消すので、汚れた盤面を自分で掃除する手にもなる。
   *
   * ⚠️ v5.4: 候補の条件を「寿命の消化**割合** `steps/life >= selfDestructAgeFrac`」から
   * 「残り**判断回数** `remainingTicks <= selfDestructRemainingTicks`」に変えた。
   * 割合だと種別ごとに絶対時間の意味が変わる(寿命20,000の攻撃と6,000の妨害で同じ0.9でも
   * 残りステップが2,000と600)うえ、CEM から見て「あと何回撃ち直せるか」という
   * 意思決定に直結する量になっていなかった。tick は判断周期そのものなので直結する。
   * 秒数ではなく DECISION_INTERVAL_STEPS を基準にする(STEPS_PER_SECOND は使わない)。
   *
   * ⚠️ 判定順も変えた(spec.md 機能「自爆」)。先に候補を数え、**候補が居るときだけ**
   * 確率抽選する。候補ゼロで rng を回すと、方策が違っても同じだけ乱数が進むという
   * 意味のない結合ができ、CRN での比較がぼやける。
   *
   * @returns {number} 消したアリの数(呼び出し元が flyingCount を補正するため)
   */
  function trySelfDestruct(view) {
    const ants = view.myAnts;
    if (ants.length === 0) return 0;

    // 1. 残り判断tickが閾値以下のアリを候補にし、同時に最も寿命を消化した1匹を選ぶ。
    // ⚠️ 既定値は 0(=閾値なし＝候補にならない)。旧 selfDestructAgeFrac は比較が
    // `>=` だったので既定 1 が「実質オフ」だったが、比較が `<=` に反転したので
    // 既定も反転する。ここを 1 のままにすると方策未指定で自爆が暴発する。
    const maxRemainingTicks = policy.selfDestructRemainingTicks ?? 0;
    let target = null;
    let bestAgeFrac = -1;
    for (const ant of ants) {
      const remainingSteps = Math.max(0, ant.life - ant.steps);
      const remainingTicks = Math.ceil(remainingSteps / C.DECISION_INTERVAL_STEPS);
      if (remainingTicks > maxRemainingTicks) continue;
      const ageFrac = ant.life > 0 ? ant.steps / ant.life : 1;
      if (ageFrac > bestAgeFrac) {
        bestAgeFrac = ageFrac;
        target = ant;
      }
    }
    // 2. 候補が0匹なら何もしない(乱数も消費しない)。
    if (!target) return 0;

    // 3〜4. 自爆確率を [0,1] にクランプして抽選する。
    const p = Math.min(
      1,
      Math.max(
        0,
        (policy.selfDestructBias ?? 0) +
          (policy.pollutionDestructWeight ?? 0) * (view.boardPollution ?? 0),
      ),
    );
    if (rng.next() >= p) return 0;

    // 5〜6. 候補中で最も寿命を消化している1匹を消す(engine 側で cleanupAnt が走る)。
    observe({ type: 'selfDestruct', antId: target.id, kind: target.kind, ageFrac: bestAgeFrac });
    selfDestruct(target.id);
    return 1;
  }

  return {
    decide(view) {
      // 発火済みの確保を解放してから、この判断で使えるトークンを確定する。
      releaseExpiredCommitments(view.step);
      avail = Math.max(0, view.tokens - committedTokens());

      // 自爆は飛行数上限の判定より前に行う(上限に達しているときこそ使いたい)。
      const destroyed = trySelfDestruct(view);
      if (view.flyingCount - destroyed >= C.MAX_FLYING) return null;

      return tryDefend(view) ?? tryEscort(view) ?? tryAttack(view) ?? null;
    },
    reset() {
      assignedIntercepts = new Set();
      escortedAtSteps = new Set();
      commitments = [];
      avail = 0;
    },
  };
}
