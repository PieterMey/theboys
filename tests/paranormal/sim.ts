// Owner: env-paranormal (v1.2). Simulated crews for the paranormal core: a generated facility, N players wandering on
// the nav grid (A* paths, pauses, van trips), scripted director phases / events / tension, scripted monsters, power,
// blackout and light switches. Drives the real plan.ts through a ParaWorld; records every emitted event with the sim
// state at that moment so tests can check blocks, gates, budgets, novelty, guarantees and cadence.
import { generateFacility } from '../../packages/shared/src/procgen/index.ts';
import { mirrorsOf } from '../../packages/shared/src/procgen/mirrors.ts';
import type { MirrorSpot } from '../../packages/shared/src/procgen/mirrors.ts';
import type { MovableRef } from '../../packages/shared/src/procgen/movables.ts';
import type { LoreSpot } from '../../packages/shared/src/procgen/lore.ts';
import { astar, buildEdgeGrid, initialDoorOpen } from '../../packages/shared/src/nav/index.ts';
import type { DoorOpenFn, EdgeGrid } from '../../packages/shared/src/nav/index.ts';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import { makeRng } from '../../packages/shared/src/rng.ts';
import type { Rng } from '../../packages/shared/src/rng.ts';
import type { ParanormalEvent } from '../../packages/shared/src/messages/paranormal.ts';
import type { PhenomenonRecord } from '../../apps/server/src/paranormal/api.ts';
import { resolveBalance } from '../../apps/server/src/paranormal/balance.ts';
import { chaseActive, clockMinOf, hauntOf, newCrewPara, tickPara } from '../../apps/server/src/paranormal/plan.ts';
import { indoor, spaceAtXZ } from '../../apps/server/src/paranormal/gates.ts';
import type { CrewPara, DirectorPhase, ParaBalance, ParaMonster, ParaOut, ParaPlayer, ParaWorld } from '../../apps/server/src/paranormal/types.ts';

export interface SimMonster { id: string; kind: string; x: number; z: number; active: boolean; state: string }

export interface SimOpts {
  seed: string;
  players: number;
  risk?: number;
  /** real seconds for 22:00 -> 04:00 (40-min contracts: 2400) */
  realSec?: number;
  crew?: string;
  contractIndex?: number;
  /** partial config/balance/paranormal.json */
  balance?: Record<string, unknown>;
  /** director phase over time (default: build 50 s, peak 4, fade 6, relax 35) */
  director?: ((tSec: number) => DirectorPhase) | null;
  /** seconds between director events (0 = none; default 25) */
  directorEvery?: number;
  /** constant per-player tension (default 0.2) */
  tension?: number;
  /** scripted monsters (default: one wandering hound + a Listener that wakes at wakeSec) */
  monsters?: ((tSec: number, sim: Sim) => SimMonster[]) | null;
  wakeSec?: number;
  /** listener hunts for 10 s every chaseEvery s (0 = never) */
  chaseEvery?: number;
  blackoutFrom?: number;
  /** all power zones on from this time (twin levers; default 240 s) */
  powerFrom?: number;
  /** player index holding the Core (lifted) from coreFrom */
  coreCarrier?: number;
  coreFrom?: number;
  /** player index hidden in a locker for the whole run */
  hiddenPlayer?: number;
  movables?: boolean;
  lore?: boolean;
  themeHaunt?: number;
  snatcherLurking?: boolean;
  /** the layout's mirrors are ignored */
  noMirrors?: boolean;
  /** players start spread inside (default) or at the van spawns */
  startAtVan?: boolean;
}

export interface Emitted {
  ev: ParanormalEvent;
  /** sim seconds */
  t: number;
  clockMin: number;
  H: number;
  phase: DirectorPhase;
  chase: boolean;
  sinceWake: number;
  sinceDirector: number;
  blackout: boolean;
  players: ParaPlayer[];
  monsters: SimMonster[];
}

interface Walker {
  id: string;
  name: string;
  x: number;
  z: number;
  yaw: number;
  path: [number, number][] | null;
  pi: number;
  pause: number;
  speed: number;
}

const CYCLE = (t: number): DirectorPhase => {
  const c = t % 95;
  return c < 50 ? 'build' : c < 54 ? 'peak' : c < 60 ? 'fade' : 'relax';
};

export class Sim {
  o: SimOpts;
  L: LevelLayout;
  grid: EdgeGrid;
  doorOpen: DoorOpenFn;
  b: ParaBalance;
  st: CrewPara;
  w: ParaWorld;
  rng: Rng;
  now = 1_000_000;
  t0 = 1_000_000;
  walkers: Walker[] = [];
  switches = new Map<number, boolean>();
  dirEvents: { t: number; kind: string; source: string }[] = [];
  lastDirEventAt = -Infinity;
  emitted: Emitted[] = [];
  ends: { id: number; reason: string; t: number }[] = [];
  reveals: { id: number; at: number; t: number }[] = [];
  records: PhenomenonRecord[] = [];
  mons: SimMonster[] = [];
  wokeAtSim = -Infinity;
  private paraPlayers: ParaPlayer[] = [];
  private indoorCells: number[] = [];
  private vanCells: number[] = [];
  private lockerFor: string | null = null;
  private movs: MovableRef[] = [];
  private lores: LoreSpot[] = [];
  private houndPath: { path: [number, number][]; i: number; x: number; z: number } | null = null;

  constructor(o: SimOpts) {
    this.o = o;
    this.L = generateFacility({ seed: o.seed, players: o.players, risk: o.risk ?? 1 });
    this.grid = buildEdgeGrid(this.L);
    this.doorOpen = initialDoorOpen(this.L);
    this.b = resolveBalance(o.balance ?? {});
    this.rng = makeRng(o.seed, 'paranormal-sim');
    const L = this.L;
    for (const s of L.spaces) this.switches.set(s.id, s.light !== 'off');
    for (let c = 0; c < L.owner.length; c++) {
      const s = L.owner[c];
      if (s < 0) continue;
      if (indoor(L, s)) this.indoorCells.push(c);
      else if (L.spaces[s].type === 'van') this.vanCells.push(c);
    }
    if (o.movables) this.movs = this.makeMovables();
    if (o.lore) this.lores = this.makeLore();
    const spawns = L.items.filter((i) => i.kind === 'spawn_player');
    for (let i = 0; i < o.players; i++) {
      let x: number, z: number;
      if (o.startAtVan && spawns.length) { x = spawns[i % spawns.length].x; z = spawns[i % spawns.length].z; } else {
        const c = this.indoorCells[Math.floor(this.rng.next() * this.indoorCells.length)];
        x = (c % L.W) + 0.5; z = Math.floor(c / L.W) + 0.5;
      }
      this.walkers.push({ id: `p${i}`, name: ['Ann', 'Bob', 'Cas', 'Dee', 'Eli', 'Fay'][i] ?? `P${i}`, x, z, yaw: this.rng.next() * 6.28, path: null, pi: 0, pause: this.rng.next() * 3, speed: 1.2 + this.rng.next() * 1.6 });
    }
    if (o.hiddenPlayer !== undefined) {
      const lk = L.items.find((i) => i.kind === 'hiding' && indoor(L, i.space));
      if (lk) {
        this.lockerFor = lk.id;
        const wk = this.walkers[o.hiddenPlayer];
        wk.x = lk.x; wk.z = lk.z;
      }
    }
    const sim = this;
    this.w = {
      layout: L,
      grid: this.grid,
      doorOpen: this.doorOpen,
      now: () => sim.now,
      players: () => sim.paraPlayers,
      monsters: () => sim.mons,
      director: () => (sim.o.director === null ? null : {
        phase: sim.phase(), tension: Object.fromEntries(sim.walkers.map((wk) => [wk.id, sim.o.tension ?? 0.2])), events: sim.dirEvents,
      }),
      clockMin: () => Math.min(360, (sim.tSec() / (sim.o.realSec ?? 900)) * 360),
      contractRealSec: () => sim.o.realSec ?? 900,
      blackout: () => sim.blackout(),
      coreLifted: () => sim.o.coreCarrier !== undefined && sim.tSec() >= (sim.o.coreFrom ?? 0),
      lightsOn: (s) => sim.lightsOn(s),
      setLights: (s, on) => { sim.switches.set(s, on); },
      mirrors: (): MirrorSpot[] => (sim.o.noMirrors ? [] : mirrorsOf(L)),
      movables: () => sim.movs,
      loreSpots: () => sim.lores,
      themeHaunt: () => sim.o.themeHaunt ?? 0,
      snatcherLurking: () => !!sim.o.snatcherLurking,
    };
    this.refreshPlayers();
    this.st = newCrewPara(this.w, o.crew ?? 'SIMX', o.contractIndex ?? 0, this.b);
    if (o.lore) this.st.loreTargets = this.lores.map((l) => l.id);
  }

  tSec(): number { return (this.now - this.t0) / 1000; }
  phase(): DirectorPhase { return (this.o.director ?? CYCLE)(this.tSec()); }
  blackout(): boolean { return this.o.blackoutFrom !== undefined && this.tSec() >= this.o.blackoutFrom; }

  lightsOn(s: number): boolean {
    const sp = this.L.spaces[s];
    if (!sp || !this.switches.get(s)) return false;
    if (sp.light === 'broken') return false;
    if (sp.kind === 'outside' || sp.type === 'van') return true;
    if (this.blackout()) return false;
    return sp.powerZone === 0 || this.tSec() >= (this.o.powerFrom ?? 240);
  }

  out: ParaOut = {
    event: (ev) => {
      const players = this.paraPlayers.map((p) => ({ ...p }));
      this.emitted.push({
        ev: JSON.parse(JSON.stringify(ev)) as ParanormalEvent, t: this.tSec(), clockMin: clockMinOf(this.st, this.w), H: hauntOf(this.st, this.w, this.b),
        phase: this.phase(), chase: chaseActive(this.mons.filter((m) => m.active), players), sinceWake: (this.now - this.wokeAtSim) / 1000,
        sinceDirector: (this.now - this.lastDirEventAt) / 1000, blackout: this.blackout(), players, monsters: this.mons.map((m) => ({ ...m })),
      });
    },
    end: (id, reason) => { this.ends.push({ id, reason, t: this.tSec() }); },
    reveal: (id, at) => { this.reveals.push({ id, at, t: this.tSec() }); },
    phenomenon: (rec) => { this.records.push(rec); },
  };

  private refreshPlayers(): void {
    const L = this.L;
    this.paraPlayers = this.walkers.map((wk, i) => {
      const s = spaceAtXZ(L, wk.x, wk.z);
      const hidden = this.o.hiddenPlayer === i ? this.lockerFor : null;
      return {
        id: wk.id, name: wk.name, x: wk.x, z: wk.z, yaw: wk.yaw, light: s >= 0 && !this.lightsOn(s), alive: true,
        inVan: s >= 0 && L.spaces[s].type === 'van', hidden,
        core: this.o.coreCarrier === i && this.tSec() >= (this.o.coreFrom ?? 0), grabbed: false,
      };
    });
  }

  private randomCell(van: boolean): [number, number] {
    const cells = van && this.vanCells.length ? this.vanCells : this.indoorCells;
    const c = cells[Math.floor(this.rng.next() * cells.length)];
    return [(c % this.L.W) + 0.5, Math.floor(c / this.L.W) + 0.5];
  }

  private canOpen = (id: number): boolean => {
    const k = this.L.doors[id]?.kind;
    return k !== 'locked' && k !== 'vault' && k !== 'blocked';
  };

  private moveWalkers(dt: number): void {
    for (let i = 0; i < this.walkers.length; i++) {
      const wk = this.walkers[i];
      if (this.o.hiddenPlayer === i) continue;
      if (wk.pause > 0) { wk.pause -= dt; continue; }
      if (!wk.path) {
        const [tx, tz] = this.randomCell(this.rng.chance(0.08));
        const r = astar(this.grid, wk.x, wk.z, tx, tz, { mode: 'walk', doorOpen: this.doorOpen, canOpen: this.canOpen, maxCost: 120 });
        if (!r || r.cells.length < 2) { wk.pause = 1; continue; }
        wk.path = r.cells.map((c) => [(c % this.L.W) + 0.5, Math.floor(c / this.L.W) + 0.5]);
        wk.pi = 1;
      }
      let step = wk.speed * dt;
      while (step > 0 && wk.path && wk.pi < wk.path.length) {
        const [px, pz] = wk.path[wk.pi];
        const dx = px - wk.x, dz = pz - wk.z;
        const d = Math.hypot(dx, dz);
        if (d < 1e-6) { wk.pi++; continue; }
        wk.yaw = Math.atan2(dx, dz);
        if (d <= step) { wk.x = px; wk.z = pz; step -= d; wk.pi++; } else { wk.x += (dx / d) * step; wk.z += (dz / d) * step; step = 0; }
      }
      if (wk.path && wk.pi >= wk.path.length) { wk.path = null; wk.pause = 1 + this.rng.next() * 6; }
    }
  }

  private moveMonsters(dt: number): void {
    const t = this.tSec();
    if (this.o.monsters === null) { this.mons = []; return; }
    if (this.o.monsters) { this.mons = this.o.monsters(t, this); return; }
    // default: a wandering hound + a Listener (dormant until wakeSec, hunts 10 s every chaseEvery)
    if (!this.houndPath || this.houndPath.i >= this.houndPath.path.length) {
      const start = this.houndPath ? [this.houndPath.x, this.houndPath.z] : this.randomCell(false);
      const [tx, tz] = this.randomCell(false);
      const r = astar(this.grid, start[0], start[1], tx, tz, { mode: 'walk', doorOpen: this.doorOpen, canOpen: this.canOpen, maxCost: 120 });
      this.houndPath = { path: r ? r.cells.map((c) => [(c % this.L.W) + 0.5, Math.floor(c / this.L.W) + 0.5]) : [[start[0], start[1]]], i: 0, x: start[0], z: start[1] };
    }
    const hp = this.houndPath;
    let step = 1.5 * dt;
    while (step > 0 && hp.i < hp.path.length) {
      const [px, pz] = hp.path[hp.i];
      const d = Math.hypot(px - hp.x, pz - hp.z);
      if (d <= step) { hp.x = px; hp.z = pz; step -= d; hp.i++; } else { hp.x += ((px - hp.x) / d) * step; hp.z += ((pz - hp.z) / d) * step; step = 0; }
    }
    const wake = this.o.wakeSec ?? 200;
    const awake = t >= wake;
    if (awake && this.wokeAtSim === -Infinity) this.wokeAtSim = this.now;
    const ce = this.o.chaseEvery ?? 0;
    const hunting = awake && ce > 0 && t - wake > 20 && (t - wake) % ce < 10;
    const lp = this.walkers[0];
    this.mons = [
      { id: 'hound0', kind: 'hound', x: hp.x, z: hp.z, active: true, state: 'idle' },
      { id: 'listener0', kind: 'listener', x: hunting ? lp.x + 3 : 2, z: hunting ? lp.z : 2, active: awake, state: awake ? (hunting ? 'hunt' : 'patrol') : 'dormant' },
    ];
  }

  private makeMovables(): MovableRef[] {
    const out: MovableRef[] = [];
    let i = 0;
    for (const it of this.L.items) {
      if (it.kind !== 'prop' || !indoor(this.L, it.space)) continue;
      const p = String(it.data?.prop ?? '');
      if (!['chair', 'trash_can', 'bottles', 'cardboard_box', 'jerrycan', 'clock'].includes(p)) continue;
      out.push({ ref: `prop:${i++}`, key: `prop.${p}`, kind: 'prop', space: it.space, x: it.x, y: p === 'bottles' || p === 'clock' ? 0.9 : 0, z: it.z, rot: it.rot ?? 0 });
    }
    return out;
  }

  private makeLore(): LoreSpot[] {
    const out: LoreSpot[] = [];
    let i = 0;
    for (const it of this.L.items) {
      if (it.kind !== 'prop' || !String(it.data?.prop ?? '').startsWith('lore_')) continue;
      out.push({ id: it.id, idx: i++, style: 'clipboard', space: it.space, roomType: this.L.spaces[it.space]?.type ?? '', x: it.x, y: 1.4, z: it.z, rot: it.rot ?? 0, p: [it.x, 1.4, it.z] });
    }
    return out;
  }

  /** one tick */
  step(dtMs: number): void {
    this.now += dtMs;
    const dt = dtMs / 1000;
    const t = this.tSec();
    this.moveWalkers(dt);
    this.moveMonsters(dt);
    const every = this.o.directorEvery ?? 25;
    if (every > 0 && this.o.director !== null && t >= this.nextDirSec) {
      const ph = this.phase();
      if (ph !== 'peak' && ph !== 'fade') {
        const kind = this.rng.chance(0.2) ? 'quiet' : 'flicker';
        this.dirEvents.push({ t: Math.round(t), kind, source: 'sim' });
        if (this.dirEvents.length > 50) this.dirEvents.shift();
        if (kind !== 'quiet') this.lastDirEventAt = this.now;
        this.nextDirSec = t + every;
      }
    }
    this.refreshPlayers();
    tickPara(this.st, this.w, this.b, this.out);
  }

  private nextDirSec = 20;

  run(sec: number, dtMs = 100): this {
    const n = Math.round((sec * 1000) / dtMs);
    for (let i = 0; i < n; i++) this.step(dtMs);
    return this;
  }

  /** emitted phenomena (no revives) */
  events(): Emitted[] {
    return this.emitted.filter((e) => e.ev.kind !== 'revive');
  }

  /** player teleport (tests) */
  place(i: number, x: number, z: number, yaw = 0, pause = 9999): void {
    const wk = this.walkers[i];
    wk.x = x; wk.z = z; wk.yaw = yaw; wk.path = null; wk.pause = pause;
    this.refreshPlayers();
  }
}
