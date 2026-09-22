import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A shell script the repository runs has to be executable in the INDEX, not
 * just in whichever working tree it was written in.
 *
 * `core.hooksPath` points at `scripts/git-hooks`, and a hook without the bit
 * is skipped — with a hint on stdout that is easy to read past. This repo
 * shipped exactly that: the pre-commit hook was recorded as `100644`, so every
 * clone of it got a hook that never ran, and the typecheck it guards stopped
 * happening without anything failing. `pre-publish-check.sh` had to be invoked
 * as `bash scripts/...` for the same reason.
 *
 * Git stores the bit in the mode of the index entry, which is what a clone is
 * built from, so that is what this reads — a `chmod +x` in a working tree that
 * was never `git update-index --chmod=+x` leaves the next clone broken exactly
 * as before.
 */

/** The index mode of every tracked file under `scripts/`, keyed by path. */
function trackedModes() {
  const out = execFileSync('git', ['ls-files', '-s', 'scripts/'], {
    encoding: 'utf8',
    cwd: join(import.meta.dirname, '..'),
  });
  const modes = new Map();
  for (const line of out.split('\n')) {
    const match = /^(\d{6})\s+[0-9a-f]+\s+\d+\t(.+)$/.exec(line);
    if (match) modes.set(match[2], match[1]);
  }
  return modes;
}

test('every shell script under scripts/ is executable in the index', () => {
  const modes = trackedModes();
  const shellScripts = [...modes.keys()].filter((path) => path.endsWith('.sh'));

  assert.ok(shellScripts.length > 0, 'no shell scripts found — has the layout changed?');

  const notExecutable = shellScripts.filter((path) => modes.get(path) !== '100755');
  assert.deepEqual(
    notExecutable,
    [],
    `recorded as non-executable, so a fresh clone cannot run them: ${notExecutable.join(', ')}. ` +
      'Fix with `git update-index --chmod=+x <path>`.',
  );
});

test('every git hook is executable in the index', () => {
  const modes = trackedModes();
  const hooks = [...modes.keys()].filter((path) => path.startsWith('scripts/git-hooks/'));

  assert.ok(hooks.length > 0, 'no hooks found — has core.hooksPath moved?');

  const notExecutable = hooks.filter((path) => modes.get(path) !== '100755');
  assert.deepEqual(
    notExecutable,
    [],
    `git skips a hook without the bit, with a hint that is easy to read past: ${notExecutable.join(', ')}`,
  );
});

test('the hooks directory the repository points at is the one that holds the hooks', () => {
  // A path that has moved leaves the hooks in place and running nothing.
  const configured = execFileSync('git', ['config', '--get', 'core.hooksPath'], {
    encoding: 'utf8',
    cwd: join(import.meta.dirname, '..'),
  }).trim();

  assert.equal(
    configured,
    'scripts/git-hooks',
    'core.hooksPath no longer points at scripts/git-hooks',
  );
  const present = readdirSync(join(import.meta.dirname, 'git-hooks'));
  assert.ok(present.includes('pre-commit'), 'no pre-commit hook in scripts/git-hooks');
});
