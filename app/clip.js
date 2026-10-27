// Clip mode (?clip=1): records a vertical 1080x1920 TikTok clip of the run into a separate canvas.
// Loaded with a dynamic import() from engine.js only when the URL asks for it, so normal players never fetch or run any of this.

const W = 1080, H = 1920;
const GAME_W = 1080, GAME_H = 1350;
// TikTok draws its UI over the bottom (caption, account) and the right edge (buttons) and the tab bar over the top:
// every piece of text stays inside this box and above y 1440.
const SAFE = { left: 60, right: 920 };
const TEXT_W = SAFE.right - SAFE.left;
const OUTRO_MS = 2000;
const FRAME_MS = 1000 / 30;
const SITE_URL = 'night-highway.vercel.app';

// the game's own palette and type (globals.css)
const C = {
  night: '#04070f', ink: '#e8efff', dim: '#a3b2d6', red: '#ff2b45', blue: '#79c2ff',
  rule: 'rgba(165,190,245,0.24)', track: 'rgba(232,239,255,0.14)',
};
const F = {
  display: '"Big Shoulders Display", "Oswald", "Arial Narrow", "Roboto Condensed", Impact, sans-serif',
  body: '"Overpass", "Helvetica Neue", Arial, sans-serif',
  mono: '"Overpass Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};
const font = (weight, px, fam) => weight + ' ' + px + 'px ' + fam;

const STYLES = {
  defi: {
    label: 'Défi', title: '60 SECONDES. COMBIEN DE KM ?', live: true,
    kicker: 'DÉFI', accent: ['#ff2b45', '255,43,69'], endTitle: 'TU FAIS MIEUX ?',
    outro: {},
  },
};

const TITLE_BANK = [
  'TU TIENS 60 SECONDES ?', 'BATS MON SCORE ?', 'TU FAIS MIEUX ?', 'CAPABLE DE BATTRE ÇA ?',
  'QUI BAT CE SCORE ?', 'ESSAIE DE FAIRE MIEUX', 'NE TOUCHE AUCUNE VOITURE', 'FRÔLE-LES SANS CRASHER',
  '60 SECONDES. ZÉRO ERREUR.', 'UNE MINUTE. UN DÉFI.', 'ARRIVES-TU À 3 KM ?', 'TU OSES FAIRE PLUS ?',
];

const MIMES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

const prefs = (() => {
  const d = { style: 'defi', texts: {}, ends: {}, hideHud: false, last15: false };
  try {
    const p = Object.assign(d, JSON.parse(window.localStorage.getItem('night-highway:clip2') || '{}'));
    if (!STYLES[p.style]) p.style = 'defi';
    if (!p.texts || typeof p.texts !== 'object') p.texts = {};
    if (!p.ends || typeof p.ends !== 'object') p.ends = {};
    return p;
  } catch (e) { return d; }
})();
function savePrefs() { try { window.localStorage.setItem('night-highway:clip2', JSON.stringify(prefs)); } catch (e) { /* storage unavailable */ } }

const fmt = (n) => Math.floor(n).toLocaleString('en-US');
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function wrap(g, text, maxW) {
  const lines = [];
  let cur = '';
  for (const word of text.split(/\s+/)) {
    const test = cur ? cur + ' ' + word : word;
    if (cur && g.measureText(test).width > maxW) { lines.push(cur); cur = word; } else cur = test;
  }
  if (cur) lines.push(cur);
  return lines;
}

// the wordmark's two-layer neon glow (.wordmark .hot), scaled to the font size
function glowText(g, text, x, y, color, rgb, fs, maxW) {
  g.save();
  g.fillStyle = color;
  g.shadowColor = 'rgba(' + rgb + ',0.55)'; g.shadowBlur = fs * 0.1; g.fillText(text, x, y, maxW);
  g.shadowColor = 'rgba(' + rgb + ',0.35)'; g.shadowBlur = fs * 0.36; g.fillText(text, x, y, maxW);
  g.restore();
  g.fillText(text, x, y, maxW);
}

// MediaRecorder files have no proper duration or seek index, so players can't scrub or change speed.
// ffmpeg.wasm (served from /ffmpeg, fetched only here) rewrites the container without re-encoding.
let ffmpegPromise = null;
function loadFfmpeg() {
  if (!ffmpegPromise) {
    ffmpegPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/ffmpeg/ffmpeg.js';
      s.onload = async () => {
        try {
          const ff = new window.FFmpegWASM.FFmpeg();
          await ff.load({ coreURL: '/ffmpeg/ffmpeg-core.js', wasmURL: '/ffmpeg/ffmpeg-core.wasm' });
          resolve(ff);
        } catch (e) { reject(e); }
      };
      s.onerror = () => reject(new Error('ffmpeg script failed to load'));
      document.head.appendChild(s);
    }).catch((e) => { ffmpegPromise = null; throw e; });
  }
  return ffmpegPromise;
}
async function remux(blob, ext) {
  const ff = await loadFfmpeg();
  const inName = 'in.' + ext, outName = 'out.' + ext;
  await ff.writeFile(inName, new Uint8Array(await blob.arrayBuffer()));
  const args = ['-i', inName, '-c', 'copy'];
  if (ext === 'mp4') args.push('-movflags', '+faststart');
  args.push(outName);
  const code = await ff.exec(args);
  if (code !== 0) throw new Error('ffmpeg exited with ' + code);
  const data = await ff.readFile(outName);
  ff.deleteFile(inName).catch(() => {}); ff.deleteFile(outName).catch(() => {});
  return new Blob([data.buffer], { type: blob.type });
}

export function createClip({ canvas, G, hud }) {
  const comp = document.createElement('canvas');
  comp.width = W; comp.height = H;
  const g = comp.getContext('2d', { alpha: false });
  const backdrop = document.createElement('canvas');
  backdrop.width = W; backdrop.height = H;

  // the game's web fonts must be ready before the canvas can use them
  ['900 100px "Big Shoulders Display"', '800 100px "Big Shoulders Display"', '600 20px "Overpass Mono"', '800 20px "Overpass"']
    .forEach((f) => { if (document.fonts && document.fonts.load) document.fonts.load(f).catch(() => {}); });

  const mime = typeof MediaRecorder !== 'undefined' ? MIMES.find((m) => MediaRecorder.isTypeSupported(m)) : null;
  const isMp4 = !!mime && mime.startsWith('video/mp4');
  const ext = isMp4 ? 'mp4' : 'webm';
  console.info('[clip] recording format: ' + (mime || 'unsupported'));

  const stream = comp.captureStream(30);
  let actx = null, dest = null;
  let rec = null;
  let chunks = [];
  let phase = 'idle'; // idle | rec | outro | finishing
  let aborted = false, job = null;
  let outroT0 = 0, lastDraw = 0, recT0 = 0, shownState = '';
  let blobUrl = null;
  let st = STYLES.defi, title = '', endText = '', gy = 420, hideHudNow = false;
  let bestStart = 0, popup = null, fin = { score: 0, dist: 0, nm: 0 };
  let scrimTop = null, scrimBot = null;
  // game seconds that pass per real second; below 1 on slow machines, where the game's time step is capped
  let rate = 1, lastWall = 0, lastGameT = null, pausedMs = 0, pauseAt = 0;
  const LAST_REAL_S = 15 - OUTRO_MS / 1000; // the 15 s clip includes the 2 s end screen

  // ---------- panel ----------
  const el = (tag, css, text) => { const n = document.createElement(tag); if (css) n.style.cssText = css; if (text) n.textContent = text; return n; };
  const panel = el('div', 'position:fixed;top:12px;left:12px;z-index:50;width:min(340px,calc(100vw - 24px));padding:12px 14px;border-radius:10px;background:rgba(4,8,20,.86);border:1px solid rgba(165,190,245,.3);color:#e8efff;font:13px/1.4 ' + F.body + ';user-select:auto;pointer-events:auto');
  panel.hidden = true;
  panel.appendChild(el('div', 'font:600 11px ' + F.mono + ';letter-spacing:.2em;text-transform:uppercase;color:#79c2ff;margin-bottom:8px', 'Mode clip'));
  const fieldCss = 'width:100%;padding:7px 9px;border-radius:6px;border:1px solid rgba(165,190,245,.4);background:#0a1126;color:#fff;font:inherit';
  const titleRow = el('div', 'display:flex;gap:6px;margin-top:8px');
  const input = el('input', fieldCss + ';text-transform:uppercase;flex:1;min-width:0');
  input.type = 'text'; input.maxLength = 70;
  input.setAttribute('aria-label', 'Texte du haut de la vidéo');
  const dice = el('button', 'padding:0 10px;border-radius:6px;border:1px solid rgba(165,190,245,.4);background:#0a1126;color:#e8efff;font:600 12px ' + F.body + ';cursor:pointer;white-space:nowrap', '🎲 Titre aléatoire');
  dice.type = 'button';
  titleRow.appendChild(input); titleRow.appendChild(dice);
  panel.appendChild(titleRow);
  const endRow = el('div', 'margin-top:6px');
  const endInput = el('input', fieldCss + ';text-transform:uppercase');
  endInput.type = 'text'; endInput.maxLength = 40;
  endInput.setAttribute('aria-label', 'Texte de l’écran de fin');
  endRow.appendChild(endInput);
  panel.appendChild(endRow);
  const checks = {};
  const check = (label, key) => {
    const row = el('label', 'display:flex;gap:8px;align-items:center;margin-top:8px;cursor:pointer');
    const cb = el('input'); cb.type = 'checkbox';
    cb.addEventListener('change', () => { prefs[key] = cb.checked; savePrefs(); });
    row.appendChild(cb); row.appendChild(document.createTextNode(label));
    panel.appendChild(row);
    checks[key] = cb;
  };
  check('Cacher le HUD pendant l’enregistrement', 'hideHud');
  check('Clip de 15 s en tout (fin de course + écran final)', 'last15');
  const fmtLine = el('div', 'margin-top:8px;font-size:12px;color:' + (isMp4 ? '#8fe3a6' : '#ffb454'));
  fmtLine.textContent = !mime ? 'Enregistrement non supporté par ce navigateur.'
    : isMp4 ? 'Format : MP4 (prêt pour TikTok)'
      : 'Format : WebM — TikTok l’accepte mal, convertis en MP4 (ffmpeg, HandBrake…) ou utilise Chrome.';
  panel.appendChild(fmtLine);
  const status = el('div', 'margin-top:6px;font-size:12px;color:#a3b2d6', 'L’enregistrement démarre au « Go ».');
  panel.appendChild(status);
  const dl = el('button', 'margin-top:8px;width:100%;padding:9px;border-radius:6px;border:0;background:#79c2ff;color:#04070f;font:800 13px ' + F.body + ';cursor:pointer', 'Télécharger le clip');
  dl.type = 'button'; dl.hidden = true;
  panel.appendChild(dl);
  // typing in the panel must not trigger the game's hotkeys (the engine listens on window)
  for (const t of ['keydown', 'keyup']) panel.addEventListener(t, (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
  input.addEventListener('input', () => { prefs.texts[prefs.style] = input.value; savePrefs(); });
  endInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') endInput.blur(); });
  endInput.addEventListener('input', () => { prefs.ends[prefs.style] = endInput.value; savePrefs(); });
  document.body.appendChild(panel);

  function refreshPanel() {
    const s = STYLES[prefs.style];
    const hasTitle = s.title !== '';
    titleRow.hidden = !hasTitle;
    input.value = prefs.texts[prefs.style] != null ? prefs.texts[prefs.style] : s.title;
    input.placeholder = s.title;
    endRow.hidden = !!s.outro.urlOnly;
    endInput.value = prefs.ends[prefs.style] != null ? prefs.ends[prefs.style] : s.endTitle;
    endInput.placeholder = 'Texte de fin (vide = aucun)';
    checks.hideHud.checked = s.hideHud ? true : !!prefs.hideHud;
    checks.hideHud.disabled = !!s.hideHud;
    checks.last15.checked = !!prefs.last15;
  }
  dice.addEventListener('click', () => {
    const cur = input.value.trim().toUpperCase();
    let next = cur;
    while (next === cur) next = TITLE_BANK[Math.floor(Math.random() * TITLE_BANK.length)];
    input.value = next;
    prefs.texts[prefs.style] = next; savePrefs();
  });
  refreshPanel();

  dl.addEventListener('click', () => {
    if (!blobUrl) return;
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = 'night-highway-' + prefs.style + '.' + ext;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  // ---------- drawing ----------
  function paintBackdrop() {
    const b = backdrop.getContext('2d');
    b.fillStyle = C.night; b.fillRect(0, 0, W, H);
    if (!title) return;
    const text = title.toUpperCase();
    const [accent, accentRgb] = st.accent;
    b.textAlign = 'left'; b.textBaseline = 'alphabetic';
    b.letterSpacing = '8px'; b.font = font(600, 28, F.mono); b.fillStyle = accent;
    b.save(); b.shadowColor = 'rgba(' + accentRgb + ',0.6)'; b.shadowBlur = 14;
    b.fillText(st.kicker, SAFE.left, 205); b.restore();
    b.letterSpacing = '0px';
    const boxTop = 225, boxH = gy - 10 - boxTop;
    let fs = 200, lines = [text];
    for (; fs >= 56; fs -= 4) {
      b.font = font(900, fs, F.display);
      lines = wrap(b, text, TEXT_W);
      if (lines.length * fs * 0.9 <= boxH && lines.every((l) => b.measureText(l).width <= TEXT_W)) break;
    }
    b.font = font(900, fs, F.display);
    b.textAlign = 'left'; b.textBaseline = 'alphabetic';
    const lh = fs * 0.9;
    const y0 = boxTop + (boxH - lines.length * lh) / 2 + fs * 0.8;
    lines.forEach((l, i) => {
      const y = y0 + i * lh;
      if (st.allAccent || (lines.length > 1 && i === lines.length - 1)) { glowText(b, l, SAFE.left, y, accent, accentRgb, fs, TEXT_W); return; }
      b.save();
      b.shadowColor = 'rgba(121,194,255,0.35)'; b.shadowBlur = fs * 0.3;
      b.fillStyle = C.ink; b.fillText(l, SAFE.left, y, TEXT_W);
      b.restore();
      b.fillStyle = C.ink; b.fillText(l, SAFE.left, y, TEXT_W);
    });
  }

  function drawGame() {
    const sw = canvas.width, sh = canvas.height, ta = GAME_W / GAME_H;
    let sx = 0, sy = 0, sW = sw, sH = sh;
    if (sw / sh > ta) { sW = sh * ta; sx = (sw - sW) / 2; } else { sH = sw / ta; sy = (sh - sH) / 2; }
    g.drawImage(canvas, sx, sy, sW, sH, 0, gy, GAME_W, GAME_H);
    // the title band melts into the picture like the game's own veils
    g.fillStyle = scrimTop; g.fillRect(0, gy, W, 300);
    g.fillStyle = scrimBot; g.fillRect(0, gy + GAME_H - 300, W, 300);
  }

  function statBlock(x, align, label, value, unit) {
    g.textAlign = align; g.textBaseline = 'alphabetic';
    g.letterSpacing = '6px';
    g.font = font(600, 26, F.mono); g.fillStyle = C.dim;
    g.fillText(label, x, gy + 84);
    g.letterSpacing = '0px';
    g.font = font(800, 140, F.display); g.fillStyle = C.ink;
    g.fillText(value, x, gy + 214);
    if (unit) {
      const w = g.measureText(value).width;
      g.font = font(600, 32, F.mono); g.fillStyle = C.dim;
      g.fillText(unit, x + w + 14, gy + 214);
    }
  }

  function drawLive(now) {
    const late = G.time < 10;
    g.fillStyle = C.track; g.fillRect(0, gy, W, 8);
    g.save();
    g.fillStyle = late ? C.red : C.ink;
    if (late) { g.shadowColor = C.red; g.shadowBlur = 24; }
    g.fillRect(0, gy, W * clamp(G.time / 60, 0, 1), 8);
    g.restore();
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.7)'; g.shadowBlur = 16;
    statBlock(SAFE.left, 'left', 'SCORE', fmt(G.score), '');
    statBlock(SAFE.right, 'right', 'NEAR MISSES', String(G.nearMiss), '');
    g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.letterSpacing = '6px';
    g.font = font(600, 30, F.mono); g.fillStyle = C.blue;
    g.fillText('BEST ' + fmt(Math.max(bestStart, G.score)), SAFE.left, gy + 272);
    g.letterSpacing = '0px';
    g.restore();
    if (popup) {
      const k = (now - popup.t0) / 1250;
      if (k >= 1) popup = null;
      else {
        g.save();
        g.globalAlpha = k < 0.15 ? k / 0.15 : 1 - Math.pow(Math.max(0, (k - 0.45) / 0.55), 2);
        const y = gy + 520 - 46 * (1 - Math.pow(1 - Math.min(1, k * 2.5), 3));
        g.textAlign = 'center'; g.textBaseline = 'alphabetic';
        g.shadowColor = 'rgba(0,0,0,0.7)'; g.shadowBlur = 18;
        g.letterSpacing = '8px'; g.font = font(900, 96, F.display); g.fillStyle = C.blue;
        g.fillText(popup.text.toUpperCase(), (SAFE.left + SAFE.right) / 2, y, TEXT_W);
        g.letterSpacing = '4px'; g.font = font(600, 34, F.mono); g.fillStyle = C.dim;
        g.fillText(popup.sub.toUpperCase(), (SAFE.left + SAFE.right) / 2, y + 58, TEXT_W);
        g.restore();
      }
    }
  }

  // the results card of the game, re-set for a vertical frame
  function drawOutro(t) {
    const o = st.outro;
    const a = clamp(t / 300, 0, 1);
    g.fillStyle = 'rgba(2,5,12,' + ((o.urlOnly ? 0.4 : 0.88) * a).toFixed(3) + ')';
    g.fillRect(0, 0, W, H);
    g.save();
    g.globalAlpha = a;
    g.textBaseline = 'alphabetic';
    if (o.urlOnly) {
      g.textAlign = 'center'; g.letterSpacing = '5px';
      g.font = font(600, 32, F.mono); g.fillStyle = C.dim;
      g.fillText(SITE_URL.toUpperCase(), (SAFE.left + SAFE.right) / 2, 1280, TEXT_W);
      g.restore(); g.letterSpacing = '0px';
      return;
    }
    g.textAlign = 'left';
    g.letterSpacing = '7px'; g.font = font(600, 28, F.mono); g.fillStyle = C.dim;
    g.fillText('SCORE FINAL', SAFE.left, 620);
    g.letterSpacing = '0px';
    const size = o.big ? 440 : 330;
    g.font = font(900, size, F.display); g.fillStyle = C.ink;
    const txt = fmt(fin.score);
    let y = 660 + size * 0.72;
    g.save();
    g.shadowColor = 'rgba(121,194,255,0.3)'; g.shadowBlur = size * 0.12;
    g.fillText(txt, SAFE.left, y, TEXT_W);
    g.restore();
    g.fillText(txt, SAFE.left, y, TEXT_W);
    y += 56;
    g.fillStyle = C.rule; g.fillRect(SAFE.left, y, TEXT_W, 2);
    y += 62;
    const stat = (x, label, value, unit) => {
      g.letterSpacing = '5px'; g.font = font(600, 22, F.mono); g.fillStyle = C.dim; g.fillText(label, x, y);
      g.letterSpacing = '0px'; g.font = font(800, 76, F.display); g.fillStyle = C.ink; g.fillText(value, x, y + 74);
      if (unit) { const w = g.measureText(value).width; g.font = font(600, 26, F.mono); g.fillStyle = C.dim; g.fillText(unit, x + w + 10, y + 74); }
    };
    stat(SAFE.left, 'DISTANCE', fin.dist.toFixed(2), 'km');
    stat(SAFE.left + 330, 'NEAR MISSES', String(fin.nm), '');
    stat(SAFE.left + 650, 'BEST', fmt(fin.best), '');
    y += 74 + 150;
    if (endText) {
      g.font = font(900, 130, F.display);
      glowText(g, endText.toUpperCase(), SAFE.left, y, st.accent[0], st.accent[1], 130, TEXT_W);
      y += 100;
    } else y += 30;
    g.letterSpacing = '3px'; g.font = font(600, 34, F.mono); g.fillStyle = C.ink;
    g.fillText(SITE_URL, SAFE.left, y, TEXT_W);
    g.letterSpacing = '0px';
    g.restore();
  }

  // ---------- recording ----------
  function begin() {
    st = STYLES[prefs.style];
    const raw = (prefs.texts[prefs.style] != null ? prefs.texts[prefs.style] : st.title).trim() || st.title;
    title = st.title === '' ? '' : raw.replace('[SCORE]', G.best > 0 ? fmt(G.best) : 'ÇA');
    endText = (prefs.ends[prefs.style] != null ? prefs.ends[prefs.style] : st.endTitle).trim();
    gy = title ? 420 : 285;
    hideHudNow = !!st.hideHud || !!prefs.hideHud;
    scrimTop = g.createLinearGradient(0, gy, 0, gy + 300);
    scrimTop.addColorStop(0, 'rgba(4,7,15,0.9)'); scrimTop.addColorStop(1, 'rgba(4,7,15,0)');
    scrimBot = g.createLinearGradient(0, gy + GAME_H - 300, 0, gy + GAME_H);
    scrimBot.addColorStop(0, 'rgba(4,7,15,0)'); scrimBot.addColorStop(1, 'rgba(4,7,15,0.9)');
    paintBackdrop();
    chunks = []; popup = null;
    bestStart = G.best || 0; // G.best only updates when the run ends
    aborted = false;
    rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8000000, audioBitsPerSecond: 128000 });
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = finish;
    rec.start(500);
    recT0 = performance.now();
    pausedMs = 0; pauseAt = 0;
    phase = 'rec';
    lastDraw = 0;
    if (hideHudNow) hud.classList.add('off');
    dl.hidden = true;
    status.textContent = '● Enregistrement en cours…';
  }

  async function publish(blob, note) {
    const token = job = { cancelled: false };
    const mine = token;
    status.textContent = 'Optimisation du fichier (durée, avance rapide)…';
    try { blob = await remux(blob, ext); note = (note ? note + ' ' : '') + 'Fichier réparé.'; } catch (e) { console.warn('[clip] remux failed', e); }
    if (mine.cancelled) return;
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl = URL.createObjectURL(blob);
    const secs = Math.round((performance.now() - recT0 - pausedMs) / 1000);
    status.textContent = 'Clip prêt : ' + '~' + secs + ' s, ' + (blob.size / 1048576).toFixed(1) + ' Mo (' + ext.toUpperCase() + ').' + (note ? ' ' + note : '');
    dl.hidden = false;
    phase = 'idle';
  }

  function finish() {
    hud.classList.toggle('off', G.hudOff);
    if (aborted || !chunks.length) { phase = 'idle'; return; }
    const blob = new Blob(chunks, { type: mime.split(';')[0] });
    chunks = [];
    publish(blob, '');
  }

  function abort() {
    if (job) job.cancelled = true;
    if (phase === 'idle' || !rec) return;
    aborted = true;
    try { if (rec.state !== 'inactive') rec.stop(); } catch (e) { /* already stopped */ }
    phase = 'idle';
  }

  function syncPanel() {
    if (G.state === shownState) return;
    shownState = G.state;
    panel.hidden = !(G.state === 'title' || G.state === 'end');
  }

  return {
    // called by engine.js, after the game canvas has been rendered this frame
    draw() {
      syncPanel();
      if (!mime) return;
      if (G.state === 'drive') {
        const w = performance.now();
        if (lastGameT !== null && w - lastWall > 0 && w - lastWall < 1000) {
          rate = rate * 0.9 + clamp((lastGameT - G.time) / ((w - lastWall) / 1000), 0.05, 1.5) * 0.1;
        }
        lastWall = w; lastGameT = G.time;
      }
      if (phase === 'idle') {
        if (G.state !== 'drive') return;
        // last-15 mode starts when about LAST_REAL_S real seconds remain, not game seconds
        if (prefs.last15 && G.time / rate > LAST_REAL_S) return;
        begin();
      }
      if (phase === 'finishing') return;
      const now = performance.now();
      if (phase === 'rec' && G.state === 'end') {
        fin = { score: Math.floor(G.score), dist: G.distRun / 1000, nm: G.nearMiss, best: Math.floor(Math.max(bestStart, G.score)) };
        phase = 'outro'; outroT0 = now;
      }
      if (now - lastDraw < FRAME_MS - 2) return;
      lastDraw = now;
      g.drawImage(backdrop, 0, 0);
      drawGame();
      if (phase === 'rec') { if (st.live) drawLive(now); }
      else {
        drawOutro(now - outroT0);
        if (now - outroT0 >= OUTRO_MS) { phase = 'finishing'; rec.stop(); }
      }
    },
    onStart() { abort(); rate = 1; lastGameT = null; },
    onPause(on) {
      lastGameT = null;
      if (rec && phase === 'rec') { if (on) pauseAt = performance.now(); else if (pauseAt) { pausedMs += performance.now() - pauseAt; pauseAt = 0; } }
      if (!rec) return;
      if (on && rec.state === 'recording') rec.pause();
      else if (!on && rec.state === 'paused') rec.resume();
    },
    onNearMiss(gap, text, sub) {
      if (phase !== 'rec') return;
      if (st.live) popup = { text, sub, t0: performance.now() };
    },
    // the clip always gets the sound, whatever the player's M setting is
    attachAudio(ctx, master) {
      actx = ctx;
      dest = ctx.createMediaStreamDestination();
      master.connect(dest);
      dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
    },
  };
}
