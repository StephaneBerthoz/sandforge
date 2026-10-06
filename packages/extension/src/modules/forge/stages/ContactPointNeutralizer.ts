/**
 * Contact point stage of the Forge execution pipeline.
 *
 * Every row a run writes has its email addresses and phone numbers made
 * unreachable before it goes, whether the run anonymizes or not, unless it is
 * told to keep them as the source holds them (`ExecuteOptions.keepContactPoints`).
 * Run into a client's sandbox, a clone met record-triggered flows that email
 * and text the contacts they are created for, and anonymization was off by
 * default: the copies were real people, reachable from the sandbox.
 *
 * - An email field's address goes in under `.invalid`, the top-level domain
 *   kept from ever resolving (RFC 2606): `jane@acme.com` becomes
 *   `jane@acme.com.invalid`, readable and never delivered, as Salesforce
 *   leaves the users' addresses of a refreshed sandbox. An address already
 *   there is left. One the field cannot hold with the suffix becomes a short
 *   address of its own under `example.invalid`.
 * - A phone field's number becomes a fictional one, in the mobile range the
 *   French regulator keeps for fiction (+33 6 39 98 XX XX), drawn as the
 *   Frozen dataset draws its numbers: the same number gives the same one
 *   throughout a run, so two records that shared it still share one.
 * - A text field whose API name gives it to either (`contactPointOf`) has
 *   each address in its value, or each run of seven digits or more, treated
 *   so, and the rest of the text left as it is: a text that holds neither is
 *   no contact point, whatever the field's name.
 *
 * Wired where a row is cleaned for its insert — `cleanNodeRecords` for the
 * rows of a node, the orphan parent's own cleaning for a parent copied from
 * outside the graph — so anonymization, when the run asks for it, works on
 * values already neutralized.
 */

import { randomBytes } from 'node:crypto';

import type {
  ForgeContactPointField,
  ForgeContactPointKind,
  ForgeContactPointsReport,
} from '@sandforge/shared';
import { contactPointOf } from '../../../core/precheck/PIIDetector.js';
import { DeterministicPseudonymizer } from '../../frozendataset/DeterministicPseudonymizer.js';
import type { FieldInfo } from '../ForgeExecutor.js';

/** The most characters an email field takes: 80, whatever the object. */
export const EMAIL_FIELD_LENGTH = 80;

/** The most characters a phone field takes: 40, whatever the object. */
const PHONE_FIELD_LENGTH = 40;

/** The top-level domain no address under it is ever delivered to. */
const INVALID_TLD = '.invalid';

/** An address that already ends under the domain kept from resolving. */
const ENDS_INVALID = /\.invalid$/i;

/**
 * An address within a text: a local part, `@`, and a domain of two labels or
 * more. A domain written with a trailing dot leaves the dot out.
 */
const ADDRESS_IN_TEXT = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/**
 * A phone number within a text: seven digits or more, `+` before them or not,
 * with up to two separators between two digits — `+33 (0)6 12 34 56 78`,
 * `06.12.34.56.78`, `555-0100 1234`. A run that starts in the middle of a
 * longer one of digits is no number of its own.
 */
const PHONE_IN_TEXT = /\+?(?<!\d)\d(?:[\s.()/-]{0,2}\d){6,}/g;

/**
 * Whether a number is already one of the range kept for fiction, written with
 * its country code — `+33`, `0033`, with `(0)` or not — or in the national
 * form.
 */
function isFictional(value: string): boolean {
  return /^(?:(?:00)?330?|0)63998\d{4}$/.test(value.replace(/\D/g, ''));
}

/** One field of an object that holds a contact point, as the run's rows hold it. */
export interface ContactPointField {
  /** The name the row holds it by: a field map's name for it, when it renames it. */
  readonly name: string;
  /** What it holds. */
  readonly kind: ForgeContactPointKind;
  /**
   * An email or a phone field, whose whole value is one address or one
   * number; otherwise a text that may hold some among other words.
   */
  readonly typed: boolean;
  /** The most characters it takes; absent, as many as a value needs. */
  readonly maxLength?: number;
}

/**
 * The fields of an object that hold a contact point, from its describe: the
 * email and phone fields, and the texts their API name gives to either.
 *
 * @param fields - The object's fields, with their type and length.
 * @param rename - Source to target field names, from the run's field map.
 */
export function contactPointFieldsOf(
  fields: readonly FieldInfo[],
  rename: Readonly<Record<string, string>> = {},
): ContactPointField[] {
  const found: ContactPointField[] = [];
  for (const field of fields) {
    const type = (field.type ?? '').toLowerCase();
    const kind = contactPointOf(field.name, type);
    if (!kind) continue;
    const typed = type === 'email' || type === 'phone';
    const fallback =
      type === 'email' ? EMAIL_FIELD_LENGTH : type === 'phone' ? PHONE_FIELD_LENGTH : 0;
    const length = field.length !== undefined && field.length > 0 ? field.length : fallback;
    found.push({
      name: rename[field.name] ?? field.name,
      kind,
      typed,
      ...(length > 0 ? { maxLength: length } : {}),
    });
  }
  return found;
}

/** What one row's neutralization does to an object's rows, field by field. */
export type RowNeutralizer = (row: Record<string, unknown>) => void;

/**
 * Neutralizes the contact points of the rows a run writes, and counts them per
 * object and field. One per run: its numbers are drawn with a key of its own,
 * so one run's fictional numbers say nothing of the next one's.
 */
export class ContactPointNeutralizer {
  private readonly pseudonymizer: DeterministicPseudonymizer;

  /** Per object, in the order the run wrote them, the fields neutralized and how many values. */
  private readonly counted = new Map<
    string,
    Map<string, { kind: ForgeContactPointKind; values: number }>
  >();

  /**
   * @param salt - The key the fictional numbers and the short addresses are
   *   drawn with. Omitted, a random one: the same number gives the same one
   *   throughout the run, and another one in the next run.
   */
  constructor(salt: string = randomBytes(32).toString('hex')) {
    this.pseudonymizer = new DeterministicPseudonymizer(salt);
  }

  /**
   * What neutralizes the rows of an object, changing each in place and
   * counting each value it changes; nothing when no field of the object holds
   * a contact point.
   *
   * @param fields - The object's source fields, with their type and length.
   * @param rename - Source to target field names: the rows hold a renamed
   *   field under its target's name.
   */
  forObject(
    objectApiName: string,
    fields: readonly FieldInfo[],
    rename: Readonly<Record<string, string>> = {},
  ): RowNeutralizer | undefined {
    const points = contactPointFieldsOf(fields, rename);
    if (points.length === 0) return undefined;
    return (row) => {
      for (const point of points) {
        const value = row[point.name];
        if (typeof value !== 'string') continue;
        const neutralized = this.neutralize(point, value);
        if (neutralized === value) continue;
        // Left out, the field goes in empty: what it held could not be written
        // unreachable within the field's length.
        if (neutralized === null) delete row[point.name];
        else row[point.name] = neutralized;
        this.count(objectApiName, point);
      }
    };
  }

  /**
   * An email field's address, made undeliverable: `.invalid` after it, or —
   * the field too short for that — a short address of its own under
   * `example.invalid`. An address already under `.invalid`, and an empty
   * value, come back as they are.
   *
   * @param maxLength - The most characters the field takes.
   * @returns The address to write, or null when none fits the field.
   */
  email(value: string, maxLength: number = EMAIL_FIELD_LENGTH): string | null {
    const address = value.trim();
    if (address === '' || ENDS_INVALID.test(address)) return value;
    const suffixed = `${address}${INVALID_TLD}`;
    if (suffixed.length <= maxLength) return suffixed;
    const short = this.shortAddress(address);
    return short.length <= maxLength ? short : null;
  }

  /**
   * A phone number, replaced by a fictional one drawn from it: with its
   * country code (`+3363998XXXX`), or in the national form (`063998XXXX`)
   * where the field is too short for that. A number already in the range, and
   * a value with no digit, come back as they are.
   *
   * @param maxLength - The most characters the field takes; absent, no bound.
   * @returns The number to write, or null when none fits the field.
   */
  phone(value: string, maxLength?: number): string | null {
    if (!/\d/.test(value) || isFictional(value)) return value;
    return this.fictional(value, maxLength);
  }

  /** What the run neutralized, for its summary. */
  report(): ForgeContactPointsReport {
    const fields: ForgeContactPointField[] = [];
    let values = 0;
    for (const [objectApiName, byField] of this.counted) {
      for (const [field, { kind, values: count }] of byField) {
        fields.push({ objectApiName, field, kind, values: count });
        values += count;
      }
    }
    return { neutralized: true, fields, values };
  }

  /** One value of a contact point field, neutralized; the same value when there was nothing to. */
  private neutralize(point: ContactPointField, value: string): string | null {
    if (point.typed) {
      return point.kind === 'email'
        ? this.email(value, point.maxLength)
        : this.phone(value, point.maxLength);
    }
    return point.kind === 'email'
      ? this.addressesIn(value, point.maxLength)
      : this.numbersIn(value, point.maxLength);
  }

  /**
   * A text with every address in it under `.invalid`; with short addresses of
   * their own when the field cannot hold the suffixes. A text with no address
   * comes back as it is.
   *
   * @param maxLength - The most characters the field takes; absent, no bound.
   * @returns The text to write, or null when no form of it fits the field.
   */
  addressesIn(text: string, maxLength?: number): string | null {
    const fits = (candidate: string): boolean =>
      maxLength === undefined || candidate.length <= maxLength;
    const suffixed = text.replace(ADDRESS_IN_TEXT, (address) =>
      ENDS_INVALID.test(address) ? address : `${address}${INVALID_TLD}`,
    );
    if (suffixed === text || fits(suffixed)) return suffixed;
    const shortened = text.replace(ADDRESS_IN_TEXT, (address) =>
      ENDS_INVALID.test(address) ? address : this.shortAddress(address),
    );
    return fits(shortened) ? shortened : null;
  }

  /**
   * A text with every number in it replaced by a fictional one; in the
   * national form when the field cannot hold them with their country code.
   */
  private numbersIn(text: string, maxLength: number | undefined): string | null {
    const fits = (candidate: string): boolean =>
      maxLength === undefined || candidate.length <= maxLength;
    const replaced = (national: boolean): string =>
      text.replace(PHONE_IN_TEXT, (run) => {
        if (isFictional(run)) return run;
        const drawn = this.drawnNumber(run);
        return national ? `0${drawn.slice(3)}` : drawn;
      });
    const international = replaced(false);
    if (international === text || fits(international)) return international;
    const national = replaced(true);
    return fits(national) ? national : null;
  }

  /** The fictional number drawn from `value`, in the first form the field holds. */
  private fictional(value: string, maxLength: number | undefined): string | null {
    const drawn = this.drawnNumber(value);
    if (maxLength === undefined || drawn.length <= maxLength) return drawn;
    const national = `0${drawn.slice(3)}`;
    return national.length <= maxLength ? national : null;
  }

  /** `+3363998XXXX`, the same for the same digits throughout the run. */
  private drawnNumber(value: string): string {
    return String(this.pseudonymizer.pseudonymize('phoneE164', value.replace(/[^\d+]/g, '')));
  }

  /** `user-XXXXXXXX@example.invalid`, the same for the same address throughout the run. */
  private shortAddress(address: string): string {
    return String(this.pseudonymizer.pseudonymize('email', address.toLowerCase()));
  }

  private count(objectApiName: string, point: ContactPointField): void {
    const byField =
      this.counted.get(objectApiName) ??
      new Map<string, { kind: ForgeContactPointKind; values: number }>();
    const known = byField.get(point.name) ?? { kind: point.kind, values: 0 };
    known.values += 1;
    byField.set(point.name, known);
    this.counted.set(objectApiName, byField);
  }
}
