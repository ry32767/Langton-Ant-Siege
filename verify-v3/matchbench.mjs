// v3 実盤面での1試合シミュレーションのスループット(CPU方策学習の所要時間を見積もる)
const DIRS=[[0,-1],[1,0],[0,1],[-1,0]];
const R=n=>Math.floor(Math.random()*n);
const RULE='RRL',K=3,W=120,H=60,Z=16;
const SPS=120, TIME=240, WIN=5, CAP=30, MAXFLY=4;
const L_ATT=2400,L_INT=400, C_ATT=5, C_INT=3;
const idx=(x,y)=>y*W+x, gx=(s,x)=> s===0?x:W-1-x;
function blob(n){const s=new Set();let x=R(Z),y=R(H),g=0;
  while(s.size<n&&g++<n*30){s.add(y*W+x);const d=DIRS[R(4)],nx=x+d[0],ny=(y+d[1]+H)%H;
    if(nx>=0&&nx<Z){x=nx;y=ny;}}
  return [...s].map(i=>[i%W,Math.floor(i/W)]);}
// テンプレート9+9を用意(中身の質は問わない。速度計測が目的)
const ATK=Array.from({length:9},()=>({cells:blob(R(12)),ant:[R(Z),R(H),R(4)]}));
const DIS=Array.from({length:9},()=>({cells:blob(R(5)),ant:[R(Z),R(H),R(4)]}));

function match(p1,p2){
  const b=new Uint8Array(W*H), last=new Int16Array(W*H).fill(-1);
  const sides=[{sc:0,tok:0,ants:[],p:p1},{sc:0,tok:0,ants:[],p:p2}];
  let nid=0;
  const totalSteps=TIME*SPS;
  for(let s=0;s<totalSteps;s++){
    if(s%SPS===0) for(const S of sides) S.tok=Math.min(CAP,S.tok+1);
    // 意思決定(1秒に1回)
    if(s%SPS===0) for(let i=0;i<2;i++){
      const S=sides[i], O=sides[1-i];
      if(S.ants.length>=MAXFLY) continue;
      const enemyIn = O.ants.some(a=>a.kind==='attack');
      const useD = enemyIn && Math.random()<S.p.defendBias;
      const tpl = useD ? DIS[R(9)] : ATK[R(9)];
      const cost = (useD?C_INT:C_ATT) + tpl.cells.length;
      if(S.tok < Math.max(cost, S.p.fireThreshold)) continue;
      S.tok-=cost;
      const id=nid++;
      for(const [x,y] of tpl.cells){const j=idx(gx(i,x),y); b[j]=1; last[j]=id;}
      S.ants.push({id,side:i,kind:useD?'disrupt':'attack',
        x:tpl.ant[0],y:tpl.ant[1],d:tpl.ant[2],steps:0,life:useD?L_INT:L_ATT,cells:tpl.cells});
    }
    for(let i=0;i<2;i++){
      const S=sides[i];
      for(let k=S.ants.length-1;k>=0;k--){
        const a=S.ants[k];
        const j=idx(gx(i,a.x),a.y), st=b[j];
        a.d=RULE[st]==='R'?(a.d+1)&3:(a.d+3)&3; b[j]=(st+1)%K; last[j]=a.id;
        a.x+=DIRS[a.d][0]; a.y=(a.y+DIRS[a.d][1]+H)%H; a.steps++;
        let dead=false;
        if(a.x<0) dead=true;
        else if(a.x>=W-Z){ S.sc++; dead=true; }
        else if(a.steps>=a.life) dead=true;
        if(dead){
          for(const [x,y] of a.cells){const q=idx(gx(i,x),y); if(last[q]===-1||last[q]===a.id){b[q]=0;last[q]=-1;}}
          for(let q=0;q<W*H;q++) if(last[q]===a.id){b[q]=0;last[q]=-1;}
          S.ants.splice(k,1);
        }
      }
    }
    if(sides[0].sc>=WIN||sides[1].sc>=WIN) break;
  }
  return sides[0].sc>sides[1].sc?0:(sides[1].sc>sides[0].sc?1:-1);
}
const P=()=>({fireThreshold:5+R(15),defendBias:Math.random()});
console.log('=== v3 実盤面での試合シミュレーション速度 ===');
const N=60, t0=process.hrtime.bigint();
let r={0:0,1:0,'-1':0};
for(let i=0;i<N;i++) r[match(P(),P())]++;
const sec=Number(process.hrtime.bigint()-t0)/1e9;
console.log(` ${N}試合を ${sec.toFixed(1)}秒 → ${(N/sec).toFixed(1)} 試合/秒`);
console.log(` 勝敗: side1 ${r[0]} / side2 ${r[1]} / 引き分け ${r['-1']}`);
const perGen = 60*40;
console.log(`\n CEM学習の見積り(集団60 × 各40試合 = ${perGen}試合/世代):`);
console.log(`   1世代 ≈ ${(perGen/(N/sec)).toFixed(0)}秒 / 40世代 ≈ ${(perGen*40/(N/sec)/60).toFixed(0)}分`);
console.log(` バランス検証 5,000試合 ≈ ${(5000/(N/sec)/60).toFixed(1)}分`);
