// Owner: env-world (v1.2). One InstancedMesh for every placement of a prop part across the WHOLE site (parent: the
// level root), instead of one per room. Door-lag finding: three r186 gives every InstancedMesh its own node build and
// its own shader (RenderObject cache key + the instance buffer's generated name), so the per-room meshes compiled new
// shaders on each room's first draw (0.5-3 s hitches when a door opened); a site-wide batch is drawn and compiled
// once, at load (render.warmSite), and a room reveal only changes which instances it draws.
// Per-room culling is kept by PACKING: the instances of the visible spaces occupy the front of the buffer and `count`
// covers them. Logical instance ids (add order) never change, so containers, prop handles and drawer pages keep
// addressing their instance; an update to a hidden instance is stored and lands when its space is packed again.
// Packing is stable: an instance that stays visible keeps its slot (the TRAA velocity pass compares each slot with the
// previous frame), newly visible instances fill holes first, and the buffer is only compacted when holes dominate.
import * as THREE from 'three/webgpu';

/** extra bounds (m) around the packed instances: drawer travel, hinged doors, small shoves */
const MARGIN = 0.75;
const ZERO16 = new Float32Array(16);
const _sph = new THREE.Sphere();
const _mat = new THREE.Matrix4();

/** the batch behind a level InstancedMesh (tests / diagnostics; never in userData: clone() would copy a cycle) */
const byMesh = new WeakMap<THREE.Object3D, SiteBatch>();
export function siteBatchOf(o: THREE.Object3D): SiteBatch | null { return byMesh.get(o) ?? null; }

const zeroScale = (m: THREE.Matrix4): boolean => {
  const e = m.elements;
  return e[0] === 0 && e[1] === 0 && e[2] === 0 && e[4] === 0 && e[5] === 0 && e[6] === 0 && e[8] === 0 && e[9] === 0 && e[10] === 0;
};

export class SiteBatch {
  readonly im: THREE.InstancedMesh;
  /** spaces holding at least one instance (render's mirror warm set compiles the batches of mirror rooms) */
  readonly spaces = new Set<number>();
  private readonly spaceOf: Int32Array;
  private readonly data: Float32Array;
  /** logical id -> packed slot (-1 = not drawn) */
  private readonly slotOf: Int32Array;
  /** packed slot -> logical id (-1 = hole: zero-scale matrix) */
  private readonly owner: Int32Array;
  private n = 0;
  private used = 0;

  constructor(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number, name: string) {
    const cap = Math.max(1, Math.floor(capacity));
    this.im = new THREE.InstancedMesh(geometry, material, cap);
    this.im.name = name;
    this.im.count = 0;
    this.im.visible = false;
    this.im.userData.siteSpaces = this.spaces;
    byMesh.set(this.im, this);
    this.spaceOf = new Int32Array(cap);
    this.data = new Float32Array(cap * 16);
    this.slotOf = new Int32Array(cap).fill(-1);
    this.owner = new Int32Array(cap).fill(-1);
  }

  /** logical instances added so far */
  get size(): number { return this.n; }
  get capacity(): number { return this.spaceOf.length; }

  /** a new logical instance in `space` (not drawn until the next pack); returns its id, -1 when full */
  add(space: number, m: THREE.Matrix4): number {
    if (this.n >= this.spaceOf.length) return -1;
    const id = this.n++;
    this.spaceOf[id] = space;
    m.toArray(this.data, id * 16);
    this.spaces.add(space);
    return id;
  }

  /** world matrix of a logical instance (drawn now or the next time its space is visible) */
  setMatrixAt(id: number, m: THREE.Matrix4): void {
    if (id < 0 || id >= this.n) return;
    m.toArray(this.data, id * 16);
    const k = this.slotOf[id];
    if (k < 0) return;
    this.im.setMatrixAt(k, m);
    this.im.instanceMatrix.needsUpdate = true;
    // a moved instance (a shoved prop) keeps inside the bounds; a zero-scale (hidden) one never grows them
    const bs = this.im.boundingSphere;
    if (!bs || zeroScale(m)) return;
    const g = this.im.geometry;
    if (!g.boundingSphere) g.computeBoundingSphere();
    _sph.copy(g.boundingSphere!).applyMatrix4(m);
    if (bs.isEmpty() || bs.center.distanceTo(_sph.center) + _sph.radius > bs.radius) bs.union(_sph);
  }

  getMatrixAt(id: number, out: THREE.Matrix4): THREE.Matrix4 {
    return id >= 0 && id < this.n ? out.fromArray(this.data, id * 16) : out.identity();
  }

  spaceOfId(id: number): number { return id >= 0 && id < this.n ? this.spaceOf[id] : -1; }
  /** packed slot of a logical instance (-1 = not drawn); tests */
  slotOfId(id: number): number { return id >= 0 && id < this.n ? this.slotOf[id] : -1; }

  /** draw the instances of the visible spaces (mask[space] !== 0; null = every space) */
  pack(mask: Uint8Array | null): void {
    const vis = (s: number) => mask === null || (s >= 0 && s < mask.length && mask[s] !== 0);
    const arr = this.im.instanceMatrix.array as Float32Array;
    let count = this.im.count;
    let changed = false;
    // 1. instances of spaces that went out of view: their slots become holes
    for (let i = 0; i < this.n; i++) {
      const k = this.slotOf[i];
      if (k < 0 || vis(this.spaceOf[i])) continue;
      this.slotOf[i] = -1;
      this.owner[k] = -1;
      arr.set(ZERO16, k * 16);
      this.used--;
      changed = true;
    }
    // 2. instances of newly visible spaces: the lowest holes first, then appended
    let hole = 0;
    for (let i = 0; i < this.n; i++) {
      if (this.slotOf[i] >= 0 || !vis(this.spaceOf[i])) continue;
      while (hole < count && this.owner[hole] >= 0) hole++;
      const k = hole < count ? hole : count++;
      this.owner[k] = i;
      this.slotOf[i] = k;
      arr.set(this.data.subarray(i * 16, i * 16 + 16), k * 16);
      this.used++;
      changed = true;
    }
    // 3. no trailing holes; compact (in slot order) when holes dominate the drawn range
    while (count > 0 && this.owner[count - 1] < 0) count--;
    if (count - this.used > Math.max(8, count >> 1)) {
      let w = 0;
      for (let k = 0; k < count; k++) {
        const i = this.owner[k];
        if (i < 0) continue;
        if (k !== w) {
          arr.copyWithin(w * 16, k * 16, k * 16 + 16);
          arr.set(ZERO16, k * 16);
          this.owner[w] = i;
          this.owner[k] = -1;
          this.slotOf[i] = w;
        }
        w++;
      }
      count = w;
      changed = true;
    }
    if (count !== this.im.count) changed = true;
    this.im.count = count;
    this.im.visible = count > 0;
    if (!changed) return;
    this.im.instanceMatrix.needsUpdate = true;
    this.refreshBounds();
  }

  /** bounds over the drawn instances (+ MARGIN for parts that move after the pack) */
  private refreshBounds(): void {
    const im = this.im;
    const g = im.geometry;
    if (!g.boundingSphere) g.computeBoundingSphere();
    const bs = im.boundingSphere ?? (im.boundingSphere = new THREE.Sphere());
    bs.makeEmpty();
    const arr = im.instanceMatrix.array as Float32Array;
    for (let k = 0; k < im.count; k++) {
      if (this.owner[k] < 0) continue;
      _mat.fromArray(arr, k * 16);
      if (zeroScale(_mat)) continue;
      _sph.copy(g.boundingSphere!).applyMatrix4(_mat);
      bs.union(_sph);
    }
    if (!bs.isEmpty()) bs.radius += MARGIN;
  }

  dispose(): void { this.im.dispose(); }
}
