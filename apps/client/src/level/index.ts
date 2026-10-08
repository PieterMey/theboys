// Owner: track ② Level (v1.2: env-world). Builds the 3D level from world.layout whenever it changes and provides the
// 'level' service: layout, edge grid, roomAt, visibleSpaces (DunGen-style BFS through open doors, depth 3), fixtures
// for ③'s light pool, door state + animation, item -> Object3D registry; v1.2 (LevelServiceV12, level/api.ts): van
// stations + named parts + upgrades, openable containers, lore pages, quiet door easing + rattles, floor surfaces,
// movable prop handles and the mirror registry.
// Lights are NOT created here (③ Render owns light pools); only emissive meshes.
import * as THREE from 'three/webgpu';
import type { ClientContext } from '../core/context.ts';
import { SYS } from '../core/loop.ts';
import type { LayoutItem, LevelLayout } from '@dead-air/shared/layout.ts';
import { buildEdgeGrid, spaceLinks } from '@dead-air/shared/nav/index.ts';
import type { DoorOpenFn, EdgeGrid, SpaceLink } from '@dead-air/shared/nav/index.ts';
import { verifyLayoutHash } from '@dead-air/shared/procgen/hash.ts';
import { stationsOf } from '@dead-air/shared/procgen/van.ts';
import type { Station, StationKind } from '@dead-air/shared/procgen/van.ts';
import * as ContainersMod from '@dead-air/shared/procgen/containers.ts';
import type { ContainerInfo, ContainerPart } from '@dead-air/shared/procgen/containers.ts';
import { loreSpotsOf } from '@dead-air/shared/procgen/lore.ts';
import type { LoreSpot } from '@dead-air/shared/procgen/lore.ts';
import { mirrorsOf } from '@dead-air/shared/procgen/mirrors.ts';
import type { MirrorSpot } from '@dead-air/shared/procgen/mirrors.ts';
import { siteThemeOf, themeFor } from '@dead-air/shared/procgen/themes.ts';
import { LevelMaterials } from './materials.ts';
import { buildLevelGeometry } from './mesher.ts';
import { EASE_RETURN_SPEED, buildDoor, mergeChildrenByMaterial } from './doors.ts';
import type { DoorVisual } from './doors.ts';
import { buildItem } from './props.ts';
import { buildStencils } from './stencils.ts';
import { buildExterior } from './exterior.ts';
import { findPart, loadPropModel, propsPending, setPropRenderer, templateInfo } from './assets.ts';
import type { PropTemplateInfo, TemplatePart } from './assets.ts';
import { PROP_DEFS } from '@dead-air/shared/procgen/decor.ts';

// env-layout's container table (namespace access: tolerant of the table's helpers being renamed mid-round)
const containersOf = (L: LevelLayout): readonly ContainerInfo[] => ContainersMod.containersOf(L);
type PartDefLike = Pick<ContainerPart, 'idx' | 'kind' | 'node' | 'local' | 'size' | 'travel' | 'hinge' | 'authoredOpen'> & { slotLocal?: [number, number, number] };
/** part table of a host prop (container or not: every tool chest closes its authored-open lid) */
function partDefsFor(it: LayoutItem): readonly PartDefLike[] {
  const fn = (ContainersMod as unknown as { containerDefFor?: (it: LayoutItem) => { parts: readonly PartDefLike[] } | null }).containerDefFor;
  try { return fn?.(it)?.parts ?? []; } catch { return []; }
}
import { clutterFor } from '@dead-air/shared/procgen/clutter.ts';
import { makeRng } from '@dead-air/shared/rng.ts';
import { NO_CAST_MATS, clutterParts, fillParts, plainParams, procPartGeometry, procParts, setMaterial, waterSheet } from './setpieces.ts';
import type { Part } from './setpieces.ts';
import { mergeParts } from './geo.ts';
import type { MergeItem } from './geo.ts';
import { ContainerSystem, measuredFloor, partInstanceMatrix, restOf, slotInPart, swingPose } from './containers.ts';
import type { PiecePose } from './containers.ts';
import { applyLorePage, disposeLorePage, drawerPageOffset, loadLoreFont, loreHolderParts, makeLorePage, redrawLorePages } from './lore.ts';
import type { DrawerPageSpec, LorePage } from './lore.ts';
import { MirrorRegistry, makeMirrorGlass, mirrorFrameParts } from './mirrors.ts';
import { buildVan } from './van.ts';
import type { VanBuild } from './van.ts';
import { facadeMat, themeMaterials } from './palettes.ts';
import { SURFACE_KINDS, buildSurfaceGrid, surfaceFromGrid } from './surfaces.ts';
import { decalAtlasSource, decalParts, decalStats, setDecalLoader } from './decals.ts';
import { exitSigns } from './signs.ts';
import type { ExitSign } from './signs.ts';
import type { SurfaceGrid } from './surfaces.ts';
import type { LevelServiceV12, LorePageVisual, PropHandle, SurfaceKind } from './api.ts';
import type { RenderServiceV12 } from '../render/api.ts';

export type V3 = [number, number, number];
export type FixtureState = 'on' | 'off' | 'flicker' | 'broken';
export interface FixtureInfo {
  space: number; pos: V3; state: FixtureState; id: string; kind: string;
  /** v1.2: yaw of directional fixtures (sconce, wall pack, flood, headlight) */
  rot?: number;
  /** v1.2: battery-backed emergency light (ignores blackouts) */
  battery?: boolean;
}

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
  interface ServiceMap { level: LevelService & LevelServiceV12 }
}

const CULL_DEPTH = 3;
/** the v1.1 procedural set pieces (setpieces.ts); every other procedural key is a v1.2 kit (or the bevelled fallback) */
const SETPIECE_KEYS: ReadonlySet<string> = new Set(['server_rack', 'morgue_drawers', 'autopsy_table', 'table', 'pew', 'altar', 'pallet_rack', 'boiler_tank', 'tank', 'counter', 'workbench', 'washer', 'stove', 'pallet_stack', 'plant_table', 'bench', 'filing', 'pipes_wall', 'fire_ext', 'noticeboard', 'clock', 'crucifix']);
/** small wall-mounted items: not worth a shadow-map draw per shadowed light */
const NO_SHADOW_ITEMS = new Set(['switch', 'note', 'intercom', 'keypad', 'vent', 'deposit', 'leave_lever']);
/** named item parts other tracks may animate / restyle: never merged */
const ITEM_KEEP = new Set(['led', 'screen', 'screen0', 'screen1', 'screen2', 'screen3', 'scanner', 'glass', 'toggle', 'glow', 'placeholder']);
/** items whose objects other packages drive (objectives animates the lever handle): always built as item objects */
const VAN_ITEMS = new Set(['console', 'leave_lever', 'deposit', 'mirror']);

/** same generated level (content hash + seed + kind + theme), whatever object it arrived in */
function sameLayout(a: LevelLayout | null, b: LevelLayout | null): boolean {
  return !!a && !!b && a.hash === b.hash && a.seed === b.seed && a.kind === b.kind && a.W === b.W && a.H === b.H && a.theme === b.theme;
}
function safe<T>(fn: () => T, fallback: T, report?: (m: string) => void): T {
  try { return fn(); } catch (e) { report?.(e instanceof Error ? e.message : String(e)); return fallback; }
}
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

/** one GLB furniture / clutter batch: every placement of `key` in `space` */
interface GlbEntry {
  space: number; key: string;
  m: THREE.Matrix4[];
  /** layout item per placement (null for clutter) */
  items: (LayoutItem | null)[];
  /** container host id per placement (only the first copy of a host) */
  cont: (string | null)[];
  /** movable ref per placement ('prop:12' | 'clutter:7' | null) */
  refs: (string | null)[];
  clutter: boolean;
  /** created instanced meshes: body meshes use instance = placement; part meshes map placement -> instances */
  body: THREE.InstancedMesh[];
  parts: { im: THREE.InstancedMesh; slots: { i: number; index: number; base: THREE.Matrix4 }[] }[];
  tpl: THREE.Object3D | null;
}
interface ShapeGroup { geo: THREE.BufferGeometry; material: THREE.Material; members: TemplatePart[] }
const shapeCache = new WeakMap<PropTemplateInfo, ShapeGroup[]>();
/** template parts grouped by identical (centred) geometry: same-size drawers share one instanced geometry */
function partShapes(info: PropTemplateInfo): ShapeGroup[] {
  const hit = shapeCache.get(info);
  if (hit) return hit;
  const out: ShapeGroup[] = [];
  for (const p of info.parts) {
    const g = p.geometry.clone().translate(-p.centre.x, -p.centre.y, -p.centre.z);
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const match = out.find((s) => {
      if (s.material !== p.material) return false;
      const sp = s.geo.getAttribute('position') as THREE.BufferAttribute;
      if (sp.count !== pos.count) return false;
      for (let i = 0; i < pos.count; i += Math.max(1, Math.floor(pos.count / 64))) {
        if (Math.abs(sp.getX(i) - pos.getX(i)) > 0.002 || Math.abs(sp.getY(i) - pos.getY(i)) > 0.002 || Math.abs(sp.getZ(i) - pos.getZ(i)) > 0.002) return false;
      }
      return true;
    });
    if (match) { match.members.push(p); g.dispose(); } else out.push({ geo: g, material: p.material, members: [p] });
  }
  shapeCache.set(info, out);
  return out;
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
  let propStats = { furniture: 0, clutter: 0, staticMeshes: 0, instancedMeshes: 0, glbPlacements: 0, partMeshes: 0, containers: 0, lore: 0, mirrors: 0, kits: 0, decals: 0, exitSigns: 0 };
  // ---- v1.2 state (rebuilt with the layout)
  const containers = new ContainerSystem();
  containers.enabled = ctx.flags.containers !== false;
  const lorePages = new Map<string, LorePage>();
  let loreList: readonly LoreSpot[] = [];
  const mirrorReg = new MirrorRegistry();
  let van: VanBuild | null = null;
  let vanStats = { meshes: 0, visible: 0 };
  let stationList: Station[] = [];
  const stationObjs = new Map<StationKind, THREE.Object3D>();
  let vanUpgrades = new Set<string>();
  let surfaces: SurfaceGrid | null = null;
  const glbEntries = new Map<string, GlbEntry>();
  const refIndex = new Map<string, { entry: GlbEntry; i: number }>();
  let prefetchTheme = '';
  let mirrorRetry = 0;
  /** test hook: layout override (theme preview) */
  let themeOverride: string | null = null;

  const renderSvc = () => ctx.services.use('render') as (ReturnType<typeof ctx.services.use<'render'>> & Partial<RenderServiceV12>) | undefined;

  const roomAt = (x: number, z: number) => {
    if (!layout) return -1;
    const cx = Math.floor(x), cz = Math.floor(z);
    if (cx < 0 || cz < 0 || cx >= layout.W || cz >= layout.H) return -1;
    return layout.owner[cz * layout.W + cx];
  };

  // an easing door counts as open from its first frame (doorVersion bumps at the start), so the room behind is drawn
  const linkOpen = (l: SpaceLink) => l.kind === 'fence' || l.kind === 'open' || (l.door >= 0 && (doorState[l.door] === 1 || (doorVis[l.door]?.t ?? 0) > 0.02 || (doorVis[l.door]?.override ?? null) !== null));

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
    for (const p of lorePages.values()) disposeLorePage(p);
    lorePages.clear();
    loreList = [];
    mirrorReg.clear();
    van = null;
    stationObjs.clear();
    stationList = [];
    surfaces = null;
    glbEntries.clear();
    refIndex.clear();
    containers.reset([], () => null);
  };

  const rebuild = (Lin: LevelLayout | null) => {
    const t0 = performance.now();
    // per-phase build time (ms) for diag.level.timing (gate measurements)
    const tm: Record<string, number> = {};
    let tl = t0;
    const lap = (k: string) => { const n = performance.now(); tm[k] = +((tm[k] ?? 0) + n - tl).toFixed(1); tl = n; };
    clear();
    lap('clear');
    const L = Lin && themeOverride ? { ...Lin, theme: themeOverride } : Lin;
    layout = L;
    grid = null;
    links = [];
    cacheKey = '';
    version++;
    if (!L) { ctx.diag.level = { layout: null }; return; }
    if (!themeOverride && !verifyLayoutHash(L)) ctx.reportError(`level: layout hash mismatch for ${L.seed}`);
    const report = (what: string) => (m: string) => ctx.reportError(`level ${what}: ${m}`);
    grid = buildEdgeGrid(L);
    links = spaceLinks(L);
    doorState = new Uint8Array(L.doors.length);
    L.doors.forEach((d, i) => { doorState[i] = d.kind === 'open' || d.initiallyOpen ? 1 : 0; });
    lap('grid');
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
    lap('mesher');
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
    lap('doors');
    // v1.2 derived content (pure, shared with the server): containers, lore spots, mirrors, stations
    const conts = safe(() => containersOf(L), [] as readonly ContainerInfo[], report('containers'));
    loreList = safe(() => loreSpotsOf(L), [] as readonly LoreSpot[], report('lore'));
    const mirrorSpots = safe(() => mirrorsOf(L), [] as MirrorSpot[], report('mirrors'));
    stationList = safe(() => stationsOf(L), [] as Station[], report('stations'));
    containers.reset(conts, (c) => hostMatrixOf(L, c));
    lap('derived');
    // the van (exterior in the lot group, interior + stations in the van space)
    const vanSpace = L.spaces.find((s) => s.type === 'van')?.id ?? null;
    const lot = L.spaces.find((s) => s.open && s.type === 'lot') ?? L.spaces.find((s) => s.open);
    van = safe(() => buildVan(L, mats, { vanSpace }), null, report('van'));
    if (van) {
      (lot ? groups[lot.id] : root).add(van.exterior);
      (vanSpace !== null ? groups[vanSpace] : root).add(van.interior);
      for (const g of van.geometries) disposable.push(g);
      for (const [k, o] of van.stations) stationObjs.set(k, o);
      let n = 0, vis = 0;
      for (const g of [van.exterior, van.interior]) g.traverse((o) => { if ((o as THREE.Mesh).isMesh) { n++; if (o.visible) vis++; } });
      vanStats = { meshes: n, visible: vis };
    }
    // furniture + clutter: static per-space batches (procedural set pieces merged per material, asset models instanced)
    lap('van');
    const statics = buildStatics(L, conts, mirrorSpots, tm);
    tl = performance.now();
    // items
    for (const it of L.items) {
      if (it.kind === 'prop') {
        const key = String(it.data?.prop ?? '');
        // batched (statics), van stations (van.ts), lore holders + decorative mirrors (statics + pages / glass)
        if (PROP_DEFS[key] || van?.itemIds.has(it.id) || it.data?.station !== undefined || key.startsWith('lore_') || it.data?.mirror !== undefined) continue;
      }
      const o = buildItem(it, L, mats);
      if (!o) continue;
      const sub: THREE.Object3D[] = [];
      o.traverse((c) => { if ((c as THREE.Group).isGroup) sub.push(c); });
      for (const grp of sub) for (const mm of mergeChildrenByMaterial(grp, ITEM_KEEP, false)) disposable.push(mm.geometry);
      const casts = !NO_SHADOW_ITEMS.has(it.kind) && !(it.kind === 'mirror' && it.data?.mirror === 'van');
      o.traverse((c) => { const m = c as THREE.Mesh; if (m.isMesh) { m.castShadow = casts; m.receiveShadow = true; } });
      items.set(it.id, o);
      itemSpace.set(it.id, it.space);
      groups[it.space]?.add(o);
    }
    lap('items');
    // item-backed stations (console / leave lever / deposit / hub mirror) + the records board marker
    for (const s of stationList) {
      if (s.virtual || stationObjs.has(s.kind)) continue;
      const o = items.get(s.itemId);
      if (o) { stationObjs.set(s.kind, o); continue; }
      if (s.kind === 'records') {
        const marker = new THREE.Group();
        marker.name = 'station:records';
        marker.position.set(s.x, s.y, s.z);
        marker.rotation.y = s.rot;
        marker.userData.itemId = s.itemId;
        groups[s.space]?.add(marker);
        stationObjs.set('records', marker);
      }
    }
    // the console's scanner screen is part of the scanner upgrade
    const scanner = stationObjs.get('console')?.getObjectByName('scanner');
    if (van && scanner) van.upgrades.set('scanner', [...(van.upgrades.get('scanner') ?? []), scanner]);
    applyUpgrades();
    // mirrors: the van's glass (prop station or the hub's mirror item) + decorative glasses
    const rs = renderSvc();
    for (const vm of van?.mirrors ?? []) mirrorReg.add(rs?.mirrors, vm.glass, { space: vm.space, w: vm.w, h: vm.h, kind: 'van', itemId: vm.itemId, priority: 2 });
    for (const it of L.items) {
      if (it.kind !== 'mirror') continue;
      const glass = items.get(it.id)?.getObjectByName('glass') as THREE.Mesh | undefined;
      if (!glass) continue;
      const w = it.data?.mirror === 'van' ? Number(it.data?.w ?? 0.45) - 0.044 : 0.66, h = it.data?.mirror === 'van' ? Number(it.data?.h ?? 0.9) - 0.044 : 1.4;
      mirrorReg.add(rs?.mirrors, glass, { space: it.space, w, h, kind: 'van', itemId: it.id, priority: 2 });
    }
    let nMirrors = 0;
    for (const m of mirrorSpots) {
      if (m.kind === 'van') continue;
      const { holder, glass } = makeMirrorGlass(m);
      disposable.push(glass.geometry);
      groups[m.space]?.add(holder);
      holder.updateMatrixWorld(true);
      mirrorReg.add(rs?.mirrors, glass, { space: m.space, w: m.w, h: m.h, kind: m.kind, itemId: m.id });
      nMirrors++;
    }
    // lore pages (hidden until the fieldguide sends one); drawer pages lie at their container part's slot
    for (const s of loreList) {
      const page = makeLorePage(s, s.container ? drawerSpecOf(L, s.container, s.part ?? 0) ?? undefined : undefined);
      groups[s.space]?.add(page.holder);
      lorePages.set(s.id, page);
      placeDrawerPage(page);
    }
    void loadLoreFont().then((ok) => { if (ok) redrawLorePages(lorePages.values()); });
    lap('mirrors+lore');
    // stencils
    // (stencil planes and exterior meshes are per-layout geometry too; their textures/materials are cached and kept)
    for (const st of buildStencils(L)) { groups[st.space]?.add(st.mesh); disposable.push(st.mesh.geometry); }
    lap('stencils');
    // exterior (attached to the outdoor lot space)
    if (lot) {
      for (const o of buildExterior(L, geo.fences, mats, { facade: facadeMat(L.theme) }).outdoor) {
        o.traverse((c) => { const m = c as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; disposable.push(m.geometry); } });
        groups[lot.id].add(o);
      }
    }
    lap('exterior');
    // floor surfaces (footsteps): floorSurface per space + puddles / flooded halls as water
    surfaces = safe(() => buildSurfaceGrid(L), null, report('surfaces'));
    // fixtures for ③
    fixtures = L.items.filter((i) => i.kind === 'light').map((i) => ({
      space: i.space, pos: [i.x, i.y ?? L.wallH - 0.04, i.z] as V3, state: String(i.data?.state ?? 'on') as FixtureState,
      id: i.id, kind: String(i.data?.kind ?? 'tube'), rot: i.rot ?? 0, battery: i.data?.battery === true,
    }));
    applyInteractionDoors(true);
    if (debugFlat) root.traverse((o) => { const m = (o as THREE.Mesh).material; for (const mm of Array.isArray(m) ? m : m ? [m] : []) (mm as THREE.Material & { fog?: boolean }).fog = false; });
    lap('tail');
    const ms = performance.now() - t0;
    propStats.containers = conts.length;
    propStats.lore = loreList.length;
    propStats.mirrors = nMirrors;
    ctx.diag.level = {
      kind: L.kind, seed: L.seed, hash: L.hash, theme: L.theme, W: L.W, H: L.H, spaces: L.spaces.length, doors: L.doors.length,
      items: items.size, tris: geo.stats.tris, buildMs: +ms.toFixed(1), fixtures: fixtures.length, props: statics,
      van: vanStats, stations: stationList.map((s) => `${s.kind}${s.virtual ? '*' : ''}`).join(','), timing: tm,
    };
    for (const fn of listeners) {
      try { fn(L); } catch (e) { ctx.reportError(`level onRebuild: ${e instanceof Error ? e.message : e}`); }
    }
  };

  /** where a drawer lore page lies: env-layout's slot of the container part (host-local) and the floor it fits on */
  const drawerSpecOf = (L: LevelLayout, contId: string, idx: number): DrawerPageSpec | null => {
    const it = L.items.find((i) => i.id === contId);
    const p = it ? partDefsFor(it).find((dp) => dp.idx === idx) : undefined;
    if (!it || !p?.slotLocal) return null;
    const slide = p.kind === 'drawer' || p.kind === 'tray' ? Math.min(0.45, Math.max(0, p.travel)) : 0;
    // a counter bay (hinged door): the bay's free floor; drawers / lids: their own footprint
    const width = p.kind === 'door' ? Math.max(0.2, p.size[0] - 0.06) : p.size[0];
    const depth = p.kind === 'door' ? Math.max(0.2, Number(it.data?.d ?? 0.7) - 0.14) : p.size[2];
    return { slotLocal: [...p.slotLocal] as [number, number, number], slide, width, depth };
  };
  /** drawer pages behind hinged doors / lids lie still in the host frame: placed once (riding pages follow per frame) */
  const placeDrawerPage = (p: LorePage) => {
    if (!p.drawerOffset || p.follow || !p.spot.container) return;
    const host = containers.host(p.spot.container);
    if (!host) return;
    p.holder.matrix.multiplyMatrices(host, p.drawerOffset);
    p.holder.matrixWorldNeedsUpdate = true;
  };
  /** a GLB host's template arrived: lift its drawer pages onto the measured part floor (some models carry a raised
   *  drawer bottom above env-layout's slot height, a tool chest's tray sits over its drawers) */
  const liftDrawerPages = (entry: GlbEntry, info: PropTemplateInfo) => {
    for (const p of lorePages.values()) {
      if (!p.drawer || !p.spot.container || !entry.cont.includes(p.spot.container)) continue;
      const it = entry.items[entry.cont.indexOf(p.spot.container)];
      const dp = it ? partDefsFor(it).find((d) => d.idx === (p.spot.part ?? 0)) : undefined;
      if (!dp) continue;
      const floor = measuredFloor(info, dp, p.drawer.slotLocal);
      if (floor === null) continue;
      p.drawerOffset = drawerPageOffset(p.drawer, p.spot.idx, floor, p.drawerOffset ?? undefined);
      placeDrawerPage(p);
    }
  };

  /** host placement (world) of a container: GLB hosts use the instancing transform, procedural ones their item frame */
  const hostMatrixOf = (L: LevelLayout, c: ContainerInfo): THREE.Matrix4 | null => {
    const it = L.items.find((i) => i.id === c.id);
    if (!it) return null;
    const def = PROP_DEFS[String(it.data?.prop ?? '')];
    const y = (it.y ?? 0) - (def?.mount === 'wall' ? def.h / 2 : 0);
    return new THREE.Matrix4().makeRotationY(it.rot ?? 0).setPosition(it.x, def?.proc ? it.y ?? 0 : y, it.z);
  };

  /** furniture + clutter of a layout into per-space static meshes; asset models as InstancedMesh per space + key */
  const buildStatics = (L: LevelLayout, conts: readonly ContainerInfo[], mirrorSpots: readonly MirrorSpot[], tm: Record<string, number> = {}) => {
    const ver = version;
    let tl = performance.now();
    const lap = (k: string) => { const n = performance.now(); tm[k] = +((tm[k] ?? 0) + n - tl).toFixed(1); tl = n; };
    /** static batches per space + material ('vc' = every plain colour material of the space in one mesh) */
    const buckets = new Map<string, { space: number; mat: string; cast: boolean; items: MergeItem[] }>();
    const tmp = new THREE.Matrix4(), tmp2 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), one = new THREE.Vector3(1, 1, 1), pos = new THREE.Vector3();
    let furniture = 0, clutter = 0, placements = 0, kits = 0;
    const contByHost = new Map(conts.map((c) => [c.id, c]));
    const loreByHost = new Map(loreList.filter((s) => s.style !== 'drawer').map((s) => [s.id, s]));
    const mirrorByItem = new Map(mirrorSpots.map((m) => [m.id, m]));
    /** procedural movable parts: per space + part shape, the instances (container id, part idx, base) */
    const procShapes = new Map<string, { space: number; mat: string; geo: THREE.BufferGeometry; entries: { cont: ContainerInfo; part: ContainerPart; base: THREE.Matrix4; pose?: PiecePose }[] }>();
    /** queue parts (item-local, placed by m; prototype parts carry their own matrix) for the one-pass merge; a bucket
     *  casts when any casting item adds a part that may cast (no glass, glows, paper, pulls) */
    const push = (space: number, cast: boolean, parts: Part[], m: THREE.Matrix4 | null) => {
      const base = m ? m.clone() : null; // callers reuse their matrix
      for (const p of parts) {
        const plain = plainParams(mats, p.mat);
        const key = plain ? plain.bucket : p.mat;
        const k = `${space}|${key}`;
        let b = buckets.get(k);
        if (!b) { b = { space, mat: key, cast: false, items: [] }; buckets.set(k, b); }
        if (cast && !NO_CAST_MATS.has(p.mat)) b.cast = true;
        const mm = p.m ? (base ? new THREE.Matrix4().multiplyMatrices(base, p.m) : p.m) : base;
        b.items.push(plain ? { geo: p.geo, m: mm, rgb: plain.rgb, rm: plain.rm } : { geo: p.geo, m: mm });
      }
    };
    const addGlb = (space: number, key: string, m: THREE.Matrix4, meta: { item: LayoutItem | null; cont: string | null; ref: string | null; clutter: boolean }) => {
      const k = `${space}|${key}`;
      let e2 = glbEntries.get(k);
      if (!e2) { e2 = { space, key, m: [], items: [], cont: [], refs: [], clutter: meta.clutter, body: [], parts: [], tpl: null }; glbEntries.set(k, e2); }
      const i = e2.m.length;
      e2.m.push(m);
      e2.items.push(meta.item);
      e2.cont.push(meta.cont);
      e2.refs.push(meta.ref);
      if (!meta.clutter) e2.clutter = false;
      if (meta.ref) refIndex.set(meta.ref, { entry: e2, i });
      placements++;
    };
    for (const it of L.items) {
      if (it.kind !== 'prop') continue;
      const key = String(it.data?.prop ?? '');
      const rot = it.rot ?? 0;
      // van stations are drawn by van.ts (the hub's records noticeboard is plain furniture + a station marker)
      if (it.data?.station !== undefined && key !== 'noticeboard') continue;
      const lore = loreByHost.get(it.id);
      if (lore) {
        tmp.makeRotationY(rot).setPosition(it.x, it.y ?? 1.5, it.z);
        push(it.space, false, loreHolderParts(lore.style, { w: num(it.data?.w), d: num(it.data?.d), h: num(it.data?.h) }), tmp);
        continue;
      }
      const mir = mirrorByItem.get(it.id);
      if (mir) {
        if (mir.kind !== 'van') { tmp.makeRotationY(rot).setPosition(it.x, mir.y, it.z); push(it.space, false, mirrorFrameParts(mir.kind, mir.w, mir.h), tmp); }
        continue;
      }
      const def = PROP_DEFS[key];
      if (!def) continue;
      furniture++;
      const cont = contByHost.get(it.id) ?? null;
      if (def.proc) {
        const host = !!cont;
        const parts = procParts(it, makeRng(`${L.seed}:${it.id}`, 'decor:set'), host ? { host: true, skip: new Set(cont.parts.map((p) => p.idx)) } : {});
        if (!parts) continue;
        const kit = !SETPIECE_KEYS.has(key);
        if (kit) kits++;
        tmp.makeRotationY(rot).setPosition(it.x, it.y ?? 0, it.z);
        // kits cast only when taller than 0.9 m (the clutter rule); the v1.1 set pieces keep solid || h > 1
        push(it.space, kit ? Number(it.data?.h ?? def.h) > 0.9 : def.solid || def.h > 1, parts, tmp);
        const defParts = cont ? partDefsFor(it) : [];
        if (cont) for (const p of cont.parts) {
          const pg = procPartGeometry(key, p, slotInPart(defParts.find((dp) => dp.idx === p.idx)));
          const sk = `${it.space}|${pg.shapeKey}`;
          let sh = procShapes.get(sk);
          if (!sh) { sh = { space: it.space, mat: pg.mat, geo: pg.geo, entries: [] }; procShapes.set(sk, sh); } else pg.geo.dispose();
          sh.entries.push({ cont, part: p, base: new THREE.Matrix4().makeTranslation(p.local[0], p.local[1], p.local[2]) });
          // a piece with its own motion (a morgue door swinging aside): one more instanced shape, same material
          const pc = pg.piece;
          if (pc) {
            const sk2 = `${it.space}|${pc.shapeKey}`;
            let sh2 = procShapes.get(sk2);
            if (!sh2) { sh2 = { space: it.space, mat: pc.mat, geo: pc.geo, entries: [] }; procShapes.set(sk2, sh2); } else pc.geo.dispose();
            const pose = swingPose([p.local[0] + pc.pivot[0], p.local[1] + pc.pivot[1], p.local[2] + pc.pivot[2]], pc.sign, pc.travel, pc.lead);
            sh2.entries.push({ cont, part: p, base: new THREE.Matrix4().makeTranslation(p.local[0] + pc.offset[0], p.local[1] + pc.offset[1], p.local[2] + pc.offset[2]), pose });
          }
        }
      } else {
        const n = Math.max(1, Number(it.data?.n ?? 1));
        const yy = (it.y ?? 0) - (def.mount === 'wall' ? def.h / 2 : 0);
        // rows of asset models (library stacks): n copies along the item's local x, back to back when deep enough
        const w = Number(it.data?.w ?? def.w), d = Number(it.data?.d ?? def.d);
        const per = n > 1 ? Math.max(1, Math.floor((w + 0.05) / def.w)) : 1;
        const doubled = d >= def.d * 1.75;
        let first = true;
        for (let i = 0; i < per; i++) for (const side of doubled ? [1, -1] : [1]) {
          const lx = per > 1 ? -w / 2 + (w / per) * (i + 0.5) : 0;
          const lz = doubled ? side * (def.d / 2 + 0.01) : 0;
          const yaw = rot + (side < 0 ? Math.PI : 0);
          const cx = Math.cos(rot), sx = Math.sin(rot);
          pos.set(it.x + lx * cx + lz * sx, yy, it.z - lx * sx + lz * cx);
          q.setFromEuler(e.set(0, yaw, 0));
          const mm = new THREE.Matrix4().compose(pos, q, one);
          addGlb(it.space, key, mm, { item: it, cont: first ? cont?.id ?? null : null, ref: first && per === 1 && !doubled ? it.id : null, clutter: false });
          first = false;
          if (key === 'shelves' || key === 'desk') push(it.space, false, fillParts(key, makeRng(`${L.seed}:${it.id}:${i}:${side}`, 'decor:fill'), L.spaces[it.space]?.type ?? ''), mm);
        }
      }
    }
    lap('s.furniture');
    // cosmetic clutter (derived from the layout, deterministic)
    const crng = makeRng(`${L.seed}:${L.hash}`, 'decor:clutter-mesh');
    const decalClip = grid ? { grid, wallH: L.wallH } : null;
    const d0 = decalStats.built;
    clutterFor(L).forEach((ci, idx) => {
      clutter++;
      // v1.2 decals: clipped world quads, merged per space under the one shared decal material (no shadows)
      if (ci.kind === 'decal') { push(ci.space, false, decalParts(ci, decalClip), null); return; }
      if (ci.kind === 'glb' && ci.key) {
        pos.set(ci.x, ci.y, ci.z);
        q.setFromEuler(e.set(ci.tip ? Math.PI / 2 : 0, ci.rot, 0, 'YXZ'));
        const m = new THREE.Matrix4().compose(pos, q, one);
        if (ci.tip) m.premultiply(new THREE.Matrix4().makeTranslation(0, 0.28, 0));
        addGlb(ci.space, ci.key, m, { item: null, cont: null, ref: `clutter:${idx}`, clutter: true });
        return;
      }
      push(ci.space, ci.kind === 'pipe', clutterParts(ci, crng), null);
    });
    lap('s.clutter');
    // flooded boiler halls: one dark water sheet over the floor
    for (const s of L.spaces) {
      if (s.type !== 'boiler' || s.rect.w * s.rect.h < 40) continue;
      push(s.id, false, [{ mat: 'water', geo: waterSheet(s.rect.x, s.rect.y, s.rect.w, s.rect.h) }], null);
    }
    // v1.2 EXIT signs over the doors on the way out (shared black + exit-glow materials, merged per space)
    const signs = safe(() => exitSigns(L, links), [] as ExitSign[]);
    for (const sg of signs) push(sg.space, false, sg.parts, sg.m);
    lap('s.signs');
    let staticMeshes = 0;
    for (const b of buckets.values()) {
      const merged = mergeParts(b.items, b.mat === 'vc' || b.mat === 'vcGlass');
      if (!merged.getAttribute('position').count) { merged.dispose(); continue; }
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, setMaterial(mats, b.mat));
      mesh.name = `set:${b.space}:${b.mat}`;
      mesh.castShadow = b.cast;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      groups[b.space]?.add(mesh);
      disposable.push(merged);
      staticMeshes++;
    }
    lap('s.merge');
    // procedural container parts: one InstancedMesh per space + shape (no shadows), bounds taken fully open
    let partMeshes = 0;
    for (const sh of procShapes.values()) {
      const im = new THREE.InstancedMesh(sh.geo, setMaterial(mats, sh.mat), sh.entries.length);
      im.name = `parts:${sh.space}:${sh.mat}`;
      sh.entries.forEach((en, j) => {
        const host = containers.host(en.cont.id) ?? new THREE.Matrix4();
        im.setMatrixAt(j, en.pose ? tmp.multiplyMatrices(host, en.pose(1, tmp2)).multiply(en.base) : partInstanceMatrix(host, en.part, 1, en.base, tmp));
      });
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      sh.entries.forEach((en, j) => containers.addSlot(en.cont.id, en.part.idx, im, j, en.base, en.pose));
      im.castShadow = false;
      im.receiveShadow = true;
      groups[sh.space]?.add(im);
      instanced.push(im);
      disposable.push(sh.geo);
      partMeshes++;
    }
    for (const entry of glbEntries.values()) {
      const { space, key, m } = entry;
      const def = PROP_DEFS[key];
      void loadPropModel(key).then((tpl) => {
        if (version !== ver || !tpl) return;
        entry.tpl = tpl;
        const info = templateInfo(tpl);
        // clutter GLBs cast only when taller than 0.9 m; furniture keeps solid || h > 0.9
        const castShadow = def && !entry.clutter ? def.solid || def.h > 0.9 : (info?.height ?? measureHeight(tpl)) > 0.9;
        const authoredOpen = !!info && entry.items.some((it) => !!it && partDefsFor(it).some((p) => p.authoredOpen));
        const split = !!info && info.parts.length > 0 && (entry.cont.some(Boolean) || authoredOpen);
        const meshes: THREE.Mesh[] = info ? (split ? info.body : info.full()) : templateMeshes(tpl);
        for (const src of meshes) {
          if (Array.isArray(src.material)) continue;
          const im = new THREE.InstancedMesh(src.geometry, src.material, m.length);
          im.name = `glb:${space}:${key}`;
          for (let i = 0; i < m.length; i++) im.setMatrixAt(i, info ? m[i] : tmp.multiplyMatrices(m[i], src.matrixWorld));
          im.instanceMatrix.needsUpdate = true;
          im.computeBoundingSphere();
          im.castShadow = castShadow;
          im.receiveShadow = true;
          if (debugFlat) (im.material as THREE.Material & { fog?: boolean }).fog = false;
          groups[space]?.add(im);
          instanced.push(im);
          entry.body.push(im);
          propStats.instancedMeshes++;
        }
        if (split && info) { buildGlbParts(entry, info); liftDrawerPages(entry, info); }
      });
    }
    lap('s.parts+glb');
    propStats = { ...propStats, furniture, clutter, staticMeshes, instancedMeshes: 0, glbPlacements: placements, partMeshes, kits, decals: decalStats.built - d0, exitSigns: signs.length };
    return propStats;
  };

  /** movable parts of a split GLB batch: one InstancedMesh per part shape; containers animate theirs */
  const buildGlbParts = (entry: GlbEntry, info: PropTemplateInfo) => {
    const tmp = new THREE.Matrix4();
    for (const shape of partShapes(info)) {
      const slots: { i: number; index: number; base: THREE.Matrix4; cont: string | null; part: ContainerPart | null }[] = [];
      for (let i = 0; i < entry.m.length; i++) {
        const it = entry.items[i];
        const contId = entry.cont[i];
        const contInfo = contId ? containers.info(contId) : null;
        const defParts = it ? partDefsFor(it) : [];
        for (const tp of shape.members) {
          const cp = contInfo?.parts.find((p) => p.node && tp.nodes.includes(p.node)) ?? null;
          const dp = cp ?? (defParts.find((p) => p.node && tp.nodes.includes(p.node)) as ContainerPart | undefined) ?? null;
          const base = restOf(dp, new THREE.Matrix4()).multiply(new THREE.Matrix4().makeTranslation(tp.centre.x, tp.centre.y, tp.centre.z));
          slots.push({ i, index: slots.length, base, cont: cp ? contId : null, part: cp });
        }
      }
      if (!slots.length) continue;
      const im = new THREE.InstancedMesh(shape.geo, shape.material, slots.length);
      im.name = `parts:${entry.space}:${entry.key}`;
      for (const s of slots) im.setMatrixAt(s.index, partInstanceMatrix(entry.m[s.i], s.part, s.part ? 1 : 0, s.base, tmp));
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      for (const s of slots) if (s.part && s.cont) containers.addSlot(s.cont, s.part.idx, im, s.index, s.base);
      im.castShadow = false;
      im.receiveShadow = true;
      if (debugFlat) (im.material as THREE.Material & { fog?: boolean }).fog = false;
      groups[entry.space]?.add(im);
      instanced.push(im);
      entry.parts.push({ im, slots: slots.map((s) => ({ i: s.i, index: s.index, base: s.base })) });
      propStats.partMeshes++;
    }
  };

  const applyUpgrades = () => {
    if (!van) return;
    for (const [id, objs] of van.upgrades) for (const o of objs) o.visible = vanUpgrades.has(id);
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
      if (instant) { v.override = null; v.ret = false; v.t = open ? 1 : 0; v.apply(v.t); }
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

  // ---- v1.2 members
  const v12: LevelServiceV12 = {
    stations: () => stationList,
    stationObject: (kind) => stationObjs.get(kind) ?? null,
    setVanUpgrades(ids) { vanUpgrades = new Set(ids); applyUpgrades(); },
    containers: () => containers.containers(),
    setContainerOpen: (id, mask, instant) => containers.setOpen(id, mask, instant),
    containerOpen: (id) => containers.open(id),
    containerAnim: (id, idx) => containers.anim(id, idx),
    setContainerProgress: (id, idx, t) => containers.setProgress(id, idx, t),
    containerPartMatrix: (id, idx, out) => containers.partMatrix(id, idx, out),
    loreSpots: () => loreList,
    setLorePage(id: string, page: LorePageVisual | null) {
      const p = lorePages.get(id);
      if (p) applyLorePage(p, page);
    },
    setDoorProgress(id, t) {
      const v = doorVis[id];
      if (!v || v.speed <= 0) return;
      if (t === null) {
        if (v.override !== null) { v.override = null; v.ret = true; doorVersion++; }
        return;
      }
      if (v.override === null) doorVersion++; // the room behind starts drawing on the first eased frame
      v.override = Math.max(0, Math.min(1, t));
    },
    rattleDoor(id, ms, amp = 1) {
      const v = doorVis[id];
      if (!v || v.kind === 'blocked') return;
      const now = performance.now();
      v.rattle = { t0: now, until: now + Math.max(0, ms), amp: Math.max(0, Math.min(2, amp)) };
    },
    surfaceAt(x, z): SurfaceKind {
      if (!layout) return 'concrete';
      return surfaces ? surfaceFromGrid(surfaces, x, z) : 'concrete';
    },
    propHandle(ref, at) {
      let hit = refIndex.get(ref) ?? null;
      if (!hit && at) {
        const key = at.key.startsWith('prop.') ? at.key.slice(5) : at.key;
        let best = 0.35;
        for (const entry of glbEntries.values()) {
          if (entry.key !== key) continue;
          entry.m.forEach((m, i) => { const d = Math.hypot(m.elements[12] - at.x, m.elements[14] - at.z); if (d < best) { best = d; hit = { entry, i }; } });
        }
      }
      return hit ? makePropHandle(hit.entry, hit.i) : null;
    },
    mirrorOf: (itemId) => mirrorReg.of(itemId),
  };

  /** zero-scale the instance, hand out a movable clone; commit bakes the clone's matrix back into the instances */
  const makePropHandle = (entry: GlbEntry, i: number): PropHandle | null => {
    if (!entry.tpl || !entry.body.length) return null;
    const original = entry.m[i].clone();
    const ver = version;
    const write = (mat: THREE.Matrix4) => {
      for (const im of entry.body) { im.setMatrixAt(i, mat); im.instanceMatrix.needsUpdate = true; }
      for (const p of entry.parts) for (const s of p.slots) if (s.i === i) { p.im.setMatrixAt(s.index, mat === ZERO ? ZERO : new THREE.Matrix4().multiplyMatrices(mat, s.base)); p.im.instanceMatrix.needsUpdate = true; }
    };
    write(ZERO);
    const obj = entry.tpl.clone(true);
    obj.name = `movable:${entry.refs[i] ?? i}`;
    obj.matrixAutoUpdate = true;
    original.decompose(obj.position, obj.quaternion, obj.scale);
    obj.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = false; m.receiveShadow = true; } });
    groups[entry.space]?.add(obj);
    let open = true;
    const finish = (mat: THREE.Matrix4) => {
      if (!open) return;
      open = false;
      obj.removeFromParent();
      if (version !== ver) return;
      entry.m[i].copy(mat);
      write(mat);
      for (const im of entry.body) im.boundingSphere = null;
    };
    return {
      object: obj,
      commit(world) { finish(world); },
      restore() { finish(original); },
    };
  };

  const service: LevelService & LevelServiceV12 = {
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
    ...v12,
  };
  ctx.services.provide('level', service);

  // test-only helpers (screenshots): free camera override + optional debug light
  let camOverride: { p: V3; t: V3 } | null = null;
  const slotMarks: THREE.Object3D[] = [];
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
      ceilings(on: boolean) { for (const id of ['ceiling_tiles', 'ceiling_concrete', 'ceiling_metal', 'wall_insulated'] as const) if (mats.has(id)) mats.get(id).visible = on; },
      door: (id: number) => ({ open: doorState[id] === 1, t: doorVis[id]?.t, override: doorVis[id]?.override ?? null, kind: layout?.doors[id]?.kind, ix: (ctx.world.full as { interaction?: { doors?: Record<number, unknown> } } | null)?.interaction?.doors?.[id] ?? null }),
      /** debug: disable adjacency culling */
      cull(on: boolean) { cullOn = on; },
      /** debug: show / hide the decal meshes (draw-call deltas) */
      decals(on: boolean) { let n = 0; root.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.name.endsWith(':decal')) { o.visible = on; n++; } }); return n; },
      /** debug: a small bright marker at every container's main slot (env-layout's point where searched items lie):
       *  shots check that an opened container shows it from a standing eye */
      slotMarkers(on: boolean) {
        for (const o of slotMarks) o.removeFromParent();
        slotMarks.length = 0;
        if (!on || !layout) return 0;
        const mat = new THREE.MeshBasicNodeMaterial({ color: 0xff3010 });
        const geo = new THREE.BoxGeometry(0.1, 0.07, 0.1).translate(0, 0.035, 0);
        for (const c of containers.containers()) {
          const part = c.parts.find((pp) => pp.idx === c.main);
          if (!part) continue;
          const m = new THREE.Mesh(geo, mat);
          m.name = 'debug:slot';
          m.position.set(part.slot[0], part.slot[1], part.slot[2]);
          groups[c.space]?.add(m);
          slotMarks.push(m);
        }
        return slotMarks.length;
      },
      /** debug: freeze a door mesh at openness t (0..1) without changing its logical state */
      doorPose(id: number, t: number) { const v = doorVis[id]; if (!v) return false; v.t = t; v.open = t >= 0.5; v.apply(t); return true; },
      /** debug: rebuild the current layout with another site theme (palette preview; null = the layout's own) */
      theme(name: string | null) { themeOverride = name; const L = ctx.world.layout; layout = null; rebuild(L); return ctx.diag.level; },
      /** debug: v1.2 service passthrough */
      level: () => service,
      surface: (x: number, z: number) => service.surfaceAt(x, z),
      surfaceKinds: () => SURFACE_KINDS,
      /** debug: renderer counters of the last frame + furniture/clutter batch stats */
      renderInfo() {
        const r = ctx.services.use('three')?.renderer as unknown as { info?: { render?: Record<string, number> } } | undefined;
        const ri = r?.info?.render ?? {};
        let meshes = 0, visible = 0;
        root.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes++; });
        root.traverseVisible((o) => { if ((o as THREE.Mesh).isMesh) visible++; });
        return {
          drawCalls: ri.drawCalls, calls: ri.calls, triangles: ri.triangles, levelMeshes: meshes, levelMeshesVisible: visible, props: propStats,
          van: vanStats, containers: containers.containers().length, lorePages: lorePages.size, mirrors: mirrorReg.count(), mirrorsPending: mirrorReg.hasPending(),
          upgrades: [...vanUpgrades], stations: stationList.map((s) => ({ kind: s.kind, id: s.itemId, virtual: !!s.virtual, object: stationObjs.has(s.kind) })),
          decals: { built: propStats.decals, atlas: decalAtlasSource, clipped: decalStats.clipped, dropped: decalStats.dropped },
        };
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
    // the staged decal atlas + index through the level's KTX2 loader (the procedural atlas shows until then)
    setDecalLoader((key) => mats.texture(key));
    if (ctx.world.layout && ctx.world.layout !== layout) rebuild(ctx.world.layout);
    done();
  });

  /** the active work order's theme: compile its palette while the crew is still in the hub */
  const prefetchOrder = () => {
    const order = (ctx.world.full as { activeOrder?: { siteTheme?: string; siteName?: string } | null } | null)?.activeOrder;
    if (!order) return;
    const theme = themeFor(order.siteTheme ?? (order.siteName ? siteThemeOf(order.siteName) : undefined));
    if (theme === prefetchTheme) return;
    prefetchTheme = theme;
    const three = ctx.services.use('three');
    void mats.prefetch(themeMaterials(theme), three?.scene ?? null, three?.camera ?? null).catch(() => {});
  };

  ctx.world.subscribe(() => {
    const w = ctx.world;
    // every 'phase' event and every (re)connect Welcome carries a freshly decoded copy of the SAME layout (drive keeps
    // the hub, results keep the facility): rebuilding on object identity froze the client for seconds on each of them
    // (shader compiles) and leaked the old door/stencil/prop GPU resources. Rebuild only when the content changes.
    const cur = themeOverride && layout ? { ...layout, theme: (w.layout?.theme ?? layout.theme) } : layout;
    if (w.layout !== layout && !sameLayout(w.layout, cur) && ctx.services.use('three')) { themeOverride = null; rebuild(w.layout); }
    if (w.full !== lastFull) { lastFull = w.full; applyInteractionDoors(false); prefetchOrder(); }
  });

  const _pm = new THREE.Matrix4();
  ctx.registerSystem({
    name: 'level',
    order: SYS.level,
    update(dt) {
      if (!layout) return;
      // door animation: quiet-ease overrides, slow return after a cancelled ease, rattles
      const now = performance.now();
      for (const v of doorVis) {
        if (!v) continue;
        if (v.override !== null) {
          if (v.t !== v.override) { v.t = v.override; v.apply(v.t); }
        } else if (v.speed > 0) {
          const target = v.open ? 1 : 0;
          if (v.t !== target) {
            const sp = v.ret ? Math.min(v.speed, EASE_RETURN_SPEED) : v.speed;
            v.t = target > v.t ? Math.min(1, v.t + dt * sp) : Math.max(0, v.t - dt * sp);
            v.apply(v.t);
            if (v.t === 0 || v.t === 1) { doorVersion++; v.ret = false; }
          } else v.ret = false;
        }
        if (v.rattle) {
          const r = v.rattle;
          if (now >= r.until) { v.rattle = null; v.apply(v.t); }
          else {
            const age = (now - r.t0) / 1000;
            const env = Math.min(1, age * 12) * Math.min(1, (r.until - now) / 120);
            const j = r.amp * env * (0.65 * Math.sin(age * 71) + 0.35 * Math.sin(age * 113 + 1.3));
            v.apply(v.t);
            v.shake(j);
          }
        }
      }
      containers.update(dt);
      // pages lying in drawers ride on the drawer (pages behind doors / lids were placed once)
      for (const p of lorePages.values()) {
        if (!p.drawerOffset || !p.follow || !p.mesh.visible || !p.spot.container) continue;
        if (containers.partMatrix(p.spot.container, p.spot.part ?? 0, _pm)) {
          p.holder.matrix.multiplyMatrices(_pm, p.drawerOffset);
          p.holder.matrixWorldNeedsUpdate = true;
        }
      }
      // mirrors registered before the render mirror service existed
      if (mirrorReg.hasPending() && (mirrorRetry -= dt) <= 0) { mirrorRetry = 0.5; mirrorReg.flush(renderSvc()?.mirrors); }
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

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
/** meshes of a template without the v1.2 split (fallback roots) */
function templateMeshes(tpl: THREE.Object3D): THREE.Mesh[] {
  tpl.updateMatrixWorld(true);
  const out: THREE.Mesh[] = [];
  tpl.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && !Array.isArray(m.material)) out.push(m); });
  return out;
}
function measureHeight(tpl: THREE.Object3D): number {
  const bb = new THREE.Box3().setFromObject(tpl);
  return bb.isEmpty() ? 0 : bb.max.y - bb.min.y;
}
