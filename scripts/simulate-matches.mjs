#!/usr/bin/env node
// バランス診断ハーネス。docs/spec.md「バランス指標(simulate-matches.mjs の合格ライン)」準拠。
//
// 1) CPU vs CPU の試合を --games 回シミュレーションし、得点・試合時間・勝率・盤面汚染度などを集計する。
// 2) さらに攻撃/迎撃/護衛の性能を個別に測定する(得点率・ハイウェイ割合・カウンター密度・突破率)。
// 3) §29 の追加レポート項目(観測のみ。合否判定には使わない)を集計する。
//
// 数値の合格レンジはすべて src/config.js の BALANCE から読む(ここに数値をハードコードしない)。
// 乱数は createRng(seed) だけを使う(Math.random() 禁止)。同じ --seed なら出力が完全に一致する。
//
// v4(MAP-Elites 版)追従メモ:
//   - 盤面が90度回転し、攻撃軸は y(C.SCORE_LINE_Y)、配置帯は y=0..15、ラップは左右(x)になった。
//   - グローバル定数 C.RULE / C.COLORS / C.PLACED_CELL_STATE / C.SCORE_LINE_X /
//     C.HIGHWAY_PERIOD / C.HIGHWAY_ONSET_STEP は廃止された(このファイルに残っていた参照はすべて除去済み)。
//   - テンプレートの cells は [x, y, state] の3要素、rule / colorCount をテンプレートごとに持つ。
//   - ハイウェイ判定は自前で周期検出を書かず、src/search/highway-detector.js の
//     detectHighwayFromPath を使う。ただしこの関数は「x はラップしていない絶対座標」を要求する
//     (呼び出し側の責務、と同ファイルの docstring に明記)ため、渡す前に unwrapPath() で
//     トーラスのラップを展開する。
//
// v5(発射列可変化)追従メモ:
//   - 盤面 256×256、ZONE_DEPTH=32、得点ライン y=224、STEPS_PER_SECOND=300、
//     ATTACK_LIFE=6000、DISRUPT_LIFE=1000(すべて src/config.js から読む)。
//   - 得点ゲート(C.isInScoreGate)導入。敵陣到達(reached)だけでは得点にならず、到達時の x が
//     ゲート内(32〜224)でなければ得点しない(scored)。simulateSolo/simulateVersus は
//     scored と reached を両方返す。
//   - テンプレートの cells は **アリからの相対 [dx, dy, state]**(絶対座標ではない)。
//     絶対座標の action に直すには src/template.js の instantiateTemplate(template, antX) を通す。
//   - identifyTable のキーは "antY,antDir"(antX は可変になったのでキーから外れた)。
//   - counterTable[attackId] の要素は { disruptId, deltaX, fireAtStep, successRate }。
//     escortTable[attackId][interceptId] の要素は
//     { interceptDeltaX, interceptFireAtStep, escortDisruptId, escortDeltaX, fireAtStep }。
//     迎撃/護衛の発射列は wrapX(攻撃の発射列 + deltaX) で決める。
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as C from '../src/config.js';
import {
  createRng,
  createMatch,
  stepMatch,
  getStats,
  scheduleFire as engineScheduleFire,
  selfDestruct as engineSelfDestruct,
  simulateSolo,
  simulateVersus,
  toGlobalY,
  instantiateTemplate,
} from '../src/engine.js';
import { wrapX, scoringLaunchColumns } from '../src/template.js';
import { detectHighwayFromPath } from '../src/search/highway-detector.js';
import { buildCounterMatrix, buildEscortTable } from '../src/search/evaluate-interaction.js';
import { createCpuAgent } from '../src/cpu.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_PATH = path.join(__dirname, '..', 'data', 'templates.json');
const POLICY_PATH = path.join(__dirname, '..', 'data', 'policy.json');

// ---------------------------------------------------------------------------
// CLI 引数
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
function argNum(name, def) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= argv.length) return def;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) ? v : def;
}
const GAMES = argNum('games', 1000);
const SEED = argNum('seed', 1);
// data/templates.json はまだ旧スキーマ(v3.1)のままの場合がある。新スキーマ移行後の動作を
// エラーなく検証するための最小合成テンプレート(攻撃2種・妨害2種)へのフォールバック。
// 旧 data/templates.json は書き換えない。
const SYNTHETIC = argv.includes('--synthetic');

const T0 = process.hrtime.bigint();
function elapsedSec() {
  return Number(process.hrtime.bigint() - T0) / 1e9;
}

// ---------------------------------------------------------------------------
// 決定論的な乱数ユーティリティ(train-policy.mjs と同じ方式)
// ---------------------------------------------------------------------------

/** 複数の整数から決定論的な32bit非ゼロシードを作る(単純ハッシュ)。 */
function deriveSeed(...parts) {
  let h = 0x811c9dc5 >>> 0; // FNV-1a 風
  for (const p of parts) {
    h ^= p >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h === 0 ? 1 : h >>> 0;
}

// ---------------------------------------------------------------------------
// 新スキーマの最小合成テンプレート(--synthetic)
// 攻撃2種・妨害2種。counterTable / escortTable は src/search/evaluate-interaction.js の
// buildCounterMatrix / buildEscortTable(generate-templates.mjs の本番選抜と同じ参照実装)を
// そのまま使って計算する(ロジックを重複実装しない)。
//
// v5: テンプレートは antX を持たない。cells は**アリからの相対 [dx, dy, state]**
// (config.js の TEMPLATE_CELL_RADIUS=8 以内)。identifyTable のキーは "antY,antDir"。
// ---------------------------------------------------------------------------
function buildSyntheticTemplates() {
  const attack = [
    {
      id: 'SA1',
      rule: 'RRL',
      colorCount: 3,
      cells: [[0, 0, 1]],
      antY: 30,
      antDir: C.DIR_RIGHT,
      kind: 'attack',
      cost: C.ATTACK_COST + 1,
    },
    {
      id: 'SA2',
      rule: 'RRL',
      colorCount: 3,
      cells: [[1, 1, 1]],
      antY: 30,
      antDir: C.DIR_RIGHT,
      kind: 'attack',
      cost: C.ATTACK_COST + 1,
    },
  ];
  const disrupt = [
    {
      id: 'SD1',
      rule: 'RL',
      colorCount: 2,
      cells: [[2, 5, 1]],
      antY: 8,
      antDir: C.DIR_DOWN,
      kind: 'disrupt',
      cost: C.DISRUPT_COST + 1,
    },
    {
      id: 'SD2',
      rule: 'RL',
      colorCount: 2,
      cells: [[-2, 5, 1]],
      antY: 8,
      antDir: C.DIR_DOWN,
      kind: 'disrupt',
      cost: C.DISRUPT_COST + 1,
    },
  ];

  // entryXAt0: 発射列0で撃ったときの到達列(scoringLaunchColumns / cpu.js の tryAttack が
  // 参照する)。無いと得点ゲートに入る列が計算できず、CPU が攻撃候補から外してしまう。
  for (const a of attack) {
    const r = simulateSolo(instantiateTemplate(a, 0));
    a.entryXAt0 = r.reached ? r.entryX : null;
  }

  const identifyTable = {};
  for (const a of attack) identifyTable[`${a.antY},${a.antDir}`] = a.id;

  // deltaX の全256列掃引は --synthetic 用の最小フィクスチャには過剰なので、
  // generate-templates.mjs の共進化中の近似と同じ考え方で COEVO_DELTA_X_STRIDE 刻みの
  // 粗いグリッドにする(本番の9×9選抜だけが全列を掃引する。config.js のコメント参照)。
  const deltaXs = Array.from(
    { length: Math.ceil(C.WIDTH / C.COEVO_DELTA_X_STRIDE) },
    (_, i) => i * C.COEVO_DELTA_X_STRIDE,
  );

  const { counterTable } = buildCounterMatrix(attack, disrupt, { deltaXs });
  const escortTable = buildEscortTable(attack, disrupt, counterTable, { escortDeltaXs: deltaXs });

  return { attack, disrupt, identifyTable, counterTable, escortTable };
}

// ---------------------------------------------------------------------------
// 入力読み込み
// ---------------------------------------------------------------------------
let templates;
if (SYNTHETIC) {
  console.error('[--synthetic] data/templates.json を使わず、新スキーマの最小合成テンプレート(攻撃2種・妨害2種)を使う。');
  templates = buildSyntheticTemplates();
} else {
  if (!existsSync(TEMPLATES_PATH)) {
    console.error(
      'data/templates.json が見つかりません。先に `node scripts/generate-templates.mjs` を実行するか、`--synthetic` を付けて実行してください。',
    );
    process.exit(1);
  }
  templates = JSON.parse(readFileSync(TEMPLATES_PATH, 'utf8'));
  const firstAttack = (templates.attack ?? [])[0];
  if (firstAttack && !('rule' in firstAttack)) {
    console.error(
      '⚠️ data/templates.json は旧スキーマ(v3.1、rule/colorCount フィールドなし)のまま。' +
        ' 新スキーマでの検証には `--synthetic` を付けて実行してください。' +
        ' このまま処理は続行するが、配置マスが新しい配置帯(y=0..15)の外にある可能性が高く、数値は参考にならない。',
    );
  } else if (firstAttack && (templates.schemaVersion !== 5 || 'antX' in firstAttack)) {
    // v5(schemaVersion:5)は cells が相対座標で、テンプレートごとの antX を持たない
    // (generate-templates.mjs の templatesOutput 参照)。'antX' が残っている、または
    // schemaVersion が無い/5でない場合は v5 以前(旧v4など)の生成物とみなす。
    console.error(
      '⚠️ data/templates.json は v5 スキーマ(schemaVersion:5、cells が相対座標、antX/entryXAt0 あり)ではない可能性が高い' +
        `(検出: schemaVersion=${templates.schemaVersion ?? '無し'}, antX=${'antX' in firstAttack ? 'あり' : '無し'})。` +
        ' `node scripts/generate-templates.mjs` で再生成するか、`--synthetic` を付けて実行してください。' +
        ' このまま処理は続行するが、cells を相対座標として絶対座標に変換するため配置が壊れ、数値は参考にならない。',
    );
  }
}
const attackTemplates = templates.attack ?? [];
const disruptTemplates = templates.disrupt ?? [];
const disruptById = new Map(disruptTemplates.map((d) => [d.id, d]));
const counterTable = templates.counterTable ?? {};
const escortTable = templates.escortTable ?? {};

// data/policy.json が無ければ中立方策(仕様書の指示どおりの既定値)を使う。
// ⚠️ v5.4 で方策は17次元になった(disruptAimOffsetFrac 削除、selfDestructAgeFrac →
// selfDestructRemainingTicks)。ここは「学習前の既定値」なので、自爆の2つは
// **意図的に「自爆しない」設定**にしてある(selfDestructBias=0, selfDestructRemainingTicks=0
// =候補になるアリが存在しない)。学習済みの方策と比べたときに「自爆を覚えたかどうか」が
// 差として見えるようにするため。attackAvoidBias も同じ流儀で「新機能を使わない既定値」にしてある。
const NEUTRAL_POLICY = Object.freeze({
  fireThreshold: 8,
  reserveTokens: 6,
  defendBias: 0.7,
  escortBias: 0.5,
  attackPref: Array.from({ length: C.TEMPLATE_COUNT_ATTACK }, () => 1.0),
  selfDestructBias: 0,
  selfDestructRemainingTicks: 0, // 値域は1..10だが「自爆しない」既定値として意図的に範囲外の0を使う
  pollutionDestructWeight: 0,
  attackAvoidBias: 0, // 盤面を見ない一様選択(既定挙動)
});

let policy;
let policyNote;
if (existsSync(POLICY_PATH)) {
  const raw = JSON.parse(readFileSync(POLICY_PATH, 'utf8'));
  policy = raw.policy;
  policyNote = `data/policy.json を使用(学習済み・trainedAt=${raw.trainedAt ?? '不明'}・matches=${raw.matches ?? '?'})`;
} else {
  policy = NEUTRAL_POLICY;
  policyNote = 'data/policy.json が見つからないため中立方策を使用(fireThreshold=8, reserveTokens=6, defendBias=0.7, escortBias=0.5, attackPref=全1.0)';
}

console.log(`Langton Ant Siege バランス診断: games=${GAMES} seed=${SEED}${SYNTHETIC ? ' (--synthetic)' : ''}`);
console.log(`方策: ${policyNote}`);
console.log('');

// ---------------------------------------------------------------------------
// ハイウェイ判定共通ヘルパ
// ---------------------------------------------------------------------------

/**
 * x がトーラスでラップする軌跡を展開する(絶対座標に直す)。
 * detectHighwayFromPath は「x はラップしていない絶対座標。巻き戻しは呼び出し側の責務」と
 * 明記しているため、simulateSolo/simulateVersus の path([x,y] or [x,y,dir])を渡す前に必ず通す。
 */
function unwrapPath(path) {
  if (!Array.isArray(path) || path.length === 0) return path;
  const out = [path[0].slice()];
  let ux = path[0][0];
  for (let i = 1; i < path.length; i++) {
    let dx = path[i][0] - path[i - 1][0];
    if (dx > C.WIDTH / 2) dx -= C.WIDTH;
    else if (dx < -C.WIDTH / 2) dx += C.WIDTH;
    ux += dx;
    const p = path[i].slice();
    p[0] = ux;
    out.push(p);
  }
  return out;
}

function detectHighway(rawPath) {
  return detectHighwayFromPath(unwrapPath(rawPath));
}

// ---------------------------------------------------------------------------
// 1) 試合シミュレーション(CPU vs CPU、--games 回)
//    §29-1(ルール長分布)・§29-5(異種rule衝突率)もここで一緒に集計する。
// ---------------------------------------------------------------------------

// §29-1: 実際に発射された弾のルール長のヒストグラム。 rule 未指定なら engine の既定
// (C.LEGACY_RULE)が使われるため、その長さで数える。
const ruleLengthHist = {};
function recordRuleLength(action) {
  if (!action) return;
  const len = action.rule ? action.rule.length : C.LEGACY_RULE.length;
  ruleLengthHist[len] = (ruleLengthHist[len] ?? 0) + 1;
}

// §29(新規): 予約発射の消化率。scheduleFire() された回数(予約数)と、自爆(selfDestruct)の
// 呼び出し回数・成功回数を数える。
//
// ⚠️ engine.js の side.fired(getStats() の st.fired)は「scheduleFire 経由で予約が
// 満期を迎えて発火した回数」と「decide() が即座に返したアクションがその場で fire() された
// 回数」の両方を合算したものなので、これをそのまま「予約の消化数」として使うと分母
// (scheduleFire 呼び出し回数)より大きくなってしまう(即時発射ぶんが混ざるため)。
// そこで decide() が非nullを返した回数(即時発射の回数)を別に数え、
// st.fired からその分を差し引いた値を「予約が満期を迎えて実際に発火した回数」の推定値とする
// (engine.js を編集できないため、呼び出し側だけで完結させる近似)。
let sumScheduleFireCalls = 0;
let sumImmediateFireCalls = 0;
let sumSelfDestructCalls = 0;
let sumSelfDestructSuccess = 0;

/** CPU エージェントを作り、発射した kind ごとの回数を counters に積む(診断用)。 */
function makeTrackedAgent(getMatch, sideIndex, rngSeed, counters) {
  const rng = createRng(rngSeed);
  const base = createCpuAgent({
    templates,
    policy,
    rng,
    scheduleFire: (action, atStep) => {
      counters[action.kind] = (counters[action.kind] ?? 0) + 1;
      recordRuleLength(action);
      sumScheduleFireCalls++;
      engineScheduleFire(getMatch(), sideIndex, action, atStep);
    },
    selfDestruct: (antId) => {
      sumSelfDestructCalls++;
      const ok = engineSelfDestruct(getMatch(), sideIndex, antId);
      if (ok) sumSelfDestructSuccess++;
      return ok;
    },
  });
  return {
    decide(view) {
      const action = base.decide(view);
      if (action) {
        counters[action.kind] = (counters[action.kind] ?? 0) + 1;
        recordRuleLength(action);
        sumImmediateFireCalls++;
        // §29(新規): launchColumnSpread。CPU が実際に選んだ攻撃の発射列(antX)の分布。
        if (action.kind === 'attack') {
          launchColumnCounts[action.antX] = (launchColumnCounts[action.antX] ?? 0) + 1;
        }
      }
      return action;
    },
    reset: base.reset,
  };
}

// §29(新規): CPU が実際に選んだ攻撃の発射列(antX)ごとの発射回数。
const launchColumnCounts = {};

let sumTotalScore = 0;
let sumDurationSec = 0;
let drawCount = 0;
let side1Wins = 0; // spec の「side1」= match.sides[0]
let side2Wins = 0;
let sumPollution = 0;
let sumFired = 0;
let sumScoredAnts = 0;
let maxConcurrentFlyingOverall = 0;
let sumAttackFired = 0;
let sumDisruptFired = 0;

// §29-5: 異種rule衝突率。「あるアリが、自分と違う colorCount のアリが最後に触れたセルを
// 踏んだ」回数 / 「あるアリが、(誰かが最後に触れた)非白のセルを踏んだ」回数。
// engine.js に集計フックが無いため、runMatch の代わりに stepMatch を手動で回し、
// 各ステップの移動フェーズ直前(=そのアリがまさにそのセルを踏む直前)にアリID→colorCount の
// 対応表を控えてから lastToucher を覗く。
let crossRuleTouchedCells = 0;
let crossRuleMismatch = 0;

/**
 * §29(新規): scoreGateMissRate。敵陣に到達した弾のうち、得点ゲートを外して得点にならなかった割合。
 *
 * engine.js は stepMatch() の内部で resolveAnt() を呼ぶだけで、reached/scored を外に返さない
 * (moveSide が score++ するかどうかしか分からない)。そこで「y は1ステップに高々1しか動かない」
 * (C.DIRS の dy は -1/0/+1 のみ)という不変量を使う: あるステップで敵陣境界(C.SCORE_LINE_Y)に
 * **到達しうる**のは、そのステップの直前に y === C.SCORE_LINE_Y - 1 だったアリだけ。
 * そのアリがこのステップで消滅していれば、それは必ず「敵陣到達(reached)」による消滅であり
 * (寿命切れ(steps>=life)による消滅は resolveAnt 内で y>=SCORE_LINE_Y の判定より後に見るため、
 * どのみち y>=SCORE_LINE_Y なら reached=true が先に確定する)、得点(scored)したかどうかは
 * そのステップで自陣の scoredAnts が増えたかどうかで判別する。
 * ⚠️ 同じ陣営が同じステップに複数の攻撃アリを境界(y=SCORE_LINE_Y-1)に持つ場合は近似になる
 * (scoredAnts の増分は陣営単位のカウントで、どの弾が得点したかまでは追えないため)。
 * MAX_FLYING が小さいので稀にしか起きない。
 */
let scoreGateReachedCount = 0;
let scoreGateMissCount = 0;

for (let g = 0; g < GAMES; g++) {
  const matchSeed = deriveSeed(SEED, g);
  const match = createMatch({ seed: matchSeed });
  const counters = [{}, {}];
  // 両陣営は同一方策(自己対戦)。それでも「どちらの乱数ストリームがどちらの席に座るか」を
  // ゲームごとに入れ替え、席順(先手/後手)そのものの効果を firstSideWinRate に反映させる
  // (train-policy.mjs の evaluate() と同じ考え方)。
  // ⚠️ 同一方策どうしの自己対戦は盤面・行動が鏡像に近くなりやすく、side1(席0)がタイブレークで
  // 必ず勝つ「自己対戦特有の見かけ上の先手優位」を生みうる。診断ヒントで別途注意喚起する。
  const streamA = deriveSeed(SEED, g, 1);
  const streamB = deriveSeed(SEED, g, 2);
  const swap = g % 2 === 1;
  match.sides[0].agent = makeTrackedAgent(() => match, 0, swap ? streamB : streamA, counters[0]);
  match.sides[1].agent = makeTrackedAgent(() => match, 1, swap ? streamA : streamB, counters[1]);

  const antColorCount = new Map(); // id -> colorCount。ids は試合内で使い回されないので消さなくてよい
  while (match.phase !== 'finished') {
    for (const side of match.sides) {
      for (const ant of side.ants) antColorCount.set(ant.id, ant.colorCount);
    }
    for (const side of match.sides) {
      for (const ant of side.ants) {
        const gy = toGlobalY(ant.sideIndex, ant.y);
        const j = gy * C.WIDTH + ant.x; // engine.js の idx(x,y) と同じ規則
        const toucherId = match.lastToucher[j];
        if (toucherId !== -1 && toucherId !== ant.id) {
          const toucherColorCount = antColorCount.get(toucherId);
          if (toucherColorCount !== undefined) {
            crossRuleTouchedCells++;
            if (toucherColorCount !== ant.colorCount) crossRuleMismatch++;
          }
        }
      }
    }
    // scoreGateMissRate 用: 敵陣境界(y=SCORE_LINE_Y-1)にいる攻撃アリだけを控える(上のコメント参照)。
    const boundarySnapshot = [];
    for (const side of match.sides) {
      for (const ant of side.ants) {
        if (ant.kind === 'attack' && ant.y === C.SCORE_LINE_Y - 1) {
          boundarySnapshot.push({ id: ant.id, sideIndex: side.index });
        }
      }
    }
    const scoredAntsBefore = [match.sides[0].scoredAnts, match.sides[1].scoredAnts];

    stepMatch(match);

    for (const snap of boundarySnapshot) {
      const stillAlive = match.sides[snap.sideIndex].ants.some((a) => a.id === snap.id);
      if (stillAlive) continue; // 境界にいたが消滅しなかった(=まだ届いていない)
      scoreGateReachedCount++;
      if (match.sides[snap.sideIndex].scoredAnts === scoredAntsBefore[snap.sideIndex]) {
        scoreGateMissCount++;
      }
    }
  }

  const st = getStats(match);

  sumTotalScore += st.scores[0] + st.scores[1];
  sumDurationSec += st.durationSec;
  if (st.result === 'draw') drawCount++;
  else if (st.result === 'side1') side1Wins++;
  else if (st.result === 'side2') side2Wins++;
  sumPollution += st.pollution;
  sumFired += st.fired[0] + st.fired[1];
  sumScoredAnts += st.scoredAnts[0] + st.scoredAnts[1];
  maxConcurrentFlyingOverall = Math.max(
    maxConcurrentFlyingOverall,
    st.maxConcurrentFlying[0],
    st.maxConcurrentFlying[1],
  );
  sumAttackFired += (counters[0].attack ?? 0) + (counters[1].attack ?? 0);
  sumDisruptFired += (counters[0].disrupt ?? 0) + (counters[1].disrupt ?? 0);
}

const avgTotalScore = sumTotalScore / GAMES;
const avgDurationSec = sumDurationSec / GAMES;
const drawRate = drawCount / GAMES;
const decisiveGames = side1Wins + side2Wins;
const firstSideWinRate = decisiveGames > 0 ? side1Wins / decisiveGames : NaN;
const avgPollution = sumPollution / GAMES;
const avgFired = sumFired / GAMES;
const avgScoredAnts = sumScoredAnts / GAMES;
const avgAttackFired = sumAttackFired / GAMES;
const avgDisruptFired = sumDisruptFired / GAMES;
const crossRuleCollisionRate = crossRuleTouchedCells > 0 ? crossRuleMismatch / crossRuleTouchedCells : NaN;
const scoreGateMissRate = scoreGateReachedCount > 0 ? scoreGateMissCount / scoreGateReachedCount : NaN;

// 経過時間・スループットは実行のたびに変わるため stderr に出す(stdout は --seed が同じなら完全一致させる)。
console.error(`${GAMES}試合のシミュレーション完了(${elapsedSec().toFixed(1)}秒、${(GAMES / elapsedSec()).toFixed(0)}試合/秒)`);

// ---------------------------------------------------------------------------
// 2) 攻撃アリの得点率(妨害なし) + 得点した弾のハイウェイ割合
//    乱数配置(generate-templates.mjs の randomCandidate と同じ生成方法。ただし v4 の軸に追従:
//    配置帯は y=0..15、x は WIDTH 全域がラップする)を多数 simulateSolo する。
//    §29-2〜4(形成時間・周期・速度の分布)もここで同時に集計する。
// ---------------------------------------------------------------------------

/** 配置可能帯(y=0..ZONE_DEPTH-1)内で連結気味のマス集合を n個作る(n>=1)。x はラップする。 */
/**
 * v5: 配置マスはアリからの相対 [dx, dy] で、C.TEMPLATE_CELL_RADIUS 以内(config.js
 * 「配置マスをアリから何マス以内に置くか」参照)。ランダムウォークの原点をアリ(0,0)に取り、
 * |dx|,|dy| <= TEMPLATE_CELL_RADIUS かつ antY+dy が配置帯(0..ZONE_DEPTH-1)に収まる範囲だけを歩く。
 * x はトーラスなので dx の符号に制約はいらない(半径だけ守る)。
 */
function blobRelative(rng, n, antY) {
  const R = C.TEMPLATE_CELL_RADIUS;
  const seen = new Set();
  let dx = 0;
  let dy = 0;
  let guard = 0;
  while (seen.size < n && guard++ < n * 30) {
    seen.add(`${dx},${dy}`);
    const d = C.DIRS[rng.int(4)];
    const ndx = dx + d[0];
    const ndy = dy + d[1];
    const ny = antY + ndy;
    if (Math.abs(ndx) <= R && Math.abs(ndy) <= R && ny >= 0 && ny < C.ZONE_DEPTH) {
      dx = ndx;
      dy = ndy;
    }
  }
  return [...seen].map((k) => k.split(',').map(Number));
}

/**
 * ランダムな rule/colorCount を持つ攻撃候補を作る。rule を持たせないと engine が
 * C.LEGACY_RULE(='RRL'、L=3)へ既定で落ちてしまい、この得点率測定が事実上つねに
 * L=3 だけを測ることになる(§29-1 が検出しようとしているバイアスそのもの)ため、
 * ここでは必ずランダムな rule を明示する。
 *
 * v5: cells は相対テンプレートとして作り、instantiateTemplate で絶対座標(antX 込み)に直す。
 * antX はランダムな列でよい(x 方向の平行移動はハイウェイの厳密な対称性なので、
 * テンプレートの実力=到達可否は antX に依存しない。config.js「発射列(antX)の可変化」参照)。
 */
function randomAttackCandidate(rng) {
  const colorCount = C.MIN_COLORS + rng.int(C.MAX_COLORS - C.MIN_COLORS + 1);
  const rule = Array.from({ length: colorCount }, () => (rng.next() < 0.5 ? 'L' : 'R')).join('');
  const antY = rng.int(C.ZONE_DEPTH);
  const antDir = rng.int(4);
  const antX = rng.int(C.WIDTH);
  const cells = blobRelative(rng, 1 + rng.int(C.MAX_CELLS), antY).map(([dx, dy]) => [dx, dy, rng.int(colorCount)]);
  const relTemplate = { cells, rule, colorCount, antY, antDir, kind: 'attack' };
  return instantiateTemplate(relTemplate, antX);
}

const RANDOM_ATTACK_SAMPLES = 2000;
const randomAttackRng = createRng(deriveSeed(SEED, 0xa11a5e1));
let scoredCount = 0;
let reachedCount = 0;
let highwayCandidateCount = 0;
let reachedGivenHighwayCount = 0;
const scoredCandidates = [];
for (let i = 0; i < RANDOM_ATTACK_SAMPLES; i++) {
  const cand = randomAttackCandidate(randomAttackRng);
  const r = simulateSolo(cand, { trackPath: true });
  const isHighway = detectHighway(r.path) !== null;
  if (isHighway) highwayCandidateCount++;
  if (r.scored) {
    scoredCount++;
    scoredCandidates.push(cand);
  }
  if (r.reached) {
    reachedCount++;
    if (isHighway) reachedGivenHighwayCount++;
  }
}
/**
 * 「攻撃アリの得点率(妨害なし)」= **P(敵陣に到達 | その候補がハイウェイになっている)**。
 *
 * ⚠️ v5.1 で分母を「全ランダム候補」から「ハイウェイになった候補」に**戻した**。
 * 合格レンジ(30〜50%)は変えていない。理由:
 *
 * この合格レンジは v3.1 で決めたもので、当時のランダム候補は**全部 `RRL` 固定**だった。
 * つまり候補は定義上すべてハイウェイで、当時測っていた「得点率」は実質
 * `P(到達 | ハイウェイ)` だった。v4 以降はルール自体がランダムなので、そもそも
 * ハイウェイになるのが1割ほどしかなく、素の割合はレンジの意味を失う。
 *
 * 実測(乱数候補4,000件・ATTACK_LIFE=20,000):
 *   ハイウェイになった      10.9%
 *   敵陣に到達した           5.2%   ← 素の割合。v3.1 のレンジとは比較できない
 *   P(到達 | ハイウェイ)    47.6%   ← v3.1 が測っていたもの。レンジ 30〜50% の中
 *   P(ハイウェイ | 到達)   100.0%   ← highwayShareOfScoring
 *
 * つまり崩れていたのはバランスではなく**指標の定義**だった。閾値を実測に合わせて緩めるのは
 * 検査を無意味にするので、指標を元の意味に戻す方を選んだ(AGENTS.md「バランスに関わる
 * 変更の規律」)。素の割合は下の観測項目 rawReachRate として残す。
 *
 * ⚠️ 到達判定は `reached`(敵陣に入ったか)であって `scored`(得点ゲートに入ったか)では
 * ない。ランダム候補には発射列(antX)を選ぶ主体がいないが、実プレイでは発射列は自由に
 * 選べ、左右がトーラスなので到達列をゲート内に持ってくる antX は必ず存在する。
 * ゲートが実プレイでどう効くかは別の観測項目 scoreGateMissRate で測る。
 */
const scoreRateNoDisrupt =
  highwayCandidateCount > 0 ? reachedGivenHighwayCount / highwayCandidateCount : NaN;
/** 観測のみ: 全ランダム候補に対する素の到達率(v3.1 のレンジとは比較できない)。 */
const rawReachRate = reachedCount / RANDOM_ATTACK_SAMPLES;
/** 観測のみ: ランダム候補がそもそもハイウェイになる割合。 */
const highwayFormationRate = highwayCandidateCount / RANDOM_ATTACK_SAMPLES;

let highwayCount = 0;
const formationStepHist = {};
const highwayPeriodHist = {};
const highwaySpeedHist = {}; // 3桁に丸めてキーにする
for (const cand of scoredCandidates) {
  const r = simulateSolo(cand, { trackPath: true });
  if (!r.scored) continue;
  const hw = detectHighway(r.path);
  if (hw !== null) {
    highwayCount++;
    formationStepHist[hw.formationStep] = (formationStepHist[hw.formationStep] ?? 0) + 1;
    highwayPeriodHist[hw.period] = (highwayPeriodHist[hw.period] ?? 0) + 1;
    const speedKey = hw.speed.toFixed(3);
    highwaySpeedHist[speedKey] = (highwaySpeedHist[speedKey] ?? 0) + 1;
  }
}
const highwayShareOfScoring = scoredCandidates.length > 0 ? highwayCount / scoredCandidates.length : NaN;

// ---------------------------------------------------------------------------
// 3) カウンター密度・カウンター無し攻撃数
//    同梱9攻撃 × 9妨害 × deltaX × FIRE_TIMINGS の全組み合わせを total-war で判定する。
//    (--synthetic では 2攻撃 × 2妨害 になる。)
//
//    v5: テンプレートの cells は相対 [dx,dy,state]。攻撃は常に antX=0 で実体化し、
//    妨害は antX=deltaX で実体化する(差分 deltaX だけが結果を左右する。
//    src/search/evaluate-interaction.js のモジュール冒頭コメントと同じ考え方)。
//    deltaX の全256列掃引は 9×9×256×13 ≈ 27万回の simulateVersus になり重いので、
//    ここも generate-templates.mjs の共進化中の近似と同じ COEVO_DELTA_X_STRIDE 刻みの
//    粗いグリッドで妥協する(本番の9×9選抜だけが全列を掃引する)。
// ---------------------------------------------------------------------------

const densityDeltaXs = Array.from(
  { length: Math.ceil(C.WIDTH / C.COEVO_DELTA_X_STRIDE) },
  (_, i) => i * C.COEVO_DELTA_X_STRIDE,
);

function isCountered(attackInstance, disruptTpl, deltaX, t0) {
  const disruptInstance = instantiateTemplate(disruptTpl, deltaX);
  const r = simulateVersus(attackInstance, [{ template: disruptInstance, side: 1, fireAtStep: t0 }]);
  return !r.scored;
}

/**
 * カウンター密度の分母は **(妨害 × 発射タイミング)** で、deltaX は分母に入れない。
 *
 * ⚠️ v5 で deltaX(発射列の差)の次元が増えたが、これを分母に掛けると v4 の数値と
 * 比較できなくなる(掃引点を増やすほど密度が下がるだけの、意味のない指標になる)。
 * この指標が答えるべき問いは「守る側が持っている手のうち、どれくらいが実際に効くか」で、
 * **発射列は守る側が自由に選べる**(選ぶための表が counterTable の deltaX)。
 * つまり「ある妨害をあるタイミングで撃つ」という1つの手は、**いずれかの deltaX で
 * 止められるなら成立する**。そこで deltaX は「その手が成立するか」の内側の探索として扱い、
 * 分母には入れない。これで v4 の「(妨害 × タイミング)のうち何割が効くか」と同じ意味に戻る。
 *
 * ⚠️ 合格レンジ(`BALANCE.counterDensityMedian`)は変更していない。変えたのは
 * 「v5 で意味が壊れた分母の定義」だけ(AGENTS.md「バランスに関わる変更の規律」)。
 */
const timingsCount = C.FIRE_TIMINGS.length;
const totalCombosPerAttack = disruptTemplates.length * timingsCount;
const attackDensities = attackTemplates.map((a) => {
  const attackInstance = instantiateTemplate(a, 0);
  let counteredCombos = 0;
  let counteredWithDeltaX = 0; // 参考値: deltaX まで分母に入れた旧定義(観測のみ)
  for (const d of disruptTemplates) {
    for (const t0 of C.FIRE_TIMINGS) {
      let anyDeltaXWorks = false;
      for (const deltaX of densityDeltaXs) {
        if (isCountered(attackInstance, d, deltaX, t0)) {
          counteredWithDeltaX++;
          anyDeltaXWorks = true;
        }
      }
      if (anyDeltaXWorks) counteredCombos++;
    }
  }
  return {
    id: a.id,
    counteredCombos,
    counteredWithDeltaX,
    density: totalCombosPerAttack > 0 ? counteredCombos / totalCombosPerAttack : NaN,
  };
});
const sortedDensities = attackDensities.map((d) => d.density).slice().sort((x, y) => x - y);
function median(sorted) {
  const n = sorted.length;
  if (n === 0) return NaN;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
const counterDensityMedian = median(sortedDensities);

/**
 * 「カウンターを持たない攻撃テンプレートの数」(必須条件)。
 *
 * ⚠️ **粗いグリッドの掃引で数えてはいけない。** 上の密度計算は deltaX を
 * `COEVO_DELTA_X_STRIDE`(16列)刻みでしか見ていないが、テンプレート生成側の最終テーブルは
 * 2列刻み(128点)で掃引している。つまり「粗いグリッドに乗らない deltaX にだけカウンターを
 * 持つ攻撃」が偽陽性で「カウンター無し」に数えられる(実測: 生成側0件に対しここで2件)。
 *
 * この指標が本当に答えるべきなのは「**同梱の counterTable を使って、実際にすべての攻撃を
 * 止められるか**」。プレイヤーも CPU も counterTable に載っている手しか使えないので、
 * 表に載っていない deltaX でカウンターできても意味がない。逆に表に載っていても実際には
 * 止まらないなら、それは生成側のバグである。
 *
 * そこで **同梱 counterTable のエントリを1件ずつ再シミュレーションして検証する**。
 * 生成側を信用せず独立に確かめるという当初の目的にも適う(エントリ数は数十件なので安い)。
 */
const counterVerification = attackTemplates.map((a) => {
  const attackInstance = instantiateTemplate(a, 0);
  const entries = counterTable[a.id] ?? [];
  let verified = 0;
  for (const e of entries) {
    const disruptTpl = disruptTemplates.find((d) => d.id === e.disruptId);
    if (!disruptTpl) continue;
    if (isCountered(attackInstance, disruptTpl, e.deltaX ?? 0, e.fireAtStep)) verified++;
  }
  return { id: a.id, entries: entries.length, verified };
});
const attacksWithoutCounter = counterVerification.filter((v) => v.verified === 0).length;
const counterEntriesTotal = counterVerification.reduce((s, v) => s + v.entries, 0);
const counterEntriesVerified = counterVerification.reduce((s, v) => s + v.verified, 0);

// ---------------------------------------------------------------------------
// 4) 攻撃のみ vs 有効な迎撃の突破率 / 攻撃＋護衛 vs 同じ迎撃の突破率
//    templates.json の counterTable / escortTable の第1候補(成功率最良)を使う。
//    §29-6(衝突後highway復帰率)もここで使う counterTable の情報を流用する。
//
//    v5: 攻撃の発射列(antX)は「得点できる区間」(scoringLaunchColumns)から決定論的に
//    1つ選ぶ(区間の中央。乱数を使わず再現性を保つ)。entryXAt0 が無い(旧スキーマの
//    テンプレート等)場合は互換のため template.antX(無ければ0)にフォールバックする。
//    迎撃/護衛の発射列は wrapX(攻撃の発射列 + deltaX / escortDeltaX) で合わせる
//    (counterTable/escortTable は deltaX の表であって絶対座標の表ではないため。
//    config.js「発射列(antX)の可変化」参照)。
// ---------------------------------------------------------------------------

const breakthroughVsCounterResults = [];
const breakthroughWithEscortResults = [];
// §29-6 用のサンプル: 攻撃 + その最良カウンターの組み合わせ(どちらも実体化済み・絶対座標)。
const recoverySamples = [];
for (const a of attackTemplates) {
  const counters = counterTable[a.id] ?? [];
  if (counters.length === 0) {
    breakthroughVsCounterResults.push({ id: a.id, available: false, scored: null });
    breakthroughWithEscortResults.push({ id: a.id, available: false, scored: null });
    continue;
  }
  const cols = scoringLaunchColumns(a);
  const attackAntX = cols.count > 0 ? wrapX(cols.min + Math.floor(cols.count / 2)) : (a.antX ?? 0);
  const attackInstance = instantiateTemplate(a, attackAntX);

  const best = counters[0];
  const counterTpl = disruptById.get(best.disruptId);
  const counterInstance = instantiateTemplate(counterTpl, wrapX(attackAntX + (best.deltaX ?? 0)));
  const r1 = simulateVersus(attackInstance, [{ template: counterInstance, side: 1, fireAtStep: best.fireAtStep }]);
  breakthroughVsCounterResults.push({ id: a.id, available: true, scored: r1.scored });
  recoverySamples.push({ attack: attackInstance, counterTpl: counterInstance, fireAtStep: best.fireAtStep });

  const escorts = escortTable[a.id]?.[best.disruptId] ?? [];
  if (escorts.length === 0) {
    breakthroughWithEscortResults.push({ id: a.id, available: false, scored: null });
    continue;
  }
  const bestEscort = escorts[0];
  const escortTpl = disruptById.get(bestEscort.escortDisruptId ?? bestEscort.escortId);
  const escortInstance = instantiateTemplate(escortTpl, wrapX(attackAntX + (bestEscort.escortDeltaX ?? 0)));
  const r2 = simulateVersus(attackInstance, [
    { template: escortInstance, side: 0, fireAtStep: bestEscort.fireAtStep },
    { template: counterInstance, side: 1, fireAtStep: best.fireAtStep },
  ]);
  breakthroughWithEscortResults.push({ id: a.id, available: true, scored: r2.scored });
}
const vsCounterAvailable = breakthroughVsCounterResults.filter((r) => r.available);
const breakthroughVsCounter =
  vsCounterAvailable.length > 0
    ? vsCounterAvailable.filter((r) => r.scored).length / vsCounterAvailable.length
    : NaN;
const withEscortAvailable = breakthroughWithEscortResults.filter((r) => r.available);
const breakthroughWithEscort =
  withEscortAvailable.length > 0
    ? withEscortAvailable.filter((r) => r.scored).length / withEscortAvailable.length
    : NaN;

// ---------------------------------------------------------------------------
// §29-6: 衝突後highway復帰率
//
// 定義(この計測方法自体が観測項目の仕様なので、ここに明記する):
//   1. 妨害なしの単体軌道(simulateSolo, trackPath:true)を baseline とする。
//   2. 同じ攻撃 + その最良カウンター(3節で使ったのと同じ組み合わせ)を simulateVersus
//      (trackPath:true)で走らせ、攻撃アリの軌跡を得る。
//   3. baseline と実際の軌跡(どちらも unwrapPath 済み)を先頭から比較し、座標が最初に
//      食い違うステップを「乱れの発生(divergence)」とする。最後まで食い違わなければ
//      「妨害の影響が軌道に出ていない」とみなし、分母から除外する(妨害が届かなかった/
//      無効化された等)。
//   4. divergence 以降の軌跡だけを detectHighwayFromPath にかけ、周期運動が再検出できれば
//      「復帰した」とみなす。
//   5. 復帰率 = 復帰した件数 / 乱れが発生した件数。
// ---------------------------------------------------------------------------
let recoveryDenominator = 0;
let recoveryNumerator = 0;
for (const sample of recoverySamples) {
  const solo = simulateSolo(sample.attack, { trackPath: true });
  const versus = simulateVersus(sample.attack, [{ template: sample.counterTpl, side: 1, fireAtStep: sample.fireAtStep }], {
    trackPath: true,
  });
  if (!versus.path || !solo.path) continue;
  const soloPath = unwrapPath(solo.path);
  const versusPath = unwrapPath(versus.path);
  const minLen = Math.min(soloPath.length, versusPath.length);
  let divergeIdx = -1;
  for (let i = 0; i < minLen; i++) {
    if (soloPath[i][0] !== versusPath[i][0] || soloPath[i][1] !== versusPath[i][1]) {
      divergeIdx = i;
      break;
    }
  }
  if (divergeIdx === -1) continue; // 軌道に影響が出ていない(妨害が届かなかった等)
  const tail = versusPath.slice(divergeIdx);
  recoveryDenominator++;
  if (detectHighwayFromPath(tail) !== null) recoveryNumerator++;
}
const highwayRecoveryRateAfterCollision = recoveryDenominator > 0 ? recoveryNumerator / recoveryDenominator : NaN;

// ---------------------------------------------------------------------------
// 表の出力(合否判定の指標)
// ---------------------------------------------------------------------------

function inRange(v, [lo, hi]) {
  return Number.isFinite(v) && v >= lo && v <= hi;
}
function fmtPct(v) {
  return Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : 'N/A';
}
function fmtNum(v, digits = 2) {
  return Number.isFinite(v) ? v.toFixed(digits) : 'N/A';
}
function fmtPctRange([lo, hi]) {
  if (lo <= 0 && hi >= 1) return '任意';
  if (hi >= 1) return `${(lo * 100).toFixed(1)}% 以上`;
  if (lo <= 0) return `${(hi * 100).toFixed(1)}% 以下`;
  return `${(lo * 100).toFixed(1)}% 〜 ${(hi * 100).toFixed(1)}%`;
}
function fmtNumRange([lo, hi], unit = '') {
  return `${lo}${unit} 〜 ${hi}${unit}`;
}

const rows = [];
function addRow(name, actualStr, rangeStr, ok) {
  rows.push({ name, actualStr, rangeStr, ok });
}

addRow(
  '攻撃アリの得点率(妨害なし)',
  `${fmtPct(scoreRateNoDisrupt)}(素の到達率 ${fmtPct(rawReachRate)} / HW化率 ${fmtPct(highwayFormationRate)})`,
  fmtPctRange(C.BALANCE.scoreRateNoDisrupt),
  inRange(scoreRateNoDisrupt, C.BALANCE.scoreRateNoDisrupt),
);
addRow('得点した弾のハイウェイ割合', fmtPct(highwayShareOfScoring), fmtPctRange(C.BALANCE.highwayShareOfScoring), inRange(highwayShareOfScoring, C.BALANCE.highwayShareOfScoring));
addRow('カウンター密度(中央値)', fmtPct(counterDensityMedian), fmtPctRange(C.BALANCE.counterDensityMedian), inRange(counterDensityMedian, C.BALANCE.counterDensityMedian));
addRow(
  'カウンターを持たない攻撃テンプレートの数',
  `${attacksWithoutCounter}件(同梱表${counterEntriesVerified}/${counterEntriesTotal}件が再現)`,
  `${C.BALANCE.attacksWithoutCounter}件(必須)`,
  attacksWithoutCounter === C.BALANCE.attacksWithoutCounter,
);
addRow('攻撃のみ vs 有効な迎撃の突破率', fmtPct(breakthroughVsCounter), fmtPctRange(C.BALANCE.breakthroughVsCounter), inRange(breakthroughVsCounter, C.BALANCE.breakthroughVsCounter));
addRow('攻撃＋護衛 vs 同じ迎撃の突破率', fmtPct(breakthroughWithEscort), fmtPctRange(C.BALANCE.breakthroughWithEscort), inRange(breakthroughWithEscort, C.BALANCE.breakthroughWithEscort));
addRow('1試合あたりの総得点(両陣営合計)', fmtNum(avgTotalScore), fmtNumRange(C.BALANCE.totalScorePerMatch, '点'), inRange(avgTotalScore, C.BALANCE.totalScorePerMatch));
addRow('平均試合時間', `${fmtNum(avgDurationSec, 1)}秒`, fmtNumRange(C.BALANCE.matchDurationSec, '秒'), inRange(avgDurationSec, C.BALANCE.matchDurationSec));
addRow('時間切れ引き分け率', fmtPct(drawRate), fmtPctRange(C.BALANCE.drawRate), inRange(drawRate, C.BALANCE.drawRate));
addRow('先手勝率(side1)', fmtPct(firstSideWinRate), fmtPctRange(C.BALANCE.firstSideWinRate), inRange(firstSideWinRate, C.BALANCE.firstSideWinRate));
addRow('試合終了時の盤面汚染度', fmtPct(avgPollution), fmtPctRange(C.BALANCE.boardPollution), inRange(avgPollution, C.BALANCE.boardPollution));

const nameW = Math.max(...rows.map((r) => r.name.length), '指標'.length) + 2;
const actualW = Math.max(...rows.map((r) => r.actualStr.length), '実測'.length) + 2;
const rangeW = Math.max(...rows.map((r) => r.rangeStr.length), '想定範囲'.length) + 2;

function padDisplay(s, width) {
  // 全角文字を2幅として数える簡易パディング(日本語ラベルの表を揃えるため)。
  let w = 0;
  for (const ch of s) w += ch.codePointAt(0) > 0x2000 ? 2 : 1;
  return s + ' '.repeat(Math.max(1, width - w));
}

console.log('=== バランス指標(docs/spec.md の合格ライン。合否判定に使う) ===');
console.log(padDisplay('指標', nameW) + padDisplay('実測', actualW) + padDisplay('想定範囲', rangeW) + '判定');
for (const r of rows) {
  console.log(padDisplay(r.name, nameW) + padDisplay(r.actualStr, actualW) + padDisplay(r.rangeStr, rangeW) + (r.ok ? 'OK' : 'NG'));
}
console.log('');

const passCount = rows.filter((r) => r.ok).length;
const failCount = rows.length - passCount;
console.log(`合格 ${passCount}件 / 不合格 ${failCount}件`);
console.log('');

// ---------------------------------------------------------------------------
// 参考値(spec §9 の未決定事項の計測。合否判定はしない)
// ---------------------------------------------------------------------------
console.log('=== 参考値(spec §9 未決定事項の計測、合否判定なし) ===');
console.log(`1試合あたりの平均発射数(両陣営合計): ${fmtNum(avgFired)}(うち攻撃 ${fmtNum(avgAttackFired)} / 妨害 ${fmtNum(avgDisruptFired)})`);
console.log(`1試合あたりの平均得点アリ数(両陣営合計): ${fmtNum(avgScoredAnts)}`);
console.log(`全試合中の同時飛行数の最大値(1陣営あたり、上限${C.MAX_FLYING}): ${maxConcurrentFlyingOverall}`);
console.log('');

// ---------------------------------------------------------------------------
// §29: 追加レポート項目(観測のみ。合否判定には使わない)
// ---------------------------------------------------------------------------

function printCountHistogram(title, counts, unit = '件') {
  console.log(title);
  const keys = Object.keys(counts);
  if (keys.length === 0) {
    console.log('    (サンプルなし)');
    return;
  }
  const sortedKeys = keys.sort((a, b) => Number(a) - Number(b));
  for (const k of sortedKeys) console.log(`    ${k}: ${counts[k]}${unit}`);
}

console.log('=== 観測のみの指標(§29。合否判定には使わない) ===');

console.log('');
console.log('[1] ルール長分布(実際に発射された弾。L=3 に偏っていないかを確認する指標)');
printCountHistogram('    ルール長 → 発射回数', ruleLengthHist, '回');

console.log('');
console.log(`[2] 形成時間分布(得点した弾のうち、ハイウェイと判定された ${highwayCount}/${scoredCandidates.length} 件の formationStep)`);
printCountHistogram('    formationStep → 件数', formationStepHist);

console.log('');
console.log('[3] highway period 分布(同サンプル)');
printCountHistogram('    period → 件数', highwayPeriodHist);

console.log('');
console.log('[4] highway speed 分布(同サンプル。1ステップあたりの並進距離、小数点3桁で丸め)');
printCountHistogram('    speed → 件数', highwaySpeedHist);

console.log('');
console.log('[5] 異種rule衝突率(あるアリが、自分と違う colorCount のアリが最後に触れたセルを踏んだ回数の割合)');
console.log(`    分母(誰かが最後に触れたセルを踏んだ回数): ${crossRuleTouchedCells}`);
console.log(`    分子(踏んだ相手の colorCount が自分と異なる回数): ${crossRuleMismatch}`);
console.log(`    crossRuleCollisionRate = ${fmtPct(crossRuleCollisionRate)}`);

console.log('');
console.log('[6] 衝突後highway復帰率(定義は上のコメント参照。attackTemplates × 最良カウンターの組み合わせで計測)');
console.log(`    軌道に乱れが観測されたサンプル数(分母): ${recoveryDenominator}`);
console.log(`    乱れの後に再びハイウェイと判定できたサンプル数(分子): ${recoveryNumerator}`);
console.log(`    highwayRecoveryRateAfterCollision = ${fmtPct(highwayRecoveryRateAfterCollision)}`);
console.log('');

console.log('[7] scoreGateMissRate(v5新規。敵陣に到達した弾のうち、得点ゲートを外して得点にならなかった割合。' +
  '実プレイ(games=' + GAMES + ')の試合ログから計測。定義・近似の限界は上のコメント参照)');
console.log(`    分母(敵陣境界に到達したとみなせた消滅回数): ${scoreGateReachedCount}`);
console.log(`    分子(同じステップで自陣の得点が増えなかった回数): ${scoreGateMissCount}`);
console.log(`    scoreGateMissRate = ${fmtPct(scoreGateMissRate)}`);
console.log('');

console.log('[8] launchColumnSpread(v5新規。CPU が実プレイで実際に選んだ攻撃の発射列(antX)の分布)');
console.log(`    使われた発射列の種類数: ${Object.keys(launchColumnCounts).length} / ${C.WIDTH}列`);
printCountHistogram('    antX → 発射回数', launchColumnCounts, '回');
console.log('');

console.log('[9] 予約発射の消化率・自爆(新規。selfDestruct 配線の観測。合否判定には使わない。定義は上のコメント参照)');
const estimatedScheduledMatured = Math.max(0, sumFired - sumImmediateFireCalls);
const scheduleFireConsumptionRate =
  sumScheduleFireCalls > 0 ? estimatedScheduledMatured / sumScheduleFireCalls : NaN;
console.log(`    scheduleFire() 呼び出し回数(予約数、全試合合計): ${sumScheduleFireCalls}`);
console.log(`    実際に発射に至った回数(全試合合計、st.fired 合計): ${sumFired}`);
console.log(`    うち decide() が即座に返した回数(即時発射、全試合合計): ${sumImmediateFireCalls}`);
console.log(`    予約が満期を迎えて発火した回数(推定、st.fired - 即時発射): ${estimatedScheduledMatured}`);
console.log(`    予約発射の消化率(推定) = ${fmtPct(scheduleFireConsumptionRate)}`);
console.log(`    selfDestruct() 呼び出し回数(全試合合計): ${sumSelfDestructCalls}`);
console.log(`    selfDestruct() 成功回数(全試合合計): ${sumSelfDestructSuccess}`);
console.log('');

// ---------------------------------------------------------------------------
// 不合格項目の診断ヒント
// ---------------------------------------------------------------------------
if (failCount > 0) {
  console.log('=== 診断ヒント ===');
  const failedNames = new Set(rows.filter((r) => !r.ok).map((r) => r.name));

  if (failedNames.has('1試合あたりの総得点(両陣営合計)')) {
    const impliedBreakthrough = avgAttackFired > 0 ? avgScoredAnts / avgAttackFired : NaN;
    console.log('- 総得点の内訳:');
    console.log(`    平均攻撃発射数=${fmtNum(avgAttackFired)} 平均妨害発射数=${fmtNum(avgDisruptFired)} 平均得点数=${fmtNum(avgScoredAnts)}`);
    console.log(`    攻撃1発あたりの得点率(概算, 得点数/攻撃発射数)=${fmtPct(impliedBreakthrough)}`);
    console.log(`    参考: 妨害なしの得点率=${fmtPct(scoreRateNoDisrupt)} / 攻撃のみvs迎撃の突破率=${fmtPct(breakthroughVsCounter)} / 攻撃+護衛vs迎撃の突破率=${fmtPct(breakthroughWithEscort)}`);
    if (Number.isFinite(impliedBreakthrough) && impliedBreakthrough < 0.05) {
      console.log('    → 概算突破率が極端に低い。迎撃(counterTable)が強く効きすぎているか、CPUが護衛を撃てていない(escortBias/トークン不足)可能性がある。');
    }
    console.log(`    方策: fireThreshold=${fmtNum(policy.fireThreshold)} reserveTokens=${fmtNum(policy.reserveTokens)} defendBias=${fmtNum(policy.defendBias)} escortBias=${fmtNum(policy.escortBias)}`);
    if (avgAttackFired < 1) {
      console.log('    → 攻撃発射数自体が極端に少ない。fireThreshold/reserveTokens が高すぎて攻撃を出せていない可能性がある。');
    }
  }
  if (failedNames.has('得点した弾のハイウェイ割合')) {
    console.log(`- ハイウェイ割合: 得点サンプル${scoredCandidates.length}件中${highwayCount}件がハイウェイと判定された。寿命(ATTACK_LIFE=${C.ATTACK_LIFE})が緩すぎる/厳しすぎる可能性がある。`);
  }
  if (failedNames.has('カウンター密度(中央値)') || failedNames.has('カウンターを持たない攻撃テンプレートの数')) {
    console.log('- 攻撃ごとのカウンター密度(カウンターされた組み合わせ数/' + totalCombosPerAttack + '):');
    for (const d of attackDensities) {
      console.log(`    ${d.id}: ${d.counteredCombos}/${totalCombosPerAttack} (${fmtPct(d.density)})`);
    }
  }
  if (failedNames.has('攻撃のみ vs 有効な迎撃の突破率')) {
    console.log('- 攻撃ごとの突破結果(有効な迎撃に対して):');
    for (const r of breakthroughVsCounterResults) {
      console.log(`    ${r.id}: ${r.available ? (r.scored ? '突破した' : '止まった') : 'カウンターなし(異常)'}`);
    }
  }
  if (failedNames.has('攻撃＋護衛 vs 同じ迎撃の突破率')) {
    console.log('- 攻撃+護衛ごとの突破結果:');
    for (const r of breakthroughWithEscortResults) {
      console.log(`    ${r.id}: ${r.available ? (r.scored ? '突破した' : '止まった') : '護衛の記録なし'}`);
    }
  }
  if (failedNames.has('試合終了時の盤面汚染度')) {
    console.log(`- 平均盤面汚染度=${fmtPct(avgPollution)}。クリーンアップ(lastToucher)が想定どおり働いているか engine.js のテストを確認すること。`);
  }
  if (failedNames.has('先手勝率(side1)')) {
    console.log(`- side1勝ち=${side1Wins} side2勝ち=${side2Wins} 引き分け=${drawCount}(全${GAMES}試合)。`);
    console.log('    ⚠️ この harness は両陣営に同一方策を使う自己対戦なので、盤面・行動が鏡像に近くなり、');
    console.log('    最終局面のタイブレーク(stepMatch が side0→side1の順で判定する)で side1 が常に勝つ');
    console.log('    「自己対戦特有の見かけ上の先手優位」を生みうる。実際、方策に強い差をつけた別試験では');
    console.log('    勝敗は席ではなく方策の強さに追随した(席固定の構造的優位ではなさそうという状況証拠)。');
    console.log('    この指標を確定させるには、強さの異なる2方策(または席をランダム化した学習)での再測定が必要。');
  }
  if (failedNames.has('時間切れ引き分け率') || failedNames.has('平均試合時間')) {
    console.log(`- 平均試合時間=${fmtNum(avgDurationSec, 1)}秒 引き分け率=${fmtPct(drawRate)}(時間上限=${C.TIME_LIMIT_SEC}秒)。`);
  }
  if (failedNames.has('攻撃アリの得点率(妨害なし)')) {
    console.log(`- 乱数攻撃 ${RANDOM_ATTACK_SAMPLES}件中 ${scoredCount}件が得点(${fmtPct(scoreRateNoDisrupt)})。寿命(ATTACK_LIFE)を調整する場合は docs/spec.md 第2章の実測値も合わせて更新すること。`);
    console.log('    ⚠️ v4 ではランダム候補が rule/colorCount もランダムに持つため、v3.1(RRL固定)の合格レンジとは前提が異なる。テンプレート再生成・レンジ再測定が必要(docs/spec.md「未決定事項」)。');
  }
  console.log('');
}

process.exit(failCount > 0 ? 1 : 0);
