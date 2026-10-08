// Owner: fieldguide (v1.2). FIELD GUIDE (Company form FG-1) content: SERVER ONLY. Every line here is handwritten (no AI)
// and never bundled into the client: config/balance/*.json IS bundled, so no page text may live there
// (tests/fieldguide/content.test.ts greps apps/client/** and config/balance/** for it).
//
// Numbers are {{placeholders}} filled at send time from ctx.balance ({{monsters.listener.grabAloneM}}), a few shared
// constants ({{const.MOVE.sprint}}) or small derived values ({{calc.listenerCrouchLitM}}). {{path|default}} falls back to
// the default while a v1.2 balance key has not landed yet.
//
// Markup understood by the client: paragraphs are separated by '\n'; a paragraph starting with '✎ ' is a handwritten
// margin note from a previous crew.
//
// Listener copy follows flags.listenerFairV12 (plan check #24n): pages and the card have a v1.1 variant so a rollback never
// shows the wrong rules. Low cover (plan check #10): any solid at least waist-high (>= lowCoverMinH) hides a crouched
// player, desks AND shelves.
import type { MonsterKind } from '@dead-air/shared/state.ts';
import type { ParanormalKind } from '@dead-air/shared/messages/paranormal.ts';
import { BAND_RADIUS_M, CLOCK, MOVE, NOISE_M, PATH } from '@dead-air/shared/constants.ts';

export const MONSTER_ORDER: readonly MonsterKind[] = ['hound', 'listener', 'mannequin', 'snatcher'];

export interface MonsterDef {
  kind: MonsterKind;
  name: string;
  /** level 2 card: CLASSIFICATION / RULE / COUNTERPLAY lines */
  card: readonly string[];
  /** card while listenerFairV12 is off (Listener only) */
  cardV11?: readonly string[];
  /** level 1: what you heard */
  sounds: readonly string[];
}

export interface PageDef {
  /** 'hound.1' */
  id: string;
  monster: MonsterKind;
  /** 1-based page number within the monster's section */
  n: number;
  title: string;
  text: string;
  /** variant shown while listenerFairV12 is off */
  titleV11?: string;
  textV11?: string;
}

export const MONSTERS: Readonly<Record<MonsterKind, MonsterDef>> = {
  hound: {
    kind: 'hound',
    name: 'THE HOUND',
    card: [
      'CLASSIFICATION: K-9 (canine, presumed). No eyes. Hunts entirely by ear.',
      'RULE: Whispers and crouch-steps are beneath its notice. A growl means it heard you; a second noise near it and it charges.',
      'COUNTERPLAY: When it growls, everyone FREEZE. Crouch (C) to move. Throw a bottle to send it somewhere else.',
    ],
    sounds: [
      'Wet huffing, low to the floor.',
      'Claws ticking on concrete, then stopping.',
      'A growl you feel in your fillings.',
    ],
  },
  listener: {
    kind: 'listener',
    name: 'THE LISTENER',
    card: [
      'CLASSIFICATION: Unknown. Tall, head always cocked to one side. Understands speech.',
      'RULE: It hunts what you SAY: room names, people, numbers, plans. When it notices you its head snaps round; then it hunts. It only grabs someone with no teammate within {{monsters.listener.grabAloneM}} m.',
      'COUNTERPLAY: Sprint, it is slower than a running employee. Crouch behind anything waist-high, desks and shelves alike. Shut a door in its face, light a flare or swing the crowbar. Stay in pairs. Its first grab only knocks you down.',
    ],
    cardV11: [
      'CLASSIFICATION: Unknown. Tall, head always cocked to one side. Understands speech.',
      'RULE: It hunts what you SAY: room names, people, numbers, plans, and acts on what it heard. It only grabs someone with no teammate within {{monsters.listener.grabAloneM}} m.',
      'COUNTERPLAY: Stay in pairs. If it grabs someone, shove it off (E) or hit it with the crowbar within {{monsters.listener.grabSec}} seconds. Lie to it. Verify every radio call.',
    ],
    sounds: [
      'A dry clicking, like a tongue against teeth.',
      'Static on the walkie when nobody pressed the button.',
      'A voice on the radio that is almost a colleague.',
    ],
  },
  mannequin: {
    kind: 'mannequin',
    name: 'THE MANNEQUIN',
    card: [
      'CLASSIFICATION: Display figure, porcelain-pale. The inventory lists none. The inventory is wrong.',
      'RULE: It cannot move while someone is looking at it AND it is lit. Your visor blinks. One watcher is a gamble; two watchers are safe.',
      'COUNTERPLAY: Keep it lit and keep looking. Back away together, facing it. A glowstick at its feet keeps it lit for you.',
    ],
    sounds: [
      'A joint creaking, the way old wood does.',
      'Footsteps that stop exactly when you turn around.',
      'Nothing. Mostly nothing.',
    ],
  },
  snatcher: {
    kind: 'snatcher',
    name: 'THE SNATCHER',
    card: [
      'CLASSIFICATION: Duct-dwelling. Long arms. Never observed standing up.',
      'RULE: It lives in the vents and takes whoever wanders off alone, then drags them to a grate.',
      'COUNTERPLAY: Stay close to the crew. Watch for rattling grates and falling dust. If it takes someone, follow the trail and pull them out at the grate (hold E).',
    ],
    sounds: [
      'A vent grate rattling in a room with no draught.',
      'Scratching inside the ceiling, keeping pace with you.',
      'Soft clicking, right overhead.',
    ],
  },
};

export const PAGES: readonly PageDef[] = [
  // ------------------------------------------------------------------ THE HOUND (5)
  {
    id: 'hound.1', monster: 'hound', n: 1,
    title: 'RE: THE DOG',
    text: [
      'To all field staff. The animal on site is not a dog and is not to be called "the dog" in incident reports. It is THE HOUND.',
      'It has no eyes and it does not need them. It hears a footstep two rooms away and remembers exactly where it stopped.',
      'The Company accepts no liability for staff who "thought it was asleep".',
      '✎ it is never asleep',
    ].join('\n'),
  },
  {
    id: 'hound.2', monster: 'hound', n: 2,
    title: 'THE GROWL MEANS FREEZE',
    text: [
      'When it hears you, it stops and growls. That growl is your warning, and the Company considers you warned.',
      'Make a second noise near it within {{monsters.hound.chargeWindowSec}} seconds and it charges at {{monsters.hound.chargeSpeed}} m/s: faster than you, faster than your colleagues and faster than the paperwork.',
      'Stand still. Stop talking. About {{monsters.hound.loseInterestSec}} seconds of silence and it loses interest.',
      '✎ "stand still" includes your mouth, Gary',
    ].join('\n'),
  },
  {
    id: 'hound.3', monster: 'hound', n: 3,
    title: 'WHAT IT CAN HEAR (A TABLE)',
    text: [
      'Crouch-step: {{const.NOISE_M.crouchStep}} m. Walking: {{const.NOISE_M.walkStep}} m. Sprinting: {{const.NOISE_M.sprintStep}} m.',
      'Whispering: {{const.BAND_RADIUS_M.1}} m. Talking: {{const.BAND_RADIUS_M.2}} m. Screaming: {{const.BAND_RADIUS_M.4}} m, and frankly that one is on you.',
      'Anything that carries less than {{monsters.hound.hearMinRadiusM}} m slips under it. Crouch (C) past it and whisper if you must.',
      'Sound travels along corridors and around corners. A closed door only muffles it (about {{const.PATH.doorClosedCost}} m of extra distance).',
    ].join('\n'),
  },
  {
    id: 'hound.4', monster: 'hound', n: 4,
    title: 'BOTTLES ARE COMPANY PROPERTY. THROW THEM.',
    text: [
      'A smashed bottle carries {{const.NOISE_M.bottle}} metres. The Hound will go and investigate it, and it will sniff around the glass for a while before it gives up.',
      'Throw it far. Throw it away from your crew. Do not throw it at the Hound.',
      '✎ it does not fetch. ask Dmitri. you can\'t, which is the point',
    ].join('\n'),
  },
  {
    id: 'hound.5', monster: 'hound', n: 5,
    title: 'INCIDENT REPORT 7-K: LUNCH',
    text: [
      'Staff are reminded that the Hound eats what it catches, and that it takes its time (about {{monsters.hound.eatSec}} seconds). This is not an opportunity to finish your task. It is an opportunity to leave.',
      'The kennel Hound at the van lot is chained and cannot reach you. Practise on it: walk close and it turns and growls, sprint and it lunges, crouch and it never knows you were there.',
      'Training kennel record: no deaths. Several resignations.',
    ].join('\n'),
  },

  // ------------------------------------------------------------------ THE LISTENER (6)
  {
    id: 'listener.1', monster: 'listener', n: 1,
    title: 'IT IS NOT DEAF. IT IS LISTENING.',
    text: [
      'The Listener sleeps when you arrive. When it wakes, every light on site flickers at once and every walkie squelches. From then on, assume it heard everything.',
      'It does not care how loud you are. It cares what you say: room names, colleagues\' names, numbers, plans. Say "meet me in the boiler room" and it will be there first.',
      'The Company recommends code words, lies and silence, in that order.',
    ].join('\n'),
  },
  {
    id: 'listener.2', monster: 'listener', n: 2,
    title: 'IT LOOKS BEFORE IT HUNTS',
    text: [
      'When it notices you, it stops. Its head snaps toward you with a sound like a knuckle cracking. You now have about {{monsters.listener.noticeSec|1.2}} seconds. Use them.',
      'It hunts at {{monsters.listener.huntSpeed|4.6}} m/s. You walk at {{const.MOVE.walk}} and sprint at {{const.MOVE.sprint}}. Do the maths, then do the sprinting.',
      'It cannot pounce on anyone it has not warned first, so the head snap is a courtesy. The Company does not extend courtesies twice.',
    ].join('\n'),
    titleV11: 'IT SEES FURTHER IN THE LIGHT',
    textV11: [
      'It sees about {{monsters.listener.sightLitM}} m in a lit room and {{monsters.listener.sightDarkM}} m in the dark. Inside that range it comes for you, and it covers the last {{monsters.listener.lungeRangeM}} metres faster than you can turn around.',
      'Keep the lights off where you can, keep your flashlight down when it is close, and never be the one left alone in a room with it.',
    ].join('\n'),
  },
  {
    id: 'listener.3', monster: 'listener', n: 3,
    title: 'GET DOWN',
    text: [
      'Crouched (C), you are much harder to spot: about {{calc.listenerCrouchLitM}} m in the light and {{calc.listenerCrouchDarkM}} m in the dark, instead of {{monsters.listener.sightLitM}} and {{monsters.listener.sightDarkM}}.',
      'Crouch behind anything at least {{monsters.listener.lowCoverMinH|0.75}} m tall (a desk, a counter, a shelf, a cabinet) and it looks straight past you. A low desk only hides you within about {{monsters.listener.lowCoverRangeM|2.5}} m of it; shelving taller than {{monsters.listener.tallCoverMinH|1.7}} m hides you even standing.',
      'Crouching does not make you invisible. It makes you furniture. Be good furniture.',
    ].join('\n'),
    titleV11: 'LOCKERS ARE COMPANY-APPROVED',
    textV11: [
      'A locker is the only cover the Company will sign off on. Get in (E), keep still and wait it out.',
      'Crouching keeps the Hound off you but does nothing for the Listener\'s eyes. If it watched you climb in, it knows where you are: find a different locker.',
    ].join('\n'),
  },
  {
    id: 'listener.4', monster: 'listener', n: 4,
    title: 'DOORS, FLARES, CROWBARS',
    text: [
      'Things that slow it down, in order of preference.',
      'A closed door: about {{monsters.listener.huntDoorPauseSec|1.4}} s to get through. A door slammed in its face from up close: stunned for {{monsters.listener.doorSlamStunSec|1}} s, and it usually loses you.',
      'A burning flare: it will not come within {{monsters.listener.flareRepelM|3}} m of one. A crowbar to the head: it staggers for {{monsters.listener.staggerSec|2}} s and then backs off.',
      'Lockers also work, if it did not see you get in.',
      '✎ the flare is not a torch. do not wave it at people',
    ].join('\n'),
    titleV11: 'CROWBARS AND SHOVES',
    textV11: [
      'If it grabs someone you have {{monsters.listener.grabSec}} seconds. Get within {{monsters.listener.shoveRangeM}} m and shove it off (E) or hit it with the crowbar. It lets go and keeps away for a while.',
      'If nobody comes, nobody comes. That is why the Company insists on pairs.',
    ].join('\n'),
  },
  {
    id: 'listener.5', monster: 'listener', n: 5,
    title: 'IT ONLY TAKES THE LONELY',
    text: [
      'It will not grab anyone with a teammate within {{monsters.listener.grabAloneM}} m. It follows at a distance instead and waits for one of you to wander off.',
      'The first time it gets its hands on you it only knocks you down: {{monsters.listener.knockdownSec|2}} seconds on the floor and a dead flashlight for {{monsters.listener.knockdownLightOffSec|6}}. Consider it a performance review.',
      'After that it holds on for {{monsters.listener.grabSec}} seconds. MASH E to struggle free, or have a colleague within {{monsters.listener.shoveRangeM}} m shove it (E) or use the crowbar.',
      'A crew of one gets {{monsters.listener.soloGrabSec|6}} seconds and an easier struggle, because Management believes in you. Statistically.',
    ].join('\n'),
    textV11: [
      'It will not grab anyone with a teammate within {{monsters.listener.grabAloneM}} m. It follows at a distance instead and waits for one of you to wander off.',
      'When it grabs, it holds on for {{monsters.listener.grabSec}} seconds. After that there is no paperwork, because there is no employee.',
    ].join('\n'),
  },
  {
    id: 'listener.6', monster: 'listener', n: 6,
    title: 'IT LIES ON THE RADIO',
    text: [
      'It can talk on your walkies, and it sounds almost right.',
      'A real call clicks when someone presses push-to-talk. Its calls do not click, and your walkie light flickers red.',
      'Verify every radio call. Agree a code word in the van. Never say the vault code out loud anywhere near it, and never announce where you are going. It has already been there.',
      '✎ if "you" call asking where you are, it is not you',
    ].join('\n'),
  },

  // ------------------------------------------------------------------ THE MANNEQUIN (4)
  {
    id: 'mannequin.1', monster: 'mannequin', n: 1,
    title: 'INVENTORY DISCREPANCY: ONE (1) DISPLAY FIGURE',
    text: [
      'The display figure on your site is not on the inventory, is not a display figure, and is not where you left it.',
      'It cannot move while someone is looking at it AND it is lit. Both. A figure in the dark is a figure in motion. A figure nobody is watching is a figure right behind you.',
      'It turns up late in the night (from about {{calc.mannequinSpawnClock}}) or the moment somebody lifts the Core.',
    ].join('\n'),
  },
  {
    id: 'mannequin.2', monster: 'mannequin', n: 2,
    title: 'YOUR VISOR BLINKS',
    text: [
      'Company visors blink every {{monsters.mannequin.blinkMinSec}} to {{monsters.mannequin.blinkMaxSec}} seconds. You will not notice. It will.',
      'One person watching it is a gamble. Two people watching it blink at different moments, which is the only reason the Company still employs two people.',
      'It crosses a room at {{monsters.mannequin.speed}} m/s, so do not look away to check the map.',
    ].join('\n'),
  },
  {
    id: 'mannequin.3', monster: 'mannequin', n: 3,
    title: 'LIGHT IT',
    text: [
      'Lit means: a room light that is on, a flashlight beam from within about {{monsters.mannequin.flashlightRangeM}} m, or a glowstick within 2 m of it.',
      'A glowstick costs less than a funeral and lasts longer than most employees. Drop one at its feet and walk backwards, together, facing it.',
      'If the power goes, so does your protection.',
    ].join('\n'),
  },
  {
    id: 'mannequin.4', monster: 'mannequin', n: 4,
    title: 'A MIRROR DOES NOT COUNT',
    text: [
      'Staff keep asking. No: a mirror does not count as watching it. Its reflection can stare back at you all night and the figure itself will still walk up behind you.',
      'Neither does a photo, a screen, or a colleague saying "it hasn\'t moved". Only your own eyes on the figure itself, with light on it.',
      'When it starts moving again after being watched, its joints creak. Treat the creak as your final notice.',
    ].join('\n'),
  },

  // ------------------------------------------------------------------ THE SNATCHER (4)
  {
    id: 'snatcher.1', monster: 'snatcher', n: 1,
    title: 'MAINTENANCE REQUEST: THE VENTS',
    text: [
      'Facilities Management has closed 214 tickets about "noises in the ducts" as WORKING AS INTENDED.',
      'The Snatcher lives in the vents. It takes people who are alone: more than {{monsters.snatcher.aloneM}} m from everyone else for about {{monsters.snatcher.aloneSec}} seconds.',
      'It leaves you alone for your first {{calc.snatcherStartMin}} minutes on site. After that, it does not.',
    ].join('\n'),
  },
  {
    id: 'snatcher.2', monster: 'snatcher', n: 2,
    title: 'BEFORE IT DROPS',
    text: [
      'It gives notice, which is more than HR does.',
      'A grate rattles. Dust trickles from the ceiling. Something scratches along the ducts, keeping pace with you. Then a soft clicking right above you, about {{monsters.snatcher.tickLeadSec}} seconds before it drops.',
      'If you can hear the clicking, you are already alone. Fix that.',
    ].join('\n'),
  },
  {
    id: 'snatcher.3', monster: 'snatcher', n: 3,
    title: 'IF IT TAKES YOU',
    text: [
      'It drags you toward the nearest grate. MASH E to struggle: every press slows it down.',
      'Scream for your crew. Screaming is unprofessional, but the Company will overlook it this once.',
      'You have roughly {{monsters.snatcher.dragSec}} seconds before you are in the ducts and off the payroll.',
    ].join('\n'),
  },
  {
    id: 'snatcher.4', monster: 'snatcher', n: 4,
    title: 'IF IT TAKES SOMEONE ELSE',
    text: [
      'Follow the drag trail to the grate. Stand at the grate and hold E: {{monsters.snatcher.pullSec}} seconds within {{monsters.snatcher.pullRangeM}} m pulls them back out.',
      'It retreats into the ducts and sulks for about {{monsters.snatcher.rescueRetreatSec}} seconds. Do not spend that time splitting up again.',
      '✎ count heads after every rescue. count them again',
    ].join('\n'),
  },
];

/** ANOMALIES tab: kinds and counts only (labels are deliberately vague: nothing here explains a phenomenon) */
export const ANOMALY_LABELS: Readonly<Record<ParanormalKind, string>> = {
  dark_walk: 'LIGHTS DYING IN A LINE',
  revive: 'LIGHTS COMING BACK',
  mirror_writing: 'WRITING ON A MIRROR',
  mirror_figure: 'SOMEONE BEHIND YOU (MIRROR)',
  presence: 'A SHADOW WITH NO OWNER',
  silhouette: 'A FIGURE AT THE END OF THE HALL',
  cold_spot: 'COLD SPOT',
  knock: 'KNOCKING',
  handle_rattle: 'A RATTLING HANDLE',
  poltergeist: 'OBJECTS MOVING ON THEIR OWN',
  object_fall: 'SOMETHING FELL',
  footprints: 'WET FOOTPRINTS',
  brownout_breath: 'BROWNOUT',
  radio_on: 'A RADIO SWITCHING ON',
  phone_ring: 'A RINGING PHONE',
  dead_poke: 'A NUDGE FROM THE OTHER SIDE',
};
export const ANOMALY_KINDS: readonly ParanormalKind[] = Object.keys(ANOMALY_LABELS) as ParanormalKind[];
export function anomalyLabel(kind: string): string {
  return (ANOMALY_LABELS as Record<string, string>)[kind] ?? kind.replace(/_/g, ' ').toUpperCase();
}

// ---------------------------------------------------------------- lookups

const BY_ID = new Map(PAGES.map((p) => [p.id, p]));
export function pageDef(id: string): PageDef | null {
  return BY_ID.get(id) ?? null;
}
/** page ids of one monster, in page order */
export function pageIdsOf(kind: MonsterKind): string[] {
  return PAGES.filter((p) => p.monster === kind).sort((a, b) => a.n - b.n).map((p) => p.id);
}
export function pagesTotalOf(kind: MonsterKind): number {
  return pageIdsOf(kind).length;
}
export function isMonsterKind(k: unknown): k is MonsterKind {
  return typeof k === 'string' && (MONSTER_ORDER as readonly string[]).includes(k);
}

// ---------------------------------------------------------------- placeholders

/** where placeholder values come from: ctx.balance (domain -> object) */
export type BalanceLike = Readonly<Record<string, unknown>>;

const CONSTS: Readonly<Record<string, unknown>> = { NOISE_M, MOVE, BAND_RADIUS_M, PATH, CLOCK };

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function walk(root: unknown, parts: readonly string[]): unknown {
  let cur: unknown = root;
  for (const k of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

const bal = (b: BalanceLike, path: string): number | undefined => num(walk(b, path.split('.')));
const clockAt = (gameMin: number): string => {
  const total = CLOCK.startHour * 60 + Math.round(gameMin);
  const h = Math.floor(total / 60) % 24, m = ((total % 60) + 60) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

/** derived values ({{calc.<name>}}) */
const CALC: Readonly<Record<string, (b: BalanceLike) => number | string | undefined>> = {
  listenerCrouchLitM: (b) => {
    const s = bal(b, 'monsters.listener.sightLitM');
    return s === undefined ? undefined : s * (bal(b, 'monsters.listener.crouchSightMult') ?? 0.6);
  },
  listenerCrouchDarkM: (b) => {
    const s = bal(b, 'monsters.listener.sightDarkM');
    return s === undefined ? undefined : s * (bal(b, 'monsters.listener.crouchSightMult') ?? 0.6);
  },
  mannequinSpawnClock: (b) => clockAt(bal(b, 'monsters.mannequin.spawnGameMin') ?? 90),
  snatcherStartMin: (b) => Math.max(1, Math.round((bal(b, 'monsters.snatcher.minStartSec') ?? 120) / 60)),
};

/** a placeholder's value, or undefined when its source is missing (the inline default then applies) */
export function resolvePlaceholder(path: string, b: BalanceLike): number | string | undefined {
  const [root, ...rest] = path.split('.');
  if (root === 'calc') return CALC[rest.join('.')]?.(b);
  if (root === 'const') return num(walk(CONSTS, rest));
  return bal(b, path);
}

/** 4.6 -> '4.6', 6 -> '6', 0.75 -> '0.75' */
export function fmtNum(n: number): string {
  const r = Math.round(n * 100) / 100;
  return String(Object.is(r, -0) ? 0 : r);
}

export const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.]+)\s*(?:\|\s*(-?[0-9.]+)\s*)?\}\}/g;

/** fill every {{placeholder}}; a value that cannot be resolved and has no default becomes '?' (never raw braces) */
export function fillText(text: string, b: BalanceLike): string {
  return text.replace(PLACEHOLDER, (_m, path: string, def: string | undefined) => {
    const v = resolvePlaceholder(path, b);
    if (typeof v === 'string') return v;
    const n = v ?? (def !== undefined ? Number(def) : undefined);
    return n === undefined || !Number.isFinite(n) ? '?' : fmtNum(n);
  });
}

/** title + filled text of a page under the current flags */
export function renderPage(def: PageDef, b: BalanceLike, v12: boolean): { id: string; title: string; text: string } {
  const old = !v12 && def.textV11 !== undefined;
  return { id: def.id, title: old ? (def.titleV11 ?? def.title) : def.title, text: fillText(old ? def.textV11! : def.text, b) };
}

/** the monster's card lines under the current flags */
export function renderCard(kind: MonsterKind, b: BalanceLike, v12: boolean): string[] {
  const d = MONSTERS[kind];
  return ((!v12 && d.cardV11) ? d.cardV11 : d.card).map((l) => fillText(l, b));
}

/** every template string (tests: placeholder + leak checks) */
export function allTemplates(): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  for (const k of MONSTER_ORDER) {
    const d = MONSTERS[k];
    d.card.forEach((t, i) => out.push({ where: `${k}.card.${i}`, text: t }));
    d.cardV11?.forEach((t, i) => out.push({ where: `${k}.cardV11.${i}`, text: t }));
    d.sounds.forEach((t, i) => out.push({ where: `${k}.sounds.${i}`, text: t }));
  }
  for (const p of PAGES) {
    out.push({ where: `${p.id}.title`, text: p.title }, { where: `${p.id}.text`, text: p.text });
    if (p.titleV11) out.push({ where: `${p.id}.titleV11`, text: p.titleV11 });
    if (p.textV11) out.push({ where: `${p.id}.textV11`, text: p.textV11 });
  }
  return out;
}
