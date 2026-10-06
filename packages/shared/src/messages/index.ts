// FROZEN aggregation (P0). Each track owns ONE file in this folder and only adds entries to its own
// interfaces. Never edit another track's file; never rename/remove entries (additive only).
import type { NetEvents, NetReqs } from './net.ts';
import type { LevelEvents, LevelReqs } from './level.ts';
import type { PlayersEvents, PlayersReqs } from './players.ts';
import type { VoiceEvents, VoiceReqs } from './voice.ts';
import type { ObjectivesEvents, ObjectivesReqs } from './objectives.ts';
import type { InteractionEvents, InteractionReqs } from './interaction.ts';
import type { MonstersEvents, MonstersReqs } from './monsters.ts';
import type { MetaEvents, MetaReqs } from './meta.ts';
import type { AiEvents, AiReqs } from './ai.ts';

/** event name -> payload (server -> client, reliable, ordered) */
export interface EventMap
  extends NetEvents, LevelEvents, PlayersEvents, VoiceEvents, ObjectivesEvents, InteractionEvents, MonstersEvents, MetaEvents, AiEvents {}

/** request name -> { args; result } (client -> server, answered by 'rep') */
export interface ReqMap
  extends NetReqs, LevelReqs, PlayersReqs, VoiceReqs, ObjectivesReqs, InteractionReqs, MonstersReqs, MetaReqs, AiReqs {}

export type EventName = keyof EventMap & string;
export type EventPayload<E extends EventName> = EventMap[E];
export type ReqName = keyof ReqMap & string;
export type ReqArgs<R extends ReqName> = ReqMap[R] extends { args: infer A } ? A : never;
export type ReqResult<R extends ReqName> = ReqMap[R] extends { result: infer X } ? X : never;
