// 実験C: (1) 古典アリでのテンプレート生成の現実性  (2) 防御ブロックの効き方
const DIRS=[[0,-1],[1,0],[0,1],[-1,0]];
const R=n=>Math.floor(Math.random()*n);
const HWP={RL:104,RRL:18};

function shot(rule,W,H,Z,L,cells,ax,ay,ad,defend){
  const K=rule.length,b=new Uint8Array(W*H),idx=(x,y)=>y*W+x;
  for(const [x,y] of cells) b[idx(x,y)]=1;
  if(defend) for(const [x,y] of defend) b[idx(x,y)]=1;
  let x=ax,y=ay,d=ad,s=0,hw=0;
  const P=HWP[rule]; const hx=[],hy=[];
  while(s<L){
    hx.push(x);hy.push(y);
    const i=idx(x,y),st=b[i];
    d=rule[st]==='R'?(d+1)&3:(d+3)&3;
    b[i]=(st+1)%K;
    x+=DIRS[d][0]; y=(y+DIRS[d][1]+H)%H; s++;
    if(x<0||x>=W) return {out:'off',s,hw};
    if(hx.length>P){const dx=x-hx[hx.length-P];let dy=y-hy[hy.length-P];
      if(dy>H/2)dy-=H; if(dy<-H/2)dy+=H;
      if(dx!==0&&Math.abs(dx)===Math.abs(dy)&&Math.abs(dx)<=2)hw++;}
    if(x>=W-Z) return {out:'score',s,hw};
  }
  return {out:'to',s,hw};
}
function blob(n,x0,x1,H,W){const set=new Set();let x=x0+R(x1-x0),y=R(H),g=0;
  while(set.size<n&&g++<n*30){set.add(y*W+x);const d=DIRS[R(4)],nx=x+d[0],ny=(y+d[1]+H)%H;
    if(nx>=x0&&nx<x1){x=nx;y=ny;}}
  return [...set].map(i=>[i%W,Math.floor(i/W)]);}
function mut(t,x0,x1,H,W,MAXC){
  const c=t.cells.map(a=>[a[0],a[1]]); let ant=[...t.ant]; const op=R(6);
  if(op===0&&c.length<MAXC)c.push([x0+R(x1-x0),R(H)]);
  else if(op===1&&c.length)c.splice(R(c.length),1);
  else if(op===2&&c.length){const k=R(c.length),d=DIRS[R(4)],nx=c[k][0]+d[0];
    if(nx>=x0&&nx<x1)c[k]=[nx,(c[k][1]+d[1]+H)%H];}
  else if(op===3){ant[0]=x0+R(x1-x0);ant[1]=R(H);}
  else if(op===4){ant[2]=R(4);}
  else if(c.length){const dx=R(3)-1,dy=R(3)-1;
    for(let k=0;k<c.length;k++){const nx=c[k][0]+dx;if(nx>=x0&&nx<x1)c[k]=[nx,(c[k][1]+dy+H)%H];}}
  const sn=new Set(),u=[];for(const a of c){const k=a[1]*W+a[0];if(!sn.has(k)){sn.add(k);u.push(a);}}
  return {cells:u,ant};}

console.log('=== C-1: テンプレート生成の現実性(盤面120x60・Z=8) ===');
const W=120,H=60,Z=8,MAXC=20;
for(const [rule,L] of [['RRL',2420],['RL',17380]]){
  const arc=new Map(); let ev=0; const t0=process.hrtime.bigint();
  const NS=6, tierOf=s=>Math.min(NS-1,Math.floor(s/L*NS));
  const add=t=>{const r=shot(rule,W,H,Z,L,t.cells,t.ant[0],t.ant[1],t.ant[2]);ev++;
    if(r.out!=='score')return;
    const b=t.cells.length*NS+tierOf(r.s), c=arc.get(b);
    if(!c||r.hw/r.s>c.q) arc.set(b,{tpl:t,s:r.s,q:r.hw/r.s});};
  const BUDGET = rule==='RRL' ? 2e6 : 3e5;
  for(let i=0;i<Math.min(20000,BUDGET/10);i++)
    add({cells:blob(R(MAXC+1),0,Z,H,W),ant:[R(Z),R(H),R(4)]});
  while(ev<BUDGET){ const k=[...arc.keys()];
    if(!k.length){ add({cells:blob(R(MAXC+1),0,Z,H,W),ant:[R(Z),R(H),R(4)]}); continue; }
    add(mut(arc.get(k[R(k.length)]).tpl,0,Z,H,W,MAXC)); }
  const sec=Number(process.hrtime.bigint()-t0)/1e9;
  const qs=[...arc.values()].map(v=>v.q).sort((a,b)=>b-a);
  console.log(` ${rule.padEnd(4)} L=${String(L).padStart(6)} : ${ev.toLocaleString()}評価を ${sec.toFixed(1)}秒 (${Math.round(ev/sec).toLocaleString()}評価/秒)`);
  console.log(`      → テンプレート ${arc.size}件 / HW割合 中央値 ${qs.length?(qs[Math.floor(qs.length/2)]*100).toFixed(0)+'%':'—'} 最高 ${qs.length?(qs[0]*100).toFixed(0)+'%':'—'}`);
  console.log(`      → 1000万評価の推定所要 ${(1e7/(ev/sec)/60).toFixed(1)}分`);
}

console.log('\n=== C-2: 防御ブロックの効き方(RRL・120x60・Z=8・L=2420) ===');
console.log('  敵陣に置く防御ブロック数 | 得点率(乱数配置) | 得点率の低下');
const L=2420; let base=null;
for(const nd of [0,5,10,20,40,80]){
  const T=8000; let sc=0;
  for(let t=0;t<T;t++){
    const def=nd?blob(nd,W-Z,W,H,W):[];
    const r=shot('RRL',W,H,Z,L,blob(R(15),0,Z,H,W),R(Z),R(H),R(4),def);
    if(r.out==='score')sc++;
  }
  const p=sc/T*100; if(base===null)base=p;
  console.log(`  ${String(nd).padStart(24)} | ${p.toFixed(1).padStart(15)}% | ${((1-p/base)*100).toFixed(0)}% 減`);
}
