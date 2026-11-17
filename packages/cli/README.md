# sandforge

The command lines of [SandForge](https://github.com/StephaneBerthoz/sandforge), the VS Code extension that moves test data between Salesforce orgs, without the editor and without a checkout: seed an org from a template, clone a record or whole tables, run a Sync, take a checkpoint and rewind to it, mask an org, replay a Frozen Dataset, empty a sandbox, apply a `sandforge.yaml` — and an MCP server that gives these to an AI agent.

These are the scripts of the repository's `packages/extension/cli/`, bundled: the same guards, the same flags, the same exit codes.

## Requirements

- Node.js 20.19 or later.
- The Salesforce CLI (`sf`), logged in to every org you name: each command names an org by its alias (`sf alias list`) and takes its session from `sf`.

## Run

```sh
npx sandforge --help
npx sandforge clone --help
npx sandforge seed --target DEV --template <id> --dry-run
```

Installed with `npm install --global sandforge`, the command is `sandforge <command>`, and each one answers to its own name too, `sandforge-<command>`. The lines the commands print name them the way that runs anywhere, `npx sandforge checkpoint rewind --org DEV …`: npx takes the command installed when there is one. On npm, the packages named `sandforge-<command>` run nothing: each says the command to type instead.

## The MCP server

In Claude Code:

```sh
claude mcp add sandforge -- npx -y sandforge mcp
```

The tools, the `confirm` rule a write needs, and what each answer carries: [SandForge for AI agents](https://github.com/StephaneBerthoz/sandforge/blob/master/docs/mcp.md).

## Commands

| Command      | What it does                                                                |
| ------------ | --------------------------------------------------------------------------- |
| `autopilot`  | run an Autopilot copy between two orgs                                      |
| `backup`     | take and restore DataOps snapshots                                          |
| `checkpoint` | take a checkpoint of an org's data, and rewind the org to it                |
| `cleanup`    | Bulk delete records you created on a sandbox in a time window               |
| `clone`      | clone a record, or whole tables, from one org to a sandbox, or remove a run |
| `compare`    | compare two orgs the way the Compare page does                              |
| `dataops`    | mask an org's records, and put them back                                    |
| `empty`      | empty objects of a sandbox, or the whole of it                              |
| `env`        | apply a sandforge.yaml to an org, and take it back                          |
| `frozen`     | build and replay a Frozen Dataset                                           |
| `mcp`        | the MCP server: these scripts as tools for an AI agent, on stdio            |
| `monitor`    | read an org the way the Monitor page does                                   |
| `pipeline`   | plan and run an Automation pipeline exported from VS Code                   |
| `seed`       | fill an org from a seed template                                            |
| `sync`       | run a Sync between two orgs                                                 |

`sandforge <command> --help` gives its options and its exit codes. Every command refuses a flag it does not read with exit code `2`, before any org is reached; every command that writes to an org refuses a production one before it writes anything. What each one does, its flags, the exit codes and the pipelines that run them: [Command line & CI](https://github.com/StephaneBerthoz/sandforge/blob/master/ci-examples/README.md).

## As an sf plugin

The same package installs into the Salesforce CLI:

```sh
sf plugins trust allowlist add --name sandforge
sf plugins install sandforge
sf sandforge --help
sf sandforge clone --help
```

`sf sandforge <command>` is `npx sandforge <command>`: the same script, run in sf's own process, with the same flags, the same guards, the same exit codes and the same output, `--json` and the MCP server included. `--help` and `-h` print the command's own help, word for word. sf's own flags are not read: `--target-org` is refused with exit code `2` like any flag a command does not take, before any org is reached, and no command takes sf's default org. Each one names its org by its alias, with `--org`, `--source` or `--target`, as under npx.

**The question at install.** sf takes a plugin's signature from Salesforce's own site only, and Salesforce does not sign this one, so sf asks before it installs it, "sandforge isn't signed by Salesforce. Only install the plugin if you trust its creator. Do you want to continue the installation?", unless its name is on your allowlist. `sf plugins trust allowlist add --name sandforge` puts it there, once; it trusts the name, whatever version sf installs under it. Before you add it, check where the package was built: from 1.80.0, each version is published by the repository's own workflow with npm provenance, which `npm view sandforge dist.attestations` shows, and which `npm audit signatures` verifies in a folder where the package is installed.

**Node.** sf runs the commands on its own Node, and they need Node.js 20.19 or later there too. sf 2.150.5 and later run on Node 22 or later; on an older sf, which can run on an older Node, a Node before 20.19 is refused before anything runs, as `npx sandforge` refuses it.

**Telemetry.** sf records each command it runs, `sf sandforge clone` among them: the command, the plugin and its version, the exit code and the time it took. Of the flags, it records only those a command declares to it, and the plugin declares none: neither a flag of a SandForge command nor its value reaches it. `sf config set disable-telemetry=true`, or `SF_DISABLE_TELEMETRY=true`, turns it off. SandForge adds no telemetry of its own.

**The help hook.** Once installed, the plugin's `init` hook is loaded by every sf command, SandForge's or not. It prints a SandForge command's own help when `--help` or `-h` comes before any `--`, and does nothing for any other command.

The lines the commands print keep `npx sandforge …`, the line that takes a run back or the launcher of an exported pipeline: they run wherever sf runs, a CI job included. Out of a global install, npx runs the latest version published, which can be newer than the plugin's. `sf plugins uninstall sandforge` removes the plugin.

### In sfdx-hardis's menus

`sf sandforge:hardis-commands --json` gives the VS Code extension of sfdx-hardis a SandForge menu of four entries, each of them read only and none reaching an org:

- `sf sandforge --help`
- `sf sandforge seed --list-templates`
- `sf sandforge env validate`, which checks the `sandforge.yaml` of the folder the command runs in
- `sf sandforge env state`, which lists the environments kept on this machine

sfdx-hardis asks every plugin installed for its menu entries. To list SandForge in its Dependencies panel for everyone who works in a project, add it to the project's `.sfdx-hardis.yml`:

```yaml
customPlugins:
  - name: sandforge
    helpUrl: https://github.com/StephaneBerthoz/sandforge/blob/master/packages/cli/README.md#as-an-sf-plugin
```

From that panel, a click installs the plugin, or updates it, with `echo y|sf plugins:install sandforge@latest`, which answers yes to the question above. The SandForge menu, as sfdx-hardis shows it, is not yet proven.

### Where it is proven

On Linux, with sf 2.154 on Node 22. An sf before 2.151, which runs on oclif 4, is not yet proven, and neither is Node 20.19 under sf. macOS and Windows are not yet proven.

## Versions and license

The package is published with each release of the extension, at the same version. MIT; the notices of the packages it bundles are in `THIRD-PARTY-NOTICES.md`.
