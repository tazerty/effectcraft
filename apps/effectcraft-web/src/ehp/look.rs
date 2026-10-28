//! Evora (KIN-FK-B2, E2-KIN): the palette the engine shows under Evora's editor, reported as
//! `effectcraft.info().evoraTheme` for the CI bench and diagnostics (the theme kind, the
//! surfaces, the text colours, the accent and its shades, gradients, radii), once per change.

use std::cell::Cell;

use effectcraft_ui_egui::theme::{Tokens, host_accent};
use egui::Color32;
use serde_json::json;

thread_local! {
    static SHOWN: Cell<Option<Tokens>> = const { Cell::new(None) };
}

fn hex(c: Color32) -> String {
    format!("#{:02x}{:02x}{:02x}", c.r(), c.g(), c.b())
}

/// Report the palette `t` the editor shows (called every pass in the host bridge).
pub(crate) fn report(t: &Tokens) {
    if SHOWN.with(Cell::get) == Some(*t) {
        return;
    }
    SHOWN.with(|s| s.set(Some(*t)));
    crate::api::set_info(
        "evoraTheme",
        json!({
            "kind": t.kind.name(),
            "hostAccent": host_accent().map(hex),
            "appBg": hex(t.app_bg),
            "headerBg": hex(t.header_bg),
            "panelBg": hex(t.panel_bg),
            "row": hex(t.row),
            "rowAlt": hex(t.row_alt),
            "rowSelected": hex(t.row_selected),
            "fieldBg": hex(t.field_bg),
            "fieldBorder": hex(t.field_border),
            "hover": hex(t.hover),
            "pressed": hex(t.pressed),
            "text": hex(t.text),
            "textDim": hex(t.text_dim),
            "textFaint": hex(t.text_faint),
            "hotText": hex(t.hot_text),
            "timecode": hex(t.timecode),
            "tlBg": hex(t.tl_bg),
            "cti": hex(t.cti),
            "keyframe": hex(t.keyframe),
            "keyframeSelected": hex(t.keyframe_selected),
            "pasteboard": hex(t.pasteboard),
            "accent": hex(t.accent),
            "accentHover": hex(t.accent_hover),
            "focus": hex(t.focus),
            "gradients": t.gradients,
            "radius": t.radius,
            "radiusSm": t.radius_sm,
        }),
    );
}
