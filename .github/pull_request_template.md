## Summary

<!-- What changes and why. Link the issue if there is one. -->

## How verified

<!-- Commands you ran and their results (e.g. `npm test`: N passed), plus any manual check (Inspector, a live node). -->

## Checklist

- [ ] `npm run lint` passes
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] New behaviour has tests
- [ ] No protected file touched (`.claude/**`, `.github/workflows/**`, `CODEOWNERS`, `AGENTS.md`, `CLAUDE.md`, `SECURITY.md`, `server.json`, `LICENSE`, `.npmrc`, lockfiles), unless a maintainer asked for it

If this PR adds or changes a tool:

- [ ] `README.md` and `README.ja.md` (tool table; an example question for a new tool)
- [ ] `evals/cases.json`
- [ ] `docs/DESIGN-BRIEF.md` §5
- [ ] `CHANGELOG.md` under `[Unreleased]`
