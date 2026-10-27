// Night Highway game engine. Runs once against the DOM rendered by NightHighway.tsx.
import * as THREE from 'three';

let started = false;

export function startNightHighway() {
if (started) return;
started = true;
const $ = (id) => document.getElementById(id);
const bootEl = $('boot');
function fatal(msg) {
  bootEl.hidden = false;
  bootEl.classList.add('err');
  bootEl.querySelector('p').textContent = msg;
}

// ---------- small helpers ----------
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
const mod = (a, n) => ((a % n) + n) % n;
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const lin = (hex) => new THREE.Color(hex).convertSRGBToLinear();
const hdr = (r, g, b) => new THREE.Color(r, g, b);
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = window.matchMedia('(pointer: coarse)').matches;
const store = {
  get(k, d) { try { const v = window.localStorage.getItem('night-highway:' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { window.localStorage.setItem('night-highway:' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
};

// clip mode (?clip=1) is loaded lazily at the bottom; stays null for normal players
let clip = null;

// ---------- renderer ----------
const canvas = $('scene');
let renderer = null;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
} catch (err) { renderer = null; }
if (!renderer || !renderer.getContext()) { fatal('This game needs WebGL, and this browser has it turned off. Try another browser or turn on hardware acceleration.'); return; }
renderer.setClearColor(0x000000, 1);
const gl = renderer.getContext();
const isGL2 = renderer.capabilities.isWebGL2;
let hdrType = THREE.UnsignedByteType;
if (isGL2 && gl.getExtension('EXT_color_buffer_float')) hdrType = THREE.HalfFloatType;
else if (!isGL2 && gl.getExtension('OES_texture_half_float') && gl.getExtension('OES_texture_half_float_linear') && gl.getExtension('EXT_color_buffer_half_float')) hdrType = THREE.HalfFloatType;
const HDR = hdrType === THREE.HalfFloatType;
const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(58, 1, 0.3, 4200);

// ---------- post-processing: HDR scene -> bloom + anamorphic flare -> radial motion blur, grade ----------
const rtOpts = (depth) => ({ minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, type: hdrType, depthBuffer: depth, stencilBuffer: false });
let sceneRT;
if (isGL2 && THREE.WebGLMultisampleRenderTarget) {
  sceneRT = new THREE.WebGLMultisampleRenderTarget(4, 4, rtOpts(true));
  sceneRT.samples = 4;
} else {
  sceneRT = new THREE.WebGLRenderTarget(4, 4, rtOpts(true));
}
const LEVELS = 6;
const downRT = [];
const upRT = [];
for (let i = 0; i < LEVELS; i++) {
  downRT.push(new THREE.WebGLRenderTarget(4, 4, rtOpts(false)));
  upRT.push(new THREE.WebGLRenderTarget(4, 4, rtOpts(false)));
}
const flareRT = [new THREE.WebGLRenderTarget(4, 4, rtOpts(false)), new THREE.WebGLRenderTarget(4, 4, rtOpts(false))];
const maskRT = new THREE.WebGLRenderTarget(4, 4, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false });
[sceneRT, maskRT].concat(downRT, upRT, flareRT).forEach((r) => { r.texture.generateMipmaps = false; });

const POST_VS = 'varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
const postMat = (fs, uniforms) => new THREE.ShaderMaterial({ vertexShader: POST_VS, fragmentShader: fs, uniforms, depthTest: false, depthWrite: false });

const quadGeo = new THREE.BufferGeometry();
quadGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
quadGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
const postScene = new THREE.Scene();
const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const quad = new THREE.Mesh(quadGeo);
quad.frustumCulled = false;
postScene.add(quad);
function runPass(mat, target) { quad.material = mat; renderer.setRenderTarget(target); renderer.render(postScene, postCam); }

const prefilterMat = postMat(`
uniform sampler2D tDiffuse; uniform vec2 uTexel; uniform float uThreshold; uniform float uKnee;
varying vec2 vUv;
vec3 pf(vec3 c) {
  c = clamp(c, vec3(0.0), vec3(40.0));
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  return c * (max(soft, br - uThreshold) / max(br, 1e-4));
}
void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb * 4.0;
  c += texture2D(tDiffuse, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  c += texture2D(tDiffuse, vUv + uTexel * vec2( 1.0, -1.0)).rgb;
  c += texture2D(tDiffuse, vUv + uTexel * vec2(-1.0,  1.0)).rgb;
  c += texture2D(tDiffuse, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  gl_FragColor = vec4(pf(c / 8.0), 1.0);
}`, { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: HDR ? 1.5 : 0.9 }, uKnee: { value: 0.5 } });

const downMat = postMat(`
uniform sampler2D tDiffuse; uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb * 4.0;
  c += texture2D(tDiffuse, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  c += texture2D(tDiffuse, vUv + uTexel * vec2( 1.0, -1.0)).rgb;
  c += texture2D(tDiffuse, vUv + uTexel * vec2(-1.0,  1.0)).rgb;
  c += texture2D(tDiffuse, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  gl_FragColor = vec4(c / 8.0, 1.0);
}`, { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() } });

const upMat = postMat(`
uniform sampler2D tDiffuse; uniform sampler2D tAdd; uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec2 o = uTexel;
  vec3 c = texture2D(tDiffuse, vUv + vec2(-2.0 * o.x, 0.0)).rgb;
  c += texture2D(tDiffuse, vUv + vec2(-o.x, o.y)).rgb * 2.0;
  c += texture2D(tDiffuse, vUv + vec2(0.0, 2.0 * o.y)).rgb;
  c += texture2D(tDiffuse, vUv + vec2(o.x, o.y)).rgb * 2.0;
  c += texture2D(tDiffuse, vUv + vec2(2.0 * o.x, 0.0)).rgb;
  c += texture2D(tDiffuse, vUv + vec2(o.x, -o.y)).rgb * 2.0;
  c += texture2D(tDiffuse, vUv + vec2(0.0, -2.0 * o.y)).rgb;
  c += texture2D(tDiffuse, vUv + vec2(-o.x, -o.y)).rgb * 2.0;
  gl_FragColor = vec4(c / 12.0 + texture2D(tAdd, vUv).rgb, 1.0);
}`, { tDiffuse: { value: null }, tAdd: { value: null }, uTexel: { value: new THREE.Vector2() } });

const flareMat = postMat(`
uniform sampler2D tDiffuse; uniform vec2 uTexel; uniform float uSpread; uniform float uCut;
varying vec2 vUv;
void main() {
  vec3 c = vec3(0.0);
  float ws = 0.0;
  for (int i = -7; i <= 7; i++) {
    float fi = float(i);
    float w = exp(-fi * fi / 24.0);
    vec3 s = texture2D(tDiffuse, vUv + vec2(fi * uTexel.x * uSpread, 0.0)).rgb;
    c += max(s - vec3(uCut), vec3(0.0)) * w;
    ws += w;
  }
  gl_FragColor = vec4(c / ws, 1.0);
}`, { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() }, uSpread: { value: 1 }, uCut: { value: 0 } });

const compositeMat = postMat(`
uniform sampler2D tScene; uniform sampler2D tBloom; uniform sampler2D tFlare; uniform sampler2D tMask;
uniform vec2 uRes; uniform vec2 uVP;
uniform float uBlur; uniform float uSamples; uniform float uBloom; uniform float uFlare; uniform vec3 uFlareTint;
uniform float uExposure; uniform float uTime; uniform float uAberr; uniform float uVignette; uniform float uGrain;
uniform vec3 uFlash;
varying vec2 vUv;
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
vec3 toSRGB(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void main() {
  vec2 uv = vUv;
  vec3 base = min(texture2D(tScene, uv).rgb, vec3(60.0));
  float mask = texture2D(tMask, uv).r;
  vec2 d = uv - uVP;
  float len = length(d);
  vec2 nd = d / max(len, 1e-4);
  float amt = uBlur * min(len, 0.85) * (1.0 - mask);
  vec3 acc = base;
  float wsum = 1.0;
  if (amt > 0.0005) {
    float j = hash(gl_FragCoord.xy + fract(uTime * 7.0) * 113.0);
    for (int i = 1; i <= 10; i++) {
      float fi = float(i);
      if (fi > uSamples) break;
      float t = (fi - j) / uSamples;
      vec2 suv = uv - nd * amt * t;
      float w = (1.0 - texture2D(tMask, suv).r) * (1.0 - 0.45 * t);
      acc += min(texture2D(tScene, suv).rgb, vec3(60.0)) * w;
      wsum += w;
    }
  }
  vec3 col = acc / wsum;
  vec2 cd = uv - 0.5;
  vec2 ca = cd * dot(cd, cd) * uAberr;
  float keep = 1.0 - mask;
  col.r += (texture2D(tScene, uv + ca).r - base.r) * keep;
  col.b += (texture2D(tScene, uv - ca).b - base.b) * keep;
  col = max(col, vec3(0.0));
  col += texture2D(tBloom, uv).rgb * uBloom;
  col += texture2D(tFlare, uv).rgb * uFlareTint * uFlare;
  col += uFlash;
  col = aces(col * uExposure);
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, col * vec3(0.9, 0.98, 1.14), (1.0 - l) * 0.55);
  col += vec3(0.004, 0.007, 0.016) * (1.0 - l);
  vec2 vq = cd * vec2(uRes.x / uRes.y, 1.0);
  col *= mix(1.0, smoothstep(1.25, 0.32, length(vq)), uVignette);
  vec3 o = toSRGB(col);
  o += (hash(gl_FragCoord.xy + uTime * 61.7) - 0.5) * uGrain;
  gl_FragColor = vec4(o, 1.0);
}`, {
  tScene: { value: null }, tBloom: { value: null }, tFlare: { value: null }, tMask: { value: null },
  uRes: { value: new THREE.Vector2(1, 1) }, uVP: { value: new THREE.Vector2(0.5, 0.55) },
  uBlur: { value: 0 }, uSamples: { value: 9 }, uBloom: { value: HDR ? 0.16 : 0.12 }, uFlare: { value: 0.2 },
  uFlareTint: { value: new THREE.Vector3(0.45, 0.65, 1.25) },
  uExposure: { value: 0.95 }, uTime: { value: 0 }, uAberr: { value: 0.02 }, uVignette: { value: 0.7 }, uGrain: { value: 0.035 },
  uFlash: { value: new THREE.Vector3() },
});
const maskMat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });

function renderFrame() {
  renderer.setRenderTarget(sceneRT);
  renderer.render(scene, camera);

  // a quarter-res silhouette of the player's car keeps it sharp while the world smears
  scene.overrideMaterial = maskMat;
  camera.layers.set(1);
  renderer.setRenderTarget(maskRT);
  renderer.render(scene, camera);
  camera.layers.set(0);
  scene.overrideMaterial = null;

  prefilterMat.uniforms.tDiffuse.value = sceneRT.texture;
  prefilterMat.uniforms.uTexel.value.set(1 / sceneRT.width, 1 / sceneRT.height);
  runPass(prefilterMat, downRT[0]);
  for (let i = 1; i < LEVELS; i++) {
    const s = downRT[i - 1];
    downMat.uniforms.tDiffuse.value = s.texture;
    downMat.uniforms.uTexel.value.set(1 / s.width, 1 / s.height);
    runPass(downMat, downRT[i]);
  }
  let cur = downRT[LEVELS - 1];
  for (let i = LEVELS - 2; i >= 0; i--) {
    upMat.uniforms.tDiffuse.value = cur.texture;
    upMat.uniforms.tAdd.value = downRT[i].texture;
    upMat.uniforms.uTexel.value.set(0.5 / cur.width, 0.5 / cur.height);
    runPass(upMat, upRT[i]);
    cur = upRT[i];
  }

  const fu = flareMat.uniforms;
  fu.uTexel.value.set(1 / downRT[1].width, 1 / downRT[1].height);
  fu.tDiffuse.value = downRT[1].texture; fu.uSpread.value = 1.6; fu.uCut.value = 2.4;
  runPass(flareMat, flareRT[0]);
  fu.tDiffuse.value = flareRT[0].texture; fu.uSpread.value = 5.0; fu.uCut.value = 0.0;
  runPass(flareMat, flareRT[1]);
  fu.tDiffuse.value = flareRT[1].texture; fu.uSpread.value = 14.0;
  runPass(flareMat, flareRT[0]);

  const cu = compositeMat.uniforms;
  cu.tScene.value = sceneRT.texture;
  cu.tBloom.value = upRT[0].texture;
  cu.tFlare.value = flareRT[0].texture;
  cu.tMask.value = maskRT.texture;
  runPass(compositeMat, null);
}

let qScale = 1;
const basePR = Math.min(window.devicePixelRatio || 1, coarse ? 1.0 : 1.25);
let viewW = 1;
let viewH = 1;
function resize() {
  viewW = Math.max(1, window.innerWidth);
  viewH = Math.max(1, window.innerHeight);
  const pr = basePR * qScale;
  renderer.setPixelRatio(pr);
  renderer.setSize(viewW, viewH, false);
  const w = Math.max(2, Math.round(viewW * pr));
  const h = Math.max(2, Math.round(viewH * pr));
  sceneRT.setSize(w, h);
  let bw = w;
  let bh = h;
  for (let i = 0; i < LEVELS; i++) {
    bw = Math.max(1, bw >> 1);
    bh = Math.max(1, bh >> 1);
    downRT[i].setSize(bw, bh);
    upRT[i].setSize(bw, bh);
  }
  flareRT[0].setSize(downRT[1].width, downRT[2].height);
  flareRT[1].setSize(downRT[1].width, downRT[2].height);
  maskRT.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
  compositeMat.uniforms.uRes.value.set(w, h);
  camera.aspect = viewW / viewH;
  camera.updateProjectionMatrix();
}

// ---------- geometry helpers ----------
const boxAt = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
const cylAt = (rt, rb, h, seg, x, y, z) => new THREE.CylinderGeometry(rt, rb, h, seg).translate(x, y, z);
const flatPlane = (w, l, x, y, z) => new THREE.PlaneGeometry(w, l).rotateX(-Math.PI / 2).translate(x, y, z);

function mergeGeometries(list, colors) {
  const parts = list.map((g) => (g.index ? g.toNonIndexed() : g));
  let total = 0;
  for (const g of parts) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const hasUv = parts.every((g) => !!g.attributes.uv);
  const uv = hasUv ? new Float32Array(total * 2) : null;
  const col = colors ? new Float32Array(total * 3) : null;
  let o = 0;
  parts.forEach((g, gi) => {
    if (!g.attributes.normal) g.computeVertexNormals();
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    if (uv) uv.set(g.attributes.uv.array, o * 2);
    if (col) {
      const c = colors[gi];
      for (let i = 0; i < n; i++) { col[(o + i) * 3] = c[0]; col[(o + i) * 3 + 1] = c[1]; col[(o + i) * 3 + 2] = c[2]; }
    }
    o += n;
  });
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  if (uv) out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

// smooth shading across gentle curves, hard edges where faces meet at a sharp angle
function creaseNormals(geo, angle) {
  const pos = geo.attributes.position;
  const n = pos.count;
  const cosT = Math.cos(angle);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  const faceN = [];
  const buckets = new Map();
  const key = (i) => Math.round(pos.getX(i) * 500) + ',' + Math.round(pos.getY(i) * 500) + ',' + Math.round(pos.getZ(i) * 500);
  for (let f = 0; f < n; f += 3) {
    a.fromBufferAttribute(pos, f); b.fromBufferAttribute(pos, f + 1); c.fromBufferAttribute(pos, f + 2);
    e1.subVectors(c, b); e2.subVectors(a, b);
    const fn = e1.cross(e2).normalize().clone();
    faceN.push(fn);
    for (let k = 0; k < 3; k++) {
      const kk = key(f + k);
      let arr = buckets.get(kk);
      if (!arr) { arr = []; buckets.set(kk, arr); }
      arr.push(fn);
    }
  }
  const nor = new Float32Array(n * 3);
  const acc = new THREE.Vector3();
  for (let f = 0; f < n; f += 3) {
    const fn = faceN[f / 3];
    for (let k = 0; k < 3; k++) {
      acc.set(0, 0, 0);
      for (const o of buckets.get(key(f + k))) if (o.dot(fn) > cosT) acc.add(o);
      if (acc.lengthSq() < 1e-8) acc.copy(fn);
      acc.normalize();
      nor[(f + k) * 3] = acc.x; nor[(f + k) * 3 + 1] = acc.y; nor[(f + k) * 3 + 2] = acc.z;
    }
  }
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return geo;
}

// ---------- canvas textures ----------
function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function toTex(c, opts = {}) {
  const t = new THREE.CanvasTexture(c);
  if (opts.srgb !== false) t.encoding = THREE.sRGBEncoding;
  if (opts.repeat) { t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.RepeatWrapping; }
  if (opts.aniso) t.anisotropy = maxAniso;
  return t;
}
function rr(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

const ROAD_W = 17;
const ROAD_TEX_LEN = 24;
function makeRoadTextures() {
  const W = 512, H = 2048;
  const px = (x) => (x + ROAD_W / 2) * W / ROAD_W;
  const py = (m) => m * H / ROAD_TEX_LEN;
  const base = makeCanvas(W, H), g = base.getContext('2d');
  const emc = makeCanvas(W, H), e = emc.getContext('2d');
  const roc = makeCanvas(W, H), r = roc.getContext('2d');
  g.fillStyle = '#26292f'; g.fillRect(0, 0, W, H);
  e.fillStyle = '#000000'; e.fillRect(0, 0, W, H);
  r.fillStyle = 'rgb(168,168,168)'; r.fillRect(0, 0, W, H);
  const blot = (ctx, x, y, rx, ry, style) => {
    ctx.fillStyle = style;
    for (const oy of [-H, 0, H]) { ctx.beginPath(); ctx.ellipse(x, y + oy, rx, ry, 0, 0, Math.PI * 2); ctx.fill(); }
  };
  for (let i = 0; i < 80; i++) {
    blot(g, rand(0, W), rand(0, H), rand(8, 46), rand(30, 220), Math.random() < 0.55 ? `rgba(0,0,0,${rand(0.05, 0.14).toFixed(3)})` : `rgba(120,126,138,${rand(0.03, 0.07).toFixed(3)})`);
  }
  for (let i = 0; i < 28; i++) blot(r, rand(0, W), rand(0, H), rand(20, 70), rand(80, 360), `rgba(55,55,55,${rand(0.35, 0.7).toFixed(3)})`);
  for (const lc of [-5.4, -1.8, 1.8, 5.4]) {
    for (const off of [-0.8, 0.8]) {
      const x0 = px(lc + off - 0.38), x1 = px(lc + off + 0.38);
      const gd = g.createLinearGradient(x0, 0, x1, 0);
      gd.addColorStop(0, 'rgba(0,0,0,0)'); gd.addColorStop(0.5, 'rgba(0,0,0,0.17)'); gd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gd; g.fillRect(x0, 0, x1 - x0, H);
      const gr = r.createLinearGradient(x0, 0, x1, 0);
      gr.addColorStop(0, 'rgba(80,80,80,0)'); gr.addColorStop(0.5, 'rgba(80,80,80,0.55)'); gr.addColorStop(1, 'rgba(80,80,80,0)');
      r.fillStyle = gr; r.fillRect(x0, 0, x1 - x0, H);
    }
  }
  const img = g.getImageData(0, 0, W, H), d = img.data;
  for (let i = 0; i < d.length; i += 4) { const nz = (Math.random() - 0.5) * 30; d[i] += nz; d[i + 1] += nz; d[i + 2] += nz + 2; }
  g.putImageData(img, 0, 0);
  const paint = (x0, x1, y0, y1, color, glow) => {
    const X0 = px(x0), X1 = px(x1), Y0 = py(y0), Y1 = py(y1);
    g.fillStyle = color; g.fillRect(X0, Y0, X1 - X0, Y1 - Y0);
    e.fillStyle = glow; e.fillRect(X0, Y0, X1 - X0, Y1 - Y0);
    r.fillStyle = 'rgb(205,205,205)'; r.fillRect(X0, Y0, X1 - X0, Y1 - Y0);
  };
  paint(-7.43, -7.27, 0, 24, '#cfae45', '#2c2408');   // median-side edge line (yellow)
  paint(7.27, 7.43, 0, 24, '#dcd9cf', '#2a2a2a');     // outside edge line (white)
  for (const lx of [-3.6, 0, 3.6]) for (const y0 of [0, 12]) paint(lx - 0.075, lx + 0.075, y0, y0 + 3, '#d6d3ca', '#262626');
  const dot = (xm, ym, c, glow) => {
    const X = px(xm), Y = py(ym);
    g.fillStyle = c; g.fillRect(X - 2, Y - 3, 4, 6);
    e.fillStyle = glow; e.fillRect(X - 2, Y - 3, 4, 6);
  };
  for (const lx of [-3.6, 0, 3.6]) for (const ym of [7.5, 19.5]) dot(lx, ym, '#e6e6e6', '#ffffff');
  for (const ym of [3, 9, 15, 21]) { dot(-7.35, ym, '#e8c24a', '#ffc340'); dot(7.35, ym, '#e6e6e6', '#d6e0ff'); }
  return { map: toTex(base, { repeat: true, aniso: true }), emissive: toTex(emc, { repeat: true, aniso: true }), rough: toTex(roc, { srgb: false, repeat: true, aniso: true }) };
}

function makeBarrierTextures() {
  const W = 128, H = 512;
  const c = makeCanvas(W, H), g = c.getContext('2d');
  const ce = makeCanvas(W, H), e = ce.getContext('2d');
  g.fillStyle = '#7d8290'; g.fillRect(0, 0, W, H);
  e.fillStyle = '#000000'; e.fillRect(0, 0, W, H);
  const img = g.getImageData(0, 0, W, H), d = img.data;
  for (let i = 0; i < d.length; i += 4) { const nz = (Math.random() - 0.5) * 26; d[i] += nz; d[i + 1] += nz; d[i + 2] += nz; }
  g.putImageData(img, 0, 0);
  const gd = g.createLinearGradient(0, 0, W * 0.5, 0);
  gd.addColorStop(0, 'rgba(18,18,24,0.6)'); gd.addColorStop(1, 'rgba(18,18,24,0)');
  g.fillStyle = gd; g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(14,14,20,0.85)'; g.fillRect(0, 0, W, 3);
  const rx = Math.round(0.52 * W), ry = Math.round(H * 0.5);
  g.fillStyle = '#c9a033'; g.fillRect(rx, ry, 6, 10);
  e.fillStyle = '#ffb233'; e.fillRect(rx, ry, 6, 10);
  return { map: toTex(c, { repeat: true, aniso: true }), emissive: toTex(ce, { repeat: true }) };
}

function glowTexture(w, h, fn) {
  const c = makeCanvas(w, h), g = c.getContext('2d');
  const img = g.createImageData(w, h), d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w * 2 - 1, v = (y + 0.5) / h * 2 - 1;
      const a = clamp(fn(u, v), 0, 1) * 255;
      const i = (y * w + x) * 4;
      d[i] = a; d[i + 1] = a; d[i + 2] = a; d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return toTex(c, { srgb: false });
}
const texPool = glowTexture(128, 128, (u, v) => Math.pow(Math.max(0, 1 - Math.hypot(u, v)), 2.2));
const texStreak = glowTexture(32, 256, (u, v) => Math.exp(-(u * u) / 0.09) * Math.pow(Math.max(0, 1 - v * v), 1.6));
const texSoftRect = glowTexture(64, 128, (u, v) => smooth(1.0, 0.5, Math.max(Math.abs(u), Math.abs(v))));
const texShadow = glowTexture(64, 128, (u, v) => smooth(1.0, 0.35, Math.pow(Math.pow(Math.abs(u), 4) + Math.pow(Math.abs(v), 4), 0.25)));

// text-bearing textures get redrawn once the web fonts arrive
const SIGN_FONT = '"Overpass", "Arial Narrow", Arial, sans-serif';
const MONO_FONT = '"Overpass Mono", Menlo, Consolas, monospace';
const DISPLAY_FONT = '"Big Shoulders Display", "Oswald", "Arial Narrow", Impact, sans-serif';
const textTextures = [];
function textTexture(w, h, draw) {
  const c = makeCanvas(w, h), g = c.getContext('2d');
  draw(g, w, h);
  const t = toTex(c, { aniso: true });
  textTextures.push({ g, w, h, draw, t });
  return t;
}
function redrawText() {
  for (const tt of textTextures) { tt.g.clearRect(0, 0, tt.w, tt.h); tt.draw(tt.g, tt.w, tt.h); tt.t.needsUpdate = true; }
}
function arrowGlyph(g, x, y, s, ang) {
  g.save(); g.translate(x, y); g.rotate(ang);
  g.beginPath();
  g.moveTo(-s * 0.12, s * 0.5); g.lineTo(-s * 0.12, -s * 0.02); g.lineTo(-s * 0.34, -s * 0.02);
  g.lineTo(0, -s * 0.5); g.lineTo(s * 0.34, -s * 0.02); g.lineTo(s * 0.12, -s * 0.02); g.lineTo(s * 0.12, s * 0.5);
  g.closePath(); g.fill(); g.restore();
}
function drawSign(spec) {
  return (g, w, h) => {
    g.fillStyle = '#0d6a44'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#eef2ec'; g.lineWidth = 10; rr(g, 14, 14, w - 28, h - 28, 26); g.stroke();
    g.fillStyle = '#eef2ec'; g.textBaseline = 'alphabetic'; g.textAlign = 'left';
    if (spec.exit) {
      g.font = `800 44px ${SIGN_FONT}`;
      const tw = g.measureText(spec.exit).width + 44;
      g.lineWidth = 6; rr(g, w - tw - 44, 40, tw, 66, 12); g.stroke();
      g.fillText(spec.exit, w - tw - 22, 90);
    }
    g.font = `800 ${spec.big}px ${SIGN_FONT}`; g.fillText(spec.l1, 60, spec.y1);
    g.font = `600 ${spec.mid}px ${SIGN_FONT}`; g.fillText(spec.l2, 64, spec.y2);
    if (spec.arrow === 'exit') arrowGlyph(g, w - 140, h - 140, 150, Math.PI / 4);
    if (spec.arrow === 'down') { arrowGlyph(g, w - 230, h - 110, 110, Math.PI); arrowGlyph(g, w - 110, h - 110, 110, Math.PI); }
  };
}
const texSignA = textTexture(1024, 448, drawSign({ exit: 'EXIT 21', l1: 'Downtown', l2: 'Harbor Blvd', big: 150, y1: 255, mid: 84, y2: 365, arrow: 'exit' }));
const texSignB = textTexture(1024, 544, drawSign({ l1: 'Airport', l2: 'Ocean Ave', big: 150, y1: 210, mid: 84, y2: 320, arrow: 'down' }));
const texPlate = textTexture(256, 64, (g, w, h) => {
  g.fillStyle = '#e6e9f0'; rr(g, 2, 2, w - 4, h - 4, 8); g.fill();
  g.strokeStyle = '#1b2440'; g.lineWidth = 3; rr(g, 3, 3, w - 6, h - 6, 7); g.stroke();
  g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  g.fillStyle = '#25389a'; g.font = `600 11px ${MONO_FONT}`; g.fillText('AFTER MIDNIGHT', w / 2, 16);
  g.fillStyle = '#121a33'; g.font = `600 34px ${MONO_FONT}`; g.fillText('NITE 60', w / 2, 53);
});
function drawNeon(lines) {
  return (g, w, h) => {
    const gd = g.createLinearGradient(0, 0, 0, h);
    gd.addColorStop(0, '#0b0d1a'); gd.addColorStop(1, '#03040a');
    g.fillStyle = gd; g.fillRect(0, 0, w, h);
    g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    for (const L of lines) {
      g.font = L.font;
      g.shadowColor = L.glow; g.shadowBlur = 30; g.fillStyle = L.color; g.fillText(L.t, w / 2, L.y);
      g.shadowBlur = 10; g.fillText(L.t, w / 2, L.y);
      g.shadowBlur = 0; g.globalAlpha = 0.55; g.fillStyle = '#ffffff'; g.fillText(L.t, w / 2, L.y); g.globalAlpha = 1;
    }
    g.strokeStyle = 'rgba(255,255,255,0.08)'; g.lineWidth = 6; g.strokeRect(3, 3, w - 6, h - 6);
  };
}
const texBoards = [
  textTexture(1024, 384, drawNeon([
    { t: 'NOVA', font: `900 200px ${DISPLAY_FONT}`, color: '#6ff3ff', glow: '#1ad9ff', y: 225 },
    { t: 'OPEN ALL NIGHT', font: `800 52px ${SIGN_FONT}`, color: '#ff6fd8', glow: '#ff2fb9', y: 318 },
  ])),
  textTexture(1024, 384, drawNeon([
    { t: 'LATE DINER', font: `900 150px ${DISPLAY_FONT}`, color: '#ffb35c', glow: '#ff7a1a', y: 190 },
    { t: 'COFFEE · PANCAKES · 24/7', font: `800 46px ${SIGN_FONT}`, color: '#ffe8c4', glow: '#ff9d3d', y: 292 },
  ])),
  textTexture(1024, 384, drawNeon([
    { t: 'NIGHT FM', font: `900 170px ${DISPLAY_FONT}`, color: '#ff5470', glow: '#ff1f4a', y: 205 },
    { t: '101.7 · NO TALK, JUST DRIVING', font: `800 42px ${SIGN_FONT}`, color: '#d4e3ff', glow: '#7fa8ff', y: 300 },
  ])),
];
if (document.fonts && document.fonts.load) {
  Promise.all([
    document.fonts.load(`800 80px ${SIGN_FONT}`),
    document.fonts.load(`600 30px ${MONO_FONT}`),
    document.fonts.load(`900 80px ${DISPLAY_FONT}`),
  ]).then(redrawText).catch(() => {});
}

// ---------- sky, stars, distant skyline ----------
const SKY = { zenith: lin('#03060f'), mid: lin('#0a1633'), horizon: lin('#1b3263'), glow: lin('#25386a') };
const FOG_DENSITY = 0.0021;
const FOG_COLOR = SKY.horizon.clone().add(SKY.glow.clone().multiplyScalar(0.45));
scene.fog = new THREE.FogExp2(FOG_COLOR, FOG_DENSITY);

const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  uniforms: { uZenith: { value: SKY.zenith }, uMid: { value: SKY.mid }, uHorizon: { value: SKY.horizon }, uGlow: { value: SKY.glow }, uTime: { value: 0 } },
  vertexShader: `
    varying vec3 vDir;
    void main() { vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
  fragmentShader: `
    uniform vec3 uZenith; uniform vec3 uMid; uniform vec3 uHorizon; uniform vec3 uGlow; uniform float uTime;
    varying vec3 vDir;
    float h21(vec2 p) { p = fract(p * vec2(234.34, 435.345)); p += dot(p, p + 34.23); return fract(p.x * p.y); }
    float vnoise(vec2 p) {
      vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
    }
    float fbm(vec2 p) { float s = 0.0; float a = 0.5; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
    void main() {
      vec3 d = normalize(vDir);
      float h = d.y;
      vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.16, h));
      col = mix(col, uZenith, smoothstep(0.12, 0.75, h));
      col += uGlow * exp(-max(h, 0.0) * 11.0) * 0.45;
      vec2 cp = d.xz / max(h + 0.08, 0.04);
      float c = fbm(cp * 0.55 + vec2(uTime * 0.004, 0.0));
      float band = smoothstep(0.02, 0.10, h) * (1.0 - smoothstep(0.30, 0.65, h));
      float cl = smoothstep(0.48, 0.82, c) * band;
      col = mix(col, uGlow * 0.9 + uMid * 0.5, cl * 0.45);
      col = mix(col, uHorizon + uGlow * 0.45, smoothstep(0.0, -0.05, h));
      gl_FragColor = vec4(col, 1.0);
    }`,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(3000, 48, 24), skyMat);
sky.renderOrder = -3;
sky.frustumCulled = false;
scene.add(sky);

const stars = (() => {
  const N = 1100;
  const pos = new Float32Array(N * 3), aB = new Float32Array(N), aP = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const az = rand(0, Math.PI * 2);
    const el = Math.asin(rand(Math.sin(0.12), 0.98));
    const R = 2600;
    pos[i * 3] = Math.cos(el) * Math.sin(az) * R;
    pos[i * 3 + 1] = Math.sin(el) * R;
    pos[i * 3 + 2] = Math.cos(el) * Math.cos(az) * R;
    aB[i] = Math.pow(Math.random(), 3) * 1.6 + 0.12;
    aP[i] = rand(0, 6.28);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aB', new THREE.BufferAttribute(aB, 1));
  geo.setAttribute('aP', new THREE.BufferAttribute(aP, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPR: { value: 1 } },
    vertexShader: `
      attribute float aB; attribute float aP; uniform float uTime; uniform float uPR; varying float vB;
      void main() {
        vB = aB * (0.75 + 0.25 * sin(uTime * (1.5 + aP) + aP * 7.0)) * smoothstep(0.0, 0.3, normalize(position).y);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = (1.2 + aB * 1.1) * uPR;
      }`,
    fragmentShader: `
      varying float vB;
      void main() { vec2 c = gl_PointCoord - 0.5; float a = smoothstep(0.5, 0.0, length(c)); gl_FragColor = vec4(vec3(0.75, 0.83, 1.0) * vB * a, 1.0); }`,
    blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = -2;
  scene.add(pts);
  return pts;
})();

function makeSkylineTextures() {
  const W = 2048, H = 512;
  const sc = makeCanvas(W, H), g = sc.getContext('2d');
  const lc = makeCanvas(W, H), l = lc.getContext('2d');
  l.fillStyle = '#000000'; l.fillRect(0, 0, W, H);
  const block = (x, bw, bh, shade) => {
    for (const ox of [0, -W, W]) { const X = x + ox; if (X > W || X + bw < 0) continue; g.fillStyle = shade; g.fillRect(X, H - bh, bw, bh); }
  };
  const lite = (x, y, color) => {
    l.fillStyle = color;
    for (const ox of [0, -W, W]) { const X = x + ox; if (X >= 0 && X < W) l.fillRect(X, y, 1, 1); }
  };
  let x = 0;
  while (x < W) {
    const bw = rand(10, 46);
    const t = x / W;
    const cluster = Math.pow(0.5 + 0.5 * Math.cos((t - 0.3) * Math.PI * 4), 3);
    const bh = rand(20, 70) + cluster * rand(60, 330) * (Math.random() < 0.55 ? 1 : 0.45);
    const k = (rand(0, 10)) | 0;
    const shade = `rgb(${9 + k},${14 + k},${30 + k})`;
    block(x, bw, bh, shade);
    const top = H - bh;
    for (let wy = top + 5; wy < H - 6; wy += 4) {
      if (Math.random() < 0.08) continue;
      for (let wx = x + 2; wx < x + bw - 2; wx += 3) {
        if (Math.random() < 0.16) { const r = Math.random(); lite(Math.round(wx), wy, r < 0.5 ? '#ffcf8a' : r < 0.85 ? '#cfe0ff' : '#8fb0ff'); }
      }
    }
    if (bh > 260 && Math.random() < 0.6) block(x + bw / 2 - 1, 2, bh + rand(15, 40), shade);
    if (bh > 220) { l.fillStyle = '#ff3a3a'; l.fillRect(Math.round(x + bw / 2), Math.round(top - 3), 2, 2); }
    x += bw + rand(-4, 3);
  }
  return { sil: toTex(sc, { repeat: true }), lit: toTex(lc, { repeat: true }) };
}
const skylineTex = makeSkylineTextures();
skylineTex.sil.wrapT = THREE.ClampToEdgeWrapping;
skylineTex.lit.wrapT = THREE.ClampToEdgeWrapping;
const skyline = new THREE.Mesh(
  new THREE.CylinderGeometry(1700, 1700, 380, 96, 1, true),
  new THREE.ShaderMaterial({
    side: THREE.BackSide, transparent: true, depthWrite: false, fog: false,
    uniforms: { tSil: { value: skylineTex.sil }, tLit: { value: skylineTex.lit }, uHaze: { value: FOG_COLOR } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform sampler2D tSil; uniform sampler2D tLit; uniform vec3 uHaze;
      varying vec2 vUv;
      void main() {
        vec2 uv = vec2(vUv.x * 3.0, vUv.y);
        vec4 s = texture2D(tSil, uv);
        vec3 lights = texture2D(tLit, uv).rgb;
        float hz = smoothstep(0.5, 0.0, vUv.y);
        vec3 col = mix(s.rgb, uHaze, 0.45 + 0.4 * hz) + lights * (1.6 - 0.7 * hz);
        gl_FragColor = vec4(col, s.a);
      }`,
  }),
);
skyline.position.y = 380 / 2 - 30;
skyline.renderOrder = -1;
skyline.frustumCulled = false;
scene.add(skyline);

// ---------- environment reflections (built once) ----------
function buildEnvMap() {
  const envScene = new THREE.Scene();
  const envGeo = new THREE.SphereGeometry(60, 64, 32);
  const ep = envGeo.attributes.position;
  const ec = new Float32Array(ep.count * 3);
  const zen = lin('#0b1530'), hor = lin('#3d5ea6'), gnd = lin('#0a0d16');
  const ccol = new THREE.Color();
  for (let i = 0; i < ep.count; i++) {
    const h = ep.getY(i) / 60;
    ccol.copy(hor).lerp(zen, smooth(0, 0.6, h)).lerp(gnd, smooth(0, -0.12, h));
    const band = 1.2 * Math.exp(-Math.abs(h) * 18);
    ec[i * 3] = ccol.r + hor.r * band; ec[i * 3 + 1] = ccol.g + hor.g * band; ec[i * 3 + 2] = ccol.b + hor.b * band;
  }
  envGeo.setAttribute('color', new THREE.BufferAttribute(ec, 3));
  envScene.add(new THREE.Mesh(envGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const lampMat = new THREE.MeshBasicMaterial({ color: hdr(2.6, 2.5, 2.4) });
  for (let i = 0; i < 6; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(14, 0.5, 1.6), lampMat);
    b.position.set(rand(-20, 20), 26, -50 + i * 20);
    b.rotation.y = rand(-0.2, 0.2);
    envScene.add(b);
  }
  const warm = new THREE.MeshBasicMaterial({ color: hdr(1.2, 0.7, 0.3), side: THREE.DoubleSide });
  for (let i = 0; i < 10; i++) {
    const a = rand(0, Math.PI * 2);
    const b = new THREE.Mesh(new THREE.PlaneGeometry(rand(8, 20), rand(1, 3)), warm);
    b.position.set(Math.sin(a) * 55, rand(1, 5), Math.cos(a) * 55);
    b.lookAt(0, b.position.y, 0);
    envScene.add(b);
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(envScene, 0.03);
  pmrem.dispose();
  return rt.texture;
}
const envMap = buildEnvMap();

// additive light decals (pools, wet-road reflections) fade to black in the haze instead of to fog colour
const GLOW_VS = `
  varying vec2 vUv; varying float vDepth; varying vec3 vTint;
  void main() {
    vUv = uv;
    vTint = vec3(1.0);
    #ifdef USE_INSTANCING_COLOR
      vTint = instanceColor;
    #endif
    vec4 p = vec4(position, 1.0);
    #ifdef USE_INSTANCING
      p = instanceMatrix * p;
    #endif
    vec4 mv = modelViewMatrix * p;
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;
const GLOW_FS = `
  uniform sampler2D map; uniform vec3 uColor; uniform float uDensity;
  varying vec2 vUv; varying float vDepth; varying vec3 vTint;
  void main() {
    float fd = vDepth * uDensity;
    gl_FragColor = vec4(texture2D(map, vUv).rgb * uColor * vTint * exp(-fd * fd), 1.0);
  }`;
function makeGlowMaterial(map, color, fogScale) {
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: map }, uColor: { value: color }, uDensity: { value: FOG_DENSITY * (fogScale || 1) } },
    vertexShader: GLOW_VS, fragmentShader: GLOW_FS,
    blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
}

// ---------- the freeway ----------
const LANES = [-5.4, -1.8, 1.8, 5.4];
const OPP_LANES = [-12.3, -15.9, -19.5, -23.1];
const MEDIAN_X = -8.85;
const RIGHT_X = 8.85;
const OPP_OUTER_X = -26.55;
const OPP_CENTER = -17.7;
const ROAD_LEN = 1400;
const ROAD_NEAR = 60;
let dist = 0;

const hemi = new THREE.HemisphereLight(lin('#86a2e6'), lin('#0d0f18'), 0.8);
const moon = new THREE.DirectionalLight(lin('#9fb6ff'), 0.35);
moon.position.set(-60, 120, 40);
scene.add(hemi, moon);

const roadTex = makeRoadTextures();
roadTex.map.repeat.set(1, ROAD_LEN / ROAD_TEX_LEN);
const roadMat = new THREE.MeshStandardMaterial({
  color: hdr(1.2, 1.2, 1.3), map: roadTex.map, roughnessMap: roadTex.rough, roughness: 1, metalness: 0,
  emissive: hdr(1, 1, 1), emissiveMap: roadTex.emissive, emissiveIntensity: 1.0, envMap, envMapIntensity: 0.7,
});
for (const cx of [0, OPP_CENTER]) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_W, ROAD_LEN), roadMat);
  m.rotation.x = -Math.PI / 2;
  m.position.set(cx, 0, ROAD_NEAR - ROAD_LEN / 2);
  scene.add(m);
}
const ground = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000), new THREE.MeshStandardMaterial({ color: lin('#0b0f18'), roughness: 1, metalness: 0 }));
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.15;
scene.add(ground);
const walkMat = new THREE.MeshStandardMaterial({ color: lin('#1c212c'), roughness: 0.95, metalness: 0, envMap, envMapIntensity: 0.3 });
for (const [cx, w] of [[11.45, 4.6], [-28.75, 3.8]]) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, ROAD_LEN), walkMat);
  m.rotation.x = -Math.PI / 2;
  m.position.set(cx, 0.03, ROAD_NEAR - ROAD_LEN / 2);
  scene.add(m);
}

const barTex = makeBarrierTextures();
barTex.map.repeat.set(1, 1 / 6);
const barMat = new THREE.MeshStandardMaterial({
  color: hdr(1.2, 1.2, 1.28), map: barTex.map, emissive: hdr(1, 1, 1), emissiveMap: barTex.emissive, emissiveIntensity: 1.1,
  roughness: 0.92, metalness: 0, envMap, envMapIntensity: 0.35,
});
const barProfile = new THREE.Shape([[-0.305, 0], [0.305, 0], [0.305, 0.075], [0.175, 0.33], [0.075, 0.81], [-0.075, 0.81], [-0.175, 0.33], [-0.305, 0.075]].map((p) => new THREE.Vector2(p[0], p[1])));
const barGeo = new THREE.ExtrudeGeometry(barProfile, { depth: ROAD_LEN, bevelEnabled: false, steps: 1 });
barGeo.translate(0, 0, ROAD_NEAR - ROAD_LEN);
for (const x of [MEDIAN_X, RIGHT_X, OPP_OUTER_X]) {
  const m = new THREE.Mesh(barGeo, barMat);
  m.position.x = x;
  scene.add(m);
}

// ---------- city blocks: one instanced draw, windows generated in the shader ----------
const BLD_L = 1700;
const BLD_NEAR = 90;
const blds = [];
function rollBuilding(b) {
  if (b.row === 0) {
    b.w = rand(10, 26);
    b.h = Math.random() < 0.14 ? rand(55, 120) : rand(8, 38);
    b.x = b.side * ((b.side > 0 ? 21 : 37) + b.w / 2 + rand(0, 12));
  } else {
    b.w = rand(22, 52);
    b.h = Math.random() < 0.35 ? rand(120, 270) : rand(35, 115);
    b.x = b.side * ((b.side > 0 ? 60 : 78) + b.w / 2 + rand(0, 90));
  }
  b.seed = Math.random();
}
for (const side of [1, -1]) {
  for (const row of [0, 1]) {
    let cur = rand(0, 20);
    while (cur < BLD_L - 12) {
      const depth = row === 0 ? rand(14, 34) : rand(24, 60);
      const b = { side, row, depth, base: cur + depth / 2, z: null };
      rollBuilding(b);
      blds.push(b);
      cur += depth + (row === 0 ? rand(2, 10) : rand(6, 30));
    }
  }
}
const bGeo = new THREE.BoxGeometry(1, 1, 1);
bGeo.translate(0, 0.5, 0);
const bSeeds = new THREE.InstancedBufferAttribute(new Float32Array(blds.length), 1);
bGeo.setAttribute('aSeed', bSeeds);
const bMat = new THREE.ShaderMaterial({
  uniforms: { uFogColor: { value: FOG_COLOR }, uFogDensity: { value: FOG_DENSITY } },
  extensions: { derivatives: true },
  vertexShader: `
    attribute float aSeed;
    varying vec3 vLocal; varying vec3 vN; varying float vSeed; varying vec3 vSize; varying float vDepth;
    void main() {
      vec3 size = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
      vSize = size;
      vLocal = vec3((position.x + 0.5) * size.x, position.y * size.y, (position.z + 0.5) * size.z);
      vN = normal;
      vSeed = aSeed;
      vec4 mv = viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
      vDepth = -mv.z;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    uniform vec3 uFogColor; uniform float uFogDensity;
    varying vec3 vLocal; varying vec3 vN; varying float vSeed; varying vec3 vSize; varying float vDepth;
    float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    void main() {
      vec3 col;
      float glowAmt = 0.0;
      if (vN.y > 0.5) {
        col = vec3(0.006, 0.008, 0.014);
      } else {
        vec2 fc; float face;
        if (abs(vN.x) > 0.5) { fc = vec2(vLocal.z, vLocal.y); face = vN.x > 0.0 ? 1.0 : 2.0; }
        else { fc = vec2(vLocal.x, vLocal.y); face = vN.z > 0.0 ? 3.0 : 4.0; }
        float style = fract(vSeed * 7.31);
        vec2 sp = style < 0.4 ? vec2(3.1, 3.5) : (style < 0.75 ? vec2(2.2, 3.2) : vec2(4.2, 3.8));
        vec2 ws = style < 0.4 ? vec2(0.58, 0.52) : (style < 0.75 ? vec2(0.78, 0.46) : vec2(0.86, 0.66));
        vec2 g = fc / sp;
        vec2 cell = floor(g);
        vec2 f = fract(g) - 0.5;
        vec2 fw = max(fwidth(g), vec2(0.001));
        vec2 edge = 0.5 * ws;
        vec2 m = smoothstep(edge + fw, edge - fw, abs(f));
        float win = m.x * m.y;
        float blur = clamp(max(fw.x, fw.y) * 2.2 - 0.35, 0.0, 1.0);
        win = mix(win, ws.x * ws.y, blur);
        float h = hash(cell + vec2(vSeed * 91.7, face * 13.3));
        float litP = mix(0.06, 0.24, fract(vSeed * 3.71));
        float lit = step(1.0 - litP, h);
        float fh = hash(vec2(cell.y * 1.37, vSeed * 57.0 + face));
        lit = max(lit, step(0.92, fh) * step(0.25, h));
        float floorOK = step(1.0, cell.y) * step(fc.y + sp.y * 0.6, vSize.y);
        lit = mix(lit * floorOK, litP * 0.85, blur);
        float hc = hash(cell.yx + vSeed * 3.3);
        vec3 wc = hc < 0.45 ? vec3(1.0, 0.70, 0.40) : (hc < 0.85 ? vec3(0.66, 0.80, 1.0) : vec3(0.45, 0.55, 1.0));
        float inten = mix(0.45, 1.25, hash(cell * 1.7 + vSeed));
        vec3 facade = vec3(0.010, 0.013, 0.022) * (0.75 + 0.5 * fract(vSeed * 13.1));
        vec3 glass = vec3(0.016, 0.026, 0.050) + vec3(0.02, 0.035, 0.07) * clamp(fc.y / max(vSize.y, 1.0), 0.0, 1.0);
        col = mix(facade, glass, win * floorOK);
        col += win * lit * wc * inten;
        glowAmt = win * lit;
        float accentOn = step(0.82, fract(vSeed * 5.37)) * step(30.0, vSize.y);
        float band = smoothstep(vSize.y - 1.2, vSize.y - 0.9, vLocal.y) * (1.0 - smoothstep(vSize.y - 0.5, vSize.y - 0.3, vLocal.y));
        vec3 accent = fract(vSeed * 11.0) < 0.5 ? vec3(0.25, 0.85, 1.6) : vec3(1.5, 0.3, 0.75);
        col += band * accentOn * accent * 1.0;
        glowAmt = max(glowAmt, band * accentOn);
        col += vec3(0.30, 0.20, 0.12) * exp(-vLocal.y * 0.28) * 0.18;
      }
      float fd = vDepth * uFogDensity;
      float fogF = 1.0 - exp(-fd * fd);
      col = mix(col, uFogColor, fogF * (1.0 - 0.4 * clamp(glowAmt, 0.0, 1.0)));
      gl_FragColor = vec4(col, 1.0);
    }`,
});
const bMesh = new THREE.InstancedMesh(bGeo, bMat, blds.length);
bMesh.frustumCulled = false;
bMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
scene.add(bMesh);
const bArr = bMesh.instanceMatrix.array;
function writeBuilding(i, b) {
  const o = i * 16;
  bArr.fill(0, o, o + 16);
  bArr[o] = b.w; bArr[o + 5] = b.h; bArr[o + 10] = b.depth;
  bArr[o + 12] = b.x; bArr[o + 14] = b.z || 0; bArr[o + 15] = 1;
  bSeeds.array[i] = b.seed;
}
blds.forEach((b, i) => writeBuilding(i, b));
function updateBuildings() {
  let seedsDirty = false;
  for (let i = 0; i < blds.length; i++) {
    const b = blds[i];
    const z = BLD_NEAR - mod(b.base - dist, BLD_L);
    if (b.z !== null && z < b.z - BLD_L * 0.5) {
      rollBuilding(b);
      b.z = z;
      writeBuilding(i, b);
      seedsDirty = true;
    } else {
      b.z = z;
      bArr[i * 16 + 14] = z;
    }
  }
  bMesh.instanceMatrix.needsUpdate = true;
  if (seedsDirty) bSeeds.needsUpdate = true;
}

// ---------- shared materials for structures ----------
const metalMat = new THREE.MeshStandardMaterial({ color: lin('#2a2f39'), roughness: 0.55, metalness: 0.7, envMap, envMapIntensity: 0.6 });
const concreteMat = new THREE.MeshStandardMaterial({ color: lin('#4a5161'), roughness: 0.92, metalness: 0, envMap, envMapIntensity: 0.25 });
const fasciaMat = new THREE.MeshStandardMaterial({ color: lin('#6d7586'), roughness: 0.85, metalness: 0, envMap, envMapIntensity: 0.3 });
const shellMat = new THREE.MeshStandardMaterial({ color: lin('#15181f'), roughness: 0.4, metalness: 0.6, envMap, envMapIntensity: 0.8 });
const LAMP_COOL = hdr(2.3, 2.45, 2.9);
const matCool = new THREE.MeshBasicMaterial({ color: LAMP_COOL });
const matWarm = new THREE.MeshBasicMaterial({ color: hdr(2.5, 1.45, 0.6) });
const matRed = new THREE.MeshBasicMaterial({ color: hdr(2.6, 0.06, 0.09) });
const glowCool = makeGlowMaterial(texPool, lin('#a9bfff').multiplyScalar(0.18));
const glowWarm = makeGlowMaterial(texPool, lin('#ffb36b').multiplyScalar(0.24));

function instanced(geo, mat, count) {
  const m = new THREE.InstancedMesh(geo, mat, count);
  m.frustumCulled = false;
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const a = m.instanceMatrix.array;
  for (let i = 0; i < count; i++) { const o = i * 16; a.fill(0, o, o + 16); a[o] = 1; a[o + 5] = 1; a[o + 10] = 1; a[o + 15] = 1; }
  scene.add(m);
  return m;
}

// median lamps: tall double-arm poles every 45 m
const LAMP_SP = 45, LAMP_N = 32, LAMP_L = LAMP_SP * LAMP_N, LAMP_NEAR = 45;
const LAMP_Y = 11.8, LAMP_ARM = 6.0;
const LAMP_OUR_X = MEDIAN_X + LAMP_ARM - 0.2;
const LAMP_OPP_X = MEDIAN_X - LAMP_ARM + 0.2;
const lampPoles = instanced(mergeGeometries([
  cylAt(0.12, 0.17, 11.2, 8, 0, 0.81 + 5.6, 0),
  boxAt(LAMP_ARM + 0.2, 0.12, 0.14, LAMP_ARM / 2, LAMP_Y + 0.12, 0),
  boxAt(LAMP_ARM + 0.2, 0.12, 0.14, -LAMP_ARM / 2, LAMP_Y + 0.12, 0),
]), metalMat, LAMP_N);
const lampHeads = instanced(mergeGeometries([
  boxAt(1.1, 0.16, 0.45, LAMP_ARM - 0.2, LAMP_Y, 0),
  boxAt(1.1, 0.16, 0.45, -LAMP_ARM + 0.2, LAMP_Y, 0),
]), matCool, LAMP_N);
const lampPools = instanced(mergeGeometries([
  flatPlane(13, 18, LAMP_ARM - 0.2, 0.05, 0),
  flatPlane(13, 18, -LAMP_ARM + 0.2, 0.05, 0),
]), glowCool, LAMP_N);
const lampZ = new Float32Array(LAMP_N);
for (const m of [lampPoles, lampHeads, lampPools]) { const a = m.instanceMatrix.array; for (let i = 0; i < LAMP_N; i++) a[i * 16 + 12] = MEDIAN_X; }

// sodium street lamps along the frontage roads
const SL_SP = 32, SL_N = 45, SL_L = SL_SP * SL_N, SL_NEAR = 45;
const slPosts = instanced(mergeGeometries([cylAt(0.07, 0.1, 6.6, 6, 0, 3.3, 0), boxAt(1.5, 0.08, 0.1, -0.75, 6.55, 0)]), metalMat, SL_N * 2);
const slHeads = instanced(boxAt(0.6, 0.12, 0.26, -1.35, 6.48, 0), matWarm, SL_N * 2);
const slPools = instanced(flatPlane(9, 12, -1.6, 0.08, 0), glowWarm, SL_N * 2);
for (const m of [slPosts, slHeads, slPools]) {
  const a = m.instanceMatrix.array;
  for (let i = 0; i < SL_N * 2; i++) {
    const o = i * 16;
    if (i >= SL_N) { a[o] = -1; a[o + 10] = -1; a[o + 12] = -28.2; } else { a[o + 12] = 11.0; }
  }
}

// ---------- props that recycle along the road: overpasses, sign gantries, billboards ----------
const props = [];
function addProp(obj, base, L, near, update) { props.push({ obj, base, L, near, update }); scene.add(obj); }

function makeOverpass() {
  const grp = new THREE.Group();
  const deckY = 8.2, deckH = 1.5, deckD = 13, span = 170, cx = -12;
  const top = deckY + deckH / 2;
  const concrete = [
    boxAt(span, deckH, deckD, cx, deckY, 0),
    boxAt(span, 1.0, 0.35, cx, top + 0.5, deckD / 2 - 0.18),
    boxAt(span, 1.0, 0.35, cx, top + 0.5, -deckD / 2 + 0.18),
  ];
  for (const px of [MEDIAN_X, 11.6, -28.8, 34, -58]) concrete.push(boxAt(1.3, deckY - deckH / 2, 3.4, px, (deckY - deckH / 2) / 2, 0));
  grp.add(new THREE.Mesh(mergeGeometries(concrete), concreteMat));
  grp.add(new THREE.Mesh(boxAt(span, 0.45, 0.1, cx, deckY + 0.22, deckD / 2 + 0.05), fasciaMat));
  const under = [];
  for (let x = -27; x <= 9; x += 9) for (const z of [deckD / 2 - 1.2, -deckD / 2 + 1.2]) under.push(boxAt(1.2, 0.08, 0.3, x, deckY - deckH / 2 - 0.05, z));
  grp.add(new THREE.Mesh(mergeGeometries(under), matCool));
  const fascia = [];
  for (let x = cx - span / 2 + 4; x <= cx + span / 2 - 4; x += 7.2) fascia.push(boxAt(0.32, 0.12, 0.08, x, deckY - 0.32, deckD / 2 + 0.1));
  grp.add(new THREE.Mesh(mergeGeometries(fascia), matWarm));
  const posts = [], heads = [];
  for (const x of [-52, -30, -8, 14, 36]) {
    posts.push(cylAt(0.09, 0.12, 5.2, 6, x, top + 2.6, deckD / 2 - 0.3));
    posts.push(boxAt(1.6, 0.08, 0.1, x - 0.8, top + 5.2, deckD / 2 - 0.3));
    heads.push(boxAt(0.7, 0.12, 0.3, x - 1.5, top + 5.12, deckD / 2 - 0.3));
  }
  grp.add(new THREE.Mesh(mergeGeometries(posts), metalMat));
  grp.add(new THREE.Mesh(mergeGeometries(heads), matCool));
  grp.add(new THREE.Mesh(flatPlane(30, 12, -9, 0.06, 0), glowCool));
  const cars = [];
  for (let i = 0; i < 3; i++) {
    const c = new THREE.Group();
    const y = top + 0.75;
    c.add(new THREE.Mesh(boxAt(4.4, 1.2, 1.8, 0, y, 0), shellMat));
    c.add(new THREE.Mesh(mergeGeometries([boxAt(0.06, 0.12, 0.34, 2.23, y - 0.1, 0.55), boxAt(0.06, 0.12, 0.34, 2.23, y - 0.1, -0.55)]), matCool));
    c.add(new THREE.Mesh(mergeGeometries([boxAt(0.06, 0.12, 0.34, -2.23, y - 0.05, 0.55), boxAt(0.06, 0.12, 0.34, -2.23, y - 0.05, -0.55)]), matRed));
    const dir = i % 2 === 0 ? 1 : -1;
    c.rotation.y = dir > 0 ? 0 : Math.PI;
    c.position.set(rand(-85, 60), 0, dir > 0 ? -2.8 : 2.8);
    c.userData.dir = dir;
    c.userData.v = rand(14, 22);
    grp.add(c);
    cars.push(c);
  }
  grp.userData.cars = cars;
  return grp;
}
function updateOverpass(dt, grp) {
  for (const c of grp.userData.cars) {
    c.position.x += c.userData.dir * c.userData.v * dt;
    if (c.position.x > 66) c.position.x = -90;
    else if (c.position.x < -90) c.position.x = 66;
  }
}

function makeGantry() {
  const grp = new THREE.Group();
  const signMat = (tex) => new THREE.MeshStandardMaterial({ map: tex, emissive: hdr(1, 1, 1), emissiveMap: tex, emissiveIntensity: 0.6, roughness: 0.6, metalness: 0 });
  const parts = [
    boxAt(0.45, 8.6, 0.45, MEDIAN_X, 5.1, 0),
    boxAt(0.45, 9.4, 0.45, 10.3, 4.7, 0),
    boxAt(19.6, 0.32, 0.32, 0.72, 8.3, -0.35),
    boxAt(19.6, 0.32, 0.32, 0.72, 8.3, 0.35),
    boxAt(19.6, 0.32, 0.32, 0.72, 6.0, -0.35),
  ];
  for (let x = -8.4; x <= 9.8; x += 1.4) parts.push(boxAt(0.08, 2.3, 0.08, x, 7.15, -0.35));
  parts.push(boxAt(7.4, 3.2, 0.12, -3.0, 7.4, 0.55), boxAt(6.0, 3.2, 0.12, 4.6, 7.4, 0.55));
  grp.add(new THREE.Mesh(mergeGeometries(parts), metalMat));
  const a = new THREE.Mesh(new THREE.PlaneGeometry(7.4, 3.2), signMat(texSignA));
  a.position.set(-3.0, 7.4, 0.62);
  const b = new THREE.Mesh(new THREE.PlaneGeometry(6.0, 3.2), signMat(texSignB));
  b.position.set(4.6, 7.4, 0.62);
  grp.add(a, b);
  const fixtures = [];
  for (const x of [-5.6, -3.0, -0.4, 2.6, 6.6]) fixtures.push(boxAt(0.5, 0.1, 0.25, x, 5.65, 0.9));
  grp.add(new THREE.Mesh(mergeGeometries(fixtures), matWarm));
  return grp;
}

function makeBillboard(tex, side) {
  const grp = new THREE.Group();
  grp.add(new THREE.Mesh(mergeGeometries([
    cylAt(0.35, 0.45, 11.5, 10, 0, 5.75, 0),
    boxAt(10.8, 4.3, 0.4, 0, 13.4, -0.1),
    boxAt(10.8, 0.12, 0.9, 0, 11.2, 0.3),
  ]), metalMat));
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(10.2, 3.82), new THREE.MeshBasicMaterial({ map: tex, color: hdr(2.3, 2.3, 2.3) }));
  panel.position.set(0, 13.4, 0.12);
  grp.add(panel);
  const lights = [];
  for (const x of [-4, -1.3, 1.3, 4]) lights.push(boxAt(0.4, 0.1, 0.2, x, 11.3, 0.6));
  grp.add(new THREE.Mesh(mergeGeometries(lights), matCool));
  grp.rotation.y = side > 0 ? -0.42 : 0.42;
  grp.position.x = side > 0 ? 12.4 : -30.6;
  return grp;
}

for (let i = 0; i < 3; i++) addProp(makeOverpass(), 180 + i * 480, 1440, 70, updateOverpass);
addProp(makeGantry(), 420, 1440, 70);
addProp(makeGantry(), 900, 1440, 70);
addProp(makeBillboard(texBoards[0], 1), 330, 1440, 70);
addProp(makeBillboard(texBoards[1], 1), 1010, 1440, 70);
addProp(makeBillboard(texBoards[2], -1), 700, 1440, 70);

function updateWorld(dt) {
  roadTex.map.offset.y = (dist / ROAD_TEX_LEN) % 1;
  barTex.map.offset.y = (dist / 6) % 1;
  updateBuildings();
  const lp = lampPoles.instanceMatrix.array, lh = lampHeads.instanceMatrix.array, lo = lampPools.instanceMatrix.array;
  for (let i = 0; i < LAMP_N; i++) {
    const z = LAMP_NEAR - mod(i * LAMP_SP + 20 - dist, LAMP_L);
    lampZ[i] = z;
    lp[i * 16 + 14] = z; lh[i * 16 + 14] = z; lo[i * 16 + 14] = z;
  }
  lampPoles.instanceMatrix.needsUpdate = true;
  lampHeads.instanceMatrix.needsUpdate = true;
  lampPools.instanceMatrix.needsUpdate = true;
  const sp = slPosts.instanceMatrix.array, sh = slHeads.instanceMatrix.array, so = slPools.instanceMatrix.array;
  for (let i = 0; i < SL_N * 2; i++) {
    const k = i % SL_N;
    const z = SL_NEAR - mod(k * SL_SP + (i >= SL_N ? 16 : 0) - dist, SL_L);
    sp[i * 16 + 14] = z; sh[i * 16 + 14] = z; so[i * 16 + 14] = z;
  }
  slPosts.instanceMatrix.needsUpdate = true;
  slHeads.instanceMatrix.needsUpdate = true;
  slPools.instanceMatrix.needsUpdate = true;
  for (const p of props) {
    p.obj.position.z = p.near - mod(p.base - dist, p.L);
    if (p.update) p.update(dt, p.obj);
  }
}

// ---------- vehicles ----------
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];

// side profile (u: rear -> front, v: height) extruded across the car's width; rear ends up at +z
function profileGeometry(build, width, bevel, length) {
  const s = new THREE.Shape();
  build(s);
  const depth = Math.max(0.01, width - bevel * 2);
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 10, steps: 1 });
  g.translate(0, 0, -depth / 2);
  g.rotateY(Math.PI / 2);
  g.translate(0, 0, length / 2);
  return creaseNormals(g.index ? g.toNonIndexed() : g, 0.75);
}

const CAR_L = 4.5;
const PAINTS = [
  { name: 'Midnight blue', hex: '#1b2f72' },
  { name: 'Candy red', hex: '#9e0d1d' },
  { name: 'Pearl white', hex: '#d7dbe4' },
  { name: 'Gloss black', hex: '#0c0d11' },
  { name: 'Ultraviolet', hex: '#3a1d78' },
  { name: 'Harbor teal', hex: '#0b7f86' },
  { name: 'Sunset orange', hex: '#c9500c' },
];
const paintMat = new THREE.MeshPhysicalMaterial({ color: lin(PAINTS[0].hex), metalness: 0.55, roughness: 0.3, clearcoat: 0.7, clearcoatRoughness: 0.08, envMap, envMapIntensity: 1.0 });
const glassMat = new THREE.MeshStandardMaterial({ color: lin('#05080e'), metalness: 0.4, roughness: 0.05, envMap, envMapIntensity: 1.1 });
const trimMat = new THREE.MeshStandardMaterial({ color: lin('#0c0e13'), metalness: 0.3, roughness: 0.5, envMap, envMapIntensity: 0.6 });
const chromeMat = new THREE.MeshStandardMaterial({ color: lin('#c3c8d2'), metalness: 1, roughness: 0.16, envMap, envMapIntensity: 1.1 });
const tireMat = new THREE.MeshStandardMaterial({ color: lin('#0b0b0d'), roughness: 0.9, metalness: 0 });
const rimMat = new THREE.MeshStandardMaterial({ color: lin('#3a3e47'), metalness: 0.9, roughness: 0.28, envMap, envMapIntensity: 1.2 });
const lensMat = new THREE.MeshStandardMaterial({ color: lin('#2b0408'), metalness: 0.2, roughness: 0.1, envMap, envMapIntensity: 1.2 });
const TAIL_ON = hdr(3.0, 0.07, 0.11);
const tailMat = new THREE.MeshBasicMaterial({ color: TAIL_ON.clone() });
const headMat = new THREE.MeshBasicMaterial({ color: hdr(2.4, 2.5, 2.8) });
const plateMat = new THREE.MeshStandardMaterial({ map: texPlate, emissive: hdr(1, 1, 1), emissiveMap: texPlate, emissiveIntensity: 0.35, roughness: 0.5 });
let paintIdx = 0;
function setPaint(i) { paintIdx = mod(i, PAINTS.length); paintMat.color.copy(lin(PAINTS[paintIdx].hex)); }

const carRoot = new THREE.Group();
const chassis = new THREE.Group();
const body = new THREE.Group();
carRoot.add(chassis);
chassis.add(body);
scene.add(carRoot);
const addTo = (parent, geo, mat) => { const m = new THREE.Mesh(geo, mat); parent.add(m); return m; };

addTo(body, profileGeometry((s) => {
  s.moveTo(0.10, 0.26);
  s.lineTo(0.54, 0.26); s.lineTo(0.54, 0.34);
  s.absarc(0.98, 0.34, 0.44, Math.PI, 0, true);
  s.lineTo(1.42, 0.26); s.lineTo(3.12, 0.26); s.lineTo(3.12, 0.34);
  s.absarc(3.56, 0.34, 0.44, Math.PI, 0, true);
  s.lineTo(4.00, 0.26); s.lineTo(4.36, 0.27);
  s.quadraticCurveTo(4.52, 0.38, 4.48, 0.55);
  s.quadraticCurveTo(4.25, 0.73, 3.55, 0.83);
  s.lineTo(3.22, 0.88);
  s.lineTo(1.20, 0.94);
  s.lineTo(0.32, 0.93);
  s.quadraticCurveTo(0.05, 0.92, 0.02, 0.80);
  s.lineTo(0.0, 0.50);
  s.quadraticCurveTo(0.0, 0.30, 0.10, 0.26);
}, 1.96, 0.05, CAR_L), paintMat);
addTo(body, profileGeometry((s) => {
  s.moveTo(0.80, 0.90); s.lineTo(3.26, 0.86);
  s.quadraticCurveTo(2.95, 1.04, 2.52, 1.18);
  s.quadraticCurveTo(2.05, 1.255, 1.55, 1.225);
  s.quadraticCurveTo(1.12, 1.15, 0.80, 0.90);
}, 1.46, 0.06, CAR_L), glassMat);
addTo(body, profileGeometry((s) => {
  s.moveTo(1.32, 1.235);
  s.quadraticCurveTo(1.62, 1.31, 2.05, 1.325);
  s.quadraticCurveTo(2.42, 1.315, 2.60, 1.25);
  s.lineTo(2.54, 1.235);
  s.quadraticCurveTo(2.05, 1.295, 1.38, 1.215);
  s.lineTo(1.32, 1.235);
}, 1.36, 0.02, CAR_L), paintMat);
addTo(body, mergeGeometries([boxAt(0.2, 0.09, 0.16, -1.02, 1.0, -0.55), boxAt(0.2, 0.09, 0.16, 1.02, 1.0, -0.55)]), paintMat);
addTo(body, mergeGeometries([
  boxAt(1.88, 0.045, 0.34, 0, 1.28, 1.98),
  boxAt(0.03, 0.22, 0.42, -0.95, 1.22, 1.98), boxAt(0.03, 0.22, 0.42, 0.95, 1.22, 1.98),
  boxAt(0.04, 0.32, 0.12, -0.45, 1.10, 1.98), boxAt(0.04, 0.32, 0.12, 0.45, 1.10, 1.98),
]), trimMat);
addTo(body, boxAt(1.86, 0.15, 0.035, 0, 0.755, 2.282), lensMat);
addTo(body, mergeGeometries([
  boxAt(1.50, 0.028, 0.03, 0, 0.75, 2.302),
  boxAt(0.36, 0.05, 0.03, -0.72, 0.787, 2.302), boxAt(0.36, 0.05, 0.03, 0.72, 0.787, 2.302),
  boxAt(0.05, 0.13, 0.03, -0.88, 0.745, 2.30), boxAt(0.05, 0.13, 0.03, 0.88, 0.745, 2.30),
]), tailMat);
const plate = addTo(body, new THREE.PlaneGeometry(0.52, 0.13), plateMat);
plate.position.set(0, 0.52, 2.312);
const diffParts = [boxAt(1.36, 0.16, 0.42, 0, 0.27, 2.08)];
for (let i = -2; i <= 2; i++) diffParts.push(boxAt(0.02, 0.15, 0.36, i * 0.22, 0.27, 2.12));
addTo(body, mergeGeometries(diffParts), trimMat);
const EXHAUST_X = [-0.64, -0.5, 0.5, 0.64];
addTo(body, mergeGeometries(EXHAUST_X.map((x) => new THREE.CylinderGeometry(0.052, 0.052, 0.24, 14).rotateX(Math.PI / 2).translate(x, 0.30, 2.26))), chromeMat);
addTo(body, mergeGeometries(EXHAUST_X.map((x) => new THREE.CircleGeometry(0.04, 12).translate(x, 0.30, 2.381))), new THREE.MeshBasicMaterial({ color: hdr(0.05, 0.02, 0.02) }));
addTo(body, mergeGeometries([boxAt(0.44, 0.05, 0.05, -0.66, 0.62, -2.29), boxAt(0.44, 0.05, 0.05, 0.66, 0.62, -2.29)]), headMat);

const flameMat = new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 }, uPower: { value: 0 }, uLen: { value: 1 }, uCore: { value: hdr(2.5, 3.2, 6.0) }, uEdge: { value: hdr(0.5, 0.3, 2.2) } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform float uTime; uniform float uPower; uniform float uLen; uniform vec3 uCore; uniform vec3 uEdge;
    varying vec2 vUv;
    void main() {
      float t = vUv.y / max(uLen, 0.05);
      float flick = 0.7 + 0.3 * sin(uTime * 70.0 + vUv.y * 24.0) * sin(uTime * 23.0);
      float k = max(1.0 - t, 0.0);
      gl_FragColor = vec4(mix(uEdge, uCore, k * k * k) * pow(k, 1.7) * flick * uPower, 1.0);
    }`,
  blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide,
});
addTo(body, mergeGeometries(EXHAUST_X.map((x) => new THREE.ConeGeometry(0.06, 0.9, 12, 1, true).rotateX(Math.PI / 2).translate(x, 0.30, 2.38 + 0.45))), flameMat);

const wheels = [];
const tireGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.27, 28).rotateZ(Math.PI / 2);
const rimParts = [new THREE.CylinderGeometry(0.24, 0.24, 0.275, 20).rotateZ(Math.PI / 2)];
for (let k = 0; k < 5; k++) rimParts.push(new THREE.BoxGeometry(0.29, 0.42, 0.055).rotateX((k * Math.PI * 2) / 5));
const rimGeo = mergeGeometries(rimParts);
for (const [x, z] of [[-0.86, 1.27], [0.86, 1.27], [-0.86, -1.31], [0.86, -1.31]]) {
  const w = new THREE.Group();
  w.position.set(x, 0.35, z);
  w.rotation.order = 'YXZ';
  w.add(new THREE.Mesh(tireGeo, tireMat), new THREE.Mesh(rimGeo, rimMat));
  chassis.add(w);
  wheels.push(w);
}
chassis.add(new THREE.Mesh(flatPlane(2.7, 5.4, 0, 0.02, 0.05), new THREE.MeshBasicMaterial({
  color: 0x000000, alphaMap: texShadow, transparent: true, opacity: 0.82, depthWrite: false,
  polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
})));
chassis.add(new THREE.Mesh(flatPlane(2.6, 5.2, 0, 0.03, 0), makeGlowMaterial(texSoftRect, hdr(0.1, 0.08, 0.4))));

const headSpot = new THREE.SpotLight(lin('#dfe8ff'), 2.4, 120, 0.42, 0.55, 1.2);
headSpot.position.set(0, 0.7, -2.0);
headSpot.target.position.set(0, 0, -32);
chassis.add(headSpot, headSpot.target);
const tailGlow = new THREE.PointLight(hdr(1, 0.05, 0.08), 1.6, 9, 2);
tailGlow.position.set(0, 0.55, 2.7);
chassis.add(tailGlow);
const lampLight = new THREE.PointLight(lin('#dbe6ff'), 0, 28, 2);
scene.add(lampLight);
for (const l of [hemi, moon, headSpot, tailGlow, lampLight]) l.layers.enable(1);
body.traverse((o) => o.layers.enable(1));
for (const w of wheels) w.traverse((o) => o.layers.enable(1));

// ---------- traffic ----------
function sedanGeometry() {
  const L = 4.7;
  const bodyG = profileGeometry((s) => {
    s.moveTo(0.05, 0.36); s.lineTo(4.62, 0.36); s.quadraticCurveTo(4.72, 0.40, 4.72, 0.60);
    s.quadraticCurveTo(4.55, 0.78, 3.55, 0.88); s.lineTo(1.30, 0.96); s.lineTo(0.30, 0.95);
    s.quadraticCurveTo(0.02, 0.92, 0.0, 0.70); s.quadraticCurveTo(0.0, 0.40, 0.05, 0.36);
  }, 1.82, 0.06, L);
  const cabinG = profileGeometry((s) => {
    s.moveTo(0.95, 0.94); s.lineTo(3.40, 0.88); s.quadraticCurveTo(3.0, 1.18, 2.70, 1.40);
    s.quadraticCurveTo(2.15, 1.47, 1.55, 1.44); s.quadraticCurveTo(1.20, 1.30, 0.95, 0.94);
  }, 1.54, 0.05, L);
  const wheelG = [[-0.8, 1.35], [0.8, 1.35], [-0.8, -1.4], [0.8, -1.4]].map(([x, z]) => new THREE.CylinderGeometry(0.34, 0.34, 0.24, 16).rotateZ(Math.PI / 2).translate(x, 0.34, z));
  const parts = [bodyG, cabinG].concat(wheelG, [boxAt(1.84, 0.2, 0.14, 0, 0.44, 2.36), boxAt(1.84, 0.2, 0.14, 0, 0.44, -2.36)]);
  const cols = [[1, 1, 1], [0.06, 0.07, 0.09]].concat(wheelG.map(() => [0.03, 0.03, 0.035]), [[0.22, 0.22, 0.24], [0.22, 0.22, 0.24]]);
  const TAIL = [2.8, 0.07, 0.11], HEAD = [2.3, 2.4, 2.7];
  const lights = mergeGeometries([
    boxAt(0.42, 0.14, 0.06, -0.62, 0.78, 2.42), boxAt(0.42, 0.14, 0.06, 0.62, 0.78, 2.42),
    boxAt(0.40, 0.11, 0.06, -0.62, 0.66, -2.42), boxAt(0.40, 0.11, 0.06, 0.62, 0.66, -2.42),
  ], [TAIL, TAIL, HEAD, HEAD]);
  return { body: mergeGeometries(parts, cols), lights };
}
function truckGeometry() {
  const parts = [], cols = [];
  const add = (g, c) => { parts.push(g); cols.push(c); };
  add(boxAt(2.55, 2.9, 11.4, 0, 2.6, 1.5), [0.86, 0.88, 0.92]);
  add(boxAt(2.2, 0.35, 11.0, 0, 1.0, 1.5), [0.06, 0.06, 0.07]);
  add(boxAt(2.4, 0.16, 0.12, 0, 0.75, 7.15), [0.1, 0.1, 0.1]);
  for (const x of [-0.42, 0.42]) add(boxAt(0.04, 2.7, 0.03, x, 2.6, 7.215), [0.3, 0.3, 0.32]);
  add(boxAt(2.45, 2.3, 2.3, 0, 2.05, -5.95), [1, 1, 1]);
  add(boxAt(2.4, 0.95, 1.7, 0, 3.6, -5.65), [1, 1, 1]);
  add(boxAt(2.2, 0.85, 0.05, 0, 2.55, -7.11), [0.05, 0.06, 0.08]);
  add(boxAt(2.5, 0.35, 0.2, 0, 0.75, -7.1), [0.2, 0.2, 0.22]);
  add(boxAt(1.0, 0.5, 2.0, 0, 0.9, -4.3), [0.06, 0.06, 0.07]);
  for (const z of [6.2, 5.0, -3.4, -6.2]) for (const x of [-1.0, 1.0]) add(new THREE.CylinderGeometry(0.5, 0.5, 0.5, 16).rotateZ(Math.PI / 2).translate(x, 0.5, z), [0.03, 0.03, 0.035]);
  const lp = [], lc = [];
  const L = (g, c) => { lp.push(g); lc.push(c); };
  const RED = [2.8, 0.07, 0.11], AMB = [2.6, 1.1, 0.1], WHT = [2.3, 2.4, 2.7];
  L(boxAt(0.32, 0.16, 0.06, -1.0, 1.25, 7.24), RED); L(boxAt(0.32, 0.16, 0.06, 1.0, 1.25, 7.24), RED);
  for (const x of [-1.15, -0.3, 0, 0.3, 1.15]) L(boxAt(0.12, 0.08, 0.06, x, 3.98, 7.24), AMB);
  for (let z = -3.6; z <= 6.6; z += 2.55) for (const x of [-1.29, 1.29]) L(boxAt(0.04, 0.08, 0.16, x, 1.42, z), AMB);
  for (const x of [-0.85, 0.85]) L(boxAt(0.4, 0.15, 0.06, x, 1.2, -7.12), WHT);
  for (const x of [-0.9, -0.3, 0.3, 0.9]) L(boxAt(0.1, 0.07, 0.06, x, 4.1, -6.48), AMB);
  return { body: mergeGeometries(parts, cols), lights: mergeGeometries(lp, lc) };
}

const trafficPaint = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.45, roughness: 0.38, envMap, envMapIntensity: 1.0 });
const trafficLight = new THREE.MeshBasicMaterial({ vertexColors: true });
const sedan = sedanGeometry();
const truck = truckGeometry();
const N_SAME_CARS = 13, N_OPP = 12, N_TRUCKS = 3;
const N_CARS = N_SAME_CARS + N_OPP;
function withColors(mesh, n) {
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  return mesh;
}
const carBodies = withColors(instanced(sedan.body, trafficPaint, N_CARS), N_CARS);
const carLights = withColors(instanced(sedan.lights, trafficLight, N_CARS), N_CARS);
const truckBodies = withColors(instanced(truck.body, trafficPaint, N_TRUCKS), N_TRUCKS);
const truckLights = withColors(instanced(truck.lights, trafficLight, N_TRUCKS), N_TRUCKS);

const CAR_COLORS = ['#e9ebef', '#c9ccd3', '#8d929c', '#2a2d33', '#101114', '#1f3f7a', '#7d1620', '#3c4b3a', '#b9a888', '#4b5a6e', '#e9ebef', '#c9ccd3'].map(lin);
const TRUCK_COLORS = ['#f2f2f2', '#d9dde3', '#9fb3c8', '#c94b3b'].map(lin);
const vehicles = [];
for (let i = 0; i < N_CARS; i++) vehicles.push({ kind: 'car', idx: i, dir: i < N_SAME_CARS ? 1 : -1, len: 4.85, halfW: 0.94, x: 0, z: null, v: 30, cruise: 30, lane: 0, sy: 1, brake: 0, lc: null, prevZ: 0, color: CAR_COLORS[0] });
for (let i = 0; i < N_TRUCKS; i++) vehicles.push({ kind: 'truck', idx: i, dir: 1, len: 14.5, halfW: 1.28, x: 0, z: null, v: 23, cruise: 23, lane: 2, sy: 1, brake: 0, lc: null, prevZ: 0, color: TRUCK_COLORS[0] });

function laneBlocked(v, laneX, z, gap) {
  let near = 0;
  for (const o of vehicles) {
    if (o === v || o.dir !== v.dir || o.z === null) continue;
    const dz = Math.abs(o.z - z);
    if (Math.abs(o.x - laneX) < 2.4 && dz < gap + (o.len + v.len) / 2) return true;
    if (v.dir > 0 && dz < 22 && Math.abs(o.x - laneX) > 1) near++;
  }
  return v.dir > 0 && near >= 3;
}
function spawn(v, zMin, zMax) {
  const lanes = v.dir > 0 ? LANES : OPP_LANES;
  for (let t = 0; t < 16; t++) {
    const li = v.kind === 'truck' ? 2 + ((Math.random() * 2) | 0) : (Math.random() * 4) | 0;
    const z = rand(zMin, zMax);
    if (!laneBlocked(v, lanes[li], z, 14)) {
      v.lane = li; v.x = lanes[li]; v.z = z; v.prevZ = z; v.lc = null; v.brake = 0;
      v.cruise = v.kind === 'truck' ? rand(21, 25) : (v.dir > 0 ? rand(23, 31) + (3 - li) * 1.6 : rand(25, 36));
      v.v = v.cruise;
      v.sy = v.kind === 'truck' ? 1 : (Math.random() < 0.3 ? rand(1.12, 1.25) : rand(0.97, 1.05));
      v.color = v.kind === 'truck' ? pick(TRUCK_COLORS) : pick(CAR_COLORS);
      return true;
    }
  }
  v.z = zMin - 320;
  v.prevZ = v.z;
  return false;
}
for (const v of vehicles) spawn(v, v.dir > 0 ? -640 : -900, v.dir > 0 ? -45 : -20);

function updateTraffic(dt, pv) {
  for (const v of vehicles) {
    v.prevZ = v.z;
    if (v.dir > 0) {
      let lead = null, gap = 1e9;
      for (const o of vehicles) {
        if (o === v || o.dir < 0 || o.z >= v.z || Math.abs(o.x - v.x) > 2.2) continue;
        const g = v.z - o.z - (v.len + o.len) / 2;
        if (g < gap) { gap = g; lead = o; }
      }
      let target = v.cruise;
      if (lead && gap < 32) target = Math.min(target, lead.v - (gap < 10 ? 4 : 0));
      v.brake = target < v.v - 0.8 ? 1 : 0;
      v.v = damp(v.v, Math.max(target, 8), v.brake ? 2.2 : 0.8, dt);
      if (!v.lc && v.kind === 'car' && lead && gap < 30 && lead.v < v.cruise - 2.5 && v.z < -60 && Math.random() < dt * 0.8) {
        const opts = [v.lane - 1, v.lane + 1].filter((l) => l >= 0 && l < 4);
        if (Math.random() < 0.5) opts.reverse();
        for (const l of opts) {
          if (!laneBlocked(v, LANES[l], v.z, 10)) { v.lc = { from: v.x, to: LANES[l], t: 0 }; v.lane = l; break; }
        }
      }
      v.z += (pv - v.v) * dt;
    } else {
      v.z += (pv + v.v) * dt;
    }
    if (v.lc) {
      v.lc.t += dt / 2.2;
      v.x = lerp(v.lc.from, v.lc.to, smooth(0, 1, v.lc.t));
      if (v.lc.t >= 1) { v.x = v.lc.to; v.lc = null; }
    }
    if (v.dir > 0) { if (v.z > 40 || v.z < -980) { spawn(v, -720, -520); v.prevZ = v.z; } }
    else if (v.z > 40) { spawn(v, -980, -700); v.prevZ = v.z; }
  }
}
function writeTraffic() {
  for (const v of vehicles) {
    const bodyM = v.kind === 'truck' ? truckBodies : carBodies;
    const lightM = v.kind === 'truck' ? truckLights : carLights;
    let yaw = v.dir > 0 ? 0 : Math.PI;
    if (v.lc) yaw += -Math.sign(v.lc.to - v.lc.from) * 0.05 * Math.sin(Math.PI * clamp(v.lc.t, 0, 1));
    _q.setFromAxisAngle(_yAxis, yaw);
    _p.set(v.x, 0, v.z);
    _s.set(1, v.sy, 1);
    _m4.compose(_p, _q, _s);
    bodyM.setMatrixAt(v.idx, _m4);
    lightM.setMatrixAt(v.idx, _m4);
    const c = bodyM.instanceColor.array;
    c[v.idx * 3] = v.color.r; c[v.idx * 3 + 1] = v.color.g; c[v.idx * 3 + 2] = v.color.b;
    const k = smooth(-900, -560, v.z) * (1 + v.brake * 1.3);
    const lc = lightM.instanceColor.array;
    lc[v.idx * 3] = k; lc[v.idx * 3 + 1] = k; lc[v.idx * 3 + 2] = k;
  }
  for (const m of [carBodies, carLights, truckBodies, truckLights]) { m.instanceMatrix.needsUpdate = true; m.instanceColor.needsUpdate = true; }
}

// ---------- effects: wet-road reflections, sparks, wind streaks ----------
const STREAK_MAX = 150;
const streakMesh = withColors(instanced(flatPlane(1, 1, 0, 0, 0), makeGlowMaterial(texStreak, hdr(1, 1, 1), 0.8), STREAK_MAX), STREAK_MAX);
let streakN = 0;
function addStreak(lx, ly, lz, r, g, b, lenScale) {
  if (streakN >= STREAK_MAX) return;
  const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
  const dz = lz - cz;
  if (dz > -2 || dz < -460 || cy < 0.2) return;
  const t = cy / (cy + ly);
  const rz = cz + dz * t;
  const rx = cx + (lx - cx) * t;
  const d = -dz;
  _q.setFromAxisAngle(_yAxis, Math.atan2(lx - cx, lz - cz));
  _p.set(rx, 0.04, rz);
  _s.set(clamp(0.32 + d * 0.006, 0.32, 1.5), 1, clamp(d * 0.42 * (lenScale || 1), 1.6, 32));
  _m4.compose(_p, _q, _s);
  streakMesh.setMatrixAt(streakN, _m4);
  const ca = streakMesh.instanceColor.array;
  ca[streakN * 3] = r; ca[streakN * 3 + 1] = g; ca[streakN * 3 + 2] = b;
  streakN++;
}

function lineCloud(n) {
  const pos = new Float32Array(n * 6), col = new Float32Array(n * 6);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
  const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false }));
  lines.frustumCulled = false;
  scene.add(lines);
  return { pos, col, geo };
}
const SPARK_N = 160;
const sparkCloud = lineCloud(SPARK_N);
const sparks = [];
for (let i = 0; i < SPARK_N; i++) sparks.push({ life: 0, max: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 });
let sparkCursor = 0;
function emitSparks(x, y, z, sideX, count, power) {
  for (let i = 0; i < count; i++) {
    const s = sparks[sparkCursor];
    sparkCursor = (sparkCursor + 1) % SPARK_N;
    s.life = s.max = rand(0.25, 0.7);
    s.x = x; s.y = y; s.z = z + rand(-0.6, 0.6);
    s.vx = sideX * rand(0.5, 4) + rand(-1, 1);
    s.vy = rand(0.5, 4.5) * power;
    s.vz = rand(3, 14) * power;
  }
}
function updateSparks(dt, pv) {
  const P = sparkCloud.pos, C = sparkCloud.col;
  for (let i = 0; i < SPARK_N; i++) {
    const s = sparks[i];
    const o = i * 6;
    if (s.life <= 0) { C.fill(0, o, o + 6); continue; }
    s.life -= dt;
    s.vy -= 9.8 * dt;
    s.vz += pv * 0.9 * dt;
    s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
    if (s.y < 0.02) { s.y = 0.02; s.vy *= -0.35; }
    const k = clamp(s.life / s.max, 0, 1);
    P[o] = s.x; P[o + 1] = s.y; P[o + 2] = s.z;
    P[o + 3] = s.x - s.vx * 0.025; P[o + 4] = s.y - s.vy * 0.025; P[o + 5] = s.z - s.vz * 0.025;
    C[o] = 4 * k; C[o + 1] = 1.6 * k * k; C[o + 2] = 0.4 * k * k * k;
    C[o + 3] = 1.2 * k; C[o + 4] = 0.3 * k * k; C[o + 5] = 0;
  }
  sparkCloud.geo.attributes.position.needsUpdate = true;
  sparkCloud.geo.attributes.color.needsUpdate = true;
}

const WIND_N = 90;
const windCloud = lineCloud(WIND_N);
const wind = [];
function resetWind(w, px, far) {
  w.x = px + (Math.random() < 0.5 ? -1 : 1) * rand(1.8, 13);
  w.y = rand(0.2, 7);
  w.z = far ? rand(-130, -30) : rand(-130, 6);
}
for (let i = 0; i < WIND_N; i++) { const w = {}; resetWind(w, 0, false); wind.push(w); }
function updateWind(dt, pv, px, boostK) {
  const P = windCloud.pos, C = windCloud.col;
  const len = clamp(pv * 0.07, 0, 7);
  const I = smooth(35, 85, pv) * 0.22 + boostK * 0.35;
  for (let i = 0; i < WIND_N; i++) {
    const w = wind[i];
    w.z += pv * dt;
    if (w.z > camera.position.z + 1) resetWind(w, px, true);
    const o = i * 6;
    P[o] = w.x; P[o + 1] = w.y; P[o + 2] = w.z;
    P[o + 3] = w.x; P[o + 4] = w.y; P[o + 5] = w.z - len;
    C[o] = 0.6 * I; C[o + 1] = 0.75 * I; C[o + 2] = 1.0 * I;
    C[o + 3] = 0; C[o + 4] = 0; C[o + 5] = 0;
  }
  windCloud.geo.attributes.position.needsUpdate = true;
  windCloud.geo.attributes.color.needsUpdate = true;
}

// ---------- game state ----------
const HUD = {
  hud: $('hud'), clock: $('clock'), timebar: $('timebar'), timefill: $('timefill'), score: $('score'), dist: $('dist'), nm: $('nm'),
  hint: $('hint'), speedo: $('speedo'), speed: $('speed'), arc: $('arc'), gear: $('gear'), nitro: $('nitro'), pops: $('pops'),
  count: $('count'), title: $('title'), results: $('results'), pause: $('pause'), touch: $('touch'), bestLine: $('bestLine'),
};
(function drawTicks() {
  let svg = '';
  for (let k = 0; k <= 18; k++) {
    const a = Math.PI + (k / 18) * Math.PI;
    const major = k % 3 === 0;
    const c = Math.cos(a), s = Math.sin(a);
    const r0 = major ? 84 : 89, r1 = 95;
    svg += `<line class="tick${major ? ' major' : ''}" x1="${(125 + c * r0).toFixed(1)}" y1="${(125 + s * r0).toFixed(1)}" x2="${(125 + c * r1).toFixed(1)}" y2="${(125 + s * r1).toFixed(1)}"></line>`;
    if (major) svg += `<text class="tick-num" x="${(125 + c * 110).toFixed(1)}" y="${(125 + s * 110 + 3).toFixed(1)}">${k * 20}</text>`;
  }
  $('ticks').innerHTML = svg;
})();

const G = {
  state: 'boot', t: 0, time: 60, cd: 0, lastCd: 0, score: 0, bonus: 0, distRun: 0, nearMiss: 0, overtakes: 0, crashes: 0,
  top: 0, sumV: 0, sumT: 0, combo: 0, comboT: 0, shake: 0, flash: 0, flashCol: new THREE.Vector3(1, 1, 1), paused: false, hudOff: false,
  shot: 0, shotT: 6.5, best: Number(store.get('best', 0)) || 0, hintT: 0,
};
const player = {
  x: LANES[2], vx: 0, v: 34, lastV: 34, nitro: 1, boosting: false, throttle: 0, braking: 0, gear: 1, rpm: 900, cut: 0,
  wheelRot: 0, crashT: 0, pop: 0, flame: 0, ap: LANES[2], scrape: 0,
};
const keys = { up: false, down: false, left: false, right: false, boost: false };
const CAMS = [
  { name: 'Chase', dist: 8.6, h: 2.5, look: 30, lookH: 1.05, fov: 58 },
  { name: 'Cinematic', dist: 13, h: 1.7, look: 42, lookH: 1.7, fov: 46 },
  { name: 'Bumper', dist: 5.4, h: 0.9, look: 24, lookH: 0.95, fov: 70 },
  { name: 'Roof', dist: -0.2, h: 1.42, look: 30, lookH: 1.1, fov: 72, inside: true },
];
let camMode = mod(Number(store.get('cam', 0)) || 0, CAMS.length);
const GLOW = [
  { name: 'Soft lights', bloom: 0.035, flare: 0.0, exposure: 0.8 },
  { name: 'Normal lights', bloom: 0.065, flare: 0.05, exposure: 0.86 },
  { name: 'Vivid lights', bloom: 0.11, flare: 0.12, exposure: 0.92 },
];
let glowIdx = clamp(Math.round(Number(store.get('glow', 1)) || 0), 0, GLOW.length - 1);
function applyGlow() {
  const g = GLOW[glowIdx];
  const cu = compositeMat.uniforms;
  cu.uBloom.value = g.bloom * (HDR ? 1 : 0.8);
  cu.uFlare.value = g.flare;
  cu.uExposure.value = g.exposure;
}
applyGlow();
setPaint(Number(store.get('paint', 0)) || 0);

function popup(text, sub, cls) {
  const el = document.createElement('div');
  el.className = 'pop' + (cls ? ' ' + cls : '');
  const b = document.createElement('b');
  b.textContent = text;
  el.appendChild(b);
  if (sub) { const s = document.createElement('small'); s.textContent = sub; el.appendChild(s); }
  HUD.pops.appendChild(el);
  while (HUD.pops.children.length > 3) HUD.pops.firstChild.remove();
  setTimeout(() => el.remove(), 1300);
}
function showCount(text, go) {
  HUD.count.textContent = '';
  const s = document.createElement('span');
  s.textContent = text;
  if (go) s.className = 'go';
  HUD.count.appendChild(s);
}

// ---------- sound: a synthesized engine, wind and road noise ----------
const audio = {
  ctx: null, master: null, enabled: store.get('sound', true) !== false,
  init() {
    if (this.ctx) { this.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      const ctx = new AC();
      this.ctx = ctx;
      this.master = ctx.createGain();
      if (clip) {
        // clip mode: the recording taps master at full level; muting (M) only silences the speakers
        this.master.gain.value = 0.42;
        this.spk = ctx.createGain();
        this.spk.gain.value = this.enabled ? 1 : 0;
        this.master.connect(this.spk).connect(ctx.destination);
        clip.attachAudio(ctx, this.master);
      } else {
        this.master.gain.value = this.enabled ? 0.42 : 0;
        this.master.connect(ctx.destination);
      }
      // clip mode: the car's own sounds (engine, wind, road, scraping) skip the recording tap; effects keep it
      this.bed = this.master;
      if (clip) { this.bed = ctx.createGain(); this.bed.gain.value = 0.42; this.bed.connect(this.spk); clip.attachBed(this.bed); }
      this.o1 = ctx.createOscillator(); this.o1.type = 'sawtooth';
      this.o2 = ctx.createOscillator(); this.o2.type = 'square';
      this.o3 = ctx.createOscillator(); this.o3.type = 'sawtooth';
      this.eFilter = ctx.createBiquadFilter(); this.eFilter.type = 'lowpass'; this.eFilter.Q.value = 3;
      this.eGain = ctx.createGain(); this.eGain.gain.value = 0;
      const g2 = ctx.createGain(); g2.gain.value = 0.45;
      const g3 = ctx.createGain(); g3.gain.value = 0.5;
      this.o1.connect(this.eFilter);
      this.o2.connect(g2).connect(this.eFilter);
      this.o3.connect(g3).connect(this.eFilter);
      this.eFilter.connect(this.eGain).connect(this.bed);
      const len = ctx.sampleRate * 2;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      let lastS = 0;
      for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; lastS = (lastS + 0.02 * w) / 1.02; d[i] = lastS * 3.5 + w * 0.25; }
      this.noiseBuf = buf;
      const loop = (rate) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.playbackRate.value = rate; return s; };
      this.wind = loop(1);
      this.wFilter = ctx.createBiquadFilter(); this.wFilter.type = 'bandpass'; this.wFilter.Q.value = 0.5;
      this.wGain = ctx.createGain(); this.wGain.gain.value = 0;
      this.wind.connect(this.wFilter).connect(this.wGain).connect(this.bed);
      this.rumble = loop(0.6);
      this.rFilter = ctx.createBiquadFilter(); this.rFilter.type = 'lowpass'; this.rFilter.frequency.value = 160;
      this.rGain = ctx.createGain(); this.rGain.gain.value = 0;
      this.rumble.connect(this.rFilter).connect(this.rGain).connect(this.bed);
      this.scrapeSrc = loop(1.7);
      this.sFilter = ctx.createBiquadFilter(); this.sFilter.type = 'bandpass'; this.sFilter.frequency.value = 2400; this.sFilter.Q.value = 3;
      this.sGain = ctx.createGain(); this.sGain.gain.value = 0;
      this.scrapeSrc.connect(this.sFilter).connect(this.sGain).connect(this.bed);
      const t = ctx.currentTime;
      [this.o1, this.o2, this.o3, this.wind, this.rumble, this.scrapeSrc].forEach((n) => n.start(t));
    } catch (e) {
      this.ctx = null;
    }
  },
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); },
  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => {}); },
  setEnabled(on) {
    this.enabled = on;
    store.set('sound', on);
    if (this.spk) this.spk.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.05);
    else if (this.master) this.master.gain.setTargetAtTime(on ? 0.42 : 0, this.ctx.currentTime, 0.05);
  },
  update(rpm, throttle, pv, boost, scrape) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const f = Math.max(30, (rpm / 60) * 3);
    this.o1.frequency.setTargetAtTime(f, t, 0.03);
    this.o2.frequency.setTargetAtTime(f * 0.5, t, 0.03);
    this.o3.frequency.setTargetAtTime(f * 1.012, t, 0.03);
    this.eFilter.frequency.setTargetAtTime(220 + rpm * 0.12 + throttle * 700, t, 0.05);
    this.eGain.gain.setTargetAtTime(0.05 + throttle * 0.07 + boost * 0.03, t, 0.06);
    const s01 = clamp(pv / 95, 0, 1);
    this.wFilter.frequency.setTargetAtTime(500 + s01 * 1600, t, 0.1);
    this.wGain.gain.setTargetAtTime(s01 * s01 * 0.22 + boost * 0.06, t, 0.1);
    this.rGain.gain.setTargetAtTime(0.05 + s01 * 0.12, t, 0.1);
    this.sGain.gain.setTargetAtTime(scrape * 0.25, t, 0.03);
  },
  burst(freq, q, dur, vol, type) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 1 + Math.random() * 0.3;
    const f = ctx.createBiquadFilter(); f.type = type || 'bandpass'; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.05);
  },
  whoosh() { this.burst(900, 0.8, 0.5, 0.35); },
  crash() { this.burst(300, 0.6, 0.6, 0.9, 'lowpass'); this.burst(1800, 1.5, 0.35, 0.4); },
  pop() { this.burst(700, 2, 0.12, 0.3); },
  beep(freq, dur) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(); o.type = 'square'; o.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  },
};

// ---------- driving ----------
const GEAR_TOP = [62, 104, 148, 198, 252, 345];
const P_HALF_W = 0.98, P_HALF_L = 2.3, LIM = 7.45;
function nearestLane(x) {
  let bi = 0, bd = 1e9;
  for (let i = 0; i < LANES.length; i++) { const d = Math.abs(LANES[i] - x); if (d < bd) { bd = d; bi = i; } }
  return bi;
}
function laneClearAhead(laneX, range) {
  for (const v of vehicles) if (v.dir > 0 && Math.abs(v.x - laneX) < 2.2 && v.z < 6 && v.z > -range) return false;
  return true;
}
function laneClearBeside(laneX) {
  for (const v of vehicles) if (v.dir > 0 && Math.abs(v.x - laneX) < 2.3 && Math.abs(v.z) < v.len / 2 + 7) return false;
  return true;
}
function autopilot(dt, targetV) {
  const li = nearestLane(player.ap);
  if (!laneClearAhead(player.ap, 70)) {
    const opts = [li - 1, li + 1].filter((l) => l >= 0 && l < 4);
    if (Math.random() < 0.5) opts.reverse();
    for (const l of opts) if (laneClearAhead(LANES[l], 90) && laneClearBeside(LANES[l])) { player.ap = LANES[l]; break; }
  }
  player.vx = damp(player.vx, clamp((player.ap - player.x) * 1.8, -6, 6), 5, dt);
  player.x += player.vx * dt;
  let tv = targetV;
  for (const v of vehicles) if (v.dir > 0 && Math.abs(v.x - player.x) < 2.3 && v.z < 0 && v.z > -40) tv = Math.min(tv, v.v - 2);
  player.throttle = damp(player.throttle, player.v < tv ? 0.7 : 0.2, 6, dt);
  player.v = damp(player.v, Math.max(tv, 5), 1.2, dt);
  player.boosting = false;
  player.braking = tv < player.v - 3 ? 1 : 0;
}
function drive(dt) {
  const up = keys.up || coarse;
  const down = keys.down;
  const steerIn = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  player.boosting = keys.boost && player.nitro > 0.02 && !down;
  const vmax = player.boosting ? 104 : 86;
  let a = 0;
  if (up || player.boosting) a += (player.boosting ? 24 : 15) * Math.max(0, 1 - Math.pow(player.v / vmax, 1.7)) * (player.cut > 0 ? 0.3 : 1);
  if (down) a -= 32;
  a -= 0.6 + 0.00042 * player.v * player.v;
  if (player.crashT > 0) a -= 6;
  player.v = clamp(player.v + a * dt, 0, 110);
  player.throttle = damp(player.throttle, up || player.boosting ? 1 : 0, 10, dt);
  player.braking = down ? 1 : 0;
  player.nitro = player.boosting ? Math.max(0, player.nitro - dt * 0.24) : Math.min(1, player.nitro + dt * 0.05);
  const latMax = lerp(3.5, 10.5, clamp(player.v / 45, 0, 1));
  player.vx = damp(player.vx, steerIn * latMax, 7, dt);
  player.x += player.vx * dt;
  player.ap = LANES[nearestLane(player.x)];
  return steerIn;
}
function contactBarriers(dt, steerIn) {
  player.scrape = 0;
  for (const side of [1, -1]) {
    if (player.x * side <= LIM) continue;
    player.x = LIM * side;
    if (player.vx * side > 0) player.vx = -side * Math.min(2, Math.abs(player.vx) * 0.3);
    if (steerIn === side && player.v > 8 && G.state === 'drive') {
      player.scrape = 1;
      player.v = Math.max(0, player.v - 9 * dt);
      G.shake = Math.max(G.shake, 0.35);
      if (Math.random() < dt * 40) emitSparks(player.x + side * 1.0, 0.35, rand(-1.5, 1.8), side, 3, 0.9);
    }
  }
}
function hit(strength, sx, side) {
  player.crashT = 0.8;
  G.shake = Math.min(1.4, G.shake + strength);
  G.flash = 0.5 * strength;
  G.flashCol.set(1.0, 0.12, 0.1);
  G.combo = 0;
  G.comboT = 0;
  if (G.state === 'drive') { G.crashes++; popup('Crash', 'combo lost', 'hot'); }
  emitSparks(sx, 0.6, side === 0 ? -2.2 : rand(-1, 1), side || (Math.random() < 0.5 ? -1 : 1), 26, 1.2);
  audio.crash();
}
function nearMiss(gap) {
  G.comboT = 4;
  G.combo = Math.min(G.combo + 1, 9);
  const pts = Math.round(250 * G.combo * (gap < 0.5 ? 1.5 : 1));
  G.bonus += pts;
  G.nearMiss++;
  player.nitro = Math.min(1, player.nitro + 0.15);
  const label = gap < 0.5 ? 'Close call' : 'Near miss';
  const sub = '+' + pts + (G.combo > 1 ? '  ×' + G.combo : '');
  popup(label, sub, 'cool');
  if (clip) clip.onNearMiss(gap, label, sub);
  audio.whoosh();
}
function checkTraffic() {
  for (const v of vehicles) {
    if (v.dir < 0) continue;
    const ox = (v.halfW + P_HALF_W) - Math.abs(v.x - player.x);
    const oz = (v.len / 2 + P_HALF_L) - Math.abs(v.z);
    if (ox > 0 && oz > 0) {
      if (ox < oz) {
        const side = Math.sign(player.x - v.x) || 1;
        player.x += side * (ox + 0.02);
        player.vx = side * 5;
        v.x -= side * 0.25;
        player.v *= 0.93;
        if (player.crashT <= 0) hit(0.6, player.x - side * P_HALF_W, side);
      } else if (v.z < 0) {
        v.z = -(v.len / 2 + P_HALF_L + 0.3);
        v.prevZ = v.z;
        v.v = Math.max(v.v, player.v * 0.6 + 4);
        player.v = Math.max(0, Math.min(player.v, v.v - 3));
        if (player.crashT <= 0) hit(1, player.x, 0);
      } else {
        v.z = v.len / 2 + P_HALF_L + 0.3;
        v.prevZ = v.z;
      }
    }
    if (v.prevZ < 0 && v.z >= 0 && G.state === 'drive') {
      G.overtakes++;
      const gap = Math.abs(v.x - player.x) - v.halfW - P_HALF_W;
      if (gap < 1.1 && player.v > 25 && player.crashT <= 0) nearMiss(gap);
    }
  }
}
function updateGears(dt) {
  const kmh = player.v * 3.6;
  let g = 0;
  while (g < GEAR_TOP.length - 1 && kmh > GEAR_TOP[g]) g++;
  const lo = g === 0 ? 0 : GEAR_TOP[g - 1], hi = GEAR_TOP[g];
  const frac = clamp((kmh - lo) / (hi - lo), 0, 1);
  const target = 1100 + frac * 6300 + (g === 0 ? player.throttle * 1500 : 0);
  if (g + 1 > player.gear && player.throttle > 0.5 && G.state === 'drive') { player.cut = 0.12; player.pop = 0.18; audio.pop(); }
  player.gear = g + 1;
  player.cut = Math.max(0, player.cut - dt);
  player.rpm = damp(player.rpm, target, 12, dt);
}
function updateCarVisual(dt, steerIn) {
  carRoot.position.x = player.x;
  chassis.rotation.y = damp(chassis.rotation.y, -player.vx * 0.028, 10, dt);
  body.rotation.z = damp(body.rotation.z, player.vx * 0.006, 8, dt);
  const acc = (player.v - player.lastV) / Math.max(dt, 1e-4);
  player.lastV = player.v;
  body.rotation.x = damp(body.rotation.x, clamp(acc * 0.0016, -0.03, 0.025), 6, dt);
  body.position.y = (reduceMotion ? 0 : Math.sin(G.t * 31) * 0.004 * clamp(player.v / 80, 0, 1)) + (player.crashT > 0 ? Math.sin(G.t * 60) * 0.02 * player.crashT : 0);
  player.wheelRot -= (player.v * dt) / 0.35;
  for (let i = 0; i < 4; i++) {
    wheels[i].rotation.x = player.wheelRot;
    wheels[i].rotation.y = i >= 2 ? damp(wheels[i].rotation.y, steerIn * 0.32 - player.vx * 0.02, 10, dt) : 0;
  }
  const brakeK = player.braking ? 2.3 : 1;
  tailMat.color.copy(TAIL_ON).multiplyScalar(brakeK);
  tailGlow.intensity = 1.6 * brakeK;
  player.flame = damp(player.flame, player.boosting ? 1 : 0, 12, dt);
  let pow = player.flame;
  const fu = flameMat.uniforms;
  if (player.pop > 0) {
    player.pop -= dt;
    const k = clamp(player.pop / 0.18, 0, 1) * 0.9;
    if (k > pow) { pow = k; fu.uCore.value.setRGB(6, 3.2, 1.2); fu.uEdge.value.setRGB(2.2, 0.6, 0.1); fu.uLen.value = 0.45; }
  } else {
    fu.uCore.value.setRGB(2.5, 3.2, 6.0);
    fu.uEdge.value.setRGB(0.5, 0.3, 2.2);
    fu.uLen.value = 0.55 + 0.45 * player.flame;
  }
  fu.uPower.value = pow;
  fu.uTime.value = G.t;
}
function updateLampLight() {
  let bd = 1e9, bz = 0;
  for (let i = 0; i < LAMP_N; i++) { const d = Math.abs(lampZ[i] - 0.5); if (d < bd) { bd = d; bz = lampZ[i]; } }
  lampLight.position.set(LAMP_OUR_X, LAMP_Y - 0.4, bz);
  lampLight.intensity = 2.6 * Math.exp(-(bd * bd) / 160);
}
function updateStreaks() {
  streakN = 0;
  const bk = player.braking ? 1.8 : 1;
  for (const s of [-0.72, 0.72]) addStreak(player.x + s, 0.76, 2.3, 0.45 * bk, 0.015 * bk, 0.025 * bk, 0.45);
  for (const v of vehicles) {
    const fade = smooth(-900, -560, v.z);
    if (fade <= 0) continue;
    if (v.dir > 0) {
      const k = 0.3 * fade * (1 + v.brake * 0.8);
      const truckish = v.kind === 'truck';
      const off = truckish ? 1.0 : 0.62;
      const y = truckish ? 1.25 : 0.78 * v.sy;
      const zz = v.z + (truckish ? 7.24 : 2.42);
      addStreak(v.x - off, y, zz, k, k * 0.03, k * 0.05);
      addStreak(v.x + off, y, zz, k, k * 0.03, k * 0.05);
    } else {
      const k = 0.22 * fade;
      for (const s of [-0.62, 0.62]) addStreak(v.x + s, 0.66 * v.sy, v.z + 2.42, k * 0.92, k * 0.95, k);
    }
  }
  streakMesh.count = streakN;
  streakMesh.instanceMatrix.needsUpdate = true;
  streakMesh.instanceColor.needsUpdate = true;
}

// ---------- camera ----------
const camPos = new THREE.Vector3(0, 2.5, 8.6);
const camLook = new THREE.Vector3(0, 1, -30);
const _vpDir = new THREE.Vector3();
function updateCamera(dt) {
  const speedK = clamp(player.v / 90, 0, 1);
  const boostK = player.flame;
  let fov = 58;
  let blurScale = 1;
  const driving = G.state === 'drive' || G.state === 'countdown';
  if (driving) {
    const c = CAMS[camMode];
    camPos.x = damp(camPos.x, player.x * (c.inside ? 1 : 0.8) + (c.inside ? 0 : player.vx * 0.05), c.inside ? 40 : 5, dt);
    camPos.y = c.h + (c.inside ? 0 : speedK * 0.2);
    camPos.z = c.dist + (c.inside ? 0 : speedK * 1.3 + boostK * 0.9);
    camLook.set(player.x * 0.9 + player.vx * 0.15, c.lookH, -c.look);
    fov = c.fov + speedK * 8 + boostK * 7;
  } else {
    G.shotT -= dt;
    if (G.shotT <= 0) { G.shot = (G.shot + 1) % 4; G.shotT = 6.5; }
    const px = player.x;
    const sway = Math.sin(G.t * 0.25);
    if (G.shot === 0) { camPos.set(px * 0.8, 1.75, 13); camLook.set(px, 1.7, -42); fov = 46; }
    else if (G.shot === 1) { camPos.set(px + 3.0 + sway * 0.3, 0.85, -7.6); camLook.set(px, 0.75, 0.2); fov = 50; blurScale = 0.5; }
    else if (G.shot === 2) { camPos.set(px - 5.6, 1.05, -0.4 + sway); camLook.set(px, 0.7, 0.4); fov = 48; blurScale = 0.6; }
    else { camPos.set(px * 0.6 + sway * 2, 6.2, 16); camLook.set(px, 0.6, -24); fov = 50; }
  }
  let sx = 0, sy = 0;
  if (!reduceMotion) {
    const amp = speedK * speedK * 0.025 + G.shake * 0.18 + boostK * 0.02;
    sx = (Math.random() - 0.5) * amp;
    sy = (Math.random() - 0.5) * amp;
  }
  camera.position.set(camPos.x + sx, camPos.y + sy, camPos.z);
  camera.lookAt(camLook);
  if (driving) camera.rotateZ(-player.vx * 0.0035);
  else if (camera.aspect > 1.2) camera.rotateY(0.13);
  if (camera.aspect < 1.3) fov = Math.min(88, fov * lerp(1.45, 1, clamp((camera.aspect - 0.45) / 0.85, 0, 1)));
  camera.fov = damp(camera.fov, fov, 4, dt);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  return blurScale;
}
function updatePost(blurScale) {
  const cu = compositeMat.uniforms;
  _vpDir.set(0, 0, -1).transformDirection(camera.matrixWorldInverse);
  let dx = _vpDir.x, dy = _vpDir.y, dz = _vpDir.z;
  if (dz > 0) { dx = -dx; dy = -dy; dz = -dz; }
  const f = 1 / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const iz = 1 / Math.max(-dz, 0.02);
  cu.uVP.value.set(0.5 + 0.5 * clamp((f / camera.aspect) * dx * iz, -60, 60), 0.5 + 0.5 * clamp(f * dy * iz, -60, 60));
  const speedK = clamp((player.v - 12) / 78, 0, 1);
  cu.uBlur.value = (reduceMotion ? 0.3 : 1) * blurScale * (0.032 * speedK * speedK + 0.022 * player.flame);
  cu.uSamples.value = qScale < 0.85 ? 6 : 9;
  cu.uAberr.value = 0.003 + 0.006 * speedK + 0.01 * player.flame;
  cu.uTime.value = G.t;
  cu.uFlash.value.copy(G.flashCol).multiplyScalar(G.flash);
}

// ---------- HUD ----------
const hudCache = {};
function setText(el, key, val) { if (hudCache[key] !== val) { hudCache[key] = val; el.textContent = val; } }
const fmt = (n) => Math.floor(n).toLocaleString('en-US');
function updateHUD() {
  if (HUD.hud.hidden) return;
  const kmh = Math.round(player.v * 3.6);
  setText(HUD.speed, 'speed', String(kmh));
  setText(HUD.gear, 'gear', String(player.gear));
  HUD.arc.style.strokeDashoffset = (314.16 * (1 - clamp(kmh / 360, 0, 1))).toFixed(1);
  HUD.nitro.style.transform = 'scaleX(' + player.nitro.toFixed(3) + ')';
  HUD.speedo.classList.toggle('boost', player.boosting);
  HUD.speedo.classList.toggle('redline', !player.boosting && kmh > 290);
  const tl = Math.max(0, G.time);
  setText(HUD.clock, 'clock', tl.toFixed(1));
  HUD.timefill.style.transform = 'scaleX(' + (tl / 60).toFixed(4) + ')';
  const late = G.state === 'drive' && tl < 10;
  HUD.clock.classList.toggle('late', late);
  HUD.timebar.classList.toggle('late', late);
  setText(HUD.score, 'score', fmt(G.score));
  setText(HUD.dist, 'dist', (G.distRun / 1000).toFixed(2));
  setText(HUD.nm, 'nm', String(G.nearMiss));
}

// ---------- flow ----------
function showTitle() {
  G.state = 'title';
  G.shot = 0;
  G.shotT = 6.5;
  HUD.title.hidden = false;
  HUD.results.hidden = true;
  HUD.hud.hidden = true;
  HUD.touch.hidden = true;
  HUD.bestLine.textContent = G.best > 0 ? 'Best run on this device: ' + fmt(G.best) : '';
}
function startRun() {
  audio.init();
  if (clip) clip.onStart();
  Object.assign(G, { state: 'countdown', cd: 3, lastCd: 4, time: 60, score: 0, bonus: 0, distRun: 0, nearMiss: 0, overtakes: 0, crashes: 0, top: 0, sumV: 0, sumT: 0, combo: 0, comboT: 0, hintT: 9 });
  togglePause(false);
  player.nitro = 1;
  player.crashT = 0;
  if (player.v < 28) player.v = 30;
  HUD.title.hidden = true;
  HUD.results.hidden = true;
  HUD.hud.hidden = false;
  HUD.hud.classList.toggle('off', G.hudOff);
  HUD.touch.hidden = !coarse;
  HUD.hint.style.opacity = '1';
  try { canvas.focus({ preventScroll: true }); } catch (e) { /* focus is optional */ }
}
function endRun() {
  G.state = 'end';
  G.shot = 0;
  G.shotT = 7;
  const score = Math.floor(G.score);
  const prev = G.best;
  const isBest = score > prev;
  if (isBest) { G.best = score; store.set('best', score); }
  $('resKicker').textContent = isBest ? 'New best run' : 'Run complete';
  $('resScore').textContent = fmt(score);
  const rb = $('resBest');
  rb.textContent = isBest ? (prev > 0 ? 'Previous best ' + fmt(prev) : 'First run on this device') : 'Best ' + fmt(G.best);
  rb.classList.toggle('new', isBest);
  $('rDist').textContent = (G.distRun / 1000).toFixed(2);
  $('rTop').textContent = String(Math.round(G.top));
  $('rAvg').textContent = String(Math.round(G.sumT > 0 ? (G.sumV / G.sumT) * 3.6 : 0));
  $('rNm').textContent = String(G.nearMiss);
  $('rOv').textContent = String(G.overtakes);
  $('rCr').textContent = String(G.crashes);
  HUD.hud.hidden = true;
  HUD.touch.hidden = true;
  HUD.results.hidden = false;
  for (const k in keys) keys[k] = false;
}
function togglePause(on) {
  if (on === G.paused) return;
  G.paused = on;
  HUD.pause.hidden = !on;
  if (on) audio.suspend(); else audio.resume();
  if (clip) clip.onPause(on);
}
function toggleFullscreen() {
  try {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
  } catch (e) { /* fullscreen is not allowed here */ }
}

function update(dt) {
  G.t += dt;
  let steerIn = 0;
  if (G.state === 'drive') {
    steerIn = drive(dt);
    G.time -= dt;
    if (G.time <= 0) { G.time = 0; endRun(); }
  } else if (G.state === 'countdown') {
    autopilot(dt, 31);
    G.cd -= dt;
    const n = Math.ceil(G.cd);
    if (n !== G.lastCd && n > 0) { G.lastCd = n; showCount(String(n)); audio.beep(440, 0.12); }
    if (G.cd <= 0) {
      G.state = 'drive';
      showCount('Go', true);
      audio.beep(880, 0.25);
      G.flash = 0.25;
      G.flashCol.set(0.5, 0.6, 1.0);
    }
  } else {
    autopilot(dt, G.state === 'end' ? 33 : 40);
  }
  contactBarriers(dt, steerIn);
  player.crashT = Math.max(0, player.crashT - dt);
  updateGears(dt);
  const pv = player.v;
  dist += pv * dt;
  if (G.state === 'drive') {
    G.distRun += pv * dt;
    G.sumV += pv * dt;
    G.sumT += dt;
    G.top = Math.max(G.top, pv * 3.6);
    G.comboT -= dt;
    if (G.comboT <= 0) G.combo = 0;
    G.score = G.distRun + G.bonus;
    if (G.hintT > 0) { G.hintT -= dt; if (G.hintT <= 0) HUD.hint.style.opacity = '0'; }
  }
  updateTraffic(dt, pv);
  checkTraffic();
  updateWorld(dt);
  writeTraffic();
  updateCarVisual(dt, steerIn);
  updateSparks(dt, pv);
  updateWind(dt, pv, player.x, player.flame);
  updateLampLight();
  G.shake = damp(G.shake, 0, 3.5, dt);
  G.flash = damp(G.flash, 0, 5, dt);
  const blurScale = updateCamera(dt);
  updateStreaks();
  updatePost(blurScale);
  sky.position.copy(camera.position);
  stars.position.copy(camera.position);
  skyline.position.x = camera.position.x;
  skyline.position.z = camera.position.z;
  skyMat.uniforms.uTime.value = G.t;
  stars.material.uniforms.uTime.value = G.t;
  stars.material.uniforms.uPR.value = renderer.getPixelRatio();
  audio.update(player.rpm, player.throttle, pv, player.flame, player.scrape);
  updateHUD();
}

// ---------- input ----------
const KEYMAP = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', ShiftLeft: 'boost', ShiftRight: 'boost', Space: 'boost' };
const HOTKEYS = ['KeyV', 'KeyC', 'KeyL', 'KeyM', 'KeyH', 'KeyP', 'Escape', 'KeyR', 'KeyF', 'Enter', 'NumpadEnter'];
window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const code = e.code;
  const k = KEYMAP[code];
  const idle = G.state === 'title' || G.state === 'end';
  if (k || HOTKEYS.includes(code)) e.preventDefault();
  if (!e.repeat && (code === 'Enter' || code === 'NumpadEnter' || (code === 'Space' && idle))) {
    if (idle) { startRun(); return; }
    if (G.paused) { togglePause(false); return; }
  }
  if (k) keys[k] = true;
  if (e.repeat) return;
  audio.resume();
  switch (code) {
    case 'KeyV':
      camMode = (camMode + 1) % CAMS.length;
      store.set('cam', camMode);
      popup(CAMS[camMode].name + ' camera');
      break;
    case 'KeyC':
      setPaint(paintIdx + 1);
      store.set('paint', paintIdx);
      popup(PAINTS[paintIdx].name);
      break;
    case 'KeyL':
      glowIdx = (glowIdx + 1) % GLOW.length;
      store.set('glow', glowIdx);
      applyGlow();
      popup(GLOW[glowIdx].name);
      break;
    case 'KeyM':
      audio.init();
      audio.setEnabled(!audio.enabled);
      popup(audio.enabled ? 'Sound on' : 'Sound off');
      break;
    case 'KeyH':
      G.hudOff = !G.hudOff;
      HUD.hud.classList.toggle('off', G.hudOff);
      break;
    case 'KeyP':
    case 'Escape':
      if (G.state === 'drive' || G.state === 'countdown') togglePause(!G.paused);
      break;
    case 'KeyR':
      if (G.state !== 'title' && G.state !== 'boot') startRun();
      break;
    case 'KeyF':
      toggleFullscreen();
      break;
    default:
      break;
  }
});
window.addEventListener('keyup', (e) => { const k = KEYMAP[e.code]; if (k) keys[k] = false; });
window.addEventListener('blur', () => {
  for (const k in keys) keys[k] = false;
  if (G.state === 'drive') togglePause(true);
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) audio.suspend(); else if (!G.paused) audio.resume();
});
$('startBtn').addEventListener('click', startRun);
$('againBtn').addEventListener('click', startRun);
HUD.pause.addEventListener('click', () => togglePause(false));
canvas.addEventListener('pointerdown', () => {
  try { canvas.focus({ preventScroll: true }); } catch (e) { /* focus is optional */ }
  audio.resume();
});
for (const btn of document.querySelectorAll('.tbtn')) {
  const k = btn.dataset.k;
  const off = () => { keys[k] = false; btn.classList.remove('on'); };
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    keys[k] = true;
    btn.classList.add('on');
    try { btn.setPointerCapture(e.pointerId); } catch (err) { /* capture is optional */ }
  });
  btn.addEventListener('pointerup', off);
  btn.addEventListener('pointercancel', off);
  btn.addEventListener('lostpointercapture', off);
}

// ---------- loop ----------
let ftAvg = 16, qTimer = 0, last = 0;
function adaptQuality(ms) {
  ftAvg = lerp(ftAvg, ms, 0.05);
  qTimer += ms;
  if (qTimer < 2500) return;
  qTimer = 0;
  if (ftAvg > 24 && qScale > 0.6) { qScale = Math.max(0.6, qScale * 0.85); resize(); }
  else if (ftAvg < 13 && qScale < 1) { qScale = Math.min(1, qScale * 1.1); resize(); }
}
function frame(now) {
  requestAnimationFrame(frame);
  const ms = now - last;
  last = now;
  if (G.paused) return;
  update(Math.min(ms / 1000, 0.05));
  renderFrame();
  if (clip) clip.draw();
  adaptQuality(Math.min(ms, 100));
}

let booted = false;
function boot(data) {
  if (booted) return;
  booted = true;
  if (data && typeof data === 'object') {
    if (Number.isInteger(data.paint)) setPaint(data.paint);
    if (Number.isInteger(data.cam)) camMode = mod(data.cam, CAMS.length);
  }
  if (coarse) document.body.classList.add('touch');
  resize();
  window.addEventListener('resize', resize);
  try {
    update(1 / 60);
    renderer.compile(scene, camera);
    renderFrame();
  } catch (e) {
    fatal('The graphics engine hit an error while starting. Reloading the page usually fixes it.');
    return;
  }
  bootEl.hidden = true;
  showTitle();
  requestAnimationFrame((t) => { last = t; frame(t); });
}
boot({});
if (new URLSearchParams(window.location.search).get('clip') === '1') {
  import('./clip.js').then((m) => { clip = m.createClip({
    canvas, G, hud: HUD.hud,
    // what the menu video cycles through
    menu: {
      nPaints: PAINTS.length, paintIndex: () => paintIdx, paintName: (i) => PAINTS[i].name, setPaint,
      nGlow: GLOW.length, glowIndex: () => glowIdx, glowName: (i) => GLOW[i].name,
      setGlow: (i) => { glowIdx = i; applyGlow(); },
    },
    initAudio: () => audio.init(),
  }); }).catch(() => { /* clip mode is optional */ });
}
window.NightHighway = { G, player, keys, startRun, endRun };
}
