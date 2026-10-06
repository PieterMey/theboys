// Owner: track (c) Monsters. PUBLIC server API for other tracks (names fixed by the plan):
//   startMonsters(crew, {risk, contractIndex})   meta, after setPhase('contract', layout)
//   stopMonsters(crew)
//   listener.setBrain(fn(input) => Promise<Intent|null>)   AI track (JEV -> Haiku); null/timeout -> rule brain
//   listener.onDecision(fn(crew, decision))
//   listener.heard(crew, utterance)              AI track (or we subscribe to ai/api.ts onUtterance)
//   director.setPicker(fn(state, allowed) => Promise<string|null>)
//   decisionLog(crew) -> string[]                'it heard "meet in BOILER" -> ambushed BOILER'
//   startHub(crew)                               chained kennel hound in the van hub
// Extras: decisionEntries(crew), monsterPositions(crew), listenerCanHear(crew, x, z, radiusM).
// Safe to import from anywhere: no runtime state is touched until the monsters track installed.
import type { Crew } from '../core/types.ts';
import { registry } from './registry.ts';
import type { DirectorPicker, ListenerBrain, ListenerDecision } from './registry.ts';
import type { DecisionEntry } from './types.ts';

export type { ListenerBrain, ListenerBrainInput, ListenerIntent, ListenerDecision, DirectorPicker, DirectorPickState, ListenerAction } from './registry.ts';
export type { DecisionEntry } from './types.ts';

/** Utterance shape from the AI track (onUtterance). Extra fields are ignored. */
export interface HeardUtterance {
  segId: string | number;
  speaker: string;
  text: string;
  lang?: string;
  band?: number;
  /** speaker's room at onset: space id or callsign */
  room?: number | string | null;
  /** space id of the speaker's room at onset (AI track's Utterance) */
  roomId?: number;
  /** speaker position (x, z) at onset */
  pos?: [number, number];
  startedAt?: number;
  endedAt?: number;
  hearers?: { players?: string[]; listener?: boolean; walkies?: string[] };
  /** 'voice' (default) | 'radio' | 'text' */
  via?: 'voice' | 'radio' | 'text';
  /** AI track's taunt flag (meta / injection / mocking talk): fresh input even without callsigns or plan words */
  taunt?: boolean;
}

export interface MonstersImpl {
  startMonsters(crew: Crew, o: { risk: number; contractIndex: number }): boolean;
  stopMonsters(crew: Crew): void;
  startHub(crew: Crew): boolean;
  heard(crew: Crew, u: HeardUtterance): boolean;
  decisionLog(crew: Crew): DecisionEntry[];
  positions(crew: Crew): { id: string; kind: string; x: number; z: number; active: boolean; state: string }[];
  listenerCanHear(crew: Crew, x: number, z: number, radiusM: number): boolean;
}

let impl: MonstersImpl | null = null;

/** called by monsters/index.ts install */
export function bindMonstersImpl(i: MonstersImpl): void {
  impl = i;
}

export function startMonsters(crew: Crew, o: { risk: number; contractIndex: number }): boolean {
  return impl ? impl.startMonsters(crew, o) : false;
}

export function stopMonsters(crew: Crew): void {
  impl?.stopMonsters(crew);
}

export function startHub(crew: Crew): boolean {
  return impl ? impl.startHub(crew) : false;
}

export const listener = {
  /** install the AI brain (JEV -> Haiku). Pass null to go back to the rule brain. */
  setBrain(fn: ListenerBrain | null): void {
    registry.brain = fn;
  },
  onDecision(fn: (crew: Crew, d: ListenerDecision) => void): () => void {
    registry.decisionSubs.add(fn);
    return () => registry.decisionSubs.delete(fn);
  },
  /** a transcript (who-heard-what: hearers.listener says whether the Listener heard it). Returns true if it was kept. */
  heard(crew: Crew, u: HeardUtterance): boolean {
    return impl ? impl.heard(crew, u) : false;
  },
};

export const director = {
  setPicker(fn: DirectorPicker | null): void {
    registry.picker = fn;
  },
};

/** 'heard -> did' lines of the current/last contract (oldest first) */
export function decisionLog(crew: Crew): string[] {
  return impl ? impl.decisionLog(crew).map((e) => e.line) : [];
}

export function decisionEntries(crew: Crew): DecisionEntry[] {
  return impl ? impl.decisionLog(crew).slice() : [];
}

/** active + inactive monsters with positions (console blips, AI who-heard-what) */
export function monsterPositions(crew: Crew): { id: string; kind: string; x: number; z: number; active: boolean; state: string }[] {
  return impl ? impl.positions(crew) : [];
}

/** would the Listener hear a sound of radius `radiusM` at (x, z)? (same path metric as everything else) */
export function listenerCanHear(crew: Crew, x: number, z: number, radiusM: number): boolean {
  return impl ? impl.listenerCanHear(crew, x, z, radiusM) : false;
}
