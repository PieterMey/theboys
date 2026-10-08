// Owner: env-render (v1.2). ONE density function (environment critic #1). This file owns ALL extinction and the
// ambient / lit-air in-scatter on EVERY preset, as scene.fogNode (so it also applies inside mirror renders):
//   sigma(p) = haze(y) + groundMist(y; noise-carved top) + local fog volumes
//   - haze: d0 * exp(-y / Hs) (closed-form integral along the view ray)
//   - ground mist 0..~1.2 m: m * sat((top - y) / soft), top and density carved by a noise bank sampled where the
//     ray crosses y = 1.2 (closed-form integral of the linear ramp)
//   - local volumes (setFogVolumes, <= 8, a table row of the light grid texture): closed-form chord integral of a
//     (1 - d^2 / r^2) profile; 'ground' volumes hug the floor
//   - a 1.5 m clear bubble around the camera; extinction capped at 60 % within 15 m (relaxes beyond)
//   - in-scatter colour mixed from 3 light-grid samples along the ray (the camera-side one from a main-camera
//     uniform: inside a mirror cameraPosition is the virtual camera behind the wall) + a dark floor + moonlight
// mist.ts (Medium+) adds ONLY shadowed-light in-scatter through the same density (fogDensityAt), attenuated by its
// own transmittance, added the same way on every preset (no scene x T).
// Lit materials, fogNode and the volume material only get plain uniforms in the render group (no new uniform
// buffers: they sit at 12/12) and the shared grid + noise textures (textures with the same texture share a binding).
import * as THREE from 'three/webgpu';
import {
  Fn, Loop, cameraPosition, exp, float, max, min, mix, output, positionWorld, renderGroup, smoothstep, texture3D, time,
  uniform, vec3, vec4, int, select,
} from 'three/tsl';
import type { GridNodes } from './lightgrid.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

export interface FogCfg {
  /** dark floor of the in-scatter (fog colour in an unlit space), indoor / outdoor */
  color: string;
  outdoorColor: string;
  /** haze extinction at y = 0 (1/m) indoor / outdoor, and its scale height (m) */
  haze: number;
  outdoorHaze: number;
  hazeHeight: number;
  /** ground mist extinction (1/m), top (m), soft edge (m), outdoor multiplier */
  mist: number;
  mistTop: number;
  mistSoft: number;
  outdoorMist: number;
  /** noise bank frequency (1/m) for the mist top + mid-ray haze breakup, and the wind drift (m/s) */
  bankScale: number;
  hazeScale: number;
  wind: [number, number, number];
  /** lit air: in-scatter = grid irradiance proxy x litK */
  litK: number;
  /** moon in-scatter colour (outdoors, x outdoor factor) */
  moon: string;
  /** clear bubble around the camera (m) */
  bubble: number;
  /** minimum transmittance within capNear m (0.4 = at most 60 % extinction), relaxing to 0 at capFar */
  capT: number;
  capNear: number;
  capFar: number;
  /** frost tint of volumes with frost > 0 */
  frost: string;
}

export const FOG_DEFAULTS: FogCfg = {
  color: '#05070a', outdoorColor: '#0a0f16',
  haze: 0.028, outdoorHaze: 0.016, hazeHeight: 6,
  mist: 0.06, mistTop: 1.15, mistSoft: 0.6, outdoorMist: 1.4,
  bankScale: 0.085, hazeScale: 0.21, wind: [0.09, 0.012, 0.05],
  litK: 0.0065, moon: '#2c3848',
  bubble: 1.5, capT: 0.4, capNear: 15, capFar: 40,
  frost: '#cfe4ff',
};

export interface FogUniforms {
  /** x d0 (1/m), y Hs (m), z mist m (1/m), w mist top (m) */
  a: { value: THREE.Vector4 };
  /** x mist soft (m), y bubble (m), z capT, w capNear */
  b: { value: THREE.Vector4 };
  /** x capFar, y bankScale, z hazeScale, w litK */
  c: { value: THREE.Vector4 };
  /** xyz wind (m/s), w outdoor factor 0..1 */
  wind: { value: THREE.Vector4 };
  /** dark in-scatter floor (linear rgb) */
  color: { value: THREE.Color };
  /** moon in-scatter (linear rgb, already x outdoor factor) */
  moon: { value: THREE.Color };
  /** grid irradiance proxy at the MAIN camera (rgb) */
  camGrid: { value: THREE.Color };
  /** the main camera room's params (mist, haze, frost, steam) */
  camRoom: { value: THREE.Vector4 };
  /** frost tint */
  frost: { value: THREE.Color };
  /** global fog multiplier (0 = no fog, debug / boot check) */
  k: { value: number };
}

export function createFogUniforms(cfg: FogCfg): FogUniforms {
  const col = (s: string) => new THREE.Color(s);
  return {
    a: { value: new THREE.Vector4(cfg.haze, cfg.hazeHeight, cfg.mist, cfg.mistTop) },
    b: { value: new THREE.Vector4(cfg.mistSoft, cfg.bubble, cfg.capT, cfg.capNear) },
    c: { value: new THREE.Vector4(cfg.capFar, cfg.bankScale, cfg.hazeScale, cfg.litK) },
    wind: { value: new THREE.Vector4(cfg.wind[0], cfg.wind[1], cfg.wind[2], 0) },
    color: { value: col(cfg.color) },
    moon: { value: new THREE.Color(0, 0, 0) },
    camGrid: { value: new THREE.Color(0, 0, 0) },
    camRoom: { value: new THREE.Vector4(1, 1, 0, 0) },
    frost: { value: col(cfg.frost) },
    k: { value: 1 },
  };
}

/** TSL handles of the shared fog state (every node built from the same uniform objects) */
export interface FogNodes {
  a: N; b: N; c: N; wind: N; color: N; moon: N; camGrid: N; camRoom: N; frost: N; k: N;
  noise: THREE.Data3DTexture;
  grid: GridNodes;
}

export function fogNodes(u: FogUniforms, grid: GridNodes, noise: THREE.Data3DTexture): FogNodes {
  const U = <T>(o: { value: T }) => uniform(o.value as never).setGroup(renderGroup);
  const k = uniform(u.k.value).setGroup(renderGroup);
  // keep the scalar uniform live: callers write u.k.value, we mirror it every render
  (k as unknown as { onRenderUpdate(fn: () => number): unknown }).onRenderUpdate(() => u.k.value);
  return { a: U(u.a), b: U(u.b), c: U(u.c), wind: U(u.wind), color: U(u.color), moon: U(u.moon), camGrid: U(u.camGrid), camRoom: U(u.camRoom), frost: U(u.frost), k, noise, grid };
}

const sat = (x: N) => x.clamp(0, 1);

/** 0..1 bank noise over (x, z) (the y = 1.2 crossing) and the haze breakup at a 3D point */
function bankNoise(F: FogNodes, x: N, z: N): N {
  const drift = F.wind.xyz.mul(time);
  return texture3D(F.noise, vec3(x.mul(F.c.y), float(0.37), z.mul(F.c.y)).add(drift.mul(F.c.y))).r;
}
function hazeNoise(F: FogNodes, p: N): N {
  const drift = F.wind.xyz.mul(time).mul(1.7);
  return texture3D(F.noise, p.mul(F.c.z).add(drift.mul(F.c.z)).add(vec3(0.21, 0.53, 0.77))).r;
}

/** antiderivative of the ground-mist ramp sat((h - y) / w) */
function rampG(y: N, h: N, w: N): N {
  const cp = y.sub(h.sub(w)).clamp(0, w);
  return min(y, h.sub(w)).add(cp).sub(cp.mul(cp).div(w.mul(2)));
}

/** closed-form chord integral of density (1 - d^2/r^2)+ for the segment A + s*dir, s in [0, len] */
function sphereChord(A: N, dir: N, len: N, c: N, r: N): N {
  const oc = c.sub(A);
  const tc = oc.dot(dir); // closest approach along the ray
  const b2 = oc.dot(oc).sub(tc.mul(tc)); // squared closest distance
  const h2 = r.mul(r).sub(b2);
  const hh = h2.max(0).sqrt();
  // integrate (h^2 - s^2) / r^2 for s in [max(-h, -tc), min(h, len - tc)]
  const s0 = max(hh.negate(), tc.negate());
  const s1 = min(hh, len.sub(tc));
  const F = (s: N) => h2.mul(s).sub(s.mul(s).mul(s).div(3));
  return select(s1.greaterThan(s0).and(h2.greaterThan(0)), F(s1).sub(F(s0)).div(r.mul(r)), float(0));
}

/**
 * Point density (extinction, 1/m) of the shared medium at world p (for the mist march). camRoomMul / tag params as
 * in the fog integral: the march samples the fragment-side room params once per pixel (passed in).
 */
export function fogDensityAt(F: FogNodes, p: N, room: N): N {
  const nb = bankNoise(F, p.x, p.z);
  const nh = hazeNoise(F, p);
  const haze = F.a.x.mul(room.y).mul(nh.mul(0.5).add(0.75)).mul(exp(p.y.max(0).negate().div(F.a.y)));
  const top = F.a.w.mul(nb.mul(0.8).add(0.6));
  const mist = F.a.z.mul(room.x).mul(nb.mul(1.2).add(0.4)).mul(sat(top.sub(p.y).div(F.b.x)));
  const d = haze.add(mist).toVar();
  const nv = int(F.grid.rows.y);
  Loop(nv, ({ i }: { i: N }) => {
    const v = F.grid.volume(i);
    const r = v.a.w;
    const q = sat(float(1).sub(p.sub(v.a.xyz).dot(p.sub(v.a.xyz)).div(r.mul(r))));
    const ground = select(v.b.z.greaterThan(0.5), sat(float(1.4).sub(p.y).div(0.8)), float(1));
    d.addAssign(v.b.x.mul(q).mul(ground));
  });
  return d.mul(F.k);
}

/**
 * The scene fog node: transmittance from the closed-form optical depth camera -> fragment (bubble + cap), plus the
 * in-scatter colour. Returns vec4(output.rgb * T + Cin * (1 - T), output.a).
 */
export function buildFogNode(F: FogNodes): N {
  return Fn(() => {
    const P = positionWorld.toVar();
    const C = cameraPosition.toVar();
    const V = P.sub(C).toVar();
    const L = V.length().max(1e-4).toVar();
    const dir = V.div(L).toVar();
    const t0 = min(L, F.b.y);
    const A = C.add(dir.mul(t0)).toVar();
    const len = L.sub(t0).toVar();
    const y0 = A.y, y1 = P.y;
    const dy = y1.sub(y0).toVar();
    const safeDy = select(dy.abs().lessThan(1e-3), float(1e-3), dy);
    // noise bank where the ray crosses the mist top (y ~ 1.2), haze breakup at the middle of the ray (<= 12 m out)
    const sx = sat(float(1.2).sub(y0).div(safeDy));
    const X = mix(A, P, sx);
    const nb = bankNoise(F, X.x, X.z);
    const M = A.add(dir.mul(min(len.mul(0.5), 12))).toVar();
    const nh = hazeNoise(F, M);
    // room params: camera room (uniform) + the fragment's room (tag lookup), averaged
    const tagP = F.grid.tagAt(P.x.sub(dir.x.mul(0.3)), P.z.sub(dir.z.mul(0.3))).toVar();
    const roomP = F.grid.spaceParams(tagP);
    const room = (select(tagP.lessThan(-0.5), F.camRoom, F.camRoom.add(roomP).mul(0.5)) as N).toVar() as N;
    // haze: d0 * exp(-y / Hs), average of the exponential over [y0, y1]
    const Hs = F.a.y;
    const e0 = exp(y0.max(0).negate().div(Hs));
    const e1 = exp(y1.max(0).negate().div(Hs));
    const avgExp = select(dy.abs().lessThan(1e-3), e0, Hs.mul(e0.sub(e1)).div(safeDy));
    const tauHaze = F.a.x.mul(room.y).mul(nh.mul(0.5).add(0.75)).mul(len).mul(avgExp.max(0));
    // ground mist: m * sat((top - y) / soft), top carved by the bank noise
    const w = F.b.x;
    const top = F.a.w.mul(nb.mul(0.8).add(0.6)).max(w.add(0.05));
    const g0 = rampG(y0, top, w);
    const g1 = rampG(y1, top, w);
    const f0 = sat(top.sub(y0).div(w));
    const avgRamp = select(dy.abs().lessThan(1e-3), f0, g1.sub(g0).div(safeDy));
    const tauMist = F.a.z.mul(room.x).mul(nb.mul(1.2).add(0.4)).mul(len).mul(avgRamp.max(0));
    // local volumes (cold spots, steam): chord integrals, their colour weighted by their share of the depth
    const tauVol = float(0).toVar();
    const volCol = vec3(0).toVar();
    const frostK = float(0).toVar();
    const nv = int(F.grid.rows.y);
    Loop(nv, ({ i }: { i: N }) => {
      const v = F.grid.volume(i);
      const chord = sphereChord(A, dir, len, v.a.xyz, v.a.w);
      // floor-hugging volumes: weight by how low the chord runs (cheap: the segment's lower end height)
      const ground = select(v.b.z.greaterThan(0.5), sat(float(1.4).sub(min(y0, y1)).div(0.8)), float(1));
      const t = v.b.x.mul(chord).mul(ground);
      tauVol.addAssign(t);
      volCol.addAssign(v.c.rgb.mul(t));
      frostK.addAssign(v.b.y.mul(t));
    });
    const tau = tauHaze.add(tauMist).add(tauVol).mul(F.k).toVar();
    const Tmin = F.b.z.mul(float(1).sub(smoothstep(F.b.w, F.c.x, L)));
    const T = max(exp(tau.negate()), Tmin).toVar();
    // in-scatter colour: dark floor + lit air from 3 grid samples (camera side = main-camera uniform) + moon
    const gMid = F.grid.bilinear(M.x, M.z, float(-2));
    const Pf = P.sub(dir.mul(min(len, 0.3)));
    const gFar = F.grid.bilinear(Pf.x, Pf.z, float(-2));
    const lit = F.camGrid.mul(0.34).add(gMid.mul(0.33)).add(gFar.mul(0.33)).mul(F.c.w);
    const volShare = tauVol.div(tau.max(1e-4)).clamp(0, 1);
    const volTint = volCol.div(tauVol.max(1e-4));
    const frost = frostK.div(tauVol.max(1e-4)).clamp(0, 1).mul(volShare);
    const base = F.color.add(lit).add(F.moon).toVar();
    const cin = mix(base, base.mul(volTint.mul(1.6)).add(volTint.mul(0.02)), volShare.mul(0.6));
    const cin2 = mix(cin, cin.add(F.frost.mul(0.03)).mul(mix(vec3(1), F.frost.mul(1.15), frost)), frost);
    const rgb = output.rgb.mul(T).add(cin2.mul(T.oneMinus()));
    return vec4(rgb, output.a);
  })();
}

/** CPU twin of the point density (no noise: the noise mean) for halo scaling, ambient queries and tests */
export function cpuDensity(cfg: { haze: number; hazeHeight: number; mist: number; mistTop: number; mistSoft: number }, x: number, y: number, z: number, vols: readonly { p: [number, number, number]; r: number; density: number; ground?: boolean }[], room = { mist: 1, haze: 1 }): number {
  const haze = cfg.haze * room.haze * Math.exp(-Math.max(0, y) / cfg.hazeHeight);
  const top = cfg.mistTop * (0.6 + 0.8 * 0.45);
  const mist = cfg.mist * room.mist * (0.4 + 1.2 * 0.45) * Math.max(0, Math.min(1, (top - y) / cfg.mistSoft));
  let d = haze + mist;
  for (const v of vols) {
    const dx = x - v.p[0], dy = y - v.p[1], dz = z - v.p[2];
    const q = Math.max(0, 1 - (dx * dx + dy * dy + dz * dz) / (v.r * v.r));
    const g = v.ground ? Math.max(0, Math.min(1, (1.4 - y) / 0.8)) : 1;
    d += v.density * q * g;
  }
  return d;
}

/** CPU twin of the analytic ground-mist ramp integral (tests: matches a brute-force march) */
export function cpuRampAvg(y0: number, y1: number, top: number, soft: number): number {
  const G = (y: number) => { const cp = Math.max(0, Math.min(soft, y - (top - soft))); return Math.min(y, top - soft) + cp - cp * cp / (2 * soft); };
  if (Math.abs(y1 - y0) < 1e-3) return Math.max(0, Math.min(1, (top - y0) / soft));
  return (G(y1) - G(y0)) / (y1 - y0);
}

/** CPU twin of the sphere chord integral */
export function cpuSphereChord(A: [number, number, number], dir: [number, number, number], len: number, c: [number, number, number], r: number): number {
  const oc = [c[0] - A[0], c[1] - A[1], c[2] - A[2]];
  const tc = oc[0] * dir[0] + oc[1] * dir[1] + oc[2] * dir[2];
  const b2 = oc[0] * oc[0] + oc[1] * oc[1] + oc[2] * oc[2] - tc * tc;
  const h2 = r * r - b2;
  if (h2 <= 0) return 0;
  const hh = Math.sqrt(h2);
  const s0 = Math.max(-hh, -tc), s1 = Math.min(hh, len - tc);
  if (s1 <= s0) return 0;
  const F = (s: number) => h2 * s - s * s * s / 3;
  return (F(s1) - F(s0)) / (r * r);
}
