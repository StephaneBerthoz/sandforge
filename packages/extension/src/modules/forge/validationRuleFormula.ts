/**
 * Whether a validation rule can refuse a record as it is inserted, read from
 * its error condition formula: the rule refuses a record when the formula
 * holds, and some formulas cannot hold on an insert.
 *
 * As Salesforce documents them, on a record being created `ISCHANGED` is
 * false, `ISNEW` is true, and `PRIORVALUE` gives the field's current value. A
 * formula that requires a change — `AND(ISCHANGED(Status__c), …)`, a
 * `NOT(ISNEW())` guard, `PRIORVALUE(Amount__c) <> Amount__c`,
 * `AND(ISPICKVAL(PRIORVALUE(Status__c), "Approved"), NOT(ISPICKVAL(Status__c,
 * "Approved")))` — is false on every insert, and its rule refuses an update
 * only. Run on a large client sandbox, a Frozen preview listed fourteen rules
 * of one object as what might refuse its inserts, most of them of that kind.
 *
 * The reading is conservative: a formula it cannot parse, or one whose value
 * on an insert depends on the record, holds as far as it knows, and its rule
 * is kept.
 */

/** A part of a formula as the reading takes it. */
type FormulaNode =
  | { kind: 'call'; name: string; args: FormulaNode[] }
  | { kind: 'binary'; op: string; left: FormulaNode; right: FormulaNode }
  | { kind: 'not'; arg: FormulaNode }
  | { kind: 'negative'; arg: FormulaNode }
  | { kind: 'literal'; value: string }
  | { kind: 'reference'; name: string };

/** What a formula, or a part of it, is on an insert: always true, always false, or either. */
type OnInsert = 'true' | 'false' | 'unknown';

/** A formula the reading cannot take apart. */
class UnreadableFormula extends Error {}

/** The tokens of a formula: literals, names, operators and punctuation. */
function tokensOf(formula: string): string[] {
  const tokens: string[] = [];
  let at = 0;
  while (at < formula.length) {
    const rest = formula.slice(at);
    const space = /^\s+/.exec(rest);
    if (space) {
      at += space[0].length;
      continue;
    }
    if (rest.startsWith('/*')) {
      const end = formula.indexOf('*/', at + 2);
      if (end < 0) throw new UnreadableFormula('an unclosed comment');
      at = end + 2;
      continue;
    }
    const quote = rest[0];
    if (quote === "'" || quote === '"') {
      let end = 1;
      while (end < rest.length && rest[end] !== quote) end += rest[end] === '\\' ? 2 : 1;
      if (end >= rest.length) throw new UnreadableFormula('an unclosed text');
      tokens.push(rest.slice(0, end + 1));
      at += end + 1;
      continue;
    }
    const word = /^(?:\d+(?:\.\d+)?|[A-Za-z_$][A-Za-z0-9_$.]*)/.exec(rest);
    if (word) {
      tokens.push(word[0]);
      at += word[0].length;
      continue;
    }
    const operator = /^(?:&&|\|\||==|!=|<>|<=|>=|[=<>+\-*/^&!(),])/.exec(rest);
    if (!operator) throw new UnreadableFormula(`an unexpected character: ${rest[0]}`);
    tokens.push(operator[0]);
    at += operator[0].length;
  }
  return tokens;
}

/** The binary operators by precedence, the loosest first, as Salesforce orders them. */
const PRECEDENCE: ReadonlyArray<ReadonlySet<string>> = [
  new Set(['||']),
  new Set(['&&']),
  new Set(['=', '==', '<>', '!=', '<', '>', '<=', '>=']),
  new Set(['+', '-', '&']),
  new Set(['*', '/']),
  new Set(['^']),
];

/** A formula taken apart, or {@link UnreadableFormula} when it cannot be. */
function parse(formula: string): FormulaNode {
  const tokens = tokensOf(formula);
  let at = 0;
  const peek = (): string | undefined => tokens[at];
  const expect = (token: string): void => {
    if (tokens[at] !== token) throw new UnreadableFormula(`${token} expected`);
    at++;
  };
  const binary = (level: number): FormulaNode => {
    if (level >= PRECEDENCE.length) return unary();
    let left = binary(level + 1);
    for (let op = peek(); op !== undefined && PRECEDENCE[level].has(op); op = peek()) {
      at++;
      left = { kind: 'binary', op, left, right: binary(level + 1) };
    }
    return left;
  };
  const unary = (): FormulaNode => {
    if (peek() === '!') {
      at++;
      return { kind: 'not', arg: unary() };
    }
    if (peek() === '-' || peek() === '+') {
      const sign = tokens[at++];
      const arg = unary();
      return sign === '-' ? { kind: 'negative', arg } : arg;
    }
    return primary();
  };
  const primary = (): FormulaNode => {
    const token = tokens[at++];
    if (token === undefined) throw new UnreadableFormula('the formula ends early');
    if (token === '(') {
      const inner = binary(0);
      expect(')');
      return inner;
    }
    if (token.startsWith("'") || token.startsWith('"')) {
      return { kind: 'literal', value: `text:${token.slice(1, -1)}` };
    }
    if (/^\d/.test(token)) return { kind: 'literal', value: `number:${Number(token)}` };
    if (!/^[A-Za-z_$]/.test(token)) throw new UnreadableFormula(`${token} out of place`);
    if (peek() === '(') {
      at++;
      const args: FormulaNode[] = [];
      if (peek() !== ')') {
        args.push(binary(0));
        while (peek() === ',') {
          at++;
          args.push(binary(0));
        }
      }
      expect(')');
      return { kind: 'call', name: token.toUpperCase(), args };
    }
    const upper = token.toUpperCase();
    if (upper === 'TRUE' || upper === 'FALSE' || upper === 'NULL') {
      return { kind: 'literal', value: upper.toLowerCase() };
    }
    // API names are the org's to spell: one field whatever its case.
    return { kind: 'reference', name: token.toLowerCase() };
  };
  const node = binary(0);
  if (at !== tokens.length) throw new UnreadableFormula(`${tokens[at]} out of place`);
  return node;
}

/** The formula as it reads on an insert: `PRIORVALUE(field)` gives the field itself. */
function onInsert(node: FormulaNode): FormulaNode {
  switch (node.kind) {
    case 'call':
      if (node.name === 'PRIORVALUE' && node.args.length === 1) return onInsert(node.args[0]);
      return { ...node, args: node.args.map(onInsert) };
    case 'binary':
      return { ...node, left: onInsert(node.left), right: onInsert(node.right) };
    case 'not':
    case 'negative':
      return { ...node, arg: onInsert(node.arg) };
    default:
      return node;
  }
}

/** A part of a formula written one way, so that two parts that say the same compare equal. */
function canonical(node: FormulaNode): string {
  switch (node.kind) {
    case 'call':
      return `${node.name}(${node.args.map(canonical).join(',')})`;
    case 'binary': {
      const op = node.op === '==' ? '=' : node.op === '!=' ? '<>' : node.op;
      const sides = [canonical(node.left), canonical(node.right)];
      // Either way round, an equality says the same.
      if (op === '=' || op === '<>') sides.sort();
      return `(${sides[0]} ${op} ${sides[1]})`;
    }
    case 'not':
      return `NOT(${canonical(node.arg)})`;
    case 'negative':
      return `-(${canonical(node.arg)})`;
    case 'literal':
      return node.value;
    case 'reference':
      return node.name;
  }
}

const negated = (value: OnInsert): OnInsert =>
  value === 'true' ? 'false' : value === 'false' ? 'true' : 'unknown';

/** The parts a conjunction requires together: `AND(a, b)`, `a && b`, nested. */
function conjunctsOf(node: FormulaNode): FormulaNode[] {
  if (node.kind === 'call' && node.name === 'AND') return node.args.flatMap(conjunctsOf);
  if (node.kind === 'binary' && node.op === '&&') {
    return [...conjunctsOf(node.left), ...conjunctsOf(node.right)];
  }
  return [node];
}

/** The parts a disjunction takes either of: `OR(a, b)`, `a || b`, nested. */
function disjunctsOf(node: FormulaNode): FormulaNode[] {
  if (node.kind === 'call' && node.name === 'OR') return node.args.flatMap(disjunctsOf);
  if (node.kind === 'binary' && node.op === '||') {
    return [...disjunctsOf(node.left), ...disjunctsOf(node.right)];
  }
  return [node];
}

/**
 * A condition and whether a part asserts or denies it: `NOT(x)` denies `x`,
 * `a <> b` denies `a = b`. Two parts of a conjunction that assert and deny one
 * condition cannot hold together, whatever the record holds.
 */
function polarityOf(node: FormulaNode): { condition: string; holds: boolean } {
  if (node.kind === 'not') {
    const inner = polarityOf(node.arg);
    return { condition: inner.condition, holds: !inner.holds };
  }
  if (node.kind === 'call' && node.name === 'NOT' && node.args.length === 1) {
    const inner = polarityOf(node.args[0]);
    return { condition: inner.condition, holds: !inner.holds };
  }
  if (node.kind === 'binary' && (node.op === '<>' || node.op === '!=')) {
    return { condition: canonical({ ...node, op: '=' }), holds: false };
  }
  return { condition: canonical(node), holds: true };
}

/** A boolean literal's value, when the part is one. */
function literalValue(node: FormulaNode): OnInsert | undefined {
  if (node.kind !== 'literal') return undefined;
  if (node.value === 'true') return 'true';
  if (node.value === 'false') return 'false';
  return undefined;
}

/** What a part of a formula is on an insert, the formula as {@link onInsert} reads it. */
function valueOnInsert(node: FormulaNode): OnInsert {
  const literal = literalValue(node);
  if (literal) return literal;
  if (node.kind === 'not') return negated(valueOnInsert(node.arg));
  if (node.kind === 'call') {
    switch (node.name) {
      case 'ISCHANGED':
        return 'false';
      case 'ISNEW':
        return 'true';
      case 'NOT':
        return node.args.length === 1 ? negated(valueOnInsert(node.args[0])) : 'unknown';
      case 'AND':
        return conjunction(conjunctsOf(node));
      case 'OR':
        return disjunction(disjunctsOf(node));
      case 'IF': {
        if (node.args.length !== 3) return 'unknown';
        const [condition, then, otherwise] = node.args;
        const test = valueOnInsert(condition);
        if (test === 'true') return valueOnInsert(then);
        if (test === 'false') return valueOnInsert(otherwise);
        const a = valueOnInsert(then);
        return a === valueOnInsert(otherwise) ? a : 'unknown';
      }
      default:
        return 'unknown';
    }
  }
  if (node.kind === 'binary') {
    if (node.op === '&&') return conjunction(conjunctsOf(node));
    if (node.op === '||') return disjunction(disjunctsOf(node));
    return comparison(node);
  }
  return 'unknown';
}

/** A conjunction: false when one part is, or when two parts contradict each other. */
function conjunction(parts: readonly FormulaNode[]): OnInsert {
  const values = parts.map(valueOnInsert);
  if (values.includes('false')) return 'false';
  const asserted = new Map<string, boolean>();
  for (const part of parts) {
    const { condition, holds } = polarityOf(part);
    const before = asserted.get(condition);
    if (before !== undefined && before !== holds) return 'false';
    asserted.set(condition, holds);
  }
  return values.every((value) => value === 'true') ? 'true' : 'unknown';
}

/** A disjunction: false when every part is. */
function disjunction(parts: readonly FormulaNode[]): OnInsert {
  const values = parts.map(valueOnInsert);
  if (values.includes('true')) return 'true';
  return values.every((value) => value === 'false') ? 'false' : 'unknown';
}

/**
 * A comparison: a value compared with itself — what `PRIORVALUE(x) <> x` reads
 * as on an insert — is never different from it, nor greater or smaller; and a
 * condition known on an insert compared with a boolean is known too
 * (`ISNEW() = FALSE`).
 */
function comparison(node: Extract<FormulaNode, { kind: 'binary' }>): OnInsert {
  const equality = node.op === '=' || node.op === '==';
  const difference = node.op === '<>' || node.op === '!=';
  if (canonical(node.left) === canonical(node.right)) {
    if (difference || node.op === '<' || node.op === '>') return 'false';
    return 'unknown';
  }
  if (!equality && !difference) return 'unknown';
  const left = literalValue(node.left) ?? valueOnInsert(node.left);
  const right = literalValue(node.right) ?? valueOnInsert(node.right);
  if (left === 'unknown' || right === 'unknown') return 'unknown';
  return (left === right) === equality ? 'true' : 'false';
}

/**
 * Whether a validation rule's error condition formula can only hold on a
 * change of a record, and never as one is inserted: its rule refuses an
 * update, and no insert. False for a formula that may hold on an insert, and
 * for one the reading cannot take apart.
 *
 * @param formula - The rule's `errorConditionFormula`, as its metadata gives it.
 */
export function holdsOnlyOnChange(formula: string): boolean {
  try {
    return valueOnInsert(onInsert(parse(formula))) === 'false';
  } catch (err: unknown) {
    if (err instanceof UnreadableFormula) return false;
    throw err;
  }
}
