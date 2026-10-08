// Owner: fieldguide (v1.2) client. Shared client state (signals) for the booklet screen, the bulletin reader and index.ts.
import { signal } from '@preact/signals';
import type { MonsterKind } from '@dead-air/shared/state.ts';
import type { FieldGuideView } from '@dead-air/shared/messages/fieldguide.ts';

export type FgTab = MonsterKind | 'anomalies';
export const TABS: readonly FgTab[] = ['hound', 'listener', 'mannequin', 'snatcher', 'anomalies'];

/** latest private 'fieldguide.state' / 'fieldguide.get' view (null until the first one arrives) */
export const fgView = signal<FieldGuideView | null>(null);
/** last tab the player looked at (the booklet reopens there) */
export const fgTab = signal<FgTab>('hound');

/** display names for the client side only (the server sends the same names with the view) */
export const MONSTER_NAMES: Readonly<Record<MonsterKind, string>> = {
  hound: 'THE HOUND', listener: 'THE LISTENER', mannequin: 'THE MANNEQUIN', snatcher: 'THE SNATCHER',
};

export const isTab = (t: unknown): t is FgTab => typeof t === 'string' && (TABS as readonly string[]).includes(t);
