/**
 * Which roots a sample of the whole org draws among, resolved before a
 * request is sent: the dates its roots were made or last modified in
 * (`window`), a condition on the roots of an object (`rootWhere`), and the
 * field the roots of an object are stratified by (`strata`) — each held to
 * the objects of the run as the sample takes them (`sampleLinks.ts`) and to
 * their describes, and given per object as the reader of the source takes
 * them (`RootRead.window`, `where`, `stratifiedBy`), which writes their terms.
 *
 * They choose the roots alone, the top of each story. A record under a root,
 * or above it as its parent, comes whatever its date or its values: the
 * reader holds them to the reads of the roots — their count, their scan,
 * their statements by date — and never to a read of records by their ids,
 * under a parent, or whole. Applied as an object's filter, the same
 * condition would leave empty the lookup of an account whose parent is
 * outside it, and a record that cannot do without it would not be written:
 * the copy would change. `--filter` is what leaves records out of it.
 *
 * - **Window.** `CreatedDate` or `LastModifiedDate`, from an instant
 *   included to one left out, in UTC to the second, either left out; or the
 *   last n days, counted back from when the sample is drawn and written as
 *   that instant, `lastDays` kept beside it for the report. An object whose
 *   describe has no such date has no root in the draw, and is said apart,
 *   never as empty: the reader is not asked for it.
 * - **Filter on the roots.** The user's WHERE, as an object's filter is
 *   held. A statement takes two semi-joins at most (an org refused a third,
 *   `EXCEEDED_MAX_SEMIJOIN_SUBSELECTS`): an object's filter and the filter on
 *   its roots hold no more together, which is refused here before the org is
 *   asked.
 * - **Strata.** `Field`, of every object drawn whose describe lists it and
 *   groups it, or `Object.Field`, of that object, before the other form. A
 *   picklist, a checkbox or a lookup — the record type, the owner — and none
 *   that carries the draw, which a root never fills.
 *
 * Every option the run cannot take is refused here, all at once and each
 * with its way out (`SampleDrawInvalid`), nothing read.
 */

import type { ForgeSampleOptions, ForgeSampleWindow, WholeOrgSampleRoots } from '@sandforge/shared';
import { soqlInstant } from '../../checkpoint/orgStreams.js';
import { ForgeRunGateError } from '../ForgeRunGate.js';
import type { SampleLinks } from './sampleLinks.js';
import type { RootRead } from './sampleReader.js';

/** A field of an object's describe in the source, as the options of a draw are held to it. */
export interface SampleDrawField {
  name: string;
  /** The field's type as the describe gives it: `picklist`, `boolean`, `reference`, `string`… */
  type?: string;
  /** Whether the org groups rows by it; unknown when the describe does not say. */
  groupable?: boolean;
  /** Whether the org aggregates it, as `COUNT(Id)` does the id; unknown when not said. */
  aggregatable?: boolean;
}

/** What the options of a draw are resolved against: see {@link sampleRootsOf}. */
export interface SampleRootsInput {
  options: Pick<ForgeSampleOptions, 'window' | 'rootWhere' | 'strata'>;
  /** When the sample is drawn, in milliseconds: what a window of the last days counts back from. */
  now: number;
  links: SampleLinks;
  /** The objects the user left out of the run (`--exclude-object`). */
  excluded?: Iterable<string>;
  /** An object's describe in the source; undefined for one the run has none of. */
  fieldsOf(objectApiName: string): readonly SampleDrawField[] | undefined;
  /** An object's filter (`ForgeConfig.objectSoqlFilters`). */
  filterOf?(objectApiName: string): string | undefined;
}

/**
 * How the roots of one object drawn from its roots are chosen, as the reader
 * takes them: the window, its instants resolved; the filter on its roots;
 * the field its roots are stratified by, as its describe names it.
 */
export interface SampleObjectRoots extends Pick<RootRead, 'window' | 'where' | 'stratifiedBy'> {
  objectApiName: string;
  /**
   * Set when a window is asked and its describe has no such date: no root of
   * it is in the draw, and the reader is not asked for any.
   */
  notWindowed?: true;
}

/** Which roots a sample draws among: see {@link sampleRootsOf}. */
export interface SampleRoots {
  /** The window, its instants resolved, `lastDays` kept beside them. */
  window?: ForgeSampleWindow;
  /** Every object drawn from its roots, by name, with how its roots are chosen. */
  objects: ReadonlyMap<string, SampleObjectRoots>;
  /** The objects drawn whose describe has no date the window asks: no root in the draw. */
  notWindowed: string[];
  /** The filters on the roots, by object, as they are applied. */
  where: Array<{ objectApiName: string; where: string }>;
  /**
   * Whether the roots in the draw are fewer than the roots of the source:
   * held to a window or to a filter on the roots. Strata keep every root in
   * the draw.
   */
  restricted: boolean;
  /** Whether an object's roots are stratified. */
  stratified: boolean;
}

/**
 * The options of a draw refused before it sends a request, nothing written
 * (`SAMPLE_DRAW_INVALID`): each problem in its words, each naming what is
 * valid or the way to write it. A count the source refuses is the reader's
 * to refuse, in the source's words. A gate's stop as any other, its name
 * kept: `isForgeRunGateError` reads it by its name too.
 *
 * Read off the describes discovery took, after the reads a run makes first:
 * said "no request was sent", a refusal followed 163 requests of discovery
 * and of the target. The draw sent none; the words say whose they were.
 */
export class SampleDrawInvalid extends ForgeRunGateError {
  constructor(readonly problems: readonly string[]) {
    super(
      'SAMPLE_DRAW_INVALID',
      `${problems.join(' ')} Nothing was written, and no root was counted or read: the ` +
        'requests sent before the draw were discovery’s and the target’s.',
      undefined,
      undefined,
      undefined,
      { sample: { requests: 0 } },
    );
  }
}

/** A day, in milliseconds: what a window of the last days counts back by. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** The most semi-joins a statement takes: an org refused a third. */
export const SEMI_JOINS_MOST = 2;

/** The describe types a stratum may be of: a picklist, a checkbox, a lookup. */
const STRATUM_TYPES: ReadonlySet<string> = new Set(['picklist', 'boolean', 'reference']);

/** The fields of few values a refusal offers of an object, at most. */
const FIELDS_OFFERED = 6;

/** The objects a refusal names, at most. */
const OBJECTS_NAMED = 12;

/** `text` with its quoted literals emptied: what is read for its words. */
function withoutLiterals(text: string): string {
  return text.replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

/** The semi-joins `text` holds, `IN (SELECT …)`, quoted text left out. */
export function semiJoinsIn(text: string | undefined): number {
  if (text === undefined) return 0;
  return withoutLiterals(text).match(/\(\s*SELECT\b/gi)?.length ?? 0;
}

/** The field of `fields` named `name`, the case told alike. */
function fieldNamed(
  fields: readonly SampleDrawField[] | undefined,
  name: string,
): SampleDrawField | undefined {
  const key = name.toLowerCase();
  return fields?.find((field) => field.name.toLowerCase() === key);
}

/** `names` as a refusal says them: the first dozen, the others counted. */
function namesOf(names: readonly string[]): string {
  if (names.length === 0) return 'none';
  const shown = names.slice(0, OBJECTS_NAMED).join(', ');
  return names.length > OBJECTS_NAMED ? `${shown} and ${names.length - OBJECTS_NAMED} more` : shown;
}

/**
 * The window as the draw applies it: its bounds as instants to the second,
 * as `soqlInstant` writes them; of the last n days, its start counted back
 * from `now`, `lastDays` kept beside it.
 *
 * @returns The window, or the problem it is refused for: a bound that is no
 * instant, or a window that ends before it starts.
 */
function resolvedWindowOf(
  window: ForgeSampleWindow,
  now: number,
): { window: ForgeSampleWindow } | { problem: string } {
  if (window.lastDays !== undefined && window.from === undefined && window.to === undefined) {
    return {
      window: {
        field: window.field,
        from: soqlInstant(now - window.lastDays * DAY_MS),
        lastDays: window.lastDays,
      },
    };
  }
  const instant = (text: string | undefined): string | null | undefined => {
    if (text === undefined) return undefined;
    try {
      return soqlInstant(text);
    } catch {
      return null;
    }
  };
  const from = instant(window.from);
  const to = instant(window.to);
  if (from === null || to === null) {
    return {
      problem: `The window's bound ${from === null ? window.from : window.to} is no instant: write it in UTC, as 2025-07-01T00:00:00Z.`,
    };
  }
  if (from !== undefined && to !== undefined && Date.parse(from) >= Date.parse(to)) {
    return {
      problem: `The window starts at ${from} and ends before it, at ${to}: its start is before its end.`,
    };
  }
  return {
    window: {
      field: window.field,
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
    },
  };
}

/**
 * Of an object drawn from its roots, the lookup that keeps it from having
 * any: one that carries the draw, names one object, and that a record cannot
 * be written without — every record fills it, as an opportunity's product
 * line its opportunity.
 */
function rootlessBy(
  links: SampleLinks,
  objectApiName: string,
): { field: string; parent: string } | undefined {
  const link = (links.linksOf.get(objectApiName) ?? []).find(
    (own) => own.carries && own.required && own.prefix === undefined,
  );
  return link ? { field: link.field, parent: link.parent } : undefined;
}

/**
 * Whether `field` of `objectApiName` carries the draw: a root never fills
 * it, and its value says nothing of the root.
 */
function carrierNamed(
  links: SampleLinks,
  objectApiName: string,
  field: string,
): { parent: string } | undefined {
  const key = field.toLowerCase();
  const link = (links.linksOf.get(objectApiName) ?? []).find(
    (own) => own.carries && own.field.toLowerCase() === key,
  );
  return link ? { parent: link.parent } : undefined;
}

/**
 * The fields of few values a refusal offers of an object: its record type
 * and owner first, then its picklists, those it groups by and that carry no
 * draw.
 */
function offeredFieldsOf(input: SampleRootsInput, objectApiName: string): string[] {
  const fields = (input.fieldsOf(objectApiName) ?? []).filter(
    (field) =>
      field.groupable !== false &&
      STRATUM_TYPES.has(field.type ?? '') &&
      carrierNamed(input.links, objectApiName, field.name) === undefined,
  );
  const first = ['RecordTypeId', 'OwnerId'].flatMap((name) => {
    const field = fieldNamed(fields, name);
    return field ? [field.name] : [];
  });
  const picklists = fields
    .filter((field) => field.type === 'picklist')
    .map((field) => field.name)
    .sort();
  return [...first, ...picklists].slice(0, FIELDS_OFFERED);
}

/** The way out of a stratum refused on `objectApiName`: the fields of few values it has. */
function fewValuesOf(input: SampleRootsInput, objectApiName: string): string {
  const offered = offeredFieldsOf(input, objectApiName);
  return (
    'Its roots are stratified by a field of few values — a picklist, a checkbox, the record type ' +
    '(RecordTypeId) or the owner (OwnerId)' +
    (offered.length > 0 ? `: of ${objectApiName}, ${offered.join(', ')}.` : '.')
  );
}

/**
 * The field of `objectApiName` named `field` its roots are stratified by, as
 * its describe names it; or why it cannot be: a field the describe does not
 * list, of a type of many values, one that carries the draw, one the org
 * does not group by, or an object whose records the org does not count by a
 * field.
 */
function stratumOf(
  input: SampleRootsInput,
  objectApiName: string,
  field: string,
): { problem: string } | { field: string } {
  const fields = input.fieldsOf(objectApiName);
  const named = fieldNamed(fields, field);
  if (!named) {
    return {
      problem: `${objectApiName} has no field ${field}. ${fewValuesOf(input, objectApiName)}`,
    };
  }
  if (!STRATUM_TYPES.has(named.type ?? '')) {
    return {
      problem:
        (named.type
          ? `${objectApiName}.${named.name} is a ${named.type} field, of too many values to ` +
            'stratify by. '
          : `The describe does not say what type ${objectApiName}.${named.name} is, and a ` +
            'stratum is of a known few. ') + fewValuesOf(input, objectApiName),
    };
  }
  const carrier = carrierNamed(input.links, objectApiName, named.name);
  if (carrier) {
    return {
      problem:
        `${objectApiName}.${named.name} names the ${carrier.parent} a record of ${objectApiName} comes ` +
        `under, and a root of ${objectApiName} never fills it: it stratifies nothing. ` +
        fewValuesOf(input, objectApiName),
    };
  }
  if (named.groupable === false) {
    return {
      problem:
        `The source does not group ${objectApiName} by ${named.name}, which its strata are counted ` +
        `by. ${fewValuesOf(input, objectApiName)}`,
    };
  }
  if (fieldNamed(fields, 'Id')?.aggregatable === false) {
    return {
      problem:
        `The source does not count the records of ${objectApiName} by a field (COUNT(Id)), which ` +
        'its strata are counted by: its roots cannot be stratified.',
    };
  }
  return { field: named.name };
}

/**
 * Resolve the options of a draw against the run: see the module's comment.
 * Every object drawn from its roots is in the answer, with nothing of its
 * own when nothing chooses its roots.
 *
 * @throws SampleDrawInvalid With every problem at once, each with its way out.
 */
export function sampleRootsOf(input: SampleRootsInput): SampleRoots {
  const { links, options } = input;
  const problems: string[] = [];
  let window: ForgeSampleWindow | undefined;
  if (options.window !== undefined) {
    const resolved = resolvedWindowOf(options.window, input.now);
    if ('problem' in resolved) problems.push(resolved.problem);
    else window = resolved.window;
  }

  const drawn = [...links.classes]
    .filter(([, kind]) => kind.kind === 'drawn' && kind.rooted)
    .map(([objectApiName]) => objectApiName)
    .sort();
  const withRoots = drawn.filter((objectApiName) => !rootlessBy(links, objectApiName));
  const byKey = new Map([...links.classes.keys()].map((name) => [name.toLowerCase(), name]));
  const excluded = new Map([...(input.excluded ?? [])].map((name) => [name.toLowerCase(), name]));

  /**
   * The object of the run an option names, the case told alike; or why its
   * roots cannot be chosen: left out, not of the run, copied whole, with no
   * root of its own, or every record of it under one it cannot do without.
   */
  const objectNamed = (name: string, option: 'where' | 'strata'): string | undefined => {
    const asked = option === 'where' ? 'filter on its roots' : 'strata';
    const objectApiName = byKey.get(name.toLowerCase());
    const kind = objectApiName === undefined ? undefined : links.classes.get(objectApiName);
    if (objectApiName === undefined || kind === undefined) {
      const left = excluded.get(name.toLowerCase());
      problems.push(
        left !== undefined
          ? `${left} is left out of the run (--exclude-object), and has no root to draw: take it ` +
              `out of one option or the other.`
          : `${name} is no object of the run, and takes no ${asked}. The objects whose roots are ` +
              `drawn are ${namesOf(withRoots)}.`,
      );
      return undefined;
    }
    if (kind.kind === 'whole') {
      problems.push(
        `Every record of ${objectApiName} comes, as the sample copies it whole: it has no root ` +
          `drawn, and takes no ${asked}. ` +
          (option === 'where'
            ? `--filter leaves records of it out of the copy.`
            : `The objects whose roots are drawn are ${namesOf(withRoots)}.`),
      );
      return undefined;
    }
    if (!kind.rooted) {
      problems.push(
        `${objectApiName} has no root of its own: its records come as the records the sample ` +
          `keeps name them, and it takes no ${asked}. The objects whose roots are drawn are ` +
          `${namesOf(withRoots)}.`,
      );
      return undefined;
    }
    const under = rootlessBy(links, objectApiName);
    if (under) {
      problems.push(
        `Every record of ${objectApiName} comes under the ${under.parent} it cannot be written ` +
          `without (${under.field}): it has no root, and takes no ${asked}. ` +
          (option === 'where'
            ? `Filter the roots of ${under.parent} instead: --fit-where ` +
              `"${under.parent}=Id IN (SELECT ${under.field} FROM ${objectApiName} WHERE …)".`
            : `Stratify the roots of ${under.parent} instead.`),
      );
      return undefined;
    }
    return objectApiName;
  };

  // The filters on the roots, each of an object whose roots are drawn, once.
  const whereOf = new Map<string, string>();
  for (const [name, text] of Object.entries(options.rootWhere ?? {})) {
    const objectApiName = objectNamed(name, 'where');
    if (objectApiName === undefined) continue;
    if (whereOf.has(objectApiName)) {
      problems.push(`The roots of ${objectApiName} are given two filters: give one.`);
      continue;
    }
    const semiJoins = semiJoinsIn(input.filterOf?.(objectApiName)) + semiJoinsIn(text);
    if (semiJoins > SEMI_JOINS_MOST) {
      problems.push(
        `A statement of ${objectApiName} takes ${SEMI_JOINS_MOST} semi-joins at most ` +
          `(IN (SELECT …)), and its filter and the filter on its roots hold ${semiJoins}: write ` +
          'one of them without, or fold them into fewer.',
      );
      continue;
    }
    whereOf.set(objectApiName, text.trim());
  }

  // The strata: of one object, before the form every object takes.
  let everyObject: string | undefined;
  const ofOne = new Map<string, string>();
  for (const spec of options.strata ?? []) {
    const dot = spec.indexOf('.');
    if (dot < 0) {
      everyObject = spec;
      continue;
    }
    const objectApiName = objectNamed(spec.slice(0, dot), 'strata');
    if (objectApiName === undefined) continue;
    if (ofOne.has(objectApiName)) {
      problems.push(`The roots of ${objectApiName} are stratified by one field at most: give one.`);
      continue;
    }
    ofOne.set(objectApiName, spec.slice(dot + 1));
  }
  const strataOf = new Map<string, string>();
  for (const [objectApiName, field] of ofOne) {
    const stratum = stratumOf(input, objectApiName, field);
    if ('problem' in stratum) problems.push(stratum.problem);
    else strataOf.set(objectApiName, stratum.field);
  }
  if (everyObject !== undefined) {
    let took = false;
    for (const objectApiName of withRoots) {
      if (ofOne.has(objectApiName)) continue;
      const fields = input.fieldsOf(objectApiName);
      const named = fieldNamed(fields, everyObject);
      // Of every object that lists it and groups it, as the form says.
      if (!named || named.groupable === false || fieldNamed(fields, 'Id')?.aggregatable === false) {
        continue;
      }
      took = true;
      const stratum = stratumOf(input, objectApiName, named.name);
      if ('problem' in stratum) {
        problems.push(
          `${stratum.problem} Or name each object ${everyObject} stratifies, as ` +
            `Object.${everyObject}.`,
        );
      } else strataOf.set(objectApiName, stratum.field);
    }
    if (!took) {
      problems.push(
        `No object whose roots are drawn — ${namesOf(withRoots)} — has a field ${everyObject} ` +
          `it groups by. Name the object and its field, as ` +
          `${withRoots[0] ?? 'Account'}.RecordTypeId.`,
      );
    }
  }

  if (problems.length > 0) throw new SampleDrawInvalid(problems);

  const notWindowed: string[] = [];
  const objects = new Map<string, SampleObjectRoots>();
  for (const objectApiName of drawn) {
    const where = whereOf.get(objectApiName);
    const stratifiedBy = strataOf.get(objectApiName);
    const entry: SampleObjectRoots = {
      objectApiName,
      ...(where !== undefined ? { where } : {}),
      ...(stratifiedBy !== undefined ? { stratifiedBy } : {}),
    };
    if (window !== undefined) {
      const dated = fieldNamed(input.fieldsOf(objectApiName), window.field);
      if (dated) {
        entry.window = {
          field: window.field,
          ...(window.from !== undefined ? { from: window.from } : {}),
          ...(window.to !== undefined ? { to: window.to } : {}),
        };
      } else {
        entry.notWindowed = true;
        notWindowed.push(objectApiName);
      }
    }
    objects.set(objectApiName, entry);
  }
  return {
    ...(window !== undefined ? { window } : {}),
    objects,
    notWindowed,
    where: [...whereOf]
      .map(([objectApiName, where]) => ({ objectApiName, where }))
      .sort((a, b) => (a.objectApiName < b.objectApiName ? -1 : 1)),
    restricted: window !== undefined || whereOf.size > 0,
    stratified: strataOf.size > 0,
  };
}

/**
 * How a sample chose its roots, as its report says it, but for the values of
 * its strata, which the draw counts (`StratifiedRoots.report`): the window,
 * the objects drawn without its date, and the filters on the roots. Nothing
 * of a draw among every root.
 */
export function sampleRootsReportOf(roots: SampleRoots): Omit<WholeOrgSampleRoots, 'strata'> {
  return {
    ...(roots.window !== undefined ? { window: roots.window } : {}),
    ...(roots.notWindowed.length > 0 ? { notWindowed: [...roots.notWindowed] } : {}),
    ...(roots.where.length > 0 ? { where: roots.where.map((entry) => ({ ...entry })) } : {}),
  };
}
