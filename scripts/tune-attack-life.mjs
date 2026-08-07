#!/usr/bin/env node
// ATTACK_LIFE(攻撃アリの寿命)を**実測から決める**ための掃引スクリプト。
//
// なぜ後から決められるか:
//   第1アーカイブ(ハイウェイ発見)は仮想盤面を SEARCH_LIFE まで走らせるので ATTACK_LIFE に
//   依存しない。探索中のゲーム射影は ATTACK_LIFE ではなく GAME_LIFE_SEARCH_CAP(=12,000)で
//   走らせ、個体ごとの **実到達ステップ数(arrivalStep)** を記録してある。
//   したがって「arrivalStep <= 候補寿命」を数え直すだけで、再探索せずに別の寿命に対する
//   viable 集合を復元できる(config.js の GAME_LIFE_SEARCH_CAP のコメント参照)。
//
// 使い方:
//   node scripts/generate-templates.mjs ...   # 先に探索してアーカイブを作る
//   node scripts/tune-attack-life.mjs         # 掃引結果を表で出す
//   node scripts/tune-attack-life.mjs --from 4000 --to 12000 --step 500
//
// 出力は「候補寿命ごとの viable 件数 / ハイウェイ署名の種類数 / 速度クラスの被覆 /
// 到達時間の分散」。ここから **読み合いの軸になる到達時間の差が最も大きく、かつ
// 候補数が9×9の選抜に足りる**寿命を選ぶ。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVE_PATH = path.join(__dirname, '..', 'data', 'search-archive.json');

const argv = process.argv.slice(2);
function argNum(name, def) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= argv.length) return def;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) ? v : def;
}
const FROM = argNum('from', 3000);
const TO = argNum('to', C.GAME_LIFE_SEARCH_CAP);
const STEP = argNum('step', 500);

const archive = JSON.parse(readFileSync(ARCHIVE_PATH, 'utf8'));
const entries = archive.archive1.cells.map(([, individual]) => individual);

/** アーカイブの個体から、寿命判定に必要な情報だけを取り出す。 */
const records = entries
  .map((e) => ({
    arrivalStep: e.meta?.game?.arrivalStep ?? null,
    reached: e.meta?.game?.reached === true,
    period: e.meta?.highway?.period ?? null,
    driftX: e.meta?.highway?.driftX ?? null,
    driftY: e.meta?.highway?.driftY ?? null,
    rule: e.genome?.rule ?? '',
  }))
  .filter((r) => r.reached && r.arrivalStep != null);

if (records.length === 0) {
  console.error('到達した個体がアーカイブに1件もありません。先に探索を実行してください。');
  process.exit(1);
}

function signature(r) {
  return `${r.period},${Math.abs(r.driftX)},${Math.abs(r.driftY)}`;
}
function verticalSpeed(r) {
  return r.period > 0 ? Math.abs(r.driftY) / r.period : 0;
}
function speedClass(r) {
  const bounds = C.ARCHIVE2.speedClassBins;
  const v = verticalSpeed(r);
  for (let i = 0; i < bounds.length; i++) if (v <= bounds[i]) return i;
  return bounds.length - 1;
}

const arrivals = records.map((r) => r.arrivalStep).sort((a, b) => a - b);
const pct = (p) => arrivals[Math.min(arrivals.length - 1, Math.floor((arrivals.length - 1) * p))];
console.log(`到達した個体: ${records.length}件`);
console.log(
  `arrivalStep 分位: 最小=${arrivals[0]} p10=${pct(0.1)} p25=${pct(0.25)} 中央=${pct(0.5)} ` +
    `p75=${pct(0.75)} p90=${pct(0.9)} 最大=${arrivals[arrivals.length - 1]}`,
);
console.log('');
console.log('寿命\tviable\t署名種\t速度クラス\t到達秒(最短〜最長)\t到達秒の幅');
console.log('----\t------\t------\t----------\t------------------\t----------');

for (let life = FROM; life <= TO; life += STEP) {
  const viable = records.filter((r) => r.arrivalStep <= life);
  if (viable.length === 0) {
    console.log(`${life}\t0\t-\t-\t-\t-`);
    continue;
  }
  const sigs = new Set(viable.map(signature));
  const classes = new Set(viable.map(speedClass));
  const times = viable.map((r) => r.arrivalStep / C.STEPS_PER_SECOND);
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  console.log(
    `${life}\t${viable.length}\t${sigs.size}\t${classes.size}/${C.ARCHIVE2.speedClassBins.length}\t` +
      `${tMin.toFixed(1)}〜${tMax.toFixed(1)}秒\t${(tMax - tMin).toFixed(1)}秒`,
  );
}

console.log('');
console.log(`現在の src/config.js の ATTACK_LIFE = ${C.ATTACK_LIFE}(${(C.ATTACK_LIFE / C.STEPS_PER_SECOND).toFixed(1)}秒)`);
console.log('選び方: 到達秒の幅が読み合いの軸になる。幅が伸びなくなる手前で止めるのが目安。');
console.log('⚠️ 変えたら src/config.js と docs/spec.md 第2章のルール表を同じコミットで直すこと。');
