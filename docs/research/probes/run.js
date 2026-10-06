// node run.js <channel: chrome|msedge> <parts comma list>
const path = require('path');
const fs = require('fs');
const http = require('http');
const HERE = __dirname;
const SCRATCH = path.resolve(HERE, '..');
const { chromium } = require(path.join(SCRATCH, 'tmcp_deps', 'node_modules', 'playwright-core'));
const channel = process.argv[2] || 'chrome';
const parts = (process.argv[3] || 'api,ec,two,remote,chunks,panner,glitch,trace,bg').split(',');
const WAV = path.join(HERE, 'out', 'tone440.wav');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function traceRun(browser, page, mode) {
  const cdp = await browser.newBrowserCDPSession();
  const chunks = [];
  cdp.on('Tracing.dataCollected', e => chunks.push(...e.value));
  const done = new Promise(r => cdp.on('Tracing.tracingComplete', r));
  await cdp.send('Tracing.start', { traceConfig: { includedCategories: ['disabled-by-default-audio', 'audio', 'webrtc', 'disabled-by-default-webrtc'] }, transferMode: 'ReportEvents' });
  let settings;
  try { settings = await page.evaluate(m => aecMixProbe(m), mode); } catch (e) { settings = 'ERR ' + e.message.split('\n')[0]; }
  await cdp.send('Tracing.end');
  await done;
  await cdp.detach();
  const counts = {};
  for (const ev of chunks) {
    const n = ev.name || '';
    if (/Mix|Listen|Loopback|Aec|Echo|Processor|Reference|Tapper|OutputDevice/i.test(n)) counts[n] = (counts[n] || 0) + 1;
  }
  return { settings, eventCounts: counts, totalEvents: chunks.length };
}

(async () => {
  const html = fs.readFileSync(path.join(HERE, 'probe.html'));
  const server = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(html); }).listen(0, '127.0.0.1');
  await new Promise(r => server.on('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({
    channel, headless: true,
    ignoreDefaultArgs: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${WAV}`, '--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.setDefaultTimeout(120000);
  const consoleErrs = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrs.push(m.text()); });
  page.on('pageerror', e => consoleErrs.push('pageerror ' + e.message));
  await page.goto(url);
  const res = { channel, version: browser.version() };
  const run = async (name, fn) => { if (!parts.includes(name)) return; try { res[name] = await fn(); } catch (e) { res[name] = 'ERR ' + e.message.split('\n')[0]; } };
  await run('api', () => page.evaluate(() => apiSurface()));
  await run('ec', () => page.evaluate(() => ecCaps()));
  await run('two', () => page.evaluate(() => twoTracks()));
  await run('remote', () => page.evaluate(() => remoteTests()));
  await run('chunks', () => page.evaluate(() => chunkTest()));
  await run('panner', () => page.evaluate(() => pannerModels()));
  await run('glitch', () => page.evaluate(() => pannerGlitch()));
  await run('trace', async () => {
    const out = {};
    for (const mode of ['true', 'remote-only', 'all', 'false']) out[mode] = await traceRun(browser, page, mode);
    return out;
  });
  await run('bg', async () => {
    await page.evaluate(() => bgSetup());
    await sleep(1500);
    const r1 = await page.evaluate(() => bgRead());
    const p2 = await ctx.newPage();
    await p2.goto('about:blank');
    await p2.bringToFront();
    await sleep(5000);
    const r2 = await page.evaluate(() => bgRead());
    await page.bringToFront();
    return { before: r1, after5sHidden: r2, deltas: { raf: r2.raf - r1.raf, workletQuantaApprox: r2.worklet - r1.worklet, timerTicks: r2.timer - r1.timer, acTime: +(r2.acTime - r1.acTime).toFixed(2) } };
  });
  res.consoleErrs = consoleErrs.slice(0, 10);
  const outFile = path.join(HERE, 'out', `result_${channel}.json`);
  fs.writeFileSync(outFile, JSON.stringify(res, null, 1));
  console.log(JSON.stringify(res, null, 1));
  await browser.close(); server.close();
})().catch(e => { console.error(e); process.exit(1); });
