//! AEGIS Desktop — Tauri shell over the Cockpit.
//!
//! Phase A scope (current):
//!   - Single main window pointed at the Cockpit (dev URL or bundled
//!     static build).
//!   - System tray with Open / Toggle Protection (stub) / Quit.
//!   - Health pinger placeholder — the real gateway sidecar lands in
//!     Phase A.2 once we settle the Node-binary packaging.
//!
//! Out of scope for Phase A:
//!   - Bundled gateway binary (depends on `pkg`/`nexe` choice).
//!   - Process-level agent discovery (Phase B).
//!   - Auto-updater (Phase D).

use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    Manager,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
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
        .invoke_handler(tauri::generate_handler![greet, gateway_status])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ── IPC commands ───────────────────────────────────────────────────────────

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {name}! AEGIS desktop is running.")
}

/// Probe the embedded gateway. Phase A returns a static placeholder —
/// real impl pings http://localhost:8080/health once the sidecar lands
/// in Phase A.2.
#[tauri::command]
async fn gateway_status() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "status": "not_implemented",
        "note": "gateway sidecar lands in Phase A.2",
    }))
}
