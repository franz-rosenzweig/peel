<sub>[Peel docs](README.md) › Under the hood</sub>

# Developing

These are the working notes for changing Peel itself: what each file does, how the model is made, the headers, the
test walk and deploying. Everything a user needs is in the other pages.

## How it runs

Plain ES modules, no build step.

| File | What |
|---|---|
| `app/index.html`, `app/style.css` | The page. Phone, tablet and computer layouts; light and dark. |
| `app/main.js` | Screens, tabs, tools, pinch and zoom, undo/redo, copy/save/keep, batch, recent photos, the sheet dialog. `window.__peel` is there for checks. |
| `app/compose.js` | The pipeline from a "doc" (photo, mask, settings) to the finished PNG: edge → photo look → text → border/outline → turn/shadow → size, cached step by step. Exports are made again from the full-size photo, around the subject only, with the mask made bigger smoothly and the text drawn again. |
| `app/sticker.js` | Masks: the distance transform, the die-cut border, outlines (incl. marching squares for the dashed line), shapes, brushes, wand, pieces, edge tools. |
| `app/cutout.js` | Loads ONNX Runtime Web and the model, runs it. WebGPU when the browser has it, otherwise WebAssembly on up to 4 threads. Falls back to WebAssembly if the GPU fails or returns nonsense. |
| `app/fx.js`, `app/text.js`, `app/sheet.js` | Photo looks; text layout and fonts; sheet layout and a small PDF writer. |
| `app/store.js` | My stickers and recent photos (IndexedDB) and a tiny zip writer. |

Cutting and fixing happen on a copy of the photo up to 1200 px (`MAX_WORK` in `main.js`), and the photo itself is
kept up to 2400 px (`MAX_ORIG`), which is what exports are made from. Export sizes are `SIZES` in `compose.js`.
A kept sticker stores a "project" (the working image as JPEG or PNG, the mask as a PNG and the settings), which is
what reopening it uses, so a reopened sticker exports at the working size only.

## The model and ONNX Runtime

The model (`app/models/isnet-general-h2f.onnx`) and ONNX Runtime (`app/vendor/ort/`) aren't in git.
`tools/fetch.sh` gets ONNX Runtime Web 1.30.0 from npm and runs `tools/build_model.py`, which downloads
rembg's `isnet-general-use.onnx` and rewrites it (see the script for the three changes and why).

If the model file ever changes, give it a new name (or bump `CACHE` in `cutout.js`) and update `MODEL_BYTES`,
because browsers keep the old one in Cache Storage under its URL.

## Cross-origin isolation

The page has to be **cross-origin isolated** for WebAssembly threads, so the server sends
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` for Peel's folder
(on my server, for `/stickers/*`). Without them it still works, on one thread. Clipboard, Cache Storage and
isolation all need https or localhost. [Your own copy](server.md) has a server example.

## Checks

```
tools/serve.py 8466 ~/some/photos          # local copy with the same headers, photos at /test/
tools/walk.py http://127.0.0.1:8466 /tmp/peel                    # computer layout, every tool
tools/walk.py http://127.0.0.1:8466 /tmp/peel-m --mobile --dark  # phone, dark, real touch events
tools/walk.py https://your.copy/stickers /tmp/peel-live --photos ~/some/photos   # an https copy
```

`walk.py` cuts a photo, then goes through Cutout only, the outlines, turn and flip, the photo looks, text and
moving it, the export size, a two-finger pinch, erasing while zoomed, undo/redo, the edge tools, Keep and
reopening, the wand, Remove piece, Split, a text sticker, a batch, recent photos and the sheet (including a PDF),
screenshotting each step. It prints a line per check and any page errors, and exits 1 if anything failed.
`--photo`, `--plain` and `--group` pick the test photos (main, plain background, separate things); without them it
looks for the file names in the script. `--size WxH` sets the window, `--ep webgpu` runs the model on a software
GPU instead of WebAssembly, and `--quick` stops after the basics. A live site has no `/test/`, so there
`--photos DIR` hands the photos over as data URLs.

`walk.py` starts its own headless Chrome (Chrome for Testing by default, or whatever `CHROME` points to) and needs
the Python `websocket-client` package.

`?ep=wasm` or `?ep=webgpu` on the URL forces one way of running the model.

## Deploying

```
tools/deploy.sh
```

It runs `tools/fetch.sh` first if the model or ONNX Runtime is missing, then copies `app/` with rsync to the folder
my web server serves Peel from. For your own server, change the destination in the script.
