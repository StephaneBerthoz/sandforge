# SandForge: Salesforce DevOps Toolkit

<!-- badges:start -->

![Version](https://img.shields.io/badge/version-1.32.0-blue)
[![CI](https://github.com/StephaneBerthoz/sandforge/actions/workflows/ci.yml/badge.svg)](https://github.com/StephaneBerthoz/sandforge/actions/workflows/ci.yml)
![TypeScript](https://img.shields.io/badge/typescript-strict-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Languages](https://img.shields.io/badge/i18n-6%20languages-orange)

<!-- badges:end -->

**Forge your Salesforce sandboxes.** SandForge populates your developer sandbox with realistic data: cloned from a real record or generated synthetically, with production guardrails. One WebView UI, no Command Palette required.

---

## Why switch from SFDMU or Data Loader?

- **No config file to author.** Paste a record ID: BFS discovery walks the relationship graph for you and lookups are remapped on write (a record type the target does not have keeps its source Id, and the SandForge log names it). No `export.json` to hand-write, no field mapping to keep in step with the schema.
- **No mandatory CSV round-trip.** Records move org to org over the API. CSV import is still there when you want it — one door in, not the only one.
- **Production Guard on by default.** Double confirmation before any write to a Production org, DELETE blocked outright. Nothing to switch on, nothing to remember.
- **Your existing SFDMU config keeps working.** The Migration module imports an `export.json` into a Sync config, so what you already built comes with you.

---

## Your first clone in 2 minutes

1. **Connect your orgs**: click the SandForge icon in the Activity Bar, open **Organizations**, and click **Import from SF CLI** to pull in every org authenticated in the Salesforce CLI.
2. **Open Forge**: click the flame icon in the sidebar, or run **SandForge: Open Forge** from the Command Palette.
3. **Paste a root record ID** from your UAT sandbox into **Record ID or Salesforce URL** (an Account works well).
4. Click **Discover Graph**, then tune **Depth**, **Records per object**, and **Anonymize PII**.
5. Click **Review & Execute** toward your dev sandbox. IDs are remapped as the records are written; a record type with no active record type of the same API name on the target keeps its source Id, and the SandForge log names it.

![Forge — live record preview, dependency estimate and PII detection](assets/screenshots/forge.png)

---

## Modules

SandForge ships 14 modules in a single extension:

| Module             | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Forge**          | Clone a record and its relationship graph between orgs, with BFS dependency discovery and automatic ID remapping                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Frozen Dataset** | Extract once, pseudonymize deterministically, replay identically after every sandbox refresh                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Seed**           | Synthetic data from AI personas, templates, CSV import, or LLM-backed field rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Sync**           | Source-to-target sync between orgs with field mapping, transforms, and conflict resolution against the target                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Monitor**        | API limits, jobs, storage, and health score in real time, with threshold alerts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Compare**        | Metadata diff, permission set and profile presence, and five Organization settings, compared between two orgs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **DataOps**        | Org backup, restore from any backup, and PII anonymization templates _(compliance workflows and quality rules coming soon)_                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Automation**     | Visual pipeline builder with 15 step types, sequenced with live progress. Only `delay` runs today: a pipeline holding any other step is marked as unable to run, and refused before it starts rather than reported done _(step execution, scheduling and triggers coming soon)_                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **AI Assistant**   | With your own Anthropic key: chat, pipeline drafts in Automation, and NL2SOQL, custom personas and AI field rules (picked by you or set by a built-in persona) in Seed. A saved chat continues after a restart or an AI setting change, and the model is given its last 20 messages of it. While AI is on, a failed Seed, Sync, DataOps or Automation run sends its error message — every Salesforce Id in it replaced by `<id>` — to the model for a fix suggestion shown as a VS Code notification. A built-in table of common Salesforce error codes answers the codes it knows first, on your machine, AI on or off, and sends nothing. The failures SandForge writes itself, and any failure raised with no SandForge view open, send nothing either. `sandforge.ai.errorResolution` turns that sending off on its own; turning AI off stops it at once. Compare's schema advice and Monitor's anomaly scan are rule-based: they run with AI off and no key |
| **Grappe**         | Per-partition progress reporting for large Seed and Sync runs — an Autopilot run reports only its start and its end — behind `sandforge.grappe.enabled` (off by default). Execution itself is sequential — this splits the _reporting_, not the work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Migration**      | Import existing SFDMU `export.json` or CSV configurations into Sync configs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Autopilot**      | Zero-config sandbox seeding through a guided wizard, with GDPR, CCPA, HIPAA and PCI-DSS anonymization rule sets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Organizations**  | Org registry with SF CLI import and tier-based safety coloring                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Reports**        | Execution reports and success-rate analytics, built from your Forge and Sync run history _(audit trail and data lineage coming soon)_                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

Safety is on by default: Production Guard requires double confirmation before any write on a Production org and blocks DELETE there. Its safety-check decisions are held in memory for the session only — a persisted, readable audit trail is still to come.

---

## Documentation

| Guide                                                            | Description                                                                                                       |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [Getting Started](docs/getting-started.md)                       | Install, connect your org, run your first operation                                                               |
| [Forge: Dev Sandbox Quickstart](docs/forge-quickstart.md)        | Clone a record graph from a partial-copy sandbox into your dev sandbox (wizard + CLI)                             |
| [Forge: Record-Scoped Architecture](docs/forge-record-scoped.md) | Internals of the scoped clone pipeline (BFS discovery, RecordType mapping, cycle 2-pass, orphan parent expansion) |
| [Frozen Dataset](docs/modules/frozen-dataset.md)                 | Replayable reference datasets                                                                                     |
| [Seed](docs/modules/seed.md)                                     | AI generation, CSV import, org-to-org cloning                                                                     |
| [Sync](docs/modules/sync.md)                                     | Org-to-org data synchronization with field mapping and conflict resolution                                        |
| [Monitor](docs/modules/monitor.md)                               | Real-time org health, API limits, and job tracking                                                                |
| [Compare](docs/modules/compare.md)                               | Metadata diff, permission set and profile presence, and five Organization settings                                |
| [DataOps](docs/modules/dataops.md)                               | Backup, restore and anonymization (compliance and quality coming soon)                                            |
| [Automation](docs/modules/automation.md)                         | Visual pipeline builder (step execution, scheduling and triggers coming soon)                                     |
| [FAQ & Troubleshooting](docs/faq.md)                             | Common questions and solutions to frequent issues                                                                 |

---

## Screenshots

![Home — orgs, health and the forge entry point](assets/screenshots/home.png)

![Seed — the template gallery and object picker that fill an empty dev org](assets/screenshots/seed.png)

![Sync — source and target orgs, direction, conflict strategy and a filtered object set](assets/screenshots/sync.png)

![Monitor — health score, governor limits and storage breakdown](assets/screenshots/monitor.png)

![DataOps — backup history with per-object results](assets/screenshots/dataops.png)

---

## Requirements

| Requirement           | Version            |
| --------------------- | ------------------ |
| Visual Studio Code    | 1.95+              |
| Salesforce CLI (`sf`) | Latest             |
| Node.js               | 22                 |
| pnpm                  | 11                 |
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

### From Source

```bash
git clone https://github.com/StephaneBerthoz/sandforge.git
cd sandforge
pnpm install
pnpm build
pnpm package
```

---

## Architecture

SandForge is a pnpm monorepo with three packages:

| Package              | Description                                          | Tech                      |
| -------------------- | ---------------------------------------------------- | ------------------------- |
| `packages/shared`    | Types, Zod schemas, constants, utilities             | TypeScript strict         |
| `packages/extension` | VSCode extension host, Salesforce API, orchestrators | Node.js, esbuild          |
| `packages/webview`   | React application, UI components, stores             | Vite, Tailwind, Shadcn/ui |

The WebView talks to the extension host through a typed `postMessage` broker; every message is validated by Zod schemas at the boundary.

---

## Keyboard Shortcuts

| Shortcut       | Action                           |
| -------------- | -------------------------------- |
| `Ctrl+Shift+R` | Open Grappe (partition progress) |
| `Ctrl+Shift+A` | Open Automation                  |

On macOS, use `Cmd` instead of `Ctrl`.

---

## Configuration

| Setting                                    | Description                                                                                                                          | Default                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| `sandforge.telemetry`                      | Record extension errors locally for diagnosis. Nothing is sent over the network.                                                     | `false`                      |
| `sandforge.orgs.validateOnStartup`         | Validate registered orgs at startup and auto-refresh expired sessions via the sf CLI                                                 | `true`                       |
| `sandforge.seed.defaultBatchSize`          | Default batch size for Seed data operations                                                                                          | `200`                        |
| `sandforge.sync.defaultBatchSize`          | Default batch size for Sync data operations                                                                                          | `200`                        |
| `sandforge.sync.maxConcurrentOps`          | Maximum concurrent sync operations                                                                                                   | `3`                          |
| `sandforge.ai.enabled`                     | Enable the AI Assistant (requires an API key)                                                                                        | `false`                      |
| `sandforge.ai.provider`                    | AI provider (only `anthropic` is implemented)                                                                                        | `anthropic`                  |
| `sandforge.ai.model`                       | AI model used by every AI feature (chat, NL2SOQL, pipeline drafts, error resolution, Seed)                                           | `claude-sonnet-4-5-20250929` |
| `sandforge.ai.errorResolution`             | Send a failed run's error message to the model for a fix suggestion (Salesforce Ids removed first)                                   | `true`                       |
| `sandforge.ai.tokenBudgetMaxPerSession`    | Maximum AI tokens per window session, shared by all AI features (warns at 80%)                                                       | `200000`                     |
| `sandforge.backup.maxCount`                | Maximum number of backups retained per org                                                                                           | `10`                         |
| `sandforge.pipeline.timeout`               | Pipeline execution timeout (ms)                                                                                                      | `300000`                     |
| `sandforge.safety.requireProdConfirmation` | Require confirmation for Production org operations                                                                                   | `true`                       |
| `sandforge.safety.auditLogging`            | Record each Production Guard safety-check decision in an in-memory log (last 1000, session only)                                     | `true`                       |
| `sandforge.grappe.enabled`                 | Report large Seed and Sync runs partition by partition (an Autopilot run reports only its start and end); execution stays sequential | `false`                      |
| `sandforge.grappe.autoActivateThreshold`   | Record count at or above which that partitioned reporting starts                                                                     | `10000`                      |
| `sandforge.grappe.grappeSize`              | Records per grappe partition                                                                                                         | `5000`                       |

See the full list of settings in the VSCode Settings UI under "SandForge".

---

## Internationalization

Full UI in 6 languages: English, French, German, Spanish, Japanese, Brazilian Portuguese. All UI text uses `t('key')` via react-i18next, and numbers and dates are formatted with Intl APIs using the editor locale. Durations are not: they are composed from fixed `h`/`min`/`s`/`ms` tokens and read the same in every locale.

---

## What's New

See the [CHANGELOG](changelog.md) for release notes. Report issues on the [GitHub Issues](https://github.com/StephaneBerthoz/sandforge/issues) page.

---

## Contributing

```bash
pnpm install          # Install dependencies
pnpm typecheck        # Type-check all packages (tsc --noEmit)
pnpm lint             # Lint with ESLint
pnpm test             # Run tests (Vitest)
pnpm build            # Build all packages
pnpm validate         # typecheck + lint + test + build
pnpm package          # Generate .vsix
```

Every `.ts` file must have a corresponding `.test.ts` in the same directory. The build must stay green at all times. TypeScript strict mode is enforced: no `any`, no unused locals. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

---

## Author

**Stephane Berthoz**

## License

[MIT](LICENSE)
