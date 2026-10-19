<sub>[Peel docs](README.md) › Running your own copy</sub>

# Your own copy

Running your own copy of Peel is simple, because it's a folder of plain files: HTML, CSS, JavaScript modules, fonts
and the cutter, with no server code, no database and no build step. Any web server can host it, and so can your
own computer if you just want to try it. There are only three things to get right, which are the cutter, two
headers and https, and this page goes through them.

## 1. Get the code and the cutter

```
git clone https://github.com/franz-rosenzweig/peel
cd peel
tools/fetch.sh
```

The cutter and the engine that runs it aren't kept in git, because together they're well over 100 MB.
`tools/fetch.sh` gets them for you: it downloads ONNX Runtime Web 1.30.0 from npm into `app/vendor/ort/`, and then
runs `tools/build_model.py`, which downloads rembg's copy of IS-Net (`isnet-general-use.onnx`, 176 MB) and rewrites
it into `app/models/isnet-general-h2f.onnx` (90 MB). The rewrite only changes how the model is stored, not what it
computes, and the script explains the three changes at the top.

`build_model.py` needs Python 3 with numpy and onnx. If onnx isn't installed, the script's own note shows one way:

```
pip install --target /tmp/onnxlib onnx
PYTHONPATH=/tmp/onnxlib tools/fetch.sh
```

## 2. Try it on your computer

```
tools/serve.py 8466
```

That serves `app/` at http://127.0.0.1:8466 with the same headers as a real server (below). Open it in a browser
and make a sticker. Localhost counts as a secure address, so everything works there, Copy and Paste included.

## 3. Put it on a server

Copy the `app/` folder to your web server, under any path you like. Everything in Peel uses relative addresses,
so `https://example.com/stickers/` works just as well as a site of its own. Then make sure of these:

- **Two headers for the folder:** `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`. They make the page "cross-origin isolated", which is what lets the
  cutter use up to four processor cores when there's no graphics chip for it. Everything Peel loads is its own, so
  they cost nothing. Without them it still works, on one core, which is slower.
- **https.** The clipboard (Copy and Paste), keeping the cutter in the browser, and cross-origin isolation all only
  work on https (or localhost).
- **The right types.** `.mjs` files have to be served as JavaScript and `.wasm` as `application/wasm`, or the browser
  refuses them. Most servers do this already.
- **Fresh code.** I send `Cache-Control: private, no-cache` for the HTML, CSS and JavaScript, which means the browser
  checks for a newer file every time (a quick "not changed" when there isn't one), so an update never mixes a new
  page with an old module.

Here's what that looks like in a Caddyfile, for a site that's only Peel:

```
stickers.example.com {
	root * /var/www/peel/app
	encode zstd gzip
	header Cross-Origin-Opener-Policy same-origin
	header Cross-Origin-Embedder-Policy require-corp
	header Cache-Control "private, no-cache"
	file_server
}
```

If you serve Peel next to other things, put the two isolation headers on Peel's path only, because they also stop
a page from loading pictures and scripts from other sites, which Peel never does but other pages might.

## Make it yours

The footer at the bottom of the page says Peel is part of my site and links to the source. Change that line in
`app/index.html` for your copy. The app's name, colours and icon are in `app/index.html`, `app/style.css` and
`app/manifest.webmanifest`.

## Updating the cutter

Browsers keep the cutter in Cache Storage under its address, so if you ever change the model file, give it a new
name (or bump `CACHE` in `app/cutout.js`) and update `MODEL_BYTES` there too, or browsers that already have the old
one will keep using it. `build_model.py` prints the new size when it's done.

## Next step

If you're going to change the code, [Developing](DEVELOPING.md) has the map of the files and the test walk.

<sub>Next: [Developing](DEVELOPING.md) →</sub>
