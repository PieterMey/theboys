// Owner: fieldguide (v1.2). The FIELD GUIDE (Company form FG-1): a per-player, permanent monster booklet.
// - Encounters: monsters onMonsterEvent -> PlayerSave.fieldGuide (first contact, heard/seen once per kind per visit, deaths,
//   escapes); the hub kennel Hound counts. 'fieldguide.filed' ('NEW ENTRY: THE HOUND') on first contact.
// - Hazard bulletins: 2/3/4 lore spots per contract (by risk) become kind 'bulletin' interactables; reading one files the
//   next page of its monster the reader lacks (reader only), 'fieldguide.read' + 'fieldguide.filed', stat pagesFiled.
// - Drawer pages: up to drawerPagesMax PAGE_TYPE items stocked into closed containers; a pickup files the page.
// - Footprints: paranormal setLoreTargets(bulletin spots somebody connected still lacks a page from).
// - Anomalies: paranormal onPhenomenon -> anomalies[kind]++ per witness.
// - Van shelf: kind 'fieldguide' on stationOf(L, 'booklet') in hub and contract -> 'fieldguide.open'.
// Page text lives in ./content.ts only and travels only for pages the receiver owns ('fieldguide.state' / 'fieldguide.get').
// Registration runs from the phase hook (installed after interaction, so after its rebuild) AND from this module's own tick
// whenever the phase/layout key changes: the first hub never runs a phase hook (plan check #15).
import type { TrackInstall } from '../core/boot.ts';
import type { Crew, ServerContext, ServerPlayer } from '../core/types.ts';
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import type { MonsterKind } from '@dead-air/shared/state.ts';
import type { FieldGuideSave } from '@dead-air/shared/progress.ts';
import { emptyFieldGuide } from '@dead-air/shared/progress.ts';
import type { FieldGuideBulletinView, FieldGuideView } from '@dead-air/shared/messages/fieldguide.ts';
import type { MonsterEvent } from '@dead-air/shared/messages/monsters.ts';
import type { ItemEvent } from '@dead-air/shared/messages/interaction.ts';
import type { ParanormalKind } from '@dead-air/shared/messages/paranormal.ts';
import { PAGE_TYPE, v12Id } from '@dead-air/shared/catalog.ts';
import { loreSpotsOf } from '@dead-air/shared/procgen/lore.ts';
import type { LoreSpot } from '@dead-air/shared/procgen/lore.ts';
import { containersOf } from '@dead-air/shared/procgen/containers.ts';
import { stationOf } from '@dead-air/shared/procgen/van.ts';
import { normalOfYaw } from '@dead-air/shared/procgen/common.ts';
import { makeRng } from '@dead-air/shared/rng.ts';
import * as IX from '../interaction/api.ts';
import { currentOrder, playerSave, recordStat, shift, updatePlayerSave } from '../meta/api.ts';
import { emitMonsterEvent, monsterPositions, onMonsterEvent } from '../monsters/api.ts';
import { emitPhenomenon, onPhenomenon, setLoreTargets } from '../paranormal/api.ts';
import { clockMin } from '../objectives/api.ts';
import { ANOMALY_KINDS, MONSTERS, MONSTER_ORDER, anomalyLabel, isMonsterKind, pageDef, pageIdsOf, pagesTotalOf, renderPage } from './content.ts';
import {
  assignMonsters, buildView, choosePage, clockText, filePage, mergeInto, monsterOf, nextMissing, ownedPages, pickBulletinSpots,
  pickPageContainers, presentMonsters, recordContact, sanitize,
} from './logic.ts';
import type { ContactHow, SpotLike } from './logic.ts';

const TRACK = 'fieldguide';
/** system order: after meta (90), so a hub layout meta just set is already there */
const ORDER = 95;
const SHELF_PROMPT = 'Field guide';
const BULLETIN_PROMPT = 'Read the hazard bulletin';

interface Bulletin {
  /** interactable id 'lore:<spot id>' */
  id: string;
  spot: string;
  space: number;
  monster: MonsterKind;
  p: [number, number, number];
  /** spot yaw: the frame faces normalOfYaw(rot) */
  rot: number;
  /** pid -> the page this bulletin showed them (null: nothing left to file; shown a page they already own) */
  reads: Map<string, string>;
}
interface Stocked { pageId: string; container: string; monster: MonsterKind; spot: string | null; taken: boolean }

interface FgCrew {
  /** `${phase}|${kind}:${seed}:${hash}` the interactables were built for (null = nothing built) */
  key: string | null;
  /** layout part of key (interaction rebuilds its registry when this changes) */
  lkey: string | null;
  /** encounter scope: bumps whenever the key changes (heard/seen count once per kind per visit) */
  visit: number;
  counted: Set<string>;
  /** escape/death dedupe: key -> server ms */
  recent: Map<string, number>;
  shelf: { id: string; p: [number, number, number]; ref: string } | null;
  bulletins: Map<string, Bulletin>;
  stocked: Stocked[];
  /** layout key the drawer pages were stocked for: a re-place on the same layout (phase bounce, flag toggle) never
   *  stocks a second copy */
  stockedFor: string | null;
  /** spot -> (pid -> page shown), kept while the layout stays (a re-place on the same layout keeps who read what) */
  reads: Map<string, Map<string, string>>;
  /** page item ids already handled (pickup + acquire for the same item never files twice) */
  handled: Set<string>;
  /** page items to delete on the next tick */
  removals: string[];
  present: MonsterKind[];
  /** contract ticks left to confirm 'present' against the monsters that actually started (0 = done) */
  presenceChecks: number;
  /** per layout (kept across a same-site re-place): the monsters on site, confirmed against the started ones, and the
   *  monster each bulletin spot carries */
  sitePresent: MonsterKind[] | null;
  presenceVerified: boolean;
  assigned: Map<string, MonsterKind>;
  dirty: Set<string>;
  targetsKey: string;
  ticks: number;
  /** dev/test only (dbg.fieldguide.fakeSpots): synthetic wall spots while loreSpotsOf is still the contract stub */
  fake: SpotLike[] | null;
}

type Spot = SpotLike & { p: [number, number, number]; rot?: number; container?: string };

const crews = new WeakMap<Crew, FgCrew>();
function S(crew: Crew): FgCrew {
  let st = crews.get(crew);
  if (!st) {
    st = {
      key: null, lkey: null, visit: 0, counted: new Set(), recent: new Map(), shelf: null, bulletins: new Map(), stocked: [], stockedFor: null, reads: new Map(), handled: new Set(),
      removals: [], present: [], presenceChecks: 0, sitePresent: null, presenceVerified: false, assigned: new Map(), dirty: new Set(), targetsKey: '', ticks: 0, fake: null,
    };
    crews.set(crew, st);
  }
  return st;
}

/** same identity interaction's registry uses (engine.ts layoutKey) */
const layoutKeyOf = (L: LevelLayout | null): string | null => (L ? `${L.kind}:${L.seed}:${L.hash}` : null);

export const install: TrackInstall = (ctx: ServerContext) => {
  const log = ctx.log(TRACK);
  const enabled = (): boolean => ctx.flags.fieldGuide !== false;
  const v12 = (): boolean => ctx.flags.listenerFairV12 !== false;
  const fb = (): Record<string, unknown> => (ctx.balance.fieldguide as Record<string, unknown> | undefined) ?? {};
  const num = (k: string, d: number): number => {
    const v = fb()[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : d;
  };
  const safe = <T>(what: string, f: () => T, d: T): T => {
    try {
      return f();
    } catch (e) {
      log.warn(`${what} failed:`, e instanceof Error ? e.message : e);
      return d;
    }
  };

  // ---------------------------------------------------------------- saves

  /** in-memory booklet for a player meta has no save for (tests without meta, or before meta attached them) */
  const fallback = (pl: ServerPlayer, create: boolean): FieldGuideSave | null => {
    const cur = pl.slices[TRACK] as FieldGuideSave | undefined;
    if (cur || !create) return cur ?? null;
    const fresh = emptyFieldGuide();
    pl.slices[TRACK] = fresh;
    return fresh;
  };
  const readSave = (crew: Crew, pid: string): FieldGuideSave => {
    const pl = crew.players.get(pid);
    const sv = safe('playerSave', () => playerSave(crew, pid), null);
    if (sv) {
      const fg = sanitize(sv.fieldGuide);
      const extra = pl ? fallback(pl, false) : null;
      if (!extra) return fg;
      const copy = sanitize(JSON.parse(JSON.stringify(fg)));
      mergeInto(copy, extra);
      return copy;
    }
    return (pl && fallback(pl, false)) ?? emptyFieldGuide();
  };
  /** mutate pid's booklet (persisted through meta's debounced save; in-memory fallback without a save) */
  const withSave = (crew: Crew, pid: string, fn: (fg: FieldGuideSave) => void): void => {
    const pl = crew.players.get(pid);
    if (!pl) return;
    const ok = safe('updatePlayerSave', () => updatePlayerSave(crew, pid, (sv) => {
      const fg = (sv.fieldGuide = sanitize(sv.fieldGuide));
      const extra = fallback(pl, false);
      if (extra) {
        mergeInto(fg, extra);
        delete pl.slices[TRACK];
      }
      fn(fg);
    }), false);
    if (!ok) fn(fallback(pl, true)!);
  };
  const connectedIds = (crew: Crew): string[] => [...crew.players.values()].filter((p) => p.connected).map((p) => p.id);
  const connectedSaves = (crew: Crew): FieldGuideSave[] => connectedIds(crew).map((pid) => readSave(crew, pid));

  // ---------------------------------------------------------------- views + events

  const bulletinViews = (crew: Crew, st: FgCrew, pid: string, save: FieldGuideSave): FieldGuideBulletinView[] | undefined => {
    if (crew.phase !== 'contract' || !st.bulletins.size) return undefined;
    return [...st.bulletins.values()].map((b) => ({
      spot: b.spot, monster: b.monster, name: MONSTERS[b.monster].name, read: b.reads.has(pid) || nextMissing(save, b.monster) === null,
    }));
  };
  const viewFor = (crew: Crew, pid: string): FieldGuideView => {
    const save = readSave(crew, pid);
    return buildView(save, { balance: ctx.balance, v12: v12(), bulletins: bulletinViews(crew, S(crew), pid, save) });
  };
  const sendState = (crew: Crew, pid: string): void => {
    const pl = crew.players.get(pid);
    if (!pl?.connected) return;
    ctx.emit(crew, 'fieldguide.state', viewFor(crew, pid), { to: [pid] });
  };
  const markDirty = (crew: Crew, pid: string): void => { S(crew).dirty.add(pid); };
  const flushDirty = (crew: Crew, st: FgCrew): void => {
    if (!st.dirty.size) return;
    const ids = [...st.dirty];
    st.dirty.clear();
    for (const pid of ids) sendState(crew, pid);
  };
  const site = (crew: Crew): string => safe('currentOrder', () => currentOrder(crew)?.siteName, undefined) ?? 'THE LOT';
  /** contract clock ('23:41') on site; the host's wall clock in the van lot (no contract clock runs there) */
  const stamp = (crew: Crew): string => {
    const m = safe('clockMin', () => clockMin(crew), -1);
    if (m >= 0) return clockText(m);
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const stat = (crew: Crew, pid: string, key: string, n = 1): void => { safe('recordStat', () => recordStat(crew, pid, key, n), undefined); };

  // ---------------------------------------------------------------- footprints

  const updateTargets = (crew: Crew, st: FgCrew): void => {
    let ids: string[] = [];
    if (enabled() && crew.phase === 'contract') {
      const pids = connectedIds(crew);
      const saves = new Map(pids.map((pid) => [pid, readSave(crew, pid)]));
      const lacks = (monster: MonsterKind, reads?: Map<string, string>) =>
        pids.some((pid) => !reads?.has(pid) && nextMissing(saves.get(pid)!, monster) !== null);
      for (const b of st.bulletins.values()) if (lacks(b.monster, b.reads)) ids.push(b.spot);
      for (const s of st.stocked) if (s.spot && !s.taken && pids.some((pid) => !saves.get(pid)!.pages.includes(s.pageId))) ids.push(s.spot);
      ids = [...new Set(ids)];
    }
    const key = ids.join(',');
    if (key === st.targetsKey) return;
    st.targetsKey = key;
    safe('setLoreTargets', () => setLoreTargets(crew, ids), undefined);
  };

  // ---------------------------------------------------------------- placement

  const spotsOf = (L: LevelLayout, st: FgCrew): Spot[] => {
    if (st.fake) return st.fake as Spot[];
    return safe('loreSpotsOf', () => loreSpotsOf(L), [] as readonly LoreSpot[]).map((s) => ({ ...s }));
  };
  /** the risk the site was generated for (same source interaction uses); the work order's risk as a fallback */
  const riskOf = (crew: Crew, L: LevelLayout): number => {
    const m = Number(L.metrics?.risk);
    const r = Number.isFinite(m) && m > 0 ? m : safe('currentOrder', () => currentOrder(crew)?.risk, undefined) ?? 1;
    return Math.max(1, Math.min(3, Math.round(Number(r) || 1)));
  };
  const contractIndexOf = (crew: Crew): number => safe('shift', () => shift(crew).contract, 0) || 0;

  const registerShelf = (crew: Crew, L: LevelLayout, st: FgCrew): void => {
    const s = safe('stationOf', () => stationOf(L, 'booklet'), null);
    if (!s) { st.shelf = null; return; }
    st.shelf = { id: v12Id('fieldguide', s.itemId), p: [s.p[0], s.p[1], s.p[2]], ref: s.itemId };
    IX.registerInteractables(crew, [{ id: st.shelf.id, kind: 'fieldguide', p: st.shelf.p, prompt: SHELF_PROMPT, enabled: true, r: 0.35, ref: st.shelf.ref }]);
  };
  const registerBulletins = (crew: Crew, list: Iterable<Bulletin>): void => {
    IX.registerInteractables(crew, [...list].map((b) => ({ id: b.id, kind: 'bulletin', p: b.p, prompt: BULLETIN_PROMPT, enabled: true, r: 0.6, ref: b.spot })));
  };

  const placeContract = (crew: Crew, L: LevelLayout, st: FgCrew): void => {
    const risk = riskOf(crew, L);
    const byRisk = fb().bulletinsByRisk;
    const count = Array.isArray(byRisk) && typeof byRisk[risk - 1] === 'number' ? Math.max(0, Math.round(byRisk[risk - 1] as number)) : risk + 1;
    st.sitePresent ??= presentMonsters({
      risk, contractIndex: contractIndexOf(crew), hasVents: L.items.some((i) => i.kind === 'vent'),
      mannequin: ctx.flags.mannequin !== false, snatcher: ctx.flags.snatcher !== false, balance: ctx.balance,
    });
    st.present = st.sitePresent.slice();
    const spots = spotsOf(L, st);
    const saves = connectedSaves(crew);
    // bulletins: placement depends only on the layout and crew code; the monster each one carries on the crew's booklets
    const chosen = pickBulletinSpots(L, spots, makeRng(`${L.seed}|${crew.code}`, 'fieldguide.bulletins'), count, num('minDepthFrac', 0.35));
    // a spot keeps its monster for the whole site (a re-place on the same layout restores it); new spots get one
    const need = chosen.filter((s) => !st.present.includes(st.assigned.get(s.id) as MonsterKind));
    const fresh = assignMonsters(st.present, saves, need.length, makeRng(`${L.seed}|${crew.code}`, 'fieldguide.assign'));
    need.forEach((s, i) => st.assigned.set(s.id, fresh[i]!));
    const monsters = chosen.map((s) => st.assigned.get(s.id)!);
    chosen.forEach((s, i) => {
      const id = v12Id('bulletin', s.id);
      let reads = st.reads.get(s.id);
      if (!reads) st.reads.set(s.id, (reads = new Map()));
      st.bulletins.set(id, { id, spot: s.id, space: s.space, monster: monsters[i]!, p: [s.p[0], s.p[1], s.p[2]], rot: Number(s.rot ?? 0) || 0, reads });
    });
    if (st.bulletins.size) registerBulletins(crew, st.bulletins.values());
    st.presenceChecks = st.presenceVerified ? 0 : 300; // monsters start right after the phase change: confirm within ~10 s
    // drawer pages: drawer lore spots, else any container
    const max = Math.max(0, Math.round(num('drawerPagesMax', 2)));
    if (max > 0 && st.stockedFor !== st.lkey) {
      st.stockedFor = st.lkey;
      const drawers = spots.filter((s) => s.style === 'drawer' && typeof s.container === 'string')
        .map((s) => ({ ...s, id: s.container!, spot: s.id as string | null }));
      const pool = drawers.length ? drawers : safe('containersOf', () => containersOf(L), []).map((c) => ({
        id: c.id, style: 'container', space: c.space, roomType: c.roomType, x: c.x, z: c.z, spot: null as string | null,
      }));
      const rng = makeRng(`${L.seed}|${crew.code}`, 'fieldguide.pages');
      const used = new Set<string>();
      for (const c of pickPageContainers(L, pool, rng, pool.length)) {
        if (st.stocked.length >= max) break;
        const pageId = choosePage(st.present, saves, used, rng);
        if (!pageId) break;
        if (!safe('stockContainer', () => IX.stockContainer(crew, c.id, { type: PAGE_TYPE, name: pageId }), false)) continue;
        used.add(pageId);
        st.stocked.push({ pageId, container: c.id, monster: pageDef(pageId)!.monster, spot: c.spot, taken: false });
      }
    }
    log.info(`${crew.code}: ${st.bulletins.size} bulletin(s) [${[...st.bulletins.values()].map((b) => `${b.spot}=${b.monster}`).join(', ')}], `
      + `${st.stocked.length} drawer page(s) [${st.stocked.map((s) => `${s.pageId}@${s.container}`).join(', ')}], present ${st.present.join('/')}`
      + `${spots.length ? '' : ' (no lore spots on this layout)'}`);
  };

  const removeMine = (crew: Crew, st: FgCrew): void => {
    for (const b of st.bulletins.values()) safe('removeInteractable', () => IX.removeInteractable(crew, b.id), undefined);
    if (st.shelf) safe('removeInteractable', () => IX.removeInteractable(crew, st.shelf!.id), undefined);
  };

  /** (re)build for the current phase + layout; cheap no-op while the key is unchanged */
  const ensure = (crew: Crew): FgCrew => {
    const st = S(crew);
    const lkey = enabled() ? layoutKeyOf(crew.layout) : null;
    const key = lkey === null ? null : `${crew.phase}|${lkey}`;
    if (st.key === key) return st;
    const wasContract = st.bulletins.size > 0;
    // same layout, new phase (contract -> results, hub -> drive) or switched off: take ours out of interaction's registry.
    // A new layout needs nothing: interaction's rebuild already wiped it.
    if (st.key !== null && (key === null || st.lkey === lkey)) removeMine(crew, st);
    if (st.lkey !== lkey && lkey !== null) {
      // a new site: drawer pages, reads and handled page items belong to the old one
      st.stocked = [];
      st.stockedFor = null;
      st.reads.clear();
      st.handled.clear();
      st.sitePresent = null;
      st.presenceVerified = false;
      st.assigned.clear();
    }
    st.key = key;
    if (lkey !== null) st.lkey = lkey;
    st.visit++;
    st.counted.clear();
    st.recent.clear();
    st.shelf = null;
    st.bulletins.clear();
    st.present = [];
    st.presenceChecks = 0;
    const L = crew.layout;
    if (key !== null && L) {
      safe('shelf', () => registerShelf(crew, L, st), undefined);
      if (crew.phase === 'contract' && L.kind === 'facility') safe('placement', () => placeContract(crew, L, st), undefined);
    }
    if (wasContract || st.bulletins.size) for (const pid of connectedIds(crew)) st.dirty.add(pid);
    updateTargets(crew, st);
    return st;
  };

  /** interaction may rebuild its registry under us (e.g. a dbg relayout to the same key): put ours back */
  const verify = (crew: Crew, st: FgCrew): void => {
    const ints = safe('IX.state', () => IX.state(crew).ints, {} as Record<string, unknown>);
    if (st.shelf && !ints[st.shelf.id]) {
      IX.registerInteractables(crew, [{ id: st.shelf.id, kind: 'fieldguide', p: st.shelf.p, prompt: SHELF_PROMPT, enabled: true, r: 0.35, ref: st.shelf.ref }]);
    }
    const missing = [...st.bulletins.values()].filter((b) => !ints[b.id]);
    if (missing.length) registerBulletins(crew, missing);
  };

  /** monsters start after the phase hook: once they run, a bulletin about a monster that did not start (a Snatcher
   *  without usable vents, a dbg contract on another risk) is reassigned to one that did */
  const verifyPresence = (crew: Crew, st: FgCrew): void => {
    if (st.presenceChecks <= 0) return;
    st.presenceChecks--;
    // the hub kennel runtime can still answer for a moment after a relayout: only contract agents count
    const kinds = new Set(safe('monsterPositions', () => monsterPositions(crew), []).filter((m) => m.id !== 'kennel').map((m) => m.kind));
    if (!kinds.size) return;
    st.presenceChecks = 0;
    st.presenceVerified = true;
    const actual = MONSTER_ORDER.filter((k) => kinds.has(k));
    if (!actual.length || actual.join() === st.present.join()) return;
    st.present = actual;
    st.sitePresent = actual.slice();
    const wrong = [...st.bulletins.values()].filter((b) => !actual.includes(b.monster));
    if (!wrong.length) return;
    const L = crew.layout;
    const again = assignMonsters(actual, connectedSaves(crew), wrong.length, makeRng(`${L?.seed ?? ''}|${crew.code}`, 'fieldguide.reassign'));
    wrong.forEach((b, i) => { b.monster = again[i]!; st.assigned.set(b.spot, b.monster); b.reads.clear(); });
    log.info(`${crew.code}: monsters on site ${actual.join('/')}: bulletin(s) ${wrong.map((b) => `${b.spot}=${b.monster}`).join(', ')} reassigned`);
    for (const pid of connectedIds(crew)) st.dirty.add(pid);
    updateTargets(crew, st);
  };

  // ---------------------------------------------------------------- filing

  /** file `pageId` (or, if pid already owns it, the next page of that monster they lack) for pid; null = nothing new */
  const fileFor = (crew: Crew, pid: string, pageId: string | null, monster: MonsterKind): string | null => {
    let filed: string | null = null;
    withSave(crew, pid, (fg) => {
      const want = pageId && !fg.pages.includes(pageId) ? pageId : nextMissing(fg, monster);
      if (want && filePage(fg, want)) filed = want;
    });
    if (!filed) return null;
    const save = readSave(crew, pid);
    const def = pageDef(filed)!;
    stat(crew, pid, 'pagesFiled', 1);
    ctx.emit(crew, 'fieldguide.filed', {
      kind: monster, pageId: filed, title: renderPage(def, ctx.balance, v12()).title, n: ownedPages(save, monster).length, of: pagesTotalOf(monster),
      name: MONSTERS[monster].name,
    }, { to: [pid] });
    markDirty(crew, pid);
    return filed;
  };

  const readBulletin = (crew: Crew, player: ServerPlayer, b: Bulletin): void => {
    const pid = player.id;
    const st = S(crew);
    let shown = b.reads.get(pid) ?? null;
    let filed = false;
    if (shown === null) {
      const got = fileFor(crew, pid, null, b.monster);
      filed = !!got;
      // nothing left to file (they own every page of it): show one of them again, stable per bulletin
      const ids = pageIdsOf(b.monster);
      shown = got ?? ids[Math.abs(hashStr(b.spot)) % ids.length]!;
      b.reads.set(pid, shown);
    }
    const def = pageDef(shown)!;
    const page = renderPage(def, ctx.balance, v12());
    const save = readSave(crew, pid);
    ctx.emit(crew, 'fieldguide.read', {
      spot: b.spot, monster: b.monster, title: page.title, text: page.text, pageId: shown, filed,
      n: ownedPages(save, b.monster).length, of: pagesTotalOf(b.monster), name: MONSTERS[b.monster].name,
    }, { to: [pid] });
    markDirty(crew, pid);
    updateTargets(crew, st);
  };

  // ---------------------------------------------------------------- encounters

  const onMonster = (crew: Crew, e: MonsterEvent): void => {
    if (!enabled() || !e || !isMonsterKind(e.monster)) return;
    const pid = typeof e.victim === 'string' ? e.victim : e.event === 'flinch' && typeof e.by === 'string' ? e.by : null;
    if (!pid || !crew.players.has(pid)) return;
    const st = ensure(crew);
    let how: ContactHow;
    let heard = false, seen = false, death = false, escape = false;
    switch (e.event) {
      case 'heard': case 'notice': case 'alert': case 'charge': how = 'heard'; heard = true; break;
      case 'seen': case 'flinch': how = 'seen'; seen = true; break;
      case 'grab': case 'snatch': how = 'grabbed'; seen = true; break;
      case 'knockdown': case 'freed': case 'escaped': case 'rescued': how = 'grabbed'; seen = true; escape = true; break;
      case 'kill': how = 'killed'; seen = true; death = true; break;
      default: return; // 'wake' has no player
    }
    const kind = e.monster;
    const once = (what: string): boolean => {
      const k = `${pid}|${kind}|${what}`;
      if (st.counted.has(k)) return false;
      st.counted.add(k);
      return true;
    };
    // the same event repeated for the same monster within encounterDedupSec counts once (a knockdown and a later
    // escape from a second grab are different events and both count)
    const t = ctx.now();
    const recently = (): boolean => {
      const k = `${pid}|${e.id}|${e.event}`;
      const last = st.recent.get(k);
      if (last !== undefined && t - last < num('encounterDedupSec', 30) * 1000) return true;
      st.recent.set(k, t);
      return false;
    };
    const countHeard = heard && once('heard');
    const countSeen = seen && once('seen');
    const dup = (death || escape) && recently();
    const countDeath = death && !dup;
    const countEscape = escape && !dup;
    // nothing new (already counted this visit, contact on file): no save write
    if (!countHeard && !countSeen && !countDeath && !countEscape && readSave(crew, pid).monsters[kind]?.first) return;
    let first = false;
    const at = stamp(crew);
    const where = site(crew);
    withSave(crew, pid, (fg) => {
      const m = monsterOf(fg, kind);
      if (countHeard) m.heard++;
      if (countSeen) m.seen++;
      if (countDeath) m.deaths++;
      if (countEscape) m.escapes++;
      first = recordContact(fg, kind, how, at, where);
    });
    if (first) {
      const save = readSave(crew, pid);
      ctx.emit(crew, 'fieldguide.filed', {
        kind, title: `NEW ENTRY: ${MONSTERS[kind].name}`, n: ownedPages(save, kind).length, of: pagesTotalOf(kind), name: MONSTERS[kind].name,
      }, { to: [pid] });
      log.info(`${crew.code}: ${crew.players.get(pid)?.name ?? pid} first contact with ${kind} (${how}) at ${where} ${at}`);
    }
    if (first || countHeard || countSeen || countDeath || countEscape) markDirty(crew, pid);
  };

  // ---------------------------------------------------------------- wiring

  ctx.registerSystem({
    name: TRACK,
    order: ORDER,
    tick(_dt, crew) {
      const st = ensure(crew);
      if (st.removals.length) {
        const ids = st.removals.splice(0);
        for (const id of ids) safe('removeItem', () => IX.removeItem(crew, id), undefined);
      }
      if (st.key !== null && ++st.ticks % 30 === 0) verify(crew, st);
      if (st.presenceChecks > 0) verifyPresence(crew, st);
      flushDirty(crew, st);
    },
  });

  ctx.hooks.phase.push(function fieldguidePhase(crew) {
    ensure(crew);
  });
  ctx.hooks.join.push(function fieldguideJoin(crew, player) {
    // sent from the tick: an event emitted inside the join hook would reach the client before its welcome
    markDirty(crew, player.id);
    updateTargets(crew, S(crew));
  });
  ctx.hooks.leave.push(function fieldguideLeave(crew) {
    updateTargets(crew, S(crew));
  });

  IX.onInteract('fieldguide', (crew, player) => {
    if (!enabled()) return false;
    ctx.emit(crew, 'fieldguide.open', {}, { to: [player.id] });
    sendState(crew, player.id);
    return true;
  });
  IX.onInteract('bulletin', (crew, player, targetId) => {
    if (!enabled()) return false;
    const b = ensure(crew).bulletins.get(targetId);
    if (!b) return false;
    readBulletin(crew, player, b);
    return true;
  });

  onMonsterEvent((crew, e) => onMonster(crew, e));

  IX.onItemEvent((crew, e: ItemEvent) => {
    if (!enabled() || e.type !== PAGE_TYPE || (e.kind !== 'pickup' && e.kind !== 'acquire')) return;
    const st = ensure(crew);
    if (st.handled.has(e.id)) return;
    st.handled.add(e.id);
    const named = typeof e.name === 'string' ? pageDef(e.name) : null;
    const stocked = st.stocked.find((s) => s.pageId === e.name && !s.taken);
    if (stocked) stocked.taken = true;
    const monster: MonsterKind = named?.monster ?? st.present[0] ?? 'hound';
    const got = crew.players.has(e.pid) ? fileFor(crew, e.pid, named?.id ?? null, monster) : null;
    if (!got && crew.players.has(e.pid)) {
      ctx.emit(crew, 'notice', { text: `Field note: ${MONSTERS[monster].name}. Already in your field guide.`, kind: 'info' }, { to: [e.pid] });
    }
    st.removals.push(e.id);
    updateTargets(crew, st);
  });

  onPhenomenon((crew, rec) => {
    if (!enabled() || !rec) return;
    const kind = String(rec.kind);
    for (const pid of new Set(rec.witnesses ?? [])) {
      if (!crew.players.has(pid)) continue;
      let first = false;
      let kinds = 0;
      withSave(crew, pid, (fg) => {
        first = !(fg.anomalies[kind] > 0);
        fg.anomalies[kind] = (fg.anomalies[kind] ?? 0) + 1;
        kinds = Object.keys(fg.anomalies).filter((k) => fg.anomalies[k]! > 0).length;
      });
      if (first) {
        ctx.emit(crew, 'fieldguide.filed', { kind: 'anomaly', title: `NEW ENTRY: ${anomalyLabel(kind)}`, n: kinds, of: ANOMALY_KINDS.length, name: anomalyLabel(kind) }, { to: [pid] });
      }
      markDirty(crew, pid);
    }
  });

  ctx.registerReq('fieldguide.get', (crew, player) => viewFor(crew, player.id));

  // ---------------------------------------------------------------- dev-only test hooks (dbg.fieldguide.*)

  type Args = Record<string, unknown> | null | undefined;
  const target = (crew: Crew, me: ServerPlayer, pid: unknown): ServerPlayer => (typeof pid === 'string' ? crew.players.get(pid) : undefined) ?? me;
  ctx.registerDbg('fieldguide.state', (crew, player, args) => {
    const st = ensure(crew);
    const pl = target(crew, player, (args as Args)?.pid);
    return {
      enabled: enabled(), key: st.key, visit: st.visit, present: st.present, shelf: st.shelf,
      bulletins: [...st.bulletins.values()].map((b) => {
        const [nx, nz] = normalOfYaw(b.rot);
        return { id: b.id, spot: b.spot, space: b.space, monster: b.monster, p: b.p, front: [b.p[0] + nx * 0.9, b.p[2] + nz * 0.9], reads: Object.fromEntries(b.reads) };
      }),
      stocked: st.stocked, targets: st.targetsKey ? st.targetsKey.split(',') : [], fake: !!st.fake,
      save: readSave(crew, pl.id), persisted: !!safe('playerSave', () => playerSave(crew, pl.id), null),
    };
  });
  ctx.registerDbg('fieldguide.event', (crew, player, args) => {
    const a = (args ?? {}) as Partial<MonsterEvent>;
    const ev: MonsterEvent = {
      monster: (isMonsterKind(a.monster) ? a.monster : 'hound') as MonsterEvent['monster'], id: String(a.id ?? `${a.monster ?? 'hound'}0`),
      event: (a.event ?? 'seen') as MonsterEvent['event'], victim: a.victim ?? player.id, at: ctx.now(), ...(a.by ? { by: a.by } : {}),
    };
    emitMonsterEvent(crew, ev);
    return { ok: true, ev };
  });
  ctx.registerDbg('fieldguide.phenomenon', (crew, player, args) => {
    const a = (args ?? {}) as { kind?: string; witnesses?: string[] };
    emitPhenomenon(crew, {
      id: Math.floor(ctx.now()) % 1e6, kind: (a.kind ?? 'cold_spot') as ParanormalKind, tier: 0, t: 0, space: -1, target: null,
      witnesses: Array.isArray(a.witnesses) ? a.witnesses : [player.id], tell: false,
    });
    return { ok: true };
  });
  ctx.registerDbg('fieldguide.fakeSpots', (crew, _player, args) => {
    const st = S(crew);
    const L = crew.layout;
    const on = (args as Args)?.on !== false;
    st.fake = on && L ? fakeSpots(L) : null;
    removeMine(crew, st);
    st.key = null; // force a re-place on the next ensure (same layout: drawer pages are not stocked twice)
    st.bulletins.clear();
    ensure(crew);
    return { ok: true, spots: st.fake?.length ?? 0, bulletins: [...st.bulletins.values()].map((b) => ({ id: b.id, spot: b.spot, monster: b.monster, p: b.p })) };
  });
  ctx.registerDbg('fieldguide.spawnPage', (crew, player, args) => {
    const a = (args ?? {}) as { pageId?: string; x?: number; z?: number };
    const it = IX.spawnItem(crew, PAGE_TYPE, [Number(a.x ?? player.pose.p[0]), 0.05, Number(a.z ?? player.pose.p[2])], { name: String(a.pageId ?? 'hound.1') });
    IX.flushNow(crew);
    return it;
  });
  ctx.registerDbg('fieldguide.pickup', (crew, player, args) => {
    // simulate interaction's v1.2 pickup ItemEvent (G3) for a page item
    const a = (args ?? {}) as { itemId?: string; pageId?: string; pid?: string };
    const pl = target(crew, player, a.pid);
    const id = String(a.itemId ?? `fake-page-${Math.floor(ctx.now())}`);
    IX.emitItemEvent(crew, { kind: 'pickup', pid: pl.id, type: PAGE_TYPE, id, name: String(a.pageId ?? 'hound.1'), fresh: true });
    return { ok: true, id };
  });
  ctx.registerDbg('fieldguide.file', (crew, player, args) => {
    // file one page directly (screenshots / tests): same path as a bulletin or drawer page
    const a = (args ?? {}) as { pageId?: string; pid?: string };
    const def = pageDef(String(a.pageId ?? ''));
    if (!def) return { ok: false, reason: 'unknown page id' };
    const pl = target(crew, player, a.pid);
    return { ok: true, filed: fileFor(crew, pl.id, def.id, def.monster) };
  });
  ctx.registerDbg('fieldguide.flag', (crew, _player, args) => {
    // dev/test only: flip flags.fieldGuide in this process (production reads config/flags.json); the tick tears down / rebuilds
    ctx.flags.fieldGuide = (args as Args)?.on !== false;
    ensure(crew);
    return { fieldGuide: ctx.flags.fieldGuide };
  });
  ctx.registerDbg('fieldguide.reset', (crew, player, args) => {
    const pl = target(crew, player, (args as Args)?.pid);
    withSave(crew, pl.id, (fg) => {
      fg.monsters = {};
      fg.pages = [];
      fg.anomalies = {};
    });
    delete pl.slices[TRACK];
    markDirty(crew, pl.id);
    return { ok: true };
  });

  log.info(`installed (flag fieldGuide=${enabled()}, ${pageIdsOf('hound').length + pageIdsOf('listener').length + pageIdsOf('mannequin').length + pageIdsOf('snatcher').length} pages)`);
};

/** stable small hash for picking a page to show on a repeat read */
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h | 0;
}

/** dev/test: one synthetic wall spot per room (not the entrance) at the room's north wall, while loreSpotsOf is a stub */
function fakeSpots(L: LevelLayout): SpotLike[] {
  const out: (SpotLike & { idx: number; y: number; rot: number; p: [number, number, number] })[] = [];
  let idx = 0;
  for (const s of L.spaces) {
    if (s.kind !== 'room' || s.id === L.entrance || s.type === 'lobby' || s.type === 'vault' || s.rect.w < 2 || s.rect.h < 2) continue;
    const x = s.rect.x + s.rect.w / 2;
    const z = s.rect.y + 0.4;
    out.push({ id: `fake:${s.id}`, idx: idx++, style: 'board', space: s.id, roomType: s.type, x, y: 1.5, z, rot: 0, p: [x, 1.5, z] });
  }
  return out;
}
