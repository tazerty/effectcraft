//! The app: startup (storage, session restore, hooks), the eframe app and the page glue.

use std::cell::{Cell, RefCell};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use effectcraft_engine::Session;

use crate::{api, audio, browse, diskcache, files, frames, persist, storage, worker};
use effectcraft_ui_egui::EffectcraftApp;
use serde_json::json;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(module = "/js/host.js")]
extern "C" {
    #[wasm_bindgen(js_name = showDeviceLost)]
    fn show_device_lost(message: &str, kept: bool);
}

/// Work for the UI thread with access to the app (posted by async tasks: picked files…).
type Action = Box<dyn FnOnce(&mut EffectcraftApp)>;

static WORKER: AtomicBool = AtomicBool::new(false);

/// Running inside a Web Worker (no page, no downloads).
pub fn is_worker() -> bool {
    WORKER.load(Ordering::Relaxed)
}

pub(crate) fn set_worker() {
    WORKER.store(true, Ordering::Relaxed);
}

/// `rel` resolved against the page's URL (`worker.js`, `audio-worklet.js`); `""` = the page's
/// folder.
pub fn page_url(rel: &str) -> String {
    let href = web_sys::window().and_then(|w| w.location().href().ok()).unwrap_or_default();
    web_sys::Url::new_with_base(if rel.is_empty() { "./" } else { rel }, &href).map(|u| u.href()).unwrap_or_else(|_| rel.to_string())
}

thread_local! {
    static ACTIONS: RefCell<Vec<Action>> = const { RefCell::new(Vec::new()) };
    static CTX: RefCell<Option<egui::Context>> = const { RefCell::new(None) };
    /// Evora (E4): the running app's runner, to carry out posted actions between frames ([`pump`]).
    static RUNNER: RefCell<Option<eframe::WebRunner>> = const { RefCell::new(None) };
    /// Evora (E4): a [`pump`] of the posted actions is scheduled.
    static PUMP: Cell<bool> = const { Cell::new(false) };
}

/// Evora (E4): milliseconds a posted action waits for a UI frame before it is carried out
/// without one.
const PUMP_AFTER_MS: i32 = 100;

/// Run `f` on the UI thread at the next frame. Evora (E4): in the host bridge, also without a
/// frame when none comes soon ([`pump`]).
pub fn post(f: impl FnOnce(&mut EffectcraftApp) + 'static) {
    ACTIONS.with(|a| a.borrow_mut().push(Box::new(f)));
    repaint();
    schedule_pump();
}

/// The egui context of the running app (`None` before it starts).
pub(crate) fn egui_ctx() -> Option<egui::Context> {
    CTX.with(|c| c.borrow().clone())
}

/// Evora (E4): in the host bridge, schedule a [`pump`] (one at a time).
fn schedule_pump() {
    // The bench's witness build (feature `evora-witness`, never in the artefact) waits for frames.
    if cfg!(feature = "evora-witness") || !crate::ehp::hosted() || PUMP.with(Cell::get) {
        return;
    }
    let Some(window) = web_sys::window() else { return };
    let run = Closure::once_into_js(|| {
        PUMP.with(|p| p.set(false));
        pump();
    });
    if window.set_timeout_with_callback_and_timeout_and_arguments_0(run.unchecked_ref(), PUMP_AFTER_MS).is_ok() {
        PUMP.with(|p| p.set(true));
    }
}

/// Evora (E4): carry out the posted actions no frame has taken yet. eframe draws its frames on
/// `requestAnimationFrame` while the page is visible (on a timer once the tab is hidden), and the
/// browser runs no animation frame for an iframe it doesn't paint (`display: none`, off screen),
/// even in a visible tab: the answers to the Evora page (`evora:save`, `evora:ack`) must not wait
/// for it. The `evora:dirty` an action causes is reported too.
fn pump() {
    if ACTIONS.with(|a| a.borrow().is_empty()) {
        return;
    }
    let Some(runner) = RUNNER.with(|r| r.borrow().clone()) else { return };
    // `None` during a frame, after a panic or before the app exists: the next frame takes them.
    let Some(mut web) = runner.app_mut::<WebApp>() else { return };
    let actions = ACTIONS.with(|a| std::mem::take(&mut *a.borrow_mut()));
    for f in actions {
        f(&mut web.app);
    }
    crate::ehp::dirty(web.app.session.is_dirty());
}

/// Ask for a UI frame.
pub fn repaint() {
    CTX.with(|c| {
        if let Some(c) = c.borrow().as_ref() {
            c.request_repaint();
        }
    });
}

/// Open a project or import media from table paths (picked or dropped files).
pub(crate) fn open_or_import(app: &mut EffectcraftApp, paths: Vec<String>) {
    let (projects, media): (Vec<String>, Vec<String>) = paths.into_iter().partition(|p| p.to_ascii_lowercase().ends_with(".ecproj"));
    if let Some(p) = projects.last()
        && let Err(e) = app.session.execute("file.open", json!({"path": p}))
    {
        app.ui.status = e.to_string();
    }
    if !media.is_empty() {
        match app.session.execute("file.import", json!({"paths": media})) {
            Ok(r) => {
                if let Some(errs) = r["errors"].as_array().filter(|e| !e.is_empty()) {
                    app.ui.status = errs.iter().filter_map(|e| e.as_str()).collect::<Vec<_>>().join("; ");
                }
            }
            Err(e) => app.ui.status = e.to_string(),
        }
    }
}

/// The eframe app: the shared EffectCraft UI plus the browser host's per-frame duties.
pub struct WebApp {
    pub app: EffectcraftApp,
    /// Keep the session snapshot (off with `?empty`).
    pub persist: bool,
}

impl eframe::App for WebApp {
    fn raw_input_hook(&mut self, ctx: &egui::Context, raw_input: &mut egui::RawInput) {
        self.app.raw_input_hook(ctx, raw_input);
    }

    /// Evora (E4): lets [`pump`] reach the app between frames (`WebRunner::app_mut`).
    fn as_any_mut(&mut self) -> Option<&mut dyn std::any::Any> {
        Some(&mut *self)
    }

    fn logic(&mut self, ctx: &egui::Context, frame: &mut eframe::Frame) {
        let actions = ACTIONS.with(|a| std::mem::take(&mut *a.borrow_mut()));
        for f in actions {
            f(&mut self.app);
        }
        // Evora (E2, E4): in the host bridge, the settings the Evora page imposes (the theme of
        // `evora:init` and `evora:theme`) apply here, in every pass, not only in a drawn frame:
        // the UI draws nothing once the graphics device is lost (`ui` returns early) and gets no
        // frame while its iframe isn't painted. Once per change (`prefs_revision`).
        if crate::ehp::hosted() {
            self.app.apply_prefs(ctx);
        }
        // Files dropped on the page: read them, then open/import.
        let dropped: Vec<web_sys::File> = ctx.input(|i| i.raw.dropped_files.iter().filter_map(|f| f.web_file().cloned()).collect());
        if !dropped.is_empty() {
            files::read_files(dropped, |paths| post(move |app| open_or_import(app, paths)));
        }
        self.app.logic(ctx, frame);
        api::poll_replies();
        // Render Queue outputs written this frame (here or by a worker) → downloads.
        files::flush_downloads();
        // What a reload comes back to.
        if self.persist {
            persist::snapshot(&self.app.session, ctx.input(|i| i.time), 1.0);
        }
        // Evora (E4): the host hears when its document becomes modified or saved (`evora:dirty`).
        crate::ehp::dirty(self.app.session.is_dirty());
        api::set_info("gpu", json!({"compositor": self.app.gpu_adapter(), "viewerOnGpu": self.app.viewer_on_gpu()}));
        api::set_info("frameWorkers", frames::stats());
        // Settings ▸ Disk ▸ Disk Cache (frames in the Origin Private File System).
        let d = &self.app.session.prefs.disk;
        diskcache::configure(d.disk_cache_enabled, d.disk_cache_max_gb, storage::quota());
        api::set_info("diskCache", diskcache::stats());
    }

    fn ui(&mut self, ui: &mut egui::Ui, frame: &mut eframe::Frame) {
        self.app.ui(ui, frame);
        block_external_links(ui.ctx(), &mut self.app);
    }
}

/// Evora (E7): the engine opens no external page. Help ▸ links (help.docs, help.appPage,
/// help.github, help.onlineTutorials, help.reportIssue, help.sibling), the trained models'
/// project and licence pages, the credits and any hyperlink all end in egui's `OpenUrl` command,
/// which the browser runner turns into `window.open`: they are dropped here, at the end of the
/// frame, before the runner sees them. The Evora shell owns every link out of the editor (and its
/// iframe has no `allow-popups`). The URL is logged and the status line says why nothing opened.
fn block_external_links(ctx: &egui::Context, app: &mut EffectcraftApp) {
    let blocked: Vec<String> = ctx.output_mut(|o| {
        let mut urls = Vec::new();
        o.commands.retain(|c| match c {
            egui::OutputCommand::OpenUrl(open) => {
                urls.push(open.url.clone());
                false
            }
            _ => true,
        });
        urls
    });
    if blocked.is_empty() {
        return;
    }
    for url in &blocked {
        log::info!("Evora build: external link not opened: {url}");
    }
    app.ui.status = "External links are not opened in this editor.".into();
}

fn query() -> Option<web_sys::UrlSearchParams> {
    web_sys::window().and_then(|w| w.location().search().ok()).and_then(|s| web_sys::UrlSearchParams::new_with_str(&s).ok())
}

fn query_flag(name: &str) -> bool {
    query().is_some_and(|p| p.has(name))
}

fn query_value(name: &str) -> Option<String> {
    query().and_then(|p| p.get(name))
}

/// A session wired for the browser: media decoding from memory, expressions, scripting, Render
/// Queue export to downloads, settings in browser storage, renders and analyses in workers.
pub fn session() -> Session {
    let pool = Arc::new(effectcraft_media::MediaPool::new());
    persist::register_media(&pool);
    Session {
        services: Arc::new(files::WebServices),
        footage: pool.clone(),
        importer: Some(Arc::new(files::WebImporter { pool })),
        expr: Some(Arc::new(effectcraft_expr::Expressions)),
        expr_check: Some(effectcraft_expr::check_syntax),
        script: Some(effectcraft_host::script::runner),
        exporter: Some(Arc::new(effectcraft_host::FileExporter { sink: Some(files::export_sink()) })),
        config: Some(Arc::new(persist::config())),
        offload: (!query_flag("noworkers")).then(|| {
            // Job workers render on a WebGPU device of their own (`?nogpuworkers`: their CPU).
            worker::set_job_worker_gpu(!query_flag("nogpuworkers"));
            Arc::new(worker::WorkerOffload) as Arc<dyn effectcraft_engine::offload::Offload>
        }),
        browser: Some(Arc::new(browse::WebBrowser)),
        storage: Some(Arc::new(storage::WebStorage)),
        ..Default::default()
    }
}

/// Evora (E3): an Evora interface language (`?lang=`, one of the platform's 14 codes) as the
/// engine's catalog code. `zh-Hans` (also `zh-cn`, `zh`) → `zh-hans`; fr, de, es, ru, ja and en
/// keep their code; ar, hi, id, it, ko and tr, which the engine has no catalog for, → `en` (the
/// Evora shell shows its banner). `pt` (Evora's Portuguese is Brazilian, campaign decision of
/// 2026-10-27) and `pt-br` → `pt-br`. Anything else → none. The host bridge (E4) maps
/// `evora:init` and `evora:lang`'s `engineLang` through it too.
pub(crate) fn evora_language(code: &str) -> Option<&'static str> {
    match code.trim().to_ascii_lowercase().as_str() {
        "en" => Some("en"),
        "fr" => Some("fr"),
        "de" => Some("de"),
        "es" => Some("es"),
        "ru" => Some("ru"),
        "ja" => Some("ja"),
        "zh-hans" | "zh-cn" | "zh" => Some("zh-hans"),
        "pt" | "pt-br" => Some("pt-br"),
        "ar" | "hi" | "id" | "it" | "ko" | "tr" => Some("en"),
        _ => None,
    }
}

/// Browser file pickers in place of the desktop's file dialogs.
fn install_hooks(app: &mut EffectcraftApp) {
    app.hooks.pick_files = Some(Box::new(|exts: &[&str]| {
        let accept = exts.iter().map(|e| format!(".{e}")).collect::<Vec<_>>().join(",");
        if let Err(e) = files::pick(&accept, true, |paths| post(move |app| open_or_import(app, paths))) {
            log::warn!("file picker: {e:?}");
        }
        // the import happens when the browser hands over the files
        Vec::new()
    }));
    app.hooks.pick_open_project = Some(Box::new(|| {
        if let Err(e) = files::pick(".ecproj", false, |paths| post(move |app| open_or_import(app, paths))) {
            log::warn!("file picker: {e:?}");
        }
        None
    }));
    // Saving downloads the file: the chosen name is all a "save dialog" needs.
    app.hooks.pick_save = Some(Box::new(|name: &str| Some(files::path_for(if name.is_empty() { "Untitled Project.ecproj" } else { name }))));
    app.hooks.audio_device = Some(Box::new(audio::open));
    app.hooks.audio_devices = Some(Box::new(|| vec!["Browser default output".into()]));
}

/// Entry point (called by the page's bootstrap script once the wasm module is instantiated).
#[wasm_bindgen]
pub async fn start(canvas_id: String) -> Result<(), JsValue> {
    eframe::WebLogger::init(log::LevelFilter::Info).ok();
    // Match System follows `?lang=` in the address, then the browser's languages; a language
    // chosen in Settings still wins.
    let navigator = web_sys::window().map(|w| w.navigator());
    let browser = navigator.iter().flat_map(|n| n.languages().iter().filter_map(|v| v.as_string()).collect::<Vec<_>>());
    effectcraft_ui_egui::i18n::set_system_locales(query_value("lang"), browser.collect());
    let doc = web_sys::window().and_then(|w| w.document()).ok_or("no document")?;
    let canvas: web_sys::HtmlCanvasElement = doc.get_element_by_id(&canvas_id).ok_or("no canvas")?.dyn_into()?;
    let empty = query_flag("empty");
    let home = query_flag("home");
    // Evora (E4, E5): with `?host=evora` the engine first announces itself (`evora:ready`) to the
    // parent page `evora-host.json` admits and waits for its `evora:init`, before it touches
    // browser storage. The storage namespace comes from that message only (never from the URL);
    // the other namespaces' stores and the un-namespaced ones are deleted before the engine opens
    // its own. Without an admitted parent, without a namespace or in the memory mode
    // (`?storage=memory`), the engine keeps nothing in browser storage. Without `?host=evora`
    // nothing changes.
    let host = query_value("host").as_deref() == Some("evora");
    let memory = query_value("storage").as_deref() == Some("memory");
    let boot = if host { crate::ehp::boot(memory).await } else { None };
    if host {
        let ns = boot.as_ref().and_then(|b| b.storage_ns.clone()).unwrap_or_default();
        let purge = boot.as_ref().is_some_and(|b| b.purge);
        crate::ehp::prepare_storage(ns, !memory, purge).await;
    }
    // Browser storage: settings, recent projects, imported media, saved projects, auto-saves and
    // the last session come back.
    let t0 = js_sys::Date::now();
    let stored = match persist::load(&query_value("storage").unwrap_or_default()).await {
        Ok(n) => n,
        Err(e) => {
            log::warn!("browser storage unavailable: {e}");
            0
        }
    };
    api::set_info("storage", json!({"backend": persist::backend(), "entries": stored, "loadMs": js_sys::Date::now() - t0}));
    audio::install_unlock();
    browse::restore();
    // Evora (E4): no disk cache folder when the host turns the cache off (`evora:init.prefs`).
    if boot.as_ref().and_then(|b| b.disk_cache) != Some(false) {
        diskcache::init();
    }
    storage::refresh();
    let runner = eframe::WebRunner::new();
    let started = runner
        .start(
            canvas,
            eframe::WebOptions::default(),
            Box::new(move |cc| {
                CTX.with(|c| *c.borrow_mut() = Some(cc.egui_ctx.clone()));
                // The page owns this shared presentation device; worker devices retain their
                // separate owned-device handlers. No browser error-scope future is blocked on.
                let gpu_failures = effectcraft_ui_egui::gpu_failure::GpuFailureBridge::new(&cc.egui_ctx);
                if let Some(rs) = &cc.wgpu_render_state {
                    let errors = gpu_failures.clone();
                    rs.device.on_uncaptured_error(Arc::new(move |error| {
                        let message = format!("uncaptured GPU error: {error}");
                        if errors.report(&message, false) {
                            log::error!("{message}");
                        }
                    }));
                    // The canvas can't present any more (#225): the page says so over it and
                    // offers a reload, which brings the session back when browser storage keeps it.
                    let lost = gpu_failures.clone();
                    let kept = !empty && persist::backend() != "memory";
                    rs.device.set_device_lost_callback(move |reason, message| {
                        let message = format!("GPU device lost ({reason:?}): {message}");
                        lost.report(&message, true);
                        show_device_lost(&message, kept);
                    });
                }
                let mut session = session();
                session.load_settings();
                // Evora (E3): the interface language imposed by the host page (`?lang=`), set
                // before the first frame so the editor never shows English first. Not saved.
                if let Some(language) = query_value("lang").as_deref().and_then(evora_language) {
                    session.prefs.general.language = language.to_string();
                }
                // Evora (E2): the light or dark appearance imposed by the host page
                // (`?theme=light|dark`), before the first frame. Not saved.
                if let Some(mode) = query_value("theme").filter(|m| m == "light" || m == "dark") {
                    session.prefs.appearance.appearance_mode = mode;
                }
                // Evora (E4): what `evora:init` imposes (language, theme, disk cache). Not saved.
                if let Some(b) = &boot {
                    crate::ehp::apply_init(&mut session, b);
                }
                let recovery = session.begin_recovery();
                // `?empty`: a blank project; `?demo`: the demo project; otherwise the last visit's
                // project (the demo on a first visit).
                let restored = !empty && !query_flag("demo") && persist::restore(&mut session);
                if !restored && !empty {
                    let _ = session.execute("file.openDemoProject", json!({}));
                }
                api::set_info("restored", json!(restored));
                // The ScriptUI panels open on the last visit open again.
                let _ = session.execute("window.restoreScriptPanels", json!({}));
                let mut app = EffectcraftApp::new(session);
                app.set_gpu_failure_bridge(gpu_failures);
                app.ui.start_screen = home;
                if let Some(r) = recovery.filter(|r| !restored && r.autosave.is_some()) {
                    app.offer_recovery(r);
                }
                install_hooks(&mut app);
                // Viewer frames render in frame workers (`?frameworkers=N`, 0 or `?noworkers`:
                // on the page's thread), each on its own WebGPU device where the browser has
                // WebGPU in workers (`?nogpuworkers`: their CPU).
                let n = if query_flag("noworkers") { 0 } else { query_value("frameworkers").and_then(|v| v.parse().ok()).unwrap_or(2usize).min(8) };
                if n > 0 {
                    app.frames.set_remote(Some(Arc::new(frames::WebFrames::start(n, !query_flag("nogpuworkers")))));
                }
                app.frames.set_virtual_media(files::STORE.media_epoch(), Arc::new(|path| files::STORE.file_identity(path)));
                let (tx, rx) = std::sync::mpsc::channel();
                api::set_sender(tx);
                app = app.with_control(rx);
                let backend = cc.wgpu_render_state.as_ref().map(|rs| format!("{:?}", rs.adapter.get_info().backend));
                api::set_info("backend", json!(backend));
                Ok(Box::new(WebApp { app, persist: !empty }))
            }),
        )
        .await;
    if let Err(e) = started {
        // Evora (E4): `evora:failed {code}` to an admitted host.
        if host {
            crate::ehp::failed(&e);
        }
        return Err(e);
    }
    // Evora (E4): the editor runs with what `evora:init` set: accept it (`evora:ack`). The
    // posted actions may run between frames from now on (actions posted before: pumped now).
    if host {
        RUNNER.with(|r| *r.borrow_mut() = Some(runner.clone()));
        schedule_pump();
        crate::ehp::init_applied();
    }
    // Hide the loading message once the app runs.
    if let Some(el) = doc.get_element_by_id("loading") {
        el.remove();
    }
    Ok(())
}
