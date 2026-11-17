import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  bashLauncher,
  bashQuote,
  githubActionsWorkflow,
  pipelineLaunchers,
  pwshLauncher,
  pwshQuote,
  type LauncherInput,
} from './pipelineRunners.js';

const PIPELINE = 'pipe-nightly';

function launcherInput(overrides: Partial<LauncherInput> = {}): LauncherInput {
  return {
    pipelineId: PIPELINE,
    pipelineName: 'Nightly reset',
    fileName: 'nightly-reset.sandforge-pipeline.json',
    sandforgeVersion: '1.81.0',
    exportedAt: '2026-11-20T10:00:00.000Z',
    schedule: { cron: '0 2 * * *', timezone: 'Europe/Paris' },
    machineTimezone: 'UTC',
    now: Date.parse('2026-11-20T10:00:00.000Z'),
    orgs: [
      { key: 'org-uat', alias: 'UAT', label: 'UAT' },
      { key: 'org-dev', label: 'org-dev' },
    ],
    variables: [{ name: 'apiToken', env: 'SANDFORGE_VAR_APITOKEN', secret: true }],
    approvals: [
      { name: "Go? (it's late)", staging: false },
      { name: 'Staging gate', staging: true },
    ],
    rewinds: [{ name: 'Back', alias: 'UAT' }],
    ...overrides,
  };
}

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-launcher-'));
  made.push(dir);
  return dir;
}

/**
 * A folder of the commands the bash launcher uses, and nothing else: what
 * cron gives a script, without the node and sf this machine may have.
 */
function bareBin(dir: string): string {
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const tool of ['dirname', 'mkdir', 'chmod', 'date', 'tee', 'cat']) {
    const found = ['/usr/bin', '/bin'].map((at) => join(at, tool)).find((path) => existsSync(path));
    if (found) symlinkSync(found, join(bin, tool));
  }
  return bin;
}

/** Stand-ins for node, sf and npx: npx writes the words it was given, and ends as `npxExit` says. */
function fakeTools(bin: string, npxExit: number): string {
  const said = join(bin, '..', 'npx-args');
  const tool = (name: string, body: string): void => {
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  tool('node', 'exit 0');
  tool('sf', 'exit 0');
  tool('npx', `printf '%s\\n' "$@" > ${bashQuote(said)}\nexit ${npxExit}`);
  return said;
}

function runBash(script: string, home: string, bin: string, env: Record<string, string> = {}) {
  return spawnSync('/bin/bash', [script], {
    env: { HOME: home, PATH: bin, ...env },
    encoding: 'utf8',
  });
}

describe('the bash launcher of a pipeline', () => {
  it('is bash that parses, named after the file, with its crontab line in this machine’s zone', () => {
    const dir = scratch();
    const launcher = bashLauncher(launcherInput());
    const script = join(dir, launcher.fileName);
    writeFileSync(script, launcher.text);

    expect(launcher.fileName).toBe('nightly-reset.sh');
    expect(spawnSync('/bin/bash', ['-n', script], { encoding: 'utf8' }).status).toBe(0);
    // 02:00 in Paris in November is 01:00 in UTC; in summer it is 00:00.
    expect(launcher.schedule).toMatchObject({
      kind: 'line',
      text: '0 1 * * * /bin/bash /path/to/nightly-reset.sh',
      timezone: 'UTC',
      offsetMinutes: -60,
    });
    // 01:00 in UTC is 03:00 in Paris once its clocks go forward.
    expect(launcher.text).toContain('# From 2027-03-28T01:00:00.000Z, it runs 60 minutes later');
    expect(launcher.text).toContain(
      "# From 2027-10-31T01:00:00.000Z, it runs at the pipeline's times again.",
    );
  });

  it('says Node.js is not found and ends in 127, under the bare environment cron gives it', () => {
    const dir = scratch();
    const launcher = bashLauncher(launcherInput());
    const script = join(dir, launcher.fileName);
    writeFileSync(script, launcher.text);

    const ran = runBash(script, join(dir, 'home'), bareBin(dir));

    expect(ran.status).toBe(127);
    expect(ran.stderr).toContain('Node.js 20.19 or later is not found on this PATH');
    const log = readFileSync(
      join(dir, 'home', '.sandforge', 'pipelines', PIPELINE, 'runs.log'),
      'utf8',
    );
    expect(log).toContain('nothing ran');
  });

  it('runs nothing, ending in 2, while the alias of an org or a secret is not set, and names each', () => {
    const dir = scratch();
    const bin = bareBin(dir);
    const said = fakeTools(bin, 0);
    const script = join(dir, 'nightly-reset.sh');
    writeFileSync(script, bashLauncher(launcherInput()).text);

    const ran = runBash(script, join(dir, 'home'), bin);

    expect(ran.status).toBe(2);
    expect(ran.stderr).toContain('org_alias_1 (the alias of org "org-dev")');
    expect(ran.stderr).toContain('SANDFORGE_VAR_APITOKEN (variable "apiToken", a secret)');
    expect(existsSync(said)).toBe(false);
  });

  it('runs the exact release on the file beside it, with what it was given, and ends as the run ends', () => {
    const dir = scratch();
    const bin = bareBin(dir);
    const said = fakeTools(bin, 3);
    const script = join(dir, 'nightly-reset.sh');
    writeFileSync(script, bashLauncher(launcherInput()).text);
    const store = join(dir, 'journal', 'pipelines', PIPELINE);
    mkdirSync(store, { recursive: true });
    writeFileSync(
      join(store, 'env'),
      "export ORG_ALIAS_1='DEV'\nexport SANDFORGE_VAR_APITOKEN='x'\n",
    );

    const ran = runBash(script, join(dir, 'home'), bin, {
      SANDFORGE_JOURNAL_DIR: join(dir, 'journal'),
    });

    expect(ran.status).toBe(3);
    expect(readFileSync(said, 'utf8').trim().split('\n')).toEqual([
      '-y',
      'sandforge@1.81.0',
      'pipeline',
      'run',
      '--file',
      join(dir, 'nightly-reset.sandforge-pipeline.json'),
      '--triggered-by',
      'schedule',
      '--fail-on-partial',
      '--org',
      'org-dev=DEV',
      '--var-env',
      'apiToken=SANDFORGE_VAR_APITOKEN',
    ]);
    expect(readFileSync(join(store, 'runs.log'), 'utf8')).toMatch(/start\n[\s\S]*exit 3\n$/);
  });

  it('never answers an Approval nor confirms a Rewind itself: the lines that would are commented out, none for a Staging gate', () => {
    const text = bashLauncher(launcherInput()).text;
    expect(text).toContain(`# args+=(--approve ${bashQuote("Go? (it's late)")})`);
    expect(text).toContain("# args+=(--confirm-rewind 'UAT')");
    expect(text).not.toMatch(/^args\+=\(--approve/m);
    expect(text).not.toContain("--approve 'Staging gate'");
    expect(text).toContain('"Staging gate" stands before a write to a sandbox marked Staging');
  });

  it('says why a schedule has no line in this machine’s crontab', () => {
    const launcher = bashLauncher(
      launcherInput({
        schedule: { cron: '30 23 * * 1', timezone: 'UTC' },
        machineTimezone: 'Asia/Tokyo',
      }),
    );
    // 23:30 on Monday in UTC is 08:30 on Tuesday in Tokyo: a weekly line moves its day.
    expect(launcher.schedule).toMatchObject({
      kind: 'line',
      text: '30 8 * * 2 /bin/bash /path/to/nightly-reset.sh',
    });

    const refused = bashLauncher(
      launcherInput({
        schedule: { cron: '30 23 1 * *', timezone: 'UTC' },
        machineTimezone: 'Asia/Tokyo',
      }),
    );
    expect(refused.schedule).toMatchObject({ kind: 'refused', code: 'notExact' });
    expect(refused.text).toContain(
      "# Its schedule cannot be written as a line of this machine's crontab:",
    );
  });
});

describe('the PowerShell launcher of a pipeline', () => {
  it('registers a daily or weekly trigger in Task Scheduler, and leaves a schedule of many starts to a person', () => {
    expect(pwshLauncher(launcherInput()).schedule).toMatchObject({
      kind: 'line',
      text: expect.stringContaining("New-ScheduledTaskTrigger -Daily -At '01:00'"),
    });
    expect(
      pwshLauncher(launcherInput({ schedule: { cron: '0 7 * * 1,5', timezone: 'UTC' } })).schedule,
    ).toMatchObject({
      text: expect.stringContaining(
        "New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Friday -At '07:00'",
      ),
    });
    expect(
      pwshLauncher(launcherInput({ schedule: { cron: '*/15 * * * *', timezone: 'UTC' } })).schedule,
    ).toMatchObject({
      kind: 'manual',
      reason: expect.stringContaining('create the task in Task Scheduler by hand'),
    });
  });

  it('quotes a word as PowerShell reads it whole, typographic quotes too', () => {
    expect(pwshQuote("it's")).toBe("'it''s'");
    expect(pwshQuote('it’s')).toBe("'it’’s'");
  });

  const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0;
  it.skipIf(!pwsh)(
    'is PowerShell that parses, and runs the exact release with what it was given',
    () => {
      const dir = scratch();
      const launcher = pwshLauncher(launcherInput());
      const script = join(dir, launcher.fileName);
      writeFileSync(script, launcher.text);

      const parsed = spawnSync(
        'pwsh',
        [
          '-NoProfile',
          '-Command',
          `[ScriptBlock]::Create((Get-Content -Raw -LiteralPath ${pwshQuote(script)})) | Out-Null`,
        ],
        { encoding: 'utf8' },
      );
      expect(parsed.stderr).toBe('');
      expect(parsed.status).toBe(0);

      const bin = join(dir, 'bin');
      mkdirSync(bin);
      const said = fakeTools(bin, 0);
      const ran = spawnSync('pwsh', ['-NoProfile', '-File', script], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env['PATH'] ?? ''}`,
          SANDFORGE_JOURNAL_DIR: join(dir, 'journal'),
          ORG_ALIAS_1: 'DEV',
          SANDFORGE_VAR_APITOKEN: 'x',
        },
        encoding: 'utf8',
      });
      expect(ran.status).toBe(0);
      expect(readFileSync(said, 'utf8').trim().split('\n')).toEqual([
        '-y',
        'sandforge@1.81.0',
        'pipeline',
        'run',
        '--file',
        join(dir, 'nightly-reset.sandforge-pipeline.json'),
        '--triggered-by',
        'schedule',
        '--fail-on-partial',
        '--org',
        'org-dev=DEV',
        '--var-env',
        'apiToken=SANDFORGE_VAR_APITOKEN',
      ]);
    },
  );
});

describe('the GitHub Actions workflow of a pipeline', () => {
  it('is YAML on the pipeline’s schedule in its own zone, and by hand, one run at a time', () => {
    const launcher = githubActionsWorkflow(launcherInput());
    const workflow = parse(launcher.text) as {
      on: { schedule: Array<{ cron: string; timezone: string }>; workflow_dispatch: null };
      concurrency: { group: string; 'cancel-in-progress': boolean };
      jobs: {
        run: { steps: Array<{ name?: string; run?: string; env?: Record<string, string> }> };
      };
    };

    expect(launcher.fileName).toBe('nightly-reset.yml');
    expect(workflow.on.schedule).toEqual([{ cron: '0 2 * * *', timezone: 'Europe/Paris' }]);
    expect(workflow.on).toHaveProperty('workflow_dispatch');
    expect(workflow.concurrency).toEqual({
      group: `sandforge-pipeline-${PIPELINE}`,
      'cancel-in-progress': false,
    });
    const signIn = workflow.jobs.run.steps.find((s) => s.name === "Sign in to the pipeline's orgs");
    expect(signIn?.env).toEqual({
      SFDX_AUTH_URL_UAT: '${{ secrets.SFDX_AUTH_URL_UAT }}',
      SFDX_AUTH_URL_PIPELINE_ORG_2: '${{ secrets.SFDX_AUTH_URL_PIPELINE_ORG_2 }}',
    });
    const run = workflow.jobs.run.steps.find((s) => s.name === 'Run the pipeline');
    expect(run?.env?.['SANDFORGE_VAR_APITOKEN']).toBe('${{ secrets.SANDFORGE_VAR_APITOKEN }}');
    expect(run?.run).toContain("args+=(--org 'org-dev=pipeline-org-2')");
    expect(run?.run).toContain('npx -y \'sandforge@1.81.0\' "${args[@]}"');
    expect(spawnSync('/bin/bash', ['-n'], { input: run?.run, encoding: 'utf8' }).status).toBe(0);
  });

  it('runs by hand alone a pipeline with no schedule, and says GitHub starts a schedule every 5 minutes at most', () => {
    const none = parse(githubActionsWorkflow(launcherInput({ schedule: null, orgs: [] })).text) as {
      on: Record<string, unknown>;
      jobs: { run: { steps: Array<{ name?: string }> } };
    };
    expect(Object.keys(none.on)).toEqual(['workflow_dispatch']);
    expect(none.jobs.run.steps.map((s) => s.name)).not.toContain("Sign in to the pipeline's orgs");

    const often = githubActionsWorkflow(
      launcherInput({ schedule: { cron: '*/2 * * * *', timezone: 'UTC' } }),
    );
    expect(often.text).toContain('# GitHub starts a schedule every 5 minutes at most');
  });

  it('tells how to print each org’s auth URL by the command current CLIs reveal it by, never sf org display, which redacts it', () => {
    const text = githubActionsWorkflow(launcherInput()).text;
    expect(text).toContain(
      '#   SFDX_AUTH_URL_UAT: the sfdx auth URL of "UAT" (sf org auth show-sfdx-auth-url --target-org UAT --json, its result.sfdxAuthUrl)',
    );
    expect(text).toContain(
      '#   SFDX_AUTH_URL_PIPELINE_ORG_2: the sfdx auth URL of "org-dev" (sf org auth show-sfdx-auth-url --target-org <its username> --json, its result.sfdxAuthUrl)',
    );
    expect(text).not.toContain('sf org display');
  });

  it('signs in to each org with sf org login sfdx-url, the command sf has, never sfdxurl', () => {
    // Run against a trap org, the workflow it wrote stopped at its sign-in:
    // sf answered the word it named "Command org:login:sfdxurl not found."
    const workflow = parse(githubActionsWorkflow(launcherInput()).text) as {
      jobs: { run: { steps: Array<{ name?: string; run?: string }> } };
    };
    const signIn = workflow.jobs.run.steps.find((s) => s.name === "Sign in to the pipeline's orgs");
    const logins = (signIn?.run ?? '').split('\n').filter((line) => line.includes('sf org login'));
    expect(logins).toHaveLength(2);
    expect(logins[0]).toMatch(
      /^sf org login sfdx-url --sfdx-url-file "\$auth_dir\/org-1\.txt" --alias '?UAT'?$/,
    );
    expect(logins[1]).toMatch(/^sf org login sfdx-url --sfdx-url-file "\$auth_dir\/org-2\.txt" /);
    expect(signIn?.run).not.toContain('sfdxurl');
  });
});

describe('the launchers of an export', () => {
  it('are one for each runner, each saying the release and the file it runs', () => {
    const launchers = pipelineLaunchers(launcherInput());
    expect(Object.keys(launchers)).toEqual(['cron', 'taskScheduler', 'githubActions']);
    for (const launcher of Object.values(launchers)) {
      expect(launcher.text).toContain(
        'It runs: npx -y sandforge@1.81.0 pipeline run --file nightly-reset.sandforge-pipeline.json',
      );
    }
  });

  it('keep a name that breaks a line on one line of a comment', () => {
    const text = bashLauncher(launcherInput({ pipelineName: 'Nightly\nrm -rf ~' })).text;
    expect(text).toContain('# SandForge pipeline "Nightly rm -rf ~", run from its file');
    expect(text.split('\n').filter((line) => line.startsWith('rm '))).toEqual([]);
  });

  it('leave out of their lines a variable, an Approval and an alias whose names break a line, and say which', () => {
    const broken = launcherInput({
      orgs: [{ key: 'org-uat', alias: 'UAT\n  - run: evil', label: 'UAT' }],
      variables: [{ name: 'token\n      - run: evil', env: 'SANDFORGE_VAR_TOKEN', secret: true }],
      approvals: [{ name: 'Go\nrm -rf ~', staging: false }],
      rewinds: [],
    });
    const dir = scratch();
    for (const launcher of Object.values(pipelineLaunchers(broken))) {
      expect(launcher.text).not.toMatch(/^\s*(?:- run: evil|rm -rf ~)/m);
    }
    const bash = bashLauncher(broken).text;
    writeFileSync(join(dir, 'run.sh'), bash);
    expect(spawnSync('/bin/bash', ['-n', join(dir, 'run.sh')]).status).toBe(0);
    expect(bash).toContain(
      '# Variable "token - run: evil" holds a line break in its name, which no line gives: rename it.',
    );
    expect(bash).toContain(
      '# Approval step "Go rm -rf ~" holds a line break in its name: only a terminal answers it.',
    );
    expect(bash).toContain('org_alias_1="${ORG_ALIAS_1:-}"');
    const workflow = parse(githubActionsWorkflow(broken).text) as {
      jobs: { run: { steps: Array<{ name?: string }> } };
    };
    expect(workflow.jobs.run.steps.map((s) => s.name ?? 'uses')).toEqual([
      'uses',
      'uses',
      'Install the Salesforce CLI',
      "Sign in to the pipeline's orgs",
      'uses',
      'Run the pipeline',
    ]);
  });
});
