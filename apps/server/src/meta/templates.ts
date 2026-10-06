// Owner: track (d) Meta. Handwritten template pack: work orders (sites, histories, memos, Company Requests, clue notes),
// drive chatter, rule cards, HR performance reviews and termination letters. Darkly comic corporate tone, PG-13,
// supernatural threat only (never pathogens, chemicals, weapons or lab procedures). (e) may swap AI text in later.
//
// Clue-note placeholders (substituted by (a) objectives at contract start; each appears at most once per order):
//   {{CODE_A}} first two vault digits · {{CODE_B}} last two vault digits
//   {{ROOM_1}} vault room callsign · {{ROOM_2}} breaker lever A room · {{ROOM_3}} breaker lever B room
// (same set as BRIEF_PLACEHOLDERS in packages/shared/src/messages/ai.ts)
import type { CompanyRequestKind } from '@dead-air/shared/workorder.ts';
import type { MetaRuleCard } from '@dead-air/shared/messages/meta.ts';

export interface SiteTemplate {
  name: string;
  history: string;
  memo: string;
  /** flavour modifiers shown as chips on the order card */
  modifiers: string[];
}

export const SITES: readonly SiteTemplate[] = [
  {
    name: 'Halvorsen Cold Storage',
    history: 'Built in 1961 to keep fish. Closed in 1998 after the night staff began requesting transfers to "anywhere with fewer footsteps". The freezers were never switched off. Nobody can say who pays the electricity bill.',
    memo: 'The client reports the freezers are "humming in a key that wasn\'t there before". Humming is not billable. Salvage is. Wear the thermal liners the Company did not issue you.',
    modifiers: ['COLD', 'LONG CORRIDORS'],
  },
  {
    name: 'St. Brannock Infirmary, East Wing',
    history: 'The east wing was sealed in 1979 "for renovations". The renovation budget was approved four times. The wing was never renovated, and every contractor who quoted for it asked to be paid in advance.',
    memo: 'Do not answer the patient call buttons. They are not connected to anything, which is exactly why you should not answer them. The vault holds the hospital\'s original Core. Bring it home.',
    modifiers: ['DARK WARDS'],
  },
  {
    name: 'Mercer & Pell Records Depository',
    history: 'Eleven kilometres of shelving and one surviving index card. Mercer vanished in 1987. Pell continued alone for six years, filing reports addressed to Mercer, until he too was misfiled.',
    memo: 'Everything in here is confidential, including the things that whisper. Do not read the files aloud. Especially not the ones with your name on them. There should not be any with your name on them.',
    modifiers: ['QUIET SITE', 'MAZE'],
  },
  {
    name: 'Lowmoor Pumping Station No. 4',
    history: 'Stations 1 to 3 were decommissioned without incident. Station 4 kept pumping after the water was cut off. Engineers logged "a regular knocking, like someone politely asking to be let out".',
    memo: 'The pumps are loud. You are not. Keep it that way. Twin breakers restore the pump room lights; pull them together or the alarm will tell everything in the building exactly where you are.',
    modifiers: ['MACHINE NOISE'],
  },
  {
    name: 'The Gilded Lantern Hotel, Service Levels',
    history: 'Five stars upstairs, no stars downstairs. Guests complained about room service arriving at doors nobody had ordered from. The kitchens closed in 2004; the service bell still rings at 03:00.',
    memo: 'Guests are not your concern. There are no guests. If a guest asks you for something, you are on your break. Salvage the silverware, the safe and the Core. Tipping is discouraged.',
    modifiers: ['TIGHT HALLS'],
  },
  {
    name: 'Varga Brothers Foundry',
    history: 'Three generations of Vargas cast bells here. The last bell was never collected. It hangs in the furnace hall and rings once whenever someone says a number out loud.',
    memo: 'Management reminds you that numbers are Company property. Read the vault code out ONCE, quietly, to the person standing at the keypad. Do not count your salvage on the radio.',
    modifiers: ['HEAVY SALVAGE'],
  },
  {
    name: 'Old Quarry Road Telephone Exchange',
    history: 'Every call in the county went through this building until 1991. Switchboard operators reported a caller who never spoke, only listened. The line was traced to the exchange itself.',
    memo: 'The phones are dead. If one rings, it is not for you, and you should absolutely not tell it where you are. Radio discipline is mandatory. Radio discipline is always mandatory. Today it is extra mandatory.',
    modifiers: ['RADIO HEAVY'],
  },
  {
    name: 'Wetherby Municipal Laundry',
    history: 'Washed the uniforms of six hospitals and one prison until the drums started turning on their own. The last foreman said the sheets came out "folded, warm, and shaped like people".',
    memo: 'Ignore any laundry that appears to be standing up. It is static. Static is a known phenomenon. The Company has a laminated card about it somewhere.',
    modifiers: ['DAMP', 'LOW VISIBILITY'],
  },
  {
    name: 'Kestrel Point Ferry Terminal',
    history: 'The last ferry left on time in 2009 and arrived nowhere. The terminal stayed open for another year, announcing departures to an empty hall in a voice nobody on staff recognised.',
    memo: 'If you hear a boarding announcement, do not board. There is no boat. There has not been a boat for years. Salvage the ticket office safe and the Core, then get back in the van, which is a real vehicle.',
    modifiers: ['OPEN HALLS'],
  },
  {
    name: 'Fenwick Hall Boarding School, Lower Floors',
    history: 'Fenwick Hall closed mid-term in 1983. The register lists 212 pupils and 213 lockers in use. Nobody has ever found out who owned the extra locker, though several people have heard it close.',
    memo: 'Lights-out was at 21:00. You are late. Keep your voices down in the corridors and do not run. The Company is not saying anything is listening. The Company is saying the prefects were very strict.',
    modifiers: ['LOCKERS', 'ECHOES'],
  },
  {
    name: 'Dunmore Radio Relay Station',
    history: 'Relayed shipping forecasts for forty years. In its final year it began relaying forecasts nobody had written, for places that are not on any chart, delivered in the voice of whoever was on shift.',
    memo: 'Something on this site has learned to use radios. Verify every call. If your teammate sounds wrong, they are wrong. If they sound right, ask them something only they would know. Then whisper it.',
    modifiers: ['LISTENER ACTIVE'],
  },
  {
    name: 'Corrigan Shoe Factory',
    history: 'Corrigan made sensible shoes for sensible people for seventy years. The factory closed in 1996. Night guards kept hearing footsteps on the cutting floor, always in a size nobody stocked.',
    memo: 'Remember: footsteps carry. Crouch-walk where it matters. Sprint only when you have already been noticed. If you hear footsteps that are not yours, they are not yours.',
    modifiers: ['HARD FLOORS'],
  },
  {
    name: 'Brightwater Public Baths',
    history: 'Victorian tiles, Edwardian plumbing, and a deep end that was drained in 1974 and refilled itself in 1975. The pool has been dry since. The changing rooms are always slightly wet.',
    memo: 'Do not go in the deep end. There is no water in the deep end. That is not the point. Salvage the ticket machines, the brass fittings and the Core. Tiles echo. So will you.',
    modifiers: ['ECHOES'],
  },
  {
    name: 'Northgate Parcel Sorting Centre',
    history: 'Ninety thousand parcels a night, until one sorting shift ended with ninety thousand and one. The extra parcel has no address, no sender, and is apparently quite heavy for its size.',
    memo: 'Do NOT open the unaddressed parcel. Do not shake it. Do not ask it what is inside. Everything else in the building is fair salvage. Fragile items lose value when dropped; so do contractors.',
    modifiers: ['CLUTTERED'],
  },
  {
    name: 'Our Lady of the Sound, Chapel and Hall',
    history: 'The bell tower was built to be heard across the marsh. When the bell was removed in 1990 the parish kept hearing it. The hall was let to a bingo club, which left after the numbers started calling themselves.',
    memo: 'Please be respectful: this is a former place of worship and current place of salvage. Candlesticks, collection plates and the Core are approved for removal. Hymn books are not worth the weight.',
    modifiers: ['QUIET SITE'],
  },
  {
    name: 'Tidewell Greenhouses',
    history: 'Tidewell grew orchids for the city florists. The glasshouses went dark in 2011, but the plants never died. Botanists who visited said they turned, slowly, toward whoever was speaking.',
    memo: 'The plants are harmless. Probably. The thing that waters them is not. Lit glasshouses are easy to see into, from both sides. Keep your flashlight low and your voices lower.',
    modifiers: ['GLASS', 'OPEN SIGHTLINES'],
  },
  {
    name: 'Marrow Lane Bus Depot',
    history: 'The night buses ran from here until the last driver reported a passenger who stayed on past the terminus, every night, for a month. The depot closed. The buses were never moved.',
    memo: 'Do not sit in the buses. Do not ring the bell. If a bus engine starts, it is not one of ours. Our van is the one with the Company logo and the very tired driver.',
    modifiers: ['LARGE BAYS'],
  },
  {
    name: 'Halcyon Department Store, Closed Floors',
    history: 'Floors four to six were closed in 1989 after a stocktake found more mannequins than had ever been ordered. The surplus was never explained, and is never in the same place twice.',
    memo: 'Stock-taking is not required. If a display figure appears closer than it was, keep looking at it and keep it lit. Two of you. Back away together. Do not argue about whose turn it is to blink.',
    modifiers: ['MANNEQUINS LIKELY'],
  },
  {
    name: 'Pellam County Courthouse Archive',
    history: 'Two centuries of verdicts in a basement built for one. The archivist retired in 2002, citing "an appeal that will not stop being lodged". The courtroom upstairs still calls the same case at night.',
    memo: 'You are not on trial. Please stop saying "I object" on the radio; it is not funny and it tells everyone where you are. Salvage the records safe and the Core. Leave the gavel.',
    modifiers: ['MAZE', 'DARK'],
  },
  {
    name: 'Ironside Grain Silo Offices',
    history: 'Ironside stored grain for the whole valley. The offices at the base were abandoned in 2006 when the silos began to answer back over the intercom, mostly with the names of staff who had already gone home.',
    memo: 'Intercoms on this site are live. Something uses them. If an intercom calls your name, do not go. If it calls a room, go somewhere else. If it calls the van, the van is fine. Probably.',
    modifiers: ['INTERCOMS'],
  },
  {
    name: "Wren's End Holiday Camp, Staff Quarters",
    history: "A cheerful seaside camp with a cheerful seaside problem: the entertainment staff never clocked out. The camp closed in 1993. The talent show is still on, every night, in the staff hall.",
    memo: 'Do not join in. Do not applaud. Do not volunteer from the audience, however politely you are asked. Salvage the prize cabinet, the ticket office and the Core. Enjoy your stay is not an instruction.',
    modifiers: ['CHEERFUL', 'DO NOT CLAP'],
  },
  {
    name: 'Okonkwo Natural History Museum, Deep Storage',
    history: 'The public galleries are fine. Deep storage holds four thousand specimens that were catalogued once and have been counted wrong ever since. The night curator recommends you do not count them.',
    memo: 'The exhibits are dead and should remain so. Salvage the display brass, the curator\'s safe and the Core. The museum would like its silence back when you are done.',
    modifiers: ['FRAGILE LOOT'],
  },
  {
    name: 'Blackwater Waterworks',
    history: 'Clean water for 40,000 homes, and a filtration hall that hums the same three notes over and over. A 1997 inspection report ends mid-sentence, with the words "it is copying the".',
    memo: 'Whatever is copying, do not give it material. Use code words. Lie about room names. The Listener cannot tell a joke from a plan, and frankly neither can most of you.',
    modifiers: ['LISTENER ACTIVE', 'MACHINE NOISE'],
  },
  {
    name: 'Lindqvist Piano Works',
    history: 'Lindqvist pianos were famous for their tone. The last one off the line was never tuned; it tunes itself, at night, one note at a time, slightly sharper each year.',
    memo: 'If you hear a piano, freeze. Not because of the piano. The piano is fine. Because of what comes to listen to it. Twin breakers are in the workshop wing. Pull together, please.',
    modifiers: ['HOUND TERRITORY'],
  },
];

/** Company Request flavour text per kind. {{X}} = threshold. */
export const REQUEST_TEXT: Record<CompanyRequestKind, readonly string[]> = {
  ALL_SURVIVE: [
    'Bring everyone back. Replacement paperwork takes eleven working days.',
    'Headcount at 04:00 must match headcount at 22:00. HR has asked us to stop "rounding".',
    'Zero fatalities this contract. The insurance renewal is on Friday.',
    'Return all contractors in one piece each. Several pieces is not acceptable.',
  ],
  EXTRACT_ABOVE: [
    'Recover at least {{X}} scrip of salvage. The client\'s insurer is watching the van door.',
    'Haul {{X}} scrip or better. Anything less and Accounts will want to talk.',
    'The client expects {{X}} scrip back. The client has expectations. Meet them.',
    'Minimum recovery: {{X}} scrip. The Company will not be explaining a shortfall twice.',
  ],
  LURE_IT_WITH_A_LIE: [
    'Name a room on an open channel, make sure nobody is in it, and let it go and look. Liability would love to know if this works.',
    'Send it somewhere empty: say a callsign out loud while nobody is there. Research has questions. You have answers.',
    'Tell it a lie. Say a room name where it can hear you, keep that room empty, and let it waste its time. The Company does this to you all the time.',
  ],
};

export const REQUEST_REWARD: Record<CompanyRequestKind, [number, number]> = {
  ALL_SURVIVE: [80, 120],
  EXTRACT_ABOVE: [60, 110],
  LURE_IT_WITH_A_LIE: [100, 150],
};

export interface NoteTemplate {
  title: string;
  body: string;
}

/** first half of the vault code (exactly one per order) */
export const CODE_A_NOTES: readonly NoteTemplate[] = [
  { title: 'Sticky note, keypad side', body: 'Vault code starts {{CODE_A}}. The rest is with Doug. Doug is not here any more. Nobody is sure where Doug is.' },
  { title: 'Torn shift log, page 4', body: '...changed the vault code again. First two are {{CODE_A}}, same as my locker. If anyone asks, I never wrote this down.' },
  { title: 'Inside of a cigarette packet', body: '{{CODE_A}}--. Remember the dashes. The dashes are important. (They are not important, the second half is.)' },
  { title: 'Memo: vault access', body: 'For security the code is split between two notes. This note holds the first half: {{CODE_A}}. Please do not keep both notes in the same place. Signed, Security.' },
  { title: 'Scratched into a desk', body: 'CODE {{CODE_A}}?? it heard me say the rest. dont say the rest' },
];

/** second half of the vault code (exactly one per order) */
export const CODE_B_NOTES: readonly NoteTemplate[] = [
  { title: 'Napkin, coffee-stained', body: 'Last two digits of the vault: {{CODE_B}}. Eat this napkin after reading. (Do not actually eat the napkin.)' },
  { title: 'Overtime claim form', body: 'Hours: 14. Reason: stayed late re-setting the vault to --{{CODE_B}}. Approved? Never approved.' },
  { title: 'Child\'s drawing, pinned up', body: 'A crayon picture of the building with the numbers {{CODE_B}} written very carefully on the vault door. Nobody here has children.' },
  { title: 'Security handover', body: 'Second half of the code: {{CODE_B}}. First half is on the other note. If you have found both notes, congratulations, you are security now.' },
  { title: 'Written on the back of a glove', body: '..{{CODE_B}}. said it quietly. it still came.' },
];

/** where the twin breakers are (one per order) */
export const LEVER_NOTES: readonly NoteTemplate[] = [
  { title: 'Maintenance tag', body: 'Breaker A: {{ROOM_2}}. Breaker B: {{ROOM_3}}. Pull them at the SAME time or the alarm goes off and everything comes to see.' },
  { title: 'Electrician\'s note', body: 'Twin breakers restore vault power. One in {{ROOM_2}}, one in {{ROOM_3}}. Count down together on the radio. Not too loudly.' },
  { title: 'Laminated safety card', body: 'POWER RESTORATION: two operators, two levers ({{ROOM_2}} / {{ROOM_3}}), one second apart at most. Failure results in alarm, cooldown and disappointment.' },
];

/** pure flavour (0-3 per order) */
export const FLAVOUR_NOTES: readonly NoteTemplate[] = [
  { title: 'Notice board', body: 'Whoever keeps whistling in the vents: please stop. Nobody on the night shift can whistle.' },
  { title: 'Incident report', body: 'Staff member reported being called by name over the intercom. Staff member was alone in the building. Staff member has been reassigned to days, at their own request, in writing, in capitals.' },
  { title: 'Lost and found', body: 'Found: one boot, left foot, size 9, still warm. If this is yours please collect from the {{ROOM_1}} at your earliest convenience.' },
  { title: 'Cleaning rota', body: 'Monday: corridors. Tuesday: offices. Wednesday: do NOT clean the {{ROOM_1}}. Thursday: see Wednesday.' },
  { title: 'Handwritten warning', body: 'IT HEARS ROOM NAMES. IT HEARS OUR NAMES. Use the code words. Say "kitchen" when you mean the vault. It does not know we do not have a kitchen.' },
  { title: 'Employee of the month', body: 'Congratulations to the night shift for zero recorded incidents this month. Records were lost in an incident.' },
  { title: 'Final memo', body: 'If you are reading this, the van is still waiting. It will not wait forever. It will wait until 04:00, which is close to forever, but not as close as you would like.' },
  { title: 'Torn page', body: 'The dog does not see. The dog does not need to see. Whisper. Crouch. Throw something and it will go and check. Good dog. Good dog. Please be a good dog.' },
  { title: 'Staff survey', body: 'Q7: Do you feel listened to at work? 100% of respondents answered "yes". 0% of respondents found this reassuring.' },
];

/** drive radio chatter (in order, typed out on the loading screen). {{SITE}} {{QUOTA}} {{HAULED}} {{CONTRACT}} */
export const DRIVE_CHATTER: readonly string[] = [
  'DISPATCH: Van 9, you are cleared for {{SITE}}. Do not stop for hitchhikers. Do not stop for anything.',
  'DISPATCH: Shift quota stands at {{QUOTA}} scrip. You have hauled {{HAULED}}. The Company believes in you, statistically.',
  'DISPATCH: The van cab is sealed. Talk freely in there. Everywhere else, assume an audience.',
  'DISPATCH: Vault code shows on the van console only. Somebody read it out. Quietly. Once.',
  'DISPATCH: Twin breakers. Pull them together. We will not explain this again. We have explained it every night.',
  'DISPATCH: The van leaves at 04:00, with or without you. Historically: without.',
  '[static] ...say again, Van 9? We have you at... [static] ...four of you? ...five? [static]',
  'DISPATCH: Contract {{CONTRACT}} of the shift. Drive safe. Salvage safer. Survive optional but encouraged.',
];

export function ruleCards(risk: number, mannequin: boolean): MetaRuleCard[] {
  return [
    {
      monster: 'hound',
      title: 'THE HOUND IS BLIND',
      rule: 'It ignores whispers and crouch-steps. When it growls, everyone FREEZE. A second noise nearby and it charges.',
      hint: 'Throw a bottle to send it elsewhere.',
    },
    {
      monster: 'listener',
      title: 'THE LISTENER UNDERSTANDS',
      rule: 'It hunts information, not noise: room names, player names, numbers and plans. It only grabs someone with no teammate within 8 m.',
      hint: risk >= 2 ? 'Lie to it. Verify every radio call.' : 'It listens quietly at first. Then it acts on what it heard.',
    },
    {
      monster: 'mannequin',
      title: mannequin ? 'THE MANNEQUIN MOVES UNSEEN' : 'MANNEQUIN: NOT REPORTED',
      rule: mannequin
        ? 'It is frozen while someone watches it AND it is lit. Your visor blinks; two watchers are safe, one is a gamble.'
        : 'No display figures reported on this site. If one is closer than it was, keep it lit and keep looking.',
      hint: mannequin ? 'Back away together. Glowsticks keep it lit.' : 'Risk 2 sites and every third contract: expect company.',
    },
  ];
}

// ---------------- HR: Company Performance Review (per shift) ----------------

export const REVIEW_RATINGS = {
  star: 'EXCEEDS EXPECTATIONS (SUSPICIOUSLY)',
  good: 'MEETS EXPECTATIONS',
  meh: 'MEETS EXPECTATIONS (BARELY)',
  bad: 'BELOW EXPECTATIONS',
  dead: 'DECEASED · STILL ON PAYROLL',
} as const;

/** {{NAME}} {{DEATHS}} {{SURVIVED}} {{LEVEL}} {{QUOTE}} {{HAUL}} */
export const MEMO_BODIES: Record<keyof typeof REVIEW_RATINGS, readonly string[]> = {
  star: [
    '{{NAME}} survived {{SURVIVED}} of {{CONTRACTS}} contracts without dying once, which the Company finds commendable and slightly unnerving. Please share your methods with the rest of the crew, quietly.',
    '{{NAME}} returned alive every time. Management has flagged this for review, because nobody does that. Keep up the work, and please stop making the rest of the crew look bad.',
  ],
  good: [
    '{{NAME}} completed the shift with acceptable losses (themselves: {{DEATHS}}). Attendance was good. Survival was mostly good. The Company is mostly pleased.',
    '{{NAME}} performed their duties. Their duties occasionally performed them back. Net assessment: fine. Do not let it go to your head; it already has enough in there.',
  ],
  meh: [
    '{{NAME}} died {{DEATHS}} times this shift. The Company would like to remind {{NAME}} that dying is not a break, and that breaks are unpaid anyway.',
    '{{NAME}} contributed to the shift in ways the Company is still trying to quantify. Mostly by being loud in corridors. Please consider a career in whispering.',
  ],
  bad: [
    '{{NAME}} died {{DEATHS}} times in {{CONTRACTS}} contracts. HR notes this is a personal best, and asks that it remain a personal best.',
    '{{NAME}} spent more of the shift deceased than alive. The Company has had chairs with better attendance. The chairs, to be fair, were also quieter.',
  ],
  dead: [
    '{{NAME}} did not survive any contract this shift. Their badge was very well travelled. The Company thanks {{NAME}} for their service and for the paperwork.',
  ],
};

/** quote framing; {{QUOTE}} is something the Listener overheard from this player */
export const QUOTE_LINES: readonly string[] = [
  'Exhibit A, as overheard by on-site personnel: "{{QUOTE}}". Please think before you transmit.',
  'Our listening partner on site particularly enjoyed: "{{QUOTE}}". So did HR.',
  'The following was logged by the facility, verbatim: "{{QUOTE}}". It has been added to your file and to the training video.',
];

export const NO_QUOTE_LINES: readonly string[] = [
  'The facility logged nothing useful from {{NAME}} all shift. Either excellent radio discipline or a broken microphone. HR is checking which.',
  'No recorded transmissions. The Company appreciates silence and is billing you for it.',
];

export const REVIEW_COMMENTS = {
  promoted: [
    'The crew met its quota of {{QUOTA}} scrip with {{HAUL}} hauled. Overtime bonus: {{OVERTIME}}. You are promoted to the next shift, which is the same as this shift but with a higher quota. Congratulations.',
    'Quota met: {{HAUL}} of {{QUOTA}}. The Company is delighted, in a measured, legally reviewed way. Your reward is more work. Next quota: {{NEXT}}.',
  ],
  fired: [
    'The crew hauled {{HAUL}} scrip against a quota of {{QUOTA}}. The Company has decided to explore other contractors. You are the other contractors now, somewhere else.',
    'Quota missed: {{HAUL}} of {{QUOTA}}. Your contracts are terminated, your gear is reclaimed, and your levels are, regrettably, still yours. See you next shift, new hires.',
  ],
} as const;

/** termination letter (one per crew); {{CREW}} {{NAMES}} {{HAUL}} {{QUOTA}} {{DATE}} */
export const TERMINATION_LETTERS: readonly string[] = [
  'Dear {{NAMES}},\n\nFollowing a review of your recent performance ({{HAUL}} of {{QUOTA}} scrip), the Company regrets to inform you that your services are no longer required, effective 04:01.\n\nPlease return your badges, your walkies and anything you may have heard. Your career levels and cosmetic privileges remain yours; the Company is many things but it is not petty about helmets.\n\nYou are welcome to reapply. You will be hired. You always are.\n\nWarm regards,\nHuman Resources\n(Night Division)',
  'To: Crew {{CREW}} ({{NAMES}})\nRe: Termination of Contract\n\nThe Company thanks you for your {{HAUL}} scrip. It needed {{QUOTA}}. The difference has been noted, framed and hung in the break room.\n\nYour run is reset. Your shift balance is reclaimed. Your levels are retained, as are your memories, though the Company would prefer you kept those to yourselves.\n\nThe van will take you home. The van does not take anyone home. It will take you to the start.\n\nSincerely,\nHR',
];
