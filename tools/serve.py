#!/usr/bin/env python3
"""Serve app/ locally the way stuffs does (no-cache, cross-origin isolated),
plus test photos at /test/ from a folder you name.

    tools/serve.py [port] [photos-dir]
"""
import http.server, os, sys
from functools import partial

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8466
PHOTOS = sys.argv[2] if len(sys.argv) > 2 else None


class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm",
                      ".webmanifest": "application/manifest+json", ".onnx": "application/octet-stream"}

    def translate_path(self, path):
        if PHOTOS and path.startswith("/test/"):
            return os.path.join(PHOTOS, os.path.basename(path.split("?")[0]))
        return super().translate_path(path)

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "private, no-cache")
        super().end_headers()

    def log_message(self, *a):
        pass


http.server.ThreadingHTTPServer(("127.0.0.1", PORT), partial(H, directory=ROOT)).serve_forever()
