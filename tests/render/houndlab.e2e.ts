// Owner: track ③ Render. Look-dev lab: the hound under Lambert vs PBR variants (swapped live via __render.three()).
//   node tests/render/houndlab.e2e.ts [--base http://127.0.0.1:3098] -> tests/artifacts/polish/lab/hound_*.png
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { REPO } from '../lib/launch.ts';
import { ANIM } from '../../packages/shared/src/anim.ts';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', 'http://127.0.0.1:3098');
const OUT = join(REPO, 'tests/artifacts/polish/lab');
mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SOFTWARE = process.env.DEADAIR_RENDER === 'swiftshader';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required',
  // tools/gpu-guard.mjs software lane (hardware GPU off for agent tests): SwiftShader WebGL2
  ...(SOFTWARE ? ['--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [])] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await context.routeWebSocket((url) => !url.pathname.endsWith('/ws'), (ws) => { ws.close(); });
const page = await context.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text()); });
await page.goto(`${BASE}/?test=1&autojoin=1&preset=ultra${SOFTWARE ? '&webgl=1' : ''}#HLAB`, { waitUntil: 'domcontentloaded' });
const dbg = (r: string, a: unknown = {}) => page.evaluate(([rr, aa]) => window.__game!.dbg(rr as string, aa), [r, a] as const);
async function shot(name: string) {
  const cdp = await page.context().newCDPSession(page);
  const r = (await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })) as { data: string };
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'));
  await cdp.detach();
}
try {
  await page.waitForFunction(() => window.__game?.ready() === true && !!window.__game?.me(), undefined, { timeout: 90_000 });
  await dbg('monsters.start', { seed: 'polish-a', players: 2, risk: 2 });
  await page.waitForFunction(() => (window.__game!.state() as { phase: string }).phase === 'contract', undefined, { timeout: 30_000 });
  await dbg('monsters.freeze', { on: true });
  await page.waitForFunction(() => (window as unknown as { __monsters?: { loaded(): boolean } }).__monsters?.loaded() === true, undefined, { timeout: 30_000 }).catch(() => null);
  // PIT room of polish-a: x 26..32? use the lit room logic quickly: stand in the lobby instead (always lit)
  const L = await page.evaluate(() => (window as unknown as { __monstersLayout(): { entrance: number; spaces: { id: number; rect: { x: number; y: number; w: number; h: number } }[] } }).__monstersLayout());
  const r = L.spaces[L.entrance].rect;
  const cx = r.x + 1.0, cz = r.y + r.h / 2, tx = r.x + 3.6;
  for (const id of ['hound1', 'listener0', 'mannequin0']) await dbg('monsters.place', { id, x: 0.5, z: 0.5, active: false, state: 'out', outSec: 999 }).catch(() => null);
  await dbg('monsters.place', { id: 'hound0', x: tx, z: cz, yaw: Math.PI * 0.75, state: 'alert', active: true, anim: ANIM.mAlert });
  await page.evaluate(([x, z, tx2]) => { window.__game!.teleport(x, z, Math.atan2(tx2 - x, 0)); window.__game!.look(Math.PI / 2, -0.2); }, [cx, cz, tx] as const);
  await sleep(2500);
  await page.evaluate(([x, z]) => { window.__game!.teleport(x, z, Math.PI / 2); window.__game!.look(Math.PI / 2, -0.2); }, [cx, cz] as const);
  await sleep(1500);
  await shot('hound_lambert');
  const variants = ['standard', 'physical', 'phong', 'normals'];
  for (const v of variants) {
    const info = await page.evaluate((variant) => {
      const R = (window as unknown as { __render: { three(): { scene: { traverse(f: (o: unknown) => void): void }; THREE: unknown } } }).__render.three();
      const THREE = R.THREE;
      const out: string[] = [];
      R.scene.traverse((o: unknown) => {
        const m = o as { isSkinnedMesh?: boolean; material: { type: string; map?: unknown; colorNode?: unknown }; geometry: { attributes: Record<string, unknown> }; name: string; parent?: { name?: string } };
        if (!m.isSkinnedMesh) return;
        if (m.material?.type !== 'MeshLambertNodeMaterial' && !(m as unknown as { userData: { hl?: boolean } }).userData.hl) return;
        (m as unknown as { userData: { hl?: boolean; orig?: unknown } }).userData.hl = true;
        const ud = (m as unknown as { userData: { orig?: { colorNode?: unknown; map?: unknown } } }).userData;
        ud.orig ??= m.material;
        out.push(`${m.name}:${Object.keys(m.geometry.attributes).join('/')}`);
        if (!THREE) return;
        const T = THREE as unknown as Record<string, new (p?: unknown) => { colorNode?: unknown; map?: unknown; roughness?: number; metalness?: number; color?: { setHex(n: number): void } }>;
        const C = variant === 'standard' ? T.MeshStandardNodeMaterial : variant === 'physical' ? T.MeshPhysicalNodeMaterial : variant === 'phong' ? T.MeshPhongNodeMaterial : T.MeshNormalNodeMaterial;
        const nm = new C();
        if (variant !== 'normals') { nm.colorNode = ud.orig!.colorNode; nm.map = ud.orig!.map; nm.roughness = 0.5; nm.metalness = 0; }
        m.material = nm as unknown as { type: string };
      });
      return { out, three: !!THREE };
    }, v);
    console.log(v, JSON.stringify(info));
    await sleep(2500);
    await shot(`hound_${v}`);
  }
} finally {
  await browser.close();
}
