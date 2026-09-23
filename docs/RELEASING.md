# Releasing symbol-mcp-server

For maintainers. A release puts one version in three places, all from the same npm tarball:

- **npm**, published by the release workflow through trusted publishing (OIDC) with provenance.
  No npm token exists, locally or in the repository.
- **GitHub Releases**: the notes from `CHANGELOG.md`, the tarball as npm serves it, npm's
  provenance bundle for it, and the Claude Desktop bundle (`.mcpb`) with a build provenance
  attestation.
- **MCP Registry**: the entry in `server.json`, published by hand with `mcp-publisher`.

An agent may prepare the changelog and `package.json` of a release PR. Everything else below is done
by a maintainer: `server.json` and `package-lock.json` are protected files, and agents never create
tags, approve deployments or publish.

## Steps

| # | Step | Who |
|---|---|---|
| 1 | Release PR: `CHANGELOG.md` and `package.json` | agent or maintainer |
| 2 | Same PR: `server.json` and `package-lock.json` | maintainer |
| 3 | Merge when CI is green | maintainer |
| 4 | Tag `vX.Y.Z` and push the tag | maintainer |
| 5 | Approve the `npm-publish` environment | maintainer |
| 6 | `publish` job: npm with provenance | release workflow |
| 7 | `github-release` job: notes and assets | release workflow |
| 8 | Check the release | maintainer |
| 9 | Publish to the MCP Registry | maintainer |

### 1. Release PR: changelog and version

On a branch such as `chore/release-X.Y.Z`, with the title `chore: release X.Y.Z`:

- `CHANGELOG.md`: the entries under `## [Unreleased]` move to a new `## [X.Y.Z] - YYYY-MM-DD`
  section below an empty `## [Unreleased]` heading. At the bottom, `[Unreleased]` compares
  `vX.Y.Z...HEAD`, and a new `[X.Y.Z]` line compares the previous tag with `vX.Y.Z`.
- `package.json`: `"version": "X.Y.Z"`.
- `node scripts/release-notes.mjs X.Y.Z` prints the new section. The release workflow uses this
  output as the release notes and fails when the section is missing or empty.

The version follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html), as the changelog
states.

### 2. Same PR: registry entry and lockfile

- `server.json`: `version` and `packages[0].version` become `X.Y.Z`.
- `package-lock.json`: let npm write it, never edit it by hand, for example
  `npm install --package-lock-only --ignore-scripts`. Only the root `version` and
  `packages[""].version` should change; check with `git diff package-lock.json`.

Until this commit is in, the docs-sync test fails: it checks that `server.json` and
`package-lock.json` carry the version of `package.json` (`test/unit/docs-sync.test.ts`). The
`protected-files` CI check accepts the `server.json` change only because the PR's author is the
maintainer's account; it looks at the author, not at who made each commit. `package-lock.json` is
not on its list, so review that diff yourself.

### 3. Merge

Merge when CI is green (lint, typecheck, tests and build on Node 22 and 24, `npm audit`,
dependency review, protected files, CodeQL).

### 4. Tag

```sh
git switch main
git pull --ff-only
git log -1 --format=%s     # chore: release X.Y.Z (#NN)
git tag vX.Y.Z
git push origin vX.Y.Z
```

A pushed tag that matches `v*.*.*` starts `.github/workflows/release.yml`.

### 5. Approve

The `publish` job waits in the `npm-publish` GitHub Environment, whose required reviewer is the
maintainer. Open the run (Actions, "Release (npm trusted publishing)", the run for `vX.Y.Z`), check
that it is the tag you pushed, and approve it with **Review deployments**.

### 6. `publish` job

On Node 24, with a check that npm is 11.5.1 or newer (needed for trusted publishing):
`npm ci --ignore-scripts`, lint, typecheck, tests, build, a check that the tag equals the
`package.json` version, then `npm publish --access public --provenance`. npm exchanges the job's
OIDC token for the publish; the provenance attestation links the version to this commit and run.

### 7. `github-release` job

Runs only after `publish` succeeded:

1. `node scripts/release-notes.mjs X.Y.Z > notes.md`: the changelog section as release notes.
2. `bash scripts/release-assets.sh X.Y.Z assets`: waits until the registry shows the new version's
   attestations (up to `RELEASE_ASSETS_WAIT` seconds, default 300), then saves the tarball exactly
   as npm serves it (`symbol-mcp-server-X.Y.Z.tgz`, checked against the registry's
   `dist.integrity`) and npm's SLSA provenance bundle for it
   (`symbol-mcp-server-X.Y.Z.tgz.sigstore.json`, whose subject is checked).
3. `bash scripts/build-mcpb.sh X.Y.Z assets/symbol-mcp-server-X.Y.Z.tgz assets`: the Claude Desktop
   bundle, from that tarball and the production dependencies of this commit's lockfile.
4. `actions/attest`: a GitHub build provenance attestation for the `.mcpb`.
5. `gh release create vX.Y.Z assets/* --notes-file notes.md --verify-tag --title vX.Y.Z`.

### 8. Check the release

```sh
gh release view vX.Y.Z      # the notes, and three assets: .tgz, .tgz.sigstore.json, .mcpb
gh release download vX.Y.Z --dir /tmp/release-X.Y.Z
cd /tmp/release-X.Y.Z
gh attestation verify symbol-mcp-server-X.Y.Z.tgz \
  --bundle symbol-mcp-server-X.Y.Z.tgz.sigstore.json \
  --repo inotakeh/symbol-mcp-server --digest-alg sha512
gh attestation verify symbol-mcp-server-X.Y.Z.mcpb --repo inotakeh/symbol-mcp-server
npm view symbol-mcp-server@X.Y.Z dist.attestations
```

`--digest-alg sha512` is needed because npm's provenance names the tarball by its SHA-512. The
README section "Release integrity" shows users the same checks.

### 9. MCP Registry

The Registry checks the npm package of the version it is given and refuses one it cannot see yet,
so wait until npm shows the new version:

```sh
npm view symbol-mcp-server dist-tags.latest     # X.Y.Z
mcp-publisher login github
mcp-publisher publish                           # publishes server.json
```

Install `mcp-publisher` as the [Registry quickstart](https://modelcontextprotocol.io/registry/quickstart)
describes. Then look for the entry at
https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.inotakeh/symbol. This step
is manual until the release workflow publishes to the Registry itself.

## When something fails

- **`publish` fails before `npm publish`** (tests, or a tag that does not match `package.json`):
  nothing was published. Delete the tag (`git push origin :refs/tags/vX.Y.Z`, then
  `git tag -d vX.Y.Z`), fix the problem on `main` through a PR, and tag again.
- **`github-release` fails**: the version is already on npm. If the failed run already created a
  release or a draft for `vX.Y.Z` (for example when an upload failed), delete it first with
  `gh release delete vX.Y.Z`, which keeps the tag; otherwise the re-run stops at "release already
  exists". Then re-run the failed job from the run's page. Only the workflow can attach the build
  provenance to the `.mcpb`, so prefer a re-run to a release created by hand.
- **The Registry refuses the version**: npm does not show it yet, or `server.json` does not carry
  the version of `package.json`. Wait, check both, and publish again.

## Backfilling or recreating an older release

A GitHub Release can be made or remade for a version that is already on npm, for example to attach
the tarball and its provenance bundle to an older release (OpenSSF Scorecard's Signed-Releases
check averages the last five releases). From `main`, whose changelog has every released section:

```sh
node scripts/release-notes.mjs A.B.C > /tmp/notes-A.B.C.md
bash scripts/release-assets.sh A.B.C /tmp/assets-A.B.C
gh release create vA.B.C /tmp/assets-A.B.C/* --notes-file /tmp/notes-A.B.C.md \
  --verify-tag --title vA.B.C --latest=false
```

- `--latest=false` keeps the newest version marked Latest, which the README's download link uses.
- To remake an existing release, delete it first with `gh release delete vA.B.C` (this keeps the
  tag). To change only the notes, use `gh release edit vA.B.C --notes-file …`; to replace assets,
  `gh release upload vA.B.C <files> --clobber`.
- A `.mcpb` exists from 0.8.0 on. One built by hand (CONTRIBUTING, "Building the Claude Desktop
  bundle") has no build provenance attestation, so `gh attestation verify` fails for it; leave it
  out of a backfilled release.

## OpenSSF Scorecard

`.github/workflows/scorecard.yml` runs on every push to `main` and weekly (Mondays 01:30 UTC). It
publishes the results to the Scorecard API, which the README badge shows, and uploads them to
code scanning.

- Score and checks: https://scorecard.dev/viewer/?uri=github.com/inotakeh/symbol-mcp-server
  (the same data as JSON: https://api.scorecard.dev/projects/github.com/inotakeh/symbol-mcp-server).
- Findings: the repository's **Security → Code scanning**, tool "Scorecard".
- A new release counts from the first run after the GitHub Release exists: the weekly run or the
  next push to `main`. The push of the release merge itself comes before the release.
