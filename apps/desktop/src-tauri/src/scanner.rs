//! Best-effort scan for running agent-shaped processes.
//!
//! Heuristic, not exact: we inspect each process's command line + cwd and
//! flag anything whose argv contains a known agent library keyword
//! (anthropic, openai, langchain, crewai, llama_index, …). This catches the
//! "python -m my_agent" or "python my_agent.py" pattern without needing
//! macOS Endpoint Security entitlements.
//!
//! False positives are acceptable — the worst that happens is the Welcome
//! page suggests instrumenting a process that doesn't actually use an LLM.
//! False negatives matter more, but a missed candidate just looks the same
//! as today.

use serde::Serialize;
use sysinfo::{ProcessesToUpdate, System};

#[derive(Debug, Serialize)]
pub struct CandidateAgent {
    pub pid: u32,
    pub name: String,
    pub cmdline: String,
    pub cwd: Option<String>,
    /// Which keywords triggered the match — exposed to the UI so users see
    /// why a particular process was flagged.
    pub matched: Vec<String>,
    pub lang: &'static str,
}

/// Substrings we look for in a process's argv. Lowercase comparison.
const KEYWORDS: &[&str] = &[
    "anthropic",
    "openai",
    "langchain",
    "langgraph",
    "crewai",
    "llama_index",
    "llamaindex",
    "smolagents",
    "google.generativeai",
    "bedrock-runtime",
    "mistralai",
    "@anthropic-ai/sdk",
    "@modelcontextprotocol",
    "vercel/ai",
    "@mastra/core",
    "ollama",
];

/// True for interpreters that conventionally host AI agents.
fn is_interpreter(name: &str) -> Option<&'static str> {
    let n = name.to_ascii_lowercase();
    if n.contains("python") {
        Some("Python")
    } else if n == "node" || n.ends_with("/node") || n.contains("bun") {
        Some("JavaScript")
    } else {
        None
    }
}

pub fn scan() -> Vec<CandidateAgent> {
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);

    let me = std::process::id();

    let mut out: Vec<CandidateAgent> = Vec::new();
    for (pid, proc) in sys.processes() {
        let pid_u32: u32 = (*pid).as_u32();
        if pid_u32 == me {
            continue;
        }
        let name = proc.name().to_string_lossy().into_owned();
        let Some(lang) = is_interpreter(&name) else {
            continue;
        };

        // Build a single command-line string and lowercase copy for matching.
        let cmd_vec: Vec<String> = proc
            .cmd()
            .iter()
            .map(|s| s.to_string_lossy().into_owned())
            .collect();
        if cmd_vec.is_empty() {
            continue;
        }
        let cmd = cmd_vec.join(" ");
        let cmd_lower = cmd.to_ascii_lowercase();

        let mut matched: Vec<String> = Vec::new();
        for kw in KEYWORDS {
            if cmd_lower.contains(kw) {
                matched.push((*kw).to_string());
            }
        }
        if matched.is_empty() {
            continue;
        }

        // Skip noisy self-instrumented processes (already integrated with
        // AEGIS) so we don't flag the gateway itself or this Tauri shell.
        if cmd_lower.contains("agentguard") || cmd_lower.contains("aegis") {
            continue;
        }

        let cwd = proc
            .cwd()
            .map(|p| p.to_string_lossy().into_owned());

        out.push(CandidateAgent {
            pid: pid_u32,
            name,
            cmdline: truncate(&cmd, 240),
            cwd,
            matched,
            lang,
        });
    }

    // Stable, friendly ordering: by language then by PID asc.
    out.sort_by(|a, b| a.lang.cmp(b.lang).then(a.pid.cmp(&b.pid)));
    out
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    format!("{cut}…")
}
