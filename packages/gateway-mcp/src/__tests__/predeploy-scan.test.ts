/**
 * Tests for the SARIF parser. We don't shell out to the real
 * agent-audit binary here — those would be flaky on machines without
 * Python + the package installed. Instead we hand the parser a
 * canned SARIF document that mirrors agent-audit's actual output
 * shape and assert the field mapping.
 *
 * The end-to-end "spawn agent-audit + ingest" path is exercised in
 * the integration smoke (run separately when the binary is present).
 */

import { parseSarif, trimSarif } from '../services/predeploy-scan';

const REAL_AGENT_AUDIT_SARIF = {
  $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
  version: '2.1.0',
  runs: [{
    tool: {
      driver: {
        name: 'agent-audit',
        semanticVersion: '0.18.2',
        rules: [
          {
            id: 'AGENT-001',
            name: 'PromptInjectionUnsanitized',
            shortDescription: { text: 'Prompt injection via unsanitized user input' },
            fullDescription:  { text: 'A user-controlled string is concatenated into a system prompt without sanitization.' },
            defaultConfiguration: { level: 'error' },
            properties: { tags: ['ASI-01', 'CWE-94', 'security'], 'security-severity': '9.1' },
            help: { text: 'Wrap user input in a sandboxed function or use Anthropic structured tool args.' },
          },
          {
            id: 'AGENT-007',
            name: 'SecretInCode',
            shortDescription: { text: 'API key / secret committed in source' },
            defaultConfiguration: { level: 'error' },
            properties: { tags: ['CWE-798'], 'security-severity': '7.5' },
          },
          {
            id: 'AGENT-022',
            name: 'MCPServerShadowing',
            shortDescription: { text: 'MCP server name shadows a built-in tool' },
            defaultConfiguration: { level: 'warning' },
            properties: { tags: ['ASI-05'], 'security-severity': '5.0' },
          },
        ],
      },
    },
    invocations: [{ workingDirectory: { uri: '/repos/acme-bot' } }],
    results: [
      {
        ruleId: 'AGENT-001',
        level: 'error',
        message: { text: 'User input flows into system prompt via build_prompt() at line 42' },
        locations: [{ physicalLocation: {
          artifactLocation: { uri: 'src/agent.py' },
          region: { startLine: 42, startColumn: 5, endLine: 42, endColumn: 60 },
        } }],
        properties: { confidence: 0.93 },
      },
      {
        ruleId: 'AGENT-007',
        level: 'error',
        message: { text: 'sk-... hardcoded in src/keys.py:3' },
        locations: [{ physicalLocation: {
          artifactLocation: { uri: 'src/keys.py' }, region: { startLine: 3 },
        } }],
        properties: { confidence: 0.99 },
      },
      {
        ruleId: 'AGENT-022',
        level: 'warning',
        message: { text: 'MCP server "filesystem" shadows the built-in filesystem tool' },
        locations: [{ physicalLocation: {
          artifactLocation: { uri: '.mcp.json' }, region: { startLine: 12 },
        } }],
      },
    ],
  }],
};

describe('SARIF parser (predeploy-scan)', () => {
  it('maps the real agent-audit SARIF shape into AegisFinding[] correctly', () => {
    const parsed = parseSarif(REAL_AGENT_AUDIT_SARIF, 100)!;
    expect(parsed.ok).toBe(true);
    expect(parsed.tool.name).toBe('agent-audit');
    expect(parsed.tool.version).toBe('0.18.2');
    expect(parsed.findings).toHaveLength(3);
    const byId = Object.fromEntries(parsed.findings.map(f => [f.rule_id, f]));
    expect(byId['AGENT-001'].severity).toBe('critical');   // security-severity 9.1
    expect(byId['AGENT-001'].tier).toBe('BLOCK');
    expect(byId['AGENT-001'].owasp_id).toBe('ASI-01');
    expect(byId['AGENT-001'].cwe_id).toBe('CWE-94');
    expect(byId['AGENT-001'].location.start_line).toBe(42);
    expect(byId['AGENT-001'].confidence).toBeCloseTo(0.93);
    expect(byId['AGENT-007'].severity).toBe('high');       // security-severity 7.5
    expect(byId['AGENT-007'].cwe_id).toBe('CWE-798');
    expect(byId['AGENT-022'].severity).toBe('medium');     // 5.0
    expect(byId['AGENT-022'].tier).toBe('WARN');
    expect(byId['AGENT-022'].owasp_id).toBe('ASI-05');
  });

  it('summary.by_severity + by_tier reflect the populated findings', () => {
    const parsed = parseSarif(REAL_AGENT_AUDIT_SARIF, 100)!;
    expect(parsed.summary.total).toBe(3);
    expect(parsed.summary.by_severity.critical).toBe(1);
    expect(parsed.summary.by_severity.high).toBe(1);
    expect(parsed.summary.by_severity.medium).toBe(1);
    expect(parsed.summary.by_tier.BLOCK).toBe(2);
    expect(parsed.summary.by_tier.WARN).toBe(1);
  });

  it('respects the max cap', () => {
    const flood = {
      ...REAL_AGENT_AUDIT_SARIF,
      runs: [{
        ...REAL_AGENT_AUDIT_SARIF.runs[0],
        results: Array.from({ length: 50 }, () => REAL_AGENT_AUDIT_SARIF.runs[0].results[0]),
      }],
    };
    const parsed = parseSarif(flood, 10)!;
    expect(parsed.findings).toHaveLength(10);
  });

  it('returns null for non-SARIF input', () => {
    expect(parseSarif({}, 100)).toBeNull();
    expect(parseSarif({ runs: [] }, 100)).toBeNull();
    expect(parseSarif(null, 100)).toBeNull();
  });

  it('falls back to "medium" when no level / security-severity provided', () => {
    const minimal = {
      version: '2.1.0',
      runs: [{
        tool: { driver: { name: 'x', rules: [{ id: 'X-1' }] } },
        results: [{
          ruleId: 'X-1',
          message: { text: 'no level' },
          locations: [{ physicalLocation: { artifactLocation: { uri: 'a.py' }, region: { startLine: 1 } } }],
        }],
      }],
    };
    const parsed = parseSarif(minimal, 10)!;
    expect(parsed.findings[0].severity).toBe('medium');
  });

  it('trimSarif: clamps runs[0].results to max + preserves the rest', () => {
    const big = {
      $schema: 'sarif-2.1.0',
      version: '2.1.0',
      runs: [{
        tool: { driver: { name: 'agent-audit', semanticVersion: '0.18.2', rules: [{ id: 'X' }] } },
        results: Array.from({ length: 100 }, (_, i) => ({ ruleId: 'X', message: { text: `r${i}` } })),
        invocations: [{ workingDirectory: { uri: '/x' } }],
      }],
    };
    const trimmed = trimSarif(big, 25) as any;
    expect(trimmed.runs[0].results).toHaveLength(25);
    expect(trimmed.runs[0].tool.driver.name).toBe('agent-audit');
    expect(trimmed.runs[0].invocations[0].workingDirectory.uri).toBe('/x');
    expect(trimmed.version).toBe('2.1.0');
    expect(trimmed.$schema).toBe('sarif-2.1.0');
  });

  it('trimSarif: leaves non-SARIF input untouched', () => {
    expect(trimSarif(null, 10)).toBeNull();
    expect(trimSarif({}, 10)).toEqual({});
    expect(trimSarif({ runs: [] }, 10)).toEqual({ runs: [] });
  });

  it('parseSarif populates the sarif field is NOT this parser\'s job (caller handles)', () => {
    // sarif blob is added by the service after parseSarif returns
    const parsed = parseSarif(REAL_AGENT_AUDIT_SARIF, 100)!;
    expect(parsed.sarif).toBeUndefined();
  });

  it('maps note-level results into severity:note tier:INFO', () => {
    const informational = {
      version: '2.1.0',
      runs: [{
        tool: { driver: { name: 'x', rules: [{ id: 'X-2' }] } },
        results: [{
          ruleId: 'X-2', level: 'note',
          message: { text: 'fyi' },
          locations: [{ physicalLocation: { artifactLocation: { uri: 'a.py' }, region: { startLine: 1 } } }],
        }],
      }],
    };
    const parsed = parseSarif(informational, 10)!;
    expect(parsed.findings[0].severity).toBe('note');
    expect(parsed.findings[0].tier).toBe('INFO');
  });
});
