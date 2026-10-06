// Probe: does Playwright-launched Chrome (installed channel) get a real WebGPU adapter on this
// Windows host in headless vs headed mode, does the canvas show up in screenshots, what rAF rate
// do we get, and does --use-file-for-fake-audio-capture feed a WAV into getUserMedia?
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const SCRATCH = path.resolve(__dirname, '..');
const { chromium } = require(path.join(SCRATCH, 'tmcp_deps', 'node_modules', 'playwright-core'));
const OUT = path.join(SCRATCH, 'tmcp_out');

const HTML = `<!doctype html><html><body style="margin:0;background:#000">
<canvas id="c" width="640" height="360" style="width:640px;height:360px"></canvas>
<script>
async function run() {
  const out = { secure: isSecureContext, hasGpu: !!navigator.gpu, ua: navigator.userAgent };
  try {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    out.adapter = adapter ? { vendor: adapter.info?.vendor, architecture: adapter.info?.architecture,
      device: adapter.info?.device, description: adapter.info?.description,
      isFallback: adapter.info?.isFallbackAdapter, maxTex2D: adapter.limits.maxTextureDimension2D,
      nFeatures: [...adapter.features].length, hasTimestamp: adapter.features.has('timestamp-query') } : null;
    if (adapter) {
      const device = await adapter.requestDevice();
      const ctx = document.getElementById('c').getContext('webgpu');
      ctx.configure({ device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: 'opaque' });
      let frames = 0; const t0 = performance.now();
      await new Promise(res => { (function f() {
        const enc = device.createCommandEncoder();
        const pass = enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(),
          loadOp: 'clear', storeOp: 'store', clearValue: { r: 1, g: 0, b: 1, a: 1 } }] });
        pass.end(); device.queue.submit([enc.finish()]); frames++;
        if (performance.now() - t0 < 2000) requestAnimationFrame(f); else res();
      })(); });
      out.rafFps = Math.round(frames / ((performance.now() - t0) / 1000));
    }
  } catch (e) { out.gpuError = String(e); }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ac = new AudioContext(); await ac.resume();
    const an = ac.createAnalyser(); an.fftSize = 8192;
    ac.createMediaStreamSource(stream).connect(an);
    await new Promise(r => setTimeout(r, 1500));
    const buf = new Float32Array(an.frequencyBinCount); an.getFloatFrequencyData(buf);
    let m = 1; for (let i = 1; i < buf.length; i++) if (buf[i] > buf[m]) m = i;
    out.audio = { ctxState: ac.state, peakHz: Math.round(m * ac.sampleRate / an.fftSize), peakDb: Math.round(buf[m]),
      label: stream.getAudioTracks()[0].label };
  } catch (e) { out.audioError = String(e); }
  window.__result = out;
}
run();
</script></body></html>`;

function pngPixel(file, x, y) { // minimal PNG decoder (8-bit RGB/RGBA, non-interlaced)
  const b = fs.readFileSync(file); let p = 8, w, h, ct, idat = [];
  while (p < b.length) { const len = b.readUInt32BE(p), type = b.toString('ascii', p + 4, p + 8), d = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; } else if (type === 'IDAT') idat.push(d); p += 12 + len; }
  const bpp = ct === 6 ? 4 : 3, raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, img = Buffer.alloc(h * stride);
  for (let r = 0; r < h; r++) { const f = raw[r * (stride + 1)], s = raw.subarray(r * (stride + 1) + 1, (r + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) { const a = i >= bpp ? img[r * stride + i - bpp] : 0, up = r ? img[(r - 1) * stride + i] : 0,
      c = r && i >= bpp ? img[(r - 1) * stride + i - bpp] : 0; let v = s[i];
      if (f === 1) v += a; else if (f === 2) v += up; else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { const pp = a + up - c, pa = Math.abs(pp - a), pb = Math.abs(pp - up), pc = Math.abs(pp - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? up : c); }
      img[r * stride + i] = v & 255; } }
  const o = y * stride + x * bpp; return [img[o], img[o + 1], img[o + 2]];
}

async function probe(name, opts, wav) {
  const args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required', ...(opts.extraArgs || [])];
  const t0 = Date.now();
  const browser = await chromium.launch({ channel: 'chrome', headless: opts.headless, args });
  const res = { name, launchMs: Date.now() - t0, version: browser.version() };
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    const logs = []; page.on('console', m => logs.push(`${m.type()}: ${m.text()}`));
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.waitForFunction(() => window.__result, null, { timeout: 30000 });
    Object.assign(res, await page.evaluate(() => window.__result));
    const shot = path.join(OUT, `probe_${name}.png`); await page.screenshot({ path: shot });
    res.centerPixel = pngPixel(shot, 320, 180);
    if (opts.gpuPage) {
      const gp = await page.context().newPage(); await gp.goto('chrome://gpu'); await gp.waitForTimeout(1500);
      const txt = await gp.evaluate(() => document.body.innerText || '');
      // chrome://gpu content lives in shadow DOM in recent versions; fall back to deep text walk
      const deep = await gp.evaluate(() => { const acc = []; (function walk(n) { if (n.shadowRoot) walk(n.shadowRoot);
        for (const c of n.childNodes) { if (c.nodeType === 3) acc.push(c.textContent); else walk(c); } })(document.documentElement); return acc.join('\n'); });
      res.gpuPageLines = (deep || txt).split('\n').map(s => s.trim()).filter(s => /WebGPU|WebGL|Hardware accelerated|Software only|ANGLE|GL_RENDERER|Direct3D|D3D|Vulkan|Skia Backend/i.test(s)).slice(0, 25);
    }
    res.consoleErrors = logs.filter(l => l.startsWith('error')).slice(0, 5);
  } catch (e) { res.error = String(e); }
  await browser.close();
  return res;
}

let PORT;
(async () => {
  const server = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(HTML); }).listen(0, '127.0.0.1');
  await new Promise(r => server.on('listening', r)); PORT = server.address().port;
  const w440 = path.join(OUT, 'tone440.wav'), w880 = path.join(OUT, 'tone880.wav');
  const runs = (process.argv[2] || 'headless,headless_unsafe,headless_uncapped,headed').split(',');
  const results = [];
  for (const r of runs) {
    if (r === 'headless') results.push(await probe('headless', { headless: true, gpuPage: true }, w440));
    if (r === 'headless_unsafe') results.push(await probe('headless_unsafe', { headless: true, extraArgs: ['--enable-unsafe-webgpu'] }, w880));
    if (r === 'headless_uncapped') results.push(await probe('headless_uncapped', { headless: true, extraArgs: ['--disable-gpu-vsync', '--disable-frame-rate-limit'] }, w440));
    if (r === 'headed') results.push(await probe('headed', { headless: false, gpuPage: true }, w880));
    if (r === 'headed_uncapped') results.push(await probe('headed_uncapped', { headless: false, extraArgs: ['--disable-gpu-vsync', '--disable-frame-rate-limit'] }, w880));
  }
  console.log(JSON.stringify(results, null, 1));
  server.close();
})();
