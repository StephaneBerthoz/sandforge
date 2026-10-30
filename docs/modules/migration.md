# Migration

Import an existing SFDMU `export.json`, or a CSV or JSON file, into a Sync configuration. Importing reads the file and changes nothing in any org; running the configuration it makes, from Sync, writes records to the target org.

<!-- how-to:start: written by scripts/sync-module-howto.mjs from howTo.migration in packages/webview/src/i18n/locales/en.json -->

## How to

1. Pick the kind of file you have: SFDMU export.json, or CSV or JSON file.
2. Type the file's absolute path in File path, then press Import.
3. Under Object Set, check each object's operation, External ID and WHERE clause.
4. Under Run this import, pick the Source org and the Target org, then press Run sync.
5. To run it again later, name it and press Save as a Sync configuration.

**Tip:** Import writes nothing to any org; only Run sync writes, to the Target org, once Production Guard has judged the run.

<!-- how-to:end -->
