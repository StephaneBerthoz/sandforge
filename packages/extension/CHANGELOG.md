# Changelog

All notable changes to SandForge will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **A sync's WHERE filter can only filter.** A sync object's WHERE clause was
  checked for four DML keywords and nothing else, so a clause carrying
  `LIMIT 1`, `OFFSET` or `FOR UPDATE` was appended to the source read as
  written: a filter ending in `LIMIT 1` copied one record and the run still
  reported itself complete. An SFDMU `export.json` could carry such a clause
  without anyone typing it. A clause that goes past the filter is now refused
  before the run: an extra clause, a subquery, a comment, a semicolon, a
  parenthesis that escapes its group or an unclosed quote. Quoted text is set
  aside first, so `Status = 'Delete pending'` still works. The same rule is
  applied again where the query is built, and to Clone filters when they
  count, sample or fetch records. It now guards Clone, Frozen Dataset and
  Autopilot filters as well, so a saved filter in any of them that relied on
  one of these — an unbalanced parenthesis, or `FOR` or `WITH` outside quotes —
  is refused too.
- **A sync no longer runs the opposite way to what it says.** The direction
  list offered _Target to source_, and the run then wrote source to target,
  into the org you meant to read from. The option is gone and a configuration
  asking for it is refused; to copy the other way, swap the two orgs.
  Incremental, delta and CDC modes only ever replayed a full sync, and are
  refused the same way.
- **A field that cannot hold its value stops the sync before anything is
  written.** The field-type check existed but never ran for a sync: its one
  caller treated every source field as text and only logged a warning, so a
  text field mapped onto a date field was discovered by Salesforce, record by
  record, after the run had started writing. Both orgs are now described
  before the run and every field a mapping copies unchanged is compared — with
  no mapping, every same-named field. A mismatch ends the run with the pairs
  that do not fit, and so does an org whose description cannot be compared. A
  mapping whose value a transform rewrites is not judged on its source type.
- **Files are refused instead of breaking a sync partway through.**
  `Attachment`, `ContentVersion` and `Document` keep their content in a file
  body that Bulk API 2.0 rejects, and the object picker still offered them: a
  run that included one failed past the bulk threshold, after the REST path
  had already written records. They are no longer offered, and a
  configuration naming one is refused before it starts.
- **A transform rule carries the settings you type into it, and leaves the
  field the write matches on alone.** The truncate length, the prefix, the
  suffix, the search and its replacement, the regular expression, the default
  value, the date and number formats and the formula all cleared themselves on
  every keystroke, so every value-based rule reached the run with an empty
  configuration: it did nothing the box asked for, and a truncate, prefix or
  suffix rule still rewrote every field as text — a number became its digits,
  an empty field an empty string — while a date or number format rule applied
  its built-in default. The run reported success either way. The boxes now hold
  what you type and the rule carries it to the run. Such a rule applies to
  every field of every record of the run, so `Id` and the external ID the run
  matches on are now left exactly as they are by every rule the builder adds: a
  prefix or a truncate over the match field would upsert new records under a
  key the target has never seen and report every one of them as written. A
  truncate length is sent as the whole number the configuration requires, and
  text that is not one is not kept — the box empties and the rule goes out with
  no length, rather than truncating at a length you did not ask for. Value
  mapping is the one rule the builder still has no box for, so a rule of that
  type added on the page goes out empty and leaves every value as it is.
- **Sync no longer offers a conflict strategy that only pretends to be one.**
  _Manual_ resolves every conflict to the source values and writes them — the
  same result as _Source wins_ — while its name promises a review, and there is
  no screen in the product on which a conflict can be reviewed. The list now
  holds the four strategies a bidirectional run acts on: source wins, target
  wins, newest wins and a field-level merge. A saved configuration still naming
  the withdrawn strategy reopens on _Source wins_.
- **A record-scoped clone with more than 600 children runs to the end.** A
  scoped query travels in the request URI, and the list of Ids that scopes it
  stopped fitting there at around 600, past which the clone refused to start.
  Below that the query could still overflow, because the list is repeated once
  per lookup field: three lookups on 600 parents built a query no org accepts.
  Forge now splits a large scope across as many queries as fit the URI, reads
  them in turn, keeps each record once and still honours the per-object cap.
  Frozen dataset extraction, which builds its queries the same way, now reads
  every part too. The one case still refused is an object whose field list
  alone leaves no room for an Id; excluding fields from it lets it run.
- **Records cloned by Forge carry the target org's record type.** Record type
  Ids differ between orgs, and the in-product clone never translated them:
  every record kept the source org's `RecordTypeId`, which the target refuses.
  Before a run, Forge now reads the active record types of both orgs and
  matches them by object and API name — the object matters, since Account and
  Opportunity can each have a "Business" record type. A record type with no
  match on the target is named in the output instead of surfacing later as an
  insert error that points to nothing; the master record type, whose Id is the
  same everywhere, is left as it is. The lookup gives up after 30 seconds and
  the run goes ahead untranslated, and Abort while it waits refuses the run at
  once. The command-line clone and the recipe tool match within the object as
  well.
- **The command-line clone reads master-detail relationships like the wizard.**
  The clone script and the Grappe recipe tool dropped the cascade-on-delete flag
  from the fields they read, so a master-detail an object declares on its own
  field was recorded as a lookup: where the pair was not also seen from the
  parent's side, the edge stayed a lookup and a cycle held together by such
  fields was planned as a lookup to null out. Both now mark a field that
  cascades on delete as master-detail, as the extension's own describe adapter
  does: the master-detail edge wins for an object pair, and a cycle with no
  lookup in it is planned as two passes.
- **A Forge SOQL query's WHERE clause now filters the object after FROM.** Forge
  read only the object name and dropped the clause, so `SELECT Id FROM Account
WHERE Industry = 'Energy'` cloned Accounts from the whole table, up to the
  cap, under a warning that admitted it. The clause now reaches the run as that
  object's filter: discovery counts the rows it matches, and the clone reads
  only those. An alias on the object (`FROM Account a WHERE a.Industry = …`) is
  removed from the clause first, and an alias declared over a relationship after
  the FROM object (`FROM Contact c, c.Account a WHERE a.Name = 'Acme'`) is
  rewritten to the path the object understands, so the clause filters on the
  related field as you wrote it; text inside quotes that reads like one is left
  alone. An alias built on a relationship that starts from no alias the query
  declares keeps Discover disabled, under a message pointing at the FROM clause
  rather than the WHERE one. Related objects are still read from their whole
  tables, not narrowed to the matching rows, and every object stays capped at
  200 records or fewer; the warning under the query now says exactly that and
  names the object it filters. ORDER BY, LIMIT and the other clauses after WHERE
  are not applied. A clause the extension would refuse — longer than 512
  characters, containing `--`, `/*` or `*/` even inside a quoted value, or
  ending with a semicolon — keeps Discover disabled and hides Reuse last graph,
  with a message saying why; such queries used to discover without their filter.
  A saved template holding a SOQL query now runs as that query on Discover and
  on Reuse last graph alike, with the same filter, the same cap and the same
  refusal. Reuse last graph used to send only the template's id, and such a
  template was not held to the cap.
- **Leaving a running discovery stops it, at once.** Back on the discovery
  spinner returned to the input screen but left the graph walk querying the org.
  Discovering again started a second walk beside the first, whose late answer —
  a truncated graph or an error — could replace what the new discovery showed,
  and a truncated graph was cached for the next identical request. Back now
  cancels the walk, a new discovery cancels the one it replaces, and a cancelled
  walk reports only that it was cancelled — no graph, no error — and caches
  nothing. The cancel also takes effect straight away: the walk used to notice
  it only between batches of six objects, each waiting for its slowest call, up
  to 30 seconds for a describe on a rate-limited org, and the lookup of the root
  object waited for the org's whole object list. Each call now settles as soon
  as the discovery is cancelled. A request whose connection was still opening is
  not sent; one already sent to Salesforce runs to its end, and its answer is
  dropped.
- **Select All and Deselect All act on the rows the search shows.** With the
  table filtered, both buttons changed every object in the graph, including
  the hidden ones, so a clone could gain or lose objects nobody saw change.
- **Forge refuses the same objects whether it walks the graph or fetches a
  missing parent.** Discovery and parent expansion kept separate exclusion
  lists that had drifted apart, so expansion could insert a job or log record
  such as `AsyncApexJob` or `CronTrigger` that discovery refused to walk into.
  There is now one list.
- **The Forge Errors panel explains the Salesforce errors it recognizes, in all
  six languages.** No locale defined the hints the translator named, so the
  panel printed raw key paths such as `forge.error.duplicateValue.explanation`
  under the message. Every hint it can produce now has text in English, French,
  German, Spanish, Japanese and Brazilian Portuguese, a test fails when the
  translator names a key a locale lacks, and the Forge quickstart says the hints
  follow the SandForge interface language rather than French or English.
- **A seed that names a Faker method SandForge does not generate is refused
  before its first insert.** The method was checked only when the generator
  reached it, so with a bad method on a later object the earlier objects were
  already in the org when the run stopped. None of the three Quick Seed
  templates could run: they named five methods nothing generated. Minimal Demo
  and Service Cloud Starter failed on their first object; Sales Cloud Starter
  inserted its price book, then failed on Product2. Job titles, street
  addresses, catch phrases, product descriptions and near-future dates are now
  generated, the validator refuses any other method and names the object and
  field, and the wizard offers a list of methods instead of a free-text box.
- **A seed configured in the wizard reaches the org unless a field it cannot
  fill needs you.** The wizard gave every described text, number and date field
  a Faker rule with no method, and every picklist a random pick with no values,
  so the run refused the template with "Faker rule requires a fakerMethod"
  before writing anything. Each field now opens on a rule the run accepts: a
  Faker method read from the field's type and name — an email address on an
  email field, a person's name on a Name field, a sentence otherwise — a random
  pick among the picklist's own values, an unchecked checkbox, and, on a type no
  generator fits such as a multi-select picklist or a time field, a fixed value
  left empty, which a required field still has to be given before the run.
  Switching a picklist field to another rule type and back restores its values
  instead of leaving the run to refuse an empty pick. An optional lookup
  pointing at an object the run does not seed, such as an owner, is left out of
  the run and defaulted by the org instead of failing the whole template; a
  required one is still sent, so the run is refused before it writes anything
  and names the object the lookup points at.
- **A persona applies to every object you seed.** Objects are described one at
  a time, but a persona was applied once: every object whose description
  arrived afterwards kept its default rules, with no warning. Each object now
  receives the selected persona as it arrives.
- **AI field rules never insert blank fields, and no longer write text into
  typed fields.** When AI was off, over its token budget or refused a call, the
  fields were written empty, while the release notes said they fell back to
  Faker. A field the AI leaves empty now receives a generated sentence, and
  the run continues with the refusal in the log. Because that value is text,
  the wizard offers AI generation only on text and long text fields, a wizard
  run that sets it on a number, currency, date, checkbox, email or picklist
  field is refused before the first insert, and personas no longer set it on
  such fields. The results step now names, object by object, the fields that
  received a sentence, and says whether the AI answered nothing — it is off, or
  the call was refused — or answered with values missing; a partitioned run
  reports it too.
- **A generated value fits the field it is written to.** A sentence written by
  the generator or by AI was inserted whole, so a 40-character text field met it
  with STRING_TOO_LONG and the record failed. The wizard now carries each
  described field's length into its rule, and keeps it when a persona or a
  change of rule type rewrites the rest of that rule; a value longer than the
  field is cut to it, at the last word boundary inside the limit when there is
  one and hard otherwise. A rule that carries no length is left as it is.
- **A persona written by AI keeps only what Seed can generate.** The model was
  shown `"params": { "...": "..." }` and had to guess, and whatever it wrote
  was stored: an unknown Faker method stopped the run later, and a minimum
  written as `"200"` was ignored. The prompt now lists each generator's params
  and the supported methods, patterns Seed cannot use are dropped, and numbers
  written as text are read as numbers.
- **Quick Seed shows how far the run has got.** Its bar sat at 50% for the
  whole run and every object read 0 of N, because only a start and an end were
  reported. Each object, and each partition of a partitioned object, now
  reports the records written so far, the bulk paths count against the whole
  run, and a second run in the same session starts at 0%.
- **Stop stops your own seed, and a progress bar follows its own run.** Every
  open panel receives every run's progress, and the Seed wizard's Stop sent the
  abort for whichever run had reported progress last, so with two runs going it
  could stop the other one. A seed's operation id is now the id of the request
  that started it, as a sync's already was. Stop targets that id, and the Seed,
  Quick Seed and Sync progress bars read only their own run's figures, so
  another run no longer moves them.
- **A clone that fails says so at once, in your language.** A clone could fail
  after it started, including when the production guard blocked it or its
  confirmation was declined. The extension reported that only as an operation
  failure, which the clone wizard never listened for, so the wizard stayed on
  its running screen for two minutes and then showed a raw timeout instead of
  the reason. It now matches that failure to the clone it started and says
  straight away, in the SandForge interface language, which of three things
  happened: the production confirmation was declined, the production guard
  blocked the clone before any record was written, or the clone stopped before
  it finished. Only that last one is followed by the error as it was reported,
  untranslated; the guard's own reason is written to the SandForge output
  channel.
- **Home's recommended action opens the screen it names, ready to go.**
  Confirming a recommendation only switched page: Clone and Quick Seed landed on
  Seed's mode picker, and Sync landed on Grappe, which can only display a run
  already in progress. Clone now opens the clone wizard writing to the target
  org the recommendation named, with its source org selected and that org's
  objects loading; Quick Seed opens Seed on its templates, and Sync opens Sync
  with both orgs set. Quick Seed also stops asking twice for an org the
  recommendation has already named: the step after the first template you pick
  opens with that org selected, unless it is no longer connected, in which case
  it asks as before. Nothing runs from Home: the clone preview and the
  production guard still come first, and a quick seed still waits for the click
  that starts it.
- **An answer reaches only the request that asked for it.** Each panel built
  message ids from the time and its own counter, so two panels sending in the
  same millisecond could mint the same id and take each other's answers, and a
  sync sent under a repeated id was refused as a duplicate; ids are now random.
  A Frozen Dataset request took any error of its type, so another panel's failed
  load cancelled yours, and the Frozen page took every load progress event,
  every 4-point control result and every post-load verdict that arrived,
  whichever run had asked for it: a run started from another panel moved your
  progress bar and left its verdict on your page. Forge mission control took any
  Forge error, progress event or result, so another run's error marked yours
  aborted; each now takes only what answers its own request. A Frozen run is
  followed from the request that starts it to its verdict, so the verification
  chained after a load still reports; starting the same kind of run again drops
  the one it replaces, including after a switch between the Extract and Load
  tabs, and leaving the page clears the progress it was showing. Settings
  mistook the AI status update that the extension pushes whenever the AI wiring
  changes for the answer to its own status check, and dropped the real reply; it
  now waits for that reply.
- **A message the extension drops is answered.** A message refused by the rate
  limiter, or of a type no handler takes, was only logged, and the page that
  sent it waited out its whole timeout before showing a generic failure. The
  extension now answers it with a bridge error correlated to it. The panel that
  sent the message shows that error as a Bridge error notice, and the other
  open panels leave it alone: one refusal used to appear once per open
  SandForge panel, each of them reporting a request it had not made. The
  Schedules tab follows the same rule for the refusals it shows. A drop that
  answers no message at all is still shown in every open panel, since none of
  them owns it.
- **Sync history loads, and an export says where it went, whichever Sync tab
  you are on.** Nothing passed the extension's answers to the history store: the
  request went out, the table never filled, and an export never reached the Save
  dialog. The Sync page now feeds the store the five answers it waits for — the
  list, one entry's detail, the exported content, a history error and the save
  dialog's reply — and it stays mounted for as long as Sync is open, where the
  History tab does not: an export you started and then left the tab on lost its
  answer, so no dialog opened and no file was written, and a path saved on the
  way out was announced nowhere. The dialog now opens and the file's path — or
  the reason it was not written — reaches you wherever you are. A dismissed
  dialog stays silent, as other exports already did.
- **The AI token budget holds across AI setting changes.** Every change to a
  `sandforge.ai.*` setting rebuilt the AI stack with a fresh, empty counter, so
  toggling any AI setting was a way past the limit, and until the rebuild
  finished, calls from Seed or an open chat went through with no budget at
  all. There is now one counter per window, shared by every AI call and kept
  across rebuilds. **Raising `sandforge.ai.tokenBudgetMaxPerSession` no longer
  restarts the count, as 1.22.0 said it did**: the new limit applies to the
  tokens already used, and only a window reload or "SandForge: Reset AI Token
  Budget" starts over.
- **You are told when the AI budget runs low, wherever you are.** The 80%
  warning and the refusal were sent to a page that never listened for them;
  the only sign was the gauge on the AI page, and a Seed run whose AI values
  were refused fell back quietly. VS Code now shows a notice once at 80% and
  once when requests start being refused, with a button that opens the
  setting. The gauge also shows as soon as the AI page opens, instead of
  after the next AI call.
- **A new API key is used as soon as you save it.** With AI already on, saving
  a key changed no setting, so nothing rebuilt the client: a wrong key, once
  saved, failed every call until the window was reloaded, even after it was
  corrected. Saving a key now rebuilds the AI stack straight away.
- **Turning AI off stays off.** Each setting change started its own AI setup,
  and nothing kept them in order: a turn-on still waiting for the keychain
  could finish after a later turn-off and put the assistant back. The latest
  change now wins, and a setup overtaken by a newer one installs nothing.
- **A failed AI call is one request to Anthropic, not three.** The Anthropic
  SDK retried each failed call twice underneath the circuit breaker that
  counts failures, so three counted overloads could mean nine requests before
  the breaker opened. The SDK's own retries are off.
- **A failing run asks the model once per failure, not once per occurrence.** A
  run failing the same way many times asked the model every time. Failures with
  the same code whose messages differ only by a record or org Id now share one
  call while it runs and reuse its answer for ten minutes; a call that fails is
  not kept. An aggregated Salesforce error is answered from the built-in table
  when any of its codes has an entry: only the first code was read, so an
  unknown first code sent the message to the model even when a later one had a
  curated answer. The prompt no longer tells the model "Module: unknown" and
  "Operation: unknown": it now carries the module the failed run belongs to, the
  request that started it, the object it was on — every object of the run when
  the failure names none — and the batch size the records were written with,
  while a line the handler cannot fill is left out. The answer is still
  remembered by error code and message, so the same failure raised by two runs
  is still asked about once.
- **An AI pipeline draft wrapped in a markdown fence loads its steps, and a
  draft with no step is refused with a reason.** The pipeline reader parsed the
  model's raw reply, so JSON inside a `json` code fence read as no JSON and came
  back with no step, and the Automation page opened an empty canvas as if the
  draft had worked. The draft is now read from inside the fence. A draft left
  with no step answers as a failure, and the page shows "The AI returned a
  pipeline with no steps, so there is nothing to load" with an example of what
  to ask for.
- **The NL2SOQL check accepts a parent-child subquery.** `SELECT Id, Name,
(SELECT LastName FROM Contacts) FROM Account` was rejected with `Object
"Contacts" not found in schema`: the check took the subquery's relationship
  name for the queried object. A subquery, in the field list or in WHERE, is now
  left to the org, while the plain fields around it are still checked, so an
  invented field next to a subquery is still reported. A draft whose only
  selected item is a subquery comes back marked as not checked, and the FAQ says
  subqueries are not checked.
- **The anomaly scan runs, on any object.** It asked Salesforce for
  `FIELDS(ALL)` over 500 records, a query the platform refuses above 200 rows,
  and the fallback meant to catch the refusal looked for its code in the
  message, where jsforce does not put it. That query is no longer sent: the
  scan names the object's fields itself and samples the 500 records it
  promises, or 200 with `FIELDS(ALL)` when the field list would make the query
  too long to send. A refusal is recognised by its code. Compare's data
  comparison, Autopilot's record reads and Sync's fallback read go through the
  same query and are fixed with it. The object dropdown now ends with **Other
  object…**, which takes any object's API name. A name that is not shaped like
  an API name is explained under the field and never sent; a well-formed name
  the org does not have comes back as the org's refusal.
- **Monitor trends span the week they claim.** The 7-day view drew the same 24
  hours as the 24-hour view, and a 30-day button offered data that was never
  kept: every snapshot stored some fifty limits, so the 500 KB cap held about
  27 hours. History now keeps only the limits the dashboard charts, a full
  week fits, the chart offers 24 hours and 7 days, and a second chart's period
  buttons, which filtered nothing, are gone. Direction, change and
  time-to-limit still read the last day, since most of these limits reset
  daily, and the health score takes a trend penalty for the charted limits
  only.
- **Governance rules are measured, or they say they are not.** Evaluation keyed
  the org's `/limits` answer by limit name only, while the built-in policies
  name metrics such as `apiUsagePercent` or `mfaEnabledPercent`: those read 0,
  so on every org the MFA, password and code-coverage rules failed and the API
  and storage rules passed, and none of it said anything about the org. API and
  storage usage are now read from `DailyApiRequests` and `DataStorageMB`, and a
  rule whose metric the org gives no reading for is shown as not measured, in
  six languages, left out of the compliance score and of the remediation
  checklist, and raising no alert. A policy where nothing could be measured
  shows no score at all. Nothing is read yet about multi-factor authentication,
  password policy strength or Apex code coverage, so those rules report as not
  measured.
- **Org Health Check shows counts under its count labels.** Active Jobs and
  Recent Errors showed the points those two signals had lost — 30 for three
  failed jobs — and the error figure was whatever the Error Logs panel had last
  read, which a dashboard refresh never renewed. The two figures are now Failed
  Jobs and Recent Error Logs: the failed `AsyncApexJob` rows and the error
  `ApexLog` rows of the last 24 hours that this refresh read itself, up to 50,
  each shown as 0 when its rows cannot be read. The formula behind the health
  badge is unchanged, but its input is not: the error signal now scores the logs
  the refresh read itself, so an org whose error logs had never been loaded
  showed a healthy badge and can now show a degraded one. Reading them costs one
  `ApexLog` query per refresh, on top of the one the Error Logs panel makes for
  itself.
- **Live Operations cancels what it lists, and offers pause nowhere.** The
  panel lists Seed and Sync runs, but Cancel, Pause and Resume went to a
  handler that only knows pipeline runs, so every click ended in "No active
  operation found". Cancel now stops the run, scheduled syncs included, a
  notification says when it could not, and the list is read again after a
  cancel and on every refresh. Neither run can be paused, so the panel no
  longer offers to. A Cancel clicked as a run ends is now refused rather than
  claimed: the panel holds a snapshot of the list and the registry keeps
  finished runs, so the click found one, answered that a run which had already
  completed was stopped, and relabelled it aborted. A run that is no longer
  running is left exactly as it ended — same outcome, same end time, no new
  event — and the answer says it had already finished, which the panel shows as
  a refused cancel.
- **An acknowledged alert shows as acknowledged in the history too.** The
  alerts panel, the alert history and the alerts count each asked for the same
  list, and an acknowledge or dismiss refreshed only the panel that sent it.
  All three now read one query.
- **An expired org can be reconnected from its card.** An org whose session
  had expired or failed showed a badge and no way forward. Its card now offers
  Try Reconnect, which repeats how the org was added: a CLI import runs again,
  a browser login reopens with the alias filled in, and a password login with
  the alias and username (the password is typed again).
- **The JWT and Device Flow cards say they are coming soon.** Both methods are
  refused by the extension, but their cards looked like the working ones and
  their tooltips described a login that does not exist. They are marked
  "Coming soon" on the card, in the tooltip and for assistive technology.
- **An org edit is saved, and the edit dialog no longer offers a safety tier.**
  In the Organizations edit dialog, Save changed only the panel's own copy of
  the org, so the next org list put the old alias, colour and tags back and a
  window reload lost them. The extension now writes them to the org registry and
  answers with the saved list; the card changes when that answer arrives, and a
  refused edit is shown in the page banner. The safety tier select is gone: the
  production guard decides from the org type and never read it, and the pick was
  not saved either, so it looked like a safety control and did nothing. Those
  edits also survive a CLI re-import and a reconnect, which rebuild the org from
  what Salesforce returns — default alias, default colour, no tags — and used to
  replace the stored entry: an org renamed "QA sandbox" and coloured amber came
  back as `dev@example.com` in blue. Saving an org that is already known now
  keeps the alias, colour, icon and tags it was given, and takes everything
  Salesforce owns — status, instance URL, org type, safety tier and metadata —
  from the incoming org, so a sandbox that moved instance is still recorded at
  its new URL. The alias set in SandForge wins over the one the Salesforce CLI
  reports, so an alias changed with `sf alias set` no longer shows up here:
  rename the org from the edit dialog.
- **One org that never answers no longer holds up the others at startup.**
  Startup validation checked orgs one after another with no bound, so an
  identity call to an instance that accepted the connection and never replied
  kept the sweep waiting, and the orgs after it were never checked. Each
  identity check now gives up after 20 seconds and counts as a failure for that
  org's circuit breaker, every `sf` call that refreshes a session token is
  stopped after 30 seconds, and the sweep moves on after 45 seconds per org and
  marks the silent one as an error. An org whose check succeeds after that
  deadline is set back to connected, so a slow link no longer leaves it in error
  for the rest of the session; a late failure, or a status something else has
  changed in the meantime, is left alone.
- **A Salesforce CLI that never answers no longer holds the caller forever.**
  The 30-second timeout on an `sf` call kills the process the extension started.
  On Windows that is the shell, and when `sf`'s own child keeps the output pipe
  open the call never came back: a sync asking for a connection waited with no
  end. Each `sf` run of the token refresh now has an outer deadline two seconds
  past that timeout, after which the caller is told the CLI did not answer
  within 30 seconds, and on Windows the whole process tree is killed. A run that
  overran is not repeated for the reads that follow it.
- **Operations recovered from a previous session are replayed only once the
  network answers.** A queue reloaded at startup was drained against the status
  the window opened with, which is simply online until something checks. With
  the network actually down, each recovered operation was replayed, failed and
  was dropped rather than kept. The replay now waits for a connectivity check:
  while the check says offline the operations stay queued and the probe keeps
  running, and they go out when it finds the network up. With no probe wired, or
  probing turned off, there is nothing to check with and the queue is drained as
  before.
- **Open Org in Browser works from the Command Palette.** The command needed an
  org id the palette cannot pass, so it was hidden there and the launcher
  dropdown was the only way in. Run without one, it now lists the registered
  orgs to choose from, or points to the Organizations page when none is
  registered, in all six languages.
- **Closing or reloading the window aborts the syncs, seeds, CSV imports and
  frozen-dataset runs still going.** On dispose — a window close, a reload, an
  update — the list of background operations was cleared without aborting
  anything, so a running operation kept its live abort signal and nothing was
  left to report on it. Running syncs, seeds, clones started from Seed, CSV
  imports and frozen-dataset runs now receive their abort signal, and a state
  update scheduled during shutdown is cancelled instead of being posted to a
  bridge that is already gone.
- **The Forge command-line scripts refuse a bad flag before they contact an
  org.** In `sandforge-clone`, `--depth deep` was cast straight into the depth
  type, and a malformed record Id or API name was refused only after both orgs
  had been authenticated. The flags now go through the schema the wizard uses,
  and a bad one exits with code 2 before `sf org display` runs. `--owner-map`
  crashed on every use, because the Id pattern it checked against was never
  defined; it now works. `sandforge-cleanup` read `--since` and `--max` only
  after `sf org display` had handed over a session, so a `--since` carrying an
  extra SOQL clause, a `last_n_days:0` or a `--max` that was not a number was
  discovered with an authenticated connection already open, and a bad alias or
  object name exited 1, the code the script keeps for a fatal error, rather than
  the 2 that means a command line it will not run. Every flag is now read and
  checked first — the alias, the object names, `--since` against the forms it
  accepts and `--max` as a whole number above 0 — and a bad one writes the
  reason to stderr and exits 2 with no org contacted. The cleanup script and the
  Grappe recipe tool beside it no longer run when they are merely imported, as
  the clone script already did not: each starts a run only when it is the script
  that was invoked.
- **The in-app Help stops teaching a sync rollback, an API-timeout setting
  and four other features that do not exist.** In all six languages it taught
  a sync rollback nothing reads, an API-timeout setting the manifest never
  declared, Grappe as the cure for a slow run, deploying straight from a
  Compare diff, pipelines started by schedules and webhooks, and a DataOps
  suite with data subject requests, quality scans and mass deletes. A user who
  followed it expected a sync to be undoable. The Help now marks what is coming
  as coming, and states that a sync cannot be undone and should be preceded by
  a backup. Forge, Frozen Dataset and Grappe get sections of their own.
  Ctrl+Enter, taught as "run the current action", broadcast an event nothing
  listened to and is no longer handled or taught. The Help no longer teaches
  Ctrl+1..9, which VS Code mostly keeps for itself, and teaches the G+letter
  chords instead.
- **Automation says which steps run before you press Run, on the canvas and in
  the Marketplace.** Only Delay and Condition have handlers; every other step
  type reports success without opening a connection, so a pipeline of Seed and
  Backup steps ran green and moved no record. The canvas carries a notice, the
  palette marks the thirteen inert step types as coming soon, and the header and
  welcome no longer promise automated seed and sync. The Home quick action and
  SandForge's own command palette offered "Run Last Pipeline", which only ever
  opened the page, and now say so: "Open Pipelines". That notice now also
  stands above the Marketplace list, since a template card is read on its own
  and an installed template is built from those same step types, and it takes a
  single row instead of a panel, so it no longer pushes what it warns about
  down the screen. Approval no longer claims to pause and wait for someone,
  because a run walks straight through it; Notification no longer offers
  delivery by email, Slack or another channel, and its configuration asks for
  the message alone rather than a Channel box nothing read. The starter
  template named "Data Migration Dry Run" is now "Migration Pre-flight Check"
  and no longer offers to validate without committing, no Marketplace template
  promises to notify or alert anyone, and the run views drop a "Waiting
  Approval" status no run was ever given.
- **The DataOps welcome and guide stop promising what is not built.** The
  welcome offered to schedule cleanups and track data quality, and the guide
  described a request form, cleanup recommendations, a quality dashboard,
  incremental backups, an object picker and point-in-time recovery. A backup
  is a full snapshot of Account and Contact, restored whole into the org it
  came from, and both now say exactly that.
- **Create Template in DataOps › Anonymize says it is not built.** The button
  accepted the click and did nothing, because nothing creates a template. It is
  now disabled, with a "Coming soon" hint.
- **Sync reports to the Grappe view only at or above
  `sandforge.grappe.autoActivateThreshold`.** With Grappe enabled, every sync
  opened a Grappe run whatever its size, while Seed and Autopilot waited for the
  threshold the setting names. Before the first write, Sync now counts each
  object's source records with the run's WHERE filter, one `SELECT COUNT()` per
  object, and each count stops where the read stops: at the query cap on a
  production source, at 50,000 records elsewhere. It reports one partition per
  object only when the total reaches the threshold. If the org refuses a count,
  the sync goes on and reports nothing to the Grappe view. The Grappe help, the
  empty Grappe page and both Grappe setting descriptions now say that Sync waits
  for the threshold too, in all six languages, and the Sync guide says when the
  reporting starts and what the counting costs: one API request per object of
  the run, charged to the org's daily limit, production included, and none at
  all with the setting off.
- **An Autopilot run opens and closes in the Grappe view under one id.** The
  start and completion events each minted their own `autopilot-<timestamp>`, one
  before the run's work started and one after it ended, so the closing event
  named a run that had never been opened. Both now carry the id minted when the
  run starts.
- **SandForge follows VS Code's display language until you choose one.** A
  webview only sees the OS locale, so VS Code set to French on an English system
  opened SandForge in English. The extension now passes VS Code's display
  language to every panel and to the sidebar, and as long as no language has
  been chosen in SandForge, the interface tries it before the OS locale, falling
  back to the OS locale when SandForge ships no bundle for it. An English VS
  Code on a French, German, Spanish, Japanese or Portuguese system therefore now
  opens SandForge in English, where it used to follow the system. A language
  chosen in SandForge still wins.
- **A language that fails to load in Settings is reported, and the selector
  returns to the language on screen.** The change was fire-and-forget: when the
  locale bundle could not be loaded, the selector showed the new language over
  an interface still in the old one, and nothing said why.
- **What's New shows only highlights written for the version you upgraded to,
  and stays closed when there are none.** Every upgrade showed the same
  launch-era list (bilingual support, new branding) under the new version
  number. Highlights are now kept per version; this release has none, so
  upgrading to it opens no panel.
- **Connect org in the welcome wizard no longer ends onboarding at step 1 of 5.** The button opened the org manager and marked onboarding complete, so the
  wizard never came back. It now closes the wizard for the session and leaves
  onboarding unfinished, so the wizard returns the next time the extension
  starts.
- **The Migration page no longer says nothing is written above a button that
  writes.** The subtitle said the file is only read and nothing is written or
  executed, on the page whose Run button writes the converted configuration's
  records to the target org. It now says importing changes nothing and running
  writes to the target org, in six languages.
- **A page that crashes no longer takes the panel's navigation down with it.**
  The only error boundary sat above the whole panel, so a render error in one
  page also unmounted the command palette and the keyboard shortcuts, leaving
  Recover as the only way out, and Recover remounted the whole panel on the
  module it was opened with. Each routed page now has its own boundary, keyed
  on the route: the palette, the G-key chords and the overlays stay up, and
  moving to another module renders that module.
- **The Welcome, What's New and Generate with AI dialogs keep keyboard focus and
  close on Escape.** They were marked modal, yet Tab walked out into the page
  behind them and Escape did nothing, and the Welcome and What's New overlays
  did not even take focus when they opened. Focus now moves into the dialog when
  it opens, Tab and Shift+Tab wrap inside it, Escape closes it, and on close
  focus goes back to the control that held it before, if there was one. Escape
  on the Welcome wizard skips it the way its Skip button does, so a ticked
  "Don't show again" is kept, and the Generate with AI dialog is named after its
  heading. The Compare diff dialog uses the same trap and no longer pulls focus
  back to its close button whenever its page re-renders. So does Monitor's
  health report dialog, which already kept Tab inside: it pulled focus back to
  its Close button whenever Monitor refreshed the figures behind it and lost
  focus when it closed, and now leaves focus where it is and gives it back to
  View Full Report on close.
- **Screen readers hear what a progress bar measures and how far a seed, sync or
  Forge run has got, and the side panel's unstarred favorite star can be seen.**
  The Welcome wizard's step bar, the Automation and Forge run bars, Seed's
  per-object bars, Compare's drift score, the Grappe progress panel and
  Monitor's KPI cards, limits, API usage, live operations and Apex insights were
  announced as a bare number, which axe rates as serious, and the bars on the
  Grappe page, the Frozen Dataset load and Autopilot's control panel were not
  progress bars to a screen reader at all. Each is now a progress bar with a
  name — the limit, category, operation, object, partition or log on its row,
  the title of its Monitor card, "Records Processed", "API Calls" and
  "Progress" on Autopilot's control panel, "Forge progress" or "Grappe
  progress" for a whole run, "Step progress" on the Welcome wizard, and
  "Progress" on an Automation run and a Frozen Dataset load — and gives its
  value as a percentage. A progress bar with a visible label takes that label as
  its name. Seed and Quick Seed, Sync, Forge and the Grappe panel on the
  Autopilot page also announce a running operation's progress, as in "Seed
  progress: 40%": the first at once, then at most once every five seconds with
  the latest figure, and the end without waiting. Inside Seed and Sync the
  Grappe panel stays quiet, since the page already announces the run. The
  unstarred favorite star sat at 40% opacity over the muted text colour, well
  under the contrast an icon control needs; it is now drawn at full strength in
  the description colour and brightens on hover.
- **The example pipelines can no longer delete what they did not clone.**
  `sandforge-cleanup --since today` selects every record the user created that
  day on the target, cloned or not, and its help, the CI README and the Forge
  guides called that "records you cloned". In the pipelines, turning off dry
  run for a real clone also made the next step delete for real. The pipeline
  cleanup is now always a preview, the guides preview first and limit the real
  delete with `--objects`, and in Jenkins the cleanup stage no longer runs
  when the clone was skipped, where it would have used a login left by an
  earlier build.
- **A failed GitLab or Azure example run is reported, and the Azure clone waits
  for the quality gates.** GitLab sent its failure message from the package
  job only; a notify job now runs when any job fails. The Azure clone stage's
  condition dropped the implicit `succeeded()`, so the clone reached the orgs
  after the quality gates had failed, and the example asked for a Slack
  webhook no step used. Every example now runs its org stages only when a
  record Id is configured, and the Jenkins header says that Id is a build
  parameter.

- **A sync configuration can be saved, and a schedule runs a saved one.** A
  schedule runs a stored configuration by id, and nothing in the product could
  store one: the builder offered a single made-up entry named _Default
  configuration_, so every schedule built on it named a configuration no run
  could load. The Sync review step now has a **Save** button, which keeps the
  configuration you have just read through under the two orgs it runs between.
  It is checked as a run started by hand is, so one asking to write target to
  source, for a mode other than full, or for manual conflict review is refused
  and nothing is stored. Saving again without leaving the page updates the
  entry it was saved under, while a changed configuration — other orgs,
  objects, mappings, transforms or strategy — is stored as a new entry, so a
  schedule keeps running what it was built on; the saved confirmation
  disappears as soon as what is on screen differs from what was saved. The
  schedule builder offers those saved configurations, each with the time it was
  saved, since two saves of the same pair of orgs carry the same name. Until
  one exists, New schedule and Edit are disabled and the tab says to save one
  first; editing a schedule whose configuration has since been deleted opens
  with none picked and cannot be saved until one is chosen, rather than moving
  the schedule onto another pair of orgs. A schedule naming a configuration
  that was never saved is refused. The tab itself listened to none of the
  answers it asked for: the list stayed empty behind its loading skeleton, a
  schedule created, paused or deleted did not change on screen, and a refused
  request looked like nothing at all. Those answers now reach it, and a
  refusal — including a list of saved configurations that could not be read,
  which is not the same as nothing having been saved — is shown at the top of
  the tab.
- **A scheduled sync says how its run ended.** Notify on completion and notify
  on failure only wrote a line to the SandForge output channel, so a schedule
  that fired while you were working said nothing on screen. Each now raises a
  notification in the SandForge panels open at the time; with none open, the
  output channel line and the schedule's last result remain. A run the sync
  engine reported as failed — a lost connection, a Bulk API failure, a run that
  was aborted — was announced as completed, because only an error thrown
  outright counted as a failure; it is now announced as a failure, with the
  first error the run reported. A run in which some records were refused is
  announced as completed with errors, with the first of them, instead of as a
  clean success. And a schedule whose configuration has since been deleted no
  longer falls due every 60 seconds in silence: it is recorded as a failure at
  each of its run times, its next run time moves on, and, with notify on
  failure on, the notification names the configuration that is missing.
- **Save as template keeps the seed you just ran, and a saved template opens
  again.** The button on the results step did nothing: nothing sent the
  configuration anywhere, so a set of objects, record counts and field rules
  worth keeping had to be rebuilt by hand next time. It now stores exactly what
  the run was given, under the objects it seeded and the day, as a new entry
  rather than over one already there; it stays disabled until a run has
  produced something and while a save is under way, confirms the save, and
  gives the reason when one is refused. In the gallery, Use this on a saved
  template asked for it under a key the extension does not read, so every saved
  template was refused and the click did nothing, with nothing opened and
  nothing said — and the answer, had it arrived, was passed on whole to the
  dialog that opens a template, which would have found no objects in it. A
  saved template now opens, one that has since been deleted says so, and a load
  the extension refuses gives its reason.
- **A missing Salesforce CLI now says where to get it, and the message stays up
  long enough to act on.** Two of the three working ways to connect an org run
  through the `sf` command line — importing the orgs it already holds, and
  OAuth web login — so a machine without it is left with username and password
  alone. The failure arrived as a toast that dismissed itself after five
  seconds and carried the install address as plain text nobody could click.
  That toast now stays until you dismiss it and carries an Install the CLI
  button that opens the Salesforce install page, and the connection error
  banner on the Organizations page, which is the only place the failure
  survives once the toast is gone, offers the same link. Buttons on a message
  the extension sends now arrive at all: the page dropped them on the way in,
  so any action such a message offered was rendered as nothing.
- **The AI key is added in Settings, and no message sends you to a command that
  does not exist.** A key that was missing or refused was answered with "Open
  Command Palette → SandForge: Configure AI Key", in all six languages, and the
  error raised when a custom Seed persona was asked for with AI off named the
  same command. No such command is contributed — the Settings page is the only
  place that stores a key — so the one instruction shown at the moment of
  failure led to an empty palette search. Both now point at Settings > AI > API
  key, and every sentence that sends a reader to the Command Palette is held to
  the commands the extension contributes. A request the provider refuses as
  invalid now says so and says it was not retried, where the banner used to
  show a generic AI error. The Help's AI section now states what a failed run
  sends: the built-in table of Salesforce error codes answers the codes it
  knows first and sends nothing, with AI on or off; SandForge's own refusals
  and any failure while no SandForge view is open send nothing; anything else
  goes with its Salesforce Ids replaced, comes back as a VS Code notification,
  and stops entirely with `sandforge.ai.errorResolution`.
- **A clone that could not read an object to the end says which objects were
  cut short.** Forge reads each source object page by page and stops at 50 000
  records or 500 pages. A run that reached either bound finished as an
  unqualified success: the counts on the results screen were the rows it had
  written, and the only trace of the rows it never read was a line in the
  SandForge output channel. The run result now carries the objects whose read
  stopped on a bound, and the results screen names them and says to split the
  run into filtered runs that each stay under it. A run that read every object
  whole shows nothing extra.
- **A frozen dataset says when the salt in the environment is not the one it
  was built with.** Pseudonyms are keyed by the salt in
  `SANDFORGE_FROZEN_SALT`, and the page showed that salt's fingerprint beside
  the dataset without ever comparing the two. Extracting again under a
  different salt gives the same records different pseudonyms from the ones the
  stored dataset holds, and nothing fails while it happens. The page now
  compares the two fingerprints and, when they differ, shows both, says a new
  extraction would not match the dataset it sits next to, and asks for the
  original salt to be set back first. A load is unaffected — it replays the
  files as they are and never reads the salt — and the warning speaks of the
  next extraction only.
- **Active Sessions name the user, and an org with no refresh history to read
  says so.** The column headed Username showed the user's 18-character record
  id, because the query read no name; it now shows the login name and falls
  back to the id only when a session carries none. Rows were also identified by
  the user rather than by the session, so two sessions held by one user shared
  a single row identity; every session now has its own row. Sandbox Refreshes
  answered "No sandbox refresh events" on an org that cannot be asked the
  question at all — only an org that manages sandboxes keeps that history, so
  on a sandbox the empty state read as an answer about the org. It now says the
  org keeps no refresh history to read, and the Monitor guide says the same.
- **Compare's permission and drift tabs are named for what they read.** The tab
  called Permission Matrix promised a grid of CRUD and field-level permissions
  across profiles and permission sets; what it reads is permission set and
  profile names, split into source only, target only and both, and no object or
  field permission is read anywhere behind it. It is now called Permission
  Presence, and the guide answers "which permission sets and profiles is this
  org missing?" instead of "who can see what". The tab called Drift Dashboard
  promised automated detection with drift metrics and categories; what it reads
  is five fields of the Organization record from each org when you open it —
  name, language, default locale, time zone and the month the fiscal year
  starts — one query per org, with nothing running on a schedule and nothing
  kept between runs, and it lists the settings that match as well as those that
  differ. It is now called Org Settings Drift, and the Compare guide is held to
  what the two tabs read.
- **The Marketplace listing and the Command Palette say what SandForge does.**
  The store description, in all six languages, sold "automate pipelines, with
  streaming execution for large datasets". No pipeline step touches an org —
  Delay waits, Condition reads the run's variables, and the other thirteen
  report success without running — and Seed and Sync write their batches one
  after another. Each language now says that pipelines are drafted and started
  by hand, and that no pipeline step acts on your org yet. The listing was also
  filed under Visualization, which brought browsers it disappoints; it is filed
  under Other and Testing. In the Command Palette, "SandForge: Open Grappe"
  named a view without saying what it shows and now reads "Open Grappe
  (partition progress)", and "SandForge: Cheers!" — an easter egg that shows a
  mojito, not a feature — is no longer listed there.
- **Forge's ID remapping is described with the one case it does not cover.**
  "Every ID is remapped automatically" was on the Marketplace page, in both
  READMEs, in the getting started guide and the Forge quick start, in the Forge
  walkthrough and — in six languages — on the in-app Help page and the Forge
  page's empty state. A record type is the exception: one with no active record
  type of the same API name on the target keeps its source Id, and the SandForge
  log names it. All of those surfaces now carry the exception beside the claim,
  each in the language it is read in.
- **Both ways to connect your first org say they need the Salesforce CLI.** The
  first step of the Get Started walkthrough offered Import from SF CLI or OAuth
  (Web), so a reader with no CLI took the second — and the browser login is run
  by the CLI too, so it refused for want of `sf` on PATH, on the one screen
  written to get them started. The step and the page behind it now state, in six
  languages, that both paths need the Salesforce CLI installed and on your PATH,
  and link to where to get it.
- **The README tables and the FAQ describe the extension that ships.** The
  Compare row of both READMEs sold a "permission matrix" and "drift detection":
  the Permissions tab lists which permission sets and profiles exist on each
  side, with no object or field permission behind them, and Drift reads five
  Organization settings — name, language, locale, time zone and fiscal year
  start. Both rows say that now. The two Settings tables had drifted from each
  other and from the extension: startup org validation was listed in one README
  only and the three Grappe settings in neither, so a reader who opened the
  Settings editor met rows nothing had told them about. Each table now lists
  exactly the settings SandForge declares, with the default it ships, and the
  two agree. The AI Assistant row still said a saved chat could be reread but
  not continued once VS Code restarts; it can be continued, the page shows it
  whole and the model is given its last 20 messages, and the row now also says
  that a failed run's message travels with its Ids replaced, that the suggestion
  arrives as a VS Code notification, and which setting stops the sending. The
  FAQ promised "30+" locale-aware Faker generators where Seed has 30, and
  described OpenAI and custom providers "listed in settings" that the settings
  do not offer; its answer on what leaves your machine now names that setting
  too, and adds the bare "Pipeline failed" a pipeline ends on to the failures
  that are never sent.
- **A pipeline run reaches the History tab.** Nothing ever wrote a finished run
  to the store that tab reads, so History said "No execution history" in every
  install and the History Runs count stayed at zero, however many pipelines had
  been run. A run that completes or fails is now recorded when it ends, with its
  status, what triggered it, its start time, its duration, how many steps ran
  and how many of them failed, and the tab asks for the history again as soon as
  a run answers, so a run started since the page was opened shows up without
  reopening it. The log keeps the 50 most recent runs and drops the oldest as
  new ones arrive; a run cut off by the pipeline timeout still leaves nothing
  behind. The pipeline as it stood when the run started is kept beside the entry
  in extension storage, where a later replay could read it, and is not sent to
  the page, since a pipeline variable can carry a secret default value.
- **The production confirmation names every object a run writes to, and stops
  giving a record count nobody has measured.** Before any write to a production
  org, SandForge shows a dialog summing the operation up, and that same summary
  is the reason a blocked run reports. A clone named only the first of its
  objects, and a masking run named no object at all but "AnonymizeData"; both
  announced exactly 1 record, and a sync announced 0, when the records are only
  read once the run has started and nothing had counted them. The summary now
  lists every object of a clone, and every object a masking run addresses —
  those its template covers when the request names none — and says the number of
  records is not known yet rather than inventing one. A count that has been
  measured, zero included, is still shown as the number it is, and which runs
  ask for a confirmation or an approval is unchanged.
- **Frozen Dataset no longer blocks the extension while it reads and writes its
  files.** Its selection, query tokens, pseudonymization rules, manifest,
  per-object record files and reference mapping were each read and written in
  one blocking call, so a selection, an extraction, a load, a verification, and
  even the status the page asks for when it opens, left SandForge unable to
  answer anything else until the disk had finished: progress stopped moving and
  every other request queued behind it, the longer the bigger the dataset.
  Those reads and writes no longer hold the extension, apart from the two small
  records stamped at the end of a run — the counting contract a load leaves
  behind, and the verdict a verification writes onto the manifest — which are
  still written in one call. The record files are also written one line each,
  as only the loader ever reads them back, so they are smaller and quicker to
  write; the manifest, which is meant to be read, keeps its indentation.
- **A frozen dataset reload no longer counts a mapping it cannot look at as a
  first load.** Each load writes down which record of the dataset became which
  Id in the target org, and a reload reads that file back to clear what the
  previous run wrote before writing again. Whether the file was there at all
  was settled by a check that answers "not there" for anything it cannot look
  at — a folder on the way to it that cannot be opened, for instance — and "not
  there" was read as nothing having been loaded yet: the reload cleared nothing
  and wrote a second copy of records that were already in the target org. The
  file is now read directly, so only a file that is genuinely absent counts as
  a first load, and any other failure stops the run and reports what happened.
- **The jobs list shows how long ago a job started, and can be sorted on it.**
  Monitor's jobs table dated every job with a short date and time and always
  listed the newest first, so seeing whether a job had just started meant
  reading timestamps, and the oldest could not be brought to the top. A job
  created within the last day now shows how long ago it started, in the
  interface language, with the exact date and time on hover; an older job keeps
  the exact date and time, which reads better than a count of hours. The
  _Created_ heading is a button, reachable from the keyboard, that flips every
  expanded class group between newest and oldest first. Those rows also name
  their columns now, so a screen reader reads each value with its heading and
  hears which way the list is sorted.
- **A jobs list still being read no longer says the org has none.** While the
  dashboard re-read an org whose last read had found no jobs, the jobs table
  showed "No recent jobs" — a statement about the org, made before the org had
  answered. It now shows placeholder rows, marked as busy for screen readers,
  until the answer arrives; a list that already holds jobs keeps showing them
  while it is read again.

- **Bulk API jobs count against one limit, whichever run opened them.**
  SandForge caps how many Bulk API 2.0 jobs it keeps open at once, but each run
  built a counter of its own, so the cap held for one run at a time: a seed, a
  CSV import, a clone started from Seed, a frozen dataset load and a sync
  writing at the same time each had a full budget, and the sync's came from _Maximum concurrent
  sync operations_, a setting that caps how many scheduled runs overlap, not
  the jobs inside one. Those five write paths now share one counter, one
  cap of five for the whole window, and a job that would push past it is
  refused instead of opened — the write it belonged to stops with an error. A job that dies partway — a
  connection dropped mid-upload — releases its slot instead of holding it for
  the rest of the window, and two jobs opened in the same millisecond are
  tracked as two rather than the second taking the first's place and freeing a
  slot still in use.
- **A clone matches reference data however many rows the object holds.**
  Business Hours and Operating Hours are not cloned: Forge looks each source row
  up on the target by name and points the records that use it at the row already
  there. The whole list of names travelled in one query, and past a few hundred
  rows that query outgrew the request URI Salesforce accepts, so the org refused
  it outright. The object was then reported as failed and the run carried on,
  with every record whose lookup pointed at one of those rows going out under
  the source org's Id — an Id the target does not have. The names are now split
  across as many queries as fit, at most 500 to a query, and the answers are
  merged: the run resolves exactly the rows the single query was meant to.
- **Forge runs and DataOps backups join the runs a window close stops, and
  end recorded as what they were.** None of the three was tracked as a
  background run, so a window close, a reload or an extension update left a
  clone walking the source org and writing to the target with nothing left to
  report what it had done. They now take the same shutdown stop the syncs and
  seeds already took. A backup stops between two objects: nothing reaches
  storage until every object has been read, so a stopped backup leaves no
  half-saved snapshot and has to be run again for a complete one. A restore is
  deliberately not stopped: cut in the middle it would leave the org with some
  records put back and some not, and nothing records where it stopped. Each run
  also ends recorded as what it was — a clone that finished in failure, or that
  you stopped with Abort, is never recorded as completed — so when no SandForge
  panel is open the native notification reports a failure as a failure and says
  nothing at all about a run you stopped yourself. Live Operations still lists
  Seed and Sync runs only.

- **Text reaches readable contrast on seven of VS Code's themes, its default
  Light 2026 and Dark 2026 among them.** Much of the panel's text was written in
  colours no theme picks for reading. Secondary text — timestamps, usernames,
  counts, hints, empty states, chart axes — used VS Code's colour for disabled
  controls, 1.92:1 on Light 2026's editor background and 2.50:1 on Dark 2026's;
  it now uses the description colour VS Code gives its own secondary text, or
  the editor text colour where it sits on a tint, and text keeps the disabled
  colour only on controls that are disabled. Severity and accent text often used
  fixed shades picked for a dark editor — red read 2.77:1 on a white one, yellow
  1.53:1 — or VS Code's severity colours, most of them made for icons and
  squiggles rather than text. Severity text now mixes the theme's own severity
  colour, and accent text its old shade, with the theme's text colour in a share
  that reads on each of the seven themes named below, on the tinted badges, rows
  and banners under them too. Text faded to part strength is drawn in full:
  upcoming wizard steps, toast messages and the Automation scheduler preview. An
  object you leave out of a Forge clone gets a dashed outline on the graph
  instead, and a suggested Quick Sync object that cannot be added is struck
  through. Labels written in white on a coloured fill, 2.46:1 on the danger
  button under Dark+, now take the editor background colour, so on a dark theme
  the danger and Forge buttons and the org type badges carry dark text.
  Placeholders without a colour of their own take the theme's placeholder colour
  instead of a grey no theme picked, 2.54:1 on a white input. The bar is 4.5:1
  for text against everything drawn under it on Light 2026, Dark 2026, Light
  Modern, Dark Modern, Light+, Dark+ and Quiet Light. Text in a colour pair the
  theme itself draws below that — its placeholders, its secondary text on
  Light+'s side bar and cards and throughout Quiet Light, and Quiet Light's
  badges and selected items — is held to the theme's own contrast instead.
  Solarized Light, whose own text reads 3.64:1 on its side bar, is held to no
  bar, and the other themes VS Code bundles, the high contrast ones included,
  are not measured. Every change is checked against the bar: in the colours the
  code writes under all seven themes, in the browser on fifteen pages and ten
  further states under the first four, and on eight more states under all
  seven.
- **Spinners, pulses and hover effects hold still when your system asks for
  reduced motion, and the org pickers show status by shape as well as colour.**
  With reduced motion turned on in the operating system, spinners, the pulsing
  blocks shown while a page loads, the Monitor alert ping, the moving dashes on
  graph edges and hover and colour transitions kept moving; they now stand
  still. Wizard steps, cards and dialogs still fade in, and Monitor's health
  gauge still fills to its score. The org pickers in Forge and on Frozen
  Dataset's Load tab told an org's status only by the colour of a dot. The dot
  is now a filled circle when the org is connected, a ring while it refreshes
  and a diamond when its session has expired or its connection failed, and
  screen readers hear the status as well: the picker names the selected org
  with its status, and each org in the list says its own. The buttons that fold
  Monitor's sections away, which had no name, are now named after their section
  and say whether it is open.
- **Spanish and Brazilian Portuguese have their accents back.** Some of the text
  in SandForge's panels and side panel had been written without them: the side
  panel listed "Automatizacion", an expired org's card read "Sesion expirada" or
  "Sessao expirada", the Username / Password form asked for a "Contrasena", and
  the Welcome wizard offered "Nao mostrar novamente". In all, 135 Spanish and
  176 Brazilian Portuguese strings are corrected, so these now read
  "Automatización", "Sesión expirada", "Sessão expirada", "Contraseña" and "Não
  mostrar novamente". The Spanish questions and exclamations that lacked their
  opening mark have it too: Help's FAQ asks "¿Por qué mi Puntaje de Salud es
  bajo?", and Home's Getting Started card, shown while no org is connected,
  opens with "¡Bienvenido a SandForge!". Seed's getting-started card now asks
  you to "pueble su sandbox", where it said "poble". Command titles, settings
  and the messages SandForge shows through VS Code already had their accents in
  both languages, and French, German and Japanese were not affected. A Spanish
  word ending in -ción or -sión, a Portuguese one ending in -ção or -são, or one
  of a short list of common words such as página, también, não or você, written
  without its accent, now fails the checks run on every change.

### Changed

- **Only Anthropic can be picked as the AI provider.** The provider setting
  offered OpenAI and Custom, which fail on every call, and AI still reported
  itself available with either selected. The setting now offers Anthropic
  alone, and a `settings.json` that names another provider leaves AI off and
  sends nothing.
- **A failed run's fix suggestion comes from the built-in table even with AI
  off, and appears once, as a VS Code notification.** The table of common
  Salesforce error codes needs no model and no key, but it was consulted only
  once AI was on and an Anthropic key was stored, so users without a key got no
  hint. While a SandForge panel or sidebar view is open, it now answers a failed
  Seed, Sync, DataOps or Automation run whether AI is on or off, and only what
  it cannot answer goes to the model, while AI is on. It covers every code the
  retry classifier knows: `REQUEST_RUNNING_TOO_LONG`, `SERVER_UNAVAILABLE`,
  `INVALID_FIELD` and `INSUFFICIENT_ACCESS_OR_READONLY` had no entry. The
  suggestion used to be posted to every open panel, each of which showed it,
  and a suggestion from the table was always in English. It is now a single VS
  Code notification, and a suggestion from the table follows VS Code's display
  language: every code it knows is translated into French, German, Spanish,
  Japanese and Brazilian Portuguese. With no SandForge view open nothing is
  asked, so a scheduled sync failing with every panel closed no longer costs a
  model call for a suggestion nobody sees.
- **Production orgs are listed first.** The Organizations page showed orgs in
  the order they were added; it now orders them by type, production first,
  then by whether the org is usable, then by alias.
- **A scheduled sync is tracked like a manual one.** It appears among
  background operations, can be cancelled from Live Operations, and when no
  SandForge panel is open it gets the same completion or failure notification
  as a sync started by hand.
- **Vlocity package objects are left out of a clone.** Objects in the
  `vlocity_*` namespaces attach dozens of configuration records to standard
  objects through reverse lookups, so following them from a single Case or
  Account pulled the package's catalogue into a dev sandbox.
- **`sandforge-cleanup` no longer sweeps insurance objects by default.**
  InsurancePolicy and InsurancePolicyCoverage exist only in orgs with that data
  model, and there the default sweep deleted policies created by hand that
  day. Name them in `--objects` when a clone wrote them.
- **A large seed no longer posts every created Id to the page.** A
  50,000-record run serialised 50,000 Ids into one message for a results step
  that shows counts. At most 1,000 Ids and 1,000 errors per object now reach
  the page; the counts stay complete and a flag marks the cut.
- **Seed has no dry run, and a request for one is refused.** A seed request with
  `dryRun` returned an empty success before generating anything: nothing was
  written, but nothing was previewed either, and the answer read like a preview
  that had passed. Such a request is now refused with an explicit error before
  the org is touched.
- **The Monitor and Forge wait on fewer round trips.** A Monitor refresh ran the
  limits call and the job query one after the other, and parsed the stored trend
  history once per limit; the two calls now run together and the history is read
  once. Forge describes the target object while the source records download
  instead of after, and describes each object once per org: discovery cached its
  describes, but the source fields, whether the target accepts inserts, the
  target fields and the drift check each sent their own, so one run described
  the same object three times or more per org. They now share one describe per
  org and object, kept five minutes like discovery's, and a caller that arrives
  while it is under way waits for it instead of sending another. A field added
  on the target within those five minutes is seen once they have passed. The
  check that the target accepts inserts on an object has also left the run loop,
  where each answer was awaited before the next object was written: the checks
  now go out ahead of the loop, six at a time — the ceiling graph discovery
  already uses to stay inside the connection pool and the org's per-IP limit,
  now one constant both read — and the run reads the answers as it goes. Abort
  stops them at the end of the wave in flight. What happens with an answer is
  unchanged: an object the target refuses is skipped and reported, and a check
  that fails is surfaced as a per-object error while the object is still
  attempted.
- **The AI tab on the Forge page is marked coming soon and cannot be opened.**
  It took a prompt and enabled Discover, then discovery stopped with "Cannot
  resolve root object": nothing turns a prompt into a Forge run. The tab is now
  disabled with a Coming soon badge, the empty-input hint no longer asks for a
  prompt, and a past AI run reopened from the history opens on the record tab.
- **Automation stops promising triggers, a scheduler release and sync modes it
  does not have.** Nothing starts a pipeline except a manual run, yet the
  scheduler badge promised v1.2 and the Triggers tab offered Schedule, Event,
  Webhook, Sandbox Refresh and Deployment Complete as if they fired. The badge
  now says coming soon without naming a release, every trigger card except
  Manual carries a coming-soon badge, the panel says that only a manual run
  starts a pipeline, and the Automation guide lists the trigger types the panel
  offers and names no release. Two marketplace templates promised a dry-run sync
  and an incremental sync that the sync step does not perform: they are now
  named Data Migration Check and Checked Sync, no longer carry the dry-run,
  incremental or delta tags, and their sync step says pipelines do not transfer
  records yet.
- **Every AI draft reads the model's reply the same way.** NL2SOQL drafts,
  pipeline drafts and suggestions, custom Seed personas, AI-generated Seed
  records and a failed run's fix suggestion each handled a fenced reply their
  own way, or not at all, and cast its fields one by one. They now share one
  schema-checked reader, so pipeline suggestions are read from inside a fence
  too, and a NL2SOQL or custom-persona reply that is not JSON shows the same
  message as a reply of the wrong shape instead of a raw JSON syntax error. A
  fix suggestion the model writes as prose rather than JSON is recorded the same
  way, in place of the parser's own error.
- **An idle window no longer calls Salesforce every 30 seconds.** The
  connectivity probe sent a request to login.salesforce.com every 30 seconds
  from every open window, whether or not anything waited in the offline queue.
  It now repeats only while an operation is queued or the last check found the
  network down. An operation queued while the network was last seen up gets one
  check straight away: if the network turns out to be down, the operation stays
  queued and is replayed when the network comes back, instead of being retried
  at once and failing. A burst of operations queued in the same moment shares
  that one check instead of sending a probe request each, and the sharing is
  dropped after 10 seconds, so a probe that hangs costs one check rather than
  every check for the rest of the session.
- **Telemetry log records are readable in the SandForge output channel.** They
  reached the channel as raw JSON lines. They are now written as `[time] [LEVEL]
message`, followed by their extra fields, in the same layout as the channel's
  other lines; a line that is not such a record is written unchanged.
- **The telemetry setting says what it does: record errors locally, send
  nothing.** The setting in six languages and both READMEs called it anonymous
  usage telemetry, but it only feeds a local log with no network transport. The
  Settings counter read "Events sent" beside a "Buffer size" row fixed at 0; it
  now reads "Diagnostic events recorded", and the buffer row is gone. A docs
  check ties the wording to what that logger imports.
- **The CI examples and contributor guide take pnpm from the repository's
  pin.** Every example pipeline hardcoded pnpm 11 while the repository's own
  workflows read `packageManager`; CONTRIBUTING.md and the pnpm ADR cited a
  release two bumps old, and the Jenkins header asked for a Node 20 tool.
- **The Sync help and guide describe the rules and strategies that run.** The
  help panel promised "13 transform types" and "conflict resolution
  strategies" in six languages, and the module page sold five conflict
  strategies including a manual merge and called transforms "configurable
  per-field or per-object". Both now say that a transform rule applies to every
  field of every record of the run, `Id` and the external ID it matches on
  excepted, and that a value mapping rule added on the page has no table to
  fill, so it leaves every value as it is. A value mapping rule imported from
  an SFDMU `export.json` carries its own table and does replace values. The
  help panel also says which rules take no setting, which takes a length and
  which take text. The guide gives what a formula rule really does — it
  substitutes the field value into the token `VALUE` and evaluates the
  arithmetic — in place of a conditional rule that does not exist, notes that
  per-mapping rules exist in the configuration format but no screen sets them,
  and names the four strategies a bidirectional run reads with what each does
  to a conflicting record, including that newest wins keeps the target record
  only when both sides carry a readable last-modified date and the target's is
  the later one.
- **The guides describe what ships.** The Seed guide no longer describes a
  relationship editor: a lookup receives records its target object created
  earlier in the run, so that object has to be part of it, while an optional
  lookup to an object outside the run is left out of the run and a required one
  refuses it. The guide also gives the rule a described field opens on, and says
  a generated value longer than the field is cut to it. The Forge quickstart and
  example recipes no longer offer an upsert mode the wizard does not have — only
  the command line's `--upsert` — and say the command line is two scripts run
  with `pnpm exec tsx` from a checkout, after `pnpm install` and `pnpm
build:shared`, not an installed CLI; the two scripts' own headers and `--help`
  say the same, in place of the `sandforge-clone` and `sandforge-cleanup`
  commands they used to name, which no install provides, and the quickstart
  lists the flags each script exits 2 on. The record-scoped clone guide says its
  reduction figure came from one dry run on one dataset, and describes how large
  scopes are read. The Monitor guide gains a section for each of the nine panels
  it did not mention, and states their current limits: Apex insights estimates
  from log size, and the Username column shows a user Id. It says where the
  health check's failed-job and error-log counts are read from, and which
  built-in governance rules the org gives no reading for. It also says background
  operations do not survive a reload: after a window reload or an extension host
  restart, Live Operations no longer shows a run that was in progress and cannot
  cancel it. The Frozen Dataset guide no longer gives Production Guard an audit
  trail: with `sandforge.safety.auditLogging` on, the guard keeps its
  safety-check decisions in memory for the session only.

- **The AI token budget is 200,000 tokens by default, and a command starts it
  over without a reload.** The previous default of 50,000 tokens lasted roughly
  a dozen exchanges with the assistant, since each message sends the recent
  conversation again, and going on meant raising the limit or reloading the
  window. Unless you set `sandforge.ai.tokenBudgetMaxPerSession` yourself, the
  limit is now 200,000. "SandForge: Reset AI Token Budget", in the Command
  Palette, brings this window's count back to zero and keeps the limit: a
  notice says how many tokens are available, the gauge on the AI page follows,
  and the 80% and refusal notices come again once the count climbs back. The
  notice shown when requests start being refused offers Reset Budget next to
  Open Settings; the 80% notice, while nothing is refused yet, does not. The
  reason a refused request gives in the assistant's chat names the command
  instead of a reload. It was always in English; it now follows VS Code's
  display language in French, German, Spanish, Japanese and Brazilian
  Portuguese, and names the command as the Command Palette shows it there.

### Removed

- **The Sync page no longer shows a Real-Time tab or a Conflicts tab.** Every
  real-time channel is answered by a handler that does nothing, so the
  Real-Time tab could only end at an error badge, and the Conflicts tab could
  only list conflicts that stream never delivers.
- **The bridge no longer routes requests no screen sends.** `compare:start`,
  `dataops:backup` and `pipeline:run`, aliases of `compare:execute`,
  `backup:execute` and `pipeline:execute`, are gone, and so are `monitor:start`,
  `monitor:health-score`, `execution:status`, `execution:list`,
  `execution:manual-retry`, `dataops:masking-templates-by-object`,
  `governance:policy:get`, `governance:policies:export`,
  `governance:policies:import` and `forge:target-preflight:request`, with their
  protocol declarations, the handler code, payload schemas and replies only they
  used, the per-object masking template service, and the governance policy
  store's export and import. The message envelope now refuses them. Nothing in
  the product could send them, yet they read as live features to anyone reading
  the protocol. `operation:cancel`, `operation:pause` and `operation:resume` go
  the same way: once Live Operations' Cancel moved to `execution:abort`, nothing
  sent them, and the runs they could reach — pipeline runs — were never the ones
  it listed. Stopping a run still goes through Cancel in Live Operations and
  Cancel run on the Seed page, which abort the run itself.
  `cache:invalidate-all` and `cache:get-stats` go too, with the cache manager
  behind them and its 60-second sweep, which ran for the life of the window
  over caches that were never registered with it; the Settings section that
  spoke to them was removed long ago. So do `hint:dismiss` and
  `onboarding:reset`, with the record of dismissed hints, since no screen
  dismisses a hint or restarts the welcome flow, and
  `ai:resolve-error:response`, a reply the extension never posted: the
  suggestion for a failed run is shown once, where the failure is raised, as a
  VS Code notification. `connectivity:status` is the one of these that was
  sent — every panel asked for it on opening and displayed nothing, the
  online/offline banner it fed being gone — so opening a SandForge panel now
  makes one round trip fewer.
- **A sync validation path nothing could reach.** The sync writer accepted an
  optional list of target field descriptors and, when given one, refused a
  whole batch before any write — but nothing ever passed one, and a single
  descriptor list held against every object of a run would have refused valid
  updates, and partial mappings over required fields and picklists. It is gone.
  The field-type comparison both orgs go through before a run catches the type
  mismatch it was added for, and Salesforce still reports a value too long for
  its field or a required field left empty.

### Security

- **Login credentials only go to Salesforce.** Username/password login sent
  the username, password and security token to any `https:` host the connect
  request named. The login URL is now checked against the Salesforce login
  hosts — `login.salesforce.com`, `test.salesforce.com`, My Domain, and any
  `*.force.com` or `*.cloudforce.com` host — and anything else is refused with
  `INVALID_LOGIN_URL` before a credential leaves the extension. Browser login
  goes through the same check before the Salesforce CLI starts. Logging in
  through a host outside these domains — a legacy instance host such as
  `na1.salesforce.com`, or a government or regional cloud domain — is now
  refused too, and no setting allows one yet. The refusal names the way in —
  authenticate with `sf org login web --instance-url <url>`, then add the org
  with SFDX Import, which applies no host restriction — and Getting Started
  documents both the accepted hosts and that two-step path.
- **Only a host reaches the Windows shell during browser login.** On Windows,
  `sf org login web` runs as a shell command, and only the login URL's
  hostname was checked: its path went into the command line unescaped, so a
  path like `/"&calc&"` reached cmd.exe. The URL is reduced to
  `https://<host>` before either the Windows or the POSIX command is built,
  and a URL carrying a path, query, fragment, credentials or port is refused.
- **A sync configuration stores what SandForge understands and nothing else.**
  Saving or running a configuration, or saving a schedule, kept every key the
  page sent, and those keys were saved, snapshotted into history and replayed
  on reruns. Unknown keys are now dropped at the boundary. An upsert key must be
  a single field name: a phrase or an SFDMU composite key such as
  `Name;Parent.Name` used to reach the upsert job as-is. An empty External ID
  box still counts as no key.
- **An object name read from a describe is checked before a request is built
  with it.** When Forge fetched a missing parent record, the parent's object
  name went into two describe request paths before it was validated. It is
  now validated first, and a malformed name sends nothing.
- **Refusals SandForge writes itself no longer reach the model.** While AI was
  on, a run failing on any of these cost a model call: a declined production
  confirmation, a duplicate run, the per-org backup and rollback lock, a CRUD or
  FLS refusal, a Production Guard block, a missing backup or one taken from
  another org, an org that is not found or has no stored credentials, a
  malformed CLI username, and a pipeline that failed without an error of its
  own. Several of those messages carry an org Id. None of them is sent now.
  Other errors SandForge raises, such as a failed connection or a validation
  error, still are.
- **Fake personas and format-preserving values are keyed with the anonymizer's
  salt.** The persona picked for a record, the placeholder for a field no
  persona maps and the output of `preserve_format` all came from an unkeyed
  hash of the record Id or of the original value. A record got the same fake
  identity in every installation, and a phone number or national Id run through
  `preserve_format` could be confirmed by trying candidates. They are now drawn
  from HMAC-SHA256 under the same key that already covers `hash` and `shuffle`.
  No template DataOps ships carries a salt, so masking there runs under a key
  the window draws when it starts and never writes down: a record keeps the
  same fake name, email, phone and address, and the same shuffled values,
  across every masking run of that window, and is given others in the next one.
- **A webview can load files from the webview bundle only.** Panels and the
  sidebar used the whole extension folder as their resource root, so a webview
  could request any packaged file, compiled extension code included. The root is
  now `webview-dist`, and SECURITY.md says why styles still allow
  `'unsafe-inline'`: the dialog scroll lock inserts a `<style>` element at
  runtime, and three components render `<style>` blocks.
- **The CI examples no longer leave Salesforce auth URLs on the build
  machine.** All four pipelines wrote both auth URLs to fixed files under /tmp
  at the default umask and removed them a line later; in Jenkins these were
  separate shell steps, so a failed login stopped the build before the removal,
  on a machine that keeps /tmp between builds. The URLs now go to a private
  directory created under `umask 077`, removed by a trap when the shell exits,
  failed login included, and Jenkins logs its CI aliases out after every build.
- **The release job runs only code that cannot change under it.** Every action
  in every workflow was referenced by a tag, which whoever controls the action
  can move — in the release job, that included the pnpm setup whose binary
  publishes with the Marketplace token in its environment, and a third-party
  release action holding a token that can push. Every action is now pinned to a
  commit with its version beside it, the GitHub release is created with `gh`,
  and a check fails on any tag.
- **A manual Stryker run no longer pastes its glob into a shell.** The optional
  mutate glob was substituted into the script before bash parsed it, so a glob
  containing a quote ran as shell code. It now reaches the script as a quoted
  variable, and a check fails when any workflow interpolates a free-text input
  into a `run:` step or a github-script `script:`.

- **A failed run's error message loses its Salesforce Ids before it reaches the
  model, and that sending can be turned off on its own.** A failed Seed, Sync,
  DataOps or Automation run asks the model for a fix suggestion with nobody
  pressing anything, and Salesforce quotes record and org Ids back in the
  messages it writes. Only the failures SandForge writes itself were held back:
  any other message went out as written, Ids and all, so `Secret storage did not
answer within 10000 ms for org "00D…"` reached the model with the org in it.
  Every 15- or 18-character Id in a message is now replaced by `<id>` first,
  including one joined to a name by an underscore, while a custom field API name
  that happens to hold a run of that length is left as it is. The sending also
  has a setting of its own, `sandforge.ai.errorResolution`, on by default: off,
  no failure is sent at all, the built-in table of common Salesforce error codes
  still answers on your machine while a SandForge view is open, and chat,
  NL2SOQL, pipeline drafts and Seed's AI field rules keep working. The
  suggestion is now asked for in the editor's display language, so the
  notification arrives in the language VS Code is running in.
- **Every change is scanned for credentials left in the history.** The source
  and its history are public, so a key committed by mistake and removed an hour
  later is still a key anyone can read back out of it, and nothing had ever
  looked for one. All the commits on a branch are now scanned, not just the
  files as they stand, by a scanner pinned to a fixed version and checked
  against the digest written down with it. A finding names the file and the
  line while keeping the value itself out of the build log, and it fails the
  run — which in turn refuses a release, since a release requires a green run.
  Build output, installed packages, generated reports and the lockfile are the
  only places the scan skips.

### Build

- **The packaged extension is started, in a real VS Code, on every push.**
  Every test so far ran against a mocked `vscode` module, so nothing proved the
  extension activates at all: a broken activation event, or a command the
  manifest contributes and no code registers, would have reached the
  Marketplace on a green run. A smoke suite now downloads a real VS Code, loads
  the built extension into it, waits for activation, checks that every
  contributed command is registered and opens the panel through each of its
  three entry commands. It runs as its own blocking workflow under `xvfb-run`,
  and never inside `pnpm validate` — which would download VS Code on every
  local run — with a repository gate holding that split in place.
- **Accessibility rules run over every webview component.** ESLint checked
  React and TypeScript but knew nothing about accessible markup, so a clickable
  `div` with no keyboard handler, a control with no accessible name and a
  `<label>` bound to nothing all passed review. The recommended
  `eslint-plugin-jsx-a11y` set now runs over the webview as warnings — 86 of
  them today, listed by rule and explained in CONTRIBUTING.md — so the count is
  visible and can only be worked down.
- **The Stryker summary shows Stryker's score.** The job summary computed its
  own: Ignored mutants counted as survivors and uncovered ones were left out,
  so the same run page said 79.15% in the log and 46.95% in the summary, next
  to a break threshold copied by hand. It now uses Stryker's formula, reads the
  threshold from the config the run enforced, and fails the step when it
  cannot read the report instead of leaving an empty summary on a green run.
- **Mutation testing covers the extension's execution engine and runs when the
  code it mutates changes.** It used to mutate seven files of the shared
  package once a night, and fail only below 54 against a real score of 79. It
  now also mutates the Bulk, retry and timeout engine, runs on every push and
  pull request that touches the mutated code, its test setup, its runner
  config or the lockfile, and each config fails no more than five points under
  its measured score. The extension's test config resolves its paths from its
  own folder: started from the repository root, as Stryker starts it, it found
  no test at all.
- **CI runs on current action versions and stops runs nobody will read.** The
  actions ran on the retired Node 20 runtime; they now run on Node 24, and
  Dependabot proposes new pins. CI, Knip, Format Check and Stryker cancel a
  pull-request run that a newer push replaces, while master pushes, the nightly
  and manual runs never share a group, so each master commit keeps its own
  result. Format Check loses a PR comment step that could never post.
- **The security policy names the release that is out.** SECURITY.md promised
  fixes for 1.21.x after 1.22.0 shipped, and listed a development script as a
  CLI in scope. Its supported-versions table is now written from package.json
  when the extension is packaged, and the pre-publish check fails when it
  drifts.
- **The claims check reads the Help page, and fails when the code changes
  under it.** Each false Help claim above is a rule over the Help text of the
  six languages, tied to the code that makes it false: nothing reads
  `enableRollback`, the manifest has no API-timeout setting, no channel deploys
  a diff, the scheduler does nothing, a run's history entry keeps no step
  results, three DataOps tabs are mounted as coming soon, and nothing listens
  for Ctrl+Enter. Build any of those features and its anchor fails first.
- **The claims check reads the wording and code it used to skip.** The CDC rule
  read only the Help page's sync text; it now reads every README, guide,
  setting, notification and webview fallback, and a disclaimer counts only in
  the sentence, clause or list item that names CDC. The Grappe rules also
  refuse, in a sentence about Grappe, the ordinary phrases for concurrency in
  the six languages ("at once", "à la fois", "auf einmal", 一度に and others), and
  anchors pin Sync's per-object loop, its threshold check, and the single id
  under which Sync and Autopilot open and close a Grappe run. A new rule refuses
  "audit trail" next to Production Guard in six languages. The automatic error
  resolution anchor refuses a `resolveError` call behind a condition that reads
  anything but the resolver: around the call, in the expression it is made on,
  or in any value given to the name that expression starts from. Some shapes,
  listed in the rule, are not read, such as an early exit above the call or a
  call made inside a callback. The tool scan now reads the webview and catches
  `vscode.lm` taken whole or bound, and the attacks recorded against the AI
  Assistant rules are replayed in memory on every run, except the
  import-coverage ones, which the coverage control reads on the real tree.
- **The Sync module page is held to the code it describes.** A check beside the
  page fails when it sells a conflict review, a conditional rule, a transform
  reach or a Grappe count the code no longer matches. Every claim that rests on
  a source line is pinned to that line first, so an assertion about a page the
  code has moved on from cannot pass quietly.
- **Hand-built bridge messages are checked.** In a webview file that posts a
  message, every hand-built `type: '<channel>'` must be a channel the protocol
  declares, the raw `sidebar:*` channels excepted; an undeclared one used to
  surface only at run time, as a bridge error. On the extension side, a
  `:response` type built outside `buildResponse` is refused whatever it is
  posted through, the sidebar's own `postMessage` included, whether written as a
  literal, a template, or a value typed as a `:response` literal or a union
  holding one. Five listed sites are exempt — two pushes no request asked for,
  and three answers to the sidebar's raw requests — and each of them has to
  still exist. A value typed as plain `string` and a key computed at runtime are
  not read.
- **Forge tests that could not fail now can.** The orphan-parent cap test
  passed with zero parents fetched, the preview suite replaced SOQL escaping
  with a pass-through, the pause test waited on a real timer, and the
  query-size tests used field lists so short that the URI budget could have
  been raised past what Salesforce accepts unnoticed. Each now fails when the
  behaviour it names breaks, and the suite gains property tests for Id
  remapping, a discovery case where two objects reference each other, and
  Person Account cases.
- **AI and accessibility tests fail on regressions they let through.** The AI
  page's tests fail when its error banner stops clearing on send or on opening
  another conversation, the delete test starts from a restored conversation that
  was never in memory, and AI setup fails its test when it posts the webview
  anything beyond the status it owes. The accessibility scans now also cover the
  Welcome and What's New overlays open over a page, the Generate with AI dialog
  and the Automation canvas with a run in progress; on their first run they
  found the Welcome wizard's and the Automation run's unnamed progress bars,
  fixed above.
- **The CI and contributor docs describe the pipeline that runs.** ci.yml
  still called Windows the only leg running E2E, and CONTRIBUTING and the pull
  request template listed six validate gates where there are fifteen. They now
  describe the ubuntu E2E leg, point to the validate script, and say it leaves
  out the Playwright suite and mutation testing.
- **The command-line scripts are typechecked and linted with the rest of the
  extension.** `cli/` and `tools/` live beside `src/`, so no tsconfig and no
  `eslint src/` read them, and a type error or an undeclared constant in either
  script only surfaced when someone ran it against a real org. A
  `tsconfig.scripts.json` now covers both folders, the extension's `typecheck`
  and `lint` scripts read them, the shared lint rules and the typed-linting
  block apply to them, and a gate refuses a change that narrows the scope again
  — it reads the configuration ESLint resolves for a script file, not just the
  globs written in the config.
- **Dependabot proposes only the updates it can resolve.** Its grouped proposal
  for the production dependencies bumped typescript-eslint, left the shared
  version in `pnpm-workspace.yaml` at `^8` and wrote the resolved 8.70.0 into
  the lockfile beside a manifest that reads `catalog:`, so an install from the
  lockfile refused the branch on Linux, macOS and Windows alike. The npm entry
  is gone: the configuration moves action pins only, and it records the two
  constraints that entry carried — `@types/vscode` moves with `engines.vscode`
  and never on its own, and a proposal used to be held for seven days. Security
  updates come from the repository setting rather than from that file and keep
  arriving; one that lands on a dependency the catalog owns fails the same way
  and needs the version moved in `pnpm-workspace.yaml` by hand. A check fails if
  npm comes back while a manifest reads the catalog.

- **A request whose contents are not what its channel expects is refused.**
  Such a request is answered with an error naming the field at fault, instead
  of being acted on as it arrived. About ninety routes did that already and
  nothing held them to it: a route that stopped checking went on answering, on
  whatever the message happened to carry, and nothing said so. A check now
  reads every route as it is written, following the steps it hands the request
  to, and fails when one reaches into a request it has not checked first. Two
  routes are listed as exceptions, each with the reason it is one — one checks
  its request against a schema of its own instead of through the shared helper,
  the other reads a single optional number and falls back unless it is a usable
  count — and the check fails when an entry stops applying, so neither can
  outlive what it excuses.
- **A release becomes public only once the Marketplace serves the version.** The
  GitHub release was created after the Marketplace publish, so a publish that
  errored left the new tag pushed with nothing beside it, and one that errored
  after the upload had landed left an installable version with no release page
  and no notes. Three runs in a row ended there — the gallery call returned an
  error after about three minutes each time, and a version the Marketplace has
  already accepted cannot be uploaded again, so no retry could tell whether the
  first attempt had landed. The release is now drafted, with the VSIX attached,
  before the publish; the publish is attempted up to three times with a limit of
  five minutes on each; and the Marketplace is then asked, up to thirty times,
  whether it serves that exact version. Only then does the release stop being a
  draft. If the version never appears the run fails with the draft, the notes
  and the tag already in place for whoever finishes it by hand, and the run's
  own time limit now covers that whole worst case instead of being killed
  part-way through a release without a word.
- **A release is cut only from a commit that passed CI, and carries only the
  version bump.** Nothing in the release run looked at what CI had concluded
  about the commit being released; its own validation runs on one operating
  system and no end-to-end suite, so a commit whose CI run had failed could
  still be bumped, tagged, pushed and published. That conclusion is now read
  first, and a run stops before it writes anything unless the commit passed —
  a commit with no completed run is refused too. The release commit itself was
  built by staging whatever the working tree happened to hold, so a stray build
  output or an unfinished edit could go out under a message reading "release".
  It now stages the files the version bump writes and the lockfile, and stops if
  anything else in the tree has changed.
- **The checks that catch a broken package run on every change, and now cover
  the translations.** SandForge reads three things off disk only when they are
  first needed: the Salesforce connection code, the AI provider code, and every
  language other than English. A package that lost one of them installs and
  starts normally, and then fails at the moment you connect an org, ask the
  model for something, or use the extension in French, German, Spanish,
  Japanese or Brazilian Portuguese — where the interface stays English with an
  error where each translation should be. The gates that look for those files,
  and the size limit on the code loaded at startup, ran on the day a release was
  cut and never before it. A package is now built and put through them on every
  change, the translation bundles are checked against the list of languages the
  extension itself offers, so a language added there is covered without anyone
  remembering to come back, and the bundle-size gate no longer reports its
  result as an activation time it never measured.
- **The checks test what they say they test.** They all ran on Node 22, the
  oldest release SandForge supports, and none ran on Node 24, the one the
  extension and its command-line scripts are written on, so a difference
  between the two surfaced only on someone's own machine or after a release:
  the typecheck, the tests and the build now run on both, with Node 22 still
  the version every gate decides on. Two copies of the project running the
  end-to-end suite at the same time also shared one development server, so one
  copy's sources answered the other one's assertions; a run can now be given a
  port of its own, and one that has been starts its own server instead of
  borrowing a busy one, and refuses a value that is not a port rather than
  failing further on with nothing to point at. And a test that failed and then
  passed on retry used to leave a green run and no trace anywhere; the number
  of those is now reported on the run itself.

## [1.22.0] - 2026-09-15

This release is about things that said they worked.

Almost every change below has the same shape: a feature, a setting, a button
or a sentence in the listing promised something the code did not do. A sync
dry run that synchronised for real. A token budget nobody counted. An anomaly
scan that only ever read Account. A Grappe page selling parallel execution, in
six languages, over a sequential loop. A diagnosis flow no screen could start,
still able to run anonymous Apex when a message asked for it.

Each one is now done, refused out loud, or gone — and where a check had let it
through, the check was rewritten until it could fail. Thirty-five modules that
nothing shipped were deleted along the way, the package lost a copy of zod, and
the repository stopped addressing people who had its planning documents open.

### Fixed

- **A refused export no longer reports a save.** When the host rejected an
  export — a DataOps backup over the size limit, for instance — the rejection
  came back on the channel the page reads as an outcome, matched nothing, and
  fell through to the success branch: a green confirmation for a file that was
  never written. It is now an error, attached to the export that caused it,
  and the DataOps page shows it. That page had never shown a refused backup
  export: the effect that raises its errors read the export's error without
  re-running when it changed.
- **A restore Salesforce mostly rejected no longer reports success.** Restore
  and anonymization counted the records Salesforce accepted and dropped the
  rest. A rollback where 900 of 1,000 records were refused said "100 records
  restored", with no error anywhere. Both now report a partial or failed result,
  with a sample of what the org said, and tell you through a notification.
- **An error lands on the request that caused it.** Most errors used to reach
  the page with no indication of which request they answered, so every request
  of the same module waiting at that moment took them as its own. A long Sync
  could show as failed because an unrelated field lookup had failed — and its
  real result, arriving later, was discarded. Every error now names its
  request, and the page no longer hands one that names none to whichever
  request happens to be waiting — CSV import and Clone included, which had
  their own way of doing so.
- **A confirmation you have to type starts empty every time.** If a
  confirmation dialog was closed by the page rather than by you — a refresh
  removing what it was about — the text you had typed stayed, and the next time
  it opened the button was already armed: one click, nothing typed. This
  affected every typed confirmation in the product: clone and seed execution,
  Forge, conflict resolution, anonymization and org management.
- **The Monitor's critical-jobs band reports what it sees.** It had no data
  source, so it was always empty — which reads exactly like "nothing critical".
  It now flags Apex jobs that have stopped progressing, never a job that is
  merely long-running, and shows "unknown" rather than "all clear" when it has
  nothing to go on.
- **The Monitor opens the org's Apex Jobs page instead of an abort that never
  worked.** Salesforce does not let an Apex job's status be changed through the
  API, so every abort ended in "Failed to abort job". The critical-jobs band now
  links to Setup › Apex Jobs, where aborting works. The extension builds that
  address from the org it already knows — the page cannot choose where it sends
  you — and a slow confirmation from VS Code no longer shows as a failure.

- **A saved AI conversation continues after a restart.** The assistant only knew
  the conversations opened during the current session: after restarting VS Code —
  or after any change to an AI setting — an older conversation could still be
  reread, but the first message sent into it came back as "conversation not
  found", whether it had been reopened from the list or not. It now resumes with
  its full history, in order, and deleting it removes it from the list and from
  storage alike.
- **An AI failure says what went wrong.** It only switched the waiting indicator
  off, so a refused request looked exactly like one that answered nothing. The
  reason the extension gives is now shown in the conversation, can be copied,
  and clears on the next message. Only the failures of what this page asked for
  appear there: an analysis that failed in another panel no longer surfaces in
  the chat.
- **The AI token budget you set is enforced.** `sandforge.ai.tokenBudgetMaxPerSession`
  was read by nothing: no counter ever started, the gauge in the assistant never
  appeared, and no request was ever refused however many tokens it had spent. One
  counter now meters every AI call — chat, natural-language SOQL, pipeline
  drafts, error resolution, Seed personas and AI field rules share it — the gauge
  turns amber at 80% and further requests are refused at 100% with a message
  naming the setting and the count. **If you use AI and never touched this
  setting, its default of 50,000 tokens now applies to you**: roughly a dozen
  exchanges per window, after which requests are refused until you raise the
  setting — which restarts the counter — or reload the window. During seed
  generation a refused call falls back to Faker data instead of failing the run,
  and the refusal is only logged.
- **A failed operation is explained once, and from the answers that ship with
  SandForge first.** Every failure was handed to the assistant without the
  Salesforce error code, so the twenty-five resolutions built into SandForge were
  never found: a locked row, a validation rule or an expired session went to the
  AI provider like anything else, taking the org's error text with it. It was
  also handed over once per open SandForge panel — three panels meant three
  calls, three copies of that text leaving the machine and nine notifications for
  one failure. A failure is now resolved once, where it happens, and a known
  Salesforce error is answered from the built-in list without contacting the
  provider at all.
- **Two analyses that never needed a model no longer ask for a key.** Compare's
  schema advice and Monitor's anomaly scan are rule sets: they read the org's
  description or a sample of records and send nothing anywhere. Their buttons
  were clickable without AI all the same, only to answer "AI not configured".
  They now work with AI off and no key stored.
- **Turning AI off stops it at once.** Once a session was running, clearing the
  setting undid nothing: chat, natural-language SOQL, pipeline drafts and the fix
  suggestion after a failed run kept sending to the model until the window was
  reloaded. Everything that talks to the model is now put away as soon as the
  setting changes, the interface is told without waiting for a reload, and
  turning AI back on restores it just as quickly.
- **A persona's AI fields follow its instruction again.** Applying a built-in
  persona set up its AI-generated fields — the e-commerce product review, the
  non-profit campaign name — but the model only ever received the field name: the
  instruction the persona carried was stored under a name the generation contract
  does not know, and was dropped before it reached the model. It now arrives, and
  is shown in the instruction box of the configuration step, where you can edit
  it before running.

- **Natural-language SOQL is written against your org's fields, and says when it
  could not be.** The model was handed the API names and labels of every object
  in the org and not one field name, so the fields in the draft were its own
  invention and the panel gave no sign of it. SandForge now describes up to five
  objects your request names — by API name or by label, singular or plural —
  sends the model their field API names, labels and types, and rejects a draft
  that selects a plain field none of them has, naming the field. When nothing
  could be checked, the draft still comes back with a line that says why:
  either the org returned no field list for the object the draft queries, or
  the draft selects only values from related records or totals, which are left
  to the org to judge.
- **The anomaly scan reads the object you choose, and says how the run went.**
  It sampled Account and nothing else, whatever the org held. A dropdown beside
  the button now picks the object: Account first, then up to 20 of the org's
  objects that hold records, largest first. Selecting another org puts the
  choice back on Account, drops the previous org's report, and offers nothing but
  Account until that org's own list arrives, so a scan is never sent for an
  object the new org does not have. A run that finds nothing says
  so, and one that fails shows the reason under the button instead of leaving
  the panel exactly as it was.
- **A sync configuration's sort order is honoured, and can only sort.** A sync
  object accepts an `orderBy` — an SFDMU export carries one, and the importer
  keeps it. It reached a query only through the sync dry run, which no screen
  and no command could start, so every real run ignored an imported order. The
  real read now sorts by it. An ORDER BY ends the statement, so whatever
  followed the field names would run with it — `Id ASC LIMIT 1` would truncate
  the read, `Id ASC FOR UPDATE` would lock the rows it returns. The field is
  refused at the extension boundary unless it lists field names with an
  optional ASC/DESC and NULLS FIRST/LAST, and checked again where the query is
  assembled.
- **A built-in persona's ranges, lists, prefixes and locales reach the
  generator.** A persona describes each field in its own vocabulary — a premium
  between 200 and 5,000, a contract type drawn from five values, a medical
  record number prefixed `MRN-`, a French company name. Those settings were
  passed on under the persona's own key names, which the generation contract
  does not read, so they were dropped on the way and the fields fell back to
  defaults: 0 to 1,000 for a number, an empty value for a picklist, a lorem
  sentence for a name. They now arrive under the names the generator reads. A field
  described by a digit mask, such as the French SIRET, now gets a digit in place
  of each `#`, different from one record to the next, instead of the mask
  itself. Product names, IBANs whose check digits validate and BICs in the ISO
  9362 shape replace the lorem sentences those three fields used to get. A faker
  method SandForge does not implement now stops the run before any record is
  written, and names the method, instead of inserting a sentence that looks
  like a value.

### Changed

- **The shipped catalogue is a quarter smaller.** 555 translation keys that
  nothing displayed were removed from all six languages — 2,240 keys down to
  1,685, 642 KB down to 499 KB in every install. Thirty-one keys recorded as
  unused were in fact displayed, and stay.
- **The documentation describes what the extension does.** Sync writes in one
  direction; conflict resolution is what runs both ways. Automation composes
  and saves pipelines, but its steps other than Delay and Condition do not
  execute yet, and it has no dry-run mode. Scheduled runs and real-time sync
  are not available. Safety checks are logged in memory for the session, not
  kept as an audit trail. Compare's Snapshots is a live capture of two orgs, not
  a history.

- **The AI model setting says what it sets.** `sandforge.ai.model` was described
  as the model "for the assistant". One adapter is built from it and every
  feature that reaches a model goes through that adapter, so its description now
  names them: assistant chat, natural-language SOQL, pipeline drafts, error
  resolution, Seed personas and Seed AI field rules.

### Removed

- **Thirty modules that never ran are gone.** Twenty-five files in the
  extension host — a smart field generator, two validation-rule helpers, a
  pipeline version store, an approval gate, a sync impact analyser, CSV and
  JSON connectors, a data masker and others — were compiled, tested and
  maintained, and not one of them was reachable from the code the extension
  starts: none appears in the shipped `dist/extension.js`, so removing all
  3,737 lines leaves that file byte for byte the size it was. Five webview
  components were in the same state, including a relation editor and an ERD
  mini-map no page mounted, an org-connect dialog the org page replaced with
  an inline form, and a retry hook whose panel had already been deleted. The
  14 translation keys only they displayed leave all six languages with them,
  3.6 KB off the catalogue every install carries.
- **Failed-job diagnosis, which nothing in the product could start.** The
  listing sold "failed-job diagnosis over 10 read-only tools"; no screen asked
  for a diagnosis or sent an approval, and the tools were connected to nothing.
  The extension still acted on both requests whenever AI was set up. A diagnosis
  request sent the error it carried to the model and kept the model's answer for
  ten minutes. An approval naming one of that answer's actions then ran it if
  the model had proposed anonymous Apex and marked it as needing approval: the
  script went to `executeAnonymous` in the org the diagnosis named, with no
  confirmation dialog — and a script sent with the approval ran in place of the
  model's. Neither request is accepted any more, and the listing now describes
  the assistant you can actually open.
- **Two AI requests that no screen sent are no longer answered**: module
  suggestions and AI personas. Seed's own personas are unaffected.
- **The extension package no longer ships an extra copy of zod** that only the
  removed diagnosis loaded: the VSIX is 13% smaller (2.08 MB to 1.81 MB).

- **A sync could run Apex, and nothing in the product could ask it to.** A sync
  configuration accepted two fields whose contents were sent to the org as
  anonymous Apex — one before a single record was read, the other after the last
  was written. No wizard field, no importer, no example and no page ever produced
  them; they could only reach the extension through a configuration edited by
  hand. Both fields and the path behind them are gone: a sync moves data and runs
  no code. A configuration that still carries one is refused with an explicit
  message rather than run — or quietly stripped — behind your back.
- **Seed's field step no longer carries a suggest button and a
  validation-rule warning strip that nothing could fill.** The step still
  accepted field suggestions and validation-rule results and drew a button, a
  badge and a warning block from them; what produced them was removed with the
  modules that never ran, and the step's only caller passes neither. The
  inputs, the three pieces of interface behind them and the one translation key
  they displayed are gone from all six languages.
- **Five more modules of the shared contract that no shipping code reads.**
  The settings, pipeline, compliance and cluster validation schemas and the
  standard-object reference tables were compiled and tested, and not one of
  their values was ever read outside their own tests — they reached the rest of
  the repository only through a re-export that names nothing. The extension
  used to build their schemas at load — about 9.5 KB of the package goes with
  them; the webview never carried them at all.

- **Four AI entry points no route could reach.** A one-shot completion on the
  assistant and the two prompt builders standing on it — field-rule suggestions
  and a sync-configuration review — had no caller: each would have sent a prompt
  and billed a request that no screen could ask for. The provider contract's
  token-counting method went with them, along with the three adapter
  implementations it obliged, and a shared schema factory neither side of the
  bridge read.

- **A sync configuration no longer accepts a dry run it never performed.**
  `dryRun` was accepted on a sync configuration and read by nothing on the way
  to a run: a configuration that set it to `true` synchronised for real. The
  simulated path behind it was reachable only from tests. The flag is gone from
  the contract. A configuration that still sets it to `true` is refused, with a
  message saying a sync writes to the target org; `false`, which every stored
  configuration carries, stays accepted.

### Build

- **The orphan-module check covers the extension and the shared contract, not
  just the webview.** It walks the import graph from the four entry points the
  build really uses, over the TypeScript syntax tree rather than a regular
  expression, so a module named in a comment, imported for its types alone, or
  kept alive by nothing but its own test is reported instead of counted as
  live. Modules that compile to nothing — interfaces and type aliases — are
  left alone, since deleting one would break the type check without changing a
  bundle. Checked against the shipped bundle, the graph contains every file
  esbuild emitted, so nothing it reports can be a false alarm.
- **A barrel is no longer counted as a caller.** `export * from './x'`
  re-exports every symbol of a file without naming one, so `./x` used to look
  reached the moment anything imported the barrel — and 94 files sat behind
  such a re-export, where a module nobody names anywhere could pass a check
  that reported "no orphan modules". A re-exported file now counts as reached
  only once shipping code names one of its symbols, resolved through chained
  barrels. Where the check cannot tell — a namespace import used as a value, a
  dynamic or side-effect import, none of which names what it pulls in — it
  keeps the file: it can still miss dead code, never call live code dead.
- **Test data that lives next to the code it describes is not reported as
  dead.** A fixture outside the four test-support directories was reported with
  "delete it or wire it into an entry point" as the only advice, which is the
  wrong move for a file whose job is to serve tests. `*.fixtures.ts` is now a
  recognised name, and the report says so.
- **`pnpm validate` runs what CI blocks on**, including the screenshot check,
  and the check that enforces this no longer accepts a commented-out command
  as a command that runs.
- **The public-links check exits after passing.** It printed its success and
  then kept the release waiting forever.
- **The translation check reads the whole repository**, not the webview alone,
  exempts runtime-built keys only where a real call builds them, and ignores a
  key named in a comment.
- **The request-correlation check runs on every platform, and outside the
  coverage pass.** It compared file paths as Node builds them with paths as
  TypeScript writes them — the same on Linux and macOS, different on Windows,
  where it read nothing and flagged what it should have trusted. Under coverage
  instrumentation its type-checking pass also ran long enough to starve the test
  runner on small CI machines. It now normalises every path, stays out of the
  coverage run it adds nothing to, and `validate` is held to still running it.
- **`execution:progress` is gone.** Nothing ever emitted it; the channel, its
  tracker and its hook are removed, and the emission check no longer certifies
  a channel from code that only constructs its emitter.
- **Two stale paths no longer describe the repository.** The unused-code check
  was told to ignore a quarantine directory that no longer exists, which it
  reported on every run; and the packaging ignore list claimed the command-line
  and tooling sources it excludes were "already bundled" into the extension,
  which no build entry point reaches.
- **The AI call-path check compares symbols, not spellings.** It credited a
  method with a caller as soon as some `x.<name>(…)` existed anywhere in the
  three packages, so the dead one-shot completion above was covered by the
  Grappe store's `complete`, and the provider contract's `dispose` by
  twenty-two unrelated ones, VS Code's included — the check could not fail. It
  now builds a TypeScript program per bundle and resolves every call to the
  declaration it actually reaches, so a namesake in another class, package or
  library is not a caller. Two seconds slower, and provably able to go red.
- **The confidentiality check can pass.** Before a release it scans every
  tracked file for client names and real org Ids, and it had not passed since
  at least 1.20.0: its Id pattern matched 59 places and not one was an org —
  fixtures counting up from `00D000000000001`, placeholders of one repeated
  letter, the example Id from Salesforce's documentation, eighteen characters
  in the middle of a lockfile hash, and its own definition. A check that always
  fails hides the failure that matters among the ones everybody expects. An Id
  now has to stand on its own and the stand-in shapes are named; a finding is
  reported by file and line, without repeating a client name or a whole Id into
  a log; and it runs on every push, where CI checks Ids and a local run checks
  names as well.

## [1.21.0] - 2026-09-10

The end-to-end suite came back, and immediately started finding real bugs.

SandForge shipped 83 end-to-end tests, 35 of them failing, and nobody knew:
the CI leg that ran them was cancelled at thirty minutes on every run, so the
suite had never once finished. Another 91 tests sat in a quarantine directory,
excluded from the run entirely. This release turns 75 running tests into 209 —
and every user-facing fix below was found by a test that could finally reach
the product.

### Fixed

- **The compliance report no longer crashes on open.** After an Autopilot run,
  clicking "Compliance Report" showed "Something went wrong": the extension
  sends the report inside an envelope and the panel read the envelope as the
  report, so `entries` was `undefined`. A _bridge flow_ test had been green
  over it the whole time, because it answered with a message shape the
  extension has never emitted.
- **Compare's Permission Matrix, Snapshots and Drift Dashboard no longer kill
  the panel.** Each read data in a shape the extension does not send —
  `filteredRows.map is not a function` — and the ErrorBoundary took down the
  whole page, not just the tab. All three now render what the extension
  actually produces: presence of each permission set and profile per org,
  object counts and one-sided objects per snapshot, and settings drift row by
  row. A degenerate answer surfaces as an error naming the channel, never as
  an empty view that would read as "these orgs agree".
- **Conflict resolution no longer carries choices onto the next record.**
  Resolving two fields on one conflict and then selecting another left those
  choices armed: Apply was already enabled for a record nobody had decided on,
  and the message sent carried a field the second record was not even in
  conflict over. Applying it wrote one record's values onto another.
- **The conflict strategy you pick is the one that travels.** Real-time sync
  offered five strategies per object and sent `source_wins` regardless — a
  control with no effect, on the setting that decides which data survives a
  collision. Where objects disagree the session now degrades to manual
  resolution rather than applying one object's rule to another.
- **Stopping a real-time stream names the stream.** `realtime:stop` sent an
  empty session id, so a host running two streams could not tell which to
  close. A single pushed `realtime:event` was also dropped on the floor — the
  channel was declared and schema-registered, and the store had no case for it.
- **The record-per-object cap in Forge has an accessible name.** Its label was
  a styled `<div>`, so a screen reader announced "combo box" and nothing else.
  axe rates this critical; it is now a real label carrying the visible text,
  with the hint as a description.

### Changed

- **The end-to-end suite runs, and runs everything.** 209 tests across 18
  files, up from 75 across 9. The quarantine directory is gone: seven specs
  were rewritten against the panels the extension actually opens, two were
  deleted for driving channels that exist nowhere in the product, and two were
  rebuilt from scratch against real surfaces — real-time CDC and conflict
  resolution, both shipped and both previously untested. Nothing was silenced
  to get there: no skipped test, no widened timeout, no emptied assertion.

### Build

- **`pnpm validate` now means what it claims.** It ran neither `format:check`
  nor `knip` — each blocking every push from its own workflow — nor
  `test:coverage`. Three blocking gates it never ran, so a green `validate`
  never implied a green CI. The parity gate meant to prevent exactly this had
  the same blind spot: it read only `ci.yml`, so "runs in CI" excluded the two
  workflows that are also CI.
- **The Marketplace screenshots are byte-stable.** The Monitor page draws a
  live countdown, so every regeneration produced a different `monitor.png` and
  the release gate flagged it forever. The clock is frozen for the capture.
- **The E2E message helper stopped lying.** `getMessages(type)` filtered on the
  transport envelope rather than the message inside it, so it returned an empty
  list for every type anyone asked for — and three tests were red for that
  reason alone, with nothing to do with the product they pointed at.

## [1.20.0] - 2026-09-09

Reports stops apologising and starts reporting, and fifteen smaller things.

The three previous releases removed what the product claimed and did not do.
This one adds: a module that shipped as four empty tabs now reads the run
history two other modules have been keeping since they shipped.

### Added

- **Reports works.** It shipped as four tabs with no producer anywhere in the
  codebase, printing 0 / 0 / 0.0% / 0 — figures a reader takes for
  measurements ("this org ran nothing and fails everything") rather than for an
  absent feature; v1.19.0 made it say so instead. Nothing was missing but the
  reading: Forge stores its runs under `forge:history` and Sync under
  `sync:history:all`, each with a status, a duration and a record count. The
  Executions tab and the success-rate figures come from those, with no new
  storage, no call to your org and no invented number. Each report exports as
  JSON through the same Save dialog every other export now uses. Audit trail
  and data lineage have no such store and still say so.
- **Copy an error in one click**, from any banner in the product — the thing
  you actually want when you are about to paste it into an issue. Long and
  multi-line errors stay fully readable instead of being clipped.
- **Search your orgs** once you have more than five, and an Organizations panel
  that shows what it is doing during the initial load and the CLI import
  instead of staying blank.

### Fixed

- **Forge refuses an unreadable record id on the spot.** A half-pasted id, or
  one with a space in it, left the button enabled and sent the run anyway — you
  waited for a round trip to the org to get back `Cannot resolve root object
for inputMode "record"`. And **Enter now starts discovery** from the record
  field, which the SOQL and AI tabs already allowed.
- **A failed discovery is no longer hidden behind the previous graph.** From
  the second discovery of a session, the earlier graph was still on screen, so
  the error had nowhere to render: you read — and could execute — the previous
  org's graph believing it was the new one.
- **Failures come first.** Job groups carrying failures and governance rules in
  breach now sort above the rest, and each job filter says how many jobs it
  keeps, instead of leaving you to count.
- **Salesforce error codes reach the message.** `INSUFFICIENT_ACCESS_ON_CROSS_
REFERENCE_ENTITY`, `ENTITY_IS_DELETED`, `DUPLICATE_VALUE` and their kin were
  carried on fields the message never read, so you saw a description with no
  code — or an empty string. `MULTIPLE_API_ERRORS` showed "Multiple errors
  returned. Check `error.data`" instead of the errors it was holding.
- **The Settings save button belongs to the tab it saves.** It rendered on
  every tab while writing only one. "Reset to defaults" now asks first, and
  actually restores the default language.
- **The Reports KPI row is gated per tile.** It required all four figures to
  have a source, so the three that do would have been hidden to avoid printing
  the one that does not. Each tile appears with its own source.

### Security

- **The critical advisory in the shipped VSIX is closed.** Of seventy
  advisories in the tree, two reached users: `websocket-driver` (critical),
  bundled through `jsforce → faye`, and `form-data` (high). Both are pinned to
  patched versions. `csv-parse` moves 5 → 7 across a major boundary, verified
  against all four of jsforce's CSV entry points including the streaming path
  the Bulk API results use.

### Build

- **The vendoring guard no longer fails open.** It matched `from`, `require()`
  and `import()` but not `import 'pkg';` — the side-effect form with no
  binding. A dependency reached only that way was never vendored, and the VSIX
  shipped with the exact `MODULE_NOT_FOUND` the guard exists to prevent, while
  the build stayed green.
- **The dead-key baseline can only shrink.** It held 590 entries and had grown
  every time code was deleted; it now refuses to grow, drops entries that
  regain a consumer, and prints its own census — `587 recorded, 586 listed
today (1 removed since)`.
- **The screenshot gate stopped crying wolf.** It called four correct images
  stale after a Prettier reflow, and again after a regeneration, because it
  read a deleted file's old commit. Staleness is judged on what the generator
  does, and a file written since its last commit is current.
- **The link check answers in twenty seconds**, not twenty minutes: it checked
  the same URL once per occurrence and then multiplied each rate-limited one by
  four retries. One verdict per URL, two retries, a ninety-second ceiling.

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

The repository is public, and the release that opens it repairs the flagship.

Forge could not clone an object holding more than 200 records: every object
above the threshold failed, and its whole subtree was skipped behind it. Below
that threshold, a clone stopped at the first 2 000 rows of each object and
still reported success. Both are fixed. Around them this release closes the one
write path that reached a target org with no Production Guard check, gives the
guard the real operation to judge instead of a hardcoded single-row upsert, and
repairs a Marketplace listing whose links all answered 404 to anyone but the
author.

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
  pictured a navigation sidebar deleted in 1.8.0, showed 9 of the 14 modules,
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
  pictured a UI deleted ten minor versions earlier — a navigation sidebar
  removed in 1.8.0, a "v3.0.0" watermark from the pre-1.0 internal numbering, an
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

**Monitor v2 Core + AI Integration + close-out hardening.** Two feature tracks shipped under the v1.3.0 umbrella, plus a six-bug close-out pass that surfaced when the extension was installed from a freshly built VSIX. The monitor track ships the time-series substrate (MetricBus, TimeSeriesStore, MonitorRegistry + 8 probes, DriftDetector v2, AnomalyEngine, ReportExporter, FleetSummaryService). The AI track ships the read-only assistant (per-provider CircuitBreaker, AbortController, 10 read-only tools with CI fence, per-panel-session token budget, prompt-injection defence with adversarial vitest, AIDiagnoseHandler with approve gate, Anthropic adapter functional + OpenAI/Custom stubs).

### Added

**Monitor v2 Core**

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

**AI Integration**

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
- Adversarial vitest spec: 7 jailbreak fixtures × 2 defence layers + 2 spotlight assertions
- `AIDiagnoseHandler` self-defence canary asserts the literal `</user-data>` substring NEVER appears in the body between the wrapper's open + close tags
- 4 bridge envelopes (`ai:diagnose`, `ai:diagnose:response`, `ai:approve-action`, `ai:approve-action:response`) + 3 budget envelopes (`ai:budget:state`, `ai:budget:warn`, `ai:budget:exceeded`) + `ai:provider:status` + `ai:tool-trace`
- 6 `ai.error.*` i18n keys (overloaded / rateLimit / auth / cancelled / transient / unknown) in EN + FR

**Close-out wiring**

- `sandforge.openAI` command + `Bot` icon + EN/FR NLS title + Ctrl+K palette entry: AI Assistant now reachable from the activity bar (SidePanel), the in-panel layout (Sidebar), the top bar route labels, and the command palette across all 11 surfaces

**Tooling**

- `scripts/git-hooks/pre-commit` runs `pnpm -r typecheck` + locale dup-key scan on every commit
- `package.json` `prepare` lifecycle auto-installs the hook on `pnpm install` via `core.hooksPath = scripts/git-hooks`

### Fixed

- **AIChatPanel.tsx ad-hoc message types**: replaced inline `BaseMessage & { payload: { ... } }` types for `ai:provider:status` / `ai:budget:state` (which were missing `id` + `timestamp`) with canonical `AIProviderStatusMessage` / `AIBudgetStateMessage` imports from `@sandforge/shared`. Webview tsc was failing on the close-out; extension vitest never caught it because the inline type compiled fine in isolation.
- **`pnpm.overrides` minimatch flipped vsce to incompatible major**: previous `<3.1.4: >=3.1.4` was a non-existent version (last 3.x is 3.1.2) that resolved vsce's `^3.0.3` to 9.x or 10.x, breaking vsce's CJS-default `__importDefault(require('minimatch'))` with `(0 , minimatch_1.default) is not a function`. Tightened lower bound to `<3.0.5` (the actual ReDoS-fix threshold per GHSA), constrained replacement to `>=3.0.5 <4` so CJS-default consumers stay on 3.x, plus `@vscode/vsce>minimatch: 3.1.2` path-scoped override belt-and-braces.
- **AI panel was an orphan route**: `AIPage` was registered in `PanelRouter.tsx` but `'ai'` was missing from `ModuleRoute` type, `ALL_ROUTES`, `router.tsx routeComponents`, both sidebars (`SidePanel.tsx` + `Sidebar.tsx`), `TopBar ROUTE_LABELS`, `CommandPalette ROUTE_ICONS+LABEL_KEYS`, `extension.ts moduleCommands`, `SidebarViewProvider commandMap`, the package.json command contribution, and EN/FR NLS. The whole AI backend was unreachable from the user-facing UI.
- **`BridgeProvider.tsx` contract drift on `ai:status:response`**: the listener read `msg.payload.available` but the canonical `AIStatusResponse` payload field is `enabled`. Silent typecheck-clean / runtime-broken. `setAiAvailable(undefined)` always made `aiAvailable === false` even when the API key was configured. Replaced ad-hoc inline type with `AIStatusResponse` import from shared so future renames break both sides at compile time.
- **Duplicate top-level keys in EN + FR locale JSONs**: `monitor`, `dataops`, `execution` were each defined twice in `en.json` and `fr.json`. `JSON.parse` silently kept only the second value (which contained `liveOps` only for `monitor`), wiping out `monitor.title`, `monitor.limits`, `monitor.emptyState`, etc. The user saw raw i18n keys on the Monitor empty state. Programmatic deep-merge preserved both occurrences in all three keys; verified all 4 other locales (de, es, ja, pt-BR) clean.

### Changed

- `pnpm validate` now ALWAYS runs through the pre-commit hook on every commit. The earlier flow let work land without ever invoking `pnpm package` (the only path that exercises webview tsc + VSIX production + vsce interop). The new hook closes that gap.

### Security

- **Prompt-injection defence verified adversarially**: `escapeUserData` HTML-entity-escapes `<` / `>` / `&`, strips NUL bytes, and `wrapAsUserData(label, value)` produces `<user-data label='${label}'>${escaped}</user-data>` where the label itself is also escaped. The spotlight clause in all 3 system prompts tells Claude `<user-data>` content is data, never instructions. 7 jailbreak fixtures (closing-tag breakout, nested-tag confusion, system-prompt impersonation, plain-text instruction, base64, unicode-lookalike, polyglot CDATA-like) all neutralised at the encoding layer with vitest assertions on both defence layers per fixture.

## [1.2.5] - 2026-05-02

**Forge Hardening Pass**: 23 audit findings resolved (security, performance, correctness) + CLI feature parity with the wizard, plus 5 Playwright E2E specs covering critical user flows.

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
- 5 Playwright E2E specs covering: AI persona seed → execute, sync conflict resolve, monitor refresh + CSV export, CDC subscribe + event stream, AI diagnose + apply fix
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

**« Scale & Complete » (v1.2.3), shipped as v1.2.4.** Marketplace release of « Scale & Complete », tagged `v1.2.4`. The feature content is documented under [1.2.3]; this entry records the version actually published so the version sequence has no gaps.

- Three seed modes: AI Personas (10 industry personas), CSV Import (drag-and-drop + validation), Clone from Org (topological insert + ID mapping)
- Real-time sync lifecycle: CDC subscriptions, conflict resolution UI, execution history, cron scheduling
- Streaming execution (async generator, >10K records) + background operations with native notifications
- Enterprise UI: pagination, virtual scrolling, skeleton loading, notification center, keyboard shortcuts
- Smart Actions on HomePage: analyzes org state and recommends best next action

Tests: 8320 passing | VSIX: 1.24 MB | i18n: 6 languages

## [1.2.3] - 2026-03-28

**Scale & Complete**: Enterprise foundation, real-time sync, conflict resolution, AI personas, streaming execution, and three new seed modes.

> **Correction (2026-09-09).** Two bullets in this entry — "Cache manager with
> automatic org-switch invalidation" under _Added_, and "Org-switch cache
> invalidation (no stale data between orgs)" under _Performance_ — described
> something that never ran. `CacheManager` shipped with a `register()` method
> that no production code has ever called, so its registry has been empty since
> the first commit and `invalidateAll()` always iterated over nothing. The
> `cache:invalidate-all` and `cache:get-stats` channels reached a live handler
> that operated on that same empty registry.
>
> What was true, and still is: no stale data crosses an org switch. Every real
> cache is already keyed by org — `DescribeCache` is a `Map<orgId, …>`, the
> describe caches key on `${orgId}::${objectApiName}` and on `orgId` — and
> `RecordScopeCache` is built per run and dies with it. The invalidation was
> never needed, which is why nobody noticed it was absent. The claim was wrong;
> the guarantee it advertised came from the per-org keys.

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
- ~~Cache manager with automatic org-switch invalidation~~ — retracted, never
  ran; see the correction note at the top of this entry

### Changed

- SeedPage restructured with mode selector and AI persona fork (was wizard-only)
- Sync Page reorganized with tabbed layout (Active Syncs, History, Schedules, Conflicts, Real-Time)
- Seed and Sync handlers refactored: streaming pipeline for large datasets, background detachment for long-running ops
- Home Dashboard now shows SmartActionCard with contextual recommendations

### Performance

- Virtual scrolling for all large data tables (10,000+ rows)
- Ring buffer for CDC events (constant memory, no array growth)
- ~~Org-switch cache invalidation (no stale data between orgs)~~ — retracted,
  never ran; the per-org cache keys provided this, not an invalidation pass
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
