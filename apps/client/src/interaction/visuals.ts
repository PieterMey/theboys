// Owner: track (b) Interaction. Procedural item meshes (world items, held view model, thrown bottles), lit glowstick
// markers (emissive only + a floor halo, no lights), revive rings at fresh bodies, and the target glint.
// v1.1 gear: burning flares (emissive stick + halo + one of FLARE_LIGHTS pooled unshadowed SpotLights, created once at
// start-up so DynamicLighting's light-type set never changes mid-game), armed motion sensors (blinking LED), pro
// flashlight, adrenaline syringe, lucky charm and the cursed idol.
import * as THREE from 'three/webgpu';
import { itemDef } from '@dead-air/shared/interactables.ts';
import type { InteractionState, ItemState } from '@dead-air/shared/messages/interaction.ts';

type Mat = THREE.MeshStandardNodeMaterial;

const mats = new Map<string, THREE.Material>();

// real prop models for some world items via ② Level's loader (guarded: absent / failing -> procedural model stays)
const PROP_FOR: Record<string, string> = { crowbar: 'crowbar', medkit: 'medical_box' };
type PropLoader = (key: string) => Promise<THREE.Object3D | null>;
let propLoader: Promise<PropLoader | null> | null = null;
function propModel(key: string): Promise<THREE.Object3D | null> {
  propLoader ??= import('../level/assets.ts')
    .then((m) => ((m as { loadPropModel?: PropLoader }).loadPropModel ?? null))
    .catch(() => null);
  return propLoader.then((fn) => (fn ? fn(key).catch(() => null) : null));
}
function std(key: string, p: { color: number; rough?: number; metal?: number; emissive?: number; ei?: number; opacity?: number }): Mat {
  let m = mats.get(key) as Mat | undefined;
  if (!m) {
    m = new THREE.MeshStandardNodeMaterial({ color: p.color, roughness: p.rough ?? 0.6, metalness: p.metal ?? 0 });
    if (p.emissive !== undefined) {
      m.emissive = new THREE.Color(p.emissive);
      m.emissiveIntensity = p.ei ?? 1;
    }
    if (p.opacity !== undefined) {
      m.transparent = true;
      m.opacity = p.opacity;
      m.depthWrite = false;
    }
    mats.set(key, m);
  }
  return m;
}

let haloTex: THREE.CanvasTexture | null = null;
function halo(): THREE.CanvasTexture {
  if (haloTex) return haloTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,0.85)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.35)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  haloTex = new THREE.CanvasTexture(c);
  haloTex.colorSpace = THREE.SRGBColorSpace;
  return haloTex;
}

function spriteMat(color: number, opacity: number): THREE.SpriteNodeMaterial {
  const key = `sprite:${color}:${opacity}`;
  let m = mats.get(key) as THREE.SpriteNodeMaterial | undefined;
  if (!m) {
    m = new THREE.SpriteNodeMaterial({ color, map: halo(), transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending });
    mats.set(key, m);
  }
  return m;
}

function haloMat(color: number, opacity: number): THREE.MeshBasicNodeMaterial {
  const key = `halo:${color}:${opacity}`;
  let m = mats.get(key) as THREE.MeshBasicNodeMaterial | undefined;
  if (!m) {
    m = new THREE.MeshBasicNodeMaterial({ color, map: halo(), transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending });
    mats.set(key, m);
  }
  return m;
}

const geo = new Map<string, THREE.BufferGeometry>();
function g<T extends THREE.BufferGeometry>(key: string, make: () => T): T {
  let x = geo.get(key) as T | undefined;
  if (!x) geo.set(key, (x = make()));
  return x;
}

function mesh(gm: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const me = new THREE.Mesh(gm, m);
  me.position.set(x, y, z);
  me.castShadow = true;
  me.receiveShadow = true;
  return me;
}

/** Build a model for an item type. Origin = bottom centre, +Z forward. */
export function buildItemModel(type: string, opts: { lit?: boolean } = {}): THREE.Group {
  const grp = new THREE.Group();
  grp.name = `ix:${type}`;
  switch (type) {
    case 'bottle': {
      const glass = std('glass', { color: 0x1f4a2a, rough: 0.06, metal: 0.1, opacity: 0.86 });
      grp.add(mesh(g('btl.body', () => new THREE.CylinderGeometry(0.038, 0.042, 0.19, 14)), glass, 0, 0.095, 0));
      grp.add(mesh(g('btl.shoulder', () => new THREE.CylinderGeometry(0.016, 0.038, 0.05, 14)), glass, 0, 0.215, 0));
      grp.add(mesh(g('btl.neck', () => new THREE.CylinderGeometry(0.014, 0.016, 0.07, 10)), glass, 0, 0.275, 0));
      grp.add(mesh(g('btl.label', () => new THREE.CylinderGeometry(0.0412, 0.0412, 0.055, 14, 1, true)), std('label', { color: 0x8c7a4e, rough: 0.9 }), 0, 0.09, 0));
      break;
    }
    case 'crowbar': {
      const paint = std('crowbar', { color: 0x9e2a22, rough: 0.42, metal: 0.55 });
      const steel = std('steel', { color: 0x8a8f94, rough: 0.35, metal: 0.9 });
      const shaft = mesh(g('cb.shaft', () => new THREE.CylinderGeometry(0.011, 0.011, 0.62, 8)), paint, 0, 0.011, 0);
      shaft.rotation.x = Math.PI / 2;
      grp.add(shaft);
      const hook = mesh(g('cb.hook', () => new THREE.TorusGeometry(0.04, 0.011, 6, 12, Math.PI * 1.1)), paint, 0, 0.051, 0.31);
      hook.rotation.y = Math.PI / 2;
      grp.add(hook);
      const tip = mesh(g('cb.tip', () => new THREE.BoxGeometry(0.03, 0.008, 0.05)), steel, 0, 0.012, -0.33);
      grp.add(tip);
      break;
    }
    case 'glowstick': {
      const glow = opts.lit
        ? std('glow.lit', { color: 0x6dff8f, rough: 0.3, emissive: 0x39ff6a, ei: 7 })
        : std('glow.pack', { color: 0x4fae62, rough: 0.35, emissive: 0x39ff6a, ei: 0.8 });
      const n = opts.lit ? 1 : 3;
      for (let i = 0; i < n; i++) {
        const c = mesh(g('gs.stick', () => new THREE.CapsuleGeometry(0.011, 0.15, 4, 8)), glow, (i - (n - 1) / 2) * 0.03, 0.012, 0);
        c.rotation.x = Math.PI / 2;
        c.castShadow = false;
        grp.add(c);
      }
      if (opts.lit) {
        const h = new THREE.Mesh(g('gs.halo', () => new THREE.PlaneGeometry(2.6, 2.6)), haloMat(0x39ff6a, 0.32));
        h.rotation.x = -Math.PI / 2;
        h.position.y = 0.01;
        h.renderOrder = 2;
        grp.add(h);
        const h2 = new THREE.Mesh(g('gs.halo2', () => new THREE.PlaneGeometry(0.5, 0.5)), haloMat(0xb8ffc8, 0.55));
        h2.rotation.x = -Math.PI / 2;
        h2.position.y = 0.012;
        grp.add(h2);
      }
      break;
    }
    case 'medkit': {
      const shell = std('medkit', { color: 0xe7e1d3, rough: 0.55 });
      const red = std('medred', { color: 0xc0201b, rough: 0.5, emissive: 0x500000, ei: 0.4 });
      grp.add(mesh(g('mk.box', () => new THREE.BoxGeometry(0.3, 0.11, 0.2)), shell, 0, 0.055, 0));
      grp.add(mesh(g('mk.cross1', () => new THREE.BoxGeometry(0.11, 0.004, 0.035)), red, 0, 0.112, 0));
      grp.add(mesh(g('mk.cross2', () => new THREE.BoxGeometry(0.035, 0.004, 0.11)), red, 0, 0.112, 0));
      grp.add(mesh(g('mk.handle', () => new THREE.TorusGeometry(0.035, 0.007, 6, 10, Math.PI)), std('dark', { color: 0x222222, rough: 0.6 }), 0, 0.11, 0));
      break;
    }
    case 'walkie': {
      const body = std('walkie', { color: 0x2b2f33, rough: 0.55, metal: 0.1 });
      grp.add(mesh(g('wk.body', () => new THREE.BoxGeometry(0.062, 0.15, 0.034)), body, 0, 0.075, 0));
      grp.add(mesh(g('wk.ant', () => new THREE.CylinderGeometry(0.006, 0.008, 0.09, 6)), std('dark', { color: 0x222222, rough: 0.6 }), 0.018, 0.195, 0));
      grp.add(mesh(g('wk.grill', () => new THREE.BoxGeometry(0.045, 0.05, 0.004)), std('grill', { color: 0x15181a, rough: 0.9 }), 0, 0.105, 0.018));
      const led = mesh(g('wk.led', () => new THREE.SphereGeometry(0.005, 6, 4)), std('led.green', { color: 0x2aff6a, emissive: 0x2aff6a, ei: 4 }), -0.02, 0.147, 0.012);
      led.name = 'led';
      led.castShadow = false;
      grp.add(led);
      break;
    }
    case 'airhorn': {
      grp.add(mesh(g('ah.can', () => new THREE.CylinderGeometry(0.03, 0.03, 0.13, 12)), std('ahcan', { color: 0xd4362b, rough: 0.35, metal: 0.4 }), 0, 0.065, 0));
      const horn = mesh(g('ah.horn', () => new THREE.ConeGeometry(0.045, 0.1, 14, 1, true)), std('ahhorn', { color: 0xf2efe6, rough: 0.5 }), 0, 0.18, 0);
      horn.rotation.x = Math.PI;
      grp.add(horn);
      break;
    }
    case 'keycard': {
      grp.add(mesh(g('kc.card', () => new THREE.BoxGeometry(0.086, 0.003, 0.054)), std('keycard', { color: 0xf2c230, rough: 0.35, emissive: 0xffb000, ei: 0.6 }), 0, 0.002, 0));
      grp.add(mesh(g('kc.strip', () => new THREE.BoxGeometry(0.086, 0.0035, 0.012)), std('dark', { color: 0x222222, rough: 0.6 }), 0, 0.0025, 0.016));
      break;
    }
    case 'badge': {
      grp.add(mesh(g('bd.card', () => new THREE.BoxGeometry(0.07, 0.004, 0.1)), std('badge', { color: 0x3f7fb3, rough: 0.4, emissive: 0x1c4c7a, ei: 0.8 }), 0, 0.003, 0));
      grp.add(mesh(g('bd.plate', () => new THREE.BoxGeometry(0.05, 0.0045, 0.03)), std('badgeplate', { color: 0xe8e8e8, rough: 0.5 }), 0, 0.0035, -0.02));
      break;
    }
    case 'flashlight_pro': {
      const body = std('proflash', { color: 0x1b1f24, rough: 0.35, metal: 0.7 });
      const bezel = std('probezel', { color: 0xb9c3cc, rough: 0.25, metal: 1 });
      const tube = mesh(g('pf.tube', () => new THREE.CylinderGeometry(0.019, 0.019, 0.17, 14)), body, 0, 0.02, -0.02);
      tube.rotation.x = Math.PI / 2;
      grp.add(tube);
      const head = mesh(g('pf.head', () => new THREE.CylinderGeometry(0.03, 0.021, 0.06, 16)), bezel, 0, 0.02, 0.09);
      head.rotation.x = Math.PI / 2;
      grp.add(head);
      const lens = mesh(g('pf.lens', () => new THREE.CircleGeometry(0.026, 16)), std('prolens', { color: 0xdfeeff, emissive: 0xcfe6ff, ei: 3 }), 0, 0.02, 0.1205);
      lens.castShadow = false;
      grp.add(lens);
      grp.add(mesh(g('pf.grip', () => new THREE.BoxGeometry(0.012, 0.006, 0.05)), std('progrip', { color: 0x4fa3ff, emissive: 0x1a5cff, ei: 0.8 }), 0, 0.041, -0.02));
      break;
    }
    case 'flare':
    case 'flare.lit': {
      const lit = type === 'flare.lit';
      const red = std('flare', { color: 0xc8241b, rough: 0.55 });
      const cap = std('flarecap', { color: 0x222222, rough: 0.6 });
      const n = lit ? 1 : 3;
      for (let i = 0; i < n; i++) {
        const x = (i - (n - 1) / 2) * 0.038;
        const st = mesh(g('fl.stick', () => new THREE.CylinderGeometry(0.014, 0.014, 0.21, 10)), red, x, 0.015, 0);
        st.rotation.x = Math.PI / 2;
        grp.add(st);
        const c = mesh(g('fl.cap', () => new THREE.CylinderGeometry(0.015, 0.015, 0.03, 10)), cap, x, 0.015, -0.115);
        c.rotation.x = Math.PI / 2;
        grp.add(c);
      }
      if (lit) {
        const tip = mesh(g('fl.tip', () => new THREE.SphereGeometry(0.022, 10, 8)), std('flaretip', { color: 0xffd0c0, emissive: 0xff3a1c, ei: 22 }), 0, 0.02, 0.11);
        tip.castShadow = false;
        tip.name = 'tip';
        grp.add(tip);
        const h = new THREE.Mesh(g('fl.halo', () => new THREE.PlaneGeometry(4.2, 4.2)), haloMat(0xff2a12, 0.42));
        h.rotation.x = -Math.PI / 2;
        h.position.set(0, 0.012, 0.1);
        h.renderOrder = 2;
        h.name = 'halo';
        grp.add(h);
        // upright glow sprite around the burning tip (reads from any angle, flickers)
        const sp = new THREE.Sprite(spriteMat(0xff4a22, 0.9));
        sp.scale.setScalar(0.55);
        sp.position.set(0, 0.06, 0.11);
        sp.name = 'glow';
        grp.add(sp);
      }
      break;
    }
    case 'sensor':
    case 'sensor.armed': {
      const armed = type === 'sensor.armed';
      grp.add(mesh(g('ms.base', () => new THREE.CylinderGeometry(0.07, 0.08, 0.03, 18)), std('msbase', { color: 0x2c3136, rough: 0.5, metal: 0.5 }), 0, 0.015, 0));
      grp.add(mesh(g('ms.dome', () => new THREE.SphereGeometry(0.05, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2)), std('msdome', { color: 0x9adfd2, rough: 0.15, metal: 0.1, opacity: 0.7 }), 0, 0.03, 0));
      grp.add(mesh(g('ms.ant', () => new THREE.CylinderGeometry(0.003, 0.003, 0.12, 6)), std('dark', { color: 0x222222, rough: 0.6 }), 0.05, 0.09, 0));
      const led = mesh(g('ms.led', () => new THREE.SphereGeometry(0.009, 8, 6)), armed ? std('led.teal', { color: 0x62ffe0, emissive: 0x30ffd0, ei: 9 }) : std('led.off', { color: 0x1d3b35, rough: 0.5 }), 0, 0.075, 0);
      led.castShadow = false;
      led.name = 'led';
      grp.add(led);
      if (armed) {
        const ring = new THREE.Mesh(g('ms.ring', () => new THREE.PlaneGeometry(0.9, 0.9)), haloMat(0x30ffd0, 0.28));
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.006;
        ring.name = 'ring';
        grp.add(ring);
      }
      break;
    }
    case 'syringe': {
      const barrel = mesh(g('sy.barrel', () => new THREE.CylinderGeometry(0.011, 0.011, 0.11, 12)), std('syglass', { color: 0xdfe8ea, rough: 0.08, opacity: 0.55 }), 0, 0.012, 0);
      barrel.rotation.x = Math.PI / 2;
      grp.add(barrel);
      const fluid = mesh(g('sy.fluid', () => new THREE.CylinderGeometry(0.0085, 0.0085, 0.08, 10)), std('syfluid', { color: 0xffd23f, emissive: 0xffb000, ei: 1.6 }), 0, 0.012, 0.01);
      fluid.rotation.x = Math.PI / 2;
      fluid.castShadow = false;
      grp.add(fluid);
      const needle = mesh(g('sy.needle', () => new THREE.CylinderGeometry(0.0015, 0.0015, 0.045, 6)), std('steel', { color: 0x8a8f94, rough: 0.35, metal: 0.9 }), 0, 0.012, 0.077);
      needle.rotation.x = Math.PI / 2;
      grp.add(needle);
      const plunger = mesh(g('sy.plunger', () => new THREE.BoxGeometry(0.03, 0.03, 0.006)), std('dark', { color: 0x222222, rough: 0.6 }), 0, 0.012, -0.065);
      grp.add(plunger);
      break;
    }
    case 'charm': {
      // a rabbit's foot on a brass ring: fuzzy pale foot + faint green luck glow
      grp.add(mesh(g('ch.foot', () => new THREE.CapsuleGeometry(0.022, 0.05, 6, 10)), std('chfur', { color: 0xe9e1cf, rough: 1 }), 0, 0.022, 0));
      grp.children[grp.children.length - 1]!.rotation.x = Math.PI / 2;
      const ring = mesh(g('ch.ring', () => new THREE.TorusGeometry(0.018, 0.003, 6, 16)), std('brass', { color: 0xb08a3e, rough: 0.3, metal: 1 }), 0, 0.022, 0.06);
      ring.rotation.y = Math.PI / 2;
      grp.add(ring);
      const clover = mesh(g('ch.clover', () => new THREE.CircleGeometry(0.02, 4)), std('chclover', { color: 0x4fd14a, emissive: 0x2fb52a, ei: 1.5 }), 0, 0.046, 0);
      clover.rotation.x = -Math.PI / 2;
      clover.castShadow = false;
      grp.add(clover);
      break;
    }
    case 'loot.idol': {
      // squat stone figure, too-long neck, cocked head (the Listener's shape) with faint violet eyes
      const stone = std('idol', { color: 0x3b3346, rough: 0.85, metal: 0.05, emissive: 0x1a0830, ei: 0.4 });
      grp.add(mesh(g('id.base', () => new THREE.CylinderGeometry(0.075, 0.09, 0.05, 8)), stone, 0, 0.025, 0));
      grp.add(mesh(g('id.body', () => new THREE.CylinderGeometry(0.035, 0.06, 0.16, 8)), stone, 0, 0.13, 0));
      grp.add(mesh(g('id.neck', () => new THREE.CylinderGeometry(0.012, 0.016, 0.12, 6)), stone, 0, 0.27, 0));
      const head = mesh(g('id.head', () => new THREE.SphereGeometry(0.035, 10, 8)), stone, 0.012, 0.345, 0);
      head.scale.set(0.8, 1.25, 0.9);
      head.rotation.z = 0.5;
      grp.add(head);
      const eyeM = std('idoleye', { color: 0xd6b8ff, emissive: 0xa060ff, ei: 10 });
      for (const ex of [-0.011, 0.011]) {
        const e = mesh(g('id.eye', () => new THREE.SphereGeometry(0.005, 6, 4)), eyeM, 0.012 + ex, 0.35 + ex * 0.5, 0.028);
        e.castShadow = false;
        grp.add(e);
      }
      const h = new THREE.Mesh(g('id.halo', () => new THREE.PlaneGeometry(0.9, 0.9)), haloMat(0x7a3cff, 0.22));
      h.rotation.x = -Math.PI / 2;
      h.position.y = 0.008;
      grp.add(h);
      break;
    }
    default: {
      // salvage (only when this track rolls loot; objectives renders its own)
      const tier = type === 'loot.heavy' ? 2 : type === 'loot.medium' ? 1 : 0;
      const s = [0.14, 0.26, 0.46][tier];
      grp.add(mesh(g(`loot.${tier}`, () => new THREE.BoxGeometry(s, s * 0.7, s * 0.8)), std(`loot${tier}`, { color: [0xb08d2a, 0x8d6b3a, 0x6c5a48][tier], rough: 0.5, metal: 0.5 }), 0, s * 0.35, 0));
      break;
    }
  }
  return grp;
}

export interface HeldView {
  pid: string;
  type: string;
  /** world position of the hand (bone) */
  p: [number, number, number];
  /** avatar yaw */
  yaw: number;
}

export interface Visuals {
  update(st: InteractionState, opts: VisualOpts): void;
  /** remote players' active items, placed at their hands every frame */
  held(list: HeldView[]): void;
  /** play the held-item swing / throw animation */
  animate(kind: 'swing' | 'throw' | 'use'): void;
  dispose(): void;
}

export interface VisualOpts {
  camera: THREE.PerspectiveCamera;
  activeType: string | null;
  showViewModel: boolean;
  /** world item id under the crosshair (glint) */
  targetItem: string | null;
  targetPos: [number, number, number] | null;
  /** thrown projectiles from snapshot dyn: id -> pos/yaw */
  thrown: { id: string; p: [number, number, number]; yaw: number }[];
  serverNow: number;
  radioTx: boolean;
  dt: number;
}

export function createVisuals(scene: THREE.Scene): Visuals {
  const root = new THREE.Group();
  root.name = 'interaction';
  scene.add(root);
  const items = new Map<string, { obj: THREE.Group; type: string; key: string }>();
  const glows = new Map<string, THREE.Group>();
  const rings = new Map<string, THREE.Mesh>();
  const thrown = new Map<string, THREE.Group>();
  const heldObjs = new Map<string, { type: string; obj: THREE.Group }>();
  const heldTilt: Record<string, [number, number, number]> = {
    crowbar: [-1.2, 0, 0], bottle: [0.2, 0, 0], walkie: [0, 0, 0], medkit: [0, 0, 0], glowstick: [-1.3, 0, 0], airhorn: [0, 0, 0],
    flashlight_pro: [-0.2, 0, 0], flare: [-1.2, 0, 0], sensor: [0, 0, 0], syringe: [-1.2, 0, 0], charm: [0, 0, 0], 'loot.idol': [0, 0, 0],
  };
  // burning flares + their pooled red lights (unshadowed SpotLights pointing down: DynamicLighting batches them, and
  // they exist from the first frame, so lighting a flare never changes the light-type set / recompiles materials)
  const flares = new Map<string, THREE.Group>();
  const armedSensors = new Set<THREE.Group>();
  const FLARE_LIGHTS = 2;
  const flareLights: THREE.SpotLight[] = [];
  for (let i = 0; i < FLARE_LIGHTS; i++) {
    const l = new THREE.SpotLight(0xff2a14, 0, 11, 1.52, 0.55, 1.5);
    l.castShadow = false;
    l.name = `flare-light-${i}`;
    l.position.set(0, -520 - i, 0);
    l.target.position.set(0, -530 - i, 0);
    root.add(l, l.target);
    flareLights.push(l);
  }
  const tmpCam = new THREE.Vector3();
  // view model follows the camera (matrix copied each frame; the camera need not be in the scene)
  const vmRoot = new THREE.Group();
  vmRoot.matrixAutoUpdate = false;
  root.add(vmRoot);
  const vmHolder = new THREE.Group();
  vmHolder.position.set(-0.25, -0.25, -0.5); // left hand: ⑤'s flashlight view model is on the right
  vmRoot.add(vmHolder);
  // pre-warm (initial-lag fix): every item model is drawn once, microscopic and right in front of the camera, during the
  // first frames (join / loading screen), so its pipelines compile there instead of stalling the first time someone
  // picks up a medkit or throws a flare mid-contract
  const warm = new THREE.Group();
  warm.position.set(0, 0, -0.4);
  warm.scale.setScalar(0.0002);
  for (const t of ['flare.lit', 'flare', 'sensor', 'sensor.armed', 'syringe', 'charm', 'loot.idol', 'flashlight_pro', 'bottle',
    'glowstick', 'crowbar', 'medkit', 'walkie', 'airhorn', 'keycard', 'badge', 'loot.small']) warm.add(buildItemModel(t));
  warm.add(buildItemModel('glowstick', { lit: true }));
  vmRoot.add(warm);
  let warmFrames = 90;
  let vmType: string | null = null;
  let vmObj: THREE.Group | null = null;
  let anim: { kind: 'swing' | 'throw' | 'use'; t: number } | null = null;
  let bob = 0;
  const glint = new THREE.Mesh(
    new THREE.TorusGeometry(0.12, 0.005, 6, 32),
    std('glint', { color: 0xffd27a, emissive: 0xffb347, ei: 2.5, opacity: 0.75 }),
  );
  glint.rotation.x = -Math.PI / 2;
  glint.visible = false;
  glint.castShadow = false;
  root.add(glint);
  const ringMat = std('revring', { color: 0xff3b3b, emissive: 0xff2020, ei: 2.2, opacity: 0.8 });
  const ringGeo = new THREE.TorusGeometry(0.55, 0.012, 6, 48);

  const vmPose = (type: string): { pos: [number, number, number]; rot: [number, number, number]; scale: number } => {
    switch (type) {
      case 'crowbar': return { pos: [0.02, -0.02, 0.02], rot: [-1.1, 0.25, 0.1], scale: 1 };
      case 'bottle': return { pos: [0.02, -0.12, 0.02], rot: [0.35, 0.2, 0.25], scale: 0.85 };
      case 'walkie': return { pos: [0, -0.06, 0], rot: [0.25, -0.5, 0], scale: 1.1 };
      case 'medkit': return { pos: [-0.02, -0.1, -0.05], rot: [0.35, -0.4, 0], scale: 0.8 };
      case 'glowstick': return { pos: [0.03, -0.09, 0.02], rot: [0.9, 0.4, 0.3], scale: 0.75 };
      case 'airhorn': return { pos: [0, -0.09, 0], rot: [0.9, 0, 0], scale: 1 };
      case 'keycard': return { pos: [0, 0, 0], rot: [1.2, 0.1, 0], scale: 1.4 };
      case 'flashlight_pro': return { pos: [0.02, -0.06, 0], rot: [0.15, 0.25, 0], scale: 1.2 };
      case 'flare': return { pos: [0.03, -0.08, 0.02], rot: [0.9, 0.4, 0.3], scale: 0.85 };
      case 'sensor': return { pos: [0, -0.1, 0], rot: [0.6, 0.2, 0], scale: 1.1 };
      case 'syringe': return { pos: [0.02, -0.07, 0], rot: [0.5, 0.5, 0.2], scale: 1.4 };
      case 'charm': return { pos: [0, -0.07, 0], rot: [0.8, 0.3, 0], scale: 1.4 };
      case 'loot.idol': return { pos: [0, -0.2, -0.03], rot: [0.1, 0.4, 0], scale: 0.85 };
      case 'badge': return { pos: [0, 0, 0], rot: [1.2, 0.1, 0], scale: 1.4 };
      default: return { pos: [0, -0.1, 0], rot: [0.2, 0.3, 0], scale: 0.7 };
    }
  };

  const syncItems = (st: InteractionState) => {
    const seen = new Set<string>();
    for (const it of Object.values(st.items)) {
      if (it.where !== 'world' || !it.p) continue;
      seen.add(it.id);
      const mtype = it.type === 'sensor' && it.armed ? 'sensor.armed' : it.type;
      const key = `${mtype}:${it.p[0].toFixed(2)}:${it.p[1].toFixed(2)}:${it.p[2].toFixed(2)}`;
      let e = items.get(it.id);
      if (e && e.type !== mtype) {
        root.remove(e.obj);
        armedSensors.delete(e.obj);
        e = undefined;
      }
      if (!e) {
        const made: { obj: THREE.Group; type: string; key: string } = { obj: buildItemModel(mtype), type: mtype, key: '' };
        if (mtype === 'sensor.armed') armedSensors.add(made.obj);
        e = made;
        root.add(made.obj);
        items.set(it.id, made);
        const pk = PROP_FOR[it.type];
        if (pk) {
          void propModel(pk).then((m) => {
            if (!m || items.get(it.id) !== made) return;
            made.obj.clear();
            made.obj.add(m.clone(true));
          });
        }
      }
      if (e.key !== key) {
        e.key = key;
        placeItem(e.obj, it);
      }
    }
    for (const [id, e] of items) if (!seen.has(id)) { root.remove(e.obj); armedSensors.delete(e.obj); items.delete(id); }
  };

  const syncFlares = (st: InteractionState, cam: THREE.Camera, now: number) => {
    const list = st.flares ?? {};
    for (const [id, fl] of Object.entries(list)) {
      let gr = flares.get(id);
      if (!gr) {
        gr = buildItemModel('flare.lit');
        gr.rotation.y = (id.length * 2.3 + fl.p[0]) % (Math.PI * 2);
        root.add(gr);
        flares.set(id, gr);
      }
      gr.position.set(fl.p[0], 0, fl.p[2]);
      // sputter: the last 8 s the flame dies down
      const left = Math.max(0, (fl.until - now) / 1000);
      const fade = Math.min(1, left / 8);
      const t = performance.now() / 1000;
      const flick = 0.8 + 0.12 * Math.sin(t * 23 + fl.p[0]) + 0.08 * Math.sin(t * 57 + fl.p[2]);
      gr.userData.k = fade * flick;
      const glow = gr.getObjectByName('glow');
      if (glow) glow.scale.setScalar((0.45 + 0.2 * flick) * (0.3 + 0.7 * fade));
      const h = gr.getObjectByName('halo');
      if (h) h.scale.setScalar(0.35 + 0.65 * fade * (0.9 + 0.1 * flick));
    }
    for (const [id, gr] of flares) if (!list[id]) { root.remove(gr); flares.delete(id); }
    // the nearest burning flares to the camera get the pooled lights
    cam.getWorldPosition(tmpCam);
    const near = [...flares.values()].sort((a, b) => a.position.distanceToSquared(tmpCam) - b.position.distanceToSquared(tmpCam));
    for (let i = 0; i < flareLights.length; i++) {
      const l = flareLights[i]!;
      const gr = near[i];
      if (!gr) {
        if (l.intensity !== 0) { l.intensity = 0; l.position.set(0, -520 - i, 0); l.target.position.set(0, -530 - i, 0); l.target.updateMatrixWorld(); }
        continue;
      }
      l.position.set(gr.position.x, 1.45, gr.position.z);
      l.target.position.set(gr.position.x, 0, gr.position.z);
      l.target.updateMatrixWorld();
      l.intensity = 34 * Number(gr.userData.k ?? 1);
    }
  };

  const placeItem = (obj: THREE.Group, it: ItemState) => {
    const p = it.p!;
    obj.position.set(p[0], p[1], p[2]);
    // lying items: bottles / airhorns stand, crowbars lie, cards lie flat
    obj.rotation.set(0, it.rot ?? 0, 0);
    if (it.type === 'bottle' && p[1] < 0.05) obj.rotation.z = Math.PI / 2 * 0.98, obj.position.y = 0.04;
  };

  const syncGlows = (st: InteractionState) => {
    for (const [id, p] of Object.entries(st.glows)) {
      let gr = glows.get(id);
      if (!gr) {
        gr = buildItemModel('glowstick', { lit: true });
        gr.rotation.y = (id.length * 1.7) % Math.PI;
        root.add(gr);
        glows.set(id, gr);
      }
      gr.position.set(p[0], p[1], p[2]);
    }
    for (const [id, gr] of glows) if (!st.glows[id]) { root.remove(gr); glows.delete(id); }
  };

  const syncRings = (st: InteractionState, now: number, dt: number) => {
    for (const b of Object.values(st.bodies)) {
      const live = now < b.reviveBy;
      let r = rings.get(b.pid);
      if (live && !r) {
        r = new THREE.Mesh(ringGeo, ringMat);
        r.rotation.x = -Math.PI / 2;
        r.castShadow = false;
        root.add(r);
        rings.set(b.pid, r);
      }
      if (r) {
        if (!live) { root.remove(r); rings.delete(b.pid); continue; }
        r.position.set(b.p[0], 0.02, b.p[2]);
        const k = 1 + Math.sin(now / 180) * 0.06;
        r.scale.setScalar(k);
      }
    }
    for (const [pid, r] of rings) if (!st.bodies[pid]) { root.remove(r); rings.delete(pid); }
    void dt;
  };

  const syncThrown = (list: VisualOpts['thrown']) => {
    const seen = new Set<string>();
    for (const t of list) {
      seen.add(t.id);
      let o = thrown.get(t.id);
      if (!o) {
        o = buildItemModel(t.id.includes(':flare:') ? 'flare.lit' : 'bottle');
        const h = o.getObjectByName('halo');
        if (h) h.visible = false;
        root.add(o);
        thrown.set(t.id, o);
      }
      o.position.set(t.p[0], t.p[1] - 0.14, t.p[2]);
      o.rotation.set(t.yaw, t.yaw * 0.3, 0);
    }
    for (const [id, o] of thrown) if (!seen.has(id)) { root.remove(o); thrown.delete(id); }
  };

  const syncViewModel = (o: VisualOpts) => {
    o.camera.updateMatrixWorld();
    vmRoot.matrix.copy(o.camera.matrixWorld);
    vmRoot.matrixWorldNeedsUpdate = true;
    const want = o.showViewModel ? o.activeType : null;
    if (want !== vmType) {
      if (vmObj) vmHolder.remove(vmObj);
      vmObj = null;
      vmType = want;
      if (want) {
        vmObj = buildItemModel(want);
        vmObj.traverse((c) => { c.castShadow = false; });
        vmHolder.add(vmObj);
        const ps = vmPose(want);
        vmObj.position.set(...ps.pos);
        vmObj.rotation.set(...ps.rot);
        vmObj.scale.setScalar(ps.scale);
      }
    }
    if (!vmObj || !vmType) return;
    bob += o.dt;
    const ps = vmPose(vmType);
    let ox = 0, oy = Math.sin(bob * 1.6) * 0.004, oz = 0, rx = 0;
    if (anim) {
      anim.t += o.dt;
      const dur = anim.kind === 'swing' ? 0.38 : 0.3;
      const k = Math.min(1, anim.t / dur);
      const s = Math.sin(k * Math.PI);
      if (anim.kind === 'swing') { rx = -s * 1.6; ox = -s * 0.12; oz = -s * 0.1; }
      else if (anim.kind === 'throw') { oz = -s * 0.25; oy += s * 0.08; }
      else { oy -= s * 0.05; }
      if (k >= 1) anim = null;
    }
    vmObj.position.set(ps.pos[0] + ox, ps.pos[1] + oy, ps.pos[2] + oz);
    vmObj.rotation.set(ps.rot[0] + rx, ps.rot[1], ps.rot[2]);
    const led = vmObj.getObjectByName('led');
    if (led) led.visible = o.radioTx ? true : Math.floor(bob * 2) % 2 === 0;
  };

  return {
    update(st, o) {
      if (warmFrames > 0 && --warmFrames === 0) vmRoot.remove(warm);
      syncItems(st);
      syncGlows(st);
      syncFlares(st, o.camera, o.serverNow);
      if (armedSensors.size) {
        const on = Math.floor(performance.now() / 450) % 3 === 0;
        for (const obj of armedSensors) { const led = obj.getObjectByName('led'); if (led) led.visible = on; }
      }
      syncRings(st, o.serverNow, o.dt);
      syncThrown(o.thrown);
      syncViewModel(o);
      if (o.targetPos) {
        glint.visible = true;
        glint.position.set(o.targetPos[0], Math.max(0.015, o.targetPos[1] - 0.08), o.targetPos[2]);
        const k = 1 + Math.sin(performance.now() / 160) * 0.08;
        glint.scale.setScalar(k);
      } else glint.visible = false;
    },
    held(list) {
      const seen = new Set<string>();
      for (const h of list) {
        seen.add(h.pid);
        let e = heldObjs.get(h.pid);
        if (e && e.type !== h.type) { root.remove(e.obj); e = undefined; }
        if (!e) {
          e = { type: h.type, obj: buildItemModel(h.type) };
          root.add(e.obj);
          heldObjs.set(h.pid, e);
        }
        const tilt = heldTilt[h.type] ?? [0, 0, 0];
        e.obj.position.set(h.p[0], h.p[1] - 0.06, h.p[2]);
        e.obj.rotation.set(tilt[0], h.yaw + tilt[1], tilt[2], 'YXZ');
        e.obj.visible = true;
      }
      for (const [pid, e] of heldObjs) if (!seen.has(pid)) { root.remove(e.obj); heldObjs.delete(pid); }
    },
    animate(kind) {
      anim = { kind, t: 0 };
    },
    dispose() {
      scene.remove(root);
    },
  };
}

export function itemColor(type: string): string {
  return itemDef(type).color;
}
