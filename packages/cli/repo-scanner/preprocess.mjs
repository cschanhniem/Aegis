/**
 * String-literal aware preprocessor for the scanner regex stage.
 *
 * Problem this solves: snippet strings in our cockpit / docs that
 * contain literal `import anthropic` cause false-positive framework
 * detections. Tree-sitter would solve this properly; that's a big
 * dependency commit. This module is the 90% solution at zero deps:
 *
 *   blankOutStrings(text, lang) → text'
 *
 * Returns the same text with all string-literal bodies replaced by
 * spaces (preserving newlines + offsets so line numbers don't drift).
 * The framework / workflow / tool regexes then run on text'; matches
 * that would have fired inside a string are gone.
 *
 * Python:
 *   - triple-double, triple-single docstrings (raw, byte, f-string variants)
 *   - regular ' / " strings, with backslash-escape awareness
 *
 * JavaScript / TypeScript:
 *   - template literals (backtick)
 *   - regular ' / " strings, with backslash-escape awareness
 *   - JSX strings (handled correctly since they're identical to "..." / '...')
 *
 * What we deliberately DON'T do:
 *   - parse comments — many false positives we care about are in
 *     comments AND string literals; blanking strings is enough to
 *     close the gap that motivated this work
 *   - balance nested backticks-in-${...} interpolations — see note
 *     in the JS scanner below
 */

const SPACE = (ch) => (ch === '\n' || ch === '\r' ? ch : ' ')

function blankOutPythonStrings(text) {
  const out = []
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    // Skip Python comments lock-stock (regex-side anchors usually
    // start with `^\s*` and # already prevents `import` from being
    // a Python import). We DO blank them so URL/string scanners
    // don't double-match.
    if (c === '#') {
      while (i < n && text[i] !== '\n') { out.push(' '); i++ }
      continue
    }
    // String prefix (rb"...", f'...', etc.). Strip the prefix then
    // jump into the matching opener detection below.
    const prefixMatch = text.slice(i).match(/^([rRbBuUfF]{0,3})([\"'])/)
    if (prefixMatch) {
      // Emit spaces for the prefix
      for (let k = 0; k < prefixMatch[1].length; k++) out.push(' ')
      i += prefixMatch[1].length
      const quote = text[i]
      // Triple-quoted?
      if (text[i + 1] === quote && text[i + 2] === quote) {
        const close = quote + quote + quote
        out.push(' ', ' ', ' ')
        i += 3
        while (i < n && text.slice(i, i + 3) !== close) {
          out.push(SPACE(text[i]))
          i++
        }
        if (i < n) { out.push(' ', ' ', ' '); i += 3 }
        continue
      }
      // Single-line single-quoted
      out.push(' ')
      i++
      while (i < n && text[i] !== quote && text[i] !== '\n') {
        if (text[i] === '\\' && i + 1 < n) { out.push(' ', ' '); i += 2; continue }
        out.push(SPACE(text[i]))
        i++
      }
      if (i < n && text[i] === quote) { out.push(' '); i++ }
      continue
    }
    out.push(c)
    i++
  }
  return out.join('')
}

function blankOutJsStrings(text) {
  const out = []
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    // Line comments
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') { out.push(' '); i++ }
      continue
    }
    // Block comments
    if (c === '/' && text[i + 1] === '*') {
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        out.push(SPACE(text[i]))
        i++
      }
      if (i < n) { out.push(' ', ' '); i += 2 }
      continue
    }
    // Strings
    if (c === '"' || c === "'") {
      const quote = c
      out.push(' ')
      i++
      while (i < n && text[i] !== quote && text[i] !== '\n') {
        if (text[i] === '\\' && i + 1 < n) { out.push(' ', ' '); i += 2; continue }
        out.push(SPACE(text[i]))
        i++
      }
      if (i < n && text[i] === quote) { out.push(' '); i++ }
      continue
    }
    // Template literals
    if (c === '`') {
      out.push(' ')
      i++
      // We treat ${...} as part of the string body. Real interpolated
      // code in a snippet COULD contain `import openai` — but in
      // practice that's a snippet itself (a doc example), which is
      // exactly what we want to blank out. So we don't try to recurse
      // into ${...}.
      while (i < n && text[i] !== '`') {
        if (text[i] === '\\' && i + 1 < n) { out.push(' ', ' '); i += 2; continue }
        out.push(SPACE(text[i]))
        i++
      }
      if (i < n && text[i] === '`') { out.push(' '); i++ }
      continue
    }
    out.push(c)
    i++
  }
  return out.join('')
}

export function blankOutStrings(text, lang) {
  if (!text) return text
  if (lang === 'python') return blankOutPythonStrings(text)
  if (lang === 'javascript') return blankOutJsStrings(text)
  // Go: same string rules as JS (double-quote escapes, backtick raw, no interpolation)
  if (lang === 'go') return blankOutJsStrings(text)
  return text   // unknown language → don't touch (no false-negative risk)
}
