// Copies the ffmpeg.wasm files into public/ so the browser loads them same-origin (clip mode only fetches them).
import { cpSync, mkdirSync } from 'node:fs';

const out = new URL('../public/ffmpeg/', import.meta.url);
mkdirSync(out, { recursive: true });
const from = (pkg, file) => new URL('../node_modules/' + pkg + '/dist/umd/' + file, import.meta.url);
for (const f of ['ffmpeg.js', '814.ffmpeg.js']) cpSync(from('@ffmpeg/ffmpeg', f), new URL(f, out));
for (const f of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) cpSync(from('@ffmpeg/core', f), new URL(f, out));
