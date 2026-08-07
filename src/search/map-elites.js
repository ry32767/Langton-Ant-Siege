// MAP-Elites アーカイブの汎用実装。純粋なデータ操作のみ(engine.js は import しない)。
// 評価関数(evaluate)は呼び出し側から渡されるだけで、中身には一切依存しない。
//
// アーカイブの内部表現は疎な Map(キーは記述子ビンを連結した文字列)。
// dims の順序でキーを組み立てるので、次元数が増えても密配列で爆発しない。

import { createRandomGenome } from './genome.js';
import { mutate } from './mutate.js';

/**
 * MAP-Elites アーカイブを作る。
 * dims: [{ name: 'direction', bins: 8 }, ...] 各軸を 0..bins-1 の整数ビンで受け取る前提。
 */
export function createArchive({ dims }) {
  return {
    dims: dims.map((d) => ({ name: d.name, bins: d.bins })),
    cells: new Map(),
  };
}

/** descriptor(記述子オブジェクト)からアーカイブのセルキー文字列を作る。 */
function descriptorKey(archive, descriptor) {
  return archive.dims.map((d) => descriptor[d.name]).join(',');
}

/**
 * individual をアーカイブに挿入を試みる。
 * 空セルなら必ず 'inserted'。埋まっているセルは quality が厳密に大きいときだけ 'replaced'、
 * それ以外(同値含む)は 'rejected'。
 */
export function tryInsert(archive, individual) {
  const key = descriptorKey(archive, individual.descriptor);
  const existing = archive.cells.get(key);
  if (existing === undefined) {
    archive.cells.set(key, individual);
    return 'inserted';
  }
  if (individual.quality > existing.quality) {
    archive.cells.set(key, individual);
    return 'replaced';
  }
  return 'rejected';
}

/** 埋まっているセルから一様ランダムに1件返す。空アーカイブなら null。 */
export function sampleParent(archive, rng) {
  const entries = Array.from(archive.cells.values());
  if (entries.length === 0) return null;
  const i = Math.floor(rng() * entries.length);
  return entries[Math.min(i, entries.length - 1)];
}

/** アーカイブの統計を返す。total は dims の bins をすべて掛けた理論上のセル数。 */
export function archiveStats(archive) {
  const total = archive.dims.reduce((acc, d) => acc * d.bins, 1);
  const filled = archive.cells.size;
  const coverage = total > 0 ? filled / total : 0;
  let qualityMax = -Infinity;
  let qualitySum = 0;
  for (const individual of archive.cells.values()) {
    qualitySum += individual.quality;
    if (individual.quality > qualityMax) qualityMax = individual.quality;
  }
  const qualityMean = filled > 0 ? qualitySum / filled : 0;
  return {
    filled,
    total,
    coverage,
    qualityMax: filled > 0 ? qualityMax : 0,
    qualityMean,
    qualitySum,
  };
}

/** 埋まっているセルの中身を配列で返す。 */
export function archiveEntries(archive) {
  return Array.from(archive.cells.values());
}

/** JSON シリアライズ可能な素のオブジェクトに変換する(data/search-archive.json 用)。 */
export function toJSON(archive) {
  return {
    dims: archive.dims,
    cells: Array.from(archive.cells.entries()).map(([key, individual]) => [key, individual]),
  };
}

/** toJSON の出力からアーカイブを復元する。 */
export function fromJSON(obj) {
  return {
    dims: obj.dims.map((d) => ({ name: d.name, bins: d.bins })),
    cells: new Map(obj.cells.map(([key, individual]) => [key, individual])),
  };
}

/**
 * MAP-Elites 本体。
 * 1. initialBatch 件を createRandomGenome で作って評価・挿入
 * 2. iterations 回: sampleParent → mutate → evaluate → tryInsert
 * 3. evaluate が null/undefined/descriptor 無しを返したら挿入せずに続行する
 * 4. onProgress があれば一定間隔(PROGRESS_INTERVAL)で archiveStats を渡して呼ぶ
 */
export function runMapElites({ archive, evaluate, rng, iterations, initialBatch, onProgress }) {
  const PROGRESS_INTERVAL = 100;

  const evaluateAndInsert = (genome) => {
    const result = evaluate(genome);
    if (result == null || result.descriptor == null) return;
    tryInsert(archive, { genome, descriptor: result.descriptor, quality: result.quality, meta: result.meta });
  };

  for (let i = 0; i < initialBatch; i++) {
    const genome = createRandomGenome(rng);
    evaluateAndInsert(genome);
  }

  for (let i = 0; i < iterations; i++) {
    const parent = sampleParent(archive, rng);
    if (parent) {
      const child = mutate(parent.genome, rng);
      evaluateAndInsert(child);
    } else {
      // アーカイブが空(全評価が null だった等)の場合はランダム個体で継続する
      const genome = createRandomGenome(rng);
      evaluateAndInsert(genome);
    }
    if (onProgress && (i + 1) % PROGRESS_INTERVAL === 0) {
      onProgress(archiveStats(archive));
    }
  }

  return archive;
}
