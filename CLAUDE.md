# CLAUDE.md

> Claude Code はこのファイルを自動で読み込みます。このプロジェクトの作業規約・コマンド・検証ループは [AGENTS.md](AGENTS.md) に**一元化**しています(全エージェント共通)。CLAUDE.md はそれを取り込む薄いラッパで、Claude Code 固有の補足だけを足します。

@AGENTS.md

## Claude Code 固有の補足

- ゲームバランスに関わる変更を提案するときは、`node scripts/simulate-matches.mjs --games 5000` の**出力を実際に貼って**根拠にすること。目視や推測で「良くなったはず」と言わない。
- `docs/spec.md` 第2章のルール表と `src/config.js` は必ず一致させる。片方だけ直した状態でコミットしない。
- 仕様の記述が曖昧に見えたら、推測で埋める前に `verify-v3/` のスクリプトを読むこと。REVIEW.md の数値はすべてそのコードの出力なので、挙動はそこで既に確定している。
