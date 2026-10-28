// Evora CI smoke test (written by Evora; Node with a global WebSocket, no dependency).
//
// Headless Chrome (the runner's own) loads a parent page served on origin B; the parent frames the
// engine page served on origin A (another port). Over the DevTools protocol the test waits for the
// engine to start inside the cross-origin iframe and requires: the engine's execution context on
// origin A, `window.effectcraftLoad.readyMs` set without error, the canvas present and sized, the
// loading notice gone, the parent unable to read the frame (cross-origin), and no page error (no
// exception, no console error, no error log entry, no Content-Security-Policy issue) in the page,
// the frame or the engine's workers. It also reads the menus the engine draws (`ui.menu.list` in
// every catalog language) and the widgets on screen (`ui.elements`), and counts ArtCraft marks and
// default-emoji characters in them, and sensitive terms in the menu labels as drawn. Prints `SMOKE` lines, a JSON report and a
// screenshot; exits non-zero on failure. Every pass that started also requires (EVORA-KIN-25) the
// engine's graphics device alive at its end (no « device lost » notice, js/host.js showDeviceLost)
// and widgets on screen (`ui.elements` not empty): the screen checks never judge an empty list.
//
//   node smoke.mjs --parent=http://127.0.0.1:8602/parent.html --engine=http://127.0.0.1:8601 \
//     --label=plain --out=/tmp/smoke [--chrome=google-chrome] [--timeout=240000] [--terms=block]
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const opt = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)=(.*)$/s);
  if (m) opt[m[1]] = m[2];
}
const chrome = opt.chrome || "google-chrome";
const parentUrl = opt.parent;
const engineOrigin = opt.engine;
const label = opt.label || "smoke";
const out = opt.out || join(tmpdir(), "evora-smoke");
const timeoutMs = Number(opt.timeout || 240000);
const settleMs = Number(opt.settle || 5000);
const termsMode = opt.terms || "measure";
// `--links=block` (patch E7): Help links run inside the engine must open no page and log no error.
const linksMode = opt.links || "off";
// `--expect-lang=fr` (patch E3): the engine was framed with `?lang=fr`: its menus must start translated.
const expectLang = opt["expect-lang"] || "";
// `--ehp=memory|opfs` (patches E4, E5): the parent page is the « pont-ehp » bench
// (ehp-parent.html), a minimal Evora shell; the engine speaks EHP v1 to it (`?host=evora`, the
// parent admitted by evora-host.json) with browser storage off (`memory`, `?storage=memory` as
// Evora imposes it) or namespaced (`opfs`). `--ehp-ns`: the `storageNs` of evora:init;
// `--ehp-url-ns`: a namespace planted in the engine's URL, which must be ignored.
const ehpMode = opt.ehp || "";
const ehpNs = opt["ehp-ns"] || "";
const ehpUrlNs = opt["ehp-url-ns"] || "";
// `--ehp-leg=keys-1|keys-2` (correction 1 of lot KIN-FK-B2): the member's keyboard shortcuts
// across a restart of the editor ([ehp-keys-reload], [ehp-keys-active], [ehp-keys-pin],
// [ehp-keys-upstream], [ehp-keys-reset]): two passes of the « pont-ehp » bench in its browser
// storage mode, on one Chrome profile (`--profile`), each ending after the document is open.
const ehpLeg = ["keys-1", "keys-2"].includes(opt["ehp-leg"]) ? opt["ehp-leg"] : "";
// `--expect-theme=light` (patch E2): the engine was framed with `?theme=light`.
const expectTheme = opt["expect-theme"] || "";
// `--witness-require=A|B` and `--witness-tolerate=C|D` (EVORA-KIN-20): a witness pass, against a
// sabotaged engine, page or bench file. It must fail on each required finding (text found in the
// failure), and on nothing else but the tolerated ones (consequences of the same sabotage):
// exactly what its sabotage breaks. Then, and only then, it exits 0 (`SMOKE_WITNESS ... ok=true`);
// its `SMOKE` line still says ok=false.
const witnessRequire = (opt["witness-require"] || "").split("|").filter(Boolean);
const witnessTolerate = (opt["witness-tolerate"] || "").split("|").filter(Boolean);
// `--languages=en,fr` (EVORA-KIN-25): the catalog languages whose menus are read (all by default;
// the device-loss witness reads English only).
const LANGUAGES = opt.languages ? opt.languages.split(",").filter(Boolean) : ["en", "ja", "zh-hans", "zh-hant", "uk", "es", "pt-br", "ru", "fr", "de", "cs"];
const BRAND = /artcraft|discord\.gg|getartcraft/i;
const EMOJI = /\p{Emoji_Presentation}|\u{FE0F}|\u{20E3}/u;
const PICTO = /\p{Extended_Pictographic}/u;
const TERMS = /lumetri|lightroom|acrobat|premiere|adobe|cycore/i;
mkdirSync(out, { recursive: true });
if (!parentUrl || !engineOrigin) {
  console.error("usage: --parent=URL --engine=ORIGIN");
  process.exit(2);
}
if (typeof WebSocket !== "function") {
  console.error("this Node has no global WebSocket (Node >= 22, or --experimental-websocket)");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The longest a poll of the engine's start may take before it is asked again.
const LOAD_POLL_MS = 2000;
const errors = [];
const warnings = [];
const logs = [];
const issues = [];
// KIN-03: the browser's downloads (Browser.downloadWillBegin), refused by Chrome all the same.
const downloads = [];
const contexts = new Map();
const sessions = new Map();
const report = { label, parentUrl, engineOrigin, ok: false };

// `--profile=DIR` (correction 1 of lot KIN-FK-B2): Chrome's profile, kept for a later pass (the
// second leg of `--ehp-leg`); a fresh one otherwise.
const profile = opt.profile || mkdtempSync(join(tmpdir(), "evora-chrome-"));
if (opt.profile) {
  mkdirSync(profile, { recursive: true });
  // The lock files a killed browser leaves must not make the next one refuse the profile.
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) rmSync(join(profile, f), { force: true });
}
const DEFAULT_FLAGS = [
  "--headless=new",
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-sync",
  "--enable-unsafe-webgpu",
  "--enable-unsafe-swiftshader",
  "--use-angle=swiftshader",
  "--ignore-gpu-blocklist",
  // EVORA-KIN-28: on the runner's software GPU the page's WebGPU device was lost in every pass
  // (Q-15-3), the GPU process alive (GPU.ProcessLifetimeEvents: one launch, no crash, run
  // 39194377234): Chrome found no shared image able to back the WebGPU canvas
  // (« Could not find SharedImageBackingFactory … WebgpuSwapChainTexture … », then « GPU state
  // invalid »). Vulkan in the GPU process, on SwiftShader, keeps it (GPU probe of run 39196935391:
  // kept 120 s with these four switches, and with the first two alone; lost in 3 s without them,
  // lost after 50 s with ANGLE on Vulkan). The WebGPU adapter is named and the fallback to GL
  // (the configuration that loses the device) refused, so that a change of the runner shows.
  // The GPU watchdog (EVORA-KIN-27) changed nothing and is not stopped.
  "--enable-features=Vulkan",
  "--use-vulkan=swiftshader",
  "--use-webgpu-adapter=swiftshader",
  "--disable-vulkan-fallback-to-gl-for-testing",
  "--window-size=1400,900",
];
const flags = [...DEFAULT_FLAGS, "about:blank"];
report.chromeFlags = flags.filter((f) => !f.startsWith("--user-data-dir="));
const proc = spawn(chrome, flags, { stdio: ["ignore", "ignore", "pipe"] });
let chromeErr = "";
// Chrome's own lines about the GPU (EVORA-KIN-25): its GPU process, the watchdog, Vulkan, Dawn,
// SwiftShader; printed (SMOKE_GPU_LOG) when the graphics device is lost or no widget is on screen.
const GPU_LOG = /gpu|watchdog|vulkan|dawn|swiftshader|webgpu|angle|crash|exited|terminat/i;
const GPU_LOG_MAX = 300;
const gpuLog = [];
let stderrTail = "";
const wsUrl = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`Chrome did not print its DevTools URL: ${chromeErr.slice(-2000)}`)), 30000);
  proc.stderr.on("data", (d) => {
    chromeErr = (chromeErr + d).slice(-100000);
    const lines = (stderrTail + d).split("\n");
    stderrTail = lines.pop();
    for (const l of lines) if (GPU_LOG.test(l) && gpuLog.length < GPU_LOG_MAX) gpuLog.push(`${Date.now()} ${l.slice(0, 400)}`);
    const m = chromeErr.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) {
      clearTimeout(t);
      resolve(m[1]);
    }
  });
  proc.on("exit", (code) => reject(new Error(`Chrome exited (${code}): ${chromeErr.slice(-2000)}`)));
});

const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error("DevTools websocket error"));
});
let nextId = 1;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(typeof m.data === "string" ? m.data : m.data.toString());
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject, method } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
    else resolve(msg.result);
    return;
  }
  onEvent(msg);
};

function send(method, params = {}, sessionId) {
  const id = nextId++;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
}

function where(msg) {
  const s = sessions.get(msg.sessionId);
  return s ? `${s.type} ${s.url}` : "browser";
}

function onEvent(msg) {
  const p = msg.params || {};
  switch (msg.method) {
    case "Target.attachedToTarget":
      sessions.set(p.sessionId, { type: p.targetInfo.type, url: p.targetInfo.url });
      setup(p.sessionId, p.targetInfo.type).catch((e) => warnings.push(`attach ${p.targetInfo.type}: ${e.message}`));
      break;
    case "Runtime.executionContextCreated": {
      const c = p.context;
      contexts.set(`${msg.sessionId}:${c.id}`, { sessionId: msg.sessionId, id: c.id, origin: c.origin, isDefault: !!(c.auxData && c.auxData.isDefault), frameId: c.auxData ? c.auxData.frameId : null });
      break;
    }
    case "Runtime.executionContextDestroyed":
      contexts.delete(`${msg.sessionId}:${p.executionContextId}`);
      break;
    case "Runtime.executionContextsCleared":
      for (const k of [...contexts.keys()]) if (k.startsWith(`${msg.sessionId}:`)) contexts.delete(k);
      break;
    case "Runtime.exceptionThrown": {
      const d = p.exceptionDetails || {};
      errors.push(`exception [${where(msg)}] ${d.exception?.description ?? d.text} @ ${d.url ?? ""}:${d.lineNumber ?? ""}`);
      break;
    }
    case "Runtime.consoleAPICalled": {
      const text = (p.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
      const line = `console.${p.type} [${where(msg)}] ${text}`;
      if (p.type === "error" || p.type === "assert") errors.push(line);
      else if (p.type === "warning") warnings.push(line);
      else logs.push(line);
      break;
    }
    case "Log.entryAdded": {
      const e = p.entry || {};
      const line = `log.${e.level} ${e.source} [${where(msg)}] ${e.text} ${e.url ?? ""}`;
      if (e.level === "error") errors.push(line);
      else if (e.level === "warning") warnings.push(line);
      break;
    }
    case "Browser.downloadWillBegin":
    case "Page.downloadWillBegin":
      downloads.push({ method: msg.method, url: String(p.url || "").slice(0, 120), name: p.suggestedFilename || "" });
      break;
    case "Audits.issueAdded":
      if (p.issue && p.issue.code === "ContentSecurityPolicyIssue") {
        issues.push(JSON.stringify(p.issue.details?.contentSecurityPolicyIssueDetails ?? p.issue));
      }
      break;
    default:
  }
}

async function setup(sessionId, type) {
  try {
    const tasks = [send("Runtime.enable", {}, sessionId), send("Log.enable", {}, sessionId).catch(() => {})];
    if (type === "page" || type === "iframe") {
      tasks.push(send("Page.enable", {}, sessionId), send("Audits.enable", {}, sessionId).catch(() => {}));
    }
    tasks.push(send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId).catch(() => {}));
    await Promise.all(tasks);
  } finally {
    await send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
  }
}

async function evalIn(ctx, expression, awaitPromise = false, timeout = 30000) {
  const r = await send("Runtime.evaluate", { expression, contextId: ctx.id, returnByValue: true, awaitPromise, timeout }, ctx.sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

const defaultCtx = (origin) => [...contexts.values()].find((c) => c.origin === origin && c.isDefault);
// The parent page's own context (its main frame: a rogue frame of the « pont-ehp » bench shares
// its origin).
let mainFrameId = null;
let navigatedAt = 0;
// The page's CDP session (lot KIN-FK-B2: a capture of the dark E2-KIN palette mid-pass).
let pageSession = null;
const parentCtx = (origin) => [...contexts.values()].find((c) => c.origin === origin && c.isDefault && (!mainFrameId || c.frameId === mainFrameId));

function check(cond, msg) {
  if (!cond) {
    report.failures.push(msg);
    console.log(`::error::smoke ${label}: ${msg}`);
  }
}

// Diagnostics (EVORA-KIN-18), never a verdict: what the engine's frame shows at a given moment:
// the page's visibility, how many animation frames it gets in a second, the editor's state as it
// reports it (ui.inspect: theme, frames per second, widgets registered by the last drawn frame,
// dialog), the appearance setting, the compositor. Printed as `SMOKE_DIAG <label> <where> {...}`.
const DIAG_WAIT_MS = 5000;
const ENGINE_DIAG = `(async () => {
  const within = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r("timeout"), ${DIAG_WAIT_MS}))]);
  const raf = await within(new Promise((res) => { let n = 0; const t0 = performance.now();
    const tick = () => { n += 1; if (performance.now() - t0 < 1000) requestAnimationFrame(tick); else res(n); }; requestAnimationFrame(tick); }));
  let inspect = null;
  try { const r = await within(window.effectcraft.request("ui.inspect", {}));
    inspect = r && r.ui ? { theme: r.ui.theme, fps: Math.round(r.fps || 0), elements: r.elements, windowFocused: r.windowFocused, dialog: r.dialog, window: r.window, renderMs: r.renderMs } : r;
  } catch (e) { inspect = "error " + String(e); }
  let mode = null;
  try { mode = await within(window.effectcraft.execute("prefs.get", { key: "appearance.appearanceMode" })); } catch (e) { mode = "error " + String(e); }
  let gpu = null;
  try { const i = window.effectcraft.info(); gpu = i ? { gpu: i.gpu, backend: i.backend } : null; } catch (e) { gpu = "error " + String(e); }
  const lost = document.getElementById("device-lost");
  return JSON.parse(JSON.stringify({ at: Date.now(), visibility: document.visibilityState, hasFocus: document.hasFocus(),
    deviceLost: lost ? (lost.querySelector("small") || lost).textContent.slice(0, 300) : false, raf, inspect, mode, gpu }));
})()`;
async function diag(ctx, where) {
  try {
    const d = await evalIn(ctx, ENGINE_DIAG, true, 30000);
    (report.diag = report.diag || []).push({ where, ...d });
    console.log(`SMOKE_DIAG ${label} ${where} ${JSON.stringify(d)}`);
  } catch (e) {
    console.log(`SMOKE_DIAG ${label} ${where} error ${e && e.message}`);
  }
}

// ------------------------------------------------------------------ graphics device and screen (EVORA-KIN-25)

// The notice the engine's page shows once its WebGPU device is lost (js/host.js showDeviceLost),
// its message, or false.
const LOST_NOTICE = `(() => { const n = document.getElementById("device-lost"); return n ? (n.querySelector("small") || n).textContent.slice(0, 300) : false; })()`;
// What the engine's frame shows at the end of a pass: the notice, the widgets of the last drawn
// frame (`ui.elements`, -1 when the answer isn't a list) and the frame workers' GPU (diagnostic).
const SCREEN_STATE = `(async () => { const lost = ${LOST_NOTICE};
  const els = await window.effectcraft.request("ui.elements", {});
  let workers = null; try { workers = window.effectcraft.info().frameWorkers; } catch (e) { workers = "error " + String(e); }
  return JSON.parse(JSON.stringify({ lost, elements: Array.isArray(els) ? els.length : -1, workers })); })()`;
// The adapter the engine's page gets (diagnostic): what the runner's browser offers WebGPU.
const ADAPTER_INFO = `(async () => { if (!navigator.gpu) return "no navigator.gpu";
  const a = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!a) return null; const i = a.info || {};
  return { vendor: i.vendor, architecture: i.architecture, device: i.device, description: i.description,
    fallback: !!(i.isFallbackAdapter || a.isFallbackAdapter), features: a.features ? a.features.size : null,
    maxTexture2D: a.limits ? a.limits.maxTextureDimension2D : null }; })()`;

// The GPU as the browser reports it (SystemInfo): devices, driver, feature status. Diagnostic.
async function systemGpu() {
  try {
    const si = await Promise.race([send("SystemInfo.getInfo"), sleep(15000).then(() => null)]);
    const g = (si && si.gpu) || {};
    report.systemGpu = si
      ? { devices: (g.devices || []).map((d) => `${d.vendorString || d.vendorId} ${d.deviceString || d.deviceId} (${d.driverVendor || "?"} ${d.driverVersion || "?"})`), featureStatus: g.featureStatus || null }
      : "timeout";
    console.log(`SMOKE_DIAG ${label} system-gpu ${JSON.stringify(report.systemGpu)}`);
  } catch (e) {
    console.log(`SMOKE_DIAG ${label} system-gpu error ${e && e.message}`);
  }
}

// The browser's GPU process histograms (lifetime, termination, crashes, hangs) and Chrome's GPU
// lines, printed when the device is lost or no widget is on screen. Diagnostic.
async function gpuEvidence() {
  try {
    const r = await Promise.race([send("Browser.getHistograms", { query: "GPU" }), sleep(10000).then(() => ({ histograms: [] }))]);
    const keep = (r.histograms || []).filter((h) => /Lifetime|Termination|Crash|Exit|Watchdog|Hang|Lost|WebGPU|Dawn/i.test(h.name)).slice(0, 40);
    for (const h of keep) console.log(`SMOKE_GPU_HISTOGRAM ${label} ${h.name} n=${h.count} ${(h.buckets || []).map((b) => `${b.low}:${b.count}`).join(",")}`);
    if (!keep.length) console.log(`SMOKE_GPU_HISTOGRAM ${label} none of ${(r.histograms || []).length}`);
  } catch (e) {
    console.log(`SMOKE_GPU_HISTOGRAM ${label} error ${e && e.message}`);
  }
  for (const l of gpuLog) console.log(`SMOKE_GPU_LOG ${label} ${l}`);
  console.log(`SMOKE_GPU_LOG ${label} ${gpuLog.length} line(s)${gpuLog.length >= GPU_LOG_MAX ? " (capped)" : ""}`);
}

// The checks of every pass that started: the device alive, widgets on screen.
async function judgeScreen(ctx) {
  let s;
  try {
    s = await evalIn(ctx, SCREEN_STATE, true, 60000);
  } catch (e) {
    s = { lost: `unreadable (${e && e.message})`, elements: -1, workers: null };
  }
  report.screen = s;
  let adapter = null;
  try {
    adapter = await evalIn(ctx, ADAPTER_INFO, true, 15000);
  } catch (e) {
    adapter = `error ${e && e.message}`;
  }
  report.screen.adapter = adapter;
  console.log(`SMOKE_GPU label=${label} lost=${JSON.stringify(s.lost)} elements=${s.elements} adapter=${JSON.stringify(adapter)} workers=${JSON.stringify(s.workers).slice(0, 800)}`);
  check(s.lost === false, `périphérique graphique perdu : ${s.lost}`);
  check(s.elements > 0, `aucun widget à l'écran (ui.elements : ${s.elements})`);
  return s;
}

// ------------------------------------------------------------------ « pont-ehp » (E4, E5)

// What the engine declares in evora:ready (src/ehp.rs), each capability exercised below;
// `storage.memory` only when it was framed in the memory mode (`?storage=memory`).
// Since the V1 bridge (lot KIN-FK-B1): doc.saved-ack, export.drive, pick.drive, media.need and
// ui.focus-out, each with its checks below ([ehp-sack], [ehp-export], [ehp-pick], [ehp-need],
// [ehp-focus]; [ehp-menus] and [ehp-cache] for the host mode of KIN-01 and KIN-02).
// Since lot KIN-FK-B2: command and command.catalog ([ehp-commands], [ehp-command], [ehp-command-scope],
// [ehp-command-params], [ehp-command-destructive]) and font.inject ([ehp-font], [ehp-font-worker]);
// the E2-KIN palette ([ehp-theme]) and the « Kinetika » keyboard profile ([ehp-keys]).
const EHP_CAPABILITIES = [
  "doc.open", "doc.save", "doc.saved-ack", "doc.dirty", "doc.request-save", "export.drive", "pick.drive", "media.need",
  "storage.ns", "storage.purge", "live.lang", "live.theme", "ui.focus-out", "command", "command.catalog", "font.inject",
];
const EHP_EXPECTED = ehpMode === "memory" ? [...EHP_CAPABILITIES, "storage.memory"] : EHP_CAPABILITIES;
const EHP_KNOWN = new Set([
  ...EHP_CAPABILITIES, "storage.memory", "doc.multi", "media.ranges", "command", "font.inject", "author", "ui.activity", "drop.files", "prefs.sync", "command.catalog",
]);
const EHP_OUTBOUND = new Set(["evora:ready", "evora:failed", "evora:ack", "evora:dirty", "evora:save", "evora:export", "evora:pick", "evora:need", "evora:focus-out", "evora:commands"]);
// command.catalog (Evora's rules of 2026-10-27 on command bridges, AVENANT §4 and §5): the catalog's
// white list (src/ehp/commands.rs), what it must hold, the removal markers of its ids and labels
// (fr, then de after evora:lang) and the exceptions, each justified one by one (CAT_EXCEPTIONS).
const CAT_FILE_ADMITTED = ["file.import", "file.importMultiple", "file.importSolid", "file.importPlaceholder", "file.importLottie", "file.newCompFromSelection", "file.exportLottie", "file.exportTimeline"];
const CAT_OFF = ["edit.editOriginal", "templates.saveAs", "anim.browsePresets"];
const CAT_PREMISE = ["file.import", "edit.undo", "edit.clear", "layer.newText", "project.newFolder", "layer.setBlendMode.mode-Multiply", "edit.purge.what-memory"];
const CAT_DESTRUCTIVE_PREMISE = ["edit.clear", "edit.cut", "edit.purge.what-memory", "layer.mask.removeAll"];
const CAT_MARK_ID = new Set(["delete", "remove", "cut", "clear", "flatten", "reset", "discard", "erase", "purge"]);
const CAT_MARK_LABEL = new Set([...CAT_MARK_ID, "supprimer", "effacer", "couper", "retirer", "réinitialiser", "vider", "purger", "aplatir", "löschen", "entfernen", "ausschneiden", "zurücksetzen", "leeren"]);
// Two effects of the Effect menu are named after what they remove from the picture: applying one
// adds an effect to the selected layer (Edit ▸ Undo takes it away), nothing of the member's goes.
const CAT_EXCEPTIONS = {
  "effect.apply.effect-ec.noise.removegrain": "applies the Remove Grain effect: adds an effect, removes nothing",
  "effect.apply.effect-ec.channel.removecolormatting": "applies the Remove Color Matting effect: adds an effect, removes nothing",
};
const CAT_BRAND = /effectcraft|artcraft|lumetri|premiere|adobe|cycore/i;
const CAT_ID = /^[a-z][A-Za-z0-9_.-]*$/;
// The words of an id (dots, dashes and camelCase split) and of a label (letters only).
const idWords = (id) => (String(id).match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) || []).map((w) => w.toLowerCase());
const labelWords = (l) => String(l).toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
// The catalog's hash recomputed (FNV-1a 64 of each id, \0, 1 or 0, \n).
const catalogHash = (cmds) => {
  const P = 0x100000001b3n;
  const M = (1n << 64n) - 1n;
  let h = 0xcbf29ce484222325n;
  const feed = (bytes) => {
    for (const b of bytes) h = ((h ^ BigInt(b)) * P) & M;
  };
  for (const c of cmds) {
    feed(new TextEncoder().encode(String(c.id)));
    feed([0, c.destructive ? 0x31 : 0x30, 0x0a]);
  }
  return h.toString(16).padStart(16, "0");
};
// ui.focus-out (the bridge's F6) never bound; keys that type no character may stand alone.
const KEY_FREE = /^(Delete|Backspace|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Escape|Enter|Tab|Home|End|PageUp|PageDown|F[0-9]{1,2})$/;
// A shortcut of a single character key: a letter, digit, punctuation, symbol, Space or keypad key
// without Ctrl, Cmd or Alt (Shift alone still types a character; WCAG 2.1.4).
const singleKey = (k) => {
  const s = String(k).replace(/^Physical\+/, "");
  let key;
  let mods;
  if (s.endsWith("++")) {
    key = "+";
    mods = s.slice(0, -2).split("+").filter(Boolean);
  } else {
    const parts = s.split("+");
    key = parts.pop();
    mods = parts;
  }
  return !mods.some((m) => m === "Ctrl" || m === "Cmd" || m === "Alt") && !KEY_FREE.test(key);
};
// E2-KIN (apps/kinetika/CONCEPTION-PRO.md §8.3 in Evora): WCAG contrast of the palette's pairs.
const luminance = (hex) => {
  const v = [1, 3, 5].map((i) => parseInt(String(hex).slice(i, i + 2), 16) / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
};
const contrast = (a, b) => {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const THEME_PAIRS = [
  ["text", "panelBg", 4.5], ["textDim", "panelBg", 4.5], ["textFaint", "panelBg", 4.5], ["textFaint", "rowAlt", 4.5],
  ["hotText", "panelBg", 4.5], ["timecode", "panelBg", 4.5], ["text", "rowSelected", 4.5], ["fieldBorder", "fieldBg", 3],
  ["keyframe", "tlBg", 3], ["cti", "tlBg", 3], ["keyframeSelected", "tlBg", 3], ["focus", "panelBg", 3],
];
const THEME_SURFACES = { light: { appBg: "#e4e4e7", panelBg: "#f4f4f5", fieldBg: "#ffffff", pasteboard: "#d4d4d4" }, dark: { appBg: "#09090b", panelBg: "#18181b", fieldBg: "#09090b", pasteboard: "#262626" } };
// The member's keys of `--ehp-leg` (correction 1 of lot KIN-FK-B2): an alias (a single key, the
// member's to add) on a command the profile leaves free, upstream's own keys recorded on another
// (the engine drops an override equal to them), and a copy of the profile with a key of its own.
const KEYS_LEG = { copy: "Evora banc", alias: { command: "timeline.reveal.rotation", keys: ["Q"] }, own: { command: "timeline.reveal.opacity", keys: ["Alt+O"] }, upstream: "timeline.reveal.position" };
// Menu commands the engine hides in the bridge (src/ehp.rs HIDDEN_COMMANDS: a sample) and others it
// keeps (the premise: the list is the engine's own).
const EHP_HIDDEN = ["file.newProject", "file.openDemoProject", "file.revealInFinder", "file.watchFolder", "effect.plugins.load", "help.github"];
const EHP_SHOWN = ["file.import", "file.save", "file.saveAs", "file.exportLottie", "comp.saveFrameAs"];
// After an evora:saved {ok: false}, how long the bench waits for an evora:dirty {dirty: false}
// that must not come (doc.saved-ack).
const EHP_SACK_SETTLE_MS = 2500;
// The exports, picks and needs of the V1 bridge (a render of three frames on the runner's software
// GPU included).
const EHP_V1_WAIT_MS = 90000;
const EHP_WAIT_MS = 30000;
const EHP_READY_WAIT_MS = 20000;
const EHP_ROGUE_SETTLE_MS = 1500;
const EHP_ADOPT_MS = 800;
const EHP_REWRITE_WAIT_MS = 2500;
// The engine's start (EVORA-KIN-20, KIN-22): on the runner's software GPU (SwiftShader) the
// page's graphics device is lost soon after the start and the page's thread is held for tens of
// seconds at a time that varies (about 50 s between the answers to evora:init and evora:open in
// run 38879898863; in run 38886463958 the hold began right after three prompt answers). The bench
// waits until the engine answers promptly EHP_SETTLE_STEADY times in a row, a second apart,
// before it opens the document, so that every answer of the protocol is then judged within
// EHP_WAIT_MS.
const EHP_SETTLE_MS = 240000;
const EHP_SETTLE_STEADY = 10;
const EHP_PROBE_MS = 3000;
// The engine's frame not painted (display: none): the time its animation frames take to stop, and
// how long evora:request-save may wait for its evora:save meanwhile.
const EHP_HIDE_SETTLE_MS = 1500;
const EHP_HIDDEN_WAIT_MS = 10000;
const EHP_OTHER_NS = "c".repeat(64);
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ENGINE_STORES = ["effectcraft", "effectcraft-cache", "effectcraft-handles"];
const NAMESPACED = /^evns-([A-Za-z0-9_-]{1,64})--(.+)$/;
// The namespace of an engine store's name ("" upstream's), null when it isn't the engine's (as
// js/host.js classifies them).
const storeNs = (name) => {
  if (ENGINE_STORES.includes(name)) return "";
  const m = NAMESPACED.exec(name);
  return m && ENGINE_STORES.includes(m[2]) ? m[1] : null;
};
const keyNs = (key) => {
  if (/^effectcraft/.test(key)) return "";
  const m = NAMESPACED.exec(key);
  return m ? m[1] : null;
};
const engineStores = (l) =>
  [...(l.opfs || []).map((n) => ["opfs", n, storeNs(n)]), ...(l.idb || []).map((n) => ["idb", n, storeNs(n)]), ...(l.ls || []).map((n) => ["ls", n, keyNs(n)])].filter(
    ([, , ns]) => ns !== null,
  );
const LISTING = `(async () => { const out = { opfs: [], idb: [], ls: [] };
  try { const root = await navigator.storage.getDirectory(); for await (const [n] of root.entries()) out.opfs.push(n); } catch (e) { out.opfsError = String(e); }
  try { out.idb = (await indexedDB.databases()).map((d) => d.name); } catch (e) { out.idbError = String(e); }
  try { for (let i = 0; i < localStorage.length; i++) out.ls.push(localStorage.key(i)); } catch (e) { out.lsError = String(e); }
  return out; })()`;
// Installed in the engine's page once the document is open. Every deletion the engine makes from
// then on, with the wall-clock time it completed (the purge's answer, stamped on the same clock by
// the parent page, must come after them; performance.now() of two documents isn't comparable).
// And every write the engine's page attempts (opening or creating an OPFS entry for writing,
// opening an IndexedDB database, setting a localStorage key), with the time it was asked: with
// OPFS some are seen while the document is edited (the premise), in the memory mode none at all,
// and after the purge's answer none, whether it would succeed or not (a stopped writer doesn't
// try).
const PURGE_HOOKS = `(() => { const log = (window.__evoraPurgeLog = []); const writes = (window.__evoraWriteLog = []); const at = () => Date.now();
  const rm = FileSystemDirectoryHandle.prototype.removeEntry;
  FileSystemDirectoryHandle.prototype.removeEntry = function (...a) { return rm.apply(this, a).then((v) => { log.push({ op: "opfs", name: a[0], at: at() }); return v; }); };
  const del = IDBFactory.prototype.deleteDatabase;
  IDBFactory.prototype.deleteDatabase = function (name) { const r = del.call(this, name); r.addEventListener("success", () => log.push({ op: "idb", name, at: at() })); return r; };
  const lr = Storage.prototype.removeItem;
  Storage.prototype.removeItem = function (k) { const v = lr.call(this, k); log.push({ op: "ls", name: k, at: at() }); return v; };
  for (const m of ["getDirectoryHandle", "getFileHandle"]) {
    const f = FileSystemDirectoryHandle.prototype[m];
    FileSystemDirectoryHandle.prototype[m] = function (name, opts) { if (opts && opts.create) writes.push({ op: "opfs:" + m, name, at: at() }); return f.call(this, name, opts); };
  }
  const cw = FileSystemFileHandle.prototype.createWritable;
  FileSystemFileHandle.prototype.createWritable = function (...a) { writes.push({ op: "opfs:createWritable", name: this.name, at: at() }); return cw.apply(this, a); };
  const op = IDBFactory.prototype.open;
  IDBFactory.prototype.open = function (...a) { writes.push({ op: "idb:open", name: a[0], at: at() }); return op.apply(this, a); };
  const si = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) { writes.push({ op: "ls:setItem", name: k, at: at() }); return si.call(this, k, v); };
  return true; })()`;
// KIN-03: every download the engine's page starts (an anchor with `download` clicked, an object
// URL handed to window.open), with the browser's own downloads (Browser.downloadWillBegin).
const DOWNLOAD_HOOKS = `(() => { const log = (window.__evoraDownloadLog = []);
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (...a) { if (this.hasAttribute("download")) log.push({ op: "a.download", name: this.getAttribute("download") }); return click.apply(this, a); };
  const open = window.open;
  window.open = function (...a) { log.push({ op: "window.open", url: String(a[0]).slice(0, 80) }); return open.apply(this, a); };
  return true; })()`;
// Animation frames the engine's frame gets in about a second (none when the browser doesn't paint it).
const RAF_COUNT = `new Promise((res) => { let n = 0; const t0 = performance.now();
  const tick = () => { n += 1; if (performance.now() - t0 < 1000) requestAnimationFrame(tick); }; requestAnimationFrame(tick);
  setTimeout(() => res(n), 1200); })`;

async function runEhp(ectx, parentOrigin) {
  const r = (report.ehp = { mode: ehpMode, ns: ehpNs, urlNs: ehpUrlNs, steps: [] });
  const note = (k, v) => r.steps.push({ [k]: v });
  const state = async () =>
    evalIn(parentCtx(parentOrigin), "JSON.parse(JSON.stringify({ log: __ehp.log, ids: __ehp.ids, harness: __ehp.harness, saves: __ehp.saves, acks: __ehp.acks, exports: __ehp.exports, picks: __ehp.picks, needs: __ehp.needs }))");
  const step = (name) => evalIn(parentCtx(parentOrigin), `__ehp.step.${name}()`);
  const stepWith = (name, ...args) => evalIn(parentCtx(parentOrigin), `__ehp.step.${name}(${args.map((a) => (a === undefined ? "undefined" : JSON.stringify(a))).join(", ")})`);
  const exec = (command, params) =>
    evalIn(ectx, `window.effectcraft.execute(${JSON.stringify(command)}, ${JSON.stringify(params || {})}).then((v) => JSON.parse(JSON.stringify(v ?? null)))`, true, 60000);
  const request = (method) => evalIn(ectx, `window.effectcraft.request(${JSON.stringify(method)}, {}).then((v) => JSON.parse(JSON.stringify(v ?? null)))`, true, 60000);
  // A request with parameters, its failure as {rejected: message} (a refused command).
  const requestWith = (method, params) =>
    evalIn(
      ectx,
      `window.effectcraft.request(${JSON.stringify(method)}, ${JSON.stringify(params || {})}).then((v) => JSON.parse(JSON.stringify(v ?? null)), (e) => ({ rejected: String((e && e.message) || e) }))`,
      true,
      60000,
    );
  const listing = () => evalIn(ectx, LISTING, true);
  const until = async (what, pred, ms = EHP_WAIT_MS) => {
    const end = Date.now() + ms;
    let s = await state();
    while (!pred(s) && Date.now() < end) {
      await sleep(200);
      s = await state();
    }
    const ok = pred(s);
    check(ok, `[ehp] ${what} : rien en ${ms} ms`);
    return ok ? s : null;
  };
  const answersTo = (s, id) => s.log.filter((m) => id && m.re === id);
  const ackOk = (s, id, code) => {
    const a = answersTo(s, id).filter((m) => m.type === "evora:ack");
    return a.length === 1 && a[0].payload && a[0].payload.ok === true && (code === undefined || a[0].payload.code === code);
  };
  const labelsOf = (items) => (items || []).flatMap((it) => [String(it.label ?? ""), ...(it.path || []).map(String)]);
  const seeded = {
    opfs: ["effectcraft", "effectcraft-cache", `evns-${EHP_OTHER_NS}--effectcraft`, `evns-${EHP_OTHER_NS}--effectcraft-cache`, "evns-ci-a--effectcraft", `evns-${ehpNs}--effectcraft-cache`, "evora-keep"],
    idb: ["effectcraft-handles", `evns-${EHP_OTHER_NS}--effectcraft-handles`, `evns-${ehpNs}--effectcraft-handles`, "evora-keep"],
    ls: [`evns-${EHP_OTHER_NS}--effectcraft`, "effectcraft-seed", `evns-${ehpNs}--effectcraft`, "evora-keep"],
  };
  // The account's own stores the seed page leaves (kept by evora:init, deleted by evora:purge).
  // KIN-02: the account's disk cache folder (with its `v1/mattes/` entry) is not kept: the bridge
  // has no disk cache, evora:init deletes it.
  const seededOwn = [`idb:evns-${ehpNs}--effectcraft-handles`, `ls:evns-${ehpNs}--effectcraft`];
  const seededOwnCache = `opfs:evns-${ehpNs}--effectcraft-cache`;
  const keepers = (l) => l.opfs.includes("evora-keep") && l.idb.includes("evora-keep") && l.ls.includes("evora-keep");

  // 1. The seed page saw its fixture (else a purge check would pass on nothing).
  let s = await until("rapport de la page d'amorçage", (x) => x.harness.some((h) => h.report && h.report.harness === "seed"), EHP_READY_WAIT_MS);
  const seedEntry = s ? s.harness.find((h) => h.report.harness === "seed") : null;
  const seed = seedEntry ? seedEntry.report : null;
  r.seed = seed;
  r.timing = { navigation: navigatedAt, seed: seedEntry ? Math.round(seedEntry.at - navigatedAt) : null };
  check(!!(seed && seed.listing && ["opfs", "idb", "ls"].every((k) => seeded[k].every((n) => seed.listing[k].includes(n)))), `[ehp] amorçage incomplet : ${JSON.stringify(seed)}`);
  // NR-5 (EVORA-KIN-31): every seeded cache folder holds a `v1/mattes/` entry (cache kind of
  // v0.11.1), so the folders evora:init and evora:purge must remove carry that kind too.
  const seededMattes = seeded.opfs.filter((n) => n.endsWith("effectcraft-cache"));
  check(!!(seed && seed.listing && Array.isArray(seed.listing.mattes) && seededMattes.length === 3 && seededMattes.every((n) => seed.listing.mattes.includes(n))), `[ehp] amorçage incomplet (cache mattes) : ${JSON.stringify(seed && seed.listing ? seed.listing.mattes : null)}`);

  // 2. evora:ready, once; evora:init accepted, the version 2 copy ignored.
  s = await until("evora:ready", (x) => x.log.some((m) => m.type === "evora:ready"), EHP_READY_WAIT_MS);
  if (!s) {
    // The bridge is mute (the witness pass): what stayed in browser storage is checked all the same.
    const after = await listing();
    r.afterInit = after;
    const foreign = engineStores(after).filter(([, , ns]) => ns !== ehpNs);
    check(foreign.length === 0, `[ehp] magasins étrangers non purgés au démarrage : ${JSON.stringify(foreign)}`);
    return;
  }
  s = await until("accusé d'evora:init", (x) => answersTo(x, x.ids.init).length > 0);
  if (!s) return;
  const settleFrom = Date.now();
  const settleEnd = settleFrom + EHP_SETTLE_MS;
  let steady = 0;
  let probes = 0;
  let held = 0;
  while (steady < EHP_SETTLE_STEADY && Date.now() < settleEnd) {
    probes += 1;
    const t0 = Date.now();
    const answered = await Promise.race([request("ui.inspect").then(() => true, () => false), sleep(EHP_PROBE_MS).then(() => false)]);
    if (answered && Date.now() - t0 < EHP_PROBE_MS) {
      steady += 1;
      await sleep(1000);
    } else {
      steady = 0;
      held += 1;
      await sleep(500);
    }
  }
  const settled = steady >= EHP_SETTLE_STEADY;
  r.timing.settle = Date.now() - settleFrom;
  console.log(`SMOKE_DIAG ${label} settle ${JSON.stringify({ ms: r.timing.settle, probes, held, settled })}`);
  check(settled, `[ehp] le moteur ne répond pas après evora:init : rien en ${EHP_SETTLE_MS} ms`);
  if (!settled) return;
  await diag(ectx, "settled");
  await step("open");
  s = await until("accusé d'evora:open", (x) => answersTo(x, x.ids.open).length > 0);
  if (!s) return;
  await evalIn(ectx, PURGE_HOOKS);
  await evalIn(ectx, DOWNLOAD_HOOKS);
  const ready = s.log.filter((m) => m.type === "evora:ready");
  const rp = (ready[0] && ready[0].payload) || {};
  r.timing.ready = ready[0] ? Math.round(ready[0].at - navigatedAt) : null;
  r.timing.open = Math.round(Math.max(...answersTo(s, s.ids.open).map((m) => m.at)) - navigatedAt);
  r.ready = rp;
  check(ready.length === 1, `[ehp] evora:ready reçu ${ready.length} fois (attendu : 1)`);
  check(rp.app === "kinetika" && rp.ehp === "1.0" && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(String(rp.version)), `[ehp] evora:ready inattendu : ${JSON.stringify(rp)}`);
  const caps = Array.isArray(rp.capabilities) ? rp.capabilities : [];
  check(caps.length === EHP_EXPECTED.length && EHP_EXPECTED.every((c) => caps.includes(c)) && caps.every((c) => EHP_KNOWN.has(c)), `[ehp] capacités annoncées : ${JSON.stringify(caps)}`);
  check(answersTo(s, s.ids.v2init).length === 0, "[ehp] le moteur a répondu à un evora:init de version 2");
  check(ackOk(s, s.ids.init), `[ehp] accusé d'evora:init absent ou négatif : ${JSON.stringify(answersTo(s, s.ids.init))}`);
  check(ackOk(s, s.ids.open), `[ehp] accusé d'evora:open absent ou négatif : ${JSON.stringify(answersTo(s, s.ids.open))}`);
  s = await until("evora:dirty {dirty: false} après l'ouverture", (x) => x.log.some((m) => m.type === "evora:dirty" && m.payload && m.payload.dirty === false && m.payload.docRef === x.ids.doc));

  // 3. Browser storage once evora:init is applied (E5).
  const info = await evalIn(ectx, "JSON.parse(JSON.stringify(window.effectcraft.info()))");
  const afterInit = await listing();
  r.backend = info && info.storage ? info.storage.backend : null;
  r.afterInit = afterInit;
  const foreign = engineStores(afterInit).filter(([, , ns]) => ns !== ehpNs);
  check(foreign.length === 0, `[ehp] magasins étrangers non purgés au démarrage : ${JSON.stringify(foreign)}`);
  check(keepers(afterInit), `[ehp] témoins étrangers au moteur effacés : ${JSON.stringify(afterInit)}`);
  check(!engineStores(afterInit).some(([, , ns]) => ns === ehpUrlNs), `[ehp] espace de noms lu dans l'URL : ${JSON.stringify(afterInit)}`);
  const own = engineStores(afterInit).filter(([, , ns]) => ns === ehpNs).map(([k, n]) => `${k}:${n}`);
  const lostOwn = seededOwn.filter((x) => !own.includes(x));
  check(lostOwn.length === 0, `[ehp] magasins du même compte effacés au démarrage (ils doivent rester) : ${JSON.stringify(lostOwn)}`);
  // KIN-02: the premise (the seed page left this account's cache folder, mattes included), then
  // the folder gone once evora:init is applied.
  check(!!(seed && seed.listing && seed.listing.opfs.includes(`evns-${ehpNs}--effectcraft-cache`)), `[ehp-cache] prémisse : cache disque du compte absent de l'amorçage : ${JSON.stringify(seed && seed.listing ? seed.listing.opfs : null)}`);
  check(!own.includes(seededOwnCache), `[ehp-cache] cache disque du compte non vidé au démarrage (mattes compris) : ${JSON.stringify(own)}`);
  if (ehpMode === "memory") {
    check(r.backend === "memory", `[ehp] stockage du moteur ${r.backend} (attendu : memory)`);
    // (the account's cache folder is judged by [ehp-cache])
    const created = own.filter((x) => !seededOwn.includes(x) && x !== seededOwnCache);
    check(created.length === 0, `[ehp] le moteur a créé un magasin en mode mémoire : ${JSON.stringify(created)}`);
  } else {
    check(r.backend === "opfs", `[ehp] stockage du moteur ${r.backend} (attendu : opfs)`);
    check(own.includes(`opfs:evns-${ehpNs}--effectcraft`), `[ehp] aucun magasin « evns-${ehpNs.slice(0, 8)}…--effectcraft » : ${JSON.stringify(own)}`);
  }

  // 4. The document, the language and the theme of evora:init.
  const summary = await exec("project.summary");
  note("summary", summary);
  check(summary && summary.path === "/evora-smoke.ecproj" && summary.dirty === false, `[ehp] document ouvert inattendu : ${JSON.stringify(summary)}`);
  const frLabels = labelsOf(await request("ui.menu.list"));
  const inspect1 = await request("ui.inspect");
  const theme1 = String(inspect1 && inspect1.ui ? inspect1.ui.theme : "");
  note("theme at init", theme1);
  check(frLabels.includes("Enregistrer"), "[ehp] langue d'evora:init (fr) absente des menus (« Enregistrer »)");
  check(/^light/i.test(theme1), `[ehp] thème d'evora:init (clair) absent : ${theme1}`);
  await diag(ectx, "init");

  // 4b. The member's keyboard shortcuts across a restart of the editor (`--ehp-leg`, correction 1
  //     of lot KIN-FK-B2): the two legs share one browser profile and end here. The first records
  //     the member's keys: an alias in the « Kinetika » profile, upstream's own keys on a command the
  //     profile leaves free (the engine drops that override: the bridge writes it out), then a copy
  //     of the profile, made active, with a key of its own; they reach browser storage. The second
  //     starts the editor again and finds them, and the copy still active; then upstream's keys
  //     never come back (the copy reset, upstream's preset made active) and Reset Preset, clicked in
  //     the shortcut editor, empties the profile of the member's keys.
  if (ehpLeg) {
    const L = KEYS_LEG;
    const leg = (r.keysLeg = { leg: ehpLeg });
    const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
    const tryExec = (command, params) => exec(command, params).catch((e) => ({ rejected: String((e && e.message) || e) }));
    // Passes of the engine: the bridge settles the presets at the end of the frame that changed them.
    const passes = async () => {
      for (let i = 0; i < 3; i++) await request("ui.inspect").catch(() => null);
    };
    const overrides = async (preset) => {
      const d = await tryExec("shortcuts.export", { preset });
      return d && d.overrides ? d.overrides : null;
    };
    const pick = (o) => o && { alias: o[L.alias.command], own: o[L.own.command], upstream: o[L.upstream], save: o["file.save"] };
    const list = await tryExec("shortcuts.list", {});
    const rows = list && Array.isArray(list.commands) ? list.commands : [];
    const row = (key) => rows.find((x) => x.key === key) || null;
    const up = row(L.upstream);
    const upDefaults = up && Array.isArray(up.defaults) ? up.defaults : [];
    Object.assign(leg, { preset: list && list.preset, presets: list && list.presets, upstreamDefaults: upDefaults });
    if (ehpLeg === "keys-1") {
      // Premises: the profile active, the three commands bindable, upstream's keys on the free
      // command, which the profile leaves without a key.
      check(
        !!list && list.preset === "Kinetika" && !!row(L.alias.command) && !!row(L.own.command) && !!up && upDefaults.length > 0 && (up.keys || []).length === 0,
        `[ehp-keys-reload] prémisse : profil ou commandes du banc absents : ${JSON.stringify({ preset: list && list.preset, alias: row(L.alias.command), own: row(L.own.command), up })}`,
      );
      leg.setAlias = await tryExec("shortcuts.set", { command: L.alias.command, keys: L.alias.keys });
      leg.setUpstream = await tryExec("shortcuts.set", { command: L.upstream, keys: upDefaults });
      await passes();
      leg.kinetika = pick(await overrides("Kinetika"));
      check(!!leg.kinetika && same(leg.kinetika.alias, L.alias.keys), `[ehp-keys-reload] touche du membre absente du profil : ${JSON.stringify(leg)}`);
      check(!!leg.kinetika && same(leg.kinetika.upstream, upDefaults), `[ehp-keys-pin] touches de l'amont enregistrées par le membre laissées implicites dans le profil : ${JSON.stringify(leg.kinetika)}`);
      leg.duplicate = await tryExec("shortcuts.preset", { op: "duplicate", from: "Kinetika", name: L.copy });
      leg.setOwn = await tryExec("shortcuts.set", { command: L.own.command, keys: L.own.keys });
      await passes();
      leg.flushed = await evalIn(ectx, "window.effectcraft.flush().then(() => true, (e) => String((e && e.message) || e))", true, 60000).catch((e) => String(e));
      const stored = await evalIn(ectx, "window.effectcraft.listStored().then((v) => JSON.parse(JSON.stringify(v)))", true, 60000).catch(() => null);
      leg.stored = stored && { config: stored.config, pending: stored.pending };
      check(
        leg.flushed === true && !!stored && Array.isArray(stored.config) && stored.config.includes("shortcuts.json") && stored.pending === false,
        `[ehp-keys-reload] prémisse : raccourcis non écrits dans le stockage du navigateur : ${JSON.stringify({ flushed: leg.flushed, stored: leg.stored, duplicate: leg.duplicate, setOwn: leg.setOwn })}`,
      );
    } else {
      check(
        !!list && list.preset === L.copy && Array.isArray(list.presets) && list.presets.includes("Kinetika") && list.presets.includes(L.copy),
        `[ehp-keys-active] préréglage du membre non retrouvé actif au redémarrage : ${JSON.stringify({ preset: list && list.preset, presets: list && list.presets })}`,
      );
      leg.kinetika = pick(await overrides("Kinetika"));
      leg.copy = pick(await overrides(L.copy));
      check(
        !!leg.kinetika && same(leg.kinetika.alias, L.alias.keys) && same(leg.kinetika.save, ["Cmd+S"]) && !!leg.copy && same(leg.copy.own, L.own.keys) && same(leg.copy.alias, L.alias.keys),
        `[ehp-keys-reload] touches du membre perdues au redémarrage : ${JSON.stringify({ kinetika: leg.kinetika, copy: leg.copy })}`,
      );
      check(upDefaults.length > 0 && !!leg.copy && same(leg.copy.upstream, upDefaults), `[ehp-keys-pin] touches de l'amont enregistrées par le membre perdues au redémarrage : ${JSON.stringify({ copy: leg.copy, upDefaults })}`);
      // Upstream's keys never come back: the copy reset gets the profile's keys, and upstream's
      // preset, made active, gives way to the profile.
      leg.selectCopy = await tryExec("shortcuts.preset", { op: "select", name: L.copy });
      leg.reset = await tryExec("shortcuts.reset", {});
      await passes();
      leg.copyReset = pick(await overrides(L.copy));
      check(
        !!leg.copyReset && same(leg.copyReset.save, ["Cmd+S"]) && same(leg.copyReset.upstream, []) && same(leg.copyReset.own, []) && same(leg.copyReset.alias, []),
        `[ehp-keys-upstream] préréglage réinitialisé sans les touches du profil : ${JSON.stringify(leg.copyReset)}`,
      );
      leg.selectUpstream = await tryExec("shortcuts.preset", { op: "select", name: "EffectCraft Default" });
      await passes();
      const after = await tryExec("shortcuts.list", { assigned: true });
      leg.afterUpstream = after && after.preset;
      check(!!after && after.preset === "Kinetika", `[ehp-keys-upstream] préréglage de l'amont laissé actif sous l'hôte : ${JSON.stringify(leg.afterUpstream)}`);
      // Reset Preset in the shortcut editor, on the profile itself: a click on the editor's button.
      leg.selectProfile = await tryExec("shortcuts.preset", { op: "select", name: "Kinetika" });
      leg.setAgain = await tryExec("shortcuts.set", { command: L.alias.command, keys: L.alias.keys });
      await passes();
      const before = pick(await overrides("Kinetika"));
      leg.dialog = await requestWith("ui.menu.invoke", { command: "app.keyboardShortcuts" });
      await passes();
      leg.click = await requestWith("ui.click", { id: "shortcuts.resetPreset" });
      await passes();
      const reset = pick(await overrides("Kinetika"));
      leg.profileReset = { before, after: reset };
      check(!!before && same(before.alias, L.alias.keys) && !(leg.click && leg.click.rejected), `[ehp-keys-reset] prémisse : alias du membre ou clic absents : ${JSON.stringify(leg.profileReset)} ${JSON.stringify(leg.click)}`);
      const emptied = !!reset && !same(reset.alias, L.alias.keys);
      check(emptied, `[ehp-keys-reset] « Reset Preset » sans effet sur le profil de l'hôte : ${JSON.stringify(leg.profileReset)}`);
      if (emptied) check(same(reset.alias, []) && same(reset.save, ["Cmd+S"]) && same(reset.upstream, []), `[ehp-keys-upstream] profil réinitialisé sans ses touches : ${JSON.stringify(reset)}`);
      if (pageSession) {
        const shot = await send("Page.captureScreenshot", { format: "png" }, pageSession).catch(() => null);
        if (shot) writeFileSync(join(out, `smoke-${label}-raccourcis.png`), Buffer.from(shot.data, "base64"));
      }
    }
    note("keys leg", leg);
    console.log(`SMOKE_KEYS ${label} ${JSON.stringify(leg).slice(0, 3000)}`);
    return;
  }

  // 5. No answer to a window that isn't the parent, to an origin not admitted, to version 2; the
  //    parent's own request (the witness) is answered.
  await step("rogue");
  s = await until("ordres des fenêtres intruses", (x) => x.harness.filter((h) => h.report && h.report.harness === "rogue").length === 2);
  await sleep(EHP_ROGUE_SETTLE_MS);
  await step("clean");
  s = await until("réponse à evora:request-save (témoin)", (x) => answersTo(x, x.ids.clean).length > 0);
  if (!s) await diag(ectx, "clean");
  if (s) {
    check(ackOk(s, s.ids.clean, "clean"), `[ehp] témoin : evora:request-save sans réponse « clean » : ${JSON.stringify(answersTo(s, s.ids.clean))}`);
    for (const k of ["rogueSource", "rogueOrigin", "v2save"]) {
      check(!!s.ids[k] && answersTo(s, s.ids[k]).length === 0, `[ehp] réponse à un message refusé (${k}) : ${JSON.stringify(answersTo(s, s.ids[k]))}`);
    }
  }

  // 6. An edit: evora:dirty; evora:request-save: evora:save answering it, then not modified.
  await exec("comp.new", {});
  s = await until("evora:dirty {dirty: true}", (x) => x.log.some((m) => m.type === "evora:dirty" && m.payload && m.payload.dirty === true && m.payload.docRef === x.ids.doc));
  await step("save");
  s = await until("evora:save en réponse à evora:request-save", (x) => x.saves.some((v) => v.re === x.ids.save));
  if (s) {
    const v = s.saves.find((x) => x.re === s.ids.save);
    note("save", v);
    check(v.docRef === s.ids.doc && v.name === "evora-smoke.ecproj" && v.saveAs === false && v.arrayBuffer && v.byteLength > 0 && v.items >= 1, `[ehp] evora:save inattendu : ${JSON.stringify(v)}`);
    // Received after the evora:save (`seq`): both often arrive in the same millisecond.
    const after = await until("evora:dirty {dirty: false} après l'enregistrement", (x) => x.log.some((m) => m.type === "evora:dirty" && m.payload && m.payload.dirty === false && m.seq > v.seq));
    if (!after) {
      const tail = (await state()).log.slice(-8).map((m) => ({ type: m.type, seq: m.seq, at: m.at, re: m.re, dirty: m.payload ? m.payload.dirty : undefined }));
      console.log(`SMOKE_DIAG ${label} dirty-after-save ${JSON.stringify({ saveSeq: v.seq, saveAt: v.at, saveId: v.id, tail })}`);
    }
  }
  // Save As: a copy (saveAs, the original docRef); the host's new docRef is the document after.
  await exec("file.saveAs", { path: "/evora-copie.ecproj" });
  s = await until("evora:save d'un « Enregistrer sous »", (x) => x.saves.some((v) => v.saveAs === true));
  if (s) {
    const v = s.saves.find((x) => x.saveAs === true);
    note("saveAs", v);
    check(v.docRef === s.ids.doc && v.name === "evora-copie.ecproj" && v.re === null && v.byteLength > 0, `[ehp] « Enregistrer sous » inattendu : ${JSON.stringify(v)}`);
    await sleep(EHP_ADOPT_MS);
    await exec("comp.new", {});
    await exec("file.save", {});
    s = await until("evora:save de la copie", (x) => x.saves.some((w) => w.docRef === x.ids.copy));
    if (s) {
      const w = s.saves.find((x) => x.docRef === s.ids.copy);
      note("save of the copy", w);
      check(w.saveAs === false && w.name === "evora-copie.ecproj" && w.byteLength > 0, `[ehp] enregistrement de la copie inattendu : ${JSON.stringify(w)}`);
    }
  }

  // 6b. The engine's frame not painted (display: none): the browser gives it no animation frame,
  //     even in a visible tab. The Evora page asks for a save when the editor goes out of sight
  //     (§7.2): the evora:save comes all the same, while the frame stays hidden.
  s = await state();
  const current = s.ids.copy || s.ids.doc;
  await exec("comp.new", {});
  s = await until("evora:dirty {dirty: true} avant le masquage", (x) => {
    const last = x.log.filter((m) => m.type === "evora:dirty" && m.payload && m.payload.docRef === current).at(-1);
    return !!last && last.payload.dirty === true;
  });
  if (s) {
    await evalIn(parentCtx(parentOrigin), "__ehp.step.hide(true)");
    await sleep(EHP_HIDE_SETTLE_MS);
    const raf = await evalIn(ectx, RAF_COUNT, true);
    await step("hiddenSave");
    s = await until("evora:save en réponse à evora:request-save, cadre masqué", (x) => x.saves.some((v) => v.re === x.ids.hidden), EHP_HIDDEN_WAIT_MS);
    const display = await evalIn(parentCtx(parentOrigin), "document.getElementById('engine').style.display");
    r.hidden = { raf, display, answered: !!s };
    note("hidden", r.hidden);
    // The premise: the frame got no animation frame while hidden (else this proves nothing).
    check(raf === 0, `[ehp] prémisse du masquage : le cadre masqué reçoit encore des images d'animation (${raf} en 1 s)`);
    check(display === "none", `[ehp] prémisse du masquage : le cadre n'est plus masqué à la réponse (${display})`);
    if (s) {
      const v = s.saves.find((x) => x.re === s.ids.hidden);
      check(v.docRef === current && v.saveAs === false && v.byteLength > 0, `[ehp] evora:save du cadre masqué inattendu : ${JSON.stringify(v)}`);
    }
    await evalIn(parentCtx(parentOrigin), "__ehp.step.hide(false)");
    await sleep(EHP_ADOPT_MS);
  }

  // 7. Language and theme while running (live.lang, live.theme): dark (evora:init made it light),
  //    then light again; each read as soon as its answer came (the engine answers once it shows it).
  await step("live");
  s = await until("accusés d'evora:theme et d'evora:lang", (x) => answersTo(x, x.ids.theme).length > 0 && answersTo(x, x.ids.lang).length > 0);
  if (s) {
    check(ackOk(s, s.ids.theme) && ackOk(s, s.ids.lang), `[ehp] accusés d'evora:theme / evora:lang : ${JSON.stringify([answersTo(s, s.ids.theme), answersTo(s, s.ids.lang)])}`);
    const inspect2 = await request("ui.inspect");
    const theme2 = String(inspect2 && inspect2.ui ? inspect2.ui.theme : "");
    check(/^dark/i.test(theme2), `[ehp] thème à chaud (sombre) absent : ${theme2}`);
    if (!/^dark/i.test(theme2)) await diag(ectx, "live");
    await sleep(500);
    const deLabels = labelsOf(await request("ui.menu.list"));
    const changed = deLabels.filter((l, i) => l !== frLabels[i]).length;
    note("live", { theme: theme2, labelsChanged: changed });
    check(deLabels.includes("Speichern") && changed >= 20, `[ehp] langue à chaud (de) absente : ${changed} libellés changés`);
  }
  await step("live2");
  s = await until("accusé du second evora:theme", (x) => answersTo(x, x.ids.theme2).length > 0);
  if (s) {
    check(ackOk(s, s.ids.theme2), `[ehp] accusé du second evora:theme : ${JSON.stringify(answersTo(s, s.ids.theme2))}`);
    const inspect3 = await request("ui.inspect");
    const theme3 = String(inspect3 && inspect3.ui ? inspect3.ui.theme : "");
    note("live2", { theme: theme3 });
    check(/^light/i.test(theme3), `[ehp] thème à chaud (clair) absent : ${theme3}`);
    if (!/^light/i.test(theme3)) {
      await diag(ectx, "live2");
      await sleep(3000);
      await diag(ectx, "live2+3s");
    }
  }

  // 7a. E2-KIN (lot KIN-FK-B2, Q-K41 (a)): the palette the editor shows (effectcraft.info().evoraTheme,
  //     the values compiled and applied): zinc surfaces, no gradient, the 12 px radius, the accent of
  //     evora:init and evora:theme with its shades, every pair above its WCAG floor; in light (indigo,
  //     after the second evora:theme), in dark with another accent (pink), then light indigo again.
  {
    const look = () => evalIn(ectx, "JSON.parse(JSON.stringify((window.effectcraft.info() || {}).evoraTheme || null))");
    const lookUntil = async (pred) => {
      const end = Date.now() + EHP_WAIT_MS;
      let t = await look();
      while (!(t && pred(t)) && Date.now() < end) {
        await sleep(250);
        t = await look();
      }
      return t;
    };
    const judge = (t, kind, accent, what) => {
      const want = THEME_SURFACES[kind];
      const surfaces = !!t && t.kind === kind && Object.keys(want).every((k) => t[k] === want[k]);
      check(surfaces && t.gradients === false && t.radius === 12 && t.radiusSm === 4 && t.accent === accent && t.hostAccent === accent, `[ehp-theme] palette E2-KIN (${what}) absente : ${JSON.stringify(t)}`);
      const low = t ? THEME_PAIRS.map(([a, b, min]) => [a, b, min, Math.round(contrast(t[a], t[b]) * 100) / 100]).filter(([, , min, r]) => !(r >= min)) : ["illisible"];
      check(!!t && low.length === 0, `[ehp-theme] contrastes sous le seuil (${what}) : ${JSON.stringify(low)}`);
      note(`theme ${what}`, t);
    };
    judge(await lookUntil((t) => t.kind === "light" && t.accent === "#4f46e5"), "light", "#4f46e5", "clair, indigo");
    await step("theme3");
    s = await until("[ehp-theme] accusé d'evora:theme (sombre, rose)", (x) => answersTo(x, x.ids.theme3).length > 0);
    check(!!s && ackOk(s, s.ids.theme3), `[ehp-theme] accusé d'evora:theme (sombre, rose) : ${JSON.stringify(s ? answersTo(s, s.ids.theme3) : null)}`);
    judge(await lookUntil((t) => t.kind === "dark" && t.accent === "#db2777"), "dark", "#db2777", "sombre, rose");
    if (pageSession && label === "pont-ehp") {
      await sleep(1500);
      const shot = await send("Page.captureScreenshot", { format: "png" }, pageSession).catch(() => null);
      if (shot) writeFileSync(join(out, `smoke-${label}-sombre.png`), Buffer.from(shot.data, "base64"));
    }
    await step("theme4");
    s = await until("[ehp-theme] accusé d'evora:theme (clair, indigo)", (x) => answersTo(x, x.ids.theme4).length > 0);
    judge(await lookUntil((t) => t.kind === "light" && t.accent === "#4f46e5"), "light", "#4f46e5", "clair, indigo, de retour");
  }

  // 7b. KIN-01: the menu entries that can't work in Evora's editor are hidden, and refused.
  {
    const items = await request("ui.menu.list");
    const ids = new Set((items || []).map((it) => String(it.id ?? "")));
    const shown = EHP_HIDDEN.filter((c) => ids.has(c));
    const missing = EHP_SHOWN.filter((c) => !ids.has(c));
    note("menus", { listed: ids.size, shown, missing });
    check(missing.length === 0, `[ehp-menus] prémisse : entrées attendues absentes des menus : ${JSON.stringify(missing)}`);
    check(shown.length === 0, `[ehp-menus] entrées sans effet dans Evora encore affichées : ${JSON.stringify(shown)}`);
    const before = await exec("project.summary");
    const refused = await requestWith("ui.menu.invoke", { command: "file.openDemoProject" });
    const after = await exec("project.summary");
    note("menus invoke", { refused, before: before && before.path, after: after && after.path });
    const isRefused = !!refused && (refused.rejected !== undefined || refused.ok === false);
    check(isRefused && after && before && after.path === before.path, `[ehp-menus] commande masquée exécutée : ${JSON.stringify({ refused, before, after })}`);
  }

  // 7b'. The « Kinetika » keyboard shortcut profile (lot KIN-FK-B2, Q-K19 (a)): active, the common
  //      conventions bound, no single character key, and the menus show its keys.
  {
    const list = await exec("shortcuts.list", { assigned: true });
    const rows = (list && Array.isArray(list.commands)) ? list.commands : [];
    const keysOf = (key) => ((rows.find((x) => x.key === key) || {}).keys || []);
    const single = rows.flatMap((x) => (x.keys || []).filter(singleKey).map((k) => `${x.key} = ${k}`));
    const items = await request("ui.menu.list");
    const save = (items || []).find((it) => it.id === "file.save");
    note("keys", { preset: list && list.preset, presets: list && list.presets, assigned: rows.length, single, save: save && save.shortcut });
    check(!!list && list.preset === "Kinetika", `[ehp-keys] profil « Kinetika » inactif : ${JSON.stringify(list && { preset: list.preset, presets: list.presets })}`);
    check(keysOf("file.save").includes("Cmd+S") && keysOf("edit.undo").includes("Cmd+Z") && keysOf("edit.copy").includes("Cmd+C") && rows.length >= 10, `[ehp-keys] prémisse : conventions communes absentes du profil : ${JSON.stringify(rows.map((x) => [x.key, x.keys]).slice(0, 40))}`);
    check(single.length === 0, `[ehp-keys] raccourcis d'une seule touche dans le profil : ${JSON.stringify(single.slice(0, 20))}`);
    check(!!save && save.shortcut === "Cmd+S", `[ehp-keys] les menus ne montrent pas le raccourci du profil : ${JSON.stringify(save)}`);
  }

  // 7c. ui.focus-out: F6 in the engine goes back to the Evora page (evora:focus-out {}), once per
  //     press, never with a modifier; the canvas and the browser don't get it.
  {
    const keys = await evalIn(
      ectx,
      `(() => { const k = (type, extra) => window.dispatchEvent(new KeyboardEvent(type, Object.assign({ key: "F6", code: "F6", bubbles: true, cancelable: true }, extra || {})));
        const plain = !k("keydown"); k("keyup"); const shift = !k("keydown", { shiftKey: true }); k("keyup", { shiftKey: true });
        return { prevented: plain, shiftPrevented: shift }; })()`,
    );
    s = await until("[ehp-focus] evora:focus-out après F6", (x) => x.log.some((m) => m.type === "evora:focus-out"), EHP_WAIT_MS);
    await sleep(500);
    const st = await state();
    const outs = st.log.filter((m) => m.type === "evora:focus-out");
    note("focus-out", { keys, count: outs.length });
    check(!!s && outs.length === 1 && outs[0].re === null && outs[0].payload && Object.keys(outs[0].payload).length === 0, `[ehp-focus] evora:focus-out attendu une fois, sans charge ni re : ${JSON.stringify(outs)}`);
    check(!!keys && keys.prevented === true && keys.shiftPrevented === false, `[ehp-focus] F6 non retenue (ou Maj+F6 retenue) : ${JSON.stringify(keys)}`);
  }

  // 7d. doc.saved-ack: an evora:saved {ok: false} leaves the engine modified (no evora:dirty
  //     {dirty: false}, project.summary dirty); the next save, acknowledged, makes it saved.
  {
    await step("failNext");
    // The mark before the edit: its evora:dirty may arrive before the next read of the log.
    s = await state();
    const mark = s.log.length ? s.log[s.log.length - 1].seq : 0;
    await exec("comp.new", {});
    s = await until("evora:dirty {dirty: true} avant l'enregistrement refusé", (x) => x.log.some((m) => m.seq > mark && m.type === "evora:dirty" && m.payload && m.payload.dirty === true));
    await step("sack1");
    s = await until("[ehp-sack] evora:save en réponse à la demande refusée", (x) => x.saves.some((v) => v.re === x.ids.sack1));
    if (s) {
      const v = s.saves.find((x) => x.re === s.ids.sack1);
      await sleep(EHP_SACK_SETTLE_MS);
      const st = await state();
      const clean = st.log.filter((m) => m.type === "evora:dirty" && m.payload && m.payload.dirty === false && m.seq > v.seq);
      const sum = await exec("project.summary");
      note("saved-ack refused", { answer: v.answer, clean: clean.length, dirty: sum && sum.dirty });
      check(v.answer && v.answer.ok === false, `[ehp-sack] prémisse : le banc n'a pas refusé l'enregistrement : ${JSON.stringify(v.answer)}`);
      check(clean.length === 0 && sum && sum.dirty === true, `[ehp-sack] le moteur se dit enregistré après un accusé négatif : ${JSON.stringify({ clean, summary: sum })}`);
    }
    await step("sack2");
    s = await until("[ehp-sack] evora:save en réponse à la seconde demande", (x) => x.saves.some((v) => v.re === x.ids.sack2));
    if (s) {
      const v = s.saves.find((x) => x.re === s.ids.sack2);
      const after = await until("[ehp-sack] evora:dirty {dirty: false} après un accusé positif", (x) => x.log.some((m) => m.type === "evora:dirty" && m.payload && m.payload.dirty === false && m.seq > v.seq));
      const sum = await exec("project.summary");
      note("saved-ack accepted", { answer: v.answer, dirty: sum && sum.dirty });
      check(!!after && v.answer && v.answer.ok === true && sum && sum.dirty === false, `[ehp-sack] le moteur reste modifié après un accusé positif : ${JSON.stringify({ answer: v.answer, summary: sum })}`);
    }
  }

  // 7e. export.drive: a frame render and a Lottie export, each named in the editor's save dialog,
  //     and a render of three frames (an image sequence, one stored .zip) go to Evora's Drive as
  //     evora:export, with the document's docRef; never a download.
  {
    const current = (await state()).ids.copy || (await state()).ids.doc;
    await exec("comp.new", { name: "Rendu", width: 64, height: 64, duration: 0.1 });
    const frame = await requestWith("ui.menu.invoke", { command: "comp.saveFrameAs" });
    s = await until("[ehp-export] evora:export du rendu d'image", (x) => x.exports.some((e) => e.name === "Frame.png"), EHP_V1_WAIT_MS);
    const lottie = await requestWith("ui.menu.invoke", { command: "file.exportLottie" });
    s = await until("[ehp-export] evora:export du Lottie", (x) => x.exports.some((e) => e.name === "Animation.json"), EHP_V1_WAIT_MS);
    const st = await state();
    const png = st.exports.find((e) => e.name === "Frame.png");
    const json = st.exports.find((e) => e.name === "Animation.json");
    note("exports", { frame, lottie, png, json });
    check(!!png && png.mime === "image/png" && png.arrayBuffer && png.byteLength > 0 && png.magic === "89504e47" && png.docRef === current, `[ehp-export] rendu d'image : evora:export attendu (PNG, docRef) : ${JSON.stringify({ frame, png })}`);
    check(!!json && json.mime === "application/json" && json.arrayBuffer && json.byteLength > 0 && json.magic.startsWith("7b") && json.docRef === current, `[ehp-export] Lottie : evora:export attendu (JSON, docRef) : ${JSON.stringify({ lottie, json })}`);
    const added = await exec("renderQueue.add", { format: "png" }).catch((e) => ({ error: String(e && e.message) }));
    const rendered = await exec("renderQueue.render", { wait: true }).catch((e) => ({ error: String(e && e.message) }));
    s = await until("[ehp-export-zip] evora:export du rendu de la file", (x) => x.exports.some((e) => /\.zip$/.test(String(e.name))), EHP_V1_WAIT_MS);
    const zip = s ? s.exports.find((e) => /\.zip$/.test(String(e.name))) : null;
    note("render queue", { added, rendered, zip });
    check(!!zip && zip.mime === "application/zip" && zip.magic === "504b0304" && zip.byteLength > 0 && zip.docRef === current, `[ehp-export-zip] rendu de la file : un .zip attendu en evora:export : ${JSON.stringify({ added, rendered, zip })}`);
    await sleep(1000);
    const engineDownloads = await evalIn(ectx, "JSON.parse(JSON.stringify(window.__evoraDownloadLog || []))");
    note("downloads", { engine: engineDownloads, browser: downloads });
    check(engineDownloads.length === 0 && downloads.length === 0, `[ehp-export] téléchargement déclenché : ${JSON.stringify({ engine: engineDownloads, browser: downloads })}`);
  }

  // 7f. pick.drive and media.need: File ▸ Import opens Evora's picker (evora:pick), the two images
  //     it answers become footage; the project saved with them, reopened as another document whose
  //     media sit under other Drive uids, asks for them (evora:need) and comes back whole, without
  //     the browser's storage.
  {
    const imported = await requestWith("ui.menu.invoke", { command: "file.import" });
    s = await until("[ehp-pick] evora:pick d'un import", (x) => x.picks.length > 0, EHP_V1_WAIT_MS);
    const pick = s ? s.picks[0] : null;
    const pp = (pick && pick.payload) || {};
    note("pick", { imported, pick });
    check(!!pick && pp.purpose === "import" && pp.multiple === true && Array.isArray(pp.accept) && pp.accept.length >= 1 && pp.accept.length <= 32 && pp.accept.includes("image/*") && pp.forPath === undefined, `[ehp-pick] evora:pick inattendu : ${JSON.stringify(pick)}`);
    await sleep(1500);
    const check1 = await exec("footage.check", { wait: true }).catch((e) => ({ error: String(e && e.message) }));
    note("footage after import", check1);
    check(!!check1 && check1.checked === 2 && check1.missing === 0, `[ehp-pick] les deux images choisies dans Evora ne sont pas devenues des métrages : ${JSON.stringify(check1)}`);
    await step("mediaSave");
    s = await until("[ehp-need] evora:save du projet et de ses médias", (x) => x.saves.some((v) => v.re === x.ids.mediaSave));
    const reopened = await step("reopen");
    s = await until("[ehp-need] accusé de la réouverture", (x) => !!x.ids.reopen && answersTo(x, x.ids.reopen).length > 0);
    s = await until("[ehp-need] evora:need des médias du projet rouvert", (x) => x.needs.length > 0, EHP_V1_WAIT_MS);
    const need = s ? s.needs[0] : null;
    const np = (need && need.payload) || {};
    const paths = Array.isArray(np.paths) ? [...np.paths].sort() : [];
    note("need", { reopened, need });
    check(reopened === true, `[ehp-need] prémisse : le projet enregistré ne porte pas les médias importés`);
    check(!!need && np.docRef === s.ids.doc3 && JSON.stringify(paths) === JSON.stringify(["/evora/01JZMEDB0000000000000000BB/bleu.png", "/evora/01JZMEDB0000000000000000BB/rouge.png"]), `[ehp-need] evora:need inattendu : ${JSON.stringify(need)}`);
    await sleep(2000);
    const sum = await exec("project.summary");
    const check2 = await exec("footage.check", { wait: true }).catch((e) => ({ error: String(e && e.message) }));
    note("footage after need", { summary: sum && sum.path, check: check2 });
    check(!!sum && sum.path === "/evora-medias.ecproj" && !!check2 && check2.checked === 2 && check2.missing === 0, `[ehp-need] le projet rouvert n'a pas retrouvé ses deux médias : ${JSON.stringify({ path: sum && sum.path, check: check2 })}`);
  }

  // 7g. command.catalog (lot KIN-FK-B2; AVENANT of 2026-10-27, §4 and §5): evora:commands after the
  //     answer to evora:init (fr) and after evora:lang (de), the same ids and hash; a white list by
  //     construction, no free parameter, the removal markers all destructive; a catalog command runs,
  //     a command outside it doesn't, nor one with a parameter, nor a destructive one unconfirmed.
  {
    const cats = await evalIn(parentCtx(parentOrigin), "JSON.parse(JSON.stringify(__ehp.catalogs))");
    s = await state();
    const initAck = answersTo(s, s.ids.init).find((m) => m.type === "evora:ack");
    const fr = cats.find((c) => c.payload && c.payload.lang === "fr");
    const de = cats.find((c) => c.payload && c.payload.lang === "de");
    const first = cats[0];
    note("catalogs", cats.map((c) => ({ seq: c.seq, lang: c.payload && c.payload.lang, count: c.payload && c.payload.count, hash: c.payload && c.payload.hash })));
    check(!!first && first === fr && !!initAck && first.seq > initAck.seq && first.re === null && JSON.stringify([...first.keys].sort()) === JSON.stringify(["id", "payload", "type", "v"]), `[ehp-commands] evora:commands absent après l'accusé d'evora:init (fr) : ${JSON.stringify({ first: first && { seq: first.seq, re: first.re, keys: first.keys, lang: first.payload && first.payload.lang }, initAck: initAck && initAck.seq })}`);
    check(!!de, `[ehp-commands] aucun evora:commands après evora:lang (de) : ${JSON.stringify(cats.map((c) => c.payload && c.payload.lang))}`);
    if (fr && label === "pont-ehp") {
      writeFileSync(join(out, "commands.json"), `${JSON.stringify({ app: r.ready && r.ready.app, version: r.ready && r.ready.version, ...fr.payload }, null, 2)}\n`);
    }
    for (const c of [fr, de].filter(Boolean)) {
      const p = c.payload || {};
      const cmds = Array.isArray(p.commands) ? p.commands : [];
      const ids = cmds.map((x) => String(x.id));
      const bad = cmds.filter((x) => !(x && CAT_ID.test(String(x.id)) && String(x.id).length <= 100 && typeof x.label === "string" && x.label.length >= 1 && x.label.length <= 200
        && Array.isArray(x.path) && x.path.length <= 8 && x.path.every((e) => typeof e === "string" && e.length >= 1 && e.length <= 200)
        && typeof x.enabled === "boolean" && typeof x.destructive === "boolean" && Object.keys(x).every((k) => ["id", "label", "path", "enabled", "destructive"].includes(k))));
      check(/^[0-9a-f]{16}$/.test(String(p.hash)) && p.count === cmds.length && cmds.length >= 1 && cmds.length <= 2000 && bad.length === 0 && new Set(ids).size === ids.length
        && JSON.stringify(Object.keys(p).sort()) === JSON.stringify(["commands", "count", "hash", "lang", "params"]), `[ehp-commands] catalogue hors schéma (${p.lang}) : ${JSON.stringify({ hash: p.hash, count: p.count, n: cmds.length, keys: Object.keys(p), bad: bad.slice(0, 5) })}`);
      check(catalogHash(cmds) === p.hash, `[ehp-commands] empreinte du catalogue (${p.lang}) différente de celle des identifiants : ${p.hash} contre ${catalogHash(cmds)}`);
      const outside = ids.filter((id) => (id.startsWith("file.") && !CAT_FILE_ADMITTED.includes(id)) || /^(app|help|prefs)\./.test(id) || CAT_OFF.includes(id) || EHP_HIDDEN.includes(id));
      check(outside.length === 0, `[ehp-commands] hors liste blanche (${p.lang}) : ${JSON.stringify(outside.slice(0, 20))}`);
      const missing = CAT_PREMISE.filter((id) => !ids.includes(id));
      check(missing.length === 0 && ids.some((id) => id.startsWith("effect.apply.effect-")), `[ehp-commands] prémisse : commandes attendues absentes du catalogue (${p.lang}) : ${JSON.stringify(missing)}`);
      const unflagged = CAT_DESTRUCTIVE_PREMISE.filter((id) => !cmds.some((x) => x.id === id && x.destructive === true));
      const marked = cmds.filter((x) => !x.destructive && !CAT_EXCEPTIONS[x.id] && (idWords(x.id).some((w) => CAT_MARK_ID.has(w)) || labelWords(x.label).some((w) => CAT_MARK_LABEL.has(w))));
      check(unflagged.length === 0 && marked.length === 0, `[ehp-commands] commandes de retrait non destructives (${p.lang}) : ${JSON.stringify({ unflagged, marked: marked.map((x) => [x.id, x.label]).slice(0, 20) })}`);
      const branded = cmds.filter((x) => CAT_BRAND.test(x.label) || x.path.some((e) => CAT_BRAND.test(e)));
      check(branded.length === 0, `[ehp-commands] marque ou terme tiers dans le catalogue (${p.lang}) : ${JSON.stringify(branded.map((x) => [x.id, x.label, x.path]).slice(0, 10))}`);
    }
    check(!!fr && !!de && fr.payload.hash === de.payload.hash && fr.payload.count === de.payload.count && JSON.stringify(fr.payload.commands.map((x) => x.id)) === JSON.stringify(de.payload.commands.map((x) => x.id)), `[ehp-commands] catalogues fr et de différents (identifiants ou empreinte) : ${JSON.stringify([fr && fr.payload.hash, de && de.payload.hash])}`);
    const code = (st, key) => {
      const a = answersTo(st, st.ids[key]).find((m) => m.type === "evora:ack");
      return a && a.payload ? (a.payload.ok === true ? "ok" : String(a.payload.code)) : null;
    };
    const run = async (key, command, params, confirmed) => {
      await stepWith("cmd", key, command, params, confirmed);
      const st = await until(`[ehp-command] accusé d'evora:command (${key})`, (x) => !!x.ids[key] && answersTo(x, x.ids[key]).some((m) => m.type === "evora:ack"));
      return st ? code(st, key) : null;
    };
    const count = async () => {
      const sum = await exec("project.summary");
      return sum && Array.isArray(sum.items) ? sum.items.length : -1;
    };
    // A catalog command runs as its menu entry does: File ▸ New ▸ New Folder adds an item.
    const n0 = await count();
    const c1 = await run("cmd1", "project.newFolder", {});
    const n1 = await count();
    note("command", { c1, items: [n0, n1] });
    check(c1 === "ok" && n0 >= 0 && n1 === n0 + 1, `[ehp-command] commande du catalogue sans effet : ${JSON.stringify({ code: c1, items: [n0, n1] })}`);
    // Outside the catalog: refused, nothing sent (no evora:save for File ▸ Save, the shell's).
    const saves0 = (await state()).saves.length;
    const c2 = await run("cmd2", "file.save", {});
    const c3 = await run("cmd3", "app.about", {});
    await sleep(EHP_ROGUE_SETTLE_MS);
    const saves1 = (await state()).saves.length;
    note("command outside", { c2, c3, saves: [saves0, saves1] });
    check(c2 === "capability" && c3 === "capability" && saves1 === saves0, `[ehp-command-scope] commande hors catalogue exécutée : ${JSON.stringify({ c2, c3, saves: [saves0, saves1] })}`);
    // No free parameter: a catalog command with one (here a path) is refused, without effect.
    const c4 = await run("cmd4", "project.newFolder", { name: "/opfs/evora/../x" });
    const n2 = await count();
    note("command params", { c4, items: [n1, n2] });
    check(c4 === "invalid_content" && n2 === n1, `[ehp-command-params] paramètre libre admis : ${JSON.stringify({ code: c4, items: [n1, n2] })}`);
    // Destructive: refused without confirmed: true (absent or false), run with it.
    const c5 = await run("cmd5", "edit.purge.what-memory", {});
    const c6 = await run("cmd6", "edit.purge.what-memory", {}, false);
    const c7 = await run("cmd7", "edit.clear", {});
    const n3 = await count();
    const c8 = await run("cmd8", "edit.purge.what-memory", {}, true);
    note("command destructive", { c5, c6, c7, c8, items: [n2, n3] });
    check(c5 === "forbidden" && c6 === "forbidden" && c7 === "forbidden" && n3 === n2 && c8 === "ok", `[ehp-command-destructive] commande destructive sans confirmation : ${JSON.stringify({ c5, c6, c7, c8, items: [n2, n3] })}`);
  }

  // 7h. font.inject (lot KIN-FK-B2, E6): the bench's font (a TrueType font of the runner, served by
  //     the parent) joins the engine's fonts, non-fonts are refused; a text in it draws unlike the
  //     same text in Inter, on the page (Composition ▸ Save Frame) and in the job workers (Render
  //     Queue: the files of each stored .zip).
  {
    const users = async () => {
      const f = await exec("text.fonts");
      return (f && Array.isArray(f.families) ? f.families : []).filter((x) => x.origin === "user").map((x) => String(x.family));
    };
    const u0 = await users();
    await step("font");
    s = await until("[ehp-font] accusé d'evora:font", (x) => !!x.ids.font && answersTo(x, x.ids.font).length > 0, EHP_V1_WAIT_MS);
    const font = await evalIn(parentCtx(parentOrigin), "JSON.parse(JSON.stringify(__ehp.font))");
    const fontAck = s ? answersTo(s, s.ids.font) : null;
    const u1 = await users();
    const added = u1.filter((f) => !u0.includes(f));
    note("font", { font, ack: fontAck, before: u0, after: u1 });
    check(!!font && !font.error && ["00010000", "4f54544f", "74727565"].includes(font.magic), `[ehp-font] prémisse : police du banc illisible : ${JSON.stringify(font)}`);
    check(u0.length === 0, `[ehp-font] prémisse : police « user » avant l'injection : ${JSON.stringify(u0)}`);
    check(!!s && ackOk(s, s.ids.font) && added.length >= 1, `[ehp-font] police injectée absente des polices du moteur : ${JSON.stringify({ ack: fontAck, added })}`);
    await step("fontBad");
    s = await until("[ehp-font] accusé d'une fausse police", (x) => !!x.ids.fontBad && answersTo(x, x.ids.fontBad).length > 0);
    const badAck = s ? answersTo(s, s.ids.fontBad).find((m) => m.type === "evora:ack") : null;
    check(!!badAck && badAck.payload && badAck.payload.ok === false && badAck.payload.code === "invalid_content" && (await users()).length === u1.length, `[ehp-font] des octets qui ne sont pas une police admis : ${JSON.stringify(badAck)}`);
    const family = added[0];
    if (family) {
      const mark = (await state()).exports.length;
      const frame = async (name, fontName) => {
        await exec("comp.new", { name, width: 240, height: 80, duration: 0.1 });
        await exec("layer.newText", { text: "Kinetika Evora", font: fontName, size: 40 });
        const before = (await state()).exports.length;
        await requestWith("ui.menu.invoke", { command: "comp.saveFrameAs" });
        const st = await until(`[ehp-font] rendu d'image (${name})`, (x) => x.exports.length > before, EHP_V1_WAIT_MS);
        return st ? st.exports[st.exports.length - 1] : null;
      };
      const a = await frame("PoliceA", family);
      const b = await frame("PoliceB", "Inter");
      note("font frames", { a, b });
      check(!!a && !!b && a.magic === "89504e47" && b.magic === "89504e47" && a.sum !== b.sum, `[ehp-font] le texte se rend en police injectée comme en police de repli : ${JSON.stringify({ a, b })}`);
      const queued = async (name) => {
        const before = (await state()).exports.length;
        const added2 = await exec("renderQueue.add", { comp: name, format: "png" }).catch((e) => ({ error: String(e && e.message) }));
        const rendered = await exec("renderQueue.render", { wait: true }).catch((e) => ({ error: String(e && e.message) }));
        const st = await until(`[ehp-font-worker] rendu de la file (${name})`, (x) => x.exports.slice(before).some((e) => /\.zip$/.test(String(e.name)) || /\.png$/.test(String(e.name))), EHP_V1_WAIT_MS);
        const e = st ? st.exports.slice(before).find((x) => /\.zip$/.test(String(x.name)) || /\.png$/.test(String(x.name))) : null;
        return { added: added2, rendered, export: e, sums: e ? (e.entries.length ? e.entries : [e.sum]) : [] };
      };
      const qa = await queued("PoliceA");
      const qb = await queued("PoliceB");
      note("font render queue", { qa, qb, mark });
      check(qa.sums.length >= 1 && qb.sums.length >= 1 && qa.sums.every((x) => !qb.sums.includes(x)), `[ehp-font-worker] les rendus de la file ignorent la police injectée : ${JSON.stringify({ a: qa.sums, b: qb.sums, ea: qa.export && qa.export.name, eb: qb.export && qb.export.name })}`);
    }
  }

  // 8. evora:purge: answered after the stores are gone, nothing comes back afterwards.
  const beforePurge = await listing();
  r.beforePurge = beforePurge;
  const purgeAt = Date.now();
  await step("purge");
  s = await until("accusé d'evora:purge", (x) => answersTo(x, x.ids.purge).length > 0);
  if (s) {
    check(ackOk(s, s.ids.purge), `[ehp] accusé d'evora:purge absent ou négatif : ${JSON.stringify(answersTo(s, s.ids.purge))}`);
    const ackAt = s.acks[s.ids.purge] ? s.acks[s.ids.purge].at : 0;
    const afterPurge = await listing();
    r.purge = { ackAt, afterPurge };
    check(engineStores(afterPurge).length === 0, `[ehp] stockage du moteur non vide après evora:purge : ${JSON.stringify(engineStores(afterPurge))}`);
    check(keepers(afterPurge), `[ehp] témoins étrangers au moteur effacés par la purge : ${JSON.stringify(afterPurge)}`);
    // An edit after the purge (snapshot, flush, cache): no store may come back, and the engine
    // may not even try to write (a store already listed after the answer is « non vide » above).
    // Since the V1 bridge the host mode keeps no session snapshot (KIN-01): a save puts the project
    // in the engine's file table, which a writer still running would flush to browser storage.
    await exec("comp.new", {});
    await step("afterPurgeSave");
    await until("evora:save après evora:purge", (x) => x.saves.some((v) => v.re === x.ids.afterPurgeSave));
    await sleep(EHP_REWRITE_WAIT_MS);
    // Passes of the engine after that wait (a session snapshot is due at most a second after a
    // change): three requests, each answered by a later pass than the one before.
    for (let i = 0; i < 3; i++) await request("ui.inspect").catch(() => null);
    const later = await listing();
    r.purge.later = later;
    const leftAfter = new Set(engineStores(afterPurge).map(([k, n]) => `${k}:${n}`));
    const recreated = engineStores(later).filter(([k, n]) => !leftAfter.has(`${k}:${n}`));
    check(recreated.length === 0, `[ehp] le moteur a recréé un magasin après evora:purge : ${JSON.stringify(recreated)}`);
    const writes = await evalIn(ectx, "JSON.parse(JSON.stringify(window.__evoraWriteLog || []))");
    const late = writes.filter((w) => w.at > ackAt);
    const earlier = writes.filter((w) => w.at < purgeAt);
    r.purge.writes = writes;
    console.log(`SMOKE_DIAG ${label} purge ${JSON.stringify({ purgeAt, ackAt, writes: writes.length, earlier: earlier.length, late: late.length, last: writes.slice(-6) })}`);
    if (ehpMode === "memory") check(writes.length === 0, `[ehp] écriture du moteur en mode mémoire : ${JSON.stringify(writes.slice(0, 10))}`);
    else check(earlier.length >= 1, "[ehp] prémisse des écritures : aucune écriture du moteur observée pendant l'édition (OPFS)");
    check(late.length === 0, `[ehp] écriture du moteur après evora:purge : ${JSON.stringify(late.slice(0, 10))}`);
    // Every deletion, read once they are all done: each of the account's stores (OPFS, IndexedDB,
    // localStorage) went, before the answer.
    const deletions = await evalIn(ectx, "JSON.parse(JSON.stringify(window.__evoraPurgeLog || []))");
    r.purge.deletions = deletions;
    const own = deletions.filter((d) => d.at >= purgeAt && (storeNs(d.name) !== null || keyNs(d.name) !== null));
    check(own.length >= 1, `[ehp] aucune suppression observée pendant la purge : ${JSON.stringify(deletions)}`);
    check(deletions.every((d) => d.at <= ackAt), `[ehp] accusé d'evora:purge envoyé avant la fin des suppressions : ${JSON.stringify({ ackAt, deletions })}`);
    const doomed = engineStores(beforePurge).filter(([, , ns]) => ns === ehpNs || ns === "").map(([k, n]) => `${k}:${n}`);
    const goneBeforeAck = new Set(deletions.filter((d) => d.at >= purgeAt && d.at <= ackAt).map((d) => `${d.op}:${d.name}`));
    const kept = doomed.filter((x) => !goneBeforeAck.has(x));
    r.purge.doomed = doomed;
    check(kept.length === 0, `[ehp] magasins du compte non supprimés avant l'accusé : ${JSON.stringify(kept)}`);
    check(seededOwn.every((x) => doomed.includes(x)), `[ehp] prémisse de la purge : magasins du compte absents avant evora:purge : ${JSON.stringify(doomed)}`);
  }

  // 9. Every message from the engine: its own window and origin, a plain object, EHP v1, the
  //    exact envelope, ULIDs, an outbound type; every answer correlated to a request.
  s = await state();
  check(s.log.filter((m) => m.type === "evora:ready").length === 1, `[ehp] evora:ready reçu de nouveau en cours de séance : ${s.log.filter((m) => m.type === "evora:ready").length} fois`);
  const sent = new Set(Object.values(s.ids));
  for (const m of s.log) {
    if (!(m.fromEngine && m.plain && m.v === 1)) {
      check(false, `[ehp] message hors norme ou d'une autre source : ${JSON.stringify(m).slice(0, 300)}`);
      continue;
    }
    const keysOk = m.keys.every((k) => ["v", "type", "id", "re", "payload"].includes(k)) && ["v", "type", "id", "payload"].every((k) => m.keys.includes(k));
    check(keysOk, `[ehp] enveloppe hors norme : ${JSON.stringify(m.keys)}`);
    check(ULID.test(String(m.id)) && (m.re === null || ULID.test(String(m.re))), `[ehp] id ou re hors ULID : ${m.id} / ${m.re}`);
    check(EHP_OUTBOUND.has(m.type), `[ehp] type inattendu : ${m.type}`);
    check(m.type !== "evora:failed", `[ehp] evora:failed : ${JSON.stringify(m.payload)}`);
    if (m.type === "evora:ack" || (m.type === "evora:save" && m.re !== null)) check(sent.has(m.re), `[ehp] réponse à une demande inconnue : ${m.re}`);
  }
  r.messages = s.log.map((m) => `${m.type}${m.re ? `<${m.re.slice(-4)}` : ""}${m.payload && m.payload.code ? `:${m.payload.code}` : ""}${m.payload && m.payload.dirty !== undefined ? `:${m.payload.dirty}` : ""}`);
}

report.failures = [];
let exitCode = 1;
try {
  const version = await send("Browser.getVersion");
  report.chrome = version.product;
  // KIN-03: Chrome refuses every download and says so (Browser.downloadWillBegin).
  await send("Browser.setDownloadBehavior", { behavior: "deny", eventsEnabled: true }).catch((e) => warnings.push(`Browser.setDownloadBehavior: ${e.message}`));
  await systemGpu();
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: page } = await send("Target.attachToTarget", { targetId, flatten: true });
  pageSession = page;
  sessions.set(page, { type: "page", url: parentUrl });
  await setup(page, "page");
  await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false }, page);
  const t0 = Date.now();
  navigatedAt = Date.now();
  const nav = await send("Page.navigate", { url: parentUrl }, page);
  mainFrameId = nav.frameId || null;
  let load = null;
  let readyAt = null;
  while (Date.now() - t0 < timeoutMs) {
    const ctx = defaultCtx(engineOrigin);
    if (ctx) {
      try {
        // A context that goes away while it is asked (the « pont-ehp » bench's seed page opening
        // the engine) may leave the question unanswered: ask again rather than wait.
        load = await Promise.race([evalIn(ctx, "window.effectcraftLoad ? JSON.parse(JSON.stringify(window.effectcraftLoad)) : null"), sleep(LOAD_POLL_MS).then(() => null)]);
      } catch {
        load = null;
      }
      if (load && (load.readyMs !== undefined || load.error)) {
        readyAt = Date.now();
        break;
      }
    }
    await sleep(250);
  }
  report.load = load;
  report.wallReadyMs = readyAt ? readyAt - t0 : null;
  check(!!defaultCtx(engineOrigin), `aucun contexte d'exécution sur l'origine du moteur ${engineOrigin}`);
  check(readyAt !== null, `moteur non prêt en ${timeoutMs} ms`);
  check(!(load && load.error), `échec du démarrage : ${load && load.error}`);
  if (readyAt !== null && !(load && load.error)) {
    await sleep(settleMs);
    const ctx = defaultCtx(engineOrigin);
    report.dom = await evalIn(
      ctx,
      `(() => { const c = document.getElementById("effectcraft_canvas"); const r = c ? c.getBoundingClientRect() : null;
        const nav = performance.getEntriesByType("navigation")[0];
        let top; try { top = window.top.location.href; } catch (e) { top = "inaccessible (" + e.name + ")"; }
        return { origin: location.origin, href: location.href, canvas: !!c, width: c ? c.width : 0, height: c ? c.height : 0,
          cssWidth: r ? r.width : 0, cssHeight: r ? r.height : 0, loading: !!document.getElementById("loading"), top,
          navigation: nav ? { fetchStart: nav.fetchStart, responseEnd: nav.responseEnd, domContentLoaded: nav.domContentLoadedEventEnd, load: nav.loadEventEnd } : null }; })()`,
    );
    report.info = await evalIn(ctx, "JSON.parse(JSON.stringify(window.effectcraft.info()))");
    check(report.dom.canvas && report.dom.width > 0 && report.dom.height > 0, `canevas absent ou vide : ${JSON.stringify(report.dom)}`);
    check(!report.dom.loading, "l'avis de chargement est toujours affiché");
    const parentOrigin = new URL(parentUrl).origin;
    const pctx = parentCtx(parentOrigin);
    report.parent = pctx
      ? await evalIn(pctx, `(() => { const f = document.getElementById("engine"); let read; try { read = f.contentDocument === null ? "null (cross-origin)" : "readable"; } catch (e) { read = "blocked (" + e.name + ")"; } let api; try { api = typeof f.contentWindow.effectcraft; } catch (e) { api = "blocked (" + e.name + ")"; } return { origin: location.origin, contentDocument: read, contentWindowApi: api, sandbox: f.getAttribute("sandbox") }; })()`)
      : null;
    check(report.parent && report.parent.origin !== report.dom.origin, "le parent et le moteur ont la même origine");
    check(report.parent && report.parent.contentDocument !== "readable", "le parent lit le document du moteur (même origine)");
    if (ehpMode) await runEhp(ctx, parentOrigin);
    // What the engine draws: the menus in every catalog language and the widgets on screen
    // (not in the « pont-ehp » bench: the other passes read them).
    const labels = [];
    const perLanguage = {};
    if (!ehpMode) {
    const menuLabels = () => evalIn(ctx, `window.effectcraft.request("ui.menu.list", {}).then((r) => r.map((i) => String(i.label ?? "")))`, true, 60000);
    const initialLabels = expectLang ? await menuLabels() : null;
    let englishLabels = null;
    for (const lang of LANGUAGES) {
      await evalIn(ctx, `window.effectcraft.execute("prefs.set", { key: "general.language", value: ${JSON.stringify(lang === "en" ? "en" : lang)} })`, true, 30000).catch((e) =>
        warnings.push(`prefs.set ${lang}: ${e.message}`),
      );
      const items = await evalIn(ctx, `window.effectcraft.request("ui.menu.list", {}).then((r) => JSON.parse(JSON.stringify(r)))`, true, 60000);
      const texts = [];
      for (const it of items || []) {
        texts.push(String(it.label ?? ""));
        for (const seg of it.path || []) texts.push(String(seg));
      }
      perLanguage[lang] = texts.length;
      if (lang === "en") englishLabels = (items || []).map((it) => String(it.label ?? ""));
      labels.push(...texts.map((t) => [lang, t, "menu"]));
    }
    await evalIn(ctx, `window.effectcraft.execute("prefs.set", { key: "general.language", value: "system" })`, true, 30000).catch(() => {});
    if (expectTheme) {
      const inspect = await evalIn(ctx, `window.effectcraft.request("ui.inspect", {}).then((r) => JSON.parse(JSON.stringify(r)))`, true, 60000);
      const theme = String(inspect && inspect.ui ? inspect.ui.theme : "");
      report.theme = { expected: expectTheme, shown: theme };
      check(theme.toLowerCase() === expectTheme, `thème imposé « ${expectTheme} » absent (thème affiché « ${theme} »)`);
      await diag(ctx, "theme");
    }
    if (expectLang) {
      const differ = (initialLabels || []).filter((l, i) => englishLabels && l !== englishLabels[i]).length;
      report.lang = { expected: expectLang, labels: (initialLabels || []).length, translatedAtStart: differ, sample: (initialLabels || []).slice(0, 8) };
      check(differ >= 20, `langue imposée « ${expectLang} » absente au démarrage (${differ} libellés traduits)`);
    }
    if (linksMode === "block") {
      const pages = async () => (await send("Target.getTargets")).targetInfos.filter((x) => x.type === "page").length;
      const before = await pages();
      const errBefore = errors.length;
      for (const cmd of ["help.github", "help.docs", "help.reportIssue", "help.onlineTutorials"]) {
        await evalIn(ctx, `window.effectcraft.execute(${JSON.stringify(cmd)}, {})`, true, 30000).catch((e) => warnings.push(`${cmd}: ${e.message}`));
      }
      await sleep(2000);
      const after = await pages();
      report.links = { commands: 4, pagesBefore: before, pagesAfter: after, errorsDuring: errors.slice(errBefore) };
      check(after === before, `un lien externe a ouvert une page (${before} -> ${after})`);
      check(errors.length === errBefore, `erreur(s) en ouvrant les liens externes : ${JSON.stringify(errors.slice(errBefore))}`);
    }
    const elements = await evalIn(ctx, `window.effectcraft.request("ui.elements", {}).then((r) => JSON.parse(JSON.stringify(r)))`, true, 60000).catch((e) => {
      warnings.push(`ui.elements: ${e.message}`);
      return [];
    });
    // Widgets on screen: their automation labels (source strings), checked for marks and emoji;
    // never on an empty list (EVORA-KIN-25: a lost graphics device draws no widget).
    for (const el of elements || []) labels.push(["screen", String(el.label ?? ""), "screen"]);
    check(Array.isArray(elements) && elements.length > 0, `aucun widget à l'écran : les contrôles d'écran (marques, émojis) portent sur une liste vide (${JSON.stringify(elements).slice(0, 80)})`);
    const hits = (re, only) => labels.filter(([, t, src]) => (!only || src === only) && re.test(t));
    report.render = {
      menuItemsPerLanguage: perLanguage,
      screenElements: (elements || []).length,
      texts: labels.length,
      brand: hits(BRAND).slice(0, 20),
      emoji: hits(EMOJI).slice(0, 20),
      pictographs: hits(PICTO).slice(0, 20),
      // Sensitive terms: in the menu labels as drawn (after translation and the E9 overrides).
      terms: hits(TERMS, "menu").slice(0, 40),
      termsCount: hits(TERMS, "menu").length,
    };
    check(labels.length > 0, "aucun libellé relu au rendu (ui.menu.list, ui.elements)");
    check(report.render.brand.length === 0, `marques ArtCraft au rendu : ${JSON.stringify(report.render.brand)}`);
    check(report.render.emoji.length === 0, `émojis au rendu : ${JSON.stringify(report.render.emoji)}`);
    if (termsMode === "block") check(report.render.termsCount === 0, `termes sensibles au rendu : ${JSON.stringify(report.render.terms)}`);
    }
    // Every pass that started (EVORA-KIN-25): the graphics device alive and widgets on screen at
    // its end; the GPU evidence when they aren't.
    const screen = await judgeScreen(ctx);
    if (screen.lost !== false || !(screen.elements > 0)) await gpuEvidence();
    const shot = await send("Page.captureScreenshot", { format: "png" }, page);
    writeFileSync(join(out, `smoke-${label}.png`), Buffer.from(shot.data, "base64"));
  }
  await sleep(500);
  check(errors.length === 0, `${errors.length} erreur(s) de page`);
  check(issues.length === 0, `${issues.length} violation(s) de CSP`);
  exitCode = report.failures.length ? 1 : 0;
} catch (e) {
  report.failures.push(String(e && e.stack ? e.stack : e));
  console.log(`::error::smoke ${label}: ${e && e.message}`);
} finally {
  report.errors = errors;
  report.cspIssues = issues;
  report.warnings = warnings.slice(0, 200);
  report.logs = logs.slice(0, 200);
  report.ok = exitCode === 0;
  if (witnessRequire.length) {
    const fails = report.failures;
    const missing = witnessRequire.filter((w) => !fails.some((f) => f.includes(w)));
    const unexpected = fails.filter((f) => !witnessRequire.some((w) => f.includes(w)) && !witnessTolerate.some((w) => f.includes(w)));
    const witnessOk = fails.length > 0 && missing.length === 0 && unexpected.length === 0;
    report.witness = { require: witnessRequire, tolerate: witnessTolerate, missing, unexpected, ok: witnessOk };
    exitCode = witnessOk ? 0 : 1;
    console.log(`SMOKE_WITNESS label=${label} ok=${witnessOk} required=${witnessRequire.length} missing=${JSON.stringify(missing)} unexpected=${JSON.stringify(unexpected)}`);
  }
  writeFileSync(join(out, `smoke-${label}.json`), JSON.stringify(report, null, 2));
  const l = report.load || {};
  const r = report.render || {};
  console.log(
    `SMOKE label=${label} ok=${report.ok} theme=${report.theme ? report.theme.shown : "-"} ehp=${report.ehp ? `${report.ehp.mode}:${report.ehp.backend ?? "-"}:${(report.ehp.messages || []).length}msg` : "-"} lang=${report.lang ? `${report.lang.expected}:${report.lang.translatedAtStart}` : "-"} links=${report.links ? `${report.links.pagesBefore}->${report.links.pagesAfter}/${report.links.errorsDuring.length}` : "-"} chrome="${report.chrome}" wall_ready_ms=${report.wallReadyMs} wasm_ms=${l.wasmMs !== undefined ? Math.round(l.wasmMs) : "-"} ready_ms=${l.readyMs !== undefined ? Math.round(l.readyMs) : "-"} backend=${report.info ? JSON.stringify(report.info.backend ?? null) : "-"} webgpu=${report.info ? report.info.webgpu : "-"} errors=${errors.length} csp=${issues.length} lost=${report.screen ? JSON.stringify(report.screen.lost) : "-"} elements=${report.screen ? report.screen.elements : "-"} texts=${r.texts ?? "-"} brand=${r.brand ? r.brand.length : "-"} emoji=${r.emoji ? r.emoji.length : "-"} terms=${r.termsCount ?? "-"}`,
  );
  for (const e of errors.slice(0, 30)) console.log(`SMOKE_ERROR ${e}`);
  for (const i of issues.slice(0, 10)) console.log(`SMOKE_CSP ${i}`);
  for (const f of report.failures) console.log(`SMOKE_FAIL ${f}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = [
      `### Test de fumée « ${label} » (Chrome sans interface, iframe d'une autre origine)`,
      "",
      "| Élément | Valeur |",
      "|---|---|",
      `| Résultat | ${report.ok ? "VERT" : "ROUGE"} |`,
      `| Chrome | ${report.chrome ?? "?"} |`,
      `| Parent / moteur | ${parentUrl} / ${engineOrigin} |`,
      `| Démarrage à froid (navigation du parent → moteur prêt) | ${report.wallReadyMs ?? "-"} ms |`,
      `| Moteur : wasm compilé et instancié / prêt (depuis le script du moteur) | ${l.wasmMs !== undefined ? Math.round(l.wasmMs) : "-"} ms / ${l.readyMs !== undefined ? Math.round(l.readyMs) : "-"} ms |`,
      `| Rendu (backend, WebGPU) | ${report.info ? `${JSON.stringify(report.info.backend ?? null)}, ${report.info.webgpu}` : "-"} |`,
      `| Canevas | ${report.dom ? `${report.dom.width}×${report.dom.height}` : "-"} |`,
      `| Parent → moteur | ${report.parent ? `${report.parent.contentDocument}, API ${report.parent.contentWindowApi}, sandbox « ${report.parent.sandbox} »` : "-"} |`,
      `| Erreurs de page / violations CSP | ${errors.length} / ${issues.length} |`,
      `| Libellés relus au rendu (menus × ${LANGUAGES.length} langues + écran) | ${r.texts ?? "-"} |`,
      `| Marques / émojis / termes sensibles au rendu | ${r.brand ? r.brand.length : "-"} / ${r.emoji ? r.emoji.length : "-"} / ${r.termsCount ?? "-"} (${termsMode === "block" ? "bloquant" : "mesure"}) |`,
      `| Thème imposé (E2) | ${report.theme ? `${report.theme.expected} : ${report.theme.shown}` : "non vérifié"} |`,
      `| Langue imposée (E3) | ${report.lang ? `${report.lang.expected} : ${report.lang.translatedAtStart} libellés de menu traduits dès le démarrage sur ${report.lang.labels}` : "non vérifiée"} |`,
      `| Pont EHP et stockage (E4, E5) | ${report.ehp ? `${report.ehp.mode}, stockage ${report.ehp.backend ?? "-"} ; échanges : ${(report.ehp.messages || []).join(" ")} ; après evora:init OPFS ${JSON.stringify(report.ehp.afterInit ? report.ehp.afterInit.opfs : null)} ; après evora:purge OPFS ${JSON.stringify(report.ehp.purge ? report.ehp.purge.afterPurge.opfs : null)}, IndexedDB ${JSON.stringify(report.ehp.purge ? report.ehp.purge.afterPurge.idb : null)}` : "non vérifié"} |`,
      `| Liens externes (E7 : 4 commandes Help) | ${report.links ? `pages ${report.links.pagesBefore} -> ${report.links.pagesAfter}, erreurs ${report.links.errorsDuring.length}` : "non vérifié"} |`,
      `| Périphérique graphique / widgets à l'écran (fin de passe) | ${report.screen ? `${report.screen.lost === false ? "vivant" : `perdu (${report.screen.lost})`} / ${report.screen.elements}` : "non vérifié"} |`,
      "",
    ];
    if (report.failures.length) rows.push(...report.failures.map((f) => `- échec : ${f}`), "");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, rows.join("\n") + "\n");
  }
  await Promise.race([send("Browser.close").catch(() => {}), sleep(3000)]);
  proc.kill("SIGKILL");
  process.exit(exitCode);
}
