const names = ['Talker', 'Tone', 'Shouter', 'Quiet'];
const res = await Promise.all(names.map((n) => h.bandHist(P[n].page, 8000)));
const out = Object.fromEntries(names.map((n, i) => [n + ' (' + P[n].wav + ')', res[i]]));
const shots = [];
for (const n of names) shots.push(await h.shot(P[n].page, '06-hud-' + n));
return { out, shots };
