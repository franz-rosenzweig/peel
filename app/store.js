// Kept in this browser's IndexedDB: "stickers" (My stickers, each with what it
// takes to reopen it) and "photos" (the last few photos opened). If IndexedDB
// isn't available (a private window, blocked storage) they live in memory.

const DB = 'peel', STORES = ['stickers', 'photos'];
let dbP = null;
const mem = { stickers: new Map(), photos: new Map() };

function open() {
  dbP ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB, 2);
    r.onupgradeneeded = () => {
      for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }).catch(() => null);
  return dbP;
}

function tx(db, store, mode, fn) {
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode), r = fn(t.objectStore(store));
    t.oncomplete = () => res(r?.result);
    t.onerror = () => rej(t.error);
  });
}

async function all(store) {
  const db = await open();
  let items = [...mem[store].values()];
  if (db) { try { items = items.concat(await tx(db, store, 'readonly', s => s.getAll())); } catch {} }
  return items;
}

async function put(store, item) {
  const db = await open();
  if (db) { try { await tx(db, store, 'readwrite', s => s.put(item)); return; } catch {} }
  mem[store].set(item.id, item);
}

async function del(store, id) {
  mem[store].delete(id);
  const db = await open();
  if (db) { try { await tx(db, store, 'readwrite', s => s.delete(id)); } catch {} }
}

export const list = async () => (await all('stickers')).sort((a, b) => b.made - a.made);
export const add = item => put('stickers', item);
export const remove = id => del('stickers', id);

export const photos = async () => (await all('photos')).sort((a, b) => b.opened - a.opened);
export async function addPhoto(item, keep = 8) {
  await put('photos', item);
  const old = (await photos()).slice(keep);
  for (const p of old) await del('photos', p.id);
}
export const removePhoto = id => del('photos', id);

// A plain zip (stored, not compressed: PNGs are compressed already).
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export async function zip(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const data = new Uint8Array(await f.blob.arrayBuffer()), name = enc.encode(f.name), crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
    h.setUint16(8, 0, true); h.setUint16(10, 0, true); h.setUint16(12, 0x21, true);
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true);
    h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    parts.push(h.buffer, name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true); c.setUint16(12, 0, true); c.setUint16(14, 0x21, true);
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.push(c.buffer, name);
    offset += 30 + name.length + data.length;
  }
  const size = central.reduce((n, p) => n + p.byteLength, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, size, true); e.setUint32(16, offset, true);
  return new Blob([...parts, ...central, e.buffer], { type: 'application/zip' });
}
