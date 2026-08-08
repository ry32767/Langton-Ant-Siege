# Action-Centric CPU 実装契約(v6)

> `action_centric_cpu_diff_spec.md`(確定差分仕様)を、このリポジトリの実際の型・関数名・定数名へ
> 落とし込んだ**凍結契約**。engine / cpu / 学習 / 評価 / テストの各実装はこの文書だけを見て書ける。
> ここに書かれていない名前を新しく発明しないこと。値を変えたくなったらまずこの文書を直す。

---

## 0. 用語と座標

- **グローバル座標** … `board` の実座標。`x∈[0,256)` はトーラス、`y∈[0,256)`。
- **CPUローカル座標** … 陣営から見た座標。`y=0` が自陣、`y=255` が敵陣。`toLocalY(sideIndex, gy)` で変換。
  `x` は陣営で鏡像にならない(変換しない)。
- **coarse block** … 8×8セルを1ブロックにした 32×32 の粗視化盤面。1ブロック = 64セル。

新しい定数は **すべて `src/config.js`** に置く(数値の直書き禁止)。

```js
export const COARSE_SIZE = 32;                       // 32×32
export const COARSE_BLOCK = WIDTH / COARSE_SIZE;     // 8
export const COARSE_SHIFT = 3;                       // x >> 3 で coarse 列(WIDTH=256 前提)
export const COARSE_COUNT = COARSE_SIZE * COARSE_SIZE;       // 1024
export const COARSE_CELLS_PER_BLOCK = COARSE_BLOCK * COARSE_BLOCK; // 64
export const COARSE_BAND_COUNT = 4;                  // §17.2 の4band
export const COARSE_ROWS_PER_BAND = COARSE_SIZE / COARSE_BAND_COUNT; // 8

/** グローバル coarse 行 → CPUローカル coarse 行(逆変換も同じ式)。 */
export function coarseLocalRow(sideIndex, cyGlobal) {
  return sideIndex === 0 ? cyGlobal : COARSE_SIZE - 1 - cyGlobal;
}
```

> `COARSE_SHIFT` が `Math.log2(COARSE_BLOCK)` と一致することは `test/config.test.js` で検査する。

---

## 1. engine 側の追加(`src/engine.js`)

### 1.1 match に持たせる増分カウンタ

`createMatch()` の戻り値へ追加する。**すべてグローバル coarse 座標**(`index = cyGlobal * 32 + cxGlobal`)。

```js
coarseNonWhite:   new Int32Array(C.COARSE_COUNT),        // ブロック内の非白セル数 0..64
coarseOwnedBySide: [new Int32Array(C.COARSE_COUNT),      // lastToucherSide === 1 のセル数
                    new Int32Array(C.COARSE_COUNT)],     // lastToucherSide === 2 のセル数
// 自軍アリ別 ownership(§13)。[sideIndex][slot] で 32×32。slot は 0..MAX_FLYING-1。
coarseOwnedByAnt: [
  Array.from({length: C.MAX_FLYING}, () => new Int32Array(C.COARSE_COUNT)),
  Array.from({length: C.MAX_FLYING}, () => new Int32Array(C.COARSE_COUNT)),
],
// 各スロットに今どのアリが居るか(空きは -1)。fire でスロット確保、消滅で解放。
antSlotOccupant: [new Int8Array(C.MAX_FLYING).fill(-1), new Int8Array(C.MAX_FLYING).fill(-1)],
// セルの現在の所有アリのスロット番号+1(0 = 所有者なし)。lastToucher と同じ長さ。
lastToucherSlot: new Uint8Array(C.CELL_COUNT),
```

`lastToucherSlot` を持つ理由: 所有権の増分更新でアリIDからスロットを引くと Map 参照が
ホットパス(`stepAnt`)に入る。セルに直接スロットを書いておけば O(1) の配列参照で済む。

### 1.2 増分更新のフック

盤面へ書き込む経路は **`stepAnt` / `fire` / `cleanupAnt` の3つだけ**(既存 `bumpCounters` の
呼び出し箇所と完全に同じ)。新しい書き込み経路を作らないこと。

- `bumpCounters(...)` に `counters.coarseNonWhite[b] += delta` を1行足す(`b = (gy>>3)*32 + (x>>3)`)。
- 所有権は新ヘルパで更新する:

```js
/** セル j の所有者が (oldSide, oldSlot) → (newSide, newSlot) へ変わったときの増分更新。
 *  side は 0=所有者なし / 1=side0 / 2=side1(lastToucherSide と同じ符号化)。
 *  slot は 0=不明or未確保 / 1..MAX_FLYING。counters が null なら何もしない。 */
function bumpOwnership(counters, x, gy, oldSide, oldSlot, newSide, newSlot)
```

呼び出し位置:

| 経路 | old | new |
|---|---|---|
| `stepAnt` | セル書き換え前の `lastToucherSide[j]` / `lastToucherSlot[j]` | `ant.sideIndex+1` / `ant.slot+1` |
| `fire`(配置マス) | 同上 | `sideIndex+1` / `slot+1` |
| `cleanupAnt`(白に戻すセル) | 同上 | `0` / `0` |

⚠️ **`fire()` の配置マスも必ず ownership に計上する。** 差分仕様 §14 は `stepAnt` の
oldAnt→newAnt 遷移しか書いていないが、`fire()` も `lastToucher[j] = antId` を書くため、
ここを落とすと §32 の「`ownedTrailAmount` が実 cleanup セル数と一致する」テストが落ちる。

### 1.3 スロットの確保と解放

- `fire()`: `antSlotOccupant[sideIndex]` の空き(値 -1)を**添字の小さい順**に探して確保し、
  `ant.slot` に持たせ、`antSlotOccupant[sideIndex][slot] = antId` を書く。
  空きが無いのは `canFire` が `MAX_FLYING` を弾くのでありえない(念のため `slot=-1` なら発射失敗扱い)。
- アリ消滅(`moveSide` の cleanup / `selfDestruct`): `cleanupAnt` の後に
  `antSlotOccupant[side][slot] = -1` と `coarseOwnedByAnt[side][slot].fill(0)` を行う。
  `cleanupAnt` が正しければ fill(0) は冗長だが、**不変条件の保険として必ず行う**。

> 不変条件(テストで検査する): `Σ_slot coarseOwnedByAnt[s][slot][b]` は
> 「ブロック b 内で `lastToucher[j] !== -1` かつ `lastToucherSide[j] === s+1` のセル数」
> = `coarseOwnedBySide[s][b]` に一致する。

### 1.4 `createSideView` の追加フィールド

**参照渡し。コピーしない**(既存 `board` / `columnNonWhite` と同じ規律)。すべて**グローバル coarse 座標**で
渡し、ローカル変換は利用側が `C.coarseLocalRow(sideIndex, cy)` で行う。

```js
coarseNonWhite,        // Int32Array(1024) 参照
coarseOwnedMine,       // Int32Array(1024) = match.coarseOwnedBySide[sideIndex]
coarseOwnedEnemy,      // Int32Array(1024) = match.coarseOwnedBySide[1 - sideIndex]
coarseAntOwned,        // (Int32Array|null)[MAX_FLYING] = 自軍スロットごと。空きスロットは null
```

`toView(ant)` に `slot`(自軍のみ意味を持つ。敵は `-1` を入れる)を追加する。
既存フィールドは**一切変えない**(`board` / `lastToucherSide` / `columnNonWhite` も残す)。

---

## 2. Action の形(`src/cpu.js`)

```js
// WAIT — 常に合法。score ≡ 0(§4)。特徴は計算しない
{ type: 'WAIT' }

// FIRE — 即時(atStep === view.step)または予約(atStep > view.step)
{
  type: 'FIRE',
  kind: 'attack' | 'disrupt',   // テンプレートの物理的 kind。戦術ラベルではない
  templateId: string,
  launchX: number,              // 0..255
  atStep: number,
  cost: number,                 // C.costOf(kind, cells.length)
  source: 'generic' | 'counter' | 'escort',  // 由来。**選択規則に使ってはならない**(ログ専用)
  engineAction: object,         // instantiateTemplate() の戻り値(engine.fire がそのまま受け取る)
}

// SELF_DESTRUCT — 飛行中の自軍アリすべてが候補(事前フィルタ禁止・§6)
{ type: 'SELF_DESTRUCT', antId: number, slot: number, ant: object /* view の myAnt */ }
```

`type` に `ATTACK` / `DEFEND` / `ESCORT` を作らない(§3.1)。

## 3. `generateActions(view, ctx)` — 合法性と候補圧縮だけ

責務は §7 のとおり。**戦術優先順位を一切埋め込まない。**

1. `WAIT` を必ず入れる。
2. `flyingCount < C.MAX_FLYING` のときだけ FIRE 候補を作る(枠が埋まっていれば FIRE は非合法)。
3. **generic FIRE**
   - 攻撃3種それぞれ: 得点ゲート内から `C.ACTION_ATTACK_GATE_SAMPLES` 列、ゲート外から
     `C.ACTION_ATTACK_OFFGATE_SAMPLES` 列を `rng.int()` で**一様に**サンプルする。
     ⚠️ 旧 `chooseAttackColumn` の「いちばん綺麗な列を選ぶ」ヒューリスティクスは**移植禁止**(§41)。
     列の良し悪しは特徴8〜15が表現し、重みが学習する。
   - 妨害3種それぞれ: 全256列から `C.ACTION_DISRUPT_SAMPLES` 列を一様サンプル。
   - すべて `atStep = view.step`(即時)。
4. **counter 由来 FIRE**(§9。候補生成情報としてのみ使う)
   - `view.enemyAnts` の攻撃アリを `identifyTable["spawnY,spawnDir"]` で特定し、
     `counterTable[attackId]` を走査。`absStep = threat.firedAtStep + cand.fireAtStep`。
     `absStep >= view.step` かつ `projectedTokens(absStep) >= cost` のものを候補化。
     `launchX = wrapX(threat.spawnX + cand.deltaX)`。
   - 全体で `C.ACTION_COUNTER_MAX` 件まで。列挙順は `successRate` 降順→`fireAtStep` 昇順→`deltaX` 昇順
     (**候補数制御のための決定論的な列挙順**であって選好ではない。`successRate` は特徴に入れない・§9)。
5. **escort 由来 FIRE**(同上)
   - `view.myAnts` の攻撃アリごとに `counterTable[myAnt.templateId]` の各 `disruptId` について
     `escortTable[myAnt.templateId][disruptId]` を走査。`absStep = myAnt.firedAtStep + cand.fireAtStep`。
     `launchX = wrapX(myAnt.spawnX + cand.escortDeltaX)`。全体で `C.ACTION_ESCORT_MAX` 件まで。
   - ⚠️ 旧実装の「攻撃を撃つのと同じ判断で護衛を予約する」抱き合わせは**廃止**。
     1判断=1アクション。護衛窓が判断周期より短くて撃てない場合は、そのまま候補が出ないだけでよい
     (§27「護衛を使わない方が強い」も正当な学習結果)。
6. **SELF_DESTRUCT**: `view.myAnts` 全件。年齢・残寿命・汚染度による事前フィルタ禁止(§6)。
7. **重複除去**: `(type, templateId, launchX, atStep)` / `(type, antId)` が同一の候補は1件に畳む(§29)。

即時 FIRE は `cost <= avail`、予約 FIRE は `cost <= projectedTokens(atStep)` を満たすものだけ残す。

新しい `src/config.js` の定数:

```js
export const ACTION_ATTACK_GATE_SAMPLES = 4;    // 得点ゲート内からサンプルする発射列数
export const ACTION_ATTACK_OFFGATE_SAMPLES = 2; // ゲート外(scoreReachability=0)からの発射列数
export const ACTION_DISRUPT_SAMPLES = 4;        // 妨害の発射列サンプル数
export const ACTION_COUNTER_MAX = 8;            // counterTable 由来候補の上限
export const ACTION_ESCORT_MAX = 4;             // escortTable 由来候補の上限
```

## 4. `selectAction(view, actions, ctx)`

```
score(WAIT) = 0
score(other) = Σ weights[i] * features[i]
```

最大スコアを選ぶ。**同点は候補配列の添字が小さい方**(決定論)。すべての実行 Action が 0 未満なら
WAIT が勝つ(§4)。`rng` は特徴計算・スコア計算に**一切使わない**(乱数は候補生成の列サンプルのみ)。

`decide(view)` の戻り値と副作用:

| 選ばれた Action | 戻り値 | 副作用 |
|---|---|---|
| `WAIT` | `null` | なし |
| 即時 `FIRE` | `engineAction` | `commitments` に `{atStep: view.step, cost}` を積む |
| 予約 `FIRE` | `null` | `scheduleFire(engineAction, atStep)` + `commitments` に積む |
| `SELF_DESTRUCT` | `null` | `selfDestruct(antId)` |

`commitments` / `projectedTokens` / `releaseExpiredCommitments` は旧実装からそのまま維持する(§15)。

---

## 5. 24次元 Feature Encoder(凍結)

`encodeFeatures(view, action, ctx) -> Float64Array(24)`。**完全決定論・乱数不使用**。
`WAIT` には呼ばない。すべて下表の範囲に収まること(テストで検査)。

| # | 名前 | 範囲 | 定義 |
|--:|---|---|---|
| 0 | `isAttackFire` | {0,1} | FIRE かつ `kind==='attack'` |
| 1 | `isDisruptFire` | {0,1} | FIRE かつ `kind==='disrupt'` |
| 2 | `isSelfDestruct` | {0,1} | SELF_DESTRUCT |
| 3 | `tokenAfter` | [0,1] | `clamp(tokensAfter / C.TOKEN_CAP, 0, 1)`。FIRE は `projectedTokens(atStep) - cost`、SELF_DESTRUCT は `avail - C.SELF_DESTRUCT_COST` |
| 4 | `flyingAfter` | [0,1] | `clamp(flyingAfter / C.MAX_FLYING, 0, 1)`。FIRE は `flyingCount+1`、SELF_DESTRUCT は `flyingCount-1` |
| 5 | `effectDelay` | [0,1] | `clamp(delaySteps / max(C.TOTAL_STEPS - view.step, 1), 0, 1)`。SELF_DESTRUCT は 0。FIRE は `(atStep - view.step) + travel`、`travel` は攻撃 `template.arrivalStep`、妨害 `0` |
| 6 | `scoreReachability` | {0,1} | 攻撃 FIRE かつ `launchColumnScores(tpl, launchX)` が真 → 1。妨害・自爆は 0 |
| 7 | `robustness` | [0,1] | 攻撃 FIRE → `clamp(template.robustness, 0, 1)`。他は 0 |
| 8 | `boardOccupancyBand0` | [0,1] | 下記 |
| 9 | `boardOwnershipBand0` | [-1,1] | 下記 |
| 10..15 | band1..band3 の同ペア | 同上 | 下記 |
| 16 | `enemyNearAnchor` | [0,1] | 下記 |
| 17 | `enemyForwardPresence` | [0,1] | 下記 |
| 18 | `allyNearAnchor` | [0,1] | 下記 |
| 19 | `allyForwardPresence` | [0,1] | 下記 |
| 20 | `destructAge` | [0,1] | SELF_DESTRUCT のみ。`clamp(ant.steps / ant.life, 0, 1)` |
| 21 | `ownedTrailAmount` | [0,1] | SELF_DESTRUCT のみ。`ownedCellCount / C.CELL_COUNT` |
| 22 | `ownedTrailCentroidY` | [0,1] | SELF_DESTRUCT のみ。所有セルのローカルY重心 /(HEIGHT-1)。0=自陣側。所有0なら 0 |
| 23 | `ownedTrailSpread` | [0,1] | SELF_DESTRUCT のみ。下記。所有0なら 0 |

### 5.1 anchor(§17.2 / §17.3 共通)

```
FIRE          → anchorX = launchX,      anchorYLocal = template.antY
SELF_DESTRUCT → anchorX = targetAnt.x,  anchorYLocal = targetAnt.y   // view のローカル y
```

### 5.2 特徴 8〜15(盤面band)

水平カーネル(全32列が寄与する):

```
d      = toroidalCoarseDistance(cx, anchorCx)   // 0..16
Kx(d)  = 1 - d / (COARSE_SIZE / 2)              // 1 .. 0
ΣKx    = 16                                     // 正規化に使う定数
anchorCx = anchorX >> COARSE_SHIFT
```

band は **CPUローカル** coarse 行で決める: `band = floor(coarseLocalRow(sideIndex, cyGlobal) / 8)`。
band0 が自陣側、band3 が敵陣側。

```
occupancy(band)  = Σ_cx Kx(cx) * colOcc[band][cx] / 16
ownership(band)  = Σ_cx Kx(cx) * colOwn[band][cx] / 16

colOcc[band][cx] = (Σ_{cy∈band} coarseNonWhite[cy*32+cx]) / (8 * 64)              ∈ [0,1]
colOwn[band][cx] = (Σ_{cy∈band} (coarseOwnedEnemy[b] - coarseOwnedMine[b])) / (8 * 64) ∈ [-1,1]
```

**性能要件(§29.3)**: `colOcc` / `colOwn`(4×32=128要素×2)は**1判断につき1回**だけ作り、
その判断内の全 Action で使い回す。さらに `anchorCx` ごとの8特徴は32エントリのキャッシュに
memo 化する(同じ coarse 列の候補が何本あっても1回しか畳み込まない)。
1判断あたりの計算量: 1024(band集約) + 32×4×(異なるanchorCx数)。

### 5.3 特徴 16〜19(アリ空間関係)

```
dxNorm = toroidalDistance(ant.x, anchorX) / (WIDTH / 2)     ∈ [0,1]
dyNorm = |ant.y - anchorYLocal| / (HEIGHT - 1)              ∈ [0,1]
dist   = hypot(dxNorm, dyNorm) / SQRT2                      ∈ [0,1]
prox   = 1 - dist                                           ∈ [0,1]

16 enemyNearAnchor     = max(prox) over view.enemyAnts                       (敵0匹なら 0)
17 enemyForwardPresence= clamp(Σ prox over {敵 : ant.y > anchorYLocal} / MAX_FLYING, 0, 1)
18 allyNearAnchor      = max(prox) over view.myAnts(自爆対象アリ自身は除く)  (0匹なら 0)
19 allyForwardPresence = clamp(Σ prox over {味方 : ant.y > anchorYLocal} / MAX_FLYING, 0, 1)
```

敵アリの attack/disrupt は区別しない(§17.3)。この4つを「迎撃」「護衛」というラベルで扱わない。

### 5.4 特徴 21〜23(所有軌跡)

`coarseAntOwned[slot]`(Int32Array(1024))だけから求める。全盤面走査は禁止。
1判断につきスロットごとに1回計算してキャッシュする。

```
owned      = Σ_b m[b]
ownedTrailAmount = owned / CELL_COUNT

// 重心はブロック中心で近似する(ブロック中心のローカル座標)
cyLocal(b) = coarseLocalRow(side, floor(b/32)) * 8 + 3.5
cx(b)      = (b % 32) * 8 + 3.5
ownedTrailCentroidY = (Σ m[b] * cyLocal(b) / owned) / (HEIGHT - 1)

// X はトーラスなので円周平均を使う
θ(b)  = 2π * cx(b) / WIDTH
x̄     = atan2(Σ m sinθ, Σ m cosθ) を x に戻した値
varX  = Σ m * toroidalDistance(cx(b), x̄)^2 / owned
varY  = Σ m * (cyLocal(b) - ȳ)^2 / owned
ownedTrailSpread = clamp(sqrt(varX + varY) / C.OWNED_SPREAD_SCALE, 0, 1)
```

```js
// 正規化スケール。所有セルが盤面全体に散ったときの RMS 距離の目安。
export const OWNED_SPREAD_SCALE = Math.hypot(WIDTH / 4, HEIGHT / 4); // ≈ 90.5
```

---

## 6. Reference League(`src/reference-policies.js`)

学習しない固定4方策(§19)。**`generateActions` を共有**し、スコア関数だけを差し替える。
`createCpuAgent({ scoreAction })` の形で注入する(CEM は `scoreAction` を渡さず `weights` を渡す)。

```js
export const REFERENCE_POLICY_NAMES = ['ATTACK_ONLY', 'CHEAP_SPAM', 'SAVE_AND_BURST', 'DEFEND_HEAVY'];
export function createReferenceScorer(name): (action, view, ctx) => number
```

決定論的な共通 tie-break(すべての参照方策で同じ): `atStep` 昇順 → `templateId` 辞書順 → `launchX` 昇順。
スコアは「採用するものに正、しないものに `-Infinity`」を返し、順位は上の tie-break を
小さいほど高スコアになるよう単調写像して表す。

| 方策 | 規則 |
|---|---|
| `ATTACK_ONLY` | 即時の attack FIRE のみ採用。妨害・自爆は不採用。無ければ WAIT |
| `CHEAP_SPAM` | 即時 attack FIRE のうち `cost` 最小。同コストは共通 tie-break。無ければ WAIT |
| `SAVE_AND_BURST` | `avail < C.BURST_THRESHOLD` なら WAIT。以上なら `ATTACK_ONLY` と同じ |
| `DEFEND_HEAVY` | `source === 'counter'` の FIRE があればそれを共通 tie-break で1つ。無ければ `ATTACK_ONLY` |

```js
export const BURST_THRESHOLD = 20; // SAVE_AND_BURST 専用の固定値。CEM の学習対象ではない(§19.3)
```

---

## 7. `data/policy.json` 新スキーマ(§37)

旧フィールド(`policy` オブジェクト、`fireThreshold` 等)を**混在させない**。

```jsonc
{
  "trainedAt": "...",
  "method": "CEM_ACTION_CENTRIC",
  "featureSchemaVersion": 1,
  "dimensions": 24,
  "population": 80, "elite": 16, "gamesPerIndividual": 40,
  "minGenerations": 20, "maxGenerations": 60, "actualGenerations": 0,
  "seed": 1,
  "weights": [ /* 24要素。これが唯一の方策 */ ],
  "evaluation": {
    "referenceLeagueAverageWinRate": 0, "winRateVsAttackOnly": 0,
    "winRateVsCheapSpam": 0, "winRateVsSaveAndBurst": 0,
    "winRateVsDefendHeavy": 0, "winRateVsOldCPU": 0, "averageScoreDiff": 0
  },
  "performance": { "matchesPerSec": 0, "decisionsPerSec": 0, "avgCandidatesPerDecision": 0,
                   "p95CandidatesPerDecision": 0, "featureEncodeUsPerDecision": 0,
                   "actionScoreUsPerDecision": 0 },
  "trajectory": [ { "generation": 1, "bestFitness": 0, "eliteMeanFitness": 0,
                    "normalizedMeanShift": 0 } ],
  "validation": [ { "generation": 5, "candidate": "mean|generationBest|bestSoFar",
                    "referenceLeagueAverageWinRate": 0, "perOpponent": {} } ],
  "tacticsLog": { "wait": 0, "attackFire": 0, "disruptFire": 0, "selfDestruct": 0,
                  "byTemplate": {} }
}
```

`src/cpu.js` は `createCpuAgent({ templates, weights, rng, scheduleFire, selfDestruct, observe })`。
`policy` という引数名は使わない(旧スキーマと取り違えるため)。
`src/app.js` は `weights: policyData.weights` を渡す。

`data/policy-v55.json` は**旧スキーマの凍結スナップショット**。`src/cpu-legacy.js` と対で
`scripts/evaluate-policy.mjs` の §26.2 だけが読む。

---

## 8. 学習(`scripts/train-policy.mjs`)

- 24次元 対角ガウス CEM。`population=80` / `elite=16` / `gamesPerIndividual=40` /
  `minGenerations=20` / `maxGenerations=60`。
- 初期分布: `mean = 0`(24次元すべて)、`std = 1`。重みはクランプしない(スケール自由)。
  ただし `MIN_STD = 0.05` を下限にする。
- 1個体40試合の配分(§22): self-play 20 + 各リーグ 5×4。
- fitness = `0.5 * selfPlayWinRate + 0.5 * mean(4リーグの winRate) + 0.01 * avgScoreDiff`。
  **戦術使用回数を fitness に入れない**(§20)。
- CRN: 1世代・1評価枠の中では全個体が同じシード列。training seed と validation seed は
  別の名前空間(`deriveSeed(SEED, gen, slot)` と `deriveSeed(SEED, 0xVAL, checkpoint, ...)`)。
- 5世代ごとに held-out validation(§23): `mean` / `generationBest` / `bestSoFar` の3候補 ×
  リーグ4種 × 100試合 = 1候補あたり400試合。
- early stop(§24): 20世代未満は停止しない。20世代以降、直近2回の validation で
  best held-out `referenceLeagueAverageWinRate` の改善が **1ポイント未満**なら停止できる。
  `normalizedMeanShift` は**補助表示のみ**で停止条件にしない。
- 最終候補(§25): `final mean` / `best validation candidate` / 直近数世代の best を
  同一の固定 final-evaluation シード集合で再評価し、勝った1つを `weights` にする。
- 並列: `worker_threads`。**乱数はメインスレッドだけが持ち、ワーカーは純粋関数**
  (`generate-templates.mjs` と同じ規律)。結果は完了順ではなく**投入した添字順**に集約する。
  `--workers N`(既定 = `min(cpus-2, 22)`)。ワーカー数を変えても結果は一致すること。

## 9. 評価(`scripts/evaluate-policy.mjs` 新規)

- `--mode final`: リーグ4種 × 500試合 = 2,000試合、旧CPU(`src/cpu-legacy.js` +
  `data/policy-v55.json`)と 1,000試合。side1/side2 を均等割当。
- `--mode bench`(§28): `matches/sec` / `decisions/sec` / 平均・p95 候補数 /
  feature 時間 / scoring 時間 / coarse 更新コスト / ownership 更新コストを新旧CPUで比較。
- 戦術使用ログ(§27)を出力するが fitness には使わない。

---

## 10. テスト(`test/`)

| ファイル | 内容 |
|---|---|
| `test/coarse-board.test.js` | §31。全32×32が見える / band 変化 / anchorX でカーネルが変わる / X wrap 連続 / side1 のローカルY向きが side0 と一致 |
| `test/ownership.test.js` | §32。A→B の踏み直しで所有が移る / A自爆でそのセルは消えない / `ownedTrailAmount` = 実 cleanup セル数 / スロット解放 / 不変条件 |
| `test/action-features.test.js` | §30 死に次元(24次元すべてで `weight=±W` が順位を変える) / 全特徴が規定範囲内 |
| `test/action-generation.test.js` | §33 自爆候補(若いアリも候補・`destructAge` は候補生成に影響しない・ownership 0 でも候補) / §5(`scoreReachability=0` の攻撃も候補に残る) |
| `test/cpu.test.js` | §34 戦術非固定(4種すべてが weights 次第で選ばれる)/ 固定優先順位が無い / engine を import していない / 再現性 |
| `test/reference-league.test.js` | §35。4方策が決定論・世代非依存・CEM非参照 / fitness 配分 50 + 12.5×4 = 100% |

`node --test` の**件数**を必ず見る(0 tests で green にしない)。

---

## 11. この契約で明示的に決めた「仕様書に書かれていない」判断

1. **発射列のサンプリング**(§5 の「候補数制御上の上限内」の解釈): 得点ゲート内から4列・
   ゲート外から2列を **match RNG で一様に**引く。順位付けは24特徴に任せる。
   旧 `chooseAttackColumn` の汚染回避ヒューリスティクスは戦術の直接教示なので移植しない(§41)。
2. **1判断=1アクション**。旧実装の「自爆してから攻撃」「攻撃と同時に護衛を予約」という
   抱き合わせは廃止する(§3 の単一 Action 選択に反するため)。
3. **`lastToucherSlot` の導入**。§13/§14 は ownership map の持ち方を指定していないが、
   ホットパスで id→slot を引かないための実装上の要請。
4. **`OWNED_SPREAD_SCALE` / `BURST_THRESHOLD` の値**。仕様は「正規化する」「固定値」としか
   言っていないので、この文書が唯一の定義。
5. **`robustness`(特徴7)の実データ範囲が狭い**。現行3種は 0.9970 / 0.9974 / 0.9976 で
   ほぼ定数のため、この次元は実戦では学習信号が弱い。§30 の死に次元テストは
   構成した state で判定するので通るが、実測として `docs/spec.md` の未決定事項に記録する。
