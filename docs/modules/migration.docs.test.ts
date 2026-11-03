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

  it('says the object comes from the query, and a filter with it', () => {
    // Positive control: the importer reads both from the query, where a real
    // export holds them.
    expect(SFDMU_IMPORTER).toContain('readSfdmuQuery(entry.query).object');
    expect(SFDMU_IMPORTER).toContain('where: whereOf(obj),');
    expect(SFDMU_IMPORTER).toContain(
      'if (entry.read.where !== undefined) return entry.read.where;',
    );

    expect(DOC).toContain('Its name comes from the FROM of its `query`, as in SFDMU');
    expect(DOC).toContain("the query's WHERE filter and ORDER BY are carried over");
    expect(DOC).toContain(
      'A `where` key, which SFDMU does not read, counts only for a query with no WHERE',
    );
  });

  it('says the deletes go first, the last listed first, as SFDMU runs them', () => {
    // Positive control: the configuration takes the entries in SFDMU's order.
    expect(SFDMU_IMPORTER).toContain('this.convert(inRunOrder(kept, keepOrder))');
    expect(SFDMU_IMPORTER).toContain('deletes(entry) ? [entry.set, 0, keepOrder ? at : -at]');

    expect(DOC).toContain('SFDMU deletes before it writes, the last object listed first');
    expect(DOC).toContain('under `keepObjectOrderWhileExecute`');
  });

  it('says a delete is shown on the Execute step before its run, and Run now opens it there', () => {
    const HOOK = source('packages/webview/src/pages/Sync/useSyncPageData.ts');
    const PAGE = source('packages/webview/src/pages/Sync/SyncPage.tsx');
    // Positive control: the execute step lists the opened configuration's
    // objects, holds Run until it has, and Run now opens one that deletes.
    expect(PAGE).toContain('{!busy && openedConfigEntries !== null && (');
    expect(PAGE).toContain('disabled={filesNeedSave || transformsNeedField || openedUnread}');
    expect(HOOK).toContain('if (!asked.simulate && deletes && openedConfig?.id !== asked.id) {');

    expect(DOC).toContain('**Open in Sync** says what each object does above **Run the sync**');
    expect(DOC).toContain('**Run now** opens such a configuration there rather than run it');
  });

  it('says a run neutralizes emails and phone numbers, and where the box that keeps them is', () => {
    const PAGE = source('packages/webview/src/pages/Migration/MigrationPage.tsx');
    const CONTACT_POINTS = source('packages/extension/src/modules/sync/syncContactPoints.ts');
    expect(CONTACT_POINTS).toContain(
      'return config.keepContactPoints === true ? undefined : new ContactPointNeutralizer();',
    );
    expect(PAGE).toContain('...(keepContactPoints ? { keepContactPoints: true } : {}),');

    expect(DOC).toContain('Emails and phone numbers, which SFDMU copies as read');
    expect(DOC).toContain(
      'Untick **Neutralize emails and phone numbers** under **Run it from Sync**',
    );
  });

  it('says a mapping is read under the flag SFDMU reads it under, the two files with it', () => {
    expect(SFDMU_IMPORTER).toContain(
      'fieldMapping: entry.useFieldMapping ? [...fieldItems, ...entry.fieldMapping] : [],',
    );
    expect(SFDMU_IMPORTER).toContain(
      "? files.valueRows.filter((row) => isItsRow(row) && row.value.trim() !== '')",
    );

    expect(DOC).toContain('With the flag off or absent SFDMU ignores them, and so does the import');
    expect(DOC).toContain('Under `useValuesMapping`, the rows of `ValueMapping.csv`');
  });

  it('lists what is not carried, each row of it one the importer says', () => {
    // Positive control: each note the table promises is one the importer emits.
    for (const code of [
      'excluded',
      'readonly',
      'noQuery',
      'unknownOperation',
      'deletesElsewhere',
      'mockAllFields',
      'duplicate',
      'delete',
      'updateKey',
      'defaultKey',
      'upsertKey',
      'unusableKey',
      'fieldMappingOff',
      'valueRows',
      'notMaster',
      'limit',
      'queryClause',
      'whereRefused',
      'deleteOldData',
      'mockFields',
      'settings',
      'contactPoints',
      'objectSets',
    ]) {
      expect(SFDMU_IMPORTER).toContain(`'${code}'`);
    }

    expect(DOC).toContain('## What the import does not carry');
    expect(DOC).toContain('`DeleteSource`, `DeleteHierarchy`');
    expect(DOC).toContain('the fields are left out of the write rather than copied');
    expect(DOC).toContain('A key the import does not know never fails it');
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
