// Owner: track (d) Meta (apps/client/src/meta/**). Client plugin entry: hub HUD, board/shop/creator/kennel/brightness,
// drive loading screen, van console, results, HR memo, pause menu (settings / how to play / credits), join extras.
import './meta.css';
import type { ClientContext } from '../core/context.ts';
import { SYS } from '../core/loop.ts';
import type { EventPayload } from '@dead-air/shared/messages/index.ts';
import { PLAYER } from '@dead-air/shared/constants.ts';
import { applySettings, metaOf, players, settings, sfx } from './state.ts';
import { HubCrew, HubShift, HubBanner, HubPrompt, HubHints } from './hub.tsx';
import { BoardScreen, ShopScreen } from './board.tsx';
import { MirrorScreen } from './creator.tsx';
import { BrightnessScreen, JoinExtras, KennelScreen, MenuScreen, runPendingClaim } from './menus.tsx';
import { DriveScreen } from './drive.tsx';
import { ConsoleScreen, consoleMirror, resetMirror } from './console.tsx';
import { MemoScreen, ResultsScreen } from './results.tsx';
import { FLOW_SCREENS, ITEM_SCREEN, META_SCREENS, closeScreen, metaSlice, openScreen } from './nav.ts';
import type { MetaClientSlice } from './nav.ts';
import { installWorkshop } from './workshop.ts';
import { StatsScreen } from './stats.tsx';

/** screens the server may open with 'meta.open' (the workshop and the field guide handle their own) */
const OPENABLE = new Set(['kennel', 'mirror', 'board', 'shop', 'console', 'stats']);

function localPos(ctx: ClientContext): [number, number, number] | null {
  const lp = players(ctx)?.localPose?.();
  if (lp) return lp.p;
  const me = ctx.world.me ? ctx.world.players.get(ctx.world.me)?.latest() : null;
  return me ? me.p : null;
}

function nearestItem(ctx: ClientContext): { id: string; kind: string; d: number } | null {
  const L = ctx.world.layout;
  const p = localPos(ctx);
  if (!L || !p) return null;
  let best: { id: string; kind: string; d: number } | null = null;
  for (const it of L.items) {
    if (!(it.kind in ITEM_SCREEN)) continue;
    if (L.kind !== 'hub' && it.kind !== 'console') continue;
    const r = it.kind === 'kennel' ? 3.2 : PLAYER.interactRange + 0.4;
    const d = Math.hypot(it.x - p[0], it.z - p[2]);
    if (d <= r && (!best || d < best.d)) best = { id: it.id, kind: it.kind, d };
  }
  return best;
}

export function install(ctx: ClientContext): void {
  const ui = ctx.ui;
  ui.registerScreen('board', BoardScreen);
  ui.registerScreen('shop', ShopScreen);
  ui.registerScreen('mirror', MirrorScreen);
  ui.registerScreen('kennel', KennelScreen);
  ui.registerScreen('brightness', BrightnessScreen);
  ui.registerScreen('menu', MenuScreen);
  ui.registerScreen('drive', DriveScreen);
  ui.registerScreen('console', ConsoleScreen);
  ui.registerScreen('results', ResultsScreen);
  ui.registerScreen('memo', MemoScreen);
  ui.registerScreen('stats', StatsScreen);

  ui.registerHud('top-left', HubCrew, { order: 20, id: 'meta-crew' });
  ui.registerHud('top-right', HubShift, { order: 20, id: 'meta-shift' });
  ui.registerHud('top', HubBanner, { order: 20, id: 'meta-banner' });
  ui.registerHud('center', HubPrompt, { order: 20, id: 'meta-prompt' });
  ui.registerHud('bottom', HubHints, { order: 40, id: 'meta-hints' });
  ui.registerHud('join', JoinExtras, { order: 30, id: 'meta-join' });

  // ---- server -> client
  ctx.net.on('meta.update', (d: EventPayload<'meta.update'>) => {
    const full = ctx.world.full;
    if (!full) return;
    full.meta = d.meta;
    full.workOrders = d.workOrders;
    full.activeOrder = d.activeOrder;
    ctx.world.notify();
  });
  ctx.net.on('meta.open', (d: EventPayload<'meta.open'>) => {
    if (OPENABLE.has(d.screen) && ui.screen.value.name !== d.screen) openScreen(ctx, d.screen, d.props ?? {});
  });
  // v1.2 collection log: a first find (private to the finder)
  ctx.net.on('meta.collection', (d: EventPayload<'meta.collection'>) => {
    ui.toast(`NEW FIND · ${d.label} · collection log ${d.total}/${d.of}`, 'info', 4500);
    sfx(ctx, 'sfx.ui_confirm');
  });
  const onAny = ctx.net.on as unknown as (e: string, fn: (d: unknown) => void) => () => void;
  onAny('interaction.patch', (d) => {
    const p = d as { reset?: { doors?: Record<number, { open: boolean; locked: boolean }>; dead?: string[] }; doors?: Record<number, { open: boolean; locked: boolean }>; dead?: string[] };
    const m = consoleMirror(ctx);
    if (p.reset) {
      m.doors = { ...(p.reset.doors ?? {}) };
      m.dead = [...(p.reset.dead ?? [])];
    }
    if (p.doors) Object.assign(m.doors, p.doors);
    if (p.dead) m.dead = [...p.dead];
  });
  onAny('objectives.state', (d) => {
    consoleMirror(ctx).obj = d as never;
  });
  onAny('monsters.intercept', (d) => {
    const s = metaSlice(ctx);
    s.intercepts.push(d as MetaClientSlice['intercepts'][number]);
    if (s.intercepts.length > 40) s.intercepts.shift();
  });

  // ---- phase flow -> screens
  const syncPhaseScreen = () => {
    const cur = ui.screen.value.name;
    if (cur === 'join') return;
    const ph = ctx.world.phase;
    if (ph === 'drive') {
      if (cur !== 'drive') openScreen(ctx, 'drive');
    } else if (ph === 'results') {
      if (cur !== 'results' && cur !== 'memo') openScreen(ctx, 'results');
    } else if (FLOW_SCREENS.has(cur) || (ph === 'contract' && META_SCREENS.has(cur) && cur !== 'console' && cur !== 'menu')) {
      closeScreen(ctx);
    }
  };
  ctx.bus.on('world:phase', ({ from, to }) => {
    if (to === 'contract') metaSlice(ctx).intercepts = [];
    // Company PA: last contract of the shift coming up
    const sh = metaOf(ctx)?.shift;
    if (from === 'results' && to === 'hub' && sh && sh.contract === (sh.contractsPerShift ?? 3) - 1) setTimeout(() => sfx(ctx, 'vo.pa_quota_reminder'), 1800);
    resetMirror(ctx);
    syncPhaseScreen();
  });
  // one-time brightness check in the van: armed on welcome, opened by the per-frame system on the first frame the
  // screen is 'none' in the hub (the join screen can stay up for up to ~25 s after welcome while the level builds)
  let brightPending = false;
  const maybeBrightness = (): void => {
    if (!brightPending) return;
    if (settings().brightnessDone || ctx.params.has('nobright')) { brightPending = false; return; }
    if (ctx.world.phase !== 'hub' || ui.screen.value.name !== 'none') return;
    brightPending = false;
    openScreen(ctx, 'brightness', { first: true });
  };
  ctx.bus.on('net:welcome', ({ resumed }) => {
    resetMirror(ctx);
    if (!resumed) runPendingClaim(ctx);
    if (!resumed && ctx.world.phase === 'hub') setTimeout(() => sfx(ctx, 'vo.pa_welcome'), 2500);
    if (!settings().brightnessDone && !ctx.params.has('nobright')) brightPending = true;
    setTimeout(() => {
      syncPhaseScreen();
      void applySettings(ctx);
      maybeBrightness();
    }, 600);
  });
  ctx.bus.on('audio:unlocked', () => { void applySettings(ctx, ['master', 'voice', 'sfx']); });

  // keep the local identity's profile in sync with the host (canonical badge, claimed profile)
  ctx.world.subscribe(() => {
    const me = ctx.world.crew?.players.find((p) => p.id === ctx.world.me);
    if (!me) return;
    const id = ctx.net.identity();
    if (JSON.stringify(id.profile) !== JSON.stringify(me.profile) || id.name !== me.name) ctx.net.setIdentity({ name: me.name, profile: me.profile });
  });

  // ---- input: E at hub items (fallback when (b) does not route them), Esc, B
  const bus = ctx.bus as unknown as { on(k: string, fn: (d: { down?: boolean }) => void): () => void };
  bus.on('action:interact', (d) => {
    if (d && d.down === false) return;
    if (ui.screen.value.name !== 'none') return;
    if (ctx.world.phase !== 'hub' && ctx.world.phase !== 'contract') return;
    const near = nearestItem(ctx);
    if (!near) return;
    // (b) routes E by aim (board/shop/mirror/console -> 'meta.open'); only the kennel is ours alone. Without (b), all of them.
    if (metaOf(ctx)?.serverInteract && near.kind !== 'kennel') return;
    openScreen(ctx, ITEM_SCREEN[near.kind]);
  });
  bus.on('action:menu', (d) => {
    if (d && d.down === false) return;
    if (performance.now() - metaSlice(ctx).openedAt < 400) return; // pointer-lock release caused by opening a screen
    const cur = ui.screen.value.name;
    if (cur === 'none' && (ctx.world.phase === 'hub' || ctx.world.phase === 'contract')) openScreen(ctx, 'menu');
  });
  addEventListener('keydown', (e) => {
    const cur = ui.screen.value.name;
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
    if (e.key === 'Escape') {
      if (META_SCREENS.has(cur) && !FLOW_SCREENS.has(cur)) {
        e.preventDefault();
        closeScreen(ctx);
      }
      return;
    }
    if (typing || e.repeat) return;
    if (e.code === 'KeyR' && ctx.world.phase === 'hub' && (cur === 'none' || cur === 'board') && ctx.net.status === 'joined') {
      const me = ctx.world.crew?.players.find((p) => p.id === ctx.world.me);
      void ctx.net.req('meta.ready', { ready: !me?.ready }).catch(() => {});
      return;
    }
    if ((e.code === 'KeyB' || e.code === 'Tab') && ctx.world.phase === 'hub') {
      if (cur === 'none') {
        e.preventDefault();
        openScreen(ctx, 'board');
      } else if (cur === 'board') {
        e.preventDefault();
        closeScreen(ctx);
      }
    }
  });

  // ---- per frame: prompt target, freeze movement while a screen is open
  let lastScreen = '';
  let acc = 0;
  ctx.registerSystem({
    name: 'meta',
    order: SYS.ui,
    update(dt) {
      const cur = ui.screen.value.name;
      if (brightPending && cur === 'none') maybeBrightness();
      if (cur !== lastScreen) {
        const frozen = cur !== 'none';
        try { players(ctx)?.freeze?.('meta-screen', frozen); } catch { /* optional */ }
        // full-screen meta screens hide the HUD layer (the console keeps it: radio LED, band meter)
        if (META_SCREENS.has(cur) && cur !== 'console') ui.hudVisible.value = false;
        else if (META_SCREENS.has(lastScreen) || cur === 'none') ui.hudVisible.value = true;
        lastScreen = cur;
      }
      acc += dt;
      if (acc >= 0.1) {
        acc = 0;
        const s = metaSlice(ctx);
        const n = cur === 'none' ? nearestItem(ctx) : null;
        if ((n?.id ?? null) !== (s.near?.id ?? null)) {
          s.near = n;
          ctx.world.notify();
        }
      }
    },
  });

  // ---- test hooks
  if (ctx.testMode) {
    (window as unknown as { __meta?: unknown }).__meta = {
      open: (name: string, props?: Record<string, unknown>) => openScreen(ctx, name, props ?? {}),
      close: () => closeScreen(ctx),
      screen: () => ui.screen.value.name,
      meta: () => JSON.parse(JSON.stringify(metaOf(ctx))),
      near: () => metaSlice(ctx).near,
      pushIntercept: (d: MetaClientSlice['intercepts'][number]) => metaSlice(ctx).intercepts.push(d),
      layoutItems: () => (ctx.world.layout?.items ?? []).map((i) => ({ id: i.id, kind: i.kind, x: i.x, z: i.z, rot: i.rot ?? 0 })),
    };
  }

  // v1.2 workshop (G5): 'workbench' screen + van upgrade sync
  installWorkshop(ctx);
}
