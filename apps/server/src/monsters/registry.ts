// Owner: track (c) Monsters. Module-level registry shared by api.ts (public) and the runtime: the Listener brain
// (set by the AI track), decision subscribers, the director picker. No imports of runtime code (no cycles).
import type { Crew } from '../core/types.ts';
import type { ListenerAction } from './types.ts';
import type { MonsterEvent } from '@dead-air/shared/messages/monsters.ts';

export type { ListenerAction };

/** What the brain gets: only what the Listener actually heard or saw (never positions it did not perceive). */
export interface ListenerBrainInput {
  crew: string;
  risk: number;
  /** contract seconds since the monsters started */
  now: number;
  self: { room: string | null; space: number; state: string };
  /** newest last; text is untrusted player speech */
  heard: {
    id: number;
    ago: number;
    speaker: string | null;
    speakerId: string | null;
    text: string;
    room: string | null;
    roomId: number;
    via: 'voice' | 'radio' | 'text';
    callsigns: string[];
    /** player ids named in the line */
    names: string[];
    meaningful: boolean;
    /** v1.3 (flag earwigs): relayed by an ear; room / roomId are then the EAR's room, not the speaker's.
     *  TODO(ai): say "(heard through an ear in <room>)" in the Listener prompt; ignored until then */
    viaEar?: boolean;
  }[];
  /** callsigned rooms of this facility */
  rooms: { id: number; callsign: string }[];
  /** players it has heard or seen (name for prompts; id for targets) */
  players: { id: string; name: string; heardAgo: number | null; seenAgo: number | null }[];
  allowed: ListenerAction[];
  lureReady: boolean;
}

export interface ListenerIntent {
  action: ListenerAction;
  /** callsign ('BOILER') or space id */
  room?: string | number | null;
  /** player id or name */
  player?: string | null;
  /** memory note, <= 8 words */
  note?: string | null;
  /** 'jev' | 'haiku' | 'rule' ... (for the log) */
  source?: string;
}

export interface ListenerDecision {
  crew: string;
  at: number;
  action: ListenerAction;
  room: string | null;
  space: number;
  player: string | null;
  note: string;
  heard: string | null;
  speaker: string | null;
  /** v1.2: speaker's player id */
  speakerId?: string | null;
  source: string;
  valid: boolean;
  line: string;
}

export type ListenerBrain = (input: ListenerBrainInput) => Promise<ListenerIntent | null>;

export interface DirectorPickState {
  crew: string;
  phase: 'build' | 'peak' | 'fade' | 'relax';
  /** max per-player tension 0..1 */
  tension: number;
  perPlayer: Record<string, number>;
  /** seconds since contract start */
  t: number;
  /** in-game minutes since 22:00 */
  clockMin: number;
}

export type DirectorPicker = (state: DirectorPickState, allowed: string[]) => Promise<string | null>;

export const registry = {
  brain: null as ListenerBrain | null,
  decisionSubs: new Set<(crew: Crew, d: ListenerDecision) => void>(),
  picker: null as DirectorPicker | null,
  /** v1.2 monster event bus subscribers (api.onMonsterEvent) */
  monsterEventSubs: new Set<(crew: Crew, e: MonsterEvent) => void>(),
};

/** director phase stored by the director module in crew.slices.director */
export function directorPhase(crew: Crew): string {
  const d = crew.slices.director as { phase?: string } | undefined;
  return d?.phase ?? 'build';
}
