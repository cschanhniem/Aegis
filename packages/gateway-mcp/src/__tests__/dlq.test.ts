import Database from 'better-sqlite3';
import pino from 'pino';
import { DlqService } from '../services/dlq';

function setup() {
  return new DlqService(new Database(':memory:'), pino({ level: 'silent' }));
}

describe('DlqService', () => {
  it('enqueue + get round-trip', () => {
    const svc = setup();
    const id = svc.enqueue({
      orgId: 'org-1', trace_id: 't1', tool_name: 'db_update',
      compensator_kind: 'webhook',
      last_error: 'HTTP 503',
      attempts_made: 3,
      planned_action: { url: 'http://x/y', payload: { foo: 1 } },
    });
    const row = svc.get({ orgId: 'org-1', id })!;
    expect(row.trace_id).toBe('t1');
    expect(row.attempts_made).toBe(3);
    expect((row.planned_action as any).payload.foo).toBe(1);
    expect(row.status).toBe('pending');
  });

  it('list filters by status', () => {
    const svc = setup();
    const a = svc.enqueue({ orgId: 'org-1', trace_id: 't1', tool_name: 'x', compensator_kind: 'webhook', last_error: 'e', attempts_made: 1, planned_action: {} });
    svc.enqueue({ orgId: 'org-1', trace_id: 't2', tool_name: 'x', compensator_kind: 'webhook', last_error: 'e', attempts_made: 1, planned_action: {} });
    svc.dismiss({ orgId: 'org-1', id: a });
    expect(svc.list({ orgId: 'org-1', status: 'pending'    })).toHaveLength(1);
    expect(svc.list({ orgId: 'org-1', status: 'dismissed' })).toHaveLength(1);
  });

  it('markRetried only flips pending entries', () => {
    const svc = setup();
    const id = svc.enqueue({ orgId: 'org-1', trace_id: 't', tool_name: 'x', compensator_kind: 'webhook', last_error: 'e', attempts_made: 1, planned_action: {} });
    expect(svc.markRetried({ orgId: 'org-1', id })).toBe(true);
    expect(svc.get({ orgId: 'org-1', id })!.status).toBe('retried');
    // Already retried: subsequent retry no-ops
    expect(svc.markRetried({ orgId: 'org-1', id })).toBe(false);
  });

  it('dismiss only flips pending entries + carries note + actor', () => {
    const svc = setup();
    const id = svc.enqueue({ orgId: 'org-1', trace_id: 't', tool_name: 'x', compensator_kind: 'webhook', last_error: 'e', attempts_made: 1, planned_action: {} });
    expect(svc.dismiss({ orgId: 'org-1', id, actor: 'sre@acme', note: 'fixed by hand' })).toBe(true);
    const row = svc.get({ orgId: 'org-1', id })!;
    expect(row.status).toBe('dismissed');
    expect(row.resolved_by).toBe('sre@acme');
    expect(row.resolution_note).toBe('fixed by hand');
  });

  it('cross-tenant isolation', () => {
    const svc = setup();
    const a = svc.enqueue({ orgId: 'org-A', trace_id: 't', tool_name: 'x', compensator_kind: 'webhook', last_error: 'e', attempts_made: 1, planned_action: {} });
    expect(svc.get({ orgId: 'org-B', id: a })).toBeNull();
    expect(svc.markRetried({ orgId: 'org-B', id: a })).toBe(false);
    expect(svc.dismiss({ orgId: 'org-B', id: a })).toBe(false);
  });

  it('stats counts per status', () => {
    const svc = setup();
    svc.enqueue({ orgId: 'org-1', trace_id: 't1', tool_name: 'x', compensator_kind: 'w', last_error: 'e', attempts_made: 1, planned_action: {} });
    const i2 = svc.enqueue({ orgId: 'org-1', trace_id: 't2', tool_name: 'x', compensator_kind: 'w', last_error: 'e', attempts_made: 1, planned_action: {} });
    const i3 = svc.enqueue({ orgId: 'org-1', trace_id: 't3', tool_name: 'x', compensator_kind: 'w', last_error: 'e', attempts_made: 1, planned_action: {} });
    svc.markRetried({ orgId: 'org-1', id: i2 });
    svc.dismiss({ orgId: 'org-1', id: i3 });
    expect(svc.stats('org-1')).toEqual({ pending: 1, retried: 1, dismissed: 1 });
  });
});
