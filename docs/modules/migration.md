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
