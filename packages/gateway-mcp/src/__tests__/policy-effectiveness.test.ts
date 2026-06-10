/**
 * Policy effectiveness scorer tests. Pins:
 *   - precision / recall / F1 math is correct on synthetic data
 *   - 4 signal classes fire under the documented conditions
 *   - per-policy bucketing is correct (no cross-policy leakage)
 *   - window filter actually scopes by created_at
 */
import Database from 'better-sqlite3';
import { PolicyEffectivenessService } from '../services/policy-effectiveness';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE violations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL, policy_id TEXT NOT NULL, trace_id TEXT NOT NULL,
      violation_type TEXT NOT NULL, details TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE approvals (
      id TEXT PRIMARY KEY,
      trace_id TEXT UNIQUE NOT NULL, agent_id TEXT NOT NULL,
      tool_name TEXT NOT NULL, risk_level TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL
    );
  `);
  return db;
}

function insertVio(db: Database.Database, policyId: string, traceId: string, ts?: string) {
  db.prepare(
    `INSERT INTO violations (agent_id, policy_id, trace_id, violation_type, created_at)
     VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')))`,
  ).run('agent-x', policyId, traceId, 'pattern', ts ?? null);
}

function insertApproval(db: Database.Database, traceId: string, status: 'APPROVED' | 'REJECTED' | 'EXPIRED', ts?: string) {
  db.prepare(
    `INSERT INTO approvals (id, trace_id, agent_id, tool_name, risk_level, status, expires_at, created_at)
     VALUES (?, ?, 'agent-x', 'shell', 'HIGH', ?, datetime('now', '+1 hour'), COALESCE(?, datetime('now')))`,
  ).run(`apv-${traceId}`, traceId, status, ts ?? null);
}

describe('PolicyEffectivenessService', () => {
  test('healthy policy lands in HEALTHY when precision ≥ 0.8 + recall ≥ 0.5', () => {
    const db = makeDb();
    // P fires 20 times; 18 of those were REJECTED (TP), 2 APPROVED (FP).
    // Also 2 REJECTED on OTHER traces — those are FN for P.
    for (let i = 0; i < 18; i++) { insertVio(db, 'P', `t-rej-${i}`); insertApproval(db, `t-rej-${i}`, 'REJECTED'); }
    for (let i = 0; i < 2;  i++) { insertVio(db, 'P', `t-fp-${i}`);  insertApproval(db, `t-fp-${i}`, 'APPROVED'); }
    for (let i = 0; i < 2;  i++) { insertApproval(db, `t-fn-${i}`, 'REJECTED'); }

    const r = new PolicyEffectivenessService(db).compute({ hours: 24 });
    const p = r.rows.find(r => r.policy_id === 'P')!;
    expect(p.fired_count).toBe(20);
    expect(p.true_positives).toBe(18);
    expect(p.false_positives).toBe(2);
    expect(p.false_negatives_est).toBe(2);  // 20 REJECTED total - 18 TP = 2
    expect(p.precision).toBeCloseTo(0.9, 2);
    expect(p.recall).toBeCloseTo(0.9, 2);
    expect(p.signal).toBe('HEALTHY');
  });

  test('noisy policy with high FP rate (50+ fires) → RETIRE', () => {
    const db = makeDb();
    // P fires 60 times; 55 APPROVED (FP), 5 REJECTED (TP).
    for (let i = 0; i < 55; i++) { insertVio(db, 'P', `tt-fp-${i}`); insertApproval(db, `tt-fp-${i}`, 'APPROVED'); }
    for (let i = 0; i < 5;  i++) { insertVio(db, 'P', `tt-tp-${i}`); insertApproval(db, `tt-tp-${i}`, 'REJECTED'); }

    const r = new PolicyEffectivenessService(db).compute({ hours: 24 });
    const p = r.rows.find(r => r.policy_id === 'P')!;
    expect(p.signal).toBe('RETIRE');
    expect(p.fp_rate).toBeGreaterThan(0.5);
    expect(p.recommendation).toMatch(/false-positive rate|retir/i);
  });

  test('loose policy with many FN → TIGHTEN', () => {
    const db = makeDb();
    // P fires 12 times (≥ 10 PROBE threshold), all REJECTED → 12 TP.
    // But 30 OTHER rejections exist — P only caught 12 of 42 → FN=30 > TP=12.
    for (let i = 0; i < 12; i++) { insertVio(db, 'P', `r-tp-${i}`); insertApproval(db, `r-tp-${i}`, 'REJECTED'); }
    for (let i = 0; i < 30; i++) { insertApproval(db, `r-fn-${i}`, 'REJECTED'); }

    const r = new PolicyEffectivenessService(db).compute({ hours: 24 });
    const p = r.rows.find(r => r.policy_id === 'P')!;
    expect(p.signal).toBe('TIGHTEN');
    expect(p.false_negatives_est).toBe(30);
  });

  test('too few fires → PROBE class', () => {
    const db = makeDb();
    for (let i = 0; i < 5; i++) { insertVio(db, 'P', `s-${i}`); insertApproval(db, `s-${i}`, 'REJECTED'); }
    const r = new PolicyEffectivenessService(db).compute({ hours: 24 });
    expect(r.rows.find(r => r.policy_id === 'P')?.signal).toBe('PROBE');
  });

  test('multiple policies tracked independently', () => {
    const db = makeDb();
    for (let i = 0; i < 20; i++) { insertVio(db, 'A', `a-${i}`); insertApproval(db, `a-${i}`, 'REJECTED'); }
    for (let i = 0; i < 60; i++) { insertVio(db, 'B', `b-${i}`); insertApproval(db, `b-${i}`, 'APPROVED'); }
    const r = new PolicyEffectivenessService(db).compute({ hours: 24 });
    const a = r.rows.find(r => r.policy_id === 'A')!;
    const b = r.rows.find(r => r.policy_id === 'B')!;
    expect(a.signal).toBe('HEALTHY');
    expect(b.signal).toBe('RETIRE');
    // Summary roll-up
    expect(r.summary.policies_evaluated).toBe(2);
    expect(r.summary.healthy).toBe(1);
    expect(r.summary.candidates_to_retire).toBe(1);
  });

  test('window filter scopes by created_at', () => {
    const db = makeDb();
    // Insert with a created_at far in the past — should be excluded.
    insertVio(db, 'P', 'old', '2024-01-01T00:00:00Z');
    insertApproval(db, 'old', 'REJECTED', '2024-01-01T00:00:00Z');
    const r = new PolicyEffectivenessService(db).compute({ hours: 24 });
    expect(r.rows.find(r => r.policy_id === 'P')).toBeUndefined();
  });

  test('no fires in window → empty rows + summary zeros', () => {
    const db = makeDb();
    const r = new PolicyEffectivenessService(db).compute({ hours: 24 });
    expect(r.rows).toEqual([]);
    expect(r.summary.policies_evaluated).toBe(0);
  });

  test('hours param is clamped to ≤ 90 days', () => {
    const db = makeDb();
    const r = new PolicyEffectivenessService(db).compute({ hours: 24 * 9999 });
    expect(r.window.hours).toBe(24 * 90);
  });
});
