# Seed

Generate realistic test data in your Salesforce sandboxes with AI, Faker profiles, CSV import, org-to-org cloning, or reusable templates. Seed handles object dependencies automatically and includes built-in PII detection to keep sensitive fields anonymized.

SandForge offers three Seed modes accessible from a card-based mode selector:

- **AI Generate**: Use the 4-step Seed Wizard or Quick Seed from a template gallery to generate data with AI, Faker profiles, or templates
- **CSV Upload**: Import data from a CSV file with auto column mapping, validation, and a 4-step wizard
- **Clone from Org**: Clone records from a source org into a target org with relationship-ordered insert and ID mapping

## Quick Start

1. Navigate to **Seed** from the sidebar
2. Choose a seed mode: **AI Generate**, **CSV Upload**, or **Clone from Org**
3. Follow the guided wizard for your chosen mode
4. View results with per-object record counts, error details, and export options

## Seed Modes

### AI Generate (Seed Wizard)

The classic 4-step wizard for AI-powered data generation:

- **Step 1 -- Select:** Choose an org, pick objects from the schema list, and set record volumes. The NL2SOQL helper lets you describe what you need in plain English.
- **Step 2 -- Configure:** Customize field generation rules per object and review PII warnings. Each described field opens on a rule the run accepts: a Faker method chosen from the field's type and name (an email address on an email field, a sentence on a text field with no better match), and no Faker rule at all on a checkbox or another type no generator fits. A field of one of those other types -- a multi-select picklist, a time field -- opens with no value, so a required one still has to be filled in before the run, or its records fail on it. A number is drawn within the digits the org says the field holds, and a percentage up to 100; a latitude or longitude opens with no value, since one drawn at random would point nowhere near the address generated beside it. A Faker rule takes its method from the list of methods SandForge generates; a template or persona that names any other method is refused before the first record is written, with the object and field it sits on. A generated or AI-written value longer than the field is cut to the field's length, at a word boundary when there is one. A lookup field receives the ids of records its target object created earlier in the same run, so that object has to be part of the run; an optional lookup to an object outside the run, such as an owner, is left out of the run and keeps whatever the org puts there, and so is an optional lookup to the object itself, such as an account's parent, which the insert writing the object cannot fill; and so is an optional lookup that would make two objects of the run wait on each other, such as a custom lookup from an account to a contact while the contacts point at their accounts -- a standard lookup is kept before a custom one, and otherwise the one pointing at the object picked first; a required one is still sent, so the run is refused before it writes anything and names the object the lookup points at. Under **Advanced Settings**, a relation fills one lookup of an object from a parent object's records -- the ones this run creates, or records already in the org, picked by a SOQL filter and bounded by a number of parents you set -- and gives each parent exactly N children, a random number between two bounds, or an average spread evenly (0.5 gives a child to every other parent). The relation decides how many records its child object gets, in place of the count set on the first step, and says under its row how many it plans; an object takes its count from one relation at most. A relation the run cannot honour -- parents written after the child, a spread that makes no child -- keeps the wizard on this step. The run writes the parents first and gives each child the id its parent got; a child whose parents could not be written or found is not written at all.
- **Step 3 -- Execute:** Progress is reported as each object starts, with the records written so far and a live progress bar. With fewer than five objects the wizard comes here straight from Step 1: the objects' fields are read on this step, with the same default rules Step 2 would show, and the run waits until every object is read. A banner says the run uses those default rules, with the persona's patterns when one was picked, and links back to Step 2; the relations are set on this step.
- **Step 4 -- Results:** Summary badge (success/partial/failure, or cancelled for a run stopped with Cancel -- the records it created stay in the org and are counted), records created vs. failed, per-object breakdown. Save as template, export CSV, or seed again.

**Quick Seed** lets you skip configuration entirely: select a template from the gallery, pick your org, and seed in 1 click. Opened from the Home recommendation, the org the confirmation named is already selected, as long as it is still connected; the selection step still shows it and nothing is written until you start the run.

### CSV Upload

Import data from a CSV file with a 4-step wizard:

- **Step 1 -- Upload:** Select your target org and object, then drag-and-drop a CSV file (or use the file picker). A preview of the first 10 rows is shown immediately.
- **Step 2 -- Map Columns:** CSV headers are auto-matched to Salesforce fields using case-insensitive, underscore-tolerant matching. Override any mapping with a dropdown. Status indicators show matched, unmapped, and type-incompatible columns.
- **Step 3 -- Validate:** Records are validated against Salesforce field metadata: type mismatches, missing required fields, length violations, invalid picklist values, and duplicate external IDs. Errors are grouped by type in accordion sections. Proceed if validation passes or if the error rate is below 10%.
- **Step 4 -- Execute:** Records are inserted via the Seed pipeline. View per-object results on completion. The audit trail records an import cancelled before its first row as **stopped**, under `IMPORT_CANCELLED`, and one cancelled once a row went in as partial.

**Supported formats:** UTF-8 CSV with headers. BOM is stripped automatically. Papaparse handles parsing with `dynamicTyping: false` for predictable type conversion.

### Clone from Org

Clone records from one Salesforce org to another with a 4-step wizard:

- **Step 1 -- Source Org:** Select the source org (all connected orgs except the current target). A visual indicator shows the source-to-target direction.
- **Step 2 -- Select Objects:** Browse objects from the source org with a searchable list. Check objects to clone and optionally add a SOQL WHERE clause per object to filter records (e.g., `Industry = 'Technology'`). Next asks for the preview, which needs a target as well as a source: the target is the org selected in SandForge, and with none selected Next stays disabled and the step says to pick one on the Organizations page.
- **Step 3 -- Preview:** View the insertion order (topological sort of dependencies), the lookups a second pass fills in (see below), record counts per object, and sample records. The order and those lookups are read as the run reads them: from the target org's describe, and only from the lookups the source org's describe has too. A lookup only the target has is never read, so it orders nothing and every record goes in with it empty; one the target requires -- a master-detail, or a lookup made required, deployed to the target alone -- is named above Execute, as the target will refuse every record of its object. A lookup only the source has is listed apart: the target has no field for its values, and the clone leaves them out of every record. An object either org cannot describe stops the preview, which names the object and the org, as it would stop the run before anything is written. A warning appears for clones exceeding 10,000 records. The run goes to the orgs the preview was made for: select another org after it and the preview is set aside, the wizard says why, and Next previews again for the org selected now. The extension refuses a run that is not for the orgs of the preview it follows, before reading either org.
- **Step 4 -- Execute:** Execute, or Next on the preview, runs the clone and shows it running; the wizard stays on the run until it ends. Records are fetched from the source org (cursor-based pagination, 2000/batch), relationships are remapped, and records are inserted in dependency order. A field the target org does not have is left out of every record -- sent, the org would refuse the whole record -- and the results name it under its object. Per-object progress is shown during execution. Results open on a badge saying how the clone ended -- complete, partially complete or failed -- and include an ID mapping table (source ID to target ID) with CSV export. A clone stopped with Cancel reads Cancelled instead: the results say how many records it had created, which stay in the target org, list only the objects it reached, and, when the cancel came before its second pass, say that the lookups it owed stay empty. A clone that fails, including one the production guard blocks or whose confirmation you decline, shows its error as soon as the extension reports it; a request SandForge refuses before reading either org, such as a filter that does more than select records, is said in words, and the SandForge output channel names the part it refused. A clone that ends without results goes back to its preview, to run again; dismissing its error keeps the objects picked and the preview.

**Self-referential objects and cycles** (e.g., Account.ParentId, or an account's key contact while each contact points at its account) are written in two passes, as Forge writes them: the records go in with those lookups empty, and a second pass fills them in once the record they point at is in the target. An account's parent the clone does not copy is sent as it was read, like any lookup at a record outside the clone. The results say how many lookups the second pass filled in, and why it could not fill the others -- a cycle's lookup at a record that was never cloned stays empty. Only a cycle of lookups that must be set when the record is created -- required, or not updatable -- stops the clone, before anything is written, with the lookups named.

## Features

### Forge (Graph-Based Discovery)

The Forge page provides a richer workflow with three input modes, and a fourth shown as coming soon:

- **Record** -- Paste a Record ID or Salesforce URL, preview the record live, then discover its full dependency graph
- **SOQL** -- Write a query to pick the root object. Its WHERE clause filters the
  object after FROM, and discovery counts the rows it matches. Only that object is
  filtered: related objects in the graph are not narrowed to the matching rows, and
  each one is read from its whole table. Every object is capped at 200 records or
  fewer per run. ORDER BY, LIMIT and the other clauses after WHERE are not applied.
  A WHERE clause longer than 512 characters, containing `--`, `/*` or `*/` (even
  inside a quoted value), or ending with a semicolon cannot be sent: the page says
  so under the query and Discover stays disabled until it is rewritten.
- **Template** -- Select a saved template for repeatable operations. A template
  saved from a SOQL query runs as that query, on Discover and on Reuse last graph
  alike: its WHERE clause filters the object after FROM, every object is capped at
  200 records or fewer, and a clause that cannot be sent keeps Discover disabled and
  Reuse last graph hidden.
- **AI** _(coming soon)_ -- The tab is shown but cannot be opened: nothing turns a
  prompt into a seed plan yet. A past AI run reopened from the history opens on
  **Record**.

After input, the Discovery phase renders an interactive dependency graph in a split view. Click any node to inspect fields, toggle inclusion, and configure anonymization per field.

**Recent runs**, under the input form, lists the last runs: each refills the form, and a run that created records — finished, or stopped part way by a failure or a cancel — can remove them from the org it wrote to, children before their parents, keeping the records it linked to and, unless you ask, the ones changed or added to since the run — see [Forge: remove what a run created](../forge-quickstart.md#remove-what-a-run-created).

### AI and NL2SOQL

- NL2SOQL translates natural language into SOQL. It describes up to five objects your request names, gives the model their field API names, and rejects a draft that selects a plain field they do not have -- a relationship path such as `Account.Name`, and any item carrying a bracket such as `COUNT(Id)`, are left to the org to judge. A draft where no plain field was compared comes back with a line saying so, naming the case: no object the org recognises was named, or the draft selects nothing but related-record paths and totals
- AI Data Generation creates context-aware realistic values using Anthropic (Claude); additional providers are planned. When AI is off, or a call is refused (missing key, token budget) or returns fewer values than asked, the fields it left empty receive a generated sentence instead and the run continues; the results step names those fields on the object that received them, and the refusal is written to the SandForge log. Because the value is always text, the wizard offers AI generation only on text and long text fields, and a run whose rules name a number, date, checkbox, email or picklist field type for it is refused before the first insert (wizard runs always name the field type; a template that omits it is not checked)
- Personas you create from a description keep only the patterns Seed can generate: a pattern naming an unknown generator or Faker method is dropped, and numeric params written as text are read as numbers
- PII Scanner auto-detects sensitive fields (email, phone, address, SSN, etc.) with confidence scores

### Dependency Resolution

- Automatic topological sort of parent-child relationships before insert
- Cycle detection with clear error messages
- Lookup fields point at records their target object inserted earlier in the same run, picked at random; a relation places each child under a parent instead -- one this run creates or one already in the org -- with the number of children per parent it sets
- Configurable depth: Direct (1 level), Full (all levels), or Custom (N levels)

### Templates and Export

- **Save as template** on the results step stores the configuration the run just used -- its objects, record counts, field rules and relations -- under the objects and the date. It is added to the gallery, next to the pre-built templates, and never overwrites one already there. A save the host refuses shows its reason next to the button
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
