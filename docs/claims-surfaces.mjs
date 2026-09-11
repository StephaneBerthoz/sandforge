/**
 * What both claims gates share: the manifest localization they resolve `%key%`
 * against, and the one piece of vocabulary they both have to spell right.
 *
 * VS Code renders `contributes.*` descriptions, command titles and walkthrough
 * bodies from `package.nls.<locale>.json`, so a manifest string is only half a
 * surface: the half a reader meets lives in six files beside it. Both
 * `marketplace-claims.test.mjs` (which pins a handful of entries) and
 * `product-claims.test.mjs` (which reads every one of them) need the same
 * resolution, and a second copy of it would be a second thing to keep true.
 *
 * Not a test file: it holds no `test()` call, so importing it registers
 * nothing and `node --test docs/*.test.mjs` still runs each gate once.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const docsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(docsDir, '..');
const extensionDir = join(repoRoot, 'packages', 'extension');

/** The six manifest locale bundles, as `locale → file name`. */
export const NLS_FILES = {
  en: 'package.nls.json',
  fr: 'package.nls.fr.json',
  de: 'package.nls.de.json',
  es: 'package.nls.es.json',
  ja: 'package.nls.ja.json',
  'pt-br': 'package.nls.pt-br.json',
};

/** The same six, as `locale → flat key/value map`. */
export const bundles = () =>
  Object.fromEntries(
    Object.entries(NLS_FILES).map(([locale, file]) => [
      locale,
      JSON.parse(readFileSync(join(extensionDir, file), 'utf8')),
    ]),
  );

/**
 * Concurrency, in the six languages the extension ships — the claim no surface
 * may make about Grappe while every grappe path is a sequential `for await`.
 *
 * Spanish and Portuguese spell "parallel" with a single `l`. An earlier
 * `\bparall[eèa]l` matched neither, so `motor de ejecución paralela` and
 * `motor de execução paralela` sat on the Grappe page header reported by
 * nothing, in a gate written to check exactly that.
 *
 * The word is not the only way to say it, and the missing spellings were not
 * hypothetical: `sandforge.grappe.maxWorkers` shipped for a release as "maximum
 * number of partitions processed **concurrently**" (removed in v1.17.0,
 * CONTRACT-03), which the accent-free `paral…` class could not see. So the
 * class carries the concurrency vocabulary of all six: the accented French
 * forms (`parallélisme`, `parallélisation`), `concurrent`/`concurremment` and
 * the Iberian `concorrente`, German `gleichzeitig` and `nebenläufig`,
 * `simultané`/`simultáneo`/`simultaneamente`, and the Japanese 並列 / 並行 / 同時.
 *
 * The word alone is not the rule: see {@link parallelAssertions}.
 */
export const PARALLEL_WORD =
  /\bparal{1,2}[eèéaá]l|\bconcurren|\bconcorren|\bgleichzeitig|\bnebenl(?:ä|a)ufig|\bsimult[aáâ]n|並列|並行|同時/i;

/**
 * The negations the six languages write. A sentence that DENIES concurrency is
 * the honest sentence this product now has to be able to publish: `docs/faq.md`
 * answers a slow-run question with "(Grappe, when enabled, reports progress per
 * partition; it does not run the partitions concurrently.)", and an ADR titled
 * "Grappe is not a parallel executor" is the page a reader most needs. A bare
 * word ban refuses all three, and a gate that refuses honest text gets weakened
 * by hand, which costs more than the coverage it buys.
 *
 * A denial is rarely written in the citation form. An earlier class held
 * `plutôt que`, `au lieu de`, `en lugar de`, `em vez de`, `anstatt` — and not
 * one of them survives contact with the next word: French elides both phrases
 * before a vowel (`plutôt qu'en parallèle`, `au lieu d'une exécution en
 * parallèle`), the two Iberian languages contract the preposition into the
 * article (`en lugar del`, `em vez do`), German writes the nominal `anstelle
 * einer parallelen Ausführung`, and Japanese writes `並列実行の代わりに`. Each of
 * those is a true sentence the gate refused. So the phrases are written with
 * their elisions and contractions, the nominal forms are added beside the
 * subordinating ones, and French `ne` — which carries the negation while `pas`
 * may be absent (`ne … que`, `n'existe plus`) — is read on its own.
 *
 * Widening this class can only let a sentence through, never refuse one: it is
 * the safe direction, and the limit it buys is declared where the rule is used.
 */
const NEGATOR = new RegExp(
  [
    // English, with the phrases that put one thing where another was.
    String.raw`\b(?:not|never|no|nor|none|nothing|neither|without|isn't|aren't|doesn't|don't|cannot|can't)\b`,
    String.raw`\b(?:instead|rather\s+than|in\s+place\s+of|far\s+from|short\s+of)\b`,
    // French: `ne` elides into `n'`, and so do both "instead of" phrases.
    String.raw`\b(?:ne|pas|jamais|aucune?|ni|rien|sans|non)\b|\bn['’]`,
    String.raw`\bplut[oô]t\s+qu(?:e\b|['’])|\bau\s+lieu\s+d(?:e\b|['’])`,
    // German, with the nominal `anstelle` and the emphatic forms.
    String.raw`\b(?:nicht|nichts|keine?[nmrs]?|keinesfalls|keineswegs|nie|niemals|ohne|statt|anstatt|anstelle)\b`,
    // Spanish and Portuguese, with the article the preposition contracts into.
    String.raw`\b(?:no|nunca|jamás|ningun[ao]?|ningún|nada|nenhum[ao]?|sin|sem|nem|não)\b`,
    String.raw`\b(?:en|em)\s+(?:lugar|vez)\s+d(?:el|es|os|as|e|o|a)\b`,
    // Japanese, with the nominal 〜の代わりに and 〜なし.
    String.raw`ません|ない|なく|なし|ではなく|せず|ずに|代わりに`,
  ].join('|'),
  'iu',
);

/**
 * A sentence: the unit a negation governs. A full stop only ends one when
 * whitespace follows, so `docs/product-claims.test.mjs` and `v1.21` stay whole
 * — an earlier cut split on every dot, and a filename written in front of the
 * word cut the denial off from the thing it denied.
 */
const SENTENCE = /(?<=[.!?…])\s+|[。！？\n]+/u;

/**
 * The sentences of a text that ASSERT concurrency: the word, in a sentence that
 * denies nothing.
 *
 * The limit, declared rather than guessed at: a sentence that denies one thing
 * and asserts concurrency in the same breath — "Grappe does not queue the
 * partitions, it runs them in parallel" — reads as a denial and passes. The
 * trade is deliberate. What stands behind it is the mined list of wordings this
 * product published, refused whole, and the code anchors under that; what a
 * tighter rule costs is a true sentence refused, which is how a gate ends up
 * weakened by hand.
 */
export function parallelAssertions(text) {
  const assertions = [];
  for (const sentence of String(text).split(SENTENCE)) {
    if (!PARALLEL_WORD.test(sentence)) continue;
    if (NEGATOR.test(sentence)) continue;
    assertions.push(sentence.trim());
  }
  return [...new Set(assertions)];
}

/** Whether a manifest string is a localization placeholder rather than prose. */
export const isNlsPlaceholder = (value) => typeof value === 'string' && /^%[\w.-]+%$/.test(value);

/** `%key%` → the value each locale gives it. Throws if any locale lacks it. */
export function resolveNls(placeholder) {
  const key = /^%(.+)%$/.exec(placeholder)?.[1];
  assert.ok(key, `not a localization placeholder: ${JSON.stringify(placeholder)}`);
  const out = {};
  for (const [locale, bundle] of Object.entries(bundles())) {
    const value = bundle[key];
    assert.equal(
      typeof value,
      'string',
      `${NLS_FILES[locale]} has no entry for "${key}" — the manifest renders the raw %key%`,
    );
    out[locale] = value;
  }
  return out;
}
