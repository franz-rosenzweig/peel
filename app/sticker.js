// Masks and the die-cut border. A mask is a Uint8Array, one byte per pixel
// (0 = gone, 255 = kept), the same size as the working image.

const INF = 1e20;
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = t => t * t * (3 - 2 * t);

// Squared Euclidean distance transform (Felzenszwalb & Huttenlocher), in place.
// grid holds 0 on the pixels we measure from and INF everywhere else. A Float32Array
// is enough (exact for distances under 4096 px) and takes half the memory.
export function edt(grid, w, h) {
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1);
  const v = new Int32Array(n);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) f[x] = grid[o + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) grid[o + x] = d[x];
  }
  return grid;
}

function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

// distance from every pixel to the nearest pixel where in(i) is true
function distTo(w, h, inside) {
  const g = new Float32Array(w * h);
  for (let i = 0; i < g.length; i++) g[i] = inside(i) ? 0 : INF;
  edt(g, w, h);
  for (let i = 0; i < g.length; i++) g[i] = Math.sqrt(g[i]);
  return g;
}

export function bbox(mask, w, h, thr = 16) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      if (mask[o + x] >= thr) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export function coverage(mask) {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] >= 128) n++;
  return n / mask.length;
}

// 4-connected flood labelling of pixels where ok(i); returns labels and sizes
function label(w, h, ok) {
  const n = w * h, lab = new Int32Array(n), stack = new Int32Array(n), sizes = [0];
  for (let i = 0; i < n; i++) {
    if (lab[i] || !ok(i)) continue;
    const id = sizes.length;
    let sp = 0, size = 0;
    stack[sp++] = i; lab[i] = id;
    while (sp) {
      const p = stack[--sp], x = p % w;
      size++;
      if (x > 0 && !lab[p - 1] && ok(p - 1)) { lab[p - 1] = id; stack[sp++] = p - 1; }
      if (x < w - 1 && !lab[p + 1] && ok(p + 1)) { lab[p + 1] = id; stack[sp++] = p + 1; }
      if (p >= w && !lab[p - w] && ok(p - w)) { lab[p - w] = id; stack[sp++] = p - w; }
      if (p < n - w && !lab[p + w] && ok(p + w)) { lab[p + w] = id; stack[sp++] = p + w; }
    }
    sizes.push(size);
  }
  return { lab, sizes };
}

// The model's raw 0..1 matte, already resized to w×h, becomes a clean mask:
// harden the haze, then drop stray islands (bokeh, a bit of the table) that are
// small next to the main subject, along with the soft fringe around them.
export function cleanMatte(m, w, h) {
  const n = w * h, out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = m[i];
    out[i] = a <= 0.15 ? 0 : a >= 0.8 ? 255 : Math.round(smooth((a - 0.15) / 0.65) * 255);
  }
  const { lab, sizes } = label(w, h, i => out[i] >= 128);
  if (sizes.length <= 2) return out;
  const big = Math.max(...sizes), keep = sizes.map(s => s >= Math.max(big * 0.06, n * 0.0004));
  const d = distTo(w, h, i => lab[i] && keep[lab[i]]);
  const reach = Math.max(3, Math.round(Math.max(w, h) / 300));
  for (let i = 0; i < n; i++) {
    if (lab[i] && !keep[lab[i]]) out[i] = 0;
    else if (!lab[i] && d[i] > reach) out[i] = 0;
  }
  return out;
}

// Separate pieces in a mask (things that don't touch), biggest first. Each kept
// pixel, soft edge included, goes to the piece it's connected to; pieces much
// smaller than the biggest one don't count. Returns { count, labels }.
export function pieces(mask, w, h, minFrac = 0.05) {
  const n = w * h, { lab, sizes } = label(w, h, i => mask[i] >= 128);
  const big = Math.max(0, ...sizes), min = Math.max(big * minFrac, n * 0.002);
  const order = sizes.map((s, id) => [s, id]).filter(([s, id]) => id && s >= min).sort((a, b) => b[0] - a[0]);
  const remap = new Int32Array(sizes.length);
  order.forEach(([, id], k) => { remap[id] = k + 1; });
  // spread the labels out over the soft edge, breadth first, so the fringe follows its piece
  const queue = new Int32Array(n);
  let qh = 0, qt = 0;
  for (let i = 0; i < n; i++) {
    lab[i] = lab[i] ? remap[lab[i]] : 0;
    if (lab[i]) queue[qt++] = i;
  }
  while (qh < qt) {
    const p = queue[qh++], x = p % w, id = lab[p];
    for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
      if (q < 0 || q >= n || lab[q] || !mask[q]) continue;
      lab[q] = id; queue[qt++] = q;
    }
  }
  return { count: order.length, labels: lab };
}

export function piece(mask, labels, id) {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) if (labels[i] === id) out[i] = mask[i];
  return out;
}

// The piece under (x, y), or the nearest one within a finger's reach, plus its
// soft fringe. Returns a Uint8Array of 1s, or null when there's nothing there.
export function pieceAt(mask, w, h, x, y) {
  const reach = Math.max(10, Math.round(Math.max(w, h) * 0.015));
  let seed = -1, best = Infinity;
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const px = Math.round(x) + dx, py = Math.round(y) + dy, d = dx * dx + dy * dy;
      if (px < 0 || py < 0 || px >= w || py >= h || d >= best || d > reach * reach) continue;
      if (mask[py * w + px] >= 40) { best = d; seed = py * w + px; }
    }
  }
  if (seed < 0) return null;
  const n = w * h, hit = new Uint8Array(n), stack = new Int32Array(n);
  let sp = 0;
  stack[sp++] = seed; hit[seed] = 1;
  while (sp) {
    const p = stack[--sp], px = p % w;
    for (const q of [px > 0 ? p - 1 : -1, px < w - 1 ? p + 1 : -1, p - w, p + w]) {
      if (q < 0 || q >= n || hit[q] || mask[q] < 40) continue;
      hit[q] = 1; stack[sp++] = q;
    }
  }
  // take the faint fringe next to it too
  for (let pass = 0; pass < 3; pass++) {
    const add = [];
    for (let p = 0; p < n; p++) {
      if (hit[p] || !mask[p]) continue;
      const px = p % w;
      if ((px > 0 && hit[p - 1]) || (px < w - 1 && hit[p + 1]) || (p >= w && hit[p - w]) || (p < n - w && hit[p + w])) add.push(p);
    }
    for (const p of add) hit[p] = 1;
  }
  return hit;
}

// Magic wand: take out everything close to the colour at (x, y), either just
// the patch connected to it or everywhere in the photo. tol is 0..100.
export function wand(mask, img, w, h, x, y, tol, connected) {
  const d = img.data, n = w * h;
  let r = 0, g = 0, b = 0, c = 0;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const px = Math.round(x) + dx, py = Math.round(y) + dy;
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      const i = (py * w + px) * 4;
      r += d[i]; g += d[i + 1]; b += d[i + 2]; c++;
    }
  }
  if (!c) return 0;
  r /= c; g /= c; b /= c;
  const T = (0.03 + tol / 100 * 0.5) * 441.7, inner = T * 0.7;
  const strength = i => {
    const dr = d[i * 4] - r, dg = d[i * 4 + 1] - g, db = d[i * 4 + 2] - b;
    const dist = Math.sqrt(dr * dr * 0.9 + dg * dg * 1.2 + db * db * 0.9);
    return dist <= inner ? 1 : dist >= T ? 0 : (T - dist) / (T - inner);
  };
  let removed = 0;
  const hit = i => {
    const s = strength(i);
    if (s > 0) {
      const v = Math.round(mask[i] * (1 - s));
      if (v !== mask[i]) { removed++; mask[i] = v; }
    }
    return s > 0;
  };
  if (!connected) {
    for (let i = 0; i < n; i++) hit(i);
    return removed;
  }
  const seen = new Uint8Array(n), stack = new Int32Array(n);
  const seed = Math.min(h - 1, Math.max(0, Math.round(y))) * w + Math.min(w - 1, Math.max(0, Math.round(x)));
  let sp = 0;
  stack[sp++] = seed; seen[seed] = 1;
  while (sp) {
    const p = stack[--sp];
    if (!hit(p)) continue;
    const px = p % w;
    for (const q of [px > 0 ? p - 1 : -1, px < w - 1 ? p + 1 : -1, p - w, p + w]) {
      if (q < 0 || q >= n || seen[q]) continue;
      seen[q] = 1; stack[sp++] = q;
    }
  }
  return removed;
}

// Edge tools: grow (+) or shrink (−) the edge by a few pixels, and smooth it.
// Shrinking also takes off the faint halo of old background around the edge.
export function refineEdge(mask, w, h, grow = 0, smoothPx = 0) {
  if (!grow && !smoothPx) return mask;
  const n = w * h;
  let m = mask;
  if (smoothPx > 0) {
    const f = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = m[i] / 255;
    const r = Math.max(1, Math.round(smoothPx));
    for (let k = 0; k < 3; k++) boxBlur(f, w, h, r);
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.round(smooth(clamp01((f[i] - 0.3) / 0.4)) * 255);
    m = out;
  }
  if (grow) {
    const out = new Uint8Array(n);
    if (grow < 0) {
      const d = distTo(w, h, i => m[i] < 128), k = -grow;
      for (let i = 0; i < n; i++) out[i] = Math.min(m[i], Math.round(clamp01(d[i] - k) * 255));
    } else {
      const d = distTo(w, h, i => m[i] >= 128);
      for (let i = 0; i < n; i++) out[i] = Math.max(m[i], Math.round(clamp01(grow + 0.5 - d[i]) * 255));
    }
    m = out;
  }
  return m;
}

function boxBlur(f, w, h, r) {
  const tmp = new Float32Array(Math.max(w, h)), span = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let s = 0;
    for (let x = -r; x <= r; x++) s += f[o + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[x] = s / span;
      s += f[o + Math.min(w - 1, x + r + 1)] - f[o + Math.max(0, x - r)];
    }
    for (let x = 0; x < w; x++) f[o + x] = tmp[x];
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += f[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      tmp[y] = s / span;
      s += f[Math.min(h - 1, y + r + 1) * w + x] - f[Math.max(0, y - r) * w + x];
    }
    for (let y = 0; y < h; y++) f[y * w + x] = tmp[y];
  }
}

export function shapeMask(kind, w, h) {
  const c = canvas(w, h), g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff';
  const s = Math.min(w, h), cx = w / 2, cy = h / 2;
  if (kind === 'circle') {
    g.beginPath(); g.arc(cx, cy, s * 0.49, 0, Math.PI * 2); g.fill();
  } else if (kind === 'heart') {
    const k = s * 0.98, ox = cx - k / 2, oy = cy - k / 2, P = (x, y) => [ox + x * k, oy + y * k];
    g.beginPath();
    g.moveTo(...P(0.5, 0.95));
    g.bezierCurveTo(...P(0.3, 0.8), ...P(0.0, 0.58), ...P(0.02, 0.32));
    g.bezierCurveTo(...P(0.04, 0.1), ...P(0.3, 0.0), ...P(0.5, 0.2));
    g.bezierCurveTo(...P(0.7, 0.0), ...P(0.96, 0.1), ...P(0.98, 0.32));
    g.bezierCurveTo(...P(1.0, 0.58), ...P(0.7, 0.8), ...P(0.5, 0.95));
    g.fill();
  } else {
    const r = s * 0.09, m = s * 0.01;
    g.beginPath(); g.roundRect(m, m, w - 2 * m, h - 2 * m, r); g.fill();
  }
  const d = g.getImageData(0, 0, w, h).data, out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3];
  return out;
}

// One brush dab, soft at the rim. value 0 erases, 255 brings back.
export function dab(mask, w, h, cx, cy, r, value) {
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
  const soft = Math.max(1, r * 0.3);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > r) continue;
      const t = Math.min(1, (r - d) / soft), i = y * w + x;
      if (value) mask[i] = Math.max(mask[i], Math.round(t * 255));
      else mask[i] = Math.min(mask[i], Math.round((1 - t) * 255));
    }
  }
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  return c;
}

// Closed outlines of alpha >= 128, by marching squares, as lists of [x, y].
export function contours(a, w, h) {
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : a[y * w + x]);
  const W1 = w + 1, segs = new Map();
  const ek = (x, y, vertical) => ((y + 1) * (W1 + 1) + x + 1) * 2 + (vertical ? 1 : 0);
  const pt = new Map();
  const point = (key, x0, y0, x1, y1) => {
    if (!pt.has(key)) {
      const v0 = at(x0, y0), v1 = at(x1, y1), t = v1 === v0 ? 0.5 : (128 - v0) / (v1 - v0);
      pt.set(key, [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
    }
    return key;
  };
  const link = (p, q) => {
    if (!segs.has(p)) segs.set(p, []);
    if (!segs.has(q)) segs.set(q, []);
    segs.get(p).push(q); segs.get(q).push(p);
  };
  for (let y = -1; y < h; y++) {
    for (let x = -1; x < w; x++) {
      const tl = at(x, y) >= 128, tr = at(x + 1, y) >= 128, br = at(x + 1, y + 1) >= 128, bl = at(x, y + 1) >= 128;
      const c = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0);
      if (c === 0 || c === 15) continue;
      const T = () => point(ek(x, y, false), x, y, x + 1, y);
      const R = () => point(ek(x + 1, y, true), x + 1, y, x + 1, y + 1);
      const B = () => point(ek(x, y + 1, false), x, y + 1, x + 1, y + 1);
      const L = () => point(ek(x, y, true), x, y, x, y + 1);
      switch (c) {
        case 1: case 14: link(L(), B()); break;
        case 2: case 13: link(B(), R()); break;
        case 3: case 12: link(L(), R()); break;
        case 4: case 11: link(T(), R()); break;
        case 6: case 9: link(T(), B()); break;
        case 7: case 8: link(L(), T()); break;
        case 5: link(L(), T()); link(B(), R()); break;
        case 10: link(T(), R()); link(L(), B()); break;
      }
    }
  }
  const loops = [], used = new Set();
  for (const start of segs.keys()) {
    if (used.has(start)) continue;
    const loop = [];
    let prev = -1, cur = start;
    while (cur !== undefined && !used.has(cur)) {
      used.add(cur);
      loop.push(pt.get(cur));
      const next = segs.get(cur).find(k => k !== prev && !used.has(k));
      prev = cur; cur = next;
    }
    if (loop.length > 8) loops.push(loop);
  }
  return loops;
}

const OUTLINE_INK = '#2A2630';

// The sticker body: border, outline and the subject, trimmed, without the shadow.
// img: ImageData; border: fraction of the subject's long side; outline: none | line | double | dashed.
// px: output pixels per working pixel, so the few fixed sizes grow with a bigger render.
export function render({ img, mask, w, h, border = 0.035, color = '#ffffff', outline = 'none', outlineColor = OUTLINE_INK, px = 1 }) {
  const box = bbox(mask, w, h);
  if (!box) return null;
  const side = Math.max(box.w, box.h);
  const r = border * side, s = r * 0.55;
  const t = outline === 'line' ? Math.max(1.5 * px, side * 0.008) : outline === 'double' ? Math.max(3 * px, side * 0.014 + r * 0.45) : 0;
  const dl = outline === 'dashed' ? Math.max(1.5 * px, side * 0.0065) : 0;
  const pad = Math.ceil(r + s + t + dl * 2 + 3 * px);
  const rx = box.x - pad, ry = box.y - pad, rw = box.w + 2 * pad, rh = box.h + 2 * pad, n = rw * rh;

  // subject pixels and their alpha, in region coordinates
  const sub = new ImageData(rw, rh), sd = sub.data, src = img.data;
  const alpha = new Uint8Array(n);
  for (let y = 0; y < rh; y++) {
    const iy = y + ry;
    if (iy < 0 || iy >= h) continue;
    for (let x = 0; x < rw; x++) {
      const ix = x + rx;
      if (ix < 0 || ix >= w) continue;
      const a = mask[iy * w + ix];
      if (!a) continue;
      const si = (iy * w + ix) * 4, di = (y * rw + x) * 4;
      sd[di] = src[si]; sd[di + 1] = src[si + 1]; sd[di + 2] = src[si + 2]; sd[di + 3] = a;
      alpha[y * rw + x] = a;
    }
  }

  // the cut line: grow the subject by r + s, then shrink it back by s, which
  // rounds it off and fills the little gaps a die cutter would skip
  let shape = alpha;
  const cut = r >= 0.5 * px;
  if (cut) {
    const g = new Float32Array(n);
    for (let i = 0; i < n; i++) g[i] = alpha[i] >= 64 ? 0 : INF;
    edt(g, rw, rh);
    const grow = (r + s) * (r + s);
    for (let i = 0; i < n; i++) g[i] = g[i] <= grow ? INF : 0;
    edt(g, rw, rh);
    shape = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.round(clamp01(Math.sqrt(g[i]) - s + 0.5) * 255);
      shape[i] = a;
      // nothing of the photo outside the cut line (faint haze the model wasn't sure about)
      if (sd[i * 4 + 3] > a) sd[i * 4 + 3] = a;
    }
  }

  const body = canvas(rw, rh), bg = body.getContext('2d');
  const layer = c => { bg.drawImage(c, 0, 0); free(c); };
  if (t > 0) layer(tint(ringAround(shape, rw, rh, t), rw, rh, outlineColor));
  if (cut) layer(tint(shape, rw, rh, color));
  layer(toCanvas(sub));
  if (dl > 0) {
    bg.save();
    bg.strokeStyle = outlineColor; bg.lineWidth = dl; bg.lineJoin = 'round'; bg.lineCap = 'round';
    bg.setLineDash([dl * 3.2, dl * 2.4]);
    for (const loop of contours(shape, rw, rh)) {
      bg.beginPath();
      loop.forEach(([x, y], i) => (i ? bg.lineTo(x, y) : bg.moveTo(x, y)));
      bg.closePath(); bg.stroke();
    }
    bg.restore();
  }
  return { canvas: body, side, r };
}

// a band of width t just outside the shape (and under it)
function ringAround(shape, w, h, t) {
  const d = distTo(w, h, i => shape[i] >= 128), out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(shape[i], Math.round(clamp01(t + 0.5 - d[i]) * 255));
  return out;
}

function tint(a, w, h, color) {
  const [r, g, b] = hex(color), id = new ImageData(w, h), d = id.data;
  for (let i = 0; i < a.length; i++) {
    const o = i * 4;
    d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = a[i];
  }
  return toCanvas(id);
}

// Turn, flip and drop the shadow (which always falls down, whatever the turn).
export function finish(body, { rotate = 0, flip = false, shadow = true, side = 100, r = 0, px = 1 } = {}) {
  const rad = rotate * Math.PI / 180, c = Math.abs(Math.cos(rad)), s = Math.abs(Math.sin(rad));
  const bw = body.width, bh = body.height;
  const rw = Math.ceil(bw * c + bh * s), rh = Math.ceil(bw * s + bh * c);
  const sp = shadow ? Math.ceil(side * 0.035 + r * 0.4 + 4 * px) : 0;
  const out = canvas(rw + 2 * sp, rh + 2 * sp), g = out.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.translate(out.width / 2, out.height / 2);
  g.rotate(rad);
  if (flip) g.scale(-1, 1);
  if (shadow) {
    g.shadowColor = 'rgba(52, 36, 20, 0.30)';
    g.shadowBlur = side * 0.018 + r * 0.25 + 2 * px;
    g.shadowOffsetY = side * 0.008 + r * 0.12 + px;
  }
  g.drawImage(body, -bw / 2, -bh / 2);
  return out;
}

// Scale a finished sticker down so its long side is at most `long` pixels.
export function fit(c, long) {
  let cur = c;
  while (Math.max(cur.width, cur.height) > long * 1.9) {
    const h = canvas(cur.width / 2, cur.height / 2), g = h.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(cur, 0, 0, h.width, h.height);
    if (cur !== c) free(cur);
    cur = h;
  }
  const k = long / Math.max(cur.width, cur.height);
  if (k >= 1) return cur;
  const out = canvas(cur.width * k, cur.height * k), g = out.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(cur, 0, 0, out.width, out.height);
  if (cur !== c) free(cur);
  return out;
}

// Let go of a canvas we're done with now, not whenever the garbage collector gets
// round to it: Safari on an iPad only allows so much canvas memory in all.
export function free(c) {
  c.width = c.height = 0;
}

// A mask made bigger, smoothly (bilinear). Output pixel (X, Y) starts at
// (ax + X * sx, ay + Y * sy) in mask pixels, where mask pixel i spans i..i+1, and
// shows the mask at its centre. Outside the mask it's 0, so the photo's edge stays a clean cut.
export function upscale(mask, w, h, ow, oh, ax, ay, sx, sy) {
  const out = new Uint8Array(ow * oh);
  const along = (n, a, s, len) => {
    const i0 = new Int32Array(n).fill(-1), i1 = new Int32Array(n), f = new Float32Array(n);
    for (let X = 0; X < n; X++) {
      const p = a + (X + 0.5) * s;
      if (p < 0 || p >= len) continue;
      const t = Math.min(len - 1, Math.max(0, p - 0.5)), i = Math.floor(t);
      i0[X] = i; i1[X] = Math.min(len - 1, i + 1); f[X] = t - i;
    }
    return { i0, i1, f };
  };
  const xs = along(ow, ax, sx, w), ys = along(oh, ay, sy, h);
  for (let Y = 0; Y < oh; Y++) {
    const y0 = ys.i0[Y];
    if (y0 < 0) continue;
    const r0 = y0 * w, r1 = ys.i1[Y] * w, fy = ys.f[Y], o = Y * ow;
    for (let X = 0; X < ow; X++) {
      const x0 = xs.i0[X];
      if (x0 < 0) continue;
      const x1 = xs.i1[X], fx = xs.f[X];
      const top = mask[r0 + x0] + (mask[r0 + x1] - mask[r0 + x0]) * fx;
      const bot = mask[r1 + x0] + (mask[r1 + x1] - mask[r1 + x0]) * fx;
      out[o + X] = Math.round(top + (bot - top) * fy);
    }
  }
  return out;
}

export function toCanvas(data) {
  const c = canvas(data.width, data.height);
  c.getContext('2d').putImageData(data, 0, 0);
  return c;
}

export function hex(c) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(c) || [0, 'ff', 'ff', 'ff'];
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}
