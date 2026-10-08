// Owner: env-world (v1.2). EXIT signs: a black housing with glowing green EXIT letters over the doors on the way out.
// One over the inside of the exit door, then, walking the space graph outward from the lobby, one on the far side of
// every door that leads back toward it from a corridor or a junction room (<= 3 links away, <= 10 per site). Pure
// geometry in the shared 'black' + 'exitGlow' materials, merged per space by the level (no lights, no shadows).
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { LayoutDoor, LevelLayout } from '@dead-air/shared/layout.ts';
import type { SpaceLink } from '@dead-air/shared/nav/index.ts';
import { HALF_T } from '@dead-air/shared/procgen/place.ts';
import type { Part } from './setpieces.ts';
import { DOOR_H } from './mesher.ts';

export interface ExitSign { space: number; door: number; m: THREE.Matrix4; parts: Part[] }

const SIGN = { w: 0.4, h: 0.16, d: 0.06 } as const;
const MAX_SIGNS = 10;
const MAX_DEPTH = 3;

const B = (w: number, h: number, d: number, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);

/** the EXIT lettering (local frame: centre of the sign face, +Z out), strokes 12 mm, cap height 70 mm */
function letters(z: number): THREE.BufferGeometry {
  const s = 0.012, H = 0.07, dz = 0.004;
  const gs: THREE.BufferGeometry[] = [];
  let x = -0.106;
  // E
  gs.push(B(s, H, dz, x + s / 2, 0, z), B(0.05, s, dz, x + 0.025, H / 2 - s / 2, z), B(0.04, s, dz, x + 0.02, 0, z), B(0.05, s, dz, x + 0.025, -H / 2 + s / 2, z));
  x += 0.05 + 0.015;
  // X
  const xw = 0.055, diag = Math.hypot(xw - s, H), ang = Math.atan2(H, xw - s);
  gs.push(B(diag, s, dz).rotateZ(ang).translate(x + xw / 2, 0, z), B(diag, s, dz).rotateZ(-ang).translate(x + xw / 2, 0, z));
  x += xw + 0.015;
  // I
  gs.push(B(s, H, dz, x + s / 2, 0, z));
  x += s + 0.015;
  // T
  gs.push(B(0.05, s, dz, x + 0.025, H / 2 - s / 2, z), B(s, H - s, dz, x + 0.025, -s / 2, z));
  const g = mergeGeometries(gs.map((q) => q.toNonIndexed()));
  for (const q of gs) q.dispose();
  return g;
}

/** sign parts in its local frame (origin = sign centre, back on the wall face at z = -d/2, +Z into the room) */
export function exitSignParts(): Part[] {
  return [
    { mat: 'black', geo: B(SIGN.w, SIGN.h, SIGN.d) },
    { mat: 'black', geo: B(0.05, 0.03, 0.03, -0.12, SIGN.h / 2 + 0.015, -0.01) },
    { mat: 'black', geo: B(0.05, 0.03, 0.03, 0.12, SIGN.h / 2 + 0.015, -0.01) },
    { mat: 'exitGlow', geo: letters(SIGN.d / 2 + 0.002) },
  ];
}

/** sideways step when env-layout's emergency light already hangs over the middle of the door (EMERGENCY_Y 2.4) */
const BESIDE_LIGHT = 0.44;

/**
 * World transform of a sign over door d on the side of space s (null if s is on neither side). `shift` slides it
 * along the wall (+ = the door's +x / +z): the part past the door's span must sit on a plain wall of the same line.
 */
function signMatrix(L: LevelLayout, d: LayoutDoor, s: number, shift = 0): THREE.Matrix4 | null {
  const y = DOOR_H + 0.08 + SIGN.h / 2 + 0.06;
  if (y + SIGN.h / 2 + 0.03 > L.wallH) return null;
  const mid = d.len / 2;
  const off = HALF_T + SIGN.d / 2 + 0.001;
  const own = (x: number, z: number) => (x < 0 || z < 0 || x >= L.W || z >= L.H ? -1 : L.owner[z * L.W + x]);
  const v = d.dir === 'v';
  // a cell index along the door line whose edge is a plain wall (owners differ on both sides, no door there)
  const wallAt = (c: number) => {
    if (c >= (v ? d.y : d.x) && c < (v ? d.y : d.x) + d.len) return true; // the door's own lintel
    const a = v ? own(d.x - 1, c) : own(c, d.y - 1), b = v ? own(d.x, c) : own(c, d.y);
    if (a === b || (a !== s && b !== s)) return false;
    return !L.doors.some((o) => o.dir === d.dir && (v ? o.x === d.x && c >= o.y && c < o.y + o.len : o.y === d.y && c >= o.x && c < o.x + o.len));
  };
  const at = (v ? d.y : d.x) + mid + shift;
  if (!wallAt(Math.floor(at - SIGN.w / 2 + 0.01)) || !wallAt(Math.floor(at + SIGN.w / 2 - 0.01))) return null;
  if (v) {
    const cz = d.y + Math.floor(mid);
    const plus = own(d.x, cz) === s, minus = own(d.x - 1, cz) === s;
    if (!plus && !minus) return null;
    return new THREE.Matrix4().makeRotationY(plus ? Math.PI / 2 : -Math.PI / 2).setPosition(d.x + (plus ? off : -off), y, at);
  }
  const cx = d.x + Math.floor(mid);
  const plus = own(cx, d.y) === s, minus = own(cx, d.y - 1) === s;
  if (!plus && !minus) return null;
  return new THREE.Matrix4().makeRotationY(plus ? 0 : Math.PI).setPosition(at, y, d.y + (plus ? off : -off));
}

/** EXIT signs of a facility (none in the hub or without an exit door) */
export function exitSigns(L: LevelLayout, links: readonly (readonly SpaceLink[])[]): ExitSign[] {
  if (L.kind !== 'facility') return [];
  const exitDoor = L.doors.find((d) => d.kind === 'exit');
  if (!exitDoor) return [];
  const lobby = [exitDoor.a, exitDoor.b].find((s) => s >= 0 && !L.spaces[s]?.open);
  if (lobby === undefined) return [];
  const out: ExitSign[] = [];
  // env-layout's battery emergency lights sit over the middle of some doors (data.door): hang the sign beside them
  const lit = new Set(L.items.filter((i) => i.kind === 'light' && i.data?.kind === 'emergency' && typeof i.data?.door === 'number').map((i) => `${i.data!.door}|${i.space}`));
  const add = (space: number, door: LayoutDoor) => {
    if (out.length >= MAX_SIGNS) return;
    const shifts = lit.has(`${door.id}|${space}`) ? [BESIDE_LIGHT, -BESIDE_LIGHT] : [0];
    for (const sh of shifts) {
      const m = signMatrix(L, door, space, sh);
      if (m) { out.push({ space, door: door.id, m, parts: exitSignParts() }); return; }
    }
  };
  add(lobby, exitDoor);
  // breadth-first away from the lobby: the sign hangs on the far side of the door that leads back
  const depth = new Map<number, number>([[lobby, 0]]);
  let frontier = [lobby];
  for (let k = 1; k <= MAX_DEPTH && frontier.length; k++) {
    const next: number[] = [];
    for (const s of frontier) for (const l of links[s] ?? []) {
      if (l.kind === 'fence' || depth.has(l.other) || l.other < 0) continue;
      const sp = L.spaces[l.other];
      if (!sp || sp.open || sp.kind === 'vault') continue;
      depth.set(l.other, k);
      next.push(l.other);
      const door = l.door >= 0 ? L.doors[l.door] : null;
      const junction = (links[l.other] ?? []).filter((q) => q.kind !== 'fence').length >= 3;
      if (door && door.kind !== 'open' && (sp.kind === 'corridor' || junction)) add(l.other, door);
    }
    frontier = next;
  }
  return out;
}
