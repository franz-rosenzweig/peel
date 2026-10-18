// From a "doc" (photo, mask and settings) to the finished sticker:
//   mask → edge tools → photo look → text → border/outline → turn/flip/shadow → size.
// Each step is cached on the doc, so moving one slider only redoes what it touches.
import * as S from './sticker.js';
import { applyFx } from './fx.js';
import { drawText, hasText } from './text.js';

export const SIZES = { S: 512, M: 1024, L: 4096 };
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
    // the letters go over the photo ("over" with straight alpha)
    for (let i = 0; i < w * h; i++) {
      const ta = td[i * 4 + 3];
      if (!ta) continue;
      const a = ta / 255, b = (mk[i] / 255) * (1 - a), oa = a + b, o = i * 4;
      od[o] = (td[o] * a + od[o] * b) / oa;
      od[o + 1] = (td[o + 1] * a + od[o + 1] * b) / oa;
      od[o + 2] = (td[o + 2] * a + od[o + 2] * b) / oa;
      mk[i] = Math.round(oa * 255);
    }
    lay = { img: out, mask: mk, w, h, ox: M, oy: M };
  }
  lay.img0 = img;
  c.lay = lay; c.layKey = key;
  return lay;
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

export function sticker(doc, { quick = false, size = null } = {}) {
  const L0 = layers(doc), L = quick ? halfOf(L0) : L0;
  const st = doc.style, plain = st.mode === 'cutout';
  const body = S.render({
    img: L.img, mask: L.mask, w: L.w, h: L.h,
    border: plain ? 0 : st.border / 100, color: st.color,
    outline: plain ? 'none' : st.outline, outlineColor: st.outlineColor,
  });
  if (!body) return null;
  const out = S.finish(body.canvas, { rotate: st.rotate, flip: st.flip, shadow: !plain && st.shadow, side: body.side, r: body.r });
  return size ? S.fit(out, SIZES[size] || SIZES.M) : out;
}

export const toBlob = (c, type = 'image/png', q) =>
  new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('encode'))), type, q));
