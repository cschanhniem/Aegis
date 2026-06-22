//! Tauri commands that bridge the JS-side repo-onboarding wizard to the
//! bundled Node tools (tools/repo-scanner + tools/codemod-inject).
//!
//! Why shell out instead of re-implementing in Rust:
//!   - The Node tools are the source of truth (tested + dogfooded).
//!   - Customers running `agentguard scan` from a terminal get bit-for-bit
//!     the same behaviour as the desktop button.
//!   - Keeps the Rust crate slim. No regex / AST parsing duplicated.
//!
//! Resource layout (release builds):
//!   resource_dir/
//!     node-runtime/bin/node          ← portable Node we ship
//!     tools/repo-scanner/index.mjs   ← staged by prepare-sidecars.mjs
//!     tools/codemod-inject/index.mjs
//!
//! Dev builds: use system `node` and read tools from REPO_ROOT/tools/.

use std::path::PathBuf;
use std::process::Command;
use std::io::Write;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Serialize)]
pub struct ToolResult {
    pub ok: bool,
    /// JSON body parsed from the Node script's stdout when it returns
    /// structured data. For the scanner this is the full report; for the
    /// injector it's `{ mode, results }`.
    pub data: Option<serde_json::Value>,
    /// Captured stderr — surfaced to the UI verbatim for diagnostics.
    pub stderr: String,
    /// Exit code of the spawned Node process.
    pub exit_code: i32,
}

fn node_binary(app: &AppHandle) -> PathBuf {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        return PathBuf::from("node");
    }
    #[cfg(not(debug_assertions))]
    {
        if let Ok(dir) = app.path().resource_dir() {
            let bundled = dir.join("node-runtime/bin/node");
            if bundled.exists() { return bundled; }
        }
        PathBuf::from("node")
    }
}

fn tool_path(app: &AppHandle, tool: &str) -> PathBuf {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        // Look for the repo root by walking up from CARGO_MANIFEST_DIR.
        // src-tauri lives at apps/desktop/src-tauri, so up three is repo root.
        let manifest = env!("CARGO_MANIFEST_DIR");
        let repo_root = PathBuf::from(manifest)
            .ancestors()
            .nth(3)
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        return repo_root.join("tools").join(tool).join("index.mjs");
    }
    #[cfg(not(debug_assertions))]
    {
        if let Ok(dir) = app.path().resource_dir() {
            return dir.join("tools").join(tool).join("index.mjs");
        }
        PathBuf::from("tools").join(tool).join("index.mjs")
    }
}

fn run_node(app: &AppHandle, script: PathBuf, args: &[&str]) -> ToolResult {
    if !script.exists() {
        return ToolResult {
            ok: false,
            data: None,
            stderr: format!("tool script not found at {}", script.display()),
            exit_code: -1,
        };
    }
    let node = node_binary(app);
    let mut cmd = Command::new(&node);
    cmd.arg(&script);
    for a in args { cmd.arg(a); }
    match cmd.output() {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            // Try direct parse, then fall back to last JSON-looking line —
            // both scanner and injector emit a JSON line at the end of
            // their stdout when run without --json (and exclusive JSON in
            // --json mode).
            let parsed = parse_last_json(&stdout);
            ToolResult {
                ok: out.status.success(),
                data: parsed,
                stderr,
                exit_code: out.status.code().unwrap_or(-1),
            }
        }
        Err(e) => ToolResult {
            ok: false,
            data: None,
            stderr: format!("failed to spawn node: {e}"),
            exit_code: -1,
        },
    }
}

fn parse_last_json(stdout: &str) -> Option<serde_json::Value> {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(stdout.trim()) {
        return Some(v);
    }
    for line in stdout.lines().rev() {
        let t = line.trim();
        if !t.starts_with('{') { continue; }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(t) {
            return Some(v);
        }
    }
    None
}

#[derive(Debug, Deserialize)]
pub struct ScanOptions {
    pub path: String,
    pub include_tests: Option<bool>,
    pub max_files: Option<u32>,
}

/// Scan a local directory using the bundled repo-scanner. Returns the
/// full JSON report ready for the Cockpit wizard. Used by the
/// "Choose folder…" button in the repo-onboarding flow.
#[tauri::command]
pub fn aegis_scan_repo(app: AppHandle, options: ScanOptions) -> ToolResult {
    let mut args: Vec<String> = vec![options.path, "--json".to_string()];
    if options.include_tests.unwrap_or(false) {
        args.push("--include-tests".to_string());
    }
    if let Some(m) = options.max_files {
        args.push("--max-files".to_string());
        args.push(m.to_string());
    }
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run_node(&app, tool_path(&app, "repo-scanner"), &arg_refs)
}

#[derive(Debug, Deserialize)]
pub struct InjectOptions {
    /// Full scanner-report JSON, serialized by the JS side (so Rust never
    /// touches the wire shape).
    pub report_json: String,
    /// One of "dry-run" | "write" | "revert".
    pub mode: String,
    pub gateway: String,
    pub api_key: Option<String>,
    pub only_entry_points: Option<bool>,
    pub include_protected: Option<bool>,
}

/// Inject the AEGIS bootstrap snippet (or revert) into files identified
/// by the scanner report. Writes the report to a temp file on disk,
/// hands it to codemod-inject, and cleans up afterward.
#[tauri::command]
pub fn aegis_inject_repo(app: AppHandle, options: InjectOptions) -> ToolResult {
    let app_data = match app.path().app_data_dir() {
        Ok(p) => p,
        Err(e) => return ToolResult {
            ok: false, data: None, stderr: format!("app_data_dir: {e}"), exit_code: -1,
        },
    };
    if let Err(e) = std::fs::create_dir_all(&app_data) {
        return ToolResult {
            ok: false, data: None, stderr: format!("create app data dir: {e}"), exit_code: -1,
        };
    }
    let temp = app_data.join(format!("aegis-scan-{}.json", std::process::id()));
    if let Err(e) = std::fs::File::create(&temp).and_then(|mut f| f.write_all(options.report_json.as_bytes())) {
        return ToolResult {
            ok: false, data: None, stderr: format!("write temp report: {e}"), exit_code: -1,
        };
    }

    let mut args: Vec<String> = vec![
        "--report".to_string(), temp.to_string_lossy().to_string(),
        "--gateway".to_string(), options.gateway,
    ];
    if let Some(k) = options.api_key {
        if !k.is_empty() {
            args.push("--api-key".to_string());
            args.push(k);
        }
    }
    if options.only_entry_points.unwrap_or(false) { args.push("--only-entry-points".to_string()); }
    if options.include_protected.unwrap_or(false) { args.push("--include-protected".to_string()); }
    match options.mode.as_str() {
        "write"  => args.push("--write".to_string()),
        "revert" => args.push("--revert".to_string()),
        // "dry-run" is the default, no flag needed
        _ => {}
    }

    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let result = run_node(&app, tool_path(&app, "codemod-inject"), &arg_refs);
    let _ = std::fs::remove_file(&temp);
    result
}

/// Confirm at startup that the WebView is running inside Tauri.
/// JS calls this with `try { await invoke('aegis_runtime_check') } catch {…}` —
/// success means the native command path is available, otherwise the
/// wizard falls back to its file-upload UI.
#[tauri::command]
pub fn aegis_runtime_check() -> &'static str {
    "tauri"
}
