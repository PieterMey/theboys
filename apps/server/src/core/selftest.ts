// `node apps/server/src/index.ts --selftest`: boot on a random port (mode 'test', all tracks installed strictly),
// connect 2 ws clients to one crew, assert both get welcome + snap within 2 s, check a req round trip and that
// secret paths 404. Prints OK and exits 0, else exits 1.
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, decodeMsg, encodeMsg } from '@dead-air/shared/envelope.ts';
import type { ClientMsg, ServerMsg } from '@dead-air/shared/envelope.ts';
import { randomProfile } from '@dead-air/shared/profile.ts';
import { boot } from './boot.ts';
import type { TrackInstall } from './boot.ts';
import { setQuiet } from './log.ts';

interface ClientResult { name: string; welcome: Extract<ServerMsg, { op: 'welcome' }>; snaps: number; rosterMax: number; repErr: string }

function client(url: string, name: string, crew: string, timeoutMs: number): Promise<ClientResult> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'nodebuffer';
    const send = (m: ClientMsg) => ws.send(encodeMsg(m));
    let welcome: ClientResult['welcome'] | null = null;
    let snaps = 0;
    let rosterMax = 0;
    let repErr = '';
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`${name}: timeout (welcome=${!!welcome}, snaps=${snaps}, rep=${repErr || 'none'})`));
    }, timeoutMs);
    const check = () => {
      if (welcome && snaps > 0 && repErr && rosterMax >= 2) {
        clearTimeout(timer);
        ws.close();
        resolve({ name, welcome, snaps, rosterMax, repErr });
      }
    };
    ws.on('open', () => {
      const playerKey = randomBytes(16).toString('hex');
      send({ op: 'hello', v: PROTOCOL_VERSION, build: 'selftest', crew, playerKey, name, profile: randomProfile(name) });
    });
    ws.on('message', (data: Buffer) => {
      const m = decodeMsg<ServerMsg>(data);
      if (m.op === 'welcome') {
        welcome = m;
        rosterMax = Math.max(rosterMax, m.crew.players.length);
        send({ op: 'pose', seq: 1, p: [1, 0, 2], yaw: 0, pitch: 0, stance: 0, anim: 0, light: 1 });
        send({ op: 'req', id: 1, r: 'selftest.nope' as never, a: {} });
      } else if (m.op === 'snap') snaps++;
      else if (m.op === 'ev' && m.e === 'crew') rosterMax = Math.max(rosterMax, (m.d as { players: unknown[] }).players.length);
      else if (m.op === 'rep' && m.id === 1) repErr = m.ok ? 'unexpected ok' : (m.err ?? 'err');
      else if (m.op === 'err') reject(new Error(`${name}: server err ${m.code}: ${m.msg}`));
      check();
    });
    ws.on('error', (e) => reject(new Error(`${name}: ${e.message}`)));
  });
}

/** Let handles drain naturally (process.exit while sockets close trips a libuv assert on Windows). */
function finish(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 1500).unref();
}

export async function runSelftest(tracks: [string, TrackInstall][]): Promise<void> {
  const t0 = performance.now();
  setQuiet(true);
  let srv: Awaited<ReturnType<typeof boot>> | null = null;
  try {
    srv = await boot({ mode: 'test', port: 0, tracks, strict: true });
    const url = `ws://127.0.0.1:${srv.port}/ws`;
    const [a, b] = await Promise.all([client(url, 'Alpha', 'SELF', 2000), client(url, 'Bravo', 'SELF', 2000)]);
    if (a.welcome.crew.code !== 'SELF' || b.welcome.crew.code !== 'SELF') throw new Error('clients landed in different crews');
    if (a.welcome.you === b.welcome.you) throw new Error('both clients got the same player id');
    if (!a.repErr.startsWith('unknown request')) throw new Error(`unexpected rep: ${a.repErr}`);
    for (const p of ['/.env', '/saves/crews/x.json', '/logs/ai-usage.jsonl', '/.git/config']) {
      const r = await fetch(`http://127.0.0.1:${srv.port}${p}`);
      if (r.status !== 404) throw new Error(`${p} returned ${r.status} (expected 404)`);
    }
    const h = await fetch(`http://127.0.0.1:${srv.port}/healthz`);
    if (!h.ok) throw new Error(`/healthz ${h.status}`);
    const ms = Math.round(performance.now() - t0);
    console.log(`selftest OK: 2 clients joined crew SELF, welcome+snap (${a.snaps}/${b.snaps} snaps), req round trip, 404s ok, ${tracks.length} tracks installed (${ms} ms)`);
    await srv.close();
    finish(0);
  } catch (e) {
    console.error('selftest FAILED:', e instanceof Error ? e.message : e);
    try { await srv?.close(); } catch { /* ignore */ }
    finish(1);
  }
}
