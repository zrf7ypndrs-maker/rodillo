// Renders the title music (js/music.js, the same code the app runs) and writes it as a WAV to listen to:
//   node tools/music-preview.mjs [out.wav] [loops]   (default /tmp/rodillo-title.wav, 2 loops back to back, so the
// loop point can be heard in the middle). Prints the render time, the level and the seam check.
import fs from 'node:fs';
import { renderLoop, SR } from '../js/music.js';

const outFile = process.argv[2] || '/tmp/rodillo-title.wav';
const loops = Number(process.argv[3] || 2);
const t0 = performance.now();
const [L, R] = await renderLoop();
const ms = performance.now() - t0;
const n = L.length, pcm = Buffer.alloc(n * 4);
let sum = 0, step = 0;
for (let i = 0; i < n; i++) {
  pcm.writeInt16LE(Math.round(L[i] * 32767), i * 4);
  pcm.writeInt16LE(Math.round(R[i] * 32767), i * 4 + 2);
  sum += L[i] * L[i] + R[i] * R[i];
  if (i) step += Math.abs(L[i] - L[i - 1]);
}
const body = Buffer.concat(Array(loops).fill(pcm)), head = Buffer.alloc(44);
head.write('RIFF', 0); head.writeUInt32LE(36 + body.length, 4); head.write('WAVE', 8); head.write('fmt ', 12);
head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(2, 22); head.writeUInt32LE(SR, 24);
head.writeUInt32LE(SR * 4, 28); head.writeUInt16LE(4, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(body.length, 40);
fs.writeFileSync(outFile, Buffer.concat([head, body]));
const rms = 20 * Math.log10(Math.sqrt(sum / (2 * n)));
console.log(`rendered ${(n / SR).toFixed(1)} s in ${(ms / 1000).toFixed(2)} s; rms ${rms.toFixed(1)} dBFS; seam step ${Math.abs(L[0] - L[n - 1]).toFixed(4)} vs typical ${(step / (n - 1)).toFixed(4)}`);
console.log(`wrote ${outFile} (${loops} loops)`);
