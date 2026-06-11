/**
 * Tauri runtime bridge. Importing this module is safe in browser-only
 * builds — `isTauri()` returns false and every helper short-circuits.
 *
 * In a Tauri WebView, calls go through `window.__TAURI__.core.invoke` /
 * `window.__TAURI__.dialog.*` (exposed via `withGlobalTauri: true`).
 */

interface InvokeArgs { [k: string]: unknown }

function tauriHandle(): any | null {
  if (typeof window === 'undefined') return null
  return (window as any).__TAURI__ ?? null
}

export function isTauri(): boolean {
  return !!tauriHandle()?.core?.invoke
}

export async function invoke<T = unknown>(cmd: string, args?: InvokeArgs): Promise<T> {
  const h = tauriHandle()
  if (!h?.core?.invoke) throw new Error('not running inside Tauri')
  return h.core.invoke(cmd, args) as Promise<T>
}

/** Opens the native folder picker. Returns the selected absolute path,
 *  or null if the user cancelled. Works when the dialog plugin is
 *  registered (it is, in this app) AND withGlobalTauri = true. */
export async function pickDirectory(opts?: { defaultPath?: string }): Promise<string | null> {
  const h = tauriHandle()
  if (!h) throw new Error('not running inside Tauri')
  // Prefer the v2 dialog plugin's JS bridge when available, else
  // fall through to invoking the plugin command directly.
  if (h.dialog?.open) {
    const r = await h.dialog.open({ directory: true, multiple: false, defaultPath: opts?.defaultPath })
    return typeof r === 'string' ? r : null
  }
  // Tauri v2 plugin-invoke form: `plugin:<id>|<command>`
  const r = await invoke<string | null>('plugin:dialog|open', {
    options: { directory: true, multiple: false, defaultPath: opts?.defaultPath },
  })
  return r ?? null
}

// ── Typed wrappers for the AEGIS-specific commands ──────────────────────
export interface ToolResult<T = any> {
  ok: boolean
  data: T | null
  stderr: string
  exit_code: number
}

export interface ScanReport {
  root: string
  scanned_at: string
  files_scanned: number
  repo: { repo_name?: string; version?: string; owner_email?: string }
  candidates: any[]
  summary: { total: number; entry_points: number; already_protected: number; by_framework: Record<string, number> }
}

export function aegisScanRepo(path: string, opts: { includeTests?: boolean; maxFiles?: number } = {}): Promise<ToolResult<ScanReport>> {
  return invoke<ToolResult<ScanReport>>('aegis_scan_repo', {
    options: { path, include_tests: opts.includeTests, max_files: opts.maxFiles },
  })
}

export interface InjectResults {
  mode: 'dry-run' | 'write' | 'revert'
  results: Array<{ ok: boolean; file?: string; skipped?: boolean; reason?: string; diff?: string; agentId?: string; error?: string }>
}

export function aegisInjectRepo(args: {
  reportJson: string
  mode: 'dry-run' | 'write' | 'revert'
  gateway: string
  apiKey?: string
  onlyEntryPoints?: boolean
  includeProtected?: boolean
}): Promise<ToolResult<InjectResults>> {
  return invoke<ToolResult<InjectResults>>('aegis_inject_repo', {
    options: {
      report_json: args.reportJson,
      mode: args.mode,
      gateway: args.gateway,
      api_key: args.apiKey,
      only_entry_points: args.onlyEntryPoints,
      include_protected: args.includeProtected,
    },
  })
}
