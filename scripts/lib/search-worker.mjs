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
import { compressSeed } from '../../src/search/seed-compression.js';

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


// ---------------------------------------------------------------------------
// タスク: 妨害の Seed Compression(差分仕様 §7・§8)
//
// 妨害コストは DISRUPT_BASE_COST + ceil(cells/2) なので、**2マス減るごとに1トークン安くなる**。
// 迎撃札を実際に使える価格帯へ収めるため、迎撃性能を落とさない範囲で配置セルを貪欲に削る。
//
// ⚠️ 「周期軌道を保っているか」だけでは不十分(§8 の採用条件)。セルを削ると軌道が変わり、
// 「まだハイウェイではあるが、もう当たらない」個体になりうる。したがって verify では
// **元候補が持っていた迎撃能力を失っていないか**を毎回 evaluateInteraction で測り直す。
//
// ⚠️ このタスクは乱数を使わない(compressSeed の削除順は距離→辞書順で決定論的)。
// ワーカーは純粋関数のままなので、並列数を変えても結果は変わらない。
// ---------------------------------------------------------------------------
function taskCompressDisrupt(payload) {
  const { genome, attacks, preserve } = payload;

  // preserve = [[attackIndex, deltaX, fireAtStep], ...]
  // この妨害が**実際に止められていた**組み合わせだけを列挙したもの(段階⑤で計算済みの hits)。
  // ⚠️ 全グリッド(攻撃 × 全deltaX × 全タイミング)を verify のたびに舐めると、
  // 1候補あたり数十万シミュレーションになり圧縮だけで数時間かかる。§8 が要求しているのは
  // 「元が持っていた迎撃能力を失っていないこと」なので、**元のヒットだけ**を再評価すれば足りる。
  if (!preserve || preserve.length === 0) {
    return { cells: toTemplateCells(genome), removed: 0, verifyCalls: 0, preserved: 0 };
  }

  function tplOf(cells) {
    return { rule: genome.rule, cells, antY: genome.antY, antDir: genome.antDir, kind: 'disrupt' };
  }

  /** 妨害としての空間制約(§8 の採用条件1・2)。敵陣へ到達してしまう個体は不可。 */
  function trajectoryOk(cells) {
    const r = simulateSolo(instantiateTemplate(tplOf(cells), 0), { trackPath: false });
    return !r.reached;
  }

  const baseCells = toTemplateCells(genome).map(([dx, dy, state]) => ({ dx, dy, state }));

  const verify = (candidateCells) => {
    const flat = candidateCells.map((c) => [c.dx, c.dy, c.state]);
    if (!trajectoryOk(flat)) return false;
    const tpl = tplOf(flat);
    // 元が止められていた組を1つでも失ったら不採用(§8 採用条件3)。
    for (const [ai, dx, t0] of preserve) {
      const { scored } = evaluateInteraction(attacks[ai], tpl, t0, dx);
      if (scored) return false;
    }
    return true;
  };

  const res = compressSeed(baseCells, verify);
  return {
    cells: res.cells.map((c) => [c.dx, c.dy, c.state]),
    removed: res.removed,
    verifyCalls: res.verifyCalls,
    preserved: preserve.length,
  };
}

const TASKS = {
  evaluate: taskEvaluate,
  countCounters: taskCountCounters,
  coverage: taskCoverage,
  counterRow: taskCounterRow,
  disruptProfile: taskDisruptProfile,
  compressDisrupt: taskCompressDisrupt,
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
