// 妨害込み評価: 「妨害に強い攻撃テンプレート」を探索できるか
// 評価 = 妨害テンプレート集 × 発射タイミング の総当たりで、生き残って得点できた割合(= robustness)
const DIRS=[[0,-1],[1,0],[0,1],[-1,0]];
const R=n=>Math.floor(Math.random()*n);
const RULE='RRL',K=3,W=120,H=60,Z=16,L_ATT=2400,L_INT=400;
const idx=(x,y)=>y*W+x, gx=(s,x)=> s===0?x:W-1-x;

function mk(side,ax,ay,ad,life){return{side,x:ax,y:ay,d:ad,life,steps:0,alive:true,scored:false};}
function step(b,a){ if(!a.alive)return;
  const i=idx(gx(a.side,a.x),a.y), st=b[i];
  a.d = RULE[st]==='R'?(a.d+1)&3:(a.d+3)&3; b[i]=(st+1)%K;
  a.x+=DIRS[a.d][0]; a.y=(a.y+DIRS[a.d][1]+H)%H; a.steps++;
  if(a.x<0){a.alive=false;return;}
  if(a.x>=W-Z){a.alive=false;a.scored=true;return;}
  if(a.steps>=a.life)a.alive=false;}
function place(b,s,c){for(const [x,y] of c) b[idx(gx(s,x),y)]=1;}
function blob(n){const s=new Set();let x=R(Z),y=R(H),g=0;
  while(s.size<n&&g++<n*30){s.add(y*W+x);const d=DIRS[R(4)],nx=x+d[0],ny=(y+d[1]+H)%H;
    if(nx>=0&&nx<Z){x=nx;y=ny;}}
  return [...s].map(i=>[i%W,Math.floor(i/W)]);}

// 単独評価(妨害なし)
function solo(t){
  const b=new Uint8Array(W*H); place(b,0,t.cells);
  const a=mk(0,t.ant[0],t.ant[1],t.ant[2],L_ATT);
  while(a.alive) step(b,a);
  return a.scored ? a.steps : 0;
}
// 妨害1発つきで評価
function vs(t,dis,t0){
  const b=new Uint8Array(W*H); place(b,0,t.cells);
  const A=mk(0,t.ant[0],t.ant[1],t.ant[2],L_ATT);
  let I=null;
  for(let s=0;s<L_ATT;s++){
    if(s===t0){ place(b,1,dis.cells); I=mk(1,dis.ant[0],dis.ant[1],dis.ant[2],L_INT); }
    step(b,A); if(I) step(b,I);
    if(!A.alive) break;
  }
  return A.scored;
}

// --- 妨害テンプレート集(防御側の手札)を用意 ---
const NPOOL=Number(process.env.NPOOL||60);
const TIMES=[0,200,400,600,800,1000,1200,1400];
const pool=Array.from({length:NPOOL},()=>({cells:blob(R(7)),ant:[R(Z),R(H),R(4)]}));

// robustness = 全 (妨害テンプレ × タイミング) のうち、止められなかった割合
function robustness(t){
  let ok=0,tot=0;
  for(const d of pool) for(const t0 of TIMES){ tot++; if(vs(t,d,t0)) ok++; }
  return ok/tot;
}

// --- 1. 素直に探した攻撃テンプレートの robustness 分布 ---
const plain=[];
for(let i=0;i<800000 && plain.length<40;i++){
  const t={cells:blob(R(17)),ant:[R(Z),R(H),R(4)]};
  const s=solo(t); if(s) plain.push({...t,steps:s});
}
const t0=process.hrtime.bigint();
const rs=plain.map(t=>robustness(t)).sort((a,b)=>a-b);
const sec=Number(process.hrtime.bigint()-t0)/1e9;
const q=p=>rs[Math.floor(rs.length*p)];
console.log(`=== 1. 素直に探した攻撃 ${plain.length}件 の妨害耐性(妨害${NPOOL}種 × タイミング${TIMES.length}通り = ${NPOOL*TIMES.length}試行/件) ===`);
console.log(` 生存率: 最低 ${(rs[0]*100).toFixed(1)}% / 中央 ${(q(.5)*100).toFixed(1)}% / 最高 ${(rs[rs.length-1]*100).toFixed(1)}%`);
console.log(` 評価コスト: ${(sec/plain.length*1000).toFixed(0)}ms/件`);

// --- 2. robustness を目的関数にして探索できるか ---
function mut(t){const c=t.cells.map(a=>[a[0],a[1]]);let ant=[...t.ant];const op=R(6);
  if(op===0&&c.length<16)c.push([R(Z),R(H)]);
  else if(op===1&&c.length)c.splice(R(c.length),1);
  else if(op===2&&c.length){const k=R(c.length),d=DIRS[R(4)],nx=c[k][0]+d[0];
    if(nx>=0&&nx<Z)c[k]=[nx,(c[k][1]+d[1]+H)%H];}
  else if(op===3){ant[0]=R(Z);ant[1]=R(H);}
  else if(op===4){ant[2]=R(4);}
  else if(c.length){const dx=R(3)-1,dy=R(3)-1;
    for(let k=0;k<c.length;k++){const nx=c[k][0]+dx;if(nx>=0&&nx<Z)c[k]=[nx,(c[k][1]+dy+H)%H];}}
  const sn=new Set(),u=[];for(const a of c){const k=a[1]*W+a[0];if(!sn.has(k)){sn.add(k);u.push(a);}}
  return {cells:u,ant};}

console.log('\n=== 2. robustness を最大化する探索(山登り・親は現行ベスト) ===');
let best=plain.reduce((a,b)=>robustness(a)>=robustness(b)?a:b);
let bestR=robustness(best);
console.log(` 開始: 生存率 ${(bestR*100).toFixed(1)}%`);
const T1=process.hrtime.bigint(); let evals=0;
const BUDGET=Number(process.env.BUDGET||600);
while(evals<BUDGET){
  const cand=mut(best); evals++;
  if(!solo(cand)) continue;              // 単独で得点できないものは論外
  const r=robustness(cand);
  if(r>bestR){ bestR=r; best=cand;
    console.log(`  評価${String(evals).padStart(4)}: 生存率 ${(bestR*100).toFixed(1)}%  (コスト ${5+best.cells.length}, 到達 ${solo(best)}ステップ)`); }
}
console.log(` ${evals}回の評価を ${(Number(process.hrtime.bigint()-T1)/1e9).toFixed(0)}秒 → 最終 生存率 ${(bestR*100).toFixed(1)}%`);
