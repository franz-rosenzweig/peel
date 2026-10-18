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

- **Cut out**: IS-Net (DIS, general use) finds the main subject. Stray bits that are small next to it
  (bokeh, a corner of the table) are dropped automatically.
- **Circle, Heart, Square**: photo stickers in a shape, no cutting involved.
- **Pick the thing**: drag a box around what you want and it cuts again from just that part, which also
  gives a small subject more detail. For shapes it's "Move it", to choose which part of the photo fills them.
- **Erase / Bring back**: brushes for fixing the cutout by hand. Undo goes back 20 steps.
- **Border**: none to chunky, eight colours plus any colour, shadow on or off. The border is the subject
  grown and then shrunk back (a morphological closing on a distance transform), so it's smooth and fills
  the small gaps a real die cutter would skip.
- **Copy / Save / Keep**: Copy puts the PNG on the clipboard; Save opens the share sheet on a phone or tablet
  (Save Image, Save to Files) and downloads on a computer. Everything copied, saved or kept also lands in
  **My stickers** (IndexedDB, this browser only), where **Save all** shares or zips the lot.
- **Paste** takes a picture from the clipboard. If it already has a see-through background (lifted out of a
  photo on an iPhone or iPad), Peel skips the cutting and just adds the border.

## How it runs

Plain ES modules, no build step.

| File | What |
|---|---|
| `app/index.html`, `app/style.css` | The page. Phone, tablet and computer layouts; light and dark. |
| `app/main.js` | Screens, tools, copy/save, the stage drawing. `window.__peel` is there for checks. |
| `app/cutout.js` | Loads ONNX Runtime Web and the model, runs it. WebGPU when the browser has it, otherwise WebAssembly on up to 4 threads. Falls back to WebAssembly if the GPU fails or returns nonsense. |
| `app/sticker.js` | Masks, the distance transform, the border, shapes, brushes. |
| `app/store.js` | My stickers (IndexedDB) and a tiny zip writer. |

The model (`app/models/isnet-general-h2f.onnx`) and ONNX Runtime (`app/vendor/ort/`) aren't in git.
`tools/fetch.sh` gets ONNX Runtime Web 1.30.0 from npm and runs `tools/build_model.py`, which downloads
rembg's `isnet-general-use.onnx` and rewrites it (see the script for the three changes and why).

The page has to be **cross-origin isolated** for WebAssembly threads, so the stuffs Caddyfile sends
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` for `/stickers/*`.
Without them it still works, on one thread. Clipboard, Cache Storage and isolation all need https or localhost.

## Checks and deploy

```
tools/serve.py 8466 ~/some/photos          # local copy with the same headers, photos at /test/
tools/walk.py http://127.0.0.1:8466 /tmp/peel --photo cat.jpg            # computer layout
tools/walk.py http://127.0.0.1:8466 /tmp/peel-m --mobile --dark --photo cat.jpg
tools/walk.py https://stuffs.tiresia.xyz/stickers /tmp/peel-live --photos ~/some/photos --photo cat.jpg
tools/deploy.sh                            # rsync app/ to /srv/docker/stuffs/site/stickers/
```

`walk.py` clicks through cut, the shapes, erase, undo, pick the thing, border and keep, screenshots each
step and prints any page errors and how long the cut took. `?ep=wasm` or `?ep=webgpu` on the URL forces one.

If the model file ever changes, give it a new name (or bump `CACHE` in `cutout.js`) and update `MODEL_BYTES`,
because browsers keep the old one in Cache Storage under its URL.
