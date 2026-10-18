// From a "doc" (photo, mask and settings) to the finished sticker:
//   mask → edge tools → photo look → text → border/outline → turn/flip/shadow → size.
// Each step is cached on the doc, so moving one slider only redoes what it touches.
// Editing and the preview work at the working size (up to 1200 px). An export is made
// again from the full-size photo, around the subject only, so it comes out sharp.
import * as S from './sticker.js';
import { applyFx } from './fx.js';
import { drawText, hasText } from './text.js';

// long side of an export; Large is as big as the photo allows, up to 2400 px so it
// stays quick (and fits in memory) on an iPad
export const SIZES = { S: 512, M: 1024, L: 2400 };
const C = new WeakMap();
const cacheOf = doc => { let c = C.get(doc); if (!c) C.set(doc, (c = {})); return c; };

export function edgeMask(doc) {
  const c = cacheOf(doc), key = `${doc.maskVer}|${doc.mask?.length}|${doc.edge.grow}|${doc.edge.smooth}`;
  if (c.edgeKey !== key) {
    c.edge = S.refineEdge(doc.mask, doc.W, doc.H, doc.edge.grow, doc.edge.smooth);
    c.edgeKey = key;
  }
  return c.edge;
}

export function fxImage(doc) {
  const c = cacheOf(doc), key = JSON.stringify(doc.fx);
  if (c.fxKey !== key || c.fxSrc !== doc.img) {
    c.fx = applyFx(doc.img, doc.fx);
    c.fxKey = key; c.fxSrc = doc.img;
  }
  return c.fx;
}

// room around the photo for text that sits outside it
export const margin = doc => (hasText(doc.text) ? Math.round(0.45 * Math.max(doc.W, doc.H)) : 0);

// The photo (with its look) and the mask, with the text merged in.
export function layers(doc) {
  const c = cacheOf(doc), mask = edgeMask(doc), img = fxImage(doc);
  const key = `${c.edgeKey}|${c.fxKey}|${hasText(doc.text) ? JSON.stringify(doc.text) : ''}`;
  if (c.layKey === key && c.lay.img0 === img) return c.lay;
  let lay;
  if (!hasText(doc.text)) {
    lay = { img, mask, w: doc.W, h: doc.H, ox: 0, oy: 0 };
  } else {
    const M = margin(doc), W = doc.W, H = doc.H, w = W + 2 * M, h = H + 2 * M;
    const tc = S.canvas(w, h), tg = tc.getContext('2d', { willReadFrequently: true });
    drawText(tg, doc.text, W, H, 1, M, M);
    const td = tg.getImageData(0, 0, w, h).data;
    const out = new ImageData(w, h), od = out.data, mk = new Uint8Array(w * h), sd = img.data;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const si = y * W + x, di = (y + M) * w + x + M;
        od[di * 4] = sd[si * 4]; od[di * 4 + 1] = sd[si * 4 + 1]; od[di * 4 + 2] = sd[si * 4 + 2];
        od[di * 4 + 3] = 255; mk[di] = mask[si];
      }
    }
    over(od, mk, td);
    lay = { img: out, mask: mk, w, h, ox: M, oy: M };
  }
  lay.img0 = img;
  c.lay = lay; c.layKey = key;
  return lay;
}

// the letters go over the photo ("over" with straight alpha), in place
function over(od, mk, td) {
  for (let i = 0; i < mk.length; i++) {
    const ta = td[i * 4 + 3];
    if (!ta) continue;
    const a = ta / 255, b = (mk[i] / 255) * (1 - a), oa = a + b, o = i * 4;
    od[o] = (td[o] * a + od[o] * b) / oa;
    od[o + 1] = (td[o + 1] * a + od[o + 1] * b) / oa;
    od[o + 2] = (td[o + 2] * a + od[o + 2] * b) / oa;
    mk[i] = Math.round(oa * 255);
  }
}

// The same layers k times bigger, but only around the subject: the photo straight
// from doc.orig (with its look), the mask (edge tools and all) made bigger smoothly,
// and the text drawn again at the new size.
function bigLayers(doc, k) {
  const c = cacheOf(doc), L = layers(doc);
  if (c.big?.from === L && c.big.k === k) return c.big;
  const box = S.bbox(L.mask, L.w, L.h);   // the same subject box render() goes by
  if (!box) return null;
  const { crop, W, H } = doc, kx = crop.w / W, ky = crop.h / H, f = k / kx, m = 3;
  // the part we need in photo pixels, with the soft edge just outside the box, starting
  // on a whole pixel so that at full size the photo is copied as it is
  const gx = Math.floor(crop.x + (box.x - L.ox - m) * kx), gy = Math.floor(crop.y + (box.y - L.oy - m) * ky);
  const w = Math.ceil((crop.x + (box.x + box.w - L.ox + m) * kx - gx) * f);
  const h = Math.ceil((crop.y + (box.y + box.h - L.oy + m) * ky - gy) * f);

  let img = new ImageData(w, h);
  if (!doc.textOnly) {
    // only from the part of the photo that was picked
    const pc = S.canvas(w, h), pg = pc.getContext('2d', { willReadFrequently: true });
    const x0 = Math.max(gx, Math.floor(crop.x)), y0 = Math.max(gy, Math.floor(crop.y));
    const x1 = Math.min(gx + w / f, Math.ceil(crop.x + crop.w)), y1 = Math.min(gy + h / f, Math.ceil(crop.y + crop.h));
    if (x1 > x0 && y1 > y0) {
      pg.imageSmoothingQuality = 'high';
      pg.drawImage(doc.orig, x0, y0, x1 - x0, y1 - y0, (x0 - gx) * f, (y0 - gy) * f, (x1 - x0) * f, (y1 - y0) * f);
    }
    img = applyFx(pg.getImageData(0, 0, w, h), doc.fx);
    S.free(pc);
  }

  const mask = doc.textOnly ? new Uint8Array(w * h)
    : S.upscale(edgeMask(doc), W, H, w, h, (gx - crop.x) / kx, (gy - crop.y) / ky, 1 / (f * kx), 1 / (f * ky));
  if (doc.hasAlpha && doc.kind === 'cut' && !doc.textOnly) {
    // a picture that came with a see-through background keeps its own crisp edge
    const d = img.data;
    for (let i = 0; i < mask.length; i++) if (d[i * 4 + 3] < mask[i]) mask[i] = d[i * 4 + 3];
  }
  if (hasText(doc.text)) {
    const tc = S.canvas(w, h), tg = tc.getContext('2d', { willReadFrequently: true });
    drawText(tg, doc.text, W, H, k, (crop.x - gx) * f, (crop.y - gy) * f);
    over(img.data, mask, tg.getImageData(0, 0, w, h).data);
    S.free(tc);
  }
  c.big = { img, mask, w, h, from: L, k };
  return c.big;
}

// half size, for live previews while a slider moves
function halfOf(L) {
  if (L.half) return L.half;
  const W = Math.ceil(L.w / 2), H = Math.ceil(L.h / 2);
  const src = S.toCanvas(L.img), c = S.canvas(W, H), g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(src, 0, 0, W, H);
  const m = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const a = 2 * y * L.w + 2 * x, b = Math.min(2 * y + 1, L.h - 1) * L.w + 2 * x, x1 = Math.min(2 * x + 1, L.w - 1) - 2 * x;
      m[y * W + x] = (L.mask[a] + L.mask[a + x1] + L.mask[b] + L.mask[b + x1] + 2) >> 2;
    }
  }
  L.half = { img: g.getImageData(0, 0, W, H), mask: m, w: W, h: H };
  return L.half;
}

// The sticker at the working size, or at half that while a slider moves. With a
// size (S, M or L) it's the PNG to hand over instead, as exported() makes it.
export function sticker(doc, { quick = false, size = null } = {}) {
  const L0 = layers(doc), out = finished(doc, quick ? halfOf(L0) : L0);
  if (!size || !out) return out;
  const png = exported(doc, out, size);
  if (png !== out) S.free(out);
  return png;
}

// border/outline, then turn/flip/shadow; px is output pixels per working pixel
function finished(doc, L, px = 1) {
  const st = doc.style, plain = st.mode === 'cutout';
  const body = S.render({
    img: L.img, mask: L.mask, w: L.w, h: L.h, px,
    border: plain ? 0 : st.border / 100, color: st.color,
    outline: plain ? 'none' : st.outline, outlineColor: st.outlineColor,
  });
  if (!body) return null;
  const out = S.finish(body.canvas, { rotate: st.rotate, flip: st.flip, shadow: !plain && st.shadow, side: body.side, r: body.r, px });
  S.free(body.canvas);
  return out;
}

// The PNG for Small, Medium or Large. base is the sticker at the working size. When the
// photo has more pixels than that, the sticker is made again from the photo itself, as
// big as the size wants (or the photo allows), and looks the same, only sharper.
export function exported(doc, base, size) {
  const want = SIZES[size] || SIZES.M, long = Math.max(base.width, base.height);
  const k = Math.min(want / long * 1.02, native(doc));
  const L = k > 1.05 && bigLayers(doc, k), big = L ? finished(doc, L, k) : null;
  const out = S.fit(big || base, want);
  if (big && out !== big) S.free(big);
  return out;
}

// photo pixels per working pixel (text on its own can be drawn at any size)
const native = doc => (doc.textOnly ? Infinity : Math.min(doc.crop.w / doc.W, doc.crop.h / doc.H));

export const toBlob = (c, type = 'image/png', q) =>
  new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('encode'))), type, q));
