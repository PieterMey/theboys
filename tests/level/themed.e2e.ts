// Env-layout (v1.2): ws-bot e2e against a dev server. dbg.level.generate with a site theme + work-order modifiers
// switches the crew into a themed contract: the summary and the layout the client receives carry L.theme and
// metrics['mod:<slug>'], the van stations are real (not virtual), containers / lore / mirrors derive on the client side
// exactly as on the server; dbg.level.hub returns the hub with its van mirror and records board.
// Run (dev server first): PORT=3811 NODE_ENV=development AI_MODE=mock SAVES_DIR=<scratch>/saves SESSION_FILE=<scratch>/session.json
//   node apps/server/src/index.ts   then   BASE_URL=http://127.0.0.1:3811 node tests/level/themed.e2e.ts
import { connectBot } from '../bots/bot-client.ts';
import { stationsOf } from '../../packages/shared/src/procgen/van.ts';
import { containersOf } from '../../packages/shared/src/procgen/containers.ts';
import { loreSpotsOf } from '../../packages/shared/src/procgen/lore.ts';
import { mirrorsOf } from '../../packages/shared/src/procgen/mirrors.ts';
import { floorSurface } from '../../packages/shared/src/procgen/themes.ts';
import { generateFacility, verifyLayoutHash } from '../../packages/shared/src/procgen/index.ts';
import { loadTuning } from '../../tools/gen-cli.ts';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3811';
const WS = BASE.replace(/^http/, 'ws') + '/ws';
const CREW = `TH${'BCDFGHJKLM'[Math.floor(Date.now() / 1000) % 10]}${'BCDFGHJKLM'[Math.floor(Date.now() / 10000) % 10]}`;
let fails = 0;
const check = (step: string, ok: boolean, info?: unknown) => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step}${info !== undefined ? ` :: ${JSON.stringify(info)}` : ''}`);
};

const bot = await connectBot({ url: WS, crew: CREW, name: 'ThemeBot' });
try {
  check('welcome: hub layout', bot.layout?.kind === 'hub', bot.layout?.kind);
  const hubSt = stationsOf(bot.layout!);
  check('hub: real stations incl. records board + van mirror', ['records', 'mirror', 'workbench', 'stash', 'booklet', 'charger'].every((k) => hubSt.some((s) => s.kind === k && !s.virtual)), hubSt.map((s) => `${s.kind}${s.virtual ? '?' : ''}`));
  for (const [theme, modifiers, players] of [['cold_storage', ['COLD', 'LONG CORRIDORS'], 4], ['hospital', ['DARK WARDS'], 2], ['records', ['MAZE', 'DARK'], 6]] as const) {
    const seed = `e2e-${theme}`;
    const phase = bot.waitEvent('phase', (d) => d.state.layout?.kind === 'facility', 20000);
    const sum = await bot.dbg('level.generate', { seed, players, risk: 1, theme, modifiers: [...modifiers] }, 30000) as { theme?: string; hash: string; errors: string[]; metrics: Record<string, number>; genMs: number };
    await phase;
    const L = bot.layout!;
    check(`${theme}: summary theme + no invariant errors`, sum.theme === theme && sum.errors.length === 0, { theme: sum.theme, errors: sum.errors, genMs: sum.genMs });
    const slugs = theme === 'cold_storage' ? ['cold', 'long'] : theme === 'hospital' ? ['dark'] : ['maze', 'dark'];
    check(`${theme}: metrics mod:*`, slugs.every((sl) => L.metrics[`mod:${sl}`] === 1 || L.metrics.attempt >= 13), Object.keys(L.metrics).filter((k) => k.startsWith('mod:')));
    check(`${theme}: client layout = summary (hash verifies)`, L.hash === sum.hash && L.theme === theme && verifyLayoutHash(L), { hash: L.hash });
    // the server used config/balance/level.json: the same request generates the same layout locally
    const local = generateFacility({ seed, players, risk: 1, theme, modifiers: [...modifiers] }, loadTuning());
    check(`${theme}: server layout = local generation`, local.hash === L.hash, { local: local.hash, server: L.hash });
    const st = stationsOf(L);
    check(`${theme}: van stations real`, ['console', 'leave_lever', 'deposit', 'workbench', 'stash', 'booklet', 'charger', 'mirror'].every((k) => st.some((s) => s.kind === k && !s.virtual)));
    const C = containersOf(L), lore = loreSpotsOf(L), mir = mirrorsOf(L);
    check(`${theme}: containers / lore / mirrors derive`, C.length >= 5 && lore.length >= 4 && mir.length >= 3, { containers: C.length, lore: lore.length, mirrors: mir.length });
    const floors = [...new Set(L.spaces.map((s) => floorSurface(L, s.id)))];
    check(`${theme}: themed floors`, floors.length >= 3, floors);
  }
  const back = bot.waitEvent('phase', (d) => d.state.layout?.kind === 'hub', 20000);
  await bot.dbg('level.hub', {});
  await back;
  check('back to the hub', bot.layout?.kind === 'hub' && mirrorsOf(bot.layout!).length === 1);
} finally {
  bot.close();
}
console.log(fails ? `FAILED ${fails}` : 'ALL PASS');
process.exit(fails ? 1 : 0);
