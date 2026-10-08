// Owner: track (c) Monsters (v1.2 G2). The Listener's crouch sight + prop cover (flag listenerFairV12), ws bots only:
//  - lit (flashlight on) and crouched: seen at 3 m, not at 4 m (6 m x crouchSightMult 0.6 = 3.6 m); standing: seen at 4 m
//  - crouched right behind a low solid prop (desk, table, counter, pew...: PROP_DEFS h 0.75-1.25) within 2.5 m: never
//    seen; standing behind the same prop: seen; crouched behind a crate (h 0.35): still seen
//  - (v1.2 extra) a tall prop (h >= 1.7, shelves / racks) between it and a standing player hides them
//   node tests/monsters/listener-crouch.e2e.ts        (own dev server on PORT, default 3802)
import { PROP_DEFS } from '../../packages/shared/src/procgen/decor.ts';
import { cellOf, los } from '../../packages/shared/src/nav/index.ts';
import { Bot, sleep, startServer } from './bot.ts';
import { cabSpot, check, contract, freeOfSolids, findLine, park, placeListener, r2, serverErrors, summary, tp } from './fairlib.ts';
import type { World } from './fairlib.ts';

const PORT = Number(process.env.PORT ?? 3802);
const srv = await startServer(PORT);
const url = `ws://127.0.0.1:${PORT}/ws`;
const A = new Bot('Ann'), B = new Bot('Bob');

const STAND = 0, CROUCH = 1;

/** the Listener (fresh, watching) at S facing P; A at P with the given stance + flashlight; spotted within ms? */
async function seenAt(w: World, S: [number, number], P: [number, number], stance: number, ms = 1300): Promise<boolean> {
  await park(A);
  await tp(A, P[0], P[1], { stance, light: 1, yaw: Math.atan2(S[0] - P[0], S[1] - P[1]) + Math.PI });
  await sleep(120);
  const t0 = performance.now();
  await placeListener(A, S[0], S[1], P[0], P[1]);
  const deadline = t0 + ms;
  while (performance.now() < deadline) {
    if (A.eventsOf('monsters.spotted', t0).length) { await park(A); await sleep(3200); return true; } // noticeCooldownSec
    await sleep(40);
  }
  await park(A);
  return false;
}

interface CoverSpot { key: string; h: number; S: [number, number]; P: [number, number]; d: number }

/** viewer S and target P on opposite sides of a solid prop of `keys`, target within 0.5 m of the prop edge */
function coverSpots(w: World, keys: (k: string, h: number) => boolean, maxD: number): CoverSpot[] {
  const out: CoverSpot[] = [];
  for (const it of w.L.items) {
    if (it.kind !== 'prop' || it.data?.solid !== true) continue;
    const key = String(it.data.prop ?? '');
    const h = Number(it.data.h ?? PROP_DEFS[key]?.h ?? NaN);
    if (!keys(key, h)) continue;
    const wd = Number(it.data.w ?? 0), dp = Number(it.data.d ?? 0);
    const rot = it.rot ?? 0;
    const alongX = Math.abs(Math.round(rot / (Math.PI / 2))) % 2 === 0;
    const hx = (alongX ? wd : dp) / 2, hz = (alongX ? dp : wd) / 2;
    for (const [ax, az, half] of [[1, 0, hx], [-1, 0, hx], [0, 1, hz], [0, -1, hz]] as const) {
      const P: [number, number] = [it.x + ax * (half + 0.42), it.z + az * (half + 0.42)];
      for (const back of [maxD - 2 * half - 0.42, maxD - 2 * half - 0.9]) {
        if (back < 0.5) continue;
        const S: [number, number] = [it.x - ax * (half + back), it.z - az * (half + back)];
        const ok = (q: [number, number]) => {
          const c = cellOf(w.g, q[0], q[1]);
          return c >= 0 && w.g.owner[c] >= 0 && w.L.spaces[w.g.owner[c]]?.kind !== 'outside' && freeOfSolids(w, q[0], q[1], 0.3);
        };
        if (!ok(P) || !ok(S) || !los(w.g, S[0], S[1], P[0], P[1], w.open)) continue;
        out.push({ key, h, S, P, d: Math.hypot(P[0] - S[0], P[1] - S[1]) });
        break;
      }
    }
  }
  return out;
}

try {
  const w = await contract(url, 'LCRCH', [A, B], 'g2-crouch-1', 2, 1);
  const [cx, cz] = cabSpot(w);
  await tp(B, cx, cz); // out of the way (sealed van cab): A is alone
  const line = findLine(w, 4);
  check('found an open 4 m sight line', !!line, line ? `${line.S} -> ${line.P}` : '');
  if (line) {
    const at = (m: number): [number, number] => [line.S[0] + line.dir[0] * m, line.S[1] + line.dir[1] * m];
    check('lit + crouched at 3 m: seen (3.6 m crouch range)', await seenAt(w, line.S, at(3), CROUCH));
    check('lit + crouched at 4 m: NOT seen', !(await seenAt(w, line.S, at(4), CROUCH)));
    check('lit + standing at 4 m: seen (unchanged 6 m)', await seenAt(w, line.S, at(4), STAND));
  }
  const low = coverSpots(w, (k, h) => h >= 0.75 && h <= 1.25, 3.3);
  const pref = ['desk', 'table', 'counter', 'pew', 'workbench', 'bed_frame', 'altar'];
  low.sort((a, b) => (pref.includes(a.key) ? pref.indexOf(a.key) : 99) - (pref.includes(b.key) ? pref.indexOf(b.key) : 99));
  const lowSpot = low[0];
  check('found a low solid prop (desk / table / counter / pew...) with spots across it', !!lowSpot, lowSpot ? `${lowSpot.key} h ${lowSpot.h}, ${r2(lowSpot.d)} m` : `${low.length}`);
  if (lowSpot) {
    check(`crouched right behind the ${lowSpot.key} (within 2.5 m): never seen`, !(await seenAt(w, lowSpot.S, lowSpot.P, CROUCH, 1800)));
    check(`standing behind the ${lowSpot.key}: seen`, await seenAt(w, lowSpot.S, lowSpot.P, STAND));
  }
  const crates = coverSpots(w, (k) => k === 'crate', 3.0);
  const crate = crates[0];
  check('found a crate with spots across it', !!crate, crate ? `${r2(crate.d)} m` : '');
  if (crate) check('crouched behind a crate (h 0.35): still seen', await seenAt(w, crate.S, crate.P, CROUCH));
  const tall = coverSpots(w, (_k, h) => h >= 1.7, 4.5);
  const tallSpot = tall[0];
  if (tallSpot) check(`standing behind a tall ${tallSpot.key} (h ${tallSpot.h}): not seen (tall cover)`, !(await seenAt(w, tallSpot.S, tallSpot.P, STAND, 1600)));
  else console.log('  (no tall prop with free spots on both sides in this layout: tall-cover check skipped)');
  const errs = serverErrors(srv.log());
  check('no server errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
  check('run', false, e instanceof Error ? e.stack ?? e.message : String(e));
} finally {
  A.close();
  B.close();
  await srv.stop();
}
process.exitCode = summary('Listener crouch + cover');
setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
