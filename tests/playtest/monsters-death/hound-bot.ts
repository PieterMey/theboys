// Report-only ws-bot probe on :3203 (crew MDTG): (1) is a growl cue emitted on ALERT? (2) does ONE continuous 1.2 s
// talk utterance (no pause) already make the hound wind up + charge? (3) two footsteps 1.1 s apart after the growl?
import { BAND } from '../../../packages/shared/src/constants.ts';
import { Bot, sleep } from '../../monsters/bot.ts';

const url = 'ws://127.0.0.1:3203/ws';
const a = new Bot('Probe');
const b = new Bot('Park');
await a.connect(url, 'MDTG');
await b.connect(url, 'MDTG');
const st = await a.dbg<{ ok: boolean; agents: { id: string; x: number; z: number }[] }>('monsters.start', { seed: 'probe-hound-1', players: 2, risk: 1 });
console.log('start', st.ok, st.agents.map((x) => `${x.id}@${x.x},${x.z}`).join(' '));
await sleep(300);
const L = (a.eventsOf('phase').pop()?.d as { state?: { layout?: { van: { cab: { x: number; y: number } } } } })?.state?.layout;
await b.dbg('monsters.tp', { x: L!.van.cab.x + 1, z: L!.van.cab.y + 1.5 }); // park in the sealed cab
const hound = async () => ((await a.dbg<{ agents: { id: string; state: string; x: number; z: number }[] }>('monsters.state')).agents).find((x) => x.id === 'hound0')!;
const trace = async (ms: number) => {
  const out: string[] = [];
  const t = performance.now();
  let last = '';
  while (performance.now() - t < ms) {
    const h = await hound();
    if (h.state !== last) { last = h.state; out.push(`${Math.round(performance.now() - t)}ms:${h.state}`); }
    await sleep(40);
  }
  return out.join(' -> ');
};
const cues = (since: number) => a.eventsOf('monsters.cue', since).map((e) => `${(e.d as { cue: string }).cue}@${Math.round(e.at - since)}ms`).join(' ');

async function scenario(name: string, act: () => Promise<void>): Promise<void> {
  // a fresh, calm hound with the bot ~7 m away in open space
  await a.dbg('players.kill', { id: a.id, alive: true }).catch(() => null);
  await a.dbg('interaction.revive', { pid: a.id }).catch(() => null);
  const h0 = await hound();
  await a.dbg('monsters.place', { id: 'hound0', x: h0.x, z: h0.z, state: 'idle', active: true });
  await a.dbg('monsters.tp', { x: h0.x, z: h0.z + 0.01 }); // find a nearby free cell: walk the bot out along +x/+z
  // pick the farthest of a few offsets that keeps the bot reachable (server clamps nothing; just try)
  await a.dbg('monsters.tp', { x: h0.x + 5, z: h0.z });
  await sleep(1200);
  const t = performance.now();
  const tr = trace(4000);
  await act();
  console.log(`${name}: ${await tr} | cues: ${cues(t)} | kills: ${a.eventsOf('monsters.kill', t).map((e) => JSON.stringify(e.d)).join(' ')}`);
  await sleep(500);
}

await scenario('S1 single talk utterance 1.2 s (no pause)', async () => { a.loud(BAND.talk); await sleep(1200); a.loud(BAND.silent); });
await sleep(9000);
await scenario('S2 short talk 0.4 s, then silent', async () => { a.loud(BAND.talk); await sleep(400); a.loud(BAND.silent); });
await sleep(9000);
await scenario('S3 one footstep, freeze 1.1 s, one more footstep', async () => {
  await a.dbg('monsters.noise', { radiusM: 5, kind: 'walkStep' });
  await sleep(1100);
  await a.dbg('monsters.noise', { radiusM: 5, kind: 'walkStep' });
});
a.close();
b.close();
process.exit(0);
