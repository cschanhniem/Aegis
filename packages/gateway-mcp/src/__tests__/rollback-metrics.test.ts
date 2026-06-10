import { RollbackMetricsService } from '../services/rollback-metrics';

describe('RollbackMetricsService', () => {
  it('records per-outcome counters per (tool, kind) tuple', () => {
    const m = new RollbackMetricsService();
    m.record({ tool_name: 'db_update', compensator_kind: 'webhook', outcome: 'rolled_back', duration_ms: 12 });
    m.record({ tool_name: 'db_update', compensator_kind: 'webhook', outcome: 'rolled_back', duration_ms: 14 });
    m.record({ tool_name: 'db_update', compensator_kind: 'webhook', outcome: 'failed',      duration_ms: 87 });
    m.record({ tool_name: 'send_email', compensator_kind: 'webhook', outcome: 'no_op',     duration_ms: 1  });

    const snap = m.snapshot();
    const dbu  = snap.find(r => r.tool_name === 'db_update')!;
    const sem  = snap.find(r => r.tool_name === 'send_email')!;
    expect(dbu.total.rolled_back).toBe(2);
    expect(dbu.total.failed).toBe(1);
    expect(sem.total.no_op).toBe(1);
  });

  it('success_rate = (rolled_back + no_op) / total', () => {
    const m = new RollbackMetricsService();
    for (let i = 0; i < 8; i++) m.record({ tool_name: 'x', compensator_kind: 'k', outcome: 'rolled_back', duration_ms: 10 });
    for (let i = 0; i < 2; i++) m.record({ tool_name: 'x', compensator_kind: 'k', outcome: 'failed',      duration_ms: 10 });
    const s = m.snapshot()[0];
    expect(s.success_rate).toBeCloseTo(0.8);
  });

  it('latency quantiles increase with q', () => {
    const m = new RollbackMetricsService();
    for (let i = 1; i <= 100; i++) {
      m.record({ tool_name: 'x', compensator_kind: 'k', outcome: 'rolled_back', duration_ms: i });
    }
    const s = m.snapshot()[0];
    expect(s.p50_ms).toBeLessThan(s.p95_ms);
    expect(s.p95_ms).toBeLessThanOrEqual(s.p99_ms);
  });

  it('mean tracks the running average', () => {
    const m = new RollbackMetricsService();
    m.record({ tool_name: 'x', compensator_kind: 'k', outcome: 'rolled_back', duration_ms: 10 });
    m.record({ tool_name: 'x', compensator_kind: 'k', outcome: 'rolled_back', duration_ms: 30 });
    m.record({ tool_name: 'x', compensator_kind: 'k', outcome: 'rolled_back', duration_ms: 50 });
    const s = m.snapshot()[0];
    expect(s.mean_ms).toBeCloseTo(30, 1);
  });

  it('ignores non-finite + negative durations from the histogram', () => {
    const m = new RollbackMetricsService();
    m.record({ tool_name: 'x', compensator_kind: 'k', outcome: 'rolled_back', duration_ms: NaN });
    m.record({ tool_name: 'x', compensator_kind: 'k', outcome: 'rolled_back', duration_ms: -5 });
    const s = m.snapshot()[0];
    // Both counter increments happened (we're counting EVENTS), but
    // neither went into the histogram
    expect(s.total.rolled_back).toBe(2);
    expect(s.mean_ms).toBe(0);  // no valid samples
  });

  it('prometheus output contains the right metric names + labels', () => {
    const m = new RollbackMetricsService();
    m.record({ tool_name: 'db_insert', compensator_kind: 'webhook', outcome: 'rolled_back', duration_ms: 25 });
    const text = m.prometheus();
    expect(text).toContain('# HELP aegis_rollback_total');
    expect(text).toContain('# TYPE aegis_rollback_total counter');
    expect(text).toMatch(/aegis_rollback_total\{tool="db_insert",compensator="webhook",outcome="rolled_back"\} 1/);
    expect(text).toContain('# TYPE aegis_rollback_duration_ms histogram');
    expect(text).toMatch(/aegis_rollback_duration_ms_bucket\{tool="db_insert",compensator="webhook",le="\+Inf"\}/);
    expect(text).toContain('aegis_rollback_duration_ms_sum');
    expect(text).toContain('aegis_rollback_duration_ms_count');
  });

  it('reset clears all counters', () => {
    const m = new RollbackMetricsService();
    m.record({ tool_name: 'x', compensator_kind: 'k', outcome: 'rolled_back', duration_ms: 10 });
    expect(m.snapshot()).toHaveLength(1);
    m.reset();
    expect(m.snapshot()).toHaveLength(0);
  });

  it('properly escapes quotes in label values', () => {
    const m = new RollbackMetricsService();
    m.record({ tool_name: 'tool"with"quote', compensator_kind: 'k', outcome: 'rolled_back', duration_ms: 1 });
    const text = m.prometheus();
    expect(text).toContain('tool="tool\\"with\\"quote"');
  });
});
