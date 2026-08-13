import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * `examples/README.md` is the copy-paste surface `docs/forge-quickstart.md`
 * sends readers to, and both CLIs skip unknown flags in silence: a recipe that
 * names a flag the parser never reads fails exactly like a no-op, so the reader
 * blames the tool instead of the doc. Nothing else compares the two — the
 * examples ship outside the VSIX and no build step reads them.
 *
 * The flag vocabulary is taken from the arg parser rather than from HELP, since
 * HELP is prose that can outlive the code path it describes.
 */

const EXTENSION_ROOT = join(__dirname, '..', '..');
const README = readFileSync(join(EXTENSION_ROOT, 'examples', 'README.md'), 'utf8');

/** Every `--flag` token, ignoring the `—` em dashes the prose is full of. */
const FLAG_RE = /(?<![\w-])--[a-z][a-z-]*/g;

/** `get('--x')` / `has('--x')` / `collectRepeated('--x')` — the reads that do something. */
const PARSER_READ_RE = /\b(?:get|has|collectRepeated)\(\s*'(--[a-z-]+)'/g;

function parsedFlags(script: string): ReadonlySet<string> {
  const source = readFileSync(join(EXTENSION_ROOT, 'cli', script), 'utf8');
  const flags = new Set<string>(['--help']);
  for (const [, flag] of source.matchAll(PARSER_READ_RE)) flags.add(flag);
  return flags;
}

const KNOWN_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['sandforge-clone.ts', parsedFlags('sandforge-clone.ts')],
  ['sandforge-cleanup.ts', parsedFlags('sandforge-cleanup.ts')],
]);

interface Usage {
  readonly script: string;
  readonly flag: string;
  readonly line: number;
}

/**
 * Walks the fenced blocks and attributes each flag to the script invoked above
 * it, so a cleanup-only flag pasted into a clone recipe is caught too. A block
 * that names no script (wizard click-paths, expected output) has no CLI to
 * check against and is skipped.
 */
function flagUsages(): Usage[] {
  const usages: Usage[] = [];
  let inFence = false;
  let script: string | undefined;

  README.split(/\r?\n/).forEach((line, index) => {
    if (line.startsWith('```')) {
      inFence = !inFence;
      script = undefined;
      return;
    }
    if (!inFence) return;

    const invocation = /sandforge-(?:clone|cleanup)\.ts/.exec(line);
    if (invocation) script = invocation[0];
    if (!script) return;

    for (const [flag] of line.matchAll(FLAG_RE)) {
      usages.push({ script, flag, line: index + 1 });
    }
  });

  return usages;
}

describe('examples/README.md CLI recipes', () => {
  it('only uses flags the invoked CLI actually parses', () => {
    const unknown = flagUsages().filter(({ script, flag }) => !KNOWN_FLAGS.get(script)?.has(flag));

    expect(unknown.map(({ script, flag, line }) => `${flag} (${script}, line ${line})`)).toEqual(
      [],
    );
  });

  it('covers the flags every recipe leans on', () => {
    // Guards the extractor itself: a regex that silently matched nothing would
    // make the assertion above pass on any README at all.
    const used = new Set(flagUsages().map(({ flag }) => flag));
    expect([...used]).toEqual(expect.arrayContaining(['--record', '--dry-run', '--upsert']));
  });

  it('answers a DUPLICATE_VALUE re-run with the shipped upsert flag', () => {
    // The re-run scenario is the one place a reader arrives already failing,
    // so a placeholder flag there costs them the fix they came for.
    expect(README).not.toMatch(/--upsert-mode/);
    expect(README).not.toMatch(/not yet a CLI flag/);
  });

  it('points the dry-run tip at the flag, not at the dev recipe', () => {
    const tip = /^- \*\*Always dry-run first\*\*.*$/m.exec(README)?.[0];
    expect(tip).toContain('`--dry-run`');
    expect(tip).not.toContain('recipe-forge-grappe');
  });
});
