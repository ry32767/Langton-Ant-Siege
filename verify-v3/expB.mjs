// 実験B: 新ジオメトリ(両端に配置可能域、敵の配置可能域に到達で得点、最大ステップ制限)
// 「ハイウェイ級の挙動でないと得点できない」ことを最大ステップ制限で担保できるか
const DIRS=[[0,-1],[1,0],[0,1],[-1,0]];
const R=n=>Math.floor(Math.random()*n);

// hspeed: 横方向のハイウェイ速度(列/ステップ)
const RULES={ RL:{k:2,hs:2/104,hwP:104}, RRL:{k:3,hs:1/18,hwP:18} };

function shot(rule,W,H,Z,L,cells,ax,ay,ad,defend=[],edge='die'){
  const K=rule.length, b=new Uint8Array(W*H), idx=(x,y)=>y*W+x;
  for(const [x,y] of cells) b[idx(x,y)]=1;
  for(const [x,y] of defend) b[idx(x,y)]=1;
  let x=ax,y=ay,d=ad,s=0,hw=0;
  const P=RULES[rule].hwP, hx=[],hy=[];
  while(s<L){
    hx.push(x);hy.push(y);
    const i=idx(x,y),st=b[i];
    d = rule[st]==='R'?(d+1)&3:(d+3)&3;
    b[i]=(st+1)%K;
    x+=DIRS[d][0]; y=(y+DIRS[d][1]+H)%H; s++;
    if(x<0){ if(edge==='wrap') x+=W; else return {out:'off',s,hw}; }
    if(x>=W){ if(edge==='wrap') x-=W; else return {out:'off',s,hw}; }
    if(hx.length>P){
      const A=[x,y], B=[hx[hx.length-P],hy[hy.length-P]];
      let dy=A[1]-B[1]; if(dy>H/2)dy-=H; if(dy<-H/2)dy+=H;
      const dx=A[0]-B[0];
      if(dx!==0&&Math.abs(dx)===Math.abs(dy)&&Math.abs(dx)<=2) hw++;
    }
    if(x>=W-Z) return {out:'score',s,hw};
  }
  return {out:'timeout',s,hw};
}
function blob(n,x0,x1,H,W){
  const set=new Set(); let x=x0+R(x1-x0),y=R(H),g=0;
  while(set.size<n&&g++<n*30){ set.add(y*W+x);
    const d=DIRS[R(4)],nx=x+d[0],ny=(y+d[1]+H)%H;
    if(nx>=x0&&nx<x1){x=nx;y=ny;} }
  return [...set].map(i=>[i%W,Math.floor(i/W)]);
}

console.log('=== 実験B-1: 最大ステップ制限で「ハイウェイ以外を落とせるか」(RRL) ===');
console.log('  盤面   Z  余裕率 | 最大ステップL | 得点率 | 得点した弾のHW割合');
for(const [W,H] of [[80,40],[120,60],[160,60]]){
  const Z=8, base=Math.ceil((W-Z)/RULES.RRL.hs);
  for(const m of [1.05,1.2,1.5,2.5]){
    const L=Math.ceil(base*m); const T=8000;
    let sc=0,hwSum=0,stSum=0;
    for(let t=0;t<T;t++){
      const r=shot('RRL',W,H,Z,L,blob(R(15),0,Z,H,W),R(Z),R(H),R(4));
      if(r.out==='score'){sc++;hwSum+=r.hw;stSum+=r.s;}
    }
    console.log(` ${W}x${H}  ${Z}  ${m.toFixed(2)}  | ${String(L).padStart(12)} | ${(sc/T*100).toFixed(1).padStart(5)}% | ${sc?(hwSum/stSum*100).toFixed(1)+'%':'—'}`);
  }
}

console.log('\n=== 実験B-2: 古典アリ(RL)は新ジオメトリで成立するか ===');
console.log('  盤面     端の扱い | 最大ステップL | 得点率 | HW割合');
for(const [W,H] of [[120,60],[200,80]]){
  const Z=8, base=Math.ceil(9976 + (W-Z)/RULES.RL.hs);
  for(const edge of ['die','wrap']){
    for(const m of [1.1,1.5]){
      const L=Math.ceil(base*m), T=1500;
      let sc=0,hwSum=0,stSum=0;
      for(let t=0;t<T;t++){
        const r=shot('RL',W,H,Z,L,blob(R(15),0,Z,H,W),R(Z),R(H),R(4),[],edge);
        if(r.out==='score'){sc++;hwSum+=r.hw;stSum+=r.s;}
      }
      console.log(` ${W}x${H}  ${edge==='die'?'場外で死  ':'左右もラップ'}  | ${String(L).padStart(12)} | ${(sc/T*100).toFixed(1).padStart(5)}% | ${sc?(hwSum/stSum*100).toFixed(0)+'%':'—'}`);
    }
  }
}
