# archive/

過去バージョンの配布物。**実装の参照元にはしない**(現行の仕様は `docs/`、現行の検証スクリプトは `verify-v3/` と `verify-highway/`)。

| ファイル | 内容 |
|---|---|
| `files.zip` | v1 のドキュメント一式(README / AGENTS / CLAUDE / docs) |
| `langton_ant_siege_v2.zip` | v2 のドキュメント + `verify-v2/` 検証スクリプト。REVIEW.md 本編・付録B が参照 |
| `langton_ant_siege_v3.zip` | v3.0 のドキュメント + `verify-v3/` `verify-highway/`。ドキュメントは v3.1 の `docs/` に置き換え済み |
| `verify-scripts.zip` | v1 の検証スクリプト。REVIEW.md 本編が参照 |
| `highway-options.zip` | ハイウェイを敷くルールの網羅探索の記録(`HIGHWAY-OPTIONS.md` + `verify-highway/`) |
| `highway-demo.html` | ハイウェイ形成をブラウザで見るデモ |
| `verify-v54.mjs` | v5.4 の CPU 行動内訳スクリプト(旧 `scripts/verify-v54.mjs`)。**v6 で退役**。「迎撃/護衛/攻撃/自爆」という戦術カテゴリを前提に数えていたが、v6 の Action-Centric CPU にはそのカテゴリ自体が無い(WAIT / FIRE / SELF_DESTRUCT の3種しかなく、妨害を「迎撃」と呼ぶか「護衛」と呼ぶかは人間の解釈でしかない)。後継は `scripts/evaluate-policy.mjs --mode final` の戦術使用ログ(差分仕様 §27)|
