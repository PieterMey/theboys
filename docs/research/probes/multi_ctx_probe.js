const path = require('path'); const http = require('http');
const { chromium } = require(path.join(__dirname, '..', 'tmcp_deps', 'node_modules', 'playwright-core'));
const HTML = `<!doctype html><canvas id=c width=1280 height=720></canvas><script>
(async()=>{const a=await navigator.gpu.requestAdapter();const d=await a.requestDevice();const ctx=document.getElementById('c').getContext('webgpu');
ctx.configure({device:d,format:navigator.gpu.getPreferredCanvasFormat()});let n=0;const t0=performance.now();
await new Promise(r=>{(function f(){const e=d.createCommandEncoder();const p=e.beginRenderPass({colorAttachments:[{view:ctx.getCurrentTexture().createView(),loadOp:'clear',storeOp:'store',clearValue:{r:0,g:.5,b:1,a:1}}]});p.end();d.queue.submit([e.finish()]);n++;if(performance.now()-t0<3000)requestAnimationFrame(f);else r();})();});
window.__r={arch:a.info.architecture,fps:Math.round(n/3)};})();</script>`;
(async () => {
  const s = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(HTML); }).listen(0, '127.0.0.1');
  await new Promise(r => s.on('listening', r)); const url = `http://127.0.0.1:${s.address().port}/`;
  const b = await chromium.launch({ channel: 'chrome', headless: true });
  const pages = await Promise.all([0, 1, 2, 3].map(async () => (await b.newContext({ viewport: { width: 1280, height: 720 } })).newPage()));
  await Promise.all(pages.map(p => p.goto(url)));
  const res = await Promise.all(pages.map(p => p.waitForFunction(() => window.__r, null, { timeout: 20000 }).then(h => h.jsonValue())));
  console.log('4 contexts / 1 browser:', JSON.stringify(res)); await b.close(); s.close();
})();
