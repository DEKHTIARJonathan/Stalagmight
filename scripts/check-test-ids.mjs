import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPONENT_ROOT = path.join(REPO_ROOT, 'src', 'components');

export const INTERACTIVE_TAGS = new Set([
  'a',
  'button',
  'input',
  'select',
  'textarea',
  'Button',
  'IconButton',
  'MenuRow',
  'Select',
  'Toggle',
  'DatePicker',
  'PositiveNumberField',
  'ShortcutRecorder',
  'PanelOpenerTab',
]);

const INTERACTIVE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'menuitem',
  'option',
  'radio',
  'switch',
  'tab',
]);

const INTERACTION_HANDLERS = new Set([
  'onClick',
  'onContextMenu',
  'onDoubleClick',
]);

function hasTestId(node) {
  return node.attributes.properties.some(
    (attr) => ts.isJsxAttribute(attr) && ['data-testid', 'testId'].includes(attr.name.getText()),
  );
}

function literalAttribute(node, names) {
  const attr = node.attributes.properties.find(
    (candidate) => ts.isJsxAttribute(candidate) && names.includes(candidate.name.getText()),
  );
  if (!attr || !ts.isJsxAttribute(attr) || !attr.initializer) return null;
  if (ts.isStringLiteral(attr.initializer)) return attr.initializer.text;
  if (
    ts.isJsxExpression(attr.initializer) &&
    attr.initializer.expression &&
    ts.isStringLiteral(attr.initializer.expression)
  ) {
    return attr.initializer.expression.text;
  }
  return null;
}

function literalTestId(node) {
  return literalAttribute(node, ['data-testid', 'testId']);
}

function hasAttribute(node, names) {
  return node.attributes.properties.some(
    (attr) => ts.isJsxAttribute(attr) && names.includes(attr.name.getText()),
  );
}

function isInteractive(node, tag) {
  if (INTERACTIVE_TAGS.has(tag)) return true;
  if (tag[0] !== tag[0]?.toLowerCase()) return false;
  const role = literalAttribute(node, ['role']);
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  return hasAttribute(node, [...INTERACTION_HANDLERS]);
}

function isInsideMapCallback(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      current.expression.name.text === 'map'
    ) {
      return true;
    }
    if (ts.isSourceFile(current)) return false;
  }
  return false;
}

export function analyzeSource(fileName, sourceText) {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings = [];

  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source);
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      if (isInteractive(node, tag) && !hasTestId(node)) {
        findings.push({ fileName, line, message: `<${tag}> has no data-testid/testId` });
      }
      const literal = literalTestId(node);
      if (literal && isInsideMapCallback(node)) {
        findings.push({
          fileName,
          line,
          message: `literal test ID "${literal}" is rendered inside map(); include row identity`,
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return findings;
}

function componentFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...componentFiles(fullPath));
    else if (
      entry.name.endsWith('.tsx') &&
      !entry.name.includes('.test.') &&
      !fullPath.includes(`${path.sep}__tests__${path.sep}`)
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

export function scan(root = COMPONENT_ROOT) {
  return componentFiles(root).flatMap((fileName) =>
    analyzeSource(fileName, fs.readFileSync(fileName, 'utf8')),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const findings = scan();
  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(`${path.relative(REPO_ROOT, finding.fileName)}:${finding.line}: ${finding.message}`);
    }
    console.error(`Test-ID gate failed with ${findings.length} finding(s).`);
    process.exitCode = 1;
  } else {
    console.log('Test-ID gate passed.');
  }
}
