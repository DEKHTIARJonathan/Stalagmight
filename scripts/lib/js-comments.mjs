// String-aware JS/TS comment stripping for the line-based source gates
// (#576 E7 / E2 / E14): check-e2e-parallel-safe.mjs, the read-only gating
// tripwire and check-e2e-no-sleep.mjs.
//
// Removes `//` and `/* */` comments from a file's lines while KEEPING string
// and template contents (a rule must still see `'localhost:5173'` or
// `'closureAdjusted'`). `/* */` and template literals carry across lines;
// '...' and "..." end at the line end. A quoted `/*` or `//` is not a comment -
// the bug class both older per-line strippers had (one blanked the rest of a
// file after 'fixtures/*.dmp', the other missed block comments entirely).
// Not a parser: a regex literal holding a quote can confuse it for the rest of
// that one line, which can only make a gate see MORE code, never less.
export function stripComments(lines) {
  const out = [];
  let inBlock = false;
  let inTemplate = false;
  for (const line of lines) {
    let code = '';
    let quote = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      const n = line[i + 1];
      if (inBlock) {
        if (c === '*' && n === '/') { inBlock = false; i++; code += ' '; }
        continue;
      }
      if (inTemplate || quote) {
        code += c;
        if (c === '\\') { code += n ?? ''; i++; continue; }
        if (inTemplate && c === '`') inTemplate = false;
        else if (quote && c === quote) quote = null;
        continue;
      }
      if (c === '/' && n === '/') break;
      if (c === '/' && n === '*') { inBlock = true; i++; code += ' '; continue; }
      if (c === "'" || c === '"') quote = c;
      else if (c === '`') inTemplate = true;
      code += c;
    }
    out.push(code);
  }
  return out;
}
