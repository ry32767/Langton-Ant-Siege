// CEM 学習・評価の対戦ワーカー(worker_threads)。
//
// ⚠️ search-worker.mjs と同じ規律: **このワーカーは乱数を一切「決めない」。**
// 試合シードの基点(seedBase)はメインスレッドが決めて payload で渡す。ワーカーは
// 「渡された条件で対戦して勝率と得点差を返すだけの純粋関数」に徹する。
// 結果を worker-pool.mjs が**投入した添字順**に並べるかぎり、ワーカー数を変えても
// 学習の出力は完全に一致する(差分仕様 §36 の再現性要件)。
//
// テンプレートは workerData で起動時に一度だけ渡す(ジョブごとに送ると転送コストが支配的になる)。

import { parentPort, workerData } from 'node:worker_threads';
import { evaluatePair } from './match-runner.mjs';

const templates = workerData?.templates;

parentPort.on('message', (msg) => {
  const { id, task, payload } = msg;
  try {
    if (task !== 'evaluatePair') throw new Error(`未知のタスク: ${task}`);
    const { seedBase, subject, opponent, games, gameOffset } = payload;
    const res = evaluatePair(templates, seedBase, subject, opponent, games, { gameOffset });
    parentPort.postMessage({ id, ok: true, result: res });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err?.stack ?? String(err) });
  }
});
