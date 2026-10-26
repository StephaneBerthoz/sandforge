import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { envFileSchema } from '@sandforge/shared';
import {
  ENV_SCHEMA_FILE,
  ENV_SCHEMA_PATH,
  WRITE_COMMAND,
  envFileJsonSchema,
  envSchemaText,
  isEnvSchemaCurrent,
  main,
} from './write-env-schema.js';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

/** The schema as the VSIX ships it: what the editor reads, not what this run makes. */
const shipped = JSON.parse(readFileSync(ENV_SCHEMA_FILE, 'utf8')) as Record<string, unknown>;

/**
 * Whether `value` holds to `schema`, for the keywords `z.toJSONSchema` writes:
 * the same reading as the JSON Schema test of `env.schema.test.ts`, the file
 * checked here the way an editor would. A keyword it does not know fails the
 * check, rather than letting what it says go unread.
 */
function holdsTo(schema: Record<string, unknown>, value: unknown, at = '$'): string[] {
  const problems: string[] = [];
  const known = new Set([
    '$schema',
    'default',
    'type',
    'properties',
    'required',
    'additionalProperties',
    'propertyNames',
    'items',
    'minItems',
    'maxItems',
    'enum',
    'const',
    'pattern',
    'minLength',
    'maxLength',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'anyOf',
    'oneOf',
  ]);
  for (const keyword of Object.keys(schema)) {
    if (!known.has(keyword)) problems.push(`${at}: unread keyword ${keyword}`);
  }
  const type = schema['type'];
  const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'object' && !isObject) return [...problems, `${at}: not an object`];
  if (type === 'array' && !Array.isArray(value)) return [...problems, `${at}: not an array`];
  if (type === 'string' && typeof value !== 'string') return [...problems, `${at}: not a string`];
  if (type === 'number' && typeof value !== 'number') return [...problems, `${at}: not a number`];
  if (type === 'integer' && !Number.isInteger(value)) return [...problems, `${at}: not an integer`];
  if (type === 'boolean' && typeof value !== 'boolean')
    return [...problems, `${at}: not a boolean`];
  if ('const' in schema && schema['const'] !== value) problems.push(`${at}: not the constant`);
  if (Array.isArray(schema['enum']) && !schema['enum'].includes(value)) {
    problems.push(`${at}: not one of the values`);
  }
  if (typeof value === 'string') {
    if (typeof schema['pattern'] === 'string' && !new RegExp(schema['pattern']).test(value)) {
      problems.push(`${at}: does not match ${schema['pattern']}`);
    }
    if (typeof schema['minLength'] === 'number' && value.length < schema['minLength']) {
      problems.push(`${at}: too short`);
    }
    if (typeof schema['maxLength'] === 'number' && value.length > schema['maxLength']) {
      problems.push(`${at}: too long`);
    }
  }
  if (typeof value === 'number') {
    if (typeof schema['minimum'] === 'number' && value < schema['minimum']) {
      problems.push(`${at}: below the minimum`);
    }
    if (typeof schema['maximum'] === 'number' && value > schema['maximum']) {
      problems.push(`${at}: above the maximum`);
    }
    if (typeof schema['exclusiveMinimum'] === 'number' && value <= schema['exclusiveMinimum']) {
      problems.push(`${at}: not above the minimum`);
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema['minItems'] === 'number' && value.length < schema['minItems']) {
      problems.push(`${at}: too few items`);
    }
    if (typeof schema['maxItems'] === 'number' && value.length > schema['maxItems']) {
      problems.push(`${at}: too many items`);
    }
    const items = schema['items'] as Record<string, unknown> | undefined;
    if (items) value.forEach((item, i) => problems.push(...holdsTo(items, item, `${at}[${i}]`)));
  }
  if (isObject) {
    const object = value as Record<string, unknown>;
    const properties = (schema['properties'] ?? {}) as Record<string, Record<string, unknown>>;
    for (const name of (schema['required'] ?? []) as string[]) {
      if (!(name in object)) problems.push(`${at}: misses ${name}`);
    }
    const names = schema['propertyNames'] as Record<string, unknown> | undefined;
    const rest = schema['additionalProperties'];
    for (const [key, item] of Object.entries(object)) {
      if (names) problems.push(...holdsTo(names, key, `${at}{${key}}`));
      if (key in properties) problems.push(...holdsTo(properties[key] ?? {}, item, `${at}.${key}`));
      else if (rest === false) problems.push(`${at}: ${key} is not a property`);
      else if (rest !== undefined) {
        problems.push(...holdsTo(rest as Record<string, unknown>, item, `${at}.${key}`));
      }
    }
  }
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const options = schema[keyword] as Array<Record<string, unknown>> | undefined;
    if (!options) continue;
    const passing = options.filter((option) => holdsTo(option, value, at).length === 0).length;
    if (keyword === 'anyOf' ? passing === 0 : passing !== 1) {
      problems.push(`${at}: ${passing} of the ${keyword} options hold`);
    }
  }
  return problems;
}

/** The YAML blocks of the environments guide, parsed: whole files and fragments of one. */
function guideBlocks(): Array<Record<string, unknown>> {
  const guide = readFileSync(join(REPO_ROOT, 'docs', 'environments.md'), 'utf8').replace(
    /\r\n/g,
    '\n',
  );
  return [...guide.matchAll(/^```yaml\n([\s\S]*?)^```$/gm)].map(
    (match) => parse(match[1] ?? '') as Record<string, unknown>,
  );
}

/** A copy of `document` with `value` set at `path`. */
function withValue(document: unknown, path: ReadonlyArray<string | number>, value: unknown) {
  const copy = structuredClone(document) as Record<string | number, unknown>;
  let at: Record<string | number, unknown> = copy;
  path.slice(0, -1).forEach((step) => {
    at = at[step] as Record<string | number, unknown>;
  });
  at[path[path.length - 1] as string | number] = value;
  return copy;
}

describe('the schema file the extension ships', () => {
  it('is what envFileSchema gives today, so a change to the file schema shows in the editor', async () => {
    // A change to env.schema.ts that is not written again leaves the editor
    // checking files against the old shape: keys the script reads underlined,
    // keys it refuses passed.
    expect(await isEnvSchemaCurrent(), `${ENV_SCHEMA_PATH} is stale: run ${WRITE_COMMAND}`).toBe(
      true,
    );
    expect(readFileSync(ENV_SCHEMA_FILE, 'utf8')).toBe(await envSchemaText());
  });

  it('sits where the manifest’s yamlValidation points, and is the file schema itself', () => {
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, 'packages', 'extension', 'package.json'), 'utf8'),
    ) as { contributes: { yamlValidation?: Array<{ url: string }> } };

    expect(manifest.contributes.yamlValidation?.map((entry) => entry.url)).toEqual([
      `./${ENV_SCHEMA_PATH}`,
    ]);
    expect(shipped['required']).toEqual(['version', 'name', 'resources']);
    expect(shipped['additionalProperties']).toBe(false);
  });

  it('is draft 7, and says what the 2020-12 dialect zod writes by default says', () => {
    // Draft 7 is the dialect every YAML language server reads. Should zod come
    // to write a keyword whose meaning differs between the two (`$defs`,
    // `prefixItems`), this fails, and the choice is made again.
    const { $schema: draft7, ...said7 } = envFileJsonSchema('draft-7');
    const { $schema: draft2020, ...said2020 } = envFileJsonSchema('draft-2020-12');

    expect(draft7).toBe('http://json-schema.org/draft-07/schema#');
    expect(draft2020).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(said7).toEqual(said2020);
    expect(shipped['$schema']).toBe(draft7);
  });
});

describe('the script', () => {
  let dir: string;
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sandforge-env-schema-'));
    stdout = [];
    stderr = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds a file that differs stale, names the command, and writes it again', async () => {
    const file = join(dir, 'schemas', 'sandforge.schema.json');
    const older = JSON.parse(readFileSync(ENV_SCHEMA_FILE, 'utf8')) as {
      properties: Record<string, unknown>;
    };
    delete older.properties['checkpoint'];
    writeFileSync(join(dir, 'older.json'), JSON.stringify(older), 'utf8');

    expect(await isEnvSchemaCurrent(join(dir, 'older.json'))).toBe(false);
    expect(await main(['--check'], join(dir, 'older.json'))).toBe(1);
    expect(stderr.join('')).toContain(
      `is stale: it is not what envFileSchema gives. Run ${WRITE_COMMAND}`,
    );

    expect(await isEnvSchemaCurrent(file)).toBe(false);
    expect(await main([], file)).toBe(0);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(readFileSync(ENV_SCHEMA_FILE, 'utf8'));
    expect(await main(['--check'], file)).toBe(0);
  });

  it('refuses an argument it does not read, and writes nothing', async () => {
    const file = join(dir, 'sandforge.schema.json');

    expect(await main(['--fix'], file)).toBe(2);
    expect(stderr.join('')).toContain('unknown argument: --fix; only --check is read');
    expect(existsSync(file)).toBe(false);
  });
});

describe('a sandforge.yaml, checked as the editor checks it', () => {
  const blocks = guideBlocks();
  const files = blocks.filter((block) => 'version' in block);
  const [first] = files;

  it('accepts every example file of the environments guide, as validate does', () => {
    // Positive control: the guide's seed, frozen and mask examples, at least.
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const file of files) {
      expect(holdsTo(shipped, file), String(file['name'])).toEqual([]);
      expect(envFileSchema.safeParse(file).success, String(file['name'])).toBe(true);
    }
  });

  it('accepts each fragment of the guide set into its first example', () => {
    // The guide gives its forge resources and its checkpoint settings as
    // fragments of the first file: set in, each makes a file the editor passes.
    const fragments = blocks.filter((block) => !('version' in block));
    expect(fragments.length).toBeGreaterThanOrEqual(2);
    for (const fragment of fragments) {
      const file = {
        ...first,
        ...fragment,
        resources: {
          ...(first?.['resources'] as Record<string, unknown>),
          ...(fragment['resources'] as Record<string, unknown> | undefined),
        },
      };
      expect(holdsTo(shipped, file), Object.keys(fragment).join(', ')).toEqual([]);
    }
  });

  it('refuses a key it does not know wherever it stands, as validate refuses it', () => {
    const seedFile = files.find((file) => file['name'] === 'case-flow');
    const frozenFile = files.find((file) => file['name'] === 'claims-flow');
    const maskFile = files.find((file) => file['name'] === 'uat-masked');
    expect([seedFile, frozenFile, maskFile]).not.toContain(undefined);

    const misspelt = [
      withValue(seedFile, ['dry_run'], true),
      withValue(seedFile, ['targets', 'kind'], ['scratch']),
      withValue(seedFile, ['resources', 'accounts', 'depends_on'], []),
      withValue(seedFile, ['resources', 'accounts', 'objects', 0, 'cout'], 3),
      withValue(frozenFile, ['resources', 'claims', 'dataset', 'digests'], 'sha256:0'),
      withValue(maskFile, ['resources', 'customers', 'rule'], 'contact-points'),
      withValue(maskFile, ['masking', 'contact-points', 'rule'], []),
    ];
    for (const document of misspelt) {
      expect(holdsTo(shipped, document)).not.toEqual([]);
      expect(envFileSchema.safeParse(document).success).toBe(false);
    }
  });

  it('refuses a kind it does not have, and a resource without the key its kind needs', () => {
    const frozenFile = files.find((file) => file['name'] === 'claims-flow');
    const refused = [
      withValue(first, ['resources', 'accounts', 'kind'], 'maks'),
      withValue(frozenFile, ['resources', 'claims', 'dataset'], undefined),
      withValue(first, ['version'], 2),
      withValue(first, ['resources', 'Accounts'], { kind: 'seed', template: 't' }),
    ].map((document) => JSON.parse(JSON.stringify(document)) as unknown);

    for (const document of refused) {
      expect(holdsTo(shipped, document)).not.toEqual([]);
      expect(envFileSchema.safeParse(document).success).toBe(false);
    }
  });

  it('leaves to validate what the zod schema checks in code, beyond the shape', () => {
    // A seed resource names a template or its objects: a refinement, which no
    // JSON Schema keyword carries. The editor passes it, validate refuses it,
    // as the README says.
    const neither = JSON.parse(
      JSON.stringify(withValue(first, ['resources', 'accounts', 'objects'], undefined)),
    ) as unknown;

    expect(holdsTo(shipped, neither)).toEqual([]);
    expect(envFileSchema.safeParse(neither).error?.issues.map((issue) => issue.message)).toEqual([
      'A seed resource names a built-in template (template) or the objects it writes (objects): give one',
    ]);
  });
});
