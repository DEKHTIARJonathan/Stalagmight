import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOT = path.join(REPO_ROOT, 'src');

export const INTERACTIVE_TAGS = new Set([
  'a',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
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

function repeatedCallback(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isCallExpression(current.parent) &&
      current.parent.arguments.includes(current)
    ) {
      const call = current.parent;
      if (
        ts.isPropertyAccessExpression(call.expression) &&
        (['map', 'flatMap'].includes(call.expression.name.text) ||
          (call.expression.expression.getText() === 'Array' && call.expression.name.text === 'from'))
      ) {
        return current;
      }
    }
    if (ts.isSourceFile(current)) return false;
  }
  return null;
}

function containingJsxParent(node) {
  let child = ts.isJsxOpeningElement(node) ? node.parent : node;
  let current = child.parent;
  for (; current; current = current.parent) {
    if (ts.isConditionalExpression(current)) return child;
    if (ts.isJsxElement(current) || ts.isJsxFragment(current)) return current;
    if (ts.isSourceFile(current)) return null;
    child = current;
  }
  return null;
}

export function analyzeSource(fileName, sourceText) {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings = [];
  const literalContainers = new Map();

  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source);
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      if (isInteractive(node, tag) && !hasTestId(node)) {
        findings.push({ fileName, line, message: `<${tag}> has no data-testid/testId` });
      }
      const literal = literalTestId(node);
      const callback = repeatedCallback(node);
      if (callback && literal) {
        findings.push({
          fileName,
          line,
          message: `test ID${literal ? ` "${literal}"` : ''} is rendered repeatedly; include item identity`,
        });
      }
      if (literal) {
        const container = containingJsxParent(node);
        const prior = literalContainers.get(literal);
        if (container && prior === container) {
          findings.push({ fileName, line, message: `literal test ID "${literal}" is duplicated in one JSX container` });
        } else if (container) {
          literalContainers.set(literal, container);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return findings;
}

function productionTsxFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...productionTsxFiles(fullPath));
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

export function scan(root = SOURCE_ROOT) {
  return productionTsxFiles(root).flatMap((fileName) =>
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
