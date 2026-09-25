#!/usr/bin/env bash
# Local git pre-push hook (NOT part of the repository; install with:
#   cp docs/pre-push-private-check.sh .git/hooks/pre-push && chmod +x .git/hooks/pre-push
# ). Refuses to push any commit whose tree or history contains a string listed in
# .claude/private-identifiers.txt (gitignored). The list is read with the same rules as
# .claude/hooks/scan-secrets.py: each line is a literal string, not a regular expression; leading
# and trailing white space is trimmed (the CR of a CRLF line too); empty lines, lines starting
# with # and lines shorter than 6 characters are skipped; matching ignores case.
set -u
list="$(git rev-parse --show-toplevel)/.claude/private-identifiers.txt"
[[ -f "$list" ]] || exit 0
patterns=$(sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$list" |
  awk 'length($0) >= 6 && substr($0, 1, 1) != "#"')
[[ -n "$patterns" ]] || exit 0
# Without the pattern file every grep below fails and the push would pass unchecked: refuse instead.
if ! pfile=$(mktemp) || ! printf '%s\n' "$patterns" > "$pfile"; then
  [[ -n "${pfile:-}" ]] && rm -f "$pfile"
  echo "pre-push: could not write the identifiers to a temporary file; refusing to push."
  exit 1
fi
status=0
while read -r local_ref local_sha remote_ref remote_sha; do
  [[ "$local_sha" =~ ^0+$ ]] && continue
  if [[ "$remote_sha" =~ ^0+$ ]]; then range="$local_sha"; else range="$remote_sha..$local_sha"; fi
  # 1. every tree in the pushed range
  for c in $(git rev-list "$range"); do
    if git grep -I -i -F -q -f "$pfile" "$c" -- . 2>/dev/null; then
      echo "pre-push: commit $c contains a private identifier (tree)"; status=1
    fi
  done
  # 2. commit messages
  if git log --format=%B "$range" | grep -i -F -q -f "$pfile"; then
    echo "pre-push: a commit message in $range contains a private identifier"; status=1
  fi
done
rm -f "$pfile"
if [[ $status -ne 0 ]]; then
  echo "pre-push: refusing to push. Rewrite the commits named above without the identifiers, then push again."
fi
exit $status
