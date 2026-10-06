const L = await h.ev(P.Quiet.page, () => window.__ix && window.__ix.layout ? window.__ix.layout() : null);
if (!L) return 'no __ix.layout';
h.writeFileSync(h.join(h.DIR, 'layout.json'), JSON.stringify(L));
const spaces = L.spaces.map((s) => ({ id: s.id, kind: s.kind, type: s.type, cs: s.callsign, r: s.rect, dist: s.dist }));
const doors = L.doors.map((d) => ({ id: d.id, a: d.a, b: d.b, x: d.x, y: d.y, dir: d.dir, len: d.len, kind: d.kind, lock: d.lock, open0: d.initiallyOpen }));
return { W: L.W, H: L.H, van: L.van, entrance: L.entrance, nSpaces: spaces.length, spaces: spaces.slice(0, 60), doors: doors.slice(0, 40) };
