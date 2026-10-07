// Generates the app icons from the inline SVGs below (no binaries in git):
//   build/icon.ico (16..256, PNG entries; the exe icon), build/icon.png (256; the window icon),
//   build/steam-client-icon.ico (16+32) and build/steam-community-icon.jpg (184x184) for the Steamworks upload.
// Usage: node apps/desktop/scripts/make-icons.mjs [--if-missing]
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const OUT = join(import.meta.dirname, '..', 'build');
if (process.argv.includes('--if-missing') && existsSync(join(OUT, 'icon.ico')) && existsSync(join(OUT, 'icon.png'))) process.exit(0);

// "dead air": a signal that goes flat, and the red on-air light
const FULL = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
<defs>
<radialGradient id="bg" cx="50%" cy="38%" r="78%"><stop offset="0" stop-color="#18231e"/><stop offset=".55" stop-color="#080b0a"/><stop offset="1" stop-color="#020303"/></radialGradient>
<radialGradient id="glow" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#ff6a52" stop-opacity=".95"/><stop offset=".35" stop-color="#d23b2e" stop-opacity=".45"/><stop offset="1" stop-color="#d23b2e" stop-opacity="0"/></radialGradient>
</defs>
<rect width="256" height="256" rx="48" fill="url(#bg)"/>
<rect x="5" y="5" width="246" height="246" rx="44" fill="none" stroke="#f0b43c" stroke-opacity=".28" stroke-width="3"/>
<path d="M30 168 H70 L80 132 L92 200 L104 112 L116 186 L126 150 L134 168 H226" fill="none" stroke="#f0b43c" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
<circle cx="176" cy="88" r="56" fill="url(#glow)"/>
<circle cx="176" cy="88" r="23" fill="#e0412f"/>
<circle cx="169" cy="81" r="7" fill="#ff9a84" opacity=".7"/>
</svg>`;
// simplified for 16-32 px: thicker line, bigger dot, no glow
const SMALL = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32" rx="6" fill="#050706"/>
<path d="M3 21 H9 L12 14 L15 26 L18 21 H29" fill="none" stroke="#f0b43c" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
<circle cx="22.5" cy="9.5" r="5" fill="#e0412f"/>
</svg>`;

/** @param {number} size */
async function png(size) {
  const small = size <= 32;
  const svg = Buffer.from(small ? SMALL : FULL);
  const density = Math.max(72, Math.round((72 * size) / (small ? 32 : 256)) * 2);
  return sharp(svg, { density }).resize(size, size, { kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toBuffer();
}

/** ICO container with PNG entries (Windows Vista+). @param {{ size: number, buf: Buffer }[]} entries */
function ico(entries) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = head.length + dir.length;
  entries.forEach(({ size, buf }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(buf.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += buf.length;
  });
  return Buffer.concat([head, dir, ...entries.map((e) => e.buf)]);
}

mkdirSync(OUT, { recursive: true });
const sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
const entries = await Promise.all(sizes.map(async (size) => ({ size, buf: await png(size) })));
writeFileSync(join(OUT, 'icon.ico'), ico(entries));
writeFileSync(join(OUT, 'icon.png'), entries[entries.length - 1].buf);
writeFileSync(join(OUT, 'steam-client-icon.ico'), ico(entries.filter((e) => e.size === 16 || e.size === 32)));
writeFileSync(join(OUT, 'steam-community-icon.jpg'), await sharp(Buffer.from(FULL), { density: 144 }).resize(184, 184).flatten({ background: '#020303' }).jpeg({ quality: 92 }).toBuffer());
console.log(`icons -> ${OUT} (${sizes.join(', ')} px)`);
