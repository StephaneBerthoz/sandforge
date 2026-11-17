# 0006: The sf plugin, without @oclif/core

**Status:** Accepted
**Date:** 2026-11-17

## Context

The `sandforge` npm package runs its commands as `npx sandforge <command>`,
on Node.js 20.19 or later. sfdx-hardis, in its default mode, runs from its
menus only a line that starts with `sf `, and it adds to them the entries an
installed plugin lists with `sf <plugin>:hardis-commands --json`. An sf
plugin is a package whose manifest has an `oclif` section; the usual way to
write one is to depend on `@oclif/core` and extend its `Command`.

Three things stood in the way, each measured against sf 2.154.4
(`@oclif/core` 5.1.2) on Node 22:

- `@oclif/core` 5 brings 39 packages and 4.4 MB, and asks for Node 22 or
  later: `npx sandforge` would fetch them at every cold start, and Node 20
  would meet `EBADENGINE`.
- A command that starts the script in a child process loses Ctrl-C. sf sets
  no SIGINT listener: sf dies at once and the child goes on writing after the
  shell's prompt. Had sf passed the signal on, the child would get two, and a
  second one tells the scripts to end at once, without the summary of what
  the run wrote.
- oclif answers `--help` and `-h`, anywhere before `--`, before it looks for
  the command, and its formatter trims each line: the 821 lines of
  `sandforge clone --help` came out with every indentation gone, `-h` under sf
  kept almost nothing, and the help of a verb (`pipeline plan --help`) could
  not be reached.

## Decision

- **No `@oclif/core`.** oclif takes for a command any export whose `run` is a
  function, whatever it extends. The build writes one small class per command
  into `lib/sf/sandforge/`, each with a static `run`, `strict = false` and no
  flags, and `oclif.manifest.json` beside them. The package keeps no
  dependency; its archive grows by 4,083 bytes.
- **In sf's process.** A command's `run` hands its words, unchanged, to the
  dispatcher `bin/sandforge.mjs` runs: no `--` removed, no flag added. One
  process, one signal: `sf sandforge mcp` ends on 130 on SIGINT, as
  `node bin/sandforge.mjs mcp` does, and exit codes 0, 1 and 2 come back as
  they are. The class first refuses a Node older than 20.19, in the words of
  `bin/`, since an sf before 2.150.5 may run on Node 18.6.
- **The help, from an `init` hook.** oclif runs `init` hooks before it reads
  `--help`. Given a SandForge command and `--help` or `-h` before `--`, the
  plugin's hook runs `bin/sandforge.mjs` with the same words and ends sf on
  its exit code; for any other command it does nothing.
  `sf sandforge clone --help` is then byte for byte
  `npx sandforge clone --help`. It costs a small module loaded by every sf
  command, within the noise of sf's start (medians of 0.71 s with it and
  0.77 s without, over ten alternating runs).
- **Never sf's default org.** No command reads `--target-org` or sf's default
  org, and none will for a write: a write needs the org named by its alias,
  under sf as under npx.
- **`sf sandforge:hardis-commands`**, hidden, gives sfdx-hardis four menu
  entries, each read only and reaching no org: `sf sandforge --help`,
  `sf sandforge seed --list-templates`, `sf sandforge env validate` and
  `sf sandforge env state`.

## Consequences

- Ending the process from an `init` hook, while the `init` hooks of other
  plugins run beside it, is not how oclif hooks are usually written. An oclif
  that ran `init` after its help test would show its own help again: the
  package's `check-sf` gate compares `sf sandforge … --help` with `bin/` on a
  pinned sf before each publication.
- The lines the commands print keep `npx sandforge`: they run wherever sf
  runs, a CI file included, at the latest version published rather than the
  plugin's.
- sf's telemetry records the command, the plugin and its version, the exit
  code and the time it took; of the flags, only those a command declares, and
  the plugin declares none.
- Proven with sf 2.154 on Node 22, on Linux. oclif 4 (an sf before 2.151),
  Node 20.19 under sf, macOS and Windows are not yet proven.
