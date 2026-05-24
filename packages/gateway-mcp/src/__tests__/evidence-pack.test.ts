/**
 * EvidencePackService — service-layer tests with a seeded in-memory
 * DB. Endpoint-level smoke covered by the same harness pattern used
 * for code-shield-api / alignment-api.
 */

import pino from 'pino';
import Database from 'better-sqlite3';
import { initializeEnterpriseSchema } from '../db/enterprise-schema';
import { initializeDatabase } from '../db/database';
import { AuditLogService } from '../services/audit-log';
import { EvidencePackService } from '../services/evidence-pack';

const silent = pino({ level: 'silent' });

async function makeStack() {
  // Use the real init path so we get traces/policies tables + the
  // enterprise schema in one shot. Then layer audit-log.
  const db = await initializeDatabase(':memory:');
  initializeEnterpriseSchema(db);
  const audit = new AuditLogService(db, silent);
  const svc = new EvidencePackService(db, silent);
  return { db, audit, svc };
}

describe('EvidencePackService.build', () => {
  test('empty system → all sections present but minimal', async () => {
    const { svc } = await makeStack();
    const pack = svc.build('default');
    expect(pack.meta.version).toBe('1.0');
    expect(pack.meta.org_id).toBe('default');
    expect(typeof pack.meta.generated_at).toBe('string');
    expect(Array.isArray(pack.audit_log)).toBe(true);
    expect(pack.integrity.total_agents).toBe(0);
    expect(pack.trace_counts).toEqual([]);
  });

  test('audit_log includes injected rows scoped to org', async () => {
    const { audit, svc } = await makeStack();
    audit.log({
      org_id: 'default', action: 'tenant.config.update', resource_type: 'system',
      resource_id: 'default', details: { rules: 3 }, ip_address: '127.0.0.1',
    });
    audit.log({
      org_id: 'other-org', action: 'policy.create', resource_type: 'policy',
      resource_id: 'p1', details: {}, ip_address: '127.0.0.1',
    });
    const pack = svc.build('default');
    // Should include the 'default' row and any org_id IS NULL rows;
    // 'other-org' row must NOT leak.
    const actions = pack.audit_log.map((r: any) => r.action);
    expect(actions).toContain('tenant.config.update');
    expect(actions).not.toContain('policy.create');
  });

  test('audit_log details JSON is parsed, not left as a string', async () => {
    const { audit, svc } = await makeStack();
    audit.log({
      org_id: 'default', action: 'tenant.config.update', resource_type: 'system',
      details: { rules: 7, mode: 'strict' },
    });
    const pack = svc.build('default');
    const row = pack.audit_log[pack.audit_log.length - 1] as any;
    expect(typeof row.details).toBe('object');
    expect(row.details.rules).toBe(7);
  });

  test('maxRowsPerTable caps the audit dump', async () => {
    const { audit, svc } = await makeStack();
    // Seed 5 rows; cap at 2.
    for (let i = 0; i < 5; i++) {
      audit.log({
        org_id: 'default', action: 'tenant.config.update', resource_type: 'system',
        details: { i },
      });
    }
    const pack = svc.build('default', { maxRowsPerTable: 2 });
    expect(pack.audit_log.length).toBe(2);
  });

  test('integrity section reflects current trace state', async () => {
    const { db, svc } = await makeStack();
    db.prepare(
      `INSERT INTO traces
       (trace_id, agent_id, timestamp, sequence_number,
        input_context, thought_chain, tool_call, observation,
        integrity_hash, previous_hash, environment, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      't-1', 'agent-x', '2026-05-20T00:00:00Z', 1,
      '{}', '{}', '{}', '{}', 'h1', null, 'PRODUCTION', '1.0.0',
    );

    const pack = svc.build('default');
    expect(pack.integrity.total_agents).toBe(1);
    expect(pack.trace_counts.length).toBe(1);
    expect(pack.trace_counts[0].agent_id).toBe('agent-x');
    expect(pack.trace_counts[0].count).toBe(1);
    expect(pack.trace_counts[0].latest_trace_id).toBe('t-1');
  });

  test('pack is JSON-serializable (no circular refs, no functions)', async () => {
    const { audit, svc } = await makeStack();
    audit.log({
      org_id: 'default', action: 'tenant.config.update', resource_type: 'system',
      details: { x: 1 },
    });
    const pack = svc.build('default');
    // Round-trip — if any field has a non-serializable value, this throws.
    const round = JSON.parse(JSON.stringify(pack));
    expect(round.meta.org_id).toBe('default');
    expect(round.audit_log.length).toBe(1);
  });
});
