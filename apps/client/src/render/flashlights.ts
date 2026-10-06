// Owner: track ③ Render. Flashlight light pool. Created ONCE at init (N shadowed ProjectorLights with a procedural
// TSL cookie + (6-N) unshadowed SpotLights batched by DynamicLighting, each with a soft additive cone).
// Never add/remove lights or toggle castShadow at runtime: on/off/battery = intensity only.
import * as THREE from 'three/webgpu';
import {
  Fn, float, mix, normalView, positionLocal, positionView, positionWorld, smoothstep, uniform, vec3, exp, sin, length, vec2, cos, atan,
  lightPosition, color as tslColor,
} from 'three/tsl';
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
}

interface Slot {
  light: THREE.SpotLight;
  shadowed: boolean;
  /** cookie flicker multiplier (shadowed) */
  flick: { value: number };
  /** volumetric scattering weight of this beam (read by the volume model via light.userData.volWeight) */
  volW: { value: number };
  cone: THREE.Mesh;
  coneK: { value: number };
  id: string | null;
  /** smoothed intensity for on/off fades */
  cur: number;
}

const PARK = new THREE.Vector3(0, -500, 0);

/**
 * Procedural cookie (r = 1 at the projector frustum edge). A real reflector torch: tight hot core (~7 deg), the main
 * throw (~16 deg), a wide dim spill (~33 deg) and faint reflector rings + lens smudges. Everything ends inside
 * r = 0.94, so the ProjectorLight's square frustum never shows (the old spill ran to r = 1.3: a rounded-square beam).
 * Edges run slightly warmer than the core (incandescent spill). Near-field clamp: closer than `nearClamp` m the
 * beam stops brightening, so a wall in your face is bright, never a blown-out white disk + bloom.
 * The node reads the lit position from the build context: in the volume pass that is the ray sample, so the
 * shafts get the same profile and clamp.
 */
function makeCookie(seed: number, light: THREE.Light, nearClamp: number, decay: number) {
  const k = uniform(1);
  const nearK = uniform(nearClamp);
  return {
    k,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    node: (Fn as any)(([uv]: [THREE.Node], builder: { context: { positionWorld?: THREE.Node } }) => {
      const p = (uv as unknown as ReturnType<typeof vec3>).xy.sub(0.5).mul(2);
      const r = length(p);
      const r2 = r.mul(r);
      const core = exp(r2.mul(-1 / (0.17 * 0.17)));
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

export interface FlashlightPool {
  slots: Slot[];
  update(list: FlashlightInfo[], camera: THREE.PerspectiveCamera, t: number, dt: number, opts: { activeShadowed: number; volumetric: boolean; reduceFlicker: boolean }): void;
  usedShadowed(): number;
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
      const ck = makeCookie(1.7 + i * 2.31, pl, cfg.nearClamp ?? 2, cfg.decay);
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
    slots.push({ light, shadowed: isShadow, flick, volW: volW as unknown as { value: number }, cone: cone.mesh, coneK: cone.k, id: null, cur: 0 });
  }

  const fwd = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const col = new THREE.Color();
  let used = 0;

  function score(f: FlashlightInfo, cam: THREE.PerspectiveCamera): number {
    if (f.local) return -1e9;
    tmp.set(f.pos[0], f.pos[1], f.pos[2]).sub(cam.position);
    const d = tmp.length();
    // beam visible if the source is in front OR the beam points towards the camera's view
    const inFront = tmp.dot(fwd) > 0 ? 0 : 6;
    return d + inFront + (f.on ? 0 : 50);
  }

  return {
    slots,
    usedShadowed: () => used,
    update(list, camera, t, dt, opts) {
      camera.getWorldDirection(fwd);
      const sorted = list.slice().sort((a, b) => score(a, camera) - score(b, camera));
      const nS = Math.min(opts.activeShadowed, slots.filter((s) => s.shadowed).length);
      const wantShadow = new Set(sorted.slice(0, nS).map((f) => f.id));
      const rest = sorted.slice(nS);
      const shadowSlots = slots.filter((s) => s.shadowed);
      const plainSlots = slots.filter((s) => !s.shadowed);
      // keep stable slot assignment (no thrash), then fill free slots
      const assign = new Map<Slot, FlashlightInfo>();
      const byId = new Map(list.map((f) => [f.id, f] as const));
      for (const s of shadowSlots) if (s.id && wantShadow.has(s.id) && byId.has(s.id)) { assign.set(s, byId.get(s.id)!); wantShadow.delete(s.id); }
      const freeS = shadowSlots.filter((s, i) => i < nS && !assign.has(s));
      for (const id of wantShadow) { const s = freeS.shift(); if (s) assign.set(s, byId.get(id)!); else rest.unshift(byId.get(id)!); }
      const plainIds = new Set(rest.map((f) => f.id));
      for (const s of plainSlots) if (s.id && plainIds.has(s.id) && byId.has(s.id)) { assign.set(s, byId.get(s.id)!); plainIds.delete(s.id); }
      const freeP = plainSlots.filter((s) => !assign.has(s));
      for (const f of rest) if (plainIds.has(f.id)) { const s = freeP.shift(); if (s) assign.set(s, f); }
      used = 0;
      for (const s of slots) {
        const f = assign.get(s);
        if (!f) {
          s.id = null;
          s.cur = 0;
          s.light.intensity = 0;
          s.light.position.copy(PARK); // parked: shadow frustum sees nothing => near-free shadow pass
          s.light.target.position.set(0, -600, 0);
          s.coneK.value = 0;
          s.cone.visible = false;
          continue;
        }
        if (s.id !== f.id) s.cur = f.on ? 1 : 0;
        s.id = f.id;
        if (s.shadowed) used++;
        const base = f.tier === 2 ? cfg.intensity2 : cfg.intensity1;
        col.set(f.tier === 2 ? cfg.color2 : cfg.color1);
        s.light.color.copy(col);
        // battery flicker (deterministic per slot; visual only)
        let flick = 1;
        const bat = f.battery ?? 1;
        if (bat < 0.15 && f.on) {
          const ph = Math.floor(t * 14 + s.light.id * 7.3);
          const h = ((ph * 2654435761) >>> 0) / 4294967296;
          flick = opts.reduceFlicker ? 0.55 + 0.45 * bat / 0.15 : h < 0.25 ? 0.08 : h < 0.45 ? 0.55 : 1;
          flick *= 0.45 + 0.55 * (bat / 0.15);
        }
        const target = f.on ? 1 : 0;
        s.cur += (target - s.cur) * Math.min(1, dt * 30);
        const k = s.cur * flick;
        s.light.intensity = base * (s.shadowed ? 1 : 0.9) * k;
        s.flick.value = 1;
        // your own beam: a subtle haze (you look down its axis); teammates' beams: readable shafts across the dark
        s.volW.value = f.local ? (cfg.volLocal ?? 0.6) : (cfg.volRemote ?? 1.8);
        s.light.position.set(f.pos[0], f.pos[1], f.pos[2]);
        s.light.target.position.set(f.pos[0] + f.dir[0] * 10, f.pos[1] + f.dir[1] * 10, f.pos[2] + f.dir[2] * 10);
        s.light.target.updateMatrixWorld();
        const wantCone = !s.shadowed || !opts.volumetric;
        s.cone.visible = wantCone && k > 0.01;
        if (s.cone.visible) {
          s.cone.position.copy(s.light.position);
          s.cone.lookAt(s.light.target.position);
          // own beam: fainter (camera is inside it)
          s.coneK.value = cfg.cone * k * (f.local ? 0.35 : 1) * (f.tier === 2 ? 1.2 : 1);
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
void mix; void vec2;
