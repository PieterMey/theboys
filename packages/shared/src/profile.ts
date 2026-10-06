// FROZEN CONTRACT (P0): character profile, synced to everyone and saved on the host.

export type HelmetKind = 'dome' | 'box' | 'diver';
export type BodyKind = 'm' | 'f';

export interface Profile {
  name: string; // 1..16 chars
  body: BodyKind;
  /** primary + secondary suit colours, '#rrggbb' */
  suit: [string, string];
  helmet: HelmetKind;
  visor: { glyphs: string; color: string }; // glyphs: up to 3 visible chars
  /** badge number shown on the suit and used in the claim code */
  badge: number;
}

export const PROFILE_LIMITS = { nameMax: 16, glyphsMax: 3 } as const;

export const SUIT_PALETTE = ['#d4a017', '#c0392b', '#2e86c1', '#27ae60', '#8e44ad', '#e67e22', '#7f8c8d', '#ecf0f1', '#1abc9c', '#2c3e50'] as const;
export const VISOR_COLORS = ['#7dfcff', '#ff4d4d', '#9dff6b', '#ffd84d', '#ff7df3', '#ffffff'] as const;

/** helmet unlocks by career level */
export const HELMET_UNLOCK_LEVEL: Record<HelmetKind, number> = { dome: 1, box: 2, diver: 5 };

export function randomProfile(name: string, rnd: () => number = Math.random): Profile {
  const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
  return {
    name: name.slice(0, PROFILE_LIMITS.nameMax),
    body: rnd() < 0.5 ? 'm' : 'f',
    suit: [pick(SUIT_PALETTE), pick(SUIT_PALETTE)],
    helmet: 'dome',
    visor: { glyphs: name.slice(0, 1).toUpperCase(), color: pick(VISOR_COLORS) },
    badge: 100 + Math.floor(rnd() * 900),
  };
}
