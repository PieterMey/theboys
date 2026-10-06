// Owner: track ③ Render. Ceiling fixture lights: a fixed pool of unshadowed PointLights (batched by
// DynamicLighting, clamped to the preset max every frame) + instanced emissive tubes and soft halo shells for
// every fixture (fixtures never light the fog, so the glow is faked). Power overrides + monster flicker.
import * as THREE from 'three/webgpu';
import { attribute, normalView, positionView, smoothstep, color as tslColor, float } from 'three/tsl';
import type { FixtureInfo, V3 } from './types.ts';

export interface FixtureCfg {
  color: string;
  intensity: number;
  distance: number;
  decay: number;
  halo: number;
  tube: number;
}

export interface FixturePool {
  lights: THREE.PointLight[];
  update(src: { fixtures: FixtureInfo[]; visibleSpaces?: (cam: V3) => Set<number> } | null, cam: THREE.Camera, t: number, opts: { max: number; reduceFlicker: boolean }): void;
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

export function createFixturePool(scene: THREE.Scene, cfg: FixtureCfg, poolSize: number): FixturePool {
  const color = new THREE.Color(cfg.color);
  const lights: THREE.PointLight[] = [];
  for (let i = 0; i < poolSize; i++) {
    const l = new THREE.PointLight(color, 0, cfg.distance, cfg.decay);
    l.castShadow = false;
    l.name = `fixture-${i}`;
    l.position.set(0, -400, 0);
    scene.add(l);
    lights.push(l);
  }

  // instanced tube + halo shell (per-instance brightness in a custom attribute; one draw each)
  const tubeGeo = new THREE.BoxGeometry(1.25, 0.05, 0.14);
  const haloGeo = new THREE.SphereGeometry(1, 16, 10);
  const tubeMat = new THREE.MeshBasicNodeMaterial();
  const lvlT = attribute('fixLevel', 'float');
  tubeMat.colorNode = tslColor(color).mul(lvlT.mul(cfg.tube).add(0.004));
  tubeMat.fog = false;
  const haloMat = new THREE.MeshBasicNodeMaterial();
  haloMat.transparent = true;
  haloMat.depthWrite = false;
  haloMat.blending = THREE.AdditiveBlending;
  haloMat.fog = false;
  const lvlH = attribute('fixLevel', 'float');
  const facing = normalView.dot(positionView.normalize().negate()).clamp(0, 1);
  haloMat.colorNode = tslColor(color).mul(smoothstep(0.0, 1.0, facing).pow(3).mul(lvlH).mul(cfg.halo));
  haloMat.side = THREE.FrontSide;
  void float;

  let tubes: THREE.InstancedMesh | null = null;
  let halos: THREE.InstancedMesh | null = null;
  let levelAttr: THREE.InstancedBufferAttribute | null = null;
  let lastList: FixtureInfo[] | null = null;
  const powerSpace = new Map<number, boolean>();
  let powerAll = true;
  const strobeUntil = new Map<number, number>();
  let lit = 0;

  function rebuild(list: FixtureInfo[]) {
    if (tubes) { scene.remove(tubes); tubes.dispose(); }
    if (halos) { scene.remove(halos); halos.dispose(); }
    const n = Math.max(1, list.length);
    const arr = new Float32Array(n);
    levelAttr = new THREE.InstancedBufferAttribute(arr, 1);
    levelAttr.setUsage(THREE.DynamicDrawUsage);
    const tg = tubeGeo.clone();
    tg.setAttribute('fixLevel', levelAttr);
    const hg = haloGeo.clone();
    hg.setAttribute('fixLevel', levelAttr);
    tubes = new THREE.InstancedMesh(tg, tubeMat, n);
    halos = new THREE.InstancedMesh(hg, haloMat, n);
    tubes.name = 'fixture-tubes';
    halos.name = 'fixture-halos';
    halos.renderOrder = 9;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      p.set(f.pos[0], f.pos[1], f.pos[2]);
      q.identity();
      s.set(1, 1, 1);
      tubes.setMatrixAt(i, m.compose(p, q, s));
      s.set(1.1, 0.32, 0.45);
      halos.setMatrixAt(i, m.compose(p.clone().add(new THREE.Vector3(0, -0.06, 0)), q, s));
    }
    if (!list.length) { tubes.count = 0; halos.count = 0; }
    tubes.frustumCulled = false;
    halos.frustumCulled = false;
    scene.add(tubes, halos);
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
        if (lv > 0.001 && (!vis || vis.has(f.space))) order.push(i);
      }
      if (levelAttr) levelAttr.needsUpdate = true;
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
          l.position.set(f.pos[0], f.pos[1] - 0.22, f.pos[2]);
          l.intensity = cfg.intensity * (levels ? levels[idx] : 1);
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
