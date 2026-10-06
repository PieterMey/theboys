// Owned by P2 track (a) Objectives (levers, vault, Core, extraction, clock, Company Requests, notes).
// Additive only. The server sends the whole ObjectivesState in FullState.objectives (welcome / phase / resume) and
// again as the 'objectives.state' event whenever it changes (coalesced, <= 5 Hz). Discrete events carry fx/sfx cues.
import type { Vec3 } from '../state.ts';
import type { ContractResult } from '../saves.ts';

export type CoreState = 'vault' | 'carried' | 'dropped' | 'van' | 'none';
export type LootClass = 'small' | 'medium' | 'heavy';

/** One salvage item (objectives keeps its own loot registry; values count toward `hauled` once in the van). */
export interface ObjLoot {
  /** layout loot slot id, e.g. 'loot:12' */
  id: string;
  /** item type for renderers / (b): 'loot.small' | 'loot.medium' | 'loot.heavy' */
  type: string;
  cls: LootClass;
  name: string;
  /** current scrip value (fragile items lose 10% per hard drop) */
  value: number;
  fragile: boolean;
  where: 'world' | 'held' | 'van';
  holder?: string;
  /** world position (floor y = 0) while lying around; last known position otherwise */
  p: Vec3;
  /** yaw radians */
  rot: number;
  /** space id it was spawned in */
  space: number;
  /** procgen depth tier of the slot (0..2) */
  tier: number;
}

export interface ObjLever {
  id: string;
  p: Vec3;
  rot: number;
  space: number;
  /** power zone this pair powers */
  zone: number;
  /** handle is down (pulled, waiting for the partner, or the pair succeeded) */
  down: boolean;
  /** player id holding it down while waiting for the partner pull */
  by?: string;
}

export interface ObjNote {
  /** layout note slot id, e.g. 'note:3' */
  id: string;
  title: string;
  /** resolved text (secrets substituted) */
  body: string;
  p: Vec3;
  rot: number;
  space: number;
  /** which half of the vault code this note carries, if any */
  codeHalf?: 'A' | 'B';
}

export interface ObjRequest {
  kind: string;
  done: boolean;
  failed: boolean;
  reward: number;
  param?: number;
  text: string;
}

export interface ObjCore {
  id: string;
  /** current value (each drop costs dropLossFrac of it) */
  value: number;
  /** value at contract start */
  baseValue: number;
  state: CoreState;
  /** players currently holding a handle (lifted when 2) */
  carriers: string[];
  p: Vec3;
  yaw: number;
  drops: number;
}

export interface ObjKeypad {
  id: string;
  p: Vec3;
  rot: number;
  space: number;
  zone: number;
  /** vault door id it opens */
  door: number;
  /** powered (both breakers thrown) */
  enabled: boolean;
  /** wrong-code lockout until this server time (ms), 0 = none */
  lockedUntil: number;
}

export interface ObjectivesState {
  /** power zone id -> powered */
  power: Record<number, boolean>;
  vaultOpen: boolean;
  coreState: CoreState;
  /** scrip value inside the van this contract (salvage + extracted Core) */
  hauled: number;
  /** total spawned loot value (salvage only, Core excluded) */
  lootTotal: number;
  requests: ObjRequest[];
  blackout: boolean;
  /** true once the van is leaving / contract ended */
  ended: boolean;
  // ---- added by (a) ----
  /** false outside a running contract (hub/results): clients hide everything */
  active: boolean;
  orderId: string;
  risk: number;
  /** server clock (ms, ctx.now()) when the contract clock started at 22:00 */
  startedAt: number;
  /** real seconds for 22:00 -> 04:00 (balance.core.contractRealSec unless overridden) */
  realSec: number;
  /** in-game minutes since 22:00 when this state was built (clients extrapolate from startedAt/realSec) */
  clockMin: number;
  /** horn / departure warning has sounded */
  horn: boolean;
  /** 4-digit vault code. Shown ONLY by the van console UI (meta) and inside the two split clue notes. */
  code: string;
  keypad: ObjKeypad | null;
  levers: ObjLever[];
  /** failed twin pull -> both breakers locked until this server time (ms), 0 = none */
  leverCooldownUntil: number;
  core: ObjCore | null;
  loot: ObjLoot[];
  notes: ObjNote[];
  /** salvage counters for the HUD checklist: items in the van / items spawned */
  salvage: { count: number; total: number; value: number };
  /** van cargo rect (grid metres) = "inside the van" for departure / leave lever / drops */
  van: { x: number; y: number; w: number; h: number } | null;
  /** deposit point (inside the van) and its radius */
  deposit: { p: Vec3; r: number } | null;
  /** leave-now lever */
  leaveLever: { id: string; p: Vec3; rot: number } | null;
  /** ids of players that died this contract */
  dead: string[];
  /** who owns the salvage items: 'interaction' = (b)'s world items (pick up / drop / deposit via interaction.*),
   *  'objectives' = this track's own registry (objectives.pick / drop / deposit). `loot` mirrors them either way. */
  lootMode: 'interaction' | 'objectives';
}

/** Contract result handed to objectives.onContractEnd listeners (meta) and sent in 'objectives.end'. */
export interface ObjContractResult extends ContractResult {
  crew: string;
  lootTotal: number;
  /** salvage part of `hauled` (without the Core) */
  salvage: number;
  coreValue: number;
  /** sum of rewards of the requests in requestsMet */
  requestsReward: number;
  requests: ObjRequest[];
  /** 'departure' (04:00) | 'leave' (leave-now lever) | 'wipe' (everyone dead) | 'abort' (dbg / phase change) */
  reason: 'departure' | 'leave' | 'wipe' | 'abort';
  /** players left behind at departure */
  leftBehind: string[];
  durationSec: number;
}

export type LeverResult = 'waiting' | 'success' | 'fail' | 'cooldown' | 'nopower';

export interface ObjectivesEvents {
  /** whole objectives slice (coalesced, on change) */
  'objectives.state': ObjectivesState;
  /** a breaker lever moved: waiting = one handle down; success = pair thrown; fail = partner missed the 1 s window */
  'objectives.lever': { id: string; by: string; result: LeverResult; zone: number; p: Vec3; cooldownUntil?: number };
  /** zone powered (lights + keypad) */
  'objectives.power': { zone: number; on: boolean; spaces: number[] };
  /** keypad key/enter feedback (ok=false: wrong code / no power / locked out) */
  'objectives.keypad': { id: string; by: string; ok: boolean; reason?: string; p: Vec3 };
  'objectives.vault': { open: boolean; door: number; by: string | null; p: Vec3 };
  /** Core lifted / handle grabbed / dropped / extracted */
  'objectives.core': { state: CoreState; by?: string; value: number; lost?: number; p: Vec3; carriers: string[] };
  /** loot picked / dropped / deposited */
  'objectives.loot': { id: string; by: string; action: 'pick' | 'drop' | 'deposit' | 'break'; value: number; p: Vec3; hauled: number };
  /** 03:00: every light in the facility dies (clients: services.render.setPower('all', false) + sfx.power_down_blackout) */
  'objectives.blackout': { clockMin: number };
  /** 03:30: van horn */
  'objectives.horn': { clockMin: number; p: Vec3 };
  /** 04:00 the van leaves: players not inside are lost */
  'objectives.departure': { lost: string[] };
  /** a Company Request changed state */
  'objectives.request': ObjRequest;
  /** contract over (also delivered to server listeners via objectives.onContractEnd) */
  'objectives.end': { result: ObjContractResult };
  /** personal feedback line for the acting player (e.g. 'Needs a partner on the other breaker') */
  'objectives.msg': { text: string; kind?: 'info' | 'warn' };
  /** server-routed E on a keypad / note (when (b) routes interactions): open that UI on this client */
  'objectives.open': { ui: 'keypad' | 'note'; id: string };
  /** PA / voice cue for everyone: key into assets ('vo.pa_blackout', ...) */
  'objectives.pa': { key: string; text: string };
}

export interface ObjectivesReqs {
  /** generic E on an objectives interactable (lever, keypad, core, loot, deposit, leave_lever, note) */
  'objectives.interact': { args: { id: string }; result: { ok: boolean; msg?: string; open?: 'keypad' | 'note' } };
  'objectives.lever': { args: { id: string }; result: { ok: boolean; msg?: string; result?: LeverResult } };
  /** enter the vault code at the keypad (must be within reach, powered, not locked out) */
  'objectives.keypad': { args: { code: string; id?: string }; result: { ok: boolean; msg?: string } };
  /** single keypad key press (beep for everyone nearby); purely cosmetic */
  'objectives.key': { args: { key: string }; result: { ok: boolean } };
  /** grab / release a Core handle */
  'objectives.core': { args: { action: 'grab' | 'release' }; result: { ok: boolean; msg?: string; state?: CoreState } };
  'objectives.pick': { args: { id: string }; result: { ok: boolean; msg?: string } };
  /** drop the most recently picked item (or `id`) in front of the player; inside the van = deposited */
  'objectives.drop': { args: { id?: string }; result: { ok: boolean; msg?: string; deposited?: boolean } };
  /** deposit everything carried (must be inside the van / at the deposit point) */
  'objectives.deposit': { args: Record<string, never> | undefined; result: { ok: boolean; msg?: string; value: number } };
  /** pull the leave-now lever (all living players must be inside the van) */
  'objectives.leave': { args: Record<string, never> | undefined; result: { ok: boolean; msg?: string } };
  'objectives.state': { args: Record<string, never> | undefined; result: ObjectivesState | null };
}
