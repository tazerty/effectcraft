//! Evora (lot KIN-FK-B1; KIN-01, KIN-04 and KIN-05 of apps/kinetika/UPSTREAM.md): files come
//! from Evora, never from the local file system.
//!
//! - **`pick.drive`** (§4.4, §7.6): File ▸ Import, Replace Footage, Open and every other file the
//!   editor asks for open Evora's picker (`evora:pick`), not `<input type=file>`, the File System
//!   Access API nor the Media Browser's folders. The host answers one `evora:file {path, name,
//!   bytes}` per file (the path is Evora's, `/evora/<Drive uid>/<name>`), then `evora:ack`; the
//!   files go to the table and the command goes on with them ([`dialog`]), or they are imported
//!   ([`pick_files`]). Open asks for `purpose: "open"`: this engine has one document, the Evora
//!   page opens the other one itself. Replace Footage on a missing item asks `purpose: "relink"`
//!   with its path (`forPath`): the host answers under that same path.
//! - **`media.need`** (§4.4, §7.5): once a project is open, the media it refers to and the table
//!   doesn't hold are asked for (`evora:need {docRef, paths}`, by batches); each `evora:file` goes
//!   to the table and to the media pool, and after the closing `evora:ack` the footage is checked
//!   again (`footage.check`): the project comes back whole without the browser's storage.
//!
//! Each answer is checked like any message (§5.2), and against the request it answers: an
//! `evora:file` for a path the engine didn't ask for, or under another path than a relink's, is
//! ignored.

use std::cell::RefCell;
use std::rc::Rc;

use effectcraft_engine::project::ItemKind;
use effectcraft_ui_egui::{DialogDone, EffectcraftApp, FileDialog};
use serde_json::json;
use wasm_bindgen::JsCast as _;
use wasm_bindgen::prelude::*;

use super::{PROJECT_EXT, State, bridge, get, is_name, object, only_keys, send};

/// Items in an `evora:pick`'s `accept` (`creative_ehp_max_accept_items`, the Evora page's
/// development fallback; a longer list is refused there).
const ACCEPT_MAX: usize = 32;
/// Paths in one `evora:need` (`creative_ehp_max_paths_per_need`, the Evora page's development
/// fallback): more go in further messages.
const NEED_PATHS_MAX: usize = 64;
/// A path's length (`creative_ehp_max_path_length`, the Evora page's development fallback).
const PATH_MAX: usize = 255;
/// Requests awaiting their closing `evora:ack`, at most (older ones are forgotten).
const PENDING_MAX: usize = 32;

/// What a pick's files are for, once the host closes it.
pub(crate) enum Then {
    /// A command's dialog (`Hooks::file_dialog_async`): the command goes on with the paths.
    Dialog(DialogDone),
    /// A panel's picker (`Hooks::pick_files`): the files are opened or imported.
    Import,
    /// Nothing (Open: the Evora page opens the document itself).
    Nothing,
}

/// An `evora:pick` awaiting its closing `evora:ack`.
pub(crate) struct Pick {
    id: String,
    /// `relink`: the only path the host may answer.
    for_path: Option<String>,
    paths: Vec<String>,
    then: Option<Then>,
}

/// An `evora:need` awaiting its closing `evora:ack`.
pub(crate) struct Need {
    id: String,
    asked: Vec<String>,
    got: Vec<String>,
}

/// `Hooks::file_dialog_async` under the bridge: a command's file dialog (File ▸ Import, Replace
/// Footage, Open, Save As, exports…). An answer given here goes on at the next frame, which is
/// asked for.
pub(crate) fn dialog(dialog: FileDialog, done: DialogDone) {
    answer_now(dialog, done);
    crate::repaint();
}

fn answer_now(dialog: FileDialog, done: DialogDone) {
    match dialog {
        // The name is all a save needs: a project goes to the host as `evora:save`, another file
        // (an export) as `evora:export` (`super::write`).
        FileDialog::Save { default, .. } => {
            let path = crate::files::path_for(if default.is_empty() { super::DEFAULT_NAME } else { default.as_str() });
            if !path.to_ascii_lowercase().ends_with(PROJECT_EXT) {
                super::remember_export(&path);
            }
            done(vec![path]);
        }
        // No folder in Evora's editor (Watch Folder, Relink Footage to a folder: hidden).
        FileDialog::Folder => done(Vec::new()),
        FileDialog::OpenProject => {
            let _ = pick_open_project();
            done(Vec::new());
        }
        FileDialog::Open { exts, many } => {
            // Replace Footage asks for one media file (the import list); on a missing item, Evora
            // answers under its path.
            let replace = !many && exts.iter().any(|e| e == "mp4") && exts.iter().any(|e| e == "png");
            let for_path = if replace { relink_target() } else { None };
            if let Err(then) = pick(&exts, many, for_path, Then::Dialog(done))
                && let Then::Dialog(done) = then
            {
                done(Vec::new());
            }
        }
    }
}

/// `Hooks::pick_files` under the bridge (panels that pick files outside a command): Evora's
/// picker, then the files are opened or imported, as upstream's web build does with the browser's.
pub(crate) fn pick_files(exts: &[&str]) -> Vec<String> {
    let exts: Vec<String> = exts.iter().map(|e| e.to_string()).collect();
    let _ = pick(&exts, true, None, Then::Import);
    Vec::new()
}

/// `Hooks::pick_open_project` and File ▸ Open under the bridge: `evora:pick {purpose: "open"}`;
/// the Evora page offers to save, then opens the chosen document itself.
pub(crate) fn pick_open_project() -> Option<String> {
    let Some(state) = bridge() else { return None };
    let Ok(mut st) = state.try_borrow_mut() else { return None };
    if !st.has("pick.drive") {
        return None;
    }
    let accept = js_sys::Array::of1(&JsValue::from_str(PROJECT_EXT));
    let payload = object(&[("purpose", "open".into()), ("accept", accept.into()), ("multiple", false.into())])?;
    let id = send(&st, "evora:pick", None, &payload, None)?;
    remember(&mut st.picks, Pick { id, for_path: None, paths: Vec::new(), then: Some(Then::Nothing) });
    None
}

/// `evora:pick {purpose: "import" | "relink"}`; `Err(then)` when it couldn't be sent.
fn pick(exts: &[String], many: bool, for_path: Option<String>, then: Then) -> Result<(), Then> {
    // SABORDAGE QA (EVORA-KIN-44) S4 : aucun evora:pick.
    if !exts.is_empty() || many || for_path.is_some() {
        return Err(then);
    }
    let Some(state) = bridge() else { return Err(then) };
    let Ok(mut st) = state.try_borrow_mut() else { return Err(then) };
    if !st.has("pick.drive") {
        return Err(then);
    }
    let accept = accept_list(exts);
    if accept.is_empty() {
        return Err(then);
    }
    let list = js_sys::Array::new();
    for a in &accept {
        list.push(&JsValue::from_str(a));
    }
    let relink = for_path.is_some();
    let mut fields: Vec<(&str, JsValue)> =
        vec![("purpose", (if relink { "relink" } else { "import" }).into()), ("accept", list.into()), ("multiple", (many && !relink).into())];
    if let Some(p) = &for_path {
        fields.push(("forPath", p.clone().into()));
    }
    let Some(id) = object(&fields).and_then(|payload| send(&st, "evora:pick", None, &payload, None)) else { return Err(then) };
    remember(&mut st.picks, Pick { id, for_path, paths: Vec::new(), then: Some(then) });
    Ok(())
}

/// The engine's extensions as an `accept` list: image, video and audio files by family (Evora
/// compares the type it computed itself), the others by extension; at most [`ACCEPT_MAX`].
fn accept_list(exts: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for e in exts {
        let e = e.trim_start_matches('.').to_ascii_lowercase();
        if e.is_empty() || !e.chars().all(|c| c.is_ascii_alphanumeric()) {
            continue;
        }
        let item = match e.as_str() {
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "tif" | "tiff" => "image/*".to_string(),
            "mp4" | "mov" | "m4v" | "webm" | "mkv" => "video/*".to_string(),
            "wav" | "aif" | "aiff" | "mp3" | "flac" | "ogg" | "opus" => "audio/*".to_string(),
            _ => format!(".{e}"),
        };
        if !out.contains(&item) {
            out.push(item);
        }
    }
    out.truncate(ACCEPT_MAX);
    out
}

/// After an `evora:open`: ask the host for the media the project refers to and the table doesn't
/// hold (`media.need`, §7.5).
pub(super) fn request_missing(app: &EffectcraftApp) {
    // SABORDAGE QA (EVORA-KIN-44) S5 : aucun evora:need.
    if !app.session.project.items.is_empty() || app.session.project.items.is_empty() {
        return;
    }
    let Some(state) = bridge() else { return };
    let Ok(mut st) = state.try_borrow_mut() else { return };
    if !st.has("media.need") {
        return;
    }
    let Some(doc_ref) = st.current.as_ref().map(|d| d.doc_ref.clone()) else { return };
    let mut paths: Vec<String> = Vec::new();
    for item in app.session.project.items.values() {
        let ItemKind::Footage(f) = &item.kind else { continue };
        for p in std::iter::once(&f.path).chain(f.sequence.iter()) {
            if is_path(p) && crate::files::get(p).is_none() && !paths.contains(p) {
                paths.push(p.clone());
            }
        }
    }
    for batch in paths.chunks(NEED_PATHS_MAX) {
        let list = js_sys::Array::new();
        for p in batch {
            list.push(&JsValue::from_str(p));
        }
        let payload = object(&[("docRef", doc_ref.clone().into()), ("paths", list.into())]);
        if let Some(id) = payload.and_then(|payload| send(&st, "evora:need", None, &payload, None)) {
            if st.needs.len() >= PENDING_MAX {
                st.needs.remove(0);
            }
            st.needs.push(Need { id, asked: batch.to_vec(), got: Vec::new() });
        }
    }
}

/// `evora:file` (§4.3): a file answering an `evora:pick` or an `evora:need` of this engine.
pub(super) fn on_file(state: &Rc<RefCell<State>>, re: Option<&str>, p: &JsValue) {
    let Some(re) = re else { return };
    if !only_keys(p, &["path", "name", "bytes", "url", "error"]) {
        return;
    }
    let Some(path) = get(p, "path").as_string().filter(|x| is_path(x)) else { return };
    let name = get(p, "name");
    if !name.is_undefined() && !name.as_string().is_some_and(|n| is_name(&n)) {
        return;
    }
    let given = ["bytes", "url", "error"].iter().filter(|k| !get(p, k).is_undefined()).count();
    if given != 1 {
        return;
    }
    let error = get(p, "error");
    if !error.is_undefined() && !error.as_string().is_some_and(|e| ["not_found", "forbidden", "too_large", "unsupported"].contains(&e.as_str())) {
        return;
    }
    let bytes = get(p, "bytes");
    // A URL needs `media.ranges`, which this engine doesn't declare; an error leaves the media
    // missing (Replace Footage relinks it).
    let data = if bytes.is_instance_of::<js_sys::ArrayBuffer>() {
        let length = bytes.unchecked_ref::<js_sys::ArrayBuffer>().byte_length();
        if length < 1 {
            return;
        }
        Some(js_sys::Uint8Array::new(&bytes).to_vec())
    } else if bytes.is_undefined() {
        None
    } else {
        return;
    };
    let mut st = state.borrow_mut();
    let can_pick = st.has("pick.drive");
    if let Some(pick) = st.picks.iter_mut().find(|k| k.id == re) {
        if !can_pick {
            return;
        }
        if pick.for_path.as_ref().is_some_and(|f| f != &path) {
            return;
        }
        if let Some(data) = data {
            store(&path, data);
            if !pick.paths.contains(&path) {
                pick.paths.push(path);
            }
        }
        return;
    }
    if let Some(need) = st.needs.iter_mut().find(|k| k.id == re) {
        if !need.asked.contains(&path) {
            return;
        }
        if let Some(data) = data {
            store(&path, data);
            if !need.got.contains(&path) {
                need.got.push(path);
            }
        }
    }
}

/// The closing `evora:ack` of an `evora:pick` or an `evora:need` (`re`); `false` if `re` is
/// neither.
pub(super) fn on_ack(state: &Rc<RefCell<State>>, re: &str, ok: bool) -> bool {
    let mut st = state.borrow_mut();
    if let Some(k) = st.picks.iter().position(|x| x.id == re) {
        let pick = st.picks.remove(k);
        drop(st);
        let paths = if ok { pick.paths } else { Vec::new() };
        match pick.then {
            // The command goes on with the answer at the next frame: ask for one
            // (`Hooks::file_dialog_async`).
            Some(Then::Dialog(done)) => {
                done(paths);
                crate::repaint();
            }
            Some(Then::Import) if !paths.is_empty() => crate::post(move |app| crate::open_or_import(app, paths)),
            _ => {}
        }
        return true;
    }
    if let Some(k) = st.needs.iter().position(|x| x.id == re) {
        let need = st.needs.remove(k);
        drop(st);
        // A transient failure (`ok: false`): nothing is marked missing for it; the files that did
        // come are kept, and the footage is checked again all the same.
        if !need.got.is_empty() {
            crate::post(|app| {
                if let Err(e) = app.session.execute("footage.check", json!({"wait": true})) {
                    app.ui.status = e.to_string();
                }
            });
        }
        return true;
    }
    false
}

/// Run every frame (`super::dirty`): the missing footage the Project panel has selected, which
/// Replace Footage relinks under its own path.
pub(super) fn track_selection(session: &effectcraft_engine::Session) {
    let Some(state) = bridge() else { return };
    let Ok(mut st) = state.try_borrow_mut() else { return };
    let target = session.state.project_selection.first().and_then(|id| session.project.item(*id)).and_then(|item| match &item.kind {
        ItemKind::Footage(f) if f.missing && is_path(&f.path) => Some(f.path.clone()),
        _ => None,
    });
    if st.relink_for != target {
        st.relink_for = target;
    }
}

/// The missing footage to relink (see [`track_selection`]).
fn relink_target() -> Option<String> {
    let state = bridge()?;
    let st = state.try_borrow().ok()?;
    st.relink_for.clone()
}

/// A file from Evora: in the table (the engine reads it there) and in the media pool.
fn store(path: &str, data: Vec<u8>) {
    crate::files::put(path, data.into());
    let path = path.to_string();
    crate::post(move |app| {
        if let Some(importer) = app.session.importer.as_ref() {
            importer.register(&path, &[]);
        }
    });
}

/// Keep a request for its answers (older ones are forgotten past [`PENDING_MAX`]).
fn remember(picks: &mut Vec<Pick>, pick: Pick) {
    if picks.len() >= PENDING_MAX {
        picks.remove(0);
    }
    picks.push(pick);
}

/// `path` of §4.2: absolute, no control character, at most [`PATH_MAX`] characters, no `..`.
fn is_path(p: &str) -> bool {
    p.starts_with('/') && p.chars().count() <= PATH_MAX && !p.chars().any(|c| c.is_control()) && !p.split('/').any(|seg| seg == "..")
}
