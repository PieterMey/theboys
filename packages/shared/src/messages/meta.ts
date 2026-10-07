// Owned by P2 track (d) Meta (hub, board, shop, results, quota, XP, saves, claim codes, console).
// Additive only. The base MetaState fields (shift, careers, shop) are filled by the core defaultMeta() and the meta track.
import type { WorkOrder } from '../workorder.ts';
import type { Profile } from '../profile.ts';
import type { StatsReply } from '../progress.ts';

/** shop line shown in the van store (PLAN §3.5) */
export interface MetaShopItem {
  id: string;
  name: string;
  price: number;
  desc: string;
  /** (b) interaction item type handed out via giveItem, e.g. 'walkie' | 'crowbar' | 'bottle' | 'glowstick' | 'medkit' */
  type?: string;
  /** items per purchase (bottles x3, glowsticks x5) */
  qty?: number;
}

/** one rule card shown on the drive (loading) screen, one per monster */
export interface MetaRuleCard {
  monster: 'hound' | 'listener' | 'mannequin' | 'snatcher';
  title: string;
  rule: string;
  hint: string;
}

export interface MetaDeathCard {
  player: string;
  name: string;
  /** 'HOUND' | 'LISTENER' | 'MANNEQUIN' | 'VAN' (left behind) | ... */
  killer: string;
  /** short reason, e.g. "heard your SPRINT, 9 m" */
  reason: string;
  detail?: string;
  /** badge recovered (no fine) */
  badgeRecovered?: boolean;
}

export interface MetaXpLine {
  player: string;
  name: string;
  gained: number;
  reasons: { text: string; xp: number }[];
  xp: number;
  level: number;
  levelUp: boolean;
  /** human readable unlocks this contract, e.g. 'BOX helmet' */
  unlocks: string[];
}

export interface MetaHeardDid {
  heard: string;
  did: string;
  /** in-game clock label, e.g. '00:40' */
  at?: string;
}

/** v1.2 workshop recipe (G5) */
export interface MetaRecipe {
  id: string; name: string; desc: string; tier: 1 | 2;
  /** item type or shop pack id handed out next contract */
  out: string; qty: number;
  cost: Record<string, number>;
  scrip?: number;
  shopPrice?: number;
  /** 'Needs: Soldering station' */
  locked?: string;
}
export interface MetaUpgrade { id: string; name: string; desc: string; scrip: number; cost: Record<string, number>; owned: boolean }
export interface MetaWorkbench {
  stash: Record<string, number>; recipes: MetaRecipe[]; upgrades: MetaUpgrade[]; balance: number;
  pool: Record<string, number>; poolSlots: number; maxPoolSlots: number;
  /** requester's hand-out priority */
  loadout: string[];
}
export interface MetaPlayerLine { player: string; name: string; hauled: number; items: number; deaths: number; revives: number; creptM: number; finds: string[] }

/** per-contract instant results (PLAN §1.5) */
export interface MetaContractResults {
  orderId: string;
  siteName: string;
  risk: number;
  outcome: 'extracted' | 'left_early' | 'wiped' | 'voided' | 'timeout';
  hauled: number;
  lootTotal: number;
  coreExtracted: boolean;
  requests: { kind: string; text: string; done: boolean; reward: number }[];
  requestScrip: number;
  survivors: string[];
  deaths: MetaDeathCard[];
  fines: { player: string; name: string; amount: number }[];
  balanceBefore: number;
  balanceAfter: number;
  shiftHauled: number;
  quota: number;
  /** 1-based contract number within the shift */
  contract: number;
  contractsPerShift: number;
  xp: MetaXpLine[];
  heardDid: MetaHeardDid[];
  /** true when this was the last contract of the shift (the HR memo follows) */
  shiftEnd: boolean;
  /** v1.2 (workshop): materials committed to the stash + items scrapped this contract */
  salvage?: { materials: Record<string, number>; scrapped: number };
  /** v1.2 (meta): per-player result lines */
  players?: MetaPlayerLine[];
  /** v1.2 (meta): at most 3 */
  superlatives?: { title: string; player: string; name: string; why: string }[];
}

/** end-of-shift Company Performance Review (template first, AI swaps in) */
export interface MetaShiftReview {
  shiftIndex: number;
  quota: number;
  hauled: number;
  met: boolean;
  overtime: number;
  verdict: 'promoted' | 'fired';
  memos: { player: string; name: string; title: string; body: string; quote?: string; rating: string }[];
  comments: string;
  /** anonymous "employee comments" (AI review), shown under the memo */
  employeeComments?: string[];
  /** termination letter body when fired */
  letter: string | null;
  source: 'template' | 'ai';
  nextQuota: number | null;
  /** true while the AI version is still being written: the client shows "drafting" instead of typing the template */
  pending?: boolean;
}

/** private to the receiving player */
export interface MetaYou {
  /** save id holding this player's career (differs from the live id after a claim) */
  saveId: string;
  /** claim code 'BADGE-PIN' when known this session (PIN is only stored hashed on the host) */
  claim: string | null;
  xp: number;
  level: number;
  /** xp needed for the next level (null = max) */
  nextLevelXp: number | null;
  achievements: string[];
}

export interface MetaState {
  shift: { index: number; contract: number; quota: number; hauled: number; balance: number; quotasMet: number; contractsPerShift?: number };
  /** player id -> { xp, level } */
  careers: Record<string, { xp: number; level: number }>;
  shop: { id: string; name: string; price: number; desc: string }[];
  // ---- added by (d) meta (all optional for older readers) ----
  /** work order picked by the leader on the board (null = none yet) */
  picked?: string | null;
  /** owner player id ('crew' = company gear) -> item type -> count; handed out at contract start */
  gear?: Record<string, Record<string, number>>;
  /** drive (loading) phase info */
  drive?: { orderId: string; siteName: string; endsAt: number; rules: MetaRuleCard[]; chatter: string[] } | null;
  results?: MetaContractResults | null;
  review?: MetaShiftReview | null;
  /** results phase auto-continues at this server time (ms) */
  resultsEndsAt?: number;
  you?: MetaYou;
  /** crew average career level (connected players) */
  avgLevel?: number;
  /** crew achievements (any member) */
  achievements?: string[];
  /** true when (b) interaction routes E at board/shop/mirror/kennel/console to the server (else the client checks proximity) */
  serverInteract?: boolean;
  /** contracts finished by this crew in total (career) */
  contractsDone?: number;
  /** results phase: ids of players who pressed 'back to the van' (per-player continue) */
  continued?: string[];
  /** leader is holding DRIVE until this server time (ms) */
  holdUntil?: number;
  /** v1.2: VanUpgrade ids owned */
  unlocks?: string[];
  /** v1.2: crew stash */
  stash?: Record<string, number>;
}

export interface MetaEvents {
  /** meta slice + board changed (per receiver: `meta.you` is private) */
  'meta.update': { meta: MetaState; workOrders: WorkOrder[]; activeOrder: WorkOrder | null };
  /** open a client screen (from a server-side interactable handler) */
  'meta.open': { screen: string; props?: Record<string, unknown> };
  /** v1.2 crew stash changed (delta per MaterialType) */
  'meta.stash': { delta: Record<string, number>; by: string | null; reason: 'scrap' | 'deposit' | 'craft' | 'upgrade' | 'contract' | 'fired' };
  /** v1.2 first find of a collection-log entry (private to the finder) */
  'meta.collection': { key: string; label: string; total: number; of: number };
}

export interface MetaReqs {
  /** per-player ready toggle in the van (also mirrors to crew.ready semantics) */
  'meta.ready': { args: { ready: boolean }; result: { ok: true } };
  /** leader picks a work order; the drive starts once everyone is ready */
  'meta.pick': { args: { orderId: string }; result: { ok: boolean; reason?: string } };
  /** leader held DRIVE for 3 s: start the drive now with the picked (or given) order */
  'meta.drive': { args: { orderId?: string }; result: { ok: boolean; reason?: string } };
  /** leader is holding the DRIVE button (true) or let go (false) */
  'meta.hold': { args: { holding: boolean }; result: { ok: boolean } };
  'meta.buy': { args: { item: string }; result: { ok: boolean; reason?: string; balance: number } };
  /** creator: validated profile change (helmet unlocks by level); broadcast to everyone */
  'meta.profile': { args: { profile: Profile }; result: { ok: boolean; profile: Profile; reason?: string } };
  /** generate a new claim PIN for this player's save */
  'meta.newPin': { args: Record<string, never> | undefined; result: { claim: string } };
  /** results -> hub (leader, or anyone after the shift memo). vote:true = per-player 'back to the van': the crew moves on
   *  once every connected player has voted (or the countdown ends); waiting = players still reading */
  'meta.continue': { args: { vote?: boolean } | Record<string, never> | undefined; result: { ok: boolean; reason?: string; waiting?: number } };
  'meta.state': { args: Record<string, never> | undefined; result: { meta: MetaState; workOrders: WorkOrder[]; activeOrder: WorkOrder | null } };
  /** v1.2 workshop (G5): hub only, within benchRangeM of the workbench */
  'meta.workbench': { args: Record<string, never> | undefined; result: MetaWorkbench };
  'meta.craft': { args: { recipe: string }; result: { ok: boolean; reason?: string; bench: MetaWorkbench } };
  'meta.upgrade': { args: { id: string }; result: { ok: boolean; reason?: string; bench: MetaWorkbench } };
  /** v1.2 (meta): hand-out priority, validated against POOL_TYPES + HANDOUT_ONLY */
  'meta.loadout': { args: { order: string[] }; result: { ok: boolean; reason?: string; loadout: string[] } };
  /** v1.2 (meta): personnel file (own, or a crewmate's in a shared crew) */
  'meta.stats': { args: { saveId?: string } | undefined; result: StatsReply };
}
