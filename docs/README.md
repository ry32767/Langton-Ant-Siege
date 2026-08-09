# ドキュメント

全体概要は [../README.md](../README.md)、作業規約は [../AGENTS.md](../AGENTS.md)。

| ドキュメント | 内容 |
|---|---|
| [spec.md](spec.md) | ゲームルール・機能・受け入れ条件・検証戦略・タスク(契約書) |
| [data-model.md](data-model.md) | 盤面・アリ・陣営・テンプレート・genome/探索アーカイブ・方策のデータ構造とJSONの形 |
| [architecture.md](architecture.md) | オフライン事前生成＋実行時テーブル参照という構成の設計判断と、実測に基づく所要時間 |
| [action-centric-contract.md](action-centric-contract.md) | v6 Action-Centric CPU の**実装契約**。view の追加フィールド・Action の形・26次元 Feature Encoder の凍結表・Reference League・`policy.json` の新スキーマ。engine / cpu / 学習 / 評価 / テストはこの文書だけを見て書ける |
| [../DESIGN.md](../DESIGN.md) | 見た目(配色・書体・余白)の唯一の正。値の実体は `src/tokens.css` |
| [../REVIEW.md](../REVIEW.md) | 実測レビュー(v1本編 + 付録B: ダメージ定義 + 付録C: ハイウェイとジオメトリ + 付録D: 妨害込み評価と共進化 + 付録E: 9種への絞り込みとCPU設計)。現仕様の各制約が「なぜ必要か」の根拠(v3.1 時点の実測。v4/v5 の盤面・ルール空間では未再測定。🚧 spec.md の「未決定事項」参照) |
| [../verify-v3/](../verify-v3/) [../verify-highway/](../verify-highway/) | REVIEW.md の数値を出した検証スクリプト。**仕様が曖昧に見えたらここを読む**(挙動は既にここで確定している) |
