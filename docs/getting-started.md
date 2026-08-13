# Getting Started with SandForge

This guide walks you through installing SandForge, connecting your first Salesforce org, and running your first data operation.

---

## Prerequisites

Before you begin, make sure you have:

- **Visual Studio Code** 1.95 or later
- **Salesforce CLI** (`sf`) installed and authenticated with at least one org
- **A Salesforce sandbox or scratch org** to work with (Developer Edition works fine)
- _(Optional)_ An Anthropic (Claude) API key for AI-powered data generation

Verify your Salesforce CLI setup:

```bash
sf org list
```

You should see at least one authenticated org in the output.

---

## Installation

### From the VSCode Marketplace (recommended)

1. Open VSCode
2. Go to Extensions (`Ctrl+Shift+X`)
3. Search for **SandForge**
4. Click **Install**
5. Reload VSCode when prompted

### From a VSIX file

1. Download the latest `sandforge.vsix` from the [Releases page](https://github.com/StephaneBerthoz/sand-forge/releases)
2. In VSCode, open the Command Palette (`Ctrl+Shift+P`) and run **Extensions: Install from VSIX...**
3. Select the downloaded file

---

## First Launch

After installation, you will see the SandForge flame in the VSCode Activity Bar (left edge). Click it to open the **launcher** — a narrow sidebar view, not a dashboard. Everything starts here, and each module you pick opens in its own editor tab.

Top to bottom, the launcher gives you:

- **Org switcher** -- The current org with a live status dot and its type badge (PROD, SANDBOX, SCRATCH...). Open it to list every registered org, jump to one in a browser, or pick **New organization...** at the bottom to go to Organizations.
- **Orgs / Ops** -- Two counters, connected orgs and recent operations. Collapsible, and collapsed for you on short viewports.
- **Forge** -- The orange hero button, straight into the record-scoped clone journey. This is the shortcut you will use most.
- **Favorites** -- Only shown once you star something. Every module in the list below has a star button.
- **Modules** -- Monitor, Seed, Sync, Grappe, Autopilot, Frozen Dataset, Compare Org, DataOps, Automation, Migration, AI Assistant.
- **Tools** -- Organizations, Settings, Help.
- **Running / Last Operation** -- The operation in flight, or the last one to finish with its status and age.
- **Open Full UI** -- Opens Monitor in a full editor tab.

> **Note:** the **Home** dashboard — KPI row, sandbox health, recent operations — is an in-panel view only. It has no launcher entry and no `SandForge: Open ...` command, so it is reached from inside a SandForge panel: either the `G` then `H` chord, or the SandForge command palette on `Ctrl+K` (`Cmd+K` on macOS). That palette is SandForge's own, distinct from the VSCode palette on `Ctrl+Shift+P`.

![Home — the in-panel dashboard, reached with Ctrl+K](../assets/screenshots/home.png)

---

## Connect Your Org

1. Open **Organizations** from the launcher's Tools section, or pick **New organization...** at the bottom of the org switcher
2. The Org Manager page shows a connection banner with five auth methods:
   - **SFDX Import** -- Imports orgs already authenticated via Salesforce CLI (fastest option)
   - **OAuth Web** -- Opens a browser window for standard OAuth flow
   - **Username/Password** -- Direct login with username, password, and security token
   - **JWT** -- JSON Web Token authentication (coming soon)
   - **Device Flow** -- OAuth device flow for headless environments (coming soon)
3. Click **SFDX Import** to import your existing CLI-authenticated orgs automatically
4. Once connected, your org appears as a card with its alias, type badge (PROD/SBX), and status dot

> **Tip:** SandForge has a Production Guard that requires double confirmation for any operation targeting a Production org. Sandboxes and scratch orgs work without extra prompts.

---

## Your First Operation

The main SandForge use case: **populate a sandbox from a real record**. Let's walk through the **Forge** journey:

1. Navigate to **Forge** from the sidebar
2. Paste a root record ID in the **Record** tab (e.g. an Account from your UAT org) and pick the **Source Org** and **Target Org** (your dev sandbox)
3. Click **Discover Graph** — Forge walks the record's relationship graph (Account → Contacts, Opportunities, Cases…)
4. Tune the options: **Depth**, **Records per object**, **Anonymize PII**, excluded objects
5. Click **Review & Execute**, then **Execute Forge** — records land in your sandbox with every ID remapped

See the [Forge Quickstart](forge-quickstart.md) for the full walkthrough (including the headless CLI).

No real data to copy yet? The **Seed** module generates test data instead:

1. Navigate to **Seed** from the launcher's Modules list
2. Choose a seed mode from the mode selector: **AI Generate**, **CSV Upload**, or **Clone from Org**
3. For **AI Generate**: Select your org, pick objects, set record counts, configure field rules, then execute
4. For **CSV Upload**: Select your org and object, drag-and-drop a CSV file, map columns, validate, then execute
5. For **Clone from Org**: Select source and target orgs, pick objects to clone, preview the insertion order, then execute
6. View results with per-object record counts, error details, and export options

The **NL2SOQL** helper in Step 1 lets you describe what you want in plain English (e.g., "All accounts created this month with more than 10 employees") and generates the SOQL query for you.

---

## What's Next

Now that you are up and running, explore the full capabilities of each module:

- [Forge](forge-quickstart.md) -- Record-scoped clone: populate a sandbox from a real record and its relationship graph
- [Seed](modules/seed.md) -- AI generation, CSV import, and org-to-org cloning with templates and dependency resolution
- [Sync](modules/sync.md) -- Bidirectional data synchronization between orgs
- [Monitor](modules/monitor.md) -- Real-time org health, API limits, and job tracking
- [Compare](modules/compare.md) -- Metadata diff, permission matrix, and drift detection
- [DataOps](modules/dataops.md) -- Backup, restore, anonymization, and data quality
- [Automation](modules/automation.md) -- Visual pipeline builder with scheduling

Have questions? Check the [FAQ and Troubleshooting](faq.md) guide.
