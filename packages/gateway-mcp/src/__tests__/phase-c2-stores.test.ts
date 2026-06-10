/**
 * Phase C.2 store tests — final batch of dual-backend Postgres
 * migration tests. Covers the 8 remaining tables:
 *
 *   - OrganizationsStore   (org root record + settings JSON column
 *                          which is where tenant_config lives)
 *   - LegacyApiKeysStore   (v0 single-shared key)
 *   - OrgApiKeysStore      (per-org scoped keys)
 *   - WitnessStore         (transparency_witness + cosignature)
 *   - SagaStore            (saga + saga_step state machine)
 *   - SnapshotStore        (trace_snapshot for rollback compensators)
 */
import Database from 'better-sqlite3';
import { newDb } from 'pg-mem';
import { createHash, randomUUID } from 'crypto';

import {
  SqliteOrganizationsStore, PostgresOrganizationsStore, type OrganizationsStore,
  SqliteLegacyApiKeysStore, PostgresLegacyApiKeysStore, type LegacyApiKeysStore,
  SqliteOrgApiKeysStore,    PostgresOrgApiKeysStore,    type OrgApiKeysStore,
} from '../db/identity-stores';
import { SqliteWitnessStore,  PostgresWitnessStore,  type WitnessStore }  from '../db/witness-store';
import { SqliteSagaStore,     PostgresSagaStore,     type SagaStore }     from '../db/saga-store';
import { SqliteSnapshotStore, PostgresSnapshotStore, type SnapshotStore } from '../db/snapshot-store';

function makePool(): any {
  const { Pool } = newDb().adapters.createPg();
  return new Pool();
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// ── OrganizationsStore ──────────────────────────────────────────────

function runOrgs(name: string, make: () => Promise<OrganizationsStore>) {
  describe(`OrganizationsStore (${name})`, () => {
    let s: OrganizationsStore;
    beforeEach(async () => { s = await make(); });
    afterEach(async () => { await s.close(); });

    test('insert + get round-trips', async () => {
      await s.insert({ id: 'acme', name: 'Acme Corp', slug: 'acme-corp', plan: 'enterprise' });
      const row = await s.get('acme');
      expect(row?.name).toBe('Acme Corp');
      expect(row?.plan).toBe('enterprise');
    });

    test('getBySlug works', async () => {
      await s.insert({ id: 'acme', name: 'Acme', slug: 'acme-co' });
      const row = await s.getBySlug('acme-co');
      expect(row?.id).toBe('acme');
    });

    test('updateSettings stores arbitrary JSON (tenant_config persistence)', async () => {
      await s.insert({ id: 'acme', name: 'Acme', slug: 'a' });
      const cfg = JSON.stringify({ deploymentMode: 'financial', sso: { enabled: true } });
      expect(await s.updateSettings('acme', cfg)).toBe(true);
      const row = await s.get('acme');
      expect(JSON.parse(row!.settings).deploymentMode).toBe('financial');
    });

    test('list returns rows in creation order', async () => {
      await s.insert({ id: 'a', name: 'A', slug: 'a' });
      await s.insert({ id: 'b', name: 'B', slug: 'b' });
      const list = await s.list();
      expect(list.map(o => o.id)).toEqual(['a', 'b']);
    });

    test('delete removes the row', async () => {
      await s.insert({ id: 'gone', name: 'G', slug: 'g' });
      expect(await s.delete('gone')).toBe(true);
      expect(await s.get('gone')).toBeNull();
    });
  });
}
runOrgs('Sqlite',   async () => { const s = new SqliteOrganizationsStore(new Database(':memory:')); await s.init(); return s; });
runOrgs('Postgres', async () => { const s = new PostgresOrganizationsStore(makePool()); await s.init(); return s; });

// ── LegacyApiKeysStore ──────────────────────────────────────────────

function runLegacyKeys(name: string, make: () => Promise<LegacyApiKeysStore>) {
  describe(`LegacyApiKeysStore (${name})`, () => {
    let s: LegacyApiKeysStore;
    beforeEach(async () => { s = await make(); });
    afterEach(async () => { await s.close(); });

    test('insert + findByHash works', async () => {
      await s.insert({ agent_id: 'a1', key_hash: sha('secret') });
      const row = await s.findByHash(sha('secret'));
      expect(row?.agent_id).toBe('a1');
      expect(row?.status).toBe('ACTIVE');
    });

    test('revoke removes ACTIVE state; findByHash returns null', async () => {
      await s.insert({ agent_id: 'a1', key_hash: sha('s') });
      expect(await s.revoke('a1', 'compromised')).toBe(true);
      expect(await s.findByHash(sha('s'))).toBeNull();
      const row = await s.findByAgent('a1');
      expect(row?.status).toBe('REVOKED');
      expect(row?.revocation_reason).toBe('compromised');
    });

    test('restore reactivates a revoked key', async () => {
      await s.insert({ agent_id: 'a1', key_hash: sha('s') });
      await s.revoke('a1');
      expect(await s.restore('a1')).toBe(true);
      expect((await s.findByAgent('a1'))?.status).toBe('ACTIVE');
    });
  });
}
runLegacyKeys('Sqlite',   async () => { const s = new SqliteLegacyApiKeysStore(new Database(':memory:')); await s.init(); return s; });
runLegacyKeys('Postgres', async () => { const s = new PostgresLegacyApiKeysStore(makePool()); await s.init(); return s; });

// ── OrgApiKeysStore ─────────────────────────────────────────────────

function runOrgKeys(name: string, make: () => Promise<OrgApiKeysStore>) {
  describe(`OrgApiKeysStore (${name})`, () => {
    let s: OrgApiKeysStore;
    beforeEach(async () => { s = await make(); });
    afterEach(async () => { await s.close(); });

    test('insert + findActiveByHash works', async () => {
      const id = randomUUID();
      await s.insert({
        id, org_id: 'acme', key_hash: sha('p1'), key_prefix: 'aeg_abc',
        name: 'CI bot', scopes: '["*"]',
      });
      const row = await s.findActiveByHash(sha('p1'));
      expect(row?.id).toBe(id);
      expect(row?.org_id).toBe('acme');
    });

    test('revoke makes the key inactive', async () => {
      const id = randomUUID();
      await s.insert({ id, org_id: 'acme', key_hash: sha('p'), key_prefix: 'aeg_x' });
      expect(await s.revoke('acme', id)).toBe(true);
      expect(await s.findActiveByHash(sha('p'))).toBeNull();
    });

    test('cross-tenant revoke returns false', async () => {
      const id = randomUUID();
      await s.insert({ id, org_id: 'acme', key_hash: sha('p'), key_prefix: 'aeg_x' });
      expect(await s.revoke('beta', id)).toBe(false);
      expect(await s.findActiveByHash(sha('p'))).not.toBeNull();
    });

    test('listForOrg scopes results', async () => {
      await s.insert({ id: randomUUID(), org_id: 'a', key_hash: sha('k1'), key_prefix: 'aeg_a1' });
      await s.insert({ id: randomUUID(), org_id: 'a', key_hash: sha('k2'), key_prefix: 'aeg_a2' });
      await s.insert({ id: randomUUID(), org_id: 'b', key_hash: sha('k3'), key_prefix: 'aeg_b1' });
      expect((await s.listForOrg('a')).length).toBe(2);
      expect((await s.listForOrg('b')).length).toBe(1);
    });

    test('touchLastUsed updates last_used_at without other changes', async () => {
      const id = randomUUID();
      await s.insert({ id, org_id: 'acme', key_hash: sha('t'), key_prefix: 'aeg_t' });
      const before = await s.findActiveByHash(sha('t'));
      expect(before?.last_used_at).toBeNull();
      await s.touchLastUsed(id);
      const after = await s.findActiveByHash(sha('t'));
      expect(after?.last_used_at).not.toBeNull();
    });
  });
}
runOrgKeys('Sqlite',   async () => { const s = new SqliteOrgApiKeysStore(new Database(':memory:')); await s.init(); return s; });
runOrgKeys('Postgres', async () => { const s = new PostgresOrgApiKeysStore(makePool()); await s.init(); return s; });

// ── WitnessStore ────────────────────────────────────────────────────

function runWitness(name: string, make: () => Promise<WitnessStore>) {
  describe(`WitnessStore (${name})`, () => {
    let s: WitnessStore;
    beforeEach(async () => { s = await make(); });
    afterEach(async () => { await s.close(); });

    test('register + list witnesses scoped per org', async () => {
      await s.registerWitness({ id: 'w1', orgId: 'acme', name: 'sigstore', publicKeyPem: '-----BEGIN-----xxx-----END-----' });
      await s.registerWitness({ id: 'w2', orgId: 'beta', name: 'external', publicKeyPem: '-----BEGIN-----yyy-----END-----' });
      expect((await s.listWitnesses('acme')).length).toBe(1);
      expect((await s.listWitnesses('beta')).length).toBe(1);
    });

    test('deactivate flips active=0; active_only filter respects it', async () => {
      await s.registerWitness({ id: 'w1', orgId: 'acme', name: 'w', publicKeyPem: 'xxx' });
      await s.deactivateWitness('acme', 'w1');
      expect((await s.listWitnesses('acme', { active_only: true })).length).toBe(0);
      expect((await s.listWitnesses('acme')).length).toBe(1);   // still in table
    });

    test('cross-tenant deactivate returns false', async () => {
      await s.registerWitness({ id: 'w1', orgId: 'acme', name: 'w', publicKeyPem: 'xxx' });
      expect(await s.deactivateWitness('beta', 'w1')).toBe(false);
      expect((await s.getWitness('w1'))?.active).toBe(1);
    });

    test('insertCosignature + findCosignaturesForRoot', async () => {
      await s.registerWitness({ id: 'w1', orgId: 'acme', name: 'w', publicKeyPem: 'xxx' });
      await s.insertCosignature({ witness_id: 'w1', tree_size: 100, root_hash: 'root-aaa', signature: 'sig1' });
      await s.insertCosignature({ witness_id: 'w1', tree_size: 200, root_hash: 'root-bbb', signature: 'sig2' });
      const aaa = await s.findCosignaturesForRoot('root-aaa');
      expect(aaa.length).toBe(1);
      expect(aaa[0].tree_size).toBe(100);
    });
  });
}
runWitness('Sqlite',   async () => { const s = new SqliteWitnessStore(new Database(':memory:')); await s.init(); return s; });
runWitness('Postgres', async () => { const s = new PostgresWitnessStore(makePool()); await s.init(); return s; });

// ── SagaStore ───────────────────────────────────────────────────────

function runSaga(name: string, make: () => Promise<SagaStore>) {
  describe(`SagaStore (${name})`, () => {
    let s: SagaStore;
    beforeEach(async () => { s = await make(); });
    afterEach(async () => { await s.close(); });

    test('open + get + transition lifecycle', async () => {
      await s.open({ id: 'g1', org_id: 'acme', kind: 'rollback', agent_id: 'a1' });
      expect((await s.get('acme', 'g1'))?.state).toBe('STARTED');
      expect(await s.transition('acme', 'g1', 'COMPLETED')).toBe(true);
      const row = await s.get('acme', 'g1');
      expect(row?.state).toBe('COMPLETED');
      expect(row?.completed_at).not.toBeNull();
    });

    test('appendStep increments step_count', async () => {
      await s.open({ id: 'g2', org_id: 'acme', kind: 'rb' });
      await s.appendStep({ saga_id: 'g2', step_idx: 0, trace_id: 't1', outcome: 'rolled_back', compensator_kind: 'noop', duration_ms: 10 });
      await s.appendStep({ saga_id: 'g2', step_idx: 1, trace_id: 't2', outcome: 'rolled_back', compensator_kind: 'noop', duration_ms: 20 });
      const row = await s.get('acme', 'g2');
      expect(row?.step_count).toBe(2);
      expect((await s.listSteps('g2')).length).toBe(2);
    });

    test('list by state scopes correctly', async () => {
      await s.open({ id: 'r1', org_id: 'acme', kind: 'rb' });
      await s.open({ id: 'r2', org_id: 'acme', kind: 'rb' });
      await s.transition('acme', 'r2', 'COMPLETED');
      expect((await s.list({ org_id: 'acme', state: 'STARTED' })).length).toBe(1);
      expect((await s.list({ org_id: 'acme', state: 'COMPLETED' })).length).toBe(1);
    });

    test('list by array of states filters with IN clause', async () => {
      await s.open({ id: 's1', org_id: 'acme', kind: 'rb' });
      await s.open({ id: 's2', org_id: 'acme', kind: 'rb' });
      await s.transition('acme', 's2', 'COMPENSATING');
      const r = await s.list({ org_id: 'acme', state: ['STARTED', 'COMPENSATING'] });
      expect(r.length).toBe(2);
    });

    test('cross-tenant get returns null', async () => {
      await s.open({ id: 'priv', org_id: 'acme', kind: 'rb' });
      expect(await s.get('beta', 'priv')).toBeNull();
    });
  });
}
runSaga('Sqlite',   async () => { const s = new SqliteSagaStore(new Database(':memory:')); await s.init(); return s; });
runSaga('Postgres', async () => { const s = new PostgresSagaStore(makePool()); await s.init(); return s; });

// ── SnapshotStore ───────────────────────────────────────────────────

function runSnapshots(name: string, make: () => Promise<SnapshotStore>) {
  describe(`SnapshotStore (${name})`, () => {
    let s: SnapshotStore;
    beforeEach(async () => { s = await make(); });
    afterEach(async () => { await s.close(); });

    test('insert + get round-trips', async () => {
      await s.insert({ trace_id: 't1', kind: 'git', snapshot_data: '{"ref":"abc"}', hash: 'h1' });
      const row = await s.get('t1');
      expect(row?.kind).toBe('git');
      expect(row?.snapshot_data).toBe('{"ref":"abc"}');
    });

    test('insert UPSERTs on duplicate trace_id', async () => {
      await s.insert({ trace_id: 't1', kind: 'git', snapshot_data: 'v1', hash: 'h1' });
      await s.insert({ trace_id: 't1', kind: 'git', snapshot_data: 'v2', hash: 'h2' });
      const row = await s.get('t1');
      expect(row?.snapshot_data).toBe('v2');
      expect(row?.hash).toBe('h2');
    });

    test('getMany returns all requested rows', async () => {
      await s.insert({ trace_id: 'a', kind: 'git', snapshot_data: '1', hash: 'h' });
      await s.insert({ trace_id: 'b', kind: 'git', snapshot_data: '2', hash: 'h' });
      await s.insert({ trace_id: 'c', kind: 'file', snapshot_data: '3', hash: 'h' });
      const rows = await s.getMany(['a', 'b']);
      expect(rows.length).toBe(2);
      expect(rows.map(r => r.trace_id).sort()).toEqual(['a', 'b']);
    });

    test('listByKind partitions by compensator', async () => {
      await s.insert({ trace_id: 'g1', kind: 'git', snapshot_data: '1', hash: 'h' });
      await s.insert({ trace_id: 'g2', kind: 'git', snapshot_data: '2', hash: 'h' });
      await s.insert({ trace_id: 'f1', kind: 'file', snapshot_data: '3', hash: 'h' });
      expect((await s.listByKind('git')).length).toBe(2);
      expect((await s.listByKind('file')).length).toBe(1);
    });

    test('delete removes the row', async () => {
      await s.insert({ trace_id: 't', kind: 'git', snapshot_data: '1', hash: 'h' });
      expect(await s.delete('t')).toBe(true);
      expect(await s.get('t')).toBeNull();
    });
  });
}
runSnapshots('Sqlite',   async () => { const s = new SqliteSnapshotStore(new Database(':memory:')); await s.init(); return s; });
runSnapshots('Postgres', async () => { const s = new PostgresSnapshotStore(makePool()); await s.init(); return s; });
