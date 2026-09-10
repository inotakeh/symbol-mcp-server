#!/usr/bin/env bash
# Local git pre-push hook (NOT part of the repository; install with:
#   cp docs/pre-push-private-check.sh .git/hooks/pre-push && chmod +x .git/hooks/pre-push
# ). Refuses to push any commit whose tree or history contains a string listed in
# .claude/private-identifiers.txt (gitignored). Case-insensitive.
set -u
list="$(git rev-parse --show-toplevel)/.claude/private-identifiers.txt"
[[ -f "$list" ]] || exit 0
patterns=$(grep -v '^\s*#' "$list" | grep -v '^\s*$' | awk 'length($0) >= 6')
[[ -n "$patterns" ]] || exit 0
pfile=$(mktemp); printf '%s\n' "$patterns" > "$pfile"
status=0
while read -r local_ref local_sha remote_ref remote_sha; do
  [[ "$local_sha" =~ ^0+$ ]] && continue
  if [[ "$remote_sha" =~ ^0+$ ]]; then range="$local_sha"; else range="$remote_sha..$local_sha"; fi
  # 1. every tree in the pushed range
  for c in $(git rev-list "$range"); do
    if git grep -I -i -q -f "$pfile" "$c" -- . 2>/dev/null; then
      echo "pre-push: commit $c contains a private identifier (tree)"; status=1
    fi
  done
  # 2. commit messages
  if git log --format=%B "$range" | grep -i -q -f "$pfile"; then
    echo "pre-push: a commit message in $range contains a private identifier"; status=1
  fi
done
rm -f "$pfile"
if [[ $status -ne 0 ]]; then
  echo "pre-push: refusing to push. Rebuild the history without the identifiers (see the squash procedure)."
fi
exit $status
