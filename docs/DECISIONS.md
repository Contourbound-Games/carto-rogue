# Decisions

Approved product and design decisions. Add a dated entry when the developer approves a decision. Don't
record proposals here, and don't rewrite old entries; supersede them with a new entry that links back.

## Standing references

These documents hold earlier approved decisions in full. They remain the source of truth for their topics.

- [Steam 1.0 Scope](STEAM_1_0_SCOPE.md): shared core vs Steam-only content, and what is out of Steam 1.0.
- [Generator Versioning](GENERATOR_VERSIONING.md): mountain identity `{ generator, seed }`, determinism and
  the Standard golden fixture.

## 2026-10-10 — Development flow and CI

- The main Claude Code session owns design, implementation coordination, verification and the final
  verdict. Work-branch commits, pushes and PR creation are always allowed; direct commits or pushes to
  `main` and PR merges are not. The developer merges on GitHub.
- High-risk changes (as defined in `CLAUDE.md`) need an independent Codex review, run by the developer with
  `/codex:review --base main`, before they are called done or merged. Changing or removing existing tests
  is high-risk; adding new tests is not, by itself.
- Codex rescue is used only as a read-only diagnostician. The Codex review gate (Stop hook) stays disabled.
- GitHub Actions runs lint, tests and both edition builds on every push and pull request, with no path
  filters and no AI API calls.
- `docs/REPORT.md` records CI results only up to the commit that changed code. CI for a report-only push is
  checked but not written back.
