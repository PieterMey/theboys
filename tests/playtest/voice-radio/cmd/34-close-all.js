const names = Object.keys(P);
for (const n of names) await h.close(n);
return { closed: names };
