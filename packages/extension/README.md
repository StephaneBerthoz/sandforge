# SandForge: Salesforce DevOps Toolkit

[![Version](https://img.shields.io/badge/version-1.11.0-blue)](https://marketplace.visualstudio.com/items?itemName=StephaneBerthoz.sandforge)
![Tests](https://img.shields.io/badge/tests-7408-brightgreen)
![License](https://img.shields.io/badge/license-MIT-green)
![Languages](https://img.shields.io/badge/i18n-6%20languages-orange)

**Forge your Salesforce sandboxes.** SandForge populates your developer sandbox with realistic data: cloned from a real record or generated synthetically, with production guardrails. One WebView UI, no Command Palette required.

---

## Your first clone in 2 minutes

1. **Connect your orgs**: click the SandForge icon in the Activity Bar, open the org dropdown at the top of the **Launcher**, choose **New organization…**, then **Import from SF CLI** to pull in every org authenticated in the Salesforce CLI.
2. **Open Forge**: click the flame icon in the sidebar, or run **SandForge: Open Forge** from the Command Palette.
3. **Paste a root record ID** from your UAT sandbox into **Record ID or Salesforce URL** (an Account works well).
4. Click **Discover Graph**, then tune **Depth**, **Records per object**, and **Anonymize PII**.
5. Click **Review & Execute** toward your dev sandbox. Every ID is remapped automatically.

![Forge flow: from a record to a populated sandbox](https://raw.githubusercontent.com/StephaneBerthoz/sand-forge/master/assets/screenshots/forge-flow.gif)

New here? The built-in **Get Started** walkthrough (Help → Welcome → "Get started with SandForge") guides you through these steps directly inside VS Code.

---

## Modules

SandForge ships 14 modules in a single extension:

| Module | What it does |
|---|---|
| **Forge** | Clone a record and its relationship graph between orgs, with BFS dependency discovery and automatic ID remapping |
| **Frozen Dataset** | Extract once, pseudonymize deterministically, replay identically after every sandbox refresh |
| **Seed** | Synthetic data from AI personas, templates, CSV import, or LLM-backed field rules |
| **Sync** | Bidirectional sync between orgs with field mapping, transforms, and conflict resolution |
| **Monitor** | API limits, jobs, storage, and health score in real time, with threshold alerts |
| **Compare** | Metadata diff, permission matrix, and drift detection across orgs |
| **DataOps** | Backup and restore, PII anonymization (GDPR, CCPA, HIPAA, PCI DSS), data quality rules |
| **Automation** | Visual pipeline builder with 15 step types and dry-run mode (scheduling and triggers coming soon) |
| **AI Assistant** | NL2SOQL and failed-job diagnosis over 10 read-only tools |
| **Grappe** | Parallel execution engine for datasets above 10,000 records |
| **Migration** | Import existing SFDMU `export.json` or CSV/JSON files into Sync configs |
| **Autopilot** | Zero-config sandbox seeding through a guided wizard |
| **Organizations** | Org registry with SF CLI import and tier-based safety coloring |
| **Reports** | Execution reports, operational analytics, audit trail, and data lineage |

Safety is on by default: Production Guard requires double confirmation before any write on a Production org, blocks DELETE there, and keeps an audit trail of operations. Expired org sessions are auto-refreshed at startup via the sf CLI — no more mid-operation auth walls.

---

## Screenshots

![Home Dashboard](https://raw.githubusercontent.com/StephaneBerthoz/sand-forge/master/assets/screenshots/home.png)

![Seed Wizard](https://raw.githubusercontent.com/StephaneBerthoz/sand-forge/master/assets/screenshots/seed.png)

![Sync Field Mapping](https://raw.githubusercontent.com/StephaneBerthoz/sand-forge/master/assets/screenshots/sync.png)

![Monitor Dashboard](https://raw.githubusercontent.com/StephaneBerthoz/sand-forge/master/assets/screenshots/monitor.png)

![Autopilot Execution](https://raw.githubusercontent.com/StephaneBerthoz/sand-forge/master/assets/screenshots/autopilot.png)

---

## FAQ

- **Does my data leave my machine?** No. Telemetry is opt-in (off by default), the AI assistant is disabled by default, and your API key stays in VS Code Secret Storage.
- **Can I point it at production?** Reads, yes. Writes go through the Production Guard: double confirmation, and destructive operations (DELETE) are blocked outright.
- **Is this an SFDMU replacement?** The Migration module imports your existing `export.json` into a Sync config — non-destructively, nothing is written to your orgs.
- **Which orgs are supported?** Any org authenticated in the Salesforce CLI (`sf`), imported in one click.
- **Is it free?** Yes — MIT licensed, no account, no paid tier.

---

## Documentation

| Guide | Description |
|---|---|
| [Getting Started](https://github.com/StephaneBerthoz/sand-forge/blob/master/docs/getting-started.md) | Install, connect your org, run your first operation |
| [Forge: Dev Sandbox Quickstart](https://github.com/StephaneBerthoz/sand-forge/blob/master/docs/forge-quickstart.md) | Clone a record graph from a partial-copy sandbox into your dev sandbox (wizard + CLI) |
| [Forge: Record-Scoped Architecture](https://github.com/StephaneBerthoz/sand-forge/blob/master/docs/forge-record-scoped.md) | Internals of the scoped clone pipeline (BFS discovery, RecordType mapping, cycle 2-pass, orphan parent expansion) |
| [Frozen Dataset](https://github.com/StephaneBerthoz/sand-forge/blob/master/docs/modules/frozen-dataset.md) | Replayable reference datasets |
| [Seed](https://github.com/StephaneBerthoz/sand-forge/blob/master/docs/modules/seed.md) | AI generation, CSV import, org-to-org cloning |
| [Sync](https://github.com/StephaneBerthoz/sand-forge/blob/master/docs/modules/sync.md) | Bidirectional data synchronization between orgs |
| [Monitor](https://github.com/StephaneBerthoz/sand-forge/blob/master/docs/modules/monitor.md) | Real-time org health, API limits, and job tracking |
| [Compare](https://github.com/StephaneBerthoz/sand-forge/blob/master/docs/modules/compare.md) | Metadata diff, permission matrix, and drift detection |
| [DataOps](https://github.com/StephaneBerthoz/sand-forge/blob/master/docs/modules/dataops.md) | Backup, restore, anonymization, and data quality |
| [Automation](https://github.com/StephaneBerthoz/sand-forge/blob/master/docs/modules/automation.md) | Visual pipeline builder with scheduling |
| [FAQ & Troubleshooting](https://github.com/StephaneBerthoz/sand-forge/blob/master/docs/faq.md) | Common questions and solutions to frequent issues |

---

## Requirements

| Requirement | Version |
|---|---|
| Visual Studio Code | 1.95+ |
| Salesforce CLI (`sf`) | Latest |
| AI API key (optional) | Anthropic (Claude) |

---

## Installation

### From Marketplace (recommended)

1. Open VSCode
2. Go to Extensions (`Ctrl+Shift+X`)
3. Search for **SandForge**
4. Click **Install**

### From VSIX

Download `sandforge.vsix` from the [Releases](https://github.com/StephaneBerthoz/sand-forge/releases) page, then run **Extensions: Install from VSIX...** from the Command Palette.

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+R` | Open Grappe |
| `Ctrl+Shift+A` | Open Automation |

In-app, press `Ctrl+K` for the command palette and `G` + a letter to jump between modules (see the Help page for the full map). On macOS, use `Cmd` instead of `Ctrl`.

---

## Configuration

| Setting | Description | Default |
|---|---|---|
| `sandforge.telemetry` | Enable anonymous usage telemetry | `false` |
| `sandforge.orgs.validateOnStartup` | Validate registered orgs at startup and auto-refresh expired sessions via the sf CLI | `true` |
| `sandforge.seed.defaultBatchSize` | Default batch size for Seed data operations | `200` |
| `sandforge.sync.defaultBatchSize` | Default batch size for Sync data operations | `200` |
| `sandforge.sync.maxConcurrentOps` | Maximum concurrent sync operations | `3` |
| `sandforge.ai.enabled` | Enable the AI Assistant (requires an API key) | `false` |
| `sandforge.ai.provider` | AI provider (`anthropic` supported; `openai`/`custom` planned) | `anthropic` |
| `sandforge.ai.model` | AI model used by the assistant | `claude-sonnet-4-5-20250929` |
| `sandforge.ai.tokenBudgetMaxPerSession` | Maximum AI token budget per Assistant panel session | `50000` |
| `sandforge.backup.maxCount` | Maximum number of backups retained per org | `10` |
| `sandforge.pipeline.timeout` | Pipeline execution timeout (ms) | `300000` |
| `sandforge.safety.requireProdConfirmation` | Require confirmation for Production org operations | `true` |
| `sandforge.safety.auditLogging` | Enable audit logging for all data operations | `true` |

See the full list of settings in the VSCode Settings UI under "SandForge".

---

## Internationalization

Full UI in 6 languages, at 100% translation coverage enforced in CI: English, French, German, Spanish, Japanese, Brazilian Portuguese. Your language choice persists across sessions.

---

## Support

- [Report an issue](https://github.com/StephaneBerthoz/sand-forge/issues)
- [Ask a question (Q&A)](https://github.com/StephaneBerthoz/sand-forge/discussions)
- [Changelog](https://github.com/StephaneBerthoz/sand-forge/blob/master/changelog.md)
- [Security policy](https://github.com/StephaneBerthoz/sand-forge/blob/master/SECURITY.md)

Missing a feature? [Open a feature request](https://github.com/StephaneBerthoz/sand-forge/issues/new?template=feature_request.yml) — responses are fast.

## Author

**Stephane Berthoz**

## License

[MIT](https://github.com/StephaneBerthoz/sand-forge/blob/master/LICENSE)
