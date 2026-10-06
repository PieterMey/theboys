// Diagnostic: does the push-to-talk setting (localStorage deadair.voice.ptt=1) gate the mic band? (report-only)
import { launchPlayer, waitForGame } from '../../lib/launch.ts';

const BASE = 'http://127.0.0.1:3203';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const p = await launchPlayer({ name: 'Pat', wav: 'shout.wav', baseUrl: BASE, crew: 'MDTB', query: { autojoin: '1', nobright: '1' } });
await p.page.routeWebSocket(/token=/, () => {});
await p.page.addInitScript(() => {
  try {
    localStorage.setItem('deadair.voice.ptt', '1');
    localStorage.setItem('deadair.voice.base', '-21');
    localStorage.setItem('deadair.voice.cal', JSON.stringify({ noiseDb: -75, talkDb: -21, whisperDb: -35, shoutDb: -8, at: Date.now() }));
  } catch { /* ignore */ }
});
await p.page.reload({ waitUntil: 'domcontentloaded' });
await waitForGame(p.page, 90_000);
await p.page.waitForFunction(() => window.__game?.me(), undefined, { timeout: 30_000 });
const read = () => p.page.evaluate(() => {
  const vd = window.__voiceDebug as unknown as { band(): number; micSettings(): unknown } | undefined;
  return { ls: localStorage.getItem('deadair.voice.ptt'), band: vd?.band(), mic: vd?.micSettings() };
});
console.log('after join', JSON.stringify(await read()));
const samples: number[] = [];
for (let i = 0; i < 12; i++) { await sleep(250); samples.push((await read()).band ?? -1); }
console.log('no V held (3 s):', samples.join(','));
await p.page.mouse.click(640, 360).catch(() => null);
await sleep(500);
const s2: number[] = [];
for (let i = 0; i < 12; i++) { await sleep(250); s2.push((await read()).band ?? -1); }
console.log('after a click, no V held (3 s):', s2.join(','));
await p.page.keyboard.down('KeyV');
const s3: number[] = [];
for (let i = 0; i < 8; i++) { await sleep(250); s3.push((await read()).band ?? -1); }
await p.page.keyboard.up('KeyV');
console.log('V held (2 s):', s3.join(','));
const s4: number[] = [];
for (let i = 0; i < 8; i++) { await sleep(250); s4.push((await read()).band ?? -1); }
console.log('V released (2 s):', s4.join(','));
// settings UI text about push-to-talk
console.log('ptt service', await p.page.evaluate(() => { try { return JSON.stringify((window as unknown as { __game: { state(): { diag: Record<string, unknown> } } }).__game.state().diag.voice ?? null).slice(0, 400); } catch (e) { return String(e); } }));
await p.close();
process.exit(0);
