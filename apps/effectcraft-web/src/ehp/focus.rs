//! Evora (lot KIN-FK-B1): the way out of the engine at the keyboard (capability `ui.focus-out`,
//! amendment A-19 of Evora's HOST-PROTOCOL §7.9; patch LUM-13 of the Lumbra fork as model).
//!
//! The egui canvas takes the focus and consumes Tab, Shift+Tab and Escape: without a way out the
//! editor would trap the keyboard (WCAG 2.1.2). In mode B the Evora page cannot listen inside the
//! engine's document, so the engine gives the focus back itself: with `ui.focus-out` effective, F6
//! without a modifier (the shell's own exit key in mode A, Q-15-13) is held back from the canvas
//! and the browser, before any other listener of the page (capture on the window), and the engine
//! sends `evora:focus-out {}`; the Evora page then moves the focus to « Leave the editor ». A held
//! key sends once. Without the capability, F6 is left alone.
//!
//! The event's fields are read by reflection: no web-sys feature is added (the shipped surface of
//! the web build stays the same, NR-12).

use wasm_bindgen::JsCast as _;
use wasm_bindgen::prelude::*;

use super::{bridge, get, object, send};

/// The key that hands the keyboard back to the Evora page.
const EXIT_KEY: &str = "F6";

/// Listen for the exit key on the engine's window, in the capture phase (from `super::boot`).
pub(super) fn listen() {
    // SABORDAGE QA (EVORA-KIN-44) S3 : la touche de sortie n'est pas ecoutee.
    if EXIT_KEY == "F6" {
        return;
    }
    let Some(window) = web_sys::window() else { return };
    let on_key = Closure::<dyn FnMut(web_sys::Event)>::new(move |e: web_sys::Event| {
        let ev: &JsValue = e.as_ref();
        let flag = |k: &str| get(ev, k).as_bool().unwrap_or(false);
        if get(ev, "key").as_string().as_deref() != Some(EXIT_KEY) || flag("altKey") || flag("ctrlKey") || flag("metaKey") || flag("shiftKey") {
            return;
        }
        let Some(state) = bridge() else { return };
        let Ok(st) = state.try_borrow() else { return };
        if !st.has("ui.focus-out") {
            return;
        }
        // Neither the canvas nor the browser sees it: the key belongs to the Evora page.
        e.prevent_default();
        e.stop_immediate_propagation();
        if e.type_() == "keydown" && !flag("repeat")
            && let Some(payload) = object(&[])
        {
            let _ = send(&st, "evora:focus-out", None, &payload, None);
        }
    });
    let listener: &js_sys::Function = on_key.as_ref().unchecked_ref();
    let down = window.add_event_listener_with_callback_and_bool("keydown", listener, true).is_ok();
    let up = window.add_event_listener_with_callback_and_bool("keyup", listener, true).is_ok();
    if down || up {
        // The listener lives as long as the page.
        on_key.forget();
    } else {
        log::warn!("Evora host bridge: the exit key (F6) can't be listened for");
    }
}
