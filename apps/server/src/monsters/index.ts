// Owner: track (c) Monsters (apps/server/src/monsters/**). Server plugin entry: perception (noise bus from ⑤, voice
// loudness, interaction hooks), Hound / Mannequin / Listener, the director (apps/server/src/director), snapshots,
// requests ('monsters.see' | 'monsters.shove' | 'monsters.log') and dev-only dbg.monsters.* test controls.
import { BAND } from '@dead-air/shared/constants.ts';
import { fieldAt, soundFlood } from '@dead-air/shared/nav/index.ts';
import { STANCE } from '@dead-air/shared/state.ts';
import type { DirectorEventKind } from '@dead-air/shared/messages/monsters.ts';
import type { Crew, PlayerPose, ServerContext, ServerPlayer } from '../core/types.ts';
import { SYSTEM_ORDER } from '../core/types.ts';
import { emitNoise, onNoise, onProxText } from '../players/noise.ts';
import { isTaunt } from '../ai/text.ts';
import { bindMonstersImpl, listener as listenerApi, onMonsterEvent } from './api.ts';
import type { HeardUtterance, ListenerIntent, MonsterEvent, MonstersImpl } from './api.ts';
import { coverNear } from './cover.ts';
import { describeEars, earForText, earForUtterance, earRelayed, earsSnapshot } from './earwigs.ts';
import { bindExternal, boundApis, holdingCrowbar, isAlive } from './ext.ts';
import { inCab } from './geo.ts';
import { ambushProbe, forceGrab, forceIntent, forceWake, grabPosition, knockedSpot, listenerDoorClosed, listenerFlash, listenerHeardUtterance, listenerMelee, listenerOf, listenerStruggle, listenerSummary, listenerVentTrip, tryFree, warnState } from './listener.ts';
import { litAt, scheduleBlink } from './mannequin.ts';
import { afterDeath, fillSnapshot, makeRt, runtimeStats, startContract, startHubRuntime, stopRuntime, tickRuntime } from './runtime.ts';
import type { Rt } from './runtime.ts';
import { bal, crewM, fairOn, num } from './types.ts';
import type { Agent, CrewMonsters, DecisionEntry, HoundAgent, ListenerAction, ListenerAgent, MannequinAgent, SnatcherAgent } from './types.ts';
import { applyVictimPose, describeSnatcher, pull as snatchPull, rattle as snatchRattle, readyNow, snatcherOf, snatchVictim, struggle as snatchStruggle } from './snatcher.ts';
import { directorDeath, directorState, installDirector, resetDirector, runDirectorEvent } from '../director/index.ts';

export function install(ctx: ServerContext): void | Promise<void> {
  const log = ctx.log('monsters');
  const rts = new WeakMap<CrewMonsters, Rt>();
  const lastLog = new WeakMap<Crew, DecisionEntry[]>();
  const phaseAt = new WeakMap<Crew, number>();

  const onKilled = (crew: Crew, pid: string, killer: Agent | null, x: number, z: number) => {
    const cm = crewM(crew);
    if (!cm) return;
    const seen = cm.deaths.get(pid);
    if (seen !== undefined && cm.time - seen < 5) return; // dedupe (our kill + interaction's onDeath)
    cm.deaths.set(pid, cm.time);
    const rt = rtFor(crew);
    if (rt) afterDeath(rt, killer, x, z);
    directorDeath(crew, x, z);
  };

  const rtFor = (crew: Crew): Rt | null => {
    const cm = crewM(crew);
    if (!cm) return null;
    let rt = rts.get(cm);
    if (!rt) rts.set(cm, (rt = makeRt(ctx, crew, cm, onKilled)));
    return rt;
  };

  /** v1.3 contract-end log line: what the Listener heard (counts and metres only; never names or text) */
  const logContractEnd = (crew: Crew) => {
    const cm = crewM(crew);
    if (!cm || cm.mode !== 'contract') return;
    const L = cm.agents.find((a) => a.kind === 'listener') as ListenerAgent | undefined;
    if (L) log.info(`crew ${crew.code}: contract end: the Listener ${listenerSummary(L)}`);
  };

  const startMonsters = (crew: Crew, o: { risk: number; contractIndex: number }): boolean => {
    const L = crew.layout;
    if (!L || L.kind !== 'facility') {
      log.warn(`startMonsters(${crew.code}): no facility layout (phase ${crew.phase})`);
      return false;
    }
    const cur = crewM(crew);
    if (cur && cur.mode === 'contract' && cur.layout === L) return true; // idempotent
    logContractEnd(crew);
    stopRuntime(crew);
    resetDirector(crew);
    const cm = startContract(ctx, crew, o);
    if (!cm) return false;
    lastLog.set(crew, cm.log);
    void rebind();
    log.info(`crew ${crew.code}: monsters started (risk ${cm.risk}, contract ${cm.contractIndex}, ${cm.agents.map((a) => a.id).join(', ')})`);
    return true;
  };

  const startHub = (crew: Crew): boolean => {
    const L = crew.layout;
    if (!L || L.kind !== 'hub') return false;
    const cur = crewM(crew);
    if (cur && cur.mode === 'hub' && cur.layout === L) return true;
    stopRuntime(crew);
    const cm = startHubRuntime(ctx, crew);
    if (cm) log.info(`crew ${crew.code}: kennel hound in the hub`);
    return !!cm;
  };

  const stopMonsters = (crew: Crew) => {
    const cm = crewM(crew);
    if (cm) lastLog.set(crew, cm.log);
    logContractEnd(crew);
    stopRuntime(crew);
  };

  const heard = (crew: Crew, u: HeardUtterance): boolean => {
    const rt = rtFor(crew);
    if (!rt || rt.cm.mode !== 'contract' || !u || typeof u.text !== 'string') return false;
    const L = listenerOf(rt);
    if (!L) return false;
    const sp = u.speaker ? crew.players.get(String(u.speaker)) : undefined;
    let room = typeof u.roomId === 'number' && u.roomId >= 0 ? u.roomId : -1;
    if (room >= 0) { /* AI track's roomId */ } else if (typeof u.room === 'number') room = u.room;
    else if (typeof u.room === 'string' && u.room) room = rt.cm.callsignSpace.get(u.room.toUpperCase()) ?? (/^\d+$/.test(u.room) ? Number(u.room) : -1);
    if (room < 0 && sp) room = rt.cm.layout.owner[Math.floor(sp.pose.p[2]) * rt.cm.layout.W + Math.floor(sp.pose.p[0])] ?? -1;
    const durMs = Number(u.endedAt) - Number(u.startedAt);
    const seg = {
      segId: String(u.segId ?? `${u.speaker}:${ctx.now()}`),
      speaker: sp?.id ?? (u.speaker ? String(u.speaker) : null),
      text: u.text,
      room,
      via: u.via ?? (sp?.radio ? 'radio' : 'voice'),
      band: Number(u.band ?? sp?.band ?? BAND.talk),
      heard: typeof u.hearers?.listener === 'boolean' ? u.hearers.listener : undefined,
      durSec: Number.isFinite(durMs) && durMs > 0 ? durMs / 1000 : 2,
      x: Array.isArray(u.pos) ? Number(u.pos[0]) : undefined,
      z: Array.isArray(u.pos) ? Number(u.pos[1]) : undefined,
      taunt: u.taunt === true,
    };
    const line = listenerHeardUtterance(rt, L, seg);
    if (line) return true;
    // v1.3 (flag earwigs): it did not hear it itself; an ear that heard this speaker's voice (not deaf) relays it
    if (sp) {
      const ear = earForUtterance(rt, sp.id, seg.durSec);
      if (ear) {
        const viaEar = listenerHeardUtterance(rt, L, { ...seg, ear: { id: ear.id, space: ear.space, x: ear.x, z: ear.z } });
        if (viaEar) { earRelayed(rt, ear); return true; }
      }
    }
    return false;
  };

  const impl: MonstersImpl = {
    startMonsters,
    stopMonsters,
    startHub,
    heard,
    decisionLog: (crew) => crewM(crew)?.log ?? lastLog.get(crew) ?? [],
    positions: (crew) => (crewM(crew)?.agents ?? []).map((a) => ({ id: a.id, kind: a.kind, x: a.x, z: a.z, active: a.active, state: a.state })),
    listenerCanHear: (crew, x, z, radiusM) => {
      const rt = rtFor(crew);
      const L = rt ? listenerOf(rt) : null;
      if (!rt || !L || inCab(rt.cm.layout, x, z) || inCab(rt.cm.layout, L.x, L.z)) return false;
      const f = soundFlood(rt.cm.grid, x, z, radiusM, rt.cm.doorOpen);
      return fieldAt(rt.cm.grid, f, L.x, L.z) <= radiusM;
    },
    // v1.2: G1 (crawl vents: never while a vent is busy) and E4
    ventInUse: (crew, ventItemId) => {
      const cm = crewM(crew);
      if (!cm || cm.mode !== 'contract') return false;
      if (snatchVictim(cm)) return true; // any active snatch, crew-wide (a rescuer never crawls away)
      const L = cm.agents.find((a) => a.kind === 'listener') as ListenerAgent | undefined;
      return !!L && listenerVentTrip(L, String(ventItemId));
    },
    isGrabbed: (crew, pid) => {
      const cm = crewM(crew);
      if (!cm || cm.mode !== 'contract') return null;
      if (snatchVictim(cm) === pid) return 'snatcher';
      const L = cm.agents.find((a) => a.kind === 'listener') as ListenerAgent | undefined;
      if (!L) return null;
      if (L.state === 'grab' && L.grabVictim === pid) return 'listener';
      const rt = rtFor(crew);
      return rt && knockedSpot(rt, L, pid) ? 'listener' : null;
    },
  };
  bindMonstersImpl(impl);

  // dev only: the last monster events + Listener decisions per crew (dbg.monsters.events; both are server-only APIs)
  const evLog = new WeakMap<Crew, (MonsterEvent & { n: number })[]>();
  const decLog = new WeakMap<Crew, { n: number; action: string; speaker: string | null; speakerId: string | null; valid: boolean; line: string }[]>();
  let evSeq = 0;
  if (ctx.env.dev) {
    onMonsterEvent((crew, e) => {
      let arr = evLog.get(crew);
      if (!arr) evLog.set(crew, (arr = []));
      arr.push({ ...e, n: ++evSeq });
      if (arr.length > 300) arr.splice(0, arr.length - 300);
    });
    listenerApi.onDecision((crew, d) => {
      let arr = decLog.get(crew);
      if (!arr) decLog.set(crew, (arr = []));
      arr.push({ n: ++evSeq, action: d.action, speaker: d.speaker, speakerId: d.speakerId ?? null, valid: d.valid, line: d.line });
      if (arr.length > 100) arr.splice(0, arr.length - 100);
    });
  }

  // ---- external tracks (optional) ----
  const rebind = async () => {
    try {
      await bindExternal(ctx, {
        onDeath: (crew, pid, cause) => {
          const p = crew.players.get(pid);
          if (!p) return;
          const killer = cause && typeof cause === 'object' ? String((cause as { killer?: unknown }).killer ?? '') : '';
          const cm = crewM(crew);
          const agent = cm?.agents.find((a) => a.kind === killer) ?? null;
          onKilled(crew, pid, agent, p.pose.p[0], p.pose.p[2]);
        },
        onMelee: (crew, attacker, args) => {
          const p = crew.players.get(attacker);
          const rt = rtFor(crew);
          const L = rt ? listenerOf(rt) : null;
          // frees a grab; v1.2: a hit during hunt / stalk / notice staggers it (eye position + swing direction)
          return !!(p && rt && L && rt.cm.mode === 'contract' && listenerMelee(rt, L, p, args[0], args[1]));
        },
        onUtterance: (crew, u) => { heard(crew, u as HeardUtterance); },
        onDoor: (crew, id, open, by) => {
          if (open || !by) return;
          const rt = rtFor(crew);
          const L = rt ? listenerOf(rt) : null;
          if (rt && L && rt.cm.mode === 'contract') listenerDoorClosed(rt, L, id, by);
        },
        onItemEvent: (crew, e) => {
          // v1.2 (SHOULD): a flashbulb fired toward the Listener makes it flinch and retreat
          const ev = e as { kind?: string; type?: string; pid?: string; p?: unknown; dir?: unknown } | null;
          if (!ev || ev.kind !== 'use' || ev.type !== 'flashbulb' || typeof ev.pid !== 'string') return;
          const p = crew.players.get(ev.pid);
          const rt = rtFor(crew);
          const L = rt ? listenerOf(rt) : null;
          if (p && rt && L && rt.cm.mode === 'contract') listenerFlash(rt, L, p, ev.p, ev.dir);
        },
      });
    } catch (e) {
      log.warn(`external bind failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  // ---- noise bus (⑤ players: footsteps + every track's action noises) ----
  onNoise((crew, n) => {
    const cm = crewM(crew);
    if (!cm || cm.mode === 'off') return;
    cm.noiseQ.push({ x: n.x, z: n.z, radiusM: n.radiusM, kind: String(n.kind), source: n.source });
  });
  // proximity text reaches the Listener the same way speech does
  onProxText((crew, e) => {
    const rt = rtFor(crew);
    const L = rt ? listenerOf(rt) : null;
    if (!rt || !L || rt.cm.mode !== 'contract') return;
    const f = soundFlood(rt.cm.grid, e.x, e.z, e.radiusM, rt.cm.doorOpen);
    const hearsIt = !inCab(rt.cm.layout, e.x, e.z) && fieldAt(rt.cm.grid, f, L.x, L.z) <= e.radiusM;
    const room = rt.cm.layout.owner[Math.floor(e.z) * rt.cm.layout.W + Math.floor(e.x)] ?? -1;
    const seg = { segId: `text:${e.player.id}:${e.t}`, speaker: e.player.id, text: e.text, room, via: 'text' as const, band: BAND.talk, heard: hearsIt, durSec: 1, x: e.x, z: e.z, taunt: isTaunt(e.text) };
    if (listenerHeardUtterance(rt, L, seg) || hearsIt) return;
    // v1.3 (flag earwigs): a line typed next to an ear reaches it the way speech does
    const ear = earForText(rt, e.x, e.z, e.radiusM, f);
    if (ear && listenerHeardUtterance(rt, L, { ...seg, ear: { id: ear.id, space: ear.space, x: ear.x, z: ear.z } })) earRelayed(rt, ear);
  });

  // ---- systems + hooks ----
  ctx.registerSystem({
    name: 'monsters',
    order: SYSTEM_ORDER.monsters,
    tick(dt, crew) {
      const L = crew.layout;
      let cm = crewM(crew);
      if (crew.phase === 'hub') {
        if (L && L.kind === 'hub' && (!cm || cm.layout !== L)) startHub(crew);
      } else if (crew.phase === 'contract') {
        if (L && L.kind === 'facility' && (!cm || cm.layout !== L || cm.mode !== 'contract')) {
          // meta normally calls startMonsters right after setPhase; auto-start if it did not
          const since = performance.now() - (phaseAt.get(crew) ?? 0);
          if (since > 2500) {
            const risk = Number(L.metrics?.risk ?? 1) || 1;
            const shift = (crew.slices.meta as { shift?: { contract?: number } } | undefined)?.shift;
            startMonsters(crew, { risk, contractIndex: Number(shift?.contract ?? 0) || 0 });
          }
        }
      } else if (cm) stopMonsters(crew);
      cm = crewM(crew);
      if (!cm || cm.mode === 'off') return;
      if (cm.layout !== crew.layout) { stopMonsters(crew); return; }
      const rt = rtFor(crew)!;
      rt.hound = bal(ctx, 'hound');
      rt.mannequin = bal(ctx, 'mannequin');
      rt.listener = bal(ctx, 'listener');
      rt.snatcher = bal(ctx, 'snatcher');
      rt.retreatBal = bal(ctx, 'retreat');
      tickRuntime(rt, dt);
    },
  });

  installDirector(ctx, rtFor);

  ctx.hooks.crewSnapshot.push((crew, snap) => {
    const cm = crewM(crew);
    if (cm && cm.mode !== 'off') {
      fillSnapshot(cm, snap);
      // v1.3 (flag earwigs): the ears as static dyn entries 'ear:<n>' (the client draws them)
      if (cm.ears?.length) { const rt = rtFor(crew); if (rt) earsSnapshot(rt, snap); }
    }
  });

  ctx.hooks.phase.push((crew, _from, to) => {
    phaseAt.set(crew, performance.now());
    const cm = crewM(crew);
    if (!cm) return;
    if ((cm.mode === 'contract' && to !== 'contract') || (cm.mode === 'hub' && to !== 'hub')) stopMonsters(crew);
  });

  // a grabbed victim is held in place; pose cadence is tracked for the mannequin's stall tolerance
  ctx.hooks.pose.push((crew, player, pose: PlayerPose) => {
    const ps = (player.slices.monsters ??= {}) as { poses?: number; lastPose?: number };
    ps.poses = (ps.poses ?? 0) + 1;
    ps.lastPose = performance.now();
    const rt = rtFor(crew);
    // the Snatcher's victim follows the drag (and vanishes into the duct)
    const sn = snatcherOf(rt?.cm ?? null);
    if (sn && sn.victim === player.id && (sn.state === 'drop' || sn.state === 'drag' || sn.state === 'duct')) {
      applyVictimPose(sn, pose);
      return;
    }
    const L = rt ? listenerOf(rt) : null;
    if (!L) return;
    // v1.2 knockdown: pinned where it knocked them down for knockdownSec
    const kn = rt ? knockedSpot(rt, L, player.id) : null;
    if (kn) { pose.p = [kn.x, pose.p[1], kn.z]; return; }
    if (L.state !== 'grab' || L.grabVictim !== player.id) return;
    const [gx, gz] = grabPosition(L);
    pose.p = [gx, pose.p[1], gz];
  });

  ctx.hooks.leave.push((crew, player, info) => {
    if (!info.final) return;
    const cm = crewM(crew);
    if (!cm) return;
    for (const m of cm.sight.values()) m.delete(player.id);
    cm.blinks.delete(player.id);
  });

  // ---- requests ----
  ctx.registerReq('monsters.see', (crew, player, args) => {
    const cm = crewM(crew);
    const s = (args as { s?: unknown } | null)?.s;
    if (!cm || cm.mode !== 'contract' || !s || typeof s !== 'object') return { ok: false };
    const ttl = num(bal(ctx, 'mannequin'), 'sightTtlMs', 300);
    const now = performance.now();
    for (const [id, vis] of Object.entries(s as Record<string, unknown>)) {
      if (!cm.agents.some((a) => a.id === id && a.kind === 'mannequin')) continue;
      let m = cm.sight.get(id);
      if (!m) cm.sight.set(id, (m = new Map()));
      if (vis === true && isAlive(crew, player)) m.set(player.id, { until: now + ttl });
      else m.delete(player.id);
    }
    return { ok: true };
  });

  ctx.registerReq('monsters.shove', (crew, player, args) => {
    const rt = rtFor(crew);
    const L = rt ? listenerOf(rt) : null;
    if (!rt || !L) return { ok: false, freed: false };
    const kind = (args as { kind?: string } | null | undefined)?.kind === 'melee' ? 'melee' : 'shove';
    if (kind === 'melee' && !holdingCrowbar(crew, player)) return { ok: false, freed: false };
    return { ok: true, freed: tryFree(rt, L, player) };
  });

  ctx.registerReq('monsters.log', (crew) => ({ lines: impl.decisionLog(crew).map((e) => e.line) }));

  // the victim mashes E (struggle): v1.2 Listener grab (1.0 = free), else the Snatcher drag; teammates hold E at the
  // Snatcher rescue spot (heartbeat every <= 250 ms)
  ctx.registerReq('monsters.struggle', (crew, player) => {
    const rt = rtFor(crew);
    if (!rt) return { ok: false, struggle: 0 };
    const L = listenerOf(rt);
    if (L && L.state === 'grab' && L.grabVictim === player.id && fairOn(ctx)) return listenerStruggle(rt, L, player);
    const sn = snatcherOf(rt.cm);
    if (!sn) return { ok: false, struggle: 0 };
    return { ok: sn.victim === player.id, struggle: snatchStruggle(rt, sn, player) };
  });
  ctx.registerReq('monsters.pull', (crew, player, args) => {
    const rt = rtFor(crew);
    const sn = snatcherOf(rt?.cm ?? null);
    if (!rt || !sn || !sn.victim) return { ok: false, pull: 0, inRange: false };
    const on = (args as { on?: boolean } | null | undefined)?.on !== false;
    const r = snatchPull(rt, sn, player, on);
    return { ok: true, ...r };
  });

  // ---- dev-only test controls ----
  ctx.registerDbg('monsters.state', (crew) => {
    const cm = crewM(crew);
    if (!cm) return { mode: 'off', bound: boundApis(), log: (lastLog.get(crew) ?? []).map((e) => e.line) };
    return {
      mode: cm.mode, time: Math.round(cm.time * 100) / 100, risk: cm.risk, contractIndex: cm.contractIndex, frozen: cm.frozen,
      agents: cm.agents.map((a) => { const d = describe(a, cm.time); if (a.kind === 'mannequin') { const rt = rtFor(crew); d.lit = rt ? litAt(rt, a.x, a.z) : null; } return d; }),
      poses: [...crew.players.values()].map((p) => ({ id: p.id, p: p.pose.p.map((v) => Math.round(v * 100) / 100), yaw: Math.round(p.pose.yaw * 100) / 100, light: p.pose.light, alive: isAlive(crew, p) })),
      log: cm.log.map((e) => ({ line: e.line, action: e.action, target: e.target, source: e.source, valid: e.valid, t: Math.round(e.t) })),
      director: directorState(crew),
      blinks: Object.fromEntries([...cm.blinks].map(([k, v]) => [k, { next: Math.round(v.next * 100) / 100, end: Math.round(v.end * 100) / 100 }])),
      sight: Object.fromEntries([...cm.sight].map(([k, v]) => [k, [...v.keys()]])),
      bound: boundApis(),
      stats: runtimeStats(),
      // v1.3 (flag earwigs)
      ears: (() => { const rt = rtFor(crew); return rt ? describeEars(rt) : []; })(),
    };
  });
  ctx.registerDbg('monsters.start', async (crew, _p, args) => {
    const a = (args ?? {}) as { risk?: number; contractIndex?: number; seed?: string; players?: number; fixture?: boolean };
    if (!crew.layout || crew.layout.kind !== 'facility' || a.seed) {
      const gen = await import('@dead-air/shared/procgen/index.ts');
      const layout = gen.generateFacility({ seed: a.seed ?? `monsters-${crew.code}`, players: a.players ?? Math.max(2, ctx.crews.connected(crew).length), risk: a.risk ?? 1 });
      ctx.setPhase(crew, 'contract', layout);
    } else if (crew.phase !== 'contract') ctx.setPhase(crew, 'contract');
    const ok = startMonsters(crew, { risk: a.risk ?? 1, contractIndex: a.contractIndex ?? 0 });
    const cm = crewM(crew);
    return { ok, seed: crew.layout?.seed, hash: crew.layout?.hash, agents: cm?.agents.map((x) => describe(x)) ?? [] };
  });
  ctx.registerDbg('monsters.hub', async (crew) => {
    if (!crew.layout || crew.layout.kind !== 'hub') {
      const gen = await import('@dead-air/shared/procgen/index.ts');
      ctx.setPhase(crew, 'hub', gen.generateHub());
    }
    return { ok: startHub(crew), agents: crewM(crew)?.agents.map((x) => describe(x)) ?? [] };
  });
  ctx.registerDbg('monsters.stop', (crew) => { stopMonsters(crew); return { ok: true }; });
  ctx.registerDbg('monsters.freeze', (crew, _p, args) => {
    const cm = crewM(crew);
    if (cm) cm.frozen = (args as { on?: boolean } | null)?.on !== false;
    return { frozen: cm?.frozen ?? null };
  });
  ctx.registerDbg('monsters.noise', (crew, player, args) => {
    const a = (args ?? {}) as { x?: number; z?: number; radiusM?: number; kind?: string; source?: string };
    const [px, , pz] = player.pose.p;
    emitNoise(crew, { x: Number(a.x ?? px), z: Number(a.z ?? pz), radiusM: Number(a.radiusM ?? 10), kind: String(a.kind ?? 'test'), source: a.source ?? player.id });
    return { ok: true };
  });
  ctx.registerDbg('monsters.utter', (crew, player, args) => {
    const a = (args ?? {}) as Partial<HeardUtterance> & { listener?: boolean };
    const now = ctx.now();
    const ok = heard(crew, {
      segId: a.segId ?? `dbg:${now}`, speaker: a.speaker ?? player.id, text: String(a.text ?? ''), band: a.band ?? BAND.talk,
      room: a.room ?? null, startedAt: now - 1500, endedAt: now, via: a.via,
      hearers: a.listener === undefined ? undefined : { listener: a.listener },
      taunt: a.taunt === true || isTaunt(String(a.text ?? '')),
    });
    return { ok };
  });
  ctx.registerDbg('monsters.place', (crew, _p, args) => {
    const a = (args ?? {}) as { id?: string; x?: number; z?: number; yaw?: number; state?: string; active?: boolean; outSec?: number; anim?: number };
    const cm = crewM(crew);
    const ag = cm?.agents.find((q) => q.id === a.id || q.kind === a.id);
    if (!cm || !ag) return { ok: false };
    if (a.x !== undefined) ag.x = ag.lastX = Number(a.x);
    if (a.z !== undefined) ag.z = ag.lastZ = Number(a.z);
    if (a.yaw !== undefined) ag.yaw = Number(a.yaw);
    ag.path = null;
    // no door pause carried over from before the move (it would open that door from wherever it is now)
    ag.doorWait = 0;
    ag.pendingDoor = -1;
    if (a.state) { ag.state = a.state; ag.st = 0; }
    if (a.active !== undefined) ag.active = !!a.active;
    if (a.anim !== undefined) ag.anim = Number(a.anim);
    if (a.active && ag.kind === 'listener') (ag as ListenerAgent).dormant = false;
    if (ag.kind === 'listener' && a.state) {
      // tests: a clean slate for the new state ('ambush' = stand still facing `yaw` for holdSec, watching)
      const L = ag as ListenerAgent;
      const hold = Number((args as { holdSec?: number } | null)?.holdSec ?? 120);
      L.targetPlayer = null;
      L.pounceUntil = 0;
      L.grabVictim = null;
      L.ventFrom = L.ventTo = null;
      L.ventAfter = null;
      L.ventIds = null;
      L.intent = a.state === 'ambush' ? 'ambush_room' : a.state === 'patrol' || a.state === 'search' ? 'patrol' : L.intent;
      if (a.state === 'ambush') { L.targetSpace = -1; L.until = cm.time + hold; }
      if (a.state === 'search') L.searchUntil = cm.time + hold;
    }
    if (a.active && ag.kind === 'mannequin') (ag as MannequinAgent).spawned = true;
    if (ag.kind === 'hound') { const h = ag as HoundAgent; h.timer = 3; h.lastNoiseAt = -100; h.heardAt = -100; }
    if (a.outSec !== undefined) rtFor(crew)?.retreat(ag, Number(a.outSec));
    return { ok: true, agent: describe(ag) };
  });
  ctx.registerDbg('monsters.tp', (crew, player, args) => {
    const a = (args ?? {}) as { id?: string; x?: number; z?: number; yaw?: number; light?: 0 | 1; stance?: number };
    const p = a.id ? crew.players.get(a.id) : player;
    if (!p) return { ok: false };
    p.pose = { ...p.pose, p: [Number(a.x ?? p.pose.p[0]), 0, Number(a.z ?? p.pose.p[2])], yaw: Number(a.yaw ?? p.pose.yaw), light: a.light ?? p.pose.light, stance: a.stance ?? p.pose.stance ?? STANCE.stand };
    p.poseAt = performance.now();
    return { ok: true, p: p.pose.p };
  });
  ctx.registerDbg('monsters.wake', (crew) => {
    const rt = rtFor(crew);
    const L = rt ? listenerOf(rt) : null;
    if (!rt || !L) return { ok: false };
    forceWake(rt, L);
    return { ok: true, agent: describe(L) };
  });
  ctx.registerDbg('monsters.spawnMannequin', (crew, _p, args) => {
    const rt = rtFor(crew);
    const m = rt?.cm.agents.find((a) => a.kind === 'mannequin') as MannequinAgent | undefined;
    if (!rt || !m) return { ok: false, reason: 'no mannequin this contract (risk >= 2 or contractIndex >= 2)' };
    const a = (args ?? {}) as { x?: number; z?: number };
    m.spawned = true;
    m.active = true;
    m.state = 'frozen';
    m.st = 0;
    m.path = null;
    if (a.x !== undefined) m.x = m.lastX = Number(a.x);
    if (a.z !== undefined) m.z = m.lastZ = Number(a.z);
    const blinkIn = Number((args as { blinkIn?: number } | null)?.blinkIn ?? 18);
    for (const p of rt.alive()) scheduleBlink(rt, p.id, blinkIn + rt.cm.rng.next() * 0.01);
    return { ok: true, agent: describe(m) };
  });
  ctx.registerDbg('monsters.snatcher', (crew, _p, args) => {
    const rt = rtFor(crew);
    const sn = snatcherOf(rt?.cm ?? null);
    if (!rt || !sn) return { ok: false, reason: 'no snatcher this contract (risk >= 2 or contractIndex >= snatcher.minContractIndex (2), layout with vents)' };
    const a = (args ?? {}) as { op?: string; grate?: string };
    if (a.op === 'ready') readyNow(rt, sn);
    if (a.op === 'rattle') {
      const g = sn.grates.find((q) => q.id === a.grate) ?? sn.grate;
      if (g) snatchRattle(rt, sn, g, true);
    }
    return { ok: true, agent: describe(sn, rt.cm.time) };
  });
  ctx.registerDbg('monsters.director', (crew, _p, args) => {
    const rt = rtFor(crew);
    if (!rt) return { ok: false };
    const kind = String((args as { kind?: string } | null)?.kind ?? 'flicker') as DirectorEventKind;
    return { ok: runDirectorEvent(rt, kind, 'dbg'), state: directorState(crew) };
  });
  ctx.registerDbg('monsters.blink', (crew, _p, args) => {
    const rt = rtFor(crew);
    const a = (args ?? {}) as { id?: string; inSec?: number };
    if (!rt || !a.id) return { ok: false };
    scheduleBlink(rt, a.id, Number(a.inSec ?? 1));
    return { ok: true };
  });
  // test-only fake AI brain: returns the given intent (or null) after delayMs, for validation tests
  ctx.registerDbg('monsters.fakeBrain', (_crew, _p, args) => {
    const a = (args ?? {}) as { intent?: ListenerIntent | null; delayMs?: number; off?: boolean };
    if (a.off) { listenerApi.setBrain(null); return { ok: true, brain: 'rule' }; }
    listenerApi.setBrain(async () => {
      await new Promise((r) => setTimeout(r, Number(a.delayMs ?? 50)));
      return a.intent ? { ...a.intent, source: 'fake' } : null;
    });
    return { ok: true, brain: 'fake' };
  });
  ctx.registerDbg('monsters.kill', (crew, player, args) => {
    // simulate a death elsewhere (e.g. interaction): retreat logic
    const id = (args as { id?: string } | null)?.id ?? player.id;
    const p = crew.players.get(id);
    if (!p) return { ok: false };
    onKilled(crew, id, null, p.pose.p[0], p.pose.p[2]);
    return { ok: true };
  });
  // ---- v1.2 test controls ----
  // flip a monsters flag in memory (dev only; config/flags.json is untouched; dbg.reloadConfig restores it)
  ctx.registerDbg('monsters.flag', (_crew, _p, args) => {
    const a = (args ?? {}) as { name?: string; on?: boolean };
    const allowed = ['listenerFairV12', 'mannequin', 'snatcher', 'director', 'listenerAi', 'earwigs'];
    if (!a.name || !allowed.includes(a.name)) return { ok: false, allowed };
    ctx.flags[a.name] = a.on !== false;
    return { ok: true, flags: Object.fromEntries(allowed.map((k) => [k, ctx.flags[k]])) };
  });
  // override monster balance knobs in memory: { section: 'listener', set: { noticeSec: 2 } } (dbg.reloadConfig restores)
  ctx.registerDbg('monsters.tune', (_crew, _p, args) => {
    const a = (args ?? {}) as { section?: string; set?: Record<string, unknown> };
    const m = ((ctx.balance as Record<string, Record<string, unknown>>).monsters ??= {}) as Record<string, Record<string, unknown>>;
    if (!a.section || !a.set) return { ok: false };
    const s = (m[a.section] ??= {});
    Object.assign(s, a.set);
    return { ok: true, section: s };
  });
  // grab a player now (knockdown: true = force the knockdown, false = skip it)
  ctx.registerDbg('monsters.grab', (crew, player, args) => {
    const a = (args ?? {}) as { id?: string; knockdown?: boolean };
    const rt = rtFor(crew);
    const L = rt ? listenerOf(rt) : null;
    const p = crew.players.get(a.id ?? player.id);
    if (!rt || !L || !p || !p.alive || L.state === 'grab') return { ok: false };
    forceGrab(rt, L, p, a.knockdown);
    return { ok: true, agent: describe(L, rt.cm.time) };
  });
  ctx.registerDbg('monsters.events', (crew, _p, args) => {
    const since = Number((args as { since?: number } | null)?.since ?? 0);
    return { events: (evLog.get(crew) ?? []).filter((e) => e.n > since), decisions: (decLog.get(crew) ?? []).filter((e) => e.n > since) };
  });
  ctx.registerDbg('monsters.cover', (crew, _p, args) => {
    const a = (args ?? {}) as { x?: number; z?: number; r?: number };
    if (!crew.layout) return { boxes: [] };
    return { boxes: coverNear(crew.layout, Number(a.x ?? 0), Number(a.z ?? 0), Number(a.r ?? 4)) };
  });
  ctx.registerDbg('monsters.intent', (crew, _p, args) => {
    const a = (args ?? {}) as { action?: string; space?: number; player?: string | null };
    const rt = rtFor(crew);
    const L = rt ? listenerOf(rt) : null;
    if (!rt || !L || !a.action) return { ok: false };
    forceIntent(rt, L, a.action as ListenerAction, Number(a.space ?? -1), a.player ?? null);
    return { ok: true, agent: describe(L, rt.cm.time) };
  });
  ctx.registerDbg('monsters.ambushProbe', (crew, _p, args) => {
    const rt = rtFor(crew);
    const L = rt ? listenerOf(rt) : null;
    if (!rt || !L) return { ok: false };
    return { ok: true, ...ambushProbe(rt, L, Number((args as { space?: number } | null)?.space ?? -1)) };
  });
  // tests: the Listener forgets a player (warnings, notices, knockdowns, what it heard / saw of them)
  ctx.registerDbg('monsters.forget', (crew, _p, args) => {
    const rt = rtFor(crew);
    const L = rt ? listenerOf(rt) : null;
    const id = (args as { id?: string } | null)?.id;
    if (!rt || !L) return { ok: false };
    for (const m of [L.warned, L.noticedAt, L.knocks, L.knocked, L.heardP, L.known] as Map<string, unknown>[]) {
      if (id) m.delete(id);
      else m.clear();
    }
    return { ok: true };
  });
  ctx.registerDbg('monsters.warn', (crew, _p, args) => {
    const rt = rtFor(crew);
    const L = rt ? listenerOf(rt) : null;
    const id = (args as { id?: string } | null)?.id ?? '';
    if (!rt || !L) return { ok: false };
    return { ok: true, warn: warnState(rt, L, id), knocks: L.knocks.get(id) ?? 0 };
  });

  void rebind().then(() => log.info(`installed (bound: ${Object.entries(boundApis()).filter(([k, v]) => k !== 'subscribed' && v.length).map(([k]) => k).join(', ') || 'none yet'})`));
}

function describe(a: Agent, t = 0): Record<string, unknown> {
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const base: Record<string, unknown> = { id: a.id, kind: a.kind, x: r2(a.x), z: r2(a.z), yaw: r2(a.yaw), state: a.state, anim: a.anim, active: a.active, st: r2(a.st), path: a.path ? a.path.length - a.pathI : 0, goal: [r2(a.goalX), r2(a.goalZ)] };
  if (a.kind === 'hound') {
    const h = a as HoundAgent;
    Object.assign(base, { chained: h.chained, tx: r2(h.tx), tz: r2(h.tz), tdoor: h.tdoor, lastNoiseKind: h.lastNoiseKind, lastNoiseDist: r2(h.lastNoiseDist) });
  } else if (a.kind === 'listener') {
    const L = a as ListenerAgent;
    Object.assign(base, {
      dormant: L.dormant, wakeAt: r2(L.wakeAt), intent: L.intent, targetSpace: L.targetSpace, targetPlayer: L.targetPlayer, grabVictim: L.grabVictim,
      memory: L.memory.map((l) => ({ text: l.text, speaker: l.speakerName, callsigns: l.callsigns, meaningful: l.meaningful, used: l.used, room: l.room, ear: l.ear ?? null, px: r2(l.px), pz: r2(l.pz) })),
      // v1.2
      grabStruggle: r2(L.grabStruggle), grabSolo: L.grabSolo, grabLeft: L.state === 'grab' ? r2(L.grabUntil - t) : 0,
      pouncing: L.pounceUntil > t, speed: r2(L.speed), knocks: Object.fromEntries(L.knocks), ventIds: L.ventIds,
      warned: Object.fromEntries([...L.warned].map(([k, v]) => [k, r2(t - v)])),
      // v1.3: wake gate + hearing telemetry (memory entries: ear = the relaying ear id)
      held: L.held === true, wokeAt: L.wokeAt === undefined ? null : r2(L.wokeAt), heardLines: L.heardLines ?? 0, heardDormant: L.heardDormant ?? 0,
      earLines: L.earLines ?? 0, nearestSpeakerM: L.nearestSpeakerM === undefined ? null : r2(L.nearestSpeakerM), summary: listenerSummary(L),
    });
  } else if (a.kind === 'mannequin') {
    const m = a as MannequinAgent;
    Object.assign(base, { spawned: m.spawned, observed: m.observed });
  } else if (a.kind === 'snatcher') {
    Object.assign(base, describeSnatcher(a as SnatcherAgent, t));
  }
  return base;
}

export type { ServerPlayer };
