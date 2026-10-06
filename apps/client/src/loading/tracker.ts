// Owner: v1.1 loading screen. Real download progress: every three.js loader (GLTF / KTX2 / Texture / File) goes
// through THREE.DefaultLoadingManager (item start/end counts), every fetch under /assets/ shows up as a 'resource'
// performance entry, and the asset manifest knows each file's size (bytes) -> "12/31 files · 8.4/22.1 MB".
import * as THREE from 'three/webgpu';
import { getAssetManifest } from '@dead-air/shared/assets.ts';

export interface AssetProgress {
  /** loads started / finished since the tracker started (three loaders + /assets/ fetches) */
  started: number;
  done: number;
  /** manifest bytes of the files started / finished */
  bytesTotal: number;
  bytesDone: number;
  /** performance.now() of the last start or finish */
  lastChange: number;
}

const p: AssetProgress = { started: 0, done: 0, bytesTotal: 0, bytesDone: 0, lastChange: 0 };
const inFlight = new Set<string>();
const seen = new Set<string>();
let installed = false;
let sizeOf: Map<string, number> | null = null;

function bytesFor(url: string): number {
  const m = getAssetManifest();
  if (!m) return 0;
  if (!sizeOf) {
    sizeOf = new Map();
    for (const e of Object.values(m.files)) {
      sizeOf.set(`${m.base}${e.url}`, e.bytes);
      for (const alt of Object.values(e.alt ?? {})) if (alt) sizeOf.set(`${m.base}${alt}`, e.bytes);
    }
  }
  try {
    const path = new URL(url, location.href).pathname;
    return sizeOf.get(path) ?? 0;
  } catch { return 0; }
}

const key = (url: string) => { try { return new URL(url, location.href).pathname; } catch { return url; } };

function start(url: string): void {
  const k = key(url);
  if (inFlight.has(k) || seen.has(k)) return;
  inFlight.add(k);
  p.started++;
  p.bytesTotal += bytesFor(url);
  p.lastChange = performance.now();
}
function end(url: string): void {
  const k = key(url);
  if (seen.has(k)) return;
  if (!inFlight.has(k)) { start(url); }
  inFlight.delete(k);
  seen.add(k);
  p.done++;
  p.bytesDone += bytesFor(url);
  p.lastChange = performance.now();
}

/** start tracking (idempotent; call as early as possible) */
export function installTracker(): void {
  if (installed) return;
  installed = true;
  const mgr = THREE.DefaultLoadingManager as unknown as { itemStart(u: string): void; itemEnd(u: string): void; itemError(u: string): void };
  const s0 = mgr.itemStart.bind(mgr), e0 = mgr.itemEnd.bind(mgr), x0 = mgr.itemError.bind(mgr);
  mgr.itemStart = (u) => { try { if (!u.startsWith('blob:') && !u.startsWith('data:')) start(u); } catch { /* ignore */ } s0(u); };
  mgr.itemEnd = (u) => { try { if (!u.startsWith('blob:') && !u.startsWith('data:')) end(u); } catch { /* ignore */ } e0(u); };
  mgr.itemError = (u) => { try { end(u); } catch { /* ignore */ } x0(u); };
  // plain fetches (sound effects, clip maps) only show up when finished: count them as started + done
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (!e.name.includes('/assets/') || e.name.endsWith('manifest.json')) continue;
        end(e.name);
      }
    }).observe({ type: 'resource', buffered: false });
  } catch { /* old browser */ }
}

export function assetProgress(): Readonly<AssetProgress> & { pending: number } {
  return { ...p, pending: inFlight.size };
}

export function fmtMB(bytes: number): string {
  return `${(bytes / 1048576).toFixed(bytes > 10 * 1048576 ? 0 : 1)} MB`;
}
