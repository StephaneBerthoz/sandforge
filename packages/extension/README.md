# SandForge: Salesforce DevOps Toolkit

<!-- badges:start -->
[![Version](https://img.shields.io/badge/version-1.20.0-blue)](https://marketplace.visualstudio.com/items?itemName=StephaneBerthoz.sandforge)
![TypeScript](https://img.shields.io/badge/typescript-strict-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Languages](https://img.shields.io/badge/i18n-6%20languages-orange)
<!-- badges:end -->

**Forge your Salesforce sandboxes.** SandForge populates your developer sandbox with realistic data: cloned from a real record or generated synthetically, with production guardrails. One WebView UI, no Command Palette required.

---

## Why switch from SFDMU or Data Loader?

- **No config file to author.** Paste a record ID: BFS discovery walks the relationship graph for you and every lookup is remapped on write. No `export.json` to hand-write, no field mapping to keep in step with the schema.
- **No mandatory CSV round-trip.** Records move org to org over the API. CSV import is still there when you want it — one door in, not the only one.
- **Production Guard on by default.** Double confirmation before any write to a Production org, DELETE blocked outright, operations logged. Nothing to switch on, nothing to remember.
- **Your existing SFDMU config keeps working.** The Migration module imports an `export.json` into a Sync config, so what you already built comes with you.

---

## Your first clone in 2 minutes

1. **Connect your orgs**: click the SandForge icon in the Activity Bar, open the org dropdown at the top of the **Launcher**, choose **New organization…**, then **Import from SF CLI** to pull in every org authenticated in the Salesforce CLI.
2. **Open Forge**: click the flame icon in the sidebar, or run **SandForge: Open Forge** from the Command Palette.
3. **Paste a root record ID** from your UAT sandbox into **Record ID or Salesforce URL** (an Account works well).
4. Click **Discover Graph**, then tune **Depth**, **Records per object**, and **Anonymize PII**.
5. Click **Review & Execute** toward your dev sandbox. Every ID is remapped automatically.

![Forge — live record preview, dependency estimate and PII detection](https://raw.githubusercontent.com/StephaneBerthoz/sandforge/master/assets/screenshots/forge.png)

New here? The built-in **Get Started** walkthrough (Help → Welcome → "Get started with SandForge") guides you through these steps directly inside VS Code.

---

## Modules

SandForge ships 14 modules in a single extension:

| Module             | What it does                                                                                                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Forge**          | Clone a record and its relationship graph between orgs, with BFS dependency discovery and automatic ID remapping                                                                                         |
| **Frozen Dataset** | Extract once, pseudonymize deterministically, replay identically after every sandbox refresh                                                                                                             |
| **Seed**           | Synthetic data from AI personas, templates, CSV import, or LLM-backed field rules                                                                                                                        |
| **Sync**           | Bidirectional sync between orgs with field mapping, transforms, and conflict resolution                                                                                                                  |
| **Monitor**        | API limits, jobs, storage, and health score in real time, with threshold alerts                                                                                                                          |
| **Compare**        | Metadata diff, permission matrix, and drift detection across orgs                                                                                                                                        |
| **DataOps**        | Org backup, restore from any backup, and PII anonymization templates _(compliance workflows and quality rules coming soon)_                                                                              |
| **Automation**     | Visual pipeline builder with 15 step types and dry-run mode (scheduling and triggers coming soon)                                                                                                        |
| **AI Assistant**   | NL2SOQL and failed-job diagnosis over 10 read-only tools                                                                                                                                                 |
| **Grappe**         | Per-partition progress reporting for large Seed, Sync and Autopilot runs, behind `sandforge.grappe.enabled` (off by default). Execution itself is sequential — this splits the _reporting_, not the work |
| **Migration**      | Import existing SFDMU `export.json` or CSV/JSON files into Sync configs                                                                                                                                  |
| **Autopilot**      | Zero-config sandbox seeding through a guided wizard, with GDPR, CCPA, HIPAA and PCI-DSS anonymization rule sets                                                                                          |
| **Organizations**  | Org registry with SF CLI import and tier-based safety coloring                                                                                                                                           |
| **Reports**        | Execution reports and success-rate analytics, built from your Forge and Sync run history _(audit trail and data lineage coming soon)_                                                                    |

Safety is on by default: Production Guard requires double confirmation before any write on a Production org, blocks DELETE there, and keeps an audit trail of operations. Expired org sessions are auto-refreshed at startup via the sf CLI — no more mid-operation auth walls.

---

## Screenshots

![Home — orgs, health and the forge entry point](https://raw.githubusercontent.com/StephaneBerthoz/sandforge/master/assets/screenshots/home.png)

![Seed — the template gallery and object picker that fill an empty dev org](https://raw.githubusercontent.com/StephaneBerthoz/sandforge/master/assets/screenshots/seed.png)

![Sync — source and target orgs, direction, conflict strategy and a filtered object set](https://raw.githubusercontent.com/StephaneBerthoz/sandforge/master/assets/screenshots/sync.png)

![Monitor — health score, governor limits and storage breakdown](https://raw.githubusercontent.com/StephaneBerthoz/sandforge/master/assets/screenshots/monitor.png)

![DataOps — backup history with per-object results](https://raw.githubusercontent.com/StephaneBerthoz/sandforge/master/assets/screenshots/dataops.png)

---

## FAQ

- **Does my data leave my machine?** No. Telemetry is opt-in (off by default), the AI assistant is disabled by default, and your API key stays in VS Code Secret Storage.
- **Can I point it at production?** Reads, yes. Writes go through the Production Guard: double confirmation, and destructive operations (DELETE) are blocked outright.
- **Is this an SFDMU replacement?** For moving data between orgs from your editor, yes — and without the config file: you paste a record ID, SandForge discovers the relationship graph and remaps every ID on write. SFDMU keeps the edge for headless CI, where it has a real binary and SandForge does not. Switching costs nothing you already built: the Migration module imports your existing `export.json` into a Sync config, non-destructively — nothing is written to your orgs.
- **Which orgs are supported?** Any org authenticated in the Salesforce CLI (`sf`), imported in one click.
- **Is it free?** Yes — MIT licensed, no account, no paid tier.

---

## Documentation

| Guide                                                                                                                     | Description                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [Getting Started](https://github.com/StephaneBerthoz/sandforge/blob/master/docs/getting-started.md)                       | Install, connect your org, run your first operation                                                               |
| [Forge: Dev Sandbox Quickstart](https://github.com/StephaneBerthoz/sandforge/blob/master/docs/forge-quickstart.md)        | Clone a record graph from a partial-copy sandbox into your dev sandbox (wizard + CLI)                             |
| [Forge: Record-Scoped Architecture](https://github.com/StephaneBerthoz/sandforge/blob/master/docs/forge-record-scoped.md) | Internals of the scoped clone pipeline (BFS discovery, RecordType mapping, cycle 2-pass, orphan parent expansion) |
| [Frozen Dataset](https://github.com/StephaneBerthoz/sandforge/blob/master/docs/modules/frozen-dataset.md)                 | Replayable reference datasets                                                                                     |
| [Seed](https://github.com/StephaneBerthoz/sandforge/blob/master/docs/modules/seed.md)                                     | AI generation, CSV import, org-to-org cloning                                                                     |
| [Sync](https://github.com/StephaneBerthoz/sandforge/blob/master/docs/modules/sync.md)                                     | Bidirectional data synchronization between orgs                                                                   |
| [Monitor](https://github.com/StephaneBerthoz/sandforge/blob/master/docs/modules/monitor.md)                               | Real-time org health, API limits, and job tracking                                                                |
| [Compare](https://github.com/StephaneBerthoz/sandforge/blob/master/docs/modules/compare.md)                               | Metadata diff, permission matrix, and drift detection                                                             |
| [DataOps](https://github.com/StephaneBerthoz/sandforge/blob/master/docs/modules/dataops.md)                               | Backup, restore and anonymization (compliance and quality coming soon)                                            |
| [Automation](https://github.com/StephaneBerthoz/sandforge/blob/master/docs/modules/automation.md)                         | Visual pipeline builder (scheduling and triggers coming soon)                                                     |
| [FAQ & Troubleshooting](https://github.com/StephaneBerthoz/sandforge/blob/master/docs/faq.md)                             | Common questions and solutions to frequent issues                                                                 |

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

| Shortcut       | Action          |
| -------------- | --------------- |
| `Ctrl+Shift+R` | Open Grappe     |
| `Ctrl+Shift+A` | Open Automation |

In-app, press `Ctrl+K` for the command palette and `G` + a letter to jump between modules (see the Help page for the full map). On macOS, use `Cmd` instead of `Ctrl`.

---

## Configuration

| Setting                                    | Description                                                                          | Default                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------ | ---------------------------- |
| `sandforge.telemetry`                      | Enable anonymous usage telemetry                                                     | `false`                      |
| `sandforge.orgs.validateOnStartup`         | Validate registered orgs at startup and auto-refresh expired sessions via the sf CLI | `true`                       |
| `sandforge.seed.defaultBatchSize`          | Default batch size for Seed data operations                                          | `200`                        |
| `sandforge.sync.defaultBatchSize`          | Default batch size for Sync data operations                                          | `200`                        |
| `sandforge.sync.maxConcurrentOps`          | Maximum concurrent sync operations                                                   | `3`                          |
| `sandforge.ai.enabled`                     | Enable the AI Assistant (requires an API key)                                        | `false`                      |
| `sandforge.ai.provider`                    | AI provider (`anthropic` supported; `openai`/`custom` planned)                       | `anthropic`                  |
| `sandforge.ai.model`                       | AI model used by the assistant                                                       | `claude-sonnet-4-5-20250929` |
| `sandforge.ai.tokenBudgetMaxPerSession`    | Maximum AI token budget per Assistant panel session                                  | `50000`                      |
| `sandforge.backup.maxCount`                | Maximum number of backups retained per org                                           | `10`                         |
| `sandforge.pipeline.timeout`               | Pipeline execution timeout (ms)                                                      | `300000`                     |
| `sandforge.safety.requireProdConfirmation` | Require confirmation for Production org operations                                   | `true`                       |
| `sandforge.safety.auditLogging`            | Enable audit logging for all data operations                                         | `true`                       |

See the full list of settings in the VSCode Settings UI under "SandForge".

---

## Internationalization

Full UI in 6 languages: English, French, German, Spanish, Japanese, Brazilian Portuguese. Key parity across locales is enforced in CI. Your language choice persists across sessions.

---

## Support

- [Report an issue](https://github.com/StephaneBerthoz/sandforge/issues)
- [Ask a question (Q&A)](https://github.com/StephaneBerthoz/sandforge/discussions)
- [Changelog](https://github.com/StephaneBerthoz/sandforge/blob/master/changelog.md)
- [Security policy](https://github.com/StephaneBerthoz/sandforge/blob/master/SECURITY.md)

Missing a feature? [Open a feature request](https://github.com/StephaneBerthoz/sandforge/issues/new?template=feature_request.yml) — responses are fast.

## Author

**Stephane Berthoz**

## License

[MIT](https://github.com/StephaneBerthoz/sandforge/blob/master/LICENSE)
