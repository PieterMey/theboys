// Owner: meta-records (v1.2). Read paths of the PERSONNEL FILE:
//   - 'meta.stats' {saveId?}: your own file, or a crewmate's when you share a crew
//   - GET /api/stats with the header x-deadair-key (the browser player key; main menu, before joining). The key is
//     never in the URL and never logged; Cache-Control no-store.
// Counters and ids only: saves never hold transcripts.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PlayerSave } from '@dead-air/shared/saves.ts';
import { emptyStats } from '@dead-air/shared/progress.ts';
import type { CollectionEntry, StatsHeadline, StatsReply } from '@dead-air/shared/progress.ts';
import { collectionCatalog } from '@dead-air/shared/messages/meta.ts';
import type { SaveStore } from './saves.ts';
import { collectionCount } from './stats.ts';
import { safeName } from './safety.ts';

export const STATS_KEY_HEADER = 'x-deadair-key';
const MAX_CREWS = 8;

function headline(sv: PlayerSave): StatsHeadline {
  const st = sv.stats;
  return {
    saveId: sv.id, name: safeName(sv.name, sv.id).name, badge: sv.profile?.badge ?? 0, level: sv.level, contracts: st?.contracts ?? 0,
    lootValue: st?.lootValue ?? 0, deaths: st?.deaths ?? 0, revivesGiven: st?.revivesGiven ?? 0, collection: collectionCount(sv),
  };
}

/**
 * The personnel file of `subject`. `viewer` = the asking save: someone else's file only lists the crews both share and
 * drops the crew codes from their collection entries.
 */
export function statsReply(store: SaveStore, subject: PlayerSave | null, viewer: string | null = subject?.id ?? null): StatsReply {
  const collectionSize = collectionCatalog().length;
  if (!subject) return { you: null, crews: [], collectionSize };
  const own = viewer === subject.id;
  const shared = own ? null : new Set(viewer ? store.crewsOf(viewer) : []);
  const collection: Record<string, CollectionEntry> = {};
  for (const [k, e] of Object.entries(subject.collection ?? {})) collection[k] = own ? { ...e } : { at: e.at, site: e.site, crew: '' };
  const crews = store.crewsOf(subject.id)
    .filter((code) => !shared || shared.has(code))
    .map((code) => store.crew(code))
    .filter((c): c is NonNullable<typeof c> => !!c)
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    .slice(0, MAX_CREWS)
    .map((c) => ({
      code: c.code,
      members: (c.members ?? []).map((id) => store.playerById(id)).filter((x): x is PlayerSave => !!x).map(headline),
      records: c.records ?? null,
    }));
  return {
    you: {
      saveId: subject.id, name: safeName(subject.name, subject.id).name, badge: subject.profile?.badge ?? 0, level: subject.level, xp: subject.xp,
      achievements: [...(subject.achievements ?? [])], stats: subject.stats ?? emptyStats(subject.createdAt ?? new Date().toISOString()), collection,
    },
    crews,
    collectionSize,
  };
}

/** may `viewer` read `target`'s file? (same save, or a crew both are members of) */
export function canRead(store: SaveStore, viewer: string, target: string, liveCrewSaves: readonly string[] = []): boolean {
  if (viewer === target) return true;
  if (liveCrewSaves.includes(viewer) && liveCrewSaves.includes(target)) return true;
  const mine = new Set(store.crewsOf(viewer));
  return store.crewsOf(target).some((c) => mine.has(c));
}

/** GET /api/stats handler (registerHttpRoute). 401 without the header; you:null for a key with no save yet. */
export function statsRoute(store: SaveStore): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', STATS_KEY_HEADER);
    const raw = req.headers[STATS_KEY_HEADER];
    const key = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
    if (!key || key.length > 200) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: `missing ${STATS_KEY_HEADER} header` }));
      return;
    }
    const sv = store.playerByKey(key);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(JSON.stringify(statsReply(store, sv)));
  };
}
