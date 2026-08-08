# AGENTS.md

> このプロジェクトでコードを書く**すべての AI エージェント(Codex / Cursor / Claude Code など)共通の作業規約**。作業前に読むこと。Claude Code は `CLAUDE.md` 経由で読み込む。

## ドキュメントの役割
- **README.md**(直下・人間向け)：概要・フォルダ構成・使い方。AI 専用手順は書かない。
- **AGENTS.md**(このファイル)：作業規約・コマンド・検証ループ・ドキュメント同期規約。
- **CLAUDE.md**(直下)：Claude Code 固有の補足のみ(このファイルを読み込む薄いラッパ)。
- **docs/**：`spec.md`(ゲームルール・受け入れ条件=合格ライン)、`README.md`(索引)、`data-model.md`、`architecture.md`。
- **docs/action-centric-contract.md**：v6 の CPU 実装契約。view の追加フィールド・Action の形・**24次元 Feature Encoder の凍結表**・Reference League・`data/policy.json` の新スキーマ。**CPU/学習/評価に触るなら spec.md より先にこれを読む**(名前と式が一字一句ここで決まっている)。
- **REVIEW.md**(直下)：実測レビュー(v1本編 + 付録B/C/D/E)。現仕様の制約の根拠。**ルールを変えたくなったら先にこれを読む。**
- **verify-v3/ verify-highway/**：REVIEW.md の数値を出した検証スクリプト。**仕様の曖昧な箇所は、まずここを読んで挙動を確認する**(REVIEW.md の全数値はこのコードの出力なので、これが事実上の実行可能な仕様書になっている)。

作業前に：概要は README.md、**ゲームルールと受け入れ条件は `docs/spec.md`(第2章のルール表は全機能の前提)**、盤面/アリ/テンプレートの形は `docs/data-model.md`、CPU設計や全体構成の判断は `docs/architecture.md` を読む。

## Tech Stack
| レイヤー | 技術 |
|---|---|
| フロントエンド | バニラ JavaScript (ESM) + HTML5 Canvas(ビルド不要) |
| オフライン処理 | Node.js スクリプト(開発時のみ実行、依存パッケージ無し) |
| Backend / DB | なし(静的サイト) |
| Deploy | GitHub Pages |

`package.json` は `"type": "module"` を宣言するためだけに置いてある(依存パッケージなし)。これが無いと `scripts/*.mjs` から `src/*.js` を `import` できない。

## Commands
```bash
npx serve .                                  # ローカルで動作確認(HTTPサーバー必須。file:// では動かない)
node --test                                  # test/ の単体テスト(Node組み込みテストランナー)
node scripts/generate-templates.mjs --quick --out-dir /tmp/tpl-check   # 通し確認(数分。本番設定ではない)
node scripts/generate-templates.mjs --budget-min 180 --workers 22   # 本探索(実時間で打ち切る)
node scripts/generate-templates.mjs --seed 1 --iterations 4200000   # 上の成果物を再現する(下記)
node scripts/tune-attack-life.mjs            # 探索アーカイブから ATTACK_LIFE の候補を掃引して比較
node scripts/generate-templates.mjs --resume-archive data/search-archive.json  # ①を省略して②〜⑤だけ再実行
node scripts/evaluate-policy.mjs --mode bench              # ★学習の**前**に必須。性能ベンチ(v6 §28)→ data/benchmark.json
node scripts/train-policy.mjs                # 24次元 Action 評価器を CEM で学習 → data/policy.json(数十分)
node scripts/train-policy.mjs --quick --out /tmp/policy-check.json  # 学習の通し確認(数分。本番設定ではない)
node scripts/evaluate-policy.mjs --mode final             # ★学習の**後**。リーグ2,000試合＋旧CPU1,000試合(v6 §26)
node scripts/simulate-matches.mjs --games 5000            # バランス検証(得点率・HW割合・盤面汚染度・先手勝率)
node scripts/simulate-matches.mjs --games 100 --seed 1    # シード固定で再現性を確認(2回実行して出力一致)
```

**v6(Action-Centric CPU)の学習・検証の順序**。この順を崩さないこと:

1. `evaluate-policy.mjs --mode bench` … 差分仕様 §28 が「CEM 本学習前に性能計測を必須」としている。
   ここで足りないと分かったときの最適化順は §29 で、**世代数の削減は最後**。
2. `train-policy.mjs` … `--workers N`(既定 = min(コア数-2, 22))。乱数はメインスレッドだけが持ち
   ワーカーは純粋関数なので、**ワーカー数を変えても `--seed` が同じなら出力は一致する**。
3. `evaluate-policy.mjs --mode final` … `data/policy.json` の `evaluation` / `tacticsLog` を上書きする。
4. `simulate-matches.mjs --games 5000` … バランス指標11項目。

⚠️ **`scripts/verify-v54.mjs` は v6 で退役した**(`archive/verify-v54.mjs`)。「迎撃/護衛」という戦術
カテゴリを前提に数えるスクリプトだったが、v6 の CPU には WAIT / FIRE / SELF_DESTRUCT しか無く、
妨害を「迎撃」と呼ぶか「護衛」と呼ぶかは人間の解釈でしかない(差分仕様 §3・§8)。
戦術の使用回数は `evaluate-policy.mjs --mode final` の戦術使用ログが出す(§27。**fitness には入れない**)。

⚠️ **通し確認(`--quick`)には必ず `--out-dir` を付ける。** 付けないと `data/templates.json` を直接上書きし、以降の `simulate-matches` / `train-policy` が「動作確認用の粗いテンプレート」を本物だと思って走る(実際に踏みかけた)。

⚠️ **`generate-templates.mjs` は import しただけで探索が走り出す**(トップレベルで実行される)。構文チェックをしたいだけなら `node --check scripts/generate-templates.mjs` を使うこと。`node -e "import('./scripts/generate-templates.mjs')"` は3時間の本探索を起動してしまう(実際に起きた)。

**探索の再現性について(v5)**: 探索は worker_threads で並列化してあるが、**乱数はメインスレッドだけが持ち、ワーカーは純粋関数**で、結果は完了順ではなく**投入した添字順**にアーカイブへ入る。バッチ幅もワーカー数から導出せず固定値にしてある。したがって `--seed` と `--iterations` が同じなら**ワーカー数を変えても成果物は一致する**。
`--budget-min`(実時間で打ち切る)を使った場合だけはマシンの速さで反復回数が変わるので、実行後にログと `data/search-archive.json` の `reproduceCommand` に「その回の反復回数」が残る。再生成するときはそれを `--iterations` に渡す。

**`ATTACK_LIFE` を変えるときに探索をやり直さない**: 段階①(ハイウェイ発見)は仮想盤面を `SEARCH_LIFE` まで走らせるので寿命に依存せず、ゲーム射影も `GAME_LIFE_SEARCH_CAP` で走らせて個体ごとの `arrivalStep` を記録している。つまり寿命を変えて必要なのは②以降だけ。`--resume-archive data/search-archive.json` で①を丸ごと省略して作り直せる。**寿命を変えたら必ずこれで再生成すること**(古い寿命で選んだ9×9を残さない)。

⚠️ **所要時間は `DISRUPT_LIFE` にほぼ比例する。**「数分」は `DISRUPT_LIFE=1,000` のときの値。段階⑤のカウンター行列は (攻撃 × 妨害 × deltaX × タイミング) の直積を実シミュレーションで回すので、妨害の寿命がそのまま1評価のコストになる。実測: **`DISRUPT_LIFE=6,000` で 48.2分**(累計 2,195,199 評価)。寿命を上げるときは待ち時間も同じ倍率で増えると見積もること。

## Verification Loop(検証ループ)
**機能を実装したら、完了宣言の前に必ず回す。** 最重要の規約。

1. 実装する
2. 検証する：`node --test`(該当する単体テストがあれば実行)。**「0 tests」で green になっていないか必ず出力の件数を見る**
3. **ルール・数値・エンジンに手を入れた場合は `node scripts/simulate-matches.mjs --games 5000` を実行し、`docs/spec.md` の「バランス指標」の範囲内に収まっているか確認する**
4. テンプレート生成ロジックや `src/engine.js` を変えた場合は `node scripts/generate-templates.mjs` → `node scripts/train-policy.mjs` を再実行し `data/*.json` を更新
5. `docs/spec.md` の該当機能の**受け入れ条件**を1つずつ照合(自動テストが無いものは `npx serve .` でブラウザ手動確認)
6. 1つでも失敗・未達なら原因を直して 2 に戻る
7. すべて green かつ全受け入れ条件 ○ かつバランス指標が範囲内で初めて「完了」

ルール：テストにエラーがある状態で「完了」と言わない。仕様の不備で満たせないときは `docs/spec.md` の「未決定事項」に追記して相談。手動確認は何をどう確認したか一言報告。テストの無い受け入れ条件は可能なら先にテストを書く。

## エンジンの参照実装
`src/engine.js` の1ステップ処理・得点判定・クリーンアップは、**`verify-v3/matchbench.mjs` の `match()` が参照実装**(REVIEW.md の試合スループットとバランス数値はこれで出した)。挙動を変えるときは、変えた理由を `docs/spec.md` の決定事項に書く。特に次の4点は取り違えやすい:

- **回転は「踏んだ時点の状態」で決める**(状態を進めた後の値ではない)。`d = RULE[st]==='R' ? d+1 : d-1; board[i] = (st+1)%3;` の順
- **配置マスは状態1(灰)で書き込む**。状態2(黒)ではない。既に非白のマスも無条件で1に上書きする
- **判定は前進後**。移動先が x<0 なら消滅、x≥104 なら得点して消滅、それ以外で `steps>=life` なら消滅
- **発射時に `lastToucher` を自分のIDで埋める**。だから「他のアリが後から踏んだ配置マス」はクリーンアップで残る

## バランスに関わる変更の規律
ゲームルールと数値は**実測に基づいて決まっている**。目視では破綻に気づけないことが v1 レビューで実証済み。だから：

- **ルールや数値を変えたら、必ず `simulate-matches.mjs` を回して数値で確認する。** 「良くなった気がする」で確定しない
- 特に **得点弾のハイウェイ割合(95%以上)**、**カウンターを持たない攻撃テンプレートの数(0件)**、**攻撃＋護衛の突破率(60〜100%)** は、この作品の面白さそのものなので毎回見る
- 数値は `src/config.js` に一元化し、ハードコードしない
- 以下の制約は**外すと壊れることが実測済み**。外したくなったら先に `REVIEW.md` を読み、理由を `docs/spec.md` の決定事項に書いてから変える
  - **アリの寿命(攻撃 `ATTACK_LIFE`=20,000 / 妨害 `DISRUPT_LIFE`=6,000)** — 攻撃側はこれが「ハイウェイ以外を落とす」唯一の仕組みなので緩めると成立しなくなる。⚠️ **妨害側は v5.3 で寿命による担保をやめ、`DISRUPT_MAX_LOCAL_Y`(=盤面中央)を超えたら死ぬ空間制約に置き換えた**ため、妨害の寿命は「敵陣に到達させない」ための値ではなくなっている(数値は `src/config.js` が正)
  - **配置可能域を自陣の端16列に限定** — 広げると横断距離が縮み、ハイウェイが不要になる
  - **RRL(3色)ルール** — 古典RL(2色)に戻すと、ハイウェイ形成に9,976ステップかかり寿命内に届かない
  - **`lastToucher` によるクリーンアップ** — 単純な一括クリアにすると他のアリの軌跡を壊す
  - **防御はブロックではなく妨害アリ** — 配置ブロックによる防御は実測で効果ゼロ
  - **テンプレートは妨害込みで共進化させて生成する** — 空盤面だけで評価すると「カウンターを持たない攻撃」が14秒で作れてしまう
  - **候補プールを間引くときは必ずハイウェイ署名で層化する**(v5) — アーカイブの列挙順は「セルが最初に埋まった順」＝ありふれた署名順なので、素朴に先頭 N 件を取ると選抜プールが最頻署名で埋まる。選抜スコアが多様性を評価していても「プールに無いものは選べない」
  - **得点ゲートはテンプレートの実力を左右しない**(v5) — 左右がトーラスなので到達列をゲート内に入れる発射列は必ず存在する。したがって探索の viable 判定は `scored`(ゲート適用後)ではなく `reached`(敵陣到達)で行う。ゲートが効くのは実プレイで「どの列から撃つか」を縛るところだけ
  - **カウンター表は絶対座標ではなく `deltaX` の表**(v5) — 平行移動不変性(`test/evaluate-interaction.test.js`)がこの設計の根拠。「ゲートの外へずらした」を成功と数えると平行移動で無効になるカウンターを記録してしまうので、`evaluateInteraction` の判定は必ず敵陣到達で行う

## ドキュメント同期規約
コードだけ進んで docs が古くなると土台が嘘になる。だから：
- **仕様や挙動を変えたら、対応するドキュメントを同じ変更(コミット)で更新する**：ゲームルール・機能・受け入れ条件・タスク→`docs/spec.md`、盤面/アリ/陣営/テンプレート/方策の形→`docs/data-model.md`、CPU設計や全体構成の判断→`docs/architecture.md`、使い方・セットアップ・フォルダ構成→`README.md`。
- **`src/config.js` の数値を変えたら `docs/spec.md` 第2章のルール表も同じ変更で直す。**
- **docs を増減したら `docs/README.md` の索引も直す。** Mermaid 図を持つ docs は実装とズレたら図も直す。
- **ファイルやフォルダを移動したら、`README.md` のフォルダ構成と `REVIEW.md` の付録のパス参照も直す。**
- 今すぐ直せないズレは `docs/spec.md` の「未決定事項」に残して放置しない。

## コーディング規約
- `src/engine.js` はブラウザ・Node のどちらからも読み込める純粋な JS(ESM)にする(DOM や `window` に依存しない)。オフラインの生成・学習・検証スクリプトと、実行時のブラウザロジック・先読みシミュレーションの**すべてが同じコードを共有する**ため
- 盤面は `Uint8Array` で持つ(セルをオブジェクト化しない)
- 数値定数は `src/config.js` に集約する
- 単体テストは `test/*.test.js` に置く(`node --test` が拾う)
- コメントは日本語でよい

## Do NOT
- `src/engine.js` に DOM 依存コードを混ぜない(Node のスクリプトから使えなくなる)
- `src/cpu.js` から `src/engine.js` のシミュレーション関数を呼ばない(実行時探索をしない設計をコード上の依存関係で担保する)
- 数値をソースに直書きしない(`src/config.js` に置く)
- **バランスに関わる変更を `simulate-matches.mjs` で確認せずに完了と言わない**
- README.md に AI 向け手順を書かない(人間向けに保つ)
- 仕様を変えたのに docs を直さず「完了」と言わない
- `data/templates.json` `data/policy.json` を手で直接編集しない(ロジックを直したらスクリプトを再実行して更新)
- `archive/` の中身を実装の参照元にしない(過去バージョンの記録。現行は `verify-v3/` `verify-highway/`)
