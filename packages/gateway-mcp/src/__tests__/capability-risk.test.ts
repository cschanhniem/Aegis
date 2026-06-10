/**
 * Capability risk scorer tests. Pins:
 *   - Empty / minimal inventories land in LOW class
 *   - Research agent (web_search only) ~ LOW
 *   - Ops agent (shell + file_write + http_post) ~ HIGH/CRITICAL
 *   - Description modifiers shift the score in the documented direction
 *   - Recommendations track the score class
 *   - Per-tool decomposition exposes the top-contributing dimension
 */
import { scoreCapabilityRisk, type ToolInventoryEntry } from '../services/capability-risk';

test('empty inventory yields LOW class with score 0', () => {
  const r = scoreCapabilityRisk([]);
  expect(r.score).toBe(0);
  expect(r.risk_class).toBe('LOW');
  expect(r.tools).toEqual([]);
});

test('research agent (web_search only) lands in LOW', () => {
  const inv: ToolInventoryEntry[] = [
    { name: 'web_search', category: 'read-only' },
  ];
  const r = scoreCapabilityRisk(inv);
  expect(r.risk_class).toBe('LOW');
  expect(r.score).toBeLessThan(25);
});

test('ops agent (shell + file_write + http_post) lands in HIGH or CRITICAL', () => {
  const inv: ToolInventoryEntry[] = [
    { name: 'shell',      category: 'shell',         description: 'arbitrary shell commands on production' },
    { name: 'file_write', category: 'file',          description: 'destructive — can rm any path' },
    { name: 'http_post',  category: 'network',       description: 'external outbound HTTPS' },
  ];
  const r = scoreCapabilityRisk(inv);
  expect(['HIGH', 'CRITICAL']).toContain(r.risk_class);
  expect(r.score).toBeGreaterThanOrEqual(50);
});

test('descriptive modifier "read-only" dampens the action dimension', () => {
  const a = scoreCapabilityRisk([{ name: 'mystery_tool' }]);
  const b = scoreCapabilityRisk([{ name: 'mystery_tool', description: 'read-only fetcher' }]);
  expect(b.score).toBeLessThanOrEqual(a.score);
});

test('descriptive modifier "destructive" increases action + scale', () => {
  const a = scoreCapabilityRisk([{ name: 'delete_resource', category: 'database' }]);
  const b = scoreCapabilityRisk([{ name: 'delete_resource', category: 'database', description: 'destructive — drops customer rows' }]);
  expect(b.dimensions.action).toBeGreaterThanOrEqual(a.dimensions.action);
  expect(b.score).toBeGreaterThanOrEqual(a.score);
});

test('descriptive modifier "credential" increases secrets dimension', () => {
  const a = scoreCapabilityRisk([{ name: 'tool_x' }]);
  const b = scoreCapabilityRisk([{ name: 'tool_x', description: 'rotates the api-key' }]);
  expect(b.dimensions.secrets).toBeGreaterThan(a.dimensions.secrets);
});

test('per-tool decomposition records category + dimensions + rationale', () => {
  const inv: ToolInventoryEntry[] = [
    { name: 'query_db', category: 'database', description: 'reads customer PII' },
  ];
  const r = scoreCapabilityRisk(inv);
  expect(r.tools.length).toBe(1);
  expect(r.tools[0].name).toBe('query_db');
  expect(r.tools[0].category).toBe('database');
  expect(r.tools[0].dimensions.pii).toBeGreaterThan(0);
  expect(r.tools[0].rationale).toContain('database');
});

test('multi-tool of same category amplifies rather than saturates (fan-out bonus)', () => {
  const one = scoreCapabilityRisk([{ name: 'sql1', category: 'database' }]);
  const four = scoreCapabilityRisk([
    { name: 'sql1', category: 'database' },
    { name: 'sql2', category: 'database' },
    { name: 'sql3', category: 'database' },
    { name: 'sql4', category: 'database' },
  ]);
  expect(four.score).toBeGreaterThan(one.score);
});

test('recommendations escalate with risk class', () => {
  const low = scoreCapabilityRisk([{ name: 'search', category: 'read-only' }]);
  const high = scoreCapabilityRisk([
    { name: 'shell',      category: 'shell' },
    { name: 'http_post',  category: 'network' },
    { name: 'file_write', category: 'file' },
  ]);
  expect(low.recommendations.some(r => /minimal|light/i.test(r))).toBe(true);
  // HIGH (50-74) recommends pending / witness; CRITICAL (≥ 75) tightens
  // further with block / approval / saga. Either rec set should fire
  // for our 3-distinct-high-action test case.
  expect(high.recommendations.some(r => /pending|witness|block|approval|saga/i.test(r))).toBe(true);
  // HIGH must NOT carry LOW-class posture text.
  expect(high.recommendations.some(r => /minimal|light/i.test(r))).toBe(false);
});

test('category inference works from tool name when category field absent', () => {
  const r = scoreCapabilityRisk([
    { name: 'exec_shell' },          // → shell
    { name: 'read_file' },           // → read-only
    { name: 'http_get' },            // → network
  ]);
  const cats = r.tools.map(t => t.category);
  expect(cats).toContain('shell');
  expect(cats).toContain('read-only');
  expect(cats).toContain('network');
});

test('dimensions are bounded to [0, 100]', () => {
  // Spam many high-action tools — aggregate must still cap at 100.
  const tools: ToolInventoryEntry[] = Array.from({ length: 50 }, (_, i) => ({
    name: `shell_${i}`, category: 'shell', description: 'destructive production',
  }));
  const r = scoreCapabilityRisk(tools);
  for (const v of Object.values(r.dimensions)) {
    expect(v).toBeLessThanOrEqual(100);
  }
  expect(r.score).toBeLessThanOrEqual(100);
});
