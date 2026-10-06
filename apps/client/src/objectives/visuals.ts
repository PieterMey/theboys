// Owner: track (a) Objectives. 3D side of the objectives: animates ②'s placeholders through services.level
// (breaker handles + LEDs, keypad screen, leave lever), moves the Core canister with its dyn entity (upright on the
// pedestal, horizontal between two carriers, on its side when dropped) with a pulsing glow + hum loop, hides the
// level's loot-slot placeholders when (b) renders the real salvage, and builds simple meshes when ② has none.
import * as THREE from 'three/webgpu';
import type { ClientContext } from '../core/context.ts';
import type { ObjectivesState } from '@dead-air/shared/messages/objectives.ts';
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import { objState } from './state.ts';

interface LevelLike {
  layout: LevelLayout | null;
  itemObject(id: string): THREE.Object3D | null;
  setItemObject?(id: string, obj: THREE.Object3D | null): void;
  onRebuild?(fn: (l: LevelLayout) => void): () => void;
  version?: number;
}

interface SfxHandle { stop(): void; setPos?(p: [number, number, number]): void }

const std = (color: number, opts: { rough?: number; metal?: number; emissive?: number; ei?: number; transparent?: boolean; opacity?: number } = {}) => {
  const m = new THREE.MeshStandardNodeMaterial({
    color, roughness: opts.rough ?? 0.5, metalness: opts.metal ?? 0.1,
    emissive: opts.emissive ?? 0x000000, emissiveIntensity: opts.ei ?? 1,
    transparent: opts.transparent ?? false, opacity: opts.opacity ?? 1,
  });
  return m;
};

export interface ObjVisuals {
  update(dt: number): void;
  /** brief red flash on the keypad screen */
  keypadFlash(ok: boolean): void;
  dispose(): void;
}

export function createObjVisuals(ctx: ClientContext): ObjVisuals {
  const level = () => (ctx.services.use as unknown as (n: string) => unknown)('level') as LevelLike | undefined;
  const M = {
    ledRed: std(0x400000, { emissive: 0xff2a1a, ei: 3 }),
    ledAmber: std(0x402800, { emissive: 0xffa31a, ei: 3.5 }),
    ledGreen: std(0x003a10, { emissive: 0x2aff6a, ei: 3.5 }),
    ledOff: std(0x101010, { rough: 0.6 }),
    scrDead: std(0x050607, { rough: 0.3 }),
    scrAmber: std(0x1a1000, { emissive: 0xffb340, ei: 1.6, rough: 0.2 }),
    scrGreen: std(0x001a08, { emissive: 0x3dff7a, ei: 1.8, rough: 0.2 }),
    scrRed: std(0x1a0000, { emissive: 0xff3322, ei: 2.2, rough: 0.2 }),
    metal: std(0x2d3236, { rough: 0.45, metal: 0.7 }),
    chrome: std(0x9aa3a8, { rough: 0.25, metal: 0.9 }),
    red: std(0x8e1b14, { rough: 0.5, metal: 0.2 }),
    glass: std(0x9fe9ff, { rough: 0.05, metal: 0, transparent: true, opacity: 0.35 }),
    core: std(0x0c3a44, { emissive: 0x38e8ff, ei: 3.2, rough: 0.2 }),
  };
  const root = new THREE.Group();
  root.name = 'objectives';
  let attached = false;
  let layoutKey = '';
  let core: { obj: THREE.Group; glow: THREE.Mesh | null; own: boolean; baseY: number } | null = null;
  const fallbacks = new Map<string, THREE.Object3D>();
  const handles = new Map<string, { h: THREE.Object3D; up: number; cur: number }>();
  let hum: SfxHandle | null = null;
  let humAcc = 0;
  let flash: { ok: boolean; until: number } | null = null;
  let t = 0;

  const scene = () => ctx.services.use('three')?.scene ?? null;

  function obj(id: string): THREE.Object3D | null {
    return level()?.itemObject(id) ?? fallbacks.get(id) ?? null;
  }

  function placeFallback(id: string, o: THREE.Object3D, p: [number, number, number], rot: number): void {
    o.position.set(p[0], p[1], p[2]);
    o.rotation.y = rot;
    root.add(o);
    fallbacks.set(id, o);
  }

  function buildLever(): THREE.Group {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.6, 0.22), M.metal));
    const h = new THREE.Group();
    h.name = 'handle';
    h.position.set(0, 0, 0.13);
    h.add(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.32, 0.05).translate(0, 0.14, 0.03), M.chrome));
    h.add(new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.18, 10).rotateZ(Math.PI / 2).translate(0, 0.3, 0.06), M.red));
    h.rotation.x = 0.55;
    g.add(h);
    const led = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.02).translate(0.15, 0.24, 0.12), M.ledRed);
    led.name = 'led';
    g.add(led);
    return g;
  }

  function buildKeypad(): THREE.Group {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.24, 0.05), M.metal));
    const scr = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.045, 0.01).translate(0, 0.075, 0.027), M.scrDead);
    scr.name = 'screen';
    g.add(scr);
    return g;
  }

  function buildCanister(): THREE.Group {
    const can = new THREE.Group();
    can.name = 'canister';
    can.add(new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.5, 24).translate(0, 0.32, 0), M.glass));
    const glow = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.44, 16).translate(0, 0.32, 0), M.core);
    glow.name = 'glow';
    can.add(glow);
    can.add(new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.08, 24).translate(0, 0.04, 0), M.chrome));
    can.add(new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.08, 24).translate(0, 0.6, 0), M.chrome));
    return can;
  }

  function reset(): void {
    for (const o of fallbacks.values()) o.removeFromParent();
    fallbacks.clear();
    handles.clear();
    if (core) { core.obj.removeFromParent(); core = null; }
    if (hum) { try { hum.stop(); } catch { /* */ } hum = null; }
  }

  /** first frame of a contract layout: wire placeholders / fallbacks */
  function setup(st: ObjectivesState): void {
    const lv = level();
    for (const l of st.levers) {
      let o = lv?.itemObject(l.id) ?? null;
      if (!o) { o = buildLever(); placeFallback(l.id, o, l.p, l.rot); }
      const h = o.getObjectByName('handle');
      if (h) handles.set(l.id, { h, up: h.rotation.x, cur: h.rotation.x });
    }
    if (st.keypad && !lv?.itemObject(st.keypad.id)) placeFallback(st.keypad.id, buildKeypad(), st.keypad.p, st.keypad.rot);
    if (st.leaveLever) {
      const o = lv?.itemObject(st.leaveLever.id);
      const h = o?.getObjectByName('handle');
      if (h) handles.set(st.leaveLever.id, { h, up: h.rotation.x, cur: h.rotation.x });
    }
    if (st.core) {
      const host = lv?.itemObject(st.core.id) ?? null;
      let can = host?.getObjectByName('canister') as THREE.Group | undefined;
      let own = false;
      let baseY = 0.51;
      if (can) {
        // take the canister off ②'s pedestal so it can travel (the pedestal stays)
        root.attach(can);
      } else {
        can = buildCanister();
        own = true;
        baseY = 0;
        root.add(can);
      }
      const glow = can.getObjectByName('glow') as THREE.Mesh | undefined;
      if (glow && !own) glow.material = M.core;
      core = { obj: can, glow: glow ?? null, own, baseY };
    }
    // (b) renders the real salvage as world items: the level's loot-slot crates would be fake loot
    if (st.lootMode === 'interaction' && lv?.layout) {
      for (const it of lv.layout.items) {
        if (it.kind !== 'loot') continue;
        const o = lv.itemObject(it.id);
        if (o) o.visible = false;
      }
    }
  }

  function setMat(o: THREE.Object3D | null | undefined, m: THREE.Material): void {
    if (o && (o as THREE.Mesh).isMesh && (o as THREE.Mesh).material !== m) (o as THREE.Mesh).material = m;
  }

  function updateCore(st: ObjectivesState, dt: number): void {
    if (!core || !st.core) return;
    const c = st.core;
    const s = ctx.world.dyn.get(c.id)?.sample(ctx.world.renderTime());
    const p = s?.p ?? c.p;
    const yaw = s?.yaw ?? c.yaw;
    const o = core.obj;
    o.rotation.order = 'YXZ';
    if (c.state === 'carried') {
      // lying along the carriers' axis at hand height, centred between them
      const dx = Math.sin(yaw), dz = Math.cos(yaw);
      o.position.set(p[0] - dx * 0.34, 0.92, p[2] - dz * 0.34);
      o.rotation.set(Math.PI / 2, yaw, 0);
    } else if (c.state === 'dropped') {
      const dx = Math.sin(yaw), dz = Math.cos(yaw);
      o.position.set(p[0] - dx * 0.34, 0.2, p[2] - dz * 0.34);
      o.rotation.set(Math.PI / 2, yaw, 0);
    } else if (c.state === 'van') {
      o.position.set(p[0], 0.02, p[2] + 0.4);
      o.rotation.set(0, 0, 0);
    } else {
      // on the pedestal (vault)
      o.position.set(p[0], core.baseY || 0.51, p[2]);
      o.rotation.set(0, 0, 0);
    }
    // glow pulse: faster while carried, dim when dropped
    t += dt;
    const base = c.state === 'carried' ? 4.2 : c.state === 'dropped' ? 1.4 : 3.0;
    const rate = c.state === 'carried' ? 6 : 1.6;
    M.core.emissiveIntensity = base * (0.8 + 0.2 * Math.sin(t * rate));
    // hum loop follows the canister
    const sfx = ctx.services.use('sfx') as unknown as { play(id: string, pos?: [number, number, number], o?: Record<string, unknown>): SfxHandle | null } | undefined;
    if (!hum && sfx && st.active && !st.ended) {
      try { hum = sfx.play('sfx.core_hum_loop', [o.position.x, o.position.y, o.position.z], { loop: true, volume: 0.55, radius: 9 }); } catch { hum = null; }
    }
    humAcc += dt;
    if (hum && humAcc > 0.1) {
      humAcc = 0;
      try { hum.setPos?.([o.position.x, o.position.y, o.position.z]); } catch { /* */ }
    }
  }

  function updateLevers(st: ObjectivesState, dt: number): void {
    for (const l of st.levers) {
      const hs = handles.get(l.id);
      if (hs) {
        // the handle swings from up-and-out (hs.up) through the front to down-and-out
        const target = l.down ? Math.PI - hs.up : hs.up;
        hs.cur += (target - hs.cur) * Math.min(1, dt * (l.down ? 16 : 6));
        hs.h.rotation.x = hs.cur;
      }
      const o = obj(l.id);
      const led = o?.getObjectByName('led');
      const powered = !!st.power[l.zone];
      setMat(led, powered ? M.ledGreen : l.down ? M.ledAmber : st.leverCooldownUntil > ctx.world.serverNow() ? (Math.floor(t * 4) % 2 ? M.ledRed : M.ledOff) : M.ledRed);
    }
    if (st.leaveLever) {
      const hs = handles.get(st.leaveLever.id);
      if (hs) {
        const target = st.ended ? Math.PI - hs.up : hs.up;
        hs.cur += (target - hs.cur) * Math.min(1, dt * 10);
        hs.h.rotation.x = hs.cur;
      }
    }
    if (st.keypad) {
      const scr = obj(st.keypad.id)?.getObjectByName('screen');
      const now = performance.now();
      let m: THREE.Material = st.vaultOpen ? M.scrGreen : st.keypad.enabled ? M.scrAmber : M.scrDead;
      if (flash && now < flash.until) m = flash.ok ? M.scrGreen : (Math.floor(now / 90) % 2 ? M.scrRed : M.scrDead);
      if (st.keypad.lockedUntil > ctx.world.serverNow() && !st.vaultOpen) m = Math.floor(now / 250) % 2 ? M.scrRed : M.scrDead;
      setMat(scr, m);
    }
  }

  return {
    update(dt) {
      const st = objState.value;
      const sc = scene();
      const L = ctx.world.layout;
      const key = st && st.active && L && ctx.world.phase === 'contract' ? `${L.seed}:${L.hash}:${st.orderId}:${level()?.version ?? 0}` : '';
      if (key !== layoutKey) {
        reset();
        layoutKey = key;
        if (key && st) setup(st);
      }
      if (!key || !st || !sc) {
        if (attached) { root.removeFromParent(); attached = false; }
        return;
      }
      if (!attached) { sc.add(root); attached = true; }
      updateLevers(st, dt);
      updateCore(st, dt);
      if (st.ended && hum) { try { hum.stop(); } catch { /* */ } hum = null; }
    },
    keypadFlash(ok) {
      flash = { ok, until: performance.now() + (ok ? 1200 : 700) };
    },
    dispose() {
      reset();
      root.removeFromParent();
    },
  };
}
