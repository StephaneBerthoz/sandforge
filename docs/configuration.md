# Configuration

Every SandForge setting lives under **SandForge** in the VS Code Settings UI. This page lists them, with the keyboard shortcuts and the languages the panels speak.

## Settings

| Setting                                    | Description                                                                                                                                                           | Default           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `sandforge.showWhatsNew`                   | Show what a new minor version brings the first time a SandForge panel opens after an upgrade. A patch version never shows it.                                         | `true`            |
| `sandforge.openOnStartup`                  | Show the SandForge side panel and open Home when a window starts. The first start after install shows the side panel alone, with the Get Started walkthrough in front | `true`            |
| `sandforge.telemetry`                      | Record extension errors locally for diagnosis. Nothing is sent over the network.                                                                                      | `false`           |
| `sandforge.orgs.validateOnStartup`         | Validate registered orgs when SandForge first opens a view in a window, and auto-refresh expired sessions via the sf CLI                                              | `true`            |
| `sandforge.forge.graphView`                | Forge's discovery, Review and execution screens: `auto` shows a table past 25 objects or under 560 pixels wide, a graph otherwise; `graph` or `table` always          | `auto`            |
| `sandforge.forge.maxRecordsPerObject`      | Most records of one object a Forge clone reads: a clone of whole tables reads and writes them a page at a time; past it, truncated                                    | `50000`           |
| `sandforge.forge.maxRoots`                 | Most records a Forge clone from a query takes as roots; more, with no LIMIT holding them, is refused before any other read (up to 2,000)                              | `200`             |
| `sandforge.seed.defaultBatchSize`          | Default batch size for Seed data operations                                                                                                                           | `200`             |
| `sandforge.sync.defaultBatchSize`          | Default batch size for Sync data operations                                                                                                                           | `200`             |
| `sandforge.sync.maxConcurrentOps`          | Maximum concurrent sync operations                                                                                                                                    | `3`               |
| `sandforge.sync.maxRecordsPerObject`       | Most records of one object a sync reads, from either org, 50,000 at most; past it, the run says it read the object in part                                            | `50000`           |
| `sandforge.ai.enabled`                     | Enable the AI Assistant (requires an API key)                                                                                                                         | `false`           |
| `sandforge.ai.provider`                    | AI provider (only `anthropic` is implemented)                                                                                                                         | `anthropic`       |
| `sandforge.ai.model`                       | AI model used by every AI feature (chat, NL2SOQL, pipeline drafts, error resolution, Seed)                                                                            | `claude-sonnet-5` |
| `sandforge.ai.errorResolution`             | Send a failed run's error message to the model for a fix suggestion (Salesforce Ids removed first)                                                                    | `true`            |
| `sandforge.ai.tokenBudgetMaxPerSession`    | Maximum AI tokens per window session, shared by all AI features (warns at 80%)                                                                                        | `200000`          |
| `sandforge.backup.maxCount`                | Maximum number of backups retained per org                                                                                                                            | `10`              |
| `sandforge.backup.maxAgeDays`              | Days a DataOps backup, which holds records' values unencrypted, is kept before it is deleted; 0 keeps it until deleted by hand                                        | `30`              |
| `sandforge.backup.maxRecordsPerObject`     | Most records of each object a DataOps backup, or a slice of one, holds; an object holding more is backed up in part, or in slices once asked                          | `50000`           |
| `sandforge.checkpoint.beforeRunKeepDays`   | Days a checkpoint a run takes before its first write (Checkpoint first), which holds records' values unencrypted, is kept; 0 keeps it until deleted by hand           | `7`               |
| `sandforge.pipeline.timeout`               | Pipeline execution timeout (ms)                                                                                                                                       | `300000`          |
| `sandforge.safety.requireProdConfirmation` | No longer used: every write to a production org asks first                                                                                                            | `true`            |
| `sandforge.safety.auditLogging`            | Record each Production Guard decision with the run it concerns in the audit trail                                                                                     | `true`            |
| `sandforge.safety.confirmAboveRecords`     | Ask before a Forge clone, an Autopilot run or a Sync writes more than this many records (0: never); one near the target org's data storage is asked about too         | `2000`            |
| `sandforge.grappe.enabled`                 | Show a large Seed, Sync or Autopilot run's progress in a Grappe panel of its run screen (Autopilot: one partition per wave); execution stays sequential               | `false`           |
| `sandforge.grappe.autoActivateThreshold`   | Record count at or above which that partitioned reporting starts                                                                                                      | `10000`           |
| `sandforge.grappe.grappeSize`              | Records per grappe partition                                                                                                                                          | `5000`            |

## Keyboard shortcuts

| Shortcut       | Action          |
| -------------- | --------------- |
| `Ctrl+Shift+A` | Open Automation |

In-app, press `Ctrl+K` for the command palette and `G` + a letter to jump between modules (see the Help page for the full map). On macOS, use `Cmd` instead of `Ctrl`.

## Languages

Full UI in 6 languages: English, French, German, Spanish, Japanese, Brazilian Portuguese. Key parity across locales is enforced in CI, and your language choice persists across sessions. Numbers and dates are formatted with Intl APIs in the language picked in SandForge, keeping the editor's regional conventions when the editor uses that same language. Durations are not: they are composed from fixed `h`/`min`/`s`/`ms` tokens and read the same in every locale.
