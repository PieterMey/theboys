// Owner: env-render (v1.2). render.warmSite() (door-lag fix): every mesh under the level root (all spaces, the doors,
// the site-wide prop batches, hidden pages / upgrades) is drawn once through the REAL frame (pre-pass, scene pass,
// every shadow slot via the warm beams) behind the loading / drive screen, so opening a door or a first walk into a
// room compiles nothing. three r186 compiles on an object's first draw: the node builder cache key holds the
// material + vertex layout (+ the object uuid for an InstancedMesh), so meshes with one signature share their
// shaders. Each frame forces a few signature groups (visible, frustum culling off; every other level mesh leaves all
// layers for that frame, v1.3) and restores everything right after the render. Pacing: a group
// costs ~1 unit per material not warmed yet (+1 per InstancedMesh, x1.5 when it casts shadows: the shadow pass); a
// frame takes units up to its budget. v1.3 (3c) cost model: a warm frame is charged its WHOLE interval, from its
// begin() to the next frame's begin() (the JS render plus whatever the GPU process / driver then spent on its new
// pipelines: on WebGPU the compiles stall the NEXT frame, which v1.2 booked as idle time and answered with a bigger
// batch, up to 40 units: the host's 6.6-8.5 s frames). The budget aims a warm frame at base + clamp(2 x base, 50,
// 250) ms from the measured ms per unit, grows by at most x1.5 per frame, and is capped per backend (limits(): ~6
// units on WebGL2, ~4 signature groups on WebGPU). base = a calibration frame's wall time: a warm frame that forces
// nothing (every level mesh isolated), at the start of each run and whenever the queue moves from the instanced
// batches to the plain meshes (their per-unit cost differs, software lane run: ~40 vs ~190 ms; the budget restarts
// at 1 there too). Pausable: a run that hits its time limit resolves { done: false } and the next run resumes where it
// stopped; a level rebuild starts over.
import type * as THREE from 'three/webgpu';
import type { SiteWarmResult } from './types.ts';

export interface SiteWarmDeps {
  /** the level root (null: no level / the test backdrop) */
  root(): THREE.Object3D | null;
  /** changes on every level rebuild */
  version(): unknown;
  /** meshes never forced (live mirror glass, mirror warm meshes, layers no camera draws) */
  skip(m: THREE.Mesh): boolean;
  now(): number;
  /** v1.3 (3c): per-frame caps (cost units, signature groups); default WARM_LIMITS.webgl2 */
  limits?(): WarmLimits;
}

/** v1.3 (3c): the most a warm frame takes, whatever the measured costs say (render.json warm.*) */
export interface WarmLimits {
  /** cost units per frame (sync link per program on WebGL2 without KHR_parallel_shader_compile) */
  units: number;
  /** signature groups per frame (WebGPU: the JS cost of a pipeline is ~0, the GPU process pays for it) */
  groups: number;
  /** a warm frame aims at base + clamp(2 x base, minMs, maxMs) */
  minMs: number;
  maxMs: number;
}
export const WARM_LIMITS: { webgl2: WarmLimits; webgpu: WarmLimits } = {
  webgl2: { units: 6, groups: 40, minMs: 50, maxMs: 250 },
  webgpu: { units: 40, groups: 4, minMs: 50, maxMs: 250 },
};

export interface SiteWarmInfo {
  total: number; warmed: number; signatures: number; left: number; frames: number; budget: number; units: number;
  /** wall ms per cost unit; the cheapest warm frame's wall ms; the longest JS render of a warm frame; the longest
   *  warm frame wall time (render + the GPU / driver time charged to it) */
  perUnitMs: number; baseMs: number; maxFrameMs: number; maxWallMs: number;
  /** most units / groups one frame took; calibration frames drawn (they force nothing) */
  maxUnits: number; maxGroups: number; calibrations: number;
  renderMs: number; wallMs: number; done: boolean; pending: number; limits: WarmLimits;
}

export interface SiteWarm {
  /** warm the current level (resume / no-op when already warm); resolves when done or after maxMs (paused) */
  run(maxMs: number, onProgress?: (k: number) => void): Promise<SiteWarmResult>;
  /** before the frame's render: force this frame's batch; true = draw this frame (with the warm beams) */
  begin(): boolean;
  /** right after the render: restore every forced object, adapt the batch size, settle runs */
  end(renderMs: number): void;
  /** a run is pending (other warm-ups and auto quality wait) */
  active(): boolean;
  info(): SiteWarmInfo;
}

const isInst = (m: THREE.Object3D) => (m as THREE.InstancedMesh).isInstancedMesh === true;

/** shader signature of a mesh: meshes with the same one share every node build, program and pipeline */
export function warmSignature(m: THREE.Mesh): string {
  if (isInst(m)) return `I:${m.uuid}`;
  const mats = Array.isArray(m.material) ? m.material : [m.material];
  const g = m.geometry;
  let layout = '';
  for (const k of Object.keys(g.attributes).sort()) {
    const a = g.attributes[k] as THREE.BufferAttribute;
    layout += `${k}${a.itemSize}${a.normalized ? 'n' : ''},`;
  }
  layout += `${g.index ? 'i' : ''}:${Object.keys(g.morphAttributes).length}`;
  return `${mats.map((x) => x?.uuid ?? '-').join('+')}|${layout}|${m.castShadow ? 'C' : ''}${m.receiveShadow ? 'R' : ''}|${m.layers.mask}`;
}

/** a forced object's flags (mask only: an isolated mesh keeps whatever visibility other systems give it mid-frame) */
interface Saved { o: THREE.Object3D; visible: boolean; frustumCulled: boolean; mask: number; maskOnly: boolean }
interface Waiter { res: (r: SiteWarmResult) => void; until: number; onProgress?: (k: number) => void }

export function createSiteWarm(deps: SiteWarmDeps): SiteWarm {
  let root: THREE.Object3D | null = null;
  let key: unknown = undefined;
  let keyed = false;
  let seen = new WeakSet<THREE.Object3D>();
  let queue: THREE.Mesh[][] = [];
  let qi = 0;
  let total = 0, warmed = 0, sigs = 0, frames = 0, renderMs = 0;
  let startedAt = 0, wallMs = -1;
  let done = false;
  /** a warm frame's fixed cost (wall ms of a calibration frame: nothing forced); wall ms per cost unit; units for
   *  this frame */
  let base = 0, perUnit = 40, budget = 1;
  let taken = 0, units = 0, unitsAll = 0, maxFrame = 0, maxWall = 0, maxUnitsFrame = 0, maxGroupsFrame = 0;
  /** begin() of the last warm frame (0 = the last frame was no warm frame) and the units it took */
  let lastBegin = 0, lastUnits = 0;
  /** a calibration frame is due (run start, class change) / this frame is one */
  let calibDue = true, calibFrame = false, lastCalib = false, calibs = 0;
  /** class of the last batch (1 = instanced, 0 = plain meshes, -1 = none yet): a new class re-learns its cost */
  let cls = -1;
  let mats = new WeakSet<THREE.Material>();
  const saved: Saved[] = [];
  let waiters: Waiter[] = [];

  const limits = (): WarmLimits => { try { return deps.limits?.() ?? WARM_LIMITS.webgl2; } catch { return WARM_LIMITS.webgl2; } };
  const save = (o: THREE.Object3D, maskOnly = false) => { saved.push({ o, visible: o.visible, frustumCulled: o.frustumCulled, mask: o.layers.mask, maskOnly }); };
  const restore = () => {
    for (let i = saved.length - 1; i >= 0; i--) {
      const s = saved[i];
      s.o.layers.mask = s.mask;
      if (s.maskOnly) continue;
      s.o.visible = s.visible;
      s.o.frustumCulled = s.frustumCulled;
    }
    saved.length = 0;
  };
  const reset = (r: THREE.Object3D) => {
    root = r;
    key = deps.version();
    keyed = true;
    seen = new WeakSet();
    mats = new WeakSet();
    queue = [];
    qi = 0;
    total = warmed = sigs = frames = 0;
    renderMs = unitsAll = maxFrame = maxWall = maxUnitsFrame = maxGroupsFrame = 0;
    startedAt = deps.now();
    wallMs = -1;
    done = false;
    budget = 1;
    cls = -1;
    calibDue = true;
  };
  /** every level mesh but `keep` leaves all layers for this frame (restored by restore()) */
  const isolate = (keep: Set<THREE.Object3D> | null) => {
    root?.traverse((o) => {
      if (!(o as THREE.Mesh).isMesh || keep?.has(o) || o.layers.mask === 0) return;
      save(o, true);
      o.layers.mask = 0;
    });
  };
  const matsOf = (m: THREE.Mesh) => (Array.isArray(m.material) ? m.material : [m.material]);
  /** compile cost estimate of a group (see the header) */
  const unitsOf = (g: THREE.Mesh[]): number => {
    const m0 = g[0];
    let n = isInst(m0) ? 1 : 0;
    for (const x of matsOf(m0)) if (x && !mats.has(x)) n++;
    return Math.max(0.15, n * (m0.castShadow ? 1.5 : 1));
  };
  /** queue the meshes not seen yet, grouped by signature: instanced batches first (each has its own shaders) */
  const collect = (): number => {
    if (!root) return 0;
    const by = new Map<string, THREE.Mesh[]>();
    let n = 0;
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || seen.has(m)) return;
      seen.add(m);
      if (deps.skip(m)) return;
      const s = warmSignature(m);
      let g = by.get(s);
      if (!g) { g = []; by.set(s, g); }
      g.push(m);
      n++;
    });
    const groups = [...by.values()];
    groups.sort((a, b) => Number(isInst(b[0])) - Number(isInst(a[0])));
    for (const g of groups) queue.push(g);
    total += n;
    return n;
  };
  const attached = (o: THREE.Object3D) => {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p === root) return true;
    return false;
  };
  const result = (ok: boolean): SiteWarmResult => ({
    done: ok, ms: Math.round(wallMs >= 0 ? wallMs : deps.now() - startedAt), frames, meshes: warmed, signatures: sigs, left: Math.max(0, queue.length - qi), total,
  });
  const finish = (ok: boolean) => {
    if (ok) { done = true; if (wallMs < 0) wallMs = deps.now() - startedAt; }
    const w = waiters;
    waiters = [];
    for (const x of w) { x.onProgress?.(1); x.res(result(ok)); }
  };
  /** runs whose time is up resolve { done: false } (paused: the next run resumes) */
  const settleLate = () => {
    const now = deps.now();
    if (!waiters.some((w) => now >= w.until)) return;
    const late = waiters.filter((w) => now >= w.until);
    waiters = waiters.filter((w) => now < w.until);
    for (const w of late) w.res(result(false));
  };
  /** the level root / version moved on: start over on the current one (true = there is a level) */
  const sync = (): boolean => {
    const r = deps.root();
    if (!r) return false;
    if (r !== root || !keyed || deps.version() !== key) { reset(r); collect(); }
    return true;
  };

  return {
    run(maxMs, onProgress) {
      if (!sync()) return Promise.resolve({ done: true, ms: 0, frames: 0, meshes: 0, signatures: 0, left: 0, total: 0 });
      // anything added since (a late prop batch, an item): queued now; nothing left = already warm
      if (qi >= queue.length && !collect()) { done = true; if (wallMs < 0) wallMs = deps.now() - startedAt; return Promise.resolve(result(true)); }
      done = false;
      return new Promise<SiteWarmResult>((res) => { waiters.push({ res, until: deps.now() + Math.max(0, maxMs), onProgress }); });
    },
    begin() {
      if (saved.length) restore(); // a frame that never reached end()
      taken = 0;
      units = 0;
      const now = deps.now();
      // v1.3 (3c): charge the previous warm frame its whole interval (render + the GPU / driver work it caused), then
      // size this frame's batch from it
      const prev = lastBegin, prevUnits = lastUnits, prevCalib = lastCalib;
      lastBegin = 0;
      lastUnits = 0;
      lastCalib = false;
      calibFrame = false;
      if (!waiters.length) return false;
      settleLate(); // never a warm frame past a caller's time limit (its screen may be gone)
      if (!waiters.length) return false;
      if (!sync()) { finish(true); return false; }
      if (qi >= queue.length && !collect()) { finish(true); return false; }
      const lim = limits();
      if (prev > 0) {
        const wall = Math.max(0, now - prev);
        if (prevCalib) base = wall;
        else if (prevUnits > 0) {
          maxWall = Math.max(maxWall, wall);
          // a cheaper real frame than the calibration (something compiled under it): the better estimate
          base = base > 0 ? Math.min(base, wall) : wall;
          perUnit = perUnit * 0.5 + Math.max(0.5, (wall - base) / Math.max(0.15, prevUnits)) * 0.5;
          const target = base + Math.min(lim.maxMs, Math.max(lim.minMs, 2 * base));
          budget = Math.max(1, Math.min(lim.units, budget * 1.5 + 1, (target - base) / perUnit));
        }
      }
      const first = isInst(queue[qi][0]) ? 1 : 0;
      if (first !== cls) { cls = first; budget = 1; perUnit = Math.max(perUnit, 40); calibDue = true; }
      if (calibDue) {
        // calibration: a warm frame that forces nothing (only what is not level geometry draws) measures the fixed
        // cost the next batches are paced against
        calibDue = false;
        calibFrame = lastCalib = true;
        calibs++;
        lastBegin = now;
        isolate(null);
        return true;
      }
      const batch = new Set<THREE.Object3D>();
      while (qi < queue.length) {
        const g = queue[qi];
        const cu = unitsOf(g);
        if (taken > 0 && (units + cu > budget || taken >= lim.groups || (isInst(g[0]) ? 1 : 0) !== cls)) break;
        for (const m of g) if (attached(m)) { batch.add(m); for (const x of matsOf(m)) if (x) mats.add(x); }
        units += cu;
        qi++;
        taken++;
      }
      if (!batch.size) return false;
      lastBegin = now;
      lastUnits = units;
      maxUnitsFrame = Math.max(maxUnitsFrame, units);
      maxGroupsFrame = Math.max(maxGroupsFrame, taken);
      const forced = new Set<THREE.Object3D>();
      for (const m of batch) {
        save(m);
        m.visible = true;
        m.frustumCulled = false;
        for (let p = m.parent; p && p !== root; p = p.parent) {
          if (p.visible || forced.has(p)) continue;
          forced.add(p);
          save(p);
          p.visible = true;
        }
      }
      // v1.3 (2c) isolation: only the batch draws. EVERY other level mesh leaves all layers this frame (v1.2 did this
      // only under the groups the batch forced visible, so the first warm frame also drew + compiled the whole view
      // around the camera: 27-54 pipelines in one frame in the lane, with a 1-unit budget)
      isolate(batch);
      warmed += batch.size;
      sigs += taken;
      return true;
    },
    end(ms) {
      if (saved.length) restore();
      if (calibFrame) { calibFrame = false; return; }
      if (!taken) return;
      frames++;
      renderMs += ms;
      unitsAll += units;
      maxFrame = Math.max(maxFrame, ms);
      taken = 0;
      const prog = total ? warmed / total : 1;
      for (const w of waiters) w.onProgress?.(prog);
      if (qi >= queue.length && !collect()) { finish(true); return; }
      settleLate();
    },
    active: () => waiters.length > 0,
    info: () => ({
      total, warmed, signatures: sigs, left: Math.max(0, queue.length - qi), frames, budget: +budget.toFixed(2), units: +unitsAll.toFixed(1),
      perUnitMs: +perUnit.toFixed(1), baseMs: +base.toFixed(1), maxFrameMs: Math.round(maxFrame), maxWallMs: Math.round(maxWall),
      maxUnits: +maxUnitsFrame.toFixed(2), maxGroups: maxGroupsFrame, calibrations: calibs,
      renderMs: Math.round(renderMs), wallMs: Math.round(wallMs >= 0 ? wallMs : startedAt ? deps.now() - startedAt : 0), done, pending: waiters.length,
      limits: limits(),
    }),
  };
}
