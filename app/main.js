import * as S from './sticker.js';
import * as cut from './cutout.js';
import * as store from './store.js';

const $ = s => document.querySelector(s);
const MAX_ORIG = 2400;   // longest side we keep of the photo
const MAX_WORK = 1200;   // longest side we cut and paint at
const COLORS = ['#FFFFFF', '#FFF3D6', '#FFD1DC', '#FFE27A', '#BDEFD8', '#BFE3FF', '#D9C9FF', '#26232B'];
const touchy = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 1;

const st = {
  orig: null, hasAlpha: false, crop: null, name: 'sticker',
  work: null, img: null, W: 0, H: 0,
  kind: 'cut', mask: null, ai: new Map(), maskVer: 0,
  tool: null, brush: 4,
  border: 3.5, color: '#FFFFFF', shadow: true,
  undo: [], version: 0, keptVer: -1,
  blob: null, blobVer: -1, half: null,
  view: null, cursor: null, drag: null, stroke: null, subC: null, run: 0, pieces: null,
};

/* ---------- loading a photo ---------- */

async function loadBlob(blob, name = 'sticker') {
  let im;
  try { im = await decode(blob); } catch {
    toast("That file didn't open as a picture.");
    return;
  }
  const k = Math.min(1, MAX_ORIG / Math.max(im.width, im.height));
  const c = S.canvas(im.width * k, im.height * k);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(im, 0, 0, c.width, c.height);
  st.orig = c;
  st.hasAlpha = seeThrough(g.getImageData(0, 0, c.width, c.height).data);
  st.name = (name.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'sticker').slice(0, 40);
  st.crop = { x: 0, y: 0, w: c.width, h: c.height };
  st.ai.clear(); st.undo = []; st.kind = 'cut'; st.tool = null;
  showEditor();
  buildWork();
  await makeMask();
}

function decode(blob) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob), im = new Image();
    im.onload = () => { URL.revokeObjectURL(url); res(im); };
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('decode')); };
    im.src = url;
  });
}

// A picture that already has a see-through background (lifted in Photos, or a PNG cutout)
function seeThrough(d) {
  let clear = 0, n = 0;
  for (let i = 3; i < d.length; i += 16) { n++; if (d[i] < 250) clear++; }
  return clear / n > 0.02;
}

function buildWork() {
  const { x, y, w, h } = st.crop;
  const k = Math.min(1, MAX_WORK / Math.max(w, h));
  const W = Math.max(8, Math.round(w * k)), H = Math.max(8, Math.round(h * k));
  const c = S.canvas(W, H), g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(st.orig, x, y, w, h, 0, 0, W, H);
  st.work = c; st.img = g.getImageData(0, 0, W, H); st.W = W; st.H = H;
  st.subC = S.canvas(W, H);
}

const cropKey = () => Object.values(st.crop).map(Math.round).join(',');

async function makeMask() {
  const run = ++st.run;
  syncUI();
  if (st.kind !== 'cut') {
    busy(false);
    setMask(S.shapeMask(st.kind, st.W, st.H));
    return;
  }
  if (st.hasAlpha) {
    const m = new Uint8Array(st.W * st.H), d = st.img.data;
    for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3];
    busy(false);
    setMask(m);
    return;
  }
  const key = cropKey(), { work, W, H } = st;
  if (st.ai.has(key)) { busy(false); setMask(st.ai.get(key).slice()); return; }
  st.mask = null;
  draw();
  busy('Cutting it out…');
  try {
    await cut.ready();
    if (run !== st.run) return;
    busy('Cutting it out…');
    await frames(2);
    const m = S.cleanMatte(await cut.cutout(work, W, H), W, H);
    st.ai.set(key, m);
    if (run !== st.run) return;   // she moved on while it was cutting
    busy(false);
    setMask(m.slice());
    if (S.coverage(m) < 0.003) {
      toast("Couldn't find one clear thing in that photo. Try Pick the thing, or a shape.", 6000);
    }
  } catch (e) {
    console.error(e);
    if (run !== st.run) return;
    busyFail("The cutter couldn't run in this browser.",
      'You can still make a circle, heart or square sticker. Or lift the thing out in Photos, copy it and paste it here.');
  }
}

function setMask(m) {
  st.mask = m;
  st.maskVer++;
  syncSub();
  updatePieces();
  changed();
}

/* ---------- rendering ---------- */

let raf = 0, quick = false, idle = 0;
function changed(fast = false) {
  st.version++;
  quick = fast;
  draw();
  clearTimeout(idle);
  idle = setTimeout(prerender, fast ? 500 : 250);
}

function draw() {
  if (!raf) raf = requestAnimationFrame(paint);
}

function paint() {
  raf = 0;
  const v = $('#view'), box = v.getBoundingClientRect(), dpr = Math.min(3, devicePixelRatio || 1);
  const cw = Math.round(box.width * dpr), ch = Math.round(box.height * dpr);
  if (v.width !== cw || v.height !== ch) { v.width = cw; v.height = ch; }
  const g = v.getContext('2d');
  g.clearRect(0, 0, cw, ch);
  g.imageSmoothingQuality = 'high';
  if (!st.work) return;

  if (st.tool === 'crop') {
    const k = Math.min(cw * 0.94 / st.orig.width, ch * 0.86 / st.orig.height);
    const w = st.orig.width * k, h = st.orig.height * k, ox = (cw - w) / 2, oy = (ch - h) / 2 + ch * 0.04;
    st.view = { k: k / dpr, ox: ox / dpr, oy: oy / dpr, dpr };
    g.drawImage(st.orig, ox, oy, w, h);
    const r = st.drag ? rectOf(st.drag) : st.crop;
    const rx = ox + r.x * k, ry = oy + r.y * k, rw = r.w * k, rh = r.h * k;
    g.fillStyle = 'rgba(20, 14, 10, 0.5)';
    g.beginPath(); g.rect(ox, oy, w, h); g.rect(rx, ry, rw, rh); g.fill('evenodd');
    g.lineWidth = 2 * dpr; g.strokeStyle = '#fff'; g.setLineDash([8 * dpr, 6 * dpr]);
    g.strokeRect(rx, ry, rw, rh); g.setLineDash([]);
    if (st.kind === 'circle' || st.kind === 'heart') {
      g.save(); g.globalAlpha = 0.9; g.strokeStyle = '#fff'; g.lineWidth = 2 * dpr;
      const s = Math.min(rw, rh);
      g.beginPath(); g.arc(rx + rw / 2, ry + rh / 2, s * 0.49, 0, Math.PI * 2); g.stroke(); g.restore();
    }
    return;
  }

  if (st.tool === 'erase' || st.tool === 'restore') {
    const k = Math.min(cw * 0.94 / st.W, ch * 0.84 / st.H);
    const w = st.W * k, h = st.H * k, ox = (cw - w) / 2, oy = (ch - h) / 2 + ch * 0.05;
    st.view = { k: k / dpr, ox: ox / dpr, oy: oy / dpr, dpr };
    g.drawImage(st.work, ox, oy, w, h);
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--wash');
    g.fillRect(ox, oy, w, h);
    g.drawImage(st.subC, ox, oy, w, h);
    if (st.cursor) {
      const r = brushR() * k;
      g.lineWidth = 2 * dpr;
      g.strokeStyle = 'rgba(0,0,0,.55)';
      g.beginPath(); g.arc(ox + st.cursor.x * k, oy + st.cursor.y * k, r, 0, Math.PI * 2); g.stroke();
      g.strokeStyle = 'rgba(255,255,255,.95)'; g.lineWidth = 1 * dpr;
      g.beginPath(); g.arc(ox + st.cursor.x * k, oy + st.cursor.y * k, r - 1.5 * dpr, 0, Math.PI * 2); g.stroke();
    }
    return;
  }

  if (!st.mask) {
    // still cutting: show the photo softly behind the busy note
    const k = Math.min(cw * 0.9 / st.W, ch * 0.9 / st.H);
    g.globalAlpha = 0.5;
    g.drawImage(st.work, (cw - st.W * k) / 2, (ch - st.H * k) / 2, st.W * k, st.H * k);
    g.globalAlpha = 1;
    return;
  }
  const s = sticker(quick);
  if (!s) return;
  const big = quick ? 2 : 1;
  const k = Math.min(cw * 0.84 / (s.width * big), ch * 0.84 / (s.height * big), 2.5 * dpr) * big;
  g.drawImage(s, (cw - s.width * k) / 2, (ch - s.height * k) / 2, s.width * k, s.height * k);
}

// quick: a half-size version, for while a slider is moving
function sticker(fast) {
  const opts = { border: st.border / 100, color: st.color, shadow: st.shadow };
  if (!fast) return S.render({ img: st.img, mask: st.mask, w: st.W, h: st.H, ...opts });
  if (!st.half || st.half.ver !== st.maskVer) {
    const W = Math.ceil(st.W / 2), H = Math.ceil(st.H / 2), c = S.canvas(W, H), g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(st.work, 0, 0, W, H);
    const m = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const a = (2 * y) * st.W + 2 * x, b = Math.min(2 * y + 1, st.H - 1) * st.W + 2 * x, x1 = Math.min(2 * x + 1, st.W - 1) - 2 * x;
      m[y * W + x] = (st.mask[a] + st.mask[a + x1] + st.mask[b] + st.mask[b + x1] + 2) >> 2;
    }
    st.half = { ver: st.maskVer, img: g.getImageData(0, 0, W, H), mask: m, W, H };
  }
  const h = st.half;
  return S.render({ img: h.img, mask: h.mask, w: h.W, h: h.H, ...opts });
}

// keep a full-size PNG of the current sticker ready, so Save can hand it over at once
async function prerender() {
  if (!st.mask || st.tool || st.blobVer === st.version) return;
  const ver = st.version;
  const b = await stickerBlob();
  if (ver === st.version) { st.blob = b; st.blobVer = ver; }
  if (quick) { quick = false; draw(); }
}

function stickerBlob() {
  if (st.blobVer === st.version && st.blob) return Promise.resolve(st.blob);
  const c = sticker(false);
  return new Promise((res, rej) => c ? c.toBlob(b => b ? res(b) : rej(new Error('png')), 'image/png') : rej(new Error('empty')));
}

function syncSub(r) {
  if (!st.mask || !st.subC) return;
  const x = r ? r.x : 0, y = r ? r.y : 0, w = r ? r.w : st.W, h = r ? r.h : st.H;
  const out = new ImageData(w, h), d = out.data, src = st.img.data;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const p = (y + j) * st.W + x + i, o = (j * w + i) * 4;
      d[o] = src[p * 4]; d[o + 1] = src[p * 4 + 1]; d[o + 2] = src[p * 4 + 2]; d[o + 3] = st.mask[p];
    }
  }
  st.subC.getContext('2d').putImageData(out, x, y);
}

/* ---------- tools ---------- */

const brushR = () => st.brush / 100 * Math.max(st.W, st.H) * 0.5;

function toImg(e) {
  const b = $('#view').getBoundingClientRect(), v = st.view;
  return { x: (e.clientX - b.left - v.ox) / v.k, y: (e.clientY - b.top - v.oy) / v.k };
}

function rectOf(d) {
  let x0 = d.a.x, y0 = d.a.y, x1 = d.b.x, y1 = d.b.y;
  if (st.kind === 'circle' || st.kind === 'heart') {
    const s = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    x1 = x0 + Math.sign(x1 - x0 || 1) * s; y1 = y0 + Math.sign(y1 - y0 || 1) * s;
  }
  const W = st.orig.width, H = st.orig.height;
  const x = Math.max(0, Math.min(x0, x1)), y = Math.max(0, Math.min(y0, y1));
  return { x, y, w: Math.min(W, Math.max(x0, x1)) - x, h: Math.min(H, Math.max(y0, y1)) - y };
}

function setupPointer() {
  const v = $('#view');
  v.addEventListener('pointerdown', e => {
    if (!st.tool || !st.view || e.button > 0) return;
    e.preventDefault();
    v.setPointerCapture(e.pointerId);
    const p = toImg(e);
    if (st.tool === 'crop') { st.drag = { a: p, b: p }; draw(); return; }
    snapshot();
    st.stroke = p; st.cursor = p;
    dabAt(p, p);
  });
  v.addEventListener('pointermove', e => {
    if (!st.tool || !st.view) return;
    const p = toImg(e);
    if (st.tool === 'crop') {
      if (st.drag) { st.drag.b = p; draw(); }
      return;
    }
    st.cursor = p;
    if (st.stroke) {
      for (const ev of e.getCoalescedEvents?.() || [e]) {
        const q = toImg(ev);
        dabAt(st.stroke, q);
        st.stroke = q;
      }
    }
    draw();
  });
  const end = async e => {
    if (st.tool === 'crop' && st.drag) {
      const r = rectOf(st.drag);
      st.drag = null;
      const min = Math.max(st.orig.width, st.orig.height) * 0.03;
      if (r.w < min || r.h < min) { draw(); return; }
      snapshot();
      st.crop = r;
      setTool(null);
      buildWork();
      await makeMask();
      return;
    }
    if (st.stroke) {
      st.stroke = null;
      st.maskVer++;
      st.version++;
      updatePieces();
    }
    if (e.pointerType !== 'mouse') st.cursor = null;
    draw();
  };
  v.addEventListener('pointerup', end);
  v.addEventListener('pointercancel', end);
  v.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && !st.stroke) { st.cursor = null; draw(); } });
}

function dabAt(a, b) {
  const r = brushR(), val = st.tool === 'restore' ? 255 : 0;
  const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (r * 0.25)));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, d = S.dab(st.mask, st.W, st.H, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, r, val);
    if (d.w <= 0 || d.h <= 0) continue;
    x0 = Math.min(x0, d.x); y0 = Math.min(y0, d.y); x1 = Math.max(x1, d.x + d.w); y1 = Math.max(y1, d.y + d.h);
  }
  if (x1 > x0) syncSub({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  draw();
}

function snapshot() {
  st.undo.push({ crop: { ...st.crop }, kind: st.kind, mask: st.mask?.slice() });
  if (st.undo.length > 20) st.undo.shift();
  $('#undo').disabled = false;
}

async function undo() {
  const s = st.undo.pop();
  $('#undo').disabled = !st.undo.length;
  if (!s) return;
  const sameCrop = cropKey() === Object.values(s.crop).map(Math.round).join(',');
  st.crop = s.crop; st.kind = s.kind;
  if (!sameCrop) buildWork();
  if (s.mask && s.mask.length === st.W * st.H) { syncUI(); setMask(s.mask); } else await makeMask();
}

const HINTS = {
  erase: 'Paint over anything that shouldn’t be there.',
  restore: 'Paint over bits that went missing.',
  crop: 'Drag a box around the thing you want.',
};

function setTool(t) {
  if (t === st.tool) t = null;
  st.tool = t; st.cursor = null; st.drag = null; st.stroke = null;
  const stage = $('#stage');
  stage.classList.toggle('editing', t === 'erase' || t === 'restore');
  stage.classList.toggle('cropping', t === 'crop');
  $('#view').style.touchAction = t ? 'none' : '';
  $('#stagebar').hidden = !t;
  $('#hint').textContent = HINTS[t] || '';
  $('#whole').hidden = t !== 'crop';
  $('#brushRow').hidden = !(t === 'erase' || t === 'restore');
  for (const b of document.querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === t));
  showSplit();
  if (!t) changed();
  else draw();
}

async function setKind(k) {
  if (k === st.kind || !st.work) return;
  snapshot();
  st.kind = k;
  if (st.tool && st.tool !== 'crop') setTool(null);
  await makeMask();
}

function syncUI() {
  for (const b of document.querySelectorAll('[data-kind]')) b.setAttribute('aria-checked', String(b.dataset.kind === st.kind));
  const isCut = st.kind === 'cut';
  for (const b of document.querySelectorAll('.cutonly')) b.hidden = !isCut;
  $('.tools').classList.toggle('shapes', !isCut);
  $('#cropLabel').textContent = isCut ? 'Pick the thing' : 'Move it';
  HINTS.crop = isCut ? 'Drag a box around the thing you want.' : 'Drag a box over the part of the photo to use.';
  if (st.tool === 'crop') $('#hint').textContent = HINTS.crop;
}

/* ---------- busy note ---------- */

function busy(text, frac, sub = '') {
  const b = $('#busy');
  if (text === false) { b.hidden = true; return; }
  b.hidden = false; b.classList.remove('failed');
  $('#busyText').textContent = text;
  $('#busySub').textContent = sub;
  $('#barWrap').hidden = frac == null;
  if (frac != null) $('#bar').style.width = `${Math.round(frac * 100)}%`;
}

function busyFail(text, sub) {
  busy(text, null, sub);
  $('#busy').classList.add('failed');
  setTimeout(() => { busy(false); if (st.kind === 'cut' && !st.mask) setKind('rounded'); }, 5000);
}

cut.listen((got, total, phase) => {
  if ($('#editor').hidden || $('#busy').hidden && phase) return;
  if (phase === 'warming') busy('Getting the scissors ready…', 1, 'Almost there.');
  else busy('Getting the scissors ready…', got / total, `${(got / 1e6).toFixed(0)} of ${(total / 1e6).toFixed(0)} MB. This only happens the first time.`);
});

/* ---------- copy, save, keep ---------- */

function copySticker() {
  if (!st.mask) return;
  const p = stickerBlob();
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    toast("This browser won't copy pictures. Use Save instead.");
    return;
  }
  navigator.clipboard.write([new ClipboardItem({ 'image/png': p })]).then(async () => {
    toast('Copied! Now paste it into GoodNotes.');
    keep(await p, true);
  }, e => {
    console.warn(e);
    toast("Couldn't copy here. Use Save instead.");
  });
}

async function saveSticker() {
  if (!st.mask) return;
  const ready = st.blobVer === st.version && st.blob;
  const blob = ready || await stickerBlob();
  const file = new File([blob], `${st.name}-sticker.png`, { type: 'image/png' });
  await give([file]);
  keep(blob, true);
}

// share sheet on phones and tablets (Save Image, Save to Files, AirDrop…), a download elsewhere
async function give(files, zipName) {
  if (touchy && navigator.canShare?.({ files })) {
    try { await navigator.share({ files }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  if (files.length === 1) download(files[0], files[0].name);
  else download(await store.zip(files.map(f => ({ name: f.name, blob: f }))), zipName);
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

async function keep(blob, auto) {
  if (!st.mask) return;
  if (st.keptVer === st.version) {
    if (!auto) { toast('That one’s already in My stickers.'); nextPart(); }
    return;
  }
  st.keptVer = st.version;
  blob ??= await stickerBlob();
  const bmp = await createImageBitmap(blob).catch(() => null);
  await store.add({ id: newId(), made: Date.now(), name: st.name, blob, w: bmp?.width || 0, h: bmp?.height || 0 });
  await refreshTray();
  if (!auto) nextPart();
}

// After Keep, go straight to boxing the next part of the same photo.
function nextPart() {
  if (st.tool !== 'crop') setTool('crop');
  $('#hint').textContent = 'Kept! Now drag a box around the next part, or tap Done.';
}

/* ---------- split: one sticker per separate piece ---------- */

function updatePieces() {
  st.pieces = st.kind === 'cut' && st.mask ? S.pieces(st.mask, st.W, st.H) : null;
  showSplit();
}

function showSplit() {
  const n = st.pieces?.count || 0;
  $('#split').hidden = n < 2 || !!st.tool || !st.mask;
  $('#splitN').textContent = n;
}

async function splitKeep() {
  const p = st.pieces;
  if (!p || p.count < 2) return;
  const opts = { border: st.border / 100, color: st.color, shadow: st.shadow }, base = Date.now();
  for (let id = 1; id <= p.count; id++) {
    const c = S.render({ img: st.img, mask: S.piece(st.mask, p.labels, id), w: st.W, h: st.H, ...opts });
    if (!c) continue;
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    // the biggest piece first in My stickers
    await store.add({ id: newId(), made: base + p.count - id, name: `${st.name}-${id}`, blob, w: c.width, h: c.height });
  }
  st.keptVer = st.version;
  await refreshTray();
  toast(`Kept ${p.count} stickers, one for each piece. They’re in My stickers.`, 4500);
}

let urls = [];
async function refreshTray() {
  const items = await store.list();
  urls.forEach(u => URL.revokeObjectURL(u)); urls = [];
  const grid = $('#grid');
  grid.textContent = '';
  for (const it of items) {
    const tile = document.createElement('div');
    tile.className = 'tile';
    const img = new Image(), u = URL.createObjectURL(it.blob);
    urls.push(u);
    img.src = u; img.alt = 'A sticker'; img.loading = 'lazy';
    const acts = document.createElement('div');
    acts.className = 'acts';
    acts.append(
      act('i-copy', 'Copy', () => copyBlob(it.blob)),
      act('i-save', 'Save', () => give([new File([it.blob], `${it.name || 'peel'}-sticker.png`, { type: 'image/png' })])),
      act('i-trash', 'Delete', async () => { await store.remove(it.id); refreshTray(); }),
    );
    tile.append(img, acts);
    grid.append(tile);
  }
  $('#count').textContent = items.length ? `(${items.length})` : '';
  $('#saveAll').hidden = items.length < 2;
  $('#empty').hidden = !!items.length;
  return items;
}

function act(icon, label, fn) {
  const b = document.createElement('button');
  b.type = 'button'; b.title = label; b.setAttribute('aria-label', label);
  b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#${icon}"/></svg>`;
  b.addEventListener('click', fn);
  return b;
}

function copyBlob(blob) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') { toast("This browser won't copy pictures. Use Save instead."); return; }
  navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    .then(() => toast('Copied! Now paste it into GoodNotes.'), () => toast("Couldn't copy here. Use Save instead."));
}

async function saveAll() {
  const items = await store.list();
  const files = items.map((it, i) => new File([it.blob], `peel-${String(items.length - i).padStart(2, '0')}.png`, { type: 'image/png' }));
  give(files, 'peel-stickers.zip');
}

/* ---------- screens ---------- */

function showEditor() {
  $('#start').hidden = true;
  $('#editor').hidden = false;
  busy(false);
  setTool(null);
  $('#undo').disabled = true;
  requestAnimationFrame(() => $('#stage').scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
}

function showStart() {
  $('#editor').hidden = true;
  $('#start').hidden = false;
  st.work = null; st.mask = null; st.orig = null;
}

let toastT = 0;
function toast(text, ms = 3200) {
  const t = $('#toast');
  t.textContent = text; t.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('on'), ms);
}

const frames = n => new Promise(r => {
  const step = () => (n-- > 0 ? requestAnimationFrame(step) : setTimeout(r, 0));
  step();
});

/* ---------- wiring ---------- */

function borderName(v) {
  return v <= 0 ? 'None' : v < 2 ? 'Thin' : v < 4.5 ? 'Medium' : v < 6.5 ? 'Thick' : 'Chunky';
}

function setupColors() {
  const box = $('#colors');
  const pick = $('#pickColor');
  const mark = () => {
    for (const b of box.children) b.setAttribute('aria-checked', String(b.dataset.c === st.color));
  };
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.type = 'button'; b.setAttribute('role', 'radio'); b.dataset.c = c;
    b.style.background = c; b.setAttribute('aria-label', `Border color ${c}`);
    b.addEventListener('click', () => { st.color = c; mark(); changed(); });
    box.append(b);
  }
  const more = document.createElement('button');
  more.type = 'button'; more.className = 'more'; more.setAttribute('role', 'radio'); more.dataset.c = 'custom';
  more.setAttribute('aria-label', 'Pick any border color');
  more.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-plus"/></svg>';
  more.addEventListener('click', () => pick.click());
  pick.addEventListener('input', () => {
    st.color = pick.value.toUpperCase(); more.dataset.c = st.color; more.style.background = st.color; mark(); changed(true);
  });
  pick.addEventListener('change', () => changed());
  box.append(more);
  mark();
}

function setup() {
  setupColors();
  setupPointer();

  const file = $('#file');
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    if (f) loadBlob(f, f.name);
    file.value = '';
  });
  // start fetching the cutter while the photo picker is open
  $('#pickBtn').addEventListener('click', () => cut.ready().catch(() => {}));
  $('#again').addEventListener('click', () => { cut.ready().catch(() => {}); file.click(); });

  $('#paste').addEventListener('click', async () => {
    try {
      for (const it of await navigator.clipboard.read()) {
        const t = it.types.find(t => t.startsWith('image/'));
        if (t) { loadBlob(await it.getType(t), 'pasted'); return; }
      }
      toast('There’s no picture on the clipboard yet. Copy one first.');
    } catch {
      toast(touchy ? 'Tap and hold here, then choose Paste.' : 'Press ⌘V or Ctrl+V to paste.');
    }
  });
  document.addEventListener('paste', e => {
    const f = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith('image/'));
    if (f) { e.preventDefault(); loadBlob(f, 'pasted'); }
  });

  const drop = $('#drop');
  addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  addEventListener('dragleave', e => { if (!e.relatedTarget) drop.classList.remove('over'); });
  addEventListener('drop', e => {
    e.preventDefault(); drop.classList.remove('over');
    const f = [...(e.dataTransfer?.files || [])].find(f => f.type.startsWith('image/'));
    if (f) loadBlob(f, f.name);
  });

  for (const b of document.querySelectorAll('[data-kind]')) b.addEventListener('click', () => setKind(b.dataset.kind));
  for (const b of document.querySelectorAll('[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool));
  $('#doneFix').addEventListener('click', () => setTool(null));
  $('#whole').addEventListener('click', async () => {
    snapshot();
    st.crop = { x: 0, y: 0, w: st.orig.width, h: st.orig.height };
    setTool(null); buildWork(); await makeMask();
  });
  $('#undo').addEventListener('click', undo);

  const brush = $('#brush');
  brush.addEventListener('input', () => {
    st.brush = +brush.value;
    st.cursor = { x: st.W / 2, y: st.H / 2 };
    draw();
  });

  const border = $('#border');
  border.addEventListener('input', () => { st.border = +border.value; $('#borderVal').textContent = borderName(st.border); changed(true); });
  border.addEventListener('change', () => changed());
  $('#shadow').addEventListener('change', e => { st.shadow = e.target.checked; changed(); });

  $('#copy').addEventListener('click', copySticker);
  $('#save').addEventListener('click', saveSticker);
  $('#keep').addEventListener('click', () => keep(null, false));
  $('#split').addEventListener('click', splitKeep);
  $('#saveAll').addEventListener('click', saveAll);

  $('#help').addEventListener('click', () => $('#helpDlg').showModal());
  $('.brand').addEventListener('click', e => { if (!$('#editor').hidden) { e.preventDefault(); showStart(); } });

  addEventListener('keydown', e => {
    if (e.target.closest?.('input, textarea')) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z' && !$('#editor').hidden) { e.preventDefault(); undo(); }
    else if (mod && e.key.toLowerCase() === 'c' && !$('#editor').hidden && !String(getSelection())) { e.preventDefault(); copySticker(); }
    else if (e.key === 'Escape' && st.tool) setTool(null);
  });

  new ResizeObserver(() => draw()).observe($('#stage'));
  refreshTray();
  // warm up quietly if the cutter is already on this device
  cut.isCached().then(yes => { if (yes) setTimeout(() => cut.ready().catch(() => {}), 1200); });
}

setup();

// for checks from the console and the test walker
window.__peel = {
  st, loadBlob, setKind, setTool, undo, keep, splitKeep, list: store.list, sticker: () => sticker(false), which: cut.which,
  async loadURL(u, name) { const b = await (await fetch(u)).blob(); await loadBlob(b, name || 'test'); },
};
