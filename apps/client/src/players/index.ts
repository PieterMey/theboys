// Owner: track ⑤ Players (apps/client/src/players/**; v1.2 additions: players-stealth). Client plugin entry; see
// apps/client/src/core/context.ts. Provides services.input + services.players; first-person controller, remote
// avatars, view model, emotes, pings, proximity text, spectator camera, pose source (20 Hz), footstep SFX per floor,
// beforeunload guard. v1.2: stance HUD + one-time stealth hints, the desktop app's Left-Ctrl crouch (input.ts),
// mirror self (setMirrorSelf), the view model on the first-person render layer, ref-counted flashlight disables.
import * as THREE from 'three/webgpu';
import { STANCE } from '@dead-air/shared/state.ts';
import { ANIM } from '@dead-air/shared/anim.ts';
import { PLAYER } from '@dead-air/shared/constants.ts';
import { assetVariants, hasAsset } from '@dead-air/shared/assets.ts';
import type { EmoteKind } from '@dead-air/shared/messages/players.ts';
import type { Profile } from '@dead-air/shared/profile.ts';
import { los } from '@dead-air/shared/nav/index.ts';
import type { ClientContext } from '../core/context.ts';
import { SYS } from '../core/loop.ts';
import { RENDER_LAYERS } from '../render/api.ts';
import { createInput, ctrlCrouchOn, desktopBridge, loadSettings, saveSettings } from './input.ts';
import { applyCamera, createLocal, levelNav, stepLocal } from './local.ts';
import { createAvatars, profileOf } from './avatars.ts';
import type { SelfPose } from './avatars.ts';
import { loadRigLib } from './rig.ts';
import { createViewModel } from './viewmodel.ts';
import { EMOTE_ANIM, WHEEL, createPingMarkers, pushChat, ui, wheelPick } from './social.ts';
import { rayGrid } from './collide.ts';
import { outgoingChat, shownChat } from './chatmask.ts';
import { ChatHud, CrawlHud, CrosshairHud, EmoteWheelHud, PokeBarHud, ScreenHintHud, StaminaHud, StanceHud, StealthHintHud } from './hud.tsx';
import { createCrawl } from './vents.ts';
import { HINT_TEXT, createHintStore, roomLitAt, sameStance, spottedHints, stanceView, stepSfxFor, surfaceAt as floorUnder } from './stealth.ts';
import type { HintId, StanceView } from './stealth.ts';
import type { FlashlightInfo, LevelServiceShape, PlayersService, V3 } from './types.ts';
import { useLoose } from './types.ts';

export type { PlayersService, FlashlightInfo, PlayerSettings } from './types.ts';

declare global {
  interface Window {
    /** test-only (?test=1) players debug hooks */
    __players?: {
      local(): { p: V3; yaw: number; pitch: number; stance: number; anim: number; stamina: number; speed: number; light: boolean; dead: boolean; eye: number };
      avatars(): { id: string; rig: boolean; p: V3; anim: number; light: boolean; plate: number; visible: boolean }[];
      flashlights(): FlashlightInfo[];
      emote(kind: EmoteKind): void;
      ping(): Promise<unknown>;
      chat(text: string): Promise<unknown>;
      chatLines(): string[];
      markers(): number;
      spectate(on: boolean | null): void;
      spectating(): { on: boolean; target: string | null };
      cycle(): void;
      rigReady(): boolean;
      setCamera(pos: V3, look: V3): void;
      freeCam(on: boolean): void;
      /** nearest cell to the player with a solid wall on its +X edge and a free -X edge: walk-into-wall tests */
      findWall(): { cx: number; cz: number; wallX: number } | null;
      inputState(): unknown;
      /** local-only avatar (variants screenshots) */
      dummy(id: string, p: V3, yaw: number, profile: unknown, opts?: { anim?: number; stance?: number; light?: 0 | 1; pitch?: number }): void;
      clearDummies(): void;
      /** test-only point light (adds a light: recompiles; never used in game) */
      testLight(p: V3, intensity: number, color?: string): void;
      /** v1.2: stance HUD state, the crouch latch, the hint on screen, the mirror-self avatar's layers + shadows */
      stealth(): { stance: StanceView; latched: boolean; hint: string | null; lightOff: string[]; ctrlCrouch: boolean; crawling: boolean };
      mirrorSelf(): { on: boolean; layers: number[]; castShadow: boolean; meshes: number; visible: boolean; nameplate: boolean } | null;
      /** show a stealth hint now (screenshots), ignoring the once-only store */
      showHint(id: HintId): void;
      /** services.players itself (setFlashlightEnabled / setMirrorSelf / settings in e2e tests) */
      svc(): PlayersService;
      /** the longest wall- and prop-free run along +X inside one closed space (walk tests): its first cell centre */
      lane(): { x: number; z: number; len: number } | null;
      /** v1.3 dead pokes: poke like the bar's buttons (resolves with the server reply, null when not sent) */
      poke(kind: 'knock' | 'flicker', count?: number): Promise<unknown>;
      /** v1.3 dead pokes: the poke bar's state (ready times as ms from now) */
      pokeUi(): { on: boolean; room: string | null; knockInMs: number; flickerInMs: number; msg: string | null; pending: boolean };
    };
  }
}

/** services.level (env-world, v1.2): the floor under a point; 'water' = wet steps over the space's floor */
interface LevelSurfaceLike { surfaceAt?(x: number, z: number): string }
/** services.interaction (interaction-gear, v1.2): holds(type) once it lands; inventory() meanwhile */
interface InteractionHoldsLike { holds?(type: string): boolean; inventory?(): (string | null)[] }
/** services.render (env-render, v1.2): layers once mirrors / first-person layering exist */
interface RenderLayersLike { layers?: { self?: number; firstPerson?: number } }

export async function install(ctx: ClientContext): Promise<void> {
  const bal = () => (ctx.balance.players ?? {}) as Record<string, number>;
  const settings = loadSettings(bal().mouseSensitivity ?? 0.0022);
  const input = createInput(ctx, settings);
  const me = createLocal();
  let forcedSpectate: boolean | null = null;
  let specTarget: string | null = null;
  let freeCam = false;
  let testCam: { pos: THREE.Vector3; look: THREE.Vector3 } | null = null;
  let lastLayoutHash: string | null = null;
  let rigReady = false;
  /** v1.2: reasons currently holding the flashlight off (setFlashlightEnabled) */
  const lightOff = new Set<string>();
  /** v1.2: mirror self requested by env-render */
  let mirrorSelfOn = false;
  /** v1.2: the view model moved to render's first-person layer */
  let vmLayered = false;
  const log = (m: string) => console.info(`[players] ${m}`);

  // ---------------- services.input ----------------
  ctx.services.provide('input', {
    state: input.state,
    setInput: input.setInput,
    teleport(x, z, yaw) {
      if (!Number.isFinite(x) || !Number.isFinite(z)) { log(`ignored non-finite teleport (${x}, ${z})`); return; }
      me.pos.set(x, 0, z);
      me.vel.set(0, 0, 0);
      if (yaw !== undefined && Number.isFinite(yaw)) me.yaw = yaw;
    },
    look(yaw, pitch) {
      if (Number.isFinite(yaw)) me.yaw = yaw;
      if (Number.isFinite(pitch)) me.pitch = Math.max(-1.48, Math.min(1.48, pitch));
    },
  });

  const three = ctx.services.use('three') ?? (await Promise.race([ctx.services.wait('three'), new Promise<undefined>((r) => setTimeout(() => r(undefined), 5000))]));
  if (!three) {
    ctx.reportError('players: services.three missing; avatars/camera disabled');
    return;
  }
  const { scene, camera } = three;
  const done = ctx.readiness.require('players');
  let readyDone = false;
  const finishReady = () => { if (!readyDone) { readyDone = true; done(); } };
  setTimeout(finishReady, 15000);

  // ---------------- SFX ----------------
  const sfxPlay = (key: string, pos?: V3, volume = 1, rate = 1) => {
    const sfx = ctx.services.use('sfx');
    if (!sfx || !hasAsset(key)) return;
    try { sfx.play(key, pos, rate === 1 ? { volume } : { volume, rate }); } catch { /* tolerate */ }
  };
  /** v1.2: the floor under (x, z): env-world's level.surfaceAt when present, else the layout space's floorSurface */
  const floorAt = (x: number, z: number) => {
    const lvl = useLoose<LevelSurfaceLike>(ctx.services, 'level');
    const fn = typeof lvl?.surfaceAt === 'function' ? (px: number, pz: number) => lvl.surfaceAt!(px, pz) : undefined;
    return floorUnder(fn, ctx.world.layout, x, z);
  };
  const hasFamily = (key: string) => assetVariants(key).length > 0;
  /** footstep sound for a floor (concrete / metal / wood / carpet families, wet steps on water); remote crouch steps
   *  further than remoteCrouchStepMaxM are not played (creeping teammates stay as quiet as they are to monsters) */
  const stepSfx = (pos: V3, kind: string, remote: boolean) => {
    if (remote && kind === 'crouchStep') {
      const d = Math.hypot(pos[0] - camera.position.x, pos[2] - camera.position.z);
      if (d > (bal().remoteCrouchStepMaxM ?? 4)) return;
    }
    const { key: family, rate } = stepSfxFor(floorAt(pos[0], pos[2]).sfx, hasFamily);
    const vars = assetVariants(family);
    const list = vars.length ? vars : assetVariants('sfx.step_concrete');
    if (!list.length) return;
    const key = list[Math.floor(Math.random() * list.length)];
    const vol = (kind === 'crouchStep' ? 0.22 : kind === 'sprintStep' ? 0.85 : 0.5) * (remote ? 0.85 : 0.6);
    sfxPlay(key, pos, vol, rate);
  };

  // ---------------- scene parts ----------------
  const vm = createViewModel(scene);
  if (ctx.params.get('vmprop') !== '0') void vm.loadProp(three.renderer, log);
  const avatars = createAvatars(ctx, scene, { stepSfx });
  const markers = createPingMarkers(scene);

  void loadRigLib(log).then((lib) => {
    avatars.setRig(lib);
    rigReady = !!lib;
    avatars.warm(camera, 24);
    setTimeout(finishReady, 900);
  });

  // ---------------- state helpers ----------------
  const meId = () => ctx.net.me ?? ctx.world.me;
  const joined = () => ctx.net.status === 'joined' || ctx.net.status === 'reconnecting' || (ctx.net.status === 'open' && !!ctx.world.me);
  const inGame = () => joined() && ctx.ui.screen.value.name === 'none';
  const aliveFlag = () => ctx.world.crew?.players.find((p) => p.id === meId())?.alive;
  const isDead = () => forcedSpectate ?? (ctx.world.phase === 'contract' && aliveFlag() === false);
  const livingTeammates = () => (ctx.world.crew?.players ?? []).filter((p) => p.id !== meId() && p.alive && p.connected && avatars.get(p.id)).map((p) => p.id);

  // ---------------- v1.2 crawl vents (stretch, flag crawlVents; server players/vents.ts) ----------------
  const crawl = createCrawl(ctx, scene, {
    meId,
    freeze: (on) => { if (on) me.frozen.add('crawl'); else me.frozen.delete('crawl'); },
    teleport: (x, z, yaw) => {
      if (!Number.isFinite(x) || !Number.isFinite(z)) return;
      me.pos.set(x, 0, z);
      me.vel.set(0, 0, 0);
      if (Number.isFinite(yaw)) me.yaw = yaw;
      me.pitch = 0;
    },
    play: sfxPlay,
  });

  // ---------------- v1.2 one-time stealth hints (localStorage 'deadair.hints.v12'; meta's hints setting) ----------------
  const hints = createHintStore();
  /** hints waiting for their moment (frame() shows each once it is due); a phase change drops them */
  const hintQueue: { id: HintId; at: number }[] = [];
  let hintTimer: ReturnType<typeof setTimeout> | null = null;
  const showHint = (id: HintId) => {
    const ms = bal().hintMs ?? 6500;
    const text = id === 'contract' && ctrlCrouchOn(settings) ? `C / LEFT CTRL: CROUCH · ${HINT_TEXT.contract.split(' · ').slice(1).join(' · ')}` : HINT_TEXT[id];
    ui.hint.value = { id, text, until: performance.now() + ms };
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { if (ui.hint.value?.id === id) ui.hint.value = null; }, ms);
  };
  /** show once ever (per browser), unless meta's hints setting is off */
  const hintOnce = (id: HintId) => {
    if (hints.once(id)) showHint(id);
  };
  /** the same, after `delayMs` and only once the arrival / loading screen is gone (frame() shows it) */
  const queueHint = (id: HintId, delayMs: number) => {
    if (!hints.seen(id) && !hintQueue.some((q) => q.id === id)) hintQueue.push({ id, at: performance.now() + delayMs });
  };

  let synced = false;
  const syncFromServer = (force: boolean, why: string) => {
    const id = meId();
    const hash = ctx.world.layout?.hash ?? null;
    if (!force && hash === lastLayoutHash) return;
    const sameLevel = synced && hash !== null && hash === lastLayoutHash;
    lastLayoutHash = hash;
    const s = id ? ctx.world.players.get(id)?.latest() : null;
    if (s && Number.isFinite(s.p[0]) && Number.isFinite(s.p[2])) {
      const d = Math.hypot(s.p[0] - me.pos.x, s.p[2] - me.pos.z);
      if (sameLevel) {
        // re-welcome on the same level (silent reconnect / resume): never rotate the view; only adopt the server
        // position when it really moved us (the next poses validate server-side, net.correct handles drift)
        if (d > 2) { me.pos.set(s.p[0], 0, s.p[2]); me.vel.set(0, 0, 0); }
        log(`${why}: same level, kept view (server pose ${d.toFixed(2)} m away${d > 2 ? ', position adopted' : ''})`);
        return;
      }
      me.pos.set(s.p[0], 0, s.p[2]);
      if (Number.isFinite(s.yaw)) me.yaw = s.yaw;
      me.pitch = 0;
      me.vel.set(0, 0, 0);
      log(`${why}: pose from server (${s.p[0].toFixed(1)}, ${s.p[2].toFixed(1)}) yaw ${s.yaw.toFixed(2)}`);
    }
    synced = true;
    me.stamina = 1;
  };
  ctx.bus.on('net:welcome', () => syncFromServer(true, 'welcome'));
  ctx.bus.on('world:phase', ({ to }) => {
    syncFromServer(false, 'phase');
    input.resetCrouch(); // v1.2: a toggled crouch never carries into the next phase
    hintQueue.length = 0; // a hint queued for one phase never shows in the next
    if (to === 'contract') queueHint('contract', 3500);
  });

  // ---------------- flashlight ----------------
  const setLight = (on: boolean) => {
    const next = on && me.lightEnabled && !me.dead;
    if (next === me.light) return;
    me.light = next;
    sfxPlay('sfx.flashlight_click', [me.cam.x, me.cam.y, me.cam.z], 0.6);
    ctx.bus.emit('action:flashlight', { down: true, on: me.light });
  };
  input.onFlashlight = () => {
    if (!inGame() || me.dead) return;
    setLight(!me.light);
  };

  // ---------------- emotes ----------------
  const emote = (kind: EmoteKind) => {
    if (ctx.flags.emotes === false || me.dead || me.hidden) return;
    const anim = EMOTE_ANIM[kind];
    me.animOverride = { anim, until: performance.now() + (bal().emoteMs ?? 2600) };
    ctx.net.req('players.emote', { kind }).catch(() => { /* offline */ });
  };
  let wheelVec = { x: 0, y: 0 };
  ctx.bus.on('action:emote', ({ down }) => {
    if (ctx.flags.emotes === false) return;
    if (down) {
      if (!inGame() || me.dead) return;
      ui.wheelOpen.value = true;
      ui.wheelSel.value = null;
      wheelVec = { x: 0, y: 0 };
      input.takeMouse();
    } else if (ui.wheelOpen.value) {
      ui.wheelOpen.value = false;
      const k = ui.wheelSel.value;
      ui.wheelSel.value = null;
      if (k) emote(k);
    }
  });
  // 1-4 while the wheel is open pick an emote (input.ts sends 'action:wheelKey' then, never 'action:slot')
  ctx.bus.on('action:wheelKey', ({ slot }) => {
    if (!ui.wheelOpen.value) return;
    const k = WHEEL[slot];
    if (k) { ui.wheelSel.value = k; }
  });
  ctx.net.on('players.emote', (d) => {
    if (d.id === meId()) return;
    avatars.playEmote(d.id, d.anim, bal().emoteMs ?? 2600);
  });

  // ---------------- ping ----------------
  const ping = async () => {
    if (!inGame() || me.dead) return null;
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(me.camQuat);
    const o: V3 = [me.cam.x, me.cam.y, me.cam.z];
    const d: V3 = [dir.x, dir.y, dir.z];
    const lvl = useLoose<LevelServiceShape>(ctx.services, 'level');
    let p: V3 | null = null;
    if (lvl?.raycast) {
      try { p = lvl.raycast(o, d, 40)?.p ?? null; } catch { p = null; }
    }
    if (!p) {
      const nav = levelNav(ctx);
      p = rayGrid(nav?.grid ?? null, o, d, 40, nav?.wallH ?? 3, nav?.doorOpen ?? (() => true)).p;
    }
    return ctx.net.req('players.ping', { p }).catch(() => null);
  };
  ctx.bus.on('action:ping', ({ down }) => { if (down) void ping(); });
  ctx.net.on('players.ping', (d) => {
    const prof = profileOf(ctx, d.id);
    markers.spawn(d.p, prof.visor.color || '#7dfcff', bal().pingMs ?? 3000);
    ctx.bus.emit('players:ping', { id: d.id, p: d.p });
  });

  // ---------------- proximity text ----------------
  ctx.bus.on('action:chat', ({ open }) => {
    if (ctx.flags.proxText === false) return;
    if (open && !inGame()) return;
    ui.chatOpen.value = open;
    input.setChatOpen(open);
  });
  // v1.3 P1d (chatmask.ts): names.ts masks blocked words on the way out and again on display
  const chat = (text: string) => ctx.net.req('players.chat', { text: outgoingChat(text) }).catch(() => null);
  ctx.bus.on('players:chatSend', ({ text }) => { void chat(text); });
  ctx.net.on('players.chat', (d) => {
    const line = shownChat(d);
    pushChat(ctx, line.name, line.text, d.id === meId());
  });

  // ---------------- spectating ----------------
  const cycleTarget = () => {
    const list = livingTeammates();
    if (!list.length) { specTarget = null; return; }
    const i = specTarget ? list.indexOf(specTarget) : -1;
    specTarget = list[(i + 1) % list.length];
  };
  ctx.bus.on('action:use', ({ down }) => {
    if (down && me.dead) cycleTarget();
  });
  const specCam = new THREE.Vector3();
  const specLook = new THREE.Vector3();
  let specInit = false;

  // ---------------- v1.3 dead pokes (flag deadPokes): the spectator's poke bar ----------------
  // keys 1-3 knock that many times, 4 flickers the watched room (input.ts routes the digits while the bar is up); the
  // server (paranormal.poke) decides where and whether, and owns the cooldowns: the bar only mirrors them
  const pokesFlag = () => ctx.flags.deadPokes === true && ctx.flags.paranormal !== false;
  const pokeBal = (k: string, d: number): number => {
    const v = ((ctx.balance.paranormal as { poke?: Record<string, unknown> } | undefined)?.poke ?? {})[k];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d;
  };
  const POKE_REFUSED: Record<string, string> = {
    off: 'THE LINE IS DEAD', alive: 'ONLY THE DEAD CAN DO THAT', phase: 'NOTHING TO HAUNT HERE', cooldown: 'NOT YET', budget: 'YOU ARE SPENT FOR THIS CONTRACT',
    busy: 'SOMEONE ELSE IS KNOCKING', far: 'TOO FAR FROM THE LIVING', nothing: 'NOTHING TO KNOCK ON HERE', dark: 'NO LIGHT TO FLICKER HERE',
  };
  const KNOCKED = ['', 'KNOCKED ONCE', 'KNOCKED TWICE', 'KNOCKED THREE TIMES'];
  const pokeRoomAt = (x: number, z: number): string | null => {
    const L = ctx.world.layout;
    if (!L) return null;
    const cx = Math.floor(x), cz = Math.floor(z);
    if (cx < 0 || cz < 0 || cx >= L.W || cz >= L.H) return null;
    return L.spaces[L.owner[cz * L.W + cx]]?.callsign ?? null;
  };
  const poke = async (kind: 'knock' | 'flicker', count = 1): Promise<unknown> => {
    const st = ui.poke.value;
    if (!st.on || st.pending) return null;
    const n = Math.max(1, Math.min(3, Math.round(count) || 1));
    const t0 = performance.now();
    const readyAt = kind === 'knock' ? st.knockReadyAt : st.flickerReadyAt;
    if (t0 < readyAt) {
      ui.poke.value = { ...st, msg: `NOT YET · ${Math.ceil((readyAt - t0) / 1000)} s`, msgUntil: t0 + 1600 };
      return null;
    }
    ui.poke.value = { ...st, pending: true };
    const r = await ctx.net.req('paranormal.poke', kind === 'knock' ? { kind, count: n } : { kind }, 4000).catch(() => null);
    const t = performance.now();
    const next = { ...ui.poke.value, pending: false, msgUntil: t + 2600 };
    if (!r) next.msg = 'NO SIGNAL';
    else {
      if (typeof r.knockMs === 'number') next.knockReadyAt = t + r.knockMs;
      if (typeof r.flickerMs === 'number') next.flickerReadyAt = t + r.flickerMs;
      const wait = (r.reason === 'cooldown' || r.reason === 'busy') && r.cooldownMs ? ` · ${Math.ceil(r.cooldownMs / 1000)} s` : '';
      next.msg = r.ok ? (kind === 'knock' ? KNOCKED[n] : `FLICKERED ${next.room ?? 'THE LIGHTS'}`) : `${POKE_REFUSED[r.reason ?? 'off'] ?? 'THE LINE IS DEAD'}${wait}`;
    }
    ui.poke.value = next;
    return r;
  };
  ctx.bus.on('players:poke', ({ kind, count }) => { void poke(kind === 'flicker' ? 'flicker' : 'knock', count ?? 1); });
  /** keep the bar's visibility + watched room in step with the camera (signal writes only on change) */
  const updatePokeBar = () => {
    const on = me.dead && pokesFlag() && ctx.world.phase === 'contract';
    const room = on ? pokeRoomAt(me.cam.x, me.cam.z) : null;
    const pv = ui.poke.value;
    if (pv.on === on && pv.room === room) return;
    ui.poke.value = on && !pv.on
      ? { ...pv, on, room, knockMs: pokeBal('knockCooldownSec', 8) * 1000, flickerMs: pokeBal('flickerCooldownSec', 20) * 1000, msg: null, msgUntil: 0 }
      : { ...pv, on, room };
  };

  // ---------------- pose source (20 Hz) ----------------
  ctx.net.setPoseSource(() => {
    if (!meId()) return null;
    if (me.dead) {
      return { p: [me.cam.x, me.cam.y, me.cam.z], yaw: me.yaw, pitch: me.pitch, stance: STANCE.dead, anim: ANIM.death, light: 0 };
    }
    return {
      p: [me.pos.x, me.pos.y, me.pos.z], yaw: me.yaw, pitch: me.pitch, stance: me.stance, anim: me.anim,
      light: me.light && me.lightEnabled ? 1 : 0,
    };
  });

  // ---------------- beforeunload guard ----------------
  addEventListener('beforeunload', (e) => {
    const guard = joined() && (ctx.world.phase === 'contract' || ctx.world.phase === 'drive') && (!ctx.testMode || ctx.params.get('guard') === '1');
    if (!guard) return;
    e.preventDefault();
    e.returnValue = 'Leave the shift?';
  });

  // ---------------- services.players ----------------
  /** (b) interaction: tier 2 = the player carries the Pro Flashlight */
  const ixTier = (id: string): 1 | 2 => (ctx.services.use('interaction')?.flashlightTier?.(id) === 2 ? 2 : 1);
  const flashlights = (): FlashlightInfo[] => {
    const out: FlashlightInfo[] = [];
    const id = meId();
    if (id && joined()) {
      out.push({
        id, pos: [vm.lensPos.x, vm.lensPos.y, vm.lensPos.z], dir: [vm.beamDir.x, vm.beamDir.y, vm.beamDir.z],
        on: me.light && me.lightEnabled && !me.dead && !me.hidden && !crawl.active(), local: true, tier: ixTier(id), battery: ctx.services.use('interaction')?.battery?.() ?? 1,
      });
    }
    for (const a of avatars.avatars.values()) {
      const cp = Math.cos(a.pitch);
      out.push({
        id: a.id, pos: [a.lampWorld.x, a.lampWorld.y, a.lampWorld.z],
        dir: [Math.sin(a.yaw) * cp, Math.sin(a.pitch), Math.cos(a.yaw) * cp], on: a.light && a.root.visible, local: false, tier: ixTier(a.id),
      });
    }
    return out;
  };
  const playersService: PlayersService = {
    localId: meId,
    flashlights,
    headPos(id) {
      if (id === meId()) return [me.cam.x, me.cam.y, me.cam.z];
      const a = avatars.get(id);
      return a ? [a.headWorld.x, a.headWorld.y, a.headWorld.z] : null;
    },
    cameraPos: () => [camera.position.x, camera.position.y, camera.position.z],
    spectating: () => me.dead,
    setSpectate(on) { forcedSpectate = on; },
    setFlashlightEnabled(enabled, reason = 'battery') {
      // v1.2 (plan check #13): ref-counted per reason like freeze(): usable only while no reason holds it off
      // (battery, night vision, a knockdown ...), so the end of a knockdown never relights a dead battery
      const why = typeof reason === 'string' && reason ? reason : 'battery';
      if (enabled) lightOff.delete(why);
      else lightOff.add(why);
      me.lightEnabled = lightOff.size === 0;
      if (!me.lightEnabled && me.light) { me.light = false; ctx.bus.emit('action:flashlight', { down: true, on: false }); }
    },
    flashlightOn: () => me.light && me.lightEnabled && !me.dead,
    setFlashlight: (on) => setLight(on),
    setSpeedMult(mult) { me.speedMult = Number.isFinite(mult) ? Math.max(0, Math.min(2, mult)) : 1; },
    setCarry(id) { me.carry = id; },
    setHidden(hidden, at, yaw) {
      me.hidden = hidden;
      me.hiddenAt = hidden && at ? at : null;
      if (hidden && yaw !== undefined && Number.isFinite(yaw)) me.yaw = yaw;
    },
    playAnim(anim, ms) { me.animOverride = { anim, until: performance.now() + ms }; },
    freeze(reason, on) { if (on) me.frozen.add(reason); else me.frozen.delete(reason); },
    localPose: () => (meId() ? { p: [me.pos.x, me.pos.y, me.pos.z], yaw: me.yaw, pitch: me.pitch, stance: me.stance, anim: me.anim } : null),
    avatarObject: (id) => avatars.get(id)?.root,
    emote,
    // v1.2: ctrlCrouch reads true by default in the desktop app (its shell sends Left Ctrl as a crouch hotkey)
    settings: () => ({ ...settings, ...(desktopBridge()?.onHotkey ? { ctrlCrouch: ctrlCrouchOn(settings) } : {}) }),
    setSettings(p) {
      Object.assign(settings, p);
      saveSettings(settings);
    },
    stamina: () => me.stamina,
    setStaminaFree(ms) {
      me.staminaFreeUntil = performance.now() + Math.max(0, Number(ms) || 0);
      me.stamina = 1;
      me.sprintLock = false;
    },
    setPreviewAvatar(id, pose, profile) {
      if (!pose || !profile) { avatars.removeDummy(id); return; }
      avatars.setDummy(id, { p: pose.p, yaw: pose.yaw, pitch: 0, stance: pose.stance ?? STANCE.stand, anim: pose.anim ?? ANIM.idle, light: pose.light ?? 0 }, profile);
    },
    locked: () => input.locked(),
    /**
     * v1.2 (env-render's live mirrors): the local player's own full-body avatar at the local pose, only on
     * RENDER_LAYERS.self (mirror cameras draw it, the main camera never does), castShadow false, no nameplate, no
     * step sfx. Returns its stable root; false removes it.
     */
    setMirrorSelf(on) {
      mirrorSelfOn = !!on;
      if (!on) return avatars.setSelf(null, 0);
      const id = meId();
      const layer = useLoose<RenderLayersLike>(ctx.services, 'render')?.layers?.self ?? RENDER_LAYERS.self;
      return avatars.setSelf(id ? profileOf(ctx, id) : ctx.net.identity().profile, layer);
    },
  };
  ctx.services.provide('players', playersService);

  // ---------------- HUD ----------------
  ctx.ui.registerHud('bottom', StaminaHud, { id: 'players-stamina', order: 30 });
  ctx.ui.registerHud('center', CrosshairHud, { id: 'players-crosshair', order: 10 });
  // untransformed slot: its position:fixed lines resolve against the viewport (spectator banner, click-to-look)
  ctx.ui.registerHud('top-left', ScreenHintHud, { id: 'players-screen-hints', order: 80 });
  ctx.ui.registerHud('top-left', StealthHintHud, { id: 'players-stealth-hint', order: 81 });
  // v1.3 dead pokes: the spectator's poke bar (screen-anchored like the spectator banner)
  ctx.ui.registerHud('top-left', PokeBarHud, { id: 'players-poke-bar', order: 82 });
  ctx.ui.registerHud('top-left', CrawlHud, { id: 'players-crawl', order: 5 });
  ctx.ui.registerHud('center', EmoteWheelHud, { id: 'players-emotes', order: 20 });
  // v1.2: next to voice's band meter (order 10): your voice, then your feet
  ctx.ui.registerHud('bottom-left', StanceHud, { id: 'players-stance', order: 11 });
  ctx.ui.registerHud('bottom-left', ChatHud, { id: 'players-chat', order: 40 });
  ctx.bus.on('input:pointerlock', ({ locked }) => { ui.locked.value = locked; });

  // ---------------- v1.2 stance HUD + hint triggers ----------------
  const HIDDEN_STANCE: StanceView = { mode: null, radiusM: 0, tag: null, soles: false };
  let stanceAt = 0;
  let kennelOf: { hash: string; p: [number, number] | null } | null = null;
  const kennelPos = (): [number, number] | null => {
    const L = ctx.world.layout;
    if (!L) return null;
    if (kennelOf?.hash !== L.hash) {
      const k = L.items.find((i) => i.kind === 'kennel');
      kennelOf = { hash: L.hash, p: k ? [k.x, k.z] : null };
    }
    return kennelOf.p;
  };
  const holdsSoles = (): boolean => {
    const ix = useLoose<InteractionHoldsLike>(ctx.services, 'interaction');
    try {
      if (typeof ix?.holds === 'function') return !!ix.holds('soles');
      return !!ix?.inventory?.().includes('soles');
    } catch {
      return false;
    }
  };
  /** the stance HUD reading (only while it can matter: contracts, and the hub's training kennel) */
  const updateStance = (now: number) => {
    if (now - stanceAt < 66) return;
    stanceAt = now;
    let v = HIDDEN_STANCE;
    const phase = ctx.world.phase;
    const kp = phase === 'hub' ? kennelPos() : null;
    const where = phase === 'contract' || (!!kp && Math.hypot(me.pos.x - kp[0], me.pos.z - kp[1]) <= (bal().stanceHudKennelM ?? 8));
    if (where && !me.dead && !me.hidden && !crawl.active() && inGame()) {
      v = stanceView({
        stance: me.stance, speed: me.speed, surface: floorAt(me.pos.x, me.pos.z).noise, soles: holdsSoles(),
        v12: ctx.flags.stealthV12 !== false, bal: bal(),
      });
    }
    if (!sameStance(v, ui.stance.value)) ui.stance.value = v;
  };
  /** last local footstep that was not a creep (the kennel hint needs your steps to be what it heard) */
  let loudStep: { at: number; radiusM: number } | null = null;
  ctx.bus.on('players:step', ({ kind }) => {
    ui.stepPulse.value++;
    if (kind !== 'crouchStep') loudStep = { at: performance.now(), radiusM: ui.stance.value.radiusM || 5 };
  });
  ctx.net.on('monsters.cue', (d) => {
    if (d.cue !== 'growl' || me.dead || !inGame()) return;
    const dist = Math.hypot(me.pos.x - d.p[0], me.pos.z - d.p[2]);
    if (ctx.world.phase === 'hub' && d.id === 'kennel') {
      // the training kennel growled at your footsteps (your last loud step just now, within its reach)
      if (loudStep && performance.now() - loudStep.at < 1600 && dist <= loudStep.radiusM + 3) hintOnce('kennel');
    } else if (ctx.world.phase === 'contract' && dist <= d.radius) hintOnce('growl');
  });
  // the victim-only 'spotted' event (monsters-fair, plan check #24c), never the crew-wide notice cue. The first one shows
  // 'spotted'; the first one that finds your own flashlight on in an unlit room (the room-light state interaction
  // mirrors from the server: the Listener's sight reads it) shows 'flashlight', after 'spotted' has had its time
  (ctx.net.on as unknown as (e: string, fn: (d: unknown) => void) => () => void)('monsters.spotted', (d) => {
    const victim = (d as { victim?: unknown; pid?: unknown } | null)?.victim ?? (d as { pid?: unknown } | null)?.pid;
    if (typeof victim === 'string' && victim !== meId()) return;
    if (me.dead || ctx.world.phase !== 'contract') return;
    const ix = ctx.services.use('interaction');
    const lit = roomLitAt(ctx.world.layout, typeof ix?.lightOn === 'function' ? (space) => ix.lightOn(space) : undefined, me.pos.x, me.pos.z);
    const plan = spottedHints((id) => hints.seen(id) || hintQueue.some((q) => q.id === id), me.light && me.lightEnabled, lit);
    if (plan.now) hintOnce(plan.now);
    if (plan.later) queueHint(plan.later, (bal().hintMs ?? 6500) + 400);
  });

  // ---------------- per-frame ----------------
  const tmpLook = new THREE.Vector3();
  const tmpM = new THREE.Matrix4();
  const testScene = ctx.params.get('scene') === 'test';
  let sysMs = 0;
  ctx.registerSystem({
    name: 'players',
    order: SYS.players,
    update(dt) {
      const t0 = performance.now();
      try { frame(dt); } finally {
        sysMs = sysMs * 0.9 + (performance.now() - t0) * 0.1;
        if (ctx.testMode) ctx.diag.playersMs = Math.round(sysMs * 100) / 100;
      }
    },
  });
  function frame(dt: number) {
      const game = inGame();
      input.setActive(game);
      if (!game && input.locked() && ctx.ui.screen.value.name !== 'none') input.releaseLock();
      ui.inGame.value = joined() && !testScene;
      if (!joined() || testScene) {
        avatars.update(dt, camera.position, null);
        markers.update();
        return;
      }
      // death / spectate transitions
      const deadNow = !!isDead();
      if (deadNow !== me.dead) {
        me.dead = deadNow;
        if (deadNow) { me.light = false; specInit = false; cycleTarget(); }
        else { specTarget = null; me.pitch = 0; }
        input.resetCrouch(); // v1.2: neither the dead nor the revived keep a toggled crouch
        ctx.bus.emit('players:spectate', { on: deadNow });
      }
      // emote wheel selection by mouse
      if (ui.wheelOpen.value) {
        const m = input.takeMouse();
        wheelVec.x = Math.max(-120, Math.min(120, wheelVec.x + m.dx));
        wheelVec.y = Math.max(-120, Math.min(120, wheelVec.y + m.dy));
        const pick = wheelPick(wheelVec.x, wheelVec.y);
        if (pick) ui.wheelSel.value = pick;
        input.takeLook(); // no camera turn while choosing
      } else input.takeMouse();

      if (me.dead) {
        // spectator camera: follow a living teammate (click cycles), else free look at the death spot
        const look = input.takeLook();
        me.yaw += look.dYaw;
        me.pitch = Math.max(-1.3, Math.min(1.3, me.pitch + look.dPitch));
        if (specTarget && !livingTeammates().includes(specTarget)) cycleTarget();
        if (!specTarget) cycleTarget();
        const a = specTarget && !freeCam ? avatars.get(specTarget) : undefined;
        if (a) {
          const fwd = tmpLook.set(Math.sin(a.yaw), 0, Math.cos(a.yaw));
          const head = a.headWorld;
          // farthest boom length with line of sight (walls/van behind the target pull the camera in)
          const nav = levelNav(ctx);
          const want = new THREE.Vector3();
          for (const dist of [2.2, 1.7, 1.25, 0.9, 0.6]) {
            want.set(head.x - fwd.x * dist, head.y + 0.2 + dist * 0.15, head.z - fwd.z * dist);
            if (!nav || los(nav.grid, head.x, head.z, want.x, want.z, nav.doorOpen)) break;
          }
          if (!specInit) { specCam.copy(want); specLook.copy(head); specInit = true; }
          specCam.lerp(want, 1 - Math.exp(-dt * 6));
          specLook.lerp(new THREE.Vector3(head.x + fwd.x * 2, head.y - 0.1, head.z + fwd.z * 2), 1 - Math.exp(-dt * 8));
          me.cam.copy(specCam);
          tmpM.lookAt(specCam, specLook, camera.up);
          me.camQuat.setFromRotationMatrix(tmpM);
        } else {
          // free cam (noclip, slow) around the death spot
          const st = input.typing() ? { forward: 0, right: 0 } : input.state();
          const fx = Math.sin(me.yaw), fz = Math.cos(me.yaw);
          me.cam.x += (fx * st.forward - Math.cos(me.yaw) * st.right) * dt * 3;
          me.cam.z += (fz * st.forward + Math.sin(me.yaw) * st.right) * dt * 3;
          if (me.cam.y < 0.5) me.cam.y = PLAYER.eye;
          me.camQuat.setFromEuler(new THREE.Euler(me.pitch, me.yaw + Math.PI, 0, 'YXZ'));
        }
        avatars.hideNameplate(a ? specTarget : null);
        const specName = a ? (ctx.world.crew?.players.find((p) => p.id === specTarget)?.name ?? null) : null;
        if (!ui.spectating.value.on || ui.spectating.value.target !== specName) ui.spectating.value = { on: true, target: specName };
        updatePokeBar();
      } else {
        if (ui.spectating.value.on) { ui.spectating.value = { on: false, target: null }; avatars.hideNameplate(null); }
        if (ui.poke.value.on) updatePokeBar();
        const step = stepLocal(ctx, me, input, dt);
        if (ctx.testMode) ctx.diag.players = { st: input.state(), typing: input.typing(), vel: [me.vel.x, me.vel.z], frozen: [...me.frozen], dt };
        if (step) {
          stepSfx(step.pos, step.kind, false);
          ctx.bus.emit('players:step', step);
        }
      }
      ui.stamina.value = Math.round(me.stamina * 100) / 100;
      if (testCam) {
        camera.position.copy(testCam.pos);
        camera.lookAt(testCam.look);
        camera.updateMatrixWorld();
      } else applyCamera(camera, me);
      const now = performance.now();
      // v1.2 crawl vents: the camera creeps down the duct (local only) until the server's exit teleport
      const crawling = !testCam && crawl.update(now, camera.position, camera.quaternion);
      if (crawling) camera.updateMatrixWorld();
      // v1.2: the view model draws on the first-person layer once render has layers (mirrors never show it); until then
      // it stays on layer 0 so it can never vanish
      if (!vmLayered) {
        const fp = useLoose<RenderLayersLike>(ctx.services, 'render')?.layers?.firstPerson;
        if (typeof fp === 'number') { vm.setLayer(fp); vmLayered = true; log(`view model on render layer ${fp}`); }
      }
      vm.update(dt, me, !me.dead && !me.hidden && !testCam && !crawling, me.light && me.lightEnabled && !crawling, bal().flashlightLag ?? 16);
      const selfPose: SelfPose = mirrorSelfOn && !me.dead && !me.hidden && !crawling
        ? { p: [me.pos.x, me.pos.y, me.pos.z], yaw: me.yaw, pitch: me.pitch, stance: me.stance, anim: me.anim, light: 0 }
        : null;
      avatars.update(dt, camera.position, { on: me.light && me.lightEnabled && !me.dead, pos: vm.lensPos, dir: vm.beamDir }, selfPose);
      markers.update();
      updateStance(now);
      const due = hintQueue.length ? hintQueue.findIndex((q) => now >= q.at) : -1;
      if (due >= 0 && inGame() && !me.dead && !document.querySelector('[data-loading-active]')) {
        const [{ id }] = hintQueue.splice(due, 1);
        if (ctx.world.phase === 'contract') hintOnce(id);
      }
  }

  // ---------------- test hooks ----------------
  const dummyIds = new Set<string>();
  if (ctx.testMode) {
    window.__players = {
      local: () => ({
        p: [me.pos.x, me.pos.y, me.pos.z], yaw: me.yaw, pitch: me.pitch, stance: me.stance, anim: me.anim, stamina: me.stamina,
        speed: me.speed, light: me.light, dead: me.dead, eye: me.eye,
      }),
      avatars: () => [...avatars.avatars.values()].map((a) => ({
        id: a.id, rig: a.rig, p: [a.root.position.x, a.root.position.y, a.root.position.z] as V3, anim: a.curAnim, light: a.light,
        plate: (a.nameplate.material as THREE.SpriteNodeMaterial).opacity, visible: a.root.visible,
      })),
      flashlights,
      emote,
      ping,
      chat,
      chatLines: () => ui.chatLines.value.map((l) => `${l.name}: ${l.text}`),
      markers: () => markers.count(),
      spectate: (on) => { forcedSpectate = on; },
      spectating: () => ({ on: me.dead, target: specTarget }),
      cycle: cycleTarget,
      rigReady: () => rigReady,
      setCamera: (pos, look) => { testCam = { pos: new THREE.Vector3(...pos), look: new THREE.Vector3(...look) }; },
      freeCam: (on) => { freeCam = on; if (!on) testCam = null; },
      dummy: (id, p, yaw, profile, o = {}) => {
        dummyIds.add(id);
        avatars.setDummy(id, { p, yaw, pitch: o.pitch ?? 0, stance: o.stance ?? 0, anim: o.anim ?? ANIM.idle, light: o.light ?? 0 }, profile as Profile);
      },
      clearDummies: () => { for (const id of dummyIds) avatars.removeDummy(id); dummyIds.clear(); },
      testLight: (p, intensity, color = '#ffe2b8') => {
        const l = new THREE.PointLight(color, intensity, 12, 2);
        l.position.set(p[0], p[1], p[2]);
        scene.add(l);
      },
      inputState: () => ({ ...input.state(), svcSame: ctx.services.use('input')?.setInput === input.setInput }),
      stealth: () => ({
        stance: ui.stance.value, latched: input.crouchLatched(), hint: ui.hint.value?.id ?? null, lightOff: [...lightOff],
        ctrlCrouch: ctrlCrouchOn(settings), crawling: crawl.active(),
      }),
      mirrorSelf: () => {
        const a = avatars.self();
        if (!a) return null;
        const layers = new Set<number>();
        let castShadow = false;
        let meshes = 0;
        let holder: THREE.Object3D = a.root;
        while (holder.parent && holder.parent !== scene) holder = holder.parent;
        holder.traverse((o) => {
          for (let l = 0; l < 32; l++) if (o.layers.isEnabled(l)) layers.add(l);
          const m = o as THREE.Mesh;
          if (m.isMesh) { meshes++; if (m.castShadow) castShadow = true; }
        });
        return { on: mirrorSelfOn, layers: [...layers].sort((x, y) => x - y), castShadow, meshes, visible: holder.visible, nameplate: a.nameplate.visible };
      },
      showHint: (id) => showHint(id),
      svc: () => playersService,
      poke: (kind, count) => poke(kind, count ?? 1),
      pokeUi: () => {
        const p = ui.poke.value;
        const t = performance.now();
        return {
          on: p.on, room: p.room, knockInMs: Math.max(0, Math.round(p.knockReadyAt - t)), flickerInMs: Math.max(0, Math.round(p.flickerReadyAt - t)),
          msg: p.msg && t < p.msgUntil ? p.msg : null, pending: p.pending,
        };
      },
      lane: () => {
        const nav = levelNav(ctx);
        if (!nav) return null;
        const g = nav.grid;
        const free = (cx: number, cz: number) => {
          const own = g.owner[cz * g.W + cx];
          if (own < 0 || g.spaces[own]?.open) return false;
          return g.solidStart[cz * g.W + cx + 1] === g.solidStart[cz * g.W + cx];
        };
        let best: { x: number; z: number; len: number } | null = null;
        for (let cz = 1; cz < g.H - 1; cz++) {
          let run = 0;
          for (let cx = 1; cx < g.W - 1; cx++) {
            const here = free(cx, cz) && free(cx, cz - 1) && free(cx, cz + 1);
            // a run continues only through an open vertical edge (no wall / door between the two cells)
            run = here ? (run > 0 && g.v[cz * (g.W + 1) + cx] !== 0 ? 1 : run + 1) : 0;
            if (run > (best?.len ?? 0)) best = { x: cx - run + 1 + 0.5, z: cz + 0.5, len: run };
          }
        }
        return best;
      },
      findWall: () => {
        const nav = levelNav(ctx);
        if (!nav) return null;
        const g = nav.grid;
        let best: { cx: number; cz: number; wallX: number } | null = null;
        let bestD = Infinity;
        for (let cz = 1; cz < g.H - 1; cz++) {
          for (let cx = 1; cx < g.W - 1; cx++) {
            const own = g.owner[cz * g.W + cx];
            if (own < 0 || g.owner[cz * g.W + cx - 1] !== own) continue;
            if (g.spaces[own]?.open) continue;
            const iR = cz * (g.W + 1) + cx + 1, iL = cz * (g.W + 1) + cx;
            if (g.v[iR] !== 1 || g.v[iL] !== 0) continue;
            // no solids in the cell
            let solid = false;
            for (let k = g.solidStart[cz * g.W + cx]; k < g.solidStart[cz * g.W + cx + 1]; k++) solid = true;
            if (solid) continue;
            const d = Math.hypot(cx + 0.5 - me.pos.x, cz + 0.5 - me.pos.z);
            if (d < bestD) { bestD = d; best = { cx, cz, wallX: cx + 1 }; }
          }
        }
        return best;
      },
    };
  }
}
