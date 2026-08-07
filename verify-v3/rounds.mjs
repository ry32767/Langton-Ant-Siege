// 攻撃/妨害の共進化を複数ラウンド回して収束するか見る
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
function vs(t,d,t0){const b=new Uint8Array(W*H);place(b,0,t.cells);
  const A=mk(0,t.ant[0],t.ant[1],t.ant[2],L_ATT);let I=null;
  for(let s=0;s<L_ATT;s++){
    if(s===t0){place(b,1,d.cells);I=mk(1,d.ant[0],d.ant[1],d.ant[2],L_INT);}
    step(b,A);if(I)step(b,I); if(!A.alive)break;}
  return A.scored;}
function counters(t,pool){let n=0;for(const d of pool)for(const t0 of TIMES)if(!vs(t,d,t0))n++;return n;}
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

let pool=Array.from({length:100},()=>({cells:blob(R(7)),ant:[R(Z),R(H),R(4)]}));
let atts=[];
for(let i=0;i<2e6 && atts.length<16;i++){const t={cells:blob(R(17)),ant:[R(Z),R(H),R(4)]};if(solo(t))atts.push(t);}
const T0=process.hrtime.bigint();
console.log('ラウンド | 妨害手札 | カウンター数(最小/中央/最大) | 止められない攻撃 | 累計秒');
for(let round=0;round<=4;round++){
  const comb=pool.length*TIMES.length;
  const cs=atts.map(t=>counters(t,pool)).sort((a,b)=>a-b);
  const zero=cs.filter(c=>c===0).length;
  const sec=Number(process.hrtime.bigint()-T0)/1e9;
  console.log(`   ${round}    |   ${String(pool.length).padStart(4)}   |   ${String(cs[0]).padStart(3)} / ${String(cs[Math.floor(cs.length/2)]).padStart(4)} / ${String(cs[cs.length-1]).padStart(4)}  (${comb}通り中) |     ${zero}/${atts.length}      | ${sec.toFixed(0)}`);
  if(round===4) break;
  // 攻撃側: カウンター最小化
  atts = atts.map(seed=>{
    let best=seed, bc=counters(seed,pool);
    for(let k=0;k<80;k++){const c=mut(best);if(!solo(c))continue;
      const n=counters(c,pool); if(n<bc){bc=n;best=c;} if(bc===0)break;}
    return best;});
  // 防御側: 止められない攻撃へのカウンターを探して手札に追加
  for(const t of atts){
    if(counters(t,pool)>0) continue;
    for(let k=0;k<4000;k++){
      const d={cells:blob(R(7)),ant:[R(Z),R(H),R(4)]}, t0=TIMES[R(TIMES.length)];
      if(!vs(t,d,t0)){ pool.push(d); break; }
    }
  }
}
