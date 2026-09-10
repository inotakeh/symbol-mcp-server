#!/usr/bin/env python3
"""
PreToolUse hook for Edit / Write / MultiEdit / NotebookEdit (Claude Code).

Blocks the agent's file tools from touching files that define the guardrails
themselves, release/publishing metadata, credentials, or anything outside the
project directory. Reading these files is still allowed (via Read) so Claude
can understand them; changes must be proposed in chat and applied by a human.

Exit 2 = block (stderr shown to Claude). Exit 0 = no decision.
"""
import fnmatch
import json
import os
import re
import sys
import tempfile

PROJECT_DIR = os.path.realpath(os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd())
HOME = os.path.realpath(os.path.expanduser("~"))

# Locations OUTSIDE the project that Claude Code itself needs to write to.
# Kept deliberately narrow: plan files, auto-memory, and temp/scratch space.
# Settings, hooks, credentials under ~/.claude stay blocked.
EXTERNAL_ALLOWED = [
    re.compile(r"^" + re.escape(os.path.join(HOME, ".claude", "plans")) + r"(/|$)"),
    re.compile(r"^" + re.escape(os.path.join(HOME, ".claude", "projects")) + r"/[^/]+/memory(/|$)"),
    re.compile(r"^" + re.escape(os.path.realpath(tempfile.gettempdir())) + r"(/|$)"),
]

# Patterns are matched against the path relative to the project root (POSIX form).
PROTECTED = [
    # Guardrails and agent configuration
    ".claude/**",
    ".claude",
    "CLAUDE.md",
    "CLAUDE.local.md",
    ".mcp.json",
    # CI / release / repo governance
    ".github/workflows/**",
    ".github/CODEOWNERS",
    ".github/dependabot.yml",
    "SECURITY.md",
    "LICENSE",
    "LICENSE.*",
    "server.json",          # MCP Registry metadata (name/version/package identity)
    # Package manager control files
    ".npmrc",
    "package-lock.json",    # must only change through npm (install/ci), never by hand
    "pnpm-lock.yaml",
    "yarn.lock",
    # Git internals and hooks
    ".git/**",
    ".husky/**",
    "lefthook.yml",
    ".pre-commit-config.yaml",
    # Secrets
    ".env",
    ".env.*",
    "**/*.pem",
    "**/*.key",
    "**/id_rsa*",
    "**/id_ed25519*",
    "**/harvesters.dat",
]

# Exceptions inside protected patterns that are fine for the agent to create/edit.
ALLOWED_EXCEPTIONS = [
    ".env.example",
]


def rel_path(p):
    p = os.path.realpath(os.path.join(PROJECT_DIR, os.path.expanduser(p))) if not os.path.isabs(p) else os.path.realpath(os.path.expanduser(p))
    try:
        rel = os.path.relpath(p, PROJECT_DIR)
    except ValueError:
        return None, p
    if rel.startswith(".."):
        return None, p
    return rel.replace(os.sep, "/"), p


def matches(rel, pattern):
    if fnmatch.fnmatch(rel, pattern):
        return True
    # "dir/**" should also match "dir/x" and "dir" itself
    if pattern.endswith("/**"):
        base = pattern[:-3]
        if rel == base or rel.startswith(base + "/"):
            return True
    return False


def main():
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)
    if data.get("tool_name") not in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
        sys.exit(0)
    ti = data.get("tool_input") or {}
    path = ti.get("file_path") or ti.get("notebook_path") or ""
    if not path:
        sys.exit(0)

    rel, absolute = rel_path(path)
    if rel is None:
        scratch = data.get("scratchpad_dir")
        allowed_external = list(EXTERNAL_ALLOWED)
        if scratch:
            allowed_external.append(re.compile(r"^" + re.escape(os.path.realpath(scratch)) + r"(/|$)"))
        if any(rx.match(absolute) for rx in allowed_external):
            sys.exit(0)
        print(
            f"BLOCKED by guard-files: writing outside the project directory is forbidden ({absolute}). "
            "Allowed external locations: ~/.claude/plans/, ~/.claude/projects/<project>/memory/, the session scratchpad and the temp directory.",
            file=sys.stderr,
        )
        sys.exit(2)

    if any(matches(rel, ex) for ex in ALLOWED_EXCEPTIONS):
        sys.exit(0)

    for pattern in PROTECTED:
        if matches(rel, pattern):
            print(
                f"BLOCKED by guard-files: '{rel}' is a protected file (pattern '{pattern}'). "
                "Guardrails, CI/release config, lockfiles, licenses and secrets are edited by humans only. "
                "Describe the exact change you want in chat and stop; do not try another way to modify it.",
                file=sys.stderr,
            )
            sys.exit(2)

    sys.exit(0)


if __name__ == "__main__":
    main()
