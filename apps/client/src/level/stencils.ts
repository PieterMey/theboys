// Owner: track ② Level. Spray-stencilled callsigns on the walls next to doors (CanvasTexture decals, polygon offset,
// alpha-tested): outside each named room's door ("where am I going") and inside it ("where am I").
import * as THREE from 'three/webgpu';
import type { LayoutDoor, LevelLayout } from '@dead-air/shared/layout.ts';
import { HALF_T } from '@dead-air/shared/procgen/place.ts';
import { makeRng } from '@dead-air/shared/rng.ts';
import { DOOR_H, FACADE_H } from './mesher.ts';

const texCache = new Map<string, { tex: THREE.CanvasTexture; aspect: number }>();
const matCache = new Map<string, THREE.Material>();

/** Stencil-style text texture (cached). Returns the texture and its width/height aspect. */
export function stencilTexture(text: string, color = '#e9e6dc', opts: { distress?: number; font?: string } = {}): { tex: THREE.CanvasTexture; aspect: number } {
  const key = `${text}|${color}|${opts.distress ?? 1}|${opts.font ?? ''}`;
  const hit = texCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 256;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, c.width, c.height);
  const font = opts.font ?? "'Arial Black', 'Segoe UI Black', Impact, 'Helvetica Neue', sans-serif";
  let size = 190;
  g.font = `900 ${size}px ${font}`;
  const spaced = text.split('').join(' ');
  let w = g.measureText(spaced).width;
  if (w > 960) { size = Math.floor(size * (960 / w)); g.font = `900 ${size}px ${font}`; w = g.measureText(spaced).width; }
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  // soft overspray halo, then the crisp letters
  g.fillStyle = color;
  g.globalAlpha = 0.18;
  g.filter = 'blur(6px)';
  g.fillText(spaced, 512, 132);
  g.filter = 'none';
  g.globalAlpha = 1;
  g.fillText(spaced, 512, 132);
  // stencil bridges: thin horizontal gaps at fixed heights through every letter
  g.globalCompositeOperation = 'destination-out';
  g.fillRect(0, 132 - size * 0.04, 1024, Math.max(2, size * 0.035));
  // distress: specks + drips
  const r = makeRng(text, 'decor:stencil');
  const n = Math.round(1400 * (opts.distress ?? 1));
  for (let k = 0; k < n; k++) {
    g.globalAlpha = 0.25 + r.next() * 0.75;
    const s = 1 + r.next() * 5;
    g.fillRect(r.next() * 1024, r.next() * 256, s, s * (0.5 + r.next()));
  }
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.fillStyle = color;
  const left = 512 - w / 2, right = 512 + w / 2;
  for (let k = 0; k < 7; k++) {
    const x = left + r.next() * (right - left);
    const len = 12 + r.next() * 50;
    g.globalAlpha = 0.5 + r.next() * 0.4;
    g.fillRect(x, 132 + size * 0.38, 2 + r.next() * 2, len);
  }
  g.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const out = { tex, aspect: Math.max(2, Math.min(4, (w + 60) / (size * 1.1))) };
  texCache.set(key, out);
  return out;
}

export function stencilMaterial(text: string, color: string): THREE.Material {
  const k = `${text}|${color}`;
  let m = matCache.get(k);
  if (!m) {
    const { tex } = stencilTexture(text, color);
    const mm = new THREE.MeshStandardNodeMaterial({ map: tex, roughness: 0.75, metalness: 0, alphaTest: 0.35 });
    mm.polygonOffset = true;
    mm.polygonOffsetFactor = -2;
    mm.polygonOffsetUnits = -4;
    mm.name = `level.stencil.${text}`;
    m = mm;
    matCache.set(k, m);
  }
  return m;
}

export interface Stencil { space: number; mesh: THREE.Mesh }

/**
 * Decals for every door that leads into a named space. Each decal is attached to the space whose wall it is
 * painted on (so culling hides it with that space).
 */
export function buildStencils(L: LevelLayout): Stencil[] {
  const { W, H, owner, spaces } = L;
  const own = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : owner[y * W + x]);
  const isDoorEdge = new Set<string>();
  for (const d of L.doors) for (let i = 0; i < d.len; i++) isDoorEdge.add(d.dir === 'v' ? `v${d.x},${d.y + i}` : `h${d.x + i},${d.y}`);
  const out: Stencil[] = [];
  const named = (s: number) => s >= 0 && !!spaces[s].callsign && spaces[s].type !== 'van';
  // a wall cell-edge along the door's line at offset k (cells beyond the door), separating `onSide` from `other`
  const edgeOk = (d: LayoutDoor, k: number, faceSpace: number, backSpace: number, plusFace: boolean) => {
    if (d.dir === 'h') {
      const x = k, y = d.y;
      if (x < 0 || x >= W || isDoorEdge.has(`h${x},${y}`)) return false;
      const plus = own(x, y), minus = own(x, y - 1);
      return plusFace ? plus === faceSpace && minus === backSpace : minus === faceSpace && plus === backSpace;
    }
    const x = d.x, y = k;
    if (y < 0 || y >= H || isDoorEdge.has(`v${x},${y}`)) return false;
    const plus = own(x, y), minus = own(x - 1, y);
    return plusFace ? plus === faceSpace && minus === backSpace : minus === faceSpace && plus === backSpace;
  };
  const place = (d: LayoutDoor, label: string, color: string, faceSpace: number, backSpace: number) => {
    // which side of the line is faceSpace on?
    const plusOwner = d.dir === 'h' ? own(d.x, d.y) : own(d.x, d.y);
    const plusFace = plusOwner === faceSpace;
    const sideH = spaces[faceSpace].open ? FACADE_H : L.wallH;
    const { aspect } = stencilTexture(label, color);
    const w = Math.max(0.85, Math.min(1.7, 0.2 * label.length + 0.3));
    const h = w / aspect;
    const need = Math.ceil(w + 0.45);
    const start = d.dir === 'h' ? d.x : d.y;
    const end = start + d.len;
    let along = Number.NaN, y = 1.85;
    let wOut = w, hOut = h;
    // right of the door, then left of the door
    let ok = true;
    for (let k = 0; k < need && ok; k++) ok = edgeOk(d, end + k, faceSpace, backSpace, plusFace);
    if (ok) along = end + 0.25 + w / 2;
    else {
      ok = true;
      for (let k = 1; k <= need && ok; k++) ok = edgeOk(d, start - k, faceSpace, backSpace, plusFace);
      if (ok) along = start - 0.25 - w / 2;
    }
    if (Number.isNaN(along)) {
      // over the door on the lintel
      const lw = d.len - 2 * HALF_T - 0.08;
      wOut = Math.min(w, lw);
      hOut = wOut / aspect;
      if (hOut > (sideH - DOOR_H) * 0.7) { hOut = (sideH - DOOR_H) * 0.7; wOut = hOut * aspect; }
      along = (start + end) / 2;
      y = DOOR_H + Math.min(0.45, (Math.min(sideH, L.wallH) - DOOR_H) / 2);
    }
    const off = HALF_T + 0.004;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(wOut, hOut), stencilMaterial(label, color));
    m.name = `stencil:${label}`;
    if (d.dir === 'h') {
      const z = plusFace ? d.y + off : d.y - off;
      m.position.set(along, y, z);
      m.rotation.y = plusFace ? 0 : Math.PI;
    } else {
      const x = plusFace ? d.x + off : d.x - off;
      m.position.set(x, y, along);
      m.rotation.y = plusFace ? Math.PI / 2 : -Math.PI / 2;
    }
    out.push({ space: faceSpace, mesh: m });
  };
  for (const d of L.doors) {
    if (d.kind === 'open' || d.kind === 'blocked' || d.a < 0 || d.b < 0) continue;
    for (const [S, O] of [[d.a, d.b], [d.b, d.a]] as const) {
      if (!named(S)) continue;
      const cs = spaces[S].callsign!;
      const color = cs === 'VAULT' ? '#f2c230' : cs === 'LOBBY' ? '#f2c230' : '#e9e6dc';
      if (spaces[O].type !== 'van') place(d, cs, color, O, S);
      if (spaces[S].kind !== 'vault') place(d, cs, '#d8d4c8', S, O);
    }
  }
  return out;
}
