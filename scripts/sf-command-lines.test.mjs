/**
 * Gate: every `sf org …` line the product, its pages and its pipelines give a
 * reader is a command of the Salesforce CLI, with flags that command takes.
 *
 * The refusal of an alias `sf` does not know ended on `in a CI job, "sf org
 * login jwt" or "sf org login sfdxurl"`, met on twelve commands and the MCP
 * server; the sign-in steps of the CI examples ran the same word. sf 2.154
 * answers it "Command org:login:sfdxurl not found.": the command is `sf org
 * login sfdx-url`, and a pipeline copied as it stood stopped at its sign-in.
 * The words were never set beside the CLI's own list of its commands, which
 * is what this gate does, on every tracked text file: the messages of the
 * extension and of the command lines, the locales and bundles, the pages, the
 * pipelines, and the tests that pin those words.
 *
 * The commands of the `org` topic and their flags are those `sf commands
 * --json` listed for @salesforce/cli 2.154.4, kept here so that a CI job with
 * no `sf` reads them: each command's flags by their long names, a letter after
 * the slash when the flag has one; `--json`, `--flags-dir` and `--help` are
 * taken by every command. A flag's deprecated names are left out: a line given
 * to a reader names the flag as the CLI's help does. To read them again,
 * `sf commands --json`, and for each id that starts with `org:`, its `flags`.
 *
 * Run: node --test scripts/sf-command-lines.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'scripts/sf-command-lines.test.mjs';

/** The commands of the `org` topic, by id, and the flags each takes beside the global ones. */
const SF_ORG_COMMANDS = {
  'org:assign:permset': 'name/n on-behalf-of/b target-org/o api-version',
  'org:assign:permsetlicense': 'name/n on-behalf-of/b target-org/o api-version',
  'org:auth:show-access-token': 'target-org/o no-prompt/p',
  'org:auth:show-sfdx-auth-url': 'target-org/o no-prompt/p',
  'org:auth:show-user-password': 'target-org/o no-prompt/p',
  'org:create:agent-user': 'target-org/o api-version base-username first-name last-name',
  'org:create:sandbox':
    'definition-file/f set-default/s alias/a wait/w poll-interval/i async name/n ' +
    'source-sandbox-name source-id license-type/l target-org/o no-prompt no-track-source',
  'org:create:scratch':
    'alias/a async set-default/d definition-file/f target-dev-hub/v no-ancestors/c edition/e ' +
    'snapshot/s no-namespace/m duration-days/y wait/w api-version client-id/i track-source/t ' +
    'username description name release admin-email source-org',
  'org:create:shape': 'target-org/o api-version loglevel',
  'org:create:snapshot': 'target-dev-hub/v api-version loglevel source-org/o name/n description/d',
  'org:create:user':
    'set-alias/a definition-file/f set-unique-username/s target-org/o api-version loglevel',
  'org:delete:sandbox': 'target-org/o no-prompt/p',
  'org:delete:scratch': 'target-org/o no-prompt/p',
  'org:delete:shape': 'target-org/o api-version loglevel no-prompt/p',
  'org:delete:snapshot': 'target-dev-hub/v api-version loglevel snapshot/s no-prompt/p',
  'org:disable:tracking': 'target-org/o',
  'org:display': 'target-org/o api-version verbose loglevel',
  'org:display:user': 'target-org/o api-version loglevel',
  'org:enable:tracking': 'target-org/o',
  'org:generate:password': 'on-behalf-of/b length/l complexity/c target-org/o api-version',
  'org:get:snapshot': 'target-dev-hub/v api-version loglevel snapshot/s',
  'org:list': 'verbose all clean no-prompt/p skip-connection-status loglevel',
  'org:list:auth': 'loglevel',
  'org:list:limits': 'target-org/o api-version loglevel',
  'org:list:metadata': 'api-version loglevel target-org/o output-file/f metadata-type/m folder',
  'org:list:metadata-types': 'api-version loglevel target-org/o output-file/f filter-known/k',
  'org:list:shape': 'verbose loglevel',
  'org:list:snapshot': 'target-dev-hub/v api-version loglevel',
  'org:list:sobject:record-counts': 'sobject/s target-org/o api-version loglevel',
  'org:list:users': 'target-org/o api-version loglevel',
  'org:login:access-token':
    'instance-url/r set-default-dev-hub/d set-default/s alias/a no-prompt/p loglevel',
  'org:login:jwt':
    'username/o jwt-key-file/f client-id/i instance-url/r set-default-dev-hub/d set-default/s ' +
    'alias/a no-prompt/p loglevel',
  'org:login:sfdx-url':
    'sfdx-url-file/f sfdx-url-stdin/u set-default-dev-hub/d set-default/s alias/a no-prompt/p ' +
    'loglevel',
  'org:login:web':
    'browser/b client-id/i instance-url/r set-default-dev-hub/d set-default/s alias/a ' +
    'no-prompt/p loglevel client-app/c username scopes',
  'org:logout': 'target-org/o client-app/c all/a no-prompt/p loglevel',
  'org:open': 'target-org/o api-version private browser/b path/p url-only/r loglevel source-file/f',
  'org:open:agent':
    'target-org/o api-version api-name/n private browser/b url-only/r authoring-bundle version',
  'org:refresh:sandbox':
    'no-auto-activate wait/w poll-interval/i source-sandbox-name source-id async name/n ' +
    'definition-file/f target-org/o no-prompt',
  'org:resume:sandbox': 'wait/w name/n job-id/i use-most-recent/l target-org/o',
  'org:resume:scratch': 'job-id/i use-most-recent/r wait/w',
};

/** The flags every command takes. */
const GLOBAL_FLAGS = ['--json', '--flags-dir', '--help', '-h'];

/** Each command's flags as a line writes them: `--alias` and `-a`. */
const FLAGS = new Map(
  Object.entries(SF_ORG_COMMANDS).map(([id, flags]) => [
    id,
    new Set([
      ...GLOBAL_FLAGS,
      ...flags.split(' ').flatMap((flag) => {
        const [name, char] = flag.split('/');
        return char === undefined ? [`--${name}`] : [`--${name}`, `-${char}`];
      }),
    ]),
  ]),
);

/** Every id a command's words lead through: `org`, `org:login`, `org:login:web`. */
const TOPICS = new Set(
  Object.keys(SF_ORG_COMMANDS).flatMap((id) =>
    id.split(':').map((_, at, words) => words.slice(0, at + 1).join(':')),
  ),
);

/**
 * What may say `sf org` and a word the CLI does not have, and why. Each one
 * must still be found somewhere, or it goes.
 */
const ALLOWED = [
  {
    file: 'packages/extension/src/core/connection/DeviceLogin.ts',
    words: 'org login device',
    why: 'it says the CLI dropped the command: the reason the extension runs the device flow itself',
  },
  {
    file: /^ci-examples\/[^/]+$/,
    words: 'org secrets',
    why: 'a sentence about the secrets of an org a pipeline signs in with, not a command',
  },
  {
    file: /^packages\/extension\/src\/core\/connection\/ConnectionHelper(?:\.test)?\.ts$/,
    words: 'org display -u',
    why:
      'the read the extension falls back on for the CLIs older than `org auth show-access-token`, ' +
      'which know the org by -u; sf 2.154 still takes it, as the old name of --target-org',
  },
];

/** Where a line break was before two lines were read as one: counted, never a space. */
const JOINED = '';

/** The line breaks of `text`, each as {@link JOINED}. */
const breaksOf = (text) => text.replace(/[^\n]/g, '').replace(/\n/g, JOINED);

/**
 * The text a line is read in: the pieces of a string the source glues with
 * `+` read as one, a shell line carried on with a backslash read as one line,
 * and a comment of the source that goes on to the next line read as one.
 */
function joined(text) {
  return text
    .replace(/(['"`])\s*\+\s*(['"`])/g, (glue) => breaksOf(glue))
    .replace(/\\\r?\n\s*/g, (carried) => ` ${breaksOf(carried)}`)
    .replace(/\r?\n\s*(?:\*|\/\/)(?![/*])\s*/g, (comment) => ` ${breaksOf(comment)}`);
}

/** The words of a token, without the punctuation of a sentence around it. */
const bare = (token) => token.replaceAll(JOINED, '').replace(/^[(`'"]+|[),.;:!?`'"]+$/g, '');

/**
 * An `sf org` a reader would run, not the end of another word; after a JSON
 * string's line break too.
 */
const SF_ORG = /(?:(?<![\w$-])|(?<=\\n))sf[\s\uE000]+org(?![\w:-])/g;

/**
 * Each `sf org …` of `text` the CLI does not have, or with a flag its command
 * does not take: `<where>: <what>`.
 */
export function wrongCommands(path, text) {
  const read = joined(text);
  const starts = [...read.matchAll(SF_ORG)];
  const found = [];
  for (const [n, match] of starts.entries()) {
    const before = read.charAt(match.index - 1);
    const from = match.index + match[0].length;
    // Between quotes, the line ends where they close; else at the end of the
    // line, a JSON string's among them, or where a shell goes on to another
    // command. Either way, before the next sf command.
    const closed =
      before !== '' && `"'\``.includes(before)
        ? read.indexOf(before, from)
        : read.slice(from).search(/\\n|[\n;|&]/) + from;
    const ends = [closed, starts[n + 1]?.index ?? -1].filter((at) => at >= from);
    const segment = read.slice(from, ends.length > 0 ? Math.min(...ends) : undefined);
    const tokens = segment
      .split(/\s+/)
      .map(bare)
      .filter((token) => token !== '');
    let id = 'org';
    let command;
    let at = 0;
    // A word glued to what is not one ends the command there: a pattern's
    // `login/` or `sfdxurl[^\n]*`.
    let glued = false;
    for (; at < tokens.length && !glued; at++) {
      const word = /^[a-z][a-z-]*/.exec(tokens[at])?.[0];
      if (word === undefined || !TOPICS.has(`${id}:${word}`)) break;
      id = `${id}:${word}`;
      if (FLAGS.has(id)) command = id;
      glued = word !== tokens[at];
    }
    const prefix = read.slice(0, match.index);
    const line = prefix.split('\n').length + prefix.split(JOINED).length - 1;
    if (command === undefined) {
      // A topic alone, `sf org login`, lists its commands; a word after it
      // that is none of them is a command the CLI does not have.
      const next = glued ? undefined : /^[a-z][a-z-]*/.exec(tokens[at] ?? '')?.[0];
      if (next !== undefined) {
        found.push(`${path}:${line}: sf ${id.split(':').join(' ')} ${next}`);
      }
      continue;
    }
    const flags = FLAGS.get(command);
    for (const token of tokens.slice(at)) {
      const flag = /^(--?[a-zA-Z][\w-]*)/.exec(token)?.[1];
      if (flag !== undefined && !flags.has(flag)) {
        found.push(`${path}:${line}: sf ${command.split(':').join(' ')} ${flag}`);
      }
    }
  }
  return found;
}

/** Whether a finding is one of {@link ALLOWED}. */
const allowed = (path, finding) =>
  ALLOWED.some(
    (entry) =>
      (typeof entry.file === 'string' ? entry.file === path : entry.file.test(path)) &&
      finding.endsWith(`: sf ${entry.words}`),
  );

/** The text files git tracks, as paths from the repository's root. */
function trackedTextFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(
      (path) =>
        path !== '' &&
        path !== SELF &&
        path !== 'pnpm-lock.yaml' &&
        (/\.(?:[cm]?[jt]sx?|json|md|ya?ml|sh|ps1|txt)$/.test(path) ||
          basename(path) === 'Jenkinsfile'),
    );
}

const files = trackedTextFiles();
const findings = files.flatMap((path) =>
  wrongCommands(path, readFileSync(resolve(root, path), 'utf8')).map((finding) => ({
    path,
    finding,
  })),
);

test('reads the messages, the locales, the pages and the pipelines that name an sf command', () => {
  for (const path of [
    'packages/extension/cli/sfFailure.ts',
    'packages/extension/cli/sfSession.ts',
    'packages/extension/src/core/connection/ConnectionHelper.ts',
    'packages/webview/src/i18n/locales/en.json',
    'packages/extension/l10n/bundle.l10n.fr.json',
    'docs/getting-started.md',
    'ci-examples/README.md',
    'ci-examples/github-actions.yml',
    'ci-examples/Jenkinsfile',
    '.github/workflows/canary.yml',
  ]) {
    assert.ok(files.includes(path), `${path} is not read`);
  }
});

test('every sf org line names a command of the Salesforce CLI, with flags it takes', () => {
  const wrong = findings
    .filter(({ path, finding }) => !allowed(path, finding))
    .map(({ finding }) => finding);
  assert.deepEqual(
    wrong,
    [],
    'sf has no such command or flag (sf commands --json lists them): name the one it has, ' +
      `as its help writes it.\n${wrong.join('\n')}`,
  );
});

test('finds a command sf lacks in a sentence, a glued string, a shell line and a flag; lets a command, a topic and prose be', () => {
  const probe = [
    'sign in with "sf org login web --alias DEV" (in a CI job, "sf org login sfdxurl").',
    '`"sf org login jwt" or "sf org login ` +\n        `sfdxurl"); then run it again`',
    `'(in a CI job, "sf ' +\n        'org login sfdx' + 'url").'`,
    '  sf org login sfdx-url --sfdx-url-file "$auth_dir/source.txt" \\\n    --alias ci --tgt x',
    'Run "sf org display --target-org DEV --verbose", then "sf org list" names them.',
    '"sf org login" lists the ways to sign in; sf org display reached the org.',
    'the secrets of the org: sf org secrets and a record',
    '"Cannot connect:\\nsf org login sfdxurl, or sf org open --target-org DEV\\n- sf org list"',
    'expect(said).toMatch(/sf org login sfdxurl[^\\n]*--alias ci-target/);',
    "// try 'sf org auth\n// show-access-token' or 'sf org auth\n// show-token'",
  ].join('\n');
  assert.deepEqual(
    wrongCommands('probe', probe).map((finding) => finding.replace(/^probe:\d+: /, '')),
    [
      'sf org login sfdxurl',
      'sf org login sfdxurl',
      'sf org login sfdxurl',
      'sf org login sfdx-url --tgt',
      'sf org secrets',
      'sf org login sfdxurl',
      'sf org login sfdxurl',
      'sf org auth show-token',
    ],
  );
});

test('each allowed word still stands where it is allowed', () => {
  for (const entry of ALLOWED) {
    assert.ok(
      findings.some(({ path, finding }) => allowed(path, finding) && finding.endsWith(entry.words)),
      `nothing says "sf ${entry.words}" any more: remove it from ALLOWED (${entry.why})`,
    );
  }
});
