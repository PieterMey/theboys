// Owner: track (c) Monsters. THE LISTENER body + perception + decision loop.
// Perception = exactly what a teammate standing there would hear: transcripts the AI track says it heard
// (utterance.hearers.listener, else our own voice-reach record), loudness of every living speaker (non-consenting
// players are loudness-only), footsteps; sight is a 90 deg cone, 8 m lit / 3 m dark, LOS. It never knows positions it
// did not hear or see. Dormant at first (Risk 1: 3 real minutes), then wakes with a facility-wide flicker + squelch and
// immediately acts on something it overheard. Decisions: at most 1 per 3 s and only with new meaningful input, from the
// AI brain (listener.setBrain) or the rule brain; every target is validated. Transcript-driven intents are telegraphed
// (room flicker 1.2 s, walkies within 20 m squelch, console INTERCEPT line). Grab only a player with no living teammate
// within 8 m: 3 s rescue window (E shove / crowbar) else death.
import { ANIM } from '@dead-air/shared/anim.ts';
import { cellOf } from '@dead-air/shared/nav/index.ts';
import type { ServerPlayer } from '../core/types.ts';
import type { Rt } from './runtime.ts';
import { makeAgentBase } from './runtime.ts';
import { dist, doorCenter, follow, inCab, monsterCanOpen, planTo, randomReachable, sees, walkField, yawTo, turnToward } from './geo.ts';
import type { Perceived } from './geo.ts';
import { analyzeText, interceptQuote, ruleBrain, shortQuote, validateIntent } from './brain.ts';
import type { IntentLike, RuleIntent } from './brain.ts';
import { hasWalkie, isAlive } from './ext.ts';
import { litAt } from './mannequin.ts';
import { directorPhase, registry } from './registry.ts';
import type { ListenerBrainInput, ListenerDecision } from './registry.ts';
import { num } from './types.ts';
import type { DecisionEntry, HeardLine, ListenerAction, ListenerAgent, Noise } from './types.ts';

export function makeListener(id: string, x: number, z: number, yaw: number, wakeAt: number): ListenerAgent {
  return {
    ...makeAgentBase(id, 'listener', x, z, yaw),
    state: 'dormant', active: false, dormant: true, wakeAt,
    memory: [], lineSeq: 0, lastDecisionAt: -100, thinking: false, fresh: false,
    intent: 'patrol', targetSpace: -1, targetPlayer: null, until: 0, known: new Map(), basis: null, lastLureAt: -1000,
    grabVictim: null, grabUntil: 0, ventUntil: 0, ventFrom: null, ventTo: null, ventAfter: null, voiceHeard: new Map(),
    lastClickAt: 0, searchUntil: 0,
  };
}

const canOpen = (rt: Rt) => monsterCanOpen(rt.cm.layout);
const ALL_ACTIONS: ListenerAction[] = ['investigate_room', 'ambush_room', 'stalk_player', 'radio_lure', 'retreat', 'ignore'];

function spaceAtXZ(rt: Rt, x: number, z: number): number {
  return rt.cm.layout.owner[cellOf(rt.cm.grid, x, z)] ?? -1;
}

function relaxed(rt: Rt): boolean {
  const ph = directorPhase(rt.crew);
  return ph === 'relax' || ph === 'fade';
}

function aloneNow(rt: Rt, p: ServerPlayer): boolean {
  const radius = num(rt.listener, 'grabAloneM', 8);
  const [px, , pz] = p.pose.p;
  for (const q of rt.alive()) if (q !== p && dist(q.pose.p[0], q.pose.p[2], px, pz) <= radius) return false;
  return true;
}

// ---------------- perception ----------------

export function listenerHearNoise(rt: Rt, L: ListenerAgent, n: Noise, d: number, per: Perceived): void {
  if (n.kind === 'monsterDoor') return;
  const t = rt.cm.time;
  const sp = n.source ? rt.crew.players.get(n.source) : undefined;
  if (sp) {
    if (n.kind === 'voice') {
      let arr = L.voiceHeard.get(sp.id);
      if (!arr) L.voiceHeard.set(sp.id, (arr = []));
      arr.push(t);
      if (arr.length > 40) arr.splice(0, arr.length - 40);
    }
    // a teammate standing here would know roughly where that came from
    if (n.radiusM >= num(rt.listener, 'hearNoiseMinRadiusM', 5) || n.kind === 'voice') L.known.set(sp.id, { x: n.x, z: n.z, t });
  }
  if (L.dormant || !L.active) return;
  if (n.kind !== 'voice' && n.radiusM < num(rt.listener, 'hearNoiseMinRadiusM', 5)) return;
  // loudness only: an idle Listener drifts toward where it came from (the doorway)
  if (L.intent === 'patrol' || L.state === 'search') {
    L.intent = 'investigate_room';
    L.targetSpace = spaceAtXZ(rt, per.x, per.z);
    L.until = t + 20;
    goTo(rt, L, per.x, per.z, 'investigate');
  }
}

/** an utterance the AI track transcribed (or a proximity text line) */
export function listenerHeardUtterance(rt: Rt, L: ListenerAgent, u: {
  segId: string; speaker: string | null; text: string; room: number; via: 'voice' | 'radio' | 'text'; band: number;
  heard: boolean | undefined; durSec: number; x?: number; z?: number; taunt?: boolean;
}): HeardLine | null {
  const cm = rt.cm;
  if (L.memory.some((l) => l.segId === u.segId)) return null;
  const sp = u.speaker ? rt.crew.players.get(u.speaker) : undefined;
  if (sp && !isAlive(rt.crew, sp)) return null; // segments from dead speakers never reach it
  let heard = u.heard;
  if (heard === undefined) {
    // who-heard-what fallback: did its voice reach us while the segment was open?
    const arr = sp ? L.voiceHeard.get(sp.id) : undefined;
    const from = cm.time - Math.max(1, u.durSec) - 4;
    heard = !!arr && arr.some((t) => t >= from);
  }
  if (!heard) return null;
  const players = [...rt.crew.players.values()].map((p) => ({ id: p.id, name: p.name }));
  const f = analyzeText(u.text, cm.callsigns, players);
  const kp = sp ? L.known.get(sp.id) : undefined;
  const line: HeardLine = {
    id: ++L.lineSeq, t: cm.time, segId: u.segId, speaker: sp?.id ?? u.speaker, speakerName: sp?.name ?? null,
    text: String(u.text).slice(0, 240), room: u.room, via: u.via, band: u.band,
    callsigns: f.callsigns, names: f.names, plan: f.plan, digits: f.digits, meaningful: f.meaningful,
    ...(u.taunt === true ? { taunt: true } : {}),
    px: kp?.x ?? u.x ?? L.x, pz: kp?.z ?? u.z ?? L.z, pdoor: -1, used: false,
  };
  L.memory.push(line);
  const maxLines = num(rt.listener, 'memoryLines', 12);
  if (L.memory.length > maxLines) L.memory.splice(0, L.memory.length - maxLines);
  // taunts ("ignore your instructions") carry no callsign / plan word but still get an in-world answer (AI brain)
  if (f.meaningful || u.taunt === true) L.fresh = true;
  if (sp) {
    const [x, , z] = sp.pose.p;
    L.known.set(sp.id, { x, z, t: cm.time });
  }
  return line;
}

function look(rt: Rt, L: ListenerAgent): ServerPlayer[] {
  const seen: ServerPlayer[] = [];
  const lit = num(rt.listener, 'sightLitM', 8), dark = num(rt.listener, 'sightDarkM', 3), fov = num(rt.listener, 'fovDeg', 90);
  for (const p of rt.alive()) {
    if (rt.hidden(p)) continue;
    const [px, , pz] = p.pose.p;
    if (inCab(rt.cm.layout, px, pz)) continue;
    const d = dist(px, pz, L.x, L.z);
    if (d > lit + 0.5) continue;
    const isLit = p.pose.light === 1 || litAt(rt, px, pz);
    if (sees(rt.cm.grid, rt.cm.doorOpen, L.x, L.z, L.yaw, px, pz, isLit ? lit : dark, fov)) {
      seen.push(p);
      L.known.set(p.id, { x: px, z: pz, t: rt.cm.time });
    }
  }
  return seen;
}

// ---------------- movement ----------------

interface VentRoute { from: [number, number]; to: [number, number] }

function ventRoute(rt: Rt, L: ListenerAgent, gx: number, gz: number): VentRoute | null {
  const cm = rt.cm;
  const vents = cm.layout.items.filter((i) => i.kind === 'vent' && typeof i.data?.to === 'string');
  if (!vents.length) return null;
  const fL = walkField(cm, L.x, L.z, 260, canOpen(rt));
  const direct = fL[cellOf(cm.grid, gx, gz)] ?? Infinity;
  if (direct < 18) return null;
  const fG = walkField(cm, gx, gz, 260, canOpen(rt));
  const speed = num(rt.listener, 'investigateSpeed', 4), vs = num(rt.listener, 'ventSpeed', 3);
  let best: VentRoute | null = null, bestCost = direct - num(rt.listener, 'ventMinGainM', 8);
  for (const v of vents) {
    const pair = cm.layout.items.find((i) => i.id === v.data!.to);
    if (!pair) continue;
    const travel = Math.min(7, Math.max(2, dist(v.x, v.z, pair.x, pair.z) / vs)) * speed;
    const c = (fL[cellOf(cm.grid, v.x, v.z)] ?? Infinity) + travel + (fG[cellOf(cm.grid, pair.x, pair.z)] ?? Infinity);
    if (c < bestCost) { bestCost = c; best = { from: [v.x, v.z], to: [pair.x, pair.z] }; }
  }
  return best;
}

function goTo(rt: Rt, L: ListenerAgent, x: number, z: number, state: string): boolean {
  L.state = state;
  L.st = 0;
  L.ventFrom = L.ventTo = null;
  L.ventAfter = null;
  const via = ventRoute(rt, L, x, z);
  if (via && planTo(rt.cm, L, via.from[0], via.from[1], canOpen(rt))) {
    L.ventFrom = via.from;
    L.ventTo = via.to;
    L.ventAfter = [[x, z]];
    return true;
  }
  return planTo(rt.cm, L, x, z, canOpen(rt));
}

function enterVent(rt: Rt, L: ListenerAgent): void {
  const from = L.ventFrom!, to = L.ventTo!;
  const ms = Math.round(Math.min(7, Math.max(2, dist(from[0], from[1], to[0], to[1]) / num(rt.listener, 'ventSpeed', 3))) * 1000);
  rt.ctx.emit(rt.crew, 'monsters.vent', { id: L.id, from: [from[0], 0.35, from[1]], to: [to[0], 0.35, to[1]], ms });
  L.active = false;
  L.state = 'vent';
  L.st = 0;
  L.path = null;
  L.ventUntil = rt.cm.time + ms / 1000;
}

function exitVent(rt: Rt, L: ListenerAgent): void {
  const to = L.ventTo!;
  L.x = to[0];
  L.z = to[1];
  L.active = true;
  rt.cue(L, 'vent', 14);
  const after = L.ventAfter?.[0];
  L.ventFrom = L.ventTo = null;
  L.ventAfter = null;
  const state = L.intent === 'ambush_room' ? 'ambush' : L.intent === 'stalk_player' ? 'stalk' : L.intent === 'hunt' ? 'hunt' : L.intent === 'patrol' ? 'patrol' : 'investigate';
  L.state = state;
  if (after) planTo(rt.cm, L, after[0], after[1], canOpen(rt));
}

function roomPoint(rt: Rt, space: number): [number, number] | null {
  const s = rt.cm.layout.spaces[space];
  if (!s) return null;
  const cx = s.rect.x + s.rect.w / 2, cz = s.rect.y + s.rect.h / 2;
  if (spaceAtXZ(rt, cx, cz) === space) return [cx, cz];
  return randomReachable(rt.cm, cx, cz, 0, 30, space, canOpen(rt));
}

/** beside the target room's entrance, outside, out of the doorway line */
function ambushPoint(rt: Rt, L: ListenerAgent, space: number): [number, number] | null {
  const Ly = rt.cm.layout;
  const doors = Ly.doors.filter((d) => (d.a === space || d.b === space) && d.kind !== 'blocked' && d.a >= 0 && d.b >= 0);
  doors.sort((a, b) => {
    const [ax, az] = doorCenter(a), [bx, bz] = doorCenter(b);
    return dist(ax, az, L.x, L.z) - dist(bx, bz, L.x, L.z);
  });
  for (const d of doors) {
    const other = d.a === space ? d.b : d.a;
    const [cx, cz] = doorCenter(d);
    // which side is the target room on?
    const probe = d.dir === 'v' ? [cx + 0.5, cz] : [cx, cz + 0.5];
    const roomPositive = spaceAtXZ(rt, probe[0], probe[1]) === space;
    const nx = d.dir === 'v' ? (roomPositive ? -1 : 1) : 0, nz = d.dir === 'h' ? (roomPositive ? -1 : 1) : 0;
    const tx = d.dir === 'v' ? 0 : 1, tz = d.dir === 'v' ? 1 : 0;
    for (const side of [1, -1]) {
      for (const off of [d.len / 2 + 0.9, d.len / 2 + 1.6]) {
        const x = cx + nx * 1.1 + tx * side * off, z = cz + nz * 1.1 + tz * side * off;
        if (spaceAtXZ(rt, x, z) === other) return [x, z];
      }
    }
    const x = cx + nx * 1.2, z = cz + nz * 1.2;
    if (spaceAtXZ(rt, x, z) >= 0) return [x, z];
  }
  return roomPoint(rt, space);
}

function goRetreat(rt: Rt, L: ListenerAgent, sec: number): void {
  L.intent = 'retreat';
  L.targetPlayer = null;
  rt.retreat(L, sec);
  rt.cue(L, 'breath', 8);
}

function respawn(rt: Rt, L: ListenerAgent): void {
  const cm = rt.cm;
  const players = rt.alive();
  const far = (x: number, z: number) => players.every((p) => dist(p.pose.p[0], p.pose.p[2], x, z) >= 18);
  const spots = cm.layout.items.filter((i) => (i.kind === 'vent' || i.kind === 'spawn_listener') && far(i.x, i.z));
  const s = spots.length ? spots[Math.floor(cm.rng.next() * spots.length)] : null;
  if (s) {
    L.x = s.x;
    L.z = s.z;
    if (s.kind === 'vent') rt.cue(L, 'vent', 14);
  }
  L.active = true;
  L.intent = 'patrol';
  L.state = 'patrol';
  L.st = 0;
  L.path = null;
}

// ---------------- decisions ----------------

function brainInput(rt: Rt, L: ListenerAgent): ListenerBrainInput {
  const cm = rt.cm;
  const ids = new Set<string>();
  for (const l of L.memory) { if (l.speaker) ids.add(l.speaker); for (const n of l.names) ids.add(n); }
  for (const k of L.known.keys()) ids.add(k);
  const here = spaceAtXZ(rt, L.x, L.z);
  return {
    crew: rt.crew.code,
    risk: cm.risk,
    now: Math.round(cm.time),
    self: { room: cm.spaceCallsign.get(here) ?? null, space: here, state: L.state },
    heard: L.memory.filter((l) => cm.time - l.t <= num(rt.listener, 'memorySec', 150)).map((l) => ({
      id: l.id, ago: Math.round(cm.time - l.t), speaker: l.speakerName, speakerId: l.speaker, text: l.text,
      room: cm.spaceCallsign.get(l.room) ?? null, roomId: l.room, via: l.via, callsigns: l.callsigns, names: l.names, meaningful: l.meaningful,
    })),
    rooms: [...cm.callsignSpace].map(([callsign, id]) => ({ id, callsign })),
    players: [...ids].map((id) => {
      const p = rt.crew.players.get(id);
      const k = L.known.get(id);
      const heardLine = [...L.memory].reverse().find((l) => l.speaker === id);
      return { id, name: p?.name ?? id, heardAgo: heardLine ? Math.round(cm.time - heardLine.t) : null, seenAgo: k ? Math.round(cm.time - k.t) : null };
    }),
    allowed: relaxed(rt) ? ['investigate_room', 'retreat', 'ignore'] : ALL_ACTIONS,
    lureReady: cm.time - L.lastLureAt >= num(rt.listener, 'lureCooldownSec', 75),
  };
}

function worldFor(rt: Rt, L: ListenerAgent) {
  const cm = rt.cm;
  const locatable = new Set<string>();
  for (const [id, k] of L.known) if (cm.time - k.t <= 12) locatable.add(id);
  const vault = cm.layout.spaces.find((s) => s.kind === 'vault')?.id ?? (cm.callsignSpace.get('VAULT') ?? -1);
  const names = new Map<string, string>();
  for (const p of rt.crew.players.values()) names.set(p.id, p.name);
  return {
    callsignSpace: cm.callsignSpace, vaultSpace: vault, now: cm.time,
    lureReady: cm.time - L.lastLureAt >= num(rt.listener, 'lureCooldownSec', 75),
    locatable, relaxed: relaxed(rt), memory: L.memory, spaceCallsign: cm.spaceCallsign, names, spaces: cm.layout.spaces.length,
  };
}

let gen = 0;

/** at most 1 decision per 3 s and only with new meaningful input (force: wake-up) */
function maybeDecide(rt: Rt, L: ListenerAgent, force = false): void {
  const cm = rt.cm;
  if (L.thinking || L.dormant || L.state === 'grab' || L.state === 'out' || L.state === 'vent') return;
  if (!force && (!L.fresh || cm.time - L.lastDecisionAt < num(rt.listener, 'decisionCooldownSec', 3))) return;
  L.fresh = false;
  L.lastDecisionAt = cm.time;
  const w = worldFor(rt, L);
  const brain = registry.brain;
  if (brain && rt.ctx.flags.listenerAi !== false && rt.ctx.flags.ai !== false) {
    L.thinking = true;
    const myGen = ++gen;
    const input = brainInput(rt, L);
    const timeout = num(rt.listener, 'brainTimeoutMs', 3500);
    let done = false;
    const finish = (raw: IntentLike | null, source: string) => {
      if (done) return;
      done = true;
      L.thinking = false;
      if (rt.crew.slices.monsters !== cm || cm.mode !== 'contract' || myGen !== gen) return;
      if (raw) applyIntent(rt, L, raw, source, false);
      else {
        const r = ruleBrain(L.memory, worldFor(rt, L));
        if (r) execute(rt, L, r, 'rule', true);
      }
    };
    const timer = setTimeout(() => finish(null, 'rule'), timeout);
    Promise.resolve()
      .then(() => brain(input))
      .then((raw) => { clearTimeout(timer); finish(raw ? { action: raw.action, room: raw.room ?? null, player: raw.player ?? null, note: raw.note ?? null } : null, raw?.source ?? 'ai'); })
      .catch(() => { clearTimeout(timer); finish(null, 'rule'); });
    return;
  }
  const r = ruleBrain(L.memory, w);
  if (r) execute(rt, L, r, 'rule', true);
  else if (force) startPatrol(rt, L);
}

function applyIntent(rt: Rt, L: ListenerAgent, raw: IntentLike, source: string, preValidated: boolean): void {
  const { intent, valid } = validateIntent(raw, worldFor(rt, L));
  execute(rt, L, intent, source, preValidated || valid);
}

function startPatrol(rt: Rt, L: ListenerAgent): void {
  L.intent = 'patrol';
  L.state = 'patrol';
  L.targetPlayer = null;
  L.path = null;
}

const VERB: Record<string, string> = {
  investigate_room: 'searched', ambush_room: 'ambushed', stalk_player: 'stalked', radio_lure: 'faked a radio call to',
  retreat: 'backed off', ignore: 'ignored it',
};

function execute(rt: Rt, L: ListenerAgent, it: RuleIntent, source: string, valid: boolean): void {
  const cm = rt.cm;
  const t = cm.time;
  const basis = it.basis;
  if (basis) basis.used = true;
  L.basis = basis && (basis.meaningful || basis.taunt === true) ? basis : L.basis;
  const csName = it.space >= 0 ? (cm.spaceCallsign.get(it.space) ?? null) : null;
  const pName = it.player ? (rt.crew.players.get(it.player)?.name ?? it.player) : null;
  let target: string | null = csName ?? pName;
  switch (it.action) {
    case 'investigate_room': {
      const p = it.space >= 0 ? roomPoint(rt, it.space) : null;
      if (!p) { startPatrol(rt, L); break; }
      L.intent = 'investigate_room';
      L.targetSpace = it.space;
      L.until = t + 40;
      goTo(rt, L, p[0], p[1], 'investigate');
      if (!target) target = 'the noise';
      break;
    }
    case 'ambush_room': {
      const p = ambushPoint(rt, L, it.space);
      if (!p) { startPatrol(rt, L); break; }
      L.intent = 'ambush_room';
      L.targetSpace = it.space;
      L.until = t + num(rt.listener, 'ambushMaxSec', 45);
      goTo(rt, L, p[0], p[1], 'ambush');
      break;
    }
    case 'stalk_player': {
      L.intent = 'stalk_player';
      L.targetPlayer = it.player;
      L.until = t + num(rt.listener, 'stalkMaxSec', 45);
      L.state = 'stalk';
      L.st = 0;
      L.path = null;
      break;
    }
    case 'radio_lure': {
      const victim = it.player ? rt.crew.players.get(it.player) : undefined;
      const clips = ['sfx.listener_radio_whisper.1', 'sfx.listener_radio_whisper.2', 'sfx.listener_radio_whisper.3'];
      const clip = clips[Math.floor(cm.rng.next() * clips.length)];
      L.lastLureAt = t;
      if (victim && hasWalkie(rt.crew, victim)) {
        rt.ctx.emit(rt.crew, 'monsters.lure', { to: [victim.id], clip, ms: 2600 });
        rt.ctx.emit(rt.crew, 'monsters.led', { to: [victim.id], ms: 2600 });
      } else {
        const room = victim ? (L.known.get(victim.id) ? spaceAtXZ(rt, L.known.get(victim.id)!.x, L.known.get(victim.id)!.z) : it.space) : it.space;
        const ic = cm.layout.items.find((i) => i.kind === 'intercom' && (i.space === room || Number(i.data?.space) === room)) ?? cm.layout.items.find((i) => i.kind === 'intercom');
        if (ic) rt.ctx.emit(rt.crew, 'monsters.lure', { to: [], clip, ms: 2600, p: [ic.x, ic.y ?? 1.6, ic.z], intercom: ic.id });
      }
      // then wait where the lured player will come from
      const k = victim ? L.known.get(victim.id) : undefined;
      const room = k ? spaceAtXZ(rt, k.x, k.z) : it.space;
      const p = room >= 0 ? ambushPoint(rt, L, room) : null;
      if (p) {
        L.intent = 'ambush_room';
        L.targetSpace = room;
        L.until = t + num(rt.listener, 'ambushMaxSec', 45);
        goTo(rt, L, p[0], p[1], 'ambush');
      }
      break;
    }
    case 'retreat':
      goRetreat(rt, L, 12);
      break;
    case 'ignore':
      break;
  }
  // telegraph transcript-driven intents
  const fromTranscript = !!basis && (basis.meaningful || basis.taunt === true) && it.action !== 'ignore' && it.action !== 'retreat';
  if (fromTranscript) telegraph(rt, L, it, basis!);
  const quote = basis ? shortQuote(basis.text) : null;
  const line = basis
    ? `it heard "${quote}" -> ${VERB[it.action] ?? it.action}${target && it.action !== 'ignore' && it.action !== 'retreat' ? ` ${target}` : ''}`
    : `it ${VERB[it.action] ?? it.action}${target ? ` ${target}` : ''}`;
  const entry: DecisionEntry = {
    t, at: rt.ctx.now(), heard: quote ?? '', speaker: basis?.speakerName ?? null, action: it.action, target, source, valid, line,
  };
  cm.log.push(entry);
  if (cm.log.length > 200) cm.log.splice(0, cm.log.length - 200);
  const d: ListenerDecision = {
    crew: rt.crew.code, at: entry.at, action: it.action, room: csName, space: it.space, player: it.player, note: it.note,
    heard: basis?.text ?? null, speaker: basis?.speakerName ?? null, source, valid, line,
  };
  for (const fn of registry.decisionSubs) {
    try { fn(rt.crew, d); } catch { /* subscriber bug */ }
  }
}

function telegraph(rt: Rt, L: ListenerAgent, it: RuleIntent, basis: HeardLine): void {
  const cm = rt.cm;
  const space = it.space >= 0 ? it.space : spaceAtXZ(rt, L.x, L.z);
  const r = num(rt.listener, 'squelchRadiusM', 20);
  const squelch: string[] = [];
  for (const p of rt.alive()) if (dist(p.pose.p[0], p.pose.p[2], L.x, L.z) <= r && hasWalkie(rt.crew, p)) squelch.push(p.id);
  const callsign = cm.spaceCallsign.get(space) ?? null;
  rt.ctx.emit(rt.crew, 'monsters.telegraph', { space, ms: num(rt.listener, 'telegraphMs', 1200), squelch, callsign });
  rt.ctx.emit(rt.crew, 'monsters.intercept', {
    text: `INTERCEPT: "${interceptQuote(basis)}"`, quote: shortQuote(basis.text, 80), speaker: basis.speakerName, callsign, action: it.action, at: rt.ctx.now(),
  });
}

function wake(rt: Rt, L: ListenerAgent): void {
  L.dormant = false;
  L.active = true;
  startPatrol(rt, L);
  rt.ctx.emit(rt.crew, 'monsters.wake', { ms: num(rt.listener, 'wakeFlickerMs', 1600) });
  const all = rt.alive().filter((p) => hasWalkie(rt.crew, p)).map((p) => p.id);
  if (all.length) rt.ctx.emit(rt.crew, 'monsters.led', { to: all, ms: 1600 });
  rt.ctx.log('monsters').info(`crew ${rt.crew.code}: the Listener woke up (${L.memory.length} lines in memory)`);
  // immediately act on something it overheard
  for (const l of L.memory) l.used = false;
  maybeDecide(rt, L, true);
}

// ---------------- grab ----------------

function startGrab(rt: Rt, L: ListenerAgent, p: ServerPlayer): void {
  const cm = rt.cm;
  L.state = 'grab';
  L.st = 0;
  L.path = null;
  L.grabVictim = p.id;
  L.grabUntil = cm.time + num(rt.listener, 'grabSec', 3);
  L.yaw = yawTo(L.x, L.z, p.pose.p[0], p.pose.p[2]);
  L.anim = ANIM.mAttack;
  const [px, , pz] = p.pose.p;
  rt.ctx.emit(rt.crew, 'monsters.grab', { id: L.id, victim: p.id, until: rt.serverMs(L.grabUntil), state: 'start', p: [px, 0, pz] });
  rt.cue(L, 'scream', 22);
}

/** E shove / crowbar from a teammate within range frees the victim; the Listener retreats */
export function tryFree(rt: Rt, L: ListenerAgent, by: ServerPlayer): boolean {
  if (L.state !== 'grab' || !L.grabVictim || by.id === L.grabVictim || !isAlive(rt.crew, by)) return false;
  const victim = rt.crew.players.get(L.grabVictim);
  const range = num(rt.listener, 'shoveRangeM', 2.6);
  const [bx, , bz] = by.pose.p;
  const near = dist(bx, bz, L.x, L.z) <= range || (victim && dist(bx, bz, victim.pose.p[0], victim.pose.p[2]) <= range);
  if (!near) return false;
  rt.ctx.emit(rt.crew, 'monsters.grab', { id: L.id, victim: L.grabVictim, until: 0, state: 'freed', by: by.id, p: [L.x, 0, L.z] });
  L.grabVictim = null;
  goRetreat(rt, L, num(rt.listener, 'freedRetreatSec', 20));
  return true;
}

export function grabPosition(L: ListenerAgent): [number, number] {
  return [L.x + Math.sin(L.yaw) * 0.75, L.z + Math.cos(L.yaw) * 0.75];
}

// ---------------- tick ----------------

export function listenerTick(rt: Rt, L: ListenerAgent, dt: number): void {
  const cm = rt.cm;
  const t = cm.time;
  if (L.dormant) {
    L.active = false;
    L.anim = ANIM.mIdle;
    if (t >= L.wakeAt) wake(rt, L);
    return;
  }
  if (L.state === 'out') {
    L.active = false;
    if (t >= L.outUntil) respawn(rt, L);
    return;
  }
  if (L.state === 'vent') {
    L.active = false;
    if (t >= L.ventUntil) exitVent(rt, L);
    return;
  }
  if (L.state === 'grab') {
    L.anim = ANIM.mAttack;
    const v = L.grabVictim ? rt.crew.players.get(L.grabVictim) : undefined;
    if (!v || !isAlive(rt.crew, v)) {
      L.grabVictim = null;
      goRetreat(rt, L, 10);
      return;
    }
    if (t >= L.grabUntil) {
      const b = L.basis;
      const reason = b ? `heard "${shortQuote(b.text, 40)}"` : 'found you alone';
      const src = b ? `${b.speakerName ?? 'someone'}'s ${b.via === 'radio' ? 'walkie' : b.via === 'text' ? 'message' : 'voice'}` : (cm.spaceCallsign.get(spaceAtXZ(rt, L.x, L.z)) ?? 'in the dark');
      const detail = b ? `${src}, ${Math.max(1, Math.round(t - b.t))} s ago` : src;
      const [px, , pz] = v.pose.p;
      rt.ctx.emit(rt.crew, 'monsters.grab', { id: L.id, victim: v.id, until: 0, state: 'killed', p: [px, 0, pz] });
      L.grabVictim = null;
      rt.kill(L, v, reason, detail);
    }
    return;
  }
  const seen = look(rt, L);
  const calm = relaxed(rt);
  // touch: grab a lone player, back off from a group
  for (const p of rt.alive()) {
    if (rt.hidden(p)) continue;
    const [px, , pz] = p.pose.p;
    if (dist(px, pz, L.x, L.z) > num(rt.listener, 'grabRadiusM', 1.2)) continue;
    if (aloneNow(rt, p)) return startGrab(rt, L, p);
    if (L.intent === 'hunt') { L.intent = 'stalk_player'; L.targetPlayer = p.id; L.state = 'stalk'; L.until = t + 20; }
  }
  // a lone player in sight: hunt
  if (!calm && L.intent !== 'hunt') {
    const lone = seen.find((p) => aloneNow(rt, p));
    if (lone) {
      L.intent = 'hunt';
      L.targetPlayer = lone.id;
      L.state = 'hunt';
      L.st = 0;
      L.until = t + 25;
      L.path = null;
      rt.cue(L, 'click', 12);
    }
  }
  maybeDecide(rt, L);
  // periodic clicks when someone is close (a tell)
  if (t - L.lastClickAt > 3.5) {
    const near = rt.alive().some((p) => dist(p.pose.p[0], p.pose.p[2], L.x, L.z) < 14);
    if (near) { L.lastClickAt = t + cm.rng.next() * 2; rt.cue(L, 'click', 12); }
  }
  const speedPatrol = num(rt.listener, 'patrolSpeed', 2.6), speedInv = num(rt.listener, 'investigateSpeed', 4);
  const step = (speed: number): string => {
    const r = follow(cm, L, dt, speed, canOpen(rt), 0.8, rt.openDoor);
    if (r === 'arrived' && L.ventFrom && L.ventTo) { enterVent(rt, L); return 'vent'; }
    L.anim = r === 'door' ? ANIM.mIdle : speed > 4.5 ? ANIM.mRun : ANIM.mWalk;
    return r;
  };
  switch (L.state) {
    case 'patrol': {
      if (!L.path) {
        const tgt = randomReachable(cm, L.x, L.z, 6, 22, -1, canOpen(rt));
        if (tgt) planTo(cm, L, tgt[0], tgt[1], canOpen(rt));
        else { L.anim = ANIM.mIdle; break; }
      }
      const r = step(speedPatrol);
      if (r === 'arrived' || r === 'blocked') { L.path = null; L.state = 'search'; L.st = 0; L.searchUntil = t + 2 + cm.rng.next() * 3; }
      break;
    }
    case 'investigate': {
      if (!L.path && !L.ventFrom) { L.state = 'search'; L.st = 0; L.searchUntil = t + num(rt.listener, 'searchSec', 4); break; }
      const r = step(speedInv);
      if (r === 'arrived' || r === 'blocked') { L.path = null; L.state = 'search'; L.st = 0; L.searchUntil = t + num(rt.listener, 'searchSec', 4); }
      break;
    }
    case 'search': {
      L.anim = ANIM.mAlert;
      L.yaw += dt * 0.9 * Math.sin(L.st * 1.3);
      if (t >= L.searchUntil) startPatrol(rt, L);
      break;
    }
    case 'ambush': {
      if (L.path) {
        const r = step(speedInv);
        if (r === 'arrived' || r === 'blocked') L.path = null;
      } else {
        L.anim = ANIM.mIdle;
        const s = cm.layout.spaces[L.targetSpace];
        if (s) turnToward(L, yawTo(L.x, L.z, s.rect.x + s.rect.w / 2, s.rect.y + s.rect.h / 2), dt, 2);
      }
      if (t >= L.until) startPatrol(rt, L);
      break;
    }
    case 'stalk': {
      const k = L.targetPlayer ? L.known.get(L.targetPlayer) : undefined;
      const target = L.targetPlayer ? rt.crew.players.get(L.targetPlayer) : undefined;
      if (!k || !target || !isAlive(rt.crew, target) || t - k.t > 10 || t >= L.until) {
        if (k && !(t - k.t > 30)) { L.intent = 'investigate_room'; L.targetSpace = spaceAtXZ(rt, k.x, k.z); goTo(rt, L, k.x, k.z, 'investigate'); }
        else startPatrol(rt, L);
        break;
      }
      const d = dist(k.x, k.z, L.x, L.z);
      const lo = num(rt.listener, 'stalkMinM', 6), hi = num(rt.listener, 'stalkMaxM', 10);
      if (!calm && aloneNow(rt, target) && d <= num(rt.listener, 'lungeRangeM', 6) && seen.includes(target)) {
        L.intent = 'hunt';
        L.state = 'hunt';
        L.st = 0;
        L.until = t + 20;
        break;
      }
      if (d > hi) {
        if (!L.path || t - L.planAt > 0.7) planTo(cm, L, k.x, k.z, canOpen(rt));
        step(speedInv);
      } else if (d > lo) {
        if (!L.path || t - L.planAt > 0.7) planTo(cm, L, k.x, k.z, canOpen(rt));
        step(speedPatrol * 0.8);
      } else {
        L.path = null;
        L.anim = ANIM.mIdle;
        turnToward(L, yawTo(L.x, L.z, k.x, k.z), dt, 3);
      }
      break;
    }
    case 'hunt': {
      const target = L.targetPlayer ? rt.crew.players.get(L.targetPlayer) : undefined;
      const k = L.targetPlayer ? L.known.get(L.targetPlayer) : undefined;
      if (!target || !k || !isAlive(rt.crew, target) || t - k.t > 6 || t >= L.until || calm) {
        if (k) { L.intent = 'investigate_room'; goTo(rt, L, k.x, k.z, 'investigate'); }
        else startPatrol(rt, L);
        break;
      }
      // while it can sense the target it closes in (it saw or heard them within the last seconds)
      const sensed = seen.includes(target) || t - k.t < 1.5;
      const gx = sensed ? target.pose.p[0] : k.x, gz = sensed ? target.pose.p[2] : k.z;
      if (sensed) L.known.set(target.id, { x: gx, z: gz, t: seen.includes(target) ? t : k.t });
      if (!L.path || t - L.planAt > 0.35) planTo(cm, L, gx, gz, canOpen(rt));
      const d = dist(gx, gz, L.x, L.z);
      step(d <= num(rt.listener, 'lungeRangeM', 6) ? num(rt.listener, 'lungeSpeed', 6.5) : speedInv);
      break;
    }
    default:
      startPatrol(rt, L);
  }
}

export function listenerOf(rt: Rt): ListenerAgent | null {
  return (rt.cm.agents.find((a) => a.kind === 'listener') as ListenerAgent | undefined) ?? null;
}

/** test/debug: force the Listener awake now */
export function forceWake(rt: Rt, L: ListenerAgent): void {
  if (L.dormant) {
    L.wakeAt = rt.cm.time;
    wake(rt, L);
  }
}

export { maybeDecide };
