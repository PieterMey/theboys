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
  /** v1.2 additive: what it sounds like (level >= 1; empty while unknown) */
  sounds?: string[];
}
/** v1.2 additive: a hazard bulletin on the current site (lore spot id = the interactable's ref) */
export interface FieldGuideBulletinView {
  spot: string;
  monster: MonsterKind;
  /** monster display name for the frame ('THE HOUND') */
  name: string;
  /** you already filed this bulletin's page (or own every page of its monster): the frame is drawn dim */
  read: boolean;
}
export interface FieldGuideView {
  monsters: FieldGuideMonsterView[];
  anomalies: { kind: string; label: string; count: number }[];
  pagesFound: number;
  pagesTotal: number;
  /** v1.2 additive: bulletins on this site (contract only) */
  bulletins?: FieldGuideBulletinView[];
  /** v1.2 additive: how many anomaly kinds the Company recognises (ANOMALIES tab footer) */
  anomalyKinds?: number;
}
export interface FieldguideEvents {
  'fieldguide.state': FieldGuideView;
  /** v1.2 additive fields: name = monster / anomaly display name */
  'fieldguide.filed': { kind: MonsterKind | 'anomaly'; pageId?: string; title: string; n: number; of: number; name?: string };
  /** v1.2 additive fields: pageId shown, filed = this read put a new page in your booklet, n/of = that monster's pages */
  'fieldguide.read': { spot: string; monster: MonsterKind; title: string; text: string; pageId?: string; filed?: boolean; n?: number; of?: number; name?: string };
  'fieldguide.open': { tab?: MonsterKind | 'anomalies' };
}
export interface FieldguideReqs {
  'fieldguide.get': { args: Record<string, never> | undefined; result: FieldGuideView };
}
