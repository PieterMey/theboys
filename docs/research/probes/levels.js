// For each constraint set, launch a fresh headless Chrome whose fake mic plays levels.wav once (%noloop),
// capture the track's power envelope (4864-frame windows) with an AudioWorklet, align it to the file's own
// envelope by cross-correlation, and report per-segment active-speech level (dBFS) in vs out.
const path = require('path');
const fs = require('fs');
const http = require('http');
const HERE = __dirname;
const SCRATCH = path.resolve(HERE, '..');
const { chromium } = require(path.join(SCRATCH, 'tmcp_deps', 'node_modules', 'playwright-core'));
const WAV = path.join(HERE, 'out', 'levels.wav');
const REF = JSON.parse(fs.readFileSync(path.join(HERE, 'out', 'levels.json'), 'utf8'));
const PAGE = `<!doctype html><html><body><script>
const sleep = ms => new Promise(r => setTimeout(r, ms));
window.capture = async (constraints, seconds) => {
  const s = await navigator.mediaDevices.getUserMedia({ audio: constraints });
  const st = s.getAudioTracks()[0].getSettings();
  const ac = new AudioContext({ sampleRate: 48000 });
  const code = "class Env extends AudioWorkletProcessor { constructor(){ super(); this.acc = 0; this.n = 0; this.buf = []; } process(inputs){ const ch = inputs[0] && inputs[0][0]; if (ch) { for (let i = 0; i < ch.length; i++) this.acc += ch[i] * ch[i]; } this.n += 128; if (this.n >= ${REF.W}) { this.buf.push(this.acc / this.n); this.acc = 0; this.n = 0; if (this.buf.length >= 5) { this.port.postMessage(this.buf); this.buf = []; } } return true; } } registerProcessor('env', Env);";
  await ac.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
  const node = new AudioWorkletNode(ac, 'env');
  const mute = new GainNode(ac, { gain: 0 });
  ac.createMediaStreamSource(s).connect(node).connect(mute).connect(ac.destination);
  const env = []; node.port.onmessage = e => { for (const v of e.data) env.push(+(10 * Math.log10(v + 1e-20)).toFixed(2)); };
  await ac.resume();
  await sleep(seconds * 1000);
  await ac.close(); s.getTracks().forEach(t => t.stop());
  return { settings: { ec: st.echoCancellation, agc: st.autoGainControl, ns: st.noiseSuppression }, env };
};
</script></body></html>`;
const configs = {
  raw: { echoCancellation: false, autoGainControl: false, noiseSuppression: false },
  agcOnly: { echoCancellation: false, autoGainControl: true, noiseSuppression: false },
  nsOnly: { echoCancellation: false, autoGainControl: false, noiseSuppression: true },
  full: { echoCancellation: true, autoGainControl: true, noiseSuppression: true },
};
function align(ref, cap) {
  // lag L such that cap[i + L] ~ ref[i]; maximize correlation of clamped dB envelopes
  const c = v => Math.max(v, -80);
  let best = -Infinity, bestL = 0;
  for (let L = -40; L < 40; L++) {
    let s = 0, n = 0;
    for (let i = Math.max(0, -L); i < ref.length && i + L < cap.length; i++) { s += (c(ref[i]) + 80) * (c(cap[i + L]) + 80); n++; }
    const m = s / Math.max(n, 1); if (m > best) { best = m; bestL = L; }
  }
  return bestL;
}
const pDb = arr => +(10 * Math.log10(arr.reduce((a, v) => a + 10 ** (v / 10), 0) / arr.length)).toFixed(1);
(async () => {
  const server = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(PAGE); }).listen(0, '127.0.0.1');
  await new Promise(r => server.on('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const dur = REF.env.length * REF.W / 48000 + 2.5;
  const result = {};
  for (const [name, cons] of Object.entries(configs)) {
    const browser = await chromium.launch({ channel: 'chrome', headless: true,
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${WAV}%noloop`, '--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage(); page.setDefaultTimeout(120000);
    await page.goto(url);
    const { settings, env } = await page.evaluate(([c, d]) => capture(c, d), [cons, dur]);
    await browser.close();
    const L = align(REF.env, env);
    const segs = {};
    for (const s of REF.segs) {
      const i0 = Math.ceil(s.start * 48000 / REF.W), i1 = Math.floor(s.end * 48000 / REF.W);
      const idx = []; for (let i = i0; i < i1; i++) idx.push(i);
      if (s.targetActiveRmsDbfs === null) { segs[s.name] = { inDb: pDb(idx.map(i => REF.env[i])), outDb: pDb(idx.map(i => env[i + L] ?? -200)) }; continue; }
      const mx = Math.max(...idx.map(i => REF.env[i]));
      const act = idx.filter(i => REF.env[i] > mx - 25);
      const half = Math.floor(act.length / 2);
      segs[s.name] = {
        inActive: pDb(act.map(i => REF.env[i])),
        outActive: pDb(act.map(i => env[i + L] ?? -200)),
        outFirstHalf: pDb(act.slice(0, half).map(i => env[i + L] ?? -200)),
        outSecondHalf: pDb(act.slice(half).map(i => env[i + L] ?? -200)),
        outPeakWindow: Math.max(...act.map(i => env[i + L] ?? -200)),
      };
    }
    result[name] = { settings, lagWindows: L, segs, env };
    console.error(name, 'done');
  }
  fs.writeFileSync(path.join(HERE, 'out', 'levels_result.json'), JSON.stringify(result, null, 1));
  console.log('saved');
  server.close();
})().catch(e => { console.error(e); process.exit(1); });
