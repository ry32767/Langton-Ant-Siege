// Seed Distillation(仕様 §10〜§24)。
//
// 通常の genome は「初期配置 → transient → formationStep → highway」という流れを持つ。
// ゲームでは transient が丸ごと**発射から弾が仕上がるまでの遅延**になる。
// そこで、発見済みハイウェイが形成された時点の局所盤面を切り出し、
//   **そのハイウェイ状態を直接開始できる有限初期配置(種)**
// へ逆変換する。これは高速化ではなく、
//   「発見しやすいが形成が遅いハイウェイ」と「ゲームで即座に使えるハイウェイ種」
// を分離して探索するための工程(§34)。
//
// パイプライン(§11):
//   verified highway → formation snapshot → local crop → 座標正規化
//   → replay 検証 → セル圧縮 → distilled genome → MAP-Elites へ再投入
//
// DOM に依存しない純粋な ESM。engine.js の CA 規則は複製せず、
// highway-fingerprint.js の simulateWithBoard(複製の唯一の例外)を再利用する。

import * as C from '../config.js';
import { simulateWithBoard } from './highway-fingerprint.js';
import { detectHighwayFromPath } from './highway-trajectory.js';
import { compressSeed } from './seed-compression.js';

// ---------------------------------------------------------------------------
// 内部専用の解像度パラメータ
// ゲームバランスの数値ではなく抽出アルゴリズムの解像度なので config.js には出さない
// (evaluate-projectile.js の STABILITY_CYCLES_CAP と同種の理由)。
// ---------------------------------------------------------------------------

/**
 * crop 半径を段階的に広げる列(§13)。
 * TEMPLATE_CELL_RADIUS(=8)を超える半径も試すのは、§22 が「16セルを超える種は
 * ゲーム用としては不採用だが研究用アーカイブには残してよい」としているため。
 * ゲームに使えるかどうかは gameUsable フラグで別に判定する。
 */
const CROP_RADII = Object.freeze([2, 3, 4, 6, 8, 12, 16]);

/** snapshot を取る位置の候補(formationStep からの周期数)。§12「またはその直後の安定周期開始位置」。 */
const SNAPSHOT_CYCLE_OFFSETS = Object.freeze([0, 1, 2, 4]);

/** replay 検証で走らせる周期数の余裕(§14 は最低5周期一致を要求)。 */
const REPLAY_EXTRA_CYCLES = 4;

// ---------------------------------------------------------------------------
// 座標ヘルパ
// ---------------------------------------------------------------------------

/** トーラス上の x 差を、絶対値が最小になる符号付きオフセットに直す。 */
function signedDx(x, originX) {
  let dx = x - originX;
  if (dx > C.WIDTH / 2) dx -= C.WIDTH;
  else if (dx < -C.WIDTH / 2) dx += C.WIDTH;
  return dx;
}

/** simulateWithBoard の frames から detectHighwayFromPath 用の [x,y,dir] 軌跡を作る(x は巻き戻し済み)。 */
function framesToPath(frames) {
  const n = frames.length;
  if (n === 0) return [];
  const path = new Array(n);
  let ux = frames[0].x;
  path[0] = [ux, frames[0].y, frames[0].dir];
  for (let i = 1; i < n; i++) {
    ux += signedDx(frames[i].x, frames[i - 1].x);
    path[i] = [ux, frames[i].y, frames[i].dir];
  }
  return path;
}

// ---------------------------------------------------------------------------
// ① formation snapshot(§12)
// ---------------------------------------------------------------------------

/**
 * highway 形成直後の局所盤面を切り出す。アリ位置を原点に正規化して返す(§12)。
 * 最大半径 maxRadius ぶんの近傍を1回だけ取り、小さい crop はそこから派生させる
 * (半径ごとに再シミュレーションしない)。
 *
 * @returns {null | {antDir:number, cells:Array<{dx:number,dy:number,state:number}>}}
 *   cells は**非ゼロのマスだけ**(状態0は「何も塗られていない」なので種に含めない)。
 */
export function captureFormationSnapshot(genome, highway, snapshotStep, maxRadius) {
  let captured = null;
  const { frames, outOfBoard } = simulateWithBoard(
    genome,
    snapshotStep + 1,
    (step, x, y, dir, board) => {
      const cells = [];
      for (let dy = -maxRadius; dy <= maxRadius; dy++) {
        const gy = y + dy;
        if (gy < 0 || gy >= C.SEARCH_BOARD_HEIGHT) continue;
        for (let dx = -maxRadius; dx <= maxRadius; dx++) {
          const gx = (((x + dx) % C.WIDTH) + C.WIDTH) % C.WIDTH;
          const state = board[gy * C.WIDTH + gx];
          if (state !== 0) cells.push({ dx, dy, state });
        }
      }
      captured = { antDir: dir, cells };
    },
    new Set([snapshotStep]),
  );
  if (outOfBoard || frames.length <= snapshotStep) return null;
  return captured;
}

// ---------------------------------------------------------------------------
// ② replay 検証(§14)
// ---------------------------------------------------------------------------

/**
 * 種セルから走らせ直して、元のハイウェイと同じ period / drift を
 * HIGHWAY_MIN_CYCLES 周期以上再現するか確認する。
 *
 * @returns {null | {formationStep:number, period:number, driftX:number, driftY:number, verifiedCycles:number}}
 *   再現しなければ null。再現すれば replay 上で検出したハイウェイ(= distilled 側の値)。
 */
export function replaySeed(rule, antDir, cells, highway, options = {}) {
  const minCycles = options.minCycles ?? C.HIGHWAY_MIN_CYCLES;
  // 検出には最低 (minCycles+1) 周期ぶんの軌跡が要る。形成に少しかかる場合の余裕も足す。
  const steps = highway.period * (minCycles + 1 + REPLAY_EXTRA_CYCLES) + 64;
  // antY=0 で走らせる。仮想盤面には配置帯の概念が無く、y の平行移動は力学に影響しない。
  const seedGenome = { rule, antY: 0, antDir, cells };
  const { frames, outOfBoard } = simulateWithBoard(seedGenome, steps);
  if (outOfBoard) return null;
  const detected = detectHighwayFromPath(framesToPath(frames), { minCycles });
  if (!detected) return null;
  if (
    detected.period !== highway.period ||
    detected.driftX !== highway.driftX ||
    detected.driftY !== highway.driftY ||
    detected.verifiedCycles < minCycles
  ) {
    return null;
  }
  return detected;
}

// ---------------------------------------------------------------------------
// ③ ゲーム採用可否(§22)
// ---------------------------------------------------------------------------

/**
 * 圧縮後の種がゲーム用テンプレートになれるかを判定し、なれるなら発射行 antY を決める。
 *
 * ⚠️ 制約は crop 半径ではなく **圧縮後セル集合の実際の広がり**で見る(§15/§22 の読み方)。
 * 半径12で切り出しても、圧縮後に残ったセルが半径3に収まっていればゲームに使える。
 *   - セル数 <= MAX_CELLS
 *   - |dx|, |dy| <= TEMPLATE_CELL_RADIUS(genome の不変条件。mutate も同じ範囲で動く)
 *   - dy の広がりが配置帯(ZONE_DEPTH)に収まる ⇒ 収まる antY が存在する
 * antY は「最も深い位置」を選ぶ。深いほど得点ラインまでの距離が縮み、寿命内に届きやすい。
 */
export function gameUsability(cells) {
  if (cells.length === 0 || cells.length > C.MAX_CELLS) {
    return { gameUsable: false, antY: null, reason: `cellCount=${cells.length}` };
  }
  let minDy = Infinity;
  let maxDy = -Infinity;
  for (const c of cells) {
    if (Math.abs(c.dx) > C.TEMPLATE_CELL_RADIUS || Math.abs(c.dy) > C.TEMPLATE_CELL_RADIUS) {
      return { gameUsable: false, antY: null, reason: 'cellOutsideTemplateRadius' };
    }
    if (c.dy < minDy) minDy = c.dy;
    if (c.dy > maxDy) maxDy = c.dy;
  }
  // 0 <= antY + dy < ZONE_DEPTH をすべての dy について満たす antY の範囲
  const lo = Math.max(0, -minDy);
  const hi = Math.min(C.ZONE_DEPTH - 1, C.ZONE_DEPTH - 1 - maxDy);
  if (lo > hi) return { gameUsable: false, antY: null, reason: 'dyBboxExceedsZoneDepth' };
  return { gameUsable: true, antY: hi, reason: null };
}

// ---------------------------------------------------------------------------
// ④ パイプライン本体
// ---------------------------------------------------------------------------

/**
 * genome + 検出済み highway から distilled genome を作る(§11 のパイプライン全体)。
 *
 * @param {{rule:string, antY:number, antDir:number, cells:Array}} genome
 * @param {{period:number, driftX:number, driftY:number, formationStep:number, verifiedCycles:number}} highway
 * @param {{parentGenomeId?:string, minCycles?:number, compress?:boolean}} [options]
 * @returns {{
 *   attempted:boolean, success:boolean, gameUsable:boolean,
 *   genome:object|null, cropRadius:number|null, snapshotStep:number|null,
 *   sourceFormationStep:number, distilledFormationStep:number|null,
 *   sourceCellCount:number, distilledCellCount:number|null,
 *   reason:string|null
 * }}
 */
export function distillSeed(genome, highway, options = {}) {
  const fail = (reason) => ({
    attempted: true,
    success: false,
    gameUsable: false,
    genome: null,
    cropRadius: null,
    snapshotStep: null,
    sourceFormationStep: highway?.formationStep ?? null,
    distilledFormationStep: null,
    sourceCellCount: genome.cells.length,
    distilledCellCount: null,
    reason,
  });

  if (!highway || !Number.isInteger(highway.period) || highway.period <= 0) return fail('noHighway');

  const maxRadius = CROP_RADII[CROP_RADII.length - 1];
  const compress = options.compress !== false;

  for (const cycleOffset of SNAPSHOT_CYCLE_OFFSETS) {
    const snapshotStep = highway.formationStep + cycleOffset * highway.period;
    const snapshot = captureFormationSnapshot(genome, highway, snapshotStep, maxRadius);
    if (!snapshot) continue;

    for (const r of CROP_RADII) {
      const cropped = snapshot.cells.filter((c) => Math.abs(c.dx) <= r && Math.abs(c.dy) <= r);
      if (cropped.length === 0) continue;
      const detected = replaySeed(genome.rule, snapshot.antDir, cropped, highway, options);
      if (!detected) continue;

      // 再現できた。ここから不要セルを削る(§15)。
      const verify = (cells) => cells.length > 0 && replaySeed(genome.rule, snapshot.antDir, cells, highway, options) !== null;
      const compressed = compress ? compressSeed(cropped, verify).cells : cropped;

      // 圧縮後の種で改めて形成ステップを測る(圧縮でわずかに変わりうる)。
      const finalDetected = replaySeed(genome.rule, snapshot.antDir, compressed, highway, options) ?? detected;

      const usability = gameUsability(compressed);
      const distilled = usability.gameUsable
        ? {
            rule: genome.rule,
            antY: usability.antY,
            antDir: snapshot.antDir,
            cells: compressed.map((c) => ({ dx: c.dx, dy: c.dy, state: c.state })),
            origin: 'distilled',
            parentGenomeId: options.parentGenomeId ?? null,
          }
        : null;

      return {
        attempted: true,
        success: true,
        gameUsable: usability.gameUsable,
        genome: distilled,
        cropRadius: r,
        snapshotStep,
        sourceFormationStep: highway.formationStep,
        distilledFormationStep: finalDetected.formationStep,
        sourceCellCount: genome.cells.length,
        distilledCellCount: compressed.length,
        reason: usability.reason,
      };
    }
  }

  return fail('noReproducibleCrop');
}
