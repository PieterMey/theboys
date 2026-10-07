// Owner: env-layout (v1.2). Contract skeleton: keep every export/signature; env-layout tunes the tables. Pure.
import type { LevelLayout } from '../layout.ts';

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
  /** preferred EXISTING callsigns (stable reorder, never new callsigns) */
  prefer: { landmarks: readonly string[]; rooms: readonly string[] };
  /** paranormal haunt bias -0.1..0.15 */
  haunt: number;
}

const T = (id: SiteTheme, base: SiteTheme | null, label: string, landmarks: string[], rooms: string[], haunt: number): ThemeDef =>
  ({ id, base, label, prefer: { landmarks, rooms }, haunt });
export const THEMES: Readonly<Record<SiteTheme, ThemeDef>> = {
  facility: T('facility', null, 'FACILITY', [], [], 0),
  hospital: T('hospital', null, 'HOSPITAL', ['MORGUE', 'CHAPEL'], ['INFIRMARY', 'NURSERY', 'SHOWERS', 'LAUNDRY', 'CRYO', 'KITCHEN'], 0.1),
  waterworks: T('waterworks', null, 'WATERWORKS', ['BOILER', 'STORES'], ['PUMPS', 'TANKS', 'SHOWERS', 'PIT', 'FURNACE', 'GARAGE'], 0),
  industry: T('industry', 'waterworks', 'INDUSTRIAL', ['BOILER', 'STORES'], ['FOUNDRY', 'FURNACE', 'PIT', 'GARAGE', 'DOCK', 'TANKS'], 0),
  records: T('records', null, 'RECORDS', ['LIBRARY', 'SERVER'], ['ARCHIVE', 'OFFICE', 'WARDEN', 'MAILROOM', 'GALLERY'], 0.05),
  hospitality: T('hospitality', 'records', 'HOSPITALITY', ['CANTEEN', 'LIBRARY'], ['KITCHEN', 'LAUNDRY', 'SHOWERS', 'NURSERY', 'GALLERY', 'CHAPEL'], 0.05),
  cold_storage: T('cold_storage', null, 'COLD STORAGE', ['STORES'], ['COLDROOM', 'CRYO', 'DOCK', 'KITCHEN', 'PUMPS', 'TANKS'], 0.05),
  comms: T('comms', 'records', 'COMMS', ['SERVER', 'LIBRARY'], ['OFFICE', 'ARCHIVE', 'MAILROOM', 'WARDEN'], 0.05),
  transport: T('transport', 'industry', 'TRANSPORT', ['STORES', 'CANTEEN'], ['GALLERY', 'GARAGE', 'DOCK', 'PIT', 'MAILROOM'], 0),
  retail: T('retail', 'hospitality', 'RETAIL', ['CANTEEN', 'STORES'], ['GALLERY', 'OFFICE', 'MAILROOM'], 0.05),
  parish: T('parish', 'records', 'PARISH', ['CHAPEL', 'LIBRARY'], ['GALLERY', 'ARCHIVE', 'MORGUE', 'NURSERY'], 0.15),
  baths: T('baths', 'hospital', 'BATHS', ['BOILER'], ['SHOWERS', 'PIT', 'PUMPS', 'LAUNDRY', 'TANKS'], 0.05),
  greenhouse: T('greenhouse', 'waterworks', 'GREENHOUSE', ['STORES'], ['GREENHOUSE', 'NURSERY', 'PUMPS', 'TANKS', 'KITCHEN'], 0),
  laundry: T('laundry', 'hospital', 'LAUNDRY', ['BOILER', 'CANTEEN'], ['LAUNDRY', 'SHOWERS', 'KITCHEN', 'STORES', 'PUMPS'], 0),
};

export function isSiteTheme(v: unknown): v is SiteTheme {
  return typeof v === 'string' && (SITE_THEMES as readonly string[]).includes(v);
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

/** 'light' item data.kind values; render draws unknown kinds as 'tube' */
export const FIXTURE_KINDS = ['tube', 'lamp', 'wall', 'van', 'bulb', 'sconce', 'highbay', 'emergency', 'candle', 'led_strip', 'flood', 'headlight'] as const;

export type FloorSurface = 'concrete' | 'tile' | 'metal' | 'grate' | 'carpet' | 'wood' | 'rubber' | 'lino' | 'asphalt' | 'dirt';

const CLINICAL = new Set(['morgue', 'infirmary', 'showers', 'cold', 'cryo', 'kitchen', 'laundry', 'nursery']);
const INDUSTRIAL = new Set(['boiler', 'furnace', 'foundry', 'pumps', 'tanks', 'garage', 'dock', 'pit', 'storage', 'greenhouse']);
const HEAVY = new Set(['boiler', 'furnace', 'foundry', 'pumps', 'tanks']);
/** floor of a space (server footstep noise, client step sfx). Must equal the floor the client palette draws; the
 *  skeleton is the exact v1.1 mesher mapping ('facility'); env-layout extends it per theme. L.metrics carries the applied
 *  modifiers (metrics['mod:hardfloors'] = 1), so pass the whole layout on server and client alike. */
export function floorSurface(L: Pick<LevelLayout, 'theme' | 'spaces' | 'metrics'>, space: number): FloorSurface {
  const s = L.spaces[space];
  if (!s) return 'concrete';
  if (s.type === 'van') return 'metal';
  if (s.kind === 'outside') return s.type === 'kennel' ? 'dirt' : 'asphalt';
  if (s.kind === 'corridor') return 'lino';
  if (s.kind === 'vault') return 'metal';
  if (s.type === 'lobby' || CLINICAL.has(s.type)) return 'tile';
  if (INDUSTRIAL.has(s.type)) return HEAVY.has(s.type) ? 'metal' : 'concrete';
  if (s.type === 'server' || s.type === 'radio') return 'rubber';
  return 'lino';
}
