// Owner: track ③ Render. Quick luminance histogram of screenshots (look-dev): p5/p25/p50/p75/p95 + % near-black.
//   node tests/render/lumstats.ts <png> [<png> ...]
import sharp from 'sharp';

for (const f of process.argv.slice(2)) {
  const { data, info } = await sharp(f).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) lum[i] = 0.2126 * data[i * 3] + 0.7152 * data[i * 3 + 1] + 0.0722 * data[i * 3 + 2];
  const s = Array.from(lum).sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(n - 1, Math.floor(p * n))].toFixed(0);
  let black = 0, clip = 0;
  for (const v of lum) { if (v < 6) black++; if (v > 250) clip++; }
  console.log(`${f.split(/[\/]/).slice(-2).join('/').padEnd(34)} p5 ${q(0.05).padStart(3)} p25 ${q(0.25).padStart(3)} p50 ${q(0.5).padStart(3)} p75 ${q(0.75).padStart(3)} p95 ${q(0.95).padStart(3)}  black<6: ${(100 * black / n).toFixed(1)}%  clip>250: ${(100 * clip / n).toFixed(2)}%`);
}
