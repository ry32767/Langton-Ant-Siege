// 厳密なハイウェイ検出: 「並進をともなう周期運動」が終端まで continuous に続く最早時刻を求める
const DIRS=[[0,-1],[1,0],[0,1],[-1,0]];

export function trace(rule, maxSteps){
  const k=rule.length, cells=new Map();
  let x=0,y=0,dir=0;
  const px=new Int32Array(maxSteps+1), py=new Int32Array(maxSteps+1);
  for(let s=0;s<maxSteps;s++){
    px[s]=x; py[s]=y;
    const key=x*1000003+y, st=cells.get(key)||0;
    dir = rule[st]==='R' ? (dir+1)&3 : (dir+3)&3;
    cells.set(key,(st+1)%k);
    x+=DIRS[dir][0]; y+=DIRS[dir][1];
  }
  px[maxSteps]=x; py[maxSteps]=y;
  return {px,py,cells};
}

// 終端付近で「pos[t+P]-pos[t] が一定 かつ 非ゼロ」となる最小周期 P を探す
export function findPeriod(px,py,n,maxP=3000,reps=6){
  for(let P=1;P<=maxP;P++){
    const base=n-P*(reps+1);
    if(base<0) break;
    const dx=px[base+P]-px[base], dy=py[base+P]-py[base];
    if(dx===0&&dy===0) continue;
    let ok=true;
    for(let r=1;r<=reps;r++){
      if(px[base+P*(r+1)]-px[base+P*r]!==dx || py[base+P*(r+1)]-py[base+P*r]!==dy){ ok=false; break; }
    }
    if(ok) return {P,dx,dy};
  }
  return null;
}

// その周期構造が「いつから」始まったか(最早の開始時刻)を二分探索
export function highwayStart(px,py,n,P,dx,dy){
  const holds = t => {
    for(let s=t; s+P<=n; s+=P)
      if(px[s+P]-px[s]!==dx || py[s+P]-py[s]!==dy) return false;
    return true;
  };
  let lo=0, hi=n-P;
  if(!holds(hi)) return -1;
  while(lo<hi){ const mid=(lo+hi)>>1; if(holds(mid)) hi=mid; else lo=mid+1; }
  return lo;
}

export function analyze(rule, maxSteps=60000){
  const {px,py}=trace(rule,maxSteps);
  const per=findPeriod(px,py,maxSteps);
  if(!per) return {rule, highway:false};
  const start=highwayStart(px,py,maxSteps,per.P,per.dx,per.dy);
  const speed=Math.hypot(per.dx,per.dy)/per.P;
  return {rule, highway:true, start, period:per.P, step:[per.dx,per.dy], speed};
}

if(process.argv[2]==='calib'){
  console.log('=== 較正: 古典ラングトンのアリ (RL) ===');
  console.log(analyze('RL',60000));
}
