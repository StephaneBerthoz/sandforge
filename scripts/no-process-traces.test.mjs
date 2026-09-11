/**
 * Gate: no internal planning identifiers or development-process narration in
 * any tracked file.
 *
 * READ THIS BEFORE EDITING — this gate is the inverse of every other gate in
 * the repo. `ci-parity.test.mjs` deliberately strips comments before matching,
 * because a commented-out step must not count as a step; `product-claims` and
 * `marketplace-claims` parse structure and ignore prose. Here a MENTION is
 * precisely the defect. This repository is public. A comment reading
 * "<LABEL>: describeGlobal returns 1-2 MB of JSON" ships that label to every
 * reader of the GitHub tree and of the published .vsix, and points at an
 * internal tracker nobody outside can open. So this gate does the one thing
 * the others refuse to do: it sweeps raw text, comments and all, and treats
 * any occurrence as a failure.
 *
 * WHAT IS AND IS NOT A TRACE
 *
 * A trace is the label, not the knowledge. "<LABEL>: describeGlobal returns
 * 1-2 MB of JSON" carries a real reason for a real workaround. The fix is
 * never to delete the sentence — it is to delete the label and keep the
 * sentence. The failure message says so, because the first instinct when a
 * gate goes red is to delete the line.
 *
 * These are NOT traces and must keep passing:
 *   - technical standards and their numbers (language tags, encodings, hash
 *     algorithms, UTC offsets);
 *   - business identifiers used as test DATA (external ids, plates, codes);
 *   - the product's own delivered vocabulary: Autopilot execution waves,
 *     Forge stages, loader phases, Production Guard safety tiers;
 *   - Anthropic and Claude named as the shipped AI PROVIDER — settings,
 *     adapter, user docs. That is a feature, not a footprint.
 *
 * EXCEPTIONS ARE MOTIFS, NEVER FILES. There is no ignored-file list, not even
 * for this file: its own fixtures are assembled at runtime from fragments so
 * that no literal label is ever written here. A file-level exclusion would let
 * a whole file rot silently; a motif has to state what it permits and why, and
 * `allowlist entries are all live` below proves each one still earns its keep.
 *
 * KNOWN LIMIT — numbered execution waves. "wave 2" was plan narration in the
 * purged text AND is the shipped vocabulary of the Autopilot planner, whose
 * waves are 0-based integers rendered as "Wave 1" in the UI and used as
 * `wave-0` testids. Text alone cannot tell the two apart, so the narration
 * rules below do not claim to: they catch the decimal sub-numbering
 * ("wave <n>.<n>") that only ever came from a plan document, and leave integer
 * waves to review. Same reasoning keeps "milestone" unflagged: the adapters
 * use it facing the user, about features not yet built.
 *
 * Run: node --test scripts/no-process-traces.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The shape of a planning task identifier: an all-caps prefix, a hyphen, a
 * short number. Requiring the prefix to both start AND end with a letter is
 * what keeps the sweep quiet on the two things that otherwise flood it —
 * character-class fragments like `A-Z0-9` in regex sources, and single-letter
 * labels like `N-1`. It still admits every family the purge found, including
 * the ones carrying a digit in the middle (accessibility labels) and the
 * two-letter ones.
 *
 * Capped at three digits: four-digit tails are years and published decision
 * records, never task numbers.
 */
const TASK_ID = /\b[A-Z][A-Z0-9]{0,9}[A-Z]-\d{1,3}\b/g;

/**
 * Motifs that have the task-identifier SHAPE but are not traces.
 *
 * `example` is not decoration. `allowlist entries are all live` asserts three
 * things about every entry: TASK_ID really does catch the example (so the
 * entry is not dead weight), the motif clears it, and the motif still matches
 * something in the tree. That last check is what stops the allowlist becoming
 * the ignore list this gate refuses to have — an exception must be earned by a
 * real line, and when the line goes, the exception has to go with it.
 *
 * Standards whose shape TASK_ID cannot reach are absent on purpose rather than
 * listed as dead entries: accessibility and payment-card standards carry no
 * hyphen-number, four-digit standards (date/time, decision records) exceed the
 * three-digit cap, and API versions are dotted. None of them can ever trip
 * this gate, so none of them needs an exception.
 */
const ALLOWED = [
  {
    pattern: /\bBCP-47\b/g,
    example: 'BCP-47',
    why: 'IETF language-tag standard; named by the i18n matcher and the webview `<html lang>`.',
  },
  {
    pattern: /\bUTF-(?:8|16|32)\b/g,
    example: 'UTF-8',
    why: 'Character encodings; the CSV importer documents the one it accepts.',
  },
  {
    pattern: /\bSHA-(?:1|224|256|384|512)\b/g,
    example: 'SHA-256',
    why: 'Hash algorithms; the frozen-dataset salt model publishes a fingerprint.',
  },
  {
    pattern: /\bUTC[+-]\d{1,2}\b/g,
    example: 'UTC-7',
    why: 'Fixed UTC offsets; the countdown tests pin a clock to one.',
  },
  {
    pattern: /\bACC-\d{1,3}\b/g,
    example: 'ACC-001',
    why: 'Account external-id and code values in fixtures — test DATA, not a label.',
  },
  {
    pattern: /\bEXT-\d{1,3}\b/g,
    example: 'EXT-001',
    why: 'External record ids in conflict-resolution fixtures — test DATA.',
  },
  {
    pattern: /\bKEY-\d{1,3}\b/g,
    example: 'KEY-001',
    why: 'External-key column values in Forge writer fixtures — test DATA.',
  },
  {
    pattern: /\bSF-\d{1,3}\b/g,
    example: 'SF-001',
    why: 'Code values produced by field-mapping and transform fixtures — test DATA.',
  },
  {
    pattern: /\bTEAM-\d{1,3}\b/g,
    example: 'TEAM-6',
    why: 'A value typed into a filter box by an org-manager test — test DATA.',
  },
  {
    pattern: /\b[A-Z]{2}-\d{3}-[A-Z]{2}\b/g,
    example: 'AB-123-CD',
    why: 'French SIV plate shape, pseudonymised and asserted on by the anonymiser.',
  },
  {
    pattern: /\bXX-\d{2}\b/g,
    example: 'XX-99',
    why: 'A deliberately malformed plate, asserted to be rejected by the SIV control.',
  },
];

/**
 * Development-process narration: phrasings that describe how the product was
 * built rather than what it does.
 *
 * Every motif here is numbered on purpose. The bare nouns are all legitimate
 * product vocabulary — loaders run phases, the planner emits waves, orgs have
 * safety tiers — and flagging them would make the gate a nuisance that gets
 * switched off. It is the *numbering* that betrays a plan document: shipped
 * tiers are named (critical/high/medium/low), shipped phases are named
 * ('guards' | 'align' | 'insert'), and the recipe tool's phases are lettered.
 */
const NARRATION = [
  {
    pattern: /\bphase[ _-]?\d+\b/gi,
    example: ['Phase', '12'].join(' '),
    why: 'Numbered delivery phase. Shipped phases are named or lettered, never numbered.',
  },
  {
    pattern: /\bplan[ _]\d+\b|\bplan[ _-]\d{2}-\d{2}\b/gi,
    example: ['Plan', '04-04'].join(' '),
    why: 'Plan-document numbering. A plan RECORD id is hyphenated with one digit and stays legal.',
  },
  {
    pattern: /\btask[ _-]\d+\b/gi,
    example: ['task', '08'].join(' '),
    why: 'Numbered work item from a task list.',
  },
  {
    pattern: /\btier[ _-]\d+\b/gi,
    example: ['Tier', '2'].join(' '),
    why: 'Numbered delivery tier. Production Guard safety tiers are named, never numbered.',
  },
  {
    pattern: /\b(?:wave|step|batch)[ _-]\d+\.\d+\b/gi,
    example: ['wave', '2.6'].join(' '),
    why: 'Decimal sub-numbering only ever came from a plan document; execution waves are integers.',
  },
];

/** Tracked files, as git sees them — the exact set that is published. */
const trackedFiles = execFileSync('git', ['ls-files', '-z'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
  .split('\0')
  .filter(Boolean);

/**
 * Every tracked file's text, screenshots and other binaries excluded.
 *
 * Binaries are skipped by looking for a NUL byte rather than by extension: an
 * extension list is a file-exclusion list in disguise, and would start
 * swallowing prose the day someone adds a `.txt` to it.
 */
const textFiles = trackedFiles.flatMap((file) => {
  let buffer;
  try {
    buffer = readFileSync(join(root, file));
  } catch {
    return []; // deleted in the working tree; nothing to scan
  }
  if (buffer.includes(0)) return [];
  return [{ file, text: buffer.toString('utf8') }];
});

/** All [start, end) spans an allowlist motif covers in one line. */
const allowedSpans = (line) => {
  const spans = [];
  for (const { pattern } of ALLOWED) {
    pattern.lastIndex = 0;
    for (const m of line.matchAll(pattern)) spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
};

/**
 * Every trace in a blob of text, as {line, column, match, rule}.
 *
 * Exported shape rather than an inline loop so the fixtures below can prove
 * the detector fires and stays quiet without touching the working tree.
 */
export const findTraces = (text) => {
  const found = [];
  text.split('\n').forEach((line, i) => {
    const cleared = allowedSpans(line);
    TASK_ID.lastIndex = 0;
    for (const m of line.matchAll(TASK_ID)) {
      const [start, end] = [m.index, m.index + m[0].length];
      const covered = cleared.some(([from, to]) => from <= start && end <= to);
      if (!covered)
        found.push({ line: i + 1, match: m[0], rule: 'planning identifier', text: line });
    }
    for (const { pattern, why } of NARRATION) {
      pattern.lastIndex = 0;
      for (const m of line.matchAll(pattern)) {
        found.push({ line: i + 1, match: m[0], rule: why, text: line });
      }
    }
  });
  return found;
};

const HOW_TO_FIX = [
  '',
  'A trace is the LABEL, not the knowledge it introduces.',
  '  Keep the reason, remove the label:',
  '    before:  // <LABEL>: describeGlobal returns 1-2 MB of JSON, so it is cached',
  '    after:   // describeGlobal returns 1-2 MB of JSON, so it is cached',
  '  A test name carrying a label becomes a description of the behaviour:',
  "    before:  it('handles <LABEL> correctly')",
  "    after:   it('retries the callout once after a 401')",
  '',
  'Never delete the explanation. If a line is only a label and nothing else,',
  'the reason it stood for still belongs somewhere — write it out.',
  '',
  'If the match is a genuine standard, a business identifier used as test data,',
  'or delivered product vocabulary, add a MOTIF with its reason to ALLOWED or',
  'narrow the NARRATION rule in scripts/no-process-traces.test.mjs.',
  'Do not add a file to an ignore list; there is none, on purpose.',
].join('\n');

test('no planning identifiers or process narration in tracked files', () => {
  const hits = [];
  for (const { file, text } of textFiles) {
    for (const trace of findTraces(text)) {
      hits.push(`  ${file}:${trace.line}  ${trace.match}\n      ${trace.text.trim()}`);
    }
  }
  assert.equal(
    hits.length,
    0,
    `${hits.length} internal trace(s) found in tracked files:\n${hits.join('\n')}\n${HOW_TO_FIX}`,
  );
});

/*
 * ---- Proof the sweep is not vacuous -------------------------------------
 *
 * Fixtures are assembled from fragments (`['PERF', '99'].join('-')`) instead
 * of written out, so that this file stays clean under its own sweep and needs
 * no self-exclusion. A literal label typed here would be caught like any other.
 */
const ID = (prefix, n) => [prefix, n].join('-');

test('detects a planning identifier in a source comment', () => {
  const found = findTraces(`// ${ID('PERF', '99')}: the query is slow`);
  assert.equal(found.length, 1);
  assert.equal(found[0].match, ID('PERF', '99'));
});

test('detects a numbered phase in a documentation page', () => {
  const found = findTraces(`Shipped in ${['Phase', '12'].join(' ')} of the rollout.`);
  assert.equal(found.length, 1);
});

test('detects a planning identifier inside a test name', () => {
  const found = findTraces(`it('handles ${ID('WIRE', '04')} correctly', () => {});`);
  assert.equal(found.length, 1);
  assert.equal(found[0].match, ID('WIRE', '04'));
});

test('detects the families the purge had to remove', () => {
  for (const [prefix, n] of [
    ['MKT', '04'],
    ['VSIX', '01'],
    ['DEADCODE', '03'],
    ['TESTS', '08'],
    ['GOV', '07'],
    ['QSYNC', '02'],
    ['HARD', '06'],
    ['QSEED', '02'],
    ['ALERT', '11'],
    ['A11Y', '02'],
    ['UX', '15'],
    ['SP', '01'],
    ['WV', '12'],
  ]) {
    const label = ID(prefix, n);
    assert.equal(findTraces(`/* ${label}: something */`).length, 1, `missed ${label}`);
  }
});

test('leaves standards, provider names and delivered vocabulary alone', () => {
  const clean = [
    'Optional BCP-47 locale string; defaults to the runtime locale.',
    'Supported format: UTF-8 CSV with headers.',
    'only the salt SHA-256 fingerprint (12 hex chars)',
    'Pin the clock just before midnight Pacific (PDT = UTC-7 on this date):',
    "Plate__c: 'AB-123-CD',",
    "Plate__c: 'XX-99', // invalid SIV shape",
    "expect(plan.objects[0].sampleRecords[0]).toEqual({ Code: 'ACC-100' });",
    "recordId: 'EXT-001',",
    "{ Id: ROOT_ID, ExternalKey__c: 'KEY-001' }",
    "id: 'plan-1',",
    'Choose Anthropic as the provider and paste your Claude API key.',
    '"description": "Anthropic API key used by the AI assistant."',
    '// Wave 1: Contact, depends on wave 0',
    'Wave execution order (0-based).',
    'const testid = `wave-${index}`;',
    "phase: 'guards' | 'align' | 'insert' | 'pass2'",
    'Phase B — scoped dry-run starting…',
    'org tier (sandbox or production), safety tier critical/high/medium/low',
    'Custom provider ships in a future SandForge milestone.',
    'WCAG 2.1 AA contrast on the skipped badge; PCI-DSS scope; API v60.0',
    'const RE = /^[A-Z0-9]{3}-[a-z]+$/;',
    'N-1 revisions are kept; see ADR-0003 for the salt model.',
  ];
  for (const line of clean) {
    assert.deepEqual(findTraces(line), [], `false positive on: ${line}`);
  }
});

test('allowlist entries are all live', () => {
  for (const { pattern, example, why } of ALLOWED) {
    assert.ok(why && why.length > 20, `allowlist entry ${example} needs a real reason`);
    TASK_ID.lastIndex = 0;
    assert.ok(
      TASK_ID.test(example),
      `allowlist entry ${example} is unreachable — TASK_ID never matches it, so the entry is dead`,
    );
    pattern.lastIndex = 0;
    assert.ok(
      pattern.test(example),
      `allowlist entry ${example} no longer matches its own example`,
    );
    assert.deepEqual(
      findTraces(example),
      [],
      `allowlist entry ${example} does not clear its example`,
    );
    const used = textFiles.some(({ text }) => {
      pattern.lastIndex = 0;
      return pattern.test(text);
    });
    assert.ok(
      used,
      `allowlist entry ${example} matches nothing in the tree any more. ` +
        'Delete it: an unused exception is a blind spot nobody is watching.',
    );
  }
});

test('narration rules all fire on their own example', () => {
  for (const { example, why } of NARRATION) {
    assert.ok(why && why.length > 20, `narration rule ${example} needs a real reason`);
    assert.equal(findTraces(example).length, 1, `narration rule ${example} no longer fires`);
  }
});

test('the failure message tells the reader to keep the reason', () => {
  assert.match(HOW_TO_FIX, /Keep the reason, remove the label/);
  assert.match(HOW_TO_FIX, /Never delete the explanation/);
});
