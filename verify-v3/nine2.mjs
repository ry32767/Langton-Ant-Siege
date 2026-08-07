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
function traj(t){const b=new Uint8Array(W*H);place(b,0,t.cells);
  const a=mk(0,t.ant[0],t.ant[1],t.ant[2],L_ATT);const p=[];
  while(a.alive){p.push([a.x,a.y]);step(b,a);}return p;}
function vs(t,d,t0){const b=new Uint8Array(W*H);place(b,0,t.cells);
  const A=mk(0,t.ant[0],t.ant[1],t.ant[2],L_ATT);let I=null;
  for(let s=0;s<L_ATT;s++){
    if(s===t0){place(b,1,d.cells);I=mk(1,d.ant[0],d.ant[1],d.ant[2],L_INT);}
    step(b,A);if(I)step(b,I); if(!A.alive)break;}
  return A.scored;}

const NA=60,ND=80;
const A=[],D=[];
for(let i=0;i<5e6 && A.length<NA;i++){const t={cells:blob(R(17)),ant:[R(Z),R(H),R(4)]};
  const s=solo(t); if(s) A.push({...t,steps:s});}
for(let i=0;i<ND;i++) D.push({cells:blob(R(7)),ant:[R(Z),R(H),R(4)]});
const M=A.map(a=>D.map(d=>TIMES.filter(t0=>!vs(a,d,t0)).length));

console.log(`=== 候補プール ${NA}攻撃 × ${ND}妨害 のカウンター行列 ===`);
const perA=M.map(r=>r.filter(v=>v>0).length);
const perD=D.map((_,j)=>M.filter(r=>r[j]>0).length);
const s=a=>[...a].sort((x,y)=>x-y);
console.log(` 攻撃1件を止められる妨害の種類数(${ND}種中): 最小${s(perA)[0]} 中央${s(perA)[Math.floor(NA/2)]} 最大${s(perA)[NA-1]}`);
console.log(` 妨害1件がカバーする攻撃数(${NA}件中): 最小${s(perD)[0]} 中央${s(perD)[Math.floor(ND/2)]} 最大${s(perD)[ND-1]}`);
console.log(` カウンターが1つも無い攻撃: ${perA.filter(v=>v===0).length}件 / 何も止められない妨害: ${perD.filter(v=>v===0).length}件\n`);

// ---- 貪欲 + 局所探索で 9x9 を選ぶ ----
function evaluate(ai,di){
  const sub=ai.map(a=>di.map(d=>M[a][d]>0?1:0));
  const pa=sub.map(r=>r.reduce((x,y)=>x+y,0));
  const pd=di.map((_,j)=>sub.reduce((s2,r)=>s2+r[j],0));
  let sc=0;
  if(pa.some(v=>v===0)) sc-=1000*pa.filter(v=>v===0).length;   // 止められない攻撃は重いペナルティ
  if(pd.some(v=>v===0)) sc-=200*pd.filter(v=>v===0).length;    // 死に札もペナルティ
  sc -= pa.reduce((x,v)=>x+Math.abs(v-3),0);                   // 各攻撃のカウンターは3種前後が理想
  sc -= pd.reduce((x,v)=>x+Math.abs(v-3),0);
  const cs=new Set(ai.map(a=>5+A[a].cells.length)), ts=new Set(ai.map(a=>Math.floor(A[a].steps/200)));
  sc += cs.size*2 + ts.size*2;                                  // コスト・到達時間の多様性
  return sc;
}
let ai=[...Array(NA).keys()].slice(0,9), di=[...Array(ND).keys()].slice(0,9), cur=evaluate(ai,di);
for(let it=0;it<200000;it++){
  const na=[...ai],nd=[...di];
  if(Math.random()<0.5){ na[R(9)] = R(NA); if(new Set(na).size<9) continue; }
  else { nd[R(9)] = R(ND); if(new Set(nd).size<9) continue; }
  const v=evaluate(na,nd);
  if(v>=cur){cur=v;ai=na;di=nd;}
}
const sub=ai.map(a=>di.map(d=>M[a][d]));
const pa=sub.map(r=>r.filter(v=>v>0).length), pd=di.map((_,j)=>sub.filter(r=>r[j]>0).length);
console.log('=== 選抜した 9攻撃 × 9妨害 (数値 = 止まる発射タイミングの数 / 10通り中) ===');
console.log('             ' + di.map((_,j)=>`D${j+1}`.padStart(4)).join('') + '   カウンター');
sub.forEach((r,i)=>console.log(
  `  A${i+1} c${String(5+A[ai[i]].cells.length).padStart(2)} ${String(A[ai[i]].steps).padStart(4)}st ` +
  r.map(v=>String(v).padStart(4)).join('') + `   ${pa[i]}種`));
console.log('  カバー数     ' + pd.map(v=>String(v).padStart(4)).join(''));
console.log(`\n → 止められない攻撃 ${pa.filter(v=>v===0).length}件 / 死に札 ${pd.filter(v=>v===0).length}件`);
console.log(` → 攻撃あたりのカウンター種数: ${s(pa).join(',')}`);
console.log(` → コスト ${[...new Set(ai.map(a=>5+A[a].cells.length))].sort((x,y)=>x-y).join(',')} / 到達 ${[...new Set(ai.map(a=>Math.round(A[a].steps/120*10)/10))].sort((x,y)=>x-y).join(', ')}秒`);

// ---- 識別可能性 ----
const trs=ai.map(a=>traj(A[a]));
let ident=-1;
for(let t=1;t<=1200;t++){
  if(new Set(trs.map(p=>p[Math.min(t,p.length-1)].join(','))).size===9){ident=t;break;}
}
console.log(`\n=== 防御側は飛来中の攻撃を識別できるか ===`);
console.log(` 9種の位置がすべて異なるステップ: ${ident>0?ident+` (${(ident/120).toFixed(2)}秒)`:'不可'}`);
const st0=new Set(ai.map(a=>`${A[a].ant[0]},${A[a].ant[1]},${A[a].ant[2]}`));
console.log(` 発射位置・向きが異なる組み合わせ: ${st0.size}/9`);
// カウンターが有効な最も遅い発射タイミング(防御側の猶予)
let latest=[];
for(let i=0;i<9;i++){ let mx=-1;
  for(let j=0;j<9;j++){ if(M[ai[i]][di[j]]===0) continue;
    for(const t0 of TIMES) if(!vs(A[ai[i]],D[di[j]],t0)) mx=Math.max(mx,t0); }
  latest.push(mx); }
console.log(` 各攻撃に対しカウンターが成立する最も遅い発射タイミング: ${latest.join(', ')} ステップ`);
console.log(` → 識別に${ident}ステップかかるので、猶予が${ident}以上あれば「見てから対応」が成立する`);
