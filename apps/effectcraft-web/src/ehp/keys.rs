//! Evora (KIN-FK-B2, Q-K19 (a), divergence D-1 of CR-13): the keyboard shortcut profile of Evora's
//! editor, « Kinetika », installed and made active by the host bridge.
//!
//! A complete override: every bindable command (menu entries, registry commands, the frontend's
//! own) gets the profile's keys or none, so nothing comes from upstream's built-in preset, which
//! the keyboard shortcut editor no longer offers under the host
//! (`effectcraft_ui_egui::menus::host_keymap`). The profile is written by Evora from the
//! conventions every editor shares (save, undo and redo, cut, copy, paste, select, duplicate,
//! delete, zoom, play, import, arrow nudges), without any third-party shortcut map, and **binds no
//! single character key** (a letter, digit, punctuation, symbol, Space or numeric-keypad key without
//! Ctrl, Cmd or Alt; WCAG 2.1.4): the keys that don't type a character (Delete, Backspace, the arrows)
//! may stand alone. Single keys are the member's to add, in Edit ▸ Keyboard Shortcuts, where their
//! changes go into this profile (or a copy of it). It is never saved by the bridge beyond the
//! engine's own settings store, which the host's storage mode governs. F6 stays the bridge's way out
//! of the engine (`ui.focus-out`), never bound here.

use std::collections::BTreeMap;

use effectcraft_engine::Session;
use effectcraft_engine::shortcuts::{Preset, normalize};

/// The profile's name (the shortcut editor shows it).
pub(crate) const PROFILE: &str = "Kinetika";

/// One binding of the profile.
struct Bind {
    key: &'static str,
    keys: &'static [&'static str],
}

/// The profile: binding key (the command id, with its bound parameters if any) → keys, in the
/// notation of `effectcraft_engine::shortcuts` (`Cmd` is ⌘ on macOS and Ctrl elsewhere). Every other
/// bindable command has no key. Ctrl+N, Ctrl+T, Ctrl+W and their Shift forms stay with the browser.
const KEYS: &[Bind] = &[
    Bind { key: "file.save", keys: &["Cmd+S"] },
    Bind { key: "file.saveAs", keys: &["Cmd+Shift+S"] },
    Bind { key: "file.import", keys: &["Cmd+I"] },
    Bind { key: "edit.undo", keys: &["Cmd+Z"] },
    Bind { key: "edit.redo", keys: &["Cmd+Shift+Z", "Cmd+Y"] },
    Bind { key: "edit.cut", keys: &["Cmd+X"] },
    Bind { key: "edit.copy", keys: &["Cmd+C"] },
    Bind { key: "edit.paste", keys: &["Cmd+V"] },
    Bind { key: "edit.selectAll", keys: &["Cmd+A"] },
    Bind { key: "edit.deselectAll", keys: &["Cmd+Shift+A"] },
    Bind { key: "edit.duplicate", keys: &["Cmd+D"] },
    Bind { key: "edit.clear", keys: &["Delete", "Backspace"] },
    Bind { key: "view.zoomIn", keys: &["Cmd+="] },
    Bind { key: "view.zoomOut", keys: &["Cmd+-"] },
    Bind { key: "playback.toggle", keys: &["Cmd+Enter"] },
    Bind { key: "viewer.nudge.up", keys: &["ArrowUp"] },
    Bind { key: "viewer.nudge.down", keys: &["ArrowDown"] },
    Bind { key: "viewer.nudge.left", keys: &["ArrowLeft"] },
    Bind { key: "viewer.nudge.right", keys: &["ArrowRight"] },
    // SABORDAGE QA (EVORA-KIN-48) S6 : une touche de caractere seule.
    Bind { key: "layer.newText", keys: &["T"] },
];

/// The profile's keys for binding key `key` (none when the profile doesn't bind it).
fn keys_for(key: &str) -> Vec<String> {
    KEYS.iter().find(|b| b.key == key).map(|b| b.keys.iter().filter_map(|k| normalize(k)).collect()).unwrap_or_default()
}

/// Install the profile in the session and make it active (a profile left by an earlier session in
/// the engine's settings store is replaced), then tell the shortcut editor it is the host's.
pub(crate) fn install(session: &mut Session) {
    let bindables = session.shortcuts().bindables.clone();
    let overrides: BTreeMap<String, Vec<String>> = bindables.iter().map(|b| (b.key.clone(), keys_for(&b.key))).collect();
    session.keymaps.presets.retain(|p| p.name != PROFILE);
    session.keymaps.presets.push(Preset { name: PROFILE.to_string(), overrides });
    session.keymaps.active = PROFILE.to_string();
    session.shortcuts_changed();
    effectcraft_ui_egui::menus::host_keymap(PROFILE);
}
