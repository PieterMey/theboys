// Owner: menu track (apps/client/src/menu/**). Main menu / title screen shown on load before joining:
// PLAY (the core Join panel), CHARACTER (local profile editor -> hello), SETTINGS / HOW TO PLAY / CREDITS (meta's
// components), HOST (invite link, admin token only). It replaces the 'join' screen registration, so the screen name
// stays 'join' (meta / net / players logic that checks for 'join' is unchanged). ?autojoin=1 skips it entirely.
import './menu.css';
import { effect } from '@preact/signals';
import type { ClientContext } from '../core/context.ts';
import { SYS } from '../core/loop.ts';
import { MainMenu, menuView } from './MainMenu.tsx';
import { menuStatic } from './sound.ts';
import { hashCode } from '../core/ui/JoinScreen.tsx';

export function install(ctx: ClientContext): void {
  // tests / dev: ?autojoin=1 keeps the bare core Join screen (no title menu, no ambience)
  if (ctx.params.get('autojoin') === '1') return;
  ctx.ui.registerScreen('join', MainMenu);
  // invite link (#CODE): open straight onto the PLAY panel, code pre-filled, JOIN CREW focused (Enter joins)
  if (hashCode()) menuView.value = 'play';

  // "menu session" = before the first welcome, or after leaving the crew (pause menu -> LEAVE -> 'join')
  let menuSession = true;
  ctx.bus.on('net:welcome', () => { menuSession = false; });

  let last = ctx.ui.screen.value.name;
  effect(() => {
    const name = ctx.ui.screen.value.name;
    if (name === last) return;
    const prev = last;
    last = name;
    if (name === 'join') {
      if (ctx.net.status !== 'joined') menuSession = true;
      ctx.ui.hudVisible.value = false;
      return;
    }
    // a pre-join sub-screen (e.g. meta's brightness check from SETTINGS) closed to 'none': back to the menu
    if (name === 'none' && menuSession && ctx.net.status !== 'joined') {
      queueMicrotask(() => ctx.ui.setScreen('join', { view: menuView.value }));
      return;
    }
    if (prev === 'join') {
      ctx.ui.hudVisible.value = true;
      if (!menuSession) {
        menuStatic(ctx, 0);
        menuView.value = 'title';
        if (name === 'none') fadeIn();
      }
    }
  });
  if (ctx.ui.screen.value.name === 'join') ctx.ui.hudVisible.value = false;
  // the title menu owns the whole screen: keep the HUD layer hidden under it (meta's per-frame HUD toggle can
  // re-show it after a pre-join brightness check)
  ctx.registerSystem({
    name: 'menu',
    order: SYS.ui + 5,
    update() {
      if (menuSession && ctx.ui.screen.value.name === 'join' && ctx.ui.hudVisible.value) ctx.ui.hudVisible.value = false;
    },
  });
}

/** black -> scene fade after the menu closes into the game (own DOM node, removed when done) */
function fadeIn(): void {
  const el = document.createElement('div');
  el.className = 'mm-fadein';
  document.body.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
  setTimeout(() => el.remove(), 3000);
}
