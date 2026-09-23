#!/usr/bin/env bash
# Collects the GitHub Release assets of one published version:
#
#   <outdir>/symbol-mcp-server-<version>.tgz                 the tarball exactly as npm serves it
#   <outdir>/symbol-mcp-server-<version>.tgz.sigstore.json   npm's SLSA provenance sigstore bundle
#
#   scripts/release-assets.sh 0.7.0 assets
#
# Used by the github-release job of .github/workflows/release.yml, and by maintainers to backfill
# releases of older versions (OpenSSF Scorecard's Signed-Releases averages the last five releases).
# Checks, in order: the tarball's sha512 equals the registry's dist.integrity, and the bundle's
# provenance subject is this package version with the tarball's sha512. Any mismatch aborts.
#
# Needs bash, node (>= 22, for fetch) and npm; no jq, curl or GNU coreutils, so it also runs on
# macOS. Reads only public registry data; no token is used. Exit: 0 done, 1 failed, 2 usage.
# RELEASE_ASSETS_WAIT (seconds, default 300) bounds the wait for a version that was just published.
set -euo pipefail

usage() {
  echo "usage: scripts/release-assets.sh <version> <outdir>   (e.g. 0.7.0 assets)" >&2
  exit 2
}
fail() {
  echo "release-assets: $*" >&2
  exit 1
}

[ "$#" -eq 2 ] || usage
version="${1#v}"
outdir="$2"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || usage
[ -n "$outdir" ] || usage

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
name="$(node -p 'require(process.argv[1]).name' "$script_dir/../package.json")"
spec="$name@$version"
mkdir -p "$outdir"

# 1. The registry can lag behind a publish that just finished: wait for the attestations URL.
wait_total="${RELEASE_ASSETS_WAIT:-300}"
waited=0
attestations_url=""
while :; do
  attestations_url="$(npm view "$spec" dist.attestations.url 2>/dev/null || true)"
  [ -n "$attestations_url" ] && break
  [ "$waited" -ge "$wait_total" ] &&
    fail "$spec has no dist.attestations.url after ${waited}s (not published, or published without provenance)."
  sleep 15
  waited=$((waited + 15))
done

# 2. The tarball exactly as published, checked against the registry's integrity string.
tarball_name="$(npm pack "$spec" --pack-destination "$outdir" --json |
  node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>console.log(JSON.parse(s)[0].filename))')"
tarball="$outdir/$tarball_name"
[ -f "$tarball" ] || fail "npm pack did not write $tarball."
expected_integrity="$(npm view "$spec" dist.integrity)"
actual_integrity="$(node -e '
  const { createHash } = require("node:crypto");
  const data = require("node:fs").readFileSync(process.argv[1]);
  console.log("sha512-" + createHash("sha512").update(data).digest("base64"));
' "$tarball")"
[ "$actual_integrity" = "$expected_integrity" ] ||
  fail "$tarball_name integrity $actual_integrity does not match the registry's $expected_integrity."

# 3 + 4. npm's SLSA provenance bundle, kept only if its subject is this version and this tarball.
bundle="$tarball.sigstore.json"
# NODE_USE_ENV_PROXY makes fetch honour HTTPS_PROXY like npm does (no effect without a proxy).
NODE_USE_ENV_PROXY=1 node - "$attestations_url" "$tarball" "$bundle" "pkg:npm/$spec" <<'NODE'
const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const [url, tarball, bundlePath, purl] = process.argv.slice(2);
const SLSA_V1 = 'https://slsa.dev/provenance/v1';
(async () => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} answered HTTP ${response.status}`);
  const { attestations } = await response.json();
  const found = (attestations ?? []).find((a) => a.predicateType === SLSA_V1);
  if (!found?.bundle?.dsseEnvelope?.payload) throw new Error(`no ${SLSA_V1} bundle at ${url}`);
  const statement = JSON.parse(Buffer.from(found.bundle.dsseEnvelope.payload, 'base64').toString());
  const digest = createHash('sha512').update(readFileSync(tarball)).digest('hex');
  const subject = (statement.subject ?? []).find((s) => s.name === purl);
  if (!subject) throw new Error(`provenance has no subject ${purl}`);
  if (subject.digest?.sha512 !== digest) {
    throw new Error(`provenance subject sha512 ${subject.digest?.sha512} is not the tarball's ${digest}`);
  }
  writeFileSync(bundlePath, `${JSON.stringify(found.bundle)}\n`);
})().catch((err) => {
  console.error(`release-assets: ${err.message}`);
  process.exit(1);
});
NODE

echo "$tarball"
echo "$bundle"
