#!/usr/bin/env python3
"""Walk Peel in headless Chrome, use every tool, and screenshot each step.

    tools/walk.py BASE_URL OUT_DIR [--ep wasm|webgpu] [--size 1180x820] [--mobile] [--dark]
                  [--photos DIR] [--photo NAME] [--plain NAME] [--group NAME] [--quick]

BASE_URL is where the app is served. tools/serve.py puts test photos at /test/; for a live
site, --photos DIR hands them over as data URLs instead. --photo is the main test photo,
--plain one on a plain background (for the wand), --group one with separate things (for
Remove piece and Split). --quick stops after the basics. Prints the page's errors and the
checks that failed, so it doubles as a smoke test (exit code 1 on any problem).
"""
import json, os, shutil, subprocess, sys, tempfile, time, urllib.request
from base64 import b64decode
from pathlib import Path

import websocket

CHROME = os.environ.get("CHROME", str(Path.home() / ".local/opt/google/chrome-linux64/chrome"))


class Page:
    def __init__(self, w, h, mobile=False, dark=False, gpu=False):
        self.prof = tempfile.mkdtemp(prefix="peel-walk-")
        flags = [CHROME, "--headless=new", "--no-sandbox", "--hide-scrollbars", "--mute-audio",
                 "--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--remote-allow-origins=*",
                 "--remote-debugging-port=0", f"--user-data-dir={self.prof}"]
        if gpu:
            flags += ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan=swiftshader",
                      "--use-webgpu-adapter=swiftshader"]
        self.chrome = subprocess.Popen(flags + ["about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        pf = Path(self.prof) / "DevToolsActivePort"
        for _ in range(100):
            if pf.exists() and pf.read_text().strip():
                break
            time.sleep(0.1)
        port = pf.read_text().split()[0]
        pages = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list"))
        self.ws = websocket.create_connection(next(p for p in pages if p["type"] == "page")["webSocketDebuggerUrl"])
        self.n = 0
        self.problems, self.logs = [], []
        for d in ("Page", "Runtime", "Log"):
            self.call(f"{d}.enable")
        self.size(w, h, mobile)
        self.call("Emulation.setEmulatedMedia", features=[{"name": "prefers-color-scheme", "value": "dark" if dark else "light"}])
        self.call("Browser.grantPermissions", permissions=["clipboardReadWrite", "clipboardSanitizedWrite"])

    def size(self, w, h, mobile=False):
        self.w, self.h = w, h
        self.call("Emulation.setDeviceMetricsOverride", width=w, height=h, deviceScaleFactor=2 if mobile else 1, mobile=mobile)
        if mobile:
            self.call("Emulation.setTouchEmulationEnabled", enabled=True, maxTouchPoints=5)

    def call(self, method, **params):
        self.n += 1
        i = self.n
        self.ws.send(json.dumps({"id": i, "method": method, "params": params}))
        while True:
            m = json.loads(self.ws.recv())
            self.note(m)
            if m.get("id") == i:
                if "error" in m:
                    raise RuntimeError(f"{method}: {m['error']}")
                return m.get("result", {})

    def note(self, m):
        p = m.get("params", {})
        meth = m.get("method")
        if meth == "Runtime.exceptionThrown":
            d = p["exceptionDetails"]
            self.problems.append(d.get("exception", {}).get("description") or d.get("text"))
        elif meth == "Runtime.consoleAPICalled":
            text = " ".join(str(a.get("value", a.get("description", ""))) for a in p["args"])
            (self.problems if p.get("type") == "error" else self.logs).append(f"{p.get('type')}: {text}")
        elif meth == "Log.entryAdded" and p["entry"]["level"] in ("error", "warning"):
            self.logs.append(f'log {p["entry"]["level"]}: {p["entry"]["text"]} {p["entry"].get("url", "")}')

    def pump(self, s):
        self.ws.settimeout(0.2)
        end = time.time() + s
        while time.time() < end:
            try:
                self.note(json.loads(self.ws.recv()))
            except websocket.WebSocketTimeoutException:
                pass
        self.ws.settimeout(120)

    def js(self, code):
        r = self.call("Runtime.evaluate", expression=code, awaitPromise=True, returnByValue=True)
        if "exceptionDetails" in r:
            raise RuntimeError(r["exceptionDetails"].get("exception", {}).get("description", code))
        return r.get("result", {}).get("value")

    def wait(self, code, timeout=120):
        t = time.time()
        while time.time() - t < timeout:
            if self.js(code):
                return time.time() - t
            self.pump(0.3)
        raise TimeoutError(code)

    def nav(self, url, wait=2):
        self.call("Page.navigate", url=url)
        self.pump(wait)

    def shot(self, path, full=False):
        o = {"format": "png"}
        if full:
            hh = self.call("Page.getLayoutMetrics")["cssContentSize"]["height"]
            o.update(captureBeyondViewport=True, clip={"x": 0, "y": 0, "width": self.w, "height": hh, "scale": 1})
        Path(path).write_bytes(b64decode(self.call("Page.captureScreenshot", **o)["data"]))
        print("shot", path)

    def touch(self, kind, pts):
        self.call("Input.dispatchTouchEvent", type=kind,
                  touchPoints=[{"x": x, "y": y, "id": i} for i, (x, y) in enumerate(pts)])

    def pinch(self, cx, cy, d0, d1, steps=8):
        pts = lambda d: [(cx - d / 2, cy), (cx + d / 2, cy)]
        self.touch("touchStart", pts(d0))
        for i in range(1, steps + 1):
            self.touch("touchMove", pts(d0 + (d1 - d0) * i / steps))
        self.touch("touchEnd", [])
        self.pump(0.4)

    def click(self, sel):
        self.js(f"document.querySelector({json.dumps(sel)}).click()")
        self.pump(0.5)

    def mouse(self, kind, x, y, buttons=1):
        self.call("Input.dispatchMouseEvent", type=kind, x=x, y=y, button="left" if buttons else "none",
                  buttons=buttons, clickCount=1, pointerType="mouse")

    def drag(self, pts):
        self.mouse("mouseMoved", *pts[0], buttons=0)
        self.mouse("mousePressed", *pts[0])
        for p in pts[1:]:
            self.mouse("mouseMoved", *p)
        self.mouse("mouseReleased", *pts[-1])
        self.pump(0.4)

    def close(self):
        self.chrome.kill()
        self.chrome.wait()
        shutil.rmtree(self.prof, ignore_errors=True)


def main():
    a = sys.argv[1:]
    opt = lambda k, d: a[a.index(k) + 1] if k in a else d
    base, out = a[0].rstrip("/"), Path(a[1])
    ep = opt("--ep", "wasm")
    w, h = map(int, opt("--size", "1180x820").split("x"))
    mobile, dark = "--mobile" in a, "--dark" in a
    if mobile and "--size" not in a:
        w, h = 390, 844
    out.mkdir(parents=True, exist_ok=True)
    pg = Page(w, h, mobile=mobile, dark=dark, gpu=ep == "webgpu")
    fails = []

    def src(name):
        if "--photos" in a:  # a live site has no /test/: hand the photo over as a data URL
            import base64, mimetypes
            fp = Path(opt("--photos", "")) / name
            return f"data:{mimetypes.guess_type(fp.name)[0]};base64,{base64.b64encode(fp.read_bytes()).decode()}"
        return f"/test/{name}"

    def load(name):
        t = time.time()
        pg.js("__peel.st.doc = null")
        pg.js(f"void __peel.loadURL('{src(name)}', '{name}')")
        pg.wait("!!__peel.st.doc && !!__peel.st.doc.mask && document.getElementById('busy').hidden", 600)
        pg.pump(0.6)
        return time.time() - t

    def check(name, cond):
        ok = pg.js(cond)
        print(("  ok  " if ok else "  FAIL") + " " + name)
        if not ok:
            fails.append(name)

    def shot(name, full=False):
        pg.shot(out / f"{name}.png", full=full)

    def stage():
        return pg.js("(()=>{const r=document.getElementById('view').getBoundingClientRect();return [r.left,r.top,r.width,r.height]})()")

    def img_to_client(x, y):  # work-image point -> page point, using the current edit view
        return pg.js(f"(()=>{{const v=__peel.st.view, r=document.getElementById('view').getBoundingClientRect();"
                     f"return [r.left+v.ox+{x}*v.k, r.top+v.oy+{y}*v.k]}})()")

    try:
        pg.nav(f"{base}/?ep={ep}", 3)
        print("isolated:", pg.js("crossOriginIsolated"), "gpu:", pg.js("!!navigator.gpu"), "caches:", pg.js("'caches' in self"))
        shot("01-start")
        took = load(opt("--photo", "09_cupcake.jpg"))
        print(f"cut took {took:.1f}s on", pg.js("__peel.which()"))
        shot("02-cut")
        check("sticker renders", "!!__peel.sticker()")

        # style: cutout only, outlines, turn & flip
        pg.click('[data-tab="style"]')
        pg.click('[data-mode="cutout"]')
        shot("03-cutout-only")
        check("cutout only: see-through preview", "document.getElementById('stage').dataset.bg === 'checker'")
        check("cutout only: no border controls", "document.querySelector('.stickeronly').hidden")
        pg.click('[data-mode="sticker"]')
        for o in ("line", "double", "dashed"):
            pg.click(f'[data-outline="{o}"]')
            shot(f"04-outline-{o}")
        pg.click('[data-outline="none"]')
        pg.js("__peel.set('style.rotate', 20); __peel.set('style.flip', true)")
        pg.pump(0.6)
        shot("05-turn-flip")
        pg.click("#turnReset")
        if "--quick" in a:
            raise SystemExit

        # photo looks
        pg.click('[data-tab="photo"]')
        for look in ("vintage", "bw"):
            pg.click(f'[data-look="{look}"]')
            shot(f"06-look-{look}")
        pg.click("#fxReset")

        # text on a photo sticker
        pg.click('[data-tab="text"]')
        pg.js("__peel.set('text.value', 'Yum!')")
        pg.pump(0.8)
        shot("07-text")
        pg.click('[data-font="script"]')
        pg.pump(0.6)
        shot("07-text-script")
        pg.click('[data-tool="text"]')
        shot("08-move-text")
        b = stage()
        pg.drag([(b[0] + b[2] * 0.5, b[1] + b[3] * 0.75), (b[0] + b[2] * 0.6, b[1] + b[3] * 0.4), (b[0] + b[2] * 0.7, b[1] + b[3] * 0.3)])
        check("text moved", "__peel.st.doc.text.y < 0.8")
        pg.click("#doneFix")
        pg.click("#textClear")

        # size choice
        pg.click('[data-size="S"]')
        pg.pump(1.2)
        check("small export is 512 px", "Math.max(...(__peel.st.blobDims||[0])) <= 512 && Math.max(...(__peel.st.blobDims||[0])) > 300")
        pg.click('[data-size="M"]')

        # zoom: pinch with two fingers, then the buttons
        pg.click('[data-tab="cut"]')
        pg.click('[data-tool="erase"]')
        b = stage()
        pg.pinch(b[0] + b[2] / 2, b[1] + b[3] / 2, 80, 260)
        check("pinch zooms in", "__peel.st.zoom.z > 2")
        check("pinch didn't erase", "__peel.st.undo.length === 0")
        shot("09-pinched")
        x, y = img_to_client(pg.js("__peel.st.doc.W/2"), pg.js("__peel.st.doc.H*0.62"))
        pg.drag([(x - 60 + i * 12, y) for i in range(11)])
        check("erase made an undo step", "__peel.st.undo.length === 1")
        shot("10-erased-zoomed")
        pg.click("#zoomFit")
        check("fit resets zoom", "__peel.st.zoom.z === 1")
        pg.click("#doneFix")
        pg.click("#undo")
        check("undo", "__peel.st.undo.length === 0 && __peel.st.redo.length === 1")
        pg.click("#redo")
        check("redo", "__peel.st.undo.length === 1 && __peel.st.redo.length === 0")
        pg.click("#undo")

        # edge tools
        pg.js("document.getElementById('grow').value=-3; document.getElementById('grow').dispatchEvent(new Event('input')); document.getElementById('grow').dispatchEvent(new Event('change'))")
        pg.pump(0.8)
        shot("11-edge-shrink")
        pg.js("document.getElementById('grow').value=0; document.getElementById('grow').dispatchEvent(new Event('change')); __peel.set('edge.grow', 0)")

        # keep, then reopen it from My stickers
        pg.click("#keep")
        pg.wait("__peel.list().then(l => l.length >= 1)", 30)
        check("keep goes to the next part", "__peel.st.tool === 'crop'")
        pg.click("#doneFix")
        pg.js("__peel.set('style.color', '#FFE27A')")
        pg.js("__peel.openKept(0)")
        pg.pump(1)
        check("reopened sticker has white border again", "__peel.st.doc.style.color === '#FFFFFF' && !!__peel.st.doc.mask")
        shot("12-reopened")

        # magic wand on a plain background
        load(opt("--plain", "08_flower_bouquet.jpg"))
        pg.js("__peel.set('kind', 'cut')")
        pg.click('[data-tool="wand"]')
        pg.click('[data-wand="everywhere"]')
        pg.click("#wholeMask")
        x, y = img_to_client(20, 20)
        pg.mouse("mouseMoved", x, y, 0); pg.mouse("mousePressed", x, y); pg.mouse("mouseReleased", x, y)
        pg.pump(0.6)
        shot("13-wand")
        check("wand took the background", "(()=>{const m=__peel.st.doc.mask; let n=0; for (let i=0;i<m.length;i+=7) if (m[i]<128) n++; return n/(m.length/7) > 0.4})()")
        pg.click("#doneFix")
        shot("14-wand-sticker")

        # remove a piece, and split
        load(opt("--group", "30_teddy_bear.jpg"))
        check("split pill shows", "!document.getElementById('split').hidden")
        n0 = pg.js("__peel.st.pieces.count")
        pg.click('[data-tool="tap"]')
        cx, cy = pg.js("(()=>{const d=__peel.st.doc, p=__peel.st.pieces, L=p.labels; let sx=0,sy=0,c=0; for(let i=0;i<L.length;i++) if(L[i]===p.count){sx+=i%d.W; sy+=Math.floor(i/d.W); c++;} return [sx/c, sy/c]})()")
        x, y = img_to_client(cx, cy)
        pg.mouse("mouseMoved", x, y, 0); pg.mouse("mousePressed", x, y); pg.mouse("mouseReleased", x, y)
        pg.pump(0.6)
        shot("15-removed-piece")
        check("a piece was removed", f"__peel.st.pieces === null || __peel.st.pieces.count === {n0} - 1")
        pg.click("#undo")
        pg.click("#doneFix")
        before = pg.js("__peel.list().then(l => l.length)")
        pg.click("#split")
        pg.wait(f"__peel.list().then(l => l.length >= {before} + 2)", 60)
        check("split kept each piece", f"__peel.list().then(l => l.length >= {before} + 2)")

        # text-only sticker
        pg.js("__peel.startText()")
        pg.pump(0.5)
        pg.js("document.getElementById('textValue').value='Monday'; document.getElementById('textValue').dispatchEvent(new Event('input'))")
        pg.pump(0.8)
        pg.click('[data-tab="style"]')
        pg.click('[data-outline="line"]')
        shot("16-text-sticker")
        check("text sticker renders", "!!__peel.sticker()")
        pg.click("#keep")
        pg.pump(1)

        # batch
        pg.js(f"void __peel.batchURLs([{json.dumps(src('29_teddy_bear.jpg'))}, {json.dumps(src('12_potted_plant.jpg'))}])")
        pg.pump(1)
        shot("17-batch-running")
        pg.wait("document.getElementById('batch').hidden", 600)
        pg.pump(1)
        check("batch added two", f"__peel.list().then(l => l.length >= {before} + 5)")
        pg.js("scrollTo(0,0)")
        shot("18-start-with-recent", full=True)
        check("recent photos show", "!document.getElementById('recent').hidden")

        # sticker sheet
        pg.js("__peel.openSheet()")
        pg.pump(1.5)
        shot("19-sheet")
        check("sheet preview drawn", "document.querySelectorAll('#sheetPreview canvas').length >= 1")
        check("pdf builds", "import('./sheet.js').then(async m => { const c=document.createElement('canvas'); c.width=200; c.height=260; const b=await m.pdf([c,c], m.PAGES.letter); const t=await b.slice(0,8).text(); return t.startsWith('%PDF-1.4') && b.size > 500; })")
        pg.js("document.getElementById('sheetDlg').close()")
        pg.js("document.getElementById('help').click()")
        pg.pump(0.4)
        shot("20-help")
    except SystemExit:
        pass
    except Exception as e:
        fails.append(f"walk stopped: {e}")
        print("  FAIL walk stopped:", e)
        try:
            shot("99-stopped")
        except Exception:
            pass
    finally:
        print("\n".join(f"  {l}" for l in pg.logs[-12:] if "warn" in l or "error" in l))
        for p in pg.problems:
            print("! page:", p)
        pg.close()
    if fails or pg.problems:
        sys.exit(1)


if __name__ == "__main__":
    main()
