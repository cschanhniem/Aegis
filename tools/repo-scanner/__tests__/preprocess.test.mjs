/**
 * Tests for the string-literal preprocessor. Verifies that:
 *  - import / from statements inside Python strings are erased
 *  - import statements inside JS template literals are erased
 *  - URL strings ARE blanked (so HTTP signatures wouldn't fire on
 *    blanked text — but the scanner uses raw text for HTTP, so this
 *    is fine)
 *  - Line numbers preserved
 *  - Real code outside strings is untouched
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const { blankOutStrings } = await import('../preprocess.mjs')

test('Python: triple-quoted docstring with import → blanked', () => {
  const src = `"""
example:
  import anthropic
  client = anthropic.Anthropic()
"""
import openai
`
  const out = blankOutStrings(src, 'python')
  // The string body should be blanked
  assert.ok(!/import\s+anthropic/.test(out), 'string-body import should be blanked')
  // Real import outside the docstring should survive
  assert.ok(/import openai/.test(out), 'real import line should survive')
})

test('Python: single-line single-quoted string → blanked', () => {
  const src = `s = 'import anthropic'\nimport openai\n`
  const out = blankOutStrings(src, 'python')
  assert.ok(!/import anthropic/.test(out))
  assert.ok(/import openai/.test(out))
})

test('Python: f-string prefix recognised', () => {
  const src = `s = f"the snippet is: import anthropic; do stuff"\nimport mistralai\n`
  const out = blankOutStrings(src, 'python')
  assert.ok(!/import anthropic/.test(out))
  assert.ok(/import mistralai/.test(out))
})

test('Python: line numbers preserved (newlines untouched)', () => {
  const src = `"""line1
line2
line3"""
import openai
`
  const out = blankOutStrings(src, 'python')
  const lines = out.split('\n')
  // src has 4 newlines → 5 segments, last empty.
  //  index 0: `"""line1`     → all blanked
  //  index 1: `line2`        → all blanked
  //  index 2: `line3"""`     → all blanked
  //  index 3: `import openai` (real code, preserved)
  //  index 4: `` (trailing)
  assert.equal(lines.length, 5)
  assert.ok(lines[3].includes('import openai'))
})

test('JS: backtick template literal with import → blanked', () => {
  const src = "const snippet = `import OpenAI from 'openai'\\nconst c = new OpenAI()`\nimport Anthropic from '@anthropic-ai/sdk'\n"
  const out = blankOutStrings(src, 'javascript')
  // The template-literal body's text "import OpenAI" must be gone
  assert.ok(!/import\s+OpenAI/.test(out), `expected blanked: ${out}`)
  // Real import must survive
  assert.ok(/import Anthropic/.test(out))
})

test('JS: double-quoted import string → blanked', () => {
  const src = `const x = "from anthropic import Anthropic"\nimport OpenAI from 'openai'\n`
  const out = blankOutStrings(src, 'javascript')
  assert.ok(!/from anthropic/.test(out))
  assert.ok(/import OpenAI/.test(out))
})

test('JS: block comment containing import → blanked', () => {
  const src = `/* example:\nimport anthropic from '@anthropic-ai/sdk'\n*/\nimport OpenAI from 'openai'\n`
  const out = blankOutStrings(src, 'javascript')
  assert.ok(!/import anthropic/.test(out))
  assert.ok(/import OpenAI/.test(out))
})

test('JS: line comment containing import → blanked', () => {
  const src = `// import anthropic\nimport OpenAI from 'openai'\n`
  const out = blankOutStrings(src, 'javascript')
  assert.ok(!/import anthropic/.test(out))
  assert.ok(/import OpenAI/.test(out))
})

test('JS: escaped quote inside string does NOT terminate string early', () => {
  const src = "const s = \"foo \\\" import anthropic\"\nimport OpenAI from 'openai'\n"
  const out = blankOutStrings(src, 'javascript')
  assert.ok(!/import anthropic/.test(out))
  assert.ok(/import OpenAI/.test(out))
})

test('unknown language → returns text untouched (no false-negative risk)', () => {
  const src = `import anthropic\n"some string"\n`
  const out = blankOutStrings(src, 'rust')
  assert.equal(out, src)
})

test('Go: strings are blanked — but Go imports embed module paths in strings, so this preprocessor is NOT used for Go in the scanner pipeline (this test verifies the standalone behaviour)', () => {
  const src = `package main
const note = "import openai"
import "github.com/sashabaranov/go-openai"
`
  const out = blankOutStrings(src, 'go')
  // The preprocessor blanks all double-quoted strings, including the
  // module-import path. This is why the scanner does NOT use this
  // preprocessor — see comment in index.mjs.
  assert.ok(!/import openai/.test(out))
  assert.ok(!/sashabaranov\/go-openai/.test(out))
})
