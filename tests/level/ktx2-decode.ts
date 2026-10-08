// Env-layout (v1.2) test helper: decode KTX2 files with three's Basis Universal transcoder (wasm, CPU only, no GPU) to
// prove a built texture is valid: header, levels, alpha flag, and that level 0 transcodes to RGBA32.
//   node tests/level/ktx2-decode.ts <file.ktx2> [...]
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import vm from 'node:vm';

const ROOT = resolve(import.meta.dirname, '../..');
const BASIS_DIR = resolve(ROOT, 'node_modules/three/examples/jsm/libs/basis');

interface KTX2File {
  isValid(): boolean; getWidth(): number; getHeight(): number; getLevels(): number; getHasAlpha(): boolean; getFaces(): number;
  startTranscoding(): boolean; getImageTranscodedSizeInBytes(level: number, layer: number, face: number, fmt: number): number;
  transcodeImage(dst: Uint8Array, level: number, layer: number, face: number, fmt: number, getAlphaForOpaque: number, channel0: number, channel1: number): number;
  close(): void; delete(): void;
}
interface BasisModule { KTX2File: new (data: Uint8Array) => KTX2File; initializeBasis(): void }
let mod: Promise<BasisModule> | null = null;
/** the transcoder is a classic (non-module) Emscripten script: evaluate it in a context that has require/__filename */
function basis(): Promise<BasisModule> {
  mod ??= (async () => {
    const src = readFileSync(resolve(BASIS_DIR, 'basis_transcoder.js'), 'utf8');
    const sandbox: Record<string, unknown> = { require: createRequire(resolve(BASIS_DIR, 'x.js')), __filename: resolve(BASIS_DIR, 'basis_transcoder.js'), __dirname: BASIS_DIR, process, console, Buffer, URL, WebAssembly, TextDecoder, setTimeout, clearTimeout, performance };
    vm.createContext(sandbox);
    vm.runInContext(`${src}\n;globalThis.__BASIS = BASIS;`, sandbox);
    const factory = sandbox.__BASIS as (o: object) => Promise<BasisModule>;
    const m = await factory({ wasmBinary: readFileSync(resolve(BASIS_DIR, 'basis_transcoder.wasm')) });
    m.initializeBasis();
    return m;
  })();
  return mod;
}

export interface Ktx2Info { width: number; height: number; levels: number; alpha: boolean; rgba: Uint8Array }
/** decode level 0 of a KTX2 file to RGBA32 (cTFRGBA32 = 13) */
export async function decodeKtx2(file: string): Promise<Ktx2Info> {
  const B = await basis();
  const k = new B.KTX2File(new Uint8Array(readFileSync(file)));
  try {
    if (!k.isValid()) throw new Error(`${file}: invalid KTX2`);
    if (!k.startTranscoding()) throw new Error(`${file}: startTranscoding failed`);
    const RGBA32 = 13;
    const rgba = new Uint8Array(k.getImageTranscodedSizeInBytes(0, 0, 0, RGBA32));
    if (!k.transcodeImage(rgba, 0, 0, 0, RGBA32, 0, -1, -1)) throw new Error(`${file}: transcode failed`);
    return { width: k.getWidth(), height: k.getHeight(), levels: k.getLevels(), alpha: k.getHasAlpha(), rgba };
  } finally {
    k.close(); k.delete();
  }
}

if (import.meta.filename === process.argv[1]) {
  for (const f of process.argv.slice(2)) {
    const r = await decodeKtx2(f);
    let a0 = 0;
    for (let i = 3; i < r.rgba.length; i += 4) if (r.rgba[i] < 128) a0++;
    console.log(f, `${r.width}x${r.height}`, 'levels', r.levels, 'alpha', r.alpha, 'transparent px', a0);
  }
}
