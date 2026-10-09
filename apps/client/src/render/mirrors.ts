// Owner: env-render (v1.2). Mirrors (flag 'mirrors'): a reflector pool + per-mirror glass from ONE factory.
// - Pool: one planar reflector (bounces:false = one update per frame, generateMipmaps for the glass blur). At most 1
//   live mirror on every preset (Ultra 0.5 res, High 0.3 at full rate, half rate only while the camera is still,
//   Medium 0.25 within 5 m, Low none: fallback glass). The render target size is FIXED when a mirror goes live
//   (no reallocation while it stays live) and capped (<= 10 MB with mips + depth); RTs are disposed after ~10 s idle.
// - Candidates: a visible space, <= maxDist, facing, in frustum; scored by projected area with 1.3x hysteresis; the
//   van mirror wins inside the van. Menus / covers / hidden: no live mirror (the reflector also refuses to render).
// - Per mirror: a live mesh (reflection, fog, writing, cracks, tarnish) and the fallback glass (E3's glass mesh with
//   the fallback material: dark glass that still shows fog, writing and cracks), toggled with visible. The reflector
//   target and the ghost group are parented to an always-visible anchor at the glass (the target follows the glass).
// - Wrapped updateBefore: renders with the scene pass's own context (the same shader code: the first live mirror
//   compiles nothing for materials the main view drew) with its AO term switched off by a uniform (never the main
//   view's screen-space AO in the glass); the virtual camera sees main + ghost + self minus first-person, and only
//   while coverMode is 'game' (or the warm-up forces it).
// - The local player's mirror self (players.setMirrorSelf) within 8 m; a batched 'mirror bounce' SpotLight at the
//   local beam's mirror image lights the space behind you; a faint ghost-layer rim light for the figure.
import * as THREE from 'three/webgpu';
import { Fn, abs, float, max, min, mix, reflector, screenUV, smoothstep, texture, uniform, uv, vec2, vec3, fract, sin, dot, clamp } from 'three/tsl';
import { RENDER_LAYERS } from './api.ts';
import type { BeamInfo, MirrorHandle, MirrorKind, MirrorOpts, MirrorService, RenderCoverMode, V3 } from './api.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

export interface MirrorBudget {
  /** live mirrors at once (0 = fallback glass only) */
  live: number;
  /** reflection resolution scale of the drawing buffer */
  scale: number;
  /** candidates within this distance (m) */
  maxDist: number;
  /** update every other frame while the camera is still */
  halfRateStill: boolean;
}

export const MIRROR_BUDGETS: Record<string, MirrorBudget> = {
  // v1.3 (4e): Lite never renders a reflection (the fallback glass)
  lite: { live: 0, scale: 0.25, maxDist: 0, halfRateStill: true },
  low: { live: 0, scale: 0.25, maxDist: 0, halfRateStill: true },
  medium: { live: 1, scale: 0.25, maxDist: 5, halfRateStill: true },
  high: { live: 1, scale: 0.3, maxDist: 8, halfRateStill: true },
  ultra: { live: 1, scale: 0.5, maxDist: 8, halfRateStill: false },
};

/** reflection RT pixel cap: 1024 x 576 HalfFloat + mips + depth ~ 8.7 MB */
export const MIRROR_MAX_PIXELS = 1024 * 576;

export interface MirrorCandidate { id: number; score: number; van: boolean }

/**
 * Live-set selection (pure): highest projected area first, the van mirror first while the camera is in the van,
 * the current live mirror kept unless a rival scores > hysteresis x its score. menu = nothing live.
 */
export function chooseLive(cands: readonly MirrorCandidate[], current: readonly number[], budget: number, opts: { menu: boolean; inVan: boolean; hysteresis?: number }): number[] {
  if (opts.menu || budget <= 0) return [];
  const hy = opts.hysteresis ?? 1.3;
  const byId = new Map(cands.map((c) => [c.id, c] as const));
  const rank = (c: MirrorCandidate) => (opts.inVan && c.van ? 1e9 : 0) + c.score;
  const sorted = cands.filter((c) => c.score > 0).sort((a, b) => rank(b) - rank(a) || a.id - b.id);
  const out: number[] = [];
  // keep current ones that are still candidates unless clearly beaten by a non-live rival
  const kept = current.filter((id) => byId.has(id) && byId.get(id)!.score > 0);
  for (const id of kept) {
    if (out.length >= budget) break;
    const me = byId.get(id)!;
    const rival = sorted.find((c) => !kept.includes(c.id) && !out.includes(c.id));
    if (rival && rank(rival) > rank(me) * hy) continue;
    out.push(id);
  }
  for (const c of sorted) {
    if (out.length >= budget) break;
    if (!out.includes(c.id)) out.push(c.id);
  }
  return out.sort((a, b) => a - b);
}

const NO_IDS: number[] = [];
const sameIds = (a: readonly number[], b: readonly number[]) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/** fixed reflection RT size for a drawing buffer and scale: multiples of 8, capped at MIRROR_MAX_PIXELS */
export function fixedReflectorSize(drawW: number, drawH: number, scale: number, maxPixels = MIRROR_MAX_PIXELS): [number, number] {
  let w = Math.max(8, drawW * scale), h = Math.max(8, drawH * scale);
  const px = w * h;
  if (px > maxPixels) { const k = Math.sqrt(maxPixels / px); w *= k; h *= k; }
  return [Math.max(8, Math.round(w / 8) * 8), Math.max(8, Math.round(h / 8) * 8)];
}

/** projected-area score of a glass for a camera (0 = behind / facing away / beyond maxDist) */
export function mirrorScore(cam: V3, glass: V3, normal: V3, w: number, h: number, maxDist: number): number {
  const dx = cam[0] - glass[0], dy = cam[1] - glass[1], dz = cam[2] - glass[2];
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 > maxDist * maxDist) return 0;
  const d = Math.sqrt(d2) || 1e-3;
  const facing = (dx * normal[0] + dy * normal[1] + dz * normal[2]) / d;
  if (facing <= 0.05) return 0;
  return (w * h * facing) / Math.max(0.25, d2);
}

// ------------------------------------------------------------------------------------------------ glass factory

const BLACK = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
// filterable like the CanvasTextures E4 swaps in (the binding layout must not change: sampler + filterable float)
BLACK.minFilter = THREE.LinearFilter;
BLACK.magFilter = THREE.LinearFilter;
BLACK.needsUpdate = true;
BLACK.name = 'mirror-no-writing';

interface GlassUniforms { fogK: N; reveal: N; crackK: N; crackSeed: N; tarnish: N; aspect: N; writing: N }

/** procedural cracks: 7 jagged rays from a seeded point (glass uv, aspect-corrected), -> line 0..1 + uv offset */
function crackNodes(u: N, U: GlassUniforms): { line: N; offset: N } {
  const h1 = (n: number): N => fract(sin(U.crackSeed.mul(12.9898).add(n * 78.233)).mul(43758.5453));
  const c: N = vec2(h1(1).mul(0.5).add(0.25), h1(2).mul(0.5).add(0.25));
  const p: N = vec2(u.x.mul(U.aspect), u.y);
  const cc: N = vec2(c.x.mul(U.aspect), c.y);
  let line: N = float(0);
  for (let i = 0; i < 7; i++) {
    const ang = h1(3 + i).add(i / 7).mul(Math.PI * 2);
    const len = h1(11 + i).mul(0.45).add(0.2);
    const dir = vec2(sin(ang.add(Math.PI / 2)), sin(ang));
    const rel = p.sub(cc);
    const t = clamp(dot(rel, dir), 0, len);
    // a slight zig-zag along the ray
    const kink = sin(t.mul(41).add(i * 1.7)).mul(0.006);
    const perp = vec2(dir.y.negate(), dir.x);
    const dist = rel.sub(dir.mul(t)).sub(perp.mul(kink)).length();
    const fade = float(1).sub(t.div(len)).max(0);
    line = max(line, smoothstep(0.0032, 0.0006, dist).mul(fade.mul(0.7).add(0.3)));
  }
  const ring = smoothstep(0.012, 0.0, abs(p.sub(cc).length().sub(h1(31).mul(0.04).add(0.035))));
  line = max(line, ring.mul(0.6)).mul(U.crackK).clamp(0, 1);
  const offset = p.sub(cc).normalize().mul(line).mul(0.006);
  return { line, offset };
}

function makeGlass(refl: N, opts: MirrorOpts): { live: THREE.MeshStandardNodeMaterial; fallback: THREE.MeshStandardNodeMaterial; U: GlassUniforms } {
  const U: GlassUniforms = {
    fogK: uniform(0), reveal: uniform(0), crackK: uniform(0), crackSeed: uniform(0), tarnish: uniform(opts.tarnish ?? 0.12),
    aspect: uniform(Math.max(0.2, opts.w / Math.max(0.05, opts.h))), writing: texture(BLACK),
  };
  const u = uv();
  const cr = crackNodes(u, U);
  const wipe = U.writing.sample(u).r.mul(U.reveal).clamp(0, 1);
  const fogA = U.fogK.mul(wipe.oneMinus()).clamp(0, 1).toVar();
  const edge = U.tarnish.mul(smoothstep(0.3, 0.5, max(abs(u.x.sub(0.5)), abs(u.y.sub(0.5)))));
  // ---- live glass: the reflection (light mip blur against TRAA smear), heavier blur under condensation
  const ruv = screenUV.flipX().add(cr.offset);
  const r0 = refl.sample(ruv).level(0.7);
  const r1 = refl.sample(ruv).level(4.5);
  const tint = vec3(0.86, 0.9, 0.88);
  const reflCol = mix(r0.rgb, r1.rgb.mul(0.5), fogA).mul(tint).mul(edge.oneMinus()).mul(cr.line.mul(0.55).oneMinus());
  const live = new THREE.MeshStandardNodeMaterial({ color: 0x050606, roughness: 0.07, metalness: 0 });
  live.colorNode = mix(vec3(0.012), vec3(0.3, 0.32, 0.33), fogA).add(cr.line.mul(0.22));
  live.roughnessNode = mix(float(0.07), float(0.55), fogA).add(cr.line.mul(0.3)).clamp(0.04, 1);
  live.emissiveNode = reflCol;
  // the reflection already carries the fog of the whole path (camera -> glass -> object)
  live.fog = false;
  live.name = 'mirror-live';
  // ---- fallback glass: dark silvered glass (analytic highlights only), condensation, writing marks, cracks
  const fb = new THREE.MeshStandardNodeMaterial({ color: 0x0b0c0d, roughness: 0.05, metalness: 0.9 });
  const marks = U.writing.sample(u).r.mul(U.reveal).mul(U.fogK.oneMinus());
  fb.colorNode = mix(vec3(0.03, 0.033, 0.036), vec3(0.3, 0.32, 0.33), fogA).add(cr.line.mul(0.28)).add(marks.mul(0.05)).mul(edge.mul(0.6).oneMinus());
  fb.roughnessNode = mix(float(0.05), float(0.55), fogA).add(marks.mul(0.25)).add(cr.line.mul(0.3)).clamp(0.04, 1);
  fb.metalnessNode = mix(float(0.9), float(0.0), fogA.max(cr.line));
  fb.name = 'mirror-fallback';
  void min;
  return { live, fallback: fb, U };
}

// ------------------------------------------------------------------------------------------------ service

interface Mirror {
  id: number;
  opts: MirrorOpts;
  glass: THREE.Mesh;
  anchor: THREE.Group;
  liveMesh: THREE.Mesh;
  ghost: THREE.Group;
  U: GlassUniforms;
  fbMat: THREE.Material;
  live: boolean;
  handle: MirrorHandle;
  disposed: boolean;
}

export interface MirrorDeps {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** flag 'mirrors' (false = fallback glass only) */
  enabled: boolean;
  budget(): MirrorBudget;
  coverMode(): RenderCoverMode;
  visibleSpaces(cam: V3): Set<number> | null;
  /** the camera's space is the van */
  inVan(): boolean;
  localBeam(): BeamInfo | null;
  players(): { setMirrorSelf?(on: boolean): THREE.Object3D | null } | undefined;
  /** context for the reflection render (the scene pass's own context: shared programs); null = the renderer's default */
  reflectionContext(): N | null;
  /** true / false around each reflection render (the scene-pass context's AO term off while it renders) */
  reflecting?(on: boolean): void;
  /** ?rdebug=mirrornested: the stock reflector path (rendered nested inside the first pass that draws the glass) */
  nested?: boolean;
  /** v1.3 (4b): a dark bounce / rim light gets visible=false (it leaves the batched per-pixel light loop) */
  hideIdle?(): boolean;
}

export interface MirrorSystem extends MirrorService {
  /** per frame, before the draw: candidates, live set, fixed sizes, self, bounce light, idle disposal */
  update(now: number, dt: number): void;
  /** the warm set: a forced reflection over the warm proxies (parent = the proxies group in front of the camera) */
  warm(parent: THREE.Object3D | null): void;
  /** (re)usable by auto quality: drop the live mirror without touching the budget table */
  setSuspended(on: boolean): void;
  /** spaces holding a registered mirror (the warm set compiles their materials through the reflection) */
  spaces(): number[];
  /** bumps on every register / dispose (render re-warms the mirror rooms when the registered set changes) */
  version(): number;
  bounceLight: THREE.SpotLight;
  rimLight: THREE.PointLight;
  info(): { registered: number; live: number; renders: number; rt: [number, number] | null; suspended: boolean };
  /** render the live reflection now (call once per drawn frame, after the shadows are armed, before the pipeline) */
  renderLive(): void;
  /** diagnostics: { ctx: the reflection context swap, rim: ghost rim light, render: reflection renders, explicit: top-level } */
  debug(p: Partial<{ ctx: boolean; rim: boolean; render: boolean; explicit: boolean }>): Record<string, boolean>;
}

export function createMirrorSystem(d: MirrorDeps): MirrorSystem {
  const mirrors: Mirror[] = [];
  let nextId = 1;
  let liveIds: number[] = [];
  let suspended = false;
  let renders = 0;
  let lastLiveAt = -Infinity;
  let fixed: [number, number] | null = null;
  let warming = false;
  let skipFrame = false;
  let frameN = 0;
  let selfOn = false;
  /** the warm-up wants the mirror self avatar (its pipelines compile through the forced reflection) */
  let selfForced = false;
  let version = 0;
  const lastCam = new THREE.Vector3(1e9, 0, 0);
  const lastQ = new THREE.Quaternion();

  // ---- the pool (1 reflector: at most 1 live mirror on every preset)
  const refl = reflector({ resolutionScale: 0.5, generateMipmaps: true, bounces: false, depth: false }) as N;
  const base = refl.reflector as N;
  base.target.name = 'mirror-reflector-target';
  const origUpdate = base.updateBefore.bind(base);
  const origRes = base._updateResolution.bind(base);
  base._updateResolution = (rt: THREE.RenderTarget, renderer: THREE.WebGPURenderer) => {
    if (fixed) { if (rt.width !== fixed[0] || rt.height !== fixed[1]) rt.setSize(fixed[0], fixed[1]); }
    else origRes(rt, renderer);
  };
  const maskOf = (cam: THREE.Camera) => ((cam.layers.mask | (1 << RENDER_LAYERS.ghost) | (1 << RENDER_LAYERS.self)) & ~(1 << RENDER_LAYERS.firstPerson) & ~(1 << RENDER_LAYERS.vol)) >>> 0;
  /** test / diagnostics toggles (window.__render.mirrorDebug) */
  const dbg = { ctx: true, rim: true, render: true, explicit: d.nested !== true };
  // Wrapped updateBefore. v1.2: the reflection renders EXPLICITLY before the pipeline (renderLive(): a top-level
  // render, never nested inside the pre-pass / scene pass), so the reflector's own per-frame hook is a no-op unless
  // ?rdebug=mirrornested asks for the stock nested path.
  const reflect = (frame: N) => {
    const vcam = base.getVirtualCamera(frame.camera) as THREE.Camera;
    vcam.layers.mask = maskOf(frame.camera);
    const r = d.renderer as unknown as { contextNode: N };
    const prev = r.contextNode;
    const ctxNode = dbg.ctx ? d.reflectionContext() : null;
    if (ctxNode) r.contextNode = ctxNode;
    d.reflecting?.(true);
    try { origUpdate(frame); renders++; } finally { r.contextNode = prev; d.reflecting?.(false); }
  };
  base.updateBefore = (frame: N) => {
    if (dbg.explicit) return undefined;
    if (!warming && (d.coverMode() !== 'game' || suspended || !liveIds.length)) return undefined;
    if (!warming && skipFrame) return undefined;
    if (!dbg.render) return undefined;
    reflect(frame);
    return undefined;
  };

  // ---- warm glass (forced reflection during warm-up frames)
  const warmGlass = makeGlass(refl, { space: -1, w: 0.03, h: 0.03, kind: 'hand' });
  const warmMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.03, 0.03), warmGlass.live);
  warmMesh.name = 'mirror-warm';
  // same render state as every live mesh (receiveShadow is part of the render object's dynamic cache key): the
  // first live mirror view then compiles nothing new (run 4: 170 -> 172 pipelines without it)
  warmMesh.receiveShadow = true;
  warmMesh.frustumCulled = false;
  warmMesh.visible = false;
  const warmFb = new THREE.Mesh(warmMesh.geometry, warmGlass.fallback);
  warmFb.name = 'mirror-warm-fallback';
  warmFb.frustumCulled = false;
  warmFb.visible = false;

  // ---- lights (created once, batched; intensity only)
  const bounceLight = new THREE.SpotLight(0xffffff, 0, 20, 0.5, 0.9, 1.6);
  bounceLight.castShadow = false;
  bounceLight.name = 'mirror-bounce';
  bounceLight.position.set(0, -450, 0);
  bounceLight.target.position.set(0, -451, 0);
  d.scene.add(bounceLight, bounceLight.target);
  const rimLight = new THREE.PointLight(0x9fb6d6, 0, 3.5, 2);
  rimLight.castShadow = false;
  rimLight.name = 'mirror-ghost-rim';
  rimLight.layers.set(RENDER_LAYERS.ghost);
  rimLight.position.set(0, -455, 0);
  d.scene.add(rimLight);

  const tmp = new THREE.Vector3();
  const tmpN = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();
  // per-frame scratch (update() allocates nothing while mirrors are registered)
  const camV: V3 = [0, 0, 0];
  const candBuf: MirrorCandidate[] = [];
  const drawSize = new THREE.Vector2();
  const bo = new THREE.Vector3(), bd = new THREE.Vector3(), bn = new THREE.Vector3(), bh = new THREE.Vector3();
  const bp = new THREE.Vector3(), bN = new THREE.Vector3();
  const frustum = new THREE.Frustum();
  const projScreen = new THREE.Matrix4();
  const sphere = new THREE.Sphere();

  function attached(o: THREE.Object3D): boolean {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p === d.scene) return true;
    return false;
  }

  function setLive(m: Mirror, on: boolean) {
    if (m.live === on) return;
    m.live = on;
    m.liveMesh.visible = on;
    // the fallback glass hides through its own (per-mirror) material: children of the level's glass mesh (a frame,
    // a bulb strip) stay visible, and a coplanar fallback never shows in its own reflection
    m.fbMat.visible = !on;
    if (on) m.anchor.add(base.target);
  }

  function dispose(m: Mirror) {
    if (m.disposed) return;
    m.disposed = true;
    setLive(m, false);
    if (base.target.parent === m.anchor) m.anchor.remove(base.target);
    m.anchor.removeFromParent();
    // the glass geometry belongs to the level; only our live material goes
    (m.liveMesh.material as THREE.Material).dispose();
    const i = mirrors.indexOf(m);
    if (i >= 0) mirrors.splice(i, 1);
    liveIds = liveIds.filter((id) => id !== m.id);
    version++;
  }

  const sys: MirrorSystem = {
    bounceLight,
    rimLight,
    register(glass, opts) {
      const id = nextId++;
      const mats = makeGlass(refl, opts);
      glass.material = mats.fallback;
      const anchor = new THREE.Group();
      anchor.name = `mirror:${opts.itemId ?? id}`;
      const liveMesh = new THREE.Mesh(glass.geometry, mats.live);
      liveMesh.name = 'mirror-live';
      liveMesh.visible = false;
      liveMesh.scale.copy(glass.scale);
      liveMesh.receiveShadow = true;
      anchor.add(liveMesh);
      const ghost = new THREE.Group();
      ghost.name = 'mirror-ghost';
      ghost.layers.set(RENDER_LAYERS.ghost);
      anchor.add(ghost);
      (glass.parent ?? d.scene).add(anchor);
      anchor.position.copy(glass.position);
      anchor.quaternion.copy(glass.quaternion);
      let m: Mirror;
      const handle: MirrorHandle = {
        id,
        itemId: opts.itemId ?? null,
        live: () => m.live,
        setFog(k) { m.U.fogK.value = Math.max(0, Math.min(1, k)); },
        setWriting(mask, reveal = 1) { m.U.writing.value = mask ?? BLACK; m.U.reveal.value = mask ? Math.max(0, Math.min(1, reveal)) : 0; },
        setCrack(k, seed = id * 7.31) { m.U.crackK.value = Math.max(0, Math.min(1, k)); m.U.crackSeed.value = seed % 1000; },
        ghost,
        dispose: () => dispose(m),
      };
      m = { id, opts, glass, anchor, liveMesh, ghost, U: mats.U, fbMat: mats.fallback, live: false, handle, disposed: false };
      mirrors.push(m);
      version++;
      return handle;
    },
    list: () => mirrors.map((m) => m.handle),
    liveCount: () => mirrors.filter((m) => m.live).length,
    setSuspended(on) { suspended = on; },
    renderLive() {
      if (!dbg.explicit || !dbg.render) return;
      let mat: THREE.Material | null = null;
      if (warming) mat = warmMesh.material as THREE.Material;
      else {
        if (d.coverMode() !== 'game' || suspended || !liveIds.length || skipFrame) return;
        const m = mirrors.find((x) => x.id === liveIds[0]);
        if (!m || !m.live) return;
        mat = m.liveMesh.material as THREE.Material;
      }
      // a top-level render (never nested in a pipeline pass): the stock hook hides `material` (the live glass) in
      // its own reflection and renders the scene from the mirrored camera into the fixed-size target
      reflect({ scene: d.scene, camera: d.camera, renderer: d.renderer, material: mat });
    },
    debug(p) {
      Object.assign(dbg, Object.fromEntries(Object.entries(p).filter(([, v]) => typeof v === 'boolean')));
      rimLight.visible = dbg.rim;
      return { ...dbg };
    },
    spaces: () => [...new Set(mirrors.map((m) => m.opts.space).filter((x) => x >= 0))],
    version: () => version,
    info: () => ({ registered: mirrors.length, live: mirrors.filter((m) => m.live).length, renders, rt: fixed, suspended }),
    warm(parent) {
      selfForced = !!parent && d.enabled && d.budget().live > 0;
      if (!parent) {
        warming = false;
        base.forceUpdate = false;
        warmMesh.visible = false;
        warmFb.visible = false;
        warmMesh.removeFromParent();
        warmFb.removeFromParent();
        return;
      }
      warming = true;
      if (warmMesh.parent !== parent) { parent.add(warmMesh); parent.add(warmFb); }
      warmMesh.position.set(0.12, -0.05, -1.6);
      warmFb.position.set(0.16, -0.05, -1.6);
      warmMesh.visible = true;
      warmFb.visible = true;
      warmMesh.add(base.target);
      base.forceUpdate = true;
      if (!fixed) fixed = [64, 36];
    },
    update(now, dt) {
      void dt;
      frameN++;
      // detached glass (level rebuilt without dispose): drop the mirror
      for (let i = mirrors.length - 1; i >= 0; i--) if (!attached(mirrors[i].glass)) dispose(mirrors[i]);
      const cam = d.camera;
      const cp = camV;
      cp[0] = cam.position.x; cp[1] = cam.position.y; cp[2] = cam.position.z;
      const budget = d.enabled && !suspended ? d.budget() : { live: 0, scale: 0, maxDist: 0, halfRateStill: true };
      const menu = d.coverMode() !== 'game';
      // keep the anchors on their glass (props may move) and the ghost children on the ghost layer only
      for (const m of mirrors) {
        if (m.glass.parent && m.anchor.parent !== m.glass.parent) m.glass.parent.add(m.anchor);
        m.anchor.position.copy(m.glass.position);
        m.anchor.quaternion.copy(m.glass.quaternion);
        m.liveMesh.scale.copy(m.glass.scale);
        if (m.ghost.children.length) m.ghost.traverse((o) => { if (o.layers.mask !== 1 << RENDER_LAYERS.ghost) o.layers.set(RENDER_LAYERS.ghost); (o as THREE.Mesh).castShadow = false; });
      }
      const cands = candBuf;
      cands.length = 0;
      let nearest = Infinity;
      if (mirrors.length) {
        const vis = d.visibleSpaces(cp);
        projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
        frustum.setFromProjectionMatrix(projScreen, cam.coordinateSystem);
        for (const m of mirrors) {
          m.glass.getWorldPosition(tmp);
          if (vis && m.opts.space >= 0 && !vis.has(m.opts.space)) continue;
          const dist = tmp.distanceTo(cam.position);
          nearest = Math.min(nearest, dist);
          if (budget.live <= 0) continue;
          m.glass.getWorldQuaternion(tmpQ);
          tmpN.set(0, 0, 1).applyQuaternion(tmpQ);
          sphere.center.copy(tmp);
          sphere.radius = 0.5 * Math.hypot(m.opts.w, m.opts.h);
          if (!frustum.intersectsSphere(sphere)) continue;
          const s = mirrorScore(cp, [tmp.x, tmp.y, tmp.z], [tmpN.x, tmpN.y, tmpN.z], m.opts.w, m.opts.h, budget.maxDist) * (m.opts.priority ?? 1);
          if (s > 0) cands.push({ id: m.id, score: s, van: m.opts.kind === ('van' as MirrorKind) });
        }
      }
      if (menu) cands.length = 0;
      const next = !cands.length && !liveIds.length ? NO_IDS : chooseLive(cands, liveIds, budget.live, { menu, inVan: d.inVan() });
      if (!sameIds(next, liveIds)) {
        // a mirror goes live: fix the reflection size now (no reallocation while it stays live)
        if (next.length) {
          d.renderer.getDrawingBufferSize(drawSize);
          fixed = fixedReflectorSize(drawSize.x, drawSize.y, budget.scale);
        }
        liveIds = next;
      }
      for (const m of mirrors) setLive(m, liveIds.indexOf(m.id) >= 0);
      if (liveIds.length) lastLiveAt = now;
      // half rate while the camera is still (High / Medium): skip every other reflection update
      const moved = lastCam.distanceToSquared(cam.position) > 1e-6 || Math.abs(lastQ.dot(cam.quaternion)) < 0.999999;
      lastCam.copy(cam.position);
      lastQ.copy(cam.quaternion);
      skipFrame = budget.halfRateStill && !moved && (frameN & 1) === 1;
      // idle: free the reflection targets after ~10 s without a live mirror
      if (!liveIds.length && !warming && now - lastLiveAt > 10_000 && base.renderTargets.size) {
        for (const rt of base.renderTargets.values()) (rt as THREE.RenderTarget).dispose();
        base.renderTargets.clear();
        fixed = null;
      }
      // the local player's mirror self within 8 m of a mirror (game only)
      const wantSelf = selfForced || (!menu && d.enabled && nearest <= 8);
      if (wantSelf !== selfOn) {
        selfOn = wantSelf;
        try { d.players()?.setMirrorSelf?.(wantSelf); } catch { /* players track mid-edit */ }
      }
      // mirror bounce: the local beam hitting a nearby mirror lights the space behind you (its mirror image)
      bounceLight.intensity = 0;
      rimLight.intensity = 0;
      const beam = d.localBeam();
      if (beam && mirrors.length && !menu) {
        let best: Mirror | null = null;
        let bestK = 0;
        const o = bo.set(beam.pos[0], beam.pos[1], beam.pos[2]);
        const dir = bd.set(beam.dir[0], beam.dir[1], beam.dir[2]);
        for (const m of mirrors) {
          m.glass.getWorldPosition(tmp);
          if (tmp.distanceTo(o) > 8) continue;
          m.glass.getWorldQuaternion(tmpQ);
          const n = bn.set(0, 0, 1).applyQuaternion(tmpQ);
          const denom = dir.dot(n);
          if (denom > -0.05) continue;
          const t = bh.copy(tmp).sub(o).dot(n) / denom;
          if (t <= 0.1 || t > 8) continue;
          // hit within the glass (local x/y), with the beam footprint as margin
          const local = bh.copy(o).addScaledVector(dir, t).sub(tmp).applyQuaternion(tmpQ.invert());
          const foot = Math.tan(beam.angle * 0.6) * t;
          const ox = Math.max(0, Math.abs(local.x) - m.opts.w / 2), oy = Math.max(0, Math.abs(local.y) - m.opts.h / 2);
          const miss = Math.hypot(ox, oy) / Math.max(0.05, foot);
          if (miss > 1) continue;
          const area = (m.opts.w * m.opts.h) / Math.max(0.05, Math.PI * foot * foot);
          const k = Math.min(1, area) * (1 - miss) * Math.min(1, -denom * 1.5);
          if (!best || k > bestK) { best = m; bestK = k; bp.copy(tmp); bN.copy(n); }
        }
        if (best && bestK > 0.01) {
          // mirror image of the lens across the glass plane, aimed along the reflected beam
          const dist = bh.copy(o).sub(bp).dot(bN);
          bounceLight.position.copy(o).addScaledVector(bN, -2 * dist);
          const rdir = bh.copy(dir).reflect(bN);
          bounceLight.target.position.copy(bounceLight.position).addScaledVector(rdir, 4);
          bounceLight.angle = Math.min(1.2, beam.angle * 1.05);
          bounceLight.distance = beam.range;
          bounceLight.intensity = beam.intensity * 0.72 * bestK;
          bounceLight.target.updateMatrixWorld();
          // faint cold rim on whatever stands in the ghost group (ghost layer only: seen in reflections)
          if (best.ghost.children.length) {
            best.ghost.getWorldPosition(tmp);
            rimLight.position.copy(tmp).addScaledVector(bN, 0.6);
            rimLight.position.y += 1.4;
            rimLight.intensity = 0.6;
          }
        }
      }
      if (bounceLight.intensity === 0) { bounceLight.position.set(0, -450, 0); bounceLight.target.position.set(0, -451, 0); }
      if (rimLight.intensity === 0) rimLight.position.set(0, -455, 0);
      // v1.3 (4b): dark = out of the batched light loop (no recompile: batched light types never leave DynamicLighting's
      // set, the fixture pool keeps one sentinel per type)
      const hide = d.hideIdle?.() === true;
      bounceLight.visible = !hide || bounceLight.intensity > 0;
      rimLight.visible = dbg.rim && (!hide || rimLight.intensity > 0);
    },
  };
  void origRes;
  return sys;
}
