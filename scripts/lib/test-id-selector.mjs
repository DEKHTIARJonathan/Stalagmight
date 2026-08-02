/** Quote arbitrary text as a CSS string token. */
export function cssStringLiteral(value) {
  let escaped = '"';
  for (const char of String(value)) {
    const codePoint = char.codePointAt(0);
    if (codePoint === 0) {
      escaped += '\\FFFD ';
    } else if ((codePoint >= 1 && codePoint <= 31) || codePoint === 127) {
      escaped += `\\${codePoint.toString(16).toUpperCase()} `;
    } else if (char === '"' || char === '\\') {
      escaped += `\\${char}`;
    } else {
      escaped += char;
    }
  }
  return `${escaped}"`;
}

/** Build a CSS attribute selector for an exact data-testid value. */
export function testIdSelector(testId) {
  return `[data-testid=${cssStringLiteral(testId)}]`;
}
