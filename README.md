# Langton Ant Siege

> ラングトンのアリが敷く「ハイウェイ」を弾道として撃ち合う、1人用のリアルタイム攻城ゲーム

盤面の自分側の端にマスとアリを配置して発射すると、アリはセルオートマトンのルールで自動的に動き出し、しばらくすると**まっすぐな「ハイウェイ」を敷いて盤面を縦に横断していきます**。反対側の端にある敵の陣地の、しかも**盤面中央の得点ゲート**まで届けば1得点(左右の端は「壁」で得点になりません)。

アリには寿命があるので、ハイウェイに乗れない弾はどんなに暴れても届きません。相手の弾を止めたいときは、安い**妨害アリ**を撃って軌道上の跡を踏み荒らします。逆に自分の攻撃を守るために妨害アリを**護衛**として随伴させることもでき、攻撃 → 迎撃 → 護衛 → 再迎撃 の読み合いになります。CPU相手(またはCPU同士)の対戦ができ、ビルド不要でGitHub Pagesにそのまま公開できます。

## 主な機能
- **ハイウェイを敷くアリ** — アリ(テンプレート)ごとに固有のルール(`'L'/'R'` の文字列、色数2〜16)と配置マスの状態を持つ。しばらく動くと直線的なハイウェイを形成し、盤面を縦に横断していく。左右はつながっている(トーラス)、上下は場外(得点/消滅)。異なる色数のアリが同じマスを踏むと、盤面の生値をお互いの色数で割った余りとして解釈し合う(異種ルールの衝突)
- **発射列を自分で選べる** — テンプレートの配置マスはアリからの相対位置で決まっていて、どの列(左右)から撃つかは発射のたびに自由に選べる。ただし得点できるのは盤面中央の帯に着弾する列だけなので、「どこから撃つか」も駆け引きになる
- **準備フェーズ(資源トークン)** — 1秒ごとにトークンが貯まり、自陣の端の帯にマスとアリを配置。攻撃アリ5トークン、妨害アリ3トークン、マス1個につき1トークン
- **寿命によるフィルタ** — アリには最大ステップ数があり、ハイウェイに乗った弾しか敵陣まで届かない
- **妨害アリ** — 安くて寿命の短いアリ。相手のハイウェイの上を踏み荒らして軌道を崩す。自分の攻撃を守る**護衛**にも使える。アリは攻撃・妨害あわせて1陣営4匹まで同時に飛ばせる
- **テンプレート選択(攻撃9種 + 妨害9種)** — 事前生成・事前検証されたテンプレートを攻撃/妨害のタブから選ぶ。9種に絞ってあるので、飛来中の敵の弾がどれかを**発射した行と向きで識別できる**
- **CPU AI** — 「どの札がどの札に勝つか」は事前計算テーブル、「いつ何にトークンを使うか」はCPU同士の自己対戦(CEM法)で学習した方策。実行時は軽量なテーブル参照のみ
- **対戦モード選択** — 「プレイヤー vs CPU」「CPU vs CPU」を選んで開始

> ゲームルールの詳細と各機能の受け入れ条件は [docs/spec.md](docs/spec.md)。自由入力(テンプレート以外の配置)は MVP では実装しません(理由は spec.md 機能3)。

## 技術スタック
- **フロントエンド**: バニラ JavaScript (ESM) + HTML5 Canvas(ビルド不要)
- **オフライン処理**: Node.js スクリプト(開発時のみ実行、`data/*.json` を生成)
- **デプロイ**: GitHub Pages(静的ファイルをそのまま配信)

## フォルダ構成

実装完了時点のプロジェクト構成。

```
Langton-Ant-Siege/
├── README.md         # このファイル(人間向けの概要・使い方)
├── AGENTS.md         # AI エージェント共通の作業規約・検証ループ
├── CLAUDE.md         # Claude Code 固有の補足(AGENTS.md を読み込む)
├── REVIEW.md         # 実測レビュー(v1本編 + 付録B/C/D/E)。現ルールの根拠
├── package.json      # type:module のみ。依存パッケージなし
├── .nojekyll         # GitHub Pages の Jekyll 処理を無効化
├── index.html        # エントリーポイント
├── DESIGN.md         # 見た目(配色・書体・余白)の唯一の正。src/tokens.css の値の根拠
├── docs/             # 仕様・設計ドキュメント
│   ├── README.md     #   索引
│   ├── spec.md       #   ゲームルール・機能・受け入れ条件(契約書)
│   ├── data-model.md #   盤面/アリ/テンプレート/genome/探索アーカイブ/方策のデータ構造
│   └── architecture.md #  構成と設計判断
├── src/
│   ├── config.js     # 盤面サイズ・寿命・コスト・トークン・速度などの数値定数(一元管理)
│   ├── engine.js     # アリ・盤面・得点判定・トークン・勝敗などの試合ルール(Node/ブラウザ共通)
│   ├── template.js   # 発射列(antX)の実体化。相対テンプレート→絶対座標の変換(engine/cpu/app/scriptsが共有)
│   ├── search/       # MAP-Elites 探索の型・変異・アーカイブ・検出・蒸留・レポート(オフライン生成が使う)
│   │   ├── genome.js               #   探索対象の genome 表現(rule/antY/antDir/cells。antXは持たない)
│   │   ├── mutate.js               #   genome への突然変異オペレータ
│   │   ├── map-elites.js           #   アーカイブの汎用実装(挿入・サンプリング・実行ループ)
│   │   ├── highway-trajectory.js   #   ハイウェイ検出:高速フィルタ(軌跡の周期性)
│   │   ├── highway-fingerprint.js  #   ハイウェイ検出:厳密確認(近傍セルfingerprint)
│   │   ├── highway-detector.js     #   上記2つの再エクスポート用ファサード
│   │   ├── evaluate-projectile.js  #   genome 1件の探索評価+ゲーム評価
│   │   ├── evaluate-interaction.js #   攻撃×妨害×deltaX×タイミングの相互作用評価
│   │   ├── seed-distillation.js    #   Seed Distillation(ハイウェイ形成局面から初期配置を逆抽出)
│   │   ├── seed-compression.js     #   種セルの貪欲圧縮
│   │   └── search-report.js        #   探索結果の集計レポート
│   ├── app.js        # 画面制御・入力・描画・ゲームループ
│   ├── cpu.js        # テンプレート/方策の読み込みと、攻撃/妨害の意思決定(engine.jsには依存しない)
│   ├── tokens.css    # 配色・書体・余白のデザイントークン(DESIGN.md が唯一の正)
│   └── style.css
├── test/             # node --test が拾う単体テスト
│   ├── config.test.js
│   ├── engine.test.js
│   ├── cpu.test.js
│   ├── genome.test.js
│   ├── mutate.test.js
│   ├── map-elites.test.js
│   ├── highway-detector.test.js
│   ├── evaluate-projectile.test.js
│   ├── evaluate-interaction.test.js
│   ├── search-report.test.js
│   └── integration.test.js
├── scripts/          # 開発時のみ実行する Node スクリプト
│   ├── generate-templates.mjs   # 攻撃/妨害テンプレートを共進化+選抜で生成(worker_threadsで並列化)
│   ├── train-policy.mjs         # CPU同士の自己対戦(CEM法)で方策を学習
│   ├── simulate-matches.mjs     # バランス検証(得点率・HW割合・盤面汚染度など)
│   ├── tune-attack-life.mjs     # 探索アーカイブからATTACK_LIFE(攻撃アリの寿命)候補を掃引
│   └── lib/
│       ├── worker-pool.mjs      #   worker_threads の固定サイズプール
│       └── search-worker.mjs    #   評価タスクを実行するワーカー本体(乱数を持たない純粋関数)
├── data/             # 生成物(コミット対象・手で編集しない)
│   ├── templates.json           # 生成済みテンプレート 9+9 と事前計算テーブル
│   ├── policy.json              # 学習済み方策
│   ├── search-archive.json      # MAP-Elites 探索アーカイブのダンプ(ブラウザは読み込まない。tune-attack-life.mjsが参照)
│   └── search-report.json       # 探索結果の統計レポート(スロープ分布・Seed Distillationの効果など)
├── verify-v3/        # v3ルールの検証スクリプト(REVIEW 付録C/D/E が参照)
├── verify-highway/   # ハイウェイ検出器とルール網羅探索(REVIEW 付録C が参照)
└── archive/          # 過去バージョンの配布物・検証スクリプトのzip(参照用)
```

## セットアップ

```bash
# 依存パッケージなし(バニラJS)。ローカル確認は静的サーバーを立てるだけ
npx serve .
```

**HTTPサーバーが必須です。** `data/*.json` を `fetch` で読み込むため、`index.html` をダブルクリックして `file://` で開くと動きません。

テンプレートと方策を作り直したいときは:

```bash
node scripts/generate-templates.mjs           # 既定は本探索(--budget-min 180 = 3時間)。動作確認だけなら --quick を付ける
node scripts/generate-templates.mjs --quick   # 小さな予算(数分)で通しの動作確認
node scripts/train-policy.mjs                 # 数分
node scripts/tune-attack-life.mjs             # 探索アーカイブからATTACK_LIFE(攻撃アリの寿命)候補を掃引して表示する
```

`generate-templates.mjs` の主なオプション:

| オプション | 既定値 | 意味 |
|---|---|---|
| `--seed <n>` | 1 | 乱数シード(同じシードなら結果が再現する) |
| `--quick` | オフ | 小予算で通しの動作確認をする。本番のテンプレート生成には使わない |
| `--workers <n>` | 使用可能なCPUコア数-2(最低1) | 並列に使うワーカースレッド数 |
| `--budget-min <n>` | 180 | ハイウェイ探索に使う実時間の上限(分) |

## 使い方

1. 開始画面で「プレイヤー vs CPU」または「CPU vs CPU」を選ぶ
2. (プレイヤー操作時)攻撃タブの9種から、コスト・到達時間・カウンター数を見て一手を選び、撃つ列(自陣内のどこから発射するか)を選ぶ
3. トークンが足りていれば「発射」を押す。アリがハイウェイを敷いて盤面を横断し、反対の端の敵陣の**盤面中央の帯**に届けば1得点(左右の端に着弾しても得点にはならない)
4. 相手のアリが飛んできたら、識別表示(A1〜A9)を見て、それを止められる妨害を推奨タイミングで撃ち込む
5. 自分の攻撃に迎撃が来たら、護衛の妨害アリを送って迎撃側の軌道を崩す
6. 先に5得点で勝利(240秒で時間切れの場合は得点が多い方の勝ち。同点なら引き分け)

## 開発者・AI エージェント向け
- 作業規約・検証ループ・ドキュメント同期は [AGENTS.md](AGENTS.md)(全エージェント共通)
- Claude Code 固有の補足は [CLAUDE.md](CLAUDE.md)
- ゲームルール・受け入れ条件は [docs/spec.md](docs/spec.md)、他の設計は [docs/README.md](docs/README.md)
- ルールや数値を変える前に [REVIEW.md](REVIEW.md) の**付録C/D/E**を読むこと(現在の制約は実測に基づいて決まっている。本編と付録Bは過去バージョンの記録)

## ライセンス
未定
