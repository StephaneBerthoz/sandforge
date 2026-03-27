# Getting Started with SandForge

This guide walks you through installing SandForge, connecting your first Salesforce org, and running your first data operation.

---

## Prerequisites

Before you begin, make sure you have:

- **Visual Studio Code** 1.95 or later
- **Salesforce CLI** (`sf`) installed and authenticated with at least one org
- **A Salesforce sandbox or scratch org** to work with (Developer Edition works fine)
- *(Optional)* An AI API key (OpenAI, Anthropic, or Ollama) for AI-powered data generation

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

1. Download the latest `sandforge.vsix` from the [Releases page](https://github.com/sandforge/sandforge/releases)
2. In VSCode, open the Command Palette (`Ctrl+Shift+P`) and run **Extensions: Install from VSIX...**
3. Select the downloaded file

---

## First Launch

After installation, you will see the SandForge icon in the VSCode Activity Bar (left sidebar). Click it to open the SandForge panel.

![Activity Bar icon](../assets/screenshots/getting-started-01.png)

The **Home Dashboard** appears with a bento-grid layout showing:

- **KPI Row** -- Connected orgs count, active jobs, recent operations, and limit warnings
- **Forge Hero Card** -- Quick-launch area with a record ID input and "Start Forge" button
- **Sandbox Health** -- Status of your connected orgs at a glance
- **Quick Actions** -- One-click access to Forge, Grappe, Monitor, and Automation
- **Recent Operations** -- Your last 5 operations with status badges

If you have no connected orgs, a **Getting Started** card will guide you through the first steps.

![Home Dashboard](../assets/screenshots/getting-started-02.png)

---

## Connect Your Org

1. Navigate to **Organizations** using the sidebar or click "Connect Org" on the Home page
2. The Org Manager page shows a connection banner with five auth methods:
   - **SFDX Import** -- Imports orgs already authenticated via Salesforce CLI (fastest option)
   - **OAuth Web** -- Opens a browser window for standard OAuth flow
   - **Username/Password** -- Direct login with username, password, and security token
   - **JWT** -- JSON Web Token authentication (coming soon)
   - **Device Flow** -- OAuth device flow for headless environments (coming soon)
3. Click **SFDX Import** to import your existing CLI-authenticated orgs automatically
4. Once connected, your org appears as a card with its alias, type badge (PROD/SBX), and status dot

![Org Manager](../assets/screenshots/getting-started-03.png)

> **Tip:** SandForge has a Production Guard that requires double confirmation for any operation targeting a Production org. Sandboxes and scratch orgs work without extra prompts.

---

## Your First Operation

Let's walk through a simple **Seed** operation to generate test data:

1. Navigate to **Seed** from the sidebar or Quick Actions
2. Choose a seed mode from the mode selector: **AI Generate**, **CSV Upload**, or **Clone from Org**
3. For **AI Generate**: Select your org, pick objects, set record counts, configure field rules, then execute
4. For **CSV Upload**: Select your org and object, drag-and-drop a CSV file, map columns, validate, then execute
5. For **Clone from Org**: Select source and target orgs, pick objects to clone, preview the insertion order, then execute
6. View results with per-object record counts, error details, and export options

![Seed Wizard](../assets/screenshots/getting-started-04.png)

The **NL2SOQL** helper in Step 1 lets you describe what you want in plain English (e.g., "All accounts created this month with more than 10 employees") and generates the SOQL query for you.

---

## What's Next

Now that you are up and running, explore the full capabilities of each module:

- [Seed](modules/seed.md) -- AI generation, CSV import, and org-to-org cloning with templates and dependency resolution
- [Sync](modules/sync.md) -- Bidirectional data synchronization between orgs
- [Monitor](modules/monitor.md) -- Real-time org health, API limits, and job tracking
- [Compare](modules/compare.md) -- Metadata diff, permission matrix, and drift detection
- [DataOps](modules/dataops.md) -- Backup, restore, anonymization, and data quality
- [Automation](modules/automation.md) -- Visual pipeline builder with scheduling

Have questions? Check the [FAQ and Troubleshooting](faq.md) guide.
