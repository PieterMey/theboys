// Owner: fieldguide (v1.2). Smoke: boot, hub shelf registered from the tick (first hub, no phase hook), state on join.
import { Bot, check, crewCode, sleep, startServer } from './lib.ts';
import type { FgDbgState } from './lib.ts';

const srv = await startServer({ dir: process.env.FG_DIR });
const bots: Bot[] = [];
try {
  const code = crewCode();
  const a = new Bot('Ann');
  bots.push(a);
  await a.connect(srv.ws, code);
  await sleep(600);
  const st = await a.dbg<FgDbgState>('fieldguide.state');
  console.log(JSON.stringify({ key: st.key, shelf: st.shelf, persisted: st.persisted }));
  check(st.shelf && st.shelf.id.startsWith('fg:'), 'hub shelf interactable registered in the first hub');
  check(!!a.ix.ints[st.shelf!.id] && a.ix.ints[st.shelf!.id]!.kind === 'fieldguide', 'client mirror has the shelf (kind fieldguide)');
  check(a.of('fieldguide.state').length >= 1, 'fieldguide.state pushed after join');
  const v = await a.req<{ monsters: { kind: string; level: number; name: string }[]; pagesTotal: number }>('fieldguide.get');
  check(v.monsters.length === 4 && v.monsters.every((m) => m.level === 0 && m.name === '???'), 'fresh booklet: 4 unknown monsters');
  check(v.pagesTotal === 19, 'pagesTotal 19');
  console.log('SMOKE OK');
} catch (e) {
  console.error(e);
  console.error(srv.log().slice(-4000));
  process.exitCode = 1;
} finally {
  for (const b of bots) b.close();
  await srv.stop();
}
