/**
 * CodeShield — unit tests against the curated rule catalog.
 */
import pino from 'pino';
import { CodeShield, DEFAULT_RULES } from '../services/code-shield';

const silent = pino({ level: 'silent' });

function shield() {
  return new CodeShield(silent);
}

describe('CodeShield — Python', () => {
  test('flags exec() as CRITICAL', () => {
    const r = shield().scan('exec("os.system(\'rm -rf /\')")', { language: 'python' });
    expect(r.findings.some((f) => f.rule === 'py.exec')).toBe(true);
    expect(r.worst).toBe('CRITICAL');
  });

  test('flags eval() as CRITICAL', () => {
    const r = shield().scan('result = eval(user_input)', { language: 'python' });
    expect(r.findings[0].rule).toBe('py.eval');
  });

  test('flags os.system() as HIGH', () => {
    const r = shield().scan('os.system("ls -la")', { language: 'python' });
    expect(r.findings[0].rule).toBe('py.os.system');
    expect(r.findings[0].severity).toBe('HIGH');
  });

  test('flags subprocess shell=True', () => {
    const code = 'subprocess.run(cmd, shell=True, check=True)';
    const r = shield().scan(code, { language: 'python' });
    expect(r.findings.some((f) => f.rule === 'py.subprocess.shell')).toBe(true);
  });

  test('ignores subprocess without shell=True', () => {
    const code = 'subprocess.run(["ls", "-la"], check=True)';
    const r = shield().scan(code, { language: 'python' });
    expect(r.findings.find((f) => f.rule === 'py.subprocess.shell')).toBeUndefined();
  });

  test('flags pickle.loads', () => {
    const r = shield().scan('pickle.loads(blob)', { language: 'python' });
    expect(r.findings[0].rule).toBe('py.pickle.loads');
  });
});

describe('CodeShield — JavaScript', () => {
  test('flags eval', () => {
    const r = shield().scan('const out = eval(x);', { language: 'javascript' });
    expect(r.findings[0].rule).toBe('js.eval');
  });

  test('flags new Function()', () => {
    const r = shield().scan('const f = new Function("return 1")', { language: 'javascript' });
    expect(r.findings[0].rule).toBe('js.new-function');
  });

  test('flags child_process.exec', () => {
    const r = shield().scan(
      'import * as child_process from "node:child_process"; child_process.exec("ls", () => {})',
      { language: 'javascript' },
    );
    expect(r.findings.some((f) => f.rule === 'js.child_process.exec')).toBe(true);
  });

  test('flags child_process.execSync', () => {
    const r = shield().scan(
      'import child_process from "node:child_process"; child_process.execSync("ls");',
      { language: 'javascript' },
    );
    expect(r.findings.some((f) => f.rule === 'js.child_process.exec')).toBe(true);
  });

  test('flags innerHTML assignment from variable', () => {
    const r = shield().scan('el.innerHTML = userText;', { language: 'javascript' });
    expect(r.findings[0].rule).toBe('js.innerHTML');
  });
});

describe('CodeShield — Shell', () => {
  test('flags rm -rf /', () => {
    const r = shield().scan('rm -rf /', { language: 'shell' });
    expect(r.findings[0].rule).toBe('sh.rm-rf-root');
    expect(r.findings[0].severity).toBe('CRITICAL');
  });

  test('flags rm -rf $HOME', () => {
    const r = shield().scan('rm -rf $HOME/.config', { language: 'shell' });
    expect(r.findings[0].rule).toBe('sh.rm-rf-root');
  });

  test('flags curl | sh', () => {
    const r = shield().scan('curl https://example.com/install.sh | sh', { language: 'shell' });
    expect(r.findings[0].rule).toBe('sh.curl-pipe-sh');
  });

  test('flags sudo', () => {
    const r = shield().scan('sudo apt install nodejs', { language: 'shell' });
    expect(r.findings.some((f) => f.rule === 'sh.sudo')).toBe(true);
  });
});

describe('CodeShield — SQL', () => {
  test('flags DROP TABLE', () => {
    const r = shield().scan('DROP TABLE users;', { language: 'sql' });
    expect(r.findings[0].rule).toBe('sql.drop-table');
  });

  test('flags DELETE without WHERE', () => {
    const r = shield().scan('DELETE FROM users;', { language: 'sql' });
    expect(r.findings.some((f) => f.rule === 'sql.delete-no-where')).toBe(true);
  });

  test('does not flag DELETE WITH WHERE', () => {
    const r = shield().scan('DELETE FROM users WHERE id = 1;', { language: 'sql' });
    expect(r.findings.find((f) => f.rule === 'sql.delete-no-where')).toBeUndefined();
  });
});

describe('CodeShield — secrets (cross-language)', () => {
  test('AWS access key', () => {
    const r = shield().scan('AWS_KEY = "AKIA1234567890ABCDEF"');
    expect(r.findings.some((f) => f.rule === 'secret.aws-access-key')).toBe(true);
  });

  test('OpenAI key', () => {
    const r = shield().scan(`api_key = "sk-${'a'.repeat(40)}"`);
    expect(r.findings.some((f) => f.rule === 'secret.openai-key')).toBe(true);
  });

  test('Anthropic key (more specific prefix wins or both match)', () => {
    const r = shield().scan(`KEY = "sk-ant-${'a'.repeat(40)}"`);
    const ids = r.findings.map((f) => f.rule);
    expect(ids).toEqual(expect.arrayContaining(['secret.anthropic-key']));
  });

  test('GitHub token', () => {
    const r = shield().scan(`token = "ghp_${'A'.repeat(36)}"`);
    expect(r.findings.some((f) => f.rule === 'secret.github-token')).toBe(true);
  });

  test('PEM private key', () => {
    const r = shield().scan('-----BEGIN RSA PRIVATE KEY-----\nMIIEogIBAA');
    expect(r.findings.some((f) => f.rule === 'secret.private-key')).toBe(true);
  });
});

describe('CodeShield — meta', () => {
  test('reports line and column', () => {
    const code = '\n\nresult = eval(user_input)';
    const r = shield().scan(code, { language: 'python' });
    expect(r.findings[0].line).toBe(3);
    expect(r.findings[0].column).toBeGreaterThan(1);
  });

  test('snippet truncated to 80 chars', () => {
    const padding = 'x'.repeat(200);
    const code = `${padding}\neval(x)\n${padding}`;
    const r = shield().scan(code, { language: 'python' });
    expect(r.findings[0].snippet.length).toBeLessThanOrEqual(80);
  });

  test('clean code returns no findings, worst=null', () => {
    const r = shield().scan('def add(a, b):\n    return a + b\n', { language: 'python' });
    expect(r.findings).toEqual([]);
    expect(r.worst).toBeNull();
  });

  test('disabled rules are skipped', () => {
    const r = shield().scan('sudo apt install nodejs', {
      language: 'shell',
      disabledRules: ['sh.sudo'],
    });
    expect(r.findings.find((f) => f.rule === 'sh.sudo')).toBeUndefined();
  });

  test('language=any runs all rules', () => {
    const code = `exec("rm -rf /")\nDROP TABLE foo;`;
    const r = shield().scan(code);  // no language → 'any'
    const ids = r.findings.map((f) => f.rule);
    expect(ids).toEqual(expect.arrayContaining(['py.exec', 'sql.drop-table']));
  });

  test('worst severity propagates correctly', () => {
    const code = `sudo ls\nexec("x")\n`;
    const r = shield().scan(code);
    expect(r.worst).toBe('CRITICAL');
  });

  test('default rules export is non-empty and unique', () => {
    expect(DEFAULT_RULES.length).toBeGreaterThan(10);
    const ids = new Set(DEFAULT_RULES.map((r) => r.id));
    expect(ids.size).toBe(DEFAULT_RULES.length);
  });
});
