// 数値定数の一元管理。ここ以外に数値を直書きしない(AGENTS.md「コーディング規約」)。
// この値を変えたら docs/spec.md 第2章のルール表も同じ変更で直すこと。
// DOM に依存しない純粋な ESM。Node のスクリプトとブラウザの両方から import する。
//
// v4(MAP-Elites 版)の変更点:
//   - 盤面を90度回転。攻撃軸が上下、ラップが左右になった
//   - グローバル定数 RULE(='RRL') / COLORS / PLACED_CELL_STATE を廃止。
//     ルールと色数はテンプレート(=アリ)ごとに持ち、配置セルは状態を個別に指定する

// ---- 盤面 ----------------------------------------------------------------
//
// ⚠️ v5 で 60×120 → **256×256(正方形)** に拡大した。理由は「より複雑なハイウェイと
// 戦略が成立する余地を作るため」(設計判断)。副作用と対処は次のとおり:
//   - 中間地帯が 88行 → 192行 になり横断距離が2.2倍。寿命を 3,600 → 6,000 に引き上げた
//   - 1秒あたりのステップを 120 → 300 に上げ、横断の体感時間(11.6〜19.7秒)を維持した
//   - 盤面セル数が 7,200 → 65,536 になり、engine の全盤面走査(クリーンアップ)が
//     支配的コストになったので、アリごとの touched インデックス列に置き換えた(engine.js 参照)
export const WIDTH = 256; // 列。左右はトーラス
export const HEIGHT = 256; // 行。上下は場外(消滅 / 得点)
export const ZONE_DEPTH = 32; // 配置可能帯の深さ。side1 は y=0..31、side2 は y=224..255
export const WRAP_HORIZONTAL = true; // 左右はトーラス
export const WRAP_VERTICAL = false; // 上下はラップしない
export const CELL_COUNT = WIDTH * HEIGHT;

/** 得点ライン。ローカル座標でこの y 以上に入った瞬間に得点判定に入る。 */
export const SCORE_LINE_Y = HEIGHT - ZONE_DEPTH; // 224

/**
 * 得点ゲート(§v5)。**敵陣に到達しただけでは得点にならない**。到達した瞬間の x が
 * この帯の中に入っているときだけ1得点で、外に出た場合は得点せずに消滅する。
 *
 * ⚠️ 盤面を 256 列に広げると、守る側は 256 列すべてを警戒しなければならず迎撃が
 * 成立しなくなる(発射位置を可変にしたのでなおさら)。得点を中央192列に限ることで
 * 「門を守る」という防衛目標を作り、`BALANCE.attacksWithoutCounter = 0`(必須条件)を
 * 満たせる幅に戻す。ゲートの外側は左右32列ずつの「壁」になる。
 */
export const SCORE_GATE_WIDTH = 192;
export const SCORE_GATE_X_MIN = (WIDTH - SCORE_GATE_WIDTH) / 2; // 32
export const SCORE_GATE_X_MAX = SCORE_GATE_X_MIN + SCORE_GATE_WIDTH; // 224(この値は含まない)

/** x が得点ゲートの中か。engine の得点判定と UI の描画が共有する唯一の定義。 */
export function isInScoreGate(x) {
  return x >= SCORE_GATE_X_MIN && x < SCORE_GATE_X_MAX;
}

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
// ⚠️ v5 で 120 → 300 に引き上げた。盤面が2.2倍縦長になったぶんアリの横断ステップ数が
// 増えるので、そのままだと1回の攻撃に40秒以上かかって試合のテンポが崩れる。
// 300 step/s なら横断時間は 11.6〜19.7秒に収まり、v4(13.5〜28.7秒)と同水準になる。
export const STEPS_PER_SECOND = 300; // 論理は固定ステップ、描画は requestAnimationFrame
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
 * 🚧 **この値は暫定。本探索の結果から実測で確定させる**(docs/spec.md 未決定事項)。
 * 「複雑なハイウェイには 6,000 でも足りないかもしれない」という指摘に対しては、
 * **探索をやり直さずに後から決められる**構造にしてある:
 *   - 第1アーカイブ(ハイウェイ発見)は仮想盤面 SEARCH_BOARD_HEIGHT を SEARCH_LIFE まで
 *     走らせるので ATTACK_LIFE に依存しない
 *   - 探索中のゲーム射影は ATTACK_LIFE ではなく GAME_LIFE_SEARCH_CAP(=12,000)で行い、
 *     個体ごとの **実到達ステップ数(arrivalStep)** を記録する
 *   - 探索後に scripts/tune-attack-life.mjs で arrivalStep の分布を掃引し、
 *     「viable件数 / 到達時間の分散 / 速度クラス被覆」から ATTACK_LIFE を決める
 * 決めたら必ずこのコメントを実測値の根拠に置き換えること。
 *
 * ⚠️ v5 で 3,600 → 6,000 に引き上げた。盤面が 60×120 → 256×256 になり、
 * 最深発射位置(y=ZONE_DEPTH-1=31)から得点ライン(y=224)までが **193行**になったため
 * (v4 は88行)。速度クラスごとの必要ステップ数は次のとおり:
 *   v_y = 0.0556 (period 18 / drift 1)  →  3,471 step (11.6秒)
 *   v_y = 0.0385 (period 52 / drift 2)  →  5,018 step (16.7秒)
 *   v_y = 0.0327 (下限)                 →  5,900 step (19.7秒)
 *   v_y = 0.0294 (period 34 / drift 1)  →  6,562 step ← **寿命内に届かない**
 *
 * つまり ZONE_DEPTH=32 では最低速クラスが落ちる。到達可能な v_y は 0.033〜0.056 で、
 * 到達時間に 11.6〜19.7秒 の差が出る(v4 は 13.5〜28.7秒)。ここは読み合いの軸なので
 * `ARCHIVE2.speedClassBins` をこの範囲に合わせて切り直してある。
 *
 * ⚠️ 「寿命がハイウェイ以外を落とすフィルタ」という設計原則は v4 同様に弱まっている。
 * `BALANCE.highwayShareOfScoring`(95%以上)を必ず再測定して確認すること。
 */
export const ATTACK_LIFE = 6000;
export const DISRUPT_COST = 3; // 実コスト = DISRUPT_COST + 配置マス数 → 4..19
/**
 * 妨害アリの寿命(ステップ)。
 * ⚠️ v5 で 400 → 1,000 に引き上げた。**実時間 3.3秒 を維持するための換算**
 * (400/120秒 = 1,000/300秒)。最速クラスでも縦に約56行しか進まないので、
 * 192行ある中間地帯の 1/3 までしか届かず、敵陣(y≥224)には到達しない。
 * この「妨害は敵陣に届かない」性質は docs/spec.md 機能5の受け入れ条件。
 */
export const DISRUPT_LIFE = 1000;

export const MAX_CELLS = 16; // 1回の発射で置ける配置マスの上限
/**
 * 配置マスをアリから何マス以内に置くか(チェビシェフ半径)。
 *
 * ⚠️ v5 で導入した。v4 は配置帯(60×16=960マス)全体に一様ランダムで16マス撒いていたが、
 * 盤面が 256列 になると配置帯は 256×32=8,192マス になり、**アリが配置マスを一度も
 * 踏まないまま飛んでいく**(密度 0.2%)。そうなると genome の初期配置部分が事実上
 * 無意味になり「ルールだけの探索」に退化する。アリの近傍に限定して撒くことで
 * 初期配置が軌道に効くようにする。Seed Distillation(§10-§24)が生成する種も
 * 「アリ周囲の局所セル」なので、表現がそちらと一致する利点もある。
 */
export const TEMPLATE_CELL_RADIUS = 8;
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

/**
 * カウンター表・護衛表が候補にする発射タイミング(攻撃の発射ステップからの相対)。
 *
 * ⚠️ **ATTACK_LIFE から導出する。定数リテラルで固定しないこと。**
 * v3.1 は `[0, 150, ..., 1350]` の固定リストだった。これは寿命2,400 用に決めた格子で、
 * v4 で寿命を 3,600 に上げたときに据え置いたため、**飛行後半をカバーする迎撃タイミングが
 * 存在しなくなった**。妨害は寿命400(≒3.3秒)しかないので、1,350 に撃つとステップ1,750 には
 * 消えている。一方、低速クラスの弾の到達は 2,316〜3,458 ステップ。
 *
 * 実測(低速署名の viable 個体8件を、同じ妨害候補23件に対して評価):
 *   旧格子(最大1350): カウンターを持てた低速弾 **0件 / 8件**
 *   新格子(最大3000): カウンターを持てた低速弾 **7件 / 8件**(成功タイミングは全部 1,650〜3,000)
 * つまり「遅い弾は構造的にカウンター不能 → 必須条件によって選抜不可能 → 弾速の多様性が出ない」
 * という詰みは、この格子の打ち切りが原因だった。
 *
 * 間隔は「判断周期 DECISION_INTERVAL_STEPS の倍数ばかりにしない」ことが要件
 * (docs/spec.md の警告を参照)。v4 の 150 は判断周期120の1.25倍だったので、
 * v5 でも同じ比率 `STEPS_PER_SECOND * 1.25` = 375 を使う(300の倍数にならない)。
 * 末尾を `ATTACK_LIFE - DISRUPT_LIFE * 1.5` までにしているのは、消滅間際に撃っても
 * 干渉する時間が無いため(v4 の 600 = DISRUPT_LIFE 400 × 1.5 と同じ比率)。
 */
export const FIRE_TIMING_INTERVAL = Math.round(STEPS_PER_SECOND * 1.25); // 375
export const FIRE_TIMING_LAST = ATTACK_LIFE - Math.round(DISRUPT_LIFE * 1.5); // 4,500
export const FIRE_TIMINGS = Object.freeze(
  Array.from({ length: Math.floor(FIRE_TIMING_LAST / FIRE_TIMING_INTERVAL) + 1 }, (_, i) => i * FIRE_TIMING_INTERVAL),
);

/**
 * 発射列(antX)の可変化(§v5)。テンプレートは `cells` をアリ列からの相対 dx で持ち、
 * 発射時に antX を自由に選べる。左右がトーラスなので **x 方向の平行移動は力学の厳密な
 * 対称性**であり、ハイウェイ署名・形成時間・カウンター関係はそのまま保存される
 * (y 方向は飛距離が変わるので同じ扱いはできない。antY はテンプレート固有のまま)。
 *
 * カウンター表は (attack, disrupt, deltaX, fireAtStep) の表になる。deltaX は
 * 「妨害の発射列 − 攻撃の発射列」を WIDTH で割った余り。
 * 共進化中に全 WIDTH 列を掃引するのは重すぎるので、この粗いグリッドで近似し、
 * 最終9×9のテーブル計算だけ全列を掃引する。
 */
export const COEVO_DELTA_X_STRIDE = 16; // 共進化中の deltaX 掃引の刻み(256/16 = 16点)

// ---- 探索(MAP-Elites) -----------------------------------------------------
/** ハイウェイ探索時のシミュレーション上限(§7)。ゲーム採用評価とは別。 */
export const SEARCH_LIFE = 20000;

/**
 * 探索中のゲーム射影に使う寿命の**上限キャップ**。ATTACK_LIFE ではなくこの値で走らせ、
 * 個体ごとの実到達ステップ数(arrivalStep)を記録する。
 *
 * こうしておくと ATTACK_LIFE を後から変えても探索をやり直す必要がない
 * (arrivalStep <= 新しい ATTACK_LIFE かどうかを見るだけで再射影できる)。
 * 値は「採用しうる ATTACK_LIFE の上限」として決める。193行 ÷ 最低速の実用ハイウェイ
 * (v_y≈0.017)= 11,350 step なので、余裕を見て 12,000。
 */
export const GAME_LIFE_SEARCH_CAP = 12000;

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

/**
 * 第2アーカイブ(ゲーム候補)の記述子ビン(§14・§15)。
 *
 * ⚠️ v4.1 で `speedClassBins` を追加した。理由: archive2Attack の記述子が
 * `(entryPositionTier, robustnessTier)` の2軸だけだと、ハイウェイ署名(周期・並進)が
 * 異なる弾でも同じセルに競合してしまい、選抜前の候補プールでハイウェイ署名の多様性が
 * 失われる(実測: elite 605件 → viable 131件・署名4種類 → archive2Attack の elite が
 * わずか6件に潰れ、署名は2種類まで減った)。ハイウェイ署名から実効的な縦方向速度
 * `v_y = |driftY| / period` を出し、それをビン分けして軸に加える。
 *
 * `robustnessBins` は 5→2 に削った。理由: 実測で robustness の値はほぼ最上位ビュー
 * (無敵に近い個体)に張り付いており、軸として機能していなかった(§17 参照)。次元を
 * 1つ増やすとセル数が掛け算で増える(旧: entry6×robustness5=30セル)ので、機能していない
 * 軸を粗くしてセル総数の爆発を避ける(新: entry6×robustness2×speedClass3=36セル。
 * 旧30セルとほぼ同水準に収まる)。
 */
export const ARCHIVE2 = Object.freeze({
  entryPositionBins: 6, // 敵陣へ侵入した x 座標(旧仕様の entryY から変更)
  robustnessBins: Object.freeze([0.5, 1.0]),
  // v_y の境界値。v5 で到達可能になる範囲は 193行 / (ATTACK_LIFE - 形成) なので
  // おおよそ 0.033〜0.056。その間を3等分する位置に境界を置く。
  // 🚧 ATTACK_LIFE を実測で確定させたら、この境界も同じ根拠で切り直すこと。
  speedClassBins: Object.freeze([0.04, 0.048, 1.0]),
  reachBins: 6, // 妨害の縦方向到達距離(旧 reachColumns → reachRows)
  /**
   * 妨害の縦到達距離のビン幅スケール。理論上の最大値
   * (最速ハイウェイ 0.0556 行/step × DISRUPT_LIFE)より少し大きい値にして、
   * 実測範囲が reachBins に収まるようにする。
   * ⚠️ v4 では generate-templates.mjs にローカル定数(25)として置いていたが、
   * DISRUPT_LIFE に連動する値なのでここに移した(AGENTS.md「数値をソースに直書きしない」)。
   */
  reachScale: Math.ceil(DISRUPT_LIFE * 0.0556 * 1.1), // 62
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
