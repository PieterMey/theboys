// Gate G (v1.2) helpers shared by tests/gates/v12-providers.mjs and tests/gates/v12-flags.mjs: the whole server booted
// in-process (dev mode, all 12 tracks, scratch SAVES_DIR / SESSION_FILE, AI_MODE=mock), a small ws bot and a PASS / FAIL
// recorder that attributes every check to its owning package.
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';

export const ROOT = resolve(import.meta.dirname, '../..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(pred, ms = 4000, step = 50) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await pred();
    if (v) return v;
    await sleep(step);
  }
  return pred();
}

export function recorder() {
  const results = [];
  const check = (pkg, name, pass, info = '') => {
    results.push({ pkg, name, pass: !!pass, info: String(info) });
    console.log(`${pass ? 'PASS' : 'FAIL'}  [${pkg}] ${name}${info !== '' ? `  (${info})` : ''}`);
    return !!pass;
  };
  const guard = async (pkg, name, fn) => {
    try { await fn(); } catch (e) { check(pkg, name, false, e instanceof Error ? e.stack?.split('\n').slice(0, 3).join(' | ') : String(e)); }
  };
  const summary = () => {
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    for (const f of failed) console.log(`  FAIL [${f.pkg}] ${f.name}${f.info ? `: ${f.info}` : ''}`);
    return failed.length;
  };
  return { results, check, guard, summary };
}

const TRACKS = ['net', 'level', 'players', 'voice', 'objectives', 'interaction', 'monsters', 'paranormal', 'meta', 'safes', 'fieldguide', 'ai'];

/** boot every server track in this process; env must not point at the live saves (it never does: scratch dirs only) */
export async function bootServer(port, scratchPrefix) {
  if (port === 3000 || port === 3100) throw new Error('refusing the live ports');
  const scratch = process.env.GATE_SCRATCH ?? mkdtempSync(join(tmpdir(), scratchPrefix));
  mkdirSync(join(scratch, 'saves'), { recursive: true });
  process.env.NODE_ENV = 'development';
  process.env.AI_MODE = 'mock';
  process.env.SAVES_DIR = join(scratch, 'saves');
  process.env.SESSION_FILE = join(scratch, 'session.json');
  const { boot } = await import('../../apps/server/src/core/boot.ts');
  const { setQuiet } = await import('../../apps/server/src/core/log.ts');
  const tracks = [];
  for (const n of TRACKS) tracks.push([n, (await import(`../../apps/server/src/${n}/index.ts`)).install]);
  if (!process.env.VERBOSE) setQuiet(true);
  const srv = await boot({ mode: 'development', port, tracks });
  return { srv, ctx: srv.ctx, scratch };
}

const { PROTOCOL_VERSION, decodeMsg, encodeMsg } = await import('../../packages/shared/src/envelope.ts');
const { randomProfile } = await import('../../packages/shared/src/profile.ts');

export class Bot {
  constructor(name) {
    this.name = name; this.key = randomBytes(16).toString('hex'); this.id = ''; this.full = null; this.events = [];
    this.n = 1; this.seq = 1; this.pending = new Map();
  }
  connect(port, crew) {
    return new Promise((res, rej) => {
      const ws = (this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`));
      ws.binaryType = 'nodebuffer';
      const t = setTimeout(() => rej(new Error(`${this.name}: no welcome`)), 15000);
      ws.on('open', () => this.send({ op: 'hello', v: PROTOCOL_VERSION, build: 'gate', crew, playerKey: this.key, name: this.name, profile: randomProfile(this.name) }));
      ws.on('message', (data) => {
        const m = decodeMsg(data);
        if (m.op === 'welcome') { this.id = m.you; this.full = m.state; clearTimeout(t); res(); }
        else if (m.op === 'ev') {
          if (m.e === 'phase') this.full = m.d.state;
          if (m.e === 'meta.update' && this.full) Object.assign(this.full, { meta: m.d.meta, workOrders: m.d.workOrders, activeOrder: m.d.activeOrder });
          this.events.push({ e: m.e, d: m.d, at: Date.now() });
          if (this.events.length > 3000) this.events.splice(0, 1000);
        } else if (m.op === 'rep') {
          const p = this.pending.get(m.id);
          if (p) { this.pending.delete(m.id); if (m.ok) p.res(m.d); else p.rej(new Error(m.err ?? 'req failed')); }
        } else if (m.op === 'err') rej(new Error(`${this.name}: ${m.code} ${m.msg}`));
      });
      ws.on('error', rej);
    });
  }
  send(m) { this.ws.send(encodeMsg(m)); }
  req(r, a = {}, ms = 10000) {
    const id = this.n++;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.send({ op: 'req', id, r, a });
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error(`${r} timed out`)); }, ms);
    });
  }
  /** resolves to the error text instead of rejecting */
  async reqErr(r, a = {}) {
    try { return { ok: true, d: await this.req(r, a) }; } catch (e) { return { ok: false, err: e instanceof Error ? e.message : String(e) }; }
  }
  dbg(r, a = {}) { return this.req(`dbg.${r}`, a); }
  pose(x, z, stance = 0, yaw = 0, light = 0) { this.send({ op: 'pose', seq: this.seq++, p: [x, 0, z], yaw, pitch: 0, stance, anim: 0, light }); }
  get phase() { return this.full?.phase ?? '' }
  waitPhase(phase, ms = 30000) { return waitFor(() => this.phase === phase, ms, 50); }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

let codeN = 0;
/** a fresh crew code (consonants only) */
export function crewCode(prefix) {
  const A = 'BCDFGHJKLMNPQRSTVWXZ';
  const n = Date.now() + codeN++ * 7919;
  return `${prefix}${A[n % 20]}${A[Math.floor(n / 20) % 20]}${A[Math.floor(n / 400) % 20]}`.slice(0, 6);
}

/** hub -> drive -> contract through the real meta flow (leader picks `order`, everyone readies, dbg skips the drive) */
export async function toContract(bots, order) {
  const lead = bots[0];
  const o = order ?? lead.full?.workOrders?.find((x) => x.available) ?? lead.full?.workOrders?.[0];
  if (!o) throw new Error('no work order on the board');
  await lead.req('meta.pick', { orderId: o.id });
  for (const b of bots) await b.req('meta.ready', { ready: true });
  if (!(await lead.waitPhase('drive', 15000))) throw new Error(`no drive (phase ${lead.phase})`);
  await sleep(200);
  const driveState = lead.full?.meta?.drive ?? null;
  await lead.dbg('meta.skipDrive');
  if (!(await lead.waitPhase('contract', 60000))) throw new Error(`no contract (phase ${lead.phase})`);
  await sleep(500);
  return { order: o, driveState };
}
