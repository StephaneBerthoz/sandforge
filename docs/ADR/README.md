# Architecture Decision Records

ADRs record the decisions that shape SandForge and that future contributors
must not silently undo. One decision per file, immutable once Accepted.
Change course by adding a new ADR that supersedes the old one.

(`DECISIONS.md` at the repo root is the older, free-form decision log from
the genesis line. New decisions go here.)

## Format

- File name: `NNNN-<kebab-case-slug>.md`, zero-padded, monotonically
  increasing. Take the next number; never reuse one.
- Sections: **Status**, **Date**, **Context**, **Decision**,
  **Consequences**. Keep it short: one page max.
- Statuses:
  - `Proposed`: under discussion, not yet binding.
  - `Accepted`: binding; code and reviews must follow it.
  - `Deprecated`: no longer relevant, kept for history.
  - `Superseded by NNNN`: replaced by a newer ADR (link both ways).

## Index

| # | Title | Status | Date |
|---|-------|--------|------|
| [0001](./0001-pnpm-11-settings-migration.md) | pnpm 11 settings migration | Accepted | 2026-08-03 |
| [0002](./0002-message-contract-zero-drift.md) | Message contract zero-drift | Accepted | 2026-08-03 |
| [0003](./0003-frozen-dataset-salt-model.md) | Frozen dataset salt model | Accepted | 2026-08-03 |
