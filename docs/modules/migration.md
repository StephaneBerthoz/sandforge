# Migration

Import an existing SFDMU `export.json` into a Sync configuration. Importing reads the file and changes nothing in any org. Under **Run it from Sync**, pick the two orgs, then **Save as a Sync configuration** and **Open in Sync**: Sync's Execute step simulates it, runs it, and its results say what it created and can remove it. A CSV file of records is not a migration definition: Seed's **CSV Upload** loads its rows.

<!-- how-to:start: written by scripts/sync-module-howto.mjs from howTo.migration in packages/webview/src/i18n/locales/en.json -->

## How to

1. Press Browse… and pick your SFDMU export.json, or paste its absolute path in File path.
2. Press Import: SandForge reads the file and writes nothing to any org.
3. Under Object Set, check each object's operation, External ID, batch size and WHERE clause.
4. Pick the Source org and the Target org, name it, and press Save as a Sync configuration.
5. Press Open in Sync: Simulate checks it there, and Run the sync writes it.

**Tip:** A CSV file of records goes to Seed's CSV Upload, which loads its rows. Only Sync writes, once Production Guard has judged the run.

<!-- how-to:end -->

## What the import carries

- Each object of the export becomes an object of the Sync configuration, with its operation, External ID, WHERE filter and ORDER BY; a `Readonly` object is left out. Sync reads every field the source org's describe lists, not the field list of the export's `query`
- A `fieldMapping` renames its field and that field alone: the source field goes under the target's name, and every other field of the object is copied under its own name, as read. An export that maps `BillingCity` onto `ShippingCity` writes the billing city into ShippingCity and the account's other fields as the source holds them; a mapping does not narrow the write to the mapped fields
- A `targetObject` that sends an object to another object is refused, and nothing of the export is imported: Sync writes an object to the same object in the target org, so the import names each object, where the export sends it and its field mappings, as `Account → Lead (Name → Company)`, for you to take those entries or those objects out of the file. It is refused whether `useFieldMapping` is on or off. A `targetObject` that names the object itself changes nothing, and a `Readonly` object is left out before it counts
- `excludedFields` are not written, renamed or not
- A `valuesMapping` becomes a value mapping rule on its field, named as the target calls it when the export renames that field
