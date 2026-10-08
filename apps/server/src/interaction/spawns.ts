// Owner: interaction (G3, v1.2). Pure, deterministic spawn planners (no ctx, no state): special finds, crafting
// materials and drawer contents. engine.ts calls them; tests/gear/finds.test.ts drives them over hundreds of seeds.
// Every planner owns one named rng stream on `${L.seed}:${L.hash}`, so adding one never moves another's draws, and the
// v1.1 find types keep their exact rolls (they come first in specialFinds and consume the same draws as before).
import type { LayoutItem, LevelLayout } from '@dead-air/shared/layout.ts';
import type { ContainerInfo } from '@dead-air/shared/procgen/containers.ts';
import { makeRng } from '@dead-air/shared/rng.ts';
import type { Rng } from '@dead-air/shared/rng.ts';
import { CURIOS, CURIO_TYPE, GEAR_V12, MATERIAL_TYPES } from '@dead-air/shared/catalog.ts';
import { ITEM_DEFS, LOOT_NAMES, LOOT_TIER_TYPES } from '@dead-air/shared/interactables.ts';

type V3 = [number, number, number];

/** one item to create: at a floor slot (finds, materials) or inside a container (contents: p is set at opening) */
export interface SpawnSpec {
  type: string;
  p?: V3;
  rot?: number;
  /** layout slot id it took */
  slot?: string;
  count?: number;
  value?: number;
  name?: string;
  tier?: number;
}

const V12_GEAR = new Set<string>([...GEAR_V12, CURIO_TYPE]);
const clamp01 = (x: unknown): number => Math.max(0, Math.min(1, Number(x) || 0));
const roomType = (L: LevelLayout, sl: LayoutItem): string => L.spaces[sl.space]?.type ?? '';

// ---------------------------------------------------------------- special finds

export interface FindsCfg {
  /** type -> chance (iteration order = JSON order; the v1.1 types first) */
  finds: Record<string, number>;
  /** type -> preferred room types (v1.2 gear) */
  findRooms?: Record<string, string[]>;
  minDistFrac: number;
  /** v1.1 cursed idol value range */
  idolValue: [number, number];
  /** v1.2 curio value range */
  curioValue: [number, number];
  /** flag gearV12: false = only the v1.1 find types */
  gearV12: boolean;
}

/**
 * Rare finds in the deepest rooms (dist >= minDistFrac x the deepest room, never corridors). v1.2 gear prefers its
 * findRooms (a deep slot there, else any room slot there, else any deep slot). The master keycard only spawns on sites
 * with a keycard-locked door. At most one of each type per site. Returns the specs and the slot ids they took.
 */
export function planFinds(L: LevelLayout, free: readonly LayoutItem[], cfg: FindsCfg): { specs: SpawnSpec[]; used: Set<string> } {
  const used = new Set<string>();
  const specs: SpawnSpec[] = [];
  const maxD = Math.max(0, ...L.spaces.map((sp) => sp.dist ?? 0));
  const minD = maxD * cfg.minDistFrac;
  const deep = free.filter((sl) => (L.spaces[sl.space]?.dist ?? 0) >= minD && L.spaces[sl.space]?.kind !== 'corridor').slice();
  const rng = makeRng(`${L.seed}:${L.hash}`, 'interaction.finds');
  rng.shuffle(deep);
  const hasLocked = L.doors.some((d) => d.kind === 'locked');
  for (const [type, chance] of Object.entries(cfg.finds)) {
    if (!ITEM_DEFS[type]) continue;
    const v12 = V12_GEAR.has(type);
    if (v12 && !cfg.gearV12) continue;
    if (type === 'masterkey' && !hasLocked) continue;
    if (!deep.length) continue;
    if (!rng.chance(clamp01(chance))) continue;
    let sl: LayoutItem | undefined;
    const rooms = v12 ? cfg.findRooms?.[type] : undefined;
    if (rooms?.length) {
      const i = deep.findIndex((x) => rooms.includes(roomType(L, x)));
      if (i >= 0) sl = deep.splice(i, 1)[0];
      else {
        const any = free.filter((x) => !used.has(x.id) && rooms.includes(roomType(L, x)) && L.spaces[x.space]?.kind !== 'corridor');
        if (any.length) {
          sl = any[rng.int(0, any.length - 1)];
          const j = deep.indexOf(sl!);
          if (j >= 0) deep.splice(j, 1);
        }
      }
    }
    sl ??= deep.shift()!;
    used.add(sl.id);
    const spec: SpawnSpec = { type, p: [sl.x, 0, sl.z], rot: sl.rot ?? 0, slot: sl.id };
    if (type === 'loot.idol') Object.assign(spec, { value: rng.int(cfg.idolValue[0], cfg.idolValue[1]), tier: 2, name: 'Cursed idol' });
    if (type === CURIO_TYPE) Object.assign(spec, { value: rng.int(cfg.curioValue[0], cfg.curioValue[1]), tier: 2, name: rng.pick(CURIOS) });
    const st = ITEM_DEFS[type]?.stack;
    if (st && type !== 'loot.idol') spec.count = st;
    specs.push(spec);
  }
  return { specs, used };
}

// ---------------------------------------------------------------- crafting materials

export interface MaterialsCfg {
  baseCount: number;
  perPlayer: number;
  /** count multiplier at risk >= 2 */
  riskMult: number;
  units: [number, number];
  /** weight multiplier of a material in one of its affinity rooms */
  affinityMult: number;
  affinity: Record<string, string[]>;
  relicRooms: string[];
  relicChance: number;
}

export const MATERIALS_DEFAULT: MaterialsCfg = {
  baseCount: 6, perPlayer: 2, riskMult: 1.25, units: [1, 2], affinityMult: 4,
  affinity: {
    'mat.scrap': ['garage', 'foundry', 'furnace', 'dock', 'storage', 'pit'],
    'mat.wiring': ['server', 'radio', 'mailroom', 'office', 'archive'],
    'mat.chem': ['laundry', 'kitchen', 'infirmary', 'cryo', 'tanks', 'greenhouse', 'showers'],
    'mat.optics': ['gallery', 'office', 'archive', 'library', 'radio'],
    'mat.cells': ['server', 'radio', 'garage', 'storage', 'dock'],
  },
  relicRooms: ['chapel', 'gallery', 'morgue'], relicChance: 0.08,
};

/** number of material pickups for a crew size / risk: round((base + perPlayer x players) x (risk >= 2 ? riskMult : 1)) */
export function materialCount(players: number, risk: number, cfg: MaterialsCfg = MATERIALS_DEFAULT): number {
  return Math.max(0, Math.round((cfg.baseCount + cfg.perPlayer * Math.max(1, players)) * (risk >= 2 ? cfg.riskMult : 1)));
}

/** a material for a room type: the relic only in relicRooms (relicChance), else the five base materials weighted
 *  affinityMult in their affinity rooms */
export function pickMaterial(rng: Rng, room: string, cfg: MaterialsCfg = MATERIALS_DEFAULT): string {
  if (cfg.relicRooms.includes(room) && rng.chance(cfg.relicChance)) return 'mat.relic';
  const base = MATERIAL_TYPES.filter((t) => t !== 'mat.relic');
  const w = base.map((t) => (cfg.affinity[t]?.includes(room) ? cfg.affinityMult : 1));
  let r = rng.next() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < base.length; i++) {
    r -= w[i]!;
    if (r < 0) return base[i]!;
  }
  return base[base.length - 1]!;
}

/** material pickups (1-2 units each) on free floor slots (never the lot or the van); one slot each */
export function planMaterials(L: LevelLayout, free: readonly LayoutItem[], players: number, risk: number, cfg: MaterialsCfg = MATERIALS_DEFAULT): SpawnSpec[] {
  const rng = makeRng(`${L.seed}:${L.hash}`, 'interaction.materials');
  const slots = rng.shuffle(free.filter((sl) => {
    const sp = L.spaces[sl.space];
    return !!sp && sp.kind !== 'outside' && sp.type !== 'van';
  }));
  const n = Math.min(slots.length, materialCount(players, risk, cfg));
  const out: SpawnSpec[] = [];
  for (let i = 0; i < n; i++) {
    const sl = slots[i]!;
    const type = pickMaterial(rng, roomType(L, sl), cfg);
    out.push({ type, p: [sl.x, 0, sl.z], rot: sl.rot ?? 0, slot: sl.id, count: rng.int(cfg.units[0], cfg.units[1]) });
  }
  return out;
}

// ---------------------------------------------------------------- container contents

export interface ContainerLootCfg {
  emptyChance: number;
  secondItemChance: number;
  /** entry -> weight; entries: 'loot' (tier 0-1 salvage from the drawer budget), 'mat' (a material) or an item type */
  default: Record<string, number>;
  kinds: Record<string, Record<string, number>>;
  rooms: Record<string, Record<string, number>>;
  /** item type -> count in a drawer */
  counts: Record<string, number>;
}

export const CONTAINER_LOOT_DEFAULT: ContainerLootCfg = {
  emptyChance: 0.4, secondItemChance: 0.25,
  default: { loot: 5, mat: 3, bottle: 1, glowstick: 1 },
  kinds: {
    cabinet: { loot: 4, mat: 2, bottle: 2, glowstick: 2, flare: 1 },
    desk: { loot: 6, mat: 2, glowstick: 1, battery: 1 },
    filing: { loot: 5, mat: 2 },
    tool_chest: { crowbar: 2, mat: 5, loot: 2, flare: 1, battery: 1 },
    morgue_drawers: { loot: 4, mat: 2 },
    counter: { bottle: 3, loot: 3, mat: 2, glowstick: 1 },
  },
  rooms: { infirmary: { medkit: 3 }, morgue: { medkit: 1 }, garage: { flare: 1 }, dock: { flare: 1 } },
  counts: { bottle: 1, glowstick: 2, flare: 1, battery: 1 },
};

export interface ContainerRoll {
  contents: Map<string, SpawnSpec[]>;
  /** salvage value placed in drawers (the floor gets budget - spent) */
  spent: number;
}

/**
 * Roll every container's private contents once per layout: ~emptyChance empty, else 1-2 entries from the merged
 * default / kind / room-type weights. 'loot' draws tier 0-1 salvage (the host's tier hint, at most 1) from `budget`
 * (containerBudgetFrac of the site's salvage); 'mat' only with materials on; v1.2 gear only with gearV12.
 */
export function rollContainers(
  L: LevelLayout, list: readonly ContainerInfo[], budget: number,
  o: { cfg?: ContainerLootCfg; materials: boolean; gearV12: boolean; salvage: boolean; tierValues: [number, number][]; matCfg?: MaterialsCfg },
): ContainerRoll {
  const cfg = o.cfg ?? CONTAINER_LOOT_DEFAULT;
  const rng = makeRng(`${L.seed}:${L.hash}`, 'interaction.containers');
  const contents = new Map<string, SpawnSpec[]>();
  let spent = 0;
  const tv = (t: number): [number, number] => o.tierValues[t] ?? [10, 30];
  for (const c of list) {
    const out: SpawnSpec[] = [];
    contents.set(c.id, out);
    if (rng.chance(clamp01(cfg.emptyChance))) continue;
    const table: Record<string, number> = { ...cfg.default, ...(cfg.kinds[c.kind] ?? {}) };
    for (const [k, w] of Object.entries(cfg.rooms[c.roomType] ?? {})) table[k] = (table[k] ?? 0) + w;
    const entries = Object.entries(table).filter(([k, w]) => {
      if (!(w > 0)) return false;
      if (k === 'loot') return o.salvage;
      if (k === 'mat') return o.materials;
      if (!ITEM_DEFS[k]) return false;
      return !V12_GEAR.has(k) || o.gearV12;
    });
    const n = 1 + (rng.chance(clamp01(cfg.secondItemChance)) ? 1 : 0);
    for (let i = 0; i < n && entries.length; i++) {
      let r = rng.next() * entries.reduce((a, [, w]) => a + w, 0);
      let pick = entries[entries.length - 1]![0];
      for (const [k, w] of entries) {
        r -= w;
        if (r < 0) { pick = k; break; }
      }
      if (pick === 'loot') {
        let tier = Math.max(0, Math.min(1, Math.round(c.tier ?? 0)));
        let value = rng.int(tv(tier)[0], tv(tier)[1]);
        if (spent + value > budget * 1.08) {
          tier = 0;
          value = rng.int(tv(0)[0], tv(0)[1]);
        }
        if (spent + value <= budget * 1.08) {
          spent += value;
          out.push({ type: LOOT_TIER_TYPES[tier]!, value, tier, name: rng.pick(LOOT_NAMES[tier]!) });
          continue;
        }
        // the drawer budget is spent: the drawer holds something else from its table instead of standing empty
        const rest = entries.filter(([k]) => k !== 'loot');
        if (!rest.length) continue;
        let r2 = rng.next() * rest.reduce((a, [, w]) => a + w, 0);
        pick = rest[rest.length - 1]![0];
        for (const [k, w] of rest) {
          r2 -= w;
          if (r2 < 0) { pick = k; break; }
        }
      }
      if (pick === 'mat') {
        const mc = o.matCfg ?? MATERIALS_DEFAULT;
        out.push({ type: pickMaterial(rng, c.roomType, mc), count: rng.int(mc.units[0], mc.units[1]) });
      } else {
        // one of a kind per drawer (a second roll of the same gear is dropped)
        if (out.some((x) => x.type === pick)) continue;
        out.push({ type: pick, ...(cfg.counts[pick] ? { count: cfg.counts[pick] } : {}) });
      }
    }
  }
  return { contents, spent };
}
