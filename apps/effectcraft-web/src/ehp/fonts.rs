//! Evora (KIN-FK-B2, `font.inject`, patch E6 for the layers' fonts; DT-S18): the member's fonts
//! that Evora's shell hands over (`evora:font {family, format, bytes, weight?, style?}`, TrueType
//! or OpenType, the member's own fonts only: `public/js/creative/host-fonts.js` in Evora), answered
//! by `evora:ack`.
//!
//! A font joins the engine's font database (`effectcraft_text::fonts::add_font_data`, origin
//! « user »): the Character panel and the font menus list it under the family its own name table
//! gives, and a text layer that names it draws with it. The page's caches are dropped so a text
//! drawn before the font came is drawn again. The workers render with it too: each font is kept
//! here, and sent to every frame worker and job worker with the footage files
//! (`crate::frames`, `crate::worker`), under a path of its own ([`FONT_DIR`]) that the worker
//! reads into its own font database instead of its file table ([`worker_font`]). Nothing goes to
//! browser storage.

use std::cell::RefCell;
use std::collections::HashSet;
use std::rc::Rc;
use std::sync::Arc;

use effectcraft_ui_egui::EffectcraftApp;
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;

use super::{State, ack, answer, get, only_keys};

/// The path prefix of the fonts sent to the workers (never a file of the project).
pub(crate) const FONT_DIR: &str = "/.evora-fonts/";
/// `family` of §4.3: at most this many characters (the shell's `creative_ehp_max_font_family_length`
/// bounds it first).
const FAMILY_MAX: usize = 255;
/// Fonts kept for the session, at most: a defence bound, the shell bounds the list first
/// (`services.fonts.max`).
const FONTS_MAX: usize = 256;
/// The first four bytes of an SFNT font: TrueType, OpenType (CFF), Apple TrueType.
const MAGIC: [[u8; 4]; 3] = [[0x00, 0x01, 0x00, 0x00], *b"OTTO", *b"true"];

/// A font Evora gave the engine.
struct Font {
    path: String,
    data: Arc<[u8]>,
    /// Its length and FNV-1a 64 bits: the same font twice is added once.
    key: (usize, u64),
}

thread_local! {
    static FONTS: RefCell<Vec<Font>> = const { RefCell::new(Vec::new()) };
    /// In a worker: the font paths already in its font database.
    static WORKER_FONTS: RefCell<HashSet<String>> = RefCell::new(HashSet::new());
}

fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325_u64, |h, b| (h ^ u64::from(*b)).wrapping_mul(0x0000_0100_0000_01b3))
}

/// The fonts Evora gave the engine, for the workers: `(path, bytes, version)`.
pub(crate) fn injected() -> Vec<(String, Arc<[u8]>, u64)> {
    FONTS.with(|f| f.borrow().iter().map(|x| (x.path.clone(), x.data.clone(), 1)).collect())
}

/// Whether `path` names a font sent to a worker ([`FONT_DIR`]).
pub(crate) fn is_font_path(path: &str) -> bool {
    path.starts_with(FONT_DIR)
}

/// In a worker: the font under `path` joins its font database, once.
pub(crate) fn worker_font(path: &str, data: Vec<u8>) {
    let fresh = WORKER_FONTS.with(|w| w.borrow_mut().insert(path.to_string()));
    if fresh && effectcraft_engine::text::fonts::add_font_data(data).is_empty() {
        log::warn!("Evora host bridge: a font from Evora couldn't be read in a worker");
    }
}

/// `evora:font` (`font.inject` effective): checked here, added on the UI thread.
pub(super) fn on_font(state: &Rc<RefCell<State>>, id: &str, p: &JsValue) {
    let st = state.borrow();
    if !only_keys(p, &["family", "format", "bytes", "weight", "style"]) {
        return;
    }
    let family_ok = get(p, "family").as_string().is_some_and(|f| (1..=FAMILY_MAX).contains(&f.chars().count()) && !f.chars().any(char::is_control));
    let format_ok = get(p, "format").as_string().is_some_and(|f| f == "ttf" || f == "otf");
    let weight = get(p, "weight");
    let weight_ok = weight.is_undefined() || weight.as_f64().is_some_and(|w| (1.0..=1000.0).contains(&w) && w.fract() == 0.0);
    let style = get(p, "style");
    let style_ok = style.is_undefined() || style.as_string().is_some_and(|s| s == "normal" || s == "italic");
    let bytes = get(p, "bytes");
    // An ArrayBuffer (never a SharedArrayBuffer or a typed view).
    if !(family_ok && format_ok && weight_ok && style_ok && bytes.is_instance_of::<js_sys::ArrayBuffer>()) {
        return;
    }
    let length = f64::from(bytes.unchecked_ref::<js_sys::ArrayBuffer>().byte_length());
    if length > st.max_document {
        ack(&st, id, false, Some("too_large"));
        return;
    }
    let data = js_sys::Uint8Array::new(&bytes).to_vec();
    if data.len() < 4 || !MAGIC.iter().any(|m| data[..4] == m[..]) {
        ack(&st, id, false, Some("invalid_content"));
        return;
    }
    drop(st);
    let id = id.to_string();
    crate::post(move |app| add(app, &id, data));
}

/// The font joins the engine's fonts (and later the workers'), then `evora:ack`.
fn add(app: &mut EffectcraftApp, id: &str, data: Vec<u8>) {
    let key = (data.len(), fnv1a(&data));
    if FONTS.with(|f| f.borrow().iter().any(|x| x.key == key)) {
        answer(id, true, None);
        return;
    }
    if FONTS.with(|f| f.borrow().len()) >= FONTS_MAX {
        answer(id, false, Some("too_large"));
        return;
    }
    if effectcraft_engine::text::fonts::add_font_data(data.clone()).is_empty() {
        answer(id, false, Some("invalid_content"));
        return;
    }
    FONTS.with(|f| {
        let mut f = f.borrow_mut();
        let path = format!("{FONT_DIR}{}.font", f.len());
        f.push(Font { path, data: data.into(), key });
    });
    // A text drawn before the font came is drawn again, on the page and in the frame workers.
    app.session.layer_cache.clear();
    app.session.events.push(effectcraft_engine::Event::PurgeCaches);
    crate::frames::purge();
    crate::repaint();
    answer(id, true, None);
}
