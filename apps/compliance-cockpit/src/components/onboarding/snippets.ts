import type { ScenarioId } from './scenario-picker'

export interface SnippetBlock {
  language: 'bash' | 'python' | 'javascript' | 'http'
  label: string
  body: string
}

export interface SnippetSet {
  /** Heading shown above the snippets. */
  title: string
  /** Sub-line that explains what these snippets do in one sentence. */
  blurb: string
  /** Ordered list of code blocks the user will execute. */
  blocks: SnippetBlock[]
  /** Documentation pointer shown under the blocks. */
  docsHref?: string
}

function withKey(s: string, apiKey: string): string {
  if (!apiKey) return s
  return s.replace('<YOUR_API_KEY>', apiKey)
}

export function snippetsFor(
  scenario: ScenarioId,
  ctx: { gatewayUrl: string; apiKey: string },
): SnippetSet {
  const { gatewayUrl, apiKey } = ctx
  const keyHint = apiKey ? '' : '\n# Set AEGIS_API_KEY in your env or paste it inline.'

  switch (scenario) {
    case 'python':
      return {
        title: 'Drop in two lines of Python',
        blurb: 'AEGIS auto-patches every supported framework that is already imported in your process. Existing code stays unchanged.',
        blocks: [
          {
            language: 'bash',
            label: '1. Install the SDK',
            body:  'pip install agentguard-aegis',
          },
          {
            language: 'python',
            label: '2. Add to the top of your entry point',
            body: withKey(
              `import agentguard
agentguard.auto(
    "${gatewayUrl}",
    agent_id="my-agent",
    api_key="${apiKey || '<YOUR_API_KEY>'}",
)${keyHint}`,
              apiKey,
            ),
          },
          {
            language: 'bash',
            label: '3. Run your agent. AEGIS will start streaming traces here.',
            body:  'python your_agent.py',
          },
        ],
      }
    case 'javascript':
      return {
        title: 'Drop in two lines of TypeScript',
        blurb: 'The JS SDK auto-patches OpenAI, Anthropic, Vercel AI SDK, and Mastra in one call.',
        blocks: [
          {
            language: 'bash',
            label: '1. Install the SDK',
            body:  'npm install @justinnn/agentguard',
          },
          {
            language: 'javascript',
            label: '2. Add to the top of your entry file',
            body: withKey(
              `import agentguard from '@justinnn/agentguard'

agentguard.auto('${gatewayUrl}', {
  agentId: 'my-agent',
  apiKey:  '${apiKey || '<YOUR_API_KEY>'}',
})`,
              apiKey,
            ),
          },
          {
            language: 'bash',
            label: '3. Run your agent.',
            body:  'node ./your-agent.js',
          },
        ],
      }
    case 'demo':
      return {
        title: 'Run the AEGIS demo agent (60 seconds)',
        blurb: 'No code, no LLM keys. The demo agent calls the gateway with a realistic mix of safe + risky operations so every panel in the Cockpit lights up.',
        blocks: [
          {
            language: 'bash',
            label: '1. (Optional) Install the AEGIS CLI globally',
            body:  'npm install -g @justinnn/agentguard-cli',
          },
          {
            language: 'bash',
            label: '2. Launch the demo agent',
            body: withKey(
              `npx agentguard demo \\
  --gateway ${gatewayUrl} \\
  --api-key ${apiKey || '<YOUR_API_KEY>'}`,
              apiKey,
            ),
          },
          {
            language: 'bash',
            label: '3. Or run it directly from the monorepo',
            body:  'node tools/demo-agent/index.mjs',
          },
        ],
      }
    case 'proxy':
      return {
        title: 'Route your existing OpenAI / Anthropic calls through AEGIS',
        blurb: 'Point any HTTP-speaking client at the LLM Egress Proxy. Tool calls get inspected before they leave your network, no SDK install needed.',
        blocks: [
          {
            language: 'bash',
            label: '1. Pick the upstream you want guarded',
            body:  '# OpenAI:   /api/v1/llm-proxy/openai/<path>\n# Anthropic: /api/v1/llm-proxy/anthropic/<path>',
          },
          {
            language: 'bash',
            label: '2. OpenAI Python client',
            body: withKey(
              `from openai import OpenAI
client = OpenAI(
    base_url="${gatewayUrl}/api/v1/llm-proxy/openai/v1",
    default_headers={"X-AEGIS-Key": "${apiKey || '<YOUR_API_KEY>'}"},
)`,
              apiKey,
            ),
          },
          {
            language: 'bash',
            label: '3. Anthropic Python client',
            body: withKey(
              `from anthropic import Anthropic
client = Anthropic(
    base_url="${gatewayUrl}/api/v1/llm-proxy/anthropic",
    default_headers={"X-AEGIS-Key": "${apiKey || '<YOUR_API_KEY>'}"},
)`,
              apiKey,
            ),
          },
        ],
      }
  }
}
