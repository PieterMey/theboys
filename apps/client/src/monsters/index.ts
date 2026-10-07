// Owner: track (c) Monsters (apps/client/src/monsters/**). Client side of the monsters:
//  - views for snapshot monsters (hound / porcelain mannequin / elongated wet Listener), animated from state/anim with
//    crossfades, hidden while active=false; procedural placeholders until the models load
//  - sounds for 'monsters.cue' + loops (mannequin scrape only while it moves unobserved, Listener hum/clicks)
//  - mannequin sighting reports ('monsters.see', 10 Hz) + the visor blink overlay ('monsters.blink')
//  - telegraphs: room flicker (services.render.flickerSpace), walkie squelch, radio lures, LED tell, director events
//  - Listener grab: victim frozen + red vignette; teammates get an [E] SHOVE prompt ('monsters.shove')
//  - v1.1 Snatcher: vent tells (rattle, dust, soft clicks), the drop, the drag (victim camera follows it, dark + muffled
//    in the duct, mash E to struggle), the wet drag trail on the floor, teammates' [HOLD E] PULL prompt at the rescue
//    spot ('monsters.pull' heartbeat), retreat shriek
//  - readiness part 'monsters': done once the models are loaded and every monster pipeline was drawn once (warm-up),
//    so a loading screen gated on ctx.readiness hides the first-sight compile hitch
import * as THREE from 'three/webgpu';
import { float, mx_noise_float, smoothstep, uv, vec2 } from 'three/tsl';
import { h } from 'preact';
import { signal } from '@preact/signals';
import { ANIM } from '@dead-air/shared/anim.ts';
import type { Vec3, SnapMonster } from '@dead-air/shared/state.ts';
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import { buildEdgeGrid, initialDoorOpen, los } from '@dead-air/shared/nav/index.ts';
import type { DoorOpenFn, EdgeGrid } from '@dead-air/shared/nav/index.ts';
import type { ClientContext } from '../core/context.ts';
import { SYS } from '../core/loop.ts';
import type { SnatchEvent } from '@dead-air/shared/messages/monsters.ts';
import { addKennelGlow, instantiate, loadMonsterLib, poseSnatcher } from './models.ts';
import type { MonsterLib, MonsterModel } from './models.ts';

interface SfxHandleLike { stop(): void; setPos?(p: Vec3): void }
interface SfxLike {
  play(id: string, pos?: Vec3 | null, opts?: { volume?: number; loop?: boolean; radius?: number; rate?: number; ui?: boolean; id?: string }): SfxHandleLike | null;
  flicker?(space: number, ms: number): void;
}
interface RenderLike { flickerSpace?(space: number, ms: number): void }
interface LevelLike { doorOpen?: DoorOpenFn; spaceGroup?(space: number): THREE.Group | null }
interface PlayersLike { freeze?(reason: string, on: boolean): void; localPose?(): { p: Vec3; yaw: number } | null; cameraPos?(): Vec3; setFlashlightEnabled?(on: boolean): void; flashlightOn?(): boolean }
interface InputLike { teleport?(x: number, z: number, yaw?: number): void; look?(yaw: number, pitch: number): void }

declare module '../core/bus.ts' {
  interface BusEvents {
    /** Listener tell: the local walkie LED flickers red for ms (interaction's walkie HUD may show it) */
    'monsters:led': { ms: number };
    /** local visor blink started (mannequin mechanic) */
    'monsters:blink': { ms: number };
    /** local player grabbed / released by the Listener */
    'monsters:grabbed': { on: boolean };
    /** local player snatched / released by the Snatcher (phase 'drop' | 'drag' | 'duct' | null) */
    'monsters:snatched': { on: boolean; phase: string | null };
  }
}

interface View {
  id: string;
  kind: string;
  root: THREE.Group;
  model: MonsterModel | null;
  placeholder: THREE.Object3D | null;
  current: number;
  frozenAt: number;
  speed: number;
  lastP: THREE.Vector3;
  loop: SfxHandleLike | null;
  loopKey: string;
  state: string;
  tilt: number;
  /** performance.now() the Snatcher's drop started (fall from the ceiling) */
  dropAt: number;
}

const CUE_SFX: Record<string, [string, number, number?]> = {
  rattle: ['sfx.listener_vent_crawl', 0.85, 1.12],
  dust: ['sfx.cloth', 0.22, 1.7],
  tick: ['sfx.listener_click_tick', 0.42, 1.38],
  snatch: ['sfx.creature_scream', 1, 0.9],
  scratch: ['sfx.mannequin_scrape', 0.65, 0.85],
  shriek: ['sfx.creature_scream', 1, 1.3],
  growl: ['sfx.hound_growl_low', 1],
  huff: ['sfx.hound_alert_huff', 0.9],
  bark: ['sfx.hound_charge_bark', 1],
  sniff: ['sfx.hound_sniff', 0.7],
  eat: ['sfx.hound_eating', 0.9],
  lunge: ['sfx.hound_charge_bark', 1],
  creak: ['sfx.mannequin_creak', 0.8],
  click: ['sfx.listener_click_tick', 0.8],
  vent: ['sfx.listener_vent_crawl', 1],
  scream: ['sfx.creature_scream', 1],
  breath: ['sfx.creature_breath', 0.7],
};

export function install(ctx: ClientContext): void {
  if (ctx.params.get('nomonsters') === '1') return;
  const views = new Map<string, View>();
  let lib: MonsterLib | null = null;
  let libRequested = false;
  const use = <T,>(name: string) => (ctx.services.use as unknown as (n: string) => T | undefined)(name);
  const sfx = () => use<SfxLike>('sfx');
  const render = () => use<RenderLike>('render');
  const level = () => use<LevelLike>('level');
  const players = () => use<PlayersLike>('players');
  const serverToLocal = (serverMs: number) => performance.now() + (serverMs - ctx.world.serverNow());

  // ---------------- camera / grid helpers ----------------
  const camPos = (): THREE.Vector3 | null => {
    const cam = ctx.services.use('three')?.camera;
    if (!cam) return null;
    return cam.getWorldPosition(new THREE.Vector3());
  };
  let gridFor: { layout: LevelLayout | null; grid: EdgeGrid | null; init: DoorOpenFn } = { layout: null, grid: null, init: () => true };
  const grid = (): EdgeGrid | null => {
    const L = ctx.world.layout;
    if (gridFor.layout !== L) {
      gridFor = { layout: L, grid: null, init: () => true };
      if (L && Array.isArray(L.owner)) {
        try { gridFor = { layout: L, grid: buildEdgeGrid(L), init: initialDoorOpen(L) }; } catch { /* bad layout */ }
      }
    }
    return gridFor.grid;
  };
  const doorOpen = (): DoorOpenFn => level()?.doorOpen ?? gridFor.init;

  const playAt = (key: string, p: Vec3, opts: { volume?: number; radius?: number; rate?: number } = {}) => {
    try { return sfx()?.play(key, p, opts) ?? null; } catch { return null; }
  };
  const play2d = (key: string, opts: { volume?: number; rate?: number } = {}) => {
    try { return sfx()?.play(key, null, { ...opts, ui: true }) ?? null; } catch { return null; }
  };
  const within = (p: Vec3, r: number) => {
    const c = camPos();
    return !c || Math.hypot(c.x - p[0], c.z - p[2]) <= r;
  };

  // ---------------- views ----------------
  // readiness part 'monsters' (loading screen): models loaded + every monster pipeline compiled (compileAsync on the
  // warm-up group against the real scene); never blocks for long (15 s safety, failure = done)
  const monstersReady = ctx.readiness.require('monsters');
  let readyDone = false;
  const finishReady = () => { if (!readyDone) { readyDone = true; monstersReady(); } };
  setTimeout(finishReady, 15000);
  const ensureLib = () => {
    if (libRequested) return;
    libRequested = true;
    void loadMonsterLib((m) => console.info(`[monsters] ${m}`)).then((l) => {
      lib = l;
      if (!l) { finishReady(); return; }
      for (const v of views.values()) attachModel(v);
      const tryWarm = (n: number) => {
        if (!ctx.services.use('three')) { if (n < 40) setTimeout(() => tryWarm(n + 1), 250); else finishReady(); return; }
        startWarmup(true);
      };
      tryWarm(0);
    });
  };

  // ---- shader warm-up: draw every monster once (tiny, at the camera) so its pipelines compile now, not the first
  // time it appears (a 1-2 s compile hitch there would let the mannequin move while you watch it) ----
  let warmGroup: THREE.Group | null = null;
  let warmFrames = 0;
  const startWarmup = (compile = false) => {
    const three = ctx.services.use('three');
    if (!three || !lib) return;
    warmGroup?.removeFromParent();
    warmGroup = new THREE.Group();
    warmGroup.name = 'monsters:warmup';
    for (const t of Object.values(lib.templates)) {
      if (!t) continue;
      const m = instantiate(t);
      m.root.scale.setScalar(0.004);
      m.mixer.update(0);
      warmGroup.add(m.root);
    }
    // the Snatcher's local effects (dust motes, drag trail, duct) get their pipelines now too
    for (const src of [dust, trail]) {
      const im = new THREE.InstancedMesh(src.geometry, src.material, 1);
      im.setMatrixAt(0, new THREE.Matrix4().makeScale(0.004, 0.004, 0.004));
      im.castShadow = false;
      warmGroup.add(im);
    }
    for (const src of [ductBox, ductEnd]) {
      const mm = new THREE.Mesh(src.geometry, src.material);
      mm.scale.setScalar(0.004);
      warmGroup.add(mm);
    }
    three.scene.add(warmGroup);
    warmFrames = 4;
    if (compile) {
      const g = warmGroup;
      const r = three.renderer as unknown as { compileAsync?(o: THREE.Object3D, c: THREE.Camera, s?: THREE.Scene): Promise<void> };
      if (r.compileAsync) {
        const t0 = performance.now();
        void Promise.race([r.compileAsync(g, three.camera, three.scene), new Promise((res) => setTimeout(res, 8000))])
          .then(() => { console.info(`[monsters] pipelines compiled in ${Math.round(performance.now() - t0)} ms`); finishReady(); }, () => finishReady());
      } else finishReady();
    }
  };
  const warmTick = () => {
    const three = ctx.services.use('three');
    if (!warmGroup || !three) return;
    if (warmFrames-- <= 0) { warmGroup.removeFromParent(); warmGroup = null; return; }
    const cam = three.camera;
    const fwd = new THREE.Vector3();
    cam.getWorldDirection(fwd);
    warmGroup.position.copy(cam.getWorldPosition(new THREE.Vector3())).addScaledVector(fwd, 0.6);
  };

  const placeholder = (kind: string): THREE.Object3D => {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardNodeMaterial({ color: kind === 'mannequin' ? 0xe8e2d6 : 0x0a0a0c, roughness: kind === 'listener' ? 0.15 : 0.6 });
    if (kind === 'hound') {
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.25, 0.8, 4, 8), mat);
      body.rotation.x = Math.PI / 2;
      body.position.y = 0.55;
      g.add(body);
    } else if (kind === 'snatcher') {
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.14, 1.3, 4, 8), mat);
      body.rotation.x = Math.PI / 2;
      body.position.y = 0.4;
      g.add(body);
    } else {
      const tall = kind === 'listener' ? 2.35 : 1.85;
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, tall - 0.5, 4, 8), mat);
      body.position.y = tall / 2;
      g.add(body);
    }
    g.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return g;
  };

  const attachModel = (v: View) => {
    const t = lib?.templates[v.kind as keyof MonsterLib['templates']];
    if (!t || v.model) return;
    const m = instantiate(t);
    if (v.id === 'kennel') addKennelGlow(m);
    v.model = m;
    if (v.placeholder) { v.root.remove(v.placeholder); v.placeholder = null; }
    v.root.add(m.root);
    v.current = -1;
  };

  const makeView = (s: SnapMonster): View => {
    const root = new THREE.Group();
    root.name = `monster:${s.id}`;
    const v: View = { id: s.id, kind: s.kind, root, model: null, placeholder: null, current: -1, frozenAt: 0, speed: 0, lastP: new THREE.Vector3(s.p[0], 0, s.p[2]), loop: null, loopKey: '', state: s.state, tilt: 0.42 + Math.random() * 0.2, dropAt: 0 };
    ensureLib();
    if (lib) attachModel(v);
    if (!v.model) { v.placeholder = placeholder(s.kind); root.add(v.placeholder); }
    ctx.services.use('three')?.scene.add(root);
    return v;
  };

  const dropView = (v: View) => {
    v.root.removeFromParent();
    v.loop?.stop();
    v.model?.mixer.stopAllAction();
  };

  const setAnim = (v: View, anim: number, dt: number, s: SnapMonster) => {
    const m = v.model;
    if (!m) return;
    m.mixer.update(dt);
    if (anim === ANIM.mFrozen) {
      // frozen: pause whatever pose it is in (mid-stride is the scariest)
      const cur = m.actions.get(v.current);
      if (cur) cur.timeScale = 0;
      else if (m.actions.get(ANIM.mFrozen)) {
        const a = m.actions.get(ANIM.mFrozen)!;
        a.reset().play();
        a.time = (Math.abs(Math.sin(s.p[0] * 3.1 + s.p[2])) * a.getClip().duration) % a.getClip().duration;
        a.timeScale = 0;
        v.current = ANIM.mFrozen;
      }
      return;
    }
    let id = anim;
    if (!m.actions.has(id)) id = m.actions.has(ANIM.mIdle) ? ANIM.mIdle : [...m.actions.keys()][0];
    const a = m.actions.get(id);
    if (!a) return;
    const clip = m.clips.get(id)!;
    if (v.current !== id) {
      const prev = m.actions.get(v.current);
      a.reset();
      a.enabled = true;
      a.setEffectiveWeight(1);
      a.play();
      if (prev && prev !== a) prev.crossFadeTo(a, id === ANIM.mAttack ? 0.12 : 0.28, false);
      v.current = id;
    }
    let ts = clip.timeScale || 1;
    if (clip.natural > 0 && v.speed > 0.2) ts = Math.min(1.8, Math.max(0.55, v.speed / clip.natural)) * (clip.timeScale || 1);
    a.timeScale = ts;
  };

  const loopFor = (v: View, s: SnapMonster): string => {
    if (!s.active) return '';
    if (v.kind === 'mannequin' && (s.state === 'move' || s.state === 'door')) return 'sfx.mannequin_scrape';
    if (v.kind === 'listener') return 'sfx.fluorescent_hum_loop';
    if (v.kind === 'hound' && s.state === 'eat') return 'sfx.hound_eating';
    return '';
  };

  // ---------------- mannequin sightings ----------------
  let blinkUntil = 0;
  let seeAcc = 0;
  const seeStats: { sent: number; last: Record<string, boolean> | null; err: string; skip: string; frames: number; reached: number; why: string } = { sent: 0, last: null, err: '', skip: '', frames: 0, reached: 0, why: '' };
  ctx.diag.monstersSee = seeStats;
  const frustum = new THREE.Frustum();
  const pv = new THREE.Matrix4();
  const tmp = new THREE.Vector3();
  const reportSightings = (dt: number) => {
    seeAcc += dt;
    if (seeAcc < 0.1) return;
    seeAcc = 0;
    const cam = ctx.services.use('three')?.camera;
    const g = grid();
    const mans = [...ctx.world.monsters.keys()].map((id) => ctx.world.sampleMonster(id)).filter((s): s is SnapMonster => !!s && s.kind === 'mannequin' && s.active);
    if (!mans.length || !cam || ctx.world.phase !== 'contract') { seeStats.skip = `mans=${mans.length} cam=${!!cam} phase=${ctx.world.phase}`; return; }
    cam.updateMatrixWorld();
    pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    frustum.setFromProjectionMatrix(pv);
    const c = cam.getWorldPosition(new THREE.Vector3());
    const blinking = performance.now() < blinkUntil;
    const out: Record<string, boolean> = {};
    for (const s of mans) {
      let vis = false;
      const d = Math.hypot(c.x - s.p[0], c.z - s.p[2]);
      if (!blinking && d <= 30) {
        for (const y of [0.3, 1.2, 1.7]) {
          if (frustum.containsPoint(tmp.set(s.p[0], y, s.p[2]))) { vis = true; break; }
        }
        if (!vis) seeStats.why = `frustum c=${c.x.toFixed(1)},${c.z.toFixed(1)} m=${s.p[0]},${s.p[2]}`;
        if (vis && g) { vis = los(g, c.x, c.z, s.p[0], s.p[2], doorOpen()); if (!vis) seeStats.why = 'los'; }
      } else seeStats.why = blinking ? 'blink' : `far ${d.toFixed(1)}`;
      out[s.id] = vis;
    }
    seeStats.sent++;
    seeStats.last = out;
    void ctx.net.req('monsters.see', { s: out }, 2000).catch((e: unknown) => { seeStats.err = String(e); });
  };

  // ---------------- overlays (visor blink, grab vignette, death card fallback) ----------------
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:40;background:#000;opacity:0;transition:opacity 40ms linear';
  const vignette = document.createElement('div');
  vignette.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:39;opacity:0;transition:opacity 120ms;background:radial-gradient(ellipse at center, rgba(0,0,0,0) 35%, rgba(120,0,0,0.55) 75%, rgba(40,0,0,0.92) 100%)';
  const card = document.createElement('div');
  card.style.cssText = 'position:fixed;left:50%;top:38%;transform:translate(-50%,-50%);pointer-events:none;z-index:41;display:none;text-align:center;font:600 22px/1.35 ui-monospace,Consolas,monospace;color:#e8e2d6;text-shadow:0 0 12px #000;letter-spacing:0.08em';
  document.body.append(overlay, vignette, card);

  const blink = (atServer: number, ms: number) => {
    const start = serverToLocal(atServer);
    const delay = Math.max(0, start - performance.now());
    setTimeout(() => {
      blinkUntil = performance.now() + ms;
      overlay.style.opacity = '0.94';
      play2d('sfx.metal_click', { volume: 0.35, rate: 1.6 });
      ctx.bus.emit('monsters:blink', { ms });
      setTimeout(() => { overlay.style.opacity = '0'; }, ms);
    }, delay);
  };

  // ---------------- grab ----------------
  const grabState = signal<{ id: string; victim: string; until: number; p: Vec3 } | null>(null);
  const ledUntil = signal(0);
  let lastShove = 0;
  const myId = () => ctx.world.me ?? ctx.net.me;
  const nearGrab = (): boolean => {
    const gs = grabState.value;
    const me = myId();
    if (!gs || !me || gs.victim === me) return false;
    const c = players()?.localPose?.()?.p ?? (camPos() ? [camPos()!.x, 0, camPos()!.z] as Vec3 : null);
    if (!c) return false;
    const lm = ctx.world.sampleMonster(gs.id);
    const dl = lm ? Math.hypot(c[0] - lm.p[0], c[2] - lm.p[2]) : 99;
    // the server's shove range (balance listener.shoveRangeM) plus a little slack for interpolation
    const range = Number((ctx.balance.monsters as { listener?: { shoveRangeM?: number } } | undefined)?.listener?.shoveRangeM ?? 2.6) + 0.2;
    return Math.min(dl, Math.hypot(c[0] - gs.p[0], c[2] - gs.p[2])) <= range;
  };
  const shove = (kind: 'shove' | 'melee') => {
    if (!nearGrab() || performance.now() - lastShove < 250) return;
    lastShove = performance.now();
    void ctx.net.req('monsters.shove', { kind }).catch(() => null);
  };
  const busAny = ctx.bus as unknown as { on(k: string, fn: (d: { down?: boolean }) => void): () => void };
  busAny.on('action:interact', (d) => { if (d?.down !== false) shove('shove'); });
  busAny.on('action:use', (d) => { if (d?.down !== false) shove('melee'); });
  addEventListener('keydown', (e) => { if (e.code === 'KeyE' && !e.repeat) shove('shove'); });

  ctx.ui.registerHud('center', () => {
    const gs = grabState.value;
    const me = myId();
    if (!gs) return null;
    if (gs.victim === me) return h('div', { class: 'hud-chip', style: 'color:#ff6b5b;font-weight:700;letter-spacing:0.12em' }, 'IT HAS YOU — SCREAM FOR HELP');
    return nearGrab() ? h('div', { class: 'hud-chip', style: 'color:#ffd27a;font-weight:700;letter-spacing:0.1em' }, '[E] SHOVE IT OFF') : null;
  }, { id: 'monsters-grab', order: 5 });
  ctx.ui.registerHud('top-right', () => (ledUntil.value > performance.now() && !use<unknown>('interaction')
    ? h('div', { class: 'hud-chip', title: 'walkie', style: 'color:#ff3030' }, h('span', { style: 'display:inline-block;width:9px;height:9px;border-radius:50%;background:#ff2a2a;box-shadow:0 0 8px #ff2a2a;margin-right:6px' }), 'RX')
    : null), { id: 'monsters-led', order: 60 });

  // ---------------- events ----------------
  const net = ctx.net;

  // ---------------- Snatcher (v1.1): dust, drag trail, duct, victim camera, struggle, rescue ----------------
  const input = () => use<InputLike>('input');
  const sceneOf = () => ctx.services.use('three')?.scene ?? null;
  const AXIS_Y = new THREE.Vector3(0, 1, 0);
  const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), s4 = new THREE.Vector3(), p4 = new THREE.Vector3();
  // dust motes: one instanced pool; lit by flashlights (faint self-glow so a lit corridor still shows the trickle)
  const DUST_N = 192;
  const dustMat = new THREE.MeshStandardNodeMaterial({ color: 0xa8a294, roughness: 1, metalness: 0, emissive: 0x1a1814 });
  const dust = new THREE.InstancedMesh(new THREE.BoxGeometry(0.018, 0.018, 0.018), dustMat, DUST_N);
  dust.name = 'monsters:dust';
  dust.frustumCulled = false;
  dust.castShadow = false;
  dust.count = 0;
  const bursts: { x: number; y: number; z: number; t0: number; n: number; seed: number; spread: number }[] = [];
  const addDust = (p: Vec3, n = 56, spread = 0.4) => {
    bursts.push({ x: p[0], y: p[1], z: p[2], t0: performance.now(), n, seed: Math.random() * 1000, spread });
    if (bursts.length > 6) bursts.shift();
  };
  const frac = (v: number) => v - Math.floor(v);
  const updateDust = () => {
    const now = performance.now();
    let k = 0;
    for (let b = bursts.length - 1; b >= 0; b--) {
      const B = bursts[b];
      const t = (now - B.t0) / 1000;
      if (t > 3.6) { bursts.splice(b, 1); continue; }
      for (let i = 0; i < B.n && k < DUST_N; i++) {
        const r1 = frac(Math.sin((i + 1) * 12.9898 + B.seed) * 43758.5453);
        const r2 = frac(Math.sin((i + 1) * 78.233 + B.seed) * 12543.123);
        const r3 = frac(Math.sin((i + 1) * 39.425 + B.seed) * 9123.77);
        const tt = t - r3 * 1.2;
        if (tt < 0) continue;
        const y = B.y - (0.28 * tt + 0.16 * tt * tt);
        if (y < 0.02) continue;
        p4.set(B.x + (r1 - 0.5) * B.spread + Math.sin(tt * 2 + i) * 0.03, y, B.z + (r2 - 0.5) * B.spread + Math.cos(tt * 1.7 + i) * 0.03);
        const sc = 0.5 + r3;
        s4.set(sc, sc, sc);
        q4.setFromAxisAngle(AXIS_Y, tt * 3 + i);
        m4.compose(p4, q4, s4);
        dust.setMatrixAt(k++, m4);
      }
    }
    dust.count = k;
    if (k) {
      dust.instanceMatrix.needsUpdate = true;
      if (!dust.parent) sceneOf()?.add(dust);
    }
  };
  // the drag trail: wet dark smears on the floor along the victim's path (everyone sees it; it stays this contract)
  const TRAIL_N = 360;
  const trailMat = new THREE.MeshStandardNodeMaterial({ color: 0x1c0705, roughness: 0.12, metalness: 0, transparent: true, opacity: 0.82, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  {
    // ragged, streaky wet smear (not a rectangle): soft elliptical edge broken up by noise, claw streaks along the drag
    const c = uv().sub(0.5).mul(2.0);
    const edge = c.x.mul(c.x).add(c.y.mul(c.y).mul(0.55));
    const ragged = mx_noise_float(uv().mul(vec2(4.0, 3.0)).add(float(7.3))).mul(0.45);
    const streak = mx_noise_float(vec2(uv().x.mul(16.0), uv().y.mul(1.4))).mul(0.5).add(0.5);
    trailMat.opacityNode = smoothstep(float(1.0), float(0.3), edge.add(ragged)).mul(streak.mul(0.6).add(0.4)).mul(0.9);
  }
  const trailGeo = new THREE.PlaneGeometry(0.34, 0.5);
  trailGeo.rotateX(-Math.PI / 2);
  const trail = new THREE.InstancedMesh(trailGeo, trailMat, TRAIL_N);
  trail.name = 'monsters:trail';
  trail.frustumCulled = false;
  trail.castShadow = false;
  trail.receiveShadow = true;
  trail.count = 0;
  let trailK = 0;
  let trailLast: [number, number] | null = null;
  const stamp = (x: number, z: number, yaw: number, w = 1) => {
    const i = trailK % TRAIL_N;
    trailK++;
    q4.setFromAxisAngle(AXIS_Y, yaw + (Math.random() - 0.5) * 0.25);
    p4.set(x + (Math.random() - 0.5) * 0.06, 0.011 + (i % 7) * 0.0004, z + (Math.random() - 0.5) * 0.06);
    s4.set(w * (0.8 + Math.random() * 0.4), 1, 0.85 + Math.random() * 0.35);
    m4.compose(p4, q4, s4);
    trail.setMatrixAt(i, m4);
    trail.count = Math.min(TRAIL_N, trailK);
    trail.instanceMatrix.needsUpdate = true;
    if (!trail.parent) sceneOf()?.add(trail);
  };
  const trailTo = (x: number, z: number) => {
    if (!trailLast) { trailLast = [x, z]; stamp(x, z, 0, 1.5); return; }
    const [lx, lz] = trailLast;
    const d = Math.hypot(x - lx, z - lz);
    if (d < 0.28) return;
    const yaw = Math.atan2(x - lx, z - lz);
    const n = Math.min(40, Math.max(1, Math.floor(d / 0.28)));
    for (let i = 1; i <= n; i++) stamp(lx + ((x - lx) * i) / n, lz + ((z - lz) * i) / n, yaw);
    trailLast = [x, z];
  };
  const clearTrail = () => { trail.count = 0; trailK = 0; trailLast = null; };
  // the duct the victim is dragged into (local only): a cramped metal box behind the grate, faint light far down it
  const ductMat = new THREE.MeshStandardNodeMaterial({ color: 0x0b0c0d, roughness: 0.85, metalness: 0.1, side: THREE.BackSide, emissive: 0x020203 });
  const duct = new THREE.Group();
  duct.name = 'monsters:duct';
  const ductBox = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.62, 6), ductMat);
  ductBox.position.z = -3;
  const ductEnd = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.5), new THREE.MeshBasicNodeMaterial({ color: 0x3a2a1c }));
  ductEnd.position.z = -5.95;
  duct.add(ductBox, ductEnd);
  duct.traverse((o) => { o.frustumCulled = false; o.castShadow = false; o.receiveShadow = false; });
  duct.visible = false;

  interface SnatchSt { id: string; victim: string; phase: string; p: Vec3; grate: NonNullable<SnatchEvent['grate']>; progress: number; pull: number; struggle: number; eta: number }
  const snatch = signal<SnatchSt | null>(null);
  const snatchUi = signal(0);
  let snatchedMe = false;
  let holdingE = false;
  let lastPullSent = 0;
  let lastStruggle = 0;
  const smooth = { x: 0, z: 0, init: false };
  const nameOf = (id: string) => ctx.world.crew?.players.find((p) => p.id === id)?.name ?? 'them';
  const rescueSpot = (st: SnatchSt): Vec3 => (st.phase === 'duct' ? st.grate.front : st.p);
  const myPos = (): Vec3 | null => players()?.localPose?.()?.p ?? null;
  const nearRescue = (): boolean => {
    const st = snatch.value;
    const me = myId();
    const c = myPos();
    if (!st || !me || st.victim === me || !c) return false;
    const r = rescueSpot(st);
    return Math.hypot(c[0] - r[0], c[2] - r[2]) <= 2.1;
  };
  const struggleNow = () => {
    if (performance.now() - lastStruggle < 45) return;
    lastStruggle = performance.now();
    void ctx.net.req('monsters.struggle', {}).then((r) => { const st = snatch.value; if (st && r) st.struggle = r.struggle; }).catch(() => null);
  };
  const onE = (down: boolean) => {
    const st = snatch.value;
    const me = myId();
    if (!st || !me) { holdingE = false; return; }
    if (st.victim === me) { if (down) struggleNow(); return; }
    if (holdingE && !down) void ctx.net.req('monsters.pull', { on: false }).catch(() => null);
    holdingE = down;
  };
  busAny.on('action:interact', (d) => onE(d?.down !== false));
  const typingIn = (e: KeyboardEvent) => { const t = e.target as HTMLElement | null; return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable); };
  addEventListener('keydown', (e) => { if (e.code === 'KeyE' && !e.repeat && !typingIn(e)) onE(true); });
  addEventListener('keyup', (e) => { if (e.code === 'KeyE' && !typingIn(e)) onE(false); });

  type HidePlayers = PlayersLike & { setHidden?(h: boolean, at?: Vec3, yaw?: number): void };
  const endSnatchLocal = (ev: SnatchEvent | null) => {
    if (!snatchedMe) return;
    snatchedMe = false;
    const pl = players() as HidePlayers | undefined;
    pl?.setHidden?.(false);
    pl?.freeze?.('monsters.snatch', false);
    duct.visible = false;
    overlay.style.opacity = '0';
    vignette.style.opacity = '0';
    if (ev && ev.state === 'freed') {
      const g = snatch.value?.grate;
      const yaw = g ? Math.atan2(g.n[0], g.n[1]) : undefined;
      input()?.teleport?.(ev.p[0], ev.p[2], yaw);
      input()?.look?.(yaw ?? 0, 0);
    }
    ctx.bus.emit('monsters:snatched', { on: false, phase: null });
  };

  net.on('monsters.snatch', (d) => {
    const me = myId();
    if (d.state === 'start' && d.grate) {
      snatch.value = { id: d.id, victim: d.victim, phase: d.phase ?? 'drop', p: d.p, grate: d.grate, progress: d.progress ?? 0, pull: 0, struggle: 0, eta: d.eta ?? 0 };
      trailLast = null;
      trailTo(d.p[0], d.p[2]);
      addDust([d.p[0], 2.7, d.p[2]], 64, 0.7);
      if (d.victim === me) {
        snatchedMe = true;
        smooth.x = d.p[0];
        smooth.z = d.p[2];
        smooth.init = true;
        players()?.freeze?.('monsters.snatch', true);
        vignette.style.opacity = '1';
        play2d('sfx.breath_scared', { volume: 1 });
        play2d('sfx.body_fall', { volume: 0.9 });
        ctx.bus.emit('monsters:snatched', { on: true, phase: d.phase ?? 'drop' });
      }
    } else if (d.state === 'tick') {
      const st = snatch.value;
      if (!st || st.victim !== d.victim) return;
      const was = st.phase;
      snatch.value = { ...st, phase: d.phase ?? st.phase, p: d.p, progress: d.progress ?? st.progress, pull: d.pull ?? st.pull, struggle: d.struggle ?? st.struggle, eta: d.eta ?? st.eta };
      if (was !== 'duct' && d.phase === 'duct') {
        addDust([st.grate.p[0] + st.grate.n[0] * 0.05, 0.6, st.grate.p[2] + st.grate.n[1] * 0.05], 48, 0.3);
        if (d.victim === me) { play2d('sfx.metal_hit', { volume: 0.7, rate: 0.8 }); ctx.bus.emit('monsters:snatched', { on: true, phase: 'duct' }); }
      }
    } else {
      if (d.state === 'freed') {
        const g = snatch.value?.grate;
        if (g) playAt('sfx.metal_hit', g.p, { volume: 0.9, radius: 20 });
        if (d.victim === me) play2d('sfx.breath_scared', { volume: 0.8 });
      }
      endSnatchLocal(d);
      snatch.value = null;
      holdingE = false;
    }
  });

  const victimCamera = (st: SnatchSt, dt: number) => {
    const three = ctx.services.use('three');
    const cam = three?.camera;
    if (!cam) return;
    const pl = players() as HidePlayers | undefined;
    const g = st.grate;
    const nx = g.n[0], nz = g.n[1];
    const k = 1 - Math.exp(-8 * dt);
    const tx = st.phase === 'duct' ? g.front[0] : st.p[0], tz = st.phase === 'duct' ? g.front[2] : st.p[2];
    if (!smooth.init) { smooth.x = tx; smooth.z = tz; smooth.init = true; }
    smooth.x += (tx - smooth.x) * k;
    smooth.z += (tz - smooth.z) * k;
    const t = performance.now() / 1000;
    const shake = (Math.sin(t * 31) * 0.012 + Math.sin(t * 17.3) * 0.02) * (st.phase === 'drop' ? 3 : 1);
    // keep the controller on the server's drag pose (poses validate); viewmodel + own light are off while dragged
    input()?.teleport?.(smooth.x, smooth.z);
    if (st.phase === 'duct') {
      const ax = g.p[0] - nx * 0.6, az = g.p[2] - nz * 0.6;
      pl?.setHidden?.(true, [ax, 0.32, az], Math.atan2(-nx, -nz));
      duct.visible = true;
      duct.position.set(g.p[0] - nx * 0.15, 0.33, g.p[2] - nz * 0.15);
      duct.rotation.set(0, Math.atan2(nx, nz), 0);
      if (!duct.parent) sceneOf()?.add(duct);
      cam.position.set(ax + shake, 0.32 + shake * 0.5, az);
      cam.lookAt(g.p[0] - nx * 4, 0.28 + Math.sin(t * 9) * 0.03, g.p[2] - nz * 4);
      overlay.style.opacity = String(0.42 + 0.12 * Math.sin(t * 3.1));
    } else {
      duct.visible = false;
      pl?.setHidden?.(true, [smooth.x, 0.36, smooth.z]);
      const sm = ctx.world.sampleMonster(st.id);
      cam.position.set(smooth.x + shake, 0.36 + Math.abs(shake), smooth.z - shake);
      if (sm && sm.active) cam.lookAt(sm.p[0], 0.7, sm.p[2]);
      else cam.lookAt(g.p[0], 0.4, g.p[2]);
      cam.rotateZ(0.35 + Math.sin(t * 2.3) * 0.08);
      overlay.style.opacity = String(0.16 + 0.1 * Math.sin(t * 4.7));
    }
    cam.updateMatrixWorld();
    vignette.style.opacity = String(0.8 + 0.2 * Math.sin(t * 11));
  };

  const snatcherView = (v: View, s: SnapMonster, visible: boolean) => {
    const st = snatch.value;
    v.root.userData.duct = false;
    // the drop: it falls out of the ceiling duct onto its victim
    if (s.state === 'drop' && visible) {
      if (!v.dropAt) v.dropAt = performance.now();
      const k = Math.min(1, (performance.now() - v.dropAt) / 380);
      v.root.position.y = 2.6 * (1 - k) * (1 - k);
    } else {
      v.dropAt = 0;
      v.root.position.y = 0;
    }
    // the victim sees it in the duct ahead of them, reeling them in
    if (st && st.id === s.id && st.victim === myId() && st.phase === 'duct' && snatchedMe) {
      const g = st.grate;
      v.root.visible = true;
      v.root.userData.duct = true;
      v.root.position.set(g.p[0] - g.n[0] * 2.1, 0, g.p[2] - g.n[1] * 2.1);
      v.root.rotation.y = Math.atan2(g.n[0], g.n[1]);
    }
  };

  const snatchFrame = (dt: number) => {
    updateDust();
    const st = snatch.value;
    if (!st) { duct.visible = false; return; }
    const me = myId();
    if (st.phase === 'duct') trailTo(st.grate.front[0], st.grate.front[2]);
    else trailTo(st.p[0], st.p[2]);
    if (me && st.victim !== me && holdingE && performance.now() - lastPullSent > 200) {
      lastPullSent = performance.now();
      void ctx.net.req('monsters.pull', { on: true }).catch(() => null);
    }
    if (me && st.victim === me && snatchedMe) victimCamera(st, dt);
    snatchUi.value = (snatchUi.value + 1) % 1000000;
  };

  const bar = (f: number, col: string) => h('div', { style: 'width:220px;height:6px;background:rgba(255,255,255,0.12);margin:6px auto 0;border-radius:3px;overflow:hidden' },
    h('div', { style: `width:${Math.round(Math.max(0, Math.min(1, f)) * 100)}%;height:100%;background:${col}` }));
  ctx.ui.registerHud('center', () => {
    void snatchUi.value;
    const st = snatch.value;
    const me = myId();
    if (!st || !me) return null;
    const left = Math.max(0, Math.round((st.eta - ctx.world.serverNow()) / 1000));
    if (st.victim === me) {
      return h('div', { class: 'hud-chip', style: 'color:#ff6b5b;font-weight:700;letter-spacing:0.12em;text-align:center' },
        st.phase === 'duct' ? 'IN THE VENT: MASH [E], SCREAM FOR HELP' : 'IT IS DRAGGING YOU: MASH [E]',
        bar(st.struggle, '#ffd27a'), bar(1 - st.progress, '#ff4a3a'));
    }
    if (nearRescue()) {
      return h('div', { class: 'hud-chip', style: 'color:#ffd27a;font-weight:700;letter-spacing:0.1em;text-align:center' },
        `[HOLD E] PULL ${nameOf(st.victim).toUpperCase()} OUT`, bar(st.pull, '#ffd27a'));
    }
    return h('div', { class: 'hud-chip', style: 'color:#ff9a7a;font-weight:600;letter-spacing:0.08em' },
      `${nameOf(st.victim).toUpperCase()} WAS TAKEN: FOLLOW THE SCRATCHING (${left} s)`);
  }, { id: 'monsters-snatch', order: 4 });
  net.on('monsters.cue', (d) => {
    const s = CUE_SFX[d.cue];
    if (d.cue === 'dust') addDust([d.p[0], d.p[1], d.p[2]], d.p[1] > 1.5 ? 56 : 40, d.p[1] > 1.5 ? 0.6 : 0.3);
    if (!s || !within(d.p, d.radius)) return;
    const p: Vec3 = d.kind === 'snatcher' ? [d.p[0], d.p[1], d.p[2]] : [d.p[0], d.kind === 'hound' ? 0.6 : 1.6, d.p[2]];
    playAt(s[0], p, { volume: s[1], radius: d.radius, rate: s[2] ?? 1 });
    if (d.cue === 'rattle') playAt('sfx.metal_click', p, { volume: 0.6, radius: d.radius, rate: 0.7 });
    if (d.cue === 'snatch') playAt('sfx.body_fall', [d.p[0], 0.3, d.p[2]], { volume: 1, radius: d.radius });
    if (d.cue === 'scratch') playAt('sfx.listener_vent_crawl', p, { volume: 0.55, radius: d.radius, rate: 0.9 });
    if (d.cue === 'lunge') playAt('sfx.metal_hit', p, { volume: 0.8, radius: d.radius });
    if (d.cue === 'eat') playAt('sfx.bone_crack', p, { volume: 0.7, radius: 12 });
  });
  net.on('monsters.telegraph', (d) => {
    render()?.flickerSpace?.(d.space, d.ms);
    sfx()?.flicker?.(d.space, d.ms);
    const me = myId();
    if (me && d.squelch.includes(me)) play2d('sfx.radio_squelch_on', { volume: 0.8 });
  });
  net.on('monsters.wake', (d) => {
    const L = ctx.world.layout;
    if (L) for (const s of L.spaces) { render()?.flickerSpace?.(s.id, d.ms); sfx()?.flicker?.(s.id, d.ms); }
    play2d('sfx.radio_squelch_on', { volume: 0.9 });
    setTimeout(() => play2d('sfx.radio_static_burst', { volume: 0.5 }), 180);
  });
  net.on('monsters.lure', (d) => {
    const me = myId();
    if (d.p) {
      playAt('sfx.radio_static_burst', d.p, { volume: 0.8, radius: 14 });
      setTimeout(() => playAt(d.clip, d.p!, { volume: 0.9, radius: 14, rate: 0.94 }), 350);
    } else if (me && d.to.includes(me)) {
      // no PTT click: static straight into a garbled half-voice
      play2d('sfx.radio_static_burst', { volume: 0.55 });
      setTimeout(() => play2d(d.clip, { volume: 0.85, rate: 0.93 }), 320);
    }
  });
  net.on('monsters.led', (d) => {
    const me = myId();
    if (!me || !d.to.includes(me)) return;
    ledUntil.value = performance.now() + d.ms;
    ctx.bus.emit('monsters:led', { ms: d.ms });
    setTimeout(() => { ledUntil.value = 0; }, d.ms + 30);
  });
  net.on('monsters.blink', (d) => blink(d.at, d.ms));
  net.on('monsters.vent', (d) => {
    playAt('sfx.listener_vent_crawl', d.from, { volume: 1, radius: 16 });
    setTimeout(() => playAt('sfx.listener_vent_crawl', d.to, { volume: 1, radius: 16 }), Math.max(0, d.ms - 600));
  });
  net.on('monsters.director', (d) => {
    const me = myId();
    switch (d.kind) {
      case 'flicker':
        if (d.space !== undefined) { render()?.flickerSpace?.(d.space, d.ms ?? 900); sfx()?.flicker?.(d.space, d.ms ?? 900); }
        break;
      case 'door_slam':
        if (d.p) playAt('sfx.distant_door_slam', d.p, { volume: 1, radius: 40 });
        break;
      case 'radio_static':
        if (me && d.to?.includes(me)) play2d('sfx.radio_static_burst', { volume: 0.5 });
        break;
      case 'fixture_failure':
        if (d.space !== undefined) render()?.flickerSpace?.(d.space, d.ms ?? 900);
        if (d.p) playAt('sfx.glass_break', d.p, { volume: 0.8, radius: 20 });
        break;
      default:
        break;
    }
  });
  net.on('monsters.grab', (d) => {
    const me = myId();
    if (d.state === 'start') {
      grabState.value = { id: d.id, victim: d.victim, until: d.until, p: d.p };
      if (d.victim === me) {
        players()?.freeze?.('monsters.grab', true);
        vignette.style.opacity = '1';
        ctx.bus.emit('monsters:grabbed', { on: true });
        play2d('sfx.breath_scared', { volume: 0.9 });
      }
    } else {
      grabState.value = null;
      if (d.victim === me) {
        players()?.freeze?.('monsters.grab', false);
        vignette.style.opacity = '0';
        ctx.bus.emit('monsters:grabbed', { on: false });
      }
      if (d.state === 'freed') playAt('sfx.creature_growl', [d.p[0], 1.6, d.p[2]], { volume: 0.9, radius: 20 });
    }
  });
  net.on('monsters.kill', (d) => {
    const me = myId();
    if (within(d.p, 25)) playAt('sfx.bone_crack', [d.p[0], 1, d.p[2]], { volume: 0.9, radius: 25 });
    if (d.victim === me && !use<unknown>('interaction')) {
      // fallback death card (the interaction track normally owns death cards)
      card.textContent = `${d.killer.toUpperCase()} ${d.reason}${d.detail ? `, ${d.detail}` : ''}`;
      card.style.display = 'block';
      setTimeout(() => { card.style.display = 'none'; }, 4000);
    }
  });
  ctx.bus.on('world:phase', () => {
    if (lib) { startWarmup(); setTimeout(() => startWarmup(), 1500); }
    endSnatchLocal(null);
    snatch.value = null;
    clearTrail();
    bursts.length = 0;
    grabState.value = null;
    vignette.style.opacity = '0';
    players()?.freeze?.('monsters.grab', false);
  });

  // load + warm the models early (menu/join), long before a monster first appears (loading screen: readiness)
  ctx.bus.on('net:welcome', () => ensureLib());
  setTimeout(() => ensureLib(), 0);

  // ---------------- per-frame ----------------
  ctx.registerSystem({
    name: 'monsters',
    order: SYS.monsters,
    update(dt) {
      seeStats.frames++;
      const three = ctx.services.use('three');
      if (!three) return;
      const w = ctx.world;
      const show = w.phase === 'contract' || w.phase === 'hub';
      const seen = new Set<string>();
      for (const id of w.monsters.keys()) {
        const s = w.sampleMonster(id);
        if (!s) continue;
        seen.add(id);
        let v = views.get(id);
        if (!v || v.kind !== s.kind) {
          if (v) dropView(v);
          v = makeView(s);
          views.set(id, v);
        }
        if (!v.root.parent) three.scene.add(v.root);
        const visible = show && s.active;
        v.root.visible = visible;
        const np = new THREE.Vector3(s.p[0], s.p[1], s.p[2]);
        const inst = dt > 0 ? v.lastP.distanceTo(np) / dt : 0;
        v.speed = v.speed * 0.8 + Math.min(12, inst) * 0.2;
        v.lastP.copy(np);
        v.root.position.copy(np);
        v.root.rotation.y = s.yaw;
        if (v.kind === 'snatcher') snatcherView(v, s, visible);
        if (v.root.visible && v.kind === 'snatcher') {
          setAnim(v, s.anim, dt, s);
          const wa = v.model?.actions.get(v.current);
          // dragging: it crawls backward, facing its victim
          if (wa && (s.state === 'drag' || v.root.userData.duct)) wa.timeScale = -Math.abs(wa.timeScale || 1);
          if (v.model) poseSnatcher(v.model, v.root.userData.duct ? 'drag' : s.state, performance.now() / 1000);
        } else if (visible) {
          setAnim(v, s.anim, dt, s);
          // the Listener's head is always cocked
          if (v.kind === 'listener' && v.model?.head) {
            v.model.head.rotateZ(v.tilt);
            v.model.head.rotateX(-0.15);
          }
        }
        // loops
        const want = visible ? loopFor(v, s) : '';
        if (want !== v.loopKey) {
          v.loop?.stop();
          v.loop = null;
          v.loopKey = want;
          if (want) v.loop = playAt(want, [s.p[0], 1.2, s.p[2]], { volume: want === 'sfx.fluorescent_hum_loop' ? 0.55 : 0.9, radius: want === 'sfx.mannequin_scrape' ? 14 : 9, rate: want === 'sfx.fluorescent_hum_loop' ? 0.79 : 1, ...{ loop: true } } as never);
          if (want && v.loop === null) v.loopKey = '';
        } else if (v.loop?.setPos) v.loop.setPos([s.p[0], 1.2, s.p[2]]);
        v.state = s.state;
      }
      for (const [id, v] of views) if (!seen.has(id)) { dropView(v); views.delete(id); }
      seeStats.reached++;
      snatchFrame(dt);
      warmTick();
      reportSightings(dt);
      if (performance.now() > blinkUntil && overlay.style.opacity !== '0' && overlay.style.opacity !== '') overlay.style.opacity = '0';
      if (grabState.value && myId() === grabState.value.victim) vignette.style.opacity = String(0.75 + 0.25 * Math.sin(performance.now() / 90));
    },
  });

  if (ctx.testMode) {
    (window as unknown as { __monsters?: unknown }).__monsters = {
      views: () => [...views.values()].map((v) => ({ id: v.id, kind: v.kind, model: !!v.model, visible: v.root.visible, anim: v.current, state: v.state, loop: v.loopKey })),
      loaded: () => !!lib,
      layout: () => ctx.world.layout,
      tint: (id: string, hex: number) => { const v = views.get(id); let n = 0; v?.root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && (m.material as THREE.MeshStandardNodeMaterial).color) { (m.material as THREE.MeshStandardNodeMaterial).color.setHex(hex); n++; } }); return n; },
      basic: (id: string) => { const v = views.get(id); let n = 0; v?.root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.material = new THREE.MeshBasicNodeMaterial({ color: 0x000000 }); n++; } }); return n; },
      mat: (id: string, kind: string) => { const v = views.get(id); v?.root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && !(m.material as THREE.Material).name.startsWith('eye')) { const old = m.material as THREE.MeshStandardMaterial; m.material = kind === 'std' ? new THREE.MeshStandardNodeMaterial({ color: 0x000000, roughness: 1, metalness: 0 }) : kind === 'stdmap' ? new THREE.MeshStandardNodeMaterial({ color: 0x050505, roughness: 1, metalness: 0, map: old.map ?? null }) : kind === 'lambert' ? new THREE.MeshLambertNodeMaterial({ color: 0x000000 }) : new THREE.MeshStandardNodeMaterial({ color: 0x000000, roughness: 1, metalness: 0, flatShading: true }); } }); return true; },
      see: () => { try { reportSightings(1); return { ...seeStats, acc: seeAcc }; } catch (e) { return { error: String(e instanceof Error ? e.stack : e) }; } },
      debug: (id: string) => {
        const v = views.get(id);
        const out: unknown[] = [];
        v?.root.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) {
            const mat = m.material as THREE.MeshStandardNodeMaterial;
            out.push({ name: m.name, type: mat.type, hasColorNode: !!mat.colorNode, color: mat.color?.getHexString?.(), map: !!mat.map, visible: m.visible });
          }
        });
        return { model: !!v?.model, placeholder: !!v?.placeholder, meshes: out };
      },
      load: () => { ensureLib(); return loadMonsterLib(() => {}).then((l) => !!l); },
    };
  }
  if (ctx.testMode) (window as unknown as { __monstersLayout?: () => unknown }).__monstersLayout = () => ctx.world.layout;
  ctx.diag.monsters = { installed: true };
}
