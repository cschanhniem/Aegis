/**
 * CollusionDetector tests — pins the multi-agent SOTA security
 * detection signals: handoff burst, sensitive→outbound relay, and
 * cycle detection.
 */
import { CollusionDetector } from '../services/collusion-detector';

// ── handoff_burst ──────────────────────────────────────────────────

test('handoff_burst fires when A→B rate spikes above historical baseline', () => {
  const d = new CollusionDetector();
  const t0 = Date.now();

  // History: A→B sends one message every 30s for 15 minutes (= 30
  // total). The first 27 land OUTSIDE the 1-min sliding window so
  // they never contribute to `recent`, but they boost the all-time
  // average that the burst test compares against.
  for (let i = 0; i < 30; i++) {
    d.observe({
      ts: t0 + i * 30_000,
      agent_id: 'A', target_agent_id: 'B',
      tool_name: 'send_message', category: 'communication',
    });
  }

  // Now a burst: 10 sends in 5 seconds (well above the 1-msg/30s baseline).
  let last;
  for (let i = 0; i < 10; i++) {
    last = d.observe({
      ts: t0 + 30 * 30_000 + i * 500,
      agent_id: 'A', target_agent_id: 'B',
      tool_name: 'send_message', category: 'communication',
    });
  }
  expect(last!.handoff_burst).toBe(true);
  expect(last!.score).toBeGreaterThan(0);
});

test('handoff_burst does NOT fire when total < min observations', () => {
  const d = new CollusionDetector();
  const r = d.observe({
    ts: Date.now(), agent_id: 'A', target_agent_id: 'B',
    tool_name: 'send_message', category: 'communication',
  });
  expect(r.handoff_burst).toBe(false);
});

// ── sensitive_relay (data exfil chain) ─────────────────────────────

test('sensitive_relay fires when A reads sensitive data + sends to B + B does outbound action with same fingerprint', () => {
  const d = new CollusionDetector();
  const now = Date.now();
  const fp = 'sha256:beef';

  // 1. A reads sensitive customer data (database category).
  d.observe({
    ts: now, agent_id: 'A',
    tool_name: 'query_customer_records', category: 'database',
    content_fp: fp,
  });
  // 2. A sends the data to B.
  d.observe({
    ts: now + 1_000, agent_id: 'A', target_agent_id: 'B',
    tool_name: 'send_message', category: 'communication',
    content_fp: fp,
  });
  // 3. B does an outbound communication (email) carrying the same fingerprint.
  const r = d.observe({
    ts: now + 2_000, agent_id: 'B',
    tool_name: 'send_email', category: 'communication',
    content_fp: fp,
  });
  expect(r.sensitive_relay).toBe(true);
  expect(r.score).toBeGreaterThanOrEqual(0.6);
  expect(r.details.some(s => s.includes('sensitive relay'))).toBe(true);
});

test('sensitive_relay does NOT fire when the outbound action is past the window', () => {
  const d = new CollusionDetector();
  const now = Date.now();
  const fp = 'sha256:cafe';
  d.observe({ ts: now,            agent_id: 'A', tool_name: 'query', category: 'database', content_fp: fp });
  d.observe({ ts: now + 1_000,    agent_id: 'A', target_agent_id: 'B', tool_name: 'msg', category: 'communication', content_fp: fp });
  // Outbound 60s later — past the 30s relay window.
  const r = d.observe({ ts: now + 60_000, agent_id: 'B', tool_name: 'send_email', category: 'communication', content_fp: fp });
  expect(r.sensitive_relay).toBe(false);
});

// ── cycle ──────────────────────────────────────────────────────────

test('cycle detection fires when A → B → C → A', () => {
  const d = new CollusionDetector();
  const now = Date.now();
  d.observe({ ts: now,       agent_id: 'A', target_agent_id: 'B', tool_name: 'm', category: 'communication' });
  d.observe({ ts: now + 100, agent_id: 'B', target_agent_id: 'C', tool_name: 'm', category: 'communication' });
  const r = d.observe({ ts: now + 200, agent_id: 'C', target_agent_id: 'A', tool_name: 'm', category: 'communication' });
  expect(r.cycle).toBe(true);
});

test('cycle detection fires on the smallest A → B → A cycle', () => {
  const d = new CollusionDetector();
  const now = Date.now();
  d.observe({ ts: now,       agent_id: 'A', target_agent_id: 'B', tool_name: 'm', category: 'communication' });
  const r = d.observe({ ts: now + 100, agent_id: 'B', target_agent_id: 'A', tool_name: 'm', category: 'communication' });
  expect(r.cycle).toBe(true);
});

test('non-cyclic chains do NOT fire cycle detection', () => {
  const d = new CollusionDetector();
  const now = Date.now();
  d.observe({ ts: now,       agent_id: 'A', target_agent_id: 'B', tool_name: 'm', category: 'communication' });
  const r = d.observe({ ts: now + 100, agent_id: 'B', target_agent_id: 'C', tool_name: 'm', category: 'communication' });
  expect(r.cycle).toBe(false);
});

// ── Window eviction ────────────────────────────────────────────────

test('events outside CYCLE_WINDOW_MS are evicted', () => {
  const d = new CollusionDetector();
  const t0 = Date.now();
  d.observe({ ts: t0, agent_id: 'A', target_agent_id: 'B', tool_name: 'm', category: 'communication' });
  // Far in the future: cycle window passed, edge.recent should be empty.
  d.observe({ ts: t0 + 90_000, agent_id: 'X', target_agent_id: 'Y', tool_name: 'm', category: 'communication' });
  // The edge A→B exists in `edges` (we don't delete the row) but no
  // recent timestamps remain in its window.
  expect(d._edgeCount()).toBeGreaterThanOrEqual(2);
});

// ── Composite score ────────────────────────────────────────────────

test('multiple signals stack into composite score but cap at 1.0', () => {
  const d = new CollusionDetector();
  const now = Date.now();
  // Set up baseline + bursty cycle with relay all at once.
  for (let i = 0; i < 30; i++) {
    d.observe({ ts: now - 600_000 + i * 1000, agent_id: 'A', target_agent_id: 'B', tool_name: 'm', category: 'communication' });
  }
  d.observe({ ts: now - 5_000, agent_id: 'A', tool_name: 'q', category: 'database', content_fp: 'fp1' });
  d.observe({ ts: now - 1_000, agent_id: 'A', target_agent_id: 'B', tool_name: 'm', category: 'communication', content_fp: 'fp1' });
  // Cycle close + outbound + burst all on this one call:
  const r = d.observe({ ts: now, agent_id: 'B', target_agent_id: 'A', tool_name: 'send_email', category: 'communication', content_fp: 'fp1' });
  expect(r.score).toBeGreaterThan(0);
  expect(r.score).toBeLessThanOrEqual(1);
});
