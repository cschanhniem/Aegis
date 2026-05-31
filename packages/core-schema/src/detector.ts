/**
 * Detector plugin contract.
 *
 * Every signal-producing component in AEGIS — PII scanner, anomaly model,
 * tool classifier, secret/exfil/IPI detector, customer plugin — implements
 * the same `Detector` interface. The runtime walks a `DetectorRegistry`
 * during /check and /traces, aggregates `Signal[]`, and hands them to the
 * decision layer (DSL, policy engine, sink/transparency log).
 *
 * Design choices:
 *
 *   • Stateful detectors (anomaly, drift) hold their state internally and
 *     are constructed with whatever per-runtime dependencies they need.
 *     The contract does not impose a state-shape — only an evaluate() shape.
 *
 *   • Detectors are pure inspectors. They do NOT make allow/deny decisions.
 *     They emit Signal records; the DSL / policy layer composes those into
 *     decisions. This keeps detection extensible without giving plugins a
 *     bypass over policy.
 *
 *   • `category` is a free-form string in v1 so detectors can ship before
 *     the Threat Ontology lands. Once ontology v1 publishes, detectors set
 *     `ontology: ['AAT-T1234', …]` and the registry validates IDs exist.
 */

import { z } from 'zod';

export const SeveritySchema = z.enum(['info', 'warn', 'critical']);
export type Severity = z.infer<typeof SeveritySchema>;

export const DetectorKindSchema = z.enum([
  'content',   // inspects tool args / outputs (PII, secret, prompt-injection)
  'behavior',  // inspects sequence-over-time (anomaly, drift, baseline)
  'classify',  // assigns category labels (tool classifier)
  'meta',      // inspects other detector signals (correlator, cross-agent)
]);
export type DetectorKind = z.infer<typeof DetectorKindSchema>;

/**
 * What a detector produces. One detector → zero-or-more signals per call.
 * Multiple low-severity signals from the same detector are allowed
 * (e.g. PII detector emits one per match type).
 */
export const SignalSchema = z.object({
  detector: z.string(),               // detector name that emitted this
  version: z.string(),                // detector version, semver-ish
  severity: SeveritySchema,
  category: z.string(),               // free-form v1; ontology ID later
  message: z.string(),                // human-readable summary
  evidence: z.record(z.any()).optional(),
  ontology: z.array(z.string()).optional(),   // AAT-Txxxx node IDs covered
});
export type Signal = z.infer<typeof SignalSchema>;

/**
 * Read-only snapshot of the call AEGIS is inspecting. Detectors must treat
 * this as immutable — anything they want to track across calls goes in
 * their own internal state.
 */
export interface DetectorContext {
  readonly tool: {
    readonly name: string;
    readonly args: Record<string, unknown>;
  };
  readonly agent: { readonly id: string };
  readonly tenant: { readonly id: string };
  readonly session?: { readonly id: string };
  /** Upstream detector results, populated as the chain runs. Lets a
   *  meta-detector see what content/behavior detectors already emitted. */
  readonly upstream?: ReadonlyArray<Signal>;
  /** Adversary-controlled conversation surface. When the LLM egress proxy
   *  is in the loop, it pulls earlier-turn tool results out of the request
   *  body and surfaces them here so the IPI detector can scan retrieved
   *  content for embedded instructions. Treat every string in this object
   *  as untrusted regardless of who returned it. */
  readonly conversation?: {
    /** Text blocks that came from tool / function-call results in
     *  prior turns. Web pages, RAG hits, file contents, email bodies,
     *  anything the LLM read from a tool. */
    readonly toolResultContent?: ReadonlyArray<string>;
    /** Direct user input in this turn — kept separate so trust
     *  boundaries are explicit in detector logic. */
    readonly userInput?: string;
  };
}

export interface Detector {
  readonly name: string;                  // unique within a registry
  readonly version: string;
  readonly kind: DetectorKind;
  /**
   * Ontology nodes this detector claims to cover (AAT-T* IDs from
   * @agentguard/core-schema/ontology). Used to build the per-tenant coverage
   * map at GET /api/v1/ontology/coverage. Detectors MAY emit signals
   * outside their declared coverage (taxonomy lags reality), but the
   * coverage map is the contract customers compare vendors against.
   */
  readonly coverage?: ReadonlyArray<string>;
  /** Optional one-time setup. Registry awaits this before first evaluate. */
  init?(): Promise<void> | void;
  evaluate(ctx: DetectorContext): Promise<Signal[]> | Signal[];
}
