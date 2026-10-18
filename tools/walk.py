#!/usr/bin/env python3
"""Walk Peel in headless Chrome and screenshot each step.

    tools/walk.py BASE_URL OUT_DIR [--ep wasm|webgpu] [--photo NAME] [--size 1180x820] [--mobile] [--dark] [--photos DIR]

BASE_URL is where the app is served (tools/serve.py puts test photos at /test/).
Prints the page's errors and how long the cut took, so it doubles as a smoke test.
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
    base, out = a[0].rstrip("/"), Path(a[1])
    ep = a[a.index("--ep") + 1] if "--ep" in a else "wasm"
    photo = a[a.index("--photo") + 1] if "--photo" in a else "09_cupcake.jpg"
    w, h = map(int, (a[a.index("--size") + 1] if "--size" in a else "1180x820").split("x"))
    mobile, dark = "--mobile" in a, "--dark" in a
    if mobile and "--size" not in a:
        w, h = 390, 844
    out.mkdir(parents=True, exist_ok=True)
    pg = Page(w, h, mobile=mobile, dark=dark, gpu=ep == "webgpu")
    try:
        pg.nav(f"{base}/?ep={ep}", 3)
        pg.shot(out / "01-start.png")
        print("isolated:", pg.js("crossOriginIsolated"), "gpu:", pg.js("!!navigator.gpu"), "caches:", pg.js("'caches' in self"))
        if "--photos" in a:  # a live site has no /test/: hand the photo over as a data URL
            import base64, mimetypes
            fp = Path(a[a.index("--photos") + 1]) / photo
            src = f"data:{mimetypes.guess_type(fp.name)[0]};base64,{base64.b64encode(fp.read_bytes()).decode()}"
        else:
            src = f"/test/{photo}"
        pg.js(f"void __peel.loadURL('{src}', '{photo}')")
        took = pg.wait("!!__peel.st.mask && document.getElementById('busy').hidden", 600)
        print(f"cut took {took:.1f}s on", pg.js("__peel.which()"))
        pg.pump(0.6)
        pg.shot(out / "02-cut.png")
        for k in ("circle", "heart", "rounded"):
            pg.js(f"__peel.setKind('{k}')")
            pg.pump(0.6)
            pg.shot(out / f"03-{k}.png")
        pg.js("__peel.setKind('cut')")
        pg.pump(0.6)
        # erase a stripe across the middle
        pg.js("__peel.setTool('erase')")
        pg.pump(0.4)
        b = pg.js("(()=>{const r=document.getElementById('view').getBoundingClientRect();return [r.left,r.top,r.width,r.height]})()")
        cx, cy = b[0] + b[2] / 2, b[1] + b[3] / 2
        pg.drag([(cx - 160 + i * 16, cy) for i in range(21)])
        pg.shot(out / "04-erase.png")
        pg.js("__peel.setTool(null)")
        pg.pump(0.6)
        pg.shot(out / "05-after-erase.png")
        pg.js("__peel.undo()")
        pg.pump(0.6)
        pg.shot(out / "06-undo.png")
        # pick the thing: a box around the middle third
        pg.js("__peel.setTool('crop')")
        pg.pump(0.4)
        pg.drag([(b[0] + b[2] * 0.3, b[1] + b[3] * 0.25), (b[0] + b[2] * 0.5, b[1] + b[3] * 0.5), (b[0] + b[2] * 0.62, b[1] + b[3] * 0.85)])
        took = pg.wait("!!__peel.st.mask && document.getElementById('busy').hidden", 600)
        print(f"recut took {took:.1f}s")
        pg.pump(0.6)
        pg.shot(out / "07-picked.png")
        pg.js("document.getElementById('border').value = 7; document.getElementById('border').dispatchEvent(new Event('input')); document.getElementById('border').dispatchEvent(new Event('change'))")
        pg.js("document.querySelector('#colors button:nth-child(4)').click()")
        pg.pump(0.8)
        pg.shot(out / "08-thick-yellow.png")
        pg.js("__peel.keep(null, false)")
        pg.pump(0.8)
        pg.shot(out / "09-kept.png", full=True)
        pg.js("document.getElementById('help').click()")
        pg.pump(0.4)
        pg.shot(out / "10-help.png")
    finally:
        print("\n".join(f"  {l}" for l in pg.logs[-30:]))
        for p in pg.problems:
            print("! page:", p)
        pg.close()


if __name__ == "__main__":
    main()
