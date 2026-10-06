// Owner: track (b) Interaction. TEST-ONLY resilient client entry (/src/interaction/dev.html): same boot order as
// apps/client/src/main.ts, but every track is a guarded dynamic import, so one track's mid-edit module (404 /
// syntax error) doesn't take the whole client down while P1/P2 land in parallel. Never used by the real game.
import '../core/ui/styles.css';
import { createClientContext } from '../core/context.ts';
import type { ClientContext } from '../core/context.ts';
import { mountUi } from '../core/ui/App.tsx';
import { installTestApi } from '../core/testapi.ts';

type Install = (ctx: ClientContext) => void | Promise<void>;
type Mod = { install: Install };
const TRACKS: [string, () => Promise<Mod>][] = [
  ['net', () => import('../net/index.ts')],
  ['render', () => import('../render/index.ts')],
  ['level', () => import('../level/index.ts')],
  ['players', () => import('../players/index.ts')],
  ['voice', () => import('../voice/index.ts')],
  ['audio', () => import('../audio/index.ts')],
  ['objectives', () => import('../objectives/index.ts')],
  ['interaction', () => import('./index.ts')],
  ['monsters', () => import('../monsters/index.ts')],
  ['meta', () => import('../meta/index.ts')],
  ['ai', () => import('../ai/index.ts')],
];

const ctx = createClientContext();
if (ctx.testMode) installTestApi(ctx);
mountUi(ctx, document.getElementById('overlay')!);
const mods = await Promise.all(TRACKS.map(async ([name, load]) => {
  try {
    return [name, await load()] as const;
  } catch (e) {
    console.warn(`[devmain] track ${name} failed to load: ${e instanceof Error ? e.message : e}`);
    return [name, null] as const;
  }
}));
for (const [name, mod] of mods) {
  if (!mod) continue;
  try {
    await mod.install(ctx);
  } catch (e) {
    ctx.reportError(`install ${name} failed: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
  }
}
(ctx.diag as Record<string, unknown>).devmainLoaded = mods.filter(([, m]) => !!m).map(([n]) => n);
ctx.loop.start(ctx);
if (ctx.params.get('autojoin') === '1' && ctx.hashCrew) {
  ctx.audio.unlock();
  void ctx.net.join(ctx.hashCrew).then(() => ctx.ui.setScreen('none'), (e: unknown) => ctx.reportError(`autojoin: ${e}`));
}
