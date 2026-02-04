import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { darkOnlyTokenNames, themeTokens } from '../tokens';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cssPath = path.resolve(__dirname, '../../index.css');
const cssSource = fs.readFileSync(cssPath, 'utf8');

function extractBlock(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`Missing theme block for marker: ${marker}`);
  }
  const open = source.indexOf('{', start);
  if (open === -1) {
    throw new Error(`Missing opening brace for marker: ${marker}`);
  }
  const close = source.indexOf('}', open);
  if (close === -1) {
    throw new Error(`Missing closing brace for marker: ${marker}`);
  }
  return source.slice(open + 1, close);
}

function extractTokens(block: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  const tokenRegex = /(--cc-[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let match: RegExpExecArray | null = null;
  while ((match = tokenRegex.exec(block)) !== null) {
    const name = match[1];
    const value = match[2];
    if (!name || !value) continue;
    tokens[name] = value.trim();
  }
  return tokens;
}

function sortedKeys(tokens: Record<string, string>): string[] {
  return Object.keys(tokens).sort();
}

const cssDarkTokens = extractTokens(extractBlock(cssSource, ':root,'));
const cssLightTokens = extractTokens(extractBlock(cssSource, '[data-theme="light"]'));

describe('theme tokens', () => {
  it('dark tokens match CSS :root block', () => {
    expect(sortedKeys(cssDarkTokens)).toEqual(sortedKeys(themeTokens.dark));
    for (const [key, value] of Object.entries(themeTokens.dark)) {
      expect(cssDarkTokens[key]).toBe(value);
    }
  });

  it('light tokens match CSS light block', () => {
    expect(sortedKeys(cssLightTokens)).toEqual(sortedKeys(themeTokens.light));
    for (const [key, value] of Object.entries(themeTokens.light)) {
      expect(cssLightTokens[key]).toBe(value);
    }
  });

  it('light tokens only override UI chrome and controls', () => {
    const lightKeys = new Set(Object.keys(themeTokens.light));
    const missingInLight = Object.keys(themeTokens.dark).filter((key) => !lightKeys.has(key));

    expect(missingInLight.sort()).toEqual([...darkOnlyTokenNames].sort());

    for (const key of darkOnlyTokenNames) {
      expect(lightKeys.has(key)).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(cssLightTokens, key)).toBe(false);
    }
  });
});
