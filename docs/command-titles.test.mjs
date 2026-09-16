/**
 * A sentence that sends somebody to the Command Palette names a command the
 * extension contributes.
 *
 * `ai.error.auth` told a user whose key had just been refused to open
 * "SandForge: Configure AI Key" from the Command Palette. No such command has
 * ever existed — nothing outside the Settings page of the webview stores a key
 * — so the one instruction shown at the exact moment of failure led to an
 * empty palette search, in all six languages.
 *
 * The rule is mechanical and deliberately narrow: in a text that mentions the
 * Command Palette, and anywhere a mention opens with an English command verb,
 * every `SandForge: <Title>` has to match a title of `contributes.commands`, resolved through the six `package.nls*`
 * bundles because that is the list VS Code actually offers. Scanning every
 * `SandForge: …` instead would be scanning the notification prefix that every
 * `l10n` string and the Marketplace tagline already use — thousands of matches,
 * none of them an instruction.
 *
 * Surfaces read here:
 *
 *  - the six webview locale bundles, by value;
 *  - the six `package.nls*.json`, by value;
 *  - the six `l10n/bundle.l10n*.json`, by value;
 *  - `README.md`, `packages/extension/README.md`, every `.md` under `docs/`
 *    minus the untracked `docs/archive/`, and the 24 walkthrough bodies;
 *  - `packages/extension/src`, where the error text a handler throws is
 *    written.
 *
 *   node --test docs/command-titles.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { NLS_FILES, bundles, isNlsPlaceholder, resolveNls } from './claims-surfaces.mjs';

const docsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(docsDir, '..');
const extensionDir = join(repoRoot, 'packages', 'extension');
const read = (...parts) => readFileSync(join(repoRoot, ...parts), 'utf8');

/**
 * "Command Palette", in the six languages the product ships. French often says
 * only "la palette", and "Befehlspalette" holds the same word.
 */
const PALETTE = /palette|paleta de comandos|コマンドパレット/i;

/**
 * `SandForge: <Title>`, stopping at the first character a title cannot hold.
 *
 * Markdown emphasis, backticks and sentence punctuation all end it, so
 * "run **SandForge: Open Forge** from the Command Palette." yields
 * "Open Forge".
 */
const MENTION = /SandForge\s*:\s*([^.,;:!?\n)\]"'`*→]+)/g;

/** Every title `contributes.commands` declares, in the six languages. */
function declaredTitles() {
  const manifest = JSON.parse(read('packages', 'extension', 'package.json'));
  const titles = new Set();
  for (const command of manifest.contributes?.commands ?? []) {
    const raw = command.title;
    const values = isNlsPlaceholder(raw) ? Object.values(resolveNls(raw)) : [raw];
    for (const value of values) titles.add(String(value).trim());
  }
  // Declared as the whole title ("SandForge: Open Forge"), compared against the
  // part MENTION captures.
  return new Set(
    [...titles].map((title) => title.replace(/^SandForge\s*:\s*/, '').trim()).filter(Boolean),
  );
}

/**
 * The English verbs a command title starts with. Translated verbs are left out:
 * "Öffnen von …" and "Ouvrir l'Org" are sentence and title fragments the
 * mention cannot tell from a command. A mention that opens with one reads as a command to run even when
 * no palette is named — "(SandForge: Configure AI Key)" in a thrown error — while
 * the notification prefix ("SandForge: Quick Seed completed") does not.
 */
const COMMAND_VERB =
  /^(Open|Configure|Run|Show|Set|Start|Stop|Clear|Export|Import|Refresh|Reset|Toggle|Connect|Disconnect|Create|Delete|View|Manage|Enable|Disable)\b/;

/** The titles a command instruction names, whether or not they exist. */
export function commandsNamedIn(text) {
  const palette = PALETTE.test(text);
  MENTION.lastIndex = 0;
  const found = [];
  let match;
  while ((match = MENTION.exec(text)) !== null) {
    // `SandForge: Open ...` stands for any of the launchers rather than naming
    // one, and getting-started.md writes it to say the Home view has none.
    const rest = text.slice(match.index + match[0].length);
    if (/^(\.\.\.|…)/.test(rest)) continue;
    let title = match[1].trim();
    /* A title can hold a bracketed qualifier of its own — "Open Grappe
       (partition progress)". The class above stops at ')' so that a mention
       wrapped in brackets, "(run SandForge: Open Forge)", does not swallow the
       closing one; when the capture leaves a bracket open, that ')' is the
       title's own and belongs to it. */
    if ((title.match(/\(/g) ?? []).length > (title.match(/\)/g) ?? []).length) {
      if (text.slice(match.index + match[0].length).startsWith(')')) title += ')';
    }
    if (palette || COMMAND_VERB.test(title)) found.push(title);
  }
  return found;
}

/** Every `.md` under a directory, minus the untracked archive. */
function markdownFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'archive') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) markdownFiles(full, acc);
    else if (entry.name.endsWith('.md')) acc.push(full);
  }
  return acc;
}

/** Every string leaf of a nested JSON bundle. */
function leaves(node, acc = []) {
  if (typeof node === 'string') acc.push(node);
  else if (node && typeof node === 'object') for (const v of Object.values(node)) leaves(v, acc);
  return acc;
}

/** Every `.ts` file of the extension source, tests included. */
function sourceFiles(dir = join(extensionDir, 'src'), acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (entry.name.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

/** `[label, text][]` — one entry per string or per line of prose. */
function surfaces() {
  const out = [];
  const push = (label, texts) => {
    for (const text of texts) out.push([label, text]);
  };

  const localesDir = join(repoRoot, 'packages', 'webview', 'src', 'i18n', 'locales');
  for (const file of readdirSync(localesDir).filter((name) => name.endsWith('.json'))) {
    push(`webview ${file}`, leaves(JSON.parse(readFileSync(join(localesDir, file), 'utf8'))));
  }

  for (const [locale, values] of Object.entries(bundles())) {
    push(`package.nls ${locale}`, Object.values(values).map(String));
  }

  const l10nDir = join(extensionDir, 'l10n');
  for (const file of readdirSync(l10nDir).filter((name) => name.endsWith('.json'))) {
    push(`l10n ${file}`, leaves(JSON.parse(readFileSync(join(l10nDir, file), 'utf8'))));
  }

  const prose = [
    join(repoRoot, 'README.md'),
    join(extensionDir, 'README.md'),
    ...markdownFiles(join(repoRoot, 'docs')),
    ...markdownFiles(join(extensionDir, 'walkthrough')),
  ];
  for (const file of [...prose, ...sourceFiles()]) {
    push(file.slice(repoRoot.length + 1), readFileSync(file, 'utf8').split('\n'));
  }

  return out;
}

test('every command an instruction names is contributed', () => {
  const declared = declaredTitles();
  assert.ok(declared.size > 0, 'the manifest contributes no command title');

  const offenders = [];
  for (const [label, text] of surfaces()) {
    for (const title of commandsNamedIn(text)) {
      if (!declared.has(title)) offenders.push(`${label}: SandForge: ${title}`);
    }
  }

  assert.deepEqual([...new Set(offenders)].sort(), []);
});

test('a title keeps its own brackets, a bracketed mention does not take one', () => {
  // The first is `command.openGrappe` as the manifest ships it; the second is
  // the shape that made the scan stop at ')' in the first place.
  assert.deepEqual(commandsNamedIn('SandForge: Open Grappe (partition progress)'), [
    'Open Grappe (partition progress)',
  ]);
  assert.deepEqual(
    commandsNamedIn('Open the Command Palette and run (SandForge: Open Forge) to start.'),
    ['Open Forge'],
  );
});

test('the scan reads a palette instruction the way a reader does', () => {
  const declared = declaredTitles();

  // The sentence this gate was written for, and its five translations, as shipped.
  const withdrawn = [
    'AI key invalid or missing. Open Command Palette → SandForge: Configure AI Key.',
    'Clé AI invalide ou absente. Ouvrir la palette → SandForge: Configurer la clé AI.',
    'KI-Schlüssel ungültig oder fehlt. Befehlspalette öffnen → SandForge: Configure AI Key.',
    'Clave de IA inválida o faltante. Abra la Paleta de comandos → SandForge: Configure AI Key.',
    'AIキーが無効または未設定です。コマンドパレット → SandForge: Configure AI Keyを開いてください。',
    'Chave de IA inválida ou ausente. Abra a Paleta de Comandos → SandForge: Configure AI Key.',
  ];
  // A thrown error named the same command with no palette in the sentence, so
  // the palette alone cannot be what makes a mention an instruction.
  withdrawn.push(
    'AI is disabled. Enable sandforge.ai.enabled and configure your Anthropic API key (SandForge: Configure AI Key) to create custom personas.',
    "            '(SandForge: Configure AI Key) to create custom personas.',",
  );
  for (const sentence of withdrawn) {
    const named = commandsNamedIn(sentence);
    assert.equal(named.length, 1, sentence);
    assert.equal(declared.has(named[0]), false, sentence);
  }

  // Positive control: the two real instructions this repository ships.
  for (const sentence of [
    'run **SandForge: Open Forge** from the Command Palette.',
    'Open **Frozen Dataset** from the sidebar (or `SandForge: Open Frozen Dataset` from the command palette)',
  ]) {
    const named = commandsNamedIn(sentence);
    assert.equal(named.length, 1, sentence);
    assert.equal(declared.has(named[0]), true, `${sentence} → ${named[0]}`);
  }

  // A sentence with no palette in it is not an instruction to run anything.
  assert.deepEqual(commandsNamedIn('SandForge: Quick Seed completed — 42 records'), []);
});

test('the six manifest bundles all declare the command titles', () => {
  const resolved = resolveNls('%command.openSettings%');
  assert.deepEqual(Object.keys(resolved).sort(), Object.keys(NLS_FILES).sort());
});
