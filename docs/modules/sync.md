# Sync

Synchronize data between two Salesforce orgs with field mapping, transforms, and conflict resolution.

## Quick Start

1. Navigate to **Sync** from the sidebar (requires at least 2 connected orgs)
2. Select a source org and a target org, then choose direction and conflict strategy
3. Configure the object set -- pick which objects to sync and set batch sizes
4. Map fields between source and target using the drag-and-drop Field Mapper or auto-match
5. Add transforms (optional), review the Sankey flow diagram, then execute

## Features

### Org Selection and Configuration

- **Source and Target Orgs** -- Select from your connected orgs with OrgBadge indicators
- **One write direction** -- Records always flow source to target. _Bidirectional_
  reverses nothing: it adds a pass that reads the matching target records first
  and applies the conflict strategy before the write, which still goes to the
  target. To copy the other way, swap the source and target orgs: a
  configuration asking for _target to source_ is refused before it runs.
- **Full Sync Only** -- Every run syncs the complete object set; a configuration asking for incremental, delta or CDC is refused before it runs
- **No real-time sync or conflict review** -- The Sync page offers Sync, History and Schedules. Real-time (CDC) replication and the conflict list it would feed are not implemented, so their tabs are not shown
- **Four conflict strategies, all of which act** -- Source wins, target wins, newest wins (the target record only when both sides carry a readable `LastModifiedDate` and the target's is later; the source whenever either side has no readable `LastModifiedDate`, or the two are equal), or a field-level merge that starts from the target record and takes the source value of every conflicting field that has one. A strategy is read on a bidirectional run, the pass that reads the matching target records before writing. Manual review is not offered: the conflict list it would feed is not shown, and the strategy of that name resolves to the source values without ever showing a conflict

### Object Set Editor

- Add/remove objects to the sync scope
- Configure batch size per object
- Available objects are loaded from the source org schema
- A per-object WHERE filter may only filter: a clause carrying `LIMIT`, `OFFSET`, `ORDER BY`, `FOR UPDATE`, a subquery, a comment or a semicolon is refused, including one imported from an SFDMU `export.json`
- An upsert key (external ID) is a single field API name; an SFDMU composite key such as `Name;Parent.Name` is refused. An empty External ID box counts as no key

### Field Mapping

Two mapping interfaces work together:

- **Field Mapper** -- Visual drag-and-drop canvas showing source fields on the left and target fields on the right. Draw lines to create mappings, or click "Auto Match" to map fields with matching API names.
- **Field Mapping Canvas** -- Detailed table view with mapping type selection (Direct, Lookup, Formula, etc.) and per-mapping controls.

### Transforms

The Transform Builder lets you add data transformation rules that run during sync:

- String transforms (uppercase, lowercase, trim, regex replace)
- Date and number formatting
- A formula rule substitutes the field value into the token `VALUE` and
  evaluates the arithmetic; a field that is not a number, or a formula without
  `VALUE`, is left as it is. There is no conditional rule
- Every rule you add applies to all fields of all objects in the run, except
  `Id` and the external ID the run matches on, which are left as they are so a
  prefix or a truncate cannot send the write to a record that does not exist.
  Per-mapping rules exist in the configuration format, but no screen sets them
- Value mapping takes a table of replacements the builder has no box for, so a
  rule of that type leaves every value as it is

### Review and Sankey Flow

Before execution, the Review step shows:

- Summary badges for direction and conflict strategy
- Object count, field mapping count, and transform count
- PII warnings if sensitive fields are detected in the sync scope
- A **Sankey Flow Diagram** visualizing data flow from source objects through mappings to target objects
- A **Save** button, which stores the reviewed configuration under the two orgs it
  runs between. The configuration is checked as a run started by hand is, so one
  asking for _target to source_, for a mode other than full, or for manual
  conflict review is refused and nothing is stored. While the Sync page stays
  open, saving the same configuration again updates its entry. Once the orgs,
  objects, mappings, transforms or strategy change, or after the page is
  reopened, saving creates a new entry, so a schedule built on the first keeps
  running what it was built on. The saved confirmation disappears as soon as the configuration on screen
  differs from the one saved.

### Schedules

- A schedule runs a **saved** configuration, chosen from the ones the Save button
  stored. Each is listed by its name and the time it was saved, since a changed
  configuration is saved under the same name as the one before it. Until one exists, the Schedules tab says so, and a schedule can be
  neither created nor edited: there is no default configuration behind one.
- Editing a schedule whose configuration has since been deleted opens with no
  configuration picked, says the previous one no longer exists, and cannot be
  saved until one is chosen. A schedule naming a configuration that was never
  saved is refused.
- The check runs every 60 seconds and fires each schedule whose cron time has
  passed, once, however long the editor was closed.
- When the configuration a schedule names has since been deleted, the run is
  recorded as a failure at each of its run times, the next run time moves on, and
  -- if the schedule asks to be told about failures -- a notification says which
  configuration is missing. It is not retried every minute in silence.
- The two notification switches on a schedule raise a notification in each
  SandForge panel open at the time: with _Notify on completion_ on, one says the
  run started and another that it completed -- or, when some records failed, a
  warning that it completed with errors, with the first one; with _Notify on
  failure_ on, one says it failed, with the first error the run reported or, when
  it reported none, a pointer to its entry in the sync history. A run that fails
  in the sync engine is reported as failed, not completed. With no panel open, the
  outcome is in the SandForge output channel and in the schedule's last result.
- The Automation page's Scheduler tab lists the same schedules by the day each
  next runs, with the same buttons. Both ask for the list again once the
  soonest run is past, so the next run and the last result follow the runs
  while the tab is open.

### Execution and Results

- Before anything is written, both orgs are described and every field a mapping copies unchanged is compared (the same-named fields when the object has no mapping). A field that cannot hold the other's type -- text onto a date, a number onto a checkbox -- stops the run with the list of mismatched pairs, and nothing is written. A mapping whose value a transform rewrites is not judged on its source type
- Real-time progress bar with elapsed time
- Sequential per-object execution. With Grappe enabled and the source records,
  counted before the run, at or above `sandforge.grappe.autoActivateThreshold`,
  the run reports progress one partition per object over that same sequential
  loop -- nothing is split and nothing runs concurrently.
- That count costs API calls. With `sandforge.grappe.enabled` on, Sync sends one
  `SELECT COUNT()` per object of the run before anything is written, and each of
  those queries counts against the org's daily API request limit, production
  included. With the setting off, no count is sent.
- Per-object result breakdown: processed, succeeded, and failed counts
- Detailed error messages per object for troubleshooting

## Tips

- Use "Auto Match" in the Field Mapper first, then manually adjust the few fields that do not match
- Narrow the object set and batch sizes for recurring syncs -- every run reprocesses the full scope
- Files do not travel: Sync has no blob-transfer stage, so `Attachment`, `ContentVersion` and `Document` are not offered in the object picker, are absent from the prebuilt templates, and a configuration naming one is refused before it runs -- Bulk API 2.0 rejects base64, so such a run used to break past 200 records
- Always review PII warnings in the Review step before executing
- If sync fails on certain objects, check field-level security on the target org
- Use the Sankey diagram to verify data flow before execution
