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
// screenshot; exits non-zero on failure.
//
//   node smoke.mjs --parent=http://127.0.0.1:8602/parent.html --engine=http://127.0.0.1:8601 \
//     --label=plain --out=/tmp/smoke [--chrome=google-chrome] [--timeout=240000] [--terms=block]
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
// `--expect-theme=light` (patch E2): the engine was framed with `?theme=light`.
const expectTheme = opt["expect-theme"] || "";
const LANGUAGES = ["en", "ja", "zh-hans", "zh-hant", "uk", "es", "pt-br", "ru", "fr", "de", "cs"];
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
const contexts = new Map();
const sessions = new Map();
const report = { label, parentUrl, engineOrigin, ok: false };

const profile = mkdtempSync(join(tmpdir(), "evora-chrome-"));
const flags = [
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
  "--window-size=1400,900",
  "about:blank",
];
const proc = spawn(chrome, flags, { stdio: ["ignore", "ignore", "pipe"] });
let chromeErr = "";
const wsUrl = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`Chrome did not print its DevTools URL: ${chromeErr.slice(-2000)}`)), 30000);
  proc.stderr.on("data", (d) => {
    chromeErr = (chromeErr + d).slice(-100000);
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
const parentCtx = (origin) => [...contexts.values()].find((c) => c.origin === origin && c.isDefault && (!mainFrameId || c.frameId === mainFrameId));

function check(cond, msg) {
  if (!cond) {
    report.failures.push(msg);
    console.log(`::error::smoke ${label}: ${msg}`);
  }
}

// ------------------------------------------------------------------ « pont-ehp » (E4, E5)

// What the engine declares in evora:ready (src/ehp.rs), each capability exercised below;
// `storage.memory` only when it was framed in the memory mode (`?storage=memory`).
const EHP_CAPABILITIES = ["doc.open", "doc.save", "doc.dirty", "doc.request-save", "storage.ns", "storage.purge", "live.lang", "live.theme"];
const EHP_EXPECTED = ehpMode === "memory" ? [...EHP_CAPABILITIES, "storage.memory"] : EHP_CAPABILITIES;
const EHP_KNOWN = new Set([...EHP_CAPABILITIES, "storage.memory", "doc.saved-ack", "doc.multi", "export.drive", "media.need", "media.ranges", "pick.drive", "command", "font.inject", "author"]);
const EHP_OUTBOUND = new Set(["evora:ready", "evora:failed", "evora:ack", "evora:dirty", "evora:save"]);
const EHP_WAIT_MS = 30000;
const EHP_READY_WAIT_MS = 20000;
const EHP_ROGUE_SETTLE_MS = 1500;
const EHP_ADOPT_MS = 800;
const EHP_REWRITE_WAIT_MS = 2500;
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
// Every deletion the engine makes from now on, with the wall-clock time it completed (the purge's
// answer, stamped on the same clock by the parent page, must come after them; performance.now()
// of two documents isn't comparable).
const PURGE_HOOKS = `(() => { const log = (window.__evoraPurgeLog = []); const at = () => Date.now();
  const rm = FileSystemDirectoryHandle.prototype.removeEntry;
  FileSystemDirectoryHandle.prototype.removeEntry = function (...a) { return rm.apply(this, a).then((v) => { log.push({ op: "opfs", name: a[0], at: at() }); return v; }); };
  const del = IDBFactory.prototype.deleteDatabase;
  IDBFactory.prototype.deleteDatabase = function (name) { const r = del.call(this, name); r.addEventListener("success", () => log.push({ op: "idb", name, at: at() })); return r; };
  const lr = Storage.prototype.removeItem;
  Storage.prototype.removeItem = function (k) { const v = lr.call(this, k); log.push({ op: "ls", name: k, at: at() }); return v; };
  return true; })()`;

async function runEhp(ectx, parentOrigin) {
  const r = (report.ehp = { mode: ehpMode, ns: ehpNs, urlNs: ehpUrlNs, steps: [] });
  const note = (k, v) => r.steps.push({ [k]: v });
  const state = async () =>
    evalIn(parentCtx(parentOrigin), "JSON.parse(JSON.stringify({ log: __ehp.log, ids: __ehp.ids, harness: __ehp.harness, saves: __ehp.saves, acks: __ehp.acks }))");
  const step = (name) => evalIn(parentCtx(parentOrigin), `__ehp.step.${name}()`);
  const exec = (command, params) =>
    evalIn(ectx, `window.effectcraft.execute(${JSON.stringify(command)}, ${JSON.stringify(params || {})}).then((v) => JSON.parse(JSON.stringify(v ?? null)))`, true, 60000);
  const request = (method) => evalIn(ectx, `window.effectcraft.request(${JSON.stringify(method)}, {}).then((v) => JSON.parse(JSON.stringify(v ?? null)))`, true, 60000);
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
    idb: ["effectcraft-handles", `evns-${EHP_OTHER_NS}--effectcraft-handles`, "evora-keep"],
    ls: [`evns-${EHP_OTHER_NS}--effectcraft`, "effectcraft-seed", "evora-keep"],
  };
  const keepers = (l) => l.opfs.includes("evora-keep") && l.idb.includes("evora-keep") && l.ls.includes("evora-keep");

  // 1. The seed page saw its fixture (else a purge check would pass on nothing).
  let s = await until("rapport de la page d'amorçage", (x) => x.harness.some((h) => h.report && h.report.harness === "seed"), EHP_READY_WAIT_MS);
  const seedEntry = s ? s.harness.find((h) => h.report.harness === "seed") : null;
  const seed = seedEntry ? seedEntry.report : null;
  r.seed = seed;
  r.timing = { navigation: navigatedAt, seed: seedEntry ? Math.round(seedEntry.at - navigatedAt) : null };
  check(!!(seed && seed.listing && ["opfs", "idb", "ls"].every((k) => seeded[k].every((n) => seed.listing[k].includes(n)))), `[ehp] amorçage incomplet : ${JSON.stringify(seed)}`);

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
  s = await until("accusé d'evora:open", (x) => answersTo(x, x.ids.open).length > 0);
  if (!s) return;
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
  check(afterInit.opfs.includes(`evns-${ehpNs}--effectcraft-cache`), "[ehp] magasin du même compte effacé au démarrage (il doit rester)");
  check(!engineStores(afterInit).some(([, , ns]) => ns === ehpUrlNs), `[ehp] espace de noms lu dans l'URL : ${JSON.stringify(afterInit)}`);
  const own = engineStores(afterInit).filter(([, , ns]) => ns === ehpNs).map(([k, n]) => `${k}:${n}`);
  if (ehpMode === "memory") {
    check(r.backend === "memory", `[ehp] stockage du moteur ${r.backend} (attendu : memory)`);
    check(own.length === 1 && own[0] === `opfs:evns-${ehpNs}--effectcraft-cache`, `[ehp] le moteur a créé un magasin en mode mémoire : ${JSON.stringify(own)}`);
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
  check(/^dark/i.test(theme1), `[ehp] thème d'evora:init (sombre) absent : ${theme1}`);

  // 5. No answer to a window that isn't the parent, to an origin not admitted, to version 2; the
  //    parent's own request (the witness) is answered.
  await step("rogue");
  s = await until("ordres des fenêtres intruses", (x) => x.harness.filter((h) => h.report && h.report.harness === "rogue").length === 2);
  await sleep(EHP_ROGUE_SETTLE_MS);
  await step("clean");
  s = await until("réponse à evora:request-save (témoin)", (x) => answersTo(x, x.ids.clean).length > 0);
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
    await until("evora:dirty {dirty: false} après l'enregistrement", (x) => x.log.some((m) => m.type === "evora:dirty" && m.payload && m.payload.dirty === false && m.at > v.at));
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

  // 7. Language and theme while running (live.lang, live.theme).
  await step("live");
  s = await until("accusés d'evora:theme et d'evora:lang", (x) => answersTo(x, x.ids.theme).length > 0 && answersTo(x, x.ids.lang).length > 0);
  if (s) {
    check(ackOk(s, s.ids.theme) && ackOk(s, s.ids.lang), `[ehp] accusés d'evora:theme / evora:lang : ${JSON.stringify([answersTo(s, s.ids.theme), answersTo(s, s.ids.lang)])}`);
    await sleep(500);
    const deLabels = labelsOf(await request("ui.menu.list"));
    const inspect2 = await request("ui.inspect");
    const theme2 = String(inspect2 && inspect2.ui ? inspect2.ui.theme : "");
    const changed = deLabels.filter((l, i) => l !== frLabels[i]).length;
    note("live", { theme: theme2, labelsChanged: changed });
    check(deLabels.includes("Speichern") && changed >= 20, `[ehp] langue à chaud (de) absente : ${changed} libellés changés`);
    check(/^light/i.test(theme2), `[ehp] thème à chaud (clair) absent : ${theme2}`);
  }

  // 8. evora:purge: answered after the stores are gone, nothing comes back afterwards.
  const beforePurge = await listing();
  r.beforePurge = beforePurge;
  await evalIn(ectx, PURGE_HOOKS);
  await step("purge");
  s = await until("accusé d'evora:purge", (x) => answersTo(x, x.ids.purge).length > 0);
  if (s) {
    check(ackOk(s, s.ids.purge), `[ehp] accusé d'evora:purge absent ou négatif : ${JSON.stringify(answersTo(s, s.ids.purge))}`);
    const ackAt = s.acks[s.ids.purge] ? s.acks[s.ids.purge].at : 0;
    const afterPurge = await listing();
    r.purge = { ackAt, afterPurge };
    check(engineStores(afterPurge).length === 0, `[ehp] stockage du moteur non vide après evora:purge : ${JSON.stringify(engineStores(afterPurge))}`);
    check(keepers(afterPurge), `[ehp] témoins étrangers au moteur effacés par la purge : ${JSON.stringify(afterPurge)}`);
    // An edit after the purge (snapshot, flush, cache): no store may come back.
    await exec("comp.new", {});
    await sleep(EHP_REWRITE_WAIT_MS);
    const later = await listing();
    r.purge.later = later;
    check(engineStores(later).length === 0, `[ehp] le moteur a recréé un magasin après evora:purge : ${JSON.stringify(engineStores(later))}`);
    // Every deletion, read once they are all done: the engine's stores went, before the answer.
    const deletions = await evalIn(ectx, "JSON.parse(JSON.stringify(window.__evoraPurgeLog || []))");
    r.purge.deletions = deletions;
    const own = deletions.filter((d) => storeNs(d.name) !== null || keyNs(d.name) !== null);
    check(own.length >= 1, `[ehp] aucune suppression observée pendant la purge : ${JSON.stringify(deletions)}`);
    check(deletions.every((d) => d.at <= ackAt), `[ehp] accusé d'evora:purge envoyé avant la fin des suppressions : ${JSON.stringify({ ackAt, deletions })}`);
  }

  // 9. Every message from the engine: its own window and origin, a plain object, EHP v1, the
  //    exact envelope, ULIDs, an outbound type; every answer correlated to a request.
  s = await state();
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
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: page } = await send("Target.attachToTarget", { targetId, flatten: true });
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
    // Widgets on screen: their automation labels (source strings), checked for marks and emoji.
    for (const el of elements || []) labels.push(["screen", String(el.label ?? ""), "screen"]);
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
  writeFileSync(join(out, `smoke-${label}.json`), JSON.stringify(report, null, 2));
  const l = report.load || {};
  const r = report.render || {};
  console.log(
    `SMOKE label=${label} ok=${report.ok} theme=${report.theme ? report.theme.shown : "-"} ehp=${report.ehp ? `${report.ehp.mode}:${report.ehp.backend ?? "-"}:${(report.ehp.messages || []).length}msg` : "-"} lang=${report.lang ? `${report.lang.expected}:${report.lang.translatedAtStart}` : "-"} links=${report.links ? `${report.links.pagesBefore}->${report.links.pagesAfter}/${report.links.errorsDuring.length}` : "-"} chrome="${report.chrome}" wall_ready_ms=${report.wallReadyMs} wasm_ms=${l.wasmMs !== undefined ? Math.round(l.wasmMs) : "-"} ready_ms=${l.readyMs !== undefined ? Math.round(l.readyMs) : "-"} backend=${report.info ? JSON.stringify(report.info.backend ?? null) : "-"} webgpu=${report.info ? report.info.webgpu : "-"} errors=${errors.length} csp=${issues.length} texts=${r.texts ?? "-"} brand=${r.brand ? r.brand.length : "-"} emoji=${r.emoji ? r.emoji.length : "-"} terms=${r.termsCount ?? "-"}`,
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
      "",
    ];
    if (report.failures.length) rows.push(...report.failures.map((f) => `- échec : ${f}`), "");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, rows.join("\n") + "\n");
  }
  await Promise.race([send("Browser.close").catch(() => {}), sleep(3000)]);
  proc.kill("SIGKILL");
  process.exit(exitCode);
}
