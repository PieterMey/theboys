// Owner: track (d) Meta. Client-side helpers: meta slice access, hooks, local settings (applied through other tracks'
// services when present; every service is optional).
import { useEffect, useState } from 'preact/hooks';
import type { ClientContext } from '../core/context.ts';
import type { MetaState } from '@dead-air/shared/messages/meta.ts';
import type { WorkOrder } from '@dead-air/shared/workorder.ts';
import type { PlayerPublic } from '@dead-air/shared/state.ts';

export const metaOf = (ctx: ClientContext): MetaState | null => ctx.world.full?.meta ?? null;
export const ordersOf = (ctx: ClientContext): WorkOrder[] => ctx.world.full?.workOrders ?? [];
export const activeOrderOf = (ctx: ClientContext): WorkOrder | null => ctx.world.full?.activeOrder ?? null;
export const mePub = (ctx: ClientContext): PlayerPublic | null => ctx.world.crew?.players.find((p) => p.id === ctx.world.me) ?? null;
export const isLeader = (ctx: ClientContext): boolean => {
  const conn = ctx.world.crew?.players.filter((p) => p.connected) ?? [];
  return !!mePub(ctx)?.isLeader || conn.length <= 1;
};

/** re-render on discrete world changes (phase, crew, meta updates) */
export function useWorldV(ctx: ClientContext): number {
  const [v, setV] = useState(ctx.world.version);
  useEffect(() => ctx.world.subscribe(() => setV(ctx.world.version)), [ctx]);
  return v;
}

/** re-render every `ms` (live meters, countdowns) */
export function useTicker(ms: number): number {
  const [t, setT] = useState(0);
  useEffect(() => {
    let alive = true;
    let id: ReturnType<typeof setTimeout>;
    const loop = () => {
      if (!alive) return;
      setT((x) => x + 1);
      id = setTimeout(loop, ms);
    };
    id = setTimeout(loop, ms);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [ms]);
  return t;
}

/** untyped service lookup (services other tracks declare; may be absent) */
export function loose<T>(ctx: ClientContext, name: string): T | undefined {
  return (ctx.services.use as unknown as (n: string) => T | undefined)(name);
}

// ---------------------------------------------------------------- settings

export interface MetaSettings {
  preset: string | null;
  exposure: number | null;
  brightnessDone: boolean;
  master: number;
  voice: number;
  sfx: number;
  sensitivity: number | null;
  reduceFlicker: boolean;
  ptt: boolean;
  micGain: number | null;
  hints: boolean;
}

const LS = 'deadair.meta.settings';
const DEFAULTS: MetaSettings = {
  preset: null, exposure: null, brightnessDone: false, master: 1, voice: 1, sfx: 1, sensitivity: null, reduceFlicker: false, ptt: false, micGain: null, hints: true,
};

let cache: MetaSettings | null = null;
const subs = new Set<() => void>();

export function settings(): MetaSettings {
  if (cache) return cache;
  let s: Partial<MetaSettings> = {};
  try { s = JSON.parse(localStorage.getItem(LS) ?? '{}') as Partial<MetaSettings>; } catch { s = {}; }
  cache = { ...DEFAULTS, ...s };
  return cache;
}

export function saveSettings(p: Partial<MetaSettings>): MetaSettings {
  cache = { ...settings(), ...p };
  try { localStorage.setItem(LS, JSON.stringify(cache)); } catch { /* private mode */ }
  for (const fn of subs) fn();
  return cache;
}

export function onSettings(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

interface RenderLike {
  presets?: readonly string[];
  preset?: string;
  setPreset?(n: string): void;
  setExposure?(v: number): void;
  exposure?(): number;
  setReduceFlicker?(on: boolean): void;
}
interface PlayersLike {
  settings?(): { sensitivity: number };
  setSettings?(p: { sensitivity?: number }): void;
  freeze?(reason: string, on: boolean): void;
  localPose?(): { p: [number, number, number]; yaw: number } | null;
  locked?(): boolean;
}
export const render = (ctx: ClientContext) => loose<RenderLike>(ctx, 'render');
export const players = (ctx: ClientContext) => loose<PlayersLike>(ctx, 'players');

let baseGains: { master: number; voice: number; sfx: number } | null = null;

/** push settings into the other tracks' services (each optional) */
export async function applySettings(ctx: ClientContext, only?: (keyof MetaSettings)[]): Promise<void> {
  const s = settings();
  const want = (k: keyof MetaSettings) => !only || only.includes(k);
  const r = render(ctx);
  try {
    if (want('preset') && s.preset && r?.setPreset && r.presets?.includes(s.preset)) r.setPreset(s.preset);
    if (want('exposure') && s.exposure !== null && r?.setExposure) r.setExposure(s.exposure);
    if (want('reduceFlicker') && r?.setReduceFlicker) r.setReduceFlicker(s.reduceFlicker);
  } catch { /* render mid-init */ }
  const v = ctx.services.use('voice') as unknown as { setPushToTalk?(on: boolean): void; setMicGain?(g: number): void } | undefined;
  try {
    if (want('ptt') && v?.setPushToTalk) v.setPushToTalk(s.ptt);
    if (want('micGain') && s.micGain !== null && v?.setMicGain) v.setMicGain(s.micGain);
  } catch { /* voice mid-init */ }
  const pl = players(ctx);
  if (want('sensitivity') && s.sensitivity !== null && pl?.setSettings) pl.setSettings({ sensitivity: s.sensitivity });
  if ((want('master') || want('voice') || want('sfx')) && ctx.audio.ctx) {
    try {
      const { getGraph } = await import('../audio/graph.ts');
      const g = getGraph(ctx.audio.ctx);
      baseGains ??= { master: g.master.gain.value, voice: g.voiceBus.gain.value, sfx: g.sfxBus.gain.value };
      const t = ctx.audio.ctx.currentTime;
      g.master.gain.setTargetAtTime(baseGains.master * s.master, t, 0.05);
      g.voiceBus.gain.setTargetAtTime(baseGains.voice * s.voice, t, 0.05);
      g.sfxBus.gain.setTargetAtTime(baseGains.sfx * s.sfx, t, 0.05);
    } catch { /* audio graph not available */ }
  }
}

// ---------------------------------------------------------------- misc

export function clockLabel(min: number): string {
  if (min < 0) return '--:--';
  const total = (22 * 60 + Math.floor(min)) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function sfx(ctx: ClientContext, key: string): void {
  try { ctx.services.use('sfx')?.play(key, undefined, { ui: true, volume: 0.7 }); } catch { /* optional */ }
}
