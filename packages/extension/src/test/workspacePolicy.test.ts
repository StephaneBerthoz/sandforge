import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/*
 * pnpm-workspace.yaml is the single place that decides which third-party
 * install scripts get to run and which CVE pins rewrite our dependency tree —
 * both of them supply-chain decisions nobody re-reads once merged, and neither
 * of them covered by a build that would fail if they silently changed back.
 *
 * The comments carry the reasoning, so they are asserted too: a comment that
 * has drifted from the policy under it is worse than no comment, because it
 * is what the next reviewer trusts.
 */

// Tests run with cwd = packages/extension → the workspace manifest is two levels up.
const manifestPath = path.resolve(process.cwd(), '..', '..', 'pnpm-workspace.yaml');
const manifest = fs.readFileSync(manifestPath, 'utf8');
const lockfile = fs.readFileSync(path.resolve(manifestPath, '..', 'pnpm-lock.yaml'), 'utf8');

interface Block {
  /** The contiguous `#` comment block directly above the key, if any. */
  readonly comment: string;
  /** Trimmed body lines, up to the first blank line or dedent. */
  readonly body: readonly string[];
}

function readBlock(key: string): Block {
  const lines = manifest.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (start === -1) {
    throw new Error(`No top-level "${key}:" key in ${manifestPath}`);
  }

  const comment: string[] = [];
  for (let i = start - 1; i >= 0 && lines[i].startsWith('#'); i--) {
    comment.unshift(lines[i]);
  }

  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith(' ')) break;
    body.push(line.trim());
  }

  return { comment: comment.join('\n'), body };
}

/** Strips the optional surrounding quotes pnpm/prettier may put on a scalar. */
function unquote(scalar: string): string {
  return scalar.replace(/^['"]|['"]$/g, '');
}

function mapping(block: Block): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of block.body) {
    const match = /^(.+?):\s*(.+)$/.exec(line);
    if (match) entries.set(unquote(match[1]), unquote(match[2]));
  }
  return entries;
}

describe('pnpm build-script approvals', () => {
  const allowBuilds = readBlock('allowBuilds');
  const approvals = mapping(allowBuilds);

  it('keeps approving only the scripts `pnpm package` actually needs', () => {
    expect(approvals.get('esbuild')).toBe('true');
    expect(approvals.get('@vscode/vsce-sign')).toBe('true');
    expect(approvals.get('core-js')).toBe('false');
    expect(approvals.get('core-js-pure')).toBe('false');
  });

  it('approves no native build for the keychain of `vsce login`', () => {
    // vsce 3 pulled in keytar for that flow alone, and its node-gyp build was
    // blocked here. vsce 4 goes through @napi-rs/keyring, prebuilt: nothing to
    // approve, and the keytar entry went with it. Back in the tree, keytar
    // would need its block again, for a code path releases never take.
    const approved = [...approvals].filter(([, allowed]) => allowed === 'true');
    expect(approved.map(([name]) => name).sort()).toEqual(['@vscode/vsce-sign', 'esbuild']);
    expect(lockfile).not.toMatch(/^\s+'?keytar@/m);
  });

  it('writes approvals only in allowBuilds, the one list pnpm 11 reads', () => {
    // pnpm 11 dropped onlyBuiltDependencies and its siblings and ignores them
    // without a word. The file kept the old list beside the new one, so a
    // change made there would look applied and do nothing.
    const removed = [
      'onlyBuiltDependencies',
      'onlyBuiltDependenciesFile',
      'neverBuiltDependencies',
      'ignoredBuiltDependencies',
      'ignoreDepScripts',
    ];
    const present = removed.filter((key) =>
      manifest.split(/\r?\n/).some((line) => line.startsWith(`${key}:`)),
    );
    expect(present).toEqual([]);
  });

  it("does not justify keytar as this extension's secrets backend", () => {
    // Secrets go through VSCode SecretStorage (adapters/storage/StorageAdapter.ts);
    // keytar appears nowhere in src, so that justification would invite a re-approval.
    expect(allowBuilds.comment).not.toMatch(/secrets backend/i);
    expect(allowBuilds.comment).toMatch(/VSCE_PAT/);
  });
});

describe('pnpm security overrides', () => {
  const overrides = readBlock('overrides');
  const pins = mapping(overrides);

  it('pins lodash once, globally', () => {
    // lodash comes only through vsce's secret linter since Recharts 3: one
    // global pin covers that path, and whatever path brings it next.
    const lodashKeys = [...pins.keys()].filter((key) => key.includes('lodash'));
    expect(lodashKeys).toEqual(['lodash@<4.18.0']);
    expect(pins.get('lodash@<4.18.0')).toBe('>=4.18.0');
  });

  it('records that lodash no longer ships', () => {
    // The block once claimed every override was devDep-only while Recharts 2
    // put lodash in webview-dist; Recharts 3 does not, and a comment still
    // saying it ships would send a reviewer after chart code that is gone.
    expect(overrides.comment).not.toMatch(/All devDep-only/);
    expect(overrides.comment).toMatch(/flatted and lodash are devDep-only/);
    expect(overrides.comment).toMatch(/Recharts 3 does not/);
  });

  it('leaves vsce the minimatch it calls by name', () => {
    // vsce 3 took minimatch 3 as a default import, and a pin held it there.
    // vsce 4 calls `minimatch_1.minimatch`, which 3.x does not export: the
    // same pin would fail `vsce package` on its first ignore pattern.
    expect(pins.has('@vscode/vsce>minimatch')).toBe(false);
    expect(overrides.comment).toMatch(/vsce 4 calls/);
  });
});
