// Owner: env-layout (v1.2; edited by agent E1-A, see the E1 progress log). Site themes: the theme table (callsign
// preference, look fallback chain), the work-order modifier slugs and their generation overlays, and the floor surface
// of every space (server footsteps = client palette). Pure; 'facility' with no modifiers is exactly the v1.1 generator.
import type { LayoutSpace, LevelLayout } from '../layout.ts';
import type { LevelTuning, LevelTuningOverrides } from './tuning.ts';
import { overlayTuning } from './tuning.ts';

export const SITE_THEMES = [
  'facility', 'hospital', 'waterworks', 'industry', 'records', 'hospitality', 'cold_storage', 'comms',
  'transport', 'retail', 'parish', 'baths', 'greenhouse', 'laundry',
] as const;
export type SiteTheme = (typeof SITE_THEMES)[number];

export interface ThemeDef {
  id: SiteTheme;
  /** looks fall back to this theme where this one is not dressed (null = facility) */
  base: SiteTheme | null;
  label: string;
  /** preferred EXISTING callsigns (stable reorder, never new callsigns); avoid = off-theme callsigns moved to the end
   *  (used only when a big site runs out of others) */
  prefer: { landmarks: readonly string[]; rooms: readonly string[]; avoid?: readonly string[] };
  /** paranormal haunt bias -0.1..0.15 */
  haunt: number;
}

const T = (id: SiteTheme, base: SiteTheme | null, label: string, landmarks: string[], rooms: string[], haunt: number, avoid?: string[]): ThemeDef =>
  ({ id, base, label, prefer: avoid ? { landmarks, rooms, avoid } : { landmarks, rooms }, haunt });
export const THEMES: Readonly<Record<SiteTheme, ThemeDef>> = {
  facility: T('facility', null, 'FACILITY', [], [], 0),
  hospital: T('hospital', null, 'HOSPITAL', ['MORGUE', 'CHAPEL'], ['INFIRMARY', 'NURSERY', 'SHOWERS', 'LAUNDRY', 'CRYO', 'KITCHEN'], 0.1,
    ['FOUNDRY', 'FURNACE', 'PIT', 'GARAGE', 'DOCK', 'TANKS', 'GREENHOUSE']),
  waterworks: T('waterworks', null, 'WATERWORKS', ['BOILER', 'STORES'], ['PUMPS', 'TANKS', 'SHOWERS', 'PIT', 'FURNACE', 'GARAGE'], 0,
    ['MORGUE', 'CHAPEL', 'NURSERY', 'GALLERY', 'LIBRARY', 'INFIRMARY']),
  industry: T('industry', 'waterworks', 'INDUSTRIAL', ['BOILER', 'STORES'], ['FOUNDRY', 'FURNACE', 'PIT', 'GARAGE', 'DOCK', 'TANKS'], 0,
    ['MORGUE', 'CHAPEL', 'NURSERY', 'GALLERY', 'LIBRARY', 'INFIRMARY', 'GREENHOUSE']),
  records: T('records', null, 'RECORDS', ['LIBRARY', 'SERVER'], ['ARCHIVE', 'OFFICE', 'WARDEN', 'MAILROOM', 'GALLERY'], 0.05,
    ['FOUNDRY', 'FURNACE', 'PIT', 'TANKS', 'PUMPS', 'GREENHOUSE', 'MORGUE', 'GARAGE', 'DOCK']),
  hospitality: T('hospitality', 'records', 'HOSPITALITY', ['CANTEEN', 'LIBRARY'], ['KITCHEN', 'LAUNDRY', 'SHOWERS', 'NURSERY', 'GALLERY', 'CHAPEL'], 0.05,
    ['FOUNDRY', 'FURNACE', 'PIT', 'TANKS', 'MORGUE', 'CRYO', 'GARAGE']),
  cold_storage: T('cold_storage', null, 'COLD STORAGE', ['STORES'], ['COLDROOM', 'CRYO', 'DOCK', 'KITCHEN', 'PUMPS', 'TANKS'], 0.05,
    ['CHAPEL', 'NURSERY', 'GALLERY', 'LIBRARY', 'FOUNDRY', 'GREENHOUSE', 'INFIRMARY', 'MORGUE']),
  comms: T('comms', 'records', 'COMMS', ['SERVER', 'LIBRARY'], ['OFFICE', 'ARCHIVE', 'MAILROOM', 'WARDEN'], 0.05,
    ['FOUNDRY', 'FURNACE', 'PIT', 'MORGUE', 'GREENHOUSE', 'CRYO', 'NURSERY']),
  transport: T('transport', 'industry', 'TRANSPORT', ['STORES', 'CANTEEN'], ['GALLERY', 'GARAGE', 'DOCK', 'PIT', 'MAILROOM'], 0,
    ['MORGUE', 'CHAPEL', 'NURSERY', 'CRYO', 'GREENHOUSE', 'FOUNDRY', 'INFIRMARY']),
  retail: T('retail', 'hospitality', 'RETAIL', ['CANTEEN', 'STORES'], ['GALLERY', 'OFFICE', 'MAILROOM'], 0.05,
    ['FOUNDRY', 'FURNACE', 'PIT', 'MORGUE', 'CRYO', 'TANKS', 'PUMPS']),
  parish: T('parish', 'records', 'PARISH', ['CHAPEL', 'LIBRARY'], ['GALLERY', 'ARCHIVE', 'MORGUE', 'NURSERY'], 0.15,
    ['FOUNDRY', 'FURNACE', 'PIT', 'TANKS', 'PUMPS', 'GARAGE', 'DOCK', 'SERVER', 'CRYO']),
  baths: T('baths', 'hospital', 'BATHS', ['BOILER'], ['SHOWERS', 'PIT', 'PUMPS', 'LAUNDRY', 'TANKS'], 0.05,
    ['FOUNDRY', 'MORGUE', 'CHAPEL', 'LIBRARY', 'GALLERY', 'GARAGE', 'DOCK', 'SERVER']),
  greenhouse: T('greenhouse', 'waterworks', 'GREENHOUSE', ['STORES'], ['GREENHOUSE', 'NURSERY', 'PUMPS', 'TANKS', 'KITCHEN'], 0,
    ['MORGUE', 'CHAPEL', 'FOUNDRY', 'CRYO', 'SERVER', 'GALLERY', 'LIBRARY']),
  laundry: T('laundry', 'hospital', 'LAUNDRY', ['BOILER', 'CANTEEN'], ['LAUNDRY', 'SHOWERS', 'KITCHEN', 'STORES', 'PUMPS'], 0,
    ['FOUNDRY', 'MORGUE', 'CHAPEL', 'LIBRARY', 'GALLERY', 'SERVER', 'PIT']),
};

export function isSiteTheme(v: unknown): v is SiteTheme {
  return typeof v === 'string' && (SITE_THEMES as readonly string[]).includes(v);
}

/** look/generation fallback chain of a theme: [theme, base, base of base, ...], without 'facility' (= the v1.1 look) */
export function themeChain(theme: string | null | undefined): SiteTheme[] {
  const out: SiteTheme[] = [];
  let t: SiteTheme | null = themeFor(theme);
  while (t && t !== 'facility' && !out.includes(t)) { out.push(t); t = THEMES[t].base; }
  return out;
}

const SITE_THEME: Readonly<Record<string, SiteTheme>> = {
  'Halvorsen Cold Storage': 'cold_storage', 'St. Brannock Infirmary, East Wing': 'hospital',
  'Mercer & Pell Records Depository': 'records', 'Lowmoor Pumping Station No. 4': 'waterworks',
  'The Gilded Lantern Hotel, Service Levels': 'hospitality', 'Varga Brothers Foundry': 'industry',
  'Old Quarry Road Telephone Exchange': 'comms', 'Wetherby Municipal Laundry': 'laundry',
  'Kestrel Point Ferry Terminal': 'transport', 'Fenwick Hall Boarding School, Lower Floors': 'hospitality',
  'Dunmore Radio Relay Station': 'comms', 'Corrigan Shoe Factory': 'industry', 'Brightwater Public Baths': 'baths',
  'Northgate Parcel Sorting Centre': 'transport', 'Our Lady of the Sound, Chapel and Hall': 'parish',
  'Tidewell Greenhouses': 'greenhouse', 'Marrow Lane Bus Depot': 'transport', 'Halcyon Department Store, Closed Floors': 'retail',
  'Pellam County Courthouse Archive': 'records', 'Ironside Grain Silo Offices': 'industry',
  "Wren's End Holiday Camp, Staff Quarters": 'hospitality', 'Okonkwo Natural History Museum, Deep Storage': 'records',
  'Blackwater Waterworks': 'waterworks', 'Lindqvist Piano Works': 'industry',
};
/** template site name -> theme (all 24 sites in apps/server/src/meta/templates.ts) */
export function siteThemeOf(siteName: string): SiteTheme | undefined {
  return SITE_THEME[siteName];
}
/** a known id wins; anything else is 'facility' (never a random theme) */
export function themeFor(requested: string | null | undefined): SiteTheme {
  return isSiteTheme(requested) ? requested : 'facility';
}
export function themeOf(L: Pick<LevelLayout, 'theme'>): SiteTheme {
  return themeFor(L.theme);
}

/** work-order chip -> slug of a generation/look change (L.metrics['mod:<slug>'] = 1 when applied); others are flavour */
export const MODIFIER_SLUG: Readonly<Record<string, string>> = {
  MAZE: 'maze', 'TIGHT HALLS': 'tight', 'OPEN HALLS': 'open', 'OPEN SIGHTLINES': 'open', 'LARGE BAYS': 'open',
  'LONG CORRIDORS': 'long', 'DARK WARDS': 'dark', DARK: 'dark', CLUTTERED: 'cluttered', LOCKERS: 'lockers',
  'HARD FLOORS': 'hardfloors', DAMP: 'damp', 'LOW VISIBILITY': 'lowvis', COLD: 'cold', ECHOES: 'echoes', 'MACHINE NOISE': 'machine',
};
export function modifierSlugs(mods: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const m of mods ?? []) {
    const s = MODIFIER_SLUG[String(m).toUpperCase()];
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** modifier slugs that change generation (dropped on the last 3 attempts so a site never fails to generate); the
 *  others only change looks / sound (hardfloors: floorSurface, damp: clutter puddles, lowvis/cold/echoes/machine) */
export const GEN_MODIFIERS: ReadonlySet<string> = new Set(['maze', 'tight', 'open', 'long', 'dark', 'cluttered', 'lockers']);
const r3 = (v: number) => Math.round(v * 1000) / 1000;
/** generation overlays per modifier slug, over the resolved (theme) tuning */
export const MODIFIER_TUNING: Readonly<Record<string, (t: LevelTuning) => LevelTuningOverrides>> = {
  maze: () => ({ innerAbsent: 0.05, innerPartial: 0.55, roomRoomDoorChance: 0.15 }),
  tight: () => ({ blockTarget: 14 }),
  open: () => ({ hallChance: 0.85, hallMaxArea: 400 }),
  // retuned from blockTarget 21 (plan check #3: GenFail rooms at 4-6 players); +6 m2/player max room area keeps the room
  // count in range (forced on every attempt: 6p retries 48% vs 53% for plain sites)
  long: (t) => ({ blockTarget: 19, innerAbsent: 0.3, bspMaxAreaPerPlayer: t.bspMaxAreaPerPlayer + 6 }),
  dark: (t) => ({ lightOffBase: r3(t.lightOffBase + 0.08) }),
  cluttered: () => ({ decorAreaPerProp: 3.6 }),
  lockers: (t) => ({ hidingRoomChance: Math.min(0.95, r3(t.hidingRoomChance * 1.5)) }),
};
/** mild per-theme look tuning (never structural: the rooms and doors of a seed stay those of the facility theme) */
export const THEME_TUNING: Readonly<Partial<Record<SiteTheme, LevelTuningOverrides>>> = {
  hospital: { lightFlickerBase: 0.15, hidingRoomChance: 0.65 },
  waterworks: { lightOffBase: 0.06, decorAreaPerProp: 4.2 },
  records: { decorAreaPerProp: 4.0, lightFlickerBase: 0.1 },
  cold_storage: { lightOffBase: 0.05, lightFlickerBase: 0.14 },
  hospitality: { decorAreaPerProp: 4.2, lightOffBase: 0.03 },
  comms: { lightFlickerBase: 0.14 },
  parish: { lightOffBase: 0.06 },
};
/** the tuning one generation attempt uses: base, the theme overlays (base of the chain first), then each generation
 *  modifier in slug order. withMods false drops the modifiers (the last 3 attempts). */
export function themedTuning(base: LevelTuning, theme: SiteTheme, slugs: readonly string[], withMods = true): LevelTuning {
  let t = base;
  for (const th of themeChain(theme).reverse()) { const o = THEME_TUNING[th]; if (o) t = overlayTuning(t, o); }
  if (withMods) for (const sl of [...slugs].sort()) { const f = MODIFIER_TUNING[sl]; if (f) t = overlayTuning(t, f(t)); }
  return t;
}

/** 'light' item data.kind values; render draws unknown kinds as 'tube' */
export const FIXTURE_KINDS = ['tube', 'lamp', 'wall', 'van', 'bulb', 'sconce', 'highbay', 'emergency', 'candle', 'led_strip', 'flood', 'headlight'] as const;

export type FloorSurface = 'concrete' | 'tile' | 'metal' | 'grate' | 'carpet' | 'wood' | 'rubber' | 'lino' | 'asphalt' | 'dirt';

const CLINICAL = new Set(['morgue', 'infirmary', 'showers', 'cold', 'cryo', 'kitchen', 'laundry', 'nursery']);
const INDUSTRIAL = new Set(['boiler', 'furnace', 'foundry', 'pumps', 'tanks', 'garage', 'dock', 'pit', 'storage', 'greenhouse']);
const HEAVY = new Set(['boiler', 'furnace', 'foundry', 'pumps', 'tanks']);
/** the v1.1 mesher mapping (theme 'facility') for corridors and rooms */
function facilityFloor(s: LayoutSpace): FloorSurface {
  if (s.kind === 'corridor') return 'lino';
  if (s.type === 'lobby' || CLINICAL.has(s.type)) return 'tile';
  if (INDUSTRIAL.has(s.type)) return HEAVY.has(s.type) ? 'metal' : 'concrete';
  if (s.type === 'server' || s.type === 'radio') return 'rubber';
  return 'lino';
}
/** per-theme floors keyed by 'corridor' or a room type, looked up along the theme chain (theme, its base, ...), else the
 *  facility mapping. Van, outdoor and vault floors never change. */
export const THEME_FLOORS: Readonly<Partial<Record<SiteTheme, Readonly<Record<string, FloorSurface>>>>> = {
  hospital: { chapel: 'wood', office: 'lino', canteen: 'tile', gallery: 'lino' },
  waterworks: { corridor: 'concrete', pumps: 'grate', tanks: 'grate', pit: 'grate', boiler: 'metal', furnace: 'metal', storage: 'concrete', garage: 'concrete', greenhouse: 'concrete', dock: 'concrete' },
  industry: { foundry: 'metal', furnace: 'metal', pit: 'dirt', mailroom: 'concrete' },
  records: { corridor: 'wood', office: 'carpet', library: 'carpet', archive: 'lino', gallery: 'wood', chapel: 'wood', canteen: 'wood', mailroom: 'lino' },
  hospitality: { corridor: 'carpet', office: 'carpet', nursery: 'carpet', canteen: 'wood', gallery: 'wood', library: 'carpet', chapel: 'wood' },
  cold_storage: { corridor: 'concrete', cold: 'concrete', cryo: 'metal', dock: 'concrete', storage: 'concrete', pumps: 'grate', tanks: 'grate' },
  comms: { corridor: 'lino', office: 'carpet', archive: 'lino', mailroom: 'lino', library: 'carpet', server: 'rubber' },
  transport: { corridor: 'tile', gallery: 'tile', canteen: 'tile', office: 'lino', mailroom: 'concrete' },
  retail: { corridor: 'lino', gallery: 'carpet', canteen: 'tile', mailroom: 'lino', storage: 'concrete' },
  parish: { corridor: 'wood', chapel: 'tile', gallery: 'wood', library: 'carpet', archive: 'wood', nursery: 'carpet', canteen: 'wood', office: 'carpet' },
  baths: { corridor: 'tile', office: 'lino', storage: 'concrete', pumps: 'grate', tanks: 'grate', boiler: 'metal', gallery: 'tile', canteen: 'tile' },
  greenhouse: { corridor: 'concrete', greenhouse: 'dirt', nursery: 'dirt', storage: 'concrete', office: 'lino' },
  laundry: { corridor: 'lino', boiler: 'metal', pumps: 'grate', storage: 'concrete', canteen: 'lino' },
};
/** HARD FLOORS (metrics['mod:hardfloors'] = 1): soft indoor floors become hard */
export const HARD_FLOOR: Readonly<Partial<Record<FloorSurface, FloorSurface>>> = { carpet: 'tile', rubber: 'tile', lino: 'tile', dirt: 'concrete' };
/** floor of a space (server footstep noise, client step sfx). Must equal the floor the client palette draws: 'facility'
 *  is the exact v1.1 mesher mapping, themes override it per corridor / room type (THEME_FLOORS along the theme chain)
 *  and metrics['mod:hardfloors'] = 1 hardens soft indoor floors. Pass the whole layout on server and client alike. */
export function floorSurface(L: Pick<LevelLayout, 'theme' | 'spaces' | 'metrics'>, space: number): FloorSurface {
  const s = L.spaces[space];
  if (!s) return 'concrete';
  if (s.type === 'van') return 'metal';
  if (s.kind === 'outside') return s.type === 'kennel' ? 'dirt' : 'asphalt';
  if (s.kind === 'vault') return 'metal';
  const key = s.kind === 'corridor' ? 'corridor' : s.type;
  let f: FloorSurface | undefined;
  for (const t of themeChain(L.theme)) { f = THEME_FLOORS[t]?.[key]; if (f) break; }
  f ??= facilityFloor(s);
  if (L.metrics?.['mod:hardfloors'] === 1) f = HARD_FLOOR[f] ?? f;
  return f;
}
