import { analyze, trace } from './detect2.mjs';

console.log('=== A. 多色チューリング・アント: ハイウェイ出現の早さ(厳密判定・色数3〜6の全ルール) ===');
const res=[];
for(let k=2;k<=6;k++) for(let m=0;m<(1<<k);m++){
  const rule=[...Array(k)].map((_,i)=>(m>>i&1)?'R':'L').join('');
  if(new Set(rule).size===1) continue;
  const r=analyze(rule,40000);
  if(r.highway) res.push(r);
}
res.sort((a,b)=>a.start-b.start);
const seen=new Set(); const uniq=[];
for(const r of res){ // 鏡像(L/R反転)は同一挙動なので片方だけ
  const mir=[...r.rule].map(c=>c==='R'?'L':'R').join('');
  if(seen.has(mir)) continue; seen.add(r.rule); uniq.push(r);
}
console.log(' rule     ハイウェイ開始  周期   1周期の並進   速度(マス/ステップ)');
for(const r of uniq.slice(0,18))
  console.log(`  ${r.rule.padEnd(7)} ${String(r.start).padStart(9)}  ${String(r.period).padStart(5)}   (${r.step[0]},${r.step[1]})`.padEnd(58)+r.speed.toFixed(4));
console.log(` 判定した中でハイウェイを持つルール: ${uniq.length}種(鏡像を除く)`);
