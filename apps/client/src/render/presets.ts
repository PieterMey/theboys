// Owner: track ③ Render. Quality presets (PLAN §4.9 table, values in config/balance/render.json) + GPU heuristics.
// v1.2 gate P: High / Ultra shadow 4 beams (yours + the 3 best remote ones); the other 2 use unshadowed batched slots.
// v1.3 (4e): 'lite', opt-in only (?preset=lite or the settings; never detected, never an auto-quality step): your own
// beam shadowed only, one output pass (tone map + grade + vignette: no bloom, CA, TRAA, velocity, grain, march), no
// GI, the v1.1 closed-form exponential fog, 4 fixture spots, <= 1280x720 with a 0.5 rung; from the next load also
// noise-free surfaces (noise-volume taps instead of MaterialX noise) and low-poly fixture halos.
import type { ClientContext } from '../core/context.ts';

export interface Preset {
  name: string;
  shadowed: number;
  unshadowed: number;
  shadowMap: number;
  volumetric: boolean;
  volScale: number;
  volSteps: number;
  gtao: boolean;
  aoScale: number;
  res: number;
  fixtures: number;
  traa: boolean;
  /** v1.3 (4e): the Lite render path (see the header) */
  lite?: boolean;
}

/** the auto-quality ladder (and GPU detection) */
export const PRESET_NAMES = ['low', 'medium', 'high', 'ultra'] as const;
/** v1.3 (4e): opt-in, outside the ladder */
export const LITE_PRESET = 'lite';
/** v1.3: what the settings menus list (services.render.presets) */
export const MENU_PRESETS = [LITE_PRESET, ...PRESET_NAMES] as const;

const FALLBACK: Record<string, Omit<Preset, 'name'>> = {
  lite: { shadowed: 1, unshadowed: 5, shadowMap: 512, volumetric: false, volScale: 0.25, volSteps: 8, gtao: false, aoScale: 0.5, res: 0.75, fixtures: 4, traa: false, lite: true },
  low: { shadowed: 2, unshadowed: 4, shadowMap: 512, volumetric: false, volScale: 0.25, volSteps: 8, gtao: false, aoScale: 0.5, res: 0.75, fixtures: 8, traa: false },
  medium: { shadowed: 4, unshadowed: 2, shadowMap: 1024, volumetric: true, volScale: 0.25, volSteps: 8, gtao: true, aoScale: 0.5, res: 1, fixtures: 16, traa: true },
  high: { shadowed: 4, unshadowed: 2, shadowMap: 1024, volumetric: true, volScale: 0.25, volSteps: 12, gtao: true, aoScale: 0.5, res: 1, fixtures: 24, traa: true },
  ultra: { shadowed: 4, unshadowed: 2, shadowMap: 2048, volumetric: true, volScale: 0.5, volSteps: 16, gtao: true, aoScale: 1, res: 1, fixtures: 32, traa: true },
};

export function presetTable(ctx: ClientContext): Record<string, Preset> {
  const cfg = (ctx.balance.render?.presets ?? {}) as Record<string, Partial<Preset>>;
  const out: Record<string, Preset> = {};
  for (const n of MENU_PRESETS) out[n] = { name: n, ...FALLBACK[n], ...(cfg[n] ?? {}) } as Preset;
  return out;
}

/** v1.3 (P6): the settings value meaning "no stored preset: GPU detection, auto quality may climb back up to it" */
export const AUTO_PRESET = 'auto';

/** v1.3 (3d, P6): a settings choice (a preset name or 'auto') against the stored choice and the active preset.
 *  store = the value to persist (null = nothing stored: AUTO); apply = the preset to switch to (null = nothing to
 *  rebuild). The same choice again (the settings re-apply it after every welcome) changes nothing: the auto-quality
 *  ladder keeps its state and a ?preset= page keeps its preset. 'auto' clears the stored choice and applies the
 *  detected preset. */
export function presetChoice(choice: string, stored: string | null, active: string, names: readonly string[], detected?: string): { store: string | null; apply: string | null } {
  if (choice === AUTO_PRESET) {
    if (stored === null || !names.includes(stored)) return { store: null, apply: null };
    return { store: null, apply: detected && names.includes(detected) && detected !== active ? detected : null };
  }
  if (!names.includes(choice)) return { store: stored, apply: null };
  if (stored === choice || active === choice) return { store: choice, apply: null };
  return { store: choice, apply: choice };
}

/** Best-effort GPU name: WebGL unmasked renderer string (Chrome exposes it), else WebGPU adapter info. */
export async function gpuName(): Promise<string> {
  let name = '';
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') ?? c.getContext('webgl');
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      name = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch { /* ignore */ }
  if (!name) {
    try {
      const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<{ info?: { vendor?: string; architecture?: string; description?: string } } | null> } }).gpu;
      const a = await gpu?.requestAdapter();
      const i = a?.info;
      if (i) name = [i.vendor, i.architecture, i.description].filter(Boolean).join(' ');
    } catch { /* ignore */ }
  }
  return name;
}

/** Default preset from the GPU name (no benchmark tonight). */
export function presetForGpu(name: string, backend: 'webgpu' | 'webgl2'): string {
  const n = name.toUpperCase();
  let p = 'medium';
  if (/SWIFTSHADER|LLVMPIPE|SOFTWARE|MICROSOFT BASIC/.test(n)) p = 'low';
  else if (/RTX\s*50\d\d|RTX\s*40[89]0|RTX\s*PRO|RX\s*9070|RX\s*7900|BLACKWELL/.test(n)) p = 'ultra';
  else if (/RTX\s*\d{4}|RX\s*[67]\d{3}|RX\s*9\d{3}|ARC\s*[AB]7|LOVELACE|AMPERE|RDNA\s*[34]/.test(n)) p = 'high';
  else if (/GTX\s*16|GTX\s*10[78]0|RX\s*5[67]00|ARC/.test(n)) p = 'medium';
  else if (/INTEL|UHD|IRIS|RADEON\(TM\) GRAPHICS|RADEON GRAPHICS|VEGA|APPLE|MALI|ADRENO|POWERVR|GTX\s*10[56]0|MX\s*\d/.test(n)) p = 'low';
  // the WebGL2 fallback is slower per light; never default above high there
  if (backend === 'webgl2' && p === 'ultra') p = 'high';
  return p;
}
