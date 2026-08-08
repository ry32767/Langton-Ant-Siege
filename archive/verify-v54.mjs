#!/usr/bin/env node
// CPU 方策 v5.4 差分仕様「第11章 学習後の検証」が要求する測定を行う、読み取り専用の検証スクリプト。
//
// なぜ必要か: v5.4 で observe() フックが追加され、CPU の意思決定の「意図」(攻撃/迎撃/護衛/自爆)
// が engine の外から観測できるようになった。学習(train-policy.mjs)は fitness だけを見て方策を
// 更新するが、§11 は「その方策が実際に何をしているか」(発射数の内訳・迎撃の成否・自爆の
// selfDestructRemainingTicks 依存性)を人間が読める形で確認することを求めている。
//
// このスクリプトは data/policy.json も src/cpu.js / src/engine.js / src/config.js も一切書き換えない。
// 標準出力に表を出すだけ(--out のような書き出しオプションは無い)。
//
// 乱数は createRng(seed) だけを使う(Math.random() は使わない)。数値定数は src/config.js から import する。
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as C from '../src/config.js';
import {
  createRng,
  createMatch,
  stepMatch,
  runMatch,
  scheduleFire as engineScheduleFire,
  selfDestruct as engineSelfDestruct,
  costOf,
} from '../src/engine.js';
import { createCpuAgent } from '../src/cpu.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_PATH = path.join(__dirname, '..', 'data', 'templates.json');
const POLICY_PATH = path.join(__dirname, '..', 'data', 'policy.json');

// ---------------------------------------------------------------------------
// CLI 引数(train-policy.mjs の argNum の流儀に合わせる)
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
function argNum(name, def) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= argv.length) return def;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) ? v : def;
}
const SEED = argNum('seed', 1);
const GAMES = argNum('games', 500);
const COMPARE_TICKS = argv.includes('--compare-ticks');
const COMPARE_DEFEND = argv.includes('--compare-defend');

// ---------------------------------------------------------------------------
// data/templates.json・data/policy.json の読み込み(読むだけ。書き出しはしない)
// ---------------------------------------------------------------------------
if (!existsSync(TEMPLATES_PATH)) {
  console.error(
    'data/templates.json が見つかりません。先に `node scripts/generate-templates.mjs` を実行してください。',
  );
  process.exit(1);
}
if (!existsSync(POLICY_PATH)) {
  console.error(
    'data/policy.json が見つかりません。先に `node scripts/train-policy.mjs` を実行してください。',
  );
  process.exit(1);
}
const templates = JSON.parse(readFileSync(TEMPLATES_PATH, 'utf8'));
const policyDoc = JSON.parse(readFileSync(POLICY_PATH, 'utf8'));
const trainedPolicy = policyDoc.policy;
if (!trainedPolicy) {
  console.error('data/policy.json に .policy が無い形式です。');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// deriveSeed: scripts/train-policy.mjs と同じ FNV-1a 風ハッシュの複製。
// train-policy.mjs はモジュールとして何も export していないため import できない。
// 「同じ試合シード列」を再現する CRN の要件上、同じアルゴリズムでなければ意味が無いので複製する。
// ---------------------------------------------------------------------------
function deriveSeed(...parts) {
  let h = 0x811c9dc5 >>> 0;
  for (const p of parts) {
    h ^= p >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h === 0 ? 1 : h >>> 0;
}

// ---------------------------------------------------------------------------
// RANDOM_POLICY: scripts/train-policy.mjs の同名定数の複製(train-policy.mjs は
// export していないため import できない)。「学習していない中立の初期方策」を
// vs RANDOM の対戦相手として使う、という定義を train-policy.mjs と一致させる。
// ---------------------------------------------------------------------------
const NUM_ATTACK = C.TEMPLATE_COUNT_ATTACK;
const RANDOM_POLICY = {
  fireThreshold: 0,
  reserveTokens: 0,
  defendBias: 0.5,
  escortBias: 0.5,
  attackPref: Array.from({ length: NUM_ATTACK }, () => 1),
  selfDestructBias: 0,
  selfDestructRemainingTicks: 0,
  pollutionDestructWeight: 0,
  attackAvoidBias: 0,
};

// ---------------------------------------------------------------------------
// 試合の実行(scripts/train-policy.mjs の makeAgent と同じ結線 + observe を追加)
// ---------------------------------------------------------------------------

// onDisruptFire は省略可(既存呼び出しに影響しない)。§29 の「妨害の平均コスト」計測用に、
// 発火直前の action(kind/cells を持つ)をそのまま横取りして観測するためのフック。
function makeAgent(getMatch, sideIndex, policy, rngSeed, observe, onDisruptFire) {
  const rng = createRng(rngSeed);
  return createCpuAgent({
    templates,
    policy,
    rng,
    scheduleFire: (action, atStep) => {
      if (onDisruptFire && action.kind === 'disrupt') onDisruptFire(action);
      return engineScheduleFire(getMatch(), sideIndex, action, atStep);
    },
    selfDestruct: (antId) => engineSelfDestruct(getMatch(), sideIndex, antId),
    observe: (event) => observe(sideIndex, event),
  });
}

/**
 * 1試合を手動ループ(stepMatch)で進め、observe イベントと「登場した全アリの参照」を記録する。
 *
 * ⚠️ アリは死ぬと side.ants 配列からは外れるが、オブジェクト自体(参照)は死んだ瞬間の
 * x/y/steps を保ったまま残る。stepMatch() 1回ごとに現在飛行中の全アリを antMap(id→参照)へ
 * 控えておけば、そのアリが「生まれてから初めて死ぬまでの間」に少なくとも1回は捕まえられる
 * (life は攻撃/妨害どちらも1よりずっと大きいので、生まれた直後の同じステップ内で
 * 即死することは無い)。
 */
// onDisruptFireA / onDisruptFireB は省略可(§28/§29 の妨害コスト計測を追加するための拡張。
// 既存の呼び出し元 [runSelfPlaySeries / runTicksCondition] は渡さないので挙動は変わらない)。
function playInstrumentedMatch(seed, policyA, policyB, onDisruptFireA, onDisruptFireB) {
  const match = createMatch({ seed });
  const events = []; // { sideIndex, type, ... }(observe がそのまま流してくる形に sideIndex を足したもの)
  const antMap = new Map(); // antId(match全体で一意) -> ant オブジェクト参照
  function observe(sideIndex, event) {
    events.push({ sideIndex, ...event });
  }
  match.sides[0].agent = makeAgent(() => match, 0, policyA, deriveSeed(seed, 1), observe, onDisruptFireA);
  match.sides[1].agent = makeAgent(() => match, 1, policyB, deriveSeed(seed, 2), observe, onDisruptFireB);

  while (match.phase !== 'finished') {
    stepMatch(match);
    for (const side of match.sides) {
      for (const ant of side.ants) antMap.set(ant.id, ant);
    }
  }
  return { match, events, antMap };
}

/** observe を使わない素の試合(vs RANDOM の勝率だけを測る経路。playMatch 相当)。 */
function playPlainMatch(seed, policyA, policyB) {
  const match = createMatch({ seed });
  match.sides[0].agent = makeAgent(() => match, 0, policyA, deriveSeed(seed, 1), () => {});
  match.sides[1].agent = makeAgent(() => match, 1, policyB, deriveSeed(seed, 2), () => {});
  runMatch(match);
  return { result: match.result, scores: [match.sides[0].score, match.sides[1].score] };
}

// ---------------------------------------------------------------------------
// 「迎撃対象になった敵攻撃アリが最終的に得点したか」の判定。
//
// ⚠️ src/engine.js の resolveAnt と**必ず同じ判定順**にすること
// (① y<0 消滅 → ② 妨害の中央超え → ③ 得点線(ゲート適用) → ④ 寿命、の順。AGENTS.md 参照)。
// まだ試合終了時点で飛行中(=側の ants 配列にまだ居る)なら「未決着」として区別する。
// ---------------------------------------------------------------------------
function classifyAntFate(match, ant, selfDestructedIds) {
  const side = match.sides[ant.sideIndex];
  const stillFlying = side.ants.some((a) => a.id === ant.id);
  if (stillFlying) return 'undecided';
  // ⚠️ 自爆で消されたアリは resolveAnt を一度も通らずに side.ants から外れる。
  // 迎撃対象を**持ち主自身が**自爆させた場合がこれに当たり、下の4条件のどれにも
  // 一致しないので判定不能になる(v5.4 で自爆が実際に使われるようになって初めて起きる)。
  // 迎撃が効いたのか相手が自分で捨てたのかを区別できない交絡なので、
  // 'notScored' に丸めず専用の区分にして**分母から除く**。
  if (selfDestructedIds.has(ant.id)) return 'selfDestructed';
  if (ant.y < 0) return 'notScored';
  if (ant.kind === 'disrupt' && ant.y >= C.DISRUPT_MAX_LOCAL_Y) return 'notScored';
  if (ant.y >= C.SCORE_LINE_Y) return C.isInScoreGate(ant.x) ? 'scored' : 'notScored';
  if (ant.steps >= ant.life) return 'notScored';
  // ここに来るのは「もう飛んでいないのに resolveAnt のどの死亡条件にも一致しない」場合で、
  // 上の判定順が engine.js の resolveAnt とズレていることを意味する。黙って丸めず即座に落とす。
  throw new Error(`classifyAntFate: resolveAnt のどの条件にも一致しないアリ(id=${ant.id})`);
}

// ---------------------------------------------------------------------------
// モード1: 学習済み方策どうしの自己対戦(§11 の発射数・迎撃成功率・自爆回数・得点差)
// ---------------------------------------------------------------------------
function runSelfPlaySeries(policy, games, seedBase) {
  let totalAttack = 0;
  let totalDefend = 0;
  let totalEscort = 0;
  let totalSelfDestruct = 0;
  let totalIntercepted = 0; // 迎撃対象が得点しなかった
  let totalNotIntercepted = 0; // 迎撃対象が得点した(迎撃失敗)
  let totalUndecided = 0; // 試合終了時点でまだ飛行中(分母から除く)
  let totalTargetSelfDestructed = 0; // 迎撃対象を持ち主が自爆させた(交絡。分母から除く)
  // ⚠️ 対照群。「迎撃された弾の得点率」は単独では効果の指標にならない(比較対象が無い)。
  // 迎撃されなかった弾の得点率と並べて初めて「迎撃に意味があるか」が言える。
  let defendedAttacks = 0;
  let defendedAttacksScored = 0;
  let undefendedAttacks = 0;
  let undefendedAttacksScored = 0;
  let totalAbsScoreDiff = 0;
  // v5.4 §28: テンプレート別の内訳(攻撃/妨害)。
  const attackFiredByTpl = new Map(); // templateId -> 発射数(決着未決も含む)
  const attackDecidedByTpl = new Map(); // templateId -> 決着がついた数(undecided/selfDestructedを除く分母)
  const attackScoredByTpl = new Map(); // templateId -> 得点した数
  const disruptFiredByTpl = new Map(); // templateId -> 迎撃+護衛の合計発射数
  let totalDisruptCost = 0; // 撃たれた妨害1件あたりのコストの総和(§28「妨害の平均コスト」用)
  let totalDisruptCount = 0;

  // onDisruptFire: 迎撃(defend)/護衛(escort)はどちらも action.kind==='disrupt' で
  // scheduleFire を経由するので、ここで横取りしてテンプレート別の発射数とコストを積算する。
  // 自己対戦(policyA===policyB)の両陣営合計を出す既存の集計方針に合わせ、両側で同じ関数を使う。
  const onDisruptFire = (action) => {
    const tid = action.templateId ?? null;
    if (tid != null) disruptFiredByTpl.set(tid, (disruptFiredByTpl.get(tid) ?? 0) + 1);
    totalDisruptCost += costOf(action.kind, action.cells.length);
    totalDisruptCount++;
  };

  for (let g = 0; g < games; g++) {
    const seed = deriveSeed(seedBase, g);
    const { match, events, antMap } = playInstrumentedMatch(
      seed,
      policy,
      policy,
      onDisruptFire,
      onDisruptFire,
    );
    // 自爆は迎撃(defend)より後のステップで起きることもあるので、先に全イベントを
    // 走査して「自爆で消えたアリID」を集めてから決着を判定する(1パスだと取りこぼす)。
    const selfDestructedIds = new Set();
    for (const ev of events) {
      if (ev.type === 'selfDestruct') selfDestructedIds.add(ev.antId);
    }

    for (const ev of events) {
      if (ev.type === 'attack') {
        totalAttack++;
      } else if (ev.type === 'escort') {
        totalEscort++;
      } else if (ev.type === 'selfDestruct') {
        totalSelfDestruct++;
      } else if (ev.type === 'defend') {
        totalDefend++;
        const targetAnt = antMap.get(ev.targetAntId);
        if (!targetAnt) {
          throw new Error(`defend の targetAntId=${ev.targetAntId} が antMap に見つからない`);
        }
        const fate = classifyAntFate(match, targetAnt, selfDestructedIds);
        if (fate === 'undecided') totalUndecided++;
        else if (fate === 'selfDestructed') totalTargetSelfDestructed++;
        else if (fate === 'scored') totalNotIntercepted++;
        else totalIntercepted++;
      }
    }
    // 対照群の集計: 登場した全**攻撃**アリを「迎撃を割り当てられたか」で二分し、
    // それぞれの得点率を出す(自爆・未決着は交絡なので両群から除く)。
    const defendedIds = new Set();
    for (const ev of events) {
      if (ev.type === 'defend') defendedIds.add(ev.targetAntId);
    }
    for (const ant of antMap.values()) {
      if (ant.kind !== 'attack') continue;
      const tid = ant.templateId ?? null;
      if (tid != null) attackFiredByTpl.set(tid, (attackFiredByTpl.get(tid) ?? 0) + 1);
      const fate = classifyAntFate(match, ant, selfDestructedIds);
      if (fate === 'undecided' || fate === 'selfDestructed') continue;
      if (tid != null) {
        attackDecidedByTpl.set(tid, (attackDecidedByTpl.get(tid) ?? 0) + 1);
        if (fate === 'scored') attackScoredByTpl.set(tid, (attackScoredByTpl.get(tid) ?? 0) + 1);
      }
      if (defendedIds.has(ant.id)) {
        defendedAttacks++;
        if (fate === 'scored') defendedAttacksScored++;
      } else {
        undefendedAttacks++;
        if (fate === 'scored') undefendedAttacksScored++;
      }
    }
    totalAbsScoreDiff += Math.abs(match.sides[0].score - match.sides[1].score);
  }

  return {
    games,
    attackPerGame: totalAttack / games,
    defendPerGame: totalDefend / games,
    escortPerGame: totalEscort / games,
    selfDestructPerGame: totalSelfDestruct / games,
    interceptDenominator: totalDefend - totalUndecided - totalTargetSelfDestructed,
    interceptSuccess: totalIntercepted,
    interceptFail: totalNotIntercepted,
    undecided: totalUndecided,
    targetSelfDestructed: totalTargetSelfDestructed,
    interceptSuccessRate:
      totalDefend - totalUndecided - totalTargetSelfDestructed > 0
        ? totalIntercepted / (totalDefend - totalUndecided - totalTargetSelfDestructed)
        : null,
    avgAbsScoreDiff: totalAbsScoreDiff / games,
    defendedAttacks,
    defendedScoreRate: defendedAttacks > 0 ? defendedAttacksScored / defendedAttacks : null,
    undefendedAttacks,
    undefendedScoreRate: undefendedAttacks > 0 ? undefendedAttacksScored / undefendedAttacks : null,
    attackFiredByTpl,
    attackDecidedByTpl,
    attackScoredByTpl,
    disruptFiredByTpl,
    avgDisruptCost: totalDisruptCount > 0 ? totalDisruptCost / totalDisruptCount : null,
  };
}

// ---------------------------------------------------------------------------
// モード1: 学習済み方策 vs RANDOM_POLICY(勝率・得点差)。scripts/train-policy.mjs の
// evaluate() と同じ流儀(先手有利を均すため試合ごとに side を入れ替え、CRN で比較する)。
// ---------------------------------------------------------------------------
function evaluateVsRandom(policy, games, seedBase) {
  let winTotal = 0;
  let scoreDiffTotal = 0;
  for (let g = 0; g < games; g++) {
    const matchSeed = deriveSeed(seedBase, g);
    const individualIsSide1 = g % 2 === 0;
    const policyA = individualIsSide1 ? policy : RANDOM_POLICY;
    const policyB = individualIsSide1 ? RANDOM_POLICY : policy;
    const { result, scores } = playPlainMatch(matchSeed, policyA, policyB);
    let outcome;
    if (result === 'draw') outcome = 0.5;
    else {
      const individualWon =
        (individualIsSide1 && result === 'side1') || (!individualIsSide1 && result === 'side2');
      outcome = individualWon ? 1 : 0;
    }
    winTotal += outcome;
    const individualScore = individualIsSide1 ? scores[0] : scores[1];
    const opponentScore = individualIsSide1 ? scores[1] : scores[0];
    scoreDiffTotal += individualScore - opponentScore;
  }
  return { winRate: winTotal / games, avgScoreDiff: scoreDiffTotal / games };
}

// ---------------------------------------------------------------------------
// モード2(--compare-ticks): selfDestructRemainingTicks ∈ {1,5,10} の CRN 比較。
// 3条件とも同じ試合シード列(deriveSeed(seedBase, g))・同じ相手(RANDOM_POLICY)・
// 同じ側の入れ替えパターン(g%2)を使う。差はポリシーの selfDestructRemainingTicks だけ。
// ---------------------------------------------------------------------------
function runTicksCondition(candidatePolicy, games, seedBase) {
  let totalSelfDestruct = 0;
  let winTotal = 0;
  let scoreDiffTotal = 0;
  for (let g = 0; g < games; g++) {
    const matchSeed = deriveSeed(seedBase, g);
    const individualIsSide1 = g % 2 === 0;
    const individualSideIndex = individualIsSide1 ? 0 : 1;
    const policyA = individualIsSide1 ? candidatePolicy : RANDOM_POLICY;
    const policyB = individualIsSide1 ? RANDOM_POLICY : candidatePolicy;
    const { match, events } = playInstrumentedMatch(matchSeed, policyA, policyB);
    for (const ev of events) {
      if (ev.type === 'selfDestruct' && ev.sideIndex === individualSideIndex) totalSelfDestruct++;
    }
    const result = match.result;
    let outcome;
    if (result === 'draw') outcome = 0.5;
    else {
      const individualWon =
        (individualIsSide1 && result === 'side1') || (!individualIsSide1 && result === 'side2');
      outcome = individualWon ? 1 : 0;
    }
    winTotal += outcome;
    const individualScore = individualIsSide1 ? match.sides[0].score : match.sides[1].score;
    const opponentScore = individualIsSide1 ? match.sides[1].score : match.sides[0].score;
    scoreDiffTotal += individualScore - opponentScore;
  }
  return {
    games,
    selfDestructPerGame: totalSelfDestruct / games,
    winRate: winTotal / games,
    avgScoreDiff: scoreDiffTotal / games,
  };
}

// ---------------------------------------------------------------------------
// モード3(--compare-defend): 「迎撃するほど負ける」を恒久測定にする(v5.4 追加差分仕様 §29)。
//
// なぜこのモードがあるか: §29 は、コスト体系(妨害の baseCost 等)を変更する前後で
// この比較を再実行し、変更が「迎撃するほど負ける」を緩和したかどうかを数値で確認することを
// 要求している。今回はコスト体系の変更**前**の基準値を、同じコードパス・同じ試合シード列で
// 固定しておくために実装する(この直後にテンプレート数とコスト体系が変わる予定)。
//
// RANDOM_POLICY(中立方策)を複製し defendBias だけ 0.0 / 0.5 / 1.0 に振ったものを
// アンカーとして、学習済み方策(data/policy.json)と対戦させる。3条件は同一の試合シード列
// (deriveSeed(seedBase, g)、seedBase に条件の添字を混ぜない CRN)を使い、試合ごとに
// 先手・後手を入れ替える。
//
// 「妨害の平均コスト」: アンカーが撃った迎撃(defend)+護衛(escort)はどちらも
// action.kind === 'disrupt' で発火されるので(src/cpu.js の tryDefend/tryEscort は
// どちらも toAction('disrupt', ...) を経由する)、makeAgent の scheduleFire フックで
// action を横取りし、engine.js の costOf(既存の一元化された関数。式はここに書かない)を
// そのまま呼んで積算する。
// ---------------------------------------------------------------------------
function runDefendBiasCondition(defendBias, games, seedBase, opponentPolicy) {
  const candidatePolicy = { ...RANDOM_POLICY, defendBias };
  let totalAttack = 0;
  let totalDefend = 0;
  let totalEscort = 0;
  let totalDisruptCost = 0;
  let totalDisruptCount = 0;
  let anchorScoreTotal = 0;
  let opponentScoreTotal = 0;
  let anchorWinTotal = 0;

  for (let g = 0; g < games; g++) {
    const matchSeed = deriveSeed(seedBase, g);
    // ⚠️ 使い捨てスクリプトの基準値に合わせる: アンカー側は g%2===0 ? 1 : 0
    // (g%2===0 のときアンカーは sideIndex=1。モード1/モード2の g%2===0→side0 とは逆)。
    const anchorSideIndex = g % 2 === 0 ? 1 : 0;
    const anchorIsSide1 = anchorSideIndex === 0;
    const policyA = anchorIsSide1 ? candidatePolicy : opponentPolicy;
    const policyB = anchorIsSide1 ? opponentPolicy : candidatePolicy;
    const onAnchorDisruptFire = (action) => {
      totalDisruptCost += costOf(action.kind, action.cells.length);
      totalDisruptCount++;
    };
    const onDisruptFireA = anchorIsSide1 ? onAnchorDisruptFire : undefined;
    const onDisruptFireB = anchorIsSide1 ? undefined : onAnchorDisruptFire;
    const { match, events } = playInstrumentedMatch(
      matchSeed,
      policyA,
      policyB,
      onDisruptFireA,
      onDisruptFireB,
    );

    for (const ev of events) {
      if (ev.sideIndex !== anchorSideIndex) continue;
      if (ev.type === 'attack') totalAttack++;
      else if (ev.type === 'defend') totalDefend++;
      else if (ev.type === 'escort') totalEscort++;
    }

    const anchorScore = anchorIsSide1 ? match.sides[0].score : match.sides[1].score;
    const opponentScore = anchorIsSide1 ? match.sides[1].score : match.sides[0].score;
    anchorScoreTotal += anchorScore;
    opponentScoreTotal += opponentScore;

    const result = match.result;
    let outcome;
    if (result === 'draw') outcome = 0.5;
    else {
      const anchorWon = (anchorIsSide1 && result === 'side1') || (!anchorIsSide1 && result === 'side2');
      outcome = anchorWon ? 1 : 0;
    }
    anchorWinTotal += outcome;
  }

  return {
    defendBias,
    games,
    attackPerGame: totalAttack / games,
    defendPerGame: totalDefend / games,
    escortPerGame: totalEscort / games,
    avgDisruptCost: totalDisruptCount > 0 ? totalDisruptCost / totalDisruptCount : null,
    anchorScorePerGame: anchorScoreTotal / games,
    opponentScorePerGame: opponentScoreTotal / games,
    anchorWinRate: anchorWinTotal / games,
    opponentWinRate: 1 - anchorWinTotal / games, // 引き分けは両者0.5扱いなので合計は必ず1
  };
}

/**
 * 対照群: 「相手も学習済み方策(自己対戦)」の勝率だけを測る。0.5付近でなければ
 * 結線がおかしい(§29 の注記どおり)。playPlainMatch を使い observe は取らない。
 */
function runSelfPlayControlWinRate(policy, games, seedBase) {
  let winTotal = 0;
  for (let g = 0; g < games; g++) {
    const matchSeed = deriveSeed(seedBase, g);
    const anchorIsSide1 = g % 2 === 0;
    const { result } = playPlainMatch(matchSeed, policy, policy);
    let outcome;
    if (result === 'draw') outcome = 0.5;
    else {
      const anchorWon = (anchorIsSide1 && result === 'side1') || (!anchorIsSide1 && result === 'side2');
      outcome = anchorWon ? 1 : 0;
    }
    winTotal += outcome;
  }
  return winTotal / games;
}

// ---------------------------------------------------------------------------
// 出力
// ---------------------------------------------------------------------------
function fmt(n, digits = 3) {
  return n === null || n === undefined ? 'N/A' : n.toFixed(digits);
}

function printHeader(title) {
  console.log('');
  console.log(`=== ${title} ===`);
}

if (!COMPARE_TICKS && !COMPARE_DEFEND) {
  printHeader(`v5.4 §11 検証(モード1: 学習済み方策の計測) games=${GAMES} seed=${SEED}`);
  console.log(`policy.json trainedAt = ${policyDoc.trainedAt ?? 'N/A'}`);

  const selfPlaySeedBase = deriveSeed(SEED, 0x51); // 'self-play' 用の分岐(vs RANDOM とは別シード列)
  const stats = runSelfPlaySeries(trainedPolicy, GAMES, selfPlaySeedBase);

  console.log('');
  console.log('[自己対戦(学習済み方策 vs 学習済み方策)・両陣営合計 1試合あたり平均]');
  console.log(`  attack shots / match          : ${fmt(stats.attackPerGame)}`);
  console.log(`  defense disrupt shots / match  : ${fmt(stats.defendPerGame)}`);
  console.log(`  escort shots / match           : ${fmt(stats.escortPerGame)}`);
  console.log(`  self destructs / match         : ${fmt(stats.selfDestructPerGame)}`);
  console.log(`  平均得点差(|score0-score1|)   : ${fmt(stats.avgAbsScoreDiff)}`);
  console.log('');
  console.log('[successful interceptions(迎撃対象が最終的に得点しなかった件数)]');
  console.log(`  迎撃(defend)発射の総数         : ${stats.defendPerGame * GAMES}`);
  console.log(`  うち試合終了時点で未決着(除外) : ${stats.undecided}`);
  console.log(`  うち対象を持ち主が自爆(除外)   : ${stats.targetSelfDestructed}`);
  console.log(`  分母(決着がついた迎撃の総数)   : ${stats.interceptDenominator}`);
  console.log(`  迎撃成功(対象アリが得点せず)   : ${stats.interceptSuccess}`);
  console.log(`  迎撃失敗(対象アリが得点した)   : ${stats.interceptFail}`);
  console.log(`  迎撃成功率                     : ${fmt(stats.interceptSuccessRate)}`);
  console.log(`  successful interceptions / match: ${fmt(stats.interceptSuccess / GAMES)}`);
  console.log('');
  console.log('[対照つきの効果測定: 迎撃された弾 vs されなかった弾の得点率]');
  console.log(`  迎撃された攻撃アリ   : ${stats.defendedAttacks} 件 / 得点率 ${fmt(stats.defendedScoreRate)}`);
  console.log(`  迎撃されなかった攻撃 : ${stats.undefendedAttacks} 件 / 得点率 ${fmt(stats.undefendedScoreRate)}`);
  const lift =
    stats.defendedScoreRate != null && stats.undefendedScoreRate != null
      ? stats.undefendedScoreRate - stats.defendedScoreRate
      : null;
  console.log(`  差(されなかった − された) = ${lift == null ? 'N/A' : fmt(lift)}`);
  console.log('  ⚠️ 正なら迎撃は得点を減らせている。0以下なら迎撃は効果が無い(または狙う相手の選び方に偏りがある)。');

  // v5.4 §28: テンプレート別の内訳。data/templates.json の attack/disrupt 配列から
  // 動的に行を作る(テンプレート数を決め打ちしない。旧9種でも新3+3でもそのまま動く)。
  console.log('');
  console.log('[テンプレート別内訳: 攻撃]');
  console.log('  id | role | cost | 発射回数/試合 | 得点率');
  console.log('  ---|------|------|----------------|-------');
  for (const tpl of templates.attack ?? []) {
    const fired = stats.attackFiredByTpl.get(tpl.id) ?? 0;
    const decided = stats.attackDecidedByTpl.get(tpl.id) ?? 0;
    const scored = stats.attackScoredByTpl.get(tpl.id) ?? 0;
    const scoreRate = decided > 0 ? scored / decided : null;
    console.log(
      `  ${tpl.id} | ${tpl.role ?? '-'} | ${tpl.cost} | ${fmt(fired / GAMES, 3)} | ${fmt(scoreRate)}`,
    );
  }

  console.log('');
  console.log('[テンプレート別内訳: 妨害(迎撃+護衛の合計)]');
  console.log('  id | role | cost | 発射回数/試合');
  console.log('  ---|------|------|----------------');
  for (const tpl of templates.disrupt ?? []) {
    const fired = stats.disruptFiredByTpl.get(tpl.id) ?? 0;
    console.log(`  ${tpl.id} | ${tpl.role ?? '-'} | ${tpl.cost} | ${fmt(fired / GAMES, 3)}`);
  }
  console.log(`  妨害の平均コスト(実際に撃たれた1件あたり): ${fmt(stats.avgDisruptCost, 2)}`);

  const vsRandomSeedBase = deriveSeed(SEED, 0x52); // 'vs random' 用の別シード列(自己対戦と混ぜない)
  const vsRandom = evaluateVsRandom(trainedPolicy, GAMES, vsRandomSeedBase);
  console.log('');
  console.log('[学習済み方策 vs RANDOM_POLICY(先手/後手を試合ごとに入れ替えて計測)]');
  console.log(`  winRate vs RANDOM               : ${fmt(vsRandom.winRate)}`);
  console.log(`  平均得点差(自分-相手, vs RANDOM): ${fmt(vsRandom.avgScoreDiff)}`);
} else if (COMPARE_TICKS) {
  printHeader(`v5.4 §11 検証(モード2: --compare-ticks CRN比較) games=${GAMES} seed=${SEED}`);
  const ticksValues = [1, 5, 10];
  const seedBase = deriveSeed(SEED, 0xc0); // 3条件共通(CRN: シードに条件の添字を混ぜない)

  const rows = ticksValues.map((ticks) => {
    const candidatePolicy = { ...trainedPolicy, selfDestructRemainingTicks: ticks };
    const res = runTicksCondition(candidatePolicy, GAMES, seedBase);
    return { ticks, ...res };
  });

  console.log('');
  console.log(
    '  selfDestructRemainingTicks | self destructs/match | winRate vs RANDOM | avgScoreDiff vs RANDOM',
  );
  console.log(
    '  ---------------------------|-----------------------|--------------------|------------------------',
  );
  for (const row of rows) {
    console.log(
      `  ${String(row.ticks).padStart(26)} | ${fmt(row.selfDestructPerGame).padStart(21)} | ${fmt(
        row.winRate,
      ).padStart(18)} | ${fmt(row.avgScoreDiff).padStart(22)}`,
    );
  }
  console.log('');
  console.log('  ⚠️ 3条件は同一の試合シード列(CRN)・同一の相手(RANDOM_POLICY)を使っている。');
  console.log('     差が出ていれば selfDestructRemainingTicks の値そのものが fitness に効いている証拠。');
} else {
  // モード3(--compare-defend): v5.4 追加差分仕様 §29。「迎撃するほど負ける」の恒久測定。
  printHeader(`v5.4 §29 検証(モード3: --compare-defend CRN比較) games=${GAMES} seed=${SEED}`);
  const defendBiasValues = [0.0, 0.5, 1.0];
  // ⚠️ 使い捨てスクリプトが seedBase = deriveSeed(1, 0x52) を使っていたため、それに合わせる
  // (モード1の vsRandomSeedBase と同じ 0x52 という分岐定数を、相手を RANDOM_POLICY から
  // trainedPolicy に差し替えて再利用している)。
  const seedBase = deriveSeed(SEED, 0x52); // 3条件共通(CRN: シードに条件の添字を混ぜない)

  const rows = defendBiasValues.map((defendBias) =>
    runDefendBiasCondition(defendBias, GAMES, seedBase, trainedPolicy),
  );

  console.log('');
  console.log(
    '  defendBias | 攻撃/試合 | 迎撃/試合 | 護衛/試合 | 妨害の平均コスト | アンカー得点 | 相手得点 | 相手(学習済み方策)勝率',
  );
  console.log(
    '  -----------|-----------|-----------|-----------|------------------|--------------|----------|------------------------',
  );
  for (const row of rows) {
    console.log(
      `  ${String(row.defendBias).padStart(10)} | ${fmt(row.attackPerGame, 2).padStart(9)} | ${fmt(
        row.defendPerGame,
        2,
      ).padStart(9)} | ${fmt(row.escortPerGame, 2).padStart(9)} | ${fmt(row.avgDisruptCost, 2).padStart(
        16,
      )} | ${fmt(row.anchorScorePerGame, 2).padStart(12)} | ${fmt(row.opponentScorePerGame, 2).padStart(
        8,
      )} | ${fmt(row.opponentWinRate, 3).padStart(22)}`,
    );
  }

  const controlSeedBase = deriveSeed(SEED, 0x53); // 対照(自己対戦)専用の別シード列
  const controlWinRate = runSelfPlayControlWinRate(trainedPolicy, GAMES, controlSeedBase);
  console.log('');
  console.log(`  [対照] 学習済み方策どうしの自己対戦の勝率(アンカー視点): ${fmt(controlWinRate)}`);
  console.log('  ⚠️ この値が0.5付近でなければ結線がおかしい(先手/後手入れ替え・勝敗判定を疑うこと)。');
  console.log('');
  console.log('  ⚠️ 3条件は同一の試合シード列(CRN)・同一の相手(学習済み方策)を使っている。');
  console.log('     妨害の平均コストは engine.js の costOf(既存の一元化関数)で計算している。');
}
