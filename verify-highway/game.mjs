// RRL(3色)ルールを実際のゲーム盤面(40x20 トーラス・配置禁止帯3列)で検証
const W=40,H=20,BOUND=20,MAXX=17,ANT_COST=5;
const DIRS=[[0,-1],[1,0],[0,1],[-1,0]];
const RULE=process.env.RULE||'RRL';
const K=RULE.length;
const rnd=n=>Math.floor(Math.random()*n);
const idx=(x,y)=>y*W+x;

function shot(cells, ax, ay, adir, maxSteps=3000){
  const b=new Uint8Array(W*H);
  for(const [x,y] of cells) b[idx(x,y)]=1;      // 配置マスは状態1
  let x=ax,y=ay,dir=adir,steps=0;
  const hx=[],hy=[];
  while(steps<maxSteps){
    hx.push(x);hy.push(y);
    const i=idx(x,y), st=b[i];
    dir = RULE[st]==='R' ? (dir+1)&3 : (dir+3)&3;
    b[i]=(st+1)%K;
    x+=DIRS[dir][0]; y=(y+DIRS[dir][1]+H)%H; steps++;
    if(x<0) return {outcome:'off',steps,dmg:0,hx,hy};
    if(x>=BOUND){
      // ダメージ = 到達マスを「色付き」とみなした4連結の非白マス総数
      const seen=new Uint8Array(W*H); const st2=[[x,y]]; seen[idx(x,y)]=1; let n=1;
      while(st2.length){const [cx,cy]=st2.pop();
        for(const [dx,dy] of DIRS){const nx=cx+dx; if(nx<0||nx>=W)continue;
          const ny=(cy+dy+H)%H; const j=idx(nx,ny);
          if(!seen[j]&&b[j]!==0){seen[j]=1;n++;st2.push([nx,ny]);}}}
      return {outcome:'arr',steps,dmg:n,hx,hy};
    }
  }
  return {outcome:'timeout',steps,dmg:0,hx,hy};
}
const stat=a=>{if(!a.length)return'n/a';const s=[...a].sort((p,q)=>p-q);const q=p=>s[Math.min(s.length-1,Math.floor(s.length*p))];
  return `median=${q(.5)} p90=${q(.9)} max=${s[s.length-1]} mean=${(a.reduce((p,c)=>p+c,0)/a.length).toFixed(1)}`;};

console.log(`=== ルール ${RULE} を 40x20 トーラス盤面で検証 ===`);
for(const n of [0,10,20]){
  const T=20000; let arr=0,off=0,to=0; const st=[],dm=[];
  for(let t=0;t<T;t++){
    const cells=[]; const s=new Set();
    let cx=rnd(MAXX),cy=rnd(H),g=0;
    while(s.size<n&&g++<n*40){s.add(cy*W+cx);const d=DIRS[rnd(4)];const nx=cx+d[0],ny=(cy+d[1]+H)%H;if(nx>=0&&nx<MAXX){cx=nx;cy=ny;}}
    for(const i of s) cells.push([i%W,Math.floor(i/W)]);
    const r=shot(cells, rnd(MAXX), rnd(H), rnd(4));
    if(r.outcome==='arr'){arr++;st.push(r.steps);dm.push(r.dmg);} else if(r.outcome==='off')off++; else to++;
  }
  console.log(`\n 配置マス${String(n).padStart(2)}個 (コスト${ANT_COST+n}):`);
  console.log(`   到達 ${(arr/T*100).toFixed(1)}%  場外 ${(off/T*100).toFixed(1)}%  打切り ${(to/T*100).toFixed(1)}%`);
  console.log(`   到達ステップ: ${stat(st)}`);
  console.log(`   ダメージ:     ${stat(dm)}`);
}

// 直線性(ハイウェイらしさ)の確認: 到達した弾の軌跡がどれだけ直線的か
console.log('\n=== 軌跡の直線性(1に近いほど真っ直ぐなハイウェイ) ===');
for(const n of [0,20]){
  let sum=0,c=0;
  for(let t=0;t<3000;t++){
    const cells=[]; const s=new Set(); let cx=rnd(MAXX),cy=rnd(H),g=0;
    while(s.size<n&&g++<n*40){s.add(cy*W+cx);const d=DIRS[rnd(4)];const nx=cx+d[0],ny=(cy+d[1]+H)%H;if(nx>=0&&nx<MAXX){cx=nx;cy=ny;}}
    for(const i of s) cells.push([i%W,Math.floor(i/W)]);
    const r=shot(cells,rnd(MAXX),rnd(H),rnd(4));
    if(r.outcome!=='arr'||r.steps<40) continue;
    // 訪問マスの異なり数 / ステップ数 (1に近い=同じ道を戻らず進み続ける=ハイウェイ)
    const uniq=new Set(); for(let k=0;k<r.hx.length;k++) uniq.add(r.hy[k]*W+r.hx[k]);
    sum+=uniq.size/r.hx.length; c++;
  }
  console.log(` 配置マス${n}個: 直線性 = ${(sum/c).toFixed(3)} (${c}件平均)`);
}
