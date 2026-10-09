// Owner: env-render (v1.3, item 3e). The title menu's static still on Low / Lite / WebGL2, instead of the live 3D
// backdrop (its 67-91 programs compiled at boot: seconds of freezes on the friends' WebGL2 machines before they could
// even click PLAY). A painted corridor in the fog with one far fluorescent and a torch pool on the floor, placed where
// the menu's shade leaves the view open (vanishing point ~64% / 47%); a slow compositor-only drift stands in for the
// backdrop's camera sway. No WebGL work at all: the canvas under it draws nothing while it is up.
// ?menu3d=1 forces the live backdrop, ?menu3d=0 the still on every preset.

/** vanishing point of the painted corridor (%), where the menu's shade is clear */
const VX = 64, VY = 47;

/** the layered CSS background (top layer first) */
export function stillBackground(): string {
  const at = `${VX}% ${VY}%`;
  return [
    // vignette (the menu adds its own shade on top)
    `radial-gradient(ellipse 95% 90% at ${at}, rgba(0,0,0,0) 38%, rgba(0,0,0,0.72) 100%)`,
    // the far end: a lit doorway under one fluorescent tube, haloed by the fog
    `radial-gradient(ellipse 3.2% 7.5% at ${VX}% ${VY + 1}%, rgba(214,236,206,0.55), rgba(214,236,206,0) 100%)`,
    `radial-gradient(ellipse 13% 24% at ${at}, rgba(150,170,150,0.26), rgba(150,170,150,0) 100%)`,
    // a doorframe at the far end: two dark jambs + a lintel against the glow, in a small box on the vanishing point
    `linear-gradient(90deg, rgba(4,5,5,0.85) 0 9%, rgba(0,0,0,0) 9% 91%, rgba(4,5,5,0.85) 91%) ${VX}% ${VY + 1}% / 5.6% 15% no-repeat`,
    `linear-gradient(180deg, rgba(4,5,5,0.85) 0 7%, rgba(0,0,0,0) 7%) ${VX}% ${VY + 1}% / 5.6% 15% no-repeat`,
    // the ceiling tube streak running toward the camera
    `linear-gradient(${180 - 7}deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0) 30%, rgba(200,226,200,0.05) 31%, rgba(0,0,0,0) 33%)`,
    // the torch pool on the floor (warm, soft) + its spill on the right wall
    `radial-gradient(ellipse 26% 14% at ${VX + 3}% 79%, rgba(255,227,189,0.13), rgba(255,227,189,0) 100%)`,
    `radial-gradient(ellipse 10% 26% at 86% 58%, rgba(255,227,189,0.05), rgba(255,227,189,0) 100%)`,
    // floor tile joints converging on the vanishing point
    `repeating-conic-gradient(from 150deg at ${at}, rgba(255,255,255,0.016) 0deg 0.35deg, rgba(0,0,0,0) 0.35deg 5deg)`,
    // the corridor box: ceiling (top), right wall, floor, left wall, soft corners
    `conic-gradient(from -50deg at ${at}, #0c0e0e 0deg, #121514 18deg, #171b19 80deg, #0f1211 98deg, #0d0e0d 128deg, #121310 190deg, #0c0d0c 228deg, #0a0b0c 262deg, #090a0b 300deg, #0b0d0d 340deg, #0c0e0e 360deg)`,
  ].join(', ');
}

export interface MenuStill {
  readonly el: HTMLDivElement;
  remove(): void;
}

/** the still over the canvas (inside the game container, under the UI overlay) */
export function createMenuStill(container: HTMLElement): MenuStill {
  const el = document.createElement('div');
  el.className = 'render-menu-still';
  el.setAttribute('data-testid', 'menu-still');
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = `position:absolute;inset:-3%;pointer-events:none;background:${stillBackground()};background-color:#050607;`
    + 'will-change:transform;animation:render-still-drift 38s ease-in-out infinite alternate;';
  // one keyframes rule for the drift (compositor-only transform, no repaint)
  if (!document.getElementById('render-still-style')) {
    const st = document.createElement('style');
    st.id = 'render-still-style';
    st.textContent = '@keyframes render-still-drift { from { transform: translate3d(-0.6%, 0.25%, 0) scale(1.01); } to { transform: translate3d(0.6%, -0.25%, 0) scale(1.03); } }'
      + ' @media (prefers-reduced-motion: reduce) { .render-menu-still { animation: none !important; } }';
    document.head.appendChild(st);
  }
  container.appendChild(el);
  return { el, remove: () => el.remove() };
}
