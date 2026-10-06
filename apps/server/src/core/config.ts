// Config loader: config/flags.json + config/balance/<domain>.json (namespaced by file name: balance.core,
// balance.voice, ...). Reload updates the SAME objects in place so references held by tracks stay valid.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export const ROOT = resolve(import.meta.dirname, '../../../..');
/** Shared data root (.env, .assets, tools/bin) — worktrees point here via DATA_ROOT. */
export const DATA_ROOT = process.env.DATA_ROOT ?? 'C:/Users/Pieter/repos/theboys';

export type Flags = Record<string, boolean>;
/** balance[domain][key]; domain = file name in config/balance without .json */
export type Balance = Record<string, Record<string, unknown>> & { core: Record<string, unknown> };

export type Mode = 'development' | 'production' | 'test';
export type AiMode = 'mock' | 'record' | 'replay' | 'live';

export interface ServerEnv {
  mode: Mode;
  /** mode === 'development' (enables dbg.* requests, Vite middleware, auto-created crews) */
  dev: boolean;
  HOST: string;
  PORT: number;
  BASE_URL: string;
  STT_URL: string;
  AI_MODE: AiMode;
  /** admin token (env ADMIN_TOKEN or random per process); printed at startup */
  ADMIN_TOKEN: string;
  /** directory holding .assets (served: <ASSETS_DIR>/dist at /assets/) */
  ASSETS_DIR: string;
  ROOT: string;
  CLIENT_DIST: string;
  MODEL_WRITER: string;
  MODEL_FAST: string;
}

export interface AppConfig {
  flags: Flags;
  balance: Balance;
  env: ServerEnv;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function replaceContents(target: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const k of Object.keys(target)) if (!(k in src)) delete target[k];
  Object.assign(target, src);
}

export function readFlags(root = ROOT): Flags {
  const p = join(root, 'config/flags.json');
  return existsSync(p) ? (readJson(p) as Flags) : {};
}

export function readBalance(root = ROOT): Balance {
  const dir = join(root, 'config/balance');
  const out: Record<string, Record<string, unknown>> = { core: {} };
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).sort()) {
      if (f.endsWith('.json')) out[f.slice(0, -5)] = readJson(join(dir, f));
    }
  }
  return out as Balance;
}

export function makeEnv(mode: Mode, portOverride?: number): ServerEnv {
  const e = process.env;
  const PORT = portOverride ?? Number(e.PORT ?? 3000);
  const assets = e.ASSETS_DIR ?? (existsSync(join(ROOT, '.assets')) ? join(ROOT, '.assets') : join(DATA_ROOT, '.assets'));
  const aiMode = (e.AI_MODE ?? 'mock') as AiMode;
  return {
    mode,
    dev: mode === 'development',
    HOST: '127.0.0.1',
    PORT,
    BASE_URL: e.BASE_URL ?? `http://127.0.0.1:${PORT}`,
    STT_URL: e.STT_URL ?? 'http://127.0.0.1:3100',
    AI_MODE: ['mock', 'record', 'replay', 'live'].includes(aiMode) ? aiMode : 'mock',
    ADMIN_TOKEN: e.ADMIN_TOKEN ?? randomBytes(12).toString('hex'),
    ASSETS_DIR: assets,
    ROOT,
    CLIENT_DIST: process.env.CLIENT_DIST || join(ROOT, 'apps/client/dist'),
    MODEL_WRITER: e.MODEL_WRITER ?? 'claude-opus-5-5',
    MODEL_FAST: e.MODEL_FAST ?? 'claude-haiku-4-5',
  };
}

export function loadConfig(mode: Mode, portOverride?: number): AppConfig {
  return { flags: readFlags(), balance: readBalance(), env: makeEnv(mode, portOverride) };
}

/** Re-read flags + balance into the existing objects. Throws on invalid JSON (caller logs; old values kept). */
export function reloadInto(cfg: AppConfig): void {
  const flags = readFlags();
  const balance = readBalance();
  replaceContents(cfg.flags, flags);
  replaceContents(cfg.balance, balance);
}
