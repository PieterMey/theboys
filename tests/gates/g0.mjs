#!/usr/bin/env node
// Gate G0: check (tsc + forbidden + secrets), server selftest, gen-cli boot (if present), client build,
// prod server on :3099 (404s for secret paths), headless Chrome on WebGPU and ?webgl=1 (backend, keepNames,
// no errors, screenshots in tests/artifacts/). Exit 0 only if everything passes.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launchPlayer, screenshot, waitForGame } from '../lib/launch.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const PORT = Number(process.env.G0_PORT ?? 3099);
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const ok = (name, pass, info = '') => {
  results.push({ name, pass, info });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`);
  return pass;
};
const run = (label, cmd) => {
  const t0 = Date.now();
  const r = spawnSync(cmd, { cwd: ROOT, shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  const pass = ok(label, r.status === 0, `${Date.now() - t0} ms`);
  if (!pass) console.log(out.split('\n').slice(-25).join('\n'));
  return pass;
};

run('npm run check', 'npm run check');
run('npm run selftest', 'npm run selftest');
if (existsSync(join(ROOT, 'tools/gen-cli.ts'))) run('gen-cli --seed 1 boots', 'node tools/gen-cli.ts --seed 1');
else console.log('SKIP  gen-cli (tools/gen-cli.ts not written yet by track ②)');
const built = run('npm run build', 'npm run build');

let server = null;
if (built) {
  server = spawn(process.execPath, ['apps/server/src/index.ts', '--prod'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  const t0 = Date.now();
  let up = false;
  while (Date.now() - t0 < 15_000 && !up) {
    try { up = (await fetch(`${BASE}/healthz`)).ok; } catch { await new Promise((r) => setTimeout(r, 150)); }
  }
  if (ok('prod server up on :' + PORT, up, `${Date.now() - t0} ms`)) {
    const idx = await fetch(`${BASE}/`);
    ok('GET / serves index.html', idx.ok && (await idx.text()).includes('DEAD AIR'));
    for (const p of ['/.env', '/saves/', '/saves/crews/x.json', '/logs/', '/.git/config', '/.git/HEAD', '/package.json', '/apps/server/src/index.ts']) {
      const r = await fetch(`${BASE}${p}`);
      ok(`GET ${p} -> 404`, r.status === 404, String(r.status));
    }
    for (const [label, webgl, want, shot] of [['WebGPU', false, 'webgpu', 'tests/artifacts/g0.png'], ['WebGL2 (?webgl=1)', true, 'webgl2', 'tests/artifacts/g0-webgl.png']]) {
      let p = null;
      try {
        p = await launchPlayer({ name: 'G0', baseUrl: BASE, webgl });
        await waitForGame(p.page, 30_000);
        await p.page.waitForTimeout(500);
        const info = await p.page.evaluate(() => {
          const g = window.__game;
          return { backend: g.backend(), errors: g.errors(), diag: g.state().diag, perf: g.perf() };
        });
        ok(`${label}: backend() === '${want}'`, info.backend === want, info.backend);
        ok(`${label}: keepNames survived the build`, info.diag.keepNames === true);
        const errs = [...p.errors, ...info.errors];
        ok(`${label}: no console/page/WebGPU errors`, errs.length === 0, errs.slice(0, 3).join(' | '));
        await screenshot(p.page, shot);
        console.log(`      screenshot ${shot}  fps=${info.perf.fps.toFixed(0)} drawCalls=${info.perf.drawCalls}`);
      } catch (e) {
        ok(`${label}: launch + ready`, false, e instanceof Error ? e.message.split('\n')[0] : String(e));
      } finally {
        await p?.close();
      }
    }
  } else console.log(log.slice(-2000));
  server.kill();
}

const failed = results.filter((r) => !r.pass);
console.log(`\nG0 ${failed.length ? 'FAILED' : 'PASSED'}: ${results.length - failed.length}/${results.length} checks`);
process.exitCode = failed.length ? 1 : 0;
