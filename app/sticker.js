// Masks and the die-cut border. A mask is a Uint8Array, one byte per pixel
// (0 = gone, 255 = kept), the same size as the working image.

const INF = 1e20;

// Squared Euclidean distance transform (Felzenszwalb & Huttenlocher), in place.
// grid holds 0 on the pixels we measure from and INF everywhere else.
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

// The model's raw 0..1 matte, already resized to w×h, becomes a clean mask:
// harden the haze, then drop stray islands (bokeh, a bit of the table) that are
// small next to the main subject, along with the soft fringe around them.
export function cleanMatte(m, w, h) {
  const n = w * h, out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = m[i];
    out[i] = a <= 0.15 ? 0 : a >= 0.8 ? 255 : Math.round(smooth((a - 0.15) / 0.65) * 255);
  }
  const lab = new Int32Array(n), sizes = [0], stack = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (out[i] < 128 || lab[i]) continue;
    const id = sizes.length;
    let sp = 0, size = 0;
    stack[sp++] = i; lab[i] = id;
    while (sp) {
      const p = stack[--sp], x = p % w;
      size++;
      if (x > 0 && !lab[p - 1] && out[p - 1] >= 128) { lab[p - 1] = id; stack[sp++] = p - 1; }
      if (x < w - 1 && !lab[p + 1] && out[p + 1] >= 128) { lab[p + 1] = id; stack[sp++] = p + 1; }
      if (p >= w && !lab[p - w] && out[p - w] >= 128) { lab[p - w] = id; stack[sp++] = p - w; }
      if (p < n - w && !lab[p + w] && out[p + w] >= 128) { lab[p + w] = id; stack[sp++] = p + w; }
    }
    sizes.push(size);
  }
  if (sizes.length <= 2) return out;
  const big = Math.max(...sizes), keep = sizes.map(s => s >= Math.max(big * 0.06, n * 0.0004));
  const grid = new Float64Array(n);
  for (let i = 0; i < n; i++) grid[i] = lab[i] && keep[lab[i]] ? 0 : INF;
  edt(grid, w, h);
  const reach = Math.max(3, Math.round(Math.max(w, h) / 300)) ** 2;
  for (let i = 0; i < n; i++) {
    if (lab[i] && !keep[lab[i]]) out[i] = 0;
    else if (!lab[i] && grid[i] > reach) out[i] = 0;
  }
  return out;
}

const smooth = t => t * t * (3 - 2 * t);

// Separate pieces in a mask (things that don't touch), biggest first. Each kept
// pixel, soft edge included, goes to the piece it's connected to; pieces much
// smaller than the biggest one don't count. Returns { count, labels }.
export function pieces(mask, w, h, minFrac = 0.05) {
  const n = w * h, lab = new Int32Array(n), stack = new Int32Array(n), sizes = [0];
  for (let i = 0; i < n; i++) {
    if (mask[i] < 128 || lab[i]) continue;
    const id = sizes.length;
    let sp = 0, size = 0;
    stack[sp++] = i; lab[i] = id;
    while (sp) {
      const p = stack[--sp], x = p % w;
      size++;
      if (x > 0 && !lab[p - 1] && mask[p - 1] >= 128) { lab[p - 1] = id; stack[sp++] = p - 1; }
      if (x < w - 1 && !lab[p + 1] && mask[p + 1] >= 128) { lab[p + 1] = id; stack[sp++] = p + 1; }
      if (p >= w && !lab[p - w] && mask[p - w] >= 128) { lab[p - w] = id; stack[sp++] = p - w; }
      if (p < n - w && !lab[p + w] && mask[p + w] >= 128) { lab[p + w] = id; stack[sp++] = p + w; }
    }
    sizes.push(size);
  }
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

export function shapeMask(kind, w, h) {
  const c = canvas(w, h), g = c.getContext('2d');
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

// The finished sticker on a transparent canvas, trimmed to fit.
// img: ImageData of the working image. border: fraction of the subject's long side.
export function render({ img, mask, w, h, border = 0.035, color = '#ffffff', shadow = true, scale = 1 }) {
  const box = bbox(mask, w, h);
  if (!box) return null;
  const side = Math.max(box.w, box.h);
  const r = border * side, s = r * 0.55;
  const pad = Math.ceil(r + s + 3);
  // the region we work in, in image pixels, clamped to nothing (it may hang off the image)
  const rx = box.x - pad, ry = box.y - pad, rw = box.w + 2 * pad, rh = box.h + 2 * pad;

  // subject pixels and their alpha, in region coordinates
  const sub = new ImageData(rw, rh), sd = sub.data, src = img.data;
  const alpha = new Uint8Array(rw * rh);
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

  // the border shape: grow the subject by r + s, then shrink it back by s,
  // which rounds it off and fills the little gaps a die cutter would skip
  let shape = null;
  if (r >= 0.5) {
    const n = rw * rh, g = new Float64Array(n);
    for (let i = 0; i < n; i++) g[i] = alpha[i] >= 64 ? 0 : INF;
    edt(g, rw, rh);
    const grow = (r + s) * (r + s);
    for (let i = 0; i < n; i++) g[i] = g[i] <= grow ? INF : 0;
    edt(g, rw, rh);
    const [cr, cg, cb] = hex(color);
    shape = new ImageData(rw, rh);
    const bd = shape.data;
    for (let i = 0; i < n; i++) {
      const a = Math.round(Math.max(0, Math.min(1, Math.sqrt(g[i]) - s + 0.5)) * 255);
      const o = i * 4;
      bd[o] = cr; bd[o + 1] = cg; bd[o + 2] = cb; bd[o + 3] = a;
      // nothing of the photo outside the cut line (faint haze the model wasn't sure about)
      if (sd[o + 3] > a) sd[o + 3] = a;
    }
  }

  const sp = shadow ? Math.ceil(side * 0.035 + r * 0.4 + 4) : 0;
  const out = canvas((rw + 2 * sp) * scale, (rh + 2 * sp) * scale);
  const g = out.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.scale(scale, scale);
  // the shadow comes from the border shape, or from the subject when there's no border
  const base = toCanvas(shape || sub);
  if (shadow) {
    g.save();
    g.shadowColor = 'rgba(52, 36, 20, 0.30)';
    g.shadowBlur = (side * 0.018 + r * 0.25 + 2) * scale;
    g.shadowOffsetY = (side * 0.008 + r * 0.12 + 1) * scale;
    g.drawImage(base, sp, sp);
    g.restore();
  } else if (shape) {
    g.drawImage(base, sp, sp);
  }
  if (shape || !shadow) g.drawImage(toCanvas(sub), sp, sp);
  return out;
}

function toCanvas(data) {
  const c = canvas(data.width, data.height);
  c.getContext('2d').putImageData(data, 0, 0);
  return c;
}

function hex(c) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(c) || [0, 'ff', 'ff', 'ff'];
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}
