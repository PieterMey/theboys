// Owner: meta-records (v1.2). Stats + collection-log recorder. Keep recordStat's signature. Counters only.
import type { Crew } from '../core/types.ts';

/** add n to pid's counter this contract: a numeric PlayerStatsV1 key, 'itemsUsed.<type>' or 'killedBy.<KILLER>';
 *  buffered, committed in finishContract; unknown keys ignored */
export function recordStat(_crew: Crew, _pid: string, _key: string, _n = 1): void {}
