#!/usr/bin/env python3
"""Static file server for the Evora CI smoke test (written by Evora; Python standard library only).

Serves ROOT on 127.0.0.1:PORT with explicit media types (application/wasm…), `Cache-Control:
no-store`, and optional extra headers (`--header 'Name: value'`, repeatable), e.g. the engine's
Content-Security-Policy. No directory listing.
"""

import argparse
import http.server
import os
import sys

TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".wasm": "application/wasm",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".json": "application/json",
    ".webmanifest": "application/manifest+json",
    ".txt": "text/plain; charset=utf-8",
}


def handler(root, extra):
    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=root, **kw)

        def guess_type(self, path):
            return TYPES.get(os.path.splitext(path)[1].lower(), "application/octet-stream")

        def list_directory(self, path):
            self.send_error(404)
            return None

        def end_headers(self):
            self.send_header("Cache-Control", "no-store")
            for name, value in extra:
                self.send_header(name, value)
            super().end_headers()

        def log_message(self, fmt, *args):
            sys.stderr.write(f"[serve {self.server.server_port}] {fmt % args}\n")

    return Handler


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--root", required=True)
    p.add_argument("--port", type=int, required=True)
    p.add_argument("--header", action="append", default=[])
    a = p.parse_args()
    extra = []
    for h in a.header:
        name, _, value = h.partition(":")
        extra.append((name.strip(), value.strip()))
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", a.port), handler(os.path.abspath(a.root), extra))
    print(f"serving {a.root} on http://127.0.0.1:{a.port}/ with {len(extra)} extra header(s)", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
