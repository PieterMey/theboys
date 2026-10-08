// Owner: workshop (v1.2). Registers 'workbench', handles meta.open {screen:'workbench'}, syncs level.setVanUpgrades.
import './workbench.css';
import type { ClientContext } from '../core/context.ts';
import type { EventPayload } from '@dead-air/shared/messages/index.ts';
import { VAN_UPGRADES } from '@dead-air/shared/catalog.ts';
import type { LevelService } from '../level/index.ts';
import type { LevelServiceV12 } from '../level/api.ts';
import { WorkbenchScreen } from './workbench.tsx';
import { openScreen } from './nav.ts';
import { metaOf } from './state.ts';

type LevelLike = LevelService & Partial<LevelServiceV12>;

export function installWorkshop(ctx: ClientContext): void {
  ctx.ui.registerScreen('workbench', WorkbenchScreen);

  // server-side interactables (E at the van workbench / crew locker) open the screen on a tab
  ctx.net.on('meta.open', (d: EventPayload<'meta.open'>) => {
    if (d.screen !== 'workbench') return;
    const props = { ...(d.props ?? {}) };
    if (ctx.ui.screen.value.name === 'workbench') ctx.ui.setScreen('workbench', props); // switch tab in place
    else openScreen(ctx, 'workbench', props);
  });

  // van upgrade parts follow MetaState.unlocks (world changes, and every level rebuild re-creates the van)
  let applied: string | null = null;
  const level = (): LevelLike | undefined => ctx.services.use('level') as LevelLike | undefined;
  const sync = (force = false): void => {
    const lv = level();
    if (!lv?.setVanUpgrades) return;
    const ok = new Set<string>(VAN_UPGRADES);
    const ids = (metaOf(ctx)?.unlocks ?? []).filter((x) => ok.has(x)).sort();
    const key = ids.join(',');
    if (!force && key === applied) return;
    try {
      lv.setVanUpgrades(ids);
      applied = key;
    } catch (e) {
      ctx.reportError(`workshop setVanUpgrades: ${e instanceof Error ? e.message : e}`);
    }
  };
  ctx.world.subscribe(() => sync());
  void ctx.services.wait('level').then((lv) => {
    lv.onRebuild(() => sync(true));
    sync(true);
  });

  if (ctx.testMode) {
    (window as unknown as { __workshop?: unknown }).__workshop = {
      open: (tab = 'craft') => openScreen(ctx, 'workbench', { tab }),
      unlocks: () => metaOf(ctx)?.unlocks ?? null,
      stash: () => metaOf(ctx)?.stash ?? null,
      applied: () => applied,
      sync: () => sync(true),
    };
  }
}
