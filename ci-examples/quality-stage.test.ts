import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const EXAMPLES_DIR = fileURLToPath(new URL('.', import.meta.url));

const PIPELINES = ['github-actions.yml', 'gitlab-ci.yml', 'Jenkinsfile', 'azure-pipelines.yml'];

/**
 * `pnpm build:shared` emits the `@sandforge/shared` dist/ that every other
 * package imports, so anything reading those types has to run after it.
 * `pnpm validate` chains it first; a hand-rolled stage may not.
 */
const BUILDS_SHARED = /pnpm (?:validate|build:shared)\b/;
const NEEDS_SHARED = /pnpm (?:typecheck|lint|test)\b/;

/**
 * Only the lines the CI platform executes. The `#` / `//` header blocks of
 * these examples name the very commands under test, so a raw file scan would
 * grade the prose instead of the pipeline.
 */
function commandLines(source: string): string[] {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('//'));
}

function read(name: string): string {
  // Normalised: the assertions are LF-anchored and miss on a CRLF checkout.
  return readFileSync(join(EXAMPLES_DIR, name), 'utf8').replace(/\r\n/g, '\n');
}

/**
 * Each call of a script the pipeline executes, with its backslash-continued
 * lines, whatever the host language escapes the backslash as. Comment lines
 * are left out: the headers name the very scripts under test.
 */
function scriptCalls(source: string, script: string): string[] {
  const executed = source
    .split('\n')
    .filter((line) => !/^\s*(?:#|\/\/)/.test(line))
    .join('\n');
  const call = new RegExp(`${script}\\.ts(?:[^\\n]*\\\\\\n)*[^\\n]*`, 'g');
  return [...executed.matchAll(call)].map(([found]) => found);
}

/** The line of a pipeline's removal call that names the summary it takes the clone back from. */
const REMOVAL_CALL = /^\s*--remove clone-summary\.json\b/m;

/**
 * Per pipeline, how its removal switch is declared off, and the condition the
 * removal runs under: the clone was no dry run, and the removal was asked for.
 */
const REMOVAL_SWITCH: Record<string, { off: RegExp; gate: RegExp }> = {
  'github-actions.yml': {
    off: /remove_after:\n(?:[ \t]+[^\n]*\n)*?[ \t]+default: 'false'/,
    gate: /if: env\.DRY_RUN != 'true' && env\.REMOVE_AFTER == 'true'/,
  },
  'gitlab-ci.yml': {
    off: /^ {2}REMOVE_AFTER: 'false'$/m,
    gate: /if \[ "\$DRY_RUN" != "true" \] && \[ "\$REMOVE_AFTER" = "true" \]; then/,
  },
  Jenkinsfile: {
    off: /booleanParam\(\s*name: 'REMOVE_AFTER',\s*defaultValue: false/,
    gate: /if \(!params\.DRY_RUN && params\.REMOVE_AFTER\) \{/,
  },
  'azure-pipelines.yml': {
    off: /- name: removeAfter\n(?:[ \t]+[^\n]*\n)*?[ \t]+default: false/,
    gate: /\$\{\{ if and\(eq\(parameters\.dryRun, false\), eq\(parameters\.removeAfter, true\)\) \}\}:/,
  },
};

describe('ci-examples quality stage', () => {
  describe.each(PIPELINES)('%s', (pipeline) => {
    it('runs the quality gates through pnpm validate', () => {
      const runs = commandLines(read(pipeline)).filter((line) => BUILDS_SHARED.test(line));

      expect(runs.some((line) => line.includes('pnpm validate'))).toBe(true);
    });

    it('builds @sandforge/shared before anything that consumes it', () => {
      const lines = commandLines(read(pipeline));
      const firstBuild = lines.findIndex((line) => BUILDS_SHARED.test(line));
      const firstConsumer = lines.findIndex((line) => NEEDS_SHARED.test(line));

      if (firstConsumer === -1) {
        return;
      }
      expect(firstBuild).toBeGreaterThan(-1);
      expect(firstBuild).toBeLessThan(firstConsumer);
    });
  });

  describe.each(PIPELINES)('%s org access', (pipeline) => {
    it('never writes an auth URL to a fixed /tmp path', () => {
      // A fixed name under /tmp is world-readable at the default umask, and a
      // failing login between the write and the `rm` left it on the agent.
      expect(commandLines(read(pipeline)).filter((line) => /> ?\/tmp\/auth-/.test(line))).toEqual(
        [],
      );
    });

    it('writes auth URLs to a private temp dir removed on exit, in the same shell as the logins', () => {
      const source = read(pipeline);
      const start = source.indexOf('umask 077');
      const lastLogin = source.lastIndexOf('sf org login sfdxurl');

      expect(start).toBeGreaterThan(-1);
      expect(lastLogin).toBeGreaterThan(start);

      // Everything from the umask to the last login has to run in one shell:
      // a trap only fires for the shell that set it, and a new step or `sh`
      // call starts a new one.
      const block = source.slice(start, lastLogin);
      expect(block).toMatch(/mktemp -d/);
      expect(block).toMatch(/trap '[^']*rm -rf[^']*' EXIT/);
      expect(block).not.toMatch(/^\s*(?:- \||(?:- )?(?:run|script): \||sh ['"]|- name:|- task:)/m);
    });

    it('never runs the cleanup to undo the clone', () => {
      // `--since today` matches every record the CI user created today, not
      // only the ones the clone step wrote: a cleanup the pipeline runs can
      // only ever be a preview.
      for (const call of scriptCalls(read(pipeline), 'sandforge-cleanup')) {
        expect(call).toMatch(/\s--dry-run\b/);
      }
    });

    it('takes the clone back with --remove of the summary the clone saved', () => {
      // What the clone created, and nothing else, as the wizard removes a run
      // from Recent runs: the summary says which records those are.
      const calls = scriptCalls(read(pipeline), 'sandforge-clone');
      const clone = calls.findIndex((call) => /\s--record\s/.test(call));
      const removal = calls.findIndex((call) => /\s--remove\s/.test(call));

      expect(clone).toBeGreaterThan(-1);
      expect(calls[clone]).toMatch(/\s--json\b[\s\S]*> clone-summary\.json/);
      expect(removal).toBeGreaterThan(clone);
      expect(calls[removal]).toMatch(/\s--remove clone-summary\.json\b/);
      expect(calls[removal]).toMatch(/\s--target ci-target\b/);
    });

    it('removes only after a real clone, and only when asked', () => {
      // A dry run created nothing and `--remove` refuses its summary; and a
      // real clone is there to stay unless the run asks for it back.
      const source = read(pipeline);
      const { off, gate } = REMOVAL_SWITCH[pipeline];
      // The call's own line: the header names the flag too.
      const removal = REMOVAL_CALL.exec(source)?.index ?? -1;
      const guarded = gate.exec(source);

      expect(source).toMatch(off);
      expect(removal).toBeGreaterThan(-1);
      expect(guarded).not.toBeNull();
      expect(guarded?.index ?? Infinity).toBeLessThan(removal);
      expect(source.lastIndexOf('> clone-summary.json', removal)).toBeLessThan(
        guarded?.index ?? -1,
      );
    });

    it('keeps the removals file with the clone summary', () => {
      // A removal keeps there what it wrote to the records it left, which the
      // next removal of the same summary reads; lost, that one takes those
      // records for changed since the run, and keeps them.
      expect(
        commandLines(read(pipeline)).some((line) => line.includes('clone-summary.removals.json')),
      ).toBe(true);
    });

    it('gates the org stages on a configured record id', () => {
      // Without a record the clone fails on a missing `--record` after both
      // logins, which reads as broken credentials rather than a missing setting.
      const gates = commandLines(read(pipeline)).filter((line) =>
        /^(?:- )?(?:if|condition):|expression \{/.test(line),
      );
      const orgGates = gates.filter((line) => line.includes('SANDFORGE_SF_ORGS'));

      expect(orgGates.length).toBeGreaterThan(0);
      for (const gate of orgGates) {
        expect(gate).toMatch(
          /SF_CLONE_RECORD_ID(?: != ''|'\], ''\)|\?\.trim\(\))|&& \$SF_CLONE_RECORD_ID\s*$/,
        );
      }
    });

    it('pins no pnpm version of its own', () => {
      // The root package.json `packageManager` field is the one pin; a copy in
      // a pipeline drifts from it on the next pnpm bump.
      const source = read(pipeline);

      expect(source).not.toMatch(/pnpm@\d/);
      expect(source).not.toMatch(/PNPM_VERSION/);
      expect(source).not.toMatch(/pnpm\/action-setup@v\d+\s*\n\s*with:\s*\n\s*version:/);
    });

    it('uses every notification secret its header asks for', () => {
      const source = read(pipeline);
      const asked = source
        .split('\n')
        .filter((line) => /^\s*(?:#|\/\/)/.test(line))
        .some((line) => /SLACK_WEBHOOK_URL|slack-webhook/.test(line));
      const used = commandLines(source).some((line) => /SLACK_WEBHOOK_URL/.test(line));

      expect(used).toBe(asked);
    });
  });

  it('removes in the Jenkins stage that logs in, never in a stage of its own', () => {
    // A stage without the login reuses whatever `ci-target` alias an earlier
    // build left in the agent's sf config.
    const removing = read('Jenkinsfile')
      .split(/(?=stage\(')/)
      .filter((stage) => REMOVAL_CALL.test(stage));

    expect(removing).toHaveLength(1);
    expect(removing[0]).toMatch(/sf org login sfdxurl[^\n]*--alias ci-target/);
  });

  it('names the removals file as the clone command derives it from the summary', () => {
    // `clone-summary.json` → `clone-summary.removals.json`, beside it.
    const cli = read('../packages/extension/cli/sandforge-clone.ts');

    expect(cli).toContain(".replace(/\\.json$/i, '.removals.json')");
  });

  it('names the Node tool the Jenkinsfile actually requests', () => {
    const source = read('Jenkinsfile');
    const tool = /nodejs '([^']+)'/.exec(source)?.[1];

    expect(tool).toBeDefined();
    const named = [...source.matchAll(/'(Node-\d+)'/g)].map(([, name]) => name);
    expect(new Set(named)).toEqual(new Set([tool]));
  });

  it('notifies from GitLab when any job fails, not only the package job', () => {
    const source = read('gitlab-ci.yml');

    expect(source).not.toMatch(/after_script:/);

    // A rule without `when: on_failure` runs the job on success too, and it
    // then posts "FAILED" for every green pipeline that rule matches.
    const notify = /^notify:\n((?:[ \t]+[^\n]*\n|\n)*)/m.exec(source)?.[1] ?? '';
    const lines = notify.split('\n').map((line) => line.trim());
    const rules = lines.flatMap((line, i) => (line.startsWith('- if:') ? [i] : []));

    expect(rules.length).toBeGreaterThan(0);
    for (const i of rules) {
      expect(lines[i + 1], lines[i]).toBe('when: on_failure');
    }
  });

  it('runs the Azure clone only after the quality stage succeeded', () => {
    // A stage `condition:` replaces the implicit succeeded() instead of adding
    // to it, so leaving it out lets the clone reach the orgs after a red gate.
    const condition = /stage: Clone\n(?:[ \t]+[^\n]*\n)*?[ \t]+condition: ([^\n]+)/.exec(
      read('azure-pipelines.yml'),
    )?.[1];

    expect(condition).toMatch(/^and\(succeeded\(\),/);
  });

  it('keeps the cleanup defaults to objects every org has', () => {
    // A default is applied to whatever org the user points it at; an
    // industry-cloud object only exists in some of them, and there it would
    // delete records the clone never wrote.
    const cli = read('../packages/extension/cli/sandforge-cleanup.ts');
    const defaults = /const DEFAULT_OBJECTS = \[([\s\S]*?)\];/.exec(cli)?.[1];

    expect(defaults).toBeDefined();
    const objects = [...(defaults ?? '').matchAll(/'([^']+)'/g)].map(([, name]) => name);
    expect(objects).toContain('Account');
    expect(objects.filter((name) => /__c$|^Insurance/.test(name))).toEqual([]);
  });

  it('tells the reader which branch the triggers name and what the cleanup can match', () => {
    const readme = read('README.md');

    expect(readme).toMatch(/`main`[^\n]*default branch/);
    expect(readme).toMatch(/--since today[^\n]*every record/);
  });

  it('documents the same command order in README.md', () => {
    const bullet = read('README.md')
      .split(/\r?\n/)
      .find((line) => line.includes('**Quality gates**'));

    expect(bullet).toBeDefined();
    expect(bullet).toContain('pnpm validate');

    const build = bullet?.indexOf('pnpm build:shared') ?? -1;
    const typecheck = bullet?.indexOf('pnpm typecheck') ?? -1;
    expect(build).toBeGreaterThan(-1);
    if (typecheck !== -1) {
      expect(build).toBeLessThan(typecheck);
    }
  });
});
