import type { GatewayTrace, CheckRequest, CheckResponse, AgentGuardConfig } from '../core/types.js';

const SDK_VERSION = '1.0.0';

/**
 * Build the header set we send on every gateway request. Identity headers
 * are filled from explicit config and fall back to environment vars so
 * customers can pin agent identity without touching code.
 */
function buildHeaders(config: AgentGuardConfig): Record<string, string> {
  const env = (typeof process !== 'undefined' && process.env) || {};
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-agentguard-sdk': `js/${SDK_VERSION}`,
    'x-aegis-agent-id': config.agentId,
  };
  // Use || (not ??) so empty-string defaults from Required<> filling
  // still fall through to the env-var lookup.
  const apiKey = config.apiKey || env.AEGIS_API_KEY || env.AGENTGUARD_API_KEY;
  if (apiKey) headers['x-api-key'] = apiKey;
  const agentSecret = config.agentSecret || env.AEGIS_AGENT_SECRET || env.AGENTGUARD_AGENT_SECRET;
  if (agentSecret) headers['x-aegis-agent-secret'] = agentSecret;
  const agentToken = config.agentToken || env.AEGIS_AGENT_TOKEN;
  if (agentToken) headers['x-aegis-agent-token'] = agentToken;
  const sessionId = config.sessionId || env.AEGIS_SESSION_ID;
  if (sessionId) headers['x-aegis-session-id'] = sessionId;
  return headers;
}

export class HttpTransport {
  private queue: GatewayTrace[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly config: AgentGuardConfig;
  private readonly settings: Required<Pick<AgentGuardConfig,
    'gatewayUrl' | 'batchSize' | 'flushIntervalMs' | 'debug'>>;

  constructor(config: AgentGuardConfig) {
    this.config = { ...config, gatewayUrl: config.gatewayUrl.replace(/\/$/, '') };
    this.settings = {
      gatewayUrl: this.config.gatewayUrl,
      batchSize: config.batchSize ?? 10,
      flushIntervalMs: config.flushIntervalMs ?? 2000,
      debug: config.debug ?? false,
    };
    this.startFlushTimer();
  }

  enqueue(trace: GatewayTrace): void {
    this.queue.push(trace);
    if (this.queue.length >= this.settings.batchSize) {
      void this.flush();
    }
  }

  async check(req: CheckRequest, timeoutMs: number): Promise<CheckResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.settings.gatewayUrl}/api/v1/check`, {
        method: 'POST',
        headers: buildHeaders(this.config),
        body: JSON.stringify(req),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Gateway check failed: ${res.status}`);
      return (await res.json()) as CheckResponse;
    } finally {
      clearTimeout(timer);
    }
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.settings.batchSize);
    try {
      await Promise.all(
        batch.map((trace) =>
          fetch(`${this.settings.gatewayUrl}/api/v1/traces`, {
            method: 'POST',
            headers: buildHeaders(this.config),
            body: JSON.stringify(trace),
          }).catch((err) => {
            if (this.settings.debug) console.warn('[AgentGuard] Failed to send trace:', err);
          })
        )
      );
    } catch (err) {
      if (this.settings.debug) console.warn('[AgentGuard] Flush error:', err);
    }
  }

  destroy(): void {
    if (this.timer) clearInterval(this.timer);
    void this.flush();
  }

  private startFlushTimer(): void {
    this.timer = setInterval(() => {
      void this.flush();
    }, this.settings.flushIntervalMs);
    // Don't block Node.js process exit
    if (this.timer.unref) this.timer.unref();
  }
}
