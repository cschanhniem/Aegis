/**
 * Canonical SHA-256 over the trace content tuple.
 *
 * Producer (api/traces.ts) and verifier (services/integrity.ts) share
 * this single source of truth. Lives in the services/ layer so the
 * service layer does NOT have to import the api/ layer — that
 * direction is a layering violation that breaks dependency-graph
 * acyclicity rules.
 *
 * Canonical form: deterministic JSON of {input_context, thought_chain,
 * tool_call, observation}. Order matters because JSON.stringify
 * preserves insertion order; do NOT reorder these without bumping a
 * content-hash version bound to existing rows.
 */
import { createHash } from 'crypto';

export function computeContentHash(
  input_context: unknown,
  thought_chain: unknown,
  tool_call: unknown,
  observation: unknown,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({ input_context, thought_chain, tool_call, observation }),
    )
    .digest('hex');
}
