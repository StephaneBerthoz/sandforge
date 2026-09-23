/**
 * A key that reaches `t()` has to exist, however it got there.
 *
 * The parity gate already refuses a `t('a.b')` whose key no locale defines,
 * but it reads the literal out of the call — so it only ever saw a key written
 * inline. `AutopilotGraph/GraphLegend.tsx` kept its ten labels in a table:
 *
 *     const NODE_STATUSES = [{ labelKey: 'autopilot.graph.legend.pending', … }]
 *     …
 *     <span>{t(item.labelKey)}</span>
 *
 * The literal never appears as an argument to `t`, so nothing checked it, and
 * the catalogue has those entries one level up (`autopilot.graph.pending`).
 * All ten rendered as their own key — "autopilot.graph.legend.pending" — on the
 * Autopilot page of every release until 1.23.1, in all six languages.
 *
 * Two rules, and neither needs to know how the key travels:
 *
 *  - RULE 1, literals. Any string literal in the webview whose first dotted
 *    segment is a top-level section of `en.json` is a catalogue key, and has to
 *    resolve to a string. Over the current tree that shape matches ~1530
 *    literals that resolve and, with the two exclusions below, none that do
 *    not. A literal that resolves to an *object* passes only if the code builds
 *    keys under it (RULE 2), since that is a family prefix rather than a key.
 *
 *  - RULE 2, families. Every `` t(`a.b.${x}`) `` head has to name a family the
 *    catalogue actually fills, in every language — at least one member, and
 *    never a bare string. `sync.history.status_${status}` resolved to the
 *    *string* `sync.history.status` ("Status"), and `sync.schedules.result_…`
 *    to nothing at all: a finished run showed "sync.history.status_failure" in
 *    its own history table. Flat families (`org.status_`, `…triggered`) are
 *    read as sibling keys sharing the stem, which is how they are written.
 *
 * What neither rule can do is notice a family that is missing ONE member —
 * `autopilot.graph` had seven of `AutopilotNodeStatus`'s eight, so a queued
 * node showed `autopilot.graph.queued`. RULE 3 pins the families whose members
 * come from a union in the TypeScript source, and reads that union rather than
 * trusting a list copied here.
 *
 * Run: node --test scripts/i18n-key-literals.test.mjs
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES_DIR = join('packages', 'webview', 'src', 'i18n', 'locales');
const WEBVIEW_SRC = join('packages', 'webview', 'src');

/**
 * Files holding dotted literals that only look like catalogue keys.
 * Each one is named, with what its literals really are, so the exclusion
 * cannot quietly grow to cover a file that does hold keys.
 */
const NOT_CATALOGUE_KEYS = new Map([
  [
    'styles/testing/vscodeThemes.ts',
    "VS Code theme colour ids — `list.hoverBackground`, `notifications.border`. They collide with the catalogue's `list` and `notifications` sections by coincidence.",
  ],
]);

/**
 * RULE 4 — the builder whose literal half is the TAIL.
 *
 * `formatRelativeTimeI18n(ts, t, keyPrefix)` does `` t(`${keyPrefix}.justNow`) ``,
 * so neither half of the key is written out anywhere: the call site passes the
 * namespace and the function appends the tail. Both prefixes it is called with
 * are listed here with the tails it appends, and every pair has to resolve —
 * a namespace that gained a caller but no strings shows "home.hoursAgo" on the
 * Home page. `tails` is read off the function so the list cannot drift from it.
 */
const TAIL_FIRST = {
  builder: 'packages/webview/src/utils/formatters.ts',
  fn: 'formatRelativeTimeI18n',
  prefixes: ['home', 'sidePanel.relativeTime'],
};

const read = (...parts) => readFileSync(join(repoRoot, ...parts), 'utf8');
const locale = (name) => JSON.parse(read(LOCALES_DIR, name));

function localeNames() {
  return readdirSync(join(repoRoot, LOCALES_DIR))
    .filter((name) => name.endsWith('.json'))
    .sort();
}

/** The value at a dotted path, or undefined. */
export function at(catalogue, path) {
  return path
    .split('.')
    .filter(Boolean)
    .reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), catalogue);
}

/** Whether `path` names a string, counting i18next's plural suffixes. */
export function resolvesToText(catalogue, path) {
  if (typeof at(catalogue, path) === 'string') return true;
  return ['zero', 'one', 'two', 'few', 'many', 'other'].some(
    (category) => typeof at(catalogue, `${path}_${category}`) === 'string',
  );
}

/**
 * The members a family prefix has in `catalogue`.
 *
 * `sync.operations.` is a nested object, and its members are its keys.
 * `org.status_` and `sync.history.triggered` are flat: the head's last segment
 * is the stem of sibling keys (`status_connected`, `triggeredManual`), and the
 * stem itself, where it exists as a key of its own, is not a member.
 */
export function familyMembers(catalogue, head) {
  const trimmed = head.replace(/\.$/, '');
  const node = at(catalogue, trimmed);
  if (node && typeof node === 'object') return Object.keys(node).sort();
  const segments = trimmed.split('.');
  const stem = segments.pop();
  const parent = at(catalogue, segments.join('.'));
  if (parent && typeof parent === 'object') {
    return Object.keys(parent)
      .filter((key) => key !== stem && key.startsWith(stem))
      .sort();
  }
  return [];
}

function sources(dir = WEBVIEW_SRC, acc = []) {
  for (const name of readdirSync(join(repoRoot, dir))) {
    const path = join(dir, name);
    if (statSync(join(repoRoot, path)).isDirectory()) sources(path, acc);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) acc.push(path);
  }
  return acc;
}

const label = (file) => relative(WEBVIEW_SRC, file).replace(/\\/g, '/');

/** Every string literal shaped like a dotted catalogue key. */
const DOTTED_LITERAL = /(['"])([a-z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+)\1/g;

/** The literal head of every `` t(`head${…}`) ``, i.e. every family prefix the code builds. */
const FAMILY_HEAD = /\bt\(\s*`([^`$]*)\$\{/g;

export function familyHeads(source) {
  return [...source.matchAll(FAMILY_HEAD)].map((match) => match[1]).filter(Boolean);
}

const allSources = () => sources().map((file) => ({ file, source: read(file) }));

test('the units of the two rules behave', () => {
  const catalogue = {
    sync: { history: { status: 'Status', status_failure: 'Failed' } },
    a: { b: 'x' },
  };
  assert.equal(resolvesToText(catalogue, 'a.b'), true);
  assert.equal(resolvesToText(catalogue, 'a'), false, 'an object is not text');
  assert.deepEqual(familyMembers(catalogue, 'sync.history.status_'), ['status_failure']);
  assert.deepEqual(familyMembers(catalogue, 'sync.'), ['history']);
  assert.deepEqual(familyMembers(catalogue, 'nope.'), []);
  assert.deepEqual(familyHeads('t(`sync.operations.${op}`) t(`x`) t(`${p}.justNow`)'), [
    'sync.operations.',
  ]);
});

test('every literal shaped like a catalogue key resolves to text', () => {
  const en = locale('en.json');
  const namespaces = new Set(Object.keys(en));
  const files = allSources();
  const heads = new Set(
    files.flatMap(({ source }) => familyHeads(source)).map((h) => h.replace(/\.$/, '')),
  );

  let checked = 0;
  const offenders = [];
  for (const { file, source } of files) {
    if (NOT_CATALOGUE_KEYS.has(label(file))) continue;
    for (const match of source.matchAll(DOTTED_LITERAL)) {
      const key = match[2];
      if (!namespaces.has(key.split('.')[0])) continue;
      checked++;
      if (resolvesToText(en, key)) continue;
      // A prefix the code builds keys under is a family, not a key.
      if (heads.has(key) && typeof at(en, key) === 'object') continue;
      if (TAIL_FIRST.prefixes.includes(key) && typeof at(en, key) === 'object') continue;
      offenders.push(`${label(file)}: ${JSON.stringify(key)} → ${typeof at(en, key)}`);
    }
  }
  // The shape is common enough that a broken matcher would be invisible.
  assert.ok(checked > 1000, `only ${checked} key-shaped literals seen — has the matcher broken?`);
  assert.deepEqual(offenders, []);
});

test('every key family the code builds is filled, in every language', () => {
  const heads = [...new Set(allSources().flatMap(({ source }) => familyHeads(source)))].sort();
  assert.ok(heads.length > 15, `only ${heads.length} key families found — has the matcher broken?`);

  const offenders = [];
  for (const name of localeNames()) {
    const catalogue = locale(name);
    for (const head of heads) {
      const members = familyMembers(catalogue, head);
      if (members.length === 0) {
        const trimmed = head.replace(/\.$/, '');
        offenders.push(
          `${name}: t(\`${head}\${…}\`) has no member — "${trimmed}" is ${typeof at(catalogue, trimmed)}`,
        );
      }
    }
  }
  assert.deepEqual(offenders, []);
});

/**
 * RULE 3 — the families whose members are a union in the source.
 *
 * `union` names an exported `type X = 'a' | 'b'`; `field` names a property of
 * an interface, for the unions written inline. `guarded` lists members the
 * component never renders, each with the line that stops it — without that the
 * only honest options are an entry nobody reads or no check at all.
 */
const UNION_BACKED = [
  {
    prefix: 'autopilot.graph.',
    from: { file: 'packages/shared/src/types/autopilot.types.ts', union: 'AutopilotNodeStatus' },
  },
  {
    prefix: 'sync.history.status_',
    from: {
      file: 'packages/shared/src/types/sync.types.ts',
      field: 'status',
      in: 'SyncExecutionResult',
    },
  },
  {
    prefix: 'sync.schedules.result_',
    from: {
      file: 'packages/shared/src/types/sync.types.ts',
      field: 'lastResult',
      in: 'SyncScheduleEntry',
    },
  },
  {
    prefix: 'sync.history.triggered',
    from: {
      file: 'packages/shared/src/types/sync.types.ts',
      field: 'triggeredBy',
      in: 'SyncHistoryEntry',
    },
    // The code capitalises the value: `triggered${v[0].toUpperCase()}${v.slice(1)}`.
    member: (value) => `triggered${value[0].toUpperCase()}${value.slice(1)}`,
  },
  {
    prefix: 'automation.triggerIdle.',
    from: {
      file: 'packages/shared/src/types/automation.types.ts',
      union: 'PipelineTriggerIdleReason',
    },
  },
  {
    prefix: 'automation.triggerLast.',
    from: {
      file: 'packages/shared/src/types/automation.types.ts',
      field: 'lastOutcome',
      in: 'PipelineTriggerStatus',
    },
  },
  {
    prefix: 'home.smartAction.action.',
    from: { file: 'packages/shared/src/types/smart-action.types.ts', union: 'SmartActionType' },
    guarded: {
      none: "SmartActionCard returns null when the action is 'none', before it reads the key",
    },
  },
];

/** The string literals of a named union, or of one interface field. */
export function unionLiterals(source, { union, field, in: container }) {
  let text = source;
  if (container) {
    const start = new RegExp(`(?:interface|type)\\s+${container}\\b`).exec(source);
    assert.ok(start, `no declaration of ${container}`);
    text = source.slice(start.index);
    const open = text.indexOf('{');
    let depth = 0;
    let end = text.length;
    for (let i = open; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) {
        end = i;
        break;
      }
    }
    text = text.slice(open, end);
    const declaration = new RegExp(
      `\\b${field}\\??\\s*:\\s*([^;\\n]*(?:\\n\\s*\\|[^;\\n]*)*);`,
    ).exec(text);
    assert.ok(declaration, `no field ${field} in ${container}`);
    text = declaration[1];
  } else {
    const declaration = new RegExp(`type\\s+${union}\\s*=([\\s\\S]*?);`).exec(source);
    assert.ok(declaration, `no union ${union}`);
    text = declaration[1];
  }
  return [...text.matchAll(/'([^']+)'/g)].map((match) => match[1]).sort();
}

test('a union is read out of the source, not copied', () => {
  const source = [
    'export type Colour =',
    "  | 'red'",
    "  | 'blue';",
    'export interface Run {',
    "  status: 'success' | 'failure';",
    '  note?: string;',
    '}',
  ].join('\n');
  assert.deepEqual(unionLiterals(source, { union: 'Colour' }), ['blue', 'red']);
  assert.deepEqual(unionLiterals(source, { field: 'status', in: 'Run' }), ['failure', 'success']);
});

test('a family backed by a union has an entry for every member of it', () => {
  const offenders = [];
  for (const name of localeNames()) {
    const catalogue = locale(name);
    for (const { prefix, from, member, guarded = {} } of UNION_BACKED) {
      const values = unionLiterals(read(from.file), from);
      assert.ok(values.length > 1, `${from.union ?? from.field} yielded ${values.length} value(s)`);
      for (const value of values) {
        if (value in guarded) continue;
        const key = prefix.endsWith('.')
          ? `${prefix}${value}`
          : `${prefix.split('.').slice(0, -1).join('.')}.${(member ?? ((v) => v))(value)}`;
        const full = member && !prefix.endsWith('.') ? key : `${prefix}${value}`;
        const target = member ? key : full;
        if (!resolvesToText(catalogue, target)) {
          offenders.push(
            `${name}: ${target} — ${from.union ?? `${from.in}.${from.field}`} has "${value}"`,
          );
        }
      }
    }
  }
  assert.deepEqual(offenders, []);
});

/** The tails a builder appends: every `` t(`${x}.tail`) `` in its source. */
export function appendedTails(source) {
  return [...source.matchAll(/\bt\(\s*`\$\{[^}]*\}\.([A-Za-z0-9_]+)`/g)]
    .map((match) => match[1])
    .sort();
}

test('the tails are read off the builder', () => {
  assert.deepEqual(appendedTails('t(`${p}.justNow`); t(`${p}.hoursAgo`, {count})'), [
    'hoursAgo',
    'justNow',
  ]);
  assert.deepEqual(appendedTails('t(`sync.x.${v}`)'), [], 'a prefix-first call appends no tail');
});

test('every prefix a tail-first builder is called with has each of its tails', () => {
  const tails = appendedTails(read(TAIL_FIRST.builder));
  assert.ok(tails.length >= 2, `only ${tails.length} tail(s) found in ${TAIL_FIRST.builder}`);

  const { fn } = TAIL_FIRST;
  const files = allSources();
  const callers = files
    .filter(({ source }) => source.includes(`${fn}(`))
    .map(({ file }) => label(file));

  const offenders = [];
  for (const prefix of TAIL_FIRST.prefixes) {
    // A declared prefix has to be one a call really passes, or it exempts nothing.
    const quoted = [`'${prefix}'`, `"${prefix}"`];
    const passed = files.some(({ source }) =>
      source
        .split(`${fn}(`)
        .slice(1)
        .some((call) => quoted.some((literal) => call.slice(0, 400).includes(literal))),
    );
    if (!passed) {
      offenders.push(`no ${fn}() call passes "${prefix}" — callers: ${callers.join(', ')}`);
    }
    for (const name of localeNames()) {
      const catalogue = locale(name);
      for (const tail of tails) {
        if (!resolvesToText(catalogue, `${prefix}.${tail}`)) {
          offenders.push(`${name}: ${prefix}.${tail} — ${fn} appends "${tail}"`);
        }
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('every excluded file still exists, so no exclusion outlives its file', () => {
  const present = new Set(sources().map(label));
  for (const [file, why] of NOT_CATALOGUE_KEYS) {
    assert.ok(present.has(file), `${file} is gone — drop its exclusion (${why})`);
  }
});
