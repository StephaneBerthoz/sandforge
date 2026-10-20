import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  FORGE_GUIDE_URL,
  cataloguedErrorCodes,
  translateError,
  type ErrorHint,
} from '@sandforge/shared';
import en from './locales/en.json';
import fr from './locales/fr.json';
import de from './locales/de.json';
import es from './locales/es.json';
import ja from './locales/ja.json';
import ptBR from './locales/pt-BR.json';

/*
 * Every page renders `t(explanationKey)` and `t(actionKey)` with no default:
 * a key missing from a locale shows up as the raw `errors.…` path where the
 * hint should be.
 */

const LOCALES: Record<string, unknown> = { en, fr, de, es, ja, 'pt-BR': ptBR };

/** The catalogue's source, whose written keys every sample below must reach. */
function catalogueSource(): string {
  const path = [
    resolve(process.cwd(), '..', 'shared', 'src', 'utils', 'error-hints.ts'),
    resolve(process.cwd(), 'packages', 'shared', 'src', 'utils', 'error-hints.ts'),
  ].find((candidate) => existsSync(candidate));
  if (!path) throw new Error(`error-hints.ts not found from ${process.cwd()}`);
  return readFileSync(path, 'utf8');
}

/** Walk a dotted key through a locale object. */
const lookup = (bundle: unknown, key: string): unknown =>
  key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node !== null && typeof node === 'object'
          ? (node as Record<string, unknown>)[part]
          : undefined,
      bundle,
    );

/** The `{{name}}` placeholders a value interpolates. */
const placeholders = (value: unknown): string[] =>
  typeof value === 'string' ? [...value.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]) : [];

/** Messages that reach the wordings a code alone does not: variants, Forge's notes. */
const MESSAGE_SAMPLES: readonly string[] = [
  "INVALID_CROSS_REFERENCE_KEY: Record Type ID: this ID value isn't valid for the user",
  'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: entity type cannot be inserted: Case History',
  "Cycle FK 'PrimaryContactId' could not be resolved — referenced parent (source 003ABC123) was not cloned",
  "Cycle FK 'ParentId' could not be resolved",
  'no parent in cache and not the root',
  'Written with the lookup empty: the InsurancePolicy record it points at is not in the clone.',
  'Object is not in the target org, or the user the run writes as cannot see it: none of its records can be written there',
  'Object is not createable on target org',
];

/** Forge's refusals of a run, by their code. */
const FORGE_REFUSAL_CODES: readonly string[] = [
  'GUARD_BLOCKED',
  'GUARD_DECLINED',
  'NOT_INITIALIZED',
  'FORGE_RUNNING',
  'DUPLICATE',
  'RETRY_UNAVAILABLE',
  'RESUME_UNAVAILABLE',
  'RESUME_TARGET_CHANGED',
  'RESUME_CHANGED',
  'RESUME_UNCERTAIN',
  'FILES_NOT_ACCEPTED',
  'ABORTED_BEFORE_START',
];

/** Every hint the catalogue can give, in each module's wording. */
const hints: ErrorHint[] = [];
for (const module of [undefined, 'forge', 'seed'] as const) {
  for (const code of cataloguedErrorCodes()) {
    const hint = translateError(`${code}: some detail`, { module });
    if (!hint) throw new Error(`no hint for ${code}`);
    hints.push(hint);
  }
  for (const raw of MESSAGE_SAMPLES) {
    const hint = translateError(raw, { module });
    if (!hint) throw new Error(`no hint for ${raw}`);
    hints.push(hint);
  }
}
for (const code of FORGE_REFUSAL_CODES) {
  const hint = translateError('Nothing was written.', { code, module: 'forge' });
  if (!hint) throw new Error(`no hint for ${code}`);
  hints.push(hint);
}

const keys = [
  ...new Set(
    hints.flatMap((hint) =>
      [hint.explanationKey, hint.actionKey].filter((key): key is string => key !== undefined),
    ),
  ),
].sort();

describe('the error catalogue’s keys', () => {
  it('samples every key the catalogue writes', () => {
    const written = new Set(
      [...catalogueSource().matchAll(/'(errors\.[\w.]+\.(?:explanation|action))'/g)].map(
        (m) => m[1],
      ),
    );
    // Positive control: the walk reads the catalogue.
    expect(written.size).toBeGreaterThan(100);
    expect(keys).toEqual([...written].sort());
  });

  for (const [locale, bundle] of Object.entries(LOCALES)) {
    it(`resolves every key, and both link labels, to text in ${locale}`, () => {
      const missing = [...keys, 'errors.guideLink', 'errors.searchLink'].filter((key) => {
        const value = lookup(bundle, key);
        return typeof value !== 'string' || value.trim() === '';
      });
      expect(missing).toEqual([]);
    });
  }

  it('interpolates, in every locale, exactly the variables the catalogue passes', () => {
    for (const hint of hints) {
      const expected = Object.keys(hint.vars ?? {}).sort();
      for (const [locale, bundle] of Object.entries(LOCALES)) {
        for (const key of [hint.explanationKey, hint.actionKey]) {
          if (key === undefined) continue;
          const used = placeholders(lookup(bundle, key));
          for (const name of used) {
            expect({ locale, key, name, passed: expected.includes(name) }).toEqual({
              locale,
              key,
              name,
              passed: true,
            });
          }
        }
        const both = [
          ...new Set([
            ...placeholders(lookup(bundle, hint.explanationKey ?? '')),
            ...placeholders(lookup(bundle, hint.actionKey ?? '')),
          ]),
        ].sort();
        expect({ locale, code: hint.code, both }).toEqual({
          locale,
          code: hint.code,
          both: expected,
        });
      }
    }
  });

  /*
   * The org's line is shown right above every hint. Forge's wordings of a
   * missing required field and of a value too long, and the shared wording of
   * an integrity rule, interpolated it and said it a second time under itself.
   */
  it('says the org’s line again in no wording, in no locale', () => {
    expect(
      hints.filter((hint) => hint.vars?.detail !== undefined).map((hint) => hint.code),
    ).toEqual([]);
    for (const [locale, bundle] of Object.entries(LOCALES)) {
      const repeating = keys.filter((key) => placeholders(lookup(bundle, key)).includes('detail'));
      expect({ locale, repeating }).toEqual({ locale, repeating: [] });
    }
  });

  it('names the code in both link labels, in every locale', () => {
    for (const [locale, bundle] of Object.entries(LOCALES)) {
      for (const key of ['errors.guideLink', 'errors.searchLink']) {
        expect({ locale, key, used: placeholders(lookup(bundle, key)) }).toEqual({
          locale,
          key,
          used: ['code'],
        });
      }
    }
  });
});

describe('what the hints say, in English', () => {
  const errors = en.errors;

  it('explains a restricted picklist refusal in Forge with what the clone does about it', () => {
    expect(errors.invalidPicklist.forge.explanation).toContain(
      'one never given values of a field takes none of them',
    );
    expect(errors.invalidPicklist.forge.explanation).toContain(
      'the clone writes the record again without that field; a record listed here could not be written that way',
    );
  });

  it("says the target's automation failed, not that the object should be left out", () => {
    expect(errors.automationRefused.forge.explanation).toContain('a trigger, a Flow or a process');
    expect(errors.automationRefused.forge.action).not.toContain('Leave this object out');
    expect(errors.automationRefused.action).not.toContain('Leave this object out');
  });

  it('says a lookup left empty outside the clone is a note: nothing failed', () => {
    expect(errors.lookupOutsideClone.explanation).toContain('nothing failed');
  });

  it('says a lookup the second pass could not fill in is filled in by a retry, not a deeper clone', () => {
    expect(errors.cycleFkUnresolved.explanation).toContain(
      'points to a record this run did not write',
    );
    expect(errors.cycleFkUnresolved.action).toContain(
      'retry the failed objects: the retry writes it and fills in this link',
    );
    expect(errors.cycleFkUnresolved.action).not.toContain('Raise the depth');
  });

  it('tells a duplicate rule that blocks apart from a unique value the org already holds', () => {
    expect(errors.duplicateRule.forge.explanation).toContain('set to Block');
    expect(errors.duplicateRule.forge.action).not.toContain('--upsert');
    expect(errors.duplicateRule.explanation).toContain('set to Block');
  });

  it('says a failed Flow may be a Send Email action the sandbox cannot send, and warns off opening every email', () => {
    const { explanation, action } = errors.flowFailed.forge;
    expect(explanation).toContain('No access');
    expect(explanation).toContain('email template or logs the email');
    expect(explanation).toContain('System email only');
    expect(action).toContain('Deactivate that Flow');
    expect(action).toContain('the people on the cloned records');
    expect(errors.flowFailed.action).toContain('the people on the records');
  });

  it('sends an expired session to the Reconnect button the org card carries, not to a terminal', () => {
    expect(errors.sessionExpired.explanation).toContain('expired');
    expect(errors.sessionExpired.action).toContain(en.nav.orgs);
    expect(errors.sessionExpired.action).toContain(en.monitor.tryReconnect);
    expect(errors.sessionExpired.action).not.toMatch(/\bsf\b|CLI/);
  });

  it('says a lock is transient, and that retrying is the way through', () => {
    expect(errors.rowLocked.forge.explanation).toContain('transient');
    expect(errors.rowLocked.forge.action).toMatch(/^Retry the failed objects/);
    expect(errors.rowLocked.explanation).toContain('transient');
  });

  it('names the inactive user as one of the target, since every record the clone creates is its running user', () => {
    expect(errors.inactiveUser.forge.explanation).toContain(
      'The clone leaves each record it creates to the user it writes as',
    );
  });

  /*
   * Forge's hints told a VS Code user to run the clone again from the command
   * line with --owner-map, --exclude or --map, where Review's Controls tab
   * offers the same decision in a click; and to "exclude the RecordTypeId
   * field" without saying where.
   */
  it('sends a Forge user to Review’s tabs for what the panel can do, never to a command-line flag', () => {
    const gaps = `Review → ${en.forge.review.gapsTab}`;
    expect(errors.inactiveUser.forge.action).toContain(`Review → ${en.forge.review.controlsTab}`);
    expect(errors.inactiveUser.forge.action).toContain(en.forge.controls.owners.legend);
    expect(errors.inactiveUser.forge.action).not.toContain('--owner-map');
    expect(errors.inactiveUser.forge.explanation).not.toContain('command line');
    expect(errors.malformedId.forge.action).toContain(`Review → ${en.forge.review.controlsTab}`);
    expect(errors.malformedId.forge.action).not.toMatch(/--exclude|--map/);
    expect(errors.recordTypeHeldBack.forge.action).toContain(gaps);
    expect(errors.recordTypeHeldBack.forge.action).toContain(
      `Review → ${en.forge.review.controlsTab}`,
    );
    expect(errors.recordTypeUnavailable.forge.action).toContain(
      `Review → ${en.forge.review.controlsTab}`,
    );
  });

  it('leads a duplicate value in Forge with removing the earlier run, and keeps --upsert as a command-line line', () => {
    const action = errors.duplicateValue.forge.action;
    expect(action.startsWith('Remove what the earlier run created')).toBe(true);
    expect(action).toContain(en.forge.history.remove);
    expect(action).toContain('From the command line, --upsert');
  });

  it('carries the CLI flags in no locale’s Forge hints but the one --upsert line the panel has no equal of', () => {
    for (const [locale, bundle] of Object.entries(LOCALES)) {
      for (const slug of [
        'inactiveUser',
        'malformedId',
        'recordTypeHeldBack',
        'recordTypeUnavailable',
      ]) {
        const action = lookup(bundle, `errors.${slug}.forge.action`) as string;
        expect({ locale, slug, flag: /--owner-map|--exclude|--map\b/.test(action) }).toEqual({
          locale,
          slug,
          flag: false,
        });
      }
    }
  });
});

/** A file of the repository, read from the package or from the repository root. */
function repositoryFile(...parts: string[]): string {
  const path = [
    resolve(process.cwd(), ...parts),
    resolve(process.cwd(), '..', '..', ...parts),
  ].find((candidate) => existsSync(candidate));
  if (!path) throw new Error(`${parts.join('/')} not found from ${process.cwd()}`);
  return readFileSync(path, 'utf8');
}

describe('the way from a Forge hint to the Forge guide', () => {
  /** One message per code of the guide's table of common errors. */
  const SAMPLES: readonly string[] = [
    'INVALID_SESSION_ID: Session expired or invalid',
    'DUPLICATE_VALUE: duplicate value found: ExternalId__c',
    'INVALID_CROSS_REFERENCE_KEY: Owner ID: cannot be blank',
    'REQUIRED_FIELD_MISSING: Required fields are missing: [AccountId]',
    'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: bad value for restricted picklist field: X',
    'FIELD_CUSTOM_VALIDATION_EXCEPTION: Enter the phone in international format [Phone]',
    'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: entity type cannot be inserted: Case History',
    'FIELD_INTEGRITY_EXCEPTION: Every asset needs an account, a contact, or both.',
    'FIELD_FILTER_VALIDATION_EXCEPTION: Value does not exist or does not match filter criteria. [AccountId]',
    'DUPLICATES_DETECTED: Use one of these records?',
    'INACTIVE_OWNER_OR_USER: operation performed with inactive user',
    'ENTITY_IS_DELETED: entity is deleted [ParentId]',
    'UNABLE_TO_LOCK_ROW: unable to obtain exclusive access to this record',
    'REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.',
    'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY: insufficient access rights on cross-reference id',
    'NUMBER_OUTSIDE_VALID_RANGE: value outside of valid range on numeric field: 123456',
    'MALFORMED_ID: Region: id value of incorrect type: North [Region__c]',
    'CANNOT_EXECUTE_FLOW_TRIGGER: We can’t save this record because the process failed.',
  ];

  /** The anchors of the rows of the guide's table of common errors. */
  const guideAnchors = (): string[] => {
    const guide = repositoryFile('docs', 'forge-quickstart.md');
    const table = guide.split('## Common errors and what they mean')[1]?.split('\n## ')[0] ?? '';
    return [...table.matchAll(/<a name="([^"]+)"><\/a>/g)].map((m) => m[1]);
  };

  it('links each Forge hint whose code the table lists to that row, and every row has one', () => {
    const anchors = guideAnchors();
    // Positive control: the walk reads the table's anchors.
    expect(anchors.length).toBeGreaterThanOrEqual(17);
    const linked = new Set<string>();
    for (const raw of SAMPLES) {
      const hint = translateError(raw, { module: 'forge' });
      expect({ raw, kind: hint?.docKind }).toEqual({ raw, kind: 'guide' });
      const [base, anchor] = (hint?.docUrl as string).split('#');
      expect(base).toBe(FORGE_GUIDE_URL);
      expect(anchors).toContain(anchor);
      linked.add(anchor);
    }
    expect([...linked].sort()).toEqual([...new Set(anchors)].sort());
  });

  it('gives each row an anchor of its own', () => {
    const anchors = guideAnchors();
    expect(anchors).toHaveLength(new Set(anchors).size);
  });

  it('links the guide at the address the Marketplace README gives it, which the public-links check fetches', () => {
    const readme = repositoryFile('packages', 'extension', 'README.md');
    expect(readme).toContain(`](${FORGE_GUIDE_URL})`);
  });
});
