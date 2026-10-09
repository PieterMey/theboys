// Owner: track (d) Meta. Node module hooks for tests/meta/settings-dom.test.ts: a .tsx file goes through Vite's oxc
// transform (Preact automatic JSX) and a .css import becomes an empty module, so a client panel renders in Node on a
// DOM shim (tests/meta/domshim.ts): no browser, no GPU. Registered with module.register() by the test.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface Resolved { url: string; format?: string | null; shortCircuit?: boolean }
interface Loaded { format?: string | null; source?: string | ArrayBuffer | Uint8Array; shortCircuit?: boolean }
type Ctx = Record<string, unknown>;
type Oxc = (code: string, file: string, o: { jsx: { runtime: 'automatic'; importSource: string } }) => Promise<{ code: string }>;

export async function resolve(specifier: string, context: Ctx, next: (s: string, c?: Ctx) => Promise<Resolved>): Promise<Resolved> {
  if (specifier.endsWith('.css')) return { url: 'data:text/javascript,export default {};', shortCircuit: true };
  return next(specifier, context);
}

let oxc: Oxc | null = null;
export async function load(url: string, context: Ctx, next: (u: string, c?: Ctx) => Promise<Loaded>): Promise<Loaded> {
  if (!url.startsWith('file:') || !url.endsWith('.tsx')) return next(url, context);
  oxc ??= (await import('vite')).transformWithOxc as unknown as Oxc;
  const file = fileURLToPath(url);
  const r = await oxc(readFileSync(file, 'utf8'), file, { jsx: { runtime: 'automatic', importSource: 'preact' } });
  return { format: 'module', source: r.code, shortCircuit: true };
}
