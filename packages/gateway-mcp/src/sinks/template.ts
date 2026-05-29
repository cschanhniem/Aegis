/**
 * Field-mapping template engine — flat, dotted-path JSONPath-lite.
 *
 *   { message: "decision=${event.payload.decision}", host: "${event.tenantId}" }
 *
 * Expressions inside `${...}` are dotted paths into the SinkEvent. Any
 * missing path resolves to empty string. No conditionals, no loops, no
 * function calls — anyone who needs that writes a custom Sink.
 */

import { SinkEvent, FieldMapping } from '@agentguard/core-schema';

const EXPR = /\$\{([a-zA-Z0-9_.]+)\}/g;

function dottedGet(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let cur: any = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function interpolate(template: string, event: SinkEvent): string {
  return template.replace(EXPR, (_match, path: string) => {
    const v = dottedGet({ event }, path);
    if (v === undefined || v === null) return '';
    if (typeof v === 'string') return v;
    return JSON.stringify(v);
  });
}

export function applyMapping(
  event: SinkEvent,
  mapping: FieldMapping | undefined,
): Record<string, unknown> {
  if (!mapping || Object.keys(mapping).length === 0) {
    // No mapping = pass through the raw event so customers can capture
    // everything AEGIS knows about a record.
    return {
      kind: event.kind,
      tenantId: event.tenantId,
      timestamp: event.timestamp,
      ...event.payload,
    };
  }
  const out: Record<string, unknown> = {};
  for (const [target, template] of Object.entries(mapping)) {
    out[target] = interpolate(template, event);
  }
  return out;
}
