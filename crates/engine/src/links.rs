//! Project links (shown in Help ▸ and by the start screen).
//!
//! Evora (EXC-K1, patch E1): this fork carries no ArtCraft mark and no community link. A modified
//! build must drop the ArtCraft marks (docs/brand/LICENSE-brand.txt): the Discord invite and the
//! getartcraft.com pages are removed, and the app page points at the source repository.

pub const APP_NAME: &str = "EffectCraft";
pub const APP_SLUG: &str = "effectcraft";
pub const GITHUB: &str = "https://github.com/storytold/effectcraft";
pub const APP_PAGE: &str = GITHUB;
pub const ISSUES: &str = "https://github.com/storytold/effectcraft/issues";

/// Sibling apps of the same upstream family: (name, GitHub repo).
pub const SIBLINGS: &[(&str, &str)] = &[
    ("PhotoCraft", "photocraft"),
    ("VectorCraft", "vectorcraft"),
    ("FilmCraft", "filmcraft"),
    ("LightCraft", "lightcraft"),
    ("PdfCraft", "pdfcraft"),
    ("DesignCraft", "designcraft"),
];

pub fn github_of(slug: &str) -> String {
    format!("https://github.com/storytold/{slug}")
}
/// Evora (EXC-K1): a sibling's page is its source repository (no getartcraft.com page).
pub fn page_of(slug: &str) -> String {
    github_of(slug)
}
