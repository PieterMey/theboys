// Overlay root: HUD slots, current screen, toasts. Mounted into #overlay by main.ts.
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { ClientContext } from '../context.ts';
import { HUD_SLOTS } from './api.ts';
import type { HudSlot } from './api.ts';
import { JoinScreen } from './JoinScreen.tsx';

/** Re-render on discrete world changes (phase, crew, me, layout). */
export function useWorld(ctx: ClientContext): number {
  const [v, setV] = useState(ctx.world.version);
  useEffect(() => ctx.world.subscribe(() => setV(ctx.world.version)), [ctx]);
  return v;
}

function Slot({ ctx, slot }: { ctx: ClientContext; slot: HudSlot }) {
  const list = ctx.ui.huds.value.filter((h) => h.slot === slot);
  if (!list.length) return null;
  return (
    <div class={`hud-slot hud-${slot}`}>
      {list.map((h) => <h.comp key={h.id} ctx={ctx} />)}
    </div>
  );
}

function App({ ctx }: { ctx: ClientContext }) {
  const { name, props } = ctx.ui.screen.value;
  void ctx.ui.screensVersion.value;
  const Screen = ctx.ui.screens.get(name);
  return (
    <>
      {ctx.ui.hudVisible.value && (
        <div class="hud">
          {HUD_SLOTS.map((s) => <Slot key={s} ctx={ctx} slot={s} />)}
        </div>
      )}
      {Screen && (
        <div class={`screen screen-${name}`}>
          <Screen ctx={ctx} {...props} />
        </div>
      )}
      <div class="toasts">
        {ctx.ui.toasts.value.map((t) => <div key={t.id} class={`toast toast-${t.kind}`}>{t.text}</div>)}
      </div>
    </>
  );
}

export function mountUi(ctx: ClientContext, root: HTMLElement): void {
  ctx.ui.registerScreen('join', JoinScreen);
  render(<App ctx={ctx} />, root);
}
