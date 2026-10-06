// Owner: track ③ Render. TEST-ONLY scene behind ?scene=test (also the idle backdrop before a level exists):
// builds walls/floors/ceilings/props from a LevelLayout fixture (tests/fixtures/layouts/*.json), ceiling fixtures,
// emissive exit signs / Core / suit visor, fake flashlights and named camera views for the stress test.
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { LevelLayout, LayoutDoor } from '@dead-air/shared/layout.ts';
import { makeEmissive, makeSurfaceMaterial } from './materials.ts';
import type { FixtureInfo, FixtureState, FlashlightInfo, V3 } from './types.ts';

export interface TestView {
  name: string;
  cam: V3;
  look: V3;
  /** flashlights for this view (local first) */
  lights: FlashlightInfo[];
  /** power overrides: 'all-off' or list of dark spaces */
  power: { all: boolean; off: number[] };
}

export interface TestScene {
  group: THREE.Group;
  layout: LevelLayout;
  fixtures: FixtureInfo[];
  bounds: THREE.Box3;
  views: Record<string, TestView>;
  update(t: number): void;
}

const T = 0.12; // wall thickness

export async function loadFixtureLayout(name = 'facility_s2_p4'): Promise<LevelLayout | null> {
  const mods = import.meta.glob('../../../../tests/fixtures/layouts/*.json', { import: 'default' });
  const key = Object.keys(mods).find((k) => k.endsWith(`/${name}.json`)) ?? Object.keys(mods)[0];
  if (!key) return null;
  return (await mods[key]()) as LevelLayout;
}

function doorOpen(d: LayoutDoor): boolean {
  return d.kind === 'open' || d.initiallyOpen;
}

export function buildTestScene(L: LevelLayout): TestScene {
  const group = new THREE.Group();
  group.name = 'render-testscene';
  const { W, H, owner } = L;
  const wallH = L.wallH || 3;
  const own = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : owner[y * W + x]);
  const doorV = new Map<string, LayoutDoor>();
  const doorH = new Map<string, LayoutDoor>();
  for (const d of L.doors) for (let i = 0; i < d.len; i++) (d.dir === 'v' ? doorV : doorH).set(d.dir === 'v' ? `${d.x}:${d.y + i}` : `${d.x + i}:${d.y}`, d);

  const walls: THREE.BufferGeometry[] = [];
  const doorsG: THREE.BufferGeometry[] = [];
  const frames: THREE.BufferGeometry[] = [];
  const addBox = (arr: THREE.BufferGeometry[], sx: number, sy: number, sz: number, x: number, y: number, z: number) => {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    g.translate(x, y, z);
    arr.push(g);
  };
  const edge = (a: number, b: number, d: LayoutDoor | undefined, vertical: boolean, x: number, z: number) => {
    if (a === b || (a < 0 && b < 0)) return;
    const [sx, sz] = vertical ? [T, 1] : [1, T];
    if (d) {
      // lintel above the opening
      addBox(walls, sx, wallH - 2.2, sz, x, 2.2 + (wallH - 2.2) / 2, z);
      if (!doorOpen(d)) addBox(doorsG, vertical ? 0.06 : 0.98, 2.18, vertical ? 0.98 : 0.06, x, 1.09, z);
      return;
    }
    addBox(walls, sx, wallH, sz, x, wallH / 2, z);
  };
  for (let y = 0; y < H; y++) for (let x = 0; x <= W; x++) edge(own(x - 1, y), own(x, y), doorV.get(`${x}:${y}`), true, x, y + 0.5);
  for (let x = 0; x < W; x++) for (let y = 0; y <= H; y++) edge(own(x, y - 1), own(x, y), doorH.get(`${x}:${y}`), false, x + 0.5, y);
  // door frames (dark steel posts) for every door opening
  for (const d of L.doors) {
    if (d.dir === 'v') { addBox(frames, 0.2, 2.25, 0.08, d.x, 1.12, d.y); addBox(frames, 0.2, 2.25, 0.08, d.x, 1.12, d.y + d.len); }
    else { addBox(frames, 0.08, 2.25, 0.2, d.x, 1.12, d.y); addBox(frames, 0.08, 2.25, 0.2, d.x + d.len, 1.12, d.y); }
  }

  const floors: THREE.BufferGeometry[] = [];
  const ceils: THREE.BufferGeometry[] = [];
  const trims: THREE.BufferGeometry[] = [];
  for (const s of L.spaces) {
    const { x, y, w, h } = s.rect;
    const f = new THREE.PlaneGeometry(w, h);
    f.rotateX(-Math.PI / 2);
    f.translate(x + w / 2, 0, y + h / 2);
    floors.push(f);
    if (!s.open) {
      const c = new THREE.PlaneGeometry(w, h);
      c.rotateX(Math.PI / 2);
      c.translate(x + w / 2, wallH, y + h / 2);
      ceils.push(c);
      // ceiling beams across long rooms (catch flashlight shadows)
      const long = w >= h;
      const n = Math.floor((long ? w : h) / 3);
      for (let i = 1; i <= n; i++) {
        if (long) addBox(trims, 0.18, 0.22, h, x + (i * w) / (n + 1), wallH - 0.11, y + h / 2);
        else addBox(trims, w, 0.22, 0.18, x + w / 2, wallH - 0.11, y + (i * h) / (n + 1));
      }
    }
  }
  const mWall = makeSurfaceMaterial({ color: 0x8a9286, roughness: 0.86, metalness: 0, grime: 0.8, pattern: 'paint' });
  const mFloor = makeSurfaceMaterial({ color: 0x5a5c55, roughness: 0.42, metalness: 0.05, grime: 0.9, pattern: 'tile' });
  const mCeil = makeSurfaceMaterial({ color: 0x3c3f3c, roughness: 0.95, metalness: 0, grime: 0.5, pattern: 'concrete' });
  const mDoor = makeSurfaceMaterial({ color: 0x4a5a63, roughness: 0.5, metalness: 0.6, grime: 0.6 });
  const mSteel = makeSurfaceMaterial({ color: 0x2b2e30, roughness: 0.38, metalness: 0.85, grime: 0.4 });
  const mCrate = makeSurfaceMaterial({ color: 0x6b5a3e, roughness: 0.8, metalness: 0, grime: 0.7 });
  const mLocker = makeSurfaceMaterial({ color: 0x3f5348, roughness: 0.45, metalness: 0.7, grime: 0.6 });
  const mesh = (geos: THREE.BufferGeometry[], mat: THREE.Material, name: string) => {
    if (!geos.length) return;
    const g = mergeGeometries(geos, false);
    if (!g) return;
    const m = new THREE.Mesh(g, mat);
    m.name = name;
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  };
  mesh(walls, mWall, 'walls');
  mesh(floors, mFloor, 'floors');
  mesh(ceils, mCeil, 'ceilings');
  mesh(doorsG, mDoor, 'doors');
  mesh(frames, mSteel, 'frames');
  mesh(trims, mSteel, 'beams');

  // props: crates for loot, lockers for hiding spots, pipes along corridors
  const loot = L.items.filter((i) => i.kind === 'loot');
  const hide = L.items.filter((i) => i.kind === 'hiding');
  const box = new THREE.BoxGeometry(1, 1, 1);
  box.translate(0, 0.5, 0);
  const inst = (items: typeof loot, mat: THREE.Material, size: V3, name: string) => {
    const im = new THREE.InstancedMesh(box, mat, Math.max(1, items.length));
    im.name = name;
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    items.forEach((it, i) => {
      const s = 0.75 + ((i * 37) % 10) / 20;
      q.setFromEuler(new THREE.Euler(0, (it.rot ?? 0) + ((i * 13) % 7) * 0.12, 0));
      m4.compose(new THREE.Vector3(it.x, 0, it.z), q, new THREE.Vector3(size[0] * s, size[1] * (name === 'lockers' ? 1 : s), size[2] * s));
      im.setMatrixAt(i, m4);
    });
    im.count = items.length;
    im.castShadow = true;
    im.receiveShadow = true;
    group.add(im);
  };
  inst(loot, mCrate, [0.55, 0.45, 0.55], 'crates');
  inst(hide, mLocker, [0.62, 1.95, 0.52], 'lockers');

  // pipes under the ceiling of every corridor (long shadows in flashlight beams)
  const pipes: THREE.BufferGeometry[] = [];
  for (const s of L.spaces) {
    if (s.kind !== 'corridor' || s.open) continue;
    const { x, y, w, h } = s.rect;
    const long = w >= h;
    const len = long ? w : h;
    if (len < 3) continue;
    const g = new THREE.CylinderGeometry(0.07, 0.07, len, 10);
    if (long) g.rotateZ(Math.PI / 2);
    else g.rotateX(Math.PI / 2);
    g.translate(long ? x + w / 2 : x + 0.25, wallH - 0.35, long ? y + 0.25 : y + h / 2);
    pipes.push(g);
  }
  mesh(pipes, mSteel, 'pipes');

  // emissives: EXIT signs over exit doors, the Core, a suit with a visor
  const exitMat = makeEmissive(0x2bff6a, 3.5);
  for (const d of L.doors.filter((dd) => dd.kind === 'exit')) {
    const sign = new THREE.Mesh(new THREE.BoxGeometry(d.dir === 'v' ? 0.06 : 0.55, 0.2, d.dir === 'v' ? 0.55 : 0.06), exitMat);
    sign.position.set(d.dir === 'v' ? d.x : d.x + d.len / 2, 2.45, d.dir === 'v' ? d.y + d.len / 2 : d.y);
    sign.name = 'exit-sign';
    group.add(sign);
  }
  const core = L.items.find((i) => i.kind === 'core');
  if (core) {
    const c = new THREE.Mesh(new THREE.IcosahedronGeometry(0.22, 3), makeEmissive(0xff4a1c, 5));
    c.position.set(core.x, 1.1, core.z);
    c.name = 'core';
    group.add(c);
    const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.32, 0.85, 16), mSteel);
    ped.position.set(core.x, 0.425, core.z);
    ped.castShadow = ped.receiveShadow = true;
    group.add(ped);
  }
  const mannequins = L.items.filter((i) => i.kind === 'spawn_mannequin');
  const suitMat = makeSurfaceMaterial({ color: 0x8a8f86, roughness: 0.65, metalness: 0.1, grime: 0.6 });
  const visorMat = makeEmissive(0x7fd6ff, 3.5);
  for (const m of mannequins) {
    const fig = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 1.0, 6, 14), suitMat);
    body.position.y = 0.85;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 18, 12), suitMat);
    head.position.y = 1.62;
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.06, 0.04), visorMat);
    visor.position.set(0, 1.64, -0.16);
    for (const o of [body, head]) { o.castShadow = true; o.receiveShadow = true; }
    fig.add(body, head, visor);
    fig.position.set(m.x, 0, m.z);
    fig.rotation.y = m.rot ?? 0;
    fig.name = 'suit';
    group.add(fig);
  }

  // fixtures
  const fixtures: FixtureInfo[] = L.items
    .filter((i) => i.kind === 'light')
    .map((i) => ({ space: i.space, pos: [i.x, (i.y ?? wallH - 0.04) - 0.03, i.z] as V3, state: ((i.data?.state as string) ?? L.spaces[i.space]?.light ?? 'on') as FixtureState }));

  const bounds = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(W, wallH + 0.2, H));

  // ---- views for the stress test / screenshots ----
  const sp = L.spaces;
  const len = (s: (typeof sp)[number]) => Math.max(s.rect.w, s.rect.h);
  const corridors = sp.filter((s) => s.kind === 'corridor' && !s.open).sort((a, b) => len(b) - len(a));
  const rooms = sp.filter((s) => (s.kind === 'room' || s.kind === 'hall') && !s.open).sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h);
  const litRoom = rooms.find((s) => s.light === 'on' && fixtures.some((f) => f.space === s.id && f.state === 'on')) ?? rooms[0];
  const bigRoom = rooms[0];
  const views: Record<string, TestView> = {};
  const eye = 1.62;
  const handLight = (cam: V3, look: V3, id = 'me', tier: 1 | 2 = 1): FlashlightInfo => {
    const d = new THREE.Vector3(look[0] - cam[0], look[1] - cam[1], look[2] - cam[2]).normalize();
    const right = new THREE.Vector3().crossVectors(d, new THREE.Vector3(0, 1, 0)).normalize();
    const p = new THREE.Vector3(...cam).addScaledVector(right, 0.22).add(new THREE.Vector3(0, -0.28, 0)).addScaledVector(d, 0.15);
    const aim = new THREE.Vector3(...look).sub(p).normalize();
    return { id, pos: [p.x, p.y, p.z], dir: [aim.x, aim.y, aim.z], on: true, local: id === 'me', tier };
  };
  const remote = (p: V3, look: V3, id: string, tier: 1 | 2 = 2): FlashlightInfo => {
    const aim = new THREE.Vector3(look[0] - p[0], look[1] - p[1], look[2] - p[2]).normalize();
    return { id, pos: p, dir: [aim.x, aim.y, aim.z], on: true, local: false, tier };
  };
  const c0 = corridors[0];
  if (c0) {
    const { x, y, w, h } = c0.rect;
    const long = w >= h;
    const cam: V3 = long ? [x + 0.6, eye, y + h / 2] : [x + w / 2, eye, y + 0.6];
    const look: V3 = long ? [x + w, 1.25, y + h / 2] : [x + w / 2, 1.25, y + h];
    views.corridor = { name: 'corridor', cam, look, lights: [handLight(cam, look)], power: { all: true, off: [c0.id] } };
  }
  if (litRoom) {
    const { x, y, w, h } = litRoom.rect;
    const cam: V3 = [x + 0.7, eye, y + 0.7];
    const look: V3 = [x + w * 0.75, 1.0, y + h * 0.75];
    views.room = { name: 'room', cam, look, lights: [], power: { all: true, off: [] } };
  }
  if (bigRoom) {
    const { x, y, w, h } = bigRoom.rect;
    const cam: V3 = [x + w / 2, eye, y + h - 0.6];
    const meet: V3 = [x + w / 2, 0.6, y + h * 0.3];
    const a: V3 = [x + w * 0.28, 1.45, y + h * 0.72];
    const b: V3 = [x + w * 0.72, 1.45, y + h * 0.66];
    views.crossing = {
      name: 'crossing', cam, look: [x + w / 2, 1.2, y],
      lights: [remote(a, [meet[0] + 1.2, meet[1], meet[2]], 'p2', 2), remote(b, [meet[0] - 1.2, meet[1], meet[2] - 0.4], 'p3', 1)],
      power: { all: true, off: [bigRoom.id] },
    };
  }
  const c1 = corridors[1] ?? corridors[0];
  if (c1) {
    const { x, y, w, h } = c1.rect;
    const long = w >= h;
    const cam: V3 = long ? [x + w - 0.6, eye, y + h / 2] : [x + w / 2, eye, y + h - 0.6];
    const look: V3 = long ? [x, 1.1, y + h / 2] : [x + w / 2, 1.1, y];
    const mate: V3 = long ? [x + w * 0.55, 1.4, y + h / 2 + 0.4] : [x + w / 2 + 0.4, 1.4, y + h * 0.55];
    views.blackout = { name: 'blackout', cam, look, lights: [handLight(cam, look), remote(mate, [look[0], 0.4, look[2]], 'p2', 2)], power: { all: false, off: [] } };
  }
  // six-flashlight stress view: every slot used in one room
  if (bigRoom) {
    const { x, y, w, h } = bigRoom.rect;
    const cam: V3 = [x + 0.6, eye, y + 0.6];
    const look: V3 = [x + w, 1.0, y + h];
    const L6: FlashlightInfo[] = [handLight(cam, look)];
    for (let i = 0; i < 5; i++) {
      const px = x + w * (0.3 + 0.1 * i);
      const pz = y + h * (0.72 - 0.08 * i);
      L6.push(remote([px, 1.4, pz], [x + w * (1 - 0.18 * i), 0.3, y + h * (0.15 + 0.15 * i)], `p${i + 2}`, (i % 2 ? 1 : 2) as 1 | 2));
    }
    views.six = { name: 'six', cam, look, lights: L6, power: { all: true, off: [] } };
  }

  // emissive check: the Core on its pedestal (bloom), lit only by a teammate's flashlight
  if (core) {
    const sp0 = L.spaces[core.space];
    const cx = sp0 ? sp0.rect.x + sp0.rect.w / 2 : core.x + 2;
    const cz = sp0 ? sp0.rect.y + sp0.rect.h / 2 : core.z + 2;
    let dx = cx - core.x;
    let dz = cz - core.z;
    if (Math.hypot(dx, dz) < 0.5) { dx = 1; dz = 0.6; }
    const dl = Math.hypot(dx, dz);
    const cam: V3 = [core.x + (dx / dl) * 2.6, 1.5, core.z + (dz / dl) * 2.6];
    const look: V3 = [core.x, 1.0, core.z];
    views.core = { name: 'core', cam, look, lights: [handLight(cam, [core.x + 0.8, 0.2, core.z + 0.5])], power: { all: false, off: [] } };
  }
  const exit = L.doors.find((dd) => dd.kind === 'exit');
  if (exit) {
    const sx = exit.dir === 'v' ? exit.x : exit.x + exit.len / 2;
    const sz = exit.dir === 'v' ? exit.y + exit.len / 2 : exit.y;
    // stand on the indoor side of the exit door, 4 m back
    const indoor = [exit.a, exit.b].filter((id) => id >= 0 && L.spaces[id] && L.spaces[id].kind !== 'outside');
    const inside = (ox: number, oz: number) => indoor.includes(own(Math.floor(ox), Math.floor(oz)));
    const cands: V3[] = exit.dir === 'v'
      ? [[sx - 2.5, 1.6, sz], [sx + 2.5, 1.6, sz], [sx - 1.2, 1.6, sz], [sx + 1.2, 1.6, sz]]
      : [[sx, 1.6, sz - 2.5], [sx, 1.6, sz + 2.5], [sx, 1.6, sz - 1.2], [sx, 1.6, sz + 1.2]];
    const cam = cands.find((c) => inside(c[0], c[2])) ?? cands[0];
    views.exit = { name: 'exit', cam, look: [sx, 1.9, sz], lights: [handLight(cam, [sx, 0.9, sz])], power: { all: false, off: [] } };
  }

  return {
    group,
    layout: L,
    fixtures,
    bounds,
    views,
    update(t) {
      const c = group.getObjectByName('core');
      if (c) c.rotation.y = t * 0.6;
    },
  };
}
