// Usage: node kokoro_bench.mjs <dtype> <device>
// Run from the kokoro_test project dir so node resolves kokoro-js there.
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
const require = createRequire(path.join(process.cwd(), "package.json"));
const { KokoroTTS } = await import(pathToFileURL(require.resolve("kokoro-js")).href);

const dtype = process.argv[2] || "fp32";
const device = process.argv[3] || "cpu";
const t0 = performance.now();
let tts;
try {
  tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype, device });
} catch (e) {
  console.log(JSON.stringify({ dtype, device, load_error: String(e).slice(0, 300) }));
  process.exit(0);
}
const loadMs = performance.now() - t0;
const voices = Object.keys(tts.voices ?? {});
const langs = [...new Set(Object.values(tts.voices ?? {}).map((v) => v.language))];
const texts = [
  "Is anyone in this room with us?",
  "Get out. Get out of my house.",
  "I can hear you breathing behind the door.",
  "The generator is on the second floor, near the attic stairs.",
];
// warm-up
await tts.generate(texts[0], { voice: "af_heart" });
const rows = [];
for (const t of texts) {
  for (let k = 0; k < 3; k++) {
    const s = performance.now();
    const audio = await tts.generate(t, { voice: "am_michael" });
    const ms = performance.now() - s;
    const dur = audio.audio.length / audio.sampling_rate;
    rows.push({ chars: t.length, ms: Math.round(ms), audio_s: +dur.toFixed(2), rtf: +(ms / 1000 / dur).toFixed(3) });
  }
}
const rtfs = rows.map((r) => r.rtf).sort((a, b) => a - b);
console.log(JSON.stringify({ dtype, device, load_ms: Math.round(loadMs), n_voices: voices.length, languages: langs, median_rtf: rtfs[Math.floor(rtfs.length / 2)], rows }, null, 0));
