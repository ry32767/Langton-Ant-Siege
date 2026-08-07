// 実験A: 上下ラップ(トーラス)の高さ H で、古典アリ(RL)のハイウェイは形成されるか
// 幅は無制限(Mapで保持)。ハイウェイ = 並進をともなう周期運動
const DIRS=[[0,-1],[1,0],[0,1],[-1,0]];
function trace(rule,H,maxSteps){
  const K=rule.length, c=new Map(); let x=0,y=0,d=0;
  const px=new Int32Array(maxSteps+1), py=new Int32Array(maxSteps+1);
  for(let s=0;s<maxSteps;s++){
    px[s]=x; py[s]=y;
    const key=x*100003+y, st=c.get(key)||0;
    d = rule[st]==='R'?(d+1)&3:(d+3)&3;
    c.set(key,(st+1)%K);
    x+=DIRS[d][0];
    y = H>0 ? (y+DIRS[d][1]+H)%H : y+DIRS[d][1];
  }
  px[maxSteps]=x; py[maxSteps]=y;
  return {px,py};
}
function findPeriod(px,py,n,H,maxP=3000,reps=6){
  const wrap=v=>{ if(H<=0) return v; let w=v%H; if(w>H/2)w-=H; if(w<-H/2)w+=H; return w; };
  for(let P=1;P<=maxP;P++){
    const b=n-P*(reps+1); if(b<0) break;
    const dx=px[b+P]-px[b], dy=wrap(py[b+P]-py[b]);
    if(dx===0&&dy===0) continue;
    let ok=true;
    for(let r=1;r<=reps;r++)
      if(px[b+P*(r+1)]-px[b+P*r]!==dx || wrap(py[b+P*(r+1)]-py[b+P*r])!==dy){ok=false;break;}
    if(ok) return {P,dx,dy};
  }
  return null;
}
function start(px,py,n,P,dx,dy,H){
  const wrap=v=>{ if(H<=0) return v; let w=v%H; if(w>H/2)w-=H; if(w<-H/2)w+=H; return w; };
  const holds=t=>{ for(let s=t;s+P<=n;s+=P) if(px[s+P]-px[s]!==dx||wrap(py[s+P]-py[s])!==dy) return false; return true; };
  let lo=0,hi=n-P; if(!holds(hi)) return -1;
  while(lo<hi){const m=(lo+hi)>>1; if(holds(m))hi=m; else lo=m+1;}
  return lo;
}
console.log('=== 実験A: トーラスの高さ H とハイウェイ形成(幅は無制限) ===');
console.log(' ルール   高さH  | ハイウェイ開始 | 周期 | 1周期の並進 | 横方向の速度(列/ステップ)');
for(const rule of ['RL','RRL']){
  for(const H of [20,40,60,80,100,140,0]){
    const N=rule==='RL'?60000:20000;
    const {px,py}=trace(rule,H,N);
    const per=findPeriod(px,py,N,H);
    if(!per){ console.log(` ${rule.padEnd(6)} ${String(H||'∞').padStart(6)}  | ${'形成されず'.padStart(13)} |`); continue; }
    const st=start(px,py,N,per.P,per.dx,per.dy,H);
    console.log(` ${rule.padEnd(6)} ${String(H||'∞').padStart(6)}  | ${String(st).padStart(13)} | ${String(per.P).padStart(4)} | (${per.dx},${per.dy})`.padEnd(66)+ (Math.abs(per.dx)/per.P).toFixed(4));
  }
}
