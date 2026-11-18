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
  [...text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1] as string);

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
    const run = [...section('The tools').matchAll(/`sandforge ([a-z]+)\b/g)].map((m) => m[1]);
    // Positive control: the table names the command each tool runs.
    expect(new Set(run)).toEqual(
      new Set(['seed', 'clone', 'sync', 'checkpoint', 'empty', 'env', 'pipeline']),
    );
    for (const tool of new Set(run)) {
      expect(
        existsSync(resolve(REPO_ROOT, `packages/extension/cli/sandforge-${tool}.ts`)),
        tool,
      ).toBe(true);
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

    expect(envTools.map((tool) => tool.name)).toEqual([
      'env_plan',
      'env_apply',
      'env_destroy',
      'env_audit',
    ]);
    expect(lines).toEqual(['plan', 'apply', 'destroy', 'audit']);
    expect(not).toContain(
      'No tool resets an environment (`sandforge env reset`) or destroys it by rewinding the org to a checkpoint (`destroy --rewind`) in this version',
    );
    expect(not).toContain('`env_destroy` takes back by removal alone.');
    expect(SERVER).not.toContain("'--rewind'");
    expect(SERVER).not.toContain("'reset'");
  });

  it('names the parameter each environment flag the server passes stands for', () => {
    const rule = section('The confirm rule');

    expect(rule).toContain(
      '`acceptNoState` is `--accept-no-state`, and `replace` and `replaceDrifted` are ' +
        '`--replace` and `--replace-drifted` (`env_plan`, `env_apply`)',
    );
    expect(rule).toContain("`includeChanged` is `env_destroy`'s `--include-changed`");
    expect(SERVER).toContain("'--accept-no-state': 'acceptNoState'");
    // A plan and an apply, each: a drift line names --replace and
    // --replace-drifted, and the refusal of an org with no state
    // --accept-no-state, whichever of the two tools ran it.
    for (const passed of [
      "...(args.acceptNoState === true ? ['--accept-no-state'] : []),",
      "...(args.replaceDrifted === true ? ['--replace-drifted'] : []),",
      "...(args.replace ?? []).flatMap((name) => ['--replace', name]),",
    ]) {
      expect(SERVER.split(passed), passed).toHaveLength(3);
    }
    expect(SERVER).toContain("flags: { '--include-changed': 'includeChanged' },");
    expect(SERVER).toContain("...(args.failOnDrift === true ? ['--fail-on-drift'] : []),");
    expect(rule).toContain(
      '`acceptUserEmails` is `--accept-user-emails` (`env_plan`, `env_apply`), which ' +
        '`acceptEmails` never stands for, nor it for `acceptEmails`',
    );
    expect(rule).toContain(
      "`env_audit`'s `save` and `failOnFindings` are `--save` and `--fail-on-findings`",
    );
    expect(SERVER).toContain("'--accept-user-emails': 'acceptUserEmails'");
    expect(
      SERVER.split("...(args.acceptUserEmails === true ? ['--accept-user-emails'] : []),"),
    ).toHaveLength(3);
    expect(SERVER).toContain("...(args.save === true ? ['--save'] : []),");
    expect(SERVER).toContain("...(args.failOnFindings === true ? ['--fail-on-findings'] : []),");
  });

  it('says no tool sets up the users of a sandbox alone, as the server runs no line of sandforge users', () => {
    const not = section('What the environment tools do not offer');

    expect(not).toContain(
      'No tool sets up the users of a sandbox alone: a `users` resource of the file is applied ' +
        'by `env_apply` and taken back by `env_destroy`, as any other resource',
    );
    expect(declaredTools().filter((tool) => tool.name.startsWith('users_'))).toEqual([]);
    expect(SERVER).not.toContain("'sandforge-users'");
  });

  it('says how many tools the server declares, in words', () => {
    const words = [
      'twenty',
      'twenty-one',
      'twenty-two',
      'twenty-three',
      'twenty-four',
      'twenty-five',
      'twenty-six',
      'twenty-seven',
      'twenty-eight',
      'twenty-nine',
    ];
    const count = declaredTools().length;
    // Positive control: the count of 1.82.0, the audit of an environment added.
    expect(count).toBeGreaterThanOrEqual(25);

    expect(DOC).toContain(`\`sandforge mcp\` gives an AI agent ${words[count - 20] ?? '?'} tools`);
  });

  it('names the parameter each flag a removal names in its advice stands for, as run_remove passes it', () => {
    const rule = section('The confirm rule');

    expect(rule).toContain(
      "as it is `run_remove`'s, whose `muteAutomation` and `leaveUndeletable` are " +
        '`--mute-automation` and `--leave-undeletable`',
    );
    for (const [flag, parameter] of [
      ['--include-changed', 'includeChanged'],
      ['--accept-automation', 'acceptAutomation'],
      ['--mute-automation', 'muteAutomation'],
      ['--leave-undeletable', 'leaveUndeletable'],
    ]) {
      expect(SERVER).toContain(`'${flag}': '${parameter}',`);
      expect(SERVER).toContain(`...(args.${parameter} === true ? ['${flag}'] : []),`);
    }
    expect(rule).toContain("whose `store` is a Sync removal's `--store`");
    expect(SERVER).toContain("...(args.store !== undefined ? ['--store', args.store] : []),");
  });

  it('names muteAutomation on the seed and the clone, as they pass it, and says a flag no tool takes is the script’s own', () => {
    // seed_run and clone_record relayed "--mute-automation" and took no such
    // parameter.
    const rule = section('The confirm rule');

    // checkpoint_rewind and checkpoint_undo relayed "--mute-automation keeps
    // quiet …" of their refusal for the emails, and took no such parameter.
    expect(rule).toContain(
      '`muteAutomation` is `--mute-automation` for `seed_run`, `clone_record`, `clone_records`, ' +
        '`clone_org_plan`, `checkpoint_rewind`, `checkpoint_undo`, `checkpoint_replay`, ' +
        '`checkpoint_replay_remove`, `empty_preview`, `empty_run` and `empty_undo` too',
    );
    expect(SERVER).toContain(
      "flags: { '--accept-emails': 'acceptEmails', '--mute-automation': 'muteAutomation' },",
    );
    expect(SERVER.split("'--mute-automation': 'muteAutomation',")).toHaveLength(10);
    expect(
      SERVER.split("...(args.muteAutomation === true ? ['--mute-automation'] : []),"),
    ).toHaveLength(11);
    expect(rule).toContain("the script's line calls this script's own");
    expect(rule).toContain('No environment mutes, and none of its runs offers it.');
    expect(SERVER).toContain(
      "named: { '--accept-automation': fileAcceptsAutomation('env_destroy') },",
    );
  });

  it('says for each tool what it runs and what it writes, each script its declaration runs named', () => {
    const blocks = SERVER.split(/\n {2}tool\(\{\n/).slice(1);
    const rows = new Map(
      section('The tools')
        .split('\n')
        .filter((line) => /^\| `[a-z_]+`/.test(line))
        .map((line) => {
          const cells = line
            .replace(/^\|/, '')
            .replace(/\|\s*$/, '')
            .split(' | ')
            .map((cell) => cell.trim());
          return [/^`([a-z_]+)`/.exec(cells[0] ?? '')?.[1] ?? '', cells] as const;
        }),
    );

    for (const tool of declaredTools()) {
      const block = blocks.find((each) => each.includes(`name: '${tool.name}',`)) ?? '';
      const [, does, runs, writes] = rows.get(tool.name) ?? [];
      expect(does, tool.name).toBeTruthy();
      expect(runs, tool.name).toBeTruthy();
      expect(writes, tool.name).toBeTruthy();
      const scripts = new Set(
        [...block.matchAll(/script: 'sandforge-([a-z]+)'/g)].map((m) => m[1] as string),
      );
      for (const script of scripts) {
        expect(runs, `${tool.name} runs sandforge ${script}`).toContain(`sandforge ${script}`);
      }
      if (/\blocal: /.test(block)) expect(runs, tool.name).toMatch(/^nothing/);
      if (tool.readOnly) expect(writes, tool.name).toMatch(/^nothing/);
      if (tool.confirms) expect(writes, tool.name).not.toMatch(/^nothing/);
    }
    // Positive control: the tools of 1.81 are rows, each naming its own line.
    expect(rows.get('clone_records')?.[2]).toContain('`sandforge clone --query');
    expect(rows.get('checkpoint_replay')?.[2]).toContain('`sandforge checkpoint replay');
    expect(rows.get('pipeline_plan')?.[2]).toContain('`sandforge pipeline plan --file');
  });

  it('says no tool runs a pipeline, pipeline_plan alone planning one, as the server runs no line but a plan', () => {
    const pipelines = section('Pipelines');

    expect(pipelines).toContain('`pipeline_plan`');
    expect(pipelines).toContain('No tool runs a pipeline');
    expect(declaredTools().filter((tool) => tool.name.startsWith('pipeline_'))).toEqual([
      { name: 'pipeline_plan', readOnly: true, destructive: false, confirms: false },
    ]);
    // The one line of the pipeline script the server runs: its plan.
    expect([...SERVER.matchAll(/script: 'sandforge-pipeline'/g)]).toHaveLength(1);
    expect(SERVER).toContain("    'plan',\n    '--file',\n    args.file,");
    expect(SERVER).not.toMatch(/'sandforge-pipeline'[^\n]*'run'/);
  });

  it('says the key of a checkpoint file reaches the server by the name of a variable, never in an argument', () => {
    const replay = section('A checkpoint replayed into another org');

    expect(replay).toContain('`keyEnv`');
    expect(replay).toContain('never the key');
    expect(SERVER).toContain("['--file', args.file, '--key-env', args.keyEnv ?? '']");
    expect(SERVER).toContain('parseArchiveKey(name) === undefined');
    expect(SERVER).not.toMatch(/\n {8}key: z/);
  });

  it('says a removal of a run still writing is refused by its script, and by the server for its own runs', () => {
    expect(section('Long calls')).toContain('(`RUN_WRITING`)');
    expect(SERVER).toContain('The script refuses that itself (RUN_WRITING)');
    expect(SERVER).not.toContain('no lock of the clone holds a journal');
  });

  it('names every code the server refuses a call with, and no other', () => {
    // The server's own refusals, before any script runs: a code the guide did
    // not name was one an agent's reader could not look up.
    const thrown = new Set([
      ...[...SERVER.matchAll(/refused\(\s*'([A-Z_]+)'/g)].map((m) => m[1] as string),
      ...[...SERVER.matchAll(/\bcode: '([A-Z_]+)'/g)].map((m) => m[1] as string),
    ]);
    const answers = section('What a call answers');
    const listed = answers.slice(answers.indexOf('A call refused by the server'));
    const named = new Set(
      [...listed.matchAll(/`([A-Z][A-Z_]+)`/g)]
        .map((m) => m[1] as string)
        .filter((code) => code !== 'VERIFIED'),
    );

    // Positive control: the codes of the confirm rule and of a plan gone.
    expect(thrown).toContain('CONFIRM');
    expect(thrown).toContain('PLAN_GONE');
    expect(named).toEqual(thrown);
  });

  it('says how a clone of the whole org goes, that it is always anonymized, and where a person copies personal data as it is', () => {
    const clone = section('A clone of the whole org');

    expect(clone).toContain('`clone_org_plan` runs the dry run of a clone of the whole org');
    expect(clone).toContain('`clone_org` takes that id and `confirm`');
    expect(clone).toContain(
      'Every personal field of a clone of the whole org is anonymized, always',
    );
    expect(clone).toContain('`sandforge clone --depth all … --no-anonymize`');
    expect(clone).toContain('`accept: { realData: true }`');
    // What the server runs: --anonymize on every plan's line, and no tool
    // that hands a script --no-anonymize.
    expect(SERVER).toMatch(/\n {4}'--anonymize',\n/);
    expect(SERVER).not.toContain("? ['--no-anonymize']");
    expect(SERVER).toContain(
      "accept: { realData: ' +\n  'true }, reviewed where the repository is",
    );
  });

  it('says how long a call holds its script before it hands its run back, as the runs module holds it', () => {
    const long = section('Long calls');
    const runs = source('packages/extension/cli/mcpRuns.ts');
    const held = /export const HOLD_SECONDS_DEFAULT = (\d+);/.exec(runs)?.[1];
    const most = /export const HOLD_SECONDS_MOST = (\d+);/.exec(runs)?.[1];
    const waited = /export const WAIT_SECONDS_MOST = (\d+);/.exec(runs)?.[1];
    if (!held || !most || !waited) throw new Error('mcpRuns.ts says its hold otherwise: re-point');

    expect(long).toContain(`once the call has held it ${held} seconds`);
    expect(long).toContain(`\`SANDFORGE_MCP_HOLD_SECONDS\` sets the hold, 0 to ${most} seconds`);
    expect(long).toContain(`\`waitSeconds\`, ${waited} at most`);
    expect(runs).toContain("export const HOLD_SECONDS_VARIABLE = 'SANDFORGE_MCP_HOLD_SECONDS';");
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
    // Since 1.83.0 the README names the server where it says the scripts, in its
    // command-line section; the line that says what the scripts are links it.
    const scripts = readme.slice(readme.indexOf('## Test data as code, for the command line & CI'));
    const checkpoint = scripts.split('\n').find((line) => line.includes('](docs/mcp.md)'));
    const privacy = source('docs/faq.md')
      .split('\n')
      .find((line) => line.startsWith('Only to Anthropic'));

    expect(checkpoint).toContain('](docs/mcp.md)');
    expect(checkpoint).toContain('an AI agent reaches them as the tools of an [MCP server]');
    expect(source('docs/modules/checkpoint.md')).toContain('](../mcp.md)');
    expect(privacy).toContain('](mcp.md)');
  });
});
