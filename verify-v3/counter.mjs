// 実験F: 攻撃テンプレートごとの「止めにくさ」の分布 + 多重発射で防御を飽和させられるか
const DIRS=[[0,-1],[1,0],[0,1],[-1,0]];
const R=n=>Math.floor(Math.random()*n);
const RULE='RRL',K=3,W=120,H=60,Z=16,L_ATT=2400;
const idx=(x,y)=>y*W+x, gx=(s,x)=> s===0?x:W-1-x;
function mk(side,ax,ay,ad,life){return {side,x:ax,y:ay,d:ad,life,steps:0,alive:true,scored:false};}
function step(b,a){ if(!a.alive)return;
  const X=gx(a.side,a.x),i=idx(X,a.y),st=b[i];
  a.d=RULE[st]==='R'?(a.d+1)&3:(a.d+3)&3; b[i]=(st+1)%K;
  a.x+=DIRS[a.d][0]; a.y=(a.y+DIRS[a.d][1]+H)%H; a.steps++;
  if(a.x<0){a.alive=false;return;}
  if(a.x>=W-Z){a.alive=false;a.scored=true;return;}
  if(a.steps>=a.life)a.alive=false;}
function place(b,s,c){for(const [x,y] of c) b[idx(gx(s,x),y)]=1;}
function blob(n,x0,x1){const s=new Set();let x=x0+R(x1-x0),y=R(H),g=0;
  while(s.size<n&&g++<n*30){s.add(y*W+x);const d=DIRS[R(4)],nx=x+d[0],ny=(y+d[1]+H)%H;
    if(nx>=x0&&nx<x1){x=nx;y=ny;}}
  return [...s].map(i=>[i%W,Math.floor(i/W)]);}

// 攻撃テンプレート確保
const atts=[];
for(let i=0;i<600000 && atts.length<30;i++){
  const t={cells:blob(R(16),0,Z),ant:[R(Z),R(H),R(4)]};
  const b=new Uint8Array(W*H); place(b,0,t.cells);
  const a=mk(0,t.ant[0],t.ant[1],t.ant[2],L_ATT);
  while(a.alive) step(b,a);
  if(a.scored) atts.push({...t,steps:a.steps});
}
// N発の攻撃 + M発の妨害 を同時に走らせて、得点した攻撃の数を返す
function battle(attList, intList){
  const b=new Uint8Array(W*H);
  const ants=[];
  for(const t of attList){ place(b,0,t.cells); ants.push(mk(0,t.ant[0],t.ant[1],t.ant[2],L_ATT)); }
  const pend=intList.map(o=>({...o,fired:false}));
  for(let s=0;s<L_ATT;s++){
    for(const p of pend) if(!p.fired && s===p.t0){ p.fired=true; place(b,1,p.cells);
      ants.push(mk(1,p.ant[0],p.ant[1],p.ant[2],p.life)); }
    for(const a of ants) step(b,a);
    if(ants.filter(a=>a.side===0).every(a=>!a.alive)) break;
  }
  return ants.filter(a=>a.side===0&&a.scored).length;
}
const rndInt=(life)=>({cells:blob(R(6),0,Z),ant:[R(Z),R(H),R(4)],life,t0:R(600)});

console.log('=== F-1: 攻撃テンプレートごとの「止めにくさ」(妨害寿命400・乱数400回試行) ===');
const diff=[];
for(const att of atts){
  let stops=0;
  for(let k=0;k<400;k++) if(battle([att],[rndInt(400)])===0) stops++;
  diff.push(stops/400);
}
diff.sort((a,b)=>a-b);
const q=p=>diff[Math.floor(diff.length*p)];
console.log(` 乱数妨害1発で止まる確率: 最小 ${(diff[0]*100).toFixed(1)}% / 中央 ${(q(.5)*100).toFixed(1)}% / 最大 ${(diff[diff.length-1]*100).toFixed(1)}%`);
console.log(` → 一番止めにくい弾でも、専用の妨害を400回探索すれば見つかる確率 ${(1-Math.pow(1-diff[0],400)).toFixed(4)}`);

console.log('\n=== F-2: 多重発射で防御を飽和させられるか(妨害は狙って撃つ=各攻撃に有効な1発を用意) ===');
console.log(' 攻撃の数 | 妨害の数 | 得点した攻撃の平均本数 | 通過率');
for(const na of [1,2,3]){
  for(const ni of [0,1,2,3]){
    let sum=0,tot=0; const T=200;
    for(let k=0;k<T;k++){
      const A=Array.from({length:na},()=>atts[R(atts.length)]);
      // 妨害は「探索済みの有効な1発」を模して、当たりが出るまで探した結果を使う
      const I=[];
      for(let m=0;m<ni;m++){
        let best=rndInt(400);
        for(let tr=0;tr<150;tr++){ const c=rndInt(400);
          if(battle([A[m%na]],[c])===0){best=c;break;} }
        I.push(best);
      }
      sum+=battle(A,I); tot+=na;
    }
    console.log(`  ${String(na).padStart(7)} | ${String(ni).padStart(7)} | ${(sum/T).toFixed(2).padStart(20)} | ${(sum/tot*100).toFixed(0)}%`);
  }
}
