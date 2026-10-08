// Owner: env-world (v1.2). Per-theme surface palettes: which level materials (MatId) a space's floor, wainscot, upper
// wall and ceiling use. Pure (no THREE / DOM), so tests run it in Node.
//   - facility (and the hub) use exactly the v1.1 mesher mapping;
//   - hospital, waterworks, records and cold_storage are dressed with their own walls / ceilings;
//   - every other theme resolves through THEMES[theme].base until it reaches a dressed one (null = facility).
// The FLOOR is derived from floorSurface(L, space) (the server's footstep noise surface), so the floor the client draws
// can never disagree with the surface the server hears: palette floor surface === floorSurface for every theme x space.
import type { LayoutSpace, LevelLayout } from '@dead-air/shared/layout.ts';
import { THEMES, floorSurface, themeFor } from '@dead-air/shared/procgen/themes.ts';
import type { FloorSurface, SiteTheme } from '@dead-air/shared/procgen/themes.ts';
import type { MatId } from './materials.ts';

export interface SpaceTheme { floor: MatId; wallLo: MatId; wallHi: MatId; ceil: MatId }
/** the themes this package dresses (MUST); others resolve via ThemeDef.base */
export const DRESSED_THEMES = ['facility', 'hospital', 'waterworks', 'records', 'cold_storage'] as const;
export type DressedTheme = (typeof DRESSED_THEMES)[number];

const CLINICAL = new Set(['morgue', 'infirmary', 'showers', 'cold', 'cryo', 'kitchen', 'laundry', 'nursery']);
const INDUSTRIAL = new Set(['boiler', 'furnace', 'foundry', 'pumps', 'tanks', 'garage', 'dock', 'pit', 'storage', 'greenhouse']);
const HEAVY = new Set(['boiler', 'furnace', 'foundry', 'pumps', 'tanks']);
const TECH = new Set(['server', 'radio']);
const PAPER = new Set(['office', 'archive', 'library', 'mailroom', 'gallery', 'chapel', 'canteen', 'lockers']);

/** floor material of a floor surface (MatId -> surface is FLOOR_SURFACE below; both directions stay in sync) */
export const FLOOR_SURFACE: Readonly<Partial<Record<MatId, FloorSurface>>> = {
  floor_concrete: 'concrete', floor_lino: 'lino', floor_tiles: 'tile', floor_rubber: 'rubber', floor_metal: 'metal',
  floor_dirt: 'dirt', asphalt: 'asphalt', floor_terrazzo: 'tile', floor_carpet: 'carpet', floor_parquet: 'wood',
  floor_grating: 'grate',
};
/** floors whose texture has a direction: UVs turn in 90-degree steps to run along the space's long axis */
export const DIRECTIONAL_FLOORS: ReadonlySet<MatId> = new Set<MatId>(['floor_parquet', 'floor_grating']);

/** the dressed theme a site theme looks like (base chain; unknown / undressed -> facility) */
export function dressedTheme(theme: string | null | undefined): DressedTheme {
  let t: SiteTheme | null = themeFor(theme);
  for (let guard = 0; t && guard < 8; guard++) {
    if ((DRESSED_THEMES as readonly string[]).includes(t)) return t as DressedTheme;
    t = THEMES[t]?.base ?? null;
  }
  return 'facility';
}

/** v1.1 mesher mapping (facility + hub), floor included */
function v11(s: LayoutSpace): SpaceTheme {
  if (s.kind === 'outside') return { floor: s.type === 'kennel' ? 'floor_dirt' : 'asphalt', wallLo: 'facade', wallHi: 'facade', ceil: 'ceiling_concrete' };
  if (s.kind === 'corridor') return { floor: 'floor_lino', wallLo: 'wall_tile_green', wallHi: 'wall_plaster_green', ceil: 'ceiling_tiles' };
  if (s.kind === 'vault') return { floor: 'floor_metal', wallLo: 'wall_vault', wallHi: 'wall_vault', ceil: 'ceiling_concrete' };
  if (s.type === 'lobby') return { floor: 'floor_tiles', wallLo: 'wall_tile_green', wallHi: 'wall_plaster', ceil: 'ceiling_tiles' };
  if (CLINICAL.has(s.type)) return { floor: 'floor_tiles', wallLo: 'wall_tile_white', wallHi: 'wall_tile_white', ceil: 'ceiling_tiles' };
  if (INDUSTRIAL.has(s.type)) return { floor: HEAVY.has(s.type) ? 'floor_metal' : 'floor_concrete', wallLo: 'wall_concrete_dark', wallHi: 'wall_concrete', ceil: 'ceiling_metal' };
  if (TECH.has(s.type)) return { floor: 'floor_rubber', wallLo: 'wall_plaster_blue', wallHi: 'wall_plaster', ceil: 'ceiling_tiles' };
  return { floor: 'floor_lino', wallLo: 'wall_plaster_blue', wallHi: 'wall_plaster', ceil: 'ceiling_tiles' };
}

type Walls = Pick<SpaceTheme, 'wallLo' | 'wallHi' | 'ceil'>;
const W = (wallLo: MatId, wallHi: MatId, ceil: MatId): Walls => ({ wallLo, wallHi, ceil });

/** walls + ceiling of a dressed theme (outside, vault and van always keep the v1.1 look) */
function themedWalls(s: LayoutSpace, t: DressedTheme): Walls | null {
  if (t === 'facility' || s.kind === 'outside' || s.kind === 'vault' || s.type === 'van') return null;
  const cls = s.kind === 'corridor' ? 'corridor' : s.type === 'lobby' ? 'lobby' : CLINICAL.has(s.type) ? 'clinical'
    : HEAVY.has(s.type) ? 'heavy' : INDUSTRIAL.has(s.type) ? 'industrial' : TECH.has(s.type) ? 'tech' : PAPER.has(s.type) ? 'paper' : 'room';
  switch (t) {
    case 'hospital':
      // St. Brannock: glazed subway-tile dados, pale mint plaster, terrazzo halls; wards fully tiled
      if (cls === 'corridor' || cls === 'lobby') return W('wall_subway', 'wall_plaster_green', 'ceiling_tiles');
      if (cls === 'clinical') return s.type === 'morgue' || s.type === 'showers' ? W('wall_tile_white', 'wall_tile_white', 'ceiling_tiles') : W('wall_subway', 'wall_tile_white', 'ceiling_tiles');
      if (cls === 'paper' || cls === 'room') return W('wall_subway', 'wall_plaster', 'ceiling_tiles');
      return null;
    case 'waterworks':
      // Victorian pumping station: brick halls, glazed-tile dados in the corridors, iron ceilings over the machines
      if (cls === 'corridor') return W('wall_subway', 'wall_brick', 'ceiling_concrete');
      if (cls === 'lobby') return W('wall_tile_green', 'wall_brick', 'ceiling_concrete');
      if (cls === 'heavy') return W('wall_brick', 'wall_brick', 'ceiling_metal');
      if (cls === 'industrial') return W('wall_concrete_dark', 'wall_brick', 'ceiling_metal');
      if (cls === 'clinical') return W('wall_subway', 'wall_tile_white', 'ceiling_concrete');
      return W('wall_tile_green', 'wall_plaster', 'ceiling_concrete');
    case 'records':
      // the depository: dark wood panelling, papered upper walls, carpeted reading rooms
      if (cls === 'corridor' || cls === 'lobby') return W('wall_wood_panel', 'wall_wallpaper', 'ceiling_tiles');
      if (cls === 'paper' || cls === 'room') return W('wall_wood_panel', 'wall_wallpaper', 'ceiling_tiles');
      if (cls === 'tech') return W('wall_wood_panel', 'wall_plaster', 'ceiling_tiles');
      return null;
    case 'cold_storage':
      // Halvorsen: white insulated sandwich panels everywhere cold, scuffed concrete kick zones in the halls
      if (cls === 'clinical' || s.type === 'cold') return W('wall_insulated', 'wall_insulated', 'wall_insulated');
      if (cls === 'corridor') return W('wall_concrete_dark', 'wall_insulated', 'ceiling_metal');
      if (cls === 'industrial' || cls === 'heavy') return W('wall_concrete_dark', 'wall_insulated', 'ceiling_metal');
      if (cls === 'lobby') return W('wall_tile_green', 'wall_insulated', 'ceiling_tiles');
      return W('wall_plaster_blue', 'wall_insulated', 'ceiling_tiles');
  }
  return null;
}

/** floor material for a surface, by dressed theme and space */
export function floorMat(surface: FloorSurface, s: LayoutSpace, t: DressedTheme): MatId {
  switch (surface) {
    case 'tile': return t !== 'facility' && t !== 'cold_storage' && (s.kind === 'corridor' || s.type === 'lobby') ? 'floor_terrazzo' : 'floor_tiles';
    case 'carpet': return 'floor_carpet';
    case 'wood': return 'floor_parquet';
    case 'grate': return 'floor_grating';
    case 'metal': return 'floor_metal';
    case 'concrete': return 'floor_concrete';
    case 'rubber': return 'floor_rubber';
    case 'asphalt': return 'asphalt';
    case 'dirt': return 'floor_dirt';
    case 'lino':
    default: return 'floor_lino';
  }
}

/** outer face of the building (lot side + the facade extension): brick for the Victorian sites, corrugated cladding
 *  for the cold store, the v1.1 concrete otherwise */
export function facadeMat(theme: string | null | undefined): MatId {
  const t = dressedTheme(theme);
  return t === 'waterworks' || t === 'records' ? 'facade_brick' : t === 'cold_storage' ? 'ceiling_metal' : 'facade';
}

/** Palette of one space. L = the whole layout (theme, spaces, metrics: floorSurface sees 'mod:hardfloors'). */
export function spacePalette(L: Pick<LevelLayout, 'theme' | 'spaces' | 'metrics'>, sid: number): SpaceTheme {
  const s = L.spaces[sid];
  const t = dressedTheme(L.theme);
  const base = v11(s);
  if (s.kind === 'outside' && t !== 'facility') { const f = facadeMat(t); base.wallLo = f; base.wallHi = f; }
  const walls = themedWalls(s, t) ?? base;
  const surface = floorSurface(L, sid);
  // facility: v1.1 floors exactly (floorSurface's facility table is the v1.1 mesher mapping)
  const floor = t === 'facility' && FLOOR_SURFACE[base.floor] === surface ? base.floor : floorMat(surface, s, t);
  return { floor, wallLo: walls.wallLo, wallHi: walls.wallHi, ceil: walls.ceil };
}

/** themeOf(space, L.theme) as the brief writes it; metrics only matter for floor modifiers ('mod:hardfloors') */
export function themeOf(s: LayoutSpace, theme?: string | null, metrics: Record<string, number> = {}): SpaceTheme {
  const spaces: LayoutSpace[] = [];
  spaces[s.id] = s;
  return spacePalette({ theme: theme ?? 'facility', spaces, metrics }, s.id);
}

/** every material a theme's palette can use (prefetch before the drive so the first room does not compile them) */
export function themeMaterials(theme: string | null | undefined): MatId[] {
  const t = dressedTheme(theme);
  const out = new Set<MatId>();
  const kinds: LayoutSpace['kind'][] = ['corridor', 'room', 'hall'];
  const types = ['lobby', 'morgue', 'infirmary', 'cold', 'boiler', 'garage', 'server', 'office', 'library', 'chapel', 'x'];
  for (const kind of kinds) for (const type of types) {
    const s: LayoutSpace = { id: 0, kind, rect: { x: 0, y: 0, w: 4, h: 4 }, zone: 0, type, callsign: null, dist: 0, light: 'on', open: false, powerZone: 0 };
    const w = themedWalls(s, t) ?? v11(s);
    out.add(w.wallLo); out.add(w.wallHi); out.add(w.ceil);
    for (const f of ['concrete', 'tile', 'metal', 'lino', 'rubber', 'carpet', 'wood', 'grate'] as FloorSurface[]) out.add(floorMat(f, s, t));
  }
  return [...out];
}
