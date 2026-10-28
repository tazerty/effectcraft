//! Evora (E4, E5): the native bridge of the Evora host protocol, EHP v1
//! (`apps/creative/HOST-PROTOCOL.md` in Evora), in Rust (web-sys), on the model of the Colophon
//! Atelier's (pdfcraft, EVORA-COL-12).
//!
//! With `?host=evora` the engine talks only to its parent page, and only when that page's origin
//! is admitted by `evora-host.json`, the file Evora's provisioning writes next to `index.html`
//! (`{"parentOrigins": [...]}`, bare http(s) origins; HOST-PROTOCOL §2.3). The build ships it
//! empty: the bridge stays mute. Never a URL parameter, a message or the referrer alone:
//! `location.ancestorOrigins` names the parent when the browser gives it and must be admitted;
//! otherwise the referrer may only pick among the admitted origins, or the single one.
//!
//! Start (§7.1): `evora:ready` as soon as the bridge listens, before any browser storage is
//! touched; the engine then waits for `evora:init`. It brings the storage namespace (`storageNs`,
//! patch E5: the only way the engine learns it), the language, the theme and the host's settings;
//! the stores of other namespaces and the un-namespaced ones are deleted (§7.7 b) before the
//! engine opens its own. `evora:ack` once the editor runs, `evora:failed {code}` if it can't start.
//! Without an admitted parent, or without a namespace, the engine keeps nothing in browser storage.
//!
//! Every message is `{ v: 1, type, id, re?, payload }` (§3). An incoming message is examined only
//! if `event.source` is the parent window AND `event.origin` the admitted origin (§5.1), then in
//! the order of §5.2: a plain object, version 1, a known type, an effective capability, the exact
//! envelope, ULID `id` (and `re`: on answers only, correlated), the payload's schema, binary data
//! an `ArrayBuffer` (never a SharedArrayBuffer or a typed view) within `maxDocumentBytes`. Anything
//! else is ignored. Outgoing messages name the parent origin as `targetOrigin`, never `*`, with
//! fresh ULIDs.
//!
//! Handled: `evora:init`, `evora:open` (bytes, or a new document), `evora:request-save`,
//! `evora:saved` (correlated; after a Save As the engine adopts the new `docRef` once its session
//! edits the copy, not after Save a Copy; with `doc.saved-ack` the project is saved only at
//! `evora:saved {ok: true}`, [`output`]), `evora:lang`, `evora:theme`, `evora:purge`, and since
//! the V1 bridge (lot KIN-FK-B1) `evora:file` and `evora:ack` (answers to the engine's
//! `evora:pick`, `evora:need` and `evora:export`, [`media`], [`output`]), and since lot KIN-FK-B2
//! `evora:command` (a command of the catalog, [`commands`]) and `evora:font` (a font of the
//! member's, [`fonts`]). Sent: `evora:ready`,
//! `evora:ack`, `evora:dirty`, `evora:save` (Save, Save As and the answer to `evora:request-save`:
//! the working project goes to the host, never to a download, even before the host opened a
//! document), `evora:failed`, and since the V1 bridge `evora:export` (renders and exports, never a
//! download), `evora:pick` (Import, Replace Footage, Open: Evora's picker, never the local file
//! system), `evora:need` (a project's media the engine doesn't hold) and `evora:focus-out` (F6,
//! [`focus`]), and since lot KIN-FK-B2 `evora:commands` (the catalog of the commands Evora may
//! run, after the answer to `evora:init` and after every `evora:lang`, [`commands`]).
//!
//! Lot KIN-FK-B2 also gives Evora's editor its look and keys: the E2-KIN palette with the accent of
//! `evora:init` and `evora:theme` (`effectcraft_ui_egui::theme::set_host_accent`, [`look`]) and
//! the « Kinetika » keyboard shortcut profile, without single-key shortcuts ([`keys`]).
//!
//! `evora:purge` (§7.7 a) stops every writer first, for good (the store's flushes and session
//! snapshots, the disk cache, the frame and job workers), then deletes the engine's browser stores
//! (`js/host.js` `storagePurge`), lists them again, and only then answers.
//!
//! The requests that need the editor (`evora:open`, `evora:request-save`, `evora:lang`,
//! `evora:theme`) run on the UI thread at the next frame, or without one shortly after when no
//! frame comes (`crate::post`: the browser gives an iframe it doesn't paint no animation frame).
//! `evora:theme` is answered once the editor shows the theme (`ui.theme`), `unsupported` otherwise.

use std::cell::RefCell;
use std::rc::Rc;

use effectcraft_ui_egui::EffectcraftApp;
use serde_json::json;
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

use crate::persist::{storage_configure, storage_purge};

/// Evora (KIN-FK-B2): the catalog of the commands Evora may run (`command.catalog`, `command`).
mod commands;
/// Evora (KIN-FK-B1): the keyboard's way out of the engine (`ui.focus-out`).
mod focus;
/// Evora (KIN-FK-B2, E6): the member's fonts (`font.inject`), on the page and in the workers.
mod fonts;
/// Evora (KIN-FK-B2): the keyboard shortcut profile of Evora's editor.
mod keys;
/// Evora (KIN-FK-B2, E2-KIN): the palette the editor shows, reported for the CI bench.
mod look;
/// Evora (KIN-04, KIN-05): Evora's picker and the project's media (`pick.drive`, `media.need`).
mod media;
/// Evora (KIN-03, KIN-06): exports to Evora's Drive and the acknowledged save (`export.drive`,
/// `doc.saved-ack`).
mod output;

pub(crate) use fonts::{injected as injected_fonts, is_font_path, worker_font};
pub(crate) use look::report as report_theme;
pub(crate) use media::{dialog, pick_files, pick_open_project};
pub(crate) use output::export;

/// Build slug and protocol version announced in `evora:ready` (§4.4, §10).
const APP: &str = "kinetika";
const EHP: &str = "1.0";
/// What this engine honours (§9.1), each exercised by the CI's « pont-ehp » smoke test. Since the
/// V1 bridge (lot KIN-FK-B1): `doc.saved-ack`, `export.drive`, `pick.drive`, `media.need` and
/// `ui.focus-out` (A-19); since lot KIN-FK-B2: `command` and `command.catalog` (the catalog of
/// the commands Evora may run, [`commands`]) and `font.inject` (the member's fonts, [`fonts`]).
/// Not yet: `media.ranges`, `author`, `doc.multi`.
const CAPABILITIES: [&str; 16] = [
    "doc.open",
    "doc.save",
    "doc.saved-ack",
    "doc.dirty",
    "doc.request-save",
    "export.drive",
    "pick.drive",
    "media.need",
    "storage.ns",
    "storage.purge",
    "live.lang",
    "live.theme",
    "ui.focus-out",
    "command",
    "command.catalog",
    "font.inject",
];
/// Declared too when the host framed the engine in upstream's memory mode (`?storage=memory`):
/// nothing persists in browser storage.
const MEMORY_CAPABILITY: &str = "storage.memory";
/// The admitted parent origins, beside `index.html` (§2.3).
const CONFIG: &str = "evora-host.json";
const LANGS: [&str; 14] = ["ar", "de", "en", "es", "fr", "hi", "id", "it", "ja", "ko", "pt", "ru", "tr", "zh-Hans"];
/// The capabilities an `evora:init` may name: the host's ceiling (`host-schema.js` in Evora,
/// `CAPABILITIES`, campaign « suite créative V1 »).
const CAPABILITY_NAMES: [&str; 23] = [
    "doc.open",
    "doc.save",
    "doc.saved-ack",
    "doc.dirty",
    "doc.multi",
    "doc.request-save",
    "export.drive",
    "media.need",
    "media.ranges",
    "pick.drive",
    "command",
    "storage.ns",
    "storage.memory",
    "storage.purge",
    "live.lang",
    "live.theme",
    "font.inject",
    "author",
    "ui.focus-out",
    "ui.activity",
    "drop.files",
    "prefs.sync",
    "command.catalog",
];
const REASONS: [&str; 5] = ["autosave", "visibility", "close", "logout", "user"];
const ACK_CODES: [&str; 16] = [
    "clean",
    "cancelled",
    "conflict",
    "too_large",
    "quota",
    "forbidden",
    "not_found",
    "invalid_content",
    "unsupported",
    "rate_limited",
    "read_only",
    "busy",
    "capability",
    "network",
    "server",
    "timeout",
];
/// The host setting this engine applies from `evora:init.prefs` (engines.json's list).
const PREF_DISK_CACHE: &str = "disk.diskCacheEnabled";
/// `displayName` of §4.3 (users.display_name).
const DISPLAY_NAME_MAX: usize = 100;
/// `name` of §4.2 (drive_files.name).
const NAME_MAX: usize = 255;
/// Message ids remembered against replays (§3).
const SEEN_MAX: usize = 512;
/// Saves awaiting their `evora:saved`.
const PENDING_SAVES_MAX: usize = 64;
const PROJECT_EXT: &str = ".ecproj";
const DEFAULT_NAME: &str = "Untitled Project.ecproj";

/// What `evora:init` sets before the engine opens browser storage.
#[derive(Clone, Debug)]
pub struct Boot {
    /// The storage namespace (`storage.ns` effective); without one the engine keeps nothing.
    pub storage_ns: Option<String>,
    /// Delete the other namespaces' stores and the un-namespaced ones first (`storage.purge`).
    pub purge: bool,
    /// The engine's catalog code (`None`: English; the host shows its banner).
    pub lang: Option<&'static str>,
    pub dark: bool,
    /// Evora (KIN-FK-B2, E2-KIN): the accent of `evora:init` (`#RRGGBB`).
    pub accent: egui::Color32,
    /// `disk.diskCacheEnabled` as the host imposes it, if it does.
    pub disk_cache: Option<bool>,
}

/// The document the host opened: its file in the table, its reference and name in Evora.
struct HostDoc {
    path: String,
    doc_ref: String,
    name: String,
}

/// An `evora:save` awaiting its `evora:saved`.
struct PendingSave {
    id: String,
    path: String,
    name: String,
    save_as: bool,
    /// With `doc.saved-ack`: the saved state the save command set, held until the host's answer
    /// ([`output::hold`]); `None` until the frame after the save.
    held: Option<output::Held>,
}

struct State {
    parent: web_sys::Window,
    origin: String,
    /// What `evora:ready` announced.
    declared: Vec<&'static str>,
    ready_id: String,
    /// The accepted `evora:init` (answered once the editor runs).
    init_id: Option<String>,
    init_waiter: Option<js_sys::Function>,
    boot: Option<Boot>,
    /// The effective capabilities: what the host offers and this engine declares (§9).
    caps: Vec<String>,
    max_document: f64,
    current: Option<HostDoc>,
    /// Table paths saved as copies (Save As) whose new `docRef` hasn't come yet.
    copies: Vec<String>,
    pending_saves: Vec<PendingSave>,
    /// The `evora:request-save` the next `evora:save` answers.
    reply_to: Option<String>,
    /// Why the last document write was refused (an `evora:ack` code).
    refusal: Option<&'static str>,
    last_dirty: Option<bool>,
    purging: bool,
    seen: Vec<String>,
    /// `limits.maxExportBytes` of `evora:init`.
    max_export: f64,
    /// `evora:pick` and `evora:need` awaiting their closing `evora:ack` ([`media`]).
    picks: Vec<media::Pick>,
    needs: Vec<media::Need>,
    /// `evora:export` awaiting the host's `evora:ack` ([`output`]).
    exports: Vec<String>,
    /// Paths a save dialog named for a file that isn't a project (an export the user asked for):
    /// written, they go to Evora's Drive ([`write`]).
    export_paths: Vec<String>,
    /// The missing footage the Project panel has selected (Replace Footage relinks it, `relink`).
    relink_for: Option<String>,
}

impl State {
    fn has(&self, capability: &str) -> bool {
        self.init_id.is_some() && self.caps.iter().any(|c| c == capability)
    }
}

thread_local! {
    static BRIDGE: RefCell<Option<Rc<RefCell<State>>>> = const { RefCell::new(None) };
}

#[cfg(feature = "evora-witness")]
thread_local! {
    /// The bench's witness build: the next `evora:dirty {dirty: false}` after a save is dropped.
    static WITNESS_SKIP_CLEAN: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// The bench's witness build (feature `evora-witness`, never in the artefact): a save was sent.
#[cfg(feature = "evora-witness")]
fn witness_saved() {
    WITNESS_SKIP_CLEAN.with(|w| w.set(true));
}
#[cfg(not(feature = "evora-witness"))]
fn witness_saved() {}

/// The bench's witness build: drop this `evora:dirty` (the first clean one after a save).
#[cfg(feature = "evora-witness")]
fn witness_drops(now: bool) -> bool {
    !now && WITNESS_SKIP_CLEAN.with(|w| w.replace(false))
}
#[cfg(not(feature = "evora-witness"))]
fn witness_drops(_now: bool) -> bool {
    false
}

fn bridge() -> Option<Rc<RefCell<State>>> {
    BRIDGE.with(|b| b.borrow().clone())
}

/// The host bridge listens (an admitted parent page): posted actions may run between frames.
pub fn hosted() -> bool {
    BRIDGE.with(|b| b.borrow().is_some())
}

/// Read `evora-host.json`, find the admitted parent, listen, announce `evora:ready` and wait for
/// a valid `evora:init` (§4.5: without limit). `None`: no admitted parent, the bridge is mute.
/// `memory`: the host framed the engine in the memory mode (`?storage=memory`).
pub async fn boot(memory: bool) -> Option<Boot> {
    let Some((window, parent, origin)) = admitted_parent().await else {
        log::info!("Evora host bridge: no admitted parent page (evora-host.json); the engine keeps nothing in browser storage");
        return None;
    };
    let mut declared = CAPABILITIES.to_vec();
    if memory {
        declared.push(MEMORY_CAPABILITY);
    }
    let state = Rc::new(RefCell::new(State {
        parent,
        origin,
        declared: declared.clone(),
        ready_id: String::new(),
        init_id: None,
        init_waiter: None,
        boot: None,
        caps: Vec::new(),
        max_document: 0.0,
        current: None,
        copies: Vec::new(),
        pending_saves: Vec::new(),
        reply_to: None,
        refusal: None,
        last_dirty: None,
        purging: false,
        seen: Vec::new(),
        max_export: 0.0,
        picks: Vec::new(),
        needs: Vec::new(),
        exports: Vec::new(),
        export_paths: Vec::new(),
        relink_for: None,
    }));
    let listener = state.clone();
    let on_message = Closure::<dyn FnMut(web_sys::MessageEvent)>::new(move |event: web_sys::MessageEvent| {
        receive(&listener, &event);
    });
    if window.add_event_listener_with_callback("message", on_message.as_ref().unchecked_ref()).is_err() {
        return None;
    }
    // The listener lives as long as the page.
    on_message.forget();
    let mut waiter = None;
    let init = js_sys::Promise::new(&mut |resolve, _reject| waiter = Some(resolve));
    state.borrow_mut().init_waiter = waiter;
    BRIDGE.with(|b| *b.borrow_mut() = Some(state.clone()));
    focus::listen();
    let capabilities = js_sys::Array::new();
    for c in declared {
        capabilities.push(&JsValue::from_str(c));
    }
    let payload = object(&[
        ("app", APP.into()),
        ("version", env!("CARGO_PKG_VERSION").into()),
        ("ehp", EHP.into()),
        ("capabilities", capabilities.into()),
    ])?;
    let id = send(&state.borrow(), "evora:ready", None, &payload, None)?;
    state.borrow_mut().ready_id = id;
    let _ = JsFuture::from(init).await;
    let boot = state.borrow().boot.clone();
    boot
}

/// E5: name the engine's browser stores after the namespace of `evora:init` (or keep nothing:
/// `persistent` false, the memory mode, or no namespace), then, with `purge`, delete the stores of
/// the other namespaces and the un-namespaced ones (§7.7 b), before anything is opened.
pub async fn prepare_storage(ns: String, persistent: bool, purge: bool) {
    let off = !persistent || ns.is_empty();
    storage_configure(&ns, off);
    if !purge {
        return;
    }
    match JsFuture::from(storage_purge("others", false)).await {
        Ok(r) => {
            let left = remaining(&r);
            if left > 0 {
                log::warn!("Evora host bridge: {left} store(s) of other accounts couldn't be deleted (held by another tab?)");
            }
        }
        Err(e) => log::warn!("Evora host bridge: deleting the other accounts' stores failed: {e:?}"),
    }
    // Evora (KIN-02): the disk cache is off in the bridge, whatever the setting: this account's
    // cache folder goes too (every kind: frames, layers, mattes), before any worker could write.
    match JsFuture::from(storage_purge("cache", false)).await {
        Ok(r) => {
            let left = remaining(&r);
            if left > 0 {
                log::warn!("Evora host bridge: {left} disk cache folder(s) couldn't be deleted");
            }
        }
        Err(e) => log::warn!("Evora host bridge: deleting the disk cache failed: {e:?}"),
    }
}

/// What `evora:init` imposes on the session before the first frame (not saved).
pub fn apply_init(session: &mut effectcraft_engine::Session, boot: &Boot) {
    session.prefs.general.language = boot.lang.unwrap_or("en").to_string();
    session.prefs.appearance.appearance_mode = if boot.dark { "dark" } else { "light" }.to_string();
    // Evora (KIN-FK-B2, E2-KIN): Evora's palette, with the accent of `evora:init`.
    effectcraft_ui_egui::theme::set_host_accent(boot.accent);
    if let Some(on) = boot.disk_cache {
        session.prefs.disk.disk_cache_enabled = on;
    }
}

/// The editor runs: accept `evora:init` (`evora:ack {ok: true}`).
pub fn init_applied() {
    let Some(state) = bridge() else { return };
    let st = state.borrow();
    if let Some(id) = st.init_id.as_deref() {
        ack(&st, id, true, None);
    }
    drop(st);
    // Evora (KIN-FK-B2): the catalog of the commands Evora may run, after the answer.
    crate::post(|app| announce(app));
}

/// Evora (KIN-FK-B2): `evora:commands` (`command.catalog` effective), the catalog in the engine's
/// language, without `re` and without answer.
fn announce(app: &EffectcraftApp) {
    let Some(state) = bridge() else { return };
    if !state.borrow().has("command.catalog") {
        return;
    }
    let lang = app.session.prefs.general.language.clone();
    let lang = if is_lang_tag(&lang) { lang } else { "en".to_string() };
    let catalog = commands::payload(app, &lang);
    let Ok(payload) = js_sys::JSON::parse(&catalog.to_string()) else { return };
    let Ok(st) = state.try_borrow() else { return };
    let _ = send(&st, "evora:commands", None, payload.unchecked_ref::<js_sys::Object>(), None);
}

/// The editor couldn't start: `evora:failed {code}` (§4.4; the host words the message).
pub fn failed(error: &JsValue) {
    let text = error.as_string().unwrap_or_else(|| format!("{error:?}"));
    let code = if text.contains("WebGL") || text.contains("WebGPU") || text.contains("adapter") { "no_webgl2" } else { "init" };
    let Some(state) = bridge() else { return };
    let st = state.borrow();
    if let Some(payload) = object(&[("code", code.into())]) {
        let _ = send(&st, "evora:failed", None, &payload, None);
    }
}

/// `evora:dirty` when the host's document becomes modified or saved (called every frame). With
/// `doc.saved-ack`, a save the host hasn't acknowledged doesn't count as saved ([`output::hold`]).
pub fn dirty(session: &mut effectcraft_engine::Session) {
    output::hold(session);
    media::track_selection(session);
    // Evora (KIN-FK-B2, correction 1): the member's keyboard shortcuts written out as they left
    // them, upstream's keys kept out (nothing when the presets didn't change).
    keys::keep(session);
    let now = session.is_dirty();
    let Some(state) = bridge() else { return };
    let Ok(mut st) = state.try_borrow_mut() else { return };
    if !st.has("doc.dirty") || st.last_dirty == Some(now) {
        return;
    }
    let Some(doc_ref) = st.current.as_ref().map(|d| d.doc_ref.clone()) else { return };
    st.last_dirty = Some(now);
    if witness_drops(now) {
        return;
    }
    if let Some(payload) = object(&[("dirty", now.into()), ("docRef", doc_ref.into())]) {
        let _ = send(&st, "evora:dirty", None, &payload, None);
    }
}

/// Save-dialog paths remembered for an export, at most (older ones are forgotten).
const EXPORT_PATHS_MAX: usize = 32;

/// Evora (KIN-01): the menu commands hidden in the bridge, because they can't work in Evora's
/// editor: another project than the host's document (new, demo, template, recent projects,
/// closing it), the local file system (reveal, watch or relink a folder, collect files, install
/// scripts or effect plug-ins, KIN-08) and external pages (E7 drops them).
const HIDDEN_COMMANDS: &[&str] = &[
    "file.newProject",
    "file.openDemoProject",
    "file.newFromTemplate",
    "file.closeProject",
    "file.openRecent",
    "file.clearRecent",
    "dynamic:recentProjects",
    "file.revealInFinder",
    "layer.revealInFinder",
    "file.watchFolder",
    "file.relinkFootage",
    "file.collectFiles",
    "file.installScript",
    "file.installScriptUIPanel",
    "effect.plugins.load",
    "help.appPage",
    "help.docs",
    "help.github",
    "help.onlineTutorials",
    "help.reportIssue",
    "help.revealLogFile",
    "help.sibling",
    "app.quit",
];

/// Evora (KIN-01, KIN-04): the editor in the bridge: Evora's picker in place of the browser's file
/// pickers and the File System Access API, no folder dialog, and the menu entries that can't work
/// in Evora hidden (`HIDDEN_COMMANDS`). Called once the app exists, with an admitted parent.
pub fn install_host_hooks(app: &mut EffectcraftApp) {
    app.hooks.pick_files = Some(Box::new(|exts: &[&str]| pick_files(exts)));
    app.hooks.pick_open_project = Some(Box::new(pick_open_project));
    app.hooks.pick_folder = None;
    app.hooks.file_dialog_async = Some(Box::new(dialog));
    effectcraft_ui_egui::menus::hide_commands(HIDDEN_COMMANDS);
    // Evora (KIN-FK-B2): the « Kinetika » keyboard shortcut profile, installed on the first start;
    // afterwards the member's presets are kept as they leave them (`keys::keep`).
    keys::install(&mut app.session);
}

/// A save dialog named `path` for a file that isn't a project (`media::dialog`): written, it goes
/// to Evora's Drive ([`write`]).
fn remember_export(path: &str) {
    let Some(state) = bridge() else { return };
    let Ok(mut st) = state.try_borrow_mut() else { return };
    if st.export_paths.iter().any(|p| p == path) {
        return;
    }
    if st.export_paths.len() >= EXPORT_PATHS_MAX {
        st.export_paths.remove(0);
    }
    st.export_paths.push(path.to_string());
}

/// What became of a file the engine writes (`Services::write_file`).
pub enum HostWrite {
    /// Not the bridge's: upstream's behaviour (a download).
    NotHost,
    /// Sent to the host as `evora:save`.
    Sent,
    /// Neither sent nor downloaded.
    Refused(String),
    /// Evora (KIN-03): an export the user named: a render output, sent as `evora:export` at the
    /// end of the frame (`files::flush_downloads`).
    Output,
    /// Evora (KIN-03): a file the engine keeps for itself: in the table only.
    Kept,
}

/// The engine writes `path`: with `doc.save`, a project file goes to the host as `evora:save`
/// (the host's document: Save; another path: Save As, a copy of it), never to a download.
pub fn write(path: &str, data: &[u8]) -> HostWrite {
    let Some(state) = bridge() else { return HostWrite::NotHost };
    let Ok(mut st) = state.try_borrow_mut() else {
        return HostWrite::Refused("Evora is busy: try again".into());
    };
    // Evora (KIN-03): in the bridge nothing goes to a download. A file a save dialog named (an
    // export the user asked for: Lottie, a frame, a copy as XML…) goes to Evora's Drive
    // (`evora:export`, at the end of the frame, with the frame's other outputs); any other file
    // the engine writes for itself stays in the table.
    if !path.to_ascii_lowercase().ends_with(PROJECT_EXT) {
        if let Some(k) = st.export_paths.iter().position(|p| p == path) {
            st.export_paths.remove(k);
            return HostWrite::Output;
        }
        return HostWrite::Kept;
    }
    if !st.has("doc.save") {
        st.refusal = Some("capability");
        return HostWrite::Refused("this editor can't save to Evora".into());
    }
    // In the bridge a project never goes to a download, even before the host opened a document.
    let Some((doc_path, doc_ref, doc_name)) = st.current.as_ref().map(|d| (d.path.clone(), d.doc_ref.clone(), d.name.clone())) else {
        st.refusal = Some("not_found");
        return HostWrite::Refused("no Evora document is open in this editor: nothing was saved".into());
    };
    let save_as = doc_path != path;
    if save_as && st.copies.iter().any(|c| c == path) {
        st.refusal = Some("busy");
        return HostWrite::Refused("this copy isn't saved in Evora yet: try again in a moment".into());
    }
    if data.is_empty() || data.len() as f64 > st.max_document {
        st.refusal = Some("too_large");
        return HostWrite::Refused("the project is too large to save in Evora".into());
    }
    let name = if save_as { clean_name(path.rsplit('/').next().unwrap_or("")) } else { doc_name };
    let re = if save_as { None } else { st.reply_to.take() };
    let buffer = js_sys::Uint8Array::from(data).buffer();
    let payload = object(&[
        ("docRef", doc_ref.into()),
        ("name", name.clone().into()),
        ("saveAs", save_as.into()),
        ("bytes", buffer.clone().into()),
    ]);
    let id = payload.and_then(|payload| send(&st, "evora:save", re.as_deref(), &payload, Some(&buffer)));
    let Some(id) = id else {
        st.reply_to = re;
        st.refusal = Some("busy");
        return HostWrite::Refused("the project couldn't be handed to Evora".into());
    };
    if st.pending_saves.len() >= PENDING_SAVES_MAX {
        st.pending_saves.remove(0);
    }
    st.pending_saves.push(PendingSave { id, path: path.to_string(), name, save_as, held: None });
    if save_as {
        st.copies.push(path.to_string());
    }
    witness_saved();
    HostWrite::Sent
}

/// The parent window and its origin, when the page is framed by an origin `evora-host.json`
/// admits. The browser's own record of the parent (`location.ancestorOrigins`) decides when it
/// exists; otherwise the referrer may only pick among the admitted origins, or the single one.
async fn admitted_parent() -> Option<(web_sys::Window, web_sys::Window, String)> {
    let window = web_sys::window()?;
    let parent = window.parent().ok().flatten()?;
    if js_sys::Object::is(&parent, &window) {
        return None;
    }
    let admitted = read_config(&window).await?;
    // `location.ancestorOrigins` (a DOMStringList; absent from web-sys and from some browsers).
    let location: JsValue = window.location().into();
    let ancestors = get(&location, "ancestorOrigins");
    let first_ancestor = (get(&ancestors, "length").as_f64().unwrap_or(0.0) >= 1.0)
        .then(|| js_sys::Reflect::get_u32(&ancestors, 0).ok().and_then(|o| o.as_string()))
        .flatten();
    let origin = match first_ancestor {
        Some(parent_origin) => Some(parent_origin).filter(|o| admitted.contains(o))?,
        None => {
            let referrer = window.document().map(|d| d.referrer()).unwrap_or_default();
            let from_referrer = web_sys::Url::new(&referrer).ok().map(|u| u.origin()).filter(|o| admitted.contains(o));
            match (from_referrer, admitted.as_slice()) {
                (Some(o), _) => o,
                (None, [only]) => only.clone(),
                _ => return None,
            }
        }
    };
    Some((window, parent, origin))
}

/// `evora-host.json`: `{ "parentOrigins": ["https://…", …] }`, each a bare web origin (the same
/// contract as the Colophon Atelier's; Evora's provisioning writes it for every engine). Read
/// past any cache: the provisioning rewrites it in place.
async fn read_config(window: &web_sys::Window) -> Option<Vec<String>> {
    let init = web_sys::RequestInit::new();
    init.set_cache(web_sys::RequestCache::NoStore);
    let response = JsFuture::from(window.fetch_with_str_and_init(CONFIG, &init)).await.ok()?;
    let response: web_sys::Response = response.dyn_into().ok()?;
    if !response.ok() {
        return None;
    }
    let text = JsFuture::from(response.text().ok()?).await.ok()?.as_string()?;
    let config = js_sys::JSON::parse(&text).ok()?;
    let list = get(&config, "parentOrigins");
    if !js_sys::Array::is_array(&list) {
        return None;
    }
    let origins: Vec<String> = js_sys::Array::from(&list).iter().filter_map(|o| o.as_string()).filter(|o| is_origin(o)).collect();
    (!origins.is_empty()).then_some(origins)
}

/// `http(s)://host[:port]`, nothing after.
fn is_origin(o: &str) -> bool {
    let rest = o.strip_prefix("https://").or_else(|| o.strip_prefix("http://"));
    rest.is_some_and(|r| !r.is_empty() && !r.contains(['/', '?', '#', '@', ' ', '\\']))
}

fn receive(state: &Rc<RefCell<State>>, event: &web_sys::MessageEvent) {
    // §5.1: source AND origin (the bench's witness build skips the source check).
    {
        let Ok(st) = state.try_borrow() else { return };
        let from_parent = cfg!(feature = "evora-witness") || event.source().is_some_and(|s| js_sys::Object::is(&s, &st.parent));
        if event.origin() != st.origin || !from_parent {
            return;
        }
    }
    // §5.2: a plain object, version 1, a known type, an effective capability, the envelope.
    let data = event.data();
    if !plain_object(&data) || get(&data, "v").as_f64() != Some(1.0) {
        return;
    }
    let Some(kind) = get(&data, "type").as_string() else { return };
    // (capability, answer): an answer carries `re`, a request doesn't.
    let (capability, answer) = match kind.as_str() {
        "evora:init" => (None, true),
        "evora:saved" => (Some("doc.save"), true),
        "evora:open" => (Some("doc.open"), false),
        "evora:request-save" => (Some("doc.request-save"), false),
        "evora:lang" => (Some("live.lang"), false),
        "evora:theme" => (Some("live.theme"), false),
        "evora:purge" => (Some("storage.purge"), false),
        // Evora (KIN-FK-B2): a command of the catalog, a font of the member's.
        "evora:command" => (Some("command"), false),
        "evora:font" => (Some("font.inject"), false),
        // Answers to the engine's `evora:pick`, `evora:need` and `evora:export` (their capability is
        // checked against the request they answer, [`media`], [`output`]).
        "evora:file" => (None, true),
        "evora:ack" => (None, true),
        // Unknown here, or a capability this engine doesn't declare: ignored (§4.1, §10).
        _ => return,
    };
    if let Some(c) = capability
        && !state.borrow().has(c)
    {
        return;
    }
    if !only_keys(&data, &["v", "type", "id", "re", "payload"]) {
        return;
    }
    let Some(id) = get(&data, "id").as_string().filter(|i| is_ulid(i)) else { return };
    let re = get(&data, "re");
    let re = if re.is_undefined() {
        None
    } else {
        match re.as_string().filter(|r| is_ulid(r)) {
            Some(r) => Some(r),
            None => return,
        }
    };
    if re.is_some() != answer {
        return;
    }
    let payload = get(&data, "payload");
    if !plain_object(&payload) {
        return;
    }
    {
        // §3: an id already seen is a replay.
        let mut st = state.borrow_mut();
        if st.seen.iter().any(|s| s == &id) {
            return;
        }
        if st.seen.len() >= SEEN_MAX {
            st.seen.remove(0);
        }
        st.seen.push(id.clone());
    }
    match kind.as_str() {
        "evora:init" => on_init(state, &id, re.as_deref(), &payload),
        "evora:saved" => on_saved(state, re.as_deref(), &payload),
        "evora:open" => on_open(state, &id, &payload),
        "evora:request-save" => on_request_save(&id, &payload),
        "evora:lang" => on_lang(&id, &payload),
        "evora:theme" => on_theme(&id, &payload),
        "evora:purge" => on_purge(state, &id, &payload),
        "evora:command" => on_command(state, &id, &payload),
        "evora:font" => fonts::on_font(state, &id, &payload),
        "evora:file" => media::on_file(state, re.as_deref(), &payload),
        "evora:ack" => on_ack(state, re.as_deref(), &payload),
        _ => {}
    }
}

/// `evora:ack` from the host (§4.5): the end of an `evora:pick` or an `evora:need`, or the
/// answer to an `evora:export`. Any other `re` is ignored.
fn on_ack(state: &Rc<RefCell<State>>, re: Option<&str>, p: &JsValue) {
    let Some(re) = re else { return };
    if !only_keys(p, &["ok", "code", "result"]) {
        return;
    }
    let Some(ok) = get(p, "ok").as_bool() else { return };
    let code = get(p, "code");
    let code = if code.is_undefined() {
        None
    } else {
        match code.as_string().filter(|c| ACK_CODES.contains(&c.as_str())) {
            Some(c) => Some(c),
            None => return,
        }
    };
    if !ok && code.is_none() {
        return;
    }
    if media::on_ack(state, re, ok) {
        return;
    }
    output::on_ack(state, re, ok, code);
}

fn on_init(state: &Rc<RefCell<State>>, id: &str, re: Option<&str>, p: &JsValue) {
    let mut st = state.borrow_mut();
    if st.init_id.is_some() || re != Some(st.ready_id.as_str()) {
        return;
    }
    let required = ["lang", "engineLang", "theme", "accent", "readOnly", "storageNs", "capabilities", "prefs", "limits"];
    let mut allowed = required.to_vec();
    allowed.push("displayName");
    if !only_keys(p, &allowed) || !required.iter().all(|k| !get(p, k).is_undefined()) {
        return;
    }
    let lang_ok = get(p, "lang").as_string().is_some_and(|l| LANGS.contains(&l.as_str()));
    let engine_lang = engine_lang(&get(p, "engineLang"));
    let dark = match get(p, "theme").as_string().as_deref() {
        Some("dark") => true,
        Some("light") => false,
        _ => return,
    };
    let accent = get(p, "accent").as_string().and_then(|a| parse_accent(&a));
    let accent_ok = accent.is_some();
    let read_only_ok = get(p, "readOnly").as_bool().is_some();
    let ns = get(p, "storageNs").as_string().filter(|ns| is_storage_ns(ns));
    let display_name = get(p, "displayName");
    let display_name_ok = display_name.is_undefined() || display_name.as_string().is_some_and(|a| (1..=DISPLAY_NAME_MAX).contains(&a.chars().count()));
    let caps = string_list(&get(p, "capabilities"));
    let caps_ok = caps.as_ref().is_some_and(|c| c.iter().all(|x| CAPABILITY_NAMES.contains(&x.as_str())));
    let prefs = get(p, "prefs");
    let prefs_ok = plain_object(&prefs)
        && js_sys::Object::keys(prefs.unchecked_ref::<js_sys::Object>()).iter().all(|k| {
            let v = js_sys::Reflect::get(&prefs, &k).unwrap_or(JsValue::UNDEFINED);
            v.as_string().is_some() || v.as_bool().is_some() || v.as_f64().is_some_and(f64::is_finite)
        });
    let limits = get(p, "limits");
    let max_document = get(&limits, "maxDocumentBytes").as_f64();
    let max_export = get(&limits, "maxExportBytes").as_f64();
    let limits_ok = plain_object(&limits)
        && only_keys(&limits, &["maxDocumentBytes", "maxExportBytes"])
        && [max_document, max_export].iter().all(|m| m.is_some_and(|m| m >= 1.0 && m.fract() == 0.0));
    let (Some(engine_lang), Some(ns), Some(caps), Some(max_document), Some(accent)) = (engine_lang, ns, caps, max_document, accent) else {
        return;
    };
    if !(lang_ok && accent_ok && read_only_ok && display_name_ok && caps_ok && prefs_ok && limits_ok) {
        return;
    }
    // The effective set: what the host offers and this engine declares (§9).
    let declared = st.declared.clone();
    st.caps = caps.into_iter().filter(|c| declared.contains(&c.as_str())).collect();
    st.max_document = max_document;
    st.max_export = max_export.unwrap_or(0.0);
    st.init_id = Some(id.to_string());
    let storage_ns = st.has("storage.ns").then_some(ns);
    let purge = st.has("storage.purge");
    let lang = engine_lang.as_deref().and_then(crate::evora_language);
    let disk_cache = get(&prefs, PREF_DISK_CACHE).as_bool();
    st.boot = Some(Boot { storage_ns, purge, lang, dark, accent, disk_cache });
    if let Some(resolve) = st.init_waiter.take() {
        let _ = resolve.call0(&JsValue::NULL);
    }
}

fn on_open(state: &Rc<RefCell<State>>, id: &str, p: &JsValue) {
    let st = state.borrow();
    if !only_keys(p, &["docRef", "name", "bytes", "url", "new"]) {
        return;
    }
    let Some(doc_ref) = get(p, "docRef").as_string().filter(|r| is_ulid(r)) else { return };
    let Some(name) = get(p, "name").as_string().filter(|n| is_name(n)) else { return };
    let given = ["bytes", "url", "new"].iter().filter(|k| !get(p, k).is_undefined()).count();
    if given != 1 {
        return;
    }
    if !get(p, "url").is_undefined() {
        // `url` needs `media.ranges`, which this engine doesn't declare.
        ack(&st, id, false, Some("capability"));
        return;
    }
    let bytes = if get(p, "new").is_undefined() {
        let bytes = get(p, "bytes");
        // An ArrayBuffer (never a SharedArrayBuffer or a typed view), 1 byte up to the limit.
        if !bytes.is_instance_of::<js_sys::ArrayBuffer>() {
            return;
        }
        let length = f64::from(bytes.unchecked_ref::<js_sys::ArrayBuffer>().byte_length());
        if length < 1.0 {
            return;
        }
        if length > st.max_document {
            ack(&st, id, false, Some("too_large"));
            return;
        }
        Some(js_sys::Uint8Array::new(&bytes).to_vec())
    } else {
        if get(p, "new").as_bool() != Some(true) {
            return;
        }
        None
    };
    drop(st);
    let id = id.to_string();
    crate::post(move |app| open_document(app, id, doc_ref, name, bytes));
}

/// `evora:open` on the UI thread: the project replaces the open one (a new one with `None`).
fn open_document(app: &mut EffectcraftApp, id: String, doc_ref: String, name: String, bytes: Option<Vec<u8>>) {
    let path = table_path(&name);
    let opened = match bytes {
        Some(data) => {
            crate::files::put(&path, data.into());
            app.session.execute("file.open", json!({"path": path})).map(|_| ())
        }
        None => match app.session.execute("file.newProject", json!({})) {
            Ok(_) => {
                // A new document is saved under its name in Evora.
                app.session.path = Some(path.clone());
                app.session.mark_saved();
                Ok(())
            }
            Err(e) => Err(e),
        },
    };
    if opened.is_ok() {
        // Evora (KIN-05): the footage paths a project file stores are followed as given in the
        // bridge. Upstream follows them through `craft_docpath::resolve_absolute`, whose result is
        // never absolute on wasm32-unknown-unknown (`Path::is_absolute` needs a Unix or Windows
        // target): every stored path would stay refused, and missing for good, even once Evora sends
        // its file (`evora:need`). Here a path only names an entry of the engine's file table, which
        // Evora fills (`evora:file`); no network share, device nor local file is ever reached.
        app.session.stored_paths = Default::default();
    }
    let Some(state) = bridge() else { return };
    let mut st = state.borrow_mut();
    match opened {
        Ok(()) => {
            st.current = Some(HostDoc { path, doc_ref, name });
            st.copies.clear();
            st.reply_to = None;
            // A save of the previous document no longer decides this one's saved state.
            st.pending_saves.clear();
            // The next frame tells the host whether it is modified (`evora:dirty`, §7.1 step 8).
            st.last_dirty = None;
            ack(&st, &id, true, None);
        }
        Err(e) => {
            app.ui.status = format!("This document couldn't be opened: {e}");
            ack(&st, &id, false, Some("invalid_content"));
            return;
        }
    }
    drop(st);
    // Evora (KIN-05): the media the project refers to and the engine doesn't hold come from Evora
    // (`evora:need`), then the footage is checked again.
    media::request_missing(app);
}

fn on_request_save(id: &str, p: &JsValue) {
    if !only_keys(p, &["reason", "docRef"]) || !get(p, "reason").as_string().is_some_and(|r| REASONS.contains(&r.as_str())) {
        return;
    }
    let doc_ref = get(p, "docRef");
    let doc_ref = if doc_ref.is_undefined() {
        None
    } else {
        match doc_ref.as_string().filter(|r| is_ulid(r)) {
            Some(r) => Some(r),
            None => return,
        }
    };
    let id = id.to_string();
    crate::post(move |app| request_save(app, id, doc_ref));
}

/// `evora:request-save` on the UI thread: `evora:save` answering it (`re`), or
/// `evora:ack {code: "clean"}` when there is nothing to save.
fn request_save(app: &mut EffectcraftApp, id: String, doc_ref: Option<String>) {
    let Some(state) = bridge() else { return };
    let path = {
        let mut st = state.borrow_mut();
        let current = st.current.as_ref().filter(|d| doc_ref.as_ref().is_none_or(|r| r == &d.doc_ref)).map(|d| d.path.clone());
        let Some(path) = current else {
            ack(&st, &id, false, Some("not_found"));
            return;
        };
        // The answer is an `evora:save`: without `doc.save` the engine can't give one.
        if !st.has("doc.save") {
            ack(&st, &id, false, Some("capability"));
            return;
        }
        if !app.session.is_dirty() {
            ack(&st, &id, true, Some("clean"));
            return;
        }
        st.reply_to = Some(id.clone());
        st.refusal = None;
        path
    };
    // `file.save` writes the project through `write` (above), which sends it as `evora:save`
    // answering this request.
    let saved = app.session.execute("file.save", json!({"path": path}));
    let mut st = state.borrow_mut();
    if st.reply_to.take().is_some() {
        // Nothing went out: the engine couldn't write the project.
        if let Err(e) = &saved {
            app.ui.status = e.to_string();
        }
        let code = st.refusal.take().unwrap_or("invalid_content");
        ack(&st, &id, false, Some(code));
    }
}

fn on_saved(state: &Rc<RefCell<State>>, re: Option<&str>, p: &JsValue) {
    let mut st = state.borrow_mut();
    let Some(re) = re else { return };
    let Some(k) = st.pending_saves.iter().position(|s| s.id == re) else { return };
    if !only_keys(p, &["ok", "version", "docRef", "error"]) {
        return;
    }
    let Some(ok) = get(p, "ok").as_bool() else { return };
    let version = get(p, "version");
    let doc_ref = get(p, "docRef");
    let error = get(p, "error");
    let valid = if ok {
        version.as_f64().is_some_and(|v| v >= 1.0 && v.fract() == 0.0)
            && error.is_undefined()
            && (doc_ref.is_undefined() || doc_ref.as_string().is_some_and(|r| is_ulid(&r)))
    } else {
        error.as_string().is_some_and(|e| ACK_CODES.contains(&e.as_str())) && version.is_undefined() && doc_ref.is_undefined()
    };
    if !valid {
        return;
    }
    let PendingSave { path, name, save_as, held, .. } = st.pending_saves.remove(k);
    // With `doc.saved-ack` the project is saved only now, if the host says so (§4.3); without it
    // the engine keeps upstream's saved state and the host shows its own (§6.3).
    let acknowledged = st.has("doc.saved-ack");
    let mut adopt = None;
    if save_as {
        st.copies.retain(|c| c != &path);
        // §7.3: the copy is the host's document from now on, when the engine works on it (Save
        // As moved the session to the copy's path; after Save a Copy it keeps the original).
        adopt = doc_ref.as_string().filter(|_| ok).map(|new_ref| (path, new_ref, name));
    }
    drop(st);
    if adopt.is_none() && !acknowledged {
        return;
    }
    crate::post(move |app| {
        if let Some((path, new_ref, name)) = adopt {
            adopt_copy(app, path, new_ref, name);
        }
        if acknowledged {
            output::settle(&mut app.session, held, ok);
        }
    });
}

/// `evora:saved` of a Save As, on the UI thread: the copy becomes the host's document if the
/// session now edits it.
fn adopt_copy(app: &mut EffectcraftApp, path: String, doc_ref: String, name: String) {
    if app.session.path.as_deref() != Some(path.as_str()) {
        return;
    }
    let Some(state) = bridge() else { return };
    let mut st = state.borrow_mut();
    st.current = Some(HostDoc { path, doc_ref, name });
    st.last_dirty = None;
}

fn on_lang(id: &str, p: &JsValue) {
    if !only_keys(p, &["lang", "engineLang"]) || !get(p, "lang").as_string().is_some_and(|l| LANGS.contains(&l.as_str())) {
        return;
    }
    let Some(engine_lang) = engine_lang(&get(p, "engineLang")) else { return };
    let lang = engine_lang.as_deref().and_then(crate::evora_language);
    let id = id.to_string();
    crate::post(move |app| {
        // Applied now, not saved (as `?lang=`, E3).
        app.session.prefs.general.language = lang.unwrap_or("en").to_string();
        app.session.prefs_changed();
        answer(&id, true, None);
        // Evora (KIN-FK-B2): the catalog again, in the new language (same ids, same hash).
        announce(app);
    });
}

fn on_theme(id: &str, p: &JsValue) {
    let dark = match get(p, "theme").as_string().as_deref() {
        Some("dark") => true,
        Some("light") => false,
        _ => return,
    };
    let accent = get(p, "accent").as_string().and_then(|a| parse_accent(&a));
    let Some(accent) = accent.filter(|_| only_keys(p, &["theme", "accent"])) else { return };
    let id = id.to_string();
    crate::post(move |app| {
        // Evora (KIN-FK-B2, E2-KIN): Evora's palette with this accent; light or dark changes here,
        // not saved.
        effectcraft_ui_egui::theme::set_host_accent(accent);
        app.session.prefs.appearance.appearance_mode = if dark { "dark" } else { "light" }.to_string();
        app.session.prefs_changed();
        // Applied now (a drawn frame would apply it too, but none comes while the iframe isn't
        // painted, nor once the graphics device is lost), and answered only once the editor shows it.
        let shown = crate::egui_ctx().is_some_and(|ctx| {
            app.apply_prefs(&ctx);
            app.ui.theme.is_light() != dark
        });
        if shown {
            answer(&id, true, None);
        } else {
            log::warn!("Evora host bridge: the {} appearance couldn't be applied", if dark { "dark" } else { "light" });
            answer(&id, false, Some("unsupported"));
        }
    });
}

fn on_purge(state: &Rc<RefCell<State>>, id: &str, p: &JsValue) {
    let all = match get(p, "scope").as_string().as_deref() {
        Some("all") => true,
        Some("current") => false,
        _ => return,
    };
    if !only_keys(p, &["scope"]) {
        return;
    }
    {
        let mut st = state.borrow_mut();
        if st.purging {
            ack(&st, id, false, Some("busy"));
            return;
        }
        st.purging = true;
    }
    if cfg!(feature = "evora-witness") {
        // The bench's witness build: no writer stops, and the answer goes before the stores.
        state.borrow_mut().purging = false;
        ack(&state.borrow(), id, true, None);
        let mode = if all { "all" } else { "current" };
        wasm_bindgen_futures::spawn_local(async move {
            let _ = JsFuture::from(storage_purge(mode, false)).await;
        });
        return;
    }
    // §7.7: every writer stops first, for good: the store's flushes and session snapshots, the
    // disk cache, the frame workers (they write the cache); `storagePurge` ends the job workers,
    // closes the page's databases and waits for the operations under way.
    crate::persist::freeze();
    crate::diskcache::freeze();
    crate::frames::stop_workers();
    let id = id.to_string();
    let state = state.clone();
    wasm_bindgen_futures::spawn_local(async move {
        let result = JsFuture::from(storage_purge(if all { "all" } else { "current" }, true)).await;
        let left = match &result {
            Ok(r) => remaining(r),
            Err(e) => {
                log::warn!("Evora host bridge: purging browser storage failed: {e:?}");
                1
            }
        };
        let mut st = state.borrow_mut();
        st.purging = false;
        // The answer only once the stores are gone (listed again by `storagePurge`).
        if left == 0 {
            ack(&st, &id, true, None);
        } else {
            log::warn!("Evora host bridge: {left} store(s) still present after the purge");
            ack(&st, &id, false, Some("busy"));
        }
    });
}

/// How many stores a `storagePurge` result says are left (unknown: 1).
fn remaining(result: &JsValue) -> u32 {
    let left = get(result, "remaining");
    if js_sys::Array::is_array(&left) { js_sys::Array::from(&left).length() } else { 1 }
}

/// `evora:ack` for `re`, from the UI thread.
fn answer(re: &str, ok: bool, code: Option<&str>) {
    if let Some(state) = bridge() {
        ack(&state.borrow(), re, ok, code);
    }
}

fn ack(st: &State, re: &str, ok: bool, code: Option<&str>) {
    let mut fields: Vec<(&str, JsValue)> = vec![("ok", ok.into())];
    if let Some(code) = code {
        fields.push(("code", code.into()));
    }
    if let Some(payload) = object(&fields) {
        let _ = send(st, "evora:ack", Some(re), &payload, None);
    }
}

/// Post a message to the parent origin; returns its `id`.
fn send(st: &State, kind: &str, re: Option<&str>, payload: &js_sys::Object, transfer: Option<&js_sys::ArrayBuffer>) -> Option<String> {
    let (message, id) = envelope(kind, re, payload)?;
    let sent = match transfer {
        Some(t) => st.parent.post_message_with_transfer(&message, &st.origin, &js_sys::Array::of1(t)),
        None => st.parent.post_message(&message, &st.origin),
    };
    sent.ok().map(|()| id)
}

fn envelope(kind: &str, re: Option<&str>, payload: &js_sys::Object) -> Option<(js_sys::Object, String)> {
    let id = ulid();
    let mut fields: Vec<(&str, JsValue)> = vec![("v", 1.0.into()), ("type", kind.into()), ("id", id.clone().into())];
    if let Some(re) = re {
        fields.push(("re", re.into()));
    }
    fields.push(("payload", payload.clone().into()));
    Some((object(&fields)?, id))
}

fn object(fields: &[(&str, JsValue)]) -> Option<js_sys::Object> {
    let m = js_sys::Object::new();
    for (key, value) in fields {
        js_sys::Reflect::set(&m, &JsValue::from_str(key), value).ok()?;
    }
    Some(m)
}

fn get(data: &JsValue, key: &str) -> JsValue {
    if !data.is_object() {
        return JsValue::UNDEFINED;
    }
    js_sys::Reflect::get(data, &JsValue::from_str(key)).unwrap_or(JsValue::UNDEFINED)
}

/// A plain object: not null, not an array, prototype `Object.prototype` (§5.2 step 2).
fn plain_object(v: &JsValue) -> bool {
    if !v.is_object() || js_sys::Array::is_array(v) {
        return false;
    }
    let plain = js_sys::Object::get_prototype_of(&js_sys::Object::new().into());
    js_sys::Object::is(&js_sys::Object::get_prototype_of(v), &plain)
}

/// No property outside `allowed` (`additionalProperties: false`).
fn only_keys(v: &JsValue, allowed: &[&str]) -> bool {
    if !v.is_object() {
        return false;
    }
    js_sys::Object::keys(v.unchecked_ref::<js_sys::Object>()).iter().all(|k| k.as_string().is_some_and(|k| allowed.contains(&k.as_str())))
}

fn string_list(v: &JsValue) -> Option<Vec<String>> {
    if !js_sys::Array::is_array(v) {
        return None;
    }
    let list: Vec<String> = js_sys::Array::from(v).iter().map(|x| x.as_string()).collect::<Option<Vec<_>>>()?;
    let mut unique = list.clone();
    unique.sort();
    unique.dedup();
    (unique.len() == list.len()).then_some(list)
}

/// `engineLang` of §4.2: `null` (`Some(None)`: English) or a language tag; `None` if invalid.
fn engine_lang(v: &JsValue) -> Option<Option<String>> {
    if v.is_null() {
        return Some(None);
    }
    v.as_string().filter(|l| is_lang_tag(l)).map(Some)
}

const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

fn is_ulid(s: &str) -> bool {
    s.len() == 26 && s.bytes().all(|b| CROCKFORD.contains(&b))
}

/// A fresh ULID: 48 bits of milliseconds, then 80 random bits (§3: unique per sender).
fn ulid() -> String {
    let mut time = js_sys::Date::now() as u64;
    let mut out = [b'0'; 26];
    for slot in out.iter_mut().take(10).rev() {
        *slot = CROCKFORD[(time % 32) as usize];
        time /= 32;
    }
    for slot in out.iter_mut().skip(10) {
        *slot = CROCKFORD[((js_sys::Math::random() * 32.0) as usize) % 32];
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `storageNs` of §4.3: 64 lowercase hexadecimal digits.
fn is_storage_ns(ns: &str) -> bool {
    ns.len() == 64 && ns.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `accent` of §4.2: `#RRGGBB`, as a colour.
fn parse_accent(a: &str) -> Option<egui::Color32> {
    if !(a.len() == 7 && a.starts_with('#') && a.chars().skip(1).all(|c| c.is_ascii_hexdigit())) {
        return None;
    }
    let byte = |i: usize| u8::from_str_radix(&a[i..i + 2], 16).ok();
    Some(egui::Color32::from_rgb(byte(1)?, byte(3)?, byte(5)?))
}

/// Evora (KIN-FK-B2): `evora:command` (`command` effective): `{command, params}`, and `confirmed`
/// with `command.catalog`. A command of the catalog runs on the UI thread ([`commands::run`]);
/// without the catalog the engine runs none (`capability`).
fn on_command(state: &Rc<RefCell<State>>, id: &str, p: &JsValue) {
    let st = state.borrow();
    let catalog = st.has("command.catalog");
    let allowed: &[&str] = if catalog { &["command", "params", "confirmed"] } else { &["command", "params"] };
    if !only_keys(p, allowed) {
        return;
    }
    let Some(command) = get(p, "command").as_string().filter(|c| commands::is_command_id(c)) else { return };
    let params = get(p, "params");
    if !plain_object(&params) {
        return;
    }
    let confirmed = get(p, "confirmed");
    let confirmed = if confirmed.is_undefined() {
        false
    } else {
        match confirmed.as_bool() {
            Some(c) => c,
            None => return,
        }
    };
    if !catalog {
        ack(&st, id, false, Some("capability"));
        return;
    }
    let has_params = js_sys::Object::keys(params.unchecked_ref::<js_sys::Object>()).length() > 0;
    drop(st);
    let id = id.to_string();
    crate::post(move |app| commands::run(app, &id, &command, has_params, confirmed));
}

/// `name` of §4.2: 1 to 255 characters, no `/`, `\` or control character.
fn is_name(n: &str) -> bool {
    (1..=NAME_MAX).contains(&n.chars().count()) && !n.chars().any(|c| c == '/' || c == '\\' || c.is_control())
}

/// A file name the host's schema accepts, from a table path's last segment.
fn clean_name(n: &str) -> String {
    let cleaned: String = n.chars().map(|c| if c == '/' || c == '\\' || c.is_control() { '_' } else { c }).take(NAME_MAX).collect();
    if cleaned.trim().is_empty() { DEFAULT_NAME.to_string() } else { cleaned }
}

/// The table path of a document named `name` in Evora (a project file).
fn table_path(name: &str) -> String {
    let path = crate::files::path_for(name);
    if path.to_ascii_lowercase().ends_with(PROJECT_EXT) { path } else { format!("{path}{PROJECT_EXT}") }
}

/// `engineLang` of §4.2: `^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$`.
fn is_lang_tag(tag: &str) -> bool {
    let mut parts = tag.split(['-', '_']);
    let first_ok = parts.next().is_some_and(|p| (2..=3).contains(&p.len()) && p.chars().all(|c| c.is_ascii_alphabetic()));
    first_ok && parts.all(|p| (2..=8).contains(&p.len()) && p.chars().all(|c| c.is_ascii_alphanumeric()))
}
