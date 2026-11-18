/**
 * Doc/code drift guard for the Back into service page.
 *
 * The page is read after a refresh by someone about to hand a sandbox to its
 * testers, and three of its promises are about what is never done: a
 * production org is refused before anything of it is read, an acceptance of
 * the emails Salesforce sends to people is never kept for the next run, and
 * an address asked back is never said to be restored. Each is held here to
 * the code that keeps it, with the ten steps, their order and the words on
 * their buttons, where the handoff note is written, and what a terminal does
 * in their place.
 *
 * Each test states the code it depends on first, and fails there if that
 * code moved: an assertion about a page that no longer works this way proves
 * nothing.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { TOOLS } from '../../packages/extension/cli/sandforge.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

// Normalised: the section split below is LF-anchored and misses on a CRLF checkout.
const DOC = readFileSync(resolve(HERE, 'recovery.md'), 'utf8').replace(/\r\n/g, '\n');

function source(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8').replace(/\r\n/g, '\n');
}

const PAGE_DIR = 'packages/webview/src/pages/Recovery';
const SCHEMA = source('packages/shared/src/schemas/recovery.schema.ts');
const USERS_SCHEMA = source('packages/shared/src/schemas/users.schema.ts');
const STATUS = source('packages/extension/src/modules/recovery/recoveryStatus.ts');
const FACTS = source('packages/extension/src/modules/recovery/recoveryFacts.ts');
const HANDOFF = source('packages/extension/src/modules/recovery/recoveryHandoff.ts');
const RECOVERY_USERS = source('packages/extension/src/modules/recovery/recoveryUsers.ts');
const HANDOFF_SECTIONS = source('packages/extension/src/modules/audit/handoffSections.ts');
const USERS_GATES = source('packages/extension/src/modules/users/usersGates.ts');
const USERS_RUN_STORE = source('packages/extension/src/modules/users/usersRunStore.ts');
const LOAD_GUARDS = source('packages/extension/src/modules/frozendataset/LoadGuards.ts');
const FROZEN_HANDLER = source('packages/extension/src/bridge/handlers/FrozenDatasetHandler.ts');
const HANDLER = source('packages/extension/src/bridge/handlers/RecoveryHandler.ts');
const USERS_CLI = source('packages/extension/cli/sandforge-users.ts');
const ENV_CLI = source('packages/extension/cli/sandforge-env.ts');
const CHECKPOINT_CLI = source('packages/extension/cli/sandforge-checkpoint.ts');
const RECOVERY_PAGE = source(`${PAGE_DIR}/RecoveryPage.tsx`);
const SANDBOX_RECOVERY = source(`${PAGE_DIR}/SandboxRecovery.tsx`);
const STEP_ROW = source(`${PAGE_DIR}/RecoveryStepRow.tsx`);
const USERS_PANEL = source(`${PAGE_DIR}/RecoveryUsers.tsx`);
const MONITOR_BAND = source('packages/webview/src/pages/Monitor/RefreshRecovery.tsx');
const ENVIRONMENTS = source('docs/environments.md');
const NLS = JSON.parse(source('packages/extension/package.nls.json')) as Record<string, string>;
const EN = JSON.parse(source('packages/webview/src/i18n/locales/en.json')) as Record<
  string,
  unknown
>;

/** A dotted key of the English catalogue, which must exist. */
function label(key: string): string {
  const value = key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      EN,
    );
  if (typeof value !== 'string') throw new Error(`en.json has no ${key}: re-point this test`);
  return value;
}

/** A label as the page writes it: the org it names becomes `\<alias\>`, as Markdown escapes it. */
function asWritten(text: string): string {
  return text.replace('{{alias}}', '\\<alias\\>');
}

/** The ids an `export const NAME = [ … ] as const` lists, in its order. */
function idsOf(text: string, name: string): string[] {
  const match = new RegExp(`export const ${name} = \\[([^\\]]*)\\]`).exec(text);
  if (!match?.[1]) throw new Error(`${name} is gone: re-point this test`);
  return [...match[1].matchAll(/'([a-zA-Z]+)'/g)].map((id) => id[1] ?? '');
}

/** The body of the `## heading` section, up to the next heading of level two. */
function section(heading: string): string {
  const start = DOC.indexOf(`\n## ${heading}\n`);
  if (start === -1) throw new Error(`recovery.md has no section "${heading}"`);
  const body = DOC.slice(start + heading.length + 5);
  const end = body.search(/\n## /);
  return end === -1 ? body : body.slice(0, end);
}

/** A section's prose with its line breaks folded, so a claim can span a wrap. */
function prose(heading: string): string {
  return section(heading).replace(/\s+/g, ' ');
}

/** The numbered steps of "The steps", by number: the name in bold, then the line. */
function docSteps(): Array<{ name: string; line: string }> {
  return [...section('The steps').matchAll(/^(\d+)\. \*\*([^*]+)\*\*: (.*)$/gm)].map((step) => ({
    name: step[2] ?? '',
    line: step[3] ?? '',
  }));
}

const STEP_IDS = idsOf(SCHEMA, 'RECOVERY_STEP_IDS');

/** The line of a step, by its id. */
function stepLine(id: string): string {
  const line = docSteps()[STEP_IDS.indexOf(id)]?.line;
  if (line === undefined) throw new Error(`recovery.md lists no step ${id}`);
  return line;
}

/** The body of `function name(` in `text`, up to the next top-level function. */
function functionBody(text: string, name: string): string {
  const start = text.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} is gone: re-point this test`);
  const rest = text.slice(start);
  const end = rest.slice(1).search(/\n(?:export )?(?:async )?function /);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

/** The body of the class method `name` in `text`, up to its closing brace. */
function methodBody(text: string, name: string): string {
  const start = text.search(new RegExp(`\\n {2}private (?:async )?${name}\\(`));
  if (start === -1) throw new Error(`${name} is gone: re-point this test`);
  const end = text.indexOf('\n  }\n', start);
  return text.slice(start, end === -1 ? undefined : end);
}

describe('docs/modules/recovery.md', () => {
  it('lists the ten steps in the order the page shows them, by the names the page gives them', () => {
    // The page draws each step's name from `recovery.step.<id>`, in the order
    // the extension deduces them, which is that of RECOVERY_STEP_IDS.
    expect(STEP_ROW).toContain('t(`recovery.step.${step.id}`)');
    expect(STEP_IDS).toHaveLength(10);
    const deduced = functionBody(STATUS, 'stepsOf');
    const order = STEP_IDS.map((id) => deduced.indexOf(`'${id}'`));
    expect(order.every((at) => at !== -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    expect(docSteps().map((step) => step.name)).toEqual(
      STEP_IDS.map((id) => label(`recovery.step.${id}`)),
    );
  });

  it('says every step but the first can be skipped, and the two checks by eye alone marked done', () => {
    expect(idsOf(SCHEMA, 'RECOVERY_SKIPPABLE_STEPS')).toEqual(
      STEP_IDS.filter((id) => id !== 'refresh'),
    );
    const markable = idsOf(SCHEMA, 'RECOVERY_MARKABLE_STEPS');
    expect(markable).toEqual(['deliverability', 'endpoints']);

    const steps = prose('The steps');
    expect(steps).toContain(
      `**${label('recovery.skip')}** sets a step aside, every step but the first`,
    );
    expect(steps).toContain(`**${label('recovery.undo')}** takes a skip or a mark back`);
    expect(stepLine('refresh')).toContain('It is never skipped.');
    const markDone = `**${label('recovery.markDone')}**`;
    for (const id of STEP_IDS) {
      expect({ id, offersMarkDone: stepLine(id).includes(markDone) }).toEqual({
        id,
        offersMarkDone: markable.includes(id),
      });
    }
  });

  it('keeps a skip and a mark for the refresh they were made after, and no other', () => {
    expect(SCHEMA).toContain('return `recovery:${entryId}:${before}`;');
    expect(FACTS).toContain('refreshKeyOf(refresh, organizationIdOf)');
    expect(prose('The steps')).toContain(
      'A skip and a mark are kept for this refresh alone: after the next one, every step starts again.',
    );
  });

  it('names Help among the ways to the page, by its section and its button', () => {
    // Help leads with After a sandbox refresh, whose button opens the page,
    // and the list of the ways there left it out.
    const help = source('packages/webview/src/pages/Help/HelpPage.tsx');
    expect(help).toMatch(/id: 'recovery',\s+titleKey: 'help\.afterRefresh',/);
    expect(help).toContain("t('help.openModule', { module: t(`nav.${page}`) })");
    const button = label('help.openModule').replace('{{module}}', label('nav.recovery'));
    expect(prose('When it opens')).toContain(
      `on **${label('nav.help')}**, the section **${label('help.afterRefresh')}**, by **${button}**`,
    );
  });

  it('names the page, its title and its palette command as the extension does', () => {
    expect(DOC.startsWith(`# ${label('nav.recovery')}\n`)).toBe(true);
    expect(DOC).toContain(`**${asWritten(label('recovery.title'))}**`);
    const command = NLS['command.openRecovery'];
    expect(command).toBe('SandForge: Back into service');
    expect(DOC).toContain(`**${command}** in the VS Code command palette`);
  });

  it('names each button as the page writes it, and each is on the page', () => {
    const pageSources = [
      RECOVERY_PAGE,
      SANDBOX_RECOVERY,
      STEP_ROW,
      USERS_PANEL,
      source(`${PAGE_DIR}/RecoveryAudit.tsx`),
    ].join('\n');
    const keys = [
      'recovery.action.showUsers',
      'recovery.action.openMasking',
      'recovery.action.openReplay',
      'recovery.action.openLoad',
      'recovery.action.takeTesters',
      'recovery.action.read',
      'recovery.action.keepInventory',
      'recovery.action.writeNote',
      'recovery.action.writeNoteAgain',
      'recovery.action.openNote',
      'recovery.action.openSetup',
      'recovery.users.simulate',
      'recovery.users.apply',
      'recovery.users.save',
      'recovery.users.export',
      'recovery.users.import',
      'recovery.finish',
      'recovery.resume',
      'common.stopRun',
      'emptyState.connectOrg',
    ];
    for (const key of keys) {
      expect({ key, onThePage: pageSources.includes(`'${key}'`) }).toEqual({
        key,
        onThePage: true,
      });
      expect({ key, inTheDoc: DOC.includes(`**${label(key)}**`) }).toEqual({
        key,
        inTheDoc: true,
      });
    }
    // What to keep before the next refresh is listed by id, each with its button.
    const before = prose('Before the next refresh');
    for (const id of idsOf(SCHEMA, 'RECOVERY_PREPARATION_IDS')) {
      expect(before).toContain(`**${label(`recovery.before.${id}.action`)}**`);
    }
  });

  it('refuses a production org before reading it: by the list of orgs, then by the org itself', () => {
    // The page asks nothing of a production org; the extension refuses it by
    // the registry before it connects, then by the org's own answer.
    const pageCheck = RECOVERY_PAGE.indexOf('!isDevelopmentOrg(org)');
    expect(pageCheck).toBeGreaterThan(-1);
    expect(pageCheck).toBeLessThan(RECOVERY_PAGE.indexOf('<SandboxRecovery'));
    const registered = methodBody(HANDLER, 'registered');
    expect(registered).toContain('if (!isDevelopmentOrg(registered))');
    expect(registered).toContain("'NOT_A_DEVELOPMENT_ORG'");
    const reach = methodBody(HANDLER, 'reach');
    const byList = reach.indexOf('this.registered(entryId, step)');
    const connects = reach.indexOf('getJsforceConnection(');
    const byOrg = reach.indexOf('guardUsersOrg(');
    expect(byList).toBeGreaterThan(-1);
    expect(byList).toBeLessThan(connects);
    expect(connects).toBeLessThan(byOrg);
    // Production Guard is asked once the org is reached as a sandbox, never in its place.
    const apply = methodBody(HANDLER, 'handleUsersApply');
    expect(apply.indexOf('this.reach(')).toBeLessThan(apply.indexOf('this.consultGuard('));
    expect(label('recovery.error.NOT_A_DEVELOPMENT_ORG')).toContain('nothing of it was read');

    const never = prose('What it never does');
    expect(never).toContain('the extension refuses one before it reads anything of it');
    expect(never).toContain("by SandForge's list of orgs first");
    expect(never).toContain('then by what the org says it is, read live');
    expect(never).toContain('it is never what stops a production org here');
  });

  it('keeps no acceptance: the next run asks again', () => {
    // A simulation is asked with none, and what was ticked under it holds for
    // the run of that simulation alone.
    expect(USERS_PANEL).toMatch(
      /const NONE_ACCEPTED: UsersAcceptances = \{\s*acceptUserEmails: false,\s*acceptEmails: false,\s*acceptAutomation: false,\s*\};/,
    );
    expect(USERS_PANEL).toContain('plan.mutate({ orgId, config, ...NONE_ACCEPTED, ...replaces });');
    expect(USERS_PANEL).toContain(
      'simulation && accepted.plan === simulation.requestId ? accepted.values : NONE_ACCEPTED',
    );
    // What the page keeps — the list of the testers, the skips and marks —
    // and what a users.json holds carry no acceptance.
    expect(RECOVERY_USERS).toMatch(
      /savedTestersSchema = z\.strictObject\(\{\s*config: usersConfigSchema,\s*savedAt: z\.iso\.datetime\(\{ offset: true \}\),\s*\}\);/,
    );
    expect(USERS_SCHEMA).not.toMatch(/accept/i);
    const acks =
      /export const recoveryAcksSchema = z\s*\.strictObject\(\{([\s\S]*?)\n {2}\}\)/.exec(SCHEMA);
    expect(acks?.[1]).toBeDefined();
    expect(acks?.[1]).not.toMatch(/accept/i);
    for (const key of ['acceptUserEmails_other', 'acceptEmails_other', 'acceptAutomation']) {
      expect(label(`recovery.users.accept.${key}`)).toContain('for this run only');
    }

    expect(prose('What it never does')).toContain(
      'are accepted for that run only: the next run asks again',
    );
    expect(prose('The users')).toContain('it asks, for this run only, what the run needs');
  });

  it('says an address asked back awaits its owner, and never that it is restored', () => {
    const awaiting = label('recovery.users.address.awaiting');
    expect(awaiting).toBe('awaiting confirmation');
    expect(label('recovery.users.change.email')).toContain('awaiting');
    expect(label('recovery.users.change.email')).not.toMatch(/restored/i);
    expect(prose('The users')).toContain(`say _${awaiting}_`);
    expect(prose('What it never does')).toContain(`is _${awaiting}_ until its owner clicks`);
    // As the guide and the FAQ are held to it: an address is never said restored.
    expect(DOC.replace(/\s+/g, ' ')).not.toMatch(/address(?:es)? (?:is |are )?restored/);
  });

  it('holds the list and a run to the users a users resource holds', () => {
    const max = /export const USERS_MAX = (\d+);/.exec(USERS_SCHEMA)?.[1];
    expect(max).toBeDefined();
    expect(USERS_GATES).toContain('users: users.slice(0, USERS_MAX),');
    expect(USERS_PANEL).toContain(`export const USERS_PER_RUN = ${max};`);
    const users = prose('The users');
    expect(users).toContain(`The list holds ${max} users at most`);
    expect(users).toContain(`A run sets up ${max} users at most.`);
  });

  it('says where the users runs are kept, which the command line takes back', () => {
    expect(USERS_RUN_STORE).toContain("const USERS_FOLDER = 'users';");
    expect(USERS_RUN_STORE).toContain("join(homedir(), '.sandforge')");
    expect(USERS_CLI).toMatch(/const VERBS = \['plan', 'apply', 'remove'\] as const;/);
    expect(USERS_CLI).toContain('--config <file.json>');
    expect(USERS_CLI).toContain('--run <n>');
    expect(prose('The users')).toContain(
      'kept where the command line keeps them, `~/.sandforge/users/`: `sandforge users remove --org <alias> --run <n>` takes one back',
    );
    // A run taken back puts the step back to do.
    expect(STATUS).toContain('facts.lastUsersRunTakenBack !== true');
    expect(stepLine('users')).toContain(
      'it is to do again once `sandforge users remove` takes that run back',
    );
  });

  it('says where the handoff note is written, readable by its owner alone, apart from env apply’s', () => {
    expect(HANDOFF).toContain("export const RECOVERY_HANDOFF_FOLDER = '_recovery';");
    expect(HANDOFF).toContain("join(resolve(journalDir), 'handoff', RECOVERY_HANDOFF_FOLDER)");
    expect(HANDOFF).toContain("env['SANDFORGE_JOURNAL_DIR']");
    expect(HANDOFF).toContain("join(homedir(), '.sandforge')");
    expect(HANDOFF).toContain('export const RECOVERY_HANDOFF_DIR_MODE = 0o700;');
    expect(HANDOFF).toContain('export const RECOVERY_HANDOFF_FILE_MODE = 0o600;');
    expect(ENVIRONMENTS).toContain('kept in `handoff/<name>/` of the journal directory');

    const note = prose('The handoff note');
    expect(note).toContain('It is kept in `~/.sandforge/handoff/_recovery/`');
    expect(note).toContain('or `handoff/_recovery/` in the folder `SANDFORGE_JOURNAL_DIR` names');
    expect(note).toContain('readable by you alone');
    expect(note).toContain(
      '`sandforge env apply` writes its own notes beside it, in `handoff/<name>/`',
    );
  });

  it('resets no password, as the note itself says', () => {
    expect(HANDOFF_SECTIONS).toContain(
      "- Passwords: each user's own, by Forgot your password? on the sandbox's login page.",
    );
    expect(HANDOFF).toContain('...notTouchedLines(),');
    const never = prose('What it never does');
    expect(never).toContain('**Passwords.** SandForge resets none.');
    expect(never).toContain("**Forgot your password?** on the sandbox's login page sends one");
  });

  it('says the endpoints step reads no field, which sandforge env audit reads from a file', () => {
    // The page asks the endpoints against the hosts deduced alone, no field.
    expect(SANDBOX_RECOVERY).toContain(
      "endpoints: asked === 'endpoints' ? { productionHosts: [], fields: [] } : false,",
    );
    const line = stepLine('endpoints');
    expect(line).toContain('lists the Named Credentials and Remote Sites');
    expect(line).toContain(
      'The fields of Custom Metadata or Custom Settings, and the production hosts a file lists, are read by `sandforge env audit`',
    );
  });

  it('says which kinds of org have no data of production to mask', () => {
    const copied = functionBody(STATUS, 'nothingCopied');
    expect(copied).toContain("if (facts.kind !== 'sandbox') return true;");
    expect(copied).toContain(
      "facts.sandboxType === 'Developer' || facts.sandboxType === 'DeveloperPro'",
    );
    expect(stepLine('masking')).toContain(
      'It does not apply to a Developer or Developer Pro sandbox, a scratch org or a Developer Edition org',
    );
  });

  it('replays into a sandbox marked Staging once its name is typed, and loads no frozen dataset there', () => {
    expect(LOAD_GUARDS).toContain(
      "if (input.orgTier === 'staging' && input.stagingReplay === true) return;",
    );
    expect(LOAD_GUARDS).toMatch(
      /if \(input\.orgTier === 'staging'\) \{\s*throw new LoadGuardError/,
    );
    expect(FROZEN_HANDLER).toContain("'REPLAY_STAGING_UNCONFIRMED'");
    expect(SANDBOX_RECOVERY).toContain("t('recovery.line.replay.staging', { alias })");
    // The deduced steps never refuse the replay for the mark; the frozen
    // dataset step, whose load the mark refuses, is said refused instead.
    const steps = functionBody(STATUS, 'stepsOf');
    expect(steps).not.toMatch(/stepOf\('replay', 'refused'/);
    expect(steps).toContain("stepOf('frozen', 'refused', 'stagingSandbox')");

    const staging = prose('Replay into a sandbox marked Staging');
    expect(staging).toContain(
      "**Replay** asks you to type the sandbox's name under the simulation",
    );
    expect(staging).toContain(
      'the extension refuses the replay before it reads anything of the org',
    );
    expect(staging).toContain('A Frozen Dataset load into a sandbox marked Staging stays refused.');
    expect(stepLine('frozen')).toContain(
      'On a sandbox marked Staging the step is refused, since the mark refuses the load',
    );
  });

  it('says what the command line runs counts for the steps, and what counts from the editor alone', () => {
    // Users runs, checkpoints, replays and inventories are the stores the
    // command lines share; maskings and loads, the window's audit trail.
    expect(FACTS).toContain("lastSuccessOf(deps.configStore, entryId, 'anonymize_execute', since)");
    expect(FACTS).toContain("lastSuccessOf(deps.configStore, entryId, 'frozen_load', since)");
    expect(FACTS).toContain('new AuditTrailStore(configStore)');
    expect(FACTS).toContain('readInventories');
    const terminal = prose('From a terminal');
    expect(terminal).toContain(
      'A masking and a Frozen Dataset load count when they ran in the editor.',
    );
    expect(terminal).toContain('an inventory kept by `sandforge env audit --save` count');
  });

  it('names commands and flags the scripts have', () => {
    for (const tool of ['users', 'env', 'checkpoint'] as const) expect(TOOLS).toHaveProperty(tool);
    expect(ENV_CLI).toContain("switches: ['--json', '--save', '--fail-on-findings']");
    expect(CHECKPOINT_CLI).toMatch(/^ {2}take {6}/m);
    expect(CHECKPOINT_CLI).toMatch(/^ {2}replay {4}/m);
    const terminal = section('From a terminal');
    for (const line of [
      '`sandforge users plan`, then `sandforge users apply`, with `--org <alias> --config users.json`',
      '`sandforge checkpoint replay`',
      '`sandforge checkpoint take`',
      '`sandforge env audit`, with `--save`',
      '`audits: { handoff: true }`',
    ]) {
      expect(terminal).toContain(line);
    }
    for (const anchor of ['a-users-resource', 'a-mask-resource', 'a-replay-resource']) {
      expect(terminal).toContain(`(../environments.md#${anchor})`);
    }
  });

  it('leads with the warning that none of it is proven on a refreshed sandbox, as the page and the guide do', () => {
    const title = label('recovery.notProven.title');
    expect(SANDBOX_RECOVERY).toContain("t('recovery.notProven.title')");
    expect(ENVIRONMENTS).toContain(`**${title}.**`);
    const warning = DOC.indexOf(`**${title}.**`);
    expect(warning).toBeGreaterThan(-1);
    expect(warning).toBeLessThan(DOC.indexOf('## The steps'));
    expect(DOC).toContain('(../environments.md#after-a-sandbox-refresh)');
  });

  it('is reached from the guide, the FAQ, Getting Started, Monitor and Checkpoints', () => {
    for (const [page, link] of [
      ['docs/environments.md', '](modules/recovery.md)'],
      ['docs/faq.md', '](modules/recovery.md)'],
      ['docs/getting-started.md', '](modules/recovery.md)'],
      ['docs/modules/monitor.md', '](recovery.md)'],
      ['docs/modules/checkpoint.md', '](recovery.md)'],
    ] as const) {
      expect({ page, links: source(page).includes(link) }).toEqual({ page, links: true });
    }
    // The guide's link sits in its section on the refresh, the FAQ's under its question.
    const guide = ENVIRONMENTS.slice(ENVIRONMENTS.indexOf('\n## After a sandbox refresh\n'));
    expect(guide.slice(0, guide.indexOf('```'))).toContain('](modules/recovery.md)');
    const faq = source('docs/faq.md');
    const question = faq.slice(faq.indexOf('\n### What do I do after a sandbox refresh?\n'));
    expect(question.slice(0, question.indexOf('\n### ', 5))).toContain('](modules/recovery.md)');
  });

  it('says how long the Monitor leads with the refresh', () => {
    expect(MONITOR_BAND).toContain('export const RECENT_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;');
    expect(prose('When it opens')).toContain('while that refresh is less than 7 days old');
  });
});
