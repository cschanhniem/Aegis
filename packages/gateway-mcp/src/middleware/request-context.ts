/**
 * Request context middleware — adds request ID, structured access logging,
 * and correlation headers for production observability.
 */

import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { Logger } from 'pino';

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      startTime?: number;
      /** Trace ID parsed from inbound W3C `traceparent` header (32-hex). */
      traceId?: string;
      /** Parent span ID parsed from inbound `traceparent` (16-hex). */
      parentSpanId?: string;
      /** Pass-through header value — propagate verbatim downstream. */
      traceparent?: string;
      tracestate?: string;
    }
  }
}

/** Parse a W3C `traceparent` header.
 *  Format: `00-<32-hex trace-id>-<16-hex parent-id>-<2-hex flags>` */
function parseTraceparent(h?: string): { traceId: string; spanId: string } | null {
  if (!h) return null;
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i.exec(h.trim());
  if (!m) return null;
  // Reject the all-zero IDs (per W3C spec they're invalid).
  if (/^0+$/.test(m[1]) || /^0+$/.test(m[2])) return null;
  return { traceId: m[1].toLowerCase(), spanId: m[2].toLowerCase() };
}

export function requestContextMiddleware(logger: Logger) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Use incoming request ID or generate one
    const requestId = (req.headers['x-request-id'] as string) || randomUUID();
    req.requestId = requestId;
    req.startTime = Date.now();

    // Continue the customer's W3C trace if they sent one. Their Datadog
    // / Honeycomb / Tempo wants to see the AEGIS gateway as a child
    // span in the same trace; without parsing this header, every audit
    // log line below gets a fresh trace id and the distributed picture
    // is broken across the gateway hop.
    const tp = (req.headers['traceparent'] as string) || undefined;
    const ts = (req.headers['tracestate'] as string) || undefined;
    const parsed = parseTraceparent(tp);
    if (parsed) {
      req.traceId = parsed.traceId;
      req.parentSpanId = parsed.spanId;
      req.traceparent = tp;
      req.tracestate = ts;
    }

    // Set response headers
    res.setHeader('X-Request-ID', requestId);
    if (tp) res.setHeader('traceparent', tp);

    // Access log on response finish
    res.on('finish', () => {
      const duration = Date.now() - (req.startTime ?? Date.now());
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      logger[level]({
        req_id: requestId,
        // trace_id flows into every line — this is what makes the
        // SRE's "click a span, jump to logs" pivot work in Datadog /
        // Loki / Honeycomb.
        trace_id: req.traceId,
        parent_span_id: req.parentSpanId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: duration,
        org_id: req.orgId,
        ip: req.ip,
        user_agent: req.headers['user-agent']?.substring(0, 80),
      }, `${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    });

    next();
  };
}
