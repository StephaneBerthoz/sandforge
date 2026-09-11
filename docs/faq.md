# FAQ and Troubleshooting

---

## Frequently Asked Questions

### What Salesforce editions are supported?

SandForge works with any Salesforce edition that exposes the REST, Bulk 2.0, and Metadata APIs. This includes Developer Edition, Enterprise, Unlimited, and Performance editions. Developer Edition (free) is sufficient for testing and evaluation.

### Do I need a paid Salesforce org?

No. A free Developer Edition org works for all SandForge features. Scratch orgs created with Salesforce CLI also work. The main constraint is API limits, which are lower on Developer Edition.

### Does SandForge modify production data?

SandForge includes a **Production Guard** with three safety tiers. Operations targeting a Production org require double confirmation, and DELETE operations are blocked by default. Each safety-check decision is recorded in an in-memory log capped at 1000 entries with FIFO eviction (`sandforge.safety.auditLogging`): it lives for the session only, is never written to disk, and no screen reads it back yet. You can configure these protections in `sandforge.safety.requireProdConfirmation`.

That said, SandForge is designed primarily for sandbox and scratch org workflows. We recommend always targeting sandboxes for data seeding and sync operations.

### How does AI data generation work? Which LLMs are supported?

AI features use an external LLM provider to generate context-aware, realistic data values. SandForge currently supports **Anthropic** (Claude models) via API key; additional providers are planned.

Enter your API key in the AI tab of the SandForge Settings page. The key is stored in VSCode SecretStorage, never in settings files. AI features are optional -- SandForge works fully without them using Faker profiles and templates.

### Can I use SandForge without AI features?

Yes. AI is entirely optional. Seed uses 30+ locale-aware Faker generators by default for names, addresses, emails, phones, and more. Template-based seeding and CSV import work without any AI provider. Disable AI in settings with `sandforge.ai.enabled: false`.

### Is my data sent to external services?

Only to Anthropic, and nothing before you turn AI on and store an Anthropic key: the OpenAI and custom providers listed in settings are not implemented and send nothing. From then on, the chat sends your conversation, NL2SOQL sends your question with the names and labels of the org's objects, a pipeline draft sends your description, a custom persona sends its description, and an AI field rule in Seed, whether you picked it or a built-in persona set it, sends the field's API name and any instruction typed for it. Every failed Seed, Sync, DataOps or Automation run also sends its error message automatically, for a fix suggestion; Salesforce error messages can quote record values. Compare's schema advice and Monitor's anomaly scan send nothing. Telemetry is off by default and, turned on, only writes error reports to a local log.

### How do I update SandForge?

VSCode auto-updates extensions from the Marketplace. For manual updates, go to Extensions (`Ctrl+Shift+X`), find SandForge, and click Update. If you installed from a `.vsix` file, download the latest version and reinstall.

### What is the difference between Seed and Sync?

**Seed** generates or imports data into a target org using three modes: AI Generate (from scratch using AI/Faker/templates), CSV Upload (from a CSV file), or Clone from Org (copy records from another org). **Sync** copies existing data between two orgs with field mapping, transforms, and conflict resolution. Use Seed to populate empty sandboxes; use Sync to keep sandboxes in sync with each other or with production.

### How do I import data from a CSV file?

Navigate to **Seed**, select **CSV Upload** from the mode selector, choose your target org and object, then drag-and-drop your CSV file. SandForge auto-maps CSV column headers to Salesforce fields using case-insensitive, underscore-tolerant matching. You can override any mapping manually. The validator checks for type mismatches, missing required fields, length violations, invalid picklist values, and duplicate external IDs before execution. Supported format: UTF-8 CSV with headers (BOM is stripped automatically).

### How do I clone records from another org?

Navigate to **Seed**, select **Clone from Org** from the mode selector, choose the source org (where records come from) and verify the target org (where records will be inserted). Select the objects to clone and optionally add SOQL WHERE filters per object. SandForge fetches records using cursor-based pagination, resolves relationships in topological order, and remaps IDs during insert. The results include an ID mapping table (source ID to new ID) that you can export as CSV.

### Can I clone self-referential objects (e.g., Account.ParentId)?

Yes. SandForge detects self-referential relationships and uses a two-pass insert: the first pass inserts records without self-references, the second pass updates self-referential fields with the remapped IDs. Circular dependencies between different objects are detected and reported as errors.

### Can I automate recurring operations?

Partly. The **Automation** module provides a visual pipeline builder where you compose and save pipelines from 15 step types (seed, sync, backup, restore, anonymize, delete, compare, precheck, script, notification, approval, delay, condition, loop, parallel) and start them by hand. Of those, only `delay` and `condition` act on anything today: the other thirteen report success without touching your org, so a run sequences and reports its steps rather than executing them. Scheduled and event-driven triggers (cron, webhook, file watch, record change) are not wired yet — see the [Automation guide](modules/automation.md).

### Does SandForge support Salesforce DX and scratch orgs?

Yes. SandForge uses Salesforce CLI (`sf`) for authentication and supports all org types that `sf` can authenticate: scratch orgs, sandboxes, Developer Edition, and production. Import your CLI-authenticated orgs using the SFDX Import auth method in the Org Manager.

---

## Troubleshooting

### Extension not activating

**Symptoms:** SandForge icon does not appear in the Activity Bar, or the WebView panel is blank.

**Solutions:**

1. Verify VSCode version is 1.95 or later (`Help > About`)
2. Run `Developer: Reload Window` from the Command Palette (`Ctrl+Shift+P`)
3. Check the Output panel (`View > Output`) and select "SandForge" from the dropdown for error messages
4. If installed from `.vsix`, reinstall using `Extensions: Install from VSIX...`

### Cannot connect to org

**Symptoms:** The Org Manager shows no orgs, or connection fails with an authentication error.

**Solutions:**

1. Verify your Salesforce CLI is authenticated: `sf org list` should show your org
2. Re-authenticate if needed: `sf org login web --alias my-sandbox`
3. For SFDX Import: make sure the CLI session is not expired. Run `sf org open --target-org my-sandbox` to refresh.
4. For Username/Password auth: verify your security token is correct (check your email for the token from Salesforce)
5. Check that your org is accessible (not locked or deactivated)

### Bulk operations failing

**Symptoms:** Seed or Sync operations fail partway through, or show high failure counts in results.

**Solutions:**

1. Check API limits via Monitor -- you may be hitting the daily API call limit
2. Reduce the batch size in the Configure step (default is 200; try 50 or 100)
3. Check field-level security: the connected user may not have CREATE or UPDATE permission on certain fields
4. For reference fields (lookups), make sure parent records exist before inserting child records
5. Review per-object error messages in the Results step for specific Salesforce error codes

### Slow performance

**Symptoms:** Operations take much longer than expected, UI feels sluggish.

**Solutions:**

1. Check the Monitor dashboard for current API usage -- high consumption slows API responses
2. Reduce concurrent operations if multiple are running simultaneously
3. Split very large loads into several smaller runs — SandForge executes a run sequentially, so splitting is what actually shortens it. (Grappe, when enabled, reports progress per partition; it does not run the partitions concurrently.)
4. Org tier matters: Developer sandboxes have lower API limits than Full sandboxes
5. Close unused VSCode extension panels to free memory

### SOQL query errors

**Symptoms:** NL2SOQL generates an invalid query, or manual SOQL queries fail.

**Solutions:**

1. Check field-level security -- the query may reference fields the connected user cannot access
2. Verify object and field API names are correct (use the schema browser in Seed Step 1)
3. Use the NL2SOQL helper for assistance -- it validates queries against the org schema
4. For relationship queries, ensure the relationship name (not the field name) is used
5. Check the error message for specific SOQL syntax issues

### WebView blank or white

**Symptoms:** The SandForge panel opens but shows a blank white screen.

**Solutions:**

1. Run `Developer: Reload Window` from the Command Palette
2. Check the Developer Tools console (`Help > Toggle Developer Tools`) for JavaScript errors
3. Clear the webview cache: close the panel, reload the window, then reopen SandForge
4. If the issue persists after reinstalling, check for conflicting extensions

### Import and export issues

**Symptoms:** CSV or JSON import fails, or exported files are malformed.

**Solutions:**

1. Verify file encoding is UTF-8 (not ANSI or other encodings)
2. For CSV files, check that column headers match Salesforce API field names
3. Ensure date fields use ISO 8601 format (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ)
4. For JSON import, validate the file structure matches SandForge template format
5. Check file size -- very large files may need to be split into smaller chunks

### Governor limit warnings

**Symptoms:** Monitor shows amber or red warnings on governor limits, operations may be throttled.

**Solutions:**

1. Open Monitor and expand the Governor Limits section to see which limits are approaching capacity
2. Reduce batch sizes for Seed and Sync operations to lower API consumption per operation
3. Spread large operations across multiple days if hitting daily limits
4. Upgrade your sandbox tier (Developer Pro or Full sandbox) for higher API limits
5. Use the Anomaly Scan button to identify unusual consumption patterns
