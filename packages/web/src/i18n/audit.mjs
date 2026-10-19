import * as ts from 'typescript';

const WHITELIST_ATTRS = new Set([
  'className',
  'style',
  'src',
  'href',
  'alt',
  'id',
  'name',
  'type',
  'htmlFor',
  'role',
  'key',
  'ref',
  'value',
  'defaultValue',
  'aria-hidden',
  'onClick',
  'onChange',
  'onKeyDown',
  'onMouseDown',
  'onSubmit',
  'onFocus',
  'onBlur',
  'placeholder',
  'title',
]);

const WHITELIST_TEXT = new Set(['true', 'false']);

function hasTranslatableText(text) {
  return /\p{L}/u.test(text) && !WHITELIST_TEXT.has(text.trim().toLowerCase());
}

export function auditComponentSource(source, filePath = 'component.tsx') {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const findings = [];

  function report(node, text) {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    findings.push({ line: line + 1, column: character + 1, text: text.slice(0, 80) });
  }

  function visit(node) {
    if (ts.isJsxText(node)) {
      const text = node.getText(sourceFile).trim();
      if (hasTranslatableText(text)) {
        report(node, text);
      }
      return;
    }

    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const text = node.text;
      const parent = node.parent;
      if (!hasTranslatableText(text)) return;

      if (ts.isJsxElement(parent) || ts.isJsxFragment(parent) || ts.isJsxExpression(parent)) {
        report(node, text);
        return;
      }

      if (ts.isJsxAttribute(parent)) {
        const attrName = parent.name.getText(sourceFile);
        if (!WHITELIST_ATTRS.has(attrName)) {
          report(node, text);
        }
        return;
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}
