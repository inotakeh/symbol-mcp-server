#!/usr/bin/env python3
"""
PreToolUse hook for the Bash tool (Claude Code).

Deterministic guardrail. It reads the command the way a POSIX shell would
(quotes, escapes, operators, redirections, heredocs, $(...), backquotes,
process substitution) and applies its rules to the commands that will actually
run, not to every word that appears in the text: a word inside a quoted
argument, a commit message or a grep pattern is data. Text that the shell or a
wrapper would execute is parsed again and checked the same way: $(...) and
backquotes, shell heredocs and here-strings, trap actions, env -S, flock -c,
script -c, watch, parallel, find -exec and xargs. sh -c / bash -c and piping
text into a shell or an interpreter are refused outright, and inline
interpreter code (node -e, python -c, ...) that starts processes is refused.

It either BLOCKS (exit 2, reason on stderr), forces a human prompt (JSON
permissionDecision "ask"), or stays silent (exit 0) so the normal permission
rules / classifier decide.

git push / fetch / ls-remote and gh run OUTSIDE the OS sandbox
(settings.local.json excludedCommands), so for them this hook is the first
defence; other git commands run inside the sandbox, which refuses writes to the
protected files, and the rules below are a second layer for them. Outside the
sandbox gh may only talk to github.com, commands that write on GitHub may only
target this repository's origin, the files gh reads (--body-file) must be in the
repository or the scratch area, pushes need an explicit non-main destination
and never push tags or wildcards, fetches only write remote-tracking refs (or
the same name without '+') from configured remotes, and lines that run them may
not contain command substitution (other than "$(cat <<'EOF' ... EOF)").
git and gh subcommands are
ALLOWLISTED (GIT_ALLOWED, GH_ALLOWED): anything not on the lists is refused by
default, including aliases and external git-* / gh-* commands. Within the
allowed subcommands, long options are also matched when abbreviated (git
accepts unique prefixes). Refused: configuration that runs
commands (git -c other than a small allowlist, git config writes, assigning
HOME / PATH / CDPATH / GIT_* / GH_* / EDITOR / PAGER / BASH_ENV / LD_* / DYLD_* /
NODE_OPTIONS ... or a variable whose name is computed, in the same command:
the hooks, pagers and ssh that git starts run outside the
sandbox as well), subcommands that run commands (submodule foreach, bisect
run, rebase --exec, difftool --extcmd, grep -O), git maintenance (it registers
background jobs), network access other than a configured remote by name
(clone, URLs, submodule add), checking out pull requests (gh pr checkout,
fetching pull/ refs: a pull request can replace these hooks, which are read
from the working tree), applying patches (apply / am other than --check /
--stat / --numstat / --summary), index/worktree plumbing, gh alias /
extension / config set / codespace / ssh-key / gpg-key, and running git or gh
anywhere other than this repository (another directory or a nested
repository). Writes to $CLAUDE_ENV_FILE and ~/.claude (shell snapshots) are
refused like other protected files.

Commands that cannot be parsed (unbalanced quotes, unterminated heredoc or
substitution) are refused: the hook fails closed.

Why a hook and not only permissions.deny:
  permissions.deny matches command text after Claude Code's own parsing and is
  bypassable by "/bin/rm", "sh -c '...'", "git -C . push" and similar forms.
  A PreToolUse hook that blocks wins over allow rules and over every permission
  mode, including bypassPermissions.

Exit codes (per Claude Code hooks reference):
  0  -> no decision (or JSON on stdout with a decision)
  2  -> block; stderr is shown to Claude as the reason
"""
import fnmatch
import glob
import json
import os
import re
import subprocess
import sys
import urllib.parse

PROJECT_DIR = os.path.realpath(os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd())
ALLOWED_PACKAGES_FILE = os.path.join(PROJECT_DIR, ".claude", "allowed-packages.txt")
ALLOWED_NPX_FILE = os.path.join(PROJECT_DIR, ".claude", "allowed-npx.txt")

# Directories inside the repo where "rm -rf" is acceptable (build artefacts only).
RM_ALLOWED_PREFIXES = ("dist", "./dist", "coverage", "./coverage", "node_modules", "./node_modules", ".tmp", "./.tmp")

# ---------------------------------------------------------------------------
# Rules on the raw text. A match anywhere blocks, even inside quotes: these
# name secrets or payloads that must not appear in a command at all.
# ---------------------------------------------------------------------------
TEXT_RULES = [
    (r"\bbase64\s+(-d|--decode)\b[^|;&]*\|\s*(ba|z)?sh\b", "Decoding and executing payloads is forbidden."),
    (r"\bchmod\s+(-R\s+)?(777|o\+w|a\+w)\b", "World-writable permissions are forbidden."),
    (r"\$\{?(NPM_TOKEN|GITHUB_TOKEN|GH_TOKEN|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|NODE_AUTH_TOKEN)\b", "Referencing credential environment variables is forbidden."),
    (r"(~|\$HOME|/Users/[^/\s]+|/home/[^/\s]+)/\.(ssh|aws|npmrc|netrc|gnupg|config/gh)\b", "Access to credential files under the home directory is forbidden."),
    (r"\b(cat|less|more|head|tail|grep|rg|sed|awk|cp|mv|xxd|hexdump|strings)\b[^|;&]*(\.env(\.\w+)?(\s|$|['\"])|id_rsa|id_ed25519|\.pem\b|\.key\b|harvesters\.dat)", "Reading or copying secret/key files is forbidden."),
    (r"\b(export|set)\s+(NPM_TOKEN|GITHUB_TOKEN|GH_TOKEN|ANTHROPIC_API_KEY|NODE_AUTH_TOKEN)=", "Setting credential environment variables is forbidden."),
    (r"(>|>>|tee)\s*(~|\$HOME)?/?\.?npmrc\b", "Writing to .npmrc is forbidden."),
]

# ---------------------------------------------------------------------------
# Messages for the command rules
# ---------------------------------------------------------------------------
MSG_GIT_NOT_ALLOWED = "git {} is not on the guardrail's allowlist of git subcommands (git runs outside the sandbox, so subcommands not on the list are refused by default). If it is needed, a human runs it, or adds it to GIT_ALLOWED in .claude/hooks/guard-bash.py."
MSG_GH_NOT_ALLOWED = "gh {} is not on the guardrail's allowlist of gh commands (gh runs outside the sandbox, so commands not on the list are refused by default). If it is needed, a human runs it, or adds it to GH_ALLOWED in .claude/hooks/guard-bash.py."
MSG_GH_FLAG_FIRST = "Put the gh command words before their flags: an unknown flag in front of them can hide which command runs. Only -R/--repo/--hostname may come first."
MSG_GIT_ENV_DYNAMIC = "A variable whose name is computed at run time is set in a command that runs git or gh, which hides whether it changes the configuration or programs they load. Write variable names literally."
MSG_PM_FLAG_FIRST = "Put the package manager's subcommand before its options: an unknown option in front of it can hide which subcommand runs. Options such as --prefix, -C, --cwd, -w and -g may come first."
MSG_PKG_ENV = "Setting package-manager configuration ({}) through the environment or the command line is forbidden (it can change the registry or re-enable install scripts). Only npm_config_cache may be set."
MSG_FIND_WRITE = "find with -delete, -fprint/-fls or an -exec that writes is forbidden when a start point is or contains protected files. Start from a narrower directory that has none."
MSG_PARSE = "The command could not be parsed ({}). Fix the quoting or the heredoc/substitution; commands the guardrail cannot read are refused."
MSG_DYNAMIC = "The command name is computed at run time (variable, substitution, glob or brace expansion), which hides the real command from the guardrails. Write the command name literally."
MSG_NETWORK = "curl/wget are disabled for the agent. Use the WebFetch tool for documentation; the MCP server itself uses fetch() in code."
MSG_DEV_TCP = "Opening network connections through /dev/tcp or /dev/udp is forbidden."
MSG_EVAL = "eval is forbidden."
MSG_SHELL_C = "sh -c / bash -c wrappers are forbidden (they hide the real command from the guardrails). Run the command directly."
MSG_PIPE_SHELL = "Feeding text into a shell or an interpreter through a pipe hides the commands from the guardrails. Run the commands directly or from a file."
MSG_PRIV = "Privilege escalation is forbidden."
MSG_REMOTE = "Remote shell/copy is forbidden. The production Symbol node must never be touched by the agent."
MSG_NODE_OPS = "Node-operation tools are forbidden in this repository."
MSG_DOCKER = "docker is forbidden here (this project has no container workflow)."
MSG_ENV_DUMP = "Dumping the environment is forbidden (it can leak tokens into the transcript)."
MSG_NPM = "npm publishing/auth/registry configuration is forbidden for the agent. Releases go through CI (tag by a human)."
MSG_PNPM = "Publishing/auth via pnpm/yarn is forbidden."
MSG_REGISTRY = "Overriding the npm registry is forbidden."
MSG_SCRIPTS = "Re-enabling install scripts is forbidden."
MSG_NPM_EXEC_C = "npm exec -c / --call runs a shell string, which hides the real command from the guardrails. Run the command directly."
MSG_INLINE_SPAWN = "Inline interpreter code that starts processes is forbidden (the guardrails cannot see the command it runs). Run the command directly."
MSG_INLINE_WRITE = "Inline interpreter code that writes to protected files (.claude/, .github/workflows/, CLAUDE.md, AGENTS.md, .npmrc, package-lock.json, LICENSE, SECURITY.md, CODEOWNERS, server.json, mcpb/manifest.json, .gitignore, .git/) is forbidden. Propose the change in chat for a human to apply."
MSG_AWK = "awk programs that run commands (system() or piping to/from a command) are forbidden. Run the command directly."
MSG_PROTECTED = "shell writes to protected files (.claude/, .github/workflows/, CLAUDE.md, AGENTS.md, .npmrc, package-lock.json, LICENSE, SECURITY.md, CODEOWNERS, server.json, mcpb/manifest.json, .gitignore, .git/) are forbidden, and so are relative writes after a cd whose target cannot be worked out. Propose the change in chat for a human to apply."
MSG_FORCE = "Force-pushes and remote branch deletion are forbidden."
MSG_MAIN = "Pushing directly to main/master is forbidden. Push a feature branch and open a PR."
MSG_TAG_PUSH = "Pushing tags is forbidden (tags trigger releases; a human pushes them)."
MSG_NO_VERIFY = "Bypassing commit hooks (--no-verify) is forbidden."
MSG_GIT_CONFIG = "Changing git configuration is forbidden. git config may only be read (--get, --get-all, --get-regexp, --list, -l, --show-origin, or 'git config get/list')."
MSG_GIT_C = "git -c {} is forbidden. git runs outside the sandbox and configuration can run commands; only commit.gpgsign, core.quotepath, color.* and advice.* may be set with -c."
MSG_GIT_ENV = "Setting {} in a command that runs git or gh is forbidden: git and gh (and the hooks, pagers, editors and ssh they start) run outside the sandbox, and this variable changes which configuration, programs or code they load."
MSG_GIT_LOCATION = "git --git-dir / --work-tree / --exec-path=... / --config-env are forbidden (git runs outside the sandbox; they point it at other configuration or programs)."
MSG_GIT_DIR = "git and gh run outside the sandbox, so they may only run in this repository: no -C or cd into another directory, a computed directory, or a nested repository."
MSG_REMOTE_CHANGE = "Changing git remotes is forbidden."
MSG_TAG = "Creating tags is forbidden (tags trigger releases; a human creates them)."
MSG_HISTORY = "History rewriting is forbidden."
MSG_GIT_EXEC = "This git option runs an arbitrary command (submodule foreach, bisect run, rebase --exec, difftool --extcmd, grep -O, --upload-pack/--receive-pack/--exec), which is forbidden: git runs outside the sandbox."
MSG_SUBMODULE = "git submodule is limited to 'status' and 'summary' (git runs outside the sandbox; the others run commands or reach other hosts)."
MSG_GIT_NET = "git may only talk to a configured remote by name (e.g. 'origin'): clone, URLs, paths and scp-like addresses are forbidden (git runs outside the sandbox)."
MSG_APPLY = "git apply / git am may only inspect a patch (--check, --stat, --numstat, --summary). Applying patches is done by a human."
MSG_PLUMBING = "Low-level git plumbing that writes the index, objects, refs or worktree directly is reserved for humans."
MSG_GIT_OTHER = "This git command talks to other hosts, serves the repository, handles credentials or schedules background jobs (maintenance), which is forbidden (git runs outside the sandbox)."
MSG_PR_CHECKOUT = "Checking out or fetching pull-request refs is forbidden: a pull request (including one from a fork) can change .claude/hooks, and the hooks are read from the working tree on every call. A human checks out pull requests."
MSG_GH = "This gh operation (merge/release/settings/secrets/auth/alias/extension/config/codespace/keys) is reserved for humans."
MSG_GH_API_PROTECTED = "Changing repository protection/secrets via gh api is forbidden."
MSG_GH_API_FIELDS = "gh api with write fields is reserved for humans."
MSG_GH_HOST = "gh may only talk to github.com (gh runs outside the sandbox, so another host would be a way to send data out): no --hostname, full URLs or HOST/OWNER/REPO for other hosts."
MSG_GH_TARGET = "gh commands that write (PR and issue changes, comments, workflow reruns) may only target this repository's origin ({}). Reading other repositories is fine."
MSG_GH_FILE = "gh reads this file outside the sandbox ({}): --body-file/-F may only name a file inside the repository (not .git/, .env*, keys) or under $TMPDIR / the scratchpad, or - for stdin."
MSG_GH_CONFIG_KEY = "gh config get is limited to git_protocol, editor, prompt, pager, browser, spinner, color_labels, accessible_colors and accessible_prompter (other keys can hold credentials)."
MSG_OUTSIDE_SUBST = "Command substitution ($(...), backticks, <(...)) is forbidden in a command line that runs gh or git push/fetch/ls-remote: those run outside the sandbox, and the substituted commands may run there too. Write the text to a file in $TMPDIR or the scratchpad and pass it with gh --body-file (a line with a substitution runs inside the sandbox, where gh cannot read its configuration)."
MSG_PUSH_IMPLICIT = "git push without an explicit destination (no refspec, HEAD or @) is only allowed from a named branch other than main/master. Name the branch: git push -u origin <branch>."
MSG_PUSH_UNCHECKED = "git push: the hook could not check whether '{}' is a local tag, so the push is refused. Push a branch by its full name (<branch>:refs/heads/<branch>)."
MSG_PUSH_WILDCARD = "git push with a wildcard refspec (*) is forbidden: it can push main or tags. Push one branch by name."
MSG_FETCH_DST = "git fetch may only write remote-tracking refs (refs/remotes/...), a local branch of the same name without '+', or a tag of the same name without '+': fetching into another local branch or tag (or forcing one) can put an unreviewed commit where a human expects a reviewed one (for example a release tag)."
MSG_FETCH_REMOTE = "git fetch/pull/ls-remote may only name a configured remote ('{}' is not one, and git would read a name that is not a remote as a path)."
MSG_FETCH_TAGS = "Tags may only be fetched from origin: a tag from another remote could take the name of a release tag."
MSG_FETCH_HEAD_OK = "git fetch --update-head-ok is forbidden (it moves the checked-out branch without updating the working tree)."
MSG_PKG_CONFIG_FILE = "Pointing a package manager at another configuration file ({}) is forbidden (it can change the registry or re-enable install scripts)."
MSG_RM_OUTSIDE = "rm target '{}' is outside the safe set (absolute/home/parent/variable paths are forbidden; \"$TMPDIR/<name>\" and paths under /tmp/claude-<uid>/ are allowed)."
MSG_RM_RECURSIVE = "Recursive rm is only allowed on build artefacts (dist/, coverage/, node_modules/, .tmp/) and temporary directories. Got '{}'."

# ---------------------------------------------------------------------------
# Tables
# ---------------------------------------------------------------------------
NETWORK_CMDS = {"curl", "wget", "fetch"}
PRIV_CMDS = {"sudo", "doas", "su"}
REMOTE_CMDS = {"ssh", "scp", "sftp", "rsync"}
NODE_OPS_CMDS = {"symbol-bootstrap", "shoestring"}
DOCKER_CMDS = {"docker", "docker-compose"}
SHELLS = {"sh", "bash", "zsh", "dash", "ksh", "mksh", "yash", "posh", "csh", "tcsh", "fish"}
# Paths through which a shell or an interpreter reads a script the guardrail cannot see
STDIN_SCRIPT = re.compile(r"^(-|/dev/stdin|/dev/fd/\d+|/proc/self/fd/\d+|[<>]\(.*)$", re.S)
AWKS = {"awk", "gawk", "mawk", "nawk"}
WRAPPERS = {"env", "command", "builtin", "exec", "nice", "nohup", "time", "timeout", "stdbuf", "caffeinate",
            "arch", "busybox", "setsid", "xargs", "flock", "watch", "parallel", "script"}
RESERVED = {"if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "time", "coproc", "esac"}
DROP_REST = {"for", "select", "case", "function"}

INLINE_FLAGS = {  # interpreter -> (options whose value is code, options that take a non-code value)
    "node": ({"-e", "--eval", "-p", "--print"}, {"-r", "--require", "--import", "--loader", "--input-type", "--env-file", "-C", "--conditions"}),
    "bun": ({"-e", "--eval", "-p", "--print"}, {"-r", "--preload", "--cwd"}),
    "python": ({"-c"}, {"-W", "-X", "-Q"}),
    "perl": ({"-e", "-E"}, {"-I", "-M", "-m"}),
    "ruby": ({"-e"}, {"-I", "-r", "-C"}),
    "php": ({"-r"}, {"-c", "-d"}),
}
SPAWN_API = re.compile(
    r"child_process|\bexecSync\b|\bexecFileSync\b|\bspawnSync\b|\bspawn\s*\(|\bexecFile\s*\(|(?<![.\w])exec\s*\(|\bfork\s*\("
    r"|\bsubprocess\b|\bos\.(system|popen|exec\w*|spawn\w*|posix_spawn\w*)\b|\bpty\.spawn\b|\bpopen\s*\(|\bsystem\s*\("
    r"|\b__import__\b|\bimportlib\b|\bprocess\.(binding|dlopen)\b|_linkedBinding"
    r"|\bBun\.spawn|\bDeno\.(run|Command)\b|\bIO\.popen\b|\bOpen3\b|\bqx\b|\bproc_open\b|\bshell_exec\b|\bpassthru\b|\bpcntl_exec\b"
)
# perl / ruby / php also call these without parentheses, and run commands with backquotes or piped opens
SCRIPT_SPAWN = re.compile(r"\b(system|exec|fork|spawn|popen|qx|syscall|pipe)\b|%x|`|\|\s*['\"]|['\"]\s*-?\|")
# open() counts as a write only when its mode argument writes (open(p, 'w'), mode='a', perl's open(F, '>', p),
# Path(p).open('w')); a read-only open() of a protected path is fine.
WRITE_API = re.compile(
    r"\b(writeFile|appendFile|copyFile|cp|rename|unlink|rm|rmdir|symlink|link|chmod|chown|truncate|mkdir|touch|utimes)(Sync)?\s*\("
    r"|createWriteStream|write_text|write_bytes|\bshutil\b|\bos\.(remove|replace|rename|unlink|rmdir|chmod|symlink|link|truncate)\b"
    r"|File\.(write|open)|IO\.write"
    r"|\bopen\s*\([^,()]*(\([^()]*\)[^,()]*)*,\s*['\"][^'\"]*[wax+>|]|\bmode\s*=\s*['\"][^'\"]*[wax+]"
    r"|\.open\s*\(\s*['\"][^'\"]*[wax+]|\bopen\s*\(\s*(my\s+)?[$\w]+\s*,\s*['\"]\+?[>|]"
)
PROTECTED_MENTION = re.compile(
    r"(?<![\w.-])(\.claude\b|\.github/workflows|CLAUDE\.md|AGENTS\.md|\.npmrc|package-lock\.json|LICENSE|SECURITY\.md|CODEOWNERS"
    r"|server\.json|mcpb/manifest\.json|\.gitignore|\.git/)|\bCLAUDE_ENV_FILE\b",
    re.IGNORECASE,  # the file system is case-insensitive: .CLAUDE/ is .claude/
)
# Checked on the awk program with the contents of its string literals removed, so FS="|" or print $1 "|" $2 are
# not pipes, while print | "cmd" and "cmd" | getline still are.
AWK_EXEC = re.compile(r"\bsystem\s*\(|\|\s*&|\|\s*getline|\bprintf?\b[^;{}]*?\|\s*[\"A-Za-z_(]")
# Also checked on the program as written: a quote inside a regular expression (/"/) makes the string removal pair
# the wrong quotes and can remove a command. Narrow enough that "|" as a field separator or in output still passes.
AWK_EXEC_RAW = re.compile(r"\bsystem\s*\(|\|\s*&|\|\s*getline|\|\s*\"[^\"\n]*\"\s*($|[;}\n])")
AWK_STRING = re.compile(r"\"(\\.|[^\"\\])*\"")

# Protected paths are compared without regard to case: APFS (this machine) and the default macOS / Windows
# file systems are case-insensitive, so ".CLAUDE/hooks/x" and "agents.md" name the protected files.
PROTECTED_COMPONENT = re.compile(r"(^|/)(\.claude|\.git|\.husky)(/|$)|(^|/)\.github/(workflows(/|$)|CODEOWNERS$|dependabot\.yml$)", re.IGNORECASE)
PROTECTED_NAMES = {"CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", ".npmrc", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
                   "SECURITY.md", "CODEOWNERS", "server.json", ".gitignore", ".mcp.json", "lefthook.yml", ".pre-commit-config.yaml"}
PROTECTED_NAMES_LC = {n.lower() for n in PROTECTED_NAMES}

GIT_C_ALLOWED = {"commit.gpgsign", "core.quotepath"}
GIT_C_ALLOWED_PREFIXES = ("color.", "advice.")
GIT_CONFIG_READ = {"--get", "--get-all", "--get-regexp", "--list", "-l", "--show-origin"}
GIT_CONFIG_WRITE = {"--add", "--unset", "--unset-all", "--replace-all", "--rename-section", "--remove-section", "-e", "--edit"}
GIT_PLUMBING = {"update-index", "mktree", "commit-tree", "fast-import", "read-tree", "checkout-index", "replace", "update-ref", "symbolic-ref"}
GIT_OTHER = {"send-email", "instaweb", "daemon", "svn", "p4", "cvsimport", "cvsserver", "cvsexportcommit", "archimport",
             "shell", "upload-pack", "receive-pack", "upload-archive",
             "maintenance"}  # register/start write the global config and a launchd/cron job that runs git later
# git and gh run outside the sandbox: only these subcommands are allowed; anything else (including
# aliases and external git-*/gh-* commands) is refused. The rules in _git/_gh still apply to them.
GIT_ALLOWED = {
    "status", "diff", "log", "show", "add", "commit", "restore", "switch", "checkout", "branch", "fetch", "pull",
    "push", "stash", "rev-parse", "ls-files", "grep", "blame", "tag", "config", "apply", "am", "merge-base",
    "describe", "remote", "shortlog", "cat-file", "ls-tree", "reflog", "show-ref", "for-each-ref", "hash-object",
    "merge", "rebase", "cherry-pick", "reset", "clean", "mv", "rm", "worktree", "version", "help", "var",
    # also allowed, with the restrictions below: read-only or already tested before the allowlist
    "ls-remote", "rev-list", "submodule", "update-index",
}
GH_ALLOWED = {  # command -> allowed subcommands (None: no subcommand)
    "pr": {"create", "view", "list", "diff", "checks", "edit", "comment", "close", "reopen", "ready", "status"},
    "issue": {"view", "list", "create", "comment"},
    "run": {"list", "view", "watch", "rerun", "cancel"},
    "workflow": {"list", "view"},
    "release": {"view", "list"},
    "repo": {"view"},
    "search": {"code", "commits", "issues", "prs", "repos"},
    "config": {"get", "list"},
    "api": None,
    "status": None,
    "browse": None,
}
GH_VALUE_FLAGS = {"-R", "--repo", "--hostname"}
GH_BOOL_FLAGS = {"-h", "--help", "--version"}
GH_BLOCKED = {"secret", "variable", "auth", "alias", "extension", "extensions", "ext", "codespace", "cs", "ssh-key", "gpg-key"}
GH_WRITE_METHODS = {"DELETE", "PATCH", "PUT", "POST"}
REMOTE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
TAG_LIKE = re.compile(r"^v?\d+(\.\d+)+")
# Variables that change which configuration, programs or code git/gh and the processes they start
# (hooks, pagers, editors, ssh, gpg, interpreters) load. Those processes run outside the sandbox too.
EXEC_ENV_NAME = re.compile(
    r"(HOME|PATH|CDPATH|XDG_CONFIG_HOME|XDG_CONFIG_DIRS|EDITOR|VISUAL|PAGER|BROWSER|LESSOPEN|LESSCLOSE|GH_[A-Z0-9_]+|GIT_[A-Z0-9_]+"
    r"|BASH_ENV|ENV|SHELL|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_[A-Z0-9_]+|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP"
    r"|NODE_OPTIONS|NODE_PATH|PERL5LIB|PERL5OPT|RUBYOPT|RUBYLIB|SSH_ASKPASS|GNUPGHOME"
    # git help runs man, and man runs its pager and formatter through these
    r"|MANPAGER|MANOPT|MANPATH|MANROFFOPT|MANSECT|GROFF_[A-Z0-9_]+|LESS|LESSKEY|LESSKEYIN|LESSKEY_SYSTEM)"
)
# Package-manager configuration through the environment (registry, ignore-scripts, userconfig, ...), refused in
# any command line; npm_config_cache (the cache directory) is allowed.
PKG_ENV = re.compile(r"^(npm_config_|yarn_|bun_config_|pnpm_config_)", re.IGNORECASE)
PKG_ENV_ALLOWED = {"npm_config_cache", "npm_config_loglevel", "npm_config_fund", "npm_config_audit",
                   "npm_config_update_notifier", "npm_config_progress", "npm_config_color"}  # output-only settings
# Package-manager options that may come before the subcommand: those that take a value, and flags.
PM_VALUE_OPTS = {
    "npm": {"--prefix", "-C", "-w", "--workspace", "--userconfig", "--globalconfig", "--cache", "--loglevel", "--tag", "--otp", "--scope",
            "--logs-dir", "--omit", "--include"},
    "pnpm": {"-C", "--dir", "--filter", "-F", "--reporter", "--loglevel", "--store-dir", "--config-dir"},
    "yarn": {"--cwd", "--cache-folder", "--modules-folder", "--network-timeout"},
    "bun": {"--cwd", "-c", "--config"},
}
PM_BOOL_OPTS = {"-g", "--global", "-s", "--silent", "-q", "--quiet", "-d", "-dd", "-ddd", "--verbose", "-y", "--yes", "--json",
                "--offline", "--prefer-offline", "--prefer-online", "--ignore-scripts", "--dry-run", "--no-audit", "--no-fund",
                "--no-progress", "--workspaces", "-ws", "--include-workspace-root", "-l", "--long", "-p", "--parseable", "-f",
                "--force", "--foreground-scripts", "-r", "--recursive", "-w", "--workspace-root", "--frozen-lockfile",
                "-v", "--version", "-h", "--help", "--color", "--no-color", "--no-update-notifier", "--if-present",
                "--no-save", "--no-package-lock"}
SAFE_ENV = {("GIT_TERMINAL_PROMPT", "0"), ("GIT_OPTIONAL_LOCKS", "0"), ("PAGER", "cat"), ("GIT_PAGER", "cat"), ("GH_PAGER", "cat")}
# Builtins whose arguments name variables (NAME or NAME=value)
SETTERS = {"export", "declare", "typeset", "local", "readonly"}
READERS = {"read", "mapfile", "readarray"}
ASSIGN_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=")
ASSIGN_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?$")
TMP_VAR = re.compile(r"^(\$TMPDIR|\$\{TMPDIR\}|\$\{TMPDIR:\?[^}]*\})/(.+)$")
CLAUDE_TMP = re.compile(r"^/(private/)?tmp/claude-\d+/[^/]+/.+")
SHORT_CLUSTER = re.compile(r"^-[A-Za-z]+$")


# ---------------------------------------------------------------------------
# Shell lexer
# ---------------------------------------------------------------------------
class ParseError(Exception):
    pass


class Word(object):
    __slots__ = ("text", "quoted", "dynamic", "glob", "brace", "comma", "assign")

    def __init__(self):
        self.text = ""        # quotes removed; expansions kept as written ($X, $(...))
        self.assign = False   # starts with an unquoted NAME= (a variable assignment)
        self.quoted = False   # some part was quoted or escaped
        self.dynamic = False  # contains $var, ${...}, $(...), `...` or $'...'
        self.glob = False     # unquoted * ? [
        self.brace = False    # unquoted {
        self.comma = False    # unquoted ,


class HereDoc(object):
    __slots__ = ("strip", "delim", "quoted", "body")

    def __init__(self, strip):
        self.strip = strip
        self.delim = None
        self.quoted = False
        self.body = ""


OPERATORS = sorted(["&&", "||", ";;&", ";;", ";&", "|&", "&>>", "&>", ">>", ">|", ">&", "<<<", "<<-", "<<", "<&", "<>",
                    ";", "&", "|", "(", ")", "<", ">", "\n"], key=len, reverse=True)
REDIRECT_OPS = {">", ">>", ">|", ">&", "&>", "&>>", "<>", "<", "<&", "<<<"}
PIPE_OPS = {"|", "|&"}


def _skip_single(s, i):
    j = s.find("'", i)
    if j < 0:
        raise ParseError("unterminated single quote")
    return j + 1


def _scan_backtick(s, i):
    n = len(s)
    while i < n:
        if s[i] == "\\":
            i += 2
            continue
        if s[i] == "`":
            return i
        i += 1
    raise ParseError("unterminated backquote")


def _skip_double(s, i):
    n = len(s)
    while i < n:
        c = s[i]
        if c == "\\":
            i += 2
            continue
        if c == '"':
            return i + 1
        if c == "`":
            i = _scan_backtick(s, i + 1) + 1
            continue
        if c == "$" and i + 1 < n and s[i + 1] in "({":
            i = (_scan_group(s, i + 2, "(", ")") if s[i + 1] == "(" else _scan_group(s, i + 2, "{", "}")) + 1
            continue
        i += 1
    raise ParseError("unterminated double quote")


def _scan_group(s, i, open_c, close_c):
    depth = 1
    n = len(s)
    while i < n:
        c = s[i]
        if c == "\\":
            i += 2
            continue
        if c == "'":
            i = _skip_single(s, i + 1)
            continue
        if c == '"':
            i = _skip_double(s, i + 1)
            continue
        if c == "`":
            i = _scan_backtick(s, i + 1) + 1
            continue
        if c == open_c:
            depth += 1
        elif c == close_c:
            depth -= 1
            if depth == 0:
                return i
        i += 1
    raise ParseError("unterminated " + ("$(...) or <(...)" if open_c == "(" else "${...}"))


def _ansi_c(body):
    try:
        return body.encode("latin-1", "backslashreplace").decode("unicode_escape")
    except Exception:
        return body


def _lex_backtick(s, i, w, subs):
    j = _scan_backtick(s, i + 1)
    subs.append(re.sub(r"\\([\\`$])", r"\1", s[i + 1:j]))
    w.dynamic = True
    w.text += s[i:j + 1]
    return j + 1


def _collect_expansions(text, subs):
    _lex_dquote(text, 0, Word(), subs, None)


def _lex_dollar(s, i, w, subs, in_dq):
    n = len(s)
    nx = s[i + 1] if i + 1 < n else ""
    if nx == "(":
        j = _scan_group(s, i + 2, "(", ")")
        if s.startswith("((", i + 1) and j - 1 > i + 2 and s[j - 1] == ")":
            _collect_expansions(s[i + 3:j - 1], subs)  # arithmetic: only nested substitutions run
        else:
            subs.append(s[i + 2:j])
        w.dynamic = True
        w.text += s[i:j + 1]
        return j + 1
    if nx == "{":
        j = _scan_group(s, i + 2, "{", "}")
        _collect_expansions(s[i + 2:j], subs)
        w.dynamic = True
        w.text += s[i:j + 1]
        return j + 1
    if nx == "'" and not in_dq:
        j = i + 2
        while j < n and s[j] != "'":
            j += 2 if s[j] == "\\" else 1
        if j >= n:
            raise ParseError("unterminated $'...' string")
        w.text += _ansi_c(s[i + 2:j])
        w.quoted = True
        w.dynamic = True
        return j + 1
    if nx == '"' and not in_dq:
        w.quoted = True
        return _lex_dquote(s, i + 2, w, subs, '"')
    m = re.match(r"[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-]", s[i + 1:i + 200])
    if m:
        w.dynamic = True
        w.text += "$" + m.group(0)
        return i + 1 + len(m.group(0))
    w.text += "$"
    return i + 1


def _lex_dquote(s, i, w, subs, term):
    n = len(s)
    while i < n:
        c = s[i]
        if term is not None and c == term:
            return i + 1
        if c == "\\" and i + 1 < n:
            nx = s[i + 1]
            if nx in '$`"\\\n':
                if nx != "\n":
                    w.text += nx
                i += 2
                continue
            w.text += c
            i += 1
            continue
        if c == "`":
            i = _lex_backtick(s, i, w, subs)
            continue
        if c == "$":
            i = _lex_dollar(s, i, w, subs, True)
            continue
        w.text += c
        i += 1
    if term is not None:
        raise ParseError("unterminated double quote")
    return i


def _read_heredocs(s, i, pending, subs):
    n = len(s)
    for hd in pending:
        lines = []
        while True:
            j = s.find("\n", i)
            line = s[i:] if j < 0 else s[i:j]
            nxt = n if j < 0 else j + 1
            if not hd.quoted:
                # With an unquoted delimiter bash removes backslash-newline before it looks for the
                # delimiter, so "EO\<newline>F" ends the heredoc (checked with bash 3.2 on macOS).
                while j >= 0 and (len(line) - len(line.rstrip("\\"))) % 2 == 1:
                    k = s.find("\n", nxt)
                    line = line[:-1] + (s[nxt:] if k < 0 else s[nxt:k])
                    j = k
                    nxt = n if k < 0 else k + 1
            cmp = line.lstrip("\t") if hd.strip else line
            if cmp == hd.delim:
                i = nxt
                break
            if j < 0:
                raise ParseError("unterminated heredoc (no line '{}')".format(hd.delim))
            lines.append(line)
            i = nxt
        hd.body = "\n".join(lines)
        if not hd.quoted:
            _collect_expansions(hd.body, subs)
    return i


def _lex(s, subs):
    toks = []
    pending = []
    state = {"w": None, "delim": None}
    n = len(s)
    i = 0

    def word():
        if state["w"] is None:
            state["w"] = Word()
        return state["w"]

    def flush():
        w = state["w"]
        if w is None:
            return
        if state["delim"] is not None:
            state["delim"].delim = w.text
            state["delim"].quoted = w.quoted
            pending.append(state["delim"])
            state["delim"] = None
        else:
            toks.append(("word", w))
        state["w"] = None

    while i < n:
        c = s[i]
        if c in " \t\r":
            flush()
            i += 1
            continue
        if c == "\\":
            if i + 1 < n and s[i + 1] == "\n":
                i += 2
                continue
            w = word()
            w.quoted = True
            if i + 1 < n:
                w.text += s[i + 1]
            i += 2
            continue
        if c == "#" and state["w"] is None:
            j = s.find("\n", i)
            i = n if j < 0 else j
            continue
        if c == "'":
            w = word()
            j = _skip_single(s, i + 1)
            w.quoted = True
            w.text += s[i + 1:j - 1]
            i = j
            continue
        if c == '"':
            w = word()
            w.quoted = True
            i = _lex_dquote(s, i + 1, w, subs, '"')
            continue
        if c == "`":
            i = _lex_backtick(s, i, word(), subs)
            continue
        if c == "$":
            i = _lex_dollar(s, i, word(), subs, False)
            continue
        if c in "<>" and i + 1 < n and s[i + 1] == "(":
            j = _scan_group(s, i + 2, "(", ")")
            subs.append(s[i + 2:j])
            w = word()
            w.dynamic = True
            w.text += s[i:j + 1]
            i = j + 1
            continue
        if c in ";&|()<>\n":
            w = state["w"]
            if c in "<>" and w is not None and w.text.isdigit() and not w.quoted and not w.dynamic:
                state["w"] = None  # file-descriptor number of a redirection
            flush()
            op = next(o for o in OPERATORS if s.startswith(o, i))
            i += len(op)
            if op in ("<<", "<<-"):
                hd = HereDoc(op == "<<-")
                toks.append(("heredoc", hd))
                state["delim"] = hd
            else:
                if state["delim"] is not None:
                    raise ParseError("heredoc without a delimiter")
                toks.append(("op", op))
            if op == "\n" and pending:
                i = _read_heredocs(s, i, pending, subs)
                del pending[:]
            continue
        w = word()
        if c in "*?[":
            w.glob = True
        elif c == "{":
            w.brace = True
        elif c == ",":
            w.comma = True
        elif c == "=" and not w.quoted and not w.dynamic and not w.assign and ASSIGN_NAME.match(w.text):
            w.assign = True
        w.text += c
        i += 1
    flush()
    if state["delim"] is not None or pending:
        raise ParseError("unterminated heredoc")
    return toks


class Cmd(object):
    def __init__(self, piped_in):
        self.words = []
        self.redirs = []     # (op, Word)
        self.heredocs = []   # HereDoc
        self.piped_in = piped_in

    def empty(self):
        return not (self.words or self.redirs or self.heredocs)


def _build(toks):
    cmds = []
    cur = Cmd(False)
    i = 0
    n = len(toks)
    while i < n:
        kind, val = toks[i]
        if kind == "word":
            if not val.quoted and val.text in ("{", "}"):
                if not cur.empty():
                    cmds.append(cur)
                    cur = Cmd(False)
            else:
                cur.words.append(val)
        elif kind == "heredoc":
            cur.heredocs.append(val)
        elif val in REDIRECT_OPS:
            if i + 1 >= n or toks[i + 1][0] != "word":
                raise ParseError("redirection without a target")
            cur.redirs.append((val, toks[i + 1][1]))
            i += 1
        elif val in PIPE_OPS:
            cmds.append(cur)
            cur = Cmd(True)
        elif val == "(" and cur.empty():
            pass  # subshell start: keep the pipe state of the command that follows
        else:
            if not cur.empty():
                cmds.append(cur)
            cur = Cmd(False)
        i += 1
    cmds.append(cur)
    return [c for c in cmds if not c.empty()]


# ---------------------------------------------------------------------------
# Collecting what runs
# ---------------------------------------------------------------------------
class Ctx(object):
    def __init__(self, cwd, flat):
        self.cwd = cwd
        self.flat = flat
        self.cmds = []     # every simple command, for cd tracking
        self.invs = []     # (words, cmd): every command that runs, wrappers included
        self.writes = []   # Word: redirection targets
        self.codes = []    # (lang, code): inline interpreter code
        self.problems = []  # block reasons found while collecting
        self.asks = []     # reasons to ask a human
        self.assigns = []  # (name, value): variables this command line sets; name None = computed at run time
        self.subs = []     # the text of every command substitution ($(...), `...`, <(...), >(...))
        self.outside = False  # the line runs gh or git push/fetch/ls-remote (excludedCommands: outside the sandbox)
        without = re.sub(r"\$\{?TMPDIR", "", flat)
        # TMPDIR may be changed in this command line (assigned, exported, read, unset...); decide() also
        # counts a sourced file
        self.tmpdir_tainted = "TMPDIR" in without

    def bases(self):
        """Directories git/gh may run in: the session cwd and every literal cd target. None = unknown."""
        # CDPATH and cdable_vars make "cd name" go somewhere the text does not say
        if "cdable_vars" in self.flat or any(n in ("CDPATH", None) for n, _ in self.assigns):
            return None
        out = [self.cwd]
        cur = self.cwd
        for c in self.cmds:
            words = c.words
            while words and _base(words[0].text) in ("builtin", "command") and len(words) > 1:
                words = words[1:]
            if not words:
                continue
            name = _base(words[0].text)
            if name not in ("cd", "pushd", "popd"):
                continue
            args = [w for w in words[1:] if not w.text.startswith("-")]
            if name == "popd" or not args or args[0].dynamic or args[0].glob or args[0].text == "-":
                return None
            cur = os.path.normpath(os.path.join(cur, os.path.expanduser(args[0].text)))
            out.append(cur)
        return out


MAX_DEPTH = 8


def _base(text):
    """The command name: basename, lower-cased. On a case-insensitive file system "CURL" or "/usr/bin/Curl" finds
    curl through PATH, so every name-based rule compares lower-case names."""
    return os.path.basename(text).lower()


def _texts(words):
    return [w.text for w in words]


def _is_cluster(t):
    return bool(SHORT_CLUSTER.match(t))


def _positionals(args):
    return [t for t in args if not t.startswith("-")]


def _collect(s, ctx, depth):
    if depth > MAX_DEPTH:
        raise ParseError("commands nested too deeply")
    subs = []
    toks = _lex(s, subs)
    for cmd in _build(toks):
        _process(cmd, ctx, depth)
    ctx.subs.extend(subs)
    for sub in subs:
        _collect(sub, ctx, depth + 1)


def _process(cmd, ctx, depth):
    words = list(cmd.words)
    while words:
        w = words[0]
        if w.assign:
            name, _, value = w.text.partition("=")
            ctx.assigns.append((name.rstrip("+").split("[")[0], value))
            words.pop(0)
            continue
        if not w.quoted and w.text in RESERVED:
            words.pop(0)
            if w.text == "time" and words and words[0].text == "-p":
                words.pop(0)
            continue
        break
    if words and not words[0].quoted and words[0].text in DROP_REST:
        if words[0].text in ("for", "select") and len(words) > 1:
            ctx.assigns.append((words[1].text if not words[1].dynamic else None, ""))  # the loop variable
        words = []
    cmd.words = words
    ctx.cmds.append(cmd)
    for op, target in cmd.redirs:
        if target.text.startswith(("/dev/tcp/", "/dev/udp/")):
            ctx.problems.append(MSG_DEV_TCP)
        if op == "<<<" or op in ("<", "<&"):
            continue
        if op == ">&" and (target.text.isdigit() or target.text == "-"):
            continue
        ctx.writes.append(target)
    if words:
        _expand(words, cmd, ctx, depth)


def _skip_opts(a, i, with_value=()):
    n = len(a)
    while i < n and a[i].startswith("-") and a[i] != "-":
        if a[i] == "--":
            return i + 1
        i += 2 if a[i] in with_value else 1
    return i


def _skip_value_opts(a, names):
    """a without the options in names and their values (separate or --opt=value)."""
    out = []
    i = 0
    while i < len(a):
        t = a[i]
        if t in names:
            i += 2
            continue
        if not any(nm.startswith("--") and t.startswith(nm + "=") for nm in names):
            out.append(t)
        i += 1
    return out


def _option_value(a, names):
    """Values of options in names (separate or --opt=value)."""
    out = []
    for k, t in enumerate(a):
        if t in names and k + 1 < len(a):
            out.append(a[k + 1])
        for nm in names:
            if nm.startswith("--") and t.startswith(nm + "="):
                out.append(t.split("=", 1)[1])
    return out


def _wrapped(name, a):
    """For a wrapper, return (index of the wrapped command in a or None, shell strings it runs)."""
    n = len(a)
    i = 1
    if name == "env":
        while i < n:
            t = a[i]
            if t in ("-S", "--split-string"):
                return None, [" ".join(a[i + 1:])]
            if t.startswith("-S") or t.startswith("--split-string="):
                val = t[2:] if t.startswith("-S") else t.split("=", 1)[1]
                return None, [" ".join([val] + a[i + 1:])]
            if t in ("-u", "--unset", "-C", "--chdir", "-P"):
                i += 2
                continue
            if t == "--":
                i += 1
                break
            if (t.startswith("-") and t != "-") or ASSIGN_RE.match(t):
                i += 1
                continue
            break
    elif name in ("command", "builtin"):
        while i < n and a[i] == "-p":
            i += 1
        if i < n and a[i] in ("-v", "-V"):
            return None, []
    elif name == "exec":
        i = _skip_opts(a, i, ("-a",))
    elif name == "nice":
        i = _skip_opts(a, i, ("-n", "--adjustment"))
    elif name == "time":
        i = _skip_opts(a, i, ("-o", "--output", "-f", "--format"))
    elif name == "caffeinate":
        i = _skip_opts(a, i, ("-t", "-w"))
    elif name == "arch":
        i = _skip_opts(a, i, ("-e",))
    elif name == "stdbuf":
        i = _skip_opts(a, i, ("-i", "-o", "-e"))
    elif name == "setsid":
        i = _skip_opts(a, i)
    elif name == "timeout":
        i = _skip_opts(a, i, ("-s", "-k", "--signal", "--kill-after")) + 1
    elif name == "xargs":
        i = _skip_opts(a, i, ("-I", "-L", "-n", "-P", "-s", "-d", "-E", "-a", "--arg-file", "--delimiter", "--max-args",
                              "--max-procs", "--max-chars", "--max-lines", "--replace", "--eof"))
    elif name in ("flock", "script"):
        for k in range(1, n):
            if a[k] in ("-c", "--command") and k + 1 < n:
                return None, [a[k + 1]]
            if a[k].startswith("--command="):
                return None, [a[k].split("=", 1)[1]]
        if name == "flock":
            i = _skip_opts(a, i, ("-w", "--timeout", "-E", "--conflict-exit-code"))
            if i < n and a[i].isdigit():
                return None, []
        else:
            i = _skip_opts(a, i, ("-t", "-F", "-T", "-I", "-O", "-B", "-E", "-m", "--timing", "--log-in", "--log-out", "--log-io"))
        i += 1  # lock file / typescript file
    elif name == "watch":
        i = _skip_opts(a, i, ("-n", "--interval", "-q", "--equexit"))
        return None, ([" ".join(a[i:])] if i < n else [])
    elif name == "parallel":
        i = _skip_opts(a, i, ("-j", "-P", "--jobs", "-S", "--sshlogin", "-N", "-n", "-L", "-I", "--arg-sep", "-a", "--arg-file"))
        j = i
        while j < n and a[j] not in (":::", "::::", ":::+", "::::+"):
            j += 1
        return None, ([" ".join(a[i:j])] if j > i else [])
    # busybox, nohup: the command follows directly
    return (i if i < n else None), []


def _interp_lang(name):
    if name in ("node", "nodejs"):
        return "node"
    if name == "bun":
        return "bun"
    if re.match(r"^python[0-9.]*$", name):
        return "python"
    if name in ("perl", "ruby", "php"):
        return name
    return None


def _inline(lang, a):
    """Return (code strings, reads code from stdin)."""
    code_opts, value_opts = INLINE_FLAGS[lang]
    letters = {o[1] for o in code_opts if len(o) == 2}
    codes = []
    n = len(a)
    i = 1
    while i < n:
        t = a[i]
        if t == "-":
            return codes, not codes
        if t == "--":
            return codes, not codes and i + 1 >= n
        if t in code_opts:
            if i + 1 < n:
                codes.append(a[i + 1])
            i += 2
            continue
        if t in value_opts:
            i += 2
            continue
        if t.startswith("--"):
            key, _, val = t.partition("=")
            if key in code_opts and val:
                codes.append(val)
            i += 1
            continue
        if lang == "python" and t == "-m":
            return codes, False
        if lang in ("node", "bun") and _is_cluster(t) and t[-1] in "ep":
            if i + 1 < n:
                codes.append(a[i + 1])  # node -pe "code"
            i += 2
            continue
        if t.startswith("-") and len(t) > 2 and lang in ("python", "perl", "ruby", "php"):
            if _is_cluster(t) and t[-1] in letters:
                if i + 1 < n:
                    codes.append(a[i + 1])
                i += 2
                continue
            for k in range(1, len(t)):
                if t[k] in letters:
                    codes.append(t[k + 1:])
                    break
            i += 1
            continue
        if t.startswith("-"):
            i += 1
            continue
        return codes, False  # a script file
    return codes, not codes


def _awk_programs(a):
    progs = []
    has_file = False
    n = len(a)
    i = 1
    while i < n:
        t = a[i]
        if t == "--":
            i += 1
            break
        if t in ("-f", "--file"):
            has_file = True
            i += 2
            continue
        if t.startswith("--file="):
            has_file = True
            i += 1
            continue
        if t in ("-e", "--source"):
            progs.append(a[i + 1] if i + 1 < n else "")
            i += 2
            continue
        if t.startswith("--source="):
            progs.append(t.split("=", 1)[1])
            i += 1
            continue
        if t in ("-v", "-F", "--assign", "--field-separator"):
            i += 2
            continue
        if t.startswith("-") and t != "-":
            i += 1
            continue
        break
    if not progs and not has_file and i < n:
        progs.append(a[i])
    return progs


def _find_execs(words):
    out = []
    n = len(words)
    i = 1
    while i < n:
        if words[i].text in ("-exec", "-execdir", "-ok", "-okdir"):
            j = i + 1
            while j < n and words[j].text not in (";", "+"):
                j += 1
            if j > i + 1:
                out.append(words[i + 1:j])
            i = j
        i += 1
    return out


def _record_assigns(name, words, ctx):
    """Record the variables a command sets (for the git/gh environment rule). Computed names are recorded as None."""
    args = words[1:]

    def add(w_or_text, value=""):
        text = w_or_text if isinstance(w_or_text, str) else w_or_text.text
        nm = text.split("=", 1)[0]
        if re.search(r"[$`]", nm):
            ctx.assigns.append((None, value))
        else:
            ctx.assigns.append((nm.rstrip("+").split("[")[0], value))

    if name == "env":
        for w in args:
            if w.text.startswith("-"):
                continue
            if w.assign or ASSIGN_RE.match(w.text) or ("=" in w.text and re.search(r"[$`]", w.text.split("=", 1)[0])):
                add(w, w.text.partition("=")[2])
                continue
            break
    elif name in SETTERS:
        nameref = any(re.match(r"^-[A-Za-z]*n", w.text) for w in args)
        for w in args:
            if w.text.startswith(("-", "+")) and not w.dynamic:
                continue
            nm, _, value = w.text.partition("=")
            add(w, value)
            if nameref and value:
                add(value)  # declare -n ref=NAME makes later assignments to ref set NAME
    elif name in READERS:
        for w in args:
            if not w.text.startswith("-") or w.dynamic:
                add(w)
    elif name == "printf":
        for k, w in enumerate(args):
            if w.text == "-v" and k + 1 < len(args):
                add(args[k + 1])
            elif w.text.startswith("-v") and len(w.text) > 2:
                add(w.text[2:])
    elif name == "getopts" and len(args) >= 2:
        add(args[1])


def _stdin_script(name, a):
    """True when a shell, source or an interpreter would run a script the guardrail cannot read."""
    # Any positional, not only the first: an option value (bash -o posix /dev/stdin) comes before the script.
    # "bash -" / "python3 -" read stdin: a heredoc there is checked, a pipe is refused by the pipe rule.
    pos = [t for t in a[1:] if not t.startswith("-") and t != "-"]
    if name in SHELLS or name in ("source", "."):
        return any(STDIN_SCRIPT.match(t) for t in pos)
    lang = _interp_lang(name)
    if lang:
        codes, _ = _inline(lang, a)
        return not codes and any(STDIN_SCRIPT.match(t) for t in pos)
    return False


def _expand(words, cmd, ctx, depth):
    while words:
        ctx.invs.append((words, cmd))
        a = _texts(words)
        name = _base(a[0])
        _record_assigns(name, words, ctx)
        if name in WRAPPERS:
            idx, strings = _wrapped(name, a)
            for st in strings:
                _collect(st, ctx, depth + 1)
            if idx is None:
                return
            words = words[idx:]
            continue
        if name == "find":
            for inner in _find_execs(words):
                _expand(inner, Cmd(False), ctx, depth)
        elif name == "trap":
            pos = [t for t in a[1:] if t not in ("-p", "-l", "--")]
            if pos and pos[0] not in ("-", ""):
                _collect(pos[0], ctx, depth + 1)
        elif name in SHELLS:
            for hd in cmd.heredocs:
                _collect(hd.body, ctx, depth + 1)
            for op, target in cmd.redirs:
                if op == "<<<":
                    _collect(target.text, ctx, depth + 1)
        else:
            lang = _interp_lang(name)
            if lang:
                codes, stdin = _inline(lang, a)
                if stdin:
                    codes += [hd.body for hd in cmd.heredocs]
                    codes += [t.text for op, t in cmd.redirs if op == "<<<"]
                for code in codes:
                    ctx.codes.append((lang, code))
        return


# ---------------------------------------------------------------------------
# Rules
# ---------------------------------------------------------------------------
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


def _pkg_name(p):
    if p.startswith("@"):
        head, _, _ = p[1:].partition("@")
        return "@" + head
    return p.split("@")[0]


# npm's own aliases for install (npm/lib/utils/cmd-list.js) and install-test
NPM_INSTALL = {"install", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "isntall", "add",
               "install-test", "it"}


def _pm_command(tool, args):
    """Index of the package manager's subcommand in args (None if there is none), or an error when an option the
    hook does not know comes before it (it could take the next word as its value and hide the subcommand)."""
    values = PM_VALUE_OPTS.get(tool, set())
    i = 0
    while i < len(args):
        t = args[i]
        if t == "--":
            return (i + 1 if i + 1 < len(args) else None), None
        if t.startswith("-") and t != "-":
            key = t.split("=", 1)[0]
            if "=" in t:
                i += 1
            elif key in values:
                i += 2
            elif key == "--color" and i + 1 < len(args) and args[i + 1] in ("always", "true", "false"):
                i += 2  # npm's --color takes an optional value ("--color always install x" installs x)
            elif key in PM_BOOL_OPTS:
                i += 1
            else:
                return None, MSG_PM_FLAG_FIRST
            continue
        return i, None
    return None, None


def _pm_sub(tool, args):
    """(subcommand, the arguments after it) for npm, pnpm, yarn and bun; (None, []) when there is none."""
    idx, err = _pm_command(tool, args)
    if err or idx is None:
        return None, []
    return args[idx], args[idx + 1:]


def check_installs(argv, allowed):
    """Block 'npm install <pkg>' etc. unless every package is in the allowlist."""
    tool = _base(argv[0])
    sub, after = _pm_sub(tool, argv[1:]) if tool in PM_VALUE_OPTS else (None, [])
    pkgs = None
    if tool == "npm" and sub in NPM_INSTALL:
        pkgs = [a for a in after if not a.startswith("-")]
    elif tool == "pnpm" and sub in ("add", "install", "i"):
        pkgs = [a for a in after if not a.startswith("-")]
    elif tool == "yarn" and sub == "add":
        pkgs = [a for a in after if not a.startswith("-")]
    elif tool == "yarn" and sub == "global" and after[:1] == ["add"]:
        pkgs = [a for a in after[1:] if not a.startswith("-")]
    elif tool == "bun" and sub in ("add", "install", "i"):
        pkgs = [a for a in after if not a.startswith("-")]
    problems = []
    for p in pkgs or []:
        if re.match(r"^(https?:|git\+|git:|github:|file:|\.|/)", p) or p.endswith((".tgz", ".tar.gz")):
            problems.append(f"'{p}' (URL/path/tarball installs are forbidden)")
        elif _pkg_name(p) not in allowed:
            problems.append(f"'{_pkg_name(p)}' (not in .claude/allowed-packages.txt)")
    return problems


def _initializer(pkg):
    """npm init <pkg> / create <pkg> runs the package create-<pkg> (@scope -> @scope/create, @scope/x -> @scope/create-x)."""
    if pkg.startswith("@"):
        scope, _, rest = pkg.partition("/")
        return scope + "/create" + ("-" + rest if rest else "")
    return "create-" + pkg


def _npx_packages(rest):
    """Packages npx / npm exec / dlx install or run: every --package / -p given before the command, and the command.
    Options after the command belong to the command (npx tsc -p tsconfig.json)."""
    pkgs = []
    i = 0
    while i < len(rest):
        t = rest[i]
        if t == "--":
            pkgs += rest[i + 1:i + 2]
            break
        if t in ("-p", "--package"):
            pkgs += rest[i + 1:i + 2]
            i += 2
            continue
        if t.startswith("--package="):
            pkgs.append(t.split("=", 1)[1])
        elif t in ("-c", "--call"):
            i += 2
            continue
        elif not t.startswith("-"):
            pkgs.append(t)
            break
        i += 1
    return pkgs


def check_npx(argv, allowed):
    tool = _base(argv[0])
    sub, after = _pm_sub(tool, argv[1:]) if tool in PM_VALUE_OPTS else (None, [])
    if (tool == "npm" and sub in ("exec", "x")) or tool in ("npx", "bunx") or (tool in ("pnpm", "yarn") and sub == "dlx") or (
            tool == "bun" and sub == "x"):
        pkgs = _npx_packages(argv[1:] if tool in ("npx", "bunx") else after)
    elif (tool == "npm" and sub in ("init", "create", "innit")) or (tool in ("pnpm", "yarn", "bun") and sub == "create"):
        args = [a for a in after if not a.startswith("-")]
        pkgs = [_initializer(args[0])] if args else []
    else:
        return []
    return [f"'{_pkg_name(p)}' (not in .claude/allowed-npx.txt)" for p in pkgs if _pkg_name(p) not in allowed]


def _is_protected_path(p):
    p = p.replace(os.sep, "/")
    if PROTECTED_COMPONENT.search(p):
        return True
    name = p.rstrip("/").rsplit("/", 1)[-1].lower()
    if name in PROTECTED_NAMES_LC or name == "license" or name.startswith("license."):
        return True
    return p.lower().endswith("mcpb/manifest.json")


def _brace_expand(s, limit=64):
    """Expand {a,b} alternatives the way bash would (ranges are left as they are)."""
    depth = 0
    start = None
    for i, c in enumerate(s):
        if c == "{":
            if depth == 0:
                start = i
            depth += 1
        elif c == "}" and depth:
            depth -= 1
            if depth == 0:
                inner = s[start + 1:i]
                parts, d, cur = [], 0, ""
                for ch in inner:
                    if ch == "," and d == 0:
                        parts.append(cur)
                        cur = ""
                        continue
                    d += (ch == "{") - (ch == "}")
                    cur += ch
                parts.append(cur)
                if len(parts) < 2:
                    continue
                out = []
                for p in parts:
                    out += _brace_expand(s[:start] + p + s[i + 1:], limit)
                    if len(out) >= limit:
                        break
                return out[:limit]
    return [s]


def _protected_target(text, ctx):
    if not text or text == "-" or text.startswith("/dev/"):
        return False
    # Claude Code sources this file (and the shell snapshots under ~/.claude) before each Bash call
    if re.search(r"\$\{?CLAUDE_ENV_FILE\b", text):
        return True
    bases = ctx.bases()
    for cand in _brace_expand(text):
        if _is_protected_path(cand):
            return True
        p = os.path.expanduser(cand)
        if bases is None and not os.path.isabs(p) and not TMP_VAR.match(cand):
            return True  # relative to a directory the hook cannot work out
        for base in bases or [ctx.cwd]:
            ab = os.path.normpath(os.path.join(base, p))
            paths = [ab]
            if re.search(r"[*?\[]", ab):
                paths += glob.glob(ab)  # a glob that matches an existing file writes that file
            for q in paths:
                if _is_protected_path(q) or _is_protected_path(os.path.realpath(q)):
                    return True
    return False


def _computed(text, ctx):
    """True when a path git/gh would write is computed at run time (other than "$TMPDIR/<name>")."""
    if not re.search(r"[$`]", text):
        return False
    m = TMP_VAR.match(text)
    return not (m and not ctx.tmpdir_tainted and not re.search(r"[$`]", m.group(2)) and ".." not in m.group(2).split("/"))


def _write_targets(name, a):
    args = a[1:]
    pos = _positionals(args)
    if name == "tee":
        return pos
    if name == "cp":
        t = _option_value(args, ("-t", "--target-directory"))
        return t or pos[-1:]
    if name in ("mv", "ln", "install", "rm", "rmdir", "unlink", "truncate", "touch", "mkdir", "chmod", "chown", "chgrp", "shred"):
        return pos
    if name == "sed" and any(t == "--in-place" or t.startswith(("--in-place=", "-i")) or (_is_cluster(t) and "i" in t) for t in args):
        files = [t for t in pos if t]  # BSD "sed -i ''" gives an empty suffix
        script_given = any(t in ("-e", "-f", "--expression", "--file") or t.startswith(("--expression=", "--file=")) for t in args)
        return files if script_given else files[1:]  # otherwise the first word is the script
    if name == "perl" and any(t.startswith("-i") or (_is_cluster(t) and "i" in t) for t in args):
        return pos
    if name == "dd":
        return [t[3:] for t in args if t.startswith("of=")]
    if name == "sort":
        return _option_value(args, ("-o", "--output")) + [t[2:] for t in args if t.startswith("-o") and len(t) > 2]
    if name == "uniq" and len(pos) > 1:
        return pos[1:2]
    if name in AWKS:
        return [m.group(1) for p in _awk_programs(a) for m in re.finditer(r"\bprintf?\b[^;{}]*?>>?\s*\"([^\"]*)\"", p)]
    if name == "find":
        return _option_value(args, ("-fprint", "-fprint0", "-fprintf", "-fls"))
    return []


# Commands find may run through -exec / -execdir / -ok that only read: any other command counts as a writer
# (a list of writers misses the many programs that can write, such as gzip, patch, tar or an interpreter)
FIND_READERS = {"grep", "egrep", "fgrep", "rg", "cat", "head", "tail", "wc", "ls", "stat", "file", "echo", "printf", "test",
                "[", "basename", "dirname", "realpath", "readlink", "sha256sum", "sha1sum", "md5sum", "shasum", "md5",
                "cksum", "diff", "cmp", "du", "jq", "true", "false", "sed"}
FIND_WALK_LIMIT = 20000


def _find_start_points(words):
    """find's start points (BSD and GNU): after the leading -H/-L/-P/-E/-X/-d/-s/-x and -f <path>, up to the expression."""
    pts = []
    i = 1
    n = len(words)
    while i < n and words[i].text in ("-H", "-L", "-P", "-E", "-X", "-d", "-s", "-x", "-f"):
        if words[i].text == "-f" and i + 1 < n:
            pts.append(words[i + 1])
            i += 1
        i += 1
    while i < n and not words[i].text.startswith(("-", "(", "!", ")")) and words[i].text != ",":
        pts.append(words[i])
        i += 1
    return pts


def _find_writes(words):
    a = _texts(words)
    if "-delete" in a:
        return True
    for inner in _find_execs(words):
        name = _base(inner[0].text)
        args = [w.text for w in inner[1:]]
        if name not in FIND_READERS or (name == "sed" and any(t.startswith(("-i", "--in-place")) or (_is_cluster(t) and "i" in t) for t in args)):
            return True
    return False


def _contains_protected(w, ctx):
    """True if the path is, or is a directory that contains, a protected path (looked up on disk, bounded)."""
    if _tmp_target(w) and not (TMP_VAR.match(w.text) and ctx.tmpdir_tainted):
        return False  # "$TMPDIR/<name>" or /tmp/claude-<uid>/..., as for rm
    if w.dynamic or w.glob or _protected_target(w.text, ctx):
        return True
    if _in_rm_allowed(w.text):
        return False  # build artefacts, like rm -rf dist
    bases = ctx.bases()
    if bases is None:
        return True
    for base in bases:
        root = os.path.realpath(os.path.join(base, os.path.expanduser(w.text)))
        if PROJECT_DIR == root or PROJECT_DIR.startswith(root + os.sep):
            return True  # the repository itself or a directory above it
        if not os.path.isdir(root):
            continue
        seen = 0
        for dirpath, dirnames, filenames in os.walk(root):
            for entry in dirnames + filenames:
                if _is_protected_path(os.path.join(dirpath, entry)):
                    return True
            seen += len(dirnames) + len(filenames)
            if seen > FIND_WALK_LIMIT:
                return True  # too large to check: assume it may
    return False


def _tmp_target(w):
    t = w.text
    m = TMP_VAR.match(t)
    if m:
        rest = m.group(2)
    elif t.startswith("/") and not w.dynamic and CLAUDE_TMP.match(t):
        rest = t
    else:
        return False
    if re.search(r"[$`]", rest):
        return False
    parts = [p for p in rest.split("/") if p not in ("", ".")]
    if not parts or ".." in parts:
        return False
    return not re.match(r"^[*?\[\]]+$", parts[-1] if t.startswith("/") else parts[0])


def _rm(words, ctx):
    args = words[1:]
    flags = [w.text for w in args if w.text.startswith("-") and not w.dynamic]
    targets = [w for w in args if not (w.text.startswith("-") and not w.dynamic)]
    recursive = any("r" in f.lower() for f in flags)
    for w in targets:
        t = w.text
        if _tmp_target(w) and not (TMP_VAR.match(t) and ctx.tmpdir_tainted):
            continue
        if t.startswith(("/", "~", "$")) or w.dynamic or ".." in t or t in ("*", ".", "./"):
            return MSG_RM_OUTSIDE.format(t)
        if recursive and not _in_rm_allowed(t):
            return MSG_RM_RECURSIVE.format(t)
    return None


def _in_rm_allowed(t):
    """t is one of the build-artefact directories or inside one ("distsrc" is not "dist")."""
    s = t.rstrip("/")
    if ".." in s.split("/"):
        return False  # dist/.. is the repository
    return any(s == p or s.startswith(p + "/") for p in RM_ALLOWED_PREFIXES)


def _repo_dir(ctx, dir_words):
    bases = ctx.bases()
    if bases is None:
        return MSG_GIT_DIR
    for base in bases:
        d = base
        for w in dir_words:
            if w.dynamic or w.glob:
                return MSG_GIT_DIR
            d = os.path.normpath(os.path.join(d, os.path.expanduser(w.text)))
        real = os.path.realpath(d)
        if not (real == PROJECT_DIR or real.startswith(PROJECT_DIR + os.sep)):
            return MSG_GIT_DIR
        p = real
        while p != PROJECT_DIR:
            if os.path.lexists(os.path.join(p, ".git")):
                return MSG_GIT_DIR
            p = os.path.dirname(p)
    return None


GIT_PROBE_TIMEOUT = 2  # seconds; a probe that takes longer counts as "cannot tell"
EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"


def _git_probe(args, cwd):
    """Run a read-only git command for the hook itself: (returncode, stdout), or (None, "") when it cannot run.

    The hook runs outside the sandbox, so git here must not start other programs: no fsmonitor, no hooks, no system
    config, no external diff or textconv drivers, no pager, no lazy fetch, and none of the caller's GIT_* variables."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update({"GIT_CONFIG_NOSYSTEM": "1", "GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0", "GIT_NO_LAZY_FETCH": "1", "LC_ALL": "C"})
    cmd = ["git", "--no-pager", "-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null"] + args
    try:
        r = subprocess.run(cmd, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, timeout=GIT_PROBE_TIMEOUT)
    except (OSError, subprocess.SubprocessError):
        return None, ""
    return r.returncode, r.stdout.decode("utf-8", "replace")


def _is_commit(ref, cwd):
    """True / False when git can tell whether ref names a tree-ish, None when it cannot run."""
    rc, _ = _git_probe(["rev-parse", "--verify", "--quiet", "--end-of-options", ref + "^{tree}"], cwd)
    if rc == 0:
        return True
    return False if rc == 1 else None


def _changed_protected(cwd, target=None, cached=False, rng=None):
    """Protected files that differ between the working tree (or the index, cached=True) and target, or across the
    range rng. target None compares the working tree with the index. None when git cannot tell."""
    args = ["diff", "--name-only", "-z", "--no-ext-diff", "--no-textconv", "--no-relative"]
    if cached:
        args.append("--cached")
    if rng is not None or target is not None:
        args += ["--end-of-options", rng if rng is not None else target]
    args.append("--")
    rc, out = _git_probe(args, cwd)
    if rc != 0:
        return None
    return [f for f in out.split("\0") if f and _is_protected_path(f)]


def _is_exclude_spec(spec):
    if spec.startswith((":!", ":^")):
        return True
    m = re.match(r"^:\(([^)]*)\)", spec)
    return bool(m) and "exclude" in [w.strip() for w in m.group(1).split(",")]


def _pathspecs_cover(specs, f, prefix, top=None):
    """Whether a set of git pathspecs covers file f. Exclude pathspecs (':!x', ':^x', ':(exclude)x') only take files
    away, and a set of excludes alone means "everything except" (git), so excludes are ignored here: the hook may
    ask when the excluded part is all that changes, but never misses a protected file."""
    positives = [s for s in specs if not _is_exclude_spec(s)]
    return not positives or any(_pathspec_covers(s, f, prefix, top) for s in positives)


def _pathspec_covers(spec, f, prefix, top=None):
    """Whether a git pathspec given in the subdirectory prefix covers the repository-relative file f. An absolute
    path is taken relative to the top of the working tree top (git accepts absolute paths inside it)."""
    s = spec
    base = prefix
    if s.startswith(":"):
        if s.startswith(":/"):
            s, base = s[2:], ""
        else:
            return True  # other pathspec magic: assume it may cover
    elif os.path.isabs(s):
        if top is None:
            return True  # cannot tell: assume it may cover
        rel = os.path.relpath(os.path.realpath(s), os.path.realpath(top))
        if rel == ".." or rel.startswith(".." + os.sep):
            return False  # outside the working tree (git refuses it)
        s, base = rel, ""
    q = os.path.normpath(os.path.join(base, s)).lower() if (base or s) else "."
    fl = f.lower()
    if q in (".", ""):
        return True
    if q.startswith(".."):
        return False
    if re.search(r"[*?\[]", s):
        return fnmatch.fnmatch(fl, q) or fnmatch.fnmatch(fl, q + "/*")
    return fl == q or fl.startswith(q + "/")


def _worktree_changes(sub, rest, cwd):
    """How a git command replaces files in the working tree or the index, as a list of (kind, target, paths):
    kind "tree" (the working tree becomes target), "index" (the index becomes target), "from-index" (the working
    tree becomes the index), or "unknown" (git cannot tell whether an argument is a commit or a path)."""
    if sub == "checkout":
        before, after, newbranch = _checkout_args(rest)
        if after is not None:
            return [("tree", before[0], after)] if before else [("from-index", None, after)]
        if not before:
            return []  # "checkout -b new": a branch at HEAD, nothing changes
        if newbranch:
            return [("tree", before[0], None)]  # start point
        is_commit = _is_commit(before[0], cwd)
        if is_commit is None:
            return [("unknown", before[0], None)]
        if is_commit:
            return [("tree", before[0], before[1:] or None)]
        return [("from-index", None, before)]
    if sub == "switch":
        pos, orphan = [], False
        i = 0
        while i < len(rest):
            t = rest[i]
            if t in ("-c", "-C", "--create", "--force-create", "--orphan"):
                orphan = orphan or t == "--orphan"
                i += 2
                continue
            if t.startswith("--orphan"):
                orphan = True
            if t.startswith("-") and t != "-":
                i += 1
                continue
            pos.append("@{-1}" if t == "-" else t)
            i += 1
        if orphan:
            return [("tree", EMPTY_TREE, None)]  # switch --orphan empties the working tree
        return [("tree", pos[0], None)] if pos else []
    if sub == "reset":
        mode = "mixed"
        before, after = [], None
        for k, t in enumerate(rest):
            if t == "--":
                after = rest[k + 1:]
                break
            hit = _opt_any(t, ("--soft", "--mixed", "--hard", "--keep", "--merge"))
            if hit:
                mode = hit[2:]
            elif not t.startswith("-"):
                before.append(t)
        if mode == "soft":
            return []  # moves HEAD only; a later checkout or reset --hard is checked then
        commit, paths = "HEAD", after
        if before:
            if after is not None:
                commit = before[0]
            else:
                is_commit = _is_commit(before[0], cwd)
                if is_commit is None:
                    return [("unknown", before[0], None)]
                commit, paths = (before[0], before[1:] or None) if is_commit else ("HEAD", before)
        return [("tree" if mode in ("hard", "keep", "merge") else "index", commit, paths)]
    if sub == "restore":
        source, worktree, staged, paths = None, False, False, []
        i = 0
        while i < len(rest):
            t = rest[i]
            # --source also abbreviated (--sou, --sour=...): git accepts unique prefixes of long options
            if (t == "-s" or (_opt_is(t, "--source") and "=" not in t)) and i + 1 < len(rest):
                source = rest[i + 1]
                i += 2
                continue
            if _opt_is(t, "--source") and "=" in t:
                source = t.split("=", 1)[1]
            elif t.startswith("-s") and len(t) > 2 and not t.startswith("--"):
                source = t[2:]
            elif _opt_is(t, "--worktree") or (_is_cluster(t) and "W" in t):
                worktree = True
            elif _opt_is(t, "--staged") or (_is_cluster(t) and "S" in t):
                staged = True
            elif t != "--" and not t.startswith("-"):
                paths.append(t)
            i += 1
        out = []
        if staged:
            out.append(("index", source or "HEAD", paths or None))
        if worktree or not staged:
            out.append(("tree", source, paths or None) if source else ("from-index", None, paths or None))
        return out
    return []


def _worktree_ask(sub, rest, ctx, dir_words):
    """A reason to ask when this git command would replace protected files (hooks, settings, workflows, ...)
    in the working tree or the index with another version, or when that cannot be checked; else None.
    Checked from every directory the command may run in (the session cwd and each literal cd before it), since
    relative pathspecs such as '..' depend on it."""
    if sub not in ("checkout", "switch", "reset", "restore", "merge", "rebase", "cherry-pick") and not (
            sub == "stash" and rest[:1] and rest[0] in ("pop", "apply", "branch")):
        return None
    bases = ctx.bases() or [ctx.cwd]
    for base in bases:
        d = base
        for w in dir_words:
            d = os.path.normpath(os.path.join(d, os.path.expanduser(w.text)))
        if not os.path.isdir(d):
            return "git {}: could not check whether it changes protected files".format(sub)
        reason = _worktree_ask_in(sub, rest, d)
        if reason:
            return reason
    return None


def _worktree_ask_in(sub, rest, cwd):
    if sub in ("rebase", "merge", "cherry-pick") and any(
            t in ("--continue", "--abort", "--skip", "--quit", "--edit-todo", "--show-current-patch") for t in rest):
        return None  # continuing or abandoning an operation already in progress (still asked as history-affecting)
    if sub in ("checkout", "switch", "reset", "restore"):
        changes = _worktree_changes(sub, rest, cwd)
    elif sub in ("merge", "rebase"):
        # the other side's changes since the merge base; every word that is not an option is tried as a ref
        # (a word that is not one, such as a -m message, makes the check fail, which asks)
        refs = [t for t in rest if not t.startswith("-") and t != "--"]
        changes = [("range", "HEAD..." + r, None) for r in (refs or ["@{upstream}"])]
        if sub == "rebase":
            # --onto X rebuilds the branch on X: compare with X directly, which also catches the commits it drops
            for k, t in enumerate(rest):
                if _opt_is(t, "--onto"):
                    onto = t.split("=", 1)[1] if "=" in t else (rest[k + 1] if k + 1 < len(rest) else "")
                    changes.append(("range", "HEAD.." + onto, None))
    elif sub == "cherry-pick":
        # each commit's own change (c^!), or a range as written
        changes = [("range", c if ".." in c else c + "^!", None) for c in rest if not c.startswith("-") and c != "--"]
    elif sub == "stash" and rest[:1] and rest[0] in ("pop", "apply", "branch"):
        args = [t for t in rest[1:] if not t.startswith("-")]
        if rest[0] == "branch":
            stash = args[1] if len(args) > 1 else "stash@{0}"
        else:
            stash = args[0] if args else "stash@{0}"
        rc, out = _git_probe(["stash", "show", "--name-only", "-z", "--no-ext-diff", "--no-textconv",
                              "--include-untracked", "--end-of-options", stash], cwd)
        if rc != 0:
            return "git stash {}: could not check whether it changes protected files".format(rest[0])
        files = [f for f in out.split("\0") if f and _is_protected_path(f)]
        return "git stash {} would change protected files ({})".format(rest[0], ", ".join(files[:3])) if files else None
    else:
        return None
    prefix = top = None
    for kind, target, paths in changes:
        if kind == "unknown":
            return "git {}: could not check whether '{}' is a commit or a path".format(sub, target)
        if kind == "range":
            changed = _changed_protected(cwd, rng=target)
        elif kind == "from-index":
            changed = _changed_protected(cwd)
        else:
            changed = _changed_protected(cwd, target=target, cached=(kind == "index"))
        if changed is None:
            return "git {}: could not check whether it changes protected files".format(sub)
        if paths:
            if prefix is None:
                rc, out = _git_probe(["rev-parse", "--show-prefix"], cwd)
                if rc != 0:
                    return "git {}: could not check whether it changes protected files".format(sub)
                prefix = out.strip().rstrip("/")
            if top is None and any(os.path.isabs(p) for p in paths):
                rc, out = _git_probe(["rev-parse", "--show-toplevel"], cwd)
                if rc != 0:
                    return "git {}: could not check whether it changes protected files".format(sub)
                top = out.strip()
            changed = [f for f in changed if _pathspecs_cover(paths, f, prefix, top)]
        if changed:
            more = " and {} more".format(len(changed) - 3) if len(changed) > 3 else ""
            return "git {} would change protected files ({}{}); the hooks are read from the working tree".format(
                sub, ", ".join(changed[:3]), more)
    return None


def _grep_opens_pager(rest):
    """git grep -O / --open-files-in-pager (runs a program), skipping the values of -e/-f and the context options."""
    skip = False
    for t in rest:
        if skip:
            skip = False
            continue
        if t == "--":
            break
        if t in ("-e", "-f", "-A", "-B", "-C", "-m", "--max-depth", "--max-count", "--context", "--after-context",
                 "--before-context", "--threads"):
            skip = True
            continue
        if t.startswith("-O") or _opt_is(t, "--open-files-in-pager") or (_is_cluster(t) and "O" in t):
            return True
    return False


def _checkout_args(rest):
    """git checkout's arguments: (words before "--", the words after it or None, whether -b/-B/--orphan creates a
    branch). New branch names are left out, and "-" (the previous branch) becomes @{-1}."""
    before, after, newbranch = [], None, False
    i = 0
    while i < len(rest):
        t = rest[i]
        if t == "--":
            after = rest[i + 1:]
            break
        if t in ("-b", "-B", "--orphan") or (_is_cluster(t) and t[-1] in "bB"):
            newbranch = True
            i += 2
            continue
        if t.startswith("--orphan="):
            newbranch = True
        if t.startswith("-") and t != "-":
            i += 1
            continue
        before.append("@{-1}" if t == "-" else t)
        i += 1
    return before, after, newbranch


def _checkout_paths(rest, cwd):
    """The paths "git checkout" writes: after "--"; otherwise the words after a first word that is a commit, or
    every word when the first is not a commit or git cannot tell. New branch names (-b/-B/--orphan) are not paths."""
    before, after, _ = _checkout_args(rest)
    if after is not None:
        return after
    if not before:
        return []
    return before[1:] if _is_commit(before[0], cwd) else before


def _fetch_src_ok(ref):
    """The source of a fetch refspec only names branches or tags (not pull requests, arbitrary refs or commit ids)."""
    r = ref[1:] if ref.startswith("+") else ref
    src = r.partition(":")[0]
    return src == "HEAD" or src.startswith(("refs/heads/", "refs/tags/")) or (
        src != "" and not src.startswith("refs/") and "pull/" not in src and "*" not in src
        and not re.fullmatch(r"[0-9a-fA-F]{7,64}", src))


def _fetch_dst_ok(ref):
    """Where a fetch refspec writes: nothing (FETCH_HEAD), remote-tracking refs (also forced), or, without '+', a local
    branch or tag of the same name as the source. Anything else can put another commit under a name a human
    trusts, such as main or a release tag."""
    force = ref.startswith("+")
    src, colon, dst = (ref[1:] if force else ref).partition(":")
    if not colon or dst == "" or dst.startswith("refs/remotes/"):
        return True
    if force:
        return False
    if dst.startswith("refs/tags/") or src.startswith("refs/tags/"):
        return src == dst

    def branch(x):
        return x[len("refs/heads/"):] if x.startswith("refs/heads/") else x
    if (dst.startswith("refs/") and not dst.startswith("refs/heads/")) or (
            src.startswith("refs/") and not src.startswith("refs/heads/")):
        return False
    return branch(src) == branch(dst)


def _opt_is(t, name, min_len=4):
    """t is the long option name, or an abbreviation of it (git accepts unique prefixes of long options)."""
    key = t.split("=", 1)[0]
    if key == name:
        return True
    return key.startswith("--") and len(key) >= min_len and name.startswith(key)


def _opt_any(t, names):
    for nm in names:
        if _opt_is(t, nm):
            return nm
    return None


def _git_tag(rest):
    write_long = {"--delete", "--annotate", "--sign", "--local-user", "--force", "--message", "--file", "--edit",
                  "--cleanup", "--create-reflog", "--trailer"}
    list_implied = {"--contains", "--no-contains", "--merged", "--no-merged", "--points-at"}
    with_value = list_implied | {"--sort", "--format", "--color", "--column"}
    listing = verify = False
    pos = []
    i = 0
    while i < len(rest):
        t = rest[i]
        if t == "--":
            pos += rest[i + 1:]
            break
        if t.startswith("--"):
            key = t.split("=", 1)[0]
            if _opt_any(t, write_long):
                return MSG_TAG
            if key == "--list" or key in list_implied:
                listing = True
            if key == "--verify":
                verify = True
            if key in with_value and "=" not in t:
                i += 1
            i += 1
            continue
        if _is_cluster(t):
            for ch in t[1:]:
                if ch in "dasufmFe":
                    return MSG_TAG
                if ch == "l":
                    listing = True
                if ch == "v":
                    verify = True
                if ch == "n":
                    listing = True
                    break
            i += 1
            continue
        if re.match(r"^-n\d+$", t):
            listing = True
            i += 1
            continue
        pos.append(t)
        i += 1
    if pos and not listing and not verify:
        return MSG_TAG
    return None


def _git_push(rest, cwd):
    blocked = {"--force": MSG_FORCE, "--force-with-lease": MSG_FORCE, "--force-if-includes": MSG_FORCE,
               "--delete": MSG_FORCE, "--mirror": MSG_FORCE, "--prune": MSG_FORCE, "--tags": MSG_TAG_PUSH,
               "--follow-tags": MSG_TAG_PUSH, "--all": MSG_MAIN, "--branches": MSG_MAIN, "--no-verify": MSG_NO_VERIFY,
               "--receive-pack": MSG_GIT_EXEC, "--exec": MSG_GIT_EXEC, "--recurse-submodules": MSG_GIT_NET}
    pos = []
    i = 0
    n = len(rest)
    while i < n:
        t = rest[i]
        if t == "--":
            pos += rest[i + 1:]
            break
        if t.startswith("--"):
            key = t.split("=", 1)[0]
            hit = _opt_any(t, blocked)
            if hit and not (hit == "--recurse-submodules" and t.endswith("=no")):
                return blocked[hit]
            if key == "--repo":
                val = t.split("=", 1)[1] if "=" in t else (rest[i + 1] if i + 1 < n else "")
                if not REMOTE_NAME.match(val):
                    return MSG_GIT_NET
                if "=" not in t:
                    i += 1
            elif key == "--push-option" and "=" not in t:
                i += 1
            i += 1
            continue
        if t.startswith("-") and t != "-":
            if "f" in t[1:] or "d" in t[1:]:
                return MSG_FORCE
            if t.endswith("o"):
                i += 1
            i += 1
            continue
        pos.append(t)
        i += 1
    if pos and not REMOTE_NAME.match(pos[0]):
        return MSG_GIT_NET
    if len(pos) < 2:
        return _push_current(cwd)  # no refspec: the checked-out branch goes to its push destination
    for ref in pos[1:]:
        if ref.startswith(("+", ":")):
            return MSG_FORCE
        if "*" in ref:
            return MSG_PUSH_WILDCARD
        src = ref.split(":", 1)[0]
        dst = ref.split(":", 1)[1] if ":" in ref else ref
        if "refs/tags" in ref or TAG_LIKE.match(dst):
            return MSG_TAG_PUSH
        if ":" not in ref and src in ("HEAD", "@"):
            r = _push_current(cwd)
            if r:
                return r
            continue
        if dst.startswith("refs/heads/"):
            dst = dst[len("refs/heads/"):]
        if dst in ("main", "master"):
            return MSG_MAIN
        r = _push_src_tag(src, cwd)
        if r:
            return r
    return None


def _push_current(cwd):
    """A reason to refuse a push of the checked-out branch without a named destination: on main/master, a detached
    HEAD, a push destination (@{push}) of main/master, or when git cannot tell."""
    rc, out = _git_probe(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd)
    if rc != 0:
        return MSG_PUSH_IMPLICIT
    if out.strip() in ("main", "master"):
        return MSG_MAIN
    rc, out = _git_probe(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{push}"], cwd)
    if rc == 0 and out.strip().split("/", 1)[-1] in ("main", "master"):
        return MSG_MAIN
    return None


def _push_src_tag(src, cwd):
    """Refuse a push whose source names a local tag (git push origin foo, where foo is a tag), also when git cannot
    tell."""
    if not src or src.startswith("refs/") or not re.match(r"^[A-Za-z0-9._/-]+$", src):
        return None  # full ref names, and revisions such as HEAD~1 (not tag names) are not tags here
    rc, _ = _git_probe(["show-ref", "--verify", "--quiet", "refs/tags/" + src], cwd)
    if rc == 1:
        return None
    return MSG_TAG_PUSH if rc == 0 else MSG_PUSH_UNCHECKED.format(src)


def _git_fetch(sub, rest, cwd):
    with_value = {"--depth", "--deepen", "--shallow-since", "--shallow-exclude", "--jobs", "--server-option",
                  "--negotiation-tip", "--refmap", "--filter", "--strategy", "--strategy-option"}
    pos = []
    multiple = every = tags = False
    refmaps = []
    i = 0
    n = len(rest)
    while i < n:
        t = rest[i]
        if t == "--":
            pos += rest[i + 1:]
            break
        if t.startswith("--"):
            key = t.split("=", 1)[0]
            if _opt_any(t, ("--upload-pack", "--receive-pack", "--exec")):
                return MSG_GIT_EXEC
            if _opt_any(t, ("--recurse-submodules", "--recurse-submodules-default")) and not t.endswith("=no"):
                return MSG_GIT_NET
            if sub == "fetch" and _opt_is(t, "--update-head-ok"):
                return MSG_FETCH_HEAD_OK
            if key == "--multiple":
                multiple = True
            if key == "--all":
                every = True
            if sub != "ls-remote" and _opt_is(t, "--tags"):
                tags = True
            if _opt_is(t, "--refmap"):
                refmaps.append(t.split("=", 1)[1] if "=" in t else (rest[i + 1] if i + 1 < n else ""))
            if key in with_value and "=" not in t:
                i += 1
            i += 1
            continue
        if t.startswith("-") and t != "-":
            if sub == "ls-remote" and "u" in t[1:]:
                return MSG_GIT_EXEC
            if sub == "fetch" and _is_cluster(t) and "u" in t:
                return MSG_FETCH_HEAD_OK
            if sub != "ls-remote" and _is_cluster(t) and "t" in t:
                tags = True
            if t in ("-j", "-o", "-s", "-X"):
                i += 1
            i += 1
            continue
        pos.append(t)
        i += 1
    repos = pos if multiple else pos[:1]
    for repo in repos:
        if not REMOTE_NAME.match(repo):
            return MSG_GIT_NET
    remotes = None
    if repos or tags:
        rc, out = _git_probe(["remote"], cwd)
        if rc != 0:
            return MSG_FETCH_REMOTE.format(repos[0] if repos else "?")
        remotes = out.split()
        for repo in repos:
            if repo not in remotes:
                return MSG_FETCH_REMOTE.format(repo)
    # tags only from origin: with --tags, a named remote other than origin (or all remotes, when there are others)
    if tags and ((repos and any(r != "origin" for r in repos)) or ((every or multiple) and any(r != "origin" for r in remotes))):
        return MSG_FETCH_TAGS
    if sub not in ("fetch", "pull") or multiple:
        return None
    specs = pos[1:] + [m for m in refmaps if m]
    # only branches and tags: pull-request heads (refs/pull/...), other refs and commit ids can bring in a
    # version of these hooks the maintainer has not merged
    if not all(_fetch_src_ok(ref) for ref in specs):
        return MSG_PR_CHECKOUT
    if not all(_fetch_dst_ok(ref) for ref in specs):
        return MSG_FETCH_DST
    if repos and repos[0] != "origin" and any("refs/tags/" in ref.partition(":")[2] for ref in specs):
        return MSG_FETCH_TAGS
    return None


def _git_config(rest):
    keys = [t.split("=", 1)[0] for t in rest]
    if any(k in GIT_CONFIG_WRITE for k in keys):
        return MSG_GIT_CONFIG
    pos = _positionals(rest)
    if pos and pos[0] in ("get", "list"):
        return None
    if any(k in GIT_CONFIG_READ or k.startswith("--get") for k in keys):
        return None
    return MSG_GIT_CONFIG


def _git(words, ctx):
    a = _texts(words)
    n = len(a)
    i = 1
    dirs = []
    while i < n:
        t = a[i]
        if t == "-C":
            if i + 1 < n:
                dirs.append(words[i + 1])
            i += 2
            continue
        if t.startswith("-c") and not t.startswith("--"):
            val = t[2:] if t != "-c" else (a[i + 1] if i + 1 < n else "")
            key = val.split("=", 1)[0].lower()
            if not (key in GIT_C_ALLOWED or key.startswith(GIT_C_ALLOWED_PREFIXES)):
                return MSG_GIT_C.format(key or "(missing)")
            i += 2 if t == "-c" else 1
            continue
        if t.startswith(("--config-env", "--exec-path=", "--git-dir", "--work-tree")):
            return MSG_GIT_LOCATION
        if t in ("--namespace", "--attr-source", "--list-cmds"):
            i += 2
            continue
        if t.startswith("-"):
            i += 1
            continue
        break
    r = _repo_dir(ctx, dirs)
    if r:
        return r
    if i >= n:
        return None
    sub = a[i]
    rest = a[i + 1:]
    pos = _positionals(rest)
    first = pos[0] if pos else None

    if sub in ("push", "fetch", "ls-remote"):
        ctx.outside = True
    # the directories the command may run in (session cwd and literal cd targets, then -C)
    run_dirs = []
    for base in ctx.bases() or [ctx.cwd]:
        d = base
        for w in dirs:
            d = os.path.normpath(os.path.join(d, os.path.expanduser(w.text)))
        run_dirs.append(d)
    if sub == "tag":
        return _git_tag(rest)
    if sub == "push":
        for d in run_dirs:
            r = _git_push(rest, d)
            if r:
                return r
        ctx.asks.append("git push to a feature branch")
        return None
    if sub in ("fetch", "pull", "ls-remote"):
        for d in run_dirs:
            r = _git_fetch(sub, rest, d)
            if r:
                return r
        if sub == "fetch" and any(_opt_is(t, "--prune-tags") or (_is_cluster(t) and "P" in t) for t in rest):
            ctx.asks.append("git fetch --prune-tags (deletes local tags)")
    if sub == "clone":
        return MSG_GIT_NET
    # options that run a command, change the repository layout or skip hooks, in any subcommand
    # (also abbreviated: git accepts unique prefixes of long options)
    for t in rest:
        if t == "--":
            break
        hit = _opt_any(t, ("--upload-pack", "--receive-pack", "--exec", "--extcmd", "--open-files-in-pager", "--no-verify"))
        if hit == "--no-verify":
            return MSG_NO_VERIFY
        if hit:
            return MSG_GIT_EXEC
    if sub == "commit":
        # -n is --no-verify; skip the values of -m/-F/-c/-C/-t (a message line such as "- new tool" is not -n)
        skip = False
        for t in rest:
            if skip:
                skip = False
                continue
            if t == "--":
                break
            if t in ("--message", "--file", "--template", "--reuse-message", "--reedit-message", "--author", "--date",
                     "--fixup", "--squash", "--trailer", "--cleanup", "--pathspec-from-file"):
                skip = True
                continue
            if t.startswith("-") and not t.startswith("--"):
                for k, ch in enumerate(t[1:], start=1):
                    if ch == "n":
                        return MSG_NO_VERIFY
                    if ch in "mFcCt":
                        skip = k == len(t) - 1  # the value is the next word
                        break
                    if ch in "uS":
                        break  # optional value, attached only
    if sub == "config":
        return _git_config(rest)
    if sub == "remote" and first in ("add", "set-url", "remove", "rm", "rename", "set-branches", "set-head"):
        return MSG_REMOTE_CHANGE
    if sub in ("filter-branch", "filter-repo"):
        return MSG_HISTORY
    if sub == "reflog" and first in ("expire", "delete"):
        return MSG_HISTORY
    if sub == "gc" and any(t.startswith("--prune") for t in rest):
        return MSG_HISTORY
    if sub == "submodule" and first not in (None, "status", "summary"):
        return MSG_SUBMODULE
    if sub == "bisect" and first == "run":
        return MSG_GIT_EXEC
    if sub == "rebase" and any(t.startswith(("-x", "--exec")) or (_is_cluster(t) and "x" in t) for t in rest):
        return MSG_GIT_EXEC
    if sub == "difftool" and any(t.startswith(("-x", "--extcmd")) or (_is_cluster(t) and "x" in t) for t in rest):
        return MSG_GIT_EXEC
    if sub == "grep" and _grep_opens_pager(rest):
        return MSG_GIT_EXEC
    if sub == "archive" and any(t.startswith("--remote") for t in rest):
        return MSG_GIT_NET
    if sub in ("apply", "am"):
        if not any(t in ("--check", "--stat", "--numstat", "--summary") for t in rest) or any(_opt_is(t, "--apply") for t in rest):
            return MSG_APPLY
    if sub in GIT_PLUMBING:
        if not (sub == "update-index" and rest and all(t in ("--refresh", "--really-refresh", "-q") for t in rest)):
            return MSG_PLUMBING
    if sub in GIT_OTHER or sub.startswith(("credential", "remote-", "http-")):
        return MSG_GIT_OTHER
    if sub not in GIT_ALLOWED:
        return MSG_GIT_NOT_ALLOWED.format(sub)
    if sub == "worktree" and first not in (None, "list"):
        return MSG_GIT_NOT_ALLOWED.format("worktree " + first)
    if sub == "help" and any(_opt_any(t, ("--web", "--info")) or (_is_cluster(t) and ("w" in t or "i" in t)) for t in rest):
        return MSG_GIT_NOT_ALLOWED.format("help --web/--info")
    if sub in ("checkout", "switch") and any(re.search(r"(^|/)pull/\d", t) for t in rest if not t.startswith("-")):
        return MSG_PR_CHECKOUT
    if any(t.startswith("--pathspec-from-file") for t in rest) and sub in ("checkout", "restore", "reset", "rm", "mv"):
        return MSG_PROTECTED  # the paths it writes are in a file the hook cannot read

    # files git writes (it runs outside the sandbox, so the hook checks them)
    targets = [t.split("=", 1)[1] for t in rest if "=" in t and _opt_any(t, ("--output", "--output-directory"))]
    targets += [rest[k + 1] for k, t in enumerate(rest[:-1]) if "=" not in t and _opt_any(t, ("--output", "--output-directory"))]
    if sub in ("format-patch", "archive"):
        targets += _option_value(rest, ("-o",))
    if sub == "checkout":
        # "checkout <tree-ish> <path>" and "checkout -- <path>" overwrite those paths
        d = ctx.cwd
        for w in dirs:
            d = os.path.normpath(os.path.join(d, os.path.expanduser(w.text)))
        targets += _checkout_paths(rest, d)
    if sub in ("restore", "rm", "mv", "init"):
        targets += pos
    if sub in ("worktree", "bundle") and first in ("add", "create") and len(pos) > 1:
        targets.append(pos[1])
    for t in targets:
        if _protected_target(t, ctx) or _computed(t, ctx):
            return MSG_PROTECTED

    # Switching the working tree (or the index) to another version can bring back older hooks and settings:
    # ask when protected files would change, or when that cannot be checked. pull is always asked, because what
    # it brings in is only known after the fetch (fetch alone is not asked).
    if sub == "pull":
        ctx.asks.insert(0, "git pull (fetch and merge) may change protected files such as .claude/hooks, which the hook cannot check before the fetch")
    else:
        reason = _worktree_ask(sub, rest, ctx, dirs)
        if reason:
            ctx.asks.insert(0, reason)
    if sub in ("rebase", "merge", "cherry-pick"):
        ctx.asks.append("history-affecting git operation")
    discard = (
        (sub == "reset" and any(_opt_is(t, "--hard") for t in rest))
        or (sub == "clean" and any(_opt_is(t, "--force") or (_is_cluster(t) and "f" in t) for t in rest))
        or (sub == "checkout" and "--" in rest and "." in rest[rest.index("--") + 1:])
        or (sub == "restore" and "." in pos)
        or (sub == "stash" and first in ("drop", "clear"))
        or (sub == "branch" and (
            "-D" in rest
            or any(_is_cluster(t) and "d" in t.lower() and "f" in t for t in rest)
            or (any(_opt_is(t, "--delete") or t == "-d" for t in rest) and any(_opt_is(t, "--force") or t == "-f" for t in rest))))
    )
    if discard:
        ctx.asks.append("operation that discards work")
    return None


def _gh_command(rest):
    """Return (command, subcommand, error). Only -R/--repo/--hostname may come before the command words."""
    found = []
    i = 0
    while i < len(rest):
        if found and (GH_ALLOWED.get(found[0], ()) is None or len(found) == 2):
            break
        t = rest[i]
        if t == "--":
            break
        if t.startswith("-") and t != "-":
            key = t.split("=", 1)[0]
            if key in GH_VALUE_FLAGS:
                i += 1 if "=" in t else 2
                continue
            if key in GH_BOOL_FLAGS:
                i += 1
                continue
            if found and found[0] not in GH_ALLOWED:
                break  # refused below anyway
            return None, None, MSG_GH_FLAG_FIRST
        found.append(t)
        i += 1
    return (found[0] if found else None), (found[1] if len(found) > 1 else None), None


# gh api's short flags that take a value (pflag: "-Xv", "-X v", "-X=v", and bundled like "-iXv")
GH_API_VALUE_SHORT = set("XfFHqtp")


def _gh_api_write(rest):
    """A reason when gh api would write: a method other than GET/HEAD, or fields/input (which switch it to POST)."""
    k = 0
    while k < len(rest):
        t = rest[k]
        if t == "--":
            break
        if t.startswith("--"):
            key, eq, val = t.partition("=")
            if key in ("--field", "--raw-field", "--input"):
                return MSG_GH_API_FIELDS
            if key == "--method":
                method = val if eq else (rest[k + 1] if k + 1 < len(rest) else "")
                if method.upper() not in ("GET", "HEAD"):
                    return MSG_GH
        elif t.startswith("-") and len(t) > 1:
            for j, ch in enumerate(t[1:], start=1):
                if ch in "fF":
                    return MSG_GH_API_FIELDS
                if ch in GH_API_VALUE_SHORT:
                    value = t[j + 1:] or (rest[k + 1] if k + 1 < len(rest) else "")
                    if ch == "X" and value.lstrip("=").upper() not in ("GET", "HEAD"):
                        return MSG_GH
                    break  # the rest of the word (or the next word) is this flag's value
        k += 1
    return None


GH_HOSTS = {"github.com", "api.github.com", "www.github.com"}
# gh commands that change something on GitHub: they may only target this repository's origin
GH_WRITE_VERBS = {("pr", "create"), ("pr", "edit"), ("pr", "close"), ("pr", "reopen"), ("pr", "comment"), ("pr", "ready"),
                  ("issue", "create"), ("issue", "comment"), ("run", "rerun"), ("run", "cancel")}
GH_CONFIG_KEYS = {"git_protocol", "editor", "prompt", "pager", "browser", "spinner", "color_labels", "accessible_colors",
                  "accessible_prompter"}
URL_START = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*://")
SECRET_NAME = re.compile(r"^(\.env(\..*)?|.*\.(pem|key)|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|\.netrc|\.npmrc)$", re.IGNORECASE)


def _origin_slug(cwd):
    """OWNER/REPO (lower case) of the origin remote on github.com, or None."""
    rc, out = _git_probe(["remote", "get-url", "origin"], cwd)
    if rc != 0:
        return None
    m = re.match(r"^(?:https://(?:[^@/]+@)?github\.com/|ssh://git@github\.com/|git@github\.com:)([^/\s]+)/([^/\s]+?)(?:\.git)?/?$",
                 out.strip(), re.IGNORECASE)
    return (m.group(1) + "/" + m.group(2)).lower() if m else None


def _gh_repo_values(rest):
    """Values of -R/--repo anywhere in the arguments (-R v, -Rv, --repo v, --repo=v)."""
    out = []
    for k, t in enumerate(rest):
        if t in ("-R", "--repo"):
            out.append(rest[k + 1] if k + 1 < len(rest) else "")
        elif t.startswith("--repo="):
            out.append(t.split("=", 1)[1])
        elif t.startswith("-R") and len(t) > 2:
            out.append(t[2:].lstrip("="))
    return out


def _gh_repo_host_slug(v):
    """(host, OWNER/REPO) of a -R value: OWNER/REPO, HOST/OWNER/REPO or a URL."""
    if URL_START.match(v):
        u = urllib.parse.urlsplit(v)
        parts = [p for p in u.path.split("/") if p]
        return (u.hostname or "").lower(), "/".join(parts[:2]).lower()
    parts = v.split("/")
    if len(parts) == 3:
        return parts[0].lower(), "/".join(parts[1:]).lower()
    return "github.com", v.lower()


def _gh_host_problem(rest):
    for k, t in enumerate(rest):
        if t == "--hostname" or t.startswith("--hostname="):
            host = t.split("=", 1)[1] if "=" in t else (rest[k + 1] if k + 1 < len(rest) else "")
            if host.lower() not in GH_HOSTS:
                return MSG_GH_HOST
        if URL_START.match(t):
            if (urllib.parse.urlsplit(t).hostname or "").lower() not in GH_HOSTS:
                return MSG_GH_HOST
    for v in _gh_repo_values(rest):
        if _gh_repo_host_slug(v)[0] not in GH_HOSTS:
            return MSG_GH_HOST
    return None


def _gh_target_problem(rest, ctx):
    """For a command that writes: every -R value and every github.com URL must name the origin repository."""
    slugs = [_gh_repo_host_slug(v)[1] for v in _gh_repo_values(rest)]
    for t in _positionals(rest):
        if URL_START.match(t):
            slugs.append(_gh_repo_host_slug(t)[1])
    if not slugs:
        return None  # gh resolves the repository from this checkout
    origin = None
    for base in ctx.bases() or [None]:
        if base is None:
            return MSG_GH_TARGET.format("unknown")
        origin = _origin_slug(base)
        if origin is None or any(s != origin for s in slugs):
            return MSG_GH_TARGET.format(origin or "unknown")
    return None


def _gh_file_ok(t, ctx):
    """Whether gh may read the file t (it runs outside the sandbox): stdin, a file in the repository that is not
    under .git/ and does not look like a secret, "$TMPDIR/<name>" or the Claude scratch area."""
    if t == "-":
        return True
    if TMP_VAR.match(t):
        return not _computed(t, ctx)
    if not t or re.search(r"[$`*?\[]", t):
        return False
    bases = ctx.bases()
    if bases is None and not os.path.isabs(os.path.expanduser(t)):
        return False
    for base in bases or [ctx.cwd]:
        ab = os.path.realpath(os.path.join(base, os.path.expanduser(t)))
        if ab.startswith(PROJECT_DIR + os.sep):
            parts = os.path.relpath(ab, PROJECT_DIR).split(os.sep)
            if any(p.lower() == ".git" for p in parts) or SECRET_NAME.match(parts[-1]):
                return False
        elif not CLAUDE_TMP.match(ab):
            return False
    return True


def _gh_body_files(rest):
    """Values of --body-file / -F (gh pr and gh issue)."""
    out = []
    for k, t in enumerate(rest):
        if t in ("-F", "--body-file"):
            out.append(rest[k + 1] if k + 1 < len(rest) else "")
        elif t.startswith("--body-file="):
            out.append(t.split("=", 1)[1])
        elif t.startswith("-F") and len(t) > 2:
            out.append(t[2:].lstrip("="))
    return out


def _gh(words, ctx):
    a = _texts(words)
    rest = a[1:]
    pos = _positionals(rest)
    ctx.outside = True
    r = _repo_dir(ctx, [])
    if r:
        return r
    sub, verb, err = _gh_command(rest)
    if err:
        return err
    r = _gh_host_problem(rest)
    if r:
        return r
    if sub is None:
        return None  # gh, gh --help, gh --version
    if sub in GH_BLOCKED:
        return MSG_GH
    if sub == "pr" and verb in ("checkout", "co"):
        return MSG_PR_CHECKOUT
    if sub not in GH_ALLOWED:
        return MSG_GH_NOT_ALLOWED.format(sub)
    allowed = GH_ALLOWED[sub]
    if allowed is not None and verb is not None and verb not in allowed:
        return MSG_GH if (sub, verb) in (("pr", "merge"), ("config", "set")) or sub == "release" else MSG_GH_NOT_ALLOWED.format(sub + " " + verb)
    if (sub, verb) in GH_WRITE_VERBS:
        r = _gh_target_problem(rest, ctx)
        if r:
            return r
    if sub in ("pr", "issue"):
        for t in _gh_body_files(rest):
            if not _gh_file_ok(t, ctx):
                return MSG_GH_FILE.format(t or "missing")
    if sub == "config" and verb == "get":
        keys = _positionals(_skip_value_opts(rest[rest.index("get") + 1:], ("-h", "--host")))
        if not keys or keys[0] not in GH_CONFIG_KEYS:
            return MSG_GH_CONFIG_KEY
    if sub == "pr" and verb in ("create", "edit", "close", "reopen", "comment", "ready"):
        ctx.asks.append("GitHub PR operation")
    if sub == "issue" and verb in ("create", "comment"):
        ctx.asks.append("GitHub issue operation")
    if sub == "run" and verb in ("rerun", "cancel"):
        ctx.asks.append("GitHub Actions run change")
    if sub == "api":
        r = _gh_api_write(rest)
        if r:
            return r
        # repository and organisation settings endpoints (not file paths such as contents/.claude/hooks/...)
        if any(re.match(r"^/?(repos/[^/]+/[^/]+|orgs/[^/]+)/(rulesets|hooks|keys|branches/[^/]+/protection"
                        r"|(actions|dependabot|codespaces)/secrets|environments/[^/]+/secrets)(/|\?|$)", p) for p in pos):
            return MSG_GH_API_PROTECTED
    targets = _option_value(rest, ("-D", "--dir", "-O", "--output"))
    for t in targets:
        if _protected_target(t, ctx) or _computed(t, ctx):
            return MSG_PROTECTED
    return None


def _inv(words, cmd, ctx, allowed_pkgs, allowed_npx):
    """Rules for one command that runs. Returns a block reason or None."""
    a = _texts(words)
    w0 = words[0]
    if a[0] not in ("[", "[[") and (w0.dynamic or w0.glob or (w0.brace and (w0.comma or ".." in w0.text))):
        return MSG_DYNAMIC
    name = _base(a[0])
    args = a[1:]
    if name in NETWORK_CMDS:
        return MSG_NETWORK
    if name == "eval":
        return MSG_EVAL
    if (name == "alias" and any("=" in t for t in args)) or (name == "hash" and "-p" in args) or (name == "enable" and "-f" in args):
        return MSG_DYNAMIC
    if name in PRIV_CMDS:
        return MSG_PRIV
    if name in REMOTE_CMDS:
        return MSG_REMOTE
    if name in NODE_OPS_CMDS:
        return MSG_NODE_OPS
    if name in DOCKER_CMDS:
        return MSG_DOCKER
    if _stdin_script(name, a):
        return MSG_PIPE_SHELL  # bash /dev/stdin, source <(...), python3 /dev/fd/0 ...
    if name in SHELLS:
        if any(t == "-c" or (_is_cluster(t) and "c" in t) or t.startswith("--command") for t in args):
            return MSG_SHELL_C
        stdin = not _positionals(args) or any(_is_cluster(t) and "s" in t for t in args)
        if stdin and cmd.piped_in:
            return MSG_PIPE_SHELL
    lang = _interp_lang(name)
    if lang:
        codes, stdin = _inline(lang, a)
        if stdin and cmd.piped_in:
            return MSG_PIPE_SHELL
    if name == "printenv":
        return MSG_ENV_DUMP
    if name == "env":
        idx, strings = _wrapped("env", a)
        if idx is None and not strings:
            return MSG_ENV_DUMP
    if name == "set" and not args:
        return MSG_ENV_DUMP
    if name == "export" and all(t == "-p" for t in args):
        return MSG_ENV_DUMP
    if name in ("declare", "typeset") and not [t for t in args if not t.startswith(("-", "+"))]:
        return MSG_ENV_DUMP
    for k, t in enumerate(args):
        # --registry, and scoped registries (--@scope:registry=...) that serve an allowed package name elsewhere
        if t.startswith("--registry") or re.match(r"^--@[^=\s]*:registry", t):
            return MSG_REGISTRY
        key, eq, val = t.partition("=")
        if key == "--no-ignore-scripts" or (key == "--ignore-scripts" and eq and val.lower() not in ("true", "1", "yes", "on")) or (
                t in ("--ignore-scripts", "ignore-scripts") and k + 1 < len(args) and args[k + 1].lower() in ("false", "0", "no", "off")):
            return MSG_SCRIPTS
        # another configuration file, or pnpm's --config.<key>=<value> (any setting, such as the registry)
        if (name in ("npm", "npx", "pnpm", "pnpx", "yarn") and key in ("--userconfig", "--globalconfig", "--config-dir",
                                                                       "--use-yarnrc")) or (
                name in ("pnpm", "pnpx") and key.startswith("--config.")):
            return MSG_PKG_CONFIG_FILE.format(key)
    if name in PM_VALUE_OPTS:
        idx, err = _pm_command(name, args)
        if name == "bun" and any(t.split("=", 1)[0] in ("-c", "--config") for t in args[:idx if idx is not None else len(args)]):
            return MSG_PKG_CONFIG_FILE.format("--config")
        if err:
            return err
        sub = args[idx] if idx is not None else None
        pos = ([sub] + _positionals(args[idx + 1:])) if idx is not None else []
        if name == "npm":
            if sub in ("publish", "unpublish", "deprecate", "owner", "access", "token", "login", "adduser", "logout", "whoami"):
                return MSG_NPM
            if sub == "set" or (sub in ("config", "c") and len(pos) > 1 and pos[1] in ("set", "edit", "delete")):
                return MSG_NPM
            if sub in ("exec", "x") and any(t in ("-c", "--call") or t.startswith("--call=") for t in args):
                return MSG_NPM_EXEC_C
            if sub in ("update", "upgrade", "dedupe") or (sub == "audit" and len(pos) > 1 and pos[1] == "fix"):
                ctx.asks.append("dependency tree change")
        if name in ("pnpm", "yarn") and sub is not None and (
                sub in ("publish", "login") or (sub == "config" and len(pos) > 1 and pos[1] == "set")):
            return MSG_PNPM
    if name == "npx" and any(t in ("-c", "--call") or t.startswith("--call=") for t in args):
        return MSG_NPM_EXEC_C
    if name == "find" and _find_writes(words):
        for sp in _find_start_points(words) or [Word()]:
            if not sp.text:
                sp.text = "."  # find with no start point searches "."
            if _contains_protected(sp, ctx):
                return MSG_FIND_WRITE
    if name == "git":
        r = _git(words, ctx)
        if r:
            return r
    if name == "gh":
        r = _gh(words, ctx)
        if r:
            return r
    if name in AWKS and any(AWK_EXEC.search(AWK_STRING.sub('""', p)) or AWK_EXEC_RAW.search(p) for p in _awk_programs(a)):
        return MSG_AWK
    if name == "rm":
        r = _rm(words, ctx)
        if r:
            return r
    for t in _write_targets(name, a):
        if _protected_target(t, ctx):
            return MSG_PROTECTED
    problems = check_installs(a, allowed_pkgs)
    if problems:
        return ("dependency not approved: " + ", ".join(problems)
                + ". Ask a human to add it to .claude/allowed-packages.txt (with a justification) before installing.")
    problems = check_npx(a, allowed_npx)
    if problems:
        return ("npx/dlx of unapproved package: " + ", ".join(problems)
                + ". npx downloads and runs arbitrary code; only packages listed in .claude/allowed-npx.txt may be run.")
    return None


def _heredoc_cat(sub):
    """True for the text of "$(cat <<'EOF' ... EOF)": cat reading a heredoc with a quoted delimiter (no expansions),
    and nothing else runs."""
    try:
        inner = []
        cmds = _build(_lex(sub, inner))
    except ParseError:
        return False
    if inner or len(cmds) != 1:
        return False
    c = cmds[0]
    return (len(c.words) == 1 and c.words[0].text == "cat" and not c.words[0].quoted and not c.redirs
            and len(c.heredocs) == 1 and c.heredocs[0].quoted)


def decide(cmd, cwd):
    """Return ("block", reason), ("ask", what) or None."""
    flat = " ".join(cmd.split())
    for pattern, reason in TEXT_RULES:
        if re.search(pattern, flat, flags=re.IGNORECASE):
            return "block", reason
    ctx = Ctx(cwd, flat)
    try:
        _collect(cmd, ctx, 0)
    except ParseError as e:
        return "block", MSG_PARSE.format(e)
    except RecursionError:
        return "block", MSG_PARSE.format("nested too deeply")
    if ctx.problems:
        return "block", ctx.problems[0]
    for nm, _ in ctx.assigns:
        if nm is not None and PKG_ENV.match(nm) and nm.lower() not in PKG_ENV_ALLOWED:
            return "block", MSG_PKG_ENV.format(nm)
    if any(_base(words[0].text) in ("source", ".") for words, _ in ctx.invs):
        ctx.tmpdir_tainted = True  # a sourced file can change TMPDIR
    allowed_pkgs = read_list(ALLOWED_PACKAGES_FILE)
    allowed_npx = read_list(ALLOWED_NPX_FILE)
    for words, c in ctx.invs:
        r = _inv(words, c, ctx, allowed_pkgs, allowed_npx)
        if r:
            return "block", r
    if ctx.outside and not all(_heredoc_cat(s) for s in ctx.subs):
        return "block", MSG_OUTSIDE_SUBST
    for lang, code in ctx.codes:
        if SPAWN_API.search(code) or (lang in ("perl", "ruby", "php") and SCRIPT_SPAWN.search(code)):
            return "block", MSG_INLINE_SPAWN
        if PROTECTED_MENTION.search(code) and WRITE_API.search(code):
            return "block", MSG_INLINE_WRITE
    git_gh = any(_base(words[0].text) in ("git", "gh") for words, _ in ctx.invs)
    for w in ctx.writes:
        # With git/gh the whole command may run outside the sandbox, so a computed target is refused too.
        if _protected_target(w.text, ctx) or (git_gh and w.dynamic and _computed(w.text, ctx)):
            return "block", MSG_PROTECTED
    if git_gh:
        # ${NAME:=value} and ${NAME=value} assign too
        assigns = ctx.assigns + [(m.group(1), "") for m in re.finditer(r"\$\{([A-Za-z_][A-Za-z0-9_]*):?=", flat)]
        for nm, value in assigns:
            if nm is None:
                return "block", MSG_GIT_ENV_DYNAMIC
            if EXEC_ENV_NAME.fullmatch(nm) and (nm, value) not in SAFE_ENV:
                return "block", MSG_GIT_ENV.format(nm)
    if ctx.asks:
        return "ask", ctx.asks[0]
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
    cwd = os.path.realpath(data.get("cwd") or PROJECT_DIR)

    result = decide(cmd, cwd)
    if result and result[0] == "block":
        flat = " ".join(cmd.split())
        print(f"BLOCKED by guard-bash: {result[1]}\nCommand: {flat}", file=sys.stderr)
        sys.exit(2)
    if result and result[0] == "ask":
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "ask",
                "permissionDecisionReason": f"guard-bash: {result[1]} requires human confirmation.",
            }
        }))
    sys.exit(0)


if __name__ == "__main__":
    main()
