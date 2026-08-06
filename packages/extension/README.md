# SandForge: Forge your Salesforce Sandboxes

SandForge populates your Salesforce developer sandbox with realistic data: cloned from a real record or generated synthetically, with production guardrails.

---

## Your first clone in 2 minutes

1. **Connect your orgs**: click the SandForge icon in the Activity Bar, open **Organizations**, and click **Import from SF CLI** to pull in every org authenticated in the Salesforce CLI.
2. **Open Forge**: click the flame icon in the sidebar, or run **SandForge: Open Forge** from the Command Palette.
3. **Paste a root record ID** from your UAT sandbox into **Record ID or Salesforce URL** (an Account works well).
4. Click **Discover Graph**, then tune **Depth**, **Records per object**, and **Anonymize PII**.
5. Click **Review & Execute** toward your dev sandbox. Every ID is remapped automatically.

![Forge flow: from a record to a populated sandbox](https://raw.githubusercontent.com/StephaneBerthoz/sand-forge-assets/main/forge-flow.gif)

---

## Three ways to populate your sandbox

- **Forge, from a real record**: pick one record in UAT or production, and Forge clones it with its whole relationship graph (Accounts, Contacts, Opportunities, Cases) into your sandbox. Dependencies are discovered breadth-first, insert order is resolved, and every ID is remapped.
- **Seed, synthetically**: generate data from 10 industry personas, pre-built templates (Sales Cloud, Service Cloud, Minimal Demo), CSV import, or LLM-backed field rules (OpenAI, Anthropic, Ollama). Generation is locale-aware and adjusts to your validation rules.
- **Frozen Dataset, replayable**: extract a dataset once, pseudonymize it deterministically, and replay it identically after every sandbox refresh.

---

## Safety by default

- **Production Guard**: 3 safety tiers with double confirmation before any write on a Production org.
- **Audit trail**: operations are logged with org, user, and timestamp.
- **Sandbox-only protections**: destructive operations such as DELETE are blocked on Production.

---

## More

- **Monitor**: API limits, jobs, storage, and health score in real time, with threshold alerts.
- **Sync**: bidirectional sync between orgs with field mapping, transforms, and conflict resolution.
- **Compare**: metadata diff, permission matrix, and drift detection across orgs.
- **DataOps**: backup and restore, PII anonymization templates (GDPR, CCPA, HIPAA, PCI DSS), data quality rules.
- **Automation**: visual pipeline builder with 15 step types, cron scheduling, and dry-run mode.
- **AI assistant**: NL2SOQL and failed-job diagnosis, read-only by design.

---

## Internationalization

Full UI in 6 languages: English, French, German, Spanish, Japanese, Brazilian Portuguese.

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
| AI API key (optional) | OpenAI, Anthropic, or Ollama |

---

## Author

**Stephane Berthoz**

## License

[MIT](LICENSE)
