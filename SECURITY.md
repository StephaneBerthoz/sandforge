# Security Policy

SandForge is a VS Code extension that handles Salesforce credentials,
sandbox data, and CI/CD pipelines. Reports of vulnerabilities are taken
seriously.

## Supported versions

Only the latest minor on the marketplace receives security fixes.

| Version | Supported |
| ------- | --------- |
| 1.84.x  | Yes       |
| < 1.84  | No        |

## Reporting a vulnerability

**Do not** open a public GitHub issue for security reports.

Email the maintainer: **stephane.berthoz@gmail.com**

Please include:

- A description of the issue and its security impact
- Reproduction steps (PoC, scripts, sample payloads)
- The version of SandForge / VS Code / Node you reproduced on
- Whether you would like to be credited in the changelog

You can expect:

- An acknowledgement within **5 business days**
- A triage update within **10 business days**
- A coordinated disclosure timeline once the severity is agreed
- A `Security` entry in `CHANGELOG.md` once the fix ships, with credit

## In scope

- Credential exposure (org tokens, secrets stored via the
  `vscode.SecretStorage` adapter)
- SOQL/SOQL-like injection in Forge / Clone / Seed paths
- Path traversal via CLI flags (`sandforge-clone`)
- CSP bypass in webview panels (nonce, sources, sandbox)
- Privilege escalation in pipeline steps (approval gate, conditional router)
- AI prompt injection via record-derived content
- Webview ↔ extension bridge: message spoofing, schema bypass
- The sf plugin of the `sandforge` npm package, its `init` hook included

## Out of scope

- Vulnerabilities in upstream dependencies — please report those upstream
  (we will follow up if a fix is required on our side)
- Issues that require write access to the user's machine to reproduce
- Issues affecting unsupported VS Code versions (< 1.95)

## The sf plugin

The `sandforge` npm package installs into the Salesforce CLI as a plugin.
Salesforce does not sign it: sf takes a plugin's signature from Salesforce's
own site only, so it asks before it installs this one, unless its name is on
your allowlist (`sf plugins trust allowlist add --name sandforge`, then
`sf plugins install sandforge`). The allowlist trusts the name, whatever
version sf installs under it later.

What to check instead is where the package was built. From 1.80.0, each
version is published by this repository's `npm-publish.yml` workflow, by
OIDC and with npm provenance, which ties the version to the commit and the
run that built it: `npm view sandforge dist.attestations` shows it, and
`npm audit signatures`, in a folder where the package is installed, verifies
its registry signature and that attestation.

Once the plugin is installed, sf loads its `init` hook before every sf
command, SandForge's or not. The hook reads the command line: when the
command is one of SandForge's and `--help` or `-h` comes before any `--`, it
prints that command's own help, by running the package's
`bin/sandforge.mjs` with the same words, and ends sf on its exit code; for
any other command it does nothing. The commands themselves run in sf's
process, with the guards they have under `npx sandforge`.

## Webview hardening

- Scripts run only with the nonce generated for each render
  (`script-src 'nonce-…'`).
- Styles are allowed from the webview origin and `'unsafe-inline'`. The
  inline part cannot be dropped today: the dialog scroll lock inserts a
  `<style>` element at runtime, and the sparkline, the graph edge animation
  and one overlay render `<style>` blocks. Without `'unsafe-inline'` the
  policy blocks all four.
- `localResourceRoots` is the packaged `webview-dist` folder only, so a
  webview cannot load any other file shipped with the extension.

## Hardening references

- `changelog.md` `### Security` entries — historical security fixes
