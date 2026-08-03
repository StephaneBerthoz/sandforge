/**
 * Deterministic pseudonymizer — the heart of the Frozen Reference Dataset
 * module (spec §3).
 *
 * Every generator derives its output from `HMAC-SHA256(salt,
 * "<generator>|<value>")`. The object and field carrying the value are
 * deliberately NOT part of the HMAC input: the same value therefore
 * produces the same pseudonym on any object/field, which is exactly what
 * makes cross-object joins (dedup, beneficiary search) behave like
 * production.
 *
 * The salt comes from the `SANDFORGE_FROZEN_SALT` environment variable
 * (or a secrets manager) — never from the repo. Only its SHA-256
 * fingerprint (12 hex chars) is consigned in the manifest. A second salt
 * must never be generated silently: cross-version determinism would be
 * lost.
 */

import { createHash, createHmac } from 'node:crypto';

/** Environment variable carrying the pseudonymization salt. */
export const FROZEN_SALT_ENV_VAR = 'SANDFORGE_FROZEN_SALT';

/** All generator names supported by {@link DeterministicPseudonymizer}. */
export const PSEUDONYM_GENERATORS = [
  'keep',
  'clear',
  'firstName',
  'lastName',
  'companyName',
  'phoneE164',
  'email',
  'registrationSIV',
  'contractNumber',
  'postalCodeGeneralize',
  'dateMonthStart',
  'dateShift',
  'geoRound1',
  'kmRound10',
] as const;

/** Union of supported generator names. */
export type PseudonymGenerator = (typeof PSEUDONYM_GENERATORS)[number];

/** Thrown when the engine is started without a salt. */
export class MissingSaltError extends Error {
  constructor() {
    super(
      `Pseudonymization salt is missing. Set the ${FROZEN_SALT_ENV_VAR} environment ` +
        `variable (e.g. export ${FROZEN_SALT_ENV_VAR}="<your-stable-secret>") and retry. ` +
        `Never invent a second salt: determinism across dataset versions would be lost.`,
    );
    this.name = 'MissingSaltError';
  }
}

/** Fictional first-name pool (output vocabulary — not client data). */
const FIRST_NAMES = [
  'Alix',
  'Camille',
  'Dominique',
  'Éloi',
  'Faustine',
  'Gabin',
  'Héloïse',
  'Ibrahim',
  'Jasmine',
  'Kylian',
  'Léa',
  'Mathis',
  'Nour',
  'Océane',
  'Paul',
  'Quitterie',
  'Rayan',
  'Salomé',
  'Théo',
  'Ursule',
  'Victor',
  'Wendy',
  'Xavier',
  'Yasmine',
  'Zacharie',
  'Ambre',
  'Bastien',
  'Chloé',
  'Dorian',
  'Emma',
  'Fabien',
  'Gabrielle',
  'Hugo',
  'Inès',
  'Jules',
  'Klara',
  'Louis',
  'Manon',
  'Noé',
  'Ophélie',
] as const;

/** Fictional last-name pool (output vocabulary — not client data). */
const LAST_NAMES = [
  'Arnaud',
  'Berthelot',
  'Chevallier',
  'Deschamps',
  'Etcheverry',
  'Fontaine',
  'Guibert',
  'Hamonic',
  'Imbert',
  'Jacquin',
  'Kermarrec',
  'Lefebvre',
  'Mignard',
  'Noirot',
  'Ollivier',
  'Perrin',
  'Quentin',
  'Rochefort',
  'Seguin',
  'Thibault',
  'Uberti',
  'Vasseur',
  'Wagner',
  'Xuereb',
  'Yverneau',
  'Zimmermann',
  'Aubry',
  'Barbier',
  'Charpentier',
  'Delattre',
  'Esnault',
  'Fournier',
  'Gosselin',
  'Hervieux',
  'Leloup',
  'Marchand',
  'Navarro',
  'Pasquier',
  'Renard',
  'Sauvage',
] as const;

/** Company-name building blocks. */
const COMPANY_CORES = [
  'Aster',
  'Boreal',
  'Cédrat',
  'Delta',
  'Ellipse',
  'Fulmen',
  'Granit',
  'Halcyon',
  'Isatis',
  'Jaspe',
  'Kelvin',
  'Lumen',
  'Méridien',
  'Noroit',
  'Obsidienne',
  'Pulsar',
] as const;

/** Company legal/activity suffixes. */
const COMPANY_SUFFIXES = [
  'Conseil',
  'Services',
  'Industries',
  'Solutions',
  'Groupe',
  'SAS',
  'Partenaires',
  'Logistique',
] as const;

/** SIV letter alphabet: A-Z without I, O, Q (never used in French SIV series). */
const SIV_LETTERS = 'ABCDEFGHJKLMNPRSTUVWXYZ';

const DATE_ONLY_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME_REGEX = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?Z$/;

const MS_PER_DAY = 86_400_000;

/**
 * HMAC-based deterministic pseudonymizer. One instance per freeze run;
 * construct via {@link DeterministicPseudonymizer.fromEnv} in production
 * code so the salt never appears in the repository.
 */
export class DeterministicPseudonymizer {
  private readonly salt: string;

  /**
   * @param salt - The pseudonymization salt. Must be non-empty; prefer
   *               {@link fromEnv} so the value comes from the environment.
   */
  constructor(salt: string) {
    if (!salt) {
      throw new MissingSaltError();
    }
    this.salt = salt;
  }

  /**
   * Build a pseudonymizer from the `SANDFORGE_FROZEN_SALT` environment
   * variable. Refuses to start without it (actionable error).
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): DeterministicPseudonymizer {
    const salt = env[FROZEN_SALT_ENV_VAR];
    if (!salt) {
      throw new MissingSaltError();
    }
    return new DeterministicPseudonymizer(salt);
  }

  /**
   * SHA-256 fingerprint of the salt (first 12 hex chars) — the only
   * salt-derived value allowed in the manifest.
   */
  get saltFingerprint(): string {
    return createHash('sha256').update(this.salt).digest('hex').slice(0, 12);
  }

  /**
   * Uniform date-shift offset in days, in [200, 400], derived from the
   * salt ONLY (not per value): the whole dataset shifts by the same
   * amount, which breaks absolute dating while preserving every duration.
   */
  get dateShiftDays(): number {
    const digest = createHash('sha256').update(`${this.salt}|dateShift-offset`).digest();
    return 200 + (digest.readUInt32BE(0) % 201);
  }

  /**
   * Pseudonymize a single value with the named generator.
   *
   * `null`/`undefined` pass through untouched: an absent field stays
   * absent and a null stays null (spec pitfall 6 — tree exports omit null
   * fields; absence must not be confused with emptiness).
   */
  pseudonymize(generator: PseudonymGenerator, value: unknown): unknown {
    if (value === null || value === undefined) {
      return value;
    }
    switch (generator) {
      case 'keep':
        return value;
      case 'clear':
        return '';
      case 'firstName':
        return this.pick(generator, String(value), FIRST_NAMES);
      case 'lastName':
        return this.pick(generator, String(value), LAST_NAMES);
      case 'companyName':
        return this.companyName(String(value));
      case 'phoneE164':
        return this.phoneE164(String(value));
      case 'email':
        return this.email(String(value));
      case 'registrationSIV':
        return this.registrationSIV(String(value));
      case 'contractNumber':
        return this.contractNumber(String(value));
      case 'postalCodeGeneralize':
        return this.postalCodeGeneralize(String(value));
      case 'dateMonthStart':
        return this.dateMonthStart(String(value));
      case 'dateShift':
        return this.dateShift(value);
      case 'geoRound1':
        return this.roundNumber(value, 1);
      case 'kmRound10':
        return this.roundTo(value, 10);
    }
  }

  /** Raw HMAC-SHA256 digest of `"<generator>|<value>"`. */
  private digest(generator: string, value: string): Buffer {
    return createHmac('sha256', this.salt).update(`${generator}|${value}`).digest();
  }

  /**
   * Deterministic byte stream for multi-symbol outputs. The first 32
   * bytes are the base digest; longer needs chain
   * `HMAC(salt, "<generator>|<value>|#<n>")` blocks.
   */
  private *bytes(generator: string, value: string): Generator<number> {
    let block = this.digest(generator, value);
    let counter = 0;
    for (;;) {
      for (const byte of block) {
        yield byte;
      }
      counter += 1;
      block = createHmac('sha256', this.salt).update(`${generator}|${value}|#${counter}`).digest();
    }
  }

  /** Pick one element of `list` via the base digest. */
  private pick<T>(generator: string, value: string, list: readonly T[]): T {
    const digest = this.digest(generator, value);
    return list[digest.readUInt32BE(0) % list.length];
  }

  private companyName(value: string): string {
    const digest = this.digest('companyName', value);
    const core = COMPANY_CORES[digest.readUInt32BE(0) % COMPANY_CORES.length];
    const suffix = COMPANY_SUFFIXES[digest.readUInt32BE(4) % COMPANY_SUFFIXES.length];
    return `${core} ${suffix}`;
  }

  /** Fictional ARCEP mobile range: +33 6 39 98 XX XX. */
  private phoneE164(value: string): string {
    const stream = this.bytes('phoneE164', value);
    let digits = '';
    for (let i = 0; i < 4; i++) {
      digits += String(stream.next().value % 10);
    }
    return `+3363998${digits}`;
  }

  private email(value: string): string {
    const digest = this.digest('email', value);
    return `user-${digest.subarray(0, 4).toString('hex')}@example.invalid`;
  }

  /** French SIV plate: two letters, three digits, two letters (AA-123-BB). */
  private registrationSIV(value: string): string {
    const stream = this.bytes('registrationSIV', value);
    const letter = (): string => SIV_LETTERS[stream.next().value % SIV_LETTERS.length];
    const digit = (): string => String(stream.next().value % 10);
    return `${letter()}${letter()}-${digit()}${digit()}${digit()}-${letter()}${letter()}`;
  }

  /** Shape-preserving: digit→digit, letter→letter (case kept), rest kept. */
  private contractNumber(value: string): string {
    const stream = this.bytes('contractNumber', value);
    let out = '';
    for (const ch of value) {
      if (ch >= '0' && ch <= '9') {
        out += String(stream.next().value % 10);
      } else if (ch >= 'A' && ch <= 'Z') {
        out += String.fromCharCode(65 + (stream.next().value % 26));
      } else if (ch >= 'a' && ch <= 'z') {
        out += String.fromCharCode(97 + (stream.next().value % 26));
      } else {
        out += ch;
      }
    }
    return out;
  }

  /**
   * First two digits kept, the rest zeroed AT LENGTH: '75012' → '75000',
   * and foreign 4-digit codes too: '8011' → '8000' (spec pitfall 4:
   * 4-digit foreign postcodes must not slip through a 5-digit-oriented
   * generalization). Non-numeric foreign postcodes keep their first two
   * characters and are shape-masked beyond that.
   */
  private postalCodeGeneralize(value: string): string {
    const s = value.trim();
    if (s.length <= 2) {
      return s;
    }
    if (/^\d+$/.test(s)) {
      return s.slice(0, 2) + '0'.repeat(s.length - 2);
    }
    let out = s.slice(0, 2);
    for (const ch of s.slice(2)) {
      if (ch >= '0' && ch <= '9') {
        out += '0';
      } else if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')) {
        out += 'X';
      } else {
        out += ch;
      }
    }
    return out;
  }

  /** Birthdate generalization: keep year and month, snap the day to the 1st. */
  private dateMonthStart(value: string): string {
    const match = DATE_ONLY_REGEX.exec(value) ?? ISO_DATETIME_REGEX.exec(value);
    if (!match) {
      // Unparseable date under a date rule: never leak — clear.
      return '';
    }
    return `${match[1]}-${match[2]}-01`;
  }

  /**
   * Uniform shift of the whole dataset by `dateShiftDays` BACKWARD.
   * Date-only values stay date-only; ISO datetimes shift as instants
   * (time-of-day preserved). Durations are preserved because the offset
   * is identical for every value of every field.
   */
  private dateShift(value: unknown): unknown {
    if (typeof value === 'string' && DATE_ONLY_REGEX.test(value)) {
      const shifted = new Date(Date.parse(`${value}T00:00:00Z`) - this.dateShiftDays * MS_PER_DAY);
      return shifted.toISOString().slice(0, 10);
    }
    if (typeof value === 'string' && ISO_DATETIME_REGEX.test(value)) {
      const shifted = new Date(Date.parse(value) - this.dateShiftDays * MS_PER_DAY);
      return shifted.toISOString();
    }
    // Unparseable date under a date rule: never leak — clear.
    return '';
  }

  /** Round a coordinate to 1 decimal place (~11 km grid). */
  private roundNumber(value: unknown, decimals: number): unknown {
    const num = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(num)) {
      return '';
    }
    const factor = 10 ** decimals;
    const rounded = Math.round(num * factor) / factor;
    return typeof value === 'number' ? rounded : String(rounded);
  }

  /** Round a counter (e.g. vehicle mileage) to the nearest `step`. */
  private roundTo(value: unknown, step: number): unknown {
    const num = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(num)) {
      return '';
    }
    const rounded = Math.round(num / step) * step;
    return typeof value === 'number' ? rounded : String(rounded);
  }
}
