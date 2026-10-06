// Owner: track (b) Interaction. Procedural item meshes (world items, held view model, thrown bottles), lit glowstick
// markers (emissive only + a floor halo, no lights), revive rings at fresh bodies, and the target glint.
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
  };
  // view model follows the camera (matrix copied each frame; the camera need not be in the scene)
  const vmRoot = new THREE.Group();
  vmRoot.matrixAutoUpdate = false;
  root.add(vmRoot);
  const vmHolder = new THREE.Group();
  vmHolder.position.set(-0.25, -0.25, -0.5); // left hand: ⑤'s flashlight view model is on the right
  vmRoot.add(vmHolder);
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
      case 'glowstick': return { pos: [0, -0.04, 0], rot: [0.5, 0.3, 0.2], scale: 1.2 };
      case 'airhorn': return { pos: [0, -0.09, 0], rot: [0.9, 0, 0], scale: 1 };
      case 'keycard': return { pos: [0, 0, 0], rot: [1.2, 0.1, 0], scale: 1.4 };
      case 'badge': return { pos: [0, 0, 0], rot: [1.2, 0.1, 0], scale: 1.4 };
      default: return { pos: [0, -0.1, 0], rot: [0.2, 0.3, 0], scale: 0.7 };
    }
  };

  const syncItems = (st: InteractionState) => {
    const seen = new Set<string>();
    for (const it of Object.values(st.items)) {
      if (it.where !== 'world' || !it.p) continue;
      seen.add(it.id);
      const key = `${it.type}:${it.p[0].toFixed(2)}:${it.p[1].toFixed(2)}:${it.p[2].toFixed(2)}`;
      let e = items.get(it.id);
      if (e && e.type !== it.type) {
        root.remove(e.obj);
        e = undefined;
      }
      if (!e) {
        const made: { obj: THREE.Group; type: string; key: string } = { obj: buildItemModel(it.type), type: it.type, key: '' };
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
    for (const [id, e] of items) if (!seen.has(id)) { root.remove(e.obj); items.delete(id); }
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
        o = buildItemModel('bottle');
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
      syncItems(st);
      syncGlows(st);
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
