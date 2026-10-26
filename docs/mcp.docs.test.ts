/**
 * Doc/code drift guard for `docs/mcp.md`, the guide to the MCP server, and
 * for the pages that send a reader to it.
 *
 * The guide is where a person learns what an agent may do to their orgs: the
 * tools, which of them write, which need `confirm`, and that the extension
 * itself gives the model no tool. Each of those is held here to the server's
 * own source, read as text: a tool added, made to write or to delete without
 * the guide saying so fails here first.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

function source(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8').replace(/\r\n/g, '\n');
}

const DOC = source('docs/mcp.md');
const SERVER = source('packages/extension/cli/sandforge-mcp.ts');
/** What starts and stops the scripts the server runs. */
const RUNNER = source('packages/extension/cli/scriptRunner.ts');

/** A section of the guide, from its heading to the next one of its level. */
function section(heading: string): string {
  const start = DOC.indexOf(`\n## ${heading}\n`);
  if (start === -1) throw new Error(`docs/mcp.md has no "## ${heading}": re-point this test`);
  const end = DOC.indexOf('\n## ', start + 1);
  return DOC.slice(start, end === -1 ? undefined : end);
}

/** The tools as the server declares them, in its order, with what each declares of itself. */
function declaredTools(): Array<{
  name: string;
  readOnly: boolean;
  destructive: boolean;
  confirms: boolean;
}> {
  const blocks = SERVER.split(/\n {2}tool\(\{\n/).slice(1);
  if (blocks.length < 10)
    throw new Error('the server declares its tools otherwise: re-point this test');
  return blocks.map((block) => {
    const name = /^\s+name: '([a-z_]+)',/m.exec(block)?.[1];
    const readOnly = /^\s+readOnly: (true|false),/m.exec(block)?.[1];
    if (!name || !readOnly) throw new Error('a tool block reads otherwise: re-point this test');
    return {
      name,
      readOnly: readOnly === 'true',
      destructive: /^\s+destructive: true,/m.test(block),
      confirms: /^\s+writesTo: /m.test(block),
    };
  });
}

/** The names in backticks of a stretch of prose, in order. */
const named = (text: string): string[] =>
  [...text.matchAll(/`([a-z]+_[a-z]+)`/g)].map((m) => m[1] as string);

describe('docs/mcp.md', () => {
  it('lists every tool the server declares, in its order, and no other', () => {
    const rows = section('The tools')
      .split('\n')
      .filter((line) => /^\| `[a-z_]+`/.test(line))
      .map((line) => /^\| `([a-z_]+)`/.exec(line)?.[1]);

    expect(rows).toEqual(declaredTools().map((tool) => tool.name));
  });

  it('names the tools that say readOnlyHint and those that say destructiveHint, as the server declares them', () => {
    const hints = section('The tools')
      .split('\n')
      .find((line) => line.includes('say `readOnlyHint`'));
    if (!hints) throw new Error('the guide no longer says which tools are read-only: re-point');
    const [readOnly, destructive] = hints.split('say `readOnlyHint`');

    const tools = declaredTools();
    expect(named(readOnly ?? '')).toEqual(tools.filter((t) => t.readOnly).map((t) => t.name));
    expect(named(destructive ?? '')).toEqual(
      tools.filter((t) => !t.readOnly && t.destructive).map((t) => t.name),
    );
  });

  it('names under the confirm rule every tool that writes with confirm, and no other', () => {
    const rule = section('The confirm rule');
    const first = rule.slice(0, rule.indexOf('takes `confirm`'));

    expect(new Set(named(first))).toEqual(
      new Set(
        declaredTools()
          .filter((t) => t.confirms)
          .map((t) => t.name),
      ),
    );
    expect(rule).toContain(
      'the call is refused before any script runs, so before anything is read',
    );
    // The refusal the rule describes is the server's own.
    expect(SERVER).toContain("'nothing was read or written.'");
  });

  it('gives the line that adds the server to Claude Code as the server says it, and the scripts its tools run exist', () => {
    const line =
      'claude mcp add sandforge -- pnpm exec tsx packages/extension/cli/sandforge-mcp.ts';

    expect(section('Add it to Claude Code')).toContain(line);
    expect(SERVER).toContain(` *   ${line}`);
    expect(SERVER).toContain(`    ${line}\n`);
    for (const script of new Set(section('The tools').match(/sandforge-[a-z]+/g) ?? [])) {
      expect(existsSync(resolve(REPO_ROOT, `packages/extension/cli/${script}.ts`)), script).toBe(
        true,
      );
    }
  });

  it('names the protocol revisions the server serves', () => {
    const version = /export const PROTOCOL_VERSION = '([\d-]+)';/.exec(SERVER)?.[1];
    const handshake = /export const HANDSHAKE_VERSIONS: readonly string\[\] = \[([^\]]+)\];/.exec(
      SERVER,
    )?.[1];
    if (!version || !handshake)
      throw new Error('the server names its revisions otherwise: re-point');
    const versions = [...handshake.matchAll(/'([\d-]+)'/g)].map((m) => m[1] as string);
    const protocol = section('The protocol');

    expect(protocol).toContain(`MCP [${version}]`);
    expect(protocol).toContain(
      `${versions.slice(0, -1).join(', ')} and ${versions.at(-1) ?? ''} -- open with \`initialize\``,
    );
    expect(protocol).toContain(`is offered ${versions[0] ?? ''}`);
  });

  it('says a cancelled call stops its script on Windows with the message the scripts hear as Ctrl-C', () => {
    expect(section('What holds')).toContain(
      'On Windows, which has no signals, the server sends the script a stop message over an IPC channel instead',
    );
    expect(SERVER).toContain("from './scriptRunner.js'");
    expect(RUNNER).toContain("stdio: windows ? ['ignore', 'pipe', 'pipe', 'ipc']");
    expect(RUNNER).toContain('child.send(STOP_MESSAGE');
  });

  it('says the environment tools offer no reset and no destroy by rewind, which the server runs no line of', () => {
    const not = section('What the environment tools do not offer');
    const envTools = declaredTools().filter((tool) => tool.name.startsWith('env_'));
    // What each environment tool runs, read off its block of the server.
    const lines = SERVER.split(/\n {2}tool\(\{\n/)
      .slice(1)
      .filter((block) => /^\s+name: 'env_/m.test(block))
      .map((block) => /script: 'sandforge-env',\s+args: \[\s+'([a-z]+)'/.exec(block)?.[1]);

    expect(envTools.map((tool) => tool.name)).toEqual(['env_plan', 'env_apply', 'env_destroy']);
    expect(lines).toEqual(['plan', 'apply', 'destroy']);
    expect(not).toContain(
      'No tool resets an environment (`sandforge-env reset`) or destroys it by rewinding the org to a checkpoint (`destroy --rewind`) in this version',
    );
    expect(not).toContain('`env_destroy` takes back by removal alone.');
    expect(SERVER).not.toContain("'--rewind'");
    expect(SERVER).not.toContain("'reset'");
  });

  it('names the parameter each environment flag the server passes stands for', () => {
    const rule = section('The confirm rule');

    expect(rule).toContain("`acceptNoState` is `env_apply`'s `--accept-no-state`");
    expect(rule).toContain("`includeChanged` is `env_destroy`'s `--include-changed`");
    expect(SERVER).toContain("flags: { '--accept-no-state': 'acceptNoState' },");
    expect(SERVER).toContain("flags: { '--include-changed': 'includeChanged' },");
    expect(SERVER).toContain("...(args.failOnDrift === true ? ['--fail-on-drift'] : []),");
  });

  it('says the extension itself gives the model no tool, and names the test that holds it', () => {
    const anchor = 'anchor: nothing shipped gives the model tools or acts on a tool call';

    expect(DOC).toContain('**The extension itself gives the model no tool**');
    expect(DOC).toContain(anchor);
    expect(source('docs/product-claims.test.mjs')).toContain(`test('${anchor}'`);
    expect(existsSync(resolve(REPO_ROOT, 'scripts/mcp-server-not-shipped.test.mjs'))).toBe(true);
  });
});

describe('the pages that send a reader to docs/mcp.md', () => {
  it('the README’s checkpoint paragraph, the checkpoint guide and the FAQ’s answer on what is sent', () => {
    const readme = source('README.md');
    const rewind = readme.slice(readme.indexOf('## Rewind an org to a checkpoint'));
    const checkpoint = rewind
      .split('\n')
      .find((line) => line.includes('[`sandforge-checkpoint` script]'));
    const privacy = source('docs/faq.md')
      .split('\n')
      .find((line) => line.startsWith('Only to Anthropic'));

    expect(checkpoint).toContain('](docs/mcp.md)');
    // The server's tools apply and destroy environments too: the paragraph names them.
    expect(checkpoint).toContain(
      'the plan, apply and destroy of the environments a `sandforge.yaml` declares',
    );
    expect(source('docs/modules/checkpoint.md')).toContain('](../mcp.md)');
    expect(privacy).toContain('](mcp.md)');
  });
});
