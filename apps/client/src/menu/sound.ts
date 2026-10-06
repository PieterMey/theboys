// Owner: menu track. Menu UI sounds (tiny synthesized radio ticks on the shared graph's sfx bus, so the volume
// settings apply) and the faint radio-static bed (services.sfx.setStatic) that starts on the first click.
import type { ClientContext } from '../core/context.ts';
import { getGraph } from '../audio/graph.ts';

let staticOn = false;

/** radio static bed level 0..1 (audio track's procedural ambience); needs the unlocked AudioContext */
export function menuStatic(ctx: ClientContext, level: number): void {
  if (level <= 0 && !staticOn) return;
  try {
    const s = ctx.services.use('sfx');
    if (!s?.setStatic || !ctx.audio.ctx) return;
    s.setStatic(level);
    staticOn = level > 0;
  } catch { /* audio not ready */ }
}

/** first user gesture on the menu: unlock audio (allowed inside the gesture) and start the static bed */
export function menuGesture(ctx: ClientContext): void {
  if (staticOn) return;
  try { ctx.audio.unlock(); } catch { /* no audio */ }
  menuStatic(ctx, 0.35);
}

let seed = 0x2f6b1d;
const noise = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x80000000 - 1;
};
let lastAt = 0;

/** 'hover' = short tick, 'select' = squelch chirp, 'back' = lower chirp */
export function uiSound(ctx: ClientContext, kind: 'hover' | 'select' | 'back'): void {
  const ac = ctx.audio.ctx;
  if (!ac || ac.state !== 'running') return;
  const now = performance.now();
  if (kind === 'hover' && now - lastAt < 45) return;
  lastAt = now;
  try {
    const g = getGraph(ac);
    const t = ac.currentTime;
    const dur = kind === 'hover' ? 0.03 : 0.11;
    const n = Math.max(1, Math.floor(ac.sampleRate * dur));
    const buf = ac.createBuffer(1, n, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const k = 1 - i / n;
      d[i] = noise() * k * k;
    }
    const src = ac.createBufferSource();
    src.buffer = buf;
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = kind === 'hover' ? 3200 : 1800;
    bp.Q.value = kind === 'hover' ? 2.5 : 1.2;
    const gain = ac.createGain();
    gain.gain.value = kind === 'hover' ? 0.11 : 0.16;
    src.connect(bp).connect(gain).connect(g.sfxBus);
    src.start(t);
    if (kind !== 'hover') {
      const o = ac.createOscillator();
      const og = ac.createGain();
      o.type = 'square';
      o.frequency.setValueAtTime(kind === 'select' ? 1250 : 700, t);
      o.frequency.exponentialRampToValueAtTime(kind === 'select' ? 1900 : 420, t + 0.07);
      og.gain.setValueAtTime(0.0001, t);
      og.gain.exponentialRampToValueAtTime(0.035, t + 0.01);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      const lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2600;
      o.connect(lp).connect(og).connect(g.sfxBus);
      o.start(t);
      o.stop(t + 0.1);
    }
  } catch { /* audio graph unavailable */ }
}
