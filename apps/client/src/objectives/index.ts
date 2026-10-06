// Owner: track (a) Objectives (apps/client/src/objectives/**). Client plugin entry; see apps/client/src/core/context.ts.
// HUD checklist + clock + requests, keypad / note modals, centre banners, "+scrip" floating texts, sfx cues, 3D
// lever/keypad/Core visuals, blackout -> services.render.setPower('all', false). E on objectives interactables is
// normally routed by (b) interaction (server calls our handlers); without (b)'s client we target + send ourselves.
import './objectives.css';
import * as THREE from 'three/webgpu';
import type { ClientContext } from '../core/context.ts';
import { SYS } from '../core/loop.ts';
import type { ObjectivesState } from '@dead-air/shared/messages/objectives.ts';
import { MOVE, PLAYER } from '@dead-air/shared/constants.ts';
import { addFloat, banner, floats, lastResult, leverWait, objState, prompt, showBanner } from './state.ts';
import { Banner, Checklist, LeverCountdown, Prompt } from './hud.tsx';
import { KeypadScreen, NoteScreen } from './modals.tsx';
import { createObjVisuals } from './visuals.ts';

export { objState } from './state.ts';

type V3 = [number, number, number];
interface SfxLike { play(id: string, pos?: V3, o?: Record<string, unknown>): unknown }
interface RenderLike { setPower?(space: number | 'all', on: boolean): void; flickerSpace?(space: number, ms: number): void }
type LooseOn = (e: string, fn: (d: Record<string, unknown>) => void) => () => void;

export function install(ctx: ClientContext): void {
  const loose = <T>(name: string) => (ctx.services.use as unknown as (n: string) => T | undefined)(name);
  const sfx = (key: string, pos?: V3, o: Record<string, unknown> = {}) => {
    try { (ctx.services.use('sfx') as unknown as SfxLike | undefined)?.play(key, pos, pos ? o : { ui: true, ...o }); } catch { /* audio optional */ }
  };
  const me = () => ctx.world.me ?? '';
  const nameOf = (id: string) => ctx.world.crew?.players.find((p) => p.id === id)?.name ?? 'Someone';

  // ---------------- state ----------------
  const setState = (st: ObjectivesState | null) => {
    objState.value = st;
    if (ctx.world.full) ctx.world.full.objectives = st;
  };
  ctx.world.subscribe(() => {
    const st = ctx.world.full?.objectives ?? null;
    if (st !== objState.value) objState.value = st;
  });
  ctx.net.on('objectives.state', (d) => setState(d));
  ctx.bus.on('world:phase', ({ to }) => {
    if (to !== 'contract') { prompt.value = null; leverWait.value = null; }
    if (to === 'hub' || to === 'drive') (ctx.services.use('render') as RenderLike | undefined)?.setPower?.('all', true);
  });

  // ---------------- UI ----------------
  ctx.ui.registerHud('top-right', Checklist, { id: 'objectives.checklist', order: 20 });
  ctx.ui.registerHud('top', Banner, { id: 'objectives.banner', order: 30 });
  ctx.ui.registerHud('top', LeverCountdown, { id: 'objectives.lever', order: 31 });
  ctx.ui.registerHud('center', Prompt, { id: 'objectives.prompt', order: 40 });
  ctx.ui.registerScreen('obj-keypad', KeypadScreen);
  ctx.ui.registerScreen('obj-note', NoteScreen);
  const openUi = (ui: 'keypad' | 'note', id: string) => {
    const cur = ctx.ui.screen.value;
    if (cur.name !== 'none' && cur.name !== 'obj-keypad' && cur.name !== 'obj-note') return;
    if (cur.name === `obj-${ui}` && cur.props.id === id) return;
    ctx.ui.setScreen(`obj-${ui}`, { id });
  };
  ctx.net.on('objectives.open', (d) => openUi(d.ui, d.id));
  ctx.net.on('objectives.msg', (d) => ctx.ui.toast(d.text, d.kind ?? 'info', 2600));

  // ---------------- events -> fx ----------------
  const visuals = createObjVisuals(ctx);
  ctx.net.on('objectives.lever', (d) => {
    sfx('sfx.lever_clunk_heavy', d.p, { volume: 0.9 });
    if (d.result === 'waiting') {
      leverWait.value = { id: d.id, at: ctx.world.serverNow(), by: d.by };
    } else if (d.result === 'fail') {
      leverWait.value = null;
      sfx('sfx.alarm_short', d.p, { volume: 1, radius: 20 });
      showBanner('BREAKER TRIPPED', 'bad', 'Alarm! Both breakers must go down within 1 second. Reset in 20 s.', 3400);
    } else if (d.result === 'success') {
      leverWait.value = null;
    }
  });
  ctx.net.on('objectives.power', (d) => {
    showBanner('POWER RESTORED', 'ok', 'The vault keypad is live.');
    sfx('sfx.power_up_surge', undefined, { volume: 0.9 });
    // (b)'s client pushes per-space lights (InteractionState.lights) to ③; only push ourselves without it
    if (!bHandlesE()) {
      const r = ctx.services.use('render') as RenderLike | undefined;
      for (const s of d.spaces) r?.setPower?.(s, d.on);
    }
  });
  ctx.net.on('objectives.keypad', (d) => {
    if (d.reason?.startsWith('key:')) { sfx('sfx.keypad_press', d.p, { volume: 0.6, radius: 6 }); return; }
    if (d.by !== me()) sfx(d.ok ? 'sfx.keypad_accept' : 'sfx.keypad_deny', d.p, { volume: 0.8 });
    visuals.keypadFlash(d.ok);
  });
  ctx.net.on('objectives.vault', (d) => {
    sfx('sfx.vault_unlock_heavy', d.p, { volume: 1, radius: 25 });
    showBanner('VAULT OPEN', 'ok', d.by ? `${nameOf(d.by)} cracked it. Get the Core: two carriers.` : undefined);
  });
  ctx.net.on('objectives.core', (d) => {
    if (d.state === 'carried' && d.carriers.length === 2) {
      sfx('sfx.metal_latch', d.p, { volume: 0.8 });
      if (d.carriers.includes(me())) showBanner('CORE LIFTED', 'info', 'Move together. Stay close or you drop it. E lets go.');
    } else if (d.state === 'dropped' && d.lost) {
      sfx('sfx.metal_hit', d.p, { volume: 1, radius: 15 });
      showBanner('CORE DROPPED', 'bad', `-$${d.lost}. It heard that.`);
      addFloat(`-$${d.lost}`, [d.p[0], 1.1, d.p[2]], 'bad');
    } else if (d.state === 'van') {
      sfx('sfx.loot_deposit', d.p, { volume: 1 });
      showBanner('CORE SECURED', 'ok', `+$${d.value} in the van`);
      addFloat(`+$${d.value} CORE`, [d.p[0], 1.4, d.p[2]], 'ok');
    } else if (d.by === me() && d.carriers.includes(me())) {
      sfx('sfx.metal_click', d.p, { volume: 0.7 });
    }
  });
  ctx.net.on('objectives.loot', (d) => {
    if (d.action === 'deposit') {
      sfx('sfx.loot_deposit', d.p, { volume: 0.8 });
      addFloat(`+$${d.value}`, [d.p[0], 1.2, d.p[2]], 'ok');
    } else if (d.action === 'break') {
      sfx('sfx.glass_break', d.p, { volume: 0.8 });
    }
  });
  ctx.net.on('objectives.blackout', () => {
    (ctx.services.use('render') as RenderLike | undefined)?.setPower?.('all', false);
    sfx('sfx.power_down_blackout', undefined, { volume: 1 });
    showBanner('03:00 · GRID FAILURE', 'bad', 'Every light in the facility just died.', 4200);
  });
  ctx.net.on('objectives.horn', (d) => {
    sfx('sfx.van_horn', d.p, { volume: 1, radius: 80 });
    showBanner('03:30 · THE VAN IS WARMING UP', 'warn', 'Departure at 04:00. Anyone outside stays.', 4200);
  });
  ctx.net.on('objectives.pa', (d) => {
    sfx(d.key, undefined, { volume: 0.9 });
  });
  ctx.net.on('objectives.request', (d) => {
    if (d.done) { sfx('sfx.ui_confirm'); ctx.ui.toast(`Company Request met: +${d.reward}`, 'info', 4000); }
    else if (d.failed) ctx.ui.toast('Company Request failed', 'warn', 3000);
  });
  ctx.net.on('objectives.departure', (d) => {
    if (d.lost.includes(me())) showBanner('LEFT BEHIND', 'bad', 'The van left without you.', 5000);
  });
  ctx.net.on('objectives.end', (d) => {
    lastResult.value = d.result;
    const r = d.result;
    if (r.reason === 'wipe') showBanner('CREW LOST', 'bad', 'Nobody made it to the van.', 5000);
    else showBanner('THE VAN IS LEAVING', 'info', `Hauled $${r.hauled}${r.coreExtracted ? ' · Core secured' : ''} · ${r.survivors.length} aboard`, 5000);
    sfx('sfx.van_engine_idle_loop', undefined, { volume: 0.6 });
  });

  // ---------------- fallback targeting (only without (b)'s client) ----------------
  const bHandlesE = () => !!loose('interaction') || ctx.ui.huds.value.some((h) => /^(interaction|ix)[.:-]/.test(h.id));
  interface Tgt { id: string; text: string; enabled: boolean }
  const targets = (st: ObjectivesState): { id: string; p: V3; text: string; enabled: boolean }[] => {
    const out: { id: string; p: V3; text: string; enabled: boolean }[] = [];
    const now = ctx.world.serverNow();
    for (const l of st.levers) out.push({ id: l.id, p: l.p, text: st.power[l.zone] ? 'Breaker (on)' : st.leverCooldownUntil > now ? 'Breaker tripped: wait' : 'Pull breaker (partner pulls the other within 1 s)', enabled: !st.power[l.zone] });
    if (st.keypad) out.push({ id: st.keypad.id, p: st.keypad.p, text: st.vaultOpen ? 'Vault open' : st.keypad.enabled ? 'Enter vault code' : 'Keypad (no power)', enabled: !st.vaultOpen });
    if (st.core && st.core.state !== 'van') out.push({ id: st.core.id, p: [st.core.p[0], 0.7, st.core.p[2]], text: st.core.carriers.includes(me()) ? 'Let go of the Core' : 'Grab a Core handle (needs 2)', enabled: st.vaultOpen || st.core.state !== 'vault' });
    for (const n of st.notes) out.push({ id: n.id, p: n.p, text: `Read: ${n.title}`, enabled: true });
    if (st.leaveLever) out.push({ id: st.leaveLever.id, p: st.leaveLever.p, text: 'Leave now (everyone alive in the van)', enabled: true });
    if (st.lootMode === 'objectives') {
      for (const l of st.loot) if (l.where === 'world') out.push({ id: l.id, p: [l.p[0], 0.3, l.p[2]], text: `Pick up ${l.name} ($${l.value})`, enabled: true });
      if (st.deposit) out.push({ id: 'deposit:0', p: st.deposit.p, text: 'Deposit salvage', enabled: true });
    }
    return out;
  };
  const camDir = new THREE.Vector3();
  const pickTarget = (): Tgt | null => {
    const st = objState.value;
    const cam = ctx.services.use('three')?.camera;
    if (!st || !st.active || st.ended || !cam || ctx.world.phase !== 'contract') return null;
    cam.getWorldDirection(camDir);
    const cp = cam.getWorldPosition(new THREE.Vector3());
    let best: Tgt | null = null;
    let bestScore = Infinity;
    for (const t of targets(st)) {
      const dx = t.p[0] - cp.x, dy = t.p[1] - cp.y, dz = t.p[2] - cp.z;
      const d = Math.hypot(dx, dy, dz);
      const flat = Math.hypot(dx, dz);
      if (flat > PLAYER.interactRange + 0.3) continue;
      const cos = d > 1e-3 ? (dx * camDir.x + dy * camDir.y + dz * camDir.z) / d : 1;
      if (cos < 0.82 && flat > 0.9) continue;
      const score = d * (2 - cos);
      if (score < bestScore) { bestScore = score; best = { id: t.id, text: t.text, enabled: t.enabled }; }
    }
    return best;
  };
  let current: Tgt | null = null;
  const doInteract = async () => {
    const st = objState.value;
    if (!st || !st.active || st.ended || ctx.ui.screen.value.name !== 'none') return;
    // carrying the Core: E always lets go (server dedupes against (b)'s routed E)
    if (st.core?.carriers.includes(me()) && st.core.state === 'carried') {
      await ctx.net.req('objectives.core', { action: 'release' }).catch(() => undefined);
      return;
    }
    if (bHandlesE()) return;
    const t = pickTarget();
    if (!t) return;
    try {
      const r = await ctx.net.req('objectives.interact', { id: t.id });
      if (r.open) openUi(r.open, t.id);
      else if (!r.ok && r.msg) ctx.ui.toast(r.msg, 'warn', 2200);
    } catch (e) {
      ctx.ui.toast(e instanceof Error ? e.message : String(e), 'warn', 2000);
    }
  };
  (ctx.bus.on as unknown as LooseOn)('action:interact', (d) => { if (d.down) void doInteract(); });
  // no players track (no action bus): raw key fallback
  addEventListener('keydown', (e) => {
    if (e.code !== 'KeyE' || e.repeat || ctx.services.use('input')) return;
    if (ctx.ui.screen.value.name !== 'none') return;
    void doInteract();
  });

  // ---------------- floating texts (3D-anchored DOM) ----------------
  // own fixed layer on <body> (Preact owns #overlay's children)
  const layer = document.createElement('div');
  layer.className = 'obj-floats';
  document.body.appendChild(layer);
  const els = new Map<number, HTMLDivElement>();
  const v = new THREE.Vector3();
  const updateFloats = () => {
    const cam = ctx.services.use('three')?.camera;
    const list = floats.value;
    const now = performance.now();
    const alive = list.filter((f) => now - f.born < 1800);
    if (alive.length !== list.length) floats.value = alive;
    for (const [id, el] of els) if (!alive.some((f) => f.id === id)) { el.remove(); els.delete(id); }
    for (const f of alive) {
      let el = els.get(f.id);
      if (!el) {
        el = document.createElement('div');
        el.className = `obj-float ${f.tone}`;
        el.textContent = f.text;
        layer.appendChild(el);
        els.set(f.id, el);
      }
      const k = (now - f.born) / 1800;
      if (!cam) { el.style.opacity = '0'; continue; }
      v.set(f.p[0], f.p[1] + k * 0.6, f.p[2]).project(cam);
      const behind = v.z > 1;
      el.style.opacity = behind ? '0' : String(Math.min(1, (1 - k) * 1.6));
      el.style.transform = `translate(${((v.x + 1) / 2) * innerWidth}px, ${((1 - v.y) / 2) * innerHeight}px) translate(-50%, -50%) scale(${1 + k * 0.15})`;
    }
  };

  // ---------------- Core carry: slow both carriers + carry animation (⑤ players service) ----------------
  interface PlayersLike { setSpeedMult?(m: number): void; setCarry?(id: string | null): void }
  let carrying: string | null = null;
  const syncCarry = () => {
    const st = objState.value;
    const c = st?.core;
    const now = st && st.active && !st.ended && c && c.state === 'carried' && c.carriers.includes(me()) ? c.id : null;
    if (now === carrying) return;
    carrying = now;
    const pl = loose<PlayersLike>('players');
    try {
      pl?.setSpeedMult?.(now ? MOVE.carryCoreMult : 1);
      pl?.setCarry?.(now);
    } catch { /* players track mid-reload */ }
  };

  // ---------------- per-frame system ----------------
  let promptAcc = 0;
  ctx.registerSystem({
    name: 'objectives',
    order: SYS.interaction + 2,
    update(dt) {
      visuals.update(dt);
      updateFloats();
      syncCarry();
      promptAcc += dt;
      if (promptAcc > 0.1) {
        promptAcc = 0;
        const st = objState.value;
        if (st && st.active && !st.ended && st.core?.state === 'carried' && st.core.carriers.includes(me())) {
          if (!prompt.value?.carry) prompt.value = { text: 'Let go of the Core', enabled: true, carry: true };
        } else if (bHandlesE()) {
          if (prompt.value) prompt.value = null;
        } else {
          current = pickTarget();
          prompt.value = current ? { text: current.text, enabled: current.enabled } : null;
        }
      }
      if (banner.value && performance.now() > banner.value.until) banner.value = null;
    },
  });

  // test hook (?test=1): agents drive the objectives UI without pointer lock / key events
  if (ctx.testMode) {
    (window as unknown as Record<string, unknown>).__objectives = {
      state: () => JSON.parse(JSON.stringify(objState.value)),
      result: () => lastResult.value,
      open: (ui: 'keypad' | 'note', id: string) => openUi(ui, id),
      close: () => ctx.ui.setScreen('none'),
      interact: (id: string) => ctx.net.req('objectives.interact', { id }),
      req: (r: string, a: unknown) => ctx.net.req(r as never, a as never),
      prompt: () => prompt.value,
      banner: () => banner.value,
    };
  }
}
