// Owner: env-paranormal (v1.2) client. SYS 55. Renders the server's paranormal events in its own tell language
// (brownouts, dying tubes, frost, knocks, shadows, wet prints; never strobes, walkies, intercoms, vents, ceiling
// scratching or the scrape loop). Timing comes from the server: effects start at the event's `at` on
// world.serverNow(); late events fast-forward; 'paranormal.sync' re-sends residue + active after a (re)join or a
// level rebuild. Witnesses: witness.ts (frustum + LOS + <= 20 m + >= 0.25 s, <= 10 Hz, only while armed).
// services.paranormal: settings {mode: 'full' | 'subtle'} (localStorage); 'reduce flicker' = slow fades only.
import type { ParanormalEvent } from '@dead-air/shared/messages/paranormal.ts';
import type { ClientContext } from '../core/context.ts';
import { RENDER_LAYERS } from '../render/api.ts';
import type { Effect, Env, LevelView, PlayersView, RenderView, SfxView } from './env.ts';
import { loadSettings, reduceFlickerOn, saveSettings } from './settings.ts';
import type { ParanormalSettings } from './settings.ts';
import { WitnessTracker } from './witness.ts';
import { DarkWalk, Revive } from './darkwalk.ts';
import { MirrorFigure, MirrorWriting } from './mirror.ts';
import { Presence, Silhouette } from './presence.ts';
import { Footprints, footprintPool } from './footprints.ts';
import { PropMove } from './props.ts';
import { BrownoutBreath, ColdSpot, Knock, clearVolumes } from './ambient.ts';
import { figures, warmTemplates } from './figure.ts';

export type { ParanormalSettings };
export interface ParanormalClientService { settings(): ParanormalSettings; setSettings(p: Partial<ParanormalSettings>): void }
declare module '../core/services.ts' {
  interface ServiceMap { paranormal: ParanormalClientService }
}

/** client loop order (between level 50 and interaction 60) */
export const PARANORMAL_SYS = 55;

function makeEffect(env: Env, ev: ParanormalEvent, residue: boolean): Effect | null {
  switch (ev.kind) {
    case 'dark_walk': return new DarkWalk(env, ev, residue);
    case 'revive': return new Revive(env, ev);
    case 'mirror_writing': return new MirrorWriting(env, ev, residue);
    case 'mirror_figure': return residue ? null : new MirrorFigure(env, ev);
    case 'presence': return residue ? null : new Presence(env, ev);
    case 'silhouette': return residue ? null : new Silhouette(env, ev);
    case 'footprints': return new Footprints(env, ev);
    case 'poltergeist':
    case 'object_fall': return new PropMove(env, ev, residue);
    case 'knock':
    case 'handle_rattle': return residue ? null : new Knock(env, ev);
    case 'cold_spot': return residue ? null : new ColdSpot(env, ev);
    case 'brownout_breath': return residue ? null : new BrownoutBreath(env, ev);
    default: return null; // stretch kinds (radio, phone, dead pokes) are off
  }
}

export function install(ctx: ClientContext): void {
  if (ctx.flags.paranormal === false) return;
  let settings = loadSettings();
  const service: ParanormalClientService = {
    settings: () => ({ ...settings }),
    setSettings(p) {
      if (p.mode === 'full' || p.mode === 'subtle') settings = { ...settings, mode: p.mode };
      saveSettings(settings);
    },
  };
  ctx.services.provide('paranormal', service);

  const use = <T,>(name: string): T | undefined => (ctx.services.use as unknown as (n: string) => T | undefined)(name);
  const level = () => use<LevelView>('level');
  let fixMap: { ver: number; list: unknown; map: Map<string, number> } = { ver: -1, list: null, map: new Map() };
  let reduce = reduceFlickerOn();
  let reduceAt = 0;
  const seenQ = new Map<number, boolean>();
  const diag = { active: 0, kinds: [] as string[], sent: 0, synced: 0, errors: 0, lastError: '', model: false, witness: { checks: 0, reports: 0, why: {} as Record<string, string> }, seenLog: [] as { id: number; end: boolean; ok: boolean | null; t: number }[] };
  ctx.diag.paranormal = diag;
  const log = (m: string) => { diag.lastError = m; console.warn(`[paranormal] ${m}`); };

  const env: Env = {
    ctx,
    render: () => use<RenderView>('render'),
    level,
    sfx: () => use<SfxView>('sfx'),
    players: () => use<PlayersView>('players'),
    three: () => ctx.services.use('three'),
    settings: () => settings,
    reduceFlicker: () => {
      const t = performance.now();
      if (t - reduceAt > 2000) { reduceAt = t; reduce = reduceFlickerOn(); }
      return reduce;
    },
    me: () => ctx.world.me ?? ctx.net.me,
    serverNow: () => ctx.world.serverNow(),
    local: (serverMs) => performance.now() + (serverMs - ctx.world.serverNow()),
    seen: (id, end = false) => { seenQ.set(id, (seenQ.get(id) ?? false) || end); },
    synth(kind, pos, opts, fb) {
      const s = env.sfx();
      if (!s) return;
      try {
        const h = s.synth?.(kind, pos ?? undefined, { occlude: true, ...opts });
        if (h) return;
        if (fb) s.play(fb.key, pos ?? undefined, { volume: fb.volume ?? 0.5, rate: fb.rate, occlude: true });
      } catch (e) { log(`sound ${kind}: ${e instanceof Error ? e.message : e}`); }
    },
    fear(v, ms) {
      const k = settings.mode === 'subtle' ? 0.5 : 1;
      try { env.sfx()?.fear?.('paranormal', Math.min(1, v * k), ms); } catch { /* audio locked */ }
    },
    fixtureIndex(id) {
      const lv = level();
      if (!lv) return -1;
      if (fixMap.ver !== lv.version || fixMap.list !== lv.fixtures) {
        const map = new Map<string, number>();
        lv.fixtures.forEach((f, i) => { if (f.id) map.set(f.id, i); });
        fixMap = { ver: lv.version, list: lv.fixtures, map };
      }
      return fixMap.map.get(id) ?? -1;
    },
    log,
  };

  const effects = new Map<number, Effect>();
  const witness = new WitnessTracker(env);
  let needSync = false;
  let syncing = false;
  let attached = false;

  const add = (ev: ParanormalEvent, residue: boolean) => {
    if (!ev || typeof ev.id !== 'number' || effects.has(ev.id)) return;
    const me = env.me();
    if (ev.to && me && !ev.to.includes(me)) return;
    try {
      const e = makeEffect(env, ev, residue);
      if (e) effects.set(ev.id, e);
    } catch (err) {
      diag.errors++;
      log(`${ev.kind}: ${err instanceof Error ? err.message : err}`);
    }
  };

  const clear = () => {
    for (const e of effects.values()) {
      try { e.dispose(); } catch { /* best effort */ }
    }
    effects.clear();
    witness.clear();
    seenQ.clear();
    clearVolumes(env);
  };

  ctx.net.on('paranormal.event', (ev) => {
    if (ctx.world.phase !== 'contract') return;
    add(ev, false);
  });
  ctx.net.on('paranormal.end', (d) => {
    const e = effects.get(d.id);
    if (e) { try { e.end(d.reason); } catch { /* best effort */ } }
  });
  ctx.net.on('paranormal.reveal', (d) => effects.get(d.id)?.reveal?.(d.at));
  ctx.bus.on('net:welcome', () => { needSync = true; });
  ctx.bus.on('world:phase', ({ to }) => {
    if (to !== 'contract') clear();
    else needSync = true;
  });

  /** the level is built for the layout the server talks about */
  const levelReady = (): boolean => {
    const lv = level();
    const L = ctx.world.layout;
    return !!lv?.layout && !!L && lv.layout.hash === L.hash && lv.layout.seed === L.seed && L.kind === 'facility';
  };

  let rebuildHooked = false;
  const hookRebuild = () => {
    if (rebuildHooked) return;
    const lv = level();
    if (!lv?.onRebuild) return;
    rebuildHooked = true;
    lv.onRebuild(() => { clear(); needSync = true; });
  };

  const doSync = async () => {
    syncing = true;
    try {
      const r = await ctx.net.req('paranormal.sync', {}, 5000);
      if (ctx.world.phase !== 'contract') return;
      for (const ev of r.residue) add(ev, true);
      for (const ev of r.active) add(ev, false);
      diag.synced++;
    } catch (e) {
      log(`sync: ${e instanceof Error ? e.message : e}`);
      needSync = true;
    } finally {
      syncing = false;
    }
  };

  /** footprint pool + warm templates live in the scene from the first frame (render's warm set compiles them) */
  const attach = () => {
    if (attached) return;
    const t = ctx.services.use('three');
    if (!t) return;
    attached = true;
    const pool = footprintPool();
    pool.mesh.layers.mask = (1 << 0) | (1 << RENDER_LAYERS.phantom);
    t.scene.add(pool.mesh);
    t.scene.add(warmTemplates(log));
  };

  // test hooks (?test=1): effect list, the flashlight, mirror liveness
  if (ctx.testMode) {
    (window as unknown as { __paranormal?: unknown }).__paranormal = {
      diag: () => JSON.parse(JSON.stringify(diag)) as unknown,
      effects: () => [...effects.values()].map((e) => ({ id: e.ev.id, kind: e.ev.kind, at: e.ev.at })),
      setFlashlight: (on: boolean) => env.players()?.setFlashlight?.(on),
      flashlightOn: () => env.players()?.flashlightOn?.() ?? null,
      mirrors: () => (env.render()?.mirrors?.list() ?? []).map((h) => ({ item: h.itemId, live: h.live() })),
      settings: () => ({ ...settings }),
      levelReady: () => levelReady(),
      contentReady: () => (level() as { contentReady?(): boolean } | undefined)?.contentReady?.() ?? null,
    };
  }

  let seenAcc = 0;
  ctx.registerSystem({
    name: 'paranormal',
    order: PARANORMAL_SYS,
    update(dt) {
      attach();
      hookRebuild();
      diag.model = figures(log).model;
      if (ctx.world.phase !== 'contract') {
        if (effects.size) clear();
        return;
      }
      if (needSync && !syncing && levelReady() && ctx.net.status === 'joined') {
        needSync = false;
        void doSync();
      }
      if (!levelReady()) return;
      const now = ctx.world.serverNow();
      for (const [id, e] of effects) {
        let keep = true;
        try { keep = e.update(now, dt); } catch (err) {
          keep = false;
          diag.errors++;
          log(`${e.ev.kind}: ${err instanceof Error ? (err.stack ?? err.message) : err}`);
        }
        if (!keep) {
          try { e.dispose(); } catch { /* best effort */ }
          effects.delete(id);
        }
      }
      witness.update(dt, effects.values());
      // witness reports: at most 10/s
      seenAcc += dt;
      if (seenQ.size && seenAcc >= 0.1) {
        seenAcc = 0;
        const [id, end] = seenQ.entries().next().value as [number, boolean];
        seenQ.delete(id);
        diag.sent++;
        const rec = { id, end, ok: null as boolean | null, t: Math.round(ctx.world.serverNow()) };
        diag.seenLog.push(rec);
        if (diag.seenLog.length > 24) diag.seenLog.shift();
        void ctx.net.req('paranormal.seen', { id, end }, 4000).then((r) => { rec.ok = r.ok; }, () => { rec.ok = false; });
      }
      diag.active = effects.size;
      diag.kinds = [...effects.values()].map((e) => e.ev.kind);
      diag.witness = witness.stats;
    },
  });
}

