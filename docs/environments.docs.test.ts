/**
 * Doc/code drift guard for `docs/environments.md`, the guide to
 * `sandforge-env`, and for the lines the CI guide, the two READMEs and the
 * FAQ give it.
 *
 * The guide is read by whoever lets a pipeline write to an org from a file
 * nobody watches apply, so what it says is held to the code that does it:
 * the help is printed whole on the page and held to the script word for
 * word; the commands and the flags each reads to the script's own table; the
 * keys of the file to the words its strict schema refuses an unknown key
 * with; the example to the check `validate` runs. Every session on the page
 * is replayed here, command by command, on the memory org the command line's
 * own tests run on, and must print what the page prints: a session written
 * by hand, or one the code no longer prints, fails here first. Each refusal
 * and limit the page states is held to the sentence the code says it in.
 *
 * Each test states the code it depends on, and fails first if that code
 * moved: an assertion about a page that no longer works this way proves
 * nothing.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The modules the command line's own tests point at the memory org.
vi.mock('../packages/extension/src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../packages/extension/cli/sfSession.js', () => ({ loadOrg: vi.fn(), makeConn: vi.fn() }));
vi.mock('../packages/extension/cli/sandforge-clone.js', async (original) => ({
  ...(await original<typeof import('../packages/extension/cli/sandforge-clone.js')>()),
  targetAutomationReader: vi.fn(),
}));
vi.mock('../packages/extension/src/modules/forge/ForgeRunRemoval.js', async (original) => ({
  ...(await original<
    typeof import('../packages/extension/src/modules/forge/ForgeRunRemoval.js')
  >()),
  removalOrg: vi.fn(),
}));
vi.mock('../packages/extension/src/core/connection/ConnectionHelper.js', async (original) => ({
  ...(await original<
    typeof import('../packages/extension/src/core/connection/ConnectionHelper.js')
  >()),
  getJsforceConnection: vi.fn(),
}));

import { checkEnvFile, documentOf } from '../packages/extension/cli/env/envFile.js';
import { main } from '../packages/extension/cli/sandforge-env.js';
import type { CommandRunner } from '../packages/extension/cli/scriptRunner.js';
import { runnerWithCheckpoints } from '../packages/extension/cli/testing/envCheckpointWorld.js';
import { EnvWorld, type EnvWorldOptions } from '../packages/extension/cli/testing/envWorld.js';
import { freezeDataset } from '../packages/extension/cli/testing/frozenDataset.js';
import { frozenDatasetDigest } from '../packages/extension/src/modules/frozendataset/datasetDigest.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

function source(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8').replace(/\r\n/g, '\n');
}

const DOC = source('docs/environments.md');
const CLI_DIR = 'packages/extension/cli';
const CLI = source(`${CLI_DIR}/sandforge-env.ts`);
const GUARDS = source(`${CLI_DIR}/env/envGuards.ts`);
const PLAN = source(`${CLI_DIR}/env/envPlan.ts`);
const APPLY = source(`${CLI_DIR}/env/envApply.ts`);
const DESTROY = source(`${CLI_DIR}/env/envDestroy.ts`);
const STATE = source(`${CLI_DIR}/env/envState.ts`);
const FILE = source(`${CLI_DIR}/env/envFile.ts`);
const SEED_KIND = source(`${CLI_DIR}/env/kinds/seed.ts`);
const FROZEN_KIND = source(`${CLI_DIR}/env/kinds/frozen.ts`);
const MASK_KIND = source(`${CLI_DIR}/env/kinds/mask.ts`);
const DATAOPS = source(`${CLI_DIR}/sandforge-dataops.ts`);
const REFERENCES = source(`${CLI_DIR}/env/envReferences.ts`);
const FROZEN = source(`${CLI_DIR}/sandforge-frozen.ts`);
const LOCK = source(`${CLI_DIR}/env/envLock.ts`);
const SEED = source(`${CLI_DIR}/sandforge-seed.ts`);
const EXIT_CODES = source(`${CLI_DIR}/exitCodes.ts`);
const STOP_SIGNALS = source(`${CLI_DIR}/stopSignals.ts`);
const SCHEMA = source('packages/shared/src/schemas/env.schema.ts');

/**
 * The body of a heading of the page, up to the next heading of its level or
 * above: a comment line of a fenced block, `# sandforge.yaml`, is none.
 */
function section(text: string, heading: string): string {
  const level = /^#+/.exec(heading)?.[0].length ?? 2;
  const start = text.indexOf(`\n${heading}\n`);
  if (start === -1) throw new Error(`"${heading}" is missing: re-point this test`);
  const rest = text.slice(start + heading.length + 1);
  const masked = rest.replace(/```[\s\S]*?```/g, (block) => block.replace(/#/g, ' '));
  const next = masked.search(new RegExp(`\\n#{1,${level}} `));
  return next === -1 ? rest : rest.slice(0, next);
}

/** The fenced blocks of a page in a language, in order. */
function fenced(text: string, language: string): string[] {
  return [...text.matchAll(new RegExp(`\`\`\`${language}\\n([\\s\\S]*?)\\n\`\`\``, 'g'))].map(
    (m) => m[1] as string,
  );
}

/** A Markdown table's rows under a heading, each as its cells, the header and rule left out. */
function rows(body: string): string[][] {
  return body
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .slice(2)
    .map((line) =>
      line
        .slice(1, -1)
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim()),
    );
}

/** The names in backticks of a text, in order. */
const ticked = (text: string): string[] =>
  [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);

/** The `--flags` a text names. */
const flagsIn = (text: string): Set<string> =>
  new Set([...text.matchAll(/(?<![\w-])(--[a-z][a-z-]*)/g)].map((m) => m[1] as string));

/** The script's HELP, as `--help` prints it: no value is interpolated into it. */
function help(): string {
  const text = /const HELP = `([\s\S]*?)`;/.exec(CLI)?.[1];
  if (!text) throw new Error('sandforge-env.ts has no HELP text: re-point this test');
  if (text.includes('${')) throw new Error('HELP interpolates a value: resolve it here');
  return text;
}

/** The commands the command line reads, from its own list. */
function commandsRead(): string[] {
  const list = /const COMMANDS = \[([^\]]*)\] as const;/.exec(CLI)?.[1];
  if (!list) throw new Error('COMMANDS is gone from sandforge-env.ts: re-point this test');
  return [...list.matchAll(/'([a-z]+)'/g)].map((m) => m[1] as string);
}

/** The flags `sandforge-frozen` reads, from its own table: what the page names of its lines. */
function frozenFlags(): Set<string> {
  const table = /const FLAGS: CommandFlags = \{([\s\S]*?)\n\};/.exec(FROZEN)?.[1];
  if (!table) throw new Error('the FLAGS of sandforge-frozen.ts are gone: re-point this test');
  return flagsIn(table);
}

/** The flags `sandforge-dataops` reads, from its own table: what the page names of its lines. */
function dataopsFlags(): Set<string> {
  const table = /const FLAGS: CommandFlags = \{([\s\S]*?)\n\};/.exec(DATAOPS)?.[1];
  if (!table) throw new Error('the FLAGS of sandforge-dataops.ts are gone: re-point this test');
  return flagsIn(table);
}

/** The flags `state recover` reads, from the script's own table of them. */
function recoverFlags(): Set<string> {
  const table = /const RECOVER_FLAGS: CommandFlags = \{([\s\S]*?)\n\};/.exec(CLI)?.[1];
  if (!table) throw new Error('RECOVER_FLAGS is gone from sandforge-env.ts: re-point this test');
  return flagsIn(table);
}

/** The flags each command reads, from the script's table of them. */
function flagsOf(): Map<string, Set<string>> {
  const table = /const FLAGS: [^=]*= \{\n([\s\S]*?)\n\};\n/.exec(CLI)?.[1];
  if (!table) throw new Error('the FLAGS table of sandforge-env.ts is gone: re-point this test');
  const read = new Map<string, Set<string>>();
  for (const [, command, body] of table.matchAll(/^ {2}([a-z]+): \{([\s\S]*?)\},?$/gm)) {
    read.set(command as string, flagsIn(body as string));
  }
  return read;
}

// ─── Replaying the sessions ──────────────────────────────────────────────────

/** Where the sessions are run from, as the page names it: a checkout beside the project. */
const HOME = '/home/dev';
const ORG_ID = '00Dxx0000001gPLEAY';
const T0 = Date.parse('2026-10-25T09:00:00.000Z');

/** The orgs a session starts on, as the page names them. */
const WORLDS: Readonly<Record<string, EnvWorldOptions>> = {
  scratch: { sandbox: true, scratch: true },
  frozen: { sandbox: true, scratch: true },
  masking: { sandbox: true },
  developer: { sandbox: false, edition: 'Developer Edition' },
  production: { sandbox: false, edition: 'Enterprise Edition' },
  sandbox: { sandbox: true },
};

/** A session under way: its org, its folders and the file as it stands. */
interface Replay {
  dir: string;
  file: string;
  journalDir: string;
  world: EnvWorld;
  /** The world's scripts, the checkpoint script among them. */
  runner: CommandRunner;
}

/** A user of the org a session names, who changes records between two commands. */
const COLLEAGUE = '005xx000003gPLEAAA';

/** The example of the page, which every session starts from. */
function example(): string {
  const [yaml] = fenced(DOC, 'yaml');
  if (!yaml) throw new Error('the page gives no example file: re-point this test');
  return `${yaml}\n`;
}

/** The file a frozen resource's sessions start from: the example of its section. */
function frozenExample(): string {
  const yaml = fenced(section(DOC, '### A frozen resource'), 'yaml')[0];
  if (!yaml) throw new Error('the frozen section gives no example file: re-point this test');
  return `${yaml}\n`;
}

/** The file a mask resource's sessions start from: the example of its section. */
function maskExample(): string {
  const yaml = fenced(section(DOC, '### A mask resource'), 'yaml')[0];
  if (!yaml) throw new Error('the mask section gives no example file: re-point this test');
  return `${yaml}\n`;
}

/** The contacts a sandbox copied from production holds, as a mask session starts on: the last with no email. */
const COPIED_CONTACTS = [
  { LastName: 'Copied 1', Email: 'one@example.com', Phone: '+33 1 00 00 00 01' },
  { LastName: 'Copied 2', Email: 'two@example.com', Phone: '+33 1 00 00 00 02' },
  { LastName: 'Copied 3', Email: 'three@example.com' },
  { LastName: 'Copied 4' },
];

/** The dataset of a frozen session, as the page's digest pins it: two claims, a contact each. */
const CLAIMS = { accounts: 2, perAccount: 1, mark: 'claim' } as const;

/** The variable the frozen example names its dataset by. */
const DATASET_VARIABLE = 'SANDFORGE_CLAIMS_DATASET';

/** Edit the file as it stands, failing when the text to change is not there. */
function edit(replay: Replay, from: string, to: string): void {
  const text = readFileSync(replay.file, 'utf8');
  if (!text.includes(from)) throw new Error(`the example no longer holds ${JSON.stringify(from)}`);
  writeFileSync(replay.file, text.replace(from, to));
}

/** What happens between two sessions, as the page says it. */
const EVENTS: Readonly<Record<string, (replay: Replay) => void | Promise<void>>> = {
  // An apply as the page's first does it, then its state.json deleted, every run file left.
  'the state of an apply lost': async (replay) => {
    const applied = await command(replay, [
      'apply',
      '--file',
      '../case-flow/sandforge.yaml',
      '--org',
      'my-de',
      '--yes',
      '--accept-no-state',
    ]);
    if (applied.code !== 0) throw new Error(`the apply before the loss ended ${applied.code}`);
    const env = join(replay.journalDir, 'env');
    const [org] = readdirSync(env);
    rmSync(join(env, org ?? '', 'case-flow', 'state.json'));
  },
  'the accounts lose their field rule': (replay) =>
    edit(
      replay,
      '        count: 3\n        fields:\n          - { fieldApiName: Name, ruleType: static, config: { staticValue: CI account } }\n',
      '        count: 3\n',
    ),
  'the file as above': (replay) => writeFileSync(replay.file, example()),
  'a contact deleted': (replay) => {
    const [contact] = replay.world.records('Contact');
    replay.world.org.trash('Contact', String(contact?.['Id']));
  },
  'accounts asks for four': (replay) => edit(replay, '        count: 3\n', '        count: 4\n'),
  'an account changed': (replay) => {
    const [account] = replay.world.records('Account');
    replay.world.org.touch('Account', String(account?.['Id']), new Date().toISOString());
  },
  'the file lists another sandbox': (replay) =>
    edit(
      replay,
      '  kinds: [scratch, developer]',
      '  kinds: [scratch, developer, sandbox]\n  sandboxes: [00Dxx0000002gPL]',
    ),
  'the journal inside the repository': (replay) => {
    replay.journalDir = join(dirname(replay.file), '.sandforge');
  },
  'the file asks a checkpoint once applied': (replay) =>
    edit(replay, '\nresources:\n', '\ncheckpoint:\n  after: baseline\n\nresources:\n'),
  'a test renames an account and creates one': (replay) => {
    const [account] = replay.world.records('Account');
    replay.world.org.edit('Account', String(account?.['Id']), { Name: 'Renamed' }, COLLEAGUE);
    createdByATest(replay);
  },
  'the file asks a checkpoint before the first write': (replay) =>
    edit(replay, '\nresources:\n', '\ncheckpoint:\n  before: true\n\nresources:\n'),
  'a test creates an account': (replay) => createdByATest(replay),
  'a contact of the load deleted': (replay) => {
    const contact = replay.world
      .records('Contact')
      .find((row) => String(row['LastName']).startsWith('SFENV claim'));
    replay.world.org.trash('Contact', String(contact?.['Id']));
  },
  'the dataset frozen again': async (replay) => {
    const dataset = join(replay.dir, 'datasets', 'claims');
    rmSync(dataset, { recursive: true, force: true });
    await freezeDataset(dataset, { ...CLAIMS, accounts: 3, version: '1.1.0' });
  },
  'the file pins the new dataset': async (replay) => {
    const digest = await frozenDatasetDigest(join(replay.dir, 'datasets', 'claims'));
    edit(replay, '      version: 1.0.0\n', '      version: 1.1.0\n');
    const pinned = /digest: (sha256:[0-9a-f]{64})/.exec(readFileSync(replay.file, 'utf8'))?.[1];
    if (!pinned) throw new Error('the frozen example pins no digest: re-point this test');
    edit(replay, pinned, digest);
  },
  'followers ask for four': (replay) => edit(replay, '        count: 3\n', '        count: 4\n'),
  'a contact copied in since': (replay) => {
    replay.world.copyIn('Contact', [{ LastName: 'Copied 5', Email: 'five@example.com' }]);
  },
  'the set names a field the org lacks': (replay) =>
    edit(
      replay,
      '{ maskKeepLast: 2 } }\n',
      '{ maskKeepLast: 2 } }\n      - { fieldPattern: Contact.Nickname__c, ruleType: fake }\n',
    ),
};

/** An account a test creates, as the colleague the sessions name. */
function createdByATest(replay: Replay): void {
  replay.world.org.add('Account', {
    Id: '001xx000003gPLEAAA',
    Name: 'Made by a test',
    CreatedById: COLLEAGUE,
    LastModifiedById: COLLEAGUE,
  });
}

/**
 * A new session: an org of `kind`, the project with its example file, an
 * empty journal. A frozen session's project is the frozen section's, its
 * Frozen configuration committed beside the file, its dataset frozen outside
 * it, where the variable the file names points.
 */
async function begin(kind: string): Promise<Replay> {
  const options = WORLDS[kind];
  if (!options) throw new Error(`no org "${kind}" to replay a session on`);
  vi.setSystemTime(T0);
  // Where its links lead, as the repository rule follows the file's folder:
  // macOS's temporary folder is a link, and the refusal named both forms.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sandforge-env-docs-')));
  const project = join(
    dir,
    kind === 'frozen' ? 'claims-flow' : kind === 'masking' ? 'uat-masked' : 'case-flow',
  );
  mkdirSync(join(project, '.git'), { recursive: true });
  mkdirSync(join(dir, 'sandforge'));
  const file = join(project, 'sandforge.yaml');
  writeFileSync(
    file,
    kind === 'frozen' ? frozenExample() : kind === 'masking' ? maskExample() : example(),
  );
  if (kind === 'frozen') {
    mkdirSync(join(project, 'frozen'));
    writeFileSync(
      join(project, 'frozen', 'claims.frozen.json'),
      JSON.stringify({ rootObject: 'Account', axes: [], edgeCases: [] }, null, 2),
    );
    const dataset = await freezeDataset(join(dir, 'datasets', 'claims'), CLAIMS);
    process.env[DATASET_VARIABLE] = dataset;
  }
  const world = new EnvWorld({
    organizationId: ORG_ID,
    tick: () => vi.setSystemTime(Date.now() + 30_000),
    ...options,
  });
  if (kind === 'masking') world.copyIn('Contact', COPIED_CONTACTS);
  const runner = runnerWithCheckpoints(world, {
    locksDir: join(dir, 'locks'),
    users: { [COLLEAGUE]: 'Colleague' },
    tick: () => vi.setSystemTime(Date.now() + 30_000),
  });
  return { dir, file, journalDir: join(dir, '.sandforge'), world, runner };
}

/** Run one command line of a session: what it said, stdout and stderr in the order they came, and its exit code. */
async function command(replay: Replay, args: string[]): Promise<{ said: string; code: number }> {
  const said: string[] = [];
  let exited: number | undefined;
  const keep = (chunk: string | Uint8Array): boolean => {
    said.push(String(chunk));
    return true;
  };
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(keep);
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(keep);
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exited = code;
    throw new Error(`exit ${code}`);
  }) as never);
  process.exitCode = undefined;
  try {
    await main(['node', 'sandforge-env.ts', ...args], {
      runner: replay.runner,
      journalDir: replay.journalDir,
      locksDir: join(replay.dir, 'locks'),
      onStop: () => () => undefined,
      cwd: join(replay.dir, 'sandforge'),
    });
  } catch (error: unknown) {
    if (!(error instanceof Error) || !error.message.startsWith('exit ')) throw error;
  } finally {
    out.mockRestore();
    err.mockRestore();
    exit.mockRestore();
  }
  const code = exited ?? Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  // The page's folders for the session's own, written with forward slashes on
  // every platform: on Windows the paths come with backslashes.
  const paths = new RegExp(`${HOME}[^\\s]*`, 'g');
  return {
    said: said
      .join('')
      .replaceAll(replay.dir, HOME)
      .replace(paths, (path) => path.replaceAll('\\', '/'))
      // A checkpoint's id ends in four random characters: the page gives them as a1b2.
      .replace(/\b(ck|rw|pv)-(\d{8}-\d{6})-[a-z0-9]{4}\b/g, '$1-$2-a1b2')
      // A masking's snapshot is named after its run's id, which ends in six: the page gives them as a1b2c3.
      .replace(/\b(cli-dataops-anonymize-\d+)-[a-z0-9]{1,6}-snapshot\b/g, '$1-a1b2c3-snapshot'),
    code,
  };
}

/** The sessions of the page, in order, each with the org it runs on and what happens before it. */
function sessions(): Array<{ start: string; event?: string; block: string }> {
  const found = [
    ...DOC.matchAll(/<!-- replay: ([a-z]+)(?:; ([^>]+?))? -->\n+```console\n([\s\S]*?)\n```/g),
  ].map((m) => ({
    start: m[1] as string,
    ...(m[2] !== undefined ? { event: m[2] } : {}),
    block: m[3] as string,
  }));
  if (found.length !== fenced(DOC, 'console').length) {
    throw new Error('a console block of the page says nothing of where it is replayed');
  }
  return found;
}

// ─── The guide ───────────────────────────────────────────────────────────────

describe('docs/environments.md', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('prints the --help text the script prints, word for word', () => {
    const text = help();
    // Positive control: the text is the help, its commands and its exit codes.
    expect(text).toContain('Commands:');
    expect(text).toContain('Exit codes: 0 done');

    const block = /### Every flag\n+```text\n([\s\S]*?)\n```/.exec(DOC)?.[1];
    expect(block).toBe(text.replace(/\n$/, ''));
  });

  it('runs the script the way every script is run, and the help says so', () => {
    const run = 'pnpm exec tsx packages/extension/cli/sandforge-env.ts';

    expect(help()).toContain(`  ${run} <command> [--file <sandforge.yaml>] --org <alias>`);
    expect(DOC).toContain(`alias sandforge-env='${run}'`);
    expect(section(DOC, '## Run it')).toContain('`pnpm install` and `pnpm build:shared`');
    // The default file is the one of the folder the script runs in.
    expect(CLI).toContain("file: resolve(cwd, fileGiven ?? 'sandforge.yaml'),");
    expect(DOC).toContain('without it, `sandforge.yaml` of the folder it runs in is read');
  });

  it('names each command the script reads, with the flags each reads, and no other', () => {
    const commands = commandsRead();
    expect(commands).toEqual(['validate', 'plan', 'apply', 'destroy', 'reset', 'state', 'output']);
    const flags = flagsOf();
    // Positive control: the table read is the one each command checks its line against.
    expect(flags.get('destroy')).toEqual(
      new Set([
        '--json',
        '--include-changed',
        '--sweep',
        '--accept-automation',
        '--rewind',
        '--accept-no-undo',
        '--yes',
        '--file',
        '--org',
        '--alias',
      ]),
    );

    // `state recover` is `state` with a second word, read by a table of its own.
    expect(CLI).toContain("const recover = command === 'state' && args[1] === 'recover';");
    flags.set('state recover', recoverFlags());
    expect(flags.get('state recover')).toEqual(new Set(['--json', '--file', '--org', '--alias']));

    const table = rows(section(DOC, '## The commands'));
    expect(table.map(([name]) => name)).toEqual([
      ...commands
        .map((c) => `\`${c}\``)
        .flatMap((c) => (c === '`state`' ? [c, '`state recover`'] : [c])),
    ]);
    for (const [name, , listed] of table) {
      const command = (name ?? '').replaceAll('`', '');
      expect(flagsIn(listed ?? ''), command).toEqual(flags.get(command));
    }
  });

  it('names in its prose and its sessions only flags the command line reads', () => {
    const read = new Set([...flagsOf().values()].flatMap((set) => [...set]));
    read.add('--help');
    // The help block aside, and the checkpoint script's own lines, which its guide holds.
    const base = DOC.replace(/```text\n[\s\S]*?\n```/, '').replace(
      /sandforge-checkpoint [^\n`]*/g,
      '',
    );
    const named = flagsIn(base);
    // Positive control: the flags of a plan, an apply, a saved plan and a destroy are all there.
    for (const flag of [
      '--fail-on-drift',
      '--accept-no-state',
      '--include-changed',
      '--sweep',
      '--out',
      '--plan',
    ]) {
      expect(named.has(flag)).toBe(true);
    }
    // The frozen section names the lines of sandforge-frozen too, and the
    // mask section those of sandforge-dataops: the flags each script reads,
    // there alone.
    const frozen = section(DOC, '### A frozen resource');
    const mask = section(DOC, '### A mask resource');
    const outside = flagsIn(base.replace(frozen, '').replace(mask, ''));
    expect([...outside].filter((flag) => !read.has(flag))).toEqual([]);
    const frozenRead = frozenFlags();
    expect(frozenRead.has('--max-total')).toBe(true);
    expect([...flagsIn(frozen)].filter((flag) => !read.has(flag) && !frozenRead.has(flag))).toEqual(
      [],
    );
    const dataopsRead = dataopsFlags();
    expect(dataopsRead.has('--restore')).toBe(true);
    expect([...flagsIn(mask)].filter((flag) => !read.has(flag) && !dataopsRead.has(flag))).toEqual(
      [],
    );
    expect(
      [...named].filter(
        (flag) => !read.has(flag) && !frozenRead.has(flag) && !dataopsRead.has(flag),
      ),
    ).toEqual([]);
  });

  it('gives an example file that passes the check validate runs: two seed resources, the second hung from the first', () => {
    const read = documentOf(example());
    if (!('document' in read)) throw new Error(read.refusal);
    const checked = checkEnvFile(read.document, HERE);
    if ('refusals' in checked) {
      throw new Error(checked.refusals.map((r) => `${r.path.join('.')}: ${r.message}`).join('\n'));
    }

    expect(checked.checked.order).toEqual(['accounts', 'contacts']);
    const contacts = checked.checked.runs['contacts']?.template;
    expect(contacts?.relations).toEqual([
      expect.objectContaining({
        childObject: 'Contact',
        lookupField: 'AccountId',
        parentObject: 'Account',
        parents: { kind: 'existing', where: "Name = 'CI account'", limit: 3 },
      }),
    ]);
    expect(checked.checked.warnings).toEqual([]);
  });

  it('lists every key of the file, as its strict schema names them when it refuses one', () => {
    /** The keys a place of the file takes, from the refusal of a key it does not. */
    const taken = (doc: Record<string, unknown>, what: string): string[] => {
      const read = checkEnvFile(doc, HERE);
      const refusal = 'refusals' in read ? read.refusals.map((r) => r.message).join('\n') : '';
      const keys = new RegExp(`"misspelt" is not a key of ${what}, which takes ([^\\n]+)`).exec(
        refusal,
      )?.[1];
      if (!keys) throw new Error(`no refusal names the keys of ${what}: ${refusal}`);
      return keys.split(', ');
    };
    const object = { object: 'Account', count: 1, fields: [] };
    const relation = {
      lookup: 'Contact.AccountId',
      parents: { object: 'Account' },
      distribution: { mode: 'perParent', count: 1 },
    };
    const file = (resource: Record<string, unknown>, top: Record<string, unknown> = {}) => ({
      version: 1,
      name: 'e',
      resources: { r: { kind: 'seed', objects: [object], ...resource } },
      ...top,
    });
    const forge = (resource: Record<string, unknown>) => ({
      version: 1,
      name: 'e',
      orgs: { uat: { alias: 'A' } },
      resources: { r: { kind: 'forge', source: 'uat', tables: [{ object: 'Case' }], ...resource } },
    });
    const places: Array<[string, string, Record<string, unknown>]> = [
      ['the file', 'the file', file({}, { misspelt: 1 })],
      ['`targets`', 'targets', file({}, { targets: { misspelt: 1 } })],
      ['`orgs.<role>`', 'an org role', file({}, { orgs: { uat: { alias: 'A', misspelt: 1 } } })],
      ['`checkpoint`', 'checkpoint', file({}, { checkpoint: { misspelt: 1 } })],
      ['`resources.<name>`', 'a seed resource', file({ misspelt: 1 })],
      ['`resources.<name>.accept`', 'accept', file({ accept: { misspelt: 1 } })],
      [
        '`resources.<name>.objects[]`',
        'an object of a seed resource',
        file({ objects: [{ ...object, misspelt: 1 }] }),
      ],
      [
        '`resources.<name>.relations[]`',
        'a relation',
        file({ relations: [{ ...relation, misspelt: 1 }] }),
      ],
      [
        '`resources.<name>.relations[].parents`',
        'a relation’s parents',
        file({ relations: [{ ...relation, parents: { object: 'Account', misspelt: 1 } }] }),
      ],
      [
        '`….parents.existing`',
        'existing parents',
        file({
          relations: [
            { ...relation, parents: { object: 'Account', existing: { limit: 1, misspelt: 1 } } },
          ],
        }),
      ],
    ];
    const frozen = (resource: Record<string, unknown>) => ({
      version: 1,
      name: 'e',
      resources: {
        r: {
          kind: 'frozen',
          config: 'f.json',
          dataset: { path: '/d', version: '1.0.0', digest: `sha256:${'0'.repeat(64)}` },
          ...resource,
        },
      },
    });
    places.push(
      ['`resources.<name>`, `kind: frozen`', 'a frozen resource', frozen({ misspelt: 1 })],
      [
        '`resources.<name>.dataset`',
        'a dataset',
        frozen({
          dataset: {
            path: '/d',
            version: '1.0.0',
            digest: `sha256:${'0'.repeat(64)}`,
            misspelt: 1,
          },
        }),
      ],
    );
    places.push(
      ['`resources.<name>`, `kind: forge`', 'a forge resource', forge({ misspelt: 1 })],
      [
        '`resources.<name>.record`',
        'a record',
        forge({ tables: undefined, record: { id: '500000000000001AAA', misspelt: 1 } }),
      ],
      [
        '`resources.<name>.tables[]`',
        'a table',
        forge({ tables: [{ object: 'Case', misspelt: 1 }] }),
      ],
      [
        '`resources.<name>.template`',
        'a template',
        forge({ template: { file: 't.json', id: 't', misspelt: 1 } }),
      ],
      [
        '`resources.<name>.anonymize`',
        'anonymize',
        forge({ anonymize: { rules: {}, misspelt: 1 } }),
      ],
      ['`resources.<name>.accept`, `kind: forge`', 'accept', forge({ accept: { misspelt: 1 } })],
    );
    const mask = (
      resource: Record<string, unknown>,
      rule: Record<string, unknown> = { fieldPattern: 'Contact.Email', ruleType: 'fake' },
    ) => ({
      version: 1,
      name: 'e',
      masking: { s: { rules: [rule] } },
      resources: { r: { kind: 'mask', rules: 's', object: 'Contact', ...resource } },
    });
    places.push(
      [
        '`masking.<set>`',
        'a rule set',
        { ...mask({}), masking: { s: { rules: [], misspelt: 1 } } },
      ],
      [
        '`masking.<set>.rules[]`',
        'a masking rule',
        mask({}, { fieldPattern: 'Contact.Email', ruleType: 'fake', misspelt: 1 }),
      ],
      [
        '`….rules[].config`',
        'a masking rule’s config',
        mask({}, { fieldPattern: 'Contact.Email', ruleType: 'mask', config: { misspelt: 1 } }),
      ],
      ['`resources.<name>`, `kind: mask`', 'a mask resource', mask({ misspelt: 1 })],
      [
        '`resources.<name>.rules`',
        'a template that ships',
        mask({ rules: { template: 'tpl-gdpr-standard', misspelt: 1 } }),
      ],
    );
    const table = rows(section(DOC, '### Every key'));
    for (const [where, what, doc] of places) {
      const row = table.find(([cell]) => cell === where);
      expect(row, where).toBeDefined();
      expect(ticked(row?.[1] ?? ''), where).toEqual(taken(doc, what));
    }
    // The three shapes of a distribution, each with its mode.
    const modes = [
      { mode: 'perParent', count: 1 },
      { mode: 'range', min: 0, max: 1 },
      { mode: 'ratio', ratio: 1 },
    ].flatMap((distribution) =>
      taken(
        file({ relations: [{ ...relation, distribution: { ...distribution, misspelt: 1 } }] }),
        'a distribution',
      ),
    );
    const distribution = table.find(
      ([cell]) => cell === '`resources.<name>.relations[].distribution`',
    );
    expect(ticked(distribution?.[1] ?? '')).toEqual([...new Set(modes)]);
    expect(table).toHaveLength(places.length + 1);
  });

  it('names the built-in templates a resource may name, as the check names them', () => {
    const read = checkEnvFile(
      { version: 1, name: 'e', resources: { r: { kind: 'seed', template: 'none' } } },
      HERE,
    );
    const refusal = 'refusals' in read ? (read.refusals[0]?.message ?? '') : '';
    const ids = /there is no built-in template "none": there is (.+)$/
      .exec(refusal)?.[1]
      ?.split(', ');
    expect(ids?.length).toBeGreaterThan(3);

    const line = DOC.split('\n').find((l) => l.startsWith('A built-in template is one of'));
    const named = ticked(line ?? '');
    expect(named).toEqual(ids);
    expect(SEED_KIND).toContain('A built-in template is its content, not its id, so a SandForge');
  });

  it('says what the file refuses, in the rules the schema and the reader keep', () => {
    const rules = section(DOC, '## The file');
    expect(FILE).toContain('const MAX_ALIASES = 100;');
    expect(rules).toContain('more than 100 aliases');
    expect(SCHEMA).toContain(
      "export const ENV_REF_PLACES: readonly string[] = [\n  'orgs.<role>.alias',\n  'resources.<frozen>.dataset.path',\n];",
    );
    expect(rules).toContain(
      "and that is the alias of an org role and the path of a frozen resource's dataset alone",
    );
    const secrets = [...SCHEMA.matchAll(/\{ name: '([A-Za-z]+)', words:/g)].map((m) => m[1]);
    const said = /A key shaped like a secret -- (.+?) --/.exec(rules)?.[1] ?? '';
    const listed = ticked(said);
    expect(listed.length).toBeGreaterThan(5);
    expect(listed.filter((secret) => !secrets.includes(secret))).toEqual([]);
    expect(SCHEMA).toContain('This file is written for a later SandForge');
    expect(rules).toContain('A file written for a later SandForge is refused.');
  });

  // Every session of the page, each on an org of its own: seconds on a loaded
  // machine, more on a CI runner, past the five a test is given by default.
  it('replays every session of the page on the memory org, and the code prints each word for word', async () => {
    const all = sessions();
    // Positive control: the walk-through and the refusals, on every kind of org.
    expect(new Set(all.map((s) => s.start))).toEqual(
      new Set(['frozen', 'masking', 'scratch', 'then', 'production', 'sandbox', 'developer']),
    );
    expect(all.length).toBeGreaterThan(20);

    let replay: Replay | undefined;
    const done: Replay[] = [];
    const dataset = process.env[DATASET_VARIABLE];
    try {
      for (const session of all) {
        if (session.start !== 'then') {
          replay = await begin(session.start);
          done.push(replay);
        }
        if (!replay) throw new Error('the first session of the page names no org');
        if (session.event !== undefined) {
          const event = EVENTS[session.event];
          if (!event) throw new Error(`nothing replays "${session.event}"`);
          await event(replay);
        }
        let last = 0;
        const parts = session.block.split(/^\$ /m).slice(1);
        expect(parts.length, session.block).toBeGreaterThan(0);
        for (const part of parts) {
          const [line = '', ...printed] = part.split('\n');
          const expected = printed.join('\n').replace(/\n$/, '');
          if (line === 'echo $?') {
            expect(expected, `the exit code after ${session.block.split('\n')[0]}`).toBe(
              String(last),
            );
            continue;
          }
          const [script, ...args] = line.split(' ');
          expect(script).toBe('sandforge-env');
          const { said, code } = await command(replay, args);
          expect(expected, `$ ${line}`).toBe(said.replace(/\n$/, ''));
          last = code;
        }
      }
    } finally {
      for (const one of done) rmSync(one.dir, { recursive: true, force: true });
      if (dataset === undefined) delete process.env[DATASET_VARIABLE];
      else process.env[DATASET_VARIABLE] = dataset;
    }
  }, 60_000);

  it('names the actions a plan gives, in the order the plan explains them, each as it explains it', () => {
    const header = /Per resource, one action:\n \*\n([\s\S]*?)\n \*\n/.exec(PLAN)?.[1] ?? '';
    const actions = [...header.matchAll(/^ \* - `([a-z]+)`:/gm)].map((m) => m[1]);
    // Positive control: the plan's comment names every action the plan's schema holds.
    const kinds = /export const envActionKindSchema = z\.enum\(\[([\s\S]*?)\]\);/.exec(SCHEMA)?.[1];
    expect(new Set(actions)).toEqual(
      new Set([...(kinds ?? '').matchAll(/'([a-z]+)'/g)].map((m) => m[1])),
    );

    const table = rows(section(DOC, '### See what it would do: `plan`'));
    expect(table.map(([action]) => action)).toEqual(actions.map((a) => `\`${a}\``));
    const when = (action: string): string =>
      table.find(([cell]) => cell === `\`${action}\``)?.[1] ?? '';
    expect(header).toContain(
      '`drifted`: applied from the same fingerprint, and records of it are gone,\n *   changed since by someone, or could not be read',
    );
    expect(when('drifted')).toContain(
      'records of it are gone, changed since by someone, or could not be read',
    );
    expect(header).toContain(
      "`blocked`: its dry run, its removal's preview, a summed gate or what this\n *   SandForge does not do refuses it — and the whole apply with it, before\n *   its first write.",
    );
    expect(when('blocked')).toBe(
      "its dry run, its removal's preview, a summed gate or what this SandForge does not do refuses it",
    );
  });

  it('says what the script leaves to the seed and what it adds, as the code that does it says', () => {
    // Each resource spawned through the seed with --json, its lines passed on to stderr.
    expect(CLI).toContain('`sandforge-seed` for a seed resource — spawned with `--json`');
    expect(source(`${CLI_DIR}/scriptRunner.ts`)).toContain(
      "Its lines go on to this process's stderr as they\n * come",
    );
    expect(DOC).toContain(
      'Each resource of the file is applied by its script -- `sandforge-seed` for a seed resource, `sandforge-clone` for a forge resource, `sandforge-frozen` for a frozen resource, `sandforge-dataops` for a mask resource --, run in a process of its own with `--json`',
    );
    expect(DOC).toContain('Each script it runs says its own lines too, on stderr, as they come');
    // The file's two checks: its own schema, then Seed's, as the panel's.
    expect(SEED_KIND).toContain(
      'checked by `seedTemplatePayloadSchema` as\n * `seed:execute` checks the panel',
    );
    expect(DOC).toContain("held to Seed's own schema and rules, as the Seed panel's are");
    // Write-ahead, and the two orders of an apply.
    expect(APPLY).toContain(
      'Write-ahead: before a script is spawned, its resource goes to `applying`',
    );
    expect(DOC).toContain(
      'Before each run starts, the state names it; once it ends, the state says how.',
    );
    expect(APPLY).toContain(
      'then every `create` and the run half of every `replace`, each\n * after what it depends on. The removal keeps a record while records that\n * stay hang from it, so the forward order would keep every parent.',
    );
    expect(DOC).toContain(
      'then what is written, each resource after what it depends on. Taken back the other way, the removal would keep every account the contacts still hang from.',
    );
    // state: by org, an alias or an Organization Id, and by file.
    expect(help()).toContain(
      'or those of one org (--org, an alias or\n            an Organization Id)',
    );
    expect(CLI).toContain('(envName === undefined || listing.env === envName) &&');
    expect(DOC).toContain(
      '`--org` keeps the states of one org, by its alias or its Organization Id, `--file` those of one file',
    );
    // The org typed from its Organization record; a scratch org told apart by the sf CLI alone.
    expect(GUARDS).toContain(
      'typed live from its Organization record, and an org\n *   that will not say what it is',
    );
    expect(GUARDS).toContain(
      'A scratch org says `IsSandbox` true, as a sandbox does: only the `sf` CLI\n * tells them apart, by the Dev Hub its display names.',
    );
    expect(DOC).toContain(
      'every command that reaches an org types it from its Organization record',
    );
    expect(DOC).toContain('**A production org**, and an org that will not say what it is.');
    expect(DOC).toContain(
      'A scratch org says it is a sandbox, as a sandbox does: only the sf CLI tells them apart, by the Dev Hub `sf org display` names for it.',
    );
  });

  it('explains the file, its keys and each command in the words the schema, the reader and the help use', () => {
    const pins: Array<[string, string, string]> = [
      // [code, what the code says, what the page says]
      [
        FILE,
        'which reads YAML\n * 1.2 — JSON included',
        'JSON is YAML, so a `.json` file named with `--file` reads too',
      ],
      [
        FILE,
        'A key\n * given twice in one mapping is refused',
        'so are a key given twice in one mapping',
      ],
      [
        FILE,
        'a second document in the file',
        'a tag YAML 1.2 does not know, a second document in the file',
      ],
      [
        help(),
        'The org to fill is never in the file.',
        '**The org to fill is never in the file.**',
      ],
      [
        SEED,
        'draws the same again',
        '`seed` keeps the draws: the same file writes the same records again',
      ],
      [
        SCHEMA,
        'A name is lower-case letters, digits and dashes',
        '`name`, lower-case letters, digits and dashes',
      ],
      [
        SCHEMA,
        ".default(['scratch', 'developer'])",
        '`scratch` and `developer` unless it says otherwise',
      ],
      [help(), 'wins over its variable', '`--alias <role>=<alias>` wins over it'],
      [
        FILE,
        'is not set: set it in the job',
        'an unset variable refuses every command but `validate`, exit `2`',
      ],
      [
        SCHEMA,
        'A seed resource names a built-in template or its objects, not both',
        'or `objects` and `relations` of its own, not both',
      ],
      [SEED_KIND, 'or leave locale out to draw in the org’s own', "the org's own without it"],
      [
        help(),
        "accept: { automation: true } is the file's --accept-automation for that resource",
        '`true`: the `--accept-automation` of the line, for this resource',
      ],
      [SCHEMA, 'an object is listed once', 'an object, listed once'],
      [
        SCHEMA,
        'Record types by DeveloperName; several take turns at random.',
        'record types by API name, several taking turns at random',
      ],
      [
        SCHEMA,
        'A lookup is named with its object, as Contact.AccountId',
        'a lookup named with its object, as `Contact.AccountId`',
      ],
      [
        SCHEMA,
        'the records this resource writes of\n * `object`; with `existing`, records the org already holds; with `from`, the\n * records another resource of the file created, by their ids',
        'the records this resource writes of it; with `existing`, records the org holds; with `from`, the records another resource created',
      ],
      [SCHEMA, 'A SOQL WHERE condition, without the keyword', 'a SOQL condition, without `WHERE`'],
      [help(), 'validate  check the file, offline', 'It reaches no org, and needs no `--org`'],
      [
        CLI,
        "(unset.has(variable.name) ? 'not set in this shell' : 'set')",
        'the variables the file reads, set or not in this shell',
      ],
      [
        CLI,
        "through\n * its script's own `--remove … --preview`",
        "read back from the org by the seed's removal preview, which deletes nothing",
      ],
      [
        CLI,
        "through its script's own\n * `--dry-run --json`",
        'Each resource to write is dry-run by the seed',
      ],
      [
        PLAN,
        'three seeds that each fit can together overrun',
        'together, three that each fit can overrun it, so the plan blocks every write when a sum goes past it',
      ],
      [
        help(),
        'exit 3 when apply would write or delete anything',
        '`--fail-on-change` exits `3` when `apply` would write or delete anything',
      ],
      [help(), 'records deleted or changed since', 'a record deleted or changed since'],
      [
        GUARDS,
        'it is warned of, not refused',
        'On a scratch org, which usually lives as long as the job that fills it, it is a warning',
      ],
      [
        STATE,
        'the fingerprint it\n * was applied from, the order, and how each step ended',
        'Per resource, the fingerprint it was applied from, the order, and how each run ended',
      ],
      [
        STATE,
        'a CI alias reused for a new scratch org gets a new\n * state, and so does a refreshed sandbox',
        'an alias reused for a new scratch org gets a new state, and so does a refreshed sandbox',
      ],
      [
        STATE,
        "would publish the org's ids with\n * the project",
        "would publish the org's record ids with the project",
      ],
      [
        STATE,
        'another apply ran, a cache put\n * back an older one — is refused, never written over',
        'another apply ran, a cache put back an older one -- is refused, never written over',
      ],
      [
        CLI,
        'a month after its last write, as a scratch org does: deleted',
        'Any other state stays, a `destroy` that took everything back included, until you delete its folder',
      ],
      [
        CLI,
        'for (const expired of await store.sweep()) {',
        'every command but `validate` first deletes those whose date has come, and says so',
      ],
      [
        DESTROY,
        'A removal refused before it deletes — the org runs automation as records\n * go and the line gave no `--accept-automation`, a user who may not delete\n * some objects — stops the destroy there',
        'A removal refused before it deletes stops the destroy there',
      ],
      [
        APPLY,
        'the step under way stops before its next call to the org',
        'stops the run under way before its next call to the org',
      ],
    ];
    for (const [code, said, page] of pins) {
      expect(code, said).toContain(said);
      expect(DOC, page).toContain(page);
    }
    // Only a scratch org's state expires.
    expect(STATE).toContain("if (state.org.kind !== 'scratch') return undefined;");
  });

  it('quotes the questions apply and destroy ask in the words the command line asks them', () => {
    expect(CLI).toContain('`Type ${prepared.target.alias} to apply ${plan.env} to it as planned:`');
    expect(DOC).toContain('`Type pool-1 to apply case-flow to it as planned:`');
    expect(CLI).toContain(
      "', the records changed since included — on a shared org, others’ work:'",
    );
    expect(DOC).toContain(
      '`Type pool-1 to take case-flow back from it, the records changed since included — on a shared org, others’ work:`',
    );
    expect(source(`${CLI_DIR}/prompt.ts`)).toContain('no terminal to answer: give --yes');
    expect(DOC).toContain('it stops at the question, exit `2`, having written nothing');
  });

  it('quotes each refusal it does not replay in the words the code says it', () => {
    const refused = section(DOC, '## What is refused');
    const quoted: Array<[string, string]> = [
      ['the file refuses it whatever else it says', GUARDS],
      ['a state of another org is never applied', GUARDS],
      [
        'Two jobs applying to one org from two machines are not kept apart: give them one concurrency group.',
        LOCK,
      ],
      ['the apply would stop part way', PLAN],
      ['the org would refuse records part way', PLAN],
      ['each resource alone may fit, the day does not', PLAN],
    ];
    for (const [words, code] of quoted) {
      expect(refused, words).toContain(`\`${words}\``);
      expect(code.replace(/[`'] \+\n\s+[`']/g, ''), words).toContain(words);
    }
    // A removal refused for automation deletes nothing without the acceptance.
    expect(SEED).toContain('without the flag the removal then');
    expect(refused).toContain(
      'unless `--accept-automation`, or `accept: { automation: true }` on the resource',
    );
    expect(CLI).toContain('resolved.checked.file.resources[name]?.accept?.automation === true;');
  });

  it('says a destroy that took everything back keeps the state, so the next apply needs no --accept-no-state', () => {
    // Anchors: the destroy keeps the state and says so, and only no state on
    // a Developer Edition org or a sandbox refuses an apply.
    expect(DESTROY).not.toContain('deps.store.remove(');
    expect(DESTROY).toContain("'destroyed, and the next apply creates it again'");
    expect(GUARDS).toContain(
      "if (target.kind === 'scratch' || acceptNoState) return { warning: said };",
    );

    expect(DOC).toContain(
      'A `destroy` that took everything back keeps the state, every resource in it destroyed: the next `apply` creates them again, with no `--accept-no-state`.',
    );
  });

  it('says where the state is kept, what it holds, for how long, and what keeps two applies apart', () => {
    const state = section(DOC, '## The state');
    expect(help()).toContain("ids, counts and dates, never a record's values");
    expect(state).toContain("**ids, counts and dates, never a record's values**");
    expect(help()).toContain(
      'env/<Organization Id>/<name>/ of the folder SANDFORGE_JOURNAL_DIR names (default: ~/.sandforge)',
    );
    expect(state).toContain(
      '`env/<Organization Id>/<name>/` of the journal directory, the folder `SANDFORGE_JOURNAL_DIR` names, `~/.sandforge` by default',
    );
    expect(STATE).toContain('export const ENV_DIR_MODE = 0o700;');
    expect(STATE).toContain('export const ENV_FILE_MODE = 0o600;');
    expect(state).toContain('(`0700`), files too (`0600`)');
    expect(STATE).toContain('export const SCRATCH_STATE_KEEP_DAYS = 30;');
    expect(state).toContain("A scratch org's state is deleted 30 days after its last write");
    expect(STATE).toContain('in CI, $RUNNER_TEMP/sandforge');
    expect(state).toContain('`$RUNNER_TEMP/sandforge`');
    expect(LOCK).toContain(
      'One file per Organization Id, `<organizationId>.env.lock`, in the folder of\n * the checkpoint locks (`~/.sandforge/locks`, whatever `SANDFORGE_JOURNAL_DIR`',
    );
    expect(state).toContain(
      '`~/.sandforge/locks/<Organization Id>.env.lock`, whatever `SANDFORGE_JOURNAL_DIR` says',
    );
    expect(STATE).toContain('A file that does not\n * parse is refused, never guessed');
    expect(state).toContain('A state that does not parse is refused, never guessed');
  });

  it('says what destroy leaves, as the removal and the destroy leave it', () => {
    const limits = section(DOC, '## What destroy takes back, and what it leaves');
    // Positive control: the destroy names what its removals leave, and the seed's sweep its refusal.
    expect(DESTROY).toContain(
      'records others changed since the apply, kept unless `--include-changed`,\n *   which takes them, and what was created under them since;',
    );
    expect(DESTROY).toContain('records that stay because records of the org depend on them;');
    expect(DESTROY).toContain(
      "a person's contact apart from its\n *   account, a lead converted since, a contract activated since.",
    );
    expect(DESTROY).toContain(
      'children deleted before their parent\n * cannot come back with it from the recycle bin.',
    );
    expect(SEED).toContain(
      'Refused when that user\n                         created records in the window on objects neither the\n                         run nor the automation reaches (hand work, likely).',
    );

    expect(limits).toContain(
      'kept unless `--include-changed`, which takes them, and what was created under them since',
    );
    expect(limits).toContain('**Records that stay because records of the org depend on them.**');
    expect(limits).toContain('unless `--sweep` takes it');
    expect(limits).toContain(
      'refused when that user created records in the window that neither the run nor the automation reaches, likely by hand',
    );
    expect(limits).toContain(
      "a person's contact apart from its account, a lead converted since, a contract activated since",
    );
    expect(limits).toContain(
      'children deleted before their parent cannot come back with it from the recycle bin. It is undone by applying again.',
    );
  });

  it('says a stopped run is taken up by the next plan, in the words the plan says it', () => {
    const why =
      "'its last run was stopped part way: what it wrote is taken back from its run file, then it runs again',";
    expect(PLAN).toContain(why);

    expect(section(DOC, '## Stopped part way')).toContain(
      '`replaced: its last run was stopped part way: what it wrote is taken back from its run file, then it runs again`',
    );
    expect(STOP_SIGNALS).toMatch(/SIGHUP: 129,\n\s+SIGINT: 130,\n\s+SIGTERM: 143,/);
  });

  it('gives the exit codes the code ends with, each with the flags the help names for it', () => {
    const constants = [...EXIT_CODES.matchAll(/export const [A-Z_]+_EXIT = (\d+);/g)].map(
      (m) => m[1],
    );
    expect(constants).toEqual(['0', '1', '3', '4']);
    // 2, a bad line, is the command line's own; the stop codes are the signals'.
    expect(CLI).toContain('process.exit(2);');

    const said = /\nExit codes: ([\s\S]*)$/.exec(help())?.[1]?.replace(/\n/g, ' ') ?? '';
    const segments = new Map<string, string>();
    for (const [, code, words] of said.matchAll(
      /(?:^|; )(\d(?:, \d+)*|\d{3}(?:, \d{3})*) ([\s\S]*?)(?=; \d|$)/g,
    )) {
      segments.set(code as string, words as string);
    }
    expect([...segments.keys()]).toEqual(['0', '1', '2', '3', '4', '130, 143, 129']);

    const table = rows(section(DOC, '## Exit codes'));
    expect(table.map(([code]) => ticked(code ?? '').join(', '))).toEqual([...segments.keys()]);
    for (const [code, meaning] of table) {
      const key = ticked(code ?? '').join(', ');
      expect(flagsIn(meaning ?? ''), key).toEqual(flagsIn(segments.get(key) ?? ''));
    }
    // 4 comes from a verification, which no seed run makes.
    expect(SEED).not.toMatch(/UNSTABLE_EXIT|exit\(4\)/);
    expect(table.find(([code]) => code === '`4`')?.[1]).toContain('No seed run verifies');
  });

  it('says what this SandForge does not do yet, as the code refuses it', () => {
    const later = section(DOC, '## Not yet');
    // Every kind of version 1 is applied: none waits for a later SandForge.
    expect(SCHEMA).toContain('const LATER_KINDS: readonly string[] = [];');
    expect(SCHEMA).toContain("const KINDS_APPLIED = 'seed, forge, frozen and mask resources';");
    expect(later).toContain('This version applies seed, forge, frozen and mask resources');
    expect(later).not.toContain('Masking');
    // A plan kept and applied, and what an apply created: no longer not yet.
    expect(commandsRead()).toContain('output');
    expect(flagsOf().get('plan')?.has('--out')).toBe(true);
    expect(flagsOf().get('apply')?.has('--plan')).toBe(true);
    expect(later).toContain('keeps a plan for `apply --plan`, names what an apply created');
    expect(later).not.toMatch(/Saved plans|Outputs/);
    // A lost state is rebuilt from the run files: no longer not yet. What
    // waits is a recovered resource kept, which the plan always replaces.
    expect(CLI).toContain("args[1] === 'recover'");
    expect(later).toContain(
      'names what an apply created, and rebuilds a lost state from the run files the journal directory keeps',
    );
    expect(later).not.toContain('no `state recover`');
    expect(PLAN).toContain('if (kept.recovered === true) {\n      reasons.push(RECOVERED_WHY);');
    expect(later).toContain('the next apply replaces every resource still in the org');
    // A relation's parents may be another resource's records: no longer not yet.
    const parents = checkEnvFile(
      {
        version: 1,
        name: 'e',
        resources: {
          r: {
            kind: 'seed',
            objects: [{ object: 'Contact', count: 1, fields: [] }],
            relations: [
              {
                lookup: 'Contact.AccountId',
                parents: { from: 'accounts', object: 'Account' },
                distribution: { mode: 'perParent', count: 1 },
              },
            ],
          },
        },
      },
      HERE,
    );
    expect('refusals' in parents && parents.refusals[0]?.message).toContain(
      '"accounts" is no resource of this file',
    );
    expect(later).not.toContain('Parents drawn by Id');
    // The MCP server's tools plan, apply and destroy an environment: docs/mcp.md says how.
    expect(source(`${CLI_DIR}/sandforge-mcp.ts`)).toContain("script: 'sandforge-env'");
    expect(later).not.toContain('MCP server');
  });
});

// ─── Checkpoints, and real data ──────────────────────────────────────────────

describe('docs/environments.md: checkpoints, reset, destroy --rewind and real data', () => {
  const CHECKPOINTS = source(`${CLI_DIR}/env/envCheckpoints.ts`);
  const REWIND = source(`${CLI_DIR}/env/envRewind.ts`);
  const FORGE_KIND = source(`${CLI_DIR}/env/kinds/forge.ts`);
  const CLONE = source(`${CLI_DIR}/sandforge-clone.ts`);
  const CHECKPOINT_CLI = source(`${CLI_DIR}/sandforge-checkpoint.ts`);
  const GUARD = source('packages/extension/src/modules/checkpoint/checkpointGuard.ts');
  /** Code with its string literals joined across the lines they are split on. */
  const joined = (code: string): string => code.replace(/['`] \+\n\s+['`]/g, '');

  it('says when each checkpoint is taken, where it is kept, and what deletes it, as the code does', () => {
    const page = section(DOC, '## Checkpoints');
    const pins: Array<[string, string, string]> = [
      [
        CHECKPOINTS,
        'a checkpoint taken once an apply ended 0,\n *   and taken again by the next apply that writes, the one before deleted',
        'is taken once an apply ended `0`, and again by the next apply that writes, the one before deleted',
      ],
      [
        CHECKPOINTS,
        'after !== undefined && (writes || state?.checkpoints?.after === undefined)',
        'An apply that writes nothing takes none, unless the state names none.',
      ],
      [
        CHECKPOINTS,
        'never taken again while the state names it',
        'and never again while the state names it',
      ],
      [
        CHECKPOINTS,
        'return state?.checkpoints?.before === undefined && !holdsWrites(state);',
        'Asked of an environment an earlier apply wrote without one, it is not taken',
      ],
      [
        CHECKPOINTS,
        "return join(journalDir, 'checkpoints');",
        'in `checkpoints/` of the journal directory',
      ],
      [
        CHECKPOINTS,
        "A checkpoint holds the records' values in\n * clear",
        "A checkpoint holds the records' values in clear",
      ],
      [
        CHECKPOINTS,
        "  return kind === 'scratch' ? SCRATCH_STATE_KEEP_DAYS : 0;",
        "a scratch org's for 30 days, any other's until the destroy that deletes them",
      ],
    ];
    for (const [code, said, words] of pins) {
      expect(code, said).toContain(said);
      expect(DOC, words).toContain(words);
    }
    expect(page).toContain(
      '`reset` rewinds the org to it, and `plan` compares the whole org with it.',
    );
    // The guard the take is refused by: the checkpoint script's own.
    expect(GUARD).toContain('A checkpoint needs a user with View All Data and Modify All Data');
    expect(page).toContain(
      "The checkpoint's own guard refuses a production org, a user without View All Data and Modify All Data, and more records than its limit: its refusal is the apply's, before its first write.",
    );
    expect(joined(CHECKPOINTS)).toContain('would be refused: ');
    expect(section(DOC, '## What is refused')).toContain('`would be refused`');
  });

  it('says what reset does, asks and offers, as the rewind and the checkpoint script do', () => {
    const reset = section(DOC, '### Between two suites: `reset`');
    // The question's words.
    expect(REWIND).toContain("`Type ${alias} to reset it to '${preview.checkpoint.name}', as `");
    expect(joined(REWIND)).toContain('back from the recycle bin — whoever made these changes');
    expect(reset).toContain(
      "`Type pool-1 to reset it to 'baseline', as case-flow was applied: it deletes 1 record(s) created since, gives 1 their values back and brings 0 back from the recycle bin — whoever made these changes, last changed by Colleague 2:`",
    );
    // Never with new Ids, and the refusal said so.
    expect(source(`${CLI_DIR}/env/envCheckpoints.ts`)).not.toContain('--accept-recreate');
    expect(joined(REWIND)).toContain('never makes records again with new Ids');
    expect(reset).toContain(
      'It never makes records again with new Ids, which the state would no longer name',
    );
    // The undo, as the checkpoint script offers it: 15 days, its own line.
    expect(joined(CHECKPOINT_CLI)).toContain(
      'Undo is offered for the last rewind of an org, for 15 days after it',
    );
    expect(reset).toContain('for 15 days, sooner if the recycle bin fills');
    expect(joined(CHECKPOINTS)).toContain(
      '`sandforge-checkpoint undo --org ${input.alias} --checkpoint ${input.checkpoint} --store ${envCheckpointStoreOf(input.journalDir)}`',
    );
    // Refused before the org is read.
    expect(joined(REWIND)).toContain('names no checkpoint taken after an apply');
    expect(joined(REWIND)).toContain('Apply again, then reset.');
    expect(reset).toContain('(`names no checkpoint taken after an apply`)');
    // The state stays: a reset writes none.
    expect(REWIND).toContain("if (verb === 'destroy' && exitCode === DONE_EXIT) {");
    expect(reset).toContain('The state stays as it was, its serial too');
  });

  it('says what destroy --rewind takes back and deletes, and that it is not undone, as the rewind does', () => {
    const rewind = section(DOC, '### Back to before the first apply: `destroy --rewind`');
    expect(joined(REWIND)).toContain(
      "the environment's checkpoints are then deleted, and this is not undone:",
    );
    expect(rewind).toContain(
      "the environment's checkpoints are then deleted, and this is not undone:`",
    );
    expect(CHECKPOINTS).toContain('a destroy is undone by applying again');
    expect(rewind).toContain('it is not undone, but by applying again');
    expect(joined(CLI)).toContain('take back records by removal: --rewind takes the whole org');
    expect(rewind).toContain(
      '`--include-changed` and `--sweep` belong to a destroy by removal, and are refused beside `--rewind`',
    );
    expect(source(`${CLI_DIR}/env/envDestroy.ts`)).toContain(
      "Once every resource is taken back, the environment's checkpoints are\n * deleted from this machine",
    );
    expect(section(DOC, '## What destroy takes back, and what it leaves')).toContain(
      "Once every resource is taken back, the environment's checkpoints are deleted from this machine; a destroy that left records keeps them.",
    );
  });

  it('says what a production source needs, the way out in the refusal’s words, and what the clone does to contact points', () => {
    const real = section(DOC, '### Real data from a production org');
    expect(joined(FORGE_KIND)).toContain(
      'Give the resource anonymize — Forge’s anonymization, a method for each category of personal field — or, reviewed in the file, accept: { realData: true }',
    );
    expect(real).toContain(
      '`Give the resource anonymize — Forge’s anonymization, a method for each category of personal field — or, reviewed in the file, accept: { realData: true }`',
    );
    expect(FORGE_KIND).toContain('const production = isProductionTarget(typed);');
    expect(real).toContain('by the rule every guard reads');
    // Refused before the record of its query is read.
    expect(FORGE_KIND).toContain(
      '// Refused before a record of it is read: a query of a production org for',
    );
    expect(real).toContain('It is met before a record of the source is read');
    expect(FORGE_KIND).toContain(
      "? ' Its anonymize sets a method for no category of personal field, so it anonymizes nothing.'",
    );
    expect(real).toContain('One that sets no method anonymizes nothing, and is said so');
    // The clone's own words for what it does to contact points.
    expect(CLONE).toContain(
      "'contact points: neutralized before writing (emails under .invalid, phone numbers in a fictional range)'",
    );
    expect(joined(FORGE_KIND)).toContain(
      'contact points: neutralized before writing (emails under .invalid, phone numbers in a fictional range), as the clone does unless keepContactPoints',
    );
    expect(real).toContain(
      '`contact points: neutralized before writing (emails under .invalid, phone numbers in a fictional range), as the clone does unless keepContactPoints`',
    );
    expect(joined(FORGE_KIND)).toContain('is a production org; ');
    expect(real).toContain(
      '`real data: its source, the prod org (PROD), is a production org; what it clones is anonymized as its anonymize says (name fake, email fake, address mask)`',
    );
  });
});

// ─── The pages that send a reader to the guide ───────────────────────────────

describe('the frozen resource and the references between resources, on the page', () => {
  it('says what a frozen resource is checked by, pinned by and given, in the words of the code that does it', () => {
    const frozen = section(DOC, '### A frozen resource');
    const pins: Array<[string, string, string]> = [
      [
        FROZEN_KIND,
        'frozenProjectConfigPayloadSchema.strict().safeParse(raw)',
        "held to Frozen's own schema, strict, a key it does not name refused",
      ],
      [FROZEN_KIND, 'a load never reads the salt', 'a load never reads the salt'],
      [
        FILE,
        'is inside the repository ${repoRoot} that ',
        'A dataset inside the repository that holds the file is refused, exit `2`',
      ],
      [
        FROZEN_KIND,
        'and the file pins ${pinned.digest}: ',
        "A dataset whose digest or version is not the file's blocks the resource, both named",
      ],
      [
        FROZEN_KIND,
        'dataset: { digest: run.dataset.digest, version: run.dataset.version }',
        'The fingerprint is of the digest, never of the path',
      ],
      [
        FROZEN_KIND,
        "const SET_BY_THE_ENVIRONMENT = ['sasDir', 'datasetDir'] as const;",
        'a `sasDir` or a `datasetDir` the configuration gives is warned of and not used',
      ],
      [FROZEN_KIND, "'--max-total',", 'the run (`load`) is held to that count with `--max-total`'],
      [
        FROZEN_KIND,
        "return `${object.objectApiName} FAILED (${parts.join(', ')})`;",
        'an object it FAILED leaves the resource partial',
      ],
      [
        PLAN,
        'its verification: ${held.verified',
        'an object FAILED, a record gone or changed since, and the resource is drifted',
      ],
      [
        FROZEN_KIND,
        "...(input.reload ? ['--reload'] : []),",
        'the replace is one run, `load --reload`',
      ],
      [FROZEN_KIND, "'may-hold-masks'", 'a field the target encrypts that may hold masks'],
      [
        FROZEN_KIND,
        'a Frozen load and its removal take no acceptance of automation',
        '`accept: { automation: true }` on a frozen resource is warned of',
      ],
    ];
    for (const [code, said, page] of pins) {
      expect(code, said).toContain(said);
      expect(frozen, page).toContain(page);
    }
  });

  it('says where the ids of a reference are read from, how many, and when they are counted exactly, as the references and the plan do', () => {
    const references = section(DOC, '### References between resources');
    const pins: Array<[string, string, string]> = [
      [
        REFERENCES,
        "a seed's run file, written as the org took each record, or the\n * summary it printed",
        "a seed's run file or its summary",
      ],
      [REFERENCES, 'never one it linked to', 'never those it linked to'],
      [
        REFERENCES,
        'the records its mapping in the sas lists among\n * its creations',
        "a Frozen load's mapping in its sas",
      ],
      [
        REFERENCES,
        "more than the ${most} a relation's parents hold: give the",
        'refuses the relation unless it gives `limit`',
      ],
      [
        SCHEMA,
        'limit goes with from: existing parents take their own, under existing',
        '`limit` goes with `from`',
      ],
      [
        FILE,
        'Take one of them out of the dependsOn of the next, or out of what its relations draw their parents from.',
        'a circle of dependencies, through `dependsOn` or `from`, are refused',
      ],
      [
        FILE,
        'writes no ${draw.relation.parentObject} records: it writes',
        'so is a seed resource drawn from for an object it does not write',
      ],
      [
        PLAN,
        'which nobody knows before it runs: counted at most as the file gives it',
        'the plan counts the drawing resource at most as the file gives it, and says so',
      ],
      [
        PLAN,
        '`the ${draw.object} records ${draw.from} creates first`',
        '`draws its parents from the Account records claims creates first`',
      ],
      [
        PLAN,
        '`the ${draw.parents} ${draw.object} record(s) ${draw.from} created`',
        '`draws its parents from the 3 Account record(s) claims created`',
      ],
      [
        PLAN,
        'the resources it depends on run again, with new records',
        '`the resources it depends on run again`',
      ],
      [
        SEED_KIND,
        'parents named by id no\n * longer in the org',
        "one deleted since refuses the run, in the seed's words",
      ],
    ];
    for (const [code, said, page] of pins) {
      expect(code.replace(/[`'] \+\n\s+[`']/g, ''), said).toContain(said);
      expect(references, page).toContain(page);
    }
    // Positive control: a draw is a dependency, and the page says so.
    expect(FILE).toContain('...drawnFrom(name, resource).map(({ from }) => from),');
    expect(references).toContain('`from` makes the resource depend on the one it draws from');
  });
});

describe('the mask resource, on the page', () => {
  const REWIND_CODE = source(`${CLI_DIR}/env/envRewind.ts`);
  /** Code with its string literals joined across the lines they are split on. */
  const joined = (code: string): string => code.replace(/['`] \+\n\s+['`]/g, '');

  it('says what a mask resource is checked by, takes first, keeps and leaves, in the words of the code that does it', () => {
    const mask = section(DOC, '### A mask resource');
    const pins: Array<[string, string, string]> = [
      [
        MASK_KIND,
        'anonymizationTemplateSavePayloadSchema.safeParse({ name, rules: set.rules })',
        "each rule as the DataOps panel saves a template's and held to that save",
      ],
      [
        MASK_KIND,
        'has no rule for ${object}: a run would mask nothing',
        'A rule set with no rule for its object is refused before any org is reached, exit `2`',
      ],
      [
        DATAOPS,
        'and writes nothing unless the snapshot holds every one of\nthem',
        'and writes nothing unless the snapshot holds every one of them',
      ],
      [MASK_KIND, 'return `dataops/${resource}`;', '`dataops/<resource>/` beside the state'],
      [
        MASK_KIND,
        'missingFieldLine(missing.objectApiName, missing.fieldApiName)',
        "blocks the resource, in the script's own words",
      ],
      [
        MASK_KIND,
        'its condition selects other records than it masked',
        'once it selects others -- records copied in since, which hold their own values --, it is drifted',
      ],
      [
        MASK_KIND,
        'and takes nothing back first: the values they held before any masking stay only in',
        "taking nothing back first: the values they held before any masking stay only in the first run's snapshot",
      ],
      [
        MASK_KIND,
        'await rm(dir, { recursive: true, force: true });',
        'delete its store, its snapshots with it',
      ],
      [
        SCHEMA,
        'a file with a mask resource takes none',
        'A file with a mask resource takes no `checkpoint.before`, exit `2`',
      ],
      [
        REWIND_CODE,
        "code: 'MASKED',",
        '`destroy --rewind` is refused while the state names a mask resource',
      ],
      [
        APPLY,
        "if (before.kind === 'mask') return forgetMask(deps, state, ask);",
        'and an apply of a file it left, delete its store',
      ],
    ];
    for (const [code, said, page] of pins) {
      expect(joined(code), said).toContain(said);
      expect(mask, page).toContain(page);
    }
    // The refusals the page quotes, in the code's words.
    const refused = section(DOC, '## What is refused');
    const quoted: Array<[string, string]> = [
      ['a run would mask nothing', MASK_KIND],
      ['destroy never unmasks', REWIND_CODE],
    ];
    for (const [words, code] of quoted) {
      expect(refused, words).toContain(`\`${words}\``);
      expect(joined(code), words).toContain(words);
    }
    // The help says it, and the page of what destroy leaves.
    expect(help()).toContain("destroy never unmasks: it deletes the resource's store");
    expect(section(DOC, '## What destroy takes back, and what it leaves')).toContain(
      'A mask resource is never unmasked: its store is deleted',
    );
  });

  it('names a DataOps template that ships, as the check names them', () => {
    const read = checkEnvFile(
      {
        version: 1,
        name: 'e',
        resources: { r: { kind: 'mask', rules: { template: 'tpl-none' } } },
      },
      HERE,
    );
    const refusal = 'refusals' in read ? (read.refusals[0]?.message ?? '') : '';
    const ids = /there is no DataOps template "tpl-none" that ships: there is (.+)$/
      .exec(refusal)?.[1]
      ?.split(', ');
    expect(ids?.length).toBeGreaterThan(2);
    expect(ids).toContain('tpl-gdpr-standard');
    expect(section(DOC, '### A mask resource')).toContain('`{ template: tpl-gdpr-standard }`');
  });

  it('gives an example file that passes the check validate runs: a sandbox listed, a set of rules, a mask resource', () => {
    const read = documentOf(maskExample());
    if (!('document' in read)) throw new Error(read.refusal);
    const checked = checkEnvFile(read.document, HERE);
    if ('refusals' in checked) {
      throw new Error(checked.refusals.map((r) => `${r.path.join('.')}: ${r.message}`).join('\n'));
    }
    expect(checked.checked.runs['customers']).toMatchObject({
      kind: 'mask',
      source: { set: 'contact-points' },
      object: 'Contact',
    });
    // Its condition asks whether a field is empty: the masking keeps it selected.
    expect(checked.checked.warnings).toEqual([]);
  });
});

describe('saved plans, outputs and the reason of a step, on the page', () => {
  const SAVED = source(`${CLI_DIR}/env/envSavedPlan.ts`);
  const OUTPUT = source(`${CLI_DIR}/env/envOutput.ts`);
  /** Code with its string literals joined across the lines they are split on. */
  const joined = (code: string): string => code.replace(/['`] \+\n\s+['`]/g, '');

  it('says what a saved plan keeps, where, for how long, and what refuses it, in the words of the code that does it', () => {
    const saved = section(DOC, '## Saved plans: `plan --out` and `apply --plan`');
    const pins: Array<[string, string, string]> = [
      [
        SAVED,
        "if ('answer' in dry && dry.answer.tool === SEED_SCRIPT) seeds[name] = dry.answer.seed;",
        'and the seeds its dry runs drew, so that a seed resource that pins none draws the same records again',
      ],
      [CLI, 'planOf(prepared, applied, say, signal, saved?.seeds)', 'the same seeds'],
      [
        CLI,
        'const differences = planDifferences(saved.plan, plan);',
        'applies only when the plan it makes is the one kept, action by action and count by count',
      ],
      [
        joined(CLI),
        '--plan applies the plan with the switches plan --out was given',
        '`apply --plan` takes the switches the plan was made with, and refuses them on its own line',
      ],
      [
        SAVED,
        "code: 'PLAN_IN_REPOSITORY',",
        'A file inside the repository is refused, exit `2`, before any org is reached, unless `--out-in-repository`',
      ],
      [SAVED, 'export const SAVED_PLAN_KEEP_MS = 24 * 60 * 60_000;', '**For a day**'],
      [
        SAVED,
        'if (saved.sandforgeVersion !== context.sandforgeVersion) {',
        'by the SandForge that made it',
      ],
      [
        joined(SAVED),
        'names the org by its Organization Id, its state, and the users who changed its records since',
        'a plan names the org by its Organization Id, its state, and the users who changed its records since',
      ],
      [
        SAVED,
        "code: 'PLAN_UNREAD',",
        'A file that is no plan `plan --out` kept is refused, exit `2`',
      ],
    ];
    for (const [code, said, page] of pins) {
      expect(code, said).toContain(said);
      expect(saved, page).toContain(page);
    }
    // The refusals the page quotes, in the code's words.
    for (const words of [
      'a plan is applied to the org it was made for',
      'the file, or a variable or an alias it reads, changed since',
      'an apply or a destroy ran since, or a cache put back another state',
      'was refused when it was made',
    ]) {
      expect(saved, words).toContain(`\`${words}\``);
      expect(joined(SAVED), words).toContain(words);
    }
    // What the schema holds: strict, no key it does not name.
    expect(SCHEMA).toContain('export const envSavedPlanSchema = z.strictObject({');
    expect(saved).toContain('read back by a strict schema');
    expect(section(DOC, '## What is refused')).toContain(
      '[Saved plans](#saved-plans-plan---out-and-apply---plan)',
    );
  });

  it('says what output names, from where, for a resource taken back, a masking and one not applied whole, in the words it prints', () => {
    const output = section(DOC, '### What it created: `output`');
    const pins: Array<[string, string, string]> = [
      [
        OUTPUT,
        'const created = await createdByRun(last, where, deps);',
        'It reaches no org, and runs no script',
      ],
      [
        REFERENCES,
        'export async function createdByRun(',
        "a seed's run file or its summary, a clone's summary, a Frozen load's mapping in its sas",
      ],
      [OUTPUT, "code: 'TWO_STATES',", 'two states under one alias'],
      [
        CLI,
        'return { answer, code: whole ? DONE_EXIT : PARTIAL_EXIT };',
        '`output` then exits `3`',
      ],
      [
        OUTPUT,
        'What it names is what the runs kept, not what the org holds now',
        '**What the runs kept, not what the org holds**: a record deleted since is still named',
      ],
    ];
    for (const [code, said, page] of pins) {
      expect(code, said).toContain(said);
      expect(output, page).toContain(page);
    }
    for (const words of [
      "taken back by a destroy: none of the org's records is its",
      'a masking creates no record: it writes over those the org holds that its condition selects',
    ]) {
      expect(output, words).toContain(`\`${words}\``);
      expect(joined(OUTPUT), words).toContain(words);
    }
  });

  it('says a step its script refused carries why, in the script’s words, as the apply reads it', () => {
    expect(APPLY).toContain('A script refused before its first write prints nothing on stdout');
    expect(APPLY).toContain('const said = answered ?? (ended ? undefined : reasonLineOf(stderr));');
    expect(section(DOC, '### Apply it: `apply`')).toContain(
      "for a step its script refused or failed, why, in the script's own words, under `refusal`: what its answer says, or else the last line it said on stderr",
    );
  });
});

describe('state recover, on the page', () => {
  const RECOVER = source(`${CLI_DIR}/env/envRecover.ts`);
  const recover = (): string => section(DOC, '## When the state is lost: `state recover`');

  it('says what state recover reads, takes back on proof alone, replaces and refuses, in the words of the code that does it', () => {
    const page = recover();
    // Anchors: the readers and the proofs the module's comment names, and the plan's reason.
    expect(RECOVER).toContain('seedRemovalTookAll(file.run)');
    expect(RECOVER).toContain('earlier.earlier?.removalLeft?.length === 0');
    expect(RECOVER).toContain('loadRecordsLeft(load).length === 0');
    expect(RECOVER).toContain('const forgotten = !found.dataops.has(resource);');
    expect(RECOVER).toContain('reloadPurgedWhole(answer)');
    expect(PLAN).toContain(
      "'its state was recovered from its run files, which do not say what it was applied from'",
    );
    expect(page).toContain(
      '`replaced: its state was recovered from its run files, which do not say what it was applied from`',
    );
    expect(page).toContain('`seed-runs/env-<name>-<resource>-<n>-<uuid>.ndjson`');
    expect(STATE).toContain(
      'return `env-${parsedName(env)}-${parsedName(resource)}-${parsedRunNumber(n)}-${uuid}`;',
    );
    // The refusal of an apply with no state names it when the runs are kept.
    expect(GUARDS).toContain("'rebuilds the state from them'");
    expect(page).toContain('`sandforge-env state recover rebuilds the state from them`');
    // A damaged state, set aside, never deleted.
    expect(STATE).toContain('let aside = `${file}.damaged-${when}`;');
    expect(page).toContain('`state.json.damaged-<when>`');
    expect(STATE).toContain(
      "'recover: it sets this file aside and rebuilds the state from the run files beside it.'",
    );
    // Written at serial 1, under a lineage of its own.
    expect(RECOVER).toContain('await deps.store.write(next, { serial: 0, lineage: next.lineage })');
    expect(page).toContain('The state is written at serial 1');
    // Each refusal it does not replay, in the code's words.
    for (const words of [
      'update it, and plan again',
      'Put it back where it came from',
      'One rank is one run',
      'it may be another environment',
      'there is nothing to rebuild a state from',
    ]) {
      expect(page, words).toContain(words);
      expect(`${RECOVER}${STATE}`.replace(/[`'] \+\n\s+[`']/g, ''), words).toContain(words);
    }
    // The checkpoints: by name and date alone.
    expect(RECOVER).toContain('const beforeName = `${file.name} before`;');
    expect(page).toContain('named `<name> before` taken before the first run');
  });
});

describe('the pages that send a reader to docs/environments.md', () => {
  const GUIDE = source('ci-examples/README.md');
  const PIPELINE = source('ci-examples/github-actions.yml');

  /** The commented-out lines of the pipeline, their comment mark taken off. */
  const commented = PIPELINE.split('\n')
    .filter((line) => /^\s*# ?/.test(line))
    .map((line) => line.replace(/^\s*# ?/, ''))
    .join('\n');

  /** The commented-out jobs of the pipeline: what follows their header. */
  function envJobs(): string {
    const start = commented.indexOf('── An environment as code (sandforge-env), commented out');
    if (start === -1) throw new Error('the pipeline has no commented sandforge-env jobs: re-point');
    return commented.slice(start);
  }

  it('the CI guide runs the script from the checkout, the state outside the repository, one org at a time', () => {
    const env = section(GUIDE, '## An environment as code');
    // Positive control: the code it describes. The store refused inside the
    // repository, exit 2, but for validate; a lock per org per machine.
    expect(GUARDS).toContain("? { code: 'STORE_IN_REPOSITORY', message: refusal, exit: 2 }");
    expect(CLI).toContain(
      'const opened = openEnvStore({ journalDir, fileFolder: dirname(args.file) });',
    );
    expect(APPLY).toContain('acquireEnvLock');
    expect(DESTROY).toContain('acquireEnvLock');
    expect(LOCK).toContain('Two machines applying to one org at once are not kept apart');

    expect(env).toContain('](../docs/environments.md)');
    expect(env).toContain(
      'or every command but `validate` refuses, exit `2`: on GitHub Actions, `$RUNNER_TEMP/sandforge`',
    );
    expect(env).toContain(
      'in a cache keyed by the org, restored before the first command and saved after the last',
    );
    expect(env).toContain('two machines applying to one org at once are not kept apart');
    expect(env).toContain('**In a pull request, `plan --fail-on-drift`.**');
    expect(env).toContain('**Around the tests, `apply --yes`, then `destroy --yes`.**');
    expect(env).toContain('with no state it is warned of, not refused');
    const read = new Set([...flagsOf().values()].flatMap((set) => [...set]));
    expect([...flagsIn(env)].filter((flag) => !read.has(flag))).toEqual([]);
  });

  it('the CI guide names the environment among the scripts its bullets and exit codes cover', () => {
    expect(GUIDE).toContain(
      "so does `sandforge-env`'s: `plan`, `apply` and `destroy` refuse a production org, and a sandbox its file does not list by its Organization Id, before they read anything, with exit code `1`, and `validate`, `state` and `output` never contact an org",
    );
    expect(GUIDE).toContain(
      "An environment's `apply` and `destroy` ask for the alias typed too, and with no terminal and no `--yes` stop at the question, exit `2`, having written nothing",
    );
    const table = rows(section(GUIDE, '## Exit codes'));
    const said = (code: string): string => table.find(([cell]) => cell === code)?.[1] ?? '';
    expect(said('`0`')).toContain(
      "an environment's `plan` is `0` whatever it found, unless `--fail-on-change` or `--fail-on-drift`",
    );
    expect(said('`1`')).toContain('no state without `--accept-no-state`');
    expect(said('`2`')).toContain('a journal directory inside the repository that holds the file');
    expect(said('`3`')).toContain(
      'its `plan` found changes with `--fail-on-change` or drift with `--fail-on-drift`',
    );
    expect(said('`130`, `143`, `129`')).toContain(
      '`apply` or `destroy` again takes up from the state',
    );
  });

  it('the commented jobs run only commands and flags the script reads, the state outside the workspace and cached by org, in one concurrency group', () => {
    const jobs = envJobs();
    const commands = commandsRead();
    const flags = flagsOf();
    const calls = [...jobs.matchAll(/sandforge-env\.ts ([a-z]+) \\\n\s+([^\n]+)/g)].map((m) => ({
      command: m[1] as string,
      line: m[2] as string,
    }));
    expect(calls.map((c) => c.command)).toEqual(['plan', 'apply', 'plan', 'destroy']);
    for (const { command, line } of calls) {
      expect(commands).toContain(command);
      const read = flags.get(command) ?? new Set<string>();
      expect(
        [...flagsIn(line)].filter((flag) => !read.has(flag)),
        line,
      ).toEqual([]);
      expect(line).toContain('--file ../sandforge.yaml --org ci-env');
    }
    expect(calls.find((c) => c.command === 'plan')?.line).toContain('--fail-on-drift');

    // Outside the workspace, which holds the file's repository.
    expect(
      jobs.match(/echo "SANDFORGE_JOURNAL_DIR=\$RUNNER_TEMP\/sandforge" >> "\$GITHUB_ENV"/g),
    ).toHaveLength(2);
    // Cached by org: restored in both jobs, saved whatever the job came to.
    const key = 'key: sandforge-env-${{ vars.SF_ENV_USERNAME }}-${{ github.run_id }}';
    expect(jobs.split(key)).toHaveLength(4);
    expect(jobs.match(/uses: actions\/cache\/restore@v4/g)).toHaveLength(2);
    expect(jobs).toMatch(/uses: actions\/cache\/save@v4\n\s+if: always\(\)/);
    // One concurrency group, keyed by the org, never cancelling a job under way.
    expect(
      jobs.match(
        /concurrency:\n\s+group: sandforge-env-\$\{\{ vars\.SF_ENV_USERNAME \}\}\n\s+cancel-in-progress: false/g,
      ),
    ).toHaveLength(2);
    // Nothing of the jobs runs: every line of them is commented out.
    expect(PIPELINE).not.toMatch(/^\s+[^#\s][^\n]*sandforge-env/m);
  });

  it('the README paragraph and the FAQ answer link the guide, and say what the help says', () => {
    const readme = section(source('README.md'), '## Test data as code, for the command line & CI');
    const faq = section(
      source('docs/faq.md'),
      '### Can I describe test data in a file my CI applies?',
    );
    // Positive control: the promises both make are the help's.
    expect(help()).toContain('A production org is refused before anything is read, exit 1.');
    expect(help()).toContain('applied again, it writes\n            nothing');

    expect(readme).toContain('](docs/environments.md)');
    expect(readme).toContain('A production org is refused before anything is read.');
    expect(readme).toContain('applied again, writes nothing');
    expect(faq).toContain('](environments.md)');
    expect(faq).toContain('refuses a production org before anything is read');
    expect(faq).toContain("ids, counts and dates, never a record's values");
    expect(faq).toContain('and a mask resource masks records the org already holds');
    expect(faq).not.toContain('masking is not yet among them');
  });

  it('the FAQ names the states and the locks among what SandForge keeps on the machine', () => {
    const kept = section(source('docs/faq.md'), '### What does SandForge keep on my machine?');
    // Positive control: the states go to env/ of the journal directory, the
    // locks to the folder of the checkpoint locks.
    expect(STATE).toContain("return dirname(toolStoreOf('env', env));");
    expect(LOCK).toContain('in the folder of\n * the checkpoint locks (`~/.sandforge/locks`');

    expect(kept).toContain(
      'the states of `sandforge-env`, in `env/` beside them, ids, counts and dates only',
    );
    expect(kept).toContain(
      "an environment's apply or its destroy writes to, in `~/.sandforge/locks/`",
    );
  });
});
