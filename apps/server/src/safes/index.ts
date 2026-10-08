// Owner: safes feature (flag 'safes', default off). Self-contained safe-cracking mini-game (server side).
// At contract start 1-2 'Company safe' interactables are placed against a wall in deep rooms. E (kind 'safe') opens the
// dial for that player ('safes.open' event). The client streams its dial position (~10 Hz, 'safes.dial') and gets back
// ONLY click / no-click; the combination never leaves the server (except the dev-only dbg.safes.peek).
// 'safes.confirm' sets the current number: right = next number (3 right = open: loot into the hands + XP),
// wrong = loud clunk (emitNoise, attracts the Hound) + reset. Esc = 'safes.close'. Tunables: config/balance/safes.json.
// Uses only public cross-track APIs (interaction api, players noise bus, meta awardXp); untyped request/event names
// are cast because messages/index.ts is integrator-owned (no messages/safes.ts).
import type { TrackInstall } from '../core/boot.ts';
import type { Crew, ServerContext, ServerPlayer } from '../core/types.ts';
import type { LevelLayout, LayoutSpace } from '@dead-air/shared/layout.ts';
import { makeRng } from '@dead-air/shared/rng.ts';
import { ITEM_DEFS } from '@dead-air/shared/interactables.ts';
import * as IX from '../interaction/api.ts';
import { emitNoise } from '../players/noise.ts';
import { awardXp, recordStat } from '../meta/api.ts';

export interface Safe {
  id: string;
  x: number;
  z: number;
  /** unit vector the safe door faces (into the room) */
  face: [number, number];
  space: number;
  combo: number[];
  value: number;
  open: boolean;
  cracker: string | null;
  stage: number;
  pos: number;
  winAt: number;
  winN: number;
}

interface CrewSafes {
  key: string;
  safes: Map<string, Safe>;
}

const states = new WeakMap<Crew, CrewSafes>();

type AnyReq = (name: string, fn: (crew: Crew, player: ServerPlayer, args: unknown) => unknown) => void;
type AnyEmit = (crew: Crew, e: string, d: unknown, opts?: { to?: string[]; except?: string[] }) => void;

const DEF: Record<string, number> = {
  countMin: 1, countMax: 2, minDistFrac: 0.55, poolSize: 6, dialMax: 40, minStep: 6, rewardMin: 120, rewardMax: 200,
  xp: 30, wrongNoiseM: 10, maxDialPerSec: 30, maxUseDistM: 3, wallInsetM: 0.42, doorClearM: 1.4, itemClearM: 1.2,
  safeGearChance: 0.35,
};
/** v1.2 safe gear weights (only types interaction implements, i.e. with ITEM_DEFS) */
const SAFE_GEAR: Record<string, number> = { lockpick: 3, masterkey: 2, nvg: 1, battery: 3, flashbulb: 2, soles: 2 };

/** v1.2: one piece of gear from a cracked safe (chance, weights), its own stream per safe so placement never moves */
export function safeGear(layout: LevelLayout, s: Pick<Safe, 'id'>, weights: Record<string, number>, chance: number): string | null {
  const rng = makeRng(`${layout.seed}:${layout.hash}:${s.id}`, 'safes.gear');
  if (!rng.chance(Math.max(0, Math.min(1, chance)))) return null;
  const list = Object.entries(weights).filter(([t, w]) => !!ITEM_DEFS[t] && Number(w) > 0);
  const total = list.reduce((a, [, w]) => a + Number(w), 0);
  let r = rng.next() * total;
  for (const [t, w] of list) {
    r -= Number(w);
    if (r < 0) return t;
  }
  return list.length ? list[list.length - 1]![0] : null;
}

export const install: TrackInstall = (ctx: ServerContext) => {
  const log = ctx.log('safes');
  // dev-only override for tests: SAFES_FORCE=1 with --dev (production honours only config/flags.json)
  const enabled = () => ctx.flags.safes === true || (process.env.NODE_ENV === 'development' && process.env.SAFES_FORCE === '1');
  const num = (k: string): number => {
    const v = (ctx.balance.safes as Record<string, unknown> | undefined)?.[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : DEF[k]!;
  };
  const str = (k: string, d: string): string => {
    const v = (ctx.balance.safes as Record<string, unknown> | undefined)?.[k];
    return typeof v === 'string' && v ? v : d;
  };
  const gearWeights = (): Record<string, number> => {
    const v = (ctx.balance.safes as Record<string, unknown> | undefined)?.safeGear;
    return v && typeof v === 'object' ? (v as Record<string, number>) : SAFE_GEAR;
  };
  const emit = ctx.emit as unknown as AnyEmit;
  const req = ctx.registerReq as unknown as AnyReq;
  const N = () => Math.max(10, Math.round(num('dialMax')));

  const get = (crew: Crew): CrewSafes | null => {
    const st = states.get(crew);
    if (!st || crew.phase !== 'contract' || !crew.layout || st.key !== crew.layout.hash) return null;
    return st;
  };

  const release = (crew: Crew, s: Safe, notify: boolean): void => {
    const pid = s.cracker;
    s.cracker = null;
    s.stage = 0;
    if (notify && pid) emit(crew, 'safes.close', { id: s.id }, { to: [pid] });
  };

  const place = (crew: Crew, layout: LevelLayout): void => {
    const safes = placeSafes(layout, num, N());
    states.set(crew, { key: layout.hash, safes: new Map(safes.map((s) => [s.id, s])) });
    IX.registerInteractables(crew, safes.map((s) => ({
      id: s.id, kind: 'safe', p: [s.x, 0.75, s.z] as [number, number, number], prompt: 'Crack the company safe', enabled: true, r: 0.55,
    })));
    log.info(`placed ${safes.length} safe(s) in ${crew.code}: ${safes.map((s) => `${s.id}@space${s.space}`).join(', ')}`);
  };

  ctx.hooks.phase.push((crew, _from, to) => {
    if (!enabled() || to !== 'contract' || !crew.layout || crew.layout.kind !== 'facility') {
      states.delete(crew);
      return;
    }
    if (states.get(crew)?.key === crew.layout.hash) return;
    try {
      place(crew, crew.layout);
    } catch (e) {
      log.warn('placement failed:', e instanceof Error ? e.message : e);
      states.delete(crew);
    }
  });

  ctx.hooks.leave.push((crew, player) => {
    const st = states.get(crew);
    if (!st) return;
    for (const s of st.safes.values()) if (s.cracker === player.id) release(crew, s, false);
  });

  IX.onDeath((crew, pid) => {
    const st = states.get(crew);
    if (!st) return;
    for (const s of st.safes.values()) if (s.cracker === pid) release(crew, s, true);
  });

  IX.onInteract('safe', (crew, player, targetId) => {
    const st = get(crew);
    const s = st?.safes.get(targetId);
    if (!enabled() || !s) return false;
    if (s.open) return 'The safe is empty';
    if (s.cracker && s.cracker !== player.id) {
      const other = crew.players.get(s.cracker);
      if (other && other.connected && IX.isAlive(crew, other.id)) return `${other.name} is working this safe`;
    }
    s.cracker = player.id;
    s.stage = 0;
    s.pos = 0;
    s.winAt = 0;
    s.winN = 0;
    emit(crew, 'safes.open', { id: s.id, stage: 0, n: N(), p: [s.x, 0.8, s.z] }, { to: [player.id] });
    return true;
  });

  /** the player's open safe (validates id, cracker, alive, distance); null = the dial must close */
  const mine = (crew: Crew, player: ServerPlayer, a: unknown): Safe | null => {
    if (!enabled()) return null;
    const id = (a as { id?: unknown } | null)?.id;
    if (typeof id !== 'string') return null;
    const s = get(crew)?.safes.get(id);
    if (!s || s.open || s.cracker !== player.id) return null;
    const dx = player.pose.p[0] - s.x, dz = player.pose.p[2] - s.z;
    const far = dx * dx + dz * dz > num('maxUseDistM') ** 2;
    if (far || !IX.isAlive(crew, player.id)) {
      release(crew, s, false);
      return null;
    }
    return s;
  };
  const posOf = (a: unknown): number => {
    const p = Number((a as { pos?: unknown } | null)?.pos);
    const n = N();
    return Number.isFinite(p) ? (((Math.round(p) % n) + n) % n) : 0;
  };

  req('safes.dial', (crew, player, a) => {
    const s = mine(crew, player, a);
    if (!s) return { click: false, closed: true };
    const now = ctx.now();
    if (now - s.winAt > 1000) { s.winAt = now; s.winN = 0; }
    if (++s.winN > num('maxDialPerSec')) return { click: false };
    const n = N();
    const to = posOf(a);
    let d = (to - s.pos) % n;
    if (d > n / 2) d -= n;
    if (d < -n / 2) d += n;
    const target = s.combo[s.stage]!;
    let click = false;
    const step = d > 0 ? 1 : -1;
    for (let k = 1; k <= Math.abs(d); k++) if ((((s.pos + step * k) % n) + n) % n === target) click = true;
    s.pos = to;
    return { click };
  });

  req('safes.confirm', (crew, player, a) => {
    const s = mine(crew, player, a);
    if (!s) return { ok: false, closed: true, stage: 0, open: false };
    const pos = posOf(a);
    s.pos = pos;
    if (pos === s.combo[s.stage]) {
      s.stage++;
      if (s.stage < s.combo.length) return { ok: true, stage: s.stage, open: false };
      s.open = true;
      s.cracker = null;
      IX.updateInteractable(crew, s.id, { enabled: false, prompt: 'Company safe (empty)' });
      const opts = { value: s.value, name: str('rewardName', 'Company bearer bonds') };
      const type = str('rewardType', 'loot.medium');
      const it = IX.giveItem(crew, player.id, type, { ...opts, via: 'safe' }) ?? IX.spawnItem(crew, type, [s.x + s.face[0] * 0.6, 0, s.z + s.face[1] * 0.6], opts);
      // v1.2 (flag gearV12): the bonds, and safeGearChance of one piece of v1.2 gear (deterministic per safe)
      const gear = ctx.flags.gearV12 !== false ? safeGear(crew.layout!, s, gearWeights(), num('safeGearChance')) : null;
      if (gear) IX.giveItem(crew, player.id, gear, { via: 'safe' });
      try { recordStat(crew, player.id, 'safesCracked'); } catch { /* meta absent */ }
      let xp = 0;
      try { xp = awardXp(crew, player.id, num('xp'), 'Cracked a company safe') ? num('xp') : 0; } catch { /* meta absent */ }
      emit(crew, 'safes.fx', { id: s.id, fx: 'open', p: [s.x, 0.8, s.z] });
      log.info(`${player.name} cracked ${s.id} in ${crew.code} (+${s.value} scrip item ${it?.id ?? '?'}${gear ? ` + ${gear}` : ''})`);
      return { ok: true, stage: s.stage, open: true, value: s.value, name: opts.name, xp, ...(gear ? { gear, gearName: ITEM_DEFS[gear]?.name ?? gear } : {}) };
    }
    s.stage = 0;
    emitNoise(crew, { x: s.x, z: s.z, radiusM: num('wrongNoiseM'), kind: 'safeClunk', source: player.id });
    emit(crew, 'safes.fx', { id: s.id, fx: 'clunk', p: [s.x, 0.8, s.z] });
    return { ok: false, stage: 0, open: false };
  });

  req('safes.close', (crew, player, a) => {
    const id = (a as { id?: unknown } | null)?.id;
    const s = typeof id === 'string' ? states.get(crew)?.safes.get(id) : undefined;
    if (s && s.cracker === player.id) release(crew, s, false);
    return { ok: true };
  });

  req('safes.list', (crew) => {
    const st = enabled() ? get(crew) : null;
    return { safes: st ? [...st.safes.values()].map((s) => ({ id: s.id, x: s.x, z: s.z, face: s.face, open: s.open })) : [] };
  });

  // dev-only (NODE_ENV=development): open the dial without aiming (tests)
  ctx.registerDbg('safes.open', (crew, player, a) => {
    const s = get(crew)?.safes.get(String((a as { id?: unknown } | null)?.id ?? 'safe:0'));
    if (!s || s.open) return { ok: false };
    s.cracker = player.id; s.stage = 0; s.pos = 0;
    emit(crew, 'safes.open', { id: s.id, stage: 0, n: N(), p: [s.x, 0.8, s.z] }, { to: [player.id] });
    return { ok: true };
  });
  // dev-only (NODE_ENV=development): combinations for tests
  ctx.registerDbg('safes.peek', (crew) => {
    const st = get(crew);
    return { safes: st ? [...st.safes.values()].map((s) => ({ id: s.id, x: s.x, z: s.z, face: s.face, combo: s.combo, open: s.open, cracker: s.cracker, stage: s.stage })) : [] };
  });
};

/** deterministic placement: 1-2 safes against a wall of the deepest rooms, clear of doors and layout items */
export function placeSafes(layout: LevelLayout, num: (k: string) => number, n: number): Safe[] {
  const rng = makeRng(layout.seed, 'safes');
  const rooms = layout.spaces.filter((s) => (s.kind === 'room' || s.kind === 'hall' || s.kind === 'vault') && !s.open
    && s.id !== layout.entrance && s.rect.w >= 3 && s.rect.h >= 3);
  if (!rooms.length) return [];
  const maxD = Math.max(...rooms.map((r) => r.dist));
  const want = rng.int(Math.round(num('countMin')), Math.round(num('countMax')));
  const out: Safe[] = [];
  const taken: { x: number; z: number }[] = [];
  // pass 1 = the deepest rooms with full clearances; crowded sites (v1.1 layouts carry more props) used to end up with
  // no safe at all, so later passes relax the door/item clearances and widen the pool until at least one fits
  const passes: [relax: number, frac: number, pool: number][] = [
    [1, num('minDistFrac'), num('poolSize')], [0.7, num('minDistFrac'), num('poolSize') * 2], [0.55, Math.min(0.3, num('minDistFrac')), rooms.length],
  ];
  for (const [relax, frac, size] of passes) {
    // relaxed passes only make sure the site gets one safe
    const enough = () => out.length >= want || (relax < 1 && out.length >= 1);
    if (enough()) break;
    const pool = rooms.filter((r) => r.dist >= maxD * frac && !out.some((s) => s.space === r.id))
      .sort((a, b) => b.dist - a.dist || a.id - b.id).slice(0, Math.max(1, Math.round(size)));
    while (!enough() && pool.length) {
      const sp = pool.splice(rng.int(0, pool.length - 1), 1)[0]!;
      const spot = wallSpot(layout, sp, rng, num, taken, relax);
      if (!spot) continue;
      taken.push(spot);
      const combo: number[] = [];
      let prev = 0;
      for (let i = 0; i < 3; i++) {
        let c = rng.int(0, n - 1);
        for (let t = 0; t < 32 && circ(c, prev, n) < num('minStep'); t++) c = rng.int(0, n - 1);
        combo.push(c);
        prev = c;
      }
      out.push({
        id: `safe:${out.length}`, x: spot.x, z: spot.z, face: spot.face, space: sp.id, combo,
        value: rng.int(Math.round(num('rewardMin')), Math.round(num('rewardMax'))),
        open: false, cracker: null, stage: 0, pos: 0, winAt: 0, winN: 0,
      });
    }
  }
  return out;
}

function circ(a: number, b: number, n: number): number {
  const d = Math.abs(a - b) % n;
  return Math.min(d, n - d);
}

function wallSpot(layout: LevelLayout, sp: LayoutSpace, rng: { next(): number; int(lo: number, hi: number): number },
  num: (k: string) => number, taken: { x: number; z: number }[], relax = 1): { x: number; z: number; face: [number, number] } | null {
  const r = sp.rect, ins = num('wallInsetM');
  const cands: { x: number; z: number; face: [number, number] }[] = [];
  for (const f of [0.5, 0.3, 0.7, 0.2, 0.8]) {
    cands.push({ x: r.x + f * r.w, z: r.y + ins, face: [0, 1] });
    cands.push({ x: r.x + f * r.w, z: r.y + r.h - ins, face: [0, -1] });
    cands.push({ x: r.x + ins, z: r.y + f * r.h, face: [1, 0] });
    cands.push({ x: r.x + r.w - ins, z: r.y + f * r.h, face: [-1, 0] });
  }
  // deterministic shuffle
  for (let i = cands.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [cands[i], cands[j]] = [cands[j]!, cands[i]!];
  }
  const doorClear = num('doorClearM') * relax, itemClear = num('itemClearM') * relax;
  for (const c of cands) {
    const cx = Math.floor(c.x), cz = Math.floor(c.z);
    if (cx < 0 || cz < 0 || cx >= layout.W || cz >= layout.H || layout.owner[cz * layout.W + cx] !== sp.id) continue;
    const nearDoor = layout.doors.some((d) => {
      const x0 = d.x, z0 = d.y, x1 = d.dir === 'h' ? d.x + d.len : d.x, z1 = d.dir === 'v' ? d.y + d.len : d.y;
      const px = Math.min(Math.max(c.x, x0), x1), pz = Math.min(Math.max(c.z, z0), z1);
      return (px - c.x) ** 2 + (pz - c.z) ** 2 < doorClear * doorClear;
    });
    if (nearDoor) continue;
    if (layout.items.some((it) => (it.x - c.x) ** 2 + (it.z - c.z) ** 2 < itemClear * itemClear)) continue;
    if (taken.some((t) => (t.x - c.x) ** 2 + (t.z - c.z) ** 2 < 4)) continue;
    return c;
  }
  return null;
}
