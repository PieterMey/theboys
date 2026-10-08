// Owner: env-world (v1.2). Decorative mirror props (strip over the washroom sinks, hand mirror on the wards, tall hall
// mirror in the lobby, a dressing mirror with bulbs in the gallery) and the glass registry: every glass (these + the
// van mirror) registers with render.mirrors (itemId = the layout item), and mirrorOf(itemId) hands the MirrorHandle
// to paranormal. The frame is static furniture merged per space + material; the glass is its own mesh (local +Z out,
// the size of MirrorSpot w x h). Without a render mirror service (stub, flag off) the glass keeps its fallback look.
import * as THREE from 'three/webgpu';
import type { MirrorKind, MirrorSpot } from '@dead-air/shared/procgen/mirrors.ts';
import type { MirrorHandle, MirrorOpts } from '../render/api.ts';
import type { Part } from './setpieces.ts';
import { RB } from './kits.ts';
import { part } from './geo.ts';
import type { AnyGeo } from './geo.ts';

const B = (w: number, h: number, d: number, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
/** glass plane offset in front of the item centre (frame boxes are MIRROR_DEPTH 0.04 deep, back on the wall) */
export const GLASS_Z = 0.013;

/** static frame geometry of a decorative mirror (local frame: item centre = glass centre, +Z out of the wall) */
export function mirrorFrameParts(kind: MirrorKind, w: number, h: number): Part[] {
  const P: Part[] = [];
  const add = (mat: string, ...gs: AnyGeo[]) => { for (const g of gs) P.push(part(mat, g)); };
  const back = (bw: number, bh: number, mat = 'black') => add(mat, B(bw, bh, 0.012, 0, 0, -0.014));
  switch (kind) {
    case 'strip': {
      // frameless washroom strip: polished edges, four chrome clips, a narrow shelf under it
      back(w, h);
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) add('steel', B(0.04, 0.025, 0.02, sx * (w / 2 - 0.12), sy * (h / 2 + 0.004), 0.004));
      add('enamel', B(w * 0.8, 0.02, 0.09, 0, -h / 2 - 0.06, 0.025));
      for (const sx of [-1, 1]) add('steel', B(0.02, 0.05, 0.08, sx * w * 0.35, -h / 2 - 0.085, 0.02));
      break;
    }
    case 'hand': {
      // enamelled steel frame (hospital), rounded
      back(w + 0.04, h + 0.04);
      const f = 0.028;
      add('enamel', RB(w + 2 * f, f, 0.03, 0, h / 2 + f / 2, 0, 0.008, 1), RB(w + 2 * f, f, 0.03, 0, -h / 2 - f / 2, 0, 0.008, 1));
      add('enamel', RB(f, h, 0.03, -w / 2 - f / 2, 0, 0, 0.008, 1), RB(f, h, 0.03, w / 2 + f / 2, 0, 0, 0.008, 1));
      add('steel', B(0.12, 0.012, 0.03, 0, h / 2 + f + 0.03, -0.005));
      break;
    }
    case 'hall': {
      // heavy dark-wood frame with a brass bead and a crest
      back(w + 0.06, h + 0.06);
      const f = 0.075;
      add('woodDark', RB(w + 2 * f, f, 0.045, 0, h / 2 + f / 2, 0.002, 0.012), RB(w + 2 * f, f, 0.045, 0, -h / 2 - f / 2, 0.002, 0.012));
      add('woodDark', RB(f, h, 0.045, -w / 2 - f / 2, 0, 0.002, 0.012), RB(f, h, 0.045, w / 2 + f / 2, 0, 0.002, 0.012));
      add('brass', B(w + 0.02, 0.012, 0.012, 0, h / 2 + 0.006, 0.018), B(w + 0.02, 0.012, 0.012, 0, -h / 2 - 0.006, 0.018), B(0.012, h, 0.012, -w / 2 - 0.006, 0, 0.018), B(0.012, h, 0.012, w / 2 + 0.006, 0, 0.018));
      add('woodDark', RB(w * 0.45, 0.12, 0.05, 0, h / 2 + f + 0.05, 0, 0.02));
      break;
    }
    case 'dressing': {
      // theatre dressing mirror: a painted board frame studded with bulbs
      const f = 0.11;
      add('woodDark', RB(w + 2 * f, h + 2 * f, 0.03, 0, 0, -0.006, 0.01));
      const bulbs: [number, number][] = [];
      for (let k = 0; k < 4; k++) bulbs.push([-w / 2 + (k + 0.5) * (w / 4), h / 2 + f / 2]);
      for (let k = 0; k < 4; k++) { bulbs.push([-w / 2 - f / 2, h / 2 - (k + 0.5) * (h / 4)]); bulbs.push([w / 2 + f / 2, h / 2 - (k + 0.5) * (h / 4)]); }
      for (const [bx, by] of bulbs) {
        add('steel', new THREE.CylinderGeometry(0.018, 0.018, 0.02, 8).rotateX(Math.PI / 2).translate(bx, by, 0.018));
        add('bulbWarm', new THREE.SphereGeometry(0.026, 10, 8).translate(bx, by, 0.04));
      }
      break;
    }
    case 'van':
    default:
      back(w, h);
      break;
  }
  return P;
}

let fallbackGlass: THREE.MeshStandardNodeMaterial | null = null;
/** shared fallback glass (silvered, a touch rough): what a mirror shows when it is not live */
export function mirrorGlassMaterial(): THREE.MeshStandardNodeMaterial {
  if (!fallbackGlass) {
    fallbackGlass = new THREE.MeshStandardNodeMaterial({ color: 0x9aa3a6, roughness: 0.07, metalness: 1 });
    fallbackGlass.name = 'level.mirror.glass';
  }
  return fallbackGlass;
}

/** holder + glass mesh for a decorative mirror spot (world placement on the holder) */
export function makeMirrorGlass(spot: MirrorSpot, material: THREE.Material = mirrorGlassMaterial()): { holder: THREE.Group; glass: THREE.Mesh } {
  const holder = new THREE.Group();
  holder.name = `mirror:${spot.id}`;
  holder.position.set(spot.x, spot.y, spot.z);
  holder.rotation.y = spot.rot;
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(spot.w, spot.h), material);
  glass.name = 'glass';
  glass.position.z = GLASS_Z;
  glass.castShadow = false;
  glass.receiveShadow = false;
  holder.add(glass);
  holder.updateMatrixWorld(true);
  return { holder, glass };
}

interface MirrorServiceLike { register(glass: THREE.Mesh, opts: MirrorOpts): MirrorHandle }

/** item id -> MirrorHandle for the current layout (disposed on rebuild) */
export class MirrorRegistry {
  private handles = new Map<string, MirrorHandle>();
  private pending: { glass: THREE.Mesh; opts: MirrorOpts }[] = [];

  /** register a glass now, or as soon as a mirror service appears (retry from the level system) */
  add(svc: MirrorServiceLike | null | undefined, glass: THREE.Mesh, opts: MirrorOpts): void {
    if (!svc) { this.pending.push({ glass, opts }); return; }
    this.registerOne(svc, glass, opts);
  }
  /** a render mirror service became available: register what waited */
  flush(svc: MirrorServiceLike | null | undefined): void {
    if (!svc || !this.pending.length) return;
    const list = this.pending;
    this.pending = [];
    for (const p of list) this.registerOne(svc, p.glass, p.opts);
  }
  hasPending(): boolean { return this.pending.length > 0; }
  private registerOne(svc: MirrorServiceLike, glass: THREE.Mesh, opts: MirrorOpts): void {
    try {
      glass.updateMatrixWorld(true);
      const h = svc.register(glass, opts);
      if (h && opts.itemId) this.handles.set(opts.itemId, h);
    } catch (e) {
      console.warn(`[level] mirror register failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  of(itemId: string): MirrorHandle | null { return this.handles.get(itemId) ?? null; }
  clear(): void {
    for (const h of this.handles.values()) { try { h.dispose(); } catch { /* render already gone */ } }
    this.handles.clear();
    this.pending = [];
  }
  count(): number { return this.handles.size; }
}
