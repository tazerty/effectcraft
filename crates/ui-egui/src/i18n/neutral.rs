//! Evora (patch E9): the display-name override catalogue ("catalogue de surcharge d'affichage").
//!
//! Third-party product and company names that the upstream interface shows (Adobe, Premiere Pro,
//! Lumetri) are replaced on screen by neutral terms, after translation, in every language,
//! English included. The rules apply where the interface draws text: [`super::tr`] and
//! [`super::tr_args`] (panels, dialogs, forms, tooltips), the menu labels
//! (`menus::entry_label`), the panel tabs, the effect names of the Effects & Presets panel, the
//! Effect Controls headers, the Timeline's group rows and the status line. Nothing below
//! `ui-egui` changes: effect ids, match names, project files and the engine's own labels keep the
//! upstream text (apps/kinetika/UPSTREAM.md §6.1; the wording may change with decision D-16).
//!
//! Lightroom, Acrobat, Cycore and "Premiere Pro Compatible" do not occur in this repository (the
//! CI audit, `.github/evora/gates.py terms`, measures them); the rules cover what does. That audit
//! reads [`RULES`] from this file, applies them to every displayed string literal and fails if a
//! term is left.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// The terms the rules remove; a string without any of them is shown unchanged (fast path).
const TERMS: [&str; 3] = ["Adobe", "Premiere", "Lumetri"];

/// (as written, shown instead), applied in this order: longer phrases first, then the generic
/// fallbacks that catch the translated catalogs.
pub(crate) const RULES: &[(&str, &str)] = &[
    // File ▸ Import / Export ▸ Adobe Premiere Pro Project… (menus, form title, every language).
    ("Export Adobe Premiere Pro Project", "Export FCP XML Project"),
    ("Adobe Premiere Pro", "FCP XML"),
    // The export form and the engine's messages about it.
    ("Final Cut Pro XML (.xml) – Premiere Pro", "Final Cut Pro XML (.xml)"),
    ("Final Cut Pro XML (Premiere Pro)", "Final Cut Pro XML"),
    ("which Premiere Pro opens", "which video editors open"),
    ("Layers Premiere can't show", "Layers a video editor can't show"),
    ("import it in Premiere Pro with", "import it in a video editor with"),
    ("native Premiere Pro projects", "native video editor projects"),
    ("in Premiere Pro use", "in the video editor use"),
    ("Premiere Pro", "video editor"),
    ("Premiere", "video editor"),
    // Project Settings ▸ Color Engine, and its translations.
    ("Adobe-style built-in", "Built-in (classic)"),
    ("Adobe 风格内置", "经典内置"),
    ("Вбудований у стилі Adobe", "Вбудований (класичний)"),
    ("Vestavěné ve stylu Adobe", "Vestavěné (klasické)"),
    ("Adobe After Effects", "After Effects"),
    ("Adobe", "classic"),
    // The colour-grading effect and its scopes panel.
    ("Lumetri Color", "Color Grading"),
    ("Lumetri Scopes", "Color Scopes"),
    ("Lumetri", "Color"),
];

/// `text` as the interface shows it: borrowed, without allocating, when no rule applies.
pub(crate) fn neutral(text: &str) -> Cow<'_, str> {
    if !TERMS.iter().any(|t| text.contains(t)) {
        return Cow::Borrowed(text);
    }
    let mut out = text.to_string();
    for (from, to) in RULES {
        if out.contains(from) {
            out = out.replace(from, to);
        }
    }
    Cow::Owned(out)
}

/// [`neutral`] for an owned label (menu entries, tab titles): the same `String` when no rule applies.
pub(crate) fn neutral_owned(text: String) -> String {
    let replaced = match neutral(&text) {
        Cow::Owned(s) => Some(s),
        Cow::Borrowed(_) => None,
    };
    replaced.unwrap_or(text)
}

/// [`neutral`] for the `&str` that [`super::tr`] returns: a rewritten string is built once and kept
/// for the session (the catalogs and engine labels it sees are a finite set).
pub(crate) fn neutral_str(text: &str) -> &str {
    let Cow::Owned(rewritten) = neutral(text) else { return text };
    static CACHE: OnceLock<Mutex<HashMap<String, &'static str>>> = OnceLock::new();
    let Ok(mut cache) = CACHE.get_or_init(Default::default).lock() else { return text };
    if let Some(shown) = cache.get(text) {
        return *shown;
    }
    let shown: &'static str = Box::leak(rewritten.into_boxed_str());
    cache.insert(text.to_string(), shown);
    shown
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rules_neutralise_the_upstream_terms() {
        assert_eq!(neutral("Adobe Premiere Pro Project..."), "FCP XML Project...");
        assert_eq!(neutral("Export Adobe Premiere Pro Project"), "Export FCP XML Project");
        assert_eq!(neutral("Lumetri Color"), "Color Grading");
        assert_eq!(neutral("Lumetri Scopes"), "Color Scopes");
        assert_eq!(neutral("Adobe-style built-in"), "Built-in (classic)");
        assert_eq!(neutral("Projet Adobe Premiere Pro..."), "Projet FCP XML...");
        assert!(matches!(neutral("Gaussian Blur"), Cow::Borrowed(_)));
        for (from, _) in RULES {
            assert!(TERMS.iter().any(|t| from.contains(t)), "{from} has no term: the fast path would skip it");
            assert!(!TERMS.iter().any(|t| neutral(from).contains(t)), "{from} keeps a term");
        }
    }
}
