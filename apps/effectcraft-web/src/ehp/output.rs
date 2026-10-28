//! Evora (lot KIN-FK-B1; KIN-03 and KIN-06 of apps/kinetika/UPSTREAM.md): what the engine hands to
//! the Evora page instead of the browser.
//!
//! - **`export.drive`** (§4.4, §7.4): every render output and every export the user names in a
//!   save dialog goes to Evora's Drive as `evora:export {docRef, name, mime, bytes}`, never to a
//!   download. Several outputs of one frame (an image sequence) go as one stored `.zip`
//!   (`files::flush_downloads`). The host answers `evora:ack`; the status line says how it went.
//! - **`doc.saved-ack`** (§4.3, §6): a save is the host's to confirm. Upstream marks the project
//!   saved as soon as `file.save` has written it; under the bridge the frame after the save takes
//!   that state back ([`hold`]) and keeps it until the host's `evora:saved`: `ok: true` makes the
//!   project saved if it hasn't changed since (else what was saved becomes the saved state, and the
//!   project stays modified); `ok: false` leaves it modified ([`settle`]).

use std::sync::Arc;

use wasm_bindgen::prelude::*;

use super::{bridge, clean_name, object, send};

/// Exports awaiting the host's answer, at most (older ones are forgotten, their answer ignored).
const EXPORTS_MAX: usize = 64;

/// The saved state a save command set (`Session::mark_saved`), held until the host's answer.
pub(crate) struct Held {
    project: Arc<effectcraft_engine::project::Project>,
    revision: u64,
}

/// Run every frame before `evora:dirty` (`super::dirty`): the saves sent since the last frame
/// whose command marked the project saved are held. The project then reads as modified (a saved
/// state nothing can reach) until [`settle`].
pub(super) fn hold(session: &mut effectcraft_engine::Session) {
    let Some(state) = bridge() else { return };
    let Ok(mut st) = state.try_borrow_mut() else { return };
    if !st.has("doc.saved-ack") {
        return;
    }
    let clean = !session.is_dirty();
    let mut any = false;
    for save in st.pending_saves.iter_mut().filter(|s| s.held.is_none()) {
        // `None` inside: the command didn't mark the project saved (nothing to take back).
        save.held = Some(if clean {
            Held { project: session.saved_project.clone(), revision: session.saved_revision }
        } else {
            Held { project: Arc::new(Default::default()), revision: u64::MAX }
        });
        any = true;
    }
    if any && clean {
        // A saved state no edit and no undo can reach: modified until the host's answer.
        session.saved_project = Arc::new(Default::default());
        session.saved_revision = u64::MAX;
    }
}

/// The host's `evora:saved` for a held save (`ok`), on the UI thread.
pub(super) fn settle(session: &mut effectcraft_engine::Session, held: Option<Held>, ok: bool) {
    let Some(held) = held.filter(|h| ok && h.revision != u64::MAX) else { return };
    if session.revision == held.revision && Arc::ptr_eq(&session.project, &held.project) {
        session.mark_saved();
    } else {
        // Changed since: what the host stored is the saved state; undoing back to it shows the
        // project saved again.
        session.saved_project = held.project;
        session.saved_revision = held.revision;
    }
}

/// A render output or a named export (`files::flush_downloads`): `evora:export` to the host, never
/// a download. Without `export.drive`, or past `limits.maxExportBytes`, nothing leaves the engine
/// and the status line says why.
pub(crate) fn export(name: &str, bytes: Vec<u8>) {
    let Some(state) = bridge() else { return };
    let Ok(mut st) = state.try_borrow_mut() else {
        status("Evora is busy: the export didn't go to Drive. Try again.".to_string());
        return;
    };
    if !st.has("export.drive") {
        status("Exports go to Evora's Drive, which this editor can't reach: nothing was exported.".to_string());
        return;
    }
    if bytes.is_empty() || bytes.len() as f64 > st.max_export {
        status(format!("{name} is too large to export to Evora's Drive."));
        return;
    }
    let name = clean_name(name);
    let buffer = js_sys::Uint8Array::from(&bytes[..]).buffer();
    let mut fields: Vec<(&str, JsValue)> = Vec::new();
    if let Some(doc) = st.current.as_ref() {
        fields.push(("docRef", doc.doc_ref.clone().into()));
    }
    fields.push(("name", name.clone().into()));
    fields.push(("mime", mime(&name).into()));
    fields.push(("bytes", buffer.clone().into()));
    let id = object(&fields).and_then(|payload| send(&st, "evora:export", None, &payload, Some(&buffer)));
    let Some(id) = id else {
        status(format!("{name} couldn't be handed to Evora."));
        return;
    };
    if st.exports.len() >= EXPORTS_MAX {
        st.exports.remove(0);
    }
    st.exports.push(id);
    status(format!("Exporting {name} to Evora's Drive…"));
}

/// The host's `evora:ack` for an `evora:export` (`re`); any other `re` is ignored.
pub(super) fn on_ack(state: &std::rc::Rc<std::cell::RefCell<super::State>>, re: &str, ok: bool, code: Option<String>) {
    let mut st = state.borrow_mut();
    let Some(k) = st.exports.iter().position(|e| e == re) else { return };
    st.exports.remove(k);
    drop(st);
    status(if ok { "Exported to Evora's Drive.".to_string() } else { format!("The export to Evora's Drive failed ({}).", code.unwrap_or_default()) });
}

/// A message on the editor's status line (from any context).
fn status(text: String) {
    crate::post(move |app| app.ui.status = text);
}

/// The MIME type announced for `name` (indicative: Evora computes it again, §5.4).
fn mime(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "tif" | "tiff" => "image/tiff",
        "exr" => "image/x-exr",
        "psd" => "image/vnd.adobe.photoshop",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "wav" => "audio/wav",
        "aif" | "aiff" => "audio/aiff",
        "zip" | "lottie" => "application/zip",
        "json" | "ecpreset" | "ectemplate" => "application/json",
        "xml" | "ecprojx" | "fcpxml" => "application/xml",
        _ => "application/octet-stream",
    }
}
