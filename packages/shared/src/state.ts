// FROZEN CONTRACT (P0) for cross-track state. Additive changes only, via the integrator.
// Coordinates: 1 grid cell = 1 m. World X = grid x, world Z = grid y, Y is up. Yaw in radians, 0 = facing +Z.
import type { LevelLayout } from './layout.ts';
import type { Profile } from './profile.ts';
import type { WorkOrder } from './workorder.ts';
import type { ObjectivesState } from './messages/objectives.ts';
import type { InteractionState } from './messages/interaction.ts';
import type { MetaState } from './messages/meta.ts';

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export type Phase = 'hub' | 'drive' | 'contract' | 'results';

/** Stance values in Pose.stance */
export const STANCE = { stand: 0, crouch: 1, sprint: 2, hidden: 3, dead: 4 } as const;

export type MonsterKind = 'hound' | 'mannequin' | 'listener' | 'snatcher';

export interface PlayerPublic {
  id: string;
  name: string;
  profile: Profile;
  connected: boolean;
  ready: boolean;
  /** true while a living crew member in the current contract (or hub) */
  alive: boolean;
  isLeader: boolean;
  /** consent flags shown to others (e.g. 'loudness-only' badge) */
  consent: { transcribe: boolean; mimic: boolean };
  level: number;
}

export interface CrewPublic {
  code: string;
  phase: Phase;
  players: PlayerPublic[];
  maxPlayers: number;
}

export interface SnapPlayer {
  id: string;
  p: Vec3;
  yaw: number;
  pitch: number;
  stance: number;
  anim: number;
  light: 0 | 1;
  /** id of a carried dyn entity, if any */
  carry?: string;
}

export interface SnapMonster {
  id: string;
  kind: MonsterKind;
  p: Vec3;
  yaw: number;
  /** behaviour state name, e.g. 'idle' | 'alert' | 'investigate' | 'charge' | 'frozen' | 'move' | 'ambush' */
  state: string;
  anim: number;
  /** false while "out of play" (retreated) -> clients hide it */
  active: boolean;
}

/** Dynamic objects whose transform changes (carried loot, thrown bottles, the Core) */
export interface SnapDyn {
  id: string;
  p: Vec3;
  yaw: number;
}

export interface Snapshot {
  t: number;
  tick: number;
  players: SnapPlayer[];
  monsters: SnapMonster[];
  dyn: SnapDyn[];
  /**
   * Per-receiver voice audibility: path distance in metres (rounded, 255 = unreachable/sealed)
   * from THIS receiving client's player (or spectator camera) to each other speaker.
   * Clients gate voice: audible iff aud[speaker] <= radiusOf(speakerBand). Same function the monsters use.
   */
  aud: Record<string, number>;
}

/** Full state sent in Welcome and after resume; tracks own their slices. */
export interface FullState {
  phase: Phase;
  /** layout for the current phase (hub layout in 'hub', facility in 'contract') */
  layout: LevelLayout | null;
  workOrders: WorkOrder[];
  activeOrder: WorkOrder | null;
  /** in-game clock minutes since 22:00 (0..360) or -1 outside contracts */
  clockMin: number;
  objectives: ObjectivesState | null;
  interaction: InteractionState | null;
  meta: MetaState;
  /** latest snapshot, so the client can place everything immediately */
  snap: Snapshot | null;
}
