// FROZEN CONTRACT (P0): work orders (contracts) shown on the van board.

export type CompanyRequestKind = 'ALL_SURVIVE' | 'EXTRACT_ABOVE' | 'LURE_IT_WITH_A_LIE';

export interface CompanyRequest {
  kind: CompanyRequestKind;
  /** e.g. EXTRACT_ABOVE threshold */
  param?: number;
  reward: number;
  /** flavour text (template or AI) */
  text: string;
}

export interface ClueNote {
  /** layout note slot id this goes into (filled at mission start) */
  slot?: string;
  title: string;
  /** body text; may contain resolved secrets (never sent to the AI with real values) */
  body: string;
}

export interface WorkOrder {
  id: string;
  seed: string;
  risk: 1 | 2 | 3;
  siteName: string;
  theme: 'facility';
  size: 'S' | 'M' | 'L';
  payoutMult: number;
  modifiers: string[];
  requirements: { minAvgLevel?: number; achievement?: string };
  /** true if the crew currently meets the requirements */
  available: boolean;
  history: string;
  memo: string;
  requests: CompanyRequest[];
  notes: ClueNote[];
  source: 'template' | 'ai';
}
