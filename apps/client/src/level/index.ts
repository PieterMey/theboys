// Owner: track ② Level (apps/client/src/level/**). Builds the 3D level from world.layout whenever it changes and
// provides the 'level' service: layout, edge grid, roomAt, visibleSpaces (DunGen-style BFS through open doors,
// depth 3), fixtures for ③'s light pool, door state + animation, item -> Object3D registry.
// Lights are NOT created here (③ Render owns light pools); only emissive meshes.
import * as THREE from 'three/webgpu';
import type { ClientContext } from '../core/context.ts';
import { SYS } from '../core/loop.ts';
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import { buildEdgeGrid, spaceLinks } from '@dead-air/shared/nav/index.ts';
import type { DoorOpenFn, EdgeGrid, SpaceLink } from '@dead-air/shared/nav/index.ts';
import { verifyLayoutHash } from '@dead-air/shared/procgen/hash.ts';
import { LevelMaterials } from './materials.ts';
import { buildLevelGeometry } from './mesher.ts';
import { buildDoor, mergeChildrenByMaterial } from './doors.ts';
import type { DoorVisual } from './doors.ts';
import { buildItem } from './props.ts';
import { buildStencils } from './stencils.ts';
import { buildExterior } from './exterior.ts';
import { loadPropModel, propsPending, setPropRenderer } from './assets.ts';
import { PROP_DEFS } from '@dead-air/shared/procgen/decor.ts';
import { clutterFor } from '@dead-air/shared/procgen/clutter.ts';
import { makeRng } from '@dead-air/shared/rng.ts';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clutterParts, fillParts, procParts, setMaterial, waterSheet } from './setpieces.ts';
import type { Part } from './setpieces.ts';

export type V3 = [number, number, number];
export type FixtureState = 'on' | 'off' | 'flicker' | 'broken';
export interface FixtureInfo { space: number; pos: V3; state: FixtureState; id: string; kind: string }

export interface LevelService {
  /** current layout (null before the first welcome) */
  readonly layout: LevelLayout | null;
  /** edge grid of the current layout (collision / nav / LOS); null without a layout */
  readonly grid: EdgeGrid | null;
  /** bumps on every rebuild */
  readonly version: number;
  /** scene root holding all level meshes */
  readonly root: THREE.Group;
  /** space id at world (x, z) or -1 */
  roomAt(x: number, z: number): number;
  /** spaces to draw from a camera position: BFS through open doors / fences, depth 3 (all spaces outside the grid) */
  visibleSpaces(camPos: V3): Set<number>;
  /** ceiling fixtures + lot lamps (states as generated; ③ applies power/flicker on top) */
  readonly fixtures: FixtureInfo[];
  /** set a door's logical state (collision) and animate its mesh (instant = no animation) */
  setDoorOpen(id: number, open: boolean, instant?: boolean): void;
  isDoorOpen(id: number): boolean;
  /** door-state callback for shared nav/collide functions (logical state) */
  readonly doorOpen: DoorOpenFn;
  /** animated 0..1 openness of a door mesh */
  doorAnim(id: number): number;
  /** placeholder Object3D of a layout item ('loot:3', 'lever:0', ...) */
  itemObject(id: string): THREE.Object3D | null;
  /** replace (or remove with null) an item's placeholder; the new object is parented to the item's space group */
  setItemObject(id: string, obj: THREE.Object3D | null): void;
  /** group of a space (for attaching per-space visuals that should cull with it) */
  spaceGroup(space: number): THREE.Group | null;
  /** called after each rebuild */
  onRebuild(fn: (layout: LevelLayout) => void): () => void;
  /** true once surface textures finished loading (or none are available) */
  texturesReady(): boolean;
  /** true once the current layout is fully dressed: textures + every furniture / clutter model loaded (loading screens
   *  can wait for this instead of guessing with frame timing) */
  contentReady(): boolean;
}

declare module '../core/services.ts' {
  interface ServiceMap { level: LevelService }
}

const CULL_DEPTH = 3;
/** small wall-mounted items: not worth a shadow-map draw per shadowed light */
const NO_SHADOW_ITEMS = new Set(['switch', 'note', 'intercom', 'keypad', 'vent', 'deposit', 'leave_lever']);
/** named item parts other tracks may animate / restyle: never merged */
const ITEM_KEEP = new Set(['led', 'screen', 'screen0', 'screen1', 'screen2', 'toggle', 'glow', 'placeholder']);

/** same generated level (content hash + seed + kind), whatever object it arrived in */
function sameLayout(a: LevelLayout | null, b: LevelLayout | null): boolean {
  return !!a && !!b && a.hash === b.hash && a.seed === b.seed && a.kind === b.kind && a.W === b.W && a.H === b.H;
}

export function install(ctx: ClientContext): void {
  const done = ctx.readiness.require('level');
  const mats = new LevelMaterials();
  const root = new THREE.Group();
  root.name = 'level';
  let layout: LevelLayout | null = null;
  let grid: EdgeGrid | null = null;
  let version = 0;
  let links: SpaceLink[][] = [];
  let groups: THREE.Group[] = [];
  let doorVis: (DoorVisual | null)[] = [];
  let doorState = new Uint8Array(0);
  const items = new Map<string, THREE.Object3D>();
  const itemSpace = new Map<string, number>();
  let fixtures: FixtureInfo[] = [];
  const listeners = new Set<(l: LevelLayout) => void>();
  let doorVersion = 0;
  let cacheKey = '';
  let cacheSet = new Set<number>();
  let lastFull: unknown = null;
  const disposable: THREE.BufferGeometry[] = [];
  /** instanced asset props of the current layout (instance buffers freed on rebuild; template geometry is shared) */
  const instanced: THREE.InstancedMesh[] = [];
  let propStats = { furniture: 0, clutter: 0, staticMeshes: 0, instancedMeshes: 0, glbPlacements: 0 };

  const roomAt = (x: number, z: number) => {
    if (!layout) return -1;
    const cx = Math.floor(x), cz = Math.floor(z);
    if (cx < 0 || cz < 0 || cx >= layout.W || cz >= layout.H) return -1;
    return layout.owner[cz * layout.W + cx];
  };

  const linkOpen = (l: SpaceLink) => l.kind === 'fence' || l.kind === 'open' || (l.door >= 0 && (doorState[l.door] === 1 || (doorVis[l.door]?.t ?? 0) > 0.02));

  const visibleSpaces = (cam: V3): Set<number> => {
    if (!layout) return new Set();
    const cx = Math.floor(cam[0]), cz = Math.floor(cam[2]);
    const key = `${cx},${cz},${doorVersion},${version}`;
    if (key === cacheKey) return cacheSet;
    let s0 = roomAt(cam[0], cam[2]);
    const set = new Set<number>();
    if (s0 < 0) {
      // outside the grid (or inside a solid cell such as the van cab): nearest space within 2 m, else everything
      for (let r = 1; r <= 2 && s0 < 0; r++) for (let dz = -r; dz <= r && s0 < 0; dz++) for (let dx = -r; dx <= r && s0 < 0; dx++) s0 = roomAt(cam[0] + dx, cam[2] + dz);
      if (s0 < 0) { layout.spaces.forEach((s) => set.add(s.id)); cacheKey = key; cacheSet = set; return set; }
    }
    set.add(s0);
    let frontier = [s0];
    for (let depth = 0; depth < CULL_DEPTH && frontier.length; depth++) {
      const next: number[] = [];
      for (const s of frontier) for (const l of links[s] ?? []) {
        if (set.has(l.other) || !linkOpen(l)) continue;
        set.add(l.other);
        next.push(l.other);
      }
      frontier = next;
    }
    cacheKey = key;
    cacheSet = set;
    return set;
  };

  const clear = () => {
    for (const g of disposable) g.dispose();
    disposable.length = 0;
    for (const im of instanced) im.dispose();
    instanced.length = 0;
    root.clear();
    groups = [];
    doorVis = [];
    items.clear();
    itemSpace.clear();
    fixtures = [];
  };

  const rebuild = (L: LevelLayout | null) => {
    const t0 = performance.now();
    clear();
    layout = L;
    grid = null;
    links = [];
    cacheKey = '';
    version++;
    if (!L) { ctx.diag.level = { layout: null }; return; }
    if (!verifyLayoutHash(L)) ctx.reportError(`level: layout hash mismatch for ${L.seed}`);
    grid = buildEdgeGrid(L);
    links = spaceLinks(L);
    doorState = new Uint8Array(L.doors.length);
    L.doors.forEach((d, i) => { doorState[i] = d.kind === 'open' || d.initiallyOpen ? 1 : 0; });
    const geo = buildLevelGeometry(L);
    groups = L.spaces.map((s) => {
      const g = new THREE.Group();
      g.name = `space:${s.id}:${s.callsign ?? s.kind}`;
      root.add(g);
      return g;
    });
    for (const [sid, e] of geo.spaces) {
      const mesh = new THREE.Mesh(e.geometry, e.mats.map((m) => mats.get(m)));
      mesh.name = `space-mesh:${sid}`;
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      groups[sid].add(mesh);
      disposable.push(e.geometry);
    }
    // doors
    const doorRoot = new THREE.Group();
    doorRoot.name = 'doors';
    root.add(doorRoot);
    doorVis = L.doors.map((d) => {
      const v = buildDoor(L, d, mats);
      if (v) {
        // door geometry is built per door (never shared): free it with the layout (materials are shared, kept)
        v.group.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; disposable.push(m.geometry); } });
        doorRoot.add(v.group);
      }
      return v;
    });
    // furniture + clutter: static per-space batches (procedural set pieces merged per material, asset models instanced)
    const statics = buildStatics(L);
    // items
    for (const it of L.items) {
      if (it.kind === 'prop' && PROP_DEFS[String(it.data?.prop ?? '')]) continue; // batched above
      const o = buildItem(it, L, mats);
      if (!o) continue;
      const sub: THREE.Object3D[] = [];
      o.traverse((c) => { if ((c as THREE.Group).isGroup) sub.push(c); });
      for (const grp of sub) for (const mm of mergeChildrenByMaterial(grp, ITEM_KEEP, false)) disposable.push(mm.geometry);
      const casts = !NO_SHADOW_ITEMS.has(it.kind);
      o.traverse((c) => { const m = c as THREE.Mesh; if (m.isMesh) { m.castShadow = casts; m.receiveShadow = true; } });
      items.set(it.id, o);
      itemSpace.set(it.id, it.space);
      groups[it.space]?.add(o);
    }
    // stencils
    // (stencil planes and exterior meshes are per-layout geometry too; their textures/materials are cached and kept)
    for (const st of buildStencils(L)) { groups[st.space]?.add(st.mesh); disposable.push(st.mesh.geometry); }
    // exterior (attached to the outdoor lot space)
    const lot = L.spaces.find((s) => s.open && s.type === 'lot') ?? L.spaces.find((s) => s.open);
    if (lot) {
      for (const o of buildExterior(L, geo.fences, mats).outdoor) {
        o.traverse((c) => { const m = c as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; disposable.push(m.geometry); } });
        groups[lot.id].add(o);
      }
    }
    // fixtures for ③
    fixtures = L.items.filter((i) => i.kind === 'light').map((i) => ({
      space: i.space, pos: [i.x, i.y ?? L.wallH - 0.04, i.z] as V3, state: String(i.data?.state ?? 'on') as FixtureState,
      id: i.id, kind: String(i.data?.kind ?? 'tube'),
    }));
    applyInteractionDoors(true);
    if (debugFlat) root.traverse((o) => { const m = (o as THREE.Mesh).material; for (const mm of Array.isArray(m) ? m : m ? [m] : []) (mm as THREE.Material & { fog?: boolean }).fog = false; });
    const ms = performance.now() - t0;
    ctx.diag.level = {
      kind: L.kind, seed: L.seed, hash: L.hash, W: L.W, H: L.H, spaces: L.spaces.length, doors: L.doors.length,
      items: items.size, tris: geo.stats.tris, buildMs: +ms.toFixed(1), fixtures: fixtures.length, props: statics,
    };
    for (const fn of listeners) {
      try { fn(L); } catch (e) { ctx.reportError(`level onRebuild: ${e instanceof Error ? e.message : e}`); }
    }
  };

  /** furniture + clutter of a layout into per-space static meshes; asset models as InstancedMesh per space + key */
  const buildStatics = (L: LevelLayout) => {
    const ver = version;
    const buckets = new Map<string, THREE.BufferGeometry[]>(); // space|mat|cast
    const glb = new Map<string, { space: number; key: string; m: THREE.Matrix4[] }>();
    const tmp = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), one = new THREE.Vector3(1, 1, 1), pos = new THREE.Vector3();
    let furniture = 0, clutter = 0, placements = 0;
    const push = (space: number, cast: boolean, parts: Part[], m: THREE.Matrix4 | null) => {
      for (const p of parts) {
        const k = `${space}|${p.mat}|${cast ? 1 : 0}`;
        let list = buckets.get(k);
        if (!list) { list = []; buckets.set(k, list); }
        const g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
        if (g !== p.geo) p.geo.dispose();
        if (m) g.applyMatrix4(m);
        for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
        if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
        list.push(g);
      }
    };
    const addGlb = (space: number, key: string, m: THREE.Matrix4) => {
      const k = `${space}|${key}`;
      let e2 = glb.get(k);
      if (!e2) { e2 = { space, key, m: [] }; glb.set(k, e2); }
      e2.m.push(m);
      placements++;
    };
    for (const it of L.items) {
      if (it.kind !== 'prop') continue;
      const key = String(it.data?.prop ?? '');
      const def = PROP_DEFS[key];
      if (!def) continue;
      furniture++;
      const rot = it.rot ?? 0;
      if (def.proc) {
        const parts = procParts(it, makeRng(`${L.seed}:${it.id}`, 'decor:set'));
        if (!parts) continue;
        tmp.makeRotationY(rot).setPosition(it.x, it.y ?? 0, it.z);
        push(it.space, def.solid || def.h > 1, parts, tmp);
      } else {
        const n = Math.max(1, Number(it.data?.n ?? 1));
        const yy = (it.y ?? 0) - (def.mount === 'wall' ? def.h / 2 : 0);
        // rows of asset models (library stacks): n copies along the item's local x, back to back when deep enough
        const w = Number(it.data?.w ?? def.w), d = Number(it.data?.d ?? def.d);
        const per = n > 1 ? Math.max(1, Math.floor((w + 0.05) / def.w)) : 1;
        const doubled = d >= def.d * 1.75;
        for (let i = 0; i < per; i++) for (const side of doubled ? [1, -1] : [1]) {
          const lx = per > 1 ? -w / 2 + (w / per) * (i + 0.5) : 0;
          const lz = doubled ? side * (def.d / 2 + 0.01) : 0;
          const yaw = rot + (side < 0 ? Math.PI : 0);
          const cx = Math.cos(rot), sx = Math.sin(rot);
          pos.set(it.x + lx * cx + lz * sx, yy, it.z - lx * sx + lz * cx);
          q.setFromEuler(e.set(0, yaw, 0));
          const mm = new THREE.Matrix4().compose(pos, q, one);
          addGlb(it.space, key, mm);
          if (key === 'shelves' || key === 'desk') push(it.space, false, fillParts(key, makeRng(`${L.seed}:${it.id}:${i}:${side}`, 'decor:fill'), L.spaces[it.space]?.type ?? ''), mm);
        }
      }
    }
    // cosmetic clutter (derived from the layout, deterministic)
    const crng = makeRng(`${L.seed}:${L.hash}`, 'decor:clutter-mesh');
    for (const ci of clutterFor(L)) {
      clutter++;
      if (ci.kind === 'glb' && ci.key) {
        pos.set(ci.x, ci.y, ci.z);
        q.setFromEuler(e.set(ci.tip ? Math.PI / 2 : 0, ci.rot, 0, 'YXZ'));
        const m = new THREE.Matrix4().compose(pos, q, one);
        if (ci.tip) m.premultiply(new THREE.Matrix4().makeTranslation(0, 0.28, 0));
        addGlb(ci.space, ci.key, m);
        continue;
      }
      push(ci.space, ci.kind === 'pipe', clutterParts(ci, crng), null);
    }
    // flooded boiler halls: one dark water sheet over the floor
    for (const s of L.spaces) {
      if (s.type !== 'boiler' || s.rect.w * s.rect.h < 40) continue;
      push(s.id, false, [{ mat: 'water', geo: waterSheet(s.rect.x, s.rect.y, s.rect.w, s.rect.h) }], null);
    }
    let staticMeshes = 0;
    for (const [k, list] of buckets) {
      const [sid, mat, cast] = k.split('|');
      const merged = list.length === 1 ? list[0] : mergeGeometries(list);
      if (list.length > 1) for (const g of list) g.dispose();
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, setMaterial(mats, mat));
      mesh.name = `set:${sid}:${mat}`;
      mesh.castShadow = cast === '1';
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      groups[Number(sid)]?.add(mesh);
      disposable.push(merged);
      staticMeshes++;
    }
    for (const { space, key, m } of glb.values()) {
      const def = PROP_DEFS[key];
      const castShadow = !def || def.solid || def.h > 0.9;
      void loadPropModel(key).then((tpl) => {
        if (version !== ver || !tpl) return;
        tpl.updateMatrixWorld(true);
        tpl.traverse((o) => {
          const src = o as THREE.Mesh;
          if (!src.isMesh || Array.isArray(src.material)) return;
          const im = new THREE.InstancedMesh(src.geometry, src.material, m.length);
          im.name = `glb:${space}:${key}`;
          for (let i = 0; i < m.length; i++) im.setMatrixAt(i, tmp.multiplyMatrices(m[i], src.matrixWorld));
          im.instanceMatrix.needsUpdate = true;
          im.computeBoundingSphere();
          im.castShadow = castShadow;
          im.receiveShadow = true;
          if (debugFlat) (im.material as THREE.Material & { fog?: boolean }).fog = false;
          groups[space]?.add(im);
          instanced.push(im);
          propStats.instancedMeshes++;
        });
      });
    }
    propStats = { furniture, clutter, staticMeshes, instancedMeshes: 0, glbPlacements: placements };
    return propStats;
  };

  const setDoorOpen = (id: number, open: boolean, instant = false) => {
    if (!layout || id < 0 || id >= doorState.length) return;
    const d = layout.doors[id];
    if (d.kind === 'open' || d.kind === 'blocked') return;
    const was = doorState[id] === 1;
    doorState[id] = open ? 1 : 0;
    const v = doorVis[id];
    if (v) {
      v.open = open;
      if (instant) { v.t = open ? 1 : 0; v.apply(v.t); }
    }
    if (was !== open || instant) doorVersion++;
  };

  // fallback door sync from FullState.interaction (the interaction track calls setDoorOpen for live changes)
  const applyInteractionDoors = (instant: boolean) => {
    const full = ctx.world.full as { layout?: LevelLayout | null; interaction?: { doors?: Record<number, { open: boolean; kind?: string }> } | null } | null;
    const ds = full?.interaction?.doors;
    if (!ds || !layout || (full?.layout && full.layout.hash !== layout.hash)) return;
    // ignore a slice that belongs to another layout (kinds must match door by door)
    for (const [k, st] of Object.entries(ds)) if (st.kind !== undefined && layout.doors[Number(k)]?.kind !== st.kind) return;
    for (const [k, st] of Object.entries(ds)) setDoorOpen(Number(k), !!st.open, instant);
  };

  const service: LevelService = {
    get layout() { return layout; },
    get grid() { return grid; },
    get version() { return version; },
    root,
    roomAt,
    visibleSpaces,
    get fixtures() { return fixtures; },
    setDoorOpen,
    isDoorOpen: (id) => doorState[id] === 1,
    doorOpen: (id) => doorState[id] === 1,
    doorAnim: (id) => doorVis[id]?.t ?? (doorState[id] ? 1 : 0),
    itemObject: (id) => items.get(id) ?? null,
    setItemObject(id, obj) {
      const old = items.get(id);
      old?.removeFromParent();
      if (!obj) { items.delete(id); return; }
      items.set(id, obj);
      const sid = itemSpace.get(id);
      if (sid !== undefined && groups[sid]) groups[sid].add(obj);
      else root.add(obj);
    },
    spaceGroup: (s) => groups[s] ?? null,
    onRebuild(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    texturesReady: () => mats.texturesDone,
    contentReady: () => !!layout && mats.texturesDone && propsPending() === 0,
  };
  ctx.services.provide('level', service);

  // test-only helpers (screenshots): free camera override + optional debug light
  let camOverride: { p: V3; t: V3 } | null = null;
  let cullOn = true;
  const debugFlat = ctx.testMode && ctx.params.get('levelLight') === '1';
  if (ctx.testMode) {
    (window as unknown as { __levelDebug?: unknown }).__levelDebug = {
      camera(p: V3 | null, t?: V3) { camOverride = p ? { p, t: t ?? [p[0], p[1], p[2] - 1] } : null; },
      info: () => ctx.diag.level,
      texturesReady: () => mats.texturesDone && propsPending() === 0,
      visible: (p: V3) => [...visibleSpaces(p)],
      setDoorOpen,
      /** debug: hide ceilings (top-down shots) */
      ceilings(on: boolean) { for (const id of ['ceiling_tiles', 'ceiling_concrete', 'ceiling_metal'] as const) mats.get(id).visible = on; },
      door: (id: number) => ({ open: doorState[id] === 1, t: doorVis[id]?.t, kind: layout?.doors[id]?.kind, ix: (ctx.world.full as { interaction?: { doors?: Record<number, unknown> } } | null)?.interaction?.doors?.[id] ?? null }),
      /** debug: disable adjacency culling */
      cull(on: boolean) { cullOn = on; },
      /** debug: freeze a door mesh at openness t (0..1) without changing its logical state */
      doorPose(id: number, t: number) { const v = doorVis[id]; if (!v) return false; v.t = t; v.open = t >= 0.5; v.apply(t); return true; },
      /** debug: renderer counters of the last frame + furniture/clutter batch stats */
      renderInfo() {
        const r = ctx.services.use('three')?.renderer as unknown as { info?: { render?: Record<string, number> } } | undefined;
        const ri = r?.info?.render ?? {};
        let meshes = 0, visible = 0;
        root.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes++; });
        root.traverseVisible((o) => { if ((o as THREE.Mesh).isMesh) visible++; });
        return { drawCalls: ri.drawCalls, calls: ri.calls, triangles: ri.triangles, levelMeshes: meshes, levelMeshesVisible: visible, props: propStats };
      },
    };
  }

  void ctx.services.wait('three').then((three) => {
    three.scene.add(root);
    setPropRenderer(three.renderer);
    if (ctx.testMode && ctx.params.get('levelLight') === '1') {
      // debug only (never in play): flat fill so geometry screenshots are readable without ③'s light pools
      const hemi = new THREE.HemisphereLight(0xd8dde2, 0x504c44, 3.5);
      hemi.name = 'level-debug-light';
      three.scene.add(hemi);
      three.scene.fog = null;
    }
    void mats.upgradeAll(three.renderer).catch((e: unknown) => ctx.reportError(`level textures: ${e instanceof Error ? e.message : e}`));
    if (ctx.world.layout && ctx.world.layout !== layout) rebuild(ctx.world.layout);
    done();
  });

  ctx.world.subscribe(() => {
    const w = ctx.world;
    // every 'phase' event and every (re)connect Welcome carries a freshly decoded copy of the SAME layout (drive keeps
    // the hub, results keep the facility): rebuilding on object identity froze the client for seconds on each of them
    // (shader compiles) and leaked the old door/stencil/prop GPU resources. Rebuild only when the content changes.
    if (w.layout !== layout && !sameLayout(w.layout, layout) && ctx.services.use('three')) rebuild(w.layout);
    if (w.full !== lastFull) { lastFull = w.full; applyInteractionDoors(false); }
  });

  ctx.registerSystem({
    name: 'level',
    order: SYS.level,
    update(dt) {
      if (!layout) return;
      // door animation
      for (const v of doorVis) {
        if (!v || v.speed <= 0) continue;
        const target = v.open ? 1 : 0;
        if (v.t === target) continue;
        v.t = target > v.t ? Math.min(1, v.t + dt * v.speed) : Math.max(0, v.t - dt * v.speed);
        v.apply(v.t);
        if (v.t === 0 || v.t === 1) doorVersion++;
      }
      const three = ctx.services.use('three');
      if (!three) return;
      if (camOverride) {
        three.camera.position.set(...camOverride.p);
        three.camera.lookAt(...camOverride.t);
        three.camera.updateMatrixWorld();
      }
      // adjacency culling
      const cp = three.camera.position;
      const vis = cullOn ? visibleSpaces([cp.x, cp.y, cp.z]) : new Set(layout.spaces.map((s) => s.id));
      for (let i = 0; i < groups.length; i++) groups[i].visible = vis.has(i);
      for (const v of doorVis) if (v) v.group.visible = vis.has(v.spaces[0]) || vis.has(v.spaces[1]);
    },
  });
}
