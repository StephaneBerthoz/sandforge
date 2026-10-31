import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Icon, ICON_NAMES } from './Icon';

const SRC_ROOT = path.resolve(__dirname, '../..');
/** The table itself, whose comments name the font it replaced. */
const ICON_SOURCE = path.join(SRC_ROOT, 'components', 'ui', 'Icon.tsx');

/** The panel's own sources: no test, no test double, not the table itself. */
function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'testing') files.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

/** A string literal, or each string a `?:`, `??` or `||` of them can give. */
function literalsOf(expression: ts.Expression | undefined): string[] {
  if (expression === undefined) return [];
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return [expression.text];
  }
  if (ts.isParenthesizedExpression(expression)) return literalsOf(expression.expression);
  if (ts.isConditionalExpression(expression)) {
    return [...literalsOf(expression.whenTrue), ...literalsOf(expression.whenFalse)];
  }
  if (
    ts.isBinaryExpression(expression) &&
    (expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      expression.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return [...literalsOf(expression.left), ...literalsOf(expression.right)];
  }
  return [];
}

function attributeLiterals(attribute: ts.JsxAttribute): string[] {
  const initializer = attribute.initializer;
  if (initializer === undefined) return [];
  if (ts.isJsxExpression(initializer)) return literalsOf(initializer.expression);
  return ts.isStringLiteral(initializer) ? [initializer.text] : [];
}

/** Every string a return statement of this function gives, nested functions left out. */
function returnedLiterals(body: ts.Node): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node)) found.push(...literalsOf(node.expression));
    if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  if (!ts.isBlock(body) && ts.isExpression(body)) found.push(...literalsOf(body));
  return found;
}

/** A name, as a codicon spelled it: what an emoji or a one-letter badge is not. */
const ICON_NAME_SHAPE = /^[a-z][a-z0-9-]*$/;

/**
 * Every icon name the sources hand over, where they hand it: `<Icon name>`,
 * an `icon` attribute or property written as a string, and what a table or
 * function typed by `IconName` holds or returns. Each with the place it is
 * written, for a failure to point at.
 */
function iconNamesInUse(): Map<string, string[]> {
  const uses = new Map<string, string[]>();
  const add = (names: string[], file: string, sf: ts.SourceFile, node: ts.Node): void => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    for (const name of names) {
      const at = `${path.relative(SRC_ROOT, file)}:${String(line)}`;
      uses.set(name, [...(uses.get(name) ?? []), at]);
    }
  };
  for (const file of sourceFiles(SRC_ROOT)) {
    if (file === ICON_SOURCE) continue;
    const text = fs.readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node): void => {
      if (ts.isJsxAttribute(node)) {
        const attribute = node.name.getText(sf);
        const tag = node.parent.parent.tagName.getText(sf);
        if ((attribute === 'name' && tag === 'Icon') || attribute === 'icon') {
          add(attributeLiterals(node), file, sf, node);
        }
      } else if (ts.isPropertyAssignment(node) && node.name.getText(sf) === 'icon') {
        add(
          literalsOf(node.initializer).filter((n) => ICON_NAME_SHAPE.test(n)),
          file,
          sf,
          node,
        );
      } else if (
        ts.isVariableDeclaration(node) &&
        node.type?.getText(sf).includes('IconName') &&
        node.initializer !== undefined &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        for (const property of node.initializer.properties) {
          if (ts.isPropertyAssignment(property)) {
            add(literalsOf(property.initializer), file, sf, property);
          }
        }
      } else if (
        ts.isFunctionLike(node) &&
        node.type?.getText(sf).includes('IconName') &&
        'body' in node &&
        node.body !== undefined
      ) {
        add(returnedLiterals(node.body as ts.Node), file, sf, node);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return uses;
}

/**
 * The files that still draw through the codicon font, which never reaches a
 * webview: their spans paint nothing. Each moves to `<Icon>` with the task
 * that owns it, and leaves this list then; no other file joins it.
 */
const STILL_ON_THE_CODICON_FONT = [
  'pages/Compare/DiffDetailModal.tsx',
  'pages/Compare/DiffGroupAccordion.tsx',
  'pages/Monitor/HealthScoreCard.tsx',
  'pages/Monitor/JobsTable.tsx',
  'pages/Sync/CDCEventFeed.tsx',
  'pages/Sync/QuickSync/QuickSyncCard.tsx',
  'pages/Sync/QuickSync/QuickSyncFlow.tsx',
  'pages/Sync/QuickSync/QuickSyncObjectStep.tsx',
  'pages/Sync/QuickSync/QuickSyncOrgStep.tsx',
  'pages/Sync/SyncPage.tsx',
];

describe('Icon', () => {
  it.each(ICON_NAMES)('draws %s as an SVG of its own, which a screen reader skips', (name) => {
    render(<Icon name={name} />);

    const icon = screen.getByTestId(`icon-${name}`);
    expect(icon.tagName.toLowerCase()).toBe('svg');
    // Strokes to paint, where the codicon span held none.
    expect(
      icon.querySelectorAll('path, circle, rect, line, polyline, polygon').length,
    ).toBeGreaterThan(0);
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    expect(icon.getAttribute('role')).toBeNull();
    expect(screen.queryAllByRole('img')).toHaveLength(0);
  });

  it('draws two names as two different glyphs', () => {
    render(
      <>
        <Icon name="edit" />
        <Icon name="trash" />
      </>,
    );
    expect(screen.getByTestId('icon-edit').innerHTML).not.toBe(
      screen.getByTestId('icon-trash').innerHTML,
    );
  });

  it('is an image named by its label when it says what no text beside it says', () => {
    render(<Icon name="error" label="Failed" />);

    const icon = screen.getByRole('img', { name: 'Failed' });
    expect(icon.tagName.toLowerCase()).toBe('svg');
    expect(icon.getAttribute('aria-hidden')).toBeNull();
  });

  it('is one em square, so a text size class sizes it, and never under 12px', () => {
    render(<Icon name="refresh" className="text-lg" />);

    const icon = screen.getByTestId('icon-refresh');
    expect(icon.getAttribute('width')).toBe('1em');
    expect(icon.getAttribute('height')).toBe('1em');
    expect(icon.getAttribute('class')).toContain('text-lg');
    expect(icon.getAttribute('class')).toContain('min-w-3');
    expect(icon.getAttribute('class')).toContain('min-h-3');
  });

  it('spins when asked to', () => {
    render(<Icon name="sync" spin />);
    expect(screen.getByTestId('icon-sync').getAttribute('class')).toContain('sf-spin');
  });

  it('refuses a name it cannot draw, and draws nothing for one forced past the type', () => {
    const { container } = render(
      // @ts-expect-error -- "dashboard" is no icon of the table
      <Icon name="dashboard" />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('draws every icon name the panel’s sources hand over', () => {
    const uses = iconNamesInUse();
    const known = new Set<string>(ICON_NAMES);
    const missing = [...uses]
      .filter(([name]) => !known.has(name))
      .map(([n, at]) => `${n} (${at.join(', ')})`);

    expect(missing).toEqual([]);
    // The buttons that hold nothing but an icon are among what it read.
    for (const name of ['edit', 'trash', 'refresh', 'close'])
      expect(uses.has(name), name).toBe(true);
  });

  it('holds no icon that nothing draws', () => {
    const uses = iconNamesInUse();
    expect(ICON_NAMES.filter((name) => !uses.has(name))).toEqual([]);
  });

  it('is the only way the panel draws an icon, but for the files still on the codicon font', () => {
    const onTheFont = sourceFiles(SRC_ROOT)
      .filter((file) => file !== ICON_SOURCE)
      .filter((file) => /codicon-/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC_ROOT, file).split(path.sep).join('/'))
      .sort();

    expect(onTheFont).toEqual(STILL_ON_THE_CODICON_FONT);
  });
});
