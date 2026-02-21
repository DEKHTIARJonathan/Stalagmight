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
const cssCaveTokens = extractTokens(extractBlock(cssSource, '[data-theme="cave"]'));
const cssDraculaTokens = extractTokens(extractBlock(cssSource, '[data-theme="dracula"]'));
const cssOneDarkTokens = extractTokens(extractBlock(cssSource, '[data-theme="one_dark"]'));
const cssSolarizedLightTokens = extractTokens(extractBlock(cssSource, '[data-theme="solarized_light"]'));
const cssCatppuccinLatteTokens = extractTokens(extractBlock(cssSource, '[data-theme="catppuccin_latte"]'));
const cssNordTokens = extractTokens(extractBlock(cssSource, '[data-theme="nord"]'));
const cssCatppuccinMochaTokens = extractTokens(extractBlock(cssSource, '[data-theme="catppuccin_mocha"]'));

/** Dark themes must include all dark token keys (including map visualization). */
const FULL_DARK_THEMES = ['cave', 'dracula', 'one_dark', 'nord', 'catppuccin_mocha'] as const;

/** Light themes only override UI chrome + controls (no map viz tokens). */
const LIGHT_THEMES = ['light', 'solarized_light', 'catppuccin_latte'] as const;

const cssTokensByTheme: Record<string, Record<string, string>> = {
  dark: cssDarkTokens,
  light: cssLightTokens,
  cave: cssCaveTokens,
  dracula: cssDraculaTokens,
  one_dark: cssOneDarkTokens,
  solarized_light: cssSolarizedLightTokens,
  catppuccin_latte: cssCatppuccinLatteTokens,
  nord: cssNordTokens,
  catppuccin_mocha: cssCatppuccinMochaTokens,
};

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

  it('cave tokens match CSS cave block', () => {
    expect(sortedKeys(cssCaveTokens)).toEqual(sortedKeys(themeTokens.cave));
    for (const [key, value] of Object.entries(themeTokens.cave)) {
      expect(cssCaveTokens[key]).toBe(value);
    }
  });

  it.each(FULL_DARK_THEMES)('%s tokens include all dark token keys (full dark theme)', (theme) => {
    expect(sortedKeys(themeTokens[theme])).toEqual(sortedKeys(themeTokens.dark));
  });

  it.each(FULL_DARK_THEMES)('%s tokens match CSS block', (theme) => {
    const cssTokens = cssTokensByTheme[theme]!;
    expect(sortedKeys(cssTokens)).toEqual(sortedKeys(themeTokens[theme]));
    for (const [key, value] of Object.entries(themeTokens[theme])) {
      expect(cssTokens[key]).toBe(value);
    }
  });

  it.each(LIGHT_THEMES)('%s tokens only override UI chrome and controls', (theme) => {
    const themeKeys = new Set(Object.keys(themeTokens[theme]));
    const missingKeys = Object.keys(themeTokens.dark).filter((key) => !themeKeys.has(key));

    expect(missingKeys.sort()).toEqual([...darkOnlyTokenNames].sort());

    const cssTokens = cssTokensByTheme[theme]!;
    for (const key of darkOnlyTokenNames) {
      expect(themeKeys.has(key)).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(cssTokens, key)).toBe(false);
    }
  });

  it.each(LIGHT_THEMES)('%s tokens match CSS block', (theme) => {
    const cssTokens = cssTokensByTheme[theme]!;
    expect(sortedKeys(cssTokens)).toEqual(sortedKeys(themeTokens[theme]));
    for (const [key, value] of Object.entries(themeTokens[theme])) {
      expect(cssTokens[key]).toBe(value);
    }
  });
});
