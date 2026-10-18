// Words on a sticker. The text becomes part of the subject, so the border
// wraps around the letters like a lettering sticker.

export const FONTS = [
  { id: 'rounded', name: 'Rounded', family: '"Nunito"', weight: 900, line: 1.1 },
  { id: 'chunky', name: 'Chunky', family: '"Titan One"', weight: 400, line: 1.1 },
  { id: 'script', name: 'Script', family: '"Pacifico"', weight: 400, line: 1.35 },
  { id: 'hand', name: 'Handwritten', family: '"Caveat"', weight: 700, line: 1.05 },
  { id: 'serif', name: 'Serif', family: '"DM Serif Display"', weight: 400, line: 1.1 },
  { id: 'type', name: 'Typewriter', family: '"Special Elite"', weight: 400, line: 1.15 },
];

export const TEXT_COLORS = ['#2A2630', '#FFFFFF', '#E8505B', '#FF8FB1', '#F5A524', '#3BAA7A', '#3D8BFD', '#8B6CF6'];

export const hasText = t => !!(t && t.value && t.value.trim());
const fontOf = t => FONTS.find(f => f.id === t.font) || FONTS[0];
export const fontCss = (t, px) => `${fontOf(t).weight} ${px}px ${fontOf(t).family}, ui-rounded, sans-serif`;

export async function loadFonts() {
  await Promise.all(FONTS.map(f => document.fonts.load(`${f.weight} 64px ${f.family}`, 'Ag').catch(() => null)));
}

// t.size: letter height as a fraction of the work image's long side;
// t.x, t.y: the centre of the text, as fractions of the work image (it may sit outside it).
export function layout(g, t, W, H) {
  const px = Math.max(8, t.size * Math.max(W, H));
  g.save();
  g.font = fontCss(t, px);
  const lines = t.value.replace(/\s+$/, '').split('\n');
  const width = Math.max(...lines.map(l => g.measureText(l).width), px * 0.5);
  g.restore();
  const lh = px * fontOf(t).line;
  return { px, lines, lh, w: width, h: lh * lines.length, cx: t.x * W, cy: t.y * H };
}

// Draws into g, where work-image point (x, y) lands at (ox + x*k, oy + y*k).
export function drawText(g, t, W, H, k = 1, ox = 0, oy = 0) {
  if (!hasText(t)) return null;
  const L = layout(g, t, W, H);
  g.save();
  g.font = fontCss(t, L.px * k);
  g.fillStyle = t.color;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  L.lines.forEach((line, i) => g.fillText(line, ox + L.cx * k, oy + (L.cy - L.h / 2 + L.lh * (i + 0.5)) * k));
  g.restore();
  return { x: ox + (L.cx - L.w / 2) * k, y: oy + (L.cy - L.h / 2) * k, w: L.w * k, h: L.h * k };
}
