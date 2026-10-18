# Peel

Peel turns a photo into a sticker. You pick a photo, it cuts out the main thing, gives it a white border
like a real die-cut sticker and hands you a PNG with a see-through background, which you can paste straight
into GoodNotes or anywhere else.

I made it because the free options either want a subscription before they'll give you a transparent PNG
(Canva) or only let you do one a day (remove.bg), and none of them do the white border. This one is FREE, with
no account, and everything happens on your own device, which means your photos never get uploaded anywhere.
The only thing it downloads is the cutter itself, about 90 MB the first time, and after that it's saved in
the browser.

Live at **https://stuffs.tiresia.xyz/stickers/**, part of [stuffs](https://stuffs.tiresia.xyz).

## What it does

**Making it**
- **Cut out**: IS-Net (DIS, general use) finds the main subject. Stray bits that are small next to it
  (bokeh, a corner of the table) are dropped automatically.
- **Circle, Heart, Square**: photo stickers in a shape, no cutting involved.
- **Text sticker**: words on their own, in six fonts, with the border wrapping the letters.
- **Pick photos** takes several at once and makes a sticker of each (batch), with the current style.
- **Paste** takes a picture from the clipboard. If it already has a see-through background (lifted out of a
  photo on an iPhone or iPad), Peel skips the cutting and just adds the border.
- **Recent photos** on the start screen open the last eight photos again.

**Fixing it** (the Cut tab)
- **Erase / Bring back** brushes, with pinch to zoom and two-finger pan (or + / − / Fit, ctrl+scroll on a computer).
- **Magic wand**: tap a colour to take it out, touching only or everywhere, with a tolerance. "Start from the
  whole photo" plus the wand is the way to lift a doodle or lettering off paper.
- **Remove piece**: tap a stray bit and it's gone.
- **Pick the thing**: drag a box around what you want and it cuts again from just that part. After **Keep**,
  Peel goes straight back to the box view for the next part of the same photo.
- **Keep each piece separately**: when the cutout has separate things, one sticker each in one tap.
- **Edge**: shrink or grow the edge a few pixels (shrinking takes off a halo of old background) and smooth it.
- **Undo / Redo**, 25 steps.

**Dressing it up**
- **Style**: Sticker or **Cutout only** (just the cutout on a see-through background); border from none to
  chunky in any colour; outline None / Line / Double / Dashed in any colour; shadow; turn and flip.
- **Photo**: looks (Vivid, Pastel, Vintage, B&W, Warm, Cool) plus brightness, contrast and colour.
- **Text**: words on a photo sticker, in six fonts, any colour and size, dragged where you want them.
- The preview background switches between paper, see-through (checkerboard) and dark.

**Getting it out**
- **Size**: Small (512 px), Medium (1024 px) or Large (as big as the photo allows). Every export is a PNG with a
  see-through background.
- **Copy / Save / Keep**: Copy puts the PNG on the clipboard; Save opens the share sheet on a phone or tablet
  (Save Image, Save to Files) and downloads on a computer. Everything copied, saved or kept lands in
  **My stickers** (IndexedDB, this browser only), with what it takes to **open it again** and change it.
- **Save all** shares or zips the lot. **Make a sheet** lays them out on Letter, A4, an iPad page or a square,
  as PNGs or one PDF, to print on sticker paper or import into GoodNotes as a page.

## How it runs

Plain ES modules, no build step.

| File | What |
|---|---|
| `app/index.html`, `app/style.css` | The page. Phone, tablet and computer layouts; light and dark. |
| `app/main.js` | Screens, tabs, tools, pinch and zoom, undo/redo, copy/save/keep, batch, recent photos, the sheet dialog. `window.__peel` is there for checks. |
| `app/compose.js` | The pipeline from a "doc" (photo, mask, settings) to the finished PNG: edge → photo look → text → border/outline → turn/shadow → size, cached step by step. |
| `app/sticker.js` | Masks: the distance transform, the die-cut border, outlines (incl. marching squares for the dashed line), shapes, brushes, wand, pieces, edge tools. |
| `app/cutout.js` | Loads ONNX Runtime Web and the model, runs it. WebGPU when the browser has it, otherwise WebAssembly on up to 4 threads. Falls back to WebAssembly if the GPU fails or returns nonsense. |
| `app/fx.js`, `app/text.js`, `app/sheet.js` | Photo looks; text layout and fonts; sheet layout and a small PDF writer. |
| `app/store.js` | My stickers and recent photos (IndexedDB) and a tiny zip writer. |

The model (`app/models/isnet-general-h2f.onnx`) and ONNX Runtime (`app/vendor/ort/`) aren't in git.
`tools/fetch.sh` gets ONNX Runtime Web 1.30.0 from npm and runs `tools/build_model.py`, which downloads
rembg's `isnet-general-use.onnx` and rewrites it (see the script for the three changes and why).

The page has to be **cross-origin isolated** for WebAssembly threads, so the stuffs Caddyfile sends
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` for `/stickers/*`.
Without them it still works, on one thread. Clipboard, Cache Storage and isolation all need https or localhost.

## Checks and deploy

```
tools/serve.py 8466 ~/some/photos          # local copy with the same headers, photos at /test/
tools/walk.py http://127.0.0.1:8466 /tmp/peel                    # computer layout, every tool
tools/walk.py http://127.0.0.1:8466 /tmp/peel-m --mobile --dark  # phone, dark, real touch events
tools/walk.py https://stuffs.tiresia.xyz/stickers /tmp/peel-live --photos ~/some/photos
tools/deploy.sh                            # rsync app/ to /srv/docker/stuffs/site/stickers/
```

`walk.py` cuts a photo, then goes through Cutout only, the outlines, turn and flip, the photo looks, text and
moving it, the export size, a two-finger pinch, erasing while zoomed, undo/redo, the edge tools, Keep and
reopening, the wand, Remove piece, Split, a text sticker, a batch, recent photos and the sheet (including a PDF),
screenshotting each step. It prints a line per check and any page errors, and exits 1 if anything failed.
`--photo`, `--plain` and `--group` pick the test photos (main, plain background, separate things).
`?ep=wasm` or `?ep=webgpu` on the URL forces one way of running the model.

If the model file ever changes, give it a new name (or bump `CACHE` in `cutout.js`) and update `MODEL_BYTES`,
because browsers keep the old one in Cache Storage under its URL.
