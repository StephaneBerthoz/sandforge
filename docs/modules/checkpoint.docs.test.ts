/**
 * Doc/code drift guard for the Checkpoint & Rewind page, and for the lines the
 * two READMEs and the command-line guide give the module.
 *
 * A rewind deletes what was created since a checkpoint, whoever created it,
 * so what its page says it leaves alone is read as a promise. Three promises
 * were once made on the page before the code kept them, or the other way
 * round: the cap that leaves out an object past the take's limit, the email
 * count against a Developer Edition's fifteen a day, and the preview's count
 * of contracts activated since. Each is held here to the code that keeps it.
 * The command line's help is printed whole on the page, so it is held to the
 * script's own text, word for word, with the two defaults it interpolates.
 *
 * Each test states the code it depends on, and fails first if that code moved:
 * an assertion about a page that no longer works this way proves nothing.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

// Normalised: the assertions below are LF-anchored and miss on a CRLF checkout.
const DOC = readFileSync(resolve(HERE, 'checkpoint.md'), 'utf8').replace(/\r\n/g, '\n');

function source(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8').replace(/\r\n/g, '\n');
}

const MODULE_DIR = 'packages/extension/src/modules/checkpoint';
const CLI = source('packages/extension/cli/sandforge-checkpoint.ts');
const PANEL_HOST = source('packages/extension/cli/panelHost.ts');
const STORE = source(`${MODULE_DIR}/OrgCheckpointStore.ts`);
const TAKE = source(`${MODULE_DIR}/takeCheckpoint.ts`);
const SCOPE = source(`${MODULE_DIR}/checkpointScope.ts`);
const GUARD = source(`${MODULE_DIR}/checkpointGuard.ts`);
const DIFF = source(`${MODULE_DIR}/rewindDiff.ts`);
const REWIND = source(`${MODULE_DIR}/rewindOrg.ts`);
const UNDO = source(`${MODULE_DIR}/undoCheckpoint.ts`);
const JOURNAL = source(`${MODULE_DIR}/rewindJournal.ts`);
const PREVIEW = source(`${MODULE_DIR}/previewCheckpoint.ts`);
const ESTIMATE = source(`${MODULE_DIR}/rewindEstimate.ts`);
const HANDLER = source('packages/extension/src/bridge/handlers/CheckpointHandler.ts');
const EXTENSION_HANDLERS = source('packages/extension/src/bridge/ExtensionHandlers.ts');
const EXTENSION = source('packages/extension/src/extension.ts');
const TYPES = source('packages/shared/src/types/checkpoint.types.ts');
const SIDE_PANEL = source('packages/webview/src/SidePanel.tsx');
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

/** A label as the page writes it: the org it names becomes `\<org\>`, as Markdown escapes it. */
function asWritten(text: string): string {
  return text.replace('{{org}}', '\\<org\\>');
}

/** The number an `export const NAME = …;` holds, `500_000` and `24 * 60 * 60_000` read too. */
function constant(text: string, name: string): number {
  const match = new RegExp(`(?:export )?const ${name} = ([0-9_ *]+);`).exec(text);
  if (!match) throw new Error(`${name} is gone: re-point this test`);
  return match[1]
    .split('*')
    .map((factor) => Number(factor.trim().replaceAll('_', '')))
    .reduce((product, factor) => product * factor, 1);
}

/** The body of a `## ` (or deeper) section, up to the next heading of its level or above. */
function section(text: string, heading: string): string {
  const level = /^#+/.exec(heading)?.[0].length ?? 2;
  const start = text.indexOf(`${heading}\n`);
  if (start === -1) throw new Error(`"${heading}" is missing`);
  const rest = text.slice(start + heading.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return next === -1 ? rest : rest.slice(0, next);
}

/** Prose only: every fenced block of a page dropped. */
function prose(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '');
}

/** The script's HELP as `--help` prints it: its two interpolated defaults resolved. */
function helpAsPrinted(): string {
  const help = /const HELP = `([\s\S]*?)`;/.exec(CLI)?.[1];
  if (!help) throw new Error('sandforge-checkpoint.ts has no HELP text: re-point this test');
  const printed = help
    .replaceAll('${DEFAULT_MAX_TOTAL}', String(constant(TAKE, 'DEFAULT_MAX_TOTAL')))
    .replaceAll('${DEFAULT_KEEP_DAYS}', String(constant(STORE, 'DEFAULT_KEEP_DAYS')));
  if (printed.includes('${')) {
    throw new Error('HELP interpolates a value this test does not resolve: add it above');
  }
  return printed;
}

/** The flags the command line reads, every command together, from its table of flags. */
function flagsRead(): Set<string> {
  const table = /const COMMON[\s\S]*?\n\};\n[\s\S]*?const FLAGS[\s\S]*?\n\};\n/.exec(CLI)?.[0];
  if (!table) throw new Error('the flags table of sandforge-checkpoint.ts is gone');
  const read = new Set([...table.matchAll(/'(--[a-z][a-z-]*)'/g)].map((m) => m[1]));
  // `--help` is read before the table, by every command and none.
  if (CLI.includes("if (args.includes('--help') || args.includes('-h')) {")) read.add('--help');
  return read;
}

/** The commands the command line reads, from its own list. */
function commandsRead(): string[] {
  const list = /const COMMANDS = \[([^\]]*)\] as const;/.exec(CLI)?.[1];
  if (!list) throw new Error('COMMANDS is gone from sandforge-checkpoint.ts');
  return [...list.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
}

/** The members of a string-literal union type `name` of `text`. */
function unionOf(text: string, name: string): string[] {
  const body = new RegExp(`export type ${name} =([\\s\\S]*?);`).exec(text)?.[1];
  if (!body) throw new Error(`${name} is gone: re-point this test`);
  return [...body.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]);
}

describe('docs/modules/checkpoint.md', () => {
  it('prints the --help text the script prints, word for word', () => {
    const help = helpAsPrinted();
    // Positive control: the text is the help, its six commands and its exit codes.
    expect(help).toContain('Commands:');
    expect(help).toContain('Exit codes: 0 done');
    expect(constant(TAKE, 'DEFAULT_MAX_TOTAL')).toBe(500_000);
    expect(constant(STORE, 'DEFAULT_KEEP_DAYS')).toBe(30);

    const block = /### Every flag\n[\s\S]*?```text\n([\s\S]*?)\n```/.exec(DOC)?.[1];
    expect(block).toBeDefined();
    expect(block).toBe(help.replace(/\n$/, ''));
  });

  it('names each command the script reads in its table, and no other', () => {
    const commands = commandsRead();
    expect(commands).toEqual([
      'take',
      'list',
      'preview',
      'rewind',
      'undo',
      'delete',
      'export',
      'import',
    ]);

    const table = section(DOC, '## From the command line');
    const rows = [...table.matchAll(/^\| `([a-z]+)` +\|/gm)].map((m) => m[1]);
    expect(rows).toEqual(commands);
  });

  it('names in its prose only flags the command line reads', () => {
    const read = flagsRead();
    // Positive control: the flags of a take, a rewind and a delete are all there.
    for (const flag of ['--estimate', '--accept-no-undo', '--accept-outside', '--all', '--store']) {
      expect(read.has(flag)).toBe(true);
    }
    const named = new Set([...prose(DOC).matchAll(/(?<![\w-])(--[a-z][a-z-]*)/g)].map((m) => m[1]));
    expect(named.size).toBeGreaterThan(8);
    expect([...named].filter((flag) => !read.has(flag))).toEqual([]);
  });

  it('says a rewind or an undo that does not ask needs its checkpoint named, latest refused', () => {
    // Positive control: the command line refuses --yes without a named checkpoint, and latest.
    expect(CLI).toContain('const namedForYes = (checkpoint: string | undefined): void => {');
    expect(CLI).toContain("if (checkpoint === 'latest') {");

    expect(DOC).toContain(
      '`rewind --yes` and `undo --yes`, which do not ask, need it named by its id or its name',
    );
    expect(DOC).toContain('without `--checkpoint`, the rewind of the checkpoint the last rewind');
  });

  it('says the command line rewinds from the preview it shows, and the panel from a fresh read', () => {
    // Positive control: the command line switches the handler to the preview
    // it answered; the panel's rewind reads the org again before it plans.
    expect(CLI).toContain('wiring.handlers.rewindCheckpointsFromPreviewsAnswered();');
    expect(REWIND).toContain('the first pass is planned');

    expect(DOC).toContain('then rewinds from that preview as it read the org');
    expect(DOC).toContain(
      'The rewind then reads the org again and acts on what you confirmed that still differs',
    );
  });

  it('says what the write check of the command line sees, and what the panel adds to it', () => {
    // Positive control: the panel hands the checkpoint the files of Sync and
    // Seed runs, and asks the handlers of the window's other writing runs;
    // the command line's host wires neither, and is left with the org's lock.
    expect(EXTENSION_HANDLERS).toContain("this.checkpointHandler.setRunFiles('sync', store);");
    expect(EXTENSION_HANDLERS).toContain("this.checkpointHandler.setRunFiles('seed', store);");
    expect(HANDLER).toContain('for (const files of [this.syncRuns, this.seedRuns]) {');
    expect(HANDLER).toContain('if (this.writers.writingTo?.(orgId) === true) return words;');
    const asked = /writingTo: \(orgId\) =>([^}]*)\}\);/.exec(EXTENSION_HANDLERS)?.[1] ?? '';
    const handlers = [...asked.matchAll(/this\.(\w+)Handler\.isWritingTo\(orgId\)/g)].map(
      (m) => m[1],
    );
    expect(handlers).toEqual(['forge', 'frozen', 'dataOps', 'compliance', 'autopilot', 'realtime']);
    for (const text of [CLI, PANEL_HOST]) {
      expect(text).not.toMatch(/setSyncRunCreations|setSeedRunCreations|setRunFiles/);
    }

    expect(DOC).toContain("**What its write check sees**: the org's lock alone.");
    expect(DOC).toContain('the runs the panel sees writing to the org are not seen here');
    expect(DOC).toContain(
      'In the panel, a run of the window writing to the org -- a Forge clone, a Frozen load or ' +
        'its removal, a DataOps restore, masking run or erasure, an Autopilot run, a Real-Time ' +
        'session that applies what it receives -- and a Sync or Seed run',
    );
  });

  it('refuses a production org with nothing to lift it, and asks for both permissions', () => {
    // Positive control: the guard says no override reaches it, and reads the two permissions.
    expect(GUARD).toContain('So nothing lifts this refusal');
    expect(GUARD).toContain("{ field: 'PermissionsViewAllData', label: 'View All Data' },");
    expect(GUARD).toContain("{ field: 'PermissionsModifyAllData', label: 'Modify All Data' },");

    expect(DOC).toContain('no setting or flag lifts the refusal');
    expect(DOC).toContain('needs **View All Data and Modify All Data**');
    expect(DOC).toContain("**Production orgs, and any org other than the checkpoint's own**");
  });

  it("reads the edition from the org and from SandForge's list of orgs, which it names as such", () => {
    // Positive control: the guard asks the registry first, then the org itself.
    expect(GUARD).toContain(
      'The org passes only when the registry\n * (`isDevelopmentOrg`) and the org itself (`typeTarget`) both say it is a',
    );

    expect(DOC).toContain(
      "the edition is read from the org itself as well as from SandForge's list of orgs",
    );
    // "The registry" read as a feature of Salesforce.
    expect(prose(DOC)).not.toMatch(/\bthe registry\b/);
  });

  it('gives the windows and limits the code keeps', () => {
    // Positive control: the figures, as the store, the take and the rewind hold them.
    expect(constant(STORE, 'RECYCLE_BIN_DAYS')).toBe(15);
    expect(constant(STORE, 'EXPIRY_WARNING_DAYS')).toBe(3);
    expect(constant(STORE, 'PREVIEW_KEEP_MS')).toBe(24 * 60 * 60_000);
    expect(REWIND).toContain('const UNDO_WINDOW_MS = RECYCLE_BIN_DAYS * 24 * 60 * 60_000;');
    // The take refuses past one total, and leaves out whole an object past
    // its limit for one object: the total, a million at most.
    expect(TAKE).toContain("code: 'TOO_MANY_RECORDS',");
    expect(constant(TAKE, 'OBJECT_ROWS_MAX')).toBe(1_000_000);
    expect(TAKE).toContain('const objectLimit = Math.min(maxTotal, OBJECT_ROWS_MAX);');
    expect(TAKE).toContain(
      'leftOut.push(pastTheLimit(scoped.objectApiName, records, objectLimit));',
    );
    expect(section(DOC, '## Taking a checkpoint')).toContain(
      "an object holding more records than the take's limit, left out whole rather than kept in part",
    );

    expect(DOC).toContain('for 30 days unless you keep it');
    expect(DOC).toContain('three days before its date, with **Keep**');
    expect(DOC).toContain('once the checkpoint is more than 15 days old');
    expect(DOC).toContain('It is offered for the last rewind of an org, for 15 days after it');
    // The undo's window is fixed; only what the rewind deleted hangs on the bin.
    expect(section(DOC, '## The preview')).toContain(
      'so you can undo it for 15 days, and what it deletes comes back with the undo while the ' +
        'recycle bin holds it: 15 days, less if it fills',
    );
    expect(DOC).not.toContain('sooner if the recycle bin fills');
    expect(DOC).toContain("A preview's reads are kept a day.");
    expect(DOC).toContain(
      "more records than the take's limit (500,000 unless the command line names another)",
    );
  });

  it('says a checkpoint past the recycle bin’s days loses only the Ids of what was deleted before a date, the rest of a rewind unbound by it', () => {
    // Anchor: the list's date is the bin's reach from now, and only a record
    // the bin no longer gives back is made again, with a new Id, once accepted.
    expect(STORE).toContain('const reach = now - RECYCLE_BIN_DAYS * DAY_MS;');
    expect(STORE).toContain(
      'return Date.parse(checkpoint.readFrom) < reach ? new Date(reach).toISOString() : undefined;',
    );
    expect(REWIND).toContain(
      'if (notMade.length > 0) return { rewound: false, refusal: recreateRefusal(notMade) };',
    );

    const list = section(DOC, '## The list');
    expect(list).toContain(
      '- The date before which deleted records can no longer come back with their Id, once the ' +
        'checkpoint is more than 15 days old',
    );
    expect(list).toContain('a rewind makes them again, with new Ids, once you accept it');
    expect(list).toContain(
      'The rest of a rewind is not bound to that date: it works for as long as the checkpoint is kept.',
    );
  });

  it('lists what a checkpoint leaves out, one kind for each reason the scope gives', () => {
    const said: Record<string, string> = {
      excludedByUser: "an object the command line's `--exclude-object` names",
      notFound: 'an object picked that the org does not have',
      notCustomSetting: 'a custom setting picked that the org does not have',
      chatter: 'Chatter posts, comments and their attachments',
      history: 'history, sharing and change-event objects',
      sharing: 'history, sharing and change-event objects',
      changeEvent: 'history, sharing and change-event objects',
      unsupportedKind:
        'big objects, external objects, Data Cloud objects, Knowledge article versions and platform events',
      customSetting: 'custom settings, which are configuration',
      files: 'the documents of the Documents tab, shared content kept in folders',
      heldWithFiles: "a file's versions and links, listed there as held with their file",
      setup: 'users, permissions and the rest of setup',
      metadata: 'metadata, which is deployed rather than kept as data',
      notWritable: 'an object the user may not query, create, edit and delete',
      notDescribed: 'an object the org would not describe',
      noSystemModstamp: 'an object with no `SystemModstamp`',
      noRecycleBin: 'an object without a recycle bin',
      unreadable: 'an object the org will not read without a filter',
    };
    // Both ways: a reason the scope gains is a kind the page has to name.
    expect(unionOf(SCOPE, 'ScopeLeftOutReason').sort()).toEqual(Object.keys(said).sort());
    // Metadata is what the Tooling API serves, the rest of what the org will not describe.
    expect(SCOPE).toContain(
      "if (described.out.has(name)) return described.tooling.has(name) ? 'metadata' : 'notWritable';",
    );

    const take = section(DOC, '## Taking a checkpoint');
    for (const words of Object.values(said)) expect(take).toContain(words);

    // One line per group of reasons under Left out, each kind in one of them:
    // the reasons ran as one sentence of some 230 words, where the reader lost
    // the thread and read the page-layout rule as one about layouts.
    const block = /\n {2}- \*\*Left out\*\*[^\n]*\n((?: {4}- [^\n]*\n)+)/.exec(take)?.[1];
    expect(block).toBeDefined();
    const groups = (block ?? '').split('\n').filter((line) => line.startsWith('    - '));
    expect(groups.length).toBeGreaterThanOrEqual(6);
    const homeless = Object.values(said).filter(
      (words) => !groups.some((line) => line.includes(words)),
    );
    expect(homeless).toEqual([]);
    expect(take).toContain(
      'the setup the org keeps as records (permissions, OAuth scopes, license assignments), told by its having no page layout',
    );
  });

  it('says the objects of a managed package are included, listed by package', () => {
    // Positive control: the scope keeps a package's objects and lists them by package.
    expect(SCOPE).toContain("A managed package's objects stay");
    expect(SCOPE).toContain(
      'function packagesOf(objects: readonly ScopedObject[]): ScopePackage[] {',
    );

    expect(section(DOC, '## Taking a checkpoint')).toContain(
      "and the objects of each managed package, by package: they are included, since an industry package's records are data like accounts",
    );
    expect(DOC).not.toContain('which stay: a party of an industry package');
  });

  it('names the controls of the page as the page labels them', () => {
    const keys = [
      'nav.checkpoint',
      'checkpoint.take.open',
      'checkpoint.take.chip.beforeUat',
      'checkpoint.take.chip.beforeDemo',
      'checkpoint.take.chip.cleanBaseline',
      'checkpoint.keep',
      'checkpoint.take.everything',
      'checkpoint.take.picked',
      'checkpoint.take.seeObjects',
      'checkpoint.take.beforeItRuns',
      'checkpoint.take.start',
      'checkpoint.take.stop',
      'checkpoint.list.rewind',
      'checkpoint.list.rename',
      'checkpoint.list.stopComparing',
      'checkpoint.list.keepIt',
      'checkpoint.preview.table.caption',
      'checkpoint.preview.cannot.title',
      'checkpoint.preview.undoCannot.title',
      'checkpoint.preview.undoCannot.accept',
      'checkpoint.preview.recreate.title',
      'checkpoint.preview.recreate.accept',
      'checkpoint.preview.outside.title',
      'checkpoint.preview.outside.accept',
      'checkpoint.preview.automation.accept',
      'checkpoint.preview.rewind',
      'checkpoint.run.stop',
      'checkpoint.result.rewindAgain',
      'checkpoint.result.stopComparing',
      'checkpoint.undo.open',
      'checkpoint.undo.acceptAutomation',
      'home.checkpoint.rewind',
      'runResults.checkpointNow.take',
    ];
    const missing = keys.filter((key) => !DOC.includes(`**${asWritten(label(key))}**`));
    expect(missing).toEqual([]);
  });

  it('tells each reason a rewind names for what still differs, in the words of the page', () => {
    const reasons = unionOf(TYPES, 'RewindResidualReason');
    // Positive control: the seven reasons the verify names.
    expect(reasons.sort()).toEqual([
      'automation',
      'changedDuringRewind',
      'changedSincePreview',
      'goneForGood',
      'kept',
      'notInBin',
      'refused',
    ]);
    const result = section(DOC, '## Rewinding');
    const missing = reasons.filter(
      (reason) =>
        !result.includes(`**${asWritten(label(`checkpoint.result.residual.${reason}.title`))}**`),
    );
    expect(missing).toEqual([]);
    // What changed after the preview is named by the result's own heading,
    // not by the same words again in lower case, which read as a typo.
    expect(result).toContain(
      'What changed after the preview is left as it is and listed under ' +
        `**${label('checkpoint.result.residual.changedSincePreview.title')}**: rewind again to take it.`,
    );
  });

  it('says how Undo names a record Salesforce lists as deleted but will not bring back: in its own words, the org’s answer after them', () => {
    // Anchor: the undo's words say the record is still listed, then quote the
    // org's answer, which says the opposite of what a read of the bin shows.
    const words = /export const KEPT_IN_BIN_WORDS =([\s\S]*?);\n/.exec(
      source(`${MODULE_DIR}/undoRewind.ts`),
    )?.[1];
    expect(words).toBeDefined();
    expect(words).toContain("'Salesforce still lists it as deleted but will not bring it back");
    expect(words).toMatch(
      /\(the org answers 'UNDELETE_FAILED: Entity is not in the recycle bin'\)"\s*$/,
    );

    expect(section(DOC, '## Undo')).toContain(
      'and a record Salesforce still lists as deleted but will not bring back, emptied from the ' +
        "bin or kept there for good, which Undo names in those words, with the org's own answer, that " +
        'it is not in the recycle bin, quoted after them.',
    );
  });

  it('says how every way a rewind can end reads, one line each', () => {
    // Positive control: five ends, the exit code of each read by the command line.
    expect(unionOf(TYPES, 'RewindStatus').sort()).toEqual([
      'cancelled',
      'failure',
      'partial',
      'success',
      'unstable',
    ]);
    const result = section(DOC, '## Rewinding');
    for (const line of [
      '- Done: the org is back at the checkpoint',
      '- Partial: the org is back at the checkpoint except the records listed',
      '- Unstable: someone kept writing to the org during the rewind',
      '- Stopped part way: the org is between the checkpoint and now',
      '- Ended before it was through',
    ]) {
      expect(result).toContain(line);
    }
  });

  it('says where checkpoints are kept, the lock apart from them, and when the expired go', () => {
    // Positive control: the store's place, the lock's, the modes, and the two sweeps.
    expect(STORE).toContain("return join(home, 'checkpoints');");
    expect(STORE).toContain(
      "dir !== undefined && dir.trim() !== '' ? resolve(dir) : join(homedir(), '.sandforge');",
    );
    expect(STORE).toContain("return join(home, '.sandforge', 'locks');");
    expect(STORE).toContain('export const CHECKPOINT_DIR_MODE = 0o700;');
    expect(STORE).toContain('export const CHECKPOINT_FILE_MODE = 0o600;');
    expect(EXTENSION).toMatch(
      /eventBroker\.onFirstWebview\(\(\) => \{[\s\S]{0,200}sweepCheckpoints\(\)/,
    );
    expect(CLI).toMatch(/sweeping = true;\n\s+try \{\n\s+await sweep\(\);/);

    const kept = section(DOC, '## Where checkpoints are kept');
    expect(kept).toContain(
      '`~/.sandforge/checkpoints/`, or `checkpoints/` in the folder `SANDFORGE_JOURNAL_DIR` names',
    );
    expect(kept).toContain('holds a lock in `~/.sandforge/locks/`, whatever store is used');
    expect(kept).toContain(
      'every folder is made readable by its owner only, and every file likewise',
    );
    expect(kept).toContain(
      'as the first SandForge view of a window opens and as any command of `sandforge-checkpoint` starts',
    );
  });

  it('says the preview, the rewind and the undo count the emails their writes send, and refuse past what the org has left', () => {
    // Anchor: the preview counts the emails and says the refusal a rewind
    // would meet; the rewind and the undo refuse past them, before writing.
    expect(PREVIEW).toContain("emailsRefusal('rewind', emails, orgName)");
    expect(REWIND).toContain(
      'if (writing && overEmails) return { rewound: false, refusal: overEmails };',
    );
    expect(UNDO).toContain(
      'if (objects.length > 0 && overEmails) return { undone: false, refusal: overEmails };',
    );
    expect(unionOf(TYPES, 'CheckpointRefusalCode')).toContain('EMAILS');
    expect(source(`${MODULE_DIR}/rewindEmails.ts`)).toContain("    code: 'EMAILS',");

    const preview = section(DOC, '## The preview');
    expect(preview).toContain(
      'Under it, the emails they send, per daily limit -- single emails, workflow emails --',
    );
    expect(preview).toContain(
      'Three refusals no box lifts: a SandForge run writing to the org, more API requests than ' +
        'the org has left today, and more emails than it has left today of a daily limit',
    );
    expect(section(DOC, '## Undo')).toContain(
      'An undo whose writes would send more emails than the org has left today of a daily limit is refused',
    );
    expect(DOC).toContain(
      "What a rewind's or an undo's writes would send is counted first, per daily limit",
    );
    expect(DOC).not.toContain('The rewind counts no emails');
  });

  it('says the emails of what could not be read are named as not counted, covered by the box of the automation, and refuse no rewind', () => {
    // Anchor: the preview names them; the rewind and the undo ask for the
    // automation's acceptance when they are said, and say them in its refusal.
    expect(PREVIEW).toContain('checkpointEmailsUncounted(records, automation)');
    for (const act of [REWIND, UNDO]) {
      expect(act).toContain('uncounted !== undefined)');
      expect(act).toContain('automationRefusal(orgName, automation, steps, uncounted)');
    }
    expect(label('checkpoint.preview.emails.uncounted')).toContain('were not counted');

    expect(section(DOC, '## The preview')).toContain(
      'What sends emails and could not be read -- a flow, process or rule whose definition the ' +
        'org refused or the read left past its bound, a flow a package installed, which the org ' +
        'lets no one read -- is named as not counted, even when nothing else sends, and the box ' +
        'covers it: a rewind is never refused for it',
    );
    expect(section(DOC, '## Undo')).toContain(
      'and what of it sends emails that were not counted, as an undo has no preview to say it',
    );
  });

  it('tells a field hidden by field-level security from one deleted since: a standard field always hidden, a custom one by the Tooling API’s FieldDefinition', () => {
    // Anchor: a standard field asks nothing; a custom one is asked of
    // FieldDefinition through the Tooling API; the three kinds are typed.
    expect(DIFF).toContain('export async function fieldsGoneOf(');
    expect(DIFF).toContain(
      "'SELECT QualifiedApiName FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '",
    );
    expect(DIFF).toContain('const CUSTOM_FIELD = /__(?:c|pc|s)$/i;');
    expect(source(`${MODULE_DIR}/compositeQueries.ts`)).toContain('/tooling/query?q=');
    expect(TYPES).toContain('hidden?: string[];');
    expect(TYPES).toContain('uncertain?: { fields: string[]; reason?: string };');
    expect(label('checkpoint.preview.cannot.fieldHidden')).toContain('field-level security');
    expect(label('checkpoint.preview.cannot.fieldRemovedOrHidden')).toContain('Deleted Fields');

    expect(section(DOC, '## The preview')).toContain(
      'the fields field-level security hides from the user since, which the describe and every ' +
        'query leave out as they do a deleted field, View All Data and Modify All Data ' +
        'notwithstanding: give the user read and edit access, then rewind again -- a standard ' +
        "field, which no one deletes, is always said hidden, and of a custom field the Tooling API's " +
        '`FieldDefinition` tells, which still lists a hidden field and no longer a deleted one',
    );
  });

  it('says a checkpoint holds the files attached to its records, what a rewind does to them and their links, what it leaves, and the file storage it holds a rewind and an undo to', () => {
    // Anchors: the scope holds files by their document, the diff tells the
    // links between files and records apart from the files no held record
    // links to, and the preview, the rewind and the undo refuse what passes
    // the org's file storage, saying nothing was written.
    expect(SCOPE).toContain("export const FILE_OBJECT = 'ContentDocument';");
    const filesDiff = /export interface RewindFilesDiff \{([\s\S]*?)\n\}/.exec(TYPES)?.[1] ?? '';
    for (const field of ['unlink', 'relink', 'updateLinks', 'outsideAdded', 'outsideDeleted']) {
      expect(filesDiff).toContain(`  ${field}: number;`);
    }
    expect(filesDiff).toContain('blindSpot?: true;');
    expect(/export type CheckpointRefusalCode =[^;]*'FILE_STORAGE'[;\n]/.test(TYPES)).toBe(true);
    expect(PREVIEW).toContain('? fileStorageRefusal(');
    expect(REWIND).toContain('const overStorage = fileStorageRefusal(');
    expect(UNDO).toContain(
      "fileStorageRefusal('undo', files, budget.fileStorage?.remaining, orgName)",
    );
    const storageWords = /const FILE_STORAGE_WORDS[\s\S]*?\n\};/.exec(ESTIMATE)?.[0] ?? '';
    expect(storageWords.match(/done: 'Nothing was written\.'/g)).toHaveLength(2);
    expect(storageWords).not.toContain('read');
    const PAGE = source('packages/webview/src/pages/Checkpoint/RewindPreview.tsx');
    for (const key of ['unlink', 'relink', 'updateLinks', 'outsideAdded', 'outsideDeleted']) {
      expect(PAGE).toContain(`'checkpoint.preview.files.${key}'`);
    }
    expect(label('checkpoint.preview.files.outsideAdded_other')).toMatch(
      /^Kept: .* as no record of this checkpoint links to them/,
    );

    const take = section(DOC, '## Taking a checkpoint');
    expect(take).toContain(
      'the files attached to the records it holds -- Salesforce Files, enhanced notes among ' +
        'them, and classic attachments --',
    );
    expect(take).toContain("never a file's content, nor its versions");
    expect(take).toContain(
      "A user without **Query All Files** sees another user's file only through a record it " +
        'is attached to, or by its Id',
    );
    const preview = section(DOC, '## The preview');
    expect(preview).toContain(
      'a link added since between a file and a record that both stay is removed, and the file stays',
    );
    expect(preview).toContain(
      "A file added since that no record of the checkpoint links to -- a user's own, a " +
        "library's -- is kept, and counted",
    );
    expect(preview).toContain('the files given a new version since, which keep it');
    expect(preview).toContain(
      'So it does when the files a rewind brings back from the recycle bin would take more ' +
        'file storage than the org has left',
    );
    expect(section(DOC, '## Undo')).toContain('a link it removed is put back, under a new Id');
    const leaves = section(DOC, '## What a rewind leaves as it is');
    expect(leaves).toContain('**The content of files.**');
    expect(leaves).toContain('A checkpoint taken before SandForge 1.70 holds no files');
    // Files were out of a checkpoint's reach until 1.70: no page says so any more.
    expect(DOC).not.toContain('File contents, file versions and attachments are not covered');
    expect(DOC).not.toContain('Metadata, users, setup, files and what already left the org');
    expect(helpAsPrinted()).not.toContain('metadata; files.');
  });

  it('says the preview counts every reason a rewind cannot undo that the contract names, and the result names each kept', () => {
    // Anchor: the diff fills what a rewind cannot undo with each reason the
    // contract allows, and the verify names what it leaves for them kept,
    // with why. Drop one and this test fails first.
    expect(unionOf(TYPES, 'RewindCannotUndoReason').sort()).toEqual([
      'activatedContract',
      'convertedLead',
      'deletedWithCreatedParent',
      'deletedWithParentOutside',
      'goneForGood',
      'newFileVersion',
    ]);
    expect(DIFF).toContain(
      "...(goneForGood > 0 ? [{ reason: 'goneForGood' as const, count: goneForGood }] : []),",
    );
    expect(DIFF).toContain("? [{ reason: 'convertedLead' as const, count: convertedSince }]");
    expect(DIFF).toContain("? [{ reason: 'activatedContract' as const, count: activatedSince }]");
    expect(DIFF).toContain(
      "? [{ reason: 'deletedWithCreatedParent' as const, count: withCreatedParent }]",
    );
    expect(DIFF).toContain(
      "? [{ reason: 'deletedWithParentOutside' as const, count: withParentOutside }]",
    );
    expect(DIFF).toContain(
      "...(newVersions > 0 ? [{ reason: 'newFileVersion' as const, count: newVersions }] : []),",
    );
    const kept = /const LEFT_AS_IT_IS[^=]*= \{([\s\S]*?)\n\};/.exec(REWIND)?.[1] ?? '';
    expect([...kept.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1])).toEqual([
      'convertedLead',
      'activatedContract',
      'deletedWithCreatedParent',
      'deletedWithParentOutside',
    ]);

    const preview = section(DOC, '## The preview');
    expect(preview).toContain(
      'the contracts activated since, which Salesforce will not set back to Draft, left activated and never given back',
    );
    expect(preview).toContain(
      'the records deleted since with a record created since that Salesforce does not undelete ' +
        'on its own, which their delete took along',
    );
    expect(preview).toContain(
      'the records deleted since with their parent, a record of an object the checkpoint does ' +
        'not hold: Salesforce brings them back with that parent only, and a checkpoint that ' +
        'holds its object brings them back',
    );
    // A record of the checkpoint that left with one created since comes back
    // through it now: the doc no longer says the rewind leaves it.
    expect(DOC).not.toContain(
      'Salesforce brings them back with that record only, which the rewind does not bring back',
    );
    expect(section(DOC, '## The preview')).toContain(
      'the records the checkpoint does not hold that took records of it along when they were ' +
        'deleted since, which come back for a moment to bring those back, then go back to the ' +
        'recycle bin with what came back with them',
    );
    expect(DOC).toContain(
      'A lead converted since stays converted, and a contract activated since stays activated',
    );
    expect(DOC).toContain(
      'The preview counts a lead converted since and a contract activated since among what a ' +
        'rewind cannot undo, and the result names each kept, never given back.',
    );
  });

  it('says a record the recycle bin no longer gives back is made again with a new Id once accepted, a file and a record deleted while taken left gone for good, and Undo deletes what it made', () => {
    // Anchor: the diff tells such a record to make again but for a file, the
    // rewind refuses it unaccepted, makes it in its sweep after what it
    // brings back, and the undo's plans send it to the bin.
    expect(DIFF).toContain(
      "const lostAs: RewindClass = recreatable(object) ? 'toRecreate' : 'goneForGood';",
    );
    expect(DIFF).toContain(
      "return !object.leftOutFields.some((field) => field.reason === 'base64');",
    );
    expect(unionOf(TYPES, 'CheckpointRefusalCode')).toContain('RECREATE');
    expect(REWIND).toContain(
      'if (notMade.length > 0) return { rewound: false, refusal: recreateRefusal(notMade) };',
    );
    expect(REWIND).toContain('await this.recreate(journal, recreate, tally);');
    expect(JOURNAL).toContain("if (line.kind === 'recreated') {");
    expect(CLI).toContain("acceptRecreate: args.includes('--accept-recreate'),");

    const preview = section(DOC, '## The preview');
    expect(preview).toContain(
      'every lookup the checkpoint holds that named one names its new Id. Anything outside ' +
        'Salesforce that names their old Ids -- an integration, a link, a report filter -- no ' +
        'longer finds them.',
    );
    expect(preview).toContain('and so is `--accept-recreate` on the command line');
    expect(preview).toContain(
      'a file, whose body the checkpoint does not hold, and a record deleted while the ' +
        'checkpoint was taken, whose values it does not hold',
    );
    expect(section(DOC, '## Rewinding')).toContain('2. **Make again** the records the recycle bin');
    expect(section(DOC, '## Undo')).toContain(
      'What it made again with new Ids goes to the recycle bin as well',
    );
  });

  it('says a record Salesforce still lists in the recycle bin once emptied from it is told by the undelete alone, made again in the same rewind once accepted, left and named otherwise, the box offered whenever records come back and required only for those counted', () => {
    // Anchor: the bring-back reads the org's answer per record, hands what it
    // can make again to the step that makes records again, names the rest;
    // the page offers the box whenever records come back, required only for
    // those counted to make again.
    expect(REWIND).toContain('for (const id of answeredNotInBin(answer, batch)) {');
    expect(REWIND).toContain('await this.withPlanned(remake, plan.recreate)');
    expect(REWIND).toContain("tally.mark('notInBin', objectApiName, id);");
    const PAGE = source('packages/webview/src/pages/Checkpoint/RewindPreview.tsx');
    expect(PAGE).toContain('const bringsBack = rewindTotals(diff).toBringBack > 0;');
    expect(PAGE).toContain('(remade.length === 0 || ticked.recreate) &&');
    expect(source('packages/extension/src/test/memoryRemovalOrg.ts')).toContain(
      'emptiedStillListed: true,',
    );

    const preview = section(DOC, '## The preview');
    expect(preview).toContain(
      'Salesforce still lists a record emptied from the recycle bin as deleted, for minutes to hours',
    );
    expect(preview).toContain(
      `under **${label('checkpoint.preview.recreate.ifEmptiedTitle')}**, and \`--accept-recreate\` on the command line`,
    );
    expect(preview).toContain(
      'That box holds the rewind only for the records the preview counts to make again.',
    );
    expect(section(DOC, '## Rewinding')).toContain(
      'A record Salesforce answers is no longer in the recycle bin -- emptied from it, though it ' +
        'still lists it as deleted, or kept there for good -- is made again in the next step',
    );
    expect(section(DOC, '## Undo')).toContain(
      'said as deleted again, with what went with it, never as brought back',
    );
  });

  it('says Undo sends what came back with a record back to the bin with it, never on its own', () => {
    // Anchor: the journal names each record that came back with a parent
    // beside it, the undo's plans leave it out of what goes on its own, and
    // the shared removal lets it go with its parent.
    expect(source(`${MODULE_DIR}/rewindJournal.ts`)).toContain(
      'if (removing(recordKey(id)) && cameBack(parent) && removing(parent)) along.add(id);',
    );
    expect(source(`${MODULE_DIR}/undoRewind.ts`)).toContain(
      '...(along.count > 0 ? { goesWithParent } : {}),',
    );
    expect(source('packages/extension/src/modules/forge/ForgeRunRemoval.ts')).toContain(
      'if (this.context.goesWithParent?.(row, runEnd) === true) return false;',
    );

    expect(section(DOC, '## Undo')).toContain(
      'what came back with a record, a contact with its account or a product with its ' +
        'opportunity, goes with that record, never on its own',
    );
  });

  it('says a record of the checkpoint that left with a record it does not hold comes back through that record, brought back for a moment, and its undo sends it back to the bin alone', () => {
    // Anchor: the diff tells the carriers apart, the rewind brings them back
    // in batches of their own and its second pass deletes them with what came
    // back with them, its stop names those still alive, and the undo says
    // what it sent back to the bin on its own.
    expect(DIFF).toContain("await spool('carrier').add({ Id: id });");
    expect(REWIND).toContain('carriers: asCarriers,');
    expect(REWIND).toContain("'record(s) brought back for a moment still in the org");
    expect(UNDO).toContain('carriedAlone: outcome.carriedAlone');
    expect(PREVIEW).toContain('(object.toBringBack.carriers ?? 0) +');

    const rewinding = section(DOC, '## Rewinding');
    expect(rewinding).toContain(
      'A record of the checkpoint that left with a record the checkpoint does not hold -- a ' +
        'contact moved since under an account created since, which was then deleted -- comes ' +
        'back with that record only, so that record comes back for a moment',
    );
    expect(rewinding).toContain(
      'Stopped between the two passes, that record stays in the org until **Rewind again** ' +
        'deletes it.',
    );
    expect(rewinding).toContain(
      'One the recycle bin no longer holds brings nothing back: what it had taken along is ' +
        'named among what still differs.',
    );
    expect(section(DOC, '## Undo')).toContain(
      'a record of the checkpoint it had taken along goes back to the bin on its own, under ' +
        'the parent the checkpoint gave it, and comes back alone',
    );
  });

  it('names the results that offer a take of the org they filled, and what is never offered one', () => {
    // Positive control: each result renders the offer, of the org the run wrote to.
    const RESULTS = {
      'packages/webview/src/pages/Seed/QuickSeedFlow.tsx': 'quick-seed-checkpoint-now',
      'packages/webview/src/pages/Seed/SeedResultsStep.tsx': 'seed-checkpoint-now',
      'packages/webview/src/pages/Seed/CsvUpload/CsvUploadWizard.tsx': 'csv-checkpoint-now',
      'packages/webview/src/pages/Seed/Clone/CloneResultsPanel.tsx': 'clone-checkpoint-now',
      'packages/webview/src/pages/Forge/ForgeResults.tsx': 'forge-results-checkpoint-now',
      'packages/webview/src/pages/Frozen/FrozenLoadTab.tsx': 'frozen-report-checkpoint-now',
    };
    for (const [path, testId] of Object.entries(RESULTS)) {
      expect({ path, offers: source(path).includes(`testId="${testId}"`) }).toEqual({
        path,
        offers: true,
      });
    }
    const offer = source('packages/webview/src/components/ui/TakeCheckpointNow.tsx');
    expect(offer).toContain('!isDevelopmentOrg(org)) return null');
    expect(offer).toContain(
      "navigate('checkpoint', { takeCheckpoint: true, targetOrgId: org.id })",
    );

    const take = section(DOC, '## Taking a checkpoint');
    expect(take).toContain(
      'The results of a Seed run (a template, the wizard, a CSV import or a clone from another org), of a Forge clone and of a Frozen load that wrote to a sandbox, a scratch org or a Developer Edition offer',
    );
    expect(take).toContain('It is not offered for a production org, nor after a run');
  });

  it('says, in a sentence of its own, that Undo could not bring back a record deleted before a record it points at, and that the acceptance covers it', () => {
    // Anchor: the diff counts such a record under a reason of its own, the
    // page words it apart, and the rewind refuses it unaccepted as it refuses
    // the other reason. Drop any of them and this test fails first.
    expect(TYPES).toContain(
      "export type RewindUndoCannotReason = 'onlyWithParent' | 'deletedBeforeParent';",
    );
    expect(DIFF).toContain(
      "undoCannot.push({ objectApiName, count: beforeParent.length, reason: 'deletedBeforeParent' });",
    );
    expect(REWIND).toMatch(
      /const NO_UNDO_LEFT[^;]*'noUndoNotAccepted',\s*'beforeParentNotAccepted',/,
    );
    expect(label('checkpoint.preview.undoCannot.beforeParent_other')).toContain(
      'which the rewind deletes next: Salesforce cannot bring them back after that.',
    );

    const preview = section(DOC, '## The preview');
    expect(preview).toContain(
      'the records it deletes before a record they point at, which the rewind deletes next: ' +
        'Salesforce cannot bring them back after that',
    );
    expect(preview).toContain(
      "the case's account lookup forbids deleting an account that still has cases",
    );
    // Said as what the rewind does and what follows, not as a case no rewind may undo.
    expect(preview).toContain(
      'so the rewind deletes the case first, alone, and Salesforce cannot bring it back once the ' +
        'account is deleted after it',
    );
    expect(preview).toContain('and so is `--accept-no-undo` on the command line');
    expect(section(DOC, '## Undo')).toContain(
      'and those it deleted before a record they point at, which it deleted next',
    );
  });

  it('says a pipeline may undo too, the journal of the last rewind deleted once its undo window ends', () => {
    // Anchor: the sweep deletes the journal of a checkpoint's last rewind once
    // its undo is past its date, the recycle bin's fifteen days after the rewind.
    expect(STORE).toMatch(
      /async function journalDue\([\s\S]*?const until = checkpoint\.lastRewind\?\.undoUntil;[\s\S]*?Date\.parse\(until\) <= now &&/,
    );
    expect(REWIND).toContain('const UNDO_WINDOW_MS = RECYCLE_BIN_DAYS * 24 * 60 * 60_000;');
    expect(constant(STORE, 'RECYCLE_BIN_DAYS')).toBe(15);

    const pool = section(DOC, '### A pool of scratch orgs, rewound between suites');
    expect(pool).toContain(
      '`undo` works in a pipeline as anywhere, but is seldom needed there: the journal of the ' +
        "checkpoint's last rewind is deleted once that rewind can no longer be undone, 15 days after it.",
    );
    // Read as: Undo does not work in CI.
    expect(DOC).not.toContain('Undo is never needed in CI');
  });

  it('says the journals of an org’s earlier rewinds go once a rewind of it has ended, each named, but for one stopped part way', () => {
    // Anchor: once its journal ended, the rewind deletes the journals Undo no
    // longer reaches — the store offers it for the org's last rewind alone —
    // keeping one still open; the panel's log and the command's output name each.
    expect(REWIND).toMatch(
      /await journal\.end\(\);[\s\S]*?removeEarlierJournals\(this\.deps\.store, this\.lock, \{/,
    );
    expect(JOURNAL).toContain(
      'const open = journal.facts.endedAt === undefined && journal.facts.undos.length === 0;',
    );
    expect(STORE).toContain('latest?.checkpointId === folder.checkpointId &&');
    expect(HANDLER).toContain(
      '`[INFO] Removed the journal of rewind ${gone.rewindId} of checkpoint',
    );
    expect(CLI).toContain('`  removed the journal of rewind ${gone.rewindId}');

    expect(section(DOC, '## Where checkpoints are kept')).toContain(
      "Undo reaches an org's last rewind alone: once a rewind of the org has ended, the journals " +
        'of its earlier rewinds, which hold the values they wrote over, are deleted, each named in ' +
        "the log and in the command's output -- but for one stopped part way, which the next " +
        'rewind of its checkpoint takes up.',
    );
    // Read as: they pile up until the checkpoint goes.
    expect(DOC).not.toContain('the journals of earlier rewinds stay with their checkpoint');
  });

  it('opens from the third line of the side bar, as its quick start says', () => {
    // Positive control: the side bar's primary modules, in their order.
    const primary = /const PRIMARY_MODULES: NavItem\[\] = \[([\s\S]*?)\n\];/.exec(SIDE_PANEL)?.[1];
    expect(primary).toBeDefined();
    const ids = [...(primary ?? '').matchAll(/id: '([a-z]+)'/g)].map((m) => m[1]);
    expect(ids.slice(0, 3)).toEqual(['seed', 'forge', 'checkpoint']);

    expect(DOC).toContain("third in the launcher's Modules list, after Seed and Forge");
  });
});

describe('the README lines of the module', () => {
  const READMES = ['README.md', 'packages/extension/README.md'];

  it('counts the module among the modules both READMEs list, and links its guide', () => {
    for (const path of READMES) {
      const modules = section(source(path), '## Modules');
      const stated = /SandForge ships (\d+) modules/.exec(modules)?.[1];
      const rows = modules.split('\n').filter((line) => /^\| \*\*[^*]+\*\* +\|/.test(line));
      expect(Number(stated), `${path}: the count and the table disagree`).toBe(rows.length);
      const row = rows.find((line) => line.startsWith('| **Checkpoints**'));
      expect(row, `${path}: no Checkpoints row`).toBeDefined();
      expect(row).toContain('docs/modules/checkpoint.md)');
      expect(row).toContain('Never on a production org');
    }
  });

  it('lists the guide and a command line that rewinds and undoes', () => {
    for (const path of READMES) {
      const docs = section(source(path), '## Documentation');
      expect(docs).toMatch(/\| \[Checkpoint & Rewind\]\([^)]*docs\/modules\/checkpoint\.md\)/);
      const cli = docs.split('\n').find((line) => line.includes('ci-examples/README.md'));
      expect(cli).toContain('rewind the org and undo the rewind');
    }
  });

  it('gives the rewind its own steps, ending on Undo, in both READMEs alike', () => {
    // The Marketplace copy points its links at GitHub and its images at
    // raw.githubusercontent.com (scripts/sync-extension-readme.mjs).
    const [root, marketplace] = READMES.map((path) =>
      section(source(path), '## Rewind an org to a checkpoint')
        .replace(/\]\([^)]*\/(docs\/[^)]+)\)/g, ']($1)')
        .replace(/\]\(https:\/\/raw\.githubusercontent\.com\/[^)]*?\/master\/([^)]+)\)/g, ']($1)'),
    );
    expect(root.trim()).toBe(marketplace.trim());
    const steps = root.split('\n').filter((line) => /^\d+\. /.test(line));
    expect(steps).toHaveLength(5);
    expect(steps[0]).toContain(`**${label('checkpoint.take.open')}**`);
    expect(steps[4]).toContain(`**${label('checkpoint.undo.open')}**`);
    expect(root).toContain('never takes a checkpoint of a production org nor rewinds one');
  });

  it('says a rewind makes again with new Ids, once accepted, what the recycle bin no longer gives back', () => {
    // Anchor: the rewind refuses such records unaccepted, and makes them in a step of its own.
    expect(REWIND).toContain(
      'if (notMade.length > 0) return { rewound: false, refusal: recreateRefusal(notMade) };',
    );
    expect(REWIND).toContain('await this.recreate(journal, recreate, tally);');

    const steps = section(source('README.md'), '## Rewind an org to a checkpoint')
      .split('\n')
      .filter((line) => /^\d+\. /.test(line));
    expect(steps[3]).toContain(
      'the records deleted since come back from the recycle bin with their Ids, or, once it no ' +
        'longer holds them and you accept it, are made again with new Ids',
    );
  });

  it('offers Undo on the org’s last rewind for the recycle bin’s 15 days, and says what it brings back while the bin holds it', () => {
    // Anchor: the list offers the Undo of the org's latest rewind alone, until
    // a date the rewind sets at the bin's fifteen days.
    expect(STORE).toContain('latest?.checkpointId === folder.checkpointId &&');
    expect(REWIND).toContain('const UNDO_WINDOW_MS = RECYCLE_BIN_DAYS * 24 * 60 * 60_000;');
    expect(constant(STORE, 'RECYCLE_BIN_DAYS')).toBe(15);

    const steps = section(source('README.md'), '## Rewind an org to a checkpoint')
      .split('\n')
      .filter((line) => /^\d+\. /.test(line));
    expect(steps[4]).toContain(
      `**${label('checkpoint.undo.open')}**, offered on the org's last rewind for 15 days, ` +
        'returns the org to how it was before the rewind and keeps what anyone changed since. ' +
        'What the rewind deleted comes back while the recycle bin holds it, and the preview ' +
        'names first what Undo could not bring back.',
    );
    // What Undo could not bring back is a section of the preview.
    expect(label('checkpoint.preview.undoCannot.title')).toBeTruthy();
    // The module's row says which thing can be undone: the rewind.
    for (const path of READMES) {
      const row = section(source(path), '## Modules')
        .split('\n')
        .find((line) => line.startsWith('| **Checkpoints**'));
      expect(row).toContain('whoever did it; the rewind itself can be undone.');
    }
  });

  it('says a rewind takes the files attached to the records back with them, never their content, in both READMEs', () => {
    // Anchor: a checkpoint holds its files by their document.
    expect(SCOPE).toContain("export const FILE_OBJECT = 'ContentDocument';");
    for (const path of READMES) {
      const text = source(path);
      expect(text).toContain(
        'It rewinds data, the files attached to the records it holds among them, not metadata, ' +
          'users or the content of files',
      );
      expect(text).not.toContain('not metadata, users or files');
    }
  });

  it('says the command line is a script of a checkout of the repository, which the extension does not install', () => {
    // Anchor: no package of the repository declares a command to install;
    // the script's help runs it through tsx from the checkout.
    for (const path of ['package.json', 'packages/extension/package.json']) {
      expect(Object.keys(JSON.parse(source(path)) as object)).not.toContain('bin');
    }
    expect(helpAsPrinted()).toContain(
      'pnpm exec tsx packages/extension/cli/sandforge-checkpoint.ts <command> --org <alias>',
    );
    expect(section(DOC, '## From the command line')).toContain(
      'from a checkout of this repository (`pnpm install` and `pnpm build:shared` first)',
    );

    expect(section(source('README.md'), '## Rewind an org to a checkpoint')).toContain(
      'From a checkout of this repository, the [`sandforge-checkpoint` ' +
        'script](docs/modules/checkpoint.md#from-the-command-line) takes, previews, rewinds and ' +
        'undoes the same way without the editor',
    );
  });
});

describe('what a checkpoint and a backup hold on this machine', () => {
  /** Every page that says it, and the help the script prints. */
  const SURFACES: Array<[string, string]> = [
    ['docs/modules/checkpoint.md', prose(DOC)],
    ['the --help of sandforge-checkpoint', helpAsPrinted()],
    ['README.md', source('README.md')],
    ['packages/extension/README.md', source('packages/extension/README.md')],
    ['docs/faq.md', source('docs/faq.md')],
    ['docs/modules/dataops.md', source('docs/modules/dataops.md')],
    ['ci-examples/README.md', source('ci-examples/README.md')],
  ];

  /** The module's source files, by name, tests left out. */
  function sourcesOf(dir: string): Array<[string, string]> {
    return readdirSync(resolve(REPO_ROOT, dir))
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .map((name) => [name, source(`${dir}/${name}`)]);
  }

  it('says the records’ values are kept unencrypted, never "in clear", which reads as "clearly"', () => {
    // Anchor: neither the checkpoint's store nor the DataOps backup's ciphers
    // what it writes: files only their owner can read, values as the org held them.
    // An export alone does, into a file that leaves the store.
    for (const dir of [MODULE_DIR, 'packages/extension/src/modules/dataops']) {
      const ciphering = sourcesOf(dir)
        .filter(([, text]) => /createCipheriv|createCipher\(/.test(text))
        .map(([name]) => name);
      expect(ciphering).toEqual(dir === MODULE_DIR ? ['checkpointArchive.ts'] : []);
    }
    expect(STORE).toContain('export const CHECKPOINT_FILE_MODE = 0o600;');

    const saidInClear = SURFACES.filter(([, text]) => /\bin clear\b/.test(text)).map(([w]) => w);
    expect(saidInClear).toEqual([]);
    for (const [where, text] of SURFACES) {
      expect({ where, unencrypted: /\bunencrypted\b/.test(text) }).toEqual({
        where,
        unencrypted: true,
      });
    }
  });
});

describe('ci-examples/README.md', () => {
  const GUIDE = source('ci-examples/README.md');

  it('gives the checkpoint a line in every exit code', () => {
    const rows = section(GUIDE, '## Exit codes')
      .split('\n')
      .filter((line) => /^\| `\d+`/.test(line));
    // Positive control: the six rows of the one table every script shares.
    expect(rows).toHaveLength(6);
    expect(rows.filter((line) => !line.includes('checkpoint'))).toEqual([]);
  });

  it("says the checkpoint's production refusal, its questions and its undo", () => {
    expect(GUIDE).toContain(
      '`take`, `preview`, `rewind` and `undo` refuse a production org before they read anything',
    );
    expect(GUIDE).toContain("a checkpoint's `rewind`, `undo` or `delete` run with no terminal");
    expect(GUIDE).toContain("A checkpoint's `rewind` is taken back with `undo`");
    expect(GUIDE).toContain(
      '../docs/modules/checkpoint.md#a-pool-of-scratch-orgs-rewound-between-suites',
    );
  });
});

describe('docs/faq.md', () => {
  const FAQ = source('docs/faq.md');

  it('says Checkpoints refuses a production org, where the FAQ says what asks before a write', () => {
    // Positive control: the guard's refusal has no override, as the module test pins.
    expect(GUARD).toContain('So nothing lifts this refusal');

    const answer = section(FAQ, '### Does SandForge modify production data?');
    expect(answer).toContain(
      'Checkpoints never takes a checkpoint of a production org nor rewinds one, and no setting lifts that',
    );
  });

  it('lists the checkpoints and the locks among what SandForge keeps on the machine', () => {
    // Positive control: the store's and the lock's places, as the store names them.
    expect(STORE).toContain("return join(home, 'checkpoints');");
    expect(STORE).toContain("return join(home, '.sandforge', 'locks');");

    const answer = section(FAQ, '### What does SandForge keep on my machine?');
    expect(answer).toContain('`~/.sandforge/checkpoints/`');
    expect(answer).toContain('`~/.sandforge/locks/`');
    expect(answer).toContain("which hold the records' values unencrypted");
  });

  it('points from the undo answer to a rewind, and to its own undo', () => {
    const answer = section(FAQ, '### How do I undo what SandForge wrote?');
    expect(answer).toContain(`**${label('checkpoint.list.rewind')}**`);
    expect(answer).toContain(`**${label('checkpoint.undo.open')}**`);
    expect(answer).toContain('(modules/checkpoint.md)');
  });
});
