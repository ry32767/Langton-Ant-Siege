// B案: 古典ラングトンのアリのまま、「ハイウェイの頭」を初期配置として与えて即ハイウェイ化できるか
// → 必要な最小セル数を測る(=トークンコストとして現実的か)
const DIRS=[[0,-1],[1,0],[0,1],[-1,0]];
const N=600, OFF=300;
function idx(x,y){return (y+OFF)*N+(x+OFF);}

// 古典アリを走らせてハイウェイ状態のスナップショットを取る
function snapshot(atStep){
  const b=new Uint8Array(N*N); let x=0,y=0,dir=0;
  for(let s=0;s<atStep;s++){
    const i=idx(x,y);
    if(b[i]===0){b[i]=1;dir=(dir+1)&3;} else {b[i]=0;dir=(dir+3)&3;}
    x+=DIRS[dir][0]; y+=DIRS[dir][1];
  }
  return {b,x,y,dir};
}
// 与えた種でハイウェイが継続するか(アリが r マス以上、直線的に進み続けるか)
function testSeed(cells, ax, ay, adir, steps=3000){
  const b=new Uint8Array(N*N);
  for(const [cx,cy] of cells) b[idx(cx,cy)]=1;
  let x=ax,y=ay,dir=adir; const hx=[],hy=[];
  for(let s=0;s<steps;s++){
    hx.push(x); hy.push(y);
    const i=idx(x,y);
    if(x<-OFF+2||y<-OFF+2||x>OFF-2||y>OFF-2) break;
    if(b[i]===0){b[i]=1;dir=(dir+1)&3;} else {b[i]=0;dir=(dir+3)&3;}
    x+=DIRS[dir][0]; y+=DIRS[dir][1];
  }
  // 周期104・並進(±2,±2) が最初から続いているか
  let ok=0;
  for(let t=0;t+104*4<hx.length;t+=104){
    const dx=hx[t+104]-hx[t], dy=hy[t+104]-hy[t];
    if(Math.abs(dx)===2&&Math.abs(dy)===2) ok++; else break;
  }
  return ok>=8;   // 8周期以上ハイウェイが続けば成功
}

const snap=snapshot(12000);
console.log('=== B案: 古典アリ(RL)に「ハイウェイの頭」を初期配置として与える ===');
console.log('アリ周辺の何マスを再現すればハイウェイが即座に継続するか:');
console.log(' 半径 | 与えるセル数(黒マス) | ハイウェイ継続');
let best=null;
for(const r of [3,4,5,6,8,10,12,15,20,25,30]){
  const cells=[];
  for(let dx=-r;dx<=r;dx++) for(let dy=-r;dy<=r;dy++){
    const cx=snap.x+dx, cy=snap.y+dy;
    if(snap.b[idx(cx,cy)]===1) cells.push([cx,cy]);
  }
  const ok=testSeed(cells, snap.x, snap.y, snap.dir);
  console.log(` ${String(r).padStart(4)} | ${String(cells.length).padStart(19)} | ${ok?'○ 成功':'× 失敗'}`);
  if(ok&&!best) best={r,n:cells.length};
}
if(best) console.log(`\n → 最小で 半径${best.r} / 黒マス ${best.n} 個 が必要`);
else console.log('\n → 半径30(黒マス数百)でも即ハイウェイ化できず');
