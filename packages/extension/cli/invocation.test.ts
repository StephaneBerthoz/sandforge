import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { commandOf, nameOf, typedWord } from './invocation.js';
import { TOOLS, type Tool } from './sandforge.js';

const here = __dirname;

/** A script's hyphenated name, `sandforge-checkpoint`, wherever a string holds it. */
const HYPHENATED = new RegExp(`sandforge-(?:${Object.keys(TOOLS).join('|')})(?![a-z])`, 'g');

/**
 * The folders of `cli/` whose strings no reader is shown: the worlds the tests
 * run the scripts in, which the package never bundles.
 */
const UNREAD_FOLDERS = ['testing'];

/** Every source of `cli/` a script runs, tests and their worlds left out. */
function sources(dir: string = here): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return UNREAD_FOLDERS.includes(relative(here, path)) ? [] : sources(path);
    }
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [path] : [];
  });
}

/** A string, or a piece of a template, of the source, and the node it sits in. */
interface Piece {
  text: string;
  node: ts.Node;
}

function piecesOf(file: ts.SourceFile): Piece[] {
  const found: Piece[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      found.push({ text: node.text, node });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Whether a string is the name of a module an import loads. */
function isModuleName(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
      parent.moduleSpecifier === node) ||
    (ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword)
  );
}

/**
 * Why the hyphenated name may stand where it does, or nothing when a reader
 * would read it as a command to type: a module or a file is named by its
 * file, and an identifier — a summary's `tool`, the script a runner starts,
 * the start of a run's id or of a scratch folder's name — is the name alone,
 * or the name and the dash the rest of the id follows.
 */
function allowedBecause(piece: Piece, at: number, name: string): string | undefined {
  if (isModuleName(piece.node)) return 'a module an import loads';
  const after = piece.text.slice(at + name.length);
  if (/^\.(?:ts|js|mjs)\b/.test(after)) return 'a file';
  // `nightly.sandforge-pipeline.json`: the name of a pipeline file, the
  // Automation page's export, which `sandforge pipeline` reads.
  if (piece.text.charAt(at - 1) === '.' && /^\.json\b/.test(after)) return 'a pipeline file';
  if (piece.text === name) return 'an identifier';
  if (at === 0 && /^-(?:[a-z]+-)*$/.test(after)) return "the start of an id or a folder's name";
  return undefined;
}

/** Each place a string of `cli/` holds a script's hyphenated name inside a text. */
function bareNames(files: readonly string[]): string[] {
  const found: string[] = [];
  for (const path of files) {
    const file = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const piece of piecesOf(file)) {
      for (const match of piece.text.matchAll(HYPHENATED)) {
        if (allowedBecause(piece, match.index, match[0]) !== undefined) continue;
        const { line } = file.getLineAndCharacterOfPosition(piece.node.getStart());
        const around = piece.text.slice(Math.max(0, match.index - 20), match.index + 40);
        found.push(`${relative(here, path)}:${line + 1}: …${around.replace(/\n/g, ' ')}…`);
      }
    }
  }
  return found;
}

describe('the command a line tells its reader to run', () => {
  it('is the script run under tsx from a checkout, which the package rewrites to npx sandforge', () => {
    for (const tool of Object.keys(TOOLS) as Tool[]) {
      expect(commandOf(tool)).toBe(`pnpm exec tsx packages/extension/cli/sandforge-${tool}.ts`);
    }
  });

  it('names a script an identifier holds as the package names its command, and nothing else', () => {
    expect(nameOf('sandforge-seed')).toBe('sandforge seed');
    expect(nameOf('sandforge-env')).toBe('sandforge env');
    expect(nameOf('sandforge-env-plan-')).toBe('sandforge-env-plan-');
    expect(nameOf('pnpm')).toBe('pnpm');
  });

  it('never names a script by the name only a global install puts on the PATH', () => {
    // Under npx the hyphenated names do not exist once the command ends, and
    // `npx sandforge-checkpoint …` would fetch whatever package holds the name.
    expect(bareNames(sources())).toEqual([]);
  });

  it('finds the name in a sentence, a line to run and a label, and lets an identifier be', () => {
    const folder = join(here, 'testing');
    const probe = ts.createSourceFile(
      join(folder, 'probe.ts'),
      [
        "import { main } from './sandforge-clone.js';",
        "const said = 'rewind with sandforge-checkpoint rewind --org DEV';",
        'const told = `run sandforge-env state recover --org ${alias}`;',
        "removalOrg(conn, 'sandforge-seed --remove');",
        "const answer = { tool: 'sandforge-sync' };",
        'const runId = `sandforge-clone-${uuid}`;',
        "if (process.argv[1]?.includes('sandforge-backup')) main();",
        "const file = 'sandforge-dataops.ts';",
      ].join('\n'),
      ts.ScriptTarget.Latest,
      true,
    );
    const flagged = piecesOf(probe).flatMap((piece) =>
      [...piece.text.matchAll(HYPHENATED)]
        .filter((match) => allowedBecause(piece, match.index, match[0]) === undefined)
        .map((match) => match[0]),
    );
    expect(flagged).toEqual(['sandforge-checkpoint', 'sandforge-env', 'sandforge-seed']);
  });
});

/**
 * The words of a Windows command line as the C runtime splits it, which
 * node.exe reads its arguments by once cmd.exe or PowerShell hands it the
 * line: spaces outside double quotes end a word, a quote opens or closes,
 * two inside are one, and backslashes count only before a quote — 2n of them
 * are n and the quote acts, 2n + 1 are n and a quote kept.
 */
function windowsWordsOf(line: string): string[] {
  const words: string[] = [];
  let word: string | undefined;
  let quoted = false;
  for (let at = 0; at < line.length; at++) {
    const char = line[at];
    if (char === '\\') {
      let slashes = 0;
      while (line[at] === '\\') {
        slashes++;
        at++;
      }
      if (line[at] === '"') {
        word = (word ?? '') + '\\'.repeat(slashes >> 1);
        if (slashes % 2 === 1) word += '"';
        else at--;
      } else {
        word = (word ?? '') + '\\'.repeat(slashes);
        at--;
      }
    } else if (char === '"') {
      if (quoted && line[at + 1] === '"') {
        word = (word ?? '') + '"';
        at++;
      } else {
        quoted = !quoted;
        word ??= '';
      }
    } else if (!quoted && (char === ' ' || char === '\t')) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else {
      word = (word ?? '') + char;
    }
  }
  if (word !== undefined) words.push(word);
  return words;
}

/** The words of a line as a POSIX shell splits it: single quotes, and a backslash outside them. */
function posixWordsOf(line: string): string[] {
  const words: string[] = [];
  let word: string | undefined;
  for (let at = 0; at < line.length; at++) {
    const char = line[at];
    if (char === "'") {
      const end = line.indexOf("'", at + 1);
      word = (word ?? '') + line.slice(at + 1, end);
      at = end;
    } else if (char === '\\') {
      at++;
      word = (word ?? '') + line[at];
    } else if (char === ' ') {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else {
      word = (word ?? '') + char;
    }
  }
  if (word !== undefined) words.push(word);
  return words;
}

/** What cmd.exe acts on outside double quotes: a word that holds one unquoted runs something else. */
const CMD_ACTS_ON = /[&|<>^()]/;

describe('a word of a line, as its shell reads it back', () => {
  const WORDS = [
    'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\owners.json',
    'C:\\Users\\dev one\\Downloads\\before uat.sfcheckpoint',
    'C:\\R&D (2026)\\store',
    "C:\\Users\\o'neil\\replay-config.json",
    'C:\\data\\',
    'C:\\data\\with space\\',
    'env=uat 2',
    'Name = \'Acme "North"\'',
    'a\\"b',
    '',
  ];

  it('leaves as it is a word no shell acts on, whatever the system', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      for (const word of [
        'DEV-SB',
        'ci+dev@example.com',
        '--var=env=uat',
        'Account,Contact',
        '/home/dev/checkpoints',
      ]) {
        expect(typedWord(word, platform)).toBe(word);
      }
    }
  });

  it('gives cmd.exe and the runtime under it each word whole on Windows, in double quotes, nothing cmd.exe acts on outside them', () => {
    for (const word of WORDS) {
      const typed = typedWord(word, 'win32');
      expect(typed.startsWith('"') && typed.endsWith('"'), typed).toBe(true);
      expect(windowsWordsOf(`--file ${typed} --target DEV`), typed).toEqual([
        '--file',
        word,
        '--target',
        'DEV',
      ]);
      const outside = typed
        .split('"')
        .filter((_, at) => at % 2 === 0)
        .join('');
      expect(outside, typed).not.toMatch(CMD_ACTS_ON);
    }
    expect(typedWord('C:\\Users\\dev one\\x.json', 'win32')).toBe('"C:\\Users\\dev one\\x.json"');
    expect(typedWord('C:\\data\\', 'win32')).toBe('"C:\\data\\\\"');
  });

  it('gives a POSIX shell each word whole elsewhere, in single quotes', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      for (const word of WORDS) {
        const typed = typedWord(word, platform);
        expect(posixWordsOf(`--file ${typed} --target DEV`), typed).toEqual([
          '--file',
          word,
          '--target',
          'DEV',
        ]);
      }
    }
    expect(typedWord("it's", 'linux')).toBe("'it'\\''s'");
  });
});
