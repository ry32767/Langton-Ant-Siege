// RRL(3色)ルールでの MAP-Elites アーカイブ: コスト × 到達時間 → 最大ダメージ
const W=40,H=20,BOUND=20,MAXX=17,ANT_COST=5,MAXC=20;
const DIRS=[[0,-1],[1,0],[0,1],[-1,0]];
const RULE=process.env.RULE||'RRL', K=RULE.length;
const SPS=Number(process.env.SPS||60);
const SPEED=[0.5,1,2,4,8,16,1e9].map(s=>s*SPS), NS=SPEED.length;
const rnd=n=>Math.floor(Math.random()*n), idx=(x,y)=>y*W+x;
const tier=s=>{for(let i=0;i<NS;i++) if(s<=SPEED[i]) return i; return NS-1;};

function evaluate(t,maxSteps=3000){
  const b=new Uint8Array(W*H);
  for(const [x,y] of t.cells) b[idx(x,y)]=1;
  let x=t.ant[0],y=t.ant[1],dir=t.ant[2],s=0;
  const cost=ANT_COST+t.cells.length;
  while(s<maxSteps){
    const i=idx(x,y), st=b[i];
    dir=RULE[st]==='R'?(dir+1)&3:(dir+3)&3;
    b[i]=(st+1)%K;
    x+=DIRS[dir][0]; y=(y+DIRS[dir][1]+H)%H; s++;
    if(x<0) return {outcome:'off',steps:s,damage:0,cost};
    if(x>=BOUND){
      const seen=new Uint8Array(W*H),stk=[[x,y]]; seen[idx(x,y)]=1; let n=1;
      while(stk.length){const [cx,cy]=stk.pop();
        for(const [dx,dy] of DIRS){const nx=cx+dx; if(nx<0||nx>=W)continue;
          const ny=(cy+dy+H)%H,j=idx(nx,ny);
          if(!seen[j]&&b[j]!==0){seen[j]=1;n++;stk.push([nx,ny]);}}}
      return {outcome:'arr',steps:s,damage:n,cost};
    }
  }
  return {outcome:'to',steps:s,damage:0,cost};
}
function randT(){const n=rnd(MAXC+1),s=new Set();let x=rnd(MAXX),y=rnd(H),g=0;
  while(s.size<n&&g++<n*40){s.add(y*W+x);const d=DIRS[rnd(4)];const nx=x+d[0],ny=(y+d[1]+H)%H;if(nx>=0&&nx<MAXX){x=nx;y=ny;}}
  return {cells:[...s].map(i=>[i%W,Math.floor(i/W)]),ant:[rnd(MAXX),rnd(H),rnd(4)]};}
function mut(t){const c=t.cells.map(a=>[a[0],a[1]]);let ant=[...t.ant];const op=rnd(6);
  if(op===0&&c.length<MAXC)c.push([rnd(MAXX),rnd(H)]);
  else if(op===1&&c.length)c.splice(rnd(c.length),1);
  else if(op===2&&c.length){const k=rnd(c.length),d=DIRS[rnd(4)],nx=c[k][0]+d[0];if(nx>=0&&nx<MAXX)c[k]=[nx,(c[k][1]+d[1]+H)%H];}
  else if(op===3){ant[0]=rnd(MAXX);ant[1]=rnd(H);}
  else if(op===4){ant[2]=rnd(4);}
  else if(c.length){const dx=rnd(3)-1,dy=rnd(3)-1;for(let k=0;k<c.length;k++){const nx=c[k][0]+dx;if(nx>=0&&nx<MAXX)c[k]=[nx,(c[k][1]+dy+H)%H];}}
  const sn=new Set(),u=[];for(const a of c){const k=a[1]*W+a[0];if(!sn.has(k)){sn.add(k);u.push(a);}}
  return {cells:u,ant};}

const B=Number(process.argv[2]||5e6); const arc=new Map(); let ev=0;
const t0=process.hrtime.bigint();
const add=t=>{const r=evaluate(t);ev++;if(r.outcome!=='arr')return;
  const b=r.cost*NS+tier(r.steps),c=arc.get(b);if(!c||r.damage>c.damage)arc.set(b,{...r,tpl:t});};
for(let i=0;i<20000;i++)add(randT());
while(ev<B){const k=[...arc.keys()];add(mut(arc.get(k[rnd(k.length)]).tpl));}
console.log(`ルール ${RULE} / ${B.toLocaleString()}評価 / ${(Number(process.hrtime.bigint()-t0)/1e9).toFixed(1)}秒 / ${arc.size}マス\n`);
console.log('■ コスト × 到達時間 → 最大ダメージ');
console.log('cost |'+['~0.5s','~1s','~2s','~4s','~8s','~16s','16s~'].map(h=>h.padStart(7)).join(' |'));
for(let c=ANT_COST;c<=ANT_COST+MAXC;c++){
  const row=[];for(let s=0;s<NS;s++){const v=arc.get(c*NS+s);row.push(v?String(v.damage).padStart(7):'      -');}
  console.log(String(c).padStart(4)+' |'+row.join(' |'));
}
