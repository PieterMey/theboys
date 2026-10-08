// Owner: fieldguide (v1.2). Pure helpers (no ctx, no I/O): FieldGuideSave mutations, the private view, which monsters
// are present on a contract, hazard-bulletin placement and the monster/page each bulletin or drawer page carries.
// Unit-tested in tests/fieldguide/logic.test.ts.
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import type { MonsterKind } from '@dead-air/shared/state.ts';
import type { FieldGuideMonster, FieldGuideSave } from '@dead-air/shared/progress.ts';
import { emptyFieldGuide } from '@dead-air/shared/progress.ts';
import type { FieldGuideBulletinView, FieldGuideMonsterView, FieldGuideView } from '@dead-air/shared/messages/fieldguide.ts';
import type { Rng } from '@dead-air/shared/rng.ts';
import {
  ANOMALY_KINDS, MONSTERS, MONSTER_ORDER, PAGES, anomalyLabel, isMonsterKind, pageDef, pageIdsOf, pagesTotalOf, renderCard, renderPage,
} from './content.ts';
import type { BalanceLike } from './content.ts';

export type ContactHow = 'heard' | 'seen' | 'grabbed' | 'killed';

const finite = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/** a well-formed FieldGuideSave from whatever a save file holds (older builds, hand edits). Reuses `raw` when valid. */
export function sanitize(raw: unknown): FieldGuideSave {
  if (!raw || typeof raw !== 'object') return emptyFieldGuide();
  const r = raw as Partial<FieldGuideSave>;
  const out = r as FieldGuideSave;
  out.v = 1;
  if (!r.monsters || typeof r.monsters !== 'object') out.monsters = {};
  for (const k of Object.keys(out.monsters)) {
    const m = (out.monsters as Record<string, FieldGuideMonster | undefined>)[k];
    if (!isMonsterKind(k) || !m || typeof m !== 'object') { delete (out.monsters as Record<string, unknown>)[k]; continue; }
    m.heard = finite(m.heard); m.seen = finite(m.seen); m.deaths = finite(m.deaths); m.escapes = finite(m.escapes);
    if (m.first && (typeof m.first !== 'object' || typeof m.first.at !== 'string' || typeof m.first.site !== 'string')) delete m.first;
  }
  const pages = Array.isArray(r.pages) ? r.pages.filter((p): p is string => typeof p === 'string' && !!pageDef(p)) : [];
  out.pages = [...new Set(pages)];
  const an: Record<string, number> = {};
  if (r.anomalies && typeof r.anomalies === 'object') for (const [k, n] of Object.entries(r.anomalies)) if (finite(n) > 0) an[k] = finite(n);
  out.anomalies = an;
  return out;
}

/** merge `src` (an in-memory fallback booklet) into `dst` */
export function mergeInto(dst: FieldGuideSave, src: FieldGuideSave): void {
  for (const k of MONSTER_ORDER) {
    const s = src.monsters[k];
    if (!s) continue;
    const d = monsterOf(dst, k);
    if (!d.first && s.first) d.first = { ...s.first };
    d.heard += s.heard; d.seen += s.seen; d.deaths += s.deaths; d.escapes += s.escapes;
  }
  for (const p of src.pages) if (!dst.pages.includes(p)) dst.pages.push(p);
  for (const [k, n] of Object.entries(src.anomalies)) dst.anomalies[k] = (dst.anomalies[k] ?? 0) + n;
}

export function monsterOf(save: FieldGuideSave, kind: MonsterKind): FieldGuideMonster {
  return (save.monsters[kind] ??= { heard: 0, seen: 0, deaths: 0, escapes: 0 });
}

/** 0 unknown, 1 heard only, 2 seen (any grab, escape or death counts as seen) */
export function levelOf(m: FieldGuideMonster | undefined): 0 | 1 | 2 {
  if (!m) return 0;
  const how = m.first?.how;
  if (m.seen > 0 || m.deaths > 0 || m.escapes > 0 || how === 'seen' || how === 'grabbed' || how === 'killed') return 2;
  if (m.heard > 0 || how === 'heard') return 1;
  return 0;
}

/** first contact; true when this call filed it */
export function recordContact(save: FieldGuideSave, kind: MonsterKind, how: ContactHow, at: string, site: string): boolean {
  const m = monsterOf(save, kind);
  if (m.first) return false;
  m.first = { at, site, how };
  return true;
}

export function ownedPages(save: FieldGuideSave, kind: MonsterKind): string[] {
  return pageIdsOf(kind).filter((id) => save.pages.includes(id));
}
export function nextMissing(save: FieldGuideSave, kind: MonsterKind): string | null {
  return pageIdsOf(kind).find((id) => !save.pages.includes(id)) ?? null;
}
/** true when the page was not in the booklet before */
export function filePage(save: FieldGuideSave, pageId: string): boolean {
  if (!pageDef(pageId) || save.pages.includes(pageId)) return false;
  save.pages.push(pageId);
  return true;
}

export interface ViewOpts {
  balance: BalanceLike;
  /** flags.listenerFairV12 */
  v12: boolean;
  bulletins?: FieldGuideBulletinView[];
}

/** the private 'fieldguide.state' payload: page text only for owned pages, the card only once seen */
export function buildView(save: FieldGuideSave, o: ViewOpts): FieldGuideView {
  const monsters: FieldGuideMonsterView[] = MONSTER_ORDER.map((kind) => {
    const m = save.monsters[kind];
    const level = levelOf(m);
    const owned = ownedPages(save, kind);
    const v: FieldGuideMonsterView = {
      kind,
      level,
      name: level > 0 || owned.length > 0 ? MONSTERS[kind].name : '???',
      card: level === 2 ? renderCard(kind, o.balance, o.v12) : [],
      sounds: level >= 1 ? MONSTERS[kind].sounds.slice() : [],
      heard: m?.heard ?? 0, seen: m?.seen ?? 0, deaths: m?.deaths ?? 0, escapes: m?.escapes ?? 0,
      pages: owned.map((id) => renderPage(pageDef(id)!, o.balance, o.v12)),
      pagesTotal: pagesTotalOf(kind),
    };
    if (m?.first) v.first = { at: m.first.at, site: m.first.site, how: m.first.how };
    return v;
  });
  const rank = (k: string) => { const i = (ANOMALY_KINDS as readonly string[]).indexOf(k); return i < 0 ? 999 : i; };
  const anomalies = Object.entries(save.anomalies)
    .filter(([, n]) => n > 0)
    .sort((a, b) => rank(a[0]) - rank(b[0]) || (a[0] < b[0] ? -1 : 1))
    .map(([kind, count]) => ({ kind, label: anomalyLabel(kind), count }));
  const view: FieldGuideView = {
    monsters,
    anomalies,
    pagesFound: new Set(save.pages.filter((p) => !!pageDef(p))).size,
    pagesTotal: PAGES.length,
    anomalyKinds: ANOMALY_KINDS.length,
  };
  if (o.bulletins) view.bulletins = o.bulletins;
  return view;
}

// ---------------------------------------------------------------- which monsters are on site

export interface PresenceOpts {
  risk: number;
  contractIndex: number;
  hasVents: boolean;
  /** flags.mannequin / flags.snatcher (default on) */
  mannequin: boolean;
  snatcher: boolean;
  balance: BalanceLike;
}
const balNum = (b: BalanceLike, path: string, d: number): number => {
  let cur: unknown = b;
  for (const k of path.split('.')) cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[k] : undefined;
  return typeof cur === 'number' && Number.isFinite(cur) ? cur : d;
};
/** the same rules monsters/runtime.ts uses: Hound and Listener always; Mannequin at risk >= 2 or the 3rd contract;
 *  Snatcher at risk >= 2 or from the 2nd contract, on a site with vents */
export function presentMonsters(o: PresenceOpts): MonsterKind[] {
  const out: MonsterKind[] = ['hound', 'listener'];
  const b = o.balance;
  if (o.mannequin && (o.risk >= balNum(b, 'monsters.mannequin.minRisk', 2) || o.contractIndex >= balNum(b, 'monsters.mannequin.minContractIndex', 2))) out.push('mannequin');
  if (o.snatcher && o.hasVents && (o.risk >= balNum(b, 'monsters.snatcher.minRisk', 2) || o.contractIndex >= balNum(b, 'monsters.snatcher.minContractIndex', 1))) out.push('snatcher');
  return out;
}

// ---------------------------------------------------------------- bulletin placement

/** the lore-spot fields placement needs (LoreSpot and test spots) */
export interface SpotLike { id: string; style: string; space: number; roomType: string; x: number; z: number }

type LayoutLike = Pick<LevelLayout, 'spaces' | 'entrance'>;

function depthFn(L: LayoutLike): (space: number) => number {
  const dist = new Map(L.spaces.map((s) => [s.id, Number.isFinite(s.dist) ? s.dist : 0]));
  return (space) => dist.get(space) ?? 0;
}
function isLobby(L: LayoutLike, s: SpotLike): boolean {
  if (s.space === L.entrance || s.roomType === 'lobby') return true;
  return L.spaces.find((sp) => sp.id === s.space)?.type === 'lobby';
}

/** farthest-first with spread: the first pick is one of the 3 deepest, then each next maximises its distance to the
 *  picks so far (plus a little depth and rng jitter); at most one per room */
function farthestFirst<T extends SpotLike>(list: readonly T[], out: T[], rooms: Set<number>, count: number, rng: Rng, depth: (space: number) => number): void {
  let avail = list.filter((s) => !rooms.has(s.space) && !out.includes(s))
    .sort((a, b) => depth(b.space) - depth(a.space) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  while (out.length < count && avail.length) {
    let pick: T;
    if (!out.length) pick = avail[rng.int(0, Math.min(2, avail.length - 1))]!;
    else {
      let best = -Infinity;
      let bi = 0;
      for (let i = 0; i < avail.length; i++) {
        const s = avail[i]!;
        let dmin = Infinity;
        for (const o of out) dmin = Math.min(dmin, Math.hypot(s.x - o.x, s.z - o.z));
        const score = dmin + depth(s.space) * 0.15 + rng.next() * 0.5;
        if (score > best) { best = score; bi = i; }
      }
      pick = avail[bi]!;
    }
    out.push(pick);
    rooms.add(pick.space);
    avail = avail.filter((s) => s !== pick && !rooms.has(s.space));
  }
}

/** `count` non-drawer spots: never the lobby/entrance, <= 1 per room, at least minDepthFrac of the deepest space's
 *  distance when possible (relaxed only if too few deep spots exist) */
export function pickBulletinSpots<T extends SpotLike>(L: LayoutLike, spots: readonly T[], rng: Rng, count: number, minDepthFrac: number): T[] {
  const depth = depthFn(L);
  const cand = spots.filter((s) => s.style !== 'drawer' && !isLobby(L, s));
  if (!cand.length || count <= 0) return [];
  const maxD = Math.max(0, ...L.spaces.map((s) => (Number.isFinite(s.dist) ? s.dist : 0)));
  const deep = cand.filter((s) => depth(s.space) >= minDepthFrac * maxD);
  const out: T[] = [];
  const rooms = new Set<number>();
  farthestFirst(deep, out, rooms, count, rng, depth);
  if (out.length < count) farthestFirst(cand, out, rooms, count, rng, depth);
  return out;
}

/** containers for drawer pages: drawer lore spots first, else any container; deep first, <= 1 per room, never the lobby */
export function pickPageContainers<T extends SpotLike>(L: LayoutLike, list: readonly T[], rng: Rng, count: number): T[] {
  const depth = depthFn(L);
  const seen = new Set<string>();
  const cand = list.filter((s) => !isLobby(L, s) && !seen.has(s.id) && (seen.add(s.id), true));
  const out: T[] = [];
  const rooms = new Set<number>();
  // jittered deep-first order, then one per room
  const keyed = cand.map((s) => ({ s, k: depth(s.space) * (0.75 + 0.5 * rng.next()) }))
    .sort((a, b) => b.k - a.k || (a.s.id < b.s.id ? -1 : 1));
  for (const { s } of keyed) {
    if (out.length >= count) break;
    if (rooms.has(s.space)) continue;
    rooms.add(s.space);
    out.push(s);
  }
  // a site with fewer rooms than pages: allow a second container in a room
  for (const { s } of keyed) {
    if (out.length >= count) break;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/** share of a monster's pages the connected players already own, 0..1 (no players = 0) */
export function ownedFraction(saves: readonly FieldGuideSave[], kind: MonsterKind): number {
  const total = pagesTotalOf(kind);
  if (!saves.length || !total) return 0;
  let owned = 0;
  for (const s of saves) owned += ownedPages(s, kind).length;
  return owned / (saves.length * total);
}

/** monsters for `count` bulletins: each goes to the present monster whose pages the connected players own least; every
 *  pick counts as one more page for everyone, so a 4-bulletin site spreads over monsters. Ties follow an rng order. */
export function assignMonsters(present: readonly MonsterKind[], saves: readonly FieldGuideSave[], count: number, rng: Rng): MonsterKind[] {
  if (!present.length || count <= 0) return [];
  const order = rng.shuffle(present.slice());
  const frac = new Map(order.map((k) => [k, ownedFraction(saves, k)]));
  const out: MonsterKind[] = [];
  for (let i = 0; i < count; i++) {
    let best = order[0]!;
    for (const k of order) if (frac.get(k)! < frac.get(best)! - 1e-9) best = k;
    out.push(best);
    frac.set(best, frac.get(best)! + 1 / Math.max(1, pagesTotalOf(best)));
  }
  return out;
}

/** a drawer page: the least-owned page of the least-owned present monster, skipping pages already used this contract */
export function choosePage(present: readonly MonsterKind[], saves: readonly FieldGuideSave[], exclude: ReadonlySet<string>, rng: Rng): string | null {
  const order = rng.shuffle(present.slice());
  const frac = new Map(order.map((k) => [k, ownedFraction(saves, k)]));
  const byNeed = order.slice().sort((a, b) => frac.get(a)! - frac.get(b)!);
  for (const kind of byNeed) {
    const ids = pageIdsOf(kind).filter((id) => !exclude.has(id));
    if (!ids.length) continue;
    const owners = (id: string) => saves.reduce((a, s) => a + (s.pages.includes(id) ? 1 : 0), 0);
    ids.sort((a, b) => owners(a) - owners(b) || pageDef(a)!.n - pageDef(b)!.n);
    return ids[0]!;
  }
  return null;
}

/** 22:00 + clockMin as 'HH:MM' */
export function clockText(clockMin: number): string {
  const total = 22 * 60 + Math.max(0, Math.round(clockMin));
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
