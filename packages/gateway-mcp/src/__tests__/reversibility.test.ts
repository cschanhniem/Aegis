import { ReversibilityClassifier } from '../services/reversibility';

describe('ReversibilityClassifier', () => {
  it('classifies known idempotent tools', () => {
    const c = new ReversibilityClassifier();
    expect(c.classify('web_search', { q: 'x' }).class).toBe('idempotent');
    expect(c.classify('file_read', { path: '/etc/hosts' }).class).toBe('idempotent');
    expect(c.classify('sql_select', {}).class).toBe('idempotent');
  });

  it('classifies known compensable tools', () => {
    const c = new ReversibilityClassifier();
    expect(c.classify('db_insert', {}).class).toBe('compensable');
    expect(c.classify('file_write', {}).class).toBe('compensable');
    expect(c.classify('sql_update', {}).class).toBe('compensable');
  });

  it('classifies known irreversible tools', () => {
    const c = new ReversibilityClassifier();
    expect(c.classify('send_email', {}).class).toBe('irreversible');
    expect(c.classify('stripe_charge', {}).class).toBe('irreversible');
    expect(c.classify('shell_exec', {}).class).toBe('irreversible');
  });

  it('uses SQL substring heuristic when tool name is generic', () => {
    const c = new ReversibilityClassifier();
    expect(c.classify('run_query', { sql: 'SELECT 1' }).class).toBe('idempotent');
    expect(c.classify('run_query', { sql: 'INSERT INTO t VALUES (1)' }).class).toBe('compensable');
    expect(c.classify('run_query', { sql: 'DROP TABLE users' }).class).toBe('irreversible');
    expect(c.classify('run_query', { sql: 'UPDATE users SET x = 1' }).class).toBe('compensable');
  });

  it('uses HTTP method heuristic', () => {
    const c = new ReversibilityClassifier();
    expect(c.classify('http_request', { method: 'GET' }).class).toBe('idempotent');
    expect(c.classify('http_request', { method: 'DELETE' }).class).toBe('irreversible');
    expect(c.classify('http_request', { method: 'POST' }).class).toBe('irreversible');
  });

  it('falls back to irreversible for unknown tools (fail-safe)', () => {
    const c = new ReversibilityClassifier();
    const r = c.classify('mystery_tool', {});
    expect(r.class).toBe('irreversible');
    expect(r.reason).toMatch(/no registered reversibility class/);
  });

  it('respects tenant overrides', () => {
    const c = new ReversibilityClassifier();
    c.setOverrides([{ tool_name: 'my_custom_tool', class: 'compensable', reason: 'has /undo endpoint' }]);
    expect(c.classify('my_custom_tool', {}).class).toBe('compensable');
    expect(c.classify('my_custom_tool', {}).reason).toBe('has /undo endpoint');
  });

  it('override beats SQL/HTTP heuristic', () => {
    const c = new ReversibilityClassifier();
    c.setOverrides([{ tool_name: 'safe_select', class: 'idempotent' }]);
    // sql=DROP would normally be irreversible, but override wins
    expect(c.classify('safe_select', { sql: 'DROP TABLE x' }).class).toBe('idempotent');
  });

  it('compensation_hint carries through SQL detection', () => {
    const c = new ReversibilityClassifier();
    const r = c.classify('q', { sql: 'INSERT INTO users (id) VALUES (1)' });
    expect(r.compensation_hint?.sql_kind).toBe('INSERT');
  });
});
