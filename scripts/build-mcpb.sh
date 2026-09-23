#!/usr/bin/env bash
# Builds the Claude Desktop bundle <outdir>/symbol-mcp-server-<version>.mcpb from the npm tarball
# that release-assets.sh downloaded and checked:
#
#   scripts/build-mcpb.sh 0.7.1 assets/symbol-mcp-server-0.7.1.tgz assets
#
# A .mcpb is a plain zip with manifest.json at its root (the optional signature block of
# `mcpb sign` is not used). Layout:
#   manifest.json   mcpb/manifest.json with the version and the tools / prompts of this build
#   icon.png        mcpb/icon.png
#   server/         dist, package.json, README.md, LICENSE from the tarball, plus the production
#                   node_modules installed with `npm ci --omit=dev` from this repository's lockfile
# The lockfile must be the one of <version> (checked), so run it from the release commit.
#
# Needs bash, node, npm, tar, zip and unzip (all present on macOS and ubuntu-latest). The work
# directory is left in place and printed, for inspection. Exit: 0 done, 1 failed, 2 usage.
set -euo pipefail

usage() {
  echo "usage: scripts/build-mcpb.sh <version> <tarball> <outdir>   (e.g. 0.7.1 assets/symbol-mcp-server-0.7.1.tgz assets)" >&2
  exit 2
}
fail() {
  echo "build-mcpb: $*" >&2
  exit 1
}

[ "$#" -eq 3 ] || usage
version="${1#v}"
tarball="$2"
outdir="$3"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || usage
[ -n "$outdir" ] || usage
[ -f "$tarball" ] || fail "tarball $tarball not found."

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$outdir"
out="$(cd "$outdir" && pwd)/symbol-mcp-server-$version.mcpb"
[ -e "$out" ] && fail "$out already exists."

work="$(mktemp -d "${TMPDIR:-/tmp}/build-mcpb.XXXXXX")"
staging="$work/staging"
server="$staging/server"
mkdir -p "$server"

# 1. The published package: only what the server needs at run time.
tar -xzf "$tarball" -C "$work"
for entry in dist package.json README.md LICENSE; do
  [ -e "$work/package/$entry" ] || fail "the tarball has no package/$entry."
  cp -R "$work/package/$entry" "$server/"
done

# 2. Production dependencies, exactly as locked for this version.
cp "$repo/package-lock.json" "$server/package-lock.json"
node - "$server" "$version" <<'NODE'
const { readFileSync } = require('node:fs');
const [dir, version] = process.argv.slice(2);
const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
const lock = JSON.parse(readFileSync(`${dir}/package-lock.json`, 'utf8'));
const found = { 'package.json': pkg.version, 'package-lock.json': lock.version };
for (const [file, v] of Object.entries(found)) {
  if (v !== version) {
    console.error(`build-mcpb: ${file} is ${v}, not ${version}. Build from the commit of that release.`);
    process.exit(1);
  }
}
NODE
(cd "$server" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)

# 3. Manifest (release version, tools and prompts of this build) and icon.
node "$repo/scripts/mcpb-manifest.mjs" "$repo/mcpb/manifest.json" "$server" "$version" \
  "$staging/manifest.json"
[ -f "$repo/mcpb/icon.png" ] && cp "$repo/mcpb/icon.png" "$staging/icon.png"

# 4. The bundle: the staging directory is the root of the zip.
(cd "$staging" && zip -X -r -q "$out" .)

# 5. Check the contents.
listing="$work/listing.txt"
unzip -Z1 "$out" > "$listing"
grep -qx 'manifest.json' "$listing" || fail "manifest.json is not at the root of $out."
grep -qx 'server/dist/index.js' "$listing" || fail "server/dist/index.js is missing from $out."
grep -q '^server/node_modules/@modelcontextprotocol/server/' "$listing" ||
  fail "server/node_modules/@modelcontextprotocol/server is missing from $out."
for dev in vitest typescript @biomejs @modelcontextprotocol/client; do
  if grep -q "^server/node_modules/$dev/" "$listing"; then
    fail "development dependency $dev is in $out."
  fi
done

echo "build-mcpb: $(wc -l < "$listing" | tr -d ' ') entries, work directory $work" >&2
echo "$out"
