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
| `seed`       | fill an org from a seed template                                            |
| `sync`       | run a Sync between two orgs                                                 |

`sandforge <command> --help` gives its options and its exit codes. Every command refuses a flag it does not read with exit code `2`, before any org is reached; every command that writes to an org refuses a production one before it writes anything. What each one does, its flags, the exit codes and the pipelines that run them: [Command line & CI](https://github.com/StephaneBerthoz/sandforge/blob/master/ci-examples/README.md).

## Versions and license

The package is published with each release of the extension, at the same version. MIT; the notices of the packages it bundles are in `THIRD-PARTY-NOTICES.md`.
