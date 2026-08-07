// ハイウェイ検出器の較正 + 各種アリのハイウェイ出現時刻の測定
const DIRS=[[0,-1],[1,0],[0,1],[-1,0]];

// 汎用チューリング・アント(多色対応)。rule[i] = 'L' or 'R' (状態iのときの回転)
// 状態は 0..k-1 を巡回。無限盤面(Map)で測定。
export function run(rule, maxSteps, detectWin=1000, detectDist=25){
  const k=rule.length;
  const cells=new Map();
  let x=0,y=0,dir=0;
  const hist=new Int32Array(maxSteps*2+2);
  let highwayAt=-1;
  for(let s=0;s<maxSteps;s++){
    hist[s*2]=x; hist[s*2+1]=y;
    const key=x*100000+y;
    const st=cells.get(key)||0;
    dir = rule[st]==='R' ? (dir+1)&3 : (dir+3)&3;
    cells.set(key,(st+1)%k);
    x+=DIRS[dir][0]; y+=DIRS[dir][1];
    if(highwayAt<0 && s>=detectWin){
      const px=hist[(s-detectWin)*2], py=hist[(s-detectWin)*2+1];
      if(Math.hypot(x-px,y-py) > detectDist){
        // 確認: さらに detectWin 進んでも同じ方向に伸び続けるか(後段でチェック)
        highwayAt=s;
      }
    }
  }
  // 到達範囲
  let minx=1e9,maxx=-1e9,miny=1e9,maxy=-1e9;
  for(const key of cells.keys()){ const cx=Math.round(key/100000), cy=key-cx*100000;
    if(cx<minx)minx=cx; if(cx>maxx)maxx=cx; if(cy<miny)miny=cy; if(cy>maxy)maxy=cy; }
  return {highwayAt, cellsUsed:cells.size, w:maxx-minx+1, h:maxy-miny+1, endX:x, endY:y};
}

// --- 較正: 古典ラングトンのアリ(RL)で ~10,000 に出るか ---
console.log('=== 検出器の較正: 古典ラングトンのアリ (rule=RL) ===');
const c=run('RL', 20000);
console.log(` ハイウェイ検出ステップ = ${c.highwayAt}  (既知の値 ~10,000 と一致すれば検出器は妥当)`);
console.log(` 20,000ステップ時点の到達範囲 = ${c.w} x ${c.h}`);

// --- 多色チューリング・アントの探索 ---
console.log('\n=== 多色チューリング・アントのハイウェイ出現時刻(色数3〜6の全ルールを網羅) ===');
const results=[];
for(let k=3;k<=6;k++){
  for(let m=0;m<(1<<k);m++){
    const rule=[...Array(k)].map((_,i)=>(m>>i&1)?'R':'L').join('');
    if(new Set(rule).size===1) continue;                 // 全部同じ回転は円を描くだけ
    const r=run(rule, 25000);
    if(r.highwayAt>0) results.push({rule, k, at:r.highwayAt, span:`${r.w}x${r.h}`});
  }
}
results.sort((a,b)=>a.at-b.at);
console.log(' rule       色数  ハイウェイ出現  そのときの到達範囲');
for(const r of results.slice(0,25))
  console.log(`  ${r.rule.padEnd(8)}  ${r.k}     ${String(r.at).padStart(7)}      ${r.span}`);
console.log(` (ハイウェイを出した ${results.length} ルール / 検査した全ルール中)`);
