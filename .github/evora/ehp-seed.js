"use strict";
// Banc « pont-ehp » (écrit par Evora ; patch E5) : page d'amorçage servie par le banc sur l'origine
// du moteur, à la place du moteur, dans son cadre (jamais dans l'artefact). Elle sème ce qu'un
// navigateur partagé peut contenir avant le démarrage : les magasins du moteur sans espace de noms
// (amont), ceux d'un autre compte, ceux d'une ancienne build (« ci-a »), ceux du compte lui-même
// (`own`, gardés par evora:init, effacés par evora:purge), et des témoins étrangers au moteur
// (« evora-keep ») qui doivent survivre à toute purge. Elle dit ce qu'elle voit à la page parente,
// puis ouvre le moteur dans le même cadre.
(async () => {
  const q = new URLSearchParams(location.search);
  const PARENT = q.get("parent");
  const OWN = q.get("own") || "";
  const OTHER = "c".repeat(64);
  const report = (m) => parent.postMessage({ harness: "seed", ...m }, PARENT);
  // Cache folders also get an entry where the frame workers of v0.11.1 write segmentation mattes
  // (`v1/mattes/`, EVORA-KIN-31, NR-5): the init and purge checks then cover that kind too.
  const MATTE = ["v1", "mattes"];
  const hasMatte = async (dir) => {
    try {
      let d = dir;
      for (const n of MATTE) d = await d.getDirectoryHandle(n);
      await d.getFileHandle("seed");
      return true;
    } catch (_) {
      return false;
    }
  };
  const list = async () => {
    const out = { opfs: [], idb: [], ls: [], mattes: [] };
    const root = await navigator.storage.getDirectory();
    for await (const [name, handle] of root.entries()) {
      out.opfs.push(name);
      if (handle.kind === "directory" && (await hasMatte(handle))) out.mattes.push(name);
    }
    out.idb = (await indexedDB.databases()).map((d) => d.name);
    for (let i = 0; i < localStorage.length; i++) out.ls.push(localStorage.key(i));
    return out;
  };
  try {
    const root = await navigator.storage.getDirectory();
    const folders = ["effectcraft", "effectcraft-cache", `evns-${OTHER}--effectcraft`, `evns-${OTHER}--effectcraft-cache`, "evns-ci-a--effectcraft", "evora-keep"];
    if (OWN) folders.push(`evns-${OWN}--effectcraft-cache`);
    for (const name of folders) {
      const dir = await root.getDirectoryHandle(name, { create: true });
      const file = await dir.getFileHandle("seed", { create: true });
      const w = await file.createWritable();
      await w.write("seed");
      await w.close();
      if (name.endsWith("effectcraft-cache")) {
        let d = dir;
        for (const n of MATTE) d = await d.getDirectoryHandle(n, { create: true });
        const mw = await (await d.getFileHandle("seed", { create: true })).createWritable();
        await mw.write("seed");
        await mw.close();
      }
    }
    // The account's own IndexedDB database and localStorage key too: kept by evora:init, deleted by
    // evora:purge (the engine opens neither under Chrome before a folder is picked).
    const dbs = ["effectcraft-handles", `evns-${OTHER}--effectcraft-handles`, "evora-keep"];
    if (OWN) dbs.push(`evns-${OWN}--effectcraft-handles`);
    for (const name of dbs) {
      await new Promise((res, rej) => {
        const r = indexedDB.open(name, 1);
        r.onupgradeneeded = () => r.result.createObjectStore("seed");
        r.onsuccess = () => { r.result.close(); res(); };
        r.onerror = () => rej(r.error);
      });
    }
    const keys = [`evns-${OTHER}--effectcraft`, "effectcraft-seed", "evora-keep"];
    if (OWN) keys.push(`evns-${OWN}--effectcraft`);
    for (const key of keys) localStorage.setItem(key, "seed");
    report({ listing: await list() });
  } catch (e) {
    report({ error: String((e && e.message) || e) });
  }
  location.replace(`index.html?${q.get("q") || ""}`);
})();
