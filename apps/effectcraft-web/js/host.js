// Browser services for the EffectCraft web app (imported by the wasm module through
// wasm-bindgen; see src/persist.rs, src/audio.rs and src/worker.rs):
//
// - storage: the Origin Private File System, or IndexedDB where OPFS can't write;
// - audio: a Web Audio output (AudioWorklet, ScriptProcessorNode fallback) fed stereo blocks;
// - workers: a pool of Web Workers, each running its own instance of the engine.
//
// Plain functions only: the Rust side owns the logic.

// ------------------------------------------------------------------ storage

// Evora (E4, E5): the engine's browser stores and their namespace. Without the Evora host bridge
// (`?host=evora`) nothing changes: the upstream names (`effectcraft` folders and databases). In
// the bridge (src/ehp.rs), the namespace is the `storageNs` of the host's `evora:init` and nothing
// else, never a URL parameter: `storageConfigure` names every store `evns-<storageNs>--<name>`
// (the OPFS folders `effectcraft` and `effectcraft-cache`, the IndexedDB databases `effectcraft`
// and `effectcraft-handles`), or turns browser storage off (memory only) when the host gave no
// namespace or the engine runs in the memory mode. Workers get the same settings in their init
// message. `storagePurge` deletes stores: the host's `evora:purge`, and the other namespaces at
// `evora:init`; it stops every writer first. A namespace is not a partition: accounts are
// isolated by the engine's own origin (mode B).
const NS_PREFIX = "evns-";
const NS_RE = /^[0-9a-f]{64}$/;
// The engine's store names, upstream's; namespaced ones are `evns-<id>--<name>` (any id, so the
// stores an earlier build named otherwise are found too).
const ENGINE_STORES = ["effectcraft", "effectcraft-cache", "effectcraft-handles"];
const NAMESPACED = /^evns-([A-Za-z0-9_-]{1,64})--(.+)$/;
// localStorage: the engine writes none (eframe's persistence is off); keys named like its stores
// would be its own.
const ENGINE_KEY = /^effectcraft/;
const PURGE_ATTEMPTS = 6;
const PURGE_RETRY_MS = 250;
const IDB_DELETE_TIMEOUT_MS = 3000;
let STORAGE_NS = "";
let STORAGE_OFF = false;
// Configured by the host bridge (or a worker of a bridged page): never ask the browser to keep
// the origin's storage (`navigator.storage.persist`).
let HOSTED = false;
// After `evora:purge`: browser storage stays off for the life of the page.
let PURGED = false;
const nsName = (base) => (STORAGE_NS ? `${NS_PREFIX}${STORAGE_NS}--${base}` : base);
const storeDir = () => nsName("effectcraft");
const storeDb = () => nsName("effectcraft");
const STORE = "entries";

/// Evora: name the engine's stores after `ns` (64 lowercase hex digits; "" for none) and say
/// whether it may keep anything in browser storage (`off`: memory only, no store is opened).
/// Called once, by the host bridge before storage is opened, or by a worker from the page's init
/// message. Returns whether `ns` was taken.
export function storageConfigure(ns, off) {
  HOSTED = true;
  STORAGE_NS = typeof ns === "string" && NS_RE.test(ns) ? ns : "";
  STORAGE_OFF = PURGED || !!off;
  for (const k of CACHE_KINDS) delete cacheDirHandles[k];
  return STORAGE_NS === ns;
}

function storageGuard() {
  if (STORAGE_OFF) throw new Error("browser storage is off for this editor");
}

// Operations on browser storage under way (a purge waits for them), and the page's IndexedDB
// connections (closed before a purge, so that deleting a database isn't blocked).
const inflight = new Set();
function tracked(p) {
  inflight.add(p);
  const done = () => inflight.delete(p);
  p.then(done, done);
  return p;
}
const openDbs = new Set();
function keepDb(db) {
  openDbs.add(db);
  db.onversionchange = () => { db.close(); openDbs.delete(db); };
  db.onclose = () => openDbs.delete(db);
  return db;
}

// The namespace of an engine store's name: "" for an upstream name, the id for a namespaced one,
// null for a store that isn't the engine's.
function storeNs(name) {
  if (ENGINE_STORES.includes(name)) return "";
  const m = NAMESPACED.exec(name);
  return m && ENGINE_STORES.includes(m[2]) ? m[1] : null;
}
function keyNs(key) {
  if (ENGINE_KEY.test(key)) return "";
  const m = NAMESPACED.exec(key);
  return m ? m[1] : null;
}
// What a purge deletes: "others" (`evora:init`) every engine store outside this namespace;
// "current" (`evora:purge`) this namespace's and the un-namespaced ones; "all" every engine store.
function doomed(mode, ns) {
  if (ns === null) return false;
  if (mode === "all") return true;
  if (mode === "current") return ns === "" || (STORAGE_NS !== "" && ns === STORAGE_NS);
  return ns === "" || ns !== STORAGE_NS;
}

/// The engine's stores a purge in `mode` would delete: [{kind: "opfs"|"idb"|"ls", name}].
async function doomedStores(mode) {
  const out = [];
  try {
    if (navigator.storage && navigator.storage.getDirectory) {
      const root = await navigator.storage.getDirectory();
      for await (const [name] of root.entries()) if (doomed(mode, storeNs(name))) out.push({ kind: "opfs", name });
    }
  } catch (e) { console.info(`storage purge (OPFS): ${e.message ?? e}`); }
  try {
    if (self.indexedDB && indexedDB.databases) {
      for (const { name } of await indexedDB.databases()) if (name && doomed(mode, storeNs(name))) out.push({ kind: "idb", name });
    }
  } catch (e) { console.info(`storage purge (IndexedDB): ${e.message ?? e}`); }
  try {
    if (self.localStorage) {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && doomed(mode, keyNs(k))) out.push({ kind: "ls", name: k });
      }
    }
  } catch (e) { console.info(`storage purge (localStorage): ${e.message ?? e}`); }
  return out;
}

// Delete an IndexedDB database; resolves with whether it went (a connection another tab holds
// keeps it until it closes, or the timeout).
function deleteDb(name) {
  return new Promise((res) => {
    const t = setTimeout(() => res(false), IDB_DELETE_TIMEOUT_MS);
    const r = indexedDB.deleteDatabase(name);
    r.onsuccess = () => { clearTimeout(t); res(true); };
    r.onerror = () => { clearTimeout(t); res(false); };
  });
}

/// Evora (E5): delete the engine's browser stores (`mode`: see `doomed`). With `stop` (the host's
/// `evora:purge`), the engine first stops writing for good: browser storage turns off (no store is
/// opened or created again; the page's store becomes memory only), the workers end (frame workers
/// write the disk cache), the page's IndexedDB connections close and the operations under way
/// finish. Then the stores go, and are listed again until none is left (a few attempts). Resolves
/// with {purged, remaining}: `opfs:<name>`, `idb:<name>`, `ls:<key>`.
export async function storagePurge(mode, stop) {
  if (stop) {
    PURGED = true;
    STORAGE_OFF = true;
    for (const k of CACHE_KINDS) delete cacheDirHandles[k];
    backend = memory();
    workersStop();
    for (const db of openDbs) {
      try { db.close(); } catch {}
    }
    openDbs.clear();
    await Promise.allSettled([...inflight]);
  }
  const purged = [];
  let remaining = [];
  for (let attempt = 0; attempt < PURGE_ATTEMPTS; attempt++) {
    let root = null;
    for (const s of await doomedStores(mode)) {
      try {
        if (s.kind === "opfs") {
          root = root || (await navigator.storage.getDirectory());
          await root.removeEntry(s.name, { recursive: true });
        } else if (s.kind === "idb") {
          if (!(await deleteDb(s.name))) continue;
        } else {
          localStorage.removeItem(s.name);
        }
        purged.push(`${s.kind}:${s.name}`);
      } catch (e) { console.info(`storage purge: ${s.kind}:${s.name}: ${e.message ?? e}`); }
    }
    remaining = (await doomedStores(mode)).map((s) => `${s.kind}:${s.name}`);
    if (!remaining.length) break;
    await new Promise((res) => setTimeout(res, PURGE_RETRY_MS));
  }
  if (purged.length) console.info(`storage purge (${mode}): ${purged.join(", ")}`);
  if (remaining.length) console.warn(`storage purge (${mode}): still present: ${remaining.join(", ")}`);
  return { purged, remaining };
}

let backend = null;

// OPFS file names can't hold "/": keys are percent-encoded.
const enc = (k) => encodeURIComponent(k);
const dec = (n) => decodeURIComponent(n);

async function opfs() {
  storageGuard();
  if (!navigator.storage || !navigator.storage.getDirectory) throw new Error("no OPFS");
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(storeDir(), { create: true });
  // Probe a write: some browsers expose OPFS but only write it from workers.
  const probe = await dir.getFileHandle(".probe", { create: true });
  if (!probe.createWritable) throw new Error("OPFS is read-only on this thread");
  const w = await probe.createWritable();
  await w.write(new Uint8Array([1]));
  await w.close();
  await dir.removeEntry(".probe");
  return {
    name: "opfs",
    async loadAll() {
      const out = [];
      for await (const [name, h] of dir.entries()) {
        if (h.kind !== "file" || name.startsWith(".") || name.endsWith(".crswap")) continue;
        const f = await h.getFile();
        out.push({ key: dec(name), data: new Uint8Array(await f.arrayBuffer()), modified: f.lastModified });
      }
      return out;
    },
    async put(key, data) {
      // createWritable writes a swap file and replaces the entry on close: atomic.
      const h = await dir.getFileHandle(enc(key), { create: true });
      const w = await h.createWritable();
      await w.write(data);
      await w.close();
    },
    async del(key) {
      try { await dir.removeEntry(enc(key)); } catch (e) { if (e.name !== "NotFoundError") throw e; }
    },
  };
}

function req(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

async function idb() {
  storageGuard();
  if (!self.indexedDB) throw new Error("no IndexedDB");
  const open = indexedDB.open(storeDb(), 1);
  open.onupgradeneeded = () => open.result.createObjectStore(STORE, { keyPath: "key" });
  const db = keepDb(await req(open));
  const tx = (mode) => db.transaction(STORE, mode).objectStore(STORE);
  return {
    name: "indexeddb",
    async loadAll() {
      const all = await req(tx("readonly").getAll());
      return all.map((r) => ({ key: r.key, data: new Uint8Array(r.data), modified: r.modified }));
    },
    async put(key, data, modified) {
      await req(tx("readwrite").put({ key, data: data.slice().buffer, modified }));
    },
    async del(key) {
      await req(tx("readwrite").delete(key));
    },
  };
}

function memory() {
  const m = new Map();
  return {
    name: "memory",
    async loadAll() { return [...m.values()]; },
    async put(key, data, modified) { m.set(key, { key, data: data.slice(), modified }); },
    async del(key) { m.delete(key); },
  };
}

/// Open the store: OPFS, else IndexedDB, else memory (nothing persists). Resolves with the
/// backend's name. `prefer` ("opfs" | "indexeddb" | "memory") forces one (tests). Evora: with
/// browser storage off (the host bridge without a namespace, or in the memory mode), memory.
export async function storeOpen(prefer) {
  const order = STORAGE_OFF ? [memory] : ({ opfs: [opfs, idb, memory], indexeddb: [idb, memory], memory: [memory] }[prefer] ?? [opfs, idb, memory]);
  for (const make of order) {
    try { backend = await make(); break; } catch (e) { console.info(`storage: ${make.name}: ${e.message ?? e}`); }
  }
  // Ask the browser not to evict the store under storage pressure (granted for installed apps).
  // Evora: never in the host bridge (a cache only; the server keeps the documents).
  if (!STORAGE_OFF && !HOSTED) {
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch {}
  }
  return backend.name;
}

/// Every stored entry: [{key, data: Uint8Array, modified}].
export async function storeLoadAll() { return tracked(backend.loadAll()); }
export async function storePut(key, data, modified) { return tracked(backend.put(key, data, modified)); }
export async function storeDelete(key) { return tracked(backend.del(key)); }

/// Ask the browser to keep the origin's storage under pressure; resolves with whether it is.
export async function storePersist() {
  if (STORAGE_OFF || HOSTED) return false;
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch {}
  return false;
}

/// {usage, quota, persisted, backend}.
export async function storeEstimate() {
  const out = { backend: backend ? backend.name : null };
  try {
    const e = await navigator.storage.estimate();
    out.usage = e.usage; out.quota = e.quota;
    out.persisted = await navigator.storage.persisted();
  } catch {}
  return out;
}

// ------------------------------------------------------------------ audio

// One AudioContext for the page. Browsers start it suspended until the user interacts with the
// page, so the first pointer/key event resumes it ("unlock").
let ctx = null;
let node = null;
let kind = null;
// Sample frames handed to the output since `audioStart`, and the context time it started at.
let posted = 0;
let startTime = 0;
let underruns = 0;
// ScriptProcessor fallback: the queue lives on this thread.
let spQueue = [];
let spOffset = 0;
// Blocks pushed while the output node is being created.
let starting = false;
let pendingPush = [];
// Bumped by every start/stop: a start superseded while it awaited the worklet gives up.
let generation = 0;

function context() {
  if (!ctx) {
    const AC = self.AudioContext || self.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC({ latencyHint: "interactive" });
  }
  return ctx;
}

function unlock() {
  const c = context();
  if (c && c.state !== "running") c.resume().catch(() => {});
}

/// Install the user-gesture unlock (called once at startup).
export function audioInstallUnlock() {
  for (const ev of ["pointerdown", "keydown", "touchend"]) {
    self.addEventListener(ev, unlock, { capture: true, passive: true });
  }
}

/// {state, sampleRate, backend, posted, played, underruns, baseLatency, outputLatency}.
export function audioState() {
  const c = ctx;
  return {
    state: c ? c.state : "none",
    sampleRate: c ? c.sampleRate : 0,
    backend: kind,
    posted,
    played: audioPlayed(),
    underruns,
    baseLatency: c ? c.baseLatency || 0 : 0,
    outputLatency: c ? c.outputLatency || 0 : 0,
  };
}

/// The output's sample rate (creates the context; 0 without Web Audio).
export function audioSampleRate() {
  const c = context();
  return c ? c.sampleRate : 0;
}

/// Start an output node; resolves when it is ready. Samples pushed before then queue up.
export async function audioStart(workletUrl) {
  audioStop();
  const c = context();
  if (!c) throw new Error("Web Audio is not available");
  unlock();
  posted = 0;
  underruns = 0;
  spQueue = [];
  spOffset = 0;
  starting = true;
  pendingPush = [];
  const gen = ++generation;
  if (c.audioWorklet && workletUrl) {
    try {
      if (!c.__ecWorklet) {
        await c.audioWorklet.addModule(workletUrl);
        c.__ecWorklet = true;
      }
      if (gen !== generation) return;
      node = new AudioWorkletNode(c, "effectcraft-output", { numberOfInputs: 0, outputChannelCount: [2] });
      node.port.onmessage = (e) => { if (e.data && e.data.underrun) underruns += e.data.underrun; };
      kind = "worklet";
    } catch (e) {
      console.warn("audio: AudioWorklet unavailable, using ScriptProcessorNode", e);
      node = null;
    }
  }
  if (!node) {
    node = c.createScriptProcessor(2048, 0, 2);
    node.onaudioprocess = (e) => {
      const l = e.outputBuffer.getChannelData(0);
      const r = e.outputBuffer.getChannelData(1);
      let i = 0;
      while (i < l.length && spQueue.length) {
        const b = spQueue[0];
        const n = Math.min(l.length - i, (b.length - spOffset) >> 1);
        for (let k = 0; k < n; k++) { l[i + k] = b[spOffset + 2 * k]; r[i + k] = b[spOffset + 2 * k + 1]; }
        i += n; spOffset += 2 * n;
        if (spOffset >= b.length) { spQueue.shift(); spOffset = 0; }
      }
      if (i < l.length) { underruns += l.length - i; l.fill(0, i); r.fill(0, i); }
    };
    kind = "scriptProcessor";
  }
  starting = false;
  if (!node) return;
  node.connect(c.destination);
  startTime = c.currentTime;
  const p = pendingPush;
  pendingPush = [];
  for (const b of p) send(b);
}

function send(samples) {
  if (kind === "worklet") node.port.postMessage(samples, [samples.buffer]);
  else spQueue.push(samples);
}

/// Queue interleaved stereo samples (Float32Array) for output.
export function audioPush(samples) {
  posted += samples.length >> 1;
  if (node && !starting) send(samples);
  else if (starting) pendingPush.push(samples);
}

/// Sample frames played since `audioStart`, by the context clock (AudioContext.currentTime).
export function audioPlayed() {
  if (!ctx || !node || starting) return 0;
  return Math.max(0, Math.round((ctx.currentTime - startTime) * ctx.sampleRate));
}

/// Output latency in sample frames (what's handed over but not audible yet comes on top).
export function audioOutputLatency() {
  if (!ctx) return 0;
  return Math.round(((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * ctx.sampleRate);
}

export function audioStop() {
  generation++;
  starting = false;
  pendingPush = [];
  if (node) {
    try { node.disconnect(); } catch {}
    if (kind === "worklet") node.port.postMessage("stop");
  }
  node = null;
  spQueue = [];
}

// ------------------------------------------------------------------ workers

// Idle workers are reused; each keeps the files it was sent (path → version) so a file goes to a
// worker once, and again when it was replaced (even by one of the same size, #218).
const idle = [];
const running = new Map(); // job id → {worker, done}
// Job workers open a WebGPU device of their own (unless `?nogpuworkers`): their jobs' frames
// render on it. `jobGpu`: what the last started worker reported; `jobStats`: the last jobs'
// {kind, gpu, passes, readbacks, ms}.
let jobWorkerGpu = true;
let jobGpu = null;
const jobStats = [];

export function setJobWorkerGpu(on) {
  jobWorkerGpu = !!on;
}

function spawn(base) {
  const worker = new Worker(new URL("worker.js", base), { type: "module", name: "effectcraft-worker" });
  const w = { worker, files: new Map(), ready: null, gpu: null, onMessage: null };
  w.ready = new Promise((res, rej) => {
    worker.onmessage = (e) => {
      if (e.data && e.data.type === "gpu") {
        w.gpu = e.data.gpu ? { adapter: e.data.gpu } : { cpu: e.data.error || "no GPU" };
        jobGpu = w.gpu;
      }
      if (e.data && e.data.type === "ready") res();
    };
    worker.onerror = (e) => rej(new Error(e.message || "worker failed to start"));
  });
  // Evora (E5): the page's storage settings, in the init message (never in the script's URL).
  worker.postMessage({ type: "init", module: self.effectcraftModule ?? null, base, gpu: jobWorkerGpu, storageNs: STORAGE_NS, storageOff: STORAGE_OFF });
  return w;
}

/// Evora (E5): end every worker before a purge (the host's `evora:purge`): frame workers write the
/// disk cache, job workers hand files to the page's store. A running job fails (its handler hears
/// it on the next task); src/frames.rs marked the frame workers gone first.
function workersStop() {
  for (let i = 0; i < frameWorkers.length; i++) {
    const fw = frameWorkers[i];
    frameWorkers[i] = null;
    if (fw) {
      try { fw.terminate(); } catch {}
    }
  }
  for (const [id, w] of running) {
    running.delete(id);
    try { w.worker.terminate(); } catch {}
    const tell = w.onMessage;
    if (tell) setTimeout(() => tell("error", "browser storage was purged: the job stopped", null, null), 0);
  }
  for (const w of idle.splice(0)) {
    try { w.worker.terminate(); } catch {}
  }
}

/// Run a job in a worker. `files`: [[path, Uint8Array, version]] the job reads (`version`
/// changes with every write of the file); `onMessage(type, json,
/// path, bytes)` receives "reply" (json), "file" (path, bytes: a rendered file to download),
/// "store" (path, bytes: a file to keep in browser storage) and "error" (json = message).
export function workerRun(id, json, files, base, onMessage) {
  const w = idle.pop() ?? spawn(base);
  w.onMessage = onMessage;
  running.set(id, w);
  w.ready.then(() => {
    w.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "reply") {
        onMessage("reply", m.json, null, null);
        if (m.done) {
          running.delete(id);
          idle.push(w);
        }
      } else if (m.type === "file") {
        onMessage("file", null, m.path, new Uint8Array(m.bytes));
      } else if (m.type === "store") {
        onMessage("store", null, m.path, new Uint8Array(m.bytes));
      } else if (m.type === "stats") {
        jobStats.push({ kind: m.kind, gpu: m.gpu, passes: m.passes, readbacks: m.readbacks, ms: m.ms });
        if (jobStats.length > 16) jobStats.shift();
      }
    };
    w.worker.onerror = (e) => {
      running.delete(id);
      onMessage("error", String(e.message || "worker error"), null, null);
      w.worker.terminate();
    };
    for (const [path, bytes, version] of files) {
      const tag = version ?? bytes.length;
      if (w.files.get(path) === tag) continue;
      w.files.set(path, tag);
      w.worker.postMessage({ type: "file", path, bytes });
    }
    w.worker.postMessage({ type: "job", json });
  }, (e) => {
    // The worker didn't start (#216): the job fails and the worker goes.
    running.delete(id);
    w.worker.terminate();
    onMessage("error", String(e.message || e), null, null);
  });
}

/// Stop a job: its worker is terminated (it can't be interrupted mid-job).
export function workerCancel(id) {
  const w = running.get(id);
  if (!w) return;
  running.delete(id);
  w.worker.terminate();
}

/// {running, idle, gpu, jobs: [{kind, gpu, passes, readbacks, ms}]}.
export function workerStats() {
  return { running: running.size, idle: idle.length, gpu: jobGpu, jobs: jobStats.slice() };
}

// ------------------------------------------------------------------ frame workers

// Long-lived workers that render viewer frames from a project replica (src/frames.rs). Unlike job
// workers they are never terminated between requests; the page sends one frame at a time each.
const frameWorkers = [];

/// Start a frame worker; returns its index. `onMessage(index, json, bytes, error)` receives each
/// `frameReply` (JSON, pixels as a Uint8Array) or, if the worker dies, the error. `gpu`: the
/// worker opens its own WebGPU device (when the browser has WebGPU in workers) and renders
/// GPU effects on it.
export function frameWorkerStart(base, onMessage, gpu) {
  const index = frameWorkers.length;
  const worker = new Worker(new URL("worker.js", base), { type: "module", name: `effectcraft-frames-${index}` });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m && m.type === "frameReply") onMessage(index, m.json, m.bytes ? new Uint8Array(m.bytes) : null, undefined);
  };
  worker.onerror = (e) => {
    onMessage(index, undefined, undefined, String(e.message || "frame worker failed"));
    worker.terminate();
  };
  // Evora (E5): the page's storage settings, in the init message (never in the script's URL).
  worker.postMessage({ type: "init", module: self.effectcraftModule ?? null, base, frames: true, gpu: !!gpu, storageNs: STORAGE_NS, storageOff: STORAGE_OFF });
  frameWorkers.push(worker);
  return index;
}

// ------------------------------------------------------------------ disk cache (OPFS)

// The disk cache (src/diskcache.rs): one file per frame under
// effectcraft-cache/v1/frames/<32 hex>.ecc and one per layer buffer under
// effectcraft-cache/v1/layers/<32 hex>.ecc in the Origin Private File System (Evora E5: the folder
// carries the host's storage namespace; no folder with browser storage off; entry names with a
// `layers/` prefix are layer buffers). Frame workers write them with synchronous access handles
// (a temporary file moved into place, so a reader never sees a partial entry; every entry also
// ends in a checksum) and read the layer buffers they prefetch; the page lists, reads and
// deletes.
const cacheRoot = () => nsName("effectcraft-cache");
const CACHE_KINDS = ["frames", "layers"];
const cacheDirHandles = {};

async function cacheDir(kind = "frames") {
  storageGuard();
  if (cacheDirHandles[kind]) return cacheDirHandles[kind];
  if (!navigator.storage || !navigator.storage.getDirectory) throw new Error("no Origin Private File System");
  let d = await navigator.storage.getDirectory();
  for (const n of [cacheRoot(), "v1", kind]) d = await d.getDirectoryHandle(n, { create: true });
  cacheDirHandles[kind] = d;
  return d;
}

/// The folder and file name of an entry name (`layers/<hex>.ecc` or `<hex>.ecc`).
async function entryDir(name) {
  if (name.startsWith("layers/")) return [await cacheDir("layers"), name.slice(7)];
  return [await cacheDir("frames"), name];
}

/// Every cached entry: [{name, size, modified}] (layer buffers named `layers/…`). Temporaries
/// older than ten minutes (a writer that died) are removed.
export function cacheList() {
  return tracked(listCache());
}

async function listCache() {
  const out = [];
  for (const kind of CACHE_KINDS) {
    const dir = await cacheDir(kind);
    const prefix = kind === "frames" ? "" : `${kind}/`;
    const stale = [];
    for await (const [name, h] of dir.entries()) {
      if (h.kind !== "file") continue;
      const f = await h.getFile();
      if (name.includes(".tmp")) {
        if (Date.now() - f.lastModified > 600000) stale.push(name);
        continue;
      }
      out.push({ name: prefix + name, size: f.size, modified: f.lastModified });
    }
    for (const n of stale) { try { await dir.removeEntry(n); } catch {} }
  }
  return out;
}

/// An entry's bytes.
export function cacheRead(name) {
  return tracked(readCache(name));
}

async function readCache(name) {
  const [dir, file] = await entryDir(name);
  const f = await (await dir.getFileHandle(file)).getFile();
  return new Uint8Array(await f.arrayBuffer());
}

/// Write an entry (in a worker: a synchronous access handle; elsewhere a writable stream);
/// resolves with its size.
export async function cacheWrite(fullName, bytes) {
  const [dir, name] = await entryDir(fullName);
  const canMove = typeof FileSystemHandle !== "undefined" && "move" in FileSystemHandle.prototype;
  const tmp = canMove ? `${name}.tmp.${Math.random().toString(36).slice(2)}` : name;
  const fh = await dir.getFileHandle(tmp, { create: true });
  if (fh.createSyncAccessHandle) {
    const h = await fh.createSyncAccessHandle();
    try {
      h.truncate(0);
      h.write(bytes, { at: 0 });
      h.flush();
    } finally {
      h.close();
    }
  } else {
    const w = await fh.createWritable();
    await w.write(bytes);
    await w.close();
  }
  if (canMove) {
    try { await fh.move(dir, name); } catch (e) { try { await dir.removeEntry(tmp); } catch {} throw e; }
  }
  return bytes.length;
}

/// Delete entries (names); missing ones are ignored.
export function cacheDelete(names) {
  return tracked(deleteCache(names));
}

async function deleteCache(names) {
  for (const n of names) {
    try {
      const [dir, file] = await entryDir(n);
      await dir.removeEntry(file);
    } catch {}
  }
}

/// Delete the whole cache (with browser storage off there is none: the purge deletes it).
export function cacheClear() {
  return tracked(clearCache());
}

async function clearCache() {
  for (const k of CACHE_KINDS) delete cacheDirHandles[k];
  if (STORAGE_OFF) return;
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(cacheRoot(), { recursive: true });
  } catch (e) {
    if (e.name !== "NotFoundError") throw e;
  }
}

/// Whether this thread has WebGPU (`navigator.gpu`).
export function hasWebGpu() {
  return !!(self.navigator && self.navigator.gpu);
}

/// Post a message ({type: "frame", json} or {type: "file", path, bytes}) to frame worker `index`.
export function frameWorkerPost(index, msg, transfer) {
  // (a purge ended the frame workers: their slots are empty)
  const w = frameWorkers[index];
  if (w) w.postMessage(msg, transfer ?? []);
}

// ------------------------------------------------------------------ media browser

// Folders opened with the File System Access API (src/browse.rs): name → {handle, files: Map of
// "name/sub/file" → FileSystemFileHandle}. Their handles are remembered in IndexedDB so the
// folders come back on the next visit (once the browser grants access again). Evora (E5): the
// database carries the host's storage namespace; with browser storage off, nothing is remembered.
const folders = new Map();
const MAX_ENTRIES = 20000;

async function handlesDb() {
  storageGuard();
  const open = indexedDB.open(nsName("effectcraft-handles"), 1);
  open.onupgradeneeded = () => open.result.createObjectStore("folders", { keyPath: "name" });
  return keepDb(await req(open));
}

async function enumerate(dir, prefix, out, files, depth) {
  for await (const [name, h] of dir.entries()) {
    if (name.startsWith(".") || out.length >= MAX_ENTRIES) continue;
    const rel = `${prefix}/${name}`;
    if (h.kind === "directory") {
      out.push({ path: rel, dir: true, size: 0, modified: 0 });
      if (depth < 8) await enumerate(h, rel, out, files, depth + 1);
    } else {
      const f = await h.getFile();
      out.push({ path: rel, dir: false, size: f.size, modified: Math.floor(f.lastModified / 1000) });
      files.set(rel, h);
    }
  }
}

async function openFolder(handle, remember) {
  const name = handle.name;
  const entries = [];
  const files = new Map();
  await enumerate(handle, name, entries, files, 0);
  folders.set(name, { handle, files });
  if (remember) {
    try {
      const db = await handlesDb();
      await req(db.transaction("folders", "readwrite").objectStore("folders").put({ name, handle }));
    } catch (e) { console.info("media browser: cannot remember the folder", e); }
  }
  return { name, entries };
}

/// Whether the browser can open folders (File System Access API).
export function browseCanPickFolder() {
  return typeof self.showDirectoryPicker === "function";
}

/// Ask for a folder; resolves with {name, entries: [{path, dir, size, modified}]}.
export async function browsePickFolder() {
  const handle = await self.showDirectoryPicker({ id: "effectcraft-media", mode: "read" });
  return openFolder(handle, true);
}

/// Folders opened on earlier visits: [{name, granted, entries?}] (entries when access is granted).
export async function browseRestore() {
  if (!self.indexedDB || !browseCanPickFolder() || STORAGE_OFF) return [];
  let all = [];
  try {
    const db = await handlesDb();
    all = await req(db.transaction("folders", "readonly").objectStore("folders").getAll());
  } catch { return []; }
  const out = [];
  for (const { name, handle } of all) {
    let granted = false;
    try { granted = (await handle.queryPermission({ mode: "read" })) === "granted"; } catch {}
    if (granted) {
      try { out.push({ granted, ...(await openFolder(handle, false)) }); continue; } catch {}
    }
    out.push({ name, granted: false });
  }
  return out;
}

/// Ask for access to a remembered folder again (needs a user gesture); resolves like
/// browsePickFolder.
export async function browseReconnect(name) {
  const db = await handlesDb();
  const rec = await req(db.transaction("folders", "readonly").objectStore("folders").get(name));
  if (!rec) throw new Error(`${name} is not remembered`);
  if ((await rec.handle.requestPermission({ mode: "read" })) !== "granted") throw new Error(`access to ${name} was not granted`);
  return openFolder(rec.handle, false);
}

/// Forget a remembered folder.
export async function browseForget(name) {
  folders.delete(name);
  try {
    const db = await handlesDb();
    await req(db.transaction("folders", "readwrite").objectStore("folders").delete(name));
  } catch {}
}

/// A file of an opened folder ("/Folders/name/sub/file"): its bytes.
export async function browseRead(path) {
  const rel = path.replace(/^\/Folders\//, "");
  const folder = folders.get(rel.split("/")[0]);
  const h = folder && folder.files.get(rel);
  if (!h) throw new Error(`${path}: its folder is not open (reconnect it)`);
  return new Uint8Array(await (await h.getFile()).arrayBuffer());
}

/// The fallback where folders can't be opened: pick files (or a whole folder, `directory`) with a
/// plain file input; resolves with [{path, bytes}] (path relative to the picked folder). A file
/// that can't be read is listed as {path, error} instead (#226); cancelling resolves with [].
export function browsePickFiles(directory) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    if (directory) input.webkitdirectory = true;
    input.oncancel = () => resolve([]);
    input.onchange = async () => {
      const out = [];
      for (const f of input.files) {
        const path = (directory && f.webkitRelativePath) || f.name;
        try {
          out.push({ path, bytes: new Uint8Array(await f.arrayBuffer()) });
        } catch (e) {
          out.push({ path, error: String((e && (e.message || e.name)) || e) });
        }
      }
      resolve(out);
    };
    input.click();
  });
}

/// The page's WebGPU device was lost (#225): the canvas can't show anything new while the project
/// stays open and editable. Say so over the stale picture, and offer to save the project (a
/// download) and to reload; the reload first writes pending changes to browser storage, from
/// which the session comes back when it is `kept` there.
export function showDeviceLost(message, kept) {
  if (document.getElementById("device-lost")) return;
  const box = document.createElement("div");
  box.id = "device-lost";
  box.setAttribute("role", "alertdialog");
  const title = document.createElement("strong");
  title.textContent = "The graphics device was lost";
  const text = document.createElement("p");
  text.textContent =
    "EffectCraft can't update the display any more. Your project is still open. " +
    (kept ? "Reload to continue: the project and its unsaved changes come back." : "This session isn't kept in browser storage: save the project before you reload.");
  const detail = document.createElement("small");
  detail.textContent = message;
  const save = document.createElement("button");
  save.textContent = "Save Project";
  save.onclick = () =>
    self.effectcraft
      .execute("file.save", {})
      .catch(() => self.effectcraft.execute("file.saveAs", { path: "/Untitled Project.ecproj" }))
      .catch((e) => (text.textContent = `Saving failed: ${(e && e.message) || e}`));
  const reload = document.createElement("button");
  reload.textContent = "Reload";
  reload.onclick = async () => {
    reload.disabled = true;
    try {
      await self.effectcraft.flush();
    } catch (e) {
      text.textContent = `Writing to browser storage failed (${(e && e.message) || e}). Save the project, or reload anyway and lose the changes.`;
      reload.textContent = "Reload Anyway";
      reload.disabled = false;
      reload.onclick = () => location.reload();
      return;
    }
    location.reload();
  };
  const buttons = document.createElement("div");
  buttons.append(save, reload);
  box.append(title, text, detail, buttons);
  document.body.append(box);
}
