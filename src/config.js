// 数値定数の一元管理。ここ以外に数値を直書きしない(AGENTS.md「コーディング規約」)。
// この値を変えたら docs/spec.md 第2章のルール表も同じ変更で直すこと。
// DOM に依存しない純粋な ESM。Node のスクリプトとブラウザの両方から import する。
//
// v4(MAP-Elites 版)の変更点:
//   - 盤面を90度回転。攻撃軸が上下、ラップが左右になった
//   - グローバル定数 RULE(='RRL') / COLORS / PLACED_CELL_STATE を廃止。
//     ルールと色数はテンプレート(=アリ)ごとに持ち、配置セルは状態を個別に指定する

// ---- 盤面 ----------------------------------------------------------------
export const WIDTH = 60; // 列。左右はトーラス
export const HEIGHT = 120; // 行。上下は場外(消滅 / 得点)
export const ZONE_DEPTH = 16; // 配置可能帯の深さ。side1 は y=0..15、side2 は y=104..119
export const WRAP_HORIZONTAL = true; // 左右はトーラス
export const WRAP_VERTICAL = false; // 上下はラップしない
export const CELL_COUNT = WIDTH * HEIGHT;

/** 得点ライン。ローカル座標でこの y 以上に入った瞬間に1得点。 */
export const SCORE_LINE_Y = HEIGHT - ZONE_DEPTH; // 104

// ---- セルオートマトンのルール ----------------------------------------------
// ルールは 'L' / 'R' の文字列で、添字がセルの状態。長さ = 色数。
// ⚠️ グローバルな RULE は存在しない。各アリが自分の rule / colorCount を持つ。
//
// 回転は「踏んだ時点の状態」で決める。状態を進めた後の値ではない。
// 異なる色数のアリが同じ盤面を共有するため、盤面の生値は ant.colorCount で割った
// 余りとして解釈する(docs/spec.md「異種ルールの衝突」)。
//   const s = board[i] % ant.colorCount;
//   ant.dir = ant.rule[s] === 'R' ? ant.dir + 1 : ant.dir - 1;
//   board[i] = (s + 1) % ant.colorCount;

export const MIN_COLORS = 2;
export const MAX_COLORS = 16; // 盤面が保持しうる状態は 0..MAX_COLORS-1。Uint8Array で足りる

/** 既存 v3.1 の挙動を固定する回帰フィクスチャ用のルール(§25)。仕様上の既定値ではない。 */
export const LEGACY_RULE = 'RRL';

// 向き: 0=up 1=right 2=down 3=left。右回転は +1、左回転は -1(&3)。
export const DIRS = Object.freeze([
  Object.freeze([0, -1]), // 0: up
  Object.freeze([1, 0]), //  1: right
  Object.freeze([0, 1]), //  2: down
  Object.freeze([-1, 0]), // 3: left
]);
export const DIR_UP = 0;
export const DIR_RIGHT = 1;
export const DIR_DOWN = 2;
export const DIR_LEFT = 3;

// ---- 時間・試合 -----------------------------------------------------------
export const STEPS_PER_SECOND = 120; // 論理は固定ステップ、描画は requestAnimationFrame
export const TIME_LIMIT_SEC = 240; // 時間切れ時は得点が多い方の勝ち。同点なら引き分け
export const TOTAL_STEPS = TIME_LIMIT_SEC * STEPS_PER_SECOND; // 28,800
export const WIN_SCORE = 5;

// ---- トークン -------------------------------------------------------------
export const TOKEN_PER_TICK = 1;
export const TOKEN_TICK_STEPS = STEPS_PER_SECOND; // 1秒ごとに +1
export const TOKEN_CAP = 30; // 上限。アリ飛行中も蓄積する

// ---- アリ -----------------------------------------------------------------
export const MAX_FLYING = 4; // 1陣営の同時飛行数(攻撃・妨害の合計)

export const ATTACK_COST = 5; // 実コスト = ATTACK_COST + 配置マス数 → 6..21
/**
 * 攻撃アリの寿命(ステップ)。§7 の GAME_PROJECTILE_LIFE。
 *
 * ⚠️ v4 で 2,400 → 3,600 に引き上げた。理由は「弾速の多様性を物理的に成立させるため」。
 *
 * 中間地帯88行を渡るのに必要なステップ数は、ルールの速度クラスごとに次のとおり:
 *   LLR / RRL       0.0556 行/step  形成  38 →  1,621 step
 *   RRRRL / LLLLR   0.0294 行/step  形成 102 →  3,096 step
 *   RRRLLL / LLLRRR 0.0263 行/step  形成  98 →  3,445 step
 *   RRRRRL / LLLLLR 0.0238 行/step  形成 126 →  3,824 step
 *   RL / LR(古典)   0.0192 行/step  形成 9,976 → 14,560 step
 *
 * 寿命2,400 では **LLR 系しか届かない**。実際 2,400 で生成した攻撃9種は全部
 * LLR 相当になり(宣言ルール長は 3/6/9/14/15 とばらついていたが、実効色数は 3 か 6 で、
 * `LLRLLR` は `rule[s % 3]` が同じなので `LLR` と力学的に同一)、
 * ハイウェイ署名(周期・並進)は9種すべて period=18 / drift=(±1,±1) の1種類しかなかった。
 * つまり「ルールを選んで撃つ」という v4 の主目的が成立していなかった。
 *
 * 3,600 にすると上位3クラス(LLR / RRRRL / RRRLLL)が届き、到達時間に
 * 13.5秒〜28.7秒 の差が生まれて読み合いの軸になる。
 *
 * ⚠️ 代償: 「寿命がハイウェイ以外を落とすフィルタ」という設計原則が弱まる。
 * `BALANCE.highwayShareOfScoring`(95%以上)を必ず再測定して確認すること。
 */
export const ATTACK_LIFE = 3600;
export const DISRUPT_COST = 3; // 実コスト = DISRUPT_COST + 配置マス数 → 4..19
export const DISRUPT_LIFE = 400; // ステップ(3.3秒)。中間地帯までしか届かない

export const MAX_CELLS = 16; // 1回の発射で置ける配置マスの上限
export const MIN_CELLS = 0; // 規則上の下限。0個(アリだけ)の発射も成立する
/**
 * テンプレート/genome に要求する配置マス数の下限(§4・§28)。
 * 0マスの弾は軌道が発射位置だけで決まり読み合いにならないため、探索空間から外す。
 */
export const MIN_TEMPLATE_CELLS = 1;

/** kind → コストと寿命。engine は kind による分岐をここだけに閉じる。 */
export const ANT_KINDS = Object.freeze({
  attack: Object.freeze({ baseCost: ATTACK_COST, life: ATTACK_LIFE }),
  disrupt: Object.freeze({ baseCost: DISRUPT_COST, life: DISRUPT_LIFE }),
});

// ---- テンプレート ---------------------------------------------------------
export const TEMPLATE_COUNT_ATTACK = 9;
export const TEMPLATE_COUNT_DISRUPT = 9;

/** カウンター表・護衛表が候補にする発射タイミング(攻撃の発射ステップからの相対)。 */
export const FIRE_TIMINGS = Object.freeze([0, 150, 300, 450, 600, 750, 900, 1050, 1200, 1350]);

// ---- 探索(MAP-Elites) -----------------------------------------------------
/** ハイウェイ探索時のシミュレーション上限(§7)。ゲーム採用評価とは別。 */
export const SEARCH_LIFE = 20000;

/**
 * 探索評価用の仮想盤面の高さ。実ゲーム盤面(HEIGHT=120)は上下端でアリが死ぬため
 * SEARCH_LIFE(=20,000)ステップに到達できない(実測: 到達率11.6%)。探索評価だけは
 * この高さの仮想盤面(上下端なし・得点判定なし)で走らせる。
 * 根拠: 現実的なハイウェイ速度 0.0556 行/ステップ × 20,000 ステップ ≒ 1,100 行なので、
 * 4,096 で往復余裕を持って収まる。
 */
export const SEARCH_BOARD_HEIGHT = 4096;

/** ハイウェイ候補として採用するのに必要な連続一致周期数(§9)。 */
export const HIGHWAY_MIN_CYCLES = 5;

/** ハイウェイ検出で試す周期の上限。 */
export const HIGHWAY_MAX_PERIOD = 2000;

/** genome の突然変異数の分布(§6.4)。実験パラメータなので固定仕様にしない。 */
export const MUTATION_COUNT_WEIGHTS = Object.freeze([0.7, 0.2, 0.1]); // 1回 / 2回 / 3回

/** 第1アーカイブ(ハイウェイ発見)の記述子ビン(§11)。 */
export const ARCHIVE1 = Object.freeze({
  directions: Object.freeze(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']),
  speedBins: 10, // 0.0..1.0 を10等分
  formationBins: Object.freeze([64, 128, 256, 512, 1024, 2048, 4096, SEARCH_LIFE]),
});

/** 第1アーカイブの quality 重み(§12)。「最速」を最大化しないための配分。 */
export const ARCHIVE1_QUALITY = Object.freeze({
  stability: 1.0, // 検証周期数
  verticality: 1.0, // 目的方向(上下)への直進性
  usability: 1.0, // ゲーム寿命内で得られる変位
  formationPenalty: 1.0, // formationStep の短さ
});

/** 第2アーカイブ(ゲーム候補)の記述子ビン(§14・§15)。 */
export const ARCHIVE2 = Object.freeze({
  entryPositionBins: 6, // 敵陣へ侵入した x 座標(旧仕様の entryY から変更)
  robustnessBins: Object.freeze([0.2, 0.4, 0.6, 0.8, 1.0]),
  reachBins: 6, // 妨害の縦方向到達距離(旧 reachColumns → reachRows)
});

// ---- CPU ------------------------------------------------------------------
/**
 * CPU が「新しい判断」をする間隔。1秒に1回(トークンが増えるのと同じ周期)。
 *
 * ⚠️ 予約した発射(counterTable / escortTable の fireAtStep)はこの周期に縛られない。
 * FIRE_TIMINGS のうち120の倍数は 0/600/1200 の3つだけなので、周期に丸めると
 * 記録されたカウンターの7割が撃てなくなる。docs/spec.md「共有盤面とステップ順序」参照。
 */
export const DECISION_INTERVAL_STEPS = STEPS_PER_SECOND;

/** 予約した発射を fireAtStep ちょうどに実行する(true)か、判断周期に丸める(false)か。 */
export const SCHEDULED_FIRE_IS_EXACT = true;

// ---- ステップ順序 ---------------------------------------------------------
/**
 * 1ステップごとに陣営の処理順(先手・後手)を入れ替えるか。
 *
 * false（常に side1 が先）にすると、side1 のアリが毎ステップ先に盤面へ書き込むため
 * side1 の迎撃が構造的に半ステップ早く効く。実測で **先手勝率100%・平均得点 4.88 対 2.04**
 * という露骨な非対称が出たので true が既定。docs/spec.md「共有盤面とステップ順序」参照。
 */
export const ALTERNATE_STEP_ORDER = true;

// ---- 回帰フィクスチャ(LEGACY_RULE の挙動を固定する。engine のテストが参照) -----
// ⚠️ 「全アリが38ステップでハイウェイになる」という意味ではない(§25)。
// LEGACY_RULE を選んだアリが従来と同じ軌道を描くことを保証するためだけの値。
export const LEGACY_HIGHWAY_ONSET_STEP = 38;
export const LEGACY_HIGHWAY_PERIOD = 18;

// ---- バランス指標の合格ライン(scripts/simulate-matches.mjs が参照) ---------
// docs/spec.md「バランス指標」の表と一致させること。
// ⚠️ v3.1 の値は「RRL固定・上下ラップ・120×60」で測ったもの。v4 では盤面もルール空間も
// 変わるため、テンプレート再生成後に再測定して確定させる(docs/spec.md「未決定事項」)。
export const BALANCE = Object.freeze({
  scoreRateNoDisrupt: Object.freeze([0.3, 0.5]), // 攻撃アリの得点率(妨害なし)
  highwayShareOfScoring: Object.freeze([0.95, 1.0]), // 得点した弾のハイウェイ割合
  counterDensityMedian: Object.freeze([0.005, 0.03]), // カウンター密度の中央値
  attacksWithoutCounter: 0, // カウンターを持たない攻撃テンプレートの数(必須)
  breakthroughVsCounter: Object.freeze([0.0, 0.1]), // 攻撃のみ vs 有効な迎撃
  breakthroughWithEscort: Object.freeze([0.6, 1.0]), // 攻撃＋護衛 vs 同じ迎撃
  totalScorePerMatch: Object.freeze([3, 10]), // 1試合あたりの総得点(両陣営合計)
  matchDurationSec: Object.freeze([60, 200]), // 平均試合時間
  drawRate: Object.freeze([0.0, 0.1]), // 時間切れ引き分け率
  firstSideWinRate: Object.freeze([0.45, 0.55]), // 先手勝率
  boardPollution: Object.freeze([0.0, 0.15]), // 試合終了時の盤面汚染度
});

/**
 * §29 の追加レポート項目。**合否判定には使わない**(観測のみ)。
 * 判定の中心は上の BALANCE のまま。
 */
export const REPORT_ONLY_METRICS = Object.freeze([
  'ruleLengthDistribution',
  'formationStepDistribution',
  'highwayPeriodDistribution',
  'highwaySpeedDistribution',
  'crossRuleCollisionRate',
  'highwayRecoveryRateAfterCollision',
]);
