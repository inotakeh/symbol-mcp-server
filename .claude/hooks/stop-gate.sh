#!/usr/bin/env bash
# OPTIONAL Stop hook: refuse to end the turn while lint/tests fail on uncommitted changes.
# Enable by adding to .claude/settings.json:
#   "Stop": [{"matcher": "", "hooks": [{"type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/stop-gate.sh", "timeout": 300}]}]
# Claude Code stops re-blocking after 8 consecutive blocks, so this cannot loop forever.
set -u
input=$(cat)
# Avoid re-entry loops: when Claude is already continuing because of this hook, let it stop.
if printf '%s' "$input" | grep -q '"stop_hook_active": *true'; then exit 0; fi
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
# Only gate when source/test files changed and are not yet committed.
if [ -z "$(git status --porcelain -- src test package.json 2>/dev/null)" ]; then exit 0; fi
if ! npm run -s lint >/tmp/stop-gate.log 2>&1 || ! npm test -s >>/tmp/stop-gate.log 2>&1; then
  echo "stop-gate: lint or tests are failing on your uncommitted changes. Fix them (or explain why they cannot pass) before finishing. Last lines:" >&2
  tail -n 30 /tmp/stop-gate.log >&2
  exit 2
fi
exit 0
