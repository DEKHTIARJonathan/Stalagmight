// Hard-coded UI text gate for the dialogs (#576 D20). Zero tolerance.
//
// Only English ships, so English typed straight into a component looks fine -
// until a second locale lands and those strings stay English. The dialogs carried
// ~440 of them (the shared Error/Confirm/unsaved-changes primitives every dialog
// renders among them, and 13 validation errors) while the rest of the app went
// through i18n (src/i18n/locales/en.json, `t('...')`). This gate keeps the dialog
// layer at zero: every user-visible string it finds must come from `t()`, or be
// an allowlisted literal that is not language (a file-format or brand name).
//
// Scope: every production .ts/.tsx under src/components/Dialogs/ (subfolders
// included), plus each src/components/common/ module a dialog file imports - the
// primitives dialogs are built from (Button, Select, Toggle, ...). The common set
// is derived from the imports on every run, so a dialog that starts using a new
// primitive brings it into scope. Tests are excluded (scripts/lib/src-files.mjs).
//
// What counts as user-visible text (TypeScript compiler API, syntax only):
//   - JSX text:                                  <p>Delete shot</p>
//   - a string in a JSX child expression:        {busy ? 'Saving...' : label}
//   - a user-facing JSX attribute:               title="Edit Shot" aria-label={`Close ${x}`}
//     (USER_FACING_ATTRS below)
//   - a user-facing property in an object literal: openDialog('error', { title: 'Failed' })
//     (USER_FACING_PROPS below)
//   - an error/message setter argument:          setError('Name is required')
//     (a call to set...Error / ...Message / ...Warning / ...Notice)
// Strings are followed through `a ? 'x' : 'y'`, `a && 'x'`, `a ?? 'x'`, `a || 'x'`,
// `'a' + b`, parentheses and `as` casts - never into a call, so `t('key')` and its
// key are never flagged. A string counts only if it has a letter once template
// placeholders (`${...}`) and HTML entities (`&rarr;`) are removed, so `{' · '}`,
// `{`${n}/${m}`}` and `&times;` pass.
//
// Allowlist (scripts/i18n-literals-allowlist.json): exact {file, text, reason}
// rows for literals that are not language. A row covers every occurrence of that
// text in that file. A row that matches nothing fails (stale), so the list cannot
// quietly outlive its reason.
//
// Usage:  node scripts/check-i18n-literals.mjs   (pnpm lint:i18n-literals)
// Fixtures: scripts/check-i18n-literals.test.mjs (pnpm lint:i18n-literals:test)

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import ts from 'typescript';
import { walkFiles, isTestPath, symlinkProblem } from './lib/src-files.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DIALOGS_DIR = 'src/components/Dialogs';
export const COMMON_DIR = 'src/components/common';
export const ALLOWLIST_FILE = 'scripts/i18n-literals-allowlist.json';

export const USER_FACING_ATTRS = new Set([
  'title',
  'label',
  'placeholder',
  'alt',
  'aria-label',
  'aria-description',
  'aria-roledescription',
  'aria-valuetext',
  'aria-placeholder',
  'tooltip',
  'description',
  'message',
  'confirmLabel',
  'cancelLabel',
  'helpText',
  'hint',
  'subtitle',
  'heading',
  'emptyText',
  'emptyMessage',
]);
export const USER_FACING_PROPS = new Set([
  'title',
  'label',
  'message',
  'description',
  'placeholder',
  'confirmLabel',
  'cancelLabel',
  'tooltip',
  'hint',
  'subtitle',
  'detail',
]);
const MESSAGE_SETTER = /^set\w*(Error|Errors|Message|Warning|Notice)$/;

const relPosix = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

// The letters left once placeholders and HTML entities are gone.
export function hasLetters(text) {
  const stripped = text
    .replace(/\$\{[^}]*\}/g, '')
    .replace(/&(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);/g, '');
  return /[A-Za-z]/.test(stripped);
}

// The string-literal nodes an expression can evaluate to (see the header).
function stringsIn(e) {
  if (!e) return [];
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isTemplateExpression(e)) return [e];
  if (ts.isConditionalExpression(e)) return [...stringsIn(e.whenTrue), ...stringsIn(e.whenFalse)];
  if (ts.isBinaryExpression(e)) {
    const k = e.operatorToken.kind;
    if (k === ts.SyntaxKind.AmpersandAmpersandToken) return stringsIn(e.right);
    if (k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.QuestionQuestionToken || k === ts.SyntaxKind.PlusToken) {
      return [...stringsIn(e.left), ...stringsIn(e.right)];
    }
    return [];
  }
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression?.(e)) {
    return stringsIn(e.expression);
  }
  return [];
}

const literalText = (node, source) =>
  ts.isTemplateExpression(node) ? node.getText(source).slice(1, -1) : node.text;

const normalize = (text) => text.replace(/\s+/g, ' ').trim();

// Findings in one file: [{file, line, kind, text}].
export function analyzeSource(file, sourceText) {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, kind);
  const findings = [];
  const add = (node, what, text) => {
    if (!hasLetters(text)) return;
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    findings.push({ file, line, kind: what, text: normalize(text) });
  };
  const visit = (node) => {
    if (ts.isJsxText(node)) {
      add(node, 'jsx-text', node.text);
    } else if (ts.isJsxAttribute(node) && node.initializer && USER_FACING_ATTRS.has(node.name.getText(source))) {
      const what = `attr ${node.name.getText(source)}`;
      if (ts.isStringLiteral(node.initializer)) add(node, what, node.initializer.text);
      else if (ts.isJsxExpression(node.initializer)) {
        for (const s of stringsIn(node.initializer.expression)) add(s, what, literalText(s, source));
      }
    } else if (ts.isJsxExpression(node) && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      for (const s of stringsIn(node.expression)) add(s, 'jsx-expr', literalText(s, source));
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && MESSAGE_SETTER.test(node.expression.text)) {
      for (const arg of node.arguments) {
        for (const s of stringsIn(arg)) add(s, `${node.expression.text}()`, literalText(s, source));
      }
    } else if (
      ts.isPropertyAssignment(node) &&
      ts.isObjectLiteralExpression(node.parent) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      USER_FACING_PROPS.has(node.name.text)
    ) {
      for (const s of stringsIn(node.initializer)) add(s, `prop ${node.name.text}`, literalText(s, source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

// Relative imports of a file, resolved to repo-relative paths that exist.
function resolvedImports(root, rel, sourceText) {
  const source = ts.createSourceFile(rel, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out = [];
  for (const stmt of source.statements) {
    const spec =
      (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)
        ? stmt.moduleSpecifier.text
        : null;
    if (!spec || !spec.startsWith('.')) continue;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
    for (const cand of [base, `${base}.tsx`, `${base}.ts`, `${base}/index.tsx`, `${base}/index.ts`]) {
      const abs = path.join(root, cand);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        out.push(cand);
        break;
      }
    }
  }
  return out;
}

// The files in scope: {files, symlinks}. See the header.
export function scopeFiles(root = REPO_ROOT) {
  const exts = ['.ts', '.tsx'];
  const dialogs = walkFiles(root, DIALOGS_DIR, { exts, skip: isTestPath });
  const common = new Set();
  for (const rel of dialogs.files) {
    for (const dep of resolvedImports(root, rel, fs.readFileSync(path.join(root, rel), 'utf8'))) {
      if (dep.startsWith(`${COMMON_DIR}/`) && !isTestPath(dep) && /\.tsx?$/.test(dep)) common.add(dep);
    }
  }
  return { files: [...dialogs.files, ...[...common].sort()], symlinks: dialogs.symlinks };
}

export function loadAllowlist(root = REPO_ROOT) {
  const parsed = JSON.parse(fs.readFileSync(path.join(root, ALLOWLIST_FILE), 'utf8'));
  return parsed.entries ?? [];
}

// Split findings into those the allowlist does not cover, and allowlist rows that
// cover nothing.
export function applyAllowlist(findings, entries) {
  const key = (file, text) => `${file}\u0000${text}`;
  const allowed = new Map(entries.map((e) => [key(e.file, normalize(e.text)), e]));
  const used = new Set();
  const violations = [];
  for (const f of findings) {
    const k = key(f.file, f.text);
    if (allowed.has(k)) used.add(k);
    else violations.push(f);
  }
  const stale = entries.filter((e) => !used.has(key(e.file, normalize(e.text))));
  return { violations, stale };
}

export function scan(root = REPO_ROOT) {
  const { files, symlinks } = scopeFiles(root);
  const findings = files.flatMap((rel) => analyzeSource(rel, fs.readFileSync(path.join(root, rel), 'utf8')));
  return { files, symlinks, findings };
}

export function main(root = REPO_ROOT) {
  const { files, symlinks, findings } = scan(root);
  const entries = loadAllowlist(root);
  const bad = entries.filter((e) => typeof e.reason !== 'string' || e.reason.trim() === '');
  const { violations, stale } = applyAllowlist(findings, entries);
  let failed = false;
  for (const link of symlinks) {
    failed = true;
    console.error(`✗ ${symlinkProblem(link)}`);
  }
  if (violations.length > 0) {
    failed = true;
    console.error(`\n✗ i18n literals: ${violations.length} hard-coded UI string(s) in the dialog layer:\n`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.kind}  ${JSON.stringify(v.text)}`);
    console.error(
      `\nMove each into src/i18n/locales/en.json and render it with t('...') (keep the English byte-identical).` +
        `\nA literal that is not language (a file-format or brand name) goes in ${ALLOWLIST_FILE} with a reason.`,
    );
  }
  if (stale.length > 0) {
    failed = true;
    console.error(`\n✗ i18n literals: ${stale.length} allowlist row(s) match nothing - remove them:\n`);
    for (const s of stale) console.error(`  ${s.file}  ${JSON.stringify(s.text)}`);
  }
  if (bad.length > 0) {
    failed = true;
    console.error(`\n✗ i18n literals: ${bad.length} allowlist row(s) without a reason.`);
  }
  if (failed) return 1;
  console.log(
    `✓ i18n literals: ${files.length} dialog-layer files, no hard-coded UI text ` +
      `(${findings.length - violations.length} allowlisted literal(s) in ${ALLOWLIST_FILE}).`,
  );
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main());
