// P3 QA diagnostics: which scene objects leak GPU geometries/textures when the layout changes (contract -> hub ->
// contract)? Records every mesh's geometry (by object path) before each layout change and reports the ones that left
// the scene without geometry.dispose() / texture.dispose().
//   BASE_URL=http://127.0.0.1:3096 node tests/qa/leak-probe.e2e.ts [--rounds 3]
import { WS_URL, connectBot, gpuRes, log, qaPlayer, randomCrew, sleep, st } from './lib.ts';

const rounds = Number(process.argv[process.argv.indexOf('--rounds') + 1] || 3);
const crew = randomCrew();
const L = await connectBot({ url: WS_URL, crew, name: 'Lead' });
const p = await qaPlayer('Ann', 'silence.wav', crew);
try {
  await p.page.evaluate(() => {
    const t = window.__render!.three();
    const T = t.THREE as unknown as { BufferGeometry: { prototype: { dispose(): void } }; Texture: { prototype: { dispose(): void } } };
    const w = window as unknown as { __qaDisposed: Set<string>; __qaTexDisposed: Set<string> };
    w.__qaDisposed = new Set();
    w.__qaTexDisposed = new Set();
    const gd = T.BufferGeometry.prototype.dispose;
    T.BufferGeometry.prototype.dispose = function (this: { uuid: string }) { w.__qaDisposed.add(this.uuid); return gd.call(this); };
    const td = T.Texture.prototype.dispose;
    T.Texture.prototype.dispose = function (this: { uuid: string }) { w.__qaTexDisposed.add(this.uuid); return td.call(this); };
  });
  const snapshotScene = () => p.page.evaluate(() => {
    const t = window.__render!.three();
    const geo: Record<string, string> = {};
    const tex: Record<string, string> = {};
    const path = (o: { name: string; parent: unknown }) => {
      const parts: string[] = [];
      let c: { name: string; parent: unknown } | null = o;
      for (let i = 0; c && i < 4; i++) { parts.unshift(c.name || '?'); c = c.parent as typeof c; }
      return parts.join('/');
    };
    t.scene.traverse((o) => {
      const m = o as unknown as { geometry?: { uuid: string }; material?: unknown; name: string; parent: unknown };
      if (m.geometry) geo[m.geometry.uuid] = path(m);
      const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
      for (const mm of mats as Record<string, unknown>[]) for (const v of Object.values(mm)) {
        const tx = v as { isTexture?: boolean; uuid?: string };
        if (tx && tx.isTexture && tx.uuid) tex[tx.uuid] = `${path(m)} [${(mm as { name?: string }).name ?? ''}]`;
      }
    });
    return { geo, tex };
  });
  const leakReport = async (label: string, before: { geo: Record<string, string>; tex: Record<string, string> }) => {
    const after = await snapshotScene();
    const r = await p.page.evaluate(([bg, bt, ag, at]) => {
      const w = window as unknown as { __qaDisposed: Set<string>; __qaTexDisposed: Set<string> };
      const lostG: Record<string, number> = {};
      for (const [u, path] of Object.entries(bg)) if (!(u in ag) && !w.__qaDisposed.has(u)) { const k = path.replace(/\d+/g, '#'); lostG[k] = (lostG[k] ?? 0) + 1; }
      const lostT: Record<string, number> = {};
      for (const [u, path] of Object.entries(bt)) if (!(u in at) && !w.__qaTexDisposed.has(u)) { const k = path.replace(/\d+/g, '#'); lostT[k] = (lostT[k] ?? 0) + 1; }
      return { lostG, lostT };
    }, [before.geo, before.tex, after.geo, after.tex] as const);
    const top = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${v} x ${k}`).join('\n    ');
    log(`${label}: geometries that left the scene undisposed: ${Object.values(r.lostG).reduce((a, b) => a + b, 0)}\n    ${top(r.lostG)}`);
    log(`${label}: textures that left the scene undisposed: ${Object.values(r.lostT).reduce((a, b) => a + b, 0)}\n    ${top(r.lostT)}`);
    log(`${label}: renderer.info ${JSON.stringify(await gpuRes(p.page))}`);
  };
  if (process.argv.includes('--lobby')) {
    // real flow: hub -> drive -> contract -> results -> hub; diff the contract scene against the next hub
    const ms = () => L.req('meta.state' as never, {} as never) as unknown as Promise<{ workOrders: { id: string; available: boolean }[] }>;
    for (let i = 0; i < rounds; i++) {
      await L.dbg('meta.contractSec', { sec: 600 });
      await L.req('meta.pick', { orderId: (await ms()).workOrders.find((o) => o.available)!.id });
      await L.req('meta.ready', { ready: true });
      await p.page.evaluate(() => window.__game!.req!('meta.ready', { ready: true }));
      await L.waitFor(() => L.full?.phase === 'drive', 10_000, 'drive');
      await L.dbg('meta.skipDrive');
      await p.page.waitForFunction(() => (window.__game!.state() as { phase: string }).phase === 'contract', undefined, { timeout: 30_000 });
      await sleep(5000);
      const inContract = await snapshotScene();
      await L.dbg('meta.endContract', { real: true });
      await p.page.waitForFunction(() => (window.__game!.state() as { phase: string }).phase === 'results', undefined, { timeout: 20_000 });
      await sleep(1500);
      await L.req('meta.continue', {});
      await p.page.waitForFunction(() => (window.__game!.state() as { phase: string }).phase === 'hub', undefined, { timeout: 20_000 });
      await sleep(3000);
      await leakReport(`lobby round ${i + 1} (contract -> hub)`, inContract);
    }
  }
  for (let i = 0; i < (process.argv.includes('--lobby') ? 0 : rounds); i++) {
    const b0 = await snapshotScene();
    const seed0 = (await st(p.page)).layout?.seed ?? '';
    await L.dbg('objectives.start', { realSec: 600 });
    await p.page.waitForFunction((seed) => (window.__game!.state() as { layout: { seed: string } | null }).layout?.seed !== seed, seed0, { timeout: 30_000 });
    await sleep(4000);
    await leakReport(`round ${i + 1} (-> contract)`, b0);
  }
} finally {
  L.close();
  await p.close();
  setTimeout(() => process.exit(0), 300).unref();
}
