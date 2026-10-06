// Owned by P2 track (b) Interaction; read by all. Interactable kinds a player can target with E / LMB.
export type InteractableKind =
  | 'door' | 'lever' | 'keypad' | 'loot' | 'core' | 'locker' | 'switch' | 'console' | 'board' | 'shop'
  | 'mirror' | 'leave_lever' | 'deposit' | 'body' | 'badge' | 'item' | 'note' | 'intercom';

export interface InteractableInfo {
  id: string;
  kind: InteractableKind;
  /** world position (m) of the interaction point */
  p: [number, number, number];
  /** prompt shown in the HUD, e.g. "Pull lever (needs a partner)" */
  prompt: string;
  /** false = shown but disabled (e.g. no power) */
  enabled: boolean;
}
