// worker_threads の固定サイズプール。
//
// ⚠️ 決定論の担保:
//   - 乱数はメインスレッドだけが持つ(ワーカーは純粋関数。search-worker.mjs 冒頭を参照)
//   - `runBatch` は **完了順ではなく投入した添字順**に結果を並べて返す
// この2つを守るかぎり、並列数を変えても `--seed 1` の出力はバイト単位で一致する。
//
// 依存パッケージは使わない(このプロジェクトは package.json に依存を持たない)。

import { Worker } from 'node:worker_threads';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, 'search-worker.mjs');

/** 既定のワーカー数。物理コアを2つ残して OS とメインスレッドの取り分にする。 */
export function defaultWorkerCount() {
  return Math.max(1, os.cpus().length - 2);
}

/**
 * @param {number} size ワーカー数
 * @param {object} [options]
 * @param {string} [options.workerPath] ワーカーのモジュールパス(既定は MAP-Elites 探索ワーカー)。
 *   v6 で CEM 学習の対戦ワーカー(match-worker.mjs)も同じプールを使うため差し替え可能にした。
 * @param {object} [options.workerData] ワーカー起動時に一度だけ渡すデータ(テンプレート等)。
 *   ⚠️ 乱数の種をここに入れないこと(乱数はメインスレッドだけが持つ。冒頭の決定論の担保を参照)。
 */
export function createPool(size = defaultWorkerCount(), options = {}) {
  const workerPath = options.workerPath ?? WORKER_PATH;
  const workerData = options.workerData;
  const workers = [];
  const idle = [];
  const queue = []; // { task, payload, resolve, reject }
  const pending = new Map(); // id -> { resolve, reject, worker }
  let nextId = 1;
  let destroyed = false;

  function dispatch(worker) {
    const job = queue.shift();
    if (!job) {
      idle.push(worker);
      return;
    }
    const id = nextId++;
    pending.set(id, { resolve: job.resolve, reject: job.reject, worker });
    worker.postMessage({ id, task: job.task, payload: job.payload });
  }

  for (let i = 0; i < size; i++) {
    const worker = new Worker(workerPath, workerData === undefined ? undefined : { workerData });
    worker.on('message', (msg) => {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(new Error(msg.error));
      if (!destroyed) dispatch(worker);
    });
    // ⚠️ error と exit の両方を扱う。片方だけだと、ワーカーが OOM 等で落ちたときに
    // そのワーカーに割り当て済みのジョブが永久に解決されず、プール全体が静かに停止する
    // (原因が分からないまま「なぜか終わらない」状態になる)。
    const failWorkerJobs = (err) => {
      for (const [id, entry] of pending.entries()) {
        if (entry.worker === worker) {
          pending.delete(id);
          entry.reject(err);
        }
      }
    };
    worker.on('error', (err) => failWorkerJobs(err));
    worker.on('exit', (code) => {
      const i = idle.indexOf(worker);
      if (i >= 0) idle.splice(i, 1);
      if (!destroyed) failWorkerJobs(new Error(`ワーカーが終了コード ${code} で落ちた`));
    });
    // ⚠️ unref() してはいけない。ワーカーが待機中で他にハンドルが無いと、未解決の
    // Promise は event loop を生かさないので Node が黙って終了してしまう(実測)。
    workers.push(worker);
    idle.push(worker);
  }

  function submit(task, payload) {
    if (destroyed) return Promise.reject(new Error('プールは破棄済み'));
    return new Promise((resolve, reject) => {
      queue.push({ task, payload, resolve, reject });
      const worker = idle.pop();
      if (worker) dispatch(worker);
    });
  }

  /**
   * payloads を全部投入し、**投入した添字順**に結果の配列を返す。
   * 1件でも失敗したら全体を reject する(黙って null を混ぜない)。
   */
  async function runBatch(task, payloads, onProgress = null) {
    if (payloads.length === 0) return [];
    if (!onProgress) return Promise.all(payloads.map((p) => submit(task, p)));
    let done = 0;
    return Promise.all(
      payloads.map((p) =>
        submit(task, p).then((r) => {
          done++;
          onProgress(done, payloads.length);
          return r;
        }),
      ),
    );
  }

  async function destroy() {
    destroyed = true;
    await Promise.all(workers.map((w) => w.terminate()));
  }

  return { size, submit, runBatch, destroy };
}
