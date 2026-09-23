# Releasing symbol-mcp-server

For maintainers. A release puts one version in three places, all from the same npm tarball:

- **npm**, published by the release workflow through trusted publishing (OIDC) with provenance.
  No npm token exists, locally or in the repository.
- **GitHub Releases**: the notes from `CHANGELOG.md`, the tarball as npm serves it, npm's
  provenance bundle for it, and the Claude Desktop bundle (`.mcpb`) with a build provenance
  attestation.
- **MCP Registry**: the entry in `server.json`, published by the release workflow with
  `mcp-publisher` and the job's GitHub OIDC token. No Registry token exists either.

An agent may prepare the changelog and `package.json` of a release PR. Everything else below is done
by a maintainer: `server.json`, `package-lock.json` and the workflows are protected files, and
agents never create tags, approve deployments or publish.

## Steps

| # | Step | Who |
|---|---|---|
| 1 | Release PR: `CHANGELOG.md` and `package.json` | agent or maintainer |
| 2 | Same PR: `server.json` and `package-lock.json` | maintainer |
| 3 | Merge when CI is green | maintainer |
| 4 | Tag `vX.Y.Z` and push the tag | maintainer |
| 5 | Approve the `npm-publish` environment | maintainer |
| 6 | `publish` job: checks, then npm with provenance | release workflow |
| 7 | `github-release` job: notes and assets (after 6, alongside 8) | release workflow |
| 8 | `registry` job: the MCP Registry (after 6, alongside 7) | release workflow |
| 9 | Check the release | maintainer |

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

Then `node scripts/release-check.mjs X.Y.Z` prints one line when the release files agree: `X.Y.Z` in
`package.json`, `package-lock.json` and `server.json`, `server.json` naming this npm package and its
`mcpName`, and a dated `CHANGELOG.md` section with notes. Otherwise it lists every difference. The
`publish` job runs the same check first.

Until this commit is in, the docs-sync test fails: it checks that `server.json` and
`package-lock.json` carry the version of `package.json` (`test/unit/docs-sync.test.ts`). The
release-check test (`test/unit/release-check.test.ts`) fails too, for the same reason. The
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
that it is the tag you pushed, and approve it with **Review deployments**. This one approval
releases everything: `github-release` and `registry` have no environment and start only when
`publish` has succeeded.

### 6. `publish` job

First, before anything is installed or published, `node scripts/release-check.mjs X.Y.Z` (step 2):
the tag's version must be in `package.json`, `package-lock.json` (root and `packages[""]`) and
`server.json` (`version` and every `packages[].version`), `server.json`'s `name` must be
`package.json`'s `mcpName` and its npm package this one, and `CHANGELOG.md` must have the version's
section. A version on npm cannot be changed, and the MCP Registry accepts it only when its `mcpName`
is `server.json`'s `name`, so a difference stops the run here.

Then, on Node 24, with a check that npm is 11.5.1 or newer (needed for trusted publishing):
`npm ci --ignore-scripts`, lint, typecheck, tests, build, then
`npm publish --access public --provenance`. npm exchanges the job's OIDC token for the publish; the
provenance attestation links the version to this commit and run.

### 7. `github-release` job

Runs once `publish` has succeeded, alongside `registry`:

1. `node scripts/release-notes.mjs X.Y.Z > notes.md`: the changelog section as release notes.
2. `bash scripts/release-assets.sh X.Y.Z assets`: waits until the registry shows the new version's
   attestations (`scripts/wait-for-npm.sh`, up to `RELEASE_ASSETS_WAIT` seconds, default 300), then
   saves the tarball exactly as npm serves it (`symbol-mcp-server-X.Y.Z.tgz`, checked against the
   registry's `dist.integrity`) and npm's SLSA provenance bundle for it
   (`symbol-mcp-server-X.Y.Z.tgz.sigstore.json`, whose subject is checked).
3. `bash scripts/build-mcpb.sh X.Y.Z assets/symbol-mcp-server-X.Y.Z.tgz assets`: the Claude Desktop
   bundle, from that tarball and the production dependencies of this commit's lockfile.
4. `actions/attest`: a GitHub build provenance attestation for the `.mcpb`.
5. `gh release create vX.Y.Z assets/* --notes-file notes.md --verify-tag --title vX.Y.Z`.

### 8. `registry` job

Runs once `publish` has succeeded, alongside `github-release`: the Registry entry names the npm
package, not the GitHub Release, so a failure there does not hold it back. The job has only
`contents: read` and `id-token: write`.

1. `bash scripts/wait-for-npm.sh symbol-mcp-server@X.Y.Z mcpName io.github.inotakeh/symbol` (the
   names come from `package.json` and `server.json`): waits, up to `NPM_WAIT` seconds (default
   300), until npm shows the version with the `mcpName` that the Registry compares with
   `server.json`'s `name`. The Registry refuses a version that npm does not show yet.
2. Downloads `mcp-publisher_linux_amd64.tar.gz` of the pinned `mcp-publisher` release and checks
   its SHA-256 before unpacking it ([Updating mcp-publisher](#updating-mcp-publisher)).
3. `mcp-publisher login github-oidc`: exchanges the job's GitHub OIDC token for a short-lived
   Registry token. The Registry grants `io.github.<repository owner>/*` from the token's
   `repository_owner` claim and looks at nothing else: a workflow in any repository of the owner
   that has `id-token: write` could publish under `io.github.inotakeh/`. Give that permission only
   to jobs that need it, in every repository of the account.
4. `mcp-publisher publish`: publishes `server.json`.

### 9. Check the release

```sh
gh run list --workflow release.yml --limit 1     # the run for vX.Y.Z and its conclusion
gh release view vX.Y.Z      # the notes, and three assets: .tgz, .tgz.sigstore.json, .mcpb
gh release download vX.Y.Z --dir /tmp/release-X.Y.Z
cd /tmp/release-X.Y.Z
gh attestation verify symbol-mcp-server-X.Y.Z.tgz \
  --bundle symbol-mcp-server-X.Y.Z.tgz.sigstore.json \
  --repo inotakeh/symbol-mcp-server --digest-alg sha512
gh attestation verify symbol-mcp-server-X.Y.Z.mcpb --repo inotakeh/symbol-mcp-server
npm view symbol-mcp-server@X.Y.Z dist.attestations
curl -fsS "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.inotakeh%2Fsymbol/versions/X.Y.Z"
```

`--digest-alg sha512` is needed because npm's provenance names the tarball by its SHA-512. The
README section "Release integrity" shows users the same checks. The last command prints the
Registry entry of this version; all versions are listed at
https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.inotakeh/symbol.

## When something fails

`github-release` and `registry` do not depend on each other: when one fails, the other still runs.
**Re-run failed jobs** on the run's page runs only the jobs that failed again; `publish`, which
succeeded, is not repeated. A run can be re-run for 30 days after it started, and a re-run uses the
workflow and the commit of the tag.

- **`publish` fails before `npm publish`** (the release files check, tests, a build error): nothing
  was published. Delete the tag (`git push origin :refs/tags/vX.Y.Z`, then `git tag -d vX.Y.Z`),
  fix the problem on `main` through a PR, and tag again.
- **`github-release` fails**: the version is already on npm, and the Registry entry does not depend
  on this job. If the failed run already created a release or a draft for `vX.Y.Z` (for example
  when an upload failed), delete it first with `gh release delete vX.Y.Z`, which keeps the tag;
  otherwise the re-run stops at "release already exists". Then re-run the failed job. Only the
  workflow can attach the build provenance to the `.mcpb`, so prefer a re-run to a release created
  by hand.
- **`registry` fails**: the version is on npm, the GitHub Release does not depend on this job, and
  nothing needs to be undone. The job's summary says so; the log of the failed step says why:
  - `wait-for-npm: npm does not show mcpName …`, or the Registry answers that the version was not
    found: npm had not caught up yet. Re-run the failed job.
  - `… already exists`: the Registry already has this version (an earlier attempt got through).
    Check it with the last command of step 9.
  - `invalid audience` at the login: the pinned `mcp-publisher` is too old for the Registry.
    Publish by hand (below) with a current `mcp-publisher`, then
    [update the pin](#updating-mcp-publisher).
  - A validation error (HTTP 422): fix `server.json` on `main` through a PR, keeping `version` at
    `X.Y.Z`, then publish by hand from that `main`.
  - Anything else, or a run older than 30 days: publish by hand.

### Publishing to the MCP Registry by hand

The Registry checks the npm package of the version it is given and refuses one it cannot see yet,
so wait until npm shows the new version with its `mcpName`:

```sh
npm view symbol-mcp-server@X.Y.Z mcpName        # io.github.inotakeh/symbol
mcp-publisher login github
mcp-publisher publish                           # publishes server.json of this checkout
```

Run it from a checkout of `vX.Y.Z`, or of `main` after a fix to `server.json` (its `version` must
still be `X.Y.Z`). Install `mcp-publisher` as the
[Registry quickstart](https://modelcontextprotocol.io/registry/quickstart) describes; `login github`
signs in through GitHub in the browser. Then check the entry as in step 9.

## Updating mcp-publisher

The `registry` job runs one `mcp-publisher` release, pinned in `.github/workflows/release.yml` by
`MCP_PUBLISHER_VERSION` and `MCP_PUBLISHER_SHA256`, the SHA-256 of its
`mcp-publisher_linux_amd64.tar.gz`. Dependabot does not update them. Change both in a PR (the
workflow is a protected file) when the Registry refuses the pinned release (`invalid audience`) or
when a newer release is wanted. Releases from before 2026-04-30 fail with `invalid audience`: since
then `mcp-publisher` derives the OIDC audience from the Registry URL.

The Registry's release workflow signs each release's checksums file with cosign (keyless), so check
that signature before taking the SHA-256 from the file:

```sh
v=X.Y.Z   # a release of https://github.com/modelcontextprotocol/registry/releases
d=$(mktemp -d)
gh release download "v$v" --repo modelcontextprotocol/registry --dir "$d" \
  --pattern mcp-publisher_linux_amd64.tar.gz --pattern "registry_${v}_checksums.txt*"
cd "$d"
cosign verify-blob "registry_${v}_checksums.txt" \
  --bundle "registry_${v}_checksums.txt.sigstore.json" \
  --certificate-identity "https://github.com/modelcontextprotocol/registry/.github/workflows/release.yml@refs/tags/v$v" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
grep ' mcp-publisher_linux_amd64.tar.gz$' "registry_${v}_checksums.txt" | sha256sum --check
grep ' mcp-publisher_linux_amd64.tar.gz$' "registry_${v}_checksums.txt"   # the SHA-256 to pin
```

`cosign` is available from Homebrew (`brew install cosign`).

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
- Pinned-Dependencies counts every action that is not pinned to a commit SHA, and every download
  that is piped into a shell or saved and then run. When a workflow needs a tool, download one
  version and check its SHA-256 before running it, as the `registry` job does with `mcp-publisher`;
  never `curl … | sh` or a `latest` URL.
