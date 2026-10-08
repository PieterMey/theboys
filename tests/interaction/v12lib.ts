// v1.2 (G3) test helpers: a containersOf test double, door / container stand spots, a ws-test server (connect to
// PORT, or spawn a temporary dev server), noise diffs via dbg.players.noise and small waits.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import type { ContainerInfo, ContainerKind } from '../../packages/shared/src/procgen/containers.ts';
import { containersOf } from '../../packages/shared/src/procgen/containers.ts';
import type { Bot } from './bot.ts';

export const ROOT = resolve(import.meta.dirname, '../..');
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const HOSTS: Record<string, ContainerKind> = {
  desk: 'desk', cabinet: 'cabinet', filing: 'filing', tool_chest: 'tool_chest', counter: 'counter', morgue_drawers: 'morgue_drawers',
};

const owner = (L: LevelLayout, x: number, z: number): number => {
  const cx = Math.floor(x), cz = Math.floor(z);
  return cx < 0 || cz < 0 || cx >= L.W || cz >= L.H ? -1 : (L.owner[cz * L.W + cx] ?? -1);
};

/**
 * Test double for E1's containersOf until it lands: furniture props (desk, cabinet, filing, tool chest, counter,
 * morgue drawers) whose front cell is walkable, <= 3 per room, <= 32 per site; one drawer part (idx 2 = main) with its
 * slot just in front of the host.
 */
export function fakeContainers(L: LevelLayout): ContainerInfo[] {
  const out: ContainerInfo[] = [];
  const perRoom = new Map<number, number>();
  for (const it of L.items) {
    if (it.kind !== 'prop') continue;
    const kind = HOSTS[String(it.data?.prop ?? '')];
    const sp = L.spaces[it.space];
    if (!kind || !sp || sp.kind === 'outside' || sp.kind === 'vault' || sp.type === 'van') continue;
    if ((perRoom.get(it.space) ?? 0) >= 3) continue;
    const rot = it.rot ?? 0;
    const fx = Math.round(Math.sin(rot)), fz = Math.round(Math.cos(rot));
    const d = Number(it.data?.d ?? 0.5);
    const fcx = it.x + fx * (d / 2 + 0.55), fcz = it.z + fz * (d / 2 + 0.55);
    if (owner(L, fcx, fcz) !== it.space) continue;
    perRoom.set(it.space, (perRoom.get(it.space) ?? 0) + 1);
    out.push({
      id: it.id, prop: String(it.data?.prop), kind, space: it.space, roomType: sp.type, x: it.x, z: it.z, rot,
      p: [it.x + fx * (d / 2), 0.78, it.z + fz * (d / 2)], front: [Math.floor(fcx), Math.floor(fcz)],
      parts: [{ idx: 2, kind: 'drawer', local: [0, 0.75, d / 2], size: [0.4, 0.14, 0.4], travel: 0.3, slot: [it.x + fx * (d / 2 + 0.12), 0.72, it.z + fz * (d / 2 + 0.12)] }],
      main: 2, tier: 0,
    });
    if (out.length >= 32) break;
  }
  return out;
}

/** E1's containers when they exist, else the test double (installed on the server with dbg.interaction.containers) */
export async function ensureContainers(bot: Bot, L: LevelLayout): Promise<{ list: readonly ContainerInfo[]; real: boolean }> {
  const real = containersOf(L);
  if (real.length) return { list: real, real: true };
  const list = fakeContainers(L);
  await bot.dbg('interaction.containers', { list });
  await bot.settle(150);
  return { list, real: false };
}

/** where to stand to use a container (its front cell centre), facing it */
export function containerStand(c: ContainerInfo): [number, number] {
  return [c.front[0] + 0.5, c.front[1] + 0.5];
}

export interface Noise { x: number; z: number; radiusM: number; kind: string; source: string; t: number }

/** recent noises (players' noise bus) after server time t */
export async function noisesSince(bot: Bot, t: number): Promise<Noise[]> {
  const list = await bot.dbg<Noise[]>('players.noise').catch(() => [] as Noise[]);
  return (list ?? []).filter((n) => n.t > t && !/Step$/.test(n.kind));
}

/** server time (ms) from the latest snapshot / event */
export function serverNow(bot: Bot): number {
  const ev = bot.events[bot.events.length - 1];
  return Math.max(bot.lastSnap?.t ?? 0, ev?.t ?? 0);
}

/** place a player's server pose directly (no footsteps, no spawn lock) */
export async function place(bot: Bot, x: number, z: number, yaw = 0, pid?: string): Promise<void> {
  await bot.dbg('interaction.pose', { pid: pid ?? bot.me, x, z, yaw });
}

export async function waitFor(pred: () => boolean | Promise<boolean>, ms = 3000, step = 40): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await pred()) return true;
    await sleep(step);
  }
  return !!(await pred());
}

/** a ws e2e server: PORT (argv[2] / env) if given, else a temporary dev server on a random port (killed by stop()) */
export async function testServer(scratch?: string): Promise<{ port: number; stop: () => void; spawned: boolean }> {
  const given = Number(process.argv[2] ?? process.env.PORT ?? 0);
  if (given > 0) return { port: given, stop: () => undefined, spawned: false };
  const dir = scratch ?? mkdtempSync(join(tmpdir(), 'g3-e2e-'));
  const child: ChildProcess = spawn(process.execPath, ['apps/server/src/index.ts', '--dev'], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0', NODE_ENV: 'development', AI_MODE: 'mock', SAVES_DIR: join(dir, 'saves'), SESSION_FILE: join(dir, 'session.json'), LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise<number>((res, rej) => {
    const t = setTimeout(() => rej(new Error('dev server did not start in 60 s')), 60_000);
    const onData = (b: Buffer) => {
      const m = /on http:\/\/[^:]+:(\d+)/.exec(String(b));
      if (m) { clearTimeout(t); res(Number(m[1])); }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('exit', (c) => rej(new Error(`dev server exited (${c})`)));
  });
  return { port, stop: () => { try { child.kill(); } catch { /* gone */ } }, spawned: true };
}

/** PASS / FAIL reporter for the e2e scripts */
export function reporter(): { ok: (cond: unknown, msg: string) => boolean; fails: () => number } {
  let n = 0;
  return {
    ok: (cond, msg) => {
      console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
      if (!cond) n++;
      return !!cond;
    },
    fails: () => n,
  };
}
