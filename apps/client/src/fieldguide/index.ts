// Owner: fieldguide (v1.2) client: the 'fieldguide' screen (J), the hazard-bulletin reader, toasts, and the bulletin
// pages on E3's lore frames (level.setLorePage). Page text only ever arrives in the private server view.
import './fieldguide.css';
import type { ClientContext } from '../core/context.ts';
import { SYS } from '../core/loop.ts';
import type { InteractionState } from '@dead-air/shared/messages/interaction.ts';
import type { LorePageVisual } from '../level/api.ts';
import { BookletScreen, BulletinScreen, uiSfx } from './booklet.tsx';
import { MONSTER_NAMES, fgTab, fgView, isTab } from './store.ts';
import { fgToasts } from './toasts.ts';

interface LevelLoreLike {
  setLorePage?(id: string, page: LorePageVisual | null): void;
  loreSpots?(): readonly { id: string }[];
}
interface InteractionLike { state(): InteractionState }

const SCREEN = 'fieldguide';
const READER = 'fieldguide-bulletin';
const TOAST_MS = 5200;
/** at most this many held announcements are shown one by one when a sheet closes; the rest become one summary */
const FLUSH_MAX = 3;

function loose<T>(ctx: ClientContext, name: string): T | undefined {
  try { return (ctx.services.use as unknown as (n: string) => T | undefined)(name); } catch { return undefined; }
}

const isTextTarget = (el: EventTarget | Element | null): boolean => {
  const t = el as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable === true);
};

export function install(ctx: ClientContext): void {
  if (ctx.flags.fieldGuide === false) return;
  ctx.ui.registerScreen(SCREEN, BookletScreen);
  ctx.ui.registerScreen(READER, BulletinScreen);

  const refresh = () => {
    if (ctx.net.status !== 'joined') return;
    void ctx.net.req('fieldguide.get', {}).then((v) => { fgView.value = v; }, () => undefined);
  };
  const open = (tab?: unknown) => {
    try { document.exitPointerLock?.(); } catch { /* ignore */ }
    ctx.ui.setScreen(SCREEN, isTab(tab) ? { tab } : {});
  };
  const close = () => {
    const cur = ctx.ui.screen.value.name;
    if (cur === SCREEN || cur === READER) ctx.ui.setScreen('none');
  };

  // ---------------------------------------------------------------- toasts never cover the booklet or the reader
  // (gate R: NEW ENTRY / PAGE FILED toasts stacked over the open booklet): held while a sheet is open, ours taken down
  // when one opens, the reader's own page gets none (./toasts.ts)
  const toasts = fgToasts(ctx.ui, {
    sheets: [SCREEN, READER], reader: READER, ms: TOAST_MS, flushMax: FLUSH_MAX,
    canFlush: () => ctx.world.phase === 'hub' || ctx.world.phase === 'contract',
  });

  // ---------------------------------------------------------------- server events
  ctx.net.on('fieldguide.state', (v) => {
    fgView.value = v;
    syncLore(true);
  });
  ctx.net.on('fieldguide.filed', (d) => {
    const name = d.name ?? (d.kind !== 'anomaly' ? MONSTER_NAMES[d.kind] : '');
    const text = d.pageId ? `FIELD GUIDE · PAGE FILED: ${name} ${d.n}/${d.of}  [J]` : `${d.title}  [J]`;
    toasts.announce(d.pageId ? `page:${d.pageId}` : `${d.kind}:${d.title}`, text);
    if (d.kind !== 'anomaly') fgTab.value = d.kind;
    if (ctx.ui.screen.value.name !== READER) uiSfx(ctx, 'sfx.ui_confirm', 0.3, 0.75);
  });
  ctx.net.on('fieldguide.read', (d) => {
    try { document.exitPointerLock?.(); } catch { /* ignore */ }
    fgTab.value = d.monster;
    ctx.ui.setScreen(READER, { ...d });
  });
  ctx.net.on('fieldguide.open', (d) => open(d?.tab));
  ctx.bus.on('net:welcome', () => setTimeout(refresh, 200));
  ctx.bus.on('world:phase', ({ to }) => {
    const cur = ctx.ui.screen.value.name;
    if ((to === 'drive' || to === 'results') && (cur === SCREEN || cur === READER)) ctx.ui.setScreen('none');
    refresh();
  });

  // ---------------------------------------------------------------- J toggles the booklet (never while typing)
  addEventListener('keydown', (e) => {
    if (e.code !== 'KeyJ' || e.repeat || e.altKey) return;
    if (isTextTarget(e.target) || isTextTarget(document.activeElement)) return;
    if (ctx.net.status !== 'joined') return;
    const cur = ctx.ui.screen.value.name;
    if (cur === SCREEN) { e.preventDefault(); close(); return; }
    const ph = ctx.world.phase;
    if (ph !== 'hub' && ph !== 'contract') return;
    if (cur === 'none' || cur === READER || cur === 'menu') {
      e.preventDefault();
      open(cur === READER ? fgTab.value : undefined);
    }
  });

  // ---------------------------------------------------------------- bulletin pages on the lore frames
  /** spot id -> the visual last handed to the level (JSON), for the current layout + frame set */
  const applied = new Map<string, string>();
  let appliedFor = '';
  let acc = 0;
  const syncLore = (force = false): void => {
    const lv = loose<LevelLoreLike>(ctx, 'level');
    const ix = loose<InteractionLike>(ctx, 'interaction');
    if (!lv?.setLorePage || !ix) return;
    const L = ctx.world.layout;
    const frames = lv.loreSpots ? lv.loreSpots() : null;
    // a new layout (or the level finished building its lore frames): forget what we drew, the frames are new
    const tag = `${L ? `${L.seed}:${L.hash}` : '-'}|${frames ? `${frames.length}:${frames[0]?.id ?? ''}` : 'n/a'}`;
    if (tag !== appliedFor) { applied.clear(); appliedFor = tag; }
    if (!force && !L) return;
    const known = frames ? new Set(frames.map((f) => f.id)) : null;
    const st = ix.state();
    const want = new Map<string, LorePageVisual>();
    for (const int of Object.values(st.ints ?? {})) {
      if (!int || int.kind !== 'bulletin' || typeof int.ref !== 'string') continue;
      if (known && !known.has(int.ref)) continue; // frame not built yet: retry on a later pass
      const b = fgView.value?.bulletins?.find((x) => x.spot === int.ref);
      want.set(int.ref, { visible: true, title: 'HAZARD BULLETIN', text: b ? `${b.name}\nFORM FG-1` : 'FORM FG-1', dim: !!b?.read });
    }
    for (const id of [...applied.keys()]) {
      if (want.has(id)) continue;
      try { lv.setLorePage(id, null); } catch (e) { ctx.reportError(`fieldguide: setLorePage(${id}, null): ${e instanceof Error ? e.message : e}`); }
      applied.delete(id);
    }
    for (const [id, v] of want) {
      const j = JSON.stringify(v);
      if (applied.get(id) === j) continue;
      try { lv.setLorePage(id, v); applied.set(id, j); } catch (e) { ctx.reportError(`fieldguide: setLorePage(${id}): ${e instanceof Error ? e.message : e}`); }
    }
  };
  ctx.registerSystem({
    name: 'fieldguide',
    order: SYS.ui + 2,
    update(dt) {
      acc += dt;
      if (acc < 0.25) return;
      acc = 0;
      syncLore();
    },
  });

  // ---------------------------------------------------------------- test hooks (?test=1)
  if (ctx.testMode) {
    (window as unknown as { __fieldguide?: unknown }).__fieldguide = {
      view: () => (fgView.value ? JSON.parse(JSON.stringify(fgView.value)) : null),
      screen: () => ctx.ui.screen.value.name,
      open: (tab?: string) => open(tab),
      close,
      refresh,
      lorePages: () => Object.fromEntries([...applied].map(([k, v]) => [k, JSON.parse(v)])),
      /** open the bulletin reader with a 'fieldguide.read' payload (screenshots) */
      reader: (d: Record<string, unknown>) => ctx.ui.setScreen(READER, { ...d }),
      /** is E3's lore API there yet? */
      levelLore: () => {
        const lv = loose<LevelLoreLike>(ctx, 'level');
        return { setLorePage: typeof lv?.setLorePage === 'function', loreSpots: typeof lv?.loreSpots === 'function' };
      },
      sync: () => syncLore(true),
      /** announcements held while a sheet is open, and our toasts on screen right now */
      toasts: () => toasts.peek(),
    };
  }
}
