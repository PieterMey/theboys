// RMS statistics (dBFS, 100 ms windows) of the fixture WAVs, to know which band each should produce.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.argv[2];
for (const f of readdirSync(dir).filter((x) => x.endsWith('.wav'))) {
  const b = readFileSync(join(dir, f));
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4), sz = b.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(off + 10), sr: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    if (id === 'data') data = b.subarray(off + 8, off + 8 + sz);
    off += 8 + sz + (sz & 1);
  }
  if (!fmt || !data || fmt.bits !== 16) { console.log(f, 'unsupported', fmt); continue; }
  const n = data.length / 2 / fmt.ch, win = Math.round(fmt.sr * 0.1);
  const dbs = [];
  for (let s = 0; s + win <= n; s += win) {
    let acc = 0;
    for (let i = s; i < s + win; i++) { const v = data.readInt16LE(i * 2 * fmt.ch) / 32768; acc += v * v; }
    dbs.push(10 * Math.log10(Math.max(1e-14, acc / win)));
  }
  const voiced = dbs.filter((d) => d > -60).sort((a, c) => a - c);
  const q = (p) => voiced.length ? voiced[Math.floor(p * (voiced.length - 1))].toFixed(1) : '-';
  console.log(`${f.padEnd(22)} ${fmt.sr} Hz ${fmt.ch}ch ${(n / fmt.sr).toFixed(1)} s  windows ${dbs.length}, voiced(>-60) ${voiced.length}  p10 ${q(0.1)} p50 ${q(0.5)} p90 ${q(0.9)} max ${q(1)}`);
}
