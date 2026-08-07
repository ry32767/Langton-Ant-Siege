// 攻撃と妨害の共進化: 「妨害に強い攻撃」は探せるか / 防御は追いつけるか
const DIRS=[[0,-1],[1,0],[0,1],[-1,0]];
const R=n=>Math.floor(Math.random()*n);
const RULE='RRL',K=3,W=120,H=60,Z=16,L_ATT=2400,L_INT=400;
const idx=(x,y)=>y*W+x, gx=(s,x)=> s===0?x:W-1-x;
const TIMES=[0,150,300,450,600,750,900,1050,1200,1350];

function mk(side,ax,ay,ad,life){return{side,x:ax,y:ay,d:ad,life,steps:0,alive:true,scored:false};}
function step(b,a){ if(!a.alive)return;
  const i=idx(gx(a.side,a.x),a.y), st=b[i];
  a.d=RULE[st]==='R'?(a.d+1)&3:(a.d+3)&3; b[i]=(st+1)%K;
  a.x+=DIRS[a.d][0]; a.y=(a.y+DIRS[a.d][1]+H)%H; a.steps++;
  if(a.x<0){a.alive=false;return;}
  if(a.x>=W-Z){a.alive=false;a.scored=true;return;}
  if(a.steps>=a.life)a.alive=false;}
function place(b,s,c){for(const [x,y] of c) b[idx(gx(s,x),y)]=1;}
function blob(n,maxX=Z){const s=new Set();let x=R(maxX),y=R(H),g=0;
  while(s.size<n&&g++<n*30){s.add(y*W+x);const d=DIRS[R(4)],nx=x+d[0],ny=(y+d[1]+H)%H;
    if(nx>=0&&nx<maxX){x=nx;y=ny;}}
  return [...s].map(i=>[i%W,Math.floor(i/W)]);}
function solo(t){const b=new Uint8Array(W*H);place(b,0,t.cells);
  const a=mk(0,t.ant[0],t.ant[1],t.ant[2],L_ATT);
  while(a.alive)step(b,a); return a.scored?a.steps:0;}
function vs(t,dis,t0){
  const b=new Uint8Array(W*H); place(b,0,t.cells);
  const A=mk(0,t.ant[0],t.ant[1],t.ant[2],L_ATT); let I=null;
  for(let s=0;s<L_ATT;s++){
    if(s===t0){place(b,1,dis.cells);I=mk(1,dis.ant[0],dis.ant[1],dis.ant[2],L_INT);}
    step(b,A); if(I) step(b,I);
    if(!A.alive) break;
  }
  return A.scored;}
// この攻撃を止められる (妨害テンプレ, タイミング) の組み合わせ数
function counters(t,pool){ let n=0;
  for(const d of pool) for(const t0 of TIMES) if(!vs(t,d,t0)) n++;
  return n;}
function mut(t,maxCells,maxX=Z){
  const c=t.cells.map(a=>[a[0],a[1]]);let ant=[...t.ant];const op=R(6);
  if(op===0&&c.length<maxCells)c.push([R(maxX),R(H)]);
  else if(op===1&&c.length)c.splice(R(c.length),1);
  else if(op===2&&c.length){const k=R(c.length),d=DIRS[R(4)],nx=c[k][0]+d[0];
    if(nx>=0&&nx<maxX)c[k]=[nx,(c[k][1]+d[1]+H)%H];}
  else if(op===3){ant[0]=R(maxX);ant[1]=R(H);}
  else if(op===4){ant[2]=R(4);}
  else if(c.length){const dx=R(3)-1,dy=R(3)-1;
    for(let k=0;k<c.length;k++){const nx=c[k][0]+dx;if(nx>=0&&nx<maxX)c[k]=[nx,(c[k][1]+dy+H)%H];}}
  const sn=new Set(),u=[];for(const a of c){const k=a[1]*W+a[0];if(!sn.has(k)){sn.add(k);u.push(a);}}
  return {cells:u,ant};}

const NPOOL=Number(process.env.NPOOL||120);
let pool=Array.from({length:NPOOL},()=>({cells:blob(R(7)),ant:[R(Z),R(H),R(4)]}));
const COMB=NPOOL*TIMES.length;
console.log(`妨害の手札 ${NPOOL}種 × タイミング${TIMES.length}通り = ${COMB}通りのカウンター候補\n`);

// 攻撃候補を確保
const atts=[];
for(let i=0;i<1500000 && atts.length<25;i++){
  const t={cells:blob(R(17)),ant:[R(Z),R(H),R(4)]};
  if(solo(t)) atts.push(t);
}

function report(label,pool){
  const cs=atts.map(t=>counters(t,pool)).sort((a,b)=>a-b);
  const zero=cs.filter(c=>c===0).length;
  const med=cs[Math.floor(cs.length/2)];
  console.log(`${label}`);
  console.log(`  カウンター数: 最小 ${cs[0]} / 中央 ${med} / 最大 ${cs[cs.length-1]}  (${COMB}通り中)`);
  console.log(`  → 手札で止められない攻撃: ${zero}/${atts.length}件 (${(zero/atts.length*100).toFixed(0)}%)`);
  return {cs,zero};
}
report('【ラウンド0】乱数の妨害手札 vs 素直に探した攻撃', pool);

// --- 攻撃側: カウンター数を最小化する探索 ---
console.log('\n【ラウンド1】攻撃側が「カウンター数最小」で探索');
const T=process.hrtime.bigint();
const robust=[];
for(const seed of atts.slice(0,8)){
  let best=seed, bc=counters(seed,pool);
  for(let k=0;k<120;k++){
    const c=mut(best,16); if(!solo(c)) continue;
    const n=counters(c,pool);
    if(n<bc){bc=n;best=c;}
    if(bc===0) break;
  }
  robust.push({t:best,c:bc});
}
robust.sort((a,b)=>a.c-b.c);
console.log(`  探索後のカウンター数: ${robust.map(r=>r.c).join(', ')}`);
console.log(`  → 手札で止められない攻撃: ${robust.filter(r=>r.c===0).length}/${robust.length}件`);
console.log(`  所要 ${(Number(process.hrtime.bigint()-T)/1e9).toFixed(0)}秒`);

// --- 防御側: その強い攻撃を止められる妨害を探索して手札に加える ---
console.log('\n【ラウンド2】防御側が「強い攻撃を止められる妨害」を探索して手札に追加');
const hard=robust.filter(r=>r.c===0).map(r=>r.t);
if(!hard.length){ console.log('  止められない攻撃が無かったため省略'); }
else {
  let added=0, found=0;
  for(const h of hard){
    let ok=null;
    for(let k=0;k<3000;k++){
      const d={cells:blob(R(7)),ant:[R(Z),R(H),R(4)]};
      const t0=TIMES[R(TIMES.length)];
      if(!vs(h,d,t0)){ ok=d; break; }
    }
    if(ok){ pool.push(ok); added++; found++; } 
  }
  console.log(`  ${hard.length}件の強い攻撃のうち ${found}件についてカウンターを発見(各3000回まで探索)`);
  console.log(`  手札を ${NPOOL} → ${pool.length} に拡張`);
  const cs=hard.map(t=>counters(t,pool));
  console.log(`  拡張後のカウンター数: ${cs.join(', ')}`);
  console.log(`  → まだ止められない攻撃: ${cs.filter(c=>c===0).length}/${hard.length}件`);
}
