import * as S from './sticker.js';
import * as C from './compose.js';
import * as cut from './cutout.js';
import * as store from './store.js';
import { LOOKS, PLAIN } from './fx.js';
import { FONTS, TEXT_COLORS, hasText, drawText, loadFonts } from './text.js';
import { PAGES, layout as sheetLayout, drawPage, pdf } from './sheet.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const MAX_ORIG = 2400;   // longest side we keep of the photo
const MAX_WORK = 1200;   // longest side we cut and paint at
const COLORS = ['#FFFFFF', '#FFF3D6', '#FFD1DC', '#FFE27A', '#BDEFD8', '#BFE3FF', '#D9C9FF', '#26232B'];
const LINE_COLORS = ['#2A2630', '#FFFFFF', '#E8505B', '#FF8FB1', '#F5A524', '#3BAA7A', '#3D8BFD', '#8B6CF6'];
const BRUSHES = new Set(['erase', 'restore']);
const EDITS = new Set(['erase', 'restore', 'wand', 'tap', 'text']);
const CUT_TOOLS = new Set(['erase', 'restore', 'wand', 'tap', 'crop']);
const touchy = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 1;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const DEFAULT_STYLE = { mode: 'sticker', border: 3.5, color: '#FFFFFF', outline: 'none', outlineColor: '#2A2630', shadow: true, rotate: 0, flip: false };
const prefs = { style: { ...DEFAULT_STYLE }, size: 'M', bg: 'paper', tol: 30, connected: true, brush: 4, ...readPrefs() };
function readPrefs() { try { return JSON.parse(localStorage.getItem('peel-prefs')) || {}; } catch { return {}; } }
let prefT = 0;
function savePrefs() {
  clearTimeout(prefT);
  prefT = setTimeout(() => { try { localStorage.setItem('peel-prefs', JSON.stringify(prefs)); } catch {} }, 300);
}

const st = {
  doc: null, tab: 'cut',
  tool: null, view: null, zoom: { z: 1, cx: null, cy: null },
  cursor: null, drag: null, stroke: null, textDrag: null, down: null,
  pointers: new Map(), gesture: null, gestureLock: false,
  undo: [], redo: [],
  version: 0, keptVer: -1, blob: null, blobKey: '', blobDims: null, full: null,
  pieces: null, run: 0, subC: null, bgBefore: null, batchStop: false, sheet: null,
};

/* ---------- docs: a photo, its mask and its settings ---------- */

function newDoc(orig, { name = 'sticker', hasAlpha = false, textOnly = false } = {}) {
  return {
    name, orig, hasAlpha, textOnly,
    crop: { x: 0, y: 0, w: orig.width, h: orig.height },
    work: null, img: null, W: 0, H: 0,
    kind: 'cut', mask: null, maskVer: 0, ai: new Map(),
    edge: { grow: 0, smooth: 0 },
    fx: { ...PLAIN },
    text: { value: '', font: 'rounded', color: '#2A2630', size: 0.1, x: 0.5, y: 0.88 },
    style: { ...DEFAULT_STYLE, ...prefs.style, rotate: 0, flip: false },
  };
}

function buildWork(doc) {
  const { x, y, w, h } = doc.crop;
  const k = Math.min(1, MAX_WORK / Math.max(w, h));
  const W = Math.max(8, Math.round(w * k)), H = Math.max(8, Math.round(h * k));
  const c = S.canvas(W, H), g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(doc.orig, x, y, w, h, 0, 0, W, H);
  doc.work = c; doc.img = g.getImageData(0, 0, W, H); doc.W = W; doc.H = H;
  if (doc === st.doc) st.subC = S.canvas(W, H);
}

const keyOf = r => [r.x, r.y, r.w, r.h].map(Math.round).join(',');
const cropKey = doc => keyOf(doc.crop);

// the mask when no cutting is needed (a shape, a lifted picture, text), else null
function quickMask(doc) {
  if (doc.textOnly) return new Uint8Array(doc.W * doc.H);
  if (doc.kind !== 'cut') return S.shapeMask(doc.kind, doc.W, doc.H);
  if (doc.hasAlpha) {
    const m = new Uint8Array(doc.W * doc.H), d = doc.img.data;
    for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3];
    return m;
  }
  const hit = doc.ai.get(cropKey(doc));
  return hit ? hit.slice() : null;
}

async function aiMask(doc) {
  const key = cropKey(doc);
  if (!doc.ai.has(key)) doc.ai.set(key, S.cleanMatte(await cut.cutout(doc.work, doc.W, doc.H), doc.W, doc.H));
  return doc.ai.get(key).slice();
}

async function makeMask() {
  const doc = st.doc, run = ++st.run;
  syncUI();
  const quick = quickMask(doc);
  if (quick) { busy(false); setMask(quick); return; }
  doc.mask = null;
  draw();
  busy('Cutting it out…');
  try {
    await cut.ready();
    if (run !== st.run) return;
    busy('Cutting it out…');
    await frames(2);
    const m = await aiMask(doc);
    if (run !== st.run || doc !== st.doc) return;   // she moved on while it was cutting
    busy(false);
    setMask(m);
    if (S.coverage(m) < 0.003) toast("Couldn't find one clear thing in that photo. Try Pick the thing, or a shape.", 6000);
  } catch (e) {
    console.error(e);
    if (run !== st.run) return;
    busyFail("The cutter couldn't run in this browser.",
      'You can still make a circle, heart or square sticker. Or lift the thing out in Photos, copy it and paste it here.');
  }
}

function setMask(m) {
  st.doc.mask = m;
  maskChanged();
}

function maskChanged() {
  st.doc.maskVer++;
  syncSub();
  updatePieces();
  changed();
}

/* ---------- loading ---------- */

function decode(blob) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob), im = new Image();
    im.onload = () => { URL.revokeObjectURL(url); res(im); };
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('decode')); };
    im.src = url;
  });
}

async function loadCanvas(blob) {
  const im = await decode(blob);
  const k = Math.min(1, MAX_ORIG / Math.max(im.width, im.height));
  const c = S.canvas(im.width * k, im.height * k);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(im, 0, 0, c.width, c.height);
  return { canvas: c, hasAlpha: seeThrough(g.getImageData(0, 0, c.width, c.height).data) };
}

// a picture that already has a see-through background (lifted in Photos, or a PNG cutout)
function seeThrough(d) {
  let clear = 0, n = 0;
  for (let i = 3; i < d.length; i += 16) { n++; if (d[i] < 250) clear++; }
  return clear / n > 0.02;
}

const cleanName = name => (String(name).replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'sticker').slice(0, 40);

async function loadBlob(blob, name = 'sticker', { remember = true, recentId = null } = {}) {
  let r;
  try { r = await loadCanvas(blob); } catch {
    toast("That file didn't open as a picture.");
    return;
  }
  const doc = newDoc(r.canvas, { name: cleanName(name), hasAlpha: r.hasAlpha });
  buildWork(doc);
  openDoc(doc);
  const cutting = makeMask();
  if (remember) rememberPhoto(r.canvas, r.hasAlpha, doc.name, recentId);
  await cutting;
}

function loadFiles(files) {
  const pics = [...files].filter(f => f.type.startsWith('image/') || /\.(heic|heif|jpe?g|png|webp|gif)$/i.test(f.name));
  if (!pics.length) return;
  if (pics.length === 1) loadBlob(pics[0], pics[0].name);
  else batch(pics);
}

function openDoc(doc) {
  st.doc = doc;
  st.undo = []; st.redo = [];
  st.keptVer = -1; st.blob = null; st.blobKey = '';
  st.subC = S.canvas(doc.W, doc.H);
  showEditor();
  syncUI();
}

function startText() {
  const doc = newDoc(S.canvas(1200, 700), { name: 'text', hasAlpha: true, textOnly: true });
  doc.text = { value: '', font: 'chunky', color: '#E8505B', size: 0.16, x: 0.5, y: 0.5 };
  buildWork(doc);
  openDoc(doc);
  setMask(new Uint8Array(doc.W * doc.H));
  setTab('text');
  setTimeout(() => $('#textValue').focus(), 50);
}

/* ---------- drawing the stage ---------- */

let raf = 0, quick = false, idle = 0;
function changed(fast = false) {
  st.version++;
  quick = fast;
  draw();
  clearTimeout(idle);
  idle = setTimeout(prerender, fast ? 450 : 200);
}

function draw() {
  if (!raf) raf = requestAnimationFrame(paint);
}

function paint() {
  raf = 0;
  const v = $('#view'), box = v.getBoundingClientRect(), dpr = Math.min(3, devicePixelRatio || 1);
  const cw = Math.round(box.width * dpr), ch = Math.round(box.height * dpr);
  if (!cw || !ch) return;
  if (v.width !== cw || v.height !== ch) { v.width = cw; v.height = ch; }
  const g = v.getContext('2d');
  g.clearRect(0, 0, cw, ch);
  g.imageSmoothingQuality = 'high';
  const doc = st.doc;
  if (!doc?.work) return;
  if (st.tool === 'crop') return paintCrop(g, cw, ch, dpr);
  if (EDITS.has(st.tool)) return paintEdit(g, cw, ch, dpr);

  if (!doc.mask) {
    // still cutting: the photo, softly, behind the busy note
    const k = Math.min(cw * 0.9 / doc.W, ch * 0.9 / doc.H);
    g.globalAlpha = 0.5;
    g.drawImage(doc.work, (cw - doc.W * k) / 2, (ch - doc.H * k) / 2, doc.W * k, doc.H * k);
    g.globalAlpha = 1;
    return;
  }
  const s = C.sticker(doc, { quick });
  if (!quick && s) st.full = { v: st.version, c: s };
  if (!s) {
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--muted');
    g.font = `700 ${18 * dpr}px ui-rounded, Nunito, sans-serif`;
    g.textAlign = 'center';
    g.fillText(doc.textOnly ? 'Type something under Text.' : 'Nothing left. Undo, or Bring back.', cw / 2, ch / 2);
    return;
  }
  const big = quick ? 2 : 1;
  const k = Math.min(cw * 0.84 / (s.width * big), ch * 0.8 / (s.height * big), 2.5 * dpr) * big;
  g.drawImage(s, (cw - s.width * k) / 2, (ch - s.height * k) / 2 - ch * 0.02, s.width * k, s.height * k);
}

function paintCrop(g, cw, ch, dpr) {
  const doc = st.doc, o = doc.orig, top = 58 * dpr;
  const k = Math.min(cw * 0.94 / o.width, (ch - top - 12 * dpr) / o.height);
  const w = o.width * k, h = o.height * k, ox = (cw - w) / 2, oy = top + (ch - top - h) / 2;
  st.view = { k: k / dpr, ox: ox / dpr, oy: oy / dpr };
  g.drawImage(o, ox, oy, w, h);
  const r = st.drag ? rectOf(st.drag) : doc.crop;
  const rx = ox + r.x * k, ry = oy + r.y * k, rw = r.w * k, rh = r.h * k;
  g.fillStyle = 'rgba(20, 14, 10, 0.5)';
  g.beginPath(); g.rect(ox, oy, w, h); g.rect(rx, ry, rw, rh); g.fill('evenodd');
  g.lineWidth = 2 * dpr; g.strokeStyle = '#fff'; g.setLineDash([8 * dpr, 6 * dpr]);
  g.strokeRect(rx, ry, rw, rh); g.setLineDash([]);
  if (doc.kind === 'circle' || doc.kind === 'heart') {
    g.save(); g.globalAlpha = 0.9; g.strokeStyle = '#fff'; g.lineWidth = 2 * dpr;
    g.beginPath(); g.arc(rx + rw / 2, ry + rh / 2, Math.min(rw, rh) * 0.49, 0, Math.PI * 2); g.stroke(); g.restore();
  }
}

const textMargin = doc => Math.round(0.3 * Math.max(doc.W, doc.H));

// erase, bring back, wand, remove piece and moving text all work on the photo itself, zoomable
function paintEdit(g, cw, ch, dpr) {
  const doc = st.doc, M = st.tool === 'text' ? textMargin(doc) : 0;
  const { k, ox, oy } = viewFor(cw, ch, dpr, doc.W + 2 * M, doc.H + 2 * M, M);
  const px = ox + M * k, py = oy + M * k;
  g.drawImage(doc.work, px, py, doc.W * k, doc.H * k);
  g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--wash');
  g.fillRect(px, py, doc.W * k, doc.H * k);
  g.drawImage(st.subC, px, py, doc.W * k, doc.H * k);
  if (st.tool === 'text') {
    const b = drawText(g, doc.text, doc.W, doc.H, k, px, py);
    if (b) {
      g.save();
      g.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent');
      g.lineWidth = 2 * dpr; g.setLineDash([6 * dpr, 5 * dpr]);
      g.strokeRect(b.x - 8 * dpr, b.y - 6 * dpr, b.w + 16 * dpr, b.h + 12 * dpr);
      g.restore();
    }
  }
  if (BRUSHES.has(st.tool) && st.cursor) {
    const r = brushR() * k, cx = ox + st.cursor.x * k, cy = oy + st.cursor.y * k;
    g.lineWidth = 2 * dpr; g.strokeStyle = 'rgba(0,0,0,.55)';
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,.95)'; g.lineWidth = dpr;
    g.beginPath(); g.arc(cx, cy, Math.max(1, r - 1.5 * dpr), 0, Math.PI * 2); g.stroke();
  }
}

// fit the picture into the stage, then apply the zoom; everything in st.view is in CSS pixels
function viewFor(cw, ch, dpr, dw, dh, M = 0) {
  const top = 58 * dpr, bottom = 52 * dpr, avail = ch - top - bottom;
  const k0 = Math.min(cw * 0.94 / dw, avail * 0.98 / dh), z = st.zoom.z, k = k0 * z;
  const cx = st.zoom.cx ?? dw / 2, cy = st.zoom.cy ?? dh / 2;
  const mx = cw / 2, my = top + avail / 2;
  const ox = mx - cx * k, oy = my - cy * k;
  st.view = { k: k / dpr, k0: k0 / dpr, ox: ox / dpr, oy: oy / dpr, mx: mx / dpr, my: my / dpr, dw, dh, M };
  return { k, ox, oy };
}

/* ---------- export: copy, save, keep ---------- */

const exportKey = () => `${st.version}|${prefs.size}`;

function stickerBlob() {
  if (st.blob && st.blobKey === exportKey()) return Promise.resolve(st.blob);
  // the preview already rendered it full size; Save just scales that
  const key = exportKey(), base = st.full?.v === st.version ? st.full.c : st.doc?.mask ? C.sticker(st.doc) : null;
  const c = base && S.fit(base, C.SIZES[prefs.size]);
  if (!c) return Promise.reject(new Error('empty'));
  return C.toBlob(c).then(b => {
    if (key === exportKey()) { st.blob = b; st.blobKey = key; st.blobDims = [c.width, c.height]; showSize(); }
    return b;
  });
}

// keep a PNG of the current sticker ready, so Save can hand it over at once
async function prerender() {
  if (!st.doc?.mask || st.tool) return;
  try { await stickerBlob(); } catch { st.blobDims = null; showSize(); }
  if (quick) { quick = false; draw(); }
}

function showSize() {
  $('#sizeHint').textContent = st.blobDims ? `${st.blobDims[0]} × ${st.blobDims[1]} px` : '';
}

function copySticker() {
  if (!st.doc?.mask) return;
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    toast("This browser won't copy pictures. Use Save instead.");
    return;
  }
  const p = stickerBlob();
  navigator.clipboard.write([new ClipboardItem({ 'image/png': p })]).then(async () => {
    toast('Copied! Now paste it into GoodNotes.');
    keep(await p, true);
  }, e => {
    console.warn(e);
    toast(String(e?.message).includes('empty') ? 'There’s nothing to copy yet.' : "Couldn't copy here. Use Save instead.");
  });
}

async function saveSticker() {
  if (!st.doc?.mask) return;
  let blob;
  try { blob = await stickerBlob(); } catch { toast('There’s nothing to save yet.'); return; }
  const plain = st.doc.style.mode === 'cutout';
  await give([new File([blob], `${st.doc.name}-${plain ? 'cutout' : 'sticker'}.png`, { type: 'image/png' })]);
  keep(blob, true);
}

// share sheet on phones and tablets (Save Image, Save to Files, AirDrop…), a download elsewhere
async function give(files, zipName = 'peel.zip') {
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

// what it takes to open a kept sticker again: the photo as cut, the mask and the settings
async function projectOf(doc, mask = doc.mask) {
  try {
    const src = await C.toBlob(doc.work, doc.hasAlpha || doc.textOnly ? 'image/png' : 'image/jpeg', 0.9);
    const id = new ImageData(doc.W, doc.H), d = id.data;
    for (let i = 0; i < mask.length; i++) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = mask[i]; d[i * 4 + 3] = 255; }
    const mb = await C.toBlob(S.toCanvas(id));
    return {
      v: 1, src, mask: mb, W: doc.W, H: doc.H, kind: doc.kind, hasAlpha: doc.hasAlpha, textOnly: doc.textOnly,
      edge: { ...doc.edge }, fx: { ...doc.fx }, text: { ...doc.text }, style: { ...doc.style },
    };
  } catch (e) { console.warn('peel: project', e); return null; }
}

async function storeSticker(doc, blob, { mask = doc.mask, made = Date.now(), name = doc.name } = {}) {
  const bmp = await createImageBitmap(blob).catch(() => null);
  await store.add({ id: newId(), made, name, blob, w: bmp?.width || 0, h: bmp?.height || 0, project: await projectOf(doc, mask) });
}

async function keep(blob, auto) {
  const doc = st.doc;
  if (!doc?.mask) return;
  if (st.keptVer === st.version) {
    if (!auto) { toast('That one’s already in My stickers.'); nextPart(); }
    return;
  }
  try { blob ??= await stickerBlob(); } catch { if (!auto) toast('There’s nothing to keep yet.'); return; }
  st.keptVer = st.version;
  await storeSticker(doc, blob);
  await refreshTray();
  if (!auto) nextPart();
}

// After Keep, go straight to boxing the next part of the same photo.
function nextPart() {
  if (st.doc.textOnly) { toast('Kept. It’s in My stickers.'); return; }
  setTab('cut');
  if (st.tool !== 'crop') setTool('crop');
  $('#hint').textContent = 'Kept! Now drag a box around the next part, or tap Done.';
}

/* ---------- split: one sticker per separate piece ---------- */

function updatePieces() {
  const d = st.doc;
  st.pieces = d?.mask && d.kind === 'cut' && !d.textOnly && !hasText(d.text) ? S.pieces(C.edgeMask(d), d.W, d.H) : null;
  showSplit();
}

function showSplit() {
  const n = st.pieces?.count || 0;
  $('#split').hidden = n < 2 || !!st.tool || !st.doc?.mask;
  $('#splitN').textContent = n;
}

async function splitKeep() {
  const doc = st.doc, p = st.pieces;
  if (!p || p.count < 2) return;
  const base = Date.now();
  for (let id = 1; id <= p.count; id++) {
    const part = { ...doc, mask: S.piece(doc.mask, p.labels, id), maskVer: doc.maskVer * 100 + id };
    const c = C.sticker(part, { size: prefs.size });
    if (!c) continue;
    // the biggest piece first in My stickers
    await storeSticker(part, await C.toBlob(c), { made: base + p.count - id, name: `${doc.name}-${id}` });
  }
  st.keptVer = st.version;
  await refreshTray();
  toast(`Kept ${p.count} stickers, one for each piece. They’re in My stickers.`, 4500);
}

/* ---------- pointer: brushes, wand, pieces, boxes, text, pinch ---------- */

const brushR = () => prefs.brush / 100 * Math.max(st.doc.W, st.doc.H) * 0.5;

function local(e) {
  const b = $('#view').getBoundingClientRect();
  return { x: e.clientX - b.left, y: e.clientY - b.top };
}

function toImg(e) {
  const l = local(e), v = st.view;
  return { x: (l.x - v.ox) / v.k, y: (l.y - v.oy) / v.k };
}

function rectOf(d) {
  const doc = st.doc;
  let x0 = d.a.x, y0 = d.a.y, x1 = d.b.x, y1 = d.b.y;
  if (doc.kind === 'circle' || doc.kind === 'heart') {
    const s = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    x1 = x0 + Math.sign(x1 - x0 || 1) * s; y1 = y0 + Math.sign(y1 - y0 || 1) * s;
  }
  const W = doc.orig.width, H = doc.orig.height;
  const x = Math.max(0, Math.min(x0, x1)), y = Math.max(0, Math.min(y0, y1));
  return { x, y, w: Math.min(W, Math.max(x0, x1)) - x, h: Math.min(H, Math.max(y0, y1)) - y };
}

function setupPointer() {
  const v = $('#view');
  v.addEventListener('pointerdown', e => {
    if (!st.tool || !st.view) return;
    if (e.pointerType === 'mouse' && e.button > 0) return;
    e.preventDefault();
    v.setPointerCapture(e.pointerId);
    st.pointers.set(e.pointerId, local(e));
    if (st.pointers.size === 2 && EDITS.has(st.tool)) { startGesture(); return; }
    if (st.pointers.size > 1 || st.gestureLock) return;
    const p = toImg(e);
    st.down = { p, l: local(e), moved: false };
    if (st.tool === 'crop') st.drag = { a: p, b: p };
    else if (BRUSHES.has(st.tool)) { snapshot(); st.stroke = p; st.cursor = p; dabAt(p, p); }
    else if (st.tool === 'text') st.textDrag = { p0: p, x0: st.doc.text.x, y0: st.doc.text.y };
    draw();
  });
  v.addEventListener('pointermove', e => {
    if (!st.tool || !st.view) return;
    if (st.pointers.has(e.pointerId)) st.pointers.set(e.pointerId, local(e));
    if (st.gesture) { moveGesture(); return; }
    if (st.gestureLock) return;
    const p = toImg(e);
    if (st.down && Math.hypot(local(e).x - st.down.l.x, local(e).y - st.down.l.y) > 6) st.down.moved = true;
    if (st.tool === 'crop') { if (st.drag) { st.drag.b = p; draw(); } return; }
    if (st.tool === 'text') {
      if (st.textDrag) {
        const t = st.doc.text, d = st.textDrag;
        t.x = clamp(d.x0 + (p.x - d.p0.x) / st.doc.W, -0.25, 1.25);
        t.y = clamp(d.y0 + (p.y - d.p0.y) / st.doc.H, -0.25, 1.25);
        draw();
      }
      return;
    }
    if (BRUSHES.has(st.tool)) {
      st.cursor = p;
      if (st.stroke) {
        for (const ev of e.getCoalescedEvents?.() || [e]) {
          const q = toImg(ev);
          dabAt(st.stroke, q);
          st.stroke = q;
        }
      }
      draw();
    }
  });
  const end = async e => {
    st.pointers.delete(e.pointerId);
    if (st.gesture) {
      if (st.pointers.size < 2) { st.gesture = null; st.gestureLock = st.pointers.size > 0; }
      return;
    }
    if (st.gestureLock) { if (!st.pointers.size) st.gestureLock = false; return; }
    const down = st.down;
    st.down = null;
    if (st.tool === 'crop' && st.drag) {
      const r = rectOf(st.drag), o = st.doc.orig;
      st.drag = null;
      if (r.w < Math.max(o.width, o.height) * 0.03 || r.h < Math.max(o.width, o.height) * 0.03) { draw(); return; }
      snapshot();
      st.doc.crop = r;
      setTool(null);
      buildWork(st.doc);
      await makeMask();
      return;
    }
    if (st.stroke) { st.stroke = null; maskChanged(); }
    if (st.textDrag) { st.textDrag = null; changed(); }
    if (down && !down.moved && e.type === 'pointerup') {
      if (st.tool === 'wand') wandAt(down.p);
      else if (st.tool === 'tap') removePieceAt(down.p);
    }
    if (e.pointerType !== 'mouse') st.cursor = null;
    draw();
  };
  v.addEventListener('pointerup', end);
  v.addEventListener('pointercancel', end);
  v.addEventListener('pointerleave', e => {
    if (e.pointerType === 'mouse' && !st.stroke) { st.cursor = null; draw(); }
  });
  // trackpad pinch or ctrl+wheel zooms, two-finger scroll pans
  v.addEventListener('wheel', e => {
    if (!EDITS.has(st.tool) || !st.view) return;
    e.preventDefault();
    const l = local(e);
    if (e.ctrlKey || e.metaKey) zoomAt(st.zoom.z * Math.exp(-e.deltaY * 0.01), l.x, l.y);
    else panBy(-e.deltaX, -e.deltaY);
  }, { passive: false });
}

// a second finger came down: whatever the first one started becomes a pinch instead
function startGesture() {
  if (st.stroke) {
    const s = st.undo.pop();
    if (s?.mask) { st.doc.mask = s.mask; syncSub(); }
    st.stroke = null; undoButtons();
  }
  if (st.textDrag) { st.doc.text.x = st.textDrag.x0; st.doc.text.y = st.textDrag.y0; st.textDrag = null; }
  st.down = null; st.cursor = null;
  const [a, b] = [...st.pointers.values()], v = st.view;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  st.gesture = { d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), z0: st.zoom.z, P0: { x: (mid.x - v.ox) / v.k, y: (mid.y - v.oy) / v.k } };
  draw();
}

function moveGesture() {
  const [a, b] = [...st.pointers.values()], g = st.gesture, v = st.view;
  if (!a || !b) return;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const z = clamp(g.z0 * Math.hypot(a.x - b.x, a.y - b.y) / g.d0, 1, 16), k = v.k0 * z;
  st.zoom = { z, cx: clamp(g.P0.x - (mid.x - v.mx) / k, 0, v.dw), cy: clamp(g.P0.y - (mid.y - v.my) / k, 0, v.dh) };
  draw();
  showZoom();
}

function zoomAt(z, lx, ly) {
  const v = st.view;
  if (!v) return;
  z = clamp(z, 1, 16);
  if (z <= 1.001) { st.zoom = { z: 1, cx: null, cy: null }; draw(); showZoom(); return; }
  const P = { x: (lx - v.ox) / v.k, y: (ly - v.oy) / v.k }, k = v.k0 * z;
  st.zoom = { z, cx: clamp(P.x - (lx - v.mx) / k, 0, v.dw), cy: clamp(P.y - (ly - v.my) / k, 0, v.dh) };
  draw(); showZoom();
}

function panBy(dx, dy) {
  const v = st.view;
  if (!v || st.zoom.z <= 1) return;
  st.zoom.cx = clamp((st.zoom.cx ?? v.dw / 2) - dx / v.k, 0, v.dw);
  st.zoom.cy = clamp((st.zoom.cy ?? v.dh / 2) - dy / v.k, 0, v.dh);
  draw();
}

function showZoom() {
  $('#zoomFit').textContent = st.zoom.z > 1.01 ? `${Math.round(st.zoom.z * 100)}%` : 'Fit';
}

function dabAt(a, b) {
  const doc = st.doc, r = brushR(), val = st.tool === 'restore' ? 255 : 0;
  const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (r * 0.25)));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, d = S.dab(doc.mask, doc.W, doc.H, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, r, val);
    if (d.w <= 0 || d.h <= 0) continue;
    x0 = Math.min(x0, d.x); y0 = Math.min(y0, d.y); x1 = Math.max(x1, d.x + d.w); y1 = Math.max(y1, d.y + d.h);
  }
  if (x1 > x0) syncSub({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  draw();
}

function wandAt(p) {
  const d = st.doc;
  if (p.x < 0 || p.y < 0 || p.x >= d.W || p.y >= d.H) return;
  snapshot();
  const n = S.wand(d.mask, d.img, d.W, d.H, p.x, p.y, prefs.tol, prefs.connected);
  if (!n) {
    st.undo.pop(); undoButtons();
    toast('Nothing to take there. Try a bit more tolerance.');
    return;
  }
  maskChanged();
}

function removePieceAt(p) {
  const d = st.doc, hit = S.pieceAt(d.mask, d.W, d.H, p.x, p.y);
  if (!hit) { toast('Tap right on the bit you want gone.'); return; }
  snapshot();
  for (let i = 0; i < hit.length; i++) if (hit[i]) d.mask[i] = 0;
  maskChanged();
}

function syncSub(r) {
  const doc = st.doc;
  if (!doc?.mask || !st.subC) return;
  const x = r ? r.x : 0, y = r ? r.y : 0, w = r ? r.w : doc.W, h = r ? r.h : doc.H;
  const out = new ImageData(w, h), d = out.data, src = doc.img.data;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const p = (y + j) * doc.W + x + i, o = (j * w + i) * 4;
      d[o] = src[p * 4]; d[o + 1] = src[p * 4 + 1]; d[o + 2] = src[p * 4 + 2]; d[o + 3] = doc.mask[p];
    }
  }
  st.subC.getContext('2d').putImageData(out, x, y);
}

/* ---------- undo and redo ---------- */

const stateNow = () => ({ crop: { ...st.doc.crop }, kind: st.doc.kind, mask: st.doc.mask?.slice() });

function snapshot() {
  st.undo.push(stateNow());
  if (st.undo.length > 25) st.undo.shift();
  st.redo = [];
  undoButtons();
}

function undoButtons() {
  $('#undo').disabled = !st.undo.length;
  $('#redo').disabled = !st.redo.length;
}

async function restore(s) {
  const d = st.doc, same = cropKey(d) === keyOf(s.crop);
  d.crop = s.crop; d.kind = s.kind;
  if (!same) buildWork(d);
  if (s.mask && s.mask.length === d.W * d.H) { syncUI(); setMask(s.mask); } else await makeMask();
}

async function undo() {
  const s = st.undo.pop();
  if (!s || !st.doc) return;
  st.redo.push(stateNow()); undoButtons();
  await restore(s);
}

async function redo() {
  const s = st.redo.pop();
  if (!s || !st.doc) return;
  st.undo.push(stateNow()); undoButtons();
  await restore(s);
}

/* ---------- tools, tabs, settings ---------- */

const HINTS = {
  erase: 'Paint over anything that shouldn’t be there. Pinch to zoom.',
  restore: 'Paint over bits that went missing. Pinch to zoom.',
  wand: 'Tap a colour to take it out.',
  tap: 'Tap a stray bit to remove it.',
  crop: 'Drag a box around the thing you want.',
  text: 'Drag to move the words.',
};

function setTool(t) {
  if (t === st.tool) t = null;
  if (t === 'text' && !hasText(st.doc?.text)) { toast('Type something first.'); t = null; }
  st.tool = t; st.cursor = null; st.drag = null; st.stroke = null; st.textDrag = null; st.down = null;
  st.zoom = { z: 1, cx: null, cy: null }; showZoom();
  const stage = $('#stage');
  stage.classList.toggle('editing', BRUSHES.has(t));
  stage.classList.toggle('cropping', t === 'crop');
  stage.classList.toggle('picking', t === 'wand' || t === 'tap');
  stage.classList.toggle('moving', t === 'text');
  $('#view').style.touchAction = t ? 'none' : '';
  $('#stagebar').hidden = !t;
  $('#hint').textContent = HINTS[t] || '';
  $('#whole').hidden = t !== 'crop';
  $('#brushRow').hidden = !BRUSHES.has(t);
  $('#wandOpts').hidden = t !== 'wand';
  $('#zoom').hidden = !EDITS.has(t) || t === 'text';
  $('#bgpick').hidden = !!t;
  for (const b of $$('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === t));
  showSplit();
  if (!t) changed();
  else draw();
}

function setTab(name) {
  st.tab = name;
  for (const b of $$('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const p of $$('[data-pane]')) p.hidden = p.dataset.pane !== name;
  if ((name !== 'cut' && CUT_TOOLS.has(st.tool)) || (name !== 'text' && st.tool === 'text')) setTool(null);
}

async function setKind(k) {
  const doc = st.doc;
  if (!doc || k === doc.kind) return;
  snapshot();
  doc.kind = k;
  if (st.tool && st.tool !== 'crop') setTool(null);
  await makeMask();
}

function setBg(bg, remember = true) {
  $('#stage').dataset.bg = bg;
  for (const b of $$('#bgpick [data-bg]')) b.setAttribute('aria-checked', String(b.dataset.bg === bg));
  if (remember) { prefs.bg = bg; savePrefs(); }
}

function styleChanged(fast = false) {
  prefs.style = { ...st.doc.style, rotate: 0, flip: false };
  savePrefs();
  syncUI();
  changed(fast);
}

const marks = {};

function syncUI() {
  const doc = st.doc;
  if (!doc) return;
  const isCut = doc.kind === 'cut', s = doc.style, plain = s.mode === 'cutout';
  for (const b of $$('[data-kind]')) b.setAttribute('aria-checked', String(b.dataset.kind === doc.kind));
  for (const el of $$('.cutonly')) el.hidden = !isCut || doc.textOnly;
  for (const el of $$('.nottext')) el.hidden = doc.textOnly;
  for (const el of $$('.textonly')) el.hidden = !doc.textOnly;
  $('.tools').classList.toggle('shapes', !isCut);
  $('#cropLabel').textContent = isCut ? 'Pick the thing' : 'Move it';
  HINTS.crop = isCut ? 'Drag a box around the thing you want.' : 'Drag a box over the part of the photo to use.';
  if (st.tool === 'crop' && !$('#hint').textContent.startsWith('Kept')) $('#hint').textContent = HINTS.crop;
  $('#grow').value = doc.edge.grow;
  $('#growVal').textContent = doc.edge.grow ? `${doc.edge.grow > 0 ? 'Grow' : 'Shrink'} ${Math.abs(doc.edge.grow)}` : 'Shrink · Grow';
  $('#smoothEdge').value = doc.edge.smooth;
  $('#brush').value = prefs.brush;
  $('#tol').value = prefs.tol;
  for (const b of $$('[data-wand]')) b.setAttribute('aria-checked', String((b.dataset.wand === 'connected') === prefs.connected));

  for (const b of $$('[data-mode]')) b.setAttribute('aria-checked', String(b.dataset.mode === s.mode));
  for (const el of $$('.stickeronly')) el.hidden = plain;
  $('#cutoutNote').hidden = !plain;
  $('#border').value = s.border;
  $('#borderVal').textContent = borderName(s.border);
  $('#shadow').checked = s.shadow;
  for (const b of $$('[data-outline]')) b.setAttribute('aria-checked', String(b.dataset.outline === s.outline));
  $('#outlineColors').hidden = s.outline === 'none';
  $('#turn').value = s.rotate;
  $('#turnVal').textContent = `${Math.round(s.rotate)}°`;
  $('#flip').setAttribute('aria-pressed', String(!!s.flip));

  for (const b of $$('#looks [data-look]')) b.setAttribute('aria-checked', String(b.dataset.look === doc.fx.look));
  $('#fxBright').value = doc.fx.bright; $('#fxContrast').value = doc.fx.contrast; $('#fxSat').value = doc.fx.sat;

  if (document.activeElement !== $('#textValue')) $('#textValue').value = doc.text.value;
  for (const b of $$('#fonts [data-font]')) b.setAttribute('aria-checked', String(b.dataset.font === doc.text.font));
  $('#textSize').value = doc.text.size * 100;

  for (const b of $$('[data-size]')) b.setAttribute('aria-checked', String(b.dataset.size === prefs.size));
  Object.values(marks).forEach(m => m());
  undoButtons();
}

function borderName(v) {
  return v <= 0 ? 'None' : v < 2 ? 'Thin' : v < 4.5 ? 'Medium' : v < 6.5 ? 'Thick' : 'Chunky';
}

// colour swatches plus a "+" for any colour; get/set read and write the doc
const pick = $('#pickColor');
let pickTarget = null;
function swatches(box, colors, get, set, label) {
  box.textContent = '';
  for (const c of colors) {
    const b = document.createElement('button');
    b.type = 'button'; b.setAttribute('role', 'radio'); b.dataset.c = c;
    b.style.background = c; b.setAttribute('aria-label', `${label} ${c}`);
    b.addEventListener('click', () => set(c));
    box.append(b);
  }
  const more = document.createElement('button');
  more.type = 'button'; more.className = 'more'; more.setAttribute('role', 'radio');
  more.setAttribute('aria-label', `Any ${label.toLowerCase()}`);
  more.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-plus"/></svg>';
  more.addEventListener('click', () => { pick.value = get().toLowerCase(); pickTarget = set; pick.click(); });
  box.append(more);
  return () => {
    if (!st.doc) return;
    const cur = get(), known = colors.includes(cur);
    for (const b of box.children) b.setAttribute('aria-checked', String(b === more ? !known : b.dataset.c === cur));
    more.style.background = known ? '' : cur;
  };
}

/* ---------- busy note and batch bar ---------- */

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
  setTimeout(() => { busy(false); if (st.doc?.kind === 'cut' && !st.doc.mask) setKind('rounded'); }, 5000);
}

function batchShow(text, frac) {
  $('#batch').hidden = false;
  $('#batchText').textContent = text;
  $('#batchBar').style.width = `${Math.round(frac * 100)}%`;
}

cut.listen((got, total, phase) => {
  const mb = `${(got / 1e6).toFixed(0)} of ${(total / 1e6).toFixed(0)} MB`;
  if (!$('#batch').hidden) {
    batchShow(phase ? 'Getting the scissors ready…' : `Getting the scissors ready (${mb}, first time only)…`, got / total);
    return;
  }
  if ($('#editor').hidden || ($('#busy').hidden && phase)) return;
  if (phase === 'warming') busy('Getting the scissors ready…', 1, 'Almost there.');
  else busy('Getting the scissors ready…', got / total, `${mb}. This only happens the first time.`);
});

// Many photos at once: each one is cut out with the current style and kept.
async function batch(files) {
  st.batchStop = false;
  const n = files.length;
  let made = 0;
  showStart();
  batchShow(`Making sticker 1 of ${n}…`, 0);
  for (let i = 0; i < n && !st.batchStop; i++) {
    batchShow(`Making sticker ${i + 1} of ${n}…`, i / n);
    try {
      const r = await loadCanvas(files[i]);
      const doc = newDoc(r.canvas, { name: cleanName(files[i].name), hasAlpha: r.hasAlpha });
      buildWork(doc);
      doc.mask = quickMask(doc) || await aiMask(doc);
      doc.maskVer++;
      const c = C.sticker(doc, { size: prefs.size });
      if (c) {
        await storeSticker(doc, await C.toBlob(c));
        made++;
        await refreshTray();
      }
    } catch (e) { console.warn('peel: batch', e); }
    batchShow(`Making sticker ${Math.min(i + 2, n)} of ${n}…`, (i + 1) / n);
    await frames(1);
  }
  $('#batch').hidden = true;
  toast(made ? `Made ${made} sticker${made > 1 ? 's' : ''}. Tap one in My stickers to touch it up.` : "Couldn't make stickers from those.", 5000);
  if (made) $('#tray').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------- My stickers ---------- */

let urls = [];
async function refreshTray() {
  const items = await store.list();
  urls.forEach(u => URL.revokeObjectURL(u)); urls = [];
  const grid = $('#grid');
  grid.textContent = '';
  for (const it of items) {
    const tile = document.createElement('div');
    tile.className = 'tile';
    const open = document.createElement('button');
    open.type = 'button'; open.className = 'tileimg';
    open.title = it.project ? 'Change it' : 'A sticker';
    const img = new Image(), u = URL.createObjectURL(it.blob);
    urls.push(u);
    img.src = u; img.alt = 'A sticker'; img.loading = 'lazy';
    open.append(img);
    open.addEventListener('click', () => openProject(it));
    const acts = document.createElement('div');
    acts.className = 'acts';
    acts.append(
      act('i-copy', 'Copy', () => copyBlob(it.blob)),
      act('i-save', 'Save', () => give([new File([it.blob], `${it.name || 'peel'}-sticker.png`, { type: 'image/png' })])),
      act('i-trash', 'Delete', async () => { await store.remove(it.id); refreshTray(); }),
    );
    tile.append(open, acts);
    grid.append(tile);
  }
  $('#count').textContent = items.length ? `(${items.length})` : '';
  $('#saveAll').hidden = items.length < 2;
  $('#sheetBtn').hidden = !items.length;
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

// open a kept sticker again, exactly as it was made
async function openProject(it) {
  const p = it.project;
  if (!p) { toast('This one was made before Peel could reopen stickers, so it can only be copied or saved.', 5000); return; }
  try {
    const im = await decode(p.src), c = S.canvas(p.W, p.H);
    c.getContext('2d').drawImage(im, 0, 0, p.W, p.H);
    const doc = newDoc(c, { name: it.name, hasAlpha: p.hasAlpha, textOnly: p.textOnly });
    Object.assign(doc, { kind: p.kind, edge: { ...p.edge }, fx: { ...p.fx }, text: { ...p.text }, style: { ...DEFAULT_STYLE, ...p.style } });
    buildWork(doc);
    const mi = await decode(p.mask), mc = S.canvas(doc.W, doc.H), mg = mc.getContext('2d', { willReadFrequently: true });
    mg.drawImage(mi, 0, 0, doc.W, doc.H);
    const md = mg.getImageData(0, 0, doc.W, doc.H).data, m = new Uint8Array(doc.W * doc.H);
    for (let i = 0; i < m.length; i++) m[i] = md[i * 4];
    openDoc(doc);
    busy(false);
    setMask(m);
    toast('Opened it again. Keep saves a new copy.');
  } catch (e) {
    console.warn(e);
    toast("Couldn't open that one again.");
  }
}

/* ---------- recent photos ---------- */

async function rememberPhoto(canvas, alpha, name, id) {
  try {
    const blob = await C.toBlob(canvas, alpha ? 'image/png' : 'image/jpeg', 0.88);
    const thumb = await C.toBlob(S.fit(canvas, 220), alpha ? 'image/png' : 'image/jpeg', 0.8);
    await store.addPhoto({ id: id || newId(), opened: Date.now(), name, blob, thumb });
    refreshRecent();
  } catch (e) { console.warn('peel: recent', e); }
}

let recentUrls = [];
async function refreshRecent() {
  const items = await store.photos();
  recentUrls.forEach(u => URL.revokeObjectURL(u)); recentUrls = [];
  const row = $('#recentRow');
  row.textContent = '';
  for (const it of items) {
    const b = document.createElement('button'), img = new Image(), u = URL.createObjectURL(it.thumb);
    recentUrls.push(u);
    b.type = 'button'; b.className = 'recentph'; b.title = 'Open this photo again';
    img.src = u; img.alt = 'A recent photo';
    b.append(img);
    b.addEventListener('click', () => { cut.ready().catch(() => {}); loadBlob(it.blob, it.name, { recentId: it.id }); });
    row.append(b);
  }
  $('#recent').hidden = !items.length;
}

/* ---------- sticker sheet ---------- */

async function openSheet() {
  const items = await store.list();
  if (!items.length) return;
  const bitmaps = await Promise.all(items.map(it => createImageBitmap(it.blob)));
  st.sheet = { items, bitmaps, off: new Set() };
  const pickBox = $('#sheetPick');
  pickBox.textContent = '';
  items.forEach((it, i) => {
    const b = document.createElement('button'), img = new Image();
    b.type = 'button'; b.className = 'sheetitem'; b.setAttribute('aria-pressed', 'true');
    img.src = urls[i] || URL.createObjectURL(it.blob); img.alt = 'A sticker';
    b.append(img);
    b.addEventListener('click', () => {
      const off = st.sheet.off;
      off.has(i) ? off.delete(i) : off.add(i);
      b.setAttribute('aria-pressed', String(!off.has(i)));
      drawSheet();
    });
    pickBox.append(b);
  });
  $('#sheetDlg').showModal();
  drawSheet();
}

function sheetPages() {
  const sh = st.sheet, page = PAGES[$('#sheetPage').value];
  const chosen = sh.bitmaps.map((b, i) => i).filter(i => !sh.off.has(i));
  const pages = sheetLayout(chosen.map(i => ({ w: sh.bitmaps[i].width, h: sh.bitmaps[i].height })), page, $('#sheetSize').value / 100, $('#sheetGap').value / 100)
    .map(pl => pl.map(p => ({ ...p, i: chosen[p.i] })));
  return { page, pages, count: chosen.length };
}

function drawSheet() {
  const { page, pages, count } = sheetPages(), box = $('#sheetPreview');
  box.textContent = '';
  const scale = Math.min(380, box.clientWidth || 380) / page.w;
  for (const pl of pages) {
    const c = drawPage(pl, st.sheet.bitmaps, page, true, scale);
    c.className = 'sheetpage';
    if (!$('#sheetWhite').checked) c.classList.add('clear');
    box.append(c);
  }
  $('#sheetInfo').textContent = count
    ? `${count} sticker${count > 1 ? 's' : ''} on ${pages.length} page${pages.length > 1 ? 's' : ''}.`
    : 'Nothing on the sheet. Tap some stickers to put them back.';
}

async function sheetSave(asPdf) {
  const { page, pages } = sheetPages();
  if (!pages.length) return;
  const white = asPdf || $('#sheetWhite').checked;
  const canvases = pages.map(pl => drawPage(pl, st.sheet.bitmaps, page, white, 1));
  if (asPdf) {
    give([new File([await pdf(canvases, page)], 'peel-sticker-sheet.pdf', { type: 'application/pdf' })]);
  } else {
    const files = [];
    for (let i = 0; i < canvases.length; i++) files.push(new File([await C.toBlob(canvases[i])], `peel-sheet-${i + 1}.png`, { type: 'image/png' }));
    give(files, 'peel-sticker-sheet.zip');
  }
}

/* ---------- screens ---------- */

function showEditor() {
  $('#start').hidden = true;
  $('#editor').hidden = false;
  busy(false);
  setTool(null);
  setTab(st.doc?.textOnly ? 'text' : 'cut');
  requestAnimationFrame(() => $('#stage').scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
}

function showStart() {
  $('#editor').hidden = true;
  $('#start').hidden = false;
  st.doc = null; st.run++;
  refreshRecent();
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

function chips(box, items, attr, label, onPick, styleOf) {
  box.textContent = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button'; b.setAttribute('role', 'radio'); b.dataset[attr] = it.id; b.textContent = it.name;
    if (styleOf) Object.assign(b.style, styleOf(it));
    b.setAttribute('aria-label', `${label}: ${it.name}`);
    b.addEventListener('click', () => onPick(it.id));
    box.append(b);
  }
}

function placeText(doc) {
  // first words go just under the subject, or in the middle when there's nothing there
  const box = doc.mask && S.bbox(C.edgeMask(doc), doc.W, doc.H, 128);
  if (!box || doc.textOnly) { doc.text.x = 0.5; doc.text.y = 0.5; return; }
  doc.text.x = (box.x + box.w / 2) / doc.W;
  doc.text.y = Math.min(1.2, (box.y + box.h) / doc.H + doc.text.size * Math.max(doc.W, doc.H) / doc.H * 0.8);
}

function setup() {
  setupPointer();
  setBg(prefs.bg, false);

  // style swatches
  marks.border = swatches($('#colors'), COLORS, () => st.doc.style.color, c => { st.doc.style.color = c; styleChanged(); }, 'Border color');
  marks.outline = swatches($('#outlineColors'), LINE_COLORS, () => st.doc.style.outlineColor, c => { st.doc.style.outlineColor = c; styleChanged(); }, 'Outline color');
  marks.text = swatches($('#textColors'), TEXT_COLORS, () => st.doc.text.color, c => { st.doc.text.color = c; syncUI(); changed(); }, 'Text color');
  pick.addEventListener('input', () => pickTarget?.(pick.value.toUpperCase()));

  chips($('#looks'), LOOKS, 'look', 'Look', id => { st.doc.fx.look = id; syncUI(); changed(); });
  chips($('#fonts'), FONTS, 'font', 'Font', id => { st.doc.text.font = id; syncUI(); changed(); },
    f => ({ fontFamily: f.family, fontWeight: f.weight }));
  loadFonts();

  // start screen
  const file = $('#file');
  file.addEventListener('change', () => {
    if (file.files?.length) loadFiles(file.files);
    file.value = '';
  });
  // start fetching the cutter while the photo picker is open
  $('#pickBtn').addEventListener('click', () => cut.ready().catch(() => {}));
  $('#again').addEventListener('click', () => { cut.ready().catch(() => {}); file.click(); });
  $('#textOnly').addEventListener('click', startText);
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
    if (e.target.closest?.('textarea, input')) return;
    const f = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
    if (f.length) { e.preventDefault(); loadFiles(f.length > 1 ? f : [new File([f[0]], 'pasted.png', { type: f[0].type })]); }
  });
  const drop = $('#drop');
  addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  addEventListener('dragleave', e => { if (!e.relatedTarget) drop.classList.remove('over'); });
  addEventListener('drop', e => {
    e.preventDefault(); drop.classList.remove('over');
    if (e.dataTransfer?.files?.length) loadFiles(e.dataTransfer.files);
  });
  $('#clearRecent').addEventListener('click', async () => {
    for (const p of await store.photos()) await store.removePhoto(p.id);
    refreshRecent();
  });

  // tabs and tools
  for (const b of $$('[data-tab]')) b.addEventListener('click', () => setTab(b.dataset.tab));
  for (const b of $$('[data-kind]')) b.addEventListener('click', () => setKind(b.dataset.kind));
  for (const b of $$('[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool));
  $('#doneFix').addEventListener('click', () => setTool(null));
  $('#whole').addEventListener('click', async () => {
    snapshot();
    st.doc.crop = { x: 0, y: 0, w: st.doc.orig.width, h: st.doc.orig.height };
    setTool(null); buildWork(st.doc); await makeMask();
  });
  $('#undo').addEventListener('click', undo);
  $('#redo').addEventListener('click', redo);
  $('#zoomIn').addEventListener('click', () => zoomAt(st.zoom.z * 1.5, st.view.mx, st.view.my));
  $('#zoomOut').addEventListener('click', () => zoomAt(st.zoom.z / 1.5, st.view.mx, st.view.my));
  $('#zoomFit').addEventListener('click', () => zoomAt(1));
  $('#brush').addEventListener('input', e => {
    prefs.brush = +e.target.value; savePrefs();
    if (st.doc) st.cursor = st.view ? { x: (st.view.mx - st.view.ox) / st.view.k, y: (st.view.my - st.view.oy) / st.view.k } : null;
    draw();
  });
  $('#tol').addEventListener('input', e => { prefs.tol = +e.target.value; savePrefs(); });
  for (const b of $$('[data-wand]')) b.addEventListener('click', () => { prefs.connected = b.dataset.wand === 'connected'; savePrefs(); syncUI(); });
  $('#wholeMask').addEventListener('click', () => {
    snapshot();
    st.doc.mask = new Uint8Array(st.doc.W * st.doc.H).fill(255);
    maskChanged(); draw();
  });
  $('#grow').addEventListener('input', e => { st.doc.edge.grow = +e.target.value; syncUI(); changed(true); });
  $('#smoothEdge').addEventListener('input', e => { st.doc.edge.smooth = +e.target.value; syncUI(); changed(true); });
  for (const id of ['#grow', '#smoothEdge']) $(id).addEventListener('change', () => { updatePieces(); changed(); });

  // style
  for (const b of $$('[data-mode]')) b.addEventListener('click', () => {
    const s = st.doc.style;
    if (s.mode === b.dataset.mode) return;
    s.mode = b.dataset.mode;
    if (s.mode === 'cutout') { st.bgBefore = $('#stage').dataset.bg; setBg('checker', false); }
    else setBg(st.bgBefore || prefs.bg, false);
    styleChanged();
  });
  $('#border').addEventListener('input', e => { st.doc.style.border = +e.target.value; styleChanged(true); });
  $('#border').addEventListener('change', () => changed());
  $('#shadow').addEventListener('change', e => { st.doc.style.shadow = e.target.checked; styleChanged(); });
  for (const b of $$('[data-outline]')) b.addEventListener('click', () => {
    const s = st.doc.style;
    s.outline = b.dataset.outline;
    if (s.outline === 'double' && s.outlineColor === '#2A2630') s.outlineColor = '#FF8FB1';
    styleChanged();
  });
  $('#turn').addEventListener('input', e => {
    let v = +e.target.value;
    for (const snap of [-180, -90, 0, 90, 180]) if (Math.abs(v - snap) <= 3) v = snap;
    st.doc.style.rotate = v; syncUI(); changed(true);
  });
  $('#turn').addEventListener('change', () => changed());
  $('#turn90').addEventListener('click', () => {
    const s = st.doc.style;
    s.rotate = ((Math.round(s.rotate / 90) * 90 + 90 + 180) % 360) - 180;
    syncUI(); changed();
  });
  $('#flip').addEventListener('click', () => { st.doc.style.flip = !st.doc.style.flip; syncUI(); changed(); });
  $('#turnReset').addEventListener('click', () => { Object.assign(st.doc.style, { rotate: 0, flip: false }); syncUI(); changed(); });

  // photo
  const fxSlider = (id, key) => {
    $(id).addEventListener('input', e => { st.doc.fx[key] = +e.target.value; changed(true); });
    $(id).addEventListener('change', () => changed());
  };
  fxSlider('#fxBright', 'bright'); fxSlider('#fxContrast', 'contrast'); fxSlider('#fxSat', 'sat');
  $('#fxReset').addEventListener('click', () => { st.doc.fx = { ...PLAIN }; syncUI(); changed(); });

  // text
  $('#textValue').addEventListener('input', e => {
    const t = st.doc.text, was = hasText(t);
    t.value = e.target.value;
    if (!was && hasText(t)) placeText(st.doc);
    updatePieces();
    changed();
  });
  $('#textSize').addEventListener('input', e => { st.doc.text.size = +e.target.value / 100; changed(true); });
  $('#textSize').addEventListener('change', () => changed());
  $('#textClear').addEventListener('click', () => {
    st.doc.text.value = '';
    if (st.tool === 'text') setTool(null);
    syncUI(); updatePieces(); changed();
  });

  // export
  for (const b of $$('[data-size]')) b.addEventListener('click', () => { prefs.size = b.dataset.size; savePrefs(); syncUI(); prerender(); });
  $('#copy').addEventListener('click', copySticker);
  $('#save').addEventListener('click', saveSticker);
  $('#keep').addEventListener('click', () => keep(null, false));
  $('#split').addEventListener('click', splitKeep);
  for (const b of $$('#bgpick [data-bg]')) b.addEventListener('click', () => setBg(b.dataset.bg));

  // tray, sheet, batch
  $('#saveAll').addEventListener('click', saveAll);
  $('#sheetBtn').addEventListener('click', openSheet);
  for (const id of ['#sheetPage', '#sheetSize', '#sheetGap', '#sheetWhite']) $(id).addEventListener('input', drawSheet);
  $('#sheetPng').addEventListener('click', () => sheetSave(false));
  $('#sheetPdf').addEventListener('click', () => sheetSave(true));
  $('#batchStop').addEventListener('click', () => { st.batchStop = true; $('#batchText').textContent = 'Stopping after this one…'; });

  $('#help').addEventListener('click', () => $('#helpDlg').showModal());
  $('.brand').addEventListener('click', e => { if (!$('#editor').hidden) { e.preventDefault(); showStart(); } });

  addEventListener('keydown', e => {
    if (e.target.closest?.('input, textarea, select')) return;
    const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase(), editing = !$('#editor').hidden;
    if (!editing) return;
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && k === 'y') { e.preventDefault(); redo(); }
    else if (mod && k === 'c' && !String(getSelection())) { e.preventDefault(); copySticker(); }
    else if (e.key === 'Escape' && st.tool) setTool(null);
    else if ((k === '+' || k === '=') && EDITS.has(st.tool)) zoomAt(st.zoom.z * 1.25, st.view.mx, st.view.my);
    else if (k === '-' && EDITS.has(st.tool)) zoomAt(st.zoom.z / 1.25, st.view.mx, st.view.my);
  });

  new ResizeObserver(() => draw()).observe($('#stage'));
  refreshTray();
  refreshRecent();
  // warm up quietly if the cutter is already on this device
  cut.isCached().then(yes => { if (yes) setTimeout(() => cut.ready().catch(() => {}), 1200); });
}

setup();

// for checks from the console and the test walker
window.__peel = {
  st, prefs, loadBlob, setKind, setTool, setTab, undo, redo, keep, splitKeep, startText, openSheet,
  list: store.list, which: cut.which, sticker: () => C.sticker(st.doc), wandAt, removePieceAt, zoomAt,
  async loadURL(u, name) { const b = await (await fetch(u)).blob(); await loadBlob(b, name || 'test'); },
  async batchURLs(list) {
    const files = await Promise.all(list.map(async (u, i) => new File([await (await fetch(u)).blob()], `photo-${i + 1}.jpg`, { type: 'image/jpeg' })));
    await batch(files);
  },
  async openKept(i = 0) { await openProject((await store.list())[i]); },
  set(path, value) {   // e.g. set('style.outline', 'dashed')
    const [a, b] = path.split('.');
    if (b) st.doc[a][b] = value; else st.doc[a] = value;
    if (a === 'text' && b === 'value' && value && st.doc.text.x === 0.5 && st.doc.text.y === 0.88) placeText(st.doc);
    syncUI(); updatePieces(); changed();
  },
};
