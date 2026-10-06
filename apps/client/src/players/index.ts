// Owner: track ⑤ Players (apps/client/src/players/**). Client plugin entry; see apps/client/src/core/context.ts.
// Provides services.input + services.players; first-person controller, remote avatars, view model, emotes,
// pings, proximity text, spectator camera, pose source (20 Hz), footstep SFX, beforeunload guard.
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
import { createInput, loadSettings, saveSettings } from './input.ts';
import { applyCamera, createLocal, levelNav, stepLocal } from './local.ts';
import { createAvatars, profileOf } from './avatars.ts';
import { loadRigLib } from './rig.ts';
import { createViewModel } from './viewmodel.ts';
import { EMOTE_ANIM, WHEEL, createPingMarkers, pushChat, ui, wheelPick } from './social.ts';
import { rayGrid } from './collide.ts';
import { ChatHud, CrosshairHud, EmoteWheelHud, StaminaHud } from './hud.tsx';
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
    };
  }
}

const STEP_SURFACE: Record<string, string> = {
  office: 'sfx.step_carpet', archive: 'sfx.step_carpet', boiler: 'sfx.step_metal', storage: 'sfx.step_concrete',
  lab: 'sfx.step_concrete', cold: 'sfx.step_metal', van: 'sfx.step_metal',
};

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
  const log = (m: string) => console.info(`[players] ${m}`);

  // ---------------- services.input ----------------
  ctx.services.provide('input', {
    state: input.state,
    setInput: input.setInput,
    teleport(x, z, yaw) {
      me.pos.set(x, 0, z);
      me.vel.set(0, 0, 0);
      if (yaw !== undefined) me.yaw = yaw;
    },
    look(yaw, pitch) {
      me.yaw = yaw;
      me.pitch = Math.max(-1.48, Math.min(1.48, pitch));
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
  const sfxPlay = (key: string, pos?: V3, volume = 1) => {
    const sfx = ctx.services.use('sfx');
    if (!sfx || !hasAsset(key)) return;
    try { sfx.play(key, pos, { volume }); } catch { /* tolerate */ }
  };
  const surfaceAt = (x: number, z: number): string => {
    const L = ctx.world.layout;
    if (!L) return 'sfx.step_concrete';
    const cx = Math.floor(x), cz = Math.floor(z);
    const sp = cx >= 0 && cz >= 0 && cx < L.W && cz < L.H ? L.owner[cz * L.W + cx] : -1;
    const s = sp >= 0 ? L.spaces[sp] : undefined;
    return (s && STEP_SURFACE[s.type]) || 'sfx.step_concrete';
  };
  const stepSfx = (pos: V3, kind: string, remote: boolean) => {
    const vars = assetVariants(surfaceAt(pos[0], pos[2]));
    const list = vars.length ? vars : assetVariants('sfx.step_concrete');
    if (!list.length) return;
    const key = list[Math.floor(Math.random() * list.length)];
    const vol = (kind === 'crouchStep' ? 0.22 : kind === 'sprintStep' ? 0.85 : 0.5) * (remote ? 0.85 : 0.6);
    sfxPlay(key, pos, vol);
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

  const syncFromServer = (force: boolean) => {
    const id = meId();
    const hash = ctx.world.layout?.hash ?? null;
    if (!force && hash === lastLayoutHash) return;
    lastLayoutHash = hash;
    const s = id ? ctx.world.players.get(id)?.latest() : null;
    if (s) {
      me.pos.set(s.p[0], 0, s.p[2]);
      me.yaw = s.yaw;
      me.pitch = 0;
      me.vel.set(0, 0, 0);
    }
    me.stamina = 1;
  };
  ctx.bus.on('net:welcome', () => syncFromServer(true));
  ctx.bus.on('world:phase', () => syncFromServer(false));

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
  ctx.bus.on('action:slot', ({ slot }) => {
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
  const chat = (text: string) => ctx.net.req('players.chat', { text }).catch(() => null);
  ctx.bus.on('players:chatSend', ({ text }) => { void chat(text); });
  ctx.net.on('players.chat', (d) => pushChat(ctx, d.name, d.text, d.id === meId()));

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
  const flashlights = (): FlashlightInfo[] => {
    const out: FlashlightInfo[] = [];
    const id = meId();
    if (id && joined()) {
      out.push({
        id, pos: [vm.lensPos.x, vm.lensPos.y, vm.lensPos.z], dir: [vm.beamDir.x, vm.beamDir.y, vm.beamDir.z],
        on: me.light && me.lightEnabled && !me.dead && !me.hidden, local: true, tier: 1,
      });
    }
    for (const a of avatars.avatars.values()) {
      const cp = Math.cos(a.pitch);
      out.push({
        id: a.id, pos: [a.lampWorld.x, a.lampWorld.y, a.lampWorld.z],
        dir: [Math.sin(a.yaw) * cp, Math.sin(a.pitch), Math.cos(a.yaw) * cp], on: a.light && a.root.visible, local: false, tier: 1,
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
    setFlashlightEnabled(enabled) {
      me.lightEnabled = enabled;
      if (!enabled && me.light) { me.light = false; ctx.bus.emit('action:flashlight', { down: true, on: false }); }
    },
    flashlightOn: () => me.light && me.lightEnabled && !me.dead,
    setFlashlight: (on) => setLight(on),
    setSpeedMult(mult) { me.speedMult = Math.max(0, Math.min(2, mult)); },
    setCarry(id) { me.carry = id; },
    setHidden(hidden, at, yaw) {
      me.hidden = hidden;
      me.hiddenAt = hidden && at ? at : null;
      if (hidden && yaw !== undefined) me.yaw = yaw;
    },
    playAnim(anim, ms) { me.animOverride = { anim, until: performance.now() + ms }; },
    freeze(reason, on) { if (on) me.frozen.add(reason); else me.frozen.delete(reason); },
    localPose: () => (meId() ? { p: [me.pos.x, me.pos.y, me.pos.z], yaw: me.yaw, pitch: me.pitch, stance: me.stance, anim: me.anim } : null),
    avatarObject: (id) => avatars.get(id)?.root,
    emote,
    settings: () => ({ ...settings }),
    setSettings(p) {
      Object.assign(settings, p);
      saveSettings(settings);
    },
    stamina: () => me.stamina,
    setPreviewAvatar(id, pose, profile) {
      if (!pose || !profile) { avatars.removeDummy(id); return; }
      avatars.setDummy(id, { p: pose.p, yaw: pose.yaw, pitch: 0, stance: pose.stance ?? STANCE.stand, anim: pose.anim ?? ANIM.idle, light: pose.light ?? 0 }, profile);
    },
    locked: () => input.locked(),
  };
  ctx.services.provide('players', playersService);

  // ---------------- HUD ----------------
  ctx.ui.registerHud('bottom', StaminaHud, { id: 'players-stamina', order: 30 });
  ctx.ui.registerHud('center', CrosshairHud, { id: 'players-crosshair', order: 10 });
  ctx.ui.registerHud('center', EmoteWheelHud, { id: 'players-emotes', order: 20 });
  ctx.ui.registerHud('bottom-left', ChatHud, { id: 'players-chat', order: 40 });
  ctx.bus.on('input:pointerlock', ({ locked }) => { ui.locked.value = locked; });

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
        ui.spectating.value = { on: true, target: a ? (ctx.world.crew?.players.find((p) => p.id === specTarget)?.name ?? null) : null };
      } else {
        if (ui.spectating.value.on) { ui.spectating.value = { on: false, target: null }; avatars.hideNameplate(null); }
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
      vm.update(dt, me, !me.dead && !me.hidden && !testCam, me.light && me.lightEnabled, bal().flashlightLag ?? 16);
      avatars.update(dt, camera.position, { on: me.light && me.lightEnabled && !me.dead, pos: vm.lensPos, dir: vm.beamDir });
      markers.update();
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
