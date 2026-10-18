// Finds the main thing in a photo with IS-Net (DIS, general use), run in the
// browser by ONNX Runtime Web. The photo never leaves the device.
//
// The model file keeps its weights in half precision to halve the download and
// casts them back up when it loads, so the maths is plain float32 and runs the
// same on WebGPU (any GPU, no f16 support needed) and on the CPU fallback.

const MODEL = './models/isnet-general-h2f.onnx';
const MODEL_BYTES = 90419445;
const CACHE = 'peel-models-v1';
const SIZE = 1024;

let ortP = null, sessP = null, backend = '', listener = null;

// progress(got, total) while the model downloads, progress(total, total, 'warming') while it starts
export const listen = fn => { listener = fn; };
const progress = (...a) => listener?.(...a);

function loadOrt() {
  ortP ??= import('./vendor/ort/ort.min.mjs').then(ort => {
    ort.env.wasm.wasmPaths = new URL('./vendor/ort/', location.href).href;
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
    ort.env.logLevel = 'error';
    return ort;
  });
  return ortP;
}

async function fetchModel() {
  let cache = null;
  try {
    cache = await caches.open(CACHE);
    const hit = await cache.match(MODEL);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
  } catch { cache = null; }
  const res = await fetch(MODEL);
  if (!res.ok) throw new Error(`Couldn't download the cutter (${res.status})`);
  const reader = res.body.getReader(), parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
    progress(Math.min(got, MODEL_BYTES), MODEL_BYTES);
  }
  const bytes = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { bytes.set(p, o); o += p.length; }
  if (cache) {
    try {
      await cache.put(MODEL, new Response(bytes.slice(), { headers: { 'Content-Type': 'application/octet-stream' } }));
      for (const k of await caches.keys()) if (k.startsWith('peel-models-') && k !== CACHE) caches.delete(k);
    } catch { /* full or private: it just downloads again next time */ }
  }
  return bytes;
}

export async function isCached() {
  try { return !!(await (await caches.open(CACHE)).match(MODEL)); } catch { return false; }
}

async function session(avoid) {
  const ort = await loadOrt();
  const bytes = await fetchModel();
  progress(MODEL_BYTES, MODEL_BYTES, 'warming');
  const forced = new URLSearchParams(location.search).get('ep');
  const eps = forced ? [forced] : navigator.gpu && avoid !== 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'];
  let last;
  for (const ep of eps) {
    try {
      const s = await ort.InferenceSession.create(bytes, { executionProviders: [ep], graphOptimizationLevel: 'all' });
      backend = ep;
      return s;
    } catch (e) { last = e; console.warn(`peel: ${ep} didn't start`, e); }
  }
  throw last || new Error('No way to run the cutter here');
}

export function ready() {
  sessP ??= session().catch(e => { sessP = null; throw e; });
  return sessP;
}

export const which = () => backend;

// Returns the matte as a Float32Array (0..1) at w×h. One run at a time.
let queue = Promise.resolve();
export function cutout(src, w, h) {
  const p = queue.then(() => run(src, w, h));
  queue = p.catch(() => {});
  return p;
}

async function run(src, w, h) {
  const ort = await loadOrt();
  let s = await ready();
  const t = document.createElement('canvas');
  t.width = t.height = SIZE;
  const g = t.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, SIZE, SIZE);
  const px = g.getImageData(0, 0, SIZE, SIZE).data, plane = SIZE * SIZE;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    input[i] = px[i * 4] / 255 - 0.5;
    input[i + plane] = px[i * 4 + 1] / 255 - 0.5;
    input[i + 2 * plane] = px[i * 4 + 2] / 255 - 0.5;
  }
  const go = async sess => (await sess.run({ input_image: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) })).output_image.data;
  let out = null;
  try { out = await go(s); } catch (e) {
    if (backend !== 'webgpu') throw e;
    console.warn('peel: webgpu run failed', e);
  }
  if (backend === 'webgpu' && (!out || !sane(out))) {
    // a GPU that fails or gives back nonsense: use the CPU from now on
    console.warn('peel: switching to wasm');
    sessP = session('webgpu');
    s = await sessP;
    out = await go(s);
  }
  return resize(out, w, h);
}

function sane(m) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < m.length; i += 7) {
    const v = m[i];
    if (Number.isNaN(v)) return false;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return hi - lo > 0.05;
}

// Scale the 1024×1024 matte to the photo's shape through a canvas (bilinear).
function resize(m, w, h) {
  const a = document.createElement('canvas');
  a.width = a.height = SIZE;
  const ga = a.getContext('2d');
  const id = ga.createImageData(SIZE, SIZE), d = id.data;
  for (let i = 0; i < m.length; i++) {
    const v = Math.max(0, Math.min(255, Math.round(m[i] * 255)));
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
  }
  ga.putImageData(id, 0, 0);
  const b = document.createElement('canvas');
  b.width = w; b.height = h;
  const gb = b.getContext('2d', { willReadFrequently: true });
  gb.imageSmoothingQuality = 'high';
  gb.drawImage(a, 0, 0, w, h);
  const r = gb.getImageData(0, 0, w, h).data, out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = r[i * 4] / 255;
  return out;
}
