// Probe: two separate headless Chrome processes (each with its own fake-mic WAV: 440 Hz vs 880 Hz)
// connect over WebRTC on localhost (no STUN/TURN, SDP relayed by this Node script), and each side
// measures the dominant frequency + level of the REMOTE audio through WebAudio, with and without
// attaching the remote stream to a muted <audio> element (the old Chrome remote-stream quirk),
// and through a GainNode standing in for proximity attenuation.
const path = require('path');
const http = require('http');
const SCRATCH = path.resolve(__dirname, '..');
const { chromium } = require(path.join(SCRATCH, 'tmcp_deps', 'node_modules', 'playwright-core'));
const OUT = path.join(SCRATCH, 'tmcp_out');

const HTML = `<!doctype html><html><body><script>
window.pc = null; window.remote = null;
window.setup = async () => {
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  pc = new RTCPeerConnection({ iceServers: [] });
  mic.getTracks().forEach(t => pc.addTrack(t, mic));
  window.gotTrack = new Promise(res => pc.ontrack = e => { remote = e.streams[0] || new MediaStream([e.track]); res(); });
};
const gathered = () => new Promise(r => { if (pc.iceGatheringState === 'complete') r(); else pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && r(); });
window.makeOffer = async () => { await pc.setLocalDescription(await pc.createOffer()); await gathered(); return pc.localDescription.toJSON(); };
window.takeOffer = async (o) => { await pc.setRemoteDescription(o); await pc.setLocalDescription(await pc.createAnswer()); await gathered(); return pc.localDescription.toJSON(); };
window.takeAnswer = async (a) => { await pc.setRemoteDescription(a); };
window.measure = async (attachAudioEl, gain) => {
  await gotTrack;
  if (attachAudioEl) { const el = new Audio(); el.srcObject = remote; el.muted = true; await el.play().catch(() => {}); }
  const ac = new AudioContext(); await ac.resume();
  const g = ac.createGain(); g.gain.value = gain;
  const an = ac.createAnalyser(); an.fftSize = 8192;
  ac.createMediaStreamSource(remote).connect(g).connect(an);
  await new Promise(r => setTimeout(r, 2000));
  const f = new Float32Array(an.frequencyBinCount); an.getFloatFrequencyData(f);
  let m = 1; for (let i = 1; i < f.length; i++) if (f[i] > f[m]) m = i;
  const t = new Float32Array(an.fftSize); an.getFloatTimeDomainData(t);
  const rms = Math.sqrt(t.reduce((s, v) => s + v * v, 0) / t.length);
  const stats = await pc.getStats(); let pair = null;
  stats.forEach(s => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = { rtt: s.currentRoundTripTime }; });
  ac.close();
  return { conn: pc.connectionState, peakHz: Math.round(m * ac.sampleRate / an.fftSize), peakDb: Math.round(f[m]), rms: +rms.toFixed(4), pair };
};
</script></body></html>`;

(async () => {
  const server = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(HTML); }).listen(0, '127.0.0.1');
  await new Promise(r => server.on('listening', r)); const url = `http://127.0.0.1:${server.address().port}/`;
  const launch = wav => chromium.launch({ channel: 'chrome', headless: true, args: [
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${path.join(OUT, wav)}`, '--autoplay-policy=no-user-gesture-required'] });
  const [bA, bB] = await Promise.all([launch('tone440.wav'), launch('tone880.wav')]);
  const [pA, pB] = await Promise.all([bA.newPage(), bB.newPage()]);
  await Promise.all([pA.goto(url), pB.goto(url)]);
  await Promise.all([pA.evaluate(() => setup()), pB.evaluate(() => setup())]);
  const t0 = Date.now();
  const offer = await pA.evaluate(() => makeOffer());
  const answer = await pB.evaluate(o => takeOffer(o), offer);
  await pA.evaluate(a => takeAnswer(a), answer);
  const res = { signalingMs: Date.now() - t0,
    candidateTypes: (offer.sdp.match(/a=candidate:[^\r\n]+/g) || []).map(c => c.split(' ')[4]).slice(0, 4) };
  res.A_hears_noAudioEl = await pA.evaluate(() => measure(false, 1));
  res.B_hears_noAudioEl = await pB.evaluate(() => measure(false, 1));
  res.A_hears_withAudioEl = await pA.evaluate(() => measure(true, 1));
  res.B_hears_gain_0_1 = await pB.evaluate(() => measure(true, 0.1));
  console.log(JSON.stringify(res, null, 1));
  await Promise.all([bA.close(), bB.close()]); server.close();
})().catch(e => { console.error(e); process.exit(1); });
