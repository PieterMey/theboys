// Owner: players-stealth (v1.2). Client half of honest footsteps: the floor under a point (level.surfaceAt, else the
// layout's floorSurface), the per-surface step sounds, the stance HUD state (the radius from the same stepNoiseRadius
// the server uses) and the one-time stealth hints (localStorage 'deadair.hints.v12').
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import { floorSurface } from '@dead-air/shared/procgen/themes.ts';
import type { FloorSurface } from '@dead-air/shared/procgen/themes.ts';
import { NOISE_M } from '@dead-air/shared/constants.ts';
import { STANCE } from '@dead-air/shared/state.ts';
import { stepNoiseRadius } from '@dead-air/shared/messages/players.ts';
import type { StepKind } from '@dead-air/shared/messages/players.ts';

export type SurfaceKind = FloorSurface | 'water';

const FLOORS: readonly string[] = ['concrete', 'tile', 'metal', 'grate', 'carpet', 'wood', 'rubber', 'lino', 'asphalt', 'dirt'];

/** floor of the layout space owning cell (x, z); 'concrete' outside the grid / on solid cells */
export function layoutSurface(L: Pick<LevelLayout, 'W' | 'H' | 'owner' | 'spaces' | 'theme' | 'metrics'> | null | undefined, x: number, z: number): FloorSurface {
  if (!L) return 'concrete';
  const cx = Math.floor(x), cz = Math.floor(z);
  const sp = cx >= 0 && cz >= 0 && cx < L.W && cz < L.H ? L.owner[cz * L.W + cx] : -1;
  if (sp < 0) return 'concrete';
  try {
    return floorSurface(L, sp);
  } catch {
    return 'concrete';
  }
}

export interface SurfaceAtFn { (x: number, z: number): string }

/**
 * The floor at (x, z) twice: `sfx` may be 'water' (puddles, flooded floors: wet steps); `noise` never is (water counts
 * as the space's own floor, like the server's floorSurface). env-world's level.surfaceAt decides when it exists.
 */
export function surfaceAt(levelSurfaceAt: SurfaceAtFn | undefined, L: Parameters<typeof layoutSurface>[0], x: number, z: number): { sfx: SurfaceKind; noise: FloorSurface } {
  let s: string | undefined;
  if (typeof levelSurfaceAt === 'function') {
    try { s = levelSurfaceAt(x, z); } catch { s = undefined; }
  }
  if (s === 'water') return { sfx: 'water', noise: layoutSurface(L, x, z) };
  if (s && FLOORS.includes(s)) return { sfx: s as FloorSurface, noise: s as FloorSurface };
  const f = layoutSurface(L, x, z);
  return { sfx: f, noise: f };
}

/** step sound family per floor (sfx manifest keys; variants .1-.4) */
export const STEP_SFX: Readonly<Record<FloorSurface, string>> = {
  lino: 'sfx.step_concrete', concrete: 'sfx.step_concrete', tile: 'sfx.step_concrete', rubber: 'sfx.step_concrete',
  asphalt: 'sfx.step_concrete', dirt: 'sfx.step_concrete', metal: 'sfx.step_metal', grate: 'sfx.step_metal',
  wood: 'sfx.step_wood', carpet: 'sfx.step_carpet',
};

/** the sound family + playback rate for a floor; water: step_wet when the manifest has it, else concrete at 0.9 */
export function stepSfxFor(surface: SurfaceKind, hasFamily: (key: string) => boolean): { key: string; rate: number } {
  if (surface === 'water') return hasFamily('sfx.step_wet') ? { key: 'sfx.step_wet', rate: 1 } : { key: 'sfx.step_concrete', rate: 0.9 };
  return { key: STEP_SFX[surface] ?? 'sfx.step_concrete', rate: 1 };
}

// ---------------------------------------------------------------- stance HUD

export type StanceMode = 'crouch' | 'walk' | 'sprint';
export type StanceTag = 'METAL FLOOR' | 'GRATING' | 'TILES' | 'CARPET' | 'SOFT SOLES';
export interface StanceView {
  mode: StanceMode | null;
  /** footstep radius (m) for this mode on this floor */
  radiusM: number;
  /** why the radius differs from 5 m: the floor first, else overshoes */
  tag: StanceTag | null;
  /** overshoes on (shown as an extra chip when the floor already has the tag) */
  soles: boolean;
}

const FLOOR_TAG: Partial<Record<FloorSurface, StanceTag>> = { metal: 'METAL FLOOR', grate: 'GRATING', tile: 'TILES', carpet: 'CARPET' };

export interface StanceInputs {
  stance: number;
  /** measured local speed (m/s) */
  speed: number;
  surface: FloorSurface;
  soles: boolean;
  /** flag stealthV12 (off: flat v1.1 radii, no floor tags) */
  v12: boolean;
  bal: Readonly<Record<string, unknown>>;
}

const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** the HUD's reading of the local player, mirroring the server's rule (a crouch above crouchMaxSpeed walks, above
 *  noiseSprintSpeed always sprints); null mode = standing still / hidden / dead */
export function stanceView(i: StanceInputs): StanceView {
  const moving = i.speed > 0.4 && i.stance !== STANCE.hidden && i.stance !== STANCE.dead;
  if (!moving) return { mode: null, radiusM: 0, tag: null, soles: false };
  const sprintSpeed = n(i.bal.noiseSprintSpeed, 4.3);
  const crouchMax = n(i.bal.crouchMaxSpeed, 3);
  const mode: StanceMode = i.stance === STANCE.sprint || i.speed > sprintSpeed ? 'sprint'
    : i.stance === STANCE.crouch && i.speed <= crouchMax ? 'crouch' : 'walk';
  const kind: StepKind = mode === 'crouch' ? 'crouchStep' : mode === 'sprint' ? 'sprintStep' : 'walkStep';
  if (!i.v12) return { mode, radiusM: NOISE_M[kind], tag: null, soles: false };
  const radiusM = stepNoiseRadius(kind, i.surface, i.soles, i.bal);
  const floorTag = FLOOR_TAG[i.surface] ?? null;
  return { mode, radiusM, tag: floorTag ?? (i.soles ? 'SOFT SOLES' : null), soles: i.soles };
}

export function sameStance(a: StanceView, b: StanceView): boolean {
  return a.mode === b.mode && Math.abs(a.radiusM - b.radiusM) < 1e-6 && a.tag === b.tag && a.soles === b.soles;
}

/** '5', '6.5', '4.25' (metres, no trailing zeros) */
export function fmtMetres(m: number): string {
  return String(Math.round(m * 100) / 100);
}

// ---------------------------------------------------------------- one-time hints

export const HINTS_KEY = 'deadair.hints.v12';
const META_SETTINGS_KEY = 'deadair.meta.settings';

export interface HintStore {
  /** shows the hint once ever (per browser); false when already seen or hints are off */
  once(id: string): boolean;
  seen(id: string): boolean;
}

export function createHintStore(storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()): HintStore {
  let seen: Set<string> | null = null;
  const load = (): Set<string> => {
    if (seen) return seen;
    seen = new Set();
    try {
      const raw = storage?.getItem(HINTS_KEY);
      const arr = raw ? (JSON.parse(raw) as unknown) : [];
      if (Array.isArray(arr)) for (const v of arr) if (typeof v === 'string') seen.add(v);
    } catch { /* corrupt / blocked: start empty */ }
    return seen;
  };
  const hintsOn = (): boolean => {
    try {
      const raw = storage?.getItem(META_SETTINGS_KEY);
      return raw ? (JSON.parse(raw) as { hints?: unknown }).hints !== false : true;
    } catch {
      return true;
    }
  };
  return {
    seen: (id) => load().has(id),
    once(id) {
      if (!hintsOn()) return false;
      const s = load();
      if (s.has(id)) return false;
      s.add(id);
      try { storage?.setItem(HINTS_KEY, JSON.stringify([...s])); } catch { /* private mode: once per session */ }
      return true;
    },
  };
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export const HINT_TEXT = {
  contract: 'C: CROUCH · creeping is silent to the Hound and the Listener',
  growl: 'FREEZE, OR CREEP AWAY [C]',
  spotted: 'IT SAW YOU · BREAK LINE OF SIGHT: DOORS, FLARES, CROUCH BEHIND COVER',
  kennel: 'It heard your footsteps. Crouch (C) to creep.',
} as const;
export type HintId = keyof typeof HINT_TEXT;
