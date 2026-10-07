// Owner: fieldguide (v1.2). All events are private to one player; page text only travels for owned pages.
import type { MonsterKind } from '../state.ts';

export interface FieldGuidePage { id: string; title: string; text: string }
export interface FieldGuideMonsterView {
  kind: MonsterKind;
  /** 0 unknown, 1 heard only, 2 seen */
  level: 0 | 1 | 2;
  name: string;
  card: string[];
  first?: { at: string; site: string; how: string };
  heard: number; seen: number; deaths: number; escapes: number;
  pages: FieldGuidePage[];
  pagesTotal: number;
}
export interface FieldGuideView {
  monsters: FieldGuideMonsterView[];
  anomalies: { kind: string; label: string; count: number }[];
  pagesFound: number;
  pagesTotal: number;
}
export interface FieldguideEvents {
  'fieldguide.state': FieldGuideView;
  'fieldguide.filed': { kind: MonsterKind | 'anomaly'; pageId?: string; title: string; n: number; of: number };
  'fieldguide.read': { spot: string; monster: MonsterKind; title: string; text: string };
  'fieldguide.open': { tab?: MonsterKind | 'anomalies' };
}
export interface FieldguideReqs {
  'fieldguide.get': { args: Record<string, never> | undefined; result: FieldGuideView };
}
