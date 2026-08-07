// 実験E: 妨害用アリは、飛来するハイウェイを本当に壊せるか
// 盤面 W x H(上下ラップ)、両端に配置可能帯 Z。side1 は右へ、side2 は左へ進む。
// 共有盤面なので、両者のアリは中央付近ですれ違う。
const DIRS=[[0,-1],[1,0],[0,1],[-1,0]];
const R=n=>Math.floor(Math.random()*n);
const RULE='RRL', K=3;
const W=120,H=60,Z=16;
const idx=(x,y)=>y*W+x;

// side: 0=左(右へ進む) 1=右(左へ進む)。ローカル座標→グローバル
const gx=(s,x)=> s===0 ? x : W-1-x;

function makeAnt(side,cells,ax,ay,ad,life){
  return {side,cells,x:ax,y:ay,d:ad,life,steps:0,alive:true,scored:false};
}
// 1ステップ進める(ローカル座標で動き、盤面アクセス時にミラー)
function stepAnt(b,a){
  if(!a.alive) return;
  const X=gx(a.side,a.x), i=idx(X,a.y), st=b[i];
  a.d = RULE[st]==='R' ? (a.d+1)&3 : (a.d+3)&3;
  b[i]=(st+1)%K;
  // side2 は左右反転しているので、ローカルの「右」がグローバルの「左」
  a.x+=DIRS[a.d][0]; a.y=(a.y+DIRS[a.d][1]+H)%H;
  a.steps++;
  if(a.x<0){a.alive=false;return;}
  if(a.x>=W-Z){a.alive=false;a.scored=true;return;}
  if(a.steps>=a.life)a.alive=false;
}
function place(b,side,cells){ for(const [x,y] of cells) b[idx(gx(side,x),y)]=1; }
function blob(n,x0,x1){const s=new Set();let x=x0+R(x1-x0),y=R(H),g=0;
  while(s.size<n&&g++<n*30){s.add(y*W+x);const d=DIRS[R(4)],nx=x+d[0],ny=(y+d[1]+H)%H;
    if(nx>=x0&&nx<x1){x=nx;y=ny;}}
  return [...s].map(i=>[i%W,Math.floor(i/W)]);}

// --- 攻撃テンプレートを探索(単独で得点できるもの) ---
const L_ATT=2400;
function tryAttack(t){
  const b=new Uint8Array(W*H); place(b,0,t.cells);
  const a=makeAnt(0,t.cells,t.ant[0],t.ant[1],t.ant[2],L_ATT);
  while(a.alive) stepAnt(b,a);
  return a.scored ? a.steps : 0;
}
const attacks=[];
for(let i=0;i<400000 && attacks.length<40;i++){
  const t={cells:blob(R(16),0,Z),ant:[R(Z),R(H),R(4)]};
  const s=tryAttack(t); if(s) attacks.push({...t,steps:s});
}
console.log(`攻撃テンプレート ${attacks.length}件 を確保 (到達ステップ 中央値 ${attacks.map(a=>a.steps).sort((p,q)=>p-q)[Math.floor(attacks.length/2)]})`);

// --- 妨害: side2 から寿命 L_INT のアリを時刻 t0 に発射 ---
function trial(att, intCells, intAnt, L_INT, t0){
  const b=new Uint8Array(W*H); place(b,0,att.cells);
  const A=makeAnt(0,att.cells,att.ant[0],att.ant[1],att.ant[2],L_ATT);
  let I=null, placed=false;
  for(let s=0;s<L_ATT+t0+L_INT;s++){
    if(s===t0 && intCells){ place(b,1,intCells); placed=true;
      I=makeAnt(1,intCells,intAnt[0],intAnt[1],intAnt[2],L_INT); }
    stepAnt(b,A); if(I) stepAnt(b,I);
    if(!A.alive) break;
  }
  return A.scored;
}

console.log('\n=== E-1: 妨害アリの効果(乱数で撃つ場合) ===');
console.log(' 妨害の寿命 | 発射タイミング | 攻撃の得点率 | 低下');
for(const L_INT of [400,800,1600]){
  for(const t0 of [0,300,600]){
    let ok=0; const T=1200;
    for(let k=0;k<T;k++){
      const att=attacks[R(attacks.length)];
      if(trial(att, blob(R(6),0,Z), [R(Z),R(H),R(4)], L_INT, t0)) ok++;
    }
    console.log(`  ${String(L_INT).padStart(9)} | ${String(t0).padStart(13)} | ${(ok/T*100).toFixed(1).padStart(11)}% | ${(100-ok/T*100).toFixed(0)}%減`);
  }
}

console.log('\n=== E-2: 狙って撃つ場合(妨害テンプレートを探索した場合の上限) ===');
console.log(' 妨害の寿命 | 探索回数 | 攻撃を止められた割合');
for(const L_INT of [400,800,1600]){
  let stopped=0; const T=60;
  for(let k=0;k<T;k++){
    const att=attacks[R(attacks.length)];
    let best=false;
    for(let tr=0;tr<400;tr++){
      if(!trial(att, blob(R(6),0,Z), [R(Z),R(H),R(4)], L_INT, R(600))){ best=true; break; }
    }
    if(best) stopped++;
  }
  console.log(`  ${String(L_INT).padStart(9)} |      400 | ${(stopped/T*100).toFixed(0)}%`);
}
