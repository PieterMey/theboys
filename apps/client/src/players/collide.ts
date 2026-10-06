// Owner: track ⑤ Players. Circle-vs-edge-grid collision (thin walls on cell edges + static solid boxes).
// Fallback for packages/shared/src/collide (② Level) so movement works before/without it; same semantics:
// walls/blocked/fence edges always block, door edges block unless doorOpen(id).
import type { DoorOpenFn, EdgeGrid } from '@dead-air/shared/nav/index.ts';
import { EDGE } from '@dead-air/shared/nav/index.ts';

const MAX_STEP = 0.1;

function blocks(code: number, door: number, doorOpen: DoorOpenFn): boolean {
  if (code === EDGE.free) return false;
  if (code === EDGE.door) return !doorOpen(door);
  return true;
}

/** push (x,z) out of segment (ax,az)-(bx,bz) to distance r; returns [x,z,hit] */
function pushSeg(x: number, z: number, r: number, ax: number, az: number, bx: number, bz: number, out: number[]): boolean {
  const ex = bx - ax, ez = bz - az;
  const len2 = ex * ex + ez * ez;
  let t = len2 > 0 ? ((x - ax) * ex + (z - az) * ez) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + ex * t, cz = az + ez * t;
  const dx = x - cx, dz = z - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 >= r * r) return false;
  const d = Math.sqrt(d2);
  if (d < 1e-6) {
    // exactly on the line: push along the segment normal toward the previous side (caller passes it via out)
    out[0] = x + out[2] * r;
    out[1] = z + out[3] * r;
    return true;
  }
  const k = (r - d) / d;
  out[0] = x + dx * k;
  out[1] = z + dz * k;
  return true;
}

function resolve(g: EdgeGrid, x: number, z: number, r: number, doorOpen: DoorOpenFn, px: number, pz: number): [number, number] {
  const out = [x, z, 0, 0];
  for (let iter = 0; iter < 4; iter++) {
    let moved = false;
    const x0 = Math.floor(x - r - 1), x1 = Math.floor(x + r + 1);
    const z0 = Math.floor(z - r - 1), z1 = Math.floor(z + r + 1);
    // vertical edges: line X = lx between cells (lx-1, y) | (lx, y), spanning z in [y, y+1]
    for (let y = Math.max(0, z0); y <= Math.min(g.H - 1, z1); y++) {
      for (let lx = Math.max(0, x0); lx <= Math.min(g.W, x1 + 1); lx++) {
        const i = y * (g.W + 1) + lx;
        if (!blocks(g.v[i], g.vDoor[i], doorOpen)) continue;
        out[2] = px < lx ? -1 : 1;
        out[3] = 0;
        if (pushSeg(x, z, r, lx, y, lx, y + 1, out)) { x = out[0]; z = out[1]; moved = true; }
      }
    }
    // horizontal edges: line Z = ly between cells (x, ly-1) | (x, ly), spanning x in [x, x+1]
    for (let ly = Math.max(0, z0); ly <= Math.min(g.H, z1 + 1); ly++) {
      for (let cx = Math.max(0, x0); cx <= Math.min(g.W - 1, x1); cx++) {
        const i = ly * g.W + cx;
        if (!blocks(g.h[i], g.hDoor[i], doorOpen)) continue;
        out[2] = 0;
        out[3] = pz < ly ? -1 : 1;
        if (pushSeg(x, z, r, cx, ly, cx + 1, ly, out)) { x = out[0]; z = out[1]; moved = true; }
      }
    }
    // static solid boxes
    const s = g.solids;
    if (s && s.length) {
      for (let b = 0; b < s.length; b += 4) {
        const bx0 = s[b], bz0 = s[b + 1], bx1 = s[b + 2], bz1 = s[b + 3];
        if (x + r < bx0 || x - r > bx1 || z + r < bz0 || z - r > bz1) continue;
        const cx = x < bx0 ? bx0 : x > bx1 ? bx1 : x;
        const cz = z < bz0 ? bz0 : z > bz1 ? bz1 : z;
        let dx = x - cx, dz = z - cz;
        let d2 = dx * dx + dz * dz;
        if (d2 >= r * r) continue;
        if (d2 < 1e-9) {
          // centre inside the box: exit through the nearest face
          const l = x - bx0, rr = bx1 - x, t = z - bz0, bt = bz1 - z;
          const m = Math.min(l, rr, t, bt);
          if (m === l) { dx = -1; dz = 0; x = bx0 - r; }
          else if (m === rr) { dx = 1; dz = 0; x = bx1 + r; }
          else if (m === t) { dx = 0; dz = -1; z = bz0 - r; }
          else { dx = 0; dz = 1; z = bz1 + r; }
          moved = true;
          continue;
        }
        const d = Math.sqrt(d2);
        d2 = (r - d) / d;
        x += dx * d2;
        z += dz * d2;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return [x, z];
}

/**
 * Move a circle of radius r from (x,z) by (dx,dz) against the edge grid. Sub-steps keep every step below the
 * radius so thin walls can't be tunnelled. Returns the new position.
 */
export function moveCircleGrid(g: EdgeGrid, x: number, z: number, dx: number, dz: number, r: number, doorOpen: DoorOpenFn): [number, number] {
  const dist = Math.hypot(dx, dz);
  const n = Math.max(1, Math.ceil(dist / MAX_STEP));
  const sx = dx / n, sz = dz / n;
  for (let i = 0; i < n; i++) {
    const px = x, pz = z;
    [x, z] = resolve(g, x + sx, z + sz, r, doorOpen, px, pz);
  }
  return [x, z];
}

/**
 * March a ray over the edge grid (2D walls + floor/ceiling planes). Returns the hit point (nudged `back` metres
 * toward the origin) or the end point.
 */
export function rayGrid(
  g: EdgeGrid | null, o: [number, number, number], d: [number, number, number], maxDist: number, wallH: number,
  doorOpen: DoorOpenFn, back = 0.08,
): { p: [number, number, number]; hit: 'wall' | 'floor' | 'ceiling' | 'none'; dist: number } {
  const step = 0.04;
  let px = o[0], py = o[1], pz = o[2];
  let cx = Math.floor(px), cz = Math.floor(pz);
  for (let t = step; t <= maxDist; t += step) {
    const x = o[0] + d[0] * t, y = o[1] + d[1] * t, z = o[2] + d[2] * t;
    const nb = (tt: number): [number, number, number] => {
      const k = Math.max(0, tt - back);
      return [o[0] + d[0] * k, o[1] + d[1] * k, o[2] + d[2] * k];
    };
    if (y <= 0) {
      const tt = d[1] < 0 ? (o[1] - 0.02) / -d[1] : t;
      const p = nb(tt);
      p[1] = 0.03;
      return { p, hit: 'floor', dist: tt };
    }
    if (y >= wallH) return { p: nb(t), hit: 'ceiling', dist: t };
    if (g) {
      const nx = Math.floor(x), nz = Math.floor(z);
      if (nx !== cx) {
        const lx = nx > cx ? nx : cx;
        const row = Math.floor(pz);
        if (row < 0 || row >= g.H || lx < 0 || lx > g.W) return { p: nb(t), hit: 'wall', dist: t };
        const i = row * (g.W + 1) + lx;
        if (blocks(g.v[i], g.vDoor[i], doorOpen)) return { p: nb(t), hit: 'wall', dist: t };
        cx = nx;
      }
      if (nz !== cz) {
        const ly = nz > cz ? nz : cz;
        const col = Math.floor(x);
        if (col < 0 || col >= g.W || ly < 0 || ly > g.H) return { p: nb(t), hit: 'wall', dist: t };
        const i = ly * g.W + col;
        if (blocks(g.h[i], g.hDoor[i], doorOpen)) return { p: nb(t), hit: 'wall', dist: t };
        cz = nz;
      }
    }
    px = x; py = y; pz = z;
  }
  void py;
  return { p: [px, Math.max(0.03, py), pz], hit: 'none', dist: maxDist };
}
