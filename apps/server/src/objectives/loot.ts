// Owner: track (a) Objectives. Loot budget + item rolls (deterministic per layout seed + order id).
// budget = core.lootBudgetBase x core.riskLootMult[risk] x core.playerMult[players]; slots weighted toward deeper
// rooms (procgen tier 0..2); class by tier (small 8-35, medium 35-90, heavy 150-300); some small/medium are fragile.
import type { LevelLayout, LayoutItem } from '@dead-air/shared/layout.ts';
import type { LootClass, ObjLoot } from '@dead-air/shared/messages/objectives.ts';
import { makeRng } from '@dead-air/shared/rng.ts';
import type { Rng } from '@dead-air/shared/rng.ts';

export interface LootTuning {
  lootValue: Record<LootClass, [number, number]>;
  lootClassByTier: Record<LootClass, number>[];
  lootSlotWeightByTier: number[];
  lootMaxPerSpace: number;
  lootMaxHeavy: number;
  lootFragileChance: number;
}

const NAMES: Record<LootClass, string[]> = {
  small: ['Brass valve', 'Old pager', 'Wristwatch', 'Zippo lighter', 'Film reel', 'Ceramic fuse', 'Cassette tape', 'Dog tags', 'Pocket radio', 'Silver spoon', 'Key ring', 'Tin badge'],
  medium: ['Typewriter', 'Field radio', 'Tool roll', 'Desk fan', 'Brass scale', 'Slide projector', 'Rotary phone', 'Gramophone horn', 'Signal lamp', 'Fuse box lid'],
  heavy: ['Generator head', 'Strongbox', 'Transformer coil', 'Server blade rack', 'Bronze bust', 'Pump motor'],
};
const FRAGILE: Record<LootClass, string[]> = {
  small: ['Vacuum tube', 'Glass insulator', 'Camera lens', 'Snow globe', 'Pocket mirror'],
  medium: ['Porcelain doll', 'Crystal lamp', 'Glass jar set', 'Oscilloscope', 'Stained glass pane'],
  heavy: ['Crystal chandelier'],
};

function weightedPick<T extends string>(rng: Rng, w: Record<T, number>): T {
  const keys = Object.keys(w) as T[];
  let sum = 0;
  for (const k of keys) sum += Math.max(0, w[k]);
  let r = rng.next() * sum;
  for (const k of keys) {
    r -= Math.max(0, w[k]);
    if (r <= 0) return k;
  }
  return keys[keys.length - 1];
}

export function lootBudget(core: Record<string, unknown>, risk: number, players: number): number {
  const base = Number(core.lootBudgetBase ?? 650);
  const rm = (core.riskLootMult as Record<string, number> | undefined)?.[String(risk)] ?? 1;
  const pm = (core.playerMult as Record<string, number> | undefined)?.[String(Math.max(1, Math.min(6, players)))] ?? 1;
  return Math.round(base * rm * pm);
}

/** Roll the contract's loot: fills a depth-weighted subset of the layout's loot slots until the budget is spent. */
export function rollLoot(layout: LevelLayout, seedKey: string, budget: number, t: LootTuning): ObjLoot[] {
  const rng = makeRng(seedKey, 'objectives.loot');
  const slots = layout.items.filter((i) => i.kind === 'loot');
  const perSpace = new Map<number, number>();
  const out: ObjLoot[] = [];
  let spent = 0;
  let heavy = 0;
  const pool: LayoutItem[] = slots.slice();
  const usedNames = new Set<string>();
  const nameFor = (cls: LootClass, fragile: boolean) => {
    const list = (fragile ? FRAGILE : NAMES)[cls];
    for (let k = 0; k < 4; k++) {
      const n = rng.pick(list);
      if (!usedNames.has(n)) { usedNames.add(n); return n; }
    }
    return rng.pick(list);
  };
  let guard = 0;
  while (pool.length && spent < budget && guard++ < 500) {
    // weighted slot pick (deeper tier = heavier weight, crowded rooms = lighter)
    let sum = 0;
    const ws = pool.map((s) => {
      const tier = Math.max(0, Math.min(2, Number(s.data?.tier ?? 0)));
      const crowd = perSpace.get(s.space) ?? 0;
      const w = crowd >= t.lootMaxPerSpace ? 0 : (t.lootSlotWeightByTier[tier] ?? 1) / (1 + crowd * 1.5);
      sum += w;
      return w;
    });
    if (sum <= 0) break;
    let r = rng.next() * sum;
    let idx = 0;
    for (; idx < ws.length - 1; idx++) { r -= ws[idx]; if (r <= 0) break; }
    const slot = pool.splice(idx, 1)[0];
    const tier = Math.max(0, Math.min(2, Number(slot.data?.tier ?? 0)));
    const w = { ...(t.lootClassByTier[tier] ?? { small: 1, medium: 0, heavy: 0 }) };
    if (heavy >= t.lootMaxHeavy) w.heavy = 0;
    const remaining = budget - spent;
    // don't open a heavy item that would blow far past the budget
    if (remaining < t.lootValue.heavy[0] * 0.8) w.heavy = 0;
    if (remaining < t.lootValue.medium[0] * 0.8) w.medium = 0;
    if (w.small + w.medium + w.heavy <= 0) w.small = 1;
    const cls = weightedPick(rng, w);
    const [lo, hi] = t.lootValue[cls];
    let value = rng.int(lo, hi);
    if (value > remaining && cls === 'small') value = Math.max(lo, remaining);
    const fragile = cls !== 'heavy' && rng.chance(t.lootFragileChance);
    if (cls === 'heavy') heavy++;
    spent += value;
    perSpace.set(slot.space, (perSpace.get(slot.space) ?? 0) + 1);
    out.push({
      id: slot.id,
      type: `loot.${cls}`,
      cls,
      name: nameFor(cls, fragile),
      value,
      fragile,
      where: 'world',
      p: [slot.x, slot.y ?? 0, slot.z],
      rot: slot.rot ?? 0,
      space: slot.space,
      tier,
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  return out;
}
