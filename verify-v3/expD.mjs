// 実験D: 得点条件を「敵の配置可能域に入った瞬間」→「敵の配置可能域を突破して奥の端に到達」に変えると
//        防御ブロックが機能するか
const DIRS=[[0,-1],[1,0],[0,1],[-1,0]];
const R=n=>Math.floor(Math.random()*n);
function shot(W,H,Z,L,cells,ax,ay,ad,defend,mode){
  const K=3,RULE='RRL',b=new Uint8Array(W*H),idx=(x,y)=>y*W+x;
  for(const [x,y] of cells) b[idx(x,y)]=1;
  for(const [x,y] of defend) b[idx(x,y)]=1;
  const goal = mode==='enter' ? W-Z : W-1;
  let x=ax,y=ay,d=ad,s=0;
  while(s<L){
    const i=idx(x,y),st=b[i];
    d=RULE[st]==='R'?(d+1)&3:(d+3)&3;
    b[i]=(st+1)%K;
    x+=DIRS[d][0]; y=(y+DIRS[d][1]+H)%H; s++;
    if(x<0||x>=W) return x>=W?{out:'score',s}:{out:'off',s};
    if(x>=goal) return {out:'score',s};
  }
  return {out:'to',s};
}
function blob(n,x0,x1,H,W){const set=new Set();let x=x0+R(x1-x0),y=R(H),g=0;
  while(set.size<n&&g++<n*30){set.add(y*W+x);const d=DIRS[R(4)],nx=x+d[0],ny=(y+d[1]+H)%H;
    if(nx>=x0&&nx<x1){x=nx;y=ny;}}
  return [...set].map(i=>[i%W,Math.floor(i/W)]);}
function scatter(n,x0,x1,H,W){const s=new Set();
  while(s.size<n) s.add(R(H)*W + x0 + R(x1-x0));
  return [...s].map(i=>[i%W,Math.floor(i/W)]);}

const W=120,H=60,L=2600;
console.log('=== D: 防御ブロックの効き方(RRL・120x60) ===');
for(const mode of ['enter','cross']){
  console.log(`\n■ 得点条件: ${mode==='enter'?'敵の配置可能域に入った瞬間':'敵の配置可能域を突破して奥の端に到達'}`);
  for(const Z of [8,16]){
    console.log(`  帯の深さ Z=${Z}`);
    console.log('    防御ブロック |  ばらまき配置  |   壁状に密集`');
    let b0=null,b1=null;
    for(const nd of [0,10,20,40,80]){
      const T=6000; let s1=0,s2=0;
      for(let t=0;t<T;t++){
        const off=blob(R(15),0,Z,H,W), a=[R(Z),R(H),R(4)];
        if(shot(W,H,Z,L,off,a[0],a[1],a[2],nd?scatter(nd,W-Z,W,H,W):[],mode).out==='score')s1++;
        if(shot(W,H,Z,L,off,a[0],a[1],a[2],nd?blob(nd,W-Z,W,H,W):[],mode).out==='score')s2++;
      }
      const p1=s1/T*100,p2=s2/T*100;
      if(b0===null){b0=p1;b1=p2;}
      console.log(`    ${String(nd).padStart(11)} | ${p1.toFixed(1).padStart(5)}% (${((1-p1/b0)*100).toFixed(0).padStart(3)}%減) | ${p2.toFixed(1).padStart(5)}% (${((1-p2/b1)*100).toFixed(0).padStart(3)}%減)`);
    }
  }
}
