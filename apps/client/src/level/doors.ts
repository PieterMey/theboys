// Owner: track ② Level. Procedural door visuals per DoorKind + open/close animation.
// Local frame per door: origin on the wall line at one end of the opening, +X along the opening (0..len),
// +Z toward the side the door swings into, wall body z in [-T/2, T/2], clear opening x in [T/2, len - T/2].
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { DoorKind, LayoutDoor, LevelLayout } from '@dead-air/shared/layout.ts';
import { HALF_T } from '@dead-air/shared/procgen/place.ts';
import { makeRng } from '@dead-air/shared/rng.ts';
import { DOOR_H } from './mesher.ts';
import type { LevelMaterials } from './materials.ts';

/** keycard colours by lock index (1 = red, 2 = blue, 3 = green, 4 = yellow) */
export const KEY_COLORS = [0xffffff, 0xff2a2a, 0x2a7bff, 0x2aff6a, 0xffd02a] as const;

export interface DoorVisual {
  id: number;
  kind: DoorKind;
  group: THREE.Group;
  /** logical state (what collision uses) */
  open: boolean;
  /** animated 0 (closed) .. 1 (open) */
  t: number;
  /** animation speed (1/s) */
  speed: number;
  apply(t: number): void;
  spaces: [number, number];
  /** emissive status light of keycard / security doors (null otherwise) */
  status: THREE.Mesh | null;
}

const ease = (t: number) => t * t * (3 - 2 * t);

let shared: {
  hazard: THREE.MeshStandardNodeMaterial; glass: THREE.MeshStandardNodeMaterial; steel: THREE.MeshStandardNodeMaterial;
  fireRed: THREE.MeshStandardNodeMaterial; doorGrey: THREE.MeshStandardNodeMaterial; brass: THREE.MeshStandardNodeMaterial;
  wiredGlass: THREE.MeshStandardNodeMaterial;
} | null = null;

function hazardTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#1a1a18';
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#d9a514';
  for (let i = -256; i < 512; i += 64) {
    g.beginPath(); g.moveTo(i, 256); g.lineTo(i + 32, 256); g.lineTo(i + 32 + 256, 0); g.lineTo(i + 256, 0); g.closePath(); g.fill();
  }
  // wear
  const r = makeRng('hazard', 'decor');
  for (let k = 0; k < 900; k++) { g.fillStyle = `rgba(30,28,24,${0.15 + r.next() * 0.35})`; g.fillRect(r.next() * 256, r.next() * 256, 1 + r.next() * 4, 1 + r.next() * 3); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

function materials() {
  if (shared) return shared;
  const hazard = new THREE.MeshStandardNodeMaterial({ map: hazardTexture(), roughness: 0.55, metalness: 0.45 });
  hazard.name = 'level.door.hazard';
  const glass = new THREE.MeshStandardNodeMaterial({ color: 0x1b262b, roughness: 0.08, metalness: 0.5, transparent: true, opacity: 0.45 });
  glass.name = 'level.door.glass';
  const wiredGlass = new THREE.MeshStandardNodeMaterial({ color: 0x30413f, roughness: 0.15, metalness: 0.3, transparent: true, opacity: 0.6 });
  wiredGlass.name = 'level.door.wiredglass';
  const steel = new THREE.MeshStandardNodeMaterial({ color: 0x8b9298, roughness: 0.32, metalness: 0.9 });
  steel.name = 'level.door.steel';
  const fireRed = new THREE.MeshStandardNodeMaterial({ color: 0x6e2a22, roughness: 0.5, metalness: 0.45 });
  fireRed.name = 'level.door.fire';
  const doorGrey = new THREE.MeshStandardNodeMaterial({ color: 0x4a5056, roughness: 0.45, metalness: 0.7 });
  doorGrey.name = 'level.door.grey';
  const brass = new THREE.MeshStandardNodeMaterial({ color: 0x9a8a5a, roughness: 0.3, metalness: 0.9 });
  brass.name = 'level.door.brass';
  shared = { hazard, glass, steel, fireRed, doorGrey, brass, wiredGlass };
  return shared;
}

const box = (w: number, h: number, d: number, x: number, y: number, z: number) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);

/** which side the door swings into: +1 = cell on the +side of the line (row y / col x), -1 = the other */
function intoSide(L: LevelLayout, d: LayoutDoor): 1 | -1 {
  const W = L.W;
  const plus = d.dir === 'h' ? (d.y < L.H ? L.owner[d.y * W + d.x] : -1) : (d.x < W ? L.owner[d.y * W + d.x] : -1);
  const minus = d.dir === 'h' ? (d.y > 0 ? L.owner[(d.y - 1) * W + d.x] : -1) : (d.x > 0 ? L.owner[d.y * W + d.x - 1] : -1);
  const sp = (s: number) => (s >= 0 ? L.spaces[s] : null);
  const P = sp(plus), M = sp(minus);
  const isRoom = (s: typeof P) => !!s && (s.kind === 'room' || s.kind === 'hall');
  if (d.kind === 'exit') return P?.open ? 1 : -1; // front doors open outward
  if (d.kind === 'vault') return P?.kind === 'vault' ? -1 : 1; // vault door swings out of the vault
  if (isRoom(P) && !isRoom(M)) return 1;
  if (isRoom(M) && !isRoom(P)) return -1;
  return 1;
}

function placeGroup(L: LevelLayout, d: LayoutDoor, side: 1 | -1, g: THREE.Group): void {
  if (d.dir === 'h') {
    if (side === 1) { g.position.set(d.x, 0, d.y); g.rotation.y = 0; }
    else { g.position.set(d.x + d.len, 0, d.y); g.rotation.y = Math.PI; }
  } else if (side === 1) { g.position.set(d.x, 0, d.y + d.len); g.rotation.y = Math.PI / 2; }
  else { g.position.set(d.x, 0, d.y); g.rotation.y = -Math.PI / 2; }
  void L;
}

/** casing on both wall faces + head */
function frameGeometry(len: number, deep = 0.03, wide = 0.075, h = DOOR_H): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const h2 = HALF_T;
  for (const s of [1, -1]) {
    const z = s * (h2 - 0.005 + (deep + 0.005) / 2);
    const d = deep + 0.005;
    parts.push(box(wide, h + wide, d, h2 - wide / 2, (h + wide) / 2, z));
    parts.push(box(wide, h + wide, d, len - h2 + wide / 2, (h + wide) / 2, z));
    parts.push(box(len - 2 * h2 + 2 * wide, wide, d, len / 2, h + wide / 2, z));
  }
  return mergeGeometries(parts);
}

export function buildDoor(L: LevelLayout, d: LayoutDoor, mats: LevelMaterials): DoorVisual | null {
  if (d.kind === 'open') return null;
  const m = materials();
  const side = intoSide(L, d);
  const g = new THREE.Group();
  g.name = `door:${d.id}`;
  placeGroup(L, d, side, g);
  const len = d.len, h2 = HALF_T;
  const clear = len - 2 * h2;
  const spaces: [number, number] = [d.a, d.b];
  const leaves: { pivot: THREE.Object3D; dir: 1 | -1 }[] = [];
  let lift: THREE.Object3D | null = null;
  let liftH = 0;
  let status: THREE.Mesh | null = null;
  let speed = 1.8;

  const addFrame = (mat: THREE.Material, deep?: number, wide?: number) => {
    const fr = new THREE.Mesh(frameGeometry(len, deep, wide), mat);
    fr.name = 'frame';
    g.add(fr);
  };
  /** hinged leaf: pivot at x0 (hinge), leaf extends toward +x (dir 1) or -x (dir -1) */
  const hinged = (x0: number, w: number, dir: 1 | -1, body: THREE.Material, thick: number, decorate: (leaf: THREE.Group, w: number, fe: 1 | -1) => void) => {
    const pivot = new THREE.Group();
    pivot.position.set(x0, 0, 0);
    const leaf = new THREE.Group();
    leaf.position.set(dir * w / 2, 0, 0);
    const slab = new THREE.Mesh(new THREE.BoxGeometry(w, DOOR_H - 0.012, thick).translate(0, (DOOR_H - 0.012) / 2 + 0.004, 0), body);
    slab.name = 'leaf';
    leaf.add(slab);
    decorate(leaf, w, dir);
    pivot.add(leaf);
    g.add(pivot);
    leaves.push({ pivot, dir });
  };
  const handles = (leaf: THREE.Group, w: number, thick: number, mat: THREE.Material, fe: 1 | -1) => {
    for (const s of [1, -1]) {
      const knob = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.025, 0.025).translate(fe * (w / 2 - 0.12), 1.0, s * (thick / 2 + 0.035)), mat);
      leaf.add(knob);
      const rose = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.1, 0.012).translate(fe * (w / 2 - 0.07), 1.0, s * (thick / 2 + 0.006)), mat);
      leaf.add(rose);
    }
  };

  switch (d.kind) {
    case 'door': {
      addFrame(mats.get('trim'));
      const wood = mats.get('wood');
      const n = len >= 2 ? 2 : 1;
      const w = clear / n - 0.008;
      const deco = (leaf: THREE.Group, lw: number, fe: 1 | -1) => {
        handles(leaf, lw, 0.045, m.brass, fe);
        // vision panel (dark glass) in the upper third
        const pane = new THREE.Mesh(new THREE.BoxGeometry(lw * 0.36, 0.42, 0.05).translate(fe * lw * 0.05, 1.55, 0), m.glass);
        leaf.add(pane);
        const kick = new THREE.Mesh(new THREE.BoxGeometry(lw - 0.04, 0.18, 0.05).translate(0, 0.1, 0), mats.get('metal_dark'));
        leaf.add(kick);
      };
      hinged(h2 + 0.004, w, 1, wood, 0.045, deco);
      if (n === 2) hinged(len - h2 - 0.004, w, -1, wood, 0.045, deco);
      speed = 2.2;
      break;
    }
    case 'fire':
    case 'exit': {
      const exit = d.kind === 'exit';
      addFrame(exit ? m.steel : mats.get('metal_dark'), 0.04, 0.09);
      const n = len >= 2 ? 2 : 1;
      const w = clear / n - 0.008;
      const deco = (leaf: THREE.Group, lw: number, fe: 1 | -1) => {
        if (exit) {
          // aluminium frame with a big glass pane
          const pane = new THREE.Mesh(new THREE.BoxGeometry(lw - 0.16, DOOR_H - 0.5, 0.055).translate(0, DOOR_H / 2 + 0.12, 0), m.glass);
          leaf.add(pane);
        } else {
          const pane = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.5, 0.06).translate(fe * lw * 0.18, 1.55, 0), m.wiredGlass);
          leaf.add(pane);
        }
        // push bar on the side away from the swing (-z), pull handle on the swing side
        const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, lw * 0.78, 8).rotateZ(Math.PI / 2).translate(0, 1.0, -0.085), m.steel);
        leaf.add(bar);
        for (const bx of [-lw * 0.36, lw * 0.36]) leaf.add(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.08, 0.06).translate(bx, 1.0, -0.055), m.steel));
        const pull = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.32, 0.03).translate(fe * (lw / 2 - 0.1), 1.05, 0.065), m.steel);
        leaf.add(pull);
      };
      // exit: aluminium-framed glass doors; fire: heavy red-brown metal doors
      const body = exit ? m.steel : m.fireRed;
      const thick = exit ? 0.05 : 0.055;
      const slabMat = exit ? new THREE.MeshStandardNodeMaterial({ color: 0x5b6166, roughness: 0.35, metalness: 0.85 }) : body;
      hinged(h2 + 0.004, w, 1, slabMat, thick, deco);
      if (n === 2) hinged(len - h2 - 0.004, w, -1, slabMat, thick, deco);
      if (exit) {
        // the slab is a frame: hollow it by hiding the slab centre behind the glass (cheap: thin slab ring)
        for (const lf of leaves) {
          const slab = lf.pivot.getObjectByName('leaf') as THREE.Mesh;
          slab.geometry.dispose();
          const parts: THREE.BufferGeometry[] = [];
          const ww = w, hh = DOOR_H - 0.012;
          parts.push(box(ww, 0.12, thick, 0, 0.06 + 0.004, 0), box(ww, 0.2, thick, 0, hh - 0.1 + 0.004, 0));
          parts.push(box(0.09, hh, thick, -ww / 2 + 0.045, hh / 2 + 0.004, 0), box(0.09, hh, thick, ww / 2 - 0.045, hh / 2 + 0.004, 0));
          parts.push(box(ww, 0.25, thick, 0, 0.3, 0));
          slab.geometry = mergeGeometries(parts);
        }
      }
      speed = exit ? 1.6 : 1.5;
      break;
    }
    case 'security':
    case 'locked': {
      const sec = d.kind === 'security';
      addFrame(m.steel, 0.06, 0.12);
      const shutter = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(clear + 0.06, DOOR_H, 0.08).translate(len / 2, DOOR_H / 2, 0), sec ? m.hazard : m.doorGrey);
      body.name = 'leaf';
      shutter.add(body);
      // ribs
      for (let y = 0.25; y < DOOR_H; y += 0.3) shutter.add(new THREE.Mesh(new THREE.BoxGeometry(clear + 0.04, 0.035, 0.1).translate(len / 2, y, 0), sec ? mats.get('metal_dark') : m.steel));
      if (!sec) {
        // keycard colour band across the shutter
        const col = KEY_COLORS[Math.min(KEY_COLORS.length - 1, Math.max(1, d.lock))];
        for (const s of [1, -1]) shutter.add(new THREE.Mesh(new THREE.BoxGeometry(clear * 0.9, 0.12, 0.01).translate(len / 2, 1.35, s * 0.046), mats.glow(col, 1.2)));
      }
      g.add(shutter);
      lift = shutter;
      liftH = DOOR_H - 0.14;
      // status lamp above the opening on both faces (security: amber, locked: keycard colour)
      const lampCol = sec ? 0xffa21a : KEY_COLORS[Math.min(KEY_COLORS.length - 1, Math.max(1, d.lock))];
      const lampGeo = mergeGeometries([box(0.22, 0.09, 0.06, len / 2, DOOR_H + 0.2, h2 + 0.03), box(0.22, 0.09, 0.06, len / 2, DOOR_H + 0.2, -h2 - 0.03)]);
      status = new THREE.Mesh(lampGeo, mats.glow(lampCol, 3));
      status.name = 'status';
      g.add(status);
      if (!sec) {
        // card readers beside the opening on both faces
        for (const s of [1, -1]) {
          const reader = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.17, 0.035).translate(len - h2 + 0.22, 1.2, s * (h2 + 0.018)), m.doorGrey);
          g.add(reader);
          g.add(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.02, 0.01).translate(len - h2 + 0.22, 1.25, s * (h2 + 0.037)), mats.glow(lampCol, 2.5)));
        }
      }
      speed = sec ? 0.75 : 1.0;
      break;
    }
    case 'vault': {
      if (len >= 2) {
        const R = 1.12;
        const cx = len / 2, cy = 1.1;
        // heavy ring frame on the corridor face
        const ring = new THREE.Mesh(new THREE.TorusGeometry(R + 0.04, 0.09, 10, 40).translate(cx, cy, h2 + 0.06), m.steel);
        g.add(ring);
        const backPlate = new THREE.Mesh(new THREE.RingGeometry(R - 0.02, R + 0.14, 40).translate(cx, cy, h2 + 0.005), mats.get('metal_dark'));
        g.add(backPlate);
        const pivot = new THREE.Group();
        pivot.position.set(cx + R + 0.02, 0, h2 + 0.2);
        const disc = new THREE.Group();
        disc.position.set(-R - 0.02, 0, 0);
        const slab = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 0.34, 48).rotateX(Math.PI / 2).translate(0, cy, 0), m.steel);
        slab.name = 'leaf';
        disc.add(slab);
        disc.add(new THREE.Mesh(new THREE.CylinderGeometry(R * 0.82, R * 0.82, 0.36, 48).rotateX(Math.PI / 2).translate(0, cy, 0), mats.get('metal_dark')));
        // locking wheel + spokes + bolts
        disc.add(new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.035, 8, 28).translate(0, cy, 0.26), m.steel));
        for (let k = 0; k < 4; k++) {
          const sp = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.035, 0.035).translate(0, 0, 0), m.steel);
          sp.position.set(0, cy, 0.26);
          sp.rotation.z = (k * Math.PI) / 4;
          disc.add(sp);
        }
        disc.add(new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.12, 16).rotateX(Math.PI / 2).translate(0, cy, 0.2), m.steel));
        for (let k = 0; k < 12; k++) {
          const a = (k / 12) * Math.PI * 2;
          const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.05, 8).rotateX(Math.PI / 2), m.brass);
          bolt.position.set(Math.cos(a) * (R - 0.09), cy + Math.sin(a) * (R - 0.09), 0.18);
          disc.add(bolt);
        }
        // hinge barrels
        for (const hy of [0.45, 1.75]) g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.34, 12).translate(cx + R + 0.02, hy, h2 + 0.2), m.steel));
        pivot.add(disc);
        g.add(pivot);
        leaves.push({ pivot, dir: -1 });
      } else {
        addFrame(m.steel, 0.07, 0.14);
        hinged(h2 + 0.004, clear - 0.008, 1, m.steel, 0.16, (leaf, lw) => {
          leaf.add(new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.025, 8, 24).translate(0, 1.15, 0.11), m.brass));
          void lw;
        });
      }
      speed = 0.4;
      break;
    }
    case 'blocked': {
      // rubble heap filling the opening (static), cosmetic rng per door
      const r = makeRng(`${L.seed}:${d.id}`, 'decor:rubble');
      const parts: THREE.BufferGeometry[] = [];
      const n = 10 + Math.round(clear * 9);
      for (let k = 0; k < n; k++) {
        const t = k / n;
        const w = 0.25 + r.next() * 0.45, hh = 0.2 + r.next() * 0.35, dd = 0.25 + r.next() * 0.45;
        const x = h2 + w / 2 + r.next() * Math.max(0.01, clear - w);
        const y = Math.min(DOOR_H - 0.2, (1 - t) * 0.1 + t * (1.2 + r.next() * 0.9)) + hh / 2;
        const z = (r.next() - 0.5) * 0.9 * (1 - t * 0.5);
        const geo = new THREE.BoxGeometry(w, hh, dd);
        geo.rotateY((r.next() - 0.5) * 1.2);
        geo.rotateZ((r.next() - 0.5) * 0.5);
        geo.translate(x, y, z);
        parts.push(geo);
      }
      // a fallen beam
      const beam = new THREE.BoxGeometry(clear + 0.5, 0.18, 0.2);
      beam.rotateZ(0.42 * (r.chance(0.5) ? 1 : -1));
      beam.translate(len / 2, 1.0, 0.25);
      parts.push(beam);
      const heap = new THREE.Mesh(mergeGeometries(parts.map((p) => p.toNonIndexed())), mats.get('rubble'));
      heap.name = 'rubble';
      g.add(heap);
      addFrame(mats.get('metal_rusty'), 0.03, 0.08);
      speed = 0;
      break;
    }
    default:
      return null;
  }

  const vis: DoorVisual = {
    id: d.id, kind: d.kind, group: g, open: d.initiallyOpen, t: d.initiallyOpen ? 1 : 0, speed, spaces, status,
    apply(t: number) {
      const k = ease(Math.max(0, Math.min(1, t)));
      const ang = (d.kind === 'vault' ? 100 : 92) * (Math.PI / 180) * k;
      for (const lf of leaves) lf.pivot.rotation.y = lf.dir === 1 ? -ang : ang;
      if (lift) lift.position.y = liftH * k;
    },
  };
  if (d.kind === 'blocked') { vis.open = false; vis.t = 0; }
  vis.apply(vis.t);
  g.traverse((o) => { o.matrixAutoUpdate = true; });
  return vis;
}
