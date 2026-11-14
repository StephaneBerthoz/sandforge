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
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
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
    files: ['bin/', 'lib/', 'THIRD-PARTY-NOTICES.md'],
    engines: { node: `>=${NODE_FLOOR}` },
  };
}

/**
 * A command of the package: refuses a Node older than the package's floor
 * (npm only warns on `engines`), then starts its file in `lib/` as if that
 * file had been run itself. Under POSIX npm links `.bin/sandforge-clone` to
 * this file, and `process.argv[1]` is that link, with no extension: the
 * script's own start, which reads its file name there, would not see itself
 * and the command would end on 0 having done nothing.
 */
export function binStub(target) {
  const [major, minor] = NODE_FLOOR.split('.').map(Number);
  return `#!/usr/bin/env node
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < ${major} || (major === ${major} && minor < ${minor})) {
  process.stderr.write(
    'sandforge needs Node.js ${major}.${minor} or later, and this is ' + process.versions.node + '. Nothing was run.\\n',
  );
  process.exit(1);
}
const { fileURLToPath } = await import('node:url');
const entry = new URL('../lib/${target}', import.meta.url);
process.argv[1] = fileURLToPath(entry);
await import(entry.href);
`;
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
  return new Promise((resolvePromise, reject) => {
    const child = spawn(node, [join(out, 'bin', 'sandforge.mjs'), 'mcp'], {
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
  const pack = spawnSync(
    npm,
    ['pack', '--json', '--ignore-scripts', '--pack-destination', prefix],
    {
      ...options,
      cwd: out,
    },
  );
  if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr}`);
  const answer = JSON.parse(pack.stdout);
  const [packed] = Array.isArray(answer) ? answer : Object.values(answer);
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
      join(prefix, packed.filename),
    ],
    { ...options, cwd: target },
  );
  if (install.status !== 0)
    throw new Error(`npm install of the packed package failed: ${install.stderr}`);
  return windows
    ? join(target, 'node_modules', 'sandforge', 'bin')
    : join(target, 'node_modules', '.bin');
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
    },
  },
  {
    name: 'npm packs these files and no other',
    run: ({ out }) => {
      const files = packedFiles(out);
      const allowed =
        /^(package\.json|README\.md|LICENSE|THIRD-PARTY-NOTICES\.md|bin\/sandforge(-[a-z]+)?\.mjs|lib\/(sandforge(-[a-z]+)?|chunk-[A-Z0-9]+)\.mjs|lib\/catalogue\.en\.json)$/;
      const strange = files.filter((file) => !allowed.test(file));
      if (strange.length > 0) throw new Error(`npm would publish these too: ${strange.join(', ')}`);
      const expected = [
        'package.json',
        'README.md',
        'LICENSE',
        'THIRD-PARTY-NOTICES.md',
        'lib/catalogue.en.json',
        'bin/sandforge.mjs',
        'lib/sandforge.mjs',
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

/** `assert.deepStrictEqual`, with the two values in the message. */
function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}:\n  is     ${JSON.stringify(actual)}\n  wanted ${JSON.stringify(expected)}`,
    );
  }
}

/** Run every check on a built package, saying each one; the number that failed. */
async function checkCommand(out, node, checks = CHECKS) {
  let failed = 0;
  for (const check of checks) {
    try {
      await check.run({ out, node });
      console.log(`  ✓ ${check.name}`);
    } catch (error) {
      failed += 1;
      console.log(`  ✗ ${check.name}\n      ${String(error.message).split('\n').join('\n      ')}`);
    }
  }
  return failed;
}

async function cli(argv) {
  const [command, ...rest] = argv;
  const nodeAt = rest.indexOf('--node');
  const node = nodeAt === -1 ? undefined : rest[nodeAt + 1];
  const positional =
    nodeAt === -1 ? rest : rest.filter((_, index) => index !== nodeAt && index !== nodeAt + 1);
  const out = positional[0] ? resolve(positional[0]) : DEFAULT_OUT;
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
    'usage: node scripts/npm-package.mjs build|check|redirects|check-redirects [<folder>] [--node <node>]',
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
