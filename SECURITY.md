# Security Policy

SandForge is a VS Code extension that handles Salesforce credentials,
sandbox data, and CI/CD pipelines. Reports of vulnerabilities are taken
seriously.

## Supported versions

Only the latest minor on the marketplace receives security fixes.

| Version | Supported |
| ------- | --------- |
| 1.2.x   | Yes       |
| < 1.2   | No        |

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
- Path traversal via CLI flags (`sandforge-clone`, `recipe-forge-grappe`)
- CSP bypass in webview panels (nonce, sources, sandbox)
- Privilege escalation in pipeline steps (approval gate, conditional router)
- AI prompt injection via record-derived content
- Webview ↔ extension bridge: message spoofing, schema bypass

## Out of scope

- Vulnerabilities in upstream dependencies — please report those upstream
  (we will follow up if a fix is required on our side)
- Issues that require write access to the user's machine to reproduce
- Issues affecting unsupported VS Code versions (< 1.95)

## Hardening references

- `changelog.md` `### Security` entries — historical security fixes
