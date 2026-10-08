// Owner: track ③ Render / env-render (v1.2). Flashlight light pool. Created ONCE at init (N shadowed ProjectorLights
// with a procedural TSL cookie + (6-N) unshadowed SpotLights batched by DynamicLighting, each with a soft additive
// cone). Never add/remove lights or toggle castShadow at runtime: on/off/battery/interference = intensity only.
// v1.2 shadows: every shadowed slot keeps shadow.autoUpdate = false for its whole life. armShadows() (called right
// before the pipeline renders) sets needsUpdate = true once per frame on assigned slots, so N cameras in one frame
// (main + live mirror + warm reflector) give ONE shadow render per slot (three r186 ShadowNode only dedupes per
// (camera, frame) under autoUpdate). Parked slots get one last render of their empty frustum, then sleep.
// Shadow camera layer masks are set ONCE, when the slots are created, and never change: the first shadowed slot is
// YOUR beam's for the page lifetime (teammates' beams never take it) and its shadow camera alone sees layer 0 + phantom
// (the paranormal presence figure: one shadow draw while it runs, not one per shadowed beam) + detail (small props /
// item models that only cast in your own beam). Teammates' slots see layer 0 only (+ an empty layer: a mask of only
// layer 0 would adopt the rendering camera's mask in ShadowNode.updateShadow); never first-person, ghost or self.
// v1.2 gate P (draw budget): High / Ultra shadow your own beam + the 3 best remote beams (nearest, most centred in the
// view, with hysteresis so two similar beams never swap every frame); the rest use the unshadowed batched slots.
// Remote beams reach remoteDistance (the shadow camera's far plane follows light.distance: fewer distant casters).
import * as THREE from 'three/webgpu';
import {
  Fn, float, mix, normalView, positionLocal, positionView, positionWorld, smoothstep, uniform, vec3, exp, sin, length, cos, atan,
  lightPosition, color as tslColor,
} from 'three/tsl';
import { RENDER_LAYERS } from './api.ts';
import type { BeamInfo } from './api.ts';
import type { FlashlightInfo, V3 } from './types.ts';

export interface FlashCfg {
  angle: number;
  penumbra: number;
  decay: number;
  distance: number;
  intensity1: number;
  intensity2: number;
  color1: string;
  color2: string;
  bias: number;
  normalBias: number;
  shadowRadius: number;
  near: number;
  cone: number;
  /** metres: below this distance from the lens the beam stops getting brighter (no blown-out hot spot up close) */
  nearClamp?: number;
  /** unshadowed SpotLight half-angle (rad); its smooth full penumbra mimics the cookie's body */
  plainAngle?: number;
  /** half-angle (rad) of the fake additive cone mesh */
  coneAngle?: number;
  /** volumetric scattering weight: own beam / teammates' beams */
  volLocal?: number;
  volRemote?: number;
  /** weight of the tight hot core in the cookie (1 = original reflector look; lower = less glare on close walls) */
  hotspot?: number;
  /** v1.2: remote beams farther than this (m) re-render their shadow map every other frame (0 = always full rate) */
  halfRateFar?: number;
  /** v1.2: range (m) of teammates' beams (default: distance); a shadowed beam's shadow far plane = its range */
  remoteDistance?: number;
  /** v1.2: score bonus (m) of a beam that already holds a shadowed slot (no flip-flop between similar beams) */
  shadowHold?: number;
}

export interface Slot {
  light: THREE.SpotLight;
  shadowed: boolean;
  /** v1.2: the slot reserved for YOUR beam (the first shadowed slot): only its shadow camera sees phantom + detail */
  own: boolean;
  /** cookie flicker multiplier (shadowed): battery flicker x beam interference; never reset during an interference */
  flick: { value: number };
  /** volumetric scattering weight of this beam (read by the volume model via light.userData.volWeight) */
  volW: { value: number };
  cone: THREE.Mesh;
  coneK: { value: number };
  id: string | null;
  /** smoothed intensity for on/off fades */
  cur: number;
  /** was assigned last frame (parking renders the empty frustum once more) */
  wasAssigned: boolean;
  /** half-rate shadow: this frame's shadow render is skipped (position + target frozen with it) */
  skip: boolean;
  /** last BeamInfo-relevant state */
  local: boolean;
  intensity: number;
  /** pool index */
  index: number;
  /** this frame's beam (index into the update list, -1 = parked) */
  next: number;
}

const PARK = new THREE.Vector3(0, -500, 0);
/** a layer NO object may use: it only keeps teammates' shadow masks from being "layer 0 alone", which three r186's
 *  ShadowNode.updateShadow replaces with the rendering camera's mask (first person, detail, ghost, self ...) */
export const SHADOW_EMPTY_LAYER = 30;
/** teammates' beams (every shadowed slot but yours, set once at creation): layer 0 only. Never phantom or detail */
export const SHADOW_LAYER_MASK = (1 << 0) | (1 << SHADOW_EMPTY_LAYER);
/** your own beam's slot (set once at creation): layer 0 + phantom (the presence figure) + detail (small props, items) */
export const SHADOW_LAYER_MASK_LOCAL = (1 << 0) | (1 << RENDER_LAYERS.phantom) | (1 << RENDER_LAYERS.detail);

/**
 * Procedural cookie (r = 1 at the projector frustum edge). A real reflector torch: tight hot core (~7 deg), the main
 * throw (~16 deg), a wide dim spill (~33 deg) and faint reflector rings + lens smudges. Everything ends inside
 * r = 0.94, so the ProjectorLight's square frustum never shows (the old spill ran to r = 1.3: a rounded-square beam).
 * Edges run slightly warmer than the core (incandescent spill). Near-field clamp: closer than `nearClamp` m the
 * beam stops brightening, so a wall in your face is bright, never a blown-out white disk + bloom.
 * The node reads the lit position from the build context: in the volume pass that is the ray sample, so the
 * shafts get the same profile and clamp.
 */
function makeCookie(seed: number, light: THREE.Light, nearClamp: number, decay: number, hotspot: number) {
  const k = uniform(1);
  const nearK = uniform(nearClamp);
  return {
    k,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    node: (Fn as any)(([uv]: [THREE.Node], builder: { context: { positionWorld?: THREE.Node } }) => {
      const p = (uv as unknown as ReturnType<typeof vec3>).xy.sub(0.5).mul(2);
      const r = length(p);
      const r2 = r.mul(r);
      const core = exp(r2.mul(-1 / (0.17 * 0.17))).mul(hotspot);
      const body = exp(r2.mul(-1 / (0.42 * 0.42))).mul(0.42);
      const spill = smoothstep(0.95, 0.42, r).mul(0.14);
      // reflector rings: bright lip at the core edge, a faint dark band outside it
      const ring = float(1)
        .add(smoothstep(0.11, 0.16, r).mul(smoothstep(0.24, 0.17, r)).mul(0.09))
        .sub(smoothstep(0.22, 0.3, r).mul(smoothstep(0.44, 0.33, r)).mul(0.1));
      const ang = atan(p.y, p.x);
      const smudge = float(1)
        .add(sin(ang.mul(3).add(seed)).mul(0.035))
        .add(sin(ang.mul(7).sub(seed * 1.7).add(r.mul(9))).mul(0.03))
        .add(sin(p.x.mul(11).add(p.y.mul(5)).add(seed * 0.6)).mul(cos(p.y.mul(13).sub(p.x.mul(4)))).mul(0.03));
      const prof = core.add(body).add(spill).mul(ring).mul(smudge).div(1.56);
      const tint = mix(vec3(1, 1, 1), vec3(1.07, 0.97, 0.84), smoothstep(0.2, 0.75, r));
      const pw = (builder.context.positionWorld ?? positionWorld) as unknown as ReturnType<typeof vec3>;
      const d = pw.sub(lightPosition(light)).length();
      const near = d.div(nearK).min(1).pow(decay);
      return tint.mul(prof.mul(near)).mul(k);
    }),
  };
}

function makeCone(len: number, angle: number, color: THREE.Color) {
  const r = Math.tan(angle) * len;
  const g = new THREE.ConeGeometry(r, len, 28, 1, true);
  g.translate(0, -len / 2, 0); // apex at origin
  g.rotateX(-Math.PI / 2); // base towards +Z (Object3D.lookAt points +Z at the target)
  const k = uniform(0);
  const m = new THREE.MeshBasicNodeMaterial();
  m.transparent = true;
  m.depthWrite = false;
  m.blending = THREE.AdditiveBlending;
  m.side = THREE.DoubleSide;
  m.fog = false;
  const t = positionLocal.z.div(len).clamp(0, 1);
  const along = smoothstep(0.0, 0.06, t).mul(t.oneMinus().pow(1.6));
  const facing = normalView.dot(positionView.normalize().negate()).abs().pow(2.6);
  m.colorNode = tslColor(color).mul(along.mul(facing).mul(k));
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  mesh.name = 'flashlight-cone';
  return { mesh, k: k as unknown as { value: number } };
}

export interface FlashUpdateOpts {
  activeShadowed: number;
  volumetric: boolean;
  reduceFlicker: boolean;
  /** false: assigned AND parked shadowed slots render every frame (the old behaviour, ?rdebug=shadowall) */
  parkShadows?: boolean;
  /** drawn-frame counter (half-rate remote shadows alternate on it) */
  frame?: number;
  /** performance.now() for beam interference (default: performance.now()) */
  now?: number;
}

export interface FlashlightPool {
  slots: Slot[];
  /** assign beams to slots, intensities, cones, interference, half-rate decisions. Shadow maps are armed separately. */
  update(list: FlashlightInfo[], camera: THREE.PerspectiveCamera, t: number, dt: number, opts: FlashUpdateOpts): void;
  /** right before the pipeline renders: needsUpdate = true on every slot that must re-render its map this frame
   *  (assigned, not skipped by half rate; or just parked: one last render). Returns the number armed. */
  armShadows(): number;
  usedShadowed(): number;
  /** every lit beam this frame (assigned slots with a visible intensity) */
  beams(): BeamInfo[];
  /** dim/stutter beam `who` ('local' = own beam) for ms; depth 0..1 (default 0.6) */
  interfere(who: string, ms: number, depth?: number, now?: number): void;
  /** look-dev / tests: beam ranges (m) of your own beam and of teammates' beams (applied on the next update) */
  setRanges(local: number, remote: number): void;
  ranges(): { local: number; remote: number };
}

interface Interference { who: string; t0: number; ms: number; depth: number; seed: number }

const hash = (n: number) => (((n | 0) * 2654435761) >>> 0) / 4294967296;

/** 0..1 dimming envelope of an interference at `now`: irregular stutter (or a smooth dip under reduceFlicker) */
export function interferenceDim(it: Interference, now: number, reduceFlicker: boolean): number {
  const u = (now - it.t0) / Math.max(1, it.ms);
  if (u < 0 || u > 1) return 0;
  const env = Math.min(1, u / 0.12) * Math.min(1, (1 - u) / 0.2);
  if (reduceFlicker) return it.depth * env * 0.8;
  // ~18 Hz stutter: dips of varying depth, never a pure on/off strobe
  const step = Math.floor((now - it.t0) / 55);
  const h = hash(step * 7 + it.seed);
  const dip = h < 0.35 ? 1 : h < 0.6 ? 0.55 : 0.2;
  return Math.min(1, it.depth * env * dip);
}

export function createFlashlightPool(scene: THREE.Scene, cfg: FlashCfg, shadowed: number, unshadowed: number, shadowMap: number, volLayer: number): FlashlightPool {
  const slots: Slot[] = [];
  const c1 = new THREE.Color(cfg.color1);
  for (let i = 0; i < shadowed + unshadowed; i++) {
    const isShadow = i < shadowed;
    let light: THREE.SpotLight;
    let flick = { value: 1 };
    const volW = uniform(1);
    if (isShadow) {
      const pl = new THREE.ProjectorLight(0xffffff, 0, cfg.distance, cfg.angle, cfg.penumbra, cfg.decay);
      const ck = makeCookie(1.7 + i * 2.31, pl, cfg.nearClamp ?? 2, cfg.decay, cfg.hotspot ?? 1);
      flick = ck.k as unknown as { value: number };
      pl.userData.volWeight = volW;
      (pl as unknown as { colorNode: unknown }).colorNode = ck.node;
      pl.castShadow = true;
      pl.shadow.mapSize.set(shadowMap, shadowMap);
      pl.shadow.bias = cfg.bias;
      pl.shadow.normalBias = cfg.normalBias;
      pl.shadow.radius = cfg.shadowRadius;
      pl.shadow.camera.near = cfg.near;
      pl.shadow.camera.far = cfg.distance;
      // v1.2: maps render only when armShadows() asks (once per frame), never per camera
      pl.shadow.autoUpdate = false;
      pl.shadow.needsUpdate = true;
      // set once for the page lifetime: slot 0 is your beam's (phantom + detail casters), the rest teammates'
      pl.shadow.camera.layers.mask = i === 0 ? SHADOW_LAYER_MASK_LOCAL : SHADOW_LAYER_MASK;
      pl.layers.enable(volLayer);
      light = pl;
    } else {
      // no cookie on the batched spots: a full smooth penumbra over a narrower cone reads like the cookie's body
      light = new THREE.SpotLight(0xffffff, 0, cfg.distance, cfg.plainAngle ?? cfg.angle * 0.8, 1, cfg.decay);
      light.castShadow = false;
    }
    light.name = `flashlight-${isShadow ? 's' : 'u'}${i}`;
    light.position.copy(PARK);
    light.target.position.set(0, -600, 0);
    scene.add(light, light.target);
    const cone = makeCone(6, cfg.coneAngle ?? cfg.angle * 0.5, c1);
    cone.mesh.visible = true;
    cone.mesh.position.copy(PARK);
    scene.add(cone.mesh);
    slots.push({ light, shadowed: isShadow, own: isShadow && i === 0, flick, volW: volW as unknown as { value: number }, cone: cone.mesh, coneK: cone.k, id: null, cur: 0, wasAssigned: false, skip: false, local: false, intensity: 0, index: i, next: -1 });
  }

  const fwd = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const aim = new THREE.Vector3();
  /** beam colours parsed once (Color.set(string) parses the style string on every call) */
  const colT1 = new THREE.Color(cfg.color1), colT2 = new THREE.Color(cfg.color2);
  let used = 0;
  let parkAll = true;
  let interferences: Interference[] = [];
  let seedN = 0;
  /** slots that must render their map this frame (set by update, consumed by armShadows) */
  const arm = new Set<Slot>();
  // per-frame assignment scratch (no per-frame Maps / Sets / filtered arrays)
  const order: number[] = [];
  let sc = new Float64Array(8);
  let want = new Uint8Array(8);
  let slotOf = new Int16Array(8);
  const byScore = (a: number, b: number) => sc[a] - sc[b] || a - b;
  /** this frame's list index of YOUR beam (the first local one; -1 = none) */
  let mine = -1;
  /** your beam may sit only in your slot, and your slot only holds your beam (unshadowed slots take anyone) */
  const fits = (s: Slot, i: number) => !s.shadowed || s.own === (i === mine);
  /** this frame's beams (built on the first beams() call after an update) */
  let beamCache: BeamInfo[] | null = null;
  let localRange = cfg.distance;
  let remoteRange = cfg.remoteDistance ?? cfg.distance;
  const hold = cfg.shadowHold ?? 2;

  /** importance (lower first): your beam, then lit beams by distance + how far off-centre their light lands, a beam
   *  already holding a shadowed slot keeps it unless another is clearly better */
  function score(f: FlashlightInfo, cam: THREE.PerspectiveCamera, held: boolean): number {
    if (f.local) return -1e9;
    tmp.set(f.pos[0], f.pos[1], f.pos[2]).sub(cam.position);
    const d = tmp.length();
    // where the beam lands (~3 m out) relative to the view axis: 0 centred .. 8 m straight behind
    aim.set(f.pos[0] + f.dir[0] * 3, f.pos[1] + f.dir[1] * 3, f.pos[2] + f.dir[2] * 3).sub(cam.position);
    const al = aim.length();
    const off = al > 1e-3 ? (1 - aim.dot(fwd) / al) * 4 : 0;
    return d + off + (f.on ? 0 : 50) - (held ? hold : 0);
  }

  const indexOf = (list: readonly FlashlightInfo[], id: string | null): number => {
    if (!id) return -1;
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return i;
    return -1;
  };

  return {
    slots,
    usedShadowed: () => used,
    setRanges(local, remote) {
      if (Number.isFinite(local) && local > 0) localRange = local;
      if (Number.isFinite(remote) && remote > 0) remoteRange = remote;
    },
    ranges: () => ({ local: localRange, remote: remoteRange }),
    interfere(who, ms, depth = 0.6, now = performance.now()) {
      interferences = interferences.filter((it) => now - it.t0 < it.ms);
      interferences.push({ who, t0: now, ms: Math.max(0, ms), depth: Math.max(0, Math.min(1, depth)), seed: (seedN++ * 131) % 997 });
    },
    beams() {
      if (beamCache) return beamCache;
      const out: BeamInfo[] = [];
      for (const s of slots) {
        if (!s.id || s.intensity < 0.01 || s.light.position.y < -100) continue;
        const p = s.light.position;
        const q = s.light.target.position;
        tmp.subVectors(q, p).normalize();
        out.push({ id: s.id, pos: [p.x, p.y, p.z], dir: [tmp.x, tmp.y, tmp.z], angle: s.light.angle, range: s.light.distance, intensity: s.intensity, local: s.local });
      }
      beamCache = out;
      return out;
    },
    armShadows() {
      let n = 0;
      for (const s of slots) {
        if (!s.shadowed) continue;
        const sh = s.light.shadow;
        // safety: nothing else may switch a slot back to per-camera updates
        if (sh.autoUpdate) sh.autoUpdate = false;
        if (arm.has(s)) { sh.needsUpdate = true; n++; }
      }
      arm.clear();
      return n;
    },
    update(list, camera, t, dt, opts) {
      const now = opts.now ?? performance.now();
      parkAll = opts.parkShadows !== false;
      beamCache = null;
      camera.getWorldDirection(fwd);
      const n = list.length;
      if (sc.length < n) { sc = new Float64Array(n * 2); want = new Uint8Array(n * 2); slotOf = new Int16Array(n * 2); }
      let shadowSlotCount = 0;
      for (const s of slots) if (s.shadowed) shadowSlotCount++;
      const nS = Math.min(opts.activeShadowed, shadowSlotCount);
      // rank the beams; the best nS get shadowed slots (your own first), the rest the unshadowed ones
      order.length = 0;
      mine = -1;
      for (let i = 0; i < n; i++) {
        order.push(i);
        if (mine < 0 && list[i].local) mine = i;
        let held = false;
        for (const s of slots) if (s.shadowed && s.id !== null && s.id === list[i].id) { held = true; break; }
        sc[i] = score(list[i], camera, held);
      }
      order.sort(byScore);
      for (let k = 0; k < n; k++) { want[order[k]] = k < nS ? 1 : 0; slotOf[order[k]] = -1; }
      // stable: a beam keeps its slot while it stays in that slot's class; then free slots fill in rank order (a
      // shadow-class beam without a free shadowed slot falls back to an unshadowed one). Your shadowed beam always sits
      // in your own slot, which nobody else takes (it stays parked without you): the masks never have to change
      for (const s of slots) {
        s.next = -1;
        const i = indexOf(list, s.id);
        if (i >= 0 && slotOf[i] < 0 && want[i] === (s.shadowed ? 1 : 0) && fits(s, i)) { s.next = i; slotOf[i] = s.index; }
      }
      for (let k = 0; k < n; k++) {
        const i = order[k];
        if (slotOf[i] >= 0) continue;
        let pick: Slot | null = null;
        if (want[i]) for (const s of slots) if (s.shadowed && s.next < 0 && fits(s, i)) { pick = s; break; }
        if (!pick) for (const s of slots) if (!s.shadowed && s.next < 0) { pick = s; break; }
        if (pick) { pick.next = i; slotOf[i] = pick.index; }
      }
      if (interferences.length) interferences = interferences.filter((it) => now - it.t0 < it.ms);
      const frame = opts.frame ?? 0;
      const halfFar = cfg.halfRateFar ?? 0;
      used = 0;
      for (const s of slots) {
        const f = s.next >= 0 ? list[s.next] : undefined;
        if (!f) {
          const was = s.wasAssigned || s.id !== null;
          s.id = null;
          s.cur = 0;
          s.intensity = 0;
          s.local = false;
          s.light.intensity = 0;
          s.light.position.copy(PARK); // parked: shadow frustum sees nothing => near-free shadow pass
          s.light.target.position.set(0, -600, 0);
          s.coneK.value = 0;
          s.cone.visible = false;
          s.flick.value = 1;
          s.skip = false;
          // one last render of the parked, empty frustum (or every frame with parkShadows:false)
          if (s.shadowed && (was || !parkAll)) arm.add(s);
          s.wasAssigned = false;
          continue;
        }
        if (s.id !== f.id) s.cur = f.on ? 1 : 0;
        const fresh = s.id !== f.id || !s.wasAssigned;
        s.id = f.id;
        s.wasAssigned = true;
        s.local = f.local;
        if (s.shadowed) used++;
        // range by role: teammates' beams reach remoteDistance (a shadowed light's shadow far plane = its distance,
        // so distant casters drop out of its pass); only your own slot's shadow sees the detail + phantom layers
        s.light.distance = f.local ? localRange : remoteRange;
        const base = f.tier === 2 ? cfg.intensity2 : cfg.intensity1;
        s.light.color.copy(f.tier === 2 ? colT2 : colT1);
        // battery flicker (deterministic per slot; visual only)
        let flick = 1;
        const bat = f.battery ?? 1;
        if (bat < 0.15 && f.on) {
          const ph = Math.floor(t * 14 + s.light.id * 7.3);
          const h = ((ph * 2654435761) >>> 0) / 4294967296;
          flick = opts.reduceFlicker ? 0.55 + 0.45 * bat / 0.15 : h < 0.25 ? 0.08 : h < 0.45 ? 0.55 : 1;
          flick *= 0.45 + 0.55 * (bat / 0.15);
        }
        // beam interference (paranormal): dims the cookie (shadowed) / the intensity (plain), shaft included
        let dim = 0;
        for (let j = 0; j < interferences.length; j++) {
          const it = interferences[j];
          if (it.who === f.id || (it.who === 'local' && f.local)) dim = Math.max(dim, interferenceDim(it, now, opts.reduceFlicker));
        }
        const target = f.on ? 1 : 0;
        s.cur += (target - s.cur) * Math.min(1, dt * 30);
        const k = s.cur * flick;
        // shadowed: the interference rides the cookie uniform (light + its shaft dim together); plain: intensity
        s.flick.value = s.shadowed ? 1 - dim : 1;
        s.light.intensity = base * (s.shadowed ? 1 : 0.9) * k * (s.shadowed ? 1 : 1 - dim);
        s.intensity = s.light.intensity * (s.shadowed ? 1 - dim : 1);
        // your own beam: a subtle haze (you look down its axis); teammates' beams: readable shafts across the dark
        s.volW.value = f.local ? (cfg.volLocal ?? 0.6) : (cfg.volRemote ?? 1.8);
        // half-rate shadows for far remote beams: skip every other frame, freezing position + target with the map
        // (a shadowed light's projection only updates when its map renders: a moving beam would slide off its shadow)
        tmp.set(f.pos[0], f.pos[1], f.pos[2]);
        const far = s.shadowed && !f.local && halfFar > 0 && tmp.distanceTo(camera.position) > halfFar;
        s.skip = far && !fresh && (frame & 1) === 1;
        if (!s.skip) {
          s.light.position.set(f.pos[0], f.pos[1], f.pos[2]);
          s.light.target.position.set(f.pos[0] + f.dir[0] * 10, f.pos[1] + f.dir[1] * 10, f.pos[2] + f.dir[2] * 10);
          s.light.target.updateMatrixWorld();
          if (s.shadowed) arm.add(s);
        }
        const wantCone = !s.shadowed || !opts.volumetric;
        s.cone.visible = wantCone && k > 0.01;
        if (s.cone.visible) {
          s.cone.position.copy(s.light.position);
          s.cone.lookAt(s.light.target.position);
          // own beam: fainter (camera is inside it)
          s.coneK.value = cfg.cone * k * (1 - dim) * (f.local ? 0.35 : 1) * (f.tier === 2 ? 1.2 : 1);
        }
      }
    },
  };
}

export function dirFromYawPitch(yaw: number, pitch: number): V3 {
  // yaw 0 looks down -Z (three default), positive yaw turns left
  const cp = Math.cos(pitch);
  return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
}
