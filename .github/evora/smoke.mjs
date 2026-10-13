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
      contexts.set(`${msg.sessionId}:${c.id}`, { sessionId: msg.sessionId, id: c.id, origin: c.origin, isDefault: !!(c.auxData && c.auxData.isDefault) });
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

function check(cond, msg) {
  if (!cond) {
    report.failures.push(msg);
    console.log(`::error::smoke ${label}: ${msg}`);
  }
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
  await send("Page.navigate", { url: parentUrl }, page);
  let load = null;
  let readyAt = null;
  while (Date.now() - t0 < timeoutMs) {
    const ctx = defaultCtx(engineOrigin);
    if (ctx) {
      try {
        load = await evalIn(ctx, "window.effectcraftLoad ? JSON.parse(JSON.stringify(window.effectcraftLoad)) : null");
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
    const pctx = defaultCtx(parentOrigin);
    report.parent = pctx
      ? await evalIn(pctx, `(() => { const f = document.getElementById("engine"); let read; try { read = f.contentDocument === null ? "null (cross-origin)" : "readable"; } catch (e) { read = "blocked (" + e.name + ")"; } let api; try { api = typeof f.contentWindow.effectcraft; } catch (e) { api = "blocked (" + e.name + ")"; } return { origin: location.origin, contentDocument: read, contentWindowApi: api, sandbox: f.getAttribute("sandbox") }; })()`)
      : null;
    check(report.parent && report.parent.origin !== report.dom.origin, "le parent et le moteur ont la même origine");
    check(report.parent && report.parent.contentDocument !== "readable", "le parent lit le document du moteur (même origine)");
    // What the engine draws: the menus in every catalog language and the widgets on screen.
    const labels = [];
    const perLanguage = {};
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
    `SMOKE label=${label} ok=${report.ok} lang=${report.lang ? `${report.lang.expected}:${report.lang.translatedAtStart}` : "-"} links=${report.links ? `${report.links.pagesBefore}->${report.links.pagesAfter}/${report.links.errorsDuring.length}` : "-"} chrome="${report.chrome}" wall_ready_ms=${report.wallReadyMs} wasm_ms=${l.wasmMs !== undefined ? Math.round(l.wasmMs) : "-"} ready_ms=${l.readyMs !== undefined ? Math.round(l.readyMs) : "-"} backend=${report.info ? JSON.stringify(report.info.backend ?? null) : "-"} webgpu=${report.info ? report.info.webgpu : "-"} errors=${errors.length} csp=${issues.length} texts=${r.texts ?? "-"} brand=${r.brand ? r.brand.length : "-"} emoji=${r.emoji ? r.emoji.length : "-"} terms=${r.termsCount ?? "-"}`,
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
      `| Langue imposée (E3) | ${report.lang ? `${report.lang.expected} : ${report.lang.translatedAtStart} libellés de menu traduits dès le démarrage sur ${report.lang.labels}` : "non vérifiée"} |`,
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
