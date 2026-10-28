//! Evora (KIN-FK-B2, Q-K19 (a), divergence D-1 of CR-13): the keyboard shortcut profile of Evora's
//! editor, « Kinetika », installed by the host bridge, then kept as the member leaves it.
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
//!
//! The member's keys are theirs (correction 1 of KIN-FK-B2): the profile is installed, and made
//! active, when the engine's settings store has none (the first start) or when upstream's preset is
//! active; afterwards the stored profile, its copies and the preset the member made active are kept
//! as they are. Three rules keep that true:
//! - every key the member records is written out ([`keep`]): the engine drops an override equal to
//!   upstream's default keys (`Keymaps::set`), and a command missing from a stored preset is read at
//!   the next start as a command that preset never knew;
//! - a command a stored preset never knew (an engine update brought it) gets the profile's keys at
//!   the start ([`install`]), never upstream's;
//! - upstream's keys never come back under the host: an emptied preset (Reset Preset, a new preset)
//!   gets the profile's keys, and upstream's preset, which the shortcut editor doesn't offer, never
//!   stays active ([`keep`]).

use std::cell::RefCell;
use std::collections::BTreeMap;

use effectcraft_engine::Session;
use effectcraft_engine::shortcuts::{DEFAULT_PRESET, Keymaps, Preset, normalize};

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
];

/// The profile's keys for binding key `key` (none when the profile doesn't bind it).
fn keys_for(key: &str) -> Vec<String> {
    KEYS.iter().find(|b| b.key == key).map(|b| b.keys.iter().filter_map(|k| normalize(k)).collect()).unwrap_or_default()
}

/// What the bridge keeps between frames: the profile's keys and upstream's default keys of every
/// bindable command, and the signature of the presets as last settled.
struct Kept {
    /// The profile as Evora writes it (every bindable command: its keys or none).
    base: BTreeMap<String, Vec<String>>,
    /// Upstream's default keys of every bindable command: what an override the engine dropped means.
    defaults: Vec<(String, Vec<String>)>,
    active: String,
    presets: usize,
    entries: usize,
}

thread_local! {
    /// Set by [`install`] (the editor runs under the host); `None` otherwise.
    static KEPT: RefCell<Option<Kept>> = const { RefCell::new(None) };
}

/// The number of presets and of their overrides: every change that can leave a command implicit
/// (an override dropped, a preset emptied or added) changes it.
fn signature(k: &Keymaps) -> (usize, usize) {
    (k.presets.len(), k.presets.iter().map(|p| p.overrides.len()).sum())
}

fn remember(kept: &mut Kept, k: &Keymaps) {
    kept.active.clone_from(&k.active);
    (kept.presets, kept.entries) = signature(k);
}

/// The presets made right under the host; whether anything changed. `start`: the editor starts (a
/// command missing from a stored preset is one it never knew: the profile's keys); otherwise the
/// presets just changed (a missing command is one whose override the engine dropped because the
/// member recorded upstream's keys: those keys, written out).
fn settle(k: &mut Keymaps, kept: &Kept, start: bool) -> bool {
    let mut changed = false;
    // Upstream's preset is never active under the host (the shortcut editor doesn't offer it), nor a
    // preset that is gone: the profile is, installed when it isn't there (the first start).
    let gone = !k.presets.iter().any(|p| p.name == k.active);
    let upstream = k.active == DEFAULT_PRESET || gone;
    if (start || upstream) && !k.presets.iter().any(|p| p.name == PROFILE) {
        k.presets.push(Preset { name: PROFILE.to_string(), overrides: kept.base.clone() });
        changed = true;
    }
    if upstream {
        k.active = PROFILE.to_string();
        changed = true;
    }
    for p in &mut k.presets {
        // An emptied preset (Reset Preset, a new preset) gets the profile's keys, never upstream's.
        if p.overrides.is_empty() {
            p.overrides = kept.base.clone();
            changed = true;
            continue;
        }
        for (key, defaults) in &kept.defaults {
            if !p.overrides.contains_key(key) {
                let keys = if start { kept.base.get(key).cloned().unwrap_or_default() } else { defaults.clone() };
                p.overrides.insert(key.clone(), keys);
                changed = true;
            }
        }
    }
    changed
}

/// Install the profile when the settings store has none, and settle the stored presets (see the
/// module's notes), then tell the shortcut editor the profile is the host's. Called once, before the
/// first frame, after the engine's settings are loaded.
pub(crate) fn install(session: &mut Session) {
    let defaults: Vec<(String, Vec<String>)> = session.shortcuts().bindables.iter().map(|b| (b.key.clone(), b.defaults.clone())).collect();
    let base: BTreeMap<String, Vec<String>> = defaults.iter().map(|(key, _)| (key.clone(), keys_for(key))).collect();
    let mut kept = Kept { base, defaults, active: String::new(), presets: 0, entries: 0 };
    if settle(&mut session.keymaps, &kept, true) {
        session.shortcuts_changed();
    }
    remember(&mut kept, &session.keymaps);
    KEPT.with(|cell| *cell.borrow_mut() = Some(kept));
    effectcraft_ui_egui::menus::host_keymap(PROFILE);
}

/// Every frame (`ehp::dirty`): once the presets changed (the shortcut editor, a script), what the
/// engine left implicit is written out and upstream's keys are kept out; nothing otherwise.
pub(crate) fn keep(session: &mut Session) {
    KEPT.with(|cell| {
        let mut cell = cell.borrow_mut();
        let Some(kept) = cell.as_mut() else { return };
        if session.keymaps.active == kept.active && signature(&session.keymaps) == (kept.presets, kept.entries) {
            return;
        }
        if settle(&mut session.keymaps, kept, false) {
            session.shortcuts_changed();
        }
        remember(kept, &session.keymaps);
    });
}
