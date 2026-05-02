/**
 * Disposable-hygiene audit (HARD-07, Plan 01-04-08).
 *
 * Walks every `.ts` file under `packages/extension/src/` (excluding tests,
 * type definitions, and node_modules) and finds registrations that *could*
 * leak if their disposable handle isn't cleaned up:
 *
 *   - `setInterval(...)` / `setTimeout(...)`
 *   - `.on(...)` / `.addListener(...)` on EventEmitter-like objects
 *   - `.onDidChange*(...)` / `.onDidReceiveMessage(...)` VSCode events
 *   - `addEventListener(...)`
 *
 * For each match we check if the result (a) is assigned to a variable that
 * later lands in `context.subscriptions.push(...)` OR `subscriptions.push(...)`,
 * (b) is wrapped in a `{ dispose: ... }` object, (c) has a matching
 * `clearInterval`/`clearTimeout`/`off`/`removeListener` in the same file, or
 * (d) is returned from a `register*` / `subscribe*` function. Anything else
 * is reported as an orphan.
 *
 * The report goes to
 * `.planning/phases/01-hardening-foundations/01-04-DISPOSABLE-AUDIT.md`.
 *
 * Run with:  pnpm audit:disposables
 */
import { Project, SyntaxKind } from 'ts-morph';
import type { CallExpression, Node, SourceFile } from 'ts-morph';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, relative } from 'node:path';

interface Orphan {
  file: string;
  line: number;
  snippet: string;
  category: string;
}

/** Identifier names we care about as potential leak sources. */
const TIMER_CALLS = new Set(['setInterval', 'setTimeout']);
const LISTENER_METHODS = new Set([
  'on',
  'addListener',
  'addEventListener',
  'onDidReceiveMessage',
]);
// onDidChange* is matched via prefix below.

function isTimerCall(call: CallExpression): boolean {
  const expr = call.getExpression();
  if (expr.getKind() === SyntaxKind.Identifier) {
    return TIMER_CALLS.has(expr.getText());
  }
  return false;
}

function listenerCategory(call: CallExpression): string | null {
  const expr = call.getExpression();
  if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) {
    return null;
  }
  const prop = expr.asKind(SyntaxKind.PropertyAccessExpression);
  if (!prop) return null;
  const name = prop.getName();
  if (LISTENER_METHODS.has(name)) {
    if (name === 'onDidReceiveMessage') return 'vscode-event';
    if (name === 'addEventListener') return 'dom-event';
    return 'event-emitter';
  }
  if (name.startsWith('onDid') || name.startsWith('onWill')) {
    return 'vscode-event';
  }
  return null;
}

/**
 * Returns true when the call expression's result is retained somewhere
 * reasonable: a push to `subscriptions`, a `.dispose()` wrapper, or a
 * matching clear/off/remove invocation in the same file.
 */
function hasDisposableSink(call: CallExpression, source: SourceFile, category: string): boolean {
  const sourceText = source.getFullText();

  // Heuristic A: result lands in a variable that is pushed to subscriptions.
  // Walk upward to find a VariableDeclaration or assignment; then search for
  // `subscriptions.push(<that identifier>)` in the file.
  const parent = call.getParentWhile(
    (_node: Node, child: Node) =>
      child.getKind() !== SyntaxKind.VariableDeclaration
      && child.getKind() !== SyntaxKind.BinaryExpression
      && child.getKind() !== SyntaxKind.ExpressionStatement
      && child.getKind() !== SyntaxKind.PropertyAssignment,
  );

  let varName: string | null = null;
  let memberAccess: string | null = null;
  if (parent) {
    const varDecl = parent.asKind(SyntaxKind.VariableDeclaration);
    if (varDecl) {
      const id = varDecl.getNameNode();
      if (id.getKind() === SyntaxKind.Identifier) {
        varName = id.getText();
      }
    }
    const bin = parent.asKind(SyntaxKind.BinaryExpression);
    if (bin && bin.getOperatorToken().getText() === '=') {
      const left = bin.getLeft();
      if (left.getKind() === SyntaxKind.Identifier) {
        varName = left.getText();
      }
      // `this.foo = call()` — capture the `foo` segment for dispose lookup.
      const propAccess = left.asKind(SyntaxKind.PropertyAccessExpression);
      if (propAccess) {
        memberAccess = propAccess.getName();
      }
    }
  }
  if (memberAccess) {
    // Covers: this.foo.dispose(), this.foo?.dispose(), foo.dispose(),
    // this.foo.unsubscribe(), foo?.()
    const memberDispose = new RegExp(
      `\\b${memberAccess}(\\?\\.|\\.)(dispose|unsubscribe)\\s*\\(`,
    );
    if (memberDispose.test(sourceText)) return true;
    // Callable-unsubscribe member pattern: `this.foo?.()` or `this.foo()`
    const memberInvoke = new RegExp(`\\b${memberAccess}(\\?\\.)?\\s*\\(\\s*\\)`);
    if (memberInvoke.test(sourceText)) return true;
  }
  if (varName) {
    const pushPattern = new RegExp(`subscriptions\\.push\\s*\\([^)]*\\b${varName}\\b`);
    if (pushPattern.test(sourceText)) return true;
    const clearPattern = new RegExp(
      `(clearInterval|clearTimeout|off|removeListener|removeEventListener)\\s*\\(\\s*${varName}\\b`,
    );
    if (clearPattern.test(sourceText)) return true;
    // Unsubscribe callback pattern: `const unsub = ...; unsub();`
    const invokePattern = new RegExp(`\\b${varName}\\s*\\(\\s*\\)`);
    if (invokePattern.test(sourceText)) return true;
    // VSCode Disposable pattern: `varName.dispose()` explicitly called.
    const disposeCall = new RegExp(`\\b${varName}\\.dispose\\s*\\(`);
    if (disposeCall.test(sourceText)) return true;
    // Collection storage: `anyCollection.set(.., varName)` / `.push(.., varName)`
    // — file is responsible for iterating + disposing later.
    // The trailing boundary accepts a word-boundary OR the array-literal
    // closer `]` (e.g. `set(key, [varA, varB])`) followed by `)` or `,`.
    const stored = new RegExp(
      `\\.(set|push|add)\\s*\\(\\s*(?:[^,)]+,\\s*)*(?:\\[[^\\]]*${varName}[^\\]]*\\]|${varName}(?=\\b|\\s|,|\\)))`,
    );
    if (stored.test(sourceText)) return true;
  }

  // Heuristic A2: call appears inside a `.push(...)` arg list (spread broker
  // subscriptions idiom — `this.unsubscribers.push(broker.on(...), broker.on(...))`).
  let ancestor: Node | undefined = call.getParent();
  for (let i = 0; i < 10 && ancestor; i++) {
    const callAncestor = ancestor.asKind(SyntaxKind.CallExpression);
    if (callAncestor) {
      const expr = callAncestor.getExpression();
      if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
        const name = expr.asKind(SyntaxKind.PropertyAccessExpression)?.getName();
        if (name === 'push') return true;
      }
    }
    ancestor = ancestor.getParent();
  }

  // Heuristic A3: for .on(event, handlerVar) — look for a matching
  // .off(event, handlerVar) call in the same file where handlerVar is an
  // identifier passed as the 2nd argument. Accepts `.off(...)` and
  // `.off?.(...)` (optional chaining).
  if (category === 'event-emitter') {
    const args = call.getArguments();
    if (args.length >= 2) {
      const handler = args[1];
      if (handler.getKind() === SyntaxKind.Identifier) {
        const handlerName = handler.getText();
        const offPattern = new RegExp(
          `\\.(off|removeListener)(\\?\\.)?\\s*\\(\\s*[^,)]+,\\s*${handlerName}\\b`,
        );
        if (offPattern.test(sourceText)) return true;
      }
    }
  }

  // Heuristic B: call is directly wrapped: `subscriptions.push({ dispose: () => clearInterval(...) })`
  // Walk upward looking for an enclosing object literal with a `dispose:` key
  // that is within 6 ancestors.
  let node: Node | undefined = call;
  for (let i = 0; i < 8 && node; i++) {
    const obj = node.asKind(SyntaxKind.ObjectLiteralExpression);
    if (obj) {
      const hasDispose = obj.getProperties().some((p: Node) => {
        const pa = p.asKind(SyntaxKind.PropertyAssignment);
        return pa?.getName() === 'dispose';
      });
      if (hasDispose) return true;
    }
    node = node.getParent();
  }

  // Heuristic C: category-specific — the file contains at least one paired
  // clear/off/remove call somewhere. (Loose but kills obvious false positives
  // on well-cared-for modules.)
  if (category === 'timer') {
    if (/clear(Interval|Timeout)\s*\(/.test(sourceText)) return true;
    // `new Promise(r => setTimeout(r, ms))` — the Promise resolves when the
    // timer fires so nothing needs to be disposed. Inspect ancestors up to 8
    // levels for a `new Promise(...)` callsite.
    let promiseAncestor: Node | undefined = call.getParent();
    for (let i = 0; i < 8 && promiseAncestor; i++) {
      const newExpr = promiseAncestor.asKind(SyntaxKind.NewExpression);
      if (newExpr && newExpr.getExpression().getText() === 'Promise') {
        return true;
      }
      promiseAncestor = promiseAncestor.getParent();
    }
  }
  if (category === 'event-emitter') {
    if (/\.(off|removeListener)\s*\(/.test(sourceText)) return true;
  }
  if (category === 'dom-event') {
    if (/removeEventListener\s*\(/.test(sourceText)) return true;
  }

  // Heuristic D: enclosing function returns something — assume caller handles
  // disposal (common for `register*`/`subscribe*` helpers).
  let fn: Node | undefined = call.getParent();
  while (fn) {
    if (
      fn.getKind() === SyntaxKind.FunctionDeclaration
      || fn.getKind() === SyntaxKind.MethodDeclaration
      || fn.getKind() === SyntaxKind.ArrowFunction
      || fn.getKind() === SyntaxKind.FunctionExpression
    ) {
      const fnText = fn.getText();
      // If the enclosing function has a `return` statement and its name looks
      // like a register helper, treat as disposed by the caller.
      const name = (fn.asKind(SyntaxKind.FunctionDeclaration)?.getName?.()
        ?? fn.asKind(SyntaxKind.MethodDeclaration)?.getName?.()
        ?? '') as string;
      if (/return\b/.test(fnText) && /^(register|subscribe|watch|listen|track)/i.test(name)) {
        return true;
      }
      break;
    }
    fn = fn.getParent();
  }

  return false;
}

function toSnippet(call: CallExpression): string {
  const text = call.getText();
  return text.length > 140 ? text.slice(0, 140) + '…' : text;
}

function main(): void {
  const repoRoot = process.cwd();
  const project = new Project({
    tsConfigFilePath: 'packages/extension/tsconfig.json',
    skipAddingFilesFromTsConfig: false,
  });

  const orphans: Orphan[] = [];
  let timerTotal = 0;
  let listenerTotal = 0;

  for (const source of project.getSourceFiles()) {
    const path = source.getFilePath();
    if (!path.includes('/packages/extension/src/')) continue;
    if (/\.test\.ts$/.test(path)) continue;
    if (/\.d\.ts$/.test(path)) continue;
    if (path.includes('node_modules')) continue;

    const calls = source.getDescendantsOfKind(SyntaxKind.CallExpression);
    for (const call of calls) {
      if (isTimerCall(call)) {
        timerTotal++;
        if (!hasDisposableSink(call, source, 'timer')) {
          orphans.push({
            file: relative(repoRoot, path).replace(/\\/g, '/'),
            line: call.getStartLineNumber(),
            snippet: toSnippet(call),
            category: 'timer',
          });
        }
        continue;
      }
      const listenerCat = listenerCategory(call);
      if (listenerCat) {
        listenerTotal++;
        if (!hasDisposableSink(call, source, listenerCat)) {
          orphans.push({
            file: relative(repoRoot, path).replace(/\\/g, '/'),
            line: call.getStartLineNumber(),
            snippet: toSnippet(call),
            category: listenerCat,
          });
        }
      }
    }
  }

  // Sort by file then line for deterministic reports.
  orphans.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));

  const byCategory = new Map<string, number>();
  for (const o of orphans) {
    byCategory.set(o.category, (byCategory.get(o.category) ?? 0) + 1);
  }

  const outPath = '.planning/phases/01-hardening-foundations/01-04-DISPOSABLE-AUDIT.md';
  mkdirSync(dirname(outPath), { recursive: true });

  const lines: string[] = [
    '# Disposable Hygiene Audit',
    '',
    `**Generated:** ${new Date().toISOString()}`,
    `**Script:** \`scripts/audit-disposables.ts\``,
    '',
    '## Summary',
    '',
    `- Total timer calls scanned: **${timerTotal}**`,
    `- Total listener calls scanned: **${listenerTotal}**`,
    `- Orphan registrations (no disposable sink found): **${orphans.length}**`,
    '',
    '### By category',
    '',
    ...[...byCategory.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([cat, n]) => `- \`${cat}\`: ${n}`),
    '',
    '## Orphans',
    '',
    orphans.length === 0
      ? '_No orphans detected. Nice hygiene!_'
      : orphans
        .map(
          (o) =>
            `- **${o.file}:${o.line}** [\`${o.category}\`]\n  \`\`\`ts\n  ${o.snippet}\n  \`\`\``,
        )
        .join('\n'),
    '',
  ];

  writeFileSync(outPath, lines.join('\n'), 'utf8');
  // eslint-disable-next-line no-console
  console.log(
    `[audit-disposables] ${orphans.length} orphan(s) across ${byCategory.size} categories. Report: ${outPath}`,
  );

  // Exit non-zero on orphan(s) so CI / `pnpm validate` can gate listener leaks.
  if (orphans.length > 0) {
    process.exit(1);
  }
}

main();
