// Owner: env-render (v1.2). Per-theme moods: fog / mist / lit-air / fixture tint / grade nudges, all applied as
// uniforms (no LUT, no recompile), plus per-room medium params (cold rooms mist and frost, showers and laundries
// steam, boiler halls haze) written into the light grid's space table. Unknown themes resolve via THEMES[].base.
import { THEMES, themeFor } from '@dead-air/shared/procgen/themes.ts';
import type { SiteTheme } from '@dead-air/shared/procgen/themes.ts';
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import type { SpaceParams } from './lightgrid.ts';

export interface Mood {
  /** multipliers on the fog config */
  haze: number;
  mist: number;
  litK: number;
  /** dark in-scatter floor tint (multiplies the fog colour) */
  floor: [number, number, number];
  /** fixture light tint (multiplies every kind colour) */
  fixtureTint: [number, number, number];
  /** grade nudges (added to fx.desat / multiplied into the GI) */
  desat: number;
  gi: number;
}

const M = (o: Partial<Mood>): Mood => ({ haze: 1, mist: 1, litK: 1, floor: [1, 1, 1], fixtureTint: [1, 1, 1], desat: 0, gi: 1, ...o });

export const MOODS: Partial<Record<SiteTheme, Mood>> = {
  facility: M({}),
  hospital: M({ haze: 0.85, mist: 0.8, litK: 1.1, floor: [0.95, 1.02, 1.05], fixtureTint: [0.96, 1.02, 1.04], desat: 0.04 }),
  waterworks: M({ haze: 1.2, mist: 1.5, litK: 1.05, floor: [0.9, 1.0, 0.98], fixtureTint: [1.0, 1.02, 0.95] }),
  records: M({ haze: 1.35, mist: 0.7, litK: 1.15, floor: [1.05, 1.0, 0.92], fixtureTint: [1.04, 1.0, 0.9], desat: -0.03 }),
  cold_storage: M({ haze: 1.1, mist: 1.8, litK: 1.0, floor: [0.88, 0.97, 1.1], fixtureTint: [0.93, 1.0, 1.08], desat: 0.05, gi: 0.9 }),
  industry: M({ haze: 1.4, mist: 1.1, litK: 1.1, floor: [1.05, 0.98, 0.9], fixtureTint: [1.05, 0.98, 0.9] }),
  hospitality: M({ haze: 1.05, mist: 0.75, litK: 1.1, floor: [1.04, 0.99, 0.94], fixtureTint: [1.06, 1.0, 0.9], desat: -0.04 }),
  comms: M({ haze: 1.1, mist: 0.8, litK: 1.0, floor: [0.95, 1.0, 1.04], fixtureTint: [0.98, 1.0, 1.04] }),
};

export function moodFor(theme: string | null | undefined): Mood {
  let t: SiteTheme | null = themeFor(theme);
  for (let i = 0; i < 4 && t; i++) {
    const m = MOODS[t];
    if (m) return m;
    t = THEMES[t]?.base ?? null;
  }
  return MOODS.facility!;
}

/** per-room medium params from the room type (+ the modifiers: 'mod:cold', 'mod:damp', 'mod:lowvis') */
export function roomParams(L: LevelLayout, space: number): SpaceParams {
  const s = L.spaces[space];
  const out: SpaceParams = { mist: 1, haze: 1, frost: 0, steam: 0 };
  if (!s) return out;
  const t = s.type;
  if (t === 'cold' || t === 'coldroom' || t === 'cryo') { out.mist = 3.2; out.frost = 0.55; }
  else if (t === 'morgue') { out.mist = 1.8; out.frost = 0.25; }
  else if (t === 'showers' || t === 'laundry' || t === 'kitchen') { out.mist = 2.2; out.steam = 0.6; out.haze = 1.3; }
  else if (t === 'boiler' || t === 'furnace' || t === 'foundry') { out.haze = 1.7; out.mist = 1.2; out.steam = 0.3; }
  else if (t === 'pumps' || t === 'tanks' || t === 'pit') { out.mist = 1.9; out.haze = 1.2; }
  else if (t === 'archive' || t === 'library' || t === 'storage' || t === 'stores') { out.haze = 1.45; out.mist = 0.6; }
  else if (s.kind === 'corridor') { out.haze = 1.0; out.mist = 0.9; }
  else if (s.kind === 'outside') { out.mist = 1.3; out.haze = 1; }
  if (s.type === 'van') { out.mist = 0.2; out.haze = 0.5; }
  const mod = (k: string) => (L.metrics?.[`mod:${k}`] ?? 0) > 0;
  if (mod('cold')) { out.mist *= 1.35; out.frost = Math.min(1, out.frost + 0.2); }
  if (mod('damp')) { out.mist *= 1.3; out.haze *= 1.1; }
  if (mod('lowvis')) { out.haze *= 1.6; out.mist *= 1.25; }
  return out;
}
