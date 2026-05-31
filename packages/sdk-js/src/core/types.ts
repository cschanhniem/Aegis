export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type Environment = 'DEVELOPMENT' | 'STAGING' | 'PRODUCTION';
export type ApprovalStatus = 'APPROVED' | 'PENDING_APPROVAL' | 'REJECTED' | 'AUTO_APPROVED';

export interface AgentGuardConfig {
  /** Gateway URL, e.g. 'http://localhost:8080' */
  gatewayUrl: string;
  /** Unique agent identifier */
  agentId: string;
  /** Deployment environment (default: DEVELOPMENT) */
  environment?: Environment;
  /** Max traces to batch before flushing (default: 10) */
  batchSize?: number;
  /** Flush interval in ms (default: 2000) */
  flushIntervalMs?: number;
  /**
   * Blocking mode: check tool calls against policies BEFORE execution.
   * Throws AgentGuardBlockedError if policy denies the call.
   * Default: false
   */
  blockingMode?: boolean;
  /** Timeout for blocking checks in ms (default: 3000) */
  blockingTimeoutMs?: number;
  /**
   * Fail-open: if gateway is unreachable during a blocking check, allow the call.
   * Set to false for strict enforcement. Default: true
   */
  failOpen?: boolean;
  /** Log debug info to console (default: false) */
  debug?: boolean;
  /**
   * AEGIS API key (per-org). Sent as X-API-Key on every request. Falls
   * back to env AEGIS_API_KEY / AGENTGUARD_API_KEY.
   */
  apiKey?: string;
  /**
   * Optional agent secret. When the agent is registered with a secret,
   * the SDK forwards it as X-AEGIS-Agent-Secret so the gateway's agent
   * registry can verify identity before serving the request. Falls back
   * to env AEGIS_AGENT_SECRET / AGENTGUARD_AGENT_SECRET.
   */
  agentSecret?: string;
  /**
   * Optional session id for cross-agent correlation. Falls back to env
   * AEGIS_SESSION_ID.
   */
  sessionId?: string;
}

export interface TraceInput {
  toolName: string;
  prompt: string;
  arguments: Record<string, unknown>;
  startTime: number;
  result?: unknown;
  error?: string;
}

export interface CheckRequest {
  agent_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  environment: string;
  /** Optional CoT alignment verdict — DSL rules can match `alignment.drifted`. */
  alignment?: {
    score: number;
    drifted?: boolean;
    signals?: string[];
    reason?: string;
  };
  /** Optional CodeShield scan summary — DSL rules can match `code_shield.worst`. */
  code_shield?: {
    worst: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | null;
    findings_count?: number;
    rules?: string[];
  };
}

export interface CheckResponse {
  decision: 'allow' | 'block' | 'pending';
  reason?: string;
  check_id?: string;
  risk_level?: string;
  category?: string;
  latency_ms?: number;
}

export interface GatewayTrace {
  trace_id: string;
  agent_id: string;
  sequence_number: number;
  timestamp: string;
  input_context: {
    prompt: string;
    system_context?: Record<string, unknown>;
  };
  thought_chain: {
    raw_tokens: string;
    parsed_steps: string[];
  };
  tool_call: {
    tool_name: string;
    function: string;
    arguments: Record<string, unknown>;
    timestamp: string;
  };
  observation: {
    raw_output: unknown;
    error?: string;
    duration_ms: number;
  };
  integrity_hash: string;
  previous_hash?: string;
  environment: string;
  version: string;
}

/** Thrown when blocking mode is enabled and a policy denies the tool call. */
export class AgentGuardBlockedError extends Error {
  public readonly toolName: string;
  public readonly reason: string;
  public readonly riskLevel: RiskLevel;
  public readonly checkId: string;

  constructor(toolName: string, reason: string, riskLevel: RiskLevel, checkId: string) {
    super(`[AgentGuard] Blocked: "${toolName}" — ${reason}`);
    this.name = 'AgentGuardBlockedError';
    this.toolName = toolName;
    this.reason = reason;
    this.riskLevel = riskLevel;
    this.checkId = checkId;
    Object.setPrototypeOf(this, AgentGuardBlockedError.prototype);
  }
}
