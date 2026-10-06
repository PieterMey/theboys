// Owner: track ③ Render. Ceiling fixture lights: a fixed pool of unshadowed PointLights (batched by
// DynamicLighting, clamped to the preset max every frame) + instanced emissive emitters and soft halo shells for
// every fixture (fixtures never light the fog, so the glow is faked), plus additive mist cones under the lot lamps.
// Per-kind look: cold green-white fluorescent tubes, warm sodium lot lamps, a sodium wall pack over the entrance,
// a dim warm van cargo light. Power overrides + monster flicker.
import * as THREE from 'three/webgpu';
import { attribute, normalView, positionLocal, positionView, smoothstep } from 'three/tsl';
import type { FixtureInfo, V3 } from './types.ts';

export interface FixtureCfg {
  color: string;
  intensity: number;
  distance: number;
  decay: number;
  halo: number;
  tube: number;
  /** per-kind overrides (tube | lamp | wall | van): colour, intensity multiplier, range, emitter + halo strength */
  kinds?: Record<string, Partial<KindCfg>>;
  /** additive mist cone under lot lamps (0 = off) */
  lampCone?: number;
}

interface KindCfg { color: string; mult: number; distance: number; emit: number; halo: number }

const KIND_DEFAULTS: Record<string, KindCfg> = {
  tube: { color: '#cfeedd', mult: 1, distance: 9, emit: 1, halo: 1 },
  lamp: { color: '#ffb35c', mult: 7.5, distance: 19, emit: 1.6, halo: 0.9 },
  wall: { color: '#ffbf73', mult: 2.2, distance: 11, emit: 1.3, halo: 0.8 },
  van: { color: '#ffe2c0', mult: 0.3, distance: 6, emit: 0.55, halo: 0.25 },
};

/** emitter + halo shape per kind: [emitter scale of the 1.25 x 0.05 x 0.14 tube box], [halo ellipsoid radii], halo y */
const SHAPES: Record<string, { emit: V3; halo: V3; haloY: number; emitY?: number }> = {
  tube: { emit: [1, 1, 1], halo: [1.1, 0.32, 0.45], haloY: -0.06 },
  lamp: { emit: [0.32, 0.3, 3.5], halo: [0.62, 0.3, 0.72], haloY: -0.12 },
  wall: { emit: [0.34, 0.6, 1.4], halo: [0.5, 0.3, 0.38], haloY: -0.08 },
  // the van fixture sits 0.3 m under the cargo roof liner: the lamp panel is mounted on the liner
  van: { emit: [0.48, 0.5, 1.6], halo: [0.55, 0.14, 0.3], haloY: 0.22, emitY: 0.27 },
};

export interface FixturePool {
  lights: THREE.PointLight[];
  /** opts.outdoor: 0 (camera inside the building) .. 1 (lot / van); unshadowed outdoor lights would leak through the facade */
  update(src: { fixtures: FixtureInfo[]; visibleSpaces?: (cam: V3) => Set<number> } | null, cam: THREE.Camera, t: number, opts: { max: number; reduceFlicker: boolean; outdoor?: number }): void;
  setPower(space: number | 'all', on: boolean): void;
  flickerSpace(space: number, ms: number): void;
  litCount(): number;
}

const hash = (n: number) => (((n | 0) * 2654435761) >>> 0) / 4294967296;

/** brightness 0..1 for a fixture at time t (visual only, deterministic per fixture) */
function patternLevel(state: string, idx: number, t: number, strobe: boolean, reduce: boolean): number {
  if (strobe) {
    if (reduce) return 0.25 + 0.2 * Math.sin(t * 3 + idx);
    const h = hash(Math.floor(t * 22) + idx * 131);
    return h < 0.5 ? 0.02 : h < 0.7 ? 0.35 : 1.15;
  }
  if (state === 'on') {
    // faint mains hum + very rare dip
    const dip = hash(Math.floor(t * 3) + idx * 977) < 0.01 ? 0.6 : 1;
    return dip * (0.97 + 0.03 * Math.sin(t * 50 + idx));
  }
  if (state === 'flicker') {
    if (reduce) return 0.55 + 0.15 * Math.sin(t * 1.3 + idx);
    // bursts of buzzing dropouts separated by calm stretches
    const burst = hash(Math.floor(t * 0.7) + idx * 389) < 0.45;
    if (!burst) return hash(Math.floor(t * 2) + idx * 59) < 0.06 ? 0.15 : 0.92;
    const h = hash(Math.floor(t * 16) + idx * 17);
    return h < 0.32 ? 0.03 : h < 0.5 ? 0.45 : 1;
  }
  return 0;
}

const kindOf = (f: FixtureInfo): string => {
  const k = (f as { kind?: string }).kind;
  return k && SHAPES[k] ? k : 'tube';
};

export function createFixturePool(scene: THREE.Scene, cfg: FixtureCfg, poolSize: number): FixturePool {
  const kinds: Record<string, KindCfg> = {};
  for (const k of Object.keys(KIND_DEFAULTS)) kinds[k] = { ...KIND_DEFAULTS[k], ...(k === 'tube' ? { color: cfg.color, distance: cfg.distance } : {}), ...(cfg.kinds?.[k] ?? {}) };
  const kindColor: Record<string, THREE.Color> = Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, new THREE.Color(v.color)]));
  const lights: THREE.PointLight[] = [];
  for (let i = 0; i < poolSize; i++) {
    const l = new THREE.PointLight(kindColor.tube, 0, cfg.distance, cfg.decay);
    l.castShadow = false;
    l.name = `fixture-${i}`;
    l.position.set(0, -400, 0);
    scene.add(l);
    lights.push(l);
  }

  // instanced emitter + halo shell (per-instance brightness + colour in custom attributes; one draw each)
  const tubeGeo = new THREE.BoxGeometry(1.25, 0.05, 0.14);
  const haloGeo = new THREE.SphereGeometry(1, 20, 12);
  const tubeMat = new THREE.MeshBasicNodeMaterial();
  const lvlT = attribute('fixLevel', 'float');
  const colT = attribute('fixColor', 'vec3');
  // HDR: lit emitters bloom; unlit ones keep a faint dead-glass grey so they still read under a flashlight
  tubeMat.colorNode = colT.mul(lvlT.mul(cfg.tube)).add(0.006);
  tubeMat.fog = false;
  const haloMat = new THREE.MeshBasicNodeMaterial();
  haloMat.transparent = true;
  haloMat.depthWrite = false;
  haloMat.blending = THREE.AdditiveBlending;
  haloMat.fog = false;
  const lvlH = attribute('fixLevel', 'float');
  const colH = attribute('fixColor', 'vec3');
  const hk = attribute('fixHalo', 'float');
  const facing = normalView.dot(positionView.normalize().negate()).clamp(0, 1);
  // squared falloff of the facing term: a soft glow that fades into the air, never a hard-rimmed disc
  haloMat.colorNode = colH.mul(smoothstep(0.05, 1.0, facing).pow(2.2).mul(lvlH).mul(hk).mul(cfg.halo));
  haloMat.side = THREE.FrontSide;

  // lot lamp mist cone: apex at the lamp head, opening downwards, additive, brightest near the lamp + at the axis
  const coneH = 6.2;
  const coneGeo = new THREE.ConeGeometry(2.6, coneH, 28, 1, true).translate(0, -coneH / 2, 0);
  const coneMat = new THREE.MeshBasicNodeMaterial();
  coneMat.transparent = true;
  coneMat.depthWrite = false;
  coneMat.blending = THREE.AdditiveBlending;
  coneMat.side = THREE.DoubleSide;
  coneMat.fog = false;
  const lvlC = attribute('fixLevel', 'float');
  const colC = attribute('fixColor', 'vec3');
  const down = positionLocal.y.negate().div(coneH).clamp(0, 1); // 0 at the lamp .. 1 at the ground
  const along = smoothstep(0.0, 0.08, down).mul(down.oneMinus().pow(1.3).mul(0.85).add(0.15));
  const edge = normalView.dot(positionView.normalize().negate()).abs().pow(1.8);
  coneMat.colorNode = colC.mul(along.mul(edge).mul(lvlC).mul(cfg.lampCone ?? 0.05));

  let tubes: THREE.InstancedMesh | null = null;
  let halos: THREE.InstancedMesh | null = null;
  let cones: THREE.InstancedMesh | null = null;
  let levelAttr: THREE.InstancedBufferAttribute | null = null;
  let coneLevel: THREE.InstancedBufferAttribute | null = null;
  let coneIdx: number[] = [];
  let lastList: FixtureInfo[] | null = null;
  const powerSpace = new Map<number, boolean>();
  let powerAll = true;
  const strobeUntil = new Map<number, number>();
  let lit = 0;

  function rebuild(list: FixtureInfo[]) {
    for (const m of [tubes, halos, cones]) if (m) { scene.remove(m); m.dispose(); }
    cones = null;
    const n = Math.max(1, list.length);
    levelAttr = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    levelAttr.setUsage(THREE.DynamicDrawUsage);
    const colors = new Float32Array(n * 3);
    const haloK = new Float32Array(n);
    for (let i = 0; i < list.length; i++) {
      const k = kindOf(list[i]);
      const c = kindColor[k];
      colors.set([c.r * kinds[k].emit, c.g * kinds[k].emit, c.b * kinds[k].emit], i * 3);
      haloK[i] = kinds[k].halo / Math.max(0.05, kinds[k].emit);
    }
    const colorAttr = new THREE.InstancedBufferAttribute(colors, 3);
    const haloAttr = new THREE.InstancedBufferAttribute(haloK, 1);
    const tg = tubeGeo.clone();
    tg.setAttribute('fixLevel', levelAttr);
    tg.setAttribute('fixColor', colorAttr);
    const hg = haloGeo.clone();
    hg.setAttribute('fixLevel', levelAttr);
    hg.setAttribute('fixColor', colorAttr);
    hg.setAttribute('fixHalo', haloAttr);
    tubes = new THREE.InstancedMesh(tg, tubeMat, n);
    halos = new THREE.InstancedMesh(hg, haloMat, n);
    tubes.name = 'fixture-tubes';
    halos.name = 'fixture-halos';
    halos.renderOrder = 9;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    coneIdx = [];
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      const sh = SHAPES[kindOf(f)];
      p.set(f.pos[0], f.pos[1] + (sh.emitY ?? 0), f.pos[2]);
      s.set(...sh.emit);
      tubes.setMatrixAt(i, m.compose(p, q, s));
      s.set(...sh.halo);
      halos.setMatrixAt(i, m.compose(new THREE.Vector3(f.pos[0], f.pos[1] + sh.haloY, f.pos[2]), q, s));
      if (kindOf(f) === 'lamp') coneIdx.push(i);
    }
    if (!list.length) { tubes.count = 0; halos.count = 0; }
    tubes.frustumCulled = false;
    halos.frustumCulled = false;
    scene.add(tubes, halos);
    if (coneIdx.length && (cfg.lampCone ?? 0.05) > 0) {
      coneLevel = new THREE.InstancedBufferAttribute(new Float32Array(coneIdx.length), 1);
      coneLevel.setUsage(THREE.DynamicDrawUsage);
      const cc = new Float32Array(coneIdx.length * 3);
      coneIdx.forEach((li, j) => { const c = kindColor[kindOf(list[li])]; cc.set([c.r, c.g, c.b], j * 3); });
      const cg = coneGeo.clone();
      cg.setAttribute('fixLevel', coneLevel);
      cg.setAttribute('fixColor', new THREE.InstancedBufferAttribute(cc, 3));
      cones = new THREE.InstancedMesh(cg, coneMat, coneIdx.length);
      cones.name = 'fixture-lamp-cones';
      cones.renderOrder = 8;
      cones.frustumCulled = false;
      coneIdx.forEach((li, j) => {
        const f = list[li];
        p.set(f.pos[0], f.pos[1] - 0.02, f.pos[2]);
        s.set(1, Math.max(0.3, f.pos[1] / coneH), 1);
        cones!.setMatrixAt(j, m.compose(p, q, s));
      });
      scene.add(cones);
    } else coneLevel = null;
    lastList = list;
  }

  const camPos = new THREE.Vector3();
  const order: number[] = [];
  return {
    lights,
    litCount: () => lit,
    setPower(space, on) {
      if (space === 'all') {
        powerAll = on;
        if (on) powerSpace.clear();
      } else powerSpace.set(space, on);
    },
    flickerSpace(space, ms) {
      strobeUntil.set(space, performance.now() + ms);
    },
    update(src, cam, t, opts) {
      const list = src?.fixtures ?? [];
      if (list !== lastList) rebuild(list);
      cam.getWorldPosition(camPos);
      const vis = src?.visibleSpaces ? src.visibleSpaces([camPos.x, camPos.y, camPos.z]) : null;
      const now = performance.now();
      const levels = levelAttr ? (levelAttr.array as Float32Array) : null;
      order.length = 0;
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        const powered = powerSpace.has(f.space) ? powerSpace.get(f.space)! : powerAll;
        const strobe = (strobeUntil.get(f.space) ?? 0) > now;
        const lv = powered && (f.state === 'on' || f.state === 'flicker') ? patternLevel(f.state, i, t, strobe, opts.reduceFlicker) : 0;
        if (levels) levels[i] = lv;
        // lot lamps are visible from everywhere outside: always worth a light while lit
        if (lv > 0.001 && (!vis || vis.has(f.space))) order.push(i);
      }
      if (levelAttr) levelAttr.needsUpdate = true;
      if (coneLevel && levels) {
        const cl = coneLevel.array as Float32Array;
        for (let j = 0; j < coneIdx.length; j++) cl[j] = levels[coneIdx[j]];
        coneLevel.needsUpdate = true;
      }
      order.sort((a, b) => {
        const fa = list[a].pos;
        const fb = list[b].pos;
        return (fa[0] - camPos.x) ** 2 + (fa[2] - camPos.z) ** 2 - ((fb[0] - camPos.x) ** 2 + (fb[2] - camPos.z) ** 2);
      });
      const max = Math.min(opts.max, lights.length);
      lit = 0;
      for (let i = 0; i < lights.length; i++) {
        const l = lights[i];
        if (i < max && i < order.length) {
          const idx = order[i];
          const f = list[idx];
          const k = kindOf(f);
          const kc = kinds[k];
          // lamps hang at 6 m and light from just under the head; tubes a little under the ceiling
          l.position.set(f.pos[0], f.pos[1] - (k === 'lamp' ? 0.12 : 0.22), f.pos[2]);
          l.color.copy(kindColor[k]);
          l.distance = kc.distance;
          // no shadows on fixtures: from inside the building the lot lamps / entrance wall pack would light the rooms
          // behind the facade, so they fade with the camera's outdoor factor (their emitters + cones stay lit)
          const out = opts.outdoor ?? 1;
          const gate = k === 'wall' ? out : k === 'lamp' ? 0.3 + 0.7 * out : 1;
          l.intensity = cfg.intensity * kc.mult * gate * (levels ? levels[idx] : 1);
          // keep the batched set constant: always visible, unused = parked at intensity 0
          lit++;
        } else {
          l.intensity = 0;
          l.position.set(0, -400, 0);
        }
      }
    },
  };
}
