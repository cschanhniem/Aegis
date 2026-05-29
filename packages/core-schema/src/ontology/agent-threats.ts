/**
 * AEGIS Agent Threat Ontology — v1.0.0
 *
 * A versioned taxonomy of threats specific to LLM agent systems, modeled on
 * MITRE ATT&CK but scoped to the agent attack surface (prompt, tool use,
 * memory, retrieval, multi-agent handoff). Every detector AEGIS ships and
 * every detector a customer registers can declare which ontology nodes it
 * covers; the gateway publishes a coverage map customers can compare across
 * vendors apples-to-apples.
 *
 * Versioning: this file is FROZEN once shipped. New nodes append; existing
 * nodes' IDs and meanings never change. Renames or splits go through a
 * deprecation cycle with a new ID and a deprecation pointer.
 *
 * ID scheme:
 *   AAT-T<tactic>            tactic node     (e.g. AAT-T1000 = Initial Compromise)
 *   AAT-T<tactic><tech>      technique node  (e.g. AAT-T1001 = Indirect Prompt Injection)
 *   AAT-T<tactic><tech>.<n>  sub-technique   (reserved for v1.1+)
 *
 * Citations are not exhaustive — they point to the canonical first paper or
 * incident report so a security reviewer can audit the taxonomy's grounding.
 */

export const ONTOLOGY_VERSION = '1.0.0';

export type Tactic =
  | 'initial-compromise'
  | 'execution'
  | 'privilege-escalation'
  | 'credential-access'
  | 'data-exfiltration'
  | 'persistence'
  | 'discovery'
  | 'impact'
  | 'defense-evasion'
  | 'lateral-movement';

export interface TacticNode {
  readonly id: string;             // AAT-T<n>000
  readonly kind: 'tactic';
  readonly slug: Tactic;
  readonly title: string;
  readonly summary: string;
}

export interface TechniqueNode {
  readonly id: string;             // AAT-T<n>0<m>
  readonly kind: 'technique';
  readonly tactic: Tactic;
  readonly title: string;
  readonly summary: string;
  /** Brief mitigation hints — pointers, not full controls. */
  readonly mitigations: readonly string[];
  /** Canonical references (paper title / arxiv id / advisory id). */
  readonly references: readonly string[];
}

export type OntologyNode = TacticNode | TechniqueNode;

// ── Tactics ────────────────────────────────────────────────────────────────

export const TACTICS: readonly TacticNode[] = Object.freeze([
  { id: 'AAT-T1000', kind: 'tactic', slug: 'initial-compromise',     title: 'Initial Compromise',     summary: 'Adversary first establishes influence over the agent loop — via input, retrieval, or supply chain.' },
  { id: 'AAT-T2000', kind: 'tactic', slug: 'execution',              title: 'Execution',              summary: 'Adversary causes the agent to take an unintended or unauthorized action through a tool.' },
  { id: 'AAT-T3000', kind: 'tactic', slug: 'privilege-escalation',   title: 'Privilege Escalation',   summary: 'Agent gains capabilities beyond its declared role or baseline.' },
  { id: 'AAT-T4000', kind: 'tactic', slug: 'credential-access',      title: 'Credential Access',      summary: 'Secrets, tokens, or keys are exposed via agent input, output, or tool args.' },
  { id: 'AAT-T5000', kind: 'tactic', slug: 'data-exfiltration',      title: 'Data Exfiltration',      summary: 'Sensitive data leaves the trust boundary through an agent action.' },
  { id: 'AAT-T6000', kind: 'tactic', slug: 'persistence',            title: 'Persistence',            summary: 'Adversary establishes durable influence — memory, retrieval store, or agent-owned artifact.' },
  { id: 'AAT-T7000', kind: 'tactic', slug: 'discovery',              title: 'Discovery',              summary: 'Agent is used to enumerate the environment, credentials, or topology.' },
  { id: 'AAT-T8000', kind: 'tactic', slug: 'impact',                 title: 'Impact',                 summary: 'Direct, observable harm: cost burn, destruction, runaway automation, DoS.' },
  { id: 'AAT-T9000', kind: 'tactic', slug: 'defense-evasion',        title: 'Defense Evasion',        summary: 'Adversary evades classifiers, policies, anomaly thresholds, or PII detectors.' },
  { id: 'AAT-T10000', kind: 'tactic', slug: 'lateral-movement',      title: 'Lateral Movement',       summary: 'Compromise propagates across agents, sessions, or shared tenant context.' },
]);

// ── Techniques ────────────────────────────────────────────────────────────

export const TECHNIQUES: readonly TechniqueNode[] = Object.freeze([
  // Initial Compromise (T1xxx)
  { id: 'AAT-T1001', kind: 'technique', tactic: 'initial-compromise', title: 'Indirect Prompt Injection',  summary: 'Adversary plants instructions in content the agent retrieves or reads from a tool result, causing the agent to follow attacker intent on later turns.', mitigations: ['Treat all retrieved content as untrusted', 'Separate instructions from data with strict delimiters', 'Detect imperative language in tool outputs'], references: ['Greshake et al., 2023 — "Not what you’ve signed up for"', 'OWASP LLM01:2025'] },
  { id: 'AAT-T1002', kind: 'technique', tactic: 'initial-compromise', title: 'Retrieval Poisoning',         summary: 'Adversary seeds the agent\'s RAG store / vector DB with adversarial documents that surface on relevant queries.',                                          mitigations: ['Provenance tagging on ingested docs', 'Anomaly-score retrieval results', 'Verify upstream sources cryptographically'],            references: ['Zou et al., 2024 — "Poisoning RAG"', 'OWASP LLM08:2025'] },
  { id: 'AAT-T1003', kind: 'technique', tactic: 'initial-compromise', title: 'Tool Supply-Chain Compromise', summary: 'A tool the agent depends on is replaced or modified by the adversary (e.g. malicious npm/PyPI package, compromised MCP server).',                          mitigations: ['Tool signature verification', 'Pinning by hash', 'Sandbox tool execution'],                                                       references: ['SLSA framework', 'Sigstore', 'OWASP LLM05:2025'] },
  { id: 'AAT-T1004', kind: 'technique', tactic: 'initial-compromise', title: 'Jailbreak / Policy Bypass',    summary: 'User input crafted to subvert the system prompt, safety policy, or operator instructions (DAN, role-play, suffix attacks).',                                mitigations: ['System prompt isolation', 'Classifier ensemble', 'Refuse-list with semantic match'],                                              references: ['Zou et al., 2023 — "Universal and Transferable Adversarial Attacks"'] },
  { id: 'AAT-T1005', kind: 'technique', tactic: 'initial-compromise', title: 'Adversarial User Input',        summary: 'Specially crafted user-supplied prompts (not jailbreak) that exploit specific tool argument grammars.',                                                    mitigations: ['Per-tool argument schema validation', 'Content sanitization at tool boundary'],                                                    references: ['OWASP LLM03:2025'] },

  // Execution (T2xxx)
  { id: 'AAT-T2001', kind: 'technique', tactic: 'execution', title: 'Out-of-Scope Tool Invocation',          summary: 'Agent invokes a tool outside its declared role or task — e.g. a research agent calling a payments tool.',                                                  mitigations: ['Per-agent allow-list', 'Baseline-derived novelty detector'],                                                                       references: ['AEGIS Agent Baseline (P2.5)'] },
  { id: 'AAT-T2002', kind: 'technique', tactic: 'execution', title: 'Tool Argument Injection',                summary: 'Adversary smuggles arguments through prompt text that change tool behavior in ways the agent did not declare.',                                          mitigations: ['Structured arg passing', 'Argument schema enforcement', 'Pre-call argument diff against intent'],                                  references: ['OWASP LLM06:2025'] },
  { id: 'AAT-T2003', kind: 'technique', tactic: 'execution', title: 'Unintended Code Execution',              summary: 'Agent uses an eval / exec / shell tool with adversary-influenced input, executing arbitrary code in the agent runtime.',                                mitigations: ['Refuse eval/shell tools by default', 'Sandboxed execution'],                                                                       references: ['OWASP LLM02:2025'] },
  { id: 'AAT-T2004', kind: 'technique', tactic: 'execution', title: 'SQL Injection via Tool',                 summary: 'Agent constructs SQL with unsanitized prompt-derived strings.',                                                                                          mitigations: ['Parameterized query enforcement', 'AST validation of generated SQL'],                                                              references: ['CWE-89'] },
  { id: 'AAT-T2005', kind: 'technique', tactic: 'execution', title: 'SSRF via Network Tool',                  summary: 'Agent\'s outbound HTTP tool is induced to call internal infra (169.254/169.x, RFC1918, metadata service).',                                              mitigations: ['Egress allow-list', 'IP/host classification at gateway'],                                                                          references: ['CWE-918'] },

  // Privilege Escalation (T3xxx)
  { id: 'AAT-T3001', kind: 'technique', tactic: 'privilege-escalation', title: 'New-Tool Activation',         summary: 'Agent invokes a tool never seen in its trained baseline — possible indicator of role-broadening attack.',                                                mitigations: ['Baseline-derived allow-list', 'Manual approval for first-time-tool calls'],                                                       references: ['AEGIS Agent Baseline (P2.5)'] },
  { id: 'AAT-T3002', kind: 'technique', tactic: 'privilege-escalation', title: 'Scope Broadening',             summary: 'Agent expands the file paths, hostnames, or database scopes it touches beyond its baseline cluster.',                                                    mitigations: ['Per-resource scope baseline', 'Scope-creep anomaly signal'],                                                                       references: [] },
  { id: 'AAT-T3003', kind: 'technique', tactic: 'privilege-escalation', title: 'Role Confusion',               summary: 'System-prompt / operator-instruction override via adversary-controlled context — agent forgets its role constraints.',                                  mitigations: ['Anchor checks at every tool call', 'Role assertion in pre-call gate'],                                                              references: ['OWASP LLM07:2025'] },
  { id: 'AAT-T3004', kind: 'technique', tactic: 'privilege-escalation', title: 'Cross-Agent Privilege Inheritance', summary: 'Agent B accepts handoff from compromised Agent A and inherits its (broader) capabilities without re-authorization.',                                 mitigations: ['Per-agent capability scoping at handoff', 'Re-validation on handoff'],                                                              references: [] },

  // Credential Access (T4xxx)
  { id: 'AAT-T4001', kind: 'technique', tactic: 'credential-access', title: 'Secret in Tool Arguments',       summary: 'API keys, bearer tokens, or service-account JSON appear in the args of an outbound tool call.',                                                          mitigations: ['Format-aware secret scanner', 'Reject-list common token shapes'],                                                                  references: ['OWASP LLM06:2025'] },
  { id: 'AAT-T4002', kind: 'technique', tactic: 'credential-access', title: 'Secret in Tool Output',           summary: 'Tool response contains secrets that the agent then exposes verbatim in its own output or downstream tool call.',                                          mitigations: ['Output-side secret scan', 'Redaction in trace persistence'],                                                                       references: [] },
  { id: 'AAT-T4003', kind: 'technique', tactic: 'credential-access', title: 'Private Key Exposure',            summary: 'PEM-format private key (RSA / EC / SSH) appears in agent context, tool args, or output.',                                                                mitigations: ['Header-string detector', 'Block-on-detect policy'],                                                                                references: [] },
  { id: 'AAT-T4004', kind: 'technique', tactic: 'credential-access', title: 'OAuth Token Leakage',             summary: 'Authorization-code or access-token strings cross trust boundaries via tool calls.',                                                                      mitigations: ['Token-shape scanner', 'Outbound URL allow-list'],                                                                                  references: [] },
  { id: 'AAT-T4005', kind: 'technique', tactic: 'credential-access', title: 'Session Token / Cookie Leakage',  summary: 'Session cookies, JWTs, or sticky-session identifiers leave the trust boundary.',                                                                         mitigations: ['Cookie-shape + JWT-shape detector'],                                                                                                references: [] },

  // Data Exfiltration (T5xxx)
  { id: 'AAT-T5001', kind: 'technique', tactic: 'data-exfiltration', title: 'Outbound Network with Sensitive Context', summary: 'Outbound HTTP / DNS / webhook tool fires shortly after the agent processes sensitive data — a likely exfil channel.',                              mitigations: ['Sensitive-context taint tracking', 'Cool-down between sensitive read and outbound write'],                                          references: [] },
  { id: 'AAT-T5002', kind: 'technique', tactic: 'data-exfiltration', title: 'External Recipient via Messaging',        summary: 'Email / Slack / messaging tool sends to a recipient outside the org\'s declared domain set.',                                                          mitigations: ['Recipient allow-list per tenant', 'Domain reputation lookup'],                                                                     references: [] },
  { id: 'AAT-T5003', kind: 'technique', tactic: 'data-exfiltration', title: 'Upload to External Destination',          summary: 'File-upload, presigned-URL POST, or cloud-bucket tool sends data to a destination outside the configured set.',                                       mitigations: ['Destination allow-list', 'Outbound size cap'],                                                                                      references: [] },
  { id: 'AAT-T5004', kind: 'technique', tactic: 'data-exfiltration', title: 'Large-Payload Outbound',                  summary: 'Single outbound payload exceeds a per-agent / per-session baseline by Nx — bulk-extract pattern.',                                                     mitigations: ['Per-agent egress baseline', 'Hard size cap policy'],                                                                                references: [] },
  { id: 'AAT-T5005', kind: 'technique', tactic: 'data-exfiltration', title: 'Encoded / Obfuscated Exfiltration',       summary: 'Sensitive data is base64 / hex / unicode-escape encoded then sent — bypasses naive string detectors.',                                                  mitigations: ['Multi-decode then re-scan', 'Entropy thresholding on outbound payloads'],                                                            references: [] },

  // Persistence (T6xxx)
  { id: 'AAT-T6001', kind: 'technique', tactic: 'persistence', title: 'Memory Poisoning',                      summary: 'Adversary causes the agent to write attacker-controlled content into long-term memory / scratchpad that influences future sessions.',                  mitigations: ['Memory-write audit', 'Provenance tag on memory entries', 'Block writes containing imperative-form text'],                            references: ['Pan et al., 2024 — "Memory Poisoning in LLM Agents"'] },
  { id: 'AAT-T6002', kind: 'technique', tactic: 'persistence', title: 'Instruction Stickiness Across Sessions', summary: 'Injected instructions persist across the agent\'s sessions via shared store, summary, or session-token replay.',                                          mitigations: ['Session boundary purge of derived instructions', 'Hash-on-summary integrity check'],                                                  references: [] },
  { id: 'AAT-T6003', kind: 'technique', tactic: 'persistence', title: 'Agent-Owned Artifact Backdoor',          summary: 'Agent creates a file, function, or workflow artifact that includes a backdoor for the adversary to invoke later.',                                       mitigations: ['Diff review on agent-created artifacts', 'Sandbox newly-created tools before exposing'],                                              references: [] },

  // Discovery (T7xxx)
  { id: 'AAT-T7001', kind: 'technique', tactic: 'discovery', title: 'Environment Enumeration',                  summary: 'Adversary uses the agent to list env vars, process list, mount points, or other host context.',                                                          mitigations: ['Refuse env-listing tools', 'Audit-on-enumerate policy'],                                                                            references: [] },
  { id: 'AAT-T7002', kind: 'technique', tactic: 'discovery', title: 'Credential Discovery',                     summary: 'Agent is induced to search filesystems, repos, or memory for credentials.',                                                                              mitigations: ['Refuse glob patterns matching credential filenames', 'Block-on-read of *.pem, *.key'],                                                references: [] },
  { id: 'AAT-T7003', kind: 'technique', tactic: 'discovery', title: 'Network Topology Mapping',                 summary: 'Agent probes internal hostnames, DNS records, or service discovery endpoints.',                                                                          mitigations: ['Internal-DNS allow-list', 'Anomaly on novel-host calls'],                                                                            references: [] },

  // Impact (T8xxx)
  { id: 'AAT-T8001', kind: 'technique', tactic: 'impact', title: 'Runaway Automation',                          summary: 'Agent enters a recursive / oscillating loop and consumes unbounded tool calls, cost, or external side effects.',                                       mitigations: ['Per-session call-rate cap', 'Recursion depth limit', 'Circuit breaker on no-progress'],                                                references: [] },
  { id: 'AAT-T8002', kind: 'technique', tactic: 'impact', title: 'Budget / Cost Burndown',                      summary: 'Adversary induces cost-amplifying tool calls (long-context, image-gen, expensive APIs) to drain budget.',                                              mitigations: ['Per-agent / per-tenant cost ceiling', 'Cost-spike anomaly'],                                                                          references: [] },
  { id: 'AAT-T8003', kind: 'technique', tactic: 'impact', title: 'Denial of Service',                           summary: 'Agent is induced to overload an internal or external service, or its own gateway.',                                                                     mitigations: ['QPS rate-limit per agent', 'Outbound-target rate cap'],                                                                                references: [] },
  { id: 'AAT-T8004', kind: 'technique', tactic: 'impact', title: 'Destructive Action',                          summary: 'Agent executes a destructive tool action — drop table, rm -rf, force-push, mass-delete.',                                                              mitigations: ['Two-stage approval for destructive verbs', 'Dry-run mode default'],                                                                    references: [] },

  // Defense Evasion (T9xxx)
  { id: 'AAT-T9001', kind: 'technique', tactic: 'defense-evasion', title: 'Argument Obfuscation',               summary: 'Adversary encodes tool args (unicode confusables, base64, splits) to evade keyword detectors.',                                                          mitigations: ['Normalize-then-detect', 'Multi-decode pipeline'],                                                                                       references: [] },
  { id: 'AAT-T9002', kind: 'technique', tactic: 'defense-evasion', title: 'Classifier Misdirection',            summary: 'Adversary frames a dangerous tool call in safe-looking language so the tool classifier mis-categorizes it.',                                            mitigations: ['Content-over-name precedence', 'Multi-signal classification'],                                                                          references: [] },
  { id: 'AAT-T9003', kind: 'technique', tactic: 'defense-evasion', title: 'Anomaly Window Probing',             summary: 'Adversary slowly increases tool-call frequency / scope to stay under sliding-window thresholds.',                                                       mitigations: ['Long-horizon baseline alongside short window', 'EWMA drift detection'],                                                                 references: [] },
  { id: 'AAT-T9004', kind: 'technique', tactic: 'defense-evasion', title: 'PII Pattern Evasion',                summary: 'Adversary breaks up or transforms PII to evade regex detectors (e.g. spaced SSN, unicode digits).',                                                     mitigations: ['Normalize digits, strip separators, then re-scan', 'Format-aware NER alongside regex'],                                                  references: [] },

  // Lateral Movement (T10xxx)
  { id: 'AAT-T10001', kind: 'technique', tactic: 'lateral-movement', title: 'Cross-Agent Trust Abuse',          summary: 'Agent B implicitly trusts Agent A\'s output; compromise of A propagates to B without re-validation.',                                                    mitigations: ['Treat sibling-agent output as untrusted by default', 'Re-classify on handoff'],                                                          references: [] },
  { id: 'AAT-T10002', kind: 'technique', tactic: 'lateral-movement', title: 'Session / Token Replay Across Agents', summary: 'Captured session token or auth credential is reused across agents within the same tenant to broaden access.',                                            mitigations: ['Per-agent token scope', 'Replay-window detection on session_id'],                                                                       references: [] },
]);

// ── Lookup helpers ────────────────────────────────────────────────────────

const _byId: ReadonlyMap<string, OntologyNode> = new Map(
  [...TACTICS, ...TECHNIQUES].map(n => [n.id, n]),
);

export function getNode(id: string): OntologyNode | undefined {
  return _byId.get(id);
}

export function isValidNodeId(id: string): boolean {
  return _byId.has(id);
}

export function listTechniquesFor(tactic: Tactic): readonly TechniqueNode[] {
  return TECHNIQUES.filter(t => t.tactic === tactic);
}

export function allNodes(): readonly OntologyNode[] {
  return [...TACTICS, ...TECHNIQUES];
}
