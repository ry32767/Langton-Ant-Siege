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
//   - 1秒あたりのステップを 120 → 300 → **670**(v5.1)に上げた。到達時間は
//     最速弾5.2秒 / 最遅弾29.9秒 になる(STEPS_PER_SECOND のコメント参照)
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

// ---- CPU の盤面観測(32×32 粗視化。v6 差分仕様 §10・docs/action-centric-contract.md §0) ----
//
// 実盤面は 256×256 = 65,536 セルある。CPU が毎判断でこれを走査すると学習が終わらない
// (view は学習1回で数千万回作られる)ので、8×8 セルを1ブロックに畳んだ 32×32 の粗視化盤面を
// engine 側で**増分更新**して持つ。CPU は局所ではなく全 32×32 ブロックを見る(§10)。
export const COARSE_SIZE = 32;
export const COARSE_BLOCK = WIDTH / COARSE_SIZE; // 8
/** `x >> COARSE_SHIFT` で coarse 列を求める。COARSE_BLOCK が2の冪であることが前提。 */
export const COARSE_SHIFT = Math.log2(COARSE_BLOCK); // 3
export const COARSE_COUNT = COARSE_SIZE * COARSE_SIZE; // 1024
export const COARSE_CELLS_PER_BLOCK = COARSE_BLOCK * COARSE_BLOCK; // 64
/** 盤面を CPU ローカル Y で4分割した帯(§17.2)。band0 が自陣側、band3 が敵陣側。 */
export const COARSE_BAND_COUNT = 4;
export const COARSE_ROWS_PER_BAND = COARSE_SIZE / COARSE_BAND_COUNT; // 8

/**
 * グローバル coarse 行 → CPU ローカル coarse 行。
 * y だけが陣営で鏡像になる(x はトーラスの共有軸なので変換しない)。
 * HEIGHT が COARSE_BLOCK の倍数なので、セル座標の鏡像とブロック座標の鏡像は完全に対応する。
 * 自己逆変換(ローカル→グローバルも同じ式)。
 */
export function coarseLocalRow(sideIndex, cyGlobal) {
  return sideIndex === 0 ? cyGlobal : COARSE_SIZE - 1 - cyGlobal;
}

/**
 * 所有セルの散らばり(特徴23 `ownedTrailSpread`)を [0,1] に落とす正規化スケール。
 * 差分仕様は「正規化2次モーメントを [0,1] へ」としか言っていないため、この値が唯一の定義
 * (docs/action-centric-contract.md §11-4)。所有セルが盤面全体に散ったときの重心からの
 * RMS 距離の目安として、x/y それぞれ盤面の 1/4 を取る。
 */
export const OWNED_SPREAD_SCALE = Math.hypot(WIDTH / 4, HEIGHT / 4); // ≈ 90.5

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
/**
 * 1秒あたりの論理ステップ数。論理は固定ステップ、描画は requestAnimationFrame。
 *
 * v4: 120 → v5: 300 → **v5.1: 670**。
 *
 * ⚠️ 到達時間の**比**(最速弾 3,471step / 最遅弾 ATTACK_LIFE=20,000step ＝ 5.8倍)は
 * この値に依存しない。変わるのは絶対時間だけ:
 *   300 step/s → 最速 11.6秒 / 最遅 66.7秒
 *   670 step/s → 最速  5.2秒 / 最遅 29.9秒
 *   900 step/s → 最速  3.9秒 / 最遅 22.2秒
 * 900 だと最速弾が3.9秒で着弾し、「識別 → 迎撃札を選ぶ → 発射列を合わせる → 撃つ」に
 * 必要な時間が足りない ——「670 は最速弾5.2秒を確保できる下限」というこの根拠は、
 * **判断周期が1秒だった v5.x の前提**(5.2秒＝判断5回ぶんしかない)に依存していた。
 *
 * ⚠️ **v6.1 で判断周期を 67ステップ(1秒に10回)にしたので、同じ5.2秒が判断52回ぶんになり、
 * この制約は緩んだ。** それでも 670 を据え置いているのは、ここから先を決めるのが
 * 判断回数ではなく**描画と体感テンポ**(1発の滞空が 20,000/670 ≒ 29.9秒 ＝ 240秒試合の約1/8)
 * だから。上げ下げするならその観点で決め直すこと。
 *
 * ⚠️ この値を変えたら FIRE_TIMING_INTERVAL が DECISION_INTERVAL_STEPS の倍数に
 * なっていないかを必ず確認する(test/config.test.js が検査する)。倍数になると
 * 記録した迎撃タイミングの大半が実際には撃てなくなる。
 */
export const STEPS_PER_SECOND = 670;
export const TIME_LIMIT_SEC = 240; // 時間切れ時は得点が多い方の勝ち。同点なら引き分け
export const TOTAL_STEPS = TIME_LIMIT_SEC * STEPS_PER_SECOND; // 240 × 670 = 160,800
export const WIN_SCORE = 5;

// ---- トークン -------------------------------------------------------------
export const TOKEN_PER_TICK = 1;
export const TOKEN_TICK_STEPS = STEPS_PER_SECOND; // 1秒ごとに +1
export const TOKEN_CAP = 30; // 上限。アリ飛行中も蓄積する

// ---- CPU の判断周期 --------------------------------------------------------
// ⚠️ FIRE_TIMINGS の導出がこの値を参照するので、ここで先に定義しておく
// (ESM の const は巻き上げられても TDZ に入るため、後ろで定義すると参照できない)。
/** CPU の判断頻度(1秒あたり)。⚠️ 下の DECISION_INTERVAL_STEPS の制約を読んでから変えること。 */
export const DECISIONS_PER_SECOND = 10;

/**
 * CPU が「新しい判断」をする間隔(ステップ)。
 *
 * ⚠️ **v6.1 で 670(1秒に1回)→ 67(1秒に10回)に変更した。**
 * 理由: 自爆のように「今この瞬間に決めたい」判断が1秒粒度だと表現できない。
 * 反応の余裕を判断回数で見ると:
 *   - 最速の攻撃弾の飛行時間 3,473ステップ = 判断 **5回**(670)→ **52回**(67)
 *   - 攻撃アリの寿命 20,000ステップ = 判断 **30回**(670)→ **299回**(67)
 * STEPS_PER_SECOND のコメントが「670 は最速弾5.2秒を確保できる下限」としていたのは
 * 判断周期が1秒だったからで、判断を細かくすればこの制約自体が緩む。
 *
 * ⚠️ **この値を変えるときに壊れうる3点**(いずれも実測で確認した):
 *
 * 1. **FIRE_TIMING_INTERVAL(=850)の約数にしてはいけない。** 下の FIRE_TIMINGS の導出には
 *    「間隔が判断周期の倍数なら50ずらす」というガードがあり、そこに掛かると FIRE_TIMINGS
 *    そのものが変わって **data/templates.json の counterTable / escortTable が全部無効になる**
 *    (テンプレート再生成が必要。`--resume-archive` でも約48分)。
 *    実測: 670 / 335 / 134 / 67 は間隔 850 のまま既存テーブルと整合。**34 は 850 の約数なので NG**。
 *    `test/config.test.js` がこの条件を検査する。
 * 2. **TOKEN_TICK_STEPS を割り切る値にする。** 670 = 10 × 67 なのでトークン加算ステップは
 *    必ず判断ステップと一致し、「トークンが増えた瞬間に使える」が保たれる。割り切れない値
 *    (例 20)にすると加算と判断がズレて、増えたトークンを使うまでに最大 N-1 ステップ待つ。
 * 3. **スループットが判断回数にほぼ比例して落ちる。** 実測(同一方策・20試合):
 *    670→44.9 / 335→38.3 / 134→29.7 / **67→14.7** / 20→5.9 試合/秒。
 *    20世代の学習(69,400試合)は 22ワーカーで 670 なら約4分、67 なら**約13分**。
 *
 * ⚠️ 予約した発射(counterTable / escortTable の fireAtStep)はこの周期に縛られず、
 * 指定したステップちょうどに発火する(SCHEDULED_FIRE_IS_EXACT)。
 * docs/spec.md「共有盤面とステップ順序」参照。
 */
export const DECISION_INTERVAL_STEPS = STEPS_PER_SECOND / DECISIONS_PER_SECOND;

// ---- アリ -----------------------------------------------------------------
export const MAX_FLYING = 4; // 1陣営の同時飛行数(攻撃・妨害の合計)

export const ATTACK_COST = 5; // 実コスト = ATTACK_COST + 配置マス数 → 6..21
/**
 * 攻撃アリの寿命(ステップ)。§7 の GAME_PROJECTILE_LIFE。
 *
 * **v5 の確定値。1,014万評価の探索アーカイブを scripts/tune-attack-life.mjs で掃引して決めた。**
 *
 * 最深発射位置(y=ZONE_DEPTH-1=31)から得点ライン(y=224)までは **193行**(v4 は88行)。
 * 掃引の実測(到達した elite 356件。「署名種」= 周期と並進の組の異なり数):
 *
 *   寿命    viable  署名種  到達時間の幅
 *    6,000     49      2     5.4秒
 *    7,500     65      5    13.3秒
 *    9,000    128      9    18.3秒
 *   12,000    356     18    28.4秒
 *
 * **弾種の多様性は寿命に対して単調に増える**。上限を決めるのは物理ではなくテンポ:
 * 1発が盤面に居座る最大時間は `ATTACK_LIFE / STEPS_PER_SECOND` 秒で、20,000 なら
 * 670 step/s なら **29.9秒**(240秒の試合の約1/8)。ここは設計判断として選んだ値
 * (STEPS_PER_SECOND のコメントに、この比がステップ速度に依存しない理由がある)。
 *
 * ⚠️ 「寿命がハイウェイ以外を落とすフィルタ」という設計原則(AGENTS.md が
 * 「外すと壊れる」としている制約)は**壊れない**ことを実測で確認済み。乱数候補4,000件で
 * 「敵陣に到達した弾のうちハイウェイと判定された割合」を寿命別に測ると:
 *   寿命 6,000 → 100.0% / 8,000 → 100.0% / 9,000 → 100.0% / 12,000 → 100.0%
 * 193行の**正味の**縦方向変位はカオス的な運動では時間をいくらかけても達成できない
 * (正味変位がほぼゼロなため)。寿命を延ばして増えるのは「遅いハイウェイ」であって
 * 「ハイウェイでないもの」ではない。それでも `BALANCE.highwayShareOfScoring`(95%以上)は
 * テンプレート再生成のたびに必ず再測定すること。
 *
 * ⚠️ この値を変えたら **`GAME_LIFE_SEARCH_CAP` も追随する**(下の定義参照)。探索中の
 * ゲーム射影はそのキャップで走らせて `arrivalStep` を記録しており、記録の上限より
 * 長い寿命へは再射影できない(その場合はアーカイブに対してゲーム射影をやり直す。
 * scripts/generate-templates.mjs の --resume-archive がそれを行う)。
 */
export const ATTACK_LIFE = 20000;
/**
 * 妨害アリの召喚ベースコスト(v5.5 で 3 → 2)。
 * ⚠️ 妨害の実コストは `DISRUPT_BASE_COST + ceil(配置マス数 / 2)` で、**配置マスの単価も攻撃の半分**。
 * 実コストは 3..10(攻撃は 6..21)。式は下の costOf() が唯一の定義なので、ここに書き足さないこと。
 */
export const DISRUPT_BASE_COST = 2;
/**
 * 妨害アリの寿命(ステップ)。
 *
 * ⚠️ v5 で 400 → 1,000。当初は「実時間3.3秒の維持」(400/120秒 = 1,000/300秒)が根拠
 * だったが、v5.1 で STEPS_PER_SECOND を 670 にしたので実時間は **1.49秒** になった。
 * それでも値を据え置いているのは、**この定数が担保しているのは実時間ではなく到達距離**
 * だから: 最速クラスでも縦に約56行しか進まず、192行ある中間地帯の 1/3 までしか届かない。
 * 「妨害は寿命内に敵陣(y≥224)に到達しない」は docs/spec.md 機能5の受け入れ条件で、
 * これは空間的な性質なのでステップ速度に依存しない。
 *
 * 🚧 ただし ATTACK_LIFE との比は 9:1(v4) → 20:1 になった。迎撃の時間窓が相対的に
 * 狭くなるので、`BALANCE.counterDensityMedian` と `attacksWithoutCounter` を再測定して
 * 影響を確認すること。問題が出たらここを上げる(ただし到達距離が中間地帯を超えない
 * 範囲で。2,000 ステップで111行=58%が上限の目安)。
 */
/**
 * 妨害アリが越えられない行(**自陣ローカル座標**)。ここに到達した瞬間に消滅する。
 *
 * ⚠️ v5.3 で導入。それまでは「妨害が敵陣(y≥224)に到達しない」という機能5の受け入れ条件を
 * **寿命だけ**で担保していた。これは脆い担保だった:
 *   - 保証が成り立つ上限は「最速ハイウェイ(周期18=1行/18step)が最浅の発射位置から
 *     得点ラインまでの193行を走る時間」= **3,474ステップ**でしかない
 *   - しかも「同梱の9種が到達しないこと」と「どんなテンプレートでも到達しないこと」は別物。
 *     テンプレートを再生成すると9種は入れ替わる。実測(乱数配置2,000通り・RRL)で
 *     寿命4,000なら **43%(865/2,000)が敵陣に到達し 637 が得点**してしまう
 *
 * そこで寿命ではなく**空間**で縛る。ローカル y がこの値以上になった妨害アリはその場で
 * 消滅する(得点しない)。x 方向はトーラス・y は陣営で鏡像なので、盤面中央 `HEIGHT/2` を
 * 使えば両陣営で自動的に対称になる。
 *
 * これにより寿命は「自陣側でどれだけ粘れるか」だけを決める自由なパラメータになり、
 * 敵陣到達は**原理的に不可能**になる(テンプレートを何度再生成しても壊れない)。
 */
export const DISRUPT_MAX_LOCAL_Y = HEIGHT / 2; // 128

/**
 * 妨害アリの寿命(ステップ)。⚠️ v5.3 で 1,000 → **6,000**。
 *
 * v5.2 まではこの値が「妨害を敵陣に到達させない」唯一の歯止めだったため 1,000 に
 * 抑えられており、縦の到達距離は最大でも約56行(192行ある中間地帯の29%)しかなかった。
 * v5.3 で `DISRUPT_MAX_LOCAL_Y`(盤面中央での消滅)を導入して到達距離を空間で縛ったので、
 * 寿命は安全性の担保から切り離され、自由に決められるようになった。
 *
 * 6,000 は「自陣側(ローカル y < 128)に十分長く留まって敵の攻撃と交差できる」ことを
 * 狙った値。中央までの最大96行は最速ハイウェイでも 96×18 = 1,728ステップで着くので、
 * 6,000 は「中央に達しない遅い弾でも寿命いっぱい粘れる」余裕を持たせている。
 *
 * ⚠️ この値を変えると `FIRE_TIMING_LAST` 経由で `FIRE_TIMINGS` の格子が変わり、
 * 既存の counterTable / escortTable の `fireAtStep` と噛み合わなくなる。
 * また `test/templates-schema.test.js` が `templates.config.disruptLife` の一致を検査する。
 * **変えたら必ずテンプレートを再生成すること**(`--resume-archive` で数分)。
 */
export const DISRUPT_LIFE = 6000;

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

/**
 * 発射コストの**唯一の定義**(v5.5)。
 *
 * ⚠️ この式を他のファイルへ書き写さないこと。プレイヤーUI・CPU・テンプレート生成・
 * MAP-Elites評価・共進化・最終選抜・templates.json・検証スクリプトが**すべてこの関数を通る**
 * ことが仕様(差分仕様 §11)。
 *
 * ⚠️ ここに置いてある理由: `src/cpu.js` は `src/engine.js` を import してはいけない
 * (実行時シミュレーションをしないことをコード上の依存関係で担保するため。AGENTS.md の Do NOT)。
 * 両方が読める場所は config.js しかない。engine.js の costOf はこれに委譲するだけの再輸出。
 *
 * 攻撃と妨害は**非対称**:
 *   攻撃 = ATTACK_COST(5) + 配置マス数        → 6..21
 *   妨害 = DISRUPT_BASE_COST(2) + ceil(マス/2) → 3..10
 * 妨害は召喚ベースだけでなく**配置マスの単価も安い**。迎撃札を実際に使える価格帯へ収めるための
 * 意図的な非対称ルール(差分仕様 §10.2)。
 */
export function costOf(kind, cellCount) {
  if (kind === 'disrupt') return DISRUPT_BASE_COST + Math.ceil(cellCount / 2);
  return ANT_KINDS[kind].baseCost + cellCount;
}

/** テンプレート(cells を持つオブジェクト)のコスト。costOf の薄いラッパ。 */
export function templateCost(template, kind) {
  return costOf(kind ?? template.kind, template.cells.length);
}

/** 自爆(飛行中の自分のアリを任意のタイミングで消す)のトークンコスト。0 = 無料・払い戻しもなし。 */
export const SELF_DESTRUCT_COST = 0;

/**
 * kind → コストと寿命。engine は kind による分岐をここだけに閉じる。
 * ⚠️ `baseCost` は**コスト式そのものではない**(妨害はマス単価が 1/2)。コストは必ず costOf() を通すこと。
 */
export const ANT_KINDS = Object.freeze({
  attack: Object.freeze({ baseCost: ATTACK_COST, life: ATTACK_LIFE }),
  disrupt: Object.freeze({ baseCost: DISRUPT_BASE_COST, life: DISRUPT_LIFE }),
});

// ---- テンプレート ---------------------------------------------------------
// v5.5: 9種 → 3種。プレイヤーが役割・相性・コストを把握できる手札数にする。
// 攻撃は Speed / Economy / Robust、妨害は Cheap / General / Complement の3役割を1種ずつ。
// ⚠️ 探索(MAP-Elites)は大量の候補を作り続ける。減らすのは**プレイヤーに公開する最終手札**だけで、
// 探索側の多様性とUIの複雑さは分離する。
export const TEMPLATE_COUNT_ATTACK = 3;
export const TEMPLATE_COUNT_DISRUPT = 3;

/** 攻撃テンプレートの役割ID(配列順と一致させる。attackPref[i] がこの順に対応する)。 */
export const ATTACK_ROLES = Object.freeze(['speed', 'economy', 'robust']);
/** 妨害テンプレートの役割ID(配列順と一致させる)。 */
export const DISRUPT_ROLES = Object.freeze(['cheap', 'general', 'complement']);

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
/**
 * ⚠️ 間隔を「秒数の定数倍」で決めてはいけない(v5.1 の修正)。
 * v5 では `STEPS_PER_SECOND * 1.25` = 375 としていたが、ATTACK_LIFE を 20,000 に
 * 引き上げると候補が **50点**に増える。カウンター表は
 * (攻撃 × 妨害 × deltaX × タイミング) の直積なので、タイミングが 13 → 50 になるだけで
 * 最終選抜の計算量が3.8倍(約3時間)になり、探索本体より選抜の方が長くなる。
 *
 * そこで **候補の「本数」を寿命によらず一定に保つ**。守る側にとって意味があるのは
 * 「妨害の寿命ぶんズラした別の手」なので、本数を固定して間隔を寿命に比例させる方が
 * 表現として素直でもある。
 * 制約: 間隔が DECISION_INTERVAL_STEPS の倍数だと記録した迎撃の大半が実際には
 * 撃てなくなる(docs/spec.md の警告)。倍数になったら 50 ずらして避ける。
 */
export const FIRE_TIMING_COUNT = 14;
export const FIRE_TIMING_LAST = ATTACK_LIFE - Math.round(DISRUPT_LIFE * 1.5);
export const FIRE_TIMING_INTERVAL = (() => {
  const raw = Math.max(50, Math.round(FIRE_TIMING_LAST / (FIRE_TIMING_COUNT - 1) / 50) * 50);
  return raw % DECISION_INTERVAL_STEPS === 0 ? raw + 50 : raw;
})();
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

// ---- 攻撃の発射列の自由化(v5.3) -------------------------------------------
//
// ⚠️ v5.4 で `DISRUPT_AIM_RANGE`(妨害の照準オフセット幅 ±32)を削除した。
// 妨害の発射列は方策の学習オフセットではなく counterTable / escortTable の
// `deltaX` / `escortDeltaX` に戻したため、この定数の参照元が無くなった
// (CPU の照準専用の定数で、探索・生成・エンジンからは使われていない)。
// 攻撃側の列選択(下の ATTACK_COLUMN_SAMPLES)は v5.3 のまま維持する。
/**
 * 攻撃の発射列を選ぶときに見る候補数(トーナメント選択の標本数)。
 *
 * 得点ゲート内の192列は x 方向の平行移動対称性により**どこも等価**なので、「絶対列◯◯が強い」は
 * 学習できない。意味を持つのは盤面の状態に対する相対評価なので、候補をこの数だけ無作為に
 * 引いて、そのうち最も汚染の少ない列(= ハイウェイが乱されにくい列)を選ぶ。
 * 全192列の argmin にすると選択が決定的になり読まれるので、標本を絞って揺らぎを残す。
 */
export const ATTACK_COLUMN_SAMPLES = 8;

// ---- Action 候補の生成(v6 Action-Centric。差分仕様 §5・§7・§29) ---------------
//
// ⚠️ これらは**候補数を制御するための上限**であって戦術的な絞り込みではない(§29)。
// 「敵が来たから妨害を優先する」「汚れていない列を選ぶ」といった戦術は候補生成に
// 入れてはいけない。候補の良し悪しは24次元の特徴が表現し、重みが学習する(§41)。
//
// 得点ゲート内の192列は x 方向の平行移動対称性でどこも等価なので、全列を候補化しても
// 情報は増えず計算量だけが増える。一様サンプルで代表を引き、順位付けは特徴に任せる。
/** 攻撃の発射列を得点ゲート内から何本サンプルするか(scoreReachability=1 になる候補)。 */
export const ACTION_ATTACK_GATE_SAMPLES = 4;
/**
 * 攻撃の発射列を得点ゲート**外**から何本サンプルするか(scoreReachability=0 になる候補)。
 * ⚠️ 0 にしてはいけない。差分仕様 §5 は「得点可能列だけに限定して候補生成してはならない」と
 * している(攻撃アリを妨害・護衛・囮・盤面操作として使う戦略を方策表現上禁止しないため)。
 */
export const ACTION_ATTACK_OFFGATE_SAMPLES = 2;
/** 妨害の発射列を全256列から何本サンプルするか。 */
export const ACTION_DISRUPT_SAMPLES = 4;
/** counterTable 由来の候補の上限(全敵アリ合計)。 */
export const ACTION_COUNTER_MAX = 8;
/** escortTable 由来の候補の上限(全自軍攻撃アリ合計)。 */
export const ACTION_ESCORT_MAX = 4;

/** Action 評価器(線形)の次元数。data/policy.json の weights の長さと必ず一致する。 */
export const ACTION_FEATURE_COUNT = 24;
/** data/policy.json の featureSchemaVersion。特徴の定義を変えたら必ず上げる。 */
export const FEATURE_SCHEMA_VERSION = 1;

/**
 * Reference League の `SAVE_AND_BURST` が撃ち始めるトークン閾値(§19.3)。
 * **参照方策の固定設定値であって CEM の学習対象ではない。**
 */
export const BURST_THRESHOLD = 20;

// ---- 探索(MAP-Elites) -----------------------------------------------------
/** ハイウェイ探索時のシミュレーション上限(§7)。ゲーム採用評価とは別。 */
export const SEARCH_LIFE = 30000;

/**
 * 探索中のゲーム射影に使う寿命の**上限キャップ**。ATTACK_LIFE ではなくこの値で走らせ、
 * 個体ごとの実到達ステップ数(arrivalStep)を記録する。
 *
 * こうしておくと ATTACK_LIFE を後から変えても探索をやり直す必要がない
 * (arrivalStep <= 新しい ATTACK_LIFE かどうかを見るだけで再射影できる)。
 * 値は「採用しうる ATTACK_LIFE の上限」として決める。193行 ÷ 最低速の実用ハイウェイ
 * (v_y≈0.017)= 11,350 step なので、余裕を見て 12,000。
 */
export const GAME_LIFE_SEARCH_CAP = ATTACK_LIFE;

/**
 * 探索評価用の仮想盤面の高さ。実ゲーム盤面(HEIGHT=120)は上下端でアリが死ぬため
 * SEARCH_LIFE(=20,000)ステップに到達できない(実測: 到達率11.6%)。探索評価だけは
 * この高さの仮想盤面(上下端なし・得点判定なし)で走らせる。
 * 根拠: 現実的なハイウェイ速度の上限 0.0556 行/ステップ × SEARCH_LIFE(30,000)ステップ
 * ≒ 1,668 行。中央から上下 2,048 行の余裕があるので収まる。
 * ⚠️ SEARCH_LIFE を上げるときはこの見積もりを検算すること(1,668 が 2,048 を超えたら
 * 本物のハイウェイが盤外判定で偽陰性になる)。
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
  // v_y(=|driftY|/period)の境界値。到達可能な下限は 193行 / ATTACK_LIFE、上限は
  // 実測で最速のハイウェイ 1/18 = 0.0556。ATTACK_LIFE=20,000 なら下限は 0.0097 で、
  // 0.0097〜0.0556 を3等分する位置に境界を置く。
  // ⚠️ ATTACK_LIFE を変えたらこの境界も同じ根拠で切り直すこと(到達可能域が変わるため)。
  speedClassBins: Object.freeze([0.025, 0.040, 1.0]),
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
