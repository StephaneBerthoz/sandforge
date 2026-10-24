# Changelog

All notable changes to SandForge will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.66.0] - 2026-10-23

Checkpoints: keep an org's data as it is now, see what changed since, and put the org back as it was, whoever made the changes, then take the rewind back if you need to.

With it, the backlog's leftovers: what real runs against sandboxes, scratch orgs and Developer Edition orgs found in Forge, Sync, Seed, Frozen Dataset, DataOps and Autopilot.

### Added

- **Checkpoints**: a new module, third in the side bar and on Home. Take a checkpoint of a sandbox, a scratch org or a Developer Edition org, of everything people work in or of the objects you pick, with what it will take before it runs; it keeps the records' values on this machine for 30 days, or until you delete it.
- **Rewind**: the preview says what a rewind would delete, give back and bring back, object by object, who last changed it, what a rewind cannot take back and what Undo could not bring back, the records outside the checkpoint that would go with it, the automation it fires and what it costs. The rewind is confirmed by typing the org's alias, can be stopped and taken up again, reads the org again at the end and names every record that still differs, with why.
- **Undo this rewind**: for 15 days, sooner if the recycle bin fills, takes back what the rewind deleted, wrote over and brought back; what anyone changed since stays, and is named.
- **Take a checkpoint now**: on the result of a Seed run, a Forge clone and a Frozen load that wrote to a sandbox, a scratch org or a Developer Edition org.
- **Command line**: `sandforge-checkpoint` takes, lists, previews, rewinds and undoes, with `--estimate`, `--dry-run`, `--fail-on-change` for a CI step, the typed alias or `--yes` with a named checkpoint, and the exit codes of the other tools.
- **Rewind and Undo**: count the emails their writes would make the org send, per daily limit, in the preview and the command line, and are refused past what the org has left today — on a Developer Edition, 15 single emails, its email alerts among them; no box lifts it.
- **Rewind**: records deleted since that the recycle bin no longer gives back — emptied from it, or kept there for good — are made again from the checkpoint with new Ids once **Make them again, with new Ids** is ticked (`--accept-recreate` on the command line); every lookup the checkpoint holds that named one names its new Id, the preview says what a new Id breaks outside Salesforce, Undo deletes them again, and a later rewind never takes them for records created since. A file, whose body the checkpoint does not hold, stays gone for good. A record Salesforce still lists in the recycle bin once emptied from it, which only its undelete's answer tells, is made again too, with what was to come back with it — the box is offered whenever the rewind brings records back — and left and named without it; Undo says what it deleted again of what the rewind made again.
- **Forge Gaps tab**: _For the target's admin_ lists what the target's metadata would need for the rows to go in as they are — a picklist value to add to a record type, a field to lengthen, a rule to turn off — by object and record type, each with its step in Setup, and copies it; `sandforge-clone --dry-run --json` gives it under `adminChanges`. SandForge changes none of it.
- **Seed Configure**: a Set by me filter lists the fields whose rule or value you changed.
- **Frozen extraction**: the result lists the fields it keeps unmasked with no rule, and **Clear these** writes a `clear` rule for each into the rules file, its version moved on, for the next extraction to clear.
- **Clone of whole tables, command line**: `sandforge-clone --object … --upsert` writes over by external id, a page at a time. Each table's pages go by one external id, the first whose value every row it reads holds and no two share, read before the first page; a page whose rows as written would repeat a value is inserted instead.

### Changed

- **Confirmations and dialogs**: give the keyboard back to the button that opened them, on every page.
- **Disconnect**: offers to delete the org's checkpoints too.
- **Sandbox refresh notice**: names the checkpoints kept of the org before the refresh.
- **Rewind preview**: counts a contract activated since, and a record deleted with one created since, among what a rewind cannot undo; the rewind leaves both as they are and says why.
- **Checkpoints**: a take, a rewind and an undo are also refused while a Frozen load or its removal, a DataOps restore, masking run or erasure, an Autopilot run or a Real-Time session of the window writes to the org.
- **Sync, command line**: `--remove` says what the target runs as it brings records back, gives them their values back, sets them back to Draft and deletes them, and writes nothing without `--accept-automation`, as the clone's removal does.
- **Forge confirmation before writing**: shows beside each object what the last simulation of the same clone counted, and asks whatever the volume when the run writes more than twice that, or 500 records more.
- **Forge reads**: a field left out of the rows is no longer read from the source, except lookups and the few fields the run needs for its own work.
- **Production writes**: Seed, Sync, Autopilot and DataOps ask before every write to a production org; `sandforge.safety.requireProdConfirmation` no longer turns that question off and is marked no longer used.
- **Sign-in**: a JWT or device sign-in reads its org back with `sf org display`, which calls that org alone, and types it from what the org says it is; `sf org list` called every org the CLI holds.
- **Autopilot review**: says, with no compliance framework picked (still the default), that names and the other personal fields go in as the source holds them, and where to pick a framework.
- **Migration and Automation**: open with 3 kB of English for the words they share with Sync and Compare (object set, schedules, org and category pickers) instead of those modules' 39 kB; Automation parses 714 kB before it paints instead of 748, Migration 688 instead of 714.
- **Browser sign-in**: registers only the org signed in to, read on its own, instead of contacting every org the Salesforce CLI holds and registering them all; Import from Salesforce CLI still imports them all.

### Fixed

- **Sync removal**: the confirmation says what the target runs as the run is taken back, the Apex triggers after an undelete among it.
- **Undo this rewind**: what came back with a record — a contact with its account, a product with its opportunity — goes back to the recycle bin with it, never on its own, so the record brought back later brings it back too.
- **Undo this rewind**: a record whose lookup the undelete puts back, on a field the checkpoint does not compare, gets its values back instead of being kept as changed since the rewind.
- **Undo this rewind**: plans from the journal on disk, a page at a time; an undo of a rewind of a million records no longer holds every id in memory.
- **Checkpoint guide**: names an object past the take's limit among what a take leaves out.
- **API requests**: a Bulk API job is counted by the calls it sends — opened, sent, closed, each read of its state and of its results — in what a take, a rewind and an undo say they sent, and a rewind or an undo past 10,000 deletes of an object is priced by its jobs' calls rather than as REST calls of 200 records.
- **Command line**: a flag given no value — another flag after it, or nothing — is refused with exit 2 before any org is reached; `--target --dry-run` logged in to an org named `--dry-run`, and a flag last on the line ran with its default.
- **Sync, command line**: the `--json` summary names the records a delta run deleted, and `--remove` from that summary alone brings them back from the recycle bin.
- **sandforge-backup**: `--list` reads the store alone; without `--org` it lists every org's snapshots, each with its org, and with `--org` only that org's.
- **Forge Execute and Clone directly**: ask before writing when the target will not say how much is left of a daily email limit its flows count against, as Autopilot does.
- **Forge, whole tables read with a cap**: a record type closed to the user the run writes as holds an object back only when it is among the rows the run reads.
- **Forge, objects without record types**: _Hold back these rows_ and _Write another value_ now apply to their rows; the command line says when a `--config` decision to hold back rows is ignored, and why.
- **Autopilot**: a selected object of more than 50,000 records is copied to its first 50,000 by Id whether or not it has lookups to follow, and the plan says so.
- **Seed**: a way to seed whose file could not be loaded says so in its place, with Reload panel, and the gallery and the way back stay up.
- **sandforge-seed --remove**: says what the target's automation runs as it deletes, and deletes nothing without `--accept-automation`.
- **Sync**: asks before writing when the target will not say how much is left of a daily email limit its Flows count against, or when its automation could not be read, as Forge and Autopilot ask.
- **Sync, Frozen load, Clone from Org, CSV Upload**: rows a duplicate rule refused in a Bulk API job, which cannot carry the header that lets a rule's matches be saved, go again through REST with it; a rule that only alerts lets them be saved, one that blocks still refuses them, and the output says how many were saved.
- **Sync removal**: a record someone else changed between two runs of the same target is no longer taken for the later run's write; the earlier run's removal keeps it as changed since unless you include the changed ones.
- **Sync**: a classic encrypted field the source user sees masked (no View Encrypted Data) is left out of every record written instead of being copied as its mask; Review warns of it, and the results, the simulation, the history and the command line name it.
- **DataOps backup**: no longer keeps the masks of encrypted fields the user cannot view, which a restore wrote back over the real values; the Backup tab names the fields not kept.
- **DataOps backup and Forge**: a record of an object too wide for one query that is saved or deleted while it is read is read again or left out, never kept or copied with the values of two saves.
- **Removals**: a removal stopped part way names what it never reached, object by object, an object it never got to included, in its result, on the command line and in the audit trail — Forge, Frozen, Seed and Sync alike.
- **Removals**: for an object your user may not delete, a record already deleted counts as gone, not refused, and an object with nothing left is not asked about.
- **Import from the CLI**: an org whose CLI login holds no edition is asked what it is, so a Developer Edition org or a sandbox no longer comes in as a production org until reconnected.
- **Error hints**: an INSUFFICIENT_ACCESS refusal no longer calls a refused read a write, as on the Real-Time tab's list of objects, in all six languages.
- **Forge, the Frozen extraction, Clone from Org and Real-Time**: a classic encrypted field the user SandForge reads the source as sees masked, lacking View Encrypted Data, is left out of every record written rather than copied as its mask, and the results, the command line and the page name it. A Frozen dataset records it as not kept.
- **Sync and Autopilot**: a run asks before it writes when the target's flows, processes or workflow rules could not be read, saying their emails were not counted.
- **Autopilot**: asks before it writes when the target's automation could not be read, as Sync does, instead of only logging it.
- **Autopilot command line**: a selected table cut to its first 50,000 records is no longer also listed as copied whole.
- **Autopilot**: the person accounts of a cut table are counted among the records the run copies, not across the whole table.
- **Sync removal**: gives back a record whose lookup the removal's undelete put back, instead of keeping it as changed since the run.
- **Forge rehearsal**: a restricted picklist value refused for a record type is now listed for the target's admin as a value to select for that record type, and one missing from the field as a value to add.

Never a production org: a checkpoint, a preview, a rewind and an undo are refused there outright, whatever the setting or flag.

## [1.65.0] - 2026-10-22

What a run would be refused is said before it writes, the command-line tools refuse production and stop on what they cannot read, and a run stays safe to take back across windows and runs.

### Added

- **Command line**: one table of exit codes for every tool, refused, partial and failed told apart, with `--fail-on-partial` and `--fail-on-drift`; a Seed run keeps a run file and can be removed after a kill; SIGTERM stops a run as Ctrl-C does.
- **API requests**: Seed, Sync, Autopilot, CSV Upload and Clone from Org compare the run with what the org has left for the day before writing.
- **CSV Upload**: its limits are said as the file is read; columns map through one list.
- **Seed Configure**: long field lists can be filtered, or narrowed to the required fields.
- **DataOps Restore**: restoring a Sync run's backup leaves the records changed or deleted since unless you include them; `--include-changed` on the command line.

### Changed

- **Command line**: refuses to write to a production org, and the cleanup refuses to delete there; an unknown flag, or a flag given a value it does not take, stops the command before any org call; a question with no terminal to answer it ends the command; the CI guide authenticates with an SFDX auth URL or a JWT.
- **Wide objects**: read in column groups, so Forge, Frozen, Sync, DataOps backup and Clone from Org copy objects too wide for one query.
- **Seed**: writes a large object slice by slice; at most 1,000,000 records per object.
- **Pages**: fetch what they need before their first paint; a part that fails to load says so with Reload panel, inside that part.
- **Reports, Help**: keep their tab, filters and open section when hidden.
- **Monitor**: no longer dims its panels while it reads.
- **Autopilot**: says when it copies only the first records of a large object.

### Fixed

- **Permissions**: a field hidden by field-level security is named as such, and the objects the target user cannot create, edit or delete are said before the run writes; an expired scratch org says so.
- **Sync**: a second VS Code window no longer stops or removes a run another window is writing; the earlier of two runs over the same records can be removed after the later one; a delta run's deletions are brought back when it is removed.
- **Forge**: removing a resumed run part by part leaves no parent record behind.
- **Panels in another language than English**: keep the launcher's import or sign-in and What's New.
- **Organizations**: the import from the Salesforce CLI names each org it could not reach.
- **Command line**: `sandforge-compare --validate` fails the pipeline when the check-only deployment fails; `sandforge-cleanup --since` selects from the date given.

## [1.64.0] - 2026-10-22

What a Sync update writes over can now be taken back, a Sync run from the command line can be removed even when it was killed, and every page opens under 900 kB.

### Added

- **Sync**: what an update, or an upsert that found the record, writes over is kept first; removing the run gives the records their values back, a record changed since left as it is unless you include it. The confirmation, the dry run and the results count the records written over.
- **Command line**: `sandforge-sync` keeps a run file, so a run killed, stopped with Ctrl-C or failed part way can be removed with `--remove <run file or id>`.
- **DataOps Restore**: a backup a Sync run kept is labelled as such.

### Changed

- **Pages**: each opens under 900 kB; Forge's later steps, its graphs, Reports' analytics and lineage, Monitor's charts and Sync's schedules load when they are shown.
- **Sync removal sweep**: its window runs to the run's last write, and a run that only wrote over records is swept too.
- **DataOps**: keeps its panels drawn while it reads again.
- **Translations**: Spanish names the pre-check step one way; None and Custom are translated.

### Fixed

- **Sync**: a Bulk job that failed after the org opened it stays with its run and is removed with it.
- **Forge**: removing a resumed run part by part also removes the parent record one part wrote for the other.
- **Real-Time**: starting a session no longer leaves unhandled errors behind.
- **Keyboard**: Seed's Read again, the Retry buttons, Monitor's Refresh and DataOps' Delete keep the focus.
- **Command line**: `sandforge-seed` names its templates.
- **DataOps Restore**: restoring a Sync run's backup no longer sends a record twice.

## [1.63.0] - 2026-10-21

Every run that writes can be taken back, CSV imports and clones included, even when its window closed in the middle of a write; Sync keeps the lookups between objects that point at each other, and every page loads lighter.

### Added

- **CSV Upload, Clone from Org**: what they create is listed in Earlier seeds and can be removed, as a seed is.
- **Sync removal**: can sweep what the target's automation created from the run's records, from the panel or with `sandforge-sync --remove --sweep`.
- **Real-Time**: an option to keep contact points as read, for objects matched by Id or external id too.

### Changed

- **Sync**: sets a lookup between objects that point at each other once both are written, instead of leaving it empty.
- **Sync results**: records written without a field or a lookup show as plain lines, not refusals.
- **Stopping a run**: a plain question with Stop the run and Keep running, nothing to type.
- **Sentences that name an object**: use its label, as the org shows it.
- **Panel tabs**: named as the navigation names each module, in your language.
- **Sidebar**: long module names and the demo-data button wrap instead of being cut.
- **Pages**: each loads only the English text and the code it uses; the base every page shares is 491 kB instead of 874.
- **Translations**: Spanish says respaldo, Portuguese lista de opções, French and German Automatique; Japanese spaces Latin words as Salesforce's Japanese interface does.
- **Command palette**: the Help entry reads Help, as in the navigation.

### Fixed

- **Seed, Sync**: a Bulk job still running when the window closed is read back, and its records are removed with the run.
- **Frozen Dataset**: a load stopped part way keeps its mapping batch by batch, so its removal and its sweep find every record.
- **Forge**: an upsert cut off part way is reconciled by its external id values: the records it created are removed with the run, the ones it updated are left alone.
- **Sync delta**: an object whose lookups were left unset is read again next time, and the results say so.
- **Production Guard**: its refusal to delete in a production org is worded in your language and names the org by its alias.
- **Seed gallery**: Back from a template keeps the keyboard on the card it was picked from.
- **Keyboard and screen readers**: Sync's tabs have their panel; Monitor's loading page has its heading.
- **Command line**: `sandforge-clone` names the objects its caps cut.

## [1.62.0] - 2026-10-21

Copies between two orgs check before they write, never duplicate, keep personal data private, and every run can be seen, stopped and taken back.

### Added

- **Live Operations**: lists every run that writes, DataOps, cleanups, erasures, pipelines and Real-Time included, updated as it goes, each with a Stop.
- **DataOps backups**: can be deleted, one or all of an org's; new backups expire after `sandforge.backup.maxAgeDays` (30), older ones stay until you delete them.
- **Forge results**: open the cloned record in the org.
- **Quick Sync results**: remove what the run created, or open it in History.
- **Seed's Clone from Org, CSV Upload**: a Stop while they write.
- **Settings**: say what each AI feature sends to Anthropic; remove the key and its conversations.

### Changed

- **Sync**: writes parents first whatever the order objects were added in; a saved configuration run again leaves out what an earlier run copied.
- **Sync**: checks volume, data storage and the target's daily emails before writing, as Forge does.
- **Sync**: one question, asked only when the target may hold the record, replaces Direction and Conflict Strategy; results show what was written in plain lines, not as refusals.
- **Forge**: a clone from one record takes the whole graph unless you set Records per object, and says where a cap cut an object.
- **Forge Review**: warns before Execute leaves gaps undecided; the Anonymization tab is always reachable.
- **Clone from Org**: neutralises emails and phone numbers by default and refuses a clone past the target's daily emails.
- **Neutralised phone numbers**: keep the original's layout, so the target's format rules accept them.
- **DataOps masking**: keeps the values first, so Restore can put them back.
- **Autopilot**: waits as long as the run takes and refuses a second run on the same target.
- **Saving an AI key**: no longer turns on sending failed runs to Anthropic.
- **Keyboard and screen readers**: focus follows each page and step, runs announce how they ended, graphs and org pickers work from the keyboard.
- **Walkthrough**: the Connect step completes once an org is registered.
- **Translations**: each language names modules and Salesforce terms as Salesforce's own interface does, consistently.

### Fixed

- **Seed's Clone from Org**: writes between two orgs that do not share their users.
- **Forge removal**: from the panel, also deletes the rows of a write call the run was stopped during; can be stopped.
- **Sync**: an insert between two sandboxes of one production no longer takes the target's values.
- **Earlier seeds**: a seed still writing can no longer be removed.
- **Reports**: a stopped Seed, Clone or CSV import reads cancelled.
- **Command-line snapshots**: kept in your own folder, readable by you only.

## [1.61.0] - 2026-10-20

The first five minutes: a new user goes from no org to seeded data, errors read in plain words, and SandForge starts lighter.

### Added

- **Launcher**: with no org, imports the orgs the Salesforce CLI already has or signs in with the browser; with one org, fills it with Seed.
- **Walkthrough**: a step to fill an empty org with demo data.
- **Seed**: lists the target's automation before writing, and refuses a run whose emails would exceed what the org has left today.
- **Seed**: a choice of locale for generated names and addresses.
- **Forge command line**: copies whole tables (`--object`, `--where`) on the panel's streamed path.
- **Seed command line**: writes through Bulk API past 200 records, as the panel does.

### Changed

- **Errors**: every module explains a Salesforce error from one catalogue, in the panel's language, with a next step and a Help search for an unknown code.
- **Sync results**: refusals are grouped by code and field.
- **Home**: recommends filling a fresh Developer Edition, and opens from the launcher.
- **Currencies**: a price entry goes in the currency of the opportunity, quote or order its lines are written in; quote lines follow their quote; dated rates are detected from the org's currency settings.
- **Sync**: writes price entries on the target's standard price book, standard prices first.
- **Forge and Autopilot**: a Developer Edition's email alerts count against its daily emails, and the clone command line refuses past them.
- **Real-Time**: emails and phone numbers are neutralised by default, as in Sync.
- **Startup**: SandForge does nothing until one of its views opens; the extension bundle is a third smaller and each panel page loads on its own.
- **Help and Reports**: release their page while hidden.
- **Seed data**: company names stay distinct past the built-in catalogue.
- **Documentation**: the README and guides lead with filling an empty org, say how each run is taken back, and Autopilot has its guide.

### Fixed

- **Forge resume**: a run stopped during a write call no longer writes that call's rows twice; verify reports extra records in the run's window.
- **Forge whole-table runs**: an owner the target lacks is left out instead of every row being refused.
- **Autopilot**: a product priced in two currencies no longer collides on its standard price.
- **Connection errors**: say what happened and offer Reconnect.
- **Command lines**: Ctrl-C stops Frozen, Autopilot and DataOps cleanly, a DataOps restore included.
- **Organizations page**: an org card no longer nests buttons.
- **Sync results**: the standard price book note is no longer shown as an error.

## [1.60.0] - 2026-10-20

An empty org fills in one click: Seed opens on templates sized for a new Developer Edition, which is no longer treated as production.

### Added

- **Seed**: two light starters lead the gallery, CRM Starter (about 300 linked records) and Leads & Activities.
- **Seed**: checks the data storage a run needs before writing anything.
- **Seed results**: refusals grouped by code and field with a hint, and a link to a created record in the org.
- **Quick Seed**: a run can be cancelled.
- **Sync and Autopilot**: emails and phone numbers are neutralised by default; an option keeps them.
- **Frozen**: the salt is kept in the editor's secret storage, with commands to copy it or use a teammate's.

### Changed

- **Seed**: opens on its template gallery, with one confirmation and the org preselected.
- **Seed templates**: products are priced on the org's standard price book, and objects the org lacks are skipped by name.
- **Seed data**: names, companies, addresses and dates vary from run to run and follow the org's locale.
- **Seed**: a run is kept on disk as it writes, so an interrupted run can still be removed.
- **Seed Configure step**: lists an account's fields for the chosen record type.
- **Developer Edition**: a development org everywhere, as Trailhead playgrounds are; a production org keeps every guard.
- **Removals**: past 10 000 records of one object they use a Bulk API job, and dependents are read once per relationship: 12 000 contacts in under a minute.
- **Sync**: an owner the target refused is left out of later objects from the start.
- **DataOps restore**: writes only the rows that differ from the org; an option rewrites them all.
- **DataOps Backup tab**: lists the objects the masking plan covers.
- **Autopilot**: three wizard steps, the compliance framework under Advanced.

### Fixed

- **Seed**: a long run no longer loses its page or asks to try again while it is still writing.
- **Seed**: records watched by a duplicate rule are no longer refused.
- **Seed**: a field the org requires without a rule is filled, and named in the results.
- **DataOps Restore tab**: the Restore button no longer sits inside a selectable card.
- **Clone command line**: prints what its scan added.

## [1.59.0] - 2026-10-19

Line items keep their parent's currency, Seed picks its record type and cleans up after the target's automation, and the bulk paths hold past 10 000 rows.

### Added

- **Seed panel**: picks the record type to write, person or business, and refuses a mix.
- **Seed panel**: lists earlier seeds, each removable from any window, after a reload too.
- **Seed removal**: can sweep what the target's automation created during the run, from the panel and with `--sweep`.
- **Currencies**: dated exchange rates are used where advanced currency management is on, by the opportunity's close date.

### Changed

- **Currencies**: line items follow their parent's currency and its conversion, in Forge, Sync and Autopilot.
- **Forge**: a price entry in a currency the target lacks gives way to the source's own entry in the currency written, or is converted and said.
- **Autopilot**: follows Account by default, reading only the accounts the selected records reference.
- **Autopilot object list**: "select all" counts nothing until asked, and the objects the target lacks are listed but not selectable.
- **Autopilot**: leaves a person account's contact to the platform and links its children to it.
- **Autopilot write gate**: sizes a person account at 4 KB, as Forge does.
- **DataOps CCPA**: without an object, masks the person accounts as well when the org has them.
- **Validation rules**: their formulas are read 25 per request, so a large org is read in fewer calls.

### Fixed

- **Backup command line**: `sandforge-backup --restore` writes again into a Developer Edition or a sandbox, and exits 1 when the snapshot or the restore fails.
- **Sync delta**: a copy it deleted is no longer linked to by a later run.
- **Frozen**: an axis on a checkbox, number or date field is queried without quotes, as Salesforce requires.

## [1.58.0] - 2026-10-17

Person accounts and multi-currency tested on real orgs: amounts keep their value, and every module writes each account as its kind.

### Changed

- **Currencies**: a currency the target lacks is replaced by the record type's default or the corporate currency, and the amounts are converted at the source's rates, in Forge, Sync and Autopilot.
- **Sync simulation and Autopilot plan**: predict the currency replacement and its conversion.
- **Frozen defaults**: required picklists are kept without a rule.
- **Frozen**: a business account's Name and a person account's last name are asked where the rules leave them empty.

### Fixed

- **Autopilot**: writes each account as its kind, person or business.
- **Autopilot**: holds back a record whose parent it refused.
- **DataOps masking**: covers a person account's own fields — names, email, phones, birthdate.
- **Frozen verification**: counts apart what the preview said it could not load.

## [1.57.0] - 2026-10-17

Sync links across runs, DataOps masks from the command line, and every module reads a large org within Salesforce's limits.

### Added

- **DataOps command line**: `sandforge-dataops anonymize` masks with a filter and a dry run, takes a snapshot first and restores from it.
- **Seed panel**: a run can be removed from its results.
- **Seed command line**: writes person accounts for a person record type.
- **Frozen preview**: lists the target's active validation rules, with their fields.

### Changed

- **Sync**: a saved configuration remembers the records its runs wrote, so a later or delta run links to them.
- **Sync**: a lookup to another row of the same write is set in a second pass.
- **Sync**: a parent refused as a duplicate of one record is linked to it, and its children follow.
- **Autopilot**: the first scan lists the org's objects without describing them.
- **Autopilot**: the write gate counts the emails the target's flows would send.
- **Frozen**: a default for a name or a unique field gives each record its own value.
- **Frozen**: business hours, which the platform never deletes, are found again by name.
- **Frozen**: the extraction reuses the selection's graph while the source's schema is unchanged.
- **Validation rules**: an insert's caveat leaves out rules that only fire on a change.
- **Automation report**: reads flow metadata within Salesforce's composite limits, 1 500 start conditions at most.
- **Forge removal**: sweeps what the target's automation created before it deletes.

### Fixed

- **Backup and Frozen command lines**: a production write nobody confirmed is refused.
- **Forge**: a cancelled run shows as cancelled, not as an error.
- **Forge removal**: a parent a swept child's roll-up touched is no longer kept as changed.
- **Forge command line**: Ctrl-C stops the run as the panel does, audited and resumable.
- **Seed**: a row a validation rule refuses is written again without the field it names.
- **DataOps**: masking and restore take a Developer Edition for development.

## [1.56.0] - 2026-10-16

Frozen Dataset tested on a large org: a dossier stays a dossier, a load says what it could not write, and personal attributes stay cleared.

### Added

- **Frozen removal**: can first sweep what the target's automation created during the load (`--sweep`, `--sweep-list`).
- **Frozen extraction**: lists the required fields the rules leave empty, and the fields kept without a rule.
- **Sync simulation**: lists the target's active validation rules, which it cannot evaluate.

### Changed

- **Frozen scope**: a dossier reads children only under the records reached from its root, not every sibling of a parent it names.
- **Frozen budget**: a refusal names the heaviest objects to leave out.
- **Frozen load**: records whose required parent the configuration excludes are left out, not asked a placeholder.
- **Frozen verification**: says failed or partial when objects were refused or held back.
- **Frozen defaults**: platform settings and restricted picklists are kept without a rule, never a personal attribute.
- **Personal-data detection**: names gender, salutation, marital status, nationality, religion and other personal attributes, in English and French.
- **Autopilot**: reads a table page by page past 2 000 rows.

### Fixed

- **Frozen**: datetimes with an offset are shifted, no longer cleared.
- **Frozen**: the control no longer takes a record type's own name for a leak.
- **Frozen**: children of a refused parent are held back, never written without it.
- **Autopilot**: fictitious values fit email and phone fields, and a personal picklist is emptied.
- **Seed**: a record's phone and mobile numbers differ.

## [1.55.0] - 2026-10-16

Sync, Seed, Autopilot and Frozen tested on a large org: each writes what it says it will, within bounds.

### Added

- **Seed command line**: `--remove` takes a run back from its summary; `--seed` makes a dry run predict the run; `--locale` and `--record-type`.
- **Autopilot write gate**: a run past the target's data storage is refused, a large one asked first (`--max-total`, `--max-depth`, `--max-objects`).
- **Frozen selection**: says each step, and keeps what it decided when it times out or is stopped.
- **Sync page**: Save sits next to the reason Run waits for a configuration that copies files.

### Changed

- **Autopilot scope**: copies the selected objects and only the parent records they reference, within Forge's bounds, not whole tables.
- **Autopilot compliance**: personal fields are found without AI; AI findings add to them.
- **Sync record types**: mapped by API name; a type the target lacks or closes to the user holds the row back.
- **Sync simulation**: predicts person-account fields, record types, refused parents, required fields, lengths and unique values.
- **Forge stops**: each names the discovery or run it stops; a discovery no longer silences another panel's.
- **Forge history**: a run keeps at most 2 000 ids in memory; the rest are read from its journal.
- **Frozen selection**: asks each describe once, with far fewer API calls on a large org.

### Fixed

- **Sync**: no person-account fields on business accounts.
- **Sync**: children of a refused parent are held back, never written without it.
- **Seed**: emails and phones get fictitious values.
- **Forge**: a stopped run no longer blocks the next one in the same window.
- **Forge graph**: background visible in a light theme.
- **Automation**: a scheduled pipeline with a step no release runs records the missed start.
- **Sync delta**: says how many changed legacy attachments it left as copied.

## [1.54.0] - 2026-10-15

Forge tested on a large org: what its automation creates can be swept, and its report reads every flow.

### Added

- A Forge removal can sweep what the target's automation created during the
  run: records created by the run's user inside the run's window, listed and
  asked before any delete, refused where the user likely worked by hand
  (`--sweep`, `--sweep-list` at the command line).

### Changed

- The automation report reads up to 500 flow start conditions in grouped
  calls, with fewer API requests, and says per object what it left unread.
- Verify tells a lookup the target's filter emptied, or its automation set,
  apart from a broken one.

### Fixed

- A rehearsal leaves a person account's contact to the platform, as the run
  does, and judges its children against it.
- A backup says whether it stopped short with a boolean.

## [1.53.0] - 2026-10-14

A resumed Forge run picks up exactly where it stopped, and the canary covers Sync.

### Added

- The Sync command line runs a saved config, delta and files included, and a
  removal it runs tells the config what went.
- The canary syncs its own records in full, then in delta, then removes the run.

### Changed

- Removal and the Id map export read a Forge run's journal page by page, and
  its removal stamps stay beside the journal.
- The Forge graph line counts included, empty, not counted and left-out
  objects the same way in a dry run and a real one.
- A removal confirmation counts files as files.

### Fixed

- A resumed Forge run copies the files left to copy, and links rather than
  copies again a file the stopped part copied.
- A Forge resume no longer gives back a status twice nor resends a lookup the
  stopped part filled.
- A Forge resume is no longer refused because an empty table of the graph
  changed meanwhile.
- A Forge retry counts what the run it retries wrote through the object's
  filter.

## [1.52.1] - 2026-10-14

### Changed

- **Marketplace listing**: its name and description say what SandForge is for,
  realistic data for Salesforce sandboxes, and fit in what the listing shows,
  in six languages.
- **README**: one text for GitHub and the Marketplace, a short line per
  module with a link to its guide, an animated tour of a Forge clone, and a
  guide for the AI Assistant.

### Fixed

- **Forge and Autopilot graphs**: the minimap shows the objects, coloured as
  the legend says, and it and the zoom controls follow the VS Code theme.

### Security

- **AI replies**: a reply that opens a code fence and never closes it is read
  at once; it could hold the extension for seconds.

## [1.52.0] - 2026-10-14

What a run writes can be taken back, however large the run.

### Added

- A Sync run can be removed from its history entry or its results: the records
  and files it created, files first, records changed since kept unless
  included, refused on a production org.
- A Forge run from a record keeps a journal too, and can be resumed.
- The Forge Id map export writes from the host, piece by piece.

### Changed

- Past 50,000 records, a Forge run's ids stay in its journal rather than in the
  history and the removal plan; removal, Verify, Retry and the export read
  them from there.
- A Sync delta run looks for newly attached files only past the newest it
  already looked at.

### Fixed

- The ids an insert returns are written to the journal before the run goes on.
- A resumed run from a record fills the lookups its stopped part owed.
- Lookups a record owes on two pages are sent once, and a conflict between them
  is found.
- The Sync help no longer says delta runs do not exist.

## [1.51.0] - 2026-10-14

A Forge run that stopped can be resumed, and every stop says what it left.

### Added

- A Forge run of whole tables that stopped, crashed or lost its window can be
  resumed from its results, the history or Live Operations, or with
  `--resume` at the command line.
- A Sync delta run with files copies files newly attached to records that did
  not change, and replaces changed legacy attachments where Production Guard
  allows a delete.

### Changed

- What a Forge run keeps goes to disk, and its second pass runs page by page.
- An object with a record type closed to the user is held back whole before
  its first page.
- Every run the user stops is audited as cancelled.

### Fixed

- A Forge clone cancelled while its journal opened no longer starts.
- The run gate leaves out what the run it retries or resumes already wrote.
- A pipeline holding a step type no release has is refused with a reason and a
  history entry, and the scheduler says why it is not scheduled.
- Run and Simulate wait for a Sync config that copies files to be saved.
- A backup stopped between two objects names the objects it never reached.

## [1.50.0] - 2026-10-13

Sync runs on its own, pipelines can write after an approval, and a canary watches.

### Added

- Sync delta: a saved config reads only what changed since its last clean run,
  can carry deletions over, and runs full after a scope change or a reset.
- Sync copies the files of the records it copies, within the target's storage
  and two caps (off by default).
- The Sync page runs a saved config now.
- Automation: an Approval step, a Condition editor, and a Sync step that runs a
  saved config, after an Approval where Production Guard would ask.
- DataOps exports a backup from the host, page by page, to the file you pick.
- The Restore tab offers a backup that failed part-way, marked partial.
- A weekly canary runs SandForge's own commands against two Developer Editions.
- Forge reads and writes a run of whole tables page by page, counts before it
  reads, and takes its ceiling from `sandforge.forge.maxRecordsPerObject`.

### Changed

- Automation no longer has Script, Loop and Parallel steps; a pipeline that
  holds one is refused by name.

### Fixed

- A Cancel sent while Production Guard is asking stops a Frozen removal or a
  Sync run before it writes.
- A removal the user stops is audited as cancelled.
- A pipeline's Sync run is recorded as such and is not cut by the pipeline's
  time budget.
- Sync writes a record again without the lookup on either form of the
  cross-reference refusal.
- Files left by a backup that never saved its metadata are removed after a day.
- A Forge rehearsal links a row the target already holds, as the run does,
  instead of refusing it and every row under it.
- A run not yet removed keeps its removal plan when later runs fill the store.
- An approval given to a pipeline's Sync step answers Production Guard only
  while that run lasts.

## [1.48.0] - 2026-10-13

Backups hold whole objects, and every long wait can be stopped.

### Added

- A DataOps backup reads every page of an object, up to
  `sandforge.backup.maxRecordsPerObject` (50,000 by default), and writes each
  page to disk as it arrives.
- A Frozen removal can be stopped from its card.
- NL2SOQL, the Forge plan and the pipeline generator can be stopped.
- Migration saves its selection as a Sync config.

### Fixed

- A backup that stops at the cap or fails part-way says so per object, and a
  restore of it warns that it brings back only part.
- A masking run's resume gives no fictional name the first part gave.
- Frozen offers Verify only for a target a load went into.
- The Gaps tab and the removal confirmation read the target again on demand.
- A stopped Autopilot run counts the emails it held for their task.
- Autopilot answers with a translated message when its module is not ready,
  instead of waiting for the timeout.

## [1.47.0] - 2026-10-09

What a run leaves is said, and what Review shows can be read again.

### Added

- Review's Automation tab and its bypass assistant read the target again on
  demand: a permission set just assigned shows as held.

### Fixed

- A stopped Autopilot run counts the lookups it left empty and the statuses
  it did not give back.
- DataOps audits a count that fails, and a resume reads back the records of a
  write whose answer never came before masking them again.
- Frozen keeps the last verification per target org.
- The AI pipeline draft shows its suggestions in the user's language.
- `NOT_INITIALIZED` reads translated on the Autopilot and CSV import pages.

## [1.46.0] - 2026-10-09

Every module can now be previewed, stopped and taken back, and the clone
command does what its flags say.

### Added

- **DataOps**: a Preview of a template on five rows of each object, before
  and after; Resume an anonymization where it stopped; saved templates take
  Constant and Truncate, and a Mask keeps its last characters.
- **Frozen**: a Preview of a load (`load --dry-run`), Cancel from the Load
  tab, and loads into a Developer Edition.
- **Forge**: a rehearsal judges the updates a run makes after its inserts; a
  validation rule's bypass comes with the permission set holding it; Forge
  asks before an uncapped read past 50 000 rows of an object.
- **Autopilot** runs and **AI** chat questions can be stopped; Migration edits
  the imported config before it runs; an org opens in the browser from its
  card; an audit entry links to its run.
- **CLI**: `--audit <file>` on the clone command.

### Changed

- A Seed clone or a Forge run whose second pass leaves lookups empty ends
  partial.
- Sync offers managed-package objects again.
- Every module's Production Guard refusal reads in the user's language.

### Fixed

- `--upsert` upserts: every run inserted.
- On an org in another language than English, validation rules had no field.
- A second `--remove`, and `--verify` after one, look only at what is left.
- Two phone numbers of a run never share a fictional one.
- The sync command refuses User, histories and file objects, as the panel
  does.

## [1.45.0] - 2026-10-09

A clone says before it writes when the target would run out of emails, and
a partial backup says what it holds.

### Added

- **Email budget**: before a clone writes, the emails the target's flows
  would send for its records are counted against what the org has left
  today (single emails for a Send Email, workflow emails for an alert). Past
  that limit a record whose flow fails is refused, so the panel asks and the
  command says it.
- **`sandforge.showWhatsNew`** turns the What's New panel off.

### Changed

- A Block duplicate rule read from the target's metadata is a warning: it
  refuses only the rows it matches. A rehearsal that meets a refusal makes it
  blocking.
- A patch release no longer opens the What's New panel.

### Fixed

- A backup the tier's bound cut short says so on the DataOps page, with the
  objects it holds only part of.
- `--rehearse --json` prints what the target refused on stderr.

## [1.44.2] - 2026-10-07

### Fixed

- **Discovery no longer cuts a child holding records** while empty standard
  objects fill its cap: an empty table takes no place under it, and nothing
  is reached through one.

## [1.44.1] - 2026-10-07

### Fixed

- **A bypass the user holds reads as held**: the Automation tab and the clone
  command no longer say a custom permission is missing, nor give the command
  to assign it, when the user already holds it.
- **A dependent picklist value its controlling value refuses** is left out
  before the write on an object without record types, as it already was on
  one with record types.

## [1.44.0] - 2026-10-06

After a clone writes, it can be checked, kept removable and accounted for;
before it writes, Review exposes every control a run takes.

### Added

- **Verify** on Results and `--verify` in the CLI: what the run created is
  there, its links point at the parents it wrote, and what changed since is
  named, once the target has settled.
- **Review's Controls tab**: fields to leave out, a filter and renames per
  object, the record cap and owner mappings, with a graph search and a
  branch left out in one click; the CLI takes `--config` and `--template`.
- **What fires on update** — a lookup filled in later, an order given back
  its status — is put to you with what fires on insert, and a removal lists
  what fires as it deletes.
- **A bypass assistant** shows the command that assigns a permission set
  holding a flow's bypass; SandForge never runs it.
- **The audit trail** says how each run was set up and exports to CSV or
  JSON.
- **Rows a gap names exactly** can be skipped.

### Fixed

- **A run stays removable** past the last 20 runs, a CLI clone interrupted
  with Ctrl-C leaves a summary `--remove` can use (`--summary`), and a
  record neither found nor in the recycle bin is said not visible, never
  removed.
- **Before a run**, the user is told what may refuse taking it back.
- **A simulation** says what a real run would do with emails and phones.
- **The README and the Marketplace page** show the current product and how
  to start safely; Forge refuses a production org rather than asking twice.

## [1.43.0] - 2026-10-06

Before a clone writes, it can say what the target would refuse, row by row,
and let you decide.

### Added

- **Simulate** on Review: the run goes through its write stage and writes
  nothing, then lists what the target would refuse or change.
- **Rehearse** on Review: a sample of the rows is sent to the target inside
  transactions that are rolled back, for the platform's own verdict; the
  clone command rehearses with `--rehearse`.
- **The Gaps tab**: what the target's metadata, a simulation or a rehearsal
  found against the rows, each with a decision in one click (map a value,
  leave it empty, set a default, truncate, map a record type, leave the
  object out, ignore), kept in the run's config and template.
- **Review reads the target's metadata** first: active validation rules and
  their bypasses, duplicate rules that block, fields only the target
  requires, lookup filters and the day's API budget.
- **Results acts on the run**: a created record opens in the target, the
  results save to CSV or JSON, the run can be removed in place, and objects
  skipped whole can be retried.
- **Templates** keep the objects left out, the fields anonymized, the file
  copy and the decisions, and export to and import from a JSON file.
- **Sync** pauses and resumes from Live Operations.

### Fixed

- **Every REST writer keeps the target's assignment rules off**, Seed,
  DataOps, Autopilot and Sync included.
- **The rows of a call that may have committed** are named in the result
  and the removal.
- **An expired session and SandForge's own refusals** are translated.
- **Seed** makes up its companies and usernames; **Frozen** catches text
  fields named for an email or a phone number.
- **DataOps** names the template fields it could not find, and says how much
  of each object the latest backup holds before an Anonymize.
- **Reports** says when its list could not load; **Compliance** says its
  status in words; the depth field refuses what discovery refuses.

## [1.42.0] - 2026-10-06

A clone checks what it is about to do before it writes, and writes no email or
phone number that reaches anyone.

### Added

- **No deliverable email or phone number by default**: Forge writes addresses
  under `.invalid` and phone numbers in a fictional range; **Keep emails and
  phone numbers as they are** turns it off.
- **A run's checks before it writes**: a production target is refused (a
  Developer Edition org and a scratch org are not production); automation that
  fires on insert, and a run above `sandforge.safety.confirmAboveRecords`, are
  put to you first; a run the target's data storage cannot hold is refused. The
  clone command needs `--accept-automation`, and stops past `--max-total`.
- **The Automation tab sees more**: processes, workflow rules and their email
  alerts, after-commit and scheduled paths, assignment and duplicate rules,
  bypasses in Decisions and custom settings, and what sends messages. Forge's
  writes keep assignment rules off unless `--apply-assignment-rules`.
- **Sync can be simulated, paused and cancelled** from its page.

### Fixed

- **DataOps Anonymize masks every row** of an object, and a run that leaves
  rows says how many.
- **Seed's data reaches nobody**: reserved email domains, fictional or
  unassigned phone ranges, a company's name on an account.
- **A Forge write survives a transient failure** without writing a row twice,
  retries locked rows, and leaves out up to three refused fields.
- **Ten more errors are explained**, each with a link to the guide.
- **No dead button or "coming soon"**: Seed exports its results; Reports and
  Automation offer only what runs; Compliance follows the run's real
  anonymization.

### Removed

- **Sync's `manual` conflict strategy**, which applied the source's values; a
  draft that holds it reopens on target wins.

## [1.41.1] - 2026-10-02

SandForge has a new mark: the forge's fire rising out of a sandbox.

### Changed

- **A new mark**, the forge's fire rising out of a sandbox, on the Marketplace
  icon, the activity bar and the side panel's header, where the Forge
  module's flame stood for the whole product; the README opens with the new
  logo, and the brand set for LinkedIn and GitHub sits in `assets/brand`.

## [1.41.0] - 2026-10-02

Review says what the target runs before a clone writes, and Bulk writes keep
every field of every row.

### Added

- **Review has an Automation tab**: per object the run writes, the target's
  active record-triggered flows and Apex triggers, on insert, update and
  delete, and the custom permissions that keep a flow from starting for the
  user who holds them; the clone command prints it before it writes, under
  `targetAutomation` with `--json`.
- **`--list-objects --json`** prints the graph as JSON, and a second
  `--remove` of a run knows what the first one wrote, from a file kept beside
  the summary.

### Fixed

- **A Bulk API write sends every field of every row and finds each row's own
  answer**: fields a row held that the first row did not were lost, and the
  ids of the rows were not found again, though the records were written; a
  write past 10 000 rows went nowhere.
- **A removal, or a reload's purge, tries once more what it was refused** once
  the rest has gone, never takes for gone a record it could not read, and a
  Frozen removal no longer counts as kept what the platform deletes with a
  contact or an email the load created.
- **A record whose required parent is of an object outside the graph gets that
  parent read by id**, with nothing read under it, so a case's invoice
  junction goes in with its invoice.
- **A Frozen load writes again a row the target refuses** for a restricted
  picklist value or a validation rule, without the field or with its declared
  replacement.
- **The Forge results page lists the run's notes apart from its errors**,
  counts an object with two reports once, and explains a lookup left empty, an
  object the target lacks or takes no insert of, and a refusal from the
  target's automation.
- **The discovery screen's counters follow only the discovery the flow waits
  on**, and the CI examples take a clone back with `--remove` on Node 24.

## [1.40.2] - 2026-10-01

Forge clones more of a real case: a record type that takes none of a
picklist's values, a policy whose insured was not read, person accounts on
both sides. The clone command removes what it wrote.

### Added

- **The clone command removes what a run of it created** with
  `--remove <summary.json>`, as the wizard's removal does; it refuses a
  production target, for a clone as for a removal, and in `--json` mode only
  the JSON goes to stdout.

### Fixed

- **A row the target refuses for a restricted picklist value is written again
  without that field**, as one a validation rule refuses, and the results say
  which refused each field: a record type never given values of a field takes
  none, while the check before the write reads them all.
- **A record whose required parent was not read gets that parent read**, so an
  insurance policy whose named insured is not the case's account is cloned
  with its coverages; a lookup left empty because its record is not in the
  clone is said so, not counted as failed, and an object the target lacks is
  said once.
- **A Frozen load links each person account's contact to the one the platform
  wrote with the account**, instead of sending a second one and setting a link
  no write sets; where the target holds the account as a business account, or
  has no person accounts, the contact goes in as a contact of that account.
- **Forge sends a person account's contact as one of its own where the target
  wrote none with its account**, a target without person accounts or a
  business record type included, and the removal confirmation no longer counts
  as kept what the platform deletes with the records the run created.
- **A parent Forge copies from outside the graph gets the checks a row gets**:
  its picklist values per record type, one more try without the fields the
  target refuses, and its person account's contact linked.
- **An unrestricted picklist or a combobox keeps the value read**; a standard
  status, stage, priority or role is still checked.
- **A lookup only an insert sets is never sent in an update**, a lookup the
  user left out is never written, and a renamed lookup is owed under its
  target name.
- **A Forge discovery that answers while its page is away is kept** and shown
  when the page comes back; only the latest discovery's answer counts.

## [1.40.1] - 2026-10-01

Forge handles what a real clone met: picklist values per record type, a
validation rule on one field, and person accounts.

### Fixed

- **A restricted picklist value is checked against the record type the row
  gets in the target**, and its controlling value: a refused value is replaced
  by the record type's default or left out, and the results say which.
- **A row a validation rule refuses on a field it names is written again
  without that field**, and the results say which field and why; every
  refusal now names its fields.
- **A person account's contact is never written on its own**: the run links
  the one the platform created with the account, and a reference no write can
  set no longer orders the run.
- **The output channel names the orgs a Forge run goes between** and, per
  object that lost rows, the status codes the target answered with.

## [1.40.0] - 2026-09-30

Forge can show its graph as a table and clone directly, and every line it
writes says how many rows an object lost.

### Added

- **Forge shows its graph as a table past 25 objects**, by the
  `sandforge.forge.graphView` setting (auto, graph, table) and a Graph/Table
  switch on discovery, review and execution.
- **Clone directly** runs discovery and execution from the start, without
  stopping on the discovery and review screens.

### Fixed

- **Forge's held-back, failed-whole and skip lines say how many rows failed**,
  as the totals and the audit count them.
- **A cancelled removal counts in the running total** and stays offered for
  what it did not reach.
- **An activated contract is deleted as it stands**, keeping its item prices
  with it when it stays, and a reload's purge counts as purged what the org
  took along after refusing it.
- **The AI chat sends alternating turns** and keeps each unconfirmed
  conversation until its own confirmation.

## [1.39.12] - 2026-09-30

Forge's metadata review names what the target lacks, and the output channel
says how each Forge step ended.

### Fixed

- **Forge's metadata review names an object the target org lacks**, or could
  not describe, and compares the others, where one missing object failed it
  whole.
- **The output channel says how Forge's discovery, run and metadata review
  ended**, with their counts, where it said only that they started.

## [1.39.11] - 2026-09-30

A removal that left records can be run again for what is left, and keeps with
an activated order what the org will not delete under it.

### Fixed

- **A removal that left records can be run again for what is left**, in Forge
  and Frozen, with or without the records changed since.
- **A removal keeps an activated order's products and actions with it** when
  the order stays, rather than sending deletes the org refuses, and names the
  files the org attached to the records it deleted.
- **Re-verify of a Frozen load a removal took part of** says how many records
  it left, and to remove them or reload.
- **A Forge run that skipped an object whole ends partial or failed**, rather
  than a success.
- **Claude Sonnet 5.5 can be chosen as the AI model**: it is told not to think
  before answering, as the other models are.

## [1.39.10] - 2026-09-29

A cancelled Frozen load says a removal takes it back, and Forge's audit entry
names the objects a run skipped.

### Fixed

- **A cancelled Frozen load says a removal takes it back**, with what it
  created, and Re-verify's refusal of a load that stopped part way says to
  reload or remove it first.
- **The Frozen load looks up the catalog the target holds on a line of its
  own**, which says what it linked, or why a read failed.
- **A Forge run's audit entry names the objects it skipped whole**, for a
  failed parent or an object the target takes no insert of, and the Audit
  Trail page shows them.
- **A Forge object's line counts the rows it held back with its failures**,
  as the run's totals and its audit entry do.

## [1.39.9] - 2026-09-27

The Frozen load names each of its phases in words, and Forge's audit entry
counts the rows a run held back.

### Fixed

- **The Frozen load names each phase in words** in every locale, where its
  badge printed the phase's code.
- **A Frozen reload ends its reference data line** once its reads are done,
  and reading the mapping of earlier loads and a pilot's root folder each
  have a line of their own.
- **A Forge run's audit entry counts the rows it held back as failed**, as
  the run's totals do.

## [1.39.8] - 2026-09-25

The AI chat keeps each answer with its conversation, and every Forge and
Frozen line ends, whatever stops the run.

### Fixed

- **An AI answer stays with the conversation its question was asked in**, and
  the page says so when another one is open; only a question's own answer or
  error ends its wait.
- **A Forge email object whose emails all wait for their task** ends when the
  run stops before them, those emails counted as not sent.
- **A Frozen step that fails ends its line with the reason**: the entry
  guards, the alignment, the required-fields check, the placeholders, pass 2,
  the statuses, PersonContact and the purge.
- **A Forge run's audit entry counts what a cancel kept from the target**, as
  Frozen's does.
- **The AI chat takes one question at a time in a conversation**, and a model
  name with spaces around it is read without them.

## [1.39.7] - 2026-09-25

The AI features ask Claude Sonnet 5, and an object a cancel stops reads as
stopped wherever its run is shown.

### Changed

- **The AI features ask Claude Sonnet 5 by default**, and Settings names the
  model configured.
- **An AI answer refused, cut off or empty** fails with a message in the
  editor's language instead of reaching the page, and a chat question that
  failed is not sent again with the next one.
- **The webview merges its classes with tailwind-merge 3**, the version made
  for Tailwind 4; vsce 4, esbuild 0.28 and Vite 8.3.1 build it.

### Fixed

- **A Forge or Frozen object a cancel stops while it is written reads as
  stopped**, with what it never sent, on the graph, its tiles and the load list.
- **The Forge graph keeps its height** on discovery and during the run, and
  its objects stay clear of the minimap, as Autopilot's stay clear of its
  minimap and legend.
- **Statuses are named in the panel's language** in Forge's results, table
  and object detail, and in Seed's progress; Forge's columns sort by them.
- **A Frozen load ends every line it opens**: an object whose write fails says
  why, and pass 2, the statuses and a reload's purge say what a cancel kept.
- **A Forge run cancelled midway is recorded as partial** in the audit trail,
  and a Frozen entry counts the rows a cancel kept back.

## [1.39.6] - 2026-09-25

The webview is built with Tailwind 4 and runs on the current versions of its
libraries; every page renders as before.

### Changed

- **The webview's styles are built with Tailwind 4**, their theme in one
  stylesheet, and every page renders as before.
- **Charts, icons, translations and dates run on Recharts 3, lucide-react 1,
  i18next 26 and date-fns 4.**
- **The Forge graph is laid out by dagre 3**, which may order the objects of a
  row differently.

### Fixed

- **A cancelled Forge or Frozen run says what each object wrote**, the emails
  that waited for their task and the price book entries included.
- **A Frozen load cancelled before an object's turn** no longer counts that
  object as failed.
- **Seed and DataOps check the cancel before every batch**, and Seed sends no
  failed batch again after it.

## [1.39.5] - 2026-09-25

A cancel stops every write that has not gone out, and the command-line tools
read and delete everything they are asked to.

### Fixed

- **A cancel stops every write that has not gone out**: a write's first
  batch, a batch the target failed on, a Bulk API job not yet opened, and a
  Frozen object's rows once its relations were looked up.
- **A Forge object the cancel stops says what it wrote**, and the updates that
  give invitees their flags stop with the run.
- **Forge's execution shows the API calls made so far**; the plan, QuickSync
  and Autopilot say their counts are estimates.
- **Autopilot's review takes the keyboard back** when a run is refused or its
  confirmation declined.
- **Forge says why each held-back row is not written**, and rows read again
  under a late order keep only those its status needs.
- **The sync command reads every row of an object**, not the first 200, and
  every command reads every page of a query.
- **The cleanup command deletes more than 200 records**, and the clone command
  prints every group of errors.

## [1.39.4] - 2026-09-25

A wizard ignores a second Enter while it waits, and Forge follows a catalog
further.

### Fixed

- **A second Enter never starts an unreviewed run**: while a wizard's Next
  waits, the keyboard stays on it, then moves to the step that comes.
- **Autopilot announces its scan and its plan**, and the keyboard moves to its
  run when it starts.
- **Forge's plan and preview card say their API calls are estimates.**
- **Forge: a product sold only by held-back lines is held back with them.**
- **Forge: records read before a parent that came late are read again under
  it**, and a category brings its parents up the tree.
- **An invited contact keeps its flag** when the target refuses only its
  answer, and the refused field is named.
- **The clone command counts its record-type lookup**, and the frozen command
  prints the PersonContact links.

## [1.39.3] - 2026-09-25

The webview runs on React 19; every page renders as before.

### Changed

- **The webview runs on React 19**, with zustand 5, framer-motion 13 and React
  Flow's maintained package, @xyflow/react 12.
- **A few icons are redrawn** by lucide's newer set, with the same meaning.

## [1.39.2] - 2026-09-25

The webview is built with Vite 8 and payloads are validated with zod 4; every
page renders as before.

### Changed

- **The webview is built with Vite 8**, its pages and styles unchanged.
- **Payloads are validated with zod 4**, which parses without eval in the
  webview, as its content security policy requires.

## [1.39.1] - 2026-09-25

Seed Clone writes only where it previewed, and Production Guard is told what
a Forge run can really write.

### Fixed

- **Seed Clone runs against the orgs it previewed.** Selecting another org
  after the preview sets it aside, and the extension refuses a run that names
  no preview, one it no longer holds, or one made for other orgs.
- **Seed Clone warns before Execute** when the target requires a lookup the
  source does not have, shows that its preview is being prepared, and keeps
  the wizard when an error is dismissed.
- **Seed Clone's Next runs the clone** instead of opening an empty step, and
  the source is asked only for the fields it has.
- **Production Guard is told what a Forge run can write**: the objects it
  writes, at most their capped counts, the related records it adds besides,
  and "unknown" when nothing counted them.
- **Forge counts the API calls a run makes**; an estimate says it is one.
- **The Review plan tab stops showing zeros** for a starter template, and a
  node card's count survives the progress throttle.
- **The clone command reads every page of a query**, not the first 2 000
  records.

## [1.39.0] - 2026-09-25

A Frozen load can be taken back, a stopped Forge run can write the rest, and
every module says what it wrote, held back or could not write.

### Added

- **Take back a Frozen load** from the Frozen page or the command line: the
  records it created go, the ones it only linked stay, and earlier loads can
  be taken back one by one. Not yet run against a real org.
- **Write the rest of a failed or stopped Forge run** over what the first run
  wrote.
- **The Load tab says why**: failed records grouped by reason, what a
  reload's purge took and could not take, and the links a load left empty.

### Fixed

- **Forge: a stopped run says what it wrote** and offers a way out; its
  progress, log, clock and result survive leaving the screen, and it reads
  Stopped, not Completed.
- **Forge: an abort is never lost**, even during Production Guard's
  confirmation, and a second run waits for the first to finish.
- **Forge: what you leave out stays out.** Unchecked or excluded objects are
  held back with their cost shown in Review, and so is every row that needs
  one of them.
- **Forge: no lines lost at smaller caps**, and a product clone brings only
  the categories its own assignments name.
- **Forge: activated orders at the default cap bring their items** and are
  activated again.
- **Forge: the catalog is read again** for what later records name, and a
  price book the clone leaves out brings no price.
- **Forge: starter templates say their counts come with discovery**, and the
  clone command says what its graph numbers count.
- **Frozen: a reload purges only what earlier loads created**, dated by the
  org's clock, and a load that fails part way keeps what it created named.
- **Frozen: a refused or cancelled reload purges nothing it should keep**, and
  orders a stopped reload set to Draft get their status back.
- **Frozen: a load leaves out what the target refuses**, carries the prices a
  pilot needs, and keeps matching the standard price book when price books
  are excluded.
- **Frozen: verify names a changed or moved dataset folder** before anything
  else.
- **Rows the platform writes itself are left to it**: an email's task and an
  event's or task's contact, in Forge, Frozen, Sync, Seed and Autopilot. An
  invited contact keeps their answer.
- **Seed Clone orders by what both orgs have in common**, breaks cycles with a
  second pass, says when a clone was cancelled, and needs both orgs before its
  preview.
- **Updates send the duplicate-rule header** in Sync, DataOps anonymization,
  compliance erasure and cleanup.
- **Live Operations and the Forge cards add up every write** of an object.
- **A cancelled run that wrote nothing is recorded as stopped** in Forge,
  Frozen and CSV import.

## [1.38.2] - 2026-09-24

Forge and Frozen clone what a record really holds, and report it in numbers
that add up. Checked on a real pair of sandboxes.

### Fixed

- **An opportunity clone with product lines works at the default settings.**
  Its prices, products, price books and selling models now come whatever the
  object cap; before, the lines were refused.
- **Results count the clone, not the tables it came from**: a run of 272
  records reads "272 of 272", where it read "272 of 4315".
- **A read that fails is named**, not counted as a whole table of failures,
  and the rate never looks complete when an object could not be read.
- **A feed item is written when its own parent is**: one failed parent object
  no longer skips every feed item of the run.
- **Tracked changes are left to the platform** by every module that copies
  feed items — Forge, Frozen, Autopilot, Sync and Seed's clone — and reported:
  the platform writes them itself and refuses a copy.
- **Order actions come with their orders.**
- **The catalog is read after the records put off to the end**, for the
  prices and products only they name.
- **A clone from a price book or a product** brings the other books and
  products its lines name.
- **A line brings the prices of its own currency**, not every currency's.
- **Full-table runs write required parents first.**
- **The plan breaks each cycle where the run does**, and says when one cannot
  be broken.
- **A run cancelled in the middle of an object counts what it wrote**, and the
  rows still waiting for their key.
- **A removal cancelled part way no longer blocks the next one.**
- **A dry run says what the target would refuse**, as a real run does.
- **Reference data is matched by name** even where the target refuses inserts.
- **Objects with nothing to clone are no longer listed as errors**; the clone
  command says why each object was skipped and folds empty tables into one
  line.
- **A dry run with files says why the file lookup failed.**
- **The Skipped card counts objects**, and the Reports page counts the records
  a run read.
- **A polymorphic orphan's parent** is looked for in its own object.
- **Frozen dossiers read their scope both ways**: one opportunity's went from
  23 records to 249, its quotes, orders and prices included, at any cap.
- **A Frozen load links the selling model the target already holds**, and
  carries the options its prices need.

## [1.38.1] - 2026-09-24

Opportunity clones and run removal, hardened on a real pair of sandboxes.

### Fixed

- **Opportunity clones bring their products.** Prices were refused and orders
  stayed unactivated.
- **Each currency keeps its own price** in multi-currency orgs.
- **Large catalogs** no longer overflow a request when standard prices are
  read.
- **Discovery keeps required lookups**, whichever side of the relationship it
  reads first.
- **Full-table runs write past a failed optional parent**, leaving that lookup
  empty and reported.
- **Records written before a failed call are kept**, and the lookups they owe
  are filled in.
- **More orders get their status back**: after an upsert, a failed call, or
  when fetched as a parent. Drafts left by a cancel or a failure are listed.
- **Second-pass counts** report every lookup left empty.
- **File copy stops before writing** when the files cannot be looked up; the
  size field keeps only what you finished typing.
- **Run results** open one report at a time.
- **Removing a run** leaves what a colleague adds meanwhile, gives the orders it
  set to Draft their status back, and dates the run by the org's clock.

## [1.38.0] - 2026-09-23

Forge copies files on request, and opportunity clones were hardened on a real
pair of sandboxes.

### Added

- **Forge copies files, on request**: the Salesforce Files and attachments of
  cloned records. Off by default; each file up to 10 MB by default, 35 MB max.
- **An anonymizing run copies files only if you accept** that they go as they
  are, since their content cannot be anonymized.
- **The files' total is checked against the target's file storage** before
  anything is written. A dry run lists them; removing the run removes them too.
- **`sandforge-clone` gains `--files`, `--max-file-size` and `--files-as-is`.**

### Fixed

- **A clone no longer writes a file's content as its URL.** Other fields holding
  file content, such as a quote's generated document, are left empty and named.
- **An opportunity clone brings only the catalog its lines use**, not whole
  price books, and keeps quote and order lines priced from other books.
- **Catalogs sold under selling models clone**: their prices are no longer
  refused.
- **Prices are written before the lines that use them**, and an opportunity
  after its account, whichever object discovery meets first.
- **Activated orders and contracts clone**: written as drafts, they get their
  status back once the run has written everything.
- **A record whose optional parent could not be written is still written**,
  with that lookup empty, and the run lists every lookup it left empty.
- **Large scoped clones no longer overflow the query URI.**
- **Removing a run goes in one pass**, root included; activated orders go back
  to Draft first, and dates come from the org's clock, not this machine's.
- **The Forge dependency graph works from the keyboard** and with a screen
  reader: a node's name selects it.

## [1.37.0] - 2026-09-23

Forge can take back what it cloned, and Cancel stops what it cancels.

### Added

- **Remove the records a Forge run created**, from its history entry, even for
  a failed or cancelled run. The Production Guard is consulted.
- **A removal never touches records the run only linked to**, nor what a later
  record depends on, and keeps records changed since unless you include them.
- **The removal is audited, and its result lists per object** what was deleted,
  already gone, kept or refused, with Salesforce's reason.
- **Every write run shows in Live Operations** and Cancel there stops it: Forge
  runs, record clones, CSV imports and Frozen loads join Sync and Seed.

### Removed

- **The Settings category of configuration profiles**, which exported nothing:
  SandForge's settings are VS Code settings, which Settings Sync carries.

### Fixed

- **Record-scoped clones keep every child**, as does Frozen extraction; some
  were dropped without a word.
- **Cancel stops what it cancels**, between objects or batches of 200, and a
  cancelled upload over 200 records is aborted before Salesforce processes it.
- **Cancelled operations say cancelled** everywhere they are shown. Failed or
  cancelled Forge runs, failed plans and comparisons no longer stay "running".
- **Two windows no longer undo each other's saves.**
- **Configuration profiles carry Forge templates** into the project the import
  is made in, adding what it lacks or replacing it when overwrite is chosen.
- **Names count as personal data**, so Forge anonymizes them, quick-start
  templates included. The GDPR template keeps a phone's last four digits.
- **An unreadable stored date reads as unknown** instead of breaking a screen;
  a schedule's is planned again, not run at once, as is one set for 2054.
- **Compare shows what a deployment creates as an addition**, not in red under
  a minus, and the Deploy tab uses the same labels as the diff views.
- **Compare's risk level is translated**, and a pipeline's Compare step names
  the org that holds each difference.
- **A wizard shows one step at a time**; screen readers name Seed's field rules,
  favourite stars, side-panel status icons and what Compare's counts count.
- **A hidden Monitor reads no org**: auto-refresh waits until the panel is
  shown again.
- **Errors stay until you dismiss them**, including the extension's own.
- **The command-line tools read a usable token** where the Salesforce CLI now
  redacts it; `sandforge-clone --dry-run` prints what each object would receive.
- **`sandforge-clone --upsert` counts an updated record as updated**, and
  `sandforge-monitor` no longer gives a sandbox production's creation date.
- **Translations read as native text**; Japanese uses Salesforce's own terms
  for org and field.

## [1.36.0] - 2026-09-23

Forge anonymization works, checked against a real org: until now a clone
carried the source's personal data whatever the toggle said.

### Fixed

- **Forge anonymizes what it clones**, parents included, with the methods
  picked in Review; emails stay valid. `sandforge-clone --anonymize` works.
- **Sync keeps renamed, constant and formula fields**, which it lost.
- **A sync schedule runs once however many windows are open**; one whose run
  is still going is skipped, not failed.
- **Compare's risk score, severities and reasons read "removed" and "added"**
  the right way round, and the reasons are translated.
- **The shipped CCPA, HIPAA and Sandbox Scrub templates run in DataOps**; an
  anonymization writes only the fields it masks and is no longer refused.
- **A seed that wrote nothing, or was refused, says failed**, a partial one
  says partial, and a refused record keeps every error.
- **The Seed wizard describes each object only once.**
- **Cancel stops a Compare step**, and a backup cancelled from Live Operations
  is not retried.
- **The audit trail is complete**: a failed Forge run's counts, upserts split
  into created and updated, and every refusal with its code.
- **Imported orgs no longer store a redacted token**, now that `sf org list`
  hides tokens; the web sign-in confirms the org just logged in to.
- **Counts agree with their number everywhere**: no more "1 records".
- **Errors stay until read** and more of them are translated; the Production
  Guard dialog names the tier it asks about.
- **Schedules read in the panel's language**, and a cron with no run within a
  year is refused.
- **An aborted Forge run is announced to screen readers**, the confirmation
  field takes focus, and the Grappe page opens its setting.

## [1.35.0] - 2026-09-23

The last "coming soon" screens now work, and no write to an org runs without
its Production Guard.

### Added

- **Compare deploys what differs, validated first.** Only a passed validation is
  deployed, after the Production Guard; a production target is refused.
- **A validation shows each component's status and the failed tests**, and
  profiles and permission sets are marked as not deployable.
- **`sandforge-compare --validate`** runs a validation from the command line.
- **Real-time sync.** Sync's Real-Time tab applies the source's Change Data
  Capture events to the target, and says where to enable objects not published.
- **Real-time conflicts** follow your strategy or wait in the Conflicts tab;
  deletes apply only when enabled, and a session resumes where it stopped.
- **Pipelines start on a schedule, in its time zone, or on a sandbox refresh**,
  once however many windows are open.
- **A pipeline schedule runs while VS Code is open**; a start missed while it
  was closed is recorded, not run late.
- **DataOps → Compliance** lists fields holding personal data, finds a person's
  records by email, name or phone, exports them, and erases them once confirmed.
- **DataOps → Cleanup** recommends stale records, children missing a parent and
  duplicates, and deletes only what it recommended, after a dry run.
- **Forge templates**: Save as template keeps a run's configuration; the
  Template tab lists, applies, renames and deletes them.
- **Forge plans from a prompt**: the AI tab turns one into the root object and
  query discovery takes, checked against the org, and runs only on a click.
- **Sign in with a JWT or the device flow.** SandForge never opens the JWT key
  file; the device flow shows the code and the page to approve it on.

### Fixed

- **No write runs without its Production Guard**; deployments, real-time
  sessions, erasures and cleanups are audited with the guard's decision.
- **Autopilot keeps its links**: children keep their parent, record types are
  matched by name, and setup and metadata objects are not copied as data.
- **Sync's update and delete runs now write**; they wrote nothing.
- **A sandbox re-imported after a refresh keeps its entry**, and an unknown
  status no longer reads as completed.
- **A sandbox no longer shows production's creation date as its own.**
- **A restore asks first** when the org answers with another id than the one
  backed up.
- **Org pickers name each org by its type**, and the anomaly scan and the
  failed-jobs count say the bound they read within.

## [1.34.0] - 2026-09-23

Five more "coming soon" screens now work, pipeline steps run, and every seed the
wizard offers can start.

### Added

- **The audit trail and the lineage, in Reports**: every write run's outcome,
  Production Guard decision, counts and data flow per object, blocked runs too.
- **The audit trail keeps no record id, field value or error text.**
- **DataOps Quality tab**: a read-only scan of up to ten objects for fill rates,
  empty required fields, duplicates by key and records not modified for N days.
- **Seed relations**: children get parents from the run or the org, spread per
  parent over a range or by a ratio. `sandforge-seed` takes `--relation`.
- **Pipeline steps that run**: Backup, Compare, Pre-check and Notification.
  Steps that write to an org stay refused, since nobody is there to confirm.
- **Pipeline runs check each step's configuration first**; Cancel stops a run,
  and the history lists each step with its result.
- **A scheduler agenda**: the Scheduler tab lists sync schedules by the day
  each next runs, with the Sync tab's actions.
- **Anonymization templates of your own**, saved from the rules on screen and
  applied like the shipped ones.
- **Compare can leave out managed packages** (`--exclude-managed` in the CLI),
  and says when nothing differs.

### Fixed

- **Every seed the wizard offers can start**, with two to four objects, with
  Account or Contact, and with default numbers that fit their fields.
- **A seed relation that finds no parent skips its child** and reports it,
  instead of saying "success".
- **Autopilot links what the target already holds**: duplicates, the standard
  price book and direct account-contact relations. Refusals keep their code.
- **Autopilot starts Order and Contract as Draft** and sets their status last.
  A duplicate's id is read from a French answer, in Forge and Sync too.
- **The anonymization template view shows its rules**, not ": " for each.
- **A pipeline payload without variables no longer fails**, a step timeout over
  24 days is refused, and the API Limit Monitoring template's condition works.

## [1.33.0] - 2026-09-23

Compare reads what it compares, SandForge notices a sandbox refresh, and an org
of unknown type is guarded as production.

### Added

- **SandForge notices a sandbox refresh**, even one completed while VS Code was
  closed: it says so, lists it, and drops what it kept about the old org.

### Changed

- **Compare reads the content** of what both orgs hold, so ids and dates alone
  no longer count as changes.
- **What Compare cannot read is "not compared"**, with the reason, and never
  lets the risk card say "safe".
- **An org of unknown type is guarded as production**: every write asks, or
  refuses, as it does for production.
- **Monitor's storage panel says what it lists**: records by object, not data
  storage use.
- **Dates and numbers follow SandForge's language**, not the editor's, and
  counts agree with their number in all six languages.
- **The sidebar loads less**: script 408 → 346 kB, stylesheet 73 → 25 kB.
- **Help starts with Forge** and has sections for Autopilot, Migration and
  Reports.

### Removed

- **Compare modes that could not run.**
- **Automation's pause**, which could never resume.

### Fixed

- **Scratch orgs are imported**, and an org's name no longer stands in for its
  edition.
- **Monitor's lists say when they stop at a bound**, error logs are counted
  exactly, and trends and the health score use limits the API returns.
- **Monitor's org bar shows the API version, namespace and creation date**, not
  a login date that was always "now".
- **Automation runs each step once**, skips the branch not taken, honours false
  conditions and timeouts, and records a run that ran out of time.
- **Automation conditions compare by their value's type** and are checked before
  a run starts; the canvas works with a keyboard and a screen reader.
- **Forge links what the target already holds**: the account-contact relation
  Salesforce creates, and a duplicate the target does not name, found by key.
- **The second pass no longer waits for records no copy writes**, which every
  clone reported as unresolved.
- **A declined CSV import or clone no longer stays listed as running.**
- **After a sandbox refresh, a frozen dataset reloads from nothing**, and
  verification no longer reports every record of the new org missing.
- **The sandbox refresh trigger card says why it starts nothing.**
- **Screen readers hear SandForge's language**; unnamed controls have names, and
  Autopilot's live counts and Forge's finished run are announced.
- **A welcome page path card no longer ends onboarding** unless "Don't show
  again" is ticked, and a language that fails to load says so.
- **More text is translated**: Compare's deployment advice, Sync history's
  relative times, and the messages shown when the extension does not answer.

## [1.32.0] - 2026-09-23

Frozen Dataset works end to end between two real sandboxes; Automation no
longer reports work it did not do, and Compare and Monitor do what they say.

### Added

- **`sandforge-frozen`, `sandforge-compare` and `sandforge-monitor`**, headless
  runners for Frozen Dataset, Compare and Monitor.
- **Forge and Seed clone link a record the target names as a duplicate**, so
  children keep their parent; the result counts linked and unnamed ones.
- **Record types you cannot use are caught before writing**: Forge, Seed clone
  and Autopilot hold the object back and name the fix; Sync uses your default.
- **`maxNodes` and `excludedObjects`** in the Frozen Dataset configuration: how
  far discovery reaches, and which objects a dataset leaves out.
- **A frozen dataset shows its coverage**: objects reached, whether discovery
  hit its cap, and objects read without the date bound or left out for files.

### Changed

- **Light themes, everywhere**: every status and category colour comes from
  the theme.
- **Copies leave `AppUsageAssignment` alone**, which the platform refused on a
  quote.
- **Every upsert waives duplicate rules**, Forge's and the DataOps restore's
  included.

### Fixed

- **Frozen Dataset selection works on a real org**: roots are judged on their
  own records; an uncovered combination says why, an empty selection says so.
- **Frozen extraction reads what a dossier needs**, so orders keep their
  products, and an object without `CreatedDate` no longer stops it.
- **Objects carrying files the rules do not keep are left out and named**,
  instead of frozen empty and refused at load.
- **Frozen load writes what it was given**, in order, including standard prices
  and activated orders; a record type you cannot use is dropped and listed.
- **Every required field left empty is listed before anything is written**,
  where the load used to create placeholders and then stop.
- **Frozen reload purges what the last load wrote**, activated orders and
  prices included.
- **Frozen verification can pass on an org that is not empty**, and no longer
  fails on objects that refuse `COUNT(Id)`.
- **No Automation step reports work it did not do**: a pipeline with a step that
  cannot run is marked and refused. Delay waits, and stops on cancel or timeout.
- **Monitor reads what it shows**: storage, custom object counts, the instance
  name, API limits, each org's own alerts and every error-log entry.
- **An unreadable health signal says "unknown"**, not "healthy, 100", and
  Monitor's statuses are translated.
- **Compare compares what it says**: permission sets, reports, dashboards and
  email templates; "select all" diffs, and it no longer gives up at 30 seconds.
- **A restore brings back a record deleted since the snapshot**, from the
  recycle bin, with its id.
- **Refusals keep their status code**, so a French org's duplicate is
  recognised.

## [1.31.0] - 2026-09-22

DataOps, first run against a real org: a backup that stopped short no longer
passes for a complete one.

### Added

- **`sandforge-backup`**, a headless DataOps runner, takes, lists and restores
  snapshots; its restore never deletes and asks first unless told not to.

### Fixed

- **A backup that stopped at its bound says so**: up to 2,000 records per
  object, 500 on production. The run warns and the listing shows it.
- **A backup is no longer reported failed when pruning old ones fails**; the
  pruning warns and retries on that org's next backup.

## [1.30.0] - 2026-09-22

Autopilot, hardened on its first run against a real pair of orgs.

### Added

- **`sandforge-autopilot`**, a headless Autopilot runner.

### Changed

- **Autopilot and Sync never write a blank row** when the target's describe
  comes back empty.

### Fixed

- **An Autopilot plan holds the objects asked for**, not everything a lookup
  reaches, such as `User`, `Profile` or `UserLicense`.
- **A plan no longer walks into history, feeds and shares**, which the platform
  cannot insert.
- **Autopilot sends only the fields the target will take**, leaving out those
  it lacks; every object used to be refused.
- **Autopilot leaves an unresolved lookup empty** instead of writing the source
  id, so the record is no longer refused over that one field.
- **Autopilot waives duplicate rules**, so contacts are no longer refused as
  duplicates.

## [1.29.0] - 2026-09-22

Seed, hardened on its first run against a real org.

### Added

- **`sandforge-seed`, a headless Seed runner.** `--object Account:5` builds its
  field rules from the org's describe, so it writes what the panel would write.

### Fixed

- **A seed that would write nothing is refused** instead of reported as a
  success: an object asking for records must name a field to fill.
- **A seed stops before writing the children of an object that wrote none**,
  instead of filling the org with records attached to nothing.
- **A field the org lacks is left out** instead of every record of the object
  being refused; the result names what was dropped.
- **Duplicate rules no longer refuse seeded records.**

## [1.28.0] - 2026-09-22

Sync, hardened on its first run against a real pair of orgs.

### Added

- **`sandforge-sync`, a headless Sync runner.** It runs Sync the way the panel
  does, without the editor.
- **The object cap can be raised from the panel.** Discovery stops at fifty
  objects; a cut-short graph now says to raise the cap and discover again.

### Fixed

- **A sync sends only the fields the target will take.** Without a field
  mapping, every record of every object was refused.
- **Duplicate rules no longer refuse a sync's records**; a unique index still
  does.
- **A lookup to a record the target lacks no longer loses the row.** It is
  written again without its lookups; the result names what was dropped.

## [1.27.1] - 2026-09-19

Accessibility fixes in the AI panel and the Autopilot graph.

### Fixed

- **A conversation in the AI panel and its delete control are native buttons**,
  now announced to screen readers.
- **The Autopilot graph controls' container no longer reads as interactive**,
  and its border follows the theme.

## [1.27.0] - 2026-09-19

An Opportunity that carries products now clones completely: account, price
book, products, prices and line items.

### Added

- **Standard prices are carried.** The standard price book is matched on both
  sides, never by its localised name, and its prices go in before custom ones.

### Fixed

- **The standard price book is no longer cloned**: each run added a second
  "Standard Price Book" to the target.
- **A price book is sent one entry per product.** A second entry for the same
  product was refused, taking the line items with it.
- **Write order follows the lookups a record cannot be written without.** The
  same clone no longer fails on one run and succeeds on the next.
- **Three fields the describe calls nullable are treated as required**,
  `OpportunityLineItem.PricebookEntryId` among them.
- **A lookup left empty at insert is filled in as soon as it can be**, so line
  items are no longer refused while their opportunity lacks its price book.
- **Two tab bars answer the arrow keys**, Home and End; disabled tabs are
  skipped, and each bar is a single stop in the tab order.

## [1.26.1] - 2026-09-19

### Changed

- **`STANDARD_PRICE_NOT_DEFINED` is explained**: a product needs a standard
  price before it can be priced in a custom price book.
- **`INVALID_CROSS_REFERENCE_KEY` on a record type is explained**: the target
  does not let the running user use that record type.

### Fixed

- **A scoped read no longer pulls rows the write is bound to refuse**, such as
  entries of a price book the run will not create.
- **The side panel's status dot and the Forge card follow the theme**, and keep
  their contrast on a light theme.

## [1.26.0] - 2026-09-19

Record-scoped clones, hardened on runs between two real sandboxes.

### Added

- **`--list-objects` in the clone CLI** prints every object discovery reached,
  with its row count and depth, and stops before reading anything.

### Changed

- **A record-scoped clone reads every row before writing the first**, so an
  object reached only through its own children is written before them.
- **Discovery no longer loses a required parent to the node cap**, headless
  runs included, going past the cap up to twice its size.
- **Children of a parent the target already holds are no longer skipped.** The
  parent is still reported as failed, since its rows were not written.

### Fixed

- **The side panel shows it is loading** instead of "No org connected" until the
  extension answers.
- **The module you are on looks selected** in the side panel, and screen readers
  announce it as current.
- **The org list closes on Escape and on a click elsewhere.**
- **A favourite can be removed from the Favourites list**, whose rows now match
  the Modules rows in height and corner radius.
- **A long module name truncates** instead of pushing the star off the row.
- **Every row in the side panel shows a keyboard focus ring.**

## [1.25.5] - 2026-09-18

### Changed

- **Discovery reaches a required parent before it runs out of room**, going
  past the fifty-object cap, up to twice it.
- **The clone CLI takes `--max-nodes`** to raise the fifty-object cap when its
  summary prints `TRUNCATED`.
- **Known limitation:** a clone of an Opportunity that carries products still
  does not complete.

### Fixed

- **An object reached only through a descendant is no longer read as empty**:
  the price book of a cloned opportunity is no longer skipped.

## [1.25.4] - 2026-09-18

### Fixed

- **Line items send `UnitPrice` without `TotalPrice`**; sending both failed each
  one. The discovery cap can still leave out their `PricebookEntry`.
- **`--owner-map` works for owners who do not exist in the target**, the case
  it is for; those records were written with no owner.
- **The second pass no longer reports failures for records written correctly**
  because of a lookup, such as `OwnerId`, to an object no module clones.

## [1.25.3] - 2026-09-18

### Changed

- **The repository runs on Node 24** instead of 22.

### Fixed

- **The Forge record field has a label** a screen reader can read.
- **Duplicate rules no longer refuse a clone.** Account clones were refused
  with `DUPLICATES_DETECTED`; a unique index (`DUPLICATE_VALUE`) still refuses.
- **A lookup to an object no clone creates is dropped**, not the record:
  `OwnerId` becomes the running user unless an owner mapping says otherwise.
- **The headless clone CLI can authenticate**; every run used to end in
  `INVALID_AUTH_HEADER`.

## [1.25.2] - 2026-09-18

### Fixed

- **Autopilot's Live Stats update as each node finishes**, instead of staying
  at zero until the run ends. A failed node counts the records it wrote.

## [1.25.1] - 2026-09-18

### Fixed

- **No module offers to copy an object the platform will not create**, such as
  `User`, `RecordType` or `Profile`; Autopilot no longer tries to insert users.
- **Autopilot also leaves them out of an explicit selection**, like a saved
  configuration.

## [1.25.0] - 2026-09-18

### Fixed

- **The Organizations page no longer crashes** on an org stored by an older
  version.
- **Forge node cards fill in their counts during the run** instead of showing
  zero, or "size not measured", throughout.

## [1.24.2] - 2026-09-17

### Changed

- **An object is described once per org, not once per step**, and reused for
  five minutes: a Quick Sync no longer describes everything twice.

### Fixed

- **Each object of a sync keeps its own field mappings**: the mapping step lets
  you pick the object, and an unmapped one is copied field for field.
- **A Forge node says when its size is unknown** instead of showing zero
  records and fields.

## [1.24.1] - 2026-09-17

### Fixed

- **A built-in Forge template asks for the record it clones from** and will not
  start without a valid one. It used to clone whole tables into the target org.

## [1.24.0] - 2026-09-17

### Fixed

- **A built-in Forge template asks for the record it clones from** and will not
  start without a valid one. It used to clone whole tables into the target org.
- **The panels are styled again.** 1.23.0 shipped without its stylesheets, so
  the whole product showed as unstyled HTML.
- **A sync with no field mapping copies each record as it was read**; it used
  to send an empty record for every row.
- **Quick Sync and ten built-in templates insert** rather than upsert on a
  source `Id` that matched nothing, so running Quick Sync twice inserts twice.
- **An upsert without an External ID field is refused before the run**, with
  two ways out; the wizard starts with no key.
- **The auto-mapper follows the run's field-type rules**: it no longer proposes
  a mapping the run refuses, nor declines one the run accepts.
- **A failed run shows why** in its history detail.
- **A run that fails partway reports the objects it wrote** and its real
  duration.
- **A Sync draft falls back to what the page offers** instead of reopening on
  a direction or mode it no longer offers; every run from it was refused.
- **Quick Sync no longer syncs an added parent twice.**
- **Quick Sync no longer suggests parents it cannot create**, such as `User`,
  `Profile` or `RecordType`; adding users ended the sync.
- **Sixteen labels show text instead of their translation key**, in the
  Autopilot graph and in Sync history and schedules.
- **The welcome screen no longer repeats its greeting** as the first step's
  heading.
- **Forge no longer shows the previous run's progress** when a new run starts
  after an abort or a failure.
- **A skipped object no longer leaves Forge running forever.**
- **Forge's progress and time remaining count skipped and failed objects as
  finished**, so a completed run reaches 100%.
- **Graph node counts are translated**: "records", "fields" and "cloneable" were
  always in English.
- **The extension no longer installs its test files**, as 1.23.0 did.

## [1.23.0] - 2026-09-17

### Changed

- **Breaking:** username/password and browser login accept only Salesforce
  login hosts. For another host, such as `na1.salesforce.com`, run
  `sf org login web --instance-url <url>`, then add the org with SFDX Import.
- **Breaking:** `sandforge-cleanup` no longer sweeps insurance objects by
  default; name them in `--objects` when a clone wrote them.
- **AI:** Anthropic is the only provider; another one set in `settings.json`
  leaves AI off. A failed run's fix suggestion comes from the built-in error
  table even with AI off, once, as a notification in VS Code's display language.
- **AI token budget:** `sandforge.ai.tokenBudgetMaxPerSession` defaults to
  200,000 tokens. Changing an AI setting, the limit included, no longer
  restarts the count; "SandForge: Reset AI Token Budget" does. VS Code warns at
  80% and when requests are refused.
- **Forge:** Vlocity package objects are left out of a clone, and the AI tab is
  disabled as coming soon.
- **Seed:** a dry run is refused instead of answering an empty success, and a
  large seed sends at most 1,000 Ids and 1,000 errors per object to the page.
- **Automation** says what runs: only a manual run starts a pipeline, only
  Delay and Condition steps act, and the rest are marked coming soon. Finished
  runs reach History.
- **Automation:** "Run Last Pipeline" is now "Open Pipelines", and the templates
  that promised a dry run or an incremental sync are now Migration Pre-flight
  Check, Data Migration Check and Checked Sync.
- **Organizations:** production orgs are listed first, and JWT and Device Flow
  are marked Coming soon. The alias set in SandForge wins over `sf alias set`:
  rename orgs from the edit dialog, whose unused safety tier select is gone.
- **Renamed:** Compare's Permission Matrix and Drift Dashboard are now
  Permission Presence and Org Settings Drift, and "SandForge: Open Grappe" now
  reads "Open Grappe (partition progress)".
- **Performance:** Monitor runs its refresh calls together, Frozen Dataset no
  longer blocks the extension on disk, an idle window no longer calls
  Salesforce every 30 seconds, and Forge describes each object once per org,
  so a field just added on the target can take up to five minutes to show.
- **Telemetry** records errors locally and sends nothing, and now says so: the
  Settings counter reads "Diagnostic events recorded", and the output channel
  shows its records as readable lines instead of raw JSON.
- **Help, guides and the Marketplace listing** describe what ships: a sync
  cannot be undone, and CLI import and browser login need the Salesforce CLI.

### Removed

- **Breaking:** Sync's "Target to source" direction, which wrote source to
  target anyway, is gone; a configuration asking for it, or for incremental,
  delta or CDC mode, is refused. To copy the other way, swap the two orgs.
- **Sync:** the Real-Time and Conflicts tabs are gone, and so is the Manual
  conflict strategy: a saved configuration using it reopens on Source wins.
  Attachment, ContentVersion and Document are no longer offered or accepted.
- **"SandForge: Cheers!"** is no longer in the Command Palette.

### Fixed

- **Sync:** a WHERE filter can only filter. A clause past it, such as the
  `LIMIT 1` that copied one record and reported success, is refused before the
  run, in Clone, Frozen Dataset and Autopilot filters too.
- **Sync:** a field that cannot hold its value stops the run before anything
  is written, and transform rules keep what you type and leave `Id` and the
  external ID alone.
- **Sync:** a Save button stores a configuration for schedules to run; the
  Schedules and History tabs fill, exports say where they went, and a scheduled
  run can be cancelled and says how it ended.
- **Grappe:** Sync reports to it only at or above
  `sandforge.grappe.autoActivateThreshold`, at a cost of one API request per
  object, and an Autopilot run opens and closes under one id.
- **Forge:** record-scoped clones with more than 600 children run to the end,
  as does Frozen Dataset extraction; records get the target org's record type;
  Business Hours and Operating Hours match however many rows they hold.
- **Forge:** a SOQL query's WHERE clause filters its object, on Discover and
  Reuse last graph; Back or a new discovery stops the running one at once;
  Select All and Deselect All act on the rows the search shows.
- **Forge:** the Errors panel explains the errors it recognizes in six
  languages, results name the objects cut short at 50,000 records or 500 pages,
  and parent fetching skips the objects discovery skips.
- **Forge command line:** documented as two scripts run with `pnpm exec tsx`
  from a checkout. A bad flag exits 2 before any org is contacted, `--owner-map`
  works, and master-detail fields read as in the wizard.
- **Seed:** the Quick Seed templates run, wizard fields open on rules the run
  accepts, and Faker methods are picked from a list; an unknown one is refused
  before the first insert.
- **Seed values:** personas reach every object, values fit their field, and AI
  fills text fields only, never leaving one blank.
- **Seed:** Quick Seed shows its progress, Stop stops your own run, Save as
  template works and saved templates open, and the clone wizard reports a
  failure at once, in your language.
- **AI:** a new API key works once saved, turning AI off stays off, a failed
  call is one request instead of three, a repeated failure asks the model once,
  and messages point to Settings > AI > API key.
- **AI drafts:** a pipeline draft in a markdown fence loads its steps, an empty
  one is refused with a reason, NL2SOQL accepts parent-child subqueries, and AI
  personas keep only what Seed can generate.
- **Monitor:** the anomaly scan runs on any object, Other object… included, and
  the Compare, Autopilot and Sync reads that shared its query are fixed with it.
- **Monitor:** trends cover the 7 days they claim and the 30-day button is
  gone; governance rules with no reading show as not measured; Org Health Check
  counts failed jobs and error logs.
- **Monitor:** Live Operations cancels the Seed and Sync runs it lists and
  offers no pause, Active Sessions name the user, acknowledged alerts show in
  the history, and recent jobs show their age and sort on the Created column.
- **Organizations:** edits are saved and survive a re-import or reconnect, an
  expired org offers Try Reconnect, a missing Salesforce CLI message stays up
  with an install link, and Open Org in Browser works from the Command Palette.
- **Connections:** an org or a Salesforce CLI that never answers no longer holds
  up startup or its caller, and operations recovered from the last session wait
  for the network.
- **Frozen Dataset:** warns when `SANDFORGE_FROZEN_SALT` is not the dataset's
  salt, and a reload that cannot read its mapping stops instead of loading the
  records twice.
- **DataOps and Migration** say what they do: a backup is a full snapshot of
  Account and Contact, restored whole; Create Template is disabled as Coming
  soon; Migration's Run writes to the target org.
- **Production Guard:** the confirmation names every object a run writes to and
  no longer states a record count nobody measured.
- **Home and onboarding:** the recommended action opens its screen ready to go,
  Connect org no longer ends onboarding at step 1, and What's New shows only
  your version's highlights.
- **Panels:** answers, progress and errors reach only the request that asked, so
  another run no longer moves or aborts yours; a refused request fails at once,
  in its own panel only; a crashing page leaves navigation working.
- **Runs:** closing or reloading the window aborts running syncs, seeds, CSV
  imports, Frozen Dataset and Forge runs and DataOps backups, and a failed or
  aborted clone is no longer recorded as completed.
- **Bulk API jobs** share one cap of five per window, whichever run opens them;
  a write that would open a sixth stops with an error.
- **Languages:** German gets its umlauts and Spanish and Portuguese their
  accents; SandForge follows VS Code's display language until you choose one,
  and a language that fails to load is reported.
- **Accessibility:** text reaches readable contrast on seven VS Code themes,
  dialogs keep focus and close on Escape, progress bars are named and announced,
  org pickers show status by shape, and reduced motion is respected.
- **CI examples:** the cleanup step is always a preview, org stages run only
  when a record Id is set, failed GitLab and Azure runs are reported, the Azure
  clone waits for the quality gates, and pnpm comes from the repository's pin.

### Security

- **Login credentials go only to Salesforce login hosts.** Browser login passes
  only the host to the Windows shell and refuses a URL with a path, query,
  fragment, port or credentials.
- **AI:** Salesforce Ids in a failed run's message become `<id>` before it
  reaches the model, SandForge's own refusals are not sent, and
  `sandforge.ai.errorResolution` turns the sending off.
- **DataOps masking** keys fake personas and `preserve_format` values with the
  anonymizer's salt, so they can no longer be matched across installations or
  traced back by trying candidates. The shipped templates carry no salt: a
  record keeps its fake values within a window and gets new ones in the next.
- **Hardening:** sync configurations keep only known keys and a single-field
  upsert key; panels load only the webview bundle; Forge checks object names
  before requests; CI examples no longer leave auth URLs on the build machine.

## [1.22.0] - 2026-09-15

Things that said they worked: each is now done, refused out loud, or gone.

### Changed

- **Breaking:** the AI token budget is enforced: 50,000 tokens by default, about
  a dozen exchanges. Raise `sandforge.ai.tokenBudgetMaxPerSession` or reload.
- **AI:** the `sandforge.ai.model` description names every AI feature it sets.
- **Docs** now say Sync is one-way, only Automation's Delay and Condition steps
  execute, and there are no scheduled runs, real-time sync or audit trail.
- **Smaller package:** VSIX 2.08 MB → 1.81 MB, translations 642 KB → 499 KB.

### Removed

- **AI:** failed-job diagnosis. No screen could start it, yet with AI set up it
  could run anonymous Apex in an org without a confirmation dialog.
- **AI:** module suggestions and AI personas, which no screen requested. Seed's
  own personas are unaffected.
- **Sync:** configuration fields that ran anonymous Apex before and after a
  sync. A configuration that still carries one is refused.
- **Sync:** `dryRun`, a dry run it never performed. `true` synchronised for real
  and is now refused; `false` is still accepted.
- **Seed:** the field step's suggest button and validation-rule warning strip,
  which nothing could fill.

### Fixed

- **Exports:** a refused export, such as a DataOps backup over the size limit,
  shows an error instead of a confirmation.
- **DataOps:** restore and anonymization report a partial or failed result when
  Salesforce rejects records, with a sample of its errors, and notify you.
- **Errors:** each error reaches the request that caused it; a Sync, CSV import
  or Clone no longer takes another request's error as its own.
- **Confirmations:** a typed confirmation starts empty every time, instead of
  reopening already armed after the page closed it.
- **Monitor:** the critical-jobs band flags Apex jobs that stopped progressing,
  and shows "unknown" rather than "all clear" when it has no data.
- **Monitor:** the critical-jobs band links to Setup › Apex Jobs, where aborting
  works, instead of an abort that always failed.
- **Monitor:** the anomaly scan reads the object you pick, not only Account, and
  says when a run finds nothing or fails.
- **Compare and Monitor:** schema advice and the anomaly scan work with AI off
  and no key stored.
- **AI:** one budget meters every AI call; the assistant's gauge turns amber at
  80%, and a refused Seed call falls back to Faker data.
- **AI:** a saved conversation continues after a restart or an AI setting
  change, with its full history; deleting one removes it from storage too.
- **AI:** a failure shows its reason in the conversation, ready to copy; one
  from another panel no longer appears there.
- **AI:** a failed operation is explained once, not once per open panel; a known
  Salesforce error gets a built-in answer without contacting the provider.
- **AI:** turning AI off stops every AI feature at once, and turning it back on
  restores them, without reloading the window.
- **AI:** natural-language SOQL uses the fields of up to five objects you name,
  rejects a draft with an unknown field, and says when it could not check.
- **Seed:** a persona's AI-generated fields receive its instruction again,
  editable in the configuration step.
- **Seed:** a built-in persona's ranges, value lists, prefixes and locales reach
  the generator, and digit masks such as SIRET get digits instead of the mask.
- **Seed:** product names, IBANs with valid check digits and ISO 9362 BICs
  replace lorem sentences.
- **Seed:** an unimplemented faker method stops the run before any record is
  written, naming the method.
- **Sync:** a configuration's `orderBy`, such as one imported from SFDMU, sorts
  real runs; it accepts only field names with ASC/DESC and NULLS FIRST/LAST.

## [1.21.0] - 2026-09-10

The end-to-end suite runs again, and every fix below is a bug it found.

### Fixed

- **The compliance report no longer crashes on open** after an Autopilot run.
- **Compare's Permission Matrix, Snapshots and Drift Dashboard render**
  instead of taking down the page; a bad answer is an error, not an empty view.
- **Conflict resolution no longer carries choices onto the next record**, where
  Apply could write one record's values onto another.
- **Real-time sync uses the conflict strategy you pick**, not always
  `source_wins`; where objects disagree, it falls back to manual resolution.
- **Stopping a real-time stream stops the right one** when two are running, and
  a single pushed event is no longer dropped.
- **Forge's record-per-object cap has an accessible name**; screen readers no
  longer announce just "combo box".

## [1.20.0] - 2026-09-09

Reports stops apologising and starts reporting.

### Added

- **Reports works**: the Executions tab and success rates come from Forge and
  Sync run history, with no call to your org. Each report exports as JSON.
- **Copy an error in one click** from any banner; long and multi-line errors are
  no longer clipped.
- **Search your orgs** once you have more than five; the Organizations panel no
  longer stays blank during the initial load and CLI import.

### Fixed

- **Forge refuses an unreadable record id on the spot** instead of sending the
  run, and Enter starts discovery from the record field.
- **A failed Forge discovery shows its error** instead of leaving the previous
  graph on screen, where it could be run as the new one.
- **Failures come first**: failing job groups and breached governance rules sort
  to the top, and each job filter shows how many jobs it keeps.
- **Error messages carry the Salesforce error code**, such as `DUPLICATE_VALUE`,
  and `MULTIPLE_API_ERRORS` lists the errors it holds.
- **The Settings save button shows only on the tab it saves.** "Reset to
  defaults" asks first and restores the default language.

### Security

- **The critical advisory in the shipped VSIX is closed**: `websocket-driver`
  (critical) and `form-data` (high) are pinned to patched versions.

## [1.19.0] - 2026-09-09

Buttons that told you they had worked, and had done nothing.

### Changed

- **Monitor no longer asks the org the same question twice**, and a refresh that
  overruns its limit stops instead of spending more API calls.
- **Forge's preview caches the org's object list** instead of re-downloading
  1–2 MB for each corrected record id.
- **A large clone's result table scrolls** instead of freezing the tab.
- **Configuration is no longer rewritten for nothing**, as Monitor's polling did
  every thirty seconds.
- **The walkthrough has a button on every step**, and "Open Org in Browser" is
  gone from the command palette, where it could only fail.
- **More of the UI is translated**: Grappe settings, the restricted-mode
  warning, empty states, "coming soon" badges and Monitor's Auto button.

### Fixed

- **"Pipeline saved" waits for the save**; a rejected one no longer shows green.
- **An AI-generated pipeline reaches the canvas**, and a refusal says why.
- **Installing a marketplace template installs its steps**, not an empty
  pipeline under its name.
- **Migration's "Run" shows a result or an error**; it used to show neither.
- **A failed sync is recorded in the history**, so it can be re-run.
- **A production seed's confirmation shows the real record count**, not 1, so
  volume thresholds can trigger.
- **A DataOps error no longer ends another operation still running**, such as a
  restore, with the wrong message.
- **A rejected request fails** instead of waiting out a 30-second timeout.
- **A new attempt clears the previous result**: a failure no longer shows above
  the last run's success.
- **Disconnecting an org drops its token** instead of keeping it until shutdown.
- **Compare's Deploy tab and Seed's relations editor say they are unbuilt**,
  instead of "No data" and an empty relation row that was never sent.

## [1.18.0] - 2026-09-09

The repository is public, and the release that opens it repairs Forge.

### Changed

- **The repository is public**, so the listing's links no longer answer 404:
  [github.com/StephaneBerthoz/sandforge](https://github.com/StephaneBerthoz/sandforge).
- **The extension activates on startup**, so scheduled syncs survive a restart
  without first opening a SandForge panel.
- **The Marketplace listing** has revised categories and keywords, and its
  opening image shows the current product.
- **The in-app help no longer lists a CDC sync mode**, and a sync template no
  longer promises attachments that Sync does not transfer.
- **Grappe is described as it works**: Seed, Sync and Autopilot activate it;
  it splits the reporting, not the work.

### Fixed

- **Forge clones objects with more than 200 records**, instead of failing them
  and skipping their whole subtree.
- **A Forge clone no longer stops at 2,000 records per object** while reporting
  success; a run that hits its record or page limit says so.
- **DataOps Restore works, for the first time.** Fields nobody may write are
  skipped and reported; one you may not write still refuses the restore.
- **"Preview anonymization" no longer anonymizes the org.** It says a simulation
  does not exist yet, and Apply asks you to type a confirmation.
- **A failed org connection shows its error** and keeps what you typed, instead
  of closing the form as if it had worked.
- **A pipeline over 30 seconds is no longer reported failed** while it runs.
- **A failed Forge run can be re-run immediately**, not blocked as a duplicate
  for an hour.
- **An expired Salesforce session recovers on its own**, with no window reload.
- **Forge discovery reports an object it could not read**, with the org's
  reason, instead of dropping it silently.
- **Reports says it has no data** instead of showing zeros.

### Security

- **Production Guard judges a sync's real operation and objects**: a delete-mode
  sync against production is no longer checked as a one-row upsert.
- **Restoring a backup goes through Production Guard**, and can no longer target
  an org other than the one the backup came from.

## [1.17.0] - 2026-08-13

A new icon, and a round of accessibility and translation fixes.

### Changed

- **New icon**: fire in a hearth replaces the anvil in the Marketplace and the
  activity bar.

### Removed

- **The `sandforge.grappe.maxWorkers` setting**, which promised parallelism the
  product does not have. Nothing read it.

### Fixed

- **Inputs have names for screen readers**; sortable headers and clickable rows
  have keyboard paths, focus rings are back, and ARIA labels are translated.
- **The record id you type on Home reaches the Forge form.**
- **Grappe's empty state points somewhere useful**, not to Forge, which cannot
  produce a Grappe run.
- **The French UI and Marketplace description have their accents back.**
- **AI error resolution answers the question**, instead of "Unable to determine
  root cause." for every failed operation.

## [1.16.0] - 2026-08-13

Faster backups, and a Marketplace listing whose images load.

### Changed

- **A backup no longer slows down every setting change and startup.** Records
  now go to files; existing backups stay restorable, with nothing to migrate.
- **The screenshots show the product you get**: four modules, with real content.
- **The Marketplace images load**; all six were broken.

## [1.15.0] - 2026-08-13

This release finishes things the codebase had already built.

### Added

- **The Restore button runs a restore**; it sent nothing before.
- **Your backup list appears**, with its counters, instead of staying empty and
  showing an error after 30 seconds.
- **Forge's results list each created record's new Id** against its source Id.
- **An imported SFDMU config can be run**, after you choose which orgs to use.
- **Forge recipes are saved in `.sandforge/forge-templates.json`** in your
  workspace, ready to commit and share; existing ones migrate on first use.

### Changed

- **Forge SOQL mode says it ignores your `WHERE` clause** and caps a run at 200
  records per object, where it was unbounded.
- **The Marketplace icon gains a strike spark**; the activity-bar icon does not.
- **Frozen Dataset coverage selection** no longer repeats a full schema
  discovery for every candidate root.

### Security

- **An arbitrary code-execution path is removed**, with the plugin feature it
  backed, which had no interface.
- **Opening an org in the browser requires an HTTPS instance URL**;
  `javascript:` and `file:` URLs got through before.

## [1.14.0] - 2026-08-12

Controls that looked like they worked, and did not.

### Changed

- **Breaking:** a `hash` anonymization rule without a salt now fails. Add a
  `hashSalt` to affected rules.
- **Docs** mark what is not built: Grappe does not auto-activate, Reports has no
  data feed, and four of the six DataOps tabs are previews.
- **Frozen Dataset coverage selection** no longer replays a full schema
  discovery per candidate root: several hundred describe calls on a large org.

### Removed

- **The Sync "Mode" dropdown**: every run was a full sync, whatever you chose.

### Fixed

- **DataOps backs up and anonymizes the org you selected**, not the first in
  your list, and shows the target before you click.
- **Cancel stops a clone, CSV import or Frozen Dataset load.**
- **Seed and Sync show real progress**, instead of bars stuck at 50% and 0%.
- **Connecting an org no longer freezes the panel for 30 seconds**, and OAuth
  web login no longer wipes what you typed.
- **A failed Monitor query shows an error**, not an empty result.
- **Forge Review's "Plan" tab loads**, and a failed plan shows as a failure, not
  an endless spinner.
- **Sync History, Sync Schedules and Settings → AI show labels**, not raw keys.
- **The Real-Time tab no longer claims a live stream** that does not exist.

### Security

- **The `hash` anonymization method uses keyed HMAC-SHA256.** Its old values,
  written to your org, were reversible.

## [1.13.0] - 2026-08-12

### Changed

- **Breaking:** a `hash` rule without a `hashSalt` now fails. Add a salt to
  affected rules.
- **Extension activation is roughly twice as fast.**
- **Activity-bar and Marketplace icons are redrawn**; the activity-bar mark is
  larger and centred.

### Fixed

- **Forge runs.** "Execute Forge" only switched screens and nothing was written;
  a backend failure now shows in the log stream.
- **Abort stops a Forge run**, which used to keep writing to the target org.
- **Transient Salesforce errors are retried again**, `UNABLE_TO_LOCK_ROW` and
  `REQUEST_LIMIT_EXCEEDED` included.
- **Selecting an org reaches the extension**; it was ignored before.

### Security

- **`hash` anonymization uses keyed HMAC-SHA256.** Its old values, written to
  your org, were reversible.
- **Client identity is gone from all public artifacts**, this changelog included.

## [1.12.0] - 2026-08-12

### Fixed

- **Monitor storage breakdown works again.** The card stayed empty on every
  refresh on older API versions.
- **Monitor recent deployments work again.** Every org answered "sObject type
  not supported".
- **Monitor sandbox refresh** no longer errors in a loop on sandbox orgs; the
  panel simply shows no events there.
- **Forge discovery in template mode starts**, using the selected template's
  saved record or SOQL input.

## [1.11.0] - 2026-08-11

### Changed

- **The sidebar loads faster and uses less memory.** It ships its own 377 KB
  bundle instead of the 1.8 MB panel bundle, without the diagram-only styles.

## [1.10.0] - 2026-08-11

### Changed

- **Every webview is about 440 KB lighter.** Only English is built in; the five
  other languages load when picked.

### Fixed

- **The selected org is kept everywhere.** A Monitor or panel opened after
  picking an org in the sidebar or status bar shows that org, not the first.
- **Monitor health-score card** no longer overflows narrow panels.
- **Monitor header keeps the org alias readable**; the action buttons wrap to
  their own row.
- **Governance header and Jobs filter buttons** wrap on narrow panels instead
  of overflowing.

## [1.9.0] - 2026-08-11

### Added

- **Forge discovery shows live progress** (objects scanned, queue) instead of
  looking frozen for 30 to 90 s on large orgs.
- **The AI provider status banner gets its data**: breaker state, cooldown end
  and error kind.

### Removed

- **The Organizations tree view.** The launcher dropdown (active org, safety
  tiers, open in browser) is now the single place for orgs.
- **The back-pressure badge**, which always showed a false "normal".

### Fixed

- **Operations queued by a crashed session** run at startup once the org is
  reachable, instead of waiting indefinitely.
- **Picking an org in Monitor or the org manager** carries over to the status
  bar, sidebar and other panels.
- **Migration imports** refuse files above 50 MB and accept valid Windows paths
  whatever the drive-letter case.
- **A Monitor error** no longer shows up in another Monitor panel open at the
  same time.

## [1.8.4] - 2026-08-11

### Fixed

- **Auth self-heal uses a live token** from `sf org auth show-access-token`:
  a "Connected" org could reject the stored one. Older CLIs work as before.

## [1.8.3] - 2026-08-11

### Removed

- **The CI badge** is gone from the Marketplace listing. No functional change.

## [1.8.2] - 2026-08-11

Org-session fixes, and SandForge now follows the sf CLI's default org.

### Added

- **Starts on the sf CLI's default org.** When no org is selected yet, the
  registered org matching the CLI's `target-org` is selected.

### Fixed

- **Self-heal uses the org's current instance URL**, so a sandbox refresh or a
  My Domain change no longer ends in `INVALID_AUTH_HEADER`.
- **Org counters no longer tick down one by one** during the startup check.

## [1.8.1] - 2026-08-11

### Fixed

- **Duplicate orgs are pruned at startup.** Entries left by early builds showed
  twice in org lists and kept "Authentication expired" loops going.

## [1.8.0] - 2026-08-11

Every overlay, trigger and crash report now works in the panels, and dead code
leaves the bundle.

### Changed

- **Smaller webview bundle**: unreachable code is gone (27.6 KB, 6.2 KB
  gzipped) and the animation library no longer ships whole.
- **Durations in Scheduler, Sync History and Audit Trail** use the common
  format.

### Fixed

- **Webview crash reports** reach the extension and are logged to the output
  channel; they were dropped.
- **The `sandforge.cheers` easter egg works**: Konami code, command, or seven
  clicks on the logo.
- **Welcome and What's New** open only in the panel that triggered them, not in
  every open panel.
- **Forge execution shows live progress.**

## [1.7.0] - 2026-08-11

Registered orgs are checked at every launch, so an expired session is refreshed
before your first operation.

### Added

- **Org check at startup** (`sandforge.orgs.validateOnStartup`, default
  `true`), with each org's status shown live in the sidebar and org pickers.

### Changed

- **Marketplace page** carries the full README: all 14 modules, five
  screenshots, the FAQ and the complete configuration reference.

### Fixed

- **Token self-heal** checks a CLI token with a real API call before storing
  it; a stale token no longer overwrites the stored one.
- **A stale sf CLI store is reported**: the error says the CLI needs
  re-authentication instead of retrying a known-bad token.

## [1.6.0] - 2026-08-11

Messages that were silently dropped now arrive: Sync tabs, Forge run controls
and onboarding.

### Changed

- **Docs**: the FAQ marks the cron scheduler as coming soon and no longer lists
  `sandforge.grappe.enabled`; the walkthrough reflects Anthropic-only AI.

### Fixed

- **Sync tabs work again**: history, schedules, CDC and conflicts no longer
  spin forever or lose reruns, exports, schedule saves and resolutions.
- **Forge pause, resume and abort work.** Before, the destructive run went on
  untouched.
- **Declining a Seed production confirmation** no longer hangs for 120 s.
- **Welcome and What's New are no longer lost on first open**, and are marked
  seen only once shown.
- **What's New shows in module panels.**
- **The sidebar follows the configured language**, and updates live when it
  changes in Settings.
- **In-app Help lists the real shortcuts** (Ctrl+1..9/0, G+key chords, Ctrl+K)
  in all 6 languages.
- **Marketplace listing images and links resolve** now that the repository is
  public; a static version badge replaces the retired ones.

## [1.5.0] - 2026-08-10

Features shipped earlier but invisible in production now reach you.

### Added

- **Keyboard shortcuts, the command palette and the welcome overlay** work in
  panels and the sidebar, and reduced motion is honored there.
- **The sidebar receives live updates**: recent operations and org changes.
- **Extension manifest in all 6 languages**: command titles, view names,
  walkthrough steps and setting descriptions.
- **Marketplace listing**: badges, a Q&A tab on GitHub Discussions, a
  `Testing` category, the FAQ and module screenshots.

### Changed

- **Error messages are capped in size** instead of listing thousands of schema
  issues.

### Fixed

- **A failed offline replay no longer loops forever** with two or three
  notifications per cycle; it is dropped and the failure reported.
- **Seed failures show at once** instead of timing out after 120 s, and a
  failed seed is no longer reported as completed.
- **A late error from an older Forge preview** no longer wipes the current one.
- **The chosen language is kept**: saving settings no longer resets it to
  English. The Welcome page offers all 6 languages.
- **QuickSync** no longer shows a permanent spinner after a panel reload.

## [1.4.0] - 2026-08-10

Hardening after 1.3.0: a safer offline queue, recent-operations panels that
fill in, and docs brought in line.

### Added

- **Offline queue notifications** when an operation is queued, replayed or
  fails to replay.
- **Recent operations** (Home, sidebar, status footer) show real activity; they
  were always empty.
- **`sandforge.openReports`**: every module now has its own command.
- **Keyboard shortcuts for every module**, as chords and Ctrl+number.
- **German, Spanish, Japanese and Brazilian Portuguese** in the Settings
  language selector.

### Changed

- **Seed runs are no longer replayed after a network failure**, to avoid
  duplicate records: you get a retry hint. Sync still replays automatically.
- **Operations queued while online run right away** instead of waiting for a
  reconnection that may never come.
- **Reduced motion** is respected everywhere.
- **Docs** list all 14 modules, mark the Automation scheduler as coming soon
  and state the Node 22 requirement everywhere.

### Fixed

- **The Welcome "don't show again" checkbox** is honored.
- **A failed sync** is no longer notified as completed.
- **QuickSync** no longer restores a permanent spinner after a reload mid-run.
- **Forge record previews** keep the latest answer; a stale one no longer
  replaces it.
- **Open in Browser** no longer fails on a malformed stored instance URL.
- **A crash in a panel or the sidebar** no longer leaves it blank.
- **Sizes, relative times, estimates and progress bars** cope with invalid
  values.

## [1.3.0] - 2026-08-10

The listing tells the truth and navigation reaches every module; new
Organizations view, Get Started walkthrough and SFDMU import.

### Added

- **Organizations view** in the sidebar: every org with its type icon, a
  refresh action and Open in Browser (`sandforge.openOrgInBrowser`).
- **Get Started walkthrough**: connect an org, first Forge clone, monitor
  limits, explore settings.
- **Migration page** (`sandforge.openMigration`) turns an SFDMU `export.json`
  or a CSV or JSON file into a Sync config to review. The file is only read.
- **A command for every module**: `sandforge.openSeed`, `sandforge.openSync`,
  `sandforge.openAutopilot`. No route falls back to Monitor any more.
- **Live operations tracker** shows seed and sync runs, manual or scheduled,
  with real progress.
- **Offline resilience**: seed and sync runs that fail on a network error are
  queued and replayed when the connection returns.
- **The chosen language survives reloads** and applies at once, with no English
  flash at startup.
- **German, Spanish, Japanese and Brazilian Portuguese translations** are
  complete.

### Changed

- **Extension bundle about 118 KiB smaller**: the Anthropic SDK loads only on
  the first AI call. AI stays off by default.
- **`ctrl+shift+r` and `ctrl+shift+a`** work only inside the SandForge view,
  not globally.
- **Virtual and untrusted workspaces** are declared unsupported.
- **Favorites now survive reloads.**

### Removed

- **The `sandforge.monitor.persistTimeSeries` setting** and unused Settings
  fields.
- **The misleading `Formatters` Marketplace category.**
- **Local tooling state and already-bundled source folders** no longer ship in
  the VSIX.

### Fixed

- **Monitor auto-refresh fires.**
- **Webview crash reports** are sent; they never were.
- **Closed panels are released** instead of piling up until the extension
  stops.
- **Marketplace listing**: homepage and issue links no longer 404, and the
  description no longer claims real-time CDC or several AI providers.

## [1.2.12] - 2026-08-06

### Changed

- **No longer a preview release** on the Marketplace.

## [1.2.11] - 2026-08-06

### Fixed

- **The Forge walkthrough GIF shows** on the Marketplace listing.

## [1.2.10] - 2026-08-03

### Changed

- **Both READMEs open with a "first clone in 2 minutes" Forge walkthrough**,
  with an animated GIF.
- **Shorter Marketplace page**, with docs links that work from it.

## [1.2.9] - 2026-08-03

Expired credentials heal themselves, real errors replace fake timeouts, and
every module says what it is for.

### Added

- **Expired sessions recover**: SandForge refreshes the token once through the
  sf CLI and retries; otherwise it tells you how to reconnect.
- **Every module's empty state** gives its job and numbered first steps. The
  Welcome page offers three paths: Forge from a record, Seed, Frozen replay.
- **Autopilot works end to end**: scan, compliance, plan, execute and report,
  with live progress; concurrent runs no longer share pause and skip.
- **Manual retry** replays a failed sync from history.
- **The status bar shows the selected org** and its connection status.
- **Production Guard covers Forge and Autopilot writes**: tier check, audit log
  and confirmation on production targets.

### Fixed

- **An org gone from the config no longer stays selected**, which left Forge on
  its empty state and Monitor timing out.
- **QuickSync works end to end**: suggestions, relationships, preview and run.
- **Real errors show** everywhere instead of `timed out after 30000ms`.
- **Monitor refresh** gives up on a stalled org after 25 s.
- **The Abort button aborts.**
- **The Telemetry settings tab** shows and saves the real setting.
- **Autopilot tier colors** apply.
- **Long bulk operations** (sync, seed, clone, CSV, backup, anonymize) no longer
  show a false failure while still running.
- **The scroll position resets** when you change page.

### Security

- **Every bridge handler validates its payloads.**

## [1.2.8] - 2026-08-03

### Fixed

- **Real errors show at once** (expired connection, unreachable org, SOQL
  failure) instead of a generic `timed out after 30000ms`.
- **Monitor refresh** reports a stalled org with an explicit error after 25 s.

## [1.2.7] - 2026-08-03

A hardening pass and a new module: Frozen Reference Dataset.

### Added

- **Frozen Reference Dataset** (`sandforge.openFrozen`): extract a dataset once
  from a UAT sandbox and replay it identically into refreshed dev sandboxes.
- **Frozen extraction** pseudonymizes deterministically with a never-stored salt
  (`SANDFORGE_FROZEN_SALT`), runs a re-identification check, writes a manifest.
- **Frozen loading** targets sandboxes only, with a pilot mode, per-phase
  progress, a full load report and a read-only check afterwards.

### Changed

- **Smaller extension**: the bundle drops from 6.7 MB to 2.3 MB.
- **AI uses one secret key**, `sandforge.ai.anthropic.key` (older keys are
  migrated), and one default model; `sandforge.ai.enabled` is honored.

### Removed

- **Settings that did nothing**: `language`, `monitor.autoRefreshInterval`,
  `api.timeout`, `api.retryAttempts`, `grappe.enabled`, `grappe.threshold`.
- **Five default keybindings** that shadowed native VS Code shortcuts.

### Fixed

- **Sync schedules run**, up to `sync.maxConcurrentOps` at a time; they never
  fired.
- **Sync history, Seed clone and CSV import, and AI conversations** respond;
  so do diagnose, manual retry, Monitor alerts, seed templates, sync configs.
- **No more total connection lockup** until VS Code restarts: each org has its
  own circuit breaker.
- **Bulk API results are truthful**: records no longer all count as successes,
  and IDs are real.
- **Seed clone and CSV import errors** show instead of a 30 s timeout.
- **Pipelines, governance policies and Compare** get their answers; a pipeline
  save was silently lost.
- **"Show Details"** no longer opens a blank panel.
- **`sandforge.telemetry`** is read, and its status and toggle reflect it.

### Security

- **Shell injection closed** in the web login (alias and instance URL).
- **Path traversal closed** in Migration file imports.
- **Payload validation extends across bridge handlers**; a sync request can no
  longer carry an arbitrary WHERE clause.
- **`safety.requireProdConfirmation` and `safety.auditLogging` are enforced**:
  confirmation on production targets, bounded audit log.
- **Webview listeners check the message origin.**

## [1.2.6] - 2026-05-05

Monitor v2 core and AI integration, plus close-out hardening.

### Added

- **AI:** an AI panel, opened with `sandforge.openAI` or the Bot icon in the
  sidebar.
- **AI:** diagnose investigates with 10 read-only tools (DML refused) and
  proposes up to 5 actions; gated ones offer Approve, Modify or Reject.
- **AI:** Anthropic is the working provider; picking OpenAI or Custom in
  `sandforge.ai.provider` does not crash and answers that they ship later.
- **AI:** after 3 consecutive overloaded answers the provider pauses for
  5 minutes; a status banner counts down.
- **AI:** per-session token budget (`sandforge.ai.tokenBudgetMaxPerSession`,
  default 50000), warned at 80% and enforced at 100%, with a live gauge.
- **AI:** error messages in English and French.
- **Monitor:** metric history per org, kept 7 days within 50 MB, saved to disk
  if you opt in (`sandforge.monitor.persistTimeSeries`).
- **Monitor:** a drift feed of field and permission changes, with filter chips.
- **Monitor:** anomaly detection over a rolling 24 h window, raised as alerts
  after a 6 h warm-up.
- **Monitor:** CSV and PDF report export and a multi-org fleet overview, not
  yet wired to the panel.
- **Forge:** record-scoped clone (first cut): clone a root record and only the
  records linked to it; a dry run queries everything without writing.
- **Forge:** lookups to records that were not cloned are left empty in scoped
  mode, so inserts go through; owners fall back to the running user.
- **Forge:** a second pass fills in lookups left empty to break cycles
  (Account ↔ Contact); those it cannot resolve are reported.
- **Forge:** record types are mapped between orgs by `DeveloperName`.
- **Forge:** an optional per-object record cap keeps dev-sized clones bounded.
- **Forge:** picklist values inactive on the target are dropped instead of
  failing the insert.
- **Forge:** reference data (BusinessHours, OperatingHours) is matched to the
  target's records by name instead of being duplicated.
- **Forge:** objects the target cannot insert into (such as `CaseHistory`) are
  skipped and reported.
- **Forge:** fields the target lacks, and Person Account fields on Business
  Accounts, are left out instead of failing the insert.
- **Forge:** run results list errors per object and stage; discovery says when
  the graph was cut at the node cap.
- **Security policy** (`SECURITY.md`) on how to report a vulnerability.

### Fixed

- **AI shows as available** once an API key is configured.
- **Monitor shows its texts** instead of raw translation keys.
- **What's New shows after each update**; it was stuck on 1.0.0.
- **Forge:** the dependency graph no longer turns most objects into one cycle,
  and parents are planned before their children.
- **Forge:** the run log is capped at 500 entries, so long runs stay light.
- **Sync and pipeline config snapshots** keep dates and other values intact.

### Security

- **AI:** org data reaches the model as untrusted data, guarded against prompt
  injection; API keys are redacted from errors.
- **SOQL injection closed** in the Clone wizard and CLI: object names and WHERE
  clauses are validated.
- **`sandforge-clone --remap-csv`** only writes a new `.csv` file inside the
  current directory.
- **Webview CSP nonces and generated IDs** use cryptographic randomness.

## [1.2.5] - 2026-05-02

Forge hardening, and the `sandforge-clone` CLI on par with the wizard.

### Added

- **`sandforge-clone --upsert`** upserts on an external ID when available, so
  re-runs skip `DUPLICATE_VALUE`.
- **`--expand-orphans`** also clones missing parents, one hop up, so child
  lookups resolve.
- **`--exclude <obj.field>`** (repeatable) drops a field on one object before
  insert.
- **`--owner-map <src=tgt>`** (repeatable) maps a source owner to a target
  user, for owners missing on the target (`INVALID_OWNER`).
- **`--filter`** narrows a clone with a WHERE filter per object (up to 50, 512
  characters each).
- **`--map`** renames fields per object, for schema drift between orgs.
- **The wizard config** takes the same exclusions, owner mappings, filters and
  renames, and can request target row counts before a run.
- **Preflight** shows existing rows in the target for the first 30 objects,
  flagging those above 1000; `--skip-preflight` bypasses it.
- **Every run summary includes the source-to-target ID mapping**;
  `--remap-csv <file>` writes it to a CSV.
- **`--json`** prints a machine-readable summary for CI, mapping included.

### Changed

- **`sandforge-clone` empties lookups to records it did not clone** instead of
  keeping the source IDs.
- **Metadata diff requests** are capped at 100 objects (was 500).
- **Forge scales further**: no stack overflow on deep graphs, a 200 MB schema
  cache cap, and discovery that keeps the extension responsive.
- **Orphan expansion** skips system objects, saving API calls.

### Fixed

- **A cached discovery is no longer reused** after changing the target org or
  clone options.
- **A missing or excluded scoped root** stops with a clear error instead of
  producing a disconnected clone.
- **Orphan expansion** keeps children reached through an expanded parent in
  scope, and no longer spends its budget on misses.
- **Upsert falls back to insert** when no field is safe to match on.
- **The root object is read correctly** from SOQL with nested subqueries.
- **Wizard progress** no longer freezes on stale counts after an abort, and a
  run's final event always arrives.

### Security

- **Forge input is validated**: record IDs, object names, graph size and WHERE
  filters (no comment markers or trailing semicolons).

## [1.2.4] - 2026-04-23

The Marketplace release of "Scale & Complete"; its changes are listed under
1.2.3.

### Added

- **Three Seed modes**: AI Personas (10 industry personas), CSV Import (drag and
  drop, validation), Clone from Org (ordered insert, ID mapping).
- **Real-time sync**: CDC subscriptions, conflict resolution, execution
  history, cron scheduling.
- **Streaming execution** above 10K records, and background operations with
  native notifications.
- **Interface**: pagination, virtual scrolling, loading skeletons, a
  notification center, keyboard shortcuts.
- **Smart Actions on Home** recommend the next action from the org's state.

## [1.2.3] - 2026-03-28

Scale & Complete: three new Seed modes, real-time sync with conflict
resolution, AI personas and streaming execution.

### Added

- **Seed mode selector**: AI Generate, CSV Upload or Clone from Org.
- **Seed CSV Import:** drag-and-drop upload, automatic column mapping with
  manual override, inline validation and a 10-row preview.
- **Seed Clone from Org:** copies records between orgs in relationship order,
  with per-object WHERE filters and self-references such as `Account.ParentId`.
- **Seed Clone from Org:** a table of source to new IDs, exportable to CSV.
- **Seed AI Personas:** 10 industry personas with a 5-record preview and
  editable field patterns, or free-form AI generation.
- **Seed wizard:** skips the Configure step under 5 objects, groups objects by
  category above 20, and offers dismissible help tips.
- **Sync real-time (CDC):** start and stop Change Data Capture per object, a
  live event feed, auto-sync per object with a conflict strategy.
- **Sync real-time (CDC):** reconnects after sleep or wake, and shows
  throughput, lag, counters and uptime.
- **Sync conflicts:** 2-way and 3-way side-by-side diff, per-field or bulk
  resolution, a filterable list and a Conflicts tab with a live count.
- **Sync history:** the last 500 runs, each with details and re-run.
- **Sync schedules:** cron with a visual builder, raw expression and time zone;
  kept across restarts, overdue jobs run once, with notifications.
- **Smart Actions on Home:** counts records on Account, Contact, Opportunity,
  Case and Lead, and recommends one next step ("Just Do It").
- **Streaming execution** above 10,000 records per object, in 2000-record
  chunks with per-chunk progress.
- **Background operations:** long runs detach, can be aborted, and notify you
  when they end while the panel is hidden.
- **Interface:** pagination, virtual scrolling for tables of 10,000+ rows,
  loading skeletons, a notification center, per-object bulk job progress.
- **Keyboard shortcuts** Ctrl+1..6 open modules directly.
- **Error recovery panel** with retry, exponential backoff and skip.
- **Cache cleared on org switch**, so no stale data between orgs.

### Changed

- **Sync page tabs**: Active Syncs, History, Schedules, Conflicts, Real-Time.
- **All new features** are translated into 6 languages.

## [1.2.2] - 2026-03-27

One-click sync and seed flows to populate a Salesforce sandbox.

### Added

- **Quick Sync in three clicks**: pick the orgs, select objects, preview and
  run.
- **Quick Sync defaults**: same-name fields mapped, source to target, full mode,
  source wins conflicts, batches of 200, upsert.
- **Quick Sync preview** estimates record counts and API calls before running.
- **Quick Sync suggests objects**: the 5 most used, and parents (Account when
  you add Opportunity).
- **Quick Seed**: seed in one click from a template gallery, with record counts
  adjustable per object.
- **Seed templates**: Sales Cloud Starter (7601 records), Service Cloud Starter
  (3800), Minimal Demo (350).
- **Sync templates**: Full Account Hierarchy, Opportunities + Products, Cases +
  Attachments.
- **Seed data by locale** in 6 locales with coherent addresses, and
  object-specific ranges such as Opportunity amounts from 5K to 500K.
- **Seed adjusts values to validation rules** (ISBLANK, ISPICKVAL, LEN, REGEX)
  and uses every active picklist value.
- **Sandbox onboarding**: sandbox detection with guidance, and a Welcome wizard
  updated for sandbox orgs.
- **First-step cards** on empty Sync and Seed pages, and a "Populate Sandbox"
  action on Home.
- **Saved sync configurations and seed templates**, and wizard drafts saved at
  every step.

### Changed

- **The Sync wizard** has 6 steps instead of 7 (org and object selection
  merged).

## [1.2.1] - 2026-03-26

Monitor enrichment: live services, alerts and governance.

### Added

- **Five Monitor panels work end to end**: Error Log Monitor, User Session
  Monitor, Apex Log Analyzer, Sandbox Refresh Tracker, Health Check.
- **Alerts**: default rules for API limits, storage and error rates, with
  thresholds and severities, VS Code notifications and a history timeline.
- **Health score** combining every metric, with a trend, in Monitor and on
  Home.
- **More limits**: email invocations, Platform Events, file storage, and a
  sandbox reset countdown.
- **Trends** use real timestamps and export to CSV.
- **Governance rules**: create, edit and delete custom rules, evaluated with
  the alerts.
- **Limits and org info are cached** for 30 s and 5 min.

## [1.2.0] - 2026-03-20

Forge usability and reliability: fixes, polish, performance and accessibility.

### Added

- **Orgs detected automatically** when the extension starts.
- **A button swaps source and target orgs.**
- **Table view** for object lists.
- **Logs kept** across sessions.
- **ETA** for long-running operations.
- **Templates**: create, edit, delete, duplicate.
- **Node search** in the Forge dependency graph.
- **Side panel redesign**: compact mode, better org switcher, collapsible
  metrics.
- **Configurable timeouts** for all API calls.
- **Real Bulk API 2.0 job IDs** in responses.
- **Accessibility**: ARIA roles for tabs, toggle buttons, live output and
  exclusive choices; contrast fixed for WCAG 2.1 AA.

### Changed

- **Faster rendering** of graphs and KPIs; table rows adapt their height.

### Fixed

- **Forge abort, pause and resume** work end to end.
- **Dry run** is honored.
- **Forge templates** resolve their objects dynamically.
- **Reference fields** are handled correctly.
- **Forge wizard checkboxes** respond.
- **Forge dashboard KPIs** are calculated correctly.

## [1.1.0] - 2026-03-19

Stabilization: every module works end to end.

### Added

- **All 8 modules work end to end**: Seed, Sync, Monitor, Compare, DataOps,
  Automation, AI, Autopilot.
- **AI conversations** are kept across sessions.
- **Dashboard refresh** with error recovery.
- **Monitor**: five feature gaps closed.

### Removed

- **Ghost features**: the Grappe sidebar, placeholder modules and dead routes.

### Fixed

- **Bulk API 2.0** is properly wired, with retries and exponential backoff.

## [1.0.0] - 2026-03-17

First public version, published on the VS Code Marketplace.

### Added

- **Six modules**: Seed (AI data), Sync (two-way ETL), Monitor (org health),
  Compare (metadata diff), DataOps (backup, compliance), Automation (pipelines).
- **AI Assistant**: NL2SOQL, error resolver, schema advice and 10 business
  personas.
- **Autopilot**: auto-provisioning with compliance profiles, a dependency graph
  and execution waves.
- **Grappe Engine** processes large datasets in parallel.
- **Production Guard**: 3 safety tiers, CRUD and FLS enforced.
- **Six languages**: en, fr, de, es, ja, pt-BR.
- **Accessibility**: WCAG 2.1 AA.
- **CI on Windows, macOS and Linux.**
- **VSIX size**: 1.07 MB.
