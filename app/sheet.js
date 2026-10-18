// Sticker sheets: My stickers laid out on pages, to print on sticker paper
// or to drop into GoodNotes as a page. PNG per page, or one PDF.

export const PAGES = {
  letter: { name: 'Letter', w: 2550, h: 3300, pt: [612, 792] },
  a4: { name: 'A4', w: 2480, h: 3508, pt: [595.28, 841.89] },
  ipad: { name: 'iPad page', w: 1536, h: 2048, pt: [768, 1024] },
  square: { name: 'Square', w: 2048, h: 2048, pt: [1024, 1024] },
};

// items: [{ w, h }]. size: a sticker's long side as a fraction of the page width.
// Returns pages, each a list of { i, x, y, w, h } in page pixels.
export function layout(items, page, size, gap) {
  const M = page.w * 0.05, G = page.w * gap, target = page.w * size;
  const pages = [];
  let cur = [], x = M, y = M, row = 0;
  items.forEach((it, i) => {
    const k = target / Math.max(it.w, it.h, 1);
    let w = it.w * k, h = it.h * k;
    const fit = Math.min(1, (page.w - 2 * M) / w, (page.h - 2 * M) / h);
    w *= fit; h *= fit;
    if (x + w > page.w - M && x > M) { x = M; y += row + G; row = 0; }
    if (y + h > page.h - M && cur.length) { pages.push(cur); cur = []; x = M; y = M; row = 0; }
    cur.push({ i, x, y, w, h });
    x += w + G; row = Math.max(row, h);
  });
  if (cur.length) pages.push(cur);
  return pages;
}

export function drawPage(placed, bitmaps, page, white, scale = 1) {
  const c = document.createElement('canvas');
  c.width = Math.round(page.w * scale); c.height = Math.round(page.h * scale);
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  if (white) { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); }
  for (const p of placed) g.drawImage(bitmaps[p.i], p.x * scale, p.y * scale, p.w * scale, p.h * scale);
  return c;
}

// A plain PDF: one full-page JPEG per page.
export async function pdf(canvases, page) {
  const enc = new TextEncoder(), parts = [], offsets = [];
  let size = 0;
  const put = x => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); size += b.length; };
  const obj = (n, body) => { offsets[n] = size; put(`${n} 0 obj\n`); body(); put('\nendobj\n'); };
  const [pw, ph] = page.pt, n = canvases.length;
  put('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const kids = canvases.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  obj(1, () => put('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => put(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`));
  for (let i = 0; i < n; i++) {
    const c = canvases[i], p = 3 + i * 3;
    const jpg = new Uint8Array(await (await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92))).arrayBuffer());
    const draw = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
    obj(p, () => put(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 ${p + 1} 0 R >> >> /Contents ${p + 2} 0 R >>`));
    obj(p + 1, () => {
      put(`<< /Type /XObject /Subtype /Image /Width ${c.width} /Height ${c.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`);
      put(jpg); put('\nendstream');
    });
    obj(p + 2, () => put(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`));
  }
  const xref = size, total = 3 + n * 3;
  put(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let i = 1; i < total; i++) put(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  put(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}
