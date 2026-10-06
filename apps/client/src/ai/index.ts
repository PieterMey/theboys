// Owner: track (e) AI + speech (apps/client/src/ai/**). Client plugin entry:
//  - everyone: the Listener's voiced radio lures ('ai.lure' -> walkie / intercom radio chain, lure.ts)
//  - host only: the AI status line (hud.tsx)
// Everything AI/speech runs on the server.
import type { ClientContext } from '../core/context.ts';
import { AiStatusHud, aiStatusSig } from './hud.tsx';
import { installLure } from './lure.ts';

export function install(ctx: ClientContext): void {
  installLure(ctx);
  const admin = ctx.net.adminToken();
  const forced = ctx.params.get('aistatus') === '1';
  if (!admin && !forced) return; // friends never see it
  ctx.ui.registerHud('top-right', AiStatusHud, { order: 90, id: 'ai-status' });
  let failures = 0;
  const poll = async () => {
    if (ctx.net.status === 'joined') {
      try {
        aiStatusSig.value = await ctx.net.req('ai.status', { admin: admin ?? undefined }, 3000);
        failures = 0;
      } catch {
        failures++;
        if (failures >= 3) aiStatusSig.value = null; // not the host (prod) or server without the ai track
      }
    }
    setTimeout(() => void poll(), failures >= 10 ? 15_000 : 2000);
  };
  void poll();
}
