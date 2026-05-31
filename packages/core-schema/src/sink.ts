/**
 * Universal Sink contract.
 *
 * One AEGIS event → N sinks. Customers register sinks per-tenant; AEGIS
 * fans every audit / decision / signal record out without us writing a
 * dedicated Splunk / Datadog / Sumo / QRadar adapter. The contract is the
 * universal interface; built-in `http` + `syslog` + `stdout` kinds cover
 * ~all SIEM and observability endpoints in use today (they all accept JSON
 * over HTTP/TLS or RFC5424 over TCP).
 *
 * Field-mapping is a flat string-template map. Sources are JSONPath-lite
 * (dotted paths into the event object); targets are flat string keys in
 * the outbound payload. This is intentionally minimal — anyone who needs
 * SIEM-grade ECS / CEF transformation drops a custom Sink, they don't
 * argue with our template language.
 */

import { z } from 'zod';

export const SinkKindSchema = z.enum(['http', 'syslog', 'stdout', 'kafka', 'nats']);
export type SinkKind = z.infer<typeof SinkKindSchema>;

export const FieldMappingSchema = z.record(z.string(), z.string());
export type FieldMapping = z.infer<typeof FieldMappingSchema>;

export const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10).default(3),
  backoffMs: z.number().int().min(0).max(60_000).default(500),
  /** Multiplier applied per attempt: backoffMs * factor^attempt. */
  factor: z.number().min(1).max(8).default(2),
});
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

export const HttpSinkConfigSchema = z.object({
  kind: z.literal('http'),
  name: z.string().min(1).max(64),
  enabled: z.boolean().default(true),
  url: z.string().url(),
  method: z.enum(['POST', 'PUT']).default('POST'),
  headers: z.record(z.string()).default({}),
  /** Optional secret reference resolved server-side at send time. */
  authHeader: z.string().optional(),                  // e.g. "Splunk <token>"
  fieldMapping: FieldMappingSchema.optional(),        // omit = forward raw
  retry: RetryPolicySchema.default({ maxAttempts: 3, backoffMs: 500, factor: 2 }),
  /** Hard timeout per attempt. */
  timeoutMs: z.number().int().min(100).max(60_000).default(5_000),
});
export type HttpSinkConfig = z.infer<typeof HttpSinkConfigSchema>;

export const SyslogSinkConfigSchema = z.object({
  kind: z.literal('syslog'),
  name: z.string().min(1).max(64),
  enabled: z.boolean().default(true),
  host: z.string(),
  port: z.number().int().min(1).max(65535).default(514),
  protocol: z.enum(['tcp', 'udp']).default('tcp'),
  facility: z.number().int().min(0).max(23).default(16),  // local0
  appName: z.string().default('aegis'),
  fieldMapping: FieldMappingSchema.optional(),
  retry: RetryPolicySchema.default({ maxAttempts: 3, backoffMs: 500, factor: 2 }),
  timeoutMs: z.number().int().min(100).max(60_000).default(5_000),
});
export type SyslogSinkConfig = z.infer<typeof SyslogSinkConfigSchema>;

export const StdoutSinkConfigSchema = z.object({
  kind: z.literal('stdout'),
  name: z.string().min(1).max(64),
  enabled: z.boolean().default(true),
  fieldMapping: FieldMappingSchema.optional(),
});
export type StdoutSinkConfig = z.infer<typeof StdoutSinkConfigSchema>;

export const KafkaSaslSchema = z.object({
  mechanism: z.enum(['plain', 'scram-sha-256', 'scram-sha-512']),
  username: z.string().min(1).max(120),
  password: z.string().min(1).max(500),
}).strict();

export const KafkaSinkConfigSchema = z.object({
  kind: z.literal('kafka'),
  name: z.string().min(1).max(64),
  enabled: z.boolean().default(true),
  /** Bootstrap servers, e.g. ["broker1:9092", "broker2:9092"]. */
  brokers: z.array(z.string().min(3)).min(1).max(16),
  topic: z.string().min(1).max(200),
  clientId: z.string().min(1).max(120).default('aegis-sink'),
  ssl: z.union([z.boolean(), z.object({ rejectUnauthorized: z.boolean().optional() })]).optional(),
  sasl: KafkaSaslSchema.optional(),
  /** Optional Kafka message key derived from a dotted event path. */
  keyPath: z.string().max(120).optional(),
  fieldMapping: FieldMappingSchema.optional(),
  retry: RetryPolicySchema.default({ maxAttempts: 3, backoffMs: 500, factor: 2 }),
  timeoutMs: z.number().int().min(100).max(60_000).default(5_000),
});
export type KafkaSinkConfig = z.infer<typeof KafkaSinkConfigSchema>;

export const NatsSinkConfigSchema = z.object({
  kind: z.literal('nats'),
  name: z.string().min(1).max(64),
  enabled: z.boolean().default(true),
  /** Server URLs, e.g. ["nats://prod-1:4222", "nats://prod-2:4222"]. */
  servers: z.array(z.string().min(7)).min(1).max(16),
  subject: z.string().min(1).max(200),
  user: z.string().min(1).max(120).optional(),
  pass: z.string().min(1).max(500).optional(),
  token: z.string().min(1).max(500).optional(),
  fieldMapping: FieldMappingSchema.optional(),
  retry: RetryPolicySchema.default({ maxAttempts: 3, backoffMs: 500, factor: 2 }),
  timeoutMs: z.number().int().min(100).max(60_000).default(5_000),
});
export type NatsSinkConfig = z.infer<typeof NatsSinkConfigSchema>;

export const SinkConfigSchema = z.discriminatedUnion('kind', [
  HttpSinkConfigSchema,
  SyslogSinkConfigSchema,
  StdoutSinkConfigSchema,
  KafkaSinkConfigSchema,
  NatsSinkConfigSchema,
]);
export type SinkConfig = z.infer<typeof SinkConfigSchema>;

/**
 * Categories the runtime can route. `audit` mirrors admin_audit_log;
 * `decision` mirrors /check + DSL outcomes; `signal` mirrors Detector
 * output; `evidence-pack` mirrors signed bundle publication.
 */
export type SinkEventKind = 'audit' | 'decision' | 'signal' | 'evidence-pack';

export interface SinkEvent {
  readonly kind: SinkEventKind;
  readonly tenantId?: string;
  readonly timestamp: string;          // ISO8601
  readonly payload: Record<string, unknown>;
}

export interface SinkSendResult {
  readonly ok: boolean;
  readonly attempts: number;
  readonly status?: number;
  readonly error?: string;
  readonly durationMs: number;
}

export interface Sink {
  readonly name: string;
  readonly kind: SinkKind;
  send(event: SinkEvent): Promise<SinkSendResult>;
  close?(): Promise<void> | void;
}
