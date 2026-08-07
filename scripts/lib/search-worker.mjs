// MAP-Elites 探索の評価ワーカー(worker_threads)。
//
// ⚠️ 設計上の最重要点: **このワーカーは乱数を一切使わない。**
// genome の生成・親の選択・突然変異はすべてメインスレッドで行い、ワーカーは
// 「渡された genome を評価して結果を返すだけの純粋関数」に徹する。
// こうすると、結果をワーカーの**完了順ではなく添字順**にアーカイブへ入れるかぎり、
// 並列数やスケジューリングに関係なく出力が完全に決定論的になる
// (AGENTS.md「--seed 1 の2回実行で出力一致」を並列化しても壊さないため)。
//
// src/engine.js のシミュレーションはモジュールレベルのバッファを使い回していて再入不可だが、
// worker_threads はワーカーごとにモジュールインスタンスが独立なので競合しない。

import { parentPort } from 'node:worker_threads';
import * as C from '../../src/config.js';
import { evaluateProjectile } from '../../src/search/evaluate-projectile.js';
import { distillSeed } from '../../src/search/seed-distillation.js';
import { evaluateInteraction } from '../../src/search/evaluate-interaction.js';
import { simulateSolo, instantiateTemplate } from '../../src/engine.js';
import { toTemplateCells } from '../../src/search/genome.js';

/** genome を engine 用の相対テンプレート形に変換する。 */
function toRelativeTemplate(genome, kind) {
  return {
    rule: genome.rule,
    cells: toTemplateCells(genome),
    antY: genome.antY,
    antDir: genome.antDir,
    kind,
  };
}

// ---------------------------------------------------------------------------
// タスク: genome 1件の探索評価(+ 必要なら Seed Distillation)
// ---------------------------------------------------------------------------
function taskEvaluate(payload) {
  const { genome, strict, distill } = payload;
  const p = evaluateProjectile(genome, { strict: strict === true });
  const out = {
    highway: p.highway,
    game: p.game,
    descriptor: p.descriptor,
    quality: p.quality,
    viable: p.viable,
    distillation: null,
    distilledGenome: null,
    distilledEval: null,
  };
  // Seed Distillation は全候補には行わない(§19)。呼び出し側が distill:true を立てた
  // 候補にだけ実行する。distilled genome はその場で再評価して一緒に返す(§18: 特別扱いせず
  // 通常の個体として再評価する)。往復のメッセージ数を減らすためワーカー内で完結させる。
  if (distill === true && p.highway.trajectoryPeriodic) {
    const d = distillSeed(genome, p.highway, { parentGenomeId: payload.parentGenomeId ?? null });
    out.distillation = {
      attempted: d.attempted,
      success: d.success,
      gameUsable: d.gameUsable,
      cropRadius: d.cropRadius,
      sourceFormationStep: d.sourceFormationStep,
      distilledFormationStep: d.distilledFormationStep,
      sourceCellCount: d.sourceCellCount,
      distilledCellCount: d.distilledCellCount,
      reason: d.reason,
    };
    if (d.genome) {
      out.distilledGenome = d.genome;
      const p2 = evaluateProjectile(d.genome);
      out.distilledEval = {
        highway: p2.highway,
        game: p2.game,
        descriptor: p2.descriptor,
        quality: p2.quality,
        viable: p2.viable,
      };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// タスク: 1件の攻撃 × 妨害プール × deltaX × タイミング のカウンター数
// ---------------------------------------------------------------------------
function taskCountCounters(payload) {
  const { attack, disrupts, deltaXs, timings } = payload;
  let stopped = 0;
  let total = 0;
  for (const d of disrupts) {
    for (const dx of deltaXs) {
      for (const t0 of timings) {
        total++;
        const { scored } = evaluateInteraction(attack, d, t0, dx);
        if (!scored) stopped++;
      }
    }
  }
  return { stopped, total };
}

// ---------------------------------------------------------------------------
// タスク: 1件の妨害が攻撃プールの何件を止められるか(coverage)
// ---------------------------------------------------------------------------
function taskCoverage(payload) {
  const { disrupt, attacks, deltaXs, timings } = payload;
  let covered = 0;
  outer: for (const a of attacks) {
    for (const dx of deltaXs) {
      for (const t0 of timings) {
        const { scored } = evaluateInteraction(a, disrupt, t0, dx);
        if (!scored) {
          covered++;
          continue outer;
        }
      }
    }
  }
  return { covered, total: attacks.length };
}

// ---------------------------------------------------------------------------
// タスク: 最終テーブル用の1行(攻撃1件 × 全妨害 × 全 deltaX × 全タイミング)
// ---------------------------------------------------------------------------
function taskCounterRow(payload) {
  const { attack, disrupts, deltaXs, timings } = payload;
  // hits[j] = その妨害が止めた (deltaX, fireAtStep) の一覧
  const hits = [];
  for (let j = 0; j < disrupts.length; j++) {
    const stoppedAt = [];
    for (const dx of deltaXs) {
      for (const t0 of timings) {
        const { scored } = evaluateInteraction(attack, disrupts[j], t0, dx);
        if (!scored) stoppedAt.push([dx, t0]);
      }
    }
    hits.push(stoppedAt);
  }
  return { hits, totalPerDisrupt: deltaXs.length * timings.length };
}

// ---------------------------------------------------------------------------
// タスク: 妨害の到達距離と終端方向(第2アーカイブの記述子用)
// ---------------------------------------------------------------------------
function taskDisruptProfile(payload) {
  const { genome } = payload;
  const tpl = instantiateTemplate(toRelativeTemplate(genome, 'disrupt'), 0);
  const r = simulateSolo(tpl, { trackPath: true });
  const reachRows = Math.max(0, r.endY - genome.antY);
  let endDir = null;
  if (r.path && r.path.length >= 2) {
    const [x1, y1] = r.path[r.path.length - 2];
    const [x2, y2] = r.path[r.path.length - 1];
    let dx = x2 - x1;
    if (dx > C.WIDTH / 2) dx -= C.WIDTH;
    else if (dx < -C.WIDTH / 2) dx += C.WIDTH;
    const dy = y2 - y1;
    const found = C.DIRS.findIndex(([ddx, ddy]) => ddx === dx && ddy === dy);
    endDir = found >= 0 ? found : null;
  }
  return { reachRows, endDir: endDir ?? genome.antDir, reached: r.reached };
}

const TASKS = {
  evaluate: taskEvaluate,
  countCounters: taskCountCounters,
  coverage: taskCoverage,
  counterRow: taskCounterRow,
  disruptProfile: taskDisruptProfile,
};

parentPort.on('message', (msg) => {
  if (msg.type === 'shutdown') {
    process.exit(0);
  }
  const { id, task, payload } = msg;
  try {
    const fn = TASKS[task];
    if (!fn) throw new Error(`未知のタスク: ${task}`);
    parentPort.postMessage({ id, ok: true, result: fn(payload) });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err?.stack ?? String(err) });
  }
});
