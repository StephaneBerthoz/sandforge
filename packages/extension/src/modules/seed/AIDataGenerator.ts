import { DataRowsReplySchema, parseModelJson, type FieldRule } from '@sandforge/shared';

import {
  LOCALE_DATA,
  isReservedEmailDomain,
  isReservedPhone,
  localeOfPhone,
  reservedPhone,
} from './LocaleData';

/** Function signature for calling an AI model */
export type CallAIFn = (prompt: string) => Promise<string>;

/** Maximum number of records to request per AI call to avoid token limits */
const MAX_RECORDS_PER_CALL = 50;

/**
 * The locale of a number put in place of one whose country the model did not
 * write: the locale a seed generates in when nothing names one.
 */
const DEFAULT_PHONE_LOCALE = 'en_US';

/**
 * What the prompt asks of contact details. A model asked for realistic values
 * writes real-looking addresses and numbers, and some of them are somebody's:
 * a sandbox whose flows mail or text new records would reach that person. The
 * answer is held to the same rules afterwards (see {@link reachNobody}): the
 * prompt is a request the model may not honour.
 */
const CONTACT_RULES: readonly string[] = [
  'Contact details must reach nobody:',
  '- every email address uses example.com, example.net, example.org, or a domain ending in .example, .invalid or .test, such as jane.doe@acme.example;',
  `- every phone number takes one of these forms, X being any digit: ${Object.values(LOCALE_DATA)
    .map((locale) => locale.phoneFormats[0])
    .join(', ')}.`,
];

/**
 * Generates data records using an AI model.
 * Builds structured prompts from field rules and an optional persona,
 * then parses JSON array responses from the AI.
 */
export class AIDataGenerator {
  private readonly callAI: CallAIFn;

  constructor(callAI: CallAIFn) {
    this.callAI = callAI;
  }

  /**
   * Generate records by prompting the AI with field rules and persona context.
   * Splits large requests into batches to respect token limits. Every email
   * address and phone number of the answer reaches nobody: see
   * {@link reachNobody}.
   */
  async generate(
    fieldRules: FieldRule[],
    count: number,
    persona?: string,
  ): Promise<Record<string, unknown>[]> {
    if (count <= 0 || fieldRules.length === 0) {
      return [];
    }

    const results: Record<string, unknown>[] = [];
    let remaining = count;
    const phoneFields = new Set(
      fieldRules
        .filter((rule) => rule.fieldType?.toLowerCase() === 'phone')
        .map((rule) => rule.fieldApiName),
    );
    let replaced = 0;
    const replacement = (written: string): string =>
      reservedPhone(localeOfPhone(written) ?? DEFAULT_PHONE_LOCALE, replaced++);

    while (remaining > 0) {
      const batchSize = Math.min(remaining, MAX_RECORDS_PER_CALL);
      const prompt = buildPrompt(fieldRules, batchSize, persona);
      const response = await this.callAI(prompt);
      const parsed = parseAIResponse(response);
      results.push(...parsed.map((record) => reachNobody(record, phoneFields, replacement)));
      remaining -= batchSize;
    }

    return results.slice(0, count);
  }
}

/**
 * Build a structured prompt describing the fields and desired output format.
 * Includes persona context when provided.
 */
export function buildPrompt(fieldRules: FieldRule[], count: number, persona?: string): string {
  const fieldDescriptions = fieldRules.map((rule) => {
    const parts = [`- ${rule.fieldApiName} (${rule.ruleType})`];
    if (rule.config.aiPrompt) {
      parts.push(`: ${rule.config.aiPrompt}`);
    }
    if (rule.config.minValue !== undefined || rule.config.maxValue !== undefined) {
      parts.push(` [range: ${rule.config.minValue ?? ''}..${rule.config.maxValue ?? ''}]`);
    }
    if (rule.config.minLength !== undefined || rule.config.maxLength !== undefined) {
      parts.push(` [length: ${rule.config.minLength ?? ''}..${rule.config.maxLength ?? ''}]`);
    }
    return parts.join('');
  });

  const lines: string[] = [];

  if (persona) {
    lines.push(`Persona: ${persona}`);
    lines.push('');
  }

  lines.push(`Generate exactly ${count} JSON objects with these fields:`);
  lines.push(...fieldDescriptions);
  lines.push('');
  lines.push(...CONTACT_RULES);
  lines.push('');
  lines.push('Return ONLY a JSON array of objects. No markdown, no explanation.');

  return lines.join('\n');
}

/**
 * Parse the AI response string into an array of record objects.
 * Handles responses wrapped in markdown code blocks. An array keeps its
 * objects, a single object is one record, any other JSON value is none.
 * @throws Error when the reply is not JSON.
 */
export function parseAIResponse(response: string): Record<string, unknown>[] {
  return parseModelJson(DataRowsReplySchema, response);
}

/**
 * An email address inside any text: its local part, and its domain. The local
 * part starts where a run of the characters it may hold starts, so a long run
 * with no '@' in it is read once and not once per character.
 */
const EMAIL_ADDRESS =
  /(?<![\p{L}\p{N}._%+-])([\p{L}\p{N}._%+-]+)@((?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+\p{L}{2,63})(?![\p{L}\p{N}-])/gu;

/**
 * A field that holds a phone number by its name, without its `__c` or `__pc`
 * suffix: `Phone`, `MobilePhone`, `Fax`, `Telefono__c`, `Tel__c`.
 */
const PHONE_FIELD = /phone|mobile|fax|telef|^tel$/i;

/** A value made of nothing but a phone number's characters. */
const WHOLE_PHONE = /^\+?[\d ()./-]+$/;

/**
 * A number written to be dialled, inside free text: in international form
 * (+33 …), with an area code in brackets ((415) …), national with its leading
 * 0 (06 12 34 56 78), or in the North American 3-3-4 grouping. Its digit
 * groups are joined by one separator, or follow a bracket: the full stop
 * ending a sentence does not join the next one's figures to it, and no run of
 * digits can be split two ways, which would let a long one stall the match. A
 * run of digits written any other way — an amount, an IBAN, a SIRET — is left
 * as it is: turned into a phone number it would be corrupted for nothing. None
 * starts inside a word, an email address or a longer run of digit groups.
 */
const WRITTEN_PHONE =
  /(?<![\w+.@-])(?<!\d )(?:(?:\+\d+|\(\d{1,4}\)|0\d*)(?:[ ./-]?\(\d+\)|[ ./-]\d+|(?<=\))\d+)*|\d{3}[ .-]\d{3}[ .-]\d{4})(?![\w@])/g;

/** A date, which a national number's leading 0 and its separators would otherwise take for one. */
const DATE = /^\d{1,4}[./-]\d{1,2}[./-]\d{1,4}$/;

/**
 * Digits a phone number written in text has at least, and at most: fewer is a
 * short code or a fragment, more is longer than E.164 lets a number be.
 */
const PHONE_DIGITS = { least: 8, most: 15 } as const;

/**
 * The record with its contact details made to reach nobody: an email address
 * on a domain that is not reserved moves to one that is (`acme.com` becomes
 * `acme.example`), and a phone number nobody holds stays while any other is
 * replaced by `replacement`. A phone field — by its rule's type or by its name
 * — has its whole value checked; any other text has its addresses and the
 * numbers written in it checked.
 *
 * The prompt asks for the same, which a model does not always do: the answer
 * is the model's, and the check runs on every one.
 */
export function reachNobody(
  record: Record<string, unknown>,
  phoneFields: ReadonlySet<string>,
  replacement: (written: string) => string,
): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(record)) {
    safe[field] = reachNobodyIn(field, value, phoneFields, replacement);
  }
  return safe;
}

function reachNobodyIn(
  field: string,
  value: unknown,
  phoneFields: ReadonlySet<string>,
  replacement: (written: string) => string,
): unknown {
  const phoneField = phoneFields.has(field) || PHONE_FIELD.test(field.replace(/__p?c$/i, ''));
  // A model writes a number as a JSON number now and then.
  const written =
    typeof value === 'number' ? String(value) : typeof value === 'string' ? value : undefined;
  if (
    phoneField &&
    written !== undefined &&
    /\d/.test(written) &&
    WHOLE_PHONE.test(written.trim())
  ) {
    return isReservedPhone(written) ? value : replacement(written);
  }
  if (typeof value !== 'string') return value;
  return value
    .replace(EMAIL_ADDRESS, (address: string, local: string, domain: string) =>
      isReservedEmailDomain(domain) ? address : `${local}@${reservedDomainFor(domain)}`,
    )
    .replace(WRITTEN_PHONE, (number: string) =>
      isWrittenPhone(number) && !isReservedPhone(number) ? replacement(number) : number,
    );
}

/** Whether a match of {@link WRITTEN_PHONE} has a phone number's digits, and is not a date. */
function isWrittenPhone(number: string): boolean {
  const digits = number.replace(/\D/g, '').length;
  return digits >= PHONE_DIGITS.least && digits <= PHONE_DIGITS.most && !DATE.test(number);
}

/**
 * The domain with its top-level label replaced by the reserved `example`:
 * `acme.com` becomes `acme.example`, which keeps the name the model chose and
 * belongs to nobody.
 */
function reservedDomainFor(domain: string): string {
  return `${domain.split('.').slice(0, -1).join('.')}.example`;
}
