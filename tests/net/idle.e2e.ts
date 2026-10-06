// Track ① Net: an idle socket must survive 3+ minutes through the tunnel (quick tunnels cut idle sockets at
// ~125 s; the server's ws.ping every 20 s keeps them alive). The bot sends NOTHING after the welcome
// (no app-level pings, no poses), then checks the socket is still open and a request round-trips.
// Run: IDLE_URL=wss://<host>.trycloudflare.com/ws IDLE_CREW=ABCD IDLE_SEC=200 node tests/net/idle.e2e.ts
import { Bot } from './bot.ts';

const url = process.env.IDLE_URL ?? 'ws://127.0.0.1:3001/ws';
const crew = process.env.IDLE_CREW ?? 'IDLE';
const sec = Number(process.env.IDLE_SEC ?? 200);
const b = new Bot({ url, name: 'Idler', crew });
const w = await b.connect(15_000);
console.log(`joined ${w.crew.code} as ${w.you} via ${url}; idling ${sec} s ...`);
let closedAt = 0;
b.ws!.on('close', (code: number) => { closedAt = Date.now(); console.log(`socket closed (code ${code}) after ${((Date.now() - t0) / 1000).toFixed(1)} s`); });
const t0 = Date.now();
await new Promise((r) => setTimeout(r, sec * 1000));
let ok = !closedAt;
if (ok) {
  try {
    await b.req('dbg.ping').catch((e: Error) => { if (!/unknown request/.test(e.message)) throw e; });
  } catch (e) {
    ok = false;
    console.log('round trip failed', e);
  }
}
console.log(`${ok ? 'PASS' : 'FAIL'}  idle ${sec} s socket survived (${ok ? 'open + req round trip' : 'closed'})`);
b.close();
process.exitCode = ok ? 0 : 1;
setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
