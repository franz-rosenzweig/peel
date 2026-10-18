// Photo looks: a few one-tap looks plus brightness, contrast and saturation.
// They change the photo inside the sticker, never the border or the text.

export const LOOKS = [
  { id: 'none', name: 'Original' },
  { id: 'vivid', name: 'Vivid', sat: 35, contrast: 12 },
  { id: 'pastel', name: 'Pastel', bright: 8, sat: -30, contrast: -22, lift: 22 },
  { id: 'vintage', name: 'Vintage', sepia: 45, contrast: -8, warm: 10, lift: 12 },
  { id: 'bw', name: 'B&W', sat: -100, contrast: 15 },
  { id: 'warm', name: 'Warm', warm: 16, sat: 8 },
  { id: 'cool', name: 'Cool', warm: -16, sat: 6 },
];

export const PLAIN = { look: 'none', bright: 0, contrast: 0, sat: 0 };

function params(fx) {
  const L = LOOKS.find(l => l.id === fx.look) || {};
  return {
    bright: (L.bright || 0) + (fx.bright || 0),
    contrast: (L.contrast || 0) + (fx.contrast || 0),
    sat: (L.sat || 0) + (fx.sat || 0),
    sepia: L.sepia || 0, warm: L.warm || 0, lift: L.lift || 0,
  };
}

export function applyFx(img, fx) {
  const p = params(fx || PLAIN);
  if (!p.bright && !p.contrast && !p.sat && !p.sepia && !p.warm && !p.lift) return img;
  // brightness, contrast, faded blacks and warmth are per channel: three lookup tables
  const lut = [new Uint8ClampedArray(256), new Uint8ClampedArray(256), new Uint8ClampedArray(256)];
  const c = 1 + p.contrast / 100, b = p.bright / 100 * 0.35, lift = p.lift / 100 * 0.3, warm = p.warm / 100 * 0.09;
  for (let v = 0; v < 256; v++) {
    let x = (v / 255 - 0.5) * c + 0.5 + b;
    x = lift + x * (1 - lift);
    lut[0][v] = (x + warm) * 255;
    lut[1][v] = (x + warm * 0.25) * 255;
    lut[2][v] = (x - warm) * 255;
  }
  const sat = 1 + p.sat / 100, sep = p.sepia / 100;
  const out = new ImageData(img.width, img.height), s = img.data, d = out.data;
  for (let i = 0; i < s.length; i += 4) {
    let r = s[i], g = s[i + 1], bl = s[i + 2];
    if (sat !== 1) {
      const l = 0.299 * r + 0.587 * g + 0.114 * bl;
      r = l + (r - l) * sat; g = l + (g - l) * sat; bl = l + (bl - l) * sat;
    }
    if (sep) {
      const sr = 0.393 * r + 0.769 * g + 0.189 * bl, sg = 0.349 * r + 0.686 * g + 0.168 * bl, sb = 0.272 * r + 0.534 * g + 0.131 * bl;
      r += (sr - r) * sep; g += (sg - g) * sep; bl += (sb - bl) * sep;
    }
    d[i] = lut[0][r < 0 ? 0 : r > 255 ? 255 : r | 0];
    d[i + 1] = lut[1][g < 0 ? 0 : g > 255 ? 255 : g | 0];
    d[i + 2] = lut[2][bl < 0 ? 0 : bl > 255 ? 255 : bl | 0];
    d[i + 3] = s[i + 3];
  }
  return out;
}
