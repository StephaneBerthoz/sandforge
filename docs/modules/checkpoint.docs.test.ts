/**
 * Doc/code drift guard for the Checkpoint & Rewind page, and for the lines the
 * two READMEs and the command-line guide give the module.
 *
 * A rewind deletes what was created since a checkpoint, whoever created it,
 * so what its page says it leaves alone is read as a promise. Three promises
 * are easy to make and the code does not keep them: a per-object cap that
 * leaves a large object out (the take refuses past one total instead), an
 * email count against a Developer Edition's fifteen a day (no rewind counts
 * emails), and a preview that names activated contracts (it counts records
 * gone for good and leads converted since, though the contract has room for
 * the other). The command line's help is printed whole on the page, so it is
 * held to the script's own text, word for word, with the two defaults it
 * interpolates.
 *
 * Each test states the code it depends on, and fails first if that code moved:
 * an assertion about a page that no longer works this way proves nothing.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
const PREVIEW = source(`${MODULE_DIR}/previewCheckpoint.ts`);
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
    expect(commands).toEqual(['take', 'list', 'preview', 'rewind', 'undo', 'delete']);

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
    // Seed runs, and asks the window's Forge runs; the command line's host
    // wires neither, and is left with the org's lock.
    expect(EXTENSION_HANDLERS).toContain("this.checkpointHandler.setRunFiles('sync', store);");
    expect(EXTENSION_HANDLERS).toContain("this.checkpointHandler.setRunFiles('seed', store);");
    expect(HANDLER).toContain('for (const files of [this.syncRuns, this.seedRuns]) {');
    expect(HANDLER).toContain('if (this.writers.forgeWritingTo?.(orgId) === true) return words;');
    for (const text of [CLI, PANEL_HOST]) {
      expect(text).not.toMatch(/setSyncRunCreations|setSeedRunCreations|setRunFiles/);
    }

    expect(DOC).toContain("**What its write check sees**: the org's lock alone.");
    expect(DOC).toContain('the Sync, Seed and Forge runs the panel sees are not seen here');
    expect(DOC).toContain('In the panel, a Forge run of the window, and a Sync or Seed run');
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

  it('gives the windows and limits the code keeps', () => {
    // Positive control: the figures, as the store, the take and the rewind hold them.
    expect(constant(STORE, 'RECYCLE_BIN_DAYS')).toBe(15);
    expect(constant(STORE, 'EXPIRY_WARNING_DAYS')).toBe(3);
    expect(constant(STORE, 'PREVIEW_KEEP_MS')).toBe(24 * 60 * 60_000);
    expect(REWIND).toContain('const UNDO_WINDOW_MS = RECYCLE_BIN_DAYS * 24 * 60 * 60_000;');
    // The take refuses past one total; no object is left out for its own size.
    expect(TAKE).toContain("code: 'TOO_MANY_RECORDS',");
    expect(TAKE).not.toMatch(/perObject|MAX_PER_OBJECT/);

    expect(DOC).toContain('for 30 days unless you keep it');
    expect(DOC).toContain('three days before its date, with **Keep**');
    expect(DOC).toContain('once the checkpoint is more than 15 days old');
    expect(DOC).toContain('It is offered for the last rewind of an org, for 15 days after it');
    expect(DOC).toContain("A preview's reads are kept a day.");
    expect(DOC).toContain(
      "more records than the take's limit (500,000 unless the command line names another)",
    );
  });

  it('lists what a checkpoint leaves out, one kind for each reason the scope gives', () => {
    const said: Record<string, string> = {
      excludedByUser: "an object the command line's `--exclude-object` names",
      notFound: 'an object picked that the org does not have',
      chatter: 'Chatter posts, comments and their attachments',
      history: 'history, sharing and change-event objects',
      sharing: 'history, sharing and change-event objects',
      changeEvent: 'history, sharing and change-event objects',
      unsupportedKind:
        'big objects, external objects, Data Cloud objects, Knowledge article versions and platform events',
      customSetting: 'custom settings, which are configuration',
      files: 'files, their versions, documents and links, and attachments',
      setup: 'users, permissions and the rest of setup',
      metadata: '; metadata;',
      notWritable: 'an object the user may not query, create, edit and delete',
      notDescribed: 'an object the org would not describe',
      noSystemModstamp: 'an object with no `SystemModstamp`',
      noRecycleBin: 'an object without a recycle bin',
      unreadable: 'an object the org will not read without a filter',
    };
    // Both ways: a reason the scope gains is a kind the page has to name.
    expect(unionOf(SCOPE, 'ScopeLeftOutReason').sort()).toEqual(Object.keys(said).sort());

    const take = section(DOC, '## Taking a checkpoint');
    for (const words of Object.values(said)) expect(take).toContain(words);
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
    // Positive control: the six reasons the verify names.
    expect(reasons.sort()).toEqual([
      'automation',
      'changedDuringRewind',
      'changedSincePreview',
      'goneForGood',
      'kept',
      'refused',
    ]);
    const result = section(DOC, '## Rewinding');
    const missing = reasons.filter(
      (reason) =>
        !result.includes(`**${asWritten(label(`checkpoint.result.residual.${reason}.title`))}**`),
    );
    expect(missing).toEqual([]);
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

  it('claims no email count the rewind does not make', () => {
    // Anchor: neither a rewind, an undo nor a preview counts the emails what
    // they fire would send. Build that count and this test fails first: the
    // page may then say what it counts.
    for (const text of [REWIND, UNDO, PREVIEW, HANDLER]) expect(text).not.toMatch(/email/i);

    expect(DOC).toContain('The rewind counts no emails');
  });

  it('says the preview counts records gone for good and leads converted since, and no activated contract', () => {
    // Anchor: the diff fills what a rewind cannot undo with records gone for
    // good and leads converted since, and no code of the module names the
    // other reason the contract allows. Count it and this test fails first.
    expect(DIFF).toContain(
      "...(goneForGood > 0 ? [{ reason: 'goneForGood' as const, count: goneForGood }] : []),",
    );
    expect(DIFF).toContain("? [{ reason: 'convertedLead' as const, count: convertedSince }]");
    const moduleCode = readdirSync(resolve(REPO_ROOT, MODULE_DIR))
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .map((file) => source(join(MODULE_DIR, file)))
      .join('\n');
    expect(moduleCode).not.toMatch(/'activatedContract'/);

    expect(DOC).toContain(
      'A lead converted since stays converted, and a contract activated since stays activated',
    );
    expect(DOC).toContain(
      'The preview counts a lead converted since among what a rewind cannot undo, and the result ' +
        'names it kept; an activated contract the preview does not count',
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
    expect(preview).toContain('and so is `--accept-no-undo` on the command line');
    expect(section(DOC, '## Undo')).toContain(
      'and those it deleted before a record they point at, which it deleted next',
    );
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
    const [root, marketplace] = READMES.map((path) =>
      section(source(path), '## Rewind an org to a checkpoint').replace(
        /\]\([^)]*\/(docs\/[^)]+)\)/g,
        ']($1)',
      ),
    );
    expect(root.trim()).toBe(marketplace.trim());
    const steps = root.split('\n').filter((line) => /^\d+\. /.test(line));
    expect(steps).toHaveLength(5);
    expect(steps[0]).toContain(`**${label('checkpoint.take.open')}**`);
    expect(steps[4]).toContain(`**${label('checkpoint.undo.open')}**`);
    expect(root).toContain('never takes a checkpoint of a production org nor rewinds one');
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
    expect(answer).toContain("which hold the records' values in clear");
  });

  it('points from the undo answer to a rewind, and to its own undo', () => {
    const answer = section(FAQ, '### How do I undo what SandForge wrote?');
    expect(answer).toContain(`**${label('checkpoint.list.rewind')}**`);
    expect(answer).toContain(`**${label('checkpoint.undo.open')}**`);
    expect(answer).toContain('(modules/checkpoint.md)');
  });
});
