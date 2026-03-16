# Seed

Generate realistic test data in your Salesforce sandboxes with AI, Faker profiles, or reusable templates. Seed handles object dependencies automatically and includes built-in PII detection to keep sensitive fields anonymized.

SandForge offers two Seed experiences. The **Seed Wizard** is a streamlined 4-step flow for quick data generation. The **Forge** page adds a graph-based discovery phase with source-to-target org cloning. Both share the same execution engine.

## Quick Start

1. Navigate to **Seed** from the sidebar
2. Select your target org and pick one or more objects (Account, Contact, Opportunity, etc.)
3. Set the record count per object using the inline volume inputs
4. Review field rules in the Configure step, then click Execute
5. View results with per-object record counts and export to CSV

## Features

### Seed Wizard (4-Step Flow)

- **Step 1 -- Select:** Choose an org, pick objects from the schema list, and set record volumes. The NL2SOQL helper lets you describe what you need in plain English and generates the SOQL query.
- **Step 2 -- Configure:** Customize field generation rules per object. Adjust batch sizes, configure parent-child relationships, and review PII warnings in the Advanced Settings accordion.
- **Step 3 -- Execute:** Real-time progress tracking per object with a live progress bar.
- **Step 4 -- Results:** Summary badge (success/partial/failure), records created vs. failed, execution time, per-object breakdown with error details. Save as template, export CSV, or seed again.

### Forge (Graph-Based Discovery)

The Forge page provides a richer workflow with four input modes:

- **Record** -- Paste a Record ID or Salesforce URL, preview the record live, then discover its full dependency graph
- **SOQL** -- Write a SOQL query to define the seed scope
- **Template** -- Select a saved template for repeatable operations
- **AI** -- Describe what you need in natural language and let the AI build the seed plan

After input, the Discovery phase renders an interactive dependency graph in a split view. Click any node to inspect fields, toggle inclusion, and configure anonymization per field. Stats (objects, records, estimated size, estimated duration) update in real time.

### AI and NL2SOQL

- NL2SOQL translates natural language into SOQL with schema validation
- AI Data Generation creates context-aware realistic values using OpenAI, Anthropic, or Ollama
- PII Scanner auto-detects sensitive fields (email, phone, address, SSN, etc.) with confidence scores

### Dependency Resolution

- Automatic topological sort of parent-child relationships before insert
- Visual relationship editor in Advanced Settings
- Configurable depth: Direct (1 level), Full (all levels), or Custom (N levels)

### Templates and Export

- Save any seed configuration as a reusable template
- Export results to CSV for external reporting
- Template Engine supports JSON/CSV with variable interpolation

## Tips

- Start with the Seed Wizard for simple operations; use Forge when you need cross-org cloning or complex dependency graphs
- Enable "Anonymize PII" in Forge to automatically mask sensitive fields during cloning
- Use the NL2SOQL helper when you are unsure which SOQL filter to apply
- Keep batch sizes at 200 (the default) unless you hit governor limits, then reduce
- Check PII warnings before executing -- amber badges highlight fields that may contain personal data
