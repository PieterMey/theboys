// Owner: env-paranormal (v1.2) client. services.paranormal settings: mode 'full' | 'subtle' (per browser, localStorage
// with try/catch: private windows and blocked storage fall back to the defaults).
//  - full: every effect as designed
//  - subtle: quieter (x0.6), half the heartbeat bumps, the mirror figure becomes fog + a handprint, no beam stutter
export interface ParanormalSettings { mode: 'full' | 'subtle' }

const KEY = 'deadair.paranormal';
const DEFAULTS: ParanormalSettings = { mode: 'full' };

export function loadSettings(): ParanormalSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<ParanormalSettings>;
    return { mode: raw.mode === 'subtle' ? 'subtle' : 'full' };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: ParanormalSettings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode / blocked storage */ }
}

/** the render track's 'reduce flicker' switch (render or meta settings key), read-only */
export function reduceFlickerOn(): boolean {
  try {
    if (localStorage.getItem('deadair.render.reduceFlicker') === '1') return true;
    const m = JSON.parse(localStorage.getItem('deadair.meta.settings') ?? '{}') as { reduceFlicker?: boolean };
    return m.reduceFlicker === true;
  } catch {
    return false;
  }
}
