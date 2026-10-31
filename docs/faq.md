# FAQ and Troubleshooting

---

## Frequently Asked Questions

### What Salesforce editions are supported?

SandForge works with any Salesforce edition that exposes the REST, Bulk 2.0, and Metadata APIs. This includes Developer Edition, Enterprise, Unlimited, and Performance editions. Developer Edition (free) is sufficient for testing and evaluation.

### Do I need a paid Salesforce org?

No. A free Developer Edition org works for all SandForge features. Scratch orgs created with Salesforce CLI also work. The main constraint is API limits, which are lower on Developer Edition.

### I have one empty org. Where do I start?

With Seed's templates: no second org, no AI key. Connect the org (the launcher's **Connect your first org** card), click **Fill \<alias\> with demo data** at the top of the launcher, or **Seed** in its Modules list, and Seed opens on its template gallery. **CRM Starter**, marked _Start here_, writes accounts with their contacts, priced opportunities with their line items, and cases: 295 records, about 0.6 MB of the 5 MB a Developer Edition holds. **Use This**, check the counts and the org, **Start Seeding**. A seed that would not fit in the org's data storage, or would make its automation send more emails than it has left today, is refused before it writes anything, and **Earlier seeds** removes a seed whenever you want. See [Getting Started](getting-started.md#one-empty-org-fill-it-with-seed).

### Does SandForge modify production data?

SandForge includes a **Production Guard**, and it knows three kinds of org. A sandbox, a scratch org and a Developer Edition org — a Trailhead playground is one — are development orgs: nothing asks before a write there, and a cleanup deletes there. A sandbox you mark **Staging** in its **Edit** dialog on the Organizations page — a full copy or a UAT sandbox holding real data, which nothing Salesforce says tells apart — is a staging org: Production Guard asks before every delete there, every metadata deployment and every write of more than 10,000 records, its badge says STAGING, and a Frozen Dataset load refuses it, as it refuses any org but a development one. Any other org, and one whose edition SandForge never read, is a production org. Forge refuses to write to a production org — any org it cannot tell is a sandbox, a scratch org or a Developer Edition org — for a run and for a rehearsal alike, and so does a Frozen Dataset load. Checkpoints never takes a checkpoint of a production org nor rewinds one, and no setting lifts that: a rewind would delete and put back the business's own work since the checkpoint. The other modules ask before every write to a production org — one confirmation, which no setting turns off: `sandforge.safety.requireProdConfirmation` is no longer used — and DELETE operations are blocked there. Each safety-check decision is recorded with the run it concerns in the audit trail, which keeps the newest 2000 runs across sessions and is read in Reports → Audit Trail; `sandforge.safety.auditLogging` turns that recording off.

That said, SandForge is designed primarily for sandbox and scratch org workflows. We recommend always targeting sandboxes for data seeding and sync operations.

### How does AI data generation work? Which LLMs are supported?

AI features use an external LLM provider to generate context-aware, realistic data values. SandForge currently supports **Anthropic** (Claude models) via API key; additional providers are planned.

Enter your API key in the AI tab of the SandForge Settings page. The key is stored in VSCode SecretStorage, never in settings files. AI features are optional -- SandForge works fully without them using Faker profiles and templates.

### Can I use SandForge without AI features?

Yes. AI is entirely optional. Seed uses 36 locale-aware Faker generators by default for names, addresses, emails, usernames, user nicknames, phones, dates, case subjects, and more. Template-based seeding and CSV import work without any AI provider. Disable AI in settings with `sandforge.ai.enabled: false`.

### Is my data sent to external services?

Only to Anthropic, the only provider SandForge offers, and nothing before you turn AI on and store an Anthropic key. From then on, the chat sends your conversation, NL2SOQL sends your question with the names and labels of the org's objects, plus the field API names, labels and types of the up to five objects your question names, a pipeline draft sends your description, a custom persona sends its description, and an AI field rule in Seed, whether you picked it or a built-in persona set it, sends the field's API name and any instruction typed for it. A scenario pack drafted for testing an Agentforce agent sends the scenario you typed, its email addresses first moved to a reserved domain and its phone numbers replaced by ones nobody holds, the language of the pack, the active values of the target org's Case Status, Origin, Priority and Type picklists and, when you pick an agent, the API names, labels and descriptions of its topics and actions, never a record of the org. A failed Seed, Sync, DataOps or Automation run also sends its error message automatically, with every 15- or 18-character Salesforce Id in it replaced by `<id>` first, together with the module it came from, the request that started it, the object API names it was working on and, where the handler knows it, the batch size, for a fix suggestion shown as a VS Code notification — unless `sandforge.ai.errorResolution` is off, which stops that sending on its own and leaves the rest of the assistant as it is -- the first key saved from the Settings page sends no failure unless you tick **Suggest fixes for failed runs** with it, and the AI card switches it, turns AI off, or removes the key; unless a built-in table of common Salesforce error codes already answers it, which is decided on your machine, sends nothing and also answers with AI off; unless it is one of the messages SandForge writes itself for a declined production confirmation, a duplicate run, a running backup or rollback, a CRUD, FLS or Production Guard refusal, a missing backup or one taken from another org, a seed refused for the data storage or the daily emails its records would take, a clone refused for those emails, a failed automation pipeline with no further detail ("Pipeline failed"), an org that is not found or has no credentials, or a malformed username; and unless no SandForge panel or sidebar view is open. Other errors SandForge raises, such as a failed connection or an invalid request, are still sent. Salesforce error messages can quote record values. Compare's schema advice and Monitor's anomaly scan send nothing. Telemetry is off by default and, turned on, only writes error reports to a local log. The [MCP server](mcp.md) a checkout of this repository runs for an AI agent sends nothing itself: it answers the agent's client, and what its tools answer -- counts, record Ids, the names of the users who last changed records, the org's words in a refusal -- goes wherever that client sends it, to the agent's model, whatever these settings say.

### How do I update SandForge?

VSCode auto-updates extensions from the Marketplace. For manual updates, go to Extensions (`Ctrl+Shift+X`), find SandForge, and click Update. If you installed from a `.vsix` file, download the latest version and reinstall.

### Which tool copies my data?

Several modules write records into an org; which one depends on what the org needs, and each says differently how a run is taken back:

| What the org needs                                     | Use                                      | Taking it back                                                                   |
| ------------------------------------------------------ | ---------------------------------------- | -------------------------------------------------------------------------------- |
| Nothing copied: realistic records in an empty org      | **Seed**, from a template of its gallery | **What this run created**, on the results, or **Earlier seeds**                  |
| One record and what hangs on it                        | **Forge**                                | **Remove the records this run created**, on the results or under **Recent runs** |
| Whole objects, filtered and mapped, as often as needed | **Sync**                                 | **Remove what this run created**, on the results or the run's history entry      |
| Whole objects in dependency order, in one go           | **Autopilot**                            | A run cannot be removed; **Rewind…** to a checkpoint taken before it             |
| The same set after every sandbox refresh               | **Frozen Dataset**                       | **Remove the records this load created**, under **Last load** on the Load tab    |

**Seed** generates or imports data into one org: from a template of its gallery, in one confirmation, or one of three other ways -- Generate data (objects, counts and field rules of your own, with Faker or AI), CSV Upload (from a CSV file), or Clone from Org (copy records from another org). **Sync** copies existing data between two orgs with field mapping, transforms, and conflict resolution, and can run a saved configuration again, on a schedule or in delta mode. Seed's Clone from Org copies objects too, once, with no configuration to run again: prefer Sync for a copy you repeat. Runs of all three can be removed. See [How do I undo what SandForge wrote?](#how-do-i-undo-what-sandforge-wrote).

### How do I undo what SandForge wrote?

A run that keeps the list of the records it created can be taken back: its records are deleted from the org it wrote to, the last object written first, into the recycle bin, a record changed since the run kept unless you include it, and a record the target already held never taken. Production Guard judges the delete, and refuses it on a production org.

| Module                                      | Taken back from                                                                                                                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Forge                                       | **Remove the records this run created**, on the results, under **Recent runs**, and under **Older runs** once a run leaves that list                                                                                |
| Seed: a template (Quick Seed) or the wizard | **What this run created**, on the results, and **Earlier seeds**, under the gallery: every seed not removed, and the last 20 removed                                                                                |
| Sync                                        | **Remove what this run created**, on the results, on the run's history entry, and under **Runs that never ended**; what it wrote over is given back, and what a delta run deleted brought back from the recycle bin |
| Sync: the Real-Time tab                     | **Earlier sessions**, at the bottom of the tab, once a session has stopped; what it wrote over is given back, and what it deleted brought back from the recycle bin                                                 |
| Frozen Dataset                              | **Remove the records this load created**, under **Last load** on the Load tab                                                                                                                                       |
| Seed: CSV Upload, Clone from Org            | **What this run created**, on the results, and **Earlier seeds**, under the gallery, with the seeds                                                                                                                 |
| Autopilot                                   | Not removable: a run keeps no list of what it created                                                                                                                                                               |
| DataOps Anonymize                           | **Restore** puts back the values a snapshot holds; it deletes nothing                                                                                                                                               |

From the command line, `sandforge-clone`, `sandforge-seed` and `sandforge-sync` take a run back with `--remove` and the summary it printed with `--json`, and `sandforge-frozen` with its `remove` step ([Command line & CI](../ci-examples/README.md)). For a run nothing can take back, `sandforge-cleanup` deletes every record your user created on the target in a window of time, whether a run wrote it or not: preview it with `--dry-run`, then narrow it with `--objects`. The safest course is to try a module that cannot be undone on an org you can refresh or throw away, such as a scratch org.

A checkpoint taken before you start takes back more than a run: **Rewind…** returns the org's data to it, whoever wrote since -- a run of any module, your testers, flows or integrations -- after a preview, and **Undo this rewind** takes the org's last rewind back for 15 days. See [Checkpoint & Rewind](modules/checkpoint.md).

### Muting the target's automation for a run

A run asked to mute (`--mute-automation` on the command line) keeps the target's flows, processes and workflow rules quiet through the org's own bypass, never by deactivating anything. The automation report every run reads first lists the custom permissions their start conditions -- or the Decision a flow starts with -- test to stay quiet for the user who holds them, and the smallest permission set that holds each (the line `bypass: assign …`). Asked to mute, the run assigns the user it writes as, and that user alone, the permission sets holding the bypasses that user lacks, for the run alone, and takes those assignments back as it ends: written, failed, stopped or thrown alike. A set the user already holds is neither assigned nor taken back. The assignment is read back before the first write, and what the run then asks about -- the automation question, or `--accept-automation` -- is only what still runs.

- **What it cannot mute.** An Apex trigger, whose code is never read; a flow, process or workflow rule whose condition names no bypass, or was not read; one a managed package installed, which no one in the org reads or changes; and a bypass no permission set a user can be assigned holds. Each still runs, and the run names it with why. With nothing it can mute, the run says so and goes on as without the option.
- **What it never does.** Deactivate a flow or change the org's metadata; assign or take back anything for another user; mute on a production org, refused whatever its setting says; mute for a user without **Assign Permission Sets** or **Manage Users**, refused before anything is assigned. A refused mute writes nothing, exit `1` from the command line.
- **Two runs at once.** Before it assigns anything, a run writes its lease on this machine, in `.sandforge/mute-leases` of the home directory (`SANDFORGE_MUTE_LEASES_DIR` moves it; every run of the user must then name the same folder): the run, its process, when the lease ends, and the assignments it created. A run that ends takes back only what it created, and none another run of this machine still needs, which that run takes back as it ends.
- **What is left if the machine dies.** The assignments stay in the org until the next run of this machine that mutes the same org as the same user: it releases, before it takes its own, a lease whose process is gone or that is past its end -- an hour, pushed back every five minutes while its run goes on. One the org refused to take back is said with the org's reason, and kept for that run to try again.
- **What it says.** A dry run says what it would assign, what that silences and what still runs, and assigns nothing. A run's result says the permission sets it assigned, what they silenced, what still ran and whether they were taken back (`mutedAutomation` in the `--json` summary), and its audit entry keeps the sets by name and the automations by count.

`sandforge-clone`, `sandforge-sync` and `sandforge-seed` take it on a run and on `--remove`, `sandforge-autopilot` on a run, `sandforge-frozen` on `load`, and `sandforge-checkpoint` on `rewind` and `undo` ([Command line & CI](../ci-examples/README.md)).

### How do I import data from a CSV file?

Navigate to **Seed**, select **CSV Upload** under the template gallery, choose your target org and object, then drag-and-drop your CSV file. SandForge auto-maps CSV column headers to Salesforce fields using case-insensitive, underscore-tolerant matching. You can override any mapping manually. The validator checks for type mismatches, missing required fields, length violations, invalid picklist values, and duplicate external IDs before execution. Supported format: UTF-8 CSV with headers (BOM is stripped automatically). An import keeps no list of the records it created, and cannot be removed from the panel.

### How do I clone records from another org?

With **Forge**, for a record and what hangs on it: paste the record's Id or URL, pick the source and the target, **Discover Graph**, then **Review & Execute** -- see the [Forge Quickstart](forge-quickstart.md). For whole objects, **Sync** copies the objects you name, filtered and mapped, and **Autopilot** copies the objects you select in the order their dependencies set. Forge and Sync runs can be removed; an Autopilot run cannot.

Seed's **Clone from Org**, under the template gallery, copies the objects you pick, with an optional SOQL WHERE filter per object, in dependency order, and gives an ID mapping table (source ID to new ID) you can export as CSV. What it created in the target is kept, and taken back from its results or **Earlier seeds**, as a seed is.

### Can I clone self-referential objects (e.g., Account.ParentId)?

Yes. SandForge detects self-referential relationships and uses a two-pass insert: the first pass inserts records without self-references, the second pass updates self-referential fields with the remapped IDs. A cycle between objects -- an account pointing at its key contact while the contact points at its account -- is written the same way: the lookup that points at the object written later goes in empty and is filled in by the second pass. Only a cycle of lookups that must be set when the record is created is reported as an error, before anything is written.

### Does SandForge handle person accounts?

Yes. In an org with person accounts, an account is written as its kind: a person account with its first and last name, its email and phones and its `__pc` fields, and without the `Name` the platform builds from them; a business account without the fields only a person account holds. The platform writes a person account's contact itself with the account: Forge and a Frozen Dataset load never send it, and point what points at it -- a case, a contact role -- at the one the platform wrote. Into a target without person accounts, Forge and Sync write the account as a business account by its name, and Forge writes its contact as a contact of that account.

- **Forge**: [Person accounts](forge-record-scoped.md#person-accounts)
- **Seed**: a person account's record type, picked on the wizard's Configure step or with `--record-type`, writes person accounts -- see [Generate data](modules/seed.md#generate-data-seed-wizard)
- **Sync**: [What a run writes](modules/sync.md#what-a-run-writes)
- **Autopilot**: writes each account as its kind, by the rule Forge and Sync share -- see the [Autopilot guide](modules/autopilot.md)
- **Frozen Dataset**: [Load Flow](modules/frozen-dataset.md#load-flow-replayable)
- **DataOps**: an anonymization template masks a person account's own name, email and phones as it masks a contact's -- see [Anonymize](modules/dataops.md#anonymize)

### Does SandForge handle multi-currency orgs?

Yes, between two orgs with several currencies. Forge, Sync and Autopilot read both orgs' currencies before writing: a record in a currency the target does not hold active, which the target would refuse, goes in a currency it holds -- the default its record type gives the field, or the target's corporate currency -- each of its amounts converted at the source's rates, an opportunity's at the dated rates of its close date where advanced currency management is on. Line items follow their parent's currency, and a price goes in the currency of the records its lines belong to. The run says which records it converted, from which currency into which.

- **Forge**: [Simulate a run](forge-reference.md#simulate-a-run), where a currency the target lacks is a gap
- **Sync**: [What a run writes](modules/sync.md#what-a-run-writes)
- **Autopilot**: the plan lists the currencies the target does not hold active -- see the [Autopilot guide](modules/autopilot.md)

### What does SandForge keep on my machine?

What lets a run be resumed, checked or taken back, and nothing it does not need. On your machine, outside the orgs:

- **VS Code's secret storage**: the session of each org you connect, the Anthropic key once you store one, and the Frozen Dataset salt.
- **VS Code's global state**: the list of orgs, the Forge and Sync run history, saved Sync configurations, the audit trail, the newest 2000 runs, and the AI conversations, whole, the 50 written to most recently -- **Delete all conversations** on the AI page, or **Remove key** on the Settings page, deletes them.
- **The extension's own storage folder** (VS Code's global storage for SandForge): the ids of the records each Forge, Sync and Seed run created -- the last 20 Seed runs, CSV imports and clones from another org among them, and for Forge and Sync up to a few megabytes, the oldest runs going first -- and each Forge run's journal, ids only, in `forge-runs/`; and the DataOps backups, which hold the records' values unencrypted, personal data among them, up to `sandforge.backup.maxCount` per org and for `sandforge.backup.maxAgeDays` days -- among them, listed as backups of the org it wrote to, the values a Sync run wrote over, which removing the run gives back, and which only their age takes -- (30 unless you set it; a backup taken before that setting existed is kept until you delete it) -- the Restore tab deletes them, and disconnecting an org asks whether its backups go with it.
- **Your workspace**: Forge templates, in `.sandforge/forge-templates.json`, so they can be committed and shared.
- **Your home folder**: a Frozen Dataset's working folder, `~/.sandforge-sas` unless its configuration names another, never inside a repository; the journals of the command-line clone, in `~/.sandforge/forge-runs/`, and the run files of the command-line Sync and Seed, in `sync-runs/` and `seed-runs/` beside them, ids and dates only; the states of `sandforge-env`, in `env/` beside them, ids, counts and dates only, and with them each mask resource's DataOps snapshots, which hold the values its masking wrote over until its destroy deletes them; the state of `sandforge-compare` and `sandforge-monitor`, in `compare/` and `monitor/` beside them, the orgs they connected and no record; and the snapshots, templates and checkpoints of `sandforge-backup` and `sandforge-dataops`, with the values a run of `sandforge-sync` wrote over, in `~/.sandforge/backups/` unless `--store` names another folder of your own, readable by your user alone (`SANDFORGE_JOURNAL_DIR` names another folder for both); and the checkpoints of the **Checkpoints** module, taken from the panel or with `sandforge-checkpoint` alike, in `~/.sandforge/checkpoints/` (`checkpoints/` in the folder `SANDFORGE_JOURNAL_DIR` names), which hold the records' values unencrypted, personal data among them, readable by your user alone, for 30 days unless kept, with the journals of their rewinds that Undo reads and, per org, the ledger of its rewinds and undos the histories mark runs by, dates, names and counts only, and the lock of each org a take, a rewind, an undo, an environment's apply or its destroy writes to, in `~/.sandforge/locks/` -- see [Where checkpoints are kept](modules/checkpoint.md#where-checkpoints-are-kept).
- **Where you save it**: a checkpoint you export with **Export…** or `sandforge-checkpoint export`, a `.sfcheckpoint` file encrypted under a key shown once and kept nowhere, readable by your user alone; it does not expire: delete it once it has served.

Telemetry is off by default and, turned on, only writes error reports to a local log.

### Can a teammate rewind a shared org to my checkpoint?

Yes, from their machine, to the same org: a team's sandbox, a training org, a CI org. **Export…** on the checkpoint's row saves it to a `.sfcheckpoint` file, encrypted, at the place you pick in the editor's save dialog, and shows the key once, with **Copy the key**: send the file and the key by two different ways, and only to people who already see all data in the org, since whoever has both reads every record it holds. On their machine, **Import…** on the Checkpoints page reads the file and asks the org before the key: it must be the file's own org, connected there under any alias, no production org, and their user needs View All Data and Modify All Data. Then the key, typed hidden, and the checkpoint is listed there, rewound to as any other. The lock against two rewinds at once is per machine, so agree on who rewinds; and the Undo of a rewind stays with the machine that made it. For the same data in each person's own org, use Frozen Dataset or a `sandforge.yaml` instead: a checkpoint is never rewound into another org. See [To another machine, and from one](modules/checkpoint.md#to-another-machine-and-from-one).

### Can I automate recurring operations?

Partly. The **Automation** module provides a visual pipeline builder where you compose and save pipelines and start them by hand, on a cron schedule, or when SandForge notices a refresh of a sandbox you choose. A schedule and a refresh trigger start a saved pipeline only while VS Code is open, one run at a time, and a start that falls due while VS Code is closed is written to the history as missed, never made late. Twelve step types run: `backup` takes a DataOps snapshot into local storage, `checkpoint` takes a checkpoint of an org on this machine, `compare` diffs the metadata of two orgs, `precheck` reads an org's API usage, storage, error logs or failed jobs, `notification` shows a VS Code notification, `delay` and `condition` wait and branch, `approval` waits until someone approves the run in VS Code, `sync` runs a configuration saved on the Sync page, `seed` seeds with a template of the Seed page, `anonymize` masks with a template of the DataOps page, and `rewind` puts an org back to a checkpoint. Four of them write to your org: `sync` into a production org or a sandbox marked Staging only after an `approval` step, whose answer Production Guard takes; `seed` and `anonymize` never into a production org, whatever is answered, and into a sandbox marked Staging only after an `approval` step; `rewind` only once you have confirmed the step by typing the org's alias below its preview, within the most records you set. A pipeline holding a `restore` or `delete` step — from a template or a draft — is refused before its first step and recorded as failed. Event, webhook and deployment triggers start nothing, and the panel does not offer them — see the [Automation guide](modules/automation.md).

### Can I describe test data in a file my CI applies?

Yes, from a checkout of this repository: a `sandforge.yaml` committed with your project says what records its tests need, and the `sandforge-env` script applies it to an org. `plan` says what it would create, keep, replace and take back, and writes nothing; `apply` writes it through Seed's, Forge's, Frozen Dataset's and DataOps' own runs, after you type the org's alias or with `--yes`, and applied again writes nothing; `destroy` takes it back, the last resource first, into the recycle bin, and names what it left. It writes to scratch orgs, Developer Edition orgs, and sandboxes the file lists by their Organization Id, and refuses a production org before anything is read. What it keeps of each org -- ids, counts and dates, never a record's values, but for the snapshot a masking takes first -- lives on your machine, outside your repository: in CI, keep it in a cache keyed by the org. This version applies seed resources, Forge clones and Frozen Dataset loads, a seed may draw its parents from the records another resource created, and a mask resource masks records the org already holds with DataOps rules, a snapshot first, never unmasked by a destroy. The file's checkpoints let `reset` return the org to how its last apply left it, between two test suites, and `destroy --rewind` to how it was before the first apply; an AI agent plans, applies and destroys an environment through the tools of the [MCP server](mcp.md), each write confirmed by the org's alias; and with Red Hat's YAML extension installed, VS Code checks the file as you type it -- see [Environments as code](environments.md).

### Does SandForge support Salesforce DX and scratch orgs?

Yes. SandForge uses Salesforce CLI (`sf`) for authentication and supports all org types that `sf` can authenticate: scratch orgs, sandboxes, Developer Edition, and production. Import your CLI-authenticated orgs with **Import from SF CLI** on the Organizations page.

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

**Symptoms:** The Organizations page shows no orgs, or connection fails with an authentication error.

**Solutions:**

1. Verify your Salesforce CLI is authenticated: `sf org list` should show your org
2. Re-authenticate if needed: `sf org login web --alias my-sandbox`
3. For Import from SF CLI: make sure the CLI session is not expired. Run `sf org open --target-org my-sandbox` to refresh.
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
3. Split very large loads into several smaller runs — SandForge executes a run sequentially, so splitting is what actually shortens it. (The Grappe page shows such a run's progress partition by partition once `sandforge.grappe.enabled` is on; it does not run the partitions concurrently, so it shortens nothing.)
4. Org tier matters: Developer sandboxes have lower API limits than Full sandboxes
5. Close unused VSCode extension panels to free memory

### SOQL query errors

**Symptoms:** NL2SOQL generates an invalid query, or manual SOQL queries fail.

**Solutions:**

1. Check field-level security -- the query may reference fields the connected user cannot access
2. Verify object and field API names are correct (use the schema browser in Seed Step 1)
3. NL2SOQL drafts the query in Forge's **AI** tab: it describes up to five objects your request names by API name or label and sends those objects' field API names to the model. The draft is then checked against the source org -- the object after FROM, every field and relationship the query names at its top level, then the org's own parser -- and comes back with what the org refused, still editable; Discover runs it once it passes. Run the query and read the error
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
5. The Anomaly Scan button sits in that same panel but reads no limit: it samples records of the object chosen in the dropdown beside it -- Account, one of the 20 largest objects that hold records, or any other object whose API name you type after choosing "Other object…" -- and reports data anomalies (outliers, future dates, negative amounts, bursts of dates less than a minute apart, near-empty fields and duplicate names or emails -- the rules the [Monitor guide](modules/monitor.md) lists), so it will not tell you where your API calls went
