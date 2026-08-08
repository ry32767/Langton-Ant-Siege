# アーキテクチャ

背景は [../README.md](../README.md)、作業規約は [../AGENTS.md](../AGENTS.md)、機能・受け入れ条件は [spec.md](spec.md)。

> v5(盤面拡大版)で `src/search/` にモジュールが追加され(Seed Distillation・2段ハイウェイ検出・
> 探索レポート)、`scripts/generate-templates.mjs` はこれらを実際に呼び出す状態になった(v4時点では
> `src/search/*` の一部が未配線だったが、v5で解消した)。探索は `worker_threads` で並列化されている。
>
> v6 で **CPU の意思決定部分を Action-Centric に全面刷新**した(下記「v6 CPU の Action-Centric 化」参照)。
> `src/cpu.js` が「固定優先順位のヒューリスティック」から「候補生成(`generateActions`) + 24次元線形評価器
> (`selectAction`)」の2段構成になり、`scripts/train-policy.mjs` は24次元 CEM + 固定 Reference League
> (`src/reference-policies.js`)で学習するようになった。`scripts/evaluate-policy.mjs` を新設し、
> 学習前の性能計測(`--mode bench`)と学習後の最終評価(`--mode final`。旧CPU `src/cpu-legacy.js` +
> `data/policy-v55.json` との対戦を含む)を担う。唯一の実装契約は
> [action-centric-contract.md](action-centric-contract.md)。

## 全体構成:オフライン事前生成 ＋ 実行時テーブル参照

チューリング・アントは決定論的だが初期配置のわずかな違いで結果が非連続に飛ぶ(カオス的)ため、CPUの意思決定を**実行時にオンライン探索**すると計算コストが読めず、リアルタイム性を阻害する。探索そのものは**開発時にオフラインで前借り**し、実行時は生成済みテーブルと学習済み方策を参照するだけにする。

**プレイヤーも同じテンプレート集から選ぶ。** 良い配置は乱数探索で見つかる確率が低く、人間が手で見つけるのは事実上不可能な一方、CPUはオフライン探索の答えを持っている。同じ土俵に立たせないと勝負が成立しない。

```mermaid
flowchart TB
    subgraph offline["開発時オフライン"]
        Gen["scripts/generate-templates.mjs<br/>①MAP-Elites探索+Seed Distillation<br/>②③④共進化 ④.5厳密確認ゲート<br/>⑤3×3選抜(v5.5)"]
        Gen -->|worker_threads並列| Pool["scripts/lib/worker-pool.mjs<br/>scripts/lib/search-worker.mjs"]
        Pool --> Search["src/search/*<br/>genome/mutate/map-elites<br/>highway-trajectory/-fingerprint<br/>seed-distillation/-compression<br/>evaluate-projectile/-interaction"]
        Search --> Sim["src/engine.js<br/>(共有シミュレーションエンジン)"]
        Gen --> Tpl["data/templates.json"]
        Gen --> Archive["data/search-archive.json"]
        Gen --> Report["data/search-report.json"]
        Archive --> Tune["scripts/tune-attack-life.mjs<br/>ATTACK_LIFE候補の掃引"]
        Tpl --> Bench["scripts/evaluate-policy.mjs --mode bench<br/>(v6。CEM本学習前の性能計測)"]
        Bench --> BenchJson["data/benchmark.json"]
        Tpl --> Train["scripts/train-policy.mjs<br/>24次元CEM + Reference League(v6)"]
        BenchJson --> Train
        Ref["src/reference-policies.js<br/>ATTACK_ONLY/CHEAP_SPAM/<br/>SAVE_AND_BURST/DEFEND_HEAVY"] --> Train
        Train --> Pol["data/policy.json"]
        Pol --> Final["scripts/evaluate-policy.mjs --mode final<br/>(v6。リーグ4種+旧CPU評価)"]
        Legacy["src/cpu-legacy.js +<br/>data/policy-v55.json<br/>(凍結した v5.5 の旧CPU)"] --> Final
        Final -->|evaluation/tacticsLogを追記| Pol
        Final --> EvalJson["data/evaluation.json"]
        Sim --> Bal["scripts/simulate-matches.mjs<br/>バランス検証"]
    end
    Tpl -->|コミットして同梱| App["index.html + src/app.js"]
    Pol -->|コミットして同梱| App
    subgraph runtime["実行時ブラウザ"]
        App -->|攻撃/妨害タブで3種ずつ役割別表示(v5.5)| UI["プレイヤーの選択"]
        UI -->|発射列antXを選ぶ| Tmpl["src/template.js<br/>instantiateTemplate"]
        App -->|weights(24次元)を適用(v6)| CPU["src/cpu.js<br/>generateActions→selectAction"]
        CPU --> Tmpl
        App --> Engine["src/engine.js<br/>(32×32粗視化盤面+ownership map)"]
        Tmpl --> Engine
        UI -->|事前計算値を表示<br/>(実行時の再計算はしない)| App
    end
```

> `src/template.js` は `engine`(Node/ブラウザ共通)・`cpu`(実行時、engineへ依存禁止)・`app`(実行時)・`scripts/generate-templates.mjs`(オフライン)のすべてから使われる共有モジュールなので、上図では独立ノードとして描いている。

### `src/search/` のモジュール構成(v4→v5)

MAP-Elites 探索用の型・変異・アーカイブ・評価・検出・蒸留・レポート。いずれも DOM は勿論、`src/engine.js` も import しない純粋なデータ操作が原則(**唯一の例外**は `highway-fingerprint.js` で、下記参照)。テンプレート生成というオフライン専用の関心事を `src/engine.js` から切り離すため。

| モジュール | 役割 |
|---|---|
| `src/search/genome.js` | 探索対象の genome 表現(`rule`/`antY`/`antDir`/`cells`。**`antX` は持たない**)。生成・検証・複製・キー化・`templates.json` 用変換・ルールの原始形正規化(`canonicalRule`) |
| `src/search/mutate.js` | genome への突然変異オペレータ(rule の伸縮・ビット反転、セルの追加/削除/移動/状態変更、アリの初期行/向き変更。近傍半径と配置帯の両方でクランプ) |
| `src/search/map-elites.js` | アーカイブの汎用実装(`createArchive`/`tryInsert`/`sampleParent`/`archiveStats`/`archiveEntries`/`toJSON`/`fromJSON`/`runMapElites`)。評価関数(`evaluate`)は呼び出し側が渡す |
| `src/search/highway-trajectory.js` | ハイウェイ検出の**高速フィルタ**(`detectHighwayFromPath`)。軌跡(位置+向き)だけを見る安価な周期性検出。MAP-Elites の全候補に適用する。`directionBin` も持つ |
| `src/search/highway-fingerprint.js` | ハイウェイ検出の**厳密確認**(`verifyHighwayStrict`)。近傍セルの正規化 fingerprint による盤面込みの高コストな再検証。高速フィルタで採用された候補にだけ適用する。**唯一の例外として engine.js の CA 1ステップ処理を最小限だけ複製する**(`simulateWithBoard`)。理由は engine.js が1ステップごとの盤面スナップショットを外部に公開していないため |
| `src/search/highway-detector.js` | 上記2モジュールの**再エクスポートのみを行うファサード**。既存の import 元(`test/highway-detector.test.js`、`evaluate-projectile.js`)を壊さないために残っている。実体はここには無い |
| `src/search/evaluate-projectile.js` | genome 1件を「探索評価(`simulateSearch`、`SEARCH_LIFE`ステップ)＋ゲーム評価(`simulateSolo`、`GAME_LIFE_SEARCH_CAP`ステップ)」にかけ、`highway`(2段構え)・`game`(`arrivalStep`込み)・`descriptor`・`quality`・`viable` を返す。寿命を変えたときは `--resume-archive` で genome を再評価して再射影する(保存済み `arrivalStep` はキャップまでしか無いので閾値の当て直しでは足りない) |
| `src/search/evaluate-interaction.js` | 攻撃 × 妨害 × `deltaX` × 発射タイミングの相互作用評価(`evaluateInteraction`/`buildCounterMatrix`/`buildEscortTable`)。`simulateVersus`/`instantiateTemplate` を経由し、自前でシミュレーションを書き直さない |
| `src/search/seed-distillation.js` | Seed Distillation 本体(`captureFormationSnapshot`/`replaySeed`/`gameUsability`/`distillSeed`)。ハイウェイ形成時点の局所盤面を種として逆抽出する |
| `src/search/seed-compression.js` | 種セルの貪欲圧縮(`compressSeed`)。アリから遠い順に削除を試し、検証関数(呼び出し側が渡す)が通る場合だけ確定する |
| `src/search/search-report.js` | 評価済み個体配列から探索レポートを集計する純粋関数(`buildSearchReport`/`formatSearchReport`)。ファイルI/Oなし |

依存関係: `map-elites.js` が `genome.js`(`createRandomGenome`)と `mutate.js`(`mutate`)を import する。`mutate.js` は `genome.js`(`cloneGenome`/`canonicalRule`/`isCellDyInZone`)に依存する。`evaluate-projectile.js` は `engine.js`(`simulateSolo`/`simulateSearch`/`instantiateTemplate`)・`genome.js`・`highway-detector.js` に依存する。`evaluate-interaction.js` は `engine.js`(`simulateVersus`/`instantiateTemplate`)に依存する。`seed-distillation.js` は `highway-fingerprint.js`(`simulateWithBoard`)・`highway-trajectory.js`・`seed-compression.js` に依存する。いずれも `src/config.js` から数値定数を引く。

### `scripts/lib/` の並列化モジュール(v5で追加。v6で学習/評価用の2モジュールを追加)

| モジュール | 役割 |
|---|---|
| `scripts/lib/worker-pool.mjs` | `worker_threads` の固定サイズプール(`createPool`/`defaultWorkerCount`)。`runBatch(task, payloads)` は**投入した添字順**に結果配列を返す(完了順ではない)。ワーカーの `error`/`exit` の両方を処理し、片方だけだとジョブが永久に解決されずプールが静かに停止するのを防ぐ。ワーカーを `unref()` しない(未解決の Promise があるうちに Node が終了しないように) |
| `scripts/lib/search-worker.mjs` | 評価タスク本体(`evaluate`/`countCounters`/`coverage`/`counterRow`/`disruptProfile`)。**乱数を一切使わない純粋関数**。genome の生成・親の選択・突然変異はすべてメインスレッド(`generate-templates.mjs`)側で行う |
| `scripts/lib/match-runner.mjs`(v6) | CPU対戦の実行を1か所に集約する共有モジュール。`train-policy.mjs`(学習)・`evaluate-policy.mjs`(評価/ベンチ)・`match-worker.mjs`(並列ワーカー)が**すべてこの実装を通る**(対戦の組み方が学習と評価でズレるのを防ぐ)。`deriveSeed`(決定論的シード合成)・`makeAgent`(方策 spec から `createCpuAgent`/`createLegacyCpuAgent` を配線)・`playMatch`(1試合)・`evaluatePair`(先後入れ替えつきのN試合。CRN)を提供する。方策 spec は `{kind:'cem', weights}` / `{kind:'reference', name}` / `{kind:'legacy', policy}` の3種類のみ(JSONでワーカーへ送れるプレーンオブジェクトに限定) |
| `scripts/lib/match-worker.mjs`(v6) | `match-runner.mjs` の `evaluatePair` をワーカースレッド上で実行するためのエントリポイント。`worker-pool.mjs` が呼び出す |

**決定論の担保(v5)**: 乱数はメインスレッドだけが持ち、ワーカーは純粋関数。結果は完了順ではなく**投入した添字順**にアーカイブへ挿入する。この2条件を守るかぎり、並列数(`--workers`)やOSのスケジューリングに関係なく、`--seed` 固定なら出力が完全に決定論的になる(AGENTS.md「`--seed 1` の2回実行で出力一致」を並列化しても壊さないための設計)。**v6の学習・評価も同じ規律に従う**: `train-policy.mjs`/`evaluate-policy.mjs` は乱数をメインスレッドだけが持ち、ジョブは投入した添字順に集約するため、ワーカー数を変えても出力が一致する。

## 主要な設計判断

| 判断 | 選択 | 理由 | 代替 |
|---|---|---|---|
| アリのルール | アリ(テンプレート)ごとに `rule`(`'L'/'R'` 文字列、色数2〜16)を持つ。グローバル固定の `RULE` は廃止(v4) | 固定1ルールだと探索空間が狭く、MAP-Elites で多様なハイウェイ(方向・速度・形成時間)を見つける余地が無い | v3.1: 全アリ共通で **RRL(3色)固定**。38ステップでハイウェイを形成した(実測。`src/config.js` の `LEGACY_RULE`/`LEGACY_HIGHWAY_ONSET_STEP` として回帰フィクスチャに残存)。古典RL(2色)は9,976ステップかかり寿命内に届かない |
| 盤面 | **v5: 256列 × 256行(正方形)**、左右ラップ(`WRAP_HORIZONTAL`)、上下は場外(`WRAP_VERTICAL=false`)。攻撃軸は上下。得点ライン `SCORE_LINE_Y = HEIGHT - ZONE_DEPTH = 224` | より複雑なハイウェイと戦略が成立する余地を作るため盤面を拡大した(設計判断)。中間地帯が88→192行になった分、寿命(`ATTACK_LIFE`)とステップ速度(`STEPS_PER_SECOND`)を引き上げて体感時間を維持した | v4: 60列 × 120行、左右ラップ、上下は場外(v3.1から90度回転)。v3.1: 120列 × 60行、上下ラップ |
| 得点ゲート | **v5: 敵陣到達だけでは得点にならず、x が中央192列(`SCORE_GATE_X_MIN`..`SCORE_GATE_X_MAX`)の内側である必要がある** | 盤面を256列に広げ、かつ発射列を可変にしたことで守る側が256列すべてを警戒しなければならなくなり迎撃が成立しなくなる。得点範囲を絞ることで「門を守る」防衛目標を再構築した | ゲート無し(v4以前の設計。発射列固定・盤面60列なら成立していた) |
| 発射列(`antX`) | **v5: テンプレートから `antX` を削除し、発射時にプレイヤー/CPUが自由に選べるようにした。配置マスはアリからの相対座標 `[dx,dy,state]` で持つ** | 左右がトーラスなので x方向の平行移動は力学の厳密な対称性であり、同じテンプレートをどの列から撃っても軌道は変わらない。この対称性を活かして自由度を増やし、「どの列から撃つか」という新しい読み合いを作った | `antX` をテンプレート固有のまま固定する(v4以前。列を覚えれば迎撃が単純化する) |
| 配置可能域 | 自陣の外端32行のみ(`ZONE_DEPTH=32`。side1: `y=0..31` / side2: `y=224..255`) | アリが盤面をほぼ横断しないと得点できない＝ハイウェイが必須になる | 自陣全体(短い距離で届いてしまい、ハイウェイが要らなくなる) |
| 配置マスの範囲 | **v5: アリ近傍(チェビシェフ半径 `TEMPLATE_CELL_RADIUS`=8)に限定** | 盤面が256列になると配置帯全体(256×32=8,192マス)に一様に16マス撒く方式では密度0.2%になり、アリが配置マスを一度も踏まずに飛んでいく(v4実測で判明)。近傍に限定することで初期配置が軌道に効くようにした | 配置帯全体に一様ランダム(v4以前。60×16=960マスなら密度が十分だった) |
| **「ハイウェイ以外を落とす」仕組み** | **アリの寿命(最大ステップ数)** | カオス的運動は正味変位がほぼゼロなので、距離の制約がそのままフィルタになる。v4実測で、寿命の余裕を1.05〜2.5倍に変えても得点弾のHW割合は98%で不変(=非HWは寿命を緩めても届かない) | 明示的なハイウェイ判定を実装して弾く(複雑で、ルールとして説明しづらい) |
| **`ATTACK_LIFE` の決め方** | **v5: 探索とは独立に、後から実測で決める。** 探索中のゲーム射影は `ATTACK_LIFE` ではなく `GAME_LIFE_SEARCH_CAP`(v5.1で `ATTACK_LIFE` に連動する値に変更。現在は20,000)で走らせ、個体ごとの実到達ステップ数(`arrivalStep`)を記録。`scripts/tune-attack-life.mjs` が候補寿命を掃引し、実測(viable件数・到達時間の分散・速度クラス被覆)から確定する。**v5.1で `ATTACK_LIFE`=20,000として確定した**(1,014万評価の掃引結果より) | 盤面拡大に伴い寿命の見積もりが難しくなった(必要ステップ数が速度クラスで3,471〜20,000と幅がある)。探索をやり直さずに寿命を調整できる構造にすることで、確定の失敗コストを下げた | 寿命を先に決め打ちして探索する(v4以前。見積もりを外すと再探索が必要) |
| **防御手段** | **安価な妨害アリ**(コスト **2+ceil(マス/2)** で3〜10(v5.5)。寿命6,000(v5.3)。v5.2までは1,000。**非対称コスト導入**(v5.5)) | v3.1実測で、配置ブロックによる防御はまったく効かない(80個置いても得点率が下がらない)。一方、狙って撃った妨害アリは98%の確率で攻撃を止める。v5.5でコストを引き下げることで「迎撃札を実際に使える価格帯」を実現 | 配置ブロックで防ぐ(実測で機能しない) / 得点条件を「帯の突破」にする(機能するが、駆け引きが静的) |
| **テンプレートの評価** | **妨害込みで評価し、攻撃と妨害を共進化させる** | 空盤面だけの評価だと「妨害に強い配置」を選べず、攻撃側が探索すれば**14秒で無敵の弾**が作れてしまう(v3.1実測)。交互に回せば健全な均衡に収束する | 空盤面のみで評価(勝ち確定の弾が生まれる) / 攻撃だけ妨害込み評価(防御が追いつけない) |
| **テンプレート数** | **攻撃3種・妨害3種**(v5.5。役割別: Speed/Economy/Robust × Cheap/General/Complement。候補プールから選抜) | 人が一覧を把握して選べる数に削減。3種なら**発射行・向き・役割で一意に識別できる**(v5: `antY`/`antDir` の組。発射列 `antX` は可変になったため識別キーから外れた)ので「相手が何を撃ったか読んで対応する」ゲームになる。**UI上の複雑さと、探索側の多様性を分離**(v5.5) | 多数のテンプレート(識別できず読み合いにならない) / 自由入力のみ(良配置が上位0.1%で人間には無理) / 大量の候補で複雑化(v5.5は選抜で6種に限定) |
| **防御が決定論的になる問題** | **護衛(自分の妨害アリで相手の迎撃を壊す)** | **v5.5で3種に削減**しても、防御側が確実に識別・迎撃できてしまい膠着する可能性がある。v3.1実測で、護衛を付けると突破率が0%→100%になり、その護衛付き攻撃にも新たな迎撃が必ず見つかる(6/6)。重ねるほどトークンを食うので読み合いが成立する | 迎撃コストを上げる(単調な数値調整で読み合いが増えない) / 識別を難しくする(種数を絞った意味が消える) |
| 同時飛行 | 1陣営最大4匹 | 妨害が強すぎる(1対1では通過率2%)ため、多重攻撃で飽和させる余地が要る。v3.1実測で攻撃2 vs 妨害1 なら46%通過 | 1匹のみ(防御が一方的に強くなる) |
| 盤面のクリーンアップ | `lastToucher` が一致するマスと自分の配置マスだけを白に戻す。**v5: 全盤面走査ではなく `ant.touched`(踏んだマスのインデックス列)だけを走査する(結果は同値)** | 複数アリが同じマスを踏み合うため、単純な一括クリアだと他のアリの軌跡を壊す。盤面が65,536マスになったため全盤面走査は性能上ボトルネックになった | 一括クリア(他のアリの状態が壊れる) / クリアしない(汚れが蓄積し予測値が無意味になる) / 全盤面走査のまま(v5では性能不足) |
| 陣営の座標系 | side1 ローカル座標に正規化し、side2 は `yGlobal = HEIGHT - 1 - yLocal`(v5: `255 - yLocal`)で鏡像変換(x は共有トーラス軸なので変換しない、向きは up⇄down を入れ替え) | テンプレート集を1つだけ持てばよく、エンジンも片側分のロジックで済む | 陣営ごとに別生成(生成時間もファイルサイズも倍) |
| テンプレートの座標変換の置き場所 | **v5: `src/template.js` に独立させた(`instantiateTemplate`)** | `src/cpu.js` は `src/engine.js` を import してはいけない(実行時オンライン探索をしないことを依存関係で担保するため)。発射列可変化に伴い CPU/UI/オフラインスクリプトすべてが「相対テンプレート→絶対座標」の変換を必要とするようになったので、これを engine から独立させて共有した | `engine.js` に置く(cpu.js が engine.js を import せざるを得なくなる) / cpu.js と app.js で別々に実装(ズレのリスク) |
| CPUの構成 | **v6: 候補生成(`generateActions`)/選択(24次元線形評価器 `selectAction`)の2段構成**。事前計算テーブル(カウンター表・護衛表・識別表)は「候補生成の材料」に降格し、選択規則には使わない | v5.5までの「戦術=テーブル固定 / 戦略=カテゴリ別パラメータ」構成は、固定優先順位(`tryDefend ?? tryEscort ?? tryAttack`)を人間が決めていた。v6はこれを廃し、「何が合法か・何を観測できるか」だけを人間が与え、「何を選ぶべきか」は24次元の重みに学習させる(差分仕様 §41)。詳細は [action-centric-contract.md](action-centric-contract.md) | 全部を学習させる(状態空間が無駄に大きい) / 全部を手書きヒューリスティックにする(調整が終わらない) / 固定優先順位のヒューリスティック(v5.5までの構成。人間が戦術を教示してしまう) |
| CPUの学習手法 | **v6: 24次元 対角ガウス CEM**による自己対戦 + 固定 Reference League(4方策) | 24次元は線形評価器の重みなので勾配不要。fitness は self-play 50% + Reference League平均50%(単一固定アンカーは廃止)。1世代の中は共通乱数(CRN)で揃え、5世代ごとの held-out validation で収束を判定する(固定世代数での打ち切りをやめた)。詳細は spec.md 機能6・決定事項、契約書 §8 参照。実測(seed=1・22ワーカー): **20世代で early stop・69,400試合・4.2分**(旧CPUは v5.2 時点で約115試合/秒・96,200試合で約14分だった)。early stop 無効で60世代まで回した比較版とはリーグ平均勝率で有意差が出なかった(spec.md「v6 の学習後検証・バランス実測」) | 強化学習(この規模では過剰。Phase 2) / 単一固定アンカーとの勝率のみをfitnessにする(v5.5までの構成。アンカーの性質にfitnessが歪む問題があった) |
| 探索の並列化 | **v5: `worker_threads` によるバッチ並列**(`scripts/lib/worker-pool.mjs`)。乱数はメインスレッドのみ、結果は投入順に挿入し決定論を保つ | オフライン探索(数百万〜数千万評価)は評価が独立なので並列化の効果が大きい。ブラウザ実行時のマルチスレッド(下記 Web Worker)とは別の話 | シングルスレッドのまま(v4以前。探索時間が線形に伸びる) |
| ランタイムの Web Worker | **不採用**(実行時ブラウザは単一スレッド) | 実行時はテーブル参照のみで軽量。v4実測で1アリ1ステップあたり0.001ms未満(v5盤面での再計測は未実施)。⚠️ これは**ブラウザ実行時**の話であり、上記「探索の並列化」(開発時オフラインの `worker_threads`)とは別レイヤーの判断 | 採用(実行時にオンライン探索する設計を選んだ場合は必要) |
| ホスティング | GitHub Pages(静的配信) | ビルド不要・無料・要件を満たす | サーバーサイド構成(この規模では過剰) |
| ランタイム構成 | ビルドツール無しの素のJS + Canvas | 静的配信に合致し、依存管理の手間がない | React 等の導入(過剰) |
| シミュレーションコードの置き場所 | `src/engine.js` を DOM 非依存の純粋な JS にし、Node(生成・学習・検証)とブラウザ(実行時・先読み)の両方から共有 | 二重実装によるズレを防ぐ | Node用とブラウザ用で別実装(ズレのリスク) |

`src/cpu.js` から `src/engine.js` のシミュレーション関数を呼ばないという制約は、コード上で確認済み(`src/cpu.js` は `engine.js` を一切 import せず、座標変換が必要な箇所は `src/template.js` を使う)。実行時にオンライン探索をしない設計を、コード上の依存関係で担保している([AGENTS.md](../AGENTS.md) の Do NOT)。

### v6 CPU の Action-Centric 化

> v5.4までの「事前計算テーブルが戦術を担当し、学習方策が戦略を担当する」という役割分担(下記の旧構成)は、v6で「候補生成(`generateActions`)/選択(`selectAction`)」という別の軸の分割に置き換わった。設計意図(差分仕様 §41)は次の1文に集約される:

> **人間が決めるのは「何が合法か・何を観測できるか・どの物理情報を低コストで候補化できるか」までであり、「何を選ぶべきか」は決めない。**

具体的には:

- `generateActions(view, ctx)` が担当するのは**合法性・トークン会計・`MAX_FLYING` の空き・候補圧縮(サンプリング本数の上限)**だけ。「敵が来たから迎撃を優先する」「汚れていない列を選ぶ」といった戦術判断は一切書かない
- `counterTable`/`escortTable`/`identifyTable` は**候補を作るための物理情報**(この攻撃はこの妨害・この deltaX・この fireAtStep で止められる、という事前計算)としてのみ使う。「その情報源だから優先する」という規則は無い(`counterTable.successRate` は候補の列挙順にのみ使い、24特徴には含めない)
- `selectAction(view, actions, ctx)` が**唯一の選択規則**。`score = Σ weights[i]*features[i]` の24次元線形評価器で最大スコアの Action を選ぶ。24特徴(盤面band占有・所有権・アリ近接・トークン/飛行数の変化・所要時間など)がすべての判断材料であり、これ以外の分岐は無い
- 妨害の正確な照準(`deltaX`)は今も学習対象にしない(候補生成側の事前計算のまま)。**変わったのは「候補をどう選ぶか」を人間が決めるのをやめたこと**であって、「候補をどう作るか」の設計思想(有限手札の総当たり計算を実行時に再学習させない)はv5.5から不変

**旧構成(v5.4まで。歴史として記録)**: 事前計算テーブルが「攻撃IDの識別・使用する迎撃妨害・迎撃/護衛の相対発射列と時刻」を担当し、学習方策(カテゴリ別パラメータ)が「いつ攻撃するか・迎撃/護衛を採用するか・どの攻撃テンプレートを選ぶか・いつ自爆するか・攻撃発射列で盤面汚染を避けるか」を担当していた。v6ではこの「戦術/戦略」という区分自体を、Action型(WAIT/FIRE/SELF_DESTRUCT)の統一された選択問題へ解消した。

## テンプレート生成パイプライン(v5・実装済み)

`scripts/generate-templates.mjs` は**パイプライン制御(配線)のみ**を担当し、探索・評価・変異・アーカイブ・検出・蒸留・レポートのロジックはすべて `src/search/*` に実装され、ここでは import して呼び出すだけになっている(v4時点では一部が未配線だったが、v5で解消した)。

```
① MAP-Elites 探索(第1アーカイブ: direction × speedBin × formationBin × cost)
   + Seed Distillation(ハイウェイが見つかった個体は形成時点の局所盤面を種として逆抽出し、
     蒸留genomeも同じアーカイブへ再投入する)
  ↓
② ゲーム射影(arrivalStep <= ATTACK_LIFE を viable とする攻撃候補 / trajectoryPeriodic を
   妨害候補とする)
  ↓
③④ 攻撃/妨害それぞれの第2 MAP-Elites アーカイブ + 共進化
   (攻撃ラウンド: カウンター数最小化 / 防御ラウンド: 止められない攻撃へのカウンター追加。
    共進化中のdeltaX掃引は COEVO_DELTA_X_STRIDE=16 の粗いグリッドで近似)
  ↓
④.5 最終選抜直前のゲート: strict再評価で fingerprintVerified===true だけを残す
  ↓
⑤ **3×3を役割別に選抜**(v5.5。攻撃=Speed/Economy/Robust、妨害=Cheap/General/Complement の1種ずつ。段階⑤のdeltaX掃引は SELECT_DELTA_X_STRIDE=2 で近似。
   最終テーブル計算だけ全256列(FULL_DELTA_XS)を掃引する)
  ↓
counterTable / escortTable / identifyTable を計算し data/templates.json / data/search-archive.json /
data/search-report.json へ書き出す
```

全工程は `worker_threads`(`scripts/lib/worker-pool.mjs`)でバッチ並列化されており、乱数をメインスレッドに限定し結果を投入順に挿入することで、並列数によらず `--seed` 固定の出力が決定論的になる(上の「`scripts/lib/` の並列化モジュール」参照)。

**CLIオプション**(`scripts/generate-templates.mjs`):

| オプション | 既定値 | 意味 |
|---|---|---|
| `--seed <n>` | 1 | 乱数シード |
| `--quick` | オフ | 小予算(数分)で通しの動作確認をする。本探索には使わない |
| `--workers <n>` | `os.cpus().length - 2`(最低1) | ワーカースレッド数 |
| `--budget-min <n>` | 180(`--quick` 指定時は0=iterations打ち切り) | 第1アーカイブ探索に使う実時間の上限(分)。0なら評価回数の上限(`archive1Iterations`)で打ち切る |
| `--resume-archive <path>` | なし | 指定すると①(第1アーカイブ探索)をスキップし、保存済み `data/search-archive.json` の `archive1`/`viablePool`/`distillStats` を読み込んで②以降だけ再実行する。保存済み `arrivalStep` は保存当時の `GAME_LIFE_SEARCH_CAP` までしか記録されていないため、キャップより長い寿命へ再射影するときはアーカイブの genome を再評価してから進める(実測: 1,407件の再評価が2.1秒) |

## データの流れ

**段階1(生成)** — `scripts/generate-templates.mjs` の `buildHighwayArchive`

1. ランダム genome の初期バッチを生成し、`src/search/evaluate-projectile.js` の `evaluateProjectile` で探索評価(`SEARCH_LIFE`ステップ)する。同時に Seed Distillation(`distill:true`)を試み、蒸留に成功した genome も同じ第1アーカイブへ再投入する
2. `sampleParent → mutate → 評価 → 添字順に挿入` をバッチ単位で `--budget-min` 分(既定180分)繰り返す

**段階2(ゲーム射影)** — `projectCandidates`

3. `viable`(=寿命内到達)な個体を攻撃候補、`trajectoryPeriodic` な個体を妨害候補として抽出する

**段階3(共進化)** — `coevolve`

4. 攻撃・妨害それぞれの第2アーカイブへ投影しながら、攻撃ラウンド(カウンター数を最小化する方向へ変異)と防御ラウンド(止められない攻撃へのカウンターを追加)を `coevoRounds`(既定4)回交互に回す

**段階4(選抜)** — `filterFingerprintVerified` → `selectNineByNine`

5. 候補プールを `fingerprintVerified===true` のものだけに絞ってから(④.5)、候補プール全体のカウンター行列(攻撃 × 妨害 × deltaX × 発射タイミング)を計算し、[spec.md](spec.md) の選抜基準を満たす **9×9** を貪欲法+局所探索で選ぶ

**段階5(組み込み)** — `buildOutput`

6. 選んだ9+9(全256列のdeltaXで再計算した最終カウンター行列)と、`counterTable` / `escortTable` / `identifyTable` を `data/templates.json` に、探索アーカイブを `data/search-archive.json` に、探索レポートを `data/search-report.json` に書き出してコミット

**方策学習・検証(v6)**

7. `scripts/evaluate-policy.mjs --mode bench` を **CEM本学習の前に**実行し、`templates.json` を使って新CPU(`src/cpu.js`)と旧CPU(`src/cpu-legacy.js`。存在すれば)のスループット・候補数・特徴生成/採点の所要時間を計測して `data/benchmark.json` に出力する
8. `scripts/train-policy.mjs` が `templates.json` と `data/benchmark.json` を使い、CPU同士(24次元 Action 評価器)を自己対戦させつつ、学習しない固定 Reference League(`src/reference-policies.js` の4方策)とも対戦させ、**24次元線形評価器の重み `weights`** を CEM法(対角ガウス)で学習して `data/policy.json` に出力する
9. `scripts/evaluate-policy.mjs --mode final` が学習済み方策を Reference League 4種(各500試合)と旧CPU(`src/cpu-legacy.js` + `data/policy-v55.json`。1,000試合)に対戦させ、`data/policy.json` の `evaluation`/`tacticsLog` を上書きし `data/evaluation.json` にも書き出す
10. `scripts/tune-attack-life.mjs` が `data/search-archive.json` の `arrivalStep` を掃引し、`ATTACK_LIFE` 候補ごとの viable件数・署名多様性・速度クラス被覆・到達時間の幅を表示する。ここから実測で `ATTACK_LIFE` を確定し、`src/config.js` と `docs/spec.md` を同じコミットで更新する
11. `scripts/simulate-matches.mjs` が学習済み方策同士を大量に対戦させ、バランス指標(得点率・HW割合・盤面汚染度など)を出力する
12. ブラウザ実行時、`src/app.js` が両JSONを読み込み、プレイヤーには攻撃/妨害のタブで3種ずつ役割別に一覧提示(v5.5)、`src/cpu.js` は `weights` に従って `generateActions`→`selectAction` で選択(実行時の再シミュレーションは行わない)。発射列(`antX`)の選択とテンプレートの絶対座標化は `src/template.js` が担う
13. `src/engine.js` は実行時、試合の進行にのみ使う。MVP では自由入力が無いので**先読みシミュレーションは不要**(テンプレートの予測値はすべて `templates.json` の事前計算値)。Phase 2 で自由入力を入れるときに先読みが要る

## 干渉とテンプレートの予測値

v2 では両陣営が干渉しない設計だったが、v3 では**干渉こそが駆け引きの中心**になった。したがってテンプレートの予測値(到達時間・到達距離)は**空盤面での値**であり、実戦では相手の妨害や自軍の他のアリによってズレる。これは仕様であり、UI では「予測値」であることが分かる表示にする。

> ⚠️ 以下の実測値(干渉の強さ・共進化の収束・オフライン処理の所要時間)はいずれも **v3.1(RRL固定・120列×60行・上下ラップ)または v4(60列×120行・左右ラップ)で計測したもの**。v5.1(256×256・左右ラップ・寿命20,000・670ステップ/秒)では未再測定。🚧 テンプレート再生成後に実測して更新すること。

実測された干渉の強さ(v3.1):

| 状況 | 攻撃の通過率 |
|---|---|
| 攻撃1発のみ | 100%(定義上、得点する弾を選んでいるため) |
| 攻撃1発 vs 乱数で撃った妨害1発 | 97%(＝乱数妨害はほぼ効かない) |
| 攻撃1発 vs 狙って撃った妨害1発 | **2%**(＝98%阻止。攻撃テンプレート30件すべてについて、400回の探索でカウンターが見つかった) |
| 攻撃2発 vs 狙って撃った妨害1発 | 46% |
| 攻撃3発のみ(妨害なし) | 59%(＝**攻撃どうしも干渉する**) |

### 共進化の収束(実測v3.1・妨害手札100種 × タイミング10通り = 1,000通り)

| ラウンド | カウンター数(最小/中央/最大) | カウンターを持たない攻撃 |
|---|---|---|
| 0(乱数の手札) | 2 / 36 / 50 | 0/16件 |
| 1(攻撃が最適化) | 1 / **7** / 30 | 0/16件 |
| 2 | 2 / 13 / 33 | 0/16件 |
| 3 | 2 / 12 / 27 | 0/16件 |
| 4 | 1 / **10** / 21 | 0/16件 |

攻撃側の最適化でカウンター密度が **3.6% → 1.0%** に下がり、以後は安定します。**カウンターを1つも持たない攻撃は最後まで出ません**。所要108秒。

## オフライン処理の所要時間(v3.1/v4実測。v5は🚧未計測)

> ⚠️ 下表は v3.1(盤面120×60・RRL固定)または v4(盤面60×120・rule可変)の実測値。v5(256×256・rule可変・deltaX掃引・並列化)でのスループットは 🚧 未計測。特にワーカー並列化・deltaX掃引の追加により、単純な行数換算では推定できない。

| 処理 | 実測値(v3.1) |
|---|---|
| シミュレーション評価のスループット(120×60・寿命2,400) | 約 16,500 回/秒(Node.js 単スレッド) |
| テンプレート生成 200万評価 | 約 2分 |
| テンプレート生成 1000万評価 | 約 10分 |
| 妨害込みの1件評価(妨害100種 × タイミング10通り) | 約 12ms |
| カウンター行列の計算(攻撃60 × 妨害80 × タイミング10) | 約 1秒 |
| **1試合のシミュレーション(120×60・240秒・最大8匹)** | **約 2.8ms(362試合/秒)** |
| 方策学習(CEM・集団60 × 40試合 × 40世代) | 約 4分(⚠️ **v3.1・旧11次元方策の実測**。v6は24次元 対角ガウス CEM + Reference League + held-out validationに刷新されており、アルゴリズムが別物のため単純比較できない。🚧 v6の所要時間は実測待ち) |
| バランス検証 5,000試合 | 約 14秒 |
| 共進化4ラウンド(攻撃16件 × 妨害100種) | 約 108秒 |

**v5 の既定探索予算は `--budget-min 180`(=3時間)** と、v3.1/v4の「数分」規模から大きく伸びている(盤面拡大・256列のdeltaX掃引・厳密確認ゲートの追加によるコスト増を、`worker_threads` 並列化で補う設計)。実測スループットは 🚧 未計測。並列化(`worker_threads`)は v5 で導入済み。

🚧 **v6の学習所要時間は実測待ち**。`scripts/evaluate-policy.mjs --mode bench`(§28)が新CPUと旧CPUの `matches/sec`/`decisions/sec` を比較計測するので、学習予算の見積もりはそちらの実測値(`data/benchmark.json`)を参照すること。
