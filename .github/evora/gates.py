#!/usr/bin/env python3
"""Evora CI gates for the web build of this fork (written by Evora; Python standard library only).

Subcommands (each prints `GATE ...` lines, appends Markdown to $GITHUB_STEP_SUMMARY and exits
non-zero when a blocking gate fails):

- `witness`: every detector is shown what it must find (fixtures); a detector that misses its
  fixture fails the job, so a silent gate can never pass for a green one.
- `site --dir DIR`: the packaged static site. Hosting files (.htaccess, _headers, *.conf) absent;
  ArtCraft marks (artcraft, discord.gg, getartcraft) absent from the site (LICENSES/ excepted);
  every precompressed .br/.gz file decompresses to its original; CSP hashes of the inline scripts
  written to DIR/csp-hashes.txt; sizes printed.
- `terms --repo DIR --mode measure|block`: sensitive third-party terms (Lumetri, Lightroom, Acrobat,
  Premiere, Adobe, Cycore) left in the displayed string literals once the display-name override
  catalogue of patch E9 (crates/ui-egui/src/i18n/neutral.rs, read from its source) is applied.
- `catalog --repo DIR --mode measure|block`: emoji and symbol audit of the displayed catalogues
  (string literals of crates/ui-egui/src and crates/engine/src, tests excluded), each character
  resolved through egui's font stack as installed by crates/ui-egui/src/theme.rs (the font that
  would draw it): a pictograph drawn by an emoji font, or any default-emoji character, is an
  emoji on screen.
"""

import argparse
import base64
import fnmatch
import glob
import gzip
import hashlib
import os
import re
import struct
import subprocess
import sys
import tempfile

BRAND_TERMS = ("artcraft", "discord.gg", "getartcraft")
HOSTING_NAMES = {".htaccess", "_headers"}
HOSTING_PATTERNS = ("*.conf",)
COMPRESSIBLE = {".wasm", ".js", ".mjs", ".html", ".svg", ".webmanifest", ".json", ".css"}
EMOJI_FONTS = {"NotoEmoji-Regular", "emoji-icon-font"}
# CSP Level 3 specification, example of a hash source: `alert('Hello, world.');`.
CSP_SPEC_SCRIPT = "alert('Hello, world.');"
CSP_SPEC_HASH = "sha256-qznLcsROx4GACP2dm0UCKCzCG+HiZ1guq6ZZDob/Tng="

FAILURES = []


def fail(msg):
    FAILURES.append(msg)
    print(f"::error::{msg}")


def summary(lines):
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    text = "\n".join(lines) + "\n"
    if path:
        with open(path, "a", encoding="utf-8") as f:
            f.write(text)
    else:
        sys.stdout.write(text)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


# ------------------------------------------------------------------------------------ site gates


def site_files(root):
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(filenames):
            out.append(os.path.relpath(os.path.join(dirpath, name), root).replace(os.sep, "/"))
    return out


def hosting_files(root):
    found = []
    for rel in site_files(root):
        name = rel.rsplit("/", 1)[-1]
        if name in HOSTING_NAMES or any(fnmatch.fnmatch(name, p) for p in HOSTING_PATTERNS):
            found.append(rel)
    return found


def brand_counts(data):
    low = data.lower()
    return {t: low.count(t.encode()) for t in BRAND_TERMS}


def inline_scripts(html):
    """The text of every <script> without a src attribute (what a CSP hash covers)."""
    out = []
    for m in re.finditer(r"<script\b([^>]*)>(.*?)</script\s*>", html, re.S | re.I):
        if re.search(r"\bsrc\s*=", m.group(1), re.I):
            continue
        out.append((m.group(1).strip(), m.group(2)))
    return out


def csp_hash(text):
    return "sha256-" + base64.b64encode(hashlib.sha256(text.encode("utf-8")).digest()).decode()


def decompress(path):
    if path.endswith(".gz"):
        with gzip.open(path, "rb") as f:
            return f.read()
    r = subprocess.run(["brotli", "-d", "-c", path], capture_output=True, check=False)
    if r.returncode != 0:
        raise RuntimeError(f"brotli -d {path}: {r.stderr.decode(errors='replace').strip()}")
    return r.stdout


def check_precompressed(root):
    """(checked, problems): every .br/.gz decompresses to its original; every compressible file has both."""
    files = set(site_files(root))
    problems, checked = [], 0
    for rel in sorted(files):
        if rel.startswith("LICENSES/") or rel.endswith((".br", ".gz")):
            continue
        if os.path.splitext(rel)[1] not in COMPRESSIBLE:
            continue
        original = open(os.path.join(root, rel), "rb").read()
        for ext in (".br", ".gz"):
            comp = rel + ext
            if comp not in files:
                problems.append(f"{comp} missing")
                continue
            try:
                if decompress(os.path.join(root, comp)) != original:
                    problems.append(f"{comp} does not decompress to {rel}")
                else:
                    checked += 1
            except Exception as e:  # noqa: BLE001 - reported as a gate failure
                problems.append(f"{comp}: {e}")
    for rel in sorted(files):
        if rel.endswith((".br", ".gz")) and rel[:-3] not in files:
            problems.append(f"{rel} has no original")
    return checked, problems


def cmd_witness(_args):
    rows = ["### Témoins des portes (chaque détecteur voit ce qu'on lui montre)", ""]
    with tempfile.TemporaryDirectory() as tmp:
        # Hosting files: three to find, one decoy.
        os.makedirs(os.path.join(tmp, "host", "sub"))
        for rel in ("_headers", "sub/.htaccess", "sub/site.conf", "sub/conference.txt"):
            open(os.path.join(tmp, "host", rel), "w").close()
        found = hosting_files(os.path.join(tmp, "host"))
        ok = found == ["_headers", "sub/.htaccess", "sub/site.conf"]
        rows.append(f"- hébergement : {len(found)}/3 {'OK' if ok else 'ÉCHEC'}")
        if not ok:
            fail(f"témoin hébergement : {found}")
        # Brand marks, case-insensitive, in bytes (a wasm module is binary).
        counts = brand_counts(b"\x00xxArtCraftyy artcraft discord.gg/abc getartcraft.com\xff")
        ok = counts == {"artcraft": 3, "discord.gg": 1, "getartcraft": 1}
        rows.append(f"- marques : {counts} {'OK' if ok else 'ÉCHEC'}")
        if not ok:
            fail(f"témoin marques : {counts}")
        # CSP hash: the specification's own example, an external script ignored.
        html = f'<script src="a.js"></script><script>{CSP_SPEC_SCRIPT}</script><script type="module">x</script>'
        scripts = inline_scripts(html)
        ok = len(scripts) == 2 and csp_hash(scripts[0][1]) == CSP_SPEC_HASH
        rows.append(f"- empreinte CSP (exemple de la spécification CSP3) : {'OK' if ok else 'ÉCHEC'}")
        if not ok:
            fail("témoin CSP : l'empreinte de l'exemple de la spécification diffère")
        # Precompressed files: a good pair passes, a tampered .gz and a missing .br are caught.
        site = os.path.join(tmp, "site")
        os.makedirs(site)
        for name, body in (("a.js", b"console.log(1);\n" * 50), ("b.html", b"<p>b</p>\n")):
            with open(os.path.join(site, name), "wb") as f:
                f.write(body)
        for name in ("a.js", "b.html"):
            subprocess.run(["gzip", "-9", "-n", "-k", os.path.join(site, name)], check=True)
        subprocess.run(["brotli", "-q", "11", "-k", os.path.join(site, "a.js")], check=True)
        with gzip.open(os.path.join(site, "b.html.gz"), "wb") as f:
            f.write(b"tampered")
        checked, problems = check_precompressed(site)
        ok = checked == 2 and sorted(problems) == ["b.html.br missing", "b.html.gz does not decompress to b.html"]
        rows.append(f"- précompression : {checked} vérifiés, {len(problems)} défauts attendus {'OK' if ok else 'ÉCHEC'}")
        if not ok:
            fail(f"témoin précompression : {checked} {problems}")
    rows.append("")
    summary(rows)
    print("\n".join(rows))
    return 1 if FAILURES else 0


def cmd_site(args):
    root = args.dir
    rows = [f"### Portes du site `{os.path.basename(root.rstrip('/'))}`", "", "| Porte | Mesure | Cible | Bloquante |", "|---|---|---|---|"]
    files = site_files(root)
    # Hosting files.
    hosting = hosting_files(root)
    rows.append(f"| Fichiers d'hébergement (.htaccess, _headers, *.conf) | {len(hosting)} {' '.join(hosting)} | 0 | oui |")
    if hosting:
        fail(f"fichiers d'hébergement dans l'artefact : {hosting}")
    # Brand marks in the site (LICENSES/ keeps the upstream copyright notices).
    totals = {t: 0 for t in BRAND_TERMS}
    per_file = []
    scanned = 0
    for rel in files:
        if rel.startswith("LICENSES/") or rel.endswith((".br", ".gz")):
            continue
        scanned += 1
        c = brand_counts(open(os.path.join(root, rel), "rb").read())
        for t in BRAND_TERMS:
            totals[t] += c[t]
        if any(c.values()):
            per_file.append(f"{rel} {c}")
    lic = sum(brand_counts(open(os.path.join(root, r), "rb").read())["artcraft"] for r in files if r.startswith("LICENSES/"))
    for t in BRAND_TERMS:
        rows.append(f"| « {t} » (casse ignorée) dans le site ({scanned} fichiers) | {totals[t]} | 0 | oui |")
    rows.append(f"| « artcraft » dans LICENSES/ (mentions conservées) | {lic} | conservées | non |")
    if any(totals.values()):
        fail(f"marques ArtCraft dans le site : {totals} ({'; '.join(per_file)})")
    # Precompressed files.
    checked, problems = check_precompressed(root)
    rows.append(f"| Fichiers .br/.gz vérifiés (décompressés = originaux) | {checked}, défauts {len(problems)} | tous | oui |")
    for p in problems:
        fail(f"précompression : {p}")
    if checked == 0:
        fail("précompression : aucun fichier .br/.gz")
    # CSP hashes of the inline scripts of every HTML page.
    lines = [
        "# CSP: SHA-256 hash sources of the inline scripts (script-src), one per line, then the page.",
        "# Generated by .github/evora/gates.py from the packaged pages; the provisioning copies them",
        "# into the engine's Content-Security-Policy.",
    ]
    nhash = 0
    for rel in files:
        if not rel.endswith(".html"):
            continue
        html = open(os.path.join(root, rel), encoding="utf-8").read()
        for i, (attrs, text) in enumerate(inline_scripts(html), 1):
            h = csp_hash(text)
            lines.append(f"'{h}'  {rel}  script#{i} {attrs or '(classic)'} {len(text.encode())} bytes")
            rows.append(f"| Empreinte CSP `{rel}` script#{i} | `'{h}'` | — | — |")
            nhash += 1
    with open(os.path.join(root, "csp-hashes.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    if nhash == 0:
        fail("aucun script inline trouvé dans les pages : l'empreinte CSP ne couvre rien")
    # Sizes.
    wasm = [r for r in files if r.endswith(".wasm")]
    for rel in wasm:
        raw = os.path.getsize(os.path.join(root, rel))
        br = os.path.getsize(os.path.join(root, rel + ".br")) if os.path.exists(os.path.join(root, rel + ".br")) else -1
        gz = os.path.getsize(os.path.join(root, rel + ".gz")) if os.path.exists(os.path.join(root, rel + ".gz")) else -1
        rows.append(f"| Taille `{rel}` brut / .br / .gz | {raw} / {br} / {gz} octets | mesure | non |")
        print(f"GATE size {rel} raw={raw} br={br} gz={gz}")
    total = sum(os.path.getsize(os.path.join(root, r)) for r in site_files(root))
    rows.append(f"| Taille totale du dossier (avec .br/.gz, LICENSES/) | {total} octets | mesure | non |")
    print(f"GATE site hosting={len(hosting)} brand={totals} licenses_artcraft={lic} precompressed_ok={checked} problems={len(problems)} csp_hashes={nhash} total={total}")
    rows.append("")
    summary(rows)
    return 1 if FAILURES else 0


# ------------------------------------------------------------------------------- catalogue audit


def _skip_ws_comments(src, i):
    n = len(src)
    while i < n:
        if src.startswith("//", i):
            j = src.find("\n", i)
            i = n if j < 0 else j + 1
        elif src.startswith("/*", i):
            depth, i = 1, i + 2
            while i < n and depth:
                if src.startswith("/*", i):
                    depth, i = depth + 1, i + 2
                elif src.startswith("*/", i):
                    depth, i = depth - 1, i + 2
                else:
                    i += 1
        elif src[i].isspace():
            i += 1
        else:
            break
    return i


_ESC = {"n": "\n", "t": "\t", "r": "\r", "0": "\0", "\\": "\\", '"': '"', "'": "'"}


def _cooked(body):
    out, i = [], 0
    while i < len(body):
        c = body[i]
        if c != "\\":
            out.append(c)
            i += 1
            continue
        nx = body[i + 1] if i + 1 < len(body) else ""
        if nx in _ESC:
            out.append(_ESC[nx])
            i += 2
        elif nx == "u":
            m = re.match(r"\\u\{([0-9a-fA-F_]+)\}", body[i:])
            if m:
                out.append(chr(int(m.group(1).replace("_", ""), 16)))
                i += m.end()
            else:
                i += 2
        elif nx == "x":
            out.append(chr(int(body[i + 2:i + 4], 16)))
            i += 4
        elif nx == "\n":
            i += 2
            while i < len(body) and body[i] in " \t\r\n":
                i += 1
        else:
            out.append(nx)
            i += 2
    return "".join(out)


def _tokens(src):
    i, n = 0, len(src)
    while True:
        i = _skip_ws_comments(src, i)
        if i >= n:
            return
        c = src[i]
        m = re.match(r'(b?r)(#*)"', src[i:i + 300])
        if m and (i == 0 or not (src[i - 1].isalnum() or src[i - 1] == "_")):
            hashes = m.group(2)
            start = i + m.end()
            end = src.find('"' + hashes, start)
            end = n if end < 0 else end
            if not m.group(1).startswith("b"):
                yield ("str", i, src[start:end])
            i = end + 1 + len(hashes)
            continue
        if c == '"' or (src.startswith('b"', i) and (i == 0 or not (src[i - 1].isalnum() or src[i - 1] == "_"))):
            j = i + (2 if c == "b" else 1)
            begin = j
            while j < n and src[j] != '"':
                j += 2 if src[j] == "\\" else 1
            if c != "b":
                yield ("str", i, _cooked(src[begin:j]))
            i = j + 1
            continue
        if c == "'":
            m = re.match(r"'(\\u\{[0-9a-fA-F_]+\}|\\x[0-9a-fA-F]{2}|\\.|[^\\'\n])'", src[i:i + 20])
            if m:
                yield ("str", i, _cooked(m.group(1)))
                i += m.end()
            else:
                i += 1
            continue
        if src.startswith("#[cfg(test)]", i):
            yield ("test", i, "")
            i += 12
            continue
        if c in "{};":
            yield (c, i, "")
        i += 1


def rust_strings(src):
    """String and char literals outside comments and #[cfg(test)] items: [(line, text)]."""
    out, depth, skip, pending = [], 0, None, False
    for kind, pos, val in _tokens(src):
        if kind == "test":
            pending = True
        elif kind == "{":
            depth += 1
            if pending and skip is None:
                skip = depth
            pending = False
        elif kind == "}":
            if skip is not None and depth == skip:
                skip = None
            depth -= 1
        elif kind == ";":
            pending = False
        elif kind == "str" and skip is None and not pending:
            out.append((src.count("\n", 0, pos) + 1, val))
    return out


def font_cmap(path):
    """Code points mapped by a TrueType/OpenType font (cmap formats 4 and 12)."""
    data = open(path, "rb").read()
    num = struct.unpack(">H", data[4:6])[0]
    off = None
    for t in range(num):
        tag, _, toff, _ = struct.unpack(">4sIII", data[12 + 16 * t:28 + 16 * t])
        if tag == b"cmap":
            off = toff
    if off is None:
        raise ValueError(f"{path}: no cmap table")
    cps = set()
    for k in range(struct.unpack(">H", data[off + 2:off + 4])[0]):
        pid, eid, soff = struct.unpack(">HHI", data[off + 4 + 8 * k:off + 12 + 8 * k])
        base = off + soff
        fmt = struct.unpack(">H", data[base:base + 2])[0]
        if fmt == 4 and (pid, eid) in ((3, 1), (0, 0), (0, 1), (0, 3), (0, 4)):
            segx2 = struct.unpack(">H", data[base + 6:base + 8])[0]
            seg = segx2 // 2
            ends = struct.unpack(f">{seg}H", data[base + 14:base + 14 + segx2])
            starts = struct.unpack(f">{seg}H", data[base + 16 + segx2:base + 16 + 2 * segx2])
            deltas = struct.unpack(f">{seg}h", data[base + 16 + 2 * segx2:base + 16 + 3 * segx2])
            ro = base + 16 + 3 * segx2
            ranges = struct.unpack(f">{seg}H", data[ro:ro + segx2])
            for i in range(seg):
                for cp in range(starts[i], ends[i] + 1):
                    if cp == 0xFFFF:
                        continue
                    if ranges[i] == 0:
                        g = (cp + deltas[i]) & 0xFFFF
                    else:
                        gp = ro + 2 * i + ranges[i] + 2 * (cp - starts[i])
                        g = struct.unpack(">H", data[gp:gp + 2])[0]
                        g = (g + deltas[i]) & 0xFFFF if g else 0
                    if g:
                        cps.add(cp)
        elif fmt == 12:
            for gi in range(struct.unpack(">I", data[base + 12:base + 16])[0]):
                s, e, g = struct.unpack(">III", data[base + 16 + 12 * gi:base + 28 + 12 * gi])
                for cp in range(s, e + 1):
                    if g + (cp - s):
                        cps.add(cp)
    return cps


def unicode_props(chars):
    """{char: (Emoji, Emoji_Presentation, Extended_Pictographic, Symbol)} from Perl's Unicode tables."""
    script = (
        'no warnings; binmode STDIN, ":utf8"; local $/; my $s = <STDIN>; '
        'for my $c (split //, $s) { printf "%d %d %d %d %d\\n", ord($c), '
        '($c =~ /\\p{Emoji}/ ? 1 : 0), ($c =~ /\\p{Emoji_Presentation}/ ? 1 : 0), '
        '($c =~ /\\p{Extended_Pictographic}/ ? 1 : 0), ($c =~ /\\p{S}/ ? 1 : 0) }'
    )
    r = subprocess.run(["perl", "-e", script], input="".join(sorted(chars)).encode("utf-8"), capture_output=True, check=True)
    out = {}
    for line in r.stdout.decode().splitlines():
        a = [int(x) for x in line.split()]
        out[chr(a[0])] = tuple(bool(x) for x in a[1:])
    return out


# egui's font stacks as crates/ui-egui/src/theme.rs installs them on the web build (no system
# fallback there). `upstream`: egui's defaults with JetBrains Mono appended to every family but
# Monospace; `evora`: patch E10, text faces (Inter, Ubuntu Light, JetBrains Mono, Hack) ahead of
# the emoji faces, which stay last for user content.
STACKS = {
    "upstream": {
        "Proportional": ["inter", "Ubuntu-Light", "NotoEmoji-Regular", "emoji-icon-font", "jbmono"],
        "Monospace": ["jbmono", "Hack", "Ubuntu-Light", "NotoEmoji-Regular", "emoji-icon-font"],
    },
    "evora": {
        "Proportional": ["inter", "Ubuntu-Light", "jbmono", "Hack", "NotoEmoji-Regular", "emoji-icon-font"],
        "Monospace": ["jbmono", "Hack", "Ubuntu-Light", "inter", "NotoEmoji-Regular", "emoji-icon-font"],
    },
}


def egui_fonts(repo):
    lock = open(os.path.join(repo, "Cargo.lock"), encoding="utf-8").read()
    m = re.search(r'name = "epaint_default_fonts"\nversion = "([^"]+)"', lock)
    if not m:
        raise RuntimeError("epaint_default_fonts absent de Cargo.lock")
    home = os.environ.get("CARGO_HOME", os.path.expanduser("~/.cargo"))
    dirs = glob.glob(os.path.join(home, "registry", "src", "*", f"epaint_default_fonts-{m.group(1)}", "fonts"))
    if not dirs:
        raise RuntimeError(f"sources de epaint_default_fonts-{m.group(1)} introuvables sous {home}/registry/src")
    d = dirs[0]
    return {
        "inter": os.path.join(repo, "assets/fonts/Inter-Regular.ttf"),
        "jbmono": os.path.join(repo, "assets/fonts/JetBrainsMono-Regular.ttf"),
        "Ubuntu-Light": os.path.join(d, "Ubuntu-Light.ttf"),
        "Hack": os.path.join(d, "Hack-Regular.ttf"),
        "NotoEmoji-Regular": os.path.join(d, "NotoEmoji-Regular.ttf"),
        "emoji-icon-font": os.path.join(d, "emoji-icon-font.ttf"),
    }, m.group(1)


def catalogue_files(repo):
    out = []
    for root in ("crates/ui-egui/src", "crates/engine/src"):
        for p in sorted(glob.glob(os.path.join(repo, root, "**", "*.rs"), recursive=True)):
            rel = os.path.relpath(p, repo).replace(os.sep, "/")
            base = os.path.basename(p)
            if "/tests/" in rel or base.startswith("tests") or base == "tests.rs":
                continue
            out.append(rel)
    return out


def classify(ch, props, cov, stacks):
    emoji, presentation, pictographic, _symbol = props.get(ch, (False, False, False, False))
    drawn = {fam: next((f for f in stack if ord(ch) in cov[f]), None) for fam, stack in stacks.items()}
    by_emoji_font = any(f in EMOJI_FONTS for f in drawn.values())
    blocked = presentation or ch in "\ufe0f\u20e3" or ((emoji or pictographic) and by_emoji_font)
    return blocked, drawn


def cmd_catalog(args):
    repo = args.repo
    stacks = STACKS[args.stacks]
    paths, egui_ver = egui_fonts(repo)
    cov = {k: font_cmap(v) for k, v in paths.items()}
    rows = [f"### Audit des émojis et symboles des catalogues affichés (piles de polices `{args.stacks}`, epaint_default_fonts {egui_ver})", ""]
    # Witnesses: the lexer and the font tables must see what they are shown.
    fixture = (
        '// ✔ in a comment\nfn a() { let x = "✔ ok"; let y = r#"😀 raw"#; let c = \'⚠\'; }\n'
        "/* 🚫 */\n#[cfg(test)]\nmod tests { fn t() { let z = \"🔥 test\"; } }\nfn b() { let w = \"\\u{2714}\"; }\n"
    )
    got = [v for _, v in rust_strings(fixture)]
    lex_ok = got == ["✔ ok", "😀 raw", "⚠", "\u2714"]
    font_ok = ord("A") in cov["inter"] and 0x1F600 not in cov["inter"] and 0x1F600 in cov["NotoEmoji-Regular"]
    props_w = unicode_props({"✔", "😀", "✓"})
    props_ok = props_w["✔"][0] and props_w["😀"][1] and not any(props_w["✓"][:3])
    blocked_w, _ = classify("✔", props_w, cov, STACKS["upstream"])
    class_ok = blocked_w and not classify("✓", props_w, cov, STACKS["upstream"])[0]
    rows.append(
        f"Témoins : lexer {'OK' if lex_ok else 'ÉCHEC'}, tables de polices {'OK' if font_ok else 'ÉCHEC'}, "
        f"propriétés Unicode {'OK' if props_ok else 'ÉCHEC'}, classement ✔/✓ {'OK' if class_ok else 'ÉCHEC'}."
    )
    for name, ok in (("lexer", lex_ok), ("polices", font_ok), ("propriétés Unicode", props_ok), ("classement", class_ok)):
        if not ok:
            fail(f"témoin du catalogue en échec : {name} ({got if name == 'lexer' else ''})")
    chars, nstr = {}, 0
    files = catalogue_files(repo)
    for rel in files:
        for line, text in rust_strings(open(os.path.join(repo, rel), encoding="utf-8").read()):
            nstr += 1
            for ch in text:
                if ord(ch) > 0x7F:
                    chars.setdefault(ch, {}).setdefault(f"{rel}:{line}", 0)
                    chars[ch][f"{rel}:{line}"] += 1
    props = unicode_props(set(chars))
    blocked, symbols = [], []
    for ch in sorted(chars):
        is_blocked, drawn = classify(ch, props, cov, stacks)
        emoji, presentation, pictographic, symbol = props.get(ch, (False, False, False, False))
        where = chars[ch]
        n = sum(where.values())
        sample = ", ".join(sorted(where)[:4]) + (" …" if len(where) > 4 else "")
        row = (ch, f"U+{ord(ch):04X}", emoji, presentation, pictographic, drawn, n, sample)
        if is_blocked:
            blocked.append(row)
        elif emoji or pictographic or symbol or any(f in EMOJI_FONTS for f in drawn.values()):
            symbols.append(row)
    rows.append(f"{len(files)} fichiers, {nstr} littéraux, {len(chars)} caractères non ASCII distincts.")
    rows.append("")
    rows.append("| Car. | Code | Emoji | Présentation emoji | Pictographe | Police (prop. / mono) | Occ. | Où | Verdict |")
    rows.append("|---|---|---|---|---|---|---|---|---|")
    for ch, cp, e, ep, xp, drawn, n, sample in blocked + symbols:
        verdict = "**émoji au rendu**" if (ch, cp, e, ep, xp, drawn, n, sample) in blocked else "symbole"
        rows.append(f"| {ch} | {cp} | {int(e)} | {int(ep)} | {int(xp)} | {drawn['Proportional']} / {drawn['Monospace']} | {n} | {sample} | {verdict} |")
    rows.append("")
    print(f"GATE catalog stacks={args.stacks} mode={args.mode} files={len(files)} strings={nstr} chars={len(chars)} emoji_rendered={len(blocked)} symbols={len(symbols)}")
    for ch, cp, *_rest in blocked:
        print(f"GATE catalog emoji {cp} {ch} {_rest[-1]}")
    if blocked:
        msg = f"{len(blocked)} caractère(s) émoji au rendu dans les catalogues : " + " ".join(f"{r[1]} {r[0]}" for r in blocked)
        if args.mode == "block":
            fail(msg)
        else:
            print(f"::warning::{msg} (mesure, bloquante avec E10)")
    summary(rows)
    return 1 if FAILURES else 0


SENSITIVE_TERMS = ("Lumetri", "Lightroom", "Acrobat", "Premiere", "Adobe", "Cycore", "Premiere Pro Compatible")
NEUTRAL_RS = "crates/ui-egui/src/i18n/neutral.rs"
TERM_ROOTS = ("crates/ui-egui/src", "crates/engine/src", "crates/effects/src", "crates/interchange/src")


def read_rules(repo):
    """The (term, neutral) pairs of the display-name override catalogue (patch E9), from its source."""
    src = open(os.path.join(repo, NEUTRAL_RS), encoding="utf-8").read()
    m = re.search(r"pub\(crate\) const RULES: &\[\(&str, &str\)\] = &\[(.*?)\n\];", src, re.S)
    if not m:
        raise RuntimeError(f"RULES introuvable dans {NEUTRAL_RS}")
    lits = [v for _, v in rust_strings(m.group(1))]
    if not lits or len(lits) % 2:
        raise RuntimeError(f"RULES illisible dans {NEUTRAL_RS} ({len(lits)} littéraux)")
    return list(zip(lits[0::2], lits[1::2]))


def apply_rules(rules, text):
    if not any(t in text for t in ("Adobe", "Premiere", "Lumetri")):
        return text
    for a, b in rules:
        text = text.replace(a, b)
    return text


def cmd_terms(args):
    repo = args.repo
    rules = read_rules(repo)
    rows = [f"### Termes sensibles des chaînes affichées, après le catalogue de surcharge E9 ({len(rules)} règles)", ""]
    # Witnesses: a covered phrase is neutralised, an uncovered term is still seen.
    w1 = apply_rules(rules, "Adobe Premiere Pro Project...")
    w2 = apply_rules(rules, "Cycore Particle World")
    w_ok = w1 == "FCP XML Project..." and "Cycore" in w2
    rows.append(f"Témoins : règle appliquée « {w1} », terme non couvert vu « {w2} » : {'OK' if w_ok else 'ÉCHEC'}.")
    if not w_ok:
        fail("témoin des termes en échec")
    before = {t: 0 for t in SENSITIVE_TERMS}
    after = {t: 0 for t in SENSITIVE_TERMS}
    left = []
    nfiles = nstr = 0
    for root in TERM_ROOTS:
        for p in sorted(glob.glob(os.path.join(repo, root, "**", "*.rs"), recursive=True)):
            rel = os.path.relpath(p, repo).replace(os.sep, "/")
            base = os.path.basename(p)
            if "/tests/" in rel or base.startswith("tests") or base == "tests.rs" or rel == NEUTRAL_RS:
                continue
            nfiles += 1
            for line, text in rust_strings(open(p, encoding="utf-8").read()):
                nstr += 1
                shown = apply_rules(rules, text)
                for t in SENSITIVE_TERMS:
                    before[t] += text.count(t)
                    n = shown.count(t)
                    after[t] += n
                    if n:
                        left.append(f"{rel}:{line} « {shown[:90]} »")
    rows.append(f"{nfiles} fichiers ({', '.join(TERM_ROOTS)}), {nstr} littéraux, casse respectée (les identifiants en minuscules ne sont pas affichés).")
    rows.append("")
    rows.append("| Terme | Avant E9 | Affiché après E9 | Verdict |")
    rows.append("|---|---|---|---|")
    for t in SENSITIVE_TERMS:
        verdict = "SANS_OBJET (absent du dépôt)" if before[t] == 0 else ("OK" if after[t] == 0 else "**reste affiché**")
        rows.append(f"| {t} | {before[t]} | {after[t]} | {verdict} |")
        print(f"GATE terms {t.replace(' ', '_')} before={before[t]} after={after[t]}")
    rows.append("")
    for x in sorted(set(left))[:40]:
        rows.append(f"- reste : {x}")
    if left:
        msg = f"{len(set(left))} chaîne(s) affichée(s) gardent un terme sensible après E9"
        if args.mode == "block":
            fail(msg)
        else:
            print(f"::warning::{msg}")
    summary(rows)
    return 1 if FAILURES else 0


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("witness")
    s = sub.add_parser("site")
    s.add_argument("--dir", required=True)
    c = sub.add_parser("catalog")
    c.add_argument("--repo", default=".")
    c.add_argument("--mode", choices=("measure", "block"), default="block")
    c.add_argument("--stacks", choices=tuple(STACKS), required=True)
    t = sub.add_parser("terms")
    t.add_argument("--repo", default=".")
    t.add_argument("--mode", choices=("measure", "block"), default="block")
    args = p.parse_args()
    return {"witness": cmd_witness, "site": cmd_site, "catalog": cmd_catalog, "terms": cmd_terms}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
