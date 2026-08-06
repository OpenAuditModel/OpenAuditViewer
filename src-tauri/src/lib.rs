use tauri::{
    plugin::{Builder as PluginBuilder, TauriPlugin},
    Runtime,
};

/// Keeps the webview inside the bundled app.
///
/// The webview renders untrusted log content, so it must never be able to
/// navigate somewhere else — a page that could redirect itself would carry
/// the window's IPC access with it. External links are unaffected: the
/// opener plugin hands them to the system browser rather than navigating
/// this webview.
///
/// Windows serves the production bundle from `http://tauri.localhost`,
/// other platforms from `tauri://`; `npm run tauri dev` serves it from
/// `http://localhost:1420`.
fn navigation_guard<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::new("navigation-guard")
        .on_navigation(|_webview, url| {
            let host = url.host_str().unwrap_or("");
            url.scheme() == "tauri" || host == "tauri.localhost" || host == "localhost"
        })
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(navigation_guard())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
