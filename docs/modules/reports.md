# Reports

Execution reports and success rates from your Forge and Sync run history, an audit trail of every run that writes to an org, and the data lineage of the records each run carried. Reports reads what SandForge kept on this machine and writes nothing to an org.

<!-- how-to:start: written by scripts/sync-module-howto.mjs from howTo.reports in packages/webview/src/i18n/locales/en.json -->

## How to

1. On Executions, click a Forge or Sync run to read its details below the list.
2. Open Audit Trail to see every run that writes to an org, newest first.
3. Narrow the list with Filter by action, Filter by module or Filter by org.
4. Press View run on an entry to see on Data Lineage where its records came from.
5. Press Export CSV or Export JSON to save the trail as filtered.

**Tip:** Reports writes nothing to any org; Export CSV and Export JSON save every entry the filters match, not only those shown.

<!-- how-to:end -->
