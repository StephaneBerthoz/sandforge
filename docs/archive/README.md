# docs/archive: Historical genesis documents

Everything under this directory is **historical**, kept for reference only.
These documents drove the genesis of SandForge (project bootstrap through the
last genesis-phase release, May 2026) but are **non-normative**: they do not
describe the current architecture, workflow, or conventions. When they
contradict the rest of the repo, the rest of the repo wins.

For current documentation, see:

- `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md` at the repo root
- `docs/modules/` for per-module user guides
- `docs/ADR/` for accepted architectural decisions
- `.planning/` for the active milestone plans

## Contents

- `prompts/`: the 4 "mega-prompts" used to generate the original codebase
  with Claude Code (modules 2, 3+4, 6+7+8, and the combined ALL variant).
  Consumed; kept as the project's genesis record.
- `plans/`: root-era and `docs/`-era execution plans from the genesis line
  (BEST-IN-CLASS plan, CLAUDE-CODE-PROMPT, intelligence-upgrade plan, and the
  2026-02/03 design+implementation pairs for autopilot v3, UI redesign, graph
  discovery guardrails, org-connection fix).
- `phases/`: the 13 phase files (`phase-00-bootstrap` …
  `phase-12-advanced-features`) of the original phase-by-phase build lineage.
  Superseded by `.planning/phases/`.
- `AUDIT.md`: comprehensive audit report v2, already marked HISTORICAL in
  its own banner (predates the internal v3.x → public v1.0.0 baseline reset).
- `FULL-PROMPT.md`: the original single-shot full build prompt (~66 KB),
  later split into the phase files above.

## Why keep them?

They explain *why* the codebase looks the way it does (module boundaries,
pattern choices, the phase lineage). Consult them for archaeology, not for
guidance. Do not link to them from living documentation.
