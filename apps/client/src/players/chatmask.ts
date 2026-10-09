// Owner: track ⑤ Players (v1.3 P1d, paranormal-players-audio). Proximity text through names.ts (P1a): blocked words
// are masked before a line goes out (an honest client never sends one, so the Listener and the HR-memo quotes get it
// clean too) and again on display (a line from an older or modified client); the speaker's name shows as names.ts
// would show it (Contractor-NNNN for a blocked or reserved one, the same name the server gives it). Pure.
import { maskText, safeDisplayName } from '@dead-air/shared/names.ts';

/** the line we send ('players.chat') */
export function outgoingChat(text: string): string {
  return maskText(String(text ?? ''));
}

/** a received 'players.chat' line as the chat HUD shows it */
export function shownChat(d: { id: string; name: string; text: string }): { name: string; text: string } {
  return { name: safeDisplayName(d.name, d.id).name, text: maskText(String(d.text ?? '')) };
}
