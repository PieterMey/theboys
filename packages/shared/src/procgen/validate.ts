// Owned by track ② Level. Independent invariant checks over a finished LevelLayout (used by tests, gen-cli, server).
import type { LevelLayout } from '../layout.ts';
import { ALL_OPEN, buildEdgeGrid } from '../nav/grid.ts';
import type { DoorOpenFn } from '../nav/grid.ts';
import { floodCells } from '../nav/path.ts';
import { los } from '../nav/los.ts';
import { CALLSIGN_INFO, confusable, findCallsigns } from '../callsign.ts';
import { layoutHash } from './hash.ts';
import { normalOfYaw } from './common.ts';
import { reachAroundSolids } from './place.ts';
import { stationsOf } from './van.ts';
import { mirrorsOf } from './mirrors.ts';
import { loreSpotsOf } from './lore.ts';
import { containersOf } from './containers.ts';

export interface ValidateOptions {
  leverMinPathM?: number;
  hidingCoverageM?: number;
  minLoops?: number;
}

export interface ValidationReport {
  errors: string[];
  leverPathM: number;
  loops: number;
}

export function validateLayout(L: LevelLayout, o: ValidateOptions = {}): ValidationReport {
  const errors: string[] = [];
  const err = (m: string) => { if (errors.length < 50) errors.push(m); };
  const { W, H, owner, spaces, doors, items } = L;
  if (owner.length !== W * H) err(`owner length ${owner.length} != ${W * H}`);
  if (layoutHash(L) !== L.hash) err('hash mismatch');
  // spaces own only cells inside their rect
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const s = owner[y * W + x];
    if (s < -1 || s >= spaces.length) { err(`bad owner ${s} at ${x},${y}`); continue; }
    if (s < 0) continue;
    const r = spaces[s].rect;
    if (x < r.x || y < r.y || x >= r.x + r.w || y >= r.y + r.h) err(`cell ${x},${y} of space ${s} outside its rect`);
  }
  spaces.forEach((s, i) => {
    if (s.id !== i) err(`space id ${s.id} at index ${i}`);
    if (!Number.isFinite(s.dist)) err(`space ${s.id} dist not finite`);
  });
  const own = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : owner[y * W + x]);
  doors.forEach((d, i) => {
    if (d.id !== i) err(`door id ${d.id} at index ${i}`);
    for (let k = 0; k < d.len; k++) {
      const p = d.dir === 'v' ? [own(d.x - 1, d.y + k), own(d.x, d.y + k)] : [own(d.x + k, d.y - 1), own(d.x + k, d.y)];
      if (!((p[0] === d.a && p[1] === d.b) || (p[0] === d.b && p[1] === d.a))) err(`door ${d.id} edge ${k} not between ${d.a}/${d.b} (${p})`);
    }
  });
  for (const it of items) {
    const s = own(Math.floor(it.x), Math.floor(it.z));
    if (s !== it.space) err(`item ${it.id} at ${it.x},${it.z} in space ${s}, expected ${it.space}`);
    if (!Number.isFinite(it.x) || !Number.isFinite(it.z)) err(`item ${it.id} non-finite pos`);
  }
  const ids = new Set<string>();
  for (const it of items) { if (ids.has(it.id)) err(`duplicate item id ${it.id}`); ids.add(it.id); }
  const byKind = (k: string) => items.filter((i) => i.kind === k);

  // van
  const cab = L.van.cab;
  const vanSpace = owner[Math.floor(cab.y) * W + Math.floor(cab.x)];
  if (vanSpace < 0 || spaces[vanSpace].type !== 'van') err('van cab not on a van space');
  for (const k of ['console', 'leave_lever']) {
    const it = byKind(k)[0];
    if (!it) err(`missing ${k}`);
    else if (it.x < cab.x || it.z < cab.y || it.x > cab.x + cab.w || it.z > cab.y + cab.h) err(`${k} outside the van cab`);
  }
  const spawns = byKind('spawn_player');
  if (spawns.length !== 6) err(`spawn_player x${spawns.length}`);
  for (const sp of spawns) if (!spaces[sp.space]?.open) err(`spawn ${sp.id} not outdoors`);

  // grid + reachability
  const g = buildEdgeGrid(L);
  const cellOfItem = (it: { x: number; z: number }) => Math.floor(it.z) * W + Math.floor(it.x);
  const start = byKind('spawn_player')[0];
  let leverPathM = 0, loops = 0;
  if (L.kind === 'facility') {
    const vaults = spaces.filter((s) => s.kind === 'vault');
    if (vaults.length !== 1) err(`vaults x${vaults.length}`);
    const vault = vaults[0];
    if (vault) {
      if (vault.callsign !== 'VAULT') err('vault callsign');
      const vd = doors.filter((d) => d.a === vault.id || d.b === vault.id);
      if (vd.length !== 1 || vd[0].kind !== 'vault') err(`vault doors ${vd.map((d) => d.kind)}`);
      const core = byKind('core');
      if (core.length !== 1 || core[0].space !== vault.id) err('core not in vault');
      const kp = byKind('keypad');
      if (kp.length !== 1) err(`keypads x${kp.length}`);
      else if (vd[0]) {
        const outside = vd[0].a === vault.id ? vd[0].b : vd[0].a;
        if (kp[0].space !== outside) err('keypad not outside the vault door');
        const dx = vd[0].dir === 'h' ? vd[0].x + vd[0].len / 2 : vd[0].x, dz = vd[0].dir === 'h' ? vd[0].y : vd[0].y + vd[0].len / 2;
        if (Math.abs(kp[0].x - dx) + Math.abs(kp[0].z - dz) > 2.5) err('keypad too far from the vault door');
      }
      // twin levers
      const lv = byKind('lever');
      if (lv.length !== 2) err(`levers x${lv.length}`);
      else {
        for (const l of lv) if (spaces[l.space].powerZone !== vault.powerZone) err(`lever ${l.id} not in the vault power zone`);
        const f = floodCells(g, [cellOfItem(lv[0])], { mode: 'walk', doorOpen: ALL_OPEN });
        leverPathM = f[cellOfItem(lv[1])];
        if (!(leverPathM >= (o.leverMinPathM ?? 18))) err(`levers only ${leverPathM} m apart`);
        if (los(g, lv[0].x, lv[0].z, lv[1].x, lv[1].z, ALL_OPEN)) err('levers see each other');
      }
    }
    // solvability: collect keycards, expand reachability (locked doors closed until their key is held)
    if (start) {
      const keys = new Set<number>();
      const lockOf = doors.map((d) => (d.kind === 'locked' ? d.lock : 0));
      let field: Float32Array = new Float32Array(0);
      for (let guard = 0; guard < 8; guard++) {
        const open: DoorOpenFn = (id) => lockOf[id] === 0 || keys.has(lockOf[id]);
        field = floodCells(g, [cellOfItem(start)], { mode: 'walk', doorOpen: open });
        let gained = false;
        for (const kc of byKind('keycard')) {
          const lk = Number(kc.data?.lock ?? 0);
          if (!keys.has(lk) && Number.isFinite(field[cellOfItem(kc)])) { keys.add(lk); gained = true; }
        }
        if (!gained) break;
      }
      for (const s of spaces) {
        let ok = false;
        for (let y = s.rect.y; y < s.rect.y + s.rect.h && !ok; y++) for (let x = s.rect.x; x < s.rect.x + s.rect.w; x++) {
          if (owner[y * W + x] === s.id && Number.isFinite(field[y * W + x])) { ok = true; break; }
        }
        if (!ok) err(`space ${s.id} (${s.kind}) unreachable`);
      }
      for (const kc of byKind('keycard')) {
        const lk = Number(kc.data?.lock ?? 0);
        const lockDoor = doors.find((d) => d.kind === 'locked' && d.lock === lk);
        if (lockDoor && spaces[kc.space].zone >= Math.max(spaces[lockDoor.a].zone, spaces[lockDoor.b].zone)) err('keycard behind its own lock');
      }
    }
    // solids (lockers, furniture, console) must not cut off rooms, doors or anything a player has to reach:
    // BFS over cells whose centre is clear of every solid box, all doors open
    {
      const seen = reachAroundSolids(g, start ? cellOfItem(start) : -1);
      const reachKinds = ['lever', 'keypad', 'switch', 'note', 'intercom', 'keycard', 'core', 'loot', 'console', 'leave_lever', 'deposit', 'vent', 'hiding'];
      for (const it of items) {
        if (!reachKinds.includes(it.kind)) continue;
        const c = cellOfItem(it);
        const cx = c % W, cy = (c - cx) / W;
        // the item's own cell, or (for solids / wall items) a walkable neighbour cell in the same space
        const ok = seen[c] || [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
          const nx = cx + dx, ny = cy + dy;
          return nx >= 0 && ny >= 0 && nx < W && ny < H && seen[ny * W + nx] && owner[ny * W + nx] === it.space;
        });
        if (!ok) err(`${it.id} unreachable around solids`);
      }
      for (const d of doors) {
        if (d.kind === 'blocked' || d.a < 0 || d.b < 0) continue;
        const c1 = d.dir === 'v' ? d.y * W + d.x - 1 : (d.y - 1) * W + d.x;
        const c2 = d.dir === 'v' ? d.y * W + d.x : d.y * W + d.x;
        const anyOk = (base: number) => { for (let k = 0; k < d.len; k++) { const cc = base + (d.dir === 'v' ? k * W : k); if (seen[cc]) return true; } return false; };
        if (!anyOk(c1) || !anyOk(c2)) err(`door ${d.id} (${d.kind}) blocked by solids`);
      }
    }
    const locked = doors.filter((d) => d.kind === 'locked');
    if (locked.length > 1) err(`locks x${locked.length}`);
    // loops (cyclomatic number of the indoor space graph)
    const fac = new Set(spaces.filter((s) => !s.open && s.type !== 'van').map((s) => s.id));
    const pairs = new Set<number>();
    for (const d of doors) if (d.kind !== 'blocked' && fac.has(d.a) && fac.has(d.b)) pairs.add(Math.min(d.a, d.b) * 4096 + Math.max(d.a, d.b));
    loops = pairs.size - fac.size + 1;
    if (loops < (o.minLoops ?? 2)) err(`loops ${loops}`);
    // hiding coverage
    const hide = byKind('hiding').map(cellOfItem);
    if (!hide.length) err('no hiding spots');
    else {
      const hf = floodCells(g, hide, { mode: 'walk', doorOpen: ALL_OPEN });
      const cov = o.hidingCoverageM ?? 16;
      let worst = 0;
      for (let c = 0; c < W * H; c++) {
        const s = owner[c];
        if (s < 0 || !fac.has(s) || spaces[s].kind === 'vault') continue;
        worst = Math.max(worst, hf[c]);
      }
      if (worst > cov) err(`hiding coverage ${worst.toFixed(1)} m > ${cov}`);
    }
    // callsigns: rooms/halls/vault named, corridors/outside unnamed, unique, mutually non-confusable
    const names: string[] = [];
    for (const s of spaces) {
      const named = s.kind === 'room' || s.kind === 'hall' || s.kind === 'vault';
      if (named && !s.callsign) err(`space ${s.id} (${s.kind}) has no callsign`);
      if (!named && s.callsign) err(`space ${s.id} (${s.kind}) has callsign ${s.callsign}`);
      if (s.callsign) { if (names.includes(s.callsign)) err(`duplicate callsign ${s.callsign}`); names.push(s.callsign); }
    }
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
      if (confusable(names[i], names[j])) err(`confusable callsigns ${names[i]}/${names[j]}`);
    }
    for (const n of names) {
      const primary = CALLSIGN_INFO[n]?.forms[0] ?? n.toLowerCase();
      const hit = findCallsigns(`go to the ${primary} now`, names);
      if (hit.length !== 1 || hit[0] !== n) err(`callsign ${n} confusable: ${hit}`);
    }
    if (!byKind('exit').length && !doors.some((d) => d.kind === 'exit')) err('no exit door');
    const sec = doors.filter((d) => d.kind === 'security').length;
    if (sec < 2 || sec > 4) err(`security doors x${sec}`);
    for (const k of ['spawn_hound', 'spawn_listener', 'spawn_mannequin', 'note', 'vent', 'intercom', 'loot', 'light', 'switch']) if (!byKind(k).length) err(`no ${k}`);
    for (const v of byKind('vent')) { const to = items.find((i) => i.id === v.data?.to); if (!to || to.data?.to !== v.id) err(`vent ${v.id} unpaired`); }
  } else {
    for (const k of ['kennel', 'mirror', 'board', 'shop']) if (byKind(k).length !== 1) err(`hub ${k} x${byKind(k).length}`);
    const hound = byKind('spawn_hound')[0];
    if (!hound || hound.data?.chained !== true) err('hub hound not chained');
  }
  // v1.2 (both kinds): stations, lore holders, mirrors and container fronts must be reachable around solids
  {
    const seen = reachAroundSolids(g, start ? cellOfItem(start) : -1);
    const near = (x: number, z: number, space: number) => {
      const cx = Math.floor(x), cz = Math.floor(z);
      if (cx < 0 || cz < 0 || cx >= W || cz >= H) return false;
      if (seen[cz * W + cx]) return true;
      return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
        const nx = cx + dx, ny = cz + dy;
        return nx >= 0 && ny >= 0 && nx < W && ny < H && seen[ny * W + nx] && owner[ny * W + nx] === space;
      });
    };
    for (const st of stationsOf(L)) {
      if (st.virtual) continue;
      if (!near(st.p[0], st.p[2], st.space)) err(`station ${st.kind} (${st.itemId}) unreachable around solids`);
    }
    for (const m of mirrorsOf(L)) {
      const [nx, nz] = normalOfYaw(m.rot);
      const fx = m.x + nx * 0.45, fz = m.z + nz * 0.45;
      const c = Math.floor(fz) * W + Math.floor(fx);
      if (m.kind !== 'van' && (owner[c] !== m.space || !seen[c])) err(`mirror ${m.id} front cell blocked`);
      else if (!near(fx, fz, m.space)) err(`mirror ${m.id} unreachable`);
    }
    if (L.kind === 'facility') {
      for (const sp of loreSpotsOf(L)) if (!near(sp.p[0], sp.p[2], sp.space)) err(`lore spot ${sp.id} unreachable around solids`);
      for (const ct of containersOf(L)) {
        const [fx, fz] = ct.front;
        if (fx < 0 || fz < 0 || fx >= W || fz >= H || !seen[fz * W + fx] || owner[fz * W + fx] !== ct.space) err(`container ${ct.id} front cell ${fx},${fz} not walkable`);
      }
    }
  }
  return { errors, leverPathM, loops };
}
