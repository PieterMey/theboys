// Owned by track ④ Voice (TURN refresh, voice status, STT segment lifecycle acks).
// Add entries here only (additive). Events: name -> payload. Reqs: name -> { args; result }.
import type { RTCIceServerLike } from '../envelope.ts';

export interface VoiceEvents {}

export interface VoiceReqs {
  /** refresh ICE servers (TURN credentials are cached ~12 h on the server). relay = TURN configured */
  'voice.ice': { args: Record<string, never> | undefined; result: { iceServers: RTCIceServerLike[]; relay: boolean } };
  /** set this player's transcription consent (PLAN §4.12 ①); opting out = loudness-only */
  'voice.consent': { args: { transcribe: boolean }; result: { transcribe: boolean } };
}
