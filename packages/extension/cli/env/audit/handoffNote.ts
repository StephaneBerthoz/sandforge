/**
 * The handoff note an apply writes once it ended: what it did to the org, in
 * Markdown, for whoever takes the sandbox from there — the testers, the admin
 * who points its endpoints away from production — and what is left to do, in
 * the order a refresh's checklist does it.
 *
 * It is made from what this machine holds, and reads nothing of the org: the
 * apply's answer, the audits it read once it wrote, and, when given, what
 * `output` reads back of the state. It names resources, objects, fields,
 * counts, ids, users by their usernames, jobs by their names and endpoints by
 * their hosts — never a value of a record, never a URL, never a word a script
 * or the org said: those may quote what a record holds. A note names
 * usernames: kept as a CI artifact, it is kept a short time, and never
 * committed.
 *
 * ```
 * <journal>/handoff/                         0700
 *   <env>/<instant>-<organizationId>.md      0600
 * ```
 */

import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  usersApplyAnswerSchema,
  type EnvMaskingSet,
  type EnvOutput,
  type EnvResource,
  type EnvRunResult,
  type EnvStepResult,
  type UsersAppliedUser,
  type UsersChange,
} from '@sandforge/shared';
import { organizationKey } from '../../../src/modules/checkpoint/OrgCheckpointStore.js';
import { commandOf } from '../../invocation.js';
import type { AuditOrgInput } from './auditVerb.js';
import { sandboxMyDomainOf } from '../envTargetHost.js';
import { ENDPOINT_SOURCE_WORDS, ENDPOINT_WHY_WORDS } from './endpointsAudit.js';

/** What a folder of the notes is made with: its owner alone lists them. */
export const HANDOFF_DIR_MODE = 0o700;

/** What a note is written with: its owner alone reads it. */
export const HANDOFF_FILE_MODE = 0o600;

/** How long the link Salesforce sends to an address asked back is said to stay good. */
export const ADDRESS_LINK_HOURS = 72;

/** What the note is made of. */
export interface HandoffInput {
  /** The apply's answer, its audits with it when it read them. */
  run: EnvRunResult;
  org: AuditOrgInput;
  /** The file as the line named it, for the line that resets the org. */
  file: string;
  /** When the apply ended. */
  at: string;
  sandforgeVersion: string;
  /** What `output` reads back of the state: what each mask resource masked, and its snapshot. */
  output?: EnvOutput;
  /** The file's resources: a mask's rules, a replay's owners. */
  resources?: Readonly<Record<string, EnvResource>>;
  /** The file's sets of masking rules, which a mask resource names. */
  masking?: Readonly<Record<string, EnvMaskingSet>>;
}

/** A name the note gives, on one line, as code: nothing in it closes the span or breaks the line. */
function code(name: string): string {
  return `\`${name.replace(/[`\r\n]+/g, ' ').trim()}\``;
}

/** Words on one line: nothing in them breaks the note's structure. */
function plain(words: string): string {
  return words.replace(/[\r\n]+/g, ' ').trim();
}

/** An instant to the second. */
function secondOf(instant: string): string {
  return instant.replace(/\.\d{3}Z$/, 'Z');
}

/** Counts by object, in words: `Account 40, Contact 120`. */
function countsOf(counts: ReadonlyArray<[string, number]>): string {
  return counts.map(([object, count]) => `${object} ${count}`).join(', ');
}

/** A change to a user, in words: never a value beyond the names the file gives. */
function changeWords(change: UsersChange): string {
  switch (change.what) {
    case 'email':
      return 'address asked back, awaiting its owner';
    case 'active':
      return change.to ? 'activated' : 'deactivated';
    case 'frozen':
      return change.to ? 'frozen' : 'unfrozen';
    case 'profile':
      return `profile ${code(change.to)}`;
    case 'permissionSet':
      return `${change.to === 'added' ? 'permission set' : 'permission set taken off:'} ${code(change.name)}`;
    case 'permissionSetGroup':
      return `${change.to === 'added' ? 'permission set group' : 'permission set group taken off:'} ${code(change.name)}`;
    case 'group': {
      const what = change.type === 'Queue' ? 'queue' : 'public group';
      return `${change.to === 'added' ? what : `${what} taken off:`} ${code(change.name)}`;
    }
  }
}

/** The users a users step set up, from its script's answer; undefined when it does not read. */
function usersOf(step: EnvStepResult): UsersAppliedUser[] | undefined {
  const parsed = usersApplyAnswerSchema.safeParse(step.answer);
  return parsed.success ? parsed.data.users : undefined;
}

/** The last run step of a resource: what the apply did to it. */
function runStepOf(run: EnvRunResult, resource: string): EnvStepResult | undefined {
  return run.steps.filter((step) => step.resource === resource && step.phase === 'run').at(-1);
}

/** How a step left its resource, in words. */
function statusWords(step: EnvStepResult): string {
  switch (step.status) {
    case 'applied':
      return 'applied';
    case 'partial':
      return 'applied in part';
    case 'failed':
      return 'failed';
    default:
      return 'stopped part way';
  }
}

/** The Access section: per user, what was done; the addresses awaiting their owner apart. */
function accessLines(input: HandoffInput): string[] {
  const lines: string[] = ['## Access', ''];
  const awaiting: string[] = [];
  const due = new Date(Date.parse(input.at) + ADDRESS_LINK_HOURS * 3_600_000).toISOString();
  const actions = input.run.plan.actions.filter((action) => action.kind === 'users');
  if (actions.length === 0) {
    lines.push('- No users resource: SandForge set up no user.');
  }
  for (const action of actions) {
    const step = runStepOf(input.run, action.resource);
    if (step === undefined) {
      lines.push(
        `- ${code(action.resource)}: ${action.action === 'keep' ? 'kept, as the last apply left its users' : 'not run'}.`,
      );
      continue;
    }
    const users = usersOf(step);
    if (users === undefined) {
      lines.push(
        `- ${code(action.resource)}: ${statusWords(step)}; what it did to each user does not read ` +
          `from its answer: ${commandOf('env')} output names its users.`,
      );
      continue;
    }
    for (const user of users) {
      const done = user.done.map(changeWords);
      const refused = (user.refused ?? []).map(
        (one) => `${changeWords(one.change)} refused (${one.code})`,
      );
      const words = [...done, ...refused];
      lines.push(
        `- ${code(user.username)}: ${words.length > 0 ? words.join('; ') : 'as the file says already'}.`,
      );
      if (user.address === 'awaiting') awaiting.push(user.username);
    }
  }
  if (awaiting.length > 0) {
    lines.push('', '### Addresses awaiting their owner', '');
    for (const username of awaiting) {
      lines.push(
        `- ${code(username)}: the address stays under \`.invalid\` until its owner follows the link ` +
          `Salesforce sent to it, by about ${secondOf(due)} (${ADDRESS_LINK_HOURS} hours).`,
      );
    }
  }
  lines.push(
    '',
    'SandForge resets no password: a user without one sets it by **Forgot your password?** on ' +
      "the sandbox's login page, once the address is theirs again.",
  );
  return lines;
}

/** The fields a mask resource's rules mask, as the file names them; undefined when it names a template. */
function maskedFieldsOf(input: HandoffInput, resource: string): string | undefined {
  const declared = input.resources?.[resource];
  if (declared?.kind !== 'mask') return undefined;
  if (typeof declared.rules !== 'string')
    return `the rules of the template ${code(declared.rules.template)}`;
  const set = input.masking?.[declared.rules];
  if (set === undefined) return undefined;
  const fields = [...new Set(set.rules.map((rule) => rule.fieldPattern))];
  return fields.length > 0 ? fields.map(code).join(', ') : undefined;
}

/** The Data section: what each resource wrote, by counts, and the starting point to reset to. */
function dataLines(input: HandoffInput): string[] {
  const lines: string[] = ['## Data', ''];
  const actions = input.run.plan.actions.filter((action) => action.kind !== 'users');
  if (actions.length === 0) lines.push('- No data resource.');
  for (const action of actions) {
    const name = `${code(action.resource)} (${action.kind})`;
    const step = runStepOf(input.run, action.resource);
    if (step === undefined) {
      const skipped = input.run.skipped?.some((one) => one.resource === action.resource) === true;
      lines.push(
        `- ${name}: ` +
          (action.action === 'keep'
            ? 'kept, as applied before'
            : action.action === 'blocked'
              ? 'not applied: refused before it wrote'
              : skipped
                ? 'not run: a resource it depends on did not end whole'
                : 'not run'),
      );
      continue;
    }
    const parts: string[] = [statusWords(step)];
    if (action.kind === 'mask') {
      const output = input.output?.resources[action.resource];
      const masked: Array<[string, number]> = output?.masked
        ? Object.entries(output.masked)
        : step.objects.flatMap((one): Array<[string, number]> =>
            one.masked !== undefined ? [[one.object, one.masked]] : [],
          );
      if (masked.length > 0) parts.push(`masked ${countsOf(masked)}`);
      const fields = maskedFieldsOf(input, action.resource);
      if (fields !== undefined) parts.push(`fields ${fields}`);
      if (output?.snapshotId !== undefined) {
        parts.push(`snapshot ${code(output.snapshotId)}, taken first`);
      }
    } else {
      const created = step.objects.filter((one) => one.created > 0);
      if (created.length > 0) {
        parts.push(`created ${countsOf(created.map((one) => [one.object, one.created]))}`);
      }
      const refused = step.objects.filter((one) => one.refused > 0);
      if (refused.length > 0) {
        parts.push(`refused ${countsOf(refused.map((one) => [one.object, one.refused]))}`);
      }
      const declared = input.resources?.[action.resource];
      if (declared?.kind === 'replay' && declared.owners !== undefined) {
        parts.push(
          declared.owners === 'same'
            ? 'owners kept as the checkpoint names them'
            : 'owned by the user the apply connected as',
        );
      }
    }
    lines.push(`- ${name}: ${parts.join('; ')}.`);
  }
  const after = input.run.checkpoints?.find((one) => one.step === 'after');
  const planned = input.run.plan.checkpoints?.find((one) => one.step === 'after');
  if (after !== undefined || planned !== undefined) {
    lines.push('', '### Starting point', '');
    const org = input.org.alias ?? input.org.organizationId;
    if (after?.checkpoint !== undefined) {
      const records =
        planned?.estimate !== undefined ? `, about ${planned.estimate.records} records` : '';
      lines.push(
        `- Checkpoint ${planned !== undefined ? `${code(planned.name)} ` : ''}` +
          `${code(after.checkpoint)}${records}: the org as the testers get it.`,
        `- Back to it between two test runs: \`${commandOf('env')} reset --file ${input.file} --org ${org}\``,
      );
    } else {
      lines.push(
        `- The checkpoint ${planned !== undefined ? `${code(planned.name)} ` : ''}was not taken` +
          `${after !== undefined ? ` (exit ${after.exitCode})` : ''}: no reset returns to this apply's end.`,
      );
    }
  }
  return lines;
}

/** The line that reads an audit the apply did not. */
function auditLine(input: HandoffInput): string {
  const org = input.org.alias ?? input.org.organizationId;
  return `\`${commandOf('env')} audit --file ${input.file} --org ${org}\``;
}

/** The section of what is left, in the order a refresh's checklist takes it. */
function toDoLines(input: HandoffInput): string[] {
  const audits = input.run.audits;
  const lines: string[] = ['## Still to do, in this order', ''];

  lines.push('1. Credentials and technical components: point them away from production.');
  const endpoints = audits?.endpoints;
  if (endpoints === undefined) {
    lines.push(`   - Not audited: ${auditLine(input)} lists those that still name production.`);
  } else {
    for (const one of endpoints.found) {
      lines.push(
        `   - ${ENDPOINT_SOURCE_WORDS[one.source]} ${code(one.name)} names ${code(one.host)}, ${ENDPOINT_WHY_WORDS[one.why]}.`,
      );
    }
    if (endpoints.found.length === 0 && endpoints.unread === undefined) {
      lines.push('   - None of those read names production.');
    }
    if (endpoints.unread !== undefined) {
      lines.push(
        '   - Not all read: check the Named Credentials, the Remote Site Settings and the ' +
          'Custom Metadata in Setup.',
      );
    }
  }

  lines.push(
    '2. Scheduled jobs: schedule again those gone, and give those stuck a user who can run them.',
  );
  const schedules = audits?.schedules;
  if (schedules === undefined) {
    lines.push(`   - Not audited: ${auditLine(input)} compares them with their inventory.`);
  } else {
    for (const job of schedules.jobs) {
      if (job.status === 'gone') {
        lines.push(
          `   - ${code(job.name)} (${plain(job.type)}) was scheduled in the inventory of ` +
            `${schedules.against?.savedAt.slice(0, 10) ?? '?'}, and is not now.`,
        );
      } else if (job.status === 'frozen' || job.status === 'inactive') {
        lines.push(
          `   - ${code(job.name)} (${plain(job.type)}) runs as ${job.owner !== undefined ? code(job.owner) : 'a user not read'}, ` +
            `who is ${job.status}: its next run fails.`,
        );
      }
    }
    if (schedules.against === undefined) {
      lines.push(
        '   - No inventory from before the refresh was kept on this machine: what is gone is not ' +
          'known.',
      );
    }
    if (schedules.unread !== undefined)
      lines.push('   - Not all read: Setup > Scheduled Jobs lists them.');
    if (!schedules.jobs.some((job) => job.status !== 'new') && schedules.unread === undefined) {
      lines.push(
        schedules.against !== undefined ? '   - None gone, none stuck.' : '   - None stuck.',
      );
    }
  }

  lines.push(
    '3. Automations that send emails — flows, workflow rules, Apex —: turn them on last, once the ' +
      'addresses and the masking are as the testers need them.',
  );

  lines.push('4. Deliverability.');
  const deliverability = audits?.deliverability;
  if (deliverability?.read === 'closed') {
    lines.push(
      '   - Read closed, System email only or No access: leave it so until the masking is done.',
    );
  } else if (deliverability?.read === 'open') {
    lines.push(
      '   - Read open, All email: what runs there emails whoever its records name. Set it to ' +
        'System email only in Setup > Deliverability until the masking is done.',
    );
  } else {
    lines.push('   - Not read: Setup > Deliverability shows it.');
  }
  return lines;
}

/** What SandForge leaves to others, each with whose it is. */
const NOT_TOUCHED: readonly string[] = [
  '- Named and External Credentials: Setup, or a deployment of your project by `sf`.',
  '- Metadata: your deployment.',
  '- Single sign-on and DKIM keys: Setup.',
  '- Deliverability: Setup > Deliverability.',
  "- Passwords: each user's own, by Forgot your password? on the sandbox's login page.",
];

/**
 * The note, in Markdown: the environment, the access, the data, what is
 * left to do and what SandForge does not touch.
 */
export function handoffNoteOf(input: HandoffInput): string {
  const { run, org } = input;
  const myDomain = sandboxMyDomainOf(org.host);
  const kind =
    org.kind === 'sandbox'
      ? `sandbox${myDomain !== undefined ? ` ${code(myDomain)}` : ''}`
      : org.kind === 'scratch'
        ? 'scratch org'
        : 'Developer Edition org';
  const lines: string[] = [
    `# Handoff: ${code(run.plan.env)} on ${code(org.alias ?? org.organizationId)}`,
    '',
    '## Environment',
    '',
    `- Environment: ${code(run.plan.env)}, state serial ${run.state.serial}.`,
    `- Org: ${org.alias !== undefined ? `${code(org.alias)}, ` : ''}${kind}, ${code(org.organizationId)}.`,
    `- Applied: ${secondOf(input.at)}, by SandForge ${input.sandforgeVersion}; it ended ${run.status}.`,
    '',
    ...accessLines(input),
    '',
    ...dataLines(input),
    '',
    ...toDoLines(input),
    '',
    '## Not touched by SandForge',
    '',
    ...NOT_TOUCHED,
  ];
  return `${lines.join('\n')}\n`;
}

/** Where an apply's note is kept by default, in the journal directory. */
export function handoffPathOf(
  journalDir: string,
  input: { env: string; organizationId: string; at: string },
): string {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(input.env))
    throw new Error(`Not an environment's name: "${input.env}"`);
  const stamp = new Date(input.at).toISOString().replace(/[-:.]/g, '');
  return join(
    resolve(journalDir),
    'handoff',
    input.env,
    `${stamp}-${organizationKey(input.organizationId)}.md`,
  );
}

/**
 * Write a note whole: into a file of its own beside it, its owner's alone,
 * flushed to the disk, then renamed into place. Its folder is made its
 * owner's alone when new.
 */
export async function writeHandoffNote(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: HANDOFF_DIR_MODE });
  const temp = `${path}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  const handle = await open(temp, 'wx', HANDOFF_FILE_MODE);
  try {
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (err: unknown) {
    await rm(temp, { force: true });
    throw err;
  }
}
