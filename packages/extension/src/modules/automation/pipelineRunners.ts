/**
 * The launchers an export writes beside a pipeline file: what starts the
 * pipeline once VS Code is closed. A bash script with its crontab line, a
 * PowerShell script with its Task Scheduler registration, and a GitHub
 * Actions workflow.
 *
 * Each is thin: it finds Node.js and the Salesforce CLI, gives the run what
 * the file cannot hold — the alias of an org known by its username alone, a
 * secret's value from the environment — and calls the one command that runs
 * a pipeline file, `npx -y sandforge@<version> pipeline run`, at the release
 * that exported it. What the run does is the file's: a launcher never
 * answers an Approval step nor confirms a Rewind on its own, and offers the
 * line that would, commented out, for a person to choose.
 *
 * A schedule goes out in the zone its scheduler reads: cron and Task
 * Scheduler read this machine's clock, so the pipeline's line is converted to
 * this machine's zone, or refused when no line there runs at the same
 * moments; GitHub Actions reads the pipeline's own zone (`timezone` beside
 * `cron`, docs.github.com, "Events that trigger workflows").
 */

import type {
  PipelineFileSchedule,
  PipelineLauncher,
  PipelineLauncherSchedule,
  PipelineOutsideRunner,
} from '@sandforge/shared';
import { PIPELINE_FILE_SUFFIX, convertCronZone, readCron } from '@sandforge/shared';
import type { CronInZone, CronZoneRefusal } from '@sandforge/shared';
import { pipelineFolderName } from './PipelineRunLock.js';

/** An org as a launcher names it: by its key in the file, and its alias when it has one of its own. */
export interface LauncherOrg {
  key: string;
  alias?: string;
  /** How a comment names it: its alias, its own name, or its key; never a username. */
  label: string;
}

/** A variable a launcher reads from the environment and hands the run (`--var-env`). */
export interface LauncherVariable {
  name: string;
  /** The environment variable it is read from. */
  env: string;
  secret: boolean;
}

/** What the launchers of one export are written from. */
export interface LauncherInput {
  pipelineId: string;
  pipelineName: string;
  /** The pipeline file's name, which each launcher runs from beside it. */
  fileName: string;
  sandforgeVersion: string;
  exportedAt: string;
  schedule: PipelineFileSchedule | null;
  /** The zone this machine's clock reads, which cron and Task Scheduler read their lines in. */
  machineTimezone: string;
  /** Now, in epoch milliseconds: the offset a converted line is moved by is the one at this instant. */
  now: number;
  orgs: readonly LauncherOrg[];
  variables: readonly LauncherVariable[];
  /** The Approval steps, by name, and whether each stands before a write to a sandbox marked Staging. */
  approvals: ReadonlyArray<{ name: string; staging: boolean }>;
  /** The Rewind steps, by name, with the alias of the org each rewinds. */
  rewinds: ReadonlyArray<{ name: string; alias?: string }>;
}

/** The oldest Node.js the `sandforge` package runs on. */
const NODE_FLOOR = { major: 20, minor: 19 };

/** How often GitHub Actions starts a schedule at most: every five minutes. */
const GITHUB_MIN_INTERVAL_MINUTES = 5;

/** The most triggers a Task Scheduler registration is written with: past it, a person creates the task. */
const MAX_TASK_TRIGGERS = 12;

/** The day names Task Scheduler takes, Sunday first, as cron numbers them. */
const WEEK_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** One line of text, for a comment or a message: whatever breaks a line becomes a space. */
function oneLine(text: string): string {
  return text.replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ').trim();
}

/** A word as bash reads it whole and as it is: in single quotes. */
export function bashQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * A word as PowerShell reads it whole and as it is: in single quotes, each one
 * doubled, the typographic ones too, which PowerShell reads as quotes.
 */
export function pwshQuote(text: string): string {
  return `'${text.replace(/['\u2018\u2019\u201a\u201b]/g, (quote) => quote + quote)}'`;
}

/** A scalar as YAML reads it as it is: a JSON string is a double-quoted YAML scalar. */
function yamlQuote(text: string): string {
  return JSON.stringify(text);
}

/** The launcher's own name: the pipeline file's, without its suffix. */
function baseNameOf(fileName: string): string {
  return fileName.endsWith(PIPELINE_FILE_SUFFIX)
    ? fileName.slice(0, -PIPELINE_FILE_SUFFIX.length)
    : fileName.replace(/\.json$/, '');
}

/** The secret a workflow reads an org's sign-in from, by its alias. */
function authSecretOf(alias: string): string {
  return `SFDX_AUTH_URL_${alias
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')}`;
}

/** How a line converted for a scheduler reads, or why it was refused. */
function scheduleOf(converted: CronInZone | CronZoneRefusal): PipelineLauncherSchedule {
  if ('refused' in converted) {
    return { kind: 'refused', code: converted.refused, reason: converted.reason };
  }
  return {
    kind: 'line',
    text: converted.cron,
    timezone: converted.timezone,
    offsetMinutes: converted.offsetMinutes,
    offsetChanges: converted.offsetChanges,
  };
}

/** What a comment says of each clock change after which a converted line runs off. */
function driftLines(schedule: Extract<PipelineLauncherSchedule, { kind: 'line' }>): string[] {
  return schedule.offsetChanges.map((change) => {
    const drift = schedule.offsetMinutes - change.offsetMinutes;
    const when = new Date(change.at).toISOString();
    if (drift === 0) return `From ${when}, it runs at the pipeline's times again.`;
    return (
      `From ${when}, it runs ${Math.abs(drift)} minutes ${drift > 0 ? 'later' : 'earlier'} ` +
      "than the pipeline's schedule says: export it again then."
    );
  });
}

/** The command a launcher runs, as the dialog and the comments name it. */
function runCommand(input: LauncherInput): string {
  return `npx -y sandforge@${input.sandforgeVersion} pipeline run --file ${input.fileName}`;
}

/** The comment lines every launcher opens with: what it is, what it needs, and what it does. */
function header(input: LauncherInput, needs: string[]): string[] {
  return [
    `SandForge pipeline "${oneLine(input.pipelineName)}", run from its file with VS Code closed.`,
    `Exported by SandForge ${input.sandforgeVersion} on ${input.exportedAt}.`,
    '',
    ...needs,
    '',
    `It runs: ${runCommand(input)}`,
    "Exit code: the run's. 0 completed; 1 failed; 2 refused before its first step, nothing",
    'ran; 3 completed with a step that failed; 129, 130 or 143 stopped by a signal; and 127',
    'when Node.js or the Salesforce CLI is not found.',
  ];
}

/** The lines that say each Approval and Rewind step, and the line that answers it, commented out. */
function answeredAhead(
  input: LauncherInput,
  comment: string,
  line: (flag: string, value: string) => string,
): string[] {
  const lines: string[] = [];
  if (input.approvals.length > 0) {
    lines.push(
      `${comment} An Approval step asks a person. Run with no one at a terminal, the run is`,
      `${comment} refused before its first step unless the step is answered here, ahead:`,
      `${comment} remove the "${comment}" of its line to answer it yes on every run.`,
    );
    for (const approval of input.approvals) {
      if (approval.staging) {
        lines.push(
          `${comment} "${oneLine(approval.name)}" stands before a write to a sandbox marked Staging:`,
          `${comment} only a person at a terminal answers it, never a line here.`,
        );
      } else {
        lines.push(`${comment} ${line('--approve', approval.name)}`);
      }
    }
  }
  if (input.rewinds.length > 0) {
    lines.push(
      `${comment} A Rewind step runs once its org's alias is confirmed: by`,
      `${comment} "npx -y sandforge@${input.sandforgeVersion} pipeline confirm --file ${input.fileName}"`,
      `${comment} at a terminal of this machine, or here. Its checkpoint must be kept on this machine.`,
    );
    for (const rewind of input.rewinds) {
      lines.push(
        rewind.alias !== undefined
          ? `${comment} ${line('--confirm-rewind', rewind.alias)}`
          : `${comment} "${oneLine(rewind.name)}" rewinds an org with no alias: confirm it with pipeline confirm.`,
      );
    }
  }
  return lines;
}

/**
 * Whether a value can stand in a line of a launcher as it is: no control
 * character, which ends a line or has no place in one, and neither of the
 * separators JavaScript and YAML read as the end of a line.
 */
function fitsALine(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) return false;
  }
  return true;
}

/** An org known by no alias a line can hold: set as one with none. */
function withoutAlias({ alias: _alias, ...org }: LauncherOrg): LauncherOrg {
  return org;
}

/**
 * The input with each value that cannot stand in a line left out, and the
 * comment lines that say which. A name holding a line break, put in a line,
 * would end it there: in a comment, the rest would run as a command; in a
 * workflow, it would end the step's script and be read as YAML. The run then
 * refuses what it misses, and says so, as it does for a value not given.
 */
function fitted(raw: LauncherInput): { input: LauncherInput; leftOut: string[] } {
  if (!fitsALine(raw.fileName)) throw new Error('A pipeline file name is one line of text.');
  const leftOut: string[] = [];
  const orgs = raw.orgs.flatMap((org) => {
    if (!fitsALine(org.key)) {
      leftOut.push(
        `Org "${oneLine(org.label)}" is named by a key no line can hold: run it from a terminal.`,
      );
      return [];
    }
    if (org.alias === undefined || fitsALine(org.alias)) return [org];
    leftOut.push(
      `The alias of org "${oneLine(org.label)}" holds a line break: it is asked below as an alias of this machine.`,
    );
    return [withoutAlias(org)];
  });
  const variables = raw.variables.filter((variable) => {
    if (fitsALine(variable.name)) return true;
    leftOut.push(
      `Variable "${oneLine(variable.name)}" holds a line break in its name, which no line gives: rename it.`,
    );
    return false;
  });
  const approvals = raw.approvals.filter((approval) => {
    if (fitsALine(approval.name)) return true;
    leftOut.push(
      `Approval step "${oneLine(approval.name)}" holds a line break in its name: only a terminal answers it.`,
    );
    return false;
  });
  const rewinds = raw.rewinds.map((rewind) =>
    rewind.alias === undefined || fitsALine(rewind.alias) ? rewind : { name: rewind.name },
  );
  return { input: { ...raw, orgs, variables, approvals, rewinds }, leftOut };
}

/** The orgs known by a username alone: each needs an alias of this machine, set in the launcher. */
function unaliased(input: LauncherInput): Array<LauncherOrg & { slot: string }> {
  return input.orgs
    .filter((org) => org.alias === undefined)
    .map((org, index) => ({ ...org, slot: `org_alias_${index + 1}` }));
}

/** The bash launcher, and the crontab line that starts it. */
export function bashLauncher(raw: LauncherInput): PipelineLauncher {
  const { input, leftOut } = fitted(raw);
  const base = baseNameOf(input.fileName);
  const fileName = `${base}.sh`;
  const folder = pipelineFolderName(input.pipelineId);
  const schedule =
    input.schedule === null
      ? undefined
      : scheduleOf(
          convertCronZone(
            input.schedule.cron,
            input.schedule.timezone,
            input.machineTimezone,
            input.now,
          ),
        );
  const scheduleLines: string[] =
    schedule === undefined
      ? ['This pipeline has no schedule: run this script by hand, or from a scheduler of your own.']
      : schedule.kind === 'line'
        ? [
            `Its schedule, as a line of this machine's crontab (crontab -e), read in ${schedule.timezone}:`,
            `  ${schedule.text} /bin/bash /path/to/${fileName}`,
            ...(schedule.offsetMinutes !== 0
              ? [
                  `The pipeline's schedule, ${input.schedule?.cron} in ${input.schedule?.timezone}, moved by ` +
                    `${schedule.offsetMinutes} minutes: Ubuntu's cron reads no zone of its own.`,
                ]
              : []),
            ...driftLines(schedule),
          ]
        : [
            "Its schedule cannot be written as a line of this machine's crontab:",
            oneLine(schedule.reason),
          ];
  const needs = [
    `Keep it beside ${input.fileName}. It needs Node.js ${NODE_FLOOR.major}.${NODE_FLOOR.minor} or later`,
    'and the Salesforce CLI (sf), signed in to each org of the pipeline under its alias.',
    "Each run is appended to runs.log, in the pipeline's folder below.",
    '',
    ...scheduleLines,
    ...(leftOut.length > 0 ? ['', ...leftOut] : []),
  ];
  const orgSlots = unaliased(input);
  const lines: string[] = [
    '#!/usr/bin/env bash',
    ...header(input, needs).map((line) => (line === '' ? '#' : `# ${line}`)),
    'set -u',
    '',
    'here="$(cd "$(dirname "$0")" && pwd)"',
    `file="$here/"${bashQuote(input.fileName)}`,
    `store="\${SANDFORGE_JOURNAL_DIR:-$HOME/.sandforge}/pipelines/"${bashQuote(folder)}`,
    'mkdir -p "$store" && chmod 700 "$store"',
    'log="$store/runs.log"',
    '',
    '# cron starts a script with little more than /usr/bin and /bin on its PATH:',
    '# the usual places of node and sf are added, then the default Node.js of nvm.',
    'PATH="$PATH:/usr/local/bin:$HOME/.local/bin"',
    'node_ok() {',
    '  command -v node >/dev/null 2>&1 &&',
    `    node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > ${NODE_FLOOR.major} || (a === ${NODE_FLOOR.major} && b >= ${NODE_FLOOR.minor}) ? 0 : 1)'`,
    '}',
    'if ! node_ok || ! command -v sf >/dev/null 2>&1; then',
    '  nvm_sh="${NVM_DIR:-$HOME/.nvm}/nvm.sh"',
    '  if [ -s "$nvm_sh" ]; then',
    '    . "$nvm_sh" >/dev/null 2>&1',
    '    nvm use --silent default >/dev/null 2>&1 || true',
    '  fi',
    'fi',
    'say() { printf \'%s %s\\n\' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" | tee -a "$log" >&2; }',
    'if ! node_ok; then',
    `  say "Node.js ${NODE_FLOOR.major}.${NODE_FLOOR.minor} or later is not found on this PATH ($PATH), nor through nvm: nothing ran. Install it, or add its folder to PATH at the top of this script."`,
    '  exit 127',
    'fi',
    'if ! command -v sf >/dev/null 2>&1; then',
    '  say "The Salesforce CLI (sf) is not found on this PATH ($PATH): nothing ran. Install it (npm install -g @salesforce/cli), or add its folder to PATH at the top of this script."',
    '  exit 127',
    'fi',
    '',
  ];
  if (orgSlots.length > 0 || input.variables.length > 0) {
    lines.push(
      '# What the pipeline file does not hold, read from here or from the environment.',
      '# cron gives a script no environment of yours: set values in "$store/env",',
      "# one `export NAME='value'` a line, in a file only you can read (chmod 600).",
      'if [ -f "$store/env" ]; then . "$store/env"; fi',
    );
    for (const slot of orgSlots) {
      lines.push(
        `# The alias, on this machine, of org "${oneLine(slot.label)}", which has none of its own`,
        `# (sf alias set <alias>=<its username>).`,
        `${slot.slot}="\${${slot.slot.toUpperCase()}:-}"`,
      );
    }
    lines.push('missing=()');
    for (const slot of orgSlots) {
      lines.push(
        `[ -n "$${slot.slot}" ] || missing+=(${bashQuote(`${slot.slot} (the alias of org "${oneLine(slot.label)}")`)})`,
      );
    }
    for (const variable of input.variables) {
      lines.push(
        `[ -n "\${${variable.env}:-}" ] || missing+=(${bashQuote(
          `${variable.env} (variable "${oneLine(variable.name)}"${variable.secret ? ', a secret' : ''})`,
        )})`,
      );
    }
    lines.push(
      'if [ "${#missing[@]}" -gt 0 ]; then',
      '  say "Not set, so nothing ran: ${missing[*]}. Set each in this script or in $store/env."',
      '  exit 2',
      'fi',
      '',
    );
  }
  lines.push(
    'args=(pipeline run --file "$file" --triggered-by schedule --fail-on-partial)',
    ...orgSlots.map((slot) => `args+=(--org ${bashQuote(`${slot.key}=`)}"$${slot.slot}")`),
    ...input.variables.map(
      (variable) => `args+=(--var-env ${bashQuote(`${variable.name}=${variable.env}`)})`,
    ),
    ...answeredAhead(input, '#', (flag, value) => `args+=(${flag} ${bashQuote(value)})`),
    '',
    'say "start"',
    `npx -y ${bashQuote(`sandforge@${input.sandforgeVersion}`)} "\${args[@]}" >>"$log" 2>&1`,
    'code=$?',
    'say "exit $code"',
    'exit "$code"',
    '',
  );
  return {
    runner: 'cron',
    fileName,
    text: lines.join('\n'),
    ...(schedule !== undefined
      ? {
          schedule:
            schedule.kind === 'line'
              ? { ...schedule, text: `${schedule.text} /bin/bash /path/to/${fileName}` }
              : schedule,
        }
      : {}),
  };
}

/** The `New-ScheduledTaskTrigger` lines a line of cron is, or why a person creates the task. */
function taskTriggers(cron: string): string[] | string {
  const fields = readCron(cron);
  if ('refused' in fields) return fields.reason;
  if (fields.daysOfMonth !== '*' || fields.months !== '*') {
    return 'It names days of the month or months, which a daily or weekly trigger does not: create the task in Task Scheduler by hand.';
  }
  const times = fields.hours.flatMap((hour) =>
    fields.minutes.map(
      (minute) => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    ),
  );
  if (times.length > MAX_TASK_TRIGGERS) {
    return (
      `It starts ${times.length} times a day; a task of that many daily triggers is better made ` +
      'with a repetition: create the task in Task Scheduler by hand.'
    );
  }
  const days =
    fields.daysOfWeek === '*'
      ? undefined
      : fields.daysOfWeek.map((day) => WEEK_DAYS[day]).join(',');
  return times.map((time) =>
    days === undefined
      ? `New-ScheduledTaskTrigger -Daily -At ${pwshQuote(time)}`
      : `New-ScheduledTaskTrigger -Weekly -DaysOfWeek ${days} -At ${pwshQuote(time)}`,
  );
}

/** The PowerShell launcher, and the Task Scheduler registration that starts it. */
export function pwshLauncher(raw: LauncherInput): PipelineLauncher {
  const { input, leftOut } = fitted(raw);
  const base = baseNameOf(input.fileName);
  const fileName = `${base}.ps1`;
  const folder = pipelineFolderName(input.pipelineId);
  let schedule: PipelineLauncherSchedule | undefined;
  if (input.schedule !== null) {
    const converted = scheduleOf(
      convertCronZone(
        input.schedule.cron,
        input.schedule.timezone,
        input.machineTimezone,
        input.now,
      ),
    );
    if (converted.kind !== 'line') {
      schedule = converted;
    } else {
      const triggers = taskTriggers(converted.text);
      schedule =
        typeof triggers === 'string'
          ? { kind: 'manual', reason: triggers }
          : {
              ...converted,
              text: [
                `# In PowerShell, from the folder that holds ${fileName}, once:`,
                `$action = New-ScheduledTaskAction -Execute 'pwsh' -Argument ('-NoProfile -File "{0}"' -f (Join-Path $PWD ${pwshQuote(fileName)}))`,
                '$triggers = @(',
                ...triggers.map((trigger) => `  ${trigger}`),
                ')',
                `Register-ScheduledTask -TaskName ${pwshQuote(`SandForge ${base}`)} -Action $action -Trigger $triggers`,
              ].join('\n'),
            };
    }
  }
  const scheduleLines: string[] =
    schedule === undefined
      ? ['This pipeline has no schedule: run this script by hand, or from a scheduler of your own.']
      : schedule.kind === 'line'
        ? [
            `Its schedule, as Task Scheduler reads it, in ${schedule.timezone}:`,
            ...schedule.text.split('\n').map((line) => `  ${line}`),
            ...driftLines(schedule),
          ]
        : schedule.kind === 'manual'
          ? [
              `Its schedule, ${input.schedule?.cron} in ${input.schedule?.timezone}, as Task Scheduler reads it:`,
              oneLine(schedule.reason),
            ]
          : ["Its schedule cannot be written for this machine's clock:", oneLine(schedule.reason)];
  const needs = [
    `Keep it beside ${input.fileName}. It needs PowerShell 7 (pwsh), Node.js`,
    `${NODE_FLOOR.major}.${NODE_FLOOR.minor} or later and the Salesforce CLI (sf), signed in to each org of the`,
    "pipeline under its alias. Each run is appended to runs.log, in the pipeline's folder below.",
    '',
    ...scheduleLines,
    ...(leftOut.length > 0 ? ['', ...leftOut] : []),
  ];
  const orgSlots = unaliased(input);
  const lines: string[] = [
    ...header(input, needs).map((line) => (line === '' ? '#' : `# ${line}`)),
    "$ErrorActionPreference = 'Continue'",
    '',
    '$here = Split-Path -Parent $MyInvocation.MyCommand.Path',
    `$file = Join-Path $here ${pwshQuote(input.fileName)}`,
    "$journal = if ($env:SANDFORGE_JOURNAL_DIR) { $env:SANDFORGE_JOURNAL_DIR } else { Join-Path $HOME '.sandforge' }",
    `$store = Join-Path (Join-Path $journal 'pipelines') ${pwshQuote(folder)}`,
    'New-Item -ItemType Directory -Force -Path $store | Out-Null',
    "$log = Join-Path $store 'runs.log'",
    'function Say([string] $line) {',
    "  $stamped = '{0} {1}' -f ([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')), $line",
    '  Add-Content -Path $log -Value $stamped',
    '  [Console]::Error.WriteLine($stamped)',
    '}',
    '',
    '$node = Get-Command node -ErrorAction SilentlyContinue',
    '$nodeOk = $false',
    'if ($node) {',
    `  & node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > ${NODE_FLOOR.major} || (a === ${NODE_FLOOR.major} && b >= ${NODE_FLOOR.minor}) ? 0 : 1)'`,
    '  $nodeOk = ($LASTEXITCODE -eq 0)',
    '}',
    'if (-not $nodeOk) {',
    `  Say "Node.js ${NODE_FLOOR.major}.${NODE_FLOOR.minor} or later is not found on this PATH: nothing ran. Install it, or add its folder to PATH."`,
    '  exit 127',
    '}',
    'if (-not (Get-Command sf -ErrorAction SilentlyContinue)) {',
    '  Say "The Salesforce CLI (sf) is not found on this PATH: nothing ran. Install it (npm install -g @salesforce/cli), or add its folder to PATH."',
    '  exit 127',
    '}',
    '',
  ];
  if (orgSlots.length > 0 || input.variables.length > 0) {
    lines.push('# What the pipeline file does not hold, set here or in the environment.');
    for (const slot of orgSlots) {
      lines.push(
        `# The alias, on this machine, of org "${oneLine(slot.label)}", which has none of its own.`,
        `$${slot.slot} = $env:${slot.slot.toUpperCase()}`,
      );
    }
    lines.push('$missing = @()');
    for (const slot of orgSlots) {
      lines.push(
        `if (-not $${slot.slot}) { $missing += ${pwshQuote(`${slot.slot} (the alias of org "${oneLine(slot.label)}")`)} }`,
      );
    }
    for (const variable of input.variables) {
      lines.push(
        `if (-not $env:${variable.env}) { $missing += ${pwshQuote(
          `${variable.env} (variable "${oneLine(variable.name)}"${variable.secret ? ', a secret' : ''})`,
        )} }`,
      );
    }
    lines.push(
      'if ($missing.Count -gt 0) {',
      "  Say ('Not set, so nothing ran: {0}. Set each in this script or in the environment.' -f ($missing -join ', '))",
      '  exit 2',
      '}',
      '',
    );
  }
  lines.push(
    "$runArgs = @('pipeline', 'run', '--file', $file, '--triggered-by', 'schedule', '--fail-on-partial')",
    ...orgSlots.map(
      (slot) => `$runArgs += @('--org', (${pwshQuote(`${slot.key}={0}`)} -f $${slot.slot}))`,
    ),
    ...input.variables.map(
      (variable) => `$runArgs += @('--var-env', ${pwshQuote(`${variable.name}=${variable.env}`)})`,
    ),
    ...answeredAhead(input, '#', (flag, value) => `$runArgs += @('${flag}', ${pwshQuote(value)})`),
    '',
    "Say 'start'",
    `& npx -y ${pwshQuote(`sandforge@${input.sandforgeVersion}`)} @runArgs *>> $log`,
    '$code = $LASTEXITCODE',
    'Say "exit $code"',
    'exit $code',
    '',
  );
  return {
    runner: 'taskScheduler',
    fileName,
    text: lines.join('\n'),
    ...(schedule !== undefined ? { schedule } : {}),
  };
}

/** Whether a line starts more often than GitHub Actions starts a schedule. */
function tooOftenForGithub(cron: string): boolean {
  const fields = readCron(cron);
  if ('refused' in fields) return false;
  const minutes = fields.minutes;
  if (minutes.length === 1) return false;
  for (let index = 0; index < minutes.length; index += 1) {
    const next = index + 1 < minutes.length ? minutes[index + 1] : minutes[0] + 60;
    if (next - minutes[index] < GITHUB_MIN_INTERVAL_MINUTES) return true;
  }
  return false;
}

/** The GitHub Actions workflow: on the pipeline's schedule, in its own zone, and by hand. */
export function githubActionsWorkflow(raw: LauncherInput): PipelineLauncher {
  const { input, leftOut } = fitted(raw);
  const base = baseNameOf(input.fileName);
  const fileName = `${base}.yml`;
  const folder = pipelineFolderName(input.pipelineId);
  // Read in the pipeline's own zone: a line of the same zone is the line,
  // written in the five fields GitHub reads.
  const schedule =
    input.schedule === null
      ? undefined
      : scheduleOf(
          convertCronZone(
            input.schedule.cron,
            input.schedule.timezone,
            input.schedule.timezone,
            input.now,
          ),
        );
  const orgs = input.orgs.map((org, index) => {
    const alias = org.alias ?? `pipeline-org-${index + 1}`;
    return { ...org, ciAlias: alias, secret: authSecretOf(alias) };
  });
  const comment = (line: string): string => (line === '' ? '#' : `# ${line}`);
  const lines: string[] = [
    ...header(input, [
      `Save it as .github/workflows/${fileName} of a private repository, and commit`,
      `${input.fileName} at the repository's root. Each org signs in from a repository secret:`,
      ...orgs.map(
        (org) =>
          `  ${org.secret}: the sfdx auth URL of "${oneLine(org.label)}" (sf org display --verbose)`,
      ),
      ...input.variables.map(
        (variable) =>
          `  ${variable.env}: variable "${oneLine(variable.name)}"${variable.secret ? ' (a secret)' : ''}`,
      ),
      '',
      'GitHub starts a schedule late when its runners are busy, the start of each hour most of',
      'all, and may drop it under heavy load; it disables the schedules of a public repository',
      'after 60 days without activity (docs.github.com, "Events that trigger workflows").',
      ...(schedule?.kind === 'refused'
        ? ['', "The pipeline's schedule cannot be written for GitHub:", oneLine(schedule.reason)]
        : []),
      ...(schedule?.kind === 'line' && tooOftenForGithub(schedule.text)
        ? [
            '',
            `GitHub starts a schedule every ${GITHUB_MIN_INTERVAL_MINUTES} minutes at most, whatever its line says.`,
          ]
        : []),
      ...(leftOut.length > 0 ? ['', ...leftOut] : []),
    ]).map(comment),
    `name: ${yamlQuote(`SandForge pipeline: ${oneLine(input.pipelineName)}`)}`,
    '',
    'on:',
  ];
  if (schedule?.kind === 'line') {
    lines.push(
      '  schedule:',
      `    - cron: ${yamlQuote(schedule.text)}`,
      `      timezone: ${yamlQuote(schedule.timezone)}`,
    );
  }
  lines.push(
    '  workflow_dispatch:',
    '',
    '# One run of the pipeline at a time: a run lock keeps one machine to one run, not two jobs.',
    'concurrency:',
    `  group: ${yamlQuote(`sandforge-pipeline-${folder}`)}`,
    '  cancel-in-progress: false',
    '',
    'permissions:',
    '  contents: read',
    '',
    'jobs:',
    '  run:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: actions/setup-node@v4',
    '        with:',
    '          node-version: 22',
    '      - name: Install the Salesforce CLI',
    '        run: npm install -g @salesforce/cli',
  );
  if (orgs.length > 0) {
    lines.push(
      "      - name: Sign in to the pipeline's orgs",
      '        env:',
      ...orgs.map((org) => `          ${org.secret}: \${{ secrets.${org.secret} }}`),
      '        # The URLs go to a private folder removed when this shell exits, a failed sign-in too.',
      '        run: |',
      '          umask 077',
      '          auth_dir=$(mktemp -d)',
      `          trap 'rm -rf "$auth_dir"' EXIT`,
      ...orgs.flatMap((org, index) => [
        `          printf '%s' "$${org.secret}" > "$auth_dir/org-${index + 1}.txt"`,
        `          sf org login sfdxurl --sfdx-url-file "$auth_dir/org-${index + 1}.txt" --alias ${bashQuote(org.ciAlias)}`,
      ]),
    );
  }
  lines.push(
    '      # The Sync watermarks, the confirmations and the history of earlier runs.',
    '      - uses: actions/cache@v4',
    '        with:',
    '          path: .sandforge',
    `          key: ${yamlQuote(`sandforge-pipeline-${folder}-\${{ github.run_id }}`)}`,
    `          restore-keys: ${yamlQuote(`sandforge-pipeline-${folder}-`)}`,
  );
  if (input.rewinds.length > 0) {
    lines.push(
      '      # A Rewind step rewinds to a checkpoint kept on the machine of the run: import it',
      '      # here first (sandforge checkpoint import), from a file you keep apart, with its key.',
      '      # - name: Import the checkpoint a Rewind step names',
      `      #   run: npx -y sandforge@${input.sandforgeVersion} checkpoint import --file <checkpoint file>`,
    );
  }
  const run = [
    `args=(pipeline run --file ${bashQuote(input.fileName)} --triggered-by "$TRIGGERED_BY" --fail-on-partial)`,
    ...orgs
      .filter((org) => org.alias === undefined)
      .map((org) => `args+=(--org ${bashQuote(`${org.key}=${org.ciAlias}`)})`),
    ...input.variables.map(
      (variable) => `args+=(--var-env ${bashQuote(`${variable.name}=${variable.env}`)})`,
    ),
    ...answeredAhead(input, '#', (flag, value) => `args+=(${flag} ${bashQuote(value)})`),
    `npx -y ${bashQuote(`sandforge@${input.sandforgeVersion}`)} "\${args[@]}"`,
  ];
  lines.push(
    '      - name: Run the pipeline',
    '        env:',
    '          SANDFORGE_JOURNAL_DIR: ${{ github.workspace }}/.sandforge',
    "          TRIGGERED_BY: ${{ github.event_name == 'schedule' && 'schedule' || 'manual' }}",
    ...input.variables.map(
      (variable) => `          ${variable.env}: \${{ secrets.${variable.env} }}`,
    ),
    '        run: |',
    ...run.map((line) => `          ${line}`),
    '',
  );
  return {
    runner: 'githubActions',
    fileName,
    text: lines.join('\n'),
    ...(schedule !== undefined ? { schedule } : {}),
  };
}

/** The three launchers of an export, by what starts each. */
export function pipelineLaunchers(
  input: LauncherInput,
): Record<PipelineOutsideRunner, PipelineLauncher> {
  return {
    cron: bashLauncher(input),
    taskScheduler: pwshLauncher(input),
    githubActions: githubActionsWorkflow(input),
  };
}
