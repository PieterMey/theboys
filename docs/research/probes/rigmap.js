const fs=require('fs');
function load(p){const b=fs.readFileSync(p);const L=b.readUInt32LE(12);const j=JSON.parse(b.slice(20,20+L).toString());const by={};j.nodes.forEach((n,i)=>by[n.name]={...n,i});return {j,by};}
const A=load(process.argv[2]),B=load(process.argv[3]);
const m={'DEF-hips':'pelvis','DEF-spine.001':'spine_01','DEF-spine.002':'spine_02','DEF-spine.003':'spine_03','DEF-neck':'neck_01','DEF-head':'Head'};
for(const s of ['L','R']){const l=s.toLowerCase();Object.assign(m,{[`DEF-shoulder.${s}`]:`clavicle_${l}`,[`DEF-upper_arm.${s}`]:`upperarm_${l}`,[`DEF-forearm.${s}`]:`lowerarm_${l}`,[`DEF-hand.${s}`]:`hand_${l}`,[`DEF-thigh.${s}`]:`thigh_${l}`,[`DEF-shin.${s}`]:`calf_${l}`,[`DEF-foot.${s}`]:`foot_${l}`,[`DEF-toe.${s}`]:`ball_${l}`});for(const f of ['index','middle','pinky','ring'])for(const k of [1,2,3])m[`DEF-f_${f}.0${k}.${s}`]=`${f}_0${k}_${l}`;for(const k of [1,2,3])m[`DEF-thumb.0${k}.${s}`]=`thumb_0${k}_${l}`;}
const q=(n)=>n.rotation||[0,0,0,1];const ang=(a,b)=>{const d=Math.abs(a.reduce((s,v,i)=>s+v*b[i],0));return 2*Math.acos(Math.min(1,d))*180/Math.PI};
const len=(n)=>Math.hypot(...(n.translation||[0,0,0]));
const rows=[];for(const [a,b] of Object.entries(m)){const na=A.by[a],nb=B.by[b];if(!na||!nb){rows.push([a,b,'MISSING']);continue;}rows.push([a,b,+ang(q(na),q(nb)).toFixed(1),+len(na).toFixed(3),+len(nb).toFixed(3)]);}
console.log('mapped',Object.keys(m).length);rows.sort((x,y)=>(y[2]||0)-(x[2]||0));console.log(rows.slice(0,12).map(r=>r.join(' ')).join('\n'));
const big=rows.filter(r=>r[2]>5).length;console.log('bones with local rest rot diff >5deg:',big,'of',rows.length);
