/**
 * Doc/code drift guard for the Migration module page.
 *
 * The page said what an SFDMU import changes in no org, and nothing of what
 * the configuration it makes then writes. One `fieldMapping` cut the write of
 * its object down to the mapped fields: an export renaming `BillingCity` onto
 * `ShippingCity` wrote ShippingCity alone and dropped every other field of
 * every record, unsaid. The page now says what a mapping, an exclusion and a
 * values mapping make a run write.
 *
 * Each test states the code it depends on, and fails first if that code moved.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

// Normalised: the assertions below are LF-anchored and miss on a CRLF checkout.
const DOC = readFileSync(resolve(HERE, 'migration.md'), 'utf8').replace(/\r\n/g, '\n');

function source(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

const SFDMU_IMPORTER = source('packages/extension/src/modules/migration/SfdmuImporter.ts');
const FIELD_MAPPING = source('packages/extension/src/modules/sync/FieldMapping.ts');
const SYNC_HANDLER = source('packages/extension/src/bridge/handlers/SyncOpsHandler.ts');

describe('docs/modules/migration.md', () => {
  it('says a fieldMapping renames its field and every other field is copied as read', () => {
    // Positive control: the importer makes each export mapping a rename, and
    // the mapped record keeps every field read but those taken or excluded.
    expect(SFDMU_IMPORTER).toContain(
      "const type: MappingType = m.sourceField === m.targetField ? 'direct' : 'rename';",
    );
    expect(SFDMU_IMPORTER).toContain('excludedFields: obj.excludedFields,');
    expect(FIELD_MAPPING).toContain(
      'Object.entries(read).filter(([field]) => !dropped.has(nameKey(field))),',
    );

    expect(DOC).toContain('A `fieldMapping` renames its field and that field alone');
    expect(DOC).toContain('a mapping does not narrow the write to the mapped fields');
    expect(DOC).toContain('`excludedFields` are not written, renamed or not');
  });

  it('says the fields read are the describe’s, not the export query’s field list', () => {
    // Positive control: the read names its fields from the source's describe.
    expect(SYNC_HANDLER).toContain(
      'const described = (await conn.describe(safeObj)).fields.map((field) => field.name);',
    );
    expect(SFDMU_IMPORTER).toContain('query: obj.query,');

    expect(DOC).toContain(
      "Sync reads every field the source org's describe lists, not the field list of the export's `query`",
    );
  });
});
