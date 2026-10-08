// DEAD AIR client entry (integrator-owned): core context -> UI -> track installs (in order) -> loop.
import './core/ui/styles.css';
import { createClientContext } from './core/context.ts';
import type { ClientContext } from './core/context.ts';
import { fetchServerFlags } from './core/flags.ts';
import { mountUi } from './core/ui/App.tsx';
import { installTestApi } from './core/testapi.ts';
import { install as net } from './net/index.ts';
import { install as render } from './render/index.ts';
import { install as level } from './level/index.ts';
import { install as players } from './players/index.ts';
import { install as voice } from './voice/index.ts';
import { install as audio } from './audio/index.ts';
import { install as objectives } from './objectives/index.ts';
import { install as interaction } from './interaction/index.ts';
import { install as monsters } from './monsters/index.ts';
import { install as paranormal } from './paranormal/index.ts';
import { install as menu } from './menu/index.ts';
import { install as meta } from './meta/index.ts';
import { install as safes } from './safes/index.ts';
import { install as fieldguide } from './fieldguide/index.ts';
import { install as ai } from './ai/index.ts';
import { install as loading } from './loading/index.ts';

type Install = (ctx: ClientContext) => void | Promise<void>;
const TRACKS: [string, Install][] = [
  // menu first: it only registers the title screen over the bare 'join' screen (no flash while render inits)
  ['menu', menu], ['net', net], ['render', render], ['level', level], ['players', players], ['voice', voice], ['audio', audio],
  ['objectives', objectives], ['interaction', interaction], ['monsters', monsters], ['paranormal', paranormal], ['meta', meta],
  ['safes', safes], ['fieldguide', fieldguide], ['ai', ai],
  // v1.1 loading screen + telemetry: last, so its phase handlers run after meta's screen changes
  ['loading', loading],
];

// the server's live flags BEFORE any install (render/level/paranormal/fieldguide read them at install time); a
// failure or a 1.5 s timeout keeps the bundled copy
const ctx = createClientContext(await fetchServerFlags());
if (ctx.testMode) installTestApi(ctx);
mountUi(ctx, document.getElementById('overlay')!);

for (const [name, install] of TRACKS) {
  try {
    await install(ctx);
  } catch (e) {
    ctx.reportError(`install ${name} failed: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
  }
}
ctx.loop.start(ctx);
// ?autojoin=1 (tests/dev): join the crew in the URL hash without the Join screen
if (ctx.params.get('autojoin') === '1' && ctx.hashCrew) {
  ctx.audio.unlock();
  void ctx.net.join(ctx.hashCrew).then(() => ctx.ui.setScreen('none'), (e: unknown) => ctx.reportError(`autojoin: ${e}`));
}
