# SandForge: Forge your Salesforce Sandboxes

[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/StephaneBerthoz.sandforge?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=StephaneBerthoz.sandforge)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/StephaneBerthoz.sandforge)](https://marketplace.visualstudio.com/items?itemName=StephaneBerthoz.sandforge)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/StephaneBerthoz.sandforge)](https://marketplace.visualstudio.com/items?itemName=StephaneBerthoz.sandforge)
[![CI](https://github.com/StephaneBerthoz/sand-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/StephaneBerthoz/sand-forge/actions/workflows/ci.yml)

**Populate a developer sandbox with realistic data in 2 minutes** — cloned from a real record with its whole relationship graph, generated synthetically, or replayed from a frozen dataset. With production guardrails, an audit trail, and full UI in 6 languages.

![Forge flow: from a record to a populated sandbox](https://raw.githubusercontent.com/StephaneBerthoz/sand-forge-assets/main/forge-flow.gif)

**Contents**: [First clone in 2 minutes](#your-first-clone-in-2-minutes) · [Three ways to populate](#three-ways-to-populate-your-sandbox) · [Safety](#safety-by-default) · [More modules](#and-much-more) · [FAQ](#faq) · [Docs](#documentation)

---

## Your first clone in 2 minutes

1. **Connect your orgs**: click the SandForge icon in the Activity Bar — the **Organizations** tree view lists every org from your Salesforce CLI (one click to import them all).
2. **Open Forge**: click the flame icon in the sidebar, or run **SandForge: Open Forge** from the Command Palette.
3. **Paste a root record ID** from your UAT sandbox (an Account works well).
4. Click **Discover Graph**, then tune **Depth**, **Records per object**, and **Anonymize PII**.
5. Click **Review & Execute** toward your dev sandbox. Every ID is remapped automatically.

New here? The built-in **Get Started** walkthrough (Help → Welcome → "Get started with SandForge") guides you through these steps directly inside VS Code.

---

## Three ways to populate your sandbox

- **Forge, from a real record**: pick one record in UAT or production, and Forge clones it with its whole relationship graph (Accounts, Contacts, Opportunities, Cases) into your sandbox. Dependencies are discovered breadth-first, insert order is resolved, and every ID is remapped.
- **Seed, synthetically**: generate data from 10 industry personas, pre-built templates (Sales Cloud, Service Cloud, Minimal Demo), CSV import, or LLM-backed field rules (Anthropic Claude — other providers planned). Generation is locale-aware and adjusts to your validation rules.
- **Frozen Dataset, replayable**: extract a dataset once, pseudonymize it deterministically, and replay it identically after every sandbox refresh.

**Migrating from SFDMU?** The **Migration** module imports your existing `export.json` (or any CSV/JSON file) and converts it into a ready-to-review Sync configuration — nothing is written to your orgs.

---

## Safety by default

- **Production Guard**: 3 safety tiers with double confirmation before any write on a Production org.
- **Audit trail**: operations are logged with org, user, and timestamp.
- **Sandbox-only protections**: destructive operations such as DELETE are blocked on Production.
- **Offline resilience**: connectivity is probed continuously; operations interrupted by a network drop are queued and replayed automatically when you're back online.

---

## And much more

- **Monitor**: API limits, jobs, storage, and health score with threshold alerts — plus **live operations** tracking your running seed and sync executions with real progress.
- **Sync**: bidirectional sync between orgs with field mapping, transforms, and conflict resolution.
- **Compare**: metadata diff, permission matrix, and drift detection across orgs.
- **DataOps**: backup and restore, PII anonymization templates (GDPR, CCPA, HIPAA, PCI DSS), data quality rules.
- **Automation**: visual pipeline builder with 15 step types and dry-run mode.
- **AI assistant**: NL2SOQL and failed-job diagnosis, read-only by design (Anthropic Claude; disabled by default, your key stays in VS Code Secret Storage).

![Monitor: limits, jobs and org health at a glance](https://raw.githubusercontent.com/StephaneBerthoz/sand-forge/master/assets/screenshots/monitor.png)

![Seed: guided wizard with templates and AI personas](https://raw.githubusercontent.com/StephaneBerthoz/sand-forge/master/assets/screenshots/seed.png)

---

## Internationalization

Full UI in 6 languages, at 100% translation coverage enforced in CI: English, French, German, Spanish, Japanese, Brazilian Portuguese. Your language choice persists across sessions.

---

## FAQ

- **Does my data leave my machine?** No. Telemetry is opt-in (off by default), the AI assistant is disabled by default, and your API key stays in VS Code Secret Storage.
- **Can I point it at production?** Reads, yes. Writes go through the Production Guard: double confirmation, and destructive operations (DELETE) are blocked outright.
- **Is this an SFDMU replacement?** The Migration module imports your existing `export.json` into a Sync config — non-destructively, nothing is written to your orgs.
- **Which orgs are supported?** Any org authenticated in the Salesforce CLI (`sf`), imported in one click.
- **Is it free?** Yes — MIT licensed, no account, no paid tier.

---

## Documentation

- [Forge: Dev Sandbox Quickstart](https://github.com/StephaneBerthoz/sand-forge/blob/master/docs/forge-quickstart.md): wizard and headless CLI walkthrough.
- [Frozen Dataset](https://github.com/StephaneBerthoz/sand-forge/blob/master/docs/modules/frozen-dataset.md): replayable reference datasets.
- [Getting Started](https://github.com/StephaneBerthoz/sand-forge/blob/master/docs/getting-started.md): install, connect, run your first operation.

---

## Requirements

| Requirement | Version |
|---|---|
| Visual Studio Code | 1.95+ |
| Salesforce CLI (`sf`) | Latest |
| AI API key (optional) | Anthropic (Claude) |

---

## Support

- [Report an issue](https://github.com/StephaneBerthoz/sand-forge/issues)
- [Ask a question (Q&A)](https://github.com/StephaneBerthoz/sand-forge/discussions)
- [Changelog](https://github.com/StephaneBerthoz/sand-forge/blob/master/changelog.md) — 17+ releases and counting
- [Security policy](https://github.com/StephaneBerthoz/sand-forge/blob/master/SECURITY.md)

Missing a feature? [Open a feature request](https://github.com/StephaneBerthoz/sand-forge/issues/new?template=feature_request.yml) — responses are fast.

## Author

**Stephane Berthoz**

## License

[MIT](LICENSE)
