# Reports

Execution reports and success rates from your Forge and Sync run history, an audit trail of every run that writes to an org, and the data lineage of the records each run carried. Reports reads what SandForge kept on this machine and writes nothing to an org.

Above its three tabs, Executions, Audit trail and Data lineage, four figures: the runs listed, their success rate, their average duration and the entries the audit trail holds. **See in Reports**, on Sync's History, opens it on Executions, where Sync's runs are listed beside Forge's; on Automation's History, it opens the Audit trail, where the writes of each step are recorded.

<!-- how-to:start: written by scripts/sync-module-howto.mjs from howTo.reports in packages/webview/src/i18n/locales/en.json -->

## How to

1. On Executions, click a Forge or Sync run to read its details below the list.
2. Open Audit trail to see every run that writes to an org, newest first.
3. Narrow the list with Filter by action, Filter by module or Filter by org.
4. Press View run on an entry to see on Data lineage where its records came from.
5. Press Export as CSV or Export as JSON to save the trail as filtered.

**Tip:** Reports writes nothing to any org; Export as CSV and Export as JSON save every entry the filters match, not only those shown.

<!-- how-to:end -->
