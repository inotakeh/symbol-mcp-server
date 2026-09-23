#!/usr/bin/env bash
# Waits until npm shows one field of a published version, then prints the field's value:
#
#   scripts/wait-for-npm.sh symbol-mcp-server@0.9.0 dist.attestations.url
#   scripts/wait-for-npm.sh symbol-mcp-server@0.9.0 mcpName io.github.inotakeh/symbol
#
# The registry can lag behind a publish that just finished, so `npm view <spec> <field>` is asked
# every 15 seconds (npm view revalidates its cache on every call) until it shows a value, or, with
# <expected>, exactly that value. A different value fails at once: the fields of a published
# version never change, so waiting would not help. NPM_WAIT (seconds, default 300) bounds the wait.
#
# Used by scripts/release-assets.sh (the provenance URL) and by the registry job of
# .github/workflows/release.yml (the mcpName that the MCP Registry compares with server.json's
# name before it accepts a version). Needs bash and npm. Exit: 0 shown (the value on stdout),
# 1 not shown within the limit, or a different value, 2 usage (arguments, or NPM_WAIT that is not
# a whole number of seconds).
set -euo pipefail

usage() {
  echo "usage: scripts/wait-for-npm.sh <name@version> <field> [<expected>]" >&2
  exit 2
}
fail() {
  echo "wait-for-npm: $*" >&2
  exit 1
}

[ "$#" -eq 2 ] || [ "$#" -eq 3 ] || usage
spec="$1"
field="$2"
expected="${3-}"
[ -n "$spec" ] && [ -n "$field" ] || usage
[ "$#" -eq 2 ] || [ -n "$expected" ] || usage
limit="${NPM_WAIT:-300}"
if ! [[ "$limit" =~ ^[0-9]+$ ]]; then
  echo "wait-for-npm: NPM_WAIT must be a whole number of seconds, not '$limit'." >&2
  exit 2
fi

waited=0
while :; do
  value="$(npm view "$spec" "$field" 2>/dev/null || true)"
  if [ -n "$value" ]; then
    if [ -z "$expected" ] || [ "$value" = "$expected" ]; then
      printf '%s\n' "$value"
      exit 0
    fi
    fail "npm shows $field of $spec as $value, not $expected."
  fi
  [ "$waited" -ge "$limit" ] &&
    fail "npm does not show $field of $spec after ${waited}s (npm view $spec $field says why)."
  sleep 15
  waited=$((waited + 15))
done
