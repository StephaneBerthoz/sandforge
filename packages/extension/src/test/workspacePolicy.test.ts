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

function sequence(block: Block): string[] {
  return block.body
    .filter((line) => line.startsWith('- '))
    .map((line) => unquote(line.slice(2).trim()));
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

  it('blocks the keytar native build in both the pnpm 11 and legacy keys', () => {
    // keytar is an optional dep of @vscode/vsce for `vsce login` only; approving
    // it runs node-gyp on every install for a code path releases never take.
    expect(approvals.get('keytar')).toBe('false');
    expect(sequence(readBlock('onlyBuiltDependencies'))).not.toContain('keytar');
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

  it('pins lodash once, globally, rather than under recharts', () => {
    // 4.18.1 is already the single resolution: narrowing to `recharts>lodash`
    // would re-resolve a dependency that ships, for no advisory gain.
    const lodashKeys = [...pins.keys()].filter((key) => key.includes('lodash'));
    expect(lodashKeys).toEqual(['lodash@<4.18.0']);
    expect(pins.get('lodash@<4.18.0')).toBe('>=4.18.0');
  });

  it('records that lodash ships, unlike the other pinned packages', () => {
    // The block used to claim every override was devDep-only. recharts pulls
    // lodash into webview-dist, so a lodash bump changes shipped chart code.
    expect(overrides.comment).not.toMatch(/All devDep-only/);
    expect(overrides.comment).toMatch(/webview-dist/);
    expect(overrides.comment).toMatch(/Monitor chart/);
  });
});
