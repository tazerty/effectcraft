#!/usr/bin/env python3
"""Surface report of the web build (written by Evora, EVORA-KIN-33; Python standard library only).

A REPORT, never a gate: it prints what the shipped site exposes, so a version bump (D-19, check
NR-12) can be compared with the build of the previous branch. Nothing here fails the job, except
a file it cannot read at all (an unreadable site is a broken package, not a measure).

- `imports --wasm FILE`: the import section of the module (module, name, kind), one line each,
  sorted, then counts per module. These are the only doors from the engine's code to the page.
  wasm-bindgen suffixes each glue import with a 16-hex-digit hash of its signature: the suffix is
  dropped, so two builds compare by what they import, not by how the hash came out.
- `net --dir DIR`: network and window primitives in the site's JavaScript and HTML (the
  precompressed copies and LICENSES/ are skipped): occurrences per file of `fetch(`, `WebSocket`,
  `XMLHttpRequest`, `EventSource`, `sendBeacon`, `window.open`, `importScripts`.

Every line starts with `SURFACE` so the job log can be grepped.
"""

import argparse
import os
import re
import sys

KINDS = {0: "func", 1: "table", 2: "memory", 3: "global", 4: "tag"}
PRIMITIVES = ("fetch(", "WebSocket", "XMLHttpRequest", "EventSource", "sendBeacon", "window.open", "importScripts")
SKIP_SUFFIXES = (".br", ".gz")


def leb_u32(buf, pos):
    result = shift = 0
    while True:
        byte = buf[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result, pos
        shift += 7
        if shift > 35:
            raise ValueError("LEB128 trop long")


def name_at(buf, pos):
    n, pos = leb_u32(buf, pos)
    return buf[pos : pos + n].decode("utf-8"), pos + n


def limits_end(buf, pos):
    flags = buf[pos]
    pos += 1
    _, pos = leb_u32(buf, pos)
    if flags & 0x01:
        _, pos = leb_u32(buf, pos)
    return pos


def wasm_imports(path):
    buf = open(path, "rb").read()
    if buf[:4] != b"\0asm":
        raise ValueError(f"{path} : pas un module WebAssembly")
    pos, out = 8, []
    while pos < len(buf):
        sid = buf[pos]
        size, body = leb_u32(buf, pos + 1)
        end = body + size
        if sid == 2:
            count, p = leb_u32(buf, body)
            for _ in range(count):
                module, p = name_at(buf, p)
                field, p = name_at(buf, p)
                kind = buf[p]
                p += 1
                if kind in (0, 4):
                    if kind == 4:
                        p += 1
                    _, p = leb_u32(buf, p)
                elif kind == 1:
                    p = limits_end(buf, p + 1)
                elif kind == 2:
                    p = limits_end(buf, p)
                elif kind == 3:
                    p += 2
                else:
                    raise ValueError(f"genre d'import inconnu {kind}")
                out.append((module, field, KINDS.get(kind, str(kind))))
        pos = end
    return out


def cmd_imports(args):
    items = sorted((m, re.sub(r"_[0-9a-f]{16}$", "", f), k) for m, f, k in wasm_imports(args.wasm))
    per_module = {}
    for module, field, kind in items:
        print(f"SURFACE import {module} {field} {kind}")
        per_module[module] = per_module.get(module, 0) + 1
    for module, n in sorted(per_module.items()):
        print(f"SURFACE imports module={module} count={n}")
    print(f"SURFACE imports total={len(items)} size={os.path.getsize(args.wasm)}")


def cmd_net(args):
    totals = {p: 0 for p in PRIMITIVES}
    for root, dirs, files in os.walk(args.dir):
        dirs[:] = sorted(d for d in dirs if d != "LICENSES")
        for f in sorted(files):
            if f.endswith(SKIP_SUFFIXES) or not f.endswith((".js", ".mjs", ".html")):
                continue
            path = os.path.join(root, f)
            text = open(path, encoding="utf-8", errors="replace").read()
            rel = os.path.relpath(path, args.dir)
            counts = {p: text.count(p) for p in PRIMITIVES}
            for p, n in counts.items():
                totals[p] += n
            print("SURFACE net " + rel + " " + " ".join(f"{p}={n}" for p, n in counts.items()))
    print("SURFACE net total " + " ".join(f"{p}={n}" for p, n in totals.items()))


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    i = sub.add_parser("imports")
    i.add_argument("--wasm", required=True)
    n = sub.add_parser("net")
    n.add_argument("--dir", required=True)
    args = ap.parse_args()
    {"imports": cmd_imports, "net": cmd_net}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
