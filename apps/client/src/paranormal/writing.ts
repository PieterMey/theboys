// Owner: env-paranormal (v1.2) client. CanvasTexture masks (R = wiped / pressed): mirror writing in an OFL hand font
// (Caveat Brush, SIL Open Font License, via Google Fonts; cursive fallbacks) with seeded per-letter jitter and
// condensation drips, revealed stroke by stroke; the Low-preset handprint; the wet bare-foot print.
import * as THREE from 'three/webgpu';
import { seeded } from './env.ts';

const FONT = "'Caveat Brush', 'Segoe Print', 'Bradley Hand', 'Comic Sans MS', cursive";
let fontReady: Promise<void> | null = null;

/** load the OFL hand font once (never blocks a reveal for more than ~1.5 s) */
export function loadWritingFont(): Promise<void> {
  if (fontReady) return fontReady;
  fontReady = new Promise<void>((res) => {
    try {
      if (!document.querySelector('link[data-para-font]')) {
        const l = document.createElement('link');
        l.rel = 'stylesheet';
        l.href = 'https://fonts.googleapis.com/css2?family=Caveat+Brush&display=swap';
        l.dataset.paraFont = '1';
        document.head.appendChild(l);
      }
      const t = setTimeout(res, 1500);
      void document.fonts?.load?.("96px 'Caveat Brush'").then(() => { clearTimeout(t); res(); }, () => { clearTimeout(t); res(); });
    } catch { res(); }
  });
  return fontReady;
}

function maskTexture(c: HTMLCanvasElement, name: string): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.name = name;
  tex.needsUpdate = true;
  return tex;
}

interface Glyph { ch: string; x: number; y: number; size: number; rot: number; w: number; line: number }

export interface WritingMask {
  tex: THREE.CanvasTexture;
  /** redraw with strokes revealed up to k (0..1, left to right, line by line) */
  draw(k: number): void;
  dispose(): void;
}

/** text written into the condensation of a w x h mirror; seed = the event seed (every client draws the same) */
export function writingMask(text: string, w: number, h: number, seed: number): WritingMask {
  const aspect = Math.max(0.25, Math.min(4, w / Math.max(0.05, h)));
  const W = 512;
  const H = Math.max(128, Math.min(1024, Math.round(W / aspect)));
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const rnd = seeded(seed ^ 0x51ed);
  // tall glass: one word per line
  const words = text.split(/\s+/).filter(Boolean);
  const lines = aspect < 0.9 && words.length > 1 ? words : [words.join(' ')];
  let size = Math.min(H / (lines.length * 1.25), 150);
  g.font = `${size}px ${FONT}`;
  const widest = Math.max(...lines.map((l) => g.measureText(l).width));
  if (widest > W * 0.84) size *= (W * 0.84) / widest;
  g.font = `${size}px ${FONT}`;
  const glyphs: Glyph[] = [];
  const lineH = size * 1.12;
  const top = H / 2 - ((lines.length - 1) * lineH) / 2;
  lines.forEach((line, li) => {
    const lw = g.measureText(line).width;
    let x = W / 2 - lw / 2 + (rnd() - 0.5) * size * 0.2;
    const tilt = (rnd() - 0.5) * 0.08;
    for (const ch of line) {
      const cw = g.measureText(ch).width;
      const s = size * (0.94 + rnd() * 0.12);
      glyphs.push({ ch, x: x + cw / 2, y: top + li * lineH + (x - W / 2) * tilt + (rnd() - 0.5) * size * 0.08, size: s, rot: (rnd() - 0.5) * 0.16 + tilt, w: cw, line: li });
      x += cw * (0.96 + rnd() * 0.1);
    }
  });
  // drips: water running down from a few letters
  const drips = glyphs.filter((q) => q.ch.trim() && rnd() < 0.35).map((q) => ({ x: q.x + (rnd() - 0.5) * q.w * 0.5, y: q.y + q.size * 0.3, len: q.size * (0.4 + rnd() * 1.4), wd: 2 + rnd() * 3 }));
  const total = glyphs.length;
  const tex = maskTexture(c, 'para-writing');
  const draw = (k: number) => {
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    g.filter = 'blur(1.2px)';
    g.fillStyle = '#fff';
    g.strokeStyle = '#fff';
    g.lineJoin = 'round';
    g.lineCap = 'round';
    const upto = Math.max(0, Math.min(1, k)) * total;
    for (let i = 0; i < total; i++) {
      if (i >= upto) break;
      const q = glyphs[i];
      const frac = Math.min(1, upto - i);
      g.save();
      g.translate(q.x, q.y);
      g.rotate(q.rot);
      g.font = `${q.size}px ${FONT}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      if (frac < 1) {
        // the finger is still moving through this letter: clip it left to right
        g.beginPath();
        g.rect(-q.w, -q.size, q.w * 2 * frac, q.size * 2);
        g.clip();
      }
      g.lineWidth = q.size * 0.07;
      g.strokeText(q.ch, 0, 0);
      g.fillText(q.ch, 0, 0);
      g.restore();
    }
    if (k >= 1) {
      g.filter = 'blur(0.8px)';
      for (const d of drips) {
        const grad = g.createLinearGradient(d.x, d.y, d.x, d.y + d.len);
        grad.addColorStop(0, 'rgba(255,255,255,0.9)');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grad;
        g.beginPath();
        g.ellipse(d.x, d.y + d.len / 2, d.wd / 2, d.len / 2, 0, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.filter = 'none';
    tex.needsUpdate = true;
  };
  draw(0);
  return { tex, draw, dispose: () => tex.dispose() };
}

/** a handprint pressed against the glass from the other side (Low preset / subtle mode: no live reflection) */
export function handprintMask(w: number, h: number, seed: number): THREE.CanvasTexture {
  const aspect = Math.max(0.25, Math.min(4, w / Math.max(0.05, h)));
  const W = 256, H = Math.max(96, Math.min(768, Math.round(W / aspect)));
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const rnd = seeded(seed ^ 0x4a7d);
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  const s = Math.min(W, H) * 0.0042 * (0.9 + rnd() * 0.2);
  const cx = W * (0.38 + rnd() * 0.24), cy = H * (0.45 + rnd() * 0.15);
  g.save();
  g.translate(cx, cy);
  g.rotate((rnd() - 0.5) * 0.6);
  g.scale(s, s);
  g.filter = 'blur(2px)';
  const blob = (x: number, y: number, rx: number, ry: number, rot: number, a: number) => {
    g.fillStyle = `rgba(255,255,255,${a})`;
    g.beginPath();
    g.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
    g.fill();
  };
  // palm, heel pads, fingers (+ the pads at their tips), thumb
  blob(0, 18, 34, 38, 0, 0.75);
  blob(-14, 44, 16, 14, 0, 0.6);
  blob(14, 44, 16, 14, 0, 0.6);
  const fingers: [number, number, number][] = [[-27, -42, -0.18], [-9, -52, -0.05], [9, -50, 0.05], [26, -40, 0.18]];
  for (const [x, y, r] of fingers) {
    blob(x, y, 7.5, 24, r, 0.7);
    blob(x + r * 30, y - 22, 7, 8, r, 0.85);
  }
  blob(-40, 8, 8, 20, -0.9, 0.7);
  g.restore();
  // a few smears dragging down
  g.filter = 'blur(1.5px)';
  for (let i = 0; i < 4; i++) {
    const x = cx + (rnd() - 0.5) * 80 * s, len = H * (0.06 + rnd() * 0.18);
    const grad = g.createLinearGradient(x, cy, x, cy + len);
    grad.addColorStop(0, 'rgba(255,255,255,0.5)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(x - 2, cy, 4, len);
  }
  g.filter = 'none';
  return maskTexture(c, 'para-handprint');
}

/** wet bare-foot print (alpha in A, a little blotchy); right foot, toes toward +y of the texture */
export function footprintTexture(): THREE.CanvasTexture {
  const W = 64, H = 128;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, W, H);
  const rnd = seeded(0xf007);
  g.filter = 'blur(1.5px)';
  const blob = (x: number, y: number, rx: number, ry: number, rot: number, a: number) => {
    g.fillStyle = `rgba(255,255,255,${a})`;
    g.beginPath();
    g.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
    g.fill();
  };
  // heel, outer arch edge, ball, toes (canvas y down = toward the heel)
  blob(32, 104, 13, 16, 0, 0.95);
  blob(40, 78, 6, 16, 0.15, 0.7);
  blob(30, 48, 16, 14, -0.1, 0.95);
  const toes: [number, number, number][] = [[18, 26, 6], [27, 22, 4.5], [35, 22, 4], [42, 25, 3.6], [48, 30, 3.2]];
  for (const [x, y, r] of toes) blob(x, y, r, r * 1.15, 0, 0.9);
  // blotches: wet, uneven
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 40; i++) blob(10 + rnd() * 44, 15 + rnd() * 105, 1 + rnd() * 3, 1 + rnd() * 3, 0, 0.35);
  g.globalCompositeOperation = 'source-over';
  g.filter = 'none';
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.name = 'para-footprint';
  tex.needsUpdate = true;
  return tex;
}
