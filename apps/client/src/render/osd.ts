// Owner: env-render (v1.3, the SIGNAL look; gfx-art "SIGNAL": every frame is a Company bodycam feed). The bodycam OSD:
// a DOM layer at FULL screen resolution over the pixelated canvas (never pixelated itself), under the game's HUD. One
// compact block in the top-left corner (the only corner the HUD leaves free: link / crew / objectives top right, the
// voice meter bottom left, render + light chips bottom right, the hotbar bottom centre): REC with a blinking dot and a
// camcorder timestamp, the camera label with LOC (the room's callsign: wall stencils are unreadable at ~640-960
// render pixels), BATT (your flashlight's battery) and SIG (the link's round trip). Text only changes when a value
// does (no per-frame DOM writes). Optional scanlines on whole-number device pixel ratios only (a fractional DPR moires).
// That corner is free only on the job: osdVisible() shows the block in the contract phase only (see there).

/** When the bodycam OSD shows (render/index.ts asks every frame; plain arguments, no per-frame object). Only on the
 *  job: world phase 'contract', the game view drawing ('game' cover mode) and no screen over it. In the van (phase
 *  'hub') the HUD's CREW panel sits in the same top-left corner and the OSD text showed through it; the title menu,
 *  the drive and the results are screens over the view; any other open screen (the Esc menu, a keypad, a note) hides
 *  it as well, so the screen's shade leaves no dim ghost of the text. `covered` = the title backdrop or the static
 *  menu still is up (no level yet). */
export function osdVisible(signal: boolean, mode: string, phase: string, screen: string, covered: boolean): boolean {
  return signal && mode === 'game' && phase === 'contract' && screen === 'none' && !covered;
}

export interface OsdData {
  /** your flashlight battery 0..1 (null = unknown / no light) */
  batt: number | null;
  /** round trip ms (null = not joined) */
  rtt: number | null;
  /** the camera's room callsign (null = none) */
  loc: string | null;
  /** the whole-number pixel scale (scanline period, physical px) */
  k: number;
}

export interface Osd {
  readonly shown: boolean;
  show(on: boolean): void;
  update(d: OsdData, now: number): void;
  remove(): void;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const pad = (n: number) => String(n).padStart(2, '0');

/** camcorder timestamp of a local date: 'OCT 09  02:13:44' */
export function osdStamp(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${pad(d.getDate())}  ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** BATT cells (4): full = '▮', empty = '▯' */
export function battBars(b: number | null): string {
  if (b === null || !Number.isFinite(b)) return '▯▯▯▯';
  const n = Math.max(0, Math.min(4, Math.ceil(b * 4 - 1e-6)));
  return '▮'.repeat(n) + '▯'.repeat(4 - n);
}

/** SIG bars from the round trip (4 = < 60 ms ... 1 = slow, 0 = no link) */
export function sigBars(rtt: number | null): string {
  if (rtt === null || !Number.isFinite(rtt)) return '____';
  const n = rtt < 60 ? 4 : rtt < 120 ? 3 : rtt < 250 ? 2 : 1;
  return '▂▄▆█'.slice(0, n) + '_'.repeat(4 - n);
}

export function createOsd(container: HTMLElement): Osd {
  const root = document.createElement('div');
  root.className = 'render-osd';
  root.setAttribute('data-testid', 'signal-osd');
  root.setAttribute('aria-hidden', 'true');
  root.style.cssText = 'position:absolute;inset:0;pointer-events:none;display:none;'
    + 'font:600 clamp(11px,1.45vw,17px)/1 Consolas,"Courier New",ui-monospace,monospace;letter-spacing:.14em;'
    + 'color:#e6eee6;text-shadow:0 0 2px rgba(0,0,0,.9),1px 1px 0 rgba(0,0,0,.75);';
  const scan = document.createElement('div');
  scan.style.cssText = 'position:absolute;inset:0;';
  const box = (css: string) => { const e = document.createElement('div'); e.style.cssText = `position:absolute;white-space:pre;${css}`; root.appendChild(e); return e; };
  root.appendChild(scan);
  const block = box('left:2.2vw;top:2.4vh;line-height:1.55;');
  const line = () => { const e = document.createElement('div'); block.appendChild(e); return e; };
  const rec = line();
  const dot = document.createElement('span');
  dot.style.cssText = 'display:inline-block;width:.62em;height:.62em;border-radius:50%;background:#ff2a1a;margin-right:.55em;vertical-align:-.02em;box-shadow:0 0 6px rgba(255,42,26,.7);';
  rec.appendChild(dot);
  rec.appendChild(document.createTextNode('REC   '));
  const stamp = document.createElement('span');
  rec.appendChild(stamp);
  const loc = line();
  loc.style.opacity = '.85';
  const stat = line();
  stat.style.opacity = '.85';
  container.appendChild(root);
  let shown = false;
  let next = 0;
  const last = { stamp: '', loc: '', stat: '', k: 0, dpr: 0 };
  const set = (e: HTMLElement, key: 'stamp' | 'loc' | 'stat', v: string) => { if (last[key] !== v) { last[key] = v; e.textContent = v; } };
  return {
    get shown() { return shown; },
    show(on) {
      if (on === shown) return;
      shown = on;
      root.style.display = on ? 'block' : 'none';
      next = 0;
    },
    update(d, now) {
      if (!shown || now < next) return;
      next = now + 250;
      // the REC dot blinks at 1 Hz (steps, no animation frames)
      dot.style.visibility = Math.floor(now / 500) % 2 === 0 ? 'visible' : 'hidden';
      set(stamp, 'stamp', osdStamp(new Date()));
      set(loc, 'loc', `CAM 2 · BODY${d.loc ? `   LOC ${d.loc.toUpperCase()}` : ''}`);
      set(stat, 'stat', `BATT ${battBars(d.batt)}   SIG ${sigBars(d.rtt)}`);
      const dpr = window.devicePixelRatio || 1;
      if (d.k !== last.k || dpr !== last.dpr) {
        last.k = d.k;
        last.dpr = dpr;
        // one dark line per render row, aligned to the canvas: only where it lands on whole device pixels
        const row = d.k / dpr;
        scan.style.background = Number.isInteger(dpr) && d.k >= 2
          ? `repeating-linear-gradient(180deg, rgba(0,0,0,0) 0 ${row - 1 / dpr}px, rgba(0,0,0,.16) ${row - 1 / dpr}px ${row}px)`
          : 'none';
      }
    },
    remove() { root.remove(); },
  };
}
