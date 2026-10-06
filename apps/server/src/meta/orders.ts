// Owner: track (d) Meta. Builds the van board: 3 TEMPLATE work orders from the handwritten pack (deterministic per crew/
// shift/board via makeRng). (e) may later swap AI-written text into history/memo/requests/notes (briefFor).
import { makeRng } from '@dead-air/shared/rng.ts';
import type { Rng } from '@dead-air/shared/rng.ts';
import type { ClueNote, CompanyRequest, CompanyRequestKind, WorkOrder } from '@dead-air/shared/workorder.ts';
import {
  CODE_A_NOTES, CODE_B_NOTES, FLAVOUR_NOTES, LEVER_NOTES, REQUEST_REWARD, REQUEST_TEXT, SITES,
} from './templates.ts';

export interface BoardInput {
  crewCode: string;
  shiftIndex: number;
  /** contract index within the shift (0-based) */
  contract: number;
  boardSeq: number;
  players: number;
  avgLevel: number;
  achievements: readonly string[];
  payoutMult: Record<string, number>;
  riskLootMult: Record<string, number>;
  playerMult: number;
  lootBudgetBase: number;
  risk2MinAvgLevel: number;
  risk2Achievement: string;
  /** site names used recently (avoid repeats) */
  recentSites: readonly string[];
}

export function risk2Available(avgLevel: number, achievements: readonly string[], minAvg: number, ach: string): boolean {
  return avgLevel >= minAvg || achievements.includes(ach);
}

function sizeFor(players: number): WorkOrder['size'] {
  return players <= 2 ? 'S' : players <= 4 ? 'M' : 'L';
}

function request(kind: CompanyRequestKind, rng: Rng, threshold: number): CompanyRequest {
  const [lo, hi] = REQUEST_REWARD[kind];
  const reward = Math.round((lo + rng.next() * (hi - lo)) / 5) * 5;
  const text = rng.pick(REQUEST_TEXT[kind]).replace('{{X}}', String(threshold));
  return kind === 'EXTRACT_ABOVE' ? { kind, param: threshold, reward, text } : { kind, reward, text };
}

function notesFor(rng: Rng): ClueNote[] {
  const notes: ClueNote[] = [
    { ...rng.pick(CODE_A_NOTES) },
    { ...rng.pick(CODE_B_NOTES) },
    { ...rng.pick(LEVER_NOTES) },
  ];
  const flav = rng.shuffle(FLAVOUR_NOTES.slice());
  const extra = rng.int(1, 3);
  for (let i = 0; i < extra; i++) notes.push({ ...flav[i] });
  // {{ROOM_1}} may appear at most once per order: keep only the first flavour note that uses it
  let used = false;
  return notes.filter((n) => {
    if (!n.body.includes('{{ROOM_1}}')) return true;
    if (used) return false;
    used = true;
    return true;
  });
}

/** 3 orders: Risk 1 (always), Risk 1 or 2 (always 1 while Risk 2 is locked), Risk 2 (needs crew avg level >= 2 or 'Core Business'). */
export function makeBoard(b: BoardInput): WorkOrder[] {
  const rng = makeRng(`${b.crewCode}|${b.shiftIndex}|${b.contract}|${b.boardSeq}`, 'board');
  const pool = SITES.filter((s) => !b.recentSites.includes(s.name));
  const sites = rng.shuffle((pool.length >= 3 ? pool : SITES).slice()).slice(0, 3);
  const mid: 1 | 2 = rng.chance(0.5) ? 1 : 2;
  const r2 = risk2Available(b.avgLevel, b.achievements, b.risk2MinAvgLevel, b.risk2Achievement);
  // a crew that cannot take Risk 2 yet still gets two choosable Risk-1 orders (the third shows what is coming)
  const risks: (1 | 2)[] = [1, r2 ? mid : 1, 2];
  return sites.map((site, i) => {
    const risk = risks[i];
    const ro = makeRng(`${b.crewCode}|${b.shiftIndex}|${b.contract}|${b.boardSeq}|${i}`, 'order');
    const loot = b.lootBudgetBase * (b.riskLootMult[String(risk)] ?? 1) * b.playerMult;
    const threshold = Math.max(100, Math.round((loot * (0.38 + ro.next() * 0.14)) / 10) * 10);
    const kinds: CompanyRequestKind[] = [ro.chance(0.5) ? 'ALL_SURVIVE' : 'EXTRACT_ABOVE'];
    if (ro.chance(0.6)) kinds.push('LURE_IT_WITH_A_LIE');
    else kinds.push(kinds[0] === 'ALL_SURVIVE' ? 'EXTRACT_ABOVE' : 'ALL_SURVIVE');
    const mannequin = risk >= 2 || b.contract >= 2;
    const modifiers = [...site.modifiers];
    if (mannequin && !modifiers.includes('MANNEQUINS LIKELY')) modifiers.push('MANNEQUIN');
    if (risk >= 2) modifiers.push('DARKER SITE');
    const seed = `${b.crewCode}-${b.shiftIndex}${b.contract}${i}-${ro.int(1000, 9999)}`;
    const order: WorkOrder = {
      id: `wo${b.boardSeq}-${i}-${seed}`,
      seed,
      risk,
      siteName: site.name,
      theme: 'facility',
      size: sizeFor(b.players),
      payoutMult: b.payoutMult[String(risk)] ?? 1,
      modifiers,
      requirements: risk >= 2 ? { minAvgLevel: b.risk2MinAvgLevel, achievement: b.risk2Achievement } : {},
      available: risk === 1 || r2,
      history: site.history,
      memo: site.memo,
      requests: kinds.map((k) => request(k, ro, threshold)),
      notes: notesFor(ro),
      source: 'template',
    };
    return order;
  });
}

/** re-evaluate availability (crew levels changed) */
export function refreshAvailability(orders: WorkOrder[], avgLevel: number, achievements: readonly string[], minAvg: number, ach: string): void {
  const r2 = risk2Available(avgLevel, achievements, minAvg, ach);
  for (const o of orders) o.available = o.risk === 1 || r2;
}

/** substitute {{...}} placeholders (exported for (a) objectives via meta/api.ts) */
export function fillPlaceholders(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
}
