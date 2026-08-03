# Seed

Generate realistic test data in your Salesforce sandboxes with AI, Faker profiles, CSV import, org-to-org cloning, or reusable templates. Seed handles object dependencies automatically and includes built-in PII detection to keep sensitive fields anonymized.

SandForge offers three Seed modes accessible from a card-based mode selector:

- **AI Generate**: Use the 8-step Seed Wizard or Quick Seed from a template gallery to generate data with AI, Faker profiles, or templates
- **CSV Upload**: Import data from a CSV file with auto column mapping, validation, and a 4-step wizard
- **Clone from Org**: Clone records from a source org into a target org with relationship-ordered insert and ID mapping

## Quick Start

1. Navigate to **Seed** from the sidebar
2. Choose a seed mode: **AI Generate**, **CSV Upload**, or **Clone from Org**
3. Follow the guided wizard for your chosen mode
4. View results with per-object record counts, error details, and export options

## Seed Modes

### AI Generate (Seed Wizard)

The classic 8-step wizard for AI-powered data generation:

- **Step 1 -- Select:** Choose an org, pick objects from the schema list, and set record volumes. The NL2SOQL helper lets you describe what you need in plain English.
- **Step 2 -- Configure:** Customize field generation rules per object. Adjust batch sizes, configure parent-child relationships, and review PII warnings.
- **Step 3 -- Execute:** Real-time progress tracking per object with a live progress bar.
- **Step 4 -- Results:** Summary badge (success/partial/failure), records created vs. failed, per-object breakdown. Save as template, export CSV, or seed again.

**Quick Seed** lets you skip configuration entirely: select a template from the gallery, pick your org, and seed in 1 click.

### CSV Upload

Import data from a CSV file with a 4-step wizard:

- **Step 1 -- Upload:** Select your target org and object, then drag-and-drop a CSV file (or use the file picker). A preview of the first 10 rows is shown immediately.
- **Step 2 -- Map Columns:** CSV headers are auto-matched to Salesforce fields using case-insensitive, underscore-tolerant matching. Override any mapping with a dropdown. Status indicators show matched, unmapped, and type-incompatible columns.
- **Step 3 -- Validate:** Records are validated against Salesforce field metadata: type mismatches, missing required fields, length violations, invalid picklist values, and duplicate external IDs. Errors are grouped by type in accordion sections. Proceed if validation passes or if the error rate is below 10%.
- **Step 4 -- Execute:** Records are inserted via the Seed pipeline. View per-object results on completion.

**Supported formats:** UTF-8 CSV with headers. BOM is stripped automatically. Papaparse handles parsing with `dynamicTyping: false` for predictable type conversion.

### Clone from Org

Clone records from one Salesforce org to another with a 4-step wizard:

- **Step 1 -- Source Org:** Select the source org (all connected orgs except the current target). A visual indicator shows the source-to-target direction.
- **Step 2 -- Select Objects:** Browse objects from the source org with a searchable list. Check objects to clone and optionally add a SOQL WHERE clause per object to filter records (e.g., `Industry = 'Technology'`).
- **Step 3 -- Preview:** View the insertion order (topological sort of dependencies), record counts per object, and sample records. A warning appears for clones exceeding 10,000 records.
- **Step 4 -- Execute:** Records are fetched from the source org (cursor-based pagination, 2000/batch), relationships are remapped, and records are inserted in dependency order. Per-object progress is shown during execution. Results include an ID mapping table (source ID to target ID) with CSV export.

**Self-referential objects** (e.g., Account.ParentId) are handled with a two-pass insert: first pass inserts records without self-references, second pass updates self-referential fields with remapped IDs.

## Features

### Forge (Graph-Based Discovery)

The Forge page provides a richer workflow with four input modes:

- **Record** -- Paste a Record ID or Salesforce URL, preview the record live, then discover its full dependency graph
- **SOQL** -- Write a SOQL query to define the seed scope
- **Template** -- Select a saved template for repeatable operations
- **AI** -- Describe what you need in natural language and let the AI build the seed plan

After input, the Discovery phase renders an interactive dependency graph in a split view. Click any node to inspect fields, toggle inclusion, and configure anonymization per field.

### AI and NL2SOQL

- NL2SOQL translates natural language into SOQL with schema validation
- AI Data Generation creates context-aware realistic values using OpenAI, Anthropic, or Ollama
- PII Scanner auto-detects sensitive fields (email, phone, address, SSN, etc.) with confidence scores

### Dependency Resolution

- Automatic topological sort of parent-child relationships before insert
- Cycle detection with clear error messages
- Visual relationship editor in Advanced Settings
- Configurable depth: Direct (1 level), Full (all levels), or Custom (N levels)

### Templates and Export

- Save any seed configuration as a reusable template
- Export results to CSV for external reporting
- Template Engine supports JSON/CSV with variable interpolation

## Tips

- Use **CSV Upload** when you have existing data in spreadsheets or exports from other systems
- Use **Clone from Org** to replicate production data into a sandbox with full relationship integrity
- Use **AI Generate** when you need realistic but synthetic data (no production data exposure)
- Start with Quick Seed for simple operations; use Forge when you need cross-org cloning or complex dependency graphs
- Enable "Anonymize PII" in Forge to automatically mask sensitive fields during cloning
- Use the NL2SOQL helper when you are unsure which SOQL filter to apply
- Keep batch sizes at 200 (the default) unless you hit governor limits, then reduce
- Check PII warnings before executing -- amber badges highlight fields that may contain personal data
