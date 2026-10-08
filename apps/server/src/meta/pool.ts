// Owner: meta-records (v1.2). Pure gear-pool maths (no ctx, no I/O; unit-tested in tests/meta/pool.test.ts).
// The pool is keyed by SAVE id (CrewSave.shift.gear 'owner|type' -> units, 'crew' = company gear). Units are real item
// types (shop packs are converted on the way in); the key order of an owner's map is its recency (newest last).
import { GEAR_PACKS } from '@dead-air/shared/interactables.ts';
import { HANDOUT_ONLY, POOL_STACK, POOL_TYPES } from '@dead-air/shared/catalog.ts';

export type Units = Record<string, number>;

/** types the pool, the hand-out and meta.loadout accept (crafted overshoes included) */
export function isPoolType(t: string): boolean {
  return POOL_TYPES.includes(t) || HANDOUT_ONLY.includes(t);
}

/** types a survivor keeps after a contract (collectGear); never HANDOUT_ONLY (overshoes wear out) */
export function isCarryType(t: string): boolean {
  return POOL_TYPES.includes(t);
}

export function stackOf(t: string): number {
  return Math.max(1, Math.round(POOL_STACK[t] ?? 1));
}

export function slotsFor(t: string, units: number): number {
  return units > 0 ? Math.ceil(units / stackOf(t)) : 0;
}

/** inventory slot-equivalents of a pool */
export function poolSlots(u: Units | undefined): number {
  let n = 0;
  for (const [t, v] of Object.entries(u ?? {})) n += slotsFor(t, v);
  return n;
}

/** a shop pack id or a real type -> [real type, units per 1] (null = not pool gear) */
export function realType(t: string): [string, number] | null {
  const pack = GEAR_PACKS[t];
  const real = pack?.type ?? t;
  if (!isPoolType(real)) return null;
  return [real, pack?.count ?? 1];
}

/** pack ids -> real units, unknown/zero entries dropped; key order (recency) kept */
export function normalizeUnits(u: Units | undefined): Units {
  const out: Units = {};
  for (const [t, v0] of Object.entries(u ?? {})) {
    const v = Math.max(0, Math.round(Number(v0) || 0));
    const r = realType(t);
    if (!r || v <= 0) continue;
    out[r[0]] = (out[r[0]] ?? 0) + v * r[1];
  }
  return out;
}

/** add units of a type as the newest entry (recency = key order) */
export function addUnits(u: Units, t: string, n: number): void {
  const prev = u[t] ?? 0;
  delete u[t];
  u[t] = prev + n;
}

/** hand-out order: the player's loadout first (types present in the pool), then the rest newest first */
export function handoutOrder(pool: Units, loadout?: readonly string[] | null): string[] {
  const have = Object.keys(pool).filter((t) => (pool[t] ?? 0) > 0);
  const out: string[] = [];
  for (const t of loadout ?? []) if (have.includes(t) && !out.includes(t)) out.push(t);
  for (const t of have.slice().reverse()) if (!out.includes(t)) out.push(t);
  return out;
}

/** split a pool into the hand-out (at most capSlots inventory slots, in `order`) and what stays in the locker */
export function allot(pool: Units, order: readonly string[], capSlots: number): { give: Units; keep: Units; slots: number } {
  const give: Units = {};
  const keep: Units = { ...pool };
  let left = Math.max(0, Math.floor(capSlots));
  for (const t of order) {
    const units = keep[t] ?? 0;
    if (units <= 0 || left <= 0) continue;
    const n = Math.min(units, left * stackOf(t));
    give[t] = n;
    left -= slotsFor(t, n);
    if (units - n > 0) keep[t] = units - n;
    else delete keep[t];
  }
  return { give, keep, slots: Math.max(0, Math.floor(capSlots)) - left };
}

/** units -> item stacks to give: [count per item] (one per inventory slot) */
export function stacks(t: string, units: number): number[] {
  const s = stackOf(t);
  const out: number[] = [];
  for (let left = units; left > 0; left -= s) out.push(Math.min(s, left));
  return out;
}

/** meta.loadout: every entry a pool type, no duplicates, at most `max` */
export function validateLoadout(order: unknown, max = 12): { ok: boolean; loadout: string[]; reason?: string } {
  if (!Array.isArray(order)) return { ok: false, loadout: [], reason: 'order must be a list of item types' };
  if (order.length > max) return { ok: false, loadout: [], reason: `at most ${max} entries` };
  const out: string[] = [];
  for (const t0 of order) {
    const t = String(t0 ?? '');
    const r = realType(t);
    if (!r) return { ok: false, loadout: [], reason: `not locker gear: ${t.slice(0, 24)}` };
    if (!out.includes(r[0])) out.push(r[0]);
  }
  return { ok: true, loadout: out };
}

/**
 * v1.1 pools were keyed by LIVE player id. A save's live ids are playerIdFromKey(key) for each sv.keys entry (PLAN §13):
 * map every owner to its save id. Save ids and 'crew' stay; unknown owners are kept as they are.
 */
export function migrateOwners(gear: Record<string, Units>, saves: readonly { id: string; keys: readonly string[] }[], liveIdOf: (key: string) => string): Record<string, Units> {
  const saveIds = new Set(saves.map((s) => s.id));
  const live = new Map<string, string>();
  for (const s of saves) for (const k of s.keys ?? []) {
    const id = liveIdOf(k);
    if (!saveIds.has(id) && !live.has(id)) live.set(id, s.id);
  }
  const out: Record<string, Units> = {};
  for (const [owner, units] of Object.entries(gear)) {
    const to = owner === 'crew' || saveIds.has(owner) ? owner : (live.get(owner) ?? owner);
    const dst = (out[to] ??= {});
    for (const [t, n] of Object.entries(units)) dst[t] = (dst[t] ?? 0) + n;
  }
  return out;
}
