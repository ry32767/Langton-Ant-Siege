// ハイウェイ(周期並進運動)検出のファサード。DOM に依存しない純粋な ESM。
// 実体は2モジュールに分割されている(仕様 §26):
//   - src/search/highway-trajectory.js : 高速フィルタ(軌跡の位置+向きベース周期検出)
//   - src/search/highway-fingerprint.js: 厳密確認(盤面込みの近傍 fingerprint 再検証)
// 既存の import 元(test/highway-detector.test.js, src/search/evaluate-projectile.js)を
// 壊さないよう、このファイルからそのまま re-export する。

export { detectHighwayFromPath, directionBin } from './highway-trajectory.js';
export { verifyHighwayStrict, simulateWithBoard } from './highway-fingerprint.js';
