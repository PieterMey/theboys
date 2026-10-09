// Owner: env-paranormal (v1.3 F7 Site Rules v0, flag siteRules). The building listens too: the house rule a site memo
// promises, checked against what the crew says (ai/api.ts onUtterance: STT transcripts) and types (players/noise.ts
// onProxText: proximity text, so players without a mic count), for 2 sites:
//  - bell_digits (Varga Brothers Foundry): a spoken number strikes the old bell in the furnace hall that many times
//    (1-12; any other number once per digit; 12 at most); every strike is a 25 m 'bell' noise there (the Hound goes to
//    the bell: a lure, or a death sentence for whoever stands under it)
//  - phone_callsign (Old Quarry Road Telephone Exchange): a spoken callsign rings that room's dead phone (its phone booth,
//    switchboard or desk, else the room's centre), 2 rings over 6 s; every ring is a 25 m 'phone' noise there
// Only the living, talk level or louder (typed text counts as talk), never from the sealed van. Each reaction starts
// at least leadMs after the line arrived, behind a mechanical wind-up (clients), so the transcript's ~1.5 s delay reads
// as deliberate. Rules make noise and sound only: no kills, no light or door changes. The site's rule comes from meta
// (meta/api.ts siteRule: meta keeps each order's template site name across AI renames), else the order's signature
// (messages/paranormal.ts siteRuleOf). Transcripts are never logged or sent: clients get 'paranormal.rule' (no text).
//   dbg: paranormal.siteRule {rule?: id | null | 'auto'} (force / clear the crew's rule), paranormal.say {text, band?}
//        (a line from the caller: typed text, or speech at `band`)
import { BAND } from '@dead-air/shared/constants.ts';
import { extractDigitRuns, findCallsigns, layoutCallsigns } from '@dead-air/shared/callsign.ts';
import { makeRng } from '@dead-air/shared/rng.ts';
import type { Rng } from '@dead-air/shared/rng.ts';
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import { SITE_RULE_IDS, siteRuleOf } from '@dead-air/shared/messages/paranormal.ts';
import type { SiteRuleEvent, SiteRuleId } from '@dead-air/shared/messages/paranormal.ts';
import type { Utterance } from '@dead-air/shared/messages/ai.ts';
import type { Crew, ServerContext, ServerPlayer } from '../core/types.ts';
import { onUtterance } from '../ai/api.ts';
import * as META from '../meta/api.ts';
import * as IX from '../interaction/api.ts';
import { emitNoise, onProxText } from '../players/noise.ts';
import { indoor, nearVan } from './gates.ts';
import { nextId } from './plan.ts';
import type { ParaBalance } from './types.ts';

/** one line the building heard (voice transcript or typed text), already analysed; never kept */
export interface RuleLine {
  speaker: string;
  alive: boolean;
  kind: 'voice' | 'text';
  band: number;
  x: number;
  z: number;
  digits: readonly string[];
  callsigns: readonly string[];
}

export interface PendingNoise { at: number; x: number; z: number; radiusM: number; kind: 'bell' | 'phone' }

export interface RuleState {
  /** layout hash this state belongs to */
  key: string;
  rng: Rng;
  /** server ms until which the bell is ringing (and resting) */
  bellUntil: number;
  /** space -> server ms until which its phone rings (and rests) */
  phoneUntil: Map<number, number>;
  lastPhoneAt: number;
  /** strike / ring noises still to come (server ms) */
  pending: PendingNoise[];
  stats: { lines: number; bells: number; strikes: number; phones: number; rings: number; ignored: Record<string, number> };
}

export function newRuleState(key: string): RuleState {
  return {
    key, rng: makeRng(key, 'site-rules'), bellUntil: -Infinity, phoneUntil: new Map(), lastPhoneAt: -Infinity, pending: [],
    stats: { lines: 0, bells: 0, strikes: 0, phones: 0, rings: 0, ignored: {} },
  };
}

export const isSiteRule = (v: unknown): v is SiteRuleId => typeof v === 'string' && (SITE_RULE_IDS as readonly string[]).includes(v);

/**
 * How many times the bell strikes for the digit runs of one line: a number 1-12 strikes that many times (it counts like
 * a clock), any other run (0, 13+, a code) once per digit; the runs of a line add up, capped at `max`. 0 = no number.
 */
export function bellStrikes(digits: readonly string[], max: number): number {
  let n = 0;
  for (const d of digits) {
    if (!/^\d+$/.test(d)) continue;
    const v = Number(d);
    n += d.length <= 2 && v >= 1 && v <= 12 ? v : d.length;
  }
  return Math.min(Math.max(1, Math.round(max)), n);
}

const r2 = (v: number): number => Math.round(v * 100) / 100;
const centre = (L: LevelLayout, space: number): { x: number; z: number } => {
  const r = L.spaces[space].rect;
  return { x: r2(Math.floor(r.x + r.w / 2) + 0.5), z: r2(Math.floor(r.y + r.h / 2) + 0.5) };
};

/** rooms the bell may hang in, best first ("it hangs in the furnace hall") */
export const BELL_ROOMS = ['FURNACE', 'FOUNDRY', 'BOILER', 'PIT'] as const;
const bellCache = new WeakMap<LevelLayout, { space: number; x: number; z: number } | null>();

/** the bell's room and spot: the first BELL_ROOMS callsign the layout has, else its largest indoor room */
export function bellSpot(L: LevelLayout): { space: number; x: number; z: number } | null {
  if (bellCache.has(L)) return bellCache.get(L) ?? null;
  const rooms = L.spaces.filter((s) => indoor(L, s.id) && s.kind !== 'corridor' && s.type !== 'van' && s.type !== 'vault');
  let s = BELL_ROOMS.map((cs) => rooms.find((q) => q.callsign === cs)).find((q) => !!q);
  if (!s) s = rooms.slice().sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h || a.id - b.id)[0];
  const out = s ? { space: s.id, ...centre(L, s.id) } : null;
  bellCache.set(L, out);
  return out;
}

const PHONE_PROPS = ['phone_booth', 'switchboard', 'desk'] as const;

/** where a room's dead phone rings: its phone booth, switchboard or desk (first by id), else the room's centre */
export function phoneSpot(L: LevelLayout, space: number): { x: number; z: number; y: number } {
  for (const key of PHONE_PROPS) {
    const it = L.items.filter((i) => i.kind === 'prop' && i.space === space && i.data?.prop === key).sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    if (it) return { x: r2(it.x), z: r2(it.z), y: key === 'desk' ? 0.85 : 1.3 };
  }
  return { ...centre(L, space), y: 1.3 };
}

export interface RuleReaction { ev: Omit<SiteRuleEvent, 'id'>; noises: PendingNoise[] }

function skip(rs: RuleState, why: string): null {
  rs.stats.ignored[why] = (rs.stats.ignored[why] ?? 0) + 1;
  return null;
}

/**
 * The building's answer to one line under `rule` at server time `now` (null = it lets this one pass). Schedules the
 * strike / ring noises in rs.pending and returns the crew event.
 */
export function reactToLine(rs: RuleState, L: LevelLayout, b: ParaBalance, rule: SiteRuleId, line: RuleLine, now: number): RuleReaction | null {
  const sr = b.siteRules;
  rs.stats.lines++;
  if (!line.alive) return skip(rs, 'dead');
  if (line.kind === 'voice' && line.band < sr.minBand) return skip(rs, 'quiet');
  if (nearVan(L, line.x, line.z, 0)) return skip(rs, 'van');
  const at = now + Math.max(250, sr.leadMs);
  if (rule === 'bell_digits') {
    const n = bellStrikes(line.digits, sr.bell.maxStrikes);
    if (!n) return skip(rs, 'no number');
    if (now < rs.bellUntil) return skip(rs, 'ringing');
    const spot = bellSpot(L);
    if (!spot) return skip(rs, 'no bell');
    const every = Math.max(600, Math.round(sr.bell.everyMs));
    rs.bellUntil = at + (n - 1) * every + sr.bell.cooldownSec * 1000;
    rs.stats.bells++;
    rs.stats.strikes += n;
    const noises: PendingNoise[] = [];
    for (let i = 0; i < n; i++) noises.push({ at: at + i * every, x: spot.x, z: spot.z, radiusM: sr.bell.noiseM, kind: 'bell' });
    rs.pending.push(...noises);
    return { ev: { rule, at, seed: rs.rng.int(1, 0x7fffffff), space: spot.space, p: [spot.x, sr.bell.y, spot.z], data: { strikes: n, everyMs: every } }, noises };
  }
  // phone_callsign: the first named room whose phone is free
  if (!line.callsigns.length) return skip(rs, 'no callsign');
  if (now < rs.lastPhoneAt + sr.phone.crewGapSec * 1000) return skip(rs, 'gap');
  for (const cs of line.callsigns) {
    const s = L.spaces.find((q) => q.callsign === cs);
    if (!s || !indoor(L, s.id) || s.type === 'van') continue;
    if (now < (rs.phoneUntil.get(s.id) ?? -Infinity)) continue;
    const spot = phoneSpot(L, s.id);
    const rings = Math.max(1, Math.round(sr.phone.rings));
    const every = Math.max(800, Math.round(sr.phone.everyMs));
    const ringMs = Math.max(300, Math.round(sr.phone.ringMs));
    rs.phoneUntil.set(s.id, at + (rings - 1) * every + ringMs + sr.phone.roomCooldownSec * 1000);
    rs.lastPhoneAt = now;
    rs.stats.phones++;
    rs.stats.rings += rings;
    const noises: PendingNoise[] = [];
    for (let i = 0; i < rings; i++) noises.push({ at: at + i * every, x: spot.x, z: spot.z, radiusM: sr.phone.noiseM, kind: 'phone' });
    rs.pending.push(...noises);
    return {
      ev: { rule, at, seed: rs.rng.int(1, 0x7fffffff), space: s.id, p: [spot.x, spot.y, spot.z], data: { callsign: cs, rings, everyMs: every, ringMs } },
      noises,
    };
  }
  return skip(rs, 'ringing');
}

/** the noises due by `now` (removed from rs.pending, oldest first) */
export function dueNoises(rs: RuleState, now: number): PendingNoise[] {
  if (!rs.pending.length) return [];
  const due = rs.pending.filter((n) => n.at <= now).sort((a, b) => a.at - b.at);
  if (due.length) rs.pending = rs.pending.filter((n) => n.at > now);
  return due;
}

// ---------------------------------------------------------------- live wiring (paranormal/index.ts install)

const aliveIn = (crew: Crew, p: ServerPlayer | undefined): boolean => {
  if (!p || !p.connected || !p.alive) return false;
  try { return IX.isAlive(crew, p.id); } catch { return p.alive; }
};

/** a transcript as a RuleLine (the text itself is not kept) */
export function lineOfUtterance(crew: Crew, u: Utterance): RuleLine {
  return {
    speaker: u.speaker, alive: aliveIn(crew, crew.players.get(u.speaker)), kind: u.kind === 'text' ? 'text' : 'voice', band: Number(u.band) || 0,
    x: Number(u.pos?.[0] ?? 0), z: Number(u.pos?.[1] ?? 0), digits: Array.isArray(u.digits) ? u.digits : [], callsigns: Array.isArray(u.callsigns) ? u.callsigns : [],
  };
}

/** typed proximity text (or a dbg line spoken at `voiceBand`) as a RuleLine, analysed like a transcript (EN/NL number
 *  words, fuzzy callsigns) */
export function lineOfText(crew: Crew, player: ServerPlayer, text: string, x: number, z: number, voiceBand?: number): RuleLine {
  const cs = crew.layout ? layoutCallsigns(crew.layout) : [];
  return {
    speaker: player.id, alive: aliveIn(crew, player), kind: voiceBand === undefined ? 'text' : 'voice', band: voiceBand ?? BAND.talk, x, z,
    digits: extractDigitRuns(text), callsigns: cs.length ? findCallsigns(text, cs) : [],
  };
}

export const SITE_RULES_ORDER = 78;

export function installSiteRules(ctx: ServerContext, getB: () => ParaBalance, moduleOn: () => boolean): void {
  const log = ctx.log('siterules');
  const states = new WeakMap<Crew, RuleState>();
  /** dbg override per crew: a rule or null (= none); absent = the site's own */
  const forced = new WeakMap<Crew, SiteRuleId | null>();
  const on = () => ctx.flags.siteRules === true && moduleOn();
  const meta = META as unknown as { siteRule?: (crew: Crew) => unknown; currentOrder?: (crew: Crew) => unknown };

  const ruleOf = (crew: Crew): SiteRuleId | null => {
    if (forced.has(crew)) return forced.get(crew) ?? null;
    try {
      if (typeof meta.siteRule === 'function') {
        const r = meta.siteRule(crew);
        return isSiteRule(r) ? r : null;
      }
      const order = typeof meta.currentOrder === 'function' ? meta.currentOrder(crew) : null;
      return siteRuleOf(order as Parameters<typeof siteRuleOf>[0]);
    } catch {
      return null;
    }
  };

  const stateOf = (crew: Crew): RuleState | null => {
    const L = crew.layout;
    if (!L) return null;
    let rs = states.get(crew);
    if (!rs || rs.key !== `${L.hash}|${crew.code}`) { rs = newRuleState(`${L.hash}|${crew.code}`); states.set(crew, rs); }
    return rs;
  };

  const handle = (crew: Crew, line: () => RuleLine): void => {
    if (!on() || crew.phase !== 'contract' || !crew.layout || crew.layout.kind !== 'facility') return;
    const rule = ruleOf(crew);
    if (!rule) return;
    const rs = stateOf(crew);
    if (!rs) return;
    const r = reactToLine(rs, crew.layout, getB(), rule, line(), ctx.now());
    if (!r) return;
    const ev: SiteRuleEvent = { id: nextId(), ...r.ev };
    ctx.emit(crew, 'paranormal.rule', ev);
    // counts only: never the line itself
    log.debug(`crew ${crew.code}: ${rule} -> ${rule === 'bell_digits' ? `${String(ev.data.strikes)} strikes` : `${String(ev.data.rings)} rings in ${String(ev.data.callsign)}`}`);
  };

  onUtterance((crew, u) => {
    try { handle(crew, () => lineOfUtterance(crew, u)); } catch (e) { log.warn('utterance failed', e instanceof Error ? e.message : e); }
  });
  onProxText((crew, e) => {
    try { handle(crew, () => lineOfText(crew, e.player, e.text, e.x, e.z)); } catch (err) { log.warn('text failed', err instanceof Error ? err.message : err); }
  });

  ctx.registerSystem({
    name: 'siterules',
    order: SITE_RULES_ORDER,
    tick(_dt, crew) {
      const rs = states.get(crew);
      if (!rs || !rs.pending.length) return;
      if (crew.phase !== 'contract' || !on()) { rs.pending = []; return; }
      for (const n of dueNoises(rs, ctx.now())) emitNoise(crew, { x: n.x, z: n.z, radiusM: n.radiusM, kind: n.kind, source: '' });
    },
  });
  ctx.hooks.phase.push((crew) => {
    const rs = states.get(crew);
    if (rs) rs.pending = [];
  });

  // ---------------- dev only ----------------
  ctx.registerDbg('paranormal.siteRule', (crew, _p, args) => {
    const a = (args ?? {}) as { rule?: unknown };
    if (a.rule === 'auto') forced.delete(crew);
    else if (a.rule === null || isSiteRule(a.rule)) forced.set(crew, a.rule as SiteRuleId | null);
    const rs = states.get(crew);
    return { on: on(), rule: ruleOf(crew), forced: forced.has(crew), stats: rs?.stats ?? null, pending: rs?.pending.length ?? 0, bell: crew.layout ? bellSpot(crew.layout) : null };
  });
  ctx.registerDbg('paranormal.say', (crew, player, args) => {
    const a = (args ?? {}) as { text?: unknown; band?: unknown };
    const [x, , z] = player.pose.p;
    const before = states.get(crew)?.stats.lines ?? 0;
    // a band makes it speech at that loudness (whispers pass); without one it is typed text
    handle(crew, () => lineOfText(crew, player, String(a.text ?? ''), x, z, a.band !== undefined && Number.isFinite(Number(a.band)) ? Number(a.band) : undefined));
    const rs = states.get(crew);
    return { heard: (rs?.stats.lines ?? 0) > before, stats: rs?.stats ?? null };
  });
}

