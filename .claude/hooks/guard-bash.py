#!/usr/bin/env python3
"""
PreToolUse hook for the Bash tool (Claude Code).

Deterministic guardrail: inspects the full command text (including subshells,
pipes and compound commands) and either BLOCKS (exit 2, reason on stderr),
forces a human prompt (JSON permissionDecision "ask"), or stays silent (exit 0)
so the normal permission rules / classifier decide.

Why a hook and not only permissions.deny:
  permissions.deny matches command text after Claude Code's own parsing and is
  bypassable by "/bin/rm", "sh -c '...'", "git -C . push" and similar forms.
  This hook sees the raw command string and applies regexes to the whole of it.
  A PreToolUse hook that blocks wins over allow rules and over every permission
  mode, including bypassPermissions.

Exit codes (per Claude Code hooks reference):
  0  -> no decision (or JSON on stdout with a decision)
  2  -> block; stderr is shown to Claude as the reason
"""
import json
import os
import re
import shlex
import sys

PROJECT_DIR = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
ALLOWED_PACKAGES_FILE = os.path.join(PROJECT_DIR, ".claude", "allowed-packages.txt")
ALLOWED_NPX_FILE = os.path.join(PROJECT_DIR, ".claude", "allowed-npx.txt")

# Directories inside the repo where "rm -rf" is acceptable (build artefacts only).
RM_ALLOWED_PREFIXES = ("dist", "./dist", "coverage", "./coverage", "node_modules", "./node_modules", ".tmp", "./.tmp")

# ---------------------------------------------------------------------------
# BLOCK rules: (regex, human-readable reason). Matched against the whole command.
# ---------------------------------------------------------------------------
BLOCK_RULES = [
    # Remote code execution / piping the network into an interpreter
    (r"\b(curl|wget|fetch)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b", "Piping network content into a shell (curl|sh) is forbidden."),
    (r"\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(python3?|node|perl|ruby)\b", "Piping network content into an interpreter is forbidden."),
    (r"\b(curl|wget)\b", "curl/wget are disabled for the agent. Use the WebFetch tool for documentation; the MCP server itself uses fetch() in code."),
    (r"\beval\b", "eval is forbidden."),
    (r"\bbase64\s+(-d|--decode)\b[^|;&]*\|\s*(ba|z)?sh\b", "Decoding and executing payloads is forbidden."),
    (r"\b(ba|z|da)?sh\s+-c\s", "sh -c / bash -c wrappers are forbidden (they hide the real command from the guardrails). Run the command directly."),

    # Privilege / system changes
    (r"\b(sudo|doas|su)\b", "Privilege escalation is forbidden."),
    (r"\bchmod\s+(-R\s+)?(777|o\+w|a\+w)\b", "World-writable permissions are forbidden."),

    # Production Symbol node: never touch it from the dev agent
    (r"\b(ssh|scp|sftp|rsync)\b", "Remote shell/copy is forbidden. The production Symbol node must never be touched by the agent."),
    (r"\b(symbol-bootstrap|shoestring)\b", "Node-operation tools are forbidden in this repository."),
    (r"\bdocker(-compose)?\b", "docker is forbidden here (this project has no container workflow)."),

    # Secrets: never dump the environment or credential files into the transcript
    (r"(^|[;&|]\s*)(env|printenv|set)\s*($|[;&|])", "Dumping the environment is forbidden (it can leak tokens into the transcript)."),
    (r"\$\{?(NPM_TOKEN|GITHUB_TOKEN|GH_TOKEN|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|NODE_AUTH_TOKEN)\b", "Referencing credential environment variables is forbidden."),
    (r"(~|\$HOME|/Users/[^/\s]+|/home/[^/\s]+)/\.(ssh|aws|npmrc|netrc|gnupg|config/gh)\b", "Access to credential files under the home directory is forbidden."),
    (r"\b(cat|less|more|head|tail|grep|rg|sed|awk|cp|mv|xxd|hexdump|strings)\b[^|;&]*(\.env(\.\w+)?(\s|$|['\"])|id_rsa|id_ed25519|\.pem\b|\.key\b|harvesters\.dat)", "Reading or copying secret/key files is forbidden."),
    (r"\b(export|set)\s+(NPM_TOKEN|GITHUB_TOKEN|GH_TOKEN|ANTHROPIC_API_KEY|NODE_AUTH_TOKEN)=", "Setting credential environment variables is forbidden."),
    (r"(>|>>|tee)\s*(~|\$HOME)?/?\.?npmrc\b", "Writing to .npmrc is forbidden."),

    # npm registry / publishing / auth — humans only, via CI trusted publishing
    (r"\bnpm\s+(publish|unpublish|deprecate|owner|access|token|login|adduser|logout|whoami|config\s+set|set\s+registry)\b", "npm publishing/auth/registry configuration is forbidden for the agent. Releases go through CI (tag by a human)."),
    (r"\b(pnpm|yarn)\s+(publish|login|config\s+set)\b", "Publishing/auth via pnpm/yarn is forbidden."),
    (r"--registry[= ]", "Overriding the npm registry is forbidden."),
    (r"--ignore-scripts=false|ignore-scripts\s+false", "Re-enabling install scripts is forbidden."),

    # git: history rewriting, bypassing hooks, changing remotes/config
    (r"\bgit\b[^|;&]*\bpush\b[^|;&]*(\s-f\b|--force\b|--force-with-lease\b|--delete\b|\s:\S)", "Force-pushes and remote branch deletion are forbidden."),
    (r"\bgit\b[^|;&]*\bpush\b[^|;&]*(\s|:)(main|master)(\s|$)", "Pushing directly to main/master is forbidden. Push a feature branch and open a PR."),
    (r"\bgit\b[^|;&]*\bcommit\b[^|;&]*(\s-n\b|--no-verify\b)", "Bypassing commit hooks (--no-verify) is forbidden."),
    (r"\bgit\b[^|;&]*\b(config)\b[^|;&]*(--global|--system|core\.hooksPath|credential|user\.(name|email)|url\.)", "Changing git configuration is forbidden."),
    (r"\bgit\b[^|;&]*\bremote\b[^|;&]*\b(add|set-url|remove|rm|rename)\b", "Changing git remotes is forbidden."),
    (r"\bgit\b[^|;&]*\btag\s+(?!(-l|--list|-n)\b)\S", "Creating tags is forbidden (tags trigger releases; a human creates them)."),
    (r"\.git/hooks\b", "Touching .git/hooks is forbidden."),
    (r"\bgit\b[^|;&]*\b(filter-branch|filter-repo|reflog\s+expire|gc\s+--prune)\b", "History rewriting is forbidden."),

    # gh CLI: anything that merges, releases, or changes repo settings/secrets is human-only
    (r"\bgh\s+(pr\s+merge|pr\s+review\s+--approve|release|repo\s+(delete|edit|deploy-key|rename|archive)|secret|variable|auth|api\s+(-X|--method)\s*(DELETE|PATCH|PUT|POST))\b", "This gh operation (merge/release/settings/secrets/auth) is reserved for humans."),
    (r"\bgh\s+api\b[^|;&]*(/(rulesets|branches/[^/\s]+/protection|hooks|keys|actions/secrets))", "Changing repository protection/secrets via gh api is forbidden."),

    # gh api with field flags defaults to POST
    (r"\bgh\s+api\b[^|;&]*(\s-f\b|\s-F\b|--field|--raw-field|--input)", "gh api with write fields is reserved for humans."),
]

WRITE_OPS = re.compile(r"(^|[;&|]\s*)(sed\s+-i|tee|cp|mv|rm|chmod|truncate|dd|ln)\b|>>?")
PROTECTED_PATHS = re.compile(r"(\.claude/|\.github/workflows/|CLAUDE\.md|\.npmrc|package-lock\.json|LICENSE|SECURITY\.md|CODEOWNERS|server\.json|\.gitignore)")

# ---------------------------------------------------------------------------
# ASK rules: force a human prompt even in auto mode.
# ---------------------------------------------------------------------------
ASK_RULES = [
    (r"\bgit\b[^|;&]*\bpush\b", "git push to a feature branch"),
    (r"\bgit\b[^|;&]*\b(rebase|merge|cherry-pick)\b", "history-affecting git operation"),
    (r"\bgit\b[^|;&]*\b(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s+\.|restore\s+\.|stash\s+(drop|clear)|branch\s+-D)\b", "operation that discards work"),
    (r"\bgh\s+pr\s+(create|edit|close|reopen|comment)\b", "GitHub PR operation"),
    (r"\bgh\s+issue\s+(create|edit|close|comment)\b", "GitHub issue operation"),
    (r"\bnpm\s+(update|upgrade|dedupe|audit\s+fix)\b", "dependency tree change"),
]


def read_list(path):
    items = set()
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#"):
                    items.add(line)
    except FileNotFoundError:
        pass
    return items


def split_subcommands(cmd):
    # Split on shell separators; good enough for allowlist checks of install commands.
    return [c.strip() for c in re.split(r"&&|\|\||;|\||\n", cmd) if c.strip()]


def check_installs(cmd, allowed):
    """Block 'npm install <pkg>' etc. unless every package is in the allowlist."""
    problems = []
    for sub in split_subcommands(cmd):
        try:
            argv = shlex.split(sub)
        except ValueError:
            continue
        if not argv:
            continue
        # strip leading env assignments and wrappers
        while argv and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", argv[0]):
            argv.pop(0)
        if not argv:
            continue
        tool = os.path.basename(argv[0])
        rest = argv[1:]
        pkgs = None
        if tool == "npm" and rest and rest[0] in ("install", "i", "add", "isntall", "in", "ins"):
            pkgs = [a for a in rest[1:] if not a.startswith("-")]
        elif tool == "pnpm" and rest and rest[0] in ("add", "install", "i"):
            pkgs = [a for a in rest[1:] if not a.startswith("-")]
        elif tool == "yarn" and rest and rest[0] == "add":
            pkgs = [a for a in rest[1:] if not a.startswith("-")]
        elif tool == "bun" and rest and rest[0] in ("add", "install", "i"):
            pkgs = [a for a in rest[1:] if not a.startswith("-")]
        if pkgs is None:
            continue
        if not pkgs:
            continue  # bare 'npm install' = lockfile install, allowed
        for p in pkgs:
            name = p
            # strip version/tag: react@18, @scope/name@1.2.3
            if name.startswith("@"):
                head, _, tail = name[1:].partition("@")
                name = "@" + head
            else:
                name = name.split("@")[0]
            if re.match(r"^(https?:|git\+|git:|github:|file:|\.|/)", p) or p.endswith((".tgz", ".tar.gz")):
                problems.append(f"'{p}' (URL/path/tarball installs are forbidden)")
            elif name not in allowed:
                problems.append(f"'{name}' (not in .claude/allowed-packages.txt)")
    return problems


def check_npx(cmd, allowed):
    problems = []
    for sub in split_subcommands(cmd):
        try:
            argv = shlex.split(sub)
        except ValueError:
            continue
        while argv and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", argv[0]):
            argv.pop(0)
        if not argv:
            continue
        tool = os.path.basename(argv[0])
        rest = argv[1:]
        if tool in ("npx", "bunx") or (tool == "pnpm" and rest and rest[0] == "dlx") or (tool == "yarn" and rest and rest[0] == "dlx"):
            if tool in ("pnpm", "yarn"):
                rest = rest[1:]
            args = [a for a in rest if not a.startswith("-")]
            if not args:
                continue
            pkg = args[0]
            name = pkg
            if name.startswith("@"):
                head, _, _ = name[1:].partition("@")
                name = "@" + head
            else:
                name = name.split("@")[0]
            if name not in allowed:
                problems.append(f"'{name}' (not in .claude/allowed-npx.txt)")
    return problems


def check_rm(cmd):
    """Only allow rm -r/-rf on build artefacts inside the repo."""
    for sub in split_subcommands(cmd):
        try:
            argv = shlex.split(sub)
        except ValueError:
            continue
        while argv and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", argv[0]):
            argv.pop(0)
        if not argv or os.path.basename(argv[0]) != "rm":
            continue
        flags = [a for a in argv[1:] if a.startswith("-")]
        targets = [a for a in argv[1:] if not a.startswith("-")]
        recursive = any("r" in f.lower() for f in flags)
        for t in targets:
            if t.startswith(("/", "~", "$")) or ".." in t or t in ("*", ".", "./"):
                return f"rm target '{t}' is outside the safe set (absolute/home/parent/variable paths are forbidden)."
            if recursive and not t.rstrip("/").startswith(RM_ALLOWED_PREFIXES):
                return f"Recursive rm is only allowed on build artefacts (dist/, coverage/, node_modules/, .tmp/). Got '{t}'."
    return None


def main():
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)
    if data.get("tool_name") != "Bash":
        sys.exit(0)
    cmd = (data.get("tool_input") or {}).get("command") or ""
    if not cmd.strip():
        sys.exit(0)

    flat = " ".join(cmd.split())

    for pattern, reason in BLOCK_RULES:
        if reason is None:
            continue
        if re.search(pattern, flat, flags=re.IGNORECASE):
            print(f"BLOCKED by guard-bash: {reason}\nCommand: {flat}", file=sys.stderr)
            sys.exit(2)

    if PROTECTED_PATHS.search(flat) and WRITE_OPS.search(flat):
        print("BLOCKED by guard-bash: shell writes to protected files (.claude/, .github/workflows/, CLAUDE.md, .npmrc, package-lock.json, LICENSE, SECURITY.md, CODEOWNERS, server.json, .gitignore) are forbidden. Propose the change in chat for a human to apply.", file=sys.stderr)
        sys.exit(2)

    rm_problem = check_rm(flat)
    if rm_problem:
        print(f"BLOCKED by guard-bash: {rm_problem}", file=sys.stderr)
        sys.exit(2)

    install_problems = check_installs(cmd, read_list(ALLOWED_PACKAGES_FILE))
    if install_problems:
        print("BLOCKED by guard-bash: dependency not approved: " + ", ".join(install_problems) + ". Ask a human to add it to .claude/allowed-packages.txt (with a justification) before installing.", file=sys.stderr)
        sys.exit(2)

    npx_problems = check_npx(cmd, read_list(ALLOWED_NPX_FILE))
    if npx_problems:
        print("BLOCKED by guard-bash: npx/dlx of unapproved package: " + ", ".join(npx_problems) + ". npx downloads and runs arbitrary code; only packages listed in .claude/allowed-npx.txt may be run.", file=sys.stderr)
        sys.exit(2)

    for pattern, what in ASK_RULES:
        if re.search(pattern, flat, flags=re.IGNORECASE):
            print(json.dumps({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "ask",
                    "permissionDecisionReason": f"guard-bash: {what} requires human confirmation.",
                }
            }))
            sys.exit(0)

    sys.exit(0)


if __name__ == "__main__":
    main()
