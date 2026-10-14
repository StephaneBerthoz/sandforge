<!-- Generated from README.md by scripts/sync-extension-readme.mjs: edit README.md, then run it. -->

# SandForge: Realistic Data for Salesforce Sandboxes

<!-- badges:start -->

[![Version](https://img.shields.io/badge/version-1.52.0-blue)](https://marketplace.visualstudio.com/items?itemName=StephaneBerthoz.sandforge)
![TypeScript](https://img.shields.io/badge/typescript-strict-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Languages](https://img.shields.io/badge/i18n-6%20languages-orange)

<!-- badges:end -->

**Forge your Salesforce sandboxes.** SandForge populates your developer sandbox with realistic data: cloned from a real record or generated synthetically, with production guardrails. One WebView UI, no Command Palette required.

---

## Why switch from SFDMU or Data Loader?

- **No config file to author.** Paste a record ID: BFS discovery walks the relationship graph for you and lookups are remapped on write (a record type the target does not have keeps its source Id, and the SandForge log names it). No `export.json` to hand-write, no field mapping to keep in step with the schema.
- **No mandatory CSV round-trip.** Records move org to org over the API. CSV import is still there when you want it — one door in, not the only one.
- **Production Guard on by default.** Forge refuses a production org as a target; the other modules ask you to confirm any write to one, and DELETE there is blocked outright. Nothing to switch on, nothing to remember.
- **Your existing SFDMU config keeps working.** The Migration module imports an `export.json` into a Sync config, so what you already built comes with you.

---

## Your first clone in 2 minutes

1. **Connect your orgs**: click the SandForge icon in the Activity Bar, open the org dropdown at the top of the launcher, choose **New organization...**, then **Import from SF CLI** to pull in every org authenticated in the Salesforce CLI.
2. **Open Forge**: click the flame icon in the sidebar, or run **SandForge: Open Forge** from the Command Palette.
3. **Paste a root record ID** from your UAT sandbox into **Record ID or Salesforce URL** (an Account works well).
4. Click **Discover Graph**, then tune **Depth**, **Records per object**, and **Anonymize PII**.
5. Click **Review & Execute** toward your dev sandbox. IDs are remapped as the records are written; a record type with no active record type of the same API name on the target keeps its source Id, and the SandForge log names it.

![Forge — live record preview, dependency estimate and PII detection](https://raw.githubusercontent.com/StephaneBerthoz/sandforge/master/assets/screenshots/forge.png)

New here? The built-in **Get Started** walkthrough (Help → Welcome → "Get started with SandForge") guides you through these steps directly inside VS Code.

---

## First steps, safely

1. **Clone into a Developer sandbox or a scratch org.** Forge writes only to a sandbox, a scratch org or a Developer Edition org; it refuses a production org, and any org it cannot tell is one of those.
2. **Simulate first.** On Review, **Simulate** takes every record through the write stage and writes nothing. Its results say how many records a real run would insert and how many gaps it found against the target.
3. **Read the Automation and Gaps tabs.** Automation lists what the target runs on the records the run writes (flows, processes, workflow rules, Apex triggers, assignment and duplicate rules), marks what sends an email or a text message, and says what may refuse a removal of the run's records; a real run asks you in VS Code to confirm what fires on insert and update before it writes anything. Gaps lists what the target would refuse or change in the rows, read from its metadata or found by a simulation or a rehearsal, each with the decisions it allows; the tab counts the gaps that will refuse rows and have no decision yet.
4. **Emails and phone numbers are neutralized by default.** Every email address is written under `.invalid` and every phone number as a fictional one, so the target's automation reaches no one; past 10,000 distinct numbers in one run, a phone field is left empty instead, and Results counts it. **Keep emails and phone numbers as they are** turns that off.
5. **Rehearse when the target has validation rules or triggers.** A simulation checks the rows against the target's fields; **Rehearse** has the target itself judge them, in calls it rolls back whole: every row when the run creates 200 or fewer, otherwise one row for each object, record type and set of filled fields. You confirm the calls it costs in VS Code first, and that confirmation names what a rollback cannot take back: platform events published immediately and callouts already made.
6. **Remove a run from Results.** **Remove the records this run created** deletes them from the target, children before their parents, into its recycle bin; its confirmation lists what the target runs as they are deleted. Records the run linked to, which the target already held, are kept, and so is a record changed since the run unless you include it. The runs under **Recent runs**, and under **Older runs** once they leave that list, offer the same removal.

![Forge Review — the Gaps tab with two gaps decided and one still refusing rows, beside the Automation tab's count](https://raw.githubusercontent.com/StephaneBerthoz/sandforge/master/assets/screenshots/forge-review.png)

![Forge simulation — nothing written, what a real run would insert, the gaps found and the emails and phone numbers it would neutralize](https://raw.githubusercontent.com/StephaneBerthoz/sandforge/master/assets/screenshots/forge-simulation.png)

---

## Modules

SandForge ships 14 modules in a single extension:

| Module             | What it does                                                                                                                                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Forge**          | Clone a record and its relationship graph between orgs, with BFS dependency discovery and automatic ID remapping. [Guide](https://github.com/StephaneBerthoz/sandforge/blob/master/docs/forge-quickstart.md)                                                                                     |
| **Frozen Dataset** | Extract once, pseudonymize deterministically, replay identically after every sandbox refresh. [Guide](https://github.com/StephaneBerthoz/sandforge/blob/master/docs/modules/frozen-dataset.md)                                                                                                   |
| **Seed**           | Synthetic data from AI personas, templates, CSV import, or LLM-backed field rules. [Guide](https://github.com/StephaneBerthoz/sandforge/blob/master/docs/modules/seed.md)                                                                                                                        |
| **Sync**           | Source-to-target sync between orgs with field mapping, transforms, and conflict resolution against the target. [Guide](https://github.com/StephaneBerthoz/sandforge/blob/master/docs/modules/sync.md)                                                                                            |
| **Monitor**        | API limits, jobs, storage, and health score in real time, with threshold alerts. [Guide](https://github.com/StephaneBerthoz/sandforge/blob/master/docs/modules/monitor.md)                                                                                                                       |
| **Compare**        | Metadata diff, permission set and profile presence, and five Organization settings, compared between two orgs. [Guide](https://github.com/StephaneBerthoz/sandforge/blob/master/docs/modules/compare.md)                                                                                         |
| **DataOps**        | Backup and restore, PII anonymization, data subject requests, a read-only data-quality scan, and a cleanup of stale, orphaned and duplicate records through Production Guard. [Guide](https://github.com/StephaneBerthoz/sandforge/blob/master/docs/modules/dataops.md)                          |
| **Automation**     | Visual pipelines of `backup`, `compare`, `precheck`, `notification`, `delay`, `condition`, `approval` and `sync` steps, run by hand, on a cron schedule or a sandbox refresh while VS Code is open. [Guide](https://github.com/StephaneBerthoz/sandforge/blob/master/docs/modules/automation.md) |
| **AI Assistant**   | Chat, NL2SOQL, pipeline drafts and Seed field rules on your Anthropic key. Failed runs send their error for a fix unless `sandforge.ai.errorResolution` is off; known codes answer with AI off. [Guide](https://github.com/StephaneBerthoz/sandforge/blob/master/docs/modules/ai-assistant.md)   |
| **Grappe**         | A progress page, not an engine: once `sandforge.grappe.enabled` is on (off by default), large Seed and Sync runs report there partition by partition. Execution stays sequential.                                                                                                                |
| **Migration**      | Import existing SFDMU `export.json` or CSV/JSON files into Sync configs.                                                                                                                                                                                                                         |
| **Autopilot**      | Zero-config sandbox seeding through a guided wizard, with GDPR, CCPA, HIPAA and PCI-DSS anonymization rule sets.                                                                                                                                                                                 |
| **Organizations**  | Org registry with SF CLI import and tier-based safety coloring; at startup, expired sessions are refreshed through the sf CLI.                                                                                                                                                                   |
| **Reports**        | Execution reports and success rates from your Forge and Sync run history, an audit trail of every run that writes to an org, and the data lineage of the records each run carried.                                                                                                               |

Safety is on by default: Forge refuses a Production org as a target, and for every other module Production Guard asks for confirmation before any write on a Production org and blocks DELETE there. Each of its decisions is recorded with the run it concerns, in Reports → Audit Trail.

---

## Screenshots

![Launcher — the SandForge mark, the current org and every module, in the VS Code sidebar](https://raw.githubusercontent.com/StephaneBerthoz/sandforge/master/assets/screenshots/launcher.png)

![Forge results — the records a run created, their ids in the target, its emails and phone numbers neutralized, and the actions to verify or remove what it wrote](https://raw.githubusercontent.com/StephaneBerthoz/sandforge/master/assets/screenshots/forge-results.png)

![Home — orgs, health and the forge entry point](https://raw.githubusercontent.com/StephaneBerthoz/sandforge/master/assets/screenshots/home.png)

![Seed — the template gallery and object picker that fill an empty dev org](https://raw.githubusercontent.com/StephaneBerthoz/sandforge/master/assets/screenshots/seed.png)

![Sync — source and target orgs, direction, conflict strategy and a filtered object set](https://raw.githubusercontent.com/StephaneBerthoz/sandforge/master/assets/screenshots/sync.png)

![Monitor — health score, governor limits and storage breakdown](https://raw.githubusercontent.com/StephaneBerthoz/sandforge/master/assets/screenshots/monitor.png)

![DataOps — backup history with per-object results](https://raw.githubusercontent.com/StephaneBerthoz/sandforge/master/assets/screenshots/dataops.png)

---

## FAQ

- **Does my data leave my machine?** Beyond the orgs you connect, only to Anthropic, and nothing before you turn the AI Assistant on (it is off by default) and store your own key, which stays in VS Code Secret Storage. From then on a failed run's error message is sent too, unless `sandforge.ai.errorResolution` is off; [the FAQ](https://github.com/StephaneBerthoz/sandforge/blob/master/docs/faq.md#is-my-data-sent-to-external-services) lists what each feature sends. Telemetry is off by default and, turned on, only writes error reports to a local log.
- **Can I point it at production?** Reads, yes. Forge never writes to one: it refuses a production target outright. The other modules' writes go through the Production Guard: a confirmation first, and destructive operations (DELETE) are blocked outright.
- **Is this an SFDMU replacement?** For moving data between orgs from your editor, yes — and without the config file: you paste a record ID, SandForge discovers the relationship graph and remaps IDs on write (a record type the target does not have keeps its source Id, and the SandForge log names it). SFDMU keeps the edge for headless CI, where it has a real binary and SandForge does not. Switching costs nothing you already built: the Migration module imports your existing `export.json` into a Sync config, non-destructively — nothing is written to your orgs.
- **Which orgs are supported?** Any org authenticated in the Salesforce CLI (`sf`), imported in one click.
- **Is it free?** Yes — MIT licensed, no account, no paid tier.

---

## Documentation

| Guide                                                                                                                     | Description                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [Getting Started](https://github.com/StephaneBerthoz/sandforge/blob/master/docs/getting-started.md)                       | Install, connect your org, run your first operation                                                                  |
| [Forge: Dev Sandbox Quickstart](https://github.com/StephaneBerthoz/sandforge/blob/master/docs/forge-quickstart.md)        | Clone a record graph from a partial-copy sandbox into your dev sandbox (wizard + CLI)                                |
| [Forge: Record-Scoped Architecture](https://github.com/StephaneBerthoz/sandforge/blob/master/docs/forge-record-scoped.md) | Internals of the scoped clone pipeline (BFS discovery, RecordType mapping, cycle 2-pass, orphan parent expansion)    |
| [Frozen Dataset](https://github.com/StephaneBerthoz/sandforge/blob/master/docs/modules/frozen-dataset.md)                 | Replayable reference datasets                                                                                        |
| [Seed](https://github.com/StephaneBerthoz/sandforge/blob/master/docs/modules/seed.md)                                     | AI generation, CSV import, org-to-org cloning                                                                        |
| [Sync](https://github.com/StephaneBerthoz/sandforge/blob/master/docs/modules/sync.md)                                     | Org-to-org data synchronization with field mapping and conflict resolution                                           |
| [Monitor](https://github.com/StephaneBerthoz/sandforge/blob/master/docs/modules/monitor.md)                               | Real-time org health, API limits, and job tracking                                                                   |
| [Compare](https://github.com/StephaneBerthoz/sandforge/blob/master/docs/modules/compare.md)                               | Metadata diff, permission set and profile presence, and five Organization settings                                   |
| [DataOps](https://github.com/StephaneBerthoz/sandforge/blob/master/docs/modules/dataops.md)                               | Backup, restore, anonymization, data subject requests, cleanup and a data-quality scan                               |
| [Automation](https://github.com/StephaneBerthoz/sandforge/blob/master/docs/modules/automation.md)                         | Visual pipeline builder: backups, comparisons, checks, notifications, by hand, on a schedule or on a sandbox refresh |
| [AI Assistant](https://github.com/StephaneBerthoz/sandforge/blob/master/docs/modules/ai-assistant.md)                     | Chat, NL2SOQL, pipeline drafts, Seed's AI rules and error resolution, and what works with AI off                     |
| [FAQ & Troubleshooting](https://github.com/StephaneBerthoz/sandforge/blob/master/docs/faq.md)                             | Common questions and solutions to frequent issues                                                                    |

---

## Requirements

| Requirement           | Version            |
| --------------------- | ------------------ |
| Visual Studio Code    | 1.95+              |
| Salesforce CLI (`sf`) | Latest             |
| AI API key (optional) | Anthropic (Claude) |

---

## Installation

### From Marketplace (recommended)

1. Open VSCode
2. Go to Extensions (`Ctrl+Shift+X`)
3. Search for **SandForge**
4. Click **Install**

### From VSIX

Download `sandforge.vsix` from the [Releases](https://github.com/StephaneBerthoz/sandforge/releases) page, then run **Extensions: Install from VSIX...** from the Command Palette.

---

## Keyboard Shortcuts

| Shortcut       | Action                           |
| -------------- | -------------------------------- |
| `Ctrl+Shift+R` | Open Grappe (partition progress) |
| `Ctrl+Shift+A` | Open Automation                  |

In-app, press `Ctrl+K` for the command palette and `G` + a letter to jump between modules (see the Help page for the full map). On macOS, use `Cmd` instead of `Ctrl`.

---

## Configuration

| Setting                                    | Description                                                                                                                          | Default           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| `sandforge.showWhatsNew`                   | Show what a new minor version brings the first time a SandForge panel opens after an upgrade. A patch version never shows it.        | `true`            |
| `sandforge.telemetry`                      | Record extension errors locally for diagnosis. Nothing is sent over the network.                                                     | `false`           |
| `sandforge.orgs.validateOnStartup`         | Validate registered orgs at startup and auto-refresh expired sessions via the sf CLI                                                 | `true`            |
| `sandforge.forge.graphView`                | Forge's discovery, Review and execution screens: `auto` shows a table past 25 objects, a graph below; `graph` or `table` always      | `auto`            |
| `sandforge.forge.maxRecordsPerObject`      | Most records of one object a Forge clone reads: a clone of whole tables reads and writes them a page at a time; past it, truncated   | `50000`           |
| `sandforge.seed.defaultBatchSize`          | Default batch size for Seed data operations                                                                                          | `200`             |
| `sandforge.sync.defaultBatchSize`          | Default batch size for Sync data operations                                                                                          | `200`             |
| `sandforge.sync.maxConcurrentOps`          | Maximum concurrent sync operations                                                                                                   | `3`               |
| `sandforge.ai.enabled`                     | Enable the AI Assistant (requires an API key)                                                                                        | `false`           |
| `sandforge.ai.provider`                    | AI provider (only `anthropic` is implemented)                                                                                        | `anthropic`       |
| `sandforge.ai.model`                       | AI model used by every AI feature (chat, NL2SOQL, pipeline drafts, error resolution, Seed)                                           | `claude-sonnet-5` |
| `sandforge.ai.errorResolution`             | Send a failed run's error message to the model for a fix suggestion (Salesforce Ids removed first)                                   | `true`            |
| `sandforge.ai.tokenBudgetMaxPerSession`    | Maximum AI tokens per window session, shared by all AI features (warns at 80%)                                                       | `200000`          |
| `sandforge.backup.maxCount`                | Maximum number of backups retained per org                                                                                           | `10`              |
| `sandforge.backup.maxRecordsPerObject`     | Most records of each object a DataOps backup reads; an object holding more is backed up in part, and the backup says so              | `50000`           |
| `sandforge.pipeline.timeout`               | Pipeline execution timeout (ms)                                                                                                      | `300000`          |
| `sandforge.safety.requireProdConfirmation` | Require confirmation for Production org operations                                                                                   | `true`            |
| `sandforge.safety.auditLogging`            | Record each Production Guard decision with the run it concerns in the audit trail                                                    | `true`            |
| `sandforge.safety.confirmAboveRecords`     | Ask before a Forge clone writes more than this many records (0: never); one near the target org's data storage is asked about too    | `2000`            |
| `sandforge.grappe.enabled`                 | Report large Seed and Sync runs partition by partition (an Autopilot run reports only its start and end); execution stays sequential | `false`           |
| `sandforge.grappe.autoActivateThreshold`   | Record count at or above which that partitioned reporting starts                                                                     | `10000`           |
| `sandforge.grappe.grappeSize`              | Records per grappe partition                                                                                                         | `5000`            |

See the full list of settings in the VSCode Settings UI under "SandForge".

---

## Internationalization

Full UI in 6 languages: English, French, German, Spanish, Japanese, Brazilian Portuguese. Key parity across locales is enforced in CI, and your language choice persists across sessions. Numbers and dates are formatted with Intl APIs in the language picked in SandForge, keeping the editor's regional conventions when the editor uses that same language. Durations are not: they are composed from fixed `h`/`min`/`s`/`ms` tokens and read the same in every locale.

---

## Support

- [Report an issue](https://github.com/StephaneBerthoz/sandforge/issues)
- [Ask a question (Q&A)](https://github.com/StephaneBerthoz/sandforge/discussions)
- [Changelog](https://github.com/StephaneBerthoz/sandforge/blob/master/changelog.md)
- [Security policy](https://github.com/StephaneBerthoz/sandforge/blob/master/SECURITY.md)

Missing a feature? [Open a feature request](https://github.com/StephaneBerthoz/sandforge/issues/new?template=feature_request.yml) — responses are fast.

---

## Author

**Stephane Berthoz**

## License

[MIT](https://github.com/StephaneBerthoz/sandforge/blob/master/LICENSE)
