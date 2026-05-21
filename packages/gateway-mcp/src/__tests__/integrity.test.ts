/**
 * IntegrityService — gold path + the two tamper-detection modes.
 *
 * Seeds a hand-built trace chain into a fresh in-memory traces
 * table, runs verifyAgentChain, asserts on the verdict. The
 * gateway production code shares the same calculateTraceHash from
 * core-schema that the service uses to recompute — these tests
 * exist to fail loudly the day someone changes the hash input set
 * without bumping a version.
 */

import pino from 'pino';
import Database from 'better-sqlite3';
import { calculateTraceHash } from '@agentguard/core-schema';
import { IntegrityService } from '../services/integrity';
import { computeContentHash } from '../api/traces';

const silent = pino({ level: 'silent' });

interface SeedTrace {
  trace_id: string;
  sequence_number: number;
  tool_name: string;
  result: string;
}

function makeDbWithTraces(agent_id: string, seeds: SeedTrace[], opts: { skipContentHash?: boolean } = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE traces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT UNIQUE NOT NULL,
      agent_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      sequence_number INTEGER NOT NULL,
      input_context TEXT NOT NULL,
      thought_chain TEXT NOT NULL,
      tool_call TEXT NOT NULL,
      observation TEXT NOT NULL,
      integrity_hash TEXT NOT NULL,
      previous_hash TEXT,
      content_hash TEXT
    );
  `);

  let prevHash: string | null = null;
  for (const s of seeds) {
    const input_context = { prompt: `step ${s.sequence_number}` };
    const thought_chain = { raw_tokens: '', parsed_steps: [] };
    const tool_call = { tool_name: s.tool_name, function: s.tool_name, arguments: {}, timestamp: '2026-05-20T00:00:00Z' };
    const observation = { raw_output: s.result, duration_ms: 1 };
    const trace = {
      trace_id: s.trace_id,
      agent_id,
      timestamp: '2026-05-20T00:00:00Z',
      sequence_number: s.sequence_number,
      input_context,
      thought_chain,
      tool_call,
      observation,
      previous_hash: prevHash ?? undefined,
      environment: 'PRODUCTION',
      version: '1.0.0',
    } as any;
    const integrity_hash = calculateTraceHash(trace);
    const content_hash = opts.skipContentHash
      ? null
      : computeContentHash(input_context, thought_chain, tool_call, observation);

    db.prepare(
      `INSERT INTO traces
       (trace_id, agent_id, timestamp, sequence_number, input_context, thought_chain, tool_call, observation, integrity_hash, previous_hash, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      s.trace_id, agent_id, '2026-05-20T00:00:00Z', s.sequence_number,
      JSON.stringify(input_context), JSON.stringify(thought_chain),
      JSON.stringify(tool_call), JSON.stringify(observation),
      integrity_hash, prevHash, content_hash,
    );

    prevHash = integrity_hash;
  }
  return db;
}

describe('IntegrityService.verifyAgentChain', () => {
  test('intact chain → ok=true with total count', () => {
    const db = makeDbWithTraces('agent-A', [
      { trace_id: 't1', sequence_number: 1, tool_name: 'web_search', result: 'ok' },
      { trace_id: 't2', sequence_number: 2, tool_name: 'read_file',  result: 'ok' },
      { trace_id: 't3', sequence_number: 3, tool_name: 'send_email', result: 'ok' },
    ]);
    const svc = new IntegrityService(db, silent);
    const r = svc.verifyAgentChain('agent-A');
    expect(r.ok).toBe(true);
    expect(r.total).toBe(3);
    expect(r.latest_trace_id).toBe('t3');
    expect(r.broken_at).toBeUndefined();
  });

  test('agent with no traces → ok=true total=0', () => {
    const db = makeDbWithTraces('agent-A', []);
    const svc = new IntegrityService(db, silent);
    const r = svc.verifyAgentChain('agent-unknown');
    expect(r.ok).toBe(true);
    expect(r.total).toBe(0);
    expect(r.latest_trace_id).toBeNull();
  });

  test('tampered integrity_hash on row N → next row link breaks', () => {
    const db = makeDbWithTraces('agent-A', [
      { trace_id: 't1', sequence_number: 1, tool_name: 'web_search', result: 'ok' },
      { trace_id: 't2', sequence_number: 2, tool_name: 'read_file',  result: 'ok' },
      { trace_id: 't3', sequence_number: 3, tool_name: 'send_email', result: 'ok' },
    ]);
    // Tamper: rewrite t2's integrity_hash. t3's previous_hash still
    // points to the old t2.integrity_hash, so the chain breaks at t3.
    db.prepare(`UPDATE traces SET integrity_hash = 'tampered-hash-xxx' WHERE trace_id = 't2'`).run();

    const r = new IntegrityService(db, silent).verifyAgentChain('agent-A');
    expect(r.ok).toBe(false);
    expect(r.broken_at?.reason).toBe('link_broken');
    expect(r.broken_at?.trace_id).toBe('t3');
    expect(r.broken_at?.expected).toBe('tampered-hash-xxx');
  });

  test('broken linkage (previous_hash rewritten) → link_broken', () => {
    const db = makeDbWithTraces('agent-A', [
      { trace_id: 't1', sequence_number: 1, tool_name: 'web_search', result: 'ok' },
      { trace_id: 't2', sequence_number: 2, tool_name: 'read_file',  result: 'ok' },
      { trace_id: 't3', sequence_number: 3, tool_name: 'send_email', result: 'ok' },
    ]);
    // Tamper: t3's previous_hash points somewhere other than t2's
    // integrity_hash. (We don't bother recomputing t3's own
    // integrity_hash — the service doesn't re-hash row content;
    // linkage alone is enough to detect this.)
    db.prepare(
      `UPDATE traces SET previous_hash = ? WHERE trace_id = 't3'`,
    ).run('fake-prior-hash');

    const r = new IntegrityService(db, silent).verifyAgentChain('agent-A');
    expect(r.ok).toBe(false);
    expect(r.broken_at?.reason).toBe('link_broken');
    expect(r.broken_at?.trace_id).toBe('t3');
    expect(r.broken_at?.actual).toBe('fake-prior-hash');
  });

  test('v0.4 content_tamper — observation column mutated after insert is caught', () => {
    const db = makeDbWithTraces('agent-A', [
      { trace_id: 't1', sequence_number: 1, tool_name: 'web_search', result: 'clean' },
      { trace_id: 't2', sequence_number: 2, tool_name: 'read_file',  result: 'clean' },
    ]);
    // Tamper: edit observation directly. Don't touch content_hash —
    // exactly the attack the v0.4 column was added to catch.
    db.prepare(
      `UPDATE traces SET observation = ? WHERE trace_id = 't2'`,
    ).run(JSON.stringify({ raw_output: 'TAMPERED', duration_ms: 1 }));

    const r = new IntegrityService(db, silent).verifyAgentChain('agent-A');
    expect(r.ok).toBe(false);
    expect(r.broken_at?.reason).toBe('content_tamper');
    expect(r.broken_at?.trace_id).toBe('t2');
  });

  test('v0.4 content_tamper precedes link check for the same row', () => {
    // If both content_tamper AND link_broken would trip on the same
    // row, content_tamper wins — it's the more specific diagnosis.
    const db = makeDbWithTraces('agent-A', [
      { trace_id: 't1', sequence_number: 1, tool_name: 'web_search', result: 'ok' },
      { trace_id: 't2', sequence_number: 2, tool_name: 'read_file',  result: 'ok' },
    ]);
    db.prepare(
      `UPDATE traces SET observation = ?, previous_hash = 'bogus' WHERE trace_id = 't2'`,
    ).run(JSON.stringify({ raw_output: 'TAMPERED', duration_ms: 1 }));

    const r = new IntegrityService(db, silent).verifyAgentChain('agent-A');
    expect(r.broken_at?.reason).toBe('content_tamper');
  });

  test('legacy rows (content_hash = NULL) skip the content check', () => {
    // Pre-v0.4 traces inserted before this column existed have
    // content_hash = NULL. They should not be flagged as tampered;
    // linkage still applies.
    const db = makeDbWithTraces(
      'agent-A',
      [
        { trace_id: 't1', sequence_number: 1, tool_name: 'web_search', result: 'ok' },
        { trace_id: 't2', sequence_number: 2, tool_name: 'read_file',  result: 'ok' },
      ],
      { skipContentHash: true },
    );
    // Modify a content field. Pre-v0.4 row has content_hash = NULL,
    // so the content check is skipped; chain stays ok.
    db.prepare(`UPDATE traces SET observation = ? WHERE trace_id = 't1'`)
      .run(JSON.stringify({ raw_output: 'no v0.4 hash on this row', duration_ms: 1 }));

    const r = new IntegrityService(db, silent).verifyAgentChain('agent-A');
    expect(r.ok).toBe(true);
  });

  test('latency_ms is reported and non-negative', () => {
    const db = makeDbWithTraces('agent-A', [
      { trace_id: 't1', sequence_number: 1, tool_name: 'web_search', result: 'ok' },
    ]);
    const r = new IntegrityService(db, silent).verifyAgentChain('agent-A');
    expect(typeof r.latency_ms).toBe('number');
    expect(r.latency_ms).toBeGreaterThanOrEqual(0);
  });
});
