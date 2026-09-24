#!/usr/bin/env bash
# Waits until npm serves the attestations of a published version, then saves them to a file:
#
#   scripts/wait-for-attestations.sh https://registry.npmjs.org/-/npm/v1/attestations/<name>@<version> out.json
#
# The registry can show a version (and its dist.attestations.url) before it serves the attestations
# themselves: 0.9.0 got HTTP 404 from that URL right after the version appeared. So the URL is
# asked every 15 seconds, like scripts/wait-for-npm.sh asks npm view, while it answers 404, a 5xx
# status or no answer at all. Any other status fails at once (403, 410 and the like will not change
# by waiting). NPM_WAIT (seconds, default 300) bounds the wait.
#
# Used by scripts/release-assets.sh, which checks the saved attestations. Needs bash and node
# (>= 22, for fetch); NODE_USE_ENV_PROXY makes fetch honour HTTPS_PROXY like npm does (no effect
# without a proxy). Exit: 0 saved, 1 not served within the limit or a status that waiting cannot
# fix, 2 usage (arguments, or NPM_WAIT that is not a whole number of seconds).
set -euo pipefail

usage() {
  echo "usage: scripts/wait-for-attestations.sh <url> <outfile>" >&2
  exit 2
}
fail() {
  echo "wait-for-attestations: $*" >&2
  exit 1
}

[ "$#" -eq 2 ] || usage
url="$1"
out="$2"
[ -n "$url" ] && [ -n "$out" ] || usage
limit="${NPM_WAIT:-300}"
if ! [[ "$limit" =~ ^[0-9]+$ ]]; then
  echo "wait-for-attestations: NPM_WAIT must be a whole number of seconds, not '$limit'." >&2
  exit 2
fi

# One request. Exit 0: saved to <outfile>. 3: not there yet (404, 5xx, no answer). 4: another
# status. The status line goes to stdout.
fetch_once() {
  NODE_USE_ENV_PROXY=1 node - "$url" "$out" <<'NODE'
const { writeFileSync } = require('node:fs');
const [url, out] = process.argv.slice(2);
fetch(url)
  .then(async (response) => {
    if (response.ok) {
      writeFileSync(out, await response.text());
      process.exit(0);
    }
    console.log(`HTTP ${response.status}`);
    process.exit(response.status === 404 || response.status >= 500 ? 3 : 4);
  })
  .catch((err) => {
    console.log(`no answer (${err.cause?.code ?? err.message})`);
    process.exit(3);
  });
NODE
}

waited=0
while :; do
  status=0
  answer="$(fetch_once)" || status=$?
  case "$status" in
    0) exit 0 ;;
    3) ;;
    4) fail "GET $url answered $answer; waiting will not change that." ;;
    *) fail "GET $url failed (node exited $status)." ;;
  esac
  [ "$waited" -ge "$limit" ] &&
    fail "npm does not serve the attestations at $url after ${waited}s (last: $answer)."
  sleep 15
  waited=$((waited + 15))
done
