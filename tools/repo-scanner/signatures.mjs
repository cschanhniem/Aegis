/**
 * AEGIS repo-scanner signature table.
 *
 * Externalised from index.mjs so adding a new provider is a one-line
 * change (and so we can unit-test the table directly without spinning
 * up the whole scanner).
 *
 * Each entry has the same shape:
 *
 *   {
 *     id:       unique kebab-case identifier (used in reports)
 *     name:     human-friendly name
 *     lang:     'python' | 'javascript' | 'go' | 'any'
 *     kind:     'import' | 'http' | 'mcp'        — drives downstream remediation:
 *                 - import: inject SDK (codemod-inject)
 *                 - http:   re-point base_url at the LLM Egress Proxy
 *                 - mcp:    wire the MCP client through the AEGIS MCP proxy
 *     patterns: array of RegExp matched against the file text. First-match-wins
 *               per framework, every match is recorded as evidence.
 *   }
 *
 * Patterns are pre-compiled here so the scanner's hot loop is just a
 * `for (const fw of SIGNATURES)` with no regex construction.
 */

// ── Import-based detection (highest-precision: lexical anchor to `import` keyword)
const IMPORT_SIGNATURES = [
  // Python
  { id: 'anthropic',     lang: 'python', name: 'Anthropic',     patterns: [/^\s*import\s+anthropic\b/m, /^\s*from\s+anthropic\b/m] },
  { id: 'openai',        lang: 'python', name: 'OpenAI',        patterns: [/^\s*from\s+openai\s+import/m, /^\s*import\s+openai\b/m] },
  { id: 'langchain',     lang: 'python', name: 'LangChain',     patterns: [/^\s*from\s+langchain[._]?\w*\s+import/m, /^\s*import\s+langchain\b/m] },
  { id: 'langgraph',     lang: 'python', name: 'LangGraph',     patterns: [/^\s*from\s+langgraph(\.\w+)*\s+import/m, /^\s*import\s+langgraph\b/m] },
  { id: 'crewai',        lang: 'python', name: 'CrewAI',        patterns: [/^\s*from\s+crewai\b/m, /^\s*import\s+crewai\b/m] },
  { id: 'llamaindex',    lang: 'python', name: 'LlamaIndex',    patterns: [/^\s*from\s+llama_index\b/m, /^\s*import\s+llama_index\b/m] },
  { id: 'mistral',       lang: 'python', name: 'Mistral',       patterns: [/^\s*from\s+mistralai\b/m, /^\s*import\s+mistralai\b/m] },
  { id: 'gemini',        lang: 'python', name: 'Google Gemini', patterns: [/^\s*import\s+google\.generativeai/m, /^\s*from\s+google\.generativeai/m, /^\s*from\s+google\s+import\s+genai\b/m] },
  { id: 'bedrock',       lang: 'python', name: 'AWS Bedrock',   patterns: [/boto3\.client\(["']bedrock(-runtime)?["']\)/, /^\s*import\s+boto3\b/m] },
  { id: 'smolagents',    lang: 'python', name: 'smolagents',    patterns: [/^\s*from\s+smolagents\b/m, /^\s*import\s+smolagents\b/m] },
  { id: 'pydantic-ai',   lang: 'python', name: 'Pydantic AI',   patterns: [/^\s*from\s+pydantic_ai\b/m] },
  { id: 'autogen',       lang: 'python', name: 'AutoGen',       patterns: [/^\s*from\s+autogen\b/m, /^\s*import\s+autogen\b/m] },
  { id: 'haystack',      lang: 'python', name: 'Haystack',      patterns: [/^\s*from\s+haystack\b/m, /^\s*import\s+haystack\b/m] },
  { id: 'dspy',          lang: 'python', name: 'DSPy',          patterns: [/^\s*import\s+dspy\b/m, /^\s*from\s+dspy\b/m] },
  { id: 'cohere',        lang: 'python', name: 'Cohere',        patterns: [/^\s*import\s+cohere\b/m, /^\s*from\s+cohere\b/m] },
  { id: 'together',      lang: 'python', name: 'Together',      patterns: [/^\s*from\s+together\b/m, /^\s*import\s+together\b/m] },
  { id: 'ollama',        lang: 'python', name: 'Ollama',        patterns: [/^\s*import\s+ollama\b/m, /^\s*from\s+ollama\b/m] },
  { id: 'groq',          lang: 'python', name: 'Groq',          patterns: [/^\s*from\s+groq\b/m, /^\s*import\s+groq\b/m] },
  { id: 'replicate',     lang: 'python', name: 'Replicate',     patterns: [/^\s*import\s+replicate\b/m, /^\s*from\s+replicate\b/m] },

  // JavaScript / TypeScript
  { id: 'anthropic-js',  lang: 'javascript', name: 'Anthropic (JS)', patterns: [/from\s+["']@anthropic-ai\/sdk["']/, /require\(\s*["']@anthropic-ai\/sdk["']\s*\)/] },
  { id: 'openai-js',     lang: 'javascript', name: 'OpenAI (JS)',    patterns: [/from\s+["']openai["']/, /require\(\s*["']openai["']\s*\)/] },
  { id: 'vercel-ai',     lang: 'javascript', name: 'Vercel AI SDK',  patterns: [/from\s+["']ai["']/, /require\(\s*["']ai["']\s*\)/] },
  { id: 'mastra',        lang: 'javascript', name: 'Mastra',         patterns: [/from\s+["']@mastra\/core/, /require\(\s*["']@mastra\/core/] },
  { id: 'langchain-js',  lang: 'javascript', name: 'LangChain (JS)', patterns: [/from\s+["']@langchain\//, /from\s+["']langchain\//] },
  { id: 'mistral-js',    lang: 'javascript', name: 'Mistral (JS)',   patterns: [/from\s+["']@mistralai\/mistralai["']/, /require\(\s*["']@mistralai\/mistralai["']\s*\)/] },
  { id: 'cohere-js',     lang: 'javascript', name: 'Cohere (JS)',    patterns: [/from\s+["']cohere-ai["']/, /require\(\s*["']cohere-ai["']\s*\)/] },
  { id: 'ollama-js',     lang: 'javascript', name: 'Ollama (JS)',    patterns: [/from\s+["']ollama["']/, /require\(\s*["']ollama["']\s*\)/] },
  { id: 'groq-js',       lang: 'javascript', name: 'Groq (JS)',      patterns: [/from\s+["']groq-sdk["']/, /require\(\s*["']groq-sdk["']\s*\)/] },

  // Go — `import (` block OR single-line `import "..."`. Pattern matches
  // a quoted path on the import line; we anchor to the well-known
  // module paths upstream of the Go SDK ecosystems.
  { id: 'openai-go',     lang: 'go', name: 'OpenAI (Go)',          patterns: [/^\s*"github\.com\/sashabaranov\/go-openai"/m, /^\s*import\s+"github\.com\/sashabaranov\/go-openai"/m] },
  { id: 'anthropic-go',  lang: 'go', name: 'Anthropic (Go)',       patterns: [/^\s*"github\.com\/anthropics\/anthropic-sdk-go"/m, /^\s*import\s+"github\.com\/anthropics\/anthropic-sdk-go"/m] },
  { id: 'langchaingo',   lang: 'go', name: 'LangChain (Go)',       patterns: [/^\s*"github\.com\/tmc\/langchaingo[^"]*"/m] },
  { id: 'bedrock-go',    lang: 'go', name: 'AWS Bedrock (Go)',     patterns: [/aws-sdk-go-v2\/service\/bedrockruntime/, /aws-sdk-go\/service\/bedrockruntime/] },
  { id: 'aegis-go',      lang: 'go', name: 'AEGIS SDK (Go)',       patterns: [/agentguard/, /aegis/] }, // sentinel — used by already-protected check
]

// ── HTTP-endpoint detection (catches raw `requests` / `fetch` users)
// Patterns are conservative — we look for the FQDN inside a string literal,
// not just "openai" in a comment. The string has to look like a URL or a
// `base_url` argument.
const HTTP_SIGNATURES = [
  {
    id: 'openai-http', name: 'OpenAI (HTTP)', lang: 'any', endpoint: 'api.openai.com',
    patterns: [/["']https?:\/\/api\.openai\.com[^"']*["']/, /\bbase_url\s*[:=]\s*["']https?:\/\/api\.openai\.com/],
  },
  {
    id: 'anthropic-http', name: 'Anthropic (HTTP)', lang: 'any', endpoint: 'api.anthropic.com',
    patterns: [/["']https?:\/\/api\.anthropic\.com[^"']*["']/],
  },
  {
    id: 'mistral-http', name: 'Mistral (HTTP)', lang: 'any', endpoint: 'api.mistral.ai',
    patterns: [/["']https?:\/\/api\.mistral\.ai[^"']*["']/],
  },
  {
    id: 'gemini-http', name: 'Gemini (HTTP)', lang: 'any', endpoint: 'generativelanguage.googleapis.com',
    patterns: [/["']https?:\/\/generativelanguage\.googleapis\.com[^"']*["']/],
  },
  {
    id: 'bedrock-http', name: 'Bedrock (HTTP)', lang: 'any', endpoint: 'bedrock-runtime',
    patterns: [/["']https?:\/\/bedrock-runtime[^"']*\.amazonaws\.com[^"']*["']/],
  },
  {
    id: 'together-http', name: 'Together (HTTP)', lang: 'any', endpoint: 'api.together.xyz',
    patterns: [/["']https?:\/\/api\.together\.xyz[^"']*["']/],
  },
  {
    id: 'groq-http', name: 'Groq (HTTP)', lang: 'any', endpoint: 'api.groq.com',
    patterns: [/["']https?:\/\/api\.groq\.com[^"']*["']/],
  },
  {
    id: 'cohere-http', name: 'Cohere (HTTP)', lang: 'any', endpoint: 'api.cohere.ai',
    patterns: [/["']https?:\/\/api\.cohere\.(?:ai|com)[^"']*["']/],
  },
  {
    id: 'perplexity-http', name: 'Perplexity (HTTP)', lang: 'any', endpoint: 'api.perplexity.ai',
    patterns: [/["']https?:\/\/api\.perplexity\.ai[^"']*["']/],
  },
  {
    id: 'fireworks-http', name: 'Fireworks (HTTP)', lang: 'any', endpoint: 'api.fireworks.ai',
    patterns: [/["']https?:\/\/api\.fireworks\.ai[^"']*["']/],
  },
  {
    id: 'openrouter-http', name: 'OpenRouter (HTTP)', lang: 'any', endpoint: 'openrouter.ai',
    patterns: [/["']https?:\/\/openrouter\.ai\/api[^"']*["']/],
  },
  {
    id: 'azure-openai-http', name: 'Azure OpenAI (HTTP)', lang: 'any', endpoint: '*.openai.azure.com',
    patterns: [/["']https?:\/\/[a-z0-9-]+\.openai\.azure\.com[^"']*["']/i],
  },
  {
    id: 'ollama-http', name: 'Ollama local (HTTP)', lang: 'any', endpoint: '127.0.0.1:11434',
    patterns: [/["']https?:\/\/(?:localhost|127\.0\.0\.1)(?::11434)[^"']*["']/],
  },
]

// ── MCP / agent-config detection.
// File-level rather than content-level: we match the FILENAME first, then
// parse the JSON to confirm it's actually an MCP / Claude / Cursor config.
const MCP_CONFIG_FILES = [
  // Claude Desktop / Claude Code
  { id: 'claude-desktop-config',  filename: 'claude_desktop_config.json',          context: 'Claude Desktop' },
  { id: 'claude-code-mcp',        filename: '.mcp.json',                            context: 'Claude Code / generic MCP' },
  { id: 'mcp-config',             filename: 'mcp.json',                             context: 'MCP host (generic)' },
  // Cursor
  { id: 'cursor-mcp',             filename: '.cursor/mcp.json',                     context: 'Cursor' },
  { id: 'cursor-mcp-flat',        filename: 'cursor.mcp.json',                      context: 'Cursor (flat)' },
  // Continue.dev
  { id: 'continue-config',        filename: '.continue/config.json',                context: 'Continue.dev' },
  // Goose / Windsurf
  { id: 'goose-config',           filename: '.config/goose/config.yaml',            context: 'Goose' },
  { id: 'windsurf-mcp',           filename: '.windsurfrc',                          context: 'Windsurf' },
  // VS Code
  { id: 'vscode-mcp',             filename: '.vscode/mcp.json',                     context: 'VS Code MCP' },
]

// ── Tool-declaration patterns ──────────────────────────────────────────
// These patterns lift the **agent's tool surface** out of the code:
//   - which tools the agent has been given (names)
//   - what shape their arguments are (when we can recover it)
//
// The wizard feeds this inventory into the policy generator, so the
// model produces policies for *the tools that actually exist* instead
// of guessing generic names like `db_query`, `shell`, etc. This is the
// single biggest precision lever we have:
//   - false positives drop because we don't block tools the agent doesn't have
//   - false negatives drop because we cover EVERY tool the agent has
//
// Each entry yields zero-or-more `{name, args?}` tuples per file. Most
// patterns capture the name only; the bundle generator can ask the LLM
// to infer arg schemas from context when the regex can't.
const TOOL_DECL_PATTERNS = [
  // OpenAI / Anthropic function-calling JSON:
  //   { "name": "db_query", "description": "...", "parameters": { ... } }
  //
  // Heuristic: find any `"name": "<id>"` followed (within ~200 chars,
  // crossing newlines) by `"description":`. This avoids the brittle
  // brace-balancing problem with nested `parameters: {...}` and keeps
  // false positives low — production code rarely has a name+description
  // pair on adjacent keys except for tool specs.
  {
    id: 'function-call-spec', lang: 'any',
    extract: (text) => {
      const out = []
      const re = /["']name["']\s*:\s*["']([A-Za-z_][\w.-]{0,80})["'][\s\S]{0,200}?["']description["']\s*:/g
      for (const m of text.matchAll(re)) {
        out.push({ name: m[1], shape: 'function-call' })
      }
      return out
    },
  },
  // LangChain Tool(name=...) / StructuredTool / @tool decorator
  {
    id: 'langchain-tool', lang: 'python',
    extract: (text) => {
      const out = []
      for (const m of text.matchAll(/\bTool\s*\(\s*name\s*=\s*["']([A-Za-z_][\w-]{0,80})["']/g)) out.push({ name: m[1], shape: 'langchain-tool' })
      for (const m of text.matchAll(/\bStructuredTool[.\w]*\s*\(\s*name\s*=\s*["']([A-Za-z_][\w-]{0,80})["']/g)) out.push({ name: m[1], shape: 'langchain-tool' })
      // @tool decorator on a function — the function name IS the tool name.
      for (const m of text.matchAll(/@tool[^\n]*\n\s*(?:async\s+)?def\s+([A-Za-z_]\w{0,80})/g)) out.push({ name: m[1], shape: 'langchain-decorator' })
      return out
    },
  },
  // CrewAI Agent(tools=[...]) — extract tool names from the array
  {
    id: 'crewai-tool', lang: 'python',
    extract: (text) => {
      const out = []
      for (const m of text.matchAll(/tools\s*=\s*\[\s*([\w.\s,()'"]+)\s*\]/g)) {
        const list = m[1]
        for (const tn of list.matchAll(/\b([A-Za-z_]\w{0,80})\s*(?=[,)])/g)) {
          // Filter known noise: keywords, primitives
          const name = tn[1]
          if (!['agent', 'tools', 'role', 'goal', 'true', 'false', 'none'].includes(name.toLowerCase())) {
            out.push({ name, shape: 'crewai-list' })
          }
        }
      }
      return out
    },
  },
  // Vercel AI SDK / Mastra: tools: { tool_name: tool({ description: ... }) }
  //
  // We anchor on the `tool(` factory inside the object so each key we
  // pick up is genuinely a tool entry (not an arbitrary nested object).
  {
    id: 'ai-sdk-tools', lang: 'javascript',
    extract: (text) => {
      const out = []
      // Find `<ident>: tool(` or `<ident>: createTool(` (case insensitive on the factory).
      const re = /(?:^|[\s,{])([A-Za-z_]\w{0,80})\s*:\s*(?:tool|createTool|aiTool)\s*\(/g
      for (const m of text.matchAll(re)) {
        const name = m[1]
        if (!['async', 'function', 'return', 'const', 'let', 'var', 'true', 'false', 'null', 'default'].includes(name)) {
          out.push({ name, shape: 'ai-sdk-tools' })
        }
      }
      return out
    },
  },
  // MCP inputSchema declarations
  {
    id: 'mcp-input-schema', lang: 'any',
    extract: (text) => {
      const out = []
      for (const m of text.matchAll(/inputSchema\s*[:=]\s*\{[^}]*?["']properties["']/gs)) {
        // We can't easily extract the tool name from inputSchema alone —
        // it's typically a sibling of `name:` in a `tools[]` element.
        // Anchor backward to a sibling `name` field.
        const start = m.index ?? 0
        const window = text.slice(Math.max(0, start - 500), start)
        const nm = window.match(/["']name["']\s*:\s*["']([A-Za-z_][\w.-]{0,80})["']/)
        if (nm) out.push({ name: nm[1], shape: 'mcp' })
      }
      return out
    },
  },
]

// ── Workflow entry-point patterns ──────────────────────────────────────
// These are the "this is where the agent loop starts" signatures. A file
// that just imports langchain might be a helper; a file that calls
// LangGraph.compile() or builds an AgentExecutor is the agent's entry
// point. We elevate `is_entry_point = true` AND tag a workflow_kind so
// the wizard can pre-select these as the targets to instrument.
const WORKFLOW_PATTERNS = [
  { id: 'langgraph',           lang: 'python', patterns: [/StateGraph\s*\(/, /\.compile\s*\(\s*\)/, /from\s+langgraph(\.|graph)?/] },
  { id: 'langchain-executor',  lang: 'python', patterns: [/AgentExecutor\s*\(/, /create_react_agent\s*\(/, /create_openai_functions_agent\s*\(/] },
  { id: 'crewai-crew',         lang: 'python', patterns: [/Crew\s*\(\s*agents\s*=/, /\.kickoff\s*\(/] },
  { id: 'autogen-groupchat',   lang: 'python', patterns: [/GroupChat\s*\(/, /GroupChatManager\s*\(/, /UserProxyAgent\s*\(/] },
  { id: 'llamaindex-agent',    lang: 'python', patterns: [/ReActAgent\.from_tools\s*\(/, /OpenAIAgent\.from_tools\s*\(/] },
  { id: 'smolagents-agent',    lang: 'python', patterns: [/ToolCallingAgent\s*\(/, /CodeAgent\s*\(/] },
  { id: 'pydantic-ai-agent',   lang: 'python', patterns: [/Agent\s*\(\s*['"][^'"]+['"]\s*,/] },

  { id: 'mastra-agent',        lang: 'javascript', patterns: [/new\s+Agent\s*\(\s*\{/, /from\s+["']@mastra\/core\/agent["']/] },
  { id: 'vercel-ai-tool',      lang: 'javascript', patterns: [/streamText\s*\(/, /generateText\s*\(/, /\btools:\s*\{/] },
  { id: 'langchain-js-agent',  lang: 'javascript', patterns: [/AgentExecutor\.fromAgentAndTools\s*\(/, /createOpenAIFunctionsAgent\s*\(/] },
]

// ── Already-protected detection (any lang).
// Recognised across import + base_url-via-egress-proxy.
const ALREADY_PROTECTED_PATTERNS = [
  /^\s*import\s+agentguard\b/m,
  /from\s+["']@justinnn\/agentguard["']/,
  /require\(\s*["']@justinnn\/agentguard["']\s*\)/,
  /agentguard\.auto\s*\(/,
  /agentguard\.Auto\s*\(/,
  /["']https?:\/\/[^"']*\/api\/v1\/llm-proxy\/[^"']*["']/,   // egress-proxy base_url
  /github\.com\/[^"']*\/agentguard[^"']*\/sdk-go/,
]

// ── Source-file extensions and the language we'd dispatch them to.
const PY_EXTS  = new Set(['.py'])
const JS_EXTS  = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs'])
const GO_EXTS  = new Set(['.go'])
const SOURCE_EXTS = new Set([...PY_EXTS, ...JS_EXTS, ...GO_EXTS])

function languageOf(file) {
  const i = file.lastIndexOf('.')
  if (i < 0) return null
  const ext = file.slice(i).toLowerCase()
  if (PY_EXTS.has(ext)) return 'python'
  if (JS_EXTS.has(ext)) return 'javascript'
  if (GO_EXTS.has(ext)) return 'go'
  return null
}

export {
  IMPORT_SIGNATURES,
  HTTP_SIGNATURES,
  MCP_CONFIG_FILES,
  WORKFLOW_PATTERNS,
  TOOL_DECL_PATTERNS,
  ALREADY_PROTECTED_PATTERNS,
  PY_EXTS,
  JS_EXTS,
  GO_EXTS,
  SOURCE_EXTS,
  languageOf,
}
