#!/usr/bin/env node
/**
 * The `sandforge` npm package: the command-line scripts of
 * `packages/extension/cli/`, bundled with everything they import, so that
 * `npx sandforge clone …` and `npx -y sandforge mcp` run without a checkout.
 *
 *   node scripts/npm-package.mjs build [<folder>]                build it (packages/cli/dist)
 *   node scripts/npm-package.mjs check [<folder>] [--node <node>]  the checks before publishing
 *   node scripts/npm-package.mjs redirects [<folder>]            the packages that keep the old
 *                                                                 names (dist/npm-redirects)
 *   node scripts/npm-package.mjs check-redirects [<folder>] [--node <node>]  their checks
 *   node scripts/npm-package.mjs check-sf [<folder>] [--node <node>] [--sf <sf>]
 *                                                                 the package as a plugin of a
 *                                                                 real sf, installed in folders
 *                                                                 of its own (sf of the PATH
 *                                                                 by default)
 *
 * The package is assembled in a folder of its own and published from there:
 * `packages/cli/package.json` is a private workspace manifest that carries
 * the version, and the manifest published is written here, where its choices
 * can be explained. Three manifests named `sandforge` in one workspace (the
 * root, the extension's and this one) would be one too many for `pnpm
 * --filter`, which already takes the first two for each other.
 *
 * What the scripts say of how they are run assumes a checkout: their usage
 * lines read `pnpm exec tsx packages/extension/cli/sandforge-seed.ts`, the MCP
 * server tells the model it runs "from a checkout of its repository", and the
 * runner the MCP server and `sandforge-env` start the scripts with looks for
 * `.ts` files beside it. Packaged, each of these would be false, so the build
 * rewrites them on the way in (`REWRITES`), leaving the sources as they are;
 * each rewrite has to find its text, and the build fails when the output
 * still names a checkout (`CHECKOUT_WORDS`).
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { identifiersIn, masked } from './check-confidential.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION = join(root, 'packages', 'extension');
const CLI = join(EXTENSION, 'cli');
const PACKAGE = join(root, 'packages', 'cli');

/** Where `build` and `check` work by default: ignored by git, published from. */
export const DEFAULT_OUT = join(PACKAGE, 'dist');

/**
 * The oldest Node the package runs on. The scripts are typed against
 * `@types/node` 20.19 and `lib: ES2022` (ADR 0005 holds the extension to the
 * Node of the oldest VS Code it supports, and `cli/` shares its code), and no
 * package bundled asks for more than Node 18. The repository's own Node 24 is
 * its toolchain's (pnpm 11, Vite 8, Vitest 5), not the scripts'. Most people
 * who run Salesforce tooling are on 20 or 22; the CLI `sf` itself asks for 22.
 */
export const NODE_FLOOR = '20.19.0';

/** What the build looks for in its output, and fails on: a checkout these scripts no longer need. */
export const CHECKOUT_WORDS = [
  'pnpm exec tsx',
  'packages/extension/cli',
  'build:shared',
  'of a checkout',
  'this checkout',
];

/**
 * The texts of the scripts that hold only from a checkout, and what they read
 * packaged. Each `file` names the one source it is in; the others run over
 * every script. A rewrite that no longer finds its text fails the build: its
 * script changed, and what it says packaged has to be looked at again.
 */
export const REWRITES = [
  {
    name: 'the file a runner starts a script from',
    file: 'scriptRunner.ts',
    find: /join\(__dirname, `\$\{script\}\.ts`\)/g,
    replace: 'join(__dirname, `${script}.mjs`)',
  },
  {
    name: "Seed's English catalogue",
    file: 'sandforge-seed.ts',
    find: /join\(\s*__dirname,\s*'\.\.',\s*'\.\.',\s*'webview',\s*'src',\s*'i18n',\s*'locales',\s*'en\.json',?\s*\)/g,
    replace: "join(__dirname, 'catalogue.en.json')",
  },
  {
    name: 'the line the MCP server says a script ran with',
    file: 'sandforge-mcp.ts',
    find: /\['pnpm exec tsx', `packages\/extension\/cli\/\$\{script\}\.ts`, \.\.\.quoted\]/g,
    replace: "['npx sandforge', script.replace(/^sandforge-/, ''), ...quoted]",
  },
  {
    name: "the MCP server's help",
    file: 'sandforge-mcp.ts',
    find: /Run from the repository root of a checkout, after\n {2}pnpm install and pnpm build:shared\. In Claude Code, from there:\n {4}claude mcp add sandforge -- pnpm exec tsx packages\/extension\/cli\/sandforge-mcp\.ts/g,
    replace: 'In Claude Code:\n    claude mcp add sandforge -- npx -y sandforge mcp',
  },
  {
    name: 'what the MCP server tells the model it runs from',
    file: 'sandforge-mcp.ts',
    find: /run from a ' \+\n\s*'checkout of its repository\. /g,
    replace: 'run from the sandforge npm package. ',
  },
  {
    name: 'what seed_templates reads',
    file: 'sandforge-mcp.ts',
    find: /Reads this checkout alone\./g,
    replace: 'Reads no org.',
  },
  {
    name: 'where a script is run from',
    find: /\n {2}Run from the repository root of a checkout, after pnpm install and\n {2}pnpm build:shared\.\n/g,
    replace: '',
  },
  {
    name: 'the command a script is run by',
    find: /pnpm exec tsx packages\/extension\/cli\/sandforge-([a-z]+)\.ts/g,
    replace: 'npx sandforge $1',
  },
  {
    name: 'the command a line tells its reader to run',
    file: 'invocation.ts',
    find: /`pnpm exec tsx packages\/extension\/cli\/sandforge-\$\{tool\}\.ts`/g,
    replace: '`npx sandforge ${tool}`',
  },
];

/** The scripts of `cli/` that start themselves, by the name `sandforge` takes: `seed`, `clone`… */
export function toolNames() {
  return readdirSync(CLI)
    .map((file) => /^sandforge-([a-z]+)\.ts$/.exec(file)?.[1])
    .filter((name) => name !== undefined)
    .sort();
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** The version the package is built at: its workspace manifest's, refused when the extension's differs. */
export function packageVersion(
  ownManifest = join(PACKAGE, 'package.json'),
  extensionManifest = join(EXTENSION, 'package.json'),
) {
  const own = readJson(ownManifest).version;
  const extension = readJson(extensionManifest).version;
  if (own !== extension) {
    throw new Error(
      `packages/cli/package.json is at ${own} and the extension at ${extension}: ` +
        'scripts/bump-version.sh moves them together',
    );
  }
  return own;
}

/** The manifest the package is published with. */
export function manifest(version, tools = toolNames()) {
  const extension = readJson(join(EXTENSION, 'package.json'));
  const repository = extension.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
  return {
    name: 'sandforge',
    version,
    description:
      "SandForge's command lines, without the editor: seed, clone and sync Salesforce orgs, " +
      'checkpoints and rewinds, masking, Frozen Datasets, sandforge.yaml environments, and an ' +
      'MCP server for AI agents.',
    keywords: [
      'salesforce',
      'sandbox',
      'test data',
      'seed data',
      'data masking',
      'scratch org',
      'sf',
      'mcp',
      'cli',
    ],
    homepage: extension.homepage,
    bugs: extension.bugs,
    // Provenance and trusted publishing match this against the repository the
    // workflow runs in.
    repository: { type: 'git', url: `git+${repository}.git`, directory: 'packages/cli' },
    license: extension.license,
    author: extension.author,
    bin: Object.fromEntries([
      ['sandforge', 'bin/sandforge.mjs'],
      ...tools.map((tool) => [`sandforge-${tool}`, `bin/sandforge-${tool}.mjs`]),
    ]),
    files: ['bin/', 'lib/', 'THIRD-PARTY-NOTICES.md', SF_MANIFEST],
    engines: { node: `>=${NODE_FLOOR}` },
    // The same package is a plugin of the Salesforce CLI: `sf plugins install
    // sandforge`, then `sf sandforge clone …`. npm reads none of this, and
    // nothing of it is a dependency: `npx sandforge` runs as it did.
    oclif: {
      commands: `./${SF_COMMANDS}`,
      topicSeparator: ' ',
      topics: { sandforge: { description: SF_TOPIC } },
      hooks: { init: `./${SF_HELP_HOOK}` },
    },
  };
}

/**
 * Where the commands of the sf plugin are, from the package's root. oclif
 * makes a command of every script file under it, by its path:
 * `sandforge/clone.mjs` is `sandforge:clone`, `sandforge/index.mjs` is
 * `sandforge`. Nothing else lives there.
 */
export const SF_COMMANDS = 'lib/sf';

/** The manifest of the sf plugin's commands, which oclif reads instead of importing each one. */
export const SF_MANIFEST = 'oclif.manifest.json';

/** The `init` hook that answers `sf sandforge … --help` with the script's own help. */
export const SF_HELP_HOOK = 'lib/sfHelpHook.mjs';

/** What sf says of the topic and of the root command `sf sandforge`. */
export const SF_TOPIC =
  "SandForge's command lines: seed, clone, sync, checkpoints, masking, Frozen Datasets, " +
  'sandforge.yaml, pipelines, MCP';

/** The hidden command the sfdx-hardis VS Code extension asks each plugin for its menus. */
export const HARDIS_COMMAND = 'hardis-commands';

/**
 * A command of the package: refuses a Node older than the package's floor
 * (npm only warns on `engines`), then starts its file in `lib/` as if that
 * file had been run itself. Under POSIX npm links `.bin/sandforge-clone` to
 * this file, and `process.argv[1]` is that link, with no extension: the
 * script's own start, which reads its file name there, would not see itself
 * and the command would end on 0 having done nothing.
 */
export function binStub(target) {
  return `#!/usr/bin/env node
${nodeGuard('', ['process.exit(1);'])}
const { fileURLToPath } = await import('node:url');
const entry = new URL('../lib/${target}', import.meta.url);
process.argv[1] = fileURLToPath(entry);
await import(entry.href);
`;
}

/**
 * The refusal of a Node older than the package's floor, the same sentence on
 * every way in: `bin/`, and the commands of the sf plugin, which sf starts
 * without `bin/` (sf 2.140 and older run on Node 18).
 *
 * @param indent - What each line opens on.
 * @param refuse - The lines that end the command once the sentence is said.
 */
function nodeGuard(indent, refuse) {
  const [major, minor] = NODE_FLOOR.split('.').map(Number);
  return [
    "const [major, minor] = process.versions.node.split('.').map(Number);",
    `if (major < ${major} || (major === ${major} && minor < ${minor})) {`,
    '  process.stderr.write(',
    `    'sandforge needs Node.js ${major}.${minor} or later, and this is ' + process.versions.node + '. Nothing was run.\\n',`,
    '  );',
    ...refuse.map((line) => `  ${line}`),
    '}',
  ]
    .map((line) => `${indent}${line}`)
    .join('\n');
}

/**
 * The commands of the sf plugin, each a class oclif takes for a command
 * because it has a static `run`, with no `@oclif/core` behind it: the root
 * `sandforge`, one per script, and the hidden menus of sfdx-hardis.
 *
 * @param tools - What each script does, by name: `TOOLS` of the built dispatcher.
 * @param paragraphs - The first paragraph of each script's `--help`, by name,
 *   and of `sandforge --help` under `''`.
 * @returns For each: its id, its file in `lib/sf/sandforge/`, the statics of
 *   its class, and the call its `run` makes once the Node is checked.
 */
export function sfCommands(tools, paragraphs) {
  const argv = (description) => ({ argv: { name: 'argv', description } });
  const command = (id, file, statics, call) => ({
    id,
    file,
    statics: {
      summary: statics.summary,
      description: statics.description,
      hidden: statics.hidden ?? false,
      strict: false,
      flags: {},
      args: statics.args,
    },
    call,
  });
  return [
    command(
      'sandforge',
      'index.mjs',
      {
        summary: SF_TOPIC,
        description: `${paragraphs['']}\n\nIts commands: sf sandforge --help. The whole help of one, its options and its exit codes: sf sandforge <command> --help.`,
        args: argv('the words npx sandforge takes'),
      },
      "const { runTool } = await import('../../sfPlugin.mjs');\nawait runTool('', argv);",
    ),
    ...Object.entries(tools).map(([tool, summary]) =>
      command(
        `sandforge:${tool}`,
        `${tool}.mjs`,
        {
          summary,
          description: `${paragraphs[tool]}\n\nThe whole help, its options and its exit codes: sf sandforge ${tool} --help.`,
          args: argv(`the words npx sandforge ${tool} takes`),
        },
        `const { runTool } = await import('../../sfPlugin.mjs');\nawait runTool(${JSON.stringify(tool)}, argv);`,
      ),
    ),
    command(
      `sandforge:${HARDIS_COMMAND}`,
      `${HARDIS_COMMAND}.mjs`,
      {
        summary: 'the menus of SandForge in the sfdx-hardis VS Code extension',
        description:
          'The entries SandForge adds to the menus of the sfdx-hardis VS Code extension, each ' +
          'reaching no org. With --json, the document the extension reads, alone on stdout.',
        hidden: true,
        args: argv('nothing, or --json for the document the extension reads'),
      },
      "const { hardisCommands } = await import('../../sfPlugin.mjs');\nprocess.exitCode = hardisCommands(argv);",
    ),
  ];
}

/** The file of a command of the sf plugin: its class, its Node checked before anything is loaded. */
export function sfCommandStub({ statics, call }) {
  const fields = Object.entries(statics).map(
    ([key, value]) => `  static ${key} = ${JSON.stringify(value)};`,
  );
  return `export default class SandforgeCommand {
${fields.join('\n')}
  static async run(argv) {
${nodeGuard('    ', ['process.exitCode = 1;', 'return;'])}
${call
  .split('\n')
  .map((line) => `    ${line}`)
  .join('\n')}
  }
}
`;
}

/**
 * A command's entry in `oclif.manifest.json`: what oclif's `cacheCommand`
 * makes of its class's statics, so that sf lists and finds it without
 * importing it, and finds the same thing when it does.
 */
export function manifestEntry(id, statics, relativePath) {
  const entry = {
    aliases: (statics.aliases ?? []).map((alias) => alias.replaceAll(' ', ':')),
    args: Object.fromEntries(
      Object.entries(statics.args ?? {}).map(([name, arg]) => [
        name,
        { description: arg.description, name },
      ]),
    ),
    description: statics.description,
    examples: statics.examples ?? statics.example,
    flags: statics.flags,
    hasDynamicHelp: false,
    hidden: statics.hidden,
    hiddenAliases: statics.hiddenAliases ?? [],
    id,
    pluginAlias: 'sandforge',
    pluginName: 'sandforge',
    pluginType: 'core',
    strict: statics.strict,
    summary: statics.summary,
    isESM: true,
    relativePath,
  };
  // What oclif leaves undefined is not written.
  return JSON.parse(JSON.stringify(entry));
}

/** The first paragraph of a help, its lines joined: sf wraps it to the terminal itself. */
export function firstParagraph(help) {
  return help
    .split(/\n[ \t]*\n/)[0]
    .split('\n')
    .map((line) => line.trim())
    .join(' ');
}

/**
 * The packages that keep the names the scripts went by, `sandforge-clone`,
 * `sandforge-checkpoint`… Their messages used to print those names, and a
 * line copied as `npx sandforge-checkpoint …` asks the registry for a package
 * of that name, which anybody could publish while it is free. Each holds the
 * name and says what runs now, then ends on 2 having run nothing: it never
 * hands the line on to `sandforge`, which would make it a second way into the
 * package to keep safe. One per command, at the package's version.
 */
// Outside packages/cli, which holds the package's manifest and README alone
// (docs/product-claims.test.mjs), and ignored by git as every dist/ is.
export const REDIRECTS_OUT = join(root, 'dist', 'npm-redirects');

/** The exit code of a redirect: the line named nothing that runs. */
export const REDIRECT_EXIT = 2;

/** What a redirect says on stderr, and all it does. */
export function redirectMessage(tool) {
  return `sandforge-${tool} is now \`npx sandforge ${tool}\`. Nothing was run.\n`;
}

/** The repository's address on GitHub, as the extension's manifest names it. */
function repositoryUrl() {
  const extension = readJson(join(EXTENSION, 'package.json'));
  return extension.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
}

/** The manifest of the redirect that keeps `sandforge-<tool>`. */
export function redirectManifest(tool, version) {
  const extension = readJson(join(EXTENSION, 'package.json'));
  return {
    name: `sandforge-${tool}`,
    version,
    description: `Kept for the sandforge package: this command is now \`npx sandforge ${tool}\`.`,
    homepage: extension.homepage,
    bugs: extension.bugs,
    repository: { type: 'git', url: `git+${repositoryUrl()}.git`, directory: 'packages/cli' },
    license: extension.license,
    author: extension.author,
    bin: { [`sandforge-${tool}`]: 'bin.mjs' },
    files: ['bin.mjs'],
    engines: { node: `>=${NODE_FLOOR}` },
  };
}

/** The command of a redirect: its message, and exit 2. */
export function redirectBin(tool) {
  return `#!/usr/bin/env node
process.stderr.write(${JSON.stringify(redirectMessage(tool))});
process.exitCode = ${REDIRECT_EXIT};
`;
}

/** The one line a redirect's README holds. */
export function redirectReadme(tool) {
  return (
    `\`sandforge-${tool}\` is kept for the [sandforge](https://www.npmjs.com/package/sandforge) ` +
    `package: run \`npx sandforge ${tool}\`. Source: ${repositoryUrl()}.\n`
  );
}

/**
 * Build the redirects into `out`, one folder per command, refusing a folder
 * that holds anything they do not write.
 *
 * @returns The folder, and the folder of each package.
 */
export function buildRedirects(out = REDIRECTS_OUT) {
  const version = packageVersion();
  const tools = toolNames();
  if (existsSync(out)) {
    const strange = readdirSync(out).filter(
      (entry) => !/^sandforge-[a-z]+$/.test(entry) || !tools.includes(entry.slice(10)),
    );
    if (strange.length > 0) {
      throw new Error(`${out} holds ${strange.join(', ')}: no build of the redirects writes these`);
    }
    rmSync(out, { recursive: true, force: true });
  }
  const packages = tools.map((tool) => {
    const folder = join(out, `sandforge-${tool}`);
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, 'package.json'),
      `${JSON.stringify(redirectManifest(tool, version), null, 2)}\n`,
    );
    writeFileSync(join(folder, 'bin.mjs'), redirectBin(tool));
    chmodSync(join(folder, 'bin.mjs'), 0o755);
    writeFileSync(join(folder, 'README.md'), redirectReadme(tool));
    copyFileSync(join(root, 'LICENSE'), join(folder, 'LICENSE'));
    return { tool, folder };
  });
  return { out, packages };
}

/**
 * `__dirname`, `__filename` and `require` in every output file: the scripts
 * are CommonJS (their `package.json` and their neighbours are found from
 * `__dirname`), and the CommonJS packages bundled call `require`.
 */
const BANNER = [
  "import { createRequire as __sandforgeRequire } from 'node:module';",
  "import { fileURLToPath as __sandforgePath } from 'node:url';",
  "import { dirname as __sandforgeDirname } from 'node:path';",
  'const require = __sandforgeRequire(import.meta.url);',
  'const __filename = __sandforgePath(import.meta.url);',
  'const __dirname = __sandforgeDirname(__filename);',
].join('\n');

/** The esbuild plugin that applies `REWRITES` to the sources of `cli/`, and notes which ones applied. */
function rewritePlugin(applied) {
  return {
    name: 'sandforge-npm-rewrites',
    setup(build) {
      build.onLoad({ filter: /[\\/]packages[\\/]extension[\\/]cli[\\/][^\\/]+\.ts$/ }, (args) => {
        let text = readFileSync(args.path, 'utf8');
        for (const rewrite of REWRITES) {
          if (rewrite.file !== undefined && basename(args.path) !== rewrite.file) continue;
          const next = text.replace(rewrite.find, rewrite.replace);
          if (next !== text) applied.add(rewrite.name);
          text = next;
        }
        return { contents: text, loader: 'ts' };
      });
    },
  };
}

/** The root of the npm package a bundled file belongs to, or null for our own sources. */
function packageRootOf(input) {
  const at = input.lastIndexOf('node_modules/');
  if (at === -1) return null;
  const parts = input.slice(at + 'node_modules/'.length).split('/');
  const depth = parts[0].startsWith('@') ? 2 : 1;
  return input.slice(0, at + 'node_modules/'.length) + parts.slice(0, depth).join('/');
}

/** The notices of every npm package bundled, read from the build's metafile. */
export function thirdPartyNotices(metafile) {
  const roots = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const packageRoot = packageRootOf(input);
    if (packageRoot) roots.add(packageRoot);
  }
  const entries = [...roots]
    .map((packageRoot) => {
      const folder = join(root, packageRoot);
      const pkg = readJson(join(folder, 'package.json'));
      const licenseFile = readdirSync(folder).find((file) =>
        /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(file),
      );
      return { pkg, text: licenseFile ? readFileSync(join(folder, licenseFile), 'utf8') : null };
    })
    .sort((a, b) => a.pkg.name.localeCompare(b.pkg.name));
  const sections = entries.map(({ pkg, text }) => {
    const license = pkg.license ?? (pkg.licenses ?? []).map((each) => each.type).join(' OR ');
    const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    const head = [
      `## ${pkg.name} ${pkg.version}`,
      '',
      `License: ${license || 'not declared'}`,
      ...(repository ? [`Repository: ${repository}`] : []),
      '',
    ];
    const body = text
      ? ['````', text.trim(), '````']
      : [`The package ships no license file; its package.json declares ${license || 'none'}.`];
    return [...head, ...body, ''].join('\n');
  });
  return [
    '# Third-party notices',
    '',
    'The files of `lib/` bundle the following packages, under their own licenses. SandForge',
    'itself is under the MIT license in `LICENSE`.',
    '',
    ...sections,
  ].join('\n');
}

/** What a build writes at the top of its folder, and all it writes. */
const BUILT = new Set([
  'bin',
  'lib',
  'package.json',
  'README.md',
  'LICENSE',
  'THIRD-PARTY-NOTICES.md',
  SF_MANIFEST,
]);

/**
 * Empty the folder of an earlier build, a build that failed half way
 * included; refuse a folder that holds anything a build does not write.
 */
function clearOut(out) {
  if (!existsSync(out)) return;
  const strange = readdirSync(out).filter((entry) => !BUILT.has(entry));
  if (strange.length > 0) {
    throw new Error(
      `${out} holds ${strange.join(', ')}: no build of the sandforge package writes these`,
    );
  }
  rmSync(out, { recursive: true, force: true });
}

/**
 * Write the commands of the sf plugin and their manifest into a package whose
 * scripts and `bin/` are built: each command says what `TOOLS` of the built
 * dispatcher says of its script, and the first paragraph of its `--help`.
 */
async function writeSfCommands(out, version) {
  const { TOOLS } = await import(pathToFileURL(join(out, 'lib', 'sandforge.mjs')).href);
  const home = scratchFolder();
  let paragraphs;
  try {
    const helpOf = (words) => {
      const asked = runBin(out, ['sandforge', ...words, '--help'], {
        node: process.execPath,
        env: sealedEnv(home),
        cwd: home,
      });
      if (asked.code !== 0) {
        throw new Error(
          `sandforge ${words.join(' ')} --help ended on ${asked.code}: ${asked.stderr}`,
        );
      }
      return firstParagraph(asked.stdout);
    };
    paragraphs = Object.fromEntries([
      ['', helpOf([])],
      ...Object.keys(TOOLS).map((tool) => [tool, helpOf([tool])]),
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  const folder = join(out, SF_COMMANDS, 'sandforge');
  mkdirSync(folder, { recursive: true });
  const commands = {};
  for (const command of sfCommands(TOOLS, paragraphs)) {
    writeFileSync(join(folder, command.file), sfCommandStub(command));
    commands[command.id] = manifestEntry(command.id, command.statics, [
      ...SF_COMMANDS.split('/'),
      'sandforge',
      command.file,
    ]);
  }
  writeFileSync(join(out, SF_MANIFEST), `${JSON.stringify({ commands, version })}\n`);
}

/**
 * Build the package into `out`.
 *
 * @returns The folder, and the npm packages bundled.
 */
export async function build(out = DEFAULT_OUT) {
  const version = packageVersion();
  const tools = toolNames();
  clearOut(out);
  const lib = join(out, 'lib');
  const bin = join(out, 'bin');
  mkdirSync(lib, { recursive: true });
  mkdirSync(bin, { recursive: true });

  // esbuild is the extension's: the one its own bundle is built with.
  const esbuild = createRequire(join(EXTENSION, 'package.json'))('esbuild');
  const applied = new Set();
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [
      join(CLI, 'sandforge.ts'),
      ...tools.map((tool) => join(CLI, `sandforge-${tool}.ts`)),
      // The sf plugin: what its commands run, and its help hook, which every
      // sf command of whoever installed it loads, alone.
      join(CLI, 'sfPlugin.ts'),
      join(CLI, 'sfHelpHook.ts'),
    ],
    outdir: lib,
    entryNames: '[name]',
    chunkNames: 'chunk-[hash]',
    outExtension: { '.js': '.mjs' },
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'node',
    target: `node${NODE_FLOOR.split('.')[0]}`,
    minify: true,
    // No map: it would carry the paths of the machine that built it, and the
    // sources are public on GitHub.
    sourcemap: false,
    // The licenses are in THIRD-PARTY-NOTICES.md, whole.
    legalComments: 'none',
    banner: { js: BANNER },
    // As the extension's own build: shared from its sources, one zod.
    alias: { '@sandforge/shared': join(root, 'packages', 'shared', 'src', 'index.ts') },
    // Only the extension host provides it; the scripts reach it through a
    // dynamic import on paths the command line never takes.
    external: ['vscode'],
    plugins: [rewritePlugin(applied)],
    metafile: true,
    logLevel: 'error',
  });
  const missed = REWRITES.filter((rewrite) => !applied.has(rewrite.name)).map((r) => r.name);
  if (missed.length > 0) {
    throw new Error(`these rewrites found nothing to rewrite, look again: ${missed.join('; ')}`);
  }

  // The sources open on `#!/usr/bin/env tsx`, which a bundled script is not
  // run under: the commands of bin/ start them, so the line goes.
  for (const file of readdirSync(lib)) {
    const path = join(lib, file);
    const text = readFileSync(path, 'utf8');
    if (text.startsWith('#!')) writeFileSync(path, text.slice(text.indexOf('\n') + 1));
  }

  const english = readJson(join(root, 'packages', 'webview', 'src', 'i18n', 'locales', 'en.json'));
  writeFileSync(
    join(lib, 'catalogue.en.json'),
    `${JSON.stringify({ seed: { templates: english.seed.templates } })}\n`,
  );

  const stubs = [
    ['sandforge', 'sandforge.mjs'],
    ...tools.map((t) => [`sandforge-${t}`, `sandforge-${t}.mjs`]),
  ];
  for (const [name, target] of stubs) {
    writeFileSync(join(bin, `${name}.mjs`), binStub(target));
    chmodSync(join(bin, `${name}.mjs`), 0o755);
  }

  writeFileSync(
    join(out, 'package.json'),
    `${JSON.stringify(manifest(version, tools), null, 2)}\n`,
  );
  copyFileSync(join(PACKAGE, 'README.md'), join(out, 'README.md'));
  copyFileSync(join(root, 'LICENSE'), join(out, 'LICENSE'));
  writeFileSync(join(out, 'THIRD-PARTY-NOTICES.md'), thirdPartyNotices(result.metafile));

  // The commands' help is read from the package as built: its version too.
  await writeSfCommands(out, version);

  const leftOver = scanText(out);
  if (leftOver.length > 0)
    throw new Error(`the package is not fit to publish:\n  ${leftOver.join('\n  ')}`);

  const bundled = [
    ...new Set(
      Object.keys(result.metafile.inputs)
        .map((input) => packageRootOf(input))
        .filter((packageRoot) => packageRoot !== null)
        .map((packageRoot) =>
          packageRoot.slice(packageRoot.lastIndexOf('node_modules/') + 'node_modules/'.length),
        ),
    ),
  ].sort();
  return { out, bundled };
}

/** Every file of a folder, relative to it, with `/` between its parts. */
function filesOf(folder, prefix = '') {
  return readdirSync(folder).flatMap((entry) => {
    const path = join(folder, entry);
    const name = prefix ? `${prefix}/${entry}` : entry;
    return statSync(path).isDirectory() ? filesOf(path, name) : [name];
  });
}

/**
 * What in a built package's text would not be fit to publish: a source map,
 * a path of the machine that built it, a phrase that sends the reader to a
 * checkout.
 */
export function scanText(out) {
  const problems = [];
  const machine = [root, root.split(sep).join('/'), 'node_modules/.pnpm'];
  for (const file of filesOf(out)) {
    if (file.endsWith('.map')) problems.push(`${file}: a source map`);
    const text = readFileSync(join(out, file), 'utf8');
    if (/sourceMappingURL=/.test(text)) problems.push(`${file}: points at a source map`);
    for (const path of machine) {
      if (text.includes(path))
        problems.push(`${file}: names "${path}" of the machine that built it`);
    }
    if (file.startsWith('lib/') && file.endsWith('.mjs')) {
      for (const words of CHECKOUT_WORDS) {
        if (text.includes(words)) problems.push(`${file}: still says "${words}"`);
      }
    }
  }
  return problems;
}

/** A run of a command of the package. */
export function runBin(out, args, options = {}) {
  const node = options.node ?? process.env.SANDFORGE_BIN_NODE ?? process.execPath;
  const [command = 'sandforge', ...rest] = args;
  const result = spawnSync(node, [join(out, 'bin', `${command}.mjs`), ...rest], {
    encoding: 'utf8',
    env: options.env ?? process.env,
    cwd: options.cwd ?? tmpdir(),
    timeout: 60_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Talk to the packaged MCP server: each message sent once the answer to the
 * one before it has come, then its input closed.
 *
 * @returns The answers, in order, and how the server ended.
 */
export function talkToMcp(out, messages, options = {}) {
  const node = options.node ?? process.env.SANDFORGE_BIN_NODE ?? process.execPath;
  // `options.line`: another way in to the same server, `sf sandforge mcp`.
  const [command, ...args] = options.line ?? [node, join(out, 'bin', 'sandforge.mjs'), 'mcp'];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      cwd: options.cwd ?? tmpdir(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const answers = [];
    let pending = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`the MCP server did not answer in time; it said:\n${stderr}`));
    }, 60_000);
    const sendNext = () => {
      const next = messages[answers.length];
      if (next === undefined) child.stdin.end();
      else child.stdin.write(`${JSON.stringify(next)}\n`);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      let at;
      while ((at = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, at);
        pending = pending.slice(at + 1);
        if (line.trim() === '') continue;
        answers.push(JSON.parse(line));
        sendNext();
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ answers, code, stderr });
    });
    sendNext();
  });
}

/** A Node's `major.minor.patch`, as `node --version` prints it. */
export function nodeVersionOf(node) {
  return spawnSync(node, ['--version'], { encoding: 'utf8' }).stdout.trim().replace(/^v/, '');
}

/** The files `npm pack` would put in the package, as npm itself lists them. */
export function packedFiles(out) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: out,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) throw new Error(`npm pack --dry-run failed: ${result.stderr}`);
  // npm 10 and 11 answer a list of the packages packed, npm 12 an object by name.
  const answer = JSON.parse(result.stdout);
  const [packed] = Array.isArray(answer) ? answer : Object.values(answer);
  return packed.files.map((file) => file.path).sort();
}

/**
 * Install the built package as npm installs it for someone, from the tarball
 * `npm pack` makes, into a folder of its own, offline: it depends on nothing.
 *
 * @returns Where the commands are: the links npm makes under POSIX; under
 *   Windows, where npm makes shell shims Node cannot run, the files they run.
 */
export function installLocally(out, prefix) {
  const windows = process.platform === 'win32';
  const npm = windows ? 'npm.cmd' : 'npm';
  const options = { encoding: 'utf8', shell: windows };
  const tarball = packInto(out, prefix);
  const target = join(prefix, 'installed');
  mkdirSync(target);
  const install = spawnSync(
    npm,
    [
      'install',
      '--offline',
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      '--no-package-lock',
      '--prefix',
      target,
      tarball,
    ],
    { ...options, cwd: target },
  );
  if (install.status !== 0)
    throw new Error(`npm install of the packed package failed: ${install.stderr}`);
  return windows
    ? join(target, 'node_modules', 'sandforge', 'bin')
    : join(target, 'node_modules', '.bin');
}

/**
 * The tarball `npm pack` makes of the built package, in `folder`: what the
 * registry would serve.
 *
 * @returns Its path.
 */
function packInto(out, folder) {
  const windows = process.platform === 'win32';
  const pack = spawnSync(
    windows ? 'npm.cmd' : 'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', folder],
    { encoding: 'utf8', shell: windows, cwd: out },
  );
  if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr}`);
  const answer = JSON.parse(pack.stdout);
  const [packed] = Array.isArray(answer) ? answer : Object.values(answer);
  return join(folder, packed.filename);
}

/** The `sf` on a PATH, or null when there is none. */
export function sfOnPath(path = process.env.PATH ?? '') {
  const names = process.platform === 'win32' ? ['sf.cmd', 'sf.exe'] : ['sf'];
  for (const folder of path.split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const file = join(folder, name);
      if (existsSync(file) && statSync(file).isFile()) return file;
    }
  }
  return null;
}

/**
 * How a check starts the Salesforce CLI `sf` names: the CLI's own script
 * under the Node checked when it is found, or `sf` as it is. npm links `sf` to
 * the script (`bin/run.js`). A shell launcher that names the script is read
 * for it: run in the check's own home, a launcher that finds its Node by
 * `$HOME` would look for it there.
 */
export function sfEntryOf(sf) {
  const real = realpathSync(sf);
  if (/\.[cm]?js$/.test(real)) return { script: true, file: real };
  const head = readFileSync(real).subarray(0, 4096).toString('utf8');
  if (/^#!.*\bnode\b/.test(head)) return { script: true, file: real };
  const named = /((?:\$\{HOME\}|\$HOME|~)?[^\s"'=]*@salesforce\/cli\/bin\/run(?:\.js)?)/.exec(
    head,
  )?.[1];
  if (named !== undefined) {
    const file = named.replace(/^(?:\$\{HOME\}|\$HOME|~)/, homedir());
    if (existsSync(file)) return { script: true, file };
  }
  return { script: false, file: sf };
}

/**
 * What of the Salesforce CLI's own folders on this machine `check-sf` could
 * change by mistake: the plugins installed, and the list of unsigned plugins
 * allowed. It never changes any of it.
 */
export function userSfFingerprint(home = homedir()) {
  const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null);
  const names = (folder) => (existsSync(folder) ? readdirSync(folder).sort() : null);
  const config = join(home, '.config', 'sf');
  const data = join(home, '.local', 'share', 'sf');
  return JSON.stringify({
    config: names(config),
    allowList: read(join(config, 'unsignedPluginAllowList.json')),
    data: names(data),
    plugins: read(join(data, 'package.json')),
  });
}

/** A path in single quotes, for a line of `sh`. */
const shQuoted = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;

/**
 * A Salesforce CLI of its own for `check-sf`: its home, its data, config and
 * cache folders in a scratch folder, telemetry, updates and the version
 * check off, npm offline, and an `sf` on the PATH that knows no org. Its
 * plugin installs land there, never in the folders of the machine's sf.
 *
 * @returns The world: how to run its sf, its environment, the package's
 *   tarball, and what the machine's sf folders held when it was made.
 */
export function sfWorld(out, node, sf) {
  const windows = process.platform === 'win32';
  const at = scratchFolder();
  const home = join(at, 'home');
  const bin = join(at, 'sf-bin');
  mkdirSync(home);
  mkdirSync(bin);
  const user = userSfFingerprint();
  const entry = sfEntryOf(sf);
  const line = entry.script ? [node, entry.file] : [entry.file];
  writeFileSync(join(bin, 'sf'), `#!/bin/sh\nexec ${line.map(shQuoted).join(' ')} "$@"\n`);
  chmodSync(join(bin, 'sf'), 0o755);
  writeFileSync(join(bin, 'sf.cmd'), `@${line.map((part) => `"${part}"`).join(' ')} %*\r\n`);
  const env = {
    ...sealedEnv(home),
    PATH: [bin, dirname(node), ...(windows ? [] : ['/usr/bin', '/bin'])].join(delimiter),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    SF_CONFIG_DIR: join(at, 'sf-config'),
    SF_DATA_DIR: join(at, 'sf-data'),
    SF_CACHE_DIR: join(at, 'sf-cache'),
    SF_DISABLE_TELEMETRY: 'true',
    SF_AUTOUPDATE_DISABLE: 'true',
    SF_SKIP_NEW_VERSION_CHECK: 'true',
    SF_USE_GENERIC_UNIX_KEYCHAIN: 'true',
    npm_config_cache: join(at, 'npm-cache'),
    npm_config_userconfig: join(at, 'npmrc'),
    npm_config_offline: 'true',
    npm_config_update_notifier: 'false',
  };
  const sfFile = join(bin, windows ? 'sf.cmd' : 'sf');
  return {
    at,
    home,
    env,
    sfFile,
    user,
    tarball: packInto(out, at),
    sf: (args) => {
      const result = spawnSync(sfFile, args, {
        encoding: 'utf8',
        env,
        cwd: home,
        // stdin closed: a question sf asks is answered by its default, no.
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: windows,
        timeout: 300_000,
        maxBuffer: 64 * 1024 * 1024,
      });
      return { code: result.status, stdout: result.stdout, stderr: result.stderr };
    },
    dispose: () => rmSync(at, { recursive: true, force: true }),
  };
}

/** The client names of `.confidential-names`, as `scripts/check-confidential.mjs` reads them. */
function confidentialNames() {
  const file = join(root, '.confidential-names');
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => !/^\s*(#|$)/.test(line));
}

/**
 * What of the built package names a client or carries a real org identifier,
 * by file: the scan of `scripts/check-confidential.mjs`, on the files that
 * are published rather than on the tracked tree.
 *
 * @returns The findings, and whether client names were checked at all.
 */
export function confidentialFindings(out) {
  const findings = [];
  for (const file of filesOf(out)) {
    readFileSync(join(out, file), 'utf8')
      .split('\n')
      .forEach((line, index) => {
        for (const id of identifiersIn(line))
          findings.push(`${file}:${index + 1} — identifier ${masked(id)}`);
      });
  }
  const names = confidentialNames();
  if (names !== null && names.length > 0) {
    const grep = spawnSync('grep', ['-rliE', '-e', names.join('|'), '.'], {
      cwd: out,
      encoding: 'utf8',
    });
    if (grep.status === 0) {
      for (const file of grep.stdout.split('\n').filter(Boolean)) {
        findings.push(`${file.replace(/^\.\//, '')} — a name listed in .confidential-names`);
      }
    } else if (grep.status !== 1) {
      throw new Error(`grep failed: ${grep.stderr}`);
    }
  }
  return { findings, namesChecked: names !== null && names.length > 0 };
}

/**
 * What a command of the package may reach while it is checked: no `sf`, a
 * home and a journal folder of its own, empty. Nothing a check runs reads an
 * org, and this holds it to that. The PATH is an empty folder: the commands
 * are started by the Node's own path and start their scripts by it, and the
 * folder a Node is installed in is where npm installs `sf` beside it — the
 * Node 22 the package is checked under held one, which the PATH of the
 * Node's folder alone handed every command.
 */
export function sealedEnv(home) {
  mkdirSync(join(home, 'journal'), { recursive: true });
  mkdirSync(join(home, 'empty-path'), { recursive: true });
  return {
    PATH: join(home, 'empty-path'),
    HOME: home,
    USERPROFILE: home,
    SANDFORGE_JOURNAL_DIR: join(home, 'journal'),
    // Windows starts `sf` through cmd.exe, found by ComSpec, which finds a
    // command by PATHEXT.
    ...(process.platform === 'win32'
      ? {
          SystemRoot: process.env.SystemRoot,
          ComSpec: process.env.ComSpec,
          PATHEXT: process.env.PATHEXT,
        }
      : {}),
  };
}

/**
 * A folder holding an `sf` of its own, which answers `sf org display` as the
 * Salesforce CLI does for an alias it does not know: its JSON document on
 * stdout, exit 1. No check runs the real `sf`.
 */
function unknownAliasSf(home, alias) {
  const bin = join(home, 'sf-bin');
  mkdirSync(bin, { recursive: true });
  const answer = JSON.stringify({
    status: 1,
    name: 'NamedOrgNotFoundError',
    message: `No authorization information found for ${alias}.`,
    exitCode: 1,
  });
  writeFileSync(join(bin, 'sf'), `#!/bin/sh\necho '${answer}'\nexit 1\n`);
  chmodSync(join(bin, 'sf'), 0o755);
  writeFileSync(join(bin, 'sf.cmd'), `@echo ${answer}\r\n@exit /b 1\r\n`);
  return bin;
}

/** The line a script's own help opens on: the command as the package names it, not a checkout's file. */
const HELP_HEAD = (tool) => `sandforge ${tool} — `;

/**
 * A pipeline file as the Automation page exports one, in `home`, whose org no
 * sf of a sealed home reaches: its plan stands up the host a run goes
 * through, then says the org was not reached, and runs nothing.
 *
 * @returns Its path.
 */
function pipelineFixture(home) {
  const file = join(home, 'nightly.sandforge-pipeline.json');
  writeFileSync(
    file,
    JSON.stringify({
      sandforgePipeline: 1,
      exportedAt: '2026-11-20T10:00:00.000Z',
      exportedBy: 'SandForge 1.81.0',
      digest: `sha256:${'0'.repeat(64)}`,
      pipeline: {
        id: 'pipe-npm-check',
        name: 'Nightly',
        description: '',
        steps: [
          { id: 's1', name: 'Health', type: 'precheck', config: { orgId: 'reg-dev' } },
          { id: 's2', name: 'Go?', type: 'approval', config: {} },
        ],
        variables: [],
        tags: [],
      },
      schedule: null,
      orgs: {
        'reg-dev': {
          alias: 'DEV',
          organizationId: '00D000000000001AAA',
          kind: 'sandbox',
          staging: false,
        },
      },
      syncConfigs: {},
      seedTemplates: {},
      maskingTemplates: {},
      settings: {},
      notes: [],
    }),
  );
  return file;
}

/** The files of `lib/sf/sandforge/`: the root, one per script, and the menus of sfdx-hardis. */
export function sfCommandFiles(tools) {
  return ['index.mjs', `${HARDIS_COMMAND}.mjs`, ...tools.map((tool) => `${tool}.mjs`)];
}

/**
 * Run a module written into `home` under `node`, from `home`.
 *
 * @returns Its exit code and what it wrote.
 */
function runModule(node, home, name, text, env, execArgv = [], args = []) {
  const file = join(home, name);
  writeFileSync(file, text);
  const result = spawnSync(node, [...execArgv, file, ...args], {
    encoding: 'utf8',
    env,
    cwd: home,
    timeout: 60_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Each class of `lib/sf/sandforge/`, imported as oclif imports it: its statics, the type of its run. */
const INTROSPECT = `import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const out = process.argv[2];
const folder = join(out, ${JSON.stringify(SF_COMMANDS)}, 'sandforge');
const classes = {};
for (const file of readdirSync(folder).sort()) {
  const { default: command } = await import(pathToFileURL(join(folder, file)).href);
  classes[file] = {
    run: typeof command?.run,
    statics: command ? Object.fromEntries(Object.keys(command).map((key) => [key, command[key]])) : null,
  };
}
const { TOOLS } = await import(pathToFileURL(join(out, 'lib', 'sandforge.mjs')).href);
process.stdout.write(JSON.stringify({ classes, tools: TOOLS }));
`;

/** The classes of the sf plugin and the dispatcher's `TOOLS`, as `node` imports them. */
function importedCommands(out, node) {
  const home = scratchFolder();
  try {
    const result = runModule(node, home, 'introspect.mjs', INTROSPECT, sealedEnv(home), [], [out]);
    if (result.code !== 0) {
      throw new Error(`the commands of the sf plugin do not import: ${result.stderr}`);
    }
    return JSON.parse(result.stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** What sf does with a command it found: import its file, then `run` with the words after its id. */
const COMMAND_DRIVER = `import { pathToFileURL } from 'node:url';
const { default: command } = await import(pathToFileURL(process.argv[2]).href);
await command.run(JSON.parse(process.argv[3]), {});
`;

/**
 * Run a command of the sf plugin as sf runs it, without sf: its class
 * imported, its `run` called with the words.
 *
 * @param tool - The script; `''` for the root command, `sandforge`.
 */
function runSfCommand(out, node, home, tool, argv, env, execArgv = []) {
  const file = join(out, SF_COMMANDS, 'sandforge', tool === '' ? 'index.mjs' : `${tool}.mjs`);
  return runModule(node, home, 'sf-command.mjs', COMMAND_DRIVER, env, execArgv, [
    file,
    JSON.stringify(argv),
  ]);
}

/** What the hook's driver prints when the hook left the line to sf. */
const HOOK_LEFT = 'the hook left the line to sf\n';

/** What sf does with an `init` hook: call it with its configuration as `this`, the id and the words. */
const HOOK_DRIVER = `import { pathToFileURL } from 'node:url';
const [hookFile, commandsJson, id, argvJson] = process.argv.slice(2);
const { default: hook } = await import(pathToFileURL(hookFile).href);
const commands = JSON.parse(commandsJson);
const config = { findCommand: (asked) => commands[asked] };
await hook.call({ config }, { id, argv: JSON.parse(argvJson), config });
process.stdout.write(${JSON.stringify(HOOK_LEFT)});
`;

/**
 * The checks a built package passes before it is published, each one a
 * function that throws what it found. `node scripts/npm-package.mjs check`
 * runs them on a package already built; `scripts/npm-package.test.mjs` on one
 * it builds.
 */
export const CHECKS = [
  {
    name: 'the manifest names the package, its version, its Node and its commands, and no dependency',
    run: ({ out }) => {
      const published = readJson(join(out, 'package.json'));
      const tools = toolNames();
      const expected = manifest(packageVersion(), tools);
      assertEqual(published, expected, 'package.json is not the manifest this build writes');
      for (const key of [
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'optionalDependencies',
        'scripts',
      ]) {
        if (key in published)
          throw new Error(`package.json has ${key}: the package runs on Node alone`);
      }
      for (const file of Object.values(published.bin)) {
        if (!existsSync(join(out, file)))
          throw new Error(`the command ${file} is not in the package`);
      }
      // The sf plugin: its commands, its manifest and its help hook, named
      // where the package has them, and still no dependency above.
      assertEqual(
        published.oclif,
        {
          commands: './lib/sf',
          topicSeparator: ' ',
          topics: { sandforge: { description: SF_TOPIC } },
          hooks: { init: './lib/sfHelpHook.mjs' },
        },
        'package.json does not make the package the sf plugin it is',
      );
      if (!published.files.includes('oclif.manifest.json')) {
        throw new Error('package.json leaves oclif.manifest.json out of its files');
      }
    },
  },
  {
    name: 'npm packs these files and no other',
    run: ({ out }) => {
      const files = packedFiles(out);
      const allowed =
        /^(package\.json|README\.md|LICENSE|THIRD-PARTY-NOTICES\.md|oclif\.manifest\.json|bin\/sandforge(-[a-z]+)?\.mjs|lib\/(sandforge(-[a-z]+)?|chunk-[A-Z0-9]+|sfPlugin|sfHelpHook)\.mjs|lib\/catalogue\.en\.json)$/;
      // oclif makes a command of every script under lib/sf: those of the
      // plugin, and nothing else.
      const commands = sfCommandFiles(toolNames()).map(
        (file) => `${SF_COMMANDS}/sandforge/${file}`,
      );
      const strange = files.filter((file) => !allowed.test(file) && !commands.includes(file));
      if (strange.length > 0) throw new Error(`npm would publish these too: ${strange.join(', ')}`);
      const expected = [
        'package.json',
        'README.md',
        'LICENSE',
        'THIRD-PARTY-NOTICES.md',
        'oclif.manifest.json',
        'lib/catalogue.en.json',
        'bin/sandforge.mjs',
        'lib/sandforge.mjs',
        'lib/sfPlugin.mjs',
        'lib/sfHelpHook.mjs',
        ...commands,
        ...toolNames().flatMap((tool) => [
          `bin/sandforge-${tool}.mjs`,
          `lib/sandforge-${tool}.mjs`,
        ]),
      ];
      const missing = expected.filter((file) => !files.includes(file));
      if (missing.length > 0) throw new Error(`npm would leave these out: ${missing.join(', ')}`);
    },
  },
  {
    name: 'the manifest of the sf plugin is what oclif makes of each command, at the version of the package',
    run: ({ out, node }) => {
      const written = readJson(join(out, SF_MANIFEST));
      const version = readJson(join(out, 'package.json')).version;
      if (written.version !== version) {
        // oclif says "Mismatched version" and imports every command instead.
        throw new Error(`${SF_MANIFEST} is at ${written.version}, the package at ${version}`);
      }
      const tools = toolNames();
      assertEqual(
        Object.keys(written.commands).sort(),
        [
          'sandforge',
          `sandforge:${HARDIS_COMMAND}`,
          ...tools.map((tool) => `sandforge:${tool}`),
        ].sort(),
        `${SF_MANIFEST} does not name the commands of the plugin`,
      );
      // oclif's help renders each text through ejs.
      if (JSON.stringify(written).includes('<%')) {
        throw new Error(`${SF_MANIFEST} holds "<%", which oclif's help would run as a template`);
      }
      const { classes, tools: summaries } = importedCommands(out, node);
      for (const [id, entry] of Object.entries(written.commands)) {
        const file = id === 'sandforge' ? 'index.mjs' : `${id.slice('sandforge:'.length)}.mjs`;
        const relativePath = [...SF_COMMANDS.split('/'), 'sandforge', file];
        if (
          entry.strict !== false ||
          entry.isESM !== true ||
          JSON.stringify(entry.flags) !== '{}' ||
          entry.pluginName !== 'sandforge' ||
          entry.hidden !== (id === `sandforge:${HARDIS_COMMAND}`)
        ) {
          throw new Error(`${id}: ${JSON.stringify(entry)}`);
        }
        assertEqual(entry.relativePath, relativePath, `${id}'s file`);
        if (!existsSync(join(out, ...relativePath))) throw new Error(`${id}: no ${file}`);
        const tool = id.slice('sandforge:'.length);
        if (id !== 'sandforge' && tool !== HARDIS_COMMAND && entry.summary !== summaries[tool]) {
          throw new Error(`${id} says "${entry.summary}", sandforge --help "${summaries[tool]}"`);
        }
        const imported = classes[file];
        if (imported === undefined) throw new Error(`${id}: ${file} was not imported`);
        assertEqual(
          entry,
          manifestEntry(id, imported.statics, relativePath),
          `${id}'s entry is not what oclif makes of its class`,
        );
      }
      const strays = Object.keys(classes).filter(
        (file) => !Object.values(written.commands).some((e) => e.relativePath.at(-1) === file),
      );
      if (strays.length > 0) throw new Error(`commands with no entry: ${strays.join(', ')}`);
    },
  },
  {
    name: 'each command of the sf plugin is a class with a static run, not strict, and nothing of the package loads @oclif',
    run: ({ out, node }) => {
      const loading = filesOf(join(out, 'lib')).filter((file) =>
        /@oclif\//.test(readFileSync(join(out, 'lib', file), 'utf8')),
      );
      if (loading.length > 0) throw new Error(`these name @oclif: ${loading.join(', ')}`);
      const { classes } = importedCommands(out, node);
      assertEqual(
        Object.keys(classes).sort(),
        sfCommandFiles(toolNames()).sort(),
        'the classes of lib/sf/sandforge',
      );
      for (const [file, imported] of Object.entries(classes)) {
        // oclif takes for a command what has a static run, and reads the line
        // as words of the command, not as an id, once it is not strict.
        if (imported.run !== 'function' || imported.statics?.strict !== false) {
          throw new Error(`${file}: run is a ${imported.run}, strict ${imported.statics?.strict}`);
        }
      }
    },
  },
  {
    name: 'a command of the sf plugin runs its script in the process, as sf runs it, with its exit codes',
    run: ({ out, node }) => {
      const home = scratchFolder();
      try {
        const env = sealedEnv(home);
        const rejected = runSfCommand(out, node, home, 'clone', ['--no-such-flag'], env);
        if (rejected.code !== 2) {
          throw new Error(
            `sandforge:clone --no-such-flag ended on ${rejected.code}: ${rejected.stderr}`,
          );
        }
        const listed = runSfCommand(out, node, home, 'seed', ['--list-templates'], env);
        if (listed.code !== 0 || !/ Minimal Demo$/m.test(listed.stdout)) {
          throw new Error(
            `sandforge:seed --list-templates ended on ${listed.code}: ${listed.stdout}${listed.stderr}`,
          );
        }
        const verb = runSfCommand(out, node, home, 'pipeline', ['plan', '--help'], env);
        if (
          verb.code !== 0 ||
          !verb.stdout.startsWith(HELP_HEAD('pipeline')) ||
          !verb.stdout.includes('plan      connect each org')
        ) {
          throw new Error(`sandforge:pipeline plan --help ended on ${verb.code}: ${verb.stderr}`);
        }
        const bare = runSfCommand(out, node, home, '', [], env);
        if (
          bare.code !== 2 ||
          !bare.stderr.startsWith('Name the command to run. Nothing was run.')
        ) {
          throw new Error(`sandforge alone ended on ${bare.code}: ${bare.stderr}${bare.stdout}`);
        }
        const alias = 'NO-SUCH-ALIAS';
        const unknown = runSfCommand(out, node, home, 'monitor', ['--org', alias], {
          ...env,
          PATH: `${unknownAliasSf(home, alias)}${delimiter}${env.PATH}`,
        });
        if (unknown.code !== 1 || !unknown.stderr.includes(`sf does not know ${alias}`)) {
          throw new Error(
            `sandforge:monitor --org ${alias} ended on ${unknown.code}: ${unknown.stderr}`,
          );
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'a command of the sf plugin refuses a Node older than the package before it loads anything of lib/',
    run: ({ out, node }) => {
      const home = scratchFolder();
      try {
        const older = join(home, 'older-node.mjs');
        writeFileSync(
          older,
          "Object.defineProperty(process, 'versions', { value: { ...process.versions, node: '20.18.3' } });\n",
        );
        // Every module the command's process resolves, written down by a
        // hook of Node's module loader.
        const log = join(home, 'loaded.txt');
        writeFileSync(log, '');
        writeFileSync(
          join(home, 'trace-hooks.mjs'),
          [
            "import { appendFileSync } from 'node:fs';",
            'let log;',
            'export function initialize(data) { log = data.log; }',
            'export async function resolve(specifier, context, next) {',
            '  const resolved = await next(specifier, context);',
            "  appendFileSync(log, resolved.url + '\\n');",
            '  return resolved;',
            '}',
            '',
          ].join('\n'),
        );
        const trace = join(home, 'trace.mjs');
        writeFileSync(
          trace,
          "import { register } from 'node:module';\n" +
            `register('./trace-hooks.mjs', import.meta.url, { data: { log: ${JSON.stringify(log)} } });\n`,
        );
        const result = runSfCommand(out, node, home, 'clone', ['--help'], sealedEnv(home), [
          '--import',
          pathToFileURL(trace).href,
          '--import',
          pathToFileURL(older).href,
        ]);
        if (
          result.code !== 1 ||
          !/^sandforge needs Node\.js 20\.19 or later, and this is 20\.18\.3\. Nothing was run\.$/m.test(
            result.stderr,
          ) ||
          result.stdout !== ''
        ) {
          throw new Error(
            `sandforge:clone under Node 20.18.3 ended on ${result.code}: ${result.stderr}${result.stdout}`,
          );
        }
        const lib = `${pathToFileURL(join(out, 'lib')).href}/`;
        const command = pathToFileURL(join(out, SF_COMMANDS, 'sandforge', 'clone.mjs')).href;
        const loaded = readFileSync(log, 'utf8').split('\n').filter(Boolean);
        // The trace saw the command itself, or it saw nothing at all.
        if (!loaded.includes(command))
          throw new Error(`the trace missed the command: ${loaded.join(', ')}`);
        const more = loaded.filter((url) => url.startsWith(lib) && url !== command);
        if (more.length > 0) throw new Error(`under Node 20.18.3 it loaded ${more.join(', ')}`);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  },
  {
    name: "sf sandforge … --help is the script's own help: the init hook runs bin/, and leaves any other line to sf",
    run: ({ out, node }) => {
      const home = scratchFolder();
      try {
        const written = readJson(join(out, SF_MANIFEST)).commands;
        const commands = {
          ...Object.fromEntries(
            Object.entries(written).map(([id, e]) => [
              id,
              { id: e.id, pluginName: e.pluginName, hidden: e.hidden },
            ]),
          ),
          'org:list': { id: 'org:list', pluginName: '@salesforce/plugin-org', hidden: false },
        };
        const hook = (id, argv) =>
          runModule(
            node,
            home,
            'hook.mjs',
            HOOK_DRIVER,
            sealedEnv(home),
            [],
            [join(out, SF_HELP_HOOK), JSON.stringify(commands), id, JSON.stringify(argv)],
          );
        for (const [id, argv, words] of [
          ['sandforge:clone', ['--help'], ['clone', '--help']],
          ['sandforge:clone', ['-h'], ['clone', '-h']],
          ['sandforge:pipeline', ['plan', '--help'], ['pipeline', 'plan', '--help']],
          ['sandforge', ['--help'], ['--help']],
        ]) {
          const said = hook(id, argv);
          const own = runBin(out, ['sandforge', ...words], {
            node,
            env: sealedEnv(home),
            cwd: home,
          });
          if (said.code !== 0 || said.stdout !== own.stdout || own.code !== 0) {
            throw new Error(
              `the hook for ${id} ${argv.join(' ')} ended on ${said.code}, and said ` +
                `${said.stdout === own.stdout ? 'the same' : 'something else'}: ${said.stderr}`,
            );
          }
        }
        for (const [id, argv] of [
          ['org:list', ['--help']],
          ['sandforge:clone', ['--', '--help']],
          [`sandforge:${HARDIS_COMMAND}`, ['--help']],
        ]) {
          const left = hook(id, argv);
          if (left.code !== 0 || left.stdout !== HOOK_LEFT) {
            throw new Error(`the hook took ${id} ${argv.join(' ')}: ${left.stdout}${left.stderr}`);
          }
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'sf sandforge:hardis-commands --json answers the menus of sfdx-hardis alone on stdout, each entry reaching no org',
    run: ({ out, node }) => {
      const home = scratchFolder();
      try {
        const env = sealedEnv(home);
        const answered = runSfCommand(out, node, home, HARDIS_COMMAND, ['--json'], env);
        let menus;
        try {
          menus = JSON.parse(answered.stdout);
        } catch {
          menus = undefined;
        }
        const entries = (menus?.result?.customCommands ?? []).flatMap(
          (menu) => menu.commands ?? [],
        );
        if (
          answered.code !== 0 ||
          menus?.status !== 0 ||
          answered.stderr !== '' ||
          entries.length === 0
        ) {
          throw new Error(
            `hardis-commands --json ended on ${answered.code}: ${answered.stdout}${answered.stderr}`,
          );
        }
        // An sf that notes it was run: no entry may start it.
        const trap = join(home, 'trap-bin');
        const ran = join(home, 'sf-ran.txt');
        mkdirSync(trap);
        writeFileSync(join(trap, 'sf'), `#!/bin/sh\necho "$@" >> '${ran}'\nexit 1\n`);
        chmodSync(join(trap, 'sf'), 0o755);
        writeFileSync(join(trap, 'sf.cmd'), `@echo %* >> "${ran}"\r\n@exit /b 1\r\n`);
        for (const { command } of entries) {
          const [sf, plugin, word, ...rest] = command.split(' ');
          if (sf !== 'sf' || plugin !== 'sandforge') throw new Error(`an entry runs ${command}`);
          const [tool, words] = word.startsWith('-') ? ['', [word, ...rest]] : [word, rest];
          const result = runSfCommand(out, node, home, tool, words, {
            ...env,
            PATH: `${trap}${delimiter}${env.PATH}`,
          });
          // 0, or a refusal before anything: env validate where no sandforge.yaml is.
          if (result.code !== 0 && result.code !== 2) {
            throw new Error(`${command} ended on ${result.code}: ${result.stderr}`);
          }
        }
        if (existsSync(ran)) throw new Error(`an entry ran sf ${readFileSync(ran, 'utf8')}`);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'nothing in it is a source map, a path of the machine that built it, or a checkout',
    run: ({ out }) => {
      const problems = scanText(out);
      if (problems.length > 0) throw new Error(problems.join('\n'));
    },
  },
  {
    name: 'it names no client and carries no real org identifier',
    run: ({ out, requireNames = true }) => {
      const { findings, namesChecked } = confidentialFindings(out);
      if (findings.length > 0) throw new Error(findings.join('\n'));
      // As scripts/pre-publish-check.sh: a CI checkout has no list of names,
      // a machine that publishes has to. The test suite, run in a worktree that
      // never holds the list, checks the identifiers and any names it has.
      if (requireNames && !namesChecked && process.env.CI !== 'true') {
        throw new Error('.confidential-names is absent from this checkout: client names unchecked');
      }
    },
  },
  {
    name: 'sandforge answers its help and its version, and refuses a word that is no command, on 2',
    run: ({ out, node }) => {
      const help = runBin(out, ['sandforge', '--help'], { node });
      if (help.code !== 0)
        throw new Error(`sandforge --help ended on ${help.code}: ${help.stderr}`);
      for (const tool of toolNames()) {
        if (!new RegExp(`^ {2}${tool} `, 'm').test(help.stdout)) {
          throw new Error(`sandforge --help does not list ${tool}`);
        }
      }
      const version = runBin(out, ['sandforge', '--version'], { node });
      const expected = readJson(join(out, 'package.json')).version;
      if (version.code !== 0 || version.stdout.trim() !== expected) {
        throw new Error(
          `sandforge --version said "${version.stdout.trim()}" (${version.code}), not ${expected}`,
        );
      }
      for (const line of [['sandforge'], ['sandforge', 'deploy'], ['sandforge', '--dry-run']]) {
        const refused = runBin(out, line, { node });
        if (refused.code !== 2 || !/Nothing was run/.test(refused.stderr)) {
          throw new Error(
            `${line.join(' ')} ended on ${refused.code}: ${refused.stderr}${refused.stdout}`,
          );
        }
      }
    },
  },
  {
    name: 'each command answers --help, as sandforge <command> and by its own name, installed by npm',
    run: ({ out, node }) => {
      const prefix = scratchFolder();
      try {
        // The links npm makes are what people run: under POSIX the script
        // sees the link's name, not its own file's.
        const links = installLocally(out, prefix);
        const viaLink = (command, args) => {
          const file = join(links, process.platform === 'win32' ? `${command}.mjs` : command);
          const result = spawnSync(node, [file, ...args], {
            encoding: 'utf8',
            cwd: prefix,
            timeout: 60_000,
          });
          return { code: result.status, stdout: result.stdout, stderr: result.stderr };
        };
        for (const tool of toolNames()) {
          const asked = viaLink('sandforge', [tool, '--help']);
          if (asked.code !== 0 || !asked.stdout.startsWith(HELP_HEAD(tool))) {
            throw new Error(
              `sandforge ${tool} --help ended on ${asked.code}: ${asked.stderr || asked.stdout.slice(0, 200)}`,
            );
          }
          for (const words of CHECKOUT_WORDS) {
            if (asked.stdout.includes(words))
              throw new Error(`sandforge ${tool} --help says "${words}"`);
          }
          const alias = viaLink(`sandforge-${tool}`, ['--help']);
          if (alias.code !== 0 || alias.stdout !== asked.stdout) {
            throw new Error(
              `sandforge-${tool} --help ended on ${alias.code} and said ` +
                `${alias.stdout === '' ? 'nothing' : 'something else'}: ${alias.stderr}`,
            );
          }
        }
      } finally {
        rmSync(prefix, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'a line that tells its reader what to run names npx sandforge, never a name npx would fetch',
    run: ({ out, node }) => {
      const home = scratchFolder();
      try {
        // DataOps refuses a line without its command, before any org, and
        // says the line to type: the one command that shows it unaided.
        const refused = runBin(out, ['sandforge', 'dataops', '--org', 'DEV'], {
          node,
          env: sealedEnv(home),
          cwd: home,
        });
        if (
          refused.code !== 2 ||
          !refused.stderr.includes('npx sandforge dataops anonymize --org')
        ) {
          throw new Error(
            `sandforge dataops --org DEV ended on ${refused.code}: ${refused.stderr}${refused.stdout}`,
          );
        }
        if (/sandforge-[a-z]+ (?:anonymize|--)/.test(refused.stderr)) {
          throw new Error(`sandforge dataops names a command npx would fetch: ${refused.stderr}`);
        }
        // A script's own name, from a message that names it, is answered with
        // the line that runs it here: "sandforge seed …" ran under no npx.
        const renamed = runBin(out, ['sandforge', 'sandforge-seed', '--target', 'DEV'], {
          node,
          env: sealedEnv(home),
          cwd: home,
        });
        if (renamed.code !== 2 || !renamed.stderr.includes(': npx sandforge seed …')) {
          throw new Error(
            `sandforge sandforge-seed --target DEV ended on ${renamed.code}: ` +
              `${renamed.stderr}${renamed.stdout}`,
          );
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'a command says how to install sf where there is none, and names an alias sf does not know',
    run: ({ out, node }) => {
      const home = scratchFolder();
      try {
        const env = sealedEnv(home);
        // The PATH holds the Node the command runs under, and no sf.
        const missing = runBin(out, ['sandforge', 'monitor', '--org', 'DEV'], {
          node,
          env,
          cwd: home,
        });
        if (
          missing.code !== 1 ||
          !missing.stderr.includes('Salesforce CLI (sf) not found on PATH.') ||
          !missing.stderr.includes('npm install -g @salesforce/cli') ||
          /ENOENT/.test(missing.stderr)
        ) {
          throw new Error(
            `with no sf, sandforge monitor ended on ${missing.code}: ${missing.stderr}`,
          );
        }
        const alias = 'NO-SUCH-ALIAS';
        const unknown = runBin(out, ['sandforge', 'monitor', '--org', alias], {
          node,
          env: { ...env, PATH: `${unknownAliasSf(home, alias)}${delimiter}${env.PATH}` },
          cwd: home,
        });
        if (
          unknown.code !== 1 ||
          !unknown.stderr.includes(
            `sf does not know ${alias}: "sf org list" names the orgs it knows`,
          ) ||
          /Command failed/.test(unknown.stderr)
        ) {
          throw new Error(
            `for an unknown alias, sandforge monitor ended on ${unknown.code}: ${unknown.stderr}`,
          );
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Seed names its templates as the Seed page does',
    run: ({ out, node }) => {
      const home = scratchFolder();
      try {
        const listed = runBin(out, ['sandforge', 'seed', '--list-templates'], {
          node,
          env: sealedEnv(home),
          cwd: home,
        });
        if (
          listed.code !== 0 ||
          !/^prebuilt-minimal-demo +\d+ object\(s\) +Minimal Demo$/m.test(listed.stdout)
        ) {
          throw new Error(
            `sandforge seed --list-templates ended on ${listed.code}:\n${listed.stdout}${listed.stderr}`,
          );
        }
        if (listed.stdout.includes('seed.templates.')) {
          throw new Error('a template is named by its catalogue key: the catalogue was not found');
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'each command ends on 2, having reached nothing, on a flag it does not read',
    run: ({ out, node }) => {
      const home = scratchFolder();
      try {
        const env = sealedEnv(home);
        for (const tool of toolNames()) {
          const refused = runBin(out, ['sandforge', tool, '--no-such-flag'], {
            node,
            env,
            cwd: home,
          });
          if (refused.code !== 2) {
            throw new Error(
              `sandforge ${tool} --no-such-flag ended on ${refused.code}: ${refused.stderr}`,
            );
          }
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'the MCP server answers initialize, lists its tools, and runs a packaged script for a call',
    run: async ({ out, node }) => {
      const home = scratchFolder();
      try {
        const version = readJson(join(out, 'package.json')).version;
        const { answers, code, stderr } = await talkToMcp(
          out,
          [
            {
              jsonrpc: '2.0',
              id: 1,
              method: 'initialize',
              params: {
                protocolVersion: '2025-06-18',
                capabilities: {},
                clientInfo: { name: 'sandforge-npm-check', version },
              },
            },
            { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
            {
              jsonrpc: '2.0',
              id: 3,
              method: 'tools/call',
              params: { name: 'checkpoint_list', arguments: { org: 'NO-SUCH-ORG' } },
            },
          ],
          { node, env: sealedEnv(home), cwd: home },
        );
        const [initialized, listed, called] = answers;
        if (
          initialized?.result?.serverInfo?.name !== 'sandforge' ||
          initialized.result.serverInfo.version !== version
        ) {
          throw new Error(`initialize answered ${JSON.stringify(initialized)}\n${stderr}`);
        }
        if (initialized.result.protocolVersion !== '2025-06-18') {
          throw new Error(`initialize agreed on ${initialized.result.protocolVersion}`);
        }
        const names = (listed?.result?.tools ?? []).map((tool) => tool.name);
        if (!names.includes('checkpoint_list') || !names.includes('seed_run')) {
          throw new Error(`tools/list answered ${names.join(', ') || JSON.stringify(listed)}`);
        }
        // checkpoint_list runs `sandforge-checkpoint list` in a process of its
        // own, from the file the runner names: the packaged one, or no list.
        const structured = called?.result?.structuredContent;
        if (
          called?.result?.isError ||
          structured?.exitCode !== 0 ||
          !Array.isArray(structured?.answer)
        ) {
          throw new Error(`checkpoint_list answered ${JSON.stringify(called)}\n${stderr}`);
        }
        if (code !== 0)
          throw new Error(`the MCP server ended on ${code} once its input closed\n${stderr}`);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'the MCP server lists the clone of the whole org, and refuses a plan it does not hold before any org is read',
    run: async ({ out, node }) => {
      const home = scratchFolder();
      try {
        const version = readJson(join(out, 'package.json')).version;
        // The plan's receipt is read from the journal folder, through the
        // modules of the plans and of the runs: loaded under this Node, or
        // the call fails before its refusal.
        const unknown = 'co-20260101-000000-zzzz';
        const { answers, code, stderr } = await talkToMcp(
          out,
          [
            {
              jsonrpc: '2.0',
              id: 1,
              method: 'initialize',
              params: {
                protocolVersion: '2025-11-25',
                capabilities: {},
                clientInfo: { name: 'sandforge-npm-check', version },
              },
            },
            { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
            {
              jsonrpc: '2.0',
              id: 3,
              method: 'tools/call',
              params: { name: 'clone_org', arguments: { plan: unknown, confirm: 'NO-SUCH-ORG' } },
            },
          ],
          { node, env: sealedEnv(home), cwd: home },
        );
        const [, listed, called] = answers;
        const names = (listed?.result?.tools ?? []).map((tool) => tool.name);
        for (const name of ['clone_org_plan', 'clone_org', 'run_status', 'run_stop']) {
          if (!names.includes(name)) {
            throw new Error(`tools/list does not list ${name}: ${names.join(', ')}`);
          }
        }
        const refusal = called?.result?.structuredContent?.refusal;
        if (
          called?.result?.isError !== true ||
          refusal?.code !== 'PLAN_GONE' ||
          !refusal.message.includes(`plan "${unknown}" is not on this machine`)
        ) {
          throw new Error(
            `clone_org of an unknown plan answered ${JSON.stringify(called)}\n${stderr}`,
          );
        }
        if (code !== 0)
          throw new Error(`the MCP server ended on ${code} once its input closed\n${stderr}`);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'pipeline plan stands up its host and refuses, exit 2, a file whose org it cannot reach',
    run: ({ out, node }) => {
      const home = scratchFolder();
      try {
        // A pipeline file as the Automation page exports one, whose org no
        // sf of this sealed home reaches: the plan builds the host the run
        // goes through — under this Node, every module of the editor's
        // handlers loaded — then says the org was not reached, and runs
        // nothing.
        const file = pipelineFixture(home);
        const planned = runBin(out, ['sandforge', 'pipeline', 'plan', '--file', file, '--json'], {
          node,
          env: sealedEnv(home),
          cwd: home,
        });
        let answer;
        try {
          answer = JSON.parse(planned.stdout);
        } catch {
          answer = undefined;
        }
        const refusal = answer?.refusals?.[0];
        if (
          planned.code !== 2 ||
          refusal?.code !== 'ORG_NOT_CONNECTED' ||
          !String(refusal.message).includes('Salesforce CLI (sf) not found on PATH.') ||
          !planned.stderr.includes('Pipeline "Nightly" (2 steps), exported from SandForge 1.81.0')
        ) {
          throw new Error(
            `sandforge pipeline plan ended on ${planned.code}: ${planned.stderr}${planned.stdout}`,
          );
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'pipeline plan and checkpoint replay answer --help, each its command’s own lines',
    run: ({ out, node }) => {
      // The help asked after a verb: the line is read as far as the verb,
      // then the help said, under this Node, before anything is reached.
      for (const [tool, verb, words] of [
        ['pipeline', 'plan', ['plan      connect each org', '--approve <step>']],
        ['checkpoint', 'replay', ['replay    set a checkpoint', '--key-env <VAR>']],
      ]) {
        const asked = runBin(out, ['sandforge', tool, verb, '--help'], { node });
        if (asked.code !== 0 || !asked.stdout.startsWith(HELP_HEAD(tool))) {
          throw new Error(
            `sandforge ${tool} ${verb} --help ended on ${asked.code}: ${asked.stderr || asked.stdout.slice(0, 200)}`,
          );
        }
        for (const said of words) {
          if (!asked.stdout.includes(said)) {
            throw new Error(`sandforge ${tool} ${verb} --help does not say "${said}"`);
          }
        }
      }
    },
  },
  {
    name: 'the MCP server lists the tools of a clone from a query, a replay and a pipeline, and plans a pipeline through the packaged script',
    run: async ({ out, node }) => {
      const home = scratchFolder();
      try {
        const version = readJson(join(out, 'package.json')).version;
        const file = pipelineFixture(home);
        const { answers, code, stderr } = await talkToMcp(
          out,
          [
            {
              jsonrpc: '2.0',
              id: 1,
              method: 'initialize',
              params: {
                protocolVersion: '2025-11-25',
                capabilities: {},
                clientInfo: { name: 'sandforge-npm-check', version },
              },
            },
            { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
            {
              jsonrpc: '2.0',
              id: 3,
              method: 'tools/call',
              params: { name: 'pipeline_plan', arguments: { file } },
            },
          ],
          { node, env: sealedEnv(home), cwd: home },
        );
        const [, listed, called] = answers;
        const names = (listed?.result?.tools ?? []).map((tool) => tool.name);
        for (const name of [
          'clone_records',
          'checkpoint_replay',
          'checkpoint_replay_remove',
          'pipeline_plan',
        ]) {
          if (!names.includes(name)) {
            throw new Error(`tools/list does not list ${name}: ${names.join(', ')}`);
          }
        }
        if (names.includes('pipeline_run')) throw new Error('tools/list lists pipeline_run');
        // pipeline_plan runs the packaged pipeline script in a process of its
        // own: the plan it answers is that script's, its org refused unreached.
        const structured = called?.result?.structuredContent;
        if (
          called?.result?.isError !== true ||
          structured?.exitCode !== 2 ||
          structured?.answer?.refusals?.[0]?.code !== 'ORG_NOT_CONNECTED' ||
          !called.result.content?.[0]?.text?.includes('No tool runs a pipeline')
        ) {
          throw new Error(`pipeline_plan answered ${JSON.stringify(called)}\n${stderr}`);
        }
        if (code !== 0)
          throw new Error(`the MCP server ended on ${code} once its input closed\n${stderr}`);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'each command refuses a Node older than the package, before anything is loaded',
    run: ({ out, node }) => {
      const home = scratchFolder();
      try {
        const older = join(home, 'older-node.mjs');
        writeFileSync(
          older,
          "Object.defineProperty(process, 'versions', { value: { ...process.versions, node: '20.18.3' } });\n",
        );
        for (const command of ['sandforge', 'sandforge-mcp']) {
          const result = spawnSync(
            node,
            ['--import', pathToFileURL(older).href, join(out, 'bin', `${command}.mjs`), '--help'],
            {
              encoding: 'utf8',
              cwd: home,
            },
          );
          if (
            result.status !== 1 ||
            !/needs Node\.js 20\.19 or later/.test(result.stderr) ||
            result.stdout !== ''
          ) {
            throw new Error(
              `${command} under Node 20.18.3 ended on ${result.status}: ${result.stderr}${result.stdout}`,
            );
          }
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  },
];

/**
 * The checks the redirects pass before they are published, each one a
 * function of the folder they were built in that throws what it found.
 */
export const REDIRECT_CHECKS = [
  {
    name: 'one redirect per command, each at the version of the package and of its name, with no dependency',
    run: ({ out }) => {
      const version = packageVersion();
      const built = readdirSync(out).sort();
      const expected = toolNames().map((tool) => `sandforge-${tool}`);
      assertEqual(built, expected, 'the redirects are not one per command');
      for (const tool of toolNames()) {
        const published = readJson(join(out, `sandforge-${tool}`, 'package.json'));
        assertEqual(published, redirectManifest(tool, version), `sandforge-${tool}'s manifest`);
        if (published.version !== readJson(join(EXTENSION, 'package.json')).version) {
          throw new Error(
            `sandforge-${tool} is at ${published.version}, not the extension's version`,
          );
        }
        for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies', 'scripts']) {
          if (key in published) throw new Error(`sandforge-${tool} has ${key}`);
        }
      }
    },
  },
  {
    name: 'npm packs its command, its README, its license and its manifest, and nothing else',
    run: ({ out }) => {
      for (const tool of toolNames()) {
        const files = packedFiles(join(out, `sandforge-${tool}`));
        assertEqual(
          files,
          ['LICENSE', 'README.md', 'bin.mjs', 'package.json'],
          `npm would publish sandforge-${tool} with`,
        );
      }
    },
  },
  {
    name: 'nothing in them is a source map, a path of the machine that built them, a client or an org',
    run: ({ out, requireNames = true }) => {
      const problems = scanText(out);
      if (problems.length > 0) throw new Error(problems.join('\n'));
      const { findings, namesChecked } = confidentialFindings(out);
      if (findings.length > 0) throw new Error(findings.join('\n'));
      if (requireNames && !namesChecked && process.env.CI !== 'true') {
        throw new Error('.confidential-names is absent from this checkout: client names unchecked');
      }
    },
  },
  {
    name: 'each says what runs now on stderr, prints nothing on stdout, and ends on 2, whatever its line',
    run: ({ out, node }) => {
      const home = scratchFolder();
      try {
        for (const tool of toolNames()) {
          for (const args of [[], ['--help'], ['--org', 'DEV', '--yes']]) {
            const result = spawnSync(node, [join(out, `sandforge-${tool}`, 'bin.mjs'), ...args], {
              encoding: 'utf8',
              env: sealedEnv(home),
              cwd: home,
              timeout: 60_000,
            });
            if (
              result.status !== REDIRECT_EXIT ||
              result.stdout !== '' ||
              result.stderr !== redirectMessage(tool)
            ) {
              throw new Error(
                `sandforge-${tool} ${args.join(' ')} ended on ${result.status}: ${result.stderr}${result.stdout}`,
              );
            }
          }
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  },
];

/**
 * The checks of the package as a plugin of a real Salesforce CLI, run by
 * `check-sf` in a world of its own (`sfWorld`): installed from its tarball
 * as `sf plugins install` installs it, then run through sf. The publish
 * workflow runs them on each Node with a pinned sf, the oldest one on the
 * Node floor; the test suite where an sf is found.
 */
export const SF_CHECKS = [
  {
    name: 'sf installs the package from its tarball, allow-listed, without a question, and lists it at its version',
    run: ({ out, world }) => {
      // A plugin installed from an archive is allow-listed by its exact URL.
      const url = `file:${world.tarball}`;
      const allowed = world.sf(['plugins', 'trust', 'allowlist', 'add', '--name', url]);
      if (allowed.code !== 0) {
        throw new Error(
          `sf plugins trust allowlist add ended on ${allowed.code}: ${allowed.stderr}`,
        );
      }
      const installed = world.sf(['plugins', 'install', url]);
      const said = `${installed.stdout}${installed.stderr}`;
      if (installed.code !== 0 || /isn't signed by Salesforce/.test(said)) {
        throw new Error(`sf plugins install ended on ${installed.code}: ${said}`);
      }
      // `--json` would list each plugin whole, every manifest within: the
      // lines a reader sees name each plugin by its name and version.
      const listed = world.sf(['plugins']);
      const version = readJson(join(out, 'package.json')).version;
      if (
        listed.code !== 0 ||
        !new RegExp(`^sandforge ${version.replaceAll('.', '\\.')}\\b`, 'm').test(listed.stdout)
      ) {
        throw new Error(
          `sf plugins does not list sandforge ${version}: ${listed.stdout}${listed.stderr}`,
        );
      }
    },
  },
  {
    name: "sf sandforge … --help is the help of bin/sandforge.mjs, byte for byte, a verb's and -h's included",
    run: ({ out, node, world }) => {
      for (const words of [
        ['--help'],
        ['clone', '--help'],
        ['clone', '-h'],
        ['pipeline', 'plan', '--help'],
        ['checkpoint', 'replay', '--help'],
      ]) {
        const viaSf = world.sf(['sandforge', ...words]);
        const own = runBin(out, ['sandforge', ...words], { node, env: world.env, cwd: world.home });
        if (viaSf.code !== 0 || own.code !== 0 || viaSf.stdout !== own.stdout) {
          throw new Error(
            `sf sandforge ${words.join(' ')} ended on ${viaSf.code} and said ` +
              `${viaSf.stdout === own.stdout ? 'the same' : 'something else'}: ${viaSf.stderr}${viaSf.stdout.slice(0, 300)}`,
          );
        }
      }
    },
  },
  {
    name: 'sf sandforge ends on the codes of the scripts: 2 for a line refused, 1 for an alias sf does not know, 0 otherwise',
    run: ({ out, world }) => {
      const version = readJson(join(out, 'package.json')).version;
      const expect = (words, code, test, what) => {
        const result = world.sf(['sandforge', ...words]);
        if (result.code !== code || !test(result)) {
          throw new Error(
            `sf sandforge ${words.join(' ')} ended on ${result.code}, not ${code} ${what}: ${result.stderr}${result.stdout}`,
          );
        }
      };
      const parses = (text) => {
        try {
          JSON.parse(text);
          return true;
        } catch {
          return false;
        }
      };
      expect(['clone', '--no-such-flag'], 2, () => true, 'on a flag clone does not read');
      // sf's own flags are words of the script, which reads none of them.
      expect(
        ['monitor', '--target-org', 'NO-SUCH-ALIAS'],
        2,
        (r) => r.stderr.includes('--target-org'),
        "on sf's --target-org",
      );
      expect([], 2, (r) => r.stderr.includes('Name the command to run'), 'naming no command');
      expect(
        ['deploy'],
        2,
        (r) => r.stderr.includes('"deploy" is not a command of sandforge'),
        'on a word that is no command',
      );
      expect(['--version'], 0, (r) => r.stdout.trim() === version, `saying ${version}`);
      expect(
        ['seed', '--list-templates'],
        0,
        (r) => / Minimal Demo$/m.test(r.stdout),
        'naming the templates',
      );
      // The sf of this world knows no org.
      expect(
        ['monitor', '--org', 'NO-SUCH-ALIAS'],
        1,
        (r) => r.stderr.includes('sf does not know NO-SUCH-ALIAS'),
        'for an alias sf does not know',
      );
      expect(
        ['checkpoint', 'list', '--org', 'NO-SUCH', '--json'],
        0,
        (r) => parses(r.stdout),
        'with its answer alone on stdout',
      );
    },
  },
  {
    name: 'sf sandforge:hardis-commands --json answers the menus of sfdx-hardis alone on stdout',
    run: ({ world }) => {
      const answered = world.sf([`sandforge:${HARDIS_COMMAND}`, '--json']);
      let menus;
      try {
        menus = JSON.parse(answered.stdout);
      } catch {
        menus = undefined;
      }
      const entries = (menus?.result?.customCommands ?? []).flatMap((menu) => menu.commands ?? []);
      if (answered.code !== 0 || menus?.status !== 0 || entries.length === 0) {
        throw new Error(
          `sf sandforge:${HARDIS_COMMAND} --json ended on ${answered.code}: ${answered.stdout}${answered.stderr}`,
        );
      }
    },
  },
  {
    name: 'sf sandforge mcp answers initialize at the version of the package, and ends on 0 once its input closes',
    run: async ({ out, world }) => {
      const version = readJson(join(out, 'package.json')).version;
      const { answers, code, stderr } = await talkToMcp(
        out,
        [
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              clientInfo: { name: 'sandforge-sf-check', version },
            },
          },
        ],
        { line: [world.sfFile, 'sandforge', 'mcp'], env: world.env, cwd: world.home },
      );
      const [initialized] = answers;
      if (initialized?.result?.serverInfo?.version !== version || code !== 0) {
        throw new Error(
          `sf sandforge mcp ended on ${code}, answering ${JSON.stringify(initialized)}\n${stderr}`,
        );
      }
    },
  },
  {
    name: "sf help sandforge clone says what clone does, from the plugin's manifest",
    run: ({ out, world }) => {
      const summary = readJson(join(out, SF_MANIFEST)).commands['sandforge:clone'].summary;
      const helped = world.sf(['help', 'sandforge', 'clone']);
      if (helped.code !== 0 || !helped.stdout.replace(/\s+/g, ' ').includes(summary)) {
        throw new Error(
          `sf help sandforge clone ended on ${helped.code}: ${helped.stdout}${helped.stderr}`,
        );
      }
    },
  },
  {
    name: "the machine's own sf is as it was: no plugin installed in its folders, nothing allowed",
    // A CI runner has no sf of its own to keep.
    localOnly: true,
    run: ({ world }) => {
      if (userSfFingerprint() !== world.user) {
        throw new Error(
          `the folders of this machine's sf changed while the plugin was checked: ${userSfFingerprint()}`,
        );
      }
    },
  },
];

/** `assert.deepStrictEqual`, with the two values in the message. */
function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}:\n  is     ${JSON.stringify(actual)}\n  wanted ${JSON.stringify(expected)}`,
    );
  }
}

/** Run every check on a built package, saying each one; the number that failed. */
async function checkCommand(out, node, checks = CHECKS, context = {}) {
  let failed = 0;
  for (const check of checks) {
    try {
      await check.run({ out, node, ...context });
      console.log(`  ✓ ${check.name}`);
    } catch (error) {
      failed += 1;
      console.log(`  ✗ ${check.name}\n      ${String(error.message).split('\n').join('\n      ')}`);
    }
  }
  return failed;
}

/** Run the checks of the package as an sf plugin with the sf named, or the PATH's. */
async function checkSfCommand(out, node, sfNamed) {
  const sf = sfNamed ?? sfOnPath();
  if (sf === null) {
    console.error('No sf on the PATH: install @salesforce/cli, or name one with --sf <sf>.');
    return 1;
  }
  const world = sfWorld(out, node, sf);
  try {
    const version = world.sf(['--version']);
    console.log(
      `Checking ${relative(process.cwd(), out) || '.'} as a plugin of ${version.stdout.trim() || sf} ` +
        `under Node ${nodeVersionOf(node)}, in ${world.at}:`,
    );
    const checks = SF_CHECKS.filter((check) => !check.localOnly || process.env.CI !== 'true');
    const failed = await checkCommand(out, node, checks, { world });
    console.log(failed === 0 ? 'Every check passed.' : `${failed} check(s) failed.`);
    return failed === 0 ? 0 : 1;
  } finally {
    world.dispose();
  }
}

/** The value of `--<name> <value>` on a line, and the line without it. */
function optionOf(words, name) {
  const at = words.indexOf(`--${name}`);
  if (at === -1) return { value: undefined, rest: words };
  return {
    value: words[at + 1],
    rest: words.filter((_, index) => index !== at && index !== at + 1),
  };
}

async function cli(argv) {
  const [command, ...words] = argv;
  const { value: node, rest } = optionOf(words, 'node');
  const { value: sf, rest: positional } = optionOf(rest, 'sf');
  const out = positional[0] ? resolve(positional[0]) : DEFAULT_OUT;
  if (command === 'check-sf') {
    return checkSfCommand(out, node ?? process.execPath, sf);
  }
  if (command === 'build') {
    const built = await build(out);
    console.log(
      `Built the sandforge package ${packageVersion()} in ${relative(process.cwd(), built.out) || '.'}: ` +
        `${built.bundled.length} npm packages bundled.`,
    );
    return 0;
  }
  if (command === 'redirects') {
    const built = buildRedirects(positional[0] ? resolve(positional[0]) : REDIRECTS_OUT);
    console.log(
      `Built ${built.packages.length} redirects at ${packageVersion()} in ` +
        `${relative(process.cwd(), built.out) || '.'}: ${built.packages.map((p) => basename(p.folder)).join(', ')}.`,
    );
    return 0;
  }
  if (command === 'check-redirects') {
    const runtime = node ?? process.execPath;
    const folder = positional[0] ? resolve(positional[0]) : REDIRECTS_OUT;
    console.log(
      `Checking the redirects in ${relative(process.cwd(), folder) || '.'} under Node ${nodeVersionOf(runtime)}:`,
    );
    const failed = await checkCommand(folder, runtime, REDIRECT_CHECKS);
    console.log(failed === 0 ? 'Every check passed.' : `${failed} check(s) failed.`);
    return failed === 0 ? 0 : 1;
  }
  if (command === 'check') {
    const runtime = node ?? process.execPath;
    console.log(
      `Checking ${relative(process.cwd(), out) || '.'} under Node ${nodeVersionOf(runtime)}:`,
    );
    const failed = await checkCommand(out, runtime);
    console.log(failed === 0 ? 'Every check passed.' : `${failed} check(s) failed.`);
    return failed === 0 ? 0 : 1;
  }
  console.error(
    'usage: node scripts/npm-package.mjs build|check|redirects|check-redirects|check-sf [<folder>] [--node <node>] [--sf <sf>]',
  );
  return 2;
}

/** A folder of its own for a build that is thrown away. */
export function scratchFolder() {
  return mkdtempSync(join(tmpdir(), 'sandforge-npm-'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
