// Owner: env-world (v1.2). Openable container visuals: drawers / trays slide along the host's local +Z, doors and lids
// hinge about their pivot (env-layout's CONTAINER_DEFS conventions). Movable parts are InstancedMesh instances (per
// space + prop key + part shape, no shadows, bounding spheres computed fully open), animated here with setMatrixAt +
// needsUpdate: opening never adds a draw call. State (target mask, eased progress, quiet-open overrides) is kept per
// container id from the layout, so calls that arrive before the async GLB templates exist are applied the moment the
// instances are created.
import * as THREE from 'three/webgpu';
import type { ContainerInfo, ContainerPart } from '@dead-air/shared/procgen/containers.ts';

/** seconds for a tap to open / close a part fully (brief: <= 0.4 s) */
export const TAP_SECONDS = 0.34;
const ease = (t: number) => t * t * (3 - 2 * t);
const AXIS = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0) } as const;
type PoseOf = Pick<ContainerPart, 'kind' | 'travel' | 'hinge' | 'authoredOpen'>;
const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _m3 = new THREE.Matrix4();

/** rotation by `angle` about the hinge axis through its pivot */
function hingeMatrix(h: NonNullable<ContainerPart['hinge']>, angle: number, out: THREE.Matrix4): THREE.Matrix4 {
  const [px, py, pz] = h.pivot;
  return out.makeTranslation(px, py, pz).multiply(_m.makeRotationAxis(AXIS[h.axis], angle)).multiply(_m2.makeTranslation(-px, -py, -pz));
}

/** host-local transform of a part at openness t (0 closed .. 1 fully open), applied to its CLOSED-pose geometry:
 *  drawers / trays slide travel (<= 0.45 m) along +Z; doors / lids turn sign * travel * t about the hinge */
export function partPose(part: PoseOf, t: number, out: THREE.Matrix4): THREE.Matrix4 {
  const k = ease(Math.max(0, Math.min(1, t)));
  if (part.kind === 'drawer' || part.kind === 'tray' || !part.hinge) return out.makeTranslation(0, 0, Math.min(0.45, Math.max(0, part.travel)) * k);
  return hingeMatrix(part.hinge, part.hinge.sign * part.travel * k, out);
}

/** authored -> closed correction of a model part (CONTAINER_DEFS authoredOpen: turn by -sign * travel); else identity */
export function restOf(part: PoseOf | null | undefined, out: THREE.Matrix4): THREE.Matrix4 {
  if (!part?.authoredOpen || !part.hinge) return out.identity();
  return hingeMatrix(part.hinge, -part.hinge.sign * part.travel, out);
}

/** host-local pose of a rendered piece at openness t (replaces partPose: e.g. a morgue door that swings aside while
 *  its tray slides out) */
export type PiecePose = (t: number, out: THREE.Matrix4) => THREE.Matrix4;
/** one rendered copy of a part: instance `index` of `im`; base = (rest . centre) matrix in the host frame; pose = an
 *  own motion for a piece of the part (default: the part's slide / hinge) */
interface Slot { im: THREE.InstancedMesh; index: number; base: THREE.Matrix4; pose?: PiecePose }
interface PartState { part: ContainerPart; t: number; override: number | null; slots: Slot[] }
interface ContState { info: ContainerInfo; host: THREE.Matrix4; mask: number; parts: Map<number, PartState> }

export class ContainerSystem {
  private conts = new Map<string, ContState>();
  private list: readonly ContainerInfo[] = [];
  private animating = new Set<ContState>();
  /** gate: flag 'containers' false keeps every drawer shut */
  enabled = true;

  /** new layout: containers + their host placement matrices (world) */
  reset(list: readonly ContainerInfo[], hostOf: (c: ContainerInfo) => THREE.Matrix4 | null): void {
    this.conts.clear();
    this.animating.clear();
    this.list = list;
    for (const info of list) {
      const host = hostOf(info) ?? new THREE.Matrix4().makeRotationY(info.rot).setPosition(info.x, 0, info.z);
      const parts = new Map<number, PartState>();
      for (const p of info.parts) parts.set(p.idx, { part: p, t: 0, override: null, slots: [] });
      this.conts.set(info.id, { info, host, mask: 0, parts });
    }
  }

  containers(): readonly ContainerInfo[] { return this.list; }
  has(id: string): boolean { return this.conts.has(id); }
  info(id: string): ContainerInfo | null { return this.conts.get(id)?.info ?? null; }
  /** host placement matrix (world) of a container */
  host(id: string): THREE.Matrix4 | null { return this.conts.get(id)?.host ?? null; }

  /** a rendered instance of a container part (async GLB arrival or the procedural build); applies the current pose */
  addSlot(id: string, idx: number, im: THREE.InstancedMesh, index: number, base: THREE.Matrix4, pose?: PiecePose): void {
    const c = this.conts.get(id);
    const ps = c?.parts.get(idx);
    if (!c || !ps) return;
    ps.slots.push({ im, index, base: base.clone(), ...(pose ? { pose } : {}) });
    this.write(c, ps);
  }

  setOpen(id: string, mask: number, instant = false): void {
    const c = this.conts.get(id);
    if (!c) return;
    c.mask = this.enabled ? mask >>> 0 : 0;
    for (const ps of c.parts.values()) {
      if (!instant || ps.override !== null) continue;
      ps.t = (c.mask >>> ps.part.idx) & 1;
      this.write(c, ps);
    }
    this.animating.add(c);
  }
  open(id: string): number { return this.conts.get(id)?.mask ?? 0; }
  anim(id: string, idx: number): number {
    const ps = this.conts.get(id)?.parts.get(idx);
    return ps ? (ps.override ?? ps.t) : 0;
  }
  /** visual 0..1 during a quiet open; null hands back to the mask (eases on from where it is) */
  setProgress(id: string, idx: number, t: number | null): void {
    const c = this.conts.get(id);
    const ps = c?.parts.get(idx);
    if (!c || !ps) return;
    if (t === null) {
      if (ps.override !== null) ps.t = ps.override;
      ps.override = null;
    } else ps.override = this.enabled ? Math.max(0, Math.min(1, t)) : 0;
    this.write(c, ps);
    this.animating.add(c);
  }
  /** world matrix of a part at its current pose (items riding in a drawer: partMatrix . host-local offset) */
  partMatrix(id: string, idx: number, out: THREE.Matrix4): boolean {
    const c = this.conts.get(id);
    const ps = c?.parts.get(idx);
    if (!c || !ps) return false;
    partPose(ps.part, ps.override ?? ps.t, _m3);
    out.multiplyMatrices(c.host, _m3);
    return true;
  }
  /** true while any part is easing (callers keep per-frame followers such as drawer pages in sync) */
  busy(): boolean { return this.animating.size > 0; }

  /** per frame: ease parts toward their mask bit (a tap takes TAP_SECONDS) */
  update(dt: number): void {
    if (!this.animating.size) return;
    const step = dt / TAP_SECONDS;
    for (const c of [...this.animating]) {
      let moving = false;
      for (const ps of c.parts.values()) {
        if (ps.override !== null) continue;
        const target = (c.mask >>> ps.part.idx) & 1;
        if (ps.t === target) continue;
        ps.t = target > ps.t ? Math.min(1, ps.t + step) : Math.max(0, ps.t - step);
        this.write(c, ps);
        if (ps.t !== target) moving = true;
      }
      if (!moving) this.animating.delete(c);
    }
  }

  private write(c: ContState, ps: PartState): void {
    if (!ps.slots.length) return;
    const t = ps.override ?? ps.t;
    partPose(ps.part, t, _m3);
    const world = _w.multiplyMatrices(c.host, _m3);
    for (const s of ps.slots) {
      if (s.pose) s.im.setMatrixAt(s.index, _w2.multiplyMatrices(c.host, s.pose(t, _m4)).multiply(s.base));
      else s.im.setMatrixAt(s.index, _w2.multiplyMatrices(world, s.base));
      s.im.instanceMatrix.needsUpdate = true;
    }
  }
}
const _w = new THREE.Matrix4(), _w2 = new THREE.Matrix4(), _m4 = new THREE.Matrix4();

/** a piece swinging on a vertical hinge at `pivot` (host-local) by sign * travel, fully open once the part is `lead`
 *  of the way out (a morgue door clears the tray that slides out behind it) */
export function swingPose(pivot: readonly [number, number, number], sign: 1 | -1, travel: number, lead: number): PiecePose {
  const h = { axis: 'y' as const, pivot: [pivot[0], pivot[1], pivot[2]] as [number, number, number], sign };
  return (t, out) => hingeMatrix(h, sign * travel * ease(Math.max(0, Math.min(1, t / Math.max(0.05, lead)))), out);
}

/** a part's slot (env-layout's host-local slotLocal, part OPEN) relative to the part centre in its CLOSED pose:
 *  drawers / trays carry their slot, hinged parts leave it in the host (no slide) */
export function slotInPart(p: Pick<ContainerPart, 'kind' | 'local' | 'travel'> & { slotLocal?: readonly [number, number, number] } | undefined): [number, number, number] | undefined {
  if (!p?.slotLocal) return undefined;
  const slide = p.kind === 'drawer' || p.kind === 'tray' ? Math.min(0.45, Math.max(0, p.travel)) : 0;
  return [p.slotLocal[0] - p.local[0], p.slotLocal[1] - p.local[1], p.slotLocal[2] - slide - p.local[2]];
}

/**
 * Highest surface of `geos` straight under (x, z) below yStart (a vertical ray; positions in the model frame), or null.
 * Tests and the level use it to find the real floor of a model drawer / tray (some carry a raised bottom).
 */
export function floorUnder(geos: readonly THREE.BufferGeometry[], x: number, z: number, yStart: number): number | null {
  let best: number | null = null;
  for (const g of geos) {
    const pos = g.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) continue;
    const idx = g.index;
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i + 2 < n; i += 3) {
      const a = idx ? idx.getX(i) : i, b = idx ? idx.getX(i + 1) : i + 1, c = idx ? idx.getX(i + 2) : i + 2;
      const ax = pos.getX(a), az = pos.getZ(a), bx = pos.getX(b), bz = pos.getZ(b), cx = pos.getX(c), cz = pos.getZ(c);
      const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(det) < 1e-12) continue;
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
      const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      const y = l1 * pos.getY(a) + l2 * pos.getY(b) + l3 * pos.getY(c);
      if (y < yStart && (best === null || y > best)) best = y;
    }
  }
  return best;
}

/** template geometry a measuredFloor needs (structural: assets.ts PropTemplateInfo) */
interface FloorTemplate { body: readonly { geometry: THREE.BufferGeometry }[]; parts: readonly { nodes: readonly string[]; geometry: THREE.BufferGeometry; centre: THREE.Vector3; size: THREE.Vector3 }[] }
const floorCache = new WeakMap<object, Map<string, number | null>>();
/**
 * The real floor under a container slot of a model host (host-local y), or null when not measurable: a drawer / tray
 * is probed inside its own geometry (closed pose; the slot rides with it), a hinged lid / door in the body under it.
 * Values far from env-layout's slot height (> 6 cm under, > 20 cm over) are rejected as a ray through a gap.
 */
export function measuredFloor(info: FloorTemplate, part: Pick<ContainerPart, 'kind' | 'node' | 'local' | 'size' | 'travel'>, slotLocal: readonly [number, number, number]): number | null {
  const key = `${part.node ?? ''}|${slotLocal.join(',')}`;
  let per = floorCache.get(info);
  if (!per) { per = new Map(); floorCache.set(info, per); }
  if (per.has(key)) return per.get(key)!;
  let y: number | null = null;
  if (part.kind === 'drawer' || part.kind === 'tray') {
    const tp = part.node ? info.parts.find((p) => p.nodes.includes(part.node!)) : undefined;
    if (tp) y = floorUnder([tp.geometry], slotLocal[0], slotLocal[2] - Math.min(0.45, Math.max(0, part.travel)), tp.centre.y + tp.size.y / 2 + 0.01);
  } else {
    y = floorUnder(info.body.map((m) => m.geometry), slotLocal[0], slotLocal[2], part.local[1] - part.size[1] / 2 - 0.004);
  }
  if (y !== null && (y < slotLocal[1] - 0.06 || y > slotLocal[1] + 0.2)) y = null;
  per.set(key, y);
  return y;
}

/** instance matrix of a part at openness t: host . pose(t) . base (base = rest . centre) */
export function partInstanceMatrix(host: THREE.Matrix4, part: PoseOf | null, t: number, base: THREE.Matrix4, out: THREE.Matrix4): THREE.Matrix4 {
  if (!part) return out.multiplyMatrices(host, base);
  partPose(part, t, _m3);
  return out.multiplyMatrices(host, _m3).multiply(base);
}
