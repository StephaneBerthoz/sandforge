# Changelog

All notable changes to SandForge will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.19.0] - 2026-09-09

Buttons that told you they had worked, and the two habits behind them.

v1.18.0 closed the defects that broke the product. This one closes the tier
below: features that ran, reported success, and had done nothing. Half of them
shared one cause — `useBridgeMutation` returns `data` and `error`, and fifteen
call sites read neither, which TypeScript strict cannot catch because not
reading a value is legal. The other half shared a second — a success toast
fired synchronously after `mutate()`, before any answer could arrive.

### Fixed

- **"Pipeline saved" waits for the save.** The toast fired one line after
  `mutate()`, with no branch and no response, so a rejected save still read as
  green — or read as green first and red a few seconds later.
- **The AI-generated pipeline reaches the canvas.** The response arrived and
  nothing consumed it: you described a pipeline, waited, and got nothing at all,
  with no explanation. A refusal now says why.
- **Installing a marketplace template installs it.** The button built an empty
  pipeline locally, wearing the template's name, and announced "Template
  installed as new pipeline" — the steps never crossed the bridge. The host has
  handled `marketplace:install` since it shipped; what kept the channel unsent
  was a line in an allowlist asserting the marketplace "cannot install", a note
  about the UI that was read for years as a statement about the product.
- **Migration's "Run" says what it did.** It moved real data and rendered
  neither result nor error.
- **A failed sync enters the history.** A sync that threw was never recorded, so
  history and re-run were dead for exactly the runs that needed them.
- **A production seed says how many records.** The confirmation was handed the
  literal `1`, so you approved the creation of 200 000 rows believing you were
  approving one — and no volume threshold could ever trigger.
- **A DataOps error no longer closes someone else's operation.** Errors on a
  dozen `dataops:*` paths were posted with no `correlationId`, so a failed
  `backup:list` ended a 120-second restore that was still running, with the
  wrong message.
- **A rejected request fails instead of timing out.** When the broker drops a
  message at envelope validation, no handler ever replies, so the request sat
  out its full 30 seconds and showed a raw timeout string. `bridge:error` now
  carries the id of the message that failed, and is matched on that id alone —
  an earlier attempt matched on a two-second window and made every concurrent
  request claim someone else's rejection.
- **A new attempt drops the previous result.** `mutate()` cleared `loading` and
  `error` but never `data`, and the error channel never touches `data` either:
  a run that succeeded followed by one that failed rendered the failure banner
  directly above the earlier run's "Complete — 118 succeeded".
- **Disconnecting an org drops its token.** The pooled connection outlived an
  explicit disconnect until the host shut down, so authentication material
  survived a revocation the user had asked for.
- **Compare's Deploy tab and Seed's relations editor say they are unbuilt.**
  Deploy sat on "No data" — which reads as "the diff has nothing deployable" —
  for a view with no producer anywhere in the codebase; the component that could
  never receive data is deleted with it. "+ Add relation" added an empty row
  that could not be filled and was never sent.

### Performance

- **Monitor stops asking the org the same question twice.** It ran the same
  AsyncApexJob query on every refresh, in the one tool whose job is to warn you
  about your API budget. A refresh that overruns its limit now stops there
  instead of spending more calls on an answer the panel stopped waiting for.
- **The Forge preview caches the org's object list.** Every corrected record id
  re-downloaded one to two megabytes of describe JSON.
- **A large clone's result table no longer freezes the tab.** The id-remapping
  table rendered one row per cloned record; it now renders a scrolling window.
- **Configuration stops rewriting itself for nothing.** Every `set` re-serialised
  the whole blob, and Monitor's polling triggered one every thirty seconds —
  thousands of full disk writes a day, almost none of them writing a new value.

### Documentation

- **The listing answers "why leave SFDMU or Data Loader".** It bought both
  keywords and never made the case.
- **The DataOps guide stops calling Restore inert.** It has worked since
  v1.18.0.
- **The Grappe settings and the restricted-mode warning are translated.** Three
  setting descriptions sat in raw English inside an otherwise translated block,
  and VS Code disabled the extension in an untrusted workspace without saying
  why.
- **The walkthrough has a button on every step**, and "Open Org in Browser"
  leaves the palette, where it could only ever fail.
- **The empty states are translated.** Automation, Autopilot, the scheduler and
  real-time "coming soon" badges and Monitor's Auto button rendered in English
  for German, Spanish, Japanese and Portuguese readers.

### Build

- **Untranslated prose fails the build.** Section 4 of the i18n gate was
  report-only, which is how the count reached fourteen while the product
  advertised six languages. A value legitimately identical across languages now
  goes in an allowlist as a decision, not as a silent tolerance.
- **The format gate covers the repository**, not the fifth of it under
  `packages/*/src` — the scripts, workflows and configuration it left out are
  where the gates themselves live.
- **`scripts/render-icon.mjs` is reachable.** It rasterises the Marketplace
  icon, it had no caller, and knip had been told to ignore the file — which hid
  the orphan along with it. It is `pnpm icons:render` now, and only its
  deliberate cross-workspace resolution of Playwright is declared.
- **The mutation score is reported.** The nightly job computed it and wrote it
  to an environment variable no later step ever read.
- **A rate limit no longer fails a release.** The public-link check turned a 429
  from raw.githubusercontent.com into "this image is broken" — a gate that fails
  for a reason unrelated to what it checks is a gate people learn to ignore.

### Removed

- `DeployFromDiff`, a component no producer could ever feed.

## [1.18.0] - 2026-09-09

The repository is public, and the audit that preceded it found the flagship
broken above 200 records.

A 114-agent review read the whole product against its own claims: 91 findings,
68 surviving a pass whose only job was to refute them. Twenty-eight were rated
high. What they have in common is not carelessness — the bridge, the CSP, the
prompt-injection defence and the six locales all held under attack. It is that
nothing ever ran the checks. `pnpm validate` could not complete on any machine,
CI had been switched off at the repository level since May, and four gates
added in v1.17.0 to fix "these gates never execute" were themselves never
executed. Sixteen of the seventeen releases were cut by hand.

### Fixed

- **Forge clones objects with more than 200 records.** The batch strategy
  returned `api: 'bulk'` and 10 000 records per batch for any object above 200,
  and the writer dropped the `api` half and posted those 10 000 to
  `conn.sobject().create()` — REST sObject Collections, capped at 200 by
  Salesforce. jsforce only splits an oversized array when `allowRecursive` is
  passed, which that call site did not pass. Every object above the threshold
  failed, and its whole subtree was skipped as "parent failed". The batch size
  is now derived from the API actually called, the second pass that patches
  cyclic foreign keys is bounded the same way, and the three write paths ask
  jsforce to split as well, so a future caller is bounded by default.
- **A clone no longer stops at 2 000 records per object.** `conn.query()`
  returns one page. Forge read that page and reported success, next to a wizard
  showing the real `SELECT COUNT()` from discovery — a 50 000-row object cloned
  as its first 2 000 rows, silently. The cursor is now followed to the end,
  bounded by record count and page count, and a run that hits either bound says
  so instead of hiding it.
- **DataOps Restore works.** It never has. Backups are taken with
  `SELECT FIELDS(ALL)`, so every one carries `CreatedDate`, `SystemModstamp`
  and `IsDeleted`; the restore asked its CRUD/FLS guard whether it could write
  _all_ the fields in the payload, those are writable by nobody, and the answer
  was no — for every object, on every restore, since the feature shipped in
  1.15.0 under the heading "Restore works." The guard now answers field by
  field, using `permissionable` from the describe to tell "nobody may write
  this" apart from "you may not write this": the first is dropped from the
  payload and reported, the second still refuses the restore.
- **"Preview anonymization" no longer anonymizes.** The preview button and the
  apply button were wired to the same handler, and the message contract has no
  dry-run flag, so clicking the secondary button masked the org's PII
  irreversibly with no confirmation. Preview now says a simulation does not
  exist yet, and Apply asks you to type a confirmation.
- **A failed org connection says so.** The form simply closed, which reads as
  success. It now shows the error and keeps what you typed.
- **A pipeline is no longer declared failed while it is still running.** The UI
  gave up after 30 s against a backend that allows 300 s, so any pipeline over
  half a minute reported a failure that had not happened.
- **A failed Forge run can be re-run immediately.** The duplicate-submission
  guard held any identical recipe for a full hour, including one killed by an
  auth error — no reload, no wait, no configuration change would release it.
- **An expired Salesforce session recovers on its own.** Pooled connections
  were never revalidated or expired, so a token that lapsed mid-session left
  the org unusable until the VS Code window was reloaded.
- **Forge discovery stops losing objects in silence.** A failed describe or a
  timed-out `COUNT()` was swallowed and the object left the graph with no
  trace, indistinguishable from one excluded on purpose or genuinely empty. A
  frozen reference dataset could ship missing an entire object because one
  query timed out. The two cases are now distinct, and the message carries the
  reason the org gave.
- **Reports says it has no data instead of showing zeros.** Four KPI cards read
  0 / 0 / 0.0% / 0 — with the success rate in amber, as though measured — for a
  module that has no producer on the extension side at all.

### Security

- **Production Guard sees a delete.** The sync handler passed
  `operation: 'upsert'` and `recordCount: 1` as literals, so a delete-mode sync
  against a Production org was presented to the only guard that exists as a
  single-row upsert. The rule that blocks DELETE on production could not fire,
  and no volume threshold could either. The real operation and the real object
  list are now what the guard is asked about.
- **`dataops:rollback` is guarded.** It wrote to the target org with no
  Production Guard check — the one unguarded write path in the product — and
  nothing tied the backup to the org it came from, so a backup of org A could
  be poured into org B. Both are closed.

### Changed

- **The repository is public**, at
  [github.com/StephaneBerthoz/sandforge](https://github.com/StephaneBerthoz/sandforge).
  The listing had been carrying twenty-four dead links: thirteen documentation
  links, Releases, Issues, Discussions, LICENSE and SECURITY in the README,
  plus `repository`, `homepage`, `bugs`, `qna` and the CI badge — image and
  href — in the manifest. Every one returned 404 to anyone but the author,
  because the repository was private and the Marketplace fetches anonymously.
  Images had been moved to a public mirror in 1.16.0 for exactly this reason
  and the reasoning was never carried across to the links. The mirror and the
  machinery that kept it in sync are gone with it: the listing now reads its
  images out of the same commit as the files on disk.
- **The extension activates on startup**, so a scheduled sync survives a
  restart. `activationEvents` was empty, which meant the tick loop that runs
  cron schedules only started once you opened a SandForge panel — the
  scheduling feature was inert in precisely the case it exists for.
- **Marketplace categories and keywords.** "Data Science" is the Jupyter shelf;
  no comparable Salesforce extension uses it. The keywords were hyphenated
  compounds — `test-data`, `data-migration` — which do not match the spaced
  queries people actually type, and the listing did not appear in the first 100
  results for `salesforce test data`, `seed data` or `data masking`.
- **The listing's opening image shows the product you get.** The hero GIF
  pictured a navigation sidebar deleted in 1.10, showed 9 of the 14 modules,
  and had "SandForge v0.0.0-e2e" in its status bar. The four screenshots below
  it had been re-shot; it had not, so the page opened with two different
  products in a row.

### Documentation

- **The in-app help panel no longer sells CDC.** It promised "4 sync modes:
  Full, Incremental, Delta, CDC" in all six languages, for a mode the UI stopped
  offering and the extension answers with a registered no-op.
- **Grappe is described correctly, in all nine places it is written.** The
  READMEs called it a "parallel execution engine" that "no operation activates
  yet" — wrong in both directions at once: Seed, Sync and Autopilot do activate
  it, and it partitions nothing. `grappeAdapter.partition()` has no caller;
  `grappeActive` wraps an unchanged sequential loop in two progress events. It
  splits the reporting, not the work, and now says so in the two READMEs, the
  FAQ and the six locales.
- **A sync template no longer promises attachments.** "Cases + Attachments"
  named a file transfer that no stage of Sync performs.
- **The Documentation table stopped re-promising what the Modules table
  disclaims** forty-five lines above it.

### Build

- **`pnpm validate` runs.** It died at step 5 of 11 on every machine: the root
  `test:docs` script invoked `vitest`, which was never a root dependency. The
  eighteen documentation tests behind it had not run since they were written.
- **CI runs the gates that `validate` runs.** It ran seven of eleven; the four
  added in v1.17.0 — under the title "run the gates the sweep wrote — four of
  them were never executed" — reached CI in none of them, because CI spells its
  own list rather than calling `validate`. A new gate now fails when the two
  lists drift, and a saboteur test proves it fails.
- **`scripts/check-screenshots.mjs` exists.** The screenshot generator has told
  readers since v1.16.0 that this file "fails the release if what ships no
  longer matches what this file produces", and the v1.16.0 changelog repeated
  the promise. It had never been written. It now fails when an image was last
  committed before the generator that produces it changed — which is what would
  have caught the stale hero GIF.
- **A claims gate covers the READMEs and the six locales.** The one gate in
  this repository that had caught prose drifting from code guarded a single
  claim in two files of `docs/`. The same facts are written in up to nine
  places, and Grappe was wrong in two opposite directions depending on which
  one you read. Each assertion is anchored to the code that decides the truth
  and fails in both directions.
- **The link gate checks links.** It only ever checked images — the failure it
  was written for was sitting one line below it the whole time. It now checks
  every link in the Marketplace README and every URL field of the manifest, as
  an anonymous visitor.
- **The release workflow can cut a release.** Its fail-fast preflight compared
  the tag of the version already published rather than the one it was about to
  create, and had blocked every release since v1.0.1.
- **A test can no longer reach the internet.** A concurrency race let one of two
  parallel AI calls escape the SDK module mock and issue a live request to
  api.anthropic.com; the suite failed with a real 401 body, which reads as an
  assertion bug rather than as "this test just called the internet".

### Removed

- The public assets mirror and its drift-checking script, obsolete now that the
  repository serving the images is the repository holding them.
- A `fast-check` dev dependency nothing imported, and two exported store
  selectors nothing read.

## [1.17.0] - 2026-08-13

A new mark, and 56 of the 69 medium audit findings.

### Changed

- **New icon.** The anvil is replaced by fire in a hearth — heat inside a
  container, which is what SandForge does to an empty sandbox. The old mark
  pictured the tool and said nothing about filling anything. Both the
  Marketplace icon and the activity-bar icon change; five other silhouettes
  were drawn and rejected against this one at 20, 24, 42 and 96 px.

### Accessibility

- **Inputs have names.** Not one `<label>` in the entire UI was tied to its
  input, so a screen reader announced 29 controls as unlabelled. Sortable
  table headers and clickable rows now have keyboard paths, focus rings that
  had been removed and never replaced are back, and the `aria-label`s that
  were hardcoded English in a six-locale product are translated.

### Fixed

- **The record id you type on Home reaches the Forge form.** It was written
  to the store and never read, so the shortcut ended with you retyping the
  same 18 characters.
- **Grappe's empty state points somewhere useful.** Its call to action opened
  Forge, the one module that cannot produce a grappe run.
- **The French UI has its accents back.** Roughly 15% of the French strings,
  and the whole French Marketplace description, were written without them.
- **AI error resolution answers the question.** The assistant was being given
  instructions written for a different task, so it was told to refuse the very
  input it always receives, and every failed operation was answered with
  "Unable to determine root cause."

### Removed

- A `sandforge.grappe.maxWorkers` setting that promised parallelism the
  product does not have. Nothing read it.
- 47 modules the UI stopped rendering releases ago.

## [1.16.0] - 2026-08-13

Three findings the last audit rated high, and the discovery that the
Marketplace listing had been showing six broken images.

### Performance

- **A backup no longer slows down every setting you change.** Backup record
  sets were written into VSCode's `globalState`, a store VSCode re-serializes
  in full on every write. One backup put megabytes behind every unrelated save
  — a toggled setting, a saved template, an org refresh — and behind startup,
  which parses the whole thing before the first panel opens. Records now go to
  files. Existing backups stay restorable: the readers fall back to the old
  location, so nothing needs migrating.

### Documentation

- **The screenshots show the product you actually get.** Every one of them
  pictured a UI deleted three minor versions ago — a navigation sidebar removed
  in 1.10, a "v3.0.0" watermark from the pre-1.0 internal numbering, an
  untranslated label. The generator that made them drove that same deleted
  sidebar, so it could not have been re-run: it broke when the screenshots
  became wrong, and nothing failed. Four modules are now shown with real
  content, and the release fails if the shipped images stop matching.
- **The Marketplace images load at all.** They pointed at a private repository,
  and the Marketplace fetches images anonymously from the public internet, so
  every one returned 404 — the listing has been showing six broken images. They
  now come from a public assets repository, checked on every release both for
  reachability and for being the same bytes as the files here.

## [1.15.0] - 2026-08-13

This release finishes things the codebase had already built. Four of the six
changes below needed no new backend at all — the implementation existed, fully
routed and unit-tested, and nothing called it.

### Features

- **Restore works.** The rollback engine has been complete since it shipped —
  permission checks before any write, batched upserts, API-limit guards,
  progress reporting — and the Restore button sent nothing. It now runs.
- **Your backup list appears.** The list request was not merely unhandled: it
  was declared in no schema, so the message was rejected before reaching any
  handler. The list was permanently empty, the counters read zero, Restore had
  nothing to select, and after 30 seconds the page showed an error.
- **A finished Forge run tells you what it created.** The source-to-target
  record Id map was built during every run and discarded when the result was
  assembled, so a clone could report "312 records" without giving you the new
  Id of any of them. The results screen now lists them.
- **An imported SFDMU config can be run.** The importer produced a complete,
  valid configuration, displayed it as JSON, and dropped it when you left the
  page. It now runs — after asking which orgs to use, because the imported file
  names orgs that do not exist in your setup.
- **Forge recipes are portable.** Saved recipes went to VSCode's internal
  storage: they survived restarts but could not leave the machine. They are now
  written to `.sandforge/forge-templates.json` in your workspace, so a recipe
  can be committed next to the project it describes and shared. Existing
  recipes are migrated automatically on first use.

### Security

- **Removed an arbitrary code-execution path.** A bridge message accepted a
  file path and imported it as a module, with no restriction beyond a length
  limit. It backed a plugin feature with no interface, whose list always
  returned empty and whose unload did nothing. The whole surface is gone.
- Opening an org in the browser now requires an HTTPS instance URL. The
  previous guard caught nothing: the URL parser it relied on accepts
  `javascript:` and `file:` without complaint.

### Changed

- **Forge SOQL mode no longer looks like it filters.** Only the object name
  after `FROM` is used — your `WHERE` clause is discarded, and the clone covers
  whole tables for every related object. The tab now says so when your query
  contains a filter, and the run is capped at 200 records per object instead of
  being unbounded. Honouring the filter for real is still to come.
- New icon. The Marketplace mark gains a strike spark; the activity-bar mark
  deliberately does not — at 20 px two shapes crowd each other, so each size
  gets one idea.

### Performance

- Frozen-dataset coverage selection no longer repeats a full schema discovery
  for every candidate root.

## [1.14.0] - 2026-08-12

Everything below came out of a systematic audit of the shipped product. The
theme is the same throughout: controls that looked like they worked, and did
not. Nine tests were found asserting the broken behaviour and were rewritten.

### Fixed

- **DataOps wrote to the wrong org.** Backup and anonymize both targeted the
  first org in your connection list rather than the one you selected, while the
  page named no org at all. If you had more than one org connected, you could be
  anonymizing an org you were not looking at. The page now uses your selection
  and shows the target before you click.
- **Cancel did nothing.** Aborting a clone, CSV import or frozen-dataset load
  was fully wired end to end and had no effect — the operation was never
  registered, so the cancel request reported "operation not found" while the
  bulk write continued. On a multi-minute load the only way to stop it was to
  close VSCode.
- **Progress bars were fake.** Seed showed a bar pinned at exactly 50 %, an
  execution timer reading "0.0s", and per-object rows frozen at "0/N" for the
  whole run; Sync showed 0 % throughout. The extension had been emitting real
  progress the entire time and nothing was listening. A healthy long run is now
  distinguishable from a hung one.
- **Connecting an org froze the panel for 30 seconds.** Nine of the ten branches
  of the connect flow answered with a toast instead of a reply, so the request
  only ended on its own timeout — every auth button stayed disabled meanwhile,
  including after a _successful_ SF CLI import. OAuth web was worse: the timeout
  expired mid-login, collapsing the form and wiping typed credentials.
- **Failed Monitor queries looked like empty results.** Fifteen handlers posted
  their error payload on the success channel, so a broken org connection
  rendered pixel-identical to an org with nothing to report.
- **The Forge Review "Plan" tab loaded forever.** The extension answered the
  plan request; nothing in the UI consumed the reply. A failed plan is now
  shown as a failure instead of a permanent spinner.
- **64 labels rendered as raw keys.** Sync History, Sync Schedules and
  Settings → AI displayed strings like `sync.schedules.builderTitle` as their
  labels — in every language, English included.
- **The Real-Time tab claimed a live stream that does not exist.** Pressing
  Start flipped the status badge to a success-green "Syncing" that never
  changed, while the extension had answered that the feature is unavailable.

### Changed

- **The Sync "Mode" dropdown was removed.** Its value never reached the
  extension: every run was a full sync regardless of the choice, and the Review
  step then displayed the discarded choice back as confirmation.
- Documentation no longer claims features the code does not implement — Grappe
  does not auto-activate, Reports has no data feed, and four of the six DataOps
  tabs are previews. Each is now marked as such.

### Performance

- Frozen-dataset coverage selection no longer replays a full uncached schema
  discovery per candidate root. On a large org that was several hundred
  redundant describe round trips per selection, including the single slowest
  call repeated each time.

### Security

- The `hash` anonymization method was a 31-bit non-cryptographic hash labelled
  `sha256:`, and those values are written into your org. Over low-entropy PII —
  SSNs, emails, phone numbers — that keyspace is exhausted in under a minute, so
  the stored values were reversible. Replaced with keyed HMAC-SHA256.
  **Breaking:** a hash rule without a salt now fails rather than producing an
  unkeyed digest. Add a `hashSalt` to affected rules.

## [1.13.0] - 2026-08-12

### Fixed

- **Forge actually runs.** The wizard's "Execute Forge" button only switched screens — nothing in the shipped UI ever sent `forge:execute`. You completed discovery and review, clicked the button, and landed on a progress screen that counted upwards forever while nothing was written to the target org. The request is now sent, and a backend failure surfaces in the log stream instead of spinning silently.
- **Abort stops the run.** Aborting a forge raised a generic error that the per-object handler absorbed as an object-level failure, so the run moved to the next object and kept writing to your target org. Abort is now a distinct signal that halts execution wherever it lands.
- **Transient Salesforce errors are retried again.** The retry engine read `statusCode`, but the Salesforce client sets `errorCode` — so every real API error normalised to "unknown" and was classified non-retryable. `UNABLE_TO_LOCK_ROW` and `REQUEST_LIMIT_EXCEEDED`, the two errors the retry machinery exists for, were never retried once. On a bulk load hitting row-lock contention this is the difference between a run that finishes and one you re-drive by hand.
- **Org selection reaches the extension.** `org:select` was implemented and unit-tested but never registered on the message router, so every selection message fell through to the unknown-type path.

### Security

- **Anonymisation `hash` is a real hash now.** Both engines implemented it as a 31-bit non-cryptographic hash while labelling the output `sha256:`, and those values are written into your org. Over low-entropy PII — SSNs, emails, phone numbers — that keyspace is exhausted in under a minute, so the stored values were reversible. Replaced with keyed HMAC-SHA256.
  - **Breaking:** a hash rule without a `hashSalt` now fails instead of producing an unkeyed digest. Add a salt to affected rules. Failing loudly beats writing a reversible value into an org under the label "anonymised".
- Client identity removed from all public artifacts. A prior engagement's name, org aliases, production data volumes and five real Salesforce record Ids were present in the public repository and in the changelog this page renders. A release gate now fails on any recurrence.

### Performance

- **Extension activation is roughly twice as fast.** jsforce and its 107-package transitive cluster were bundled into the activation path and evaluated on every VSCode start, whether or not you ever connected to an org. They now load on first connection. Main bundle 2,231 KB → 941 KB; measured activation 337 ms → 144 ms (mean of 6 interleaved A/B runs). The download is unchanged at 1.99 MB — the code still ships, it is just no longer on the startup path.

### Changed

- Activity-bar and Marketplace icons redrawn. The activity-bar mark was 8.6 px tall inside its 24 px slot and off-centre on both axes; it is now 14.2 px and centred. The PNG is generated from source via `scripts/render-icon.mjs`.

### Internal

- E2E suite repaired and made honest: a message-envelope mismatch dating from 1.5.0 had silently disabled every request/response fixture (13 → 45 passing). 11 specs driving surfaces that no longer exist are quarantined with a documented blocker each rather than deleted. 38 tests remain failing and are not yet addressed.
- Release gates added: bundle size now fails above 1100 KB instead of warning above 2048 KB, the VSIX is checked for the lazy jsforce chunk, and a handler-routing test cross-checks every declared message type against the router in both directions.

## [1.12.0] - 2026-08-12

### Fixed

- Monitor storage breakdown works again: the SOQL used `COALESCE()`, which does not parse on older API versions — plain `RecordCount` is selected and null-coalesced in code.
- Monitor recent deployments works again: `DeployRequest` now goes through the Tooling API (`tooling.query`) instead of the unsupported REST endpoint.
- Monitor sandbox-refresh no longer errors in a loop on sandbox orgs: the "not supported" verdict is remembered per org and the panel shows no events.
- Forge discovery in template mode actually starts: the selected template's saved record/SOQL input is expanded into the request instead of sending a bare `templateId`.

## [1.11.0] - 2026-08-11

### Changed

- The sidebar webview now ships its own bundle: 377 KB instead of the full 1.8 MB panel bundle — the sidebar loads faster and uses less memory; editor panels keep the full bundle.
- Webview CSS is split per target: the sidebar no longer downloads the reactflow styles used only by diagram pages.

## [1.10.0] - 2026-08-11

### Features

- Webview languages now lazy-load: only English ships inside the JS bundle, the 5 other locales load on demand through the bridge when picked (~440 KB off every webview).

### Fixed

- Org selection is kept everywhere: a Monitor or panel opened after picking an org in the sidebar/status bar now shows that org instead of falling back to the first one in the list.
- Monitor health-score card no longer overflows narrow panels — the summary and top-risk rows were clipped on the left and cut on the right below ~400 px; they now wrap/ellipsize inside the card.
- Monitor header keeps the org alias readable: the action buttons wrap to their own row instead of crushing the alias.
- Governance panel header and Jobs filter buttons wrap on narrow panels instead of overflowing.

## [1.9.0] - 2026-08-11

### Features

- Forge discovery wizard shows live progress (objects scanned / queue) instead of looking frozen for 30–90 s on large orgs.
- AI provider status is now emitted to the webview (`ai:provider:status`: breaker open/half-open/closed, cooldown end, error kind).

### Fixed

- Offline queue drains at startup: operations queued by a crashed session were parked indefinitely; they now drain when the org is reachable at activation.
- Org selection is unified: picking an org in Monitor or OrgManager propagates to the status bar, sidebar and other panels.
- Migration imports refuse files above 50 MB (OOM guard), read the file once instead of twice, and no longer reject valid Windows paths on drive-letter case.
- `monitor:error` is correlated to its request — an error can no longer surface in a different Monitor panel open in parallel.

### Changed

- The native Organizations tree view is removed: the launcher dropdown (active-org selection, safety tiers, per-row "open in browser") is the single org surface.
- Removed the `grappe:backPressure` badge (nothing ever emitted the channel), the never-wired `autopilot:node-completed`/`node-failed` bridge messages, and the unreachable `monitor:trends` request path.

## [1.8.4] - 2026-08-11

Fixed: the auth self-heal now pulls a guaranteed-live token via `sf org auth show-access-token` (which refreshes the OAuth session) instead of `sf org display` (which dumps the stored token as-is — proven rejected with HTTP 403 on a "Connected" org while show-access-token's token passes). This is the root cause of the recurring "Authentication expired" loops. Older CLIs fall back to the previous behavior; the vault is still only written after the refreshed credentials pass a real API call.

## [1.8.3] - 2026-08-11

Removed: the CI badge from the marketplace listing. No functional change.

## [1.8.2] - 2026-08-11

Added: SandForge now adopts the sf CLI's default org (`target-org`) at startup when nothing is selected yet. Fixed: the auth self-heal adopts the org's _current_ instance URL reported by the CLI — after a sandbox refresh or My Domain change, even a fresh token was rejected at the stale URL (`INVALID_AUTH_HEADER` on every org). And the startup validation no longer flips orgs through a `refreshing` state, so connected-org counters no longer tick down one by one during the launch sweep.

## [1.8.1] - 2026-08-11

Fixed: duplicate org entries — ghost entries persisted by early builds (same Salesforce org, older key scheme) showed up as duplicates in every org list and kept "Authentication expired" loops alive with their stale credentials. Startup now dedupes by the Salesforce org id and prunes the ghosts from storage and the vault.

## [1.8.0] - 2026-08-11

**Fifth-audit release: the live shell gets everything, the dead one leaves the bundle.** Fixed: webview crash reports were silently dropped by the broker (`error:boundary` now enveloped, typed, and logged extension-side), the `sandforge.cheers` easter egg finally works from real panels, Welcome/What's New no longer pop in every open panel (onboarding posts are now targeted; the broadcasting `postToActivePanel` is honestly renamed `postToAllPanels`), and the Forge execution page shows live per-object progress again (the listener read `forge:progress` fields at the message root instead of the envelope's `payload`). Changed: the unreachable `App` shell, its layouts and the orphaned AboutDialog are deleted from the bundle (−27.6 KB); the bridge type union now covers the 71 channels the extension actually emits, enforced by a new emit-side anti-drift test; the webview formatters re-export the canonical `@sandforge/shared` implementations (three divergent inline `formatDuration` removed); and the LazyMotion migration is complete — all `motion.*` imports are now `m.*`, so framer-motion's full feature set stays out of the production bundle. Full entry in the root changelog.

## [1.7.0] - 2026-08-11

**Auth reliability + toolchain modernization.** Registered orgs are now validated at every launch: expired sessions auto-refresh via the sf CLI in the background, with live per-org status in the sidebar — no more mid-operation "Authentication expired" walls (new `sandforge.orgs.validateOnStartup` setting, on by default). The token self-heal no longer persists unvalidated CLI tokens, and a stale CLI token store is called out explicitly instead of looping. Toolchain: ESLint 9 flat config with typed linting (`no-floating-promises` on the extension host), vitest 3, Stryker 9 — all 7,900+ tests green and every coverage gate passing. The marketplace page now shows the full project README: all 14 modules, screenshots, FAQ and the complete settings reference with working links. Full entry in the root changelog.

## [1.6.0] - 2026-08-11

**Fourth-audit release: messages that actually arrive.** Re-auditing 1.5.0 surfaced a regression class from the broker envelope requirement: five webview stores (sync history, sync schedule, CDC metrics/live, conflicts) posted raw messages the broker silently dropped — infinite spinners and lost mutations on the Sync tabs — and the Forge pause/resume/abort buttons did nothing on destructive runs. All senders now share a single enveloped helper. Also fixed: declining a seed production confirmation hung the UI for 120 s (now an immediate correlated `seed:error`), the onboarding/what's-new message raced the webview bundle on first open and was lost forever, the What's New overlay never rendered in module panels, the sidebar ignored the configured language (now synced live), the in-app Help listed wrong shortcuts (fixed in 6 languages), and the marketplace listing had dead images and links — the repository is now public and the retired shields.io badges were replaced. Full entry in the root changelog.

## [1.5.0] - 2026-08-10

**Third-audit release: features that actually reach the user.** Re-auditing 1.4.0 showed several features were wired but invisible — the `App` shell was dead code and the sidebar never received broker broadcasts. Now: shortcuts, command palette, welcome overlay and reduced-motion are mounted in the live panel/sidebar shells; the sidebar receives live broadcasts; the manifest is localized in all 6 languages (enforced in CI); the marketplace page gains badges, Q&A via Discussions, FAQ and screenshots. Fixed: the offline replay loop (failed replays no longer re-queue forever), seed failures returning immediately instead of a 120 s timeout, failed seeds reported as "completed", uncorrelated error responses, and the language regression that could reset your choice to English. Shared package purged of 38 dead utilities; bridge schema is now a flat discriminated union with truncated error messages. Full entry in the root changelog.

## [1.4.0] - 2026-08-10

**Post-release hardening.** A full second audit pass over 1.3.0. Offline queue safety: seeds (non-idempotent INSERTs) are no longer auto-replayed (duplicate-risk removed — you get an explicit retry hint instead), and re-queued operations now drain while online instead of waiting forever. New: offline queue notifications, the recent-operations panels are actually fed, `sandforge.openReports`, keyboard shortcuts for all 17 routes, the 6-language selector in Settings, and `prefers-reduced-motion` respected globally. Fixed: the Welcome "don't show again" checkbox was write-only, "sync completed" notifications fired for failed syncs, panel crashes showed blank panels, and the remaining doc drift (14-module table, 4-step seed wizard, scheduler marked coming soon, auto-updated version badge). Shared coverage gate now reflects the real 86% baseline. Full entry in the root changelog.

## [1.3.0] - 2026-08-10

**Marketplace trust and dead-code release.** New native Organizations tree view in the sidebar (type icons, refresh, open-in-browser), a Get Started walkthrough, and a Migration page that imports SFDMU `export.json` or CSV/JSON files into reviewable Sync configs. Every module now has its own command (`openSeed`, `openSync`, `openAutopilot`, `openMigration`) with a single source of truth for sidebar routing. Seed and sync executions feed the live-operations tracker; operations that fail on a network error are queued and replayed on reconnect. The UI language persists across reloads and all 6 locales reached 100% key parity, now enforced in CI. Fixed: Monitor auto-refresh never fired, ErrorBoundary reporting was dead, webview panels leaked in the message broker, marketplace links were 404, and the listing no longer claims real-time CDC or multi-provider LLMs. Removed ~4,700 lines of dead Monitor v2 code; the VSIX no longer ships internal tooling state; the Anthropic SDK is lazy-loaded (−118 KiB off the activation bundle). Full entry in the root changelog.

## [1.2.12] - 2026-08-06

### Changed

- Dropped the marketplace preview flag: the extension is no longer published as a preview release.

## [1.2.11] - 2026-08-06

### Fixed

- Marketplace page: the Forge walkthrough GIF is served from a public assets repository, so it renders on the listing.

## [1.2.10] - 2026-08-03

### Changed

- Documentation: both READMEs lead with the "first clone in 2 minutes" Forge walkthrough, with an animated flow GIF; marketplace page shortened and docs links made absolute. Full entry in the root changelog.

## [1.2.9] - 2026-08-03

**Reliability and onboarding release.** Expired org credentials now self-heal through an sf CLI refresh with one retry (with an actionable message when reconnect is needed). Every bridge handler validates its payloads with Zod, and handler failures surface their real message instead of a generic 30-second timeout on every flow (sync, dataops, backup, pipeline, monitor, autopilot). Autopilot is wired end-to-end: the wizard drives a real scan → compliance → plan → execute → report run with live progress, isolated per execution. QuickSync wizard repaired. Stale org selections reconcile automatically. ProductionGuard now covers Forge and Autopilot. Manual retry replays failed syncs. Onboarding rewritten around the core use case: populate a dev sandbox from a real record, in 6 languages. Full entry in the root changelog.

## [1.2.8] - 2026-08-03

### Fixed

- Bridge error surfacing: handler failures (expired connection, unreachable org) now show the actual error message instead of a generic 30-second timeout, on every bridge query and mutation. `monitor:refresh` is additionally bounded to 25 s so a stalled org cannot hang silently.

## [1.2.7] - 2026-08-03

**Hardening marathon + Frozen Reference Dataset.** Two full audit cycles over the codebase, four fix waves, and one new module. Highlights: circuit breaker lockup fixed (per-org breakers, permits released on all paths), ~20 implemented-but-unrouted bridge messages wired (monitor alerts, seed templates, sync configs/history/schedules, seed clone/CSV, AI conversations), Bulk API results correctly mapped (they previously all counted as success with fabricated ids), shell injection and path traversal closed, Zod payload validation generalized, ~37 000 lines of verified dead code removed, ForgeExecutor split into a tested stage pipeline, extension activation refactored into src/composition/, bundle minified (6.7 MB to 2.3 MB), AI stack unified on one secret key with migration, manifest safety settings actually enforced. Full entry in the root changelog.

### Added

**Frozen Reference Dataset**: extract a business dataset once from a UAT sandbox, pseudonymize it deterministically (HMAC-SHA256, env-only salt), freeze it with a manifest, gate it on a 4-point non-reidentification control (including cross-field leaks and a Salesforce checksum sweep), and replay it identically into refreshed dev sandboxes (sandbox-only guards, schema alignment including RecordType picklist gaps, pilot mode, reload without refresh, robust post-load verification). New `frozen` page in 6 languages, command `sandforge.openFrozen`, docs in `docs/modules/frozen-dataset.md`.

## [1.2.6] - 2026-05-05

**Phase 03 Monitor v2 Core + Phase 04 AI Integration + close-out hardening.** Two milestone-track phases shipped under the v1.3.0 umbrella, plus a six-bug close-out pass surfaced when the user actually installed the fresh VSIX. Phase 03 ships the time-series monitor substrate (MetricBus, TimeSeriesStore, MonitorRegistry + 8 probes, DriftDetector v2, AnomalyEngine, ReportExporter, FleetSummaryService). Phase 04 ships the read-only AI assistant (per-provider CircuitBreaker, AbortController, 10 read-only tools with CI fence, per-panel-session token budget, prompt-injection defence with adversarial vitest, AIDiagnoseHandler with approve gate, Anthropic adapter functional + OpenAI/Custom stubs).

### Added

**Phase 03: Monitor v2 Core**

- `MetricBus` typed Zod-validated pub/sub with 5 discriminated event subtypes
- `TimeSeriesStore` per-(orgId, seriesId) ring buffer, 50 MB LRU cap, 7-day retention, opt-in disk persistence (`sandforge.monitor.persistTimeSeries` setting), 5-min flush + 15-min per-org rate limit, corruption recovery
- `MonitorRegistry` single-tick scheduler with per-probe in-flight gate, drift accounting, hard timeout, visibility gating
- 8 trackers wrapped as `MonitorProbe` shells (Limits, Job, ApexLog, SandboxRefresh, ErrorLog, UserSession, Health, Governance)
- `DescribeCache` per-org TTL + LRU
- `DriftDetector v2` field-level + permission-level deltas with `DriftFeed` virtualized component
- `AnomalyEngine` rolling 24h std-dev with 30-sample / 6-h warmup gate, bridges into existing `AlertEngine`
- `ReportExporter` CSV + lazy-pdfkit PDF, sparklines via LTTB downsampling, 50-series-per-PDF cap with multi-part split
- `FleetSummaryService` + `MonitorOverviewPage` multi-org fleet landing with `ConnectionPool` reuse, `p-limit(3)`, 60-s per-org cache, exponential backoff
- `useVisibilityGate` posts `monitor:visibility` on `document.visibilitychange`

**Phase 04: AI Integration**

- `AIClient` interface + `AnthropicAdapter` (chat / complete / countTokens / runTools / dispose) using `messages.parse + zodOutputFormat` for Zod-validated structured output
- `OpenAIAdapter` + `CustomAdapter` stubs that satisfy the interface (constructor never throws, methods throw `AINotImplementedError` with provider-switch hint)
- `AIClientFactory` per-provider memoisation; switching `sandforge.ai.provider` in Settings does NOT crash the extension
- Per-provider `CircuitBreaker` (3 consecutive 529 → open for 5 min, dual-signal overloaded check, `APIUserAbortError` never trips breaker, `cancelAll()` for panel close)
- Per-AI-request `AbortController` (cancelling one chat does not abort siblings)
- 10 read-only tools (`describe_object`, `query_records`, `get_limits`, `get_recent_errors`, `get_apex_log`, `get_metadata`, `get_alerts`, `get_anomalies`, `list_sobjects`, `validate_soql`) with `wrapTool` that enforces read-only naming regex + `READ-ONLY` description substring + Zod-validated input/output
- Registry CI fence test rejects any future write-verb tool addition
- `validate_soql` AND `query_records` reject DML keywords (defence in depth, `DML_FORBIDDEN` error code)
- `AIDiagnoseHandler`: failed-job → diagnose flow with two-call pattern (`runTools` for context + `complete(schema)` for typed payload), `ActionProposalSchema`, 5 action kinds, approve-gate dispatcher
- Webview `ActionCard` (Approve / Modify / Reject trio, scrollable rootCause, ≤5 actions, per-action state badges)
- `AIProviderStatusBanner` (FR + EN copy, live mm:ss countdown to half-open transition)
- `TokenBudgetIndicator` mini-bar with 4-field tooltip, `aria-live='polite'`, green/yellow/red colour states
- `SessionBudget` class: per-panel-session token counter, sums all 4 token fields, debounced 80% warn, 100% hard refuse with preflight BEFORE the SDK call
- `sandforge.ai.tokenBudgetMaxPerSession` setting (default 50000) with EN+FR NLS
- `escapeUserData` / `wrapAsUserData` HTML-entity escape helpers + `DIAGNOSE_SYSTEM_PROMPT` / `SOQL_REVIEW_SYSTEM_PROMPT` / `ERROR_RESOLVE_SYSTEM_PROMPT` carrying the spotlight clause
- Adversarial vitest spec: 7 jailbreak fixtures × 2 defence layers + 2 spotlight assertions (RT-#10 closure)
- `AIDiagnoseHandler` self-defence canary asserts the literal `</user-data>` substring NEVER appears in the body between the wrapper's open + close tags
- 4 bridge envelopes (`ai:diagnose`, `ai:diagnose:response`, `ai:approve-action`, `ai:approve-action:response`) + 3 budget envelopes (`ai:budget:state`, `ai:budget:warn`, `ai:budget:exceeded`) + `ai:provider:status` + `ai:tool-trace`
- 6 `ai.error.*` i18n keys (overloaded / rateLimit / auth / cancelled / transient / unknown) in EN + FR

**Close-out wiring**

- `sandforge.openAI` command + `Bot` icon + EN/FR NLS title + Ctrl+K palette entry: AI Assistant now reachable from the activity bar (SidePanel), the in-panel layout (Sidebar), the top bar route labels, and the command palette across all 11 surfaces

**Tooling**

- `scripts/git-hooks/pre-commit` runs `pnpm -r typecheck` + locale dup-key scan on every commit
- `package.json` `prepare` lifecycle auto-installs the hook on `pnpm install` via `core.hooksPath = scripts/git-hooks`

### Fixed

- **AIChatPanel.tsx ad-hoc message types**: replaced inline `BaseMessage & { payload: { ... } }` types for `ai:provider:status` / `ai:budget:state` (which were missing `id` + `timestamp`) with canonical `AIProviderStatusMessage` / `AIBudgetStateMessage` imports from `@sandforge/shared`. Webview tsc was failing on Phase 04 close; extension vitest never caught it because the inline type compiled fine in isolation.
- **`pnpm.overrides` minimatch flipped vsce to incompatible major**: previous `<3.1.4: >=3.1.4` was a non-existent version (last 3.x is 3.1.2) that resolved vsce's `^3.0.3` to 9.x or 10.x, breaking vsce's CJS-default `__importDefault(require('minimatch'))` with `(0 , minimatch_1.default) is not a function`. Tightened lower bound to `<3.0.5` (the actual ReDoS-fix threshold per GHSA), constrained replacement to `>=3.0.5 <4` so CJS-default consumers stay on 3.x, plus `@vscode/vsce>minimatch: 3.1.2` path-scoped override belt-and-braces.
- **AI panel was an orphan route**: `AIPage` was registered in `PanelRouter.tsx` but `'ai'` was missing from `ModuleRoute` type, `ALL_ROUTES`, `router.tsx routeComponents`, both sidebars (`SidePanel.tsx` + `Sidebar.tsx`), `TopBar ROUTE_LABELS`, `CommandPalette ROUTE_ICONS+LABEL_KEYS`, `extension.ts moduleCommands`, `SidebarViewProvider commandMap`, the package.json command contribution, and EN/FR NLS. The whole AI backend was unreachable from the user-facing UI.
- **`BridgeProvider.tsx` contract drift on `ai:status:response`**: the listener read `msg.payload.available` but the canonical `AIStatusResponse` payload field is `enabled`. Silent typecheck-clean / runtime-broken. `setAiAvailable(undefined)` always made `aiAvailable === false` even when the API key was configured. Replaced ad-hoc inline type with `AIStatusResponse` import from shared so future renames break both sides at compile time.
- **Duplicate top-level keys in EN + FR locale JSONs**: `monitor`, `dataops`, `execution` were each defined twice in `en.json` and `fr.json`. `JSON.parse` silently kept only the second value (which contained `liveOps` only for `monitor`), wiping out `monitor.title`, `monitor.limits`, `monitor.emptyState`, etc. The user saw raw i18n keys on the Monitor empty state. Programmatic deep-merge preserved both occurrences in all three keys; verified all 4 other locales (de, es, ja, pt-BR) clean.

### Changed

- `pnpm validate` now ALWAYS runs through the pre-commit hook on every commit. The earlier flow let night autopilot ship phase summaries without ever invoking `pnpm package` (the only path that exercises webview tsc + VSIX production + vsce interop). The new hook closes that gap.

### Security

- **Prompt-injection defence verified adversarially**: `escapeUserData` HTML-entity-escapes `<` / `>` / `&`, strips NUL bytes, and `wrapAsUserData(label, value)` produces `<user-data label='${label}'>${escaped}</user-data>` where the label itself is also escaped. The spotlight clause in all 3 system prompts tells Claude `<user-data>` content is data, never instructions. 7 jailbreak fixtures (closing-tag breakout, nested-tag confusion, system-prompt impersonation, plain-text instruction, base64, unicode-lookalike, polyglot CDATA-like) all neutralised at the encoding layer with vitest assertions on both defence layers per fixture.

## [1.2.5] - 2026-05-02

**Forge Hardening Pass**: 23 audit findings resolved (security, performance, correctness) + CLI feature parity with the wizard. Phase 02 (Test Hardening) closed with 5 Playwright E2E specs covering critical user flows.

### Added

**Forge CLI (sandforge-clone)**

- `--upsert` flag: use external Id upsert when available, skipping `DUPLICATE_VALUE` on re-runs of the same source records
- `--expand-orphans` flag: single-hop expand orphan parent FKs (clones missing parents so child FKs resolve)
- `--skip-preflight` flag: bypass the new pre-execute target row count
- `--json` flag: machine-readable JSON summary on stdout for CI integration
- `--exclude <obj.field>` (repeatable): strip a specific field on a specific object before insert. BA opt-out for noisy long-text fields, calculated fields, or fields the target org doesn't have
- `--owner-map <src=tgt>` (repeatable): remap OwnerId from a source User Id to a target User Id. Use case: clone records authored by ex-employees onto a sandbox where their User no longer exists (otherwise INVALID_OWNER)
- Pre-execute preflight showing existing rows in the target org for the first 30 nodes (with a warning flag for >1000 rows) so users know the blast radius before pulling the trigger

**ForgeConfig (cross-sandbox dev/BA flow)**

- `fieldExclusions: Record<string, string[]>`: per-object field skip list (Zod-validated, max 200 fields per object). Exposed via wizard config and CLI `--exclude`
- `ownerMappings: Record<string, string>`: per-record OwnerId remap (Zod-validated, both sides must be 15/18-char Salesforce IDs, max 200 entries). Exposed via wizard config and CLI `--owner-map`
- `objectSoqlFilters: Record<string, string>`: per-object SOQL WHERE filter appended via `AND (...)` to the scope clause. Lets BAs narrow a clone to a subset (e.g. `Status = 'Open' AND CreatedDate > LAST_N_DAYS:30`) without changing graph topology. Zod-validated: max 512 chars per filter, max 50 filters, comment markers (`--`, `/*`, `*/`) and trailing semicolons rejected to block statement chaining. Exposed via wizard config and CLI `--filter`
- `fieldMappings: Record<string, Record<string, string>>`: per-object source→target field rename for schema drift (managed-package re-key, namespace change, `__c`/`__pc` variant). Source key is dropped, value written under target name. Zod-validated: SF field-name regex on both sides, max 200 fields per object, max 50 objects. Exposed via wizard config and CLI `--map`

**ForgeOrchestrator**

- `dispose()` method: clears the discovery cache and listeners on extension shutdown / org disconnect

**ForgeHandler**

- New `forge:target-preflight:request` message type: webview can request per-object existing-row counts on the target before execute. Backend uses sequential SELECT COUNT() (parallel bursts trip rate limits on big orgs), 30 s timeout, max 100 objects per request, sentinel `existing: -1` for per-object failures so the whole batch isn't aborted by FLS issues. Powers the same preflight surface as the CLI

**ExecutionSummary.remapTable**

- New `remapTable: Record<string, string>` field on every execute summary: the full source→target ID mapping table. BA reconciliation: post-clone audit, "where did source X go on the target sandbox?", CSV export, checkpoint persistence
- CLI: new `--remap-csv <file>` flag writes `sourceId,targetId` CSV (double-quoted, one mapping per row, header included)
- CLI: `--json` output now embeds `result.remapTable` for CI consumers

**Tests**

- 22 regression tests pinning the audit-fix invariants (`audit-fixes.regression.test.ts`)
- 5 Playwright E2E specs (Plan 02-03) covering: AI persona seed → execute, sync conflict resolve, monitor refresh + CSV export, CDC subscribe + event stream, AI diagnose + apply fix
- 9 fixture factories + `MockBridge.stream()` helper for multi-event flows

### Changed

**Forge security (Zod hardening)**

- `forgeConfigSchema.recordId` now regex-validated against the strict 15/18-char Salesforce ID pattern
- `forgeConfigSchemaStrict` enforces the inputMode→required-field contract via cross-field refine
- `forgeGraphNodeSchema.objectApiName` and `forgeGraphEdgeSchema.{sourceObject,targetObject}` regex-validated against the SObject API name pattern
- `forgeGraphSchema` bounded to 2000 nodes / 20000 edges (defense-in-depth against DoS payloads)
- `metadataDiffRequestPayloadSchema.objectApiNames` capped at 100 (was 500) to block API-limit DoS
- `ForgeOrchestrator.cacheKeyFor` includes `targetOrgId`, `anonymizePII`, `expandOrphanParents`, `maxRecordsPerObject` so cache hits never silently swap configurations

**Forge performance**

- `ForgePlanGenerator` Tarjan SCC rewritten as iterative: no stack overflow on deep graphs (5000+ node chain verified)
- `SchemaCache.estimateSize` now uses an O(1) structural heuristic (fields × 250 + childRel × 150) instead of `JSON.stringify`; `describeCache` byte cap restored to 200 MB, `describeGlobalCache` to 50 MB (eliminates the OOM risk introduced by the previous Infinity workaround while keeping the event loop unblocked)
- `GraphDiscoveryService` adds `setImmediate`-based event-loop yield between BFS waves, with `setTimeout(0)` polyfill for non-Node test environments
- Cold path breadcrumb (warns when `resolveRootObject` exceeds 2 s)
- `parseObjectFromSOQL` now strips parens to fixed point so deeply nested subqueries don't trick the parser into picking the wrong root object
- `IdRemapper.remapRecord` uses a single Map.get instead of has+get (3M lookups hot path on 50K-record / 30-field clones)

**Forge correctness**

- `orphanExpansionsUsed` counter now increments only on successful expansions, so a string of misses doesn't silently exhaust the budget before the eligible list has had a chance to succeed
- Pass-2 dedup uses an explicit current/updated pattern with collision detection on the same field
- `bringRootToFront` throws a clear error if the scoped root is missing or excluded (was silently producing disconnected clones)
- Orphan expand syncs the scope cache so multi-hop children that pivot through the expanded parent stay in scope
- `pickUpsertField` logs the chosen field and falls back to insert (instead of an unsafe alphabetical pick) when no candidate is non-null + unique across the batch
- `summarizeRecordForError` handles `undefined` and objects via JSON.stringify-truncated output
- `EXPANSION_EXCLUDED_OBJECTS` now mirrors the BFS-side exclusion list (BusinessProcess, DandBCompany, ProcessInstance, …), so orphan-expand stops burning API on system-managed entities
- `sandforge-clone` CLI forces `referenceFallback='nullify'` (was 'keep' by default, which preserved invalid source IDs on cross-org clones)

**Forge UX**

- `handleDiscover` flushes throttled progress on the catch path so the wizard never freezes on stale counts after an abort
- `handleExecute` reorders unsubscribe before flush so the terminal event delivers cleanly
- `handleAbort` nulls the controller refs after `.abort()` to close a small race between sequential operations

### Fixed

- Tests: `recordId` test fixtures across `ForgeHandler.test.ts`, `ForgeOrchestrator.test.ts`, `GraphDiscoveryService.test.ts`, and `forge.schema.test.ts` now use 15-char strict IDs to satisfy the new regex (no behavior change; they were stand-ins anyway)

## [1.2.4] - 2026-04-23

**Milestone v1.2.3 « Scale & Complete », shipped as v1.2.4.** Marketplace release of the Scale & Complete milestone (7 phases, 18 plans, 50 requirements), tagged `v1.2.4`. The feature content is documented under [1.2.3]; this entry records the version actually published so the version sequence has no gaps. (Entry backfilled 2026-08; it was only recorded in the root `CHANGELOG.md` and the `v1.2.4` tag message.)

- Three seed modes: AI Personas (10 industry personas), CSV Import (drag-and-drop + validation), Clone from Org (topological insert + ID mapping)
- Real-time sync lifecycle: CDC subscriptions, conflict resolution UI, execution history, cron scheduling
- Streaming execution (async generator, >10K records) + background operations with native notifications
- Enterprise UI: pagination, virtual scrolling, skeleton loading, notification center, keyboard shortcuts
- Smart Actions on HomePage: analyzes org state and recommends best next action

Tests: 8320 passing | VSIX: 1.24 MB | i18n: 6 languages

## [1.2.3] - 2026-03-28

**Scale & Complete**: Enterprise foundation, real-time sync, conflict resolution, AI personas, streaming execution, and three new seed modes.

### Added

**CSV Import (Seed)**

- Drag-and-drop CSV file upload with automatic BOM stripping and file size validation
- Auto column mapping: case-insensitive, underscore-tolerant matching to Salesforce fields with manual override
- Inline validation: type mismatches, missing required fields, length exceeded, invalid picklist values, duplicate external IDs
- 4-step wizard: Upload → Map Columns → Validate → Execute
- Preview of first 10 rows before execution

**Clone from Org (Seed)**

- Clone records between Salesforce orgs with full relationship integrity
- Source org picker with visual source → target direction indicator
- Object selector with searchable list and per-object SOQL WHERE filters
- Relationship-ordered insert via topological sort with cycle detection
- Self-referential handling (e.g., Account.ParentId) via two-pass insert
- Cursor-based pagination (2000/batch) for large datasets
- ID mapping table (source ID → new ID) with CSV export
- 4-step wizard: Source Org → Select Objects → Preview → Execute

**Seed Mode Selector**

- SeedPage now offers 3 modes via card-based selector: AI Generate, CSV Upload, Clone from Org

**CDC Real-Time Sync**

- Change Data Capture subscriptions with start/stop per object
- Live event feed with virtual scrolling (ring buffer, 5000 events)
- Event batching (150ms window) for high-throughput scenarios
- Auto-sync toggle per object with configurable conflict strategy
- Watchdog reconnection on sleep/wake with replay ID persistence
- Metrics dashboard: throughput sparkline, event lag, counters, uptime

**Conflict Resolution**

- Side-by-side diff viewer with 2-way and 3-way comparison (using base value)
- Per-field conflict resolution with source/target/manual choice
- Bulk resolution actions (accept all source, accept all target)
- Conflict list with DataTable, pagination, and severity/object/status filters
- Sync Page "Conflicts" tab with live badge count

**Sync History & Scheduling**

- Full execution history with FIFO retention (500 entries)
- History detail view with re-run capability
- Cron-based scheduling with visual builder, raw expression, and timezone support
- Schedule persistence across VSCode restarts
- Sleep/wake resilient execution (overdue jobs run once, not per missed interval)
- VSCode notifications on schedule completion/failure
- Sync Page tabs: Active Syncs, History, Schedules

**AI Personas (Seed)**

- Persona gallery with 10 industry-specific cards featuring icons and locale badges
- Preview popover showing 5 AI-generated sample records per persona
- Customization panel with editable field patterns per persona
- Persona field patterns auto-applied to Seed wizard field rules
- AI mode fork: choose between persona-guided or free-form generation

**Smart Actions**

- SmartActionAnalyzer: automatic record count analysis on 5 standard objects (Account, Contact, Opportunity, Case, Lead)
- SmartActionCard on Home Dashboard: contextual recommendations with "Just Do It" one-click CTA
- Decision priority: clone > quick-seed > sync > none (based on source data presence)

**Adaptive Seed Wizard**

- Auto-advance: skip Configure step when selecting fewer than 5 objects
- Category grouping: accordion layout when selecting more than 20 objects (Standard, Custom, Managed Package)
- InfoTooltip: dismissible contextual help persisted via localStorage

**Streaming Execution**

- StreamingPipeline: async generator-based chunk processing with abort support
- ChunkedBulkExecutor: multi-upload Bulk API 2.0 with 2000 records/chunk
- Automatic streaming for operations exceeding 10,000 records per object
- Progress callbacks with per-chunk tracking (chunksProcessed / totalChunks)
- Error cap at 100 entries to prevent memory growth during large operations

**Background Operations**

- BackgroundOperationRegistry: detached operation lifecycle with running/completed/failed/aborted states
- Abort support via AbortController for any running background operation
- Operation events: started, progress, completed, failed, aborted with subscriber pattern
- WebView visibility tracking via onDidChangeViewState
- VSCode native notifications when operations complete while panel is hidden
- ExecutionHandler: query operation status, list active operations, abort by ID
- Sync and Seed handlers automatically detach to background for streaming operations

**Enterprise Foundation**

- Pagination component with page size selector and keyboard navigation
- Virtual scrolling via @tanstack/react-virtual for large lists and tables
- Skeleton loading states for tables, cards, and panels
- Keyboard shortcuts: Ctrl+1..6 for direct module navigation
- Notification center with severity filters and mark-as-read
- Bulk job progress tracker with per-object progress bars
- Error recovery panel with retry, exponential backoff, and skip options
- Cache manager with automatic org-switch invalidation

### Changed

- SeedPage restructured with mode selector and AI persona fork (was wizard-only)
- Sync Page reorganized with tabbed layout (Active Syncs, History, Schedules, Conflicts, Real-Time)
- Seed and Sync handlers refactored: streaming pipeline for large datasets, background detachment for long-running ops
- Home Dashboard now shows SmartActionCard with contextual recommendations

### Performance

- Virtual scrolling for all large data tables (10,000+ rows)
- Ring buffer for CDC events (constant memory, no array growth)
- Org-switch cache invalidation (no stale data between orgs)
- Streaming execution for datasets > 10K records (async generator, 2000/chunk)
- Background operation detachment: UI stays responsive during long-running ops
- VSIX size: 1.23 MB
- 8320 tests passing (shared: 912, extension: 4533, webview: 2875)
- i18n: all new features translated in 6 languages (en, fr, de, es, ja, pt-BR)

## [1.2.2] - 2026-03-27

**Adoption-First: Sync & Seed Polish**: one-click sync and seed flows to populate a Salesforce sandbox.

### Added

**Quick Sync**

- 3-click flow: pick source/target orgs → multi-select objects → preview & execute
- Auto-field mapping: same-name fields matched automatically (no manual mapping step)
- Smart defaults: source-to-target direction, full mode, source-wins conflict, 200 batch size, upsert operation
- Pre-execution preview with estimated record counts and API call estimates
- Smart object suggestions: top 5 most-used objects (Account, Contact, Opportunity, Case, Lead)
- Relationship auto-detection: adding "Opportunity" auto-suggests "Account" as parent

**Quick Seed**

- 1-click seed from pre-built template gallery (no field configuration step)
- Template gallery UI with card grid showing name, description, object count, total records, and tags
- Customize record counts per object before execution

**Pre-Built Templates**

- 3 Seed templates: Sales Cloud Starter (7 objects, 7601 records), Service Cloud Starter (5 objects, 3800 records), Minimal Demo (3 objects, 350 records)
- 3 Sync templates: Full Account Hierarchy, Opportunities + Products, Cases + Attachments

**Seed Data Quality**

- Locale-aware data generation in 6 locales (en, fr, de, es, ja, pt-BR) with geo-coherent addresses
- Contextual ranges: object-specific amounts and dates (e.g., Opportunity.Amount: 5K-500K)
- Validation Rule auto-adjuster: detects ISBLANK, ISPICKVAL, LEN, REGEX rules and adjusts field values
- Picklist-aware generation: passes all active picklist values without truncation

**Onboarding**

- Sandbox detection with contextual guidance for new users
- Guided first-step cards on Sync and Seed empty states
- "Populate Sandbox" quick action on Home dashboard
- Welcome wizard updated for sandbox orgs

**Persistence**

- Save, load, and manage named sync configurations
- Save, load, and manage custom seed templates
- Wizard draft auto-save on every step change (survives page refresh)

### Changed

- Sync wizard reduced from 7 to 6 steps (merged org + object selection)

### Performance

- VSIX size: 1.16 MB
- 7623 tests passing (shared: 874, extension: 4310, webview: 2439)

## [1.2.1] - 2026-03-26

**Monitor Enrichment & Wiring**: Live backend services, alerting, and governance.

### Added

**Service Wiring**

- 5 previously dead backend services wired end-to-end with dedicated UI panels: Error Log Monitor, User Session Monitor, Apex Log Analyzer, Sandbox Refresh Tracker, Health Check

**Alert System**

- Default alert rules for API limits, storage, and error rates
- Alert persistence with configurable thresholds and severity levels
- VSCode native notifications (info/warning/error) on alert triggers
- Alert history timeline in Monitor dashboard

**Health Scoring**

- Unified health score aggregating all metric calculators
- Trend feedback with linear interpolation
- Health score displayed in Monitor dashboard and Home KPI row

**Limits & Trends**

- Expanded limits coverage: email invocations, Platform Events, FileStorage, sandbox reset countdown
- API response caching: /limits 30s TTL, OrgInfo 5min TTL
- Real timestamps in trend data (replaces index-based)
- CSV export for trend data

**Governance**

- Governance rule CRUD operations with custom rule definitions
- Rule evaluation engine with AlertEngine pipeline integration

## [1.2.0] - 2026-03-20

**Forge UX & Reliability**: Bug fixes, UX polish, performance, accessibility.

### Fixed

- Abort/pause/resume wired end-to-end in Forge execution
- DryRun flag properly honored during execution
- Dynamic object resolution for Forge templates
- Relationship field prefix map for correct reference handling
- Dead checkbox states in Forge wizard
- KPI calculation errors in Forge dashboard

### Added

**UX Improvements**

- Auto-org detection on extension activation
- Swap source/target orgs button
- Table view for object lists
- Log persistence across sessions
- ETA calculation for long-running operations
- Template CRUD management (create, edit, delete, duplicate)
- Node search in Forge dependency graph
- SidePanel redesign: compact mode, improved org switcher, collapsible metrics

**Backend Hardening**

- Structured error responses across all message handlers
- Configurable timeouts for all API calls
- Lifecycle events for operation tracking (started, progress, completed, failed)
- Real Bulk API 2.0 job IDs in responses

**Accessibility**

- ARIA tablist on tabbed interfaces
- aria-pressed on toggle buttons
- role="log" on live output panels
- Radiogroup patterns for exclusive selections
- Contrast fixes for WCAG 2.1 AA compliance

### Performance

- Dagre layout calculation separated from render cycle
- Memoized KPI computations
- Adaptive row heights in data tables
- 7149 tests passing

## [1.1.0] - 2026-03-19

**Stabilisation & Real-World Readiness**: Every module working end-to-end.

### Fixed

- CorrelationId bridge infrastructure: all message handlers use typed request/response with correlationId
- Ghost features removed: Grappe sidebar, placeholder modules, dead routes
- Bulk API 2.0 properly wired with retry and exponential backoff

### Added

- All 8 modules functional end-to-end: Seed, Sync, Monitor, Compare, DataOps, Automation, AI, Autopilot
- AI conversation persistence across sessions
- Dashboard refresh UX with error recovery
- Competitor benchmark analysis and 5 Monitor feature gaps addressed
- 7042 tests passing

## [1.0.0] - 2026-03-17

**Marketplace-Ready Release**: First public version.

### Added

- 6 core modules: Seed (AI-powered data generation), Sync (bidirectional ETL), Monitor (org health), Compare (metadata diff), DataOps (backup/compliance), Automation (visual pipelines)
- AI Assistant: NL2SOQL, error resolver, schema advice, 10 business personas
- Autopilot: auto-provisioning with compliance profiles, dependency graph, execution waves
- Grappe Engine for parallel processing of large datasets
- Production Guard with 3 safety tiers and CRUD/FLS enforcement
- Full i18n support (en, fr, de, es, ja, pt-BR)
- 162 Playwright E2E tests with WCAG 2.1 AA accessibility compliance
- GitHub Actions CI on Windows, macOS, and Linux
- VSIX optimized to 1.07 MB
- Published on VS Code Marketplace
