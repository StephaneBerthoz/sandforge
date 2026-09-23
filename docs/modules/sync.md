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
- **Real-Time and Conflicts tabs** -- Besides Sync, History and Schedules, the page offers Real-Time, which follows the change events (Change Data Capture) the source org publishes and writes each change to the target as it comes, and Conflicts, which lists the real-time changes held for a decision. See [Real-Time](#real-time)
- **Four conflict strategies, all of which act** -- Source wins, target wins, newest wins (the target record only when both sides carry a readable `LastModifiedDate` and the target's is later; the source whenever either side has no readable `LastModifiedDate`, or the two are equal), or a field-level merge that starts from the target record and takes the source value of every conflicting field that has one. A strategy is read on a bidirectional run, the pass that reads the matching target records before writing. Manual review is not offered for a run: the strategy of that name resolves to the source values without ever showing a conflict. The Conflicts tab lists only real-time changes

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
  passed, once, however long the editor was closed and however many VS Code
  windows are open: the windows of one machine share which of them makes each
  run, as they do for pipeline triggers.
- When the configuration a schedule names has since been deleted, the run is
  recorded as a failure at each of its run times, the next run time moves on, and
  -- if the schedule asks to be told about failures -- a notification says which
  configuration is missing. It is not retried every minute in silence.
- The two notification switches on a schedule raise a notification in each
  SandForge panel open at the time: with _Notify on completion_ on, one says the
  run started and another that it completed -- or, when some records failed, a
  warning that it completed with errors, with the first one, and when it was
  cancelled from Live Operations, that it was cancelled; with _Notify on
  failure_ on, one says it failed, with the first error the run reported or, when
  it reported none, a pointer to its entry in the sync history. A run that fails
  in the sync engine is reported as failed, not completed. With no panel open, the
  outcome is in the SandForge output channel and in the schedule's last result.
- The Automation page's Scheduler tab lists the same schedules by the day each
  next runs, with the same buttons. Both ask for the list again once the
  soonest run is past, so the next run and the last result follow the runs
  while the tab is open.
- A schedule is refused when it is saved, with the reason, if SandForge cannot
  read its cron expression or if no date of the coming year matches it: the
  31st of February or April never comes, and 29 February only once in four
  years.

### Real-Time

- **What it follows** -- The tab asks the source org which objects publish
  change events: the answer is the org's own list of Change Data Capture channel
  members, and each object is shown with the channel it is listed on. Only
  those can be watched: to add another, select it in Setup → Change Data
  Capture on the source org. When the org lists none, the tab says so and
  offers nothing to start.
- **What the org refuses** -- An object the org does not publish change events
  for is refused when the session starts, and the tab shows the org's answer
  word for word -- on a sandbox with Account unselected,
  `403::User not allowed to subscribe CDC without required permissions` --
  beside the objects it did accept.
- **Watched or written** -- A ticked object's changes appear in the feed as
  they come. Tick _Auto-Sync_ for it and they are also written to the target,
  through the path a Sync run writes with: only the fields the target lets the
  running user write, a record type the user cannot use left to the platform,
  a lookup the target cannot take dropped rather than the record. A session
  that writes asks the Production Guard first, a deletion counting as
  destructive.
- **How the target record is found** -- by an external id of the target object,
  filled from the source field of the same name; by the record Id, which only
  finds the records that existed when the two orgs were copied from the same
  production (one made since is reported as not written, with that reason); or
  by the mapping of a Sync configuration saved between the same two orgs -- its
  external id, field mappings, transforms and add-on fields. A change is always
  upserted on that key, or updated by Id, whatever operation the saved
  configuration names.
- An update of a record the target does not have yet copies the whole source
  record, not the one field that changed.
- **Deletions** -- only for an object whose _Apply deletions_ box is ticked.
  The deleted record is read back from the source's recycle bin to find its
  key; one no longer there is reported as not written, with that reason.
- **A target edited after the change** -- Before writing, the target record is
  read. When it was edited after the change was made, and not by the session,
  the change collides with that edit and the conflict strategy decides: source
  wins writes it; target wins keeps the edit, and so does newest wins, since
  the target's edit is the newer one; merge writes only what the source did not
  clear; manual holds the change on the Conflicts tab, to be decided field by
  field or all at once. A held change is decided while its session runs:
  stopping the session drops it, and a notification says how many were
  dropped.
- **Its own writes** -- Every write of a session announces itself to the org
  as the `SandForgeRealtime` client, and the org records that in the change it
  causes. Such a change is shown as written by the session and never applied
  again, so a session between one org and itself, or two sessions writing
  toward each other, do not echo forever.
- **Stopping and resuming** -- After each batch the session stores, per
  channel, where it got to. The next session on the same source org resumes
  right after it, so changes made while nothing was listening are replayed;
  what was received and not yet written when a session stopped is replayed
  too. The org keeps change events for three days: a resume point it no longer
  holds is replaced by every change it still holds, and the tab says so. A
  sandbox refresh forgets the stored points.
- **One session at a time** -- It runs in the extension, not in the panel:
  closing the panel does not stop it, reopening the tab finds it, Live
  Operations lists it and its Cancel stops it. A connection the org closes --
  an expired session -- is reopened from the stored points, three times at
  most, before the session stops in error with the org's answer.
- The feed says what became of each change: written, not written (with the
  target's refusal), watched only, target edit kept, held for a decision,
  deletion left alone, or the session's own write coming back. A change the org
  could not describe in full arrives without its values and is read back from
  the source; an overflow notice in its place is reported as not written, and a
  Sync run brings the target up to date.

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
