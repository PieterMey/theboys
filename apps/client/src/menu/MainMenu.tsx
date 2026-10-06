// Owner: menu track. The title screen: DEAD AIR logo over the live 3D backdrop, a keyboard/mouse menu on the left,
// sub-panels on the right (PLAY = the core Join panel, CHARACTER, SETTINGS, HOW TO PLAY, CREDITS, HOST).
import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { ScreenProps } from '../core/ui/api.ts';
import { JoinScreen, hashCode } from '../core/ui/JoinScreen.tsx';
import { PROTOCOL_VERSION } from '@dead-air/shared/envelope.ts';
import { CreditsTab, HowToTab } from '../meta/menus.tsx';
import { onSettings, settings } from '../meta/state.ts';
import { CharacterPanel, HostPanel, SettingsPanel } from './panels.tsx';
import { menuGesture, uiSound } from './sound.ts';

export type MenuView = 'title' | 'play' | 'character' | 'settings' | 'howto' | 'credits' | 'host';

/** current sub-view (kept across a pre-join detour, e.g. meta's brightness check) */
export const menuView = signal<MenuView>('title');

interface Item { id: MenuView; label: string; hint: string; kicker: string; heading: string }

const ITEMS: Item[] = [
  { id: 'play', label: 'Play', hint: 'Clock in with your crew', kicker: 'CREW ASSIGNMENT · CLOCK IN', heading: 'Clock in' },
  { id: 'character', label: 'Character', hint: 'Suit · helmet · visor', kicker: 'CONTRACTOR FILE · APPEARANCE', heading: 'Look the part' },
  { id: 'settings', label: 'Settings', hint: 'Video · audio · controls', kicker: 'EQUIPMENT CHECK', heading: 'Settings' },
  { id: 'howto', label: 'How to play', hint: 'Read before your first shift', kicker: 'COMPANY ORIENTATION · MANDATORY', heading: 'How to play' },
  { id: 'credits', label: 'Credits', hint: 'Sounds · assets · crew', kicker: 'CREDITS · ATTRIBUTION', heading: 'Credits' },
];
const HOST_ITEM: Item = { id: 'host', label: 'Host', hint: 'Invite link for your friends', kicker: 'HOST TERMINAL · THIS PC RUNS THE SERVER', heading: 'Host' };

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const loop = () => { setNow(new Date()); t = setTimeout(loop, 1000); };
    t = setTimeout(loop, 1000);
    return () => clearTimeout(t);
  }, []);
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return <span class="mm-clock">LOCAL {hh}<i>:</i>{mm} · SHIFT STARTS 22:00</span>;
}

function BuildLine({ ctx }: { ctx: ScreenProps['ctx'] }) {
  const [, setT] = useState(0);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const loop = () => { setT((x) => x + 1); if (!ctx.services.use('three')) t = setTimeout(loop, 500); };
    t = setTimeout(loop, 500);
    return () => clearTimeout(t);
  }, []);
  const be = ctx.services.use('three')?.backend;
  return <span>BUILD {ctx.build.toUpperCase()} · PROTOCOL {PROTOCOL_VERSION} · {be ? `${be.toUpperCase()} RENDERER` : 'RENDERER STARTING'}</span>;
}

function useCalm(): boolean {
  const [calm, setCalm] = useState(() => settings().reduceFlicker);
  useEffect(() => onSettings(() => setCalm(settings().reduceFlicker)), []);
  return calm;
}

export function MainMenu({ ctx, view: viewProp }: ScreenProps) {
  const view = menuView.value;
  const setView = (v: MenuView) => { menuView.value = v; };
  const [entering, setEntering] = useState(false);
  const calm = useCalm();
  const invite = hashCode();
  const host = !!ctx.net.adminToken();
  const items = host ? [...ITEMS, HOST_ITEM] : ITEMS;
  const navRef = useRef<HTMLElement>(null);
  const lastItem = useRef<MenuView>('play');

  useEffect(() => {
    if (typeof viewProp === 'string' && viewProp) menuView.value = viewProp as MenuView;
  }, [viewProp]);

  // focus: PLAY by default (the invite case), the item we came back from otherwise
  useEffect(() => {
    if (view !== 'title') return;
    const el = navRef.current?.querySelector<HTMLButtonElement>(`[data-view="${lastItem.current}"]`) ?? navRef.current?.querySelector<HTMLButtonElement>('.mm-item');
    el?.focus({ preventScroll: true });
  }, [view]);

  const open = (v: MenuView) => {
    uiSound(ctx, 'select');
    lastItem.current = v;
    setView(v);
  };
  const back = () => {
    uiSound(ctx, 'back');
    setView('title');
  };
  const hover = () => uiSound(ctx, 'hover');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (entering) return;
      if (e.key === 'Escape') {
        if (menuView.value !== 'title') {
          e.preventDefault();
          back();
        }
        return;
      }
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
      if (typing) return;
      const nav = navRef.current;
      if (!nav) return;
      const up = e.key === 'ArrowUp' || e.code === 'KeyW';
      const down = e.key === 'ArrowDown' || e.code === 'KeyS';
      if (!up && !down) return;
      const list = [...nav.querySelectorAll<HTMLButtonElement>('.mm-item')];
      if (!list.length) return;
      const i = list.indexOf(document.activeElement as HTMLButtonElement);
      if (i < 0 && menuView.value !== 'title') return; // arrows inside a sub-panel (sliders, selects) stay there
      e.preventDefault();
      const next = list[(i < 0 ? 0 : i + (down ? 1 : -1) + list.length) % list.length];
      next.focus();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [entering]);

  const cur = items.find((i) => i.id === view) ?? null;
  let body: ComponentChildren = null;
  if (view === 'play') {
    body = <JoinScreen ctx={ctx} embedded onBack={back} onHover={hover} onEntering={() => { setEntering(true); uiSound(ctx, 'select'); }} />;
  } else if (view === 'character') body = <CharacterPanel ctx={ctx} />;
  else if (view === 'settings') body = <SettingsPanel ctx={ctx} />;
  else if (view === 'howto') body = <HowToTab />;
  else if (view === 'credits') body = <CreditsTab />;
  else if (view === 'host') body = <HostPanel ctx={ctx} />;

  return (
    <div
      class={`mm-root${calm ? ' mm-calm' : ''}${view !== 'title' ? ' mm-has-panel' : ''}${entering ? ' mm-is-entering' : ''}`}
      data-testid="main-menu"
      data-view={view}
      onPointerDown={() => menuGesture(ctx)}
      onKeyDown={() => menuGesture(ctx)}
    >
      <div class="mm-shade" />
      <div class="mm-grain" />
      <div class="mm-scan" />
      <div class="mm-roll" />

      <header class="mm-topbar">
        <span class="mm-freq"><i class="mm-dot" />CH 07 · 104.7 MHz · <b>NO CARRIER</b></span>
        <Clock />
      </header>

      <div class="mm-left">
        <div class="mm-brand">
          <div class="mm-kicker">THE COMPANY PRESENTS</div>
          <h1 class="mm-title" data-text="DEAD AIR"><span>DEAD AIR</span></h1>
          <div class="mm-sub"><span>NIGHT SHIFT SALVAGE</span></div>
          <div class="mm-tag">The company appreciates your discretion.</div>
        </div>
        {invite && (
          <div class="mm-invite" data-testid="menu-invite">
            <span class="mm-invite-k">INVITE RECEIVED</span>
            <span>CREW <b>{invite}</b> · PRESS <span class="mm-key">ENTER</span> TO PLAY</span>
          </div>
        )}
        <nav class="mm-nav" ref={navRef} aria-label="Main menu">
          {items.map((it, i) => (
            <button
              key={it.id}
              type="button"
              class={`mm-item${view === it.id ? ' on' : ''}${it.id === 'play' ? ' primary' : ''}`}
              data-view={it.id}
              data-testid={`menu-${it.id}`}
              onMouseEnter={(e) => { hover(); (e.currentTarget as HTMLButtonElement).focus({ preventScroll: true }); }}
              onFocus={hover}
              onClick={() => (view === it.id ? back() : open(it.id))}
            >
              <span class="mm-num">{String(i + 1).padStart(2, '0')}</span>
              <span class="mm-label">{it.label}</span>
              <span class="mm-hint">{it.hint}</span>
            </button>
          ))}
        </nav>
      </div>

      {cur && (
        <section class={`mm-panel mm-panel-${cur.id}`} key={cur.id} data-testid={`menu-panel-${cur.id}`}>
          <header class="mm-panel-top">
            <div>
              <div class="mm-panel-kicker">{cur.kicker}</div>
              <h2 class="mm-panel-h">{cur.heading}</h2>
            </div>
            {cur.id !== 'play' && <button type="button" class="mm-back" onMouseEnter={hover} onClick={back}>BACK [ESC]</button>}
          </header>
          <div class="mm-panel-body">{body}</div>
        </section>
      )}

      <footer class="mm-foot">
        <BuildLine ctx={ctx} />
        <span class="mm-foot-r">CHROME + WIRED HEADSET RECOMMENDED</span>
      </footer>

      {entering && (
        <div class="mm-entering" data-testid="menu-entering">
          <div class="mm-entering-box">
            <div class="mm-entering-k">CREW {ctx.world.crew?.code ?? ''} · SIGNAL ACQUIRED</div>
            <div class="mm-entering-t">Entering the lot…</div>
            <div class="mm-entering-bar"><i /></div>
          </div>
        </div>
      )}
    </div>
  );
}
