## Summary

<!-- What changes and why. Link the issue if there is one. -->

## How verified

<!-- Commands you ran and their results (e.g. `npm test`: N passed), plus any manual check (Inspector, a live node). -->

## Checklist

- [ ] `npm run lint` passes
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] New behaviour has tests
- [ ] No protected file touched (`.claude/**`, `.github/**`, `AGENTS.md`, `CLAUDE.md`, `SECURITY.md`, `LICENSE`, `server.json`, `mcpb/manifest.json`, `.npmrc`, lockfiles), unless a maintainer asked for it

If this PR adds or changes a tool:

- [ ] `README.md` and `README.ja.md` (tool table; an example question for a new tool)
- [ ] `evals/cases.json`
- [ ] `docs/DESIGN-BRIEF.md` §5 (the tool's specification and the tool lists in §5 "共通規約") and the tool count in §2-2
- [ ] `CHANGELOG.md` under `[Unreleased]`
