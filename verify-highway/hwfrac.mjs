// 飛行のうち「ハイウェイ状態」(周期Pの並進運動)にある割合を直接測る
const W=40,BOUND=20,MAXX=17;
const DIRS=[[0,-1],[1,0],[0,1],[-1,0]];
const rnd=n=>Math.floor(Math.random()*n);

function shot(H, RULE, P, cells, ax,ay,adir, maxSteps=4000){
  const K=RULE.length, b=new Uint8Array(W*H), idx=(x,y)=>y*W+x;
  for(const [x,y] of cells) b[idx(x,y)]=1;
  let x=ax,y=ay,dir=adir,s=0; const hx=[],hy=[];
  while(s<maxSteps){
    hx.push(x);hy.push(y);
    const i=idx(x,y), st=b[i];
    dir = RULE[st]==='R'?(dir+1)&3:(dir+3)&3;
    b[i]=(st+1)%K;
    x+=DIRS[dir][0]; y=(y+DIRS[dir][1]+H)%H; s++;
    if(x<0) return {out:'off',hx,hy,steps:s};
    if(x>=BOUND) return {out:'arr',hx,hy,steps:s};
  }
  return {out:'to',hx,hy,steps:s};
}
// ハイウェイ状態のステップ数(周期Pで x が単調に ±1/±2 進み、y も同量動く区間)
function hwSteps(hx,hy,P,H){
  let n=0;
  for(let t=0;t+P<hx.length;t++){
    const dx=hx[t+P]-hx[t];
    let dy=hy[t+P]-hy[t]; if(dy>H/2)dy-=H; if(dy<-H/2)dy+=H;
    if(dx!==0 && Math.abs(dx)===Math.abs(dy) && Math.abs(dx)<=2) n++;
  }
  return n;
}
function gen(n,H){const s=new Set();let cx=rnd(MAXX),cy=rnd(H),g=0;
  while(s.size<n&&g++<n*40){s.add(cy*W+cx);const d=DIRS[rnd(4)];const nx=cx+d[0],ny=(cy+d[1]+H)%H;if(nx>=0&&nx<MAXX){cx=nx;cy=ny;}}
  return [...s].map(i=>[i%W,Math.floor(i/W)]);}

console.log('=== 飛行時間のうちハイウェイ状態にある割合 ===');
console.log(' ルール  盤面高さ  配置数 | 到達率 | 平均飛行 | ハイウェイ割合 | ハイウェイ区間の長さ');
for(const [RULE,P] of [['RRL',18],['RL',104]]){
  for(const H of [20,40]){
    for(const n of [0,20]){
      const T=4000; let arr=0,sumS=0,sumH=0,c=0,maxRun=0;
      for(let t=0;t<T;t++){
        const r=shot(H,RULE,P,gen(n,H),rnd(MAXX),rnd(H),rnd(4));
        if(r.out!=='arr') continue;
        arr++; const h=hwSteps(r.hx,r.hy,P,H);
        sumS+=r.steps; sumH+=h; c++;
        // 最長の連続ハイウェイ区間
        let run=0,best=0;
        for(let k=0;k+P<r.hx.length;k++){
          const dx=r.hx[k+P]-r.hx[k]; let dy=r.hy[k+P]-r.hy[k];
          if(dy>H/2)dy-=H; if(dy<-H/2)dy+=H;
          if(dx!==0&&Math.abs(dx)===Math.abs(dy)&&Math.abs(dx)<=2){run++;best=Math.max(best,run);}else run=0;
        }
        maxRun+=best;
      }
      console.log(` ${RULE.padEnd(6)} ${String(H).padStart(6)}  ${String(n).padStart(5)} | ${(arr/T*100).toFixed(1).padStart(5)}% | ${(sumS/c).toFixed(0).padStart(7)} | ${(sumH/sumS*100).toFixed(1).padStart(12)}% | 平均${(maxRun/c).toFixed(0)}ステップ`);
    }
  }
}
