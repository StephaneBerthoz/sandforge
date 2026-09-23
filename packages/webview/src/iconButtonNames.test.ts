import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import ts from 'typescript';
import { describe, it, expect } from 'vitest';

/**
 * Every button says what it does, to a screen reader too.
 *
 * A button whose only content is an icon has no name unless it is given one:
 * a screen reader announces "button" and nothing else. The Sync schedule cards
 * had two such buttons, edit and delete, and the governance panel's delete
 * button was the same. jsx-a11y cannot hold this line — its
 * `control-has-associated-label` is off for the labels it cannot see — and axe
 * only sees the states a scan reaches.
 *
 * Read from the syntax tree of every component: a button element (`button`,
 * `Button`, `m.button`, a Radix trigger or close that renders its own button,
 * anything given `role="button"`) whose children hold no text, and which has
 * no `aria-label`, `aria-labelledby` or `title`, is named here. A child
 * expression other than an element counts as text (`{t('…')}`, `{name}`), a
 * lone symbol does not (`{'\u2715'}`), and props spread onto the element may
 * carry a name, so such an element is left alone.
 */

const SRC = __dirname;

/** Every non-test component file under src/. */
function componentFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) componentFiles(full, acc);
    else if (entry.name.endsWith('.tsx') && !/\.test\./.test(entry.name)) acc.push(full);
  }
  return acc;
}

const NAMING_ATTRIBUTES = new Set(['aria-label', 'aria-labelledby', 'title']);

type JsxOpening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

function openingOf(node: ts.JsxElement | ts.JsxSelfClosingElement): JsxOpening {
  return ts.isJsxElement(node) ? node.openingElement : node;
}

function attribute(opening: JsxOpening, name: string): ts.JsxAttribute | undefined {
  return opening.attributes.properties.find(
    (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name,
  );
}

/** Whether the element renders a button of its own. */
function isButton(opening: JsxOpening): boolean {
  const tag = opening.tagName.getText();
  if (/^(button|Button|m\.button|motion\.button)$/.test(tag)) return true;
  if (/\.(Trigger|Close)$/.test(tag)) return attribute(opening, 'asChild') === undefined;
  const role = attribute(opening, 'role')?.initializer;
  return role !== undefined && ts.isStringLiteral(role) && role.text === 'button';
}

/** Whether a string holds anything to read: a letter or a digit. */
const readable = (text: string): boolean => /[\p{L}\p{N}]/u.test(text);

/** Whether an expression, rendered as a child, can put text on the page. */
function expressionHasText(expression: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(expression)) return expressionHasText(expression.expression);
  if (ts.isJsxElement(expression) || ts.isJsxFragment(expression)) {
    return expression.children.some(childHasText);
  }
  if (ts.isJsxSelfClosingElement(expression)) return false;
  if (ts.isConditionalExpression(expression)) {
    return expressionHasText(expression.whenTrue) || expressionHasText(expression.whenFalse);
  }
  if (
    ts.isBinaryExpression(expression) &&
    (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      expression.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return expressionHasText(expression.right);
  }
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return readable(expression.text);
  }
  if (expression.kind === ts.SyntaxKind.NullKeyword) return false;
  return true;
}

function childHasText(child: ts.JsxChild): boolean {
  if (ts.isJsxText(child)) return readable(child.text);
  if (ts.isJsxExpression(child)) {
    return child.expression !== undefined && expressionHasText(child.expression);
  }
  if (ts.isJsxElement(child) || ts.isJsxFragment(child)) return child.children.some(childHasText);
  return false;
}

/** `file:line <tag>` for every button in `text` that has no name. */
function unnamedButtons(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = openingOf(node);
      const props = opening.attributes.properties;
      const named =
        props.some((p) => ts.isJsxSpreadAttribute(p)) ||
        props.some((p) => ts.isJsxAttribute(p) && NAMING_ATTRIBUTES.has(p.name.getText()));
      const text = ts.isJsxElement(node) && node.children.some(childHasText);
      if (isButton(opening) && !named && !text) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        found.push(`${file}:${line + 1} <${opening.tagName.getText()}>`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('button names', () => {
  it('finds a button that holds only an icon, and passes one that is named', () => {
    // Guards the guard: a scan that stopped seeing buttons would pass everything.
    expect(
      unnamedButtons(
        'x.tsx',
        [
          'const a = <Button onClick={f}><Trash2 className="w-3 h-3" /></Button>;',
          "const b = <button onClick={f}>{'\\u2715'}</button>;",
          "const c = <button aria-label={t('common.dismiss')}>{'\\u2715'}</button>;",
          "const d = <Button icon={<X />}>{t('common.close')}</Button>;",
          '<div role="button" tabIndex={0} onClick={f}><Star /></div>;',
          '<Dialog.Close asChild><Button>{label}</Button></Dialog.Close>;',
        ].join('\n'),
      ),
    ).toEqual(['x.tsx:1 <Button>', 'x.tsx:2 <button>', 'x.tsx:5 <div>']);
  });

  it('gives every button of the panel a name', () => {
    const files = componentFiles(SRC);
    expect(files.length).toBeGreaterThan(100);
    const unnamed = files.flatMap((file) =>
      unnamedButtons(relative(SRC, file), readFileSync(file, 'utf8')),
    );
    expect(unnamed).toEqual([]);
  });
});
