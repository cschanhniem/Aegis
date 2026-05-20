//! AEGIS Desktop — Tauri shell over the Cockpit.
//!
//! Dev (`cargo tauri dev`): WebView loads `http://localhost:3000` (the
//! Cockpit dev server) — user runs the gateway and cockpit themselves.
//!
//! Release (`cargo tauri build`): spawn the embedded gateway + cockpit
//! Node servers from sidecar-stage/, wait for both ports to bind, then
//! redirect the WebView at `http://127.0.0.1:13001` and reveal the
//! window. Killed via Drop on app exit.

mod scanner;
mod sidecars;
#[cfg(not(debug_assertions))]
use sidecars::{Sidecars, COCKPIT_URL};
#[cfg(debug_assertions)]
use sidecars::Sidecars;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // ── Spawn the embedded gateway + cockpit in release builds.
            //    In dev we let the user run them — devUrl in tauri.conf.json
            //    already points at the Cockpit dev server (:3000).
            #[cfg(not(debug_assertions))]
            {
                let handle = app.handle();
                let sidecars = Sidecars::spawn_all(handle)
                    .map_err(|e| format!("failed to start AEGIS sidecars: {e}"))?;

                // Redirect the auto-opened (placeholder) window at the
                // spawned Cockpit, then reveal it.
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.eval(&format!(
                        "window.location.replace('{COCKPIT_URL}')",
                    ));
                    let _ = window.show();
                    let _ = window.set_focus();
                }

                app.manage(sidecars);
            }

            // ── System tray ──────────────────────────────────────────────
            let open_item = MenuItem::with_id(app, "open", "Open AEGIS", true, None::<&str>)?;
            let toggle_item = MenuItem::with_id(
                app,
                "toggle_protection",
                "Toggle protection (stub)",
                true,
                None::<&str>,
            )?;
            let separator_label =
                MenuItem::with_id(app, "label_status", "Status: gateway not detected", false, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit AEGIS", true, None::<&str>)?;

            let menu = Menu::with_items(
                app,
                &[&separator_label, &open_item, &toggle_item, &quit_item],
            )?;

            let _tray = TrayIconBuilder::with_id("main-tray")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("AEGIS — runtime safety layer")
                .icon(app.default_window_icon().unwrap().clone())
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "toggle_protection" => {
                        // TODO: wire to kill-switch endpoint once gateway sidecar lands
                        println!("[tray] toggle_protection clicked");
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { .. } = event {
                        if let Some(app) = tray.app_handle().get_webview_window("main") {
                            let _ = app.show();
                            let _ = app.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Kill spawned sidecars when the user closes the main window.
            if matches!(event, WindowEvent::CloseRequested { .. }) {
                if let Some(state) = window.app_handle().try_state::<Sidecars>() {
                    state.kill_all();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![greet, gateway_url, list_candidate_agents])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ── IPC commands ───────────────────────────────────────────────────────────

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {name}! AEGIS desktop is running.")
}

/// Scan running processes for agent-shaped candidates that are NOT
/// already wired through AEGIS. Heuristic — see scanner.rs.
#[tauri::command]
fn list_candidate_agents() -> Vec<scanner::CandidateAgent> {
    scanner::scan()
}

/// Tell the WebView which URL the embedded gateway is reachable at.
/// Cockpit code can call this via `window.__TAURI__.core.invoke('gateway_url')`
/// instead of hard-coding 8080 vs 18080 vs whatever the dev value is.
#[tauri::command]
fn gateway_url() -> String {
    #[cfg(debug_assertions)]
    {
        "http://localhost:8080".into()
    }
    #[cfg(not(debug_assertions))]
    {
        sidecars::GATEWAY_URL.into()
    }
}
