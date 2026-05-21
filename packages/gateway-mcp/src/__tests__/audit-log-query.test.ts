/**
 * AuditLogService.query — service-layer tests for the new
 * resource_id and free-text `q` filters. Endpoint-level coverage
 * (admin.ts /audit-log) is in api-smoke / audit-log-api tests.
 */

import pino from 'pino';
import Database from 'better-sqlite3';
import { initializeEnterpriseSchema } from '../db/enterprise-schema';
import { AuditLogService } from '../services/audit-log';

const silent = pino({ level: 'silent' });

function makeAudit() {
  const db = new Database(':memory:');
  initializeEnterpriseSchema(db);
  const audit = new AuditLogService(db, silent);
  return { db, audit };
}

describe('AuditLogService.query — new filters', () => {
  test('resource_id matches exactly', () => {
    const { audit } = makeAudit();
    audit.log({ action: 'org.create', resource_type: 'organization', resource_id: 'org-A', details: {} });
    audit.log({ action: 'org.create', resource_type: 'organization', resource_id: 'org-B', details: {} });
    audit.log({ action: 'org.update', resource_type: 'organization', resource_id: 'org-A', details: {} });

    const { entries, total } = audit.query({ resource_id: 'org-A' });
    expect(total).toBe(2);
    expect(entries.every((e: any) => e.resource_id === 'org-A')).toBe(true);
  });

  test('q does substring match across action, resource_id, and details', () => {
    const { audit } = makeAudit();
    audit.log({ action: 'judge.trace', resource_type: 'agent', resource_id: 'agent-AAA', details: { kind: 'alignment', signals: ['scope-expansion'] } });
    audit.log({ action: 'org.update', resource_type: 'organization', resource_id: 'org-BBB', details: { plan: 'enterprise' } });
    audit.log({ action: 'retention.purge', resource_type: 'retention', details: { rows_deleted: 42 } });

    // Match in action.
    expect(audit.query({ q: 'judge' }).total).toBe(1);
    // Match in resource_id.
    expect(audit.query({ q: 'BBB' }).total).toBe(1);
    // Match in details (JSON string).
    expect(audit.query({ q: 'scope-expansion' }).total).toBe(1);
    expect(audit.query({ q: 'enterprise' }).total).toBe(1);
    // No matches → empty.
    expect(audit.query({ q: 'nothing-matches-this-string-xyz' }).total).toBe(0);
  });

  test('q + resource_id combine with AND', () => {
    const { audit } = makeAudit();
    audit.log({ action: 'judge.trace', resource_type: 'agent', resource_id: 'agent-A', details: { kind: 'alignment' } });
    audit.log({ action: 'judge.trace', resource_type: 'agent', resource_id: 'agent-A', details: { kind: 'code_shield' } });
    audit.log({ action: 'judge.trace', resource_type: 'agent', resource_id: 'agent-B', details: { kind: 'alignment' } });

    // Only the alignment row on agent-A.
    const r = audit.query({ resource_id: 'agent-A', q: 'alignment' });
    expect(r.total).toBe(1);
    expect(r.entries[0].details.kind).toBe('alignment');
  });

  test('blank or whitespace-only q is ignored', () => {
    const { audit } = makeAudit();
    audit.log({ action: 'judge.trace', resource_type: 'agent', details: {} });
    audit.log({ action: 'policy.create', resource_type: 'policy', details: {} });

    expect(audit.query({ q: '' }).total).toBe(2);
    expect(audit.query({ q: '   ' }).total).toBe(2);
  });

  test('q trims whitespace before matching', () => {
    const { audit } = makeAudit();
    audit.log({ action: 'judge.trace', resource_type: 'agent', details: {} });
    expect(audit.query({ q: '  judge  ' }).total).toBe(1);
  });
});
