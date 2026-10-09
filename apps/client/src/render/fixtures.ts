// Owner: track ③ Render / env-render (v1.2). Fixture lights: "light from above".
// - A fixed pool of unshadowed, map-less SpotLights (batched by DynamicLighting) aimed per kind: tubes, lamps, bulbs,
//   high bays and LED strips point down (the ceiling stays darker than the walls), wall packs and sconces aim by
//   their rot, floods and headlights forward. Targets live in the scene (the batched spot data reads
//   target.matrixWorld and scene.matrixWorldAutoUpdate is off).
// - A small omni PointLight sub-pool for the nearest candles and bare bulbs.
// - Instanced emissive emitters + soft halo shells (halo strength scales with the local mist) + additive mist cones
//   under lot lamps.
// - Per-fixture levels (fixtureLevels()) = state pattern x power x curves x brownout. Curves: die, surge_die, brown,
//   pulse, revive (paranormal dark walk, director). No strobes except flickerSpace (the Listener telegraph).
//   Battery fixtures ignore a blackout and glow as dim red accents.
// Never add/remove lights or toggle castShadow at runtime: everything is intensity / position / visible on the
// batched pool (hiding parked batched lights keeps one visible sentinel per light type).
import * as THREE from 'three/webgpu';
import { attribute, normalView, positionLocal, positionView, smoothstep } from 'three/tsl';
import type { FixtureInfo, V3 } from './types.ts';

export type FixtureCurveName = 'die' | 'surge_die' | 'brown' | 'pulse' | 'revive';

export interface FixtureCfg {
  color: string;
  intensity: number;
  distance: number;
  decay: number;
  halo: number;
  tube: number;
  /** per-kind overrides: colour, intensity multiplier, range, emitter + halo strength, spot cone */
  kinds?: Record<string, Partial<KindCfg>>;
  /** additive mist cone under lot lamps (0 = off) */
  lampCone?: number;
  /** v1.2: omni sub-pool size (candles + bare bulbs) */
  omni?: number;
  /** v1.2: parked batched lights get visible=false (one sentinel per type stays visible) */
  hideParked?: boolean;
  /** v1.2: curve durations (ms) */
  curves?: Partial<Record<FixtureCurveName, number>>;
  /** v1.2: battery fixtures during a blackout */
  battery?: { color?: string; level?: number };
  /** v1.3 (4e): halo sphere segments [width, height] (default 20 x 12; Lite loads 10 x 6: 83k -> ~21k triangles) */
  haloSegments?: [number, number];
}

export interface KindCfg {
  color: string;
  /** x intensity (cd) */
  mult: number;
  /** range (m) */
  distance: number;
  /** emitter brightness */
  emit: number;
  halo: number;
  /** spot half-angle (rad), penumbra, decay */
  angle: number;
  penumbra: number;
  decay: number;
  /** 'down' = straight down, 'rot' = out of the wall along normalOfYaw(rot) tilted down by pitch, 'forward' = along rot, pitch */
  aim: 'down' | 'rot' | 'forward';
  /** downward tilt (rad) for 'rot' / 'forward' */
  pitch: number;
  /** 0 = spot only, 1 = spot + omni-eligible, 2 = omni only */
  omni: 0 | 1 | 2;
  /** kind default for FixtureInfo.battery */
  battery: boolean;
  /** light source this far under the fixture position (m) */
  drop: number;
}

const K = (o: Partial<KindCfg>): KindCfg => ({ color: '#cfeedd', mult: 1, distance: 9, emit: 1, halo: 1, angle: 1.2, penumbra: 0.85, decay: 2, aim: 'down', pitch: 0, omni: 0, battery: false, drop: 0.22, ...o });
export const KIND_DEFAULTS: Record<string, KindCfg> = {
  tube: K({ color: '#cfeedd', mult: 1, distance: 9 }),
  lamp: K({ color: '#ffb35c', mult: 7.5, distance: 19, emit: 1.6, halo: 0.9, angle: 1.15, penumbra: 0.7, drop: 0.12 }),
  wall: K({ color: '#ffbf73', mult: 2.2, distance: 11, emit: 1.3, halo: 0.8, angle: 1.1, penumbra: 0.75, aim: 'rot', pitch: 0.7, drop: 0.1 }),
  van: K({ color: '#ffe2c0', mult: 0.3, distance: 6, emit: 0.55, halo: 0.25, angle: 1.3, penumbra: 0.9, drop: 0.05 }),
  bulb: K({ color: '#ffd29a', mult: 0.8, distance: 7, emit: 1.2, halo: 1.1, angle: 1.45, penumbra: 0.9, omni: 1, drop: 0.12 }),
  sconce: K({ color: '#ffcf96', mult: 0.7, distance: 6, emit: 1, halo: 0.9, angle: 1.2, penumbra: 0.9, aim: 'rot', pitch: 0.9, drop: 0.05 }),
  highbay: K({ color: '#e6eeff', mult: 2.6, distance: 16, emit: 1.4, halo: 0.8, angle: 0.95, penumbra: 0.8, drop: 0.15 }),
  emergency: K({ color: '#ff3a24', mult: 0.25, distance: 6, emit: 0.8, halo: 0.6, angle: 1.3, penumbra: 0.9, battery: true, drop: 0.08 }),
  candle: K({ color: '#ffae5a', mult: 0.12, distance: 4, emit: 1.1, halo: 1.3, angle: 1.5, penumbra: 1, omni: 2, decay: 2, drop: -0.05 }),
  led_strip: K({ color: '#dde8ff', mult: 0.6, distance: 6, emit: 1.1, halo: 0.5, angle: 1.4, penumbra: 0.9, drop: 0.04 }),
  flood: K({ color: '#f2eedf', mult: 6, distance: 25, emit: 1.6, halo: 0.7, angle: 0.6, penumbra: 0.6, aim: 'forward', pitch: 0.25, drop: 0 }),
  headlight: K({ color: '#fff3d8', mult: 4, distance: 18, emit: 2, halo: 0.6, angle: 0.45, penumbra: 0.5, aim: 'forward', pitch: 0.08, drop: 0 }),
};

/** emitter + halo shape per kind: [emitter scale of the 1.25 x 0.05 x 0.14 tube box], [halo ellipsoid radii], halo y */
const SHAPES: Record<string, { emit: V3; halo: V3; haloY: number; emitY?: number }> = {
  tube: { emit: [1, 1, 1], halo: [1.1, 0.32, 0.45], haloY: -0.06 },
  lamp: { emit: [0.32, 0.3, 3.5], halo: [0.62, 0.3, 0.72], haloY: -0.12 },
  wall: { emit: [0.34, 0.6, 1.4], halo: [0.5, 0.3, 0.38], haloY: -0.08 },
  // the van fixture sits 0.3 m under the cargo roof liner: the lamp panel is mounted on the liner
  van: { emit: [0.48, 0.5, 1.6], halo: [0.55, 0.14, 0.3], haloY: 0.22, emitY: 0.27 },
  bulb: { emit: [0.08, 2, 0.6], halo: [0.3, 0.3, 0.3], haloY: -0.02 },
  sconce: { emit: [0.16, 3, 1.2], halo: [0.35, 0.4, 0.3], haloY: 0 },
  highbay: { emit: [0.4, 0.8, 3.4], halo: [0.7, 0.3, 0.7], haloY: -0.1 },
  emergency: { emit: [0.22, 1.2, 0.6], halo: [0.32, 0.18, 0.2], haloY: -0.03 },
  candle: { emit: [0.016, 0.9, 0.12], halo: [0.12, 0.16, 0.12], haloY: 0.04 },
  led_strip: { emit: [1.4, 0.3, 0.3], halo: [1.2, 0.12, 0.2], haloY: -0.02 },
  flood: { emit: [0.3, 3, 1.6], halo: [0.45, 0.35, 0.3], haloY: 0 },
  headlight: { emit: [0.14, 3, 1.2], halo: [0.3, 0.25, 0.2], haloY: 0 },
};

export interface FixtureUpdateOpts {
  max: number;
  reduceFlicker: boolean;
  /** 0 (camera inside the building) .. 1 (lot); unshadowed outdoor lights would leak through the facade */
  outdoor?: number;
  /** performance.now() (curves, brownouts); default performance.now() */
  now?: number;
  /** fixtures in an open (outdoor) space fade with the camera's outdoor factor (no shadows: they would light the
   *  rooms behind the facade); default: by kind (lot lamps and wall packs) */
  outdoorSpace?: (space: number) => boolean;
}

export interface FixtureSource { fixtures: FixtureInfo[]; visibleSpaces?: (cam: V3) => Set<number> }

export interface FixturePool {
  /** every pooled light (spots then omnis); constructor names must survive minification (keepNames) */
  lights: THREE.Light[];
  spots: THREE.SpotLight[];
  omnis: THREE.PointLight[];
  update(src: FixtureSource | null, cam: THREE.Camera, t: number, opts: FixtureUpdateOpts): void;
  setPower(space: number | 'all', on: boolean): void;
  flickerSpace(space: number, ms: number): void;
  /** smooth sag + recovery (never a strobe) */
  brownout(space: number, ms: number, depth?: number, now?: number): void;
  /** every fixture of the space surges and dies (a quick cascade); dark until its power returns or a revive */
  failSpace(space: number, now?: number): void;
  fixtureCurve(indices: readonly number[], curve: FixtureCurveName, startMs: number, stepMs?: number): void;
  /** current level per fixture (index = level.fixtures index); the same array every call */
  levels(): Float32Array;
  /** per-fixture static light data (for the light grid): colour (linear), candela at level 1, range, kind */
  info(i: number): { r: number; g: number; b: number; cd: number; range: number; kind: string; battery: boolean } | null;
  /** info() without allocating (the per-frame light-grid feed): writes colour, candela and range into `out`;
   *  false (out untouched) when there is no fixture i */
  infoInto(i: number, out: { r: number; g: number; b: number; cd: number; range: number }): boolean;
  /** lit fixture lights this frame */
  litCount(): number;
  /** the fixture list the pool currently draws */
  list(): FixtureInfo[];
  /** halo strength per fixture from the local mist (called on rebuild and when fog volumes change) */
  setMistFn(fn: ((x: number, y: number, z: number) => number) | null): void;
  /** parked batched lights visible=false (one sentinel per type stays); live switch */
  setHideParked(on: boolean): void;
}

const hash = (n: number) => (((n | 0) * 2654435761) >>> 0) / 4294967296;
const NO_LIST: FixtureInfo[] = [];
const sstep = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** brightness 0..1 for a fixture at time t (visual only, deterministic per fixture) */
export function patternLevel(state: string, idx: number, t: number, strobe: boolean, reduce: boolean): number {
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

export const CURVE_MS: Record<FixtureCurveName, number> = { die: 520, surge_die: 420, brown: 1600, pulse: 2400, revive: 760 };

/**
 * Curve multiplier at u = elapsed / duration (u may exceed 1: the end state holds). Smooth: the largest step between
 * 60 Hz frames stays well under a strobe (die / revive flutter at <= 7 Hz with soft edges).
 * Returns [multiplier, dead-after].
 */
export function curveValue(curve: FixtureCurveName, u: number, seed: number): number {
  const c = Math.max(0, u);
  switch (curve) {
    case 'die': {
      if (c >= 1) return 0;
      // a tired tube: two soft sags (a slow flutter, not a strobe), a last brief swell, then out
      const flutter = 1 - 0.35 * Math.max(0, Math.sin((c * 3.2 + seed) * Math.PI * 2)) * sstep(0, 0.2, c);
      const swell = 1 + 0.18 * sstep(0.62, 0.72, c) * (1 - sstep(0.72, 0.8, c));
      const fade = 1 - sstep(0.72, 1, c);
      return Math.max(0, flutter * swell * fade);
    }
    case 'surge_die': {
      if (c >= 1) return 0;
      const up = 1 + 0.65 * sstep(0, 0.28, c);
      return up * (1 - sstep(0.3, 1, c));
    }
    case 'brown': {
      if (c >= 1) return 1;
      return 1 - 0.7 * sstep(0, 0.25, c) * (1 - sstep(0.6, 1, c));
    }
    case 'pulse': {
      if (c >= 1) return 1;
      const env = sstep(0, 0.12, c) * (1 - sstep(0.85, 1, c));
      return 1 - 0.4 * env * (0.5 - 0.5 * Math.cos(c * Math.PI * 2 * 2));
    }
    case 'revive': {
      if (c >= 1) return 1;
      // ignition: a slow uneven warm-up (soft dips) to full
      const ramp = sstep(0, 0.85, c);
      const dips = 1 - 0.3 * Math.max(0, Math.sin((c * 2.6 + seed) * Math.PI * 2)) * (1 - c);
      return Math.max(0, ramp * dips);
    }
  }
  return 1;
}

/** brownout envelope 0..1 (1 = full sag depth): smooth in over 25 %, hold, smooth out over the last 35 % */
export function brownEnvelope(u: number): number {
  if (u <= 0 || u >= 1) return 0;
  return sstep(0, 0.25, u) * (1 - sstep(0.65, 1, u));
}

interface CurveRun { curve: FixtureCurveName; start: number; ms: number; seed: number }
interface Brown { space: number; start: number; ms: number; depth: number }

const kindOf = (f: FixtureInfo): string => {
  const k = (f as { kind?: string }).kind;
  return k && SHAPES[k] ? k : 'tube';
};

export function createFixturePool(scene: THREE.Scene, cfg: FixtureCfg, spotCount: number, omniCount = cfg.omni ?? 4): FixturePool {
  const kinds: Record<string, KindCfg> = {};
  for (const k of Object.keys(KIND_DEFAULTS)) kinds[k] = { ...KIND_DEFAULTS[k], ...(k === 'tube' ? { color: cfg.color, distance: cfg.distance, decay: cfg.decay } : {}), ...(cfg.kinds?.[k] ?? {}) };
  const kindColor: Record<string, THREE.Color> = Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, new THREE.Color(v.color)]));
  const batteryColor = new THREE.Color(cfg.battery?.color ?? '#ff2a1a');
  const batteryLevel = cfg.battery?.level ?? 0.32;
  const curveMs: Record<FixtureCurveName, number> = { ...CURVE_MS, ...(cfg.curves ?? {}) };
  const spots: THREE.SpotLight[] = [];
  for (let i = 0; i < spotCount; i++) {
    const l = new THREE.SpotLight(kindColor.tube, 0, cfg.distance, 1.2, 0.85, cfg.decay);
    l.castShadow = false;
    l.name = `fixture-spot-${i}`;
    l.position.set(0, -400, 0);
    l.target.position.set(0, -401, 0);
    scene.add(l, l.target);
    spots.push(l);
  }
  const omnis: THREE.PointLight[] = [];
  for (let i = 0; i < omniCount; i++) {
    const l = new THREE.PointLight(kindColor.candle ?? kindColor.tube, 0, 4, 2);
    l.castShadow = false;
    l.name = `fixture-omni-${i}`;
    l.position.set(0, -410, 0);
    scene.add(l);
    omnis.push(l);
  }
  const lights: THREE.Light[] = [...spots, ...omnis];

  // instanced emitter + halo shell (per-instance brightness + colour in custom attributes; one draw each)
  const tubeGeo = new THREE.BoxGeometry(1.25, 0.05, 0.14);
  const haloGeo = new THREE.SphereGeometry(1, cfg.haloSegments?.[0] ?? 20, cfg.haloSegments?.[1] ?? 12);
  const tubeMat = new THREE.MeshBasicNodeMaterial();
  const lvlT = attribute('fixLevel', 'float');
  const colT = attribute('fixColor', 'vec3');
  // HDR: lit emitters bloom; unlit ones keep a faint dead-glass grey so they still read under a flashlight
  tubeMat.colorNode = colT.mul(lvlT.mul(cfg.tube)).add(0.006);
  tubeMat.fog = false;
  tubeMat.name = 'fixture-emitter';
  const haloMat = new THREE.MeshBasicNodeMaterial();
  haloMat.transparent = true;
  haloMat.depthWrite = false;
  haloMat.blending = THREE.AdditiveBlending;
  haloMat.fog = false;
  haloMat.name = 'fixture-halo';
  const lvlH = attribute('fixLevel', 'float');
  const colH = attribute('fixColor', 'vec3');
  const hk = attribute('fixHalo', 'float');
  const facing = normalView.dot(positionView.normalize().negate()).clamp(0, 1);
  // squared falloff of the facing term: a soft glow that fades into the air, never a hard-rimmed disc
  // and fades out within ~2 m of the camera (a shell right overhead read as a big blob at the top of the frame)
  const nearFade = smoothstep(0.6, 2.4, positionView.length());
  haloMat.colorNode = colH.mul(smoothstep(0.05, 1.0, facing).pow(2.2).mul(lvlH).mul(hk).mul(cfg.halo).mul(nearFade));
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
  coneMat.name = 'fixture-lamp-cone';
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
  let colorAttr: THREE.InstancedBufferAttribute | null = null;
  let haloAttr: THREE.InstancedBufferAttribute | null = null;
  let haloBase = new Float32Array(0);
  let coneLevel: THREE.InstancedBufferAttribute | null = null;
  let coneIdx: number[] = [];
  let lastList: FixtureInfo[] | null = null;
  let levels = new Float32Array(0);
  /** static per fixture: kind cfg, light colour, battery flag, aim direction */
  let kindIdx: string[] = [];
  let isBattery: boolean[] = [];
  let aimDir: THREE.Vector3[] = [];
  let colorState = new Uint8Array(0); // 0 = kind colour, 1 = battery red
  const powerSpace = new Map<number, boolean>();
  let powerAll = true;
  const strobeUntil = new Map<number, number>();
  const curves = new Map<number, CurveRun>();
  const dead = new Set<number>();
  let browns: Brown[] = [];
  let mistFn: ((x: number, y: number, z: number) => number) | null = null;
  /** per fixture halo / lamp-cone scale from the local mist */
  let mistK = new Float32Array(0);
  let hideParked = cfg.hideParked === true;
  let lit = 0;
  const sentinelSpot = spots[0] ?? null;
  const sentinelOmni = omnis[0] ?? null;

  const poweredSpace = (space: number) => (powerSpace.has(space) ? powerSpace.get(space)! : powerAll);

  function applyMist() {
    if (!haloAttr || !lastList) return;
    const arr = haloAttr.array as Float32Array;
    for (let i = 0; i < lastList.length; i++) {
      const f = lastList[i];
      // halo / cone fakes scale with the local mist (clear air: a tight glow; thick mist: a big soft bloom)
      const m = mistFn ? Math.max(0.6, Math.min(1.6, mistFn(f.pos[0], f.pos[1], f.pos[2]))) : 1;
      arr[i] = haloBase[i] * m;
      if (i < mistK.length) mistK[i] = m;
    }
    haloAttr.needsUpdate = true;
  }

  function rebuild(list: FixtureInfo[]) {
    for (const m of [tubes, halos, cones]) if (m) { scene.remove(m); m.dispose(); }
    cones = null;
    curves.clear();
    dead.clear();
    browns = [];
    const n = Math.max(1, list.length);
    levels = new Float32Array(list.length);
    mistK = new Float32Array(list.length).fill(1);
    kindIdx = list.map(kindOf);
    isBattery = list.map((f, i) => (f as { battery?: boolean }).battery ?? kinds[kindIdx[i]].battery);
    aimDir = list.map((f, i) => {
      const kc = kinds[kindIdx[i]];
      const rot = (f as { rot?: number }).rot ?? 0;
      if (kc.aim === 'down') return new THREE.Vector3(0, -1, 0);
      const fx = Math.sin(rot), fz = Math.cos(rot);
      const p = kc.pitch;
      return new THREE.Vector3(fx * Math.cos(p), -Math.sin(p), fz * Math.cos(p)).normalize();
    });
    colorState = new Uint8Array(list.length);
    levelAttr = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    levelAttr.setUsage(THREE.DynamicDrawUsage);
    const colors = new Float32Array(n * 3);
    haloBase = new Float32Array(n);
    for (let i = 0; i < list.length; i++) {
      const k = kindIdx[i];
      const c = kindColor[k];
      colors.set([c.r * kinds[k].emit, c.g * kinds[k].emit, c.b * kinds[k].emit], i * 3);
      haloBase[i] = kinds[k].halo / Math.max(0.05, kinds[k].emit);
    }
    colorAttr = new THREE.InstancedBufferAttribute(colors, 3);
    colorAttr.setUsage(THREE.DynamicDrawUsage);
    haloAttr = new THREE.InstancedBufferAttribute(haloBase.slice(), 1);
    haloAttr.setUsage(THREE.DynamicDrawUsage);
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
    const up = new THREE.Vector3(0, 1, 0);
    coneIdx = [];
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      const k = kindIdx[i];
      const sh = SHAPES[k];
      const rot = (f as { rot?: number }).rot;
      q.setFromAxisAngle(up, rot ?? 0);
      p.set(f.pos[0], f.pos[1] + (sh.emitY ?? 0), f.pos[2]);
      s.set(...sh.emit);
      tubes.setMatrixAt(i, m.compose(p, q, s));
      s.set(...sh.halo);
      halos.setMatrixAt(i, m.compose(new THREE.Vector3(f.pos[0], f.pos[1] + sh.haloY, f.pos[2]), q, s));
      if (k === 'lamp') coneIdx.push(i);
    }
    if (!list.length) { tubes.count = 0; halos.count = 0; }
    tubes.frustumCulled = false;
    halos.frustumCulled = false;
    scene.add(tubes, halos);
    if (coneIdx.length && (cfg.lampCone ?? 0.05) > 0) {
      coneLevel = new THREE.InstancedBufferAttribute(new Float32Array(coneIdx.length), 1);
      coneLevel.setUsage(THREE.DynamicDrawUsage);
      const cc = new Float32Array(coneIdx.length * 3);
      coneIdx.forEach((li, j) => { const c = kindColor[kindIdx[li]]; cc.set([c.r, c.g, c.b], j * 3); });
      const cg = coneGeo.clone();
      cg.setAttribute('fixLevel', coneLevel);
      cg.setAttribute('fixColor', new THREE.InstancedBufferAttribute(cc, 3));
      cones = new THREE.InstancedMesh(cg, coneMat, coneIdx.length);
      cones.name = 'fixture-lamp-cones';
      cones.renderOrder = 8;
      cones.frustumCulled = false;
      const q0 = new THREE.Quaternion();
      coneIdx.forEach((li, j) => {
        const f = list[li];
        p.set(f.pos[0], f.pos[1] - 0.02, f.pos[2]);
        s.set(1, Math.max(0.3, f.pos[1] / coneH), 1);
        cones!.setMatrixAt(j, m.compose(p, q0, s));
      });
      scene.add(cones);
    } else coneLevel = null;
    lastList = list;
    applyMist();
  }

  const camPos = new THREE.Vector3();
  const camV: V3 = [0, 0, 0];
  const order: number[] = [];
  const omniOrder: number[] = [];
  const tmpT = new THREE.Vector3();
  /** per frame: squared camera distance of each listed fixture (the sorts read it; no per-frame closures) */
  let dist2 = new Float32Array(0);
  /** Smi results (a double returned to Array.prototype.sort is boxed on every call) */
  const byDist = (a: number, b: number) => (dist2[a] < dist2[b] ? -1 : dist2[a] > dist2[b] ? 1 : a - b);
  /** nearest first, in place: insertion sort for the usual handful of lit visible fixtures (Array.prototype.sort
   *  copies the array into a temporary store on every call) */
  const sortByDist = (arr: number[]) => {
    if (arr.length > 96) { arr.sort(byDist); return; }
    for (let i = 1; i < arr.length; i++) {
      const v = arr[i];
      let j = i - 1;
      while (j >= 0 && byDist(arr[j], v) > 0) { arr[j + 1] = arr[j]; j--; }
      arr[j + 1] = v;
    }
  };
  /** drop finished brownouts in place */
  const pruneBrowns = (now: number) => {
    let k = 0;
    for (let i = 0; i < browns.length; i++) if (now - browns[i].start < browns[i].ms) browns[k++] = browns[i];
    browns.length = k;
  };

  function park(l: THREE.Light, hide: boolean) {
    l.intensity = 0;
    l.position.set(0, -400, 0);
    if ((l as THREE.SpotLight).isSpotLight) (l as THREE.SpotLight).target.position.set(0, -401, 0);
    // hidden lights leave the batched loop (shorter per-pixel loop); one sentinel per type stays visible so the
    // light-type set of the batched DynamicLighting node never changes
    l.visible = !hide || l === sentinelSpot || l === sentinelOmni;
  }

  return {
    lights,
    spots,
    omnis,
    litCount: () => lit,
    list: () => lastList ?? [],
    levels: () => levels,
    info(i) {
      const f = lastList?.[i];
      if (!f) return null;
      const k = kindIdx[i];
      const kc = kinds[k];
      const c = colorState[i] === 1 ? batteryColor : kindColor[k];
      return { r: c.r, g: c.g, b: c.b, cd: cfg.intensity * kc.mult, range: kc.distance, kind: k, battery: isBattery[i] };
    },
    infoInto(i, out) {
      if (!lastList || i < 0 || i >= lastList.length) return false;
      const kc = kinds[kindIdx[i]];
      const c = colorState[i] === 1 ? batteryColor : kindColor[kindIdx[i]];
      out.r = c.r; out.g = c.g; out.b = c.b;
      out.cd = cfg.intensity * kc.mult;
      out.range = kc.distance;
      return true;
    },
    setMistFn(fn) { mistFn = fn; applyMist(); },
    setHideParked(on) {
      hideParked = on;
      if (!on) for (const l of lights) l.visible = true;
    },
    setPower(space, on) {
      if (space === 'all') {
        // a real power return (off -> on) clears the visual deaths of the dark walk / failSpace
        if (on && (!powerAll || powerSpace.size)) dead.clear();
        if (on) { for (const i of curves.keys()) { const c = curves.get(i)!; if (c.curve === 'die' || c.curve === 'surge_die') curves.delete(i); } }
        powerAll = on;
        if (on) powerSpace.clear();
      } else {
        const was = poweredSpace(space);
        powerSpace.set(space, on);
        // only a transition revives (interaction re-sends every space's state every 2 s)
        if (on && !was && lastList) {
          for (let i = 0; i < lastList.length; i++) if (lastList[i].space === space) {
            dead.delete(i);
            const c = curves.get(i);
            if (c && (c.curve === 'die' || c.curve === 'surge_die')) curves.delete(i);
          }
        }
      }
    },
    flickerSpace(space, ms) {
      strobeUntil.set(space, performance.now() + ms);
    },
    brownout(space, ms, depth = 0.5, now = performance.now()) {
      pruneBrowns(now);
      browns.push({ space, start: now, ms: Math.max(50, ms), depth: Math.max(0, Math.min(1, depth)) });
    },
    failSpace(space, now = performance.now()) {
      if (!lastList) return;
      const idx: number[] = [];
      for (let i = 0; i < lastList.length; i++) if (lastList[i].space === space) idx.push(i);
      this.fixtureCurve(idx, 'surge_die', now, 70);
    },
    fixtureCurve(indices, curve, startMs, stepMs = 0) {
      let k = 0;
      for (const i of indices) {
        if (!lastList || i < 0 || i >= lastList.length) continue;
        if (curve === 'revive') dead.delete(i);
        curves.set(i, { curve, start: startMs + k * stepMs, ms: curveMs[curve], seed: hash(i * 31 + 7) });
        k++;
      }
    },
    update(src, cam, t, opts) {
      const list = src?.fixtures ?? NO_LIST;
      if (list !== lastList) rebuild(list);
      cam.getWorldPosition(camPos);
      camV[0] = camPos.x; camV[1] = camPos.y; camV[2] = camPos.z;
      const vis = src?.visibleSpaces ? src.visibleSpaces(camV) : null;
      const now = opts.now ?? performance.now();
      const lv = levelAttr ? (levelAttr.array as Float32Array) : null;
      pruneBrowns(now);
      if (dist2.length < list.length) dist2 = new Float32Array(Math.max(list.length, dist2.length * 2, 16));
      let colorsDirty = false;
      order.length = 0;
      omniOrder.length = 0;
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        const powered = poweredSpace(f.space);
        const strobe = (strobeUntil.get(f.space) ?? 0) > now;
        const working = f.state === 'on' || f.state === 'flicker';
        let level = 0;
        let battery = false;
        if (working && powered) level = patternLevel(f.state, i, t, strobe, opts.reduceFlicker);
        else if (working && isBattery[i]) { level = batteryLevel * (0.97 + 0.03 * Math.sin(t * 2.1 + i)); battery = true; }
        // curves (dark walk, director): multiply; a finished die / surge_die leaves the fixture dead
        const c = curves.get(i);
        if (c) {
          const u = (now - c.start) / c.ms;
          if (u >= 0) {
            level *= curveValue(c.curve, u, c.seed);
            if (u >= 1) {
              curves.delete(i);
              if (c.curve === 'die' || c.curve === 'surge_die') dead.add(i);
            }
          }
        }
        if (dead.has(i)) level = 0;
        for (let bi = 0; bi < browns.length; bi++) {
          const b = browns[bi];
          if (b.space === f.space) level *= 1 - b.depth * brownEnvelope((now - b.start) / b.ms);
        }
        levels[i] = level;
        if (lv) lv[i] = level;
        const cs = battery ? 1 : 0;
        if (colorState[i] !== cs && colorAttr) {
          colorState[i] = cs;
          const k = kindIdx[i];
          const col = cs === 1 ? batteryColor : kindColor[k];
          const e = kinds[k].emit;
          (colorAttr.array as Float32Array).set([col.r * e, col.g * e, col.b * e], i * 3);
          colorsDirty = true;
        }
        if (level > 0.001 && (!vis || vis.has(f.space))) {
          const om = kinds[kindIdx[i]].omni;
          if (om !== 2) order.push(i);
          if (om >= 1) omniOrder.push(i);
          const p = f.pos;
          const dx = p[0] - camPos.x, dy = p[1] - camPos.y, dz = p[2] - camPos.z;
          dist2[i] = dx * dx + dz * dz + 0.25 * dy * dy;
        }
      }
      if (levelAttr) levelAttr.needsUpdate = true;
      if (colorsDirty && colorAttr) colorAttr.needsUpdate = true;
      if (coneLevel && lv) {
        const cl = coneLevel.array as Float32Array;
        for (let j = 0; j < coneIdx.length; j++) cl[j] = lv[coneIdx[j]] * (mistK[coneIdx[j]] ?? 1);
        coneLevel.needsUpdate = true;
      }
      sortByDist(order);
      sortByDist(omniOrder);
      const hide = hideParked;
      const out = opts.outdoor ?? 1;
      const max = Math.min(opts.max, spots.length);
      lit = 0;
      for (let i = 0; i < spots.length; i++) {
        const l = spots[i];
        if (i < max && i < order.length) {
          const idx = order[i];
          const f = list[idx];
          const k = kindIdx[idx];
          const kc = kinds[k];
          l.visible = true;
          l.position.set(f.pos[0], f.pos[1] - kc.drop, f.pos[2]);
          const a = aimDir[idx];
          tmpT.copy(l.position).addScaledVector(a, 2);
          l.target.position.copy(tmpT);
          l.color.copy(colorState[idx] === 1 ? batteryColor : kindColor[k]);
          l.distance = kc.distance;
          l.angle = kc.angle;
          l.penumbra = kc.penumbra;
          l.decay = kc.decay;
          // no shadows on fixtures: from inside the building the lot lamps / entrance wall pack would light the rooms
          // behind the facade, so they fade with the camera's outdoor factor (their emitters + cones stay lit)
          const outdoorFx = opts.outdoorSpace ? opts.outdoorSpace(f.space) : k === 'wall' || k === 'flood' || k === 'lamp';
          const gate = !outdoorFx ? 1 : k === 'lamp' ? 0.3 + 0.7 * out : out;
          l.intensity = cfg.intensity * kc.mult * gate * levels[idx] * (colorState[idx] === 1 ? 2.2 : 1);
          lit++;
        } else park(l, hide);
      }
      for (let i = 0; i < omnis.length; i++) {
        const l = omnis[i];
        if (i < omniOrder.length) {
          const idx = omniOrder[i];
          const f = list[idx];
          const k = kindIdx[idx];
          const kc = kinds[k];
          l.visible = true;
          l.position.set(f.pos[0], f.pos[1] - kc.drop, f.pos[2]);
          l.color.copy(kindColor[k]);
          l.distance = kc.distance * (kc.omni === 2 ? 1 : 0.6);
          l.decay = 2;
          // bulbs: the omni only lifts the ceiling around the bare bulb (the spot does the floor)
          l.intensity = cfg.intensity * kc.mult * levels[idx] * (kc.omni === 2 ? 1 : 0.35);
          lit++;
        } else park(l, hide);
      }
    },
  };
}
