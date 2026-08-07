// 攻撃に「護衛の妨害アリ」を随伴させると、相手の迎撃を防げるか
const DIRS=[[0,-1],[1,0],[0,1],[-1,0]];
const R=n=>Math.floor(Math.random()*n);
const RULE='RRL',K=3,W=120,H=60,Z=16,L_ATT=2400,L_INT=400;
const idx=(x,y)=>y*W+x, gx=(s,x)=> s===0?x:W-1-x;
const TIMES=[0,150,300,450,600,750,900,1050,1200,1350];
function mk(s,x,y,d,l){return{side:s,x,y,d,life:l,steps:0,alive:true,scored:false};}
function step(b,a){ if(!a.alive)return;
  const i=idx(gx(a.side,a.x),a.y),st=b[i];
  a.d=RULE[st]==='R'?(a.d+1)&3:(a.d+3)&3; b[i]=(st+1)%K;
  a.x+=DIRS[a.d][0]; a.y=(a.y+DIRS[a.d][1]+H)%H; a.steps++;
  if(a.x<0){a.alive=false;return;}
  if(a.x>=W-Z){a.alive=false;a.scored=true;return;}
  if(a.steps>=a.life)a.alive=false;}
function place(b,s,c){for(const [x,y] of c)b[idx(gx(s,x),y)]=1;}
function blob(n){const s=new Set();let x=R(Z),y=R(H),g=0;
  while(s.size<n&&g++<n*30){s.add(y*W+x);const d=DIRS[R(4)],nx=x+d[0],ny=(y+d[1]+H)%H;
    if(nx>=0&&nx<Z){x=nx;y=ny;}}
  return [...s].map(i=>[i%W,Math.floor(i/W)]);}
function solo(t){const b=new Uint8Array(W*H);place(b,0,t.cells);
  const a=mk(0,t.ant[0],t.ant[1],t.ant[2],L_ATT);while(a.alive)step(b,a);return a.scored?a.steps:0;}
// 攻撃(side0) + 護衛(side0の妨害, 時刻e0) vs 迎撃(side1の妨害, 時刻t0)
function battle(att, esc, e0, cnt, t0){
  const b=new Uint8Array(W*H); place(b,0,att.cells);
  const A=mk(0,att.ant[0],att.ant[1],att.ant[2],L_ATT);
  const ants=[A]; let ep=esc?{...esc,fired:false}:null, cp=cnt?{...cnt,fired:false}:null;
  for(let s=0;s<L_ATT;s++){
    if(ep&&!ep.fired&&s===e0){ep.fired=true;place(b,0,esc.cells);
      ants.push(mk(0,esc.ant[0],esc.ant[1],esc.ant[2],L_INT));}
    if(cp&&!cp.fired&&s===t0){cp.fired=true;place(b,1,cnt.cells);
      ants.push(mk(1,cnt.ant[0],cnt.ant[1],cnt.ant[2],L_INT));}
    for(const a of ants) step(b,a);
    if(!A.alive) break;
  }
  return A.scored;
}
// 攻撃候補と、その有効カウンターを1件ずつ確保
const cases=[];
for(let i=0;i<5e6 && cases.length<10;i++){
  const t={cells:blob(R(17)),ant:[R(Z),R(H),R(4)]};
  const s=solo(t); if(!s) continue;
  let hit=null;
  for(let k=0;k<2500;k++){
    const d={cells:blob(R(7)),ant:[R(Z),R(H),R(4)]}, t0=TIMES[R(TIMES.length)];
    if(!battle(t,null,0,d,t0)){ hit={d,t0}; break; }
  }
  if(hit) cases.push({att:{...t,steps:s},cnt:hit.d,t0:hit.t0});
}
console.log(`=== 攻撃 ${cases.length}件 と、それぞれの有効な迎撃を確保 ===`);
console.log(' (迎撃だけを撃たれた場合、いずれも攻撃は止まる = 得点0)\n');

console.log('=== 護衛の妨害アリを随伴させたときの突破率 ===');
console.log(' 護衛の探索回数 | 迎撃を突破できた攻撃 | 突破率');
for(const TRY of [0,50,200,800]){
  let ok=0;
  for(const c of cases){
    if(TRY===0){ if(battle(c.att,null,0,c.cnt,c.t0)) ok++; continue; }
    let saved=false;
    for(let k=0;k<TRY;k++){
      const esc={cells:blob(R(7)),ant:[R(Z),R(H),R(4)]}, e0=R(1200);
      if(battle(c.att,esc,e0,c.cnt,c.t0)){ saved=true; break; }
    }
    if(saved) ok++;
  }
  console.log(`  ${String(TRY).padStart(13)} | ${String(ok).padStart(19)}/${cases.length} | ${(ok/cases.length*100).toFixed(0)}%`);
}
// 護衛を付けた攻撃に対し、防御側が別の迎撃を探せるか
console.log('\n=== 護衛付きの攻撃に対し、防御側が新しい迎撃を探せるか ===');
let found=0, tested=0;
for(const c of cases.slice(0,6)){
  let esc=null,e0=0;
  for(let k=0;k<800;k++){
    const e={cells:blob(R(7)),ant:[R(Z),R(H),R(4)]}, t=R(1200);
    if(battle(c.att,e,t,c.cnt,c.t0)){ esc=e; e0=t; break; }
  }
  if(!esc) continue;
  tested++;
  for(let k=0;k<2500;k++){
    const d={cells:blob(R(7)),ant:[R(Z),R(H),R(4)]}, t0=TIMES[R(TIMES.length)];
    if(!battle(c.att,esc,e0,d,t0)){ found++; break; }
  }
}
console.log(`  護衛付き攻撃 ${tested}件のうち、新たな迎撃が見つかったもの: ${found}件 (各2500回まで探索)`);
